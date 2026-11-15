"""Regenerate the development snapshot from Terminal-Bench 2.1's public leaderboard.

Run python3 apps/web/lib/public-trends-data/update-terminal-bench.py.
Update COMMIT to refresh the snapshot from a newer reviewed commit.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
import math
from pathlib import Path
import re
from urllib.request import urlopen


REPO = "harbor-framework/terminal-bench-2-1"
COMMIT = "12b7565679ce5006230b820666353673a133db93"
SUBMISSIONS = "leaderboard/submissions"
JSON_FILE = re.compile(r"\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,160}\.json")


def read_json(url):
    with urlopen(url, timeout=10) as response:
        payload = response.read(262_145)
    if len(payload) > 262_144:
        raise ValueError(f"File is larger than the snapshot limit: {url}")
    return json.loads(payload)


def measure(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def submission(filename):
    record = read_json(f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/{SUBMISSIONS}/{filename}")
    metadata, metrics = record["metadata"], record["metrics"]
    model = metadata["model_display"]["label"]
    agent = metadata["agent_display"]["label"]
    resolved = measure(metrics["accuracy"])
    if not model or not agent or resolved is None or resolved > 100:
        raise ValueError(f"Invalid result in {filename}")

    trials, cost = measure(metrics.get("n_trials")), measure(metrics.get("total_cost_usd"))
    effort = metadata.get("reasoning_effort") or record.get("source_filter", {}).get("reasoning_effort") or None
    return {
        "id": filename,
        "name": f"{model} · {agent}",
        "model": model,
        "agent": agent,
        "effort": effort,
        "date": date.fromisoformat(metadata["date"]).isoformat(),
        "resolved": resolved,
        "cost": round(cost / trials, 6) if trials and cost is not None else None,
        "duration": measure(metrics.get("avg_trial_duration_sec")) or None,
        "apiCalls": None,
    }


def main():
    index = read_json(f"https://api.github.com/repos/{REPO}/contents/{SUBMISSIONS}?ref={COMMIT}")
    filenames = [file["name"] for file in index if file["type"] == "file" and JSON_FILE.fullmatch(file["name"])]
    if not 1 <= len(filenames) <= 64:
        raise ValueError("Expected at most 64 published submissions.")
    with ThreadPoolExecutor(max_workers=4) as readers:
        runs = list(readers.map(submission, filenames))
    target = Path(__file__).with_name("terminal-bench-2-1.json")
    target.write_text(json.dumps({
        "name": "Terminal-Bench 2.1",
        "source": {"name": "Terminal-Bench 2.1 submissions", "href": f"https://github.com/{REPO}/tree/{COMMIT}/{SUBMISSIONS}"},
        "runs": runs,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
