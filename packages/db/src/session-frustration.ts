import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { agentSessions } from "./schema";

const quotedLine = "^[[:blank:]]*>[^\n]*";
const fencedCode = "(```|~~~).*?(\\1|$)";
const inlineExcerpt = '(`[^`\n]*`|"[^"\n]*"|“[^”\n]*”)';
const phrases = [
  "i(?: am|['’]m) (?:really |very )?frustrated",
  "this is (?:really )?frustrating",
  "this still (?:isn['’]t working|doesn['’]t work|does not work|fails)",
  "you broke (?:the|my|our|this)",
  "(?:undo|revert) your (?:last |previous )?(?:change|changes|edit|edits)",
].join("|");
const reportedPhrase = String.raw`(^|[.!?][[:space:]]+|\n)[[:space:]]*(?:no[,.][[:space:]]+)?(?:${phrases})\M`;
const correctionPhrase = String.raw`(^|[.!?][[:space:]]+|\n)[[:space:]]*(?:sorry[,.][[:space:]]+)?(?:i (?:was wrong|made a mistake|missed that|misread|misunderstood)|my (?:earlier|previous) (?:answer|assumption|change) was (?:wrong|incorrect)|i(?:['’]m| am) sorry for (?:the (?:mistake|confusion|error|oversight)|misreading|misunderstanding))\M`;

export function reportedSessionFriction(message: SQL, kind: "frustration" | "correction") {
  const pattern = kind === "frustration" ? reportedPhrase : correctionPhrase;
  return sql`regexp_replace(regexp_replace(regexp_replace(${message} ->> 'text', ${fencedCode}, '', 'g'),
    ${quotedLine}, '', 'gn'), ${inlineExcerpt}, '', 'g') ~* ${pattern}`;
}

export const sessionReportedFrustration = sql<boolean>`exists (
  select 1 from jsonb_array_elements(${agentSessions.messages}) with ordinality as entry(message, position)
  where entry.position <= ${agentSessions.readyMessageCount} and entry.message ->> 'role' = 'user'
    and (${reportedSessionFriction(sql`entry.message`, "frustration")})
)`;
