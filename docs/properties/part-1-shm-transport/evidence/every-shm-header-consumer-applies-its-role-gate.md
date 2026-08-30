# every-shm-header-consumer-applies-its-role-gate

## Discovery trigger

The transport hands the same 21 header bytes to more than one consumer, and it
validates only five of them (`crates/mc-shm-transport/src/descriptor.rs:289-297`).
That makes the role gate a per-consumer obligation rather than a property of the
transport. Checking the consumers against each other found the Rust host applies
its gate and the TypeScript peer, over shared memory only, does not — while the
same peer's TCP path does.

## Evidence trail

The obligation is normative: `docs/mc-host-wire-protocol.md:266` states that a
consumer-originated `Response`, `Push`, `StreamData`, `StreamEnd`, or `Error`,
and every host-originated `Request`, are role-invalid, and that "the receiver MUST
close the generation rather than extend this profile implicitly."
`docs/mc-host-wire-protocol.md:260-261` adds `Hello` and `HelloAck` as
role-invalid on a consumer connection.

Consumer one, the host. `receive_one` calls `validate_inbound_header`
(`crates/mc-host/src/ring_transport.rs:473`), which restricts the type to
`Request`, `Cancel`, `Pong`, `Goodbye` and returns `ReadClose::Corrupt` otherwise
(`frame_channel.rs:69-74`). `Corrupt` is outside the clean set
(the `clean` classification formerly at `shm_provider.rs:498`, deleted by
`ed487e11`), so the generation closes and the custody record
goes to `recovery.report_suspect` (`:364-371`). This arm is exercised end to end
by `crates/mc-host/tests/shm_failure_modes.rs:195-241`, which publishes a
`Response` from a live peer and asserts the charges end up quarantined and
readiness returns to `Ready`.

Consumer two, the peer. `ShmFrameChannel.poll`
(`packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:295-331`) calls
`decodeHeader` at `:305` and passes the result straight to
`handlers.onFrame` at `:325`. `decodeHeader`
(`packages/plugin/src/shared/mc-host-client/protocol.ts:266-295`) ends in
`validateHeader` (`:161-231`), which covers version, the type *range*, the 64 MiB
cap, reserved flag bits, reserved priority, reserved admission class, `Sheddable`
placement, both channel/epoch rules, and pure-header-with-body. It does not
contain a role rule. The role rule lives in `headerViolation`
(`frame-channel.ts:512-557`), which starts with `isLegalHostToConsumerType`
(`:515`, set defined at `protocol.ts:297-305`, exported at `:320-322`) and adds
the identity rules — `corr === 0n` on a terminal or stream frame, `StreamEnd`
with a body, `Ping` outside `0/0/nonzero`, `Goodbye` with a nonzero correlation.
`headerViolation` has exactly three call sites: `tcp-frame-channel.ts:860`,
`transport-provider.ts:425`, and its own definition. The shared-memory channel is
not among them, and `shm-frame-channel.ts:24` does not import it.

What reaches the application instead. `ShmFrameChannel` is installed as the whole
channel, not as a layer under the TCP one: `shm-transport-provider.ts:65`
constructs it, and `connection.ts:403-405` substitutes `options.channelFactory`
for `TcpFrameChannel` entirely. `onFrame` is `(frame) => this.dispatch(...)`
(`connection.ts:391`). `dispatch` (`:798-834`) switches on the type and ends in
`default: releaseQuietly(body)` (`:832-833`) with no counter increment and no
retirement. Type numbering is `Request: 0`, `Hello: 9`, `HelloAck: 10`,
`Goodbye: 11`, with `FRAME_TYPE_MAX = FrameType.Goodbye`
(`protocol.ts:26-42`), so a host-originated `Request`, `Hello`, or `HelloAck`
passes the range check at `:165`, reaches `dispatch`, and is silently released.
`Push` is dropped one branch earlier with a counter (`connection.ts:822-825`),
which is a deliberate profile decision, not the role gate.

Consumer three, the Rust test peer. `TestShmPeer::recv`
(`ring_transport.rs:676-687`, whose body now sits in `try_recv_with`) calls
`decode_header` at `:701` and no role gate. It
is test-only surface, but it is a third reader of `ValidatedFrame::wire_header()`
and it demonstrates that the transport's lease API invites decode-only use.

## Failure scenario

A host that has been compromised, or that regresses, publishes a `Hello` or a
host-originated `Request` into the host-to-peer ring. The transport accepts it —
those bytes are outside its five — `decodeHeader` accepts it, and `dispatch`
releases the lease and returns. The generation stays open. The peer has silently
extended the profile in exactly the way the wire document forbids, and has
produced no diagnostic, no counter, and no close reason, so the divergence is
invisible in operation. Over TCP the identical frame retires the generation with
`role_violation`. The asymmetry also runs the other way: because the shm path
skips `headerViolation`, it also skips the correlation-identity rules, so a
`Response` with `corr === 0n` reaches `dispatchToPending`
(`connection.ts:837-843`), where `pending.get` misses and the frame is counted as
dropped rather than treated as a protocol violation.

## Timing windows and dependencies

No timing window. This is a static per-consumer coverage gap, and both branches
of the comparison are present at HEAD. It depends on
`wire-header-fully-validated-before-any-consumer-acts` for the framing — the
transport's success return says nothing about bytes 5 through 20 — and it is the
concrete instance of that record's second drift. Scope note: the peer consumer
lives in `packages/plugin`, which the catalog assigns to part-5, so this record
straddles the boundary. It belongs to Part 1 because the shared premise is the
transport's pass-through, and no part-5 catalog exists yet to hold it.

## What a test must construct

For the host arm, generalise `shm_failure_modes.rs:195-241` from one role-invalid
type to the full illegal set for the host direction — `Response`, `Push`,
`StreamData`, `StreamEnd`, `Error`, `Hello`, `HelloAck` — asserting `Corrupt` and
the suspect path for each. For the peer arm, a host-side driver that publishes
`Hello`, `HelloAck`, and a host-originated `Request` into the host-to-peer ring,
with the assertion on the channel's close reason and not on the drop: today the
frame is released and nothing observable changes, so an assertion phrased as
"the frame was not delivered to a handler" would pass while the property fails.
The discriminating oracle is `onClosed` being called with `role_violation`.
`shm-frame-channel.test.ts` already drives the channel with synthetic native
leases, which is the cheapest place to construct it. A static check is worth
adding beside both: every inbound channel implementation in
`mc-host-client` must reach `headerViolation`, which today is two of three.

## Investigation log

### Q: Is the role gate applied somewhere between `ShmFrameChannel.poll` and the application, so the omission at `:305` is compensated downstream?

- Sources examined: every `headerViolation` call site from a repository-wide grep
  (`frame-channel.ts:512`, `tcp-frame-channel.ts:860`,
  `transport-provider.ts:425`); `shm-frame-channel.ts:295-331`;
  `connection.ts:391` and `:798-834`; `shm-transport-provider.ts:65`;
  `connection.ts:403-405`.
- Findings: no. The only path from the shm channel to the application is
  `onFrame` to `dispatch`, and `dispatch` has no role rule — its `default` arm
  releases and returns. The provider-lease path in `transport-provider.ts` does
  apply both `validateHeader` and `headerViolation` (`:424-426`), which shows the
  check is considered necessary for an untrusted lease source elsewhere in the
  same file set.
- Missing evidence: whether `ShmFrameChannel` is reachable in any shipped
  configuration, or only through an explicitly injected factory. The transport
  registries were reported empty for Part 1 as a whole
  (`docs/mc-host-shm-transport.md:5-7`), and I did not re-derive that for the
  client package.
- Conclusion: the omission is real and uncompensated on the path that exists. Its
  urgency depends on the reachability question above, which is unresolved here.
