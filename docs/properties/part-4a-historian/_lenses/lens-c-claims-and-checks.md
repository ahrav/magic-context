# Part 4a lens C: claimed guarantees and the existing-check inventory

Attention focus: what the historian *says* it promises, and what actually
executes to hold it to that. This pass proposes no property records. The publish
pipeline belongs to
[lens-a-publish-pipeline.md](lens-a-publish-pipeline.md) and the validation gate
to [lens-b-validation-gate.md](lens-b-validation-gate.md); where a claim lands in
their territory this file records the claim and cites their record rather than
restating the analysis.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `76cd6f41`
("refactor(shm): simplify fixed-ring ownership"). Per METHOD.md rule 1 every CI
reference below is against `HEAD`, read from
`git show HEAD:.github/workflows/ci.yml`, with the working-tree line noted where
it differs, because both `.github/workflows/ci.yml` and
`.github/workflows/shm-hardening-optin.yml` are modified in the working tree.
`git status --porcelain` does report other modifications under `crates/mc-host`,
`packages/mc-shm-native`, and `packages/plugin/src/shared/`, so the clean state
was confirmed per path rather than globally: `crates/mc-module`, `crates/mc-store`,
`packages/e2e-tests/src/historian-eval`, `packages/e2e-tests/historian-eval`,
`packages/e2e-tests/scripts/run-test-selection.ts`,
`packages/plugin/src/hooks/magic-context/`, `packages/docs/src/content/docs`,
`README.md`, `ARCHITECTURE.md`, and `CONFIGURATION.md` all report clean, so every
non-workflow line reference below is both the working-tree and the `HEAD` line.
Each was read back individually at `HEAD`.

Method contract in [../../METHOD.md](../../METHOD.md).

## Claims register

Twenty-five claims, ordered by consequence to the user's real conversation. A
claim here is a lead under test, never imported truth. `NOT FOUND` means no
implementing code exists in this repository, which is the highest-value column.

| # | Verbatim claim (source) | Implied property | Implementing code |
| --- | --- | --- | --- |
| C1 | "Original CK messages for exact durable full-message and verbose recovery." (`historian.rs:425`) | The folded conversation stays recoverable verbatim after substitution. | `historian_chunk.rs:717-727` serializes; `historian.rs:525` carries; `mc-store/src/lib.rs:9472-9481` inserts. Verified. Owned by lens A `publish-preserves-raw-chunk-messages-atomically`. |
| C2 | "Original CK messages in the compacted interval, serialized for durable ctx_expand." (`historian_chunk.rs:499`) | The `ctx_expand` tool can serve the pre-fold bytes. | Field populated at `historian_chunk.rs:717-727`. The `ctx_expand` **read** side is outside this scope and unverified here. |
| C3 | "a publish never mutates cached render state directly" (`historian.rs:5-6`, restated `:443`); "The transaction intentionally leaves render state (`CoreState`, `coverage_ordinal`, watermarks, and m1 revision) untouched" (`mc-store/src/lib.rs:9345-9350`) | Substitution is additive; no pass loses the original view because of a publish. | Verified by lens A over the whole closure `mc-store:9360-9505`. Lens A lead 4 qualifies it: the two publication fences do take the transform snapshot mutex (`lib.rs:3304`, `:3341`). |
| C4 | "malformed ranges, stale chunks, bad message-id endpoints, and boundary-healing decisions are resolved before any database write is possible" (`historian_validate.rs:6-9`) | No model text reaches storage without passing the gate. | True of the compartment write. **False of the phase write**: `historian.rs:1664` persists `Validating` before validating and `:1693-1701` persists the abandon after. Lens B lead 1. |
| C5 | "Strict validation makes tierless output unreachable, but derive legacy from P1 so a future bypass cannot falsely mark a flat row as v2." (`historian.rs:59-60`) | Every published row is a v2 tiered row, and a bypass degrades safely. | The defensive derivation exists at `historian.rs:61-66`. The unreachability half is convention only. See lead L1. **Correction:** lens B cites this comment at `:60-62`; at `HEAD` it is `:59-60`, with the `legacy:` expression at `:61-66`. |
| C6 | "Single-flight is enforced here: any non-idle phase returns `Busy` with the unchanged state." (`historian.rs:232-233`) | One firing per session at a time. | `historian.rs:251-253`. Verified. Lens A `historian-single-flight-admits-one-publish-per-firing`. |
| C7 | "The publish predicate proves the producer still matches the exact firing that created the chunk; stale reattaches or a second racing publisher fail before any rows are appended." (`mc-store/src/lib.rs:9345-9348`) | A stale or duplicate publisher cannot write. | Seven gates at `mc-store:9373-9455`. Verified. Qualified by C8 and lead L2: the phase gate admits two phases. |
| C8 | "if it still observes a publishing row, the transaction did not commit, so the stale single-flight is abandoned" (`historian.rs:616-619`) | A crash before commit leaves no partial fold and does not wedge the session. | `handle_restart_load` at `historian.rs:620-655`, phases mapped at `:648-653`. Verified. Lens A `crash-before-publish-commit-refires-without-partial-state`. |
| C9 | "insertion/removal and type/id changes alter the fingerprint, while unrelated metadata drift and same-length content edits do not stale a snapshot" (`historian.rs:141-143`) | The fingerprint is deliberately blind to same-length content edits; something else must catch those. | `chunk_fingerprint` at `historian.rs:151-160`. The compensating control is `selected_range_identities` (`mc-store:9413-9425`). The claim is accurate and names its own hole. |
| C10 | "A compartment must end on an anchorable block so publication cannot mint an impossible coverage boundary." (`historian_validate.rs:36-37`) | No published boundary names a block that does not exist. | `historian_validate.rs:958-963`. Verified; test `compartment_end_must_be_anchorable` (`:1665`). |
| C11 | "make the matching firing immediately idle so the caller never leaves a durable Publishing wedge behind" (`historian.rs:550-551`) | A losing race never blocks all future firings for the session. | Four differentiated abandon arms at `historian.rs:533-593`. Verified. |
| C12 | "Authorizing fallback starts a second potentially billable run, so this needs positive proof, not the absence of one known-bad code." (`historian.rs:1228-1229`) | A second model attempt runs only after the first is proven stopped. | Enforced on the output branch (`historian.rs:1401`). **Not enforced on the start-failure branch** (`:1290-1329`). Lens A `uncertain-producer-start-authorizes-a-second-billable-run`. |
| C13 | "The id must be unique per (lineage, firing), not per (project, firing)" (`historian.rs:1004-1005`) | Concurrent subagent lineages cannot cross their producer runs and lose a commit. | `historian.rs:1013-1035`, full 64-bit FNV-1a rendering justified at `:1034-1035`. Tests `full_lineage_hash_separates_keys_that_collided_at_32_bits` (`:2146`), `producer_session_ids_are_lineage_scoped_under_one_project` (`:2163`). |
| C14 | "an unknown `session.send` outcome is retried at most once with the exact frozen bytes under the same route identity (Broca's session fingerprint makes that recovery idempotent)" (`ARCHITECTURE.md:37`) | An ambiguous send cannot become two billable runs. | `send_frozen_once` (`historian_producer.rs:929`) plus `replay_frozen_once` (`:949`), fenced at `:999-1000` and reported at `:492`. Holds **within one attempt**. Does not cover the cross-model chain: see lead L3. |
| C15 | "`run.status` handling is closed over the exact wire vocabulary (undocumented statuses fail loud instead of guessing)" (`ARCHITECTURE.md:37`) | An unknown provider status never gets guessed into a publish or an abandon. | Test `run_state_mapping_is_closed_over_known_states` (`historian_producer.rs:2175`) exists. The production mapping was not read end to end in this pass; recorded as unverified. |
| C16 | "Skips unanchored fact, observation, and primer promotion on the discarded tail to prevent double-storing when the range is re-processed." (`ARCHITECTURE.md:117`) | A re-processed range does not promote its facts twice. | `keep_side_channel` (`historian_validate.rs:1086-1098`); doc comments at `:145-147` and `:177-179` state the same rule. Tests `:1774`, `:1815`, `:1849`. Verified. |
| C17 | "Guarded by progress (`k≥2`) and emergency-disabled." (`ARCHITECTURE.md:117`) | The weak-lookahead terminal boundary is withheld for re-derivation. | `historian_validate.rs:539` guards on `compartments.len() >= 2`, **not** on a lookahead `k`. The lookahead test is separate, at `:554`. The doc's `k≥2` names the wrong quantity. Lens B `hv-single-compartment-skips-lookahead-discard`. |
| C18 | "The historian's in-flight snapshot is validated by `computeRawRangeFingerprint`, which hashes **raw content only** (ids, part types, content lengths) — never tag/drop state — so a concurrent drop can't invalidate it." (`ARCHITECTURE.md:88`) | A concurrent tag or drop cannot abort a firing. | The Rust analogue is `chunk_fingerprint` (`historian.rs:151-160`), which matches the description. But the Rust publish also fences on `selected_range_identities` (`mc-store:9413-9425`), a second freshness input the doc does not mention. See lead L4. |
| C19 | "repeated failures show a `Magic Context — history comparting needs attention` notice" (`README.md:98`); "A warning only appears in `/ctx-status` after multiple consecutive failures." (`troubleshooting.md:93`) | A persistently failing historian is visible to the user. | **NOT FOUND for the Rust leg.** `buildHistorianFailureNotice` (`compartment-runner-validation.ts:210`) is called only from `compartment-runner-incremental.ts` (`:208`, `:396`, `:493`, `:546`, `:912`), the TypeScript runner. Nothing in `packages/plugin/src` reads `publish_health_degraded` or `consecutive_publish_failures`. See lead L5. |
| C20 | "Falls back to the draft if the editor call or its validation fails, so it can never regress behavior." (`CONFIGURATION.md:454`, `historian.two_pass`) | The documented second editor pass is safe by construction. | **NOT FOUND.** No `two_pass`, `historian_editor`, or `historian-editor` symbol exists anywhere in `crates/mc-module/src`. The `two_pass` identifiers in `selection.rs:872-1229` are an unrelated tool-drop batch concept. See lead L6. |
| C21 | "`historian_timeout_ms` \| `number` \| `300000` \| Timeout per historian call (ms)." (`CONFIGURATION.md:170`) | A user-configurable per-call timeout bounds a historian call. | **NOT FOUND.** `rg historian_timeout_ms crates/mc-module/src` returns nothing. The Rust leg bounds a call by `completion_wait_budget` (660 s) and `wrapup_round_wait_budget` (600 s, `historian.rs:966`), neither user-configurable. See lead L6. |
| C22 | "There is **no built-in fallback chain** — Magic Context never silently tries models you haven't configured" (`CONFIGURATION.md:354`); "**Historian only:** your active session model, as a last resort" (`:359`) | The set of models the historian may bill against is exactly what the user configured, plus at most the session model. | `model_chain` is built only from user keys at `config.rs:396-420` and deduplicated at `:571`; empty yields `NoModels` (`historian.rs:1250`, `lib.rs:5021`). The two sentences are in tension with each other; whether the Rust leg appends the session model was not established. Unresolved. |
| C23 | "User observations are stored only when the privacy collection gate is enabled." (`historian.rs:421`) | Nothing derived from the user's own words is stored without the gate. | `collect_user_memory_candidates` threaded into the publish request; default off at `config.rs:128` per lens B. The store-side honouring of the flag was not read in this pass. Unresolved. |
| C24 | "The substance floor must not block firing." (`historian_chunk.rs:470-471`, `fold_is_only_reclaim`) | On verbatim-tail profiles, where folding is the only reclaim, a small chunk still fires. | Tests `fold_only_fires_below_substance_floor_without_emergency` (`historian_chunk.rs:1784`) and `below_budget_refuses_normally_but_fires_in_emergency` (`:1793`). Verified as a claim with a test. |
| C25 | "A historian publish does NOT bust the cache — between busts every pass is `cache_hit`." (`ARCHITECTURE.md:79`) | Folding never costs the user a cache-priced re-read. | Consistent with C3: the transaction writes no render state. The `mc-module` side of the deferral was not traced in this pass. Unresolved, needs the transform lens. |

## Contract-vs-code leads

Ordered by consequence. L1 and L2 are the two leads the task named; both are
verified, with one line-number correction.

**L1. "Strict validation makes tierless output unreachable" names its own future
bypass and nothing closes it.** The comment at `historian.rs:59-60` reads in
full: "Strict validation makes tierless output unreachable, but derive legacy
from P1 so a future bypass cannot falsely mark a flat row as v2." The surrounding
prose is the doc comment on `to_stored_compartment` (`:35-37`), which frames the
function as a pure projection: "Validation resolves the message-id endpoints and
tiers; publication stamps the row". So the module's own comment states that the
unreachability rests on a call-path convention, not on a type or an assertion,
and then writes a defensive fallback for the case where the convention breaks.
That is an admission, not a defect, and it is the clearest single sentence in the
subsystem for a reader trying to understand what is and is not enforced. Lens B
captured both halves as `hv-tierless-stored-row-arm-must-stay-unreachable` and
`hv-publish-accepts-unvalidated-validated-chunk`. **Correction:** lens B cites
the comment at `historian.rs:60-62`; at `HEAD` the two comment lines are `:59-60`
and the `legacy:` expression they guard runs `:61-66`.

**L2. The commit point admits `AwaitingProducer`, so the documented validation
phase is not enforced where it matters.** Verified by reading
`mc-store/src/lib.rs:9389-9395`: the guard is
`if !matches!(meta.historian.state, HistorianPhase::Publishing | HistorianPhase::AwaitingProducer)`,
with the two admitted phases on `:9391`. The surrounding prose makes this a
contradiction rather than a gap. The function's own doc comment
(`mc-store:9345-9348`) claims "The publish predicate proves the producer still
matches the exact firing that created the chunk; stale reattaches or a second
racing publisher fail before any rows are appended" — which is about identity,
not about validation having run. `historian.rs:1-6` names `validating` as a phase
the pipeline passes through, and `historian_validate.rs:6-9` says decisions are
resolved "before any database write is possible". Nothing in the store, the
module, or any comment explains why `AwaitingProducer` is admitted. Owned by
lens A `publish-admits-awaiting-producer-phase-at-commit`; recorded here because
the claim side is this lens's job and because the doc comment nearest the gate
does not mention validation at all, so a reader auditing the gate would not know
a claim was being broken.

**L3. The idempotent-resend claim is scoped to one attempt and the fallback loop
leaves that scope.** `ARCHITECTURE.md:37` says an unknown `session.send` outcome
"is retried at most once with the exact frozen bytes under the same route
identity (Broca's session fingerprint makes that recovery idempotent)". Both
halves are implemented: `send_frozen_once` (`historian_producer.rs:929`), one
replay (`:949`), and a fence that refuses to replay across a changed daemon or
identity, reported as `CrossIncarnationUnknown` (`:492`, constructed from the
comparisons at `:999-1000`). Tests pin it: `same_daemon_and_identity_resends_exact_bytes_once`
(`:1734`), `second_unknown_outcome_stops_without_third_attempt` (`:1754`),
`changed_daemon_returns_typed_unknown_without_resend` (`:1772`),
`any_semantic_identity_change_prevents_resend` (`:1793`). The gap is a layer up:
the producer session id embeds `firing_seq` by design (`historian.rs:1001-1002`),
so a fallback model attempt runs under a *different* session id and Broca's
fingerprint dedup cannot apply. `ARCHITECTURE.md`'s "makes that recovery
idempotent" is therefore true of the replay and false of the fallback, which is
exactly the branch lens A found unprotected (`historian.rs:1290-1329`). The doc
sentence reads as a stronger guarantee than it is.

**L4. `ARCHITECTURE.md:88` describes a one-input freshness check; the Rust
publish has two.** The doc says the in-flight snapshot is validated by a raw
content fingerprint "so a concurrent drop can't invalidate it". The Rust
fingerprint matches that description (`historian.rs:141-143`, `:151-160`), but
the commit point also fences on `selected_range_identities`
(`mc-store:9413-9425`), whose own comment says the fingerprint "remains a
readable structural diagnostic; exact content freshness is verified using the
durable block identities" (`mc-store:9409-9412`). Those two prose passages
disagree about which mechanism is load-bearing. A reader who takes
`ARCHITECTURE.md:88` at face value would not know a second, stricter fence
exists, nor that it rejects outright on an empty identity vector.

**L5. The user-visible failure signal has no Rust-leg producer.** `README.md:98`
and `troubleshooting.md:93` both promise a notice after repeated failures. The
Rust module does compute a health flag —
`"publish_health_degraded": consecutive_publish_failures >= 3` at `lib.rs:6360` —
but a repository-wide search finds no TypeScript reader of either
`publish_health_degraded` or `consecutive_publish_failures`, and the only callers
of `buildHistorianFailureNotice` are in `compartment-runner-incremental.ts`, the
TypeScript runner, which does not import `module-transport`. Compounding it,
lens B verified that a validation rejection never increments the counter at all:
`abandon_with_detail` copies it forward unchanged, which I re-verified at
`historian.rs:358`. So on the Rust leg a historian that rejects every output
indefinitely produces no notice by two independent mechanisms: the counter does
not move, and nothing reads it if it did. Unresolved, needs confirmation from a
TypeScript-side pass that no other surface consumes the module status block.

**L6. Two documented `historian` configuration keys have no Rust
implementation.** `historian.two_pass` (`CONFIGURATION.md:454`,
`packages/docs/.../configuration.md:100`) and `historian_timeout_ms`
(`CONFIGURATION.md:170`) are both documented with defaults and behavioural
promises. Neither identifier exists in `crates/mc-module/src`. `two_pass`
carries the strongest safety claim of the two — "so it can never regress
behavior" — for a feature that does not exist on this leg. The most likely
explanation is that both are TypeScript-leg features and the configuration
reference does not distinguish legs; that is a documentation-scope question, not
necessarily a defect, but a user reading `CONFIGURATION.md` and running the Rust
module gets a promise with no implementation behind it. Needs a human decision on
whether the reference should be leg-annotated.

**L7. `HistorianValidationError`'s justification names a consumer that does not
exist.** `historian_validate.rs:239-241`: "Validation failures are plain,
serializable messages because callers surface them in repair prompts and
telemetry." Lens B verified there is no repair-prompt construction anywhere in
the module. Recorded again here only because the claim is a *design
justification* for a type shape, so it is the kind of sentence a later change
would cite as precedent.

## Conventionally-enforced-only claims

Claims whose only enforcement is a comment telling a caller what to do.

1. **`ValidatedChunk` is not a proof-carrying token.** Verified at `HEAD`:
   `historian_validate.rs:226` is
   `#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]` and
   the struct at `:227-238` has eight `pub` fields and no private member. The
   module is `pub mod historian_validate` (`lib.rs:23`), the consumer is
   `pub mod historian` (`lib.rs:19`), and `publish_validated_chunk` is `pub fn`
   at `historian.rs:444`. So `Default::default()`, `serde_json::from_str`, or a
   struct literal all construct one, and any crate depending on `mc-module` can
   publish it. The task's report of this case is confirmed in full. Owned by
   lens B `hv-publish-accepts-unvalidated-validated-chunk`.
2. **The three consumer deadline budgets are hand-mirrored across languages.**
   `historian.rs:951-961` instructs consumers to use `MAX_WRAPUP_REQUEST_BUDGET`
   "VERBATIM, margin included, no consumer-side arithmetic on top", and
   `:960-961` adds "Bump this in the same commit as any change to those inputs
   and notify consumers." `:970-982` and `:985-997` repeat the rule for the
   emergency and non-emergency budgets. The TypeScript side duplicates the
   number by hand: `module-transport.ts:72-73` declares
   `MAX_WRAPUP_REQUEST_BUDGET_MS = 3_800_000` under the comment "Consumer
   deadline for the module's exported historian::MAX_WRAPUP_REQUEST_BUDGET",
   against the Rust `Duration::from_secs(3_800)` at `historian.rs:962`. Nothing
   mechanically compares them. Worse, `MAX_EMERGENCY_REQUEST_BUDGET`
   (`historian.rs:983`, 1500 s) has **no TypeScript mirror at all** that I could
   find, so the derivation at `:974-982` — which argues that a consumer deadline
   below this value "forwards a RAW array at the exact pressure where raw risks
   provider context-overflow" — is unenforced on the consumer side.
3. **`delete_session`'s default is a compatibility shim that production must
   override.** `historian.rs:789-791`: "Delete the provider session on every
   terminal path. The default calls close() for compatibility with older test
   producers, while production producers override this method". A producer
   implementation that forgets the override silently retains provider session
   data and nothing detects it.
4. **The historian system prompt must not be concatenated into `prompt`.**
   `historian.rs:894-895`: "Sent via the producer's `system` field, never
   concatenated into `prompt`." The reasoning is at `:938-943` — concatenation
   restructures a calibrated `[system, user]` request "into one the model was
   never tuned on (observed live as template-echo and seed-regurgitation on the
   calibration model itself)". A real observed failure, guarded by a comment.
5. **The wrapup keep watermark is honoured as given.** `lib.rs:6658-6660`: "The
   requested keep watermark is honored as given: it counts raw messages of ...
   and applies only a floor of 1". A caller passing a wrong watermark folds more
   of the live tail than intended and nothing refuses it.
6. **"The module owns the only store writer, so a process-local per-session
   latch is" sufficient** (`lib.rs:6675`). Single-writer is asserted in prose.
   Lens A found the durable enforcement one layer down, in the store's
   single-writer lease, which lives outside this repository.
7. **The tier parser "must never swallow a following tier's opener"**
   (`historian_validate.rs:1222`, guard at `:1128`). A regex contract stated as
   an obligation on future edits.

## Existing-check inventory

Every status below is **unaudited**. Adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for production
guards.

### In-crate tests (clustered, counts and line ranges)

Counts obtained by matching `#[test]`, `#[tokio::test]`, and
`#[tokio::test(...)]`, then listing each following `fn` line. Totals verified
against a whole-crate count of 938, which reconciles exactly with
`695 #[test]` + `163 #[tokio::test(` + `80 #[tokio::test]` across the crate.

| File | Tests | Attribute range | First / last test fn |
| --- | --- | --- | --- |
| `historian.rs` | **51** (13 sync, 38 tokio) | `:1862-4646` | `:1863` `stored_compartment_legacy_flag_tracks_p1_presence` / `:4647` `restart_mid_publishing_with_committed_tx_detects_idle` |
| `historian_validate.rs` | **19** (all sync) | `:1383-1848` | `:1384` `validate_golden_matches_typescript_oracle` / `:1849` `force_keep_last_preserves_final_compartment_and_side_channels` |
| `historian_chunk.rs` | **19** (all sync) | `:1299-2044` | `:1300` `chunk_uses_flat_block_ids_and_covers_system_ordinals_without_their_text` / `:2045` `fixture_builder_drives_boundary_chunk_assembly` |
| `historian_producer.rs` | **18** (2 sync, 16 tokio) | `:1711-2288` | `:1712` `start_opens_expected_identity_and_sends_once` / `:2289` `a_successful_drain_returns_text_and_the_length_cap` |
| `lib.rs`, historian-related | **34** matching `historian`, `wrapup`, or `reattach` | within the test module opening at `:15993` | `:16445` `historian_trigger_token_reuse_matches_retokenized_production_shape` / `:30037` `status_diagnostics_surface_pending_historian_side_channel_failure` |

**121 in-crate tests** across the four scope files plus the `lib.rs` historian
set. Clusters:

- **`historian_validate.rs`, 19 tests. The task's report is confirmed with one
  refinement.** The 19 count and the `:1384-1849` fn-line span are both correct;
  the attribute lines are `:1383-1848` and the last test body runs to the file
  end at `:1869`. Clusters: one TypeScript-oracle golden driver (`:1384`) plus a
  determinism check (`:1417`); gap and healing behaviour (`:1426`, `:1443`,
  `:1683`, `:1710`, `:1730`); tier parsing and the p1-only fallback (`:1463`,
  `:1483`, `:1512`); our-own-input validation (`:1531`, `:1576`); discard-last
  and its guards (`:1633`, `:1748`, `:1849`); envelope and anchorability
  (`:1653`, `:1665`); side-channel suppression (`:1774`, `:1815`). Lens B mapped
  these against the 22 rejecting checks and found **ten checks with no test at
  all** plus three with untested arms; that mapping is not repeated here.
- **`historian.rs`, 51 tests.** Six clusters. Pure state machine and projection
  (`:1863`, `:4213`, `:4243`, `:4286`, `:4379`); lineage and session-id isolation
  (`:2146`, `:2163`, `:3011`); the wired happy path and content-drift fences
  (`:2272`, `:2323`, `:2369`, `:4061`, `:4314`, `:4401`, `:4451`); the fallback
  chain and error classification, the largest cluster at fourteen tests
  (`:2410`-`:2850`, plus `:3895`, `:3938`); reattach and timeout recovery
  (`:2881`-`:3610`, plus `:4533`); cancellation-proof and cleanup discipline
  (`:3329`, `:3389`, `:3444`, `:3498`, `:3542`); restart load (`:4596`, `:4647`).
- **`historian_chunk.rs`, 19 tests.** Chunk construction and ordinal coverage
  (`:1300`, `:1368`, `:1391`, `:1498`, `:1651`); tool-arc and duplicate-id
  resolution (`:1432`, `:1818`); the substance floor and its bypasses (`:1772`,
  `:1784`, `:1793`); budget, truncation, and multibyte handling (`:1854`,
  `:1887`, `:1920`, `:1933`); two golden-fixture drivers (`:1962`, `:2045`).
- **`historian_producer.rs`, 18 tests.** The ambiguous-send replay fence, seven
  tests and the densest cluster in the subsystem (`:1712`-`:1978`); route and
  connection cleanup (`:2021`, `:2070`, `:2100`, `:2135`); the closed wire
  vocabulary (`:2175`, `:2222`, `:2247`); budget and drain (`:2193`, `:2289`).
- **`lib.rs`, 34 tests.** Dominated by `session.wrapup`, roughly twenty tests
  from `:27928` to `:29335`, covering the drain to the keep watermark, budget
  bounds, terminal replay, snapshot leases, and epoch fencing. Then the
  handler-level autonomous cycle (`:26660`), status and diagnostics (`:26623`,
  `:27246`, `:30037`), seeded-phase recovery (`:29822`, `:29827`, `:29832`),
  backoff (`:30010`), trigger behaviour (`:16445`, `:16518`, `:16720`), and
  shutdown of spawned historian work (`:16932`, `:17007`, `:17017`).

### Integration and CI status (with workflow line refs)

**Integration tests exercising the historian path: none found.** A
case-insensitive search for `historian` across all seven files in
`crates/mc-module/tests/` and both files in `crates/mc-module/tests/support/`
returns **zero matches**. The seven binaries hold 38 tests between them
(`boundary_counter_durability` 1, `broca_roundtrip` 2, `direct_host` 6,
`host_adapter` 4, `lifecycle_cli` 12, `prepared_output` 10,
`release_contract_conformance` 3), and not one names this subsystem. Every check
on the historian is therefore an in-crate unit test compiled into the `--lib`
target.

**The prior pass's two numbers are both confirmed.**

| Claim | Verdict |
| --- | --- |
| Only `lifecycle_cli` runs in CI | **Confirmed.** `cargo test -p mc-module --test lifecycle_cli` is the sole `mc-module` test invocation in any workflow. At `HEAD` it is `ci.yml:168`; in the modified working tree it is `ci.yml:172`. The task prompt and lens B cite `:172` (working tree); lens A cites `:167-168`. All three describe the same step. |
| 926 of 938 tests never execute | **Confirmed.** 938 total, `lifecycle_cli` contributes 12, so 926 never run. |

The full set of Rust test invocations at `HEAD` is `ci.yml:131`, `:168`, `:173`,
`:174`, `:180`, `:181`, `:183`, `:186`. Six of the eight target `mc-host`,
`mc-shm-native`, or `mc-shm-transport`. `--test lifecycle_cli` selects one
integration binary and does **not** build the `--lib` target, so no in-crate
`mc-module` unit test compiles in CI, let alone runs.

**`mc-store` is not named in any workflow at all.** Verified by searching all
five workflow files at `HEAD` for `mc-store`: zero matches in `ci.yml`,
`historian-eval.yml`, `retrieval-benchmark.yml`, `claude-code-review.yml`, and
`shm-hardening-optin.yml`.

**The store-side publish transaction does have tests — seven of them, none in
CI.** Answering the task's question directly, in `crates/mc-store/src/lib.rs`
(101 tests total): `:16625` `historian_publish_failure_counter_accumulates_and_success_state_resets`,
`:16688` `matching_historian_abandon_fences_predicate_and_update_for_both_backoffs`,
`:16781` `publish_historian_chunk_rejects_overlapping_compartment_as_typed_error`,
`:16984` `publish_historian_chunk_persists_transcript_inside_cas`,
`:17017` `publish_historian_chunk_cas_conflict_leaves_no_transcript_row`,
`:18221` `publish_historian_chunk_fails_loud_from_non_publish_state`,
`:18336` `publish_historian_chunk_rejects_recut_epoch_mismatch_as_conflict`,
plus two side-channel outbox tests at `:16829` and `:16927` and two fixture
helpers at `:16583` and `:16666`. So the commit point is not untested; it is
untested **in CI**, and per lens A none of the seven asserts that all six writes
in the transaction land or none do.

### TypeScript-side gates

This is the only historian coverage that executes on every pull request, so what
it covers matters more than its size.

The gate is one CI job, `historian-eval-contracts`, at `HEAD` `ci.yml:407-432`
(working tree `:415-440`). Its comment block at `HEAD` `:394-406` says the job
exists because "Nothing invoked test:historian-eval-unit" before it, and that it
"declares no `needs` so an unrelated failure cannot skip" it. Three steps:

| Step | `HEAD` line | Command | What it checks |
| --- | --- | --- | --- |
| Historian eval unit contracts | `ci.yml:426` | `bun run test:historian-eval-unit` | Every `src/historian-eval/**/*.test.ts` except `runner.test.ts`, which is excluded as harness-booting (`run-test-selection.ts:59-70`, `:84`). Six files: `contract.test.ts`, `dev-corpus.test.ts`, `mutations.test.ts`, `payload.test.ts`, `promote.test.ts`, `scorer.test.ts`. |
| Freeze lint over the dev corpus | `ci.yml:429` | `run-historian-eval.ts --lint` | Scenario-schema and freeze conformance of the `historian-eval/dev` corpus. Corpus hygiene, not module behaviour. |
| Invalid-state mutation battery | `ci.yml:432` | `run-historian-eval.ts --mutations` | For every scenario, crafted-wrong historian outputs must go red **at the expected stage** per mutation class. Seven classes with pinned outcomes (`mutations.ts:33-56`): `speculation-promoted` and `rejected-proposal-active` must score `FAIL:false-authoritative`; `wrong-category` and `dropped-gold-fact` must score `FAIL:recall`; `near-miss-perturbation` either; `structural-overlap` must land at `validation-rejected`; `probe-wrong-answer` must fail probe comparison. The battery fails on a stage mismatch, not only on a PASS (`mutations.ts:5-11`). |

**What these gates do not touch: the Rust historian.** Verified by reading the
scorer's imports. `scorer.ts:20-26` imports `validateHistorianOutput`,
`validateStoredCompartments`, `shouldDiscardLastHistorianCompartment`, and
`HISTORIAN_BOUNDARY_HEALING_SLACK` from
`packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts`, and
`:27-28` imports `appendCompartments` and `promoteSessionFactsDurable` from the
plugin's own storage and promotion modules. `mutations.ts:14` imports the slack
constant from the same TypeScript module. The `scoreRawOutput` seam the battery
drives is therefore
TypeScript-parse → TypeScript-validate → publish into a Bun SQLite temp DB
(`scorer.ts:715`, `:762-764`). No Cargo target, no `mc-module`, no
`historian_validate.rs`.

The lane's own code says so explicitly. `run-test-selection.ts:73-76`: the
harness-booting tests are "TS-mode only: `mc-module`'s Rust historian producer
does not promote claims, so these must never join a rust or pi selection." And
`historian-eval/README.md` names the untapped opportunity: the frozen corpus's
crafted-wrong outputs "are also the best TS<->Rust validator differential vector
set the repo has (reuse deferred, see plan scope)."

So the executing per-PR coverage measures a **parallel TypeScript
implementation** of the same contract. The only thing tying the Rust
implementation to it is one in-crate test,
`validate_golden_matches_typescript_oracle` (`historian_validate.rs:1384`),
driven by a checked-in `testdata/validate-golden.json` — and that test does not
run in CI either. Nothing executing anywhere compares the two implementations.

`historian-eval.yml` is the live lane; `README.md` records it as
`workflow_dispatch`/`schedule` only, with manual dispatch restricted to the
default branch because the job puts an API key in the job environment. It runs no
Rust target.

### Production assertions and guards (clustered)

**Explicit `assert!` or `debug_assert!` in the four scope files: none found.**
Verified per file over production lines only, cutting each file at its last
`#[cfg(test)]`: `historian.rs` (`:1821`), `historian_producer.rs` (`:1486`),
`historian_chunk.rs` (`:1171`), `historian_validate.rs` (`:1305`). Zero
assertions of either kind in any of them. All invariant enforcement is by
`Result`-returning guards.

**Panicking sites, all unaudited.** Two, and both are narrow:

- `historian.rs:1492` `RestartAction::ReattachProducer { .. } => unreachable!()`
  — the only `unreachable!`, `panic!`, or `todo!` in production code across the
  four files.
- `historian_validate.rs:929`
  `.expect("non-empty omitted present ordinals checked above")` — the only
  `.expect` in the four files, inside the gap-healing path.

**Infallible-by-construction unwraps.** 27 in `historian_validate.rs` and 8 in
`historian_chunk.rs`, and every one I sampled is a static regex compilation
inside a `OnceLock::get_or_init` (`historian_validate.rs:1159-1195`,
`historian_chunk.rs:1133-1168`). None depend on runtime data. Zero unwraps in
`historian.rs` and `historian_producer.rs` production paths.

**`debug_assert!` in the in-scope `lib.rs` regions: three.**

- `lib.rs:5068-5074`, "fold-only profile must not carry frozen tail reductions" —
  asserts no `red:*` frozen unit exists when `fold_is_only_reclaim` is true.
- `lib.rs:6478-6481` — pins the wrapup disposition to
  `"completed" | "nothing_to_compact" | "failed"`, the machine-readable contract
  a consumer parses.
- `lib.rs:7065-7069` — the wrapup drain reached the keep watermark unless a
  failure stopped it. The comment at `:7061-7064` is worth quoting because it
  states a design choice: "compartments never shrink, so a failure-free exit has
  reached the keep watermark. Assert the invariant instead of carrying a
  round-cap fallback". A `debug_assert!` compiled out of release builds is
  standing in for the round-cap the loop deliberately does not have.

**`mc-store`'s publish transaction has no assertions of any kind.** Verified
across `mc-store/src/lib.rs:9340-9560`: zero `assert!`, `debug_assert!`,
`.unwrap()`, or `.expect()`. Every failure is a typed `PublishTxnOutcome`
variant.

**Guard clusters, all unaudited.** Fingerprint re-check at the commit point;
the four differentiated abandon arms and their cooldown policy; the seven
store-side publish gates; the closed `run.status` vocabulary; the send-replay
fence; the cancellation-proof predicate; the 22 validation rejects and nine
silent drops enumerated by lens B; the substance floor and its two bypasses; the
chunk budget and truncation bounds; the wrapup per-round progress check and
budget re-check; restart-load phase mapping; the side-channel anchor filter.

## Suspiciously quiet areas

Ranked by the gap between what is claimed and what could detect a violation.

1. **The three quietest things in this scope, and the top one is the whole
   subsystem.** The historian's 121 in-crate tests, the 7 `mc-store` publish
   tests, and the 19 gate tests all execute nowhere in CI. 926 of the crate's 938
   tests never run, `mc-store` is absent from all five workflows, and no
   integration test in `crates/mc-module/tests/` mentions the historian. The only
   executing per-PR coverage is the TypeScript lane, which exercises a different
   implementation of the same contract.
2. **Nothing executing anywhere compares the Rust validator to the TypeScript
   one, and the two are documented as a matched pair.** Five in-crate test names
   assert TypeScript parity by construction —
   `validate_golden_matches_typescript_oracle` (`historian_validate.rs:1384`),
   `five_message_narrative_gap_rejects_like_typescript_validator` (`:1426`),
   `twenty_message_tool_only_gap_heals_like_typescript_validator` (`:1443`), plus
   the two golden-fixture drivers in `historian_chunk.rs` (`:1962`, `:2045`). All
   are ungated. Meanwhile the TypeScript lane's frozen corpus is described in its
   own README as "the best TS<->Rust validator differential vector set the repo
   has (reuse deferred)". The differential harness is one CI step away from
   existing and does not exist.
3. **The store-side publish transaction's atomicity claim is untested and
   currently untestable.** Seven tests reach `publish_historian_chunk`, but per
   lens A none asserts that all six writes land or none do, and the only test
   hook (`lib.rs:3311-3319`) fires *after* the store call returns, so no Rust
   test can land a fault inside the transaction. The transaction is where the
   substitution becomes durable, it has zero assertions, and the `tx.commit()`
   that defines its boundary is in a sibling repository that CI provisions as a
   metadata-only stub (`ci.yml:159-160` at `HEAD`).
4. **Ten of the validation gate's 22 rejecting checks have no test at any
   level**, per lens B's per-check mapping, and three more have untested arms.
   Answering the task's question directly, the untested ones are: nested
   `<output>` tags (check 2); compartment endpoint maps to a chunk line
   (check 8); inverted range (11); range outside the chunk (12); start ordinal
   not present (13); end ordinal not present (14); starts after coverage ended
   (15); chunk not strictly newer than the last stored end (5); uncovered
   messages with no `<unprocessed_from>` (20); and the covered-chunk
   `unprocessed_from` arms at `:1066-1074` (19). Checks 11 through 15 are the
   ordinal-sanity family — precisely the checks that stop a model from claiming
   coverage of a range it did not summarize.
5. **`historian.rs` has 51 tests and zero production assertions.** The most
   consequential file in the subsystem enforces every invariant through
   `Result`, so a violated invariant becomes a typed error a caller may or may
   not surface, never a loud failure. The one place the codebase reaches for an
   assertion instead of a mechanism (`lib.rs:7065`) uses `debug_assert!`, which
   is compiled out of release.
6. **The user-facing failure signal has no producer and its counter has no
   increment.** L5 and lens B's finding compose: `consecutive_publish_failures`
   is copied forward unchanged on the validation-rejection path
   (`historian.rs:358`), and no TypeScript reader of `publish_health_degraded`
   exists. Two independent breaks in one signal chain, and the only tests near
   it (`lib.rs:26623`, `:26639`, `:26656`) assert the flag flips inside the Rust
   status block, not that anything consumes it.
7. **The three consumer deadline budgets are cross-language constants with one
   hand-written mirror and no cross-check.** `MAX_WRAPUP_REQUEST_BUDGET` is
   duplicated by hand in `module-transport.ts:73`;
   `MAX_EMERGENCY_REQUEST_BUDGET` appears to have no mirror at all. The Rust
   comments explain in detail what breaks if a consumer gets these wrong
   (`historian.rs:974-982`: a raw array forwarded "at the exact pressure where
   raw risks provider context-overflow"). One `command-handler.test.ts:895`
   assertion pins the TypeScript side to its own constant, not to the Rust one.
8. **Two documented configuration keys with no implementation and no test that
   would notice.** `historian.two_pass` and `historian_timeout_ms` (L6). A
   configuration-reference conformance check comparing documented `historian.*`
   keys against `config.rs` parsing would catch both; none exists.
9. **`historian_chunk.rs`'s two golden fixtures are the only guard on chunk
   assembly, and assembly is what pins the raw messages.** `raw_chunk_messages`
   is built at `historian_chunk.rs:717-727` and is the sole durable copy of the
   folded conversation inside this store. Its two drivers (`:1962`, `:2045`)
   compare against checked-in fixtures, so a change that alters what is captured
   fails the fixture rather than an invariant — and neither runs in CI.
10. **The `unreachable!()` at `historian.rs:1492` and the `.expect()` at
    `historian_validate.rs:929` are the subsystem's only two panic sites and
    neither has a named test.** Both are reachable only through a state the
    author believed impossible, which is exactly the class a fresh test should
    attack.
11. **`docs/AUDIT-KNOWN-ISSUES.md` contains no historian publish, validation, or
    producer entry.** The file mentions historian only in passing. None of the
    contract-versus-code gaps in this lens or its two siblings is tracked there.

## Open questions

- Should the `historian-eval` frozen corpus be reused as a TS-versus-Rust
  validator differential, as its own README proposes? That single change would
  convert the repo's only executing historian coverage into coverage of the Rust
  implementation as well. It needs a decision on who owns the harness and whether
  the deliberate divergences lens B recorded (the empty-input error-string
  carve-out at `historian_validate.rs:1391-1399`) become failures or documented
  exceptions. (needs human input)
- Are `historian.two_pass` and `historian_timeout_ms` TypeScript-leg-only
  features, and if so should `CONFIGURATION.md` annotate keys by leg? A user on
  the Rust module currently reads a safety guarantee ("can never regress
  behavior") for a feature that is absent. (needs human input)
- Does any surface outside `packages/plugin/src` consume the module's
  `publish_health_degraded` flag (`lib.rs:6360`)? I searched `packages/plugin/src`
  and found no reader. A TUI, a doctor command, or the Pi plugin could read it.
  Unresolved, needs a TypeScript-side sweep.
- Why does the publish transaction admit `AwaitingProducer` (L2)? No comment
  anywhere explains it, and it is the one place the documented five-phase machine
  and the actual commit gate disagree. Lens A asks the same question; recording
  the duplicate deliberately so synthesis does not drop it as already answered.
  (needs human input)
- Does `CONFIGURATION.md:359` ("Historian only: your active session model, as a
  last resort") hold on the Rust leg? `config.rs:396-420` builds `model_chain`
  only from user config keys, and I did not find a session-model append. If the
  Rust leg does not implement it, C22's two sentences are consistent with the
  code and the doc is wrong; if it does, `:354`'s "never silently tries models
  you haven't configured" is the wrong half. Unresolved, needs a config lens.
- Does the store honour `collect_user_memory_candidates` (C23)? The flag is
  documented at `historian.rs:421` as the privacy gate for storing text derived
  from the user's own words. I traced it into the publish request but not into the
  store's write path. Unresolved, and it is a privacy claim, so it should not stay
  unresolved.
- Is `historian_producer.rs`'s `run.status` mapping genuinely closed over the
  wire vocabulary (C15)? A test asserts it (`:2175`), but I did not read the
  production mapping. Unresolved, needs a targeted read.
- METHOD.md's `Exercised` field question that both sibling lenses raise — whether
  a test that exists but never runs in CI is `partial` or `not yet` — applies to
  every check in this inventory. This file states CI status explicitly per
  category so a later ruling applies mechanically. (needs human input)
