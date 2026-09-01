# client-a-a-clean-host-close-and-a-transport-failure-share-one-code

## Discovery trigger

The task prompt predicted this: "Establish what the **client** concludes from a
clean close, and whether it can distinguish a healthy shutdown from a transport
failure. If it cannot, that is a significant finding, because the host's
diagnostics are also unhelpful there." It cannot.

## Evidence trail

The client's inbound path has two hops. The bridge thread owns the ring endpoint
and forwards decoded frames over a Tokio channel; `ring_reader_loop` consumes
that channel.

The bridge thread's loop (`client.rs:1866-1889`) has five exits:

```
1866:            while !cancel.is_cancelled() {          <- exit 1, cancellation
1867:                match write_rx.try_recv() {
1868:                    Ok(write) => {
1869:                        let result = decode_outbound(&write.bytes)
1870:                            .and_then(|(header, body)| endpoint.send(header, body).map_err(|_| ()));
1871:                        let failed = result.is_err();
1872:                        let _ = write.completed.send(result);
1873:                        if failed {
1874:                            break;                   <- exit 2, ring send failed
1875:                        }
1876:                    }
1877:                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break,   <- exit 3
1878:                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
1879:                }
1880:                match endpoint.try_recv_with(|bytes| read_budget.charge(bytes)) {
1881:                    Ok(Some(frame)) => {
1882:                        if read_tx.blocking_send(frame).is_err() {
1883:                            break;                   <- exit 4, reader gone
1884:                        }
1885:                    }
1886:                    Ok(None) => std::thread::sleep(Duration::from_micros(50)),
1887:                    Err(_) => break,                 <- exit 5, ring receive failed
1888:                }
1889:            }
```

Note the line numbering: the `break` for exit 2 is at `:1874`, exit 3 at `:1877`,
exit 4 at `:1883`, exit 5 at `:1887`. All five drop `read_tx` when the thread
returns after `:1893`.

The reader has exactly one handler for that closure:

```
1976: async fn ring_reader_loop(inner: Arc<Inner>, mut read: RingFrameReceiver) {
1977:     while let Some((header, body, charge)) = read.recv().await {
1978:         if validate_inbound(&header).is_err() || body.len() != header.len as usize {
1979:             inner.retire("protocol_violation");
1980:             return;
1981:         }
1982:         inner.dispatch(header, body, charge);
1983:         if inner.retired.load(Ordering::Acquire) {
1984:             return;
1985:         }
1986:     }
1987:     inner.retire("eof");
1988: }
```

`:1987` is the only site that observes channel closure, and it passes a literal.

A host that exits cleanly without emitting a channel-0 `Goodbye` produces the
same observable: its ring stops yielding frames, then the mapping goes away, so
`try_recv_with` returns `Err` at exit 5 and the client retires with `eof`. A host
whose ring publication failed produces exit 5 as well.

## Failure scenario

Part 2b's `ring-a-publish-failure-is-reported-as-a-clean-peer-close` established
that when the host cannot publish, it reports the condition to the peer as a clean
close rather than as a fault. Part 2b's
`ring-a-ring-unavailability-fails-closed-without-a-classified-reason` established
the host reports itself healthy in that state.

So the sequence is: the host's ring publication fails; the host closes cleanly and
reports healthy; the client's `try_recv_with` errors; the client retires with
`eof`; the client's caller sees `eof` and cannot tell it apart from an ordinary
host reload. Neither side holds a diagnosis. A recovery policy that should back
off on transport faults and reconnect immediately on a reload has nothing to
branch on.

## Timing windows and dependencies

No timing window. This is a static property: one code path, one literal.

Depends on Part 2b for the host-side half. Depends on
`client-a-a-retired-generation-forgets-why-it-retired` for the compounding
effect: even the transient `eof` is visible only to a caller pending at that
instant.

The one case the client *does* separate is an inbound channel-0 `Goodbye`, which
`dispatch` handles at `:1397` with `retire("connection_goodbye")`. That is a
distinct code, so a host that follows the doc's graceful-shutdown step 4 is
distinguishable. The failure is confined to hosts that do not reach that step.

## What a test must construct

Two runs against a controllable peer, each with one pending request so the code
is observable at all:

1. Run A: peer completes its drain and closes its ring without emitting a
   channel-0 `Goodbye`. Assert the pending caller's `CallError::code() == "eof"`.
2. Run B: peer's ring is made to fail `try_receive`, driving exit 5. Assert the
   pending caller's `CallError::code() == "eof"`.
3. Assert the two codes are equal, which is the property, and separately assert
   that a run C emitting a channel-0 `Goodbye` yields `connection_goodbye`, which
   establishes the client is not simply blind to all causes.

The bridge thread is constructed only by `start_ring_bridge` (`:1842`), which
requires a real descriptor and two file descriptors, so this needs an integration
harness rather than the inline `test_inner` fixture.

## Investigation log

### Q: Does a healthy host reach graceful-shutdown step 4 before its ring closes?

- Sources examined: `docs/mc-host-wire-protocol.md` section 12 shutdown ordering,
  which places "send best-effort connection Goodbye" at step 4 and "ring mappings
  and setup sockets close as their owning tasks exit (no later than this step)"
  at step 8; `client.rs:1397`; `connection.rs:186-210`.
- Findings: the doc's ordering, if honoured, gives the client
  `connection_goodbye` on every graceful host shutdown, which would confine `eof`
  to genuine faults and abrupt exits. The word "best-effort" in step 4 is what
  makes it unreliable, and the doc does not say what happens when the best effort
  fails.
- Missing evidence: whether the host's implementation actually emits it, and
  whether it can lose the race with its own ring teardown. That is 2a and 2b
  territory and I did not read `lifecycle.rs`.
- Conclusion: unresolved, needs a host-side trace. If the answer is that the
  Goodbye is reliable, this record's impact drops from significant to
  fault-path-only, though the merge of exits 2 through 5 into one code remains.

### Q: Are the four fault exits themselves worth separating?

- Sources examined: all five break sites, `RingClientEndpoint::send`
  (`ring_transport.rs:659-673`), `try_recv_with` (`:694-711`).
- Findings: exits 2 and 5 are ring faults on opposite directions. Exit 3 means the
  writer task dropped its sender, which follows `writer_loop` returning. Exit 4
  means the reader task is gone. Exits 3 and 4 are consequences of local teardown,
  so collapsing them with `eof` is defensible. Exits 2 and 5 are the ones that
  carry real diagnostic value and are currently indistinguishable from a clean
  host exit.
- Missing evidence: none.
- Conclusion: resolved with answer. The defect is specific to exits 2 and 5, and a
  fix could pass a distinct code from the bridge thread to the reader through a
  side channel rather than widening `eof`.
