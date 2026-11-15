import { workspaceSessionSearchQuery } from "@tideline/contracts";
import type { WorkspaceSessionSearchQuery } from "@tideline/contracts";

type SearchParams = Record<string, string | string[] | undefined>;
const fields = ["query", "source", "repository", "model", "from", "to", "sort", "page"] as const;

export function parseSessionFilters(input: SearchParams) {
  const present = Object.fromEntries(fields.flatMap((field) => {
    const value = input[field];
    return typeof value === "string" && value.trim() ? [[field, value.trim()]] : [];
  }));
  const result = workspaceSessionSearchQuery.safeParse(present);
  const duplicates = fields.some((field) => Array.isArray(input[field]));
  if (result.success && !duplicates) return { filters: result.data, invalid: false };

  return { filters: workspaceSessionSearchQuery.parse({}), invalid: true };
}

export function sessionFilterParams(filters: WorkspaceSessionSearchQuery) {
  const params = new URLSearchParams();
  for (const name of fields) {
    const value = filters[name];
    if (value !== undefined && value !== "" && !(name === "page" && value === 1)) params.set(name, String(value));
  }
  return params;
}

export function sessionListHref(workspaceId: string, filters: WorkspaceSessionSearchQuery) {
  const query = sessionFilterParams(filters).toString();
  return `/workspace/${workspaceId}${query ? `?${query}` : ""}`;
}

export function sessionDetailHref(workspaceId: string, sessionId: string, filters: WorkspaceSessionSearchQuery) {
  const query = sessionFilterParams(filters).toString();
  return `/workspace/${workspaceId}/sessions/${sessionId}${query ? `?${query}` : ""}`;
}

export function sessionHasFilters({ query, source, repository, model, from, to }: WorkspaceSessionSearchQuery) {
  return Boolean(query || source || repository || model || from || to);
}
