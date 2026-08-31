# codec-b-absolute-ordinal-is-harness-supplied-and-never-validated

## Discovery trigger

Lens A ended with an open question addressed to this lens
(`_lenses/lens-a-decision-units-and-config.md:589-593`): "Is `boundary.rs:687-691`'s
use of the maximum ordinal as `total_message_count` correct for a sparse tail? ...
Unresolved, needs the ingress projection's ordinal-density contract, which is the
sibling codec lens's material." Tracing where an ordinal comes from answers it, and
the answer turned out to be stronger than the question assumed: the producer emits
sparse **and duplicate** ordinals deliberately.

## Evidence trail

### The Rust ingress point

`crates/mc-module/src/codec/opencode.rs:52-60`, read at `HEAD` `e447c927`:

```
52:         let explicit_ordinal = raw_message
53:             .get("absolute_ordinal")
54:             .and_then(Value::as_u64)
55:             .or_else(|| info.get("absolute_ordinal").and_then(Value::as_u64));
56:         let ordinal = explicit_ordinal.unwrap_or_else(|| {
57:             provisional_base
58:                 .saturating_add(message_index as u64)
59:                 .saturating_add(1)
60:         });
```

`explicit_ordinal` wins unconditionally. The only constraint is `Value::as_u64`.
No comparison against `message_index`, `provisional_base`, or the previous
message's ordinal. The fallback at `:57-59` is dense, monotonic, and 1-based; the
explicit path has none of those properties.

The doc comment, `:34-36`:

```
34: /// Decode a wholly fresh OpenCode array in the absolute ordinal space inherited from a
35: /// completed lineage descent. Explicit absolute ordinals win; otherwise the positional
36: /// fallback starts after `provisional_base` instead of silently restarting at one.
```

Where it lands: `HarnessMeta.ordinal` at `:216`, `CkIngressMessage.ordinal` at
`:223`, `HarnessMessageMeta.ordinal` at `:230`. From `CkIngressMessage.ordinal` it
reaches `FlatBlock.ordinal` through the projection and is exposed as
`CkItem::ordinal` (`ck_wire.rs:71-73`).

### The producer, and what it actually emits

`packages/plugin/src/hooks/magic-context/module-wire.ts` is the writer. Three
facts settle the contract.

Session-global numbering, `:1027-1034`:

```
1027:     if (suffixStart < annotated.length) {
1028:         const base =
1029:             suffixStart > 0
1030:                 ? (resolved[suffixStart - 1] as number)
1031:                 : Math.max(0, args.provisionalBase ?? canonicalCount);
1032:         for (let index = suffixStart; index < annotated.length; index += 1) {
1033:             resolved[index] = base + (index - suffixStart) + 1;
1034:         }
1035:     }
```

The base is a canonical count or a provisional base, not an array index. So the
ordinal space is the session's canonical history, and a window into the tail of a
long session carries large ordinals. `module-wire.test.ts:180` expects
`absolute_ordinal: 501`, which is a specimen of exactly that.

Duplicate ordinals are deliberate, `:999-1018`:

```
 999:     /**
1000:      * OpenCode can place an unpersisted synthetic nudge between two persisted
1001:      * messages in one wire snapshot. It is not part of canonical raw history,
1002:      * so it borrows the preceding canonical ordinal instead of consuming a
1003:      * slot. Only explicit synthetic messages get this exception. A genuine
1004:      * persisted-but-unpaged message remains unresolved and is rejected below;
1005:      * the stored-row count and ordinal self-heal checks still catch drift.
1006:      */
...
1017:         resolved[index] = priorIndex >= 0 ? (resolved[priorIndex] as number) : 0;
```

A synthetic message "borrows the preceding canonical ordinal instead of consuming
a slot". So two messages sharing one ordinal is not a malformation; it is the
documented design. And `:1017` gives ordinal `0` to a synthetic message with no
resolved predecessor, so zero is a legitimate value.

Per-message stability is enforced on the producer side, `:1037-1052`:

```
1040:         const prior = memo.get(messageId);
1041:         if (prior !== undefined && prior !== ordinal) {
1042:             return {
1043:                 ok: false,
1044:                 reason: "mismatch",
```

So the producer already guarantees a message keeps its ordinal across passes, and
the Rust decoder does not need to re-check that.

Taken together: the ordinal space is session-global, non-dense, permits
duplicates, includes zero, and is stability-checked upstream. The Rust decoder's
verbatim pass-through is faithful to that contract.

### The consumer that reads it as a count

`crates/mc-module/src/boundary.rs:685-705`:

```
685:     let mut ordered = messages.iter().collect::<Vec<_>>();
686:     ordered.sort_by_key(|message| message.message_ordinal);
687:     let total_message_count = ordered
688:         .iter()
689:         .map(|message| message.message_ordinal)
690:         .max()
691:         .unwrap_or(ordered.len() as u64);
...
705:     builder.finish(total_message_count, eligible_end_ordinal)
```

`max()` equals the message count only when ordinals are dense and 1-based, which
is true of the positional fallback and false of the producer's real output. The
`unwrap_or(ordered.len() as u64)` at `:691` is direct evidence the author read
`max()` as a count: the empty-list fallback is a length.

`transform.rs:20278` already ships `"absolute_ordinal": 2_414` in a Rust fixture,
so the sparse case is constructible today with a value the repository uses.

### The Pi contrast

`codec/pi.rs:52`:

```
52:         let ordinal = (decoded.len() + 1) as u64;
```

and `:45` for opaque entries. Both derive from the count of *surviving* messages,
so Pi ordinals are dense and 1-based by construction and silently renumber when
`codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record`'s drop fires.
Pi has no explicit override, so the harness cannot pin the numbering. The two
harnesses therefore have opposite properties on this axis: OpenCode ordinals are
stable but not dense, Pi ordinals are dense but not stable.

### The incremental base

`decode_opencode_sidecar_incremental` (`:246-262`) passes `replace_from as u64` as
`provisional_base` at `:260`. `replace_from` is an index into the current array,
not a canonical count. So when the suffix falls back to positional numbering, its
base is array-relative while the prefix's explicit ordinals are session-global.
Nothing checks that the two halves meet.

## Failure scenario

The primary scenario is not malformed input; it is correct input read wrongly.

A session with 500 canonical messages, windowed to its last fifteen. The producer
emits ordinals around 501 to 515 (`module-wire.test.ts:180` pins 501 as a real
value). `boundary.rs:687-691` computes `total_message_count = 515` for fifteen
messages.

The second scenario is the duplicate: a synthetic nudge between two persisted
messages borrows the preceding ordinal (`module-wire.ts:1002`). Two
`CkIngressMessage` values then share an ordinal. `boundary.rs:686` sorts by
ordinal, which is stable so relative order survives, but any consumer keying on
ordinal treats the pair as one message. I did not enumerate those consumers.

The third scenario is the mixed base described above, where an incremental suffix
is numbered array-relative against a session-global prefix.

## Timing windows and dependencies

No temporal window. Cross-pass stability is guaranteed by the producer's memo
check (`module-wire.ts:1041-1048`), not by anything in Rust, so a producer change
that removed the memo would silently destabilise every ordinal-keyed piece of Rust
state with no Rust-side detection.

Depends on `codec-b-harness-decoders-accept-every-input-with-no-rejection-channel`
for the framing. Consumers are in 4a (historian chunking) and 4b (boundary
selection), so the consequence assessment belongs to them; this record establishes
the ingress contract and identifies the disagreement.

## What a test must construct

1. A decode of a fifteen-message array whose `absolute_ordinal` values run 501 to
   515, asserting whatever relationship `boundary.rs` needs. This is the shape
   `module-wire.test.ts:180` already produces on the TypeScript side, so the
   fixture is available.
2. A duplicate-ordinal array modelling the synthetic-borrow case: a persisted
   message at ordinal `N`, a synthetic message also at `N`, and a persisted message
   at `N+1`. Assert a declared outcome.
3. An ordinal-`0` case, per `module-wire.ts:1017`.
4. The mixed-base incremental case: a prefix with explicit session-global ordinals
   and a suffix taking the positional fallback, asserting the halves are
   consistently numbered.
5. A cross-language conformance test asserting the Rust decoder's ordinal
   interpretation matches `module-wire.ts`'s emission, in the style of
   `differential_goldens.rs`.
6. For Pi, an ordinal-stability assertion across a drop.

## Investigation log

### Q: Is `boundary.rs:687-691`'s max-as-count correct for a sparse tail? (Lens A's question)

- Sources examined: `boundary.rs:680-705`; `codec/opencode.rs:34-36`, `:52-60`;
  `codec/pi.rs:45`, `:52`; `transform.rs:20278`, `:27809`, `:27942`;
  `packages/plugin/src/hooks/magic-context/module-wire.ts:980-1058`;
  `module-wire.test.ts:180`, `:195-196`;
  `module-state-sync.test.ts:775`, `:779`.
- Findings: no. The producer's ordinal space is session-global
  (`module-wire.ts:1027-1034`), permits duplicates by design
  (`:999-1018`), and includes zero (`:1017`). `boundary.rs:691`'s
  `unwrap_or(ordered.len() as u64)` shows the consumer reads `max()` as a count.
  Those two readings are incompatible, and a specimen of the incompatible case is
  already in the TypeScript test suite as `absolute_ordinal: 501`.
- Missing evidence: what `ChunkBuilder::finish` does with `total_message_count`.
  That is `boundary.rs` internals, which Lens A owns as a decision unit, and the
  consequence is 4a's and 4b's call.
- Conclusion: resolved with answer, for the half this lens owns. The decoder is
  faithful to the producer's contract; the disagreement is between the producer's
  documented ordinal space and one consumer's arithmetic. Lens A's question should
  be closed with "no, and the reason is that the space is session-global, not
  sparse-by-accident". Whether the resulting chunk estimate is materially wrong is
  deferred to the consumer's owning part, and the record's impact line says so
  rather than overclaiming.

### Q: Is `absolute_ordinal` meant to be a global session ordinal?

- Sources examined: `codec/opencode.rs:34-36`, `:246-262`;
  `module-wire.ts:1020-1052`, `:1408-1409`.
- Findings: yes. `:1028-1031` bases the numbering on `canonicalCount` or an
  explicit `provisionalBase`, never on an array index. `:1408-1409` reads the field
  back from either `raw` or `info`, mirroring the Rust decoder's two-source lookup
  at `codec/opencode.rs:52-55`, so the two sides agree on the field's location. The
  Rust doc comment's phrase "absolute ordinal space inherited from a completed
  lineage descent" is accurate.
- Missing evidence: none.
- Conclusion: resolved with answer. This retires the alternative I had considered,
  that the field might be array-relative and therefore in need of decoder
  validation. It is not, so the record's guarantee is about the *consumer*
  agreeing with the ingress contract, not about the decoder validating input.

### Q: Is `provisional_base` consistent between the two languages?

- Sources examined: `codec/opencode.rs:37-41`, `:56-60`, `:257-261`;
  `module-wire.ts:1028-1031`.
- Findings: on the TypeScript side, `provisionalBase` defaults to `canonicalCount`,
  a session-global quantity. On the Rust side,
  `decode_opencode_sidecar_incremental` passes `replace_from`, an array index, into
  the same parameter at `:260`. The two callers of
  `decode_opencode_with_sidecar_and_base` in `lib.rs` (`:12572`, `:12584`) use
  `decode_opencode`, which passes `0` (`:24`). So the array-relative base is used
  only on the incremental path.
- Missing evidence: whether the incremental path's suffix can ever lack explicit
  ordinals. If the producer always annotates every message
  (`module-wire.ts:1037-1052` annotates all of `annotated`), the fallback never
  fires in production and the mismatch is unreachable.
- Conclusion: unresolved, needs confirmation that the producer annotates every
  message on every pass. `module-state-sync.test.ts:779` asserts
  `expect(inputMessage).not.toHaveProperty("absolute_ordinal")` for some message,
  which is evidence that an unannotated message exists on some path, so I cannot
  conclude the fallback is unreachable.
