# codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity

## Discovery trigger

The scope map singled this file out
(`part-4-module/_lenses/scope-map-and-risk-ranking.md:642-646`):
"`codec/sidecar.rs` owns `stamp_block_identity` and `decoded_block_fingerprint`
that everything downstream keys on, and it has zero tests of its own." Confirmed:
`grep -c '#\[test\]' crates/mc-module/src/codec/sidecar.rs` returns 0, against 17
in `opencode.rs`, 14 in `pi.rs`, and 6 in `mod.rs`. Reading the file for what an
attacker or a stale caller could supply turned up two distinct weaknesses.

## Evidence trail

### The namespace and keys are plain strings

`crates/mc-module/src/codec/sidecar.rs:131-134`, read at `HEAD` `e447c927`:

```
131: const BLOCK_IDENTITY_NAMESPACE: &str = "_cortexkit_codec";
132: const BLOCK_INDEX_KEY: &str = "blockIndex";
133: const NATIVE_INDEX_KEY: &str = "nativeIndex";
134: const FINGERPRINT_KEY: &str = "decodedFingerprint";
```

The stamp is written into `provider_extras`, `:158-175`:

```
158: pub(crate) fn stamp_block_identity(
159:     block: &mut CkWireBlock,
160:     block_index: usize,
161:     native_index: usize,
162:     fingerprint: &str,
163: ) {
164:     let identity = block
165:         .provider_extras
166:         .entry(BLOCK_IDENTITY_NAMESPACE.to_string())
167:         .or_default();
168:     identity.insert(BLOCK_INDEX_KEY.to_string(), Value::from(block_index));
169:     identity.insert(NATIVE_INDEX_KEY.to_string(), Value::from(native_index));
170:     identity.insert(
171:         FINGERPRINT_KEY.to_string(),
172:         Value::String(fingerprint.to_string()),
173:     );
174:     block.mark_modified();
175: }
```

and read back at `:177-183` with no provenance check:

```
177: fn stamped_block_identity(block: &CkWireBlock) -> Option<(usize, usize, &str)> {
178:     let identity = block.provider_extras.get(BLOCK_IDENTITY_NAMESPACE)?;
179:     let block_index = identity.get(BLOCK_INDEX_KEY)?.as_u64()?.try_into().ok()?;
180:     let native_index = identity.get(NATIVE_INDEX_KEY)?.as_u64()?.try_into().ok()?;
181:     let fingerprint = identity.get(FINGERPRINT_KEY)?.as_str()?;
182:     Some((block_index, native_index, fingerprint))
183: }
```

`ProviderExtras` is `pub type ProviderExtras = BTreeMap<String, BTreeMap<String, Value>>`
(`mc-store/src/lib.rs:42`) and `CkWireBlock.provider_extras` is a public field
(`:194`). `CkWireBlock`'s `Deserialize` (`:207-221`) reads it verbatim from the
wire through `CkWireBlockData` (`:200-205`). `TransformRequest.messages` is
`Vec<CkIngressMessage>` (`transform.rs:781`), and `CkIngressMessage.ck` is a
`CkWireMessage` (`ck_wire.rs:26-31`). So a CK-wire caller can supply
`provider_extras["_cortexkit_codec"]` with any contents it likes.

The mitigating fact, which I checked and which holds: neither harness decoder
routes harness input into that namespace. `codec/opencode.rs:567-577`
(`block_with_metadata`) writes harness metadata under the `"opencode"` key at
`:572`; `codec/pi.rs:817-822` (`insert_pi_extra`) writes under `"pi"` at `:819`.
So a forged stamp is reachable from CK ingress and not from harness ingress.

### The stamp outranks the kind check

`codec/sidecar.rs:198-227`:

```
198: fn alignment_candidate(
199:     block: &CkWireBlock,
200:     block_index: usize,
201:     meta: &BlockMeta,
202:     kind_matches: bool,
203: ) -> Option<bool> {
204:     if let Some((origin_block_index, origin_native_index, fingerprint)) =
205:         stamped_block_identity(block)
206:     {
207:         let origin_matches = origin_block_index == meta.block_index
208:             && Some(origin_native_index) == meta.native_index
209:             && meta.content_fingerprint.as_deref() == Some(fingerprint);
210:         return origin_matches.then_some(true);
211:     }
212:
213:     if kind_matches
214:         && meta
215:             .content_fingerprint
216:             .as_deref()
217:             .is_some_and(|fingerprint| decoded_block_fingerprint(block) == fingerprint)
218:     {
219:         return Some(false);
220:     }
```

The `return` at `:210` is unconditional once a stamp is present. `kind_matches` is
never consulted on that path. So a block carrying a stamp whose three fields match
a `BlockMeta` aligns to it regardless of whether the block's `CkKind` and the
meta's `kind` are compatible. The `kind_matches` argument comes from
`block_matches_meta` (`codec/opencode.rs:811-832`, `codec/pi.rs:406-434`), which is
the check that would otherwise stop a text block from aligning to a reasoning
meta.

The consequence at the encoder: `codec/opencode.rs:761-779` takes the matched
meta's `native_index` and calls `update_part_from_block(part, block)` at `:774`,
which for `CkKind::Text` sets `type: "text"` and `text` (`:836-846`). So a text
block aligned to a reasoning part rewrites that part's type. The reasoning
carve-out at `:770-773` protects against the reverse direction only: it skips the
update when the *block* is reasoning, not when the *part* is.

### The fingerprint is a change detector, not an identity

`codec/sidecar.rs:151-156`:

```
151: pub(crate) fn decoded_block_fingerprint(block: &CkWireBlock) -> String {
152:     let mut canonical = block.clone();
153:     canonical.provider_extras.remove(BLOCK_IDENTITY_NAMESPACE);
154:     canonical.mark_modified();
155:     stable_hash(&serde_json::to_value(canonical).unwrap_or(Value::Null))
156: }
```

`mark_modified` at `:154` clears `original` (`mc-store/src/lib.rs:261-263`), so
`Serialize` takes the typed branch (`:231-235`) and the hash covers `kind` plus
`provider_extras` minus the identity namespace. It is blind to the retained
pass-through bytes that `mc-store/src/lib.rs:92-95` and `:195-196` exist to
preserve.

Two blocks with identical typed cores therefore have identical fingerprints. And
`push_block` computes the fingerprint *before* stamping, so the stamp does not
disambiguate the fingerprint itself. `codec/opencode.rs:552-554`:

```
552:     let block_index = content.len();
553:     let content_fingerprint = decoded_block_fingerprint(&block);
554:     stamp_block_identity(&mut block, block_index, part_index, &content_fingerprint);
```

and `codec/pi.rs:302-304` identically. So a message with two byte-identical text
parts produces two `BlockMeta`s with the same `content_fingerprint` and different
`block_index`/`native_index`.

`block_is_unchanged` (`:192-196`) is fingerprint-only:

```
192: pub(crate) fn block_is_unchanged(block: &CkWireBlock, meta: &BlockMeta) -> bool {
193:     meta.content_fingerprint
194:         .as_deref()
195:         .is_some_and(|fingerprint| decoded_block_fingerprint(block) == fingerprint)
196: }
```

so for duplicate-content blocks it returns `true` against the wrong meta as
readily as the right one. That is contained today because `alignment_candidate`'s
stamp path (`:204-211`) compares `block_index` and `native_index` too, so
alignment disambiguates before `block_is_unchanged` is consulted at
`codec/opencode.rs:742` and `:763`. The stamp is therefore the sole disambiguator
for duplicates, and the comment at `:243-247` explains why it can be: "Origin
indexes are stamped onto decoded blocks and survive reductions, overlays, and
deletion compaction through `CkWireBlock::provider_extras`."

The fallback if a stamp is absent, `:225-227`:

```
225:     (meta.content_fingerprint.is_none() && block_index == meta.block_index && kind_matches)
226:         .then_some(false)
```

requires `content_fingerprint.is_none()`, which the harness decoders never produce
(both always set `Some` at `codec/opencode.rs:562` and `codec/pi.rs:312`). So the
positional fallback exists only for pre-fingerprint sidecars, per the comment at
`:222-224`. A stamp-less block from a modern sidecar aligns via `:213-219`, which
does consult `kind_matches`, so the honest path is kind-checked and the stamped
path is not.

### Three policies for one serialization failure

- `codec/sidecar.rs:155` — `unwrap_or(Value::Null)`. Every failing block hashes to
  the hash of `null`, so all of them collide and `block_is_unchanged` reads them as
  unchanged relative to each other.
- `codec/sidecar.rs:292-296` and `:298-305` — `stable_hash` and
  `stable_hash_prefix` use `serde_json::to_vec(value).unwrap_or_default()`, so a
  failure hashes empty bytes.
- `ck_wire.rs:585-589` — `serde_json::to_string(block).map_err(|_| CkWireError::UnsupportedBlock {...})?`,
  a typed rejection.

The failure is unreachable in practice (every `Value` in the tree came from
`serde_json` parsing, and `CkKind`'s derived `Serialize` cannot fail for one), so
this is a consistency observation rather than a live defect. It matters because two
of the three policies make a failure indistinguishable from a specific successful
value.

## Failure scenario

Forged stamp: a CK-wire message whose block carries
`provider_extras["_cortexkit_codec"] = {"blockIndex": 1, "nativeIndex": 1,
"decodedFingerprint": "<the fingerprint of the native reasoning part>"}`. The
fingerprint is not secret; it is the SHA-256 of a canonical serialisation of a
block the caller can construct itself. `alignment_candidate` returns `Some(true)`
at `:210`, the encoder takes the `:761-779` path with that part index, and
`update_part_from_block` rewrites the reasoning part as a text part. The provider
receives a request where a reasoning block's signature no longer matches its
content, which is the exact hazard the carve-out at `codec/opencode.rs:767-769`
was written to avoid: "Reasoning parts may contain provider signatures, so
changing their bytes could invalidate verification."

Duplicate-content collapse: this is latent, not live. If the stamp were ever
dropped from the pass-through path, two identical text blocks would fall to
`:213-219`, both matching both metas on fingerprint and kind, and the LCS walk at
`:248-277` would pick by score rather than by origin. The comment at `:243-247`
asserts the stamps survive; nothing tests that they do, which is the gap.

## Timing windows and dependencies

No temporal window inside the file; every function is pure.

The cross-pass dependency is the one the comment at `:243-247` names: stamps must
survive "reductions, overlays, and deletion compaction". Every mutator that edits a
block's `kind` must call `mark_modified` (`mc-store/src/lib.rs:256-263` documents
this as a MUST), and `mark_modified` clears `original` but leaves
`provider_extras` intact, so the stamp survives. `CkWireMessage::mark_fully_typed`
(`:183-188`) also leaves `provider_extras` intact. I found no path that strips the
namespace other than the deliberate removal inside `decoded_block_fingerprint`
itself.

Depends on: `codec-b-harness-decoders-accept-every-input-with-no-rejection-channel`
for the framing that nothing validates CK ingress. Depended on by
`codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour`, because
whether `codec/opencode.rs:749`'s both-`None` arm fires is decided by this
alignment.

## What a test must construct

1. A CK-wire message with a forged `_cortexkit_codec` stamp pointing at a
   reasoning part, encoded against a sidecar, asserting the reasoning part is not
   rewritten. It is rewritten today.
2. A message with two byte-identical text parts, decoded, one block mutated,
   re-encoded, asserting the correct native part changed. This exercises the
   stamp-as-disambiguator path that has no test.
3. The stamp-survival claim from `:243-247`: decode, apply a reduction, an overlay,
   and a deletion, then assert `has_stamped_block_identity` on every survivor.
4. A negative for the kind check: a stamped text block whose meta kind is
   `reasoning`, asserting the alignment is refused. `:204-211` accepts it today.
5. Any test at all in `codec/sidecar.rs`, which currently has none. Items 2 and 3
   are the highest value because they pin the invariant the whole encoder rests on.

## Investigation log

### Q: Should the stamp carry a per-decode nonce?

- Sources examined: `codec/sidecar.rs:131-134`, `:158-190`, `:198-227`, `:243-247`;
  `mc-store/src/lib.rs:179-188`, `:256-263`.
- Findings: the property that makes the stamp useful is precisely that it survives
  arbitrarily many mutations across a session, which is what `:243-247` claims. A
  nonce checked for freshness would break that. A nonce checked only for
  *provenance* (this stamp came from a decode in this process, whatever its age)
  would not, and would be enough to reject a caller-supplied stamp: keep a
  process-local random value, include it in the stamp, and reject stamps that do
  not carry it. That costs one field and does not weaken the survival property.
- Missing evidence: whether CK-wire callers are trusted. Same underlying question
  as `codec-b-harness-decoders-accept-every-input-with-no-rejection-channel`'s open
  question, and it recurs here with a sharper edge, because here the untrusted
  value steers a write into a signature-bearing provider field.
- Conclusion: needs human input on the trust model. The mechanism is
  straightforward once that is settled.

### Q: Which serialization-failure policy is normative?

- Sources examined: `codec/sidecar.rs:151-156`, `:292-305`; `ck_wire.rs:578-590`;
  `mc-store/src/lib.rs:223-236`, `:266-300` (`CkKind`'s derived `Serialize`).
- Findings: the failure is unreachable. `CkWireBlock`'s `Serialize` either forwards
  a retained `Value` or serialises `CkKind` plus `ProviderExtras`; `CkKind` contains
  `String`, `Option<String>`, `Value`, `bool`, and nested types with the same
  property, and `ProviderExtras` is a `BTreeMap<String, BTreeMap<String, Value>>`
  whose keys are `String`. `serde_json` cannot fail on any of those.
- Missing evidence: none.
- Conclusion: resolved with answer. Unreachable, so the inconsistency is a
  robustness observation rather than a defect. Worth stating because two of the
  three policies map a failure onto a valid successful value's hash, which would
  make an impossible failure indistinguishable from a real block if the type ever
  gained a non-serialisable field. Kept as an open question on the record at that
  weight, not higher.

### Q: Can a harness part inject the identity namespace?

- Sources examined: `codec/opencode.rs:567-577`, `:96-103`, `:502-509`;
  `codec/pi.rs:787-830`; `codec/sidecar.rs:151-156`.
- Findings: no. Both decoders write `provider_extras` only under their own harness
  key: `codec/opencode.rs:572` inserts under `HARNESS` (`"opencode"`, `:21`), and
  `codec/pi.rs:819` under `HARNESS` (`"pi"`, `:17`). No decoder path copies a raw
  part's arbitrary keys into `provider_extras`. And `decoded_block_fingerprint`
  removes the namespace at `:153` before hashing, so even a hypothetical injected
  stamp would not affect the fingerprint it claims to certify.
- Missing evidence: none.
- Conclusion: resolved with answer. The forged-stamp path is reachable from CK
  ingress (`transform.rs:781` plus `mc-store/src/lib.rs:207-221`) and not from
  harness ingress. That narrows the record's required enabling state and is stated
  in it.
