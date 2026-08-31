# Part 4c lens A: durable operation handlers, atomicity and idempotency

Attention focus: what each durable operation handler promises about atomicity,
ordering, and repeat delivery. The staging coordinators' own lifecycle (phase
enums, TTLs, caps, expiry, unbind release) belongs to the sibling lens and is not
re-derived here. Where a staging structure appears below it appears only as the
handler's commit or replay step.

Method contract: [../../METHOD.md](../../METHOD.md).

## Provenance and a correction to the task's commit

The task states `HEAD` = `76cd6f41`. At authoring time the repository `HEAD` is
`b5dc778e` ("fix(shm): close lifecycle and evidence gaps"), one commit later.
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty: that commit
touches `mc-host`, `mc-shm-transport`, and `mc-shm-native` only. Every line
reference below therefore holds identically at both commits. All references are
to `crates/mc-module/src/lib.rs` unless another file is named, and each was read
back individually at `b5dc778e`.

Scope is sub-part 4c as defined in
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md):
`lib.rs` ranges `139-3105`, `3398-4542`, `5591-6429`, `7134-8005`, and
`8007-10040`. Two consequences for this lens:

- `handle_session_wrapup_value` (`:6594-7132`) and `record_wrapup_command_if_current`
  (`:6521`) sit in 4a's range (`6431-7132`) and are excluded.
- The claim intent ledger handlers sit at `:10082-10182`, above this lens's
  `10040` ceiling, in 4d's range. That fact is itself a finding; see
  `h4c-no-handler-in-scope-uses-the-claim-intent-ledger`.

Reachability, established once per record but verified from one shared pair of
facts. The production entry is `CompositeComponent::handle` (`:11963`), which
calls `dispatch_value_with_inbound_bytes` (`:11994`), whose method match begins
at `:12250`. That function carries no `#[cfg]` attribute, unlike the
`dispatch_value` test wrapper directly above it at `:12228-12232`. Every method
arm cited below is present in that match in a default build with no feature flags
and no configuration: `authority.prepare` (`:12255`), the eleven
`authority.drain.*` arms (`:12257-12267`), `guidance.get` (`:12269`),
`dreamer.run_task` (`:12271`), `state_sync` (`:12278`), `state_import` (`:12279`),
`agent_drops.append` (`:12280`), `todo_state.set` (`:12305`), `session.recomp`
(`:12307`), `session.delete` (`:12309`). No handler in this lens is behind
`#[cfg(feature = ...)]`; the only feature-gated block in the file is
`drive-fault` at `:13229-13337`, which is outside this scope and outside every
record here. Per-record labels still state this individually, as METHOD.md rule 4
requires.

## Handler table

`Txns` counts distinct durable store transactions the handler can commit on one
successful request. "Identity" names the caller-supplied key that makes a repeat
recognisable, or says what stands in for one.

| Handler | Mutates | Txns | Identity | Returns |
| --- | --- | --- | --- | --- |
| `handle_state_import_value` (`:5591-5774`) | Compartment set for an empty session, via `commit_state_import` (`:5738-5743`) | 1 durable, after N in-memory staging calls | `import_id`, caller-supplied, capped 1..=128 bytes (`:5639`, const `:651`); preflighted (`:5678`) | `{ok, imported, duplicate}` (`:5749-5753`) or `{ok, staged}` (`:5732`) |
| `handle_agent_drops_value` (`:5776-5890`) | Pending agent-drop queue, via `append_pending_agent_drops_with_command` (`:5868-5874`) | 1 durable, preceded by one read (`:5833`) | `command_id` from `command_id_from_agent_drops_request` (`:5783`) | `{ok, queued, duplicate}` (`:5876`) or `{ok, queued, disposition?}` (`:5879-5883`) |
| `handle_todo_state_set_value` (`:5935-5974`) | `last_todo_state*` meta, via `set_todo_state` (`:5965`) | 1 | None. Content-keyed by `owner_message_id` + `sha256(normalized)` (`:5960`) | `{ok: true}` only (`:5967`) |
| `handle_session_flush_value` (`:5976-5993`) | `soft_refresh_pending`, via `arm_soft_refresh` (`:5986`) | 1 | None | `{ok, armed}` (`:5987`) |
| `handle_session_recomp_value` (`:5995-6124`) | Session cache and boundary reset (`:6077`), plus a recomp command row (`:6060`, `:6114`) | **2 on the reset path** (`:6077` then `:6114`); 1 on `nothing_to_do` (`:6060`) | `command_id`, capped 1..=128 bytes (`:6008`); replay read at `:6015` | `{ok, disposition}` (`:6017-6020`, `:6066-6069`, `:6115-6118`) |
| `handle_session_delete_value` (`:6126-6161`) | Deletes the session's durable rows, via `delete_session` (`:6140`) | 1 | **None** | `{ok, deleted_rows}` (`:6154`) |
| `handle_authority_prepare_value` (`:7169-7265`) | Authority row transition (`:7187-7239`), then the route-to-identity mapping via `bind_authority_route` (`:7250`, durable at `:4420`) | **2 when the transition lands in `MODULE`** | `(context_store_uuid, project, domain)` (`:7177`) plus an expected `generation` on `complete`/`ack`/`abort` (`:7189`, `:7217`, `:7229`). `begin` takes no generation | `{ok, authority}` (`:7258`) |
| `handle_authority_seed_value` (`:7267-7318`) | Authority seed rows | 1 | `(context_store_uuid, project, domain)` plus per-row `source_row_id` (`:7281-7291`) | `{ok, ...}` |
| `handle_authority_drain_value` (`:7320-7427`) | Authority drain state machine (`:7345`, `:7366`, `:7400`) | 1 per call | `(context_store_uuid, project, domain)` plus `generation` on every action except `begin` (`:7355`, `:7388`), plus `coordinator_token` (`:7358`, `:7392`) | `{ok, authority}` (`:7413`) |
| `handle_guidance_value` (`:7607-7723`) | `meta.guidance_date`, via `guidance_date_for_session` (`:7674`) committing at `:7751` | 0 or 1. **Can be 0 while returning success** | None | `{ok, bytes, hash, content_hash, preset, ...}` (`:7704-7722`); no field reports whether the date was persisted |
| `handle_transform_unpaged_value` (`:8007-8615`) | Project mural artifact (`:8210`), historian side channels (`:8252`), pass traces (`:8262`, `:8332`, `:8560`), then the fenced cache-state commit inside `apply_once` | **3 or more, in separate transactions** | None at the handler. The cache-state commit is fenced by `row_version`/`revert_epoch` inside `apply_once` | `TransformResponse` with `committed` (`:8522`) |
| `handle_state_sync_value` (`:8642-9125`) → `apply_state_sync_wire` (`:9127-9333`) | Full shadow state, via `apply_authority_state_sync` (`:9241-9285`), plus an in-memory capability flag (`:9288-9291`) | 1 durable, plus 1 in-memory effect | `shadow_generation` + `expected_shadow_seq` fence (`:9244-9245`); paged path adds `seed_id` + digest (`:8735-8748`) | `{ok, shadow_generation, shadow_seq, row_version, ...skipped/seeded counts}` (`:9292-9306`) |
| `handle_transform_page_value` (`:9335-9578`) | Nothing durable itself; assembles pages then delegates to the unpaged path | 0 direct | `transform_page_id` + `transform_page_digest` (consts `:636-641`) | Page ack, or the delegated transform response |
| `handle_dreamer_run_task` (`:9605-10040`) | Dream task ledger row (`:9989` failure path, `:10016` success path) | 1, after an external model call | `command_id`, 1..=256 bytes (`:9626-9631`), plus an `authority_generation` fence (`:9690-9698`); replay read at `:9819` before any producer run | Replayed ledger response (`:9820`, `:10029`) or an error (`:9995`, `:10035`) |

Read-only handlers in scope, listed for completeness and carrying no records
here: `handle_authority_status_value` (`:7134-7167`), `handle_mirror_pull_value`
(`:7429-7449`), `handle_prompt_surface_manifest_value` (`:7558-7605`),
`handle_status_value` (`:7888-7976`), `handle_session_status_value`
(`:6163-6429`).

## Observations

**O1. Validation precedes the first durable write in every handler in scope.**
This is the one broadly good result. Each handler runs shape, cap, and binding
checks before touching the store: `state_import` validates `v`, `session_id`,
`import_id`, and the batch window at `:5628-5651` and the compartment set at
`:5711-5714`, all before `commit_state_import` at `:5738`; `agent_drops` parses
the range at `:5804` and rejects an empty resolved id set at `:5858-5866` before
appending at `:5868`; `management_binding` (`:5892-5933`) gates `todo_state.set`,
`session.flush`, `session.recomp`, `session.delete`, and `dreamer.run_task` on
`v == 1`, a nonempty `session_id`, and a matching route binding before any of
them reach a store call. `todo_state.set` additionally normalises through
`injection::normalize_todo_state_json` and rejects a non-array at `:5957-5959`.
The `MAX_FACADE_FRAME_BYTES` cap (1 MiB, `:14279`) is applied to the whole
`state_import` body at `:5597` and to `state_json` at `:5948`. I found no path
where a durable write precedes input validation.

**O2. Three handlers commit more than one transaction and none declares the
ordering as a contract.** `session.recomp` resets at `:6077` and records the
command at `:6114`. `authority.prepare` transitions at `:7187-7239` and binds the
route at `:7250`. `handle_transform_unpaged_value` writes the mural artifact at
`:8210` and drains side channels at `:8252` before the fenced cache-state commit
inside `apply_once`. In all three the second-or-later step can fail while the
earlier step stays committed, and in all three the caller receives an error.

**O3. `guidance_date_for_session` has two paths that return success without
writing.** At `:7746-7748`, a session with no `row_version` returns `Ok(date_line)`
before reaching the commit. At `:7757-7763`, after two CAS conflicts the `for _ in
0..2` loop (`:7730`) falls through and returns the in-memory date. The caller sees
`{ok: true, ...}` at `:7704` either way, and no response field distinguishes a
persisted date from an unpersisted one. This is the same shape Part 3 recorded in
`intent-control-transition-write-is-silently-dropped`, where
`set_claim_intent_transition_tx` returns `Ok(())` without writing when its
`is_lower_hex` guard fails (`crates/mc-store/src/lib.rs:4124-4126`).

**O4. A third silent non-write, this one documented.** `bind_authority_route`
returns `Ok(())` without writing when `facade_binding(channel)` fails
(`:4417-4419`). Unlike O3 this is stated in the doc comment directly above:
"Unbound administrative calls have no route vocabulary to record and remain
valid" (`:4407-4409`). The behaviour and the contract agree, so this is not a
disagreement; it is a deliberate skip that a caller still cannot observe.

**O5. The historian side-channel drain result is computed and thrown away.**
`store.drain_historian_side_channels` at `:8252-8256` is bound to `let _`. The
function returns `HistorianSideChannelDrainResult` and the store fills in
`attempted`, `succeeded`, and `failed` per row
(`crates/mc-store/src/lib.rs:9572-9581`). None of those three counters reaches
the transform caller. An operator does have a channel: `status` surfaces
`historian.side_channel_pending_count` and
`historian.side_channel_last_failure`, asserted by the test at `:30037-30076`.
So the operator side is covered and the caller side is not.

**O6. Two handlers report duplicate delivery, one cannot.** `state_import`
returns `duplicate: true` from the preflight at `:5679-5685` and again from the
commit result at `:5752`. `agent_drops.append` returns `{queued: 0, duplicate:
true}` at `:5875-5877`. `todo_state.set` collapses both store outcomes into one
response: `Ok(TodoStateSetOutcome::Updated { .. }) | Ok(TodoStateSetOutcome::Noop)
=> respond(json!({ "ok": true }))` at `:5966-5968`. The store distinguishes them
(`crates/mc-store/src/lib.rs:2738-2741`) and `Updated` even carries a
`row_version` the handler discards. The `Noop` arm is a genuine content-keyed
no-op, requiring both `owner_message_id` and `state_hash` to match
(`crates/mc-store/src/lib.rs:6737-6740`), so this costs observability rather than
correctness.

**O7. `session.delete` is the only handler in scope that mutates durable state
with no caller-supplied identity at all.** `delete_session` at `:6140` is keyed by
`(session_id, project_root)`, both derived from the route binding. `deleted_rows`
at `:6154` differs between a first delivery and a repeat, so a caller cannot
retry idempotently, and a repeat is reported as a success with a different
payload. `session.flush` (`:5986`) and `todo_state.set` (`:5965`) also lack a
command id, but both are naturally content- or state-keyed and both return a
field (`armed`) or are a proven no-op; `session.delete` is destructive.

**O8. `state_sync` splits one logical operation across a durable write and an
in-memory effect, and only the durable half is fenced.**
`apply_authority_state_sync` commits at `:9241`; `set_note_evaluation_capability`
runs at `:9288-9291` inside the `Ok` arm only. The durable half is protected by
`expected_shadow_seq`, so a retry after a lost response is rejected with
`AuthoritySeqMismatch` at `:9316-9318` and the capability flag never gets set.

**O9. The paged `state_sync` replay memo is in-memory, and the durable fence
covers the gap.** The completed-seed replay at `:8735-8748` reads
`state.completed` from `self.state_sync_seeds`, returning the memoized response
when the digest matches and an error when it does not. That memo does not survive
a process restart, but `expected_shadow_seq` (`:9245`) does, so a post-restart
repeat is rejected rather than double-applied. Worth naming as a positive.

**10. `apply_state_sync_wire` pre-checks the historian phase and the store
re-checks it.** The handler reads `loaded.meta.historian.state` at `:9195-9196`
and rejects a non-idle phase at `:9204-9210`, and the store independently returns
`ModuleStateSyncError::HistorianBusy` handled at `:9319-9321`. The window between
the two reads is closed by the store's own check. This matches Part 3's
`write-predicates-are-re-evaluated-inside-the-write-transaction` and is the
correct pattern; recording it as a positive so the portfolio is not all defects.

**O11. `authority.drain` `finish` hands the store both sides of its own integrity
comparison.** At `:7371-7382` the handler reads `checksum_expected`,
`checksum_actual`, and `verified` from the request, defaulting the two checksums
to `""` and `verified` to `false`. The store's guard is `if !all_steps ||
!verified || checksum_expected != checksum_actual`
(`crates/mc-store/src/lib.rs:11911`). The `verified` default of `false` fails
closed, so an omission is safe. A caller that sends `verified: true` and omits
both checksums passes the equality test on `"" == ""`.

**O12. `authority.drain` `begin` accepts an empty lease token and a zero
expiry.** `:7336-7340` defaults `lease` to `""` and `lease_expires_at` to `0`,
then passes both to `authority_begin_drain` at `:7345`. Unlike `finish`, there is
no second predicate that fails closed on the default.

**O13. The dreamer's failure-path ledger write is unchecked; its success-path
write is not, and the code names the exact hazard.** The handler reads its ledger
at `:9819-9828` before constructing a producer at `:9848` or starting a run at
`:9878`, and the comment above that read states the stake plainly: "replaying a
command whose durable response exists would start a second billable run, so the
read fails closed and the caller retries" (`:9816-9818`). The read is duly
hardened, returning `dreamer_ledger_failed` on a read error (`:9822-9827`). The
success-path write at `:10016-10038` is equally careful: it purges only after the
row is durable (comment at `:10023-10027`), returns `dreamer_ledger_failed` when
the write fails, and deliberately leaves the child session alive so a retry can
recover it (`:10031-10034`). The failure path at `:9989-9994` binds the same store
call to `let _`. So the one write that a failed run depends on is the one whose
result is discarded, and a retry then finds no row at `:9819` and starts the second
billable run the comment warns about. The store side is sound: `INSERT OR IGNORE`
plus an unconditional read-back (`crates/mc-store/src/lib.rs:6947-6963`) makes the
row write-once and the replay stable.

**O14. `state_import` clears its staging on every commit outcome.** `complete()`
at `:5744-5747` runs before the `match outcome` at `:5748`, so a
`store_write_failed` at `:5762-5765` discards all staged batches. The caller must
resend the whole batch set. The `import_id` preflight at `:5678` means a resend
after a *successful* commit is recognised, so this is a cost and a lost-work
window rather than a double-apply.

**O15. Boundary note, not a record.** `record_no_fire` (`:5323-5336`) discards a
`store.commit` result at `:5335`. It lies in 4a's range (`4543-5589`) so it is
out of scope here, and its doc comment already states the intent: "A CAS conflict
just drops the diagnostic; it must never fail a pass" (`:5321-5322`). Flagged for
4a rather than claimed.

## Candidate properties

### h4c-recomp-reset-precedes-its-ledger-row

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `session_recomp_resets_cache_boundary_and_replays_started` (`:27313`) and `management_todo_flush_and_recomp_contracts_are_replay_safe` (`:27182`) cover the happy path and the `nothing_to_do` replay; neither injects a failure into `record_recomp_command` after a successful reset. Both are inline `lib.rs` tests, which CI never runs.
Guarantee: A `session.recomp` request never leaves the session reset without a durable recomp command row recording that the reset happened.
Check: `always` — after any `session.recomp` response, if `reset_session_for_recomp` committed for `(session_id)` then `load_recomp_command(session_id, command_id)` returns a row. `always` because the pairing must hold on every request that reaches the reset, not merely once per campaign.
Fault/timing angle: The window is `:6077` (reset committed) to `:6114` (command row written). A store write failure, process kill, or disk-full inside that window leaves the session reset and unattributed. The recomp latch from `try_claim_recomp_session` (`:6030`) is released on the way out because `_guard` drops, so a retry is admitted.
Required faults and enabling state: A session with `has_compartments` true or a nonempty `boundary_id` so `never_minted` is false at `:6058-6059`. Then a fault on the second `record_recomp_command` call at `:6114` only, not the first at `:6060`. A store-level fault injector or a `SIGKILL` between the two calls.
Confidence: high — [evidence](evidence/h4c-recomp-reset-precedes-its-ledger-row.md). Read both call sites and the intervening in-memory cache clears at `:6095-6113`; confirmed the early-return `nothing_to_do` path at `:6060-6074` writes the row without a reset, so only the `:6077`-then-`:6114` order is exposed.
Existing check: `:27313` `session_recomp_resets_cache_boundary_and_replays_started` asserts the reset and the `started` replay; it does not fault the ledger write.
Impact: The session's cache and boundary are destroyed with no record that a recomp ran. A retry with the same `command_id` finds no row at `:6015`, takes the latch again, and re-resets. The reset is CAS-guarded on a freshly loaded `row_version` (`:6077`), so the second reset commits rather than conflicting, and the caller's `command_id` has provided no protection at all.
Open questions:
- Is a second `reset_session_for_recomp` against an already-reset session materially harmful, or is it idempotent in effect? Resolving this needs `mc-store`'s reset semantics, which are Part 3's territory.

### h4c-guidance-date-returns-success-without-persisting

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `guidance_get_freezes_hashes_and_advances_only_on_busting_commit` (`:22935`) and four sibling `guidance_*` tests (`:22491`, `:22537`, `:22590`, `:22909`) exercise the served bytes; none drives two consecutive CAS conflicts or a session with no `row_version`. Inline, so never run in CI.
Guarantee: When `guidance.get` returns `ok: true`, either the date line it served is durably recorded in `meta.guidance_date`, or the response says it is not.
Check: `always` — for every `guidance.get` response with `ok: true`, `store.load(session_id).meta.guidance_date` equals the date embedded in the served `bytes`, or the response carries an explicit field saying the date is unpersisted. `always` because the response is the caller's only signal and it is emitted on every request.
Fault/timing angle: Two windows. First, `:7746-7748`: `loaded.row_version` is `None`, so the function returns the date before reaching `store.commit`. Second, `:7757-7763`: the `for _ in 0..2` loop at `:7730` exhausts both iterations on `CasConflict` (`:7753` continues without counting separately) and falls through to return the in-memory date. A concurrent transform committing twice against the same session produces the second window.
Required faults and enabling state: For the first window, a session row with no `row_version`. For the second, two `CasConflict` returns from `store.commit` on consecutive iterations, which a concurrent committer or a store fault injector supplies.
Confidence: high — [evidence](evidence/h4c-guidance-date-returns-success-without-persisting.md). Read `guidance_date_for_session` end to end, confirmed the only error return is `:7754` and that `handle_guidance_value` maps it to `store_write_failed` at `:7677-7680`, so the fall-through paths cannot surface as an error. Confirmed the response object at `:7704-7722` has no persistence field.
Existing check: `:22935` asserts hash advance on a busting commit; nothing asserts durability of `meta.guidance_date` under CAS pressure.
Impact: The agent is served a date line the store does not know about. On the next `guidance.get` the loop re-enters, and because `self.guidance_dates` memoises per session (`:7739-7745`) the same line is re-served in-process, so the divergence is invisible until the process restarts and the memo is lost, at which point the served date can change mid-session. Part 3 found the identical shape one layer down; this is the second instance.
Open questions:
- Is a two-iteration retry budget deliberate, or was `0..2` intended as "retry until settled"? The comment block does not say. (needs human input)

### h4c-authority-prepare-route-bind-is-a-second-transaction

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test in `lib.rs`'s inline module faults `bind_authority_route` after a successful authority transition. Searched the test module's function names for `authority` and `bind`; the matches cover status, drain, and generation mismatch, not this pairing.
Guarantee: An `authority.prepare` request that reports failure has committed no authority state transition.
Check: `always` — for every `authority.prepare` response that is `PreparedOutcome::Error`, the authority row's `(state, generation)` equals its value immediately before the request. `always` because the error contract applies to every request, and a caller reading an error must be able to assume nothing moved.
Fault/timing angle: The window is `:7246` (transition already committed, `row.state == "MODULE"`) to `:7250` (`bind_authority_route`). A failure inside `store.bind_authority_route` (`:4420-4424`) returns `Err`, which `:7249-7256` converts to `authority_route_binding_failed`, after the transition is durable.
Required faults and enabling state: An authority transition whose result row has `state == "MODULE"`, so the `if` at `:7248` is entered. Then a store fault on `bind_authority_route` only. Note the guard at `:4417-4419`: if `facade_binding(channel)` fails the function returns `Ok(())` without writing, so the fault must be on the store call, not the binding lookup.
Confidence: high — [evidence](evidence/h4c-authority-prepare-route-bind-is-a-second-transaction.md). Verified `bind_authority_route` is a durable store call, not an in-memory one, by reading `:4410-4425`. Verified the four transition arms at `:7187-7239` each commit independently before the bind.
Existing check: none.
Impact: The authority for a project is durably `MODULE` while the caller believes the prepare failed. The generation has advanced, so a retry of `ack` with the caller's remembered generation fails at `:7217-7226` with a generation mismatch, and the caller has no route mapping. Recovery needs an out-of-band read of `authority.status`.
Open questions:
- Should the route mapping be written inside the same transaction as the transition, or is a missing mapping recoverable by any later bound call? Deciding this is a design question about who owns the mapping. (needs human input)

### h4c-transform-writes-two-side-effects-before-its-fenced-commit

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `cc_inherits_oc_project_mural_on_a_natural_hard_without_defer_first_apply` (`:18591`) covers the mural inheritance path; it does not reject the pass afterwards. No test asserts what a rejected transform leaves behind.
Guarantee: A transform pass that returns `transform_failed` leaves no durable side effect that a successful pass would have produced.
Check: `always` — for every `handle_transform_unpaged_value` response that is `PreparedOutcome::Error { code: "transform_failed" }`, the project mural artifact and the historian side-channel delivery state are unchanged from immediately before the request. `always` because the failure contract applies per request.
Fault/timing angle: Both side effects precede the pass engine. `upsert_project_mural_artifact` commits at `:8210-8215`, `drain_historian_side_channels` at `:8252-8256`, and `trace_pass_received` at `:8262`. The rejection path is `reject_transform` at `:8330-8337`, reached from `:8338-8340`. The cache-state commit is fenced inside `apply_once` and is the *last* write, so a CAS rejection also lands here.
Required faults and enabling state: `serializer_profile == OpencodeAiSdk` and a request carrying a mural, so `host_mural_artifact` returns `Some` at `:8209`. Then any `TransformError` from `run_transform`, or a due historian side-channel row so the drain has work.
Confidence: high — [evidence](evidence/h4c-transform-writes-two-side-effects-before-its-fenced-commit.md). Confirmed the ordering by reading `:8206-8262` and the rejection arm at `:8330-8340`. Note the comments at `:8249-8250` and `:8258-8261` deliberately place the drain and the trace outside the fence; the mural write at `:8210` carries no such statement.
Existing check: `:18591` for the mural happy path only.
Impact: The mural artifact is content-keyed by `content_hash` (`:8213`), so a repeat delivery overwrites with identical bytes and the double-apply is benign. The durable damage is narrower than it looks: an artifact from a *rejected* pass becomes the project's inherited mural for later Claude Code passes via `cc_mural_input` (`:8224`). A pass whose content the engine refused still supplies the mural other sessions inherit.
Open questions:
- Is publishing a mural from a pass that then fails intended? The comment at `:8226-8228` explains CC inheritance but not the failure interaction.

### h4c-side-channel-drain-result-is-discarded-by-the-caller

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `status_diagnostics_surface_pending_historian_side_channel_failure` (`:30037`) proves the operator path works, asserting `side_channel_pending_count == 1` and a nonempty `side_channel_last_failure` at `:30073-30076`. Nothing covers the caller path, because there is nothing to cover.
Guarantee: A historian side-channel delivery that the module attempts and fails is reportable, with the attempted and succeeded counts distinguished.
Check: `always` — whenever `drain_historian_side_channels` reports `failed > 0` for a session, some surface reports a nonzero pending or failed count for that session. `always` because the reporting obligation attaches to every drain that fails, not to one per campaign.
Fault/timing angle: No interleaving needed. `:8252` binds the result to `let _`, discarding `attempted`, `succeeded`, and `failed`, which the store computes per row at `crates/mc-store/src/lib.rs:9572-9581`. A drain that fails every row on every pass produces no per-pass signal.
Required faults and enabling state: A due historian side-channel row plus a delivery failure. The store has a test seam for exactly this, `fail_next_historian_side_channel_for_test`, used at `:30041`.
Confidence: high — [evidence](evidence/h4c-side-channel-drain-result-is-discarded-by-the-caller.md). Read the store function signature and its counter arithmetic; read the module call site and confirmed `let _`. Read the status test and confirmed the operator surface exists, which bounds this finding rather than inflating it.
Existing check: `:30037` covers the operator surface via `status`. No check covers the discarded per-drain result.
Impact: Bounded by the operator surface, so this is an observability gap rather than silent loss. What is lost is the per-pass rate: `attempted` versus `succeeded` on a given pass cannot be recovered from a pending count, so a drain that is failing on every pass and one that succeeded look identical from the transform path. METHOD.md's effect-accounting rule wants attempted and acknowledged tracked separately; the store does track them and the module drops both.
Open questions:
- Does `side_channel_pending_count` distinguish "never attempted" from "attempted and failed"? Answering needs the `status` assembly in `historian_status_summary` (`:15447-15736`), which is 4d's range.

### h4c-session-delete-has-no-caller-supplied-operation-identity

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `session_delete_clears_durable_state_for_the_bound_lineage` (`:27420`) covers a single delete against a populated session. No test issues the same logical delete twice and compares responses.
Guarantee: A caller that retries `session.delete` after an unknown outcome can tell whether its first attempt applied.
Check: `always` — for two deliveries of the same logical `session.delete`, the second response either equals the first or carries an explicit duplicate marker. `always` because retry-after-unknown is available on every request.
Fault/timing angle: The unknown-outcome window is any response loss after `delete_session` commits at `:6140`. There is no ledger row to consult on the retry because the request carries no `command_id`: `management_binding` (`:5892-5933`) requires only `v` and `session_id`, and `handle_session_delete_value` adds no further identity.
Required faults and enabling state: A populated session, one successful delete, a dropped response, and a redelivery. No store fault needed.
Confidence: high — [evidence](evidence/h4c-session-delete-has-no-caller-supplied-operation-identity.md). Compared against the three handlers in scope that do carry an identity: `session.recomp` (`command_id`, `:6005-6010`), `agent_drops.append` (`command_id`, `:5783`), `state_import` (`import_id`, `:5639`). Confirmed `session.delete` reads no such field.
Existing check: `:27420` for a single delete.
Impact: `deleted_rows` at `:6154` is the row count, so a first delivery returns a positive number and a repeat returns zero, both as `ok: true`. A caller cannot distinguish "I deleted it" from "someone else did, or it was never there". Because the operation is destructive and terminal, the practical damage is low, but the retry contract is absent rather than satisfied.
Open questions:
- Is `deleted_rows == 0` on a repeat intended as the duplicate signal? Nothing documents it as one, and it collides with deleting an already-empty session.

### h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `management_todo_flush_and_recomp_contracts_are_replay_safe` (`:27182`) sends the identical `todo_state.set` twice, asserts `{ok: true}` both times (`:27192-27195` and `:27203-27206`), and asserts `row_version` is unchanged after the second (`:27208`). That test establishes the behaviour; it does not treat the collapsed response as a defect.
Guarantee: A `todo_state.set` response lets the caller tell whether the store accepted a new state or recognised a repeat.
Check: `always` — every `todo_state.set` response distinguishes `Updated` from `Noop`. `always` because it is a per-response obligation.
Fault/timing angle: None. This is a pure response-shaping gap, visible on the second delivery of any identical request with no fault at all.
Required faults and enabling state: None. Two identical `todo_state.set` requests.
Confidence: high — [evidence](evidence/h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write.md). Read the collapsed match arm at `:5966-5968`, the store's two-variant enum at `crates/mc-store/src/lib.rs:2738-2741`, and the `Noop` predicate at `crates/mc-store/src/lib.rs:6737-6740`, which requires both `owner_message_id` and `state_hash` to match. Confirmed the discarded `row_version` in `Updated { row_version }`.
Existing check: `:27182` asserts the current collapsed behaviour, so a fix would need that assertion updated. Recording that explicitly: the existing test locks in the shape this record questions.
Impact: Lowest severity in this lens, and deliberately kept because the question asked is idempotency observability. The store's no-op is genuinely content-keyed, so no double-apply exists. What the caller loses is the `row_version` from `Updated`, which it could otherwise use as a local fence, and the ability to detect that its owner or hash did not match what it expected.
Open questions:
- Is the collapsed response a deliberate contract, given `:27182` asserts it byte for byte? If so it should be documented at the handler. (needs human input)

### h4c-state-import-commit-clears-staging-on-every-outcome

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `state_import_batch_gap_and_staleness_evict_partial_attempts` (`:27013`) and `state_import_refuses_nonempty_session_without_writes` (`:26941`) cover staging eviction and a refused commit; `state_import_id_is_durable_and_wins_before_nonempty_check` (`:26967`) covers the duplicate preflight. None injects a `StateImportError::Store` on the final commit and then retries.
Guarantee: A `state_import` batch set that fails to commit for a retryable reason is either retained for retry or the caller is told it must resend everything.
Check: `always-or-unreached` — whenever `commit_state_import` returns `Err(StateImportError::Store(_))`, the response distinguishes "resend all batches" from "retry this batch". `always-or-unreached` because a store-level commit failure is an optional path that may never occur in a campaign, but must be safe when it does.
Fault/timing angle: `complete()` at `:5744-5747` executes between the commit at `:5738` and the `match outcome` at `:5748`, so the staged batch set is gone before the outcome is inspected. The `Err(StateImportError::Store(...))` arm at `:5762-5765` returns `store_write_failed` with no indication that the staging is now empty.
Required faults and enabling state: An empty session so the preflight returns `Ready` at `:5687`, a multi-batch import so `batch_count > 1`, all batches staged so `stage` returns `Apply` at `:5734`, then a store fault on `commit_state_import`.
Confidence: high — [evidence](evidence/h4c-state-import-commit-clears-staging-on-every-outcome.md). Read the ordering of `:5738`, `:5744-5747`, and `:5748` directly and confirmed `complete` is not inside any conditional. Confirmed the `import_id` preflight at `:5678-5686` recognises a *successful* prior commit, which bounds this to lost work rather than double-apply.
Existing check: `:26941`, `:26967`, `:27013` as described.
Impact: No double-apply: a resend after a commit that actually succeeded hits the preflight and returns `duplicate: true`. The cost is that a transient store error forces the caller to re-send an entire multi-batch import, and the error code gives it no way to know that. With batches capped at 1 MiB each (`:5597`) a large import is expensive to redo.
Open questions:
- Is `store_write_failed` classified as retryable by the TypeScript sender, and does it resend from batch zero? Answering needs the sender, which is outside this repository's Rust crates. Unresolved, needs the TS state-import client.

### h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the inline module has a `state_sync_before_apply_hook` seam at `:9232-9240` for interleaving, but no test drops the response after a successful apply and redelivers to check the capability flag.
Guarantee: The note-evaluation capability implied by a `state_sync` request is set whenever that request's durable state is applied.
Check: `always` — after any `state_sync` whose `apply_authority_state_sync` committed, the in-memory note-evaluation capability for the route's project matches the request's `note_evaluation_available`. `always` because the two effects are one logical operation on every request.
Fault/timing angle: The window is `:9241` (durable commit) to `:9288-9291` (capability set). The capability call sits inside the `Ok` arm, so a panic or a task cancellation between them, or a lost response followed by a retry, separates the two. On retry, `expected_shadow_seq` has advanced, so the store returns `AuthoritySeqMismatch` (`:9316-9318`) and the `Ok` arm is never reached again.
Required faults and enabling state: A `state_sync` with `note_evaluation_available: true` that commits, then a lost response, then a redelivery of the same wire with the same `expected_shadow_seq`.
Confidence: medium — [evidence](evidence/h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together.md). The ordering and the fence are verified by reading `:9241-9321`. What I did not establish is whether a later `state_sync` in the same session re-sends `note_evaluation_available`, which would self-heal the flag on the next pass; that requires the sender. Confidence is medium for that reason, not because the code reading is uncertain.
Existing check: none found.
Impact: If it does not self-heal, conditioned notes are refused for the rest of the process lifetime even though the durable state says the evaluator is available. `refuse_conditioned_note_without_evaluator` (`:15246-15445` range) is the consumer, in 4d's scope.
Open questions:
- Does the sender re-send `note_evaluation_available` on every `state_sync`, making this self-healing within one pass? Unresolved, needs the TypeScript state-sync sender.

### h4c-authority-drain-finish-compares-two-caller-supplied-checksums

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no inline test sends `authority.drain.finish` with `verified: true` and both checksum fields absent.
Guarantee: The authority drain flip cannot be completed without an independently computed checksum agreement.
Check: `always-or-unreached` — whenever `authority_finish_drain` accepts a flip, the compared checksums were computed by the store or the module, not supplied verbatim by the requester. `always-or-unreached` because a malformed or hostile finish request is an optional path that must be safe when taken.
Fault/timing angle: None; this is an input-trust question, not a race. At `:7371-7382` the handler forwards `checksum_expected`, `checksum_actual`, and `verified` from the request body, defaulting the checksums to `""` and `verified` to `false`. The store's guard at `crates/mc-store/src/lib.rs:11911` is `if !all_steps || !verified || checksum_expected != checksum_actual`.
Required faults and enabling state: An authority in `DRAINING` at the caller's expected generation with all drain steps recorded, then a `finish` request carrying `verified: true` and omitting both checksum fields.
Confidence: medium — [evidence](evidence/h4c-authority-drain-finish-compares-two-caller-supplied-checksums.md). The handler defaults and the store predicate are both read and quoted, so the mechanism is certain. What keeps this at medium is that I have not established whether the drain coordinator is a trusted in-process component or a remote caller. If the coordinator is trusted, this is a robustness gap; if it is not, it is a validation hole. Contrast `authority.prepare` `complete`, which computes the actual side itself via `authority_seed_checksum` at `:7197-7206` and only takes `checksum_expected` from the request. That asymmetry between the two paths is the strongest part of this finding.
Existing check: none found.
Impact: A finish request that asserts its own verification flips the authority without a real integrity comparison. `all_steps` still has to hold, so this is not a bare bypass.
Open questions:
- Who may send `authority.drain.finish`? The trust class decides whether this is a hole or a rough edge. (needs human input)
- `authority.drain.begin` has the weaker version of the same shape: `lease` defaults to `""` and `lease_expires_at` to `0` at `:7336-7340`, with no second predicate failing closed. Whether an empty lease token is accepted by `authority_begin_drain` is unresolved and needs `mc-store`.

### h4c-dreamer-failure-path-ledger-write-is-unchecked

Type: safety
Reachability: default-production
Status: active
Exercised: partial — four `dreamer_run_task_*` tests (`:25872`, `:25899`, `:25931`, `:25977`) cover argument rejection and a successful classify. None faults `record_dream_task_command` on the failure path.
Guarantee: A `dreamer.run_task` that fails after consuming a model call records that outcome durably, so a retry with the same `command_id` does not repeat the call.
Check: `always` — after any `dreamer.run_task` response, `load`ing the dream task command for `(ledger_session, command_id)` returns a row. `always` because the ledger is the retry contract and applies to every terminal outcome, success or failure.
Fault/timing angle: No interleaving needed. `:9989-9994` binds `record_dream_task_command` to `let _`, so a write failure there is invisible and the handler returns `dreamer_run_failed` at `:9995-9998` regardless. The success path at `:10016` does the opposite and returns the distinct code `dreamer_ledger_failed` at `:10035-10038` when its write fails.
Required faults and enabling state: A classify run that exhausts its models so `output.is_none()` at `:9983`, plus a store fault on `record_dream_task_command`. The authority gate at `:9684-9698` must pass first.
Confidence: high — [evidence](evidence/h4c-dreamer-failure-path-ledger-write-is-unchecked.md). Both call sites read and compared, and the replay contract fully traced: the handler reads the ledger at `:9819-9828` *before* constructing a producer at `:9848` or starting a run at `:9878`, and the store's write is `INSERT OR IGNORE` plus an unconditional read-back (`crates/mc-store/src/lib.rs:6947-6963`), so the row is write-once and replay-stable. The comment at `:9816-9818` names the exact hazard in the authors' own words: a missing row means "a second billable run", and the read is deliberately hardened to fail closed against it (`:9822-9827`). The unchecked write at `:9989` is therefore a hole in a protection the authors built on purpose.
Existing check: none for the failure-path ledger write. The four `dreamer_run_task_*` tests cover argument rejection and a successful classify.
Impact: A retry re-runs the producer, so the model is called twice for one logical command. This is the only handler in this lens whose repeat cost is an external paid side effect rather than a local write, which puts its severity above the row count involved. Secondary impact: the failure path returns `dreamer_run_failed` whether or not the ledger write landed, so a caller cannot distinguish "recorded as failed, do not retry" from "not recorded, a retry will re-run", while the success path does make that distinction with `dreamer_ledger_failed`.
Open questions:
- Is `let _` at `:9989` deliberate? Given `:9816-9818` names the second-billable-run hazard and `:9822-9827` hardens the read against it, an unchecked write on the other half of the same contract looks like an oversight. The alternative reading, that recording a failure is best-effort, is weakened by `:9984-9988` constructing a full replay-shaped response for storage. (needs human input)

### h4c-no-handler-in-scope-uses-the-claim-intent-ledger

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — this is a structural claim about which code paths exist; no test asserts the absence.
Guarantee: The durable operation handlers in 4c reach durable state without consulting the `(producer, operation_key)` claim intent ledger, so their idempotency rests entirely on per-handler identities.
Check: `unreachable` — no execution of any handler in `lib.rs:139-10040` enters `memory_tool::stage_claim_intent`, `inspect_claim_intents`, or `acknowledge_claim_intent`. `unreachable` and not `always(!X)` because the claim here is about three specific code locations never being entered from this scope, which is exactly what METHOD.md reserves `unreachable` for.
Fault/timing angle: None.
Required faults and enabling state: None.
Confidence: high — [evidence](evidence/h4c-no-handler-in-scope-uses-the-claim-intent-ledger.md). Grepped the whole file for `claim_intent`, `operation_key`, and `producer_id`. The only matches below `16001` are the three dispatch arms at `:10048-10050` and the three handlers at `:10082-10182`, all above this lens's `10040` ceiling and inside 4d's range. Cross-checked Part 3's `intent-identity-is-producer-and-operation-key`, which establishes the ledger's key as `(producer, operation_key)` at `crates/mc-store/src/lib.rs:1230` and its digest guard at `:11049-11051`.
Existing check: none.
Impact: This is the answer to the lens's second task rather than a defect on its own. The ledger's protections, a two-part identity plus a `request_digest` conflict check, are not available to any handler here. Each handler reinvents a narrower version: `command_id` alone for recomp, agent drops, and dreamer; `import_id` alone for state import; a generation or sequence fence for authority and state sync; and nothing for session delete. None carries a request digest, so a repeat delivery of the same `command_id` with a *different* body is not detected as a conflict by any handler in scope. That is the concrete gap the ledger would close.
Open questions:
- Should the durable request-path handlers adopt the ledger, or is per-handler identity deliberate because their bodies are host-generated rather than model-generated? (needs human input)

## Contract-vs-code leads

**L1. `guidance_date_for_session`'s doc silence versus its two non-writing
returns.** The function has no doc comment. `handle_guidance_value` maps its
`Err` to `store_write_failed` (`:7677-7680`), which reads as "this either wrote or
told you it could not". The two paths at `:7746-7748` and `:7757-7763` do
neither. Code cited both sides: the mapping at `:7677-7680`, the returns at
`:7746-7748` and `:7757-7763`. Not resolved in the doc's favour, because there is
no doc; recorded as an unstated contract.

**L2. `bind_authority_route`'s doc covers the unbound case but not the failure
case.** The comment at `:4407-4409` says "Unbound administrative calls have no
route vocabulary to record and remain valid", which correctly describes the
`Ok(())` at `:4417-4419`. It says nothing about the store call at `:4420` failing
after an authority transition has already committed, which is the path
`h4c-authority-prepare-route-bind-is-a-second-transaction` targets. Contract
covers one of the two non-writing or failing outcomes.

**L3. The transform's two "intentionally outside the fence" comments do not cover
the mural write.** `:8249-8250` justifies the side-channel drain sitting outside
the fenced commit, and `:8258-8261` justifies `trace_pass_received` on the
grounds that "a rejected pass must still leave a durable breadcrumb, and a trace
failure must never change the transform result". `upsert_project_mural_artifact`
at `:8210` is also outside the fence and carries no such justification; the
nearby comment at `:8226-8228` is about Claude Code inheritance, not about fence
placement. Both sides cited.

**L4. `record_no_fire`'s discard is documented; the dreamer's failure-path
discard is not, and its own file argues against it.** `:5321-5322` states "A CAS
conflict just drops the diagnostic; it must never fail a pass" for the `let _` at
`:5335`. The `let _` at `:9989` has no equivalent statement. Worse for the code, the
same function documents the opposite policy 170 lines earlier: `:9816-9818` says a
missing ledger row means "a second billable run", which is exactly what the
discarded write risks, and `:10023-10034` reasons at length about ledger durability
and purge ordering on the success path. Both sides cited: the hazard statement at
`:9816-9818` and the unchecked write at `:9989`.

**L5. `authority.prepare` computes its own checksum; `authority.drain.finish`
does not.** `:7197-7206` calls `store.authority_seed_checksum` and passes the
result as `actual`, taking only `expected` from the request. `:7371-7382` takes
both sides from the request. Both are in the same `impl`, 100 lines apart,
serving the same authority state machine. No comment explains the difference.

**L6. `todo_state.set`'s collapsed response is asserted by a test, so the test is
the de facto contract.** `:27192-27195` and `:27203-27206` assert `{"ok": true}`
exactly, twice. There is no doc comment on `handle_todo_state_set_value`. So the
only written statement of the contract is an assertion in a test that CI does not
run.

## Open questions

- Is `session.recomp`'s second reset harmful? Needs `reset_session_for_recomp`'s
  semantics from `mc-store`, which is Part 3's scope. Unresolved, needs Part 3.
- Does the TypeScript `state_sync` sender re-send `note_evaluation_available` on
  every request, self-healing `h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together`?
  Unresolved, needs the sender, which is outside the Rust crates.
- Does the TypeScript `state_import` client resend from batch zero on
  `store_write_failed`? Unresolved, same reason.
- Who is authorised to send `authority.drain.finish` and `authority.drain.begin`?
  The trust class decides whether `h4c-authority-drain-finish-compares-two-caller-supplied-checksums`
  and the `begin` lease defaults are holes or rough edges. (needs human input)
- Is the two-iteration CAS budget in `guidance_date_for_session` (`:7730`)
  deliberate? (needs human input)
- METHOD.md's `Exercised` field: every existing check cited in this lens lives in
  `lib.rs`'s inline test module, which the scope map establishes CI never runs
  (`part-4-module/_lenses/scope-map-and-risk-ranking.md:414-428`). I have written
  `partial` where a test exists and executes locally, and noted the CI gap in the
  field. The scope map's own open question on this ruling is still unresolved, so
  these labels may need a sweep once it is decided. (needs human input)
- Are the four in-process caches in scope for durability records? I read them only
  where a handler clears them as part of a durable operation (`:6095-6113` in
  recomp, `:6142-6153` in delete) and wrote no cache record, on the grounds that
  they hold no durable state. The scope map flags this as a 4c authoring decision
  and I have taken it that way; a reviewer may disagree.
