"""Build language aggregates from the CHAIN agentic conversation release (CC BY 4.0).

Download agentic_conversations.jsonl from https://zenodo.org/records/24104601.
Run python3 apps/web/lib/public-trends-data/update-chain.py /path/to/agentic_conversations.jsonl.
"""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re


EXPECTED_RECORDS = 14_900
EXPECTED_MD5 = "0ccbbb8c182357a3683dd75952f3e971"
UNSPECIFIED_MODELS = {"auto", "automatic", "copilot/auto", "default", "unknown"}
MIN_PROMPTS = 30
MIN_REPLIES = 30
MIN_SESSIONS = 5
FENCES = re.compile(r"^[ \t]*(`{3,}|~{3,}).*?(?:^[ \t]*\1[ \t]*$|\Z)", re.M | re.S)
QUOTES_AND_INLINE_CODE = re.compile(r"^[ \t]*>.*$|`[^`\n]*`", re.M)
SWEARING = re.compile(r"\b(?:asshole|bullshit|damn|fuck(?:ed|er|ing|s)?|shit(?:ty)?)\b", re.I)
APOLOGY = re.compile(
    r"(?:^|[.!?]\s+|\n)\s*(?:[-*]\s+)?(?:"
    r"(?:i(?:['’]m| am)\s+)?(?:(?:so|truly|really|very)\s+)?sorry"
    r"|i\s+(?:(?:do|sincerely|deeply)\s+)?apologi[sz]e"
    r"|(?:my|our)\s+(?:sincere\s+)?apologies)\b",
    re.I,
)


def visible_prose(text):
    return QUOTES_AND_INLINE_CODE.sub(" ", FENCES.sub(" ", text)).strip()


def make_row():
    return {
        "sessions": 0, "prompts": 0, "replies": 0, "visibleOutputTokens": 0,
        "promptsWithSwearing": 0, "repliesWithApology": 0,
    }


def get_models(exchange):
    return {
        label.strip() for turn in exchange
        if isinstance(label := turn.get("model"), str)
        and 0 < len(label.strip()) <= 100
    }


def session_totals(turns):
    prompts = {}
    exchanges = defaultdict(list)
    for turn in turns:
        if turn.get("sidechain"):
            continue
        if turn["role"] == "user":
            prompts[turn["message_index"]] = turn["text"]
        elif turn["role"] in {"assistant", "agent"}:
            exchanges[turn.get("after_user_message")].append(turn)

    totals = defaultdict(make_row)
    for index, text in prompts.items():
        prompt = visible_prose(text)
        if not prompt:
            continue
        exchange = exchanges[index]
        models = get_models(exchange)
        if len(models) != 1:
            continue
        model = models.pop()
        if model.lower() in UNSPECIFIED_MODELS:
            continue
        replies = [
            (prose, reply["n_tokens"]) for reply in exchange
            if reply["role"] == "assistant" and (prose := visible_prose(reply["text"]))
        ]
        if not replies:
            continue
        row = totals[model]
        row["sessions"] = 1
        row["prompts"] += 1
        row["promptsWithSwearing"] += bool(SWEARING.search(prompt))
        row["replies"] += len(replies)
        for reply, tokens in replies:
            row["visibleOutputTokens"] += tokens
            row["repliesWithApology"] += bool(APOLOGY.search(reply))
    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("conversations", type=Path)
    args = parser.parse_args()
    totals = defaultdict(make_row)
    digest = hashlib.md5(usedforsecurity=False)
    records = 0
    with args.conversations.open("rb") as conversations:
        for records, raw in enumerate(conversations, start=1):
            digest.update(raw)
            entry = json.loads(raw)
            for model, counts in session_totals(entry["turns"]).items():
                row = totals[(entry["provider"], model)]
                for key, count in counts.items():
                    row[key] += count

    if records != EXPECTED_RECORDS or digest.hexdigest() != EXPECTED_MD5:
        parser.error("The file checksum or record count differs from the published release.")
    models = [
        {"cohort": cohort, "model": model, **row}
        for (cohort, model), row in totals.items()
        if row["sessions"] >= MIN_SESSIONS and row["prompts"] >= MIN_PROMPTS and row["replies"] >= MIN_REPLIES
    ]
    models.sort(key=lambda row: (-row["prompts"], row["model"], row["cohort"]))
    data = {
        "minimum": {"sessions": MIN_SESSIONS, "prompts": MIN_PROMPTS, "replies": MIN_REPLIES},
        "models": models,
    }
    Path(__file__).with_name("chain-2026-11.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
