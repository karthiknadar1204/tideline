import { auth } from "@clerk/nextjs/server";
import {
  sessionDetailResponse,
  sessionSummariesResponse,
  workspaceResponse,
  workspaceSessionSearchResponse,
  workspaceUsageTargets,
} from "@tideline/contracts";
import type { WorkspaceNameUpdate, WorkspaceSessionSearchQuery, WorkspaceUsageTargetUpdate } from "@tideline/contracts";
import { notFound, redirect } from "next/navigation";
import { sessionFilterParams } from "./session-filters";

async function fetchWorkspaceResource(path: string, options: RequestInit = {}) {
  const { getToken } = await auth.protect();
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const apiUrl = new URL(process.env.TIDELINE_API_URL ?? "http://127.0.0.1:3001");
  const isLocalHttp = apiUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("TIDELINE_API_URL must use HTTPS or local HTTP.");
  }

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(new URL(`/v1/workspaces/${path}`, apiUrl), {
    ...options,
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);

  if (response?.status === 401) redirect("/sign-in");
  if (response?.status === 404) notFound();
  return response;
}

async function requestWorkspaceResource(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetchWorkspaceResource(path, { method });
  if (!response?.ok) throw new Error("Could not open the Tideline workspace.");

  return response.json();
}

export async function requestWorkspace(path: string, method: "GET" | "POST") {
  return workspaceResponse.parse(await requestWorkspaceResource(path, method));
}

export async function listWorkspaceSessions(workspaceId: string) {
  return sessionSummariesResponse.parse(
    await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/sessions`),
  );
}

export async function searchWorkspaceSessions(workspaceId: string, filters: WorkspaceSessionSearchQuery) {
  const params = sessionFilterParams(filters).toString();
  return workspaceSessionSearchResponse.parse(
    await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/session-search${params ? `?${params}` : ""}`),
  );
}

export async function readWorkspaceUsageTargets(workspaceId: string) {
  return workspaceUsageTargets.parse(
    await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/usage-targets`),
  );
}

export async function updateWorkspaceUsageTarget(workspaceId: string, update: WorkspaceUsageTargetUpdate) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/usage-targets`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return response?.ok === true;
}

export async function readWorkspaceSession(workspaceId: string, sessionId: string) {
  return sessionDetailResponse.parse(
    await requestWorkspaceResource(
      `${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
}

export async function updateWorkspaceName(workspaceId: string, input: WorkspaceNameUpdate) {
  const response = await fetchWorkspaceResource(encodeURIComponent(workspaceId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response?.ok) return;
  const result = workspaceResponse.safeParse(await response.json().catch(() => null));
  return result.data;
}
