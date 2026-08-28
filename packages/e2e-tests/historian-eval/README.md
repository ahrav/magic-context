# Historian structural eval lane

Measures whether the historian forms truthful durable memory from
conversation — and refuses to promote speculation or rejected proposals —
from a hand-audited scenario suite with fully deterministic scoring. No
agent rollouts, no LLM judge. Origin: beads task `magic-context-x4l.11`;
plan: `docs/plans/2026-08-26-2356-feat-historian-structural-eval-lane-plan.md`.

## Layout

```
historian-eval/
  dev/                      # development split: one JSON per scenario
                            # (transcript + gold + probes); tune freely
  releases/vN/              # frozen releases (immutable; promote.ts only)
    manifest.json           # release tuple + fingerprint-bound approvals + tombstones
    mutation-evidence.json  # green battery evidence per scenario (R13)
    scenarios/<id>.json
src/historian-eval/
  contract.ts               # scenario/gold/probe schemas, freeze lint, release tuple
  runner.ts                 # replay runner: e2e harness -> run record
  scorer.ts                 # deterministic scorer + probe comparison + lane report
  verification-bridge.ts    # lane-owned maturity normalization (see Deviations)
  payload.ts                # historian-output builder for tests + battery
  mutations.ts              # invalid-state mutation battery (admission gate)
  promote.ts                # freeze governance (clone of the retrieval pattern)
scripts/run-historian-eval.ts
```

## Commands

| What | Command |
|---|---|
| Lane unit tests (pure data) | `bun run test:historian-eval-unit` |
| Harness-booting runner tests | opencode-e2e standalone selection (`test:opencode-e2e`) |
| Freeze lint over the dev split | `bun scripts/run-historian-eval.ts --lint` |
| Mutation battery | `bun scripts/run-historian-eval.ts --mutations` |
| Live lane run | `bun scripts/run-historian-eval.ts --live --release historian-eval/releases/v1` |

Live runs read `ANTHROPIC_API_KEY`, `HISTORIAN_EVAL_MODEL`, and
`HISTORIAN_EVAL_PROBE_MODEL` (`provider/model`; both halves must be
non-empty, checked before any token is spent). Per-PR CI runs only the
deterministic parts (`historian-eval-deterministic` job); live runs are
scheduled or dispatched via `.github/workflows/historian-eval.yml` (R14),
and manual dispatch is restricted to the default branch because the job puts
the API key in the environment of a checked-out ref.

Each report records the system-version tuple its scores belong to: repo SHA,
resolved `opencode --version`, historian and probe model ids, parser
implementation, and chunk token budget. The OpenCode version is part of that
identity because the installer serves whatever release is current, so two
otherwise identical weekly runs can sit on different harness runtimes; a
tuple without it would make them look longitudinally comparable.

## Scoring surface (KTD1)

Facts scoring reads the literal injection read —
`readAuthorizedClaimMemorySnapshot` (`auto_inject` surface, active
lifecycle, stale retry) — with the run record's pinned `nowMs` threaded
through every read, so re-scoring a run record yields byte-identical
verdicts. Recall drives FAIL; precision is reported but never fails alone;
an expected-absent predicate matching any injection-visible active claim is
`FAIL:false-authoritative` and always run-fatal (R7/R8/KTD8).

Re-scoring an archived run is guarded by the record's own identity, not just
its bytes: `scoreRunRecord` validates the record shape, then refuses a record
whose schema, scenario id, or `scenarioFingerprint` does not match the
scenario passed in, and a record whose historian-run inventory does not match
the declared run count. Without those checks, re-scoring a run whose same-id
scenario was since edited would evaluate an old database against new gold and
return a verdict that looks valid.

`contextDbSnapshotPath` is still an absolute runner-local path, so a
downloaded artifact does not re-score in place — the snapshot has to be put
back at the recorded path, or the path rewritten. Tracked as
`magic-context-bg4`.

## The raw-output scorer seam (for task x4l.13)

`scoreRawOutput(rawOutput, scenario)` in `src/historian-eval/scorer.ts` is
the layered seam (KTD5): raw historian output -> `parseCompartmentOutput`
-> `validateHistorianOutput` -> publish into a fresh temp DB (production
`appendCompartments` + `promoteSessionFactsDurable`) -> score against gold.
A validation rejection is a stage outcome (`validation-rejected`), never a
crash — that is what the mutation battery asserts on. Metamorphic
invariants (x4l.13) can feed any transformed output through this same seam;
the harness is just one producer of such artifacts. The frozen corpus's
crafted-wrong outputs are also the best TS<->Rust validator differential
vector set the repo has (reuse deferred, see plan scope).

## Verdicts (KTD8)

Per scenario: `PASS | FAIL | ERROR`. FAIL reasons: `false-authoritative`,
`recall`, `structural`, `probe`, `invalid-output`. ERRORs are infra causes
(R6) and are excluded from all rates. The runner raises `lease-lost`,
`no-op-promotion`, `fallback-engaged`, `script-drift`, `gold-range-leak`,
`stale-snapshot`, `run-never-fired`, `probe-envelope-malformed`,
`probe-gold-uncovered`, `probe-response-leak`, `probe-tool-use`, and
`harness-failure`; the scorer adds the record-integrity reasons
`record-malformed`, `record-schema-unsupported`, `record-scenario-mismatch`,
`record-runs-incomplete`, `record-probes-incomplete`, and
`record-snapshot-mismatch`.

A live historian whose every attempt is *rejected by validation* is model
behavior: `FAIL:invalid-output`. Production reuses the same `failed` run
status for chunk-coverage rejections, no-forward-progress, and publish
exceptions, so a run that did not evaluate the historian is not a quality
verdict — the scorer's run inventory admits only a success or a
`validation: `-prefixed failure and reports anything else as
`ERROR:record-runs-incomplete`. Excluding one scenario is recoverable;
booking an outage as model quality is not.
Frozen-release run verdict: red iff any FAIL or any ERROR; exit codes:
0 green, 1 red, 2 run-fatal (false-authoritative).

## Authoring scenarios (U5)

Author latent-truth-first: write the gold expectations graph, then render
the transcript from it. Every declared hard-negative family needs at least
one expected-absent predicate. Gold facts must live before
`epilogueStartIndex` (the discard-last healing epilogue, KTD3). Content
predicates are normalized-substring matchers — pick short distinctive
phrases; the near-miss mutation class proves they still discriminate.

## Operator gates (not automatable from CI)

These plan gates need a human with live-model access; run them before
trusting or freezing the corpus:

1. **U2 prototype gate**: one dev scenario must promote gold facts live
   under the KTD3 trigger recipe
   (`--live --scenarios historian-eval/dev`, check the report + run record).
2. **U5 3-run stability audit**: each scenario's verdict identical across
   three live dev runs; tighten or re-author on instability. Re-audit after
   a system-tuple change may adapt the matcher surface only; latent-truth
   expectations are immutable under re-audit.
3. **Freeze**: confirm the battery is green (`--mutations`), author the
   two approval files
   (`kind: privacy | gold-intent`, bound to the release-tuple fingerprint),
   and call `promoteRelease` from `src/historian-eval/promote.ts`, which
   recomputes the battery itself and publishes the evidence artifact
   beside the corpus. Wrong
   scenario later: tombstone in vN+1; existing releases are never edited.

## Deviations from the plan (discovered at implementation time)

- **Verification bridge (KTD1 conflict).** At HEAD, the claim visibility
  policy admits claims to `auto_inject` only at effective maturity
  VERIFIED+; historian promotions land as CANDIDATE (`model_inference`) and
  are invisible on the literal injection read, which would score every
  scenario at recall 0. The lane measures FORMATION, so after publish it
  records a `verified` outcome for every active claim through the
  production verification operation (`recordProjectMemoryVerification` —
  the dreamer's own path) before probes and scoring. Recorded as
  `verifiedClaimCount` in the run record. See
  `src/historian-eval/verification-bridge.ts`.
- **Claim-memory fragment workaround (upstream bug
  `magic-context-e1c`).** Fresh TS-mode databases lack the claim-memory
  schema fragment, so the production publish transaction's direct-claims
  promotion throws and rolls back (this breaks `historian-success.test.ts`
  at HEAD with a freshly built plugin). The runner installs the fragment
  with the production schema factory before any historian run; remove once
  the runtime installs it itself.
- **Aux-request matcher instead of a pure poison default.** OpenCode fires
  auxiliary title-generation requests that would consume queue-ordered
  scripted turns. Main-agent scripting is matcher-keyed on the exact prompt
  sent; a benign matcher answers title requests; everything unrecognized
  still falls through to the poison default and trips the script-drift
  ERROR.
- **Probe payload capture is scripted-mode only.** In live probe routing
  the request goes to the live provider, so the raw-leak substring check
  runs only when a mock-captured payload exists; the compartment-coverage
  precondition (recomputed from published rows) enforces the leakage gate
  in both modes.
- **Trigger pressure numbers.** The proven recipe fires via the force band
  (~94% usage: `input_tokens` + `cache_creation_input_tokens` both carry
  the spike). Post-epilogue harness-owned padding (sized from the
  production protected-tail target math) pushes the boundary past the
  authored transcript so historian chunks can cover every gold-fact range.
