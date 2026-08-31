# outbox-b-checkpoint-advances-against-a-module-with-no-open-store

## Discovery trigger

Part 4d's evidence file states the case plainly: "During store-open
(`STORE_OPENING`, `lib.rs:12007-12011`) `claim.intent.stage` returns
`store_unavailable_error` (`:10097-10099`) and `claim.effects.apply` returns a
successful ack. The producer will advance its checkpoint against a module that has
no open store." That is a producer-side situation nobody has ever produced, and it
is the cleanest demonstration that the ack carries no information.

## Evidence trail

**Part 4d's four references, verified at `HEAD`.**

`crates/mc-module/src/lib.rs:12005-12011`, the phase read:

```
12005         let phase = self.store_open.phase.load(Ordering::Acquire);
12006         let mut report = match phase {
12007             STORE_OPENING => HealthReport {
12008                 status: HealthStatus::Degraded,
12009                 detail: Some("storage is opening".to_owned()),
```

`:10097-10099`, the neighbouring claim handler's behaviour with no store:

```
10097         let Some(store) = self.store() else {
10098             return store_unavailable_error();
10099         };
```

`:10184-10188`, the effects handler's entry, which checks only the route:

```
10184     fn handle_claim_effects_apply(&self, channel: RouteHandle, request: &Value) -> PreparedOutcome {
10185         if let Err(outcome) = self.claim_route_root(channel, "claim.effects.apply") {
10186             return outcome;
10187         }
```

`:10251-10254`, its answer:

```
10251         respond(json!({
10252             "protocolVersion": mc_core::claim_operation::CLAIM_INTENT_PROTOCOL_VERSION,
10253             "ackedEffectId": previous,
10254         }))
```

No `self.store()` anywhere in the range. Part 4d's grep of `:10184-10255` for a
store access is confirmed by reading the range's entry and exit.

**The producer's side of the window.** `hook.ts:917-990` runs, in order:
`readDirectFormatMarker` (local), `authorityStatus` (remote, `:924`),
`commitModuleClaimIntent` (`:950`), which itself calls `claimIntentInspect`
(`context-authority.ts:145`), `claimIntentStage` (`:196`), `claimIntentAck`
(`:244`), then `settleContext` (`:264`), which is the drain
(`hook.ts:974-988`) and the checkpoint advance
(`module-state-sync.ts:2328-2345`).

So the producer makes at least four module round trips before the delivery. To
land the delivery inside a store-open window, the store must close and reopen
between the successful `claimIntentAck` and the delivery — or the module must
restart in that interval and be reached again while opening.

**What the producer would observe.** Nothing distinguishing.
`decodeClaimEffectDeliveryResponse` (`module-wire.ts:717-735`) validates the
protocol version and the echoed id. There is no health field, no store-phase
field, and no `replayed` flag on `ClaimEffectDeliveryResponse`
(`module-wire.ts:127-130`, exactly two fields).

**The producer has no store-phase signal on this path.** The claim path's only
module read is `authorityStatus` (`hook.ts:924`), which returns an
`AuthorityStatus` (`context-authority.ts:23-46`). The `ModuleStateSyncClient`
interface (`module-state-sync.ts:2362-2404`) exposes `stateSyncCapabilities`, the
two mirror methods, and a generic `call` whose method union
(`:2385-2399`) contains no health method. So the window is, from the producer's
vantage, invisible.

**Nothing tests it.** Part 4d records the Rust half has no test at all. On the
TypeScript side, `module-state-sync.test.ts:1399-1442` and
`context-authority-crash.test.ts` both use in-process consumers with no store
concept, so neither can construct a store-open window.

## Failure scenario

The module restarts — a crash, a reconnect, a version swap — between the intent
ack and the settle. The producer's transport reconnects and delivers
`claim.effects.apply`. The module is in `STORE_OPENING`. The route is bound, so
`claim_route_root` succeeds. The handler validates the wire shape and answers with
the last effect id. The producer's two equality checks pass. The transaction at
`module-state-sync.ts:2328-2345` commits, permanently.

If `claim.effects.apply` is meant to apply (Part 4d's reading A), those effects
are lost to the module with certainty, not merely with probability — there was no
store to write to. And the producer's own logging reports success: the drain
returns non-zero `deliveredReceipts` and `deliveredEffects` (`:2347-2349`).

## Timing windows and dependencies

- The window is the module's `STORE_OPENING` phase overlapping the single
  `claim.effects.apply` call at `module-state-sync.ts:2322`.
- Depends on `outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix`: the
  echo is why the window is undetectable.
- Depends on `outbox-b-checkpoint-advance-is-the-point-of-no-return` for the
  consequence.
- Confidence is medium precisely because the producer-side sequencing that reaches
  the window is reasoned from the call order above and not constructed.

## What a test must construct

1. Module-side, which Part 4d already specified and which is the cheaper half:
   bind the facade route with no store installed, call `claim.effects.apply` with
   a well-formed receipt, and assert the outcome. If it acks, the window exists
   with no timing at all.
2. Producer-side: a consumer double that reports its own store phase out of band
   and returns a correct ack while reporting `STORE_OPENING`. Drive a mutation and
   assert the checkpoint advanced. The assertion is on the advance, not on any
   loss.
3. Cross-tree, the honest version: run the real module, restart it between the
   intent ack and the settle using the injected-cut harness shape at
   `context-authority-crash.test.ts:330-370`, and observe whether the delivery
   lands during store-open. This is the expensive one and the only one that proves
   the window is reachable in production rather than merely constructible.
4. Coverage-check form, two independent markers per METHOD.md:
   `EFFECTS_ACK_ACCEPTED` fires when
   `decodeClaimEffectDeliveryResponse` returns, and
   `MODULE_STORE_PHASE_NOT_READY` fires when the module's phase is not the ready
   phase in the same request window. Neither observes a defect and both fire on a
   correct implementation. Both firing on one request is the situation.
5. `sometimes` and not `reachable`: the ack-accepting lines execute on every
   delivery, so line coverage says nothing. What must occur at least once per
   campaign is the operational state of a not-ready consumer accepting a delivery.

## Investigation log

### Q: Can the producer observe the module's store phase from the claim path at all?

- Sources examined: `hook.ts:917-990` for the full claim-path call sequence;
  `AuthorityStatus` and `AuthorityModuleClient` (`context-authority.ts:23-46`,
  `:63-103`) for what the authority call returns;
  `ModuleStateSyncClient` (`module-state-sync.ts:2362-2404`) including the method
  union at `:2385-2399`; `ClaimEffectDeliveryResponse`
  (`module-wire.ts:127-130`).
- Findings: no field on any response the claim path reads carries a store phase or
  health status. The method union has no health entry. `HealthReport`
  (`lib.rs:12006-12011`) exists on the module side, so some transport surface
  presumably reads it, but it is not one this path touches.
- Missing evidence: whether the transport exposes health elsewhere. The transport
  is `module-transport.ts`, which the Part 5 scope map holds out of 5a and 5c as a
  boundary file (`../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:542-544`),
  so I read only its claim methods (`:1040-1104`) and did not sweep it.
- Conclusion: unresolved, needs a pass over the transport's health surface. Until
  then the check must be cross-tree, which is why route 3 above is the honest
  form.

### Q: Is the ready phase constant named in a way a producer-side test could reference?

- Sources examined: `lib.rs:12005-12011`, which matches on `STORE_OPENING` and
  falls through to other arms not read in this pass.
- Findings: `STORE_OPENING` is a Rust constant with no TypeScript counterpart I
  found on the claim path.
- Missing evidence: the full phase enumeration and whether any of it crosses the
  wire.
- Conclusion: unresolved, needs the same transport pass. Recorded rather than
  guessed.
