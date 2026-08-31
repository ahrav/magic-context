# probe-never-reports-stopped-while-either-fence-is-held

## Discovery trigger

The catalog recorded this at high confidence with the basis "stopped is returned
from exactly two places and both require the lifetime fence free". That is a
counting claim about the production code, so it is cheap to falsify and worth
confirming by exhaustive grep rather than by reading the happy path. The lens is
state-reachability: `stopped` is the one verdict that authorizes a launcher to
start a new incarnation, so any reachable `stopped` under a held fence is an
overlap admission.

## Evidence trail

- `crates/mc-host/src/lifecycle.rs` contains exactly two production
  constructions of `LifecycleState::Stopped`, at `:948` and `:1066`. The
  remaining ten matches for the variant (`:1492`, `:1532`, `:1654`, `:2169`,
  `:2181`, `:2290`, `:2310`, `:2376`) are assertions inside `#[cfg(test)] mod
  tests`, which opens at `:1300-1301`.
- Site one is `probe_lifecycle`'s runtime-directory loop, `:939-961`. It is
  reached only when `open_validated_dir` returns `None` at `:945`, meaning no
  runtime directory exists, and it returns `Stopped` at `:947-954` only after
  `lifetime_lock_free(data_dir_override)?` reads true at `:946`. The instance
  lock is a flock on the runtime-directory inode, so when that directory is
  absent there is no inode to hold; the site reports `instance_lock_free: true`
  at `:952` on that ground.
- The complement is explicit: when the loop exhausts its retries without
  finding a directory and the lifetime fence is held, `:962-971` returns
  `Wedged` with reason `"lifetime fence held without a runtime directory"`.
  A namespace replacement under a live daemon therefore lands here, not on the
  `stopped` path.
- Site two is `classify`, `:1065-1072`, guarded by `if lock_free &&
  lifetime_free` at `:1050`. Both fences are free by construction of the
  branch. Every other exit from `classify` yields `Wedged`, `Starting`,
  `Running`, or `Stopping`.
- `classify`'s comment at `:1051-1055` states the rule the two sites implement:
  no holder of either fence means no incarnation, whatever evidence remains.
  Leftover evidence only changes the `reason` string (`:1056-1064`), never the
  state.
- Acquisition order is the source of the single-fence window.
  `InstanceGuard::acquire` takes the lifetime fence first at
  `crates/mc-host/src/instance.rs:245`, resolves the runtime directory at
  `:246-247`, then takes the instance lock at `:248`. The comment at
  `:241-245` gives the reason: the lifetime fence lives outside the replaceable
  `cortexkit` subtree. `probe_lifecycle`'s own comment at `:925-928` states the
  matching teardown order — fence taken before the runtime lock at start and
  released after it at teardown.
- The absorbing grace is `LOCK_DISAGREEMENT_GRACE = 2` (`:929`) with
  `GRACE_DELAY = Duration::from_millis(25)` (`:930`), applied at `:999-1003`.
  Disagreement survives the grace only if it persists across three samples.
- The one coherent single-fence shape is the `incumbent` predicate at `:1091`,
  `!lock_free && lifetime_free && legacy_record.is_some()`. It bypasses the
  disagreement check at `:1092` and classifies by record phase, so it cannot
  reach either `Stopped` site either.

## Failure scenario

No failing path was found. The property holds as stated: both `Stopped` sites
are dominated by a check that the lifetime fence is free, and the instance lock
is either separately observed free (`:1050`) or has no inode to be held on
(`:945-946`). The nearest miss is the namespace-replacement shape, which the
code deliberately routes to `Wedged` at `:962-971` rather than to `Stopped`.

## Timing windows and dependencies

The window is the few syscalls between `instance.rs:245` and `:248` at start,
and the mirror image at teardown. A probe sampling inside it observes exactly
one fence held. That is not a fault, and the bounded grace at `:999-1003`
absorbs it: three samples spaced 25 ms apart. The property depends on
`lifetime_lock_free` reporting an absent coordination root as free, which the
function's own contract states; an external rename of
`.mc-host-coordination` under a live daemon is declared out of contract there
and would read as free, which is a stated limit of the fence, not of these two
sites.

## What a test must construct

Hold each fence in turn and assert the verdict is never `Stopped`. For a held
lifetime fence with no runtime directory, take `LifetimeLock` and delete the
runtime directory, then assert `Wedged` with reason `"lifetime fence held
without a runtime directory"`. For a held instance lock with a free lifetime
fence, flock the runtime directory alone and assert the verdict is `Wedged`
unless a legacy record makes it an incumbent. The replacement case is the
sharpest: with a live daemon holding both fences, rename or replace the
`cortexkit` subtree and assert the verdict is `Wedged`, which
`a_replaced_cortexkit_subtree_is_not_reported_stopped_while_the_daemon_lives`
(`lifecycle.rs:2275`) already does. Sustained disagreement past the grace needs
a fence held for more than 75 ms, which a test can do directly by taking the
flock itself.

## Investigation log

### Q: Is `Stopped` returned from exactly two places, and does each require both fences free?

- Sources examined: a complete grep for `LifecycleState::Stopped` and `state:
  LifecycleState::` across `lifecycle.rs`; the `mod tests` boundary at
  `:1300-1301`; `probe_lifecycle` `:912-1024` in full; `classify` `:1035-1177`
  in full; `instance.rs:230-250` for acquisition order.
- Findings: exactly two production sites, `:948` and `:1066`. Site `:1066` is
  guarded by `lock_free && lifetime_free` at `:1050`, so both fences are
  observed free. Site `:948` is guarded by `lifetime_lock_free` at `:946` and
  is reachable only when the runtime directory does not exist, so the instance
  lock has no inode to be held on rather than being separately observed free.
  The claim is confirmed, with that one refinement to how the instance lock is
  discharged.
- Missing evidence: none for this question.
- Conclusion: resolved and confirmed. Both `Stopped` sites require the lifetime
  fence free, and neither is reachable while either fence has a holder.

### Q: Are the exercising tests Linux-only, as the catalog states?

- Sources examined: every `cfg(target_os = "linux")` occurrence in
  `lifecycle.rs` (four: `:1839`, `:2013`, `:2040`, `:2081`); the `mod tests`
  header at `:1300-1302`; the test-function index across `:1324-2499`.
- Findings: **Correction.** The test module carries no platform gate, and the
  only Linux-gated items are the `within` helper at `:2013` and the two FIFO
  hang tests at `:2040` and `:2081`. The tests bearing on this property —
  `probe_reports_stopped_on_an_empty_root_without_creating_anything` (`:1489`),
  `free_lock_with_stale_publication_is_stopped_and_untouched` (`:1626`),
  `concurrent_probes_never_resurrect_stale_evidence_as_live` (`:2135`),
  `a_replaced_cortexkit_subtree_is_not_reported_stopped_while_the_daemon_lives`
  (`:2275`), and `lifetime_and_runtime_lock_disagreement_is_wedged` (`:2400`) —
  are not Linux-gated and run on any unix.
- Missing evidence: none.
- Conclusion: the catalog's "all Linux-only" qualifier is wrong for this
  record's five tests and should be dropped. The unaudited-status note stands.
