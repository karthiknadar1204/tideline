import { createHash } from "node:crypto";
import { githubActivityQuery, githubActivityResponse, githubActivitySyncUpload, githubActivityUpload, workspaceResponse } from "@tideline/contracts";
import type { createGitHubActivityStore } from "@tideline/db/github-activity";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const limit = bodyLimit({ maxSize: 270_000 });

function githubRepoKey(repository: string) {
  return createHash("sha256").update(`remote:github.com/${repository}`).digest("hex");
}

export function registerGitHubActivityRoutes(
  routes: Hono<WorkspaceContext>,
  store: ReturnType<typeof createGitHubActivityStore>,
  requireCli: MiddlewareHandler<WorkspaceContext>,
  parseSyncAuthorization: (authorization: string | undefined) => string | undefined,
) {
  async function readActivity(context: Context<WorkspaceContext>, userId: string) {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    const query = githubActivityQuery.safeParse(context.req.query());
    if (!workspaceId.success || !query.success) {
      return context.json({ error: "Invalid GitHub activity filters." }, 400);
    }
    const result = await store.list(workspaceId.data, userId, query.data);
    if (!result) return context.json({ error: "Workspace not found." }, 404);
    context.header("Cache-Control", "private, no-store");
    return context.json(githubActivityResponse.parse(result));
  }
  routes.get("/workspaces/:workspaceId/github-activity", (context) => readActivity(context, context.get("userId")));
  routes.get("/cli/workspaces/:workspaceId/github-activity", requireCli, (context) => readActivity(context, context.get("cliAccount").userId));

  routes.post("/cli/workspaces/:workspaceId/github-activity", requireCli, limit, async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId"));
    const upload = githubActivityUpload.safeParse(await context.req.json().catch(() => null));
    if (!workspaceId.success || !upload.success) return context.json({ error: "Invalid GitHub activity." }, 400);
    const { repository, events } = upload.data;
    const result = await store.record({ workspaceId: workspaceId.data, repository, repositoryKey: githubRepoKey(repository), events },
      context.get("cliAccount").userId);
    return result ? context.json(result) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.post("/cli/sync/github-activity", limit, async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    if (!tokenHash) return context.json({ error: "A sync credential is required." }, 401);
    const upload = githubActivitySyncUpload.safeParse(await context.req.json().catch(() => null));
    if (!upload.success) return context.json({ error: "Invalid GitHub activity." }, 400);
    const status = await store.recordCollector({ ...upload.data, repositoryKey: githubRepoKey(upload.data.repository) }, tokenHash);
    if (status.kind === "unauthorized") return context.json({ error: "The sync credential is invalid, expired, or revoked." }, 401);
    if (status.kind === "foreign-workspace") return context.json({ error: "Workspace not found." }, 404);
    return context.json(status.receipt);
  });
}
