import { sessionGitHubEvidence } from "@tideline/contracts/github-evidence";
import { createHash, randomBytes } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { parsePublishableKey } from "@clerk/shared/keys";
import {
  accountDeletionStatus,
  cliInstallConfig,
  cliLoginResponse,
  cliSessionListQuery,
  confirmAccountDeletion,
  confirmWorkspaceDeletion,
  MAX_CODEX_IMPORT_BYTES,
  MAX_SESSION_CAPTURE_BYTES,
  MAX_SESSION_SUBAGENT_BYTES,
  sessionImportRequest,
  syncEnrollmentRequest,
  syncEnrollmentResponse,
  workspaceNameUpdate,
  workspaceAlias,
  workspaceAliasUpdate,
  workspaceCliStatus,
  workspaceInsightSessionSummariesResponse,
  workspaceResponse,
  workspaceSessionDetailResponse,
  workspaceSessionSearchQuery,
  workspaceUsageTargetUpdate,
} from "@tideline/contracts";
import type { CliAccount, WorkspaceResponse, WorkspaceSessionSearchResponse } from "@tideline/contracts";
import { createWorkspaceStore } from "@tideline/db";
import { createBillingStore } from "@tideline/db/billing";
import { createClerkDirectoryStore } from "@tideline/db/clerk-directory";
import { createCliSetupStore } from "@tideline/db/cli-setups";
import { createSavedReportStore } from "@tideline/db/reports";
import { createSessionShareStore } from "@tideline/db/shares";
import { createGitHubActivityStore } from "@tideline/db/github-activity";
import { createSessionStore } from "@tideline/db/sessions";
import { createTranscriptStore } from "@tideline/db/transcripts";
import { createDigestDeliveryStore } from "@tideline/db/digest-delivery";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { registerCliSetupRoutes } from "./cli-setup-routes";
import { registerClerkDirectoryRoutes } from "./clerk-directory-routes";
import { registerBillingRoutes } from "./billing-routes";
import { priceSession } from "./pricing";
import { registerSavedReportRoutes } from "./saved-report-routes";
import { registerSessionShareRoutes } from "./session-share-routes";
import { registerGitHubActivityRoutes } from "./github-activity-routes";
import { registerTeamRoutes } from "./team-routes";
import { registerWorkspaceActivityRoutes } from "./workspace-activity-routes";
import { registerTranscriptReaders, registerTranscriptRoutes } from "./transcript-routes";
import { registerDigestRoutes } from "./digest-routes";
import { registerRepositoryEvidenceRoutes } from "./repository-evidence-routes";
import { registerCliSyncCoverageRoute, registerSyncInventoryRoutes } from "./sync-inventory-routes";

export type WorkspaceContext = { Variables: { userId: string; cliAccount: CliAccount } };
const grantLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const importTooLarge = "Session import exceeds the size limit.";
const importBodyLimit = bodyLimit({
  maxSize: MAX_CODEX_IMPORT_BYTES + MAX_SESSION_CAPTURE_BYTES + MAX_SESSION_SUBAGENT_BYTES + ',"capture":,"subagents":'.length,
  onError: (context) => context.json({ error: importTooLarge }, 413),
});

async function readSessionUpload(context: Context<WorkspaceContext>) {
  const text = await context.req.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "invalid" } as const;
  }

  const request = sessionImportRequest.safeParse(body);
  if (!request.success) return { kind: "invalid" } as const;

  const { session: { capture, ...session }, ...envelope } = request.data;
  const baseSize = Buffer.byteLength(capture ? JSON.stringify({ ...envelope, session }) : text);
  if (baseSize > MAX_CODEX_IMPORT_BYTES) return { kind: "too-large" } as const;

  return { kind: "valid", data: request.data } as const;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseSyncAuthorization(authorization: string | undefined) {
  const token = /^Bearer (tdsync_[0-9a-f]{64})$/.exec(authorization ?? "")?.[1];
  return token && hashToken(token);
}

function parseCliAuthorization(authorization: string | undefined) {
  const credential = cliLoginResponse.shape.token.safeParse(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1]);
  return credential.success ? hashToken(credential.data) : undefined;
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
    clerkDirectory: createClerkDirectoryStore(databaseUrl),
    setups: createCliSetupStore(databaseUrl),
    sessions: createSessionStore(databaseUrl),
    transcripts: createTranscriptStore(databaseUrl),
    shares: createSessionShareStore(databaseUrl),
    githubActivity: createGitHubActivityStore(databaseUrl),
    savedReports: createSavedReportStore(databaseUrl),
    digestDelivery: createDigestDeliveryStore(databaseUrl),
    billing: createBillingStore(databaseUrl),
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

  const { clerk, sessionVerification, workspaces, sessions, shares, savedReports } = services;
  const oauthClientId = process.env.TIDELINE_CLERK_OAUTH_CLIENT_ID;

  routes.get("/cli/install-config", (context) => {
    const config = cliInstallConfig.safeParse({ clerkIssuer: sessionVerification.issuer, oauthClientId });
    return config.success ? context.json(config.data) : context.json({ error: "CLI approval is not configured." }, 503);
  });

  const requireClerkSession = createMiddleware<WorkspaceContext>(async (context, next) => {
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
    if (await workspaces.directoryIsBlocked(auth.userId)) return context.json({ error: "Directory access is inactive." }, 401);

    context.set("userId", auth.userId);
    await next();
  });

  routes.use("/workspaces/*", requireClerkSession, async (context, next) => {
    if (await workspaces.accountIsRetiring(context.get("userId"))) {
      return context.json({ error: "Account deletion is in progress." }, 410);
    }
    await next();
  });

  routes.get("/account/deletion", requireClerkSession, async (context) => {
    const status = await workspaces.accountDeletionStatus(context.get("userId"));
    return context.json(accountDeletionStatus.parse(status));
  });

  routes.delete("/account/deletion", requireClerkSession, bodyLimit({ maxSize: 512 }), async (context) => {
    const confirmation = confirmAccountDeletion.safeParse(await context.req.json().catch(() => null));
    if (!confirmation.success) return context.json({ error: "Type DELETE to confirm account deletion." }, 400);
    const userId = context.get("userId");
    if (await workspaces.retireAccount(userId) === "owns-teams") {
      return context.json({ error: "This account owns a team workspace." }, 409);
    }

    try {
      await clerk.users.deleteUser(userId);
    } catch (error) {
      if (!(error instanceof Error) || !("status" in error) || error.status !== 404) {
        return context.json({ error: "Account data is deleted. Retry to finish removing your sign-in." }, 503);
      }
    }
    return context.body(null, 204);
  });

  routes.post("/workspaces/personal", async (context) => {
    const workspace = await workspaces.ensurePersonal(context.get("userId"));
    return context.json(workspace satisfies WorkspaceResponse);
  });

  registerWorkspaceActivityRoutes(routes, sessions);
  registerClerkDirectoryRoutes(routes, services.clerkDirectory, clerk, process.env.CLERK_WEBHOOK_SIGNING_SECRET);
  registerBillingRoutes(routes, services.billing);
  registerTranscriptRoutes(routes, services.transcripts, parseSyncAuthorization);
  registerDigestRoutes(routes, services);
  registerRepositoryEvidenceRoutes(routes, sessions, parseSyncAuthorization);
  registerSyncInventoryRoutes(routes, sessions, parseSyncAuthorization);

  registerTeamRoutes(routes, workspaces, clerk);
  registerSessionShareRoutes(routes, shares);

  routes.get("/workspaces/address/:key", async (context) => {
    const key = context.req.param("key");
    const id = workspaceResponse.shape.id.safeParse(key).data;
    const alias = id ? undefined : workspaceAlias.safeParse(key).data;
    const lookup = id ? { id } : alias && { alias };
    const address = lookup ? await workspaces.readAddress(context.get("userId"), lookup) : undefined;
    return address ? context.json(address) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.patch("/workspaces/:id/address", bodyLimit({ maxSize: 1_024 }), async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id")).data;
    if (!id) return context.json({ error: "Workspace not found." }, 404);
    const update = workspaceAliasUpdate.safeParse(await context.req.json().catch(() => null));
    if (!update.success) return context.json({ error: "Enter a valid workspace URL alias." }, 400);
    const result = await workspaces.setAlias({ workspaceId: id, userId: context.get("userId") }, update.data.alias);
    switch (result) {
      case "saved": return context.json({ id, alias: update.data.alias });
      case "conflict": return context.json({ error: "That workspace URL alias is in use." }, 409);
      case "unavailable": return context.json({ error: "Workspace not found." }, 404);
    }
  });

  routes.get("/workspaces/:id", async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) {
      return context.json({ error: "Workspace not found." }, 404);
    }

    const workspace = await workspaces.findAccessible({
      workspaceId: id.data,
      userId: context.get("userId"),
    });
    if (!workspace) {
      return context.json({ error: "Workspace not found." }, 404);
    }
    return context.json(workspace);
  });

  routes.get("/workspaces/:id/cli-status", async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    const userId = context.get("userId");
    const workspace = id.success && await workspaces.findAccessible({ workspaceId: id.data, userId });
    if (!workspace) return context.json({ error: "Workspace not found." }, 404);
    const approved = await sessions.hasActiveSyncGrant(workspace.id, userId);
    return context.json(workspaceCliStatus.parse({ approved }));
  });

  routes.patch("/workspaces/:id", bodyLimit({
    maxSize: 2_048,
    onError: (context) => context.json({ error: "Workspace name exceeds the size limit." }, 413),
  }), async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Workspace not found." }, 404);

    const update = workspaceNameUpdate.safeParse(await context.req.json().catch(() => null));
    if (!update.success) return context.json({ error: "Enter a workspace name between 1 and 80 characters." }, 400);

    const workspace = await workspaces.renameManaged({ workspaceId: id.data, userId: context.get("userId") }, update.data.name);
    return workspace ? context.json(workspace) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.delete("/workspaces/:id", bodyLimit({ maxSize: 2_048 }), async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Workspace not found." }, 404);
    const confirmation = confirmWorkspaceDeletion.safeParse(await context.req.json().catch(() => null));
    if (!confirmation.success) return context.json({ error: "Enter the workspace name to confirm deletion." }, 400);

    const result = await workspaces.deleteOwned({ workspaceId: id.data, userId: context.get("userId") }, confirmation.data.name);
    switch (result) {
      case "deleted": return context.body(null, 204);
      case "unavailable": return context.json({ error: "Workspace not found." }, 404);
      case "name-mismatch": return context.json({ error: "Enter the workspace name exactly as it appears in Settings." }, 409);
    }
  });

  routes.get("/workspaces/:id/usage-targets", async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Workspace not found." }, 404);

    const targets = await workspaces.readUsageTargets({ workspaceId: id.data, userId: context.get("userId") });
    if (!targets) return context.json({ error: "Workspace not found." }, 404);
    return context.json(targets);
  });

  routes.patch("/workspaces/:id/usage-targets", bodyLimit({
    maxSize: 2_048,
    onError: (context) => context.json({ error: "Budget or goal exceeds the size limit." }, 413),
  }), async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Workspace not found." }, 404);

    const body: unknown = await context.req.json().catch(() => null);
    const update = workspaceUsageTargetUpdate.safeParse(body);
    if (!update.success) return context.json({ error: "Expected a valid budget or goal." }, 400);

    const targets = await workspaces.updateUsageTarget({ workspaceId: id.data, userId: context.get("userId") }, update.data);
    if (!targets) return context.json({ error: "Workspace not found." }, 404);
    return context.json(targets);
  });

  routes.get("/workspaces/:workspaceId/sessions", async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    const userId = context.get("userId");
    const workspace = workspaceId.success && await workspaces.findAccessible({
      workspaceId: workspaceId.data,
      userId,
    });
    if (!workspace) {
      return context.json({ error: "Workspace not found." }, 404);
    }

    if (context.req.query("insights") === "1") {
      const summaries = await sessions.listReadyWithInsights(workspace.id, userId);
      return context.json(workspaceInsightSessionSummariesResponse.parse(summaries.map(priceSession)));
    }

    const summaries = await sessions.listReady(workspace.id);
    return context.json(summaries.map(priceSession));
  });

  async function searchSessions(context: Context<WorkspaceContext>, userId: string, includeActivityFacets = false) {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    if (!workspaceId.success || !await workspaces.findAccessible({ workspaceId: workspaceId.data, userId })) {
      return context.json({ error: "Workspace not found." }, 404);
    }

    const filters = workspaceSessionSearchQuery.safeParse(context.req.query());
    if (!filters.success) return context.json({ error: "Invalid search or session filters." }, 400);

    const { sessions: rows, skills, subagents, ...result } = await sessions.searchReady(workspaceId.data, filters.data, { includeActivityFacets });
    const response = { ...result, sessions: rows.map(priceSession) } satisfies WorkspaceSessionSearchResponse;
    return context.json(includeActivityFacets ? { ...response, skills, subagents } : response);
  }

  routes.get("/workspaces/:workspaceId/session-search", (context) => searchSessions(context, context.get("userId"), true));

  routes.get("/workspaces/:workspaceId/sessions/:sessionId", async (context) => {
    const uuid = workspaceResponse.shape.id;
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    const sessionId = uuid.safeParse(context.req.param("sessionId"));
    if (!workspaceId.success || !sessionId.success || !await workspaces.findAccessible({
      workspaceId: workspaceId.data,
      userId: context.get("userId"),
    })) {
      return context.json({ error: "Session not found." }, 404);
    }

    const session = await sessions.findReady(workspaceId.data, sessionId.data, { includeCapture: true });
    if (!session) {
      return context.json({ error: "Session not found." }, 404);
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(workspaceSessionDetailResponse.parse({
      ...priceSession(session), capture: session.capture ?? null, turnTrace: session.analytics?.turnTrace,
    }));
  });

  routes.get("/workspaces/:workspaceId/sessions/:sessionId/github-evidence", async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId")).data;
    const sessionId = workspaceResponse.shape.id.safeParse(context.req.param("sessionId")).data;
    if (!workspaceId || !sessionId || !await workspaces.findAccessible({ workspaceId, userId: context.get("userId") })) {
      return context.json({ error: "Session not found." }, 404);
    }
    const session = await sessions.findReady(workspaceId, sessionId);
    if (!session) return context.json({ error: "Session not found." }, 404);
    return context.json(sessionGitHubEvidence.parse(await services.githubActivity.evidenceForSession(workspaceId, session.review?.commits ?? [])));
  });

  routes.delete("/workspaces/:workspaceId/sessions/:sessionId", async (context) => {
    const uuid = workspaceResponse.shape.id;
    const workspaceId = uuid.safeParse(context.req.param("workspaceId")).data;
    const sessionId = uuid.safeParse(context.req.param("sessionId")).data;
    const deleted = workspaceId && sessionId && await sessions.deleteManaged({ workspaceId, sessionId, userId: context.get("userId") });
    return deleted ? context.body(null, 204) : context.json({ error: "Session not found." }, 404);
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

    if (await workspaces.accountIsRetiring(auth.userId)) {
      return context.json({ error: "Account deletion is in progress." }, 410);
    }
    if (await workspaces.directoryIsBlocked(auth.userId)) return context.json({ error: "Directory access is inactive." }, 401);

    context.set("userId", auth.userId);
    await next();
  });

  registerCliSetupRoutes(routes, services.setups, workspaces, requireClerkCli);

  routes.post("/cli/approve", requireClerkCli, async (context) => {
    const workspace = await workspaces.ensurePersonal(context.get("userId"));
    return context.json(workspace satisfies WorkspaceResponse);
  });

  const requireCliAccount = createMiddleware<WorkspaceContext>(async (context, next) => {
    const tokenHash = parseCliAuthorization(context.req.header("Authorization"));
    const account = tokenHash && await workspaces.findCliAccount(tokenHash);
    if (!account) return context.json({ error: "A valid CLI sign-in is required." }, 401);
    context.set("cliAccount", account);
    await next();
  });

  registerSavedReportRoutes(routes, savedReports, sessions, requireCliAccount);
  registerTranscriptReaders(routes, services.transcripts, requireCliAccount);
  registerGitHubActivityRoutes(routes, services.githubActivity, requireCliAccount, parseSyncAuthorization);
  registerCliSyncCoverageRoute(routes, sessions, requireCliAccount);

  routes.post("/cli/account", requireClerkCli, async (context) => {
    const userId = context.get("userId");
    const workspace = await workspaces.ensurePersonal(userId);
    const token = `tdcli_${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + grantLifetimeMs);
    if (!await workspaces.enrollCli(hashToken(token), workspace.id, expiresAt)) {
      return context.json({ error: "The CLI account is unavailable." }, 401);
    }
    return context.json(cliLoginResponse.parse({ token, expiresAt: expiresAt.toISOString(), account: { userId, workspace } }), 201);
  });

  routes.get("/cli/account", requireCliAccount, (context) => context.json(context.get("cliAccount")));

  routes.delete("/cli/account", async (context) => {
    const tokenHash = parseCliAuthorization(context.req.header("Authorization"));
    if (!tokenHash || !await workspaces.revokeCli(tokenHash)) {
      return context.json({ error: "A valid CLI sign-in is required." }, 401);
    }
    return context.body(null, 204);
  });

  routes.get("/cli/workspaces", requireCliAccount, async (context) => {
    return context.json(await workspaces.listAccessible(context.get("cliAccount").userId));
  });

  routes.get("/cli/workspaces/:workspaceId", requireCliAccount, async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    const workspace = workspaceId.success && await workspaces.findAccessible({
      workspaceId: workspaceId.data, userId: context.get("cliAccount").userId,
    });
    return workspace ? context.json(workspace) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.get("/cli/workspaces/:workspaceId/session-search", requireCliAccount, (context) => {
    return searchSessions(context, context.get("cliAccount").userId);
  });

  routes.get("/cli/workspaces/:workspaceId/sessions", requireCliAccount, async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    if (!workspaceId.success || !await workspaces.findAccessible({
      workspaceId: workspaceId.data, userId: context.get("cliAccount").userId,
    })) {
      return context.json({ error: "Workspace not found." }, 404);
    }
    const query = cliSessionListQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Invalid session filters or page cursor." }, 400);

    const { sessions: rows, nextCursor } = await sessions.pageReady(workspaceId.data, query.data);
    return context.json({ sessions: rows.map(priceSession), nextCursor });
  });

  routes.get("/cli/workspaces/:workspaceId/sessions/:sessionId", requireCliAccount, async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    const sessionId = workspaceResponse.shape.id.safeParse(context.req.param("sessionId"));
    if (!workspaceId.success || !sessionId.success || !await workspaces.findAccessible({
      workspaceId: workspaceId.data, userId: context.get("cliAccount").userId,
    })) {
      return context.json({ error: "Session not found." }, 404);
    }
    const includeCapture = context.req.query("details") === "1";
    const session = await sessions.findReady(workspaceId.data, sessionId.data, { includeCapture });
    if (!session) return context.json({ error: "Session not found." }, 404);
    context.header("Cache-Control", "private, no-store");
    const detail = priceSession(session);
    return context.json(includeCapture ? workspaceSessionDetailResponse.parse({ ...detail, capture: session.capture ?? null }) : detail);
  });

  routes.post(
    "/cli/imports",
    requireClerkCli,
    importBodyLimit,
    async (context) => {
      const request = await readSessionUpload(context);
      if (request.kind === "too-large") return context.json({ error: importTooLarge }, 413);
      if (request.kind === "invalid") {
        return context.json({ error: "Expected a valid, sanitized session import." }, 400);
      }

      const receipt = await sessions.receive(request.data, context.get("userId"));
      if (receipt === undefined) return context.json({ error: "Workspace not found." }, 404);
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

    const token = `tdsync_${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + grantLifetimeMs);
    const userId = context.get("userId");
    const response = syncEnrollmentResponse.parse({
      token, expiresAt: expiresAt.toISOString(), ...(context.req.query("includeUser") === "1" && { userId }),
    });
    const enrolled = await sessions.enrollSync({
      tokenHash: hashToken(token), workspaceId: request.data.workspaceId, userId, expiresAt,
    });
    return enrolled ? context.json(response, 201) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.post("/cli/sync/revoke", async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    if (!tokenHash || !await sessions.revokeSync(tokenHash)) {
      return context.json({ error: "A sync credential is required." }, 401);
    }
    return context.body(null, 204);
  });

  routes.get("/cli/sync/status", async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    const grant = tokenHash && await sessions.readSyncGrant(tokenHash);
    if (!grant) return context.json({ error: "The sync credential is invalid, expired, or revoked." }, 401);
    return context.json(syncEnrollmentRequest.parse(grant));
  });

  routes.post("/cli/sync/sessions", importBodyLimit, async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    if (!tokenHash) {
      return context.json({ error: "A sync credential is required." }, 401);
    }

    const request = await readSessionUpload(context);
    if (request.kind === "too-large") return context.json({ error: importTooLarge }, 413);
    if (request.kind === "invalid") {
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
