# intent-identity-is-producer-and-operation-key

## Discovery trigger

`mc_claim_intents` declares `PRIMARY KEY (producer, operation_key)`
(`crates/mc-store/src/lib.rs:1230`) yet carries five more identity-bearing
columns: `database_incarnation_id`, `format_epoch`, `authority_project`,
`authority_generation`, and `request_digest`. Whatever is *not* in the key must be
verified some other way, or a retry could be served another request's result.

## Evidence trail

**The key.** `(producer, operation_key)` at `lib.rs:1230`, matching
`ClaimCommandIdentity`'s two fields exactly
(`crates/mc-core/src/claim_operation.rs:350-356`). Every lookup uses that pair and
nothing else: staging (`lib.rs:11038-11047`), inspection (`:11127-11135`),
acknowledgement (`:11196-11208`), and both post-mutation re-reads (`:11105-11112`,
`:11269-11276`).

**The digest guard.** `compute_claim_operation_request_digest(request)` is taken
before the transaction (`lib.rs:11032-11033`) and compared against the stored
value:

- Staging: `if record.request_digest != request_digest { return
  Ok(ClaimIntentTxnOutcome::IdentityConflict); }` (`lib.rs:11049-11051`).
- Acknowledgement: same check at `:11209-11211`, and the digest is separately
  required to be 64 lowercase hex before the transaction opens (`:11175-11179`).

`IdentityConflict` surfaces as
`McStoreError::ClaimIntentIdentityConflict { producer, operation_key }`
(`lib.rs:3894-3897`). The column is `CHECK (length(request_digest) = 64)`
(`:1223`), so a truncated digest cannot be stored and later compare equal.

**The binding guard.** `require_claim_intent_binding` compares four fields, each by
value, and reports the first mismatch:

```
3855 for (field, expected, found) in [
3856     ("database incarnation", stored...database_incarnation_id.clone(), binding...clone()),
3861     ("format epoch", stored...format_epoch.to_string(), binding.format_epoch.to_string()),
3866     ("authority project", ...),
3871     ("authority generation", ...),
3876 ] {
3877     if expected != found { return Err(McStoreError::ClaimIntentBindingMismatch { field, expected, found }); }
```

(`lib.rs:3851-3886`.) Called from staging at `:11052-11063` and from
acknowledgement at `:11212-11223`, in both cases before any mutation.

**Field validation runs before anything else.**
`validate_claim_intent_fields` (`lib.rs:3816-3849`) is the first statement of both
public methods (`:11031`, `:11174`). It requires 32-hex incarnation
(`:3820-3824`), positive `format_epoch` (`:3825-3829`), nonempty
`authority_project` (`:3830-3834`), an `authority_generation` that fits `i64`
(`:3835-3837`), and `producer` and `operation_key` each 1..=256 bytes
(`:3838-3847`). Those last two are the only constraints on the key's own
components, and they are length-only. The schema mirrors them
(`lib.rs:1216-1217`).

**Ordering matters and is consistent.** In both methods the digest check precedes
the binding check, so a request that differs in both reports
`IdentityConflict`. Both precede the state machine, so a stale-identity request can
never reach the `UPDATE` at `:11256-11268`.

**A binding field is not part of the key, deliberately.** The doc comment on
`ClaimIntentBinding` calls it "Context database and authority fence captured when
a command is staged" (`mc-core/src/claim_operation.rs:358-360`), so it records the
world as of staging rather than identifying the command. That is why a replay
presents the *stored* binding and is still refused when the live authority has
moved on — the separate live-fence check at `lib.rs:11071-11077`, which is
`intent-staged-replay-produces-one-context-effect`.

**Test coverage.** `tests/claim_intent_ledger.rs:133-166` stages an intent, closes
and reopens the store, and confirms the row survives with its digest and `staged`
state intact (`:148-151`). It then re-stages with a changed
`database_incarnation_id` and asserts
`ClaimIntentBindingMismatch { field: "database incarnation", .. }` (`:153-161`),
and re-stages with a different request body under the correct binding and asserts
`ClaimIntentIdentityConflict` (`:162-165`). The other three binding fields and the
two-producers case are uncovered.

**Reachability.** `stage_claim_intent` and `acknowledge_claim_intent` are public
`McStore` methods driven by the module facade. Both are exercised from production
paths in `mc-module`; the `mc-store` tests reach them directly. Nothing about the
identity checks is gated on configuration.

## Failure scenario

A producer reuses `operation_key = "update:42"` for a genuinely different request —
different content, different target claim. Without the digest guard, staging would
find the existing row and return `replayed: true` with the *earlier* request's
`result_json` once it settled (`lib.rs:11078-11081`). The caller would receive a
committed result for an operation it never asked for and would have no way to tell.
That is a wrong-answer failure, not a lost-work failure, and it is silent on both
sides.

The binding guard covers a different shape: the same logical command replayed
against a database that has been rebuilt under a new `database_incarnation_id`, or
against a different `authority_project`. Serving the stored result there would
return a result computed against state that no longer exists.

Because `producer` is validated only for length (`lib.rs:3838-3847`, `:1216`), the
namespace is only as trustworthy as whatever authenticates the caller. Two
components that both call themselves `mc-module` share one key space and can
collide on `operation_key`; the collision is reported as `IdentityConflict`, which
is safe but indistinguishable from a genuine key reuse by one producer.

## Timing windows and dependencies

- No interleaving window for the identity checks themselves; they are
  admission-time comparisons inside the same `with_conn_fenced` transaction as the
  lookup (`lib.rs:11037`, `:11195`).
- Depends on `compute_claim_operation_request_digest` being deterministic and
  canonical over the request value, or an identical retry would be misreported as a
  conflict.
- Independent of the live-authority fence, which is a separate check at
  `lib.rs:11071-11077` and only applies to `staged` rows.

## What a test must construct

1. Stage an intent. Re-stage the same `(producer, operation_key)` with a different
   request body; assert `ClaimIntentIdentityConflict { producer, operation_key }`
   with both operands correct, and assert the stored row is unchanged.
2. The three uncovered binding fields. Re-stage with an altered `format_epoch`, an
   altered `authority_project`, and an altered `authority_generation` in turn.
   Assert `ClaimIntentBindingMismatch { field, expected, found }` names the right
   field each time. Note that `authority_project` and `authority_generation` are
   also checked by the live fence (`lib.rs:4076-4089`), so the test must
   distinguish which check fired by inspecting the error variant:
   `BindingMismatch` from `require_claim_intent_binding` versus the fence's own
   `BindingMismatch`. Both produce the same variant, which is itself worth
   recording.
3. Ordering. Re-stage with both a different request body and a different
   incarnation; assert `IdentityConflict`, pinning the precedence at `:11049` over
   `:11052`.
4. Acknowledgement side. Acknowledge with a wrong digest; assert
   `IdentityConflict`. Acknowledge with a wrong binding; assert
   `BindingMismatch`. Assert the row is unchanged in both cases, which pins that
   neither reaches the `UPDATE` at `:11256-11268`.
5. Key independence. Stage the same `operation_key` under two different `producer`
   values and assert both rows exist independently, each with its own state. That
   pins the key as the pair rather than the operation key alone.
6. Boundary. `producer` and `operation_key` at 1, 256, and 257 bytes. The 257 case
   must be `ClaimIntentInvalid` from `:3842-3846` before any SQL runs, so the schema
   CHECK at `:1216-1217` is never the thing that reports it.

## Investigation log

### Q: Is `producer` authenticated above `mc-store`?

- Sources examined: `lib.rs:1216` (schema, length CHECK only), `:3838-3847`
  (validation, length only), `:11087-11104` (the insert, which stores it verbatim),
  `:11038-11047` (the lookup, which trusts it).
- Findings: within this crate `producer` is an opaque caller-supplied string and
  forms half the primary key. There is no allow-list, no prefix rule, and no
  cross-check against the route or the binding. Any caller that can reach
  `stage_claim_intent` can stage into any producer's namespace and, if it guesses an
  `operation_key` and matches the digest, read that intent's result through
  `inspect_claim_intent` (`:11121-11138`), which takes no binding at all and
  performs no authorization.
- Missing evidence: the `mc-module` claim-intent facade handler and whatever
  authenticates the `producer` field on the wire. Outside this part's scope.
- Conclusion: unresolved, needs the `mc-module` claim-intent handler.

### Q: Can two different requests produce the same digest?

- Sources examined: `lib.rs:11032-11033` (the call),
  `mc-core/src/claim_operation.rs` for `compute_claim_operation_request_digest` and
  the canonical-encoding helpers it composes (`canonical_json_encode`,
  `sha256_hex_utf8` at `:173` neighbourhood).
- Findings: the digest is SHA-256 over a canonical JSON encoding, so a collision
  requires a SHA-256 collision. The practical risk is the opposite direction: two
  *semantically identical* requests that canonicalize differently would produce
  different digests and be reported as a conflict. I did not audit
  `canonical_json_encode` for stability across float formatting or key ordering in
  this pass.
- Missing evidence: an audit of `canonical_json_encode`'s determinism, which
  belongs to a lens on the canonical-encoding contract rather than this one.
- Conclusion: unresolved, needs a canonical-encoding audit.
