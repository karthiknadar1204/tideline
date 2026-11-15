import { MAX_CODEX_IMPORT_BYTES, MAX_SESSION_TURNS, MAX_TURN_MODELS } from "@tideline/contracts";
import type { ModelTokens, SessionImportRequest, SessionTurn, SessionTurnTrace } from "@tideline/contracts";
import { createModelUsage } from "./session-usage";

export function inputTokens(tokens: ModelTokens) {
  return tokens.input + tokens.cachedInput + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheWriteUnknown;
}

function captureTurn(promptLine: number) {
  const usage = createModelUsage(MAX_TURN_MODELS);
  const metrics: Pick<SessionTurn, "contextWindow" | "peakRequestInput" | "durationMs" | "timeToFirstTokenMs"> = {
    contextWindow: null, peakRequestInput: null, durationMs: null, timeToFirstTokenMs: null,
  };
  return {
    usage,
    metrics,
    snapshot(): SessionTurn {
      const { models, tokenCoverage } = usage.snapshot(promptLine);
      return { promptLine, models, tokenCoverage, ...metrics };
    },
  };
}

export type CapturedTurn = ReturnType<typeof captureTurn>;

export function createSessionTurns() {
  const turns: CapturedTurn[] = [];
  let omittedTurns = 0;

  return {
    start(promptLine: number) {
      const turn = captureTurn(promptLine);
      turns.push(turn);
      if (turns.length > MAX_SESSION_TURNS) {
        turns.shift();
        omittedTurns += 1;
      }
      return turn;
    },
    snapshot(throughLine: number): SessionTurnTrace | undefined {
      return turns.length ? { throughLine, omittedTurns, turns: turns.map((turn) => turn.snapshot()) } : undefined;
    },
  };
}

export function prepareBaseSessionImport(data: SessionImportRequest) {
  const body = JSON.stringify(data);
  const analytics = data.session.analytics;
  if (Buffer.byteLength(body) <= MAX_CODEX_IMPORT_BYTES || !analytics?.turnTrace) return { data, body };

  const reduced = { ...data, session: { ...data.session, analytics: { ...analytics, turnTrace: undefined } } };
  return { data: reduced, body: JSON.stringify(reduced) };
}
