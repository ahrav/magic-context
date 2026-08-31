# codec-b-pi-decoder-drops-unrecognised-entry-types-without-a-record

## Discovery trigger

Task item five: check each codec for whether an unknown field is rejected,
preserved, or silently dropped. I read the OpenCode part-type match arm first and
found the catch-all at `codec/opencode.rs:194-204` routing every unrecognised
type into `CkKind::Opaque` with the raw part retained. Expecting the same policy
in Pi, I read `codec/pi.rs:35-50` and found a `continue`.

## Evidence trail

`crates/mc-module/src/codec/pi.rs:35-50`, read at `HEAD` `e447c927`:

```
35:     for (entry_index, raw_entry) in entries.iter().enumerate() {
36:         if raw_entry.get("type").and_then(Value::as_str) == Some("compaction") {
37:             boundary = Some(pi_boundary(raw_entry, (entry_index + 1) as u64));
38:             continue;
39:         }
40:
41:         let Some(message) = pi_message(raw_entry) else {
42:             if is_pi_opaque_entry(raw_entry) {
43:                 decoded.push(decode_opaque_entry(
44:                     raw_entry,
45:                     (decoded.len() + 1) as u64,
46:                     &mut sidecar,
47:                 ));
48:             }
49:             continue;
50:         };
```

The two predicates that decide the fate of an entry:

`:661-669`:

```
661: fn pi_message(raw_entry: &Value) -> Option<&Value> {
662:     if raw_entry.get("type").and_then(Value::as_str) == Some("message") {
663:         raw_entry.get("message")
664:     } else if raw_entry.get("role").is_some() {
665:         Some(raw_entry)
666:     } else {
667:         None
668:     }
669: }
```

`:681-686`:

```
681: fn is_pi_opaque_entry(raw_entry: &Value) -> bool {
682:     matches!(
683:         raw_entry.get("type").and_then(Value::as_str),
684:         Some("custom_message" | "custom" | "branch_summary")
685:     )
686: }
```

So an entry survives decode if and only if its `type` is `compaction` (becomes the
boundary, no message), or its `type` is `message` **and** it has a `message` key,
or it has a `role` key, or its `type` is one of exactly three opaque names.
Everything else reaches `continue` at `:49`.

What `continue` at `:49` writes: nothing. `decoded` is untouched. `sidecar` is
untouched: `sidecar.order` does not grow, `sidecar.messages` does not gain a key,
and `sidecar.mid_pins` does not gain a pin (the pin at `:62` is below the `else`
block). So there is no path by which any later code can learn the entry existed.

Two distinct shapes reach the drop:

1. An unrecognised `type` with no `role`, for example
   `{"type": "tool_use_v2", "data": {}}`. `pi_message` returns `None` at `:667`;
   `is_pi_opaque_entry` is `false`.
2. `{"type": "message"}` with no `message` key. `:662` matches, so `:663` returns
   `raw_entry.get("message")`, which is `None`. The `let Some(...) else` at `:41`
   therefore takes the else branch, and `is_pi_opaque_entry` is `false` because
   the type is `message`. The entry vanishes even though the decoder recognised
   its type.

The opposite policy, in the sibling codec, `codec/opencode.rs:193-204`:

```
193:                 "snapshot" | "patch" | "agent" | "retry" => {}
194:                 _ => {
195:                     let block = opaque_block(&part_type, part.clone(), opaque_arc(part));
196:                     push_block(
197:                         &mut content,
198:                         &mut block_metas,
199:                         block,
200:                         part_index,
201:                         part,
202:                         &part_type,
203:                     );
204:                 }
```

`opaque_block` (`:1215-1222`) retains `raw` verbatim, and `push_block` (`:544-565`)
records a `BlockMeta` with `raw: raw.clone()` at `:563`. So OpenCode preserves an
unknown part twice: as a CK block and in the sidecar.

The crate's stated position on this question, `ck_wire.rs:19-21`:

```
19: // The re-exported CK message/block serializers retain the original serde_json::Value
20: // for pass-through. That must remain a Value-level replay path, not a typed-struct
21: // round-trip, so harmless future CK fields are not silently dropped.
```

and `mc-store/src/lib.rs:92-95`, on `CkWireMessage::original`:

```
92:     /// Original parsed JSON for pass-through messages. Pass-through MUST stay
93:     /// Value-level: serializing this retained value, never a typed-struct round-trip,
94:     /// preserves harmless unknown fields and keeps replay lossless as the CK wire evolves.
```

Both statements are scoped to the CK layer. Neither binds the harness layer, and
the Pi harness layer takes the opposite position without saying so.

The compounding consequence. `codec/pi.rs:52` assigns the ordinal:

```
52:         let ordinal = (decoded.len() + 1) as u64;
```

and `:45` uses `(decoded.len() + 1) as u64` for opaque entries too. Both are
derived from the count of *surviving* entries, not from `entry_index`. `entry_index`
is used only for the stable-key fallback at `:714`. So dropping entry `k`
renumbers every entry after `k`. There is no `absolute_ordinal` input on the Pi
path to pin the numbering against; see
`codec-b-absolute-ordinal-is-harness-supplied-and-never-validated`.

Reachability label. `rg` over `crates/` and `packages/` finds `decode_pi` only in
`codec/pi.rs` (its own definition at `:19` and `:23`, and test uses from `:1098`
onward) and in `codec/mod.rs:202-203` and `:245`, both inside `#[cfg(test)]`.
`lib.rs:12565-12585` hardcodes `decode_opencode` and
`DecodeSidecar::new("opencode")`; there is no harness dispatch. So the label is
`test-only` for in-tree reachability, with the caveat that `decode_pi` is a public
export (`codec/mod.rs:10`, `lib.rs:12`).

## Failure scenario

Pi adds an entry type in a release the module has not been rebuilt against, say
`{"type": "checkpoint", "id": "ck_1", ...}` between two message entries. On the
next transform pass:

1. The checkpoint entry is dropped at `:49`. Nothing records it.
2. Every message after it decodes with an ordinal one lower than before.
3. Persisted state keyed to an ordinal now names a different message. The
   boundary ordinal from a prior pass points one message too far forward.
4. `encode_pi` reproduces the session array without the checkpoint entry, because
   nothing retains it, so writing the array back truncates the session file.

The third and fourth consequences are independent: one corrupts the module's own
state, the other corrupts the harness's.

## Timing windows and dependencies

No intra-pass window. The cross-pass window is the whole point: the ordinal shift
is only observable by comparing two passes, one before and one after the new entry
type appears in the transcript.

Depends on `codec-b-harness-decoders-accept-every-input-with-no-rejection-channel`
for the framing (there is no channel by which the drop could be reported). Feeds
`codec-b-decoder-output-can-violate-the-projector-precondition`: if the dropped
entry was the `toolCall` for a surviving `toolResult`, the projection fails with
`UnpairedToolResult`.

## What a test must construct

1. A Pi entry array containing a message, then an entry with an unrecognised
   `type` and no `role`, then another message. Assert `decoded.messages.len() == 3`
   or that the third element is recoverable from `sidecar`. It fails at `HEAD`.
2. The degenerate `{"type": "message"}` with no `message` key, as a separate case,
   because it exercises `:663` rather than `:667`.
3. An ordinal-stability assertion: decode the array with and without the
   unrecognised entry and assert that the surviving messages keep their ordinals.
4. A round-trip assertion in the golden's style:
   `encode_pi(decode_pi(entries)) == entries`, which the existing golden asserts
   at `codec/mod.rs:211` but only over an input with no unrecognised entry
   (verified: the Pi golden's 11 entries use only `message`, `custom_message`, and
   `compaction`).
5. The `toolCall`-dropped composition, feeding the decoder output to
   `ck_wire::project_messages` and asserting a declared outcome.

## Investigation log

### Q: Is the three-type opaque allow-list at `:681-686` closed by design?

- Sources examined: `codec/pi.rs:681-686`, `:317-361` (`decode_opaque_entry`);
  `codec/opencode.rs:193-204`; both files' git-visible comments; the Pi golden's
  `coverage` list, which includes `custom_message`.
- Findings: no comment explains why the list has three members or why it is closed
  rather than a catch-all. `decode_opaque_entry` at `:317-361` is fully generic: it
  derives the role from `raw_entry["type"]` with a `"custom"` default at `:328-332`
  and builds an opaque block from the whole entry at `:333`. So nothing about the
  implementation requires the allow-list; the three names could be replaced by
  `is_some()` with no other change. Given `codec/opencode.rs:194-204` uses exactly
  that catch-all shape, the crate's default answer appears to be "preserve unknown
  shapes".
- Missing evidence: whether some Pi entry type must be dropped, for example a
  large binary or a UI-only record that would be wrong to hand to a provider.
  `packages/pi-plugin/PARITY.md:792-795` says Pi "deliberately drops thinking
  parts and image payloads", which is evidence that deliberate dropping is a real
  Pi concern, but it locates that dropping in the TypeScript transcript shaping,
  not in this decoder.
- Conclusion: needs human input. The implementation would support a catch-all with
  no restructuring, and the sibling codec uses one, so the closed list looks like
  an omission rather than a decision. But `PARITY.md` establishes that Pi does
  intend to drop some shapes, so I cannot assert the allow-list is wrong.

### Q: Does the TypeScript Pi plugin drop these entries before the Rust codec sees them?

- Sources examined: `packages/pi-plugin/PARITY.md:107-116` ("Pi rebuilds
  `AgentMessage[]` from JSONL every pass ... The transcript adapter's `commit()`
  writes part-level mutations back into the source array for dirty indices only");
  `:163-171` (`synth-user-<realId>` folding of `toolResult` runs); `:792-795`.
- Findings: PARITY.md describes a TypeScript transcript adapter that reshapes the
  JSONL before the shared core sees it, including folding `toolResult` runs into
  synthetic user messages. The Rust `codec/pi.rs` does none of that folding:
  `:77-79` with `:86-90` maps each `toolResult` entry to its own CK message with
  role `"tool"`. So the Rust codec's expected input shape and the shape the plugin
  produces may differ.
- Missing evidence: the TypeScript adapter itself, which is outside 4f's file
  footprint.
- Conclusion: unresolved, needs the TypeScript transcript adapter. This matters
  beyond this record: if the adapter is the real producer, the Pi golden is
  generated from raw JSONL (`pi-golden.json`'s
  `generated_from.session_files` names `.pi/agent/sessions/*.jsonl` paths
  directly) and therefore tests the wrong input shape. Recorded as lens
  contract-vs-code lead five.
