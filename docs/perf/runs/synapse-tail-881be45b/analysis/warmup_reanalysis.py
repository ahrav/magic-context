#!/usr/bin/env python3
"""Recompute retained 881be45b outcomes with the frozen 10% warmup rule.

The script reads retained raw evidence, never recollects a cell, and preserves
existing validity decisions. It excludes logical requests that start during
the first tenth of each one-second hold and retains only their linked attempts
for attempt-derived outcomes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
ANALYSIS = ROOT / "analysis"
PHASES = ("aa", "treatment")
HOLD_NS = 1_000_000_000
WARMUP_NS = HOLD_NS // 10
RETAINED_SECONDS = (HOLD_NS - WARMUP_NS) / 1_000_000_000
PERCENTILES = (50, 90, 95, 99)


def rank(samples: Iterable[int], percentile: int) -> int | None:
    ordered = sorted(samples)
    return ordered[max(math.ceil(len(ordered) * percentile / 100) - 1, 0)] if ordered else None


def distribution(samples: Iterable[int], suffix: str = "") -> dict[str, int | None]:
    ordered = sorted(samples)
    result: dict[str, int | None] = {"count": len(ordered)}
    for percentile in PERCENTILES:
        result[f"p{percentile}{suffix}"] = rank(ordered, percentile)
    result[f"max{suffix}"] = ordered[-1] if ordered else None
    return result


def argv_value(argv: list[str], flag: str, default: int = 0) -> int:
    try:
        return int(argv[argv.index(flag) + 1])
    except ValueError:
        return default
    except IndexError as error:
        raise RuntimeError(f"missing value for {flag}") from error


def read_raw(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    logical: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    summary: dict[str, Any] | None = None
    with path.open() as source:
        for line in source:
            row = json.loads(line)
            if row["kind"] == "synapse_perf_logical":
                logical.append(row["record"])
            elif row["kind"] == "synapse_perf_attempt":
                attempts.append(row["record"])
            elif row["kind"] == "synapse_perf_summary":
                summary = row
    if summary is None:
        raise RuntimeError(f"missing summary in {path}")
    return logical, attempts, summary


def started(record: dict[str, Any], load: str) -> int:
    field = "scheduled_start_ns" if load == "open" else "actual_first_send_ns"
    value = record.get(field)
    if value is None:
        raise RuntimeError(f"logical {record['logical_id']} has no {field}")
    return int(value)


def logical_latency(record: dict[str, Any], load: str) -> int:
    return int(record["terminal_ns"]) - started(record, load)


def metrics(
    logical: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    *,
    load: str,
    window_seconds: float,
    engine_delay_ms: int,
    transport_floor_ns: int,
) -> dict[str, Any]:
    ids = {int(record["logical_id"]) for record in logical}
    if any(int(record["logical_id"]) not in ids for record in attempts):
        raise RuntimeError("attempt has no retained logical request")
    dispositions = defaultdict(int)
    for record in logical:
        dispositions[record["disposition"]] += 1
    offered = len(logical)
    completed = dispositions["completed"]
    rejected = dispositions["rejected"]
    timed_out = dispositions["timed_out"]
    in_flight = dispositions["in_flight"]
    if offered != completed + rejected + timed_out + in_flight:
        raise RuntimeError("logical count form does not reconcile")
    attempt_dispositions = defaultdict(int)
    for record in attempts:
        attempt_dispositions[record["disposition"]] += 1
    if len(attempts) != sum(attempt_dispositions.values()):
        raise RuntimeError("attempt count form does not reconcile")
    permit_wait = [
        int(record["latency_ns"]) - engine_delay_ms * 1_000_000 - transport_floor_ns
        for record in attempts
        if record["method"] == "query"
    ]
    return {
        "logical_latency": distribution((logical_latency(record, load) for record in logical), "_ns"),
        "amplification": len(attempts) / offered if offered else None,
        "terminal_rejection": {
            "count": rejected,
            "rate_per_second": rejected / window_seconds,
            "probability": rejected / offered if offered else None,
        },
        "timed_out": {
            "count": timed_out,
            "rate_per_second": timed_out / window_seconds,
            "probability": timed_out / offered if offered else None,
        },
        "deadline_success": completed / offered if offered else None,
        "goodput_x_per_second": completed / window_seconds,
        "poll_distribution": distribution((int(record["polls"]) for record in logical)),
        "permit_wait": distribution(permit_wait, "_ns") if permit_wait else None,
        "accounting": {
            "offered": offered,
            "completed": completed,
            "terminal_rejected": rejected,
            "timed_out": timed_out,
            "in_flight": in_flight,
            "attempts": len(attempts),
            "attempt_dispositions": dict(sorted(attempt_dispositions.items())),
        },
    }


def assert_original_matches(derived: dict[str, Any], summary: dict[str, Any]) -> None:
    recorded_latency = summary.get("logical_latency")
    for field in ("count", "p50_ns", "p90_ns", "p95_ns", "p99_ns", "max_ns"):
        if derived["logical_latency"].get(field) != (recorded_latency or {}).get(field):
            raise RuntimeError(f"raw logical outcome differs from recorded {field}")
    if derived["poll_distribution"] != summary.get("poll_distribution"):
        raise RuntimeError("raw poll distribution differs from recorded summary")
    if derived["permit_wait"] != summary.get("permit_wait"):
        raise RuntimeError("raw permit wait differs from recorded summary")
    ledger = summary["ledger"]
    expected_rejected = ledger["offered"] - ledger["completed"] - ledger["timed_out"] - ledger["in_flight"]
    if derived["terminal_rejection"]["count"] != expected_rejected:
        raise RuntimeError("raw terminal rejection differs from recorded summary")
    checks = (
        (derived["amplification"], ledger["amplification"]),
        (derived["deadline_success"], ledger["completed"] / ledger["offered"]),
        (derived["goodput_x_per_second"], ledger["completed"] / summary["seconds"]),
    )
    if any(not math.isclose(left, right, rel_tol=0, abs_tol=1e-12) for left, right in checks):
        raise RuntimeError("raw rate or amplification differs from recorded summary")


def reanalyze(phase: str, validation: dict[str, Any]) -> dict[str, Any]:
    sequence = int(validation["sequence"])
    status_path = ROOT / phase / "raw" / f"{sequence:05d}.status.json"
    status = json.loads(status_path.read_text())
    logical, attempts, summary = read_raw(ROOT / status["stdout"])
    if not logical:
        raise RuntimeError(f"no logical records for {status_path}")
    cell = status["cell"]
    load = cell["load"]
    time_field = "scheduled_start_ns" if load == "open" else "actual_first_send_ns"
    hold_start = min(started(record, load) for record in logical)
    warmup_end = hold_start + WARMUP_NS
    retained = [record for record in logical if started(record, load) >= warmup_end]
    retained_ids = {int(record["logical_id"]) for record in retained}
    retained_attempts = [record for record in attempts if int(record["logical_id"]) in retained_ids]
    engine_delay_ms = argv_value(status["argv"], "--engine-delay-ms")
    transport_floor_ns = argv_value(status["argv"], "--transport-floor-ns")
    original = metrics(
        logical, attempts, load=load, window_seconds=float(summary["seconds"]),
        engine_delay_ms=engine_delay_ms, transport_floor_ns=transport_floor_ns,
    )
    try:
        assert_original_matches(original, summary)
    except RuntimeError as error:
        raise RuntimeError(f"{status['stdout']}: {error}") from error
    after_warmup = metrics(
        retained, retained_attempts, load=load, window_seconds=RETAINED_SECONDS,
        engine_delay_ms=engine_delay_ms, transport_floor_ns=transport_floor_ns,
    )
    return {
        "phase": phase,
        "sequence": sequence,
        "external_label": status.get("external_label"),
        "cell": cell,
        "source": status["stdout"],
        "warmup": {
            "hold_duration_ns": HOLD_NS,
            "discard_duration_ns": WARMUP_NS,
            "time_field": time_field,
            "hold_start_ns": hold_start,
            "warmup_end_ns": warmup_end,
            "discarded_logical_requests": len(logical) - len(retained),
            "retained_logical_requests": len(retained),
            "analysis_window_seconds": RETAINED_SECONDS,
        },
        "original": original,
        "after_warmup": after_warmup,
    }


def outcome_values(outcomes: dict[str, Any]) -> dict[str, float | int]:
    result: dict[str, float | int] = {}
    for field in ("p50", "p90", "p95", "p99", "max"):
        value = outcomes["logical_latency"].get(f"{field}_ns")
        if value is not None:
            result[f"logical_{field}_ns"] = value
    for field in ("amplification", "deadline_success", "goodput_x_per_second"):
        if outcomes[field] is not None:
            result[field] = outcomes[field]
    for field in ("terminal_rejection", "timed_out"):
        result[f"{field}_rate_per_second"] = outcomes[field]["rate_per_second"]
    for field in ("p50", "p90", "p95", "p99", "max"):
        value = outcomes["poll_distribution"].get(field)
        if value is not None:
            result[f"poll_{field}"] = value
    if outcomes["permit_wait"]:
        for field in ("p50", "p90", "p95", "p99", "max"):
            value = outcomes["permit_wait"].get(f"{field}_ns")
            if value is not None:
                result[f"permit_wait_{field}_ns"] = value
    return result


def locate(cell: dict[str, Any]) -> dict[str, Any]:
    factors = cell["cell"]
    return {
        "phase": cell["phase"], "sequence": cell["sequence"], "block": factors["block"],
        "variant": factors["variant"], "k": factors["k"], "arm": factors["arm"],
        "shape": factors.get("shape"), "load": factors["load"], "level": factors["level"],
        "delay_ms": factors["delay_ms"],
    }


def relative(old: float | int, new: float | int) -> float | None:
    if old == 0:
        return 0.0 if new == 0 else None
    return abs(new - old) / abs(old)


def reduce_shifts(records: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for outcome in sorted({record["outcome"] for record in records}):
        values = [record for record in records if record["outcome"] == outcome]
        comparable = [record for record in values if record["relative_shift"] is not None]
        maximum = max(comparable, key=lambda record: record["relative_shift"]) if comparable else None
        result[outcome] = {
            "max_relative_shift": maximum["relative_shift"] if maximum else None,
            "original": maximum["original"] if maximum else None,
            "after_warmup": maximum["after_warmup"] if maximum else None,
            "at": maximum["cell"] if maximum else None,
            "zero_to_nonzero_cells": [record["cell"] for record in values if record["zero_to_nonzero"]],
        }
    return result


def maximum_shifts(cells: list[dict[str, Any]]) -> dict[str, Any]:
    by_phase_arm: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    by_arm: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for cell in cells:
        old = outcome_values(cell["original"])
        new = outcome_values(cell["after_warmup"])
        for outcome, value in old.items():
            if outcome not in new:
                continue
            record = {
                "outcome": outcome, "original": value, "after_warmup": new[outcome],
                "relative_shift": relative(value, new[outcome]),
                "zero_to_nonzero": value == 0 and new[outcome] != 0,
                "cell": locate(cell),
            }
            by_phase_arm[(cell["phase"], cell["cell"]["arm"])].append(record)
            by_arm[cell["cell"]["arm"]].append(record)
    by_phase: dict[str, Any] = {}
    for (phase, arm), records in by_phase_arm.items():
        by_phase.setdefault(phase, {})[arm] = reduce_shifts(records)
    return {
        "all_valid_cells": {arm: reduce_shifts(records) for arm, records in sorted(by_arm.items())},
        "by_phase": by_phase,
    }


def matches(cell: dict[str, Any], **required: Any) -> bool:
    return all(cell["cell"].get(key) == value for key, value in required.items())


def value(cell: dict[str, Any], source: str, path: tuple[str, ...]) -> float | int | None:
    result: Any = cell[source]
    for key in path:
        result = result[key]
    return result


def mean(cells: list[dict[str, Any]], source: str, path: tuple[str, ...]) -> float | None:
    values = [value(cell, source, path) for cell in cells]
    values = [float(item) for item in values if item is not None]
    return sum(values) / len(values) if values else None


def contrast(
    reference: list[dict[str, Any]], candidate: list[dict[str, Any]], path: tuple[str, ...], scale: float = 1.0
) -> dict[str, Any]:
    result: dict[str, Any] = {"blocks_reference": len(reference), "blocks_candidate": len(candidate)}
    for source in ("original", "after_warmup"):
        ref = mean(reference, source, path)
        cand = mean(candidate, source, path)
        result[source] = {
            "reference": ref / scale if ref is not None else None,
            "candidate": cand / scale if cand is not None else None,
            "candidate_over_reference": cand / ref if ref not in (None, 0) and cand is not None else None,
            "candidate_minus_reference": (cand - ref) / scale if ref is not None and cand is not None else None,
        }
    return result


def query_input(cells: list[dict[str, Any]], delay_ms: int, level: int) -> dict[str, Any]:
    common = {"arm": "query", "load": "open", "level": level, "delay_ms": delay_ms}
    hygiene = [cell for cell in cells if matches(cell, variant="hygiene-only", k=0, **common)]
    candidates = {
        "a_k1": [cell for cell in cells if matches(cell, variant="a", k=1, **common)],
        "a_k2": [cell for cell in cells if matches(cell, variant="a", k=2, **common)],
        "a_plus_c_k1": [cell for cell in cells if matches(cell, variant="a+c", k=1, **common)],
    }
    return {
        "cell": common,
        "candidates": {
            name: {
                "logical_p95_ms": contrast(hygiene, group, ("logical_latency", "p95_ns"), 1e6),
                "amplification": contrast(hygiene, group, ("amplification",)),
                "terminal_rejection_probability": contrast(hygiene, group, ("terminal_rejection", "probability")),
                "permit_wait_p95_ms": mean(group, "original", ("permit_wait", "p95_ns")) / 1e6
                if mean(group, "original", ("permit_wait", "p95_ns")) is not None else None,
                "permit_wait_p95_ms_after_warmup": mean(group, "after_warmup", ("permit_wait", "p95_ns")) / 1e6
                if mean(group, "after_warmup", ("permit_wait", "p95_ns")) is not None else None,
            }
            for name, group in candidates.items()
        },
    }


def batch_inputs(cells: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for shape in ("1x16", "4x16-paged", "1x64"):
        common = {"arm": "batch", "shape": shape, "load": "closed", "level": 1, "delay_ms": 5}
        hygiene = [cell for cell in cells if matches(cell, variant="hygiene-only", k=0, **common)]
        result.append({
            "cell": common,
            "c": {
                "logical_p95_ms": contrast(hygiene, [cell for cell in cells if matches(cell, variant="c", k=0, **common)], ("logical_latency", "p95_ns"), 1e6),
                "amplification": contrast(hygiene, [cell for cell in cells if matches(cell, variant="c", k=0, **common)], ("amplification",)),
                "poll_p95": contrast(hygiene, [cell for cell in cells if matches(cell, variant="c", k=0, **common)], ("poll_distribution", "p95")),
            },
            "a_plus_c_k1": {
                "logical_p95_ms": contrast(hygiene, [cell for cell in cells if matches(cell, variant="a+c", k=1, **common)], ("logical_latency", "p95_ns"), 1e6),
                "amplification": contrast(hygiene, [cell for cell in cells if matches(cell, variant="a+c", k=1, **common)], ("amplification",)),
                "poll_p95": contrast(hygiene, [cell for cell in cells if matches(cell, variant="a+c", k=1, **common)], ("poll_distribution", "p95")),
            },
        })
    return result


def aa_inputs(cells: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[tuple[Any, ...], dict[str, dict[str, Any]]] = defaultdict(dict)
    for cell in cells:
        if cell["phase"] != "aa":
            continue
        factors = cell["cell"]
        key = tuple(factors.get(name) for name in ("block", "arm", "shape", "load", "level", "delay_ms"))
        groups[key][cell["external_label"]] = cell
    paths = {
        "logical_p95_ns": ("logical_latency", "p95_ns"),
        "goodput_x_per_second": ("goodput_x_per_second",),
        "deadline_success": ("deadline_success",),
        "amplification": ("amplification",),
        "terminal_rejection_rate_per_second": ("terminal_rejection", "rate_per_second"),
    }
    ratios = {name: {"original": [], "after_warmup": []} for name in paths}
    p95_within_ten = {"original": 0, "after_warmup": 0}
    paired = 0
    for labels in groups.values():
        if set(labels) != {"hygiene-aa-left", "hygiene-aa-right"}:
            continue
        paired += 1
        for name, path in paths.items():
            for source in ("original", "after_warmup"):
                left = value(labels["hygiene-aa-left"], source, path)
                right = value(labels["hygiene-aa-right"], source, path)
                if left is not None and right not in (None, 0):
                    ratio = float(left) / float(right)
                    ratios[name][source].append(ratio)
                    if name == "logical_p95_ns" and 0.9 <= ratio <= 1.1:
                        p95_within_ten[source] += 1
    return {
        "paired_valid_cells": paired,
        "ratio_left_over_right": {
            name: {
                source: {"count": len(values), "min": min(values) if values else None,
                         "max": max(values) if values else None,
                         "median": statistics.median(values) if values else None}
                for source, values in sources.items()
            }
            for name, sources in ratios.items()
        },
        "logical_p95_pairs_within_10_percent": p95_within_ten,
    }


def selection_comparison(headlines: dict[str, Any]) -> dict[str, Any]:
    query_ok = []
    zero_ok = []
    for name in ("query_5ms_1x", "query_25ms_1x"):
        candidate = headlines[name]["candidates"]["a_k1"]
        p95 = candidate["logical_p95_ms"]
        blocking = candidate["terminal_rejection_probability"]
        query_ok.append(p95["original"]["candidate"] < p95["original"]["reference"] and p95["after_warmup"]["candidate"] < p95["after_warmup"]["reference"])
        zero_ok.append(blocking["original"]["candidate"] == 0 and blocking["after_warmup"]["candidate"] == 0)
    batch_ok = []
    for entry in headlines["batch_closed_1_5ms"]:
        p95 = entry["c"]["logical_p95_ms"]
        batch_ok.append(p95["original"]["candidate"] < p95["original"]["reference"] and p95["after_warmup"]["candidate"] < p95["after_warmup"]["reference"])
    aa = headlines["aa_stability"]["ratio_left_over_right"]["logical_p95_ns"]
    preserved = all(query_ok + batch_ok + zero_ok)
    return {
        "materiality_definition": "The frozen contract provides no numerical materiality threshold. Material means a documented selection input changes: contrast direction, candidate zero terminal blocking, selected-K feasibility, or the A/A stability conclusion.",
        "query_p95_direction_preserved": all(query_ok),
        "batch_p95_direction_preserved": all(batch_ok),
        "candidate_terminal_blocking_zeros_preserved": all(zero_ok),
        "aa_p95_median_original": aa["original"]["median"],
        "aa_p95_median_after_warmup": aa["after_warmup"]["median"],
        "any_selection_input_changed_direction": not all(query_ok + batch_ok),
        "any_selection_input_materially_changed": not preserved,
        "verdict": "selection unchanged" if preserved else "selection changed",
    }


def write_checksums() -> None:
    entries = []
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            entries.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(ROOT)}")
    (ROOT / "SHA256SUMS").write_text("\n".join(entries) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--update-checksums", action="store_true")
    args = parser.parse_args()
    cells = []
    for phase in PHASES:
        validation = json.loads((ANALYSIS / f"{phase}-validation.json").read_text())
        cells.extend(reanalyze(phase, row) for row in validation["rows"] if row["valid"])
    treatment = [cell for cell in cells if cell["phase"] == "treatment"]
    headlines = {
        "query_5ms_1x": query_input(treatment, 5, 198),
        "query_25ms_1x": query_input(treatment, 25, 40),
        "batch_closed_1_5ms": batch_inputs(treatment),
        "aa_stability": aa_inputs(cells),
    }
    result = {
        "schema": "synapse-tail-881be45b-warmup-reanalysis-v1",
        "method": {
            "contract": "docs/perf/synapse-tail-contract.md warm-state section",
            "hold_duration_ns": HOLD_NS,
            "discard_duration_ns": WARMUP_NS,
            "open_loop_time_field": "scheduled_start_ns",
            "closed_loop_time_field": "actual_first_send_ns",
            "retained_window_seconds": RETAINED_SECONDS,
            "raw_evidence_modified": False,
        },
        "valid_cells": {phase: sum(cell["phase"] == phase for cell in cells) for phase in PHASES},
        "cells": cells,
        "max_relative_shift_per_outcome_per_arm": maximum_shifts(cells),
        "headline_selection_inputs": headlines,
        "selection_comparison": selection_comparison(headlines),
    }
    output = ANALYSIS / "warmup_reanalysis.json"
    output.write_text(json.dumps(result, indent=2) + "\n")
    if args.update_checksums:
        write_checksums()
    print(output)
    print(f"valid cells: aa={result['valid_cells']['aa']}, treatment={result['valid_cells']['treatment']}")


if __name__ == "__main__":
    main()
