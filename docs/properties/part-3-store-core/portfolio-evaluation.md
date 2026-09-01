# Part 3 portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. It produced 14
findings, and two of them are refutations of the fault map's own claims rather
than of the catalog's.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every correction below was re-verified against the code before acceptance,
including the two the evaluator raised against the fault map. The evaluator was
substantially right in every case and imprecise in two, both recorded.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 6 | 6 applied, 2 with a corrected premise |
| fault-map correction | 1 | applied after independent verification at `80585c48` |
| gap | 5 | queued for a follow-up pass |
| bias | 3 | require human judgment |

Record count 36 to **37**, from the reset-cycle split. Semantics distribution
26 `always`, 7 `always-or-unreached`, 3 `reachable`, 1 `unreachable`, 0
`sometimes`, against 30/2/4/0/0 before. Types 33 safety, 4 reachability.

## Refinements applied

### R1. Three records over-routed to expensive fault infrastructure

Verified and applied in `fault-map.md`. All three had been assigned a capability
they do not need, which inflated the apparent cost of the part.

`failed-fenced-transaction-leaves-no-partial-state` was routed to F2, storage
exhaustion. It needs only a late SQL error: a closure that writes at statement k
and then hits a constraint or a bogus statement. Verified the mechanism is
available today with no new infrastructure — in-crate tests already reach
`store.inner.with_conn(...)`, `with_conn_fenced` takes an arbitrary closure,
`foreign_keys = ON` (`cortexkit-store:291`), and the bootstrap carries `CHECK`,
`NOT NULL`, and `UNIQUE` constraints. One caveat recorded in the map:
`commit_state_import` validates *before* its insert loop
(`lib.rs:7172-7174`), so in that closure the error must come from a constraint,
not from `validate_state_import_compartments`. F2 now unblocks zero records.

`post-migration-open-repair-is-resumable-and-effect-idempotent` was routed to F1,
a kill after the first batch commits. Verified that `repair_note_artifacts_v51`
(`lib.rs:5069-5113`) holds no in-memory progress across batches: the project list
is re-derived on every open, and all progress lives in
`compiled_source_revision IS NULL` (`:5084`) plus the sentinel row
(`:5070-5077`). The four committed-prefix states a kill could leave are therefore
constructible directly by SQL, then reopened. No kill needed.

`intent-staged-replay-produces-one-context-effect` was routed to F1 and F10.
Verified the post-crash state is exactly a persisted `staged` row, which
`tests/claim_intent_ledger.rs` already constructs, and that re-driving the stage
enters the replay path at `lib.rs:11048-11073`. F1 drops out; **F10 does not**,
and the record still counts as not constructible today for that reason. Recorded
honestly rather than promoted.

Consequences carried through the map: totals 22/4/10 to **25/4/8**, F1's record
count 4 to 2, and a new leverage-ranking item 4 for late SQL errors and
persisted-prefix fixtures, placed above F4 because it needs no new construction
mechanism at all.

### R2. Seven check-semantics corrections

Applied in `catalog.md`, each with a one-clause rationale on the `Check:` line as
METHOD.md requires. Six move from `always` to `always-or-unreached` because the
condition's antecedent is conditional, and one moves the other way.

To `always-or-unreached`: `failed-fenced-transaction-leaves-no-partial-state`
(evaluable only on a closure that returned `Err`);
`busy-timeout-expiry-aborts-cleanly-without-partial-effect` (only on a busy
expiry); `mirror-receipt-conflict-rejects-divergent-replay` (only on a reused
receipt ID); `intent-identity-is-producer-and-operation-key` (only on a recurring
key); `intent-terminal-state-is-entered-at-most-once` (only on a row already
terminal); `intent-staged-replay-produces-one-context-effect` (only on a replay).

The conflict record's old rationale is worth naming, because it was a category
error rather than a slip. It argued `always` "because the comparison at
`claim_mirror.rs:929-939` is on the same unconditional path as the
accepted-replay case". Verified the shape: the dedup *lookup* at `:920-927` does
run on every apply, but the comparison arm is entered only through
`if let Some(stored_digest) = replay` at `:928`. The old rationale conflated an
unconditional lookup with an unconditional comparison. The new line says so.

To `always`: `mirror-accepting-gate-is-skipped-when-control-is-absent`. Verified
the check asserts a required outcome for **both** the present and the absent
control row, so the two arms are total and the property is evaluable on every
apply rather than only when the gate at `:908-919` is entered. The absent-row arm
is the one that fails today, since `if let Some(control)` has no `else` and an
absent row is treated as permission; a failing arm is a claim under test, not a
reason to weaken the semantics.

### R3. The reset-cycle record was two opposite claims

Split. `mirror-reset-cycle-requires-a-rebuild-grant` keeps the `reachable` claim,
whether the valid clear path can be entered from a production entry point at all.
The new `mirror-clear-without-a-grant-is-never-entered` carries `unreachable`,
whether a clear without a grant is kept out. The first fails today and the second
passes, which is why one record could not hold both.

`unreachable` is defensible here only because the campaign precondition is stated
in the check: within a campaign that never calls `begin_claim_store_rebuild`, the
clear statements at `claim_mirror.rs:816` and `:1148` must never execute. That
makes it a code-location claim rather than the compound state METHOD.md sends to
`always(!X)`. The wording is explicit about that.

Verified for the split: `clear_claim_mirror` (`:702-708`) drops all four tables
and has exactly two call sites; the reseed guard at `:806-808` fails closed
because `matches!(None, Some(_))` is false; the delete guard at `:1136-1147`
fails closed through `.optional()?.unwrap_or(false)`; and
`tests/claim_mirror.rs:461-479` already drives the reseed refusal arm while
nothing covers the delete arm.

This is the one case where an evidence file was added. The new
`evidence/mirror-clear-without-a-grant-is-never-entered.md` takes the guard
analysis, and the original was trimmed to the reachability claim with a scope note
pointing at its sibling. Both now carry a cross-reference explaining that they
share two markers and expect opposite outcomes under different campaign
preconditions.

The split also surfaced a finding neither record had: the same singleton control
row has **three** independent derivations of `resetting` — a Rust `matches!` in
the reseed, a SQL boolean with `unwrap_or(false)` in the delete, and an
`if let Some(control)` with no `else` in the apply. Two fail closed, one fails
open. Queued as an open question on the new record.

### R4. Three records claimed something a workload cannot observe

`synchronous-level-is-explicitly-declared-not-inherited` asserted that
`PRAGMA synchronous` "equals a value some line of code set". Provenance is not
observable: there is no runtime difference between a level code set and the
identical level inherited from `SQLITE_DEFAULT_SYNCHRONOUS`. Replaced with an
exact-value check on the live connection from `McStore::open`, with the note that
`verify_sqlite_connection_contract` cannot serve as the oracle because it accepts
the whole set `1..=3` (`sqlite_runtime.rs:133-136`).

`write-predicates-are-re-evaluated-inside-the-write-transaction` asserted that
every gated write shares one transaction handle with its predicate. That is a
property of source structure, and the record's own Confidence line admits it was
verified "by scanning every production `fn`". Narrowed to the enumerated sites
with their observable consequence each: `commit_state_import` (`lib.rs:7153-7159`,
`:7170`), `commit_transform` (`:7354-7358`, `:7390`), the two CAS loops, and the
open-path pair (`:4873`, `:4874`). The universal form is noted as belonging to a
lint or review checklist rather than a test.

`mirror-staleness-undetectable-on-memory-tool-read-path` now marks its
cross-boundary prerequisite explicitly. The read-surface enumeration is checkable
in this tree; the consequence half is not, because "behind the authority" is not
expressible anywhere in these three crates, so any assertion about observed
staleness is blocked on F10 rather than on effort.

### R5. The schema-version record mixed four things

Narrowed to an independent `store.db` manifest comparison. Two clauses moved out
with a note saying where: the crash before the post-migration repairs
(`lib.rs:4902-4903`) alters *data* and belongs to the repair record that already
owns resumability, and `recorded_mc_cache_version` mapping a recorded `0` to
`None` (`:1364`) is a version-admission question, queued below as a gap.

Two verifications strengthened this beyond the evaluator's framing. First, the
document the record leaned on is scoped to a different database: the "exact
`main.sqlite_schema` inventory" promise at
`docs/migration-version-lanes.md:11-17` sits under "Format identity" in a file
titled "Context database format", so it governs `context.db`. Only the "Runtime
contract" section (`:41-48`) extends to `store.db`, and it names foreign keys,
WAL, busy timeout, and synchronous mode — no inventory. The record now stands on
the out-of-band divergence risk alone.

Second, the record's open question was wrong. It said
`compute_schema_manifest_digest` (`sqlite_runtime.rs:156-167`) "exists to make
exactly this comparison cheap". Verified it does not: it digests a supplied
component manifest of `name`/`dependsOn`/`provides` tuples and never reads
`main.sqlite_schema`, so it compares declarations to declarations. That is why the
narrowed check now insists the expected object set be *independently* derived —
re-deriving it from the same bootstrap string it audits would be a tautology.

### R6. The tokenizer provenance record was mis-typed and over-claimed

Retyped from `reachability` to `safety` with `always` semantics, and the check
restated as stamping the resolved version plus a vocab digest and verifying the
runtime pin. The property is now an agreement between recorded and actual values
rather than the execution of a step.

The evaluator's premise needed one correction. It said "the generator names a
version and the lockfile pins it locally". The lockfile half is right:
`bun.lock:793` pins `ai-tokenizer@1.0.6` with a sha512 integrity hash, so
provenance is genuinely not absent from the repository and the record's "no
version, no vocab digest, no generator stamp" overstated the case. The generator
half is not: `crates/mc-tokenizer/gen/gen-token-golden.ts:17-19` resolves
`ai-tokenizer` by module specifier through `Bun.resolveSync` and stamps no
version anywhere. The record now says the lockfile provides the pin and the
generator provides only the specifier.

The two real gaps are as the evaluator described. The binding is unverified: the
fixture's key union across all 36 cases is exactly `{label, text, ids}` and
`token_golden.rs:14-19` deserialises only those three fields. And the runtime pin
is a caret range: `ai-tokenizer` is `"^1.0.6"` under **`dependencies`** in both
`packages/plugin/package.json:65` and `packages/pi-plugin/package.json:45`, so a
consumer installing a published package resolves any `1.x` and the lockfile does
not travel with it.

A third fact surfaced while verifying and is queued as an open question: the
generator's own doc comment calls `ai-tokenizer` "a DEV-only dependency", which
contradicts both package manifests. Either the caret range is the bug or the
comment is.

## Fault-map correction, verified independently

The fault map's F1 row claimed that "the three seams that existed to inject a
crash at a commit window (`facade_mutation_abandon_hook`,
`authority_project_resolution_fail_once`,
`authority_seed_resolution_pass_count`) were deleted as orphans and not
replaced". The evaluator called this false. Verified by reading each site at
`80585c48^` and confirming its absence at `80585c48` and at HEAD (`76cd6f41`).
The evaluator is right, and the corrected statement is now in `fault-map.md`
under a dedicated heading:

- `facade_mutation_abandon_hook` was a **pre-commit** callback, invoked inside the
  fenced facade-mutation closure after both `mc_facade_mutation_ledger` writes and
  before `tx.commit()`. Its own comment claimed it simulated "a process abandoning
  the transaction at the crash window", but running pre-commit means the only
  outcome it could produce is a rollback. That is the mid-closure failure case, not
  a crash at or after commit. It was the closest existing fit for
  `failed-fenced-transaction-leaves-no-partial-state`.
- `authority_project_resolution_fail_once` injected a **pre-read** error. The
  one-shot `AtomicBool` returned `McStoreError::Serde` before
  `self.inner.with_conn`, so no connection was opened, no transaction began, and
  no write occurred, on two read-only resolution paths.
- `authority_seed_resolution_pass_count` was **only a counter**, and a dead one:
  never incremented anywhere, read solely by a test getter.

So `80585c48` removed one pre-commit rollback seam, one pre-read error injector on
a read path, and one dead counter. **No commit-window crash seam was deleted,
because none has ever existed in this crate.** The residue of the deletion is
still visible as doubled `#[cfg(any(test, feature = "test-support"))]` attributes
at `lib.rs:4623-4624`, `:4626-4627`, `:4632-4633` and `:4889-4890`, `:4892-4893`,
`:4897-4898`.

This matters because the false claim made F1 look like a regression that could be
undone by restoring three fields. It is not. F1 is unavailable for the reason it
always was: nothing in scope terminates a process, and both surviving
crash-dependent windows lie inside `cortexkit-store` rather than in this crate.

Per crash-dependent record, the seam now required:

| Record | Seam it needs |
| --- | --- |
| acknowledged-commit-survives-process-crash | A real `SIGKILL` between `tx.commit()` returning (`cortexkit-store:230`) and the caller observing `Ok`. No in-process hook can supply it, because the window is inside the dependency and after the commit. Subprocess harness; the power-loss variant needs `dm-flakey` |
| migration-and-its-version-record-commit-together | A kill inside `tx.execute_batch` (`cortexkit-store:369`), between the batch and the version insert (`:375-380`). No seam exists in either crate, and the runner is out-of-repo, so this is a subprocess kill or a new hook in a sibling repository |
| failed-fenced-transaction-leaves-no-partial-state | None. A late SQL error in the closure suffices. The deleted `facade_mutation_abandon_hook` was the closest fit and would be a convenience, not a requirement |
| post-migration-open-repair-is-resumable-and-effect-idempotent | None. Committed-prefix fixtures replace the kill |
| intent-staged-replay-produces-one-context-effect | No crash seam. A persisted `staged` row is the post-crash state. F10 remains and is now the only blocker |

The surviving seams at HEAD, for the record: `abandon_historian_hook`
(`lib.rs:9246-9254`, inside the fenced abandon transaction after the predicate
read and before the meta write), `before_max_compartment_end_read_hook`
(`:5283`), `historian_side_channel_fail_once` (`:9666-9678`, before any write),
`tag_number_query_count`, and `authority_seed_transaction_count`.

## Gaps queued for a follow-up pass

Recorded, not mined. Each carries the evidence that makes it a gap rather than a
preference.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **Bounded liveness is entirely absent.** No record in the part is `Type: liveness`, yet four mechanisms make progress or fixpoint claims: `repair_note_artifacts_v51`'s `loop` (`lib.rs:5097-5103`) terminates only when a batch returns fewer than `NOTE_ARTIFACT_REPAIR_BATCH` rows, so a row that cannot be repaired is an unbounded loop across boots; `prune_transform_session_roots` (`:4906`) and the retention prunes have no stated bound; the migration path re-runs the whole bootstrap after any crash; and the two CAS loops are bounded at 8 attempts with no backoff (`:6735`, `:6762`), which METHOD.md's liveness rule wants expressed as an explicit attempt bound rather than left implicit in an error. The 8-attempt bound is currently recorded as a safety clause inside `bounded-cas-retry-never-duplicates-an-effect`, not as a progress claim. All four need a bounded fault-free window: stop the pressure, poll to a stated bound, then assert the fixpoint. |
| G2 | **Situation coverage is absent, though the fault map already designed the markers.** 0 `sometimes` records across 37. `fault-map.md` specifies 19 coverage checks with names, witnessed situations, and safety arguments, and every one of them is a `sometimes` obligation sitting in the harness section rather than in the catalog. This is the same finding Part 1 and Part 2a both drew. The markers exist; only their promotion to records is missing. |
| G3 | **No property rejects a recorded schema version above the ceiling of 57.** Verified the hole end to end: `LATEST_MIGRATION_VERSION` computes 57 from `MIGRATIONS` (`lib.rs:1321-1331`), `OLDEST_ADOPTABLE_MIGRATION_VERSION` aliases it (`:1342`), and `refuse_pre_cutover_store` refuses only `recorded < 57` (`:1377-1379`), so a store recorded at 58 falls into `_ => Ok(())` at `:1383`, `inner.migrate` at `:4874` is a no-op, and an older binary operates on a newer schema. The seeding mechanism already exists at `:16113` and constructs `1..57` only. The version-zero clause moved out of R5 belongs here too: `recorded_mc_cache_version` maps a recorded `0` to `None` (`:1364`), so a store with a literal `0` version row is treated as pristine. Both are `refuse_pre_cutover_store` classification questions. The only newer-schema refusal in the system is on the TypeScript side. |
| G4 | **Retention, eviction, deletion, and relational conservation have no group at all.** Verified the shape: the bootstrap declares 42 tables but only 2 `REFERENCES` clauses and 2 `ON DELETE` clauses, so cross-table conservation is almost entirely undeclared even with `foreign_keys = ON`. `delete_session` (`:5432-5476`) compensates at runtime by enumerating `sqlite_master`, probing each table with `PRAGMA table_info` for a `session_id` column, and issuing a per-table `DELETE` — 83 `session_id` mentions in the bootstrap, no cascade. Nothing in the catalog states that a deleted session leaves no orphan, that a capped table stays at its cap, or that a prune removes only what it should. The fault map already names the tied-millisecond whole-group prune defect and the two 256-row pass-scheduler caps at `:411-412` as unaudited. |
| G5 | **The mirror restart-seed contract has no shared cross-language oracle.** `tests/claim_mirror.rs:461-479` pins byte-identical-reseed idempotence on the Rust side only. The snapshot is produced by a TypeScript host, and the stamping rule that decides whether two snapshots are byte-identical is implemented twice with no shared fixture. F10 in the fault map names this; no record covers it. Related to but distinct from `core-canonical-encoding-crossruntime-parity`, which covers the encoder rather than the snapshot-equality rule built on it. |

## Biases requiring human judgment

1. **The out-of-repo `cortexkit-store` evidence is unpinned, so its line
   references are not reproducible.** `Cargo.toml:16` resolves it by *path* to
   `../commons/crates/cortexkit-store`, with a comment saying "not yet published;
   pin a published version at first release". I re-verified every
   `cortexkit-store:NNN` reference the catalog relies on — `:191` the
   `Immediate` behaviour, `:229-231` the early return and commit, `:287`/`:289`/
   `:291` the three PRAGMAs, `:341-357` the version table and `MAX(version)` read,
   `:366`/`:381` the DEFERRED migration transaction, `:691-712` the rollback test
   — and all of them are correct against the sibling's current checkout, which is
   at `d2208ed`. But nothing binds them: the sibling can move independently of
   this repository, and CI replaces it with metadata-only stubs, so neither a
   reviewer nor a test can reproduce these citations from this repository alone.
   *Judgment required:* either pin the sibling (a published version, a submodule,
   or a recorded commit in `README.md`) or downgrade every cross-repo citation to
   an unverifiable claim. Roughly a third of Group A and all of Group B's
   transaction mechanics rest on these lines. A concrete instance of the same
   class showed up during this pass: the catalog's `ci.yml` references (`:456`,
   `:479`, `:482`, `:483-484`) are exactly right against the committed HEAD
   `76cd6f41` but off by eight against the working tree, which carries an
   uncommitted `+9`-line edit to that file. Verified the committed values and left
   them unchanged. Line references are only as stable as the tree they name.

2. **Whether "no CI job runs any test in this scope" is portfolio-readiness
   evidence or a separate delivery gate.** The underlying fact holds and I
   re-verified it at both the committed HEAD and the working tree: grepping
   `mc-store`, `mc-core`, and `mc-tokenizer` across all five workflow files
   returns exactly five hits, all in `ci.yml`, all in one job, and the only
   command is `cargo check -p mc-core --no-default-features`, which compiles
   nothing testable. The test jobs that do exist run `-p mc-host`,
   `-p mc-module --test lifecycle_cli`, and the `mc-shm-*` crates. The
   evaluator's position is that the catalog **overstates** its significance: C0
   is ranked the single highest-leverage item in `fault-map.md` and stated to
   block everything below it, and the Product context section says a green CI run
   "says almost nothing about this scope". But C0 unblocks zero records by the
   fault map's own accounting, and property discovery is not gated on CI
   execution — the properties are true or false regardless of who runs them.
   *Judgment required:* decide whether C0 stays inside this portfolio as a
   record-adjacent capability or moves to a delivery gate owned outside it. If it
   stays, the ranking's claim that "nothing else on this list matters until this
   is done" should be softened, because it is an argument about value realisation
   rather than about property validity.

3. **Whether this catalog is a risk-selected slice or owes representative
   coverage of the full production monolith.** `crates/mc-store/src/lib.rs` is
   20,650 lines with production ending at 13,930 (verified), and the part also
   covers `claim_mirror.rs` at 1,152, `sqlite_runtime.rs` at 185, `mc-core` at
   1,518, and `mc-tokenizer` at 85. The 37 records concentrate heavily: Groups A
   and B cover the open path and three transaction primitives, Groups C and D the
   claim mirror and intent ledger, Groups E through G a few thousand lines of
   pure functions. Large regions of production `lib.rs` have no record at all —
   the historian publish and outbox machinery (`:9194-9798`), the note-evaluation
   claim lifecycle (`:13160-13707`), the drop-seed and strip-seed materializers
   (`:4636-4808`), and most of the DTO and state layer. G4's absence is one
   symptom of this. *Judgment required:* state the selection principle. If it is
   risk-selected, say so explicitly and name what was deliberately excluded, so a
   later reader does not mistake silence for a clean bill. If representative
   coverage is owed, the part needs several more discovery passes and the current
   record count is misleading as a completeness signal.

## Verdict

The evaluator's verdict was **"not ready" pending these corrections**. After
applying the six refinements and the fault-map correction, the honest answer is
still not ready, for a narrower and better-understood reason than before.

What improved concretely: three records moved off expensive fault infrastructure
onto oracles available today, taking the non-vacuous count from 22 to 25 of 37 and
F1's record count from 4 to 2; seven check-semantics lines now state a rationale
that survives reading the code; one record that held two contradictory claims is
two records; three unobservable claims are narrowed to what a workload can
actually assert; and a false statement about deleted crash seams — which had been
inflating the perceived cost of the most expensive capability in the part — is
corrected with per-site evidence.

Ready now for test implementation: the pure-function sweeps in `mc-core` (ranking
item 2, nine records, two with measured contradictions already waiting), the three
reachability assertions on the unwired `sqlite_runtime` and pragma sites (item 3,
all three expected to fail, which is the point), and the late-SQL-error and
persisted-prefix work promoted to item 4. None needs new infrastructure.

Not ready: the five queued gaps, of which G1 and G2 are whole missing categories
rather than additions inside existing ones; the records blocked on a normative
decision, which the fault map already lists separately; the two records that still
require a real process termination inside a sibling repository; and the two
blocked on F10, where the oracle is a design question about who owns a
cross-language contract rather than a harness gap. Handing any of those to test
implementation would encode a guess about intended behaviour.

The three biases are the reason the verdict cannot be upgraded by more of the same
work. Bias 1 decides whether a third of Group A's evidence is citable at all; bias
3 decides whether 37 records is most of the answer or a small fraction of it.
Neither is resolvable inside this pass.

## What this evaluation says about the method

Part 2a's evaluation produced seven refutations of asserted facts. Part 3's
produced two, both against the fault map rather than the catalog, and both of the
same kind: a claim about *what a test seam was for*, asserted from the seam's name
and its own comment rather than from its position in the control flow.
`facade_mutation_abandon_hook`'s comment says "crash window", and the fault map
believed it. Reading five lines further would have shown the hook runs before
`tx.commit()`, which makes rollback its only possible outcome.

The lesson is narrower than Part 2a's and worth stating separately: METHOD.md's
rule 3 already says a documented guarantee is a claim under test, but it is
written about product documentation. It applies with equal force to comments on
test infrastructure, and to a fault map's own prose about deleted code, where
nobody is looking for a contract violation. A deleted seam is the easiest thing in
a repository to describe wrongly, because the description outlives the code that
would refute it.

Second, smaller lesson. Two of the six refinements were premise-corrections rather
than clean acceptances: the evaluator said the tokenizer generator names a version
(it does not; the lockfile does) and framed the schema-inventory contract as
merely applying "mainly to a different database file" (it applies *only* to one,
and the record's cited helper cannot perform the comparison it was credited with).
Both corrections made the finding stronger, not weaker. An independent evaluator
being imprecise about a mechanism it is right about is the expected shape, and
verifying before applying is what catches it.

## Re-evaluation trigger

A fresh pass is warranted once G1 or G2 is mined, because each adds a whole
category: G1 would introduce the part's first `liveness` records, and G2 would
introduce its first `sometimes` records, changing the semantics distribution rather
than adding inside it. The corrections above do not warrant one; they narrowed and
repaired records and moved cost around the fault map without changing the
portfolio's shape.

Two other triggers, either of which fires independently:

- Any resolution of bias 3 that declares representative coverage owed. That
  redefines the scope and makes the current 37 records a baseline rather than a
  portfolio.
- Any change to `cortexkit-store` at the sibling path, since Groups A and B rest
  on line references into a repository this one does not pin. A sibling commit
  invalidates evidence here silently, with no signal in this tree at all. Until
  bias 1 is resolved, treat every `cortexkit-store:NNN` citation as needing
  re-verification at the start of any follow-up pass.
