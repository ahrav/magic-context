# Part 4c fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 through 4b: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window; crash-recovery needs a
real termination; rare implementation branches need deterministic injection to be
reachable at all; and coverage checks assert independent preconditions, never the
violation.

Provenance as in [existing-checks.md](existing-checks.md). `HEAD` is `e447c927`,
`crates/mc-module/src/lib.rs` is byte-identical to `76cd6f41` across that span so
every `lib.rs` line below holds at both commits, and the one CI step that matters
moved: `cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at
`76cd6f41` and `:172` at `HEAD`. Both are cited.

Four framing points specific to this part.

First, **the dominant obstacle is not a missing fault.** No CI job executes any
test in this scope: the 69 claim-bearing in-crate tests run nowhere, and so do the
three integration tests that drive the real handlers end-to-end through a real
`McHandler` (`direct_host.rs:67`, `direct_host.rs:149`, `host_adapter.rs:102`).
The availability column describes what a developer can construct locally. Nothing
in it is protected by automation.

Second, **this part is unusually cheap.** Its scope is a set of request handlers,
so the primary input is a request body and the primary "fault" is sending the same
request twice. Eleven of the 25 records need no fault of any kind, only ordinary
state and a second call. Three of them are among the sharpest findings in the
sub-part.

Third, **the claim that exactly one capability is missing was wrong, and this
revision withdraws it.** An earlier version of this file said there is no
store-side write-failure injector, and blocked three records plus the main half of
a fourth on that absence. The enumeration behind that claim mislabelled one seam.
`execute_tag_sql_for_test` (`crates/mc-store/src/lib.rs:6431-6440`) was described
as "narrow"; it is not. Its body is
`self.inner.with_conn(|conn| { conn.execute_batch(sql)?; Ok(()) })`, so it runs an
**arbitrary SQL batch** against the store's own connection, including `CREATE
TRIGGER`. It is gated `#[cfg(any(test, feature = "test-support"))]` (`:6433`) and
`mc-module` already enables that feature for its tests
(`crates/mc-module/Cargo.toml:66` `[dev-dependencies]`, `:71`
`mc-store = { workspace = true, features = ["test-support"] }`), and already calls
it twice, at `lib.rs:23768` and `:23795`. So the seam is present, enabled, and in
use.

That makes an aborting trigger a general write-failure injector for any table, and
all four of the writes previously called unreachable are ordinary table writes:

- `bind_authority_route` upserts `mc_authority_route_bindings`
  (`mc-store:5124-5132`).
- `record_recomp_command` inserts `mc_recomp_commands` (`:6816-6822`).
- `record_dream_task_command` inserts `mc_dream_task_commands` (`:6945-6951`).
- `commit_state_import` inserts `mc_state_imports` (`:7180-7190`).

Three mechanical facts were checked before withdrawing the claim, because each
could have invalidated the route. First, `RAISE(ABORT, ...)` in a `BEFORE INSERT`
trigger does abort an `INSERT OR IGNORE`, which is the statement form used by the
recomp and dream writes; verified directly against SQLite, along with the
`ON CONFLICT ... DO UPDATE` form the route-binding upsert uses. The outer
statement's conflict-resolution clause does not swallow it. Second,
`bind_authority_route` writes through `with_note_conn_fenced` (`:5323-5343`), which
looked like it might address a different database; it does not, it delegates to the
same `self.inner.with_conn_fenced` and only sets a caller-project scope around the
closure, so a trigger installed through the seam is in the same schema and applies.
Third, `execute_tag_sql_for_test` uses the unfenced `with_conn`, which is fine for
installing a trigger because a trigger is schema state, not a fenced write.

Two honest limits remain. The seam is named for tag SQL and its doc comment
(`:6431-6432`) describes tag-cache invalidation, so using it as a general fault
injector is off-label; a named failpoint per call site would be clearer and is
still worth having. And targeting the *second* of two calls to the same function
inside one request needs care: `record_recomp_command` is called at `lib.rs:6060`
and `:6114`, so a blanket trigger on `mc_recomp_commands` fails whichever runs
first. In that specific case the two calls are on mutually exclusive branches, the
`nothing_to_do` early return at `:6060-6074` versus the reset path, so a blanket
trigger is sufficient; where that is not true, a `WHEN` clause on row content or
installing the trigger mid-request closes it.

Fourth, **two test-only seams already exist in this file and no test uses either.**
`state_sync_before_apply_hook` (field `:2925`, fired `:9234`) runs arbitrary code
between the cheap historian read and the fenced state-sync transaction. Note what
that does and does not buy, because an earlier revision of this file over-claimed
it: it fires *before* the commit at `:9241`, so it can interleave a competing writer
ahead of the fence, and it cannot separate that commit from the in-memory
capability set at `:9288-9291`, which is the window
`h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together` is
about. A symmetric post-commit hook does not exist and is item 11 in the leverage
ranking. `state_sync_seed_now` (field `:2921`, read at `:8617-8626`) is an
injectable `Instant` for the seed coordinator, so the seed reaper's 10-minute TTL
window can be crossed in microseconds instead of waiting. Zero occurrences of
either identifier appear in the test modules. Both are free capability.

One correction to the framing supplied to this synthesis, made per METHOD.md
rule 1, and it applies to the leverage ranking below as well as here.
"Exhausting two compare-and-swap attempts is a seeded-state unit test" is true of
the arm that makes the silent success observable and **not** of the loop, and the
two must not be described with the same verb. In
`guidance_date_for_session` (`:7725-7763`) the `for _ in 0..2` loop (`:7730`)
reloads `store.load` at `:7731` on every iteration and commits at `:7751`, so a
`CasConflict` requires a writer landing between those two lines, twice, and this
function has no hook. Exhausting the loop therefore needs **contention**, not
seeded state, and cannot be produced deterministically today. The **other**
silent-success return is the one that is free: `:7746-7748` returns
`Ok(date_line)` whenever `loaded.row_version` is `None`, and
`mc-store/src/lib.rs:5500-5505` returns `row_version: None` for any session with
no row, which the store's own test `bootstrap_load_returns_uninitialized_defaults`
(`:14030-14037`) confirms. So the cheapest oracle for that record is cheaper than
claimed, needing a session that was never committed and no setup at all, while the
loop-exhaustion half needs contention. Both halves are credited separately below,
and the leverage ranking says "the no-row arm" rather than "exhausting the path"
for the same reason. Note also that the no-row arm is not merely cheap but
**already driven**: `lib.rs:22991-23008`, inside
`guidance_get_freezes_hashes_and_advances_only_on_busting_commit` (`:22935`),
dispatches `guidance.get` against a session it never commits and asserts
`row_version.is_none()` afterwards.

## Fault classes required

`H0` is listed first because it is the cheapest capability in this part and it is
not a fault at all. `H1` and `H2` are split because their records differ and the
second is the sharper one, even though their cost is identical.

| Class | Description | Available today |
| --- | --- | --- |
| H0 test execution in CI | Any workflow job that builds and runs `mc-module --lib`, or that runs the `direct_host` or `host_adapter` integration binaries | **No.** Verified across all five files in `.github/workflows/`. The only `mc-module` test invocation is `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`), which selects one integration binary and does not build `--lib`. The step above it is build-only. There is no `--lib`, no `nextest -p mc-module`, and no `--workspace` test job. `scripts/test-rust.sh` (`cargo nextest run --workspace`) is wired into root `package.json` and no workflow calls it. `MC_E2E_MODE: ts` (`ci.yml:714`) keeps Rust out of the host e2e lanes deliberately, stated at `ci.yml:719-721`. This costs a workflow change and no new infrastructure |
| H1 repeat delivery with a caller identity | The same logical request delivered twice carrying the same `command_id`, `import_id`, `transform_page_id`, or `expected_shadow_seq`, so the handler's own dedup path is exercised | **Yes, and it needs no fault.** Two sequential calls. `management_binding` (`:5892-5933`) requires only `v` and a `session_id` plus a matching binding, and the identities are plain request fields: `command_id` capped 1..=128 bytes for recomp (`:6008`) and 1..=256 for dreamer (`:9626-9631`), `import_id` capped 1..=128 (`:5639`, const `:651`). `:27182` already sends an identical `todo_state.set` twice, so the pattern is established in the suite |
| H2 repeat delivery with **no** caller identity | The same logical request delivered twice where the handler reads no identity field at all, so nothing distinguishes the second delivery from the first | **Yes, and it is the cheapest oracle in the part.** Two sequential calls and no fault. `session.delete` (`:6126-6161`) is keyed only by `(session_id, project_root)`, both derived from the route binding, and returns `deleted_rows` (`:6154`), a row count that differs between a first delivery and a repeat. `session.flush` (`:5986`) and `todo_state.set` (`:5965`) share the missing-identity shape but are content- or state-keyed; `session.delete` is destructive |
| H3 a fault between the first and second transaction of a multi-transaction handler | An injected store error, or a process termination, landing on the second durable call only, after the first has already committed | **Yes, through an aborting trigger, and an earlier revision of this row was wrong to say no.** The three pairings are `session.recomp` (`:6077` reset, then `:6114` `record_recomp_command`), `authority.prepare` (`:7187-7239` transition, then `:7250` `bind_authority_route` committing at `:4420`), and `state_import` (`:5738` `commit_state_import`, whose staging is cleared at `:5744-5747` *before* the outcome is matched at `:5748`). The dreamer's `:9989` `record_dream_task_command` has the same requirement. All four writes go to ordinary tables (`mc-store:6816-6822`, `:5124-5132`, `:7180-7190`, `:6945-6951`), and `execute_tag_sql_for_test` (`mc-store:6431-6440`) runs an arbitrary SQL batch and is enabled for `mc-module`'s tests (`crates/mc-module/Cargo.toml:66-72`), so a `BEFORE INSERT` trigger with `RAISE(ABORT, ...)` fails a chosen write on demand. See framing point three for the three mechanical facts checked before accepting this: `RAISE(ABORT)` survives `INSERT OR IGNORE` and `ON CONFLICT DO UPDATE`, `with_note_conn_fenced` is the same database, and a trigger is schema state so installing it unfenced is fine. The remaining gap is precision rather than capability: a blanket trigger cannot pick the second of two calls to the same function, which matters only for recomp, where the two calls are on mutually exclusive branches so a blanket trigger suffices. Process termination mid-request is still unavailable: no test in scope terminates a process inside a request, and `direct_host.rs:149` restarts a fixture host **between** requests. The `let _` at `:9989` remains worse than the others, because the write's own failure is unobservable to the handler even now that it can be induced |
| H4a silent success from an uncommitted session | A `guidance.get` against a session whose row does not exist, so `loaded.row_version` is `None` and `:7746-7748` returns `Ok` before reaching the commit | **Yes, with zero setup, and already exercised.** Verified end to end: `mc-store/src/lib.rs:5500-5505` returns `row_version: None` when no row exists, confirmed by that crate's own `bootstrap_load_returns_uninitialized_defaults` (`:14030-14037`). The response at `:7704-7722` has no persistence field among its twelve keys, and the only `Err` return in the function is `:7754`, so the fall-through cannot surface as an error. `lib.rs:22991-23008` already drives this arm through the handler and asserts `store.load("other").unwrap().row_version.is_none()` at `:23008`, so the class is not merely available but consumed |
| H4b compare-and-swap exhaustion across a retry budget | Two consecutive `CasConflict` returns from `store.commit`, so the `for _ in 0..2` loop (`:7730`) falls through to `:7757-7763` | **No, not deterministically, and note that this is contention rather than seeded state.** The loop reloads at `:7731` each iteration, so a conflicting writer must land between `:7731` and `:7751` twice, and `guidance_date_for_session` has no hook. A concurrent-committer thread makes it probabilistic, not deterministic. The one nearby seam, `state_sync_before_apply_hook` (`:9234`), is on a different handler. Note that H4a already makes the record non-vacuous, so this class blocks a second window rather than a record |
| H5 process restart with staged state present | A process boundary crossed while at least one coordinator holds a `Collecting` phase | **Yes, in two forms with different costs.** The graceful form is in-process and cheap: `CompositeComponent::shutdown` (`:12048`) overwrites all three coordinators with fresh defaults at `:12095-12099`, and construction (`:3463-3467`, `:3761-3765`) builds them from `Default`, so both sides of the boundary are readable from one test. The abrupt form needs a real process, and `direct_host.rs:149` `direct_primary_replays_transform_state_across_fixture_restart` already proves the fixture host can be restarted with transform state present, so this is wiring rather than new infrastructure. Only the graceful path executes the reset, which matters for the marker design below |
| H6 abandonment with no further traffic | A partial series, then silence, with no further request **of that kind** for the coordinator's whole TTL window | **Yes, and cheaper than it looks, unevenly across the three coordinators.** For seeds, `state_sync_seed_now` (`:2921`, read `:8617-8626`) is a `#[cfg(test)]` injectable `Instant` that no test sets, so a 10-minute `STATE_SYNC_SEED_COLLECTOR_TTL` (`:627`) window is crossed by assignment. For imports, `StateImportCoordinator::stale_after` (`:1346`, from `STATE_IMPORT_STALE_AFTER`, declaration `:654`, wiring `:1357`, compared `:1403`) is settable, which is how `:27013` reaches the staleness path by forcing `Duration::ZERO` at `:27055`. For pages there is neither, because there is no TTL to shorten: `TransformPageCoordinator` takes `queued_at_ms` as a parameter (`:1184`, stored `:1236`) and uses it only for `oldest_queued_at_ms` (`:1153-1163`), never for a TTL comparison. Staleness is therefore *expressible* for pages and nothing reaps on it |
| H7 caller-driven unbounded staged growth | Enough distinct sessions, or enough repeat traffic from one session, to drive a coordinator's map or byte total past a declared bound | **Yes, and it needs no fault.** The gate is one boolean: `pending_transform_count >= max_pending_transforms && !self.sessions.contains_key(session_id)` (`:1186-1190`), and `discard` (`:1131-1144`) leaves the key present because the whole impl `:1107-1320` contains no `remove`. `stage` also calls `entry(session_id).or_default()` at `:1192-1194` before validating anything, so even a request that returns `AttemptMismatch` at `:1197-1199` leaves an entry. Reading the result is already established: `:18730` fabricates a `Collecting` phase and a `CompletedTransformPage` and reads `transform_pages` back, so coordinator internals are directly inspectable from a test |
| H8 an unwind during an applying phase | A panic, or a dropped future, at the terminal `await` while a session's phase is `Applying` | **Partial, and the two halves differ.** The consequence is cheap to construct: a test can set the phase to `Applying` by hand, exactly as `:18730` fabricates a `Collecting` phase, and then assert that later pages return `in_progress` (`:1242-1254`, surfaced at `:9501-9503`). Reaching it by a *real* unwind is not available. There is no injectable panic in `handle_transform_unpaged_value`, and the file's only production panic is `:3661` on a store-open `JoinError`, a different path. The cancellation half is unresolved rather than unavailable: `handle` (`:11963-11996`) awaits inline, so whether `mc-host` can drop a dispatch future is Part 2a's fact. The structural side is fully verified: ten `impl Drop` blocks exist in this file (`:328`, `:497`, `:1875`, `:3063`, `:3083`, `:3097`, `:3121`, `:3174`, `:3210`, `:11919`) and none covers a staging phase, which is released by a plain statement at `:9554` |

Two availability caveats that cut across classes. `state_import` is
`explicit-config-only`: it is dispatched at `:12279`, but the only sender in the
shipped tree is the developer script
`packages/plugin/scripts/drive-preseed.ts:48`, so its two records are constructible
in a test while their production blast radius is currently bounded by that. Paging,
by contrast, is `default-production` with no config gate:
`module-wire.ts:20` sets `MODULE_PAGE_MAX_BYTES = 512 * 1024`, `:1097` returns an
unpaged body only below it, `:1131` stamps `transform_page_id` above it, and the
Rust side dispatches on field presence at `:7985-7986`.

## Map

All 25 records: eleven from lens A (durable operation handlers, atomicity and
idempotency) and fourteen from lens B (staging coordinator lifecycle). The counts
have moved this revision: lens A's structural claim that no handler in scope uses
the claim intent ledger is now an architectural note in the catalog prose rather
than a record, so its row is gone from this map; lens B's combined seed-and-import
reaper record is split in two because its two halves have different reachability
classes, and its restart marker is split in two because the graceful and abrupt
boundaries execute different code. "Non-vacuous today" means a developer can
construct the required state with the current harness. It does **not** mean the
check runs anywhere; under H0 none of them do.

One reachability precondition is stated once rather than per row. Every handler
cited is reached from `CompositeComponent::handle` (`:11963`) through
`dispatch_value_with_inbound_bytes` (`:11994`), whose method match begins at
`:12250` and carries no `#[cfg]` attribute, unlike the `dispatch_value` test
wrapper directly above it at `:12228-12232`. No handler in scope sits behind
`#[cfg(feature = ...)]`.

### Handlers: multi-transaction ordering and unchecked writes

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| h4c-recomp-reset-precedes-its-ledger-row | A session with `has_compartments` true or a nonempty `boundary_id`, so `never_minted` is false at `:6058-6059` and the early `nothing_to_do` return at `:6060-6074` is not taken. Then a fault on the second `record_recomp_command` at `:6114` **only**, not the first at `:6060` (H3) | **Yes, revised from No.** A `BEFORE INSERT` trigger with `RAISE(ABORT, ...)` on `mc_recomp_commands` (`mc-store:6816-6822`), installed via `execute_tag_sql_for_test`, fails that write; `RAISE(ABORT)` is not swallowed by the statement's `INSERT OR IGNORE`. Precision is free here rather than difficult: the two call sites are on mutually exclusive branches, `nothing_to_do` at `:6060` versus the reset path, so a blanket trigger on the table hits only the call the record targets on a reset-path request. The recomp latch from `try_claim_recomp_session` (`:6030`) releases on the way out because `_guard` drops, so the retry is admitted and the second reset commits against a freshly loaded `row_version` |
| h4c-authority-prepare-route-bind-is-a-second-transaction | An `authority.prepare` whose transition result row has `state == "MODULE"`, so the `if` at `:7248` is entered, then a store fault on `bind_authority_route`'s durable call at `:4420` only (H3). The fault must be on the store call, not the binding lookup: `facade_binding(channel)` failing returns `Ok(())` without writing at `:4417-4419` | **Yes, revised from No.** A `BEFORE INSERT` trigger with `RAISE(ABORT, ...)` on `mc_authority_route_bindings` (`mc-store:5124-5132`) fails exactly that call and nothing else in the request, since the transition arms write other tables. Two facts were checked: `RAISE(ABORT)` fires under `ON CONFLICT ... DO UPDATE`, which is this statement's form, and `with_note_conn_fenced` (`mc-store:5323-5343`) delegates to the same `inner.with_conn_fenced` rather than a separate database, so a trigger installed through the tag-SQL seam does apply. Note the near-miss the record already names: the `Ok(())` skip arm is reachable by sending prepare on an unbound administrative channel, but that arm is the documented one (`:4407-4409`) and does not produce the split state |
| h4c-state-import-commit-clears-staging-on-every-outcome | An empty session so the preflight returns `Ready` at `:5687`, a multi-batch import so `batch_count > 1`, all batches staged so `stage` returns `Apply` at `:5734`, then a store fault on `commit_state_import` at `:5738` producing `Err(StateImportError::Store(_))` (H3) | **Yes, revised from No.** A `BEFORE INSERT` trigger with `RAISE(ABORT, ...)` on `mc_state_imports` (`mc-store:7180-7190`, inside the import transaction) makes the commit return the `Store` error arm this record needs. The ordering was always verifiable by reading, since `complete()` at `:5744-5747` is unconditional and precedes the `match outcome` at `:5748`; what was missing and is now available is the failing outcome itself. `:26941` reaches a *refused* commit, which is a different arm taken before the write. Reachability class is `explicit-config-only`, corrected this revision to match its two siblings on the same handler |
| h4c-dreamer-failure-path-ledger-write-is-unchecked | For the main window, a classify run that exhausts its models so `output.is_none()` at `:9983`, plus a store fault on `record_dream_task_command` at `:9989` (H3). The authority gate at `:9684-9698` must pass first. For the duplicate-guard half, two **concurrent** deliveries so the in-flight guard at `:9796-9810` returns `dreamer_run_failed` at `:9803` | **Yes, revised from Partial.** All three halves are now constructible. The model-exhaustion state is already reachable: the fixture at `:25806-25810` poisons the route model chain to prove the classify loop ignores it. The unchecked write is inducible by an aborting trigger on `mc_dream_task_commands` (`mc-store:6945-6951`); `RAISE(ABORT)` is not swallowed by the `INSERT OR IGNORE`. The code collision is observable from the three `dreamer_run_failed` sites at `:9804`, `:9968` and `:9996`, in two of which no ledger row exists **by design**, so a caller cannot tell whether one does. One correction to the earlier row, which called the duplicate-guard half "pure H1": it is not, and two sequential calls cannot reach it. `inflight_dream_commands` is inserted at `:9802` and `DreamCommandGuard` (`:9811-9814`) removes the key on return, so a second delivery that begins after the first returns never sees the key. That half needs two overlapping in-flight calls |
| h4c-transform-writes-two-side-effects-before-its-fenced-commit | `serializer_profile == OpencodeAiSdk` and a request carrying a mural so `host_mural_artifact` returns `Some` at `:8209` and `upsert_project_mural_artifact` commits at `:8210-8215`. Then any `TransformError` from `run_transform`, reaching `reject_transform` at `:8330-8337` from `:8338-8340`. Optionally a due side-channel row so the drain at `:8252` has work | **Yes.** No injected fault: the pass engine's own rejections are reachable from a crafted request, and `transform_failed` has exactly one site (`:8334`), so the rejection is unambiguous to observe. The mural is content-keyed by `content_hash` (`:8213`), so the double-apply is benign; the durable consequence is that a rejected pass's artifact becomes the project's inherited mural via `cc_mural_input` (`:8224`) |
| h4c-side-channel-drain-result-is-discarded-by-the-caller | A due historian side-channel row plus a delivery failure, so the store's per-row counters at `mc-store/src/lib.rs:9572-9581` report `failed > 0` while `:8252` binds the whole result to `let _` | **Yes, and the seam already exists and is already used.** `fail_next_historian_side_channel_for_test` (`mc-store/src/lib.rs:5249`) is called at `lib.rs:30041` by `status_diagnostics_surface_pending_historian_side_channel_failure` (`:30037`). That test proves the operator surface works, which bounds this record to a per-pass observability gap rather than silent loss |

### Handlers: repeat delivery and identity

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| h4c-session-delete-has-no-caller-supplied-operation-identity | A populated session, one successful delete committing at `:6140`, then a second delivery of the same request (H2). No fault, no dropped response needed for the oracle: the second call is the observation | **Yes, and this is the cheapest oracle in the part.** Two sequential calls. `deleted_rows` (`:6154`) is a row count, so the first returns a positive number and the repeat returns zero, both as `ok: true`. Nothing documents `deleted_rows == 0` as a duplicate marker and it collides with deleting an already-empty session |
| h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write | Two identical `todo_state.set` requests (H1 by content key). The store distinguishes `Updated { row_version }` from `Noop` (`mc-store/src/lib.rs:2738-2741`, predicate `:6737-6740`) and `:5966-5968` collapses both into `{"ok": true}` | **Yes, and it is already exercised.** `:27182` sends the identical request twice, asserts `{"ok": true}` both times (`:27192-27195`, `:27203-27206`), and asserts `row_version` unchanged at `:27208`. **Record this explicitly: the existing test locks in the shape this record questions**, so a fix requires updating that assertion |
| h4c-guidance-date-returns-success-without-persisting | For the first window, a session with no store row so `loaded.row_version` is `None` at `:7746` (H4a). For the second, two consecutive `CasConflict` returns from `store.commit` at `:7751` so the loop at `:7730` falls through to `:7757-7763` (H4b) | **Yes, via H4a, and that half is already driven.** `lib.rs:22991-23008` dispatches `guidance.get` against a never-committed session and asserts `row_version.is_none()` at `:23008`, which is the store-side oracle this record asks for; what it does not assert is that the response disclosed the non-persistence, so the record's second clause is still open. The loop-exhaustion arm is blocked on H4b and needs contention, not seeded state. The in-process memo at `:7739-7745` hides the divergence until a restart loses it, so any new marker should read the store rather than a second response |
| h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together | A `state_sync` with `note_evaluation_available: true` that commits at `:9241`, then a process kill or panic strictly between that commit and `set_note_evaluation_capability` (`:9288-9291`), then a redelivery. On redelivery `expected_shadow_seq` has advanced, so the store returns `AuthoritySeqMismatch` handled at `:9316-9318` and the `Ok` arm holding the capability call is never re-entered | **Partial, revised from Yes.** The earlier row claimed two sequential calls plus the existing `state_sync_before_apply_hook` (`:2925`, fired `:9234`) suffice. They do not, and the record's workload is corrected accordingly. The hook fires **before** the commit, so code it runs precedes both effects and cannot split them. And the two effects are synchronous with nothing fallible or suspending between `:9241` returning `Ok`, `:9288-9291` setting the flag, and `respond` at `:9292`, so a lost response plus a retry cannot split them either: the first delivery already set the flag in this process. What is constructible today is the fenced rejection on the retry, which is worth witnessing on its own. What is missing is a **post-commit** hook, symmetric with the pre-apply one. Also still unresolved is whether a later `state_sync` re-sends the field and self-heals the flag, which needs the TypeScript sender |
| h4c-authority-drain-finish-compares-two-caller-supplied-checksums | An authority in `DRAINING` at the caller's expected generation with all drain steps recorded, then a `finish` request carrying `verified: true` and omitting both checksum fields, so `:7371-7382` defaults them to `""` and the store's guard `if !all_steps \|\| !verified \|\| checksum_expected != checksum_actual` (`mc-store/src/lib.rs:11911`) passes on `"" == ""` | **Yes.** Request shaping plus seeded authority state. No fault. The weaker sibling is equally free: `authority.drain.begin` defaults `lease` to `""` and `lease_expires_at` to `0` at `:7336-7340` with no second predicate failing closed. Contrast `authority.prepare` `complete`, which computes the actual side itself via `store.authority_seed_checksum` at `:7197-7206`; that asymmetry is the strongest part of the finding and is a pure code-reading fact |

### Coordinators: bounds, removal, and accounting

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| stagelc-transform-page-session-map-has-no-removal-path | Bind a route, send one paged series or even one malformed page zero, unbind **every** route for that session, repeat with a fresh session id (H7). No fault. `unbind_route` routes to `discard_transform_pages_for_route` (`:4268`) rather than an evict, while the sibling seed coordinator does call `evict` (`:4267`) | **Yes, with one workload correction.** Unbinding *a* route is not enough and the earlier row implied it was. `unbind_route` (`:4232-4256`) computes `last_session_route` by scanning the remaining bindings for another channel on the same session (`:4242-4247`) and enters the session-scoped cleanup only when none remains (`:4256`), so a multi-route session keeps its entry legitimately and a check that ignores this fails against a correct implementation. Close every binding for the session and the claim is exact: `discard` (`:1131-1144`) uses `get_mut` and clears `completed` and the phase, and the whole impl `:1107-1320` contains no `remove`. Reading map cardinality from a test is established by `:18730` |
| stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session | 64 distinct sessions each holding a `Collecting` phase, plus one further session that previously staged and was discarded so its entry survives while its phase is `Idle` (H7) | **Yes.** The `contains_key` conjunct at `:1186-1190` short-circuits the `BufferOverflow` return. The 128 MiB byte cap at `:631` still holds, so this is a loss of defence in depth, and it is exactly the half of the `:1064-1065` claim ("every sender contributes to the same bounded staging budget") that has no implementing code |
| stagelc-seed-pending-count-is-never-incremented | Stage one non-final seed batch and read the counter (H7, trivially). No fault | **Yes, and it is the cheapest oracle in lens B.** Verified by enumerating all four occurrences: declaration `:942`, initialiser `:951`, and `saturating_sub` at `:975` and `:985`. No `+=`, no comparison, and the struct at `:939-944` has no `max_pending` field while both siblings do (`:1072`, `:1345`) and both compare it (`:1186`, `:1572`). Because `phase_bytes` returns 0 for `AwaitingSeed` (`:962`), such a phase is bounded by neither counter nor bytes |
| stagelc-completed-replay-results-are-uncharged-and-unexpiring | Complete one paged transform and one paged seed successfully, then read `total_staged_bytes` and compare it **against the size of the retained result**, not against the budget ceiling (H7). No fault | **Yes, with the oracle corrected.** The earlier row inherited the record's original check, which bounded retained plus phase bytes by `max_staged_bytes`; that inequality holds trivially for a small result and holds for a coordinator that charges nothing and expires nothing, so it cannot fail on this record's own scenario. Comparing retained bytes against the charged counter is what makes it falsifiable, with a bounded-release conjunct for the expiry limb. The ordering is the mechanism: `release_phase` runs first (`:9554`, `:9101`), so the phase is `Idle` when `completed` is assigned (`:9558-9568`, `:9106-9116`), and `phase_bytes` returns 0 for `Idle` (`:1112`, `:962`). The seed reaper's filter matches only `Collecting` (`:1009`), so an `Idle` phase holding a full `PreparedOutput` is never reaped |
| stagelc-state-import-discard-runs-before-the-binding-check | A victim session staged mid-series on channel A, then a request on channel B carrying `session_id` = victim plus any field failing an early validation, for example `v != 1`. No fault | **Yes.** The closure at `:5621-5627` captures `parsed.session_id`; its call sites at `:5629`, `:5636`, `:5640` and `:5646` all precede `resolve_binding` at `:5653`, and the `BindingError::Unbound` arm itself calls it at `:5656`. The raw-session variant at `:5599-5603` runs before the wire struct is parsed. The seed path (`:8665`) and the page path (`:9347`) resolve first and do not share the shape. Constructible today; production blast radius is bounded by `state_import` being `explicit-config-only` |

### Coordinators: abandonment, restart, and unwind

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| stagelc-abandoned-page-collection-is-released-within-a-bounded-window | A partial page series, then silence, with the route left bound so `route_gone` does not mask the property (H6). Poll `total_staged_bytes` across a 15-minute window that strictly exceeds both sibling TTLs (`:627`, 10 minutes; `:654`, 5 minutes) | **Yes, at a wall-clock cost with no knob.** The situation is free to construct, and staleness is even expressible because `queued_at_ms` is a caller-supplied parameter (`:1184`, stored `:1236`). What is missing is anything to reap on it: no page TTL in `:596-669`, no `evict_stale*` in `:1107-1320`, and no injectable clock, unlike seeds (`:2921`) and imports (`stale_after`, `:1346`). The only releases are the explicit `discard_transform_pages*` calls from route replace (`:3800`), teardown (`:4268`), the twelve error returns in `:9352-:9439`, and assembly failure (`:9524`) |
| stagelc-seed-reaper-only-runs-on-fresh-traffic | One partial seed series, then no further `state_sync` request for the whole TTL window, while traffic of other kinds flows freely (H6). That distinction is the whole point: it separates a self-driven reaper from a timer | **Yes, and nearly free.** `state_sync_seed_now` (`:2921`, read `:8617-8626`) is an unused injectable clock, so the 10-minute `STATE_SYNC_SEED_COLLECTOR_TTL` (`:627`) window collapses to an assignment. Verified that `evict_stale_collectors` (`:1004`) has exactly one call site, `:8860`, inside the seed staging path it cleans, with no `spawn_module_task` or interval driving it. Split from the import half this revision; note that the coverage the combined record claimed, `:27013`, was entirely on the import side, so this half has **no** existing check at all |
| stagelc-state-import-reaper-only-runs-on-fresh-traffic | One partial multi-batch import, then no further `state_import` request for the whole window (H6) | **Yes, and half-covered already.** `StateImportCoordinator::stale_after` (`:1346`, from `STATE_IMPORT_STALE_AFTER`, declaration `:654`, wiring `:1357`, compared `:1403`) is settable, which is how `:27013` reaches the staleness path by forcing `Duration::ZERO` at `:27055` and then sending **another** import, which is the self-driven path rather than an independent one. Verified `evict_stale` has exactly one call site, `:1441`, at the top of its own `stage`. Reachability is `explicit-config-only`, which sharpens rather than weakens the record: the only production sender is a script that runs once and stops, so "abandoned" and "no further traffic of this kind" are the same case here |
| stagelc-staged-state-does-not-survive-a-restart | A process restart, graceful via `shutdown` or abrupt, with at least one `Collecting` phase live (H5) | **Yes, in-process.** `shutdown` (`:12048`) overwrites all three coordinators at `:12095-12099` and construction (`:3463-3467`, `:3761-3765`) produces empty ones, so both sides are readable from one test. The rejections are in place and fail loud: pages require `page_index == 0` from `Idle` (`:1197-1199`), imports require `batch_seq == 0` from absent (`:1566-1571`), seeds arm `AwaitingSeed` only for `batch_index == 0` (`:8869`). This record documents the intended design; its value is as the precondition for the next one |
| stagelc-restart-drops-the-only-page-level-replay-guard | A paged series whose final page commits inside `handle_transform_unpaged_value` (`:9528-9536`), the response lost or a restart before the caller records success, then the caller redriving the final page against a fresh process (H5 plus H1). Per METHOD.md's effect-accounting rule, count attempted and acknowledged separately per `(session, transform_page_id, generation)` identity, **and cap committed transitions at one per identity** | **Partial.** The situation is fully constructible; what is unresolved is whether the check is a defect oracle or a redundancy note, because nobody has established whether the cache-state CAS inside `handle_transform_unpaged_value` rejects a second application at the same generation. One correction to the oracle this revision: attempted and acknowledged bounds alone do not suffice, because two attempts with no acknowledgement permit two commits, which is the defect itself; the per-identity ceiling of one is the primary oracle and the bounds are the screen, which is what METHOD.md's rule actually says. Verified that the in-memory `completed` slot is the only page-level guard, that it is read at `:9446-9460` on an exact `generation` plus `final_digest` match, that `shutdown` clears it (`:12097`), and that it is stored only for `PreparedOutcome::Response` (`:9537-9540`), so an errored or streamed final page leaves no guard even without a restart |
| stagelc-applying-phase-has-no-unwind-guard | A panic inside `handle_transform_unpaged_value`, or the dispatch future dropped at the `await` at `:9528-9536`, while a session's phase is `Applying` (set at `:1298-1304`, released at `:9554`). Then a further page request for the same session, which should succeed and instead returns `in_progress` | **Partial.** The consequence is cheap: fabricate an `Applying` phase directly, as `:18730` fabricates a `Collecting` one, then assert `InProgress` (`:1242-1254`, surfaced `:9501-9503`). Reaching it by a real unwind is not available: no injectable panic on that path, and the file's only production panic is `:3661` on a different one. The cancellation half is unresolved and needs a Part 2a fact about whether `mc-host` drops a dispatch future; `handle` (`:11963-11996`) awaits inline. The structural claim is fully verified: ten `impl Drop` blocks and none for a staging phase, against an idiom the code states itself at `:479-480` |

### Coordinators: the two enabling-state markers

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| stagelc-a-coordination-is-observed-mid-sequence | **None.** A three-page series with the observer sampling after page 1. Reaching it needs only a transform body over `MODULE_PAGE_MAX_BYTES` (`module-wire.ts:20`), which the plugin pages automatically at `module-wire.ts:1097` | **Yes.** Verified the `Ack(next_index)` construction at `:1313-1315`, the response shape at `:9509-9513`, and that `next_index` starts at 1 (`:1232`) and increments per accepted page (`:1290`). The scoping refinement in the compliance review below is now applied in the record: conjunct (c) reads the observed session's own `phase_bytes` (`:1108-1114`), not the coordinator-global total |
| stagelc-a-graceful-shutdown-is-observed-with-staged-state-present | **None beyond the boundary itself.** A partial series, then `shutdown` (H5, graceful form) | **Yes, in-process and nearly free.** `shutdown` (`:12048`) overwrites all three coordinators at `:12095-12099`, and construction (`:3463-3467`, `:3761-3765`) produces empty ones, so both sides are readable from one test |
| stagelc-an-abrupt-restart-is-observed-with-staged-state-present | **None beyond the boundary itself.** A partial series, then a process kill rather than a `shutdown` call (H5, abrupt form) | **Yes, at the cost of a real process.** `direct_host.rs:149` already proves the fixture host can be restarted with transform state present, so this is wiring plus staging a coordination before the kill. The split from the graceful marker is applied this revision, for the reason in the compliance review below: one marker accepting either boundary form is satisfied by a campaign that never tests the abrupt one, and only the graceful path executes the reset |

**Totals: 22 non-vacuous today, 3 partial, 0 no.**

The distribution is the most favourable in the catalog so far, and it improved
again this revision for a reason worth naming precisely, because the earlier
version of this section drew the wrong conclusion from it. Part 3 had cheap
capabilities missing and records blocked on infrastructure. Part 4a had one record
blocked outright by a missing seam inside the publish transaction. Part 4b had no
blocked record and a structural hole falling on a claim no record covered. Part 4c
was described as a part where **all three blocked records plus the main half of a
fourth were blocked by exactly one missing capability**, H3, a store-side
write-failure injector. That was a tidy story and it was false: the capability
exists. An arbitrary-SQL seam is compiled into this crate's tests and already used
by them, and every one of the four writes is an ordinary table insert that an
aborting trigger can fail. So Part 4c now has **no record blocked outright**, which
is a stronger claim than the one it replaces and a less flattering one about the
original enumeration.

The three remaining `Partial` rows do not cluster on a capability either. They rest
on two unresolved facts and one missing seam of a different shape: whether the
transform handler's own CAS rejects a redriven final page (4b territory), whether
`mc-host` can drop a dispatch future (Part 2a territory), and, newly identified
this revision, the absence of a **post-commit** hook in `handle_state_sync_value`,
without which the durable write and the in-memory capability flag cannot be
separated at all. The pre-apply hook that exists fires on the wrong side of the
commit.

The methodological point is worth keeping. Absence of a *named* seam was read as
absence of the capability. Part 4a's evaluation recorded exactly that failure mode
three times and this file repeated it, in a harder-to-spot form: the seam was
listed in the enumeration, given the adjective "narrow" from its doc comment, and
never read. One line of its body settles it.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically. Markers duplicating the two existing `sometimes` records
are deliberately absent.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `handler_committed_the_recomp_reset` | `reset_session_for_recomp` (`:6077`) committed on a pass where `never_minted` was false | The ordinary shape of every reset-path recomp |
| `handler_reached_the_recomp_ledger_write` | `record_recomp_command` entered at `:6114`, distinct from the `nothing_to_do` write at `:6060` | Legal and is the second half of the pairing. Recording both call sites separately is what makes the ordering finding checkable |
| `authority_prepare_transition_landed_in_module_state` | `row.state == "MODULE"` at `:7248` | Legal; the four transition arms at `:7187-7239` exist for it |
| `authority_prepare_reached_the_route_bind` | `bind_authority_route` entered at `:7250` after the transition committed | A structural fact about straight-line order, true today with fully correct behaviour |
| `authority_route_bind_took_the_documented_unbound_skip` | `facade_binding(channel)` failed, so `:4417-4419` returned `Ok(())` without writing | Legal **and documented** at `:4407-4409`. Witnessing it is what distinguishes the deliberate skip from a store failure on the same call |
| `authority_drain_finish_supplied_both_checksum_sides` | A `finish` request carried `verified: true` with `checksum_expected` and `checksum_actual` both defaulted at `:7371-7382` | An input-domain outcome, legal to observe. The independent precondition of the integrity-comparison finding, stated without asserting a bypass |
| `guidance_session_loaded_with_no_row_version` | `loaded.row_version` was `None` at `:7746`, so the function returned before the commit | Legal: `mc-store/src/lib.rs:5500-5505` produces it for any uncommitted session. The precondition of the silent-success record, not the violation |
| `guidance_commit_returned_a_cas_conflict` | The `continue` at `:7753` taken at least once | Legal; the `for _ in 0..2` retry at `:7730` exists for it. Witnessing one conflict is not the same as asserting exhaustion |
| `transform_wrote_the_project_mural_before_the_pass` | `upsert_project_mural_artifact` committed at `:8210-8215` on a pass that later reached the engine | Legal and the ordinary OpenCode shape; the mural write is unconditionally outside the fence |
| `transform_returned_the_transform_failed_code` | `reject_transform` returned `transform_failed` at `:8334`, the code's only site | Legal: the guards in the engine exist to raise exactly this. The precondition of the rejected-side-effect record |
| `side_channel_drain_reported_a_nonzero_failed_count` | The store's per-row counters (`mc-store/src/lib.rs:9572-9581`) computed `failed > 0` for the drain at `:8252` | Legal; the seam at `mc-store/src/lib.rs:5249` exists for it and `:30041` already uses it |
| `guidance_served_a_date_for_a_session_with_no_row` | A `guidance.get` response returned for a session whose `store.load(...).row_version` is `None`, the `:7746-7748` arm | Legal, and already witnessed: `lib.rs:22991-23008` produces exactly this state and asserts it. Naming it as a marker is what lets a campaign show the arm was taken rather than inferring it from a passing assertion elsewhere in a long test |
| `state_import_reached_the_terminal_commit` | `commit_state_import` called at `:5738` after `stage` returned `Apply` at `:5734` | The ordinary shape of a completed multi-batch import |
| `state_import_cleared_staging_after_the_commit_call` | `complete()` at `:5744-5747` ran before the outcome was matched at `:5748` | Legal and unconditional by construction. This is the marker that makes the lost-work finding checkable without asserting a failed commit |
| `state_import_discarded_before_resolving_the_binding` | A `discard` call at `:5629`, `:5636`, `:5640`, `:5646`, `:5599-5603`, or the `Unbound` arm at `:5656`, taken before `resolve_binding` at `:5653` | A structural fact about statement order, true today. The precondition of the cross-session record, and it does not assert that any victim state was destroyed |
| `state_sync_set_the_capability_after_its_durable_commit` | `apply_authority_state_sync` committed at `:9241` and `set_note_evaluation_capability` then ran at `:9288-9291` | Legal and is the documented ordering; recording it is what makes the not-replayed-together finding checkable |
| `state_sync_returned_authority_seq_mismatch` | The fence rejected a repeat at `:9316-9318` | Legal and deliberate: `expected_shadow_seq` (`:9245`) exists to produce it, and it is the mechanism that makes the paged replay memo's non-durability safe |
| `dreamer_ledger_read_found_no_row_before_a_producer_ran` | The read at `:9819-9828` returned no row and a producer was then constructed at `:9848` | Legal on every first delivery. The precondition of the second-billable-run hazard the code names at `:9816-9818`, stated without asserting a second run |
| `dreamer_chain_exhausted_without_an_output` | `output.is_none()` at `:9983`, so the failure-path write at `:9989` was reached | Legal; the classify ladder can exhaust its models, and `:25806-25810` already poisons a model chain |
| `dreamer_returned_run_failed_from_the_duplicate_guard` | The in-flight guard at `:9796-9814` returned `dreamer_run_failed` at `:9804` | Legal and correct: no ledger row exists on that path **by design**. It is the independent precondition of the error-code collision |
| `todo_state_set_store_returned_the_noop_variant` | The store returned `TodoStateSetOutcome::Noop` (`mc-store/src/lib.rs:2738-2741`), whose predicate at `:6737-6740` requires both `owner_message_id` and `state_hash` to match | Legal and is a genuine content-keyed no-op. The precondition of the collapsed-response record, asserted without claiming a double-apply |
| `session_delete_returned_a_zero_deleted_rows_count` | `deleted_rows` was 0 at `:6154` on a response that was still `ok: true` | Legal: an already-empty session produces it too, which is exactly the collision the record names |
| `transform_page_session_entry_survived_a_discard` | A session key present in `transform_pages.sessions` after `discard` (`:1131-1144`) ran for it | A structural fact about the absence of a `remove`, true today with fully correct behaviour |
| `transform_page_pending_gate_was_skipped_by_a_known_session` | The `contains_key` conjunct at `:1186-1190` short-circuited the overflow return | Legal: the conjunct is deliberate code. Observing it is a fact about the gate, not an outcome |
| `transform_page_completed_slot_stored_while_phase_was_idle` | `completed` assigned at `:9558-9568` after `release_phase` at `:9554`, so `phase_bytes` (`:1112`) returned 0 | Legal and is the ordinary success path. The precondition of the uncharged-retention record |
| `seed_phase_was_awaiting_seed_with_zero_charged_bytes` | An `AwaitingSeed` phase (armed at `:8869`) whose `phase_bytes` returned 0 at `:962` | Legal and deliberate. The precondition of the missing seed bound, and it does not assert unbounded growth |
| `seed_reaper_ran_from_inside_the_seed_handler` | `evict_stale_collectors` entered from its only call site, `:8860` | Legal; that is where it is called from. The precondition of the self-driven-reaper finding, stated as a location fact |
| `state_import_reaper_ran_from_inside_stage` | `evict_stale` entered from its only call site, `:1441` | Same shape, and `:27013` already reaches it |
| `transform_page_phase_was_applying_at_the_terminal_await` | The phase set to `Applying` at `:1298-1304` and the `await` at `:9528-9536` entered | Legal on every final page. The precondition of the unwind-guard record, without requiring a panic |
| `transform_page_session_had_no_remaining_bindings` | `unbind_route` computed `last_session_route` as `Some(session)` at `:4242-4247`, so the session-scoped cleanup block at `:4256` was entered | Legal and is the ordinary teardown of a single-route session. It is the precondition the map-removal record needs, and stating it separately is what stops that record's check from firing on a multi-route session that legitimately keeps its entry |
| `side_channel_drain_attempted_more_than_it_succeeded` | The store's per-drain counters (`mc-store/src/lib.rs:9572` `attempted`, `:9575` `succeeded`) disagreed for one pass | Legal: a failing delivery produces it, and the seam at `mc-store/src/lib.rs:5249` exists for exactly that. It is the precondition of the discarded-result record stated as a fact about the drain rather than about the surface |
| `dreamer_duplicate_arrived_while_the_first_was_in_flight` | A second delivery found its key already present in `inflight_dream_commands` at `:9802` and returned at `:9803-9809` | Legal and deliberate, documented at `:9786-9789`. Recording it separately is what marks the response path that correctly leaves **no** ledger row, which is the precondition the dreamer record's scoped check depends on |

### The two existing `sometimes` records, checked against METHOD.md

Lens B produced the part's only two `sometimes` records. **Both comply**, and each
carries one refinement rather than an objection. Neither is duplicated in the
table above.

- `stagelc-a-coordination-is-observed-mid-sequence` **complies.** All three
  conjuncts are independent preconditions that hold on a correct implementation:
  a `"staged": true` response with `next_expected_index >= 1`, a series
  `transform_page_total >= 3`, and `total_staged_bytes > 0`. None asserts a
  violation, and no `always(!X)` companion exists, so the forbidden pairing is
  absent. Choosing `sometimes` over `reachable` is right for the stated reason:
  executing the `Ack` arm at `:9509-9513` is location coverage, whereas the
  operational state of a partially assembled coordination is a situation.
  **Refinement:** conjunct (c) reads `total_staged_bytes`, which is a
  coordinator-global total (`:1108-1114`). With more than one series in flight, or
  with one abandoned collection left over from an earlier test, that conjunct is
  satisfiable by a *different* session's bytes, so the marker can fire without the
  session under test ever being genuinely mid-sequence. Scope it to the observed
  session's own phase bytes. Conjunct (b) already prevents the single-page
  vacuous-pass mode, so nothing else is needed.
- `stagelc-a-restart-is-observed-with-staged-state-present` **complies.** The
  three conjuncts are preconditions on a correct system, and the record explicitly
  states that it does not assert anything was double-applied, which is the rule
  most often broken. **Refinement:** conjunct (c) accepts either of two
  alternatives, `shutdown` returning or a fresh `McHandler` observed with zero
  `total_staged_bytes`. Only the graceful path executes the reset at
  `:12095-12099`, and the record's own Fault/timing angle says both the graceful
  and the abrupt boundary should be covered. As written, a campaign that only ever
  shuts down gracefully satisfies the marker, and a green run cannot be
  distinguished from one that never tested the abrupt boundary. Split it into two
  named markers, one per boundary form, or record which side the campaign took.
  This is the same failure mode 4b recorded for its frozen-counter starvation risk
  (`../part-4b-transform/fault-map.md:204-215`): a marker that a legal-but-narrow
  campaign satisfies for the wrong reason.

### Anti-patterns to avoid in this part specifically

Six pairings are forbidden by METHOD.md's rule, and each is tempting here because
the defect is easier to name than its precondition.

- Do not pair `always(!second_billable_run)` with `sometimes(second_billable_run)`.
  The marker can only fire by paying for a duplicate model call. Assert
  `dreamer_ledger_read_found_no_row_before_a_producer_ran` and
  `dreamer_chain_exhausted_without_an_output` instead: two independent
  preconditions, both legal, both present on a correct implementation.
- Do not pair `always(!session_reset_without_a_ledger_row)` with
  `sometimes(session_reset_without_a_ledger_row)`. Assert
  `handler_committed_the_recomp_reset` and
  `handler_reached_the_recomp_ledger_write` instead.
- Do not pair `always(guidance_date_persisted)` with
  `sometimes(guidance_date_unpersisted)`. Assert
  `guidance_session_loaded_with_no_row_version` instead, which is a fact about the
  loaded row rather than about the response being wrong.
- Do not pair `always(pending_transform_count <= TRANSFORM_PAGE_MAX_PENDING)` with
  `sometimes(pending_cap_exceeded)`. Assert
  `transform_page_pending_gate_was_skipped_by_a_known_session` instead. That is a
  fact about the `contains_key` conjunct at `:1186-1190`, not an outcome.
- Do not pair `always(phase != Applying)` with
  `sometimes(phase_stranded_in_applying)`. Assert
  `transform_page_phase_was_applying_at_the_terminal_await` instead. A stranded
  phase wedges the session for the process lifetime, so a marker that fires only on
  the defect poisons the rest of the campaign.
- Do not pair `always(authority_flip_had_an_independent_checksum)` with
  `sometimes(caller_supplied_both_checksum_sides)` **as a violation marker**. The
  request shape is legal input; assert
  `authority_drain_finish_supplied_both_checksum_sides` as a precondition and keep
  the `always` on the store's comparison being independently computed.

### Placement constraints on markers in this part

Three, and they differ from 4b's because each handler owns its own first write
rather than sharing one mutation region.

1. **"Nothing durable has happened yet" has a different line per handler.** The
   first durable write is `:6077` for recomp, `:7187-7239` for authority prepare,
   `:8210` for the OpenCode transform, `:5738` for state import, `:9241` for state
   sync, and `:6140` for session delete. A marker with that meaning must sit above
   the specific one, not above a shared boundary.
2. **In `handle_state_import_value`, authorisation is *not* established before the
   first `discard`.** `resolve_binding` is `:5653` and five discard sites precede
   it (`:5599-5603`, `:5629`, `:5636`, `:5640`, `:5646`), with a sixth inside the
   `Unbound` arm at `:5656`. Any marker whose meaning is "this request was
   authorised to touch this session" must sit **after** `:5653`, and nothing placed
   at `:5629-:5646` may be read as carrying that meaning.
3. **Phase markers must record which side of `release_phase` they are on.**
   `:9554` for pages and `:9101` for seeds move the phase to `Idle` before
   `completed` is assigned (`:9558-9568`, `:9106-9116`), and `phase_bytes` returns
   0 for `Idle` (`:1112`, `:962`). A byte-accounting marker placed after the
   release sees a total that excludes the retained result, which is the defect,
   so place it where the precondition becomes true rather than after the code has
   finished depending on it.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put H7 or H1 at the
top; that is the wrong answer, because the single cheapest capability here unblocks
**zero** records and protects all 25.

**State this plainly: several of this part's sharpest findings need no fault at
all.** The guidance handler's no-row silent-success arm is a seeded-state unit test
against a session that was never committed, and note the verb: it is the *no-row
arm* that is free, not "exhausting the retry loop", which needs contention as the
framing correction above establishes. Repeat delivery of `session.delete` is two
sequential calls. Reading a dead counter is one call and one field read. None of
these needs a seam, a second process, a clock, or a new dependency.

1. **H0, running the existing tests in CI, including the two integration binaries
   that already drive the real handler.** A workflow change and nothing else:
   `cargo test -p mc-module --lib` alongside the existing `--test lifecycle_cli`
   step (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`), plus `--test direct_host`
   and `--test host_adapter`, plus calling the `scripts/test-rust.sh` lane that
   already exists in `package.json` and that no workflow invokes. It unblocks
   **zero** new records and **protects 72 existing checks**: the 69 claim-bearing
   in-crate tests spanning `:16391-30488`, plus the three integration tests that
   reach 4c through a real `McHandler` (`direct_host.rs:67`, `direct_host.rs:149`,
   `host_adapter.rs:102`). Those three are the highest-value item on the list,
   because one of them already crosses a process restart with transform state
   present, which is precisely the H5 capability two records need, and
   `host_adapter.rs:102` already holds a real single-writer lease and asserts that
   shutdown joins the blocked waiter and retains no lease. **Nothing else on this
   list matters until this is done**, because anything added below is added to a
   suite no automation executes. One blocker is named and bounded:
   `ci.yml:719-721` says Rust is absent from the e2e lanes because private
   `../commons` and `../subconscious` path-deps are not provisioned, and
   `ci.yml:163-164` provisions metadata-only stubs. Whether that constraint reaches
   these two binaries is an open question rather than a settled no.
2. **H2 and H4a, the two no-fault oracles.** No seam, no store state, no second
   process, no clock, no new dependency. Send `session.delete` twice and read
   `deleted_rows` (`:6154`); send `guidance.get` against a session with no row and
   read `meta.guidance_date` from the store rather than the response. Between them
   these make `h4c-session-delete-has-no-caller-supplied-operation-identity` and
   `h4c-guidance-date-returns-success-without-persisting` non-vacuous outright,
   and the second has a contradiction already waiting: the only `Err` return in
   `guidance_date_for_session` is `:7754`, so neither fall-through can surface as
   an error, and the response at `:7704-7722` has no persistence field among its
   twelve keys. Four further records need no fault class at all and belong in the
   same first wave for the same reason:
   `h4c-no-handler-in-scope-uses-the-claim-intent-ledger` (pure structure),
   `h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write` (already
   exercised at `:27182`, so only the verdict changes),
   `h4c-authority-drain-finish-compares-two-caller-supplied-checksums` (request
   shaping over seeded authority state), and
   `stagelc-seed-pending-count-is-never-incremented` (one call, one field read).
3. **H7 plus direct coordinator reads, which `:18730` already proves possible.**
   `module_status_memory_metrics_match_budget_accounting_and_falsy_semantics`
   (`:18730-18844`) fabricates a `Collecting` phase and a
   `CompletedTransformPage` and reads `transform_pages` back, so the whole
   coordinator surface is inspectable from a test with no new infrastructure.
   Reusing that pattern makes four records valid at once:
   `stagelc-transform-page-session-map-has-no-removal-path`,
   `stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session`,
   `stagelc-completed-replay-results-are-uncharged-and-unexpiring`, and the cheap
   half of `stagelc-applying-phase-has-no-unwind-guard`. It is third rather than
   second only because it needs 64 distinct sessions for one of the four. This is
   also where the sub-part's quietest surface finally gets touched: the 244-line
   `handle_transform_page_value` (`:9335-9578`) has zero tests while its
   TypeScript sender carries nine CI-gated `transform_page_id` assertions.
4. **H1, repeat delivery with an identity.** Also two sequential calls, and it sits
   below H2 only because the identity has to be constructed. It makes
   `h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together`
   valid through the `expected_shadow_seq` fence, and it supplies the free half of
   `h4c-dreamer-failure-path-ledger-write-is-unchecked` by observing that
   `dreamer_run_failed` is returned at `:9804`, `:9968` and `:9996` with no way for
   the caller to tell whether a durable row exists.
5. **H6, using the two clock seams that already exist and no test uses.**
   `state_sync_seed_now` (`:2921`, read `:8617-8626`) collapses the seed
   coordinator's 10-minute TTL to an assignment, and `stale_after` (`:1346`) does
   the same for imports and is already used at `:27055`. That makes
   `stagelc-seed-and-import-reapers-only-run-on-fresh-traffic` valid in
   microseconds. The page half of
   `stagelc-abandoned-page-collection-is-released-within-a-bounded-window` is the
   exception and the reason this is fifth: there is no page TTL and no page clock,
   so the honest form is a 15-minute wall-clock window, chosen because it strictly
   exceeds both sibling TTLs (`:627`, `:654`).
6. **H5, a process boundary with staged state present.** The graceful form is
   in-process and nearly free through `shutdown` (`:12048`, reset at
   `:12095-12099`). The abrupt form needs a real process, and `direct_host.rs:149`
   already proves the fixture host can be restarted, so this is wiring plus adding
   a staged coordination to that test rather than new infrastructure. It makes
   `stagelc-staged-state-does-not-survive-a-restart` and the marker
   `stagelc-a-restart-is-observed-with-staged-state-present` valid, and it supplies
   the situation `stagelc-restart-drops-the-only-page-level-replay-guard` needs.
7. **Crafted transform requests reaching a rejection.** More test-authoring work
   than items 1 through 6, which is the only reason it sits here: no seam is
   needed, since `transform_failed` has one site (`:8334`) and the engine's own
   guards raise it from crafted state. It makes
   `h4c-transform-writes-two-side-effects-before-its-fenced-commit` valid, which is
   the record that observes a rejected pass leaving a durable mural other sessions
   then inherit through `cc_mural_input` (`:8224`).
8. **H4b, deterministic CAS exhaustion in the guidance loop.** Needs a hook in
   `guidance_date_for_session` between `:7731` and `:7751`, or an accepted
   probabilistic contention test. It unblocks **zero** records, because H4a already
   makes the same record non-vacuous, so what it buys is the second window rather
   than a new finding. The nearby precedent shows how cheap the fix would be:
   `state_sync_before_apply_hook` (`:2925`, fired `:9234`) is exactly this seam,
   one handler over.
9. **H8's honest half, a real unwind at the terminal await.** Needs either an
   injectable panic on the transform path or a resolved answer from Part 2a about
   whether `mc-host` drops a dispatch future. It unblocks zero records beyond the
   fabricated-phase form already available. What it buys is the distinction between
   a wedge a test constructed and a wedge production can reach.
10. **Named store-side write failpoints, which are a clarity improvement rather
    than a capability.** This item used to read "H3, a store-side write-failure
    injector: last on cost and **first on consequence**, the only capability on this
    list that any record is blocked on", blocking three records outright plus the
    main half of a fourth. That is withdrawn. The capability exists:
    `execute_tag_sql_for_test` (`mc-store:6431-6440`) runs an arbitrary SQL batch, is
    enabled for this crate's tests (`crates/mc-module/Cargo.toml:66-72`), and is
    already used at `lib.rs:23768` and `:23795`, so an aborting trigger fails any of
    the four writes on demand. All four records are non-vacuous today:
    `h4c-recomp-reset-precedes-its-ledger-row`,
    `h4c-authority-prepare-route-bind-is-a-second-transaction`,
    `h4c-state-import-commit-clears-staging-on-every-outcome`, and
    `h4c-dreamer-failure-path-ledger-write-is-unchecked`. What remains worth doing,
    and why this stays last, is that trigger-based injection is off-label: the seam
    is named and documented for tag-cache SQL (`:6431-6432`), a trigger is coarser
    than a call site so it cannot pick the second of two calls to the same function
    without a `WHEN` clause, and a reader of the test has to reconstruct the
    mechanism. Four narrow named failpoints on `record_recomp_command`,
    `bind_authority_route`, `record_dream_task_command` and `commit_state_import`,
    following the shape of `fail_next_historian_side_channel_for_test`
    (`mc-store/src/lib.rs:5249`, consumed at `lib.rs:30041`), would say what they
    mean. They would land in `crates/mc-store`, which appears in **no** workflow, so
    the clarity is for readers rather than for CI.
11. **A post-commit hook in `handle_state_sync_value`, which is a genuine missing
    capability and is new to this list.** The existing
    `state_sync_before_apply_hook` (`:2925`, fired `:9232-9240`) is on the wrong side
    of the commit at `:9241`, and the durable write and the in-memory capability set
    at `:9288-9291` are synchronous with `respond` at `:9292`, so no request-level
    workload separates them. Splitting them needs code to run between `:9241`
    returning `Ok` and `:9288`, which means a symmetric hook or an injected panic.
    Without it `h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together`
    stays `Partial`: the fenced rejection on a retry is observable and the split
    state is not.

**Records that need a product decision rather than a harness.** No amount of test
infrastructure resolves these, and each is a live open question from at least one
lens.

- Whether `let _` at `:9989` is deliberate. The same function names the hazard at
  `:9816-9818` ("a second billable run"), hardens the read against it at
  `:9822-9827`, and reasons at length about ledger durability before purge on the
  success path at `:10023-10027`. An unchecked write on the other half of that
  contract reads as an oversight, and the alternative reading, that recording a
  failure is best-effort, is weakened by `:9984-9988` constructing a full
  replay-shaped response for storage.
- Whether `dreamer_run_failed` should be split. Two of its three sites correctly
  leave no ledger row **by design**, and the success path already distinguishes
  its failure with `dreamer_ledger_failed` at `:10036`.
- Whether the two-iteration CAS budget in `guidance_date_for_session` (`:7730`) is
  deliberate, or whether `0..2` was intended as "retry until settled", and whether
  the response should carry a persistence field at all.
- Whether `deleted_rows == 0` is intended as `session.delete`'s duplicate signal.
  Nothing documents it as one and it collides with deleting an already-empty
  session.
- Whether `todo_state.set`'s collapsed `{"ok": true}` is a deliberate contract,
  given `:27182` asserts it byte for byte, twice, and there is no doc comment on
  `handle_todo_state_set_value`.
- Who may send `authority.drain.finish` and `authority.drain.begin`. The trust
  class decides whether the caller-supplied checksum pair and the empty-lease
  default at `:7336-7340` are holes or rough edges.
- Whether `TransformPageCoordinator` should have a TTL reaper like its two
  siblings, or whether route teardown is considered sufficient. Teardown fires
  only on the **last** route for a session (`:4256`), so a multi-route session
  never gets it, and the map has no removal path in any case.
- Whether the two existing TTL reapers should be timer-driven rather than driven by
  the staging path they clean (`:8860`, `:1441`), and whether
  `StateSyncSeedCoordinator` is missing a `max_pending_seeds` cap on purpose.
- Whether `completed` replay results should be charged to `max_staged_bytes`, given
  each is a full transform or state-sync response body.
- Whether the pre-binding discard in `handle_state_import_value` (`:5621-5656`) is
  intentional, and whether `state_import` will stay `explicit-config-only`. The
  record's severity rises with its reachability class.
- Whether the paged-transform receiver should be tested at the Rust boundary at
  all, or whether the CI-gated TypeScript sender contract (nine
  `transform_page_id` assertions in `rust-mode-transform.test.ts`) is considered
  sufficient coverage of the pair. This decides whether the quietest area in 4c is
  a gap or an accepted division of labour.
- Whether the absence of any 4c entry from `docs/AUDIT-KNOWN-ISSUES.md` is
  deliberate, that is, whether that file is scoped to the TypeScript
  implementation by design. If so, the Rust side has no accepted-issues register at
  all, which is worth stating somewhere.
- Whether the TypeScript dreamer lanes and the Rust `handle_dreamer_run_task`
  implement the same contract, which would make the CI-gated TypeScript suite a
  parallel-implementation gate as 4a found for the historian validator.
- Whether `handle_mirror_pull_value` (`:7429-7449`) belongs to 4c or to Part 3's
  claim-mirror scope. The scope map assigns mirror receipt semantics to Part 3
  while listing `:7134-8005` in 4c.
- Whether a never-executed test counts as `Exercised: partial`. It governs every
  `Existing check:` line in this part, all three lenses raise it, and it is
  unresolved.
