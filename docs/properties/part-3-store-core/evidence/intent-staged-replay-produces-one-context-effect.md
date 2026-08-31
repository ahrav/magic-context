# intent-staged-replay-produces-one-context-effect

## Discovery trigger

The comment justifying the replay fence states plainly what a replay does:

```
11064 // A staged replay goes on to execute the context mutation, so it has to
11065 // clear the same live fence as a fresh stage.
```

(`crates/mc-store/src/lib.rs:11064-11065`.) So `stage_claim_intent` returning
`replayed: true` on a `staged` row is not a terminal answer — the caller proceeds to
mutate `context.db` again. The intent ledger deliberately does not decide whether
that second mutation is a second effect.

## Evidence trail

**Three separate durable steps, in two databases.**

1. Stage. `stage_claim_intent` writes the `staged` row inside one
   `with_conn_fenced` IMMEDIATE transaction against `mc_cache`
   (`lib.rs:11037`, insert at `:11087-11104`,
   `../commons/crates/cortexkit-store/src/lib.rs:185-192`).
2. Mutate. The caller applies the claim to `context.db`. Nothing in `mc-store`
   performs or observes this step; the intent's `result_json` is supplied to the
   store afterwards, not produced by it.
3. Acknowledge. `acknowledge_claim_intent` records `context-committed` in a
   *different* transaction (`lib.rs:11195`, update at `:11256-11268`).

Steps 1 and 3 are separately durable, and step 2 is in another store, so no
transaction spans the pair.

**Two crash windows, only the second dangerous.**

- Crash between 1 and 2: the row stays `staged`. Replay re-runs the mutation, which
  had never run. Correct.
- Crash between 2 and 3: the row also stays `staged`, because step 3 is what moves
  it. Replay re-runs the mutation, which *has* already run. The store cannot tell
  the two windows apart, because `staged` is the only state either leaves behind
  and the schema forbids a `staged` row from carrying a result
  (`lib.rs:1231-1234`).

**The replay path.** On an existing row, staging checks the digest (`:11049-11051`)
and the binding (`:11052-11063`), then re-runs the live fence for `staged` rows
only:

```
11071 if record.state == ClaimIntentState::Staged {
11072     if let Some(rejection) = claim_intent_stage_fence(tx, route_project_root, binding)? {
11075         return Ok(rejection);
11076     }
11077 }
11078 return Ok(ClaimIntentTxnOutcome::Applied(ClaimIntentMutationOutcome { record, replayed: true }));
```

(`lib.rs:11071-11081`.) The comment at `:11066-11070` explains the asymmetry:
"Terminal and already-committed records are recovery reads and stay idempotent so a
crashed attempt can still be resolved." So a replay of a `context-committed`,
`acknowledged`, or `terminal-rejected` row returns the stored record without
re-running anything, and only a `staged` replay is licensed to mutate again.

**What the fence does and does not protect.** `claim_intent_stage_fence`
(`lib.rs:4047-4091`) refuses a replay when the world has moved: a non-`accepting`
control row (`:4059-4061`, inert in production per
`intent-control-transition-write-is-silently-dropped`), a route with no authority
row (`:4066-4070`), a non-`MODULE` authority state (`:4071-4073`), a project
mismatch (`:4076-4082`), or a generation mismatch (`:4083-4089`). It stops a replay
committing under an obsolete generation. It does not and cannot stop a replay
re-applying an effect while the authority is still legitimately `MODULE` at the same
generation, which is exactly the second crash window.

**Idempotence must therefore come from the context mutation.** The intent's identity
is `(producer, operation_key)` (`lib.rs:1230`), and that pair plus the request
digest is what a mutation would have to key on to be a no-op on re-execution. The
result vocabulary anticipates this: `ClaimResultOutcome::Noop` is an accepted
`ContextCommitted` outcome alongside `Applied` (`lib.rs:3939-3949`), which reads as
provision for a re-executed mutation reporting that it had nothing to do. That is
suggestive, not proof, and the mutation itself is outside this part.

**Test coverage.** `tests/claim_intent_ledger.rs:346-401` constructs the first
window explicitly — the comment at `:369-370` says the staged row is left "as a
crash before the context commit would" — then begins a drain and asserts the replay
is refused with `ClaimIntentAuthorityFrozen { state: "DRAINING" }` (`:384-387`),
and finally settles the row as `terminal-rejected` (`:390-400`). That covers the
fence. Nothing covers effect counting, because nothing in this crate can observe a
`context.db` effect.

**Reachability.** `stage_claim_intent` is a public `McStore` method driven by the
module facade, and the replay branch at `:11048` is on the unconditional path for
any repeated identity. No configuration gates it.

## Failure scenario

1. A route is at `MODULE` authority, generation 12.
2. The host stages intent `("mc-module", "update:42")`. The row is durable as
   `staged`.
3. The host applies the mutation to `context.db`. The claim effect is durable.
4. The process dies before `acknowledge_claim_intent(ContextCommitted)`.
5. On restart the host replays the same stage. Digest and binding match. The
   authority is still `MODULE` at generation 12, so the fence passes at
   `lib.rs:11071-11077`. The call returns `replayed: true`.
6. The host, following the contract in the comment at `:11064-11065`, applies the
   mutation again.

If the mutation is keyed by `(producer, operation_key)` it is a no-op and reports
`Noop`. If it is not, the claim is applied twice. The ledger records exactly one
intent either way, so the duplication is invisible from the store side. The mirror
then faithfully projects whatever the authority holds, including a duplicate, and
none of the mirror's admission checks can help: `mirror-project-effect-chain-detects-omission`
catches gaps in the *source's* stream, not duplicates the source genuinely produced.

The revision guards in the mirror partly mask this: a second application producing
the same revision under a different locator is refused at
`claim_mirror.rs:1038-1043`, and a regressed revision at `:1028-1033`. But a second
application producing a *new* revision — the normal outcome of re-running an update —
is a legitimate-looking new effect.

## Timing windows and dependencies

- Window A: stage commit to context-mutation commit. Recovery by replay is correct.
- Window B: context-mutation commit to acknowledgement commit. Recovery by replay is
  correct only if the mutation is idempotent under the intent identity. This is the
  whole record.
- Both windows are unbounded in duration; the `staged` row is durable and survives
  restart, which `tests/claim_intent_ledger.rs:133-166` demonstrates at `:148-151`.
- Depends on `intent-identity-is-producer-and-operation-key` for the identity the
  mutation would key on.
- Depends on `intent-terminal-state-is-entered-at-most-once` for the guarantee that
  the acknowledgement, once it lands, cannot be undone.
- Not closable inside `mc-store` alone. Closing window B needs either a
  cross-database transaction, which SQLite in two files cannot give, or an
  intermediate durable state recording that the mutation was attempted.

## What a test must construct

The oracle must be per-identity. Aggregate effect counts cancel inside a
one-to-one contract, so a total that happens to match proves nothing.

1. Bring a route to `MODULE` authority. Stage intent `I`.
2. Apply the context mutation for `I` through whatever production path performs it.
3. Kill the process before acknowledging. Restart.
4. Replay the stage for `I`. Assert `replayed == true` and that the row is still
   `staged`.
5. Apply the context mutation for `I` a second time, as the contract instructs.
6. Primary oracle: for the claim `I` targets, assert the durable effect set equals
   the effect set implied by applying `I` exactly once. Take that expectation from
   `I`'s own `result_json` effect list once it settles, not from a recount of the
   store, so the oracle is independent of the thing under test.
7. Cheap screen, stated as bounds: let `attempted` be the number of stage calls that
   passed the fence and `acknowledged` be the number of intents that reached
   `context-committed`. Assert observed effects for `I` are at least `acknowledged`
   and at most `attempted`. On the happy path both are 1; in this scenario
   `attempted` is 2 and `acknowledged` is 1, so the bound is `1..=2` and only the
   per-identity oracle in step 6 can distinguish.
8. Window A control. Kill the process between step 1 and step 2, replay, and assert
   exactly one effect. This must pass regardless of mutation idempotence, so it
   isolates window B as the interesting case.
9. Fence control, already covered by `tests/claim_intent_ledger.rs:346-401`: begin a
   drain between steps 3 and 4 and assert the replay is refused rather than
   re-mutating.

## Investigation log

### Q: Is the context mutation keyed by `(producer, operation_key)` so re-execution is a no-op?

- Sources examined: `lib.rs:11064-11070` (the comment stating a replay re-executes
  the mutation), `:11071-11081` (the replay branch), `:3939-3949`
  (`ClaimResultOutcome::Noop` accepted for `ContextCommitted`), `:1230` (the intent
  key). Searched `mc-store` for any write to a claim effect and found none: this
  crate stores intents and mirrors, never claims themselves.
- Findings: the store deliberately delegates the decision and the result vocabulary
  leaves room for a no-op re-execution, but the mutation lives in `context.db`
  behind the host and is not in this part's scope. I could not confirm or refute
  idempotence.
- Missing evidence: the host's claim-apply path and whether it dedups on the
  operation key.
- Conclusion: needs human input.

### Q: Could the ledger close window B on its own?

- Sources examined: `lib.rs:1224-1226` (the four states), `:1231-1234` (the
  result_json CHECK), `:11225-11255` (the transition table), `:11087-11104` (the
  insert).
- Findings: not with the current state set. Closing window B requires a state
  meaning "mutation attempted, outcome unknown", distinct from `staged`. Adding one
  would need a schema change to the state CHECK at `:1224-1226`, a relaxation of the
  `result_json` CHECK at `:1231-1234` since an attempted-but-unknown row has no
  result, and new arms in the transition table. It would also change what
  `is_unresolved` counts (`mc-core/src/claim_operation.rs:399-401`), which both reset
  gates depend on. That is a design decision with real blast radius, not a local fix.
- Missing evidence: none for the mechanism; the decision itself is not mine to make.
- Conclusion: needs human input.
