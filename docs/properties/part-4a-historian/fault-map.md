# Part 4a fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as Parts 1 through 3: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window; crash-recovery needs a
real termination; rare implementation branches need deterministic injection to be
reachable at all; and coverage checks assert independent preconditions, never the
violation.

Two framing points specific to this part.

First, **the dominant obstacle is not a missing fault.** It is that no CI job
executes any test in this scope: 141 in-crate historian tests, 7 `mc-store`
publish tests, and 926 of the crate's 938 tests run nowhere, and `mc-store` is
named in no workflow at all. The availability column below therefore describes
what a developer can construct locally. Nothing in it is protected by automation.

Second, **the richest seam in this part already exists.** The historian's model
producer is a trait with 18 dedicated tests behind doubles, so "an untrusted
producer returns adversarial-but-well-formed output" is a capability the harness
already has. That is why 22 of the 25 records are non-vacuous today.

Third, **three availability claims in the first version of this map were wrong,
and all three were wrong in the pessimistic direction.** They are corrected below
and the totals moved from 19/4/1 to 22/2/1 as a result. The pattern is worth
naming, because it is the same mistake three times: each claim was made by looking
for a *named seam* and concluding from its absence that the capability was missing,
without asking whether the capability could be produced another way.

- H4 was recorded as having "no seam of any shape" for a fault inside the publish
  transaction. True for a kill, false for a SQL error, which needs no seam because
  the closure propagates the error itself.
- H8 was recorded as "no seam found in this pass" for clock and deadline control.
  Both mechanisms it needed already exist and are already exercised by tests.
- The hostile-output records were routed through full producer runs. The validator
  is pure and can be called directly.

## Fault classes required

`H0` is listed first because it is the cheapest capability in this part and it is
not a fault at all.

| Class | Description | Available today |
| --- | --- | --- |
| H0 test execution in CI | Any workflow job that builds and runs `mc-module --lib` or any `mc-store` test target | **No.** Verified across all five files in `.github/workflows/` at `HEAD`. The only `mc-module` test invocation is `cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168` at `HEAD`, `:172` in the working tree), which selects one integration binary and does not build `--lib`. `mc-store` has zero matches in any workflow. 141 in-crate historian tests plus 7 store-side publish tests execute in no job. This costs a workflow change and no new infrastructure |
| H1 adversarial-but-well-formed model output | A producer double returning a document that satisfies every structural gate while carrying degenerate, duplicated, unrelated, overlong, or out-of-band content | **Yes, and this is the strongest seam in the part.** The producer is a trait; `historian_producer.rs`'s 18 tests and `historian.rs`'s wired-path tests are built on doubles. The gate's own 19 tests already feed hand-authored documents through `parse_compartment_output` and `validate_historian_output`. What none of them does is author a *hostile* document: every fixture generates bodies from the compartment title (`historian_validate.rs:1367-1375`) and every one uses `importance="50"` or `"60"`. The capability is present; the vectors are absent |
| H2 crash injection at a chosen point in fire, validate, publish | A real process termination in one of the four pre-commit windows, then a restart through `maybe_spawn_reattach` (`lib.rs:4614-4806`) | **Partial, and the cheap half is the useful half.** No test in scope terminates a process. `restart_mid_awaiting_exposes_reattach_ids` (`historian.rs:4596`) and `restart_mid_publishing_with_committed_tx_detects_idle` (`:4647`) simulate a restart in process by seeding the durable phase and re-entering `handle_restart_load`. Because the pipeline's five phases are each a separate durable write, a seeded phase row **is** the post-crash state for the three pre-commit windows, so the cheap form is valid for `crash-before-publish-commit-refires-without-partial-state`'s load side. What no seeding can produce is a kill *inside* the publish transaction; see H4 |
| H3 producer-start and producer-output unknown outcomes | A producer double whose `start` or `send` returns `HistorianSendOutcome::OutcomeUnknown` (`historian_producer.rs:78-82`), meaning a run may have begun whose id the module never learns | **Yes.** The variant exists and the double controls it. Seven existing tests already drive the replay fence on the *output* side (`historian_producer.rs:1712-1978`) and three drive the cancellation-proof predicate (`historian.rs:3389`, `:3444`, `:3498`). No test drives an `OutcomeUnknown` on the **start** branch (`historian.rs:1290-1329`), which is the one branch that demands no cancellation proof. The oracle must count runs at the fake, not in the module |
| H4 store-transaction failure inside the publish window | An error or a termination landing between two of the six writes at `mc-store:9457-9500` | **Split, and one half is available today. This row previously said "No, and there is no seam of any shape", which was wrong for an error and right only for a termination.** *Error: yes.* No seam is needed, because `with_conn_fenced` reaches `tx.commit()` only after the closure returns `Ok` (`../commons/crates/cortexkit-store/src/lib.rs:229-231`), and the closure's final write, the `mc_cache_state` UPDATE at `mc-store:9496-9500`, propagates a `rusqlite` error through a bare `?` after `append_compartments_tx` (`:9457-9471`), `insert_chunk_transcripts_tx` (`:9472-9481`), and `enqueue_historian_side_channels_tx` (`:9482`) have already applied. A main-schema `BEFORE UPDATE ON mc_cache_state` trigger raising `ABORT` therefore forces a rollback with three writes outstanding, and the second-raw-connection technique it needs is already used by the abandon-hook test at `:16688` (path extracted at `:16691-16694`, connection opened at `:16704`). *Termination: no.* Verified over `mc-store:9340-9560`: zero hook or injectable error, and the two nearest hooks (`lib.rs:3293`, `:3329`, fired at `:3313` and `:3350`) fire after the store call returns. Outcome-level rejection remains separately available: all seven gates (`mc-store:9373-9455`) are reachable by constructing a mismatching predicate, and four existing tests do exactly that |
| H5 concurrent firing and interleaved store mutation | A second publisher racing one session, or a store mutation landing during the minutes-long model window | **Yes for mutation, partial for a true race.** Content drift during the await is already constructed: `selected_range_identity_drift_during_await_rejects_without_cooldown` (`historian.rs:2323`) and `reattach_equal_length_identity_drift_rejects_before_publish` (`:2942`) mutate `block_identity_by_mid` mid-firing through a commit hook, and `tail_identity_extension_during_await_still_publishes` (`:2369`) constructs the permitted case. What is missing is two publishes racing one session id: the in-process guards (`lib.rs:4556-4581`, `:4640-4650`) prevent it by design, so the construction must bypass them and call `publish_validated_chunk` twice, which the `pub fn` seam permits |
| H6 boundary and encoding inputs | Control characters, `\u{2028}`/`\u{2029}`, ANSI introducers, double-decodable entities, integers past `i32::MAX`, one-character bodies, byte-identical bodies | **Yes, and it is the cheapest capability in the part after H0.** `unescape_xml` (`historian_validate.rs:1148-1154`) and `escape_xml_content` are ordinary functions; `parse_compartment_output` and `validate_historian_output` are documented as deliberately pure with no clock, store, filesystem, or environment access (`historian_validate.rs:5-7`, verified against the import list at `:11-17`). A nested loop and direct calls suffice. No `proptest`, `quickcheck`, or `arbitrary` exists anywhere in the historian path, but none is needed |
| H7 cross-language differential against the TypeScript validator | Running the same input through `historian_validate.rs` and through `compartment-runner-validation.ts` and comparing dispositions | **Partial, and the missing half is wiring rather than infrastructure.** One direction already exists as a checked-in artifact: `validate_golden_matches_typescript_oracle` (`historian_validate.rs:1384`) drives 16 golden cases from `testdata/validate-golden.json`, and it does not run in CI. Separately, the TypeScript mutation battery **does** run on every pull request (`ci.yml:432` at `HEAD`) over a frozen corpus of crafted-wrong outputs with pinned per-class stages, and its own README calls that corpus the best TS-to-Rust validator differential vector set the repo has, with reuse deferred. Nothing executing anywhere compares the two implementations. The blocker is a decision about who owns the harness and whether the deliberate divergence carve-out at `historian_validate.rs:1391-1399` becomes a failure or a documented exception |
| H8 clock and deadline control | Advancing or injecting `failure_backoff_at_ms` expiry across firings, or compressing `MAX_WRAPUP_REQUEST_BUDGET` | **Yes for both records that need it. This row previously said "No seam found in this pass", which was wrong twice.** *Wrapup budget:* `wrapup_operation_budget` (`lib.rs:5445-5457`) returns a `#[cfg(test)]` override before falling back to the constant, and `wrapup_budget_bounds_busy_join_without_double_drive` (`:29236`) already sets it to 40 ms (`:29245-29248`) and restores it (`:29273-29276`). *Backoff expiry:* the gate compares the durable `failure_backoff_at_ms` against a caller-supplied `now` (`lib.rs:5042-5047`, `now` arriving via `HistorianPrepareContext` at `:4808-4821`), and the helper `expire_historian_backoff` (`:29784-29791`) already expires it by committing `Some(now_ms() - 1)`, driven by `assert_seeded_phase_recovers_then_refires_after_backoff` (`:29793`). The constants are still constants (`historian.rs:29`, `:962`, `:966`), but neither record has to wait on them. **Limit:** there is no global clock injection; the transform entry reads the real clock at `pass_now = now_ms()` (`lib.rs:8206`), so a property that needed `now` itself to advance would still have no seam |

One availability caveat that cuts across H1, H6, and H7. The gate is documented as
pure and verified to be so, which is what makes its records cheap. But
`historian.rs:1663-1664` persists the `Validating` phase **before** validating and
`:1693-1701` persists the abandon after rejecting, so a rejection is not
side-effect free for the caller. Any test that asserts "no database write" on a
rejection must scope the claim to the *compartment* write, which is where the
module's own doc claim (`historian_validate.rs:6-9`) is true, and not to the
*phase* write, where it is false.

## Map

All 25 records. "Non-vacuous today" means a developer can construct the required
state with the current harness. It does **not** mean the check runs anywhere;
under H0 none of them do.

Every record in this part is `default-production`, and the twelve that this map
previously treated as `explicit-config-only` were relabelled in the disposition of
the portfolio evaluation. The code-level gate is real: `model_chain` defaults to
empty (`config.rs:121`), is populated only from user config keys
(`config.rs:390-428`), and an empty chain short-circuits every entry point
(`lib.rs:5020-5030`, `historian.rs:1249-1251`). What decides the label is that a
completed setup cannot leave the chain empty, because `pickModel`
(`packages/cli/src/lib/model-picker.ts:71-91`) cannot return a blank value and both
setup paths always write its result (`setup-opencode.ts:445`, `:545-553`;
`setup-pi.ts:403`, `:471-481`). See the resolved subsection in `catalog.md` for the
full argument. "A configured model chain" remains a precondition of every row and
is not repeated per row.

### Publish pipeline: commit point, atomicity, and preservation

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| publish-transaction-rolls-back-every-write-on-a-late-sql-error | A fired run reaching `Publishing`, then a main-schema `BEFORE UPDATE ON mc_cache_state` trigger raising `ABORT` so the closure's last write (`mc-store:9496-9500`) fails after three writes have applied (H4, error half). Install the trigger from a second raw connection to the descriptor's path, as `mc-store:16688` already does (`:16691-16694`, `:16704`) | **Yes** — no new seam; the closure's own `?` is the mechanism |
| publish-transaction-survives-process-death-as-all-or-nothing | A real termination **between** two of the six writes at `mc-store:9457-9500` (H4, termination half). No seam exists: `after_store_publish` (`lib.rs:3313`, `:3350`) fires after the store call returns, and the transaction body has no hook. Needs a subprocess kill harness with a named kill point; the power-loss variant needs `dm-flakey` | **No** — the only record in this part that no current or cheap capability can make non-vacuous |
| publish-preserves-raw-chunk-messages-atomically | One accepted publish, then inflate `raw_messages_deflate` and compare against the JSON serialized at `historian_chunk.rs:717-727`. **No fault class required.** To attack it, add a chunk whose condensed transcript exceeds 256 KiB so the transcript is dropped (`mc-store:12682-12686`) while raw must survive (H1 for the oversized body) | **Yes** |
| raw-chunk-message-retention-has-no-eviction-budget | Enough publishes on one session to push `SUM(LENGTH(transcript_deflate))` past 8 MiB (`mc-store:410`) so the eviction loop at `:12718-12763` actually runs and is observed to blank rather than delete. No fault; a volume fixture | **Yes** |
| publication-floor-never-outruns-appended-coverage | An accepted publish whose last compartment was discarded by boundary healing, which needs at least two compartments and a lookahead distance within `BOUNDARY_HEALING_SLACK = 2` (`historian_validate.rs:19`, applied at `:554`) (H1) | **Yes** |
| publication-floor-advances-only-on-publish | An emergency-band pass, plus a concurrent firing that abandons (must not trip the detector at `lib.rs:8493`) and one that publishes (must) (H5) | **Yes** |

### Publish pipeline: single flight, fences, races, recovery

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| historian-single-flight-admits-one-publish-per-firing | Two publishes contending for one session. The in-process guards (`lib.rs:4556-4581`, `:4640-4650`) prevent a true race by design, so the construction bypasses them and drives `publish_validated_chunk` twice, which the `pub fn` seam permits. Because all five predicate fields plus the row-version CAS are compared inside the transaction (`mc-store:9373-9407`), the second publisher's rejection is reachable **sequentially**: publish once, then re-drive the same now-stale request. A genuine concurrent interleaving remains unavailable and is not required for the outcome (H5) | **Yes** |
| publish-fence-rejects-selected-content-drift | A fired run plus a divergence between the predicate's `selected_range_identities` and the stored `block_identity_by_mid`. The commit hook the existing tests at `historian.rs:2323` and `:2942` use is one seam, but the store-side gates are predicate comparisons (`mc-store:9413-9425`), so the outcome is equally reachable by **seeding** a mismatching predicate with no interleaving at all; the untested arm is the empty-identity-vector rejection at `:9413-9417`, which needs only a predicate carrying an empty vector (H5 for the live-mutation form, none for the seeded form) | **Yes** |
| publish-admits-awaiting-producer-phase-at-commit | A caller reaching `publish_historian_chunk` from `AwaitingProducer`. No in-repo caller does: `publish_output_from_awaiting` always transitions first (`historian.rs:1706-1707`). So today the oracle is a coverage check on the independent preconditions, not a demonstration | **Partial** — the coverage form is writable today and the gate widening is verified by reading `mc-store:9389-9396`; a real `AwaitingProducer` publish needs a caller that does not exist |
| crash-before-publish-commit-refires-without-partial-state | A termination in each of four windows, then a restart through `maybe_spawn_reattach` (`lib.rs:4614-4806`) (H2). Because each phase is its own durable write, seeding a `Firing`, `Validating`, or `Publishing` row **is** the post-crash state for the three pre-commit windows, and `historian.rs:4596` and `:4647` already do that. The fourth window, inside the transaction, needs H4 and is covered by the record above | **Partial** — the load side is constructible by seeding; no test terminates a process, and the post-commit-pre-acknowledgement window is unreachable |
| reattach-publishes-a-chunk-recomputed-after-the-model-ran | A restart or process handoff leaving an `AwaitingProducer` row, plus a transform request whose projection has grown past the pinned `chunk_range.to_ordinal` before the reattach publishes (H2 seeded form plus H1) | **Yes** |
| uncertain-producer-start-authorizes-a-second-billable-run | A chain with at least two models, and a producer double that fails the first `start` with a transient-classified error carrying `OutcomeUnknown` (`historian_producer.rs:80`), then succeeds on the second (H3). The oracle counts runs at the fake, per the effect-accounting rule: `acknowledged <= observed runs <= attempted` | **Yes** — the variant and the double both exist; only the vector is missing |
| wrapup-rounds-require-observed-boundary-advance | A session with several chunks left to drain and a producer double that publishes a fold which does not advance `max_compartment_end_ordinal`, so the break at `lib.rs:6982-6989` is exercised. The termination half injects the deadline through the `#[cfg(test)]` `wrapup_operation_budget` override (`lib.rs:5445-5457`), exactly as `wrapup_budget_bounds_busy_join_without_double_drive` (`:29236`) already does at `:29245-29248` (H8) | **Yes** — was `Partial`; the bounded-termination half is no longer blocked, because the deadline seam exists and is already exercised |

### Validation gate: what the gate does not check

Every row in this section was previously routed through a producer run. That is
over-costed. `parse_compartment_output` and `validate_historian_output` are
deliberately pure: the module doc says so (`historian_validate.rs:5-9`) and the
signature confirms it, taking only `text`, `chunk`, `prior_compartments`, and
`options` with no store, clock, filesystem, or environment access
(`:450-455`). So the cheapest valid oracle for every gate record is a **direct
function call** on a hand-built chunk plus a hostile output string, with the
producer double reserved for the records that actually need a driven run. The
"H1" tags below are retained to name the *vector* being authored, not to require a
producer.

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| hv-output-not-bound-to-chunk-identity | A direct `validate_historian_output` call on a chunk built from conversation A, with an output fixture taken from unrelated conversation B whose ranges are renumbered contiguous over `A.chunk.start_index..=A.chunk.end_index` and whose `<unprocessed_from>` is `A.chunk.end_index + 1` (H1 vector). Assert `Err`; it returns `Ok` today. The gate consults only `start_index`, `end_index`, `lines[].ordinal`, `lines[].message_id`, `lines[].anchorable`, `present_ordinals`, `tool_only_ranges`, and `completed_tool_arcs`, so nothing else must be faked | **Yes** |
| hv-degenerate-body-passes-content-gate | A producer returning one well-formed compartment with a one-character `p1`, a non-empty `title`, a matching `<unprocessed_from>`, and `end_message - start_message` at least 100 (H1) | **Yes** |
| hv-no-cross-compartment-content-distinctness | A producer returning N contiguous compartments whose ranges partition the chunk and whose `(title, p1, p2, p3, p4)` tuples are copies of one another (H1) | **Yes** |
| hv-importance-unbounded-then-truncating-cast | A producer emitting `importance="4294967296"` on an otherwise valid compartment, then reading the stored row (H1 plus H6). Parsed as bare `\d+` at `historian_validate.rs:1195`, captured to `u64` at `:306`, narrowed by `as i32` at `historian.rs:57` | **Yes** |
| hv-control-characters-reach-durable-rows | A producer emitting a compartment whose `p1` body or `title` attribute contains `\u{2028}`, `\r`, or an ANSI escape introducer (H6). The oracle reads the durable row, not the render, because `decay_render.rs:104-121` strips controls from titles only | **Yes** |
| hv-unescape-xml-double-decodes-entities | **No fault class at all.** A direct call: assert `unescape_xml(escape_xml_content(s)) == s` over a domain that includes the literal five-character sequence `&lt;` as prose. `unescape_xml` (`historian_validate.rs:1148-1154`) replaces `&amp;` first, so `&amp;lt;` becomes `&lt;` becomes `<` (H6) | **Yes** — the cheapest oracle in the part |
| hv-single-compartment-skips-lookahead-discard | A chunk whose content yields a **single** compartment ending at or within two ordinals of `chunk.end_index`, with `in_emergency` and `force_keep_last_compartment` both false, so the whole discard-last block at `historian_validate.rs:539-558` is skipped by the `>= 2` guard (H1) | **Yes** |
| hv-side-channel-anchor-out-of-range-drops-silently | A producer emitting a fact, event, or primer anchored to a compartment index above the count that survives discard-last, plus a second case with more than one surviving primer to reach the undocumented `.take(1)` at `historian_validate.rs:611` (H1). The oracle counts items in, items out, and reported drops | **Yes** |
| hv-heal-extends-range-without-revalidating-content | A chunk with `tool_only_ranges` or `completed_tool_arcs` populated by `historian_chunk.rs`, and a model output that leaves a gap inside one of them, so `heal_compartment_gaps` (`:927-930`) or `heal_terminal_completed_tool_arc` (`:889`) mutates `end_message` (H1) | **Yes** |

### Validation gate: enforcement that rests on convention

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| hv-tierless-stored-row-arm-must-stay-unreachable | Instrument the `1` arm of the `legacy` expression at `historian.rs:65` and drive both production publish routes (`historian.rs:1419`, `:1592`) plus the two publication fences. **No fault required** for the negative claim. The positive side, showing the arm can fire, needs a hand-built `ValidatedChunk` with a blank `p1`, which `Default` and the all-`pub` fields at `historian_validate.rs:226-238` make trivial | **Yes** |
| hv-publish-accepts-unvalidated-validated-chunk | **None in the current tree.** The record documents that the type system does not enforce the invariant: `historian.rs:444` is `pub fn` in a `pub mod` (`lib.rs:19`), `ValidatedChunk` derives `Default` with eight `pub` fields, and four existing tests (`historian.rs:4173`, `:4328`, `:4414`, `:4495`) already call `publish_validated_chunk` with hand-built input, which demonstrates the bypass. The enabling change is a second production call site added later | **Yes** — as a coverage check over the current call graph |
| hv-validation-rejection-retry-has-no-attempt-bound | A producer that returns a well-formed document the gate rejects on every attempt, for every model in the chain, across N firing opportunities. Each opportunity is gated by the cooldown at `lib.rs:5042-5047`, which compares the durable `failure_backoff_at_ms` against a caller-supplied `now`, so the helper `expire_historian_backoff` (`lib.rs:29784-29791`) supplies the next opportunity at zero wall-clock cost (H8) | **Yes** — was `Partial`; the bounded-attempt oracle is no longer blocked, because expiring the durable field replaces advancing the clock |

**Totals: 22 non-vacuous today, 2 partial, 1 no.** Previously 19/4/1 over 24
records; the change is the atomicity split (one `No` becomes one `Yes` plus one
`No`) and the two H8 records moving from `Partial` to `Yes`.

The distribution is the opposite of Part 3's. There, cheap capabilities were
missing and records were blocked on infrastructure. Here almost everything is
constructible and nothing is protected. The single `No` is a process kill inside
the publish transaction. The two remaining `Partial` rows are
`publish-admits-awaiting-producer-phase-at-commit`, blocked on a caller that does
not exist rather than on a capability, and
`crash-before-publish-commit-refires-without-partial-state`, whose load side is
constructible by seeding a durable phase while no test terminates a process.

## Coverage checks to add

Each asserts a precondition that a **correct** implementation still satisfies, so
it fires without a defect present. Names are constants, globally unique, and never
constructed dynamically.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `historian_publish_transaction_appended_at_least_one_compartment` | The transaction reached `append_compartments_tx` (`mc-store:9457-9471`) with a non-empty batch | The ordinary shape of every accepted publish |
| `historian_publish_gate_admitted_a_non_publishing_phase` | The phase guard at `mc-store:9389-9396` was satisfied by a durable state other than `Publishing` | The independent precondition of the widened gate. Legal: the guard names two phases, so observing the second is a fact about the code, not an outcome |
| `historian_publish_route_count_exceeded_one` | More than one distinct call site reached `publish_validated_chunk` during a campaign | Legal and true today: `historian.rs:527-530` plus two fences at `lib.rs:3296` and `:3332`. This is the precondition of an unvalidated publish, stated without asserting one occurred |
| `historian_restart_load_observed_a_pre_commit_phase` | A restart load saw `Firing`, `Validating`, or `Publishing` (`historian.rs:648-653`) | Legal by construction; that mapping exists for exactly this state |
| `historian_transcript_eviction_loop_blanked_a_row_holding_raw_messages` | Eviction chose a victim that still held `raw_messages_deflate` and blanked rather than deleted it (`mc-store:12748-12756`) | The documented rule, "Full message recovery is durable by contract" (`:12749-12750`) |
| `historian_condensed_transcript_exceeded_the_compressed_cap` | A publish carried a condensed transcript past `MAX_CHUNK_TRANSCRIPT_COMPRESSED_BYTES` so it was dropped while raw survived | A legal input-size outcome; it is the precondition of the raw-preservation claim, not the claim |
| `historian_selected_range_identity_changed_during_the_model_window` | One selected mid's block identities changed between the fire and the commit | Legal and expected on a live session; the fence exists for it |
| `historian_selected_range_identity_vector_was_empty_at_commit` | A predicate reached the fence with no recorded identities (`mc-store:9413-9417`) | Records the case the outright rejection exists for, without asserting an outcome |
| `historian_producer_start_returned_an_unknown_send_outcome` | A `start` call returned `HistorianSendOutcome::OutcomeUnknown` | Legal input shape and the production shape of an ambiguous send. This is the independent precondition of a second billable run, and a correct implementation still receives it |
| `historian_fallback_advanced_to_a_second_model` | The chain moved past its first model within one firing | Legal; the chain exists for it |
| `historian_wrapup_round_completed_without_boundary_advance` | One counted wrapup round finished with `max_compartment_end_ordinal` unchanged | The precondition the break at `lib.rs:6982-6989` handles. Legal to observe; the break is the correct response |
| `historian_validation_rejected_a_well_formed_document` | The gate returned `Err` for a document that parsed successfully | Ordinary and expected; it is the gate's whole purpose |
| `historian_validation_rejection_persisted_two_phase_writes` | A rejection produced both the `Validating` persist (`historian.rs:1664`) and the abandon persist (`:1693`) | Both writes are deliberate and documented (`:1709-1713`); recording them is what scopes the "no database write" claim honestly |
| `historian_gate_accepted_a_single_compartment_output` | An accepted set contained exactly one compartment, so the discard-last block was skipped by the `>= 2` guard | Legal; a one-compartment fold is a normal outcome |
| `historian_gate_healed_a_compartment_end_ordinal` | An accepted compartment's `end_message` differed from its parsed value | Legal; both heal functions exist for it |
| `historian_gate_dropped_a_side_channel_item_for_an_out_of_range_anchor` | `keep_side_channel` returned false for at least one item | The independent precondition of the silent-loss record. Legal: the bound exists and out-of-range anchors are a normal model error |
| `historian_gate_received_an_importance_above_i32_max` | A parsed `importance` exceeded `i32::MAX` before the narrowing cast at `historian.rs:57` | An input-domain outcome, legal to observe; the precondition of the wrap, not the wrap |
| `historian_gate_received_a_double_escaped_entity` | An input field carried `&amp;lt;`, the correct escaping of the literal text `&lt;` | Legal and correct producer output; asserting it is present says nothing about what `unescape_xml` returns |
| `historian_gate_ran_against_the_typescript_oracle_corpus` | At least one crafted-wrong corpus case was run through the Rust validator in the same campaign as the TypeScript one | Legal by construction, and it is the precondition of any differential claim |

**Anti-patterns to avoid in this part specifically.** Four concrete pairings are
forbidden by METHOD.md's rule, and each is tempting here because the defect is
easier to name than its precondition.

- Do not pair `always(!second_producer_run_started)` with
  `sometimes(second_producer_run_started)`. That marker can only fire by observing
  the duplicate spend. Assert
  `historian_producer_start_returned_an_unknown_send_outcome` and
  `historian_fallback_advanced_to_a_second_model` instead: two independent
  preconditions, both legal, and both present on a correct implementation.
- Do not pair `always(importance_in_1_to_100)` with
  `sometimes(importance_out_of_band)`. Assert
  `historian_gate_received_an_importance_above_i32_max` instead.
- Do not pair `always(unescape_roundtrips)` with
  `sometimes(unescape_double_decoded)`. Assert
  `historian_gate_received_a_double_escaped_entity` instead. The round-trip claim
  is already a total `always` over the input domain, so a companion `sometimes` on
  the failure adds nothing and is unsafe.
- Do not pair `always(publish_preceded_by_validation)` with
  `sometimes(publish_without_validation)`. Assert
  `historian_publish_route_count_exceeded_one` instead, which is the structural
  precondition and is true today with both production routes correct.

One further constraint on every marker in this part. The gate persists its phase
**before** it validates (`historian.rs:1664`), so a marker placed after the
`Validating` persist has already been preceded by a durable write. Place markers
at the point where the precondition becomes true, not after the code has finished
depending on it.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put producer-double
authoring at the top, and that is the wrong answer here: the two cheapest
capabilities in this part unblock **zero** new records between them and protect or
create coverage for all 25.

**State this plainly: the cheapest capabilities here are not faults.** They are
running the tests that already exist, and pointing a corpus that already runs at
the implementation it does not currently test. Both are wiring. Neither needs new
infrastructure, a new dependency, a subprocess harness, or a new seam.

1. **H0, running the existing 141 in-crate tests in CI.** A workflow change and
   nothing else: `cargo test -p mc-module --lib` alongside the existing
   `--test lifecycle_cli` step (`ci.yml:168` at `HEAD`), plus a first-ever
   `mc-store` test invocation. It unblocks **zero** new records and **protects 148
   existing test functions**: 51 in `historian.rs`, 19 in `historian_validate.rs`,
   19 in `historian_chunk.rs`, 18 in `historian_producer.rs`, 34 historian and
   wrapup tests in `lib.rs`, and the 7 store-side publish tests at
   `mc-store:16625-18336`. Nothing else on this list matters until this is done,
   because anything added below is added to a suite no automation executes. Both
   figures are corrections: the in-crate total was stated as 121 and the protected
   count as 128, and 51 + 19 + 19 + 18 + 34 is 141, plus 7 is 148.

2. **H7, pointing the existing TypeScript mutation corpus at the Rust
   validator.** The corpus is frozen, checked in, already runs on every pull
   request (`ci.yml:432` at `HEAD`), and already has pinned per-class expected
   stages across seven mutation classes (`mutations.ts:33-56`). The Rust side
   already has a golden driver that consumes a TypeScript-derived fixture
   (`historian_validate.rs:1384` over `testdata/validate-golden.json`'s 16 cases).
   Joining them is a harness step, not a new capability, and the lane's own README
   already identifies the corpus as the best TS-to-Rust differential vector set
   the repo has. This buys a **differential oracle for free**, which matters more
   here than anywhere else in the catalog, because ten of the gate's 22 rejecting
   checks have no test at all and a differential oracle covers checks nobody wrote
   a case for. Two things must be settled first, and both are decisions rather
   than work: who owns the harness, and whether the deliberate divergence
   carve-out at `historian_validate.rs:1391-1399` becomes a failure or a
   documented exception.

3. **H6, pure-function input sweeps over the gate.** No fault, no store, no
   producer, no process, no new dependency: a nested loop and direct calls to
   `unescape_xml`, `escape_xml_content`, `parse_compartment_output`, and
   `validate_historian_output`, which are documented and verified pure. It makes
   `hv-unescape-xml-double-decodes-entities` non-vacuous outright and supplies the
   input domain for `hv-control-characters-reach-durable-rows` and
   `hv-importance-unbounded-then-truncating-cast`. One of the three has a measured
   contradiction already waiting, since `&amp;` is replaced first at
   `historian_validate.rs:1149`, so the sweep pays out immediately.

4. **H1, authoring hostile output documents.** The vectors do not exist. Nine gate
   records plus four pipeline records depend on this and on nothing else. It is more
   test-authoring work than items 1 through 3, which is the only reason it sits here
   rather than above them: every existing fixture generates bodies from the
   compartment title (`historian_validate.rs:1367-1375`), so the hostile-document
   builder is new code. Note the scope correction: for the nine gate records the
   document goes straight into `validate_historian_output`, because the gate is pure
   (`:5-9`, `:450-455`), and the producer double is needed only for the pipeline
   records that require a driven run.

5. **H3, an `OutcomeUnknown` start failure.** One variant on one existing double,
   plus a run counter at the fake. It unblocks
   `uncertain-producer-start-authorizes-a-second-billable-run`, the one record in
   this part whose failure costs money rather than context quality, and it exposes
   the asymmetry between the output branch's cancellation proof
   (`historian.rs:1401`) and the start branch's absence of one (`:1290-1329`).
   Cheap enough to sit this high despite unblocking a single property.

6. **H2's seeded form, durable phase prefixes instead of a kill.** Because each of
   the five phases is its own durable write, seeding a `Firing`, `Validating`, or
   `Publishing` row is the post-crash state for the three pre-commit windows, and
   two existing tests already do it (`historian.rs:4596`, `:4647`). Extending them
   to assert "no compartment appended by this `firing_seq` exists" from every
   prefix costs no new mechanism. This does not close
   `crash-before-publish-commit-refires-without-partial-state`'s fourth window,
   which is item 8.

7. **H4's error half, a late SQL error inside the publish transaction.** Promoted
   into the ranking, because it turns out to need no new capability at all. A
   main-schema `RAISE(ABORT)` trigger on `mc_cache_state`, installed from a second
   raw connection to the descriptor's path, makes the closure's final write
   (`mc-store:9496-9500`) fail with three writes already applied, and
   `with_conn_fenced` then rolls back rather than committing
   (`cortexkit-store:229-231`). The technique is already used at `mc-store:16704`.
   It unblocks `publish-transaction-rolls-back-every-write-on-a-late-sql-error`,
   which is the falsifiable half of the part's most consequential invariant. It sits
   below the pure-function items only because it needs a store fixture rather than a
   direct call.

8. **H8, clock and deadline control.** No longer a blocker; retained in the ranking
   as the reminder that its two records are now writable. This item previously said
   the capability "requires a seam that does not exist today", and both seams do
   exist and are already exercised: the `#[cfg(test)]` wrapup-budget override
   (`lib.rs:5445-5457`, used at `:29245-29248`) and the `expire_historian_backoff`
   helper (`:29784-29791`, used at `:29793`). So
   `hv-validation-rejection-retry-has-no-attempt-bound` does not cost 60 seconds per
   attempt and `wrapup-rounds-require-observed-boundary-advance` does not cost 3800
   seconds per round. Both records are still the two whose failures are pure resource
   consumption rather than data or context corruption, which is why they sit below
   every safety item.

9. **H4's termination half, a real process kill inside the publish transaction.**
   **One** record, `publish-transaction-survives-process-death-as-all-or-nothing`,
   and it is the only record in this part that no current or cheap capability can
   make non-vacuous. It is also the most expensive item on the list, for a reason
   that is not a test-harness problem: the transaction's `tx.commit()` lives in
   `../commons/crates/cortexkit-store`, a sibling repository that CI provisions as
   a metadata-only stub (`ci.yml:159-160` at `HEAD`), so a real in-window kill
   needs either a hook in that repository or a subprocess kill harness with a named
   kill point. Making it assertable is an ownership decision before it is an
   engineering task. Note that the outcome-level half needs none of this: all
   seven gates at `mc-store:9373-9455` are already reachable, and four existing
   tests reach them.

**Records that need a product decision rather than a harness.** No amount of test
infrastructure resolves these, and each is a live open question from at least one
lens:

- Why the publish transaction admits `AwaitingProducer` (`mc-store:9389-9396`).
  Nothing in the store, the module, or any comment explains it, and it is the one
  place the documented five-phase machine and the actual commit gate disagree.
- Whether `ValidatedChunk` should carry a private field so only the gate can
  construct it, which is an API change with a `pub`-surface cost.
- Whether the gate or the renderer owns content sanitation. The asymmetry between
  `decay_render.rs:104-121`, which strips controls from titles and calls
  historian-authored titles untrusted, and `:138-147`, which guards only a body's
  `\n## ` sequence, suggests the split was not designed as a whole.
- Whether a validation rejection should increment
  `consecutive_publish_failures`. The name suggests store-side failures only, but
  `publish_health_degraded` (`lib.rs:6360`) is the only signal users see, and no
  TypeScript reader of it exists.
- Whether unbounded per-session `raw_messages_deflate` growth is the intended
  contract. The comment at `mc-store:12749-12750` reads as deliberate.
- Whether a span-relative body floor is wanted, or whether body adequacy is
  deliberately delegated to the historian-eval scorer lane, which tests a
  different implementation.
- Whether `.take(1)` on primers (`historian_validate.rs:611`) should be a
  documented cap or a reject when more than one survives.
- Whether `historian.two_pass` and `historian_timeout_ms` are TypeScript-leg-only
  features, and if so whether `CONFIGURATION.md` should annotate keys by leg.
