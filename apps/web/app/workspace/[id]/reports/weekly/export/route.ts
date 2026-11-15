import { digestReport } from "@tideline/contracts/digest";
import { readWeeklyDigest } from "../digest";

export async function GET(request: Request, { params }: RouteContext<"/workspace/[id]/reports/weekly/export">) {
  const { id } = await params;
  const week = new URL(request.url).searchParams.getAll("week");
  const digest = await readWeeklyDigest(id, week.length === 1 ? week[0] : undefined);
  const report = digestReport(digest, "weekly");
  const references = report.sessionIds.length ? ["", "## Cited session IDs", "", ...report.sessionIds.map((id) => `- ${id}`)] : [];
  return new Response([`# ${report.title}`, "", report.markdown, ...references, ""].join("\n"), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="tideline-weekly-${digest.periods.current.from}.md"`,
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
