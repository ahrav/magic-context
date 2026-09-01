#!/usr/bin/env python3
"""Geometric-mean speedup across all Criterion benches.

Walks every change/estimates.json under target/criterion and prints one float:
exp(mean(ln(1 / (1 + relative_change)))). 1.00 means no change from the
saved baseline; higher is faster.
"""

import json
import math
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("target/criterion")
    changes = sorted(
        path
        for path in root.rglob("change/estimates.json")
        if path.parent.parent.name != "report"
    )
    if not changes:
        print("no change estimates found under " + str(root), file=sys.stderr)
        return 1
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
