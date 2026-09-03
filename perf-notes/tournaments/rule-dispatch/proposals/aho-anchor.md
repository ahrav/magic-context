# Proposal: ASCII-Folded Aho-Corasick Absence Filter

## Decision frame

- **Decision owner:** AhravDutta
- **Problem:** Comprehensive scanning performs 238 sequential regex scans. `regex_automata::hybrid::search::find_fwd` consumes 95.9-96.1% of cycles. A zero-finding 128 KiB scan takes about 22.9 ms. Work scales as `238 * input_len`.
- **Decision:** Add one immutable Aho-Corasick index over certified per-rule anchors. Use it only to prove that a rule cannot match. Continue to run the existing regex implementation for every rule whose anchor may occur.
- **Evidence mode:** Frame-only. No code, benchmark, or external evidence was inspected.

### Hard gates

The design is ineligible if it changes:

- Findings, order, or spans for any input.
- `candidates_evaluated`, `work_bytes`, or `ScanError`.
- Per-rule `add_work` order.
- Candidate processing order.
- Bounded-work security.
- Semantic digest v2 or public APIs.
- Safe Rust requirements.
- Immutable corpus behavior.
- Adversarial performance materially.

### Non-goals

- Replacing regex matching.
- Deriving anchors automatically.
- Unicode case folding.
- Changing work-accounting semantics.
- Changing the corpus format, public API, or semantic digest.
- Reordering rules by anchor or expected selectivity.

### Criteria

| Criterion | Weight |
|---|---:|
| Correctness | 30 |
| Performance | 30 |
| Security | 20 |
| Complexity | 15 |
| Reversibility | 5 |

## 1. Decision summary

Build one ASCII case-insensitive Aho-Corasick automaton from supplied mandatory anchors. Scan the input once and record which rules may match. During the existing rule loop, preserve all accounting and ordering, but skip the regex search when the rule’s mandatory anchor is absent.

Use the optimization only when bounded-work enforcement is disabled or when the caller has provable headroom for the extra input pass. Otherwise use the status-quo path.

## 2. Assumptions and boundaries

### Verified from the supplied frame

- The corpus is immutable.
- Each optimized rule has a supplied anchor.
- Some anchors require ASCII case-insensitive matching.
- The existing rule order, accounting, errors, and findings are observable.
- A frozen differential test compares the complete `ScanReport`.
- Comprehensive scanning currently performs 238 sequential regex scans.

### Unverified assumptions

- **A1:** Each selected anchor is mandatory for every match of its rule. This includes every regex branch.
- **A2:** The anchor certification identifies whether ASCII folding is sufficient for the corresponding regex semantics.
- **A3:** Internal rule metadata can hold an automaton pattern ID without changing public APIs or semantic digest v2.
- **A4:** `candidates_evaluated` can retain its legacy logical increment even when the proven-absent regex call is skipped.
- **A5:** The scanner can distinguish bounded from effectively unbounded work execution.
- **A6:** An Aho-Corasick implementation is already available or can be implemented through an existing dependency without adding unsafe code.
- **A7:** Construction can disable the optimization on unsupported anchors without introducing a new public error.

If A1, A2, or A4 is false, this proposal fails its correctness gate.

### Anchor eligibility

A rule is eligible only when its selected anchor is:

- Non-empty.
- A literal byte sequence.
- Present in every possible match.
- Valid under ASCII-sensitive or ASCII-insensitive matching.
- Independent of match position.

Rules without a certified eligible anchor always use the existing regex path.

Non-ASCII case folding is unsupported. A rule whose anchor requires Unicode folding remains unfiltered.

## 3. Concrete design

### 3.1 Immutable derived index

Add private, derived corpus state:

```rust
struct AnchorPrefilter {
    matcher: AhoCorasick,
    pattern_rules: Vec<Vec<RuleIndex>>,
    anchored_rules: BitSet,
}
```

The exact containers should reuse existing types. One direct pattern-to-rule mapping is enough when each rule has one selected anchor.

The automaton and mappings are derived acceleration data:

- Excluded from semantic digest v2.
- Not serialized as semantic corpus content.
- Immutable after corpus construction.
- Rebuilt when a corpus is constructed.
- Invisible to public APIs.

Duplicate anchors share one automaton pattern and map to multiple rules.

### 3.2 Case handling

Compile a single ASCII case-insensitive automaton for all eligible anchors.

Using ASCII-insensitive matching for a case-sensitive anchor can create false positives, but not false negatives. It may cause an unnecessary regex scan, which preserves correctness. It avoids a second input pass and a second automaton.

An anchor certification error that could create a false negative is forbidden.

### 3.3 Scan result

The prefilter scans the complete input once and creates a bitset:

```text
anchor_maybe_present[rule_index]
```

A bit is set when any occurrence of the rule’s selected anchor is found. The scan may stop tracking a pattern after its first occurrence, but it must continue until all input is consumed or all anchored rules are marked present.

No match offsets are needed. The prefilter proves absence only.

### 3.4 Existing rule loop

Keep the existing loop and its side effects in their current order:

```rust
for rule in rules_in_existing_order {
    add_work_exactly_as_before(rule, input)?;

    update_candidates_evaluated_exactly_as_before(rule);

    if rule.has_eligible_anchor()
        && !anchor_maybe_present.contains(rule.index())
    {
        continue;
    }

    run_existing_regex_and_process_candidates(rule, input)?;
}
```

The actual placement of `candidates_evaluated` must match current behavior. The pseudocode does not authorize moving it.

The prefilter must not:

- Reorder rules.
- Emit candidates.
- Produce spans.
- Change regex start positions.
- Replace regex matching after an anchor hit.
- Short-circuit existing accounting.

For any rule marked present, the original regex search and candidate processing run unchanged.

### 3.5 Bounded-work mode

The prefilter performs an extra `input_len` byte pass that cannot be added to public `work_bytes` without violating report compatibility.

Therefore:

1. If bounded-work enforcement can produce a low-limit error, use the status-quo path.
2. The optimized path may run when work is explicitly unbounded.
3. It may also run when the implementation can prove at entry that the work limit has at least one full input pass of spare capacity beyond a conservative upper bound for all legacy work in this scan.
4. If that proof is unavailable or could overflow, use the status-quo path.

Do not use estimated anchor density or historical behavior to grant the optimized path.

This fallback preserves exact `ScanError`, the location and order of `add_work` calls, and the amount of work performed before a low-limit error.

### 3.6 Construction failure

Unsupported or uncertified anchors are omitted individually.

If automaton construction reports an ordinary recoverable failure, disable the entire prefilter and retain the existing scanner. Do not add a new public construction error. Allocation failure retains normal Rust process behavior.

## 4. Scenario analysis

### 4.1 128 KiB zero-anchor scan

**Mechanism:** One Aho-Corasick pass clears every eligible rule whose anchor is absent. The rule loop retains accounting but avoids most or all regex searches.

**Expected response:** Work shifts from about 238 regex passes to one literal pass plus 238 cheap bit checks and accounting calls.

**Sensitivity:** The number of rules with certified anchors and automaton constant factors.

**Evidence:** The speedup is unverified until benchmarked.

**Failure behavior:** If the automaton is not faster, disable the private prefilter and retain status quo.

### 4.2 Dense input with 80 findings

**Mechanism:** Rules with absent anchors are skipped. Rules with present anchors use the existing regex and candidate path.

**Expected response:** Findings, order, spans, counters, and errors remain identical. Performance depends on how many distinct rule anchors occur, not the finding count alone.

**Sensitivity:** False-positive anchor hits and the number of matching rules.

**Failure behavior:** Dense anchor presence reduces the benefit. It must not change output.

### 4.3 Anchor-saturated adversarial storm

**Mechanism:** Every anchored rule is marked present, so all legacy regex scans run after the prefilter.

**Expected response:** Worst-case work adds one linear Aho-Corasick pass to the current 238 regex passes. The nominal byte-pass increase is about `1 / 238`, or 0.42%, but cache effects are unverified.

**Sensitivity:** Automaton size, failure transitions, cache behavior, and input composition.

**Failure behavior:** Reject or disable the prefilter if adversarial benchmarks show a material regression under the project’s agreed threshold.

### 4.4 `max_work = 1` and boundary values

**Mechanism:** The bounded-work eligibility check chooses the status-quo path before reading input through the prefilter.

**Expected response:** The same `add_work` call fails at the same rule and returns the same `ScanError`. Boundary values produce the same full report or error as before.

**Sensitivity:** Correct classification of bounded execution and overflow-safe headroom calculation.

**Failure behavior:** Any differential mismatch makes the optimization ineligible.

### 4.5 Construction and memory

**Mechanism:** Build one deduplicated automaton and compact rule mappings when the immutable corpus is constructed.

**Expected response:** Construction and resident memory grow with total unique anchor bytes and automaton states, not input size.

**Sensitivity:** Short overlapping anchors can increase transitions and reduce selectivity.

**Failure behavior:** Disable the prefilter if construction time or memory exceeds an agreed budget. Corpus scanning remains available through status quo.

## 5. Failure and operations

- **False-negative anchor result:** Causes missed findings. This is a release blocker.
- **False-positive anchor result:** Causes an unnecessary regex scan. Output remains correct.
- **Bad supplied anchor:** Treat anchor certification as trusted corpus metadata only after differential and targeted validation.
- **Counter drift:** The frozen full-report differential must cover successful and failing scans.
- **Integer overflow:** Use checked arithmetic for any headroom proof. Overflow selects status quo.
- **Construction regression:** Measure corpus build latency and resident bytes.
- **Rollback:** Remove or disable the private prefilter. No corpus migration or API rollback is required.
- **Observability:** Benchmark counters may record prefilter use, rules cleared, and anchor saturation. They must not enter `ScanReport` or semantic digest v2.
- **Security:** Never run unaccounted prefilter work on a path that may fail due to an insufficient work limit.

## 6. Alternatives rejected

### Per-rule case-insensitive substring search

This still performs up to 238 input scans. It replaces regex work with literal work but retains `238 * n` traversal and scales poorly on zero-anchor input.

### Reordering rules by anchor occurrence

This could improve locality but changes `add_work`, candidate, finding, and error order. It violates hard gates.

### Running regex only from anchor offsets

A mandatory anchor does not establish the regex match start. Prefixes may be variable or unbounded. This requires regex-specific proofs and risks changed spans or missed matches.

### Charging the prefilter through public `work_bytes`

This changes `work_bytes`, boundary errors, and potentially `ScanError`. It violates exact report compatibility.

### Unicode-folded prefilter

Unicode case folding introduces larger semantic and implementation risk. The stated need is ASCII case-insensitive matching. Unsupported rules can remain on the existing path.

## 7. Discriminating claims and falsification checks

| ID | Claim | Falsification check |
|---|---|---|
| F1 | Every filtered rule’s anchor is mandatory under its regex semantics. | For each rule, generate or enumerate regex matches and assert the ASCII-folded anchor occurs. Add hand cases for alternation, optional groups, escapes, and scoped `(?i:...)`. Any counterexample rejects that anchor. |
| F2 | ASCII-folded Aho-Corasick has no false negatives for eligible anchors. | Differentially compare each automaton pattern against a simple byte-window ASCII-fold reference over random bytes and exhaustive short inputs. |
| F3 | Full scan behavior is exact. | Run the frozen differential on both paths and compare the complete `ScanReport`, including finding order, spans, `candidates_evaluated`, and `work_bytes`. |
| F4 | Work-limit behavior is exact. | Test `max_work` at `0`, `1`, `n-1`, `n`, every per-rule boundary around `k*n`, candidate-charge boundaries, and overflow-adjacent values. Compare the exact `ScanError`. |
| F5 | Zero-anchor performance improves materially. | Benchmark 128 KiB zero-anchor inputs against status quo with identical corpus, build, CPU pinning, and warmup. Reject if the agreed speedup target is missed. |
| F6 | Dense findings remain exact and faster or neutral. | Run the supplied 80-finding corpus through the full-report differential and benchmark both paths. |
| F7 | Saturated storms do not regress materially. | Construct inputs containing every anchor repeatedly. Measure throughput, cycles, allocations, and peak RSS. Reject if regression exceeds the agreed threshold. |
| F8 | Construction and memory remain acceptable. | Measure corpus construction time, automaton states, serialized semantic digest, and resident bytes. Assert digest v2 is byte-identical. |
| F9 | Bounded scans never execute the prefilter without proven headroom. | Instrument prefilter entry in tests. Assert zero entries for every low-limit and boundary-error case. |
| F10 | Public APIs remain unchanged. | Run existing API compatibility and semantic digest tests. Inspect the public API diff; any new public item fails the gate. |

## 8. Trade-offs and kill condition

The design optimizes the common case where most mandatory anchors are absent. It sacrifices one extra linear pass when anchors are saturated and adds derived corpus memory.

Reject the proposal if any of these occur:

- A filtered rule can match without its anchor.
- Full `ScanReport` or `ScanError` differs for any differential input.
- Low-limit scans execute unaccounted prefilter work.
- The 128 KiB zero-anchor benchmark does not improve materially.
- Anchor-saturated input regresses materially.
- Construction or memory exceeds the accepted budget.
- The implementation requires public API or semantic digest v2 changes.

**Evidence status:** Weak until F1-F10 are executed. The design is reversible because the index is private, derived, and bypassed by the status-quo path.
