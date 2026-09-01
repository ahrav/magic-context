# output-cache-replace-trails-the-accepted-commit

## Discovery trigger

The engine holds an in-process cache of serialized output messages that is read
during the render and written after it. Since the render happens before the
commit and the write happens after, the ordering had to be checked in both
directions: can the cache be populated by a rejected pass, and can it serve
bytes from a superseded revert epoch.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

### The cache

`SerializedOutputCache` (`transform.rs:341-482` for the type and impl, with
`snapshot` at `:422-437` and `replace` at `:442-472`). It is keyed by session id
and each session entry carries the `revert_epoch` it was built under
(`SerializedOutputSession`, whose `revert_epoch` field is read at `:426`).

`snapshot` (`transform.rs:422-437`):

```
if self
    .sessions
    .get(session_id)
    .is_some_and(|session| session.revert_epoch != revert_epoch)
{
    self.remove(session_id);
}
```

so an epoch mismatch evicts before any entry is handed out.

`replace` (`transform.rs:442-472`) removes the prior session entry (`:449`),
recomputes retained bytes (`:450`), returns without inserting if the entry set
exceeds the budget (`:451-453`), inserts (`:455-464`), pushes to the LRU
(`:465`), and evicts oldest-first while over budget (`:466-471`).

### The read side, and why the epoch is already correct

- `transform.rs:5377-5382` — `let output_cache_snapshot = output_cache.map(|cache|
  { cache.lock().expect("serialized output cache mutex").snapshot(&req.session_id,
  meta.revert_epoch) });`

The key point is that `meta.revert_epoch` at `:5381` is already the post-truncate
value when a mid-pass revert happened. `meta.revert_epoch` is assigned from the
truncate outcome at `:4652` (`meta.revert_epoch = outcome.revert_epoch;`), which
is 729 lines before the snapshot. So a reconcile-rematerialize pass that bumps
the epoch cannot reuse cache entries built under the previous epoch: the
mismatch at `:423-429` evicts them.

The snapshot is then handed to the three `build_output_with_tags` calls at
`:5383-5400`, `:5406-5423`, `:5435-5449`.

### The write side

- `transform.rs:5565` — `store.commit_transform(..)?`. The `?` propagates a
  `CasConflict` out of `apply_once`, so nothing below it runs on a conflict.
- `transform.rs:5604-5613` — `if let Some(cache) = output_cache {
  cache.lock().expect("serialized output cache mutex").replace(&req.session_id,
  meta.revert_epoch, output_cache_entries, output_cache_stats); }`

So `replace` is reached only when either the commit succeeded or
`commit_required` was false (`:5600-5602`, the `else` arm returning
`loaded.row_version.unwrap_or(0)`). A `commit_required == false` pass by
definition produced `core == loaded.core && meta == loaded.meta` and no consumed
drops and no overlays, so caching its entries is caching bytes the store already
agrees with.

### The production drift check, and where it lives

- `transform.rs:5451-5479` — a `#[cfg(test)]` block that re-renders the whole
  output with `output_cache_snapshot` replaced by `None` and asserts
  `assert_eq!(cached_bytes, fresh_bytes, "serialized output cache drift")` at
  `:5478`, comparing `ServedMessage::canonical_bytes` for every message.

This is the strongest check in the engine and it is compiled out of production
builds. The existing behavioural test on the epoch eviction is
`serialized_output_cache_revert_epoch_bump_evicts_session`
(`transform.rs:28884`), whose body asserts
`!cache.snapshot(&request.session_id, 3).entries.is_empty()` at `:28894` and
`cache.snapshot(&request.session_id, 4).entries.is_empty()` at `:28896`.

### The caller that owns the cache

`mc-module/src/lib.rs:8322-8328` passes `&self.serialized_outputs`, so the cache
outlives one request and is shared across all sessions on the handler. That is
what makes a stale entry consequential: it would be served to the next request
for the same session, not just to this one.

## Failure scenario

Two directions, both currently prevented.

**Rejected-pass entries.** If `replace` ran before the commit, or on the error
path, a pass whose CAS lost would leave its rendered entries in the cache. The
winning pass's state would then be paired with the loser's serialized bytes on
the next request, because `snapshot` only validates the revert epoch, not the
core version or the row version. The served array would contain bytes no accepted
pass produced, which is indistinguishable downstream from a byte-stability
violation and would bust the provider prefix.

**Pre-revert entries after a mid-pass truncate.** If the snapshot at `:5381` used
`loaded.meta.revert_epoch` instead of `meta.revert_epoch`, a
reconcile-rematerialize pass would reuse entries built over compartments the same
pass just deleted. The m0 unit would be re-rendered because the pass is a HARD,
but tail messages served from cache could carry stale identity or stale tag
prefixes.

## Timing windows and dependencies

Window for the first direction: `:5565` to `:5613`. It is closed by the `?` at
`:5599`.

Window for the second: `:4652` (epoch assigned) to `:5381` (snapshot taken). It
is closed by the snapshot using the mutated `meta`, not `loaded.meta`.

Dependency: `snapshot` validates only `revert_epoch`. Correctness of a cache hit
therefore rests on the entry keys and identity carrying everything else that
distinguishes two renders of the same block. `message_output_identity`
(`transform.rs:11014-11096`) computes that identity and is sub-part 4e's scope,
so this record does not claim the identity is sufficient, only that the epoch
gate and the commit ordering are correct.

## What a test must construct

1. **Rejected pass leaves no entries.** Register the `#[cfg(test)]` attempt hook
   (`:5563-5564`) to commit a conflicting cache-state row on every invocation, so
   the firing exhausts its retries and returns
   `Err(TransformError::Store(CasConflict))`. Then assert
   `cache.metrics()` (`transform.rs:407-415`) reports zero entries for that
   session, or that `snapshot` returns an empty entry set. This passes today and
   is a regression guard on the `?` at `:5599`.
2. **Mid-pass epoch bump evicts.** Prime the cache by running one successful
   pass. Then drive a reconcile-rematerialize pass that truncates (the
   construction in
   [revert-truncate-commits-outside-the-terminal-cas](revert-truncate-commits-outside-the-terminal-cas.md),
   with a composition that succeeds). Assert the served bytes are byte-identical
   to a run of the same pass with `output_cache: None`. That is the same oracle
   the `#[cfg(test)]` block at `:5451-5479` uses, applied deliberately to the
   epoch-bump path rather than incidentally.
3. **Budget drop does not corrupt.** Set `max_retained_bytes` below the entry-set
   size so `replace` returns early at `:451-453`. Assert `retained_bytes` is
   unchanged and `snapshot` returns empty rather than a partial set.

## Investigation log

### Q: Does `replace` silently drop the whole entry set when it exceeds the budget, and does anything observe that?

- Sources examined: `transform.rs:442-472`, `:450-453`, `:406-415`
  (`metrics`), `:376-402` (`entries_retained_bytes`).
- Findings: yes, `:451-453` is `if retained_bytes > self.max_retained_bytes {
  return; }`, after `self.remove(session_id)` at `:449`. So an over-budget session
  is left with no cached entries at all rather than a partial set, which is the
  safe direction: the next pass simply re-serializes. `metrics` exposes
  `(retained_bytes, entry_count)` but nothing distinguishes "never cached" from
  "dropped for budget", so an operator cannot tell a permanently uncached session
  from a cold one.
- Missing evidence: the configured `max_retained_bytes` and whether a realistic
  session can exceed it. `SerializedOutputCache::new` (`:367-374`) takes the
  budget as a parameter and the constant lives on the handler side, which is
  sub-part 4c.
- Conclusion: resolved with answer on the mechanism — the drop is total, not
  partial, so it is a performance concern rather than a correctness one.
  Unresolved on whether it is reachable with the shipped budget; routed to 4c's
  cache-validity focus rather than cataloged here.

### Q: Is the epoch the only thing `snapshot` validates?

- Sources examined: `transform.rs:422-437`, and the `SerializedOutputCacheEntry`
  fields read at `:390-397` (`identity`, `served`).
- Findings: yes. `snapshot` compares only `session.revert_epoch != revert_epoch`.
  Everything else that must match is carried in each entry's `identity`, which
  `cached_or_serialize_output` (`transform.rs:11098`-region) compares per message.
  That comparison is 4e's scope.
- Missing evidence: whether `message_output_identity` (`:11014-11096`) covers
  every input that can change a message's serialized bytes.
- Conclusion: unresolved, needs 4e. Recorded as the dependency this record's
  guarantee rests on, so a reader does not mistake "the epoch gate is correct"
  for "cache hits are correct".
