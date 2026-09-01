# Lens: gap G1, mandatory setup-state transitions

Targeted pass to close gap G1 from `portfolio-evaluation.md:96`. Working
material, not a deliverable.

System `/local/home/ahrav/scratch/magic-context` at `1c193ae0` (merge of
`d90e7811`). Every line reference below was read at that commit.

Scope: the setup state machine in `crates/mc-host/src/connection.rs`, its
normative source `docs/mc-host-wire-protocol.md` section 7.7 (lines 558-672), and
the two supporting files `transport_negotiation.rs` and `transport_provider.rs`.

## Observations

### O1. Four in-code states, eight documented ones

`TransportState` has exactly four variants (`connection.rs:785-793`):
`BootstrapTcp`, `TcpCommitted`, `CandidateSetup`, `ProviderActive`. The document's
state diagram names eight nodes (`docs/mc-host-wire-protocol.md:653-670`):
`Authenticating`, `SetupOnly`, `TcpCommitted`, `CandidatePrepared`, `Activating`,
`AwaitingCommit`, `ProviderActive`, `Retired`.

The mapping, verified:

| Document node | In-code representation |
| --- | --- |
| `Authenticating` | No variant. It precedes `ConnectionSetup` entirely: `authenticate_server` runs at `connection.rs:148-155` and a failure returns at `:158-160`, before `ConnectionSetup::bootstrap()` is constructed at `:194`. |
| `SetupOnly` | `TransportState::BootstrapTcp` (`:786`, constructed at `:802-808`). |
| `TcpCommitted` | `TransportState::TcpCommitted` (`:787`), assigned at `:960`. |
| `CandidatePrepared`, `Activating`, `AwaitingCommit` | Collapsed into the single `CandidateSetup` variant (`:788-790`), assigned once at `:1103`. The three sub-stages are the sequential control flow of `run_candidate_setup` (`:1130-1199`): activation at `:1140-1152`, commit at `:1154-1171`. The collapse is documented in the type's own doc comment at `:781-784`. |
| `ProviderActive` | `TransportState::ProviderActive` (`:792`), but **never reached by mutating an existing `ConnectionSetup`**. It is only ever the initial state of a *fresh* `ConnectionSetup::provider_active()` (`:812-818`) built for a *fresh* generation in `run_connection` (`:211-224`). |
| `Retired` | No variant. It is the read loop returning a `ReadExit` (`enum ReadExit`, `:371-379`), stated at `:780`. |

Two consequences a reader tracing the document will not find:

1. The document's `AwaitingCommit --> ProviderActive` arc (`:665`) is not a state
   transition in the code. It is a generation handoff: `run_candidate_setup`
   stores the promoted receiver at `connection.rs:1186` and retires the bootstrap
   at `:1189-1190`; `run_connection` then mints a second generation at `:211-216`
   and calls `serve_generation` again at `:217-224`. One documented state machine
   spans two in-code generation lifetimes with two `ConnectionSetup` values.
2. `Retired` is a return value, so there is no state to inspect for "am I
   retired" and no `matches!` arm that can accidentally treat it as ready. The
   `matches!` shape at `:833-836` and `:643-644` makes any future variant
   fail closed by default, which is the right direction.

### O2. The negotiation-first gate is not uniform across frame kinds

`transport_ready` (`connection.rs:832-837`) is true for exactly
`TcpCommitted | ProviderActive`. Call sites and the frame kinds they guard:

| Frame kind | Guard | Line |
| --- | --- | --- |
| Oversize channel-0 control declaration (`InboundEvent::Rejected`) | `transport_ready` | `:430` |
| `Request`, channel != 0 | `transport_ready`, after `epoch != 0` at `:480` | `:483` |
| `Request`, channel 0, non-negotiate | inline `matches!` copy inside `handle_control` | `:642-647` |
| `Cancel` | `transport_ready`, after shape checks at `:492` | `:495` |
| `Goodbye`, channel != 0 | `transport_ready`, after shape checks at `:549` | `:552` |
| `Goodbye`, channel 0 | none needed: returns `ReadExit::Peer` unconditionally | `:541-547` |
| `Response`, `StreamData`, `StreamEnd`, `Error`, `Push`, `Hello`, `HelloAck`, `Ping` | none needed: unconditional `ReadExit::Peer` in every state | `:587-594` |
| **`Pong`** | **none** | `:500-540` |

So the gate is uniform across every kind that can carry application or control
meaning, with one true hole: `Pong` (O4). The channel-0 `Goodbye` case is a benign
difference rather than a hole, because it retires anyway, though it retires as an
orderly close (`:546`) rather than as a setup violation. Both produce a silent
`ReadExit::Peer`, so a client cannot distinguish them on the wire.

Two ordering details inside the gated arms:

- Structural shape is checked **before** readiness in three arms (`:480` before
  `:483`, `:492` before `:495`, `:549` before `:552`). Precedence is unobservable
  because both outcomes are the same silent `ReadExit::Peer`.
- For channel-0 control the body is fully decoded **before** the gate:
  `decode_control_frame` runs at `:474`, the gate at `:642-647`. `parse_control`
  is a pure parse against the target index, so there is no side effect, but a
  premature control frame still pays a full body decode.

### O3. The gate outranks the section 7.1 authoritative-terminal promise

`docs/mc-host-wire-protocol.md:580` requires malformed negotiation content to
receive terminal `Error{code:"invalid_control_request"}` before retirement, and
the oversize-control path elsewhere in the protocol promises an authoritative
early terminal for its correlation. The code honours that for a **malformed
negotiate body** (`connection.rs:849-875` stops liveness, emits the authoritative
rejection, and returns `PeerKeepQueue`), but an **oversize control declaration
arriving before negotiation** is refused by the readiness gate at `:430` and
retires silently, with no terminal at all.

The existing test at `tests/transport_negotiation.rs:941-948` sends a 65,537-byte
channel-0 request before negotiating and asserts only `closed_within`. It passes
under either behaviour, so it does not pin this precedence.

### O4. Documented Pong retirement versus required Pong, in the same window

Contradiction, catalogued and deliberately not resolved.

- `docs/mc-host-wire-protocol.md:562`: "A first application request, routed
  request, other control operation, `Cancel`, `Pong`, or `Goodbye` retires the
  setup generation without dispatch or same-generation TCP continuation."
- `connection.rs:500-540`: the `Pong` arm checks only `channel != 0 || corr == 0`
  (`:501`) and then reconciles against `gen.pings`. There is no `transport_ready`
  call anywhere in the arm. An unmatched correlation falls through the `_ => {}`
  arm at `:538` and the loop continues. A `Pong` therefore does **not** retire a
  setup generation.
- `connection.rs:291-302`: `serve_generation` starts `liveness_loop` immediately
  after inserting the generation into the registry and **before** awaiting the
  read task at `:304`, so probing begins while the state is still
  `BootstrapTcp`. Nothing in `liveness_loop` (`:1345` onward) consults the setup
  state.
- `connection.rs:1023-1036`: the grant path stops and joins bootstrap liveness
  before publishing a selection, and its comment states why bootstrap probing is
  live during setup. That comment is independent evidence that host Pings during
  `BootstrapTcp` are intended, not accidental.

So with liveness configured the host issues a Ping during exactly the window in
which the document says an arriving Pong retires the generation, and a missed Pong
can invalidate the generation. Either the document's `Pong` entry is wrong, or the
host must not probe before a selection commits. Both readings are internally
consistent; the code implements neither cleanly.

### O5. Selection is sticky, and only two assignments exist

`setup.state` is written in exactly two places: `:960` (`TcpCommitted`) and
`:1103` (`CandidateSetup`). `handle_negotiate` refuses every state other than
`BootstrapTcp` at `:846-848`. Therefore:

- At most one negotiation commits per generation.
- No state ever leaves `TcpCommitted` or `CandidateSetup` except by retirement.
- `setup.handoff` is assigned once, at `:1104`, immediately after the state
  assignment that closes the gate, so a second candidate cannot overwrite and
  leak the first.
- Ordering: the state commits at `:960` **before** `respond_tcp` even queues the
  response (`:961`, emission spawned off-reader at `:983`). Application traffic
  pipelined behind the negotiate frame is therefore accepted before the client
  has seen the selection. That is required for pipelining and is not a defect.

Minor comment inaccuracy: `:979-980` justifies the missing pending permit with
"the setup state machine admits at most two TCP negotiation responses per
generation". The state machine admits at most **one**: `respond_tcp` has a single
caller (`:961`), which is reachable only from `BootstrapTcp`, and `:960` closes
that door first. The comment over-estimates, so the bound is still sound.

### O6. Two copies of the readiness predicate

`transport_ready` at `:832-837` and the inline `matches!` at `:642-645` are
textually identical predicates over the same field. Four call sites use the
function; the fifth, the channel-0 control gate, hand-rolls it. Nothing forces
them to agree. If a fifth state is added and only one copy is updated, the gate
silently becomes non-uniform for exactly one frame class.

### O7. Fallback reason precedence, and a preflight that is serveable by default

`handle_negotiate:947-959` computes the reason after the offer loop:
`Unavailable` if any offer reported `DynamicallyUnavailable`, else
`CapabilityVersionMismatch` if any offered transport is installed at another
version, else `None`. The comment at `:947-952` gives the reason: per
`docs/mc-host-wire-protocol.md:621`, exact `unavailable` is the only selection
that authorizes a client re-upgrade probe, so a static mismatch from a
lower-preference sibling must not mask a transient condition and permanently
suppress recovery.

Inputs to that precedence:

- `PreflightEligibility` defaults to `Serveable`
  (`transport_provider.rs:118-120`): a provider that does not override
  `preflight` is always statically eligible, so `unavailable` can only arise from
  an explicit override.
- A panicking preflight is caught at `connection.rs:907-912` and mapped to
  `StaticallyOmitted`, which contributes **no** reason and yields reasonless TCP.
  The comment at `:906` states this is intentional (fail toward static omission,
  no client probe). So a broken provider is indistinguishable from a provider that
  was never installed.
- `capability_mismatch` requires `providers.serves_transport`
  (`transport_provider.rs:286`), which is false for an empty registry.

Verified reachability consequence: `TransportProviders::default()` is empty
(`transport_provider.rs:157-163`), the crate doc states non-TCP providers are
test-injected (`:1-13`, `:109-112`), and `HostConfig::default` installs
`TransportProviders::default()` (`config.rs:297`). With no provider installed both
flags stay false, so **in every shipped configuration in this tree the reason is
always `None` and negotiation always ends in a reasonless TCP commit**. The
precedence rule itself is test-only.

## Records

### negotiation-precedes-every-gated-frame-kind

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/transport_negotiation.rs:906-949` covers four
channel-0 control operations, one routed request, and one oversize control
declaration before negotiation. `Cancel`, routed `Goodbye`, and `Pong` before
negotiation are uncovered, and no case asserts the absence of an emitted terminal.
Guarantee: while the setup state is `BootstrapTcp` or `CandidateSetup`, no routed
request is dispatched, no cancel is applied, no routed goodbye begins a close, no
non-negotiate channel-0 control action is admitted, and no oversize-rejection
terminal is emitted; the generation retires instead.
Check: `always` — for every inbound frame, assert that
`transport_ready(setup) == false` implies the read loop returned `ReadExit::Peer`
without reaching `dispatch_request` (`connection.rs:486`), `handle_cancel`
(`:498`), `begin_close_owned` (`:566`), the control admission block (`:659`
onward), or `emit_authoritative_rejection` (`:454`). `always` and not
`unreachable`, because the forbidden thing is a *state pairing* (not ready, yet
dispatched) rather than a code location that must never execute: all five sites
are legitimate once ready.
Fault/timing angle: pipelining. The client may send the gated frame in the same
TCP segment as, or immediately after, its negotiate request. The state commits at
`:960` before the response is queued at `:961`, so the interesting window is
frames that arrive after `:960` but before the client could have read the
selection; those are legitimately accepted, and a test must not mistake them for
a gate failure.
Required faults and enabling state: a raw client that authenticates and then sends
one frame of each gated kind without negotiating. No provider, no liveness, and no
fault injection: `TestHost::start` plus `setup_client`
(`tests/support/mod.rs:688`) is sufficient. Reaching the `CandidateSetup` half of
the state predicate additionally needs an injected provider, which is test-only;
the `BootstrapTcp` half is the default path.
Confidence: high — [evidence](evidence/negotiation-precedes-every-gated-frame-kind.md). All five gate sites and all
fourteen frame-kind arms enumerated against `connection.rs:417-598` and
`:626-647`.
Existing check: `tests/transport_negotiation.rs:906` covers six of the eight
gated shapes and asserts no bind occurred; it does not cover `Cancel`, routed
`Goodbye`, or the absence of a terminal on the oversize path.
Impact: any hole admits application-visible work on a connection whose transport
is not yet chosen, which is the one thing section 7.7 exists to forbid. A routed
dispatch there would run handler code the client can then be told to reach over a
different transport.
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
`CandidateSetup`, negotiation on a promoted `ProviderActive` generation, and the
at-most-one-candidate claim are uncovered.
Guarantee: at most one negotiation commits per generation. Once the state leaves
`BootstrapTcp` it never returns, at most one candidate handoff is ever recorded,
and any later or repeated negotiation retires the generation.
Check: `always` — instrument the two `setup.state` writes (`connection.rs:960`,
`:1103`) and the `setup.handoff` write (`:1104`); assert at most one of each per
`ConnectionSetup`, assert no write whose prior state is not `BootstrapTcp`, and
assert every `handle_negotiate` entry with a non-`BootstrapTcp` state returns
`ControlFlow::Close` (`:846-848`). `always` because stickiness is evaluated on
every negotiate frame, and a single violation hands one connection two
transports.
Fault/timing angle: none in the single-reader design. All three writes happen on
the sole read loop, so no interleaving can produce two selections. The timing
question is the reverse one: the state closes at `:960` and `:1103` before the
corresponding response is emitted, so retirement of a late negotiation can be
observed by the client before it observes the first selection.
Required faults and enabling state: a raw client that negotiates twice. The
`TcpCommitted` arc needs no provider and no configuration. The `CandidateSetup`
and `ProviderActive` arcs need an injected provider, which is test-only; that is
why this record is labelled by its default-reachable arc and the provider arcs
are named explicitly.
Confidence: high — [evidence](evidence/setup-selection-is-sticky-for-the-generation.md). `setup.state` has exactly two
write sites and `setup.handoff` exactly one, all enumerated by grep over
`connection.rs`.
Existing check: `tests/transport_negotiation.rs:962`
`repeated_negotiation_after_negotiated_tcp_selection_retires` covers the
`TcpCommitted` arc only. Status `unaudited`.
Impact: a second accepted negotiation would prepare a second candidate, overwrite
`setup.handoff` at `:1104`, and leak the first candidate's sender, cancellation
root, and I/O task, because the setup owner reaps only what the slot still holds
(`:201-234`).
Open questions: None.

### setup-readiness-is-decided-by-one-predicate

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads the setup state directly, and no lint or test
asserts that the two predicate copies agree.
Guarantee: exactly one definition decides whether a generation may carry
non-setup traffic, and every frame-kind gate consults that one definition, so a
new setup state cannot be ready for one frame class and not another.
Check: `always` — assert that the set of `TransportState` variants accepted by
`transport_ready` (`connection.rs:832-837`) equals the set accepted by the inline
`matches!` in `handle_control` (`:642-645`), and that no third readiness test
exists. Enforceable as a test over an extracted predicate, or mechanically by
deleting the inline copy and calling `transport_ready`; the property is the
agreement, not the shape. `always` because the two copies are evaluated
independently on every frame.
Fault/timing angle: none. This is a structural property of the source, and the
fault is a future edit rather than a runtime interleaving.
Required faults and enabling state: none for the current tree, which satisfies
the property. To make the check meaningful, add a fifth `TransportState` variant
in a test fixture, or assert both predicates over all variants; the `matches!`
shape means a new variant is refused by both copies unless a author adds it,
which is the fail-closed direction.
Confidence: high — [evidence](evidence/setup-readiness-is-decided-by-one-predicate.md). Both predicate bodies read at
HEAD and confirmed textually identical over the same field; the four
`transport_ready` call sites and the one inline site enumerated.
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
Exercised: not yet — no test sends a `Pong` before negotiation, and no test runs
a configured liveness policy against a generation that has not yet negotiated.
Guarantee: contested. `docs/mc-host-wire-protocol.md:562` states that a `Pong`
retires the setup generation. `connection.rs:500-540` implements no readiness
gate in the `Pong` arm, and `connection.rs:291-302` starts liveness probing
before the read loop is awaited at `:304`, so with liveness configured the host
demands a `Pong` in exactly the window the document says a `Pong` must retire.
This record catalogues the contradiction with both sides cited and does not
choose between them.
Check: `sometimes` — assert that a campaign produces at least one interval in
which the setup state is `BootstrapTcp` or `CandidateSetup`, a host Ping is
outstanding in `gen.pings`, and a matching `Pong` is delivered to the read loop.
Marker `SETUP_PONG_WINDOW_OBSERVED`. `sometimes` and not `always`, because
asserting either resolution would resolve a normative question this record exists
to record: the honest check is that the window occurs, so a human can decide
against a real trace. Situation coverage, not location coverage: the `Pong` arm's
lines are already executed by post-negotiation tests while the setup window is
never produced.
Fault/timing angle: the whole record is a window. It opens when `liveness_loop`
is spawned at `:296` and closes when the state commits at `:960` or `:1103`. Its
width is `ping_interval` versus the client's time to negotiate, so a fast client
never sees a Ping and a slow or paused client always does. The grant path
narrows, but does not close, the window: it stops and joins bootstrap liveness at
`:1032-1036`, which is after any bootstrap Ping may already have been sent.
Required faults and enabling state: `liveness: Some(..)` in `HostConfig`, which
is not a shipped configuration in this tree; the default is `None`
(`config.rs:296`) and the only `Some` is inside the test module
(`config.rs:664`). Plus a client that authenticates, delays negotiation past
`ping_interval`, and then answers the Ping. The weaker half of the contradiction,
that an *unsolicited* `Pong` before negotiation is silently ignored rather than
retiring the generation, needs no liveness at all and is default-production; it is
a strictly smaller claim and is recorded in the evidence file.
Confidence: high — [evidence](evidence/a-setup-pong-is-required-and-forbidden-in-the-same-window.md). Both sides read at HEAD: the
document sentence, the ungated `Pong` arm, the liveness start point, and the
grant path's own comment explaining that bootstrap probing is live during setup.
Existing check: none. `pong-preanswer-rejected-in-every-mutex-order` in this
catalog covers the `Pong` arm's acceptance rule, not its absent readiness gate.
Impact: unresolved, and that is the finding. Under the document's reading the host
kills healthy generations' probes by answering them; under the code's reading the
document forbids a frame the host itself solicits. A test author picking either
side without a decision would encode a guess as a regression test.
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
provider and a panicking preflight both contribute no reason and select reasonless
TCP.
Check: `always-or-unreached` — whenever a reason is computed
(`connection.rs:953-959`), assert `dynamically_unavailable` implies the emitted
reason is `Unavailable` regardless of `capability_mismatch`, and that a
`StaticallyOmitted` or panicking preflight contributes no reason. These semantics
and not `always`, because the path may never run in a shipped configuration: with
an empty provider registry both flags are unconditionally false, so it must be
correct when reached rather than reached at all.
Fault/timing angle: a panicking preflight is the fault of interest. It is caught
at `:907-912` and mapped to `StaticallyOmitted`, so a broken provider is
indistinguishable from one that was never installed, and the client is denied the
re-upgrade probe that `docs/mc-host-wire-protocol.md:621` reserves for
`unavailable`. Ordering matters too: the loop breaks on the first serveable TCP
offer (`:892-896`), so offers after the TCP entry are never evaluated and cannot
contribute a reason.
Required faults and enabling state: at least two injected providers, one
returning `DynamicallyUnavailable` from `preflight` and one installed at a
capability version the client does not offer, with the client offering the
unavailable transport at lower preference than the mismatched one. Injected
providers are test-only: `TransportProviders::default()` is empty
(`transport_provider.rs:157-163`), the module documents providers as
test-injected (`:1-13`), and `HostConfig::default` installs the empty registry
(`config.rs:297`). Verified consequence: in every shipped configuration the reason
is always `None`.
Confidence: high — [evidence](evidence/fallback-reason-precedence-survives-a-silent-preflight.md). Precedence block, preflight
default, panic mapping, and the `serves_transport` gate all read at HEAD; the
empty-registry conclusion traced from `HostConfig::default` to
`TransportProviders::default`.
Existing check: `tests/transport_negotiation.rs:136`
`version_mismatches_encode_the_documented_tcp_fallback_reasons` covers the
encoders, and `:876` covers one live mismatch fallback. Neither covers precedence
between the two reasons. Status `unaudited`.
Impact: reporting a static mismatch where a transient condition exists
permanently suppresses the client's re-upgrade probe, so a transport that would
recover in seconds stays unused for the life of the connection. The panic mapping
has the same effect for a provider whose preflight is merely buggy.
Open questions:
- Should a panicking preflight be observably different from permanent absence,
  for example through a host-side event, given that the wire reason must stay
  reasonless per the KTD6 comment at `:906`? (needs human input)
