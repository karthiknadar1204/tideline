import type { CliSessionExport } from "@tideline/contracts";

export function* toolCalls(session: CliSessionExport) {
  const details = new Map(session.capture?.tools.map((detail) => [`${detail.line}:${detail.index}`, detail]));
  for (const { line, index, name, status, mcpServer } of session.activity?.tools ?? []) {
    const detail = details.get(`${line}:${index}`);
    yield {
      session_id: session.id, line, item_index: index, name, status, mcp_server: mcpServer ?? null,
      input: detail?.input ?? null, output: detail?.output ?? null, truncated: detail ? Number(detail.truncated) : null,
    };
  }
}

export function* sessionPrompts(session: CliSessionExport) {
  for (const { role, line, text, timestamp } of session.messages) {
    if (role === "user") yield { session_id: session.id, line, timestamp, text };
  }
}

export function* sessionAgentRuns(session: CliSessionExport) {
  for (const { line, index, name, status } of session.activity?.children ?? []) {
    yield { session_id: session.id, line, item_index: index, name, status };
  }
}

export function* sessionAgentMessages(session: CliSessionExport) {
  for (const { agentId, line, index, messages } of session.capture?.subagents?.transcripts ?? []) {
    for (const { line: childLine, timestamp, role, text } of messages) {
      yield { session_id: session.id, line, item_index: index, agent_id: agentId, child_line: childLine, timestamp, role, text };
    }
  }
}

export function* sessionFileChanges(session: CliSessionExport) {
  for (const { line, index, path, previousPath, change, diff, truncated } of session.capture?.files ?? []) {
    yield {
      session_id: session.id, line, item_index: index, path, previous_path: previousPath, change, diff,
      truncated: Number(truncated),
    };
  }
}

export function* sessionSetupFields(session: CliSessionExport) {
  for (const [key, value] of Object.entries(session.capture?.setup ?? {})) {
    if (value !== undefined) yield { session_id: session.id, key, value };
  }
}

export function* sessionCommits(session: CliSessionExport) {
  for (const { sha, line, url } of session.review?.commits ?? []) yield { session_id: session.id, sha, line, url };
}
