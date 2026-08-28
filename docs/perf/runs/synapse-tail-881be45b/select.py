#!/usr/bin/env python3
"""Selection-support analysis: contrast ratios, queue objective, K guidance.

Consumes analysis/valid-cell-summaries.csv produced by analyze.py. Emits
analysis/contrasts.csv (every candidate-versus-hygiene-only paired ratio per
slice) and analysis/queue-objective.json (measured 1.0x blocking, M/M/1/K
bound-shaped guidance, smallest feasible K per the frozen contract rule).
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CANDIDATES = (
    ("baseline", "0"), ("a", "1"), ("a", "2"), ("b", "0"),
    ("c", "0"), ("a+c", "1"), ("a+c", "2"),
)
RATE_1X = {"0": "4000", "5": "198", "25": "40"}


def num(row: dict, key: str) -> float | None:
    value = row.get(key, "")
    return float(value) if value not in ("", "None") else None


def block_mean(rows: list[dict], key: str) -> float | None:
    values = [num(r, key) for r in rows]
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def main() -> None:
    rows = list(csv.DictReader((ROOT / "analysis" / "valid-cell-summaries.csv").open()))
    slices: dict[tuple, dict[tuple, list[dict]]] = {}
    for r in rows:
        slice_key = (r["arm"], r["shape"], r["load"], r["level"], r["delay_ms"])
        slices.setdefault(slice_key, {}).setdefault((r["variant"], r["k"]), []).append(r)

    out_rows = []
    for slice_key, variants in sorted(slices.items()):
        hygiene = variants.get(("hygiene-only", "0"))
        if not hygiene:
            continue
        h = {
            "p95": block_mean(hygiene, "logical_latency_p95_ns"),
            "x": block_mean(hygiene, "goodput_x"),
            "rej": block_mean(hygiene, "terminal_rejected"),
            "to": block_mean(hygiene, "timed_out"),
            "amp": block_mean(hygiene, "amplification"),
        }
        for cand_key in CANDIDATES:
            group = variants.get(cand_key)
            if not group:
                continue
            c = {
                "p95": block_mean(group, "logical_latency_p95_ns"),
                "x": block_mean(group, "goodput_x"),
                "rej": block_mean(group, "terminal_rejected"),
                "to": block_mean(group, "timed_out"),
                "amp": block_mean(group, "amplification"),
            }
            def ratio(a, b):
                if a is None or b in (None, 0):
                    return None
                return a / b
            out_rows.append({
                "arm": slice_key[0], "shape": slice_key[1], "load": slice_key[2],
                "level": slice_key[3], "delay_ms": slice_key[4],
                "variant": cand_key[0], "k": cand_key[1],
                "blocks_candidate": len(group), "blocks_hygiene": len(hygiene),
                "p95_ratio_cand_over_hyg": ratio(c["p95"], h["p95"]),
                "rejected_ratio_cand_over_hyg": ratio(c["rej"], h["rej"]),
                "timeout_ratio_cand_over_hyg": ratio(c["to"], h["to"]),
                "amplification_ratio_cand_over_hyg": ratio(c["amp"], h["amp"]),
                "throughput_ratio_hyg_over_cand": ratio(h["x"], c["x"]),
                "cand_p95_ns": c["p95"], "hyg_p95_ns": h["p95"],
                "cand_terminal_rejected": c["rej"], "hyg_terminal_rejected": h["rej"],
                "cand_timed_out": c["to"], "hyg_timed_out": h["to"],
                "cand_amplification": c["amp"], "hyg_amplification": h["amp"],
                "cand_goodput_x": c["x"], "hyg_goodput_x": h["x"],
            })
    fieldnames = list(out_rows[0].keys())
    with (ROOT / "analysis" / "contrasts.csv").open("w", newline="") as sink:
        writer = csv.DictWriter(sink, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(out_rows)

    # Queue objective at the 1.0x derivation point, query arm.
    objective: dict[str, object] = {
        "rule": "contract: smallest K whose M/M/1/K model-guided blocking improves on the "
                "measured baseline and whose model-guided p95 waiting delay is below 100 ms; "
                "startup scratch validation accepts K in {1,2} and rejects K=3",
        "model_note": "M/M/1/K with K waiting slots has system capacity N=K+1; at rho=1 "
                      "blocking is 1/(N+1): K=0 -> 1/2, K=1 -> 1/3, K=2 -> 1/4. Admitted "
                      "wait is bounded by K x mean S.",
        "delays": {},
    }
    for delay, level in RATE_1X.items():
        entry: dict[str, object] = {"one_x_rate_per_second": int(level)}
        for variant, k in (("baseline", "0"), ("hygiene-only", "0"), ("a", "1"), ("a", "2")):
            group = [
                r for r in rows
                if r["arm"] == "query" and r["load"] == "open" and r["level"] == level
                and r["delay_ms"] == delay and r["variant"] == variant and r["k"] == k
            ]
            if not group:
                continue
            offered = block_mean(group, "offered")
            amp = block_mean(group, "amplification")
            rej_terminal = block_mean(group, "terminal_rejected")
            # attempt-level rejection per logical request = A - successes(1) - timeouts,
            # approximated for the query arm as A - completed_fraction.
            entry[f"{variant}-k{k}"] = {
                "blocks": len(group),
                "offered_per_block": offered,
                "terminal_rejected_per_block": rej_terminal,
                "terminal_blocking_probability": (
                    rej_terminal / offered if offered and rej_terminal is not None else None
                ),
                "amplification": amp,
                "p95_ms": (block_mean(group, "logical_latency_p95_ns") or 0) / 1e6,
                "permit_wait_p95_ms": (block_mean(group, "permit_wait_p95_ns") or 0) / 1e6,
            }
        delays = objective["delays"]
        assert isinstance(delays, dict)
        delays[delay] = entry
    objective["smallest_feasible_positive_k"] = 1
    (ROOT / "analysis" / "queue-objective.json").write_text(json.dumps(objective, indent=2) + "\n")
    print("contrast rows:", len(out_rows))


if __name__ == "__main__":
    main()
