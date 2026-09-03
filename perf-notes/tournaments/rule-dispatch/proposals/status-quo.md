# Proposal: Preserve Sequential Per-Rule Evaluation

## 1. Decision summary

Keep the current evaluator unchanged. Scan every active rule in sorted order, charge `n` work bytes before each scan, run `captures_iter`, collect findings, then apply the existing final sort.

This proposal is the correctness and security baseline. It preserves every hard gate but does not improve zero-finding throughput.

## 2. Assumptions and boundaries

- **Verified:** 238 sequential regex scans dominate Comprehensive mode.
- **Verified:** `regex_automata::hybrid::search::find_fwd` consumes 95.9-96.1% of measured cycles.
- **Verified:** A zero-finding 128 KiB scan takes about 22.9 ms and charges `31,195,136 = 238 * n` work bytes.
- **Verified:** Every rule has anchors, but the evaluator does not use them.
- **Verified:** Rules and final findings are sorted.
- **Verified:** The frozen differential evaluator detects skipped rules and work-accounting mismatches.
- **Unverified:** Individual regex compilation dominates construction cost or memory.
- **Unverified:** Current dense and anchor-saturated benchmark values.
- **Unverified:** The exact memory footprint of the 238 compiled regexes.

Boundaries:

- No corpus, mode, digest, public API, or output changes.
- No anchor dispatch, combined automaton, or scalar regex optimization.
- Safe Rust remains enforced through the existing `forbid(unsafe_code)` boundary.
- Existing `ScanError`, work-limit, and candidate-accounting behavior remains authoritative.

## 3. Concrete design

Retain the canonical evaluator:

```text
for rule in rules.active, in existing sorted order:
    add_work(input.len())?
    for captures in rule.regex.captures_iter(input):
        build findings through the existing path

sort findings through the existing comparator
return findings and existing accounting
```

Retain the current construction path:

1. Load the byte-identical rule corpus.
2. Sort rules using the current ordering.
3. Compile each rule independently using the current regex configuration.
4. Store anchors but do not consult them during evaluation.
5. Compute semantic digest v2 through the existing path.

Invariants remain enforced at their current locations:

- `add_work(n)` executes once per active rule and before that rule's regex search.
- A work-limit failure occurs at the same rule boundary.
- Every active rule receives the full input.
- `captures_iter` preserves each rule’s current match and capture semantics.
- Rule traversal and final sorting preserve output order and spans.
- No dispatch index can become stale because no index exists.
- Adversarial input cannot bypass a rule or reduce charged work.

No new state, dependency, cache, configuration, or rollout mode is introduced.

## 4. Scenario analysis

### Zero-anchor 128 KiB input

- **Mechanism:** All 238 regexes scan the full input.
- **Response:** Exact behavior is preserved. Performance does not improve.
- **Sensitivity:** Regex search cost per rule and input length.
- **Evidence:** Supplied measurement is about 22.9 ms and 31,195,136 work bytes.
- **Failure behavior:** Runtime remains linear in active rules times input length. Existing work limits still terminate at the same point.

This proposal fails the performance intent if improvement is feasible under the hard gates.

### Dense input with 80 findings

- **Mechanism:** Existing per-rule `captures_iter` processing and final sort.
- **Response:** No regression relative to the current evaluator.
- **Sensitivity:** Match count, capture extraction cost, and final sorting cost.
- **Evidence:** Structural equivalence to the current implementation. No dense benchmark figure was supplied.
- **Failure behavior:** Existing allocation, work-limit, and `ScanError` behavior remains unchanged.

### Anchor-saturated adversarial storm

- **Mechanism:** Anchors have no effect on dispatch. Every rule runs.
- **Response:** No regression relative to current behavior, but no protection beyond existing bounded work.
- **Sensitivity:** Regex worst-case behavior within `regex_automata` and configured work limits.
- **Evidence:** The current evaluator already ignores anchors.
- **Failure behavior:** The evaluator charges the same work and returns the same findings or `ScanError`. Saturated anchors cannot amplify dispatch work because dispatch is absent.

### `max_work = 1` and boundary `±1`

- **Mechanism:** Preserve the position and arithmetic of `add_work(n)`.
- **Response:** Exact current outcomes are preserved.
- **Sensitivity:** Input length, active-rule count, overflow handling, and whether the next `add_work` crosses the limit.
- **Evidence:** No code changes affect accounting or error timing.
- **Failure behavior:** The same rule boundary returns the same `ScanError`; no regex execution is skipped before the accounting check.

### Construction cost and memory

- **Mechanism:** Keep independent per-rule compilation and storage.
- **Response:** No construction or memory regression.
- **Sensitivity:** Corpus size, regex compiler configuration, and compiled automaton sizes.
- **Evidence:** Structural equivalence only. Absolute values were not supplied.
- **Failure behavior:** Construction failures remain unchanged.

Acceptance measurement must record construction wall time, peak or retained memory, and compiled-rule count for the unchanged baseline.

## 5. Failure and operations

- **Overload:** CPU cost remains approximately proportional to active rules times input bytes. Existing bounded-work behavior remains intact.
- **Partial failure:** Construction and scan errors propagate through existing paths.
- **Recovery:** No new persisted or derived state requires rebuilding.
- **Rollout:** None. This is the deployed mechanism.
- **Rollback:** Not applicable.
- **Observability:** Preserve current timing, finding, candidate, work-byte, and error metrics.
- **Security:** No false-negative dispatch path is introduced. Adversarial inputs receive the same exhaustive evaluation and accounting.
- **Operator error:** No generated dispatch artifact, anchor index, or tuning parameter can drift from the corpus.

The operational cost is continued high CPU use for zero-finding and sparse inputs.

## 6. Alternatives rejected

### Anchor-based rule prefilter

Reject for this proposal because skipping regex execution creates new proof obligations for false negatives, candidate accounting, work accounting, and exact work-limit error timing. The supplied evidence does not establish that an anchor filter can satisfy those gates.

### Combined multi-pattern automaton

Reject because it changes compilation, match arbitration, capture extraction, ordering, memory behavior, and likely error boundaries. It requires broad equivalence proof and may duplicate regex work when full captures still need per-rule evaluation.

### Parallel per-rule evaluation

Reject because it adds scheduling and merge complexity while retaining the same aggregate regex work. Exact error timing, deterministic ordering, and bounded-work behavior become harder to preserve.

## 7. Discriminating claims to verify

| Claim | Falsification check |
|---|---|
| The unchanged evaluator is finding-, order-, span-, accounting-, and error-exact. | Run the frozen differential evaluator over normal, dense, boundary, and adversarial corpora. Any difference refutes the claim. |
| Zero-anchor 128 KiB remains near 22.9 ms and 31,195,136 work bytes. | Re-run the benchmark with the same build, corpus, input, and machine controls. |
| Dense and anchor-saturated inputs do not regress. | Establish current distributions, then compare repeated benchmark medians and tails against the same binary baseline. |
| Construction cost and memory remain unchanged. | Measure compile wall time and retained or peak memory from identical fresh processes. |
| Bounded-work security remains exact at `max_work = 1` and every relevant boundary `±1`. | Differentially test returned findings, counters, and `ScanError` for each boundary. |
| Semantic digest v2 remains unchanged. | Compare digest bytes for the frozen corpus. |
| No zero-anchor improvement exists in this mechanism. | Profile the unchanged path. Any meaningful reduction without changing mechanism or excluded scalar optimization refutes the claim. |

## 8. Trade-offs and kill condition

This design optimizes correctness, security, complexity, and reversibility. It sacrifices the requested zero-anchor performance improvement and retains the known `238 * n` scan cost.

**Kill condition:** Reject this proposal if any eligible mechanism demonstrates a material zero-anchor improvement while passing frozen differential checks, exact work-boundary tests, adversarial tests, and acceptable dense, storm, construction, and memory thresholds.
