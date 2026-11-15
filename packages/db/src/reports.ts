import { createHash } from "node:crypto";
import { MAX_REPORT_SESSION_REFERENCES, SAVED_REPORT_PAGE_SIZE } from "@tideline/contracts";
import type { LinkSavedReportSessionRequest, LinkSavedReportSessionResponse, SaveReportRequest, SavedReportDetail, SavedReportList, SavedReportSummary } from "@tideline/contracts";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentSessions, reportSessionFollows, savedReports, workspaces } from "./schema";
import { lockWorkspace, workspaceAccessibleTo } from "./workspaces";

type ReportAccess = { workspaceId: string; userId: string };
type SaveResult =
  | { kind: "saved"; report: SavedReportSummary; created: boolean }
  | { kind: "inaccessible" | "invalid-sessions" };
type LinkResult =
  | { kind: "found"; result: LinkSavedReportSessionResponse }
  | { kind: "report-unavailable" | "session-unavailable" | "ambiguous" | "limit" | "follow-unavailable" };

const summaryFields = {
  id: savedReports.id,
  authorId: savedReports.authorId,
  title: savedReports.title,
  visibility: savedReports.visibility,
  createdAt: savedReports.createdAt,
  sessionIds: savedReports.sessionIds,
};

function summarize({ authorId, createdAt, ...report }: Pick<typeof savedReports.$inferSelect, keyof typeof summaryFields>, userId: string): SavedReportSummary {
  return { ...report, createdAt: createdAt.toISOString(), isAuthor: authorId === userId };
}

function visibleReports({ workspaceId, userId }: ReportAccess) {
  return and(eq(savedReports.workspaceId, workspaceId), or(eq(savedReports.authorId, userId), eq(savedReports.visibility, "workspace")));
}

export function createSavedReportStore(databaseUrl: string) {
  const connection = postgres(databaseUrl);
  const db = drizzle(connection);

  return {
    async list(access: ReportAccess, page: number): Promise<SavedReportList | undefined> {
      return db.transaction(async (transaction) => {
        const [workspace] = await transaction.select({ id: workspaces.id }).from(workspaces)
          .where(and(eq(workspaces.id, access.workspaceId), workspaceAccessibleTo(access.userId)));
        if (!workspace) return;

        const rows = await transaction.select(summaryFields).from(savedReports).where(visibleReports(access))
          .orderBy(desc(savedReports.createdAt), desc(savedReports.id))
          .limit(SAVED_REPORT_PAGE_SIZE + 1).offset((page - 1) * SAVED_REPORT_PAGE_SIZE);
        return {
          reports: rows.slice(0, SAVED_REPORT_PAGE_SIZE).map((report) => summarize(report, access.userId)),
          nextPage: rows.length > SAVED_REPORT_PAGE_SIZE ? page + 1 : null,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async read(access: ReportAccess, reportId: string): Promise<SavedReportDetail | undefined> {
      const [row] = await db.select({ ...summaryFields, markdown: savedReports.markdown }).from(savedReports)
        .innerJoin(workspaces, eq(workspaces.id, savedReports.workspaceId))
        .where(and(visibleReports(access), eq(savedReports.id, reportId), workspaceAccessibleTo(access.userId)));
      if (!row) return;
      const { markdown, ...summary } = row;
      return { ...summarize(summary, access.userId), markdown };
    },

    async save(access: ReportAccess, draft: SaveReportRequest): Promise<SaveResult> {
      const { title, markdown, visibility, sessionIds } = draft;
      const contentHash = createHash("sha256").update(JSON.stringify([title, markdown, visibility, sessionIds])).digest("hex");

      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (!workspace?.role) return { kind: "inaccessible" };

        const identity = and(eq(savedReports.workspaceId, workspace.id), eq(savedReports.authorId, access.userId), eq(savedReports.contentHash, contentHash));
        const [existing] = await transaction.select(summaryFields).from(savedReports).where(identity);
        if (existing) return { kind: "saved", report: summarize(existing, access.userId), created: false };

        if (sessionIds.length) {
          const references = await transaction.select({ id: agentSessions.id }).from(agentSessions).where(and(
            eq(agentSessions.workspaceId, workspace.id), gt(agentSessions.readyMessageCount, 0), inArray(agentSessions.id, sessionIds),
          ));
          if (references.length !== sessionIds.length) return { kind: "invalid-sessions" };
        }

        const [created] = await transaction.insert(savedReports)
          .values({ ...draft, workspaceId: workspace.id, authorId: access.userId, contentHash })
          .returning(summaryFields);
        return { kind: "saved", report: summarize(created, access.userId), created: true };
      });
    },

    async remove(access: ReportAccess, reportId: string) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (!workspace?.role) return false;
        const [removed] = await transaction.delete(savedReports).where(and(
          eq(savedReports.workspaceId, workspace.id), eq(savedReports.authorId, access.userId), eq(savedReports.id, reportId),
        )).returning({ id: savedReports.id });
        return Boolean(removed);
      });
    },

    async linkSession(access: ReportAccess, reportId: string, reference: LinkSavedReportSessionRequest): Promise<LinkResult> {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (!workspace?.role) return { kind: "report-unavailable" };
        const ownReport = and(eq(savedReports.workspaceId, workspace.id), eq(savedReports.authorId, access.userId), eq(savedReports.id, reportId));
        const [report] = await transaction.select(summaryFields).from(savedReports).where(ownReport);
        if (!report) return { kind: "report-unavailable" };

        const ready = and(eq(agentSessions.workspaceId, workspace.id), gt(agentSessions.readyMessageCount, 0), isNull(agentSessions.deletedAt));
        const sources = eq(agentSessions.sourceSessionId, reference.sessionId);
        const matches = await transaction.select({ id: agentSessions.id, source: agentSessions.source, uploadedBy: agentSessions.uploadedBy })
          .from(agentSessions).where(and(ready,
          reference.source ? and(eq(agentSessions.source, reference.source), sources) : or(eq(agentSessions.id, reference.sessionId), sources),
        ));
        const direct = reference.source === undefined ? matches.find(({ id }) => id === reference.sessionId) : undefined;
        if (!direct && matches.length > 1) return { kind: "ambiguous" };
        const session = direct ?? matches[0];
        if (!session) return { kind: "session-unavailable" };
        const linked = !report.sessionIds.includes(session.id);
        if (linked && report.sessionIds.length >= MAX_REPORT_SESSION_REFERENCES) return { kind: "limit" };

        let followUntil: string | undefined;
        if (reference.follow) {
          if (session.uploadedBy !== (workspace.kind === "team" ? access.userId : null) ||
              (session.source !== "codex" && session.source !== "claude-code")) return { kind: "follow-unavailable" };
          const expiresAt = sql`clock_timestamp() + interval '7 days'`;
          const [follow] = await transaction.insert(reportSessionFollows).values({ reportId, sessionId: session.id, expiresAt })
            .onConflictDoUpdate({ target: [reportSessionFollows.reportId, reportSessionFollows.sessionId], set: { expiresAt } })
            .returning({ expiresAt: reportSessionFollows.expiresAt });
          followUntil = follow.expiresAt.toISOString();
        }

        const sessionIds = linked ? [...report.sessionIds, session.id] : report.sessionIds;
        // Keep the original save fingerprint so replaying that save returns this report and its new citations.
        if (linked) await transaction.update(savedReports).set({ sessionIds }).where(ownReport);
        return { kind: "found", result: { report: summarize({ ...report, sessionIds }, access.userId), sessionId: session.id, linked, followUntil } };
      });
    },

    async close() {
      await connection.end();
    },
  };
}
