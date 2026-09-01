# Part 3 fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 and 2a: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window; crash-recovery needs a
real termination; rare implementation branches need deterministic injection to be
reachable at all; and coverage checks assert independent preconditions, never the
violation.

One framing point specific to this part. The dominant obstacle here is not a
missing fault. It is that **no CI job executes any test in this scope**, so the
availability column below describes what a developer can produce locally, and
nothing in it is protected by automation. That distinction is carried explicitly
through the ranking at the end.

## Fault classes required

`C0` is listed first because it is the cheapest capability in this part and it is
not a fault at all.

| Class | Description | Available today |
| --- | --- | --- |
| C0 test execution in CI | Any workflow job that runs a scope test binary or library target | **No.** Verified across all five files in `.github/workflows/`. The only scope reference is `ci.yml:483-484`, `cargo check -p mc-core --no-default-features`, which compiles and runs nothing. 154 test functions across two library targets and four integration binaries execute in no job. This costs a workflow change and no new infrastructure |
| F1 power-loss and crash injection at a chosen point | `SIGKILL` or power loss at a named internal point, then reopen | **No.** No test in scope terminates a process. The two reopen tests (`lib.rs:14717` `first_application_marker_is_atomic_and_survives_reopen`, `lib.rs:16927` `historian_side_channel_outbox_recovers_after_restart`) drop the store in-process and reopen, which proves nothing about a mid-commit kill. **Correction, verified at `80585c48`:** an earlier revision of this file claimed three deleted seams "existed to inject a crash at a commit window". That is false — none of the three was a commit-window seam, and no commit-window seam has ever existed in this crate. See the note below for what was actually removed. Power loss proper, as distinct from process crash, needs `dm-flakey` or equivalent; the repository has none |
| F2 storage exhaustion | `ENOSPC`, `EDQUOT`, or a write failure on the database file, WAL, or shm during a fenced write or a migration | **No, and no record now requires it.** No storage-fault injection anywhere in scope. The only error-injection hook of any shape is `historian_side_channel_fail_once` (`lib.rs:9667`), and it fires before any write. `failed-fenced-transaction-leaves-no-partial-state` was previously routed here; it does not need storage exhaustion, because a late SQL error inside the closure produces the same mid-closure `Err` at a fraction of the cost. F2 remains genuinely unavailable, and is now unclaimed |
| F3 `SQLITE_BUSY` writer contention | A lock holder outside the file lease, contending with a multi-statement fenced write for longer than the 5-second `busy_timeout` | **Partial, and better than it looks.** The out-of-band writer already exists: `matching_historian_abandon_fences_predicate_and_update_for_both_backoffs` (`lib.rs:16687`) opens a raw `rusqlite::Connection` at `:16704`, sets `busy_timeout(Duration::ZERO)` at `:16705`, and asserts `SQLITE_BUSY` at `:16709`. What is missing is a variant that **holds** the lock rather than failing fast, so the store's own 5-second timeout (`cortexkit-store:289`) actually expires |
| F4 schema-version manipulation, including a version above the current ceiling of 57 | Seeding an arbitrary recorded `mc_cache` version, then opening | **Partial, and the missing half is one line.** `pre_cutover_module_store_is_refused_by_family_not_by_ddl_collision` (`lib.rs:16088`) already seeds arbitrary recorded versions: it loops `for version in 1..OLDEST_ADOPTABLE_MIGRATION_VERSION` at `lib.rs:16113`, so the mechanism exists and the highest value it constructs is 56. **Nothing constructs 58.** A store recorded above 57 falls into the `_ => Ok(())` arm at `lib.rs:1383`, then `inner.migrate` at `lib.rs:4874` is a no-op, and an older binary operates on a newer schema. The only newer-schema refusal in the system is on the TypeScript side |
| F5 clock and ordinal boundary values, including the `NaN`-producing infinite budget pressure | Non-finite and extremal `f64` inputs to the decay kernel; controlled or tied millisecond timestamps in the store | **Split.** **Yes for `mc-core`:** `tier`, `should_archive`, `rendered_tier`, and `compute_budget_pressure` take `f64` arguments directly, so `f64::INFINITY` and `f64::NAN` are reachable by a plain library call with zero infrastructure. A positive subnormal `history_budget` (measured at `5e-324`) makes `compute_budget_pressure` return `+inf`, and `f64::clamp` propagates `NaN` through `decay.rs:102`. **No for `mc-store`:** `current_time_ms` (`lib.rs:425`) is not injectable, so the tied-millisecond retention-boundary class, the class that produced the whole-tied-group prune defect, cannot be constructed deterministically. The other capped tables, including the two 256-row pass-scheduler caps at `lib.rs:411-412`, are unaudited for the same defect |
| F6 out-of-repo dependency variation | Changing the SQLite engine version, or the PRAGMAs, transaction primitive, and migration runner that govern durability | **No.** The three PRAGMAs (`journal_mode = WAL` at `cortexkit-store:287`, `busy_timeout(5s)` at `:289`, `foreign_keys = ON` at `:291`), the fenced-transaction primitive, and the migration runner are **not in this repository**. They live in `../commons/crates/cortexkit-store`, resolved by `Cargo.toml:16`. Nothing in scope pins or asserts them, and CI provisions "metadata-only sibling stubs" (`ci.yml:128`, `:160`, `:372`, `:475`), so even the compile path does not see the real contract. `synchronous` is never set anywhere in either crate. Separately, the engine version the declared `[3, 47, 1]` WAL-reset floor guards is whatever `rusqlite` links, and the only test asserting it (`tests/sqlite_runtime.rs:139-169`) asserts the *failing* branch |

Four supporting classes the 37 records also draw on:

| Class | Description | Available today |
| --- | --- | --- |
| F7 input-domain generation | A generator sweeping a value domain rather than a fixture list | **No tooling, but not a blocker.** No `proptest`, `quickcheck`, or `arbitrary` in any scope `Cargo.toml`. Every existing check is a hand-written case. A plain nested loop is sufficient for every record that needs this, so it is a convenience |
| F8 identifier-shape and fixture-identity plants | Supplying a 36-character dashed store UUID where a 32-lowercase-hex incarnation is expected, and vice versa | **Yes.** `tests/claim_intent_ledger.rs:11-15` already carries a dashed store UUID distinct from the incarnation, which is the exact plant needed. This fixture change is what exposed the dead identity comparison in the first place |
| F9 lost-response replay | Re-driving an operation with the same identity after a dropped or delayed response | **Yes.** Replays are ordinary in-process API calls with no transport involved. This is already exercised for receipts and staged intents |
| F10 cross-boundary observation | Observing an effect or a state that lives outside these three crates | **No.** Two records need it: the context effect of a staged claim intent lands in a different database, and the mirror's stamping rule must be compared against a TypeScript host with no shared fixture |

One availability caveat that cuts across every class. A repaired defect
established that a fixture which builds its own schema can make a test pass
vacuously: a repair statement wrote a dropped column and the test passed because
the fixture created that column. Because the migration DDL is one 881-line raw
string literal (`lib.rs:432-1312`) that nothing validates at compile time, any
fault implemented against hand-written fixture DDL rather than a real
`McStore::open` inherits that vacuity risk.

## What `80585c48` actually removed

Recorded here because the earlier F1 row mis-described it, and the mis-description
inflated F1's apparent cost. Verified by reading each site at `80585c48^` and
confirming its absence at `80585c48` and at HEAD (`76cd6f41`).

| Removed | What it actually was | Why it is not a commit-window seam |
| --- | --- | --- |
| `facade_mutation_abandon_hook` (`80585c48^:4557`, `:4826`, `:4997`, `:5308-5310`) | A `FnMut()` callback invoked inside the fenced facade-mutation closure after both `mc_facade_mutation_ledger` writes and **before** `tx.commit()`. Its own comment described simulating "a process abandoning the transaction at the crash window" | It ran pre-commit, so the only outcome it could produce is a rollback. A rollback is the *mid-closure failure* case, not a crash at or after commit. It was the closest existing fit for `failed-fenced-transaction-leaves-no-partial-state`, and nothing to do with durability after acknowledgement |
| `authority_project_resolution_fail_once` (`80585c48^:4561`, `:4830`, `:5182`, `:5219`, `:5247`) | A one-shot `AtomicBool` that made `authority_project_state_for_route` and `authority_project_for_route` return `McStoreError::Serde` on their next call | It returned **before** `self.inner.with_conn`, so no connection was opened, no transaction began, and no write occurred. It injected a pre-read error on two read-only resolution paths |
| `authority_seed_resolution_pass_count` (`80585c48^:4567`, `:4836`, `:12049-12050`) | An `AtomicUsize` field plus a test getter | It was **never incremented anywhere**. A dead observability counter, not an injection point of any kind |

The accurate statement is therefore: `80585c48` removed one pre-commit rollback
seam, one pre-read error injector on a read path, and one dead counter. No
commit-window crash seam was deleted, because none existed. The residue of the
deletion is still visible as doubled `#[cfg(any(test, feature = "test-support"))]`
attributes at `lib.rs:4623-4624`, `:4626-4627`, `:4632-4633` and `:4889-4890`,
`:4892-4893`, `:4897-4898`.

The seams that survive at HEAD are `abandon_historian_hook`
(`lib.rs:9246-9254`, inside the fenced abandon transaction after the predicate
read and before the meta write), `before_max_compartment_end_read_hook`
(`:5283`), `historian_side_channel_fail_once` (`:9666-9678`, before any write),
`tag_number_query_count`, and `authority_seed_transaction_count`.

### What each crash-dependent record now needs

| Record | Seam it needs after this correction |
| --- | --- |
| acknowledged-commit-survives-process-crash | A real `SIGKILL` between `tx.commit()` returning (`cortexkit-store:230`) and the caller observing `Ok`. No in-process hook can supply this, because the window is inside the dependency and after the commit; restoring any of the three deleted fields would not help. Needs a subprocess harness, and the power-loss variant needs `dm-flakey` |
| migration-and-its-version-record-commit-together | A kill inside `tx.execute_batch` (`cortexkit-store:369`), between the batch and the version insert (`:375-380`). Neither crate has a seam there, and the migration runner is out-of-repo, so this needs a subprocess kill or a new hook in `cortexkit-store` (F6 ownership question, not a local one) |
| failed-fenced-transaction-leaves-no-partial-state | **No crash seam.** A late SQL error inside the closure is sufficient; see the F2 row and the leverage ranking. The deleted `facade_mutation_abandon_hook` was the closest fit and would be a convenience, not a requirement |
| post-migration-open-repair-is-resumable-and-effect-idempotent | **No crash seam.** Committed-prefix fixtures replace the kill; see the F1 row for that record in the map |
| intent-staged-replay-produces-one-context-effect | **No crash seam.** A persisted `staged` row is the post-crash state. F10 remains, and is now the only blocker |

## Map

All 37 records. "Non-vacuous today" means a developer can construct the required
state with the current harness. It does **not** mean the check runs anywhere;
under C0 none of them do.

### SQLite durability, transactions, schema, migrations

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| acknowledged-commit-survives-process-crash | `SIGKILL` between commit and acknowledgement, then reopen through `McStore::open`. Separating process crash from power loss needs a second variant that loses the page cache (F1) | **No** — both reopen tests drop in-process |
| synchronous-level-is-explicitly-declared-not-inherited | None. Open a store and read `PRAGMA synchronous` | **Yes** — and the check fails today, because nothing sets it (F6) |
| bundled-engine-satisfies-the-declared-wal-reset-precondition | None to observe the version. Observing a consequence needs enough write volume to wrap the WAL repeatedly with a concurrent reader (F6) | **Yes** for the version comparison; No for the consequence |
| wal-reset-gate-runs-on-the-production-open-path | None. Instrument `evaluate_sqlite_runtime_gate` and call `McStore::open` | **Yes** — a `reachable` check writable today, and it fails, because the gate has no production caller |
| connection-contract-is-verified-on-the-production-connection | None for reachability. Making it meaningful needs a store opened where WAL cannot be enabled (F6) | **Partial** — reachability yes, the WAL-unavailable case no |
| failed-fenced-transaction-leaves-no-partial-state | A closure that writes at statement k and then fails at a later statement, for k strictly between 1 and n. **No fault class required.** A deliberately failing statement is enough: bogus SQL, a `CHECK` violation (two exist in the bootstrap), a `NOT NULL` or `UNIQUE` violation, or a foreign-key violation, since `foreign_keys = ON` (`cortexkit-store:291`). In-crate tests already reach `store.inner.with_conn(...)`, so `store.inner.with_conn_fenced(\|tx\| ...)` with a late failing statement is available today. For the production closures, the mid-closure error must land after a successful write: note that `commit_state_import` validates before its insert loop (`lib.rs:7172-7174`), so the error must come from a constraint rather than from `validate_state_import_compartments` | **Yes** — reclassified from **No**. Only the *out-of-repo* dependency test (`cortexkit-store:691-712`) exercises this shape today, but nothing blocks an in-crate one |
| migration-and-its-version-record-commit-together | `SIGKILL` during `tx.execute_batch(m.statements)` on a fresh database, then reopen (F1). Because `MIGRATIONS` is one 878-line batch, the kill point is easy to hit and hard to place | **No** |
| recorded-schema-version-cannot-disagree-with-the-actual-schema | A raw connection that drops a table, then a reopen. The record is narrowed to the out-of-band divergence case, so the `(mc_cache, 0)` seeding is no longer part of it; that case is queued as a version-admission gap instead (F4) | **Yes** — a plain `rusqlite` operation. The remaining difficulty is not the fault but the oracle: an *independent* expected object set does not exist |
| post-migration-open-repair-is-resumable-and-effect-idempotent | **No kill required.** The repair carries no in-memory progress across batches: the project list is re-derived on every `McStore::open` (`lib.rs:5081-5091`) and all progress lives in `compiled_source_revision IS NULL` (`:5084`) plus the sentinel row (`:5070-5077`). So the four committed-prefix states a kill could leave — nothing repaired and no flag, some rows repaired and no flag, all rows repaired and no flag, all repaired with the flag — are each constructible directly by SQL, then reopened. Assert the final state equals the run-to-completion state from every prefix. The >500-row two-project volume is still wanted for the multi-batch prefix | **Yes** — reclassified from **No**; the kill was the only blocker and it is not needed |
| busy-timeout-expiry-aborts-cleanly-without-partial-effect | A lock holder outside the file lease held longer than 5 seconds, contending with a multi-statement fenced write (F3) | **Partial** — `lib.rs:16704` builds the writer; it must hold rather than fail fast |
| bounded-cas-retry-never-duplicates-an-effect | Eight or more competing commits landing between one caller's load and commit (F3). Needs a hook in the load-to-commit window; `set_before_max_compartment_end_read_hook` (`lib.rs:5283`) is that shape but on a different path | **No** |
| write-predicates-are-re-evaluated-inside-the-write-transaction | A second writer committing between the predicate read and the write. In-process this is prevented by `Mutex<Connection>` (`cortexkit-store:159, 189`) and cross-process by the file lease (`:279-282`), so it needs a lease-bypassing writer (F3) | **Yes** — that is exactly what `lib.rs:16704` constructs |

### Claim mirror and intent ledger

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| mirror-receipt-replay-applies-effects-once | A seeded mirror, then a dropped or delayed apply response and a caller retry (F9). The interesting variant is apply N, apply N+1, replay N | **Yes** — ordinary API calls |
| mirror-receipt-conflict-rejects-divergent-replay | A seeded mirror with receipt R applied, then a group with `receipt_id = R` and any altered field: changed effect payload, different vector, different `expected_effect_count` | **Yes** |
| mirror-project-effect-chain-detects-omission | A seeded mirror with at least two projects, and a receipt whose project-A effects skip an outbox position while project B's effects occupy the intervening global IDs, so the contiguous-global-ID check at `claim_mirror.rs:435-448` still passes | **Yes** — this is the case the field exists for and the only one untested |
| mirror-generation-advances-exactly-one-per-touched-project | Two projects at known generations; receipts touching one, the other, and neither; off-by-one and off-by-two vectors in each direction | **Yes** — the untouched-project arm is the gap |
| mirror-read-fence-relies-on-generation-advance | A concurrent `apply_claim_mirror_receipt` landing between the two `claim_mirror_state()` calls, plus a mutation that changes `acked_effect_id` without changing a generation | **Partial** — the coverage form is constructible; the discriminating mutation is not |
| mirror-reset-cycle-requires-a-rebuild-grant | None. It needs a **production caller** of `begin_claim_store_rebuild`; searching `crates/` and `packages/` finds none, only the definition at `lib.rs:11304`, `tests/claim_intent_ledger.rs:299,313`, `tests/claim_mirror.rs:331,454,498`, and two doc comments | **No** — the cycle is fully driven, but only from test code |
| mirror-clear-without-a-grant-is-never-entered | A seeded mirror, then a non-identical `replace_claim_mirror_snapshot` and a `delete_claim_mirror` with no unresolved intents, each with no control row and with every non-`resetting` control state. Assert non-entry at `claim_mirror.rs:816` and `:1148`. No fault class required | **Yes** — `tests/claim_mirror.rs:461-479` already drives the reseed refusal arm; the delete arm and the non-entry instrumentation are the gap |
| mirror-accepting-gate-is-skipped-when-control-is-absent | A seeded mirror. Case one: control set to `draining` or `resetting`, then apply, assert `ResetRequired`. Case two: no control row, then apply, observe success (F8 to write the row with a 32-hex identifier) | **Yes** |
| intent-control-transition-write-is-silently-dropped | Nothing beyond an authority transition on the `memories` domain with a `context_store_uuid` that is not 32 lowercase hex. All four call sites (`lib.rs:11434`, `:11640`, `:11738`, `:11790`) pass `context_store_uuid`, and a dashed UUID is the production shape (F8) | **Yes** — the fixture plant already exists |
| intent-identity-is-producer-and-operation-key | A staged intent, then re-stage with a different body and each of the four binding fields altered in turn, and acknowledge with a wrong digest | **Yes** — `format_epoch`, `authority_project`, `authority_generation`, and a second producer on the same key are the gaps |
| intent-terminal-state-is-entered-at-most-once | A staged intent driven to each terminal state, then every `ClaimIntentAckKind` attempted against it, including `TerminalRejected` against `context-committed` and against `acknowledged` | **Yes** |
| intent-staged-replay-produces-one-context-effect | **No kill required.** The post-crash state is exactly a persisted `staged` row, which `tests/claim_intent_ledger.rs` already constructs; re-driving the stage then enters the replay path at `lib.rs:11048-11073`. Use a persisted-prefix fixture instead of a kill: stage, record the external effect, leave the row `staged`, replay, and count effects for that identity (F10) | **No** — reclassified from "needs both a kill and an out-of-crate effect count" to needs **only** the out-of-crate effect count. F1 is no longer a blocker; F10 still is |
| mirror-staleness-undetectable-on-memory-tool-read-path | A seeded mirror plus a source that stops delivering receipts, then a read through `list_committed_claims` (F10) | **No** — nothing in the store can express "behind the authority" |

### Core semantics, decay, canonicalization, tokenizer

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| core-decay-newest-compartment-tier-floor | `budget_pressure = f64::INFINITY`, which `compute_budget_pressure` (`decay.rs:130-145`) returns for a positive subnormal `history_budget` (F5) | **Yes** — a direct library call, no infrastructure |
| core-decay-tier-ladder-monotone-and-archive-agreement | None. An input sweep, whose grid must include the intended disagreement window where `tier == 5` but `should_archive == false`, needing `anchor_overlap > 0` (F7) | **Yes** |
| core-decay-budget-pressure-range-totality | None for the `NaN` and non-positive cases. The `+inf` output needs a positive subnormal budget (F5) | **Yes** |
| core-decay-archive-termination-bound | `anchor_overlap = f64::NAN`. `f64::clamp` propagates `NaN`, so the clamp at `decay.rs:102` returns `NaN` and `z >= Z4 + G * NaN` is false for every `z` (F5) | **Yes** as a library-level check; the only in-tree caller hardcodes `0.0`, so reachability is test-only |
| core-canonical-encoding-crossruntime-parity | A generator spanning the discriminating regions: keys straddling the BMP/astral boundary, keys differing past a shared prefix, integers at exactly `±(2^53 - 1)` and `±2^53`, `-0`, floats with zero fraction, control characters, `U+2028`, `U+2029` (F7 and F10) | **Partial** — the Rust half yes, the cross-runtime comparison needs the other runtime |
| core-result-decode-acceptance-boundary | A stored envelope whose `payload` carries a fractional number, a number beyond `±(2^53 - 1)`, or a nested object with one. Writing it requires a producer that does not canonicalize: an older writer, a hand-repaired row, or a future encoding version | **Yes** — constructible directly |
| core-applicability-heads-order-independence | None. A permutation generator over distinct-key lists, plus a separate marker recording whether a duplicate-key list ever reaches the function (F7) | **Yes** |
| core-revision-locator-roundtrip-inverse | None. A generator over the three components: `revision` at 0, 1, `MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER + 1`, `i64::MAX`; digests of length 63, 64, 65; uppercase-hex digests; wrong prefix and wrong length (F7) | **Yes** |
| core-intent-ack-transition-legality-gap | A lost acknowledgement followed by a retry with a different `kind`; two producers acknowledging the same command identity; an acknowledgement after `Acknowledged` or `TerminalRejected` (F9) | **No** — `mc-core` has no transition model to check against; the record is that the model is absent |
| core-pass-classifier-destructive-clear-guard | None. Exhaustive enumeration only | **Yes** — the cheapest oracle in the part |
| tokenizer-cross-process-determinism | A second process, and ideally a second target. The realistic fault is a dependency bump: `fancy-regex` is transitive and pinned only by `Cargo.lock`, so `cargo update` can move `\p{L}` and `\p{N}` classification (F6) | **Yes** for a second process; No for a second target and No for the dependency-bump variant |
| tokenizer-golden-oracle-provenance | An upstream `ai-tokenizer` change plus a fixture regeneration, or an edit to the vendored vocab, with the test still green | **No** — the fixture records only `{label, text, ids}`, so it has no provenance field to check |

**Totals: 25 non-vacuous today, 4 partial, 8 no.** Up from 22/4/10 across 36
records. Three of the four changes are the cheaper-oracle reroutes above rather
than new capability: `failed-fenced-transaction-leaves-no-partial-state` and
`post-migration-open-repair-is-resumable-and-effect-idempotent` moved from No to
Yes by dropping F2 and F1 respectively, and
`mirror-clear-without-a-grant-is-never-entered` is the new record from the reset
split. `intent-staged-replay-produces-one-context-effect` stays No: F1 is gone
from its requirement, but F10 is not.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `store_recorded_version_equalled_the_shipped_ceiling` | An open compared a recorded `mc_cache` version against the ceiling and found equality | The ordinary state of every current store |
| `store_open_admitted_a_recorded_version_row` | The `_ => Ok(())` arm at `lib.rs:1383` was taken with a recorded version present, as distinct from absent | Legal: an already-migrated store must be admitted |
| `store_open_repair_skipped_on_sentinel_present` | The repair body was skipped because the completion flag row existed | The documented skip at `lib.rs:5071-5080` |
| `store_open_repair_committed_more_than_one_batch` | The repair loop committed at least two batches of `NOTE_ARTIFACT_REPAIR_BATCH` | Legal on a store with more than 500 unrepaired rows |
| `store_fenced_write_contended_with_an_out_of_band_writer` | A writer outside the file lease attempted a write while a fenced transaction held the lock | Legal; the busy timeout exists for exactly this |
| `store_cas_attempt_lost_at_least_once` | A row-version CAS lost a race and re-entered its retry loop | Legal; the bounded retry exists for it |
| `store_retention_prune_encountered_a_timestamp_tie` | A retention prune found two or more rows sharing the boundary `ts_ms` | Legal and routine with a millisecond clock and batched writes; it is the precondition of the whole-group prune defect, not the defect |
| `mirror_read_fence_executed_both_state_reads` | A read fence completed both `claim_mirror_state()` calls | Legal by construction |
| `mirror_receipt_applied_between_two_state_reads` | A receipt committed between a fence's two reads | Both facts legal; the window is ordinary |
| `mirror_receipt_touched_two_projects_in_one_group` | One receipt group carried effects for two distinct projects | Legal; the per-project chain field exists for it |
| `mirror_receipt_presented_zero_advance_for_an_untouched_project` | A vector carried `stored + 0` for a project the receipt did not touch | Required by the vector rule, so it is the correct behaviour |
| `mirror_apply_ran_with_no_control_row_present` | An apply proceeded while the intent-control row was absent | The production default today |
| `intent_authority_transition_supplied_a_dashed_store_uuid` | An authority transition passed a 36-character dashed identifier into the transition writer | Legal input shape; it is the production shape. This is the independent precondition of the silently-dropped write, and it is safe because a correct implementation would still receive that identifier |
| `intent_replay_observed_an_existing_staged_row` | A stage call found an existing row for the same producer and operation key | Legal; the replay path exists for it |
| `core_budget_pressure_returned_a_non_finite_value` | `compute_budget_pressure` returned `+inf` for a positive subnormal budget | An input-domain outcome, legal to observe; the precondition of the tier-floor failure, not the failure |
| `core_anchor_overlap_clamp_received_a_non_finite_value` | The clamp at `decay.rs:102` was handed a non-finite `anchor_overlap` | The precondition of the termination failure, stated independently |
| `core_tier_and_should_archive_disagreed_in_the_protected_window` | `tier == 5` while `should_archive == false` | Documented and intended P4 protection at `decay.rs:94` and `:107-108` |
| `core_applicability_heads_received_a_duplicate_key_list` | A duplicate-key list reached the applicability-head function | Records the case where the order-independence property is genuinely undefined, without asserting an outcome |
| `tokenizer_estimate_ran_in_a_second_process` | A token estimate was produced outside the parent test process | Legal; it is the whole point of the determinism claim |

**Anti-patterns to avoid in this part specifically.** Three concrete pairings are
forbidden by METHOD.md's rule, and each is tempting here:

- Do not pair `always(!intent_control_row_absent_after_transition)` with
  `sometimes(intent_control_row_absent_after_transition)`. That marker can only
  fire by observing the silently-dropped write. Assert
  `intent_authority_transition_supplied_a_dashed_store_uuid` instead, which is the
  independent precondition and holds on a correct implementation.
- Do not pair `always(tier(1, m, p) == 1)` with `sometimes(tier(1, m, p) != 1)`.
  Assert `core_budget_pressure_returned_a_non_finite_value` instead.
- Do not pair `always(prune_leaves_table_at_cap)` with
  `sometimes(prune_took_table_below_cap)`. Assert
  `store_retention_prune_encountered_a_timestamp_tie` instead.

One further constraint on every marker in this part. Because the two
`debug_assert!` sites at `lib.rs:6878` and `:6988` are already dead restatements
placed after their own early returns, a new marker must not be positioned after a
guard that already establishes it. Place markers at the point where the
precondition becomes true, not after the code has finished depending on it.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put crash
injection near the top, and that is the wrong answer here: crash injection is the
most expensive capability in the part and it unblocks only two records, while the
cheapest capability unblocks none and protects everything.

1. **C0, running the existing tests in CI. State this plainly: the cheapest
   capability in this part is not a fault at all.** It requires a workflow change
   and no new infrastructure. It unblocks **zero** new records and **protects 154
   existing test functions**, including the six regression tests for repaired
   defects (`tests/claim_mirror.rs:527`, `:591`,
   `tests/claim_intent_ledger.rs:230`, `:345`, and the two no-work replay tests at
   `lib.rs:18577` and `:18624`). Every check named anywhere in this part currently
   depends on a human choosing to run it. Nothing else on this list matters until
   this is done, because anything added below is added to a suite that no
   automation executes.

2. **Pure-function input sweeps in `mc-core`.** No fault, no store, no process, no
   new dependency: a nested loop and direct calls to `tier`, `should_archive`,
   `rendered_tier`, `compute_budget_pressure`, the canonical encoder, the revision
   locator, and the pass classifier. Nine records move from partial or unexercised
   to exercised. Two of them already have measured contradictions waiting
   (`+inf` pressure driving the newest compartment to tier 5, and `NaN`
   `anchor_overlap` defeating archival entirely), so the sweep pays out
   immediately.

3. **Reachability assertions on the three unwired `sqlite_runtime` and pragma
   sites.** One store open plus one read each: assert that
   `evaluate_sqlite_runtime_gate` executes on the `McStore::open` path, that
   `verify_sqlite_connection_contract` runs against the store's own connection,
   and that `PRAGMA synchronous` returns the exact value the code declares. Three
   records, and all three fail today, which is the point. This also forces a
   decision on the open question of whether the Rust store or the TypeScript host
   owns that contract.

4. **Late SQL errors and persisted-prefix fixtures. No fault class at all.**
   Three records previously routed to crash or storage injection need neither.
   A closure that writes and then hits a constraint or bogus statement gives
   `failed-fenced-transaction-leaves-no-partial-state` its mid-closure `Err`;
   directly seeded committed-prefix states give
   `post-migration-open-repair-is-resumable-and-effect-idempotent` its
   resumability oracle, because the repair keeps no in-memory progress; and a
   persisted `staged` row gives `intent-staged-replay-produces-one-context-effect`
   the post-crash state without a kill. Two records move from No to Yes and the
   third drops F1 from its requirement. This sits above F4 because it needs no new
   construction mechanism whatsoever, only ordinary in-crate SQL.

5. **F4, extending the schema-version boundary above the ceiling.** The seeding
   mechanism already exists at `lib.rs:16113`; the change is to construct 58 as
   well as `1..57`. One record, and it is the record covering the one failure class
   in this part that is unrecoverable in the field. Cheap enough to sit this high
   despite unblocking only one property.

6. **Ordinary-API mirror and intent construction.** Two-project receipt groups,
   divergent receipt-id replays, off-by-N generation vectors, terminal-state
   transition attempts, grant-free clear refusals on both destructive paths, and
   the dashed-UUID plant that already exists in the fixture at
   `tests/claim_intent_ledger.rs:11-15`. Nine records, no new capability, but more
   test-authoring work than items 2 through 5.

7. **F3, a holding out-of-band writer.** Convert the existing raw connection at
   `lib.rs:16704` from `busy_timeout(ZERO)`-and-fail-fast into a holder that
   outlasts the store's 5-second timeout. Two records, one small change to an
   existing test shape.

8. **F5's store half, an injectable clock.** Needed for the tied-millisecond
   retention class and for auditing whether the other capped tables share the
   whole-group prune defect. Currently blocked by `current_time_ms`
   (`lib.rs:425`) being a free function with no seam.

9. **F1, crash injection at a chosen point.** **Two** records, not four, after the
   cheaper-oracle reroutes above: only
   `acknowledged-commit-survives-process-crash` and
   `migration-and-its-version-record-commit-together` still require a real
   termination, and both windows lie inside `cortexkit-store` rather than in this
   crate. It remains the most expensive item on the list: it needs a subprocess
   harness and a named kill point, and for the migration case a hook in a
   sibling repository. Restoring the three fields deleted in `80585c48` would
   not help either record, because none of them was a commit-window seam. A true
   power-loss variant, as opposed to a process kill, needs `dm-flakey` and is a
   separate capability again.

10. **F2, storage exhaustion, and F6, dependency variation.** F2 now unblocks
    **zero** records and has no existing seam of any shape; it is retained as a
    capability note rather than a blocker. F6 is not a test-harness problem at
    all: the durability contract lives in a sibling repository that CI replaces
    with metadata-only stubs, so making it assertable is an ownership decision
    before it is an engineering task.

11. **F10, cross-boundary observation.** Two records. Both need either a shared
    cross-language fixture or a test that spans two databases, and both are better
    treated as design questions than as harness gaps.

**Records that need a product decision rather than a harness.** No amount of test
infrastructure resolves these: whether a Rust-side newer-schema refusal should
exist and which layer owns it; whether `sqlite_runtime` is meant to be reachable
from Rust at all; whether `begin_claim_store_rebuild` is meant to have a
production caller; whether `compute_budget_pressure` returning `+inf` is an
accepted "archive everything" signal or a bug; whether `tier() == 5` is a
legitimate public answer given that it disagrees with `should_archive` by design;
and whether the repair completion flag should move out of `mc_cache_state`, where
it currently writes invalid JSON and falsifies `has_cache_state`'s documented
provenance claim.
