# Part 4 scope map and risk ranking

Scoping pass only. No property records, no fixes, no source or CI edits. The
deliverable is the sub-partition plan and the region maps that let later lens
passes cite line ranges without re-reading two 30k-line files.

Provenance: `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `dde0c051` ("feat(doctor):
report mandatory ring health"). Method contract in [../../METHOD.md](../../METHOD.md).

Every line reference below was produced by a brace-balanced scan of the file at
`HEAD` and the region endpoints were then read back individually. Where a
reference is approximate it says so.

## Size accounting, corrected

The 102,515-line figure in the task is right, and it hides the single most
important fact about this crate: **47 percent of it is inline test code.**

| Bucket | Lines |
| --- | --- |
| `src/` production | 52,599 |
| `src/` inline `#[cfg(test)] mod` | 46,823 |
| `src/bin/` (all production) | 2,990 of the above production figure |
| `tests/` integration binaries | 2,379 |
| `examples/direct_host_fixture.rs` | 714 |
| **Total** | **102,515** |

The two monoliths split as follows, measured not estimated:

| File | Total | Inline test | Production |
| --- | --- | --- | --- |
| `src/lib.rs` | 30,517 | 14,516 | 16,001 |
| `src/transform.rs` | 29,439 | 16,971 | 12,468 |

So the real discovery surface is about 52.6k lines of production Rust, and there
are 938 test functions in the crate. That reframes the partition problem: sized
by production lines, five or six sub-parts land inside the 5k-to-15k band
naturally. Sizing below is given in total lines, because a discovery pass reads
the adjacent tests too, with the production share noted where it matters.

## What this crate does

`mc-module` is the Magic Context component that plugs into `mc-host` as its
primary lifecycle component. Its job is to keep a coding agent's conversation
inside a provider context window without busting the provider's prefix cache,
and to persist the compressed history so the next session can use it.

A **transform** is one pass of the CK-in / CK-out rewrite. The module receives
the harness's already-decoded CK message array and emits a rewritten array
described by the file's own header as `pass_output.ck_messages = [m0, m1] ++
tail` (`src/transform.rs:1-15`). The covered prefix of the conversation is
replaced by two synthesized region blocks: `m0`, a cumulative baseline frozen
between HARD folds, and `m1`, a volatile delta re-rendered on SOFT passes. Every
message after the coverage watermark is carried through verbatim as the live
tail. The cache discipline is the load-bearing part: byte-complete units are
rendered only on bust passes and replayed verbatim on defer, and a pure defer
writes nothing. The module owns the render and the splice; `mc-core` stays a pure
classifier and `cortexkit-cache-core` freezes whatever rendered units it is
handed.

The header also states two paired poison-resistance invariants, which are claims
under test rather than established facts: synthetic items are stripped before any
boundary, coverage, or tail computation (primary), and the `mc_*` id namespace is
reserved so a synthetic block can never masquerade as the real boundary
(backstop).

The **historian** is the writer subsystem that produces the compressed history in
the first place. `src/historian.rs:1-7` describes a durable firing state machine
`idle -> firing -> awaiting_producer -> validating -> publishing`, a pinned
ordinal-range chunk snapshot with fail-loud fingerprint verification, and a
CAS-gated publish transaction whose writes surface only through the `m1`
watermark on the next materializing pass, so a publish never mutates cached
render state directly. `historian_chunk.rs` builds the pinned chunk,
`historian_prompt.rs` assembles the per-run prompt, `historian_producer.rs` is
the Broca session client that calls out to a language model through
`mc_host::Client`, and `historian_validate.rs` parses the model's compartment XML
and validates it against the raw chunk and the already-persisted compartment
ranges "before any side effect can publish it"
(`src/historian_validate.rs:1-10`).

**Selection** is tail-reduction selection: which live tail items to reduce, and
the `ReductionDecision`s that the freeze/replay mechanics then act on
(`src/selection.rs:1-10`). It is documented as a pure deterministic function over
the flat block-granular typed tail, and determinism is stated as the cache
invariant, because the same inputs must yield byte-identical freeze and replay.

**Boundary** decides two things purely from the in-memory tail: where the
compactable/protected split sits, and whether a historian run should fire
(`src/boundary.rs:1-9`). The header claims no I/O, no wall clock, no store
access, and no ambient cache state.

**Tail hygiene** is the shared rendered-tail metric that feeds the module's
Channel-1 and Channel-2 nudges (`src/tail_hygiene.rs:1`). It measures the
rendered tail so the nudge machinery can tell the agent how many tokens are
reclaimable.

**Smart note evaluation** is a Rust port of a TypeScript reducer for the
smart-notes lifecycle, plus a vendored five-field cron evaluator
(`src/smart_note_evaluation.rs:1-11`). Both implementations replay the frozen
fixture `testdata/smart-note-evaluation-golden.json` so lifecycle behavior cannot
drift between languages. The header claims pure functions throughout.

### Who owns persistent state and who is pure

State-owning, in rough order of how much durable damage each can do:

- **Historian publish** (`historian.rs`, `historian_validate.rs`,
  `historian_chunk.rs`) writes compartments, chunk ranges, and durable phase
  state through `mc-store`. This is where raw conversation content is replaced by
  model-generated summary text.
- **`McHandler`** (`lib.rs:3398-11917`) owns every store write on the request
  path: state sync, state import, agent drops, todo state, session recomp and
  delete, wrapup, claim mirror, note evaluation claims, and the cache-state
  commit behind a transform.
- **`apply_once`** (`transform.rs:3222-5697`) computes the new cache state and
  the frozen unit set that the final compare-and-swap accepts or rejects.
- **In-process caches with their own eviction and budget accounting**, all in
  `lib.rs`: transform snapshot, boundary token, native attachment, projection.
  Plus `transform.rs`'s serialized-output cache, tag baseline cache, and tag mint
  frontier cache. These are not durable, but a stale hit produces wrong bytes.

Documented as pure computation: `selection.rs`, `boundary.rs`,
`compartment_coverage.rs`, `scheduler.rs`, `historian_validate.rs`,
`historian_prompt.rs`, `injection.rs`, `smart_note_evaluation.rs`,
`decay_render.rs`, `m0_compose.rs` (pure given the store read),
`project_docs.rs`. Purity here is a claim in a doc comment, so it is exactly the
kind of statement a lens pass should try to refute rather than assume.

## lib.rs region map (line ranges)

30,517 lines. Production is `1-16001`; everything from `16002` on is test code
except the small `#[cfg(test)]` islands noted inline.

| Range | Lines | Region |
| --- | --- | --- |
| `1-37` | 37 | Crate doc and the 31 `pub mod` / `mod` declarations |
| `39-57` | 19 | `pub mod release_contract` and `pub mod production_inputs`, both `include!` of generated files under `release/generated/` |
| `59-137` | 79 | `use` block. `#[cfg(test)]`-only imports at `:85`, `:123`, `:126`, `:129`, `:132`; `pub mod test_support` at `:130`; `mod differential_goldens` at `:133` |
| `139-158` | 20 | `ClaimMirrorSnapshotRequest`, `ClaimMirrorReceiptRequest` wire structs |
| `160-246` | 87 | `SessionBinding`, `apply_claude_code_config_controls` (`:173-194`), `host_mural_artifact` (`:197-213`), `cc_mural_input` (`:216-232`), `BindingError` |
| `248-351` | 104 | Store-open coordination: constants, `StoreOpenPolicy`, `StoreOpenCoordinator` (`:286-322`), `StoreOpenWaiterGuard` + `Drop` (`:324-332`), `jittered_store_open_delay`, `store_open_error_is_live_lease` |
| `353-508` | 156 | Dispatch health and the transform wedge detector: `DispatchHealth` (`:361-446`), `static DISPATCH_HEALTH` (`:448`), `TransformDispatchTicket` (`:456-495`) and its `Drop` (`:497-508`) |
| `510-594` | 85 | Render/format epoch constants and the `const fn` epoch predicates: `profile_render_epoch` (`:550`), `cc_u1_active` (`:562`), `tagging_surface_active` (`:568`), `tagger_feature_epoch` (`:580`), `state_sync_epoch_compatible` (`:592`) |
| `596-669` | 74 | Default and budget constants: protected tags, commit clusters, historian chunk tokens, state-sync seed caps, transform-page caps, snapshot and projection cache budgets, snapshot lease caps, wrapup margin. `#[cfg(test)]` consts at `:598`, `:610` |
| `671-827` | 157 | State-sync wire types: `ModuleStateSyncWire` (`:681-751`) and the seven seed wire structs (`:754-803`), plus `state_sync_seq_mismatch_error`, `historian_compartment_sync_busy_error` |
| `829-890` | 62 | `TransformLane`, `StateImportWire`, `StateImportCompartmentWire` + impl |
| `892-1020` | 129 | State-sync seed staging: `PendingStateSyncSeed`, `StateSyncSeedPhase`, `CompletedStateSyncSeed`, `StateSyncSeedSession`, `StateSyncSeedCoordinator` (`:957-1020`) |
| `1022-1320` | 299 | Transform-page staging: `PendingTransformPage`, `TransformPagePhase`, `CompletedTransformPage`, `TransformPageSession`, `TransformPageCoordinator` (`:1107-1320`) with `TransformPageStageAction` / `StageError` |
| `1322-1622` | 301 | State-import staging: `PendingStateImport`, `StateImportPhase`, `StateImportCoordinator` (`:1380-1622`) with its stage outcome and error enums |
| `1624-1705` | 82 | Compartment and workspace wire structs, `FacadeScope`, `From<ModuleCompartmentWire> for StoredCompartment` (`:1683-1705`) |
| `1707-1846` | 140 | `impl TransformRequest` (the `lib.rs`-side construction helpers, distinct from the type in `transform.rs`) |
| `1848-1904` | 57 | `TransformSnapshot`, `SnapshotLeaseBudget`, `SnapshotLease` + `Drop` (`:1875-1881`), `TransformSnapshotLookup`, `TransformSnapshotCache` struct |
| `1906-2079` | 174 | `impl TransformSnapshotCache`: snapshot lease acquisition, budget accounting, eviction |
| `2082-2292` | 211 | Boundary token cache: entry, `BoundaryTokenCacheSnapshot` (`:2099-2192`), retained-bytes accounting, session, `impl BoundaryTokenCache` (`:2222-2292`) |
| `2295-2715` | 421 | Native attachment cache: delta frontier, context, encoded chunk, `NativeDeltaFallbackReason` (`:2364-2384`), stats, `NativeAttachmentCacheSnapshot` (`:2418-2544`), `impl NativeAttachmentCache` (`:2573-2715`) |
| `2718-2869` | 152 | Projection cache: context, `ProjectionCacheSnapshot` (`:2737-2765`), session, `impl ProjectionCache` (`:2792-2869`) |
| `2873-2960` | 88 | `pub struct McHandler`, the handler's whole field set |
| `2962-3020` | 59 | Note-evaluator registry types: `NoteEvaluatorRegistration`, `NoteEvaluatorSlotCycles`, `new_note_evaluator_slot_cycles` |
| `3023-3104` | 82 | `pub trait HistorianProducerFactory` (`:3023-3030`), `RealHistorianProducerFactory` + impl (`:3038-3054`), `MissingProducerFactory`, `DreamerRunGuard`, `DreamCommandGuard`, `StringSetGuard`, each with `Drop` |
| `3106-3396` | 291 | Historian and wrapup orchestration types: `LiveHistorianCompletionWait` alias (`:3106`), `LiveHistorianSession`, `SessionSetGuard` + `Drop`, `PreparedHistorianFiring`, `HistorianPrepareContext`, `HistorianTriggerTimings`, `HistorianTriggerTimer` + `Drop`, `WrapupPrepareContext`, `LiveWrapupSession`, `WrapupSessionGuard` + `Drop` (`:3198-3220`), `PreparedWrapupAction`, `TerminalWrapupResponse`, `WrapupFiringError`, `RetryableWrapupReason`, `WrapupSnapshotPublicationFence` impl (`:3296-3322`), `ReattachSnapshotPublicationFence` impl (`:3332-3359`), `HistorianFiringTask`, `SchedulerObservation`, `impl HistorianProducerFactory for MissingProducerFactory` (`:3382-3396`) |
| **`3398-11917`** | **8,520** | **`impl McHandler`, 131 methods.** Sub-map below |
| `11919-11932` | 14 | `impl Drop for McHandler`, `impl Default for McHandler` (`:11928`) |
| `11934-12115` | 182 | `impl CompositeComponent for McHandler` |
| `12117-12142` | 26 | `impl PrimaryComponent for McHandler`, then `PreparedSettlement<W>` |
| `12144-12222` | 79 | `settle_prepared_with` (`:12150-12205`) and `settle_prepared` (`:12207-12222`) |
| `12224-12324` | 101 | Second `impl McHandler` block |
| `12326-12428` | 103 | Request-shape helpers and canned errors: `has_transform_page_fields`, `transform_page_error`, `unrecognized_request_error` (`:12352-12376`), `json_type_name`, `now_ms`, profile errors, `attach_native_messages` |
| `12430-12447` | 18 | `#[cfg(test)] fn message_tag_numbers` |
| `12450-12757` | 308 | Native attachment plumbing: cache key modes, `attach_native_messages_with_tags`, contexts, `validated_projection_cache_input` (`:12517-12548`), `validated_native_prefix`, `native_sidecar`, digests, `native_message_key` (`:12599-12630`), `native_reasoning_should_clear`, `encode_full_native_messages` (`:12659-12702`), `native_ingress_chunks` (`:12704-12748`), differential flag |
| `12760-13055` | 296 | `attach_native_messages_incremental`. The incremental native delta path |
| `13058-13202` | 145 | `finalize_native_messages_response` (`:13058-13131`), state-import validation error, passthrough and need-full-sync responses, `classify_attempt_timeout`, `length_capped_or_invalid`, `replay_dream_task_response` |
| `13229-13337` | 109 | `#[cfg(feature = "drive-fault")]` block: `DriveFault`, `parse_drive_fault`, `parse_drive_fault_count`, `DRIVE_FAULT_REMAINING`, `drive_fault`, `apply_drive_fault` (`:13294-13337`). Absent from a default build; the Cargo manifest states that absence is the dormancy proof |
| `13339-13473` | 135 | `respond_transform` (`:13339-13441`), `emit_pass_timing`, `respond`, `guidance_bytes_for` |
| `13475-13514` | 40 | `primary_language_directive` |
| `13516-13789` | 274 | Content digests and page reassembly: `state_sync_seed_content_digest`, `canonical_object_fields`, `transform_page_content_digest`, `transform_continuation_chunk`, `assemble_transform_page_field` (`:13587-13659`), `assemble_transform_pages` (`:13661-13699`), `assemble_state_sync_seed` (`:13701-13784`), `sha256_hex` |
| `13791-13880` | 90 | MCP result helpers and the canned error surface: `mcp_text_result`, `tool_error_result`, `session_unresolved_error`, `authority_draining_error`, `store_error_is_authority_draining`, `authority_request_key`, `invalid_params_error`, `store_unavailable_error`, `claim_mirror_error` (`:13844-13857`), note-evaluation errors |
| `13885-14277` | 393 | Note-evaluation wire parsing and outcome application: field extractors, `smart_note_selection_snapshot`, `note_evaluation_acquire_response` (`:13990-14047`), `parse_note_evaluation_wire_outcome` (`:14051-14110`), `parse_note_evaluation_wire_artifact` (`:14112-14172`), `smart_note_check_digest`, `apply_note_evaluation_outcome` (`:14193-14277`) |
| `14279-14391` | 113 | Request byte caps: `RequestMethodProbe` + impl (`:14297-14305`), `value_footprint_bound` (`:14329-14357`), `request_too_large_error`, `resident_capacity_error`, `enforce_request_byte_cap` (`:14375-14391`). `#[cfg(test)]` const at `:14393` |
| `14393-14517` | 125 | Test-only caps then argument extraction: `validate_string_cap`, `facade_arguments`, `string_arg`, `non_empty_string_arg`, `i64_arg`, `note_condition_compile_args`, `usize_arg`, expand-output truncation helpers |
| `14519-15055` | 537 | Facade expand rendering: message expand, cached expand, `render_range_expand` (`:14625-14674`), durable range expand (`:14679-14778`), `slice_expand_transcript`, verbose range expand (`:14811-14963`), `render_verbose_transcript_range_expand` (`:14968-15034`), ordinal-span parsing |
| `15057-15242` | 186 | `render_notes` (`:15057-15163`), `parse_tag_range_string` (`:15165-15210`), `parse_tag_integer`, `command_id_from_agent_drops_request` |
| `15246-15445` | 200 | Facade response and canonicalization: `command_id_from_facade_request`, `facade_text_response`, `facade_command_outcome`, `refuse_conditioned_note_without_evaluator`, `canonical_value` (`:15341-15372`), `canonical_number`, text formatting and sanitizing helpers |
| `15447-15736` | 290 | Status and boundary summary: `storage_versions_block`, `historian_status_summary`, wrapup/boundary message helpers, `cached_boundary_messages` (`:15515-15577`), `sel_kind_for_flat`, `usage_numbers` (`:15596-15623`), `projected_post_drop_percentage` (`:15629-15690`), `project_slug`, `record_historian_connect_failure` (`:15700-15736`) |
| `15738-15991` | 254 | Descriptors, tool descriptions, JSON schemas, and the manifest: `resolve_descriptor` (`:15740`), `dev_descriptor`, `dev_descriptor_at` (`:15763`), four `ctx_*` descriptions, `ctx_memory_schema` (`:15790-15924`), `ctx_search_schema`, `ctx_expand_schema`, `ctx_note_schema`, `manifest` (`:15977-15991`) |
| `15993-15999` | 7 | `#[cfg(test)] fn test_route` |
| **`16001-30279`** | **14,279** | **`#[cfg(test)] mod tests`.** Flat, no inner modules. 248 test functions: 75 `#[test]`, 173 `#[tokio::test]` |
| **`30281-30517`** | **237** | **`#[cfg(test)] mod release_contract_tests`.** 8 `#[test]` |

### `impl McHandler` sub-map (`lib.rs:3398-11917`)

131 methods. Grouped by contiguous run; every range below was measured, not
inferred from names.

| Range | Lines | Group |
| --- | --- | --- |
| `3399-3496` | 98 | Construction and task spawning: `new`, `new_with_connection_file` (`:3403-3472`), `store`, `spawn_tracked_task`, `spawn_module_task` |
| `3498-3672` | 175 | Store open: `begin_store_open` (`:3498-3541`), `run_store_open` (`:3543-3655`), `open_store_once`, `set_store_open_policy_for_test` |
| `3676-3770` | 95 | Producer-factory injection seams: `with_producer_factory`, `..._and_config`, `..._config_resolver` |
| `3775-3826` | 52 | `bind_route` |
| `3828-3976` | 149 | Note-evaluator registry: capability set/clear, expiry purge, per-channel removal, `has_live_note_evaluator`, `live_note_evaluator_policy`, `resolve_note_evaluator_project`, `validated_note_evaluator_registration`, `mint_note_evaluator_credentials` |
| `3978-4030` | 53 | Seed and page discard: `discard_state_sync_seed`, `refresh_oldest_queued_at_ms`, `log_transform_page_discard`, `discard_transform_pages_for_route`, `discard_transform_pages` |
| `4032-4230` | 199 | Projection cache and tail delta: `expand_transform_tail_delta` (`:4032-4128`), `lookup_projection_cache`, `lookup_full_projection_cache`, `cached_expand_messages`, `store_projection_cache` (`:4178-4221`), `transform_page_in_progress` |
| `4233-4298` | 66 | `unbind_route`. Route teardown and the state it must release |
| `4305-4425` | 121 | Binding resolution: `resolve_binding`, `state_sync_binding`, `facade_binding`, `module_knows_transform_session` (`:4357-4405`), `bind_authority_route` |
| `4427-4532` | 106 | Config, activity, and guidance clock: `effective_config`, `historian_active`, `wrapup_active`, `observed_last_response_at_ms`, `record_response_observation`, `guidance_now_ms`, guidance date helpers, `set_guidance_now_ms_for_test` |
| `4536-4541` | 6 | `#[cfg(test)] inject_reductions_for_test` |
| `4543-4612` | 70 | Session claims: `live_historian_completion_wait`, `try_claim_live_historian_session` (`:4556-4581`), `try_claim_recomp_session`, `try_claim_wrapup_session` |
| `4614-4806` | 193 | `maybe_spawn_reattach` |
| `4808-5184` | **377** | `prepare_historian_fire`. The historian trigger decision |
| `5186-5303` | 118 | `prepare_wrapup_fire` |
| `5305-5336` | 32 | `refresh_historian_diagnostics`, `record_no_fire` |
| `5338-5443` | 106 | Historian firing execution: `execute_historian_firing_task` (`:5338-5394`), `run_historian_firing_inline`, `await_live_historian_completion` |
| `5445-5589` | 145 | Wrapup budget and firing: `wrapup_operation_budget`, `unknown_module_retry_delay`, `remaining_wrapup_budget`, `run_wrapup_firing` (`:5477-5557`), `await_wrapup_historian_completion`, `spawn_historian_firing` |
| `5591-5774` | 184 | `handle_state_import_value` |
| `5776-5890` | 115 | `handle_agent_drops_value` |
| `5892-5993` | 102 | `management_binding`, `handle_todo_state_set_value`, `handle_session_flush_value` |
| `5995-6161` | 167 | `handle_session_recomp_value` (`:5995-6124`), `handle_session_delete_value` |
| `6163-6429` | 267 | `handle_session_status_value` |
| `6431-6592` | 162 | Wrapup response shaping: `wrapup_snapshot_is_current`, `retryable_wrapup_response`, `terminal_wrapup_response` (`:6461-6569`), `replayed_wrapup_response` |
| `6594-7132` | **539** | `handle_session_wrapup_value`. The largest single method in the crate |
| `7134-7427` | 294 | Authority lifecycle: `handle_authority_status_value`, `handle_authority_prepare_value` (`:7169-7265`), `handle_authority_seed_value`, `handle_authority_drain_value` (`:7320-7427`) |
| `7429-7449` | 21 | `handle_mirror_pull_value`, `freeze_prompt_surface_selection` |
| `7451-7605` | 155 | Prompt surface: `prompt_surface_selection_from_value` (`:7472-7556`), `handle_prompt_surface_manifest_value` |
| `7607-7764` | 158 | `handle_guidance_value` (`:7607-7723`), `guidance_date_for_session` |
| `7766-7976` | 211 | `memory_holder_metrics` (`:7766-7886`), `handle_status_value` (`:7888-7976`) |
| `7978-8005` | 28 | `handle_transform_dispatch`, `handle_transform_value` |
| `8007-8615` | **609** | `handle_transform_unpaged_value`. The main transform request path |
| `8617-8640` | 24 | `state_sync_seed_now`, `handle_transform_for_test` |
| `8642-9333` | 692 | State sync: `handle_state_sync_value` (`:8642-9125`), `apply_state_sync_wire` (`:9127-9333`) |
| `9335-9578` | 244 | `handle_transform_page_value` |
| `9580-10040` | 461 | Dreamer: `register_dreamer_run`, `unregister_dreamer_run`, `dreamer_run_registered`, `handle_dreamer_run_task` (`:9605-10040`) |
| `10042-10060` | 19 | `handle_facade_value`. Facade dispatch entry |
| `10068-10182` | 115 | Claim intent: `claim_route_root`, `handle_claim_intent_stage`, `handle_claim_intent_inspect`, `handle_claim_intent_ack` |
| `10184-10337` | 154 | Claim effects and mirror: `handle_claim_effects_apply` (`:10184-10255`), `handle_claim_mirror_replace` (`:10257-10297`), `handle_claim_mirror_apply` (`:10299-10337`) |
| `10339-10480` | 142 | Facade scope: `log_missing_facade_command_id`, `bind_facade_route_for_write`, `resolve_facade_scope` (`:10387-10480`) |
| `10482-10878` | 397 | The four `ctx_*` facades: `handle_ctx_reduce_facade` (`:10482-10588`), `handle_ctx_memory_facade` (`:10590-10697`), `handle_ctx_search_facade` (`:10699-10759`), `handle_ctx_expand_facade` (`:10761-10878`) |
| `10880-11481` | 602 | Note-evaluation protocol: `register` (`:10880-10980`), `heartbeat` (`:10982-11052`), `unregister`, `next` (`:11097-11276`), `renew`, `complete` (`:11334-11407`), `abandon`, `note_evaluation_claim_scope` |
| `11483-11916` | 434 | `handle_note_delivery_value` (`:11483-11545`), `handle_ctx_note_facade` (`:11547-11916`) |

## transform.rs region map (line ranges)

29,439 lines. Production is `1-12623`; `12625-29439` is the test module.

| Range | Lines | Region |
| --- | --- | --- |
| `1-16` | 16 | Module doc: the `[m0, m1] ++ tail` contract, the render-on-bust cache discipline, the two poison-resistance invariants |
| `17-129` | 113 | `use` block, `static M1_PENDING_LOG_BUCKETS` (`:126`), `static EMERGENCY_REASONING_EXCLUSIONS` (`:127`) |
| `132-139` | 8 | `emergency_reasoning_exclusion_count`, `#[cfg(test)] reset_emergency_reasoning_exclusion_count` |
| `141-324` | 184 | `ServedMessage`: the served output wrapper. Struct, `impl` (`:165-257`), `served_message_retained_bytes`, `Deref`, two `PartialEq`, `Serialize`, `Deserialize` |
| `327-502` | 176 | Serialized-output cache: entry, snapshot, stats, session, `SerializedOutputCache` + `Default` + `impl` (`:366-482`), `log_pending_m1_delta` |
| `504-651` | 148 | Small contract types: `M1Content`, `ReductionDecision`, `LegacyCkItemWire`, `ProducerContext` (`:548-608`), `ClaimLaneWire`, `DeclaredTrim`, `TransformGeometry`, `TrimMismatch`, `BoundaryState` + impl. `#[cfg(test)]` island at `:504` |
| `653-895` | 243 | `pub struct TransformRequest` (`:660-855`) and its ten serde default/skip helpers |
| `898-1097` | 200 | `struct TransformRequestWire` (`:898-1007`), the custom `impl<'de> Deserialize for TransformRequest` (`:1009-1077`), `legacy_item_to_message`. This is the untrusted-input decode seam |
| `1101-1138` | 38 | Response enums and directive types: `TransformStatus`, `ServedFrom`, `SurfaceState`, `Channel2NudgeDirective`, `Channel2Directive`, `HostDirectives` |
| `1145-1443` | 299 | Timing: `TransformTimings` (`:1145-1312`), `format_pass_timing_line` (`:1317-1443`) |
| `1448-1671` | 224 | Response types: `NativeMessagesDelta`, `TransformResponse` (`:1455-1535`) + impl (`:1537-1617`), `HistorianDiagnostics`, `HistorianTriggerProgress`, `ProjectionCacheInput`, `TransformWithProjection` |
| `1674-1794` | 121 | Tag and overlay internals: `TaggableKind`, `Channel1Level` + impl, `TagOverlayState`, `ActiveTagForNudge`, `Channel1Decision`, `PendingOverlayDecisions`, `OverlayComputation`, `Channel1NudgeInputs` |
| `1800-1920` | 121 | `TransformError` (`:1800-1840`), `Display`, `Error`, impl, and four `From` conversions |
| `1922-2080` | 159 | Claim-mirror read seam: `claim_state_vector`, `claim_mirror_read_outcome`, `claim_snapshot_for_context` (`:1964-2012`), `revision_signal_for_context`, `compose_m0_for_context`, `compose_m1_for_context` |
| `2093-2128` | 36 | Public entry points: `transform` (`:2093-2099`), `transform_with_projection` (`:2101-2109`), `transform_with_projection_cached` (`:2111-2128`) |
| `2133-2301` | 169 | Pass plumbing and TTL: `record_stable_pass_trace`, `pass_scheduler_observation`, `apply_once_with_estimator`, `claude_code_marker_ttl`, `internal_assumed_cache_lifetime_for_profile`, `response_marker_ttl`, `apply_once_with_estimator_and_projection` (`:2261-2301`) |
| `2303-2359` | 57 | Test hooks and the differential flag: attempt-hook registry (`#[cfg(test)]` at `:2303`, `:2306`, `:2310`, `:2322`), `prefix_projection_differential_enabled`, `assert_prefix_projection_equivalent` |
| `2361-2422` | 62 | `served_output_fingerprints`, `normalize_synthetic_todo_ingress`. The primary synthetic-strip entry |
| `2428-2630` | 203 | Lineage: `LineagePassState`, `continuation_summary_anchor`, `validate_lineage_anchor` (`:2484-2547`), `rebase_descent_ordinals` (`:2549-2598`), `lineage_protocol_passthrough`, `todo_synthesis_verdict` |
| `2632-3219` | 588 | Additive path: `AdditiveM0Composition`, `compose_additive_m0` (`:2639-2709`), `apply_additive_only` (`:2711-3219`). The compaction-disabled branch |
| **`3222-5697`** | **2,476** | **`fn apply_once`.** One linear body, no inner functions. The pass engine: projection, synthetic strip, epoch folding, tagging activation, boundary resolution, coverage advance, unit render, cache-state CAS |
| `5699-5857` | 159 | Block identity: `provisional_tail_mid`, `TailIdentityReAdoption`, `trailing_blank_identity_replays_stored`, `enforce_block_identity` (`:5747-5818`), `identity_drift_requires_reject`, `frozen_unit_targets_mid`, `block_identity_hash_prefix` |
| `5859-5941` | 83 | Ingress meta and effective limits: `apply_ingress_meta`, `effective_usage`, `effective_context_limit_tokens`, `effective_hard_context_limit_tokens` |
| `5943-6124` | 182 | Render identity and epochs: mural identity fold, `render_identity_base`, `m0_mural_input`, `m0_content_epoch_for_pass` (`:5999-6044`), `render_config_change`, `prompt_surface_selection`, `render_epoch_suffix`, `scheduler_config`, `producer_gate`, `selection_pass_class` |
| `6126-6243` | 118 | Meta/state conversion and shape checks: deferred-execute and latch conversion, `apply_scheduler_meta`, `tail_state_from_live`, `is_legacy_baseline`, `cached_m1_missing`, `valid_m0m1_shape` |
| `6245-6435` | 191 | Caveman units: depth, payload, unit construction, level, target depth, `new_caveman_units` (`:6303-6381`), `prune_covered_caveman_units`, `surviving_caveman_units` |
| `6441-6673` | 233 | Coverage and boundary divergence: `frozen_units_matched_to_tail`, `is_tail`, `is_uncovered_leading_system`, `BoundaryDivergenceRecut`, `protected_tail_floor_ordinal`, `boundary_divergence_reset_allowed`, `detect_boundary_divergence_candidate` (`:6557-6600`), coverage ordinal/bounds from compartments, `covered_system_messages_for_coverage`, `coverage_advance_covers_new_system` |
| `6675-6968` | 294 | Reduction units: frozen red payload/targets, drop-seed logging, `first_applied_pending_command_ids`, `consumed_pending_drop_ids` (`:6735-6779`), `red_unit`, `validate_reduction_monotonicity`, `reductions_pending`, `new_reduction_units` (`:6848-6882`), `effective_reductions` (`:6887-6919`), prune and survive |
| `6973-7029` | 57 | Synthesized region rendering: `synthetic_m0_message`, `render_mural_block`, `render_m1_placeholder`, `render_m1_body`, `synth_region` |
| `7031-7165` | 135 | Tail projection and coverage predicates: `sel_item_from_flat`, `tail_sel_items`, `tail_end_mid`, `tail_contains_mid`, `coverage_advanced`, `coverage_shrank`, `stored_compartment_covers_ordinal`, `first_uncovered_live_block`, `validate_live_boundary_ordinal`, `boundary_available` |
| `7167-7323` | 157 | `resolve_boundary_state` (`:7167-7269`), `trim_mismatch`, `surviving_revert_prefix_seq`, `has_durable_lineage`, `absent_shape_fingerprint`, `pending_rewrite_detail` |
| `7325-7509` | 185 | Pending passthrough and synthetic todo: `PendingPassthroughArgs`, `pending_passthrough_messages`, `pending_passthrough_result` (`:7376-7425`), `anchor_folded_by_coverage`, `advance_synthetic_todo`, `reanchor_kept_synthetic_todo_if_folded_or_shrunk` |
| `7511-7634` | 124 | Tag baseline cache: entry + impl, cache + impl (`:7554-7595`), accessor, metrics, retained bytes, entry builder |
| `7639-7697` | 59 | `load_cached_tags` |
| `7700-8044` | 345 | Tag mint frontier: `TagMintWork`, memo, key hashing, `tag_mint_frontier_start` (`:7764-7797`), candidate counting, `tag_mint_frontier_store` (`:7817-7853`), `#[cfg(test)] tag_mint_inputs` (`:7856-7872`), `tag_mint_inputs_from` (`:7875-7938`), `TagMintFrontierCache` + impl (`:7951-8010`), accessor, `append_tag_mint_rows` |
| `8048-8169` | 122 | Taggable classification and overlay state: `taggable_source`, `taggable_kind`, `newest_active_tag_block_ids`, `protected_tail_cutoff_ordinal`, `tag_overlay_state` |
| `8172-8398` | 227 | Overlay application: `temporal_gap_prefix` (`:8172-8206`), `apply_tag_overlay_to_message` (`:8208-8269`), `apply_tag_prefix_to_block`, `prepend_tag_to_tool_output`, temporal/hint/channel1 block appenders, `tag_prefix`, `prepend_tag` |
| `8403-8572` | 170 | Tag-imitation defense and user-message eligibility: `strip_tag_prefix`, `strip_leading_tag_imitations` (`:8413-8452`), inline-code delimiter tracking, `well_formed_tag_suffix`, `is_entire_system_reminder_wrapped`, `is_system_reminder_transport_message`, `is_authored_user_message`, `eligible_authored_user_tail`, `user_hint_target_was_served` |
| `8574-8761` | 188 | `compute_active_overlay_decisions` |
| `8766-8841` | 76 | `maybe_decide_live_user_hint`, `lexical_tokens` |
| `8843-8964` | 122 | `run_user_hint_lexical_search` |
| `8967-9140` | 174 | User-hint text handling: query and raw prompt extraction (`#[cfg(test)]` islands at `:8966`, `:8971`), stacked-augmentation detection, `sanitize_user_hint_query`, regex accessors, system-reminder and tag-notation stripping, `utf16_len`, `utf16_prefix`, `render_user_hint` (`:9084-9117`), truncation helpers |
| `9142-9313` | 172 | Nudge inputs: `maybe_append_channel1_nudge`, `tag_rows_for_hygiene` (`:9182-9246`), `active_tags_for_nudge`, `active_tags_for_channel2` |
| `9315-9626` | 312 | Channel-2 and Channel-1 decisions: directive input/pressure/output types, `channel2_directives` (`:9337-9378`), `channel2_pressure`, three rearm functions, `claude_code_channel2_directive` (`:9435-9503`), `channel2_directive_id`, `protected_tag_cutoff`, `channel2_token_aggregate`, `oldest_channel2_hint`, reminder text builders, `decide_channel1` (`:9562-9621`), `channel1_refire_tokens` |
| `9628-9783` | 156 | `#[cfg(test)] mod nudge_formula_tests` |
| `9785-9876` | 92 | Channel-1 placement: `newest_tool_result_for_channel1`, `tool_result_can_carry_channel1`, `oldest_reclaimable_hint`, `build_channel1_reminder`, `approx_thousands`, `format_reclaimable_hint` |
| `9880-10179` | 300 | Strip classification: `strip_unit`, `provider_sentinel_text`, metadata/ignored/placeholder predicates, `tag_stripped_text`, system-injection detection and `strip_system_injection` (`:10001-10040`), reduce/noise/image predicates, `replace_with_sentinel`, strip-unit lookups, tag-number maps, `tag_age_cutoff` |
| `10181-10494` | 314 | Frozen strips: `new_frozen_strip_units` (`:10181-10339`), `ReasoningMutationPolicy`, `remove_frozen_historical_reasoning`, `apply_surface_strips` (`:10371-10458`), `surviving_strip_units` |
| `10497-10646` | 150 | Tool-arc shape: `ReasoningMessageArcShape`, `projection_reasoning_ineligible_arc_ids`, `SplitCoverageToolArc`, `split_coverage_tool_arcs` (`:10545-10617`), `synthetic_todo_split_arcs`, `synthetic_todo_render_anchor_mid` |
| `10650-10891` | 242 | Renderer transition: `RendererTransitionClass`, `v1_transition_classes`, `RendererTransitionShapes` + impl, `renderer_transition_shapes` (`:10697-10772`), consumed-class helpers, `preserve_transition_consumed_marker`, `full_drop_tool_ids` (`:10839-10891`) |
| `10894-11169` | 276 | Output identity: `BuildOutputTimings`, `FrozenUnitIndex` + impl, `FrozenUnitLookup` + impl, `BuiltOutput`, `digest_field`, `message_output_identity` (`:11014-11096`), `cached_output_item`, `cached_or_serialize_output`, `record_output_item`, `duplicate_tool_use_locations` |
| `11172-11305` | 134 | Output integrity guards: `assert_no_orphaned_tool_arcs` (`:11172-11225`), `enforce_unique_tool_use_ids` (`:11231-11305`) |
| `11307-11574` | 268 | Merged reasoning and trailing blank: `new_merged_reasoning_strip_units`, `FrozenTrailingBlankDecision`, keep-count and decision, `canonical_blank_block`, `apply_frozen_trailing_blank_decision` (`:11390-11458`), `refresh_trailing_blank_decisions` (`:11460-11535`), `apply_serializer_residual_to_message` |
| `11577-11675` | 99 | `build_output`, `build_output_with_tags`, `build_output_with_tags_unindexed` |
| **`11678-12156`** | **479** | **`build_output_with_tags_inner`.** The final splice and serialize |
| `12159-12297` | 139 | Serializer residuals and reasoning mutation: `apply_serializer_residuals`, `..._with_exemption`, `strip_reasoning_from_merged_assistants_with_exemption`, reasoning-block predicates, exemption-mid resolution, `request_accepts_empty_content`, `reasoning_clear_cutoff_with_tags` |
| `12309-12462` | 154 | Native reasoning clearing: three `pub(crate) clear_served_native_reasoning*` entry points, `clear_served_native_reasoning_from_iter` (`:12379-12462`) |
| `12464-12623` | 160 | Sentinels and tail utilities: empty-reasoning sentinel build and detect, ignored-block predicates, projection-block maps, `elapsed_ms`, `MaterializeReasonInputs`, `classify_materialize_reason` (`:12561-12613`), `action_str` |
| **`12625-29439`** | **16,815** | **`#[cfg(test)] pub(crate) mod tests`.** Flat, no inner modules. 280 `#[test]` |

## Other modules, one line each

`src/` non-monolith modules, largest first. Line count is the whole file; the
inline-test share is in parentheses where it is material.

- `historian.rs` 4,682 (2,862 test) — the durable historian firing state machine, pinned chunk snapshot with fingerprint verification, and the CAS-gated publish transaction.
- `selection.rs` 3,365 (1,954 test) — pure deterministic tail-reduction selection producing `ReductionDecision`s; determinism is the stated cache invariant.
- `boundary.rs` 3,053 (1,080 test) — protected-tail split and historian trigger decision, claimed pure over caller-provided bytes with no clock or store.
- `historian_producer.rs` 2,306 (821 test) — Broca session client that runs the historian model call through `mc_host::Client`; interprets only Broca request and response semantics.
- `codec/opencode.rs` 2,186 (865 test) — OpenCode harness decode and encode with sidecar block-identity stamping.
- `historian_chunk.rs` 2,051 (881 test) — builds the pinned ordinal-range chunk that the historian summarizes, including the snapshot-vector compare at `:563-608`.
- `bin/ck-mc-host.rs` 2,048 (301 test) — see the overlaps section; this is the production lifecycle CLI, already covered by Part 2a.
- `historian_validate.rs` 1,869 (565 test) — parses and validates the model's compartment XML against chunk and stored ranges before any write is possible; declared fail-closed.
- `smart_note_evaluation.rs` 1,851 (901 test) — smart-note evaluation transition contract plus a vendored five-field cron evaluator, replaying a frozen cross-language fixture.
- `codec/pi.rs` 1,499 (422 test) — Pi harness decode and encode, same sidecar contract as OpenCode.
- `scheduler.rs` 1,449 (532 test) — pass-class producer (execute/defer/force/block), idle-TTL fire, mid-turn deferred-execute transition, emergency-drain latch, provider context-overflow detection.
- `ck_wire.rs` 1,279 (541 test) — CK ingress and egress wire types and the `mid#block_index` block-granular projection; retains original message objects for verbatim replay.
- `tail_hygiene.rs` 1,278 (555 test) — the shared rendered-tail hygiene metric feeding Channel-1 and Channel-2.
- `config.rs` 1,229 (514 test) — JSONC config reader with per-leaf trust policy: model choice is user-tier only, project config may only raise the execute threshold.
- `injection.rs` 911 (455 test) — synthetic todowrite injection: canonical todo normalization, the deterministic `mc_synthetic_todo_<hash>` call id, byte-exact injected pair, bust-only freeze.
- `decay_render.rs` 849 (484 test) — deterministic decay renderer turning a compartment set into the markdown history bytes for m0 and m1; **partly cataloged by Part 3**.
- `caveman.rs` 651 (40 test) — the caveman paraphrase levels used by depth-tiered tail compression.
- `bin/ck_mc_host/serve.rs` 637 (0 test) — the `serve` daemon-mode entry, including the SIGTERM handler.
- `historian_prompt.rs` 552 (220 test) — pure assembly of the historian per-run user prompt from already-loaded rows.
- `memory_render.rs` 538 (162 test) — memory and mirrored-claim rendering into m0 sub-blocks.
- `dispatch.rs` 511 (0 test) — `PreparedOutcome` / `PreparedOutput` / `PreparedSegment` and `MAX_WIRE_BODY_BYTES`: the measured, reserve-then-write response encoder.
- `classify.rs` 490 (217 test) — module-local classification helpers.
- `memory_tool.rs` 447 (87 test) — memory search used by the `ctx_memory` facade and the user-hint lexical search; **its staleness read path is cataloged by Part 3**.
- `compartment_coverage.rs` 413 (198 test) — validates strictly ordered stored compartment ranges and partitions them for the m0/m1 split.
- `m0_compose.rs` 403 (0 test) — the store-to-m0 byte producer for the HARD branch; byte producer only, does not classify HARD versus SOFT.
- `prompt_surface.rs` 385 (62 test) — guidance and prompt-surface text constants and selection.
- `codec/sidecar.rs` 339 (0 test) — shared block-meta matching, fingerprinting, and identity stamping used by both codecs.
- `bin/ck_mc_host/spawn.rs` 305 (0 test) — process spawn helper for the CLI.
- `codec/mod.rs` 299 (287 test) — re-exports only; almost the entire file is the cross-codec golden test.
- `healing.rs` 267 (108 test) — `SerializerProfile` and `quirk_residual`: per-provider serializer quirk compensation.
- `project_docs.rs` 232 (113 test) — the `<project-docs>` m0 sub-block, with non-following `symlink_metadata` reads as a load-bearing security guard.
- `m1_compose.rs` 230 (0 test) — the m1 delta byte producer.
- `differential_goldens.rs` 224 (18 test) — `#[cfg(test)]`-gated differential golden harness.
- `retained_size.rs` 212 (0 test) — retained-bytes accounting used by every cache budget in `lib.rs` and `transform.rs`.
- `test_support.rs` 178 (0 test, but `#[cfg(test)]`-only) — in-process fixture builders for parity tests.
- `divergence.rs` 178 — first-divergence attribution for served CK block sequences.
- `session_resolver.rs` 70 — the `SessionResolver` trait, `ResolvedSession`, `MissingSessionResolver`.

### `src/codec/` enumerated

Four files, 4,323 lines. `mod.rs` (299) declares `opencode`, `pi`, `sidecar` and
re-exports the six decode and three encode entry points plus the three sidecar
types; 287 of its 299 lines are a `#[cfg(test)] mod tests` that replays
per-harness golden files with a `coverage` and `missing_capture_classes`
manifest. `opencode.rs` (2,186) and `pi.rs` (1,499) are the two harness
adapters, each converting the harness's native session JSON to and from
`CkIngressMessage` / `CkWireMessage`. `sidecar.rs` (339, zero inline tests) is
the shared machinery both adapters depend on: `block_is_unchanged`,
`decoded_block_fingerprint`, `match_block_metas`, `meta_for_ck`,
`stable_hash_prefix`, `stamp_block_identity`, `BlockMeta`, `DecodeSidecar`,
`DecodedHarnessMessages`, `ExtractedBoundary`, `HarnessMessageMeta`. It carries
the block-identity stamping that everything downstream keys on, and it has no
tests of its own.

### `src/bin/ck-mc-host.rs`

2,048 lines plus `ck_mc_host/serve.rs` (637) and `ck_mc_host/spawn.rs` (305).
Its header confirms what earlier work established: this is the production
lifecycle and serve executable, a leaf binary that depends on `mc-module` plus
`mc-host` and never the reverse. Commands are `serve`, `start`, `stop`,
`restart`, `probe` (aliased from `status`), plus side-effect-free `--version`,
`release-info`, and `input-lock-digest`. Every lifecycle command emits exactly
one `magic-context.daemon/v1` JSON object on stdout; exit 0 means `ok:true`,
exit 1 an operational failure, exit 2 a usage error with no lifecycle call. It
is the production consumer of the host lifecycle probe cataloged in Part 2a, so
it is excluded from Part 4 discovery.

## Existing test coverage and CI status

938 test functions in the crate. Distribution:

| Location | Tests |
| --- | --- |
| `src/transform.rs` inline (`12625-29439`) | 280 |
| `src/lib.rs` inline (`16001-30279`) | 248 (75 `#[test]`, 173 `#[tokio::test]`) |
| `src/lib.rs` `release_contract_tests` (`30281-30517`) | 8 |
| other `src/` modules inline | the remaining ~364 |
| `tests/lifecycle_cli.rs` | 12 |
| `tests/prepared_output.rs` | 10 |
| `tests/direct_host.rs` | 6 |
| `tests/host_adapter.rs` | 4 |
| `tests/release_contract_conformance.rs` | 3 |
| `tests/broca_roundtrip.rs` | 2 |
| `tests/boundary_counter_durability.rs` | 1 |

Both giant inline test modules are **flat**: neither
`transform.rs:12626-29439` nor `lib.rs:16002-30279` contains a single inner
`mod`, so there is no structural index. A later pass locating an existing check
has to grep test-function names. As a locating aid, a keyword histogram over the
280 transform test names gives cache-state and pass 124, output and render 83,
tags and nudges 56, selection and reduction 47, identity and lineage 38, codec
and wire 25, config and scheduler 20; over the `lib.rs` test names it gives
facade/note/claim 51, historian and wrapup 49, cache-state and pass 35, codec
and native 34, selection and reduction 30, state sync/import/page 18. Buckets
overlap and about 12 percent of names match no bucket, so treat this as a
starting point, not an inventory.

### CI: exactly one mc-module test binary runs

Verified against all five files in `.github/workflows/`.

- `.github/workflows/ci.yml:164-165` — `cargo build -p mc-shm-transport -p mc-host -p mc-shm-native` then `cargo build -p mc-module --bin ck-mc-host`. Build only, in the `shm-source-build` job over `[ubuntu-latest, macos-latest, macos-15-intel]`.
- `.github/workflows/ci.yml:167-168` — step "Native lifecycle binary contract", `cargo test -p mc-module --test lifecycle_cli`. **This is the only `mc-module` test invocation in the entire workflow set.** It runs on all three matrix platforms.

Nothing else names `mc-module`. There is no `cargo test -p mc-module --lib`, no
`cargo nextest run -p mc-module`, and no workspace-wide test job: the only
`--workspace` cargo commands in CI are `cargo fmt --check`
(`.github/workflows/ci.yml:477`) and `cargo check -p mc-core
--no-default-features` (`:484`). `cargo clippy --workspace --all-targets` exists
only as `lint:rust` in root `package.json:36`, which no workflow invokes.

The consequence is stark. `scripts/test-rust.sh` runs `cargo nextest run
--workspace` and would cover everything, and root `package.json:50` wires it into
`check:all`, but no workflow calls either. So:

- **All 528 inline tests in `lib.rs` and `transform.rs` run only on a developer's machine.** So do the ~364 inline tests in the other modules.
- **Six of the seven integration binaries never run in CI**: `prepared_output`, `direct_host`, `host_adapter`, `release_contract_conformance`, `broca_roundtrip`, `boundary_counter_durability`. Only `lifecycle_cli` runs.
- `release_contract_conformance.rs` is the cross-artifact drift gate whose own header argues the drift "must fail the build, not the deployment". It does not run in CI. The separate `release-qualification-gate` job (`ci.yml:338-405`) runs the TypeScript-side drift checks, not this Rust conformance suite.

Note a correction to an existing catalog entry: Part 2a's
`the-largest-lifecycle-proof-runs-in-ci` record says "the `--test lifecycle` in
the `mc-module` step at `:149`". At `HEAD` that step is at `ci.yml:167-168`, and
the flag is `--test lifecycle_cli`. The substance of the observation is
unchanged; only the line reference has drifted.

Assertion density is high in both monoliths, but the counts are inflated by the
test modules and should not be read as production guard density: `lib.rs` has
1,466 `assert*`/`debug_assert*` occurrences and 1,085 `panic!`/`unreachable!`/
`expect(`/`unwrap(` occurrences; `transform.rs` has 1,714 and 1,318. Two
production guards worth naming now because they are explicit fail-loud checks on
the output path: `transform.rs:11172-11225 assert_no_orphaned_tool_arcs` and
`transform.rs:11231-11305 enforce_unique_tool_use_ids`.

Fixture corpus: 29 files under `testdata/`, including `boundary-golden.json`,
`ck_wire_golden.json`, `differential-golden.json`, four
`fm-boundary-divergence*` files, `historian-chunk-golden.json`,
`historian-prompt-golden.json`, `historian-system-prompt.txt`,
`ingress-projection-golden.json`, `injection-golden.json`,
`smart-note-evaluation-golden.json`, `nudge-hygiene-golden.json`,
`render-golden.json`, plus two TypeScript generators
(`gen-decay-store-differential.ts`, `gen-m0-decay-pressure-retry.ts`) and a
`codec/` subdirectory. Golden files that only an uninvoked test reads are not
evidence of anything today.

## Risk ranking (with the criteria applied)

Six criteria, applied per area. "CI" is the criterion the task asked to treat as
a risk multiplier, and it multiplies almost everything here, because only
`lifecycle_cli` runs.

| Area | Persistent state | Can lose or corrupt user data | Documented contract | Trust boundary | Concurrency and ordering | Tests, and do they run |
| --- | --- | --- | --- | --- | --- | --- |
| **Historian write, validate, publish** | Yes: compartments, chunk ranges, durable phase, publish CAS | **Irreversibly.** Raw conversation is replaced by model-generated summary text; once folded behind coverage, the original is no longer served | Strong, and strong claims: five-phase machine, fail-loud fingerprint verification, "fail-closed" validation, publish surfaces only through the m1 watermark | **Yes, the worst one.** Producer output is language-model text arriving over Broca and parsed as XML into durable rows | Yes: single live-session claim, publication fence, CAS-gated publish, chunk pinning versus concurrent coverage advance | ~108 inline across four modules, plus 12 in `lib.rs` tests; `broca_roundtrip` (2). **None run in CI** |
| **Transform pass engine** | Yes: cache state, module meta, tag rows, all committed behind one CAS | Yes: wrong bytes in the served context, wrong messages dropped, duplicate `tool_use` ids, a wedged cache state that poisons every later pass | Strong, and it states two named poison-resistance invariants and a render-once cache discipline | Yes: harness-supplied CK arrays decoded through a hand-written `Deserialize`, plus the reserved `mc_*` namespace defence | Yes: bust versus defer render-once, epoch fold ordering before activation, boundary divergence reset, snapshot lease budget | 280 inline in `transform.rs` plus a share of `lib.rs`'s. **None run in CI** |
| **McHandler op handlers and staging** | Yes: state sync, state import, agent drops, todo state, recomp, delete, wrapup, note-evaluation claims | Yes: state import overwrites session state; session delete and recomp destroy it; a bad seq or digest accepted admits foreign data | Partial. Individual methods carry good comments; there is no single contract document | Yes: raw JSON from the host, with byte caps (`enforce_request_byte_cap`, `value_footprint_bound`) and per-field id and staged-byte caps | Heavy: async tasks under a `TaskTracker`, `CancellationToken`, atomics, store-open lease waiting with jittered backoff, route unbind teardown, three staging coordinators with phase enums, dispatch wedge detector | 248 inline in `lib.rs`; `prepared_output` (10), `direct_host` (6), `host_adapter` (4), `boundary_counter_durability` (1). **None run in CI** |
| **Facade surface and note evaluation** | Yes: notes, claim mirror, note-evaluation claims and leases | Yes: `ctx_note` and the claim mirror write durable user content; a mis-scoped facade writes to the wrong project | Partial; `smart_note_evaluation.rs` has a strong cross-language fixture claim | Yes: MCP tool arguments from a model, string caps, JSON schemas, and credential minting for evaluators | Yes: claim acquire/heartbeat/renew/complete/abandon with slot cycles and expiry purge | Inline plus the `lib.rs` module. **None run in CI**. Claim-mirror parts overlap Part 3 |
| **Rendered output, tags, nudges** | Tag rows and nudge arming watermarks in module meta; three in-process caches | Yes but narrower: a wrong overlay or a stale tag-baseline hit changes replayed bytes and busts the prefix cache | Moderate; `tail_hygiene.rs` has a one-line header, and the nudge formulas have a calibration doc under `docs/` | Yes: `strip_leading_tag_imitations` and the tag-suffix well-formedness check exist specifically to stop harness content imitating module tags | Yes: tag mint frontier monotonicity, generation-gated baseline cache refill, Channel-2 rearm after fold or collapse | 56 tag/nudge and 83 output/render inline, plus `nudge_formula_tests`. **None run in CI** |
| **Pure decision units, codecs, config** | No durable writes of their own; `config.rs` reads user and project files | Indirectly: a wrong selection decision or a wrong decode drops content downstream | **Strongest in the crate.** `selection.rs`, `boundary.rs`, `scheduler.rs`, `compartment_coverage.rs`, `injection.rs` all declare purity and determinism explicitly | Yes: `config.rs` enforces per-leaf trust policy (project config may only raise the execute threshold, model choice is user-tier only); the codecs parse untrusted harness session JSON | Determinism obligations rather than concurrency; `codec/sidecar.rs` owns block-identity stamping with zero tests | Well covered inline, plus goldens. **None run in CI** |

Ranking, highest first: historian write path; transform pass engine; McHandler op
handlers; facade surface and note evaluation; rendered output and tags; pure
decision units and codecs.

The historian ranks first on the one criterion that separates recoverable from
unrecoverable. Every other area produces wrong bytes for one pass or wrong state
that a later correct pass can overwrite. The historian publish is the only path
that permanently substitutes unverified model-generated text for the user's real
conversation, and the only thing standing between the two is
`historian_validate.rs`, whose 19 tests never execute in CI.

## Proposed sub-partition

Six sub-parts. Sized in total lines, because a discovery pass reads the adjacent
tests as evidence. Line-range scoping inside the two monoliths is unavoidable and
is exact: every boundary was read back at `HEAD`.

The two giant test modules are not sub-parts. `lib.rs:16001-30517` is read as
evidence by 4a, 4c, and 4d; `transform.rs:12625-29439` is read by 4b and 4e.
Each part's `existing-checks.md` inventories the slice it consumed.

Accounting check: the six sub-parts total 64,553 lines. The remainder is
`lib.rs:1-138` (138), the two test modules (31,331), `src/bin/` (2,990, excluded
as Part 2a), `test_support.rs` and `differential_goldens.rs` (402), `tests/`
(2,379), `examples/` (714), and seven blank separator lines. That sums to
102,515.

### 4a Historian write, validate, and publish — risk 1

Files, 8 units, 13,500 lines:

- `src/historian.rs` (4,682)
- `src/historian_producer.rs` (2,306)
- `src/historian_chunk.rs` (2,051)
- `src/historian_validate.rs` (1,869)
- `src/historian_prompt.rs` (552)
- `src/lib.rs:3106-3396` (291) — historian and wrapup orchestration types, both publication fences, `HistorianFiringTask`
- `src/lib.rs:4543-5589` (1,047) — session claims, `maybe_spawn_reattach`, `prepare_historian_fire`, `prepare_wrapup_fire`, firing execution, wrapup budget and `run_wrapup_firing`
- `src/lib.rs:6431-7132` (702) — wrapup response shaping and `handle_session_wrapup_value`

Rationale: the only path in the crate that irreversibly replaces real user
conversation with unverified model output, gated solely by in-crate validation
that CI never runs.

Attention focuses:

1. **Publish admission.** Does every route into `mc-store`'s publish go through `validate_historian_output` first, and is the CAS predicate sufficient to reject a chunk pinned against coverage that has since moved? Trace fingerprint verification and `BOUNDARY_HEALING_SLACK` (`historian_validate.rs:20`) as an admission widener.
2. **Untrusted producer output.** Treat the Broca response as adversarial: malformed XML, ranges outside the chunk, overlapping or non-monotone ranges, endpoints naming message ids that are not in the pinned snapshot, and duplicate or absent compartments.
3. **Firing exclusion and phase durability.** One live historian session per session id across `prepare_historian_fire`, `run_wrapup_firing`, `maybe_spawn_reattach`, and the dreamer path; what a crash between phases leaves behind; whether both publication fences actually block a stale publish.

### 4b Transform pass engine and cache-state transition — risk 1

Files, 8 units, 10,124 lines:

- `src/transform.rs:1-7510` (7,510) — contract types, the untrusted `Deserialize`, entry points, `apply_additive_only`, `apply_once`, block identity, coverage and boundary resolution, caveman and reduction units, pending passthrough, synthetic todo
- `src/injection.rs` (911)
- `src/compartment_coverage.rs` (413)
- `src/m0_compose.rs` (403)
- `src/healing.rs` (267)
- `src/m1_compose.rs` (230)
- `src/retained_size.rs` (212)
- `src/divergence.rs` (178)

Rationale: the crate's reason to exist, and the place where a single wrong
decision either corrupts the served context or wedges the durable cache state
for every subsequent pass.

Attention focuses:

1. **The two documented poison-resistance invariants.** Verify that synthetic stripping (`transform.rs:2405-2422`) really precedes every boundary, coverage, and tail computation inside `apply_once`, and that the `mc_*` namespace reservation holds when harness content supplies a colliding id.
2. **Render-once and replay-verbatim.** Byte-complete units rendered only on bust, verbatim replay on defer, a pure defer writing nothing; and whether the cache-state CAS at the end of `apply_once` can accept a pass whose rendered units disagree with the epochs folded earlier in the same pass.
3. **Boundary and coverage monotonicity.** `coverage_shrank`, `boundary_divergence_reset_allowed`, `detect_boundary_divergence_candidate`, `validate_reduction_monotonicity`, and `enforce_block_identity` versus `identity_drift_requires_reject`: which drifts are healed, which reject, and whether a reject is reachable.

### 4c McHandler durable op handlers and staging coordinators — risk 2

Files, 5 ranges in `src/lib.rs`, 7,857 lines, essentially all production:

- `src/lib.rs:139-3105` (2,967) — wire types, store-open coordinator, dispatch health, epoch predicates and budget constants, the three staging coordinators, the four in-process caches, `McHandler` fields, note-evaluator registry types
- `src/lib.rs:3398-4542` (1,145) — construction, store open, producer-factory seams, `bind_route`, note-evaluator registry methods, discard paths, projection cache, `unbind_route`, binding resolution, guidance clock
- `src/lib.rs:5591-6429` (839) — state import, agent drops, todo state, flush, recomp, delete, session status
- `src/lib.rs:7134-8005` (872) — authority lifecycle, mirror pull, prompt surface, guidance, memory metrics, status, transform dispatch entry
- `src/lib.rs:8007-10040` (2,034) — `handle_transform_unpaged_value`, `handle_state_sync_value`, `apply_state_sync_wire`, `handle_transform_page_value`, dreamer run task

Rationale: every store write on the request path, all three multi-request staging
protocols, and all of the crate's real concurrency, with zero CI coverage and no
single contract document.

Attention focuses:

1. **Staged multi-request assembly.** The three coordinators (`StateSyncSeedCoordinator`, `TransformPageCoordinator`, `StateImportCoordinator`) each stage bytes across requests under caps, TTLs, and a phase enum. Check content-digest binding, sequence-mismatch rejection, pending-count and staged-byte caps, stale expiry, and what a route unbind mid-stage releases.
2. **Store-open and route lifetime.** `StoreOpenCoordinator` with a 60-second lease-wait window and jittered backoff, the live-lease error classification, and whether `unbind_route` releases every piece of per-route state that the coordinators, caches, and note-evaluator registry hold.
3. **Cache validity.** Four in-process caches with byte budgets and lease caps. For each: what the key covers, what a stale hit would serve, and whether the eviction accounting can go negative or strand a lease.

### 4d Facade surface, note evaluation, and response assembly — risk 2

Files, 6 units, 9,000 lines:

- `src/lib.rs:11919-16001` (4,083) — trait impls, `settle_prepared*`, native attachment plumbing and the incremental delta path, the `drive-fault` block, `respond_transform`, page and seed reassembly, canned errors, note-evaluation wire parsing, request byte caps, facade expand and note rendering, canonicalization, status summaries, schemas, manifest
- `src/lib.rs:10042-11917` (1,876) — facade dispatch, claim intent and effects and mirror, the four `ctx_*` facades, the note-evaluation protocol, `handle_ctx_note_facade`
- `src/smart_note_evaluation.rs` (1,851)
- `src/dispatch.rs` (511)
- `src/memory_tool.rs` (447)
- `src/project_docs.rs` (232)

Rationale: the model-facing tool surface, where a language model's arguments
reach durable writes, plus the measured response encoder that every reply passes
through.

Attention focuses:

1. **Argument trust and scope binding.** `facade_arguments`, the string and byte caps, `enforce_request_byte_cap` and `value_footprint_bound`, and `resolve_facade_scope` plus `bind_facade_route_for_write`: can a facade call write outside the scope its route was bound to, and are the caps applied before allocation?
2. **Note-evaluation claim lifecycle.** Register, heartbeat, next, renew, complete, abandon, plus `NoteEvaluatorSlotCycles`, credential minting, expiry purge, and `refuse_conditioned_note_without_evaluator`. Whether a claim can be completed twice, renewed after expiry, or acquired by a channel that has been unbound.
3. **Prepared-output measurement.** `dispatch.rs`'s measure-then-reserve-then-write protocol against `MAX_WIRE_BODY_BYTES`, and `settle_prepared_with`'s reserve, reserved, cancelled arms: whether a measured length can disagree with the bytes actually written, and what a cancellation leaves on the wire. Also `project_docs.rs`'s non-following `symlink_metadata` guard, which the header calls load-bearing.

### 4e Rendered output, tags, and nudge overlay — risk 3

Files, 7 units, 9,304 lines:

- `src/transform.rs:7511-12623` (5,113) — tag baseline and mint frontier caches, overlay application, tag-imitation defence, user-hint lexical search, Channel-1 and Channel-2 decisions, strips, renderer transition, output identity and the two integrity guards, `build_output_with_tags_inner`, serializer residuals, native reasoning clearing
- `src/tail_hygiene.rs` (1,278)
- `src/decay_render.rs` (849) — **partly cataloged by Part 3, see overlaps**
- `src/caveman.rs` (651)
- `src/memory_render.rs` (538)
- `src/classify.rs` (490)
- `src/prompt_surface.rs` (385)

Rationale: the final byte-producing stage. Its guards are explicit and its
failure mode is a broken provider request or a busted prefix cache rather than
lost durable state.

Attention focuses:

1. **Output integrity guards.** `assert_no_orphaned_tool_arcs` and `enforce_unique_tool_use_ids` are fail-loud production checks on the final array. Determine what each actually panics on, whether either can fire on a legitimate input, and which orphan or duplicate shapes slip past both.
2. **Tag mint and baseline-cache freshness.** Tag-number monotonicity across passes, the generation-gated append-only recognition in `TagBaselineCacheEntry` (documented at `transform.rs:7511-7515`), and what a full-refill-required generation transition serves if the refill is skipped.
3. **Nudge arming and imitation defence.** Channel-2 arming watermark, `channel2_directive_id` determinism, the three rearm paths, and whether `strip_leading_tag_imitations` plus `well_formed_tag_suffix` can be walked past by harness content, including inside inline code spans.

### 4f Pure decision units, harness codecs, and config — risk 3

Files, 10 units, 14,768 lines. This is at the top of the size band; if a single
pass runs long, split at the documented seam into 4f-i decision units
(`selection.rs`, `boundary.rs`, `scheduler.rs`, 7,867) and 4f-ii wire and config
(`codec/*`, `ck_wire.rs`, `config.rs`, `session_resolver.rs`, 6,901).

- `src/selection.rs` (3,365)
- `src/boundary.rs` (3,053)
- `src/codec/opencode.rs` (2,186)
- `src/codec/pi.rs` (1,499)
- `src/scheduler.rs` (1,449)
- `src/ck_wire.rs` (1,279)
- `src/config.rs` (1,229)
- `src/codec/sidecar.rs` (339)
- `src/codec/mod.rs` (299)
- `src/session_resolver.rs` (70)

Rationale: the best-documented and most testable material in the crate, which
makes it the cheapest place to convert explicit purity and determinism claims
into properties, and it holds the only trust-policy enforcement point
(`config.rs`) and the untested block-identity stamper (`codec/sidecar.rs`).

Attention focuses:

1. **Determinism as the cache invariant.** `selection.rs` claims same inputs
   yield same decisions and therefore byte-identical freeze and replay. Attack
   the stated structural invariants directly: the `frozen_keys` hard filter, the
   `provider_executed` filter, payload purity, arc-safe paired emission, and the
   deterministic merge where drop beats other decisions.
2. **Config trust policy.** Per-leaf tiering is a security claim: model choice is
   user-tier only because it affects spend, and project config may only raise the
   execute threshold. Check every leaf against that rule, including the
   documented divergence from the TypeScript implementation, and the
   `MAX_EXECUTE_THRESHOLD_PERCENTAGE` clamp.
3. **Codec round-trip and identity stamping.** `codec/sidecar.rs` owns
   `stamp_block_identity` and `decoded_block_fingerprint` that everything
   downstream keys on, and it has zero tests of its own. Check decode/encode
   round-trip fidelity for both harnesses, what `block_is_unchanged` treats as
   unchanged, and whether the `coverage` and `missing_capture_classes` manifest
   in `codec/mod.rs`'s golden test admits an unclassified block shape silently.
   Also `boundary.rs`'s no-clock/no-store purity claim and `scheduler.rs`'s
   regex-based provider context-overflow detection against unusual provider text.

## Overlaps with existing parts (do not duplicate)

Confirmed by reading the Part 1, Part 2a, and Part 3 material at `HEAD`. Part 2b
is parked with lens files only and cites `mc-module` once, in a claims inventory.
Part 3 has `evidence/` and `_lenses/` but no `catalog.md` yet, so it is in
progress and its scope statement is not final. `docs/properties/README.md` still
lists Part 3 as "Not started" and Part 4 as "Not started"; both are stale.

**Excluded outright, already covered:**

- `crates/mc-module/src/bin/ck-mc-host.rs` plus `ck_mc_host/serve.rs` and `ck_mc_host/spawn.rs` (2,990 lines). The production consumer of the lifecycle probe cataloged in Part 2a. Not re-mined.
- `crates/mc-module/tests/lifecycle_cli.rs` (635 lines, 12 tests). Part 2a's `existing-checks.md:101` already records it as "the only in-scope suite on both Linux and macOS" for the Part 2a store and probe surface. Not re-mined. Part 4 uses it only as the single data point that some `mc-module` test binary runs in CI.

**Cataloged by Part 3, do not re-derive; cite Part 3 and record the boundary:**

- `src/decay_render.rs`. Part 3's four `core-decay-*` records cite `:19`, `:278-282`, `:291-296`, `:306-314`, `:330-348` for the tier ladder, the hardcoded `0.0` budget pressure, the archive termination bound, and the oldest-first demotion. Part 4e should treat decay tier selection as settled and look only at how the rendered bytes are spliced into m0 and m1.
- The claim-mirror facade handlers in `lib.rs`. Part 3's five `mirror-*` records cite `:10040-10060` (facade dispatch), `:10052-10053`, `:10299-10336` (`handle_claim_mirror_apply`), and `:13844-13860` (`claim_mirror_error`) for generation advance, receipt replay and conflict, the accepting gate, and the rebuild grant. Part 4d owns the rest of the facade surface but must not re-derive mirror receipt semantics.
- `src/memory_tool.rs:19` and `:57-67`. Part 3's `mirror-staleness-undetectable-on-memory-tool-read-path` establishes that the read path takes no expected vector. Part 4d cites it rather than restating it.
- `src/transform.rs:1964-2012` (`claim_snapshot_for_context`, cited as `:1978-2011` and `:2008`) and `src/historian_chunk.rs:563-608` (cited as `:605`). Part 3's `mirror-read-fence-relies-on-generation-advance` already compares these two snapshot-vector checks. Part 4a and 4b cite it.
- `src/tail_hygiene.rs:6` and `:85`. Part 3's `tokenizer-cross-process-determinism` and `core-pass-classifier-destructive-clear-guard` cite the `mc_tokenizer` call and the `CoreState` import. Tokenizer determinism belongs to Part 3.
- `src/classify.rs:176`. Part 3's `core-pass-classifier-destructive-clear-guard` explicitly notes that `mc-module`'s `classify.rs` is a different module from `mc-core`'s pass classifier, with its own concerns. Part 4e owns `classify.rs`; Part 3 owns the `mc-core` classifier.

**No overlap found** with Part 1 (`mc-shm-transport`, `mc-shm-native`). Its only
`mc-module` mention is one line in
`evidence/no-rust-reference-over-peer-writable-payload.md`, which is a
cross-reference, not coverage.

## Open questions

- Is the absence of `cargo test -p mc-module` from CI deliberate or an oversight? Part 2a asked the same question about `mc-host`'s 22 unnamed binaries and left it needing human input. For `mc-module` the shape is more extreme: 926 of 938 tests never run in CI, including the entire historian validation suite and the `release_contract_conformance` drift gate whose own header argues it must fail the build. `scripts/test-rust.sh` exists and would cover it. (needs human input)
- Should Part 4 catalog properties whose only existing check lives in a test binary that CI never runs, as `Exercised: partial`, or as `Exercised: not yet`? `METHOD.md` defines `partial` as "what is covered", which a never-executed test arguably is not. This affects a large fraction of Part 4 records, so it needs a ruling before the lens passes start. (needs human input)
- What is Part 3's final scope? Its `catalog.md` does not exist yet, so the overlap list above is derived from its evidence files and lens files. If Part 3's scope statement claims `decay_render.rs` or the claim-mirror handlers wholly rather than as boundary context, 4d and 4e shrink. Unresolved, needs Part 3's synthesis step.
- Are the four in-process caches in `lib.rs` and the three in `transform.rs` in scope for durability properties, or only for correctness-of-served-bytes? They hold no durable state but their budgets, leases, and eviction accounting have the shape of resource properties. Unresolved, needs a scoping decision at 4c authoring time.
- Does `#[cfg(feature = "drive-fault")]` (`lib.rs:13229-13337`) need any record? The Cargo manifest argues its absence from a default build is the dormancy proof, which is itself a testable claim about the shipped artifact. It is 109 lines and would otherwise be classed `explicit-config-only`. Suggest one reachability record in 4d rather than a group.
- Is there a contract document for the transform anywhere outside the source?
  **Resolved: no.** `docs/` holds three dated performance and roll-forward notes
  plus `nudge-hygiene-calibration-2026-08-16.md` and
  `native-attachment-incremental-cache-2026-08-10.md`. `docs/specs/` holds
  `context-window-geometry.md`, `git-dedup-heuristic.md` with its golden file,
  and a `prompt-surface/` directory containing a load-bearing-rules checklist,
  a budget fixture, a CC manifest epoch fixture, mutation results, five decision
  records, and a light-validation manifest. Of the ten files in `docs/plans/`,
  five mention `mc-module` and all five do so tangentially: the shared-memory
  release gate, the beads restructure, the Tauri dashboard removal, and two
  Synapse plans. So there is no transform or historian specification. The
  authoritative contract statements are the module doc comments, which makes
  every one of them a claim with no independent source to check it against. Part
  4's external references should list `docs/specs/context-window-geometry.md` for
  4b and the whole of `docs/specs/prompt-surface/` for 4e, and should record that
  the historian has no specification outside `historian*.rs`.
