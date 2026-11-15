import { cliSetupCreated, cliSetupSnapshot } from "@tideline/contracts";
import { cliPairedInstallCommand } from "../../../../lib/cli-install";
import { fetchWorkspaceResource } from "../../../../lib/workspace";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request, { params }: RouteContext<"/workspace/[id]/connect-state">) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Open setup from your workspace." }, { status: 403, headers });
  }
  const { id } = await params;
  const response = await fetchWorkspaceResource(`${encodeURIComponent(id)}/cli-setups`, { method: "POST", allowNotFound: true });
  const setup = cliSetupCreated.safeParse(response?.ok ? await response.json().catch(() => null) : null);
  if (!setup.success) {
    return Response.json({ error: "Couldn't create a setup command." }, { status: response?.status === 404 ? 404 : 502, headers });
  }
  const { code, id: setupId, expiresAt, progress } = setup.data;
  return Response.json({ id: setupId, expiresAt, progress, command: cliPairedInstallCommand(code) }, { status: 201, headers });
}

export async function GET(request: Request, { params }: RouteContext<"/workspace/[id]/connect-state">) {
  const setupId = cliSetupSnapshot.shape.id.safeParse(new URL(request.url).searchParams.get("id"));
  if (!setupId.success) {
    return Response.json({ error: "Connection not found." }, { status: 404, headers });
  }
  const { id } = await params;
  const response = await fetchWorkspaceResource(`${encodeURIComponent(id)}/cli-setups/${setupId.data}`, { allowNotFound: true });
  const setup = cliSetupSnapshot.safeParse(response?.ok ? await response.json().catch(() => null) : null);
  if (!setup.success) {
    return Response.json({ error: "Couldn't read the setup status." }, { status: response?.status === 404 ? 404 : 502, headers });
  }
  return Response.json(setup.data, { headers });
}
