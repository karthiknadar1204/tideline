"use server";

import { savedReportDetail, workspaceResponse } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { fetchWorkspaceResource } from "../../../../../../lib/workspace";

export async function deleteSavedReport(workspaceId: string, reportId: string): Promise<string | null> {
  if (!workspaceResponse.shape.id.safeParse(workspaceId).success || !savedReportDetail.shape.id.safeParse(reportId).success) notFound();
  const response = await fetchWorkspaceResource(`${workspaceId}/saved-reports/${reportId}`, { method: "DELETE", allowNotFound: true });
  if (!response?.ok) return "Could not delete this report. Refresh to check whether it is still available.";

  const path = `/workspace/${workspaceId}/reports/saved`;
  revalidatePath(path);
  redirect(path);
}
