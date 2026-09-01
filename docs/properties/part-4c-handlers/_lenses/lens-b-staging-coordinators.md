# Part 4c lens B: staging coordinator lifecycle and cross-step state

Attention focus: the lifecycle of the multi-request staging coordinators. What
state persists between steps, what happens when a step fails or is abandoned,
and what guarantees survive a restart. Per-handler atomicity and idempotency
belong to the sibling lens and are not restated here.

Provenance: `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`. The task named `HEAD` = `76cd6f41`; the
actual `HEAD` at read time is `b5dc778e` ("fix(shm): close lifecycle and
evidence gaps"). `git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is
empty, so `crates/mc-module/src/lib.rs` is byte-identical between the two and
every line reference below is valid at both commits. Method contract in
[../../METHOD.md](../../METHOD.md).

Scope is sub-part 4c as defined in
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md):
five ranges of `crates/mc-module/src/lib.rs`, about 7,857 production lines. All
line references were read back individually at `HEAD`. Corrections to the scope
map: none needed. Its region entries for the three coordinators
(`:892-1020`, `:1022-1320`, `:1322-1622`) and their impl start lines
(`:957`, `:1107`, `:1380`) are all correct.

## Coordinator table

Four coordinators live in scope. Three stage caller bytes across requests; the
fourth sequences store opening and is included because it is named a
coordinator and shares the abandonment question, but it stages no caller data.

| Coordinator | Steps | Durable writes per step | Terminal states | Advanced by |
| --- | --- | --- | --- | --- |
| `StateSyncSeedCoordinator` (`:939-1020`) | `Idle` -> `AwaitingSeed{generation, expected_seq}` (`:908`, armed at `:8869` or by an explicit reset) -> `Collecting(PendingStateSyncSeed)` accumulating `batches: Vec<ModuleStateSyncWire>` -> `Applying{seed_id, bytes}` (`:906-911`) | None until the terminal step. `Collecting` accumulates in process memory only. The single durable write is `apply_state_sync_wire` on the assembled seed at `:9086` | `Idle` after `release_phase`, plus an out-of-band `completed: Option<CompletedStateSyncSeed>` replay slot holding the full `PreparedOutput` (`:914-921`, set at `:9106-9116`) | The caller, one `state_sync` request per batch. `handle_state_sync_value` (`:8642-9125`) is the only advancer; nothing else drives it |
| `TransformPageCoordinator` (`:1067-1320`) | `Idle` -> `Collecting(PendingTransformPage)` accumulating `pages: Vec<Value>` -> `Applying{transform_id, bytes}` (`:1035-1039`) | None until the terminal step. The durable write is the whole unpaged transform, `handle_transform_unpaged_value` at `:9528-9536`, which commits cache state behind its own CAS | `Idle` after `release_phase` at `:9554`, plus a `completed: Option<CompletedTransformPage>` replay slot holding the full `PreparedOutput` (`:1042-1047`, set at `:9558-9568`) | The caller, one paged `transform` request per page. `handle_transform_page_value` (`:9335-9578`) is the only advancer |
| `StateImportCoordinator` (`:1340-1622`) | absent -> `Collecting(PendingStateImport)` accumulating `compartments: Vec<StoredCompartment>` -> `Applying{import_id, bytes}` (`:1334-1337`). There is no `Idle` variant; a map entry exists only while pending | None until the terminal step. `store.preflight_state_import` (`:5678`) reads durable dedup state on every batch. The single durable write is `store.commit_state_import` at `:5738-5743` | Entry removed, by `complete` (`:1415-1427`), `discard` (`:1388-1395`), or `evict_stale` (`:1397-1413`). No replay slot; replay protection is durable, via `StateImportPreflight::Duplicate` (`:5679`) | The caller, one `state_import` request per batch. `handle_state_import_value` (`:5591-5774`) is the only advancer |
| `StoreOpenCoordinator` (`:286-322`) | Not a staging machine. Coordinates waiters on a single store open with a lease-wait window and jittered backoff | None of its own; `run_store_open` (`:3543-3655`) performs the open | Waiters released; `StoreOpenWaiterGuard`'s `Drop` (`:324-332`) releases on unwind | `begin_store_open` / `run_store_open`. Out of this lens's focus beyond the guard contrast noted below |

Three structural facts fall straight out of the table and drive most of the
records.

1. **No step writes durable state except the last one.** All three staging
   machines accumulate in `Mutex<...>` fields on `McHandler` (`:2946`, `:2947`,
   `:2950`). Nothing about a partial coordination is persisted anywhere.
2. **The three coordinators do not agree on cleanup.** `StateImportCoordinator`
   removes its map entry on every exit path. `StateSyncSeedCoordinator` has both
   `discard_pending` (keeps the entry, sets `Idle`) and `evict` (removes it).
   `TransformPageCoordinator` has neither: its `discard` (`:1131-1144`) only sets
   `Idle`, and the impl contains no `remove` call at all.
3. **The two TTL reapers are self-driven.**
   `StateSyncSeedCoordinator::evict_stale_collectors` is called from exactly one
   place, `:8860`, inside the seed handler. `StateImportCoordinator::evict_stale`
   is called from exactly one place, `:1441`, at the top of its own `stage`.
   Neither runs on a timer. `TransformPageCoordinator` has no reaper of any kind.

## Observations

Abandonment and reaping.

- `lib.rs:1131-1144` — `TransformPageCoordinator::discard` replaces the phase
  with `Idle` and clears `completed`, then releases the phase's byte and count
  charge. It never removes the `sessions` map entry. A grep of the whole impl
  body (`:1107-1320`) finds no `remove`, so the map is append-only.
- `lib.rs:999-1002` — `StateSyncSeedCoordinator::evict` does remove the entry,
  and `unbind_route` uses it (`:4267`). `unbind_route` uses the weaker
  `discard_transform_pages_for_route` for pages (`:4268`) and
  `StateImportCoordinator::discard` for imports (`:4269`).
- `lib.rs:1388-1395` — `StateImportCoordinator::discard` removes the entry, so
  imports leave nothing behind.
- `lib.rs:1004-1018` — the seed reaper's filter matches only
  `StateSyncSeedPhase::Collecting` (`:1009`). `AwaitingSeed` and an `Idle` phase
  carrying a `completed` result are both skipped, so neither is ever reaped by
  TTL.
- `lib.rs:627` — `STATE_SYNC_SEED_COLLECTOR_TTL` is 10 minutes.
  `lib.rs:1357` / `STATE_IMPORT_STALE_AFTER` is 5 minutes. There is no
  transform-page equivalent; a search of the constant block (`:596-669`) finds
  no page TTL.
- `lib.rs:4256` — `unbind_route`'s teardown block runs only when the removed
  binding was the *last* route for that session (`last_session_route`,
  `:4242-4247`). A session with two bound routes releases nothing when one goes
  away.
- `lib.rs:11999-12001` — `route_gone` is the host's only teardown callback and
  it forwards to `unbind_route`, so route teardown is the sole non-error release
  path for an abandoned page collection.

Bounding.

- `lib.rs:942`, `:951`, `:975`, `:985` — `pending_seed_count` is declared,
  initialised to 0, and decremented in two places. It is **never incremented**
  and never compared against anything. The struct has no `max_pending` field
  (`:939-944`), unlike its two siblings (`:1072`, `:1345`).
- `lib.rs:1186-1190` — the transform-page pending gate is
  `pending_transform_count >= max_pending_transforms && !self.sessions.contains_key(session_id)`.
  Because entries are never removed, any session that has ever staged a page
  satisfies `contains_key` for the process lifetime and skips the gate.
- `lib.rs:1192-1194` — `stage` calls `entry(session_id.to_string()).or_default()`
  before validating anything, so even a request that immediately returns
  `AttemptMismatch` (`:1197-1199`) leaves a new map entry behind.
- `lib.rs:9542-9548` — the completion block does the same `entry(...).or_default()`.
- `lib.rs:625`, `:631`, `:632`, `:652`, `:653` — the caps:
  `STATE_SYNC_SEED_MAX_STAGED_BYTES` 32 MiB, `TRANSFORM_PAGE_MAX_STAGED_BYTES`
  128 MiB, `TRANSFORM_PAGE_MAX_PENDING` 64, `STATE_IMPORT_MAX_STAGED_BYTES`
  32 MiB, `STATE_IMPORT_MAX_PENDING` 64.
- `lib.rs:958-964` and `:1108-1114` — `phase_bytes` returns 0 for `Idle` and, in
  the seed case, for `AwaitingSeed`. A `completed` replay result is therefore
  charged to no budget, because it is only ever stored after `release_phase` has
  already run and the phase is `Idle`.

Restart.

- `lib.rs:3463-3467` and `:3761-3765` — both constructors build all three
  coordinators from `Default`. Nothing reads staged state from the store.
- `lib.rs:12095-12099` — `CompositeComponent::shutdown` (`:12048`) overwrites
  all three with fresh defaults, discarding every partial coordination and every
  `completed` replay slot.
- `lib.rs:9446-9460` — the transform-page replay guard reads the in-memory
  `completed` slot and returns the cached `PreparedOutput` on an exact
  `generation` plus `final_digest` match. This is the only cross-step replay
  guard on that path; there is no durable page-level dedup record.
- `lib.rs:5678-5687` — state import is the exception. Its replay guard is
  durable (`preflight_state_import` returning `Duplicate`), so it survives a
  restart when the earlier attempt actually committed.

Liveness and blocking.

- `lib.rs:1242-1254` — while a session's phase is `Applying`, every subsequent
  page for that session returns `TransformPageStageError::InProgress`, which the
  handler surfaces as `in_progress` (`:9501-9503`).
- `lib.rs:9528-9536` — the `Applying` phase is released only after this `await`
  returns, at `:9554`. There is no `Drop` guard on the phase. If the future is
  dropped at the await, or the inner handler panics, `:9541-9572` never runs and
  the phase stays `Applying`.
- `lib.rs:497-508` — the `TransformDispatchTicket` does carry a `Drop` guard for
  exactly this hazard on the health counters, with a comment at `:503-504`
  naming panic unwind. The staging phase gets no equivalent.
- `lib.rs:251`, `:387-397` — a stalled collector is *observable*: a
  `Collecting` phase's `queued_at_ms` feeds `oldest_queued_at_ms` (`:1153-1163`,
  mirrored to the atomic at `:3985-3994`) and `report` marks the component stale
  past `TRANSFORM_WEDGE_THRESHOLD_MS` = 120,000 ms. Nothing acts on that signal;
  it is reported, not remediated.
- `lib.rs:4003-4007` — `log_transform_page_discard` pushes into a
  `#[cfg(test)]` vector `transform_page_discard_logs`. That field is written at
  `:4003` and read nowhere in the file, so the test hook exists but no test
  consumes it.

Cross-session reachability of a discard.

- `lib.rs:5621-5627` — `handle_state_import_value` defines a `discard` closure
  over `parsed.session_id`, the caller-supplied value.
- `lib.rs:5629`, `:5636`, `:5640`, `:5646`, `:5656` — every one of those call
  sites precedes `resolve_binding` at `:5653`, and the `BindingError::Unbound`
  arm itself calls `discard` at `:5656` before returning `route_unbound`. The
  raw-session variant at `:5599-5603` runs even earlier, before the wire struct
  is parsed.
- `lib.rs:8654-8664` — the seed handler's structurally identical
  deserialisation-failure arm does the opposite: it resolves the binding first at
  `:8658` and discards only on success, keyed on `binding.session` (`:8659`).
  `lib.rs:8665` is the main resolution, before any staging, and the page path
  resolves at `:9347` before its thirteen discards. So the import handler is the
  only one of the three that keys a discard on the request body.

Part 3 analogue. Part 3's finding is
`part-3-store-core/catalog.md:999` — claim-mirror rows keyed by
`database_incarnation_id` where "old rows are never garbage-collected". The
analogue in 4c is present and is the transform-page coordinator: staged pages
have no reaper and its `sessions` map has no removal path at all. The two other
coordinators do have TTLs, which makes the page coordinator's absence look like
an omission rather than a design choice.

## Candidate properties

### stagelc-transform-page-session-map-has-no-removal-path

Type: safety
Reachability: default-production — paging is automatic in the shipped plugin.
`packages/plugin/src/hooks/magic-context/module-wire.ts:1097` returns a single
unpaged body only when `unpagedBytes <= MODULE_PAGE_MAX_BYTES`, which is
`512 * 1024` at `module-wire.ts:20`; larger bodies are split and stamped with
`transform_page_id` at `module-wire.ts:1131`. The Rust side dispatches on field
presence at `lib.rs:7985-7986`, with no config gate.
Status: active
Exercised: not yet — no test inspects `TransformPageCoordinator::sessions` map
cardinality, and the `transform_page_discard_logs` hook (`lib.rs:4003`) is
written but never read.
Guarantee: the number of entries retained in `TransformPageCoordinator::sessions`
is bounded by the number of sessions currently bound to a route, not by the
number of sessions ever seen.
Check: `always` — after `unbind_route` has run for a session, that session has
no entry in `transform_pages.sessions`. `always` because the map is a live
resident structure evaluated at every staging call; there is no optional path to
excuse with `always-or-unreached`.
Fault/timing angle: none required. The growth is monotone under ordinary
sequential traffic; no interleaving is needed.
Required faults and enabling state: none. Bind a route, send one paged transform
series or even one malformed page-zero, unbind the route, repeat with a fresh
session id.
Confidence: high — [evidence](../evidence/stagelc-transform-page-session-map-has-no-removal-path.md).
Verified that the impl block `lib.rs:1107-1320` contains no `remove` call, that
`discard` (`:1131-1144`) only replaces the phase, and that `unbind_route`
(`:4268`) routes to `discard_transform_pages_for_route` rather than an `evict`,
while the sibling seed coordinator does call `evict` (`:4267`).
Existing check: none.
Impact: unbounded resident growth keyed by session id in a long-lived daemon.
Each entry is small on its own, but it also permanently re-qualifies that
session to bypass the pending-count gate (see the next record).
Open questions:
- Is retaining the entry deliberate, so that a returning session keeps its
  `completed` replay slot across a route rebind? If so the map needs its own
  bound; if not, `discard` should evict. (needs human input)

### stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session

Type: safety
Reachability: default-production — same evidence as the record above; the gate
is on the only staging entry point for paged transforms.
Status: active
Exercised: not yet — no test drives 64 concurrent pending collections and then
adds a 65th from a previously seen session.
Guarantee: at most `TRANSFORM_PAGE_MAX_PENDING` transform-page collections are
pending across all sessions at any time.
Check: `always(pending_transform_count <= TRANSFORM_PAGE_MAX_PENDING)` evaluated
after every successful `stage`. `always` rather than `unreachable` because the
forbidden condition is a state of the counter, not a code location that must not
execute; METHOD.md's first coverage rule applies directly.
Fault/timing angle: the window is the lifetime of a `sessions` entry, which is
the process lifetime. No timing precision is needed.
Required faults and enabling state: 64 distinct sessions each holding a
`Collecting` phase, plus one further session that previously staged and was
discarded, so its entry survives while its phase is `Idle`.
Confidence: high — [evidence](../evidence/stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session.md).
Verified the gate text at `lib.rs:1186-1190`, that the `contains_key` conjunct
short-circuits the overflow return, and that `discard` leaves the key present.
Existing check: none.
Impact: the count cap stops being a cap once enough sessions have been seen.
The 128 MiB byte cap at `lib.rs:631` still holds, so this is a degradation of
defence in depth rather than an unbounded byte path, but the doc comment at
`lib.rs:1064-1065` claims "every sender contributes to the same bounded staging
budget", which is exactly the guarantee the conjunct weakens.
Open questions: None.

### stagelc-abandoned-page-collection-is-released-within-a-bounded-window

Type: liveness
Reachability: default-production — same paging evidence; abandonment needs only
a sender that stops mid-series, which the plugin's own retry path can produce
(`rust-mode-transform.test.ts:1718` observes a failed page id mid-series).
Status: active
Exercised: not yet — no test stops a page series and then asserts the staged
bytes were released without a route teardown.
Guarantee: when a sender stops mid-series and no further request touches the
session, the bytes and pending charge of its `Collecting` phase are released
within 15 minutes.
Check: `always` evaluated once at the end of an explicit bounded window — stage
pages 0 and 1 of a 3-page series, stop, poll `total_staged_bytes` every 30
seconds for 15 minutes, then assert it returned to its pre-series value. The
bound is 15 minutes because it strictly exceeds both sibling TTLs, 10 minutes at
`lib.rs:627` and 5 minutes at `lib.rs:1357`; any correct reaper on this
coordinator would have to fire inside it. Stating the bound in minutes rather
than "eventually" is required by METHOD.md's liveness rules.
Fault/timing angle: the window is the quiescent period after the last page. The
whole point is that the coordinator receives no further input during it.
Required faults and enabling state: a partial page series, then silence. The
route must stay bound, otherwise `route_gone` masks the property.
Confidence: high — [evidence](../evidence/stagelc-abandoned-page-collection-is-released-within-a-bounded-window.md).
Verified there is no TTL constant for pages in `lib.rs:596-669`, no
`evict_stale*` method in `lib.rs:1107-1320`, and that the only release paths are
the explicit `discard_transform_pages*` calls from route replace (`:3800`),
route teardown (`:4268`), the twelve error returns in
`handle_transform_page_value` (`:9352`-`:9439`), and assembly failure (`:9524`).
Existing check: none. The state-import analogue is covered by
`lib.rs:27013-27072 state_import_batch_gap_and_staleness_evict_partial_attempts`,
which reaches the staleness path only by setting `stale_after` to
`Duration::ZERO` by hand at `:27051-27055`, itself evidence that the reaper is
not self-firing.
Impact: staged pages of abandoned series accumulate against the shared 128 MiB
budget for the process lifetime. Enough of them and legitimate large transforms
start failing with `buffer_overflow` (`lib.rs:9497-9500`) on a daemon that never
restarts.
Open questions:
- Was the page coordinator intentionally left without a TTL on the theory that
  `route_gone` always arrives? Route teardown only releases on the last route
  for a session (`lib.rs:4256`), so a multi-route session does not get it.
  (needs human input)

### stagelc-seed-and-import-reapers-only-run-on-fresh-traffic

Type: liveness
Reachability: default-production for the seed reaper — the shipped plugin sends
paged seeds, `packages/plugin/src/hooks/magic-context/module-state-sync.ts:1173`
sets `seed_batch_index`, and the reaper call at `lib.rs:8860` is on the only
seed staging path. `explicit-config-only` for the import reaper, see the state
import record below.
Status: active
Exercised: partial — `lib.rs:27013-27072` exercises the import reaper, but only
by forcing `stale_after` to zero and then sending another import, which is the
self-driven path rather than an independent one.
Guarantee: a stale `Collecting` phase is released within its coordinator's TTL
regardless of whether further requests of that kind arrive.
Check: `always` evaluated at the end of a bounded window — stage a partial seed,
stop all `state_sync` traffic, wait `STATE_SYNC_SEED_COLLECTOR_TTL` plus a
60-second margin, then assert `total_staged_bytes` returned to baseline. The
bound is the coordinator's own TTL constant, which is the unit the code bounds.
Fault/timing angle: the window is the quiescent period after the last batch of
that request kind. Traffic of any *other* kind may continue; that is what
distinguishes a self-driven reaper from a timer.
Required faults and enabling state: one partial seed series, then no further
`state_sync` request for the whole window. Other request kinds may flow freely.
Confidence: high — [evidence](../evidence/stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md).
Verified `evict_stale_collectors` has exactly one call site, `lib.rs:8860`, and
`evict_stale` exactly one, `lib.rs:1441`, both inside the staging path they
clean. No `spawn_module_task` or interval drives either.
Impact: the two TTLs are honoured only under continuing load of the same kind. A
session that abandons a seed and then goes idle keeps its charge against the
32 MiB seed budget. The comment at `lib.rs:626` states the intent, "Release
partial state-sync seeds whose sender stopped before completing the page
sequence", and a sender that stopped is precisely the case in which no further
`state_sync` arrives to trigger the release.
Open questions: None.

### stagelc-seed-pending-count-is-never-incremented

Type: safety
Reachability: default-production — the field and its two decrements are on the
unconditional seed staging path; no config gates them.
Status: active
Exercised: not yet — no test reads `pending_seed_count`.
Guarantee: `StateSyncSeedCoordinator::pending_seed_count` equals the number of
sessions whose phase is not `Idle`.
Check: `always` — after every `set_phase`, `discard_pending`, `release_phase`,
and `evict`, the counter equals the count of non-`Idle` phases in `sessions`.
`always` because it is a representation invariant of a live structure, checkable
at every mutation.
Fault/timing angle: none. A single successful two-batch seed falsifies it.
Required faults and enabling state: none. Stage one non-final seed batch and
read the counter.
Confidence: high — [evidence](../evidence/stagelc-seed-pending-count-is-never-incremented.md).
Verified by enumerating all four occurrences of the identifier in the file:
declaration `:942`, initialiser `:951`, and `saturating_sub` at `:975` and
`:985`. There is no `+=` and no comparison. Both siblings do increment
(`:1209`, `:1589`) and both compare against a `max_pending` field (`:1186`,
`:1572`) that this struct does not have.
Existing check: none.
Impact: the counter is dead, so its two `saturating_sub` calls are no-ops and
the seed coordinator has no pending-count bound at all. Its only bound is the
32 MiB byte cap, and because `phase_bytes` returns 0 for `AwaitingSeed`
(`:962`), an `AwaitingSeed` phase is bounded by neither. The two sibling
coordinators both cap pending count at 64.
Open questions:
- Is the missing `max_pending_seeds` cap an oversight, or is the seed path
  considered bounded because only a bound route can arm a collector? A bound
  route still supplies its own session id, so the map is bounded by sessions,
  not by routes. (needs human input)

### stagelc-completed-replay-results-are-uncharged-and-unexpiring

Type: safety
Reachability: default-production — the store sites are on the success path of
both paged transforms (`lib.rs:9558-9568`) and paged seeds (`:9106-9116`), both
reachable with no config change per the paging evidence above.
Status: active
Exercised: not yet — no test asserts a `completed` slot is released, or that its
bytes appear in `total_staged_bytes`.
Guarantee: every retained `PreparedOutput` in a coordinator is either charged to
that coordinator's staged-byte budget or released within a bounded window.
Check: `always` — for each coordinator, the sum of retained `completed` result
bytes plus phase bytes is at most `max_staged_bytes`. `always` because it is a
budget invariant of a resident structure.
Fault/timing angle: none for the accounting claim. The expiry claim shares the
quiescent window of the abandonment records.
Required faults and enabling state: complete one paged transform and one paged
seed successfully, then read `total_staged_bytes` and compare against the size
of the retained results.
Confidence: high — [evidence](../evidence/stagelc-completed-replay-results-are-uncharged-and-unexpiring.md).
Verified the ordering: `release_phase` runs first (`:9554`, `:9101`), so the
phase is `Idle` when `completed` is assigned; `phase_bytes` returns 0 for `Idle`
(`:1112`, `:962`); and the seed reaper's filter matches only `Collecting`
(`:1009`), so an `Idle` phase holding a `completed` result is skipped. Only
`evict` (`:999`) and `TransformPageCoordinator::discard` (`:1133`) clear it.
Existing check: none.
Impact: one full transform response body is retained per session, off-budget,
for as long as the session's entry survives. Combined with the map having no
removal path, the retained set is bounded only by distinct session ids. A
transform response is the largest single payload this handler produces, so this
is the heaviest of the growth vectors in this lens.
Open questions:
- `CompletedStateSyncSeed` also retains `generation`, `expected_seq`, and
  `total` (`lib.rs:914-921`) which the equivalence test at `:8739-8741` does not
  use; they appear only in the mismatch error message (`:8747-8748`). The page
  guard does compare `generation` (`:9449-9451`). Is the seed replay guard meant
  to compare them too? Deferred to the sibling lens, which owns replay
  equivalence.

### stagelc-state-import-discard-runs-before-the-binding-check

Type: safety
Reachability: explicit-config-only — `state_import` is dispatched at
`lib.rs:12279`, but the only sender in the shipped tree is the developer script
`packages/plugin/scripts/drive-preseed.ts:48`. A repository-wide search for the
method name in `packages/` finds that one non-test occurrence, so no default
production path reaches this handler.
Status: active
Exercised: not yet — no test sends a `state_import` for one session on a channel
bound to another and then checks the first session's staged batches.
Guarantee: a request on channel A can only affect staged state belonging to the
session bound to channel A.
Check: `always` — for every `state_import` request, if
`resolve_binding(channel, session_id)` would fail, the staged state of
`session_id` is unchanged. `always` because it is an authorisation invariant
evaluated per request, and the forbidden outcome is a state change rather than a
code location.
Fault/timing angle: the window is one victim session holding a `Collecting`
phase while an unrelated channel issues a request naming it.
Required faults and enabling state: victim session staged mid-series on channel
A; attacker request on channel B (bound elsewhere, or unbound) carrying
`session_id` = victim and any field that fails an early validation, for example
`v` != 1.
Confidence: high — [evidence](../evidence/stagelc-state-import-discard-runs-before-the-binding-check.md).
Verified the closure at `lib.rs:5621-5627` captures `parsed.session_id`; that
its call sites at `:5629`, `:5636`, `:5640`, and `:5646` all precede
`resolve_binding` at `:5653`; that the `BindingError::Unbound` arm calls it at
`:5656`; and that the raw-session variant at `:5599-5603` runs before the wire
struct is even parsed. Confirmed the seed path (`:8665`) and page path
(`:9347`) resolve the binding first and so do not share the shape.
Existing check: none. `lib.rs:27077 state_import_structural_rejections_name_rules_and_leave_session_empty`
covers the structural rejections but only on a correctly bound channel.
Impact: cross-session destruction of staged state, and a cheap denial of a
victim's in-progress import. Blast radius is limited by the reachability class:
today only the preseed script sends this op. If `state_import` is ever promoted
to a production path the record's severity rises with it.
Open questions:
- Is the pre-binding discard deliberate, on the theory that a malformed request
  invalidates any series in flight? If so it should key off the resolved
  binding, which is available two statements later. (needs human input)

### stagelc-staged-state-does-not-survive-a-restart

Type: safety
Reachability: default-production — the constructors at `lib.rs:3463-3467` are
the only ones used by `McHandler::new`, and the shutdown reset at
`:12095-12099` is on the unconditional `CompositeComponent::shutdown` path.
Status: active
Exercised: not yet — no test restarts a handler with a staged coordination
present and then asserts the caller's redrive behaviour.
Guarantee: a fresh process reconstructs no partial coordination, so a caller
that was mid-series must restart at index or seq 0 and will be told so.
Check: `always` — after construction, all three coordinators have empty
`sessions` maps and zero `total_staged_bytes`, and the first post-restart
non-zero-index request is rejected. `always` because it is a post-construction
invariant plus a per-request rejection, both evaluable whenever reached.
Fault/timing angle: the window is a process boundary crossed while a
coordination is in `Collecting`.
Required faults and enabling state: process restart, graceful via `shutdown` or
abrupt, with at least one `Collecting` phase live at the time.
Confidence: high — [evidence](../evidence/stagelc-staged-state-does-not-survive-a-restart.md).
Verified all three coordinators are plain `Mutex<...>` handler fields
(`:2946-2950`) built from `Default` (`:3463-3467`, `:3761-3765`); that nothing
in scope reads staged state from `mc-store`; and that the rejections are in
place: pages require `page_index == 0` from `Idle` (`:1197-1199`), imports
require `batch_seq == 0` from absent (`:1566-1571`), and seeds arm
`AwaitingSeed` only for `batch_index == 0` (`:8869`).
Existing check: none in scope. The historian's durable-phase recovery tests
(`lib.rs:29822`, `:29827`, `:29832`) prove the *historian* reconstructs across a
restart, which makes the contrast worth stating: the staging coordinators
deliberately do not.
Impact: this is the intended design as far as the code shows, and the rejections
are fail-loud rather than silent. The consequence is that a large paged
transform interrupted by a restart is fully re-sent, and that the replay guard
protecting against double application is lost with it, which is the next record.
Open questions: None.

### stagelc-restart-drops-the-only-page-level-replay-guard

Type: safety
Reachability: default-production — the guard read at `lib.rs:9446-9460` and the
store at `:9558-9568` are both on the unconditional paged-transform path.
Status: active
Exercised: not yet — no test redrives a final page across a restart.
Guarantee: a final transform page that was applied once produces at most one
durable cache-state effect, however many times it is redriven, including across
a restart.
Check: `always` per identity, with attempted and acknowledged counted
separately per METHOD.md's effect-accounting rule. For one `(session,
transform_page_id, generation)` identity: the number of committed cache-state
transitions is at least the number of acknowledged final-page responses and at
most the number of attempted final-page deliveries. The per-identity count is
the primary oracle; the aggregate bounds are the cheap screen, because a
one-to-one contract lets aggregate over- and under-counts cancel.
Fault/timing angle: the window is between the durable commit inside
`handle_transform_unpaged_value` (`:9528-9536`) and the caller observing the
response. A restart inside that window loses the acknowledgement and the guard
at the same time.
Required faults and enabling state: a paged series whose final page commits;
response lost or restart before the caller records success; caller redrives the
final page against a fresh process.
Confidence: medium — [evidence](../evidence/stagelc-restart-drops-the-only-page-level-replay-guard.md).
Verified that the `completed` slot is the only page-level replay guard, that it
is in-memory, and that it is cleared by `shutdown` (`:12097`). What I did **not**
verify is whether the durable CAS inside `handle_transform_unpaged_value` makes
the second application a no-op; that method is `lib.rs:8007-8615` and its
atomicity is the sibling lens's territory. The record is therefore stated as an
obligation with an open question rather than as a defect. Also verified that
`completed` is stored only for `PreparedOutcome::Response` (`:9537-9540`), so an
errored or streamed final page leaves no guard even without a restart.
Existing check: none found for the cross-restart case.
Impact: if the terminal handler's own CAS does not reject the replay, a redriven
final page applies a second cache-state transition against a generation the
caller believes it already consumed. Confirming or refuting this needs the
sibling lens's finding on the CAS predicate.
Open questions:
- Does the cache-state CAS in `handle_transform_unpaged_value` reject a second
  application at the same `shadow_generation`? If yes this record downgrades to
  a redundancy note; if no it is a double-apply. Requires the sibling lens's
  result. (unresolved, needs the 4c per-handler atomicity finding)
- `PreparedOutcome::Streamed` stores no `completed` slot (`:9539`). Is a paged
  transform ever answered by a stream? If so the in-process replay guard is
  absent on that path too.

### stagelc-applying-phase-has-no-unwind-guard

Type: safety
Reachability: default-production — the await at `lib.rs:9528-9536` and the
release at `:9554` are on the unconditional final-page path.
Status: active
Exercised: not yet — no test panics or cancels inside the terminal transform and
then sends another page for the same session.
Guarantee: a session's phase is never left in `Applying` after the request that
set it has finished, however that request finished.
Check: `always(phase != Applying)` for every session with no in-flight request.
`always` on the state, not `unreachable` on a location, because the defect is a
retained phase value rather than an executed statement, per METHOD.md's first
coverage rule.
Fault/timing angle: the window is the `await` at `:9528-9536`. The phase is set
to `Applying` before it (`:1298-1304`) and released after it (`:9554`), so any
non-returning exit from the await strands the phase.
Required faults and enabling state: a panic inside `handle_transform_unpaged_value`,
or the dispatch future being dropped at that await, while a session is
`Applying`. Then a further page request for the same session, which should
succeed and instead returns `in_progress`.
Confidence: high — [evidence](../evidence/stagelc-applying-phase-has-no-unwind-guard.md).
Verified there is no `Drop` impl for `TransformPagePhase` or for
`TransformPageCoordinator`; that release is a plain statement at `:9554`
reachable only by normal return; that `Applying` yields `InProgress` for all
later pages (`:1242-1254`, surfaced at `:9501-9503`); and that the codebase's own
idiom for this hazard is a guard, since `TransformDispatchTicket` has a `Drop`
(`:497-508`) whose comment at `:503-504` names panic unwind explicitly, as do
`SnapshotLease` (`:1875-1881`), `WrapupSessionGuard` (`:3198-3220`), and
`StoreOpenWaiterGuard` (`:324-332`).
Existing check: none.
Impact: a wedged session. Every later paged transform for it fails
`in_progress`, its bytes stay charged to the shared 128 MiB budget, and the only
recovery is a route teardown or a process restart. The condition is visible in
health past 120,000 ms (`:251`, `:387-397`) but nothing acts on it.
Open questions:
- Is the dispatch future ever dropped at that await, or does the host always
  poll a request to completion? `handle` (`:11963-11996`) awaits inline, so the
  answer depends on `mc-host` cancellation behaviour, which is outside 4c.
  (unresolved, needs an `mc-host` dispatch-cancellation fact from Part 2a)

### stagelc-a-coordination-is-observed-mid-sequence

Type: reachability
Reachability: default-production — reaching it needs only a transform body over
`MODULE_PAGE_MAX_BYTES` (`module-wire.ts:20`, 512 KiB), which the plugin pages
automatically at `module-wire.ts:1097`.
Status: active
Exercised: not yet — the campaign does not yet assert that any coordination was
observed strictly between its first and last step.
Guarantee: at least once per campaign, a staging coordinator is observed in a
genuinely intermediate state, so the safety records above are not vacuous.
Check: `sometimes` — at least once, all of the following independent
preconditions hold simultaneously: (a) a `transform_page` response was received
with `"staged": true` and `next_expected_index` >= 1, (b) the same series'
`transform_page_total` is >= 3, so the observed index is strictly inside the
series, and (c) the coordinator's `total_staged_bytes` is greater than zero at
that moment. `sometimes` and not `reachable` because executing the `Ack` arm at
`lib.rs:9509-9513` is location coverage, whereas what matters here is the
operational state of a partially assembled coordination; METHOD.md's second
coverage rule makes that distinction the deciding one. Every conjunct is an
independent precondition that holds on a correct implementation; none of them
asserts a violation.
Fault/timing angle: none. This is the enabling state for the other records, not
a fault.
Required faults and enabling state: none. A three-page series with the observer
sampling after page 1.
Confidence: high — [evidence](../evidence/stagelc-a-coordination-is-observed-mid-sequence.md).
Verified the `Ack(next_index)` construction at `lib.rs:1313-1315`, the response
shape at `:9509-9513`, and that `next_index` starts at 1 (`:1232`) and
increments per accepted page (`:1290`).
Existing check: partial and indirect.
`packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts:1680-1686`
asserts on the set of `transform_page_id`s in captured bodies, which proves the
TypeScript sender pages. It does not observe the Rust coordinator's state.
Impact: without this marker every `always` record in this lens can pass on a
campaign that only ever sends single-page transforms, which is the vacuous-pass
mode METHOD.md warns about.
Open questions: None.

### stagelc-a-restart-is-observed-with-staged-state-present

Type: reachability
Reachability: default-production — both the shutdown reset (`lib.rs:12095-12099`)
and the paged path are unconditional.
Status: active
Exercised: not yet — no test constructs this combination.
Guarantee: at least once per campaign, a process boundary is crossed while a
coordination is genuinely mid-sequence, so the restart records are not vacuous.
Check: `sometimes` — at least once, all of the following independent
preconditions hold: (a) at least one coordinator had a non-empty `sessions` map
with a `Collecting` phase immediately before the boundary, (b) that phase's
staged item count is >= 1 and strictly less than its `total`, and (c) the
boundary was crossed, either `shutdown` returning or a fresh `McHandler`
observed with zero `total_staged_bytes`. `sometimes` for the same reason as the
previous record: the operational situation, not the line. The conjuncts are
preconditions on a correct system; the record does not assert that anything was
double-applied.
Fault/timing angle: the boundary itself is the timing point. Both the graceful
path through `shutdown` and an abrupt drop should be covered, because only the
graceful one executes the reset at `:12095-12099`.
Required faults and enabling state: a partial series, then a restart. No other
fault needed.
Confidence: high — [evidence](../evidence/stagelc-a-restart-is-observed-with-staged-state-present.md).
Verified the reset statements at `lib.rs:12095-12099` sit inside
`async fn shutdown` (`:12048`), and that construction (`:3463-3467`) produces
empty coordinators, so both sides of the boundary are observable.
Existing check: none. The nearest analogue is the historian's seeded-phase
recovery family (`lib.rs:29793-29832`), which crosses a restart with durable
phase state present; the staging coordinators have no equivalent test.
Impact: without this marker,
`stagelc-staged-state-does-not-survive-a-restart` and
`stagelc-restart-drops-the-only-page-level-replay-guard` can both pass on a
campaign that never restarts mid-series.
Open questions: None.

## Contract-vs-code leads

Each lead cites the doc side and the code side. None is resolved in favour of
the doc, per METHOD.md rule 3.

1. **"every sender contributes to the same bounded staging budget."** Doc:
   `lib.rs:1064-1065`, the `TransformPageCoordinator` header comment. Code: the
   pending-count half of that budget is skipped for any session already in the
   map, `lib.rs:1186-1190`, and the map has no removal path, `lib.rs:1131-1144`.
   The byte half does hold.
2. **"Release partial state-sync seeds whose sender stopped before completing
   the page sequence."** Doc: `lib.rs:626`, the comment on
   `STATE_SYNC_SEED_COLLECTOR_TTL`. Code: the release runs only inside
   `handle_state_sync_value` at `lib.rs:8860`, so it fires only when a further
   `state_sync` arrives. A sender that stopped is exactly the case that supplies
   no such request.
3. **`pending_seed_count` reads as an enforced bound and is not one.** Doc: the
   field name plus the symmetry with `pending_transform_count` and
   `pending_import_count`, which are both enforced at `lib.rs:1186` and `:1572`.
   Code: `lib.rs:942`, `:951`, `:975`, `:985` are the only occurrences; no
   increment, no comparison, and no `max_pending` field on the struct at
   `:939-944`.
4. **`discard` names a release that is partial for pages.** Doc: the comment at
   `lib.rs:1129-1130`, "Drop the live collection and report its staged page
   count. Completed and applying requests are still cleared". Code: `:1131-1144`
   clears the phase and the `completed` slot but retains the map entry, which is
   the thing that keeps re-qualifying the session past the pending gate. The
   sibling `StateSyncSeedCoordinator::evict` (`:999-1002`) shows the intended
   full form.
5. **Guard idiom applied everywhere except the staging phases.** Doc: the
   `TransformDispatchTicket::Drop` comment at `lib.rs:503-504` states the rule,
   that a panic must not leave the lane's accounting wrong, and `SnapshotLease`
   (`:1875-1881`), `WrapupSessionGuard` (`:3198-3220`), `DreamerRunGuard`
   (`:3063-3071`), and `StoreOpenWaiterGuard` (`:324-332`)
   all follow it. Code: the `Applying` phase is released by a plain statement at
   `:9554` with no guard, so it is the one piece of per-request accounting in
   this file that a panic or cancellation can strand.
6. **A wedge that is reported but not remediated.** Doc: the region is named
   "the transform wedge detector" in the scope map, and `report`
   (`lib.rs:372-445`) computes `queue_stale` from a stalled collector's
   `queued_at_ms`. Code: nothing consumes `queue_stale` to release the
   collector. The detector's output is a `HealthReport` field only.

## Open questions

Design decisions, for a human.

1. Should `TransformPageCoordinator` have a TTL reaper like its two siblings, or
   is route teardown considered sufficient? Teardown only fires on the last
   route for a session (`lib.rs:4256`), so a multi-route session never gets it.
   (needs human input)
2. Should the two existing TTL reapers be driven by a timer rather than by the
   staging path they clean? Both are currently self-driven only
   (`lib.rs:8860`, `:1441`). (needs human input)
3. Is `StateSyncSeedCoordinator` missing a `max_pending_seeds` cap on purpose?
   (needs human input)
4. Should `completed` replay results be charged to `max_staged_bytes`, given
   each is a full transform or state-sync response body? (needs human input)
5. Is the pre-binding discard in `handle_state_import_value` (`lib.rs:5621-5656`)
   intentional? (needs human input)

Facts still missing, not design decisions.

6. Whether the cache-state CAS inside `handle_transform_unpaged_value`
   (`lib.rs:8007-8615`) rejects a redriven final page at the same generation.
   Blocks the confidence upgrade on
   `stagelc-restart-drops-the-only-page-level-replay-guard`.
   (unresolved, needs the sibling 4c per-handler atomicity finding)
7. Whether `mc-host` can drop a dispatch future at an await, which decides
   whether the cancellation half of `stagelc-applying-phase-has-no-unwind-guard`
   is reachable or whether only the panic half is.
   (unresolved, needs an `mc-host` dispatch-cancellation fact, Part 2a territory)
8. Whether a paged transform is ever answered with `PreparedOutcome::Streamed`,
   which would leave the page path with no in-process replay guard even without
   a restart (`lib.rs:9537-9540`). (unresolved, needs the response-assembly
   finding from 4d)
