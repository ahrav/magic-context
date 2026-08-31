# core-intent-ack-transition-legality-gap

## Discovery trigger

`crates/mc-core/src/claim_operation.rs:425` documents `ClaimIntentAckKind` as
"One legal acknowledgement transition." The word "transition" is a relation
between two states, and the word "legal" asserts that some transitions are not.
Reading the enum immediately below (`:426-432`) shows it enumerates three
*states*, not three *edges*. That mismatch between what the comment claims and
what the type expresses is the whole of this record.

## Evidence trail

The state space:

- `crates/mc-core/src/claim_operation.rs:368-369` documents the lifecycle:
  "Durable staged-intent lifecycle. `acknowledged` is transport settlement, not a
  second semantic claim state."
- `:370-377` defines `ClaimIntentState` with four variants: `Staged`,
  `ContextCommitted`, `Acknowledged`, `TerminalRejected`. Closed enum, `Copy`, no
  `#[non_exhaustive]`.
- `:379-402` is the impl: `parse` (`:380-388`), `as_str` (`:390-397`), and
  `is_unresolved` (`:399-401`), which returns true for
  `Staged | ContextCommitted`.

That is the entire state machinery in `mc-core`. Specifically absent, verified by
reading all 878 lines of the file:

- No transition function. No `fn advance`, `fn transition`, `fn can_ack`, or
  anything of that shape.
- No transition table, no `const LEGAL: &[(State, State)]`, no match arm pairing
  a source with a target.
- No expected-current-state field on the acknowledgement request.
  `ClaimIntentAckRequest` (`:437-446`) carries `protocol_version`, `binding`,
  `command`, `request_digest`, `kind`, and `result_json`. The `request_digest`
  fences on the *request identity*, not on the intent's current state.
- `ClaimIntentWireRecord` (`:449-457`) carries `state`, so a *response* reports
  the resulting state, but nothing constrains which states could have preceded
  it.

So the representable-but-illegal set is concrete. Construct an
`ClaimIntentAckRequest` with `kind: ClaimIntentAckKind::ContextCommitted` and
send it for a command whose intent is already `Acknowledged`. Nothing in
`mc-core` rejects it. The same holds for `TerminalRejected` followed by
`Acknowledged`, and for `Acknowledged` followed by `TerminalRejected`.

What the domain plainly intends, inferred from the state names and the doc at
`:368-369`:

```
Staged ──▶ ContextCommitted ──▶ Acknowledged     (terminal)
   │              │
   └──────────────┴────────────▶ TerminalRejected (terminal)
```

`is_unresolved` (`:399-401`) corroborates it: the two states it calls unresolved
are exactly the two non-terminal ones, which means the author's model has
`Acknowledged` and `TerminalRejected` as absorbing states. But `is_unresolved` is
a predicate on one state, not a guard on a transition, so it cannot prevent a
terminal state from being left.

The `ClaimIntentAckKind` variants (`:428-431`) are `ContextCommitted`,
`Acknowledged`, `TerminalRejected`: exactly the three non-`Staged` states. So the
enum is a target-state selector, and it is complete as such. Its doc comment is
what overstates.

Related coverage found outside this lens's files, recorded as a lead only:
`crates/mc-store/tests/claim_intent_ledger.rs` exists and exercises
acknowledgements, and `crates/mc-store/src/lib.rs` consumes the enum. Whether
`mc-store` enforces edge legality, and whether the test covers illegal edges, is
the sibling lens's call and this lens does not read a conclusion into it.

## Failure scenario

The window is a lost acknowledgement response followed by a retry, which is the
exact scenario the staged-intent ledger exists to survive. The doc at
`:404` says the stage request exists "to durably stage a command before context
mutation", so the ledger's purpose is to make the
"did the context mutation happen?" question answerable after a crash or a lost
response.

Sequence: the host stages an intent (`Staged`), performs the context mutation,
and acknowledges `ContextCommitted`. The acknowledgement response is lost. The
host retries. If the retry carries the same `kind`, an idempotent
`ContextCommitted -> ContextCommitted` replay is the intended and harmless case,
and `ClaimIntentStageResponse.replayed` / `ClaimIntentAckResponse.replayed`
(`:463`, `:478`) exist to report it. But if a subsequent step has already moved
the intent to `Acknowledged`, a delayed or reordered `ContextCommitted`
acknowledgement arriving afterwards would move it backwards, and nothing in the
wire contract stops it.

The consequence is that the ledger's state stops being a reliable answer to its
own question. An intent knocked back from `Acknowledged` to `ContextCommitted`
reports itself as unresolved via `is_unresolved` (`:399-401`), so a recovery
sweep that lists unresolved intents (`ClaimIntentInspectRequest.unresolved_only`,
`:421`) picks it up and may re-drive a command whose effect already landed. An
intent that escapes `TerminalRejected` could have a rejected command re-applied.
Both are double-application of a durable effect, which is the failure class the
whole staged-intent design is built to prevent.

## Timing windows and dependencies

This is the one record in this lens with a real timing angle.

The window is concurrent or reordered acknowledgement for the same
`ClaimCommandIdentity` (`:353-356`, the `(producer, operation_key)` pair). Two
sources of concurrency: a retry racing its own original after a lost response,
and two producers acknowledging the same command identity. The `binding`
(`ClaimIntentBinding`, `:361-366`, carrying `database_incarnation_id`,
`format_epoch`, `authority_project`, `authority_generation`) fences on the
*context* and *authority*, not on the intent's own progress, so it does not close
this window either.

Dependency: enforcement must live in `mc-store`, since that is where the durable
row is. The natural mechanism is a conditional update
(`UPDATE ... WHERE state = <expected>`) whose affected-row count is the fence, or
a `CHECK` constraint over the state column, or a trigger. Which of those is in
place is the sibling lens's finding, and this record's confidence is capped at
medium for exactly that reason.

## What a test must construct

1. An intent driven to each of the four states, then an acknowledgement of each
   of the three kinds attempted from each state: twelve combinations. For each,
   record `(state_before, kind, state_after, accepted_or_rejected)`.
2. The property: every observed `(state_before, kind)` pair lies in the legal
   set, which must first be written down explicitly. A defensible legal set,
   subject to the design question below:
   `{(Staged, ContextCommitted), (Staged, TerminalRejected),
   (ContextCommitted, Acknowledged), (ContextCommitted, TerminalRejected)}`
   plus idempotent self-edges if replay is expressed that way.
3. A concurrency case: two acknowledgements for the same command identity issued
   without ordering, asserting that exactly one takes effect and the loser is
   either rejected or reported as a replay, never applied as a backwards edge.
4. A lost-response case: acknowledge, discard the response, retry with the same
   kind, then retry with a *different* kind. The second retry is the one that
   probes the gap.
5. Effect accounting under loss, per the method contract: count *attempted*
   acknowledgements and *acknowledged* ones separately, and assert observed state
   transitions are at least the acknowledged count and at most the attempted
   count. Per-identity checks are the primary oracle here, because aggregate
   counts can cancel across a one-to-one contract.

Semantics: `always(pair in legal_set)`. Not `unreachable`: the forbidden thing is
a *state pair*, and `mc-core` contains no transition function in which to place a
marker, so there is no code location that must not execute. The method contract
is explicit that a forbidden state with no dedicated detection point uses
`always(!X)`.

## Investigation log

### Q: Is transition legality enforced in `mc-store`?

- Sources examined: all of `crates/mc-core/src/claim_operation.rs`; the
  existence of `crates/mc-store/tests/claim_intent_ledger.rs` and its import of
  `mc_core::claim_operation` symbols at line 2; the reference to
  `ClaimResultOutcome` in `crates/mc-store/src/lib.rs:3943`.
- Findings: `mc-core` definitively does not enforce it. Whether `mc-store` does
  cannot be established without reading `mc-store`, which is explicitly assigned
  to a sibling lens for this part. I deliberately did not read the SQL, because
  reporting a storage-layer conclusion from this lens would duplicate or
  contradict the owning lens.
- Missing evidence: the `mc-store` claim-intent-ledger schema and update
  statements.
- Conclusion: unresolved, needs the `mc-store` claim-intent-ledger lens. Handing
  this over as a directed question rather than a guess: does the acknowledgement
  update use a conditional `WHERE state = ?` (or equivalent), and is the
  affected-row count checked?

### Q: Should the wire contract carry an expected-current-state?

- Sources examined: `crates/mc-core/src/claim_operation.rs:434-446` (the ack
  request and its doc, which constrains only when `result_json` may be present),
  `:449-457` (`ClaimIntentWireRecord`, which reports `state`), `:459-480` (the
  three response types, each carrying a `replayed` flag), `:28-31`
  (`CLAIM_INTENT_PROTOCOL_VERSION` and its rationale that "transport evolution
  cannot silently reinterpret persisted command bytes").
- Findings: the design already separates the intent protocol version from the
  encoding versions precisely so the transport can evolve independently, which
  makes adding a field a contemplated kind of change. The `replayed` flags show
  the design takes idempotent retry seriously. Adding an expected-state field
  would make the fence expressible in the request rather than only inferable in
  storage, at the cost of requiring the caller to know the current state, which
  it may not after a crash. An alternative is to keep the fence in storage and
  have the response report the observed prior state so the caller can detect a
  surprise.
- Missing evidence: whether callers reliably know the prior state at
  acknowledgement time.
- Conclusion: needs human input. Recording both options because the choice
  determines where the property can be checked: a wire-level field makes it
  checkable in `mc-core`, while a storage-level fence makes it checkable only in
  an `mc-store` integration test.

### Q: What exactly is the intended legal edge set?

- Sources examined: `crates/mc-core/src/claim_operation.rs:368-377` (the
  lifecycle doc and states), `:399-401` (`is_unresolved`), `:425-432`
  (`ClaimIntentAckKind`), `:434-436` (the doc on when `result_json` is supplied:
  "only when recording `context-committed` or `terminal-rejected`").
- Findings: `:434-436` is the strongest available evidence about edges, because
  it says result bytes accompany exactly `ContextCommitted` and
  `TerminalRejected`, which implies `Acknowledged` is a settlement-only edge
  carrying no new result. Combined with `is_unresolved` marking `Staged` and
  `ContextCommitted` as the non-terminal pair, the inferred graph in the Evidence
  trail above is well supported. What is not established is whether
  `Staged -> Acknowledged` is legal (skipping `ContextCommitted`), and whether
  self-edges are the intended representation of an idempotent replay.
- Missing evidence: a written state diagram or the storage-layer guard.
- Conclusion: unresolved, needs human input on the two ambiguous edges. The
  property cannot be checked until the legal set is written down, so this
  question is a prerequisite for the record rather than a refinement of it.
