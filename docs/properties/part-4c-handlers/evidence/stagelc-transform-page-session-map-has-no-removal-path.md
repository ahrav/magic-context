# stagelc-transform-page-session-map-has-no-removal-path

## Discovery trigger

Comparing the three staging coordinators' cleanup methods side by side. Part 3
recorded a sibling subsystem where staged rows persisted with no collector
(`part-3-store-core/catalog.md:999`, claim-mirror rows keyed by
`database_incarnation_id` that "are never garbage-collected"). Looking for the
analogue in 4c, the first thing that stood out was that
`StateImportCoordinator::discard` calls `self.sessions.remove` and
`StateSyncSeedCoordinator::evict` calls `self.sessions.remove`, but
`TransformPageCoordinator::discard` calls neither.

## Evidence trail

`crates/mc-module/src/lib.rs`, all lines read back individually at
`HEAD` = `b5dc778e`. `git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/`
is empty, so these references are also valid at the `76cd6f41` named in the
task.

- `:1067-1073` — `TransformPageCoordinator` fields:
  `sessions: HashMap<String, TransformPageSession>`, `total_staged_bytes`,
  `pending_transform_count`, `max_staged_bytes`, `max_pending_transforms`.
- `:1131-1144` — `discard`. It takes `self.sessions.get_mut(session_id)`, sets
  `session.completed = None` (`:1133`), replaces the phase with
  `TransformPagePhase::Idle` (`:1134`), computes the discarded page count, and
  calls `release_phase`. There is no `remove`.
- `:1146-1151` — `set_phase` uses `self.sessions.entry(...).or_default()`, so it
  inserts on a miss.
- `:1192-1194` — `stage` opens with
  `self.sessions.entry(session_id.to_string()).or_default()` and then
  `std::mem::replace`. The insert happens before any of the envelope checks in
  the `Idle` arm, so a request that returns `AttemptMismatch` at `:1197-1199`
  still leaves an entry.
- `:9542-9548` — the completion block in `handle_transform_page_value` does the
  same `entry(...).or_default()`.
- A scan of the whole impl body `:1107-1320` for `remove` returns nothing. The
  map has insert paths and no delete path.

Contrast with the two siblings:

- `:999-1002` — `StateSyncSeedCoordinator::evict` calls `discard_pending` and
  then `self.sessions.remove(session_id)`.
- `:1388-1395` — `StateImportCoordinator::discard` is built on
  `self.sessions.remove(session_id)`; the entry's existence *is* the pending
  state, which is why that struct has no `Idle` variant (`:1334-1337`).

Teardown wiring, which decides whether anything else removes the entry:

- `:4233-4298` — `unbind_route`. The release block at `:4256-4297` runs only
  when the removed binding was the last route for that session
  (`last_session_route`, computed at `:4242-4247`). Inside it, seeds get `evict`
  (`:4267`), imports get `discard` (`:4269`), and pages get
  `discard_transform_pages_for_route` (`:4268`), which is the phase-only form.
- `:3796-3804` — the route-replacement path in `bind_route` has the same shape:
  `evict` for seeds, `discard` for imports, `discard_transform_pages_for_route`
  for pages.
- `:11999-12001` — `route_gone` forwards to `unbind_route`, so this is the only
  host-driven teardown.
- `:12097` — `shutdown` replaces the whole coordinator with `Default`, which is
  the only thing that ever empties the map, and it ends the process's useful
  life.

Reachability check, both sides as METHOD.md rule 4 requires:

- Config default: no config leaf gates paging. The Rust dispatch is on field
  presence only, `:7985-7986` calling `has_transform_page_fields` (`:12326`).
- Shipped setup path: `packages/plugin/src/hooks/magic-context/module-wire.ts:1097`
  returns an unpaged single body only when
  `unpagedBytes <= MODULE_PAGE_MAX_BYTES`; that constant is `512 * 1024` at
  `module-wire.ts:20`. Anything larger is split and stamped with
  `transform_page_id` at `module-wire.ts:1131`. So the shipped plugin reaches
  `stage` with no operator action. Class: `default-production`.

## Failure scenario

A long-lived daemon serves many sessions over its lifetime. Each session that
sends at least one paged transform, or even one malformed page-zero, gains a
permanent `TransformPageCoordinator::sessions` entry. `route_gone` fires,
`unbind_route` runs, the phase goes to `Idle` and the bytes are released, but the
key stays. Resident memory grows with the count of sessions ever seen rather
than sessions currently bound.

The second-order effect is worse than the bytes. The pending-count gate at
`:1186-1190` is conditioned on `!self.sessions.contains_key(session_id)`, so
every retained key permanently exempts that session from the count cap. That is
recorded separately as
`stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session`.

## Timing windows and dependencies

None. The growth is monotone under ordinary sequential traffic and needs no
interleaving, no fault, and no concurrency. It depends only on the daemon not
restarting, which is the intended deployment shape for a `serve` process.

## What a test must construct

1. Build a handler with a store, as `handler_with_store` does at the many call
   sites in the inline test module.
2. Bind route 1 to session A. Send a two-page transform series, or just a single
   page with `transform_page_index` set to 1 so it returns `attempt_mismatch`.
3. Call `unbind_route` for route 1, or drive `route_gone`.
4. Assert `handler.transform_pages.lock().unwrap().sessions.contains_key("A")`
   is false. Today it is true.
5. Repeat for N distinct session ids and assert `sessions.len()` stays at the
   number of currently bound sessions rather than N.

The oracle is the map's cardinality, which the test module can read directly
because the field is crate-visible; `:27051-27055` already reaches into
`state_imports` the same way.

## Investigation log

### Q: Is retaining the entry deliberate, so a returning session keeps its `completed` replay slot across a rebind?

- Sources examined: `discard` and its doc comment (`:1129-1144`), the `completed`
  read path (`:9446-9460`), `evict` on the seed sibling (`:999-1002`), the two
  teardown call sites (`:3800`, `:4268`), and the doc comment on the coordinator
  itself (`:1064-1065`).
- Findings: `discard` sets `session.completed = None` at `:1133`, so the replay
  slot is cleared on exactly the paths that would keep the key. That removes the
  only benefit a retained key could offer, which argues the retention is not
  deliberate. The doc comment at `:1129-1130` describes the method as clearing
  completed and applying requests, and says nothing about retaining the session.
- Missing evidence: no commit message, comment, or test states an intent to
  retain. There is a `#[cfg(test)]` discard-log hook at `:2949` written at
  `:4003` and read nowhere, so not even the test surface documents expectations
  here.
- Conclusion: needs human input. The code reads as an omission relative to both
  siblings, but declaring it a defect rather than a deliberate asymmetry is a
  design call.
