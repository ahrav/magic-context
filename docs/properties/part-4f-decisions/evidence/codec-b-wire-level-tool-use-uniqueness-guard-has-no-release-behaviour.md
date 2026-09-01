# codec-b-wire-level-tool-use-uniqueness-guard-has-no-release-behaviour

## Discovery trigger

The task brief noted a sibling part found a production `assert!` and an
`unreachable!` in this crate, and asked me to check the codec paths for panicking
constructs. `codec/opencode.rs:370` calls a function named
`assert_unique_tool_use_ids`, which reads like the production `assert!` the brief
described. It is not one. Reading its body, and then the same-named guard one
layer up, turned up a divergence in release behaviour between two checks of the
same invariant.

## Evidence trail

The call site, `crates/mc-module/src/codec/opencode.rs:350-372`, read at `HEAD`
`e447c927`:

```
358:     let encoded = encode_opencode_chunks_with_transition_state(
...
367:     .into_iter()
368:     .map(|chunk| chunk.value)
369:     .collect::<Vec<_>>();
370:     assert_unique_tool_use_ids(&encoded);
371:     encoded
372: }
```

The function, `:462-470`, in full:

```
462: pub(crate) fn assert_unique_tool_use_ids<'a>(
463:     messages: impl IntoIterator<Item = &'a MessageV2Json>,
464: ) {
465:     let duplicates = duplicate_tool_use_locations(messages);
466:     debug_assert!(
467:         duplicates.is_empty(),
468:         "OpenCode serialization produced duplicate tool_use ids: {duplicates:?}"
469:     );
470: }
```

That is the whole body. With `debug_assertions` off, the function computes a
`Vec<(String, usize, usize)>` and drops it. There is no branch, no log, no
repair, and no return value.

The detector it uses, `:438-460`, walks encoded parts and collects every repeat of
a `callID` on a part whose `type` is `"tool"`, keyed by a `HashSet` at `:441` and
`:454`.

The same-named guard one layer up, `crates/mc-module/src/transform.rs:11231-11251`:

```
11231: fn enforce_unique_tool_use_ids(
11232:     messages: Vec<ServedMessage>,
11233:     session_id: &str,
11234: ) -> Vec<ServedMessage> {
11235:     let duplicates = duplicate_tool_use_locations(&messages);
11236:     if duplicates.is_empty() {
11237:         return messages;
11238:     }
11239:
11240:     for (id, message_index, block_index) in &duplicates {
11241:         eprintln!(
11242:             "mc-module: duplicate_tool_use_id session={} id={} message_index={} block_index={} action=drop_later",
11243:             session_id, id, message_index, block_index
11244:         );
11245:     }
11246:     debug_assert!(
11247:         duplicates.is_empty(),
11248:         "served output contains duplicate tool_use ids: {duplicates:?}"
11249:     );
11250:
11251:     #[cfg(not(debug_assertions))]
11252:     {
```

The `#[cfg(not(debug_assertions))]` block at `:11251` onward removes the later
duplicate and, when removing it empties its owning message, also removes the
paired `ToolResult` from the following message (`:11267-11276`). So the two guards
diverge:

| | Debug | Release |
| --- | --- | --- |
| `transform.rs:11231` (CK level) | logs, then panics | logs, then heals by dropping the later duplicate |
| `codec/opencode.rs:462` (wire level) | panics | nothing |

Layer ordering. `transform.rs:12147` calls
`out = enforce_unique_tool_use_ids(out, &req.session_id)` on `Vec<ServedMessage>`,
which is CK-level, before encoding. `codec/opencode.rs:370` runs on the encoded
`Vec<MessageV2Json>`, after every render path. So the wire-level check is the last
thing that sees the array before it is returned, and it is the one with no release
behaviour.

That ordering is what makes the gap real rather than theoretical, because
encoding can introduce a duplicate the CK level never had. The encoder's own
comment says so, at `codec/opencode.rs:749-757`:

```
749:                 if call_native_index.is_none() && result_native_index.is_none() {
750:                     // OpenCode stores a completed invocation as one part, while CK expands that
751:                     // part into adjacent call and result blocks. This provider-validity invariant
752:                     // cannot depend on whether an older renderer-transition marker was persisted:
753:                     // two independently emitted shells carry the same callID.
754:                     parts.push(render_tool_pair_as_part(block, result));
755:                     block_index += 2;
756:                     continue;
757:                 }
```

"Two independently emitted shells carry the same callID" is the duplicate this
arm exists to avoid producing. It fires when neither the call nor the result
matched a native index, which is the fresh-shell case. The `parts.push` at `:754`
appends to a `parts` array that already contains whatever the retained raw had,
so a raw part with the same `callID` plus a freshly pushed shell is a duplicate
visible only after encoding.

Two independent detector implementations exist: `codec/opencode.rs:438-460` over
`MessageV2Json` parts, and `transform.rs:11235`'s `duplicate_tool_use_locations`
over `ServedMessage` content. Same name, same predicate, two representations,
maintained separately. Neither references the other.

Why the check is `always(!duplicate)` and not `unreachable`: per METHOD's rule,
the forbidden thing here is a *state* of the returned array. The guard at `:466`
is not a code point that must never execute; it executes on every encode. What
must never happen is that it finds something.

## Failure scenario

A release build. A CK message pair whose call and result both fail to match a
native index, in a message whose retained raw already carries a `tool` part with
the same `callID`. The encoder appends a second shell at `:754`.
`assert_unique_tool_use_ids` computes the duplicate and discards it. The array is
returned with two `tool` parts sharing a `callID`.

Anthropic-shaped providers reject a request containing two `tool_use` blocks with
one id, so the observable failure is a hard request error rather than a degraded
reply. The user sees a failed turn; the module's logs say nothing, because the
`eprintln!` lives in the CK-level guard and not this one.

The inverse asymmetry is the part worth noting: in a debug build the panic makes
this loud and easy to diagnose, and in the shipped build it is silent. That is
backwards for an invariant whose only consumer is the provider.

## Timing windows and dependencies

No temporal window. The ordering that matters is layer ordering, described above.

Depends on: `codec-b-block-identity-stamp-is-caller-writable-and-the-fingerprint-is-not-an-identity`,
because whether `call_native_index` and `result_native_index` are both `None` at
`:749` is decided by `match_block_metas`. A block whose stamp is lost or forged
takes a different alignment and therefore a different arm. So the two records
share a mechanism.

Depended on by: nothing in the module. The consumer is the provider.

## What a test must construct

1. A fixture where the retained raw carries a `tool` part with `callID = "c1"` and
   the CK content carries a call plus result for `"c1"` whose blocks have no stamp
   and no matching `BlockMeta`, forcing the `:749-757` arm. Encode and assert the
   returned array has no duplicate `callID`.
2. The same test under `cargo test --release`, because under `cargo test` the
   `debug_assert!` fires and the test cannot distinguish "the guard caught it" from
   "the encoder did not produce it".
3. A direct unit test on `assert_unique_tool_use_ids` with a hand-built duplicate
   array, asserting a declared outcome. There is no way to write this today
   because the function returns `()`; the test would have to be a
   `#[should_panic]` in debug, which is not the behaviour in question.
4. A cross-layer test asserting the two `duplicate_tool_use_locations`
   implementations agree on one input rendered both ways, so the pair does not
   drift.

## Investigation log

### Q: Should the wire-level guard adopt the CK-level heal, or should both fail loud?

- Sources examined: `codec/opencode.rs:350-372`, `:438-470`, `:749-757`;
  `transform.rs:11231-11290`, `:12147`; `transform.rs:21500-21530` (the two tests
  that exercise the CK-level guard).
- Findings: the CK-level heal is substantial, roughly 60 lines, and does more than
  drop a part: it tracks whether removing a duplicate empties its owning message
  and then removes the orphaned `ToolResult` from the next message
  (`:11267-11276`). That logic exists because dropping a call without its result
  would leave an unpaired result, which `ck_wire.rs:660-668` rejects. So a
  wire-level heal cannot simply mirror it; at the wire level the pair is already
  one part, so the removal is simpler, but the reasoning about what an empty
  message means is different.
- Missing evidence: whether the wire-level check was intended as a belt to the CK
  level's braces, on the assumption the CK level already healed. The test names at
  `transform.rs:21509` and `:21522` include the word "belt", which is suggestive.
- Conclusion: needs human input. The two layers encode two answers to "what do we
  do about a duplicate", and picking one is a policy decision. The technically
  relevant fact is that the CK-level heal cannot cover an encoder-introduced
  duplicate, which is exactly the case `:749-757` warns about.

### Q: Is the scope map's description of `enforce_unique_tool_use_ids` accurate?

- Sources examined: `part-4-module/_lenses/scope-map-and-risk-ranking.md:601-604`;
  `transform.rs:11172` (`assert_no_orphaned_tool_arcs`), `:11231-11251`.
- Findings: the scope map at `:603` calls `assert_no_orphaned_tool_arcs` and
  `enforce_unique_tool_use_ids` "fail-loud production checks on the final array"
  and asks what each "actually panics on". At `HEAD`,
  `enforce_unique_tool_use_ids` is fail-loud in debug and fail-quiet-and-repair in
  release, so "fail-loud production check" is not accurate for a release build. I
  did not read `assert_no_orphaned_tool_arcs`, which is 4e's material.
- Missing evidence: none for the half I checked.
- Conclusion: resolved with answer for `enforce_unique_tool_use_ids`. Recorded as a
  lead and as an open question on the record, flagged for 4e rather than claimed,
  since that function is in 4e's footprint and the scope map's characterisation is
  a working note rather than a contract.

### Q: Is `codec/opencode.rs:370` reachable on the production path?

- Sources examined: `codec/opencode.rs:283-372`; `lib.rs:12682`, `:12949`;
  `transform.rs:15031`, `:16342`, `:16364`, `:17147`.
- Findings: `assert_unique_tool_use_ids` is called only from
  `encode_opencode_impl` at `:370`, which is the body of `encode_opencode`
  (`:283`), `encode_opencode_with_session` (`:298`),
  `encode_opencode_with_session_exemptions` (`:310`), and
  `encode_opencode_with_transition_state` (`:326`). `lib.rs:12682` calls
  `encode_opencode_with_transition_state` on the production native path.
  `encode_opencode_chunks_with_transition_state` (`:374`), called directly from
  `lib.rs:12949`, does **not** call the guard, because the guard is applied in
  `encode_opencode_impl` after collecting chunks.
- Missing evidence: none.
- Conclusion: resolved with answer, and it sharpens the record. The guard is on the
  production path via `lib.rs:12682`, but the incremental chunk path at
  `lib.rs:12949` bypasses it entirely, in debug as well as release. So there is a
  production encode route with no uniqueness check at any strength. Added to the
  record's impact reasoning.
