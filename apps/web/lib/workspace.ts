import { auth } from "@clerk/nextjs/server";
import {
  workspaceSessionDetailResponse,
  sessionSummariesResponse,
  workspaceAccess,
  workspaceAccessList,
  workspaceAddress,
  workspaceCliStatus,
  workspaceInsightSessionSummariesResponse,
  workspaceResponse,
  workspaceSessionSearchWithFacets,
  workspaceTeam,
  workspaceUsageTargets,
} from "@tideline/contracts";
import type { WorkspaceNameUpdate, WorkspaceSessionSearchQuery, WorkspaceUsageTargetUpdate } from "@tideline/contracts";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { sessionFilterParams } from "./session-filters";

export function fetchTidelineApi(path: string, options: RequestInit = {}) {
  const apiUrl = new URL(process.env.TIDELINE_API_URL ?? "http://127.0.0.1:3001");
  const isLocalHttp = apiUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("TIDELINE_API_URL must use HTTPS or local HTTP.");
  }

  return fetch(new URL(`/v1${path}`, apiUrl), {
    ...options,
    cache: "no-store",
    redirect: "error",
    signal: options.signal ?? AbortSignal.timeout(5_000),
  }).catch(() => null);
}

export async function fetchWorkspaceResource(path: string, { allowNotFound, ...options }: RequestInit & { allowNotFound?: boolean } = {}) {
  const { getToken, redirectToSignIn } = await auth();
  const token = await getToken();
  if (!token) return redirectToSignIn();

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetchTidelineApi(`/workspaces/${path}`, { ...options, headers });

  if (response?.status === 401) return redirectToSignIn();
  if (response?.status === 410) redirect("/account/delete");
  if (response?.status === 404 && !allowNotFound) notFound();
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

export const readWorkspaceAccess = cache(async (workspaceId: string) => {
  return workspaceAccess.parse(await requestWorkspaceResource(encodeURIComponent(workspaceId)));
});

export const readWorkspaceAddress = cache(async (workspaceId: string) => {
  return workspaceAddress.parse(await requestWorkspaceResource(`address/${encodeURIComponent(workspaceId)}`));
});

export const listAccessibleWorkspaces = cache(async () => {
  return workspaceAccessList.parse(await requestWorkspaceResource("list"));
});

export async function hasWorkspaceCliApproval(workspaceId: string) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/cli-status`, { allowNotFound: true });
  const status = workspaceCliStatus.safeParse(response?.ok ? await response.json().catch(() => undefined) : undefined);
  return status.success && status.data.approved;
}

export const listWorkspaceSessions = cache(async (workspaceId: string) => {
  return sessionSummariesResponse.parse(
    await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/sessions`),
  );
});

export const listWorkspaceInsightSessions = cache(async (workspaceId: string) => {
  return workspaceInsightSessionSummariesResponse.parse(
    await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/sessions?insights=1`),
  );
});

export const readWorkspaceTeam = cache(async (workspaceId: string) => {
  return workspaceTeam.parse(await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/team`));
});

const readSessionSearch = cache(async (workspaceId: string, params: string) => {
  return workspaceSessionSearchWithFacets.parse(
    await requestWorkspaceResource(`${encodeURIComponent(workspaceId)}/session-search${params ? `?${params}` : ""}`),
  );
});

export function searchWorkspaceSessions(workspaceId: string, filters: WorkspaceSessionSearchQuery) {
  return readSessionSearch(workspaceId, sessionFilterParams(filters).toString());
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
  return workspaceSessionDetailResponse.parse(
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
