# a-setup-pong-is-required-and-forbidden-in-the-same-window

## Discovery trigger

The task prompt named this contradiction and asked for it to be catalogued without
resolution. Verifying it produced a sharper statement than the prompt's: it is not
only that the `Pong` handler lacks a readiness gate, it is that the host's own
liveness loop starts *before* the read loop is first polled, so the host can
solicit a Pong in the same window the document says an arriving Pong must retire
the generation.

METHOD rule 3 applies directly: the document establishes the obligation, never the
satisfaction. Both sides are cited below and neither is chosen.

## Evidence trail

The document's side, `docs/mc-host-wire-protocol.md:562`:

> A first application request, routed request, other control operation, `Cancel`,
> `Pong`, or `Goodbye` retires the setup generation without dispatch or
> same-generation TCP continuation.

`Pong` is named explicitly, in a list whose other six members are all gated in
code. Section 7.7's opening sentence (`:560`) is the general rule the list
instantiates: no traffic until a selection commits.

The code's side, `crates/mc-host/src/connection.rs:500-540`. The arm's only
validation is the shape check at `:501`:

```rust
FrameType::Pong => {
    if header.channel != 0 || header.corr == 0 {
        return ReadExit::Peer;
    }
```

Then `Instant::now()` at `:504`, the `pings` lock at `:505`, the correlation lookup
at `:506`, the flags-equality check at `:511`, and the two `written_at` branches at
`:518-536`. An unmatched correlation falls through `_ => {}` at `:538` and the read
loop continues. There is no `transport_ready` call anywhere in the arm, and
`transport_ready`'s four call sites (`:430`, `:483`, `:495`, `:552`) confirm the
omission is specific to `Pong`.

The aggravating half, `connection.rs:291-302`. `serve_generation` spawns
`liveness_loop` immediately after inserting the generation into the connection
registry, and the read task is only awaited afterwards at `:304`:

```rust
if let Some(policy) = shared.liveness.clone() {
    let stop = gen.read_cancel.child_token();
    ...
}

let read_exit = read_task.await;
```

`liveness_loop` (`:1345` onward) reads `policy.ping_interval` and the `pings` map;
nothing in it consults `setup.state`, and it has no access to the
`ConnectionSetup`, which lives on the read loop's stack frame (`:268`, `:386`).

Independent confirmation that bootstrap probing is intended rather than
accidental, `connection.rs:1023-1031`. The grant path stops and joins bootstrap
liveness before publishing a selection, and explains that the stop must happen
before the preparation wait because that wait blocks the sole read loop and "a
`prepare` slower than `ping_interval + pong_deadline` would otherwise leave a
timely Pong unread and let liveness invalidate a healthy generation". That comment
only makes sense if bootstrap Pings are live during setup.

Note what the grant path does and does not fix: it stops probing at `:1032-1036`,
which is *after* a bootstrap Ping may already have been sent, and it exists only on
the grant path. A generation that negotiates plain TCP never stops liveness at all;
it simply becomes ready at `:960`.

## Failure scenario

Two mutually exclusive readings, both defensible, and the code implements neither
cleanly.

Under the document's reading (`Pong` retires setup), the code is wrong twice: it
accepts a `Pong` that should retire, and worse, with liveness configured the host
solicits exactly that frame. A conforming client that answers a host Ping before
negotiating would be retiring its own generation if the host implemented the
document, and a conforming host that implemented the document would kill every
generation whose client answers a bootstrap Ping.

Under the code's reading (`Pong` is transport-agnostic liveness and is exempt), the
document's `:562` list is simply wrong and should not name `Pong`. A client author
implementing the document would refuse to answer bootstrap Pings, and with
`invalidate_on_missed` set the host would then invalidate a healthy generation for
protocol compliance.

The default configuration hides all of this, which is why it survived: with
`liveness: None` no Ping is ever sent, so the only observable difference is that an
unsolicited `Pong` before negotiation is ignored instead of retiring the
generation. That weaker claim is default-production and no test covers it.

## Timing windows and dependencies

The record is a window. It opens when `liveness_loop` is spawned at `:296` and
closes when the state commits at `:960` (TCP) or `:1103` (candidate). Its width is
`policy.ping_interval` against the client's time-to-negotiate:

- Fast client: negotiates within microseconds of authenticating, never sees a
  bootstrap Ping, window never materializes.
- Slow or paused client: authenticates, stalls past `ping_interval`, receives a
  Ping while the state is still `BootstrapTcp`.

There is no setup deadline protecting the bootstrap before a grant. The
`transport_setup_deadline` is created inside `grant_candidate` at `:1022`, after a
serveable offer is chosen, so a client that authenticates and never negotiates is
bounded only by liveness (when configured) or not at all.

Enabling configuration: `liveness: Some(..)`, which is not shipped in this tree.
`HostConfig::default` sets `liveness: None` at `config.rs:296`, and the only
`Some(LivenessPolicy { .. })` in the crate is inside the `#[cfg(test)]` module at
`config.rs:664`. That is the same reachability fact the portfolio evaluation
corrected for the other liveness records, and it is re-verified here rather than
inherited.

## What a test must construct

The check is situation coverage, marker `SETUP_PONG_WINDOW_OBSERVED`, and it must
assert the window rather than either resolution.

1. A host configured with `liveness: Some(LivenessPolicy { ping_interval: short,
   pong_deadline: generous, invalidate_on_missed: false })`.
2. A raw client that authenticates through `setup_client`
   (`tests/support/mod.rs:688`) and then does **not** negotiate.
3. Wait past `ping_interval` and read a `Ping` frame from the socket. Record that
   the setup state was still `BootstrapTcp` when it arrived. Since the state is
   read-loop-local, the available proxies are that no negotiate response has been
   sent and that no negotiate request was ever sent by the client.
4. Answer with a matching `Pong` and record the outcome: the generation survives
   under the code's reading, retires under the document's.

Deliberately not asserted: which outcome is correct. The test's value is producing
a real trace for the decision. Once decided, it converts into an `always` check in
one direction or the other.

A second, cheaper test covers the default-production half with no configuration:
authenticate, send an unsolicited `Pong` with channel 0 and a nonzero correlation,
and record whether the connection survives. Today it survives.

## Investigation log

### Q: Should the document drop `Pong` from `:562`, or should probing be deferred until a selection commits?

- Sources examined: `docs/mc-host-wire-protocol.md:560-562` and `:651`;
  `connection.rs:500-540`, `:291-302`, `:1023-1036`, `:1345` onward;
  `config.rs:296` and `:664`.
- Findings: the code's behaviour is internally coherent and deliberate. The grant
  path's KTD4 comment explicitly reasons about bootstrap Pings being in flight,
  and the `Pong` arm's own doc comment (`:56-74`) treats liveness as a
  transport-level concern with no reference to setup state. That is circumstantial
  evidence the code's reading is intended and the document's list is stale, but it
  is not a decision: nothing in the tree states that `Pong` was deliberately
  exempted from `:562`, and the document is the normative artifact.
- Missing evidence: no changelog, plan, or comment that mentions the `:562` list.
  No client-side implementation in this tree refuses to answer bootstrap Pings,
  which would have been evidence for the document's reading.
- Conclusion: needs human input. Recorded as a contradiction with both sides
  cited; the check asserts only that the window occurs.

### Q: If probing is deferred, what bounds a client that authenticates and never negotiates?

- Sources examined: `connection.rs:142-196` (`run_connection`), `:1022` (the setup
  deadline's construction point), `auth.rs` deadline usage at `:153`.
- Findings: the authentication deadline (`shared.timing.auth_deadline`, `:153`)
  covers only the handshake. `transport_setup_deadline` is instantiated inside
  `grant_candidate` at `:1022`, so it never applies to a bootstrap that has not
  yet chosen an offer. The authenticated connection permit is held for the whole
  setup (`:136-138`), so an idle un-negotiated connection consumes a
  `max_connections` slot indefinitely.
- Missing evidence: whether that is accepted, or whether liveness is the intended
  bound and therefore cannot be deferred.
- Conclusion: unresolved, needs the answer to the first question. Carried as the
  record's second open question because deferring probing would remove the only
  bound this path has.
