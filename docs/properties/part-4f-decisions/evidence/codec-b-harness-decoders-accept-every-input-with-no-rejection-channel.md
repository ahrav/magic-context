# codec-b-harness-decoders-accept-every-input-with-no-rejection-channel

## Discovery trigger

Reapplying Part 1's Group I to this surface
(`docs/properties/part-1-shm-transport/catalog.md:1284-1329`,
`decoder-totality-over-arbitrary-bytes`). Part 1's three decoders return
`Result<_, RingError>`, so its totality property asks whether an arbitrary byte
sequence produces an error instead of a panic. The first thing I checked here was
the return type, expecting the same shape. Both harness decoders return
`DecodedHarnessMessages` with no error type anywhere in either file. That inverts
the question: totality is satisfied trivially, and the property worth stating is
about what the decoder silently accepts.

## Evidence trail

Signatures, read at `HEAD` `e447c927`:

- `crates/mc-module/src/codec/opencode.rs:23-25` — `pub fn decode_opencode(messages: &[MessageV2Json]) -> DecodedHarnessMessages`
- `:27-32` — `decode_opencode_with_sidecar`, same return type
- `:37-41` — `decode_opencode_with_sidecar_and_base`, the real implementation
- `crates/mc-module/src/codec/pi.rs:19-21` — `pub fn decode_pi(entries: &[PiSessionEntryJson]) -> DecodedHarnessMessages`
- `:23-26` — `decode_pi_with_sidecar`, same return type

`MessageV2Json` and `PiSessionEntryJson` are both `pub type _ = Value`
(`opencode.rs:19`, `pi.rs:15`), so the input domain is every `serde_json::Value`.

The OpenCode default ladder, in the order the decoder applies it:

| Missing or malformed | Line | Substituted |
| --- | --- | --- |
| `info` object | `opencode.rs:51` | the whole raw message |
| `absolute_ordinal` | `:52-60` | `provisional_base + index + 1`, saturating |
| `info.id` and `id` | `:61-63` | `opencode-hash-<24 hex of the message>` |
| `info.role` and `role` | `:69-71` | `"user"` |
| `parts` | `:73-77` | `Vec::new()` |
| part `type` | `:83` | the literal `"unknown"`, which falls to `:194-204` |
| `text` on a text part | `:93` | `String::new()` |
| tool `state.input` | `:480-486` | `json!({})` |
| tool `callID` | `:487-490` | `synth-tool-<ordinal>-<index>-<name>-<12 hex>` |
| tool output text | `:516-522` | `""` |
| media `mime` | `:597-599` | `"application/octet-stream"` |
| tool name | `:1264-1268` | `"tool"` |

The Pi equivalent: role defaults to `"unknown"` at `pi.rs:53-57`, which reaches
the catch-all arm at `:80-83`; `toolCallId` and `toolName` default to `"tool"` at
`:261` and `:263`; `arguments` defaults to `json!({})` at `:220`.

Concrete consequence, traced by hand for the input `vec![json!("hello")]`:
`raw_message.get("info")` returns `None` on a `Value::String`, so `info` is the
string itself (`:51`); `string_field(info, "id")` returns `None` because
`Value::get` on a string returns `None`, so `stable_key` becomes
`opencode-hash-<hash of "hello">` (`:63`); role becomes `"user"` (`:71`); `parts`
becomes empty (`:77`); the part loop does not execute; `is_synthetic_message(&[])`
is `false` because of the `!parts.is_empty()` guard (`:1277-1278`). The decoder
returns one `CkIngressMessage` with role `"user"`, zero content blocks, ordinal
1, and a `HarnessMessageMeta` whose `raw` is `Value::String("hello")`. No
diagnostic is produced anywhere.

Panic-site enumeration over the production halves (`opencode.rs:1-1321`,
`pi.rs:1-1077`, `sidecar.rs:1-339`), which is the claim that makes totality hold
at all:

- `debug_assert!` at `opencode.rs:251`, `:252`, `:466`. Compiled out in release.
- Slice index `&messages[replace_from..]` at `opencode.rs:258`. Covered by
  `codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert`.
- `msg.content[block_index]` at `opencode.rs:716` — bounded by the `while
  block_index < msg.content.len()` at `:715`.
- `matched_metas.by_block[block_index]` at `:717` — `by_block` is
  `vec![None; blocks.len()]` (`sidecar.rs:260`), same length as `msg.content`.
- `matched_metas.by_block[block_index + 1]` at `:730` — reached only inside the
  `if let` whose pattern requires `msg.content.get(block_index + 1)` to be `Some`
  (`:727`), so `block_index + 1 < msg.content.len()`.
- `&messages[index]` at `opencode.rs:388`, `:389`, `:405`, `:406`, `:418` —
  bounded by `while index < messages.len()` at `:385`.
- `msg.content[0]` at `pi.rs:393` — reached only inside the `else if matches!` on
  `msg.content.first().map(|b| &b.kind)` at `:389-392`, so content is non-empty.
- `digits.get(..14)?` at `pi.rs:746` — the `?` makes a short string an early
  `None`, not a panic. This is the only free-text scalar parse in either decoder
  and it is written correctly.
- `serde_json::to_value(canonical).unwrap_or(Value::Null)` at `sidecar.rs:155`
  and `serde_json::to_vec(value).unwrap_or_default()` at `:293` and `:300` — both
  infallible-by-fallback rather than infallible-by-construction. Covered by
  `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`.

No production `unwrap()`, `expect()`, `panic!`, `unreachable!`, `todo!`, or
`assert!` exists in any of the three production halves. The one `expect` on this
path is one layer up, at `lib.rs:12588`.

Allocation bound: the largest per-message allocations are `raw_message.clone()`
at `opencode.rs:232` and `raw_entry.clone()` at `pi.rs:114`, plus `raw: raw.clone()`
per block at `opencode.rs:563` and `pi.rs:313`. So retained bytes are
`O(input_size x blocks_per_message)` in the worst case, which for a message of
`n` parts each retaining the same part is `O(n)` copies of `O(1)` parts, not
quadratic in total input. There is no length-driven pre-allocation anywhere:
`Vec::with_capacity(messages.len())` at `opencode.rs:47` is bounded by the actual
slice length, not by a decoded field, which is the specific hazard Part 1 flagged
at `catalog.md:1313-1315`.

## Failure scenario

A harness ships an array element that is not an object, or an object whose
`parts` is an object rather than an array. The decoder produces a well-formed
zero-block `"user"` message. That message:

1. Occupies an ordinal (`opencode.rs:56-60`), so it shifts nothing but is counted.
2. Enters `sidecar.order` and `sidecar.messages` (`:226-236`), so
   `message_for_index` positions shift for nothing but the message is
   addressable.
3. Is eligible for boundary selection and for the positional `meta_for_ck`
   fallback (`sidecar.rs:324-328`), because `is_synthetic_message` returned
   `false`.
4. Re-encodes from its retained raw (`opencode.rs:424`, `:706`), so the malformed
   value is handed back to the harness unchanged.

Nothing downstream can distinguish it from an authentic empty user turn, because
no field records that a substitution happened.

## Timing windows and dependencies

None. Both decoders are pure functions over one immutable slice, with no clock,
no store, and no interior mutability. `codec/mod.rs:78-89` and `:201-212` assert
`decoded == decoded_again` over the goldens, which pins purity.

The dependency that matters is directional: this property is upstream of
`codec-b-decoder-output-can-violate-the-projector-precondition`. Total acceptance
here is what allows a harness-supplied mid containing `#` to reach
`ck_wire.rs:424-426` and fail the whole pass.

## What a test must construct

1. A structured input generator over `Vec<Value>` that includes non-object
   elements, wrong-typed `parts`, wrong-typed `info`, absent `type`, deeply
   nested `metadata`, and duplicate ids.
2. A postcondition oracle, which is the part that does not exist today. At
   minimum: `decoded.len()` equals the number of input elements for OpenCode (and
   is `<=` for Pi, per the drop record); every `mid` in `decoded` appears in
   `sidecar.messages`; every `BlockMeta.native_index` is a valid index into the
   input message's `parts`; `sidecar.order.len() == decoded.len()` unless mids
   collide.
3. An allocation oracle. The natural mechanism is `dhat` per
   `/performance:heap-profile`, asserting peak bytes stay within a constant
   multiple of input bytes.
4. A release-profile run, so the three `debug_assert!`s do not mask the slice
   index at `opencode.rs:258`.

Part 1's equivalent existing check
(`tests/contract.rs:683-706`, ten lengths and two fill bytes) is the shape to
beat, and its own record calls it a smoke test.

## Investigation log

### Q: Should a harness codec have a rejection or warning channel at all?

- Sources examined: both decoder files in full; `codec/sidecar.rs`;
  `ck_wire.rs:19-21` and `:324-337`; `mc-store/src/lib.rs:40-300`;
  `lib.rs:12550-12590`; the module doc comments on all four codec files.
- Findings: the crate holds three different positions on malformed input and
  states none of them as policy. The harness decoders coerce silently. The CK
  serde layer rejects (`mc-store/src/lib.rs:113-115`, `:213-214`, both mapping a
  `CkWireMessageData`/`CkWireBlockData` failure to a serde error). The projector
  rejects with a typed error (`ck_wire.rs:324-337`). `ck_wire.rs:19-21` states a
  no-silent-drop contract but scopes it to the CK serializers only. Neither
  `codec/opencode.rs` nor `codec/pi.rs` has a module doc comment stating an input
  trust model; `opencode.rs` has no module comment at all, and `pi.rs` has none
  either.
- Missing evidence: whether the harness is considered a trusted producer. The
  harness is the plugin in `packages/`, which is first-party, which argues for
  trust. But `TransformRequest.native_messages` (`transform.rs:775`) arrives over
  the wire from a separate process, and Part 1's whole Group F treats a
  first-party peer as potentially buggy
  (`part-1-shm-transport/catalog.md:790-989`).
- Conclusion: needs human input. The technical facts are settled; the question is
  a design decision about the trust boundary, and the crate has not written one
  down for this layer.

### Q: Is the `opencode-hash-` id fallback safe against collisions?

- Sources examined: `opencode.rs:61-67`; `sidecar.rs:57-62`, `:68-73`, `:298-305`.
- Findings: the fallback is `stable_hash_prefix(raw_message, 24)`, 24 hex chars
  of SHA-256, so accidental collision is not the risk. Deliberate duplication is:
  two byte-identical id-less messages produce the same `stable_key`, therefore
  the same `mid`, and `remember_message` pushes to `order` only for a new mid
  (`:58-60`) while unconditionally overwriting `messages` (`:61`). So `decoded`
  gains two entries and `order` gains one. This is observation 23 in the lens.
- Missing evidence: whether two byte-identical id-less OpenCode messages can
  occur. Every real OpenCode message has `info.id`
  (`packages/pi-plugin/PARITY.md:176-178` says so explicitly: "OpenCode messages
  all have intrinsic `info.id`"), so the fallback fires only for synthetic or
  malformed input.
- Conclusion: resolved with answer. Collision resistance is fine; the desync is
  real but reachable only through id-less input, which PARITY.md says OpenCode
  does not produce. Recorded as lens observation 23 rather than as its own
  record, and left for synthesis to promote if the id-less path turns out to be
  reachable through the module's own synthetic writes.
