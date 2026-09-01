# codec-b-opencode-hides-four-part-types-from-every-transform-decision

## Discovery trigger

Task item three asked where the contract deliberately permits lossy translation.
Reading the OpenCode part-type match, `codec/opencode.rs:193` is a single line
mapping four named types to an empty block. Every other arm produces a block. The
question is whether those four are lost or merely hidden.

## Evidence trail

`crates/mc-module/src/codec/opencode.rs:193`, read at `HEAD` `e447c927`:

```
193:                 "snapshot" | "patch" | "agent" | "retry" => {}
```

The arm produces no `CkWireBlock` and no `BlockMeta`. Compare the catch-all
immediately below it at `:194-204`, which produces both. So these four types are
singled out for omission, distinct from the unknown-type policy.

The preservation path, traced through `encode_with_meta`
(`codec/opencode.rs:701-809`):

- `:706-711` — `raw = meta.raw.clone()` and `parts` is the raw's `parts` array.
  So encoding starts from the full ingress parts, including the four omitted
  types at their original indices.
- `:712` — `match_block_metas(&msg.content, &meta.blocks, block_matches_meta)`
  aligns CK blocks to `BlockMeta`s. The four types have no `BlockMeta`, so they
  participate in no alignment.
- `:715-782` — the mutation loop only touches `parts.get_mut(part_index)` for a
  `part_index` taken from a matched `BlockMeta.native_index` (`:731-732`, `:761`),
  or pushes a new part at `:754` and `:780`. It never removes.
- `:784` — `parts = matched_metas.remove_unretained_native_parts(parts)`.

`remove_unretained_native_parts` (`codec/sidecar.rs:118-128`):

```
118:     pub(crate) fn remove_unretained_native_parts<T>(&self, parts: Vec<T>) -> Vec<T> {
119:         parts
120:             .into_iter()
121:             .enumerate()
122:             .filter_map(|(native_index, part)| {
123:                 let decoded_block_was_removed = self.decoded_native_indices.contains(&native_index)
124:                     && !self.retained_native_indices.contains(&native_index);
125:                 (!decoded_block_was_removed).then_some(part)
126:             })
127:             .collect()
128:     }
```

`decoded_native_indices` is built at `codec/sidecar.rs:283`:

```
283:         let decoded_native_indices = metas.iter().filter_map(|meta| meta.native_index).collect();
```

That is, it contains exactly the native indices that produced a `BlockMeta`. The
four omitted types produce no `BlockMeta`, so their indices are absent from
`decoded_native_indices`, so `decoded_block_was_removed` is false for them, so
they are always retained. This immunity is structural and stated in no comment.

`:785-787` then strips compaction only when `preserve_compaction` is false:

```
785:     if !preserve_compaction {
786:         parts.retain(|part| part.get("type").and_then(Value::as_str) != Some("compaction"));
787:     }
```

Confirmed against the golden. `testdata/codec/opencode-golden.json`'s single case
has 10 messages; message index 2 has parts
`["step-start", "text", "tool", "step-finish", "patch"]`. `codec/mod.rs:88`
asserts:

```
88:             assert_eq!(encoded, strip_opencode_compaction(case.messages));
```

and `strip_opencode_compaction` (`:273-281`) removes only `compaction` parts. So
the `patch` part at message 2 must round-trip byte-identically, and the test
passing at `HEAD` is direct evidence that it does. `codec/mod.rs:74` lists
`"patch"` in the required coverage list and the golden's `coverage` array
includes it, so this is deliberate coverage rather than an accident of the
fixture.

Nothing covers `snapshot`, `agent`, or `retry`. None appears in either golden's
`coverage` list, in `missing_capture_classes`, or in the required list at
`codec/mod.rs:62-75`. So three of the four types named in the match arm are not
named anywhere in the test surface.

The other side of the property — that no transform decision sees them — follows
from the block projection. `ck_wire.rs:364-366` `project_messages` builds
`FlatBlock`s from `msg.ck.content`, which is exactly the `content` vector these
four types never enter. So every downstream consumer of `FlatProjection`
(byte accounting, tag numbering, decay, boundary selection) is structurally
blind to them.

## Failure scenario

Two shapes, and only the second is a defect today.

Not a defect: a `patch` part is invisible to the CK view and present on the wire.
That is the intended arrangement, and the golden pins it.

A latent defect: the module's byte accounting is computed over `FlatBlock.bytes`
(`ck_wire.rs:585-590` serialises the block to derive it), which excludes these
four types. If a `patch` part ever carries a diff body of meaningful size, the
module's measurement of the array it is about to hand the provider is short by
exactly that amount, on every pass, silently. The context-window budget is derived
from that measurement, so the module would under-count and could hand the provider
an array over the limit while believing it is under.

The second failure mode is a maintenance one: because the immunity in
`remove_unretained_native_parts` is structural rather than declared, adding a
`BlockMeta` for one of these types (say, to make `patch` visible to the transform)
would simultaneously make it eligible for deletion compaction. A change intended
to add visibility would also add a deletion path.

## Timing windows and dependencies

None temporal. The dependency is on `remove_unretained_native_parts`'s
set-difference semantics, which is a pure function of the `BlockMeta` list.

Depends on: the retained-raw encoding path, which means it depends on
`meta_for_ck` (`codec/sidecar.rs:315-329`) finding the right meta. If a message
falls to `encode_new_message` (`codec/opencode.rs:968-1018`) because no meta
matched, there is no retained raw and the four types are gone. That happens for
module-authored messages, which never had them, so the composition is currently
safe; it is another undeclared dependency.

## What a test must construct

1. An OpenCode message carrying all four types, decoded and re-encoded, asserting
   all four survive at their original indices byte-identically. Today only `patch`
   is covered, and only via the whole-array golden.
2. The CK-side absence: assert `decoded.messages[i].ck.content` has no block for
   any of the four, and that no `BlockMeta` claims their native indices. Nothing
   asserts this today, so a change routing `patch` into the catch-all at `:194-204`
   would not be caught.
3. The composition with deletion: a message with a `patch` part plus at least two
   decoded blocks, delete one decoded block, re-encode, and assert the `patch`
   part is still present and the deleted block's part is gone. This is the shape
   `codec/mod.rs:216-252` uses but without an immune part in the array.
4. A byte-accounting assertion, which is 4b's territory: given a `patch` part of
   known size, assert the module's measured array size accounts for it or that the
   contract explicitly says it does not.

## Investigation log

### Q: Are all four types genuinely content-free for provider purposes?

- Sources examined: `codec/opencode.rs:193` and the surrounding arms;
  `testdata/codec/opencode-golden.json`'s `patch` part; both goldens'
  `projection_oracle`; `codec/mod.rs:62-75`.
- Findings: the golden's `patch` part is the only real specimen available in the
  tree. `snapshot`, `agent`, and `retry` have no specimen anywhere. The goldens'
  `projection_oracle.status` is `"todo"` with the reason "The OpenCode SDK
  serializer is not vendored in the Rust workspace test closure", so there is no
  in-tree authority on what any OpenCode part type contains or whether the
  provider serialiser forwards it.
- Missing evidence: the OpenCode part schema. Not vendored, by the goldens' own
  admission.
- Conclusion: unresolved, needs the OpenCode part schema. `patch` is the one whose
  name suggests a body. Note that being content-free for the *provider* and being
  content-free for the *array size the module measures* are different questions,
  and only the second one matters for the latent defect above.

### Q: Why are these four singled out rather than left to the catch-all?

- Sources examined: `codec/opencode.rs:150-204` (all the named arms);
  `codec/mod.rs:62-75` (the required coverage list, which includes `step_start`,
  `step_finish`, and `patch` but not `snapshot`, `agent`, or `retry`).
- Findings: three neighbouring types — `step-start`, `subtask`, `step-finish` —
  are explicitly turned into opaque blocks at `:150-160`, `:171-181`, and
  `:182-192`, using the same `opaque_block` helper the catch-all uses. So the
  author distinguished "opaque but present" from "omitted" deliberately for six
  types in a row. The four omitted ones are therefore a considered choice, not an
  oversight.
- Missing evidence: the reason. No comment on `:193`.
- Conclusion: resolved with answer on intent (it is deliberate), unresolved on
  rationale. The deliberateness is what makes the latent-defect framing correct:
  this is a designed lossy translation whose consequences for byte accounting are
  undocumented, not a bug.
