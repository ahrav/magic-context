# codec-b-decoder-output-can-violate-the-projector-precondition

## Discovery trigger

Reapplying Part 1's `identity-and-schema-rejection-is-one-contract`
(`part-1-shm-transport/catalog.md:1375-1426`), which asks whether every path that
admits a value enforces the same condition set. Part 1's version compares two
sibling readers. Here the decoders enforce nothing, and the only enforcement in
the pipeline sits one stage later, so the question becomes whether a producer and
its consumer agree.

## Evidence trail

The consumer's condition set, `crates/mc-module/src/ck_wire.rs:324-337`, read at
`HEAD` `e447c927`:

```
324: #[derive(Debug, Clone, PartialEq, Eq)]
325: pub enum CkWireError {
326:     MidContainsReservedHash(String),
327:     UnsupportedBlock {
328:         mid: String,
329:         block_index: usize,
330:         kind: String,
331:     },
332:     UnpairedToolResult {
333:         mid: String,
334:         block_index: usize,
335:         tool_call_id: String,
336:     },
337: }
```

All three are constructed, so none is an inert variant: `MidContainsReservedHash`
at `:425`, `UnsupportedBlock` at `:585`, `UnpairedToolResult` at `:660` and
`:667`.

`project_messages` is the entry point, `:364-366`, returning
`Result<FlatProjection, CkWireError>`. It is the only unit in this lens's scope
with an error channel.

### First violation shape: a mid containing `#`

`ck_wire.rs:419-426`:

```
419: fn project_messages_from_state(
420:     messages: &[CkIngressMessage],
421:     mut builder: FlatProjectionBuilder,
422: ) -> Result<FlatProjection, CkWireError> {
423:     for msg in messages {
424:         if msg.mid.contains('#') {
425:             return Err(CkWireError::MidContainsReservedHash(msg.mid.clone()));
426:         }
```

Note `return`, not `continue`. One offending message fails the whole projection.

Where the mid comes from, OpenCode side, `codec/opencode.rs:61-67`:

```
61:         let stable_key = string_field(info, "id")
62:             .or_else(|| string_field(raw_message, "id"))
63:             .unwrap_or_else(|| format!("opencode-hash-{}", stable_hash_prefix(raw_message, 24)));
64:         let mid = sidecar
65:             .inherit_pin(&stable_key)
66:             .unwrap_or_else(|| stable_key.clone());
67:         sidecar.pin_mid(stable_key.clone(), mid.clone());
```

`string_field` (`:1281-1283`) is `value.get(key).and_then(Value::as_str).map(str::to_string)`.
No validation, no normalisation. A harness `info.id` of `"msg#1"` becomes the mid
verbatim.

Pi side, `codec/pi.rs:58-62` with `:710-715`:

```
710: fn pi_stable_key(raw_entry: &Value, message: &Value, entry_index: usize) -> String {
711:     string_field(raw_entry, "id")
712:         .or_else(|| string_field(message, "responseId"))
713:         .or_else(|| message_timestamp(message).map(|ts| format!("pi-ts-{ts}")))
714:         .unwrap_or_else(|| format!("pi-msg-{entry_index}-{}", stable_hash_prefix(message, 24)))
715: }
```

The first two sources are harness strings taken verbatim. The last two are
`#`-free by construction. `first_sight_pi_mid` (`:717-722`) has the same shape.
`decode_opaque_entry` (`:322-326`) also takes `raw_entry["id"]` verbatim.

The `#` reservation exists because `block_id` is `format!("{mid}#{index}")`
(`ck_wire.rs:513-515`). Interestingly the reservation is stricter than its own
parser requires: `split_block_id` (`:517-521`) uses `rsplit_once('#')`, which
recovers `("a#5", 0)` from `"a#5#0"` correctly. So either the reservation defends a
consumer other than `split_block_id`, or it is belt-and-braces. Either way the
decoder does not know about it.

### Second violation shape: an unpaired tool result

`ck_wire.rs:653-673`:

```
653: ) -> Result<Option<String>, CkWireError> {
654:     match &msg.content[index].kind {
655:         CkKind::ToolCall { .. } if msg.role == "assistant" => {
656:             Ok(call_arcs.get(&block_id(mid, index)).cloned())
657:         }
658:         CkKind::ToolResult { id, .. } => {
659:             let Some(queue) = pending_calls.get_mut(id) else {
660:                 return Err(CkWireError::UnpairedToolResult {
661:                     mid: mid.to_string(),
662:                     block_index: index,
663:                     tool_call_id: id.clone(),
664:                 });
665:             };
666:             let Some(call_block_id) = queue.pop_front() else {
667:                 return Err(CkWireError::UnpairedToolResult {
```

`pending_calls` is cleared and repopulated on every assistant message
(`ck_wire.rs:429-435`), so a `ToolResult` can pair only with a call from the most
recent assistant message.

The OpenCode decoder cannot produce an unpaired result from a single part.
`decode_tool_part` (`codec/opencode.rs:472-542`) pushes the call block at
`:502-509` and, when status is `completed` or `error` (`:515`), pushes the result
block at `:530-537` into the same `content` vector with the same `id`. So call and
result are adjacent within one message, and `pending_calls` is populated from that
message's calls before the results are visited.

The Pi decoder can. `codec/pi.rs:77-79` routes a `toolResult` role to
`decode_tool_result_message`, and `:86-90` maps the role to `"tool"`, so each
`toolResult` entry becomes its own CK message holding exactly one `ToolResult`
block. Its matching `toolCall` lives in a *previous* assistant entry. If that
previous entry is dropped by
`codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record`'s mechanism,
or if it is malformed such that its `toolCall` part takes a different arm, the
result has no pending call and the projection fails.

There is a second Pi-specific route to the same failure: the `id` is canonicalised
on both sides through `canonical_tool_id` (`:749-755`), which splits on `|`. The
call side stores `canonical_id` at `:230` and the result side at `:280`. So a call
whose native id is `"c1|item1"` and a result whose native id is `"c1"` both
canonicalise to `"c1"` and pair. But a call whose native id contains no `|` and a
result whose id is `"c1|item1"` also both canonicalise to `"c1"`. That direction is
safe. The unsafe direction would be a native id containing `|` in a position that
changes the split, which `split_once` makes deterministic. I found no defect here;
noted because it is the only id-rewriting either decoder does.

### The composition is untested from both ends

`ck_wire.rs:1122` and `:1149` assert `matches!(err, CkWireError::UnpairedToolResult { .. })`
for hand-built CK inputs, so the projector's rejection has coverage. Nothing
asserts the mid rejection at all. And no test anywhere feeds a decoder's output to
`project_messages`: the codec tests stop at `encode`, and the projection tests
start from hand-built `CkIngressMessage` values.

## Failure scenario

A harness ships one message whose `info.id` contains `#`. Every transform pass for
that session fails at `ck_wire.rs:425` until the message leaves the window. The
error names a reserved character the harness never agreed to avoid, and it is
attributed to the projection rather than to the message that introduced it,
because the decoder that accepted it is two frames away.

The rejection itself is correct and fail-closed. The defect is placement: the only
layer that could normalise the id is the layer that does not know the constraint
exists.

The unpaired-result scenario is worse in one way and better in another: worse
because it compounds with a silent drop, so the visible symptom is a projection
failure whose cause was an entry that no longer exists anywhere; better because
Pi has no production caller today.

## Timing windows and dependencies

No temporal window; both checks are static over one immutable message slice.

The dependency chain is the substance of the record:
`codec-b-harness-decoders-accept-every-input-with-no-rejection-channel` (total
acceptance) enables the mid violation, and
`codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record` (silent drop)
enables the pairing violation. Neither is a defect in isolation; the composition
is.

## What a test must construct

1. A single test that runs every golden case through `decode_opencode` then
   `ck_wire::project_messages`, asserting `Ok`. This is the cheapest coverage in
   this lens: two lines added to `codec/mod.rs:78-89`, and it would pin the whole
   composition for the shapes the golden already holds.
2. An OpenCode message with `info.id = "msg#1"`, asserting a declared outcome.
   Today the outcome is a whole-pass failure and nothing says that is intended.
3. The Pi composition: an entry array with an unrecognised entry between a
   `toolCall` assistant entry and its `toolResult` entry, decoded and projected,
   asserting a declared outcome.
4. A property over generated mids: for arbitrary harness id strings, decode then
   project, asserting either `Ok` or an error attributed to the specific message.

## Investigation log

### Q: Should the decoders normalise or reject `#` in a mid?

- Sources examined: `ck_wire.rs:419-426`, `:513-521`; `codec/opencode.rs:61-67`,
  `:1281-1283`; `codec/pi.rs:58-62`, `:710-722`, `:322-326`; `ck_wire.rs:364-372`.
- Findings: `ck_wire.rs:369-372` states the crate's policy for the analogous
  situation on the incremental path: "malformed or out-of-range local metadata
  falls back to a full projection rather than trusting a partial result." So there
  is precedent for degrading gracefully rather than failing the pass. Nothing
  analogous exists for a malformed mid; the check is an unconditional `return Err`.
  The decoders have two `#`-free fallbacks already (`opencode-hash-...` and
  `pi-msg-...`), so normalising would mean routing an offending id to the existing
  fallback rather than inventing a mechanism.
- Missing evidence: whether a mid is required to be stable across passes for
  reasons that would forbid rewriting it. `codec/opencode.rs:64-67`'s
  `inherit_pin` and `pin_mid` exist precisely to keep a mid stable, so a
  normalisation would have to happen before the pin, once, and then persist.
- Conclusion: unresolved, needs the mid-stability contract, which is 4c's
  territory (the sidecar and native-attachment caches key on mids). The mechanism
  is clear; whether rewriting a mid is safe is not something 4f scope can settle.

### Q: Is `UnsupportedBlock` reachable, or is it an inert variant?

- Sources examined: `ck_wire.rs:578-590`; `codec/sidecar.rs:151-156`, `:292-296`.
- Findings: constructed at `:585` from
  `serde_json::to_string(block).map_err(...)`. `CkWireBlock`'s `Serialize`
  (`mc-store/src/lib.rs:223-236`) either serialises a retained `Value` or a
  `CkWireBlockData` of `CkKind` plus `ProviderExtras`. Neither can fail for a value
  that `serde_json` can represent, and every `Value` in the tree came from
  `serde_json` parsing. So the variant is constructible in principle and
  unreachable in practice.
- Missing evidence: none.
- Conclusion: resolved with answer. Not inert (it is constructed), but effectively
  unreachable. The interesting part is the inconsistency it reveals:
  `codec/sidecar.rs:155` maps the same operation's failure to `Value::Null` and
  `:293` maps it to empty bytes. Three policies for one impossible failure.
  Recorded in the sidecar record's open questions rather than here.

### Q: Does the `canonical_tool_id` split introduce a pairing hazard?

- Sources examined: `codec/pi.rs:749-755`, `:219-241`, `:255-292`, `:757-778`,
  `:417-430`.
- Findings: `canonical_tool_id` uses `split_once('|')`, taking the first `|`. Both
  the call and result paths canonicalise before storing, and `block_matches_meta`
  (`:417-430`) canonicalises the meta's native id before comparing. So the three
  places that compare ids all apply the same transform. `native_tool_id`
  (`:757-778`) reconstructs the native form on encode, preferring an existing raw
  value, then `nativeToolCallId` from extras, then `{id}|{item_id}`. The round trip
  is consistent.
- Missing evidence: none.
- Conclusion: resolved with answer, no defect found. Recorded in the evidence trail
  because it is the only id rewriting either decoder does, and a future change to
  the split character would need all four sites updated together.
