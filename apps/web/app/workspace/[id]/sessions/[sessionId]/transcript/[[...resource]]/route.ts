import { transcriptHash } from "@tideline/contracts/transcripts";
import { fetchWorkspaceResource } from "../../../../../../../lib/workspace";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: RouteContext<"/workspace/[id]/sessions/[sessionId]/transcript/[[...resource]]">) {
  const { id, sessionId, resource = [] } = await params;
  const path = `${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/transcript`;
  if (resource[0] === "attachments" && resource.length === 2 && transcriptHash.safeParse(resource[1]).success) {
    const response = await fetchWorkspaceResource(`${path}/attachments/${resource[1]}`, { allowNotFound: true });
    return response?.ok ? new Response(response.body, {
      headers: { ...privateHeaders, "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream" },
    }) : new Response(null, { status: response?.status ?? 503, headers: privateHeaders });
  }
  if (resource.length > 1 || resource.length === 1 && !["download", "streams"].includes(resource[0])) return new Response(null, { status: 404 });
  const download = resource[0] === "download";
  const query = new URL(request.url).searchParams;
  const parameters = new URLSearchParams();
  for (const name of ["after", "stream"]) {
    const value = query.get(name);
    if (value !== null) parameters.set(name, value);
  }
  const endpoint = `${path}${resource.length ? `/${resource[0]}` : ""}?${parameters}`;
  const response = await fetchWorkspaceResource(endpoint, { allowNotFound: true, ...(download && { signal: request.signal }) });
  if (!response?.ok || !response.body) return new Response(null, { status: response?.status ?? 503, headers: privateHeaders });
  const headers = new Headers(privateHeaders);
  for (const name of ["Content-Type", "Content-Disposition"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { headers });
}
