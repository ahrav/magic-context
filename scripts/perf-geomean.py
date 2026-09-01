#!/usr/bin/env python3
import json
import math
import pathlib
import sys


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "target/criterion")
    speedups = []
    for path in root.glob("**/change/estimates.json"):
        change = json.loads(path.read_text())["mean"]["point_estimate"]
        if change <= -1:
            continue
        speedups.append(1 / (1 + change))
    if not speedups:
        raise SystemExit(f"no Criterion change estimates under {root}")
    print(f"{math.exp(sum(map(math.log, speedups)) / len(speedups)):.6f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
