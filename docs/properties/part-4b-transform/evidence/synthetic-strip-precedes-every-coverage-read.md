# synthetic-strip-precedes-every-coverage-read

## Discovery trigger

The module header names two paired poison-resistance invariants and calls the
synthetic strip the PRIMARY one. The task asked for contract-versus-code
disagreements, so the strip's actual mechanism had to be traced rather than
accepted from the header.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

### The contract

`transform.rs:12-15`:

> Two paired poison-resistance invariants: synthetic items are stripped before
> any boundary / coverage / tail computation (PRIMARY), and the `mc_*` id
> namespace is reserved (BACKSTOP) so a synthetic block can never masquerade as
> the real boundary.

### The mechanism, in order

1. `transform.rs:3243` — `let normalized_req = normalize_synthetic_todo_ingress(req);`
   Body at `:2405-2422`. It does not strip; it *marks*. For each message that is
   not already `synthetic` and whose CK content carries a `ToolCall` or
   `ToolResult` whose id satisfies `is_synthetic_todo_id`, it clones the request
   once (`:2419`) and sets `next.messages[index].ck.meta.synthetic = true`
   (`:2420`). The comment at `:3239-3241` explains why: "OpenCode transports the
   frozen todo pair as one marked tool part. Older adapters did not copy that
   marker into CK metadata, so recognize the reserved call-id namespace here too.
   Normalizing before projection keeps the replayed pair out of selection,
   coverage, and output."
2. `transform.rs:3244` — `let ingress_req = normalized_req.as_ref().unwrap_or(req);`
3. `transform.rs:3253-3257` — the projection is built from `ingress_req.messages`,
   either incrementally (`project_messages_incremental`) or fully
   (`project_messages`).
4. `transform.rs:3339` — on a lineage descent, `rebased_req =
   rebase_descent_ordinals(ingress_req, base)?`, so the rebased request is
   derived from the normalized one, not the original.
5. `transform.rs:3342` — `let req = rebased_req.as_ref().unwrap_or(ingress_req);`
   This shadows the function parameter. Every later `req` in `apply_once` is the
   normalized or normalized-and-rebased request.
6. `transform.rs:3357-3361` — `let live: Vec<&FlatBlock> = projection.blocks
   .iter().filter(|i| !i.synthetic()).collect();`
7. `transform.rs:3362-3366` — the BACKSTOP: `for item in &live { if
   item.id().starts_with(RESERVED_ID_PREFIX) { return
   Err(TransformError::ReservedId); } }`, with `RESERVED_ID_PREFIX = "mc_"` at
   `:91`.

### Verification that the shadow covers every later read

`ingress_req` appears only between `:3244` and `:3342`: at `:3244`, `:3249`,
`:3250`, `:3254`, `:3256`, `:3266`, `:3271`, `:3273`, `:3275`, `:3281`-`:3286`,
`:3290`, `:3294`, `:3297`, `:3301`-`:3303`, `:3313`, `:3315`-`:3318`, `:3320`,
`:3327`, `:3330`, `:3334`, `:3339`, `:3342`. There is no `ingress_req` reference
after the shadow.

`req.messages` appears three times after `:3350`, all after the shadow: `:3368`
(the non-decreasing-ordinal check, itself filtered on `!m.ck.meta.synthetic`),
`:3379` (`latest_assistant_message_mutation_exempt_mid`), and `:5363` (an anchor
presence check). All three therefore see the normalized flags.

The one read worth calling out explicitly is `:3441-3446`, the continued-lineage
first-live-ordinal check:

```
let first_live = req
    .messages
    .iter()
    .find(|message| !message.ck.meta.synthetic)
    .map(|message| message.ordinal);
if first_live != Some(expected_boundary) {
```

It filters on `synthetic` and reads the shadowed `req`, so a replayed todo pair
that arrived without a CK marker is excluded here too. Had `:3342` not shadowed,
this check would have counted the pair as the first live ordinal while `live`
excluded it, which is exactly the class of divergence the PRIMARY invariant
exists to prevent.

### Downstream consumers all take `live`

`resolve_boundary_state(store, req, core, meta, live)` at `:7167-7269` takes
`live` and additionally consults `req.messages` at `:7248-7252`, filtered on
`!message.ck.meta.synthetic && message.ck.role != "system"`. `resolve_coverage`
is imported from `compartment_coverage` (`:18`). `surviving_revert_prefix_seq`
(`:7275-7284`), `first_uncovered_live_block`, `tail_sel_items`,
`protected_tail_floor_ordinal` and `boundary_available` (`:7156`) all take `live`
or a value derived from it.

## Failure scenario

The invariant holding is what prevents the failure, so the scenario is what a
break looks like. An OpenCode adapter replays a frozen todo pair whose CK
metadata lacks `synthetic: true`. If `normalize_synthetic_todo_ingress` did not
mark it, or if a coverage read used the un-normalized request, the pair would
appear in `live`. Then:

- Its flat block id could be selected as the coverage anchor, so `boundary_id`
  would name a block the module itself injected. The BACKSTOP at `:3363-3365`
  catches exactly this by rejecting a live `mc_`-prefixed id, which is why the
  header calls the two invariants paired.
- Its ordinal would participate in `first_uncovered_live_block` and the
  coverage-gap guards, so a legitimate array could be rejected as having a
  coverage gap.
- It would be counted in the ordinal-monotonicity check at `:3367-3374`, and the
  injected pair's ordinal is not guaranteed to interleave monotonically with real
  messages.

## Timing windows and dependencies

No timing window. This is a straight-line ordering invariant.

The dependency is fragile in a specific way: correctness rests on the shadow at
`:3342`, and a shadow is invisible at the point of use. A future edit that moves
any coverage-relevant read above `:3342`, or that renames the shadowed binding,
breaks the invariant for that read silently. There is no assertion, no type
distinction between a normalized and an un-normalized `TransformRequest`, and no
test on the ordering.

`is_synthetic_todo_id` and the `mc_synthetic_todo_<hash>` id shape live in
`injection.rs`, which is in this sub-part's scope. The deterministic call-id
construction is what makes recognition-by-namespace possible at all.

## What a test must construct

1. Build a CK array containing a todowrite call and result pair whose ids are in
   the `mc_synthetic_todo_` namespace but whose `ck.meta.synthetic` is `false`,
   simulating the older adapter.
2. Assert the projection's `live` set excludes both blocks.
3. Assert `resolve_boundary_state` does not select either block id, and that
   `meta.coverage_ordinal` after a fold does not name either ordinal.
4. Separately, build an array with a non-synthetic block whose flat id starts
   with `mc_` and assert `TransformError::ReservedId`. That covers the BACKSTOP
   independently, which matters because the two invariants are supposed to be
   independent defences.
5. As an ordering guard rather than a behaviour test, an `always` check that
   every coverage-relevant helper is called with a collection derived from `live`
   is what actually protects the invariant. That is a structural property better
   served by a guard than a test, so it routes to
   `/low-level-systems:defensive-assertions-and-invariant-guards`.

## Investigation log

### Q: Does any coverage-relevant read use the un-normalized request?

- Sources examined: every `ingress_req` occurrence in `:3244-3342`; every
  `req.messages` occurrence in `:3350-5697` (`:3368`, `:3379`, `:5363`);
  `:3342`; `:3441-3446`; `:7167-7269`; `:7248-7252`.
- Findings: no. The shadow at `:3342` rebinds `req` before any coverage read, and
  `rebased_req` is itself derived from `ingress_req` at `:3339`, so both branches
  of the `unwrap_or` are normalized. The `:3441-3446` check, which was the
  candidate for a leak because it reads `req.messages` directly and filters on
  `synthetic`, is downstream of the shadow.
- Missing evidence: none for `apply_once`. `apply_additive_only` has its own
  reserved-id check at `:2735`, which suggests the same discipline, but its
  normalization path was not traced because it is `explicit-config-only`.
- Conclusion: resolved with answer — the invariant holds at `HEAD` for the
  default-production engine. The finding is the fragility of the mechanism, not a
  defect.

### Q: Is the PRIMARY invariant's ordering protected against future edits?

- Sources examined: `:3243-3244`, `:3342`, `:3357-3366`; searched
  `:3222-5697` for any assertion or `debug_assert` on synthetic exclusion.
- Findings: nothing. No assertion, no newtype distinguishing a normalized request,
  no test on the ordering. The only protection is the shadow plus the BACKSTOP,
  and the BACKSTOP only catches the specific case where the leaked block's id is
  in the reserved namespace, which is true for the todo pair but is not a general
  guarantee about future synthetic kinds.
- Missing evidence: none.
- Conclusion: resolved with answer — unprotected. Whether to add a type-level
  distinction is a design question; recorded here as the reason this record is
  worth cataloging even though the invariant currently holds.
