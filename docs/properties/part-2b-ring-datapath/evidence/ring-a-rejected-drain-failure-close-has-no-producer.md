# ring-a-rejected-drain-failure-close-has-no-producer

## Discovery trigger

Enumerating the `ReadClose` variants that `receive_one` can produce, in order to
write the inbound half of the frame-lifecycle map. Two of the six variants
declared at `crates/mc-host/src/frame_channel.rs:33-48` never appeared in the
enumeration. Grepping confirmed neither has a producer anywhere in the tree.

## Evidence trail

**The declared taxonomy.** `frame_channel.rs:30-48`:

```
#[derive(Debug)]
#[allow(dead_code)]
pub enum ReadClose {
    CleanEof,
    Corrupt(&'static str),
    Cancelled,
    Overloaded,
    Io(std::io::Error),
    RejectedDrainFailed,
}
```

The `#[allow(dead_code)]` at `:32` is what keeps the two unproduced variants
compiling without a warning.

**Producer enumeration, complete.**

| Variant | Producers |
| --- | --- |
| `CleanEof` | `ring_transport.rs:359` (closed inbound channel) |
| `Corrupt` | `frame_channel.rs:60`, `:67`, `:73`; `ring_transport.rs:467`, `:472`, `:477`, `:507`, `:521`, `:524` |
| `Cancelled` | `ring_transport.rs:396`, `:483`, `:493`, `:513`, `:532` |
| `Overloaded` | `ring_transport.rs:499` |
| `Io` | **none** |
| `RejectedDrainFailed` | **none** |

The two empty rows have exactly one mention each besides the declaration:
`connection.rs:403` for `Io` and `connection.rs:391` for
`RejectedDrainFailed`, both consuming match arms.

**What the missing producer strands.** `connection.rs:391-400`:

```
Err(ReadClose::RejectedDrainFailed) => {
    // The queued early terminal is authoritative for its
    // correlation even when the declared body then fails
    // (protocol §7.1): the close stays silent otherwise, but
    // that one frame must survive to flush.
    return match reject_written.take() {
        Some(terminal_rx) => ReadExit::PeerKeepQueue(terminal_rx),
        None => ReadExit::Peer,
    };
}
```

`connection.rs:397` is the only construction site of
`ReadExit::PeerKeepQueue`. Since the arm cannot be entered, the variant cannot be
built, so the `serve_generation` arm that handles it is dead too:

```
// connection.rs:304-308
ReadExit::PeerKeepQueue(terminal_written) => {
    let _ = terminal_written.await;
    gen.token.cancel();
    gen.writer.discard();
}
```

And so is the bookkeeping that feeds it: `reject_written` is declared at
`connection.rs:385` as
`let mut reject_written: Option<tokio::sync::oneshot::Receiver<()>> = None;` with
a comment explaining that it holds "the written-signal of the most recent
rejected-frame terminal: if the transport's realignment then fails, the close
fences exactly that authoritative frame (protocol §7.1)". The transport has no
realignment.

**Why the ring has no realignment to fail.** `receive_one`'s oversize channel-0
rejection is `ring_transport.rs:474-485`:

```
if header.ty == FrameType::Request && header.channel == 0 && header.len > MAX_CONTROL_BODY_LEN {
    lease.release()
        .map_err(|_| ReadClose::Corrupt("shared-memory completion failed"))?;
    inbound.send(Ok(InboundEvent::Rejected(RejectedFrame { corr: header.corr })))
        .await
        .map_err(|_| ReadClose::Cancelled)?;
    return Ok(true);
}
```

One descriptor names one complete header and body
(`docs/mc-host-wire-protocol.md:294`), so releasing the lease discards the whole
frame atomically. There is no partially-consumed stream to realign, no declared
byte count to drain, and no deadline on the rejection. The two failure modes that
`RejectedDrainFailed` existed to report — the declared body truncating or stalling
after an early terminal — cannot occur on a descriptor transport.

The variant is a residue of the deleted `frame_read.rs` and
`tcp_frame_channel.rs`, which read a length-prefixed byte stream and therefore
did have to realign. Part 2a's Group J is already marked
`superseded-by-refactor` for `frame_read.rs`, and Part 2a holds
`oversize-control-drain-work-is-bounded-without-ingress-budget` and
`the-client-body-budget-refusal-drain-is-never-entered` against that deleted
code.

## Failure scenario

There is no current defect. The wire contract's promise is satisfied vacuously.

The risk is a review hazard rather than a runtime one, and it has two shapes.

First, the dead arm looks like coverage. A reader auditing whether
`docs/mc-host-wire-protocol.md:321`'s authoritative-early-terminal guarantee is
honoured finds `connection.rs:391-400` and `:304-308` implementing it in detail,
with protocol section references, and concludes the guarantee is live. It is not
implemented; it is unreachable.

Second, `#[allow(dead_code)]` on the whole enum (`frame_channel.rs:32`) is
coarse. It suppresses the warning for every variant, so if a future refactor
stops producing `Overloaded` or `Corrupt` as well, nothing signals it. A
per-variant `#[expect(dead_code, reason = ...)]` would fail the build when a
variant stopped being dead, which is the direction the crate already uses
elsewhere: `frame_channel.rs:476` carries
`#[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]`
with an explicit reason, and that reason is itself now false (see
`ring-a-segmented-inbound-body-has-no-production-producer`).

## Timing windows and dependencies

No timing window. Static producer enumeration.

Dependencies:

- Part 2a's `oversize-control-drain-work-is-bounded-without-ingress-budget` and
  `the-client-body-budget-refusal-drain-is-never-entered` are the records this
  supersedes on the host side. The re-scope noted that whatever inbound-read
  obligation Group J held has migrated into `receive_one`; this record is the
  answer for the drain half, and the answer is that the obligation dissolved.
- `ring-a-publish-failure-is-reported-as-a-clean-peer-close` shows that
  `CleanEof` is over-produced while these two are under-produced, so the close
  taxonomy is skewed at both ends.

## What a test must construct

Nothing can construct it, which is the finding. The honest check is a
producer-existence assertion in the same family as
`ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`: for each
`ReadClose` variant, assert at least one production site exists. That is a
source-level check.

The alternative, and the better outcome, is deletion. Removing
`RejectedDrainFailed`, `Io`, `ReadExit::PeerKeepQueue`, the
`connection.rs:391-400` arm, the `connection.rs:304-308` arm, and
`reject_written` would let `#[allow(dead_code)]` come off the enum entirely,
after which the compiler enforces the property permanently and no test is needed.
That is a fix, not a check, and it is out of scope here.

Existing checks: none. Part 2a's
`the-client-body-budget-refusal-drain-is-never-entered` is the closest analogue
and was written against deleted code.

## Investigation log

### Q: Should `RejectedDrainFailed` and `Io` be removed, or retained for a future transport?

- Sources examined: `frame_channel.rs:30-48` (the enum and its blanket
  `#[allow(dead_code)]`), `connection.rs:387-405` (the consuming match),
  `connection.rs:385` (`reject_written`), `connection.rs:298-318` (the
  `ReadExit` match including the dead `PeerKeepQueue` arm),
  `connection.rs:356-370` (the `ReadExit` enum and its doc comment, which
  describes `PeerKeepQueue` as "the one exception"),
  `ring_transport.rs:474-485` (the ring's rejection path),
  `docs/mc-host-wire-protocol.md:321` (the guarantee),
  `docs/mc-host-shm-transport.md:7` ("There is no runtime transport
  selector, alternate shared-memory backend, compatibility reader, or degraded
  data path").
- Findings: the retention argument requires a future transport that reads a byte
  stream, and `docs/mc-host-shm-transport.md:7` forecloses exactly that,
  backed by the `mandatory-ring-architecture` CI gate
  (`ci.yml:41-58`) whose stated purpose is to "Reject obsolete application
  transports and dependencies". So the codebase has committed, at the CI level,
  to not reintroducing the transport these variants served. `Io` is the weaker
  case: a `std::io::Error` close could plausibly arise from a future setup-socket
  or file-backed path, and `setup_socket.rs` does convert `io::Error`
  (`setup_socket.rs:100`), though into `SetupError` rather than `ReadClose`.
- Missing evidence: what `bun run check:shm-architecture` (`ci.yml:58`) actually
  asserts. If it only greps for deleted file names it does not prevent a new
  stream transport, and the retention argument regains some force. The re-scope
  raised the same question and it is still open.
- Conclusion: unresolved pending that script, but leaning strongly toward
  removal for `RejectedDrainFailed`, since its entire semantic — realignment
  after a partially-consumed frame — is meaningless on a descriptor transport and
  would need re-designing rather than reusing even if a stream transport
  returned.

### Q: Does the ring path satisfy `docs/mc-host-wire-protocol.md:321` or merely evade it?

- Sources examined: `docs/mc-host-wire-protocol.md:321` in full;
  `ring_transport.rs:474-485`; `connection.rs:408-420` (the
  `InboundEvent::Rejected` handler and its watermark check at `:415-417`);
  `wire.rs:374` (`MAX_CONTROL_BODY_LEN = 65_536`).
- Findings: the doc's clauses split cleanly. "A channel-0 header declaring `len`
  greater than 65,536 already proves the violation" — satisfied at `:474`. "the
  host MAY emit that terminal as soon as header validation completes" —
  satisfied, `validate_inbound_header` runs at `:473` and the rejection follows
  at `:474`. "MUST NOT buffer the oversize body" — satisfied, the lease is
  released at `:475-477` before any body byte is read, and no ingress charge is
  taken. "drains and discards the declared bytes under the frame's absolute
  deadline to preserve stream alignment" — inapplicable, there is no stream. "The
  early terminal is authoritative for its correlation even if the declared body
  then truncates, stalls, or EOFs" — vacuously true, since the body cannot
  separately fail.
- Missing evidence: none.
- Conclusion: resolved with answer. The ring satisfies every applicable clause
  and the drain clause is inapplicable rather than violated. The doc's phrasing
  assumes a stream transport, which is a contract-vs-code lead in its own right
  (L5 in the lens file) but not a defect.
