# Part 2a property catalog: host lifecycle, generations, connections

Scope: `crates/mc-host/src/lifecycle.rs`, `generation.rs`, `connection.rs`,
`frame_read.rs`, `panic_boundary.rs` (~6.5k lines). Boundary context from
`dispatch.rs`, `runtime.rs`, `routing.rs`, `transport_provider.rs`,
`transport_negotiation.rs`, `frame_channel.rs`, `tcp_frame_channel.rs`,
`instance.rs`, `wire.rs`, `auth.rs`, `control.rs`.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context` at `d90e7811`, 2026-08-29. The five
scope files are byte-identical from `753b1c38` through `d90e7811`.

Not re-mined here: `shm_provider.rs` and `provider_recovery.rs` custody and
recovery, already cataloged as Part 1 boundary context.

## One naming collision to read past first

"Generation" means three unrelated things in this scope, and conflating them
makes every record ambiguous:

- **Payload generation** — a content-addressed on-disk directory named by the
  SHA-256 of its canonical manifest bytes. This is what `generation.rs` is about.
  It has no async code and no task.
- **Connection generation** — an in-process `GenerationCore` with a `u64` id
  minted per served frame channel. This lives in `connection.rs` and is the
  lifecycle state machine.
- **Catalog generation** — a `u64` catalog-state version, out of scope here.

Groups A through D, G, I, and J concern connection generations, as do the two
liveness records in Group K. Group F and the manifest and platform records in
Group K concern payload generations. Group E concerns the daemon incarnation,
which is a fourth, separately-fenced lifetime.

## Product context, corrected after portfolio evaluation

An earlier revision of this section claimed that because this is production code
on the default path, "every record here is reachable in a shipped configuration
unless marked otherwise". **That is false**, and the correction matters enough to
state before the records.

Verified reachability classes:

- **Default production.** The shutdown latch, the daemon incarnation and probe,
  the payload generation store, the panic boundary, connection admission, and the
  correlation watermark. These run in every shipped configuration.
- **Explicit configuration only.** Everything on the liveness probe path — the
  ping and pong records, including
  [pong-preanswer-rejected-in-every-mutex-order](#pong-preanswer-rejected-in-every-mutex-order)
  — is gated on `liveness` being configured. The default is `None`
  (`config.rs:296`), and the only `liveness: Some(..)` in the crate is inside the
  `#[cfg(test)]` module at `config.rs:664`. So **the liveness loop does not run in
  any shipped configuration in this tree**; those records are live only for an
  embedder that opts in.
- **Test-only.** The candidate grant, activation, commit, and promotion path.
  Non-TCP providers are explicitly test-only and the default config installs none
  (`transport_provider.rs:1-13`, `:157-163`). Records about two generations per
  socket and the promoted watermark are latent in the same sense Part 1's records
  were.

The honest summary is that this part mixes three reachability classes, and the
label belongs per record rather than in a blanket preamble. Deriving these labels
mechanically rather than by hand is an open bias, the same one Part 1 raised about
"reaches production".

One coverage fact still shapes the whole catalog and is verified: of `mc-host`'s
26 integration test binaries, CI names **four**. `tests/lifecycle.rs` (36 tests,
1872 lines), `tests/activation.rs`, and `tests/host_roundtrip.rs` are named in no
workflow. See
[the-largest-lifecycle-proof-runs-in-ci](#the-largest-lifecycle-proof-runs-in-ci).
That record is retained and it is no longer open: the ring-transport refactor
(`ed487e11 refactor(host): make ring transport mandatory`) rewrote the workflow to
name `--test lifecycle` on both platforms, and the record carries the closure and
its two residual gaps in its own `Impact:` line.

### Repair provenance

This file survived a working-tree clean holding 38 of its 55 records. The missing
17 are the gap-closure set and were reappended from `_lenses/` verbatim, five from
`gap-g1-setup-states.md`, six from `gap-g2-frame-read.md` and six from
`gap-g3-g4-g5.md`, as Groups I, J and K below. Three mechanical adjustments were
made and no record was re-derived: evidence links were rewritten from the
lens-relative `../evidence/` to the catalog-relative `evidence/`, one
cross-reference written as `../catalog.md#...` in a lens file became an intra-file
anchor, and field paragraphs were rewrapped to about 80 columns, with content
equality checked token by token afterwards. The six Group J records additionally
carry `Status: superseded-by-refactor` in place of `active`, because
`ed487e11` removed `frame_read.rs` from the module tree; the group preamble states
what that leaves outstanding. The index table already held all 55 rows in this
order, so no row was added, and none of the 38 surviving records was touched.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [generation-id-strictly-increases-and-is-never-reused](#generation-id-strictly-increases-and-is-never-reused) | safety | high |
| [at-most-one-registered-generation-per-connection](#at-most-one-registered-generation-per-connection) | safety | high |
| [close-disposition-is-a-total-function-of-the-read-exit-cause](#close-disposition-is-a-total-function-of-the-read-exit-cause) | safety | high |
| [retirement-discards-only-through-the-discard-token](#retirement-discards-only-through-the-discard-token) | safety | high |
| [a-retired-generation-emits-nothing-and-mutates-nothing](#a-retired-generation-emits-nothing-and-mutates-nothing) | safety | high |
| [generation-registry-entry-released-on-every-connection-exit](#generation-registry-entry-released-on-every-connection-exit) | safety | high |
| [disconnect-releases-every-resource-keyed-to-the-connection](#disconnect-releases-every-resource-keyed-to-the-connection) | safety | medium |
| [request-correlation-strictly-increases-per-generation](#request-correlation-strictly-increases-per-generation) | safety | high |
| [promoted-generation-refuses-the-setup-correlations](#promoted-generation-refuses-the-setup-correlations) | safety | high |
| [ping-and-consumer-correlations-cannot-cross-settle](#ping-and-consumer-correlations-cannot-cross-settle) | safety | high |
| [pong-preanswer-rejected-in-every-mutex-order](#pong-preanswer-rejected-in-every-mutex-order) | safety | high |
| [host-ping-correlation-exhaustion-retires-the-generation](#host-ping-correlation-exhaustion-retires-the-generation) | safety | high |
| [no-task-outlives-the-generation-it-serves](#no-task-outlives-the-generation-it-serves) | safety | high |
| [the-writer-task-is-abortable-through-a-stated-owner](#the-writer-task-is-abortable-through-a-stated-owner) | safety | high |
| [draining-rendezvous-is-released-or-the-loss-is-declared](#draining-rendezvous-is-released-or-the-loss-is-declared) | liveness | high |
| [no-generation-registers-after-the-drain-snapshot](#no-generation-registers-after-the-drain-snapshot) | safety | high |
| [read-task-quiescence-implies-no-further-registration](#read-task-quiescence-implies-no-further-registration) | safety | high |
| [a-cancelled-emission-releases-every-permit-it-held](#a-cancelled-emission-releases-every-permit-it-held) | safety | high |
| [no-writer-hook-panic-poisons-a-generation-lock](#no-writer-hook-panic-poisons-a-generation-lock) | safety | high |
| [shutdown-commits-exactly-once-on-write-ack](#shutdown-commits-exactly-once-on-write-ack) | safety | high |
| [admission-freeze-precedes-the-shutdown-commit](#admission-freeze-precedes-the-shutdown-commit) | safety | high |
| [shutdown-commit-effects-are-all-or-nothing](#shutdown-commit-effects-are-all-or-nothing) | safety | medium |
| [latch-wake-cannot-be-lost](#latch-wake-cannot-be-lost) | liveness | high |
| [probe-never-reports-stopped-while-either-fence-is-held](#probe-never-reports-stopped-while-either-fence-is-held) | safety | high |
| [stopping-precedes-unpublication-on-every-path](#stopping-precedes-unpublication-on-every-path) | safety | high |
| [phase-evidence-outlives-a-long-phase](#phase-evidence-outlives-a-long-phase) | liveness | high |
| [clock-anomalies-do-not-invalidate-live-evidence](#clock-anomalies-do-not-invalidate-live-evidence) | safety | high |
| [legacy-incumbent-classification-needs-an-unforgeable-witness](#legacy-incumbent-classification-needs-an-unforgeable-witness) | safety | high |
| [an-observed-wedge-cause-reaches-the-operator](#an-observed-wedge-cause-reaches-the-operator) | reachability | high |
| [current-profile-never-names-an-unvalidatable-generation](#current-profile-never-names-an-unvalidatable-generation) | safety | high |
| [validation-and-enumeration-address-one-directory-object](#validation-and-enumeration-address-one-directory-object) | safety | high |
| [an-undecidable-quarantine-witness-fails-closed](#an-undecidable-quarantine-witness-fails-closed) | safety | high |
| [persisted-state-quarantine-caps-agree](#persisted-state-quarantine-caps-agree) | safety | high |
| [every-declared-cli-reason-id-has-a-producer](#every-declared-cli-reason-id-has-a-producer) | reachability | high |
| [every-callback-invocation-is-inside-the-redaction-guard](#every-callback-invocation-is-inside-the-redaction-guard) | safety | high |
| [the-panic-hook-cannot-itself-fail](#the-panic-hook-cannot-itself-fail) | safety | medium |
| [authentication-and-capacity-rejections-are-observable](#authentication-and-capacity-rejections-are-observable) | reachability | high |
| [the-largest-lifecycle-proof-runs-in-ci](#the-largest-lifecycle-proof-runs-in-ci) | reachability | high |
| [negotiation-precedes-every-gated-frame-kind](#negotiation-precedes-every-gated-frame-kind) | safety | high |
| [setup-selection-is-sticky-for-the-generation](#setup-selection-is-sticky-for-the-generation) | safety | high |
| [setup-readiness-is-decided-by-one-predicate](#setup-readiness-is-decided-by-one-predicate) | safety | high |
| [a-setup-pong-is-required-and-forbidden-in-the-same-window](#a-setup-pong-is-required-and-forbidden-in-the-same-window) | reachability | high |
| [fallback-reason-precedence-survives-a-silent-preflight](#fallback-reason-precedence-survives-a-silent-preflight) | safety | high |
| [cancellation-preempts-every-bounded-frame-read](#cancellation-preempts-every-bounded-frame-read) | safety | high |
| [a-body-read-consumes-exactly-the-declared-frame-boundary](#a-body-read-consumes-exactly-the-declared-frame-boundary) | safety | high |
| [a-zero-length-read-ends-the-read-instead-of-looping](#a-zero-length-read-ends-the-read-instead-of-looping) | safety | high |
| [no-framed-read-resumes-after-a-read-stop](#no-framed-read-resumes-after-a-read-stop) | safety | high |
| [oversize-control-drain-work-is-bounded-without-ingress-budget](#oversize-control-drain-work-is-bounded-without-ingress-budget) | safety | high |
| [the-client-body-budget-refusal-drain-is-never-entered](#the-client-body-budget-refusal-drain-is-never-entered) | reachability | high |
| [a-timely-pong-sustains-the-generation-within-a-bounded-round](#a-timely-pong-sustains-the-generation-within-a-bounded-round) | liveness | high |
| [slow-egress-alone-does-not-retire-a-probed-generation](#slow-egress-alone-does-not-retire-a-probed-generation) | reachability | high |
| [manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector](#manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector) | safety | high |
| [a-declaration-order-change-cannot-orphan-a-retained-generation](#a-declaration-order-change-cannot-orphan-a-retained-generation) | safety | high |
| [the-atomic-directory-exchange-is-atomic-on-every-supported-platform](#the-atomic-directory-exchange-is-atomic-on-every-supported-platform) | safety | high |
| [an-occupied-rename-target-is-never-replaced-on-the-portable-path](#an-occupied-rename-target-is-never-replaced-on-the-portable-path) | safety | high |

---

## Group A: connection generation lifecycle and retirement

### generation-id-strictly-increases-and-is-never-reused

Type: safety
Status: active
Exercised: not yet — every test hand-builds `id: 1`.
Guarantee: Within one host incarnation every minted connection generation has a
strictly larger id than all previous ones, and no two live `GenerationCore`
values share an id.
Check: `always` — instrument minting; the sequence is strictly increasing, and
`shared.connections` never contains an id equal to a previously-removed one. Id
uniqueness is what makes the route registry's ownership test and the connection
registry's keying sound, so it must hold at every evaluation.
Fault/timing angle: refined after portfolio evaluation. Concurrent minting is
**not** the meaningful fault: the allocator is a single sequentially-consistent
fetch-and-add, so interleaving cannot produce a duplicate. The only way uniqueness
fails is **wraparound** at the counter's maximum, which is unchecked. Seed the
counter near its maximum rather than running a concurrency campaign.
Required faults and enabling state: a counter seeded near its maximum. The
two-generations-per-socket case needs a candidate promotion, which is a test-only
path.
Confidence: high — verified: the counter is initialized to 1 at `runtime.rs:898`
and `gen_counter` has exactly two references.
Existing check: none. `routing.rs:535`
`concurrent_generations_never_share_a_live_channel` asserts channel exclusivity
between two hand-built ids, not id minting.
Impact: a duplicate id would let one generation's close finalize another's route,
or let a stale generation's frames settle a live correlation.
Open questions: None.

### at-most-one-registered-generation-per-connection

Type: safety
Status: active
Exercised: not yet — no test drives drain during the bootstrap-to-promoted
transfer.
Guarantee: One accepted socket never has two generations registered in
`shared.connections` simultaneously, and a generation minted while draining is
never registered.
Check: `always` — for each connection task, at most one of its minted ids is in
the registry at any observation point; and when `draining` is true at the
registration check, no insert occurs.
Fault/timing angle: the bootstrap is removed inside `close_generation` and the
promoted generation is inserted afterwards, so a window exists where neither is
registered. The registration check and the shutdown snapshot share the
`connections` mutex, which is what makes the interleaving safe.
Required faults and enabling state: a committed non-TCP grant, plus a shutdown or
signal drain landing in the transfer window.
Confidence: high on the exclusion; medium that the neither-registered window is
harmless, since the lock ordering was traced but not tested.
Existing check: `tests/lifecycle.rs:1722`
`shutdown_during_candidate_setup_reaps_both_channels` covers drain during setup,
not during the transfer. Status unaudited — and that file runs in no CI job.
Impact: shutdown, route ownership, and Goodbye delivery all enumerate the
registry assuming one live owner per socket.
Open questions:
- Should the promoted generation receive a connection Goodbye when the host
  drains in the transfer window? Today it gets neither a Goodbye nor a reap.
  (needs human input)

### close-disposition-is-a-total-function-of-the-read-exit-cause

Type: safety
Status: active
Exercised: partial — the current three-arm disposition is proven only by
`tests/lifecycle.rs` and `tests/transport_negotiation.rs`, and the first runs in
no CI job.
Guarantee: For every read-exit cause, the frames emitted after the close decision
are exactly the declared set for that cause.
Check: `always` — for each cause, assert the emitted sequence: nothing for a peer
exit, the drain for a host-cancelled exit, exactly one authoritative terminal for
an oversize-control drain failure. Adding a cause without declaring its
disposition should fail to compile.
Fault/timing angle: a peer-driven close racing queued off-reader emissions. The
`ReadExit::HostCancelled if !gen.token.is_cancelled()` guard means a *new*
cancellation source silently falls into the silent-close arm.
Required faults and enabling state: each of the eleven read-exit sites, with
queued emissions in flight.
Confidence: high — this property is derived from an incident chain, not a
hypothesis. Five successive commits corrected one decision: cancel without
discard still flushed queued frames; keying on the host-wide `draining` flag gave
terminals to a peer that sent a corrupt frame during shutdown; an inherited
cancellation is a retirement rather than a drain; and a bare keep-queue marker let
the whole queue flush instead of the one promised terminal.
Existing check: partial, per above. Status unaudited.
Impact: this is the silent-close rule the wire protocol requires. Each of the five
iterations shipped a wrong disposition.
Open questions:
- Should the disposition be encoded so a new cause cannot compile without a
  declared disposition? That is a design change, not a test. (needs human input)

### retirement-discards-only-through-the-discard-token

Type: safety
Status: active
Exercised: not yet — nothing exercises admission after cancel.
Guarantee: After a generation is retired with both `token.cancel()` and
`writer.discard()`, no byte of any frame admitted after the cancel reaches the
socket.
Check: `always` — cancel the token, then have a producer that already passed its
`is_cancelled` precheck call send; assert the bytes never appear on the peer
socket. Separately assert `token.cancel()` alone does *not* stop queued frames,
because the drain paths depend on that.
Fault/timing angle: `send_ticket_before` gates on `retired` only, not on the
generation token or `discard` (`frame_channel.rs:812-825`). So the guarantee is
enforced downstream by the writer's biased discard arm, not by admission: a
producer can be admitted after cancel, and it is the writer that must drop it.
Required faults and enabling state: a producer suspended between its
`is_cancelled` precheck and its send, with the cancel landing in between.
Confidence: high — every gate read directly; `discard` being a separate token
from `retired` is the load-bearing detail.
Existing check: partial — `tcp_frame_channel.rs:1130` and `:1062` cover
writer-initiated retirement only.
Impact: a frame emitted after the close decision violates the silent-close rule.
Open questions: None.

### a-retired-generation-emits-nothing-and-mutates-nothing

Type: safety
Status: active
Exercised: partial — one shape covered.
Guarantee: Once a generation's token is cancelled, no *new* frame is admitted or
charged on its behalf, and once its writer is additionally discarded, no already
queued frame reaches the socket.
Check: `always` — after cancel, every charge attempt returns none and every emit
returns without enqueueing; after discard, the writer breaks without publishing
any remaining queued frame. The guarantee was corrected after portfolio
evaluation: an earlier revision said cancellation alone stopped queued frames,
which contradicts
[retirement-discards-only-through-the-discard-token](#retirement-discards-only-through-the-discard-token)
and is false. Cancellation stops *admission*; discard stops *queued bytes*. The
drain paths depend on exactly that split.
Fault/timing angle: the interesting interleaving is a frame already queued but
not yet begun; the biased discard arm decides it. Peer-driven exits cancel and
discard together, which is what makes a corrupt-frame close silent even during
shutdown.
Required faults and enabling state: an in-flight off-reader emission concurrent
with a peer-driven close.
Confidence: high — every emit path routes through a charge helper or an explicit
`is_cancelled` pair.
Existing check: `tests/transport_negotiation.rs:907` covers one shape;
`connection.rs:1598-1606` pins the positive fence, not the negative case.
Impact: the fail-closed property the whole retirement design rests on.
Open questions: None.

### generation-registry-entry-released-on-every-connection-exit

Type: safety
Status: active
Exercised: not yet — needs an induced panic or abort between insert and removal.
Guarantee: A generation inserted into the registry is removed before its
connection task can finish or die.
Check: `always` — for every path out of `serve_generation` after the insert, the
registry no longer contains that id, including the panic path.
Fault/timing angle: `close_generation` is the only remover and runs after
`read_tasks.wait()` and after the `shutdown_complete` rendezvous. Any unwind
before that line leaks the entry; the leaked `Arc<GenerationCore>` then keeps the
writer sender and pending map alive for host lifetime, and the shutdown sequence
iterates a generation whose task is gone.
Required faults and enabling state: a panic in the read loop, control handling,
grant, or close-route decision; or an abort while between insert and removal.
Confidence: high — the single-remover structure is directly readable and nothing
guards the interval.
Existing check: none.
Impact: a permanently leaked registry entry that shutdown will wait on.
Open questions: None.

### disconnect-releases-every-resource-keyed-to-the-connection

Type: safety
Status: active
Exercised: not yet — no test lands shutdown in the post-commit,
pre-registration window.
Guarantee: When a connection ends, every permit, charge, map entry, task, and
cancellation root created for it is released, including on the early-return path
taken while the host is draining.
Check: `always` — after the connection task returns, both permits are released,
the registry holds neither generation id, every owned route is finalized, and the
candidate's root token is cancelled.
Fault/timing angle: the gap is the promoted branch. `serve_generation` can return
early when draining is observed under the connections lock, before the read loop
runs. For the promoted generation `gen.token` *is* the candidate's root, and that
early return never cancels it, while the un-promoted arm explicitly discards the
sender and cancels the root. Release then depends on the abort-on-drop handle
rather than on the root the provider contract is written against.
Required faults and enabling state: a committed shutdown landing between the
candidate's commit completion and the promoted generation's registration.
Confidence: medium — the asymmetry and the early return are certain; what is not
established is whether any shipped provider's release depends on the root rather
than on task abort.
Existing check: `tests/lifecycle.rs:1722` covers shutdown before promotion;
`tests/transport_negotiation.rs:1522` covers the failure path. Neither lands in
this window.
Impact: a candidate transport whose root is never cancelled, released only
incidentally.
Open questions:
- Does any provider's release depend on root cancellation? That decides whether
  this leaks today. (needs human input)

---

## Group B: correlation and probe discipline

### request-correlation-strictly-increases-per-generation

Type: safety
Status: active
Exercised: partial — the watermark is covered; the pending insert is not.
Guarantee: Within one generation no consumer request correlation is accepted
twice, so a pending-request key can never collide with a live entry.
Check: `always` — for every accepted request frame and every rejection carrying a
header correlation, the correlation exceeded the watermark before the watermark
advanced; and the pending-map insert never returns an existing entry.
Fault/timing angle: none for the read-loop half, which is one task. The insert
silently overwrites, so correctness rests entirely on the watermark one function
away, with nothing asserting the insert returned empty.
Required faults and enabling state: a repeated or lower correlation; and for the
second clause, a mutation weakening the watermark while leaving the insert alone.
Confidence: high — both sites read; the check precedes the channel-0 split, so it
covers control and routed requests alike.
Existing check: `tests/dispatch.rs:211`
`a_non_increasing_correlation_closes_the_generation_before_dispatch` covers the
watermark. Nothing pins the insert return value. Status unaudited.
Impact: correlation reuse would cross-settle two requests.
Open questions: None.

### promoted-generation-refuses-the-setup-correlations

Type: safety
Status: active
Exercised: partial — the pre-commit case is covered; the post-promotion case is
not.
Guarantee: On a promoted candidate, correlations 1 and 2 are permanently spent, so
a client cannot re-drive setup or collide with the activation and commit
correlations from application traffic.
Check: `always` — a promoted generation's initial watermark equals the commit
correlation, and any request at or below it closes the generation before dispatch.
Fault/timing angle: the frames that make this matter are pipelined ahead of the
commit response. The setup driver deliberately stops polling the receiver while
awaiting write completion, so those frames are first observed by the promoted read
loop, which is exactly where this watermark applies.
Required faults and enabling state: a client that pipelines a correlation-1 or
correlation-2 request behind its commit request.
Confidence: high — the seed value and the comparison were both read.
Existing check: `tests/transport_negotiation.rs:1268` covers the pre-promotion
case. Nothing asserts a post-promotion low-correlation request is rejected.
Impact: a single wrong constant silently permits replay of the activation and
commit correlations.
Open questions: None.

### ping-and-consumer-correlations-cannot-cross-settle

Type: safety
Status: active
Exercised: yes — `tests/lifecycle.rs:468`
`ping_and_consumer_correlations_do_not_cross_settle` constructs a numerically
equal consumer correlation. Note that file runs in no CI job.
Guarantee: Host-originated ping correlations and consumer-originated correlations
never settle each other even when numerically equal.
Check: `always` — pong handling reads only the pings map; consumer terminals key
only the pending map by channel, epoch, and correlation.
Fault/timing angle: none; the separation is structural, two maps.
Required faults and enabling state: a consumer correlation numerically equal to a
live ping correlation.
Confidence: high — the two maps and both lookup sites read directly.
Existing check: as above. Status unaudited.
Impact: a cross-settle would let a client's request terminal clear a liveness
probe, defeating read-liveness detection.
Open questions: None.

### pong-preanswer-rejected-in-every-mutex-order

Type: safety
Status: active
Exercised: not yet — no test drives the two mutex orderings.
Guarantee: A pong observed strictly before its ping's bytes were written is never
accepted as an answer, regardless of which party wins the pings mutex.
Check: `always` — for every probe removed by the read loop, the read-loop
observation instant is at or after the probe's recorded write-completion instant.
The type's own doc states this unconditionally, so an accepted pre-answer is a
violation rather than a tolerated case.
Fault/timing angle: verified by direct read. The read loop samples
`now = Instant::now()` at `connection.rs:504` **before** acquiring the pings lock
at `:505`. If the writer's completion hook wins the lock first, it sets the
probe's `sent` to the completion instant; the read loop then takes the
completion-recorded arm and evaluates only
`now.duration_since(probe.sent) < pong_deadline` at `:519-521`. With
`completed_at > now`, tokio's `Instant::duration_since` saturates to zero rather
than panicking, so the comparison passes and the probe is removed. The
`answered_at >= completed_at` guard exists only in the hook's branch, not here.
Required faults and enabling state: a peer emitting a pong for a correlation
before the ping bytes complete (sequential correlations make this cheap), plus
writer-task preemption so the hook lands after the peer's pong is read, plus a
configured liveness policy.
Confidence: high — both branches read directly at HEAD, and the saturating
subtraction is documented tokio behaviour.
Existing check: none. `tests/lifecycle.rs:468` covers an *unmatched* pong, not a
matched pre-answer.
Impact: defeats the pre-answer defence the probe design exists to provide. A peer
that never reads its socket can keep a generation alive by answering pings it
never received, which is precisely what read-liveness is supposed to detect.
Open questions:
- Is the absence of the guard on this side an oversight, or is the design comment
  intended to cover it? The comment argues a peer that received bytes but answered
  without reading is indistinguishable from a real answer; that does not cover
  this case, where the pong is accepted before the bytes existed. (needs human
  input)

### host-ping-correlation-exhaustion-retires-the-generation

Type: safety
Status: active
Exercised: not yet — practically unreachable by exhaustion.
Guarantee: A correlation is never reused or wrapped; at exhaustion the sender
retires the generation instead.
Check: `always` — ingress holds by the strict watermark. Egress: the host's ping
allocator either saturates with a retirement or is proven not to wrap.
Fault/timing angle: none. The ping counter uses an unbounded `fetch_add`, so the
2^64-th ping wraps to correlation 0, and a ping with correlation 0 violates the
frame-shape rule the host's own client-side matching enforces.
Required faults and enabling state: none constructible; the record exists because
this is a documented MUST with no implementing code, which the wire protocol
explicitly calls out as a defect to be replaced with checked exhaustion.
Confidence: high — the counter and the absence of a bound were read directly.
Existing check: none.
Impact: negligible operationally, material contractually: the ingress half of
this rule is enforced and the egress half is not.
Open questions: None.

---

## Group C: task ownership, cancellation, shutdown

### no-task-outlives-the-generation-it-serves

Type: safety
Status: active
Exercised: not yet.
Guarantee: Every task holding a generation reference is a member of a set that
some shutdown path closes and waits on.
Check: `always` — enumerate spawn sites reachable from a generation; each is in
the generation's read-task set, or in the host tracker with a retained abort
handle, or owned by an abort-on-drop handle whose owner is itself tracked. Assert
the enumeration is exhaustive.
Fault/timing angle: `dispatch.rs:747` is the one bare `tokio::spawn` in the
connection path, verified. It is absent from the read-task set, so neither the
per-generation wait nor the shutdown wait covers it, and absent from the abort
handles, so the forced sweep cannot reach it. It self-bounds on one admission
deadline while holding a generation reference, so it can cancel a token for a
generation already removed from the registry.
Required faults and enabling state: an authenticated shutdown whose response is
admitted to the writer queue; the interesting case is a second shutdown on a
generation the first watchdog still holds.
Confidence: high — verified by enumerating every spawn in the three files; this is
the only untracked one.
Existing check: none.
Impact: harmless as written, which is exactly why it should be pinned: the
shutdown sequence's completeness argument rests on the enumeration being total.
Open questions:
- Should the watchdog be tracked? That makes its lifetime a stated part of the
  generation's at the cost of one abort handle.

### the-writer-task-is-abortable-through-a-stated-owner

Type: safety
Status: active
Exercised: not yet for the forced path.
Guarantee: Forced shutdown terminates every connection writer task.
Check: `always` — park a writer on a stalled peer, run the forced path, and assert
the host tracker's wait completes.
Fault/timing angle: the writer is spawned with the tracker's own `spawn`, not the
tracked helper, so no abort handle is registered and the forced sweep cannot reach
it directly. It *is* tracked, so the wait does cover it. Termination therefore
depends on a chain: the sweep aborts the connection task, which drops the
abort-on-drop handle, which aborts the writer. Break either link and forced
shutdown waits forever on a stalled writer while holding the instance lock.
Required faults and enabling state: a peer that authenticates then stops reading,
queued frames, and a drain that misses its deadline so the forced branch runs.
Confidence: high — the spawn-helper difference at this one site is unambiguous and
the abort chain is the only thing closing the gap.
Existing check: none for the forced path.
Impact: the instance lock is held until the tracker wait completes, so a surviving
writer blocks a successor incarnation.
Open questions:
- Is the omission deliberate, so the writer survives the sweep long enough to
  flush terminals and Goodbye? If so the compensating chain belongs in a comment.

### draining-rendezvous-is-released-or-the-loss-is-declared

Type: liveness
Status: active
Exercised: not yet.
Guarantee: A generation that observes draining while tearing down eventually
proceeds past the shutdown rendezvous, or the host declares that it did not.
Check: `always-or-unreached` — after the shutdown sequence returns, no task is
parked at the rendezvous; and if the drain timed out, the return value is
non-graceful and names it. `always-or-unreached` because the rendezvous is reached
only when draining was true at that instant; when the branch is skipped the
obligation does not exist and the check must not fail.
Fault/timing angle: the rendezvous await has no timeout and no competing arm. If
the drain times out during the route-settle loop, the cancelling line is never
reached and the parked task survives only because the forced sweep happens to hold
its abort handle. That handle exists because the connection task uses the tracked
spawn helper; had it used the lifecycle helper, the host would hang holding the
instance lock.
Required faults and enabling state: draining true, a generation whose read loop
exits inside the drain window, and a route-settle phase slow enough to consume the
shutdown deadline.
Confidence: high on the mechanism; medium on severity, since abort does rescue it,
but by abort, and no signal distinguishes drained from aborted mid-rendezvous.
Existing check: none.
Impact: the graceful-close guarantee degrades to task abort, two timeouts deep.
Open questions:
- Should the rendezvous carry its own timeout, or is "escaped only by the forced
  sweep" the intended contract? If the latter, the connection task's choice of
  spawn helper is a correctness requirement rather than a style choice.

### no-generation-registers-after-the-drain-snapshot

Type: safety
Status: active
Exercised: not yet.
Guarantee: The shutdown sequence's one-shot registry snapshot contains every
generation that will ever wait on the shutdown rendezvous.
Check: `always` — every inserted generation either appears in the snapshot or
completed its close before the snapshot was taken.
Fault/timing angle: the argument rests on two orderings. The draining flag is
stored with sequential consistency strictly before the snapshot, with an await
between, so any insert winning the connections lock afterwards reads true and
bails. And the check and insert share the snapshot's lock scope. Both hold as
written; neither is asserted. That the second draining writer is a *writer task*
rather than the shutdown path is what makes this non-obvious.
Required faults and enabling state: a socket accepted and authenticated between
the draining store and the snapshot; requires a multi-thread runtime to be
interesting.
Confidence: high that it holds, high that it is unchecked.
Existing check: none. The in-code comment documents only the token half of the
window, not the snapshot half.
Impact: one violation is a permanent hang.
Open questions: None.

### read-task-quiescence-implies-no-further-registration

Type: safety
Status: active
Exercised: not yet — the existing fence tests hand-roll the producer.
Guarantee: Once a generation's read-task set is closed and empty, nothing can
register another future in it.
Check: `always` — after the wait returns, the read loop has returned and no
registration site on that tracker is reachable.
Fault/timing angle: the tracker's wait completes when closed and empty, and
closing does not forbid later registration. Everything registering is spawned from
the read loop or before it starts, and the safety net is that the read loop is
itself tracked in the same set, so the count cannot reach zero while a producer
exists. The shutdown sequence closes the tracker while read loops are still live,
which is exactly the case the argument must cover.
Required faults and enabling state: a read cancellation fired while an emission
task is mid-flight.
Confidence: high — all ten registration sites enumerated; all are inside the read
loop's dynamic extent or precede it.
Existing check: `connection.rs:1598-1607` proves an already-started producer is
waited for, but hand-rolls the producer with a bare spawn instead of driving the
real read loop, so it does not cover who else can register. Both are
current-thread.
Impact: a refactor that spawns into the set from outside the read loop, or stops
tracking the read loop itself, makes shutdown silently stop waiting for producers.
Open questions: None.

### a-cancelled-emission-releases-every-permit-it-held

Type: safety
Status: active
Exercised: partial — connection permits on the candidate path only.
Guarantee: Aborting or dropping any off-reader emission task returns its pending
permit, its per-generation reject permit, and its egress byte charge.
Check: `always` — saturate the pools, abort the emission tasks, then assert both
semaphores return to full and the egress budget to zero.
Fault/timing angle: the pattern is a permit acquired before spawn and rebound
*inside* the future, which is what makes abort release it. Moving any binding
outside the async block leaks the permit on abort while leaking nothing on
success, so the bug would be invisible to a happy-path test.
Required faults and enabling state: pools at or near saturation, plus a forced
sweep or a read cancellation while emissions are parked on contended egress.
Without saturation the check cannot distinguish a leak from headroom.
Confidence: high — the binding is inside the future at all seven sites, verified.
Existing check: `tests/transport_negotiation.rs:1522` covers connection permits;
`tcp_frame_channel.rs:944` and `:1062` cover charges. Nothing covers pending or
reject permits under abort.
Impact: a stranded permit is unrecoverable without a restart.
Open questions: None.

### no-writer-hook-panic-poisons-a-generation-lock

Type: safety
Status: active
Exercised: not yet — requires an injected panic.
Guarantee: A panicking write-completion hook cannot leave any generation mutex
poisoned, and cannot convert one connection's fault into a panic on another task.
Check: `always` — install a hook that panics while holding the pings lock, then
assert the read loop's pong path and the liveness loop still make progress rather
than panicking on the lock.
Fault/timing angle: the completion hook is called synchronously inside the writer
task with no unwind guard, verified. The liveness hook takes the pings lock and
does instant arithmetic; a panic there poisons the lock, and the read loop, the
wake computation, the expiry scan, and the insert all expect a healthy lock. The
unwind also skips the writer's retirement signal, so the writer dies without
setting `retired` and senders learn only through the closed channel.
Required faults and enabling state: a configured liveness policy and an injected
panic in a completion hook. Unreachable today, which makes this a hardening
property rather than a live bug.
Confidence: high for the mechanism; medium that a hook can panic today, since no
current hook has arithmetic that must overflow.
Existing check: none. The comparable boundaries elsewhere *are* guarded — the
provider preflight, the prepare worker, and the writer's owned-conversion all
catch unwind. This call is the gap in an otherwise consistent policy.
Impact: every later connection becomes a panicking task, and because the panic
originates outside a handler callback it prints unredacted.
Open questions: None.

---

## Group D: the shutdown commit latch

### shutdown-commits-exactly-once-on-write-ack

Type: safety
Status: active
Exercised: yes — four in-crate latch tests plus three integration tests, though
the integration file runs in no CI job.
Guarantee: Across any number of concurrent and repeated shutdown requests, the
latch commits and the shutdown token is cancelled at most once per incarnation.
Check: `always` — drive concurrent and pipelined requests, some on generations
that retire mid-flight; assert the commit executes once, each requester receives
exactly one correlated response or none, and none receives two.
Fault/timing angle: the exclusion rests on the commit hook being moved into the
frame's written callback, so it either fires or is dropped, never both. The subtle
part is that commit is unconditional while reopen is guarded, so a late reopen
after a commit is a no-op but a late commit after a reopen would not be.
Required faults and enabling state: at least two requesters, plus a
pre-acknowledgement failure on the first owner.
Confidence: high — all transitions read and the mutual exclusion traced.
Existing check: strong. Four in-crate tests including one that directly pins the
enable-before-check rule against a lost wakeup, plus three integration tests.
Status unaudited.
Impact: this is the stop linearization point.
Open questions: None.

### admission-freeze-precedes-the-shutdown-commit

Type: safety
Status: active
Exercised: not yet — all four latch tests construct the hook with no registry.
Guarantee: At the instant the commit cancels the shutdown token, registry
admission is already frozen; no path can commit without freezing first.
Check: `always` — assert the freeze happens-before the cancellation on every path
that reaches the commit.
Fault/timing angle: this is a repaired defect. Generation registration once tested
only the draining flag, which the shutdown *sequence* stores, while a committed
shutdown cancels the token first, so a socket accepted in between registered a new
generation after the advertised admission-cancellation point and handler work
started after the commit. The registration gate now reads both, and dispatch
stores draining and freezes before acknowledging. But the commit only commits and
cancels; the freeze is entirely the caller's duty, unenforced by the type.
Required faults and enabling state: a socket accepted and authenticated between
the token cancellation and the freeze.
Confidence: high — the ordering and the unenforced duty were both read.
Existing check: the latch tests cannot see it, because they have no registry.
Impact: handler work admitted after the host promised it had stopped admitting.
Open questions: None.

### shutdown-commit-effects-are-all-or-nothing

Type: safety
Status: active
Exercised: not yet.
Guarantee: The commit point either applies all three effects — draining, frozen
route admission, latch commit plus token cancellation — or none.
Check: `always` — for every prefix of the hook body, if draining is set then the
shutdown token is cancelled, or a successor requester can still commit and reach
that state.
Fault/timing angle: the hook runs three effects in sequence inside the writer
task. Corrected after portfolio evaluation: a tokio **abort cannot** split it,
because the hook body is a synchronous closure with no await point, and tokio
cancels only at await points. Only a panic can, and there are two distinct
prefixes with different severities. A panic in the freeze leaves draining true
while the dropped hook reopens the latch, which is recoverable by a successor
requester. A panic inside the acknowledgement is worse: the acknowledged flag is
set *before* the commit, so the drop declines to reopen and the latch is stuck in
the in-flight phase with no possible successor. That second prefix is the wedge.
Required faults and enabling state: an authenticated shutdown that reaches write
completion, plus a panic at one of the two prefixes.
Confidence: medium — the hazard and both prefixes are read directly; a panic in
the freeze could not be constructed by inspection, so reachability rests on the
general no-unwind-guard argument rather than a specific panicking operation.
Existing check: one test covers the hook never running. Nothing covers it running
partially.
Impact: a wedged host holding the instance lock.
Open questions: None.

### latch-wake-cannot-be-lost

Type: liveness
Status: active
Exercised: yes — one in-crate test directly pins the enable-before-check rule.
Guarantee: A shutdown requester that observes the wait state is always woken by
the next phase change.
Check: `always` — for every interleaving of ownership attempt, reopen, commit, and
a waiter's change-future lifecycle, the waiter eventually returns owner or
committed.
Fault/timing angle: the notification wakes only enabled or already-polled futures
and stores no permit, so the enable-before-recheck order is load-bearing. Reopen
releases the phase lock before notifying while commit notifies while holding it;
the asymmetry is harmless for a wake-all but is undocumented and would matter if
either became a wake-one.
Required faults and enabling state: at least two concurrent requests on distinct
generations, plus a pre-acknowledgement failure so reopen fires rather than
commit. Needs a multi-thread runtime for the notify-between-check-and-poll
interleaving to be reachable, and every existing test is current-thread.
Confidence: high — the protocol is correct as written and the reasoning is
spelled out in comments.
Existing check: the strongest existing check in this scope. Status unaudited.
Impact: a lost wakeup is a permanently stuck requester holding a pending permit.
Open questions: None.

---

## Group E: daemon incarnation and the probe

### probe-never-reports-stopped-while-either-fence-is-held

Type: safety
Status: active
Exercised: yes — five in-crate tests, all Linux-only.
Guarantee: The probe returns stopped only when both the lifetime fence and the
runtime-directory instance lock are observed free.
Check: `always` — for every evidence shape, hold each fence in turn and assert the
verdict is never stopped; in particular, replace the subtree under a live daemon
and assert wedged.
Fault/timing angle: the two fences are acquired in opposite orders at start and
teardown, so a probe can legitimately land where exactly one is held; the code
absorbs that with a bounded disagreement grace and then classifies wedged. The one
coherent single-fence shape, a held runtime lock with a free lifetime fence and a
legacy record, is a pre-coordination incumbent and classifies by its record.
Required faults and enabling state: a live daemon plus namespace replacement, or a
probe sampling inside the few-syscall window between the two acquisitions.
Confidence: high — stopped is returned from exactly two places and both require
the lifetime fence free.
Existing check: strong, five tests. Status unaudited; all Linux-only.
Impact: a false stopped authorizes a launcher to start a second incarnation over a
live one.
Open questions: None.

### stopping-precedes-unpublication-on-every-path

Type: safety
Status: active
Exercised: partial — the success path only.
Guarantee: When an incarnation removes its publication, the on-disk record already
reads stopping, so an orderly stop never classifies wedged.
Check: `always` — fault-inject the phase write, run each teardown path, and assert
either the publication survives until the phase is demoted, or the verdict is not
wedged, or the failure is surfaced.
Fault/timing angle: the ordering inside the demotion function is correct and all
five teardown paths route through it. The gap is that the phase write's error is
discarded and teardown proceeds regardless. The in-code justification, that a
stale phase ages to wedged honestly, covers a *successful* write followed by a
hang, not a *failed* write, which produces an immediate wedged for a clean stop.
Required faults and enabling state: a storage or permission failure on the runtime
directory at teardown, with a publication still present.
Confidence: high on the ordering and the discarded error; medium on reachability.
Existing check: two tests cover the success path. Nothing covers the failed write.
Impact: an orderly stop reported to the operator as a fault.
Open questions:
- Is a failed demotion meant to abort or delay publication removal? The contract
  says MUST demote first without saying what a failed demotion means. (needs human
  input)

### phase-evidence-outlives-a-long-phase

Type: liveness
Status: active — **reframed after portfolio evaluation**
Exercised: not yet.
Guarantee: The documented freshness window is wide enough for every phase the
implementation can legitimately take, or the phase budget is coupled to the window
so the two cannot disagree.
Check: `always` — for a live coherent incarnation holding both fences, no phase
that the configuration permits can exceed the freshness window. The framing was
corrected: an earlier revision asserted that a healthy long phase must never be
classified wedged, which **contradicts the documented contract**. The protocol's
classification table states that an expired record in any phase is wedged, and its
prose says the freshness windows "still age a hung start or stop to wedged". So
ageing out is specified behaviour, not a violation. The real defect is a
*coupling* gap, which is what this record now states.
Fault/timing angle: the record is written once per phase transition and never
refreshed, and freshness compares it against a fixed 60 second wall-clock window
(`lifecycle.rs:770-776`, value at `:773`). That window is **not configurable**: the
sole production construction is the default, with no flag, field, or environment
override. Meanwhile the frame deadline and the lifecycle callback deadline are
operator-settable up to 365 days. So an operator can legally configure a phase
budget three orders of magnitude larger than the window that judges it, and
nothing couples them.
Required faults and enabling state: a configuration whose callback or drain budget
exceeds 60 seconds, or a slow filesystem making a phase exceed it. No adversary
needed.
Confidence: high — the window value, its non-configurability, and the settable
budgets were all verified. One candidate cause the earlier revision named,
per-file hashing during payload validation, was **refuted**: it runs before the
phase record exists.
Existing check: two tests assert that expiry produces wedged, which is the
documented behaviour. Nothing asserts the window bounds what the configuration
permits.
Impact: the freshness window is an undocumented hard cap on startup and shutdown
duration, and it is the one value in the pair that cannot be tuned.
Open questions:
- Should the window scale with the configured budgets, or should the budgets be
  clamped to it? Either couples them; the protocol specifies neither. (needs human
  input)

### clock-anomalies-do-not-invalidate-live-evidence

Type: safety
Status: active
Exercised: not yet — both freshness tests manipulate the record, not the clock.
Guarantee: A wall-clock step or an unrepresentable clock value does not reclassify
a live incarnation.
Check: `always` for a live coherent incarnation — the probe is invariant to
wall-clock adjustments larger than the freshness window.
Fault/timing angle: the millisecond helper collapses a pre-epoch clock to zero and
an unrepresentable count to the maximum. Zero fails the freshness test in one
direction, the maximum fails it in the other, so both directions of a real NTP
step or a suspend and resume longer than the window produce wedged. Neither the
daemon nor the probe uses a monotonic source for this comparison, and there is no
skew allowance beyond the same 60 second value used for expiry.
Required faults and enabling state: a clock step exceeding the window, or a clock
set before the epoch, concurrent with an incarnation in starting or stopping.
Confidence: high — the saturating collapses and the wall-clock comparison are
literal.
Existing check: one test confirms the future-side behaviour is intended for a
*forged* record; it does not distinguish forgery from a clock step.
Impact: a routine time correction reclassifies a healthy host as incoherent.
Open questions: None.

### legacy-incumbent-classification-needs-an-unforgeable-witness

Type: safety
Status: active
Exercised: partial — the regression test plants exactly the forgery by hand.
Guarantee: A running verdict derived from a legacy record is accompanied by
evidence the record's author cannot forge, or the verdict is wedged.
Check: `always` — for a legacy-shaped record beside a matching publication, the
running verdict requires a witness not writable by whoever wrote the record.
Fault/timing angle: this is a repaired defect whose fix widened the classification
to an unauthenticated shape. A canonical-digest requirement once made every
pre-coordination record decode as malformed, so routine upgrades saw an alarm
instead of a stoppable incumbent. The fix accepts *any* empty-digest record beside
a matching publication as running. Both files are attacker-writable under the
same-user model, and nothing distinguishes a genuine pre-coordination daemon from
a squatter holding only the runtime-directory flock.
Required faults and enabling state: a planted empty-digest record plus a matching
publication, with the runtime lock held.
Confidence: high — the widened predicate was read directly, and the regression
test constructs the forgery itself.
Existing check: one test pins the classification, using the forgeable shape.
Status unaudited.
Impact: a squatter is classified as a live incumbent, which suppresses a
successor.
Open questions:
- Are pre-coordination releases trusted by definition? If so, state it; if not,
  the rule needs an unforgeable witness. (needs human input)

### an-observed-wedge-cause-reaches-the-operator

Type: reachability
Status: active
Exercised: not yet.
Guarantee: When the host distinguishes a wedge cause, that distinction is
observable outside the process.
Check: `reachable` — for each distinguished wedge reason, some operator-visible
output differs. This is location and output coverage, not a state to construct.
Fault/timing angle: none. The classifier computes thirteen distinct reasons; the
sole production consumer forwards one and collapses the rest to a bare "wedged".
A probe *error* also becomes "wedged", erasing the distinction between fence
incoherence and an I/O failure. Verified: the crate has no tracing or log
dependency, so there is no second channel.
Required faults and enabling state: any wedge other than the forwarded one; two
are already fixtured in the existing tests.
Confidence: high — the forwarding is a single conditional and the reason table is
complete in one function.
Existing check: none. In-crate tests assert the reason field directly, so the
crate proves the reasons are computed while nothing proves they are conveyed.
Impact: twelve of thirteen diagnosable causes are indistinguishable to an
operator, and remediation advice is uniform where the causes are not.
Open questions:
- Is only the forwarded reason a contract, with the other twelve as pure
  diagnostics? If so they are diagnostics nobody can see. (needs human input)

---

## Group F: the payload generation store

### current-profile-never-names-an-unvalidatable-generation

Type: safety
Status: active
Exercised: partial — success and post-hoc tampering only; no fault injection and
no crash test.
Guarantee: After any outcome of staging and promotion, including a crash at any
point, the current profile is absent, quarantined, or names a digest that
validates.
Check: `always` — for every fallible step, inject a failure and a simulated crash,
then assert the invariant on the store.
Fault/timing angle: durability ordering carries this. Files and every created
directory are synced deepest-first inside the temp, the promoting rename is
followed by a directory sync, and only then is the profile rewritten and the root
synced. A crash between promote and profile replacement leaves an orphan that a
later prune removes as unprotected.
Required faults and enabling state: storage exhaustion at each write and sync
point, a delayed-allocation filesystem so exhaustion first surfaces at sync, and
power-loss simulation between the two renames, all under the transaction lock.
Confidence: high on the ordering; medium on completeness, since the
exchange-then-revalidate window has a state where the digest name holds a
candidate and the temp name holds the corrupt orphan.
Existing check: four tests cover the success path, same-digest convergence,
post-hoc tampering, and the quarantine abort. Status unaudited.
Impact: the profile is the selector that decides which payload the daemon
executes.
Open questions:
- Should the exchange-then-revalidate window be crash-tested? Whether any reader
  can observe the intermediate was not established.

### validation-and-enumeration-address-one-directory-object

Type: safety
Status: active
Exercised: partial.
Guarantee: Every read, walk, and removal in a store operation resolves through the
descriptor that operation pinned, never through a re-resolved pathname.
Check: `always` — for every store operation, a replacement directory planted at
the operation's name cannot redirect a read, a walk, or a removal.
Fault/timing angle: this is a defect class that recurred. Validation once verified
manifest-listed files through a retained descriptor while walking for unlisted
entries by pathname, so a replacement directory holding only the expected names
satisfied the walk while the result still pinned the original. That was fixed. The
identical split then survived in prune for eight more review rounds, where
enumeration by pathname drove deletions inside the pinned store.
Required faults and enabling state: a directory replacement between the pin and the
walk, under the transaction lock.
Confidence: high — both instances read as diffs.
Existing check: partial; the fixed instances have regression tests. Nothing
prevents a third instance.
Impact: two separate shipped defects from one class, and the class was never swept.
Open questions:
- How many more instances exist? A sweep of every pathname-based call in the store
  would settle it.

### an-undecidable-quarantine-witness-fails-closed

Type: safety
Status: active
Exercised: partial — the oversize case only.
Guarantee: For every *read-failure* mode of the lifecycle record and the generation
manifest, the quarantine gate refuses the mutation rather than admitting an
overwrite or a delete.
Check: `always` — for an oversize read, an I/O error, and a permission error, the
gate reports quarantined. Scope narrowed after portfolio evaluation: an earlier
revision also included non-regular shapes. That clause is **wrong** for the
lifecycle record, where replacing a planted symlink or FIFO at the record name
without following it is deliberate, documented, and covered by a passing test. The
property is about *undecidable reads*, not about hostile shapes, which have their
own separate and correct handling.
Fault/timing angle: this is a repaired defect with an unswept sibling. The
lifecycle gate once failed open on open, stat, and read failures, which admits the
start, and startup then overwrites the record by atomic rename. That was fixed.
The manifest-side gate still returns removable on four distinct failure modes, and
the most reachable of them is one the earlier revision did not name: the child
directory open rejects **any** group or other mode bit, so a 0o755 generation
directory from a future release or a restored backup is classified removable and
deleted. The other three are a missing or symlinked manifest, a stat error on an
open descriptor, and a read error.
Required faults and enabling state: a generation directory with a wider mode, or an
oversize manifest, or an I/O error on either object.
Confidence: high — the four early returns were enumerated and their reachability
ranked; the mode-bit cause is the practical one.
Existing check: one test covers the oversize manifest case.
Impact: a retained generation written by a newer release, or restored with wider
modes, is deleted by prune. That is the forward-compatibility break quarantine
exists to prevent.
Open questions: None.

### persisted-state-quarantine-caps-agree

Type: safety
Status: active
Exercised: not yet — statically checkable, and currently false.
Guarantee: The size above which persisted state is unreadable and therefore
quarantined is one value across the lifecycle record and the generation manifest.
Check: `always` — the two caps are equal, or the comment claiming they match is
removed and each threshold is separately justified.
Fault/timing angle: forward compatibility. Verified: the evidence cap is 65,536
bytes and the manifest cap is 1,048,576 bytes, sixteen times apart, while the
manifest constant is documented as "matching the lifecycle evidence cap". A future
release writing a 100 KiB record is quarantined by this release; a 100 KiB manifest
is not. A maintainer adjusting one cap on the comment's authority moves only one
threshold.
Required faults and enabling state: none.
Confidence: high — both constants and the claim read directly.
Existing check: none.
Impact: the two forward-compatibility thresholds that must agree do not, and the
code says they do.
Open questions: None.

### every-declared-cli-reason-id-has-a-producer

Type: reachability
Status: active — **premise corrected after portfolio evaluation**
Exercised: not yet.
Guarantee: Each reason id the release contract declares is emitted by the layer
the remediation implies, and a condition that maps to one id is not reported under
another.
Check: `reachable` — for each declared id, at least one site can produce it, and
the producing layer matches the remediation's audience.
Fault/timing angle: no timing angle. An earlier revision of this record claimed
`unsupported_filesystem` has **no** producer anywhere in the workspace. That is
false and is corrected here: it is produced in TypeScript, by the managed-policy
path preflight (`packages/plugin/src/shared/mc-host-lifecycle/paths.ts:157`), with
its own passing tests. What remains true, and is the real finding, is narrower:
the **Rust** conditions that ought to yield it — an atomic exchange unsupported on
the volume, a filesystem without the rename flags, a cross-device rename — all map
to the payload-invalid error instead, so a user whose filesystem cannot support the
operation is told to reinstall the payload. The declared id exists and is
reachable; the native classification does not use it.
Required faults and enabling state: a data root on a filesystem lacking atomic
same-filesystem exchange, with a corrupt unprotected occupant at the digest name so
promotion reaches the exchange.
Confidence: high — the TypeScript producer and the Rust mis-mapping were both
verified, and 17 of 31 declared ids have Rust producers.
Existing check: the TypeScript side has targeted tests. Nothing checks that the
native error classification uses the declared vocabulary.
Impact: an operator-facing diagnosis exists but the native layer cannot emit it, so
the same root cause produces different advice depending on which layer noticed.
Open questions:
- For the 13 declared ids with no Rust producer, is the intent that the
  TypeScript policy layer owns them entirely? A partial survey found producers for
  some; no count is asserted. (needs human input)

---

## Group G: the panic boundary

### every-callback-invocation-is-inside-the-redaction-guard

Type: safety
Status: active
Exercised: partial — one test pins the not-over-broad direction.
Guarantee: Every call into untrusted handler or provider code runs with the
redaction guard active, for both the synchronous prologue and each individual
future poll.
Check: `always` — every invocation is wrapped; a panic in any callback emits only
the redacted string; and a panic on the same worker from an unrelated task is not
redacted.
Fault/timing angle: the guard is a thread-local depth counter incremented per poll
rather than per await, so a yielded callback cannot suppress another task's panic
on the same worker. Installation is once-only, so the first caller decides which
prior hook is preserved, and any hook installed by a test harness afterwards is
replaced.
Required faults and enabling state: a panicking callback, plus a concurrently
panicking unrelated task on the same worker to prove the guard is not over-broad.
Confidence: high on the inventory, which is an exhaustive grep of roughly twenty
call sites; medium on the guarantee, because the promise is enforced by convention
at each site with nothing in the type system requiring a new site to wrap.
Existing check: `tests/dispatch.rs:661` pins the not-over-broad direction. Verified:
`panic_boundary.rs` has **zero** test modules of its own, so nothing asserts what
is printed, that the prior hook is preserved, or that the depth counter unwinds
correctly through a panic.
Impact: one unwrapped call site leaks handler panic payloads and backtraces.
Open questions: None.

### the-panic-hook-cannot-itself-fail

Type: safety
Status: active
Exercised: not yet.
Guarantee: Reporting a redacted callback panic never escalates into process abort
or an indefinite stall.
Check: `always` — the hook completes without panicking and without blocking, for
every state of the standard error stream.
Fault/timing angle: the hook's only output is a single `eprintln!`, verified, which
panics on a write error. A panic inside the hook is a nested panic and therefore an
abort, which bypasses the stopping demotion entirely, so the publication and a
running record survive and the launcher never observes stopping. The daemon's
standard error is a log file, so the live trigger is a full or failing disk —
precisely the condition the storage-exhaustion error exists to name. If the stream
is a pipe whose reader has stalled, the write blocks and the panicking thread parks
inside the hook.
Required faults and enabling state: a callback panic concurrent with a write
failure on the standard error stream, or a non-draining consumer.
Confidence: medium — the panic-on-write-error and nested-panic-abort behaviours are
stable standard-library semantics; the disk-full coincidence is plausible rather
than demonstrated.
Existing check: none.
Impact: a callback panic plus a full disk converts a redacted diagnostic into an
abort that skips the entire teardown ordering.
Open questions: None.

---

## Group H: observability and coverage

### authentication-and-capacity-rejections-are-observable

Type: reachability
Status: active
Exercised: not yet.
Guarantee: A rejected connection produces some record an operator can see.
Check: `reachable` — for each rejection class (authentication failure, connection
capacity exhaustion, post-authentication drain refusal), some counter, log, or
frame differs from the accepted case.
Fault/timing angle: none. Verified: authentication failure returns with no counter,
no log, and no rate signal, and the peer address is already dropped at accept, so
a credential-probing client is indistinguishable from silence. Capacity exhaustion
and drain refusal both drop an authenticated client with no frame. The crate has
no tracing or log dependency, so there is no channel to carry any of it.
Required faults and enabling state: an authentication failure, a capacity
exhaustion, and a drain refusal.
Confidence: high — all three discard sites verified at their line numbers.
Existing check: none.
Impact: the single most alarm-worthy event in the connection path produces nothing,
and capacity exhaustion looks like a network reset to both sides.
Open questions: None.

### the-largest-lifecycle-proof-runs-in-ci

Type: reachability
Status: active
Exercised: no — this is the finding.
Guarantee: The executed proof of shutdown ordering, lock-release ordering, latch
commit, fence overlap refusal, and probe-across-an-incarnation runs in continuous
integration.
Check: `reachable` — the lifecycle, activation, and roundtrip integration binaries
are named in a workflow and execute on at least one platform.
Fault/timing angle: none; a configuration fact.
Required faults and enabling state: none.
Confidence: high — verified directly. Of `mc-host`'s 26 integration binaries, CI
names four: the library tests, two shared-memory suites, one negotiation suite, a
macOS soak, one filtered macOS library test, and doc tests. `tests/lifecycle.rs`,
`tests/activation.rs`, and `tests/host_roundtrip.rs` appear in no workflow. The
only `--test lifecycle` match in the workflows is a different crate's
`lifecycle_cli`.
Existing check: none — this record *is* the check.
Impact: 36 tests and 1872 lines, including the regression tests for ten repaired
lifecycle defects, execute only when a developer runs the local script. Separately,
no in-crate lifecycle or generation test executes on macOS: the macOS library step
names exactly one filter, and a prior commit records that the library test target
did not even compile on macOS on main. **Gap closed by the ring-transport
refactor, observed 2026-08-30.** `ed487e11 refactor(host): make ring transport
mandatory` rewrote the CI workflow: `.github/workflows/ci.yml:156` adds `--test
lifecycle` to the Linux `mc-host` run and `:164` adds `--test client --test
lifecycle` to the macOS run, so the lifecycle binary now executes on both
platforms. The record is retained because the gap was real and its closure is the
evidence. Two residual gaps are narrower than the original finding:
`tests/activation.rs` and `tests/host_roundtrip.rs` remain unnamed, and the
`--test lifecycle` in the `mc-module` step at `:149` is still the unrelated
`lifecycle_cli` binary, not this one.
Open questions:
- Is the exclusion deliberate or an oversight? 22 of 26 binaries are unnamed, which
  is a broad pattern rather than a targeted exclusion. (needs human input)

## Group I: setup-state transitions

Five records closing the gap the portfolio evaluation queued at
`portfolio-evaluation.md:96`: the setup state machine in `connection.rs` has four
in-code states against the eight the wire protocol's section 7.7 documents, and no
record covered the transitions. The first three are the gate itself, that
negotiation precedes every gated frame kind, that the selection is sticky for the
generation, and that readiness is decided by one predicate rather than by two
copies of it. The last two are the sharp edges: a `Pong` that the documentation
retires and the code requires inside the same window, and a fallback-reason
precedence rule that is test-only because no shipped configuration installs a
provider that can set a reason.

### negotiation-precedes-every-gated-frame-kind

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/transport_negotiation.rs:906-949` covers four
channel-0 control operations, one routed request, and one oversize control
declaration before negotiation. `Cancel`, routed `Goodbye`, and `Pong` before
negotiation are uncovered, and no case asserts the absence of an emitted
terminal.
Guarantee: while the setup state is `BootstrapTcp` or `CandidateSetup`, no
routed request is dispatched, no cancel is applied, no routed goodbye begins a
close, no non-negotiate channel-0 control action is admitted, and no
oversize-rejection terminal is emitted; the generation retires instead.
Check: `always` — for every inbound frame, assert that
`transport_ready(setup) == false` implies the read loop returned
`ReadExit::Peer` without reaching `dispatch_request` (`connection.rs:486`),
`handle_cancel` (`:498`), `begin_close_owned` (`:566`), the control admission
block (`:659` onward), or `emit_authoritative_rejection` (`:454`). `always` and
not `unreachable`, because the forbidden thing is a *state pairing* (not ready,
yet dispatched) rather than a code location that must never execute: all five
sites are legitimate once ready.
Fault/timing angle: pipelining. The client may send the gated frame in the same
TCP segment as, or immediately after, its negotiate request. The state commits
at `:960` before the response is queued at `:961`, so the interesting window is
frames that arrive after `:960` but before the client could have read the
selection; those are legitimately accepted, and a test must not mistake them
for a gate failure.
Required faults and enabling state: a raw client that authenticates and then
sends one frame of each gated kind without negotiating. No provider, no
liveness, and no fault injection: `TestHost::start` plus `setup_client`
(`tests/support/mod.rs:688`) is sufficient. Reaching the `CandidateSetup` half
of the state predicate additionally needs an injected provider, which is
test-only; the `BootstrapTcp` half is the default path.
Confidence: high —
[evidence](evidence/negotiation-precedes-every-gated-frame-kind.md). All five
gate sites and all fourteen frame-kind arms enumerated against
`connection.rs:417-598` and `:626-647`.
Existing check: `tests/transport_negotiation.rs:906` covers six of the eight
gated shapes and asserts no bind occurred; it does not cover `Cancel`, routed
`Goodbye`, or the absence of a terminal on the oversize path.
Impact: any hole admits application-visible work on a connection whose
transport is not yet chosen, which is the one thing section 7.7 exists to
forbid. A routed dispatch there would run handler code the client can then be
told to reach over a different transport.
Open questions:
- Should a premature oversize control declaration receive the section 7.1
  authoritative terminal before retiring, or does the setup gate correctly
  outrank it? The code chooses the gate (`:430` refuses before any emission),
  while the malformed-negotiate path chooses the terminal (`:849-875`). The
  document specifies both rules and does not order them. (needs human input)

### setup-selection-is-sticky-for-the-generation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/transport_negotiation.rs:962-980` covers a repeated
negotiation after a negotiated TCP selection. Negotiation during
`CandidateSetup`, negotiation on a promoted `ProviderActive` generation, and
the at-most-one-candidate claim are uncovered.
Guarantee: at most one negotiation commits per generation. Once the state
leaves `BootstrapTcp` it never returns, at most one candidate handoff is ever
recorded, and any later or repeated negotiation retires the generation.
Check: `always` — instrument the two `setup.state` writes (`connection.rs:960`,
`:1103`) and the `setup.handoff` write (`:1104`); assert at most one of each
per `ConnectionSetup`, assert no write whose prior state is not `BootstrapTcp`,
and assert every `handle_negotiate` entry with a non-`BootstrapTcp` state
returns `ControlFlow::Close` (`:846-848`). `always` because stickiness is
evaluated on every negotiate frame, and a single violation hands one connection
two transports.
Fault/timing angle: none in the single-reader design. All three writes happen
on the sole read loop, so no interleaving can produce two selections. The
timing question is the reverse one: the state closes at `:960` and `:1103`
before the corresponding response is emitted, so retirement of a late
negotiation can be observed by the client before it observes the first
selection.
Required faults and enabling state: a raw client that negotiates twice. The
`TcpCommitted` arc needs no provider and no configuration. The `CandidateSetup`
and `ProviderActive` arcs need an injected provider, which is test-only; that
is why this record is labelled by its default-reachable arc and the provider
arcs are named explicitly.
Confidence: high —
[evidence](evidence/setup-selection-is-sticky-for-the-generation.md).
`setup.state` has exactly two write sites and `setup.handoff` exactly one, all
enumerated by grep over `connection.rs`.
Existing check: `tests/transport_negotiation.rs:962`
`repeated_negotiation_after_negotiated_tcp_selection_retires` covers the
`TcpCommitted` arc only. Status `unaudited`.
Impact: a second accepted negotiation would prepare a second candidate,
overwrite `setup.handoff` at `:1104`, and leak the first candidate's sender,
cancellation root, and I/O task, because the setup owner reaps only what the
slot still holds (`:201-234`).
Open questions: None.

### setup-readiness-is-decided-by-one-predicate

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads the setup state directly, and no lint or
test asserts that the two predicate copies agree.
Guarantee: exactly one definition decides whether a generation may carry
non-setup traffic, and every frame-kind gate consults that one definition, so a
new setup state cannot be ready for one frame class and not another.
Check: `always` — assert that the set of `TransportState` variants accepted by
`transport_ready` (`connection.rs:832-837`) equals the set accepted by the
inline `matches!` in `handle_control` (`:642-645`), and that no third readiness
test exists. Enforceable as a test over an extracted predicate, or mechanically
by deleting the inline copy and calling `transport_ready`; the property is the
agreement, not the shape. `always` because the two copies are evaluated
independently on every frame.
Fault/timing angle: none. This is a structural property of the source, and the
fault is a future edit rather than a runtime interleaving.
Required faults and enabling state: none for the current tree, which satisfies
the property. To make the check meaningful, add a fifth `TransportState`
variant in a test fixture, or assert both predicates over all variants; the
`matches!` shape means a new variant is refused by both copies unless a author
adds it, which is the fail-closed direction.
Confidence: high —
[evidence](evidence/setup-readiness-is-decided-by-one-predicate.md). Both
predicate bodies read at HEAD and confirmed textually identical over the same
field; the four `transport_ready` call sites and the one inline site
enumerated.
Existing check: none.
Impact: divergence makes the negotiation-first gate non-uniform for exactly one
frame class, which is the shape the `Pong` hole already has. This record is the
structural reason that hole is easy to create.
Open questions:
- Is the inline copy at `:642-645` deliberate, for example to keep
  `handle_control` independent of a `connection.rs`-private helper, or is it
  incidental duplication? (needs human input)

### a-setup-pong-is-required-and-forbidden-in-the-same-window

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test sends a `Pong` before negotiation, and no test
runs a configured liveness policy against a generation that has not yet
negotiated.
Guarantee: contested. `docs/mc-host-wire-protocol.md:562` states that a `Pong`
retires the setup generation. `connection.rs:500-540` implements no readiness
gate in the `Pong` arm, and `connection.rs:291-302` starts liveness probing
before the read loop is awaited at `:304`, so with liveness configured the host
demands a `Pong` in exactly the window the document says a `Pong` must retire.
This record catalogues the contradiction with both sides cited and does not
choose between them.
Check: `sometimes` — assert that a campaign produces at least one interval in
which the setup state is `BootstrapTcp` or `CandidateSetup`, a host Ping is
outstanding in `gen.pings`, and a matching `Pong` is delivered to the read
loop. Marker `SETUP_PONG_WINDOW_OBSERVED`. `sometimes` and not `always`,
because asserting either resolution would resolve a normative question this
record exists to record: the honest check is that the window occurs, so a human
can decide against a real trace. Situation coverage, not location coverage: the
`Pong` arm's lines are already executed by post-negotiation tests while the
setup window is never produced.
Fault/timing angle: the whole record is a window. It opens when `liveness_loop`
is spawned at `:296` and closes when the state commits at `:960` or `:1103`.
Its width is `ping_interval` versus the client's time to negotiate, so a fast
client never sees a Ping and a slow or paused client always does. The grant
path narrows, but does not close, the window: it stops and joins bootstrap
liveness at `:1032-1036`, which is after any bootstrap Ping may already have
been sent.
Required faults and enabling state: `liveness: Some(..)` in `HostConfig`, which
is not a shipped configuration in this tree; the default is `None`
(`config.rs:296`) and the only `Some` is inside the test module
(`config.rs:664`). Plus a client that authenticates, delays negotiation past
`ping_interval`, and then answers the Ping. The weaker half of the
contradiction, that an *unsolicited* `Pong` before negotiation is silently
ignored rather than retiring the generation, needs no liveness at all and is
default-production; it is a strictly smaller claim and is recorded in the
evidence file.
Confidence: high —
[evidence](evidence/a-setup-pong-is-required-and-forbidden-in-the-same-window.md).
Both sides read at HEAD: the document sentence, the ungated `Pong` arm, the
liveness start point, and the grant path's own comment explaining that
bootstrap probing is live during setup.
Existing check: none. `pong-preanswer-rejected-in-every-mutex-order` in this
catalog covers the `Pong` arm's acceptance rule, not its absent readiness gate.
Impact: unresolved, and that is the finding. Under the document's reading the
host kills healthy generations' probes by answering them; under the code's
reading the document forbids a frame the host itself solicits. A test author
picking either side without a decision would encode a guess as a regression
test.
Open questions:
- Should the document drop `Pong` from the retirement list at `:562`, or should
  liveness probing be deferred until a selection commits? (needs human input)
- If probing is deferred, does the setup deadline
  (`shared.timing.transport_setup_deadline`, used at `:1022`) fully replace
  liveness for detecting a peer that authenticates and then goes silent without
  negotiating? The bootstrap has no such deadline before a grant.

### fallback-reason-precedence-survives-a-silent-preflight

Type: safety
Reachability: test-only
Status: active
Exercised: partial — `tests/transport_negotiation.rs:876-905` covers capability
mismatch falling back and version mismatch retiring; `:851-874` covers an
unprovided non-TCP offer selecting reasonless TCP. No test produces
`DynamicallyUnavailable`, and no test pairs it with a mismatched sibling to
exercise the precedence.
Guarantee: when both conditions are present across the evaluated offers,
`unavailable` outranks `capability_version_mismatch`; a permanently absent
provider and a panicking preflight both contribute no reason and select
reasonless TCP.
Check: `always-or-unreached` — whenever a reason is computed
(`connection.rs:953-959`), assert `dynamically_unavailable` implies the emitted
reason is `Unavailable` regardless of `capability_mismatch`, and that a
`StaticallyOmitted` or panicking preflight contributes no reason. These
semantics and not `always`, because the path may never run in a shipped
configuration: with an empty provider registry both flags are unconditionally
false, so it must be correct when reached rather than reached at all.
Fault/timing angle: a panicking preflight is the fault of interest. It is
caught at `:907-912` and mapped to `StaticallyOmitted`, so a broken provider is
indistinguishable from one that was never installed, and the client is denied
the re-upgrade probe that `docs/mc-host-wire-protocol.md:621` reserves for
`unavailable`. Ordering matters too: the loop breaks on the first serveable TCP
offer (`:892-896`), so offers after the TCP entry are never evaluated and
cannot contribute a reason.
Required faults and enabling state: at least two injected providers, one
returning `DynamicallyUnavailable` from `preflight` and one installed at a
capability version the client does not offer, with the client offering the
unavailable transport at lower preference than the mismatched one. Injected
providers are test-only: `TransportProviders::default()` is empty
(`transport_provider.rs:157-163`), the module documents providers as
test-injected (`:1-13`), and `HostConfig::default` installs the empty registry
(`config.rs:297`). Verified consequence: in every shipped configuration the
reason is always `None`.
Confidence: high —
[evidence](evidence/fallback-reason-precedence-survives-a-silent-preflight.md).
Precedence block, preflight default, panic mapping, and the `serves_transport`
gate all read at HEAD; the empty-registry conclusion traced from
`HostConfig::default` to `TransportProviders::default`.
Existing check: `tests/transport_negotiation.rs:136`
`version_mismatches_encode_the_documented_tcp_fallback_reasons` covers the
encoders, and `:876` covers one live mismatch fallback. Neither covers
precedence between the two reasons. Status `unaudited`.
Impact: reporting a static mismatch where a transient condition exists
permanently suppresses the client's re-upgrade probe, so a transport that would
recover in seconds stays unused for the life of the connection. The panic
mapping has the same effect for a provider whose preflight is merely buggy.
Open questions:
- Should a panicking preflight be observably different from permanent absence,
  for example through a host-side event, given that the wire reason must stay
  reasonless per the KTD6 comment at `:906`? (needs human input)

## Group J: shared frame-read mechanics

Six records on `crates/mc-host/src/frame_read.rs`, 125 lines of shared
host-and-client code whose own module doc named cancellation precedence, EOF
handling and frame-boundary capping as load-bearing while the file had no tests at
all. **The ring-transport refactor has since removed that file from the module
tree**: `ed487e11 refactor(host): make ring transport mandatory` deleted
`frame_read.rs`, so every line reference in this group resolves only at the
commit the lens pass read and the records carry `Status:
superseded-by-refactor` rather than `active`. They are retained because the three
obligations did not disappear with the file. **Each must be re-derived against
the new read path** before it is treated as closed, and the two that were findings
rather than guarantees, the budget-free oversize drain and the unreachable
client-side refusal drain, are the two most likely to have moved rather than
gone.

### cancellation-preempts-every-bounded-frame-read

Type: safety
Reachability: default-production
Status: superseded-by-refactor
Exercised: not yet — no in-crate test cancels a token while any `frame_read`
helper is running, so the precedence branch has no oracle anywhere. Integration
shutdown tests execute it incidentally and assert nothing about it.
Guarantee: When a bounded frame read's cancellation token is cancelled, the
read returns `ReadStop::Cancelled` and performs no further read, even when
input bytes are simultaneously available.
Check: `always` — with the token cancelled and a full read's worth of bytes
already buffered on the reader, each of `read_exact`, `read_body`, and `drain`
returns `Err(ReadStop::Cancelled)`, and the reader's unconsumed byte count is
unchanged. `always`, not `always-or-unreached`: cancellation fires on every
production shutdown and every generation retirement, so this is evaluated on
ordinary paths rather than on an optional one. Assert the byte count, not just
the return value, because a `Cancelled` return after a completed read is the
defect and the return value alone cannot see it.
Fault/timing angle: the window is exactly one `select!` poll in which both the
token and the read are ready. Under `biased` that is deterministic; without it,
tokio picks a random ready branch, so the defect appears about half the time
per iteration and a multi-iteration `read_exact` almost surely completes and
returns `Ok(())` on a cancelled generation.
Required faults and enabling state: a reader with bytes buffered and ready,
plus a token cancelled before the poll. Both are constructible with
`tokio::io::duplex`: write the bytes, cancel the token, then call the helper.
No scheduler control is needed because the ordering is established before the
call.
Confidence: high —
[evidence](evidence/cancellation-preempts-every-bounded-frame-read.md).
Verified the `biased;` keyword and branch order at `frame_read.rs:47-49`,
`:81-83`, `:111-113`; the production cancellation sources at
`connection.rs:305`, `runtime.rs:1160`, and `runtime.rs:431`; and by exhaustive
`awk` over both test modules that no in-crate test cancels a read token.
Existing check: none. The 24 tests in `tcp_frame_channel.rs:512-1155` and the
two `read_active_frame` tests at `client.rs:3650` and `:3683` all construct a
fresh `CancellationToken::new()` and never cancel it.
Impact: a retiring generation keeps consuming frames. Each completed read
admits a frame and charges the ingress budget on a generation the host has
already decided to stop, which contradicts
[a-retired-generation-emits-nothing-and-mutates-nothing](#a-retired-generation-emits-nothing-and-mutates-nothing)
on the read side, and delays shutdown by up to one frame deadline per admitted
frame.
Open questions: None.

### a-body-read-consumes-exactly-the-declared-frame-boundary

Type: safety
Reachability: default-production
Status: superseded-by-refactor
Exercised: not yet — no test passes a non-empty buffer, and no test asserts the
consumed-byte count rather than the buffer contents.
Guarantee: A successful `read_body(reader, buf, len, ..)` consumes exactly
`len` bytes from the reader: never more, so a pipelined next header cannot be
read as this frame's body, and never fewer, so the stream stays aligned.
Check: `always-or-unreached` — for an empty `buf`, assert both that
`buf.len() == len` and that exactly `len` bytes were consumed from the reader,
with a following pipelined header still intact and readable. For a non-empty
`buf` holding `k` bytes, either the call consumes `len` bytes or it must not
return `Ok`. `always-or-unreached` because both current call sites allocate a
fresh empty vector immediately before calling (`tcp_frame_channel.rs:217`,
`client.rs:2003`), so the non-empty case is unreached today while remaining
callable through the host's forwarding wrapper at
`tcp_frame_channel.rs:264-277`.
Fault/timing angle: none for the over-read direction; the `take` at
`frame_read.rs:79` makes it physically impossible. The under-read direction has
no timing window either. It is a pure precondition: the loop at
`frame_read.rs:80` tests `buf.len() < len`, an absolute buffer length, while
the cap at `:79` counts bytes read, so any non-empty incoming buffer makes the
two disagree and the call under-reads by exactly `k`, returning `Ok(())`.
Required faults and enabling state: no fault. Call `read_body` directly with a
buffer pre-filled with `k` bytes, `0 < k < len`, and a reader holding `len`
body bytes followed by a valid header. The observable is that the header no
longer parses on the next read.
Confidence: high —
[evidence](evidence/a-body-read-consumes-exactly-the-declared-frame-boundary.md).
The cap and the loop condition were read at `frame_read.rs:79-80`; the
freshness of both callers' buffers was verified at `tcp_frame_channel.rs:217`
and `client.rs:2003`; the `take` semantics were confirmed against tokio 1.53.1.
Existing check: partial and indirect. `tcp_frame_channel.rs:836-896`,
`fragmented_and_coalesced_frames_preserve_alignment`, proves alignment survives
fragmentation and coalescing for empty buffers, which covers the over-read
direction end to end. Nothing covers the non-empty case. Status unaudited.
Impact: silent stream desynchronization with an `Ok` return. `k` body bytes are
parsed as the next header, so a peer's body content chooses the host's next
header, and the frame handed up contains `k` bytes that are not its body.
Open questions:
- Should `read_body` take `&mut Vec<u8>` at all? The client wrapper already
  owns its allocation (`client.rs:2003`), so only the host's forwarding wrapper
  needs the out-parameter. Either clearing `buf` on entry, asserting
  `buf.is_empty()`, or returning an owned `Vec` would make the disagreement
  unrepresentable rather than merely unreached. (needs human input)

### a-zero-length-read-ends-the-read-instead-of-looping

Type: safety
Reachability: default-production
Status: superseded-by-refactor
Exercised: partial — `read_body`'s EOF is proven by an exact-string assertion,
`read_exact`'s only by a wildcard that cannot discriminate the defect, and
`drain`'s only through the `RejectedDrainFailed` mapping.
Guarantee: A read returning zero bytes with the target unfilled terminates the
helper as `ReadStop::Eof` rather than continuing the loop.
Check: `always` — for each of the three helpers, close the peer mid-target and
assert the helper returns `Err(ReadStop::Eof)` promptly, well inside the
deadline. Assert the deadline is *not* consumed, because that is what separates
this property from a looping implementation: both return an error, and only the
timing and the error class distinguish them. `always`, since every orderly
mid-frame peer close reaches it.
Fault/timing angle: the whole property is about timing. A looping
implementation does not hang: a closed stream returns `Ok(0)` immediately and
forever, so it would spin hot until `timeout_at` fired and then report
`DeadlineExpired`, mapped by the host to `Corrupt("frame deadline expired")`
instead of `Corrupt("EOF inside frame")` (`tcp_frame_channel.rs:284-287`). So a
correct diagnosis costs a full frame deadline of spun CPU when it is wrong.
Required faults and enabling state: a mid-target peer close, three times: after
one header byte (`read_exact`), after a partial declared body (`read_body`),
and after a partial drained body (`drain`). All three are one `drop(client)` on
a `tokio::io::duplex` pair.
Confidence: high —
[evidence](evidence/a-zero-length-read-ends-the-read-instead-of-looping.md).
Read the three `if read == 0` sites at `frame_read.rs:55-57`, `:89-91`,
`:119-121`, and verified the non-empty-target guards at `:46`, `:109-110`. The
`read_body` case needed dependency evidence, since `read_buf` has two other
`Ok(0)` causes: both were ruled out against
`tokio-1.53.1/src/io/util/read_buf.rs:46-48` and
`bytes-1.12.1/src/buf/buf_mut.rs:1599-1636` at the versions pinned in
`Cargo.lock`.
Existing check: three tests, of unequal strength.
`tcp_frame_channel.rs:599-618` asserts the exact string
`Corrupt("EOF inside frame")` and does discriminate a looping `read_body`.
`:580-597` asserts only `Corrupt(_)`, which a looping `read_exact` would also
satisfy. `:810-834` covers `drain` through `RejectedDrainFailed`, which
collapses every stop class into one variant (`connection.rs:401-410`) and so
cannot discriminate either. Status unaudited.
Impact: a hot spin for the whole frame deadline on every orderly mid-frame
close, plus a close reason that blames a slow peer for a clean disconnect.
Open questions:
- `read_body`'s EOF detection depends on `bytes`' `BufMut for Vec<u8>` growing
  on demand. Should that dependency be pinned by a comment or an assertion at
  `frame_read.rs:89`? A buffer type with fixed remaining capacity would
  silently reclassify "buffer full" as "peer closed". (needs human input)

### no-framed-read-resumes-after-a-read-stop

Type: safety
Reachability: default-production
Status: superseded-by-refactor
Exercised: partial — the host's obligation is structurally enforced by an
exhaustive match, which is stronger than a test; the client's is enforced by
code inspection only, and no test drives a stop and then attempts a second
read.
Guarantee: After any `ReadStop`, no caller performs another framed read on the
same reader. All three helpers abandon partially consumed frames and keep no
offset, so a resumed read would begin mid-frame.
Check: `always` — for every `Err` exit of the host's `recv` and the client's
`read_active_frame`, the enclosing loop terminates without calling the reader
again. The compile-time form is stronger and already present on the host side:
the `ReadClose` match at `connection.rs:398-415` is exhaustive with every arm
returning, so a new variant cannot be handled by falling through. `always`
rather than `unreachable`, because the forbidden thing is a *state* (a second
read after a stop) reached from many call sites, not one code location.
Fault/timing angle: the sharpest case is the transport layer rather than a
caller. `recv` takes `pending_drain` at `tcp_frame_channel.rs:97` before
running the drain, so a failed drain both leaves the stream misaligned and
clears the state that would realign it. A retry of `recv` after
`Err(RejectedDrainFailed)` would read body bytes as a header with no pending
drain left. `connection.rs:401-410` is the only thing preventing that.
Required faults and enabling state: any stop class, then an attempted second
read. Cheapest construction: a truncated declared body for EOF, a paused clock
for the deadline, a cancelled token for cancellation.
Confidence: high —
[evidence](evidence/no-framed-read-resumes-after-a-read-stop.md). Verified that
no helper retains an offset (`frame_read.rs:45`, `:79`, `:108`), and that both
callers stop: the host's four exhaustive `Err` arms at `connection.rs:400`,
`:401-410`, `:411-414`, and the client's `break` at `client.rs:1897-1900` plus
its clean-EOF `break` at `:1894-1897`.
Existing check: `connection.rs:398-415` is a production structural guard rather
than a test, and covers the host completely. The client has neither a test nor
a guard, only `reader_loop`'s shape. Status unaudited.
Impact: a resumed read parses body bytes as a header. Every downstream identity
decision — correlation, channel, epoch, frame type — is then made from
attacker-chosen bytes on a stream the host believes is aligned.
Open questions:
- The obligation is not written down. `frame_read.rs:5-8` assigns short-read
  *policy* to the callers but never states that no resume is permitted. Should
  the module doc state it, given that the type system cannot? (needs human
  input)

### oversize-control-drain-work-is-bounded-without-ingress-budget

Type: safety
Reachability: default-production
Status: superseded-by-refactor
Exercised: partial — the zero-budget property is asserted, its cost bound is
not. `tcp_frame_channel.rs:803-807` proves an oversize declaration holds no
ingress budget; nothing bounds how much read-and-discard work one peer can
provoke.
Guarantee: An early-rejected oversize control frame is drained without charging
the ingress byte budget, and the work it costs is bounded by the rejected
frame's own absolute frame deadline, by the connection permit semaphore, and by
nothing else.
Check: `always` — across a sustained reject-then-drain cycle, the ingress
budget's available permits return to their starting value after every cycle
(the intended property, already asserted once), and each drain completes or
fails within the deadline armed at the rejected frame's first header byte.
State the bound in the units the code bounds: the absolute deadline from
`tcp_frame_channel.rs:169`, carried into `PendingDrain` at `:126`, default 30 s
(`config.rs:224`); and `max_connections` concurrent loops, default 64
(`config.rs:129`, `runtime.rs:890`). Do not assert a byte-rate ceiling, because
there is none.
Fault/timing angle: the deadline is armed at the *first header byte*, not at
the drain's start, and is spent by the header read and by the engine's
rejection emission before the drain begins (`connection.rs:433-462` spawns the
emission between the two `recv` calls). So a host slow to emit shortens its own
drain window and converts the drain into `RejectedDrainFailed`, which closes
the generation. That makes the loop self-limiting under host slowness but not
under host health.
Required faults and enabling state: a peer sending channel-0 `Request` headers
with strictly increasing correlations (`connection.rs:426-429`) declaring
`len > MAX_CONTROL_BODY_LEN`, each followed by the declared bytes, repeated. To
observe the aggregate, run `max_connections` of them.
Confidence: high on the mechanism, medium on whether the cost is a defect —
[evidence](evidence/oversize-control-drain-work-is-bounded-without-ingress-budget.md).
Verified that the oversize branch at `tcp_frame_channel.rs:198-202` precedes
the budget charge at `:204-215`; that the ceiling is `MAX_BODY_LEN` and not the
control cap, because `validate_inbound_header` (`frame_channel.rs:58-61`) runs
first at `:196` (`wire.rs:35`, `:371`, `:374`); and that the only permits in
the path are `connection_permits` (`connection.rs:165-169`) and `busy_rejects`
(`:443-447`, cap 32 at `:53`), the latter bounding the emissions rather than
the drain, exactly as its comment at `:437-442` says.
Existing check: `tcp_frame_channel.rs:772-808` covers one reject-then-drain
cycle and asserts the zero-budget property at `:803-807` with a deliberately
tiny budget. `:730-770` covers realignment. Neither repeats the cycle, and no
check bounds the cost. Status unaudited.
Impact: a peer can force up to 64 MiB of read-and-discard per frame per
connection, and up to `max_connections` of those concurrently, while holding no
resident-byte budget. Those bytes are also unobserved: `drain` never touches
the `CopyCounter`, whose only producers are `frame_channel.rs:376` and
`shm_provider.rs:611`, so no counter in the crate sees them.
Open questions:
- Is the unbudgeted cost acceptable, or should the drain hold a nominal charge
  or a dedicated permit? The zero-budget property is deliberate and correct as
  a *resident-memory* property (never buffer the body); the open question is
  whether the same reasoning should extend to the bandwidth and CPU the discard
  costs. (needs human input)
- Should the reject-then-drain cycle be counted? The gap here is a missing
  bound, and today no signal would show the loop running at all. (needs human
  input)

### the-client-body-budget-refusal-drain-is-never-entered

Type: reachability
Reachability: default-production
Status: superseded-by-refactor
Exercised: not yet — nothing observes the branch, so it could start firing
without notice.
Guarantee: The client's inbound read reservation is exclusively the reader's
and sized to the framing maximum, so the budget-refusal branch at
`client.rs:1970-1973` never executes.
Check: `unreachable` — the `else` arm at `client.rs:1970` must not be entered.
`unreachable` and not `always(!X)` because this is one specific code location
with a natural detection point, exactly the case the semantics table reserves
`unreachable` for. Entering it means the reservation is no longer
reader-exclusive: either a `ByteCharge` outlived its `dispatch` call, or the
cap and `MAX_BODY_LEN` diverged. A `debug_assert!(false)` or a counter on that
arm is the whole check.
Fault/timing angle: none today. The reservation is released synchronously
inside `dispatch` before the next read (`client.rs:1393` called from `:1903`),
so no interleaving can leave `used > 0` at a read. The branch becomes reachable
the moment a `dispatch` arm retains a read charge across an await, or a stream
item borrows the read charge instead of `retained_budget` (`:1523`).
Required faults and enabling state: to *prove* unreachability, none: it follows
from the four verified steps in the evidence. To detect a regression,
instrument the arm and run the ordinary inbound suite.
Confidence: high —
[evidence](evidence/the-client-body-budget-refusal-drain-is-never-entered.md).
Verified all four steps the claim rests on: the cap equals the framing maximum
(`client.rs:88`, `:403`); `validate_inbound` rejects a larger `len` first
(`:2040`, called at `:1957`); `ByteCounter::charge` refuses only when
`used > 0` or on overflow (`:1770-1781`); and `used` is zero at every read
because every `dispatch` arm releases the charge (`:1433`, `:1530`, and
ownership drop at `:1431`, `:1479`, and function exit) while retained stream
bytes go to `retained_budget` (`:1523`, documented at `:956-961`).
Existing check: none. The comment at `client.rs:1965-1969` states the invariant
in prose and correctly labels the branch as a structural guard, but nothing
enforces or observes it.
Impact: low today and that is the finding. Two dead claims hang off it:
`drain_until`'s doc at `client.rs:2010-2011` promises a realignment that no
code consumes, and even if the branch fired, `read_active_frame` returns
`Err(())` immediately after, which retires the connection at `:1897-1899` and
discards the realignment. If the branch ever does fire it signals a real
regression in the reader-exclusive reservation, and nothing would report it.
Open questions:
- Should the branch keep its drain, or return the error directly? The drain's
  only stated purpose is a realignment the sole caller discards. Removing it
  would delete the client's only `frame_read::drain` call site and make the
  guard a bare error return. (needs human input)

## Group K: configured liveness, manifest evolution, and platform

Six records closing the remaining three queued gaps. The first two are normal
configured liveness, where the loop's bound is three code-stated quantities rather
than an unbounded "eventually", and where slow egress alone must not retire a
probed generation; both are `explicit-config-only`, because `LivenessPolicy`
defaults to `None` (`config.rs:296`) and nothing in this crate opts in. The next
two are canonical manifest evolution, the golden vector that pins the bytes and
the digest, and the declaration-order change that must not orphan a retained
generation. The last two are the platform pair: an atomic directory exchange that
macOS compiles and never runs, and a portable rename fallback that cannot deliver
the guarantee its caller documents. The lens pass proposed folding the first two
into Group B and the last four into Group F; they are kept together here because
the index and the deferred-candidate list already treat the gap-closure set as
three groups, and splitting them would renumber records that other artifacts
reference.

### a-timely-pong-sustains-the-generation-within-a-bounded-round

Type: liveness
Reachability: explicit-config-only
Status: active
Exercised: partial — `tests/client.rs:97-145` keeps a generation alive across
roughly seven ping intervals with a real answering client, but asserts only
that an unrelated unary request later succeeds. It observes no Ping, no Pong,
and no retirement, so it passes unchanged if the probe never runs at all. No
test covers the retirement direction.
Guarantee: For a configured policy, a peer that answers each Ping within
`pong_deadline` of that Ping's write completion keeps its generation
uncancelled indefinitely; and when `invalidate_on_missed` is set, a peer that
does not answer has its generation cancelled within one `pong_deadline` of
write completion.
Check: `always` — under paused virtual time, for a policy with a chosen
`ping_interval` and `pong_deadline`: (a) answer every Ping strictly inside
`pong_deadline` measured from the write-completion instant recorded at
`connection.rs:1443`, advance the clock by `k * ping_interval + pong_deadline`
for a fixed small `k`, and assert `gen.token` is not cancelled and exactly `k`
Pings were written; (b) with `invalidate_on_missed: true`, answer nothing,
advance to `write_completion + pong_deadline`, and assert `gen.token` is
cancelled; and assert it is *not* cancelled at `write_completion +
pong_deadline
- 1ns`. `always` because the two directions are the dual outcomes of one
  predicate, `expired` at `connection.rs:1370-1375`, and both must hold at
  every evaluation of the loop.
Fault/timing angle: the bound is stated in the units the code bounds, so this
is a finite check rather than an unbounded "eventually". The wake is the
minimum of the next tick and the earliest `probe.sent + pong_deadline`
(`connection.rs:1355-1364`); expiry is `>= pong_deadline` from `probe.sent`
(`:1370-1373`); the tick re-arms at `now + ping_interval` (`:1399`).
`config.rs:370-382` rejects a zero value for either, so both bounds are
strictly positive in any accepted configuration. The subtle part is which
instant `probe.sent` holds: the insert at `:1403-1411` records the enqueue
instant with `written_at: None`, and the write-completion hook at `:1421-1447`
overwrites it with `completed_at`. Probes with `written_at: None` are excluded
from both the deadline wake (`:1358`) and the expiry scan (`:1372`), so
queueing delay neither expires a probe nor arms one. Both halves need paused
time; wall-clock sleeps cannot distinguish the boundary from scheduler noise.
Required faults and enabling state: a configured `LivenessPolicy`, which no
shipped configuration supplies. For (a) a cooperative peer, which the in-crate
duplex harness at `connection.rs:1480` onward already provides. For (b) a peer
that reads but never sends a Pong, plus `invalidate_on_missed: true`. Paused
tokio time for both. No adversary and no concurrency campaign.
Confidence: high —
[evidence](evidence/a-timely-pong-sustains-the-generation-within-a-bounded-round.md).
Every bound was read at HEAD and the two `sent` anchors were traced through
both writers of the field.
Existing check: partial. `tests/client.rs:97-145` covers direction (a) with an
indirect oracle, and is the only place in the crate where a full client answers
a host Ping. `tests/lifecycle.rs:468` covers an *unmatched* Pong, not a missed
one. Nothing covers direction (b).
Impact: the probe exists to detect a peer that has stopped reading. If (a)
fails, healthy long-running work is killed, which is the exact outcome
`config.rs:236-238` cites as the reason `invalidate_on_missed` defaults to
`false`. If (b) fails, a dead peer holds a generation, its route registrations,
and its egress budget for the life of the process.
Open questions:
- Should the retirement bound be stated from write completion or from Ping
  issuance? The code anchors on completion (`:1443`), so a Ping stuck in the
  queue extends the wall-clock time to retirement without bound while keeping
  the `pong_deadline` bound intact. That is the intended anchor per `:528-534`,
  but it means no bound exists on *total* time to detect a dead peer.

### slow-egress-alone-does-not-retire-a-probed-generation

Type: reachability
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test fills the writer queue while liveness is
configured.
Guarantee: Application egress backpressure, on its own, never retires a
generation whose peer is answering Pings, and in particular never retires one
when `invalidate_on_missed` is `false`.
Check: `sometimes` — a constant marker `probe_queued_behind_saturated_egress`
fires when all of these independent, legal preconditions hold at one instant: a
`LivenessPolicy` is configured; `invalidate_on_missed` is `false`; the writer
queue holds `writer_queue_frames` admitted frames; and a Ping tick is due. A
second constant marker `pong_parked_pending_write_completion` fires when a
matching Pong is observed while `probe.written_at.is_none()`, which is the park
branch at `connection.rs:535`. `sometimes` rather than `reachable` because a
campaign can execute those lines while never producing the operational state:
line coverage of `:535` proves the branch compiled and ran, whereas the
property needs a full queue coinciding with a due tick, which is situation
coverage. Both markers assert only legal preconditions, so they still fire
against a correct implementation; neither asserts a retirement, an expiry, or
any violation.
Fault/timing angle: the window exists because the host writer has no control
lane. `frame_channel.rs:761` holds a single
`mpsc::Sender<QueuedOutboundFrame>`, created at `:862` with capacity
`queue_frames`, default 64 (`config.rs:141`, passed at `connection.rs:181`).
There is no reserved control slot, unlike the client, which reserves one
(`client.rs:954`). Two distinct consequences follow, and only the first is
handled. First, a Ping queued behind application frames is deadline-anchored at
completion (`connection.rs:1443`) and its Pong is parked rather than judged
(`:528-535`), so queueing delay is not charged to the peer. That is correct and
deliberate. Second, and unhandled: the Ping's *admission* is bounded.
`gen.writer.send(...)` at `:1449` reaches `FrameSender::send`
(`frame_channel.rs:779-781`), which passes `admission_deadline()`, that is
`now + admission_timeout` (`:783-785`), and `connection.rs:178-186` supplies
`shared.timing.frame_deadline` there, default 30 seconds (`config.rs:224`). The
timeout arm at `frame_channel.rs:819-823` calls `self.retired.cancel()` and
`self.generation.cancel()`. So a Ping that cannot be admitted within
`frame_deadline` retires the generation from inside the sender, before
`liveness_loop` observes `sent.is_err()` at `:1457`. This bypasses
`invalidate_on_missed` entirely: the missed-Pong retirement at `:1376` is gated
on that flag and the admission retirement is not.
Required faults and enabling state: a configured `LivenessPolicy` with
`invalidate_on_missed: false`; a handler producing frames faster than the peer
drains them so all 64 slots stay occupied; and a peer that keeps reading fast
enough that no single dequeued write exceeds `frame_deadline`, since a peer
that stops reading is retired by the write deadline on its own, which
`config.rs:204-206` documents as intended. Paused time makes the 30 second
window cheap. The second marker needs only a Ping enqueued behind at least one
unwritten frame plus a prompt Pong.
Confidence: high —
[evidence](evidence/slow-egress-alone-does-not-retire-a-probed-generation.md).
The admission path was traced from the Ping send through the cancel calls, and
the absence of a host-side control lane was confirmed by reading the whole
`FrameSender` and its constructor.
Existing check: none. `tests/client.rs:97-145` is named
`stream_order_and_slow_consumer_do_not_block_ping_or_unary`, but its
`stream_then_hang` handler (`tests/support/mod.rs:492-501`) streams two items
that the client consumes before the observed window, so the queue is empty
throughout and there is no slow consumer. The hang is in the handler.
Impact: the documented safety valve does not hold. `config.rs:236-238` states
that `invalidate_on_missed` stays `false` because enabling it "would kill
healthy long-running awaits (protocol §9.3)". An embedder that configures a
policy with the flag off, believing invalidation is disabled, still loses
generations to egress backpressure. The failure looks like a transport reset to
both sides, and per `authentication-and-capacity-rejections-are-observable`
there is no channel to report it.
Open questions:
- Is retiring on Ping admission timeout intended? The admission timeout is a
  general frame-channel policy and the Ping is an ordinary caller of it, so
  this reads as an unnoticed interaction rather than a decision. If it is
  intended, `invalidate_on_missed`'s doc comment overstates what the flag
  disables. (needs human input)
- Should the host reserve a control slot as the client does? That would remove
  the interaction rather than document it, but it changes the queue accounting
  the ingress budget depends on.

### manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector

Type: safety
Reachability: default-production
Status: active
Exercised: partial — one byte-exact golden vector exists
(`generation.rs:1395-1412`) but its fixture omits the optional field and
carries an empty `files`, so it pins neither the optional field's position nor
`ManifestFile`'s field order, and it asserts no digest.
Guarantee: The canonical manifest encoding is fixed by a golden vector that
covers every field in the schema, so no change to declaration order can alter a
generation's bytes or its digest without a test failing.
Check: `always` — a golden test asserts a hardcoded byte string and a hardcoded
lowercase-hex SHA-256 for a fully populated `GenerationManifest`: all four
leading scalars, `source_payload_manifest_sha256` present as `Some`, and
`files` holding at least two entries so sortedness is also pinned. Assert both
`manifest.canonical_bytes() == GOLDEN_BYTES` and
`manifest.digest() == GOLDEN_DIGEST`, and assert the fixture round-trips by
decoding `GOLDEN_BYTES` and re-encoding. `always` because the encoding is
evaluated on every stage and every validate; there is no configuration in which
it is unreached.
Fault/timing angle: none. This is a static encoding contract. The mechanism is
that `canonical_bytes` is `serde_json::to_vec(self)` (`generation.rs:172-174`),
so the byte order is literally the declaration order at `:153-168` for the
outer struct and `:141-144` for each file entry, and `digest` is the SHA-256 of
exactly those bytes (`:176-178`). The optional field's
`skip_serializing_if = "Option::is_none"` at `:166` is what makes the existing
vector blind to its position: with the field absent, moving it changes nothing
about the fixture's bytes.
Required faults and enabling state: none. The check is a pure unit test with no
store, no filesystem, and no fault injection. It is the cheapest record in this
pass.
Confidence: high —
[evidence](evidence/manifest-canonical-bytes-and-digest-are-pinned-by-a-full-golden-vector.md).
Both structs, both encoding functions, and the existing fixture were read at
HEAD, and the three blind spots were each confirmed by reasoning from the
fixture's literal contents.
Existing check: `generation.rs:1395-1412`
`a_generation_staged_before_the_source_digest_field_still_decodes` asserts
`decoded.canonical_bytes() == predecessor` against the literal at `:1401`. It
is the only byte-exact manifest vector in the crate and it does pin the
relative order of the four leading scalars and `files`, and it does catch the
addition of a required field, because `deny_unknown_fields` plus a missing
field fails the decode. Status unaudited.
Impact: declaration order is a wire-compatibility contract that is currently
enforced by a fixture that cannot see two thirds of it. A maintainer who
inserts `source_payload_manifest_sha256` beside the other hashes for
readability, or who alphabetizes `ManifestFile`, changes the digest of every
generation with files and sees a green suite.
Open questions: None.

### a-declaration-order-change-cannot-orphan-a-retained-generation

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test validates a manifest written under one declaration
order against a binary using another.
Guarantee: A retained generation staged by an earlier release keeps validating,
and keeps its directory name, under any later release of the same schema
number.
Check: `always` — for a manifest fixture whose bytes were produced under the
previous declaration order, `store.validate(old_digest)` succeeds under the
current binary. Equivalently, and cheaper: for every field of
`GenerationManifest` and `ManifestFile`, a permutation of the declaration order
that leaves the existing golden test green must be detectable by some check.
`always` because validation runs on the default start path and the schema
number does not change when a field moves, so there is no version in which the
obligation lapses.
Fault/timing angle: none, but the failure shape needed correcting. The break is
**fail-closed, not silent**. `validate_in_dir` enforces the binding twice
(`generation.rs:636-648`): first `hex(sha256(bytes)) != digest`, then
`manifest.canonical_bytes() != bytes`. Under a reordered struct the on-disk
bytes still hash to the directory name, so the first check passes, and the
re-encode of the decoded manifest differs, so the second fails with
`invalid("manifest is not canonically encoded")`. The comment at `:640-647`
explains why that second check exists: without it one logical manifest would
have two identities. So reordering produces a refusal of intact payloads, which
is precisely the outcome the `source_payload_manifest_sha256` doc comment at
`:157-165` was written to avoid, reached by a different route. The second,
independent consequence is that staging the same logical content under the
reordered struct computes a different digest, so it lands in a new directory
and content-addressed deduplication stops deduplicating without any error at
all.
Required faults and enabling state: none at runtime. Constructing the check
needs a fixture manifest whose bytes encode an older field order, which is a
string literal, plus a staged directory whose files match it. No fault
injection.
Confidence: high —
[evidence](evidence/a-declaration-order-change-cannot-orphan-a-retained-generation.md).
Both equality checks were read at HEAD, and the fail-closed conclusion was
derived from them rather than assumed; the prompt's "silently change every
retained generation's digest" is corrected in the evidence file.
Existing check: partial and narrow. The predecessor fixture at
`generation.rs:1395-1412` is the only cross-version manifest test, and it
covers one specific evolution, a field added at the end and omitted when
absent. Nothing covers a field that moves.
Impact: the first start after an upgrade reports `native_payload_invalid` for
every retained generation carrying the moved field, refusing payloads that are
byte-for-byte intact. That is the forward-compatibility break the `Option` on
`source_payload_manifest_sha256` was introduced to prevent.
Open questions:
- Should the canonical encoding be decoupled from declaration order, for
  example by an explicit field-order list or a canonical-JSON serializer, so
  the contract is stated once rather than implied by the struct? The current
  design makes an ordinary refactor a compatibility break. (needs human input)

### the-atomic-directory-exchange-is-atomic-on-every-supported-platform

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the Linux arm has one test through `promote_temp`
(`generation.rs:1689`), and the macOS arm has never executed under observation.
Guarantee: Wherever the digest-target exchange runs, the two names are swapped
atomically inside one directory, or an error is returned and neither name is
left unoccupied; on a platform without the primitive it fails closed.
Check: `always-or-unreached` — for each supported platform, drive
`promote_temp` into the exchange branch and assert that after the call the
digest name holds the validated candidate and the temp name holds the displaced
corrupt orphan, with no observable state in which either name is absent. Also
assert the non-Linux non-macOS stub returns an error rather than succeeding.
`always-or-unreached` because the branch is optional: it is entered only when
the digest target is occupied by a corrupt unprotected generation
(`generation.rs:886-905`), so a run that never meets that condition owes
nothing and the check must not fail.
Fault/timing angle: the risk is platform divergence behind one expression.
`generation.rs:1191-1198` gives Linux and macOS a shared arm calling
`rustix::fs::renameat_with(.., RenameFlags::EXCHANGE)`, and its own doc comment
at `:1191-1193` records that this is `renameat2(RENAME_EXCHANGE)` on Linux and
`renameatx_np(RENAME_SWAP)` on macOS. Those are two different kernel interfaces
with independent semantics, error sets, and filesystem support, reached through
one line of Rust. The call site at `:905` sits between an exchange and a
revalidate-then-delete (`:907-910`), so a non-atomic or partially-applied
exchange deletes the wrong directory. `promote_temp`'s contract at `:865-876`
depends on the exchange being all-or-nothing.
Required faults and enabling state: a corrupt, unprotected generation already
occupying the digest target, plus a restage of the same digest. The existing
test `same_digest_corrupt_target_is_repaired_only_by_validated_exchange`
(`generation.rs:1689`) already builds that fixture, so the fault is available;
the missing element is executing it on macOS. On the stub platforms the check
is a compile-and-call assertion.
Confidence: high —
[evidence](evidence/the-atomic-directory-exchange-is-atomic-on-every-supported-platform.md).
Both cfg arms, the call site, and the whole macOS CI job were read at HEAD; the
claim that no macOS lifecycle or generation test executes is derived from the
four mc-host steps in that job rather than asserted.
Existing check: partial, Linux only. `generation.rs:1689`
`same_digest_corrupt_target_is_repaired_only_by_validated_exchange` drives the
branch. CI's macOS job (`.github/workflows/ci.yml:126-184`) runs only
`cargo build -p mc-host` (`:156`), `--test shm_soak` (`:178`), one filtered
`--lib shm_provider` test (`:179-181`), and `--doc` (`:182-183`). No
`generation` or `lifecycle` test body runs on macOS; the step comment at
`:171-174` says the job proves omission, not parity. Status unaudited.
Impact: the exchange is the store's only repair primitive for a corrupt
occupant, and it is immediately followed by a deletion. If macOS `RENAME_SWAP`
behaves differently on APFS than `RENAME_EXCHANGE` on ext4, the failure mode is
deleting a retained generation, on a platform whose lifecycle code the suite
never runs.
Open questions:
- Is macOS a supported deployment target for the lifecycle store, or only a
  development platform? The cfg arm and the CI build say it is supported enough
  to compile; the test selection says it is not exercised. That decision sets
  whether this record is a real gap or a documentation fix. (needs human input)

### an-occupied-rename-target-is-never-replaced-on-the-portable-path

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the branch is unreachable on Linux without a filesystem
that rejects `renameat2` flags, and it is the only path on macOS, where no test
in this scope runs.
Guarantee: `rename_no_replace` never replaces an occupied target, on any
platform and for any occupant, including an empty directory.
Check: `always` — plant a directory at `to`, call `rename_no_replace`, and
assert it returns `Ok(false)` and leaves both names as they were. Run the
assertion for an empty occupant and a nonempty occupant, on both the flagged
Linux path and the portable path, forcing the portable path either by a
filesystem that rejects `renameat2` flags or by extracting the fallback so it
can be called directly. `always` because the caller's contract at
`generation.rs:868-871` is unconditional, so an occupied target that gets
replaced is a violation rather than a tolerated case.
Fault/timing angle: this is a check-then-act window that is dead on one
platform and load-bearing on another. `generation.rs:1216-1242`: the Linux
block at `:1217-1230` returns on `Ok`, `EXIST`, `NOTEMPTY`, and `NOSPC`,
falling through only on `INVAL`, `NOSYS`, or `OPNOTSUPP`, so on a current
kernel with ext4, tmpfs, or overlayfs the fallback never runs. On macOS that
block is absent by cfg, so `statat` at `:1231-1235` followed by `renameat` at
`:1236-1241` is the only path. POSIX `rename` replaces an existing *empty*
directory, which `promote_temp`'s comment at `:868-871` calls out by name as
the thing that must not happen, so the flagged path and the fallback do not
implement the same guarantee. The fallback's justification at `:1211-1215` is a
prose claim that `transaction.lock` (`lifecycle.rs:44`, `:495-496`) excludes
concurrent creation. That is a claim about actors inside the trust model only,
and the same file defends against out-of-model directory replacement elsewhere:
the walk comment at `:669-678` describes exactly that attack, and the catalog's
`validation-and-enumeration-address-one-directory-object` records two shipped
defects from the class.
Required faults and enabling state: a directory appearing at the target between
the `statat` and the `renameat`. Deterministically: a failpoint between the two
calls, or an extracted fallback called with the target pre-planted. Reaching
the fallback on Linux at all needs a filesystem that rejects `renameat2` flags;
running it as the default needs macOS.
Confidence: high on the mechanism, medium on severity, since the transaction
lock does exclude the in-model actors and no out-of-model writer is
demonstrated —
[evidence](evidence/an-occupied-rename-target-is-never-replaced-on-the-portable-path.md).
Both branches, the caller's contract, and the lock references were read at
HEAD.
Existing check: none. No test drives the portable fallback on any platform, and
no test plants an empty directory at a digest target.
Impact: the guarantee `promote_temp` documents as mandatory, that a protected
occupant corrupted into an empty directory is never silently destroyed, is
enforced by the kernel on Linux and by a prose argument on macOS. A defect here
destroys a retained generation, which is the outcome the protection check
exists to prevent.
Open questions:
- Does anything outside the trust model have write access to the generations
  directory in a real deployment? The lock argument is sound if and only if the
  answer is no, and the store's validation path assumes the answer is yes.
  (needs human input)
- Should the fallback be removed rather than justified? If macOS is supported,
  it needs a real no-replace primitive; if it is not, the fallback is dead code
  on every supported platform and the stub at `:1200-1205` is the honest shape.
  (needs human input)
---

## Deferred candidates

The lens passes produced roughly 90 candidates; the 55 above are the strongest.
Groups I, J, and K closed the five gaps the portfolio evaluation queued: the
mandatory setup-state transitions, the shared frame-read mechanics and the
budget-free oversize drain, normal configured liveness, canonical manifest
evolution, and the Darwin store behaviour. The candidates still deferred to a
follow-up pass, with their lens evidence retained:

- Grant records: activation replay across generations, the grant binding compared
  against itself so two rejection branches are dead.
- Trust-boundary records: the eager capacity reservation before body arrival, the
  single-slot authoritative terminal, the unvalidated consumer launch nonce,
  channel epoch headroom.
- Store records: the untested source verification branches, the umask hazard
  class.
- Platform and drift records: the directory-enumeration backend divergence, the
  relative data-root CWD anchor, the two-fence coupling at creation, the
  probe's undocumented blocking budget, the exported-type stability question.
