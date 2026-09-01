# composite-panic-containment-covers-only-optional-health-and-shutdown

Carried into this sub-part from the superseded `part-2b-wire-and-channels`, where
it was record 11 of `_lenses/lens-c-negotiation-provider.md` (`L637-675`). Every
`composite.rs` citation was re-verified at `HEAD` = `e447c927` and the O17
enumeration was re-derived independently; both hold exactly. **One
`tests/composite_routing.rs` span was repaired**, and it is the only citation
drift in either carried composite record.

## Discovery trigger

`composite.rs` is the only file in this sub-part that contains a `catch_unwind`
at all, and it contains exactly one, inside a helper. The interesting question is
not whether the helper is correct but where it is *applied*, because the runtime
treats an escaping panic from a handler callback as fatal. So every child call in
the file is a decision: contain, or escalate. Whether that decision set is closed
and deliberate is the property.

## Evidence trail

**The helper, and what it does not do.** `catch_child_panic` is
`composite.rs:160-171`, under a doc comment at `:155-159` that states the division
of labour explicitly: it "polls `future` with every poll wrapped in
`catch_unwind`", and "the caller — not this helper — decides whether the caught
payload is dropped (health) or aggregated and re-raised (shutdown)". The body
pins the future at `:163` and wraps each individual `poll` at `:165`, returning
`Poll::Ready(Err(payload))` at `:167`. Per-poll wrapping is what makes a child
that panics *after* an `await` still caught; wrapping the whole future would not.

This is a different mechanism from `panic_boundary::redact_sync` and
`panic_boundary::redact` (`panic_boundary.rs:52-55`, `:59-66`), which the dispatch
path applies to the same callbacks one layer up. Those two do **not** catch: they
increment a thread-local depth counter so the process panic hook installed at
`:38-49` prints a redacted line instead of the payload. So the composite's
containment and the host's redaction are orthogonal, which is the distinction the
record's `Confidence:` line draws when it says this does not restate part 2a's
`every-callback-invocation-is-inside-the-redaction-guard`.

**The eleven child call positions, re-derived independently at carry time.**
Enumerated by grepping every `self.primary.`, `self.secondary.`, `self.tertiary.`
and `catch_child_panic` occurrence in the file and checking each for a wrapper.

Uncontained, nine:

| Callback | Lines |
| --- | --- |
| `install_connection_key` | `:194-196` |
| `manifest` | `:201-203` |
| `resources` | `:211-213` |
| `initialize` | `:223-225` |
| `activate` | `:235-237` |
| `bind` | `:271-273` |
| `handle` | `:279-281` |
| `route_gone` | `:292-294` |
| `health`, primary only | `:312` |

Contained, two categories covering five call sites:

| Callback | Lines | Disposition of the payload |
| --- | --- | --- |
| `health`, secondary and tertiary | `:318`, `:321` | dropped; `unwrap_or_else` substitutes the `panicked(id)` report built at `:313-317` |
| `shutdown`, all three children | `:374`, `:378`, `:382` | aggregated into `failures` and re-raised as one panic at `:387` |

**The count is exactly nine and two**, matching O17. The record's claim that the
contained set is closed is therefore verified by exhaustion over the file, not by
sampling.

**The primary-health asymmetry, which is the record's sharpest point.** `health`
is `composite.rs:305-357`. The comment at `:306-311` explains the containment
rationale, and it discusses only optional children: "The runtime trips its fatal
cell when a health callback unwinds, so an escaping panic from an optional child
would tear down the whole host over a component the host can run without. Each
optional child's poll is caught and the payload dropped rather than re-raised: the
fault becomes a failing report for that component, and the mandatory primary's
report keeps deciding the aggregate." Then `:312` calls
`self.primary.health().await` with **no** wrapper, while `:318` and `:321` wrap
the other two. So the primary is deliberately uncontained and the comment says why
only by implication — it says the primary's report "keeps deciding the aggregate",
not that a primary panic is fatal. That gap between what the comment discusses and
what `:312` does is why the record asks for an explicit test.

**The shutdown ordering, and what it protects.** `shutdown` is
`composite.rs:359-389`. The comment at `:360-369` states the invariant, and it
also fixes the drain order as tertiary, then secondary, then the mandatory
primary: a failure
must not "release the instance fence while that child's background work is still
live", so failures "are collected as redacted notes and surfaced only after every
child has drained, as one deterministic panic so the runtime still classifies this
callback as failed rather than cleanly returned". The mechanism:

- `:370` — `let mut failures: Vec<String> = Vec::new();`
- `:371-385` — an `outcomes` array literal whose three elements each call
  `shutdown_failure_note(&id, catch_child_panic(child.shutdown()).await)`, in the
  order tertiary (`:372-375`), secondary (`:376-379`), primary (`:380-383`). All
  three `await`s complete before the array is built, which is what makes the
  drain unconditional.
- `:386` — `failures.extend(outcomes.into_iter().flatten());`
- `:387-388` — `if !failures.is_empty() { panic!("{}", failures.join("; ")); }`

`shutdown_failure_note` is documented at `:173-175`: the note carries "the child
name" as "manifest identity (never sensitive)", a returned error contributes
"only its byte length (protocol V24)", and "panic payloads are dropped entirely".
So the aggregate panic at `:387` is a redacted signal, not a payload leak.

The existing check inventory already records `composite.rs:387` as one of this
sub-part's deliberate `panic!` sites, classified there as "converts child shutdown
failure into a failed callback the runtime can classify". That classification and
this record agree.

**Existing coverage, five tests, one span repaired.**

| Site | Test | Category |
| --- | --- | --- |
| `:851-885` | `a_panicking_broca_shutdown_still_drains_later_children_and_redacts` (attribute `:851`, `fn` `:852`) | contained: shutdown panic |
| `:886-917` | `an_erroring_broca_shutdown_still_drains_later_children_and_redacts` (attribute `:886`, `fn` `:887`) | contained: shutdown error |
| `:918-985` | `a_child_shutdown_failure_makes_the_host_incarnation_non_graceful` (attribute `:918`, `fn` `:919`) | the non-graceful incarnation |
| `:986-1027` | `a_panicking_broca_health_reports_failing_without_skipping_other_children` (attribute `:986`, `fn` `:987`) | contained: optional-child health panic |
| `:1028-1049` | `a_panicking_synapse_health_reports_failing_without_unwinding` (attribute `:1028`, `fn` `:1029`) | contained: optional-child health panic |

**The repair.** The lens cited the last span as `:1028-1060`.
`tests/composite_routing.rs` is 1,049 lines, so `:1060` overruns the end of the
file by eleven. The test ends on the file's final line: `:1040-1049` are the
assertions, closing with `Some("synapse health check panicked")` at `:1047`, `);`
at `:1048` and `}` at `:1049`. The corrected span is `:1028-1049`.

This drift is worth stating precisely because the earlier triage predicted the
opposite. It recorded that both composite records' subjects and both existing
checks were byte-identical and concluded that "neither needs a citation refresh".
The file contents claim is true — blob `2201b830` at `1c193ae0`, `793a973e` and
`e447c927` alike — and the conclusion still failed, because **the span was wrong
when the lens wrote it** rather than made wrong by a change. A byte-identical
subject guarantees that citations which were right stay right; it guarantees
nothing about citations that were never right.

**What has no coverage.** All nine uncontained positions. No test asserts that a
panic in `install_connection_key`, `manifest`, `resources`, `initialize`,
`activate`, `bind`, `handle`, `route_gone`, or the primary's `health` reaches the
runtime rather than being contained. That is the record's `Exercised: partial —
both contained categories have dedicated tests; no test pins that the other
categories deliberately escalate.`

**Reachability.** `serve.rs:575` constructs `StaticComposite::new(...)` and `:632`
passes it to `mc_host::run`. `composite.rs` contains zero `#[cfg]` attributes,
verified by grep, so every one of the eleven positions is unconditional.

## Failure scenario

Two, in opposite directions, and the record names both.

**Containment added where escalation is required.** Someone sees a host torn down
by a panic in a child's `handle` and wraps `:279-281` in `catch_child_panic`,
substituting an error `RequestOutcome`. The host now survives, which looks like an
improvement. What actually happened is that a handler invariant break — the
condition the runtime's fatal cell exists to catch — has been converted into a
per-request error, and the host continues serving with a child in an unknown
state. The failure is invisible in exactly the way the fatal latch exists to
prevent, and no test would fail.

The same shape applied to `bind` (`:271-273`) is worse, because it interacts with
the sibling carried record: `dispatch.rs:1164` reaches the route-gone-and-cleanup
arm precisely *because* a panicking `bind` propagates out of its spawned task.
Containing the panic in the composite would turn that into an `Ok(Some(outcome))`
at `dispatch.rs:1161` with a fabricated outcome, and the cleanup path would not
run.

**Containment removed where it is required.** Someone removes
`catch_child_panic` from one of the three `shutdown` calls at `:374`, `:378` or
`:382`. The panic then escapes mid-array-literal, so the two remaining children
never drain, and the aggregate panic at `:387` never runs. Per the comment at
`:360-369` that releases the instance fence with a child's background work still
live. This is the failure the record's `Impact:` names second, and the array
literal is what makes it a single-point change: the three `await`s are siblings in
one expression, so removing one wrapper skips the rest.

**The asymmetry that is correct and undocumented.** A panic in the primary's
`health` at `:312` escapes and is fatal, which is intended — the primary is
mandatory. But a reader following the comment at `:306-311` learns the containment
rationale for optional children and is not told that the line immediately below is
deliberately different. Someone "completing" the pattern by wrapping `:312` would
convert a mandatory-component failure into a degraded aggregate, and the comment
would read as though they had finished the job.

## Timing windows and dependencies

**The per-poll window is the interesting one and it is already handled.**
`catch_child_panic` wraps each `poll` (`:165`) rather than the whole future, so a
child that yields at an `await` and panics on a later poll is caught. A
whole-future wrapper would catch only the first poll. This is a correctness
property of the helper and the record cites it as the fault/timing angle.

**The shutdown drain ordering is a sequencing dependency, not a race.** All three
`await`s at `:374`, `:378` and `:382` complete before `:386` builds `failures`, and
the panic is deferred to `:387`. There is no interleaving to construct; the
obligation is that the code stays in that shape.

Dependencies:

- On the runtime's fatal cell for the escalation half. `lifecycle_join`
  (`runtime.rs:179-209`) is what observes an escaped panic, at `:187`, and trips
  the latch at `:192-193`. The nine uncontained positions rely on it, and a test
  for any of them reads the latch rather than a return value.
- On `panic_boundary` (`panic_boundary.rs:1-66`) for redaction, which is
  orthogonal. Part 2a's
  `every-callback-invocation-is-inside-the-redaction-guard` covers that and this
  record does not restate it.
- On [composite-route-entry-is-removed-by-exactly-one-route-gone](composite-route-entry-is-removed-by-exactly-one-route-gone.md),
  through `bind` and `route_gone`. That record depends on a panicking `bind`
  escaping; this record is what says it does. Neither dominates the other, but a
  change to the containment set would silently break that record's premise, which
  is the strongest reason to keep both.

## What a test must construct

Eleven panicking-child positions, and the harness for all of them already exists.

`tests/composite_routing.rs` already carries child stubs whose callbacks panic on
demand — two such stub impls exist, their trait methods spanning `:825-846` and
`:960-981`, and the five tests above use them. The construction for each new case
is a stub whose one callback panics.

1. **The two contained categories are covered.** No new work.
2. **The primary's `health` at `:312`**, which the record singles out. A stub
   primary whose `health` panics; assert the panic reaches the runtime rather than
   producing a `Failing` aggregate. This is the cheapest of the nine and the one
   with the highest value, because it is the asymmetry a well-intentioned change
   would erase.
3. **The remaining eight uncontained positions.** Each needs its panic observed at
   the runtime latch rather than at the composite's return, which means the oracle
   is `fatal.trip` having fired, not a value. `install_connection_key` (`:194-196`)
   is synchronous and the odd one out; the other seven are `async`.
4. **A structural assertion, which is the cheapest oracle of all and covers all
   eleven at once.** Assert that the set of `catch_child_panic` call sites in
   `composite.rs` is exactly `{:318, :321, :374, :378, :382}`. That is enumeration
   over one file, it fails informatively when a wrapper is added or removed, and it
   is the only form that catches the "containment added where escalation is
   required" failure without constructing a panic at all. The record's `Check:`
   third clause — "a panic in any other child callback reaches the runtime" — is a
   universal over nine positions, and a census discharges it far more cheaply than
   nine tests.

Faults needed: `C1` and `C3` from the fault map supply hostile handler callbacks,
and both are already available. Nothing here needs a seam. Note that the nine
escalating cases terminate the host, so each needs its own test process or a
`TestHost` whose teardown tolerates a tripped latch — which is what
`a_child_shutdown_failure_makes_the_host_incarnation_non_graceful` (`:918-985`)
already demonstrates for the shutdown case.

## Investigation log

The lens recorded `Open questions: None.` and the carry does not add one. Two
things were verified rather than asked, and both are recorded above: the O17
enumeration of nine uncontained and two contained positions was re-derived
independently and matches exactly, and the `:1028-1060` span was repaired to
`:1028-1049`.

One observation is logged as a lead rather than a question, because it is a
finding about this catalog's method rather than about the code. The repaired span
was wrong at the lens commit, not made wrong by the refactor. The triage that
routed this record forward reasoned from blob identity — subject byte-identical,
existing check byte-identical, therefore no refresh needed — and that inference is
sound only for citations that were correct to begin with. Since the four wire
records carried alongside these two produced six further repairs, five of them from
changed files and one from a span that was always short, the pattern holds in both
directions: **blob identity bounds which citations can have drifted, and bounds
nothing about which were ever right.** A later pass carrying material from any
superseded directory should re-verify spans against file length regardless of what
the blob hashes say.
