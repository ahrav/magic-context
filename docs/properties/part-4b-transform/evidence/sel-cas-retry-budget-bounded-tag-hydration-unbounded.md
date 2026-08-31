# sel-cas-retry-budget-bounded-tag-hydration-unbounded

## Discovery trigger

Task 2 asks what budget a firing has and what happens on exhaustion. Cataloguing
the retry budgets turned up an asymmetry: the outermost loop in the pass path is
explicitly bounded and carries a doc comment explaining why, and a loop 5,000
lines further down in the same file has neither.

## Evidence trail

The bounded loop. `transform.rs:82-83`:

```
/// Max CAS retries before surfacing the conflict (the module is the single writer in
/// the daemon case, so this rarely loops; the shared-store case re-loads and re-steps).
const MAX_CAS_RETRIES: u32 = 8;
```

Enforced in `apply_once_with_estimator_and_projection` (`:2261-2300`):

```
let mut attempt = 0;
let mut boundary_divergence_retry = false;
loop {
    ...
    match apply_once(..) {
        Err(TransformError::Store(McStoreError::CasConflict { .. }))
            if attempt < MAX_CAS_RETRIES =>
        {
            boundary_divergence_retry |= boundary_divergence_detected;
            attempt += 1;
            continue;
        }
        Ok(mut output) => { ...; return Ok(output); }
        other => return other,
    }
}
```

On exhaustion the guard fails, the match falls to `other => return other`, and the
`CasConflict` propagates. Nothing partial survives, because every write for the
pass is inside the single `store.commit_transform` call at `:5565-5597`, and that
call is what raised the conflict.

The unbounded loop. `load_cached_tags` (`transform.rs:7639-7696`):

```
fn load_cached_tags(store: &McStore, session_id: &str) -> Result<Arc<Vec<McTagRow>>, TransformError> {
    let store_namespace = store.tag_cache_namespace();
    loop {
        let summary = store.tag_cache_summary(session_id)?;
        let cached = tag_baseline_cache().lock()...snapshot(session_id);
        if let Some(entry) = cached {
            if entry.matches(store_namespace, summary) { return Ok(entry.tags); }
            if entry.can_append(store_namespace, summary) {
                let tail = store.load_tags_after(session_id, entry.max_tag_number)?;
                let observed = store.tag_cache_summary(session_id)?;
                ...
                if observed == summary && tail.len() == appended && ... { ...; return Ok(tags); }
                continue;                      // :7677
            }
        }
        let tags = Arc::new(store.load_tags_for_session(session_id)?);
        let observed = store.tag_cache_summary(session_id)?;
        if observed.count == tags.len() && observed.max_tag_number == ... { ...; return Ok(tags); }
    }                                          // implicit retry: falls off the end of the loop body
}
```

Two retry paths. The explicit `continue` at `:7677` when the append fast path
fails its post-read verification, and the implicit fall-through at `:7695` when
the full reload's verification fails. Neither increments a counter. There is no
`attempt` variable in the function.

Called once per pass at `transform.rs:3391`
(`let mut tag_rows = load_cached_tags(store, &req.session_id)?;`), before
selection, so a livelock here hangs the pass before any work is done.

Why the verification can fail repeatedly. The cache entry's validity is a
`(store_namespace, generation, count, max_tag_number)` tuple
(`:7516-7523`), and the header states the generation "is advanced by SQLite
triggers for every tag-table mutation" (`:7513`). `can_append` requires
`summary.generation.saturating_sub(self.generation) == appended as u64`
(`:7539`), an exact arithmetic identity between generation delta and row delta.
Any mutation that is not a plain append breaks that identity, and the full-reload
arm then has to catch a stable `(count, max_tag_number)` pair between two reads
(`:7684-7687`). A concurrent tag mint from another route on the same session, or
another process on the same store, can invalidate each attempt.

The evidence that hangs on this path are a real operational concern: `lib.rs`
carries a whole transform wedge detector, `DispatchHealth` plus
`TransformDispatchTicket` and its `Drop` (`lib.rs:353-508`), which exists to
notice a transform that stopped making progress.

## Failure scenario

Two OpenCode instances share one Magic Context database, which
`CONFIGURATION.md:765` explicitly contemplates ("multiple OpenCode instances, or
OpenCode + Pi"). Instance A drives a transform for session S and enters
`load_cached_tags`. Instance B is minting tags for S on its own pass. A reads
`tag_cache_summary`, decides on the append path, reads the tail, re-reads the
summary, finds it moved, and `continue`s. B mints again. A retries. With B minting
at a rate comparable to A's read latency, A spins.

A's pass never returns, so it never commits and never releases whatever the
handler holds. The wedge detector notices, but the pass itself has no way out
because there is no budget to exhaust.

## Timing windows and dependencies

The window is any interval during which tag mutations for one session arrive at
least as fast as `load_cached_tags` can complete a verified read. That is a
livelock window, not a deadlock: forward progress is possible on any iteration, so
the loop is not provably non-terminating, only unbounded.

Dependency: whether `can_append`'s generation arithmetic is monotone. If each
retry necessarily observes a strictly larger `generation`, and if the writer rate
is finite, the loop converges. I could not establish that from the code, because
the failing branch discards the newly read `summary` and starts over from a fresh
`tag_cache_summary` call at `:7646` rather than carrying progress forward.

## What a test must construct

The static half is cheap and is the property as stated: a check, or a review gate,
that every `loop` on the pass path has an attempt counter. `transform.rs:7641` and
`:2270` are the two loops; one has one.

The dynamic half needs a concurrent writer. `install_transform_attempt_hook`
(`transform.rs:2311-2321`) already provides an in-pass callback used by
CAS-conflict tests; a test could install a hook that mints a tag on every
invocation and then assert that `load_cached_tags` terminates within a bounded
number of store reads. That requires a read counter the function does not
currently expose, so the test would need either a counting store wrapper or a new
seam.

## Investigation log

### Q: Is the tag-hydration loop provably convergent?

- Sources examined: `transform.rs:7639-7696` in full; `TagBaselineCacheEntry`
  and its `matches` and `can_append` (`:7516-7546`); the cache struct and its
  `snapshot` / `replace` (`:7551-7595`); the header comment at `:7511-7515`.
- Findings: Each iteration begins by re-reading `tag_cache_summary` (`:7646`) and
  re-snapshotting the cache (`:7647-7650`), so no state carries between
  iterations except whatever another thread wrote to the shared cache. The
  `matches` fast path returns immediately when the tuple agrees, so a quiescent
  store terminates on the first or second iteration. Under sustained mutation
  there is no argument in the code that each iteration is closer to success.
- Missing evidence: The SQLite trigger definitions that advance the generation
  live in `mc-store` and were not read. If the generation advances exactly once
  per inserted row and tag rows are insert-only, `can_append`'s identity holds for
  every pure-append interleaving and the loop converges in two iterations. That is
  the likely design, but it is an assumption, not a verified fact, and the header's
  claim that any other transition "requires a full refill" (`:7514-7515`) implies
  the authors expected non-append transitions to exist.
- Conclusion: unresolved, needs the trigger definitions plus a statement of which
  tag columns are mutable after insert. Until then the missing counter is the
  finding, and it is verifiable statically.

### Q: Does exhausting the CAS budget leave partial work?

- Sources examined: `transform.rs:2282-2292`, `:5556-5601` (the commit region),
  `:5604-5613` (the serialized-output cache write).
- Findings: The durable commit is one `commit_transform` call, so a conflict
  leaves the row untouched. But the process-local serialized-output cache is
  written *after* the commit at `:5604-5613`, and on a conflict that code is never
  reached, so the cache is also untouched. The stderr diagnostics at `:5615-5644`
  are likewise after the commit.
- Missing evidence: whether any earlier side effect in `apply_once` escapes.
  `EMERGENCY_REASONING_EXCLUSIONS.fetch_add` at `:4195-4198` is a process-global
  counter incremented *before* the commit, so it double-counts across CAS retries.
  That is a metrics defect, not a durability one.
- Conclusion: resolved with answer. No durable partial work survives. One global
  counter over-counts on retry, which is worth a note but is not this record's
  subject.
