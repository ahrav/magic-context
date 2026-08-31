# outbox-b-acknowledgement-is-an-echo-of-the-delivered-prefix

## Discovery trigger

The task framed this as the crux, and it is: an acknowledgement that is truthful
about nothing must not be able to advance a durable cursor. The producer looks
like it defends against exactly that, twice. Following where the compared value
comes from shows why the defence cannot work.

## Evidence trail

**The producer checks the ack twice.**

First in the transport, before the drain ever sees the response.
`packages/plugin/src/hooks/magic-context/module-transport.ts:1076-1088`:

```
1076 const expectedEffectId = args.request.receipt.effects.at(-1)?.id;
1077 if (expectedEffectId === undefined) {
...
1088 return decodeClaimEffectDeliveryResponse(response, expectedEffectId);
```

The decoder then rejects a mismatch.
`packages/plugin/src/hooks/magic-context/module-wire.ts:729-733`:

```
729 if (ackedEffectId !== expectedEffectId) {
730     throw new Error(
731         `claim effect delivery response skipped checkpoint ${expectedEffectId} -> ${ackedEffectId}`,
732     );
733 }
```

Second in the drain itself.
`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2318-2327`:

```
2318 const expectedEffectId = proof.effects.at(-1)?.id;
...
2322 const acknowledged = await args.deliver(delivery);
2323 if (acknowledged.ackedEffectId !== expectedEffectId) {
```

**Where `expectedEffectId` comes from.** Both derivations read the last element
of the effect list. In the transport it is
`args.request.receipt.effects.at(-1).id`, a field of the request the producer is
about to send. In the drain it is `proof.effects.at(-1).id`, the same list, since
`delivery.effects = proof.effects` at `:2316`. So the compared value is a
function of the outgoing request only.

**What the consumer does with it.** Part 4d,
`crates/mc-module/src/lib.rs:10225-10254`, verified at `HEAD`: the handler walks
the wire effects, keeps the last id in `previous`, and answers
`"ackedEffectId": previous`. It never calls `self.store()` anywhere in
`:10184-10255`.

Therefore the check `acknowledged.ackedEffectId === expectedEffectId` is
satisfied by any consumer that can read the last element of the array it was
handed. It is a well-formedness check on the response, not evidence of
application.

**What the producer *can* verify, in full.** Every one of these is verified, and
none of them is about the consumer:

| Guard | Site | What it establishes |
| --- | --- | --- |
| receipt row exists | `:2269-2285` | local durability |
| receipt matches result JSON | `:2151-2153` | local consistency |
| effect count equals `expected_effect_count` and the decoded result | `:2156-2158` | local completeness |
| no repeated effect key | `:2160-2162` | local well-formedness |
| each row agrees with the result on project, generation, change kind | `:2163-2172` | local consistency |
| the store durably reached each claimed generation | `:2182-2195` | local durability |
| `proof.receiptId` matches the selected group | `:2292-2297` | local selection |
| every effect sits strictly above the checkpoint | `:2298-2309` | local prefix integrity |
| the ack equals the last delivered id | `:2323-2327`, `module-wire.ts:729-733` | the response is well formed |
| the protocol version is the expected one | `module-wire.ts:722` | the peer speaks the protocol |

**What the producer cannot verify.** That the consumer wrote anything; that the
consumer's store was open; that the consumer is the consumer named in
`request.consumer` (Part 4d: `lib.rs:10198-10204` accepts any non-empty string
and compares it to nothing); that a redelivery of the same group is
distinguishable from a first delivery, since the response shape carries no
`replayed` flag at all
(`ClaimEffectDeliveryResponse` is `{ protocolVersion, ackedEffectId }`,
`module-wire.ts:127-130`).

**The contrast that proves the shape was available.** The mirror lane's response
does carry module-side outcome. `module-wire.ts:783-791` reads `receiptId`,
requires a boolean `replayed`, and reads `appliedEffectCount`. So the codebase
already knows how to make a consumer report what it did, and the effects lane
does not use it. `module-transport.ts:1073-1075` nonetheless claims the two lanes
share one contract.

## Failure scenario

Any consumer that parses the request and returns the last effect id advances the
producer's durable cursor. The shipped consumer is such a consumer. So is a stub,
a proxy that lost its backend, a replaying test double, and a module whose store
is still opening (Part 4d, `lib.rs:10097-10099` versus `:10251-10254`).

The producer cannot tell these apart from a consumer that applied the prefix
correctly, and it commits the irreversible checkpoint in all cases
(`storage-claim-operations.ts:2260-2266`).

## Timing windows and dependencies

- No interleaving needed. The deficiency is in the information content of the
  response.
- Depended on by `outbox-b-checkpoint-advance-is-the-point-of-no-return` and
  `outbox-b-checkpoint-advances-against-a-module-with-no-open-store`.
- Independent of the producer's own guard chain, which is sound and which this
  record does not dispute.

## What a test must construct

1. Two consumers with identical response behaviour and different internal
   behaviour: one that records each receipt group (the shape at
   `context-authority-crash.test.ts:214-231`) and one that records nothing. Both
   return `receipt.effects.at(-1).id`.
2. Drive the same mutation against each. Assert the producer's observable
   outcome is identical: same `ClaimEffectPrefixDrainResult`, same checkpoint row.
   That identity is the property, stated positively.
3. Assert the response type cannot express the difference: check that
   `ClaimEffectDeliveryResponse` (`module-wire.ts:127-130`) has exactly two
   fields, so no field a test could assert on exists.
4. Coverage-check form: `EFFECTS_ACK_ACCEPTED` fires when
   `decodeClaimEffectDeliveryResponse` returns, and
   `EFFECTS_ACK_VALUE_DERIVABLE_FROM_REQUEST` fires when the accepted value
   equals `request.receipt.effects.at(-1).id`. Both fire on a correct
   implementation, which is what METHOD.md requires; both firing on every
   delivery is the finding.
5. Do not add an application assertion to the existing crash test's fake. That
   fake applying is what currently hides the property.

## Investigation log

### Q: Is there any other channel through which the producer could learn that the consumer applied the prefix?

- Sources examined: the full `ModuleStateSyncClient` interface
  (`module-state-sync.ts:2362-2404`) for a method that reports claim-effect
  state; `AuthorityModuleClient` (`context-authority.ts:63-103`); the mirror
  lane's `claimMirrorApply` response decoder (`module-wire.ts:776-791`) as the
  positive control; `mirrorPull` as used by `reconcileAuthorityProject`
  (`context-authority.ts:630-657`), which pulls the notes changefeed.
- Findings: no method reports claim-effect application. `mirrorPull` exists but
  `reconcileAuthorityProject` uses it only for `notes` (`:617`), and it pulls a
  changefeed of module-owned rows rather than reporting which delivered effects
  were retained. The mirror lane's `appliedEffectCount` is the only
  application-reporting field on any claim response, and it belongs to the other
  consumer.
- Missing evidence: none needed for this question.
- Conclusion: resolved with answer — no. The ack is the producer's only signal,
  and it is an echo.

### Q: Is `claim.effects.apply` meant to apply?

- Sources examined: Part 4d's investigation log, which examined the same
  question against `lib.rs:10184-10255` and `:10299-10337` and concluded "needs
  human input"; the `docs/` sweep performed for this lens, which found no claim
  or outbox specification anywhere.
- Findings: nothing new. The producer-side evidence adds one datum in each
  direction. For "meant to apply": the effects lane's decoder was written to
  reject a mismatch rather than merely record the value, which is only useful if
  the value means something. For "conformance ack": the response type was never
  given a `replayed` or `appliedEffectCount` field, while its sibling was.
- Missing evidence: a design note or commit rationale. Not retrievable in scope.
- Conclusion: needs human input.
