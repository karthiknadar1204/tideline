import { failureReasonGuidance, sessionIntelligenceResponse } from "@tideline/contracts/session-intelligence";
import { reportFilterParams } from "./reports";
import { fetchWorkspaceResource } from "./workspace";
import type { readTrendFilters } from "./workspace-trends";

const guidance: Readonly<Record<string, string>> = failureReasonGuidance;
export { guidance as failureReasonGuidance };

export async function readSessionIntelligence(workspaceId: string, filters: ReturnType<typeof readTrendFilters>) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/intelligence?${reportFilterParams(filters)}`);
  if (!response?.ok) throw new Error("Could not open session intelligence.");
  return sessionIntelligenceResponse.parse(await response.json());
}
