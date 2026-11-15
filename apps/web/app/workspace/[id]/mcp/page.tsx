import { ActivityPage } from "../dashboard/activity-page";

export default async function McpPage({ params, searchParams }: PageProps<"/workspace/[id]/mcp">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <ActivityPage workspaceId={id} kind="mcp" query={query} />;
}
