# h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together

## Discovery trigger

`apply_state_sync_wire` is otherwise the best-fenced handler in this lens's scope:
one store transaction, guarded by a generation and an expected sequence, with the
store re-checking its own predicate. Then the `Ok` arm turns out to carry a second
effect that the fence does not protect, because it is in memory and therefore
outside the transaction.

References are to `crates/mc-module/src/lib.rs` unless stated. Verified at `HEAD`
`b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The flag is read from the wire at the top and used at the bottom.**

```
9133        let note_evaluation_available = parsed.note_evaluation_available.unwrap_or(false);
```

(`:9133`, defaulting to `false` when absent.)

**The single durable transaction.** `store.apply_authority_state_sync` is called
once, at `:9241`, with a request struct spanning `:9241-9285`. Its fence:

```
9244            shadow_generation: parsed.shadow_generation,
9245            expected_shadow_seq: parsed.expected_shadow_seq,
```

**The second effect, inside the `Ok` arm only.**

```
9287            Ok(result) => {
9288                self.set_note_evaluation_capability(
9289                    &binding.project_root,
9290                    note_evaluation_available,
9291                );
9292                respond(json!({
9293                    "ok": true,
9294                    "shadow_generation": result.shadow_generation,
9295                    "shadow_seq": result.shadow_seq,
9296                    "row_version": result.row_version,
```

`set_note_evaluation_capability` is one of the note-evaluator registry methods in
the `:3828-3976` group, which the region map describes as "capability set/clear,
expiry purge, per-channel removal". It is keyed by `&binding.project_root` at
`:9289`, so it is project-scoped in-memory state, not session-scoped and not
durable.

**The fence rejects the retry, so the second effect is never reached again.**

```
9316            Err(ModuleStateSyncError::AuthoritySeqMismatch { expected, found }) => {
9317                state_sync_seq_mismatch_error(expected, found)
9318            }
```

Once `apply_authority_state_sync` has committed, `expected_shadow_seq` no longer
matches, so a redelivery of the identical wire takes `:9316-9318` and the `Ok` arm
at `:9287` is not entered. The durable half is protected exactly as intended; the
in-memory half has no second chance.

**The positive finding alongside it, worth keeping.** The handler pre-checks the
historian phase and the store re-checks it:

```
9194        if !compartments.is_empty() {
9195            let historian_phase = match store.load(&binding.session) {
9196                Ok(loaded) => loaded.meta.historian.state,
...
9204            if historian_phase != HistorianPhase::Idle {
9205                // Do not stage or adopt compartment rows while a historian owns the
9206                // snapshot. The TS sender treats this typed rejection as retry-later,
9207                // retaining its acknowledged sequence and watermarks instead of forcing
9208                // a full re-seed on every active historian pass.
9209                return historian_compartment_sync_busy_error(historian_phase);
9210            }
9211        }
```

and independently:

```
9319            Err(ModuleStateSyncError::HistorianBusy { phase }) => {
9320                historian_compartment_sync_busy_error(phase)
9321            }
```

The window between the read at `:9195` and the apply at `:9241` is closed by the
store's own check, which matches Part 3's
`write-predicates-are-re-evaluated-inside-the-write-transaction`. The pre-check is
an optimisation, not the guard.

**The paged path's replay memo is in memory, and the fence covers it.**

```
8735            if let Some(completed) = seeds
...
8739                .filter(|completed| completed.seed_id == seed_id)
8740            {
8741                if completed.final_digest == digest {
8742                    return PreparedOutcome::Response(completed.result.clone());
8743                }
```

with a digest-mismatch rejection at `:8744-8748`. The memo does not survive a
restart, but `expected_shadow_seq` does, so a post-restart repeat is rejected
rather than double-applied. That is the same division of labour as the capability
flag, except in that case the in-memory piece is a cached *response* whose loss is
harmless, while the capability flag is *state* whose loss changes behaviour.

## Failure scenario

1. A `state_sync` arrives with `note_evaluation_available: true` and the correct
   `expected_shadow_seq`.
2. `:9241` commits. The store advances the shadow sequence.
3. The response is lost, or the task is cancelled, or the process is killed between
   `:9241` and `:9288`.
4. If the process survived, `:9288-9291` may or may not have run depending on where
   the interruption landed. If the process died, it certainly did not.
5. The sender retries the identical wire. `:9241` returns `AuthoritySeqMismatch`.
   `:9316-9318` returns the mismatch error. The `Ok` arm is not entered, so
   `set_note_evaluation_capability` is not called.
6. The durable state says a note evaluator is available for the project. The
   in-memory capability flag says it is not.
7. Conditioned notes are refused for the remainder of the process lifetime, by
   `refuse_conditioned_note_without_evaluator` (in the `:15246-15445` group, 4d's
   range), unless some later request re-sets the flag.

Step 7 is where the record's confidence is limited, and it is why the record is
`medium` rather than `high`.

## Timing windows and dependencies

The window is `:9241` to `:9291`. It is narrow, so a kill landing inside it is
unlikely; the reachable trigger is the lost-response-then-retry path, where the
window is effectively the whole response round trip.

The inline test module has a seam for exactly this kind of interleaving:

```
9232        #[cfg(test)]
9233        if let Some(hook) = self
9234            .state_sync_before_apply_hook
9235            .lock()
...
9239            hook();
9240        }
```

That hook fires *before* the apply at `:9241`, so it can create a competing
committer but cannot by itself interrupt between the apply and the capability set.
A test would need a different seam or a cancellation.

Dependency, and the reason for medium confidence: whether a later `state_sync` in
the same session re-sends `note_evaluation_available`. If the sender includes the
field on every request, the flag self-heals on the next pass and this reduces to a
transient window. If it only sends the field on a full seed, the divergence persists.

## What a test must construct

- A route bound to a project, and a `state_sync` wire with
  `note_evaluation_available: true` and a correct `expected_shadow_seq`.
- A way to prevent `:9288-9291` from running after `:9241` commits. Task
  cancellation at the dispatch layer is the most faithful construction; a
  test-only seam between the two lines would be more direct but does not exist
  today.
- Then a redelivery of the identical wire, and an assertion that the capability
  flag matches the durable state.
- Oracle: compare the in-memory capability for the project against the durable
  state's view of evaluator availability. Because the flag is in-memory,
  `has_live_note_evaluator` in the `:3828-3976` group is the natural reader.
- Coverage form, per METHOD.md: do not assert the divergence. Assert the
  independent preconditions, namely that `apply_authority_state_sync` committed for
  the session and that a subsequent identical delivery returned
  `state_sync_seq_mismatch`. Both are observable on a correct implementation and
  jointly establish that the `Ok` arm ran at most once for a wire that was applied.
- The bounds screen from METHOD.md's effect accounting applies cleanly here:
  acknowledged applies is at most one, attempted is two, and the capability set
  count must equal the applied count. That equality is the crisp property.

## Investigation log

### Q: Does the sender re-send `note_evaluation_available` on every `state_sync`?

- Sources examined: `:9133` where the field is read with `unwrap_or(false)`, which
  means an absent field is treated as "no evaluator" rather than "unchanged"; the
  wire type `ModuleStateSyncWire` at `:681-751` per the region map; the presence
  flags the handler maintains for *other* optional fields, namely
  `user_profile_present` at `:9134`, `workspace_present` at `:9136`, and
  `todo_synthetic_anchor_present` at `:9173`.
- Findings: this is the most informative thing I found. Three other optional fields
  each carry an explicit `_present` companion so the store can distinguish "absent,
  leave alone" from "present and empty, clear it". `note_evaluation_available` has no
  such companion and collapses absence into `false` at `:9133`. That asymmetry
  suggests the field is expected on every request, since otherwise an omission would
  silently clear the capability. If it is indeed sent every time, the flag self-heals
  on the next `state_sync` and this record's impact is bounded to the interval
  between two syncs.
- Missing evidence: the sender itself.
- Conclusion: unresolved, needs the TypeScript state-sync sender. Leaning toward
  self-healing on the strength of the `unwrap_or(false)` asymmetry, but that is an
  inference about the sender from the receiver's defaulting, not evidence. Recorded
  as the reason confidence is medium.

### Q: Is the capability flag durable anywhere?

- Sources examined: `:9288-9291` for the call; the region-map description of the
  `:3828-3976` group, which lists "capability set/clear, expiry purge, per-channel
  removal, `has_live_note_evaluator`, `live_note_evaluator_policy`"; the
  `McHandler` field set at `:2873-2960`; the store request struct at `:9241-9285`,
  which has no capability field.
- Findings: the store request carries no note-evaluation capability, so the durable
  transaction genuinely does not include it. The registry is a handler field, hence
  in-memory and process-lifetime scoped.
- Missing evidence: none for this question.
- Conclusion: resolved with answer. The flag is in-memory only, so the two effects
  are in different durability classes and cannot be made atomic without moving one.

### Q: Is the historian pre-check at `:9195` a TOCTOU defect?

- Sources examined: `:9194-9211` for the pre-check, `:9319-9321` for the store's
  own rejection, Part 3's
  `write-predicates-are-re-evaluated-inside-the-write-transaction`.
- Findings: the store re-evaluates the predicate inside its transaction and returns
  a typed error the handler already maps. So the pre-check is redundant for safety
  and useful only for avoiding wasted work.
- Missing evidence: none.
- Conclusion: resolved with answer, negatively. Not a defect. Recorded as a positive
  observation (O10 in the lens) so the portfolio is not exclusively defects.
