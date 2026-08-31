# setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable

## Discovery trigger

The re-scope document left this open at
`docs/properties/part-2-rescope/scope-map-and-risk-ranking.md:744-746`:
"`setup_socket.rs:355` is named `read_message_unbounded` and `:369` is named
`read_message`. Whether the first is a real missing bound or a bounded read under
a misleading name is unresolved; I did not read the bodies." This record reads the
bodies and resolves it.

## Evidence trail

All references at commit `e447c927`.

`crates/mc-host/src/setup_socket.rs:355-367`:

```
355: async fn read_message_unbounded<T: DeserializeOwned>(
356:     stream: &mut UnixStream,
357: ) -> Result<T, SetupError> {
358:     let mut len = [0u8; 4];
359:     stream.read_exact(&mut len).await?;
360:     let len = u32::from_le_bytes(len) as usize;
361:     if len > MAX_SETUP_MESSAGE_LEN {
362:         return Err(SetupError::MessageTooLarge);
363:     }
364:     let mut body = vec![0u8; len];
365:     stream.read_exact(&mut body).await?;
366:     serde_json::from_slice(&body).map_err(|_| SetupError::InvalidMessage)
367: }
```

Compare `read_message` at `:369-386`, which is byte-for-byte the same except that
both `read_exact` calls are wrapped in `timeout_at(deadline, ...)` at `:374-376`
and `:382-384`.

So the difference is exclusively the deadline. The length cap at `:361-363` is
identical in both and precedes the allocation at `:364`. `MAX_SETUP_MESSAGE_LEN`
is `16 * 1024` (`:24`). **The name means time-unbounded, not length-unbounded.**
The re-scope question is answered: it is a bounded read under a misleading name,
for one axis, and genuinely unbounded on the other.

Sole caller, `observe_peer` at `:345-353`:

```
345: pub async fn observe_peer(stream: &mut UnixStream) -> PeerClose {
346:     match read_message_unbounded(stream).await {
347:         Ok(ClientMessage::Goodbye) => PeerClose::Goodbye,
348:         Err(SetupError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
349:             PeerClose::UnexpectedEof
350:         }
351:         _ => PeerClose::ProtocolError,
352:     }
353: }
```

A total function over the read outcome into three classes. Every non-`Goodbye`,
non-EOF outcome, including `MessageTooLarge` and `InvalidMessage`, is
`ProtocolError`.

The time-unboundedness is bounded by cancellation instead, at
`crates/mc-host/src/connection.rs:196-206`:

```
196:        tokio::select! {
197:            biased;
198:            () = peer_read_cancel.cancelled() => {}
199:            close = crate::setup_socket::observe_peer(&mut stream) => {
200:                if close != crate::setup_socket::PeerClose::Goodbye {
201:                    peer_ring.record_peer_death();
202:                }
203:                peer_gen.token.cancel();
204:                peer_gen.read_cancel.cancel();
205:            }
206:        }
```

`biased` with `read_cancel` first, so cancellation wins a simultaneous readiness.
The whole thing is inside `gen.read_tasks.track_future(...)` (`:195`), so Part 2a's
read-task quiescence properties apply and should be cited rather than restated.

The three-class classification is contractually load-bearing:
`docs/mc-host-shm-transport.md:49` says clean `Goodbye` and unexpected
setup-socket closure are distinct, and that unexpected closure records peer death,
cancels ring work, and tears down the exact connection. The code matches at
`:200-204`.

## Failure scenario

Two shapes.

Cap removed. If `:361-363` were deleted or the comparison inverted, a post-commit
peer sends a length prefix of `0xFFFFFFFF` and the host allocates 4 GiB at `:364`.
That peer is authenticated, so this is a post-authentication denial rather than a
pre-authentication one, but it costs one `vec![0u8; len]` per connection and
`max_connections` defaults to 64. The allocation happens before any parse, so no
JSON validity is required.

Cancellation lost. If the `select!` lost its `biased` ordering, or `observe_peer`
were awaited directly, a peer that writes three of four length bytes and stops
parks `read_exact` at `:359` forever. The task is tracked in `read_tasks`, so
shutdown would join a future that never completes. Part 2a's
`read-task-quiescence-implies-no-further-registration` and
`draining-rendezvous-is-released-or-the-loss-is-declared` are the neighbouring
obligations, and this is exactly the input that would violate them.

The partial-prefix case is the sharp one. It is not an error and not an EOF; it is
a peer holding the read open with three bytes of legitimate-looking data. There is
no deadline to end it, by design.

## Timing windows and dependencies

Unbounded in duration by construction. The sentinel is meant to sit on the socket
for the whole life of an activated connection, which is why it has no deadline. Its
bound is cancellation, expressed in the units the code actually bounds: one
`CancellationToken`, not an interval.

Depends on `read_cancel` actually being fired on every teardown path. That is Part
2a's territory, specifically
`close-disposition-is-a-total-function-of-the-read-exit-cause` and
`no-task-outlives-the-generation-it-serves`, both of which should be cited.

Depends on the sentinel being the only reader of this stream after commit. It is:
`connection.rs:192-195` moves `stream` into the spawned future by `&mut`
capture, and nothing else reads it after `activate_server` returns.

## What a test must construct

Cap, at unit level with a `UnixStream::pair`:

1. write a 4-byte little-endian prefix of `u32::MAX` and nothing else;
2. call `observe_peer` and assert `PeerClose::ProtocolError`;
3. assert no allocation of that size occurred. A resident-set delta is the
   practical oracle; `crates/mc-host/tests/support/process_resources.rs`, used by
   `shm_failure_modes.rs`, already provides `ResourceCounts` for that kind of
   assertion.

Step 3 is what makes the test non-vacuous. Asserting only `ProtocolError` passes on
an implementation that allocated 4 GiB and then failed to fill it.

A boundary pair is worth pinning at the same time: a prefix of exactly
`MAX_SETUP_MESSAGE_LEN` followed by that many bytes of valid `Goodbye`-padded JSON
must be accepted, and `MAX_SETUP_MESSAGE_LEN + 1` must be `MessageTooLarge`. That
converts the cap from "some limit exists" into a pinned edge.

Cancellation, at integration level:

4. complete a full setup so the sentinel is running;
5. write three bytes of a length prefix and stop;
6. shut the host down gracefully and assert the shutdown completes within its
   bound, proving the sentinel yielded to `read_cancel` rather than parking.

Step 6's bound must be stated in the units the code bounds. The sentinel has no
interval, so the assertion is on the shutdown sequence's own deadline, not on a
generous timeout.

## Investigation log

### Q: Is `read_message_unbounded` length-unbounded, as its name suggests?

- Sources examined: `setup_socket.rs:355-367` against `:369-386`, and
  `:388-416` (`read_message_from_prefix`) for a third comparison.
- Findings: no. All three cap at `MAX_SETUP_MESSAGE_LEN` before allocating:
  `:361-363`, `:378-380`, `:401-403`. `read_message_from_prefix` additionally
  computes `4usize.checked_add(len)` at `:404` and rejects a prefix longer than the
  computed total at `:405-407`. The only difference between the three is the
  deadline treatment.
- Missing evidence: none.
- Conclusion: resolved. The re-scope document's open question at
  `part-2-rescope/scope-map-and-risk-ranking.md:744-746` is answered: length is
  bounded in all three, and only `read_message_unbounded` lacks a deadline. The
  name is the hazard.

### Q: Is the missing deadline correct?

- Sources examined: `connection.rs:190-206`, `setup_socket.rs:345-353`,
  `docs/mc-host-shm-transport.md:45`, `:49`.
- Findings: yes. The doc says the setup socket is kept open as the peer-lifetime
  sentinel (`:45`), so a deadline would manufacture a false peer death on any idle
  connection. The correct bound for an intentionally-idle read is cancellation, and
  that is what the `biased` `select!` provides.
- Missing evidence: none.
- Conclusion: resolved. The behaviour is right; the name invites the wrong
  conclusion and already caused one. Recorded as the record's open question.

### Q: Does `observe_peer` classify every outcome?

- Sources examined: `setup_socket.rs:345-353`, `:88-98` (`SetupError` variants),
  `:80-85` (`PeerClose`).
- Findings: total. `SetupError` has nine variants; `Goodbye` maps from one `Ok`
  shape, `UnexpectedEof` from one specific `Io` kind, and the `_` arm absorbs the
  remaining eight variants plus every other `Ok` variant. `ClientMessage::Activate`
  or `Commit` arriving post-commit therefore yields `ProtocolError`, which
  `setup_socket.rs:599-651` asserts at `:647-650`.
- Missing evidence: none.
- Conclusion: resolved. Totality holds and is partially tested.
