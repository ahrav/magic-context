#!/usr/bin/env python3
"""Validate and summarize retained synapse_perf pilot records."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "pilot" / "raw"


def read_record(path: Path) -> tuple[dict | None, int, int]:
    summary = None
    logical = 0
    attempts = 0
    if not path.read_text().strip():
        return None, logical, attempts
    for line in path.read_text().splitlines():
        record = json.loads(line)
        kind = record.get("kind")
        if kind == "synapse_perf_summary":
            summary = record
        elif kind == "synapse_perf_logical":
            logical += 1
        elif kind == "synapse_perf_attempt":
            attempts += 1
    return summary, logical, attempts


def main() -> None:
    rows = []
    invalid = []
    for path in sorted(RAW.glob("*.ndjson")):
        summary, logical_rows, attempt_rows = read_record(path)
        stderr_path = path.with_suffix(".stderr")
        stderr = stderr_path.read_text().strip() if stderr_path.exists() else ""
        if summary is None:
            invalid.append({"file": str(path.relative_to(ROOT)), "reason": stderr or "missing summary"})
            continue
        ledger = summary["ledger"]
        raw_counts_match = logical_rows == ledger["offered"] and attempt_rows == ledger["attempts"]
        admissible = (
            ledger["valid"]
            and raw_counts_match
            and not summary["fatal_errors"]
            and summary["missed_slots"] == 0
            and summary["censored_per_mille"] <= 10.0
        )
        row = {
            "file": str(path.relative_to(ROOT)),
            "variant": summary["variant"],
            "arm": summary["arm"],
            "load": summary["load"],
            "engine_delay_ms": summary["engine_delay_ms"],
            "max_waiting_queries": summary["max_waiting_queries"],
            "ledger_valid": ledger["valid"],
            "raw_counts_match": raw_counts_match,
            "admissible": admissible,
            "completed": ledger["completed"],
            "offered": ledger["offered"],
            "timed_out": ledger["timed_out"],
            "amplification": ledger["amplification"],
            "logical_p95_ns": (summary.get("logical_latency") or {}).get("p95_ns"),
            "permit_wait_p95_ns": (summary.get("permit_wait") or {}).get("p95_ns"),
            "service_time_p50_ns": (summary.get("service_time") or {}).get("p50_ns"),
            "service_time_cv": summary.get("service_time_cv"),
            "censored_per_mille": summary["censored_per_mille"],
            "missed_slots": summary["missed_slots"],
            "stderr": stderr,
        }
        rows.append(row)
        if not admissible:
            invalid.append({"file": row["file"], "reason": stderr or "harness admissibility gate failed"})

    analysis = ROOT / "analysis"
    analysis.mkdir(exist_ok=True)
    (analysis / "pilot-summary.json").write_text(json.dumps(rows, indent=2) + "\n")
    validation = {
        "files_with_summary": len(rows),
        "admissible": sum(row["admissible"] for row in rows),
        "invalid": len(invalid),
        "all_logical_ledgers_valid": all(row["ledger_valid"] for row in rows),
        "all_raw_counts_match": all(row["raw_counts_match"] for row in rows),
        "invalid_records": invalid,
    }
    (analysis / "validation.json").write_text(json.dumps(validation, indent=2) + "\n")

    invalid_dir = ROOT / "invalid"
    invalid_dir.mkdir(exist_ok=True)
    for item in invalid:
        source = ROOT / item["file"]
        if source.exists():
            shutil.copy2(source, invalid_dir / source.name)
        stderr = source.with_suffix(".stderr")
        if stderr.exists():
            shutil.copy2(stderr, invalid_dir / stderr.name)

    hashes = []
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            hashes.append(f"{digest}  {path.relative_to(ROOT)}")
    (ROOT / "SHA256SUMS").write_text("\n".join(hashes) + "\n")


if __name__ == "__main__":
    main()
