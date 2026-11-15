export function normalizeWorkspacePath(path: string, workspaceId: string) {
  return path.replace(/^\/workspace\/[^/]+(?=\/|$)/, `/workspace/${workspaceId}`);
}
