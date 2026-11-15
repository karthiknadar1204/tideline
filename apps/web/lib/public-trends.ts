import { unstable_cache } from "next/cache";

export const benchmarkSource = "https://www.swebench.com/";
const leaderboardFeed = "https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json";
const maxFeedBytes = 8 * 1024 * 1024;

type BenchmarkRun = { name: string; model: string; agent: string; date: string; resolved: number; cost: number | null };
export type BenchmarkBoard = { name: string; runs: BenchmarkRun[] };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function benchmarkRun(value: unknown): BenchmarkRun[] {
  if (!object(value) || typeof value.name !== "string" || typeof value.date !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/u.test(value.date) || !Number.isFinite(Date.parse(value.date)) ||
      typeof value.resolved !== "number" || value.resolved < 0 || value.resolved > 100) return [];
  return [{
    name: value.name,
    date: value.date,
    resolved: value.resolved,
    cost: typeof value.instance_cost === "number" && Number.isFinite(value.instance_cost) && value.instance_cost >= 0 ? value.instance_cost : null,
    model: typeof value.model_display === "string" ? value.model_display : "",
    agent: typeof value.agent === "string" ? value.agent : "",
  }];
}

export const readBenchmarkBoards = unstable_cache(async (): Promise<BenchmarkBoard[]> => {
  const response = await fetch(leaderboardFeed, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxFeedBytes) throw new Error("Benchmark feed unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxFeedBytes) throw new Error("Benchmark feed exceeded its size limit");
      json += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const payload: unknown = JSON.parse(json + decoder.decode());
  if (!object(payload) || !Array.isArray(payload.leaderboards)) throw new Error("Unexpected benchmark feed");
  const boards = payload.leaderboards.slice(0, 20).flatMap((board: unknown) => {
    if (!object(board) || typeof board.name !== "string" || !Array.isArray(board.results)) return [];
    const runs = board.results.slice(0, 2_000).flatMap(benchmarkRun);
    return runs.length ? [{ name: board.name, runs }] : [];
  });
  if (!boards.length) throw new Error("Benchmark feed has no recognized results");
  return boards;
}, ["public-swe-bench-v1"], { revalidate: 3600 });
