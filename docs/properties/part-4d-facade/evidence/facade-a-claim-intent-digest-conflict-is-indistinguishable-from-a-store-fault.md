# facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault

## Discovery trigger

Task 3 asked what the claim intent ledger's request-digest conflict check does on
the module side. The store detects the conflict precisely and raises a dedicated
error variant carrying the producer and operation key. The module then throws that
precision away.

## Evidence trail

### The store detects it precisely

`crates/mc-store/src/lib.rs`

- `:11023-11031` — `stage_claim_intent` signature.
- `:11032-11033` — `compute_claim_operation_request_digest(request)` produces the
  digest from the request body.
- `:11037-11046` — the existing row is selected by
  `producer` and `operation_key`, which Part 3 established is the ledger identity
  (`part-3-store-core/_lenses/lens-b-claim-mirror-ledger.md:293`).
- `:11048-11051` — the conflict:

      if record.request_digest != request_digest {
          return Ok(ClaimIntentTxnOutcome::IdentityConflict);
      }

  So a reused `(producer, operation_key)` with a different request body is
  detected before any fence, any binding check, and any write.
- `:11209-11211` — `acknowledge_claim_intent` has the same check against the
  caller-supplied `request_digest`.
- `:11169-11173` — before that, the ack validates the digest's SHAPE:
  `is_lower_hex(request_digest, 64)`, else `ClaimIntentInvalid`.
- `:3888-3897` — `claim_intent_mutation_result` converts the transaction outcome:

      ClaimIntentTxnOutcome::IdentityConflict => Err(McStoreError::ClaimIntentIdentityConflict {
          producer: command.producer.clone(),
          operation_key: command.operation_key.clone(),
      }),

- `:3420-3422` — the variant carries `producer: String` and
  `operation_key: String`, so the two values a caller needs to fix its own bug
  are in the error's data.
- `:3898-3910` — the sibling outcomes get their own variants too:
  `ClaimIntentBindingMismatch { field, expected, found }`,
  `ClaimIntentAuthorityFrozen { state }`, `ClaimIntentRouteNotManaged`.

So the store distinguishes at least five failure classes on this path.

### The module collapses them

`crates/mc-module/src/lib.rs`

- `:10100-10112` — `handle_claim_intent_stage`:

      Err(error) => PreparedOutcome::Error {
          code: "claim_intent_stage_failed".to_string(),
          message: error.to_string(),
      }

  One code for every `Err`, whatever variant it was.
- `:10146-10149` — the same shape with `claim_intent_inspect_failed`.
- `:10177-10180` — the same shape with `claim_intent_ack_failed`.
- `:10103-10106`, `:10141-10144`, `:10172-10175` — a second code,
  `claim_intent_encode_failed`, for a `serde_json::to_value` failure on the
  response. So the handlers do have two codes each; the split is
  request-failed versus response-encode-failed, not conflict versus fault.

`memory_tool::MemoryToolError` (`memory_tool.rs:26-55`) wraps three cases,
`Store`, `ClaimMirror`, and `IntentProtocol`, and its `Display`
(`:33-43`) prefixes them "store: ", "claim mirror: ", and
"claim intent protocol: ". So the variant survives into the message text and
nowhere else.

### The codebase already has the pattern this handler is missing

`:13844-13857` — `claim_mirror_error` takes the store error and a fallback code
and promotes two variants:

    let code = match &error {
        mc_store::claim_mirror::ClaimMirrorError::NotSeeded => "claim_mirror_not_seeded",
        mc_store::claim_mirror::ClaimMirrorError::Invalid(_) => "invalid_params",
        _ => fallback_code,
    };

It is used at `:10295` and `:10335` for the two mirror handlers. The three
claim-intent handlers sitting 200 lines above it do not use an equivalent.

### Coverage

No inline test in `lib.rs:16001-30517` mentions `claim_intent`. The store's
conflict outcome is covered by `crates/mc-store/tests/claim_intent_ledger.rs`,
which `.github/workflows/ci.yml:171-172` does not run. Nothing anywhere asserts
what code the module returns for a conflict.

## Failure scenario

A producer reuses `(producer, operation_key)` for a genuinely different request.
This is the exact bug the ledger identity exists to catch: the same logical
command key naming two different command bodies.

1. `claim.intent.stage` returns
   `{code: "claim_intent_stage_failed", message: "store: claim intent identity conflict for producer X operation key Y"}`
   or whatever the variant's Display renders.
2. The plugin's decoder receives a typed error. `module-wire.ts` throws on
   protocol violations, and the caller sees a failed stage.
3. Nothing in the code path distinguishes this from a `SQLITE_BUSY`, a fence
   rejection, or a route that is not authority-managed, all of which also arrive
   as `claim_intent_stage_failed`.

The consequence is retry policy. A store fault is retryable and a
`RouteNotManaged` rejection may become valid after a route binds. An identity
conflict is neither: retrying with the same key and the same body will replay
(`:11052-11071` returns `replayed: true` for a matching digest), and retrying with
the same key and a different body will conflict again forever, because the ledger
is never pruned. A caller that treats `claim_intent_stage_failed` as retryable
will spin on a conflict; a caller that treats it as terminal will give up on a
transient store fault.

`claim.intent.ack` has an additional collapsed class worth naming:
`ClaimIntentTxnOutcome::NotFound` (`:11207`) and
`ClaimIntentTxnOutcome::Transition { expected, found }` (`:11238-11247`) also
arrive as `claim_intent_ack_failed`. "There is no such intent" and "the intent is
already terminal" are operationally different answers and share one code with
"the database was busy".

## Timing windows and dependencies

None. Two stages with the same identity and different bodies is enough, and the
order does not matter.

Reachability: default-production. `claim.intent.stage` is sent as a facade
envelope by `module-wire.ts:602-605` through `module-transport.ts:1026-1043`, and
the plugin's commit path invokes it from `hook.ts:938-990`. No flag gates it.

## What a test must construct

1. A bound facade route and an open store.
2. Stage an intent with body `A` under `(producer P, key K)`.
3. Stage again with body `B != A` under the same `(P, K)`.
4. Assert the second call's `PreparedOutcome::Error` code is distinct from the
   code the same handler returns for a store fault. Producing a store fault
   needs a seam; `install_store_for_test` (`:12234-12237`) installs an
   `Arc<McStore>`, so the cheapest alternative is to compare against
   `RouteNotManaged`, which is reachable by staging from a route with no
   authority binding, and against `store_unavailable_error` (`:10097-10099`),
   which is reachable by not installing a store at all.
5. Assert the conflict's code is stable, so a caller can match on it. A weaker
   but still useful assertion: the code is not the same string as the code for
   any other reachable failure on the same handler.
6. Repeat for `claim.intent.ack` covering `NotFound`, `Transition`, and
   `IdentityConflict`, which is three distinct classes behind one code today.
7. A replay control: stage twice with the SAME body and assert
   `replayed: true` in the response rather than an error, proving the test can
   tell a conflict from a replay.

## Investigation log

### Q: Should the three claim-intent handlers get a `claim_mirror_error`-style classifier?

- Sources examined: `lib.rs:13844-13857` (`claim_mirror_error`) and its two call
  sites `:10295`, `:10335`; `lib.rs:10100-10112`, `:10146-10149`, `:10177-10180`
  for the collapsed mappings; `mc-store/src/lib.rs:3419-3440` for the
  `ClaimIntent*` variant set; `memory_tool.rs:26-55` for the wrapper that stands
  between them; `mc-store/src/lib.rs:3888-3915` for the outcome-to-error mapping;
  `packages/plugin/src/hooks/magic-context/module-wire.ts:560-600` for what the
  plugin decoder does with a failed stage.
- Findings: the mechanical obstacle is `MemoryToolError`. `claim_mirror_error`
  can match on `ClaimMirrorError` because the mirror handlers call
  `store.replace_claim_mirror_snapshot` and
  `store.apply_claim_mirror_receipt` directly (`:10288`, `:10326`) and receive
  the store's own error type. The claim-intent handlers call through
  `memory_tool`, which wraps the store error in
  `MemoryToolError::Store(McStoreError)` (`memory_tool.rs:46-50`). So a
  classifier is still possible by matching
  `MemoryToolError::Store(McStoreError::ClaimIntentIdentityConflict { .. })`, but
  it requires the module to reach two levels into the wrapper, which is probably
  why it was not written.
- Missing evidence: whether the plugin would act on distinct codes. The
  `module-wire.ts` decoders throw on shape violations and I did not find a code
  discriminator on the claim-intent path, so adding codes may be a one-sided
  change until the plugin consumes them.
- Conclusion: needs human input. The classifier is implementable and the
  precedent is 200 lines away in the same file, but whether the fix is worth a
  wrapper change plus a plugin change depends on whether anyone wants to
  distinguish retryable from terminal on this path. Recording the property is
  independent of that decision.
