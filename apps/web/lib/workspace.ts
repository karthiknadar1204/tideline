import { auth } from "@clerk/nextjs/server";
import {
  sessionDetailResponse,
  sessionSummariesResponse,
  workspaceResponse,
} from "@tideline/contracts";
import { notFound, redirect } from "next/navigation";

async function requestWorkspaceResource(path: string, method: "GET" | "POST" = "GET") {
  const { getToken } = await auth.protect();
  const token = await getToken();
  if (!token) redirect("/sign-in");

  const apiUrl = new URL(process.env.TIDELINE_API_URL ?? "http://127.0.0.1:3001");
  const isLocalHttp = apiUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("TIDELINE_API_URL must use HTTPS or local HTTP.");
  }

  const response = await fetch(new URL(`/v1/workspaces/${path}`, apiUrl), {
    method,
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });

  if (response.status === 401) redirect("/sign-in");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("Could not open the Tideline workspace.");

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

export async function readWorkspaceSession(workspaceId: string, sessionId: string) {
  return sessionDetailResponse.parse(
    await requestWorkspaceResource(
      `${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
}
