# Prospective release holdout

This directory stores public control artifacts for prospective Magic Context release evaluation. Raw reports, transcripts, customer identifiers, concealed build maps, commitment keys, and unblinding secrets never belong here.

`trusted-manifests.jsonl` is the external trust anchor. Protected review owns each append. Epoch publishers cannot edit accepted entries. An empty registry is valid before the first real release freeze.

## Prerequisites

A real freeze is blocked until all conditions hold:

- `magic-context-x4l.14` publishes the versioned estimator, pairing, clustering, and missingness policy in `policies/analysis-policy.json`.
- `magic-context-x4l.15` publishes the versioned scorecard, hard gates, weights, tolerated regressions, and minimum-evidence policy in `policies/scorecard-policy.json`.
- Release N and the previous promoted N-1 exist as promoted, immutable release-root manifests for the same channel and platform matrix.
- Required OpenCode, Pi, Rust, database-template, harness, evaluator, prompt, model, decoding, lockfile, and runtime bytes are available by digest.
- Independent protected review can append freeze and lifecycle fingerprints to the trust registry.

Current policy documents have `status: "pending"`. This is intentional. Do not replace them with placeholder values. U7 cannot run until both sibling owners publish real policies and real promoted release roots exist.

U9 cannot run until a real cohort closes, comparison reaches a terminal report, and every admitted case passes second privacy review over exact incident bytes. Do not add placeholder incident rows or scenarios.

## Roles and custody

| Actor | May access | Must not access before close |
| --- | --- | --- |
| Release operator | Promoted release manifests, supplied approvals, public lifecycle artifacts | Raw intake, concealed map secret |
| Intake custodian | Owner-controlled quarantine, retention and deletion evidence | Runner outcomes, build identities, comparative diagnostics |
| Admission reviewer | Sanitized synthetic case and frozen rubric | Runner outcomes, build identities, concealed map |
| Adjudicator | Randomized `build-A` and `build-B` packet | Release path, version, hash, timestamp, ordering cue, concealed map |
| Release reviewer | Trusted final report, limitations, family misses, gate status | Raw intake and secret commitment material |

Custodian and admission-reviewer access evidence must show no access to runner stores, build identities, diagnostics, or concealed maps. Any access breach invalidates the epoch.

## Workflow

1. **Freeze**
   - Select release N and previous promoted N-1 in one channel and platform matrix.
   - Materialize both roots from promoted artifacts. Never rebuild during freeze.
   - Import real x4l.14 and x4l.15 policy documents without changing values.
   - Supply independent tuple-bound approvals.
   - Publish `freeze/manifest.json` once, append protected trust entries, then append the prebuilt `frozen` lifecycle event.
2. **Open intake**
   - Verify freeze, lifecycle, and external trust from a clean consumer path.
   - Append a prebuilt `intake-open` event.
   - Only then accept new reports into owner-controlled quarantine.
3. **Review intake**
   - Run privacy review before schema parsing or diagnostics.
   - Convert approved material to a minimal synthetic case.
   - Apply frozen admission rubric without comparative outcomes.
   - Retain only opaque IDs, keyed commitments, allowlisted provenance, and static rejection codes.
4. **Close cohort**
   - Stop intake at frozen cutoff under create-if-absent lock.
   - Classify each intake exactly once as admitted, rejected, or late.
   - Verify deletion evidence for raw files, temporary files, logs, caches, and backups.
   - Publish close once, append protected trust entry, then append `cohort-closed` event.
5. **Compare**
   - Validate close-to-registry bijection and implementation bundle digests.
   - Reverify both release roots before each cell.
   - Run A/A first. Stop on asymmetry or identity leakage.
   - Retry both arms together under frozen retry limit.
   - Preserve product crashes and invalid output as failures. Preserve infrastructure failures as incomplete pairs.
   - Append `running` event bound to retained outcomes.
6. **Adjudicate**
   - Keep deterministic checks unblinded.
   - Use only bounded `build-A` and `build-B` packets for subjective checks.
   - Authenticate packet-bound judgments and publish adjudication close once.
   - Require separate approval before verifying concealed map or unblinding.
7. **Report**
   - Invoke estimator owned by `magic-context-x4l.14` and scorecard owned by `magic-context-x4l.15`.
   - Recompute the complete estimator and scorecard result through those sibling-owned adapters during repository validation. Local code recomputes only deterministic pair summaries and does not duplicate sibling thresholds or directional math.
   - Keep prospective and permanent incident-pool sections separate.
   - Apply decision precedence: invalidated, observed hard-gate failure, insufficient evidence, directional decision.
   - Missing gate evidence, insufficient evidence, invalidation, hard-gate failure, or unavailable trust blocks promotion.
8. **Graduate**
   - Run second privacy review over exact incident bytes.
   - Create one prospective source contract per admitted case, including cases both releases pass.
   - Validate source against trusted close commitment.
   - Append candidates idempotently, add real incident scenario modules, then append `graduated` event.

## CLI

Run repository validation:

```sh
bun run --cwd packages/e2e-tests validate:prospective-holdout
```

Append a prebuilt, already approved lifecycle event:

```sh
bun packages/e2e-tests/scripts/prospective-holdout.ts freeze <ledger> <event.json>
bun packages/e2e-tests/scripts/prospective-holdout.ts open-intake <ledger> <event.json>
bun packages/e2e-tests/scripts/prospective-holdout.ts close <ledger> <event.json>
bun packages/e2e-tests/scripts/prospective-holdout.ts compare <ledger> <event.json>
bun packages/e2e-tests/scripts/prospective-holdout.ts report <ledger> <event.json>
bun packages/e2e-tests/scripts/prospective-holdout.ts graduate <ledger> <event.json>
bun packages/e2e-tests/scripts/prospective-holdout.ts invalidate <ledger> <event.json>
```

CLI validates and appends. It does not create approvals, unblind maps, edit tracker state, publish releases, or run live models. Validation of any ready-policy epoch requires installed `magic-context-x4l.14` estimator and `magic-context-x4l.15` scorecard adapters; pending-policy empty repositories need neither.

## Intake close checklist

Cohort close blocks unless every submitted intake has:

- privacy decision;
- synthetic conversion or static rejection rationale;
- frozen-rubric admission decision;
- family assignment for admitted cases;
- deletion evidence for raw, temporary, log, cache, and backup stores;
- outcome-blind custody evidence;
- included, rejected, or late disposition exactly once.

Bug closure remains blocked until prospective disposition, privacy decision, conversion or rejection rationale, family assignment, second privacy approval, and graduation status are recorded.

## Recovery and invalidation

Publication uses create-if-absent destinations. Retry identical interrupted work. Never overwrite an installed artifact. A conflicting retry fails.

If policy, suite, identity, root, evaluator, prompt, model, seed, missingness, exclusion, gate, or stopping fields change after freeze, append an `invalidated` event. Preserve original artifacts and outcomes as descriptive evidence. Start a new epoch. Cases submitted before new freeze cannot enter its prospective cohort.

If publication stops after cohort marker creation but before close installation, keep intake closed and retry identical close construction from retained static decisions. Do not reopen intake. If trust verification fails, stop comparison and promotion.
