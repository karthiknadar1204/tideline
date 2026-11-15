import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { syncGrants } from "./schema";

export function activeSyncGrant(tokenHash: string) {
  return and(eq(syncGrants.tokenHash, tokenHash), isNull(syncGrants.revokedAt), gt(syncGrants.expiresAt, sql`clock_timestamp()`));
}
