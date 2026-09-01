# Part 4a property catalog: the historian publish path and its validation gate

Scope: the historian subsystem of `crates/mc-module`, five files.
`src/historian.rs` (4,682 lines) holds the state machine, the publish
projection, and the drive loop. `src/historian_producer.rs` (2,306) is the
provider transport. `src/historian_chunk.rs` (2,051) assembles the chunk and
captures the original messages. `src/historian_validate.rs` (1,869) is the
admission gate. Two regions of `src/lib.rs` are in scope: `:4543-5589`
(reattach, fire preparation, the publication fences) and `:6431-7132` (the
`session.wrapup` drain). One out-of-part file is load-bearing and is cited
throughout because the commit point is inside it: the store-side publish
transaction at `crates/mc-store/src/lib.rs:9360-9500`.

Boundary context, read but not cataloged: `decay_render.rs` as the renderer that
compensates for some of the gate's omissions, `historian_prompt.rs` as the
escaping counterpart, `config.rs` for the model chain, and the TypeScript
`packages/e2e-tests/src/historian-eval` lane as the only historian coverage that
executes per pull request.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`. HEAD is `76cd6f41`
("refactor(shm): simplify fixed-ring ownership"), and all three lens agents read
and verified their line references at that commit. All five scope files are
verified stable since `1c193ae0`: `git diff --stat 1c193ae0 HEAD` over
`historian.rs`, `historian_producer.rs`, `historian_chunk.rs`,
`historian_validate.rs`, and `lib.rs` is empty, so every line reference below
resolves at HEAD and at every commit in that range. `crates/mc-store` is
likewise byte-identical across the Part 3 range, so the publish-transaction
citations carry over from Part 3 unchanged.

One provenance caveat on CI references. Both `.github/workflows/ci.yml` and
`.github/workflows/shm-hardening-optin.yml` are modified in the working tree.
Per METHOD.md rule 1 every workflow line number in this catalog is against HEAD,
read from `git show HEAD:.github/workflows/ci.yml`. The one `mc-module` test
step is `ci.yml:168` at HEAD and `ci.yml:172` in the working tree; the
`historian-eval-contracts` job is `ci.yml:407-432` at HEAD and `:415-440` in the
working tree. Records inherited from the lens files cite whichever of those the
lens agent used, and all three refer to the same two places.

## Why this part matters

This is the highest-consequence subsystem cataloged so far. Parts 1 through 3
cover transports, lifecycles, and durability: mechanisms whose failure loses or
corrupts data the system was asked to keep. This part covers the only path in
the product that irreversibly substitutes unverified language-model output for
the user's real conversation. When it succeeds, the agent stops reading what the
user wrote and starts reading what a model said the user wrote. Four facts frame
every record below.

**The commit point is a single store transaction.** The transaction opens at
`crates/mc-store/src/lib.rs:9360` through `self.inner.with_conn_fenced(...)` and
commits at `tx.commit()` in the sibling checkout
(`../commons/crates/cortexkit-store/src/lib.rs:230`); inside this repository the
last operation before that commit is the row-version bump at
`mc-store:9496-9500`. Everything the substitution depends on lands in that one
transaction: the model-generated compartment rows (`:9458`), the deflated
original messages (`:9472-9481`), the queued side channels (`:9482`), the raised
publication floor (`:9484-9488`), and the reset to idle (`:9489`). Before it
commits, no summary row exists and a crash refires cleanly; `handle_restart_load`
maps `Firing`, `Validating`, and `Publishing` to abandon-and-refire
(`historian.rs:648-653`) on the reasoning stated at `:616-619`, that a surviving
`Publishing` row proves the transaction did not commit. After it commits, the
transform's next materializing pass folds the covered prefix behind `m0`/`m1`
and the model's text is what the agent sees.

**The user's original messages are preserved in that same transaction, with one
exception.** `raw_chunk_messages` is serialized at assembly time, before the
model runs (`historian_chunk.rs:717-727`), carried through the publish request
(`historian.rs:525`), and inserted in the same transaction as the summary
(`mc-store:9472-9481`). It is documented as "Original CK messages for exact
durable full-message and verbose recovery" (`historian.rs:425-426`). The
substitution is additive rather than destructive: the transaction writes no
render state, which the store's own doc states at `mc-store:9345-9350` and
`historian.rs:441-443`. Session-level eviction is built never to reclaim the raw
copy: the budget query sums `transcript_deflate` only (`mc-store:12724-12730`),
a victim row holding raw messages has its transcript blanked and its raw payload
retained (`:12748-12756`), and only a row with no raw payload is deleted
(`:12757-12761`), under the comment "Full message recovery is durable by
contract" (`:12749-12750`). The exception the pipeline lens identified is the
reversal path: the suffix revert at `mc-store:9105-9111` deletes compartments
**and their transcripts** for the reverted suffix inside one transaction, so a
revert discards the durable raw copy for that range and leaves the harness's own
session file as the only remaining source. Reversal is therefore a suffix
revert, not an undo.

**The validation gate is the sole content gate, and three of its omissions are
consequential.** `validate_historian_output` (`historian_validate.rs:450-641`)
has exactly one production caller, `publish_output_from_awaiting`
(`historian.rs:1673-1678`), confirmed by search: every other call is inside
`#[cfg(test)]`. It is fail-closed on the compartment path, with 22 rejecting
checks and no best-effort, partial-accept, or force branch. Its omissions were
established by reading the whole production body `:1-1304`, not by absence from
one function. Three matter most. First, **nothing binds the model's output to
the conversation it summarizes**: the output is tied to the chunk only by small
integer ordinals that must exist as chunk lines (`:941-957`), with no nonce, no
required echo, and no chunk digest, so any output covering the same span is
admitted. The chunk fingerprint (`historian.rs:151-160`) binds the chunk to the
firing, not the model's text to the chunk. Second, **nothing bounds how little
the summary may say**: the only content requirements are a non-empty `title`
(`:298-303`, a silent drop) and a non-blank `p1` (`:1000-1008`, a reject), so a
one-character `p1` covering 500 ordinals is admitted, and there is no
span-relative floor of any kind. Third, **nothing structural enforces that the
gate ran at all**: `ValidatedChunk` has eight `pub` fields and derives `Default`
(`historian_validate.rs:226-238`), `publish_validated_chunk` is a `pub fn` in a
`pub mod` (`historian.rs:444`, `lib.rs:19`), so a struct literal,
`Default::default()`, or `serde_json::from_str` all construct one, and the store
side does not compensate: the commit point admits `HistorianPhase::AwaitingProducer`
as well as `Publishing` (`mc-store:9389-9396`), so the transaction does not
require that a validation ever happened.

### Coverage: the sharpest finding in the project

State this precisely, because the natural reading is wrong in two different
directions.

There are **141 in-crate tests** across the five scope files: 51 in
`historian.rs`, 19 in `historian_validate.rs`, 19 in `historian_chunk.rs`, 18 in
`historian_producer.rs`, and 34 historian-related tests inside `lib.rs`'s test
module. There are **7 store-side publish tests** in `crates/mc-store/src/lib.rs`
(`:16625`, `:16688`, `:16781`, `:16984`, `:17017`, `:18221`, `:18336`), plus two
side-channel outbox tests and two fixture helpers. The gate's own **19 tests**
are a subset of the 141. **None of them executes in CI.**

The 141 total is a correction. Every earlier statement of it in this part said
121, which is an arithmetic error rather than a miscount: the five per-file
figures were each verified correct at HEAD and 51 + 19 + 19 + 18 + 34 is 141.
The error understated the size of the unprotected suite by twenty tests and is
fixed throughout `catalog.md`, `existing-checks.md`, and `fault-map.md`.

The only `mc-module` test invocation in any of the five workflow files is
`cargo test -p mc-module --test lifecycle_cli` (`ci.yml:168` at HEAD, `:172` in
the working tree). `--test lifecycle_cli` selects one integration binary and
does **not** build the `--lib` target, so no in-crate `mc-module` unit test is
even compiled in CI, let alone run. `mc-store` is not named in any of the five
workflows at all. No integration test in `crates/mc-module/tests/` mentions the
historian: a case-insensitive search for `historian` across all seven binaries
and both support files returns zero matches. Across the whole crate, 926 of 938
tests never execute.

The trap is the workflow name. Two "historian-eval" workflows exist and one of
them does execute per pull request, which invites the conclusion that the
historian is covered. It is not, because **those gates test a different
implementation**. The executing job is `historian-eval-contracts`
(`ci.yml:407-432` at HEAD), which runs `bun run test:historian-eval-unit` plus
two `run-historian-eval.ts` modes, `--lint` and `--mutations`. Its scorer
imports `validateHistorianOutput`, `validateStoredCompartments`,
`shouldDiscardLastHistorianCompartment`, and `HISTORIAN_BOUNDARY_HEALING_SLACK`
from `packages/plugin/src/hooks/magic-context/compartment-runner-validation.ts`
(`scorer.ts:20-26`), and `appendCompartments` plus `promoteSessionFactsDurable`
from the plugin's own storage and promotion modules (`:27-28`). The seam the
mutation battery drives is TypeScript-parse, TypeScript-validate, publish into a
Bun SQLite temporary database (`scorer.ts:715`, `:762-764`). There is no Cargo
target, no `mc-module`, and no `historian_validate.rs` anywhere in it. The
second workflow, `historian-eval.yml`, is `workflow_dispatch`/`schedule` only
and also runs no Rust target.

That lane's own code excludes the Rust leg explicitly.
`run-test-selection.ts:73-76` says the harness-booting historian-eval tests are
"TS-mode only: `mc-module`'s Rust historian producer does not promote claims, so
these must never join a rust or pi selection." So the exclusion is deliberate
and documented, not an oversight.

The consequence is the finding. Five in-crate test names assert TypeScript
parity by construction, including `validate_golden_matches_typescript_oracle`
(`historian_validate.rs:1384`), `five_message_narrative_gap_rejects_like_typescript_validator`
(`:1426`), and `twenty_message_tool_only_gap_heals_like_typescript_validator`
(`:1443`), and every one of them is ungated. The Rust validator and the
TypeScript validator are documented as a matched pair, the frozen corpus is
described in `historian-eval/README.md` as "the best TS<->Rust validator
differential vector set the repo has (reuse deferred, see plan scope)", and
**nothing executing anywhere compares the two implementations**. Every
`Existing check:` line in this catalog is therefore a local-only check, and
"partial" in an `Exercised:` line means "a test exists on a developer's
machine".

Two further coverage facts belong here because several records depend on them.
Ten of the gate's 22 rejecting checks have no test at any level, and three more
have untested arms; the untested ten are checks 2, 5, 8, 11, 12, 13, 14, 15, 19
in part, and 20, of which checks 11 through 15 are the ordinal-sanity family,
precisely the checks that stop a model from claiming coverage of a range it did
not summarize. And the four scope files outside `lib.rs` contain **zero**
`assert!` or `debug_assert!` in production code, verified per file by cutting
each at its last `#[cfg(test)]`; the publish transaction in `mc-store` has no
assertions of any kind either (`mc-store:9340-9560`). Every invariant in the
subsystem is enforced by a `Result`-returning guard, so a violated invariant
becomes a typed error a caller may or may not surface.

### Resolved: the historian is reachable by default

The two record-proposing lenses disagreed about the reachability class of every
record in this part, and this catalog previously carried the disagreement
unresolved, with 12 records labelled `explicit-config-only` and 12
`default-production`. **The independent portfolio evaluation resolved it in
favour of `default-production`, and all 24 records now carry that label.** The
resolution, its author, and its evidence are recorded here because the earlier
version of this section declared the question a product decision, and it was not:
it was answerable from the shipped setup code.

**The pipeline lens's evidence is correct and insufficient.** Nothing fires
unless the resolved config carries a model chain: `model_chain` defaults to
`Vec::new()` (`config.rs:121`, verified at HEAD inside the
`Default for McModuleConfig` impl at `:118-123`), is populated only from the user
config keys `/historian/module_model`, `/historian/model`, and their fallback
arrays (`config.rs:390-428`), and an empty chain short-circuits every entry point
(`lib.rs:5020-5030`, `lib.rs:5230-5232`, `historian.rs:1249-1251`). So a bare
`McModuleConfig::default()` has no models and the historian is off.

**What settles it is that a completed setup cannot omit a historian model.** Two
facts, both verified at HEAD for this disposition:

- The model picker cannot return an empty string. `pickModel`
  (`packages/cli/src/lib/model-picker.ts:71-91`) either offers a non-empty
  option list through `selectAutocomplete` (`:89-91`) or, when discovery returned
  nothing, falls back to free-text entry whose `validate` rejects a blank value
  with "A model id is required" (`:82-87`). There is no path through it that
  yields an unset model.
- Both shipped setup paths always call it for the historian role and always carry
  the result into the written config. In `setup-opencode.ts`, `pickModel` runs
  unconditionally at `:445` and the result is passed at `:545-553`. In
  `setup-pi.ts`, `pickModel` runs unconditionally at `:403` and the result is
  passed at `:471-481`. `writeMagicContextConfig` then writes it to the
  `/historian/model` pointer that `config.rs:411` reads: `setup-pi.ts:216-246`
  declares `historianModel: string` as a required field (`:219`) and writes
  `config.historian.model` at `:242-246`.

One premise correction against the evaluator, which does not change the outcome.
The two setup legs reach the same guarantee by different routes.
`setup-pi.ts:219` types `historianModel` as a required `string`, so the write at
`:242-246` is unconditional. `setup-opencode.ts:237` types it as
`string | null` and guards the write with `if (options.historianModel)` at
`:256-260`, so that leg's guarantee rests on its call site rather than on its
signature: the only caller passes the `pickModel` result, which cannot be empty
or null. The guard is therefore never false on the setup path, but it is a
weaker construction than Pi's and a future caller could pass `null` past it.

**Why absence of a completed setup does not count as opt-in.** An
`explicit-config-only` label means a user must take a deliberate step to enable
the behaviour. Here the deliberate step enables it, and there is no step that
disables it: the historian model is not a prompt the user can decline, it is a
required answer in the middle of setup. A store whose config was written by some
other route is an incomplete installation, not a supported configuration in which
the historian is off by choice.

**The consequence is that every finding in this part is live rather than latent.**
Say it plainly, because the previous label split invited the opposite reading.
These are not defects that wait for a user to switch something on. On any machine
where `magic-context` setup completed, the gate omissions in Groups E through H,
the billable-run asymmetry in Group C, and the commit-point widening in Group A
are all reachable on ordinary production traffic. The reachability label was the
only thing in this catalog suggesting otherwise, and it was wrong.

Nothing in the records depended on the answer for constructability: every
record's fault and enabling state already named a configured model chain as a
precondition, so the relabel changes prioritisation, not what a test must build.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [publish-transaction-rolls-back-every-write-on-a-late-sql-error](#publish-transaction-rolls-back-every-write-on-a-late-sql-error) | safety | high |
| [publish-transaction-survives-process-death-as-all-or-nothing](#publish-transaction-survives-process-death-as-all-or-nothing) | safety | high |
| [crash-before-publish-commit-refires-without-partial-state](#crash-before-publish-commit-refires-without-partial-state) | safety | high |
| [publish-fence-rejects-selected-content-drift](#publish-fence-rejects-selected-content-drift) | safety | high |
| [publish-admits-awaiting-producer-phase-at-commit](#publish-admits-awaiting-producer-phase-at-commit) | safety | medium |
| [publish-preserves-raw-chunk-messages-atomically](#publish-preserves-raw-chunk-messages-atomically) | safety | high |
| [raw-chunk-message-retention-has-no-eviction-budget](#raw-chunk-message-retention-has-no-eviction-budget) | safety | high |
| [historian-single-flight-admits-one-publish-per-firing](#historian-single-flight-admits-one-publish-per-firing) | safety | high |
| [uncertain-producer-start-authorizes-a-second-billable-run](#uncertain-producer-start-authorizes-a-second-billable-run) | safety | high |
| [hv-validation-rejection-retry-has-no-attempt-bound](#hv-validation-rejection-retry-has-no-attempt-bound) | liveness | high |
| [publication-floor-never-outruns-appended-coverage](#publication-floor-never-outruns-appended-coverage) | safety | high |
| [publication-floor-advances-only-on-publish](#publication-floor-advances-only-on-publish) | safety | high |
| [wrapup-rounds-require-observed-boundary-advance](#wrapup-rounds-require-observed-boundary-advance) | liveness | medium |
| [hv-output-not-bound-to-chunk-identity](#hv-output-not-bound-to-chunk-identity) | safety | high |
| [reattach-publishes-a-chunk-recomputed-after-the-model-ran](#reattach-publishes-a-chunk-recomputed-after-the-model-ran) | safety | high |
| [hv-heal-extends-range-without-revalidating-content](#hv-heal-extends-range-without-revalidating-content) | safety | high |
| [hv-degenerate-body-passes-content-gate](#hv-degenerate-body-passes-content-gate) | reachability | high |
| [hv-no-cross-compartment-content-distinctness](#hv-no-cross-compartment-content-distinctness) | safety | high |
| [hv-single-compartment-skips-lookahead-discard](#hv-single-compartment-skips-lookahead-discard) | safety | high |
| [hv-control-characters-reach-durable-rows](#hv-control-characters-reach-durable-rows) | safety | high |
| [hv-unescape-xml-double-decodes-entities](#hv-unescape-xml-double-decodes-entities) | safety | high |
| [hv-importance-unbounded-then-truncating-cast](#hv-importance-unbounded-then-truncating-cast) | safety | high |
| [hv-publish-accepts-unvalidated-validated-chunk](#hv-publish-accepts-unvalidated-validated-chunk) | safety | high |
| [hv-tierless-stored-row-arm-must-stay-unreachable](#hv-tierless-stored-row-arm-must-stay-unreachable) | safety | high |
| [hv-side-channel-anchor-out-of-range-drops-silently](#hv-side-channel-anchor-out-of-range-drops-silently) | safety | high |

---

## Group A: the publish commit point and its fence

Four records on the one transaction that makes a substitution durable. The first
is the atomicity claim over its six writes, the second is what a crash before it
leaves behind, and the last two are the two gates that decide whether the
transaction may commit at all: a content-freshness fence that catches an edit
made while the model ran, and a phase gate that is wider than the documented
state machine. The first two share a cause worth naming up front, that
`Publishing` is persisted in a separate earlier transaction
(`historian.rs:1707`) from the publish itself (`mc-store:9360`), which is exactly
what makes a surviving `Publishing` row a proof of non-commit.

### publish-transaction-is-the-single-commit-point

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `mc-store/src/lib.rs:16984`
`publish_historian_chunk_persists_transcript_inside_cas` and `:17017`
`publish_historian_chunk_cas_conflict_leaves_no_transcript_row` cover the
transcript half of the atom; no test asserts all six writes land or none do, and
no CI job runs either (`ci.yml:167-168` is the only `mc-module` test invocation
and it runs one integration binary).
Guarantee: The compartment rows, the deflated original messages, the queued side
channels, the raised publication floor, and the historian phase reset either all
become durable together or none of them do.
Check: `always` — after any outcome of `publish_historian_chunk`, the observed
store satisfies: `count(compartments appended by this predicate) > 0` if and only
if `publication_floor_ordinal >= validated.unprocessed_from` and
`meta.historian.state == Idle` at the published `firing_seq` and a
`mc_chunk_transcripts` row exists for each appended sequence. Semantics are
`always` because it constrains every reachable post-publish state, not one code
point.
Fault/timing angle: Process kill or SQLite failure between any two of the six
writes at `mc-store:9457-9500`. The window is the interior of one `Immediate`
transaction, so the property is the claim that the wrapper's commit boundary
really is the only visible boundary.
Required faults and enabling state: A configured model chain, a fired run
reaching `Publishing`, and either an injected SQLite error inside the transaction
or a SIGKILL during it. The `#[cfg(test)] after_store_publish` hook
(`lib.rs:3311-3319`) fires only after the store call returns, so it cannot land
inside the window; a fault seam inside the transaction does not exist today.
Confidence: high —
[evidence](evidence/publish-transaction-is-the-single-commit-point.md). Read the
whole closure at `mc-store:9360-9505` and the wrapper at
`../commons/crates/cortexkit-store/src/lib.rs:185-232`; confirmed the single
`tx.commit()` at `:230` and that every early return inside the closure is a
value, not a commit.
Existing check: `mc-store/src/lib.rs:16984`, `:17017`, `:18221`
(`publish_historian_chunk_fails_loud_from_non_publish_state`). Status
`unaudited`.
Impact: A partial commit that appended compartments without raising the floor, or
raised the floor without appending, would leave a range that is neither
summarized nor eligible for boundary placement.
Open questions:

- Is there any intended fault-injection seam inside the publish transaction, or
  is the wrapper's atomicity taken on faith? (needs human input)

### crash-before-publish-commit-refires-without-partial-state

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:4596`
`restart_mid_awaiting_exposes_reattach_ids` and `:4647`
`restart_mid_publishing_with_committed_tx_detects_idle` cover the two load
outcomes with a simulated restart; neither uses a real process kill. Not run in
CI.
Guarantee: A crash at any point before the publish transaction commits leaves no
compartment rows, no transcript rows, and no raised floor, and the next load
makes the session refire-eligible rather than stuck.
Check: `always-or-unreached` — if a restart observes
`state in {Firing, Validating, Publishing}`, then no compartment appended by that
`firing_seq` exists and the load transitions the row to `Idle` with a backoff; if
it observes `Idle`, the publish either committed or never fired.
`always-or-unreached` because a crash in this window is an optional event that a
campaign may not produce, and the property must hold whenever it does.
Fault/timing angle: Four distinct windows: between the fire persist and the
producer start, between the start and the output, between the `Validating`
persist and the `Publishing` persist, and between the `Publishing` persist and
the transaction commit. The last is the dangerous one and is the one
`handle_restart_load` reasons about at `historian.rs:616-619`.
Required faults and enabling state: A configured model chain, a fired run, and a
process kill in each of the four windows, then a restart that runs
`maybe_spawn_reattach` (`lib.rs:4614-4806`).
Confidence: high —
[evidence](evidence/crash-before-publish-commit-refires-without-partial-state.md).
Verified that `Publishing` is a separate transaction from the publish
(`historian.rs:1707` versus `mc-store:9360`), that the publish CAS uses the
version that transition wrote (`historian.rs:1719`), and that
`handle_restart_load` abandons all three pre-commit phases (`:648-653`).
Existing check: `historian.rs:4596`, `:4647`, `:3776`. Status `unaudited`.
Impact: A stuck `Publishing` row would block every future fire for the session,
because `fire` refuses any non-idle phase. The abandon-on-load is the only thing
that unwedges it.
Open questions:

- `handle_restart_load` for `AwaitingProducer` with missing producer ids abandons
  (`historian.rs:630-639`), but `MissingProducerIds` is also a
  `publish_predicate` error (`:377-381`). Whether the two paths agree on what a
  partially written `AwaitingProducer` row means is unresolved, needs a targeted
  test.

### publish-fence-rejects-selected-content-drift

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:2323`
`selected_range_identity_drift_during_await_rejects_without_cooldown` and `:2942`
`reattach_equal_length_identity_drift_rejects_before_publish` cover the reject;
`:2369` `tail_identity_extension_during_await_still_publishes` covers the
permitted extension. Not run in CI.
Guarantee: No publish commits if any message in the pinned chunk range has
changed content since the fire, and a firing with no recorded content identities
cannot publish at all.
Check: `always` — at the instant of commit, for every entry in
`predicate.selected_range_identities`,
`meta.block_identity_by_mid[mid] == entry.block_identities`, and
`selected_range_identities` is non-empty. `always` because it is a precondition
on every commit.
Fault/timing angle: The whole model-run window, which is minutes. A harness can
edit, retract, or re-stamp a message while the producer runs. The fingerprint
alone would not catch a same-length content edit; the module header says so
explicitly (`historian.rs:141-143`).
Required faults and enabling state: A configured model chain, a fired run, and a
store mutation to `block_identity_by_mid` for one selected mid during the await.
The existing tests use a commit hook to do exactly this, which is the seam to
reuse.
Confidence: high —
[evidence](evidence/publish-fence-rejects-selected-content-drift.md). Read the
fence at `mc-store:9413-9425` and confirmed the empty-vector rejection is
separate from and prior to the per-mid comparison, with the reasoning at
`:9409-9412`.
Existing check: `historian.rs:2323`, `:2369`, `:2942`, `:3776`
`reattach_fingerprint_mismatch_recovers_to_idle_and_releases_routes`. Status
`unaudited`.
Impact: Without it, a summary of text the user has since changed or retracted
would replace the changed text.
Open questions:

- The fence covers only mids inside the pinned chunk range. A message just past
  the range can change freely, and
  `tail_identity_extension_during_await_still_publishes` shows an extension is
  deliberately permitted. Whether that is safe depends on the validated end
  boundary, which is the sibling validation lens's question. Unresolved, needs
  cross-lens reconciliation.

### publish-admits-awaiting-producer-phase-at-commit

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `mc-store/src/lib.rs:18221`
`publish_historian_chunk_fails_loud_from_non_publish_state` proves some phases
are refused, but no test pins which phases are admitted, and no test asserts a
committed publish was preceded by a `Validating` transition.
Guarantee: Every committed publish was preceded by a durable `Validating` then
`Publishing` transition for the same `firing_seq`.
Check: `always` — at the instant of commit,
`meta.historian.state == Publishing`. `always` rather than `unreachable`, because
the thing to forbid is a state at the commit point, not the execution of a code
location: the guard at `mc-store:9389-9396` is one expression covering both
admitted phases and cannot be marked as a forbidden location.
Fault/timing angle: None needed. The gap is static: the store admits
`AwaitingProducer` as well as `Publishing`, so the `Validating` phase is not
enforced where it matters.
Required faults and enabling state: A configured model chain plus a caller that
reaches `publish_historian_chunk` from `AwaitingProducer`.
`publish_output_from_awaiting` always transitions first
(`historian.rs:1706-1707`), so today the coverage check is on the preconditions:
the store's phase guard admits two phases, and the module has more than one
publish route (`historian.rs:527-530`, plus two fence implementations at
`lib.rs:3296` and `:3332`).
Confidence: medium —
[evidence](evidence/publish-admits-awaiting-producer-phase-at-commit.md). The
widening is verified by reading `mc-store:9389-9396`. What is not established is
whether any current caller exercises it; I found no in-repo caller that does, and
I could not rule out an external consumer of the public `mc-store` API.
Existing check: `mc-store/src/lib.rs:18221`. Status `unaudited`.
Impact: The documented five-phase machine (`historian.rs:1-6`) and the
"fail-closed before any database write" claim (`historian_validate.rs:1-9`) both
rest on validation preceding publish. The commit point does not check that. A
future or external caller that skips `validation_ok` publishes unvalidated model
text through the same gates.
Open questions:

- Is admitting `AwaitingProducer` deliberate, for example to support a recovery
  path that has not been written yet, or is it a leftover? Nothing in the code or
  comments explains it. (needs human input)

## Group B: original-content preservation and retention

The recoverability of a substitution rests on one field, `raw_chunk_messages`,
and these two records are its two halves. The first is that the copy is written
atomically with the summary it replaces. The second is that nothing ever
reclaims it, which is what makes the first meaningful over a long session and is
also an unbounded growth term nothing measures.

### publish-preserves-raw-chunk-messages-atomically

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `mc-store/src/lib.rs:16984` asserts a transcript row exists
after a publish and `:17017` asserts none exists after a CAS conflict; neither
asserts that `raw_messages_deflate` round-trips to the exact pre-publish
messages. Not run in CI.
Guarantee: Every compartment appended by a publish has, in the same transaction,
a durable deflated copy of the original CK messages for the range it replaces.
Check: `always` — for every appended compartment sequence `s`, a
`mc_chunk_transcripts` row exists with `compartment_seq = s` and non-null
`raw_messages_deflate` that inflates to the exact JSON serialized at
`historian_chunk.rs:717-727`. `always` because this is the invariant that makes
the substitution recoverable, and it must hold in every post-publish state.
Fault/timing angle: None for the atomicity itself; the window of interest is
between assembly and publish, during which the projection can change while the
fingerprint stays equal.
Required faults and enabling state: A configured model chain and one accepted
publish. To attack it: a chunk whose compressed raw payload is large, and a chunk
whose condensed transcript exceeds 256 KiB so the transcript is dropped
(`mc-store:12682-12686`) while raw must survive.
Confidence: high —
[evidence](evidence/publish-preserves-raw-chunk-messages-atomically.md). Traced
`raw_chunk_messages` from `historian_chunk.rs:717-727` through
`historian.rs:525` and `mc-store:9472-9481` into `:12687-12713`; confirmed no
size filter on the raw payload and that a compression error aborts the publish.
Existing check: `mc-store/src/lib.rs:16984`, `:17039`-region transcript-cap
tests. Status `unaudited`.
Impact: If the raw copy were absent, the folded conversation would exist only as
model-generated summary text inside this store, and the store's own full-message
and verbose expand paths would have nothing to serve.
Open questions:

- `insert_chunk_transcripts_tx` returns early when both payloads are absent
  (`mc-store:12691-12693`) and when the compartment list is empty
  (`:12679-12681`). The historian path cannot reach either, but nothing in the
  store's own signature prevents another caller from publishing compartments with
  no recoverable original. Unresolved, needs a decision on whether the store
  should enforce it.

### raw-chunk-message-retention-has-no-eviction-budget

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test measures the growth of `raw_messages_deflate` across
many publishes, and the eviction tests exercise only the transcript budget.
Guarantee: Session transcript eviction never reclaims a raw-message payload, and
therefore `SUM(LENGTH(raw_messages_deflate))` per session is bounded only by the
number of publishes.
Check: `always` — after any number of publishes and evictions, every compartment
sequence that ever had a non-null `raw_messages_deflate` still has one. Paired
with a `sometimes` on the operational state that makes the growth visible: at
least one campaign session reaches
`SUM(LENGTH(transcript_deflate)) > MAX_SESSION_TRANSCRIPT_COMPRESSED_BYTES` so
the eviction loop actually runs and is observed to blank rather than delete.
These are separate assertions on independent preconditions, not an
`always(!X)`/`sometimes(X)` pair.
Fault/timing angle: None. This is a monotone accumulation over a long session.
Required faults and enabling state: A configured model chain and enough publishes
on one session to push the transcript sum past 8 MiB (`mc-store:410`).
Confidence: high —
[evidence](evidence/raw-chunk-message-retention-has-no-eviction-budget.md). Read
`evict_chunk_transcripts_tx` at `mc-store:12718-12763`; the budget query at
`:12724-12729` sums `transcript_deflate` only, and the victim branch at
`:12748-12756` retains raw. Also confirmed the loop terminates: each iteration
either blanks a row (removing it from the victim predicate at `:12738`) or
deletes it.
Existing check: none found for raw-payload growth.
Impact: This is the price of recoverability and is probably the right trade, but
it is an unbounded per-session growth term that nothing measures or alarms on. It
belongs in the catalog as a resource property so the trade is explicit rather
than accidental.
Open questions:

- Is unbounded raw retention the intended contract, or is a separate raw budget
  missing? The comment at `mc-store:12749-12750` reads as deliberate. Needs a
  product decision on long-session storage. (needs human input)

## Group C: single-flight, refire, and billable-run accounting

Three records on how many times a firing may happen and how many provider runs it
may bill. The first is the positive guarantee, one publish per `firing_seq`,
enforced at three independent layers. The other two are its asymmetries: a
start-failure branch that authorizes a second billable run without the proof the
output branch demands, and a rejection path that refires every 60 seconds forever
without escalating a backoff or moving a health counter.

### historian-single-flight-admits-one-publish-per-firing

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:4243`
`pure_state_machine_happy_path_and_single_flight` covers the pure `fire`/`Busy`
transition and `:3011`
`concurrent_lineages_reattach_and_publish_in_isolated_sessions` covers two
lineages; no test drives two concurrent publishes against one session id. Not run
in CI.
Guarantee: For one session, at most one publish transaction commits per
`firing_seq`, and a second concurrent publisher is rejected before any row is
appended.
Check: `always` — for every session, the multiset of committed publishes has
distinct `firing_seq` values, and every rejected publish leaves
`count(mc_compartments)` unchanged. `always` because it constrains every reachable
state of the store, and the forbidden state (two commits at one `firing_seq`) has
no dedicated detection point, so `unreachable` would be wrong.
Fault/timing angle: Two publishers interleaving between the `Publishing` persist
(`historian.rs:1707`) and the transaction at `mc-store:9360`. The first to commit
bumps `row_version` and resets the phase to idle, so the second fails gate 1
(`:9373-9382`) and gate 2 (`:9389-9396`).
Required faults and enabling state: A configured model chain, plus either two
in-process firings racing (which the live-session guard at `lib.rs:4556-4581` is
meant to prevent) or one firing racing its own reattach (which the reattach latch
at `lib.rs:4640-4650` and the live-session check at `:4632-4639` are meant to
prevent). The interesting construction bypasses the in-process guards and drives
`publish_validated_chunk` twice, which the pure-function seam permits.
Confidence: high —
[evidence](evidence/historian-single-flight-admits-one-publish-per-firing.md).
Verified three independent layers: `fire` refuses non-idle
(`historian.rs:251-253`), the store predicate binds five fields
(`mc-store:9398-9407`), and the row-version CAS uses the version written by the
`Publishing` transition rather than a fresh read (`historian.rs:1707-1719` with
the reasoning at `:1709-1713`).
Existing check: `historian.rs:4243`, `:4314`
`fingerprint_mismatch_at_publish_abandons_and_releases_single_flight`, `:4451`
`compartment_generation_fence_releases_overlapped_publish_to_idle`. Status
`unaudited`.
Impact: Two commits at one `firing_seq` would append the same summarized range
twice. The overlap backstop at `mc-store:12637-12646` would catch identical
ranges, but a fallback attempt that produced different boundaries could append an
overlapping-but-not-identical second fold.
Open questions: None.

### uncertain-producer-start-authorizes-a-second-billable-run

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — `historian.rs:3389`
`unconfirmed_cancellation_stops_the_fallback_chain` and `:3444`
`uncertain_cancel_send_outcomes_stop_the_fallback_chain` cover the symmetric
protection on the output path. No test covers a start failure carrying
`OutcomeUnknown`.
Guarantee: Producer runs started for one firing are bounded: observed runs are at
least the number of starts that returned a run id, and at most the number of
`start` calls made.
Check: `always` with per-drive accounting — per call to `run_historian_firing`,
`acknowledged = count(starts returning a RunHandle)` and
`attempted = count(start calls)` summed across **every** iteration of the model
loop; assert `acknowledged <= observed provider runs <= attempted`, and separately
assert `attempted - acknowledged <= 1` so an ambiguous start cannot be followed by
another attempt. `always` because the accounting must hold on every drive.

The accounting unit is a correction, and it is the difference between an oracle
that can detect this and one that cannot. This record previously specified
per-`firing_seq` accounting, which **partitions the two runs apart and therefore
cannot observe the duplicate it describes.** On a start failure classified
`try_next_model`, the loop `continue`s at `historian.rs:1318-1321` back to the top
at `:1256` and calls `fire` again (`:1265-1274`), and `fire` increments the
sequence unconditionally (`:257`, `current.firing_seq.saturating_add(1)`). So the
orphaned run and its replacement carry different `firing_seq` values, and a
per-firing oracle sees one start each and passes. The catalog's own Impact line
below already said the second attempt fires under a new `firing_seq`, so the
record contradicted itself. The unit must be the drive, or equivalently the
attempt lineage rooted at one `run_historian_firing` call, and the counter must
live at the fake, which spans the whole loop. The old clause
`acknowledged <= 1` was correct but described a per-firing bound and is replaced
by the lineage-scoped form above.
Fault/timing angle: A `start` call whose send outcome is `OutcomeUnknown`
(`historian_producer.rs:80`), meaning the request may have reached Broca and begun
a run whose id the module never learns.
Required faults and enabling state: A configured model chain with at least two
models, and a producer double that fails the first `start` with a
transient-classified error carrying `OutcomeUnknown`, then succeeds on the second.
The oracle counts runs at the fake, not in the module.
Confidence: high —
[evidence](evidence/uncertain-producer-start-authorizes-a-second-billable-run.md).
Read `historian.rs:1290-1329` and confirmed there is no `cancel`, no outcome
inspection, and no `cancellation_confirmed_stopped` call on that branch, while
`:1401` requires exactly that proof on the output branch. Confirmed
`decide_producer_failure` (`:1052-1143`) never reads the send outcome, and neither
does `heuristic_decision` (`historian_producer.rs:412-433`).
Existing check: `historian.rs:3389`, `:3444`, `:3498`
`a_terminal_cancel_error_never_authorizes_fallback`. All cover the output branch
only. Status `unaudited`.
Impact: Duplicate spend and a duplicate provider run, not a duplicate publish. The
orphaned run's output is never drained because its id is unknown, and the second
attempt fires under a new `firing_seq` (`historian.rs:257`) with its own producer
session id (`:1013-1035`), so only one publish can commit. The cost is money and
provider load, plus a live run the module cannot cancel.
Open questions:

- The asymmetry may be deliberate, on the grounds that a start with no run id
  cannot be cancelled anyway. If so, the mitigation is to refuse fallback on
  `OutcomeUnknown` rather than to cancel. Needs a design decision. (needs human
  input)

### hv-validation-rejection-retry-has-no-attempt-bound

Type: liveness
Reachability: default-production
Status: active
Exercised: not yet — no test drives repeated validation rejections across
firings.
Guarantee: After the fault-free window opens, a session whose producer keeps
returning invalid output stops re-firing within a bounded number of attempts, or
reports degraded publish health.
Check: `always` — poll for a bounded window of `N` firing opportunities after the
last configuration change; after `N` consecutive validation rejections, either
`historian.failure_backoff_at_ms` has escalated beyond
`HISTORIAN_FAILURE_BACKOFF_MS` or `publish_health_degraded` is true. Stated in
attempts, not in an unbounded "eventually", per the liveness rules.
Fault/timing angle: The window is the 60-second backoff at `historian.rs:29`,
re-evaluated at `lib.rs:5042-5047`. Each expiry admits one more firing, each
costing a full model chain of live calls.
Required faults and enabling state: A configured model chain; a producer that
returns a well-formed document the gate rejects on every attempt, for every model
in the chain; and N firing opportunities without N times 60 seconds of wall clock.
The seam for that exists and is already used: the backoff gate compares the durable
`failure_backoff_at_ms` against a caller-supplied `now`
(`lib.rs:5042-5047`, with `now` arriving through `HistorianPrepareContext` at
`:4808-4821`), so expiring the durable field is equivalent to advancing the clock.
The test helper `expire_historian_backoff` (`lib.rs:29784-29791`) already does
exactly this by committing `Some(now_ms() - 1)`, and
`assert_seeded_phase_recovers_then_refires_after_backoff` (`:29793`) drives a
refire through it. So each additional attempt costs no wall clock.
Confidence: high —
[evidence](evidence/hv-validation-rejection-retry-has-no-attempt-bound.md).
Traced the whole rejection path: `historian.rs:1680-1703` abandons with a backoff;
`abandon_with_detail` (`:352-361`) copies `consecutive_publish_failures`
unchanged; the only increments are in `mc-store/src/lib.rs:9264-9268` and
`:9323-9326`, which this path does not reach; `completion_failure_backoff_at_ms`
(`historian.rs:1145-1154`) preserves rather than escalates the cooldown; the
intra-firing fallback at `historian.rs:1440-1450` bounds attempts per firing only.
Existing check: `lib.rs:5042-5047` enforces the 60-second cooldown, and
`lib.rs:6258-6261` reports degradation from a counter this path never increments.
Impact: Unbounded live model spend and log noise, and a session that never
compacts while its status block reports healthy publishing. Distinct from a bad
publish: no data is corrupted.
Open questions:

- Should a validation rejection increment `consecutive_publish_failures`, or does
  that counter deliberately mean "store-side publish failure only"? The name
  suggests the latter but the health signal is the only one users see. (needs
  human input)

## Group D: publication floor and coverage advance

`meta.publication_floor_ordinal` is the system's record of how far folding has
progressed, and the emergency arm treats it as a publish detector on the stated
invariant that "a PUBLISH is the only event that advances the publication floor"
(`lib.rs:8481-8501`). These three records are that invariant from three sides:
the floor never outruns the coverage that justifies it, nothing but a publish
moves it, and the wrapup drain that repeatedly advances it must observe real
progress each round or stop.

### publication-floor-never-outruns-appended-coverage

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:2309` and `:4199` assert the floor equals a
specific value after a publish, and `:2360` and `:3006` assert it stays `None`
after a rejection. No test relates the floor to the appended compartment ends
generally. Not run in CI.
Guarantee: After any publish, the publication floor is at most one past the
highest appended compartment end, and it never decreases.
Check: `always` — after every committed publish,
`meta.publication_floor_ordinal <= MAX(end_message) + 1` over all compartments
for the session, and `floor_after >= floor_before`. `always` because it
constrains every post-publish state.
Fault/timing angle: None for monotonicity, which is structural via the `max` at
`mc-store:9484-9488`. The upper bound depends on validation producing
`unprocessed_from = last_new_end + 1` after discard-last healing
(`historian_validate.rs:638`), so the interesting case is a healed batch where
the last emitted compartment was popped (`:539-556`).
Required faults and enabling state: A configured model chain and an accepted
publish whose last compartment was discarded by boundary healing, which needs at
least two compartments and a lookahead distance within `BOUNDARY_HEALING_SLACK`
(`historian_validate.rs:19`, applied at `:554`).
Confidence: high —
[evidence](evidence/publication-floor-never-outruns-appended-coverage.md). Traced
the floor from `historian_validate.rs:638` through `historian.rs:1725` and `:523`
to `mc-store:9484-9488`, and confirmed the empty-compartment rejection at
`historian_validate.rs:487-491` and the forward-progress check at `:625-635`
together prevent a floor advance with no appended coverage.
Existing check: `historian.rs:2309`, `:2360`, `:3006`, `:4199`. Status
`unaudited`.
Impact: A floor past the covered range would make messages in the gap ineligible
as boundary candidates (`boundary.rs:1417-1426`) and ineligible for tool-arc
fencing (`:1339-1357`) while no compartment summarizes them. They would still be
served verbatim, so this is a boundary-quality defect rather than data loss.
Open questions: None.

### publication-floor-advances-only-on-publish

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — the emergency re-run at `lib.rs:8490-8501` depends on this
claim and `historian.rs:2360` and `:3006` show a rejected run leaves the floor
untouched. No test enumerates the write sites. Not run in CI.
Guarantee: `meta.publication_floor_ordinal` changes only as part of a committed
publish transaction; no abandon, sync, import, or recovery path moves it.
Check: `always` — between two observations of the store, if
`publication_floor_ordinal` changed then the number of committed publishes for
that session increased. `always` because the emergency arm's correctness rests on
it at every pass.
Fault/timing angle: The emergency arm reads the floor before and after each of
its four arms (`lib.rs:8346`, `:8395`, `:8421`, `:8447`, compared at `:8493`)
precisely to detect a publish that interleaved with the request. A false positive
costs one redundant transform re-run; a false negative serves pre-fold bytes at
emergency pressure.
Required faults and enabling state: A configured model chain, an emergency-band
pass, and a concurrent firing that abandons rather than publishes, which must not
trip the detector, plus one that publishes, which must.
Confidence: high —
[evidence](evidence/publication-floor-advances-only-on-publish.md). Grepped every
`publication_floor_ordinal` occurrence in `mc-store/src/lib.rs`; the only
production assignment is `:9484-9488`, and the abandon path rebuilds only
`HistorianDurableState` (`historian.rs:353-360`), which lives under
`meta.historian` and cannot touch the sibling field. The comment at
`lib.rs:8484-8486` states the intent and the reason row-version advancement is not
used instead.
Existing check: `historian.rs:2360`, `:3006`. Status `unaudited`.
Impact: If another write site appeared, the emergency arm would either loop on
spurious re-runs or silently return pre-fold bytes at 95 percent context fill,
which is where raw forwarding risks provider overflow.
Open questions: None.

### wrapup-rounds-require-observed-boundary-advance

Type: liveness
Reachability: explicit-config-only
Status: active
Exercised: not yet — the `lib.rs` test module contains wrapup tests, but I found
none that asserts the no-advance break at `:6982-6989` or that the loop
terminates within the budget. Not run in CI.
Guarantee: A wrapup drain either advances the maximum compartment end ordinal on
every counted round or stops with a retryable failure, and it terminates within
the request budget.
Check: `always` on the per-round progress condition plus a bounded liveness check
on termination: after `MAX_WRAPUP_REQUEST_BUDGET` (3800 s, `historian.rs:962`)
the handler has returned a response, and for every counted round
`after_end > before_end`. The bound is stated in the unit the code bounds, a
wall-clock budget re-checked before each round (`lib.rs:6831-6834`), because there
is deliberately no round-count cap.
Fault/timing angle: The loop has no round cap by design, so its only ceiling is
the deadline. A producer that publishes an empty-progress fold, or a repeated
fence rejection with no cooldown (`historian.rs:533-547`), are the two shapes
that could spin.
Required faults and enabling state: A configured model chain, a session with
several chunks left to drain, and a producer double that publishes a fold which
does not advance the boundary. Run under a compressed budget so the test finishes.
The seam for that exists and is already used: `wrapup_operation_budget`
(`lib.rs:5445-5457`) returns a `#[cfg(test)]` override before falling back to
`MAX_WRAPUP_REQUEST_BUDGET`, and `wrapup_budget_bounds_busy_join_without_double_drive`
(`lib.rs:29236`) sets it to 40 ms at `:29245-29248` and restores it at
`:29273-29276`. So the deadline is injected rather than waited out, and this record
does not need new infrastructure.
Confidence: medium —
[evidence](evidence/wrapup-rounds-require-observed-boundary-advance.md). The
progress check and the break are verified at `lib.rs:6977-6989`, and the deadline
re-check before each round is verified at `:6831-6834` and `:5481-5487`. What I
did not verify is that every `continue`-shaped path in the loop re-checks the
deadline; the loop body is inside a 539-line method and I traced the documented
arms rather than all of them.
Existing check: none found for the no-advance break.
Impact: A drain that neither advances nor stops holds a `session.wrapup` request
open for the whole budget and repeatedly spends model calls. The fence-rejection
path is the specific worry because it deliberately arms no cooldown.
Open questions:

- Can a fence rejection with no cooldown (`historian.rs:533-547`) recur every
  round until the budget expires, or does the snapshot generation stabilize?
  Unresolved, needs a test that holds the transform-snapshot generation moving
  while a wrapup drains.

## Group E: output-to-conversation binding

The three records where the summary and the range it claims to describe can come
apart. The first is the root finding, that nothing in the gate ties the model's
words to this chunk beyond integer ordinals. The other two are the two mechanisms
that move a range after the model has spoken: a reattach that rebuilds the chunk
and the raw payload from a later projection, and a heal that widens a
compartment's ordinal span without looking at its body again. All three leave
ordinal coverage internally consistent, which is why nothing downstream detects
them.

### hv-output-not-bound-to-chunk-identity

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test supplies a well-formed output whose ranges fit the
chunk but whose prose describes different material.
Guarantee: A published compartment set is bound to the specific chunk it
summarizes by something the model must have read, not only by integer ordinals
that any output covering the same span satisfies.
Check: `always` — build a chunk from conversation A, then call
`validate_historian_output` with an output fixture taken from an unrelated
conversation B whose compartment ranges have been renumbered to be contiguous over
`A.chunk.start_index..=A.chunk.end_index` with `<unprocessed_from>` equal to
`A.chunk.end_index + 1`, and whose bodies therefore describe material that appears
nowhere in A. Assert the call returns `Err`. It returns `Ok` today, so this check
fails on the current implementation, which is the finding. Semantics are `always`
because admission is evaluated on every publish and the binding must hold on each
one.

The oracle is a correction. This record previously required that "at least one
accepted field carries a value derivable only from the pinned chunk's content (a
nonce echo, a chunk digest, or a quoted anchor)". That is not executable: it names
no derivation, so no test can decide whether a given field satisfies it, and it
also presumes the remedy rather than stating the property. The
unrelated-conversation fixture is decidable, needs no production change to run,
and is a direct call rather than a producer run, because the gate is pure
(`historian_validate.rs:5-9`, `:450-455`).
Fault/timing angle: A producer session reused across two chunks, or a
provider-side cache hit, returns text for the previous chunk while the current
chunk's fingerprint still matches the firing.
Required faults and enabling state: A configured historian model chain; a producer
that returns a document whose compartment ranges are contiguous over
`chunk.start_index..=chunk.end_index` and whose `<unprocessed_from>` is
`chunk_end + 1`, with bodies describing unrelated content.
Confidence: high —
[evidence](evidence/hv-output-not-bound-to-chunk-identity.md). Read every check in
`:450-641` and `:983-1084`; the only chunk-derived facts consulted are
`start_index`, `end_index`, `lines[].ordinal`, `lines[].message_id`,
`lines[].anchorable`, `present_ordinals`, `tool_only_ranges`,
`completed_tool_arcs`. Grepped for a nonce or echo requirement and found none.
Existing check: none. The chunk fingerprint at `historian.rs:1449-1461` and
`:444-455` binds chunk to firing, not text to chunk.
Impact: The served conversation prefix is replaced by a summary of something else.
The raw record survives in `raw_chunk_messages`, so this is a wrong-context
failure rather than data destruction, but every later pass reads the wrong m0.
Open questions:

- Is a chunk-derived echo requirement compatible with the byte-identical
  TypeScript oracle the golden test pins (`historian_validate.rs:1384`)? (needs
  human input)

### reattach-publishes-a-chunk-recomputed-after-the-model-ran

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: partial — `historian.rs:2881`
`reattach_terminal_redrains_from_start_without_second_send`, `:3138`
`reattach_redrains_full_run_from_start`, and `:4533`
`reattach_carries_durable_revert_epoch_to_publish` cover the reattach publish.
None compares the published `raw_chunk_messages` against what the producer
actually summarized. Not run in CI.
Guarantee: On the reattach path, the transcript and original messages stored
beside a compartment describe the same message range the model summarized.
Check: `always-or-unreached` — for a reattach publish, the inflated
`raw_messages_deflate` contains exactly the non-synthetic messages in
`[chunk.start_index, chunk.end_index]` as they existed when the producer's prompt
was built. `always-or-unreached` rather than `always` because a reattach publish is
an optional path that a campaign may never enter, and a stored original that does
not correspond to the stored summary defeats the recoverability property whenever
it is entered.
Fault/timing angle: The reattach rebuilds the chunk, the transcript, the raw
messages, and the fingerprint from the **current** request's projection
(`lib.rs:4696-4725`), minutes after the producer received the old chunk text. So
the range is recomputed, not reused, and the raw payload it stores is serialized
from the later projection (`lib.rs:4710-4721`).

The tail-superset premise is withdrawn. This record previously argued that the
recomputed range "can be a superset" of the pinned range, citing the deliberately
permitted tail extension at `tail_identity_extension_during_await_still_publishes`
(`historian.rs:2369`). **It cannot.** The reattach passes
`range.to_ordinal.saturating_add(1)` to `build_historian_chunk` as its exclusive
`eligible_end_ordinal` (`lib.rs:4696-4702`), and the builder admits no message at
or beyond that bound: the start scan filters
`message.ordinal < eligible_end_ordinal` (`historian_chunk.rs:373-375`) and the
body loop `continue`s on `message.ordinal >= eligible_end_ordinal`
(`:383-386`). So `chunk.chunk.end_index` cannot exceed the pinned `to_ordinal`, and
the raw payload, which is filtered by `chunk.chunk.start_index` and
`chunk.chunk.end_index` (`lib.rs:4714-4718`), cannot extend past it either. What
survives is same-bound recomputation: the upper bound is pinned, but the messages
inside it are re-read from the later projection, and the range can end up
*narrower* than the original if the token budget truncates differently. The
identity fence (`mc-store:9418-9425`) pins content for mids inside the pinned
range, so an equal-length edit is rejected rather than stored; the residual claim
under test is that no combination of re-read content and a narrower recomputed
range stores an original that fails to correspond to the summary.
Required faults and enabling state: A configured model chain, a restart or process
handoff leaving an `AwaitingProducer` row, and a transform request whose
projection has changed inside the pinned range before the reattach publishes. A
projection that has grown *past* `chunk_range.to_ordinal` is no longer the
interesting case, because the exclusive bound discards the growth; the interesting
cases are a content change the fence must catch and a token-budget difference that
makes the recomputed range narrower than the original.
Confidence: high —
[evidence](evidence/reattach-publishes-a-chunk-recomputed-after-the-model-ran.md),
which still carries the superseded superset framing and was not rewritten in this
disposition. The rebuild is verified at `lib.rs:4692-4725`, and the pinned range at
`historian.rs:645` and `:1529-1530`. Confidence is raised from medium because the
question the old line said "needs a test, not more reading" was answerable by
reading: `build_historian_chunk` cannot return a `chunk.chunk.end_index` beyond the
exclusive bound it is given, per the two filters at `historian_chunk.rs:373-375`
and `:383-386`.
Existing check: `historian.rs:2881`, `:2942`, `:3138`, `:4533`. Status
`unaudited`.
Impact: A stored original that is narrower than the summary, or whose content was
re-read after the model spoke, makes the durable full-message recovery misleading
rather than absent, which is worse: an expand would return messages the summary
does not describe, or omit messages it does.
Open questions:

- Does the reattach path's differing `sequence_offset` and `validate_options`
  (`lib.rs:4760-4768`) change which range is kept, relative to what the fresh path
  would have kept for the same chunk? See the contract-vs-code leads below.
  Unresolved.

### hv-heal-extends-range-without-revalidating-content

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `twenty_message_tool_only_gap_heals_like_typescript_validator`
(`:1443`) and `terminal_unprocessed_boundary_closes_a_completed_arc_forward`
(`:1683`) cover the range mutation; neither asserts anything about the body
relative to the widened range.
Guarantee: When healing widens a compartment's ordinal range, the widened range
still contains only ordinals whose content the compartment's body is entitled to
claim.
Check: `always-or-unreached` — for every accepted compartment whose `end_message`
differs from the parsed value, every newly covered present ordinal lies inside
`chunk.tool_only_ranges` or inside a `chunk.completed_tool_arcs` entry that the
terminal heal closed. `always-or-unreached` rather than `always` because the
antecedent is a healed compartment: `heal_compartment_gaps` and
`heal_terminal_completed_tool_arc` are optional paths that most publishes never
enter, and the property must hold for each healed compartment whenever one occurs.
Fault/timing angle: The window is between parse and mapping:
`heal_compartment_gaps` (`:493-497`) and `heal_terminal_completed_tool_arc`
(`:498-504`) mutate ranges at `:493-504`, before mapping at `:506` and before
validation at `:514`.
Required faults and enabling state: A chunk with `tool_only_ranges` or
`completed_tool_arcs` populated by `historian_chunk.rs`, and a model output that
leaves a gap inside one of them.
Confidence: high —
[evidence](evidence/hv-heal-extends-range-without-revalidating-content.md).
`heal_compartment_gaps` sets `compartments[i - 1].end_message` at `:927-930` and
touches no content field; `heal_terminal_completed_tool_arc` sets
`last.end_message` at `:889` and rewrites `unprocessed_from` at `:891-896`.
`map_parsed_compartments_to_chunk` then stamps a NEW `end_message_id` from the
healed ordinal (`:945-948`, `:969`), so the durable boundary identity changes too.
The healed end is still checked for anchorability at `:958-963`, and a
non-tool-only gap still rejects at `:1046-1049`.
Existing check: `:918-926` restricts gap healing to fully tool-only gaps; `:880`
restricts arc healing to arcs ending at or before `chunk_end`; `:958-963` requires
the healed end to be anchorable.
Impact: The stored compartment asserts coverage of raw messages its summary never
described, and its `end_message_id` names a block the model never saw as its
boundary. The module's own comment at `:923-925` accepts this for tool-only noise;
the record exists so the premise ("Production replay showed contiguous narrative
coverage") is a claim under test rather than a settled fact.
Open questions:

- Are `tool_only_ranges` and `completed_tool_arcs` themselves derived only from
  module-side classification, with no model influence? `historian_chunk.rs` builds
  them, so they appear trustworthy, but the derivation was not audited in this
  pass. Unresolved, needs the chunk-construction lens.

## Group F: content floors and degenerate output

Three records on how little a summary is allowed to be. The gate's strongest
content requirement is that `p1` is not blank, so the first two records are the
two shapes that requirement admits: a near-empty body over a long span, and N
byte-identical bodies over N distinct topics. The third is adjacent because it
concerns the one protection that would withhold a weak boundary for
re-derivation and does not apply to a single-compartment output, which is exactly
the shape the first record produces.

### hv-degenerate-body-passes-content-gate

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the 19 inline tests all use bodies generated from the
compartment title (`:1367-1375`), never a degenerate one.
Guarantee: The publish path can be reached with a compartment body that carries
essentially no information about the ordinals it replaces.
Check: `sometimes` — at least one campaign publish reaches the
`to_stored_compartment` call at `historian.rs:466`, inside `publish_validated_chunk`
(`:444`), with an accepted compartment whose `p1.trim().chars().count() == 1` and
whose `end_message - start_message` is at least 100. Semantics are `sometimes`, not
`reachable`, because METHOD.md's situation-coverage rule applies: `:466` is a
common call point reached on every publish and inside a `.map` over every accepted
compartment, so location coverage is satisfied by any publish at all and proves
nothing. What must be witnessed is the operational state, a near-empty body over a
long span, which a campaign can miss entirely while executing those lines
constantly.

Two corrections are folded in. The semantics were `reachable`, which this record's
own rationale defended as "this code location is attainable" — but the location is
attained by every publish, so the old check could not fail. And the cited location
was wrong: `historian.rs:1738` is inside `abandon_current_state`'s signature, and
the secondary citation `:471-475` is the events projection. The only production
`to_stored_compartment` call is `:466`.
Fault/timing angle: None. No interleaving needed.
Required faults and enabling state: A configured historian model chain and a
producer returning one well-formed compartment with a one-character `p1`, a
non-empty `title`, and a matching `<unprocessed_from>`.
Confidence: high —
[evidence](evidence/hv-degenerate-body-passes-content-gate.md). Traced every
content-touching line: `:298-303` (title non-empty, a drop), `:309-331` (tier
presence), `:1000-1008` (p1 non-blank). No length, ratio, or span-relative check
exists in `:1-1304`.
Existing check: `:1000-1008` rejects a blank `p1`, which is the strongest content
requirement in the module.
Impact: A long stretch of real conversation is served as a near-empty summary.
Compounded by hv-single-compartment-skips-lookahead-discard, because a
one-compartment output also skips the discard-last protection.
Open questions:

- Does the project want a span-relative floor, or is body adequacy deliberately
  delegated to the historian-eval scorer lane (`ci.yml:415-440`)? (needs human
  input)

### hv-no-cross-compartment-content-distinctness

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test emits two compartments with identical bodies.
Guarantee: Two compartments published in one run that cover disjoint ordinal
ranges do not carry byte-identical bodies.
Check: `always` — for every accepted `ValidatedChunk`, no two elements of
`compartments` share the same `(title, p1, p2, p3, p4)` tuple. `always` because it
is a property of each admitted set, evaluated at every publish.
Fault/timing angle: None.
Required faults and enabling state: A producer returning N contiguous compartments
whose ranges partition the chunk and whose bodies are copies of one another.
Confidence: high —
[evidence](evidence/hv-no-cross-compartment-content-distinctness.md).
`validate_parsed_compartments` (`:983-1084`) iterates compartments and compares
only `p1` presence and ordinals; no cross-element content comparison exists
anywhere in `:1-1304`.
Existing check: none.
Impact: The rendered m0 shows the same paraphrase repeated for each distinct
topic, so the agent sees one topic where the user had N. Ordinal coverage is still
correct, so nothing later detects it.
Open questions: None.

### hv-single-compartment-skips-lookahead-discard

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `discard_last_progress_guard_boundary_k1_vs_k2` (`:1633`)
covers the k1/k2 lookahead boundary with two compartments; no test covers the
one-compartment case.
Guarantee: A compartment whose terminal boundary was chosen with less than
`BOUNDARY_HEALING_SLACK` ordinals of lookahead is withheld for re-derivation,
regardless of how many compartments the run produced.
Check: `always-or-unreached` — whenever
`chunk.end_index - last.end_message <= BOUNDARY_HEALING_SLACK`, `in_emergency` is
false, and `force_keep_last_compartment` is false, the accepted set does not
contain that last compartment. `always-or-unreached` rather than `always` because
the antecedent is a conditional shape, a chunk whose narrative ends within two
ordinals of the chunk end, which a campaign may never produce; the protection must
hold whenever it does.
Fault/timing angle: The window is a chunk whose narrative ends within two ordinals
of the chunk end, so the final boundary is guessed without real lookahead.
Required faults and enabling state: A chunk whose content yields a single
compartment ending at or within two ordinals of `chunk.end_index`, with
`in_emergency` and `force_keep_last_compartment` both false.
Confidence: high —
[evidence](evidence/hv-single-compartment-skips-lookahead-discard.md). The guard
at `:539` requires `compartments.len() >= 2`; with one compartment the whole block
`:539-558` is skipped and `discarded_last` stays false.
`BOUNDARY_HEALING_SLACK = 2` at `:19`, applied at `:554`.
Existing check: `:539-558` for two or more compartments; tests at `:1633`,
`:1730`, `:1748`, `:1849`.
Impact: The weakest-lookahead boundary in the system is published unprotected in
exactly the case where the model had the least evidence. A wrong boundary freezes
into durable coverage.
Open questions:

- Is the `>= 2` guard intentional (popping the only compartment would fail the
  `:565-570` forward-progress check and reject the run) or accidental? The
  interaction suggests intentional; no comment says so. (needs human input)

## Group G: encoding, control characters, and numeric bounds

Three records on what the gate does to the bytes and numbers it admits. The gate
applies exactly one text transform, `unescape_xml` (`historian_validate.rs:1148-1154`),
which decodes five entities and strips nothing, and exactly one numeric narrowing,
an unchecked `as i32` on `importance` (`historian.rs:57`). The compensating
controls all live downstream in `decay_render.rs` and are asymmetric, so these
records are about what durable rows hold rather than what one renderer shows.

### hv-control-characters-reach-durable-rows

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no fixture contains a control character.
Guarantee: Model-authored text admitted by the gate cannot carry control
characters or line/paragraph separators into durable compartment rows.
Check: `always` — for every accepted compartment, no character of `title`,
`content`, or `p1`..`p4` satisfies `char::is_control()` or is
`\u{2028}`/`\u{2029}`. `always` because it must hold for each admitted
compartment.
Fault/timing angle: None.
Required faults and enabling state: A producer emitting a compartment whose `p1`
body or `title` attribute contains `\u{2028}`, `\r`, or an ANSI escape introducer.
Confidence: high —
[evidence](evidence/hv-control-characters-reach-durable-rows.md). Read all of
`:1-1304`: the only text transform is `unescape_xml` (`:1148-1154`), which decodes
five entities and strips nothing. Confirmed the compensating control exists
downstream and is asymmetric: `decay_render.rs:104-121` strips controls from
TITLES only; `decay_render.rs:138-147` guards only `\n## ` in bodies.
Existing check: `decay_render.rs:104-121` for titles at render time, marked in its
own comment as "Historian-authored titles are untrusted". Bodies have no
equivalent.
Impact: Durable rows hold unsanitized bytes. Any consumer that does not replicate
`decay_render`'s title handling renders them raw. The m0 path is defended for
titles and XML-escaped for bodies, so the exposure is to other readers of the same
rows.
Open questions:

- Should the gate be the sanitation point, or is renderer-side sanitation the
  deliberate design? The title comment suggests the latter was chosen consciously.
  (needs human input)

### hv-unescape-xml-double-decodes-entities

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `historian_prompt.rs:430-431` tests the escape direction
only; nothing tests the round trip.
Guarantee: Text that survives the gate is the text the model wrote: applying
`unescape_xml` to correctly escaped input reproduces the original exactly.
Check: `always` — for all `s`, `unescape_xml(escape_xml_content(s)) == s`. `always`
because the gate applies `unescape_xml` on every admitted field.
Fault/timing angle: None.
Required faults and enabling state: A model body containing the literal
five-character sequence `&lt;` as prose, which the producer correctly escapes to
`&amp;lt;`.
Confidence: high —
[evidence](evidence/hv-unescape-xml-double-decodes-entities.md). `unescape_xml`
(`:1148-1154`) replaces `&amp;` -> `&` FIRST, then `&lt;` -> `<`, so `&amp;lt;`
becomes `&lt;` becomes `<`. The counterpart `escape_xml_content`
(`decay_render.rs:80-84`, `historian_prompt.rs:104-108`) escapes `&` first and is
therefore correct; only the inverse is wrong.
Existing check: `historian_prompt.rs:427-432` asserts the escape functions, never
the inverse.
Impact: Model text that legitimately discusses entity syntax is corrupted, and
specifically GAINS raw `<`/`>` that were not markup in the source. The m0 renderer
re-escapes, so the damage is stored-text corruption rather than markup injection.
Open questions:

- Does the TypeScript host parser have the same ordering, making this a faithful
  port of an upstream defect rather than a divergence? Unresolved, needs the
  TypeScript parser source.

### hv-importance-unbounded-then-truncating-cast

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — every fixture uses `importance="50"` or `"60"`.
Guarantee: A published compartment's stored `importance` lies in the documented
1..=100 band that the decay curve consumes, or the output is rejected.
Check: `always` — for every `StoredCompartment` produced by
`to_stored_compartment`, `1 <= importance <= 100`. `always` because the invariant
must hold for every published row.
Fault/timing angle: None.
Required faults and enabling state: A producer emitting
`importance="4294967296"` or any value above `i32::MAX` on an otherwise valid
compartment.
Confidence: high —
[evidence](evidence/hv-importance-unbounded-then-truncating-cast.md). Parsed as
unbounded `\d+` at `:1195`, captured to `u64` at `:306` via `capture_u64`
(`:1106-1110`), narrowed by `as i32` at `historian.rs:57`. Confirmed no clamp in
`mc-store` (schema default only, `mc-store/src/lib.rs:455`; insert at `:12288`
casts back to `i64`). The only clamp is at render, `decay_render.rs:269-272`.
Existing check: `decay_render.rs:271` `.clamp(1, 100)` at render time, which
converts a wrapped negative into the LOWEST importance rather than rejecting it.
Impact: A compartment the model marked maximally important is stored with a
wrapped value and rendered as least important, so it decays to the densest tier
first. Silent, and the stored row is wrong for any consumer that does not clamp.
Open questions:

- Are there stored-compartment consumers besides `decay_render.rs` that read
  `importance` without clamping? Unresolved, needs a sweep of `mc-store` readers in
  a Part 3 or 4d pass.

## Group H: gate enforcement and bypass surface

Three records on whether the gate can be circumvented and what happens if it is.
The first is the structural finding, that `ValidatedChunk` is not a proof-carrying
token, and it is the enabling change for the second, a defensive arm the code's own
comment says is unreachable. The third is the gate's other disposition problem: a
class of input it neither admits nor rejects but silently drops, so a degrading
extraction is indistinguishable from a model that extracted nothing.

### hv-publish-accepts-unvalidated-validated-chunk

Type: safety
Reachability: default-production
Status: active
Exercised: partial — four tests call `publish_validated_chunk` directly with
hand-built input (`historian.rs:4173`, `:4328`, `:4414`, `:4495`), demonstrating
the bypass is trivially constructible, but no test asserts the production
invariant.
Guarantee: Every set of compartments that reaches the durable publish transaction
was produced by `validate_historian_output` from the same output text and the same
pinned chunk.
Check: `always` — every execution of `publish_validated_chunk`
(`historian.rs:444`) is preceded in the same call chain by a successful
`validate_historian_output` over the text that produced its `validated` argument.
`always` because the obligation applies to each publish; the forbidden state has no
single detection point, so per the coverage rules this is `always(...)`, not
`unreachable`.
Fault/timing angle: None. This is a structural, not a timing, property.
Required faults and enabling state: None in the current tree; the record documents
that the type system does not enforce the invariant. A second call site added later
is the enabling change.
Confidence: high —
[evidence](evidence/hv-publish-accepts-unvalidated-validated-chunk.md).
`ValidatedChunk` at `:226-238` has all-`pub` fields and derives `Default`;
`historian.rs:444` is `pub fn` inside `pub mod historian` (`lib.rs:19`), and
`historian_validate` is also `pub` (`lib.rs:23`). Confirmed by `rg` that the only
production constructions of a `ValidatedChunk` are `historian_validate.rs:628`
(the gate's own return) and test code at `historian.rs:4476`.
Existing check: convention only. Both production paths (`historian.rs:1419`,
`:1592`) funnel through `publish_output_from_awaiting`, which validates at `:1673`.
Impact: A future publish route, or an external crate depending on `mc-module`, can
write model text into durable compartments with zero validation. This is the
mechanism that would make hv-tierless-stored-row-arm-must-stay-unreachable fire.
Open questions:

- Should `ValidatedChunk` carry a private field so only the gate can construct it?
  That is an API change with a `pub` surface cost. (needs human input)

### hv-tierless-stored-row-arm-must-stay-unreachable

Type: safety
Reachability: default-production
Status: active
Exercised: partial —
`tierless_compartments_reject_while_p1_only_output_keeps_soft_fallbacks` (`:1463`)
proves the gate rejects tierless output; nothing asserts the `legacy: 1` arm is
never taken.
Guarantee: The legacy-row arm of the publish projection never executes, because
validation rejects every tierless compartment before publish.
Check: `unreachable` — the `1` arm of the `legacy` expression at `historian.rs:65`
must never be evaluated during a publish. Semantics are `unreachable` because this
is a specific code location the code's own comment says cannot be reached, not a
state without a detection point.
Fault/timing angle: None.
Required faults and enabling state: Reached only if a caller constructs a
`ValidatedChunk` without the gate, which is why this record and
hv-publish-accepts-unvalidated-validated-chunk are paired.
Confidence: high —
[evidence](evidence/hv-tierless-stored-row-arm-must-stay-unreachable.md).
`historian.rs:60-62` states the claim: "Strict validation makes tierless output
unreachable, but derive legacy from P1 so a future bypass cannot falsely mark a
flat row as v2." Verified the gate's side: `:1000-1008` rejects an absent or blank
`p1`, and `ValidatedCompartment.p1` is a clone of the parsed value (`:972`), so the
projection sees the validated field.
Existing check: `historian.rs:63-67` is itself the defensive derivation; `:1463`
covers the gate side.
Impact: If the arm ever fires, a flat row is written and `decay_render.rs:154-156`
renders it through the legacy tier path with `truncate_with_ellipsis` bounds
(`:185-192`), so the failure is silent tier degradation rather than a crash.
Open questions: None.

### hv-side-channel-anchor-out-of-range-drops-silently

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `zero_side_channel_anchor_is_suppressed` (`:1774`) and
`events beyond persisted compartment count are filtered` (golden case) cover the
filtering; nothing asserts the drop is reported.
Guarantee: A side-channel item whose declared anchor does not name a persisted
compartment is either rejected with the run or reported, never silently discarded.
Check: `always-or-unreached` — for every input side-channel item with
`origin_compartment_index` or `at_compartment` outside `1..=persisted_count`, the
run either returns `Err` or records a counted drop. `always-or-unreached` rather
than `always` because the antecedent is an out-of-range anchor, which most outputs
never carry; the disposition rule must hold whenever one arrives.
Fault/timing angle: None.
Required faults and enabling state: A producer emitting a fact, event, or primer
anchored to a compartment index above the count that survives discard-last.
Confidence: high —
[evidence](evidence/hv-side-channel-anchor-out-of-range-drops-silently.md).
`keep_side_channel` (`:1086-1098`) returns `false`; the four call sites
(`:576-583`, `:592-598`, `:603-610`, `:616-623`) use `.filter`, so the item
vanishes. `.take(1)` at `:611` additionally discards all but the first surviving
primer with no comment. Confirmed no counter or log on any of these paths.
Existing check: `:1094-1097` bounds the anchor. Its disposition is a filter, not a
reject or a metric.
Impact: Extracted facts the model did produce are lost with no signal, so a
degrading extraction looks identical to a model that extracted nothing.
`user_observations` are additionally gated off by default (`config.rs:128`), so the
practical exposure is facts, events, and primers.
Open questions:

- Should `.take(1)` on primers be a documented cap or a reject when more than one
  survives? (needs human input)

## Relationship map

Grouped by shared mechanism rather than by the section headings above, because
several of the sharpest relationships cross groups. Every dominance statement
below is a **hypothesis** about which oracle subsumes which, offered to guide
ordering, not a verified claim; none of them has been tested, because none of
these records has an executing check.

- **One transaction, six writes, and what a crash leaves.**
  [publish-transaction-rolls-back-every-write-on-a-late-sql-error](#publish-transaction-rolls-back-every-write-on-a-late-sql-error),
  [publish-transaction-survives-process-death-as-all-or-nothing](#publish-transaction-survives-process-death-as-all-or-nothing),
  [crash-before-publish-commit-refires-without-partial-state](#crash-before-publish-commit-refires-without-partial-state),
  [publish-preserves-raw-chunk-messages-atomically](#publish-preserves-raw-chunk-messages-atomically).
  All four rest on the same boundary: every early return inside the closure at
  `mc-store:9360-9505` is a value rather than a commit, and the single
  `tx.commit()` is in the sibling wrapper, reached only after the closure returns
  `Ok` (`cortexkit-store:229-231`). Either atomicity record *hypothetically
  dominates* the raw-preservation record, because a proof that all six writes are
  one atom includes the transcript write; what neither dominates is the
  round-trip half, that the stored bytes inflate to the exact pre-publish
  messages, which is a content claim rather than an atomicity claim.

  The cost statement here has been corrected. This bullet previously said the
  atomicity claims are "currently unfalsifiable by a Rust test", on the grounds
  that no fault seam exists inside the transaction. That holds for the process-death
  record and not for the SQL-error record, which is why they are now two records.
  The SQL-error half is constructible today with no new seam: the closure's final
  `mc_cache_state` UPDATE (`mc-store:9496-9500`) propagates a `rusqlite` error
  through a bare `?`, so a main-schema `RAISE(ABORT)` trigger installed from a
  second raw connection, a technique an existing test already uses
  (`mc-store:16704`), forces the rollback after three writes have applied. So three
  of these four are constructible today and only the process-death record is not.
- **Two freshness inputs at one commit point.**
  [publish-fence-rejects-selected-content-drift](#publish-fence-rejects-selected-content-drift),
  [historian-single-flight-admits-one-publish-per-firing](#historian-single-flight-admits-one-publish-per-firing),
  [publish-admits-awaiting-producer-phase-at-commit](#publish-admits-awaiting-producer-phase-at-commit).
  The commit point runs seven gates and these three records partition them. The
  fingerprint is deliberately blind to same-length content edits
  (`historian.rs:141-143`) and `selected_range_identities` is the compensating
  fence (`mc-store:9413-9425`), so the fence record and the single-flight record
  are testing different gates that happen to share one predicate struct.
  Constructing the fence record's drift mutation *hypothetically dominates* half
  of the single-flight record, because the same commit hook that mutates
  `block_identity_by_mid` mid-await is the seam that lets a second publisher
  interleave. The phase record is outside that dominance relation entirely: it is
  a static widening, needs no interleaving, and is the one gate whose failure mode
  is "validation never happened" rather than "the input went stale".
- **The gate ran, and what happens if it did not.**
  [hv-publish-accepts-unvalidated-validated-chunk](#hv-publish-accepts-unvalidated-validated-chunk),
  [hv-tierless-stored-row-arm-must-stay-unreachable](#hv-tierless-stored-row-arm-must-stay-unreachable),
  [publish-admits-awaiting-producer-phase-at-commit](#publish-admits-awaiting-producer-phase-at-commit).
  This is the most important cluster in the part, and it is one finding attacked
  from three sides. The type system does not make validation mandatory
  (`ValidatedChunk` is all-`pub` and derives `Default`), the store's phase gate
  does not require that validation happened (`AwaitingProducer` is admitted), and
  the code has already written a defensive fallback for the case where the
  convention breaks (`historian.rs:59-66`, whose comment names "a future bypass"
  outright). The two lens agents raised the first and third independently and
  their own notes say they are complementary rather than duplicates, so both are
  kept deliberately. Hypothesis: making `ValidatedChunk` unconstructable outside
  the gate would dominate all three, since it would close the bypass, make the
  tierless arm genuinely unreachable, and reduce the phase widening to a
  belt-and-braces redundancy. Narrowing the store's phase gate alone dominates
  none of them, because the bypass is in `mc-module` and does not go through the
  phase check to be dangerous.
- **Nothing ties the words to this conversation.**
  [hv-output-not-bound-to-chunk-identity](#hv-output-not-bound-to-chunk-identity),
  [hv-degenerate-body-passes-content-gate](#hv-degenerate-body-passes-content-gate),
  [hv-no-cross-compartment-content-distinctness](#hv-no-cross-compartment-content-distinctness).
  Three consequences of one absence: the gate consults only ordinals, presence,
  and anchorability, and never any function of the chunk's text. Each record is a
  different degenerate output that satisfies every ordinal check. The binding
  record *hypothetically dominates* the other two, because a required
  chunk-derived echo would be hard to satisfy with a one-character body or with N
  identical bodies. That dominance is exactly what the record's own open question
  puts at risk: an echo requirement may be incompatible with the byte-identical
  TypeScript oracle the golden test pins, so the cheapest oracle here may not be
  the strongest one available.
- **A range that moves after the model spoke.**
  [hv-heal-extends-range-without-revalidating-content](#hv-heal-extends-range-without-revalidating-content),
  [reattach-publishes-a-chunk-recomputed-after-the-model-ran](#reattach-publishes-a-chunk-recomputed-after-the-model-ran),
  [publish-fence-rejects-selected-content-drift](#publish-fence-rejects-selected-content-drift),
  [hv-single-compartment-skips-lookahead-discard](#hv-single-compartment-skips-lookahead-discard).
  Four mechanisms that decide the published boundary, and they interact rather
  than stack. Healing widens `end_message` and restamps `end_message_id` without
  re-reading the body; the reattach path rebuilds the chunk and the raw payload
  from a later projection with `in_emergency: false` and
  `force_keep_last_compartment: false` regardless of the original firing's
  options; the identity fence pins content only for mids inside the pinned range;
  and the discard-last protection that would withhold a weak terminal boundary does
  not run for a single compartment. No dominance is claimed inside this cluster. It
  is the one place in the part where the records genuinely compose into a scenario
  nobody has constructed: a single-compartment reattach whose range is recomputed
  from a later projection, healed forward to close an arc, and published with no
  lookahead protection.

  The composed scenario is narrower than this bullet previously claimed. It said
  the recomputed range "extends past the pinned end" with "a raw payload wider than
  the summary", and cited the permitted tail extension as the reason. That premise
  is withdrawn: the reattach's exclusive bound (`lib.rs:4701`, enforced at
  `historian_chunk.rs:373-375` and `:383-386`) makes a wider range impossible. The
  surviving composition is a recomputed same-bound range whose contents were re-read
  after the model spoke, which is a correspondence risk rather than a coverage one.
- **The floor as a publish detector.**
  [publication-floor-advances-only-on-publish](#publication-floor-advances-only-on-publish),
  [publication-floor-never-outruns-appended-coverage](#publication-floor-never-outruns-appended-coverage),
  [wrapup-rounds-require-observed-boundary-advance](#wrapup-rounds-require-observed-boundary-advance),
  [publish-transaction-rolls-back-every-write-on-a-late-sql-error](#publish-transaction-rolls-back-every-write-on-a-late-sql-error).
  The single-write-site record is the load-bearing one: the emergency arm's
  interleaving detection is built on it (`lib.rs:8481-8501`), and it is cheap to
  check, since it is a static enumeration of assignment sites plus one
  before/after comparison. Hypothesis: it dominates nothing but is depended on by
  everything else here. The coverage-bound record needs a healed batch to be
  interesting, the wrapup record needs a producer that publishes without
  advancing the boundary, and both of those states are produced by the same fake
  producer, so one harness serves both. The atomicity record appears in this
  cluster too, because the floor and the compartment rows being in one transaction
  is what makes the floor a sound detector at all.
- **How many runs, how many refires, and who is told.**
  [uncertain-producer-start-authorizes-a-second-billable-run](#uncertain-producer-start-authorizes-a-second-billable-run),
  [hv-validation-rejection-retry-has-no-attempt-bound](#hv-validation-rejection-retry-has-no-attempt-bound),
  [hv-side-channel-anchor-out-of-range-drops-silently](#hv-side-channel-anchor-out-of-range-drops-silently).
  Three records whose shared consequence is that a degrading historian is
  invisible. The start-failure branch bills a second run without the positive
  proof the output branch demands; a validation rejection refires every 60 seconds
  with no escalation and never increments `consecutive_publish_failures`, so
  `publish_health_degraded` stays false through unlimited rejections; and a
  dropped side-channel item is not counted anywhere. None dominates another,
  because each breaks a different signal. They are grouped because a single
  campaign observation, counting provider runs and rejections at a fake while
  polling the status block, would exercise all three at once, which makes this the
  cheapest cluster in the part by leverage.
- **Bytes and numbers that only one consumer repairs.**
  [hv-control-characters-reach-durable-rows](#hv-control-characters-reach-durable-rows),
  [hv-unescape-xml-double-decodes-entities](#hv-unescape-xml-double-decodes-entities),
  [hv-importance-unbounded-then-truncating-cast](#hv-importance-unbounded-then-truncating-cast).
  All three admit a value the gate does not check and rely on `decay_render.rs` to
  repair it, and in all three the repair is partial: controls are stripped from
  titles but not bodies (`:104-121` versus `:138-147`), the escape direction is
  correct while the inverse is not, and `importance` is clamped at render
  (`:269-272`) in a way that turns a wrapped negative into the lowest importance
  rather than an error. These are the cheapest oracles in the part, since all
  three are pure-function properties over an input domain with no faults and no
  interleavings, and the entity round trip is a one-line property test. No
  dominance among them; they share only the architectural question of whether the
  gate or the renderer owns sanitation, which is a single open decision behind all
  three.
- **The retention trade, standing alone.**
  [raw-chunk-message-retention-has-no-eviction-budget](#raw-chunk-message-retention-has-no-eviction-budget).
  The only record in the part that is a resource property rather than a
  correctness one, and it is deliberately outside every dominance chain. It is the
  price of the preservation guarantee: eviction is built to blank a transcript and
  keep the raw payload, so per-session raw growth is bounded only by the number of
  publishes. It is in the catalog so the trade is explicit. Note the tension with
  the one preservation exception named at the top of this catalog: the suffix
  revert at `mc-store:9105-9111` is the only thing that ever reclaims a raw
  payload, and it does so as a side effect of undoing a fold rather than as a
  retention policy.

