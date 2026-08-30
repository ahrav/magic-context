# Part 4c lens C: claimed guarantees and existing-check inventory

Attention focus: every checkable guarantee the code or the docs assert about
handler atomicity, idempotency, replay, staging lifecycle, and caller-visible
outcomes; then every existing claim-bearing check over that same surface. This
lens proposes no property records. Handler atomicity records belong to lens A and
staging-coordinator lifecycle records to lens B; where a claim of theirs appears
below it appears as a claim under test, not as a restated finding.

Method contract: [../../METHOD.md](../../METHOD.md). Every claim below is a lead.
A documented guarantee establishes an obligation and never establishes that the
implementation satisfies it, so no contract-versus-code disagreement is resolved
in the doc's favour.

## Provenance and two commit corrections

The task states actual `HEAD` = `b5dc778e`. At authoring time the repository
`HEAD` is `e447c927` ("refactor(shm): trim final review leftovers"), one commit
later. `git diff --stat b5dc778e..e447c927 -- crates/mc-module/ .github/` is
empty; that commit touches `crates/mc-host/src/ring_transport.rs` and two
TypeScript files under `packages/plugin/src/shared/mc-host-client/` only. So
every `crates/mc-module/src/lib.rs` and `.github/workflows/ci.yml` line reference
below holds identically at `b5dc778e` and at `e447c927`. `git status --porcelain`
reports both paths clean; the only modifications are `.beads/*.jsonl` and
untracked directories.

Two line references inherited from earlier passes have drifted and are corrected
here:

- **The CI step is `ci.yml:172`, not `:168`.** Part 4a's inventory and the scope
  map both cite `ci.yml:168` for `cargo test -p mc-module --test lifecycle_cli`,
  correct at `76cd6f41`. At `HEAD` the step is `:172` and the build step above it
  is `:169`. This matches 4a's own note that the then-modified working tree put
  it at `:172`; that working-tree change is now committed.
- **`STATE_IMPORT_STALE_AFTER` is declared at `:654`.** Lens B cites `:1357`,
  which is the wiring site inside `StateImportCoordinator::default`. The task
  prompt's `:654` is the declaration. Both are real; they are different lines.

Scope is sub-part 4c as defined in
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md):
`crates/mc-module/src/lib.rs` ranges `139-3105`, `3398-4542`, `5591-6429`,
`7134-8005`, and `8007-10040`, about 7,857 production lines. All references are
to that file unless another is named.

## Claims register

25 claims, ranked by consequence if the claim is false. "Implemented at" names
the code that carries the obligation, or `NOT FOUND` where no code implements it.
Quotes are verbatim and shortened only by ellipsis.

| # | Claim (verbatim, shortened) | Source | Implied property | Implemented at |
| --- | --- | --- | --- | --- |
| 1 | "exactly one `dreamer.run_task` executes per durable command identity. A concurrent duplicate — byte-identical or not, same first model or not — must not start its own billable chain or race the ledger's INSERT OR IGNORE with a different outcome" | `:3072-3077` | At most one billable producer chain runs per `(ledger_session, command_id)`, across concurrency and across retry | Partial. In-flight guard `:9796-9814`, ledger read `:9819-9828`, success write `:10016`. **NOT FOUND for the failure path:** `:9989` discards the write result, so a failed run leaves no proven row and a retry re-runs |
| 2 | "A ledger read failure must not look like 'no record': replaying a command whose durable response exists would start a second billable run, so the read fails closed and the caller retries" | `:9816-9818` | A `load_dream_task_command` error never admits a producer run | `:9822-9827` returns `dreamer_ledger_failed` before the producer is constructed at `:9848` |
| 3 | "Taken BEFORE the ledger read so it also closes the read-to-registration window: reading first would let a duplicate observe no row, lose the CPU while the winner ran to completion and released the guard, then acquire it and start a second billable chain" | `:9791-9795` | The guard-acquire precedes the ledger read, with no reordering | `:9796-9814` (guard) strictly precedes `:9819` (read) |
| 4 | "the module's own producer sessions must NEVER be transformed ... a transform here would recurse the historian into itself" | `:8040-8043` | No historian or dreamer child session reaches the pass engine | `:8044-8056` (prefix test on the caller-supplied `session_id`), `:8057-8074` (dreamer arm, route-validated). The two arms use different trust bases; see lead L1 |
| 5 | "Registration is the authority for a dreamer exemption. Validate the route before trusting it so a stale or cross-project channel cannot bypass transform" | `:8058-8059` | A transform bypass requires a registration plus a matching route binding | `:8057` `dreamer_run_registered` then `:8060` `resolve_binding` |
| 6 | "An idempotency conflict means a concurrent command ... owns this child session and its live, billable run: purging would cancel the other caller's run ... Return without any ledger write" | `:9953-9962` | A losing duplicate neither purges the winner's session nor writes a ledger row | `:9963-9970` returns before any purge or write |
| 7 | "Each non-final attempt must purge its session before advancing or returning ... A failed purge is therefore terminal for the command" | `:9913-9923` | No dreamer child session with a memory-pool snapshot is orphaned by chain advance | `:9940-9950` (invalid-manifest arm) and `:9972-9980` (error arm); both `break` on purge failure |
| 8 | "Purge only after the response is durable. A purge failure here cannot fail the command — the recorded response is already the command's outcome (any retry replays it)" | `:10023-10027` | Ledger durability precedes session purge on the success path | `:10016` (write, result checked) then `:10028` (`let _` purge) |
| 9 | "Validated against the requested IDs before the attempt is accepted: an enveloped-but-invalid manifest must advance the chain, not end it and be ledgered as this command's durable response" | `:9925-9934` | An invalid or length-capped manifest never becomes the command's durable response | `:9935` `length_capped_or_invalid(&result, &expected_ids)` |
| 10 | "Batch zero is checked against durable metadata before the process-local state is touched. A stale retry therefore cannot evict or allocate another live attempt" | `:8816-8817` | A stale seed batch zero cannot destroy a live seed collection | `:8818-8830` loads and compares before staging |
| 11 | "A newer full transform invalidates the prior wrapup snapshot before any store mutation. If this pass later rejects, wrapup must not pair old raw bytes with the state that the pass..." | `:8173-8175` | Snapshot invalidation strictly precedes the pass's first durable write | `:8176-8180` (`transform_snapshots.begin`), ahead of the mural write at `:8210` |
| 12 | "Live transform pages share one coordinator so every session has one in-flight attempt and every sender contributes to the same bounded staging budget" | `:1064-1065` | Both halves of the staging budget, bytes and pending count, bind every sender | Bytes half `:1200-1206`. **Pending half NOT FOUND as stated:** `:1186-1190` skips the count gate for any session already in `sessions`, and `discard` (`:1131-1144`) never removes the entry. Lens B owns the record |
| 13 | "These bounds apply to every live transform page so no session can bypass the handler-wide staging budget" | `:628-629` | The four `TRANSFORM_PAGE_MAX_*` constants are unbypassable per session | Same split as claim 12. `TRANSFORM_PAGE_MAX_PENDING` (`:632`) is the bypassable one |
| 14 | "Release partial state-sync seeds whose sender stopped before completing the page sequence" | `:626` | A stale seed collection is released whether or not more seed traffic arrives | Partial. `evict_stale_collectors` defined `:1004`, **single call site `:8860`**, inside the seed handler itself, so a stopped sender supplies no trigger. Lens B owns the record |
| 15 | "Drop the live collection and report its staged page count. Completed and applying requests are still cleared" | `:1129-1130` | `discard` fully releases a page collection | Partial. `:1131-1144` clears phase and `completed` but retains the map entry; the impl `:1107-1320` contains no `remove`. No TTL constant exists for pages in `:596-669` |
| 16 | "Epoch is part of every lookup and removal, so channel reuse cannot observe or delete state owned by another incarnation" | `:2929-2930` | Route state is keyed by `(channel, epoch)`, never by channel alone | `bindings` keyed on `RouteHandle`; exercised by `:17454 old_epoch_route_gone_preserves_new_epoch_binding_and_dispatch_state` |
| 17 | "The root is part of provenance; a cache row for the same session cannot authenticate a facade opened on another root" | `:2940-2941` | Cache provenance is root-scoped | Exercised by `:24738 opencode_cache_provenance_cannot_rebind_a_second_project_root` |
| 18 | "The project key is resolved from the server-side route binding, never from a request body" | `:2974-2975`, restated at `:3908-3909` | No request body can select the notes-authority project | `resolve_note_evaluator_project` `:3908-3976` region |
| 19 | "the channel is the daemon-controlled identity; the request's session must agree with it" ... "Both fail LOUD — never default to a project" | `:234-236`, `:241-243`, restated `:4300-4304` | Session identity is cross-checked against the channel binding on every transform request | `resolve_binding` `:4305-4343`; exercised by `:17422 resolve_fails_loud_unbound_and_on_session_mismatch` |
| 20 | "the deadline ... is the ONLY bound relating this handler's work to the caller's transport budget" | `:9758-9766` | A dreamer run cannot outlive the caller's supplied budget | `:9767-9781` deadline construction; exercised by `:25977 dreamer_run_task_requires_a_positive_timeout_ms` |
| 21 | "Enumerating the task here is a capability boundary: callers cannot use this route to select an arbitrary system prompt, model, or tool-enabled run" | `:9622-9623` | The task enum is closed against caller-chosen prompts and models | `:9605-9640`; the fixture at `:25806-25810` poisons the route model chain to prove the classify loop ignores it |
| 22 | "This trace is intentionally outside the fenced cache-state commit: a rejected pass must still leave a durable breadcrumb, and a trace failure must never change the transform result" | `:8258-8260` | Trace writes are best-effort and never alter the pass outcome | `:8262`, `:8332`, `:8560`, all `let _` |
| 23 | "A panic skips this method and is handled by Drop, so it cannot falsely advance the heartbeat" | `:479-480` | Dispatch-health completion cannot be advanced by a panicking handler | `TransformDispatchTicket::accept` `:479-495` plus `Drop` `:497-508`; exercised by `:18944 transform_dispatch_panic_drop_guard_decrements_without_completion_stamp` |
| 24 | "`cancel` is the single source of truth for whether admission is open" | `:2878-2884` | No second admission flag can drift from the cancellation token | Fields `spawn_gate: Mutex<()>` `:2885`, `cancel` `:2886`, `tasks` `:2887`; enforced by a source-text assertion in `tests/host_adapter.rs:154-158` |
| 25 | "Failed or rejected transforms never reach `finish_ready`, so without its own bound this class of entry would grow with every unique failing..." | `:1893-1895` | The in-flight snapshot map is count-bounded independently of success | `:1906-2079`; exercised by `:17496 in_flight_snapshot_entries_are_count_bounded_and_cannot_resurrect` |

Claims with **no implementing code**, counted as whole claims: **1**, claim 14.
Claims **partially unimplemented**, where the stated guarantee has a half with no
implementing code: **4** — claims 1, 12, 13, and 15. Claim 14 is counted as
wholly unimplemented rather than partial because a reaper reachable only from the
request kind it cleans cannot fire in the scenario its own comment names.

Two register notes. First, the guidance handler is deliberately absent from this
register: `guidance_date_for_session` (`:7725-7764`) carries **no doc comment at
all**, so its persistence obligation is unstated rather than claimed. It appears
below as lead L2. Second, `bind_authority_route` is absent for the opposite
reason: its skip is documented, so it appears under conventionally-enforced
claims rather than as a disagreement.

## Contract-vs-code leads

Each lead cites both sides. None is resolved in the doc's favour.

**L1. The historian transform bypass trusts a request-body prefix; the dreamer
bypass next to it does not, and only the second says why.** Doc side: `:8040-8043`
states the strong obligation, producer sessions "must NEVER be transformed", and
`:8058-8059` states the defence for the dreamer arm, "Validate the route before
trusting it so a stale or cross-project channel cannot bypass transform". Code
side: `:8044-8046` tests
`parsed.session_id.starts_with(historian::MC_CHILD_SESSION_PREFIX)`
and returns a passthrough at `:8055` with **no** `resolve_binding` call, while
`:8060` does call it for the dreamer arm. The asymmetry is acknowledged in the
code at `:8048-8050`: "The established historian namespace remains accepted for
compatibility with existing producer sessions. Dreamer IDs instead require
registration and route validation before they may bypass the transform." So the
weaker arm is documented as a compatibility carve-out, not as an oversight, which
is exactly why it belongs here as a lead rather than as a defect: the two arms
implement one stated obligation with two different trust bases. Whether a
harness-supplied `session_id` can carry that prefix is unresolved and needs the
sender. The nearest existing check is `:25110
composite_session_keys_scope_lineage_and_do_not_match_child_prefix_suffixes`,
which covers suffix collisions rather than a caller-chosen prefix.

**L2. `guidance_date_for_session` has two success returns that do not write, and
the surrounding prose implies the opposite.** Doc side: there is no doc comment on
the function; the implied contract comes from two other places. The caller maps
its `Err` to `store_write_failed` (`:7677-7680`), which reads as "this wrote or
told you it could not", and the response comment at `:7708-7709` reasons about
the date line's daily churn ("The date line changes every day, so content_hash
excludes it") while `hash` at `:7707` does cover the date, so the response's own
cache identity depends on the date being stable for the session. Code side: the
`row_version`-absent return at `:7746-7748` and the CAS-exhausted fall-through at
`:7757-7763` both return `Ok`, and the response at `:7704-7722` has no
persistence field among its twelve keys. Verified independently of lens A: the
only `Err` return in the function is `:7754`. Lens A owns the record; recorded
here as the prose side it disagrees with.

**L3. The dreamer's failure path discards the write its own file argues is
load-bearing.** Doc side: `:9816-9818` names "a second billable run" as the
hazard and hardens the read against it; `:10023-10027` reasons at length about
ledger durability preceding purge on the success path. Code side: `:9989` binds
`record_dream_task_command` to `let _`. Lens A owns the record. New here: the
**error code collides three ways**. `dreamer_run_failed` is returned at `:9804`
(duplicate in flight, no ledger row by design), `:9968` (idempotency conflict, no
ledger row by design, per claim 6), and `:9996` (chain exhausted, ledger row
attempted and unchecked). A caller receiving `dreamer_run_failed` therefore cannot
tell whether a durable row exists, and in two of the three cases the correct
answer is "no, by design". The success path does distinguish, using
`dreamer_ledger_failed` at `:10036`.

**L4. `TransformPageCoordinator::discard` names a full release and performs a
partial one.** Doc side: `:1129-1130`. Code side: `:1131-1144` uses
`sessions.get_mut` and `std::mem::replace`, never `remove`. Verified that the
whole impl `:1107-1320` contains no `remove` call. Lens B owns the record. New
here: the two sibling coordinators declare their TTLs adjacently at `:627` and
`:654`, and the transform-page constant block at `:629-633` declares four
`MAX_*` bounds and no TTL, so the omission sits inside an otherwise symmetric
block.

**L5. The seed TTL comment describes a trigger the code cannot receive.** Doc
side: `:626`. Code side: `evict_stale_collectors` is defined at `:1004` and called
from exactly one line, `:8860`. Verified by enumerating both identifiers across
the file: two occurrences of `evict_stale_collectors` in total, definition and
call. The import reaper has the same shape, defined `:1397`, called once at
`:1441`. Lens B owns the record.

**L6. `pending_seed_count` reads as a bound and has no increment.** Doc side: the
field name and the symmetry with two enforced siblings. Code side: four
occurrences in the whole file, all in scope, none an increment or a comparison.
Lens B owns the record. Verified independently here: `pending_seed_count` has zero
occurrences in the test module, so nothing observes it either.

**L7. The combined cache-budget ceiling is asserted at compile time and its
constituents are not individually re-checked.** Doc side: `:2303-2307` states "No
cache may interpret another cache's presence as authority. Keep their aggregate
process-retained ceiling explicit when any individual budget changes." Code side:
`:2309-2314` is a `const _: () = assert!(...)`, a compile-time check that the
three budgets sum within `TRANSFORM_SERVE_CACHE_COMBINED_BUDGET_BYTES`. This is
the strongest guard in the whole 4c range and it is the only `assert!` in it, but
it constrains declared constants, not observed retention. The observed-retention
side is claimed separately at `:2316-2329`
("Every resident byte this component retains for the whole incarnation, declared
to the host") and at `docs/native-attachment-incremental-cache-2026-08-10.md:50`,
which explicitly disclaims precision: "The limit does not precisely charge
allocator bucket/capacity overhead ... That multiplier is guidance, not an
enforced memory ceiling." So one side of the accounting is compile-time exact and
the other is documented as approximate.

**L8. A known `TODO` inside the scope contradicts a budget claim.** Doc side:
`:2316-2329` declares the retained-resident-bytes total to the host. Code side:
`:2816-2818` says "TODO(memory-accounting): add an active-clone budget for this
`Arc`, as identified by the module-memory audit. A running transform can retain
it after LRU eviction". The projection cache can therefore retain bytes outside
the declared total, by the code's own admission. `:18730
module_status_memory_metrics_match_budget_accounting_and_falsy_semantics` asserts
the metrics match the budget accounting, not that the accounting matches reality.

## Conventionally-enforced-only claims

Claims whose only enforcement is a convention, a comment, a naming rule, or a
grep, with no type, test, or runtime guard that would catch a violation.

1. **`bind_authority_route`'s documented skip.** `:4407-4409` says "Unbound
   administrative calls have no route vocabulary to record and remain valid",
   which correctly describes the `Ok(())` at `:4417-4419`. This is the
   contrast case the task asked for: behaviour and contract agree, so it is not a
   disagreement. The convention is nonetheless the whole enforcement. The caller
   cannot observe the skip, no field reports it, and the doc says nothing about
   the other non-writing outcome, a failure of the store call at `:4420`, which is
   lens A's territory. Zero tests reference `bind_authority_route` as an
   assertion target; the 22 tests that mention it use it as setup.
2. **The trace-discard convention.** `:8258-8260` licenses `let _` for trace
   writes. Four of the six `let _` sites in scope are traces (`:8262`, `:8332`,
   `:8560`) and the side-channel drain (`:8252`). The convention is stated once and
   applied four times; nothing distinguishes a licensed discard from an
   unlicensed one at the call site, which is precisely how `:9989` reads as
   conforming.
3. **Mutex-poisoning `expect` texts.** 110 of the 113 `.expect(` calls in scope
   are lock-poisoning expects with a hand-written label naming the mutex
   (`"transform page mutex"`, `"state sync seed mutex"`, and 34 other distinct
   labels). The convention that each label matches its mutex is enforced by
   nothing; a copy-paste mismatch would produce a misleading panic message and no
   test would notice.
4. **The `mc_*` and `MC_CHILD_SESSION_PREFIX` namespace reservations.** Claim 4's
   bypass rests on a prefix convention. `:25110` covers suffix collisions only.
5. **The source-text architecture assertions in `tests/host_adapter.rs:137-173`.**
   Nine string assertions over `include_str!("../src/lib.rs")`: production must
   not contain `HandlerOutcome`, `ModuleHandler`, `tokio::spawn(`, or
   `task_admission_open`, and must contain `spawn_gate`, `self.tasks.close()`,
   `self.cancel.cancel()`, `self.tasks.wait().await`, and
   `PreparedOutput::transform_segments`. These are real claim-bearing checks and
   they are the only enforcement of claim 24, but they are greps: renaming
   `spawn_gate` while preserving behaviour fails the test, and reintroducing a
   second admission flag under a different name passes it.
6. **The `deleted_rows` duplicate signal.** Nothing documents `deleted_rows == 0`
   as the repeat marker for `session.delete`; lens A records the gap.
7. **The `{"ok": true}` collapse for `todo_state.set`.** The only written
   statement of that contract is an assertion inside `:27182`, a test CI does not
   run. Lens A's L6.

## Existing-check inventory

Every status below is **unaudited**. An existing check does not remove a property
from the catalog; adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for guards.

### In-crate tests (clustered, counts, line ranges, attribution method)

**Attribution method, stated because the answer depends on it.**
`lib.rs` is 30,517 lines with two flat `#[cfg(test)]` modules and no inner `mod`,
so there is no structural index and a test's subject cannot be read off its
location. I enumerated all `#[test]`, `#[tokio::test]`, and `#[tokio::test(...)]`
attributes from `:16001` on, resolved each to its following `fn` line, and
brace-matched each body to its closing line. That yields **256 test functions,
248 in `mod tests` (`:16041-30278`) and 8 in `mod release_contract_tests`
(`:30320-30516`)**, which reconciles exactly with the scope map's 248 + 8.

Attribution then ran three ways, because a single number would be misleading:

1. **Reach** — does the test execute at least one line of 4c production code?
   Computed by matching 4c production entry points in each test body, then taking
   a fixpoint over the 119 non-test helper functions in the test modules so that
   tests calling a request-builder or a fixture helper are attributed
   transitively. This transitive step is load-bearing: the four dreamer tests
   invoke `handle_dreamer_run_task` only through the helper
   `dreamer_classify_outcome` (`:25798-25830`), and a naive body scan finds none
   of them. **Result: 212 of 256.**
2. **Op-specific** — does the test name or body reference a 4c-owned operation,
   coordinator, cache, route structure, or dispatch-health type? **Result: 120.**
3. **Claim-bearing on 4c** — op-specific, minus tests whose subject a sibling
   part owns, classified by test name: 11 to 4a (historian, wrapup, reattach,
   firing, side-channel, seeded-phase), 28 to 4d (facade, `ctx_*`, note
   evaluation, native attachment, prepared output, schemas, byte caps), 12 to
   4b/4e (Channel-2, renderer transition, duplicate `tool_use`, reasoning
   watermark, differential asserts). **Result: 69, spanning `:16391-30488`.**

The honest headline is **69 claim-bearing in-scope tests**, with 212 as the
reach figure and 120 as the op-specific figure. The 212 figure is inflated
because `handle_transform_unpaged_value` (`:8007-8615`) sits in 4c while the pass
engine it calls is 4b, so 82 tests reach 4c through the transform handler while
asserting engine behaviour. Classification 3 uses test names, so its boundary is
approximate at the edges; the three counts bracket the truth rather than pinning
it.

Clusters, with counts and the coverage method that produced them (direct
reference or transitive helper reference to the named handler or method literal):

| Cluster | Tests | Line range | Notes |
| --- | --- | --- | --- |
| transform handler entry (`handle_transform_*`) | 82 | `:16848-30213` | Reach-only for most; the assertions are usually 4b's |
| `status` / `health` / `diagnostics` | 33 | `:18730-30278` | The single most-reached read-only handler |
| `bind_authority_route` (as setup) | 22 | `:23111-…` | Setup, not an assertion target |
| `state_import` | 10 | `:26739-27124` | The best-covered durable op in scope |
| `agent_drops.append` | 10 | `:25445-27852` | Includes the `ctx_reduce` command-id family |
| `session.status` | 9 | `:17454-27534` | |
| `guidance.get` | 6 | `:22491-23009` | |
| store open (`begin_store_open`, `StoreOpenPolicy`) | 6 | `:16848-17059` | Lease wait, waiter dedup, shutdown cancel |
| in-scope caches (snapshot, boundary token, native, projection) | 27 | `:16391-28864` | Overlaps 4d, which owns native-attachment plumbing |
| dispatch health / wedge detector | 6 | `:18847-18957` | Includes the panic-drop-guard test |
| `dreamer.run_task` | 4 | `:25872-26009` | All four via `dreamer_classify_outcome` |
| `state_sync` (handler) | 4 | `:17542-30357` | |
| note-evaluator registry | 4 | `:23111-23381` | |
| `unbind_route` / `route_gone` | 3 | `:17406-23381` | |
| `session.flush` | 2 | `:27182`, `:27372` | |
| `session.recomp` | 2 | `:27182`, `:27313` | |
| `authority.seed` | 1 | `:25664` | |
| `todo_state.set` | 1 | `:27182` | |
| `session.delete` | 1 | `:27420` | |
| `memory_holder_metrics` | 1 | `:18730` | |

**Handlers and helpers in scope with zero test-module references at all.**
Verified by counting each identifier or method literal across the whole file and
again over `:16001-30517` only:

| Target | Occurrences in file | In test module |
| --- | --- | --- |
| `handle_transform_page_value` (`:9335-9578`, 244 lines) | 2 | **0** |
| `apply_state_sync_wire` (`:9127-9333`, 207 lines) | 3 | **0** |
| `handle_authority_prepare_value` (`:7169-7265`) | 2 | **0** |
| `handle_authority_drain_value` (`:7320-7427`) | 2 | **0** |
| `"authority.prepare"` | 6 | **0** |
| `"authority.drain*"` (11 dispatch arms, `:12257-12267`) | 12 | **0** |
| `"authority.status"` | 2 | **0** |
| `"mirror.pull"` | 3 | **0** |
| `transform_page_id`, `transform_page_index` | 4, 4 | **0**, **0** |
| `transform_generation`, `assemble_transform_page*` | 4, 4 | **0**, **0** |
| `discard_transform_pages*` | 18 | **0** |
| `discard_state_sync_seed` | 9 | **0** |
| `pending_seed_count` | 4 | **0** |
| `evict_stale_collectors` | 2 | **0** |

`prompt_surface.manifest` is not the method name; the dispatch arm at `:12270` is
`"manifest.get"`, which does have 7 test-module references. Recording the
correction so a later pass does not repeat the miss.

The paged-transform protocol deserves a separate note. `transform_page` and
`TransformPage` appear in the test module on exactly four lines, all inside one
test: `:18751`, `:18768`, `:18773`, `:18833`, within
`module_status_memory_metrics_match_budget_accounting_and_falsy_semantics`
(`:18730-18844`). That test fabricates a `Collecting` phase and a
`CompletedTransformPage` to assert **memory metrics**, then reads
`transform_pages` back. So the coordinator is touched once, as a fixture for a
budget-accounting assertion, and the 244-line handler that drives it has no test.

**`#[ignore]`: none found.** Zero occurrences in `lib.rs`.

**`should_panic`: 4, all differential-drift guards.** `:20646` and `:20695`
(`"incremental native attachment cache drift"`), `:21116` (`"incremental prefix
projection byte drift"`), `:21159` (`"OpenCode serialization produced duplicate
tool_use ids"`). The first three assert that a deliberately corrupted cache key
or frontier is caught by the differential assertion; two of the three caches
involved are in 4c scope.

**Property and concurrency tooling: none found.** Zero occurrences of `proptest`,
`quickcheck`, `loom`, `shuttle`, or `miri` in `lib.rs`. Every check in this part
is a hand-written fixture case. `.config/nextest.toml` contains overrides for
`mc-host`'s `shm_failure_modes` and `shm_soak` binaries only, so no `mc-module`
test is serialized, grouped, or timeout-adjusted. There is no `mutants.toml` and
no coverage configuration, so every placement statement in this file is
structural, not measured.

### Integration and CI status (with workflow line refs)

**Exactly one `mc-module` test binary runs in CI, and it is not one of these
three.** Verified across all five files in `.github/workflows/` at `HEAD`. The
complete set of Cargo test invocations is `ci.yml:132`, `:133`, `:134`, `:172`,
`:177`, `:178`, `:184`, `:185`, `:187`, `:190`. Only `:172` names `mc-module`:

- `ci.yml:167-169` — step "Source-build transport, host, and addon":
  `cargo build -p mc-shm-transport -p mc-host -p mc-shm-native` then
  `cargo build -p mc-module --bin ck-mc-host`. Build only.
- `ci.yml:171-172` — step "Native lifecycle binary contract":
  `cargo test -p mc-module --test lifecycle_cli`. `--test lifecycle_cli` selects
  one integration binary and does **not** build the `--lib` target, so no
  in-crate `mc-module` unit test is compiled, let alone run.

There is no `cargo test -p mc-module --lib`, no `cargo nextest run -p mc-module`,
and no `--workspace` test job; the only `--workspace` Cargo commands are
`cargo fmt --check` (`ci.yml:485`, step named at `:484`) and a `mc-core` feature
check, `cargo check -p mc-core --no-default-features` (`:492`, step at `:491`).
`scripts/test-rust.sh` runs `cargo nextest run --workspace` and is wired into
`package.json:12` and `:50`, but no workflow invokes either (`ci.yml:378` only
mentions `check:all` in a comment).

**The task asked specifically whether `direct_host.rs`, `prepared_output.rs`, or
`host_adapter.rs` exercise these handlers. Two of the three do.**

| Binary | Tests | Exercises 4c? | Evidence |
| --- | --- | --- | --- |
| `tests/direct_host.rs` (438 lines) | 6 | **Yes** | Spawns `examples/direct_host_fixture.rs`, which constructs the real `mc_module::McHandler::new_with_connection_file` at `examples/direct_host_fixture.rs:636`. Sends `"kind": "transform"` at `tests/direct_host.rs:110` and `:173`; the dispatcher accepts `kind` as an alias for `method` (`lib.rs:12248`), so both reach `handle_transform_dispatch` → `handle_transform_unpaged_value`. `:128-129` asserts `status == "ok"` and `served_from == "transform"`. `:149 direct_primary_replays_transform_state_across_fixture_restart` crosses a process boundary with transform state present, which is the closest existing thing to lens B's restart marker. `:253` covers malformed, unknown, duplicate, and over-cap controls |
| `tests/host_adapter.rs` (173 lines) | 4 | **Yes** | `McHandler::new()` at `:39`, `:74`, `:84`, `:106`. `:66` and `:69` call `route_gone`, reaching `unbind_route` (`:4233-4298`). `:102 shutdown_cancels_and_joins_blocked_store_open` holds a real single-writer lease at `:105`, polls health for `"waiting on storage lease"` at `:119`, then asserts shutdown joins the blocked waiter and retains no lease at `:134` — a direct check on `StoreOpenCoordinator` and `run_store_open`. `:137` is the nine-assertion source-text architecture check |
| `tests/prepared_output.rs` (282 lines) | 10 | **No** | Imports `mc_module::dispatch::{...}` only. Its `"status"` occurrences (`:45`, `:49`) are JSON payload fields, not dispatch methods. This binary tests `dispatch.rs`, which the scope map assigns to 4d |
| `tests/boundary_counter_durability.rs` | 1 | No | Zero 4c method literals, zero `McHandler` |
| `tests/broca_roundtrip.rs` | 2 | No | Zero `McHandler`, zero `bind_route`, zero `route_gone` |
| `tests/release_contract_conformance.rs` | 3 | No | Zero 4c method literals |
| `tests/lifecycle_cli.rs` | 12 | No | Uses `"status"` (5×) against the CLI, not the handler. Part 2a owns it |

So **three integration tests exercise 4c handlers end-to-end through a real
`McHandler`** (`direct_host.rs:67`, `:149`, and `host_adapter.rs:102`, plus route
teardown inside `:35`), and **none of them runs in CI**. This is a correction to
the prior passes' framing: the transform handler and the store-open coordinator
do have end-to-end coverage against a real handler, including a process restart;
it is simply never executed by automation. `direct_host.rs` also has a build-time
dependency on the example binary, which it builds itself at
`tests/support/direct_host.rs:40-47`.

### TypeScript-side gates

**The senders are CI-gated; the Rust receivers are not. That asymmetry is the
finding.**

`ci.yml:257` runs `bun run test`, which is `package.json:12`:
`sh scripts/test-shard.sh packages/plugin` plus three sibling packages. That
sweeps the plugin suite, including the two files that own these operations on the
TypeScript side.

| File | Tests | Tests this Rust code? |
| --- | --- | --- |
| `packages/plugin/src/hooks/magic-context/module-state-sync.test.ts` | 38 | **No.** It asserts the request shape the TypeScript sender emits and drives a TypeScript store. It installs a **stub transport object** at `:478` and inspects captured bodies (`calls[0]` at `:241`, `:288`, `:464`), then asserts on the recorded method list (`:500-501`). Its storage side is the plugin's own modules plus `createDirectTestDatabase` (`:37`). No Cargo target is invoked |
| `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts` | 77 | **No.** Uses `mock` and `spyOn` (`:3`). It owns the paging contract on the sender side: 9 references to `transform_page_id`, and lens B cites `:1680-1686` asserting the set of page ids in captured bodies. It proves the sender pages; it never observes the Rust coordinator |

The paging split is the sharpest instance. `module-wire.ts:20` sets
`MODULE_PAGE_MAX_BYTES` to `512 * 1024`, `:1097` returns an unpaged body only
below it, and `:1131` stamps `transform_page_id` above it. So paging is
default-production, the sender's half has 9 CI-gated assertions, and the
receiver's half — `handle_transform_page_value`, 244 lines — has zero tests on
either side.

**The host e2e suite runs in TypeScript mode only, and says so.** `ci.yml:658`
`e2e-host-opencode` sets `MC_E2E_MODE: ts` (`:714`, under the step at `:711`) and
the step comment at `:719-721` states: "Rust is intentionally absent from public
CI because its private ../commons and ../subconscious path-deps are not
provisioned here; the local release gate runs that host group." `e2e-host-pi`
(`:724`) has the same shape. So the absence of Rust end-to-end coverage in CI is
deliberate and documented, with a named cause, and the compensating gate is a
local release gate rather than CI. `ci.yml:163-164` also provisions
"metadata-only sibling stubs" via `scripts/provision-rust-ci-stubs.sh`, which is
the same constraint one layer down.

`packages/e2e-tests/tests/rust-multi-frame-delta-perf.test.ts` is the one place a
hermetic daemon over `McHandler` is named (`:110`), and its strict assertions are
gated behind `MC_RUST_E2E_STRICT_PERF=1` (`:113`).

**A parallel-implementation pattern also exists here, as in 4a.** The dreamer,
classify, and task-executor lanes have TypeScript tests
(`features/magic-context/dreamer/task-executor.test.ts`,
`dreamer/classify.test.ts`) that run under `ci.yml:257`, while the Rust
`handle_dreamer_run_task` has 4 in-crate tests that run nowhere. Establishing
whether those two implement the same contract is out of this lens's reach and is
recorded as an open question.

### Production assertions and guards (clustered)

Measured over production lines only, restricted to the five 4c ranges.

**Runtime assertions: one, and it is compiled out of release.**

- `:2441`
  `debug_assert_eq!(self.ingress_chunks.len(), self.ingress_chunk_retained_bytes.len())`
  — a representation invariant pairing the native cache's ingress chunks with
  their retained-byte entries. Absent from release builds. No named test.

**Compile-time assertions: one, and it is the strongest guard in scope.**

- `:2309-2314`, a `const _: () = assert!(...)` requiring
  `SERIALIZED_OUTPUT_CACHE_BUDGET_BYTES + NATIVE_ATTACHMENT_CACHE_BUDGET_BYTES +
  PROJECTION_CACHE_BUDGET_BYTES <= TRANSFORM_SERVE_CACHE_COMBINED_BUDGET_BYTES`.
  A `const` assertion, so a budget change that breaks the aggregate ceiling fails
  the build rather than production. It constrains declared constants only; see
  lead L7.

**Panicking sites: one.**

- `:3661` `panic!("store open worker failed: {error}")` on a `JoinError` from the
  `spawn_blocking` in `open_store_once`. No named test. Zero `unreachable!`, zero
  `todo!`, zero `unimplemented!`, and zero `.unwrap()` anywhere in the five
  ranges.

**`.expect(`: 113, of which 110 are lock-poisoning.** Across 36 distinct labels,
the largest being `"state sync seed mutex"` (8), `"transform snapshots mutex"`
(8), `"transform page mutex"` (8), `"state import mutex"` (7), and
`"bindings mutex"` (6). Each is infallible only while no thread panics holding
that lock, which interacts with lens B's finding that the `Applying` phase has no
unwind guard. The three non-mutex expects are the ones worth naming:
`"session.status response is an object"`, `"historian status serializes as an
object"`, and `"classifier output set"`. None has a named test.

**Discarded results: six `let _` sites, four licensed and two not.**

| Line | Call | Licensed by a comment? |
| --- | --- | --- |
| `:8252` | `store.drain_historian_side_channels(...)` | Partly, `:8249-8250`. Lens A's O5 |
| `:8262` | `store.trace_pass_received(...)` | Yes, `:8258-8260` |
| `:8332` | `store.trace_pass_rejected(...)` | By the same convention, not restated |
| `:8560` | `store.trace_pass_completed(...)` | By the same convention, not restated |
| `:9989` | `store.record_dream_task_command(...)` | **No.** Lens A's record; lead L3 |
| `:10028` | `producer.purge_session(...)` | Yes, `:10023-10027` |

`:8332` and `:8560` are additions to lens A's enumeration, which named `:8252`
and `:8262`. Both are trace writes and both fall under the `:8258-8260`
convention, so they are recorded as convention-covered rather than as findings.

**Typed rejection guards: 47 distinct error codes, and they are where the
invariants actually live.** Given one runtime assertion in 7,857 lines, every
other guarantee in scope is enforced by a `Result` or a typed error code. The
staging protocols are the densest: 12 `state_sync_seed_*` and
`state_sync_generation_mismatch` codes (`:8686-9324`) and 7 `state_import_*`
codes (`:1456-1585`, `:5631`). The authority lifecycle has 13 codes
(`:3924-9692`). The most-used codes are `bad_request` (13 sites),
`store_load_failed` (13), `store_write_failed` (10), and the paired
`route_unbound` / `session_mismatch` (8 each), which are the fail-loud binding
guards behind claim 19. **`transform_failed` has exactly one site, `:8334`**, so
the entire pass-engine rejection surface collapses to one code at the handler
boundary.

**Response fields that carry a semantic promise: 10.** `ok` (28 sites),
`disposition` (4: `:6019`, `:6035`, `:6068`, `:6117`), `duplicate` (3: `:5684`,
`:5752`, `:5876`), `staged` (3: `:5732`, `:9074`, `:9511`), `imported` (2),
`queued` (2), `next_expected_index` (2: `:9075`, `:9512`), `armed` (1: `:5987`),
`deleted_rows` (1: `:6154`), `seeded` (1: `:7316`). `duplicate` is the only
explicit idempotency signal in the whole scope and it appears on two handlers.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The paged-transform protocol is the quietest thing in 4c, and its sender is
   CI-gated.** `handle_transform_page_value` (`:9335-9578`, 244 lines) has **zero
   tests**. `transform_page_id`, `transform_page_index`, `transform_generation`,
   and `assemble_transform_page*` have zero test-module references.
   `TransformPageCoordinator` is touched on four lines of one test (`:18751`,
   `:18768`, `:18773`, `:18833`), as a fixture for a memory-metrics assertion.
   `discard_transform_pages*` has 18 occurrences and zero in tests. Meanwhile
   `rust-mode-transform.test.ts` carries 9 CI-gated `transform_page_id`
   assertions on the sender. So paging is default-production
   (`module-wire.ts:20`, `:1097`, `:1131`), the sender's contract is enforced on
   every pull request, and the receiver's 244 lines are enforced nowhere. This is
   also the coordinator lens B found has no reaper, no map-removal path, a
   bypassable pending cap, an uncharged `completed` slot, and no unwind guard —
   five findings on the one structure with no tests.
2. **`apply_state_sync_wire` has zero tests and it is the durable write.**
   207 lines (`:9127-9333`) containing the `expected_shadow_seq` fence, the
   historian-phase pre-check, the `AuthoritySeqMismatch` and `HistorianBusy`
   arms, and the note-evaluation capability effect — the exact code behind lens
   A's O8 and O10 and the fence that lens B relies on to bound its restart
   record. Four tests reach `handle_state_sync_value`; none names the function
   that writes.
3. **The authority lifecycle is 294 lines with one test.**
   `handle_authority_prepare_value`, `handle_authority_drain_value`, and
   `handle_authority_status_value` have **zero** test-module references, as do
   `"authority.prepare"`, `"authority.status"`, and all **11**
   `"authority.drain.*"` dispatch arms (`:12257-12267`). `authority.seed` has
   exactly one test (`:25664`). This is the surface carrying lens A's two
   caller-supplied-checksum findings and its second-transaction finding, and
   `bind_authority_route` — the second transaction itself — has zero assertions
   against it despite 22 tests using it as setup.
4. **`docs/AUDIT-KNOWN-ISSUES.md` tracks none of this.** The file runs to 52+
   numbered entries and contains **zero occurrences of `mc-module` or
   `crates/`**; its only apparent "rust" matches are substrings of "trust". Every
   entry analyses the TypeScript implementation, including four that are direct
   analogues of 4c concerns: A27 (historian lease atomicity), A33 (dreamer drain
   dedup-guarded not lease-locked), A24 (transform wrapper fails open), A4 and
   A29 (dreamer authority scope). So the repository has a mature
   accepted-issues register for one implementation of these contracts and none
   for the other, and none of the three 4c lenses' contract-versus-code gaps is
   tracked anywhere.
5. **Two handlers commit two transactions each and neither pairing has a test.**
   `session.recomp` (`:6077` then `:6114`) has 2 tests, neither faulting the
   second write; `authority.prepare` (`:7187-7239` then `:7250`) has none at all.
   Lens A owns both records; the quiet part is that the ordering contract is
   unstated in the code and unasserted in the tests, so nothing would notice if
   the order were swapped.
6. **One runtime assertion in 7,857 production lines, and it is
   `debug_assert!`.** `:2441` is the only one, and it is compiled out of release.
   The only unconditional assertion in scope is the compile-time `const _`
   at `:2309`. Every other invariant is a typed `Result`, which means a violated
   invariant becomes an error code a caller may or may not surface, never a loud
   failure. Compare 4a, which found the same shape in `historian.rs`.
7. **The one panic site has no test.** `:3661` `panic!("store open worker
   failed")` on a `JoinError`. Six tests cover store open; none constructs a
   worker-panic or cancellation that would reach this line.
8. **`discard_state_sync_seed` and `pending_seed_count` are unobserved.** 9 and 4
   occurrences respectively, zero in tests. The seed coordinator's discard path is
   called from the seed handler's own error arms and from `unbind_route`, and no
   test reads either the discard or the counter that lens B established is never
   incremented.
9. **Three integration tests exercise 4c against a real handler and run
   nowhere.** `direct_host.rs:67`, `:149`, and `host_adapter.rs:102` are genuine
   end-to-end checks, one of them across a process restart, and CI runs neither
   binary. `direct_host.rs` additionally builds an example binary at test time
   (`tests/support/direct_host.rs:40-47`), so it is the most expensive suite to
   adopt and currently the highest-value one unadopted.
10. **`mirror.pull` and the projection-cache TODO.** `handle_mirror_pull_value`
    (`:7429-7449`) has zero tests, though Part 3 owns mirror receipt semantics and
    the boundary should be confirmed before treating it as a 4c gap. Separately,
    `:2816-2818`'s `TODO(memory-accounting)` names a known hole in the declared
    retained-byte total, and the test that would catch it (`:18730`) asserts the
    metrics match the accounting rather than reality.
11. **No property, mutation, or concurrency tooling anywhere in scope.** Zero
    `proptest`, `loom`, `shuttle`, `miri`, `quickcheck`; no `mutants.toml`; no
    coverage configuration; no `mc-module` entry in `.config/nextest.toml`. The
    three staging protocols are multi-request state machines with phase enums,
    caps, and TTLs, and every check on them is a hand-written fixture case.
12. **36 hand-written mutex labels with no consistency check.** A mislabelled
    lock produces a misleading panic and no test notices. Low consequence, listed
    because the count is large and the enforcement is zero.

## Open questions

- Do the TypeScript dreamer lanes (`dreamer/task-executor.test.ts`,
  `dreamer/classify.test.ts`, both CI-gated via `ci.yml:257`) and the Rust
  `handle_dreamer_run_task` implement the same contract, making the TypeScript
  suite a parallel-implementation gate as 4a found for the historian validator?
  Unresolved; needs a contract comparison outside this lens's scope.
- Can a harness-supplied `session_id` carry `historian::MC_CHILD_SESSION_PREFIX`
  and so take the unvalidated transform bypass at `:8044-8055`? The code
  documents the arm as a compatibility carve-out (`:8048-8050`), which is a
  reason to keep it, not evidence that it is unreachable. Unresolved; needs the
  sender.
- Should the paged-transform receiver be tested at the Rust boundary, or is the
  CI-gated TypeScript sender contract (`rust-mode-transform.test.ts`, 9
  `transform_page_id` assertions) considered sufficient coverage of the pair?
  This decides whether quiet area 1 is a gap or an accepted division of labour.
  (needs human input)
- Should `direct_host.rs` and `host_adapter.rs` be added to CI, given they are
  the only end-to-end checks on 4c handlers and one already crosses a process
  restart, given they are the only end-to-end checks on 4c handlers? The blocker
  named at `ci.yml:719-721` is private path-dependencies for the Rust e2e group,
  which may or may not apply to these two binaries. (needs human input)
- Is the absence of a 4c section from `docs/AUDIT-KNOWN-ISSUES.md` deliberate,
  i.e. is that file scoped to the TypeScript implementation by design? If so the
  Rust side has no accepted-issues register at all, which is worth stating
  explicitly somewhere. (needs human input)
- METHOD.md's `Exercised` field: this lens reports counts, not per-record labels,
  but the same ruling that blocks lenses A and B blocks any future use of these
  counts. 3 of the 256 in-crate tests plus 3 integration tests are the only
  checks here that could ever be called "covered", and none executes in CI. The
  scope map's open question on this ruling is still unresolved.
- Does `handle_mirror_pull_value` (`:7429-7449`) belong to 4c or to Part 3's
  claim-mirror scope? The scope map assigns mirror receipt semantics to Part 3
  but lists `:7134-8005` in 4c. Unresolved; needs Part 3's synthesis.
