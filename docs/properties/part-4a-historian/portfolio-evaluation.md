# Part 4a portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. It produced 14
findings, and an unusual share of them are refutations of this part's own claims
rather than additions to them: it refuted the fault map's availability verdict on
two of the eight fault classes, refuted the catalog's central unresolved question,
refuted one record's premise outright, and showed that two records' checks could
not detect the thing the record described.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

Every correction below was re-verified against the code before acceptance. **All
nine refinements were accepted and applied; none was rejected.** The evaluator was
substantially right in every case and imprecise in three, all recorded, plus one
case where the finding was already latent in the catalog's own prose and the
catalog simply contradicted itself.

Provenance for this pass. `HEAD` is `e447c927`
("refactor(shm): trim final review leftovers"). The task framing named `b5dc778e`
as HEAD; that commit is `HEAD~1`, and
`git diff b5dc778e e447c927 -- crates/mc-module/` is empty, as is
`git diff 76cd6f41 e447c927 -- crates/mc-module/`, so every `mc-module` line
reference in this part resolves identically at all three commits and the earlier
artifacts' `76cd6f41` provenance still holds. `crates/mc-store` is likewise
unchanged. Line references outside those crates, into `packages/cli` and the
sibling `../commons/crates/cortexkit-store`, were read at `e447c927` and at the
sibling's current checkout and carry the same reproducibility caveat Part 3
recorded as its bias 1.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 9 | 9 applied, 3 with a corrected premise |
| gap | 5 | queued for a follow-up pass |
| bias | 2 | require human judgment |

Record count 24 to **25**, from the atomicity split (R5).

Semantics distribution 16 `always`, 7 `always-or-unreached`, 1 `sometimes`, 0
`reachable`, 1 `unreachable`, against 21/1/0/1/1 before. Types 22 safety, 2
liveness, 1 reachability.

Reachability distribution **25 `default-production`**, 0 `explicit-config-only`, 0
`test-only`, against a disputed 12/12 split before (R1).

Corrected in-crate test count **141**, against 121 before (R3). With the 7
store-side publish tests, 148 test functions are unprotected by CI.

Fault-map totals 22 non-vacuous today, 2 partial, 1 no, against 19/4/1 before.

## Refinements applied

### R1. The reachability disagreement is resolved in favour of `default-production`

Applied in `catalog.md`, replacing the "Unresolved: is the historian reachable by
default?" subsection with "Resolved: the historian is reachable by default", and
relabelling the 12 `explicit-config-only` records. `fault-map.md`'s per-section
preamble is updated to match.

The catalog had declared this a product question that only a human could settle.
It was not. It was answerable from the shipped setup code, and the evaluator
answered it. Verified for this disposition:

- A bare `McModuleConfig::default()` genuinely has no models
  (`config.rs:118-123`, `model_chain: Vec::new()` at `:121`), and the chain is
  populated only from the four user config pointers (`config.rs:390-428`). The
  pipeline lens's evidence was correct.
- `pickModel` cannot yield an empty model
  (`packages/cli/src/lib/model-picker.ts:71-91`): with a non-empty catalog it goes
  to `selectAutocomplete` (`:89-91`), and with an empty one it falls back to free
  text whose `validate` rejects a blank value (`:82-87`).
- Both setup paths call it unconditionally for the historian role and carry the
  result into the written config: `setup-opencode.ts:445` then `:545-553`, and
  `setup-pi.ts:403` then `:471-481`. `writeMagicContextConfig` writes it to the
  `/historian/model` pointer `config.rs:411` reads (`setup-pi.ts:242-246`).

The decisive argument is the one the catalog had not made: absence of a completed
setup is not explicit opt-in. `explicit-config-only` means the user must take a
deliberate step to turn the behaviour on. Here the deliberate step turns it on and
no step turns it off, because the historian model is a required answer mid-setup
rather than a prompt the user can decline.

**Premise correction 1.** The evaluator treated the two setup legs as equivalent.
They reach the same guarantee by different routes, and one is weaker.
`setup-pi.ts:219` declares `historianModel: string`, so its write at `:242-246` is
unconditional and the guarantee is in the signature. `setup-opencode.ts:237`
declares `string | null` and guards the write with `if (options.historianModel)`
(`:256-260`), so that leg's guarantee lives in its call site: the only caller
passes the `pickModel` result, which cannot be blank. The guard is never false
today, but a future caller could pass `null` past it. Recorded in the catalog.

The consequence is the part's real headline and is now stated plainly in the
catalog: **every finding in this part is live rather than latent.** The label split
was the only thing suggesting these were defects awaiting a user opt-in. On any
machine where setup completed, the gate omissions in Groups E through H, the
billable-run asymmetry in Group C, and the commit-point widening in Group A are
reachable on ordinary production traffic.

### R2. Five check-semantics corrections

Applied in `catalog.md`, each with a rationale on the `Check:` line as METHOD.md
requires.

`hv-degenerate-body-passes-content-gate` moves from `reachable` to `sometimes`.
METHOD.md's rule is that `reachable` is location coverage and `sometimes` is
situation coverage, and this record was on the wrong side of it: the location it
named is reached by every publish, so the check could not fail. What must be
witnessed is the operational state, a near-empty body over a long span, which a
campaign can miss while executing those lines constantly.

**Premise correction 2**, found while verifying that one. The cited location was
wrong twice over. `historian.rs:1738` is inside `abandon_current_state`'s
signature, and the secondary citation `:471-475` is the events projection. The
only production `to_stored_compartment` call is `historian.rs:466`, inside
`publish_validated_chunk` (`:444`); the other two occurrences are in tests
(`:1888`, `:1892`). Corrected in the record, and it strengthens the finding: the
call sits inside a `.map` over every accepted compartment, which is exactly why
location coverage proves nothing here.

Four records move from `always` to `always-or-unreached`, because each one's
antecedent is a conditional the campaign may never produce. This is the same
correction Part 3's evaluation made six times, and the same rationale:

| Record | Antecedent that makes it conditional |
| --- | --- |
| `reattach-publishes-a-chunk-recomputed-after-the-model-ran` | Only a reattach publish |
| `hv-heal-extends-range-without-revalidating-content` | Only a compartment whose `end_message` was healed |
| `hv-single-compartment-skips-lookahead-discard` | Only a chunk whose narrative ends within `BOUNDARY_HEALING_SLACK` of the chunk end |
| `hv-side-channel-anchor-out-of-range-drops-silently` | Only an item carrying an out-of-range anchor |

### R3. The test count is 141, not 121

Corrected throughout all three artifacts. The five per-file figures were each
re-verified at HEAD by counting `#[test]`, `#[tokio::test]`, and
`#[tokio::test(...)]` attributes, and all five are right: 51 in `historian.rs`, 19
in `historian_validate.rs`, 19 in `historian_chunk.rs`, 18 in
`historian_producer.rs`, 34 in `lib.rs`. The total is not. 51 + 19 + 19 + 18 + 34
is 141.

This was an arithmetic slip, not a miscount, and it propagated to every place the
figure appeared, including the leverage ranking's claim to protect "128 existing
test functions", which is 141 + 7 = **148**. The error understated the size of the
unprotected suite by twenty tests in the one part whose headline finding is that
none of the suite runs.

### R4. The billable-run oracle is re-specified per drive

Applied in `catalog.md`. The record
`uncertain-producer-start-authorizes-a-second-billable-run` specified accounting
"per `firing_seq`". That oracle **cannot detect the duplicate the record
describes**, because the two runs do not share a firing sequence: on a start
failure classified `try_next_model`, the loop `continue`s
(`historian.rs:1318-1321`) back to `:1256` and calls `fire` again (`:1265-1274`),
and `fire` increments the sequence unconditionally
(`:257`, `current.firing_seq.saturating_add(1)`). A per-firing oracle sees one
start under each sequence and passes.

The check is now stated per `run_historian_firing` call, summing `attempted` and
`acknowledged` across every iteration of the model loop, with the counter at the
fake, which spans the whole loop. The old `acknowledged <= 1` clause is replaced by
`attempted - acknowledged <= 1`.

This is the one finding that was already latent in the artifact. The record's own
`Impact:` line said "the second attempt fires under a new `firing_seq`
(`historian.rs:257`)". The record contradicted itself across two adjacent fields,
and the evaluator was the first reader to notice. Worth naming as a method lesson:
a record's fields are cross-checked by nobody unless someone reads them as one
argument.

### R5. Publish atomicity is implementable, and the record is split

Applied in `catalog.md` as two records, with the availability claim corrected in
`fault-map.md` (H4 row, map rows, leverage ranking) and in `existing-checks.md`
(seams section, quiet area 4).

`publish-transaction-is-the-single-commit-point` becomes:

- `publish-transaction-rolls-back-every-write-on-a-late-sql-error` —
  **constructible today, no seam required.**
- `publish-transaction-survives-process-death-as-all-or-nothing` — still
  unavailable, needs a subprocess kill harness.

Three artifacts had asserted that the atomicity claim was "currently unfalsifiable
by a Rust test" and that H4 had "no seam of any shape". That is true of a kill and
false of an error, and the mechanism is the closure's own error propagation:
`with_conn_fenced` evaluates `let out = f(&tx).map_err(...)?;` and reaches
`tx.commit()` only on `Ok`
(`../commons/crates/cortexkit-store/src/lib.rs:229-231`). The closure's last write,
the `mc_cache_state` UPDATE at `mc-store:9496-9500`, uses a bare `?`, and it runs
after `append_compartments_tx` (`:9457-9471`), `insert_chunk_transcripts_tx`
(`:9472-9481`), and `enqueue_historian_side_channels_tx` (`:9482`) have already
applied. So a main-schema `BEFORE UPDATE ON mc_cache_state` trigger raising `ABORT`
forces exactly the partial-write rollback the property is about.

The technique needs nothing new either: the abandon-hook test at `mc-store:16688`
already extracts the SQLite path from the descriptor (`:16691-16694`) and opens a
second raw `rusqlite::Connection` to it (`:16704`), and a trigger created there
lives in the main schema and fires for the store's own transaction.

**Premise correction 3.** The evaluator described the six writes as six statements.
Only four are statements: the floor raise (`mc-store:9484-9488`) and the phase reset
(`:9489`) are in-memory mutations of `meta`, serialized into the single
`mc_cache_state` UPDATE. This does not weaken the finding, it sharpens it, because
it means the trigger fires on the statement that carries two of the six writes, with
the other three already applied. Recorded in the record's `Fault/timing angle`.

One open question was added rather than resolved: the outcome-level rejections
return `Ok(PublishTxnOutcome::...)` and therefore **do** commit. Whether any
rejection arm reached after a write has already applied can commit a partial write
is not established here, and the arms at `mc-store:9465-9469` and `:9492-9494` both
sit after `append_compartments_tx`. That needs a targeted read of each post-write
return.

### R6. H8's clock claim is wrong; clock control exists and is already exercised

Corrected in `fault-map.md` (H8 row, two map rows, leverage item 8) and in
`existing-checks.md`'s seams section, with both affected records updated in
`catalog.md`.

H8 said "No seam found in this pass" and concluded that neither liveness record
could be made non-vacuous. Both mechanisms exist, and both are already driven by
existing tests:

- **Wrapup budget.** `wrapup_operation_budget` (`lib.rs:5445-5457`) consults a
  `#[cfg(test)]` override before falling back to the constant. The field is at
  `:2915`, initialised at `:3445` and `:3747`. The test
  `wrapup_budget_bounds_busy_join_without_double_drive` (`:29236`) sets it to 40 ms
  at `:29245-29248`, asserts the `budget_exhausted` disposition, and restores it at
  `:29273-29276`. The 3800-second budget never has to be waited out.
- **Backoff expiry.** The cooldown gate compares the durable
  `failure_backoff_at_ms` against a caller-supplied `now` (`lib.rs:5042-5047`),
  with `now` arriving through `HistorianPrepareContext` into
  `prepare_historian_fire` (`:4808-4821`) rather than being read inside the gate.
  The helper `expire_historian_backoff` (`:29784-29791`) expires it by committing
  `Some(now_ms() - 1)`, and
  `assert_seeded_phase_recovers_then_refires_after_backoff` (`:29793`) drives a
  refire through it. N attempts cost no wall clock.

Both records moved from `Partial` to `Yes`.

**One limit recorded against the evaluator's framing**, so this is not overread.
There is no *global* clock injection. The transform entry point reads the real
clock at `pass_now = now_ms()` (`lib.rs:8206`) and passes that value down, so the
capability is "expire a durable field" and "override a budget", not "advance time".
Neither record needs more than that, but a property that depended on `now` itself
advancing would still have no seam, and H8 now says so.

### R7. Over-costed records rerouted off producer runs

Applied in `fault-map.md`. The validator is explicitly pure — the module doc says
so (`historian_validate.rs:5-9`) and the signature confirms it, taking only `text`,
`chunk`, `prior_compartments`, and `options` with no store, clock, filesystem, or
environment access (`:450-455`). Every record in the "what the gate does not check"
section had nonetheless been routed through a full producer run. The cheapest valid
oracle for all of them is a direct function call on a hand-built chunk plus a
hostile output string, and the section now says so, with the `H1` tags retained to
name the vector rather than to require a producer. Leverage item 4 is rescoped to
match.

Two pipeline records were over-costed the same way and are rerouted:

- `publish-fence-rejects-selected-content-drift` was routed to H5, a live store
  mutation during the await. The store-side gates are predicate comparisons
  (`mc-store:9413-9425`), so the outcome is equally reachable by **seeding** a
  mismatching predicate with no interleaving, and the untested empty-vector arm
  (`:9413-9417`) needs only a predicate carrying an empty vector.
- `historian-single-flight-admits-one-publish-per-firing` was routed to a
  concurrent interleaving. Because all five predicate fields plus the row-version
  CAS are compared inside the transaction (`mc-store:9373-9407`), the second
  publisher's rejection is reachable **sequentially**: publish once, then re-drive
  the same now-stale request. A genuine concurrent interleaving remains unavailable
  and is not required for the outcome.

### R8. An unexecutable check is replaced with a concrete oracle

Applied in `catalog.md` and in `fault-map.md`'s row for the record.
`hv-output-not-bound-to-chunk-identity` required that "at least one accepted field
carries a value derivable only from the pinned chunk's content (a nonce echo, a
chunk digest, or a quoted anchor)". No test can execute that: it names no
derivation, so nothing decides whether a given field satisfies it, and it presumes
the remedy instead of stating the property.

The replacement is decidable. Build a chunk from conversation A; call
`validate_historian_output` with an output fixture from unrelated conversation B
whose compartment ranges are renumbered contiguous over
`A.chunk.start_index..=A.chunk.end_index` with `<unprocessed_from>` equal to
`A.chunk.end_index + 1`; assert `Err`. It returns `Ok` today, so the check fails on
the current implementation, which is the finding. It is a direct call, per R7.

### R9. A false premise is removed from the reattach record

Applied in `catalog.md`, in the record and in the relationship map's composed
scenario. `reattach-publishes-a-chunk-recomputed-after-the-model-ran` assumed the
recomputed chunk could extend past the pinned end, and built its `Fault/timing
angle`, its `Impact`, and the part's headline composed scenario on that. **It
cannot.** The reattach passes `range.to_ordinal.saturating_add(1)` as the exclusive
`eligible_end_ordinal` (`lib.rs:4696-4702`), and the builder admits no message at or
beyond it: the start scan filters `message.ordinal < eligible_end_ordinal`
(`historian_chunk.rs:373-375`) and the body loop `continue`s on
`message.ordinal >= eligible_end_ordinal` (`:383-386`). The raw payload is filtered
by the resulting `chunk.chunk.start_index` and `end_index` (`lib.rs:4714-4718`), so
it cannot be a superset either.

Restated as same-bound recomputation: the upper bound is pinned, but the messages
inside it are re-read from the later projection, and the range can end up
*narrower* if the token budget truncates differently. The identity fence
(`mc-store:9418-9425`) rejects an equal-length content edit inside the range, so the
residual claim under test is narrower than the original record implied.

Two consequences carried through. The record's `Confidence` rises from medium to
high, because the question its old line said "needs a test, not more reading" was
answerable by reading, and the index table is updated. And the relationship map's
composed four-mechanism scenario, described as "the one place in the part where the
records genuinely compose into a scenario nobody has constructed", loses its
coverage-widening component and is restated as a correspondence risk.

## Gaps queued for a follow-up pass

Recorded, not mined. Each carries the evidence that makes it a gap rather than a
preference.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **Producer failure modes have tests but no records.** The catalog covers what the producer *returns* and never what it does when it fails. Three distinct failure paths carry real recovery logic and no property: the output timeout at `historian.rs:1340-1367`, which attempts a `redrain_output` and, on its failure, cancels, abandons with a backoff, and closes; malformed or undocumented run status at `historian_producer.rs:1288-1313`, which rejects a `run.status` answered for the wrong `run_id` (`:1291-1295`), an absent state string (`:1296-1300`), and an undocumented state (`:1311-1313`); and partial or interleaved stream drain at `:1213-1269`, which filters units by `run_id` (`:1229-1231`) and turns a paused unit into a typed `RunPaused` error (`:1232-1240`). `historian_producer.rs`'s 18 tests exercise parts of this, including the closed-vocabulary test at `:2175`, so the gap is catalog coverage rather than test coverage. Note the interaction with R4: the timeout path also reaches `decide_producer_failure`, so a fourth billable-run question lives here. |
| G2 | **Token and monetary accounting is absent from the whole part.** `ProducerOutput` carries exactly two fields, `text: String` and `length_capped: bool` (`historian_producer.rs:190-194`). Nothing in the subsystem records input tokens, output tokens, model, or cost for a firing, so there is no quantity against which a duplicate-spend property could assert anything. This is why `uncertain-producer-start-authorizes-a-second-billable-run` has to count runs at the fake rather than observe spend in the system, and why "duplicate spend" is currently an inference from a run count rather than a measurement. A record on accounting completeness needs a decision about whether the module should carry usage at all. |
| G3 | **Input-content selection is uncataloged, and it decides what the model is asked to summarize.** The catalog covers the chunk's *ordinal* contract thoroughly and its *content* contract not at all. `historian_chunk.rs:352-450` is the selection core: the non-synthetic filter and exclusive-bound scan (`:365-386`), the system-role pinning that records content as metadata-only (`:391-395`), and the token-budget admission that decides where the chunk stops. `:611-727` is the identity and capture half: per-message block-identity collection with a `MissingBlockIdentity` refusal (`:706-714`) and the `raw_chunk_messages` serialization (`:717-727`) that every recoverability property in Group B depends on. `existing-checks.md`'s quiet area 10 already names the two golden fixtures (`:1962`, `:2045`) as the only guard here, so a change to what is captured fails a fixture rather than an invariant. R9 makes this more urgent, not less: the reattach rebuild runs this same code on a later projection. |
| G4 | **Re-foldability after transcript loss is uncataloged.** Group B proves the raw copy is *written* and never *evicted*, and `existing-checks.md`'s own sampling limits admit that nothing verifies it is *served*. The read path exists and is reachable: `lib.rs:10793-10812` handles a single-message expand, calling `durable_expand_messages` and falling back to a transcript render, with an explicit "no longer recoverable from persisted chunk transcripts" answer at `:10804-10809`; `durable_expand_messages` (`:14676-14700`) decodes `raw_messages_json`, silently `continue`s past an absent payload (`:14684-14686`) and past a JSON parse failure (`:14687-14690`), and bounds each message to the transcript's own ordinal range (`:14695`). Two of those three silent skips would turn a corrupt raw payload into a missing message with no signal. Both cited regions sit outside the `lib.rs` line ranges this part scoped, which is why the gap exists. |
| G5 | **No executing Rust-versus-TypeScript differential property exists, despite a frozen corpus being available.** This is the part's sharpest coverage finding and it has no record. Five in-crate test names assert TypeScript parity by construction, including `validate_golden_matches_typescript_oracle` (`historian_validate.rs:1384`), and none runs in CI. The TypeScript mutation battery does run on every pull request (`ci.yml:432` at `HEAD`) over a frozen corpus with pinned per-class stages (`mutations.ts:33-56`), and the lane's own README calls that corpus the best TS-to-Rust validator differential vector set the repo has, with reuse deferred. `fault-map.md` ranks joining them second by leverage and lists a coverage marker for it, but the catalog carries no property asserting that the two implementations agree. Ten of the gate's 22 rejecting checks have no test at any level, and a differential oracle is the only mechanism in sight that covers checks nobody wrote a case for. |

## Biases requiring human judgment

1. **Whether this catalog is a risk-selected slice or owes representative coverage
   of the subsystem.** The 24-record portfolio arrived as an exact 12-plus-12 split
   between the two record-proposing lenses, and that symmetry is a fact about how
   the work was divided, not about where the risk is. It reflects lens effort:
   each lens produced twelve records because each lens was one pass. The scope is
   about 13.5k lines across five files (`historian.rs` 4,682,
   `historian_producer.rs` 2,306, `historian_chunk.rs` 2,051,
   `historian_validate.rs` 1,869, plus two `lib.rs` regions), and the records
   concentrate on the publish transaction, the gate's omissions, and the floor.
   Whole mechanisms have no record at all, and four of the five queued gaps are
   symptoms of that rather than independent findings: producer failure handling
   (G1), chunk content selection (G3), the durable read path (G4), and
   cross-language agreement (G5). *Judgment required:* state the selection
   principle. If this is risk-selected, say so explicitly and name what was
   deliberately excluded, so a later reader does not mistake silence for a clean
   bill. If representative coverage is owed, 25 records is a baseline rather than a
   portfolio and the part needs several more discovery passes. Note that R1 raises
   the stakes on this decision: every record here is now `default-production`, so
   the unexamined regions are unexamined production code, not unexamined
   opt-in code.

2. **The durable raw-recovery claim is the reason this subsystem is not
   catastrophic, and no property proves it end to end.** This is the evaluator's
   judgment and it is the most important thing in this evaluation. The entire
   consequence framing of Part 4a rests on the substitution being *additive*: the
   catalog's own "Why this part matters" section argues that because
   `raw_chunk_messages` is written in the same transaction (`mc-store:9472-9481`)
   and never reclaimed by eviction (`:12748-12756`, under the comment "Full message
   recovery is durable by contract"), a wrong summary is a wrong-context failure
   rather than data destruction. Every record in Groups E through H is scoped by
   that argument. But the portfolio contains no property that closes the loop:
   publish, restart, blank the transcript so only the raw payload remains, then
   expand and assert the exact original messages come back. Group B proves the
   write and the retention; G4 records that the read path is uncataloged; and the
   two halves have never been joined in one test. *Judgment required:* decide
   whether that end-to-end property is owed before this part is handed to test
   implementation. If the recoverability claim is load-bearing for the severity of
   twelve other records, an unproven recoverability claim is not a gap of the same
   kind as the others, and the part's whole consequence model is resting on it.

## Verdict

The evaluator's verdict was **"not ready for full handoff" pending these
corrections**. After applying all nine refinements, the honest answer is still not
ready, and the reason has changed shape rather than shrunk.

What improved concretely. The part's reachability question is answered rather than
deferred, and the answer is the more serious of the two candidates: 25 of 25
records are `default-production` and every finding is live. Three availability
claims that had made the part look more expensive than it is are corrected, taking
the non-vacuous count from 19 of 24 to 22 of 25 and leaving exactly one record
blocked on infrastructure. Two records whose checks could not detect what they
described are re-specified. One record's central premise is withdrawn as false. One
unexecutable check is now a concrete failing test somebody can write this week. And
a twenty-test arithmetic error is corrected in the one part whose headline is that
none of its tests run.

Ready now for test implementation: the pure-function gate sweeps rerouted by R7,
where `hv-unescape-xml-double-decodes-entities` has a measured contradiction already
waiting; the R8 unrelated-conversation fixture, which is a direct call and is
expected to fail, which is the point; the R5 SQL-error rollback record, which needs
a trigger and a fixture and no new mechanism; and the two R6 liveness records, whose
seams turn out to be already in use by existing tests.

Not ready, for four reasons that no further work of this kind resolves. The five
queued gaps include two whole missing categories, producer failure handling (G1) and
cross-language agreement (G5), and one that undercuts the part's severity model
(G4). Bias 2 is the sharpest of these: the argument that makes this subsystem
survivable has no end-to-end property, and until someone decides whether that
property is owed, twelve records' impact statements rest on an untested premise.
Bias 1 decides whether 25 records is most of the answer or a fraction of it. And the
eight product decisions `fault-map.md` lists separately are unchanged by this pass;
handing any record that depends on one to test implementation would encode a guess
about intended behaviour.

One process caveat on the verification step, stated rather than hidden. METHOD.md's
step 7 requires records to equal index rows to equal evidence files. Records and
index rows both equal 25. Evidence files remain at 24, because this disposition was
scoped to the three artifacts and explicitly forbidden from touching `evidence/`.
Both records produced by the R5 split point at the original
`evidence/publish-transaction-is-the-single-commit-point.md`, and the
`reattach-...` evidence file still carries the superset framing R9 withdrew. Three
evidence files therefore need a follow-up pass before the mechanical check passes:
a split of the atomicity evidence into two, and a rewrite of the reattach evidence.
The catalog says so at each affected `Confidence:` line.

## What this evaluation says about the method

Part 2a's evaluation produced seven refutations of asserted facts, Part 3's produced
two. This one produced four, and three of them share a single failure mode that is
now worth writing into the method rather than rediscovering per part.

**Absence of a named seam was read as absence of the capability.** H4 said there is
"no seam of any shape" for a fault inside the publish transaction, having searched
the transaction body for a hook and found none; the closure's own `?` operator was
the seam all along. H8 said "no seam found in this pass" for clock control, having
searched for a clock abstraction; a `#[cfg(test)]` budget override and a
backoff-expiry helper both existed and were both already being driven by tests. The
gate records were routed through producer runs because a producer double is the
named seam for producer-shaped input, when the function under test takes plain
arguments. In all three cases the question asked was "is there a mechanism built for
this?" and the question that would have been right is "what is the cheapest way to
produce this state?".

The distinct lesson from R4 and R9 is different and smaller. Both are cases where a
record's own fields disagreed with each other or with a cited line, and nobody had
read the record as one argument: R4's `Check:` line specified a unit its own
`Impact:` line explained would not work, and R9's `Fault/timing angle` asserted a
superset the code it cited two lines later forecloses. A record schema with nine
fields invites field-at-a-time authoring and field-at-a-time review. The cheapest
guard is to read each finished record end to end once, as a claim, before it ships.

## Re-evaluation trigger

A fresh pass is warranted once G1 or G5 is mined, because each adds a category
rather than adding inside one: G1 would be the part's first producer-failure group,
and G5 would introduce its first cross-implementation property, whose oracle is a
different kind of thing from every oracle now in the part. The corrections above do
not warrant one; they repaired records, moved cost off the fault map, and resolved a
label, without changing the portfolio's shape.

Three other triggers, each firing independently:

- Any resolution of bias 2 that declares the end-to-end recoverability property
  owed. That property would sit upstream of twelve records' impact statements, and
  if it fails, the part's consequence model changes from "wrong context, recoverable"
  to something considerably worse.
- Any resolution of bias 1 that declares representative coverage owed, which makes
  the current 25 records a baseline.
- Any change to `../commons/crates/cortexkit-store` at the sibling path, which this
  repository resolves by path and does not pin, and which CI replaces with a
  metadata-only stub. R5's implementability argument rests on `:229-231` there. Part
  3's evaluation recorded this as its bias 1 and it is unresolved; treat every
  `cortexkit-store:NNN` citation as needing re-verification at the start of any
  follow-up pass.
