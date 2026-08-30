# Lens B: harness codecs (sub-part 4f)

Attention focus: the encoders and decoders that translate between this crate's
internal CK representation and each external harness's wire format. Primary
material is `crates/mc-module/src/codec/` (4,323 lines across four files) plus
`crates/mc-module/src/ck_wire.rs` (1,279) where it bears on codec contracts, and
`crates/mc-store/src/lib.rs:40-300`, which owns the CK types the codecs produce.

All line references verified against `HEAD` `e447c927`.

Sibling boundaries respected. Lens A owns the pure decision units and the
configuration contract; none of its fourteen `dec-a-` records are repeated here.
Part 4e owns the nudge overlay and the model-visibility half of provenance; its
lens item 18 (`_lenses/lens-b-nudge-overlay.md:373-378`) already records that
`encode_pi` writes no synthetic marker and has no production caller, and item 19
(`:379-382`) already records that `HarnessMeta::synthetic` survives on the CK
wire but is never surfaced to the model. This lens does not re-derive either. It
adds the decode direction, which 4e does not cover.

## Reapplying Part 1's decode-contract group

Part 1's Group I (`docs/properties/part-1-shm-transport/catalog.md:1277-1529`)
established four shapes for a decode surface: decoder totality over arbitrary
bytes (`:1284`), accepted decode consumes its declared width (`:1330`), identity
and schema rejection is one contract (`:1375`), and reserved bytes are rejected
unless zero (`:1427`). Those are the shapes reapplied below. Three differences
change what the shapes mean here.

1. **There is no declared width and no rejection channel.** Part 1's decoders
   return `Result<_, RingError>` over a fixed-length byte array, so "totality"
   means "returns an error rather than panicking". Both harness decoders here
   return `DecodedHarnessMessages` with no error type at all
   (`codec/opencode.rs:23-25`, `codec/pi.rs:19-21`). Totality is therefore free
   and worthless: the interesting question inverts from "does it reject" to "what
   does it silently accept, and what does it silently discard". Records 1, 3, and
   4 carry that inversion.
2. **Rejection is deferred to the next stage, not absent.** The rejection
   contract Part 1 puts inside the decoder lives one layer later here, in
   `project_messages` (`ck_wire.rs:364-366`), the only in-scope decoder returning
   `Result`. It rejects three classes (`ck_wire.rs:324-337`). So Part 1's
   "identity and schema rejection is one contract" becomes a cross-stage
   composition property: the decoder's output must satisfy the projector's
   precondition, and neither codec checks that it does. Record 9.
3. **Reserved-region policy is replaced by a retained-bytes policy.** Part 1's
   grant zeroes four reserved bytes unconditionally, so a decode-then-re-encode
   strips a future field. The CK codec takes the opposite position and says so:
   `ck_wire.rs:19-21` and `mc-store/src/lib.rs:92-95` require the pass-through
   path stay `Value`-level "so harmless unknown fields are not silently
   dropped". The harness codecs sit outside that guarantee, and one of them
   violates its spirit outright. Records 3, 4, and 12.

Part 1's `accepted-decode-consumes-its-declared-width` (`:1330-1373`) has no
literal analogue, because a JSON object has no declared width. Its useful half
survives as "every accepted byte either influences a decoded field or is retained
verbatim for replay", which is exactly what records 3, 4, and 12 test.

## Codec table

Seven translation units, five directions. "Canonical internal form" is what the
unit produces; "Lossy?" is judged against the unit's own stated contract.

| Harness / layer | Direction | Entry points | Canonical internal form | Lossy? |
| --- | --- | --- | --- | --- |
| OpenCode (MessageV2 JSON) | wire to internal | `codec/opencode.rs:23`, `:27`, `:37` | `DecodedHarnessMessages` = `Vec<CkIngressMessage>` + `Option<ExtractedBoundary>` + `DecodeSidecar` (`codec/sidecar.rs:28-34`) | Yes, in the CK view only. Four part types are dropped from `content` (`:193`); `compaction` becomes the boundary and no block (`:161-170`). Both survive re-encode through the retained raw. |
| OpenCode | internal to wire | `codec/opencode.rs:283`, `:298`, `:310`, `:326`, `:374` | `Vec<MessageV2Json>` | Yes, deliberately. A CK tool call plus tool result collapses into one native part (`:754`, `:977-986`), so two internal messages become one wire message. `encode_opencode` also drops `compaction` (`:289-290`) while `encode_opencode_with_session` keeps it (`:305-306`). |
| OpenCode sidecar (incremental) | wire to internal, suffix only | `codec/opencode.rs:246` | `DecodeSidecar` | No, by construction: it splices a prior prefix with a freshly decoded suffix. But it indexes a slice behind two `debug_assert!`s (`:251-258`). |
| Pi (session entries / `AgentMessage`) | wire to internal | `codec/pi.rs:19`, `:23` | same `DecodedHarnessMessages` | Yes, and irrecoverably. An entry that is neither a message nor one of three named opaque types is dropped from `decoded` and from the sidecar (`:41-50`, `:661-669`, `:681-686`). Nothing retains its bytes. |
| Pi | internal to wire | `codec/pi.rs:128` | `Vec<PiSessionEntryJson>` | Yes. `filter_map` lets a message vanish (`:132-136`, `:371`, `:396-397`), so the output array can be shorter than the input. No synthetic marker is written (4e lens item 18). |
| CK wire JSON | both, symmetric | `mc-store/src/lib.rs:110`, `:129`, `:207`, `:223` | `CkWireMessage` / `CkWireBlock` with a retained `original: Option<Value>` | No, by explicit contract (`lib.rs:92-95`, `:195-196`). This is the only unit that both rejects malformed input and preserves unknown fields. `mark_modified` (`:179-181`, `:261-263`) opts a value out of the guarantee. |
| CK to flat projection | internal to internal | `ck_wire.rs:364`, `:373` | `FlatProjection` of `FlatBlock` | Not applicable. The only unit returning `Result`; rejects a mid containing `#` (`:424-426`), an unserializable block (`:585-589`), and an unpaired tool result (`:660-668`). |
| Block identity substrate | shared | `codec/sidecar.rs:151`, `:158`, `:192`, `:229` | `_cortexkit_codec` stamp inside `provider_extras` plus a SHA-256 fingerprint | Yes. The fingerprint is computed over the typed projection only (`:154` clears `original` before hashing), so it is a change detector and not an identity. Zero tests in this file. |

Two facts about the table worth stating plainly. First, only the OpenCode leg has
an in-tree production caller: `lib.rs:12565-12585` hardcodes `decode_opencode`
and `DecodeSidecar::new("opencode")`, and `lib.rs:12671-12688` hardcodes the
OpenCode encoder. `rg` finds no caller of `decode_pi` or `encode_pi` anywhere in
`crates/` or `packages/` outside `codec/pi.rs`'s and `codec/mod.rs`'s own tests.
Pi is a public export (`codec/mod.rs:10`, `lib.rs:12`) with no in-tree consumer.
Second, `codec/sidecar.rs` is the one file every other unit depends on and the
one file with no tests of its own.

The table is not the whole harness surface. `healing.rs:10-28` defines five
`SerializerProfile` variants against these two codecs, so the profile axis is
orthogonal to and larger than the codec axis; see the third open question.

## Observations

Numbered so records and evidence files can cite them.

1. `codec/opencode.rs:23-25` and `codec/pi.rs:19-21` — both harness decoders
   return `DecodedHarnessMessages`, not `Result`. There is no error variant, no
   rejection, and no diagnostic channel anywhere in either decoder.
2. `codec/opencode.rs:51-83` — the OpenCode decoder's default ladder. Missing
   `info` falls back to the whole message (`:51`), a missing id becomes
   `opencode-hash-<24 hex>` (`:63`), a missing role becomes `"user"` (`:71`), a
   missing `parts` becomes the empty array (`:77`), and a missing part `type`
   becomes the literal string `"unknown"` (`:83`), which then falls to the
   opaque arm at `:194-204`. A JSON string or number in the input array decodes
   to a zero-block `"user"` message with no complaint.
3. `codec/pi.rs:52-57` — the Pi decoder's equivalent: a missing role becomes
   `"unknown"` (`:56`), which reaches the catch-all arm at `:80-83` and becomes a
   single opaque block whose kind is the literal `"unknown"`.
4. `codec/opencode.rs:193` — `"snapshot" | "patch" | "agent" | "retry" => {}`.
   These four part types produce no block and no `BlockMeta`. Because
   `MatchedBlockMetas::remove_unretained_native_parts`
   (`codec/sidecar.rs:118-128`) only removes native indices present in
   `decoded_native_indices`, and these four never enter it, they survive
   re-encode inside `meta.raw`. They are invisible to every transform decision
   and present on the wire.
5. `codec/opencode.rs:194-204` — every *unrecognised* part type becomes
   `CkKind::Opaque` carrying `raw: part.clone()`, so OpenCode preserves an
   unknown shape both in the CK view and on the wire.
6. `codec/pi.rs:41-50` — the opposite policy. `pi_message` returns `None`
   (`:661-669`) for any entry that is not `type: "message"` and has no `role`
   key; `is_pi_opaque_entry` (`:681-686`) admits only `custom_message`, `custom`,
   and `branch_summary`. Everything else hits `continue` at `:49` and is gone. It
   is not in `decoded`, not in `sidecar.order`, not in `sidecar.messages`. An
   entry shaped `{"type": "message"}` with no `message` key also vanishes,
   because `:663` returns `None`.
7. `codec/opencode.rs:246-262` — `decode_opencode_sidecar_incremental` guards
   `replace_from <= messages.len()` with `debug_assert!` at `:251` and then
   indexes `&messages[replace_from..]` at `:258`. In a release build the guard is
   compiled out and the index panics. The two in-tree callers do enforce the
   bound: `lib.rs:12550-12563` `validated_native_prefix` filters
   `*replace_from <= native_len` at `:12561`, and `native_sidecar` re-checks
   `trusted_prefix <= snapshot.sidecar.order.len()` at `:12576`.
8. `codec/opencode.rs:370` calls `assert_unique_tool_use_ids`, which is a
   `debug_assert!` (`:462-470`) with no release behaviour at all. The transform
   layer's same-named guard `enforce_unique_tool_use_ids`
   (`transform.rs:11231-11249`) also `debug_assert!`s but adds a
   `#[cfg(not(debug_assertions))]` heal branch at `:11251` that drops the later
   duplicate. So the CK-level check heals in release and the wire-level check,
   which runs last, does nothing. There are two independent
   `duplicate_tool_use_locations` implementations, one per layer
   (`codec/opencode.rs:438-460`, `transform.rs:11235`). Separately, the guard is
   applied inside `encode_opencode_impl`, so the chunk API
   `encode_opencode_chunks_with_transition_state` (`:374`) is unguarded, and
   `lib.rs:12949` calls it directly on the incremental native path. That route has
   no uniqueness check at any build profile.
9. `codec/pi.rs:128-137` — `encode_pi` is a `filter_map`. `encode_with_meta`
   returns `None` from `:371` when no `ToolResult` block is found in a message
   whose meta or raw says `toolResult`, and from `:396-397` when content is empty
   and the raw is not a Pi message. Either drops the entry, so
   `encode_pi(msgs).len() <= msgs.len()` with no signal about which index went
   missing. The OpenCode encoder has no equivalent: every message yields a chunk
   (`:428-433`).
10. `ck_wire.rs:424-426` — `project_messages_from_state` rejects any message
    whose `mid` contains `#`. Both decoders mint the mid from a harness-supplied
    string: `codec/opencode.rs:61-67` takes `info.id` verbatim, and
    `codec/pi.rs:58-62` with `:710-715` takes `id` or `responseId` verbatim.
    Neither validates. One harness id containing `#` fails the whole projection.
11. `ck_wire.rs:653-673` — `arc_for_block` returns `UnpairedToolResult` when a
    `ToolResult` has no pending call. The OpenCode decoder always emits call and
    result adjacently inside one message (`codec/opencode.rs:496-541`), so it
    cannot produce an unpaired result from one part. The Pi decoder puts a
    `toolResult` entry in its own message (`codec/pi.rs:77-79`, `:86-90`), whose
    call lives in a previous entry, so a dropped or malformed preceding entry
    (observation 6) yields an unpaired result and the projection fails.
12. `codec/opencode.rs:52-60` — `absolute_ordinal` is read from the harness
    message (or from `info`) and used verbatim, with the positional
    `provisional_base + index + 1` only as a fallback. There is no monotonicity,
    density, or uniqueness check, and the producer does not want one: the writer
    at `packages/plugin/src/hooks/magic-context/module-wire.ts:1027-1034` numbers
    from a canonical count, `:999-1018` has a synthetic message deliberately
    "borrow the preceding canonical ordinal instead of consuming a slot", and
    `:1017` assigns `0` when no predecessor resolved. So the space is
    session-global, non-dense, duplicate-permitting, and zero-inclusive.
    `boundary.rs:687-691` then uses `max(message_ordinal)` as
    `total_message_count`, with `unwrap_or(ordered.len() as u64)` at `:691` showing
    the consumer reads `max()` as a count. `transform.rs:20278` already supplies
    `"absolute_ordinal": 2_414` in a fixture and `module-wire.test.ts:180` pins
    `501`. `codec/pi.rs:52` always uses `decoded.len() + 1`, so Pi ordinals are
    dense by construction and silently renumber around a dropped entry.
13. `codec/opencode.rs:208` with `:1277-1279` and `codec/sidecar.rs:331-339` —
    provenance recovery on decode is all-or-nothing per message:
    `is_synthetic_message` requires a non-empty `parts` and that *every* part
    carry `synthetic` or `syntheticTodoMarker`. A message mixing one synthetic
    and one authored part decodes as authentic. `codec/pi.rs:99` hardcodes
    `synthetic: false`, so the Pi decoder can never recover provenance from any
    input.
14. `codec/opencode.rs:991-995` — the encoder stamps `synthetic: true` on parts
    only when `msg.meta.synthetic && msg.role == "user"`. A synthetic *assistant*
    or *tool* message gets no marker, except the todo pair, which
    `render_synthetic_todo_pair` marks with `syntheticTodoMarker: true` at
    `:946`. So encode-then-decode preserves provenance for exactly two shapes and
    loses it for every other synthetic non-user message.
15. `codec/sidecar.rs:151-156` — `decoded_block_fingerprint` clones the block,
    removes the `_cortexkit_codec` namespace, calls `canonical.mark_modified()`
    at `:154`, then hashes. Because `mark_modified` clears `original`
    (`mc-store/src/lib.rs:261-263`), the fingerprint covers `kind` plus
    `provider_extras` and nothing else. Two blocks with identical typed cores
    collide by construction, and `push_block` computes the fingerprint *before*
    stamping (`codec/opencode.rs:553-554`, `codec/pi.rs:303-304`), so two
    identical parts in one message get byte-identical fingerprints.
16. `codec/sidecar.rs:158-190` — the stamp lives in `provider_extras` under the
    plain string key `_cortexkit_codec` (`:131`). `provider_extras` is a public
    field deserialized verbatim from CK ingress
    (`mc-store/src/lib.rs:98-127`, `transform.rs:781`), so a CK-wire caller can
    supply a stamp. `has_stamped_block_identity` (`:188-190`) and
    `alignment_candidate` (`:198-227`) trust it with no authenticity check;
    `:204-211` returns early on a stamp match and never consults the kind.
17. `codec/sidecar.rs:155` and `:293` versus `ck_wire.rs:585-589` — three
    different policies for the same serialization failure on the same type.
    `decoded_block_fingerprint` maps it to `Value::Null`, `stable_hash` maps it to
    empty bytes, and `flatten_block` maps it to `CkWireError::UnsupportedBlock`.
    The first two collapse all failures onto one hash.
18. `lib.rs:12587-12588` — `native_sidecar_hash_and_size` calls
    `serde_json::to_vec(meta).expect("OpenCode sidecar metadata must serialize")`.
    This is production code (the nearest `#[cfg(test)]` markers at `:12452`,
    `:12459`, and `:12531` are attributes on enum variants and `let` bindings,
    not a `mod tests` wrapper), and it is the only unconditional panic on the
    sidecar path.
19. `codec/mod.rs:254-271` — `assert_coverage_or_recorded_missing` passes a
    required capture class if it appears in `coverage` **or** in
    `missing_capture_classes`. Both goldens use the escape hatch:
    `testdata/codec/opencode-golden.json` records `subtask` as missing and
    `testdata/codec/pi-golden.json` records `redacted_thinking` as missing. So
    `codec/opencode.rs:171-181` and `codec/pi.rs:199-211` are named as required
    and never executed by the golden.
20. Both goldens carry `projection_oracle.status: "todo"`. The OpenCode reason
    reads "The OpenCode SDK serializer is not vendored in the Rust workspace test
    closure; these goldens assert raw-part identity for wire-reachable parts plus
    sidecar re-attach". The Pi reason is the same shape. So the round-trip oracle
    is input-array identity, not provider wire bytes, by the goldens' own
    admission. Each golden holds exactly one case: 10 OpenCode messages, 11 Pi
    entries.
21. Neither golden case contains an unrecognised part type or entry type. The
    OpenCode case's part types are `step-start`, `reasoning`, `text`, `tool`,
    `step-finish`, `patch`, `file`, `compaction`; the Pi case's entry types are
    `message`, `custom_message`, `compaction`. So observations 5 and 6, the two
    opposed unknown-shape policies, are both unexercised by the round-trip test
    that is taken to cover them.
22. `codec/mod.rs:112-125` — `serve_native_golden_preserves_ingress_and_pins_synthetic_shapes`
    builds four CK messages plus decoded ingress and asserts `encoded[0]`,
    `encoded[1]`, `encoded[2]`, then `&encoded[3..]`. Four leading CK messages
    become three wire messages, because the todo pair collapses. This is the
    encode-then-decode non-identity of observation and table row two, pinned by a
    test that does not name it.
23. `codec/sidecar.rs:57-62` — `remember_message` pushes to `order` only when the
    mid is new, then unconditionally `insert`s. Two input messages sharing a mid
    (identical `info.id`, or two byte-identical id-less messages colliding on the
    `opencode-hash-` fallback at `codec/opencode.rs:63`) therefore yield two
    entries in `decoded` and one in `order`, permanently desynchronising
    `message_for_index` (`:68-73`) for every later message. `meta_for_ck`
    (`:315-329`) prefers the harness id, so both messages resolve to the *last*
    one's raw.
24. `codec/pi.rs:742-747` — `chrono_like_timestamp_ms` filters ASCII digits out
    of a timestamp string and parses the first 14 with `digits.get(..14)?`. This
    is total and allocation-bounded by the input, and it is the only place either
    decoder parses a scalar out of free text. Recorded as clean, for contrast.
25. `differential_goldens.rs:73-104` —
    `dg_golden_vacuity_guard_rejects_one_byte_fixture_perturbation_per_family`
    mutates `case.input["messages"]` and then asserts at `:99-104` that the
    *mutated input* differs from `case.expected.wire`. It never re-runs the CK
    codec on the perturbed value. The assertion cannot fail for any
    implementation of `Serialize`/`Deserialize`, so it does not guard the oracle
    it is named for. The real round-trip is at `:53-61`.

## Candidate properties

Twelve records. Reachability is labelled per record with the evidence that fixed
the label. The reachability evidence for the OpenCode leg is
`lib.rs:12565-12585` and `:12671-12688`; for the Pi leg it is the absence of any
in-tree caller, verified with `rg` over `crates/` and `packages/`.

### codec-b-harness-decoders-accept-every-input-with-no-rejection-channel

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the only decoder inputs anywhere are the two goldens' 21 well-formed values (`codec/mod.rs:57`, `:180`) and the hand-built fixtures in `codec/opencode.rs:1322-2186` and `codec/pi.rs:1078-1499`. No test supplies a non-object array element, and there is no arbitrary-input sweep of any kind.
Guarantee: For every input array, each harness decoder returns a value whose postcondition holds, without panicking, without unbounded allocation, and without producing a message that silently misrepresents its input.
Check: `always` — for arbitrary input, the call returns; `decoded.len()`, `sidecar.order.len()`, and the per-message block counts are consistent with the input; and allocation is bounded by a constant multiple of input size. A panic is a forbidden state with no dedicated detection point, so it is `always(!panic)`; `unreachable` would be wrong because no code location must never execute. This reapplies Part 1's `decoder-totality-over-arbitrary-bytes` (`part-1-shm-transport/catalog.md:1284-1329`), with the postcondition strengthened because there is no error variant to fall back on.
Fault/timing angle: none. Both decoders are pure functions over one immutable slice, exactly as Part 1's three were. The exposure is structural rather than temporal: totality is achieved by a default ladder (observations 2 and 3), not by validation, so every malformation is converted into a plausible-looking decoded message.
Required faults and enabling state: none. An arbitrary `Vec<Value>` is the whole enabling state. The interesting members are a bare string or number as an array element, a `parts` value that is an object rather than an array, and a part whose `type` is absent.
Confidence: high — [evidence](../evidence/codec-b-harness-decoders-accept-every-input-with-no-rejection-channel.md). Signatures read at `HEAD`: `codec/opencode.rs:23-25`, `:27-32`, `:37-41` and `codec/pi.rs:19-21`, `:23-26` all return `DecodedHarnessMessages`. Every fallible extraction in both files was enumerated; all of them are `Option`-combinator chains terminating in `unwrap_or`, `unwrap_or_default`, or `unwrap_or_else`. Panic sites in the production halves (`codec/opencode.rs:1-1321`, `codec/pi.rs:1-1077`): three `debug_assert!` (`opencode.rs:251`, `:252`, `:466`) and one slice index (`:258`), all covered by record two; every other index is bounded by the loop that produced it (`opencode.rs:716-717` by the `while` at `:715`, `:730` by the `.get(block_index + 1)` test at `:727`, `pi.rs:393` by the `matches!` on `.first()` at `:389-392`). No decoder allocates unboundedly; the largest allocations are `raw_message.clone()` at `opencode.rs:232` and `raw_entry.clone()` at `pi.rs:114`, each one input message.
Existing check: partial and indirect. `codec/mod.rs:78-89` and `:201-212` assert decode determinism (`decoded == decoded_again`) over the goldens, which pins purity but not totality. `codec/opencode.rs:1322-2186` (17 tests) and `codec/pi.rs:1078-1499` (14 tests) all use well-formed fixtures. Status `unaudited`. CI runs only `cargo test -p mc-module --test lifecycle_cli` (`.github/workflows/ci.yml:172`), so none of these execute in CI.
Impact: the failure mode is not a crash, it is a fabricated message. A harness that ships a malformed element gets a zero-block `"user"` message that occupies an ordinal, enters the sidecar, participates in boundary selection, and is re-encoded from its retained raw. Nothing downstream can tell it apart from an authentic empty user turn. Part 1's equivalent record could say "the property holds at HEAD and is under-evidenced rather than violated"; this one cannot, because the property as stated is violated by design.
Open questions:
- Should a harness codec have a rejection or warning channel at all, or is total coercion the deliberate contract on the grounds that the harness is trusted? Nothing in either file states a position. (needs human input)

### codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test calls `decode_opencode_sidecar_incremental` with `replace_from > messages.len()`, and no test calls it in a release build.
Guarantee: `decode_opencode_sidecar_incremental` returns a sidecar or a declared error for every `(messages, prior, replace_from)` triple, including triples its callers cannot currently produce.
Check: `always` — for arbitrary `replace_from`, the call returns without panicking. `always` rather than `always-or-unreached` because the function is called on every native-attachment pass with a cached snapshot and a non-zero trusted prefix; the *out-of-range* argument is what is currently unreachable, and that unreachability is a caller property, not a callee property.
Fault/timing angle: none in the callee. The window that matters is a maintenance window rather than a runtime one: the bound is enforced two frames up, in a different file, by two separate filters, and neither cites the callee.
Required faults and enabling state: a caller passing `replace_from > messages.len()`. Reaching it today requires either a new caller, or `validated_native_prefix`'s `:12561` filter changing, or `native_sidecar`'s `:12576` condition changing. In a debug build the `debug_assert!` fires first; in release the slice index panics with "range start index out of range".
Confidence: high — [evidence](../evidence/codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert.md). `codec/opencode.rs:251-258` read at `HEAD`: `debug_assert!(replace_from <= messages.len())` then `&messages[replace_from..]`. Both callers traced and both confirmed to enforce the bound: `lib.rs:12550-12563` filters `*replace_from <= native_len` at `:12561`, and `lib.rs:12565-12585` gates the call on `trusted_prefix > 0 && trusted_prefix <= snapshot.sidecar.order.len()` at `:12576`. Note the second condition bounds `replace_from` against the *sidecar order length*, not against `messages.len()`; the `messages.len()` bound arrives only via `validated_native_prefix`, so the two `debug_assert!`s at `:251` and `:252` are discharged by two different callers' checks.
Existing check: none for the bound. `lib.rs:12452-12453` and `:12457-12459` define `CorruptSidecarForTest` and `CorruptFrontierForTest` modes, and `:12531-12541` deliberately perturbs the projection prefix by `+1` under `cfg(test)` and then re-clamps with `prefix <= projection.message_count()` at `:12543`. That machinery proves the authors thought about a corrupted prefix on the projection path and built a test hook for it; no equivalent hook exists for the sidecar slice. Status `unaudited`.
Impact: a panic inside the transform on the default production path. This is the same shape as Part 1's observation that "narrowing `GRANT_BYTES` turns `ring.rs:430` into an unconditional panic on every call, and no property currently forbids either" (`part-1-shm-transport/catalog.md:1322-1324`): the reasoning that keeps the call safe lives only in the callers, and nothing in the tree records that the callee depends on it.
Open questions:
- Should the function clamp with `messages.len().min(replace_from)` and fall back to a full decode, matching the documented policy at `ck_wire.rs:369-372` that "malformed or out-of-range local metadata falls back to a full projection rather than trusting a partial result"? The projection path already does this; the sidecar path does not. (needs human input)

### codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record

Type: safety
Reachability: test-only
Status: active
Exercised: not yet — no golden case and no unit test supplies an entry whose `type` is outside `{message, custom_message, custom, branch_summary, compaction}`. Observation 21 verifies the Pi golden's 11 entries use only three of those.
Guarantee: An input entry the Pi decoder does not recognise is either represented in the decoded output, retained for replay, or reported; it is not discarded without trace.
Check: `always` — for every input entry, either a `CkIngressMessage` exists whose meta retains the entry's bytes, or the entry's bytes are recoverable from `sidecar.messages`. `always` because the decode loop visits every entry unconditionally.
Fault/timing angle: none. The consequence is temporal only in that it compounds: the dropped entry also shifts every later ordinal, because `codec/pi.rs:52` derives the ordinal from `decoded.len() + 1` rather than from the entry index.
Required faults and enabling state: one Pi session entry with an unrecognised `type` and no `role` key, for example `{"type": "tool_use_v2", "data": {}}`, or the degenerate `{"type": "message"}` with no `message` key.
Confidence: high — [evidence](../evidence/codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record.md). `codec/pi.rs:41-50` read at `HEAD`; `pi_message` at `:661-669` returns `None` unless `type == "message"` (then `raw_entry.get("message")`, itself possibly `None`) or a `role` key is present; `is_pi_opaque_entry` at `:681-686` admits exactly `custom_message`, `custom`, `branch_summary`. The `continue` at `:49` writes nothing. Contrasted against `codec/opencode.rs:194-204`, which routes every unknown part type to `CkKind::Opaque` with `raw: part.clone()`, so the two harness decoders hold opposite policies for the same situation. Also contrasted against the CK layer's stated contract at `ck_wire.rs:19-21`, which requires the pass-through path stay `Value`-level "so harmless future CK fields are not silently dropped".
Existing check: none. `codec/pi.rs:1078-1499` has 14 tests; `codec/pi.rs:1479-1483` asserts `encode_pi(...).is_empty()` for an empty-content message, which is the encoder half of a different drop. Status `unaudited`.
Impact: two consequences, one recoverable and one not. Recoverable: `encode_pi` cannot reproduce the entry, so a decode-then-encode round trip silently truncates the session file. Unrecoverable in the same pass: every later entry's ordinal shifts down by one, so a persisted boundary ordinal or tag keyed to an ordinal now names a different message. Because Pi has no `absolute_ordinal` input (record ten), there is no way for the harness to pin the numbering against this.
Open questions:
- Is the three-type opaque allow-list at `:681-686` a closed set by design, or a list that was meant to grow and did not? `codec/opencode.rs:194-204` suggests the crate's default answer is "preserve unknown shapes". (needs human input)
- Does the TypeScript Pi plugin drop the same entries before the Rust codec sees them? `packages/pi-plugin/PARITY.md:107-116` says Pi "rebuilds `AgentMessage[]` from JSONL every pass", which implies a shaping layer upstream. Unresolved, needs the TypeScript transcript adapter, which is outside 4f scope.

### codec-b-opencode-hides-four-part-types-from-every-transform-decision

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `testdata/codec/opencode-golden.json` includes one `patch` part (message index 2) and the round trip at `codec/mod.rs:88` therefore does pin that `patch` survives re-encode. Nothing covers `snapshot`, `agent`, or `retry`, and nothing asserts the CK-side absence for any of the four.
Guarantee: A part type the OpenCode decoder omits from the CK view is nonetheless byte-preserved on re-encode, and no downstream decision depends on seeing it.
Check: `always` — for every accepted OpenCode message, the re-encoded parts array contains every input part whose type is in `{snapshot, patch, agent, retry}`, at its original index, byte-identical; and no `BlockMeta` claims that index. `always` because the decode arm is unconditional. This is the surviving half of Part 1's `accepted-decode-consumes-its-declared-width` (`part-1-shm-transport/catalog.md:1330-1373`): a byte either influences a decoded field or is retained verbatim, and here it is the second case for four named types.
Fault/timing angle: none at decode. The interaction to check is with `remove_unretained_native_parts` (`codec/sidecar.rs:118-128`), which removes a native index only when it is in `decoded_native_indices` and not in `retained_native_indices`. The four types never enter `decoded_native_indices`, so they are structurally immune to deletion compaction. That immunity is load-bearing and stated nowhere.
Required faults and enabling state: none for the preservation direction; one OpenCode message carrying any of the four part types suffices. For the interesting composition, that message must also have a decoded block deleted, so that `remove_unretained_native_parts` runs with a non-empty removal set.
Confidence: high — [evidence](../evidence/codec-b-opencode-hides-four-part-types-from-every-transform-decision.md). `codec/opencode.rs:193` read at `HEAD`. Traced the preservation path: `encode_with_meta` starts from `meta.raw`'s parts at `:707-711`, only mutates matched indices (`:761-779`), pushes unmatched blocks (`:780`), then filters via `:784`. Confirmed against the golden: the `patch` part at input message index 2 survives `codec/mod.rs:88`'s `assert_eq!(encoded, strip_opencode_compaction(case.messages))`, which strips only `compaction`.
Existing check: partial, and it covers the type by accident rather than by design. `codec/mod.rs:59-76` lists `patch` as a required coverage class and the golden supplies one, so the round trip pins it. `codec/mod.rs:216-252` `codec_conformance_removes_leading_native_blocks_without_reindex_drift` exercises `remove_unretained_native_parts` but on a message with no immune parts. Status `unaudited`.
Impact: correct today, and fragile in one specific direction. Because these four types are invisible to the CK view, the transform's byte accounting, tag numbering, and boundary selection never see them, while the provider does. If any of the four ever carries content large enough to matter to the context budget, the module's measurement of the array is wrong by exactly that amount and no existing check would notice.
Open questions:
- Are all four types genuinely content-free for provider purposes? `patch` is the one that plausibly carries bytes. Unresolved, needs the OpenCode part-schema, which is not vendored (observation 20 records that the SDK serializer is absent from the test closure).

### codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness

Type: safety
Reachability: default-production
Status: active
Exercised: partial — one golden case per harness, `codec/mod.rs:78-89` and `:201-212`, each asserting decode-then-encode against the input array. The reverse direction is asserted nowhere, and both goldens declare their oracle incomplete.
Guarantee: The direction each codec actually claims is decode-then-encode byte identity modulo a declared exception set; encode-then-decode is explicitly not the identity, and the exception set is complete.
Check: `always` — for every accepted input array, `encode(decode(input)) == input` after removing exactly the declared exceptions (`compaction` parts for OpenCode via `codec/mod.rs:273-281`, whole `compaction` entries for Pi via `:283-288`). Stated as `always` and in one direction only, because the other direction is provably false: `codec/mod.rs:112-125` pins four CK messages encoding to three wire messages.
Fault/timing angle: none. The angle that matters is oracle strength, not timing. Both goldens carry `projection_oracle.status: "todo"` with a reason stating the harness serializer "is not vendored in the Rust workspace test closure", so the oracle compares against the retained input array and not against provider wire bytes.
Required faults and enabling state: none for the claimed direction. To make the oracle meaningful, an input containing a shape the retained-raw path does not cover: an unrecognised part or entry type (observations 5, 6, 21), or a mutated block, since an unmutated block short-circuits at `codec/opencode.rs:763-765` and `codec/pi.rs:463-465` and is trivially identical.
Confidence: high — [evidence](../evidence/codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness.md). Both goldens parsed at `HEAD`: `cases` has length 1 in each, with 10 OpenCode messages and 11 Pi entries. `projection_oracle` reasons quoted in observation 20. The asymmetry between the two OpenCode encoders was verified: `encode_opencode` passes `preserve_compaction: false` (`:289-290`) and `encode_opencode_with_session` passes `true` (`:305-306`), which is why the golden's oracle must strip compaction while the native-serving golden at `codec/mod.rs:125` compares `&encoded[3..]` to the raw messages unstripped. The four-to-three collapse was traced to `render_synthetic_todo_pair` (`:916-948`) via `:388-399`.
Existing check: `codec/mod.rs:54-90` and `:177-213`, plus determinism assertions at `:81`, `:87`, `:204`, `:210`. Genuine oracles, not tautologies: they compare against an independently captured input array (`generated_from` names a real `opencode.db` and real Pi JSONL session files), which is materially stronger than the round-trip assertion Part 1 found at `harness.rs:112-116` and characterised as "a tautology over accepted inputs" (`part-1-shm-transport/catalog.md:1360-1361`). The weakness here is breadth and oracle fidelity, not vacuity. Status `unaudited`.
Impact: one case per harness with a self-declared placeholder oracle is the entire evidence base for the property the whole encoder design rests on. The specific gap that matters is that the retained-raw path makes identity nearly automatic for unmutated input, so the test's pass carries much less information than its name implies.
Open questions:
- Should the exception set be declared in code rather than reconstructed in the test's own helpers (`codec/mod.rs:273-288`)? Today the encoder's compaction policy and the test's stripping helper are two independent statements of one rule.
- Can the `projection_oracle` TODO be discharged without vendoring the harness SDKs? If not, the goldens' status is permanent and should say so.

### codec-b-declared-missing-capture-classes-are-never-decoded

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — by construction. The classes are recorded as missing precisely so that no case supplies them.
Guarantee: Every capture class the golden names as required is actually decoded by at least one case, so the decode arm that handles it is executed.
Check: `reachable` — the decode arms at `codec/opencode.rs:171-181` (`subtask`) and `codec/pi.rs:199-211` (redacted thinking) are executed at least once per campaign. `reachable` and not `sometimes`, because the obligation here is location coverage: the arms exist, are named as required, and are provably never entered by the suite that claims to cover them.
Fault/timing angle: none.
Required faults and enabling state: one OpenCode message with a `subtask` part; one Pi assistant entry with a `thinking` part carrying `redacted: true`.
Confidence: high — [evidence](../evidence/codec-b-declared-missing-capture-classes-are-never-decoded.md). `codec/mod.rs:254-271` read at `HEAD`: the filter at `:262-266` retains a required class only when it is absent from both `coverage` and `recorded_missing`, so membership in `missing_capture_classes` satisfies the assertion. Both golden files parsed: `opencode-golden.json` has `missing_capture_classes: ["subtask"]` against a required list including `"subtask"` (`codec/mod.rs:72`), and `pi-golden.json` has `["redacted_thinking"]` against a required list including `"redacted_thinking"` (`:187`). The two decode arms were read and confirmed to be the only handlers for those shapes.
Existing check: the mechanism is the check, and it is the thing being reported. `codec/mod.rs:267-270`'s message, "codec golden neither covers nor records missing classes", is honest about what it enforces: it is a bookkeeping gate, not a coverage gate. Status `unaudited`.
Impact: `subtask` decoding is on the default production path and untested; a `subtask` part currently becomes an opaque block via `:171-181`, and if that arm were deleted the part would fall to `:194-204` and still become an opaque block, so the golden would not move. Pi's redacted-thinking arm is the one with a behavioural difference to lose: `:199-211` produces `CkKind::RedactedReasoning` while the non-redacted branch at `:212-217` produces `CkKind::Reasoning` with a signature, and the two round-trip through different encoder arms (`:543-548` versus `:536-542`).
Open questions:
- Is `missing_capture_classes` intended as a temporary ledger with an owner and a date, or as a permanent waiver? Nothing in `codec/mod.rs` or either golden says. (needs human input)

### codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `codec/opencode.rs:1486-1513` asserts that two encodes of the same input produce identical tool parts, which exercises determinism rather than the duplicate guard. No test constructs a duplicate `callID` in the encoded array.
Guarantee: The encoded OpenCode array contains no two `tool` parts sharing a `callID`, or the duplicate is removed before the array is returned.
Check: `always(!duplicate)` — for every returned `Vec<MessageV2Json>`, the multiset of `callID` values across all `tool` parts has no repeats. `always(!X)` and not `unreachable`, per METHOD's rule: the forbidden thing is a *state* of the returned array, and the guard at `codec/opencode.rs:462-470` is not a code point that must never execute, it is a check that must never find anything.
Fault/timing angle: none temporal. The ordering that matters is layer ordering: the CK-level guard runs first on `ServedMessage` (`transform.rs:12147`), the wire-level guard runs last on the encoded JSON (`codec/opencode.rs:370`). A duplicate introduced *by encoding* is visible only to the second guard, and the encoder's own comment at `:750-753` describes exactly that case: "two independently emitted shells carry the same callID".
Required faults and enabling state: a release build (`debug_assertions` off) plus an input reaching the `parts.push(render_tool_pair_as_part(block, result))` arm at `:754` for a call id that another message already emitted. The comment at `:749-757` says this arm exists because neither half matched a native index, which is the fresh-shell case.
Confidence: high — [evidence](../evidence/codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour.md). `codec/opencode.rs:462-470` read at `HEAD`: the body is `let duplicates = ...; debug_assert!(duplicates.is_empty(), ...)` and nothing else, so in release the function computes a `Vec` and discards it. Compared against `transform.rs:11231-11249`, which `debug_assert!`s at `:11246` and then has `#[cfg(not(debug_assertions))]` at `:11251` opening a heal branch that drops the later duplicate and its paired result. So the two same-named guards diverge in release, and the divergence is in the direction that leaves the wire unprotected. Two independent `duplicate_tool_use_locations` implementations exist, `codec/opencode.rs:438-460` over `MessageV2Json` and `transform.rs:11235` over `ServedMessage`.
Existing check: partial and at the wrong layer. `transform.rs:21509` and `:21522` exercise `enforce_unique_tool_use_ids` including its heal path. Nothing exercises `assert_unique_tool_use_ids`. Status `unaudited`.
Impact: a provider request containing two `tool_use` blocks with one id, which Anthropic-shaped providers reject outright, so the failure mode is a hard request error rather than a degraded reply. The debug build catches it and the shipped build does not, which is the inverse of what a wire-level invariant wants. The guard is also applied inside `encode_opencode_impl` rather than in the chunk API, so `lib.rs:12949`'s direct call to `encode_opencode_chunks_with_transition_state` on the incremental native path has no uniqueness check in any build profile.
Open questions:
- Should the wire-level guard adopt the CK-level heal branch, or should the CK-level heal be removed in favour of failing loud in both? The two layers currently encode two different answers to the same question. (needs human input)
- The scope map (`part-4-module/_lenses/scope-map-and-risk-ranking.md:603`) describes `enforce_unique_tool_use_ids` as one of two "fail-loud production checks". At `HEAD` it is a `debug_assert!` plus a release heal, so it is fail-loud in debug and fail-quiet-and-repair in release. 4e owns that function; flagged here as a lead only.

### codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given

Type: safety
Reachability: test-only
Status: active
Exercised: partial — `codec/pi.rs:1469-1484` `deleted_tool_result_does_not_replay_the_retained_raw_entry` clears a tool-result message's content and asserts `encode_pi(...).is_empty()`, which pins the `:371` drop for the fully-cleared case. The same drop with content that survives but holds no `ToolResult` is uncovered, the `:396-397` drop is uncovered, and no test asserts what a caller should conclude from the shortened array.
Guarantee: Either `encode_pi` returns one entry per input message, or the positions it dropped are recoverable by the caller.
Check: `always` — `encode_pi(msgs, sidecar).len() == msgs.len()`, or the return type carries the dropped indices. `always` because the `filter_map` runs on every call.
Fault/timing angle: none. The composition risk is index drift: callers that pair an encoded entry with the CK message at the same index are wrong after the first drop, and the OpenCode encoder's parallel API returns `EncodedOpencodeChunk` values carrying explicit `start_index` and `end_index` (`codec/opencode.rs:343-348`) precisely so that its own collapse is index-safe. Pi's has no equivalent.
Required faults and enabling state: for the `:371` drop, a message whose meta role is `toolResult` but whose CK content holds no `ToolResult` block, which the transform can produce by reducing a decoded tool-result message. For the `:396-397` drop, a CK message with empty `content` whose matched meta's raw is not a Pi message; this may be unreachable, since only `decode_opaque_entry` produces such a raw and those messages carry exactly one opaque block.
Confidence: high — [evidence](../evidence/codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given.md). `codec/pi.rs:128-137` read at `HEAD`: `filter_map` over `encode_with_meta` (returns `Option<Value>`) and `encode_new_message` (returns `Value`, wrapped in `Some` at `:134`). The two `None` returns are `:371`'s `find(...)?` and `:396-397`'s explicit `return None`. Contrasted against `codec/opencode.rs:428-433`, which pushes a chunk for every message unconditionally, and against `EncodedOpencodeChunk` (`:343-348`), whose `start_index`/`end_index` fields exist so `lib.rs:12949-12961` can splice by position. Reachability label fixed by `rg` over `crates/` and `packages/`: `encode_pi` appears only in `codec/pi.rs` and in `codec/mod.rs:208-209` and `:249`, all inside `#[cfg(test)]`; 4e reached the same conclusion independently at `part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378`.
Existing check: `codec/pi.rs:1469-1484`, which pins the cleared-content drop. Status `unaudited`.
Impact: today, none, because there is no production caller. The record exists because the function is a public export (`codec/mod.rs:10`, `lib.rs:12`) whose contract differs from its OpenCode twin in a way a future caller would not expect, and because 4e's lens item 18 already notes the Pi encode path is off-route, which makes this the moment to write the contract down rather than after it is wired up.
Open questions:
- Should `encode_pi` adopt the `EncodedOpencodeChunk` shape so index mapping is explicit? Unresolved, needs a decision about whether the Pi leg is being wired up at all.

### codec-b-decoder-output-can-violate-the-projector-precondition

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `ck_wire.rs:1122` and `:1149` assert `UnpairedToolResult` is produced for two hand-built CK inputs, so the projector's rejection is pinned. Nothing feeds decoder output to the projector, so the composition is untested from either end.
Guarantee: Every value a harness decoder returns satisfies the preconditions `project_messages` enforces, or the decoder rejects or repairs the input that would violate them.
Check: `always` — for every decoder output, `project_messages(&decoded.messages).is_ok()`. `always` because the projection runs on every transform pass. This is Part 1's `identity-and-schema-rejection-is-one-contract` (`part-1-shm-transport/catalog.md:1375-1426`) reapplied across a stage boundary instead of across two sibling readers: there, two decoders had to agree on one condition set; here, a producer and a consumer must agree, and the producer enforces nothing.
Fault/timing angle: none temporal. The structural angle is that a violation is not local: `project_messages_from_state` returns `Err` on the *first* offending message (`ck_wire.rs:424-426`), which fails the entire projection and therefore the whole pass, not just the one message.
Required faults and enabling state: two independent shapes, both harness-controlled. First, one OpenCode message with `info.id` containing `#`, or one Pi entry with such an `id` or `responseId`; the decoders copy it verbatim into the mid and the projector rejects it. Second, a Pi `toolResult` entry whose preceding `toolCall` entry was dropped by record three's mechanism, which yields a `ToolResult` block with no pending call.
Confidence: high — [evidence](../evidence/codec-b-decoder-output-can-violate-the-projector-precondition.md). `ck_wire.rs:324-337` enumerates the three error variants and all three are constructed: `MidContainsReservedHash` at `:425`, `UnsupportedBlock` at `:585`, `UnpairedToolResult` at `:660` and `:667`. Mid provenance traced: `codec/opencode.rs:61-67` takes `string_field(info, "id")` with no validation, and `codec/pi.rs:58-62` with `:710-715` takes `id` then `responseId` then a timestamp then a synthesised fallback, again unvalidated. Only the last two fallbacks are `#`-free by construction. For the pairing half, confirmed the OpenCode decoder emits call and result adjacently in one message (`codec/opencode.rs:496-541`), so it cannot produce an unpaired result from a single part, while `codec/pi.rs:77-79` with `:86-90` makes each `toolResult` its own message.
Existing check: partial and one-sided. `ck_wire.rs:1122` and `:1149` cover the projector's rejection with hand-built inputs. Nothing covers the mid rejection at all, and no test composes a decoder with the projector. Status `unaudited`.
Impact: a single harness-supplied id containing one `#` character fails every transform pass for that session until the message leaves the window. The rejection is correct and fail-closed; the defect is that it is detected two layers away from the layer that could have normalised it, and the error names a reserved character the harness never agreed to avoid.
Open questions:
- Should the decoders normalise or reject `#` in a mid, so the failure is attributable to one message rather than the whole array? `ck_wire.rs:369-372` documents the fallback-to-full-projection policy for out-of-range metadata; nothing analogous exists for a malformed mid.
- Is `#` reserved because `block_id` is `format!("{mid}#{index}")` (`ck_wire.rs:513-515`)? If so the reservation is stricter than its own parser needs: `split_block_id` (`:517-521`) uses `rsplit_once('#')`, which round-trips a mid containing `#` correctly. So either the rejection defends a consumer other than `split_block_id`, or it is belt-and-braces. Unresolved; needs the set of `block_id` consumers, several of which are in 4b and 4c scope.

### codec-b-absolute-ordinal-is-harness-supplied-and-never-validated

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `transform.rs:20278` supplies `"absolute_ordinal": 2_414` and `:27809` and `:27942` supply `1` and `3`, so the explicit path is exercised. Nothing supplies a duplicate or a zero, which are the producer's two documented non-dense cases, and nothing asserts the relationship between `max(ordinal)` and message count.
Guarantee: Every consumer of a decoded ordinal interprets it in the ordinal space the producer emits, which is session-global, non-dense, duplicate-permitting, and zero-inclusive.
Check: `always` — for every decoded array, any consumer computing a message count from ordinals agrees with `decoded.len()`. `always` because the ordinal is assigned to every decoded message on every pass. Stated over the consumer's interpretation rather than over the decoder's validation, because the producer's contract makes the decoder's verbatim pass-through correct.
Fault/timing angle: no temporal window in Rust. Cross-pass ordinal stability is guaranteed on the producer side by a memo mismatch check (`packages/plugin/src/hooks/magic-context/module-wire.ts:1041-1048`), not by anything in this crate, so a producer change that dropped the memo would destabilise every ordinal-keyed piece of Rust state with no Rust-side detection.
Required faults and enabling state: none. A window into the tail of a long session is the whole enabling state: the producer bases the numbering on a canonical count (`module-wire.ts:1028-1031`), so a fifteen-message window of a 500-message session carries ordinals around 501-515. `module-wire.test.ts:180` pins `absolute_ordinal: 501` as a real value.
Confidence: high — [evidence](../evidence/codec-b-absolute-ordinal-is-harness-supplied-and-never-validated.md). `codec/opencode.rs:52-60` read at `HEAD`; the fallback is `provisional_base.saturating_add(index).saturating_add(1)`, so the fallback is dense and monotonic and the explicit path is unconstrained. The producer was then read, which changed the finding: `module-wire.ts:1027-1034` numbers from `canonicalCount` or an explicit `provisionalBase`, never from an array index; `:999-1018` states that a synthetic message "borrows the preceding canonical ordinal instead of consuming a slot", so duplicate ordinals are deliberate; `:1017` assigns `0` when there is no resolved predecessor. `boundary.rs:687-691` computes `total_message_count` as `max()` with `unwrap_or(ordered.len() as u64)` at `:691`, which is direct evidence the consumer reads `max()` as a count. `codec/pi.rs:52` and `:45` confirmed to use `decoded.len() + 1`, so Pi is dense-but-unstable where OpenCode is stable-but-sparse.
Existing check: none for the invariant, in either language. `codec/opencode.rs:246-281`'s incremental path and `lib.rs:12550-12563`'s prefix validation both reason about positions, not ordinals. Status `unaudited`.
Impact: this record answers the open question Lens A left for this lens (`_lenses/lens-a-decision-units-and-config.md:589-593`), and the answer is that max-as-count is wrong, not merely fragile: the producer's ordinal space is session-global by design and permits duplicates by design, so `boundary.rs:687-691` disagrees with the ingress contract for every windowed session rather than only for a contrived one. Whether the resulting chunk estimate is materially wrong is 4a's and 4b's call, since `ChunkBuilder::finish` is theirs; the decoder's contribution is that it faithfully passes through a space one consumer was not written for.
Open questions:
- Should `boundary.rs:687-691` take `ordered.len()` instead of `max()`, or does it genuinely want the highest ordinal for a different reason? Needs the `ChunkBuilder::finish` contract, which is 4a and 4b scope.
- Why does Pi have no `absolute_ordinal` equivalent, given that `codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record` makes its positional numbering unstable? Unresolved.
- Can an incremental suffix ever lack explicit ordinals? `decode_opencode_sidecar_incremental` passes `replace_from` (an array index) as `provisional_base` at `:260`, while the producer's base is a canonical count, so the two bases are in different spaces. `module-state-sync.test.ts:779` asserts some message has no `absolute_ordinal`, so I could not conclude the fallback is unreachable.

### codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `codec/mod.rs:128-175` `fresh_boundary_prefix_does_not_borrow_persisted_synthetic_meta` builds a persisted message whose single part carries `synthetic: true` and asserts at `:174` that it re-encodes byte-identically, which exercises the all-synthetic recovery path. Nothing covers a mixed-parts message, and nothing covers Pi.
Guarantee: A codec that reads a message the module previously wrote recovers the same synthetic-versus-authentic classification the module assigned.
Check: `always` — for every message the module encodes with `meta.synthetic == true`, decoding the encoded form yields `meta.synthetic == true`. `always` because the classification is computed for every decoded message.
Fault/timing angle: the window is a pass boundary. Provenance is lost only when a module-authored message survives into the next pass's ingress, which is the normal case for a persisted m0, m1, or injected pair.
Required faults and enabling state: for the mixed-parts hole, one OpenCode message with one synthetic part and one authored part. For the role hole, a synthetic assistant or tool message that is not the todo pair. For Pi, any input at all.
Confidence: high — [evidence](../evidence/codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only.md). `codec/opencode.rs:1277-1279` read at `HEAD`: `!parts.is_empty() && parts.iter().all(is_synthetic_part)`, so an empty-parts message and a mixed-parts message both classify as authentic. `is_synthetic_part` at `codec/sidecar.rs:331-339` accepts `synthetic` or `syntheticTodoMarker`. Encoder side: `codec/opencode.rs:991-995` stamps `synthetic: true` on every part only when `msg.meta.synthetic && msg.role == "user"`; `render_synthetic_todo_pair` at `:941-947` stamps `syntheticTodoMarker: true`. `codec/pi.rs:99` hardcodes `synthetic: false` with no read of any input field. Part 4e is cited rather than re-derived for the two halves it owns: `part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378` for the Pi encoder writing no marker and having no production caller, and `:379-382` for `HarnessMeta::synthetic` surviving on the CK wire while never reaching the model. This record adds only the decode direction and the all-or-nothing condition, neither of which appears in 4e.
Existing check: `codec/mod.rs:128-175` for the all-synthetic path, and `codec/mod.rs:290-298` `fixture_builder_drives_synthetic_todo_wire_shape`, which asserts `message["meta"]["synthetic"] == true` on the native fixtures. Neither covers a mixed message. Status `unaudited`.
Impact: the module's own writes can come back classified as user-authored. `meta.synthetic` gates `meta_for_ck`'s positional fallback (`codec/sidecar.rs:324-328`), so a misclassified module-authored message becomes eligible to inherit a native envelope by position, which is the failure `codec/mod.rs:128-175` exists to prevent for the other direction. Pi's hardcoded `false` means the Pi leg has no provenance at all in either direction; combined with 4e's finding this leaves synthetic content indistinguishable from authentic content for that harness at every layer.
Open questions:
- Is all-parts-synthetic the intended rule, or should any synthetic part mark the message? The `!parts.is_empty()` guard suggests the author considered degenerate cases, which makes the mixed case look unconsidered rather than decided. (needs human input)
- Should `codec/pi.rs:99` read a marker at all, given 4e's finding that the Pi encoder writes none? The two halves are consistent with each other and jointly inconsistent with the OpenCode leg.

### codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `codec/sidecar.rs` has zero `#[test]` functions. Everything in it is covered only incidentally through the two harness codecs' goldens, which supply no duplicate-content blocks and no caller-supplied stamp.
Guarantee: The block-identity stamp that the encoder trusts to align a mutated block with its native part is authentic, and the fingerprint stored beside it distinguishes blocks that differ.
Check: `always` — for every block the encoder aligns via a stamp, that stamp was written by `stamp_block_identity` during this decode, and no two distinct native parts in one message share a fingerprint without the stamp separating them. `always` because the alignment runs for every block of every encoded message.
Fault/timing angle: none temporal, but the ordering inside `push_block` is load-bearing and undocumented: `codec/opencode.rs:553-554` and `codec/pi.rs:303-304` compute the fingerprint *before* stamping, so the fingerprint is deliberately stamp-independent, which is what makes it stable across passes and also what makes it collide for identical content.
Required faults and enabling state: for the collision half, one OpenCode message with two byte-identical parts. For the trust half, a CK ingress message carrying `provider_extras["_cortexkit_codec"]` with plausible `blockIndex`, `nativeIndex`, and `decodedFingerprint` values; `TransformRequest.messages` is `Vec<CkIngressMessage>` (`transform.rs:781`) and `CkWireBlock`'s `Deserialize` (`mc-store/src/lib.rs:207-221`) reads `provider_extras` verbatim.
Confidence: high — [evidence](../evidence/codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity.md). `codec/sidecar.rs:131-134` gives the namespace and three keys as plain string constants. `stamped_block_identity` at `:177-183` reads them back with no provenance check; `alignment_candidate` at `:204-211` returns early on a stamp match, never consulting `kind_matches`, so a forged stamp outranks the kind check. `decoded_block_fingerprint` at `:151-156` calls `canonical.mark_modified()` at `:154`, which clears `original` (`mc-store/src/lib.rs:261-263`), so the hash covers `kind` plus `provider_extras` only and is blind to the retained pass-through bytes the CK contract at `mc-store/src/lib.rs:92-95` exists to preserve. `block_is_unchanged` at `:192-196` is fingerprint-only. The mitigating fact was checked and holds: the harness decoders never route input into `_cortexkit_codec`, since `block_with_metadata` (`codec/opencode.rs:567-577`) writes under the `"opencode"` key, so the forged-stamp path is reachable from CK ingress and not from harness ingress.
Existing check: none in `codec/sidecar.rs`. `codec/opencode.rs:1515-1582` and `codec/pi.rs:1436-1443` exercise alignment after a block deletion and an encode replay, which covers the honest path. Status `unaudited`.
Impact: two shapes. The forged stamp lets a CK caller point a block at a native part it did not come from, and `alignment_candidate`'s early return means the kind check that would otherwise catch the mismatch is skipped, so the encoder can write a text block's content into a reasoning part. The fingerprint collision is contained today because the stamp disambiguates duplicates, which makes the stamp the sole load-bearing disambiguator for a case the fingerprint cannot handle: if the stamp were ever dropped from the pass-through path, duplicate-content blocks would align by the `:225-227` positional fallback instead, silently.
Open questions:
- Should the stamp carry a per-decode nonce so a stamp from a prior pass or a foreign caller is distinguishable? The comment at `:243-247` says the stamps "survive reductions, overlays, and deletion compaction", which is the property that makes them useful and also the reason they cannot be validated by age.
- Which of the three serialization-failure policies is normative? `:155` maps a failure to `Value::Null`, `:293` maps it to empty bytes, and `ck_wire.rs:585-589` maps it to `CkWireError::UnsupportedBlock`. The first two collapse every failing block onto one hash, which `block_is_unchanged` would then read as "unchanged".

## Contract-vs-code leads

Each lead cites both sides. Leads that became records are not repeated.

1. **The CK differential golden's vacuity guard cannot fail.**
   `differential_goldens.rs:73-104`
   (`dg_golden_vacuity_guard_rejects_one_byte_fixture_perturbation_per_family`)
   mutates `case.input["messages"]` at `:80-97` and then asserts at `:99-104`
   that the mutated *input* differs from `case.expected.wire`. The codec is never
   invoked on the perturbed value. Contrast `:53-61`, the real round trip, which
   does `serde_json::from_value::<Vec<CkWireMessage>>` then `to_value` and
   compares. The test's name claims it proves the fixture is sensitive to one
   byte; what it proves is that appending `"x"` to a string changes it. This is
   the same defect class Part 1 recorded at `catalog.md:1360-1361` ("on this
   commit the assertion is a tautology over accepted inputs"), and it is
   load-bearing here because the CK codec is the one unit whose losslessness
   guarantee is stated as a contract (`mc-store/src/lib.rs:92-95`). Recommend
   synthesis promote this to a record; it is listed as a lead only to keep this
   lens at twelve.
2. **`ck_wire.rs:19-21` states a no-silent-drop contract that the harness codecs
   sit outside.** The comment reads: "The re-exported CK message/block
   serializers retain the original `serde_json::Value` for pass-through. That
   must remain a Value-level replay path, not a typed-struct round-trip, so
   harmless future CK fields are not silently dropped." The guarantee is real for
   the CK layer (`mc-store/src/lib.rs:110-145`, `:207-236`). It says nothing
   about the harness layer, where `codec/pi.rs:41-50` silently drops whole
   entries and `codec/opencode.rs:193` silently drops four part types from the
   typed view. A reader who takes `ck_wire.rs:19-21` as the crate's policy on
   unknown data will be wrong about two of the five codec directions.
3. **`codec/sidecar.rs:158-175`'s doc comment describes a guarantee its own type
   cannot provide.** `has_stamped_block_identity` at `:185-190` is documented as
   "True when a decoded block still carries its exact native-part origin". It is
   true when the block carries three well-formed fields under a public string
   key, which is not the same claim. Recorded as
   `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`;
   listed again because the overclaim is in prose, not only in behaviour.
4. **`packages/pi-plugin/PARITY.md:172-175` says the `pi-msg-<index>` id scheme
   was migrated away; `codec/pi.rs:714` still mints it.** The parity document
   describes `pi_stable_id_scheme` (migration v25) as "a one-time forced-execute
   cutover that re-keys persisted tag/drop/caveman/placeholder state from
   `pi-msg-<index>` ids to real `SessionEntry` ids". The Rust decoder's
   last-resort stable key is `format!("pi-msg-{entry_index}-{}", ...)`. The Rust
   form appends a content hash so it is not byte-identical to the migrated-away
   shape, and it fires only when `id`, `responseId`, and both timestamps are all
   absent. Either the migration's premise is stale or the Rust fallback
   reintroduces the shape the migration removed. Unresolved; needs the
   TypeScript migration, which is outside 4f scope.
5. **`packages/pi-plugin/PARITY.md:163-171` describes `synth-user-<realId>`
   folding of `toolResult` runs as a Pi-only mechanism; the Rust Pi codec does
   not fold.** `codec/pi.rs:77-79` with `:86-90` maps each `toolResult` entry to
   its own CK message with role `"tool"`. No folding exists anywhere in
   `codec/pi.rs`. Most likely the folding lives in the TypeScript transcript
   adapter upstream of the Rust codec, which would mean the Rust Pi codec has
   never seen a real Pi transcript in production and its golden is generated from
   raw JSONL (`pi-golden.json`'s `generated_from.session_files`) rather than from
   what the plugin would hand it. If so, the Pi golden's oracle is testing the
   wrong input shape. Unresolved; needs the TypeScript adapter.
6. **`packages/pi-plugin/PARITY.md:792-797` says Pi "deliberately drops thinking
   parts and image payloads"; `codec/pi.rs` decodes both.** Thinking is decoded
   at `:194-218` and images at `:159-162` and `:873-875`. Same resolution as lead
   five: the shaping is upstream, so the Rust codec's coverage of these shapes is
   either dead or the parity claim is scoped to a different layer than a reader
   would assume. The consequence matters for `redacted_thinking`, which record
   six shows is required-but-unexercised.
7. **`lib.rs:12588`'s `expect` is the only unconditional panic on the sidecar
   path, and its message names a guarantee nothing establishes.**
   `serde_json::to_vec(meta).expect("OpenCode sidecar metadata must serialize")`.
   `HarnessMessageMeta` (`codec/sidecar.rs:84-94`) contains `raw: Value` and a
   `Vec<BlockMeta>` each with its own `raw: Value`, all of which come from harness
   input. Serializing a `Value` tree cannot fail for any value `serde_json` can
   parse, so the `expect` is sound; the point is that the same operation is
   treated as fallible three lines of reasoning away, at `ck_wire.rs:585-589` and
   `codec/sidecar.rs:155`. Three policies for one operation is the finding.
8. **Two independent `duplicate_tool_use_locations` implementations.**
   `codec/opencode.rs:438-460` walks `MessageV2Json` parts; `transform.rs:11235`
   walks `ServedMessage` content. They compute the same predicate over two
   representations of the same data and are maintained separately. Same shape as
   Lens A's `dec-a-model-key-lookup-walk-has-two-implementations-that-disagree`
   (`_lenses/lens-a-decision-units-and-config.md:389`); no disagreement found
   between these two, but neither cites the other.
9. **A second unguarded slice index of the same class as record two, outside this
   lens's footprint.** `lib.rs:12945` in `attach_native_messages_incremental`
   (`:12760`) computes `response.messages()[suffix_start..]`, where `suffix_start`
   comes from a *cached* chunk's `start_index` (`:12921-12930`) and
   `response.messages()` is the *current* response. There is no `debug_assert!`
   and no clamp on the path I read. `lib.rs:12936` also carries a production
   `expect("compatible native cache has a snapshot")`. This is 4c or 4d material,
   not 4f; flagged because it is the same shape as
   `codec-b-incremental-sidecar-slice-panics-behind-a-debug-assert` and the two
   should be assessed together. Unresolved; needs the `cache_compatible` and
   `common` derivations above `:12920`, which are outside this lens's footprint.

## Open questions

- Should Part 4f treat a property whose only existing check lives in a test
  binary CI never runs as `Exercised: partial` or `Exercised: not yet`? Every
  `partial` above follows Lens A's convention
  (`_lenses/lens-a-decision-units-and-config.md:571-576`): `partial` means a
  check exists and covers this much, independent of whether CI executes it. CI
  runs only `cargo test -p mc-module --test lifecycle_cli`
  (`.github/workflows/ci.yml:172`), so none of the 37 codec tests execute there.
  If the ruling goes the other way, six of these twelve records change label.
  (needs human input)
- Is the Pi codec live, dead, or pending? It has no in-tree caller outside its
  own tests, it is a public export, `packages/pi-plugin/` is a full TypeScript
  implementation, and leads five and six suggest the Rust Pi codec's input shape
  may not match what the plugin produces. Three of these twelve records are
  labelled `test-only` on that basis, and all three would become
  `default-production` if it is being wired up. This is the single highest-value
  question in this lens. (needs human input)
- Is there a third harness codec? No, and the reason is worth recording: the
  harness-codec axis and the serializer-profile axis are orthogonal and of
  different sizes. `healing.rs:10-28` defines five `SerializerProfile` variants
  (`OwnedLlmRunner`, `OwnedBroca`, `ClaudeCodeAnthropic`, `OpencodeAiSdk`, `Pi`,
  with wire ids at `:31-39`), while `codec/` holds two harness codecs. So
  `SerializerProfile::Pi` is selectable (`lib.rs:19151` enumerates its wire id in
  a test, and `transform.rs:2752` and `:3377` parse the request field) even though
  `encode_pi` has no production caller, and `ClaudeCodeAnthropic`
  (`transform.rs:2221`, `:12134`) is served through the OpenCode codec with a
  different post-encode healing pass rather than through a codec of its own.
  Whether a profile can be paired with the wrong codec is not checked anywhere I
  found. Unresolved; the profile contract is 4e scope, but the pairing is a seam
  neither part owns.
- Does any test compose a harness decoder with `project_messages`? I found none.
  Record nine's composition is untested from both ends, and a single test that
  ran every golden case through `decode` then `project_messages` would cover it
  for almost no cost. Unresolved, needs a decision at synthesis about whether to
  propose it in `fault-map.md`.
- What is the intended lifetime of `missing_capture_classes`? Record six treats
  it as a permanent waiver because nothing bounds it. If it is meant to be
  temporary, the goldens need an owner and a date, and the mechanism at
  `codec/mod.rs:254-271` needs to fail after that date. (needs human input)
- Are the OpenCode goldens still representative? `opencode-golden.json`'s
  `generated_from.db_path` is `/Users/ufukaltinok/.local/share/opencode/opencode.db`
  and `pi-golden.json`'s `generated_from.session_files` are absolute paths under
  the same home directory. Neither can be regenerated by anyone else, which makes
  both goldens unreproducible artifacts. Unresolved; needs a generator that runs
  from committed inputs.
