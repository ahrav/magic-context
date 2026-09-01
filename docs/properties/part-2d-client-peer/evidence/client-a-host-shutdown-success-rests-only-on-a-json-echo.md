# client-a-host-shutdown-success-rests-only-on-a-json-echo

## Discovery trigger

The task prompt asked for a specific shape: "A sibling part found a producer that
advanced a durable checkpoint on an acknowledgement that was truthful about nothing;
check for that shape here." `host_shutdown` is it.

## Evidence trail

The whole method:

```
575:    /// The host commits the stop only after the complete `host.shutdown` response frame reaches the socket, so `Ok` here is the stop linearization point the native lifecycle owner waits on; the connection itself stays open.
576:    pub async fn host_shutdown(&self) -> Result<(), CallError> {
577:        if self.inner.closed.load(Ordering::Acquire) {
578:            return Err(CallError::local(
579:                SendOutcome::NotSent,
580:                "client_closed",
581:                "client is closed",
582:            ));
583:        }
584:        let body = br#"{"op":"host.shutdown"}"#.to_vec();
585:        let deadline = Instant::now() + CLIENT_SHUTDOWN_TIMEOUT;
586:        let response = self
587:            .inner
588:            .unary(
589:                RouteHandle {
590:                    channel: 0,
591:                    epoch: 0,
592:                },
593:                body,
594:                deadline,
595:                None,
596:            )
597:            .await?;
598:        let acknowledged = serde_json::from_slice::<serde_json::Value>(&response.body)
599:            .ok()
600:            .and_then(|value| {
601:                value
602:                    .get("op")
603:                    .and_then(serde_json::Value::as_str)
604:                    .map(|op| op == "host.shutdown")
605:            })
606:            .unwrap_or(false);
607:        if !acknowledged {
608:            return Err(CallError::local(
609:                SendOutcome::Terminal,
610:                "invalid_shutdown_response",
611:                "host.shutdown response did not echo the operation",
612:            ));
613:        }
614:        Ok(())
615:    }
```

The acceptance predicate is `:598-606`: the body parses as JSON and its `op` member
is the string `"host.shutdown"`. Nothing else is consulted. No sequence number, no
daemon identity, no phase, no nonce. The `daemon_id` the client holds from
authentication (`:388`, accessor at `:435`) is not compared against anything in the
response.

The `Ok` is load-bearing. The doc comment at `:575` declares it "the stop
linearization point the native lifecycle owner waits on", so a downstream owner is
expected to treat it as proof the daemon stopped. That is a stronger claim than the
predicate supports: the predicate proves only that something on the other end of the
ring echoed a five-word JSON object.

Contrast `host_status` immediately below, which is stricter for a far less
consequential answer:

```
620:        #[derive(serde::Deserialize)]
621:        #[serde(deny_unknown_fields)]
622:        struct WireStatus {
623:            op: String,
624:            health: String,
625:            metrics: serde_json::Value,
626:        }
...
655:        if decoded.op != "host.status"
656:            || !matches!(decoded.health.as_str(), "ok" | "degraded" | "failing")
657:        {
```

`deny_unknown_fields` at `:621` plus an enumerated health value at `:656`. So the
file already knows how to validate a control response tightly, and the shutdown path
does not.

`unary`'s own `Terminal` classification does carry real information: reaching `:598`
at all means a matching `Response` frame arrived for that correlation, which
`validate_inbound` has confirmed is a channel-0 non-binary frame within
`MAX_CONTROL_BODY_LEN` (`:2015`, `:2029`). So the client knows *the host answered
this correlation*. What it does not know is whether the answer was truthful about the
stop.

## Failure scenario

A lifecycle owner wants to replace a running daemon. It calls `host_shutdown`, gets
`Ok(())`, and treats that as authority to start a replacement.

Suppose the host's control handler emits the response before its stop is committed,
or emits it and then fails to complete the drain, which
`docs/mc-host-wire-protocol.md` section 12 makes possible: its step 6 notes that on
the forced path "residual route-gone callbacks that themselves overran their deadline
may still be in flight beside it; that incarnation is already fatal". The client
cannot distinguish that from a clean stop.

The owner starts a replacement daemon while the old one still holds the instance
lock and its connection file. Part 2a's instance and generation records cover what
the host does about that, and Part 2c established credentials do not survive an
incarnation, so the two daemons would not authenticate each other's clients. The
observable failure is a replacement that cannot acquire the lock, or two daemons
briefly live, depending on the host's lock discipline.

The client contributes exactly one thing to that outcome: an `Ok` it was not entitled
to return.

## Timing windows and dependencies

The window is between the host writing the response frame and the host actually
stopping, which is host-side and is what `:575` asserts is empty. This record does not
claim the assertion is false; it records that the client has no evidence for it and
would return `Ok` either way.

The 5-second `CLIENT_SHUTDOWN_TIMEOUT` (`:51`, `:585`) bounds the wait, which means a
host whose stop takes longer than 5 seconds produces a `deadline_expired` with
`OutcomeUnknown` from `stop_or_take_terminal` (`:1019-1028`). That is the correct
classification for that case, and it is the one path where the client is honest about
not knowing.

Note the connection deliberately stays open afterwards, per `:575`. So the client will
subsequently observe the host's ring close and retire with `eof`, which by
`client-a-a-clean-host-close-and-a-transport-failure-share-one-code` it cannot
distinguish from a transport failure. The shutdown it just requested and the fault it
cannot rule out look identical.

## What a test must construct

1. A fake peer that answers channel-0 `{"op":"host.shutdown"}` with
   `{"op":"host.shutdown"}` and then keeps serving.
2. Call `host_shutdown` and assert it returns `Ok(())`.
3. Then call `host_status` on the same client and assert it also succeeds. A host
   that answered a shutdown and still serves status did not stop, and the pair of
   assertions is the observable form of "the acknowledgement was truthful about
   nothing" without the test having to reach inside the peer.
4. Add the negative direction so the check is not vacuous: a peer answering
   `{"op":"host.status"}` must produce `invalid_shutdown_response`, and a peer
   answering non-JSON must too, which pins the predicate.
5. Do not assert anything about a replacement daemon. That effect is outside the
   client and belongs to whichever part owns the lifecycle owner.

## Investigation log

### Q: Does the host emit the response strictly after its stop is committed?

- Sources examined: the claim at `client.rs:575`;
  `docs/mc-host-wire-protocol.md` section 12's graceful shutdown ordering, whose
  step 3 emits terminals "while generations are still live" and whose step 4 sends
  the connection Goodbye after the drain.
- Findings: the doc's ordering places terminal emission at step 3, before route-gone
  callbacks at step 5, the handler shutdown callback at step 6, handler drop at step
  7, and instance lock release at step 9. So the doc's own ordering has the response
  leaving well before the stop is complete, which is the opposite of what `:575`
  claims, unless `host.shutdown`'s response is special-cased to be emitted last.
- Missing evidence: the host's `host.shutdown` control handler. That is `control.rs`
  or `dispatch.rs`, which sub-part 2e owns.
- Conclusion: unresolved, needs the 2e control-handler pass. This is the highest-value
  follow-up in this lens, because `:575` is an unusually strong claim carrying a
  `` waiver, and the doc's ordering appears to contradict it.

### Q: Does any caller treat the `Ok` as authority to launch a replacement?

- Sources examined: `grep` for `host_shutdown` across `crates`, which finds the
  definition and the `ck-mc-host` binary as the plausible consumer.
- Findings: `crates/mc-module/src/bin/ck-mc-host.rs` is described by its own manifest
  as "the production lifecycle/serve executable"
  (`crates/mc-module/Cargo.toml:18-19`) and contains an `authenticate` helper at
  `:447-468` used for phase gating, so it is clearly doing lifecycle transitions
  around connect and shutdown. I did not read its shutdown phase.
- Missing evidence: the binary's shutdown sequencing.
- Conclusion: unresolved, needs a mc-module pass. Sub-part 2d's scope is `client.rs`
  alone, and reading the binary would duplicate 2f or a later part.
