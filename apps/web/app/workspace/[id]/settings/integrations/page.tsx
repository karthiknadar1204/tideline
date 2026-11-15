import { McpSetup } from "../mcp-setup";

export default async function WorkspaceIntegrationSettings({ params }: PageProps<"/workspace/[id]/settings/integrations">) {
  const { id } = await params;

  return (
    <main aria-label="Integration settings" className="max-w-4xl">
      <McpSetup workspaceId={id} />
    </main>
  );
}
