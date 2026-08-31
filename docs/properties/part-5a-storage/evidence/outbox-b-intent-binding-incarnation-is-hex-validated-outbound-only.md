# outbox-b-intent-binding-incarnation-is-hex-validated-outbound-only

## Discovery trigger

Part 3 found a Rust guard that silently drops a write when its
`database_incarnation_id` argument is not 32 lowercase hex, with all four callers
passing a dashed `context_store_uuid`. The task asks whether this producer is one
of those callers. Answering it required tracing where the producer's incarnation
value comes from and what validates it on each hop.

## Evidence trail

**Is this producer one of Part 3's four callers? No.** Part 3's four call sites
are `authority_begin_prepare` (`crates/mc-store/src/lib.rs:11434-11440`),
`authority_finish_prepare` (`:11640-11649`), and both arms of
`authority_begin_drain` (`:11738-11744`, `:11790-11796`), each passing
`context_store_uuid` into `set_claim_intent_transition_tx`. All four are inside
`mc-store`. The TypeScript producer never calls that function; it has no path into
`mc_claim_intent_controls` at all. The confusion Part 3 found is internal to the
Rust store.

**What the producer actually supplies.**
`packages/plugin/src/hooks/magic-context/hook.ts:917-920` then `:957-962`:

```
917 const marker = readDirectFormatMarker(db);
918 if (marker.status !== "present") {
919     throw new Error("claim intent requires a valid context format marker");
920 }
...
957                               binding: {
958                                   databaseIncarnationId: marker.marker.databaseIncarnationId,
959                                   formatEpoch: marker.marker.formatEpoch,
960                                   authorityProject: projectPath,
961                                   authorityGeneration: status.authority.generation,
962                               },
```

**That value is 32-hex by construction and by check.**
`packages/plugin/src/features/magic-context/storage-format-epoch.ts`:

```
74 export function generateDatabaseIncarnationId(
75     random: (byteCount: number) => Uint8Array = randomBytes,
76 ): string {
77     return Buffer.from(random(16)).toString("hex");
78 }
79
80 export function isValidDatabaseIncarnationId(candidate: string): boolean {
81     return INCARNATION_ID_PATTERN.test(candidate);
82 }
```

Sixteen random bytes hex-encoded is exactly 32 lowercase hex characters. The
mint path validates at `:124-127` and throws on failure. The read path validates
at `:222-224` and returns `{ status: "malformed" }` rather than a marker, which
`hook.ts:918` converts into a thrown error. So the producer cannot emit an invalid
incarnation on this path.

**The separate identity, and why it is not confused here.**
`context-authority.ts:445-457` mints the store UUID with `randomUUID()` — dashed,
36 characters — and the comment at `:443-444` states its distinct purpose:
"Restoring a database restores this value too, which is what lets the module
recognize a regressed marker." It is passed as `context_store_uuid` on every
`authorityStatus` call (`hook.ts:925`, `context-authority.ts:565`, `:585`, `:619`,
`:1122`) and never as `databaseIncarnationId`. The producer keeps the two apart.

**The decoder asymmetry.** The same field name is validated to two different
standards on the inbound path.
`packages/plugin/src/hooks/magic-context/module-wire.ts:283-286`, inside
`validateClaimMirrorVector`:

```
283     const databaseIncarnationId = wireString(record, "databaseIncarnationId", label);
284     if (!/^[0-9a-f]{32}$/.test(databaseIncarnationId)) {
285         throw new Error(`${label}.databaseIncarnationId must be 32 lowercase hex characters`);
286     }
```

`module-wire.ts:550-558`, `decodeClaimIntentBinding`:

```
550 function decodeClaimIntentBinding(value: unknown): ClaimIntentBinding {
551     const record = wireRecord(value, "claim intent binding");
552     return {
553         databaseIncarnationId: wireString(record, "databaseIncarnationId", "binding"),
```

No format check. The decoded binding is then compared for equality in two places:
`module-wire.ts:667`, inside the intent ack response identity check, and
`context-authority.ts:112-122`, `sameIntentBinding`, whose result decides whether
an intent is treated as belonging to an obsolete incarnation
(`context-authority.ts:156-194`).

**Outbound bodies carry no validation at all.**
`module-wire.ts:602-624` — `buildClaimIntentStageWireBody`,
`buildClaimIntentAckWireBody`, and `buildClaimEffectDeliveryWireBody` are each a
single return of `{ name, arguments: request }`. They are pass-throughs.

## Failure scenario

The outbound path is sound, so the failure is inbound. A module response whose
`intent.binding.databaseIncarnationId` is malformed — truncated, uppercase,
dashed — passes `decodeClaimIntentBinding` and reaches `sameIntentBinding`, where
it compares unequal to the producer's correct value. `commitModuleClaimIntent`
then takes the obsolete-incarnation branch (`context-authority.ts:156-194`),
terminally rejects or acknowledges the prior intent, and throws
"claim intent belongs to an obsolete context incarnation or authority" (`:193`).

That is fail-closed and therefore not a soundness break. The cost is that a
malformed value is reported as an incarnation change rather than as malformed
input, which is a diagnosis problem in a lane whose failures are already hard to
attribute.

**Part 3's trap, from this side.** Part 3 records that repairing the Rust guard
without changing its argument would make `mc_claim_intent_controls` hold a
`context_store_uuid`, and both `replace_claim_mirror_snapshot` and
`apply_claim_mirror_receipt` compare that column for equality against the real
`database_incarnation_id`. The value they would compare it against is the one this
producer supplies at `hook.ts:958` and in the mirror vector — the correct 32-hex
one. So this producer's correctness is exactly what would turn Part 3's latent gap
into a total claim-lane outage. The producer is not the defect and it is the thing
that makes the naive fix fatal.

## Timing windows and dependencies

- No timing. A format and validation question.
- Depends on Part 3's `intent-control-transition-write-is-silently-dropped` for
  the Rust-side context; adds the producer-side half.
- Independent of the checkpoint records.

## What a test must construct

1. Assert the producer's outbound invariant directly: for any database the
   plugin will open, `readDirectFormatMarker` either fails or yields a
   `databaseIncarnationId` matching `/^[0-9a-f]{32}$/`. A property test over
   marker rows, including a hand-written malformed row, covers it.
2. Assert the two identities never cross: `getContextStoreUuid` never returns a
   value that `isValidDatabaseIncarnationId` accepts, and the binding never
   carries the store UUID. The Rust test fixture at
   `crates/mc-store/tests/claim_intent_ledger.rs:11-15` already chose a dashed
   value deliberately for the same reason, so the fixtures should agree.
3. Feed `decodeClaimIntentBinding` a malformed incarnation and assert the observed
   outcome. Today it is accepted and later reported as an incarnation change; the
   test should pin which of those two it is rather than asserting a preference.
4. Positive control: feed the same malformed value to `validateClaimMirrorVector`
   and assert
   `"databaseIncarnationId must be 32 lowercase hex characters"`. That isolates
   the decoder asymmetry.

## Investigation log

### Q: Could the producer ever emit a non-32-hex `databaseIncarnationId` on the claim path?

- Sources examined: `hook.ts:917-920` and `:958`; `storage-format-epoch.ts:74-82`
  for the mint and the predicate, `:118-128` for the build-time validation, and
  `:211-224` for the read-time validation; `:563-571` and `:766-771`, the two
  other places the module validates a nullable incarnation; the outbound body
  builders at `module-wire.ts:602-624`.
- Findings: no. Every construction path validates, and the read path downgrades
  an invalid marker to `malformed`, which `hook.ts:918` rejects before the binding
  is built. The only unvalidated hop is inbound decode, which cannot affect what
  the producer sends.
- Missing evidence: none.
- Conclusion: resolved with answer — the producer cannot, and it is not one of
  Part 3's four dashed-UUID callers.
