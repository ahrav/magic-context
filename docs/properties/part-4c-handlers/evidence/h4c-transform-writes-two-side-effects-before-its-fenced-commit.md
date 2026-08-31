# h4c-transform-writes-two-side-effects-before-its-fenced-commit

## Discovery trigger

The transform pass is described throughout the crate as ending in a single
compare-and-swap: the scope map calls it "cache state, module meta, tag rows, all
committed behind one CAS"
(`docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:465`).
Reading `handle_transform_unpaged_value` forward from its entry at
`crates/mc-module/src/lib.rs:8007`, three durable writes happen *before* the pass
engine is called at all, and two of them are unconditional side effects rather
than traces.

All references are to `crates/mc-module/src/lib.rs` unless stated. Verified at
`HEAD` `b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**Write one: the project mural artifact.**

```
8207        match serializer_profile {
8208            Some(SerializerProfile::OpencodeAiSdk) => {
8209                if let Some((data_url, content_hash)) = host_mural_artifact(parsed.mural.as_ref()) {
8210                    if let Err(error) = store.upsert_project_mural_artifact(
8211                        &project_path,
8212                        data_url.as_bytes(),
8213                        &content_hash,
8214                        pass_now,
8215                    ) {
8216                        return PreparedOutcome::Error {
8217                            code: "mural_artifact_store_failed".to_string(),
```

Note the scope: `&project_path` at `:8211`, resolved at `:8184-8194` from the
route's authority project. This is a *project*-scoped write, wider than the session
the pass belongs to.

**Write two: the historian side-channel drain.**

```
8249        // A previous publish may have committed while one independent side channel failed.
8250        // Retry on normal traffic rather than creating another background timer.
8251        let side_channel_drain_started_at = Instant::now();
8252        let _ = store.drain_historian_side_channels(
8253            &parsed.session_id,
8254            pass_now,
8255            HISTORIAN_SIDE_CHANNEL_DRAIN_PER_KIND,
8256        );
```

**Write three: the received trace, with an explicit justification.**

```
8258        // This trace is intentionally outside the fenced cache-state commit: a rejected
8259        // pass must still leave a durable breadcrumb, and a trace failure must never
8260        // change the transform result.
8261        let trace_received_started_at = Instant::now();
8262        let _ = store.trace_pass_received(&parsed.session_id, pass_now);
```

**The engine runs afterwards, and its rejection returns an error.**

```
8330        let reject_transform = |e: crate::transform::TransformError| {
8331            let message = e.to_string();
8332            let _ = store.trace_pass_rejected(&parsed.session_id, &message, now_ms());
8333            PreparedOutcome::Error {
8334                code: "transform_failed".to_string(),
8335                message,
8336            }
8337        };
8338        let mut result = match run_transform() {
8339            Ok(result) => result,
8340            Err(e) => return reject_transform(e),
```

`run_transform` is the closure defined at `:8264` that calls
`transform_with_projection_cached`. So the order is: mural, drain, trace, engine,
then the fenced commit inside the engine. `response.committed` at `:8522` is the
handler's only view of whether the fence accepted.

**The Claude Code side reads the artifact back.**

```
8223            Some(SerializerProfile::ClaudeCodeAnthropic) => {
8224                match cc_mural_input(&store, &project_path) {
8225                    Ok(mural) => {
8226                        // The mural renderer is host-side by design. CC inherits the last OC artifact
8227                        // for this project and never renders or trusts a request-supplied mural itself.
8228                        // A CC-only project has no artifact, so it correctly composes without a mural.
8229                        parsed.mural = mural;
```

This is what makes the mural write's failure interaction matter: the artifact an
OpenCode pass writes becomes the input other sessions in the same project inherit.

**Idempotency of the mural write.** `content_hash` at `:8213` comes from
`host_mural_artifact` (`:197-213` per the region map), which derives it from the
mural content. So a repeat delivery of the same request writes identical bytes
under an identical hash. Repeat delivery is benign; failure ordering is not.

## Failure scenario

1. An OpenCode session sends a transform request carrying a mural.
2. `:8209` matches, `:8210` commits the artifact for the whole project.
3. `:8252` drains side channels. `:8262` writes the received trace.
4. `run_transform` at `:8338` returns `Err`, for example because the engine
   rejected the input shape or a boundary guard fired.
5. `:8340` returns `transform_failed`.
6. The caller sees a total failure. The project's mural artifact has nonetheless
   been replaced.
7. A later Claude Code pass in the same project calls `cc_mural_input` at `:8224`
   and inherits the artifact from the pass that failed.

The same ordering applies when the pass runs but its fenced commit is rejected;
`response.committed` is then false while the mural write stands.

## Timing windows and dependencies

Not a race. The window is the whole body of the pass engine, which is long, but
the trigger is an ordinary engine rejection rather than an interleaving.

Dependency on `serializer_profile`: only `OpencodeAiSdk` reaches the write at
`:8210`. A Claude Code pass takes the `:8223` branch and only reads. So the
property is conditional on profile, which the test must set.

Dependency on request content: `host_mural_artifact` must return `Some`, so the
request must carry a mural.

## What a test must construct

- A transform request with `serializer_profile` = OpenCode and a mural that makes
  `host_mural_artifact` return `Some`.
  `cc_inherits_oc_project_mural_on_a_natural_hard_without_defer_first_apply`
  (`:18591`) already builds an OpenCode pass that writes a mural and a Claude Code
  pass that inherits it, so the fixture exists; the test needs the OpenCode pass to
  fail afterwards.
- A `TransformError` from the engine, or a fenced-commit rejection. The transform
  module has an attempt-hook registry for test interleaving
  (`crates/mc-module/src/transform.rs:2303-2322` per the region map), which is the
  likely seam.
- Oracle: snapshot the project's mural artifact before the request; after any
  `transform_failed` response, assert it is unchanged. This is the property
  statement and it does not require observing a corrupted state, only comparing
  before and after.
- Coverage form for the preconditions: assert independently that the response code
  was `transform_failed` and that `host_mural_artifact` returned `Some` for the
  request. Both hold on a correct implementation and together they mark the window
  as entered.
- The side-channel half of the property needs a due side-channel row so the drain
  has work; `fail_next_historian_side_channel_for_test`, used at `:30041`, is the
  seam.

## Investigation log

### Q: Is publishing a mural from a pass that then fails intended?

- Sources examined: the comment at `:8226-8228`, which explains CC inheritance and
  says CC "never renders or trusts a request-supplied mural itself"; the comments at
  `:8249-8250` and `:8258-8261`, which do justify the other two pre-fence writes;
  the absence of any comment on `:8210-8221`.
- Findings: the authors annotated fence placement deliberately in two of three
  cases. The drain comment explains *why* it must be outside the fence (retry on
  normal traffic). The trace comment explains it explicitly, including the rejected
  pass case: "a rejected pass must still leave a durable breadcrumb". The mural
  write has no such statement, and unlike a trace or a retry-drain it is content
  the system later serves.
- Missing evidence: author intent for the mural specifically.
- Conclusion: unresolved. The asymmetry in commenting is the strongest available
  signal and it points to an oversight, but I am not treating an absent comment as
  proof of intent. Recorded as a contract-vs-code lead (L3 in the lens) rather than
  a resolved defect.

### Q: Does the double-apply on retry cause harm?

- Sources examined: `:8210-8215` for the arguments; `host_mural_artifact` at
  `:197-213` per the region map for where `content_hash` comes from.
- Findings: the write is keyed by `(project_path, content_hash)` with the hash
  derived from the content, so two deliveries of the same request write the same
  bytes. `upsert` semantics mean the second is a no-op or an identical rewrite.
- Missing evidence: whether `upsert_project_mural_artifact` bumps a generation or
  timestamp that other readers key on. `pass_now` at `:8214` is passed in, so a
  timestamp is likely stored and would differ between deliveries.
- Conclusion: resolved for content, unresolved for metadata. Content double-apply
  is benign. Whether the stored timestamp moving on a repeat matters needs the store
  function, which is Part 3's scope.

### Q: Is `response.committed` at `:8522` a reliable signal that the fence accepted?

- Sources examined: `:8521-8527`, where `committed` gates only the removal of the
  guidance-date memo; the surrounding code, which uses `committed` for nothing else
  in this region.
- Findings: the handler reads `committed` but never treats a false value as a
  failure; it returns the response either way. So a fence rejection is reported to
  the caller as a successful response with `committed: false`, not as an error.
- Missing evidence: none for this question.
- Conclusion: resolved with answer. The pre-fence writes therefore persist on both
  the error path (`:8340`) and the not-committed path, and the two are reported
  differently to the caller.
