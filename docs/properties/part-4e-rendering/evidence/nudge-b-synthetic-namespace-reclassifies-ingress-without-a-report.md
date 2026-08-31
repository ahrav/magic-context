# nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report

## Discovery trigger

Task 3 asked whether a caller-supplied value can cause injection of content the
caller did not author. Tracing the trust boundary on the injection namespace
turned up the inverse hazard: a caller-supplied value that causes *removal* of
content the caller did author, with no report.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The namespace test

`crates/mc-module/src/injection.rs:195-197`:

```
pub fn is_synthetic_todo_id(id: &str) -> bool {
    id.starts_with(SYNTHETIC_CALL_ID_PREFIX)
}
```

`SYNTHETIC_CALL_ID_PREFIX` is `"mc_synthetic_todo_"` (`:23`). The check is prefix
only, with no length, charset, or hash validation, and a test pins that:
`synthetic_id_detection_is_prefix_only` (`:906-910`) asserts
`is_synthetic_todo_id("mc_synthetic_todo_0123456789abcdef")` and
`!is_synthetic_todo_id("toolu_0123456789abcdef")`. The real ids are
`prefix + sha256[:16]` (`:121-125`), so the space of accepted ids is far wider
than the space of ids the module produces.

### The reclassification

`crates/mc-module/src/transform.rs:2405-2421`:

```
fn normalize_synthetic_todo_ingress(req: &TransformRequest) -> Option<TransformRequest> {
    let mut normalized = None;
    for (index, message) in req.messages.iter().enumerate() {
        if message.ck.meta.synthetic
            || !message.ck.content.iter().any(|block| match &block.kind {
                ck_wire::CkKind::ToolCall { id, .. } | ck_wire::CkKind::ToolResult { id, .. } => {
                    is_synthetic_todo_id(id)
                }
                _ => false,
            })
        {
            continue;
        }
        let next = normalized.get_or_insert_with(|| req.clone());
        next.messages[index].ck.meta.synthetic = true;
    }
    normalized
}
```

The write is at `:2419`. It runs once per request at `:3243`
(`let normalized_req = normalize_synthetic_todo_ingress(req);`).

Note the block-level `any`: a message with ten blocks, one of which carries such
an id, has the whole message marked synthetic.

### What being synthetic costs a message

Two consequences, both silent.

1. **Excluded from the served array.** The tail loop in
   `build_output_with_tags_inner` filters on
   `!message.ck.meta.synthetic` (`:11842-11845`). A reclassified message is never
   pushed to `out`.
2. **Excluded from overlay application.** `apply_tag_overlay_to_message` returns
   early on `ingress.ck.role == "system" || ingress.ck.meta.synthetic`
   (`:8222-8224`).

Additional reachable exclusions using the same flag, found by grepping
`!message.ck.meta.synthetic`: `:2521`, `:2556`, `:2743`, `:3444`, `:12410`, plus
`eligible_authored_user_tail` (`:8560-8562`) and
`is_authored_user_message` (`:8542-8543`), which gate the temporal marker and the
auto-search hint.

### What records it

Nothing. `normalize_synthetic_todo_ingress` returns
`Option<TransformRequest>`, so the only signal is "the request was cloned". The
caller at `:3243` binds it and uses it; no count, no list of affected mids, and no
field in `TransformTimings` (`:1144-1310`) or the response.

Compare with the adjacent path that *does* report: `materialize_reason =
Some("synthetic_todo".to_string())` at `:4355` records that a materialization
happened for synthetic-todo reasons, which is a different event.

## Failure scenario

A harness or proxy assigns tool-call ids from a scheme that can produce a string
starting with `mc_synthetic_todo_`. It could be a deliberate namespace reuse, a
collision in a prefixed id scheme, or a replay of an older module-injected pair
whose hash no longer matches anything the module would build today.

The assistant message containing that tool call is marked synthetic and dropped
from the served array. Its matching `tool` result message, which carries a
*different* id, is not dropped. The provider now receives a tool result with no
preceding tool call: an orphan arc. That is precisely the shape the sibling lens
recorded as having no production detection
(`render-a-orphan-tool-arc-has-no-production-detection`), because
`assert_no_orphaned_tool_arcs` is `#[cfg(test)]` (`transform.rs:11171`).

The user-visible symptom is a provider 400 with no module-side explanation, or on
a tolerant provider, a conversation with a hole in it.

## Timing windows and dependencies

None. `normalize_synthetic_todo_ingress` runs once, synchronously, before the
projection is built.

Dependencies: the ingress message set, which is caller-supplied, and the codec
that produced the ids, which is `codec/opencode.rs` or `codec/pi.rs`.

## What a test must construct

1. A `TransformRequest` with a non-synthetic assistant message carrying a
   `ToolCall` whose id is `mc_synthetic_todo_notarealhash`, paired with a `tool`
   message carrying a `ToolResult` with the same id.
2. Assert the served array either contains both messages or reports their
   omission. Today it will contain neither, because the pair-detection at
   `codec/opencode.rs:916-947` requires `call.meta.synthetic` and both halves get
   marked.
3. The sharper case: mark only the assistant half's id with the prefix and leave
   the result id ordinary. Assert the served array does not contain an orphan
   result. This is the constructible orphan.
4. A negative control: the same id on a message that *is* already
   `meta.synthetic == true`. The `||` short-circuit at `:2408` skips it, so
   nothing should change.

The oracle must be the served array plus the response fields, not the internal
`normalized_req`, because the property is about observability.

## Investigation log

### Q: Can a tool-call id reaching the module be chosen by anything other than the harness?

- Sources examined: `codec/opencode.rs` decode path (`:208-220` for
  `is_synthetic_message`, `:1277-1279`), `codec/sidecar.rs:331-339`
  (`is_synthetic_part`), `codec/pi.rs:189-230` (assistant decode).
- Findings: ids come from the harness's own part records. In the OpenCode shape
  the id is `callID` on a part; in the pi shape it is the `id` on a `tool_use`
  content block. Both originate provider-side or harness-side. Nothing in the
  decode path validates the id against a namespace, and nothing prevents a
  harness from emitting a prefixed id.
- Missing evidence: whether any real harness id scheme can collide, and whether
  a provider ever echoes a caller-chosen id. Both are codec questions.
- Conclusion: unresolved, needs 4f. The mechanism is certain; the exploitability
  is not.

### Q: Is the prefix check deliberately loose?

- Sources examined: `injection.rs:194-197` (the doc comment reads only "Return
  true when an id belongs to the synthetic-todowrite namespace"), the pinning
  test at `:906-910`, `transform.rs:2405` (no doc comment on
  `normalize_synthetic_todo_ingress` at all).
- Findings: a plausible reason is forward compatibility: a pair frozen under an
  older hash scheme, or a pair whose `state_json` no longer normalizes the same
  way, must still be recognised as module-authored on ingress so it is not served
  twice. A strict `prefix + 16 hex chars` check would still satisfy that, so
  looseness beyond the length is unexplained. The test name
  `synthetic_id_detection_is_prefix_only` reads as a deliberate pin, not an
  accident.
- Missing evidence: no comment states the intent.
- Conclusion: needs human input.

### Q: Does the reclassification interact with the anchored insertion, so a reclassified message could displace the injected pair?

- Sources examined: `transform.rs:11838-11839`
  (`synthetic_todo_render_anchor`), `:12091-12121` (the anchored insertion),
  `:11842-11845` (the loop filter).
- Findings: the render anchor is matched against `msg.mid` inside the loop
  (`:12094`), and the loop skips synthetic messages. If the pair's stored
  `anchor_mid` happened to name a message that got reclassified, the loop would
  never reach it, `inserted_synthetic_todo` would stay false, and the render
  would fail at `:12127-12131` with `SyntheticTodoAnchorMissing`. That is a loud
  failure, not a silent one.
- Missing evidence: whether the anchor can name a message carrying a synthetic
  id. `tail_end_mid` (`:7459`) picks the tail end, which on a replay could be the
  module's own previously injected pair's mid, but that message is already
  `meta.synthetic == true` on the way in, so `:2408`'s short-circuit skips it and
  the anchor logic never selects it (the pair is filtered from
  `req.messages` for anchoring purposes by the same `:11842-11845` loop).
- Conclusion: resolved with answer. The interaction exists but fails loud, so it
  does not widen this record.
