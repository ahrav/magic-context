# h4c-recomp-reset-precedes-its-ledger-row

## Discovery trigger

`handle_session_recomp_value` reads a ledger row before doing anything
(`crates/mc-module/src/lib.rs:6015`), which is the shape of a
retry-safe handler. But the write that creates that row on the reset path happens
at `:6114`, thirty-seven lines *after* the destructive reset at `:6077`. A handler
whose replay guard is written last is not retry-safe in the window between.

All references are to `crates/mc-module/src/lib.rs` unless stated. Verified at
`HEAD` `b5dc778e`; `git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is
empty, so these hold at the commit named in the task as well.

## Evidence trail

**The replay guard, read first.**

```
6015        match store.load_recomp_command(&session_id, command_id) {
6016            Ok(Some(row)) => {
6017                return respond(json!({
6018                    "ok": true,
6019                    "disposition": row.disposition,
6020                }));
6021            }
6022            Ok(None) => {}
```

So a second delivery with the same `command_id` short-circuits, provided the row
exists.

**The identity is caller-supplied and capped.** `command_id` is read at `:6005`
and bounded to 1..=128 bytes at `:6008-6010`. `management_binding` (`:5892-5933`)
has already required `v == 1`, a nonempty `session_id`, and a route binding that
matches. So validation precedes every write in this handler.

**The latch.** `try_claim_recomp_session` at `:6030` yields `_guard`. On the
`Err(())` arm it returns `already_in_progress` (`:6033-6036`) rather than
proceeding, so two concurrent deliveries do not both reset. The guard is a local
binding, so it releases when the function returns by any path, including the error
paths below.

**The two orderings.** There are two exits that write, and only one is exposed.

The `never_minted` early return writes the row and performs no reset:

```
6058        let never_minted = !has_compartments && loaded.core.boundary_id.trim().is_empty();
6059        if never_minted {
6060            return match store.record_recomp_command(
6061                &session_id,
6062                command_id,
6063                "nothing_to_do",
6064                now_ms(),
6065            ) {
```

The reset path writes the row last:

```
6077        let _reset = match store.reset_session_for_recomp(&session_id, loaded.row_version) {
...
6114        match store.record_recomp_command(&session_id, command_id, "started", now_ms()) {
6115            Ok(row) => respond(json!({
...
6119            Err(error) => PreparedOutcome::Error {
6120                code: "store_write_failed".to_string(),
```

Between those two calls the handler clears four in-process caches
(`:6095-6113`): `serialized_outputs`, `native_attachments`, `boundary_tokens`, and
a `transform_snapshots.begin` fence whose purpose is documented at `:6107-6109`.
None of those are durable, so they are not part of the atomicity claim, but they
widen the window in wall-clock terms.

**The CAS on the reset is on a freshly observed version.** `:6077` passes
`loaded.row_version` from the `store.load` at `:6040`. The `CasConflict` arm at
`:6079-6087` carries a comment explaining the deliberate choice: "The recomp latch
remains held; ask the caller to retry rather than claiming a reset that did not use
the observed cache version." That comment shows the author reasoned about one
failure ordering, the conflicting-transform case, and returned an error without
having reset. It does not address a failure of the *ledger* write after a
successful reset.

## Failure scenario

1. A session has compartments, so `never_minted` is false at `:6058`.
2. `session.recomp` arrives with `command_id = "recomp-7"`.
3. `:6015` finds no row. `:6030` takes the latch.
4. `:6077` resets the session's cache state and boundary. Durable.
5. `:6114` fails: disk full, `SQLITE_BUSY` past the timeout, or the process is
   killed here.
6. The caller receives `store_write_failed` (`:6119-6122`), or nothing at all if
   the process died. `_guard` drops, releasing the latch.
7. The caller retries `recomp-7`. `:6015` still finds no row. `:6030` takes the
   latch again. `:6040` loads the now-reset state and a new `row_version`.
   `:6077` resets again, and this time the CAS succeeds because the version is
   current.

The caller's `command_id` bought nothing: it was supposed to make step 7 a replay
and instead step 7 is a second application.

## Timing windows and dependencies

The window is `:6077` to `:6114`. It contains four mutex acquisitions
(`:6095-6113`), so it is not a tight instruction sequence; a `SIGKILL` or a store
error lands in it without special timing.

Dependency: `reset_session_for_recomp`'s own semantics, in `mc-store`. Whether a
second reset of an already-reset session is destructive or a no-op decides whether
this is a correctness defect or a wasted round trip. That is Part 3's territory
and is left unresolved below rather than guessed.

Not a concurrency window: the latch at `:6030` serialises concurrent deliveries.
This is a crash-and-retry window, not an interleaving.

## What a test must construct

- A session with at least one compartment or a nonempty `boundary_id`, so the
  `never_minted` branch is not taken. `session_recomp_resets_cache_boundary_and_replays_started`
  (`:27313`) already builds a session in this shape and can be the starting point.
- A store seam that fails `record_recomp_command` while leaving
  `reset_session_for_recomp` working. The store already has per-call test seams of
  this kind, for example `fail_next_historian_side_channel_for_test` used at
  `:30041`, so the pattern exists; whether one exists for this call is unverified.
- Coverage-check form, per METHOD.md: do not assert the double reset. Assert the
  independent preconditions that create the window, namely that
  `reset_session_for_recomp` committed and `load_recomp_command` returns `None`
  for the same `command_id`. Those two facts hold on a correct implementation
  only if the pairing is broken, and asserting them separately avoids a marker
  that can fire only by observing the defect.
- The alternative oracle is per-identity effect counting: for one `command_id`,
  count resets attempted and resets acknowledged, and assert observed resets are
  at most the attempted count and at least the acknowledged count. METHOD.md's
  effect-accounting rule applies because the response can be lost.

## Investigation log

### Q: Is a second `reset_session_for_recomp` against an already-reset session materially harmful?

- Sources examined: `lib.rs:6077-6094` for the call and its error arms;
  `lib.rs:6040-6057` for the state read that feeds it; the four inline recomp
  tests found by scanning test-function names in `lib.rs:16001-30517`.
- Findings: the module treats the reset as a single opaque durable step and never
  inspects what it changed; `_reset` at `:6077` is discarded. So the module-side
  evidence cannot answer the question. `session_recomp_resets_cache_boundary_and_replays_started`
  (`:27313`) asserts the post-reset state once but does not reset twice.
- Missing evidence: `reset_session_for_recomp`'s body in `crates/mc-store`, which
  is Part 3's scope and which this lens deliberately did not re-derive.
- Conclusion: unresolved, needs Part 3's account of `reset_session_for_recomp`.
  The atomicity gap between `:6077` and `:6114` is established regardless; only
  its severity depends on this answer.

### Q: Does the released latch actually admit the retry, or does something else block it?

- Sources examined: `try_claim_recomp_session` (`:4543-4612` group, called at
  `:6030`), the `_guard` binding and its drop, `handle_session_delete_value`'s
  removal of `recomp_sessions` at `:6150-6153`.
- Findings: `_guard` is a plain local, so it drops on the `store_write_failed`
  return at `:6119-6122`. Nothing in the failing path records that a reset
  occurred. On a process kill the whole in-memory map is gone, so the latch is
  certainly not held.
- Missing evidence: none for this question.
- Conclusion: resolved with answer. The retry is admitted on both the error return
  and the crash-restart path.
