# stagelc-state-import-discard-runs-before-the-binding-check

## Discovery trigger

Tracing which identity each coordinator's `discard` is keyed on. The seed and
page handlers both derive the key from a resolved binding. The state import
handler derives it from the request body, and the ordering of the binding check
relative to the first discard turned out to be inverted.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

`handle_state_import_value` is `crates/mc-module/src/lib.rs:5591-5774`. The
statement order that matters:

- `:5592-5595` — `raw_session_id` is taken straight from
  `request.get("session_id")`, before any parsing or authorisation.
- `:5596-5608` — the 1 MiB frame check. On the over-size arm, `:5599-5603` calls
  `self.state_imports.lock()...discard(session_id)` using `raw_session_id`. This
  is the earliest discard and it runs before the wire struct is even
  deserialised.
- `:5609-5620` — deserialisation into `StateImportWire`. On error, `:5612-5616`
  discards using `raw_session_id` again.
- `:5621-5627` — the `discard` closure is defined, capturing
  `&parsed.session_id`, the caller-supplied field.
- `:5628-5651` — four validation arms, each calling `discard(self)` first:
  version check `:5629`, empty-session check `:5636`, `import_id` length check
  `:5640`, `batch_seq`/`batch_count` check `:5646`.
- `:5653` — **`let _binding = match self.resolve_binding(channel, &parsed.session_id)`**.
  This is the first authorisation of the request against the channel, and it is
  after all six discards above.
- `:5655-5661` — the `BindingError::Unbound` arm itself calls `discard(self)` at
  `:5656` before returning `route_unbound`.
- `:5662-5669` — the `BindingError::SessionMismatch` arm likewise calls
  `discard(self)` at `:5663` before returning `session_mismatch`.

So the handler discards the named session's staged import on every early
rejection path, including the two paths whose whole purpose is to report that the
caller had no right to name that session.

What `discard` does, so the effect is concrete:

- `:1388-1395` — `StateImportCoordinator::discard` calls
  `self.sessions.remove(session_id)` and, on a hit, decrements
  `pending_import_count` and subtracts `phase_bytes`. It destroys the whole
  `Collecting` phase, including every batch accumulated so far.

The two sibling handlers do not have this shape, which is what makes it look like
an ordering slip rather than a policy:

- `:8654-8664` — `handle_state_sync_value`'s own deserialisation-failure arm is
  the exact analogue of `:5609-5620`, and it handles the problem correctly: at
  `:8658` it calls `self.state_sync_binding(channel, None)` and only discards on
  success, using `binding.session` (`:8659`). The key comes from the channel's own
  binding, never from the request field.
- `:8665` — the main binding resolution, before any staging. Every later seed
  discard uses `binding.session` (for example `:8711`, `:8718`, `:8727`).
- `:9347` — `handle_transform_page_value` resolves via `state_sync_binding`
  before its thirteen `discard_transform_pages(&binding.session)` calls
  (`:9352`-`:9439`).

That `:8658` arm is the strongest single piece of evidence here: the same author,
in the same file, in the structurally identical situation, reached for the
channel's binding rather than the request body.

`resolve_binding` itself is `:4305-4316` and does compare
`binding.session != request_session` (`:4312-4314`), so the check exists and is
correct. It is only reached too late.

Reachability, both sides per METHOD.md rule 4:

- Config default: the method is dispatched at `:12279`,
  `"state_import" => self.handle_state_import_value(channel, request)`. No config
  leaf gates it.
- Shipped setup path: a search across `packages/` for the method name finds
  exactly one non-test sender, `packages/plugin/scripts/drive-preseed.ts:48`
  (`kind: "state_import"`), whose header at `drive-preseed.ts:4` describes it as
  seeding a session's key "via the module's state_import op". No plugin hook, no
  CLI command, and no hot path sends it.
- Class: `explicit-config-only`. The handler is reachable only when an operator
  runs the preseed script. That bounds the blast radius today and is the reason
  this record is not the highest-severity one in the lens despite being the only
  cross-session effect in it.

## Failure scenario

Session V is mid-import on channel 1: batches 0 and 1 of 4 are staged, holding a
`Collecting` phase with two batches of compartments.

A request arrives on channel 2 carrying `session_id: "V"` and `v: 0`. Channel 2
is bound to a different session, or is not bound at all. Control reaches `:5628`,
fails the version check, calls `discard(self)` at `:5629`, and returns
`state_import_version`. Session V's two staged batches are gone. When V sends
batch 2 it hits the `None` arm at `:1565-1571`, fails `batch_seq != 0`, and gets
`batch_seq_mismatch`. V must restart its import from batch 0.

The same works with an entirely unbound channel via the `:5656` path, which is
the starker version: the handler tells the caller "route_unbound" and destroys
the victim's state on the way out.

Two things bound the severity and both belong in the record. First, no durable
state is corrupted: the durable write happens only at `:5738-5743` on the final
batch, and `preflight_state_import` (`:5678`) plus the `SessionNotEmpty` check
mean a partially staged import has written nothing. So this is denial of
progress, not data loss. Second, the reachability class above means only an
operator-run script exercises the op at all today.

## Timing windows and dependencies

The window is the victim's `Collecting` phase, which lasts until its final batch
or until `STATE_IMPORT_STALE_AFTER` (5 minutes, `:654`) elapses and
`evict_stale` reaps it on the next staging call (`:1441`). Any request on any
channel inside that window can end it.

No race is required. The two requests are ordinary sequential requests; the
`Mutex` around the coordinator (`:2950`) serialises them and the outcome is the
same either way.

## What a test must construct

1. Build a handler with a store. Bind route 1 to session `V` and route 2 to
   session `W`.
2. On route 1, send batch 0 of a two-batch `state_import` for `V`. Assert the
   response reports `"staged": 1`, matching the existing test's assertion style
   at `:27026`.
3. On route 2, send a `state_import` naming `session_id: "V"` with `v: 0`. Assert
   it fails with `state_import_version`.
4. On route 1, send batch 1 of `V`'s import. Assert it succeeds and the import
   commits. Today it fails `batch_seq_mismatch`, proving the staged state was
   destroyed by step 3.
5. Second arm: repeat with route 2 unbound entirely, driving the `:5656` path,
   and assert the same.

Both arms assert only that a well-formed continuation succeeds, which is a
property of a correct system, so neither test asserts a violation directly.

## Investigation log

### Q: Is the pre-binding discard deliberate, on the theory that a malformed request invalidates any series in flight?

- Sources examined: all six early discard sites (`:5599-5603`, `:5612-5616`,
  `:5629`, `:5636`, `:5640`, `:5646`), the two binding-error arms (`:5656`,
  `:5663`), `resolve_binding` (`:4305-4316`), the seed handler's analogous
  deserialisation-failure arm (`:8654-8664`), and the page handler's ordering
  (`:9347`).
- Findings: invalidating a series on a malformed request is a coherent policy,
  and the seed and page handlers implement exactly that policy. They just key it
  on `binding.session` rather than on the request field, which they can do
  because they resolve the binding first. The seed handler's `:8658` arm proves
  the pattern was available and used elsewhere in the same function's error
  handling. The binding resolution here needs
  nothing that is not already available at `:5628`: it takes `channel`, a
  parameter, and `parsed.session_id`, which exists from `:5609`. So moving
  `:5653` above `:5628` would preserve the policy and remove the cross-session
  effect, at no cost.
- Missing evidence: no comment at any of the six sites explains the ordering, and
  no test covers a mismatched channel. `:27077 state_import_structural_rejections_name_rules_and_leave_session_empty`
  covers the structural rejections but only on a correctly bound channel.
- Conclusion: needs human input. The fix is obvious and cheap, but declaring the
  current order a defect rather than an accepted trade-off is a design call, and
  the low reachability class means it may reasonably be deprioritised.

### Q: Can this corrupt durable state rather than just deny progress?

- Sources examined: `preflight_state_import` (`:5678-5703`) including the
  `StateImportPreflight::Duplicate` and `SessionNotEmpty` arms;
  `commit_state_import` (`:5738-5743`); and the staging outcome enum
  (`:1362-1369`).
- Findings: no. The only durable write is `commit_state_import`, reached only
  from `StateImportStageOutcome::Apply`, which `stage` returns only on the final
  batch (`:1543`, `:1592`). A destroyed `Collecting` phase has written nothing.
  Further, the durable dedup at `:5679` means a completed import cannot be
  re-applied, and `SessionNotEmpty` (`:5688`) means a partial re-import cannot
  overwrite a populated session.
- Missing evidence: none.
- Conclusion: resolved with answer. The impact is denial of progress and lost
  work, not durable corruption. The record's Impact line says so.
