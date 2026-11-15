import { unstable_cache } from "next/cache";
import chain from "./public-trends-data/chain-2026-11.json";
import terminalBench from "./public-trends-data/terminal-bench-2-1.json";
import traceLab from "./public-trends-data/tracelab-v0.0.2.json";

const sweBenchFeed = "https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json";

export type BenchmarkRun = {
  id: string;
  name: string;
  model: string;
  agent: string;
  effort: string | null;
  date: string;
  resolved: number;
  cost: number | null;
  duration: number | null;
  apiCalls: number | null;
};
export type BenchmarkBoard = { name: string; source: { name: string; href: string }; runs: BenchmarkRun[] };

export const traceLabSource = {
  name: "University of Washington SyFI TraceLab",
  release: "https://github.com/uw-syfi/TraceLab/releases/tag/v0.0.2",
  license: "https://creativecommons.org/licenses/by/4.0/",
};
export const publicAgentRuns = traceLab.runs;
export const publicModelUsage = traceLab.models;
export const publicLanguageUsage = chain;
export const publicTraceSample = traceLab.sample;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(value: unknown) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= 180 ? clean : null;
}

function day(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(value) ? value : null;
}

function measured(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

async function readPublicJson(url: string, maxBytes: number): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) throw new Error("Benchmark feed unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Benchmark feed exceeded its size limit");
      json += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(json + decoder.decode());
}

const readSweBench = unstable_cache(async (): Promise<BenchmarkBoard[]> => {
  const payload = await readPublicJson(sweBenchFeed, 8 * 1024 * 1024);
  if (!object(payload) || !Array.isArray(payload.leaderboards)) throw new Error("Unexpected benchmark feed");
  const source = { name: "SWE-bench leaderboard", href: "https://www.swebench.com/" };
  const boards = payload.leaderboards.slice(0, 20).flatMap((board: unknown) => {
    if (!object(board) || typeof board.name !== "string" || !Array.isArray(board.results)) return [];
    const runs = board.results.slice(0, 2_000).flatMap((value: unknown, index): BenchmarkRun[] => {
      if (!object(value)) return [];
      const name = label(value.name);
      const date = day(value.date);
      const resolved = measured(value.resolved, 100);
      if (!name || !date || resolved === null) return [];
      return [{
        id: `${index}`, name, date, resolved,
        cost: measured(value.instance_cost),
        duration: null,
        apiCalls: measured(value.instance_calls),
        effort: label(value.reasoning_effort),
        model: label(value.model_display) ?? name,
        agent: label(value.agent) ?? "Unspecified agent",
      }];
    });
    return runs.length ? [{ name: `SWE-bench ${board.name}`, source, runs }] : [];
  });
  if (!boards.length) throw new Error("Benchmark feed has no recognized results");
  return boards;
}, ["public-swe-bench-v2"], { revalidate: 3600 });

export async function readBenchmarkBoards(): Promise<{ boards: BenchmarkBoard[]; missingSweBench: boolean }> {
  try {
    return { boards: [...await readSweBench(), terminalBench], missingSweBench: false };
  } catch {
    return { boards: [terminalBench], missingSweBench: true };
  }
}
