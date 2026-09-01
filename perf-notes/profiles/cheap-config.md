# Config Check Profile

Target: `cheap_checks/run_cheap_check/config-key` after iteration 31.

The benchmark-only `MC_SCOPE_PROFILE=cheap-config` mode repeatedly checks one present key in a
small config file for ten seconds.

Evidence:

- 199 Hz: 1,993 samples, zero lost.
- Kernel/syscall paths dominate.
- `File::read_to_string` performs a second capacity metadata probe and seek after the explicit
  size-cap metadata check.
- String matching is a secondary cost; `config_contains_key` itself is below 1% self cycles.

Decision: retain the single open/metadata check, then wrap the descriptor in `Take<&mut File>` to
select generic `Read::read_to_string` without the duplicate File specialization. Do not add a
custom parser or matcher.

Raw profile: `/tmp/mc-scope-perf/cheap-config-iter31-199.data`; report:
`/tmp/mc-scope-perf/cheap-config-iter31.report`.
