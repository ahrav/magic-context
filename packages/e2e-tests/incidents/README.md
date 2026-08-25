# Incident regression pool

Register an incident only after `magic-context-x4l.10` approves intake. Approval
comes before catalog or test changes. This directory records accepted incident
identity and history. It does not decide release weights or fix product defects.

## Registration workflow

1. Record source provenance in `source-inventory.json`. Account for each stable
   source item and each distinct claim. Use one closed disposition. Do not turn
   unsupported wording or an audit guide into a reproduction.
2. Assign immutable source-item, source-claim, family, variant, and semantic
   revision IDs. Never reuse an ID for different evidence or behavior.
3. Choose one canonical harness from the source and ownership boundary:
   OpenCode for shared TS behavior, Pi for Pi interface findings, or Rust for
   module-owned behavior. Record why every other harness is inapplicable.
4. Add driver, normalizer, reproduction precondition, and pure verifier under
   `src/incident-pool/scenarios/`. Every executable catalog binding must be
   `live` and returned by `builtinIncidentCaseRegistry()`.
5. Add crafted invalid observations. Verifiers must reject false success text,
   correct content with wrong lifecycle state, incomplete dependency or config
   state, and stale-plus-current coexistence when those states apply.
6. Append a fingerprint-bound baseline event to `adjudications.jsonl`. Green
   wrappers enter `mode-manifest.json`; known-red variants never do.
7. Run incident unit tests, manifest validation, the applicable report command,
   and every mutation replay bound to a changed verifier.

## Semantic revisions

Append a semantic revision and reviewed baseline when any of these changes:

- normative check IDs or meaning;
- canonical harness or applicability reasons;
- green versus known-red lane;
- prerequisites or reviewed `blocked_by` dependencies;
- fixture meaning;
- driver, verifier, or normalizer behavior.

Formatting-only changes do not create a semantic revision. Implementation bytes
remain separately visible through the implementation-bundle digest.

## Append-only history

Accepted source rows, claims, catalog revisions, adjudication prefixes, and
emergency-redaction events are append-only. Correct ordinary mistakes with a
new event. Do not edit, delete, reorder, or rebind accepted history.

Emergency redaction is the only destructive exception. A reviewed entry in
`emergency-redactions.jsonl` must bind the protected base commit, exact old and
new digests, prohibited-data class, preserved logical IDs and order, and Code
Review reference. Revoke exposed credentials and purge affected artifacts
outside this repository when required. Never use emergency redaction for an
ordinary correction.

CI derives its accepted commit from the trusted GitHub event payload. Pull
requests use the checked-out merge commit's base SHA. Protected default-branch
pushes use the pushed commit's `before` SHA. The validator fetches that commit
and rejects missing, all-zero, overridden, or non-ancestor bases.

## Evidence and mutation replay

Mutation JSON remains committed source evidence. Inventory links normalize the
current artifacts and records without rewriting them. Normal report runs check
those links but do not replay mutations.

Changing an executable verifier requires serial replay of every mutation record
bound to that verifier. Each crafted invalid state must still produce the
reviewed red result before merge. Keep observed-red and reverted-green evidence.

CI currently enforces a conservative contributor gate: it derives each bound
verifier's bytes from the trusted event base and rejects any drift. The gate
does not claim replay occurred and has no replay-evidence ingestion path yet.
Land verifier changes only after adding reviewed replay support to that gate.

## Publication and privacy

Use synthetic fixtures only. Published reports allow only schema IDs, family and
variant IDs, semantic and implementation digests, baseline IDs, static check and
reason codes, harness, counts, and result classifications.

Never publish prompts, session or memory bodies, historian dumps, credentials,
ambient paths, raw stdout or stderr, exception text, or untrusted process output.
Raw diagnostics stay capped in owner-only case workspaces and are deleted during
teardown. Historian containment cases may inspect synthetic canaries only to
emit static facts.

## Lanes and incomplete results

Baseline-green variants block ordinary mode-manifest suites through
`tests/incident-pool-green.test.ts`. Baseline-red variants execute only in the
separate incident report lane. Preserve the normative failed verdict; do not
invert it into a passing characterization.

`completed`, `timeout`, `crash`, `unavailable`, and `malformed` describe run
health. `pass`, `assertion_fail`, and `not_evaluated` describe behavior.
`expected_green`, `regression`, `expected_red`, `unexpected_failure`,
`resolution_candidate`, and `unscored` compare the reviewed baseline.

Missing prerequisites report `unavailable`, `not_evaluated`, and `unscored`.
Failed reproduction preconditions remain unscored. Only incomplete results whose
static dependency exactly matches reviewed `blocked_by` data may leave the
incident command successful. Every other unhealthy or incomplete result returns
nonzero. A passing known-red case is a `resolution_candidate`; it stays in the
pool until reviewed adjudication changes its baseline.
