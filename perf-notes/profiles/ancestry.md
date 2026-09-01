# Ancestry Profile

Target: `ancestry/linear-10k/far` at commit `4ad08c20b`, benchmark build ID
`a49857b4bc63d67dd40b6f8d592a529726ced782`.

Build:

```text
RUSTFLAGS="-C target-cpu=native -C debuginfo=2 -C force-frame-pointers=yes"
```

The benchmark-only `MC_SCOPE_PROFILE=ancestry-far` mode constructs the repository once, then runs
fresh `ResolutionLadder` ancestry queries for ten seconds.

Evidence:

- 199 Hz: 2,011 samples, zero lost; 997 Hz: 9,889 samples, zero lost.
- Both frequencies rank `zlib_rs::inflate::inflate` first at about 30% self cycles.
- Commit parsing is 5-6%; loose-object lookup, hex decode, allocation, free/realloc, and memory
  movement make up most remaining attributed userspace cost.
- `perf stat`: 8.05B userspace cycles, 16.72B instructions, IPC 2.08.
- Branch miss rate: 0.69%.
- Wall/user/system over ten seconds: 10.16s / 2.28s / 7.86s.

Conclusion: far ancestry is loose-object decode and traversal work, not a hot branch in
`ResolutionLadder`. The baseline's 100x near/far spread is an algorithmic and repository-index
problem. Pursue bounded commit-graph walks or shared batch reachability before local loop tuning.

Raw profiles are under `/tmp/mc-scope-perf/ancestry-kernel-{199,997}.data`.

