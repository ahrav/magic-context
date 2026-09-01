# intent-control-transition-write-is-silently-dropped

## Discovery trigger

`set_claim_intent_transition_tx` takes a parameter named
`database_incarnation_id`, guards it with `is_lower_hex(_, 32)`, and returns
`Ok(())` without writing when the guard fails. Every one of its four call sites
passes `context_store_uuid`, and a comment ninety lines earlier in the same file
states that those two identities are minted independently.

## Evidence trail

**The silent return.**

```
4118 fn set_claim_intent_transition_tx(
4119     tx: &rusqlite::Transaction<'_>,
4120     database_incarnation_id: &str,
4121     authority_generation: u64,
4122     transition_state: &str,
4123 ) -> rusqlite::Result<()> {
4124     if !is_lower_hex(database_incarnation_id, 32) {
4125         return Ok(());
4126     }
4127     tx.execute("INSERT INTO mc_claim_intent_controls( ... ) VALUES (1, ?1, ?2, ?3, ?4)
4132                 ON CONFLICT(id) DO UPDATE SET ...", ...)?;
4144     Ok(())
4145 }
```

(`crates/mc-store/src/lib.rs:4118-4145`.) The early return is indistinguishable
from success at every call site, all of which use `?` and discard the unit value.

**The guard's exact requirement.**

```
173 pub fn is_lower_hex(text: &str, expected_len: usize) -> bool {
174     text.len() == expected_len
175         && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
176 }
```

(`crates/mc-core/src/claim_operation.rs:173-178`.) Exactly 32 bytes, each in
`[0-9a-f]`. A dashed UUID is 36 bytes and contains `-`, so it fails on both counts.

**All four call sites pass the wrong identity.**

| Line | Caller | State written |
| --- | --- | --- |
| `lib.rs:11434-11440` | `authority_begin_prepare` | `resetting` |
| `lib.rs:11640-11651` | `authority_finish_prepare` | `accepting` if the row reached `MODULE`, else `resetting` |
| `lib.rs:11738-11744` | `authority_begin_drain`, takeover or resume arm | `draining` |
| `lib.rs:11790-11796` | `authority_begin_drain`, fresh-drain arm | `draining` |

Each passes `context_store_uuid`, the first parameter of its enclosing method.

**The same file says the two identities differ.** In
`claim_intent_stage_fence`:

```
4062 // Resolve the authority from the bound route, never from the caller-supplied
4063 // binding. `mc_authority` is keyed by `context_store_uuid`, which the host mints
4064 // independently of the format marker's `database_incarnation_id`, so keying this
4065 // lookup by the binding identity matches no row and fails open.
```

(`lib.rs:4062-4065`.) So the codebase has already reasoned about exactly this
confusion, in the opposite direction, and documented the hazard.

**The test suite states the production shape.**

```
11 /// Deliberately not `INCARNATION`. Production mints the context store UUID
12 /// (`randomUUID()`) separately from the format marker's 32-hex database
13 /// incarnation, so a fixture that reuses one value for both cannot observe a
14 /// fence that keys `mc_authority` by the wrong identifier.
15 const STORE_UUID: &str = "6f1d0c4a-6f2b-4b7a-9c3d-2e5f8a1b4c7d";
```

(`crates/mc-store/tests/claim_intent_ledger.rs:11-15`.) Thirty-six characters with
dashes. Under this fixture — chosen deliberately to match production — all four
call sites write nothing.

**The tests confirm the consequence without naming it.**
`tests/claim_intent_ledger.rs:169-228` drives `authority_begin_prepare`, then
asserts staging is refused with `ClaimIntentAuthorityFrozen { state: "PREPARING" }`
(`:180-183`), and the comment at `:178-179` says why: "PREPARING is not MODULE, so
the route-resolved fence refuses the stage on the authority row itself rather than
relying on the transition-control row." Likewise at `:205-214` the drain refusal
reports `"DRAINING"`, the `mc_authority` state, not `"draining"`, the control
state. The only test that ever sees a control state is `:315-324`, which reports
`"resetting"` and follows an explicit `begin_claim_store_rebuild` call at `:313`.

**Schema note.** The column is declared
`database_incarnation_id TEXT NOT NULL CHECK (length(database_incarnation_id) = 32)`
(`lib.rs:1240-1244`). So even if the Rust guard were removed, inserting a 36-char
UUID would fail the CHECK and surface as a SQLite error rather than a silent
no-op — which is arguably the behaviour the guard is suppressing.

## Failure scenario

The ledger itself is unharmed, because its fence does not depend on the control
row. `claim_intent_stage_fence` resolves the live authority from the bound route
and refuses anything not in `MODULE` (`lib.rs:4066-4073`), so drains and prepares
still freeze staging correctly.

The damage lands entirely on the mirror. Three of the four control-row readers are
in `claim_mirror.rs`, and with the row permanently absent:

- `replace_claim_mirror_snapshot` returns `ResetRequired` for any non-identical
  snapshot (`claim_mirror.rs:806-808`).
- `delete_claim_mirror` always returns `ResetRequired` (`:1145`).
- `apply_claim_mirror_receipt` skips its `accepting` gate entirely (`:908-919`).

Together those are `mirror-reset-cycle-requires-a-rebuild-grant` and
`mirror-accepting-gate-is-skipped-when-control-is-absent`.

The trap is that fixing the guard alone makes things worse. If
`set_claim_intent_transition_tx` began writing, the row's incarnation column would
hold a `context_store_uuid`, and both
`replace_claim_mirror_snapshot:778-785` and
`apply_claim_mirror_receipt:909-915` compare that column for equality against the
real `database_incarnation_id`. Every receipt would then fail
`IncarnationMismatch`, turning a latent gap into a total claim-lane outage. The fix
has to address the argument, not the guard.

## Timing windows and dependencies

- No timing window. An unconditional early return.
- Depends on nothing; depended on by
  `mirror-reset-cycle-requires-a-rebuild-grant` and
  `mirror-accepting-gate-is-skipped-when-control-is-absent`.
- The ledger's own drain fence is independent of this record
  (`lib.rs:4066-4073`), which is why the defect has stayed invisible.

## What a test must construct

1. The direct assertion. Call `authority_begin_prepare` on the `memories` domain
   with a dashed `context_store_uuid`, then read `mc_claim_intent_controls`. Assert
   a row exists with `transition_state = 'resetting'`. On the current tree this
   fails, and the failure is the finding.
2. Repeat for `authority_finish_prepare` reaching `MODULE`, asserting `accepting`,
   and for both `authority_begin_drain` arms, asserting `draining`. Four separate
   assertions, because the four call sites are independent.
3. Positive control. Call the same methods with a `context_store_uuid` that happens
   to be 32 lowercase hex and assert the row appears. That isolates the guard as the
   cause rather than some other missing wiring.
4. The consequence, end to end. With a dashed UUID, drive the authority to
   `DRAINING`, then apply a valid `claim.mirror.apply` receipt and observe it
   succeeds, proving the mirror is not fenced by the drain.
5. The trap. With a 32-hex `context_store_uuid` that differs from the mirror's
   `database_incarnation_id`, apply a receipt and assert `IncarnationMismatch`. This
   documents why fixing the guard alone is not the fix.
6. Do not assert the defect and its absence in the same marker. Assert the
   preconditions — a `memories` authority transition ran, and the supplied identity
   was not 32-hex — and assert the resulting row state separately.

## Investigation log

### Q: Is the early return a deliberate contract or an unnoticed mismatch?

- Sources examined: `lib.rs:4118-4126` (the guard), `:4062-4065` (the comment
  distinguishing the two identities), all four call sites at `:11436`, `:11642`,
  `:11740`, `:11792`, the schema CHECK at `:1240-1244`, and
  `tests/claim_intent_ledger.rs:11-15`.
- Findings: the evidence points both ways and I will not resolve it. For
  deliberate: a guard that silently succeeds reads like "callers may pass an
  identity that is not an incarnation, ignore those", and the schema CHECK means a
  non-hex value could not be stored anyway, so returning `Ok(())` avoids a SQLite
  error on every authority transition. For unnoticed: the parameter is named
  `database_incarnation_id`, all four callers pass something the same file says is a
  different identity, and the four `transition_state` values the callers carefully
  compute (`resetting`, `accepting`, `draining`, and the `MODULE` conditional at
  `:11645-11649`) are all discarded. Nobody writes a conditional to choose between
  two states that are then thrown away on purpose.
- Missing evidence: a commit message or design note for
  `set_claim_intent_transition_tx`. Not retrievable within this pass's scope.
- Conclusion: needs human input.

### Q: Does the ledger lose its drain fence because of this?

- Sources examined: `lib.rs:4047-4091` (the whole fence), `:4052-4061` (the control
  read, fail-open on absence), `:4066-4073` (the authority read, fail-closed on a
  missing row via `RouteNotManaged` and on a non-`MODULE` state via `Frozen`),
  `tests/claim_intent_ledger.rs:169-228` and `:346-401`.
- Findings: no. The authority read is the load-bearing half and it does not consult
  the control row. Both tests assert the refusal reports the `mc_authority` state,
  and the comment at `:178-179` says the fence deliberately works this way. The
  control read is a second, currently inert, layer.
- Missing evidence: none.
- Conclusion: resolved with answer — the ledger fence is intact; the loss is
  confined to the mirror's three readers.
