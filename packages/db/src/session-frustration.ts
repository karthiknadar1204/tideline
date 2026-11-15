import { sql } from "drizzle-orm";
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

export const sessionReportedFrustration = sql<boolean>`exists (
  select 1 from jsonb_array_elements(${agentSessions.messages}) with ordinality as entry(message, position)
  where entry.position <= ${agentSessions.readyMessageCount} and entry.message ->> 'role' = 'user'
    and regexp_replace(regexp_replace(regexp_replace(
      entry.message ->> 'text', ${fencedCode}, '', 'g'
    ), ${quotedLine}, '', 'gn'), ${inlineExcerpt}, '', 'g') ~* ${reportedPhrase}
)`;
