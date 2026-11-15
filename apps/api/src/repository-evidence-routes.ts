import {
  MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES, repositoryEvidenceQuery, repositoryInstructionsResponse,
  repositoryInstructionUpload, repositoryKey, workspaceResponse,
} from "@tideline/contracts";
import type { createSessionStore } from "@tideline/db/sessions";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

export function registerRepositoryEvidenceRoutes(
  routes: Hono<WorkspaceContext>,
  sessions: ReturnType<typeof createSessionStore>,
  parseSyncAuthorization: (authorization: string | undefined) => string | undefined,
) {
  routes.get("/workspaces/:id/repositories/:repository/files", async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    const repository = repositoryKey.safeParse(context.req.param("repository"));
    if (!workspaceId.success || !repository.success) return context.json({ error: "Repository not found." }, 404);
    const query = repositoryEvidenceQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Invalid repository filters." }, 400);

    const result = await sessions.repositoryFiles({
      workspaceId: workspaceId.data, repository: repository.data, userId: context.get("userId"),
    }, query.data);
    return result ? context.json(result) : context.json({ error: "Repository not found." }, 404);
  });

  routes.get("/workspaces/:id/repositories/:repository/instructions", async (context) => {
    const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    const repository = repositoryKey.safeParse(context.req.param("repository"));
    if (!workspaceId.success || !repository.success) return context.json({ error: "Repository not found." }, 404);

    const result = await sessions.repositoryInstructions({
      workspaceId: workspaceId.data, repository: repository.data, userId: context.get("userId"),
    });
    return result === undefined ? context.json({ error: "Repository not found." }, 404)
      : context.json(repositoryInstructionsResponse.parse(result));
  });

  routes.post("/cli/sync/repository-instructions", bodyLimit({
    maxSize: 2 * MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES + 512,
    onError: (context) => context.json({ error: "Instruction snapshot exceeds the size limit." }, 413),
  }), async (context) => {
    const tokenHash = parseSyncAuthorization(context.req.header("Authorization"));
    if (!tokenHash) return context.json({ error: "A sync credential is required." }, 401);
    const request = repositoryInstructionUpload.safeParse(await context.req.json().catch(() => null));
    if (!request.success) return context.json({ error: "Expected a sanitized repository context snapshot." }, 400);
    const status = await sessions.receiveRepositoryInstructions(tokenHash, request.data);
    switch (status) {
      case "unauthorized": return context.json({ error: "The sync credential is invalid, expired, or revoked." }, 401);
      case "foreign-workspace": return context.json({ error: "Workspace not found." }, 404);
      case "unknown-repository": return context.json({ error: "Repository has no synced sessions yet." }, 404);
      case "accepted": return context.body(null, 204);
    }
  });
}
