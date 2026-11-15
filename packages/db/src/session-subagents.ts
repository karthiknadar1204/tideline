import { isDeepStrictEqual } from "node:util";
import { MAX_SESSION_SUBAGENTS } from "@tideline/contracts";
import type { SessionCapture } from "@tideline/contracts";

type Subagents = NonNullable<SessionCapture["subagents"]>;
const location = ({ parentAgentId, line, index }: Subagents["transcripts"][number]) => `${parentAgentId ?? ""}:${line}:${index}`;

function mergeSubagents(previous: Subagents | undefined, incoming: Subagents | undefined) {
  if (!previous || !incoming) return previous ?? incoming;
  const byId = new Map(previous.transcripts.map((record) => [record.agentId, record]));
  const locations = new Set(previous.transcripts.map(location));
  let truncated = previous.truncated || incoming.truncated;
  for (const record of incoming.transcripts) {
    if (record.parentAgentId && (byId.get(record.parentAgentId)?.throughLine ?? 0) < record.line) continue;
    const prior = byId.get(record.agentId);
    if (prior) {
      if (location(record) !== location(prior) || record.throughLine < prior.throughLine ||
          record.messages.length < prior.messages.length ||
          !isDeepStrictEqual(record.messages.slice(0, prior.messages.length), prior.messages) ||
          (record.throughLine === prior.throughLine && record.messages.length !== prior.messages.length)) continue;
      byId.set(record.agentId, { ...record, truncated: record.truncated || prior.truncated });
      continue;
    }
    if (locations.has(location(record))) continue;
    if (byId.size >= MAX_SESSION_SUBAGENTS) {
      truncated = true;
      continue;
    }
    locations.add(location(record));
    byId.set(record.agentId, record);
  }
  return { source: previous.source, truncated, transcripts: [...byId.values()] };
}

export function mergeSessionCapture(previous: SessionCapture | null, incoming: SessionCapture | undefined) {
  if (!previous || !incoming) return incoming;
  if (incoming.throughLine < previous.throughLine) return;
  const { subagents: previousSubagents, ...previousCapture } = previous;
  const { subagents, ...incomingCapture } = incoming;
  if (incoming.throughLine === previous.throughLine && !isDeepStrictEqual(previousCapture, incomingCapture)) return null;
  const mergedSubagents = mergeSubagents(previousSubagents, subagents);
  const merged = mergedSubagents ? { ...incomingCapture, subagents: mergedSubagents } : incomingCapture;
  return isDeepStrictEqual(previous, merged) ? undefined : merged;
}
