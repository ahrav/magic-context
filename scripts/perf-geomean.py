#!/usr/bin/env python3
"""Geometric-mean speedup across named Criterion benchmark groups.

Usage: perf-geomean.py ROOT GROUP [GROUP ...]

Prints one float: exp(mean(ln(1 / (1 + relative_change)))). 1.00 means no
change from the saved baseline; higher is faster.

Each GROUP names one directory directly under ROOT, and only change estimates
beneath the named groups are read. Criterion keeps results from every
`cargo bench` invocation in one shared ROOT and never prunes a group whose
benchmark was renamed or deleted, so an unrestricted walk would fold another
crate's benchmarks and removed cases into the reported speedup. A named group
that is missing is an error rather than a silent omission, because dropping a
regressed group would raise the geomean.
"""

import json
import math
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: perf-geomean.py ROOT GROUP [GROUP ...]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    groups = sys.argv[2:]

    changes = []
    for group in groups:
        directory = root / group
        if not directory.is_dir():
            print(f"benchmark group not found: {directory}", file=sys.stderr)
            return 1
        found = sorted(
            path
            for path in directory.rglob("change/estimates.json")
            if path.parent.parent.name != "report"
        )
        if not found:
            print(f"no change estimates under {directory}", file=sys.stderr)
            return 1
        changes.extend(found)

    logs = []
    for path in changes:
        bench_root = str(path.parent.parent.relative_to(root))
        with open(path) as handle:
            estimates = json.load(handle)
        relative = estimates["mean"]["point_estimate"]
        speedup = 1.0 / (1.0 + relative)
        print(f"{bench_root}\t{speedup:.4f}", file=sys.stderr)
        logs.append(math.log(speedup))
    print(f"{math.exp(sum(logs) / len(logs)):.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
