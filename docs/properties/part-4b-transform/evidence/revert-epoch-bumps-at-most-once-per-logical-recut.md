# revert-epoch-bumps-at-most-once-per-logical-recut

## Discovery trigger

Once the truncate at `transform.rs:4646` was identified as a durable write
inside the CAS-retry loop, the obvious follow-up was: the loop can run
`apply_once` nine times, so can it truncate nine times and bump `revert_epoch`
nine times?

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The retry loop:

- `transform.rs:2269` — `let mut attempt = 0;`
- `transform.rs:2274` — `loop {`
- `transform.rs:2283-2284` — `Err(TransformError::Store(McStoreError::CasConflict
  { .. })) if attempt < MAX_CAS_RETRIES =>`
- `transform.rs:82` — `const MAX_CAS_RETRIES: u32 = 8;`
- `transform.rs:2290-2291` — `attempt += 1; continue;`

So attempts run for `attempt` values 0 through 8, giving at most nine
`apply_once` invocations. Each one re-reads everything: `load_transform_snapshot`
at `:3387` and `load_compartments` at `:4643`.

The truncate arm on attempt 2 recomputes its argument:

- `transform.rs:4643` — `let compartments = store.load_compartments(&req.session_id)?;`
- `transform.rs:4644-4645` — `let keep_through_seq =
  surviving_revert_prefix_seq(&compartments, &live);`

`surviving_revert_prefix_seq` (`transform.rs:7275-7284`):

```
let live_ids: BTreeSet<&str> = live.iter().map(|block| block.id()).collect();
compartments
    .iter()
    .take_while(|compartment| live_ids.contains(compartment.end_message_id.as_str()))
    .map(|compartment| compartment.sequence)
    .last()
    .unwrap_or(-1)
```

It is a `take_while` prefix scan. `live` is fixed within one firing, because
`req` does not change across retries. Truncation removes a suffix of
`compartments`. Removing a suffix cannot shorten a `take_while` prefix, so
`keep_through_seq` on attempt 2 is greater than or equal to attempt 1's value.

The idempotence then rests on the store's no-op arm:

- `mc-store/src/lib.rs:9046-9052` — `SELECT COUNT(*), MIN(sequence),
  MAX(sequence) FROM mc_compartments WHERE session_id = ?1 AND sequence > ?2`
- `mc-store/src/lib.rs:9053-9059` — `if dropped_count == 0 { return
  Ok(TruncateTxnOutcome::Committed(TruncateOutcome { revert_epoch:
  meta.revert_epoch, last_recut: meta.last_recut, row_version: current.max(0) as
  u64 })); }`

That arm returns the *current* epoch and the *current* row version, writes
nothing, and bumps nothing. The epoch bump is only on the path past it
(`:9080` — `let next_epoch = meta.revert_epoch.saturating_add(1);`).

The doc on the function states this intent (`mc-store/src/lib.rs:9013-9014`): "A
no-op truncation returns the current epoch/version without rewriting the meta
blob."

Note the CAS interaction: attempt 2 passes `commit_expected`, which is
`loaded.row_version` freshly re-read (`transform.rs:4393`), so the truncate's
own CAS at `:9033-9039` will match.

The test hook that makes this constructible exists:

- `transform.rs:5563-5564` — `#[cfg(test)] run_transform_attempt_hook(&req.session_id);`
  immediately before the terminal commit
- `transform.rs:2303-2333` — the hook registry

## Failure scenario

If `keep_through_seq` on a retry were ever *smaller* than the previous
attempt's, the retry would find `dropped_count > 0`, delete more compartments,
and bump `revert_epoch` a second time within one firing. The observable
consequences: the serialized-output cache is evicted twice
(`transform.rs:5381`, `:422-429`), and `revert_epoch` stops being a witness for
"one accepted recut" because it can advance without any accepted pass. Anything
downstream that treats the epoch as a generation counter for recuts would
over-count.

## Timing windows and dependencies

Window: one firing, up to nine attempts. No external writer required, only a
CAS conflict on the terminal commit, which a concurrent state-sync, agent-drop
consumption, or historian publish can cause.

Dependency: the argument above assumes `live` is byte-identical across attempts
within a firing. That holds because `req` is borrowed unchanged into
`apply_once` (`transform.rs:2276-2282`) and `normalize_synthetic_todo_ingress`
(`:3243`) is a pure function of `req`.

## What a test must construct

1. Seed a session so the reconcile-rematerialize arm at `transform.rs:4642` is
   entered, per the construction in
   [revert-truncate-commits-outside-the-terminal-cas](revert-truncate-commits-outside-the-terminal-cas.md),
   but with a composition that succeeds so the pass reaches `:5565`.
2. Register a transform attempt hook that, on the first invocation only, commits
   a conflicting cache-state row so the terminal CAS fails.
3. Read `meta.revert_epoch` before the firing and after it.
4. Assert the difference is exactly one, not two.
5. Additionally assert `dropped_count == 0` was taken on the retry, which is the
   independent precondition rather than the violation. A store-side counter or a
   `last_recut` string comparison serves: the no-op arm returns the *prior*
   `last_recut` verbatim (`mc-store/src/lib.rs:9056`), so an unchanged
   `last_recut` after a retry is the witness.

## Investigation log

### Q: Can a retry's `keep_through_seq` ever be smaller than the previous attempt's, causing a second real truncation?

- Sources examined: `transform.rs:7275-7284` (the whole function),
  `:4643-4645`, `:2274-2299`, `:3243`, `:3342`;
  `mc-store/src/lib.rs:9046-9059`.
- Findings: the function is a `take_while` over `compartments` in iteration
  order, gated on `end_message_id` membership in the `live` id set. Two inputs:
  `compartments`, which loses a suffix across the retry, and `live`, which is
  fixed. A `take_while` prefix over a list that lost a suffix is the same prefix
  truncated at worst to the surviving length. Since the surviving compartments
  are exactly the prefix through `keep_through_seq`, and each of those had a live
  `end_message_id` on attempt 1, the same predicate holds on attempt 2 and the
  scan runs to the end of the shorter list. So `keep_through_seq` is unchanged.
  Then `sequence > keep_through_seq` selects nothing and `dropped_count == 0`.
- Missing evidence: whether `load_compartments` returns rows ordered by
  `sequence`. The `take_while` is order-sensitive and the argument depends on it.
  The truncate's own queries order explicitly (`mc-store/src/lib.rs:9066`,
  `:9075`), but `load_compartments`'s ordering was not read.
- Conclusion: unresolved, needs one read of `load_compartments`'s `ORDER BY`.
  The reasoning is sound conditional on ordered output, and no test constructs
  the retry today, so the record's confidence stays medium.
