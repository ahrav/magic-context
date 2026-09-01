# stagelc-completed-replay-results-are-uncharged-and-unexpiring

## Discovery trigger

The coordinator table asked for terminal states. Both the page and seed
coordinators turned out to have two: the phase returning to `Idle`, and a
separate `completed` slot that outlives the phase. Asking what that slot holds
and who charges it produced this record.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

What the slot holds:

- `:1042-1047` — `struct CompletedTransformPage { transform_id: String,
  generation: u64, final_digest: String, result: PreparedOutput }`. The `result`
  is the full prepared response.
- `:914-921` — `struct CompletedStateSyncSeed { seed_id, final_digest,
  generation, expected_seq, total, result: PreparedOutput }`.
- `:1050-1053` and `:924-927` — the session structs pair `phase` with
  `completed: Option<...>`, so the slot is per session, holding at most one
  result, overwritten on each success.

Where it is set, and critically in what order relative to the byte release:

- `:9541-9569` — the page completion block. `release_phase` runs first at
  `:9554-9557`, then `completed` is assigned at `:9558-9568`. By the time the
  assignment happens the phase has already been replaced with `Idle` at `:9547`.
- `:9091-9119` — the seed completion block, same ordering: `release_phase` at
  `:9101-9104`, then `completed` at `:9106-9116`, phase already `Idle` from
  `:9095`.

Why that ordering means the result is charged to nothing:

- `:1108-1114` — `TransformPageCoordinator::phase_bytes` returns
  `TransformPagePhase::Idle => 0` at `:1112`.
- `:958-964` — the seed equivalent returns 0 for both `Idle` and `AwaitingSeed`
  at `:962`.
- `:1120-1127` and `:983-990` — `release_phase` in both coordinators subtracts
  `phase_bytes(phase)` from `total_staged_bytes`. Since the staged bytes were
  fully subtracted before the result was stored, and the result's own size is
  never added, `total_staged_bytes` does not account for it.
- `:631` and `:625` — the budgets the result escapes:
  `TRANSFORM_PAGE_MAX_STAGED_BYTES` 128 MiB and
  `STATE_SYNC_SEED_MAX_STAGED_BYTES` 32 MiB.

Why it never expires:

- `:1004-1018` — the seed TTL sweep's filter destructures
  `StateSyncSeedPhase::Collecting(seed)` at `:1009` and returns `None` for
  anything else. A session whose phase is `Idle` and whose `completed` is
  `Some(...)` is skipped. `AwaitingSeed` is skipped too.
- `:970-981` — `discard_pending` touches only the phase; it does not clear
  `completed`.
- `:999-1002` — `evict` is the only seed path that removes the whole session and
  therefore the only one that frees the result. Its call sites are route
  replacement (`:3799`) and route teardown (`:4267`).
- `:1131-1144` — the page coordinator's `discard` does clear `completed` at
  `:1133`, so the page side is better off here than the seed side. But the page
  coordinator has no TTL sweep at all (see
  [stagelc-abandoned-page-collection-is-released-within-a-bounded-window](stagelc-abandoned-page-collection-is-released-within-a-bounded-window.md)),
  so `discard` only runs on route teardown, route replacement, or a subsequent
  malformed page.
- `:4256` — the teardown block is gated on the unbound route being the last for
  that session, so a multi-route session does not reach either release.

Where the slot is read, which is why it exists at all:

- `:9446-9460` — the page replay guard. On an exact match of `generation`,
  `page_complete`, and `final_digest`, it returns `completed.result.clone()`
  (`:9453`) without re-running the transform. On a digest mismatch it returns
  `digest_mismatch` (`:9455-9459`).
- `:8734-8748` — the seed equivalent, comparing `seed_id` and `final_digest`.

Reachability, both sides per METHOD.md rule 4:

- Config default: none. Both store sites are on the success path of the
  unconditional staging handlers.
- Shipped setup path: pages via
  `packages/plugin/src/hooks/magic-context/module-wire.ts:1097` and `:1131`
  against `MODULE_PAGE_MAX_BYTES` = `512 * 1024` (`module-wire.ts:20`); seeds via
  `packages/plugin/src/hooks/magic-context/module-state-sync.ts:1173`.
- Class: `default-production`.

## Failure scenario

A session completes a large paged transform. The staged page bytes are released
correctly, so `total_staged_bytes` returns to baseline and the budget looks
healthy. But the response body, which for a large transform is the biggest single
payload this handler produces, is retained in the session's `completed` slot,
charged to no budget and visible to no metric.

One such result is retained per session. Because the page coordinator's
`sessions` map has no removal path
([stagelc-transform-page-session-map-has-no-removal-path](stagelc-transform-page-session-map-has-no-removal-path.md)),
and because the seed coordinator's TTL sweep skips `Idle` phases, the retained
set is bounded only by the number of distinct sessions the daemon has served. The
byte budgets that exist to bound exactly this kind of retention do not see any of
it.

This is the heaviest growth vector in this lens, because the unit of growth is a
full transform response rather than a map key.

## Timing windows and dependencies

None for the accounting half: one successful paged transform demonstrates it
immediately.

The expiry half shares the quiescent window of the abandonment records. Note the
two coordinators differ here and the record covers both: the page side clears
`completed` on `discard` but has no TTL to reach `discard`; the seed side has a
TTL but its filter skips the state that holds `completed`. Neither combination
frees the result without a route teardown.

## What a test must construct

1. Bind route 1 to session A. Record `total_staged_bytes` as the baseline.
2. Send a complete multi-page transform series large enough that the response is
   substantial, so the retained result is measurable.
3. Assert `total_staged_bytes` returned to the baseline, which it does, and
   assert `sessions["A"].completed.is_some()`, which it is.
4. The accounting oracle: assert that
   `total_staged_bytes + sum(retained completed result bytes) <= max_staged_bytes`
   still holds, and more usefully that `total_staged_bytes` accounts for the
   retained result at all. `retained_size.rs` already exists for exactly this
   kind of accounting and is used by the four in-process caches, so the measuring
   tool is present.
5. The expiry oracle, seed side: stage and complete a paged seed, keep the route
   bound, drive `evict_stale_collectors` past the TTL by sending an unrelated
   session's batch, and assert A's `completed` was freed. Today it survives
   because `:1009` skips the `Idle` phase.

## Investigation log

### Q: Is the retained result deliberately kept off-budget so that a replay is guaranteed to succeed?

- Sources examined: the two read sites (`:9446-9460`, `:8734-8748`), the two
  store sites (`:9558-9568`, `:9106-9116`), and the four in-process caches in the
  same file, which all do charge their entries: `TransformSnapshotCache`
  (`:1906-2079`), `BoundaryTokenCache` (`:2222-2292`), `NativeAttachmentCache`
  (`:2573-2715`), and `ProjectionCache` (`:2792-2869`).
- Findings: a replay guard whose entry could be evicted under budget pressure
  would be weaker, so keeping it off the eviction path is defensible as a
  correctness choice. But being uncharged is not the same as being unevictable:
  the four caches in this file all charge their entries and evict by budget,
  which is the codebase's own idiom, and none of them is a correctness guard. The
  replay slot could be charged to a separate small budget and still never be
  evicted.
- Missing evidence: no comment states the intent at either store site.
- Conclusion: needs human input. Charging it, capping the number of retained
  results, or expiring it with the session are three different answers and the
  code implements none of them.

### Q: Does the seed replay guard compare all the fields it retains?

- Sources examined: `CompletedStateSyncSeed`'s fields (`:914-921`) and the
  comparison at `:8734-8748`.
- Findings: the retained struct carries `generation`, `expected_seq`, and
  `total`, but the guard filters on `seed_id` (`:8739`) and then compares only
  `final_digest` (`:8741`); the other three appear only in the mismatch error
  message (`:8747-8748`), not in the equivalence test. The page guard, by
  contrast, does compare `generation` as well as `final_digest` (`:9449-9451`).
  So the seed guard is the looser of the two despite retaining more.
- Missing evidence: whether the digest already covers generation transitively.
  `state_sync_seed_content_digest` (`:13516`-region) would have to be read to
  settle that, and replay equivalence is the sibling lens's territory.
- Conclusion: unresolved, needs the sibling 4c per-handler replay finding. Noted
  as an open question on the record rather than claimed as a defect here.
