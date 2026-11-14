import { buildWorkspaceReport, readReportFilters, reportCsv } from "../../../../../lib/reports";
import { listWorkspaceSessions } from "../../../../../lib/workspace";

export async function GET(request: Request, { params }: RouteContext<"/workspace/[id]/reports/export">) {
  const { id } = await params;
  const sessions = await listWorkspaceSessions(id);
  const filters = readReportFilters(new URL(request.url).searchParams);
  const report = buildWorkspaceReport(sessions, filters);
  const range = report.firstDay ? `${report.firstDay}-to-${filters.through}` : `through-${filters.through}`;
  return new Response(reportCsv(report), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="tideline-report-${range}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
