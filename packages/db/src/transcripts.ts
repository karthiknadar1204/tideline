import { createHash } from "node:crypto";
import type { TranscriptAppend } from "@tideline/contracts/transcripts";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentSessions, syncGrants, transcriptAttachments, transcriptRecords, workspaces } from "./schema";
import { workspaceAccessibleTo } from "./workspaces";

type Locator = { workspaceId: string; source: "codex" | "claude-code"; sourceId: string; stream: string };
const emptyCursor = { line: 0, offset: 0, previousOffset: 0, digest: null };

export function createTranscriptStore(url: string) {
  const db = drizzle(postgres(url));
  const fields = { line: transcriptRecords.line, offset: transcriptRecords.offset, previousOffset: transcriptRecords.start, digest: transcriptRecords.digest };
  const permitted = (workspaceId: string, sessionId: string, userId: string) => db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .innerJoin(workspaces, eq(workspaces.id, agentSessions.workspaceId))
    .where(and(eq(workspaces.id, workspaceId), eq(agentSessions.id, sessionId), isNull(agentSessions.deletedAt), workspaceAccessibleTo(userId)));
  return {
    async sync(tokenHash: string, locator: Locator, append?: TranscriptAppend[]) {
      return db.transaction(async (tx) => {
        const [grant] = await tx.select({ userId: syncGrants.userId, workspaceId: syncGrants.workspaceId })
          .from(syncGrants).where(and(eq(syncGrants.tokenHash, tokenHash), isNull(syncGrants.revokedAt),
            gt(syncGrants.expiresAt, sql`clock_timestamp()`))).for("update");
        if (!grant || grant.workspaceId !== locator.workspaceId) return { kind: "unauthorized" } as const;
        const [session] = await tx.select({
          id: agentSessions.id, pending: agentSessions.pendingCapture, ready: agentSessions.readyCapture,
        }).from(agentSessions)
          .innerJoin(workspaces, eq(workspaces.id, agentSessions.workspaceId))
          .where(and(eq(agentSessions.workspaceId, locator.workspaceId), eq(agentSessions.source, locator.source),
            eq(agentSessions.sourceSessionId, locator.sourceId), isNull(agentSessions.deletedAt),
            sql`((${workspaces.kind} = 'personal' and ${agentSessions.uploadedBy} is null) or
              (${agentSessions.uploadedBy} = ${grant.userId} and ${workspaceAccessibleTo(grant.userId ?? "")}))`))
          .for("update", { of: agentSessions });
        if (!session) return { kind: "missing" } as const;
        if (locator.stream !== "main" && ![session.pending, session.ready].some((capture) =>
          capture?.subagents?.transcripts.some(({ agentId }) => agentId === locator.stream))) return { kind: "missing" } as const;
        const matches = and(eq(transcriptRecords.sessionId, session.id), eq(transcriptRecords.stream, locator.stream));
        const [current = emptyCursor] = await tx.select(fields).from(transcriptRecords)
          .where(matches).orderBy(desc(transcriptRecords.line)).limit(1);
        if (!append) return { kind: "cursor", current } as const;
        if (append[0].start !== current.offset) return { kind: "conflict", current } as const;
        const records = append.map(({ text, omitted, start, offset, attachments }, index) => {
          const line = current.line + index + 1;
          return { sessionId: session.id, stream: locator.stream, line, start, offset, digest: createHash("sha256").update(text).digest("hex"),
            record: { line, text, omitted, attachments: attachments.map(({ base64, ...reference }) => reference) } };
        });
        await tx.insert(transcriptRecords).values(records);
        const blobs = new Map(append.flatMap(({ attachments }) => attachments.map(({ digest, mime, base64 }) => (
          [digest, { sessionId: session.id, digest, mime, data: base64 }] as const
        ))));
        if (blobs.size) await tx.insert(transcriptAttachments).values([...blobs.values()]).onConflictDoNothing();
        const tail = records[records.length - 1];
        return { kind: "cursor", current: { line: tail.line, offset: tail.offset, previousOffset: tail.start, digest: tail.digest } } as const;
      });
    },
    async read(workspaceId: string, sessionId: string, userId: string, after: number, stream: string) {
      const allowed = permitted(workspaceId, sessionId, userId).as("allowed");
      const matches = and(eq(allowed.id, transcriptRecords.sessionId), eq(transcriptRecords.stream, stream));
      const [[tail], rows] = await Promise.all([
        db.select({ line: transcriptRecords.line }).from(allowed).leftJoin(transcriptRecords, matches)
          .orderBy(desc(transcriptRecords.line)).limit(1),
        db.select({ record: transcriptRecords.record }).from(transcriptRecords)
          .innerJoin(allowed, matches).where(gt(transcriptRecords.line, after))
          .orderBy(transcriptRecords.line).limit(5),
      ]);
      if (!tail) return null;
      const total = tail.line ?? 0;
      const last = rows.at(-1)?.record.line;
      return { total, records: rows.map(({ record }) => record), after: last && last < total ? last : null };
    },
    async streams(workspaceId: string, sessionId: string, userId: string) {
      const allowed = permitted(workspaceId, sessionId, userId).as("allowed");
      const found = await db.selectDistinct({ stream: transcriptRecords.stream }).from(allowed)
        .leftJoin(transcriptRecords, eq(allowed.id, transcriptRecords.sessionId)).orderBy(transcriptRecords.stream).limit(20);
      return found.length ? found.flatMap(({ stream }) => stream ? [stream] : []) : null;
    },
    async attachment(workspaceId: string, sessionId: string, userId: string, digest: string) {
      const allowed = permitted(workspaceId, sessionId, userId).as("allowed");
      const [row] = await db.select({ mime: transcriptAttachments.mime, data: transcriptAttachments.data })
        .from(transcriptAttachments).innerJoin(allowed, eq(allowed.id, transcriptAttachments.sessionId))
        .where(eq(transcriptAttachments.digest, digest));
      return row;
    },
  };
}
