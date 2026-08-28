#!/usr/bin/env python3
"""Plan and execute the frozen Synapse concurrency matrix for one run epoch."""

import argparse
import hashlib
import json
import platform
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

CONTRACT_VERSION = 1
WORKSPACE = Path(__file__).resolve().parents[4]
DEFAULT_BUDGETS = "4,8,16,unrestricted"
DEFAULT_TOPOLOGIES = "b0,t1-2,t1-4,t1-budget,t2,t3,t4-2,t4-4"
GATE_CHOICES = ("pending", "byte-verified", "merged", "out-of-window")


class DriftError(RuntimeError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def fingerprint_values(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "fingerprint" and isinstance(child, str):
                yield child
            yield from fingerprint_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from fingerprint_values(child)


def verify_provenance(provenance):
    checks = [
        ("artifact", provenance["artifact"]["path"], provenance["artifact"]["sha256"]),
        ("bundle manifest", provenance["bundle"]["manifest_path"], provenance["bundle"]["manifest_sha256"]),
        ("model", provenance["bundle"]["model_path"], provenance["bundle"]["model_sha256"]),
        ("ORT", provenance["ort"]["path"], provenance["ort"]["sha256"]),
        ("corpus", provenance["corpus"]["path"], provenance["corpus"]["sha256"]),
    ]
    observed = {}
    for name, raw_path, expected in checks:
        path = Path(raw_path)
        if not path.is_file():
            raise DriftError(f"{name} missing: {path}")
        actual = sha256(path)
        observed[name] = actual
        if actual != expected:
            raise DriftError(f"{name} SHA-256 drift: expected {expected}, got {actual}")
    manifest = json.loads(Path(provenance["bundle"]["manifest_path"]).read_text())
    expected_fingerprint = provenance["bundle"]["fingerprint"]
    if expected_fingerprint not in set(fingerprint_values(manifest)):
        raise DriftError(f"bundle fingerprint drift: {expected_fingerprint} not present in manifest")
    required = ("model", "dims", "max_tokens", "pooling", "quantization", "recommended_batch", "model_file")
    missing = [key for key in required if key not in manifest]
    if missing:
        raise DriftError("bundle manifest missing provenance fields: {}".format(", ".join(missing)))
    if manifest["model_file"].get("sha256") != provenance["bundle"]["model_sha256"]:
        raise DriftError("model SHA-256 disagrees with bundle manifest")
    return observed


def bundle_identity(provenance):
    manifest = json.loads(Path(provenance["bundle"]["manifest_path"]).read_text())
    return {
        "model": manifest["model"],
        "fingerprint": manifest["fingerprint"],
        "dims": manifest["dims"],
        "max_tokens": manifest["max_tokens"],
        "pooling": manifest["pooling"],
        "quantization": manifest["quantization"],
        "recommended_batch": manifest["recommended_batch"],
        "model_sha256": manifest["model_file"]["sha256"],
    }


def provenance_record(provenance):
    return {
        "artifact_sha256": provenance["artifact"]["sha256"],
        "bundle_directory": "<redacted:bundle>",
        "bundle_manifest_sha256": provenance["bundle"]["manifest_sha256"],
        "bundle_identity": bundle_identity(provenance),
        "ort_library": Path(provenance["ort"]["path"]).name,
        "ort_version": provenance["ort"]["version"],
        "ort_sha256": provenance["ort"]["sha256"],
        "corpus": Path(provenance["corpus"]["path"]).name,
        "corpus_sha256": provenance["corpus"]["sha256"],
        "commit": provenance["commit"],
    }


def parse_csv(value):
    result = [item.strip() for item in value.split(",") if item.strip()]
    if not result:
        raise argparse.ArgumentTypeError("list must not be empty")
    return result


def allowed_cpus():
    status = Path("/proc/self/status").read_text()
    value = next(line.split(":", 1)[1].strip() for line in status.splitlines() if line.startswith("Cpus_allowed_list:"))
    cpus = []
    for part in value.split(","):
        if "-" in part:
            start, end = (int(number) for number in part.split("-", 1))
            cpus.extend(range(start, end + 1))
        else:
            cpus.append(int(part))
    return cpus


def cpu_constructs(budgets, include_co_tenancy):
    available = allowed_cpus()
    constructs = []
    for raw in budgets:
        if raw == "unrestricted":
            constructs.append({"id": "unrestricted", "cpu_budget": None, "cpus": available, "co_tenancy": False})
            continue
        budget = int(raw)
        if budget <= 0 or budget > len(available):
            raise ValueError(f"CPU budget {budget} cannot be satisfied by {len(available)} allowed CPUs")
        constructs.append({"id": f"budget-{budget}", "cpu_budget": budget, "cpus": available[:budget], "co_tenancy": False})
        if budget == 4 and include_co_tenancy:
            constructs.append({"id": "budget-4-co-tenancy", "cpu_budget": 4, "cpus": available[:4], "co_tenancy": True})
    return constructs


def resolved_topologies(topologies, budget):
    resolved = []
    for topology in topologies:
        value = f"t1-{budget}" if topology == "t1-budget" else topology
        if value not in resolved:
            resolved.append(value)
    return resolved


def build_schedule(seed, block_count, constructs, topologies):
    groups = []
    letters = []
    for block in range(1, block_count + 1):
        block_groups = []
        rng = random.Random(seed + block)
        template_counts = [0, 0]
        for construct in constructs:
            budget = construct["cpu_budget"] or len(construct["cpus"])
            candidates = resolved_topologies(topologies, budget)
            treatments = [(candidate, "b0", candidate) for candidate in candidates if candidate != "b0"]
            rng.shuffle(treatments)
            for rate_ratio in ("1:1", "4:1"):
                comparisons = [("aa", "b0", "b0")] + treatments
                for comparison, left, right in comparisons:
                    if template_counts[0] == template_counts[1]:
                        template_index = rng.randrange(2)
                    else:
                        template_index = 0 if template_counts[0] < template_counts[1] else 1
                    template_counts[template_index] += 1
                    template = (
                        ("A", "B", "B", "A"),
                        ("B", "A", "A", "B"),
                    )[template_index]
                    group_id = "b{:03d}-{}-{}-{}".format(block, construct["id"], rate_ratio.replace(":", "to"), comparison)
                    labels = []
                    for position, symbol in enumerate(template, 1):
                        topology = left if symbol == "A" else right
                        label = "aa-left" if comparison == "aa" and symbol == "A" else (
                            "aa-right" if comparison == "aa" else topology
                        )
                        labels.append(label)
                        letters.append({
                            "block": block,
                            "group_id": group_id,
                            "position": position,
                            "label": label,
                            "topology": topology,
                            "construct_id": construct["id"],
                            "cpu_budget": construct["cpu_budget"],
                            "cpus": construct["cpus"],
                            "co_tenancy": construct["co_tenancy"],
                            "rate_ratio": rate_ratio,
                            "seed": seed + block,
                        })
                    block_groups.append({
                        "id": group_id,
                        "block": block,
                        "construct_id": construct["id"],
                        "rate_ratio": rate_ratio,
                        "comparison": comparison,
                        "labels": labels,
                    })
        groups.extend(block_groups)
    return {"seed": seed, "contract_version": CONTRACT_VERSION, "abba_groups": groups, "letters": letters}


def command_version(command):
    try:
        return subprocess.run(command, text=True, capture_output=True, check=False, timeout=10).stdout.strip().replace("\n", "; ")
    except (OSError, subprocess.SubprocessError):
        return "unavailable"


def repository_dirty():
    try:
        result = subprocess.run(
            ["git", "-C", str(WORKSPACE), "status", "--porcelain", "--untracked-files=all"],
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
        )
        return bool(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def redacted_environment(run_dir, provenance, wrapper):
    host_hash = hashlib.sha256(platform.node().encode()).hexdigest()[:12]
    lines = [
        f"captured_utc={utc_now()}",
        f"hostname=<redacted:sha256:{host_hash}>",
        "workspace=<redacted:workspace>",
        f"kernel={platform.platform()}",
        f"machine={platform.machine()}",
        "rustc={}".format(command_version(["rustc", "-vV"])),
        "commit={}".format(provenance["commit"]),
        f"repository_dirty={repository_dirty()}",
        "artifact={} sha256={}".format(Path(provenance["artifact"]["path"]).name, provenance["artifact"]["sha256"]),
        "bundle=<redacted:bundle> fingerprint={}".format(provenance["bundle"]["fingerprint"]),
        "ort={} version={} sha256={}".format(Path(provenance["ort"]["path"]).name, provenance["ort"]["version"], provenance["ort"]["sha256"]),
        "corpus={} sha256={}".format(Path(provenance["corpus"]["path"]).name, provenance["corpus"]["sha256"]),
        f"cpu_wrapper={wrapper}",
    ]
    (run_dir / "environment.txt").write_text("\n".join(lines) + "\n")


def select_wrapper(requested):
    if requested != "auto":
        return requested
    if shutil.which("taskset"):
        return "taskset"
    if shutil.which("systemd-run"):
        return "systemd-run"
    raise SystemExit("no CPU budget wrapper found; install taskset or systemd-run")


def wrap_command(argv, letter, wrapper, single_cpu=False):
    cpus = [letter["cpus"][-1]] if single_cpu else letter["cpus"]
    cpu_list = ",".join(str(cpu) for cpu in cpus)
    if letter["cpu_budget"] is None:
        return argv
    if wrapper == "taskset":
        return ["taskset", "-c", cpu_list] + argv
    if wrapper == "systemd-run":
        return ["systemd-run", "--user", "--scope", "-p", f"AllowedCPUs={cpu_list}", "--"] + argv
    if wrapper == "none":
        return argv
    raise ValueError(f"unknown CPU wrapper {wrapper}")


def harness_argv(letter, provenance, engine):
    artifact = provenance["artifact"]["path"]
    query_rate, batch_rate = ((1, 1) if letter["rate_ratio"] == "1:1" else (1, 4))
    argv = [
        artifact,
        "--variant", "current-plugin",
        "--arm", "mixed",
        "--batch-shape", "1x16",
        "--query-rate", str(query_rate),
        "--batch-rate", str(batch_rate),
        "--ratio", letter["rate_ratio"],
        "--seconds", "1",
        "--max-waiting-queries", "1",
        "--seed", str(letter["seed"]),
        "--topology", letter["topology"],
        "--engine", engine,
    ]
    if engine == "real":
        budget = letter["cpu_budget"] or len(letter["cpus"])
        argv.extend([
            "--bundle-dir", provenance["bundle"]["directory"],
            "--ort-library", provenance["ort"]["path"],
            "--ort-sha256", provenance["ort"]["sha256"],
            "--ort-version", provenance["ort"]["version"],
            "--corpus", provenance["corpus"]["path"],
            "--corpus-sha256", provenance["corpus"]["sha256"],
            "--commit", provenance["commit"],
            "--cpu-budget", str(budget),
        ])
    return argv


def gate_states(args):
    return {
        "magic-context-c50.8": args.gate_c50_8,
        "magic-context-chj": args.gate_chj,
        "magic-context-18r": args.gate_18r,
    }


def require_real_gates(gates):
    if gates["magic-context-c50.8"] != "byte-verified":
        raise SystemExit("real-engine collection requires c50.8 byte-verified")
    for name in ("magic-context-chj", "magic-context-18r"):
        if gates[name] not in ("merged", "out-of-window"):
            raise SystemExit(f"real-engine collection requires {name} merged or out-of-window")


def loadavg():
    return Path("/proc/loadavg").read_text().strip()


def update_sums(run_dir):
    raw = run_dir / "raw"
    rows = []
    if raw.exists():
        for path in sorted(path for path in raw.rglob("*") if path.is_file()):
            rows.append(f"{sha256(path)}  {path.relative_to(run_dir)}")
    (run_dir / "SHA256SUMS").write_text("\n".join(rows) + ("\n" if rows else ""))


def update_evidence(run_dir, manifest):
    update_sums(run_dir)
    slots = manifest["slots"]
    write_json(run_dir / "summary.json", {
        "schema": "synapse-concurrency-summary/v1",
        "status": manifest["status"],
        "gate_states": manifest["gate_states"],
        "complete_slots": sum(slot["state"] == "complete" for slot in slots),
        "failed_slots": sum(slot["state"] == "failed" for slot in slots),
        "allocated_slots": sum(slot["state"] == "allocated" for slot in slots),
        "incomplete_blocks": sum(block["status"] == "incomplete" for block in manifest["blocks"]),
        "checksum_manifest": "SHA256SUMS",
    })


def new_manifest(schedule, provenance, gates, constructs, wrapper, engine, idle_gap_seconds):
    return {
        "schema": "synapse-concurrency-run/v1",
        "created_utc": utc_now(),
        "status": "planned",
        "contract_version": CONTRACT_VERSION,
        "seed": schedule["seed"],
        "engine": engine,
        "process_arrangement": "single-process-generator-and-sut",
        "repository_dirty": repository_dirty(),
        "cell_hold_seconds": 1,
        "warmup_fraction": 0.1,
        "idle_gap_seconds": idle_gap_seconds,
        "gate_states": gates,
        "provenance": provenance_record(provenance),
        "cpu_constructs": constructs,
        "cpu_wrapper": wrapper,
        "blocks": [
            {"logical_block": block, "generation": 1, "status": "planned"}
            for block in sorted({letter["block"] for letter in schedule["letters"]})
        ],
        "slots": [],
    }


def next_block_record(manifest, logical_block):
    records = [record for record in manifest["blocks"] if record["logical_block"] == logical_block]
    current = records[-1]
    if current["status"] == "complete":
        return None
    if current["status"] == "incomplete":
        current = {"logical_block": logical_block, "generation": current["generation"] + 1, "status": "planned"}
        manifest["blocks"].append(current)
    return current


def start_co_tenant(letter, wrapper):
    if not letter["co_tenancy"]:
        return None, None
    if wrapper == "none":
        raise RuntimeError("co-tenancy construct requires taskset or systemd-run")
    command = wrap_command(
        [sys.executable, "-c", "while True: pass"], letter, wrapper, single_cpu=True
    )
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return process, command


def execute_schedule(args, run_dir, schedule, manifest, provenance, wrapper):
    raw = run_dir / "raw"
    raw.mkdir(exist_ok=True)
    executed = 0
    for logical_block in sorted({letter["block"] for letter in schedule["letters"]}):
        record = next_block_record(manifest, logical_block)
        if record is None:
            continue
        record["status"] = "running"
        record["started_utc"] = utc_now()
        write_json(run_dir / "manifest.json", manifest)
        block_letters = [letter for letter in schedule["letters"] if letter["block"] == logical_block]
        try:
            for sequence, letter in enumerate(block_letters, 1):
                if args.max_letters is not None and executed >= args.max_letters:
                    raise InterruptedError("max-letters interruption")
                slot_id = "b{:03d}-g{:02d}-s{:04d}".format(logical_block, record["generation"], sequence)
                slot = {"id": slot_id, "logical_block": logical_block, "generation": record["generation"], "state": "allocated"}
                manifest["slots"].append(slot)
                write_json(run_dir / "manifest.json", manifest)
                observed = verify_provenance(provenance)
                stdout_path = raw / (slot_id + ".ndjson")
                stderr_path = raw / (slot_id + ".stderr")
                status_path = raw / (slot_id + ".status.json")
                argv = wrap_command(harness_argv(letter, provenance, args.engine), letter, wrapper)
                before = loadavg()
                co_tenant, co_tenant_argv = start_co_tenant(letter, wrapper)
                started = utc_now()
                monotonic = time.monotonic()
                try:
                    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
                        result = subprocess.run(argv, stdout=stdout, stderr=stderr, check=False, timeout=args.timeout_seconds)
                finally:
                    if co_tenant is not None:
                        co_tenant.terminate()
                        try:
                            co_tenant.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            co_tenant.kill()
                            co_tenant.wait()
                status = {
                    "slot_id": slot_id,
                    "letter": letter,
                    "argv": argv,
                    "cpu_budget_mechanism": wrapper if letter["cpu_budget"] is not None else "unrestricted",
                    "co_tenancy_argv": co_tenant_argv,
                    "provenance_sha256": observed,
                    "loadavg_before": before,
                    "loadavg_after": loadavg(),
                    "started_utc": started,
                    "ended_utc": utc_now(),
                    "duration_seconds": time.monotonic() - monotonic,
                    "exit_status": result.returncode,
                    "stdout": str(stdout_path.relative_to(run_dir)),
                    "stderr": str(stderr_path.relative_to(run_dir)),
                }
                write_json(status_path, status)
                slot["state"] = "complete" if result.returncode == 0 else "failed"
                slot["exit_status"] = result.returncode
                write_json(run_dir / "manifest.json", manifest)
                update_evidence(run_dir, manifest)
                executed += 1
                if result.returncode != 0:
                    raise RuntimeError(f"letter {slot_id} exited {result.returncode}")
                if args.idle_gap_seconds:
                    time.sleep(args.idle_gap_seconds)
            record["status"] = "complete"
            record["completed_utc"] = utc_now()
            write_json(run_dir / "manifest.json", manifest)
        except DriftError:
            record["status"] = "incomplete"
            manifest["status"] = "aborted-provenance-drift"
            write_json(run_dir / "manifest.json", manifest)
            update_evidence(run_dir, manifest)
            raise
        except (InterruptedError, KeyboardInterrupt):
            record["status"] = "incomplete"
            manifest["status"] = "incomplete"
            write_json(run_dir / "manifest.json", manifest)
            update_evidence(run_dir, manifest)
            raise
        except Exception:
            record["status"] = "incomplete"
            manifest["status"] = "failed"
            write_json(run_dir / "manifest.json", manifest)
            update_evidence(run_dir, manifest)
            raise
    manifest["status"] = "complete"
    manifest["completed_utc"] = utc_now()
    write_json(run_dir / "manifest.json", manifest)
    update_evidence(run_dir, manifest)


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("dry-run", "execute"))
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=0xC0508)
    parser.add_argument("--blocks", type=int, default=1)
    parser.add_argument("--budgets", type=parse_csv, default=parse_csv(DEFAULT_BUDGETS))
    parser.add_argument("--topologies", type=parse_csv, default=parse_csv(DEFAULT_TOPOLOGIES))
    parser.add_argument("--cpu-wrapper", choices=("auto", "taskset", "systemd-run", "none"), default="auto")
    parser.add_argument("--idle-gap-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--engine", choices=("delay", "real"), default="delay")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-letters", type=int)
    parser.add_argument("--co-tenancy", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--gate-c50-8", choices=GATE_CHOICES, default="pending")
    parser.add_argument("--gate-chj", choices=GATE_CHOICES, default="pending")
    parser.add_argument("--gate-18r", choices=GATE_CHOICES, default="pending")
    args = parser.parse_args(argv)
    if args.blocks <= 0:
        parser.error("--blocks must be positive")
    if args.idle_gap_seconds < 0 or args.timeout_seconds <= 0:
        parser.error("time values must be positive")
    return args


def main(argv=None):
    args = parse_args(argv)
    run_dir = args.run_dir.resolve()
    if run_dir.exists() and any(run_dir.iterdir()) and not args.resume:
        raise SystemExit("run directory is not empty; use --resume")
    run_dir.mkdir(parents=True, exist_ok=True)
    provenance = json.loads(args.provenance.read_text())
    wrapper = select_wrapper(args.cpu_wrapper)
    constructs = cpu_constructs(args.budgets, args.co_tenancy)
    schedule = build_schedule(args.seed, args.blocks, constructs, args.topologies)
    gates = gate_states(args)
    if args.engine == "real":
        require_real_gates(gates)
    schedule_path = run_dir / "schedule.json"
    manifest_path = run_dir / "manifest.json"
    if args.resume:
        if not schedule_path.is_file() or not manifest_path.is_file():
            raise SystemExit("resume requires existing schedule.json and manifest.json")
        if json.loads(schedule_path.read_text()) != schedule:
            raise SystemExit("resume arguments do not match retained schedule")
        manifest = json.loads(manifest_path.read_text())
        if manifest["status"] == "aborted-provenance-drift":
            raise SystemExit("provenance drift aborted this epoch; start a new run directory")
        if manifest["provenance"] != provenance_record(provenance):
            raise SystemExit("resume provenance differs from retained manifest")
        if (
            manifest["gate_states"] != gates
            or manifest["cpu_wrapper"] != wrapper
            or manifest["engine"] != args.engine
            or manifest["idle_gap_seconds"] != args.idle_gap_seconds
        ):
            raise SystemExit("resume mechanism, idle gap, or gate state differs from retained manifest")
    else:
        verify_provenance(provenance)
        write_json(schedule_path, schedule)
        manifest = new_manifest(
            schedule, provenance, gates, constructs, wrapper, args.engine, args.idle_gap_seconds
        )
        write_json(manifest_path, manifest)
        redacted_environment(run_dir, provenance, wrapper)
        update_evidence(run_dir, manifest)
    if args.mode == "dry-run":
        return 0
    try:
        execute_schedule(args, run_dir, schedule, manifest, provenance, wrapper)
    except InterruptedError as error:
        print(str(error), file=sys.stderr)
        return 75
    except DriftError as error:
        print(str(error), file=sys.stderr)
        return 74
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
