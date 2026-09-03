# Proposal: Hybrid Case-Insensitive Anchor Gate Plus Find-Then-Capture

## 1. Decision summary

Build one prepared ASCII-insensitive Aho-Corasick index over conservatively proven mandatory anchors. Use it only to eliminate rules whose anchors are absent. Process surviving rules in original order with `find_iter`, then resolve captures against the full haystack at each found start.

Retain the frozen `captures_iter` path as an internal fallback for low `max_work`, dense matches, anchor saturation, unsupported anchors, construction failure, and invariant-check failure. The optimization changes no public API, digest, corpus, observable work accounting, candidate ordering, findings, spans, captures, or errors.

**Decision owner:** AhravDutta  
**Evidence mode:** Frame-only. All quantitative claims below remain unverified until benchmarked.

## 2. Assumptions and boundaries

| Assumption | Status |
|---|---|
| The current scan charges work once per rule in rule order. | Verified from supplied frame. |
| The frozen differential oracle compares findings, order, spans, candidates, work, and errors. | Verified from supplied frame. |
| `find_iter` and `captures_iter` use identical group-0 leftmost-first iteration semantics. | Unverified. Must be checked against the pinned regex implementation. |
| Capture lookup can start at an offset while retaining full-haystack context. | Unverified. Required for anchors and boundaries. |
| Rules are prepared once and reused across scans. | Unverified. |
| Existing dependencies expose Aho-Corasick and conservative regex syntax analysis. | Unverified. |
| Internal prepared indexes do not contribute to the public digest. | Unverified. |

Boundaries:

- Safe Rust only.
- No corpus or regex rewriting.
- No public API, serialization, or digest changes.
- No change to regex semantics.
- No approximate filtering. False-positive survivors are allowed; false-negative survivors are not.
- No new externally visible errors.
- No unbounded anchor-hit collection.
- No speculative parallelism or caching.

## 3. Concrete design

### Prepared state

Extend the existing private prepared-rule collection with:

```rust
struct AnchorGate {
    automaton: AhoCorasick,
    pattern_rules: Vec<Box<[usize]>>,
    gated_rules: BitSet,
}
```

Keep this state private and excluded from digest calculation.

Deduplicate identical anchors. Map each Aho-Corasick pattern ID to every rule using that anchor. Rules without a proven anchor remain permanently eligible.

### Conservative anchor proof

Accept an anchor only when preparation proves:

```text
every match of rule R contains a byte occurrence accepted by AC pattern A
```

Use a conservative syntax walk:

- Literal concatenation contributes a mandatory anchor.
- Concatenation may select a mandatory anchor from any required child.
- Alternation contributes an anchor only when every branch proves the same anchor.
- Repetition contributes its child anchor only when its minimum is at least one.
- Capturing and non-capturing groups inherit the child result.
- Optional constructs, wildcard classes, unsupported classes, and empty branches yield no anchor.
- Unicode case-insensitive regions yield no anchor.
- ASCII-only case-insensitive regions may yield a folded ASCII anchor.
- Case-sensitive ASCII literals are safe in the insensitive automaton because extra case variants only create false positives.

Choose one longest proven anchor per rule. Resolve ties deterministically by byte order. This choice affects performance only.

### Scan selection

Use the frozen baseline immediately when:

- remaining `max_work` cannot cover all per-rule charges that the baseline would necessarily perform;
- no useful gate was built;
- the haystack is below a benchmark-selected minimum length;
- prepared-index construction was rejected for memory or latency;
- a previous internal invariant check disabled the optimization.

The low-work fallback prevents a full haystack gate scan from moving ahead of an error that baseline processing would return after only a few rule charges.

### Anchor gate

Initialize survivors with all ungated rules. Scan the haystack using overlapping Aho-Corasick enumeration so one anchor cannot hide another through non-overlapping match selection.

For every anchor hit, mark all mapped rules as survivors. Do not emit rules in automaton order.

Abort the gate and run the frozen baseline when either limit is crossed:

- survivors reach 25% of all rules;
- raw anchor hits reach 512.

These constants are private safety limits, not configuration or API. Benchmarks may lower them before merge. Raising them requires rerunning the storm tests.

The raw-hit limit bounds cases such as repeated `a` with anchors `a`, `aa`, and `aaa`.

### Rule processing

After a completed sparse gate:

1. Iterate every rule in original order.
2. Perform the existing per-rule work charge and `max_work` check at the original location.
3. If the rule has a proven absent anchor, continue.
4. If the rule has no anchor or survived the gate, run the regex path.
5. Preserve all existing candidate and result insertion code.

The gate bitset never determines output order.

### Find-then-capture

For each survivor:

1. Run `find_iter` on the original full haystack.
2. For each group-0 match, resolve captures from `match.start()` against the same full haystack.
3. Require the resolved group-0 span to equal the span returned by `find_iter`.
4. Stage results in a per-rule scratch buffer before changing observable result state.
5. Commit staged results through the existing candidate, work, and error path.

Never slice the haystack before capture resolution. Slicing would change `^`, `$`, multiline anchors, word boundaries, and surrounding-context behavior.

If capture resolution cannot reproduce group 0 exactly, discard staged results and run the frozen baseline for that rule.

After nine matches are observed for one rule, discard its staged optimized results and run the baseline for that rule. This caps duplicate dense-match work at eight completed capture resolutions plus one detection.

`find_iter` drives advancement, including empty-match UTF-8 advancement. Capture resolution never advances the iterator.

### Required invariants

- Every gated rule has a sound mandatory anchor proof.
- An absent anchor can only suppress a zero-finding rule.
- AC match order never affects rule order.
- Group-0 spans from find and capture agree before commit.
- Captures receive the original haystack and original offset.
- Existing code performs every observable charge, candidate insertion, and error decision.
- Every optimization failure falls back before observable mutation.

## 4. Scenario analysis

| Scenario | Mechanism and expected response | Sensitivity | Failure behavior |
|---|---|---|---|
| Zero-anchor 128 KiB | One AC pass marks no gated rules. The scan then charges rules in order without running their regex engines. This should remove most of the measured 238 `find_fwd` scans. | Fraction of rules with sound anchors and AC scan cost. | Ungated rules still use baseline regex. Reject if improvement is below 5x from the supplied 22.9 ms baseline. |
| 80-finding dense | At least 25% survivors trigger whole-scan baseline. Concentration in one rule triggers its nine-match fallback. | Distribution of findings and correlation between anchors and findings. | Baseline semantics and bounded small speculative overhead. |
| Anchor saturated | Survivor or raw-hit threshold aborts AC enumeration. | How late saturation occurs in the haystack. | Run the frozen baseline. Added cost is bounded to one AC pass or 512 reported hits. |
| `max_work` boundaries | Low remaining work bypasses the gate. Otherwise rules retain the original charge and check order. | Exact current charge placement. | Frozen baseline handles any boundary not proven equivalent. |
| Construction and memory | Build one immutable, deduplicated automaton with compact rule mappings. Reuse per scan. | Number and length of distinct anchors and automaton representation. | Disable the optimization if construction or retained memory exceeds the acceptance budget. No new public error. |

## 5. Failure and operations

- **Overload:** AC processing is linear in input plus reported hits. Reported hits are capped before fallback.
- **Dense regex matches:** Per-rule staging is capped at eight committed candidates before baseline retry.
- **Partial construction:** Discard the private gate and retain the baseline scanner.
- **Allocation failure:** Do not introduce recoverable behavior that differs from existing allocation policy. Avoid per-hit allocation.
- **Rollout:** Place the optimized path behind a private default-off switch for oracle and benchmark runs. Remove the switch or enable it only after gates pass.
- **Rollback:** Delete or disable the prepared gate. The frozen baseline remains intact.
- **Observability:** Add benchmark-only counters for gated rules, survivors, raw hits, saturation fallbacks, dense fallbacks, and capture mismatches. Do not expose them through the public result.
- **Security:** Reject Unicode-fold-sensitive anchors. Cap overlap enumeration and speculative capture work. Use checked offsets and safe Rust.
- **Operator error:** No tuning surface is public. Internal constants remain covered by regression benchmarks.

## 6. Alternatives rejected

1. **Run `captures_iter` for every rule after AC filtering.**  
   This captures the zero-finding gain but leaves capture-state overhead on every surviving zero-finding rule. It does not test the requested find-then-capture mechanism.

2. **Resolve captures on `&haystack[match.start()..match.end()]`.**  
   This is smaller but incorrect for anchors, multiline context, word boundaries, and any behavior that depends on bytes outside the match span.

3. **Use non-overlapping AC iteration.**  
   A selected anchor can hide another overlapping or suffix anchor, producing a false-negative survivor set.

4. **Always use the optimized path.**  
   Low `max_work`, dense findings, and saturated anchors can perform more work than the frozen scanner. Explicit fallbacks are required by the bounded-work and adversarial-regression gates.

## 7. Discriminating claims and falsification checks

| ID | Claim | Falsification check |
|---|---|---|
| V1 | Every accepted anchor is mandatory under exact regex semantics. | For every rule, combine static proof review with generated matching inputs. Fail on any regex match whose full matched bytes contain no AC-equivalent anchor occurrence. Include alternation, repetition, scoped flags, and Unicode folds. |
| V2 | Overlapping AC enumeration cannot miss a survivor. | Test duplicate, prefix, suffix, and overlapping anchors such as `a`, `aa`, `aaa`, `aba`, and `ba` across all short haystacks. Compare the survivor bitset with independent per-anchor containment checks. |
| V3 | `find_iter` produces the same group-0 sequence as `captures_iter`. | Run both paths for every corpus rule over frozen, randomized, and adversarial inputs. Compare count, order, and spans before checking subcaptures. |
| V4 | Offset capture resolution preserves all capture groups. | Compare every optional and participating group. Include `^`, `$`, `\A`, `\z`, multiline mode, word boundaries, alternation priority, empty matches, and UTF-8 boundaries. |
| V5 | All public behavior remains exact. | Run the frozen differential oracle over baseline and optimized scanners. Compare findings, ordering, spans, captures, candidates, work, and error values byte-for-byte. |
| V6 | `max_work` behavior is unchanged. | For every oracle case, rerun at each observed boundary `n-1`, `n`, and `n+1`, plus 0 and 1. Compare the first error, partial results, candidates, and work. |
| V7 | Storms do not regress materially. | Benchmark repeated-byte inputs, all-anchor inputs, overlapping-anchor inputs, late saturation, dense matches, and empty matches. Reject any p95 regression above 5% versus baseline. |
| V8 | Zero-anchor performance improves materially. | Benchmark the supplied 128 KiB zero-finding case under identical build and CPU conditions. Require at least 5x improvement over 22.9 ms and report survivor count. |
| V9 | The 80-finding case selects a bounded fallback. | Benchmark findings spread across many rules and concentrated in one rule. Confirm baseline-equivalent output and no p95 regression above 5%. |
| V10 | Construction cost is acceptable. | Measure build latency and retained bytes for the unchanged corpus. Reject if scanner construction regresses above 10% or retained memory exceeds an owner-approved budget. |
| V11 | The optimization does not alter digest or API. | Compare public API checks and digest fixtures before and after enabling the private gate. |
| V12 | Fallback is transactionally invisible. | Force capture mismatch, dense fallback, saturation fallback, and disabled construction. Confirm no duplicate results, charges, candidates, or changed errors. |

## 8. Trade-offs and kill condition

This design optimizes the dominant zero-finding workload while retaining the existing scanner for cases where filtering or split capture work loses. It spends one prepared automaton, a small survivor bitset, and bounded speculative work to avoid repeated 128 KiB regex scans.

It sacrifices simplicity in anchor proof, overlapping-hit control, and transactional fallback. The private baseline limits reversibility risk.

Reject the proposal if any differential case changes observable behavior, any mandatory-anchor proof remains unverified, full-haystack capture resolution cannot reproduce `captures_iter`, zero-finding speedup is below 5x, or any adversarial scenario regresses p95 runtime by more than 5%.
