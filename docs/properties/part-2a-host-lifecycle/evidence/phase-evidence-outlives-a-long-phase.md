# phase-evidence-outlives-a-long-phase

## Discovery trigger

The catalog recorded this as a liveness record whose existing tests assert the
opposite direction: two tests prove that expired evidence becomes `wedged`, and
none proves a healthy long phase does not. The lens is a duration budget that
nobody declared as a budget. If the record is written once per transition and
freshness is a fixed wall-clock window, then that window is a hard cap on phase
duration, and the question is only whether any legitimate operation exceeds it.

## Evidence trail

- The freshness window is **60 seconds**, `Duration::from_secs(60)`, set in
  `impl Default for ProbeFreshness` at
  `crates/mc-host/src/lifecycle.rs:770-776`, value at `:773`. The struct is
  `:765-768`.
- It is not configurable. The sole production construction is
  `ProbeFreshness::default()` at
  `crates/mc-module/src/bin/ck-mc-host.rs:402`, inside `probe()`. There is no
  CLI flag, no `HostTiming` field, and no environment override; the only other
  constructions in the tree are in `crates/mc-host/tests/lifecycle.rs` and
  `crates/mc-module/tests/lifecycle_cli.rs`.
- The record is written exactly once per phase transition, at three production
  sites, and never refreshed. `runtime.rs:668-670` writes `Starting`;
  `runtime.rs:833-835` writes `Running`; `lifecycle.rs:451` writes `Stopping`
  inside `begin_stopping`. Every other `write_lifecycle_record` call in the tree
  is inside `#[cfg(test)] mod tests`, which opens at `lifecycle.rs:1300-1301`.
  No timer, task, or interval re-writes the file — grep for
  `write_lifecycle_record` returns no periodic caller.
- The comparison is `timestamp_fresh` at `lifecycle.rs:1029-1033`, called from
  the `Starting` arm at `:1138` and the `Stopping` arm at `:1162`. Failure
  yields `Wedged` with `"starting record expired"` (`:1141`) or `"stopping record
  expired"` (`:1165`).
- The flip is terminal for the CLI. `settle_probe`
  (`ck-mc-host.rs:408-418`) re-probes only while the state is `Starting` or
  `Stopping`; anything else returns at `:415`. Its deadline is
  `TRANSITION_SETTLE = Duration::from_secs(5)` (`:48`) with `REPROBE_INTERVAL =
  Duration::from_millis(100)` (`:49`), so it gives up long before 60 seconds and
  reports whatever it last saw.

Which operations can legitimately exceed 60 seconds, from the code:

- **The stopping drain, unbounded.** `begin_stopping` at `runtime.rs:299` writes
  the record and then the awaits below it run without a bound; the comment at
  `:286-290` says both awaits are "deliberately unbounded," as is
  `retain_lock_until_drained`'s wait (`:257-271`). `shutdown_deadline` defaults
  to 10 s (`config.rs:228`) but bounds only the graceful drain, not these.
- **A multi-frame egress drain.** `frame_deadline` defaults to 30 s
  (`config.rs:224`, field `:207`) and bounds *one* dequeued frame; the field
  comment at `:202-206` states that idle waiting between frames is unbounded.
  Three queued frames each approaching their own deadline exceed 60 s with every
  individual frame inside contract.
- **A configured callback budget above the window.** `initialize` runs inside
  the `starting` phase, between the `Starting` write at `runtime.rs:668-670` and
  the `Running` write at `:833-835`, bounded by `lifecycle_callback_deadline`
  (default 30 s, `config.rs:226`). Validation only rejects zero and anything
  above `MAX_CONFIG_DURATION = 365 days` (`config.rs:81`, checks `:347-368`), so
  an operator may legitimately set 90 s and the `starting` record expires while
  a within-contract `initialize` is still running.

## Failure scenario

1. A daemon writes its `starting` record at `runtime.rs:668-670`, or its
   `stopping` record at `lifecycle.rs:451`.
2. The phase does real work: an unbounded post-`begin_stopping` drain, or a
   multi-frame egress drain at up to 30 s per frame, or an `initialize` under a
   callback deadline the operator raised above 60 s.
3. Sixty seconds pass. Nothing rewrites the record, because no site does.
4. A probe reaches `classify`, `timestamp_fresh` returns false at `:1138` or
   `:1162`, and the verdict flips to `Wedged` with reason `"starting record
   expired"` or `"stopping record expired"`.
5. `settle_probe` sees a non-transitional state and returns at `:415` without
   re-probing. The healthy, progressing incarnation is reported as a fault, and
   the CLI's remediation for `"wedged"` is `inspect_daemon_process`
   (`ck-mc-host.rs:97-103`).

## Timing windows and dependencies

Exactly 60 seconds from the last transition write, measured on the wall clock in
both the writer (`now_ms()` at `lifecycle.rs:427`) and the reader (`now_ms()` at
`:1030`). No adversary is needed: a slow filesystem, a large payload, a
throttled cgroup, or a raised callback deadline suffices. This record shares the
comparison with `clock-anomalies-do-not-invalidate-live-evidence` — that one
attacks the same 60 s window from the clock side while this one attacks it from
the duration side — and shares its verdict target with
`stopping-precedes-unpublication-on-every-path`.

## What a test must construct

A live coherent incarnation with both fences held and the phase unchanged, then
assert the probe reports the phase and not `wedged` for the full duration the
phase can legitimately take. The cheap deterministic form inverts the two
existing tests: instead of shrinking the window to `Duration::ZERO` as
`expired_starting_and_stopping_evidence_is_wedged` does (`lifecycle.rs:1537`),
hold both fences, write a `starting` record, sleep past a small window, and
assert `Starting`. Because the window is only reachable through
`ProbeFreshness`, a real-duration test must either pass a small window and a
proportionally small phase, or hold a handler in `initialize` past 60 s with
`lifecycle_callback_deadline` raised, which is the shape an operator can
actually configure.

## Investigation log

### Q: Is the record written exactly once per transition and never refreshed, and where are the write sites?

- Sources examined: complete grep for `write_lifecycle_record` and
  `begin_stopping` across `crates/`; the `mod tests` boundary at
  `lifecycle.rs:1300-1301`; `runtime.rs:663-671` and `:820-838`;
  `lifecycle.rs:416-453`.
- Findings: three production write sites — `runtime.rs:668-670` (`Starting`),
  `runtime.rs:833-835` (`Running`), `lifecycle.rs:451` (`Stopping`). All 20
  other calls are above `:1300` in the test module. No periodic or refresh
  caller exists. Confirmed.
- Missing evidence: none.
- Conclusion: resolved. Single-write-per-transition confirmed at three sites.

### Q: Which operations can legitimately exceed the window?

- Sources examined: `config.rs:200-232` (`HostTiming` fields and defaults),
  `:81` (`MAX_CONFIG_DURATION`), `:347-368` (duration validation);
  `runtime.rs:257-271`, `:286-300`, `:663-671`, `:820-838`;
  `generation.rs:412-450` and `:657-664`; `ck_mc_host/serve.rs:1-8` and
  `:544-548`.
- Findings: the unbounded post-`begin_stopping` drains and a multi-frame egress
  drain at 30 s per frame both exceed 60 s with every component inside contract.
  A raised `lifecycle_callback_deadline` does too, since validation permits up
  to 365 days. **Correction:** the catalog's third candidate, per-file hashing
  of a large generation, does *not* extend the `starting` phase. The per-file
  SHA-256 loop (`generation.rs:432-444`, driven per manifest entry at
  `:657-664`) runs from `serve`'s revalidation at `serve.rs:544-548`, and
  `serve.rs:6-8` states that lock acquisition and the `starting` record all live
  inside `mc_host::run`, which is entered afterwards. That hashing precedes the
  record's existence rather than ageing it.
- Missing evidence: whether 60 s is realistic for the target deployment's
  payload sizes and queue depths — a deployment fact, not a code fact.
- Conclusion: partially resolved. Two code-supported operations exceed the
  window and one catalog candidate is refuted. Realism remains open, as the
  catalog records.
