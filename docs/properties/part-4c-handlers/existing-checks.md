# Part 4c existing-check inventory

Every claim-bearing check for the durable operation handlers and the staging
coordinators: `crates/mc-module/src/lib.rs` ranges `139-3105`, `3398-4542`,
`5591-6429`, `7134-8005`, and `8007-10040`, about 7,857 production lines. The
sub-part owns the request-path handlers (`state_import`, `agent_drops.append`,
`todo_state.set`, `session.flush`, `session.recomp`, `session.delete`, the
`authority.*` family, `guidance.get`, `state_sync`, `dreamer.run_task`, the
unpaged and paged transform entries) and the four coordinators
(`StateSyncSeedCoordinator`, `TransformPageCoordinator`, `StateImportCoordinator`,
`StoreOpenCoordinator`).

Provenance. `HEAD` is `e447c927` ("refactor(shm): trim final review leftovers").
`git diff --stat 76cd6f41 HEAD -- crates/mc-module/src/lib.rs` returns nothing, so
every `lib.rs` line reference below is identical at `76cd6f41` and at `HEAD` and
is stated without qualification. `.github/workflows/ci.yml` **does** differ across
that span (+9, -1), and the one step that matters here moved: the
`mc-module` test invocation is `ci.yml:168` at `76cd6f41` and `ci.yml:172` at
`HEAD`. Both are cited wherever it appears. Lens C recorded the same drift and
corrected Part 4a's inherited `:168`; both numbers are real and they are different
lines.

Two references inherited from the lenses are corrected here. Lens B cites the
`WrapupSessionGuard` unwind guard at `:3198-3220`; `:3198` opens
`impl WrapupSessionGuard` with `fn set_rounds`, and the `Drop` impl is
`:3210-3220`. The `:3210` form is used below. Lens C cites
`STATE_IMPORT_STALE_AFTER` at `:1357`, which is the wiring site inside
`StateImportCoordinator::default`; the declaration is `:654`. Both are real and
both are used below for their own purpose.

An existing check does not remove a property from the catalog. Every status below
is **unaudited**: test adequacy belongs to `/testing:invariant-test-review`, and
production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory, and how the number was obtained

**69 claim-bearing in-scope tests, spanning `:16391-30488`. None of them runs in
CI.** That is the headline, and the attribution behind it is unusually careful, so
it is stated in full rather than asserted, because a reader should be able to
reproduce it.

`lib.rs` is 30,517 lines with two flat `#[cfg(test)]` modules, `mod tests`
(`:16002`) and `mod release_contract_tests` (`:30282`), and no inner `mod`. There
is no structural index, so a test's subject cannot be read off its location the
way it can in a file organised into submodules. Lens C therefore built the
attribution mechanically, in four steps:

1. **Enumerate.** All `#[test]`, `#[tokio::test]`, and `#[tokio::test(...)]`
   attributes from `:16001` on. Re-counted at `HEAD`: **256**, which is the exact
   figure lens C reports.
2. **Resolve.** Each attribute resolved to its following `fn` line, giving 256
   test functions: 248 whose `fn` lines span `:16041-30278` in `mod tests`, and 8
   spanning `:30320-30516` in `mod release_contract_tests`. That reconciles
   exactly with the scope map's independent 248 + 8.
3. **Brace-match.** Each body brace-matched to its closing line, so a test's
   extent is its real body rather than the gap to the next attribute.
4. **Fixpoint over helpers.** 4c production entry points matched inside each body,
   then a fixpoint taken over the **119 non-test helper functions** in the test
   modules, so a test that reaches a handler only through a request-builder or a
   fixture is attributed transitively. This step is load-bearing rather than
   cosmetic: all four `dreamer.run_task` tests invoke `handle_dreamer_run_task`
   only through the helper `dreamer_classify_outcome` (`:25798-25830`), and a
   naive body scan finds none of them.

The result is not one number but three, and they bracket the truth rather than
pinning it:

| Tier | Tests | What it measures |
| --- | --- | --- |
| **Reach** | **212** of 256 | Executes at least one line of 4c production code |
| **Op-specific** | **120** | Names a 4c-owned operation, coordinator, cache, route structure, or dispatch-health type |
| **Claim-bearing on 4c** | **69** | Op-specific, minus tests a sibling sub-part owns |

**The 212 figure is inflated, and by a known amount.**
`handle_transform_unpaged_value` (`:8007-8615`) sits in 4c while the pass engine
it calls is 4b, so **82 tests enter 4c through the transform handler while
asserting 4b engine behaviour**. Counting them as 4c coverage would make the
transform handler look like the best-tested surface in the sub-part when what they
actually pin is the engine below it.

The 69 is the 120 minus 51, subtracted by test name: **11 to 4a** (historian,
wrapup, reattach, firing, side-channel, seeded-phase), **28 to 4d** (facade,
`ctx_*`, note evaluation, native attachment, prepared output, schemas, byte caps),
and **12 to 4b and 4e** (Channel-2, renderer transition, duplicate `tool_use`,
reasoning watermark, differential asserts). Because that last classification uses
test names, its boundary is approximate at the edges. This is the one number in
this file that is derived rather than counted; the 256, the two module-opening
lines, and every per-cluster count below were obtained directly at `HEAD`.

**None of the 69 runs in CI.** Three mechanical facts produce that, each verified
across all five files in `.github/workflows/`:

1. **The only `mc-module` test invocation in any workflow is
   `cargo test -p mc-module --test lifecycle_cli`,** at `ci.yml:168` at
   `76cd6f41` and `:172` at `HEAD`. `--test lifecycle_cli` selects one integration
   binary and does **not** build the `--lib` target, so no in-crate `mc-module`
   unit test is compiled, let alone run. The step above it is build-only,
   `cargo build -p mc-module --bin ck-mc-host` (`:165` at `76cd6f41`, `:169` at
   `HEAD`).
2. **There is no `cargo test -p mc-module --lib`, no
   `cargo nextest run -p mc-module`, and no `--workspace` test job.** The only
   `--workspace` Cargo commands are `cargo fmt --check` and a `mc-core` feature
   check, `cargo check -p mc-core --no-default-features`.
3. **`scripts/test-rust.sh` (`cargo nextest run --workspace`) exists, is wired
   into root `package.json`, and no workflow invokes it.** The same holds for the
   `test:rust-e2e` lane.

The consequence for every record in this part is that `Exercised: partial` means
"a test exists on a developer's machine". METHOD.md's `Exercised` field does not
distinguish that from `not yet`; all three lenses raise it and it is recorded as
needing human input rather than resolved here.

## Integration tests: two of the three named binaries do exercise these handlers

This section is separate from the framing above because it is a **correction to
the prior sub-parts' posture**. Part 4b recorded that the one `mc-module`
integration binary CI runs has no transform coverage, and left the impression
that the integration suite barely touches the module's handlers. For 4c that is
wrong. Two of the three binaries the task names drive the real handlers
end-to-end through a real `McHandler`, one of them across a process restart, and
**neither runs in CI**.

| Binary | Tests | Exercises 4c? | Evidence |
| --- | --- | --- | --- |
| `tests/direct_host.rs` (438 lines) | 6 | **Yes** | Spawns `examples/direct_host_fixture.rs`, which constructs the real `mc_module::McHandler::new_with_connection_file` at `examples/direct_host_fixture.rs:636`. Sends `"kind": "transform"` at `tests/direct_host.rs:110` and `:173`, and the dispatcher accepts `kind` as an alias for `method` (`lib.rs:12248`), so both reach `handle_transform_dispatch` and then `handle_transform_unpaged_value`. `:67` `readiness_permissions_catalog_and_real_unary_transform` asserts `status == "ok"` and `served_from == "transform"` at `:128-129`. `:149` `direct_primary_replays_transform_state_across_fixture_restart` crosses a process boundary with transform state present. `:253` covers malformed, unknown, duplicate and over-cap controls | **No** |
| `tests/host_adapter.rs` (173 lines) | 4 | **Yes** | `McHandler::new()` at `:39`, `:74`, `:84`, `:106`. `:66` and `:69` call `route_gone`, reaching `unbind_route` (`:4233-4298`), which is the sole non-error release path for an abandoned page collection. `:102` `shutdown_cancels_and_joins_blocked_store_open` holds a real single-writer lease at `:105`, polls health for `"waiting on storage lease"` at `:119`, then asserts shutdown joins the blocked waiter and retains no lease at `:134`. That is a direct check on `StoreOpenCoordinator` and `run_store_open` (`:3543`) | **No** |
| `tests/prepared_output.rs` (282 lines) | 10 | **No** | Imports `mc_module::dispatch::{PreparedOutcome, PreparedOutput, PreparedOutputError, PreparedSegment, MAX_WIRE_BODY_BYTES}` and nothing else from the crate. Its `"status"` occurrences are JSON payload fields, not dispatch methods. It tests `dispatch.rs`, which the scope map assigns to sub-part **4d** | **No** |
| `tests/boundary_counter_durability.rs` | 1 | No | Zero 4c method literals, zero `McHandler` |
| `tests/broca_roundtrip.rs` | 2 | No | Zero `McHandler`, zero `bind_route`, zero `route_gone` |
| `tests/release_contract_conformance.rs` | 3 | No | Zero 4c method literals |
| `tests/lifecycle_cli.rs` | 12 | No | Uses `"status"` against the CLI, not the handler. Part 2a owns it. **This is the one binary CI runs** (`ci.yml:168` at `76cd6f41`, `:172` at `HEAD`) |

So **three integration tests reach 4c handlers through a real `McHandler`**:
`direct_host.rs:67`, `direct_host.rs:149`, and `host_adapter.rs:102`, plus route
teardown inside `host_adapter.rs:35`. The transform handler and the store-open
coordinator therefore do have end-to-end coverage, including a process restart;
it is simply never executed by automation. `direct_host.rs` is also the most
expensive of the three to adopt, because it builds the example binary itself at
test time (`tests/support/direct_host.rs:40-47`, `cargo build --example
direct_host_fixture --features direct-host-fixture`).

## In-crate tests, clustered with counts and line ranges

Clusters as lens C produced them, by direct or transitive-helper reference to the
named handler or method literal. Every cited `fn` line was re-read at `HEAD`.

| Cluster | Tests | Line range | Notes |
| --- | --- | --- | --- |
| transform handler entry (`handle_transform_*`) | 82 | `:16848-30213` | Reach-only for most; the assertions are usually 4b's |
| `status` / `health` / `diagnostics` | 33 | `:18730-30278` | The single most-reached read-only handler |
| `bind_authority_route` (as setup) | 22 | `:23111-…` | Setup, never an assertion target |
| in-scope caches (snapshot, boundary token, native, projection) | 27 | `:16391-28864` | Overlaps 4d, which owns native-attachment plumbing |
| `state_import` | 10 | `:26739-27124` | The best-covered durable op in scope |
| `agent_drops.append` | 10 | `:25445-27852` | Includes the `ctx_reduce` command-id family |
| `session.status` | 9 | `:17454-27534` | |
| `guidance.get` | 6 | `:22491-23009` | |
| store open (`begin_store_open`, `StoreOpenPolicy`) | 6 | `:16848-17059` | Lease wait, waiter dedup, shutdown cancel |
| dispatch health / wedge detector | 6 | `:18847-18957` | Includes the panic-drop-guard test |
| `dreamer.run_task` | 4 | `:25872-26009` | All four via the `dreamer_classify_outcome` helper |
| `state_sync` (handler) | 4 | `:17542-30357` | |
| note-evaluator registry | 4 | `:23111-23381` | |
| `unbind_route` / `route_gone` | 3 | `:17406-23381` | |
| `session.flush` | 2 | `:27182`, `:27372` | |
| `session.recomp` | 2 | `:27182`, `:27313` | |
| `authority.seed` | 1 | `:25664` | |
| `todo_state.set` | 1 | `:27182` | |
| `session.delete` | 1 | `:27420` | |
| `memory_holder_metrics` | 1 | `:18730` | |

Named tests the lenses use as the nearest existing check, verified by name and
`fn` line at `HEAD`:

| Line | Test | Pins |
| --- | --- | --- |
| `:17422` | `resolve_fails_loud_unbound_and_on_session_mismatch` | The fail-loud binding guard behind the session-identity claim |
| `:17454` | `old_epoch_route_gone_preserves_new_epoch_binding_and_dispatch_state` | `(channel, epoch)` keying of route state |
| `:17496` | `in_flight_snapshot_entries_are_count_bounded_and_cannot_resurrect` | The count bound on the in-flight snapshot map |
| `:18730` | `module_status_memory_metrics_match_budget_accounting_and_falsy_semantics` | Memory metrics against budget accounting, not against reality |
| `:18944` | `transform_dispatch_panic_drop_guard_decrements_without_completion_stamp` | The `TransformDispatchTicket` unwind guard |
| `:24738` | `opencode_cache_provenance_cannot_rebind_a_second_project_root` | Root-scoped cache provenance |
| `:25110` | `composite_session_keys_scope_lineage_and_do_not_match_child_prefix_suffixes` | Child-prefix **suffix** collisions, not a caller-chosen prefix |
| `:25664` | `authority_seed_bad_middle_row_fails_loudly_without_partial_frame` | The only `authority.*` test that is an assertion target |
| `:25977` | `dreamer_run_task_requires_a_positive_timeout_ms` | The caller-budget deadline |
| `:27013` | `state_import_batch_gap_and_staleness_evict_partial_attempts` | The import reaper, reached only by forcing `stale_after` to `Duration::ZERO` by hand at `:27055` |
| `:27182` | `management_todo_flush_and_recomp_contracts_are_replay_safe` | Sends an identical `todo_state.set` twice and asserts `{"ok": true}` both times. The only written statement of that contract |
| `:27313` | `session_recomp_resets_cache_boundary_and_replays_started` | The reset and the `started` replay, not the second write |
| `:27420` | `session_delete_clears_durable_state_for_the_bound_lineage` | One delete against a populated session |
| `:30037` | `status_diagnostics_surface_pending_historian_side_channel_failure` | The operator surface for a failed side-channel drain |

### Handlers and helpers in scope with zero test-module references

Re-counted at `HEAD` by matching each identifier or method literal across the
whole file and again over `:16001-30517` only.

| Target | Occurrences in file | In the test modules |
| --- | --- | --- |
| `handle_transform_page_value` (`:9335-9578`, 244 lines) | 2 | **0** |
| `apply_state_sync_wire` (`:9127-9333`, 207 lines) | 3 | **0** |
| `handle_authority_prepare_value` (`:7169-7265`) | 2 | **0** |
| `handle_authority_drain_value` (`:7320-7427`) | 2 | **0** |
| `"authority.prepare"` | 6 | **0** |
| `"authority.drain*"`, 11 dispatch arms (`:12257-12267`) | 12 | **0** |
| `"authority.status"` | 2 | **0** |
| `"mirror.pull"` | 3 | **0** |
| `transform_page_id`, `transform_page_index` | 4, 4 | **0**, **0** |
| `transform_generation`, `assemble_transform_page*` | 4, 4 | **0**, **0** |
| `discard_transform_pages*` | 18 | **0** |
| `discard_state_sync_seed` | 9 | **0** |
| `pending_seed_count` | 4 | **0** |
| `evict_stale_collectors` | 2 | **0** |

`prompt_surface.manifest` is not the method name; the dispatch arm at `:12270` is
`"manifest.get"`, which does have 7 test-module references. The correction is
recorded so a later pass does not repeat the miss.

`TransformPageCoordinator` deserves its own note. `transform_page` and
`TransformPage` appear in the test modules on exactly four lines, all inside one
test: `:18751`, `:18768`, `:18773`, `:18833`, within
`module_status_memory_metrics_match_budget_accounting_and_falsy_semantics`
(`:18730-18844`). That test fabricates a `Collecting` phase and a
`CompletedTransformPage` to assert **memory metrics**, then reads
`transform_pages` back. So the coordinator is touched once, as a fixture for a
budget-accounting assertion, and the 244-line handler that drives it has no test
at all.

### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]`: none found.** Zero occurrences in `lib.rs`.

**`should_panic`: 4, all differential-drift guards.** `:20646` and `:20695`
(`"incremental native attachment cache drift"`), `:21116` (`"incremental prefix
projection byte drift"`), `:21159` (`"OpenCode serialization produced duplicate
tool_use ids"`). The first three assert that a deliberately corrupted cache key or
frontier is caught by a differential assertion, and two of the three caches
involved are in 4c scope. They are the only tests in the file whose oracle is a
panic rather than a value comparison.

**Property, mutation and concurrency tooling: none found.** Zero occurrences of
`proptest`, `quickcheck`, `loom`, `shuttle`, or `miri` in `lib.rs`. No
`mutants.toml`. No coverage configuration, so every placement statement in this
file is structural rather than measured. `.config/nextest.toml` carries overrides
for `mc-host`'s `shm_failure_modes` and `shm_soak` binaries only, so no
`mc-module` test is serialized, grouped, or timeout-adjusted. The three staging
protocols are multi-request state machines with phase enums, caps, and TTLs, and
every check on them is a hand-written fixture case.

## The TypeScript senders are CI-gated and the Rust receivers are not

That asymmetry is the finding, and it is sharper here than in 4b. `ci.yml:257`
runs `bun run test`, which is `sh scripts/test-shard.sh packages/plugin` plus its
siblings per root `package.json`, sweeping every `*.test.ts` under the plugin
tree. Two files own these operations on the TypeScript side.

| File | Tests | Tests this Rust code? |
| --- | --- | --- |
| `packages/plugin/src/hooks/magic-context/module-state-sync.test.ts` | 38 | **No.** Asserts the request shape the TypeScript sender emits and drives a TypeScript store. It installs a stub transport object at `:478` and inspects captured bodies, then asserts on the recorded method list at `:500-501`. Its storage side is the plugin's own modules plus `createDirectTestDatabase` (`:37`). No Cargo target is invoked |
| `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts` | 77 | **No.** Uses `mock` and `spyOn`. It owns the paging contract on the sender side, with **9 references to `transform_page_id`**, including `:1680-1686` asserting the set of page ids in captured bodies. It proves the sender pages; it never observes the Rust coordinator |

**The host e2e suite runs in TypeScript mode only, and says so.**
`ci.yml:658` `e2e-host-opencode` sets `MC_E2E_MODE: ts` (`:714`), and the step
comment at `:719-721` states: "Rust is intentionally absent from public CI because
its private ../commons and ../subconscious path-deps are not provisioned here; the
local release gate runs that host group." `e2e-host-pi` (`:724`) has the same
shape. So the absence of Rust end-to-end coverage in CI is deliberate and
documented with a named cause, and the compensating gate is a local release gate
rather than CI. `ci.yml:163-164` provisions "metadata-only sibling stubs" via
`scripts/provision-rust-ci-stubs.sh`, which is the same constraint one layer down.

A parallel-implementation pattern also exists here, as 4a found for the historian.
The dreamer, classify and task-executor lanes have TypeScript tests
(`features/magic-context/dreamer/task-executor.test.ts`,
`dreamer/classify.test.ts`) that run under `ci.yml:257`, while the Rust
`handle_dreamer_run_task` has 4 in-crate tests that run nowhere. Whether the two
implement the same contract is an open question, not a resolved one.

## Production assertions and guards, clustered

Measured over production lines only, restricted to the five 4c ranges.

**Runtime assertions: one, and it is compiled out of release.** `:2441`,
`debug_assert_eq!(self.ingress_chunks.len(),
self.ingress_chunk_retained_bytes.len())`, a representation invariant pairing the
native cache's ingress chunks with their retained-byte entries. Absent from
release builds. No named test.

**Compile-time assertions: one, and it is the strongest guard in scope.**
`:2309-2314`, a `const _: () = assert!(...)` requiring
`SERIALIZED_OUTPUT_CACHE_BUDGET_BYTES + NATIVE_ATTACHMENT_CACHE_BUDGET_BYTES +
PROJECTION_CACHE_BUDGET_BYTES <= TRANSFORM_SERVE_CACHE_COMBINED_BUDGET_BYTES`. A
budget change that breaks the aggregate ceiling fails the build rather than
production. It constrains **declared constants**, not observed retention, and the
observed-retention side is documented as approximate:
`docs/native-attachment-incremental-cache-2026-08-10.md:50` says "The limit does
not precisely charge allocator bucket/capacity overhead ... That multiplier is
guidance, not an enforced memory ceiling." One side of the accounting is
compile-time exact and the other is documented as an estimate. `:2816-2818`
concedes the rest: "TODO(memory-accounting): add an active-clone budget for this
`Arc` ... A running transform can retain it after LRU eviction."

**Panicking sites: one.** `:3661`, `panic!("store open worker failed: {error}")`
on a `JoinError` from the `spawn_blocking` in `open_store_once`. No named test.
Zero `unreachable!`, zero `todo!`, zero `unimplemented!`, and zero `.unwrap()`
anywhere in the five ranges.

**`.expect(`: 113, of which 110 are lock-poisoning**, across 36 distinct
hand-written labels. The largest are `"state sync seed mutex"` (8), `"transform
snapshots mutex"` (8), `"transform page mutex"` (8), `"state import mutex"` (7),
and `"bindings mutex"` (6). Each is infallible only while no thread panics holding
that lock, which interacts directly with the finding that the `Applying` phase has
no unwind guard. The three non-mutex expects are `"session.status response is an
object"`, `"historian status serializes as an object"`, and `"classifier output
set"`. None has a named test.

**Unwind guards: ten `impl Drop` blocks, and none covers a staging phase.**
Enumerated at `HEAD`: `StoreOpenWaiterGuard` (`:328`), `TransformDispatchTicket`
(`:497`), `SnapshotLease` (`:1875`), `DreamerRunGuard` (`:3063`),
`DreamCommandGuard` (`:3083`), `StringSetGuard` (`:3097`), `SessionSetGuard`
(`:3121`), `HistorianTriggerTimer` (`:3174`), `WrapupSessionGuard` (`:3210`), and
`McHandler` (`:11919`). The idiom is stated in the code's own comment at
`:479-480`: "A panic skips this method and is handled by Drop, so it cannot
falsely advance the heartbeat." There is no `Drop` for `TransformPagePhase` or for
any coordinator, so the `Applying` phase, released by a plain statement at
`:9554`, is the one piece of per-request accounting in this file that a panic or a
cancellation can strand.

**Discarded results: six `let _` sites, four licensed by a comment and two not.**

| Line | Call | Licensed? |
| --- | --- | --- |
| `:8252` | `store.drain_historian_side_channels(...)` | Partly, `:8249-8250` |
| `:8262` | `store.trace_pass_received(...)` | Yes, `:8258-8260` |
| `:8332` | `store.trace_pass_rejected(...)` | By the same convention, not restated |
| `:8560` | `store.trace_pass_completed(...)` | By the same convention, not restated |
| `:9989` | `store.record_dream_task_command(...)` | **No** |
| `:10028` | `producer.purge_session(...)` | Yes, `:10023-10027` |

The convention at `:8258-8260` ("a rejected pass must still leave a durable
breadcrumb, and a trace failure must never change the transform result") is stated
once and applied four times, and nothing at a call site distinguishes a licensed
discard from an unlicensed one. That is precisely how `:9989` reads as conforming
while sitting on the other half of the contract `:9816-9818` hardens.

**Typed rejection guards: 47 distinct error codes, and this is where the
invariants actually live.** Given one runtime assertion in 7,857 production lines,
every other guarantee in scope is enforced by a `Result` or a typed error code, so
a violated invariant becomes an error code a caller may or may not surface rather
than a loud failure. The staging protocols are densest: 12 `state_sync_seed_*` and
`state_sync_generation_mismatch` codes (`:8686-9324`) and 7 `state_import_*` codes
(`:1456-1585`, `:5631`). The authority lifecycle has 13 (`:3924-9692`). The
most-used are `bad_request` (13 sites), `store_load_failed` (13),
`store_write_failed` (10), and the paired `route_unbound` and `session_mismatch`
(8 each). **`transform_failed` has exactly one site, `:8334`**, so the entire
pass-engine rejection surface collapses to one code at the handler boundary. One
code collides three ways: `dreamer_run_failed` is returned at `:9804` (duplicate
in flight, no ledger row by design), `:9968` (idempotency conflict, no ledger row
by design), and `:9996` (chain exhausted, ledger row attempted and unchecked), so
a caller receiving it cannot tell whether a durable row exists.

**Response fields carrying a semantic promise: 10.** `ok` (28 sites),
`disposition` (4), `duplicate` (3: `:5684`, `:5752`, `:5876`), `staged` (3:
`:5732`, `:9074`, `:9511`), `imported` (2), `queued` (2), `next_expected_index`
(2: `:9075`, `:9512`), `armed` (1: `:5987`), `deleted_rows` (1: `:6154`), `seeded`
(1: `:7316`). `duplicate` is the only explicit idempotency signal in the whole
scope and it appears on two handlers.

**Conventionally-enforced-only claims: seven.** The nine source-text architecture
assertions in `tests/host_adapter.rs:137-173` are the notable set. They read
`include_str!("../src/lib.rs")` and require production not to contain
`HandlerOutcome`, `ModuleHandler`, `tokio::spawn(`, or `task_admission_open`, and
to contain `spawn_gate`, `self.tasks.close()`, `self.cancel.cancel()`,
`self.tasks.wait().await`, and `PreparedOutput::transform_segments`. They are the
only enforcement of the claim at `:2878-2884` that "`cancel` is the single source
of truth for whether admission is open", backed by the fields at `:2885-2887`
(`spawn_gate: Mutex<()>`, `cancel`, `tasks`). They are greps: renaming
`spawn_gate` while preserving behaviour fails the test, and reintroducing a second
admission flag under a different name passes it. The others are the trace-discard
convention, the 36 mutex labels, the `mc_*` and `MC_CHILD_SESSION_PREFIX`
namespace reservations, `bind_authority_route`'s documented skip
(`:4407-4409`, matching the `Ok(())` at `:4417-4419`), `deleted_rows == 0` as an
undocumented repeat marker for `session.delete`, and the `{"ok": true}` collapse
for `todo_state.set` whose only written statement is an assertion inside `:27182`.

## Test support and fault-injection seams

**One seam inside the handlers, and it is test-only.**
`state_sync_before_apply_hook` (field `:2925`, built to `None` at `:3453` and
`:3751`, fired at `:9234`) lets a test run arbitrary code between the state-sync
load and the apply. It is the one place in 4c where an interleaving can be landed
at a chosen point.

**One coordinator knob.** `StateImportCoordinator::stale_after` (`:1346`,
initialised from `STATE_IMPORT_STALE_AFTER` at `:1357`, declaration `:654`,
compared at `:1403`) is settable from a test, which is how `:27013` reaches the
import staleness path: it forces `stale_after = Duration::ZERO` by hand at
`:27055`. That the reaper needs that treatment is itself evidence it does not
self-fire.

**One dead test hook.** `log_transform_page_discard` (`:4003`) pushes into the
`#[cfg(test)]` vector `transform_page_discard_logs` (`:2949`). The field is
written at `:4003` and read nowhere in the file, so the hook exists and no test
consumes it.

**Store-side seams: three, and none of them is a write-failure injector.**
Enumerated across `crates/mc-store/src/lib.rs`:
`fail_next_historian_side_channel_for_test` (`:5249`, used at `lib.rs:30041`),
`set_before_max_compartment_end_read_hook` (`:5283`), and
`set_abandon_historian_hook` (`:5294`), plus the read-only counters
`tag_number_query_count_for_test` (`:6426`) and
`authority_seed_transaction_count_for_test` (`:11992`), the narrow
`execute_tag_sql_for_test` (`:6434`), and two seeders (`:6654`, `:7083`). **There
is no seam that fails `record_recomp_command`, `bind_authority_route`,
`record_dream_task_command`, or `commit_state_import`.** That is the single most
consequential capability gap in this sub-part, because four records turn on a
fault landing on exactly one of those four calls after an earlier write in the
same request has already committed.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The paged-transform protocol is the quietest thing in 4c, and its sender is
   CI-gated.** `handle_transform_page_value` (`:9335-9578`) is **244 lines with
   zero tests**. `transform_page_id`, `transform_page_index`,
   `transform_generation` and `assemble_transform_page*` have zero test-module
   references; `discard_transform_pages*` has 18 occurrences and zero in tests;
   `TransformPageCoordinator` is touched on four lines of one test as a
   memory-metrics fixture. Meanwhile the TypeScript sender carries **nine
   CI-gated `transform_page_id` assertions** in `rust-mode-transform.test.ts`.
   Paging is default-production, not opt-in: `module-wire.ts:20` sets
   `MODULE_PAGE_MAX_BYTES = 512 * 1024`, `:1097` returns an unpaged body only
   below it, and `:1131` stamps `transform_page_id` above it, and the Rust side
   dispatches on field presence at `lib.rs:7985-7986` with no config gate. So the
   sender's half of the contract is enforced on every pull request and the
   receiver's 244 lines are enforced nowhere. This is also the coordinator with
   five separate lens B findings against it: no reaper, no map-removal path
   (`:1131-1144` contains no `remove`), a pending cap bypassed by any known
   session (`:1186-1190`), an uncharged `completed` slot, and no unwind guard.
   Five findings on the one structure with no tests.
2. **`apply_state_sync_wire` has zero tests and it is the durable write.** 207
   lines (`:9127-9333`) containing the `expected_shadow_seq` sequence fence, the
   historian-phase pre-check, the `AuthoritySeqMismatch` and `HistorianBusy` arms,
   and the note-evaluation capability effect. Four tests reach
   `handle_state_sync_value`; **none names the function that writes.** The fence
   is also what a restart record depends on to bound double application, so the
   one mechanism holding that argument up is untested.
3. **The authority lifecycle has zero test references across prepare, drain and
   status, including all eleven drain arms.** `handle_authority_prepare_value`
   (`:7169-7265`), `handle_authority_drain_value` (`:7320-7427`) and
   `handle_authority_status_value` (`:7134-7167`) span `:7134-7427`, 294 lines,
   and none of the three appears in the test modules. Neither do
   `"authority.prepare"`, `"authority.status"`, or any of the **11**
   `"authority.drain.*"` dispatch arms (`:12257-12267`, re-counted at `HEAD`).
   `authority.seed` has exactly one test, `:25664`. This is the surface carrying
   the two caller-supplied-checksum findings and the second-transaction finding,
   and `bind_authority_route`, the second transaction itself, has zero assertions
   against it despite 22 tests using it as setup.
4. **`docs/AUDIT-KNOWN-ISSUES.md` tracks none of this.** The file runs to 52+
   numbered entries and contains **zero occurrences of `mc-module` or `crates/`**;
   its apparent "rust" matches are substrings of "trust". Every entry analyses the
   TypeScript implementation, including four direct analogues of 4c concerns: A27
   (historian lease atomicity), A33 (dreamer drain dedup-guarded rather than
   lease-locked), A24 (transform wrapper fails open), and A4 with A29 (dreamer
   authority scope). So the repository has a mature accepted-issues register for
   one implementation of these contracts and none for the other, in a file whose
   own framing instructs auditors not to re-report what it lists.
5. **Two handlers commit two transactions each and neither pairing has a test.**
   `session.recomp` resets at `:6077` and records the command at `:6114`, and has
   2 tests, neither faulting the second write. `authority.prepare` transitions at
   `:7187-7239` and binds the route at `:7250` (`if row.state == "MODULE"` at
   `:7248`), and has none at all. The ordering is unstated in the code and
   unasserted in the tests, so nothing would notice if it were swapped.
6. **One runtime assertion in 7,857 production lines, and it is a
   `debug_assert!`.** `:2441` is the only one and it is compiled out of release.
   The only unconditional assertion in scope is the compile-time `const _` at
   `:2309`. Compare 4a, which found the same shape in `historian.rs`, and 4b,
   which found its strongest drift check compiled out while a weaker twin shipped.
7. **The one panic site has no test.** `:3661`, `panic!("store open worker
   failed")` on a `JoinError`. Six tests cover store open; none constructs a
   worker panic or cancellation that reaches this line.
8. **`discard_state_sync_seed` and `pending_seed_count` are unobserved.** 9 and 4
   occurrences respectively, zero in the test modules. The seed discard path is
   called from the seed handler's own error arms and from `unbind_route`, and no
   test reads either the discard or the counter that is never incremented.
9. **Three integration tests exercise 4c against a real handler and run
   nowhere.** `direct_host.rs:67`, `direct_host.rs:149` and `host_adapter.rs:102`
   are genuine end-to-end checks, one of them across a process restart, and CI
   runs neither binary. `direct_host.rs` additionally builds an example binary at
   test time (`tests/support/direct_host.rs:40-47`), so it is the most expensive
   suite to adopt and currently the highest-value one unadopted.
10. **`mirror.pull` and the projection-cache TODO.** `handle_mirror_pull_value`
    (`:7429-7449`) has zero tests, though Part 3 owns mirror receipt semantics and
    the boundary should be confirmed before treating it as a 4c gap. Separately
    `:2816-2818`'s `TODO(memory-accounting)` names a known hole in the declared
    retained-byte total, and the test that would catch it, `:18730`, asserts the
    metrics match the accounting rather than reality.
11. **No property, mutation or concurrency tooling anywhere in scope, over three
    multi-request state machines.** Zero `proptest`, `loom`, `shuttle`, `miri`,
    `quickcheck`; no `mutants.toml`; no coverage configuration; no `mc-module`
    entry in `.config/nextest.toml`. The three staging coordinators have phase
    enums, byte caps, pending caps and TTLs, and every check on them is a
    hand-written fixture case.
12. **36 hand-written mutex labels with no consistency check.** A mislabelled lock
    produces a misleading panic and no test notices. Low consequence, listed
    because the count is large and the enforcement is zero.

## Sampling limits on this inventory

Five limits, stated so a later pass does not read absence as absence of risk.

- **The three-tier attribution brackets rather than pins.** 212 / 120 / 69 comes
  from symbol matching plus a helper fixpoint over parsed test bodies, not from
  coverage instrumentation, which this repository does not have. The final
  subtraction of 51 uses test names, so the 69 is approximate at the edges. The
  256 attribute count, the two module-opening lines, and every per-cluster count
  were obtained directly at `HEAD`.
- **The 82 transform-handler tests are shared evidence, not 4c evidence.** They
  reach `handle_transform_unpaged_value` and assert 4b engine behaviour. Whether
  any of their assertions should be claimed by 4c is left open rather than
  decided; they are listed so a reader counting 4c coverage does not mistake reach
  for claim.
- **Two of the three named integration binaries are counted as coverage of the
  handlers, and one is explicitly not.** `prepared_output.rs` tests `dispatch.rs`,
  which the scope map assigns to 4d. If a later pass moves the dispatch boundary,
  its 10 tests move with it.
- **Scope is contested at two edges.** `handle_mirror_pull_value` (`:7429-7449`)
  sits inside the 4c range `:7134-8005` while the scope map assigns mirror receipt
  semantics to Part 3. The claim-intent ledger handlers sit at `:10082-10182`, just
  above the 4c ceiling of `:10040`, in 4d's range, which is why no handler in
  scope can use them. Both boundaries need a sibling synthesis to settle.
- **Whether a never-executed test counts as `Exercised: partial` is unresolved.**
  It governs every `Existing check:` line in this part. Three in-crate tests and
  three integration tests are the only checks here that could ever be called
  "covered", and none executes in CI. All three lenses raise it and the scope
  map's own open question on the ruling is still open.
