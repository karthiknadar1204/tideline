import { weeklyDigestSessionsResponse } from "@tideline/contracts";
import { buildDigest, digestWeeks } from "@tideline/contracts/digest";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

export async function readWeeklyDigest(workspaceId: string, requestedWeek: string | string[] | undefined) {
  const weeks = digestWeeks(requestedWeek);
  const range = new URLSearchParams({ from: weeks.prior.from, to: weeks.current.to });
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/weekly-digest?${range}`);
  if (!response?.ok) throw new Error("Could not open weekly digest.");
  return buildDigest(weeklyDigestSessionsResponse.parse(await response.json()), weeks);
}
