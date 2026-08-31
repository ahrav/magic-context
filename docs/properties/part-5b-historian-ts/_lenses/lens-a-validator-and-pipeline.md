# Part 5b lens A: the TypeScript validator and compartment pipeline as an independent implementation of a shared contract

Attention focus: what this side guarantees, and where it and the Rust side can
disagree. Not the Rust gate's own obligations, which Part 4a owns and this pass
cites rather than re-derives.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md). Scope, file set, and CI facts from
[../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md),
sub-part 5b, 16 units, 11,510 production lines. Every line reference below was
read back at `HEAD`.

**Stability caveat, inherited from the scope map.** `packages/plugin` is
**mixed**, not stable. Two directories were excluded from all of Part 5 as
actively moving, `src/shared/mc-host-client/` (5,944 lines) and
`src/shared/mc-host-lifecycle/` (4,769 lines), together 5.9 percent of the
package. Every file this lens cites sits outside both. `pi-historian-runner.ts`
is in 5b and had zero churn in the last 20 commits.

## The framing that leads

The coverage is real, and that inverts the hazard. `.github/workflows/ci.yml:256-257`
is one step, `bun run test`, executing 482 of 596 test files and 100 percent of
the test files in every package Part 5 scopes. A second job,
`historian-eval-contracts`, adds three deterministic per-PR steps with no
credentials: unit contracts (`ci.yml:433-434`), a corpus freeze lint
(`:436-437`), and the seven-class mutation battery (`:439-440`). So absent
coverage is not the default finding here.

The hazards are **drift against the Rust implementation** and **guards that
exist on one side only**. Part 4a established the asymmetry that makes this
sharp: this TypeScript validator is the only executing coverage adjacent to the
Rust historian, the eval lane's own selection code excludes the Rust leg
deliberately (`run-test-selection.ts:73-76`, cited from Part 4a), and the Rust
gate's 19 tests never run. So this file is simultaneously well-tested and the
reason the Rust side looks covered when it is not.

Three findings dominate what follows.

**1. The Rust parser documents itself as a strict superset of this one, and the
strictness is exactly one envelope check wide.** `historian_validate.rs:261-263`
says it requires "one complete historian output envelope, then use the
TypeScript host parser's permissive extraction semantics for structures inside
that root". The envelope is real: `:267-271` rejects any text that is not wholly
one `<output>` root, anchored `\A`/`\z` by `output_document_regex`
(`:1156-1161`), and `:276-280` rejects a second `<output>` tag in the body.
`parseCompartmentOutput` (`compartment-parser.ts:162-294`) has no counterpart to
either. It scans the whole input with `text.matchAll(COMPARTMENT_REGEX)`
(`:166`, regex at `:59`) and never looks for a root. So the accepted-input sets
differ by construction, and the Rust doc comment is the clearest statement in
the tree that somebody believed the two agreed below that line.

**2. This side's gate is not self-sufficient, and four of the Rust gate's 22
rejecting checks live in its callers instead.** `validateHistorianOutput`
(`compartment-runner-validation.ts:119-183`) takes `_priorCompartments` and
`_sessionId` with leading underscores (`:121`, `:123`) and reads neither. The
prior-state checks Part 4a numbers 4, 5, 6, and 22 are performed, but by
`compartment-runner-incremental.ts`: stored-range validity at `:198-212`,
chunk-start derivation at `:214-217`, chunk coverage at `:384-399`, and forward
progress at `:534-553`. `validateChunkCoverage` and `validateStoredCompartments`
are exported from the validator module (`:250`, `:325`) and imported by four
runners, never by the gate itself. That is a defensible factoring for the two
shipped runners, both of which call all four. It is a hazard for any third
caller, and a third caller already exists: the eval scorer calls
`validateHistorianOutput(rawOutput, RAW_OUTPUT_SESSION_ID, chunk, [], 1)`
(`scorer.ts:715`) with an empty prior array, so the executing mutation battery
drives the gate with none of the four.

**3. Nothing executing anywhere compares the two implementations, and the one
artifact built to compare them is a hand-run snapshot with a structural hole.**
`crates/mc-module/gen/gen-validate-golden.ts` imports the real
`compartment-parser` and `compartment-runner-validation` through
`Bun.resolveSync` (`:17-18`) and writes
`crates/mc-module/testdata/validate-golden.json` (`:662-663`), 16 cases. The
Rust consumer is `validate_golden_matches_typescript_oracle`
(`historian_validate.rs:1384-1387`), which Part 4a establishes never executes.
The generator appears in no workflow, no `package.json` script, and no file
under `scripts/`; its own docstring gives the invocation as a manual command
(`:9`). Two consequences beyond staleness. Its `ChunkJson` carries
`tool_only_ranges` (`:44`) and no completed-tool-arc field at all, so the
golden structurally cannot cover Rust check 21 or either heal path. And it
hardcodes `const BOUNDARY_HEALING_SLACK = 2` (`:38`) rather than importing
`HISTORIAN_BOUNDARY_HEALING_SLACK` (`compartment-runner-validation.ts:11`), so
changing the slack in the plugin leaves the generator silently on the old value.

## Pipeline map

What triggers a run, what validates, what commits, and where the point of no
return is. OpenCode path; the Pi path is the same shape through
`pi-historian-runner.ts` and is noted where it diverges.

**Trigger.** `checkCompartmentTrigger` (`compartment-trigger.ts:417`) runs
inside a transform pass and returns `{ shouldFire: false }` immediately when
`sessionMeta.compartmentInProgress` is set (`:433-441`). On a fire the transform
calls `startCompartmentAgent` (`compartment-runner.ts:111`), which takes three
serialization gates in order: an in-process `activeRuns` map check-then-set
(`:115-118`, justified at `:112-114` by Bun's single-threaded event loop), a
wrapup-marker check (`:120-127`), and a durable cross-process compartment lease
`acquireCompartmentLease` (`:130`) whose loss releases the start intent and
returns (`:131-141`). The lease is renewed on an interval (`:151`, `:89-109`)
against a five-minute TTL (`:102`).

**Model call and validation.** `runCompartmentAgent`
(`compartment-runner-incremental.ts:99`) reads prior compartments (`:194`),
derives `offset` from the last stored end (`:214-217`), resolves and revalidates
the protected-tail boundary snapshot (`:233-289`), reserves drain tokens
(`:330-341`), reads the chunk (`:353`), and runs the four caller-side checks
named above. It then calls `runValidatedHistorianPass`
(`compartment-runner-historian.ts:104`), which is where model output meets the
gate: initial run then `validateHistorianOutput` (`:146-152`), on rejection a
repair prompt (`:168-176`) and a second `validateHistorianOutput` (`:189-195`),
on rejection again `runFallbackHistorianPass` (`:211-215`), which walks a
deduplicated model chain (`:580-586`) validating each candidate (`:623-628`).
With `twoPass` an editor pass may replace an already-valid draft, but only if
the editor's own output validates (`:279-297`).

**Post-gate publication decisions, outside the gate.** Discard-last drops the
provisional final compartment when `shouldDiscardLastHistorianCompartment`
holds and the run is not an emergency (`:515-530`). Forward progress is checked
after that drop (`:534-553`). Events anchored past the persisted count are
filtered (`:616-623`).

**Commit.** `db.exec("BEGIN IMMEDIATE")` at `:637`. The lease holder is
re-checked *inside* the transaction and a lost lease rolls back (`:639-647`).
Then `appendCompartments` (`:648`), durable fact promotion when enabled
(`:663-677`), event insert wrapped in a swallowing `try/catch` (`:683-693`),
`queueDropsForCompartmentalizedMessages` (`:695`), failure-state clears
(`:697-700`), `recordProtectedTailPublicationFloor` (`:704`), emergency-recovery
clear (`:705`), and the deferred compaction-marker blob (`:707-713`).
**`db.exec("COMMIT")` at `:714` is the commit point.** The `finally` at
`:716-724` rolls back every non-committed path.

**After the commit point.** Injection-cache clear (`:729-731`), the publication
signal (`:738`), and then either the deferred-marker signal or the direct
`updateCompactionMarkerAfterPublication` (`:744-753`). Embedding, user-memory
candidates, and primer candidates are all post-commit and individually
swallowed (`:786-812`, `:820-844`, `:849-901`).

**The point after which a substitution is irreversible on this side.** The
commit at `:714`. Before it, no compartment row, no publication floor, and no
queued drop exists. After it, the compartment rows are durable, the publication
floor has advanced, and drop ops are queued for every tag through
`lastCompartmentEnd`. Two qualifications matter and are the substance of records
2 and 3. First, the substitution is not a deletion: the raw messages remain in
the harness's own store, and what changes is which of them the harness and the
injector present. Second, the compaction marker that makes OpenCode's
`filterCompacted` stop at the boundary (`compaction-marker-manager.ts:9-12`) is
written into OpenCode's database *after* the commit on the non-deferred path
(`:747`), so the marker and the publication are not atomic with each other
unless `deferMarkerApplication` is on.

## Divergence surface versus the Rust gate

Part 4a enumerates 22 rejecting checks in `validate_historian_output` and names
three consequential omissions. The per-check line references are Part 4a's, from
[../../part-4a-historian/_lenses/lens-b-validation-gate.md](../../part-4a-historian/_lenses/lens-b-validation-gate.md);
the verdicts and the TypeScript references are this pass's, each read at `HEAD`.

"Relocated" means the check exists on this side but not inside
`validateHistorianOutput`, so it protects the two shipped runners and not a
third caller.

| # | Rust check | TS verdict | Where, or why not |
| --- | --- | --- | --- |
| 1 | Text is wholly one `<output>` root (`:267-271`) | **Omitted** | No root check anywhere in `compartment-parser.ts`; `:166` scans the whole input |
| 2 | No second `<output>` tag in the body (`:276-280`) | **Omitted** | Same |
| 3 | Chunk coverage valid (`:457-461`) | **Relocated** | `validateChunkCoverage` (`validation.ts:325-347`), called at `incremental.ts:384`, `recomp.ts:360`, `partial-recomp.ts:400`, `pi-historian-runner.ts:652`. Not called by the gate |
| 4 | Stored ranges not inverted or overlapping (`:463-467`) | **Relocated** | `validateStoredCompartments` (`validation.ts:250-272`), called at `incremental.ts:198`, `pi-historian-runner.ts:489`, `recomp.ts:249`/`:551`, `partial-recomp.ts:311` |
| 5 | Chunk start strictly newer than last stored end (`:469-475`) | **Different: derived, not checked** | `incremental.ts:214-217` computes `offset` from the last stored end and `:353` builds the chunk from it, so the model never supplies it. A caller passing a chunk is unchecked |
| 6 | Chunk start is exactly the next *present* ordinal (`:476-483`) | **Different, and weaker** | `offset = last.endMessage + 1` (`:216`) is the next ordinal, not the next present one |
| 7 | Zero usable compartments (`:487-491`) | **Same**, identical message | `validation.ts:127-132` |
| 8 | Endpoints map to chunk lines (`:506-512`, `:949-957`) | **Different site, same effect** | `mapParsedCompartmentsToChunk` `chunk.lines.find` (`mapping.ts:39-46`) fails the pass |
| 9 | End line anchorable and `message_id` non-empty (`:958-963`) | **Omitted, structurally** | `anchorable` is a Rust `ChunkLine` field (`historian_validate.rs:39`); the TS line type is `{ ordinal, messageId }` (`validation.ts:16`). `mapping.ts:39-40` matches on ordinal only, so an empty `messageId` maps fine |
| 10 | `p1` absent or whitespace-only (`:514-524`, `:1000-1008`) | **Same** | `validation.ts:285-287` |
| 11 | `end < start` (`:1009-1014`) | **Same** | `validation.ts:288-290` |
| 12 | Endpoint outside the chunk (`:1015-1020`) | **Same** | `validation.ts:291-293` |
| 13 | Start ordinal present in the chunk (`:1021-1026`) | **Different site** | Folded into `mapping.ts:39-46` |
| 14 | End ordinal present in the chunk (`:1027-1032`) | **Different site** | Same |
| 15 | Starts after coverage was consumed (`:1033-1038`) | **Folded** | Collapsed with 16 and 17 into the `expectedStart` comparison (`validation.ts:294-299`) |
| 16 | Overlap below the next uncovered ordinal (`:1039-1045`) | **Same** | `validation.ts:295-297` |
| 17 | Gap above the next uncovered ordinal (`:1046-1049`) | **Same, weaker arithmetic** | `validation.ts:298`. Rust advances with `next_present_after` (`:1051`); TS uses `endMessage + 1` (`:300`) |
| 18 | `unprocessed_from` is the next uncovered present ordinal (`:1054-1060`) | **Same** | `validation.ts:312-314` |
| 19 | `unprocessed_from` on a covered chunk, plus the residual arm (`:1063-1074`) | **Omitted in part, and the order is reversed** | `validation.ts:306-308` accepts `chunkEnd + 1` **before** comparing `expectedStart`; Rust tests `expected_start` first (`:1055-1062`) and only then allows `chunk_end + 1` (`:1063-1065`). Record 5 |
| 20 | Uncovered messages with no `unprocessed_from` (`:1077-1081`) | **Same**, but reachable only when 19 does not short-circuit | `validation.ts:318-320` |
| 21 | Terminal boundary splits a completed tool arc (`:525-534`) | **Same** | `validation.ts:166-171`, over `boundarySplitsCompletedToolArc` (`:63-68`) |
| 22 | Forward progress past the prior stored end (`:565-570`) | **Relocated** | `incremental.ts:534-553`, and after discard-last rather than before |

Counting the 22: 9 the same, 4 the same at a different site or folded, 4
relocated to callers, 2 different by derivation, 3 omitted (1, 2, 9), and 1
partly omitted with reversed ordering (19).

Part 4a's three named omissions, checked on this side:

- **Nothing binds the output to the conversation.** Omitted here too, and by the
  same shape. The only chunk-derived facts the gate consults are `startIndex`,
  `endIndex`, and `lines[].ordinal` / `lines[].messageId`
  (`validation.ts:13-21`). There is no nonce, no required echo, and no chunk
  digest. `_sessionId` is accepted and ignored (`:121`).
- **Nothing bounds how little the summary may say.** Omitted here too. A
  non-empty `title` is a silent parser drop (`compartment-parser.ts:178`) and a
  non-blank `p1` is a reject (`validation.ts:285-287`). No length, ratio, or
  span-relative floor exists in either file.
- **Nothing structurally enforces that the gate ran.** **Weaker here than in
  Rust, in one direction and stronger in another.** Weaker: the result is a
  plain `ValidatedHistorianPassResult` object literal (`:173-182`) with no
  proof-carrying token at all, so `{ ok: true, compartments: [...] }` typechecks
  from anywhere, and `appendCompartments` (`incremental.ts:648`) takes candidate
  rows with no provenance. Stronger: on both shipped paths the only producer of
  those rows is `runValidatedHistorianPass`, and the publish transaction
  re-checks the durable lease inside itself (`:639-647`), which Rust's commit
  point does not do.

Two divergences run the other way, where this side is stricter:

- **Retry is bounded within a pass.** Part 4a records
  `hv-validation-rejection-retry-has-no-attempt-bound` on the Rust side. Here a
  single pass is initial plus repair plus a deduplicated fallback chain
  (`historian.ts:580-586`), so attempts per firing are bounded by configuration
  length. Across firings a failure additionally records a drain-failure backoff
  (`incremental.ts:924`) and retains the drain reservation as a throttle
  (`:916-925`).
- **Single-flight is durable, not process-local.** Three gates, one of them a
  cross-process lease re-checked inside the publish transaction. Part 4a's
  `uncertain-producer-start-authorizes-a-second-billable-run` has no analogue
  found here.

One divergence is agreement on a defect: `unescapeXml`
(`compartment-parser.ts:322-329`) replaces `&amp;` first and `&lt;` after, so
`&amp;lt;` decodes to `<`. Part 4a records the identical ordering as
`hv-unescape-xml-double-decodes-entities`. The two implementations agree, and
both are wrong the same way.

## Observations

1. `compartment-runner-validation.ts:121` and `:123` are `_sessionId` and
   `_priorCompartments`, both unread. The gate's signature advertises state it
   does not consult.
2. `compartment-runner-validation.ts:306-308` returns `null` for
   `unprocessedFrom === chunkEnd + 1` before the `expectedStart` comparison at
   `:312-314` and before the uncovered-suffix check at `:318-320`.
3. `compartment-runner-validation.ts:16` types a chunk line as
   `{ ordinal: number; messageId: string }`. `historian_validate.rs:39` carries
   `pub anchorable: bool`.
4. `compartment-runner-validation.ts:18` and `:20` make `toolOnlyRanges` and
   `completedToolArcs` optional, defaulted to `[]` at `:41`, `:65`, `:73`.
   `historian_validate.rs:61` and `:64` are non-optional `Vec`.
   `read-session-chunk.ts:826-827` always supplies both on the two shipped
   paths; `scorer.ts:598-599` supplies empty arrays.
5. `compartment-runner-validation.ts:57-59` heals a gap only when one
   `toolOnlyRanges` entry covers it whole (`:53-55`), mutating
   `prev.endMessage` in place. `mapping.ts:40` then resolves `endLine` from the
   healed ordinal and `:52` stamps a new `endMessageId`. No content field is
   re-examined.
6. `compartment-runner-validation.ts:136-142` runs both heals *before* mapping
   (`:144`) and before `validateParsedCompartments` (`:152`), so every
   range-shaped check sees healed ranges.
7. `compartment-runner-validation.ts:80` bounds the terminal-arc heal loop at
   `arcs.length + 1` passes and breaks on no change (`:91`).
8. `compartment-runner-validation.ts:104-117`: discard-last requires at least
   two compartments (`:108`) and a lookahead margin at or below the slack
   (`:112-114`), and refuses when the retained boundary would split an arc
   (`:115`).
9. `compartment-runner-incremental.ts:637` and `:714` bracket the publish
   transaction; `:639-647` re-checks the lease inside it.
10. `compartment-runner-incremental.ts:648` is the only `appendCompartments`
    call on this path. No raw-transcript write accompanies it. A repository-wide
    search for `chunk_transcript`, `chunkTranscript`, `rawChunkMessages`, and
    `raw_chunk_messages` across `packages/` returns zero hits;
    `crates/mc-store/src/lib.rs:9472-9479` calls `insert_chunk_transcripts_tx`
    inside the Rust publish transaction.
11. `compartment-runner-incremental.ts:695` queues drop ops; it does not apply
    them. `compartment-runner-drop-queue.ts:61` and `:69` are
    `queuePendingOp(..., "drop")`.
12. `compartment-runner-incremental.ts:747` writes the compaction marker into
    OpenCode's database after `COMMIT` at `:714`, on the non-deferred path
    selected by `:568`.
13. `compartment-runner-incremental.ts:683-693` wraps the event insert in a
    `try/catch` that logs and continues, inside the transaction. A failed event
    insert still commits the compartments.
14. `mutations.ts:50-58` maps seven classes to expected stages. Exactly one,
    `structural-overlap` (`:56`), expects `validation-rejected`; it builds an
    overlapping pair (`:344-355`), which is Rust check 16. Five expect `scored`
    and one expects a probe comparison.
15. `mutations.ts:431-449` asserts every semantic-class baseline is
    validator-clean, so a validator change that rejects a baseline surfaces as a
    battery error rather than a silent stage migration.
16. `contract.ts:769-780` fingerprints scenario schema, id, title, families,
    transcript, expected run count, gold, and probes. No validator artifact is
    in it, and `:1560` folds those per-scenario fingerprints into
    `corpusFingerprint`.
17. `gen-validate-golden.ts:38` hardcodes the healing slack; `:44` omits
    completed tool arcs from the golden's chunk shape; `:662-663` writes 16
    cases to `crates/mc-module/testdata/validate-golden.json`.
18. `compartment-runner-validation.test.ts:215-229` asserts an exact Rust error
    string for the arc-splitting reject. It executes no Rust.

## Candidate properties

Fourteen records. Semantics distribution is 11 `always`, 1
`always-or-unreached`, 1 `sometimes`, 1 `reachable`. Types are 11 safety, 1
liveness, 2 reachability. All 14 are `default-production`.

In this part `default-production` means reachable in a shipped plugin install.
The shared evidence for that label, cited per record rather than asserted as a
preamble: `startCompartmentAgent` (`compartment-runner.ts:111`) is called from
the transform pass on a trigger fire, no config key gates
`runCompartmentAgent`, and Part 4a's portfolio evaluation resolved the same
question for the Rust historian in favour of `default-production` from the
shipped setup code. Records whose reachability rests on something narrower say
so.

### tshist-a-publish-commit-is-the-single-irreversible-point

Type: safety
Reachability: default-production — `compartment-runner-incremental.ts:637-714`
is the only publish transaction on the OpenCode incremental path, reached by
every trigger-fired run that gets a validated pass. No flag gates it.
Status: active
Exercised: partial — `compartment-runner.test.ts` and
`compartment-runner-wrapup.test.ts` drive the runner end to end at
`ci.yml:257`, and the lease-loss rollback arm has a dedicated path at
`:639-647`. No test asserts that a failure at each individual write inside the
transaction leaves zero durable effect.
Guarantee: Every durable effect of a historian publication becomes visible at
`db.exec("COMMIT")` (`:714`) or not at all, and no compartment row, publication
floor advance, or queued drop exists before it.
Check: `always` — after any `runCompartmentAgent` invocation that does not reach
`:715`, `getCompartments(db, sessionId)` equals its pre-call value, the
protected-tail publication floor is unchanged, and no `drop` pending op was
added. `always` because it must hold on every abandoned path, not merely be
reachable once.
Fault/timing angle: the window is `:637-714`. The lease is re-checked at `:639`
inside `BEGIN IMMEDIATE`, so a lease lost between `startCompartmentAgent` and
the transaction rolls back at `:640`. The event insert at `:685` is wrapped in a
`try/catch` (`:684-692`) that logs and continues, so an event failure commits
the rest deliberately.
Required faults and enabling state: a SQL error or thrown exception injected at
each write between `:648` and `:713`, plus a lease revoked between `:630` and
`:639`.
Confidence: high — [evidence](../evidence/tshist-a-publish-commit-is-the-single-irreversible-point.md).
Read the whole transaction and the `finally` at `:716-724`, and confirmed every
early return above `:637` precedes any durable write.
Existing check: the runner tests at `ci.yml:257`. Status `unaudited`.
Impact: a partial publish advances the publication floor past compartments that
do not exist, and the next run's `offset` (`:214-217`) skips that range
permanently.
Open questions:
- Does the swallowed event insert at `:683-693` ever leave `persistedIds`
  disagreeing with the event rows in a way a later reader notices? Unresolved,
  needs a read of `insertCompartmentEvents`.

### tshist-a-publish-stores-no-durable-raw-copy

Type: safety
Reachability: default-production — the absence is on the only publish path;
`appendCompartments` (`:648`) is unconditional inside the transaction.
Status: active
Exercised: not yet — no test asserts what the publish transaction does *not*
write, and none could without naming the Rust behaviour as the expectation.
Guarantee: The TypeScript publish transaction writes compartment rows and no
copy of the raw messages they summarize, so the user's original conversation
survives only in the harness's own store.
Check: `always` — after any successful publish, no table written by
`:637-714` contains the raw chunk text, and the harness's own message store
still holds every ordinal in `chunk.startIndex..chunk.endIndex`. `always`
because the retention claim must hold for every published chunk.
Fault/timing angle: none for the write itself. The window that matters is
between the publish and any harness-side deletion, which this side does not
perform and cannot observe.
Required faults and enabling state: none. Constructible by publishing one chunk
and inspecting the schema.
Confidence: high — [evidence](../evidence/tshist-a-publish-stores-no-durable-raw-copy.md).
Searched `packages/` for `chunk_transcript`, `chunkTranscript`,
`rawChunkMessages`, and `raw_chunk_messages` and found zero hits; read
`compartment-storage.ts`'s insert list and confirmed no raw-text column;
confirmed `crates/mc-store/src/lib.rs:9472-9479` calls
`insert_chunk_transcripts_tx` inside the Rust publish transaction.
Existing check: none.
Impact: this side has no in-database original to fall back on. Part 4a records
that the Rust side preserves raw chunk messages in the same transaction, with a
suffix revert as the one exception that discards them. Here there is nothing to
revert to, so a bad summary is repairable only from the harness's session file.
Open questions:
- Is the harness store a durable enough original for the product's stated
  retention promise, or does a Rust-mode install silently have a stronger
  guarantee than a TypeScript-mode one? (needs human input)

### tshist-a-compaction-marker-is-not-atomic-with-the-publish

Type: safety
Reachability: default-production — `:744-753` runs on every successful publish,
and the non-deferred arm at `:747` is selected whenever
`deps.preserveInjectionCacheUntilConsumed` is not `true` (`:568`), which is the
recomp, partial-recomp, and explicit-flush shape.
Status: active
Exercised: partial — `compaction-marker-manager.ts`'s drain outcomes are typed
and tested through the deferred path. No test kills the process between `:714`
and `:747`.
Guarantee: On the non-deferred path the compaction marker in OpenCode's database
is written after the publish commits, so a crash in between leaves committed
compartments with no marker; the deferred path closes this by writing a pending
blob inside the transaction instead.
Check: `always-or-unreached` — if the process survives to `:753`, the marker
ordinal equals `lastCompartmentEnd`; if it does not, the committed publication
is marker-less and a later pass must re-derive it. `always-or-unreached`
because the non-deferred arm is optional for a given caller but must be safe
when taken.
Fault/timing angle: the window is `:714` to `:753`, which spans an
`await`-free stretch but also a second database open inside
`updateCompactionMarkerAfterPublication`. The deferred arm's blob is written at
`:707-713`, inside the transaction, precisely to remove this window; the
comment at `:557-563` states that intent.
Required faults and enabling state: process death or an
`injectCompactionMarker` failure after `:714` with
`deferMarkerApplication === false`.
Confidence: high — [evidence](../evidence/tshist-a-compaction-marker-is-not-atomic-with-the-publish.md).
Read `:557-568`, `:707-713`, and `:744-753`, and confirmed the deferred blob is
in-transaction while the direct apply is not.
Existing check: none for the crash window. Status not applicable.
Impact: OpenCode's `filterCompacted` does not stop at the boundary, so the
harness resends raw messages the plugin has already comparted, and the injector
and the harness disagree about the live tail until a later pass repairs it.
Open questions:
- Is the direct-apply arm still reached by any shipped caller, or is
  `preserveInjectionCacheUntilConsumed` now always true in production?
  Unresolved, needs a caller sweep of `startCompartmentAgent`'s deps.

### tshist-a-output-envelope-is-rust-only

Type: safety
Reachability: default-production — the parser is the first thing
`validateHistorianOutput` calls (`validation.ts:126`), on every model response.
Status: active
Exercised: not yet — every fixture in `compartment-parser.test.ts` and
`compartment-runner-validation.test.ts` wraps its compartments in `<output>`
(for example `compartment-parser.test.ts:7`, `:33`), so no case establishes what
happens without a root or with two.
Guarantee: The TypeScript parser accepts a document that is not wholly one
`<output>` root, and accepts a document containing more than one, both of which
the Rust gate rejects.
Check: `always` — for a text with leading or trailing prose around a valid
`<compartment>` set, or with two `<output>` roots,
`parseCompartmentOutput(text).compartments` is non-empty and
`validateHistorianOutput` returns `ok: true` given a matching chunk. `always`
because the acceptance is unconditional on the parser's structure, not a
reachable corner.
Fault/timing angle: none. Purely an input-shape divergence.
Required faults and enabling state: a model response with chain-of-thought
prose, a markdown fence, or a retried second envelope around otherwise valid
compartments. No fault injection needed.
Confidence: high — [evidence](../evidence/tshist-a-output-envelope-is-rust-only.md).
Read `compartment-parser.ts:162-294` and confirmed no root regex exists;
verified `historian_validate.rs:267-271` and `:276-280` reject, and that
`output_document_regex` (`:1156-1161`) is anchored `\A`/`\z`.
Existing check: none on the TypeScript side. `historian_validate.rs:267-271` is
the Rust half and never executes.
Impact: the two implementations accept different input sets, so the frozen
corpus cannot be authoritative for both, and a model whose prose leaks outside
the envelope produces durable compartments in TypeScript mode and a rejected
run in Rust mode.
Open questions:
- Is the permissiveness intentional? `historian_validate.rs:261-263` describes
  the TypeScript semantics as the inner behaviour it copies, which reads as
  though the envelope was added on purpose in Rust and never backported.
  (needs human input)

### tshist-a-unprocessed-from-chunk-end-plus-one-short-circuits-coverage

Type: safety
Reachability: default-production — `validateParsedCompartments` runs on every
validated pass (`validation.ts:152`), and `:306` is the first branch of the
`unprocessedFrom !== null` arm.
Status: active
Exercised: not yet — the gap and overlap arms have dedicated cases
(`compartment-runner-validation.test.ts:133`, `:146`, `:160`), and none supplies
an `unprocessed_from` of `chunkEnd + 1` alongside an uncovered trailing suffix.
Guarantee: When a model leaves a trailing suffix uncovered and declares
`<unprocessed_from>` equal to `chunkEnd + 1`, the TypeScript gate accepts,
while the Rust gate rejects the same document.
Check: `always` — for compartments covering `chunkStart..k` with
`k < chunkEnd` and `unprocessedFrom === chunkEnd + 1`,
`validateParsedCompartments` returns `null` and `validateHistorianOutput`
returns `ok: true`. `always` because the short-circuit is unconditional once
that value is declared.
Fault/timing angle: none. The two orderings are a static difference:
`validation.ts:306-308` tests the constant first;
`historian_validate.rs:1055-1062` tests `expected_start` first and only reaches
the `chunk_end + 1` allowance at `:1063-1065` when coverage is complete.
Required faults and enabling state: one model output with a short final
compartment and a full-processing claim. Constructible offline.
Confidence: high — [evidence](../evidence/tshist-a-unprocessed-from-chunk-end-plus-one-short-circuits-coverage.md).
Read both orderings at `HEAD` and traced the downstream effect: the runner
derives `lastCompartmentEnd` from the last compartment (`incremental.ts:534`,
`:570`), not from `unprocessedFrom`, and the gate does not return
`unprocessedFrom` at all (`validation.ts:173-182`), so the uncovered suffix is
re-read next run rather than dropped.
Existing check: none. `validation.ts:318-320` is the check this branch skips.
Impact: the accepted-output sets differ, which falsifies any claim that the
frozen corpus is authoritative for both. The uncovered range is not lost,
because `offset` (`incremental.ts:214-217`) re-reads it, so the direct product
impact is a mis-recorded `telemetry.unprocessedFrom` (`:768`) and a divergence
a differential harness would surface.
Open questions:
- Does any consumer besides telemetry read the declared `unprocessed_from`?
  The gate discards it; `pi-historian-runner.ts` was not fully read for this.
  Unresolved, needs a Pi-side sweep.

### tshist-a-anchorability-is-not-an-input-to-this-gate

Type: safety
Reachability: default-production — the chunk line type at `validation.ts:16` is
the shape every caller supplies, including `read-session-chunk.ts:826-827`.
Status: active
Exercised: not yet — no test constructs a chunk line whose end message cannot
anchor, because the type offers no way to say so.
Guarantee: The TypeScript gate cannot refuse a compartment whose end line is
unanchorable or carries an empty `messageId`, because neither fact reaches it.
Check: `always` — for a chunk whose line at the proposed end ordinal has
`messageId === ""`, `mapParsedCompartmentsToChunk` succeeds and the resulting
`endMessageId` is the empty string. `always` because the omission is structural
in the input type, not conditional.
Fault/timing angle: none.
Required faults and enabling state: a chunk line with an empty `messageId`.
Whether the raw providers can produce one is the open question below.
Confidence: high — [evidence](../evidence/tshist-a-anchorability-is-not-an-input-to-this-gate.md).
Compared `validation.ts:13-21` against `historian_validate.rs:35-52` and
confirmed `pub anchorable: bool` at `:39` has no TypeScript counterpart;
confirmed `mapping.ts:39-40` matches on `ordinal` alone and `:52` copies
`endLine.messageId` unchecked.
Existing check: none. Part 4a attributes the check to
`historian_validate.rs:958-963`, which never executes.
Impact: a durable compartment can carry an unanchorable end boundary. The
compaction marker and the injector both resolve the boundary by message id
(`compaction-marker-manager.ts:26`, `getCompartmentsByEndMessageId`), so an
empty or unresolvable id makes the boundary unfindable.
Open questions:
- Can `read-session-chunk.ts` emit a line with an empty `messageId`, and does
  Pi's provider differ? Unresolved, needs a read of the line-meta construction
  in both providers.

### tshist-a-gate-is-not-self-sufficient-without-its-runner

Type: safety
Reachability: default-production — the gate is exported and already has three
callers; two supply the missing checks and one does not.
Status: active
Exercised: partial — the four relocated checks each have runner-level tests at
`ci.yml:257`. Nothing asserts that a caller which skips them is absent, and
`scorer.ts:715` is exactly such a caller.
Guarantee: Every caller of `validateHistorianOutput` also runs
`validateStoredCompartments`, `validateChunkCoverage`, a derived chunk start,
and a forward-progress check, because the gate performs none of the four
despite accepting `priorCompartments`.
Check: `always` — for every call site of `validateHistorianOutput` whose result
can reach `appendCompartments`, the four caller-side checks precede or follow it
on the same path. `always` because the composition obligation applies to every
publishing caller.
Fault/timing angle: none for the composition. The gate signature is the hazard:
`_priorCompartments` (`:123`) makes the argument look consulted.
Required faults and enabling state: a new caller, or a refactor that moves
publication behind the gate without the runner.
Confidence: high — [evidence](../evidence/tshist-a-gate-is-not-self-sufficient-without-its-runner.md).
Confirmed both parameters are underscore-prefixed and unread; enumerated all
call sites of the four exported helpers; confirmed `scorer.ts:715` passes `[]`
for prior compartments.
Existing check: `incremental.ts:198`, `:384`, `:534`; `pi-historian-runner.ts:489`,
`:652`; `recomp.ts:249`, `:360`, `:551`; `partial-recomp.ts:311`, `:400`. All at
`ci.yml:257`. Status `unaudited`.
Impact: the gate's name and signature overstate what it proves. A publishing
caller that trusts the name inherits none of checks 4, 5, 6, or 22, and Part 4a
records those as the checks that stop a model claiming coverage of a range it
did not summarize.
Open questions: None.

### tshist-a-coverage-advance-ignores-ordinal-presence

Type: safety
Reachability: default-production — `validateParsedCompartments` (`:274-323`) is
on every validated pass.
Status: active
Exercised: partial — the contiguous and gap cases are covered
(`compartment-runner-validation.test.ts:172`, `:133`). No case supplies a chunk
whose `lines` skip an ordinal, because `validateChunkCoverage` forbids that
upstream.
Guarantee: The TypeScript gate advances expected coverage by `endMessage + 1`
and is therefore correct only for a chunk whose ordinals are contiguous, an
assumption enforced by a different function that the gate does not call.
Check: `always` — for every chunk reaching `validateParsedCompartments`,
`chunk.lines` ordinals are exactly `startIndex..endIndex` with no gap.
`always` because the arithmetic at `:300` depends on it unconditionally.
Fault/timing angle: none.
Required faults and enabling state: a chunk with a missing ordinal, supplied by
a caller that skips `validateChunkCoverage`.
Confidence: high — [evidence](../evidence/tshist-a-coverage-advance-ignores-ordinal-presence.md).
Read `:300` and `:334-344`, and confirmed `historian_validate.rs:1051` advances
with `next_present_after` over a present-ordinal set, so Rust tolerates gapped
chunks and TypeScript does not.
Existing check: `validateChunkCoverage` (`:325-347`) at the four runner sites,
all `ci.yml:257`. Status `unaudited`.
Impact: on a gapped chunk the gate rejects valid coverage with a spurious "gap
before message N", so the two implementations disagree in the rejecting
direction as well as the accepting one. Combined with the previous record, the
gate's correctness is a property of its callers.
Open questions:
- Can a gapped chunk arise in practice, given `readSessionChunk` builds
  `lineMeta` from a filtered message walk? Unresolved, needs a read of the
  filtering at `read-session-chunk.ts:797-827`.

### tshist-a-nothing-executing-compares-the-two-validators

Type: safety
Reachability: default-production — the absence governs every shipped install
that can run either implementation.
Status: active
Exercised: not yet — the only comparison artifacts are a hand-run generator, a
Rust test that never executes, and one hardcoded error string in a TypeScript
test.
Guarantee: A change to `compartment-runner-validation.ts` or
`compartment-parser.ts` that alters the accepted-output set is detected by some
check that runs.
Check: `always` — for every commit that changes the accepted-output set of
either implementation, at least one executing CI check fails. `always` because
the detection obligation applies to every such commit.
Fault/timing angle: none. This is a pipeline property.
Required faults and enabling state: a semantic edit to either validator, then a
full CI run.
Confidence: high — [evidence](../evidence/tshist-a-nothing-executing-compares-the-two-validators.md).
Verified `gen-validate-golden.ts` appears in none of the five workflow files, no
`package.json` script, and nothing under `scripts/`; its docstring gives a manual
invocation (`:9`). Verified the golden is 16 cases and its consumer is
`historian_validate.rs:1384-1387`, which Part 4a establishes never runs.
Verified the generator's `ChunkJson` (`:39-45`) has no completed-tool-arc field,
and that it hardcodes the slack at `:38` instead of importing
`HISTORIAN_BOUNDARY_HEALING_SLACK` (`validation.ts:11`).
Existing check: none executing. The nearest is
`compartment-runner-validation.test.ts:215-229`, which pins one Rust error
string and runs no Rust.
Impact: the frozen corpus is described as the best cross-implementation
differential vector set in the repo, and no gate consumes it that way. Records
4, 5, 6, and 8 are each a live divergence that this absence permits.
Open questions:
- Would regenerating the golden today change it? If it would, the checked-in
  file is already stale and the never-run Rust test would compare against an
  old TypeScript. Unresolved, needs a generator run in a clean tree.

### tshist-a-frozen-corpus-fingerprint-does-not-bind-validator-behaviour

Type: safety
Reachability: default-production — the freeze lint runs per pull request at
`ci.yml:436-437`.
Status: active
Exercised: partial — the lint is executed every pull request and its
per-scenario and corpus-identity rules are tested by the unit contracts at
`:433-434`. Nothing tests that it reacts to a validator change, because it
cannot.
Guarantee: The corpus freeze lint detects a change to the scenario corpus and
not a change to the validator that consumes it, so byte-identical frozen inputs
can mean a different accepted-output set.
Check: `always` — `scenarioFingerprint` and the derived `corpusFingerprint`
depend only on scenario fields, so for any two commits differing solely in
`compartment-runner-validation.ts`, both fingerprints are equal. `always`
because the fingerprint's input set is fixed.
Fault/timing angle: none.
Required faults and enabling state: a semantic validator edit with no corpus
edit. Constructible offline.
Confidence: high — [evidence](../evidence/tshist-a-frozen-corpus-fingerprint-does-not-bind-validator-behaviour.md).
Read `contract.ts:769-780` and confirmed the fingerprint covers schema, id,
title, families, transcript, expected run count, gold, and probes, and no
validator artifact; confirmed `:1560` derives `corpusFingerprint` from those.
Existing check: the mutation battery's baseline assertion
(`mutations.ts:431-449`) is the only mechanism that reacts to a validator
change, and only when the change rejects a previously valid baseline.
Impact: a change that makes the validator *more* permissive moves no
fingerprint and trips no baseline assertion, so it can freeze into a release
invisibly. That is the exact direction records 4 and 5 sit in.
Open questions: None.

### tshist-a-heal-rewrites-boundary-identity-without-revalidating-content

Type: safety
Reachability: default-production — both heals run unconditionally at
`validation.ts:136-142` before mapping and before the range checks.
Status: active
Exercised: partial — tool-only gap healing has three sizes covered
(`compartment-runner-validation.test.ts:91`, `:105`, `:118`) and the terminal
arc heal has two (`:196`, `:231`), each asserting the healed ordinal and in one
case the new `endMessageId` (`:284-287`). None asserts that the healed
compartment's body says anything about the absorbed messages.
Guarantee: Healing extends a compartment's range and restamps its durable end
message id from the healed ordinal without re-examining any content field, so
an absorbed range is covered by prose that never mentioned it.
Check: `always` — after a heal, `prev.endMessage` has increased,
`endMessageId` equals `chunk.lines` at the new ordinal, and every content field
(`title`, `p1` through `p4`) is byte-identical to the parsed value. `always`
because the content-preservation claim is what makes the coverage claim false.
Fault/timing angle: the ordering is the mechanism. `healCompartmentGaps`
(`:39-61`) and `healTerminalCompletedToolArc` (`:70-98`) mutate at `:58` and
`:92`, before `mapParsedCompartmentsToChunk` (`:144`) resolves `endLine`
(`mapping.ts:40`) and stamps `endMessageId` (`:52`), and before
`validateParsedCompartments` (`:152`) sees any range.
Required faults and enabling state: a chunk whose `toolOnlyRanges` covers a gap
whole (`:53-55`), or a completed arc crossing the proposed terminal boundary
with `arc.end <= chunkEnd` (`:85-86`).
Confidence: high — [evidence](../evidence/tshist-a-heal-rewrites-boundary-identity-without-revalidating-content.md).
Traced both heals and confirmed neither touches a content field; confirmed the
gap heal requires a single covering range rather than a union, so a gap spanned
by two adjacent tool-only ranges does not heal.
Existing check: `:53-55` restricts gap healing to a fully covering tool-only
range and `:85` restricts arc healing to arcs ending inside the chunk. Both at
`ci.yml:257`. Status `unaudited`.
Impact: identical in shape to Part 4a's
`hv-heal-extends-range-without-revalidating-content`, so the two
implementations agree here. The consequence is that the publication floor
advances past messages no summary describes, and this side has no durable raw
copy to recover them from (record 2).
Open questions:
- Should a gap spanned by two adjacent tool-only ranges heal? `read-session-chunk.ts:797-806`
  merges adjacent ranges before handing them over, which suggests the
  single-range requirement is load-bearing on the producer side rather than the
  consumer side. Unresolved, needs confirmation that merging is exhaustive.

### tshist-a-mutation-battery-drives-one-rejecting-check

Type: reachability
Reachability: default-production — the battery runs per pull request at
`ci.yml:439-440`.
Status: active
Exercised: yes — the battery executes every pull request and asserts a stage per
class (`mutations.ts:187-192`).
Guarantee: Of the seven mutation classes, exactly one reaches the validator's
rejecting path, and it targets the overlap check; none targets the three
omissions Part 4a names.
Check: `reachable` — the `validation-rejected` stage is entered by the
`structural-overlap` class and by no other. `reachable` because this is location
coverage of the rejecting path, and the interesting fact is how narrow it is.
Fault/timing angle: none.
Required faults and enabling state: none beyond running the battery.
Confidence: high — [evidence](../evidence/tshist-a-mutation-battery-drives-one-rejecting-check.md).
Read `MUTATION_CLASSES` (`:33-41`) and `EXPECTED_OUTCOMES` (`:50-58`) and
confirmed `structural-overlap` is the only `validation-rejected` entry;
confirmed its fixture is an overlapping pair (`:344-355`), which is Rust check
16; confirmed the scorer's chunk supplies `completedToolArcs: []`
(`scorer.ts:598-599`), so check 21 and both arc heals are vacuous in the lane.
Existing check: this record *is* the check inventory. Status `unaudited`.
Impact: the battery is real evidence for the scorer and for one structural
check, and no evidence for chunk-identity binding, minimum summary size, or
gate-ran enforcement. Reading a green battery as validator coverage overstates
it by 21 checks.
Open questions:
- Would adding a class for each of the three omissions be cheap, given the
  battery already builds crafted outputs and asserts a stage? Unresolved, needs
  a design pass, and it is a coverage-gap question rather than a property.

### tshist-a-validation-retry-is-bounded-within-one-firing

Type: liveness
Reachability: default-production — `runValidatedHistorianPass`
(`compartment-runner-historian.ts:104`) is the only model-calling path on both
shipped runners.
Status: active
Exercised: partial — `compartment-runner-timeout.ts` and the runner tests drive
failure paths at `ci.yml:257`. No test counts total model invocations for one
firing against the configured chain length.
Guarantee: One historian firing performs at most one initial call, one repair
call, one call per distinct configured fallback model, and at most one editor
call, then terminates.
Check: `always` — for one `runValidatedHistorianPass`, the number of
`runHistorianPrompt` invocations is at most `2 + |chain| + 1`, where `chain` is
the deduplicated concatenation of `fallbackModels` and `fallbackModelId`.
`always` because the bound must hold on every firing; the units are attempts,
not wall clock.
Fault/timing angle: the bound is structural, not temporal. The chain is built by
a dedup loop (`:580-586`) and returns early when empty (`:587-589`). Across firings
the runner retains the drain reservation as a throttle (`incremental.ts:916-925`)
and records a drain-failure backoff (`:924`).
Required faults and enabling state: a model that returns invalid output on
every attempt, plus a configured multi-model fallback chain.
Confidence: high — [evidence](../evidence/tshist-a-validation-retry-is-bounded-within-one-firing.md).
Read the initial, repair, fallback, and editor paths and confirmed each
validates once and does not loop; confirmed the editor pass never receives
`fallbackModels` and returns the draft on any failure (`:279-297`).
Existing check: none counting invocations. Status not applicable.
Impact: this is where the two implementations differ in this side's favour. Part
4a records `hv-validation-rejection-retry-has-no-attempt-bound` on the Rust
side, so an unverified Rust obligation is met here and not there.
Open questions:
- Across firings, is the throttle sufficient? A broken historian still refires
  each turn; the alert cooldown is 60 seconds (`incremental.ts:82`) and bounds
  notifications, not calls. Unresolved, needs the drain-failure backoff read.

### tshist-a-discard-last-drop-occurs-with-promotion-suppressed

Type: reachability
Reachability: default-production — `:515-530` is on the incremental path with no
config gate; it is skipped only in emergency or forced-keep.
Status: active
Exercised: partial — `shouldDiscardLastHistorianCompartment` has direct unit
cases including the arc-blocking one
(`compartment-runner-validation.test.ts:296-313`), and the scorer reports the
healing decision (`scorer.ts:347-351`). No test drives a full publish in which
the drop fires *and* asserts that facts, observations, and primers were all
withheld.
Guarantee: A campaign produces at least one publication in which discard-last
fires while the model output carried facts, observations, and primer candidates,
which is the state the unanchored-promotion suppression exists to handle.
Check: `sometimes` — a published run exists with
`persistedCompartments.length < emittedCompartments.length`, a non-empty
`validatedPass.facts`, a non-empty `validatedPass.userObservations`, and a
non-empty `validatedPass.primerCandidates`. Those are the independent
preconditions that jointly create the double-promotion window, asserted without
asserting the suppression itself. `sometimes` because this is situation
coverage: the branch's lines are already executed by unit tests, and what a
campaign must additionally produce is the operational state of a real
publication with a dropped tail and live side channels.
Fault/timing angle: the discard decision at `:517-521` reads emergency state
from the database (`:515`), so it is timing-dependent on overflow pressure. The
suppression it implies is computed at `:591-593` and consumed at `:663`,
`:820-825`, and `:849-854`.
Required faults and enabling state: a model that consumes almost the whole
chunk, leaving a lookahead margin at or below 2, with at least two compartments
emitted, no emergency recovery armed, and `forceKeepLastCompartment` unset.
Confidence: high — [evidence](../evidence/tshist-a-discard-last-drop-occurs-with-promotion-suppressed.md).
Traced `discardedLast` (`:591`) to `skipUnanchoredPromotion` (`:593`) and to all
three consumers; confirmed events are filtered separately at `:616-623`.
Existing check: the unit cases at `compartment-runner-validation.test.ts:296-313`
and the scorer's healing report, both executing. Status `unaudited`.
Impact: if the situation never occurs in a campaign, the suppression logic is
unexercised in composition, and a regression that promotes facts from a
discarded tail would double them on the next run, which is the specific hazard
the comment at `:579-586` names.
Open questions: None.

## Contract-vs-code leads

1. **`historian_validate.rs:261-263` describes the TypeScript parser as the
   inner semantics it reuses, and the two are not equivalent even inside the
   envelope.** The Rust doc says "Require one complete historian output
   envelope, then use the TypeScript host parser's permissive extraction
   semantics for structures inside that root." Inside the root the two still
   differ: `anchorable` (`:39`) has no TypeScript input, present-ordinal
   advance (`:1051`) has no TypeScript counterpart, and the
   `unprocessed_from` branch order is reversed (`:1055-1065` against
   `validation.ts:306-314`). Both sides cited; not resolved in favour of the
   doc.
2. **`compartment-runner-validation.ts:121` and `:123` accept `_sessionId` and
   `_priorCompartments` that the function does not read.** The signature is the
   contract a caller reads, and it claims a prior-state relationship the body
   does not have. `scorer.ts:715` already calls it with `[]`.
3. **The eval lane's README is quoted by Part 4a as calling the frozen corpus
   "the best TS<->Rust validator differential vector set the repo has (reuse
   deferred, see plan scope)".** The deferral is real and the reuse does not
   exist: `gen-validate-golden.ts` is manual, its consumer never runs, and its
   chunk shape omits completed tool arcs (`:44`). The document states an
   intention; nothing implements it.
4. **`compartment-runner-validation.ts:32-35` says "Never absorb an
   unclassified gap. Production replay with the lowest-calibration historian
   showed contiguous narrative coverage, so there is no model-quality need for
   a size-based escape hatch."** The code honours this for gaps. The terminal
   arc heal at `:70-98` is a different escape hatch on the same boundary, and
   the comment does not scope itself to gaps. Not a defect; a doc-scope
   mismatch worth a sentence.
5. **`gen-validate-golden.ts:38` hardcodes `BOUNDARY_HEALING_SLACK = 2` while
   `validation.ts:11` exports `HISTORIAN_BOUNDARY_HEALING_SLACK`.** The
   generator imports the real parser and validator through `Bun.resolveSync`
   (`:17-18`) but not this constant, so the artifact that exists to prove
   agreement can silently disagree with the implementation it samples.

## Open questions

- How should `Exercised` be labelled for a divergence record, where the
  TypeScript half runs every push and the Rust half never runs? The scope map
  raised this and left it open. Every record in this lens whose claim is a
  divergence has the same shape: the TypeScript behaviour is `partial` or `yes`
  evidence and the Rust behaviour is unverified, and the *divergence itself* is
  `not yet` because no check compares them. I labelled by the divergence, not by
  the TypeScript half. This needs the same ruling the scope map asked for.
  (needs human input)
- Would regenerating `crates/mc-module/testdata/validate-golden.json` today
  change it? That is the cheapest single measurement of how far the two
  implementations have already drifted, and it is one command. Unresolved,
  needs a generator run in a clean tree.
- Is `preserveInjectionCacheUntilConsumed` true for every shipped caller? If it
  is, the non-atomic marker window in record 3 is unreachable in production and
  that record should be re-labelled. Unresolved, needs a caller sweep.
- Can `readSessionChunk` produce a line with an empty `messageId`, or a chunk
  with non-contiguous ordinals? Records 6 and 8 both bound their impact on the
  answer. Unresolved, needs a read of `read-session-chunk.ts:797-827`, which is
  outside 5b's file set and was read only for the two lines cited.
- `pi-historian-runner.ts` (1,683 lines) was read only at its validator call
  sites (`:489`, `:652`, `:868`, `:1073`, `:1548`) and its chunk construction
  (`:625-630`). It shares `readSessionChunk` and all four caller-side checks, so
  I treat it as equivalent to the OpenCode runner for every record above. That
  equivalence is asserted from five call sites, not from a full read, and a
  later pass should confirm it rather than inherit it.
