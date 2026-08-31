# h4c-no-handler-in-scope-uses-the-claim-intent-ledger

## Discovery trigger

The lens task asked directly: Part 3 cataloged a claim intent ledger keyed by
producer and operation key, so check whether these handlers use it. They do not,
and the reason is structural rather than accidental: the ledger's handlers sit
above this sub-part's line ceiling. Recording the answer as a reachability record
rather than burying it in prose, because it is the premise every other record in
this lens rests on.

References are to `crates/mc-module/src/lib.rs` unless stated. Verified at `HEAD`
`b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The search.** Grepping the whole 30,517-line file for `claim_intent`,
`operation_key`, and `producer_id` returns matches below line 16001 only at these
lines, all inside the dispatch table or the three handlers:

```
10048            "claim.intent.stage" => self.handle_claim_intent_stage(channel, &request),
10049            "claim.intent.inspect" => self.handle_claim_intent_inspect(channel, &request),
10050            "claim.intent.ack" => self.handle_claim_intent_ack(channel, &request),
```

and the handlers themselves at `:10082` (`handle_claim_intent_stage`), `:10115`
(`handle_claim_intent_inspect`), and `:10153` (`handle_claim_intent_ack`), which
delegate to `memory_tool::stage_claim_intent` at `:10100`,
`memory_tool::inspect_claim_intents` at `:10138`, and
`memory_tool::acknowledge_claim_intent` at `:10169`.

**Why that is outside this lens.** Sub-part 4c's five ranges are `139-3105`,
`3398-4542`, `5591-6429`, `7134-8005`, and `8007-10040`
(`docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:548-552`).
The highest is capped at 10040. The claim intent dispatch arms at `:10048-10050`
and the handlers at `:10082-10182` fall in 4d's range, which the same scope map
gives as `10042-11917` (`:569`). So the boundary is four lines above this lens's
ceiling, and the separation is by design: the scope map assigns claim intent to 4d
alongside the rest of the facade surface.

**What the ledger provides, per Part 3.** Part 3's
`intent-identity-is-producer-and-operation-key` establishes two protections:

- The key. `mc_claim_intents` declares `PRIMARY KEY (producer, operation_key)` at
  `crates/mc-store/src/lib.rs:1230`, matching `ClaimCommandIdentity`'s two fields
  at `crates/mc-core/src/claim_operation.rs:350-356`.
- The digest guard. `compute_claim_operation_request_digest(request)` is taken
  before the transaction and compared against the stored value, so a repeat
  delivery carrying a *different body* under the same key is rejected as
  `IdentityConflict` rather than served the first result
  (`crates/mc-store/src/lib.rs:11049-11051` for staging, `:11209-11211` for
  acknowledgement).

The second protection is the one no handler in this lens has.

**What each 4c handler uses instead.** Reading the identity column of this lens's
handler table back as a list:

- `command_id` alone: `session.recomp` (`:6005-6010`, read back at `:6015`),
  `agent_drops.append` (`:5783`), `dreamer.run_task` (`:9626-9631`, read back at
  `:9819`).
- `import_id` alone: `state_import` (`:5639`, preflighted at `:5678`).
- A generation or sequence fence, not an operation identity: `authority.prepare`
  `complete`/`ack`/`abort` (`:7189`, `:7217`, `:7229`), `authority.drain` non-begin
  actions (`:7355`, `:7388`), `state_sync` (`:9244-9245`).
- Content-derived only: `todo_state.set` (`owner_message_id` plus
  `sha256(normalized)` at `:5960`).
- Nothing: `session.delete` (`:6126-6161`), `session.flush` (`:5976-5993`),
  `authority.prepare` phase `begin` (`:7187`), `authority.drain` action `begin`
  (`:7345`).

None of the single-key handlers takes a request digest. `state_import` comes
closest: it computes `sha256_hex(canonical_value(&request).as_bytes())` at `:5715`
and passes it into staging at `:5725`. But that digest binds *batches to each other
within one staged attempt*, which is the staging coordinator's concern and the
sibling lens's territory; it is not compared against a durable record of a prior
completed import. The durable check is the `import_id` preflight at `:5678`, which
is key-only.

## Failure scenario

The concrete gap the ledger would close, expressed as a scenario, using
`session.recomp` because it has the cleanest replay read:

1. A caller sends `session.recomp` with `command_id = "recomp-7"` and some request
   body. It succeeds and a row is recorded at `:6114`.
2. A second request arrives with the same `command_id = "recomp-7"` but a different
   body, whether from a buggy sender, a retry that regenerated its payload, or a
   confused-deputy situation.
3. `:6015` finds the row and returns `{ok: true, disposition: <recorded>}`.

The second caller is told its operation succeeded. Its actual request was never
examined and never applied. With a request digest the store would have returned an
identity conflict, as `crates/mc-store/src/lib.rs:11049-11051` does for claim
intents.

The same shape applies to `agent_drops.append`, whose duplicate verdict at
`:5875-5877` is likewise key-only, and to `dreamer.run_task`, whose replay at
`:9819-9820` returns the recorded response without comparing the current request
against what produced it.

Whether this is a live risk depends on who mints these ids. If each `command_id`
is derived from the request content by a trusted sender, key collision with a
differing body cannot occur. Nothing in the handlers enforces that, and
`command_id` is validated only for length: 1..=128 bytes for recomp (`:6008`),
1..=256 for the dreamer (`:9629`).

## Timing windows and dependencies

No timing angle. This is a structural absence.

Dependency: the id-minting discipline of the senders, which are outside the Rust
crates. That is the pivot for severity, and it is the record's open question.

Dependency: 4d's account of the claim intent handlers, which owns whether the
ledger *should* be extended to the request path or is deliberately confined to
claim operations.

## What a test must construct

This is a `reachability` record with `unreachable` semantics, so the check is
structural rather than behavioural.

- The `unreachable` assertion is that no execution of a handler in
  `lib.rs:139-10040` enters `memory_tool::stage_claim_intent`,
  `inspect_claim_intents`, or `acknowledge_claim_intent`. METHOD.md reserves
  `unreachable` for a code location that must not execute, which is exactly this
  shape: three named functions, three call sites, and a claim that none is reached
  from a bounded set of entry points.
- The cheap mechanical form is a call-graph or coverage assertion rather than a
  runtime test: instrument the three `memory_tool` entry points and drive every
  method arm in this lens's scope, then assert zero hits. Marker names must be
  constant and globally unique per METHOD.md, so three fixed markers, one per
  function.
- The *useful* companion test, which is a different property, is the digest gap:
  send two requests with an identical `command_id` and different bodies to
  `session.recomp`, and assert the second is rejected rather than replayed. That
  test fails on the current code, so it belongs to a new record if a reviewer wants
  the gap tracked as a defect rather than as context. I have deliberately not
  promoted it here, because this record's job is to establish the premise, and
  promoting it would assert a defect whose severity I cannot establish without the
  senders.

## Investigation log

### Q: Are the claim intent handlers genuinely outside 4c, or did I misread the scope?

- Sources examined: `docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:546-552`
  for 4c's five ranges; `:566-573` for 4d's; the dispatch arms at `:10048-10050` and
  the handlers at `:10082-10182`.
- Findings: 4c's last range ends at 10040. `handle_facade_value`, the facade dispatch
  entry, is at `:10042-10060` per the region map, and 4d's range starts at 10042. The
  claim intent arms are inside `handle_facade_value`'s dispatch at `:10048-10050`. So
  the split is clean and intentional, with the boundary falling between
  `handle_dreamer_run_task`'s closing brace at `:10040` and the facade entry at
  `:10042`.
- Missing evidence: none.
- Conclusion: resolved with answer. Outside 4c, inside 4d, by one line of separation.
  The scope map also records that Part 3 already owns the claim-*mirror* receipt
  semantics and that 4d must not re-derive them (`:667`), so the claim surface is
  triple-partitioned across Part 3, 4c, and 4d. This record marks 4c's edge of that
  partition.

### Q: Does `state_import`'s request digest amount to the same protection?

- Sources examined: `:5715` where the digest is computed over
  `canonical_value(&request)`; `:5725` where it is passed to `stage`; `:5678` for the
  durable preflight; the coordinator's digest-mismatch error code
  `state_import_digest_mismatch` at `:1486`.
- Findings: the digest is real and it is compared, but the comparison is against
  other batches in the same in-memory staged attempt, which is what
  `state_import_digest_mismatch` at `:1486` reports. The durable duplicate check at
  `:5678` takes `(session_id, import_id)` and no digest. So a resend of a *completed*
  import under the same `import_id` with different compartments would hit the
  preflight and be reported as a duplicate without its body being examined.
- Missing evidence: `preflight_state_import`'s body, which is Part 3's scope.
- Conclusion: unresolved on the store side, resolved on the module side. The module
  passes no digest to the durable duplicate check, so the module cannot be relying on
  one. Whether the store stores and compares a digest of its own is Part 3's to say.
  This is the closest any 4c handler comes to the ledger's second protection, and it
  still is not it.

### Q: Should the request-path handlers adopt the ledger?

- Sources examined: the ledger's key and digest guard per Part 3's evidence file;
  the eleven durable handlers in this lens; the observation that request bodies here
  are host-generated while claim operations originate from model-facing tool calls.
- Findings: there is a coherent argument for the status quo. Claim intents come from
  a language model's tool arguments, which is the highest-distrust input in the
  crate, and a request digest is proportionate there. The 4c request path is driven
  by the TypeScript host, a trusted component that presumably mints ids
  deterministically. If that holds, per-handler key-only identity is adequate.
- Missing evidence: whether the host mints ids deterministically from content, and
  whether any 4c method is reachable from a less-trusted origin. `handle_authority_drain_value`
  (`:7320`) and `handle_authority_seed_value` (`:7267`) are notable here because
  neither takes a `channel` parameter, so neither is gated on a route binding at all,
  unlike every other durable handler in this lens.
- Conclusion: needs human input. The trust-boundary question is the deciding factor
  and it is a design judgement, not a code fact.
