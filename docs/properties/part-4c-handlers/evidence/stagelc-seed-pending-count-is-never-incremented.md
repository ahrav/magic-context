# stagelc-seed-pending-count-is-never-incremented

## Discovery trigger

Building the bounding column of the coordinator table. Both
`TransformPageCoordinator` and `StateImportCoordinator` pair a
`pending_*_count` field with a `max_pending_*` field and compare them.
`StateSyncSeedCoordinator` has the counter but no maximum, so I enumerated every
occurrence of the counter to see what it was for.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

Every occurrence of `pending_seed_count` in the file, exhaustively:

- `:942` — declaration, `pending_seed_count: usize,` inside
  `struct StateSyncSeedCoordinator` (`:939-944`).
- `:951` — initialiser in `Default`, `pending_seed_count: 0,` (`:946-955`).
- `:975` — inside `discard_pending` (`:970-981`):
  `self.pending_seed_count = self.pending_seed_count.saturating_sub(1);`
- `:985` — inside `release_phase` (`:983-990`), the identical statement.

There is no fourth kind of use. No `+= 1`, no assignment, no comparison, no
read. The struct at `:939-944` has four fields: `sessions`,
`total_staged_bytes`, `pending_seed_count`, `max_staged_bytes`. There is no
`max_pending_seeds`.

Because the counter starts at 0 and is only ever `saturating_sub`-ed, it is
permanently 0, and both `saturating_sub` calls are no-ops. The two `is_pending`
guards that gate them (`:974`, `:984`) therefore protect nothing.

The two siblings, for contrast:

- `TransformPageCoordinator`: field `:1070`, initialiser `:1080`, maximum field
  `:1072` initialised from `TRANSFORM_PAGE_MAX_PENDING` (`:632`, value 64) at
  `:1082`, increment at `:1209`, decrement at `:1122`, enforcement at `:1186`,
  and a diagnostics read at `:7830`.
- `StateImportCoordinator`: field `:1343`, maximum `:1345` from
  `STATE_IMPORT_MAX_PENDING` (`:653`, value 64) at `:1356`, increment at
  `:1589`, decrements at `:1390`, `:1463`, `:1484`, `:1492`, `:1503`, `:1514`,
  `:1530`, and enforcement at `:1572`.

So the seed coordinator is the only one of the three whose pending count is
neither maintained nor enforced.

What this leaves as the seed coordinator's actual bounds:

- `:625` — `STATE_SYNC_SEED_MAX_STAGED_BYTES` = 32 MiB, held in
  `max_staged_bytes` (`:952`). This is enforced on the staging path.
- `:958-964` — `phase_bytes` returns `seed.bytes` for `Collecting` and `bytes`
  for `Applying`, but **0** for both `Idle` and `AwaitingSeed` (`:962`). An
  `AwaitingSeed` phase is therefore bounded by neither the count (dead) nor the
  bytes (zero-charged).
- `:908` — `AwaitingSeed { generation, expected_seq }` carries no payload, so its
  own footprint is small. The unbounded quantity is the number of `sessions`
  entries holding one, each with a `String` key.
- `:8869` — an `Idle` phase is promoted to `AwaitingSeed` automatically for
  `batch_index == 0`, so reaching this state needs no reset request.
- `:1004-1018` — `evict_stale_collectors` matches only `Collecting` (`:1009`), so
  an `AwaitingSeed` phase is never reaped by TTL either.

Reachability, both sides per METHOD.md rule 4:

- Config default: no leaf gates the seed path; the counter and its decrements are
  on the unconditional staging path.
- Shipped setup path: `packages/plugin/src/hooks/magic-context/module-state-sync.ts:1173`
  sends `seed_batch_index` on the normal state-sync payload, paged against
  `MODULE_PAGE_MAX_BYTES` at `module-state-sync.ts:1268` and `:1274`.
- Class: `default-production`.

## Failure scenario

Two distinct consequences, and it is worth keeping them apart because they have
different severities.

The narrow, certain one: the counter is dead, so any diagnostics or future gate
that reads it sees 0. Today nothing reads it, so there is no live wrong answer.
This is latent rather than active.

The broader one: the seed coordinator has no pending-count bound at all. A caller
that arms many collectors, each holding only a small first batch, is limited only
by 32 MiB of accumulated batch bytes and by nothing at all if its phases sit in
`AwaitingSeed`, which carries a zero byte charge. Sessions accumulate in the map
one `String` key and one `StateSyncSeedSession` each. Both siblings cap this at
64.

The mitigating fact, which must be stated so the record is not overclaimed: a
seed can only be staged on a bound route, because `handle_state_sync_value`
resolves the binding at `:8665` before any staging, and the session id must match
the binding (`:4319-4327` inside `state_sync_binding`). So the growth is bounded
by the number of distinct sessions the host binds over the process lifetime, not
by an arbitrary attacker-chosen key set. That is the same bound as the transform
page map and is still unbounded in a long-lived daemon, but it is not a
single-request amplification.

## Timing windows and dependencies

None. One non-final seed batch falsifies the representation invariant
immediately. No fault, no interleaving, no concurrency.

## What a test must construct

1. Build a handler with a store and bind route 1 to session A.
2. Send batch 0 of a two-batch seed. Assert the response reports it was staged.
3. Read `handler.state_sync_seeds.lock().unwrap().pending_seed_count` and assert
   it equals 1. Today it is 0.
4. Stronger form, as the representation invariant: after each of `set_phase`,
   `discard_pending`, `release_phase`, and `evict`, assert
   `pending_seed_count == sessions.values().filter(|s| !matches!(s.phase, Idle)).count()`.

The field is crate-visible, and the inline test module already reaches into a
coordinator's internals this way at `:27051-27055`, so no source change is
needed for the oracle.

## Investigation log

### Q: Is the counter dead code, or is it read somewhere outside this file?

- Sources examined: every occurrence of the identifier in
  `crates/mc-module/src/lib.rs`, which is where the struct is declared; the
  struct's visibility, which is private (`:939`, no `pub`); and the diagnostics
  reader that does exist for the page sibling at `:7830`.
- Findings: the type is private to the crate root module, so no other file can
  name the field. The four occurrences listed above are exhaustive. The page
  sibling's counter is surfaced in `memory_holder_metrics` at `:7830`; the seed
  counter is not surfaced anywhere, so not even a diagnostics consumer would
  notice it reading 0.
- Missing evidence: none.
- Conclusion: resolved with answer. It is dead as written.

### Q: Is the missing `max_pending_seeds` cap an oversight, or is the seed path considered bounded by route binding?

- Sources examined: `handle_state_sync_value`'s binding resolution (`:8665`),
  `state_sync_binding` (`:4319-4342`) including its session-mismatch check, the
  auto-arm at `:8869`, and the two sibling caps (`:1186`, `:1572`).
- Findings: route binding does bound the key space to sessions the host has
  bound, which is a real difference from an unauthenticated key. But the same
  argument applies verbatim to the page and import coordinators, which are also
  reached only through a resolved binding (`:9347`, `:5653`) and which are capped
  anyway. So the binding argument does not explain the asymmetry.
- Missing evidence: no comment or commit rationale in the tree.
- Conclusion: needs human input. Whether to add the cap or to delete the dead
  counter is a design decision; both are defensible and the code currently does
  neither.

### Q: Does the dead counter mask a second bug in `discard_pending` or `release_phase`?

- Sources examined: `discard_pending` (`:970-981`) and `release_phase`
  (`:983-990`) in full, plus `phase_bytes` (`:958-964`) and `is_pending`
  (`:966-968`).
- Findings: no. Both methods also adjust `total_staged_bytes`, at `:976-978` and
  `:986-988`, and that adjustment is correct and live. Only the count line is
  inert. So byte accounting on the seed coordinator is sound; it is specifically
  the count that is not.
- Missing evidence: none.
- Conclusion: resolved with answer. The defect is confined to the counter.
