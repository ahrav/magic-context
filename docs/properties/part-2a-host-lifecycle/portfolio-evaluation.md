# Part 2a portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree, and it did: it refuted
seven claims the catalog asserted, two of which were my own verification errors
rather than an agent's.

Four lenses: harness fit, coverage balance, implementability, and a wildcard pass
questioning the framing.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 11 | 9 applied, 2 accepted with the alternative already in the record |
| gap | 5 | queued for a follow-up pass |
| bias | 3 | require human judgment |

## Refutations accepted and applied

Each of these was re-verified against the code before acceptance. The evaluator
was right in every case.

1. **"Every test in scope is current-thread" was false.** Multi-threaded tests
   exist: four in `tests/activation.rs` and three in `tests/lifecycle.rs`, plus a
   two-worker runtime in the echo-host helper. The accurate, narrower claim now in
   `existing-checks.md` is that the *in-crate unit tests* are all current-thread,
   including all four latch tests and the three connection tests, and that
   `tests/transport_negotiation.rs` is current-thread throughout. Three of the
   multi-threaded tests are in the very file flagged as ungated.
2. **The fault-map's leverage ranking was wrong twice.** It put multi-thread
   scheduling first as the cheapest high-leverage gap. But multi-threaded tests
   already exist, and more threads alone does not reach a specific lock order —
   that needs a barrier or an extracted state machine. The ranking is rewritten to
   order by *cheapest valid oracle*, which promotes five records to
   exercisable-today with no new infrastructure.
3. **"Every record reaches a shipped configuration" was false, and this was the
   most consequential error.** Verified: `liveness` defaults to `None`
   (`config.rs:296`) and the only `liveness: Some(..)` in the crate is inside the
   test module (`config.rs:664`), so the entire liveness probe path — including the
   sharpest record in the part — does not run in any shipped configuration in this
   tree. Non-TCP providers are explicitly test-only. The preamble now states three
   reachability classes and assigns records to them.
4. **Two retirement records contradicted each other.** One correctly said
   cancellation plus discard stops frames admitted after the cancel; the other said
   cancellation alone stops queued frames, which is false and would have had a test
   author assert the wrong thing. Corrected: cancellation stops *admission*,
   discard stops *queued bytes*, and the drain paths depend on that split.
5. **Concurrency is not the meaningful fault for generation-id uniqueness.** The
   allocator is a single sequentially-consistent fetch-and-add, so interleaving
   cannot duplicate. The only uniqueness failure is unchecked wraparound. The
   required fault is now a seeded counter, not a concurrency campaign.
6. **A tokio abort cannot split the shutdown commit hook.** The hook body is a
   synchronous closure with no await point, and tokio cancels only at await points.
   Only a panic can, and there are two prefixes with different severities: a panic
   in the freeze is recoverable by a successor, while a panic inside the
   acknowledgement sets the acknowledged flag before committing, so the drop
   declines to reopen and the latch is stuck with no possible successor.
7. **The long-phase record contradicted the documented contract.** The protocol's
   classification table states an expired record in any phase is wedged, and its
   prose says the freshness windows "still age a hung start or stop to wedged". So
   ageing out is specified, not a violation. Reframed as the real defect: a
   *coupling* gap, since the window is a hardcoded 60 seconds with no override while
   the phase budgets it judges are operator-settable to 365 days. One candidate
   cause the record named — per-file hashing during payload validation — was
   refuted: it runs before the phase record exists.
8. **The quarantine record over-claimed by including non-regular shapes.**
   Replacing a planted symlink or FIFO at the record name without following it is
   deliberate, documented, and covered by a passing test. Narrowed to undecidable
   *reads*. The narrowing also surfaced a better finding: the most reachable
   failure mode is one the record had not named, since the child-directory open
   rejects any group or other mode bit, so a 0o755 generation directory from a
   future release or a restored backup is classified removable and deleted.
9. **`unsupported_filesystem` does have a producer.** It is produced in
   TypeScript by the managed-policy preflight, with its own passing tests. The
   record's premise was false. What survives is narrower and still real: the
   **Rust** conditions that ought to yield it all map to the payload-invalid error,
   so the same root cause produces different advice depending on which layer
   noticed.

Two refinements accepted without a change, because the record already admits the
alternative: the quarantine-cap equality record (its check already permits
"or the comment is removed and each cap separately justified", which is the
evaluator's preferred resolution), and the CI record's classification as
repository governance rather than a runtime property — kept as a record because it
gates roughly 20 existing checks, with its nature now explicit.

## Gaps queued for a follow-up pass

The catalog selected 38 of roughly 90 lens candidates and listed the rest as
deferred. The evaluator judged that selection and found five deferrals wrong.

| # | Gap | Why it should not have been deferred |
| --- | --- | --- |
| G1 | **Mandatory setup-state transitions.** Negotiation-first, sticky selection, repeated-negotiation retirement, fail-closed transitions. | The protocol makes these normative and the implementation owns the state machine. This is the largest omission. |
| G2 | **Shared frame-read mechanics and the budget-free oversize drain.** | `frame_read.rs` names cancellation precedence, EOF handling, and frame-boundary capping as load-bearing in its own doc, has zero tests, and no record covers it directly. 125 lines of shared host-and-client code with no property is not defensible. |
| G3 | **Normal configured liveness.** | All three liveness records concern shutdown or lifecycle evidence. Nothing states that a timely pong keeps a generation alive, that a missed pong retires it, or that a saturated stream cannot block the probe. |
| G4 | **Canonical manifest evolution.** | Manifest bytes depend on struct declaration order, and only predecessor-with-missing-field compatibility is golden. A full byte-and-digest vector is missing. |
| G5 | **Darwin lifecycle and store behaviour.** | The atomic exchange has a distinct macOS backend with no property and no observed test. |

The evaluator also endorsed keeping three deferrals, with reasons the catalog had
not stated: the grant binding-mismatch and replay candidates are latent because the
runtime passes the same binding used to construct the record, so those branches are
not live; and the launch-nonce candidate is bounded and documented as an unverified
claim, with any cache-key concern belonging to a later part.

## Biases requiring human judgment

1. **Zero situation coverage, again.** 33 `always`, 1 `always-or-unreached`, 4
   `reachable`, and **no `sometimes`**. Part 1 was criticized for exactly this and
   later added four. The ten legal-window markers in `fault-map.md` are harness
   obligations rather than records. *Judgment required:* promote them, or accept
   that situation coverage lives in the fault map in this repository.
2. **Seven unresolved normative questions carried as active records.** Whether the
   pong pre-answer guard's absence is an oversight; whether a promoted generation
   is owed a goodbye during drain; whether a failed phase demotion should abort
   unpublication; whether pre-coordination releases are trusted by definition;
   whether the twelve unforwarded wedge reasons are contract or diagnostics;
   whether the CI exclusion is deliberate; and how the freshness window and the
   phase budgets should be coupled. Several decide whether a record is a defect, a
   documentation fix, or a non-issue.
3. **The portfolio mixes enforcement classes.** It contains runtime invariants,
   architectural constraints that want a lint or a single spawn API rather than a
   test, documentation-consistency checks, observability requirements with no
   channel to observe through, and one CI policy. All are legitimate findings.
   *Judgment required:* separate them by enforcement class before handoff, because
   `/testing:test-strategy` can only route the first kind.

## Verdict

The evaluator's verdict was "not ready for full handoff", and after applying the
refinements that is still the right call, for a narrower reason than before.

Ready now: the records the evaluator classed as cheap in-crate units — the ping
counter's checked exhaustion, an injected panicking completion hook, permit release
under abort, the two quarantine caps, and the reason-id producer table. Those need
no new infrastructure and several are single unit tests.

Not ready: the five queued gaps, the seven records blocked on a normative decision,
and the records whose enforcement is architectural rather than behavioural. Handing
those to test implementation would encode a guess about intended behaviour, or
would write a test where a lint is the right instrument.

## What this evaluation says about the method

Part 1's evaluation produced nine refinements, none of which contradicted a
verified fact. Part 2a's produced seven refutations of asserted facts, two of them
mine. The difference is instructive: Part 2a is production code with a normative
specification, so the catalog made more claims about intent and reachability, and
those are exactly the claims a fresh reader can falsify. The lesson for later parts
is to verify reachability class per record at authoring time rather than asserting
it in a preamble.

## Re-evaluation trigger

A fresh pass is warranted once the five gaps are mined, because G1 and G2 would add
whole categories rather than additions inside existing ones. The corrections above
do not warrant one: they narrowed and repaired records without changing the
portfolio's shape.
