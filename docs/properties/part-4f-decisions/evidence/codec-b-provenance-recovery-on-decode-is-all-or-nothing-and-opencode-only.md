# codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only

## Discovery trigger

Task item six asked me to verify what each codec does with provenance rather than
re-derive a sibling's finding. Part 4e owns the encode side and the
model-visibility question. Reading its lens first
(`part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-382`) showed the decode
direction is not covered there, so that is what this record adds.

## What 4e already established, and is not re-derived here

`part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378`, item 18: "the pi
encoder emits no synthetic marker of any kind; the injected assistant half becomes
an ordinary `role: \"assistant\"` entry with `\"stopReason\": \"stop\"`
(`:595-603`). `encode_pi` has no caller outside `codec/mod.rs`'s own tests
(`codec/mod.rs:208-209`, `:249`), so the pi encode path is not on a production
route today."

`:379-382`, item 19: "`mc-store/src/lib.rs:59-75` — `HarnessMeta::synthetic` is
serialized on the CK wire, so the host can always distinguish the injected pair
from real agent work. That distinction stops at the host; nothing in the module
marks the pair for the model."

And `part-4e-rendering/evidence/nudge-b-injected-todo-pair-carries-no-provider-visible-provenance.md:96`
records the code's own concession, `transform.rs:8525`: "CK intentionally has no
transport-origin field for this Claude Code shape."

I verified all three citations resolve and say what 4e reports. This record takes
them as settled.

## Evidence trail: the decode direction

### The OpenCode recovery condition is all-or-nothing

`crates/mc-module/src/codec/opencode.rs:208`, read at `HEAD` `e447c927`:

```
208:         let synthetic = is_synthetic_message(&parts);
```

`:1277-1279`:

```
1277: fn is_synthetic_message(parts: &[Value]) -> bool {
1278:     !parts.is_empty() && parts.iter().all(is_synthetic_part)
1279: }
```

`codec/sidecar.rs:331-339`:

```
331: pub(crate) fn is_synthetic_part(part: &Value) -> bool {
332:     part.get("synthetic")
333:         .and_then(Value::as_bool)
334:         .unwrap_or(false)
335:         || part
336:             .get("syntheticTodoMarker")
337:             .and_then(Value::as_bool)
338:             .unwrap_or(false)
339: }
```

Two consequences of `all`:

1. A message with zero parts is authentic, by the `!parts.is_empty()` guard. That
   guard is deliberate, and it means the degenerate case was considered.
2. A message with one synthetic part and one authored part is authentic. Nothing in
   the file suggests that case was considered.

Note also that `parts` at `:208` is the *raw* parts array captured at `:73-77`,
before the decode loop, so parts that the loop skipped (the `ignored` text at
`:86-92`, the four omitted types at `:193`, `compaction` at `:161-170`) still
count toward the `all`. A message consisting of one synthetic text part and one
`compaction` part is therefore authentic, because `compaction` carries no
`synthetic` field.

### The OpenCode encoder marks only two shapes

`codec/opencode.rs:991-995`:

```
991:     if msg.meta.synthetic && msg.role == "user" {
992:         for part in &mut parts {
993:             set_value(part, "synthetic", Value::Bool(true));
994:         }
995:     }
```

So a synthetic **user** message gets every part marked. A synthetic assistant or
tool message gets nothing from this path.

The one exception, `render_synthetic_todo_pair` at `:916-948`:

```
941:     Some(json!({
942:         "type": "tool",
943:         "callID": id,
944:         "tool": name,
945:         "state": value,
946:         "syntheticTodoMarker": true,
947:     }))
```

reached from `:388-399`, which requires both messages synthetic, roles
`assistant` then `tool`, matching ids, an id prefixed `mc_synthetic_todo_`
(`:935`), and a `CkOutputKind::Json` output (`:938`).

So encode-then-decode preserves `meta.synthetic` for exactly two shapes: a
synthetic user message, and the todo pair. Every other synthetic message loses it.
`encode_with_meta` (`:701-809`) never stamps a synthetic marker at all; it relies
on the retained raw, which is correct for a message that arrived with one and
wrong for a module-authored message that acquired a meta by the positional
fallback.

### The Pi decoder cannot recover provenance at all

`codec/pi.rs:91-102`:

```
 91:         let ck = CkWireMessage::from_parts(
 92:             ck_role.to_string(),
 93:             content,
 94:             origin,
 95:             ProviderExtras::new(),
 96:             HarnessMeta {
 97:                 harness_id: Some(mid.clone()),
 98:                 ordinal: Some(ordinal),
 99:                 synthetic: false,
100:                 ..Default::default()
101:             },
102:         );
```

`synthetic: false` is a literal. `decode_opaque_entry` does the same at `:345`.
There is no read of any input field anywhere in `codec/pi.rs` that could set it,
which I confirmed by searching the file for `synthetic`: the only occurrences are
these two literals. So even if the Pi encoder wrote a marker, the Pi decoder would
not read it. Combined with 4e's item 18, the Pi leg has no provenance in either
direction, and the two halves are self-consistent while being jointly inconsistent
with OpenCode.

### Why the classification is load-bearing

`codec/sidecar.rs:315-329`:

```
315: pub fn meta_for_ck<'a>(
316:     sidecar: &'a DecodeSidecar,
317:     msg: &'a crate::ck_wire::CkWireMessage,
318:     index: usize,
319: ) -> Option<&'a HarnessMessageMeta> {
320:     msg.meta
321:         .harness_id
322:         .as_deref()
323:         .and_then(|mid| sidecar.message_by_mid(mid))
324:         .or_else(|| {
325:             (!msg.meta.synthetic)
326:                 .then(|| sidecar.message_for_index(index))
327:                 .flatten()
328:         })
329: }
```

`:325` gates the positional fallback on `!synthetic`. So a message misclassified as
authentic becomes eligible to inherit a native envelope by position. That is
exactly the failure `codec/mod.rs:128-175`
(`fresh_boundary_prefix_does_not_borrow_persisted_synthetic_meta`) exists to
prevent, and the comment at `codec/opencode.rs:419-421` states it: "A positional
synthetic fallback can instead attach an input nudge's native envelope to a fresh
module-authored m0/m1 message."

So the two directions are linked: the encoder's failure to mark a synthetic
assistant message causes the decoder to classify it authentic, which makes it
eligible for the positional fallback the existing test guards against from the
other side.

## Failure scenario

The module writes a synthetic assistant message that is not the todo pair. On the
next pass:

1. `encode_new_message` produces `{"info": {"id": ..., "role": "assistant"},
   "parts": [...]}` with no marker (`codec/opencode.rs:991-995` does not fire for
   a non-user role, and `:1015` builds the info without one).
2. The harness persists it.
3. The next decode reads it back: `is_synthetic_message` sees no synthetic part,
   so `meta.synthetic` is `false`.
4. The message is now indistinguishable from agent-authored assistant content. It
   is eligible for the positional `meta_for_ck` fallback at
   `codec/sidecar.rs:324-328`, and any transform decision gated on
   `meta.synthetic` treats it as authentic.

The mixed-parts variant of the same failure needs no module bug at all: a single
OpenCode message carrying one synthetic part and one authored part decodes as
authentic today.

## Timing windows and dependencies

The window is a pass boundary. Provenance is lost only when a module-authored
message survives into the next pass's ingress, which is the normal case for a
persisted m0, m1, or injected pair. Within one pass, `meta.synthetic` is whatever
the module set, so nothing is wrong.

Depends on: nothing. Depended on by
`codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given`, whose drop
behaviour is reached through `meta_for_ck`, which this classification gates.

Boundary with 4e: 4e owns whether the model can see provenance (it cannot) and the
Pi encoder's silence. This record owns the decoder's recovery condition. The two
compose into a complete picture that neither states alone.

## What a test must construct

1. An OpenCode message with one part carrying `synthetic: true` and one part
   without, asserting a declared `meta.synthetic`. It is `false` today and nothing
   says that is intended.
2. A round trip for a synthetic assistant message that is not the todo pair:
   construct it with `meta.synthetic = true`, encode with
   `encode_opencode_with_session`, decode, assert `meta.synthetic` is still `true`.
   It fails today.
3. The `compaction` interaction: a message with one synthetic text part plus a
   `compaction` part, asserting a declared classification. `compaction` has no
   `synthetic` field so the message is authentic today.
4. A Pi assertion, if the Pi leg is being wired up: encode a synthetic message,
   decode, assert the classification. It is `false` unconditionally today, so the
   test would pin the current behaviour as intended or expose it as a gap.
5. The composition with `meta_for_ck`: a misclassified module-authored message
   positioned where a native envelope exists, asserting it does not inherit one.
   `codec/mod.rs:128-175` covers the correctly-classified direction; this is the
   other one.

## Investigation log

### Q: Is all-parts-synthetic the intended rule?

- Sources examined: `codec/opencode.rs:1277-1279`, `:208`, `:73-77`, `:86-92`,
  `:161-170`, `:193`; `codec/sidecar.rs:331-339`.
- Findings: the `!parts.is_empty()` guard shows the degenerate case was considered,
  which makes the mixed case look unconsidered rather than decided. The `all`
  evaluates over the *raw* parts array, so parts the decode loop skips still count,
  which widens the mixed case to include any message pairing a synthetic part with
  a `compaction`, `snapshot`, `patch`, `agent`, `retry`, or `ignored` part. I found
  no comment addressing the mixed case anywhere in the file.
- Missing evidence: whether OpenCode can produce a mixed message. The module's own
  writes are uniform (`:992-994` marks every part), so the mixed case would come
  from the harness placing a synthetic part into a message that also holds authored
  content. `packages/pi-plugin/PARITY.md:228-232` describes OpenCode marking "its
  promptAsync part `synthetic: true`", singular, which is suggestive of a
  single-part message but not conclusive.
- Conclusion: needs human input. `any` versus `all` is a semantic choice with real
  consequences in both directions: `all` under-reports and `any` would let one
  injected part launder a whole authored message. Neither is obviously right, and
  the code does not say which was chosen.

### Q: Should `codec/pi.rs:99` read a marker at all?

- Sources examined: `codec/pi.rs` searched for `synthetic` (two literals, `:99` and
  `:345`, no reads); `part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378`;
  `codec/pi.rs:582-607`.
- Findings: the Pi encoder writes no marker and the Pi decoder reads none, so the
  two halves are consistent. Adding a decoder read without an encoder write would
  be dead code; adding both would be a wire-format change to Pi's session files.
- Missing evidence: whether Pi has a field that could carry it. `AgentMessage`
  shapes in the golden carry `role`, `content`, `api`, `provider`, `model`,
  `usage`, `stopReason`, `timestamp`, and `responseId`. None is a provenance flag,
  and `packages/pi-plugin/PARITY.md:228-234` says Pi achieves hidden delivery
  through `sendMessage(..., { display: false })` rather than a per-message flag, so
  Pi's mechanism for this is out-of-band by design.
- Conclusion: resolved with answer for the mechanism (Pi has no in-band field and
  its hidden-delivery design does not use one), unresolved for whether that is
  acceptable. Recorded as an open question on the record because the consequence,
  that synthetic and authentic content are indistinguishable on the Pi leg at
  every layer, is a security-relevant asymmetry rather than a bug in either half.

### Q: Does the todo pair actually round-trip its provenance?

- Sources examined: `codec/opencode.rs:916-948`, `:388-399`;
  `codec/sidecar.rs:331-339`; `codec/mod.rs:112-125`, `:290-298`.
- Findings: yes, and by a narrow path. `render_synthetic_todo_pair` writes
  `syntheticTodoMarker: true` on the single emitted part (`:946`), and
  `is_synthetic_part` reads that key (`sidecar.rs:335-338`). Since the emitted
  message has exactly one part, `all` is satisfied. So decoding the encoded todo
  pair yields `meta.synthetic == true` on an assistant-role message. But the two
  CK messages became one, so the round trip preserves the flag while changing the
  message count and the tool half's role, which is the non-identity recorded in
  `codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness`.
- Missing evidence: none.
- Conclusion: resolved with answer. The todo pair is the one synthetic non-user
  shape whose provenance survives, and it survives because it collapses to a
  single marked part rather than because the encoder handles non-user roles.
