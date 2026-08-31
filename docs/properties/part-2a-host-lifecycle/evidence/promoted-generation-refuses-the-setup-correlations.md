# promoted-generation-refuses-the-setup-correlations

## Discovery trigger

`ConnectionSetup` has two constructors that differ in one field. The ordinary path seeds
`initial_watermark: 0` (`connection.rs:805`); the promoted path seeds `initial_watermark:
COMMIT_CORRELATION` (`:815`). That single constant is the entire mechanism preventing a promoted
client from re-driving `transport.activate` and `transport.commit` from application traffic. Nothing
downstream re-derives it, so a wrong value would be silent.

## Evidence trail

The two constructors sit adjacent in `crates/mc-host/src/connection.rs`:

- `:805` `initial_watermark: 0,` for the default setup.
- `:810-818` `provider_active()`, whose doc comment states the reasoning — "Correlations 1 and 2
  were consumed by activation and commit, so the first application request on a promoted candidate
  is 3 (§7.7.4)" — and whose body is `initial_watermark: COMMIT_CORRELATION` at `:815`.

The constants are in `crates/mc-host/src/transport_negotiation.rs`: `ACTIVATION_CORRELATION: u64 =
1` (`:36`), `COMMIT_CORRELATION: u64 = 2` (`:38`), `FIRST_APPLICATION_CORRELATION: u64 = 3` (`:40`).
`docs/mc-host-wire-protocol.md:623-645` matches: candidate request correlation 1 carries
`transport.activate` (`:627-635`), correlation 2 carries `transport.commit` (`:637-645`).

The seed reaches the read loop at `connection.rs:391`, `let mut watermark: u64 =
setup.initial_watermark;`, and is enforced by the guard at `:469-472`, `if header.corr <= watermark
{ return ReadExit::Peer; }`. With the seed at 2, correlations 1 and 2 are both `<= watermark` and
close the generation.

`provider_active()` has exactly one call site: `connection.rs:222`, inside the promotion arm at
`:207-224`. That arm `take()`s the promoted receiver from the candidate (`:205-208`) and hands it to
`serve_generation` (`:217-224`), so the promoted read loop inherits the candidate's inbound stream
rather than a fresh one.

## Failure scenario

The pipelining that makes this reachable is not incidental — it is designed in, and the design
comment says so. `connection.rs:1156-1161`, on the candidate commit path:

```
// Promotion is gated on this exact frame's local completion — not
// queue admission, not an aggregate flush (KTD4). The receiver is
// deliberately NOT polled while waiting: an un-promoted host never
// consumes candidate frames, so a request pipelined ahead of the
// commit response stays buffered and is observed only by the
// promoted generation, where every setup invariant already holds.
```

So a client that writes a correlation-1 or correlation-2 request immediately behind its commit
request has those frames buffered in the receiver, unread, until promotion; the promoted read loop
is the first and only reader. If the seed were `0`, or `ACTIVATION_CORRELATION`, or if
`provider_active()` were replaced by the default constructor, those frames would be accepted as
ordinary application requests. Correlation 1 would then reach `handle_control` as a fresh request,
and the activation and commit correlations would be replayable from application traffic on a
channel the client already owns.

## Timing windows and dependencies

There is no race. The window is a buffering window, and it is opened deliberately by the candidate
driver's refusal to poll (`:1156-1161`), then closed by the seed. The two halves are in different
functions: the driver awaits `written_rx` at `:1171` without touching the receiver, and the guard
that catches the consequence is at `:469-472`. The dependency chain is `COMMIT_CORRELATION` →
`provider_active()` (`:815`) → `serve_generation` (`:222`) → `setup.initial_watermark` (`:391`) →
the guard (`:469`). Four hops, one constant, no assertion at any hop.

This record shares its enforcement site with
`request-correlation-strictly-increases-per-generation`; that record covers the guard, this one
covers the seed.

## What a test must construct

A client that pipelines a correlation-1 or correlation-2 request behind its commit request, then
survives promotion, then observes the generation close before dispatch. The pipelining must be real
— written to the socket before the commit response completes — because a client that waits for the
commit response and then sends correlation 1 is testing a different thing.

`tests/transport_negotiation.rs:1268`
`application_frame_before_promotion_fails_setup_instead_of_dispatching` covers the pre-promotion
direction: it stalls a 16-byte transport buffer (`:1269-1271`) so the commit response is admitted
but short of completion, and asserts setup fails. That is the candidate-side refusal, not the
promoted-side watermark. Nothing drives a low-correlation request into a generation that has already
promoted, which is the case this record names.

## Investigation log

### Q: Is the promoted seed actually reached on the live promotion path, or only in tests?

- Sources examined: `grep -n "provider_active()"` across `crates/mc-host/src/`;
  `crates/mc-host/src/connection.rs:205-232`.
- Findings: two hits only — the definition at `:812` and one call site at `:222`. That call site is
  the `Some(receiver)` arm of the promotion match at `:207`, which is the production promotion path:
  it takes the promoted receiver, builds a generation at `:211-216`, and serves it at `:217-224`.
  The `None` arm at `:226-232` reaps an unpromoted candidate and never serves.
- Missing evidence: none.
- Conclusion: resolved with answer. The seed is on the live path, with exactly one call site.

### Q: Is the "setup driver stops polling the receiver" claim in the catalog supported, or inferred?

- Sources examined: `crates/mc-host/src/connection.rs:1150-1180`.
- Findings: supported verbatim by the source comment at `:1156-1161`, quoted above. The driver reads
  the commit request at `:1154`, decodes at `:1155`, sends the response at `:1163-1170`, then awaits
  `written_rx` at `:1171` — the receiver is not touched between `:1155` and the end of the exchange.
- Missing evidence: none.
- Conclusion: resolved with answer. The catalog's fault/timing angle is a restatement of the code's
  own stated design, not an inference.
