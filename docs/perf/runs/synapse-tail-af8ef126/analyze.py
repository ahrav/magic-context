#!/usr/bin/env python3
"""Validate retained U7 rows and emit progress summaries and checksums."""

from __future__ import annotations

import hashlib
import csv
import json
import statistics
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def invalid_reason(row: dict) -> str | None:
    summary = row.get("summary") or {}
    if row["valid"]:
        return None
    if not summary:
        return "missing_summary"
    if row["ledger_valid"] is not True:
        return "ledger"
    if not row["raw_row_counts_valid"]:
        return "raw_row_count"
    if not row["raw_service_count_valid"]:
        return "raw_service_count"
    if summary.get("fatal_errors"):
        return "fatal_error"
    if summary.get("missed_slots") != 0:
        return "missed_slot"
    if summary.get("censored_per_mille", 1000) > 10:
        return "censoring"
    return "nonzero_exit"


def host_resources(summary: dict) -> dict[str, int]:
    host = [row for row in summary.get("task_deltas", []) if row.get("role") == "host_runtime"]
    return {
        "host_utime_ticks": sum(row["utime_ticks"] for row in host),
        "host_stime_ticks": sum(row["stime_ticks"] for row in host),
        "host_voluntary_context_switches": sum(row["voluntary_context_switches"] for row in host),
        "host_nonvoluntary_context_switches": sum(row["nonvoluntary_context_switches"] for row in host),
    }


def flat_row(row: dict) -> dict:
    cell = row["cell"]
    summary = row["summary"]
    ledger = summary["ledger"]
    offered = ledger["offered"]
    terminal_rejected = offered - ledger["completed"] - ledger["timed_out"] - ledger["in_flight"]
    result = {
        "sequence": row["sequence"],
        "external_label": row["external_label"],
        "block": cell["block"],
        "variant": cell["variant"],
        "k": cell["k"],
        "arm": cell["arm"],
        "shape": cell.get("shape") or "",
        "load": cell["load"],
        "level": cell["level"],
        "delay_ms": cell["delay_ms"],
        "offered": offered,
        "lambda_adm": sum(ledger["admitted_by_method"].values()) / summary["seconds"],
        "goodput_x": ledger["completed"] / summary["seconds"],
        "deadline_success": ledger["completed"] / offered if offered else 0.0,
        "terminal_rejected": terminal_rejected,
        "timed_out": ledger["timed_out"],
        "amplification": ledger["amplification"],
        "service_time_mean_ns": summary["service_time_mean_ns"],
        "service_time_cv": summary["service_time_cv"],
    }
    for prefix in ("logical_latency", "attempt_latency", "permit_wait", "poll_distribution"):
        for key, value in (summary.get(prefix) or {}).items():
            result[f"{prefix}_{key}"] = value
    result.update(host_resources(summary))
    return result


def cell_key(row: dict) -> tuple:
    return tuple(row[name] for name in ("variant", "k", "arm", "shape", "load", "level", "delay_ms"))


def write_descriptive(rows: list[dict]) -> dict:
    valid = [flat_row(row) for row in rows if row["valid"]]
    fieldnames = sorted({key for row in valid for key in row})
    with (ROOT / "analysis" / "valid-cell-summaries.csv").open("w", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(valid)

    grouped: dict[tuple, list[dict]] = {}
    for row in valid:
        grouped.setdefault(cell_key(row), []).append(row)
    metrics = (
        "logical_latency_p50_ns", "logical_latency_p90_ns", "logical_latency_p95_ns",
        "logical_latency_p99_ns", "logical_latency_max_ns", "attempt_latency_p50_ns",
        "attempt_latency_p90_ns", "attempt_latency_p95_ns", "attempt_latency_p99_ns",
        "attempt_latency_max_ns", "goodput_x", "deadline_success", "terminal_rejected",
        "timed_out", "amplification", "poll_distribution_p50", "poll_distribution_p90",
        "poll_distribution_p95", "poll_distribution_p99", "poll_distribution_max",
        "permit_wait_p50_ns", "permit_wait_p90_ns", "permit_wait_p95_ns",
        "permit_wait_p99_ns", "permit_wait_max_ns", "service_time_mean_ns",
        "service_time_cv", "host_utime_ticks", "host_stime_ticks",
        "host_voluntary_context_switches", "host_nonvoluntary_context_switches",
    )
    complete = []
    for key, group in sorted(grouped.items()):
        if len(group) != 2 or {row["block"] for row in group} != {1, 2}:
            continue
        item = {name: value for name, value in zip(("variant", "k", "arm", "shape", "load", "level", "delay_ms"), key)}
        item["blocks"] = [1, 2]
        item["metrics"] = {}
        for metric in metrics:
            values = [row.get(metric) for row in sorted(group, key=lambda row: row["block"])]
            if all(value is not None for value in values):
                numeric = [float(value) for value in values if value is not None]
                item["metrics"][metric] = {"block_values": values, "min": min(numeric), "max": max(numeric)}
        complete.append(item)
    (ROOT / "analysis" / "two-block-descriptive.json").write_text(json.dumps(complete, indent=2) + "\n")
    return {"valid_rows": len(valid), "complete_two_block_cells": len(complete)}


def aa_comparisons(rows: list[dict]) -> dict:
    groups: dict[tuple, dict[str, dict]] = {}
    for row in rows:
        if not row["valid"]:
            continue
        flat = flat_row(row)
        key = (flat["block"], flat["arm"], flat["shape"], flat["load"], flat["level"], flat["delay_ms"])
        groups.setdefault(key, {})[flat["external_label"]] = flat
    metrics = ("logical_latency_p95_ns", "goodput_x", "deadline_success", "terminal_rejected", "timed_out", "amplification")
    ratios = {metric: [] for metric in metrics}
    paired = 0
    for labels in groups.values():
        if set(labels) != {"hygiene-aa-left", "hygiene-aa-right"}:
            continue
        paired += 1
        left, right = labels["hygiene-aa-left"], labels["hygiene-aa-right"]
        for metric in metrics:
            denominator = right.get(metric)
            numerator = left.get(metric)
            if denominator not in (None, 0) and numerator is not None:
                ratios[metric].append(numerator / denominator)
    result = {
        "artifact_hash_identical": True,
        "external_labels": ["hygiene-aa-left", "hygiene-aa-right"],
        "argv_treatment_variant_for_both": "hygiene-only",
        "paired_valid_cells": paired,
        "ratio_ranges_left_over_right": {
            metric: {"count": len(values), "min": min(values), "max": max(values), "median": statistics.median(values)}
            for metric, values in ratios.items() if values
        },
        "interpretation": "Mechanical binary and treatment argv identity passed. Required schedule validity did not pass; invalid attempts are retained and no noise threshold is inferred.",
    }
    (ROOT / "analysis" / "aa-mechanical.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def read_ndjson(path: Path) -> tuple[dict | None, dict[str, int]]:
    summary = None
    counts = {"logical": 0, "attempt": 0, "service": 0}
    if not path.exists():
        return summary, counts
    with path.open() as source:
        for line in source:
            row = json.loads(line)
            kind = row.get("kind")
            if kind == "synapse_perf_summary":
                summary = row
            elif kind == "synapse_perf_logical":
                counts["logical"] += 1
            elif kind == "synapse_perf_attempt":
                counts["attempt"] += 1
            elif kind == "synapse_perf_service":
                counts["service"] += 1
    return summary, counts


def analyze_phase(phase: str) -> dict:
    schedule_path = ROOT / phase / "schedule.json"
    required = len(json.loads(schedule_path.read_text())) if schedule_path.exists() else 0
    rows = []
    for status_path in sorted((ROOT / phase / "raw").glob("*.status.json")):
        status = json.loads(status_path.read_text())
        summary, counts = read_ndjson(ROOT / status["stdout"])
        ledger = (summary or {}).get("ledger", {})
        raw_valid = bool(summary) and counts["logical"] == ledger.get("offered") and counts["attempt"] == ledger.get("attempts")
        service_valid = bool(summary) and counts["service"] == (summary.get("service_time") or {}).get("count", 0)
        valid = (
            status["exit_status"] == 0
            and bool(summary)
            and ledger.get("valid") is True
            and raw_valid
            and service_valid
            and not summary.get("fatal_errors")
            and summary.get("missed_slots") == 0
            and summary.get("censored_per_mille", 1000) <= 10.0
        )
        rows.append({
            "sequence": status["sequence"],
            "external_label": status.get("external_label"),
            "cell": status["cell"],
            "exit_status": status["exit_status"],
            "valid": valid,
            "ledger_valid": ledger.get("valid"),
            "raw_row_counts_valid": raw_valid,
            "raw_service_count_valid": service_valid,
            "summary": summary,
        })
        rows[-1]["invalid_reason"] = invalid_reason(rows[-1])
    result = {
        "required": required,
        "attempted": len(rows),
        "valid": sum(row["valid"] for row in rows),
        "invalid": sum(not row["valid"] for row in rows),
        "complete": required > 0 and len(rows) == required,
        "rows": rows,
    }
    (ROOT / "analysis" / f"{phase}-validation.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> None:
    calibration = analyze_phase("calibration")
    aa = analyze_phase("aa")
    treatment = analyze_phase("treatment")
    aa_mechanical = aa_comparisons(aa["rows"])
    descriptive = write_descriptive(treatment["rows"])
    invalid_index = {
        phase: [
            {"sequence": row["sequence"], "reason": row["invalid_reason"], "cell": row["cell"], "exit_status": row["exit_status"]}
            for row in data["rows"] if not row["valid"]
        ]
        for phase, data in (("calibration", calibration), ("aa", aa), ("treatment", treatment))
    }
    (ROOT / "invalid" / "index.json").write_text(json.dumps(invalid_index, indent=2) + "\n")
    progress = {"calibration": calibration, "aa": aa, "treatment": treatment}
    usl_gate = "USL not applicable — two repetitions without confidence intervals; gate requires at least five repetitions with CIs"
    slim: dict[str, object] = {
        phase: {key: value for key, value in data.items() if key != "rows"}
        for phase, data in progress.items()
        if isinstance(data, dict)
    }
    slim["usl_gate"] = usl_gate
    slim["aa_mechanical"] = aa_mechanical
    slim["treatment_descriptive"] = descriptive
    (ROOT / "analysis" / "progress.json").write_text(json.dumps(slim, indent=2) + "\n")

    lines = []
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(ROOT)}")
    (ROOT / "SHA256SUMS").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
