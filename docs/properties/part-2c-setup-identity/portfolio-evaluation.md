# Part 2c portfolio evaluation

Run by an independent evaluator with fresh context that had not seen the discovery
reasoning, against `catalog.md`, `existing-checks.md`, and `fault-map.md`. Its
charter was to expose systematic gaps rather than to agree. Four lenses: harness
fit, coverage balance, implementability, and a wildcard pass questioning the
framing. **Its verdict was REFUTED**, and that is recorded here without softening.

The shape of the findings is unusual and worth naming up front, because it is the
opposite of what an evaluation usually produces. **Three of the four refinements
made this portfolio's claims *weaker or smaller*, and the fourth added a record the
portfolio had argued itself out of writing.** The part had declined a liveness
record on a misreading of its own method contract, had framed a documented design
decision as an undocumented consequence, had asserted a universal property over a
published API that no campaign can establish, and had deferred a resolvable
question to a sibling sub-part. Only one finding was about a missing test
capability, and it was about a race rather than a seam.

Provenance for this pass. `HEAD` is `e447c927` ("refactor(shm): trim final review
leftovers"), which is what the three artifacts already state, and the code was read
read-only from `/local/home/ahrav/scratch/magic-context` at that commit. Every line
reference this disposition adds or repeats was opened individually, and the
native-addon references were re-derived by `grep -n` rather than by counting, which
is how the `insert_channel` sites were confirmed at `:551` and `:612`. Two facts
outside this part's files were verified because C2 turns on them:
`FrameSender` holds the frame queue's only `mpsc::Sender`
(`crates/mc-host/src/frame_channel.rs:685-694`), and `run_endpoint` returns when
`queue.recv()` yields `None` (`crates/mc-host/src/ring_transport.rs:437-440`),
after which `admission.release()` runs unconditionally at `:291`.

## Disposition summary

| Category | Count | Status |
| --- | --- | --- |
| refinement | 4 | 4 applied, 2 with a corrected or sharpened premise |
| shared refinement | 2 | 2 applied (S1 reachability evidence, S2 line references) |
| gap | 1 | queued for a follow-up pass, not mined |
| bias | 0 originating here | both biases for a human are recorded in 2b and are shared |

Record count **14 to 16**. Both additions come from C1 and neither is invented: one
is a candidate the earlier revision explicitly considered and rejected, and one is
half of an existing record whose two halves have different types.

Types **13 safety, 2 liveness, 1 reachability**, against 13/0/1 before. **The part
went from zero liveness records to two**, which was the point of C1.

Semantics **15 `always`, 1 `sometimes`, 0 `always-or-unreached`, 0 `reachable`, 0
`unreachable`**, against 13/1/0/0/0 before. Both new records are `always` evaluated
at the close of an explicit bounded window, which is the form the 2b cancellation
record also uses. The part still has no `unreachable`, and that remains correct
rather than a gap: no record here concerns a forbidden code location.

Reachability-class labels **15 `default-production`, 1 mixed
production-plus-compiled-with-no-shipped-caller**, against a flat "all 14
`default-production`" before. The one non-uniform case is
`setup-a-only-an-authenticated-grant-enters-the-native-channel-registry`, whose
subject `attach` is a published napi export with no caller on the shipped plugin
path. The fault map had resolved that to `default-production`, which flattened away
the very fact C3 turns on.

Confidence **16 high, 0 medium**, against 13/1. The part's only medium-confidence
record was medium because of a cross-sub-part dependency, and C2 closed it.

Fault-map totals **12 non-vacuous today, 4 partial, 0 unreachable**, against 10/4/0
over 14 records. Both new records are non-vacuous, so the numerator moved by two
and the partial count did not. One partial changed its *reason*, which matters more
than the count: `setup-a-an-abandoned-setup-strands-no-ring-charge` was partial for
a blocked oracle and is now partial for a non-deterministic construction.

Test counts are unchanged and the evaluator disputed none of them: 51 in-crate
tests across the five scope files, 49 of which never run; 2 peer-half tests that do
(`ci.yml:177`, `:184`); zero doctests; and six integration binaries reaching the
boundary of which three are named in no workflow.

## Refinements applied

Applied in the order the evaluation supplied. C1 changes the index, the
distribution, a group preamble, and a relationship-map bullet, so it went first;
S1 and S2 touch record text the others also edit.

### C1. The liveness rejection was wrong, and the part now has two liveness records

Applied in `catalog.md`: a new record
`setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline`; a split
of `setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable`
into `...-allocates-under-a-cap` (safety) and
`setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input`
(liveness); three new index rows; a rewritten distribution paragraph; a rewritten
Group S4 preamble; and a rewritten relationship-map bullet, which had been the home
of the rejection. In `fault-map.md`: three rows where there was one, the totals, the
rules preamble, and leverage items 2 and 4.

The earlier revision's argument, quoted from the relationship map, was that the
candidate "does not survive METHOD.md's liveness rule" because "a stalled setup is
torn down within `transport_setup_deadline`" is "bounded by a wall-clock duration
(`config.rs:227`), not by an attempt count or an explicit interval the code reasons
about". METHOD.md's liveness rule says: "State the bound in the units the code
actually bounds: attempts, deadlines, or an explicit interval." A deadline is the
second of the three admissible units, named explicitly. The rule's actual
prohibitions are an unbounded "eventually" and "a generous timeout" that "cannot
distinguish one recovery pass from a thousand", and the rejected candidate is
neither.

The code makes the bound stronger than the rejection assumed, which is why this is
a refinement rather than a coin flip. `activate_server` computes
`deadline = Instant::now() + timeout` **once**, at `setup_socket.rs:246-248`, and
threads that single `Instant` through every subsequent I/O: `send_grant`
(`:249-260`), the `Activate` read (`:261`), the `Activated` write (`:273`), the
`Commit` read (`:281`), and the `Committed` write (`:282`). `read_message`
(`:369-386`) enforces it with `timeout_at` on **both** of its `read_exact` calls
(`:374-376`, `:382-384`). So the deadline is absolute and shared rather than
per-message, a peer cannot extend it by dribbling bytes across message boundaries,
and the bound is a single value the code computes in one place and consults
everywhere. That is a bound the code reasons about, in the plainest sense of the
phrase the earlier revision used to reject it.

**The split, and why splitting rather than bounding in place.** The evaluation
allowed either. Splitting was chosen because the two clauses have different
**types**, not merely different scopes: a length cap that must hold on every read
is safety, and "it always yields to `read_cancel`" is an obligation that something
eventually completes, which is liveness. METHOD.md's schema gives each record
exactly one `Type` field, so a record carrying both is mislabelled whichever label
it wears — and the consequence was concrete rather than cosmetic: because the
clause lived inside a safety record, **it carried no bound at all**, which is the
defect the liveness rule exists to prevent. It now has one, and it is not a
duration: `connection.rs:196-206` is `tokio::select!` with `biased` and
`peer_read_cancel.cancelled()` as its first arm (`:198`), so the bound is a
cancellation edge plus one poll of that select, with the test's poll cap stated as
an explicit attempt count. The two records also have different existing coverage
(the cap has none; the cancellation path has none either, but for a different
reason — `setup_socket.rs:810-825` reaches `observe_peer` only through peer-driven
outcomes) and different constructions, so nothing is duplicated by separating them.

**Premise sharpening.** The evaluation cited `setup_socket.rs:246-284` for the
deadline record. That range is right for the window but does not distinguish the
anchor from the enforcement, and the distinction is the whole property: `:246-248`
computes the deadline once, and `:261`, `:273`, `:281`, `:282` consume it. The
record cites them separately, because a reader who only sees the range cannot tell
an absolute deadline from four per-message ones.

### C2. The deferred charge-release question is closed, and the record stays partial for a different reason

Applied in `catalog.md` on
`setup-a-an-abandoned-setup-strands-no-ring-charge`: `Reachability`, `Exercised`,
`Fault/timing angle`, `Required faults`, `Confidence` (medium to high), `Impact`,
and the open question, which is replaced rather than removed. Also on the index row
and on the relationship map's "one exit with no discard" bullet, whose heading
carried the deferral. In `fault-map.md`: that record's map row, the totals, and the
partial-reason accounting.

The record's open question was "Does dropping a `PreparedRing` inside a detached
`spawn_blocking` release the admission charge, or does that require
`sender.discard()`?", marked `unresolved, needs 2b`. 2b answers it. The chain was
verified end to end for this disposition and it does not depend on `Drop` of the
`Admission` guard at all: dropping the `PreparedRing` drops the `FrameSender` it
carries (`frame_channel.rs:685-694`), which holds the frame queue's only
`mpsc::Sender`, so the endpoint thread's `queue.recv()` yields `None` and
`run_endpoint` returns (`ring_transport.rs:437-440`); `admission.release()` then
runs at `ring_transport.rs:291`, outside the `catch_unwind` at `:279-290`, on that
exit as on every other. `Admission`'s own `Drop` (`profile.rs:581-586`) is a
backstop rather than the mechanism. Confidence moves to high and the dependency
note goes.

**The record stays partial, and the reason the evaluation gave is right and was not
in the artifacts.** Both the catalog's relationship map and the fault map's third
framing point had *corrected lens A in the optimistic direction*, arguing that the
`prepare`-timeout exit "needs no injected slowness, because
`config.timing.transport_setup_deadline` is an ordinary config field" that tests
already set (`tests/lifecycle.rs:165`, `tests/activation.rs:127-128`). Setting the
field is easy; forcing the timeout is not.
`timeout_at(Instant::now() + shared.timing.transport_setup_deadline, prepared)`
(`connection.rs:157-164`) races a timer against a `spawn_blocking` task that may
have finished already, so a fast `prepare` wins the race, the connection proceeds
normally, and a test written this way exercises the wrong path while passing — and
flakes in both directions on a loaded machine. Reachable and deterministically
reachable are different claims, and the artifacts had collapsed them. Deterministic
reach needs injected slowness inside `prepare`, which is 2b's R1 and has no seam,
or a barrier holding the blocking task past the deadline.

Note the shape of this finding, because it is the mirror image of 2b's: there, two
availability claims were **pessimistic** and understated what the harness can do.
Here, one was **optimistic** and overstated it. Both were single-probe
generalizations about a capability.

### C3. A universal claim over a published API, narrowed

Applied in `catalog.md` on
`setup-a-only-an-authenticated-grant-enters-the-native-channel-registry`:
`Reachability`, `Guarantee`, `Check`, `Confidence`, `Impact`, and the open question.
In `fault-map.md`: the map preamble's reachability paragraph, which had flattened
the label, and that record's map row.

The record asserted, as an `always` safety property, that every registry entry
originates from `connect_setup` "and never from `attach`". `attach` is a `#[napi]`
export (`packages/mc-shm-native/src/lib.rs:490-491`) surfaced to JavaScript as
`NativeChannel.attach` (`index.ts:526-529`), with no `#[cfg(test)]` and no
`#[doc(hidden)]`. A property universally quantified over the callers of a published
API cannot be established by running anything: no campaign observes the callers it
does not contain. Worse, as a universal claim it is **false** — an embedder may call
`NativeChannel.attach` deliberately and correctly, and `create_test_pair`
(`lib.rs:631`) suggests the addon's authors expected exactly that kind of caller.

**The choice made.** The evaluation allowed narrowing to the shipped plugin path or
stating plainly that the universal claim is false. Both were done, because the
narrowed version is only trustworthy if the reader is told what was given up. The
guarantee is now scoped to the shipped plugin, which is provable by a census: the
only `NativeChannel` construction on the plugin's frame-channel path is
`connectSetup` (`shm-frame-channel.ts:77`), and a grep over `packages/plugin/src`
at `HEAD` finds no other non-test `.attach(` caller. And the record now says
outright that **an unauthenticated registry entry is reachable in-process by
design**, so a later reader cannot recover the stronger claim from the narrower
one. The record stays in the catalog because the consequence it protects is real
and unchanged: any reasoning of the form "the peer must have authenticated to hold
this ring" is unsound for in-process callers, and that is worth pinning against
regression whatever `attach`'s intent turns out to be.

### C4. The defect framing on the key-only mapping authority, removed

Applied in `catalog.md` in the leading section's first framed fact, which is
rewritten to lead with the documentation; in the framing sentence that introduced
all seven facts as "consequences nobody wrote down"; in the Group S1 preamble; and
on `setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token`
(`Guarantee`, `Check`, `Impact`).

The catalog presented key-only mapping authority as an undocumented consequence,
introducing its seven framing facts as things that "read as design decisions until
the line is opened, and then read as consequences nobody wrote down", and closing
the paragraph with "A peer that never echoes has already been paid." Someone did
write it down, twice, in normative language. `docs/mc-host-wire-protocol.md:27`:
"The 32-byte connection key is a bearer capability. Possession grants every
direct-profile operation — including host-global `host.shutdown` (Section 7.6) — and
permits any `BindIdentity`. Client `role`, `consumer_identity`, `project_root`,
`harness`, and `session` are claims or scoping metadata; none grants authority."
And `auth.rs:70-81`, the doc comment on a deliberately empty `Authenticated`
struct: "WHAT THIS PROVES: the peer possesses the connection key, and (client side)
that the daemon does too. Nothing more", with `ClientHello.role` "parsed and then
discarded — any peer holding the key can claim any role, so it must never decide
admission, capacity, or privilege."

So there is no second factor to bypass, and the record is not reporting one. It is
kept as a **regression property**, which is the right category and a real one: the
relationship between key possession and mapping authority is currently exactly
one-to-one, and a refactor could break it in either direction — by introducing a
token check that appears to gate mapping but runs after the descriptors are gone,
or by admitting a peer that never proved key possession. The forward-looking
caution the record already carried, that a future design treating the token as a
second factor "would be relying on a check that runs after the asset is gone", is
the honest core of the finding and is now the whole of it.

**Premise sharpening.** The evaluation's framing was that the doc citation removes
the defect. It removes the *defect*; it does not remove the *property*, and the
disposition says which of the two it is doing. METHOD.md rule 3 cuts the other way
here from how it usually does: documentation cannot establish that an
implementation satisfies a contract, but it can certainly establish that a
behaviour was intended, and "undocumented" is a claim about the documentation that
this catalog got wrong by not searching it.

### S1. `default-production` applied too broadly

Applied in `catalog.md` on the two records whose labels were qualified, and in
`fault-map.md` where the map preamble resolved both qualifications to
`default-production`.

2c is in better shape here than 2b was: its records already carried per-record
evidence clauses rather than leaning on a preamble, which is what METHOD.md rule 4
requires. The unresolved case is the one the fault map flattened.
`setup-a-only-an-authenticated-grant-enters-the-native-channel-registry` was
labelled "`default-production` for `connect_setup`; `attach` is the surface under
test and is exported without a cfg gate" in the catalog, and the fault map then
wrote that it "is production for `connect_setup` while `attach` is a published
export with no cfg gate" under a heading asserting that every record resolves to
`default-production`. Neither states the fact that decides the record's scope:
`attach` is **compiled and exported with no shipped-plugin caller at all**. That is
now the label, with the census that establishes it, and per the S1 instruction it
says so rather than defaulting.

The other qualified label,
`setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection`, was checked
and is genuinely production on both halves: the native path through
`shm-frame-channel.ts:77` and the managed Rust path through `client.rs:346` for
embedders. It needed no change and is recorded here so the next reader knows it was
examined rather than skipped.

### S2. Line references the artifacts admitted were wrong

Applied directly to the record text, and the standalone paragraph that carried the
corrections is rewritten to say they have been applied.

The catalog's fourth provenance refinement (`catalog.md:66-79`) listed six
corrections to `packages/mc-shm-native/src/lib.rs` references in two records, and
then declined to apply them "because the records are carried verbatim from lens A".
That is not a reason METHOD.md recognizes; rule 1 requires the reference to be
correct where it is written, and a known-wrong number in a `Check:` line sends a
reader to the wrong predicate. All six are now in the records, and all six were
re-verified by `grep -n` for this pass rather than by counting lines:

- `attach`'s aliased-fd-or-grant rejection is `:533-535`, not `:534-537`.
- `attach`'s `GrantReservation::claim` is `:540-543`, not `:539-549`.
- `connect_setup`'s equal-grant rejection is `:588-590`, not `:582-584`.
- `connect_setup`'s claim is `:591-594`, not `:585-588`.
- The two `insert_channel` calls are at `:551` and `:612`, not `:550-556` and
  `:589-596`. `:655` and `:672` are two further calls inside `create_test_pair`
  (`:631`), a separate surface.

The other three references named in the instruction were checked and are already
correct in the artifacts: `catalog.md:850-864` and `:894-895` are the record text
these corrections land in, and the fault map already used `:591-594`, `:551`, and
`:612`.

One reference was checked and deliberately **not** changed, for the same reason as
in 2b: `connection.rs:130-133` for the authorization gate ends on a blank line,
since `if auth.is_err() { return; }` is `:130-132`. It points correctly and is
cited many times in both sub-parts.

## Gap queued for a follow-up pass

Recorded, not mined.

| # | Gap | Evidence |
| --- | --- | --- |
| G1 | **The manifest-and-checksum production loading branch is inventory-only: five of the nine startup reasons have no record and no reachable producer.** `requireAddon` (`packages/mc-shm-native/index.ts:189-210`) prefers the local addon — `existsSync(localPath)` at `:194-196` short-circuits and `packageAddonPath` (`:151-187`) runs only in the `else` at `:197` — and `ci.yml:193` runs `build:source` to create exactly that file before all four native and plugin steps, removing it only afterwards at `:219-223`. So the packaged path, which is the path a **shipped** install takes, never executes in CI, and five of the nine reasons in the closed set at `:22-31` are never produced by the loader. The four that any test touches are constructed as `new NativeStartupError(...)` in `shm-frame-channel.test.ts`, not produced. This is the gate `793a973e` ("build(shm): require packaged native transport") was added for, and this catalog holds **no record over it at all**: the manifest checks, the checksum comparison, and the platform and debug-build refusals are named in `fault-map.md`'s S6 row as a capability and nowhere as a property. It connects directly to 2b's rewritten doctor record, whose `missing_addon` class is the one terminal class no campaign can currently reach, for exactly this reason. Mining it needs a decision the evaluation did not make and this disposition will not either: whether a five-reason refusal taxonomy is one record with five situations or five records, and whether the CI ordering change (running one native step before `build:source`) is in scope for a properties pass. |

## Biases requiring human judgment

**This sub-part originates no new bias.** Both biases needing a human are recorded
in [../part-2b-ring-datapath/portfolio-evaluation.md](../part-2b-ring-datapath/portfolio-evaluation.md)
and are stated there because that is where the records they govern live. Both reach
into 2c and neither can be settled here.

1. **Whether static architecture assertions belong in the catalog** (2b bias 1)
   governs one record here.
   `setup-a-only-an-authenticated-grant-enters-the-native-channel-registry` is,
   after C3, a call-graph census over `packages/plugin/src` with no fault and no
   runtime state, which is the same shape as 2b's Group F records. It differs in one
   respect that may or may not matter to the answer: its subject `attach` **does**
   execute, in tests and potentially in embedders, so the census is over callers
   rather than over an unreachable location. If the answer is that census records do
   not belong, this record becomes prose and 2c drops to 15.

2. **The release-versus-quarantine policy question** (2b bias 2) is upstream of
   `setup-a-an-abandoned-setup-strands-no-ring-charge`, whose `Check` asserts that
   "the ring accounting reported at `ring_transport.rs:199-203` returns to its
   pre-attempt value" after every abandoned setup. That assertion is written against
   the current unconditional release at `ring_transport.rs:291`. If a human decides
   a condemned ring's charge should be retained as quarantined rather than released,
   this record needs an exception it does not have — the same inconsistency 2b
   records between its own two charge records. The abandoned-setup path is unlikely
   to involve a condemned ring in practice, so the exposure is small, but the record
   as written admits no exception at all and should not be read as having considered
   one.

## Verdict

The evaluator's verdict was **REFUTED**. After applying all four refinements plus
the two shared ones, the honest verdict is that the refutation was correct and the
portfolio is materially better, and it is still not ready — but for the first time
across these parts, not because of its own internal contradictions.

What improved concretely. The part has liveness coverage where it had argued
itself into having none, and the argument it used is now recorded as a misreading
so the next part does not repeat it. Two records that conflated a safety invariant
with a liveness obligation are separated, and the liveness half has a bound where
it previously had none. A universal claim that no campaign could establish and that
was false as stated is narrowed to a provable one, with the loss stated rather than
hidden. A documented design decision is no longer framed as an undocumented
consequence, which matters beyond tidiness: a reader who believed the old framing
would look for a second factor that the wire protocol explicitly says does not
exist. The part's only medium-confidence record is high, its cross-sub-part
dependency is closed, and the reason it remains partial is now a real one about a
race rather than a placeholder. And six line references the catalog had already
identified as wrong are correct in the text instead of correct in a footnote
attached to the text.

Ready now for test implementation, in this order, and the order changed under this
disposition. First, the two assertions on the CI-executing stalling peer
(`tests/shm_failure_modes.rs:44-58`, `ci.yml:133`): map the descriptors it already
holds, which discharges the mapping-authority record, and time how long the host
tolerates the stall, which discharges the new deadline record. Two records, one
existing fixture, inside a job that runs. Then the four in-process socket-pair
oracles, which now include both halves of the split sentinel record. Then the
authenticate-then-delay dialer, which de-vacuums the saturation cluster. The
`prepare`-timeout exit drops down the ranking, because a near-zero deadline does not
force it and writing the test that way produces a passing test of the wrong path.

Not ready, for three reasons no further work of this kind resolves. G1 is a missing
category: the packaged-addon loading gate that a refactor commit was written to add
has no property at all, and it is structurally unreachable in CI as configured. 2b's
bias 1 governs whether one record here survives in its current form. And above all
of it sits the fact none of these corrections touches: **49 of the 51 in-crate tests
in this scope execute in no job, and three of the six integration binaries that
reach this boundary are named in no workflow** — so S0 at the top of the leverage
ranking still unblocks zero records while protecting 72 test functions, and every
`Exercised:` line here is written against a suite that mostly does not run.

One process caveat, stated rather than hidden. METHOD.md step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 16 and
their order matches. **Evidence files remain at 14**, and three are now stale or
shared:
`setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable.md`
is linked deliberately by **both** halves of the C1 split so no link breaks, and
needs to become two files;
`setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline.md` is
linked by the new record and **does not exist yet**; and
`setup-a-only-an-authenticated-grant-enters-the-native-channel-registry.md`
documents a universal guarantee the record no longer makes. The affected records say
so at their `Confidence:` lines where it is load-bearing. This disposition was
scoped to `catalog.md`, `fault-map.md`, and this file, and was not permitted to
touch `evidence/`, `_lenses/`, source, tests, or CI.

## What this evaluation says about the method

2b's evaluation found four unenumerated absence claims and concluded that a
negative existential needs the search space named. 2c's findings are a different
error with the same root, and the root is worth stating in the more general form:
**this part twice reasoned from its own artifacts instead of from its sources.**

C1 is the clearest case and it is nearly self-refuting. The relationship map
rejected a liveness record by quoting METHOD.md's liveness rule — "not an attempt
count or an explicit interval the code reasons about" — while omitting the middle
of the rule's own three-item list, which is "deadlines". The rule is 8 lines long
and lives in a file every agent is instructed to read first. The failure was not a
misjudgment about the code; it was a paraphrase of a checklist that dropped the item
that would have decided the question. The guard is mechanical: when declining
something on the authority of a rule, quote the rule in full in the artifact, so the
omission is visible to the next reader.

C4 is the same failure against a different source. The catalog framed seven facts as
consequences nobody wrote down, and the very first one is written down twice, once
in the wire-protocol document the catalog cites eleven times elsewhere and once in a
doc comment in `auth.rs`, a file inside this part's own scope. Nobody searched for
the documentation before asserting its absence. That is 2b's negative-existential
lesson pointed at prose rather than at code, and the fix is identical: name the
search.

Two smaller patterns are worth one line each. **A correction recorded but not
applied is not a correction** (S2): six line numbers sat in a provenance note
attached to the records whose check lines still carried the wrong values, deferred on
a reason — "carried verbatim from lens A" — that METHOD.md does not recognize. 4c
observed that precision does not propagate sideways; here it did not propagate from
a paragraph to the records that paragraph was about. And **a correction can overshoot
in the optimistic direction too** (C2): both artifacts corrected lens A's
construction claim about the `prepare`-timeout exit, and both replaced a
conservative wrong answer with an aggressive wrong one, because "the deadline is a
config field" answers a different question than "can I force the timeout". A
capability claim needs the *outcome* enumerated, not just the knob found.

## Re-evaluation trigger

A fresh pass is warranted once G1 is mined, because it adds a category rather than
adding inside one. The packaged-addon loading gate is a **startup-time integrity**
surface, unlike everything else in this part, which is about a live protocol
exchange; its oracle is a refusal taxonomy over planted artifacts rather than an
observation of a peer; and it is the only place in either sub-part where a CI
ordering change is a precondition for coverage rather than a nice-to-have. It also
unblocks the one terminal class 2b's rewritten doctor record cannot currently reach.

Four other triggers, each firing independently:

- Any resolution of 2b's bias 1. It decides whether
  `setup-a-only-an-authenticated-grant-enters-the-native-channel-registry` survives
  as a record or becomes prose, and therefore whether this part holds 16 records or
  15.
- Any resolution of 2b's bias 2. It decides whether
  `setup-a-an-abandoned-setup-strands-no-ring-charge` needs an exception for a
  condemned ring, which its `Check` currently forbids by omission.
- Any answer on `attach`'s intent. If it is test surface, this part's registry
  record strengthens from a per-campaign census to a build-time assertion that the
  shipped addon does not export it, which is Part 1's neighbouring record rather
  than this one; if it is production surface, the narrowed guarantee is the
  strongest form available and should be marked as final rather than provisional.
- Any workflow change that runs the `mc-host` lib target or names
  `instance_security`, `host_roundtrip`, or `activation`. Every `Exercised:` line
  and every `Existing check:` line in this part is written against a suite that
  mostly does not execute, and the day it does, the meaning of "partial" changes
  across all 16 records. It would also make the host's own
  `committed_wire_vectors_pin_the_proof_construction` executable, which is the
  direct answer to quiet area 2 and needs no new test at all.
