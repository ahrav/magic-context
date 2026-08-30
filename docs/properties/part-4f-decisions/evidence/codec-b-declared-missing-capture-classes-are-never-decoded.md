# codec-b-declared-missing-capture-classes-are-never-decoded

## Discovery trigger

The scope map named this directly
(`part-4-module/_lenses/scope-map-and-risk-ranking.md:645-647`): "whether the
`coverage` and `missing_capture_classes` manifest in `codec/mod.rs`'s golden test
admits an unclassified block shape silently". I read the helper, then parsed both
golden files to see whether the escape hatch is actually used. It is, in both.

## Evidence trail

The mechanism, `crates/mc-module/src/codec/mod.rs:254-271`, read at `HEAD`
`e447c927`:

```
254:     fn assert_coverage_or_recorded_missing(
255:         actual: &[String],
256:         recorded_missing: &[String],
257:         required: &[&str],
258:     ) {
259:         let actual: BTreeSet<&str> = actual.iter().map(String::as_str).collect();
260:         let recorded_missing: BTreeSet<&str> =
261:             recorded_missing.iter().map(String::as_str).collect();
262:         let unresolved: Vec<&str> = required
263:             .iter()
264:             .copied()
265:             .filter(|item| !actual.contains(item) && !recorded_missing.contains(item))
266:             .collect();
267:         assert!(
268:             unresolved.is_empty(),
269:             "codec golden neither covers nor records missing classes: {unresolved:?}"
270:         );
271:     }
```

The filter at `:265` retains a required class only when it is absent from *both*
sets. So membership in `missing_capture_classes` satisfies the assertion exactly
as well as membership in `coverage`. The failure message at `:269` is honest about
this: it says "neither covers nor records missing", not "does not cover".

Both goldens use the hatch. Parsed at `HEAD`:

`testdata/codec/opencode-golden.json`:
- `coverage`: `text`, `ignored_text`, `empty_text`, `reasoning_signature`,
  `tool_completed`, `tool_error`, `file`, `step_start`, `compaction`,
  `step_finish`, `patch`
- `missing_capture_classes`: `subtask`

`testdata/codec/pi-golden.json`:
- `coverage`: `text_signature`, `thinking_signature`, `image`,
  `tool_call_split_pipe`, `thought_signature`, `tool_result`,
  `tool_result_details`, `custom_message`, `compaction`, `aborted_assistant`,
  `response_id_mid`, `timestamp_fallback_mid`
- `missing_capture_classes`: `redacted_thinking`

The required lists, `codec/mod.rs:62-75` for OpenCode and `:184-198` for Pi, both
name the missing class: `"subtask"` at `:72` and `"redacted_thinking"` at `:187`.
So in each case a class is declared required and declared missing, and the
assertion passes.

The two decode arms that are therefore never entered by the goldens:

`codec/opencode.rs:171-181`:

```
171:                 "subtask" => {
172:                     let block = opaque_block("subtask", part.clone(), None);
173:                     push_block(
174:                         &mut content,
175:                         &mut block_metas,
176:                         block,
177:                         part_index,
178:                         part,
179:                         "subtask",
180:                     );
181:                 }
```

`codec/pi.rs:194-217`, redacted branch:

```
194:             Some("thinking") => {
195:                 let redacted = part
196:                     .get("redacted")
197:                     .and_then(Value::as_bool)
198:                     .unwrap_or(false);
199:                 if redacted {
200:                     let data = string_field(part, "thinkingSignature")
201:                         .or_else(|| string_field(part, "thinking"))
202:                         .unwrap_or_default();
203:                     let block = CkWireBlock::bare(CkKind::RedactedReasoning { data });
204:                     push_block(
205:                         content,
206:                         block_metas,
207:                         block,
208:                         part_index,
209:                         part,
210:                         "redacted_reasoning",
211:                     );
212:                 } else {
```

Confirmed by inspecting the golden cases that neither arm is reached: the OpenCode
case's 10 messages carry part types `step-start`, `reasoning`, `text`, `tool`,
`step-finish`, `patch`, `file`, `compaction`, with no `subtask`. The Pi case's 11
entries are `message` x 9, `custom_message`, `compaction`; the assistant entries'
`thinking` parts would need `redacted: true` to reach `:199`, and the golden
records the class as missing precisely because none does.

The consequence differs sharply between the two arms, which is why the record's
impact line separates them.

For `subtask`: deleting `codec/opencode.rs:171-181` entirely would make a
`subtask` part fall through to the catch-all at `:194-204`, which calls the same
`opaque_block` helper with `kind = &part_type` (that is, `"subtask"`). The only
behavioural difference is the third argument: `:172` passes `None` for `arc`,
while `:195` passes `opaque_arc(part)`. `opaque_arc` (`:1224-1233`) returns `Some`
only when the part has an `approvalId` field, so for a `subtask` part without one
the two paths are identical. So the arm is near-redundant with the catch-all, and
its absence from the golden costs little.

For Pi's redacted branch, there is a real behavioural difference to lose. The
redacted path produces `CkKind::RedactedReasoning { data }` and the non-redacted
path at `:212-217` produces `CkKind::Reasoning { text, signature }`. Those
round-trip through different encoder arms:

- `codec/pi.rs:543-548` for `RedactedReasoning`: sets `type: "thinking"`,
  `thinking: ""`, `thinkingSignature: data`, and `redacted: true`.
- `:536-542` for `Reasoning`: sets `type: "thinking"`, `thinking: text`, and
  `thinkingSignature` only if a signature exists. It never sets `redacted`.

So misclassifying a redacted part as non-redacted loses the `redacted: true` flag
and moves the signature payload from `thinkingSignature` into a dropped `thinking`
value. `packages/pi-plugin/PARITY.md:346-350` states why this matters: redacted
blocks "serialize `redacted` BEFORE the empty-thinking check", so emptying one and
"dropping its signature would put a malformed redacted block (no data, no sig) on
the wire".

Reachability. The `subtask` arm is on the default production path
(`lib.rs:12572`, `:12584`, and `:12671` all call `decode_opencode`). The Pi arm is
`test-only` in-tree by the same `rg` evidence as the other Pi records. The record
is labelled `default-production` on the strength of the OpenCode half.

## Failure scenario

Not a runtime failure. The failure is that the suite reports coverage it does not
have, so a future change to either arm ships unobserved. The specific loss for Pi:
if `codec/pi.rs:199` were changed to read a differently-named field, every
redacted thinking part would take the `:212` branch, the encoder would emit a
signature-less non-redacted thinking block, and the provider would reject the
request. Nothing in the tree would catch it.

## Timing windows and dependencies

None. This is a static coverage property.

Depends on `codec-b-round-trip-identity-is-claimed-in-one-direction-on-one-case-per-harness`
for the reason the gap cannot be closed easily: the goldens are generated from
uncommitted personal inputs (`opencode-golden.json`'s
`generated_from.db_path` and `pi-golden.json`'s `generated_from.session_files` are
absolute paths under one developer's home directory), so adding a case requires
either that developer's machine or a hand-written case outside the golden format.

## What a test must construct

1. An OpenCode message with a `subtask` part, added to the golden's case or as a
   standalone unit test in `codec/opencode.rs`'s test module, asserting the block
   becomes `CkKind::Opaque` with `kind == "subtask"` and that it round-trips.
2. A Pi assistant entry with `{"type": "thinking", "redacted": true,
   "thinkingSignature": "sig"}`, asserting the decoded block is
   `CkKind::RedactedReasoning { data: "sig" }` and that re-encoding restores
   `redacted: true` and `thinkingSignature: "sig"` with `thinking: ""`.
3. The negative that makes case 2 discriminating: the same part without
   `redacted: true`, asserting `CkKind::Reasoning` and no `redacted` key on
   re-encode. Without the pair, a test could pass by treating both as redacted.
4. A gate on the manifest itself, if `missing_capture_classes` is meant to shrink:
   assert its length is at most some declining bound, or attach an owner and a
   date. Today nothing prevents it from growing.

Note that cases 1 to 3 do not need the golden format at all. They can be written
as ordinary unit tests in the two codec files, which sidesteps the
unreproducible-generator problem entirely. That makes this the cheapest gap in
this lens to close.

## Investigation log

### Q: Is `missing_capture_classes` a temporary ledger or a permanent waiver?

- Sources examined: `codec/mod.rs:28-52` (the two golden structs, both declaring
  `missing_capture_classes` with `#[serde(default)]` at `:31` and `:44`);
  `:254-271`; both golden files' full key sets (`projection_oracle`,
  `generated_from`, `coverage`, `missing_capture_classes`, `cases`).
- Findings: nothing in the code or either file bounds it, dates it, or assigns an
  owner. `#[serde(default)]` means a golden may omit the field entirely, so the
  mechanism also tolerates a golden that declares nothing. The neighbouring
  `projection_oracle` field *does* carry a `status: "todo"` and a prose `reason`
  explaining what would discharge it, which shows the file format is capable of
  expressing intent about an incomplete item; `missing_capture_classes` is a bare
  string array with no such structure.
- Missing evidence: whether a follow-up task exists. The repository uses beads for
  task tracking (`AGENTS.md`), so a `bd` query might find one, but per METHOD I
  should not treat its absence as proof.
- Conclusion: needs human input. The format precedent set by `projection_oracle`
  in the same files suggests the author knows how to express "incomplete, and here
  is what would fix it", and chose not to for this field. Whether that is because
  the waiver is permanent or because the field predates that habit is not
  determinable from the tree.

### Q: Does deleting the `subtask` arm change behaviour?

- Sources examined: `codec/opencode.rs:171-181`, `:194-204`, `:1215-1222`
  (`opaque_block`), `:1224-1233` (`opaque_arc`).
- Findings: the catch-all at `:194-204` calls `opaque_block(&part_type,
  part.clone(), opaque_arc(part))`, and `part_type` for a subtask part is exactly
  `"subtask"`. The `subtask` arm calls `opaque_block("subtask", part.clone(),
  None)`. So the only difference is the `arc` argument, and `opaque_arc` returns
  `None` unless the part has an `approvalId` (`:1225`). A subtask part with an
  `approvalId` would therefore get an `arc` from the catch-all and not from the
  dedicated arm.
- Missing evidence: whether an OpenCode `subtask` part can carry `approvalId`. Not
  determinable; the part schema is not vendored.
- Conclusion: resolved with answer for the common case (no behavioural difference,
  so the coverage gap is low-consequence for `subtask`), unresolved for the
  `approvalId` case. Either way the Pi half of this record carries the weight.
