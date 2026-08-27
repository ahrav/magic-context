#!/usr/bin/env python3
"""Run frozen U7 calibration, A/A, and treatment schedules sequentially."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[3]
ARTIFACT = WORKSPACE / "target/release/examples/synapse_perf"
ARTIFACT_SHA256 = "3524f6744a8ddda4afebf876be6b85cd26ed34c15bd758c7280adef82a241ba7"
DELAYS = (0, 5, 25)
CONCURRENCIES = (1, 2, 3, 4, 8, 16)
FACTORS = (0.25, 0.5, 0.75, 1.0, 1.5, 2.0)
ZERO_RATES = (1000, 2000, 3000, 4000, 6000, 8000)
ARMS = (("query", None), ("batch", "1x16"), ("batch", "4x16-paged"), ("batch", "1x64"))
BLOCKS = (1, 2)
AA_LABELS = ("hygiene-aa-left", "hygiene-aa-right")
TREATMENTS = (
    ("baseline", 0),
    ("hygiene-only", 0),
    ("a", 1),
    ("a", 2),
    ("b", 0),
    ("c", 0),
    ("a+c", 1),
    ("a+c", 2),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_summary(path: Path) -> dict:
    summary = None
    with path.open() as source:
        for line in source:
            row = json.loads(line)
            if row.get("kind") == "synapse_perf_summary":
                summary = row
    if summary is None:
        raise RuntimeError(f"missing summary in {path}")
    return summary


def argv_for(cell: dict) -> list[str]:
    argv = [
        str(ARTIFACT),
        "--variant", cell["variant"],
        "--arm", cell["arm"],
        "--seconds", "1",
        "--engine-delay-ms", str(cell["delay_ms"]),
        "--max-waiting-queries", str(cell["k"]),
        "--query-retry-after-ms", "50",
        "--seed", str(cell["seed"]),
    ]
    if cell.get("shape"):
        argv += ["--batch-shape", cell["shape"]]
    if cell["load"] == "closed":
        argv += ["--concurrency", str(cell["level"])]
    else:
        argv += ["--rate", str(cell["level"])]
    return argv


def execute(phase: str, sequence: int, cell: dict) -> dict:
    out_dir = ROOT / phase / "raw"
    stem = f"{sequence:05d}"
    stdout_path = out_dir / f"{stem}.ndjson"
    stderr_path = out_dir / f"{stem}.stderr"
    status_path = out_dir / f"{stem}.status.json"
    if status_path.exists():
        return json.loads(status_path.read_text())

    argv = argv_for(cell)
    started = utc_now()
    monotonic = time.monotonic()
    timed_out = False
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        try:
            result = subprocess.run(
                argv,
                cwd=WORKSPACE,
                stdout=stdout,
                stderr=stderr,
                timeout=180,
                check=False,
                env=os.environ.copy(),
            )
            exit_status = result.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_status = 124
    record = {
        "phase": phase,
        "sequence": sequence,
        "external_label": cell.get("external_label"),
        "cell": cell,
        "argv": argv,
        "cwd": str(WORKSPACE),
        "artifact_sha256": ARTIFACT_SHA256,
        "started_utc": started,
        "ended_utc": utc_now(),
        "duration_seconds": time.monotonic() - monotonic,
        "exit_status": exit_status,
        "timed_out": timed_out,
        "stdout": str(stdout_path.relative_to(ROOT)),
        "stderr": str(stderr_path.relative_to(ROOT)),
    }
    status_path.write_text(json.dumps(record, indent=2) + "\n")
    return record


def calibration() -> dict:
    path = ROOT / "calibration.json"
    if path.exists():
        return json.loads(path.read_text())
    cells = []
    for block in BLOCKS:
        for delay in (5, 25):
            cells.append({
                "variant": "hygiene-only",
                "arm": "query",
                "shape": None,
                "load": "closed",
                "level": 1,
                "delay_ms": delay,
                "k": 0,
                "seed": 1000 + block,
                "block": block,
            })
    (ROOT / "calibration" / "schedule.json").write_text(json.dumps(cells, indent=2) + "\n")
    summaries = {5: [], 25: []}
    attempts = []
    for index, cell in enumerate(cells, 1):
        status = execute("calibration", index, cell)
        attempts.append(status)
        if status["exit_status"] != 0:
            raise RuntimeError(f"calibration attempt {index} failed")
        summary = load_summary(ROOT / status["stdout"])
        summaries[cell["delay_ms"]].append(summary["service_time_mean_ns"])
    result = {
        "completed_utc": utc_now(),
        "derivation": "mean of retained per-block mean S; capacity=1e9/mean_ns; each factor rate=round_half_up(capacity*factor)",
        "attempts": attempts,
        "delays": {},
    }
    for delay, means in summaries.items():
        mean_ns = sum(means) / len(means)
        capacity = 1_000_000_000.0 / mean_ns
        rates = [int(capacity * factor + 0.5) for factor in FACTORS]
        result["delays"][str(delay)] = {
            "block_mean_service_ns": means,
            "calibration_mean_service_ns": mean_ns,
            "capacity_per_second": capacity,
            "factors": list(FACTORS),
            "rates_per_second": rates,
        }
    path.write_text(json.dumps(result, indent=2) + "\n")
    return result


def rates(delay: int, calibration_record: dict) -> tuple[int, ...]:
    if delay == 0:
        return ZERO_RATES
    return tuple(calibration_record["delays"][str(delay)]["rates_per_second"])


def load_cells(calibration_record: dict) -> list[dict]:
    cells = []
    for delay in DELAYS:
        for arm, shape in ARMS:
            for concurrency in CONCURRENCIES:
                cells.append({"arm": arm, "shape": shape, "load": "closed", "level": concurrency, "delay_ms": delay})
            for rate in rates(delay, calibration_record):
                cells.append({"arm": arm, "shape": shape, "load": "open", "level": rate, "delay_ms": delay})
    return cells


def schedule_aa(calibration_record: dict) -> list[dict]:
    schedule = []
    base_cells = load_cells(calibration_record)
    for block in BLOCKS:
        block_cells = []
        for label in AA_LABELS:
            for base in base_cells:
                cell = dict(base)
                cell.update({
                    "variant": "hygiene-only",
                    "k": 0,
                    "seed": 2000 + block,
                    "block": block,
                    "external_label": label,
                })
                block_cells.append(cell)
        random.Random(0xAA000000 + block).shuffle(block_cells)
        schedule.extend(block_cells)
    return schedule


def schedule_treatment(calibration_record: dict) -> list[dict]:
    schedule = []
    base_cells = load_cells(calibration_record)
    for block in BLOCKS:
        block_cells = []
        for variant, k in TREATMENTS:
            for base in base_cells:
                cell = dict(base)
                cell.update({
                    "variant": variant,
                    "k": k,
                    "seed": 3000 + block,
                    "block": block,
                    "external_label": f"{variant}-k{k}",
                })
                block_cells.append(cell)
        random.Random(0x7EAD0000 + block).shuffle(block_cells)
        schedule.extend(block_cells)
    return schedule


def run_schedule(phase: str, schedule: list[dict], max_cells: int | None) -> None:
    schedule_path = ROOT / phase / "schedule.json"
    if not schedule_path.exists():
        schedule_path.write_text(json.dumps(schedule, indent=2) + "\n")
    limit = len(schedule) if max_cells is None else min(len(schedule), max_cells)
    for sequence, cell in enumerate(schedule[:limit], 1):
        execute(phase, sequence, cell)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("calibration", "aa", "treatment", "all"))
    parser.add_argument("--max-cells", type=int)
    args = parser.parse_args()
    if sha256(ARTIFACT) != ARTIFACT_SHA256:
        raise SystemExit("release artifact hash changed")
    calibration_record = calibration()
    if args.phase == "calibration":
        return
    if args.phase in ("aa", "all"):
        run_schedule("aa", schedule_aa(calibration_record), args.max_cells)
    if args.phase in ("treatment", "all"):
        aa_complete = len(list((ROOT / "aa/raw").glob("*.status.json"))) == len(schedule_aa(calibration_record))
        if not aa_complete:
            raise SystemExit("full A/A schedule must complete before treatment")
        run_schedule("treatment", schedule_treatment(calibration_record), args.max_cells)


if __name__ == "__main__":
    main()
