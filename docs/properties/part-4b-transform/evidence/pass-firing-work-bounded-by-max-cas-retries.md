# pass-firing-work-bounded-by-max-cas-retries

## Discovery trigger

The task asked what bounds work per firing. The retry loop has an explicit
constant, which answers the question for the CAS path. Checking whether anything
else in the pass loops turned up one loop with no bound at all.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

### The bounded retry loop

- `transform.rs:82` — `const MAX_CAS_RETRIES: u32 = 8;` with the doc at
  `:80-81`: "Max CAS retries before surfacing the conflict (the module is the
  single writer in the daemon case, so this rarely loops; the shared-store case
  re-loads and re-steps)."
- `transform.rs:2269` — `let mut attempt = 0;`
- `transform.rs:2274` — `loop {`
- `transform.rs:2276-2282` — the `apply_once` call
- `transform.rs:2283-2284` — `Err(TransformError::Store(McStoreError::CasConflict
  { .. })) if attempt < MAX_CAS_RETRIES =>`
- `transform.rs:2290-2291` — `attempt += 1; continue;`
- `transform.rs:2293-2296` — the `Ok` arm returns
- `transform.rs:2298` — `other => return other,`

So the loop runs for `attempt` in `0..=8`, giving at most nine `apply_once`
invocations, and only a `CasConflict` continues. Every other error, including
`CoverageGap`, `IdentityDrift`, `ReductionConflict`, `BoundaryNotPresent`,
`UnknownShape`, `ReservedId`, `DuplicateBlockId`, `OrdinalViolation` and
`LineageProtocol`, returns on the first occurrence.

Within one `apply_once`, the other explicit bound on repeated work is
`BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT` (`transform.rs:85`, value 3) with the
doc at `:83-84`: "Limit consecutive passes that may ignore a coverage gap when
the applied compartment watermark is missing or stale; after this limit, the gap
is repaired instead of suppressed." It is applied at `:3931-3937` via
`.min(BOUNDARY_DIVERGENCE_PENDING_PASS_LIMIT)` and consulted at `:3944-3945`.
That bound is in passes, not in one firing, so it does not bound this firing's
work; it bounds how long a repair can be deferred across firings.

### The unbounded loop

`load_cached_tags` (`transform.rs:7639-7697`), called from the engine at
`transform.rs:3391`:

- `:7644` — `loop {`
- `:7645` — `let summary = store.tag_cache_summary(session_id)?;`
- `:7646-7649` — take the process-wide baseline snapshot
- `:7652-7654` — exact-match return
- `:7655-7679` — the append-only path: load the tail (`:7656`), re-read the
  summary (`:7657`), and return only if `observed == summary && tail.len() ==
  appended && tail.last().is_some_and(|tag| tag.tag_number ==
  summary.max_tag_number)` (`:7659-7663`). Otherwise `continue` at `:7678`.
- `:7682-7695` — the full reload path: load all tags (`:7682`), re-read the
  summary (`:7683`), and return only if `observed.count == tags.len() &&
  observed.max_tag_number == tags.last().map_or(0, |tag| tag.tag_number)`
  (`:7684-7685`). Otherwise control falls off the end of the loop body and the
  loop repeats.

Neither exit counts attempts. Both are optimistic revalidations against a value
that another writer can keep moving. There is no backoff, no attempt cap, and no
error return for repeated failure.

The loop body is sub-part 4e's scope (`transform.rs:7511-12623`). The unbounded
call from the engine at `:3391` is 4b's.

### Why the caller cannot absorb a spin

- `mc-module/src/lib.rs:8322` — `transform_with_projection_cached(&store,
  &parsed, &producer_ctx, &self.serialized_outputs,
  projection_cache_input.as_ref())`, called through the `run_transform` closure
  and invoked at `:8338` inside an `async fn`. There is no `spawn_blocking`
  around it; the only `spawn_blocking` in `lib.rs` is at `:3659`, for
  `McStore::open`.

So the whole pass, including `load_cached_tags`, occupies a tokio worker thread
for its duration.

### Who could keep the tag summary moving

`mc_tags` writers in a default build are `commit_transform`
(`mc-store/src/lib.rs:7502`) and `descend_lineage` (`:8727-8734`).
`mint_or_get_tags` (`:6258`) is annotated
`#[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]`
(`:6257`) with the comment (`:6255-6256`) that only in-crate tests reach it
without that feature. So a livelock needs two transform commits, or a
`descend_lineage`, firing repeatedly against the same session while a third
request sits in `load_cached_tags`.

## Failure scenario

Bounded half: a shared-store deployment with a second writer produces nine
`CasConflict`s in a row. The tenth conflict is returned as
`TransformError::Store(CasConflict)`, the handler maps it to
`transform_failed` (`lib.rs:8330-8337`), and the host serves the raw array for
that turn. That is the designed behaviour and it terminates.

Unbounded half: a session under enough tag churn that
`store.tag_cache_summary` changes between each pair of reads inside
`load_cached_tags` keeps the loop spinning. Each iteration issues at least two
store queries under the connection mutex
(`../commons/crates/cortexkit-store/src/lib.rs:189`), so the spinning request
also serialises against every other store user in the process while making no
progress. Nothing surfaces the condition: no counter, no log, no deadline.

## Timing windows and dependencies

The retry bound is unconditional.

The unbounded loop's reachability depends on whether two writers can touch one
session's tags while a third pass reads them. That is the same open concurrency
question that
[defer-commit-carries-no-compartment-fence](defer-commit-carries-no-compartment-fence.md)
depends on, and it belongs to sub-part 4c.

## What a test must construct

For the bound, with an explicit bounded window in attempts rather than
wall-clock:

1. Register the `#[cfg(test)]` attempt hook (`transform.rs:5563-5564`,
   registry at `:2303-2333`) with a closure that commits a conflicting
   cache-state row on each of the first three invocations and then stops.
2. Call `transform`. Assert it returns `Ok` and that the hook fired exactly four
   times: three conflicts plus the successful attempt. Stating the bound in
   attempts is what METHOD.md's liveness rule requires; a timeout could not
   distinguish four attempts from four hundred.
3. Register a closure that conflicts on every invocation. Assert the call
   returns `Err(TransformError::Store(CasConflict { .. }))` and that the hook
   fired exactly nine times.

For the unbounded loop, a bounded probe rather than a livelock demonstration:

1. Drive `load_cached_tags` with a store whose `tag_cache_summary` is
   instrumented to change on every call for the first N calls, then stabilise.
2. Count iterations and assert the function returns after the summary
   stabilises. This proves the loop makes progress once churn stops, which is the
   honest liveness statement, and it makes the iteration count observable so a
   regression that removes the stabilisation exit is visible.
3. Do not write an unbounded "eventually returns" test. It cannot fail.

## Investigation log

### Q: Is `load_cached_tags`'s loop livelock-reachable in production?

- Sources examined: `transform.rs:7639-7697` line by line; `:3391`;
  `mc-store/src/lib.rs:6255-6258` (the `mint_or_get_tags` gating), `:7483-7515`
  (`commit_transform`'s tag inserts), `:8727-8734` (`descend_lineage`'s tag
  copy); `mc-module/src/lib.rs:8322`, `:8338`, `:3659`.
- Findings: the loop has no attempt cap. In a default build the only two
  production tag writers are the transform commit and the lineage descent, and
  both also bump `row_version`, so a *single-writer* deployment cannot produce
  the churn. A shared-store or multi-request-per-session deployment could. The
  transform runs inline on a tokio worker, so a spin is not merely slow, it holds
  a worker.
- Missing evidence: whether two transform requests for one session can be in
  flight concurrently. Nothing in the 4b scope answers it;
  `lib.rs:8007-8615` is 4c.
- Conclusion: unresolved, needs the 4c dispatch and route-serialisation result.
  Stated as a bound gap rather than a demonstrated livelock.

### Q: Is nine the right count, or is it eight?

- Sources examined: `transform.rs:2269`, `:2283-2284`, `:2290-2291`.
- Findings: `attempt` starts at 0 and the guard is `attempt < MAX_CAS_RETRIES`,
  so the guard admits `attempt` values 0 through 7, each followed by `attempt +=
  1` and a `continue`. That is eight retries after the first attempt, so nine
  `apply_once` invocations total, and the ninth conflict is returned rather than
  retried.
- Missing evidence: none.
- Conclusion: resolved with answer — nine invocations, eight retries. The
  constant name is accurate.
