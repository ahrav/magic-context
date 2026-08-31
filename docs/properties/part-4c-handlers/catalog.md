# Part 4c property catalog: durable operation handlers and staging coordinators

Scope: five ranges of `crates/mc-module/src/lib.rs`, about 7,857 production lines:
`:139-3105`, `:3398-4542`, `:5591-6429`, `:7134-8005`, and `:8007-10040`, as
fixed by
[../part-4-module/_lenses/scope-map-and-risk-ranking.md](../part-4-module/_lenses/scope-map-and-risk-ranking.md).
Two neighbours are deliberately outside it and are cited rather than cataloged:
`handle_session_wrapup_value` (`:6594-7132`) and
`record_wrapup_command_if_current` (`:6521`) sit in 4a's range, and the claim
intent ledger handlers sit at `:10082-10182`, above this part's `10040` ceiling
and inside 4d's range. One out-of-part file is load-bearing and is cited
throughout because most of the durable writes land in it:
`crates/mc-store/src/lib.rs`.

Provenance. This catalog was **reconstructed from the lens files** after the
working tree was cleaned while it was untracked. Every record below is taken
verbatim from `_lenses/lens-a-durable-op-handlers.md` (twelve records, `h4c-`
prefix, plus the handler table) or `_lenses/lens-b-staging-coordinators.md`
(twelve records, `stagelc-` prefix, plus the coordinator table).
`_lenses/lens-c-claims-and-checks.md` proposed no records and supplied the
coverage context. Record text is reproduced as written by the lens agents, with
formatting adjusted (evidence links repointed from `../evidence/` to
`evidence/`) and with exactly the sixteen refinements
[portfolio-evaluation.md](portfolio-evaluation.md) records as applied. No claim
was re-derived and no line reference was re-verified against source during
reconstruction; the line references are the lens agents' own, read back
individually at their stated commits.

`HEAD` is `e447c927` ("refactor(shm): trim final review leftovers"), which is
what `existing-checks.md`, `fault-map.md`, and `portfolio-evaluation.md` state.
The two lens agents read at `b5dc778e`, one commit after the `76cd6f41` their
task named; `git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty, so
`lib.rs` is byte-identical across that span and every `lib.rs` reference holds at
all three commits. The one CI step that matters moved:
`cargo test -p mc-module --test lifecycle_cli` is `ci.yml:168` at `76cd6f41` and
`:172` at `HEAD`, and records cite whichever the lens agent used.

Reachability provenance. Twenty-two records are `default-production` and three
are `explicit-config-only`. The shared `default-production` evidence is one pair
of facts: the production entry is `CompositeComponent::handle` (`:11963`), which
calls `dispatch_value_with_inbound_bytes` (`:11994`), whose method match begins
at `:12250` and carries no `#[cfg]` attribute, unlike the `dispatch_value` test
wrapper directly above it at `:12228-12232`; and every method arm cited below is
present in that match in a default build with no feature flags and no
configuration. The three `explicit-config-only` records are all on
`handle_state_import_value` and share one piece of evidence: `state_import` is
dispatched at `:12279`, but the only sender in the shipped tree is the developer
script `packages/plugin/scripts/drive-preseed.ts:48`, so no default production
path reaches that handler. One of those three labels is a correction applied this
revision; see the refinement list at the end of this section.

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

Read-only handlers in scope, listed for completeness and carrying no records:
`handle_authority_status_value` (`:7134-7167`), `handle_mirror_pull_value`
(`:7429-7449`), `handle_prompt_surface_manifest_value` (`:7558-7605`),
`handle_status_value` (`:7888-7976`), `handle_session_status_value`
(`:6163-6429`). Listing them is a scope statement, not an argument that their
consistency needs no property; `portfolio-evaluation.md` queues that as gap G3.

## Coordinator table

Four coordinators live in scope. Three stage caller bytes across requests; the
fourth sequences store opening and is included because it is named a coordinator
and shares the abandonment question, but it stages no caller data.

| Coordinator | Steps | Durable writes per step | Terminal states | Advanced by |
| --- | --- | --- | --- | --- |
| `StateSyncSeedCoordinator` (`:939-1020`) | `Idle` -> `AwaitingSeed{generation, expected_seq}` (`:908`, armed at `:8869` or by an explicit reset) -> `Collecting(PendingStateSyncSeed)` accumulating `batches: Vec<ModuleStateSyncWire>` -> `Applying{seed_id, bytes}` (`:906-911`) | None until the terminal step. `Collecting` accumulates in process memory only. The single durable write is `apply_state_sync_wire` on the assembled seed at `:9086` | `Idle` after `release_phase`, plus an out-of-band `completed: Option<CompletedStateSyncSeed>` replay slot holding the full `PreparedOutput` (`:914-921`, set at `:9106-9116`) | The caller, one `state_sync` request per batch. `handle_state_sync_value` (`:8642-9125`) is the only advancer; nothing else drives it |
| `TransformPageCoordinator` (`:1067-1320`) | `Idle` -> `Collecting(PendingTransformPage)` accumulating `pages: Vec<Value>` -> `Applying{transform_id, bytes}` (`:1035-1039`) | None until the terminal step. The durable write is the whole unpaged transform, `handle_transform_unpaged_value` at `:9528-9536`, which commits cache state behind its own CAS | `Idle` after `release_phase` at `:9554`, plus a `completed: Option<CompletedTransformPage>` replay slot holding the full `PreparedOutput` (`:1042-1047`, set at `:9558-9568`) | The caller, one paged `transform` request per page. `handle_transform_page_value` (`:9335-9578`) is the only advancer |
| `StateImportCoordinator` (`:1340-1622`) | absent -> `Collecting(PendingStateImport)` accumulating `compartments: Vec<StoredCompartment>` -> `Applying{import_id, bytes}` (`:1334-1337`). There is no `Idle` variant; a map entry exists only while pending | None until the terminal step. `store.preflight_state_import` (`:5678`) reads durable dedup state on every batch. The single durable write is `store.commit_state_import` at `:5738-5743` | Entry removed, by `complete` (`:1415-1427`), `discard` (`:1388-1395`), or `evict_stale` (`:1397-1413`). No replay slot; replay protection is durable, via `StateImportPreflight::Duplicate` (`:5679`) | The caller, one `state_import` request per batch. `handle_state_import_value` (`:5591-5774`) is the only advancer |
| `StoreOpenCoordinator` (`:286-322`) | Not a staging machine. Coordinates waiters on a single store open with a lease-wait window and jittered backoff | None of its own; `run_store_open` (`:3543-3655`) performs the open | Waiters released; `StoreOpenWaiterGuard`'s `Drop` (`:324-332`) releases on unwind | `begin_store_open` / `run_store_open`. Out of this part's focus beyond the guard contrast |

Three structural facts fall straight out of that table and drive most of the
coordinator records.

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

## What this part is about

This part is a request surface. Its primary input is a request body and its
primary "fault" is sending the same request twice, which is why eleven of the 25
records need no injected fault of any kind. One broadly good result frames the
rest: validation precedes the first durable write in every handler in scope, and
no path was found where a durable write precedes input validation. What the
records are about is what happens after that validation passes.

**Two handlers return success without writing.** `guidance_date_for_session` has
two such paths. At `:7746-7748` a session with no `row_version` returns
`Ok(date_line)` before reaching the commit. At `:7757-7763`, after two CAS
conflicts, the `for _ in 0..2` loop (`:7730`) falls through and returns the
in-memory date. The caller sees `{ok: true, ...}` at `:7704` either way, and no
field in the response object at `:7704-7722` distinguishes a persisted date from
an unpersisted one. A third silent non-write exists and is documented:
`bind_authority_route` returns `Ok(())` without writing when
`facade_binding(channel)` fails (`:4417-4419`), and the doc comment directly
above it says why, that "Unbound administrative calls have no route vocabulary to
record and remain valid" (`:4407-4409`). The asymmetry is real and worth a
reader's attention, and this catalog deliberately does not turn it into a lesson
about documentation. Per METHOD.md rule 3 the doc establishes an obligation, not
that the obligation is right, and the missing guidance doc establishes that
nobody wrote one, not that the code is wrong. What is actually unresolved is
narrower: whether serving an unpersisted date line to a session with no row is
acceptable, and whether the response should carry a persistence field. Both are
open questions on the record, and `portfolio-evaluation.md` carries the first as
a bias needing human judgment. The no-row arm is also not unobserved:
`guidance_get_freezes_hashes_and_advances_only_on_busting_commit` (`:22935`)
dispatches `guidance.get` against a session it never commits and asserts
`row_version.is_none()` at `:23008`.

**Several handlers mutate durable state with no caller-supplied identity, and the
sharpest is destructive.** `session.delete` is the only one in scope with no
identity at all: `delete_session` at `:6140` is keyed by
`(session_id, project_root)`, both derived from the route binding, and
`management_binding` (`:5892-5933`) requires only `v` and `session_id`.
`deleted_rows` at `:6154` differs between a first delivery and a repeat, so a
caller cannot retry idempotently and a repeat is reported as a success with a
different payload. `session.flush` (`:5986`) and `todo_state.set` (`:5965`) also
lack a command id, but both are naturally content- or state-keyed and both either
return a field (`armed`) or are a proven no-op.

**No handler in scope uses the claim intent ledger, and that is an architectural
note rather than a record.** An earlier version of this catalog carried it as an
`unreachable` record over `memory_tool::stage_claim_intent`,
`inspect_claim_intents`, and `acknowledge_claim_intent`. That was wrong on two
counts. METHOD.md reserves `unreachable` for a *forbidden* code location, and
these three are not forbidden by anyone: `handle_facade_value` (`:10042`)
dispatches all three method names at `:10048-10050` and the handlers they reach
(`:10082-10182`) are ordinary facade paths production traffic is expected to
enter. And what the claim asserts is the absence of a *call edge* from one line
range to another, which is static architecture that no execution witnesses. A
contextual check was available, comparing the claim-intent tables before and
after each 4c durable request, and it was rejected: it asserts the status quo, so
a green run means "still not using the ledger" and the day a handler adopted the
ledger the check would fail on the improvement. A property whose passing
condition is the absence of a mechanism someone may reasonably add is a freeze,
not a property.

The substance is kept here in full. The ledger's protections, a two-part
`(producer, operation_key)` identity plus a `request_digest` conflict check
(established by Part 3's `intent-identity-is-producer-and-operation-key` at
`crates/mc-store/src/lib.rs:1230`, digest guard `:11049-11051`), are not
available to any handler in this part. Each handler reinvents a narrower version:
`command_id` alone for recomp, agent drops, and the dreamer; `import_id` alone
for state import; a generation or sequence fence for authority and state sync;
and nothing for `session.delete`. **None carries a request digest**, so a repeat
delivery of the same `command_id` with a *different* body is not detected as a
conflict by any handler in scope. That is the concrete gap the ledger would
close, and whether the durable request-path handlers should adopt it, or whether
per-handler identity is deliberate because their bodies are host-generated rather
than model-generated, still needs human input.

**Several operations span more than one transaction, and none declares the
ordering as a contract.** `session.recomp` resets at `:6077` and records the
command at `:6114`. `authority.prepare` transitions at `:7187-7239` and binds the
route at `:7250`. `handle_transform_unpaged_value` writes the mural artifact at
`:8210` and drains side channels at `:8252` before the fenced cache-state commit
inside `apply_once`. In all three the second-or-later step can fail while the
earlier step stays committed, and in all three the caller receives an error. Two
of the transform's out-of-fence writes carry comments justifying their placement
(`:8249-8250` for the drain, `:8258-8261` for the trace); the mural write at
`:8210` carries none.

**The dreamer names its own hazard and then drops the guard.** The handler reads
its ledger at `:9819-9828` before constructing a producer at `:9848` or starting
a run at `:9878`, and the comment above that read states the stake plainly:
replaying a command whose durable response exists "would start a second billable
run, so the read fails closed and the caller retries" (`:9816-9818`). The read is
duly hardened, returning `dreamer_ledger_failed` on a read error (`:9822-9827`),
and the success-path write at `:10016-10038` is equally careful, purging only
after the row is durable and leaving the child session alive so a retry can
recover it. The failure path at `:9989-9994` binds the same store call to
`let _`. So the one write a failed run depends on is the one whose result is
discarded, and a retry then finds no row at `:9819` and starts the second
billable run the comment warns about.

**Staged state is unevenly reaped.** `STATE_SYNC_SEED_COLLECTOR_TTL` is 10
minutes (`:627`). `STATE_IMPORT_STALE_AFTER` is 5 minutes, declared at `:654` and
wired at `:1357`. Both reapers are self-driven, with one call site each, `:8860`
for seeds and `:1441` for imports, so both TTLs are honoured only under
continuing traffic of the same kind, which is exactly the traffic an abandoning
sender stops sending. Transform pages have no reaper at all: no TTL constant in
the block at `:596-669`, no `evict_stale*` method in `:1107-1320`, and `discard`
at `:1131-1144` clears the phase and the `completed` slot while never removing
the `sessions` map entry, so the map is append-only for the process lifetime.

### Coverage

There are **69 claim-bearing in-scope tests** among the crate's 256 test
functions. **None of them executes in CI.** Two integration binaries do drive the
real handlers end to end through a real `McHandler`, three tests between them
(`direct_host.rs:67`, `direct_host.rs:149`, `host_adapter.rs:102`), and neither
binary runs: the only `mc-module` invocation in any workflow is
`cargo test -p mc-module --test lifecycle_cli`, which selects one integration
binary and does not build `--lib`. So every `Existing check:` line below is a
local-only check, and "partial" in an `Exercised:` line means a test exists on a
developer's machine.

### Refinements applied

`portfolio-evaluation.md` records **sixteen refinements, all applied, none
rejected**, taking the record count **24 to 25**. Three of them change the count
and they net to plus one:

- **F1** removes the ledger `unreachable` record and recasts it as the
  architectural note above, because "no call edge from this sub-part" is static
  architecture rather than a forbidden code point.
- **F7** splits the combined reaper record into
  `stagelc-seed-reaper-only-runs-on-fresh-traffic` and
  `stagelc-state-import-reaper-only-runs-on-fresh-traffic`, which differ in TTL,
  clock seam, existing coverage, and reachability class; the combined record
  carried both classes in one label, which METHOD.md rule 4 forbids.
- **F13** splits the restart marker into
  `stagelc-a-graceful-shutdown-is-observed-with-staged-state-present` and
  `stagelc-an-abrupt-restart-is-observed-with-staged-state-present`, because only
  the graceful path executes the reset at `:12095-12099` and each safety record
  leans on a different boundary form.

The other thirteen edit fields rather than counts: **F2** corrects the state-sync
split-state workload (the existing hook fires before the commit and the two
effects are synchronous, so only a kill or panic between them splits them);
**F3** withdraws the "no store-side write-failure injector" claim and marks four
records' faults constructible through an aborting trigger installed via
`execute_tag_sql_for_test`; **F4** links the guidance no-row check that was said
not to exist; **F5**, **F6**, **F9**, **F10**, **F11** and **F12** fix six checks
or markers that could not fail on their own record's scenario; **F8** corrects
`h4c-state-import-commit-clears-staging-on-every-outcome` from
`default-production` to `explicit-config-only` to match its two siblings on the
same dispatch path; **F14** narrows the cross-part equivalence from three sites
to two; **F15** deflates the success-without-writing headline, which is why the
prose above states the open questions instead of pre-empting them; and **F16**
edits `fault-map.md` only.

Final distributions after the disposition: **20 `always`, 2
`always-or-unreached`, 3 `sometimes`, 0 `reachable`, 0 `unreachable`**;
**19 safety, 3 liveness, 3 reachability**; **22 `default-production`, 3
`explicit-config-only`, 0 `test-only`**. `always(!X)` is counted as `always`,
following the convention Parts 4a and 4b used.

One process caveat, inherited and restated. METHOD.md step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 25.
**Evidence files remain at 24.** Both halves of the F7 split link
`evidence/stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md` and both
halves of the F13 split link
`evidence/stagelc-a-restart-is-observed-with-staged-state-present.md`, so every
link in this catalog resolves, but two files each serve two records and need to
become four. `evidence/h4c-no-handler-in-scope-uses-the-claim-intent-ledger.md`
documents the record F1 removed and is now orphaned; its content is preserved in
the architectural note above. The affected records say so at their `Confidence:`
lines.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [h4c-recomp-reset-precedes-its-ledger-row](#h4c-recomp-reset-precedes-its-ledger-row) | safety | high |
| [h4c-authority-prepare-route-bind-is-a-second-transaction](#h4c-authority-prepare-route-bind-is-a-second-transaction) | safety | high |
| [h4c-transform-writes-two-side-effects-before-its-fenced-commit](#h4c-transform-writes-two-side-effects-before-its-fenced-commit) | safety | high |
| [h4c-guidance-date-returns-success-without-persisting](#h4c-guidance-date-returns-success-without-persisting) | safety | high |
| [h4c-dreamer-failure-path-ledger-write-is-unchecked](#h4c-dreamer-failure-path-ledger-write-is-unchecked) | safety | high |
| [h4c-side-channel-drain-result-is-discarded-by-the-caller](#h4c-side-channel-drain-result-is-discarded-by-the-caller) | safety | high |
| [h4c-session-delete-has-no-caller-supplied-operation-identity](#h4c-session-delete-has-no-caller-supplied-operation-identity) | safety | high |
| [h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write](#h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write) | safety | high |
| [h4c-state-import-commit-clears-staging-on-every-outcome](#h4c-state-import-commit-clears-staging-on-every-outcome) | safety | high |
| [h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together](#h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together) | safety | medium |
| [h4c-authority-drain-finish-compares-two-caller-supplied-checksums](#h4c-authority-drain-finish-compares-two-caller-supplied-checksums) | safety | medium |
| [stagelc-transform-page-session-map-has-no-removal-path](#stagelc-transform-page-session-map-has-no-removal-path) | safety | high |
| [stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session](#stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session) | safety | high |
| [stagelc-seed-pending-count-is-never-incremented](#stagelc-seed-pending-count-is-never-incremented) | safety | high |
| [stagelc-completed-replay-results-are-uncharged-and-unexpiring](#stagelc-completed-replay-results-are-uncharged-and-unexpiring) | safety | high |
| [stagelc-abandoned-page-collection-is-released-within-a-bounded-window](#stagelc-abandoned-page-collection-is-released-within-a-bounded-window) | liveness | high |
| [stagelc-seed-reaper-only-runs-on-fresh-traffic](#stagelc-seed-reaper-only-runs-on-fresh-traffic) | liveness | high |
| [stagelc-state-import-reaper-only-runs-on-fresh-traffic](#stagelc-state-import-reaper-only-runs-on-fresh-traffic) | liveness | high |
| [stagelc-state-import-discard-runs-before-the-binding-check](#stagelc-state-import-discard-runs-before-the-binding-check) | safety | high |
| [stagelc-staged-state-does-not-survive-a-restart](#stagelc-staged-state-does-not-survive-a-restart) | safety | high |
| [stagelc-restart-drops-the-only-page-level-replay-guard](#stagelc-restart-drops-the-only-page-level-replay-guard) | safety | medium |
| [stagelc-applying-phase-has-no-unwind-guard](#stagelc-applying-phase-has-no-unwind-guard) | safety | high |
| [stagelc-a-coordination-is-observed-mid-sequence](#stagelc-a-coordination-is-observed-mid-sequence) | reachability | high |
| [stagelc-a-graceful-shutdown-is-observed-with-staged-state-present](#stagelc-a-graceful-shutdown-is-observed-with-staged-state-present) | reachability | high |
| [stagelc-an-abrupt-restart-is-observed-with-staged-state-present](#stagelc-an-abrupt-restart-is-observed-with-staged-state-present) | reachability | high |

Group names below are this reconstruction's, chosen by mechanism, except where
`portfolio-evaluation.md` pins a letter: F4 and F15 place the guidance record and
the success-without-writing prose in Group A, F1 leaves Group B at two records
after removing the ledger record, F7 places the reapers in Group E, and F13
places the restart markers in Group H. The vocabulary follows `fault-map.md`'s
own section headings where they apply.

---

## Group A: multi-transaction ordering and the writes nobody checks

Six records on handlers that reach durable state through more than one write, or
through a write whose result they discard. The first three are ordering records:
an earlier transaction commits, a later step fails, and the caller is told the
request failed. The last three are the discard family: a success returned without
the write it implies, a `let _` on the one write a retry depends on, and a drain
result thrown away at the call site. All six share one mechanism, that the
handler's error contract is weaker than a caller reading it would assume.

### h4c-recomp-reset-precedes-its-ledger-row

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `session_recomp_resets_cache_boundary_and_replays_started` (`:27313`) and `management_todo_flush_and_recomp_contracts_are_replay_safe` (`:27182`) cover the happy path and the `nothing_to_do` replay; neither injects a failure into `record_recomp_command` after a successful reset. Both are inline `lib.rs` tests, which CI never runs.
Guarantee: A `session.recomp` request never leaves the session reset without a durable recomp command row recording that the reset happened.
Check: `always` — after any `session.recomp` response, if `reset_session_for_recomp` committed for `(session_id)` then `load_recomp_command(session_id, command_id)` returns a row. `always` because the pairing must hold on every request that reaches the reset, not merely once per campaign.
Fault/timing angle: The window is `:6077` (reset committed) to `:6114` (command row written). A store write failure, process kill, or disk-full inside that window leaves the session reset and unattributed. The recomp latch from `try_claim_recomp_session` (`:6030`) is released on the way out because `_guard` drops, so a retry is admitted.
Required faults and enabling state: A session with `has_compartments` true or a nonempty `boundary_id` so `never_minted` is false at `:6058-6059`. Then a fault on the second `record_recomp_command` call at `:6114` only, not the first at `:6060`. **Constructible today, revised this disposition (F3):** a `BEFORE INSERT` trigger carrying `RAISE(ABORT, ...)` on `mc_recomp_commands` (`crates/mc-store/src/lib.rs:6816-6822`), installed through `execute_tag_sql_for_test` (`mc-store:6431-6440`), fails that write, and `RAISE(ABORT)` is not swallowed by the statement's `INSERT OR IGNORE`. Call-site precision is free here rather than difficult: the two `record_recomp_command` sites are on mutually exclusive branches, the `nothing_to_do` early return at `:6060-6074` versus the reset path, so a blanket trigger on the table hits only the call this record targets on a reset-path request. A `SIGKILL` between the two calls remains an alternative.
Confidence: high — [evidence](evidence/h4c-recomp-reset-precedes-its-ledger-row.md). Read both call sites and the intervening in-memory cache clears at `:6095-6113`; confirmed the early-return `nothing_to_do` path at `:6060-6074` writes the row without a reset, so only the `:6077`-then-`:6114` order is exposed.
Existing check: `:27313` `session_recomp_resets_cache_boundary_and_replays_started` asserts the reset and the `started` replay; it does not fault the ledger write.
Impact: The session's cache and boundary are destroyed with no record that a recomp ran. A retry with the same `command_id` finds no row at `:6015`, takes the latch again, and re-resets. The reset is CAS-guarded on a freshly loaded `row_version` (`:6077`), so the second reset commits rather than conflicting, and the caller's `command_id` has provided no protection at all.
Open questions:

- Is a second `reset_session_for_recomp` against an already-reset session
  materially harmful, or is it idempotent in effect? Resolving this needs
  `mc-store`'s reset semantics, which are Part 3's territory.

### h4c-authority-prepare-route-bind-is-a-second-transaction

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test in `lib.rs`'s inline module faults `bind_authority_route` after a successful authority transition. Searched the test module's function names for `authority` and `bind`; the matches cover status, drain, and generation mismatch, not this pairing.
Guarantee: An `authority.prepare` request that reports failure has committed no authority state transition.
Check: `always` — for every `authority.prepare` response that is `PreparedOutcome::Error`, the authority row's `(state, generation)` equals its value immediately before the request. `always` because the error contract applies to every request, and a caller reading an error must be able to assume nothing moved.
Fault/timing angle: The window is `:7246` (transition already committed, `row.state == "MODULE"`) to `:7250` (`bind_authority_route`). A failure inside `store.bind_authority_route` (`:4420-4424`) returns `Err`, which `:7249-7256` converts to `authority_route_binding_failed`, after the transition is durable.
Required faults and enabling state: An authority transition whose result row has `state == "MODULE"`, so the `if` at `:7248` is entered. Then a store fault on `bind_authority_route` only. Note the guard at `:4417-4419`: if `facade_binding(channel)` fails the function returns `Ok(())` without writing, so the fault must be on the store call, not the binding lookup. **Constructible today, revised this disposition (F3):** a `BEFORE INSERT` trigger with `RAISE(ABORT, ...)` on `mc_authority_route_bindings` (`mc-store:5124-5132`), installed through `execute_tag_sql_for_test`, fails exactly that call and nothing else in the request, since the transition arms write other tables. Two facts were checked before accepting the route: `RAISE(ABORT)` does fire under `ON CONFLICT ... DO UPDATE`, which is this statement's form, and `with_note_conn_fenced` (`mc-store:5323-5343`) delegates to the same `inner.with_conn_fenced` rather than a separate database, so a trigger installed through the tag-SQL seam applies.
Confidence: high — [evidence](evidence/h4c-authority-prepare-route-bind-is-a-second-transaction.md). Verified `bind_authority_route` is a durable store call, not an in-memory one, by reading `:4410-4425`. Verified the four transition arms at `:7187-7239` each commit independently before the bind.
Existing check: none.
Impact: The authority for a project is durably `MODULE` while the caller believes the prepare failed. The generation has advanced, so a retry of `ack` with the caller's remembered generation fails at `:7217-7226` with a generation mismatch, and the caller has no route mapping. Recovery needs an out-of-band read of `authority.status`.
Open questions:

- Should the route mapping be written inside the same transaction as the
  transition, or is a missing mapping recoverable by any later bound call?
  Deciding this is a design question about who owns the mapping. (needs human
  input)

### h4c-transform-writes-two-side-effects-before-its-fenced-commit

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `cc_inherits_oc_project_mural_on_a_natural_hard_without_defer_first_apply` (`:18591`) covers the mural inheritance path; it does not reject the pass afterwards. No test asserts what a rejected transform leaves behind.
Guarantee: A transform pass that returns `transform_failed` leaves no durable side effect that a successful pass would have produced.
Check: `always` — for every `handle_transform_unpaged_value` response that is `PreparedOutcome::Error { code: "transform_failed" }`, the project mural artifact and the historian side-channel delivery state are unchanged from immediately before the request. `always` because the failure contract applies per request.
Fault/timing angle: Both side effects precede the pass engine. `upsert_project_mural_artifact` commits at `:8210-8215`, `drain_historian_side_channels` at `:8252-8256`, and `trace_pass_received` at `:8262`. The rejection path is `reject_transform` at `:8330-8337`, reached from `:8338-8340`. The cache-state commit is fenced inside `apply_once` and is the *last* write, so a CAS rejection also lands here.
Required faults and enabling state: `serializer_profile == OpencodeAiSdk` and a request carrying a mural, so `host_mural_artifact` returns `Some` at `:8209`. Then any `TransformError` from `run_transform`, or a due historian side-channel row so the drain has work. No injected fault is needed: the pass engine's own rejections are reachable from a crafted request, and `transform_failed` has exactly one site (`:8334`), so the rejection is unambiguous to observe.
Confidence: high — [evidence](evidence/h4c-transform-writes-two-side-effects-before-its-fenced-commit.md). Confirmed the ordering by reading `:8206-8262` and the rejection arm at `:8330-8340`. Note the comments at `:8249-8250` and `:8258-8261` deliberately place the drain and the trace outside the fence; the mural write at `:8210` carries no such statement.
Existing check: `:18591` for the mural happy path only.
Impact: The mural artifact is content-keyed by `content_hash` (`:8213`), so a repeat delivery overwrites with identical bytes and the double-apply is benign. The durable damage is narrower than it looks: an artifact from a *rejected* pass becomes the project's inherited mural for later Claude Code passes via `cc_mural_input` (`:8224`). A pass whose content the engine refused still supplies the mural other sessions inherit.
Open questions:

- Is publishing a mural from a pass that then fails intended? The comment at
  `:8226-8228` explains CC inheritance but not the failure interaction.

### h4c-guidance-date-returns-success-without-persisting

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the no-row arm is already driven. `guidance_get_freezes_hashes_and_advances_only_on_busting_commit` (`:22935`) binds a second route at `:22991`, never commits a row for that session, dispatches `guidance.get` at `:22996-23005`, matches a `PreparedOutcome::Response`, and asserts `store.load("other").unwrap().row_version.is_none()` at `:23008`, which is the `:7746-7748` arm driven through the handler with the assertion made against the store. What no test covers is the second clause, that the response disclose the non-persistence, and no test drives two consecutive CAS conflicts. Inline, so never run in CI. (Corrected this disposition, F4: an earlier version of this line said no test drives a session with no `row_version`, which is false.)
Guarantee: When `guidance.get` returns `ok: true`, either the date line it served is durably recorded in `meta.guidance_date`, or the response says it is not.
Check: `always` — for every `guidance.get` response with `ok: true`, `store.load(session_id).meta.guidance_date` equals the date embedded in the served `bytes`, or the response carries an explicit field saying the date is unpersisted. `always` because the response is the caller's only signal and it is emitted on every request.
Fault/timing angle: Two windows. First, `:7746-7748`: `loaded.row_version` is `None`, so the function returns the date before reaching `store.commit`. Second, `:7757-7763`: the `for _ in 0..2` loop at `:7730` exhausts both iterations on `CasConflict` (`:7753` continues without counting separately) and falls through to return the in-memory date. A concurrent transform committing twice against the same session produces the second window.
Required faults and enabling state: For the first window, a session row with no `row_version`, which `mc-store:5500-5505` returns for any session with no row, so the setup cost is nil. For the second, two `CasConflict` returns from `store.commit` on consecutive iterations. The loop reloads `store.load` at `:7731` on every iteration and commits at `:7751`, so a conflict needs a writer landing between those two lines twice, and this function has no hook: the second window needs contention rather than seeded state and cannot be produced deterministically today.
Confidence: high — [evidence](evidence/h4c-guidance-date-returns-success-without-persisting.md). Read `guidance_date_for_session` end to end, confirmed the only error return is `:7754` and that `handle_guidance_value` maps it to `store_write_failed` at `:7677-7680`, so the fall-through paths cannot surface as an error. Confirmed the response object at `:7704-7722` has no persistence field.
Existing check: `:22991-23008`, inside `guidance_get_freezes_hashes_and_advances_only_on_busting_commit` (`:22935`), asserts no row exists after a `guidance.get` against an uncommitted session; it does not assert that the response disclosed it. `:22935` also asserts hash advance on a busting commit. Nothing asserts durability of `meta.guidance_date` under CAS pressure. Status `unaudited`.
Impact: The agent is served a date line the store does not know about. On the next `guidance.get` the loop re-enters, and because `self.guidance_dates` memoises per session (`:7739-7745`) the same line is re-served in-process, so the divergence is invisible until the process restarts and the memo is lost, at which point the served date can change mid-session. Part 3 found the identical shape one layer down; this is the second instance.
Open questions:

- Is a two-iteration retry budget deliberate, or was `0..2` intended as "retry
  until settled"? The comment block does not say. (needs human input)
- Is the no-row path intentionally ephemeral, meaning a session with no row has no
  durable state to attach a date to and the in-process memo at `:7739-7745` is the
  intended home until the session commits something? The evidence is balanced and
  METHOD.md rule 3 forbids resolving it from the absence of a doc comment.
  `portfolio-evaluation.md` carries this as bias 2. (needs human input)

### h4c-dreamer-failure-path-ledger-write-is-unchecked

Type: safety
Reachability: default-production
Status: active
Exercised: partial — four `dreamer_run_task_*` tests (`:25872`, `:25899`, `:25931`, `:25977`) cover argument rejection and a successful classify. None faults `record_dream_task_command` on the failure path.
Guarantee: A `dreamer.run_task` that fails after consuming a model call records that outcome durably, so a retry with the same `command_id` does not repeat the call.
Check: `always` — for any `dreamer.run_task` response **that consumed a model attempt**, `load`ing the dream task command for `(ledger_session, command_id)` returns a row. `always` because the ledger is the retry contract and applies to every terminal outcome, success or failure, that spent a billable run. The conditioning is a correction applied this disposition (F6): three response paths are supposed to leave no row, and an unconditional form was false against a correct implementation on all three. Argument rejection returns before the ledger is touched; the authority gate at `:9684-9698` returns before it; and the in-flight duplicate guard returns `dreamer_run_failed` at `:9803-9809` with no write **by design**, documented at `:9786-9789` as "the loser returns without any ledger write; its retry replays the winner's recorded response".
Fault/timing angle: No interleaving is needed for the main window. `:9989-9994` binds `record_dream_task_command` to `let _`, so a write failure there is invisible and the handler returns `dreamer_run_failed` at `:9995-9998` regardless. The success path at `:10016` does the opposite and returns the distinct code `dreamer_ledger_failed` at `:10035-10038` when its write fails. The duplicate-guard half does need concurrency: the key is inserted into `inflight_dream_commands` at `:9802` and `DreamCommandGuard` (`:9811-9814`) removes it when the call returns, so two sequential deliveries never see it and two overlapping in-flight calls are required.
Required faults and enabling state: For the main window, a classify run that exhausts its models so `output.is_none()` at `:9983`, plus a store fault on `record_dream_task_command`. The authority gate at `:9684-9698` must pass first. **Constructible today, revised this disposition (F3):** the model-exhaustion state is already reachable, since the fixture at `:25806-25810` poisons the route model chain to prove the classify loop ignores it, and the unchecked write is inducible by an aborting trigger on `mc_dream_task_commands` (`mc-store:6945-6951`) installed via `execute_tag_sql_for_test`, with `RAISE(ABORT)` not swallowed by the `INSERT OR IGNORE`. For the duplicate-guard half, two **concurrent** deliveries, which means two tasks and a way to hold the first inside its run.
Confidence: high — [evidence](evidence/h4c-dreamer-failure-path-ledger-write-is-unchecked.md). Both call sites read and compared, and the replay contract fully traced: the handler reads the ledger at `:9819-9828` *before* constructing a producer at `:9848` or starting a run at `:9878`, and the store's write is `INSERT OR IGNORE` plus an unconditional read-back (`crates/mc-store/src/lib.rs:6947-6963`), so the row is write-once and replay-stable. The comment at `:9816-9818` names the exact hazard in the authors' own words: a missing row means "a second billable run", and the read is deliberately hardened to fail closed against it (`:9822-9827`). The unchecked write at `:9989` is therefore a hole in a protection the authors built on purpose.
Existing check: none for the failure-path ledger write. The four `dreamer_run_task_*` tests cover argument rejection and a successful classify.
Impact: A retry re-runs the producer, so the model is called twice for one logical command. This is the only handler in this part whose repeat cost is an external paid side effect rather than a local write, which puts its severity above the row count involved. Secondary impact: the failure path returns `dreamer_run_failed` whether or not the ledger write landed, so a caller cannot distinguish "recorded as failed, do not retry" from "not recorded, a retry will re-run", while the success path does make that distinction with `dreamer_ledger_failed`. The collision is observable from the three `dreamer_run_failed` sites at `:9804`, `:9968` and `:9996`, in two of which no ledger row exists by design.
Open questions:

- Is `let _` at `:9989` deliberate? Given `:9816-9818` names the
  second-billable-run hazard and `:9822-9827` hardens the read against it, an
  unchecked write on the other half of the same contract looks like an oversight.
  The alternative reading, that recording a failure is best-effort, is weakened by
  `:9984-9988` constructing a full replay-shaped response for storage. (needs
  human input)

### h4c-side-channel-drain-result-is-discarded-by-the-caller

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `status_diagnostics_surface_pending_historian_side_channel_failure` (`:30037`) proves the operator path works, asserting `side_channel_pending_count == 1` and a nonempty `side_channel_last_failure` at `:30073-30076`. Nothing covers the caller path, because there is nothing to cover.
Guarantee: A historian side-channel delivery that the module attempts and fails is reportable, with the attempted and succeeded counts distinguished.
Check: `always` — whenever `drain_historian_side_channels` reports `failed > 0` for a session, some surface reports that drain's `attempted` and `succeeded` as **separate values**. `always` because the reporting obligation attaches to every drain that fails, not to one per campaign. The separation is a correction applied this disposition (F5): the earlier form asked only that some surface report a nonzero pending or failed count, and a pending count is a backlog depth that cannot separate a pass which attempted ten and succeeded zero from one that attempted ten and succeeded ten, which is exactly the loss the `Impact` line describes. The store already computes all three counters per row (`mc-store:9572`, `:9575`, `:9581`), so the check compares a surface against values that exist and are discarded.
Fault/timing angle: No interleaving needed. `:8252` binds the result to `let _`, discarding `attempted`, `succeeded`, and `failed`, which the store computes per row at `crates/mc-store/src/lib.rs:9572-9581`. A drain that fails every row on every pass produces no per-pass signal.
Required faults and enabling state: A due historian side-channel row plus a delivery failure. The store has a test seam for exactly this, `fail_next_historian_side_channel_for_test` (`mc-store:5249`), used at `:30041`.
Confidence: high — [evidence](evidence/h4c-side-channel-drain-result-is-discarded-by-the-caller.md). Read the store function signature and its counter arithmetic; read the module call site and confirmed `let _`. Read the status test and confirmed the operator surface exists, which bounds this finding rather than inflating it.
Existing check: `:30037` covers the operator surface via `status`. No check covers the discarded per-drain result.
Impact: Bounded by the operator surface, so this is an observability gap rather than silent loss. What is lost is the per-pass rate: `attempted` versus `succeeded` on a given pass cannot be recovered from a pending count, so a drain that is failing on every pass and one that succeeded look identical from the transform path. METHOD.md's effect-accounting rule wants attempted and acknowledged tracked separately; the store does track them and the module drops both.
Open questions:

- Does `side_channel_pending_count` distinguish "never attempted" from "attempted
  and failed"? Answering needs the `status` assembly in
  `historian_status_summary` (`:15447-15736`), which is 4d's range.

## Group B: repeat delivery and caller-supplied identity

Two records on whether a caller can tell a repeat from a first delivery. They are
the two ends of the severity range in this part: `session.delete` is destructive
and carries no identity at all, and `todo_state.set` is a proven content-keyed
no-op whose response merely collapses two distinguishable store outcomes into
one. This group held a third record, the claim intent ledger's absence, until the
independent evaluation established it was not a valid `unreachable`; its content
is now the architectural note in the section above.

### h4c-session-delete-has-no-caller-supplied-operation-identity

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `session_delete_clears_durable_state_for_the_bound_lineage` (`:27420`) covers a single delete against a populated session. No test issues the same logical delete twice and compares responses.
Guarantee: A caller that retries `session.delete` after an unknown outcome can tell whether its first attempt applied.
Check: `always` — for two deliveries of the same logical `session.delete`, the second response either equals the first or carries an explicit duplicate marker. `always` because retry-after-unknown is available on every request.
Fault/timing angle: The unknown-outcome window is any response loss after `delete_session` commits at `:6140`. There is no ledger row to consult on the retry because the request carries no `command_id`: `management_binding` (`:5892-5933`) requires only `v` and `session_id`, and `handle_session_delete_value` adds no further identity.
Required faults and enabling state: A populated session, one successful delete, a dropped response, and a redelivery. No store fault needed; the second call is the observation, so this is the cheapest oracle in the part.
Confidence: high — [evidence](evidence/h4c-session-delete-has-no-caller-supplied-operation-identity.md). Compared against the three handlers in scope that do carry an identity: `session.recomp` (`command_id`, `:6005-6010`), `agent_drops.append` (`command_id`, `:5783`), `state_import` (`import_id`, `:5639`). Confirmed `session.delete` reads no such field.
Existing check: `:27420` for a single delete.
Impact: `deleted_rows` at `:6154` is the row count, so a first delivery returns a positive number and a repeat returns zero, both as `ok: true`. A caller cannot distinguish "I deleted it" from "someone else did, or it was never there". Because the operation is destructive and terminal, the practical damage is low, but the retry contract is absent rather than satisfied.
Open questions:

- Is `deleted_rows == 0` on a repeat intended as the duplicate signal? Nothing
  documents it as one, and it collides with deleting an already-empty session.

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
Impact: Lowest severity in this part, and deliberately kept because the question asked is idempotency observability. The store's no-op is genuinely content-keyed, so no double-apply exists. What the caller loses is the `row_version` from `Updated`, which it could otherwise use as a local fence, and the ability to detect that its owner or hash did not match what it expected.
Open questions:

- Is the collapsed response a deliberate contract, given `:27182` asserts it byte
  for byte? If so it should be documented at the handler. (needs human input)

## Group C: fences, input trust, and halves that are not replayed together

Three records on operations whose protection is a fence or a predicate rather than
a ledger, and on what that protection does not cover. The state-import commit
clears its staging before it inspects the outcome, so a retryable failure costs the
whole batch set. The state-sync durable write is fenced and its in-memory sibling
effect is not, so the fence that makes a retry safe is also what stops the retry
from completing the operation. And the authority drain's `finish` hands the store
both sides of an integrity comparison the store then performs, which a sibling arm
100 lines away does not do.

### h4c-state-import-commit-clears-staging-on-every-outcome

Type: safety
Reachability: explicit-config-only — corrected this disposition (F8) from `default-production`, which contradicted the two sibling records on the identical dispatch path. `state_import` is dispatched at `:12279`, but the only sender in the shipped tree is the developer script `packages/plugin/scripts/drive-preseed.ts:48`, so no default production path reaches this handler. The record is constructible in a test regardless of the production class.
Status: active
Exercised: partial — `state_import_batch_gap_and_staleness_evict_partial_attempts` (`:27013`) and `state_import_refuses_nonempty_session_without_writes` (`:26941`) cover staging eviction and a refused commit; `state_import_id_is_durable_and_wins_before_nonempty_check` (`:26967`) covers the duplicate preflight. None injects a `StateImportError::Store` on the final commit and then retries.
Guarantee: A `state_import` batch set that fails to commit for a retryable reason is either retained for retry or the caller is told it must resend everything.
Check: `always-or-unreached` — whenever `commit_state_import` returns `Err(StateImportError::Store(_))`, the response distinguishes "resend all batches" from "retry this batch". `always-or-unreached` because a store-level commit failure is an optional path that may never occur in a campaign, but must be safe when it does.
Fault/timing angle: `complete()` at `:5744-5747` executes between the commit at `:5738` and the `match outcome` at `:5748`, so the staged batch set is gone before the outcome is inspected. The `Err(StateImportError::Store(...))` arm at `:5762-5765` returns `store_write_failed` with no indication that the staging is now empty.
Required faults and enabling state: An empty session so the preflight returns `Ready` at `:5687`, a multi-batch import so `batch_count > 1`, all batches staged so `stage` returns `Apply` at `:5734`, then a store fault on `commit_state_import`. **Constructible today, revised this disposition (F3):** a `BEFORE INSERT` trigger with `RAISE(ABORT, ...)` on `mc_state_imports` (`mc-store:7180-7190`, inside the import transaction), installed through `execute_tag_sql_for_test`, makes the commit return the `Store` error arm. The ordering was always verifiable by reading, since `complete()` is unconditional and precedes the `match`; what was missing and is now available is the failing outcome itself. `:26941` reaches a *refused* commit, which is a different arm taken before the write.
Confidence: high — [evidence](evidence/h4c-state-import-commit-clears-staging-on-every-outcome.md). Read the ordering of `:5738`, `:5744-5747`, and `:5748` directly and confirmed `complete` is not inside any conditional. Confirmed the `import_id` preflight at `:5678-5686` recognises a *successful* prior commit, which bounds this to lost work rather than double-apply.
Existing check: `:26941`, `:26967`, `:27013` as described.
Impact: No double-apply: a resend after a commit that actually succeeded hits the preflight and returns `duplicate: true`. The cost is that a transient store error forces the caller to re-send an entire multi-batch import, and the error code gives it no way to know that. With batches capped at 1 MiB each (`:5597`) a large import is expensive to redo.
Open questions:

- Is `store_write_failed` classified as retryable by the TypeScript sender, and
  does it resend from batch zero? Answering needs the sender, which is outside
  this repository's Rust crates. Unresolved, needs the TS state-import client.

### h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — and the workload is narrower than an earlier version of this record claimed, corrected this disposition (F2). The inline module has a `state_sync_before_apply_hook` seam at `:9232-9240`, but it fires **before** the commit at `:9241`, so anything it runs precedes both effects and cannot split them. No test drops the response after a successful apply and redelivers, and a retry cannot split what the first delivery completed either, because the two effects are synchronous: `:9287` opens the `Ok(result)` arm, `:9288-9291` sets the capability, `:9292` calls `respond`, with no `await`, no fallible call and no lock acquisition in between.
Guarantee: The note-evaluation capability implied by a `state_sync` request is set whenever that request's durable state is applied.
Check: `always` — after any `state_sync` whose `apply_authority_state_sync` committed, the in-memory note-evaluation capability for the route's project matches the request's `note_evaluation_available`. `always` because the two effects are one logical operation on every request.
Fault/timing angle: The window is `:9241` (durable commit) to `:9288-9291` (capability set), and what fits inside it is narrower than a lost response: a **process kill or panic landing strictly between those statements**. A lost response followed by a retry does not split them, because the first delivery already set the flag in this process. On retry, `expected_shadow_seq` has advanced, so the store returns `AuthoritySeqMismatch` (`:9316-9318`) and the `Ok` arm holding the capability call is never re-entered. That fenced rejection is the half that is observable today and is worth witnessing on its own.
Required faults and enabling state: A `state_sync` with `note_evaluation_available: true` that commits at `:9241`, then a process kill or panic strictly between that commit and `set_note_evaluation_capability`, then a redelivery of the same wire with the same `expected_shadow_seq`. Constructing that deterministically needs a **post-commit hook symmetric with the pre-apply one**, which the file does not have; it is the one capability this part found genuinely missing.
Confidence: medium — [evidence](evidence/h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together.md). The ordering and the fence are verified by reading `:9241-9321`. What I did not establish is whether a later `state_sync` in the same session re-sends `note_evaluation_available`, which would self-heal the flag on the next pass; that requires the sender. Confidence is medium for that reason, not because the code reading is uncertain.
Existing check: none found.
Impact: If it does not self-heal, conditioned notes are refused for the rest of the process lifetime even though the durable state says the evaluator is available. `refuse_conditioned_note_without_evaluator` (`:15246-15445` range) is the consumer, in 4d's scope.
Open questions:

- Does the sender re-send `note_evaluation_available` on every `state_sync`,
  making this self-healing within one pass? Unresolved, needs the TypeScript
  state-sync sender.
- Should `handle_state_sync_value` carry a post-commit hook symmetric with
  `state_sync_before_apply_hook` (`:9232-9240`), so the only remaining window is
  constructible? Without it this record's main half cannot be driven
  deterministically. (needs human input)

### h4c-authority-drain-finish-compares-two-caller-supplied-checksums

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no inline test sends `authority.drain.finish` with `verified: true` and both checksum fields absent.
Guarantee: The authority drain flip cannot be completed without an independently computed checksum agreement.
Check: `always-or-unreached` — whenever `authority_finish_drain` accepts a flip, the compared checksums were computed by the store or the module, not supplied verbatim by the requester. `always-or-unreached` because a malformed or hostile finish request is an optional path that must be safe when taken.
Fault/timing angle: None; this is an input-trust question, not a race. At `:7371-7382` the handler forwards `checksum_expected`, `checksum_actual`, and `verified` from the request body, defaulting the checksums to `""` and `verified` to `false`. The store's guard at `crates/mc-store/src/lib.rs:11911` is `if !all_steps || !verified || checksum_expected != checksum_actual`.
Required faults and enabling state: An authority in `DRAINING` at the caller's expected generation with all drain steps recorded, then a `finish` request carrying `verified: true` and omitting both checksum fields. Request shaping plus seeded authority state; no fault.
Confidence: medium — [evidence](evidence/h4c-authority-drain-finish-compares-two-caller-supplied-checksums.md). The handler defaults and the store predicate are both read and quoted, so the mechanism is certain. What keeps this at medium is that I have not established whether the drain coordinator is a trusted in-process component or a remote caller. If the coordinator is trusted, this is a robustness gap; if it is not, it is a validation hole. Contrast `authority.prepare` `complete`, which computes the actual side itself via `authority_seed_checksum` at `:7197-7206` and only takes `checksum_expected` from the request. That asymmetry between the two paths is the strongest part of this finding.
Existing check: none found.
Impact: A finish request that asserts its own verification flips the authority without a real integrity comparison. `all_steps` still has to hold, so this is not a bare bypass.
Open questions:

- Who may send `authority.drain.finish`? The trust class decides whether this is
  a hole or a rough edge. (needs human input)
- `authority.drain.begin` has the weaker version of the same shape: `lease`
  defaults to `""` and `lease_expires_at` to `0` at `:7336-7340`, with no second
  predicate failing closed. Whether an empty lease token is accepted by
  `authority_begin_drain` is unresolved and needs `mc-store`.

## Group D: coordinator bounds, removal, and accounting

Four records on the resident structures behind the three staging coordinators, and
they compose into one growth story rather than four independent ones. The
transform-page map has no removal path, which permanently re-qualifies any session
it has ever seen past the pending-count gate; the seed coordinator's pending
counter is dead, so that coordinator has no count bound at all; and the `completed`
replay slots are charged to no budget because they are only ever assigned after
`release_phase` has set the phase to `Idle`. Every one of them is a resident
representation invariant, so every check here is an `always` over a live structure
and needs no fault.

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
Check: `always` — after `unbind_route` has run for **the last remaining binding**
of a session, that session has no entry in `transform_pages.sessions`. `always`
because the map is a live resident structure evaluated at every staging call;
there is no optional path to excuse with `always-or-unreached`. The last-binding
condition is a correction applied this disposition (F9): `unbind_route`
(`:4232-4256`) computes `last_session_route` by scanning the remaining bindings
for another channel on the same session (`:4242-4247`) and enters the
session-scoped cleanup block only when none is found (`:4256`), so a session with
two bound routes legitimately keeps its entry after one closes and the
unconditional form would fail against a correct implementation.
Fault/timing angle: none required. The growth is monotone under ordinary
sequential traffic; no interleaving is needed.
Required faults and enabling state: none. Bind a route, send one paged transform
series or even one malformed page-zero, unbind **every** route for that session,
repeat with a fresh session id. Closing one route of several is not enough, per
the check's last-binding condition. Reading map cardinality from a test is
established by `:18730`.
Confidence: high — [evidence](evidence/stagelc-transform-page-session-map-has-no-removal-path.md).
Verified that the impl block `lib.rs:1107-1320` contains no `remove` call, that
`discard` (`:1131-1144`) only replaces the phase, and that `unbind_route`
(`:4268`) routes to `discard_transform_pages_for_route` rather than an `evict`,
while the sibling seed coordinator does call `evict` (`:4267`), which does
`sessions.remove` (`:999-1002`).
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
Confidence: high — [evidence](evidence/stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session.md).
Verified the gate text at `lib.rs:1186-1190`, that the `contains_key` conjunct
short-circuits the overflow return, and that `discard` leaves the key present.
Existing check: none.
Impact: the count cap stops being a cap once enough sessions have been seen.
The 128 MiB byte cap at `lib.rs:631` still holds, so this is a degradation of
defence in depth rather than an unbounded byte path, but the doc comment at
`lib.rs:1064-1065` claims "every sender contributes to the same bounded staging
budget", which is exactly the guarantee the conjunct weakens.
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
Confidence: high — [evidence](evidence/stagelc-seed-pending-count-is-never-incremented.md).
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
Check: `always`, with one conjunct per limb of the guarantee, corrected this
disposition (F10): after a `completed` slot is assigned, either
`total_staged_bytes` is **at least the size of the retained result**, or the slot
is cleared within an explicit bounded window. The earlier form asserted that
retained result bytes plus phase bytes are at most `max_staged_bytes`, which
proves neither limb: the inequality is satisfied trivially whenever the retained
result is small, and it holds for a coordinator that charges nothing and expires
nothing, which is precisely the state this record documents. Comparing retained
bytes against the charged counter is what makes the accounting claim falsifiable.
`always` because it is a budget invariant of a resident structure.
Fault/timing angle: none for the accounting claim. The expiry claim shares the
quiescent window of the abandonment records.
Required faults and enabling state: complete one paged transform and one paged
seed successfully, then read `total_staged_bytes` and compare it **against the
size of the retained result**, not against the budget ceiling.
Confidence: high — [evidence](evidence/stagelc-completed-replay-results-are-uncharged-and-unexpiring.md).
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
is the heaviest of the growth vectors in this part.
Open questions:

- `CompletedStateSyncSeed` also retains `generation`, `expected_seq`, and
  `total` (`lib.rs:914-921`) which the equivalence test at `:8739-8741` does not
  use; they appear only in the mismatch error message (`:8747-8748`). The page
  guard does compare `generation` (`:9449-9451`). Is the seed replay guard meant
  to compare them too? Deferred to the per-handler atomicity lens, which owns
  replay equivalence.

## Group E: reaping abandoned staged state

Three liveness records on what releases a coordination whose sender stopped. Each
states its bound in the unit the code bounds, per METHOD.md's liveness rules, and
the three bounds differ: transform pages have no TTL constant at all, seeds have
10 minutes at `:627`, and imports have 5 minutes declared at `:654` and wired at
`:1357`. The two existing reapers are self-driven with one call site each, so both
fire only when further traffic of the same kind arrives, which is exactly the
traffic an abandoning sender stops sending. The two halves of that shared shape
are separate records because their TTLs, clock seams, existing coverage, and
reachability classes all differ.

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
`lib.rs:627` and 5 minutes at `lib.rs:654`; any correct reaper on this
coordinator would have to fire inside it. Stating the bound in minutes rather
than "eventually" is required by METHOD.md's liveness rules.
Fault/timing angle: the window is the quiescent period after the last page. The
whole point is that the coordinator receives no further input during it.
Required faults and enabling state: a partial page series, then silence. The
route must stay bound, otherwise `route_gone` masks the property. The situation
is free to construct and staleness is even expressible, because `queued_at_ms` is
a caller-supplied parameter (`:1184`, stored `:1236`); what is missing is anything
to reap on it, and there is no injectable clock here unlike seeds (`:2921`) and
imports (`stale_after`, `:1346`), so the wall-clock cost has no knob.
Confidence: high — [evidence](evidence/stagelc-abandoned-page-collection-is-released-within-a-bounded-window.md).
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

### stagelc-seed-reaper-only-runs-on-fresh-traffic

Type: liveness
Reachability: default-production — the shipped plugin sends paged seeds,
`packages/plugin/src/hooks/magic-context/module-state-sync.ts:1173` sets
`seed_batch_index`, and the reaper call at `lib.rs:8860` is on the only seed
staging path.
Status: active
Exercised: not yet — split from the combined reaper record this disposition
(F7), and the split is what makes this line honest. The only coverage the
combined record cited, `lib.rs:27013-27072`, is entirely on the import side and
touches nothing on the seed path, so this half has **no** existing check at all.
Guarantee: a stale `Collecting` seed phase is released within
`STATE_SYNC_SEED_COLLECTOR_TTL` regardless of whether further `state_sync`
requests arrive.
Check: `always` evaluated at the end of a bounded window — stage a partial seed,
stop all `state_sync` traffic, wait `STATE_SYNC_SEED_COLLECTOR_TTL` (10 minutes,
`lib.rs:627`) plus a 60-second margin, then assert `total_staged_bytes` returned
to baseline. The bound is the coordinator's own TTL constant, which is the unit
the code bounds.
Fault/timing angle: the window is the quiescent period after the last seed batch.
Traffic of any *other* kind may continue; that distinction is the whole point,
because it separates a self-driven reaper from a timer.
Required faults and enabling state: one partial seed series, then no further
`state_sync` request for the whole window. Other request kinds may flow freely.
Nearly free to construct: `state_sync_seed_now` (field `:2921`, read at
`:8617-8626`) is an unused injectable `Instant`, so the 10-minute window collapses
to an assignment.
Confidence: high — [evidence](evidence/stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md).
Verified `evict_stale_collectors` (`:1004`) has exactly one call site,
`lib.rs:8860`, inside the seed staging path it cleans, with no `spawn_module_task`
or interval driving it. Also verified the reaper's filter matches only
`StateSyncSeedPhase::Collecting` (`:1009`), so `AwaitingSeed` and an `Idle` phase
carrying a `completed` result are both skipped and neither is ever reaped by TTL.
This record shares its evidence file with its import sibling, because both halves
of the F7 split link the pre-split file deliberately so no link breaks; per
METHOD.md step 7 that file needs to become two.
Existing check: none.
Impact: the TTL is honoured only under continuing `state_sync` load. A session
that abandons a seed and then goes idle keeps its charge against the 32 MiB seed
budget. The comment at `lib.rs:626` states the intent, "Release partial
state-sync seeds whose sender stopped before completing the page sequence", and a
sender that stopped is precisely the case in which no further `state_sync`
arrives to trigger the release.
Open questions:

- Should the reaper be driven by a timer rather than by the staging path it
  cleans? (needs human input)

### stagelc-state-import-reaper-only-runs-on-fresh-traffic

Type: liveness
Reachability: explicit-config-only — `state_import` is dispatched at
`lib.rs:12279`, but the only sender in the shipped tree is the developer script
`packages/plugin/scripts/drive-preseed.ts:48`. A repository-wide search for the
method name in `packages/` finds that one non-test occurrence, so no default
production path reaches this handler. The label sharpens rather than weakens the
record: the only production sender is a script that runs once and stops, so
"abandoned" and "no further traffic of this kind" are the same case here.
Status: active
Exercised: partial — `lib.rs:27013-27072`
`state_import_batch_gap_and_staleness_evict_partial_attempts` exercises this
reaper, but only by forcing `stale_after` to `Duration::ZERO` at `:27055` and
then sending **another** import, which is the self-driven path rather than an
independent one.
Guarantee: a stale `Collecting` import entry is released within
`STATE_IMPORT_STALE_AFTER` regardless of whether further `state_import` requests
arrive.
Check: `always` evaluated at the end of a bounded window — stage a partial
multi-batch import, stop all `state_import` traffic, wait
`STATE_IMPORT_STALE_AFTER` (5 minutes, declared `lib.rs:654`, wired `:1357`,
compared `:1403`) plus a 60-second margin, then assert `total_staged_bytes`
returned to baseline. The bound is the coordinator's own staleness constant,
which is the unit the code bounds.
Fault/timing angle: the window is the quiescent period after the last batch.
Traffic of any *other* kind may continue, which is what distinguishes a
self-driven reaper from a timer.
Required faults and enabling state: one partial multi-batch import, then no
further `state_import` request for the whole window. `StateImportCoordinator::stale_after`
(`:1346`) is settable, which is how `:27013` crosses the window without waiting.
Confidence: high — [evidence](evidence/stagelc-seed-and-import-reapers-only-run-on-fresh-traffic.md).
Verified `evict_stale` has exactly one call site, `lib.rs:1441`, at the top of its
own `stage`, with no `spawn_module_task` or interval driving it. This record
shares its evidence file with its seed sibling, because both halves of the F7
split link the pre-split file deliberately so no link breaks; per METHOD.md step 7
that file needs to become two.
Existing check: `lib.rs:27013-27072`, status `unaudited`, and it reaches the
staleness path only through the self-driven route.
Impact: the 5-minute staleness bound is honoured only under continuing
`state_import` load, and the only production sender stops after one run, so an
abandoned import's charge against the 32 MiB import budget survives until the
process exits or another import arrives.
Open questions:

- Should the reaper be driven by a timer rather than by the staging path it
  cleans? (needs human input)

## Group F: cross-session authority over staged state

One record, and it is the only authorisation property in this part. The state
import handler defines its discard closure over the caller-supplied
`parsed.session_id` and calls it from five sites that all precede
`resolve_binding`, including the `BindingError::Unbound` arm itself. Its two
sibling handlers do the opposite and resolve the binding first, which is what makes
this a shape rather than a convention.

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
`v` != 1. No fault.
Confidence: high — [evidence](evidence/stagelc-state-import-discard-runs-before-the-binding-check.md).
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

## Group G: restart, unwind, and the guards that are missing

Three records on what survives a boundary the request did not expect. The first is
the intended design stated as a property: nothing staged survives a restart, and
the rejections that enforce it fail loud. The second is its consequence, that the
only page-level replay guard is in the same memory the restart discards. The third
is the file's own idiom applied everywhere except here: ten `impl Drop` blocks
exist and none covers a staging phase, so the one piece of per-request accounting a
panic or cancellation can strand is the `Applying` phase.

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
abrupt, with at least one `Collecting` phase live at the time. Constructible
in-process: `shutdown` (`:12048`) overwrites all three coordinators at
`:12095-12099` and construction (`:3463-3467`, `:3761-3765`) produces empty ones,
so both sides are readable from one test.
Confidence: high — [evidence](evidence/stagelc-staged-state-does-not-survive-a-restart.md).
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
Check: `always` per identity, with a **ceiling of one** as the primary oracle and
attempted and acknowledged counted separately as the cheap screen, per METHOD.md's
effect-accounting rule. For one `(session, transform_page_id, generation)`
identity: the number of committed cache-state transitions is **at most one**, and
separately it is at least the number of acknowledged final-page responses and at
most the number of attempted final-page deliveries. The explicit ceiling is a
correction applied this disposition (F11): the record's own scenario is one commit,
a lost acknowledgement, and a redrive, which is two attempts and zero
acknowledgements, so the bounds alone permit `0 <= 2 <= 2` and cannot fail on the
double-apply the record exists to catch. METHOD.md's rule already says the
per-identity check is the primary oracle and the aggregate bounds are the screen;
the record had the sentence and not the assertion.
Fault/timing angle: the window is between the durable commit inside
`handle_transform_unpaged_value` (`:9528-9536`) and the caller observing the
response. A restart inside that window loses the acknowledgement and the guard
at the same time.
Required faults and enabling state: a paged series whose final page commits;
response lost or restart before the caller records success; caller redrives the
final page against a fresh process.
Confidence: medium — [evidence](evidence/stagelc-restart-drops-the-only-page-level-replay-guard.md).
Verified that the `completed` slot is the only page-level replay guard, that it
is in-memory, and that it is cleared by `shutdown` (`:12097`). What I did **not**
verify is whether the durable CAS inside `handle_transform_unpaged_value` makes
the second application a no-op; that method is `lib.rs:8007-8615` and its
atomicity is the per-handler lens's territory. The record is therefore stated as an
obligation with an open question rather than as a defect. Also verified that
`completed` is stored only for `PreparedOutcome::Response` (`:9537-9540`), so an
errored or streamed final page leaves no guard even without a restart.
Existing check: none found for the cross-restart case.
Impact: if the terminal handler's own CAS does not reject the replay, a redriven
final page applies a second cache-state transition against a generation the
caller believes it already consumed. Confirming or refuting this needs the
per-handler lens's finding on the CAS predicate.
Open questions:

- Does the cache-state CAS in `handle_transform_unpaged_value` reject a second
  application at the same `shadow_generation`? If yes this record downgrades to
  a redundancy note; if no it is a double-apply. (unresolved, needs the 4c
  per-handler atomicity finding)
- `PreparedOutcome::Streamed` stores no `completed` slot (`:9539`). Is a paged
  transform ever answered by a stream? If so the in-process replay guard is
  absent on that path too. (unresolved, needs the response-assembly finding from
  4d)

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
succeed and instead returns `in_progress`. The consequence is cheap to observe
without a real unwind: fabricate an `Applying` phase directly, as `:18730`
fabricates a `Collecting` one, then assert `InProgress` (`:1242-1254`, surfaced
`:9501-9503`). Reaching it by a real unwind is not available today, since there is
no injectable panic on that path.
Confidence: high — [evidence](evidence/stagelc-applying-phase-has-no-unwind-guard.md).
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

## Group H: the enabling-state markers

Three `sometimes` records whose only job is to stop the twenty-two records above
from passing vacuously. The first witnesses a coordination genuinely mid-sequence,
because every `always` in Groups D through G holds trivially on a campaign that
only ever sends single-page transforms. The other two witness a process boundary
crossed with staged state present, and they are two records rather than one because
only the graceful path executes the reset at `:12095-12099`, they cost differently,
and each safety record leans on a different form. All three assert independent
preconditions that hold on a correct implementation; none asserts a violation.

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
series, and (c) **that session's own `phase_bytes`** (`:1108-1114`) is greater
than zero at that moment. Conjunct (c) is a correction applied this disposition
(F12): it previously read `total_staged_bytes`, a coordinator-global sum over
every session, which with two series in flight or one abandoned collection left
from an earlier case is satisfied by bytes belonging to a session other than the
one under test, so the marker could fire while nothing was genuinely mid-sequence.
`sometimes` and not `reachable` because executing the `Ack` arm at
`lib.rs:9509-9513` is location coverage, whereas what matters here is the
operational state of a partially assembled coordination; METHOD.md's second
coverage rule makes that distinction the deciding one. Every conjunct is an
independent precondition that holds on a correct implementation; none of them
asserts a violation.
Fault/timing angle: none. This is the enabling state for the other records, not
a fault.
Required faults and enabling state: none. A three-page series with the observer
sampling after page 1.
Confidence: high — [evidence](evidence/stagelc-a-coordination-is-observed-mid-sequence.md).
Verified the `Ack(next_index)` construction at `lib.rs:1313-1315`, the response
shape at `:9509-9513`, and that `next_index` starts at 1 (`:1232`) and
increments per accepted page (`:1290`).
Existing check: partial and indirect.
`packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts:1680-1686`
asserts on the set of `transform_page_id`s in captured bodies, which proves the
TypeScript sender pages. It does not observe the Rust coordinator's state.
Impact: without this marker every `always` record in this part can pass on a
campaign that only ever sends single-page transforms, which is the vacuous-pass
mode METHOD.md warns about.
Open questions: None.

### stagelc-a-graceful-shutdown-is-observed-with-staged-state-present

Type: reachability
Reachability: default-production — both the shutdown reset (`lib.rs:12095-12099`)
and the paged path are unconditional.
Status: active
Exercised: not yet — no test constructs this combination.
Guarantee: at least once per campaign, a **graceful** shutdown is executed while
a coordination is genuinely mid-sequence, so the reset the shutdown path performs
is exercised rather than assumed.
Check: `sometimes` — at least once, all of the following independent
preconditions hold: (a) at least one coordinator had a non-empty `sessions` map
with a `Collecting` phase immediately before the boundary, (b) that phase's
staged item count is >= 1 and strictly less than its `total`, and (c) the boundary
was crossed by `CompositeComponent::shutdown` (`:12048`) **returning**, with the
fresh coordinators at `:12095-12099` observable afterwards. `sometimes` because
the operational situation is what matters, not the line: a campaign can execute
the reset statements with empty coordinators and never produce the state they
exist for. Split from a single restart marker this disposition (F13): the earlier
conjunct (c) accepted either `shutdown` returning **or** a fresh `McHandler` with
zero `total_staged_bytes`, so a campaign that only ever shut down gracefully
satisfied the marker and a green run could not say which boundary was tested. The
conjuncts are preconditions on a correct system; the record does not assert that
anything was double-applied.
Fault/timing angle: the graceful boundary itself is the timing point. This is the
only one of the two forms that executes the reset at `:12095-12099`.
Required faults and enabling state: a partial series, then `shutdown`. No other
fault needed. In-process and nearly free: `shutdown` overwrites all three
coordinators and construction (`:3463-3467`, `:3761-3765`) produces empty ones,
so both sides are readable from one test.
Confidence: high — [evidence](evidence/stagelc-a-restart-is-observed-with-staged-state-present.md).
Verified the reset statements at `lib.rs:12095-12099` sit inside
`async fn shutdown` (`:12048`), and that construction (`:3463-3467`) produces
empty coordinators, so both sides of the boundary are observable. This record
shares its evidence file with its abrupt sibling, because both halves of the F13
split link the pre-split file deliberately so no link breaks; per METHOD.md
step 7 that file needs to become two.
Existing check: none. The nearest analogue is the historian's seeded-phase
recovery family (`lib.rs:29793-29832`), which crosses a restart with durable
phase state present; the staging coordinators have no equivalent test.
Impact: without this marker,
[stagelc-staged-state-does-not-survive-a-restart](#stagelc-staged-state-does-not-survive-a-restart)
can pass on a campaign that never shuts down with staged state present, which is
the record the graceful path's reset is the mechanism for.
Open questions: None.

### stagelc-an-abrupt-restart-is-observed-with-staged-state-present

Type: reachability
Reachability: default-production — both the paged path and the loss of
in-memory state on an abrupt exit are unconditional.
Status: active
Exercised: not yet — no test kills a process with a coordination staged.
Guarantee: at least once per campaign, a process is terminated **without**
running `shutdown` while a coordination is genuinely mid-sequence, so the
records that depend on losing the in-memory replay guard together with the
acknowledgement are not vacuous.
Check: `sometimes` — at least once, all of the following independent
preconditions hold: (a) at least one coordinator had a non-empty `sessions` map
with a `Collecting` phase immediately before the boundary, (b) that phase's
staged item count is >= 1 and strictly less than its `total`, and (c) the process
was terminated without `CompositeComponent::shutdown` returning, and a fresh
`McHandler` was observed afterwards with zero `total_staged_bytes`. `sometimes`
for the same reason as its graceful sibling: the operational situation, not the
line. Split from a single restart marker this disposition (F13), because the two
boundary forms are not two ways of reaching one situation: they run different
code, they cost differently, in-process versus a real process, and each safety
record leans on a different one.
Fault/timing angle: the abrupt boundary itself is the timing point, and it is the
form that loses the acknowledgement and the in-memory guard at the same instant.
Required faults and enabling state: a partial series, then a process kill rather
than a `shutdown` call. At the cost of a real process: `direct_host.rs:149`
already proves the fixture host can be restarted with transform state present, so
this is wiring plus staging a coordination before the kill.
Confidence: high — [evidence](evidence/stagelc-a-restart-is-observed-with-staged-state-present.md).
Verified that construction (`:3463-3467`, `:3761-3765`) produces empty
coordinators, so the post-boundary side is observable, and that the reset at
`:12095-12099` sits inside `async fn shutdown` (`:12048`) and therefore does not
run on this path. This record shares its evidence file with its graceful sibling,
because both halves of the F13 split link the pre-split file deliberately so no
link breaks; per METHOD.md step 7 that file needs to become two.
Existing check: none.
Impact: without this marker,
[stagelc-restart-drops-the-only-page-level-replay-guard](#stagelc-restart-drops-the-only-page-level-replay-guard)
can pass on a campaign that never crosses a boundary abruptly, and that record is
specifically about a crash that discards the acknowledgement and the guard
together, which a graceful shutdown does not model.
Open questions: None.

## Cross-part relationship

Two sites in this repository share one shape with a Part 3 finding: **a write path
that reports success without persisting.** Part 3's
`intent-control-transition-write-is-silently-dropped` establishes that
`set_claim_intent_transition_tx` returns `Ok(())` when its `is_lower_hex` guard
fails (`crates/mc-store/src/lib.rs:4118-4126`, guard at `:4124-4126`, skipped
`tx.execute` from `:4127`), and this part finds it once one layer up, in
`guidance_date_for_session`'s two returns at `:7746-7748` and `:7757-7763`. Both
report success while the implied write did not happen, and both have the same
oracle: compare the response against a re-read of the store.

`handle_dreamer_run_task` was previously counted as a third instance and is
**not** one, corrected this disposition (F14). At `:9989-9994` it discards the
*result* of a write, and at `:9995-9998` it returns `PreparedOutcome::Error`. The
caller is told the operation failed. That is a different defect, unchecked
persistence on an error path, and it has a different oracle: the response already
says `error`, so re-reading it proves nothing, and the oracle is to re-read the
ledger after a failed run. The dreamer record itself is unchanged; only its
membership in the equivalence is.

Part 3's other relevant analogue is a retention one:
`part-3-store-core/catalog.md:999` finds claim-mirror rows keyed by
`database_incarnation_id` where "old rows are never garbage-collected". The
analogue here is the transform-page coordinator, whose staged pages have no reaper
and whose `sessions` map has no removal path at all. The two sibling coordinators
do have TTLs, which is what makes the page coordinator's absence look like an
omission rather than a design choice.

## Relationship map

Grouped by shared mechanism rather than by the section headings above, because
several of the sharpest relationships cross groups. Every dominance statement
below is a **hypothesis** about which oracle subsumes which, offered to guide
ordering, not a verified claim; none of them has been tested, because none of
these records has an executing check.

- **An earlier transaction commits and a later step fails.**
  [h4c-recomp-reset-precedes-its-ledger-row](#h4c-recomp-reset-precedes-its-ledger-row),
  [h4c-authority-prepare-route-bind-is-a-second-transaction](#h4c-authority-prepare-route-bind-is-a-second-transaction),
  [h4c-transform-writes-two-side-effects-before-its-fenced-commit](#h4c-transform-writes-two-side-effects-before-its-fenced-commit),
  [h4c-state-import-commit-clears-staging-on-every-outcome](#h4c-state-import-commit-clears-staging-on-every-outcome).
  Four records, one mechanism: the handler's error return is emitted after
  something durable already landed. Three of them share one construction after
  F3, an aborting trigger installed through `execute_tag_sql_for_test`
  (`mc-store:6431-6440`) on `mc_recomp_commands`, `mc_authority_route_bindings`,
  or `mc_state_imports`, so **one harness serves three records** and that is the
  cheapest leverage in the part. Hypothesis: building the trigger seam
  *dominates* nothing on its own, since each record needs a different table and a
  different enabling state, but it is the shared precondition for all three. The
  transform record is outside the trigger relation entirely, because its fault is
  the pass engine's own rejection and needs no injection.
- **A success returned, or a write discarded, with no signal to the caller.**
  [h4c-guidance-date-returns-success-without-persisting](#h4c-guidance-date-returns-success-without-persisting),
  [h4c-dreamer-failure-path-ledger-write-is-unchecked](#h4c-dreamer-failure-path-ledger-write-is-unchecked),
  [h4c-side-channel-drain-result-is-discarded-by-the-caller](#h4c-side-channel-drain-result-is-discarded-by-the-caller).
  Three records whose shared consequence is that the caller's view and the store's
  state can differ with nothing reporting it. They do not dominate one another,
  because each breaks a different signal: guidance withholds a persistence field,
  the dreamer discards a write result on the one path a retry depends on, and the
  transform discards three counters the store computed. They are grouped because
  the guidance no-row arm and the side-channel drain both already have a driving
  test, so two of the three are half-built, and because METHOD.md's
  effect-accounting rule is the common lens: attempted and acknowledged must be
  tracked separately, and in all three the module has the numbers and drops them.
- **Identity, or its absence, on a repeat delivery.**
  [h4c-session-delete-has-no-caller-supplied-operation-identity](#h4c-session-delete-has-no-caller-supplied-operation-identity),
  [h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write](#h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write).
  Two records, down from three: the claim intent ledger record used to sit here and
  is now the architectural note above, which is the right outcome because it could
  not fire on a per-request defect. Both survivors are two-sequential-call
  oracles with no fault, which makes them the two cheapest tests in the part.
  Hypothesis: neither dominates the other, but the ledger's absence, recorded in
  prose, is the shared cause: with a `(producer, operation_key)` identity and a
  request digest, both records' guarantees would be satisfied by construction
  rather than by per-handler convention.
- **A fence that protects the durable half and not the whole operation.**
  [h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together](#h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together),
  [h4c-authority-drain-finish-compares-two-caller-supplied-checksums](#h4c-authority-drain-finish-compares-two-caller-supplied-checksums),
  [stagelc-restart-drops-the-only-page-level-replay-guard](#stagelc-restart-drops-the-only-page-level-replay-guard).
  Three records where the protection exists and is scoped narrower than the
  operation it appears to protect. `expected_shadow_seq` makes a retry safe and
  thereby makes the in-memory sibling effect unreachable on that retry; the drain's
  `all_steps` predicate holds while the checksum comparison is supplied by the
  requester; and the page-level `completed` slot is a real guard living in the
  memory a restart discards. No dominance is claimed. What they share is the
  diagnostic question a test must answer: is the second delivery rejected because
  the operation already completed, or because the fence moved?
- **Resident growth with no removal path.**
  [stagelc-transform-page-session-map-has-no-removal-path](#stagelc-transform-page-session-map-has-no-removal-path),
  [stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session](#stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session),
  [stagelc-completed-replay-results-are-uncharged-and-unexpiring](#stagelc-completed-replay-results-are-uncharged-and-unexpiring),
  [stagelc-seed-pending-count-is-never-incremented](#stagelc-seed-pending-count-is-never-incremented).
  The tightest cluster in the part, and it is one defect observed four ways. The map
  never removes an entry; because it never removes one, `contains_key` at
  `:1186-1190` short-circuits the pending gate forever; because the phase is `Idle`
  when `completed` is assigned, the retained response body is charged to nothing;
  and the sibling coordinator's counter is dead so it has no count bound at all.
  Hypothesis: the map-removal record *dominates* the pending-cap record, since an
  evicting `discard` would restore the gate, and it *partly dominates* the
  completed-slot record, since removing the entry also drops the slot. It does not
  dominate the seed counter, which is a different struct with a different missing
  field. All four are `always` checks over a live structure with no fault, so the
  whole cluster is one test fixture that reads coordinator internals, which `:18730`
  already proves inspectable.
- **A window that closes only when new traffic arrives.**
  [stagelc-abandoned-page-collection-is-released-within-a-bounded-window](#stagelc-abandoned-page-collection-is-released-within-a-bounded-window),
  [stagelc-seed-reaper-only-runs-on-fresh-traffic](#stagelc-seed-reaper-only-runs-on-fresh-traffic),
  [stagelc-state-import-reaper-only-runs-on-fresh-traffic](#stagelc-state-import-reaper-only-runs-on-fresh-traffic).
  Three liveness records on the same absence, and the F7 split is what makes the
  relation legible: the seed and import halves differ in TTL (10 minutes at `:627`
  versus 5 at `:654`), in clock seam (`state_sync_seed_now` at `:2921` versus
  `stale_after` at `:1346`), in existing coverage (none versus `:27013`), and in
  reachability class. Hypothesis: no dominance, but a clear cost order. The seed
  half is nearly free because its clock is injectable and unused; the import half
  is half-covered already; the page half is the expensive one, because it has no
  clock seam at all and its bound must be waited out in wall-clock time. A timer
  driving all three reapers would dominate all three records at once, which is why
  `portfolio-evaluation.md` carries it as an open design question rather than a
  per-record one.
- **A guard the file has an idiom for and did not apply.**
  [stagelc-applying-phase-has-no-unwind-guard](#stagelc-applying-phase-has-no-unwind-guard),
  [stagelc-staged-state-does-not-survive-a-restart](#stagelc-staged-state-does-not-survive-a-restart).
  Paired because the second is the intended design and the first is the one place
  the design is not enforced. Ten `impl Drop` blocks exist in the file, four of them
  cited in the record, and `TransformDispatchTicket`'s comment at `:503-504` names
  panic unwind outright; the `Applying` phase is released by a plain statement at
  `:9554`. Hypothesis: the restart record *dominates* nothing and is depended on by
  the unwind record's framing, since "the phase is process-local and nothing
  reconstructs it" is what makes a stranded phase permanent until teardown.
- **The markers everything else rests on.**
  [stagelc-a-coordination-is-observed-mid-sequence](#stagelc-a-coordination-is-observed-mid-sequence),
  [stagelc-a-graceful-shutdown-is-observed-with-staged-state-present](#stagelc-a-graceful-shutdown-is-observed-with-staged-state-present),
  [stagelc-an-abrupt-restart-is-observed-with-staged-state-present](#stagelc-an-abrupt-restart-is-observed-with-staged-state-present).
  Three `sometimes` records, and after F13 the second and third are deliberately not
  interchangeable: the graceful marker witnesses the reset at `:12095-12099` that
  the design record is about, and the abrupt marker witnesses the simultaneous loss
  of the acknowledgement and the in-memory guard that the replay-guard record is
  about. Hypothesis: the mid-sequence marker *dominates* neither of the boundary
  markers but is a precondition for both, since a boundary crossed with nothing
  staged witnesses nothing. Cost order is mid-sequence first (a three-page series),
  then graceful (in-process `shutdown`), then abrupt (a real process kill).

