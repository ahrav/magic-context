# Proposal: Budget-Admitted RegexSet Dispatch

## 1. Decision summary

Build one private `regex::bytes::RegexSet` from the active rule patterns when the existing compiled rule set is constructed. Before scanning, verify against a cloned work tracker that the request can afford the complete existing `238 * n` charge. If it can, scan the corpus once with `RegexSet`, then run `captures_iter` only for matched rule IDs while replaying the existing per-rule `add_work` calls and rule order.

If the affordability probe or `RegexSet` construction cannot be used, retain the current full-scan path. Public APIs, digests, reports, errors, and work accounting remain unchanged.

## 2. Assumptions and boundaries

- **Verified from supplied context:** There are 238 active `captures_iter` scans and exact logical work is `238 * n`.
- **Verified:** `find_fwd` accounts for 96% of current runtime.
- **Verified:** A zero-finding 128 KiB scan takes about 22.9 ms.
- **Verified:** Safe Rust, immutable corpora, exact reports, bounded work, unchanged APIs, and unchanged digests are hard gates.
- **Unverified:** Active rules retain their source pattern strings and all builder settings needed to construct an equivalent `RegexSet`.
- **Unverified:** The work tracker can be cloned or can expose an equivalent private, non-mutating affordability check.
- **Unverified:** No observable side effects occur during an affordability probe on a cloned tracker.
- **Unverified:** All errors after `add_work` depend only on the same ordered capture processing, not on whether unmatched regex engines were invoked.
- **Boundary:** Build the gate once with the existing compiled rule-set lifecycle, never per corpus scan.
- **Boundary:** Do not cache gates for unbounded active-pattern combinations.
- **Non-goal:** Change rule semantics, candidate selection, finding order, work units, public configuration, or digest contents.

Missing context request: confirm the work-tracker type and side effects, pattern builder settings, active-rule lifecycle, and exact points where candidate and error state enter `ScanReport`.

## 3. Concrete design

Store private dispatch state beside the existing compiled rules:

```rust
struct CompiledRules {
    rules: Vec<CompiledRule>,
    gate: Option<regex::bytes::RegexSet>,
}
```

Construction order:

1. Compile individual rules exactly as today.
2. Build a stable gate-pattern vector in active-rule order.
3. Apply the same byte-regex semantics and relevant builder limits.
4. Attempt bounded `RegexSet` construction.
5. Store `None` on gate-specific failure and use the existing scanner.
6. Exclude `gate` and its construction result from public digests and schemas.

Scan flow:

```rust
fn scan(&self, corpus: &[u8], work: &mut Work) -> Result<ScanReport, Error> {
    let Some(gate) = &self.gate else {
        return self.scan_full(corpus, work);
    };

    let mut probe = work.clone();
    for _rule in &self.rules {
        if probe.add_work(corpus.len()).is_err() {
            return self.scan_full(corpus, work);
        }
    }

    let matched = gate.matches(corpus);

    for (rule_id, rule) in self.rules.iter().enumerate() {
        work.add_work(corpus.len())?;

        if !matched.matched(rule_id) {
            continue;
        }

        // Existing capture, candidate, finding, and error path unchanged.
        self.scan_rule(rule, corpus, work)?;
    }

    Ok(self.finish_report())
}
```

Key invariants:

- `RegexSet` index `i` always maps to active rule `i`.
- The main loop remains in original rule order.
- Every rule receives its original `add_work` call at its original processing point.
- Captures within a matched rule retain native `captures_iter` order.
- An unmatched gate result skips only a capture iterator that would produce no captures.
- Candidate and finding mutation remains inside the existing `scan_rule`.
- A failed affordability probe invokes the existing full scanner, preserving partial progress and exact error behavior.
- Gate work receives no new public work charge. It runs only after the request has demonstrated capacity for all old regex-scan work.
- No `unsafe` code is introduced.

## 4. Scenario analysis

| Scenario | Mechanism and response | Sensitivity and failure behavior |
|---|---|---|
| Zero-finding 128 KiB | Probe admits `238 * n`; one gate scan returns no IDs; all 238 work charges remain, but no `captures_iter` runs. Expected physical scan count falls from 238 to 1. Performance target remains unverified pending benchmark. | Depends on combined-set scan cost and probe overhead. If the benchmark does not materially improve from 22.9 ms, reject the proposal. |
| 80-finding dense | Gate runs once; captures run only for matched rule IDs in rule order. Reports remain oracle-identical. | Finding count does not determine matched-rule count. If most rules match or emit rejected candidates, benefit shrinks. Failure is performance loss only; semantics remain unchanged. |
| Regex/anchor-saturated storm | All matched rules run normally after the gate. Worst case is one gate scan plus all 238 existing scans. | Combined-set behavior on hostile anchors is unverified. If runtime, allocation, or peak memory materially regresses against the full scanner, disable the gate for that rule set or reject the design. |
| `max_work=1` | Probe fails before the gate. Existing full scan reproduces the first `add_work` error exactly. | Requires a side-effect-free exact probe. Without one, this design is ineligible. |
| `max_work=238*n-1` | Probe fails and selects the existing path. It preserves the same successful rule scans, work total, and eventual error. No gate cost is added. | Integer overflow and boundary semantics must match `add_work`, which is why the probe uses that implementation. |
| `max_work=238*n` and `+1` | Probe succeeds. The gate runs, then all per-rule work calls execute in order. Final work remains exactly `238*n`. | Any mismatch between probe and live tracker is a correctness failure and kill condition. |
| Construction | Build once beside existing compiled rules. Apply bounded compiler limits. Gate-only failure silently retains the full scanner. | Memory duplicates regex machinery. Per-request construction, unbounded caching, changed compile errors, or material startup/RSS regression fails the design. |

## 5. Failure and operations

- A gate compilation failure does not become a new public error. The scanner retains its existing behavior.
- Invalid individual patterns continue to fail through the existing construction path before gate construction.
- Work-limit failures use the existing full path, so the gate cannot consume an uncharged corpus pass before a low-limit error.
- The gate authorizes physical work only after the old worst-case logical work fits. This preserves the bounded-work security envelope.
- A false-negative gate result would silently lose candidates and findings. Differential tests therefore treat any false negative as a release blocker.
- A false-positive result only runs an unnecessary existing capture scan and does not alter semantics.
- Rollout requires no migration. Rollback removes the private field and dispatch branch.
- Do not add public metrics or configuration. Benchmark and differential-test results provide the acceptance evidence.

## 6. Alternatives rejected

1. **Run `RegexSet` before checking work.** This improves low-limit requests but weakens bounded-work behavior by scanning the full corpus before an error that currently may occur immediately.

2. **Charge extra work for the gate.** This changes exact work totals and shifts accepted/error boundaries, violating the frame.

3. **Use literal-prefix or Aho-Corasick dispatch.** It cannot gate arbitrary byte regexes, anchors, or patterns without usable literals while preserving exact coverage.

4. **Parallelize all 238 scans.** It preserves the full work, adds scheduling and ordering complexity, and does not address the dominant zero-finding waste.

## 7. Discriminating claims to verify

| ID | Claim | Falsification check |
|---|---|---|
| V1 | Gate dispatch preserves complete `ScanReport` equality. | Run the existing differential full-scan oracle over every immutable corpus, active-rule set, and configured limit. Compare findings, candidates, ordering, work, and error values byte-for-byte. |
| V2 | `RegexSet` never excludes a rule whose individual regex captures. | For each corpus and rule, assert `captures_iter(...).next().is_some()` implies `matches.matched(rule_id)`. Include empty matches, byte data, anchors, multiline modes, and zero-length patterns. |
| V3 | Work and errors remain exact at boundaries. | Test `max_work` values `1`, `238*n-1`, `238*n`, and `238*n+1`, plus one below, at, and above every cumulative per-rule work boundary. Compare against the full scanner. |
| V4 | Zero-finding performance materially improves. | Benchmark immutable 128 KiB zero-finding input against the current 22.9 ms baseline. Record wall time, allocations, and peak RSS. |
| V5 | Dense behavior does not materially regress. | Benchmark the supplied 80-finding corpus. Record matched-rule count separately from finding count and compare full report equality. |
| V6 | Hostile storms do not weaken security or materially regress. | Benchmark regex-saturated and anchor-saturated corpora at multiple sizes with all or most rule IDs matched. Compare time scaling, allocations, RSS, and work/error boundaries. |
| V7 | Construction remains bounded and amortized. | Measure individual-regex plus gate construction time and peak RSS for normal and hostile active sets. Confirm construction occurs once per compiled rule-set generation and gate failure falls back without changing public errors. |

## 8. Trade-offs and kill condition

The design optimizes sparse-match scans, especially zero-finding corpora. It spends one additional compiled regex structure, one affordability probe, and one gate scan on dense workloads.

Reject it if any differential result changes, if an exact non-mutating work probe is unavailable, if gate construction occurs per scan, or if construction, dense scans, or hostile storms show a material regression under the owner’s acceptance threshold.
