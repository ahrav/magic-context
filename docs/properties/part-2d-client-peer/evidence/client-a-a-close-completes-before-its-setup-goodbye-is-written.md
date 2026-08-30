# client-a-a-close-completes-before-its-setup-goodbye-is-written

## Discovery trigger

Task 5 asked what reaps client-side resources. `join_tasks_until` reaps two Tokio
tasks. Nothing reaps the OS thread that owns the setup socket, and that thread is
the one that emits the departure signal.

## Evidence trail

`close` cancels and then joins:

```
711:            self.inner.cancel.cancel();
712:        }
713:        if !self.inner.join_tasks_until(deadline).await {
714:            result = Err(ClientError::new(
715:                "shutdown_timeout",
716:                "client shutdown timed out",
717:            ));
718:        }
719:        guard.disarm();
720:        result
```

`join_tasks_until` iterates a two-element array:

```
1682:        for slot in [&self.writer, &self.reader] {
1683:            let Some(mut task) = slot.lock().await.take() else {
1684:                continue;
1685:            };
1686:            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
```

`writer` and `reader` are the only `JoinHandle` fields on `Inner`
(`client.rs:958-959`). The bridge thread's handle is discarded at the spawn site:

```
1852:    std::thread::Builder::new()
1853:        .name("mc-host-ring-client".to_owned())
1854:        .spawn(move || {
...
1894:        })
1895:        .map_err(|_| ClientError::new("setup_failed", "shared-memory setup failed"))?;
```

The `Result<JoinHandle<()>, io::Error>` is consumed by `map_err` and then by `?`,
so the handle is dropped and the thread is detached.

The thread observes cancellation only at its loop condition (`:1866`), and each
iteration can spend a full in-flight ring write plus a 50-microsecond sleep
(`:1886`) before returning there. `RingClientEndpoint::send` bounds one write at a
hardcoded two seconds (`ring_transport.rs:663-667`), so the worst-case latency
between `cancel.cancel()` and the thread reaching `:1891` is that write plus one
sleep.

Meanwhile `close`'s remaining work after `:711` is joining two tasks that are both
waiting on the same cancellation token, so they complete promptly. There is
nothing in `close` that waits on the thread.

## Failure scenario

A caller invokes `close()`, gets `Ok(())`, and the process exits, or the caller is
a short-lived CLI invocation. The bridge thread is still inside its loop body. The
process teardown destroys it before `:1891` runs, so no setup-socket `Goodbye` is
written and the socket closes as an EOF.

The host's watcher sees `PeerClose::UnexpectedEof` (`setup_socket.rs:349`) and
calls `record_peer_death()` (`connection.rs:201`) for a client that shut down
correctly and even sent its frame-level connection `Goodbye` at
`client.rs:702`.

A second, purely local variant needs no process exit at all. In `close`, the
per-route `Goodbye` loop breaks on the first failure:

```
690:                    .is_err()
691:                {
692:                    result = Err(ClientError::new(
693:                        "shutdown_timeout",
694:                        "client shutdown timed out",
695:                    ));
696:                    break;
697:                }
```

and the connection `Goodbye` at `:699-710` is guarded by `result.is_ok()`, while
`cancel.cancel()` at `:711` runs regardless. So a client whose route teardown
timed out cancels its writer without ever sending the connection `Goodbye`, and
the host's only remaining signal is the setup socket, whose message depends on the
race above.

## Timing windows and dependencies

The window opens at `client.rs:711` and closes when the bridge thread reaches
`:1891`. Its width is bounded by one ring write plus one 50-microsecond sleep, so
it is small but not vanishing, and process exit does not wait for it at all.

Inverse of `client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye`.
One design decision resolves both: hold the thread's `JoinHandle` on `Inner` and
join it under the same 5-second budget, and make the goodbye conditional on the
exit reason.

## What a test must construct

Per METHOD's coverage-check rule this must assert independent preconditions, never
the misclassification, so it still fires on a correct implementation:

1. Marker `client_close_returned_ok`: `close()` returned with
   `within_deadline == true`.
2. Marker `client_bridge_still_in_loop`: sampled at the moment marker 1 fired, the
   bridge thread had not yet executed `:1891`. A test-visible counter incremented
   at `:1890` and read after `close` returns is enough.

Both markers firing in the same run witnesses the window. Neither asserts that the
host misclassified anything, so the check is valid against a fixed implementation
too.

Names must be constant and globally unique, as METHOD requires; do not derive them
from a connection id.

For the local variant, additionally force the per-route `Goodbye` at `:688` to
fail so `:696` breaks, then assert `cancel` was cancelled and no connection
`Goodbye` reached the writer channel.

## Investigation log

### Q: Should `Inner` hold the bridge thread's `JoinHandle`?

- Sources examined: `client.rs:1842-1901`, `:934-960`, `:1677-1695`, `:671-721`.
- Findings: mechanically straightforward. `start_ring_bridge` already returns a
  `Result`, so returning the handle alongside the two channels is a signature
  change confined to `connect_info` (`:378-384`). `join_tasks_until` cannot await
  an OS thread handle directly, so the join would need `spawn_blocking` or a
  completion oneshot signalled at `:1893`. The 5-second shutdown budget is already
  shared with route teardown, and the thread's own exit latency is bounded by one
  two-second ring write, so adding it could consume 40 percent of the budget in
  the worst case.
- Missing evidence: whether any caller depends on `close()` returning quickly.
- Conclusion: needs human input. A completion oneshot signalled at `:1893` and
  awaited under the existing deadline is the cheapest correct shape, but it changes
  the shutdown latency distribution.

### Q: Is the local variant reachable, or does the route loop never fail?

- Sources examined: `send_control_wait` (`:1366-1384`), `send_control`
  (`:1319-1364`), `close` (`:671-721`).
- Findings: `send_control_wait` returns `Err` on three paths: a `send_control`
  failure mapped to `control_capacity_exhausted` (`:1374-1379`), a
  `timeout_at` expiry mapped to `shutdown_timeout` (`:1382`), and a dropped ack
  sender mapped to `connection_retired` (`:1383`). The third is reachable whenever
  the writer breaks out of its loop while a control frame is queued, which
  `writer_loop`'s cancellation exit at `:1928` does. So a close racing an
  already-cancelled writer takes the break at `:696`.
- Missing evidence: none.
- Conclusion: resolved with answer. The local variant is reachable without any
  injected fault, through a close that races a concurrent retirement.
