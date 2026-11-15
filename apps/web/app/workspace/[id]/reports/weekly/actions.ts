"use server";

import { savedReportSummary } from "@tideline/contracts";
import { digestReport } from "@tideline/contracts/digest";
import { redirect } from "next/navigation";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";
import { readWeeklyDigest } from "./digest";

export async function saveWeeklyDigest(workspaceId: string, week: string) {
  const digest = await readWeeklyDigest(workspaceId, week);
  const workspace = encodeURIComponent(workspaceId);
  const response = await fetchWorkspaceResource(`${workspace}/saved-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...digestReport(digest, "weekly"), visibility: "private" }),
  });
  const report = savedReportSummary.safeParse(response?.ok ? await response.json() : undefined);
  if (!report.success) redirect(`/workspace/${workspace}/reports/weekly?week=${digest.periods.current.from}&save=failed`);
  redirect(`/workspace/${workspace}/reports/saved/${report.data.id}`);
}
