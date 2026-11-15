import type { CliSetupTerminalProgress } from "@tideline/contracts";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cliSetups } from "./schema";

const phase = sql<string>`${cliSetups.progress} ->> 'phase'`;
const browserFields = {
  id: cliSetups.id,
  expiresAt: cliSetups.expiresAt,
  progress: cliSetups.progress,
};
const terminalFields = { id: cliSetups.id, workspaceId: cliSetups.workspaceId };
const phasesBefore: Record<CliSetupTerminalProgress["phase"], string[]> = {
  choosing: ["scanning"],
  approving: ["scanning", "choosing"],
  ready: ["starting"],
  cancelled: ["scanning", "choosing", "approving"],
  failed: ["scanning", "choosing", "approving", "starting"],
};

function active() {
  return gt(cliSetups.expiresAt, sql`clock_timestamp()`);
}

export function createCliSetupStore(databaseUrl: string) {
  const db = drizzle(postgres(databaseUrl));
  return {
    async begin(workspaceId: string, userId: string, codeHash: string) {
      return db.transaction(async (transaction) => {
        await transaction.delete(cliSetups).where(lte(cliSetups.expiresAt, sql`clock_timestamp()`));
        const [setup] = await transaction.insert(cliSetups).values({
          workspaceId,
          userId,
          codeHash,
          expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
          progress: { phase: "waiting" },
        }).returning(browserFields);
        return setup;
      });
    },
    async read(id: string, workspaceId: string, userId: string) {
      const [setup] = await db.select(browserFields).from(cliSetups).where(and(
        eq(cliSetups.id, id),
        eq(cliSetups.workspaceId, workspaceId),
        eq(cliSetups.userId, userId),
        active(),
      ));
      return setup;
    },
    async claim(codeHash: string, writerHash: string) {
      const [claimed] = await db.update(cliSetups).set({
        writerHash,
        expiresAt: sql`clock_timestamp() + interval '20 minutes'`,
        progress: { phase: "scanning" },
      }).where(and(eq(cliSetups.codeHash, codeHash), isNull(cliSetups.writerHash), active())).returning(terminalFields);
      if (claimed) return claimed;
      const [retry] = await db.select(terminalFields).from(cliSetups).where(and(
        eq(cliSetups.codeHash, codeHash), eq(cliSetups.writerHash, writerHash), eq(phase, "scanning"), active(),
      ));
      return retry;
    },
    async update(id: string, writerHash: string, progress: CliSetupTerminalProgress) {
      const [updated] = await db.update(cliSetups).set({ progress }).where(and(
        eq(cliSetups.id, id), eq(cliSetups.writerHash, writerHash), inArray(phase, phasesBefore[progress.phase]), active(),
      )).returning({ id: cliSetups.id });
      return Boolean(updated);
    },
    async approve(id: string, workspaceId: string, writerHash: string, userId: string) {
      const [approved] = await db.update(cliSetups).set({
        progress: sql`jsonb_set(${cliSetups.progress}, '{phase}', '"starting"')`,
      }).where(and(
        eq(cliSetups.id, id), eq(cliSetups.workspaceId, workspaceId), eq(cliSetups.writerHash, writerHash),
        eq(cliSetups.userId, userId), eq(phase, "approving"), active(),
      )).returning(terminalFields);
      return approved;
    },
  };
}
