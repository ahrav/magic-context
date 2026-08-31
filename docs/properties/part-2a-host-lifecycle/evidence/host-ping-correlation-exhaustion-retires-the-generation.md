# host-ping-correlation-exhaustion-retires-the-generation

## Discovery trigger

The wire protocol states the no-reuse rule for both directions and names its own violation. The host
enforces it on ingress with a watermark and does not enforce it on egress at all: the ping allocator
is an unbounded `fetch_add` with no exhaustion branch. `docs/mc-host-wire-protocol.md:748` even
records the defect as scheduled work — "Published `HistorianProducer` currently saturates at
`u64::MAX`; compatibility work in `magic-context-c50.4` MUST replace saturation with checked
exhaustion and generation retirement."

## Evidence trail

The allocator is one line. `crates/mc-host/src/connection.rs:1399`:

```
let corr = gen.next_ping_corr.fetch_add(1, Ordering::SeqCst);
```

`next_ping_corr` is `std::sync::atomic::AtomicU64` (`connection.rs:121`), seeded at 1 in all four
constructors: `connection.rs:255` on the live path, `routing.rs:502`, and the two test fixtures at
`connection.rs:1527` and `:1632`. `fetch_add` on `AtomicU64` wraps on overflow; there is no
`checked_add`, no `compare_exchange` loop with a ceiling, and no branch on the returned value. The
2^64-th probe on one generation therefore yields `corr == 0`.

Nothing downstream rejects that. `connection.rs:1412-1418` encodes the frame with
`crate::wire::FrameId::control(corr)` (`:1415`), and `FrameId::control` (`wire.rs:517-523`) is a bare
struct literal — `channel: 0, epoch: 0, corr` — with no validation. `wire.rs:571-583`
`encode_owned_frame` checks only body length against `MAX_BODY_LEN`; the correlation is copied into
the header at `:591` unexamined. The `.expect("header-only Ping always encodes")` at
`connection.rs:1418` is therefore accurate: a correlation-0 Ping encodes successfully and is written.

The host's own ingress rule then rejects the answer. `connection.rs:501-503`:

```
if header.channel != 0 || header.corr == 0 {
    return ReadExit::Peer;
}
```

So a peer that correctly echoes a correlation-0 Ping produces a frame the host classifies as a
protocol violation and closes the generation on. The ingress half of the same rule is enforced
strictly for consumer requests at `:426-429` and `:469-472`, and
`docs/mc-host-wire-protocol.md:750` exempts `Pong` from the watermark because it "reference[s]
existing identities".

## Failure scenario

Two distinct outcomes, neither of which is the documented one.

If the peer echoes the correlation-0 Ping, the read loop returns `ReadExit::Peer` at `:502` and the
generation closes — the right disposition reached for the wrong reason, blamed on the peer for
echoing exactly what the host sent.

If the peer does not answer, the probe with key `0` sits in the pings map. The next `fetch_add`
returns 1, colliding with the correlation the generation's very first probe used. Whether that
collides with a live entry depends on whether probe 1 was ever removed; the liveness loop refuses to
add a second probe beside an unexpired one (`:1384-1391`), so at most one probe is outstanding at a
time and the collision is benign in practice. The contractual violation is the reuse itself, which
`:748` states as "A correlation MUST NOT be reused, even after terminal completion."

The documented behaviour — "before another request, sender MUST retire the generation and reconnect"
— has no implementing code on this path.

## Timing windows and dependencies

No window and no fault to inject. This is an arithmetic reachability question, and the answer is that
it is not reachable by exhaustion. One probe per `ping_interval` per generation, with at most one
outstanding (`:1384-1391`), means 2^64 probes on a single unbroken generation. At the shortest
interval the config validator admits — `ping_interval` must be nonzero (`config.rs:371-374`) — this
remains far beyond any process lifetime.

The path depends on a configured liveness policy: `connection.rs:291` gates the liveness task on `if
let Some(policy) = shared.liveness.clone()`, and the default is `liveness: None` (`config.rs:296`).
No in-tree production caller sets it; the only `liveness: Some(..)` in `crates/mc-host/src/` is at
`config.rs:664`, inside the `#[cfg(test)]` module beginning at `:469`.

The record's value is therefore contractual rather than operational: a documented MUST with an
enforced ingress half and an unimplemented egress half, and the wire protocol names the gap itself.

## What a test must construct

Exhaustion cannot be driven. What can be tested is the boundary behaviour, by seeding the counter
rather than reaching it: construct a `GenerationCore` with `next_ping_corr` initialized to
`u64::MAX`, run one probe cycle, and assert the observable contract — either that the generation
retires without emitting, or, pinning today's behaviour, that a correlation-0 Ping is emitted and
that the host closes the generation when it is echoed. The four in-file constructors that already set
`next_ping_corr` (`connection.rs:255`, `:1527`, `:1632`, `routing.rs:502`) show the seam is
reachable from test code.

A second, cheaper check is a source-level assertion that no allocator in the egress path uses
unchecked `fetch_add` for a correlation. That is the form that would fail today.

No test covers either. There is no test that seeds `next_ping_corr`, and no test that sends a
correlation-0 Pong.

## Investigation log

### Q: Does anything between the allocator and the socket reject a zero correlation, so that wrap is caught before emission?

- Sources examined: `crates/mc-host/src/connection.rs:1399`, `:1412-1418`;
  `crates/mc-host/src/wire.rs:517-523` (`FrameId::control`), `:571-596` (`encode_owned_frame`).
- Findings: nothing rejects it. `FrameId::control` performs no validation, and `encode_owned_frame`
  validates only `body.len()` against `MAX_BODY_LEN` (`:577-581`) before copying `id.corr` into the
  header at `:591`. The header-only Ping has an empty body, so the encode is infallible and the
  `.expect` at `connection.rs:1418` never fires.
- Missing evidence: none.
- Conclusion: resolved with answer. A wrapped correlation reaches the wire. The only check is the
  host's own ingress guard at `:501-502`, which fires on the peer's echo rather than on the emission.

### Q: Is the seed 1 on every path, so the first probe never uses correlation 0 for an ordinary reason?

- Sources examined: `grep -rn "next_ping_corr"` across `crates/mc-host/src/`.
- Findings: five hits. The declaration at `connection.rs:121`; the `fetch_add` at `:1399`; and four
  initializations, all `AtomicU64::new(1)` — `connection.rs:255`, `:1527`, `:1632`, and
  `routing.rs:502`. No path seeds 0.
- Missing evidence: none.
- Conclusion: resolved with answer. Correlation 0 is reachable only by wrap, which confirms the
  record is about exhaustion and not about an off-by-one at generation start.
