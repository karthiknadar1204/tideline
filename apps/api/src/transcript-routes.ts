import { createHash } from "node:crypto";
import type { createTranscriptStore } from "@tideline/db/transcripts";
import {
  isRedactedTranscriptText, matchesTranscriptMedia, MAX_TRANSCRIPT_ATTACHMENT_BYTES, MAX_TRANSCRIPT_PACKET_BYTES, MAX_TRANSCRIPT_RECORD_BYTES,
  transcriptBatch, transcriptHash, transcriptLocator, transcriptMedia, transcriptStream,
} from "@tideline/contracts/transcripts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const readStreamId = (context: Context<WorkspaceContext>) => transcriptStream.safeParse(context.req.query("stream") ?? "main").data;

export function registerTranscriptRoutes(
  routes: Hono<WorkspaceContext>, store: ReturnType<typeof createTranscriptStore>,
  parseToken: (header: string | undefined) => string | undefined,
) {
  const syncPath = "/cli/sync/transcripts/:workspaceId/:source/:sourceId";
  routes.get(syncPath, async (context) => {
    const token = parseToken(context.req.header("Authorization"));
    if (!token) return context.body(null, 401);
    const location = transcriptLocator.safeParse(context.req.param());
    const stream = readStreamId(context);
    if (!location.success || !stream) return context.body(null, 400);
    const result = await store.sync(token, { ...location.data, stream });
    if (result.kind === "unauthorized") return context.body(null, 401);
    if (result.kind === "missing") return context.body(null, 404);
    return context.json(result.current, 200, privateHeaders);
  });
  routes.post(syncPath, bodyLimit({ maxSize: MAX_TRANSCRIPT_PACKET_BYTES }), async (context) => {
    const token = parseToken(context.req.header("Authorization"));
    if (!token) return context.body(null, 401);
    const location = transcriptLocator.safeParse(context.req.param());
    const packet = transcriptBatch.safeParse(await context.req.json().catch(() => null));
    const stream = readStreamId(context);
    if (!location.success || !packet.success || !stream) return context.body(null, 400);
    for (const { text, attachments } of packet.data.records) {
      if (Buffer.byteLength(text) > MAX_TRANSCRIPT_RECORD_BYTES || /[\r\n\u0000]/u.test(text)) return context.body(null, 400);
      try { if (text && !isRedactedTranscriptText(JSON.parse(text))) return context.body(null, 400); }
      catch { return context.body(null, 400); }
      for (const { digest, mime, bytes: size, base64 } of attachments) {
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length !== size || bytes.length > MAX_TRANSCRIPT_ATTACHMENT_BYTES || bytes.toString("base64") !== base64 ||
            !matchesTranscriptMedia(bytes, mime) || createHash("sha256").update(bytes).digest("hex") !== digest ||
            !text.includes(digest)) return context.body(null, 400);
      }
    }
    const result = await store.sync(token, { ...location.data, stream }, packet.data.records);
    if (result.kind === "unauthorized") return context.body(null, 401);
    if (result.kind === "missing") return context.body(null, 404);
    return context.json(result.current, result.kind === "conflict" ? 409 : 200, privateHeaders);
  });
}

export function registerTranscriptReaders(
  routes: Hono<WorkspaceContext>, store: ReturnType<typeof createTranscriptStore>, requireCli: MiddlewareHandler<WorkspaceContext>,
) {
  const path = "/workspaces/:workspaceId/sessions/:sessionId/transcript";
  async function read(context: Context<WorkspaceContext>, userId: string) {
    const { workspaceId, sessionId } = context.req.param();
    const uuid = transcriptLocator.shape.workspaceId;
    const after = Number(context.req.query("after") ?? "0");
    const stream = readStreamId(context);
    if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(sessionId).success || !Number.isSafeInteger(after) || after < 0 || !stream) {
      return context.body(null, 404);
    }
    const result = await store.read(workspaceId, sessionId, userId, after, stream);
    return result ? context.json(result, 200, privateHeaders) : context.body(null, 404);
  }
  async function streams(context: Context<WorkspaceContext>, userId: string) {
    const { workspaceId, sessionId } = context.req.param();
    const uuid = transcriptLocator.shape.workspaceId;
    if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(sessionId).success) return context.body(null, 404);
    const streams = await store.streams(workspaceId, sessionId, userId);
    return streams ? context.json({ streams }, 200, privateHeaders) : context.body(null, 404);
  }
  async function attachment(context: Context<WorkspaceContext>, userId: string) {
    const { workspaceId, sessionId, digest } = context.req.param();
    const uuid = transcriptLocator.shape.workspaceId;
    if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(sessionId).success || !transcriptHash.safeParse(digest).success) {
      return context.body(null, 404);
    }
    const attachment = await store.attachment(workspaceId, sessionId, userId, digest);
    const mime = transcriptMedia.safeParse(attachment?.mime);
    if (!attachment || !mime.success) return context.body(null, 404);
    return new Response(new Uint8Array(Buffer.from(attachment.data, "base64")), { headers: { ...privateHeaders, "Content-Type": mime.data } });
  }
  async function download(context: Context<WorkspaceContext>) {
    const { workspaceId, sessionId } = context.req.param();
    const uuid = transcriptLocator.shape.workspaceId;
    const streamId = readStreamId(context);
    if (!workspaceId || !sessionId || !uuid.safeParse(workspaceId).success || !uuid.safeParse(sessionId).success || !streamId) {
      return context.body(null, 404);
    }
    const signal = context.req.raw.signal;
    const userId = context.get("userId");
    let page = await store.read(workspaceId, sessionId, userId, 0, streamId);
    if (!page) return context.body(null, 404);
    const lastLine = page.total;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (signal.aborted) return controller.close();
        if (!page) return controller.error(new Error("The transcript could not be read"));
        if (page.records.length) {
          const text = page.records.filter(({ line }) => line <= lastLine).map(({ text }) => text + "\n").join("");
          if (text) controller.enqueue(encoder.encode(text));
        }
        if (page.after === null || page.after >= lastLine) return controller.close();
        page = await store.read(workspaceId, sessionId, userId, page.after, streamId);
      },
    });
    return new Response(stream, { headers: {
      ...privateHeaders, "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="tideline-${sessionId}${streamId === "main" ? "" : `-${streamId}`}.jsonl"`,
    } });
  }
  routes.get(path, (context) => read(context, context.get("userId")));
  routes.get(`${path}/download`, download);
  routes.get(`${path}/streams`, (context) => streams(context, context.get("userId")));
  routes.get(`${path}/attachments/:digest`, (context) => attachment(context, context.get("userId")));
  routes.get(`/cli${path}`, requireCli, (context) => read(context, context.get("cliAccount").userId));
  routes.get(`/cli${path}/streams`, requireCli, (context) => streams(context, context.get("cliAccount").userId));
  routes.get(`/cli${path}/attachments/:digest`, requireCli, (context) => attachment(context, context.get("cliAccount").userId));
}
