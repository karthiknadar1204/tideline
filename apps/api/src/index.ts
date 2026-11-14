import type { HealthResponse } from "@tideline/contracts";
import { Hono } from "hono";
import { createWorkspaceRoutes } from "./workspace-routes";

const app = new Hono();

app.get("/health", (context) => {
  return context.json({ status: "ok" } satisfies HealthResponse);
});

app.route("/v1", createWorkspaceRoutes());

const port = Number(process.env.TIDELINE_API_PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("TIDELINE_API_PORT must be an integer from 1 to 65535.");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
});

console.info(`Tideline API listening on ${server.url}`);
