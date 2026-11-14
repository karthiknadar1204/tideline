import { createHash, randomBytes } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { parsePublishableKey } from "@clerk/shared/keys";
import {
  MAX_CODEX_IMPORT_BYTES,
  sessionImportRequest,
  syncEnrollmentRequest,
  syncEnrollmentResponse,
  workspaceResponse,
} from "@tideline/contracts";
import type { WorkspaceResponse } from "@tideline/contracts";
import { createWorkspaceStore } from "@tideline/db";
import { createSessionStore } from "@tideline/db/sessions";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { priceSession } from "./pricing";

type WorkspaceContext = { Variables: { ownerId: string } };
const syncLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const importBodyLimit = bodyLimit({
  maxSize: MAX_CODEX_IMPORT_BYTES,
  onError: (context) => context.json({ error: "Session import exceeds the size limit." }, 413),
});

function hashSyncToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseSyncAuthorization(authorization: string | undefined) {
  const token = /^Bearer (tdsync_[0-9a-f]{64})$/.exec(authorization ?? "")?.[1];
  return token && hashSyncToken(token);
}

function getWorkspaceServices() {
  const {
    CLERK_PUBLISHABLE_KEY: publishableKey,
    CLERK_SECRET_KEY: secretKey,
    NEON_DB_URL: databaseUrl,
    TIDELINE_WEB_ORIGIN: webOrigin = "http://localhost:3000",
  } = process.env;

  if (!publishableKey || !secretKey || !databaseUrl) {
    return undefined;
  }

  const { frontendApi } = parsePublishableKey(publishableKey, { fatal: true });
  return {
    clerk: createClerkClient({ publishableKey, secretKey }),
    sessionVerification: {
      issuer: new URL(`https://${frontendApi}`).origin,
      authorizedParties: [new URL(webOrigin).origin],
    },
    workspaces: createWorkspaceStore(databaseUrl),
    sessions: createSessionStore(databaseUrl),
  };
}

export function createWorkspaceRoutes() {
  const routes = new Hono<WorkspaceContext>();
  const services = getWorkspaceServices();

  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  if (!services) {
    routes.all("*", (context) => context.json({ error: "Workspace service is not configured." }, 503));
    return routes;
  }

  const { clerk, sessionVerification, workspaces, sessions } = services;
  const oauthClientId = process.env.TIDELINE_CLERK_OAUTH_CLIENT_ID;

  routes.use("/workspaces/*", async (context, next) => {
    if (!/^Bearer \S+$/.test(context.req.header("Authorization") ?? "")) {
      return context.json({ error: "Sign in to access your workspace." }, 401);
    }

    const state = await clerk.authenticateRequest(context.req.raw, {
      acceptsToken: "session_token",
      ...sessionVerification,
    });
    const auth = state.toAuth();
    if (!auth?.isAuthenticated || auth.tokenType !== "session_token" || !auth.userId) {
      return context.json({ error: "Sign in to access your workspace." }, 401);
    }

    context.set("ownerId", auth.userId);
    await next();
  });

  routes.post("/workspaces/personal", async (context) => {
    const workspace = await workspaces.ensurePersonal(context.get("ownerId"));
    return context.json(workspace satisfies WorkspaceResponse);
  });

  routes.get("/workspaces/:id", async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) {
      return context.json({ error: "Workspace not found." }, 404);
    }

    const workspace = await workspaces.findOwned({
      workspaceId: id.data,
      ownerId: context.get("ownerId"),
    });
    if (!workspace) {
      return context.json({ error: "Workspace not found." }, 404);
    }
    return context.json(workspace satisfies WorkspaceResponse);
  });

  routes.get("/workspaces/:workspaceId/sessions", async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    if (!workspaceId.success || !await workspaces.findOwned({
      workspaceId: workspaceId.data,
      ownerId: context.get("ownerId"),
    })) {
      return context.json({ error: "Workspace not found." }, 404);
    }

    const summaries = await sessions.listReady(workspaceId.data);
    return context.json(summaries.map(priceSession));
  });

  routes.get("/workspaces/:workspaceId/sessions/:sessionId", async (context) => {
    const uuid = workspaceResponse.shape.id;
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    const sessionId = uuid.safeParse(context.req.param("sessionId"));
    if (!workspaceId.success || !sessionId.success || !await workspaces.findOwned({
      workspaceId: workspaceId.data,
      ownerId: context.get("ownerId"),
    })) {
      return context.json({ error: "Session not found." }, 404);
    }

    const session = await sessions.findReady(workspaceId.data, sessionId.data);
    if (!session) {
      return context.json({ error: "Session not found." }, 404);
    }
    return context.json(priceSession(session));
  });

  const requireClerkCli = createMiddleware<WorkspaceContext>(async (context, next) => {
    if (!oauthClientId) {
      return context.json({ error: "CLI approval is not configured." }, 503);
    }
    if (!/^Bearer \S+$/.test(context.req.header("Authorization") ?? "")) {
      return context.json({ error: "Clerk approval is required." }, 401);
    }

    const state = await clerk.authenticateRequest(context.req.raw, { acceptsToken: "oauth_token" });
    const auth = state.toAuth();
    if (
      !auth?.isAuthenticated ||
      auth.tokenType !== "oauth_token" ||
      auth.clientId !== oauthClientId ||
      !auth.userId
    ) {
      return context.json({ error: "Clerk approval is required." }, 401);
    }

    context.set("ownerId", auth.userId);
    await next();
  });

  routes.post("/cli/approve", requireClerkCli, async (context) => {
    const workspace = await workspaces.ensurePersonal(context.get("ownerId"));
    return context.json(workspace satisfies WorkspaceResponse);
  });

  routes.post(
    "/cli/imports",
    requireClerkCli,
    importBodyLimit,
    async (context) => {
      const body: unknown = await context.req.json().catch(() => null);
      const request = sessionImportRequest.safeParse(body);
      if (!request.success) {
        return context.json({ error: "Expected a valid, sanitized session import." }, 400);
      }

      const { workspaceId } = request.data;
      if (!await workspaces.findOwned({ workspaceId, ownerId: context.get("ownerId") })) {
        return context.json({ error: "Workspace not found." }, 404);
      }

      const receipt = await sessions.receive(request.data);
      if (!receipt) {
        return context.json({ error: "This session was already imported with different content." }, 409);
      }

      return context.json(receipt, receipt.alreadyReceived ? 200 : 202);
    },
  );

  routes.post("/cli/sync/enroll", requireClerkCli, bodyLimit({ maxSize: 2_048 }), async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const request = syncEnrollmentRequest.safeParse(body);
    if (!request.success) {
      return context.json({ error: "A valid workspace ID is required." }, 400);
    }

    const workspace = await workspaces.findOwned({
      workspaceId: request.data.workspaceId,
      ownerId: context.get("ownerId"),
    });
    if (!workspace) {
      return context.json({ error: "Workspace not found." }, 404);
    }

    const token = `tdsync_${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + syncLifetimeMs);
    const response = syncEnrollmentResponse.parse({ token, expiresAt: expiresAt.toISOString() });
    await sessions.enrollSync({ tokenHash: hashSyncToken(token), workspaceId: workspace.id, expiresAt });
    return context.json(response, 201);
  });

  routes.post("/cli/sync/revoke", async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    if (!tokenHash || !await sessions.revokeSync(tokenHash)) {
      return context.json({ error: "A sync credential is required." }, 401);
    }
    return context.body(null, 204);
  });

  routes.post("/cli/sync/sessions", importBodyLimit, async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    if (!tokenHash) {
      return context.json({ error: "A sync credential is required." }, 401);
    }

    const body: unknown = await context.req.json().catch(() => null);
    const request = sessionImportRequest.safeParse(body);
    if (!request.success) {
      return context.json({ error: "Expected a valid, sanitized session snapshot." }, 400);
    }

    const result = await sessions.receiveSync(tokenHash, request.data);
    switch (result.kind) {
      case "unauthorized":
        return context.json({ error: "The sync credential is invalid, expired, or revoked." }, 401);
      case "foreign-workspace":
        return context.json({ error: "Workspace not found." }, 404);
      case "conflict":
        return context.json({ error: "The snapshot conflicts with accepted session data." }, 409);
      case "accepted":
        return context.json(result.receipt, result.receipt.alreadyReceived ? 200 : 202);
    }
  });

  routes.onError((error, context) => {
    console.error("Tideline workspace request failed.", { error: error.name });
    return context.json({ error: "Workspace service is unavailable." }, 500);
  });

  return routes;
}
