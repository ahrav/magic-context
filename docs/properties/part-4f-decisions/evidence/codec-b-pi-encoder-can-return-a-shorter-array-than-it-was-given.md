# codec-b-pi-encoder-can-return-a-shorter-array-than-it-was-given

## Discovery trigger

Comparing the two encoders' return types for the codec table. OpenCode's chunk
producer returns `Vec<EncodedOpencodeChunk>` where each chunk carries explicit
`start_index` and `end_index` fields, which exist because OpenCode's tool-pair
collapse consumes two messages per chunk. Pi's `encode_pi` returns a plain
`Vec<Value>` built by `filter_map`, which can shrink for a different reason and
carries no index information at all.

## Evidence trail

`crates/mc-module/src/codec/pi.rs:128-137`, read at `HEAD` `e447c927`:

```
128: pub fn encode_pi(messages: &[CkWireMessage], sidecar: &DecodeSidecar) -> Vec<PiSessionEntryJson> {
129:     messages
130:         .iter()
131:         .enumerate()
132:         .filter_map(|(index, msg)| match meta_for_ck(sidecar, msg, index) {
133:             Some(meta) => encode_with_meta(msg, meta),
134:             None => Some(encode_new_message(msg)),
135:         })
136:         .collect()
137: }
```

`encode_new_message` returns `Value` and is wrapped in `Some` at `:134`, so the
no-meta path never drops. `encode_with_meta` returns `Option<Value>` and has two
`None` returns.

The first, `:363-385`, in the tool-result branch:

```
366:     if meta.role == "toolResult" || raw.get("role").and_then(Value::as_str) == Some("toolResult") {
367:         let (block, matched_meta) = msg
368:             .content
369:             .iter()
370:             .zip(&matched_metas.by_block)
371:             .find(|(block, _)| matches!(&block.kind, CkKind::ToolResult { .. }))?;
```

The `?` at `:371` returns `None` when no `ToolResult` block exists in a message
whose meta role or raw role says `toolResult`. Reachable by deleting the result
block from a decoded tool-result message: the meta still says `toolResult` because
it was recorded at decode time (`:113`), and the content no longer has the block.
This path is pinned by `codec/pi.rs:1469-1484`
(`deleted_tool_result_does_not_replay_the_retained_raw_entry`), whose fixture is a
`role: "toolResult"` entry and which calls `message.content.clear()` at `:1481`
before asserting `encode_pi(...).is_empty()` at `:1483`. So the drop is deliberate
for the cleared-content case, and the property being recorded is not "the drop is
wrong" but "the caller has no way to learn which index went missing".

Not pinned: the same `:371` drop with *non-empty* content that happens to contain
no `ToolResult` block, for example a tool-result message reduced to a single text
block. `.find` at `:367-371` searches for `CkKind::ToolResult` specifically, so a
surviving text block does not save the message.

The second, `:387-398`:

```
387:     if let Some(message) = pi_message_mut(&mut raw) {
388:         update_pi_message_content(message, msg, &matched_metas);
389:     } else if matches!(
390:         msg.content.first().map(|b| &b.kind),
391:         Some(CkKind::Opaque(_))
392:     ) {
393:         if let CkKind::Opaque(opaque) = &msg.content[0].kind {
394:             raw = opaque.raw.clone();
395:         }
396:     } else if msg.content.is_empty() {
397:         return None;
398:     }
```

`:396-397` drops a message with empty content whose raw is not a Pi message and
whose first block is not opaque. This path has no test: reaching it requires
`pi_message_mut` (`:671-679`) to return `None`, which needs a raw with neither
`type == "message"` nor a `role` key, which only `decode_opaque_entry`
(`:317-361`) produces, and an opaque entry always yields exactly one opaque block
so `msg.content.first()` would match `:389-392` unless the block was removed.

The contrast, `codec/opencode.rs:343-348` and `:428-433`:

```
343: #[derive(Debug, Clone)]
344: pub(crate) struct EncodedOpencodeChunk {
345:     pub(crate) start_index: usize,
346:     pub(crate) end_index: usize,
347:     pub(crate) value: MessageV2Json,
348: }
```

```
428:         encoded.push(EncodedOpencodeChunk {
429:             start_index: absolute_index,
430:             end_index: absolute_index.saturating_add(1),
431:             value,
432:         });
433:         index += 1;
```

Every message produces a chunk. The collapse cases at `:390-397` and `:408-412`
set `end_index` to `absolute_index + 2`, so the mapping from wire values back to
CK message positions is explicit and total. `lib.rs:12949` relies on exactly that:
it passes `suffix_start` as `base_index` and later reads `chunk.start_index` and
`chunk.end_index` to splice a cached prefix. Pi has no equivalent, so a Pi caller
attempting the same incremental splice would have no correct way to do it.

Reachability. `rg` over `crates/` and `packages/` finds `encode_pi` only in
`codec/pi.rs` (definition at `:128`, test uses from `:1147` onward) and in
`codec/mod.rs:208-209` and `:249`, both inside `#[cfg(test)]`. Part 4e reached the
same conclusion independently and recorded it at
`part-4e-rendering/_lenses/lens-b-nudge-overlay.md:373-378`: "`encode_pi` has no
caller outside `codec/mod.rs`'s own tests ... so the pi encode path is not on a
production route today." So the label is `test-only`, and the record's value is
contractual rather than operational.

## Failure scenario

No production failure today, because there is no production caller. The scenario
the record guards is the wiring-up: a future caller pairs `encode_pi`'s output
with the CK message list by index, in the same shape `lib.rs:12945-12961` uses for
OpenCode. After the first drop every pairing is off by one, and the mismatch is
silent because both sides are `Vec<Value>` of plausible shape.

The `:371` drop is the more dangerous of the two, because it fires on a *mutated*
message rather than a degenerate one. Deleting a tool-result block is a normal
transform operation (`codec/pi.rs:1436-1443` does exactly that with
`message.content.remove(0)`), so the drop is reachable from ordinary reduction
work, not only from malformed input. The existing test covers the fully-cleared
case; the partially-reduced case, where a text block survives but the
`ToolResult` does not, takes the same drop and is untested.

## Timing windows and dependencies

None temporal. The dependency is on `meta_for_ck` (`codec/sidecar.rs:315-329`):
whether a message takes the `encode_with_meta` path at all is decided there, and
the positional fallback at `:324-328` means a synthetic-flag misclassification
changes which path a message takes. That links this record to
`codec-b-provenance-recovery-on-decode-is-all-or-nothing-and-opencode-only`,
because `meta_for_ck`'s fallback is gated on `!msg.meta.synthetic`.

## What a test must construct

1. The `:371` drop with non-empty content: decode a Pi `toolResult` entry that
   yields a `ToolResult` block, add or retain a text block, remove only the
   `ToolResult`, encode, and assert a declared outcome. The existing test covers
   only `content.clear()`.
2. The `:396-397` drop, which needs an opaque entry whose single block was
   removed. It may be unreachable; if so the record should say so and the branch
   is dead code.
3. A length-preservation assertion over a multi-message array where the middle
   message hits a drop, asserting either that the length is preserved or that the
   caller can identify the dropped index.
4. If the contract is to keep the drop, a test that pins the *pairing* contract:
   encode a three-message array whose middle message drops, and assert what a
   caller is supposed to do. There is nothing to assert against today because no
   index information is returned.

## Investigation log

### Q: Should `encode_pi` adopt the `EncodedOpencodeChunk` shape?

- Sources examined: `codec/pi.rs:128-137`, `:363-404`; `codec/opencode.rs:343-348`,
  `:374-436`; `lib.rs:12945-12961`.
- Findings: the two encoders shrink for different reasons. OpenCode shrinks because
  two CK messages legitimately become one wire part, which is a *many-to-one*
  mapping and needs a range. Pi shrinks because a message is dropped, which is a
  *one-to-zero* mapping and would need only an `Option` per input position, not a
  range. So the right shape for Pi is `Vec<Option<Value>>` or a parallel index
  vector, not `EncodedOpencodeChunk`.
- Missing evidence: whether Pi ever needs a many-to-one collapse. `codec/pi.rs`
  has no pair-collapse logic at all: `encode_pi` maps one message to at most one
  entry. `packages/pi-plugin/PARITY.md:163-171` describes `synth-user-<realId>`
  folding of `toolResult` runs, which *is* a many-to-one mapping, but it lives in
  the TypeScript adapter and not here.
- Conclusion: unresolved, needs a decision about whether the Pi leg is being wired
  up. If PARITY.md's folding is meant to move into the Rust codec, Pi would need
  the range shape after all.

### Q: Which of the two drops does the existing test pin?

- Sources examined: `codec/pi.rs:1469-1484` in full, `:363-404`, `:671-679`.
- Findings: the test is `deleted_tool_result_does_not_replay_the_retained_raw_entry`.
  Its fixture at `:1471-1478` is `{"role": "toolResult", "toolCallId": "call-a",
  ...}`, so the decoded meta's `role` is `"toolResult"` (recorded at `:113` from
  `:53-57`). `:1481` calls `message.content.clear()`. So `encode_with_meta` enters
  the `:366` branch on the meta-role test, `.find` at `:367-371` finds nothing in
  empty content, and the `?` returns `None`. The test pins `:371`, not `:396-397`.
- Missing evidence: none.
- Conclusion: resolved with answer. `:371` has partial coverage (cleared content
  only); `:396-397` has none, and may be unreachable, since it requires a raw that
  `pi_message_mut` rejects, which only `decode_opaque_entry` produces, and such a
  message always has exactly one opaque block that would match `:389-392` first.
  Corrected the record's `Exercised` line to name the covered path.
