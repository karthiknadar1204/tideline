"""Regenerate the public aggregates from the pinned TraceLab v0.0.2 DuckDB file.

Download syfi_coding_trace.duckdb from https://github.com/uw-syfi/TraceLab/releases/tag/v0.0.2.
With the DuckDB Python package installed, run:
    python3 apps/web/lib/public-trends-data/update-tracelab.py /path/to/syfi_coding_trace.duckdb
"""

import argparse
import hashlib
import json
from pathlib import Path

import duckdb


EXPECTED_DIGEST = "a7bab286bc640844560850965ccf47975cf66407154132abaab90f27ec9be744"

RUNS = """
WITH session_bounds AS (
  SELECT provider, session_id, min(timestamp) AS first_event, max(timestamp) AS last_event
  FROM rounds JOIN timing_events USING (round_pk)
  WHERE provider IN ('claude', 'codex') AND timestamp IS NOT NULL
  GROUP BY provider, session_id
), session_tools AS (
  SELECT provider, session_id, count(*) AS calls
  FROM rounds JOIN tool_calls USING (round_pk)
  WHERE provider IN ('claude', 'codex')
  GROUP BY provider, session_id
), sessions AS (
  SELECT provider, strftime(first_event, '%Y-%m') AS month,
    CASE WHEN last_event > first_event THEN epoch(last_event - first_event) END AS duration,
    coalesce(calls, 0) AS calls
  FROM session_bounds LEFT JOIN session_tools USING (provider, session_id)
)
SELECT coalesce(provider, 'all') AS cohort, month,
  count(*) AS "sessions", count(duration) AS "timedSessions", sum(calls) AS "toolCalls",
  round(avg(calls), 1) AS "averageCalls",
  CASE WHEN count(*) >= 20 THEN quantile_disc(calls, 0.95) END AS "p95Calls",
  CASE WHEN count(*) >= 100 THEN quantile_disc(calls, 0.99) END AS "p99Calls",
  round(avg(duration), 1) AS "averageSeconds",
  CASE WHEN count(duration) >= 20 THEN round(quantile_cont(duration, 0.95), 1) END AS "p95Seconds",
  CASE WHEN count(duration) >= 100 THEN round(quantile_cont(duration, 0.99), 1) END AS "p99Seconds"
FROM sessions
GROUP BY GROUPING SETS ((provider, month), (month), (provider), ())
ORDER BY month NULLS FIRST, cohort
"""

MODELS = """
WITH outcomes AS (
  SELECT round_pk, count(*) AS calls, count(is_error) AS known, count(*) FILTER (WHERE is_error) AS errors
  FROM tool_calls GROUP BY round_pk
)
SELECT provider AS cohort, model, count(*) AS "modelCalls",
  sum(coalesce(current_user_message_count, 0)) AS "recordedPrompts",
  sum(coalesce(output_tokens, 0)) AS "recordedOutputTokens",
  sum(coalesce(calls, 0)) AS "toolCalls",
  sum(coalesce(known, 0)) AS "knownToolOutcomes",
  sum(coalesce(errors, 0)) AS "toolErrors"
FROM rounds LEFT JOIN outcomes USING (round_pk)
WHERE provider IN ('claude', 'codex') AND model IS NOT NULL
GROUP BY provider, model
ORDER BY "modelCalls" DESC, model, cohort
"""


def records(connection, query):
    results = connection.execute(query)
    columns = [description[0] for description in results.description]
    return [dict(zip(columns, row)) for row in results.fetchall()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    args = parser.parse_args()
    with args.database.open("rb") as database:
        if hashlib.file_digest(database, "sha256").hexdigest() != EXPECTED_DIGEST:
            parser.error("The database checksum differs from the published v0.0.2 release.")

    with duckdb.connect(str(args.database), read_only=True) as connection:
        people, start, end = connection.execute("""
          SELECT count(DISTINCT r."user"), strftime(min(t.timestamp), '%Y-%m-%d'),
            strftime(max(t.timestamp), '%Y-%m-%d')
          FROM rounds r JOIN timing_events t USING (round_pk)
          WHERE r.provider IN ('claude', 'codex')
        """).fetchone()
        data = {
            "sample": {"contributors": people, "from": start, "through": end},
            "runs": records(connection, RUNS),
            "models": records(connection, MODELS),
        }

    target = Path(__file__).with_name("tracelab-v0.0.2.json")
    target.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
