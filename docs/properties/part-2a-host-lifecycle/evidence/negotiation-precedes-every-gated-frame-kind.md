# negotiation-precedes-every-gated-frame-kind

## Discovery trigger

Gap G1 from `portfolio-evaluation.md:96` named negotiation-first as normative and
uncataloged. `docs/mc-host-wire-protocol.md:560` states the obligation directly:
the first post-authentication request MUST be a valid channel-0
`transport.negotiate` at negotiation version 1, and "no application or other
control traffic is permitted until a valid selection commits the transport". The
question that made this a record rather than a note was whether the implementation
enforces that uniformly, because a per-frame-kind gate is exactly the shape where
one arm gets forgotten.

## Evidence trail

The readiness predicate is `transport_ready` at `crates/mc-host/src/connection.rs:832-837`:

```rust
fn transport_ready(setup: &ConnectionSetup) -> bool {
    matches!(
        setup.state,
        TransportState::TcpCommitted | TransportState::ProviderActive
    )
}
```

So `BootstrapTcp` (`:786`) and `CandidateSetup` (`:790`) are both not ready. That
matches the document twice over: section 7.7 forbids traffic before a selection
commits (`:560`), and `:651` separately forbids "any application-bearing operation
while a candidate is being set up".

Every arm of the read loop's frame-kind match (`connection.rs:417-598`), read at
HEAD:

| Frame kind | Guard | Line | Reaches what if ungated |
| --- | --- | --- | --- |
| `InboundEvent::Rejected` | `transport_ready` | `:430` | `emit_authoritative_rejection` at `:454` |
| `Request`, channel != 0 | `transport_ready` | `:483` | `dispatch_request` at `:486` |
| `Request`, channel 0, non-negotiate | inline `matches!` | `:642-647` | control admission from `:659` |
| `Cancel` | `transport_ready` | `:495` | `handle_cancel` at `:498` |
| `Goodbye`, channel != 0 | `transport_ready` | `:552` | `begin_close_owned` at `:566` |
| `Goodbye`, channel 0 | none needed | `:541-547` | returns `Peer` in every state |
| `Pong` | **none** | `:500-540` | reconciles `gen.pings`; see the separate record |
| `Response`, `StreamData`, `StreamEnd`, `Error`, `Push`, `Hello`, `HelloAck`, `Ping` | none needed | `:587-594` | returns `Peer` in every state |

`Request` on channel 0 that decodes as `TransportNegotiate` is intercepted before
the control gate, at `connection.rs:636-639`, and its own state check is
`handle_negotiate:846-848` (`BootstrapTcp` only). That interception is why the
control gate at `:642-647` can be unconditional: the one frame kind that must be
accepted while not ready has already returned.

Two ordering facts inside the gated arms:

1. Structural shape precedes readiness: `epoch != 0` at `:480` before the gate at
   `:483`; the `Cancel` shape triple at `:492` before `:495`; the `Goodbye` shape
   pair at `:549` before `:552`. Both outcomes are a silent `ReadExit::Peer`, so
   the precedence is unobservable to the client and cannot be tested from the
   wire.
2. The channel-0 control body is decoded before the gate: `decode_control_frame`
   at `:474`, gate at `:642-647`. `parse_control` is a pure parse against
   `shared.targets`, so no side effect escapes, but a premature control frame
   still pays a full body decode. That is a cost observation, not a correctness
   one.

The `Rejected` arm has one more wrinkle worth pinning: the correlation watermark
is advanced at `:429` *before* the readiness gate at `:430`. Because the gate then
returns `ReadExit::Peer`, the mutated watermark is never observed again, so the
ordering is harmless in the current code. It would stop being harmless if the gate
were ever changed to continue rather than retire.

## Failure scenario

A future arm, or a refactor that moves a gate below the work it guards, admits one
gated frame while the state is `BootstrapTcp`. The concrete worst case is the
routed-request arm: `dispatch_request` at `:486` runs handler code on a connection
whose transport is not yet chosen. If the same connection then commits a non-TCP
grant, the handler has already observed work attributed to a generation that is
about to be retired and replaced (`:1189-1190`, `:211-224`), and the client's view
of which transport carried that request is undefined.

The cheaper and more likely failure is the `Cancel` arm: `handle_cancel` at `:498`
mutates `gen.pending` for a route that cannot exist yet, which is silent rather
than observable, so no test would notice.

## Timing windows and dependencies

The interesting window is pipelining, and it cuts against a naive test. The state
commits at `:960` *before* `respond_tcp` is called at `:961`, and `respond_tcp`
only spawns the emission (`:983`). So frames that arrive immediately after the
negotiate request are legitimately accepted even though the client has not yet
read the selection. A test that sends negotiate and an application request in one
write and expects a close is asserting the wrong thing.

The `CandidateSetup` half of the predicate depends on an injected provider, since
`:1103` is only reached from `grant_candidate`, which requires
`providers.find` to return a provider (`:901-905`). That half is test-only. The
`BootstrapTcp` half needs nothing beyond authentication.

## What a test must construct

1. Authenticate without negotiating: `TestHost::start` plus `setup_client`
   (`tests/support/mod.rs:688`).
2. Send one frame of each gated kind and assert the connection closes: a routed
   `Request`, a channel-0 control request, an oversize channel-0 control
   declaration, a `Cancel` with a nonzero channel, epoch, and correlation, and a
   routed `Goodbye`. The first three exist today at
   `tests/transport_negotiation.rs:906-949`; `Cancel` and routed `Goodbye` do not.
3. Assert the negative side, which no existing test does: nothing was emitted on
   the connection before the close. That is what separates "the gate refused" from
   "the work ran and then the connection happened to close".
4. For the `CandidateSetup` half, inject a provider whose `prepare` blocks, then
   send a gated frame while the candidate setup is pending.

## Investigation log

### Q: Should a premature oversize control declaration receive the section 7.1 authoritative terminal before retiring?

- Sources examined: `connection.rs:418-464` (the `Rejected` arm),
  `connection.rs:849-875` (the malformed-negotiate path),
  `docs/mc-host-wire-protocol.md:580`, `tests/transport_negotiation.rs:941-948`.
- Findings: the two paths choose opposite answers. A malformed negotiate body
  stops liveness, emits `invalid_control_request` through
  `emit_authoritative_rejection`, and returns `PeerKeepQueue` so the terminal is
  flushed. An oversize control declaration arriving before negotiation is refused
  at `:430` and retires silently with no terminal. The document states both rules
  (a terminal for malformed negotiation content, and silent retirement for
  premature traffic) without ordering them.
- Missing evidence: no design note in the tree states which rule wins when a frame
  is both premature and oversize. The existing test asserts only `closed_within`,
  so it passes under either behaviour and cannot be read as an intent statement.
- Conclusion: needs human input. The record carries it as an open question and its
  check asserts only the behaviour the code implements today.
