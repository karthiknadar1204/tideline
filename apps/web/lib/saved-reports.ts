import { savedReportDetail, savedReportList } from "@tideline/contracts";
import { fetchWorkspaceResource } from "./workspace";

const savedDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export const savedReportVisibilityLabel = { private: "Private", workspace: "Shared with workspace" };

export function formatSavedReportDate(createdAt: string) {
  return savedDate.format(new Date(createdAt));
}

export async function listSavedReports(workspaceId: string, page: number) {
  const query = new URLSearchParams({ page: String(page) });
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/saved-reports?${query}`);
  if (!response?.ok) throw new Error("Could not open saved reports.");
  return savedReportList.parse(await response.json());
}

export async function readSavedReport(workspaceId: string, reportId: string) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/saved-reports/${encodeURIComponent(reportId)}`);
  if (!response?.ok) throw new Error("Could not open the saved report.");
  return savedReportDetail.parse(await response.json());
}
