#!/usr/bin/env python3
import hashlib
import json
import os
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
RUN = Path(__file__).resolve().parent / "smoke"
ARTIFACT = ROOT / "target/release/examples/synapse_perf"
EXPECTED = "6ad6d1ad4839f43e59f7574c8c8e00bf336396601e1c464d696ce6aafc0bca9c"
TOPOLOGIES = ("b0", "t1-2", "t2", "t3", "t4-2")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


RUN.mkdir(exist_ok=True)
if sha256(ARTIFACT) != EXPECTED:
    raise SystemExit("artifact SHA-256 drift")

manifest = {
    "schema": "synapse-concurrency-gate1-smoke/v1",
    "created_utc": utc_now(),
    "evidence_scope": "delay-mechanism",
    "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "repository_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()),
    "artifact": str(ARTIFACT.relative_to(ROOT)),
    "artifact_sha256": EXPECTED,
    "driver_sha256": sha256(Path(__file__)),
    "cpu_budget": 4,
    "cpus": [0, 1, 2, 3],
    "cpu_budget_mechanism": "taskset",
    "environment": {
        "hostname": "<redacted:sha256:{}>".format(hashlib.sha256(platform.node().encode()).hexdigest()[:12]),
        "kernel": platform.platform(),
        "machine": platform.machine(),
        "allowed_cpus": sorted(os.sched_getaffinity(0)),
        "ort_test_library": "absent" if not os.environ.get("MC_SYNAPSE_TEST_ORT_LIBRARY") else "set-not-used",
    },
    "runs": [],
}

for topology in TOPOLOGIES:
    command = [
        "taskset", "-c", "0-3", str(ARTIFACT),
        "--variant", "current-plugin",
        "--arm", "mixed",
        "--batch-shape", "1x16",
        "--query-rate", "10",
        "--batch-rate", "10",
        "--ratio", "1:1",
        "--seconds", "1",
        "--engine-delay-ms", "5",
        "--max-waiting-queries", "1",
        "--seed", "839944",
        "--topology", topology,
        "--engine", "delay",
    ]
    stdout = RUN / f"{topology}.ndjson"
    stderr = RUN / f"{topology}.stderr"
    before = Path("/proc/loadavg").read_text().strip()
    started = utc_now()
    with stdout.open("wb") as out, stderr.open("wb") as err:
        result = subprocess.run(command, cwd=ROOT, stdout=out, stderr=err, check=False, timeout=180)
    manifest["runs"].append({
        "topology": topology,
        "command": command,
        "started_utc": started,
        "ended_utc": utc_now(),
        "loadavg_before": before,
        "loadavg_after": Path("/proc/loadavg").read_text().strip(),
        "exit_status": result.returncode,
        "stdout": stdout.name,
        "stderr": stderr.name,
        "stdout_sha256": sha256(stdout),
        "stderr_sha256": sha256(stderr),
    })

(RUN / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
files = sorted(path for path in RUN.iterdir() if path.is_file() and path.name != "SHA256SUMS")
(RUN / "SHA256SUMS").write_text("".join(f"{sha256(path)}  {path.name}\n" for path in files))
raise SystemExit(0 if all(run["exit_status"] == 0 for run in manifest["runs"]) else 1)
