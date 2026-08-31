# Part 1 portfolio evaluation

Discovery seeks properties; evaluation seeks flaws in the set. This pass was run
by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md` at
`9c1eb4d1`. Its charter was to expose systematic gaps rather than to agree.

Four lenses were applied: harness fit, coverage balance, implementability, and a
wildcard pass that questioned the framing itself.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 9 | 8 applied to the catalog, 1 rejected as stale |
| gap | 7 | queued for a follow-up discovery pass |
| bias | 4 | require human judgment, listed below |

## Refinements applied

Each of these changed a record's semantics, type, scope, or verdict. They are
already in `catalog.md`.

1. **`release-authority-bound-to-lease-ownership` — reachability verdict added.**
   The record implied a live read-after-recycle. Independent analysis established
   it is **not reachable in the shipped two-process topology**: every non-test
   `commit` caller discards the returned identity, the only non-test direct
   `Ring::release` is a receiver completing its own lease, and the two directions
   are separate objects with independent random incarnations. Reclassified as a
   latent API-shape hazard, with the real constraint behind the public method
   recorded (the addon needs lease-independent completion because `poll` forgets
   the lease).
2. **`receive-failure-leaves-no-wedged-slot` — semantics `always-or-unreached` to
   `unreachable`.** Two independent analyses agreed all post-commit-point failure
   branches are dead given that `validate` already succeeded on a 64-bit target.
   A third branch the catalog had missed was found (the `body_len` conversion at
   `ring.rs:828-829`). The property is now that the forbidden points are never
   entered, and the wedge is documented as what would happen if they became
   reachable. A synthetic failpoint would have proven nothing about production.
3. **`clean-reclamation-is-reachable` — semantics `reachable` to `sometimes`.**
   This is a situation, not a code location. A campaign can execute the branch's
   lines through a fake backend while never producing the operational state the
   outcome represents.
4. **`quarantine-charge-transition-is-atomic` — semantics `always` to
   `always-or-unreached`.** Admission checks `active + requested + quarantined`
   under the same mutex, so a valid public execution cannot approach the overflow.
   The ordering defect is real; the record now says it is reachable only through a
   synthetic seam instead of implying a live path.
5. **`quarantine-gates-cover-every-storage-mutation` — scope narrowed.** The
   abort clause was dropped. Restoring a slot to free does not by itself permit
   reuse while `try_reserve` remains gated on the quarantine flag, and no
   independent harm from the abort path was established. The commit clause stands.
6. **`release-exactly-once-per-sequence` — preconditions moved into the
   guarantee.** "Exactly one succeeds" is false when zero succeed, which happens
   if the ring is quarantined, the identity is wrong, or no lease was taken. The
   at-most-once half is the invariant; exactly-once holds only under the stated
   preconditions.
7. **`custody-terminal-transition-exactly-once` — reframed as a
   documentation-versus-API mismatch.** `CandidateCustody::release` takes no
   incarnation argument, so no input could carry a stale one, and the recovery
   contract deliberately keeps committed candidates valid across readiness
   changes. The documented sentence describes a mechanism that does not exist.
   That is a different finding from an unenforced runtime check, and the record
   now says so.
8. **`attach-refuses-a-quarantined-object` — confidence medium to high, impact
   corrected.** Direct read confirmed `validate_lifecycle` reads exactly eight
   fields and never `quarantined`. The claim that a quarantined attach pins a
   grant claim "for the process lifetime" was overstated: `close` and
   `force_close` release it once producers, active leases, and stranded aliases
   are empty, so it is pinned indefinitely only when a detach already stranded an
   alias.
9. **`traceability-pointers-resolve` — classification made precise.** The blunt
   "11 of 29 unresolved" was misleading. Only 2 distinct citations are
   definitively stale, one of them load-bearing for three requirement rows. Two
   are markdown anchors that resolve under standard anchor derivation, and 7 are
   TypeScript citations across two files whose snake-case fragments map
   one-to-one to real declarations under a single transform. A literal substring
   check can never match the latter two classes.

Two smaller corrections were also applied: the capability-probe open question
had an unsupported premise about step ordering, replaced with the two real
divergences (an undocumented gate before step one, and eight documented steps
implemented as five gates plus a catch-all); and the `daf6e244` incident masked
four of six boundary tests, not five, because the wrong-profile case returns
before grant decode.

Beyond these, the evidence authors corrected roughly a dozen line references
against HEAD while writing the per-property files. Those corrections live in the
evidence files; the catalog was updated where a reference supported a verdict.

## Refinement rejected as stale

The evaluator reported that 25 of 32 evidence links had no target file. That was
an artifact of reading the directory while four authors were still writing in
parallel. Verified at the time: 32 evidence files existed and all 32 catalog
links resolved, with no orphans, balanced fences, required sections present in
every file, and no content damage. After gap closure the same check passes at 58
files and 58 links.

## Gaps queued for a follow-up discovery pass

These are real omissions, not scope decisions. They belong to Part 1's surface
and are queued rather than dismissed.

| # | Gap | Why it matters |
| --- | --- | --- |
| G1 | The descriptor and grant **decode contract** is not cataloged as a whole. No record states decoder totality, exact consumption, identity and schema rejection, grant reserved-byte enforcement, or agreement between the production snapshot layout and the fuzz harness's hand-rolled layout. | This is the best-tested surface in the crate, which is exactly why its absence from the catalog is a blind spot: the catalog's own rule is that an existing check does not remove a property. |
| G2 | The **macOS path** has no property. Object creation, unlink-and-failure cleanup, object validation, and ring behaviour on macOS are all uncataloged, and macOS CI runs two of four test files. | Two macOS-specific defects were fixed with no executed check. The platform is compiled and shipped-adjacent. |
| G3 | The **iceoryx backend** has no contract-level property. It is a second implementation of the same contract with process-local sequence state. | Note one correction to the discovery input: its release is not a no-op in the sense of doing nothing; `release(self)` consumes and drops the sample. The real gaps are contract parity, restart behaviour, completion reporting, and cross-process identity. |
| G4 | The **transport-to-host wire-header composition** is absent. The transport validates only body length and version; the host validates type, flags, channel, epoch, and correlation before ingress. | The ordering currently looks correct, and nothing pins it. A reordering would move unvalidated attacker-controlled fields further into the system. |
| G5 | The **runtime-directory** authentication and revalidation path is absent. | Existing checks confirm no negative test exists for inode swap, mode change, or symlink replacement. |
| G6 | **Runtime page-size assumptions** are absent. Layout arithmetic and both prefault walks use a compile-time 4096 while only the residency vector uses the runtime size. | A prior defect in this exact area was fixed only halfway, and nothing asserts the layout total is a multiple of the real page size. |
| G7 | **Normal-operation liveness** is missing. All three liveness records concern failures; bounded backpressure progress, capacity recovery, and full-duplex starvation are uncovered. | A transport that never wedges but also never makes progress would satisfy this catalog. |

## Biases requiring human judgment

These are systematic orientations of the whole portfolio. Each needs a decision
from someone who owns the transport, not a code change.

1. **Harness-weight bias.** The portfolio routes several properties toward
   expensive fault, concurrency, and mutating-peer infrastructure when a plain
   integration test would answer them. The evaluator identified
   `no-frame-observable-before-commit`, `publish-signal-implies-committed-frame`,
   and most attach-side records as needing no concurrency at all.
   *Judgment required:* should the cheap static and plain-integration checks be
   built and landed before any of the F2, F3, F4, or F5 harness capability in
   `fault-map.md`? The fault map currently ranks capability by how many records it
   unblocks, which implicitly favours infrastructure.
2. **No situation-coverage records.** The catalog declares eleven rare windows in
   `fault-map.md` as coverage checks to add, but at evaluation time no record had
   `sometimes` semantics. Zero of 32.
   *Judgment required:* should those eleven coverage markers become first-class
   catalog records, or remain harness obligations attached to their properties?
   *Partly addressed by gap closure:* Group M added four situation-coverage
   records, two of them `sometimes` markers with explicit constant names. The
   remaining question is whether the other declared windows get the same
   treatment.
3. **Nine unresolved normative questions carried as active properties.** Nine
   records are tagged `needs human input`: what a publish signal means to a
   client, whether losing one acquired frame on cancellation is acceptable,
   whether the hostile-peer non-guarantee extends to control pages, whether the
   documented incarnation-fencing sentence should be deleted, whether one profile
   name may denote two geometries, which code is normative for close ordering,
   whether the test-only export surface is acceptable, whether `Ring::release`
   should stay public, and whether the capability enumeration is one gate per
   step.
   *Judgment required:* several of these decide whether a record is a defect, a
   documentation fix, or a non-issue. They cannot be resolved from code, and
   handing the catalog to test implementation without them will produce tests
   that encode a guess.
4. **"Reaches production" is ambiguous and hand-maintained.** The evaluator
   refuted the claim that admission accounting reaches production through shared
   code: its only non-test consumers are the explicitly injected test provider,
   and the default registry is empty. The label currently conflates default
   registration, compiled code, exported API surface, and release-gate relevance.
   *Judgment required:* define the term, then derive the labels mechanically
   rather than by hand. Related: the concentration of 11 records on ring
   quarantine, charge movement, and release bookkeeping, against zero on backend
   or platform boundaries, may or may not be intentional. Gap closure has since
   added five backend and five platform records, so the concentration is now 11 of
   58 with both boundaries represented; the labelling question stands.

## Gap closure, 2026-08-29

All seven queued gaps were mined in a follow-up pass. The catalog went from 32
records to 58, and the evidence directory from 32 files to 58.

| Gap | Records added | Group |
| --- | --- | --- |
| G1 decode contract | 5 | I |
| G2 macOS path | 3 | J |
| G6 page-size assumptions | 2 | J |
| G3 iceoryx backend | 5 | K |
| G4 wire-header composition | 4 | L |
| G5 runtime directory | 1 | L |
| G7 normal-operation liveness | 6 | M |

Effects on the evaluation's own findings:

- **Bias 2 partly addressed.** Semantics now span all five kinds: 47 `always`,
  3 `always-or-unreached`, 1 `unreachable`, 3 `reachable`, 4 `sometimes`. The
  portfolio had zero situation-coverage records; it now has four.
- **Bias 4 partly addressed.** The type mix moved from 28 safety / 2 liveness /
  2 reachability to 44 / 7 / 7, and the backend and platform boundaries the
  evaluator named as unrepresented now have ten records between them.
- **Two findings corrected during closure.** The characterization of the iceoryx
  release as a no-op was wrong: `release(self)` takes `self` by value, so drop
  glue returns the chunk to the publisher's retrieve channel, and the reclamation
  is real and exactly-once by move semantics. And `existing-checks.md` claimed
  the iceoryx suite never runs in CI; it runs on Linux, because `iceoryx` is a
  default feature and the CI step selects the crate by name, confirmed by running
  `cargo nextest list`. Both corrections are recorded at their source.
- **Four new fault classes** were required and are now in `fault-map.md`: macOS
  ring execution, a non-4096 page host, a duplex-capable peer, and iceoryx
  cross-process pairing. The last is not a harness investment; it needs an API
  change.
- **Open questions grew.** The nine `needs human input` items are now
  substantially more, concentrated in the new groups. Two are worth surfacing
  because they may invalidate records rather than answer them: whether the macOS
  ring is intended to become functional at all, and whether the iceoryx loopback
  shape is permanent.

What did not change: the seven gaps were genuine omissions rather than scope
decisions, and closing them did not overturn any original record. The transport
crate and addon are byte-identical between the commit the original records cite
and the commit the closure records were verified against.

## Re-evaluation trigger

A fresh portfolio pass is now warranted, and for the reason the earlier trigger
named: closure added whole categories (decode contract, platform, second
backend, normal-operation liveness) rather than additions inside existing ones.
The 58-record set has not been evaluated as a whole by an independent reader.

## Verdict

The evaluator's verdict was "not fit for full handoff", and after applying the
refinements that assessment is partly addressed and partly still open.

What is ready to hand to `/testing:test-strategy` now: the fourteen records the
evaluator classified as observable through current interfaces or artifacts, which
includes the whole evidence-integrity group and most of the attach-side and
cross-artifact records. Several of these need no harness investment at all.

What is not ready: the nine records blocked on a normative decision (bias 3), and
the seven queued gaps (G1 to G7). Handing over the blocked records first would
spend harness effort encoding a guess about intended behaviour.

## Re-evaluation trigger

A fresh portfolio pass is now warranted, and for the reason the original trigger
named: closure added whole categories (decode contract, platform, second backend,
normal-operation liveness) rather than additions inside existing ones. The
58-record set has not been evaluated as a whole by an independent reader. One to
three additions inside an existing category would not warrant one.

## Process note

During parallel evidence authoring, one author ran a markdown re-wrapper across
the entire evidence directory rather than only its own eight files, and one pass
was not fence-aware. It reflowed 24 files belonging to other authors and damaged
fenced code blocks in five, which that author then repaired against the real
sources. Verified afterwards: no unbalanced fences, no missing sections, and no
code-and-prose glue anywhere in the directory. Eleven files carry lines between
152 and 249 columns, against the roughly 80-column wrap used elsewhere in
`docs/`. That is a cosmetic inconsistency, recorded rather than fixed, since
reflowing tables and code references mechanically is what caused the incident.
