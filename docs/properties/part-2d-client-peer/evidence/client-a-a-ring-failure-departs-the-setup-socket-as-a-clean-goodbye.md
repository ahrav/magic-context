# client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye

## Discovery trigger

Sub-part 2d's third attention focus asked about "teardown ordering around
`encoded_goodbye` (`:1890`) and whether a client exit is distinguishable from a
crash by the host's `observe_peer`." Reading the post-loop block showed the
signal is unconditional, so the answer is that it is not distinguishable, and the
direction of the error is the surprising part.

## Evidence trail

The bridge thread's post-loop block sits outside every `break`:

```
1889:            }
1890:            if let Ok(goodbye) = crate::setup_socket::encoded_goodbye() {
1891:                let _ = setup.write_all(&goodbye);
1892:            }
1893:            let _ = setup.shutdown(std::net::Shutdown::Both);
1894:        })
```

The loop it follows begins at `:1866` and has four `break`s, at `:1874` (ring
send failed), `:1877` (write channel disconnected), `:1883` (inbound receiver
gone), and `:1887` (ring receive failed), plus the cancellation exit at the
`while` condition itself. Every one of them falls through to `:1890`.

`encoded_goodbye` is the setup-socket message, not a wire frame:
`setup_socket.rs:340-342` returns `encode_message(&ClientMessage::Goodbye)`, and
`ClientMessage::Goodbye` is the variant at `setup_socket.rs:70`.

The host reads that socket in a tracked task:

```
connection.rs:199:            close = crate::setup_socket::observe_peer(&mut stream) => {
connection.rs:200:                if close != crate::setup_socket::PeerClose::Goodbye {
connection.rs:201:                    peer_ring.record_peer_death();
connection.rs:202:                }
connection.rs:203:                peer_gen.token.cancel();
connection.rs:204:                peer_gen.read_cancel.cancel();
connection.rs:205:            }
```

`observe_peer` (`setup_socket.rs:345-352`) maps a received
`ClientMessage::Goodbye` to `PeerClose::Goodbye` (`:347`), an EOF to
`PeerClose::UnexpectedEof` (`:349`), and anything else to
`PeerClose::ProtocolError` (`:351`).

So `record_peer_death` fires only for the EOF and protocol-error cases. A client
whose ring collapsed still sends `Goodbye`, so it never fires.

## Failure scenario

A client's ring receive path fails: a geometry fault, a lease-release failure, or
any of the conditions Part 1's transport records cover. `try_recv_with` returns
`Err`, the bridge breaks at `:1887`, and the thread writes a setup-socket
`Goodbye` before shutting the socket down.

The host's watcher receives `PeerClose::Goodbye`, skips `record_peer_death`, and
cancels the generation. The host's ring diagnostics record an orderly peer
departure. Part 2b already established the host reports itself healthy on ring
unavailability, so the fault leaves no trace on either side: the client retires
with `eof` and discards the cause, and the host counts a well-behaved goodbye.

At fleet scale a systematic ring fault presents as a population of clients
politely disconnecting.

## Timing windows and dependencies

No window for the write itself; the block is unconditional. The consequence is
purely a classification error on the host.

This record and `client-a-a-close-completes-before-its-setup-goodbye-is-written`
are inverses. Here a fault looks clean. There a clean close looks like a fault,
because the owner can return before the thread reaches `:1891`. Both stem from
the same design: the departure signal is emitted by a detached thread on a path
that does not know why it is running.

Depends on Part 2c's establishment that the setup socket carries the
`ClientMessage` protocol and that row 9 of its handshake table admits exactly
`Goodbye`, `UnexpectedEof`, and `ProtocolError`.

## What a test must construct

1. Bring up a real host and client through `Client::connect`, so the bridge thread
   exists with a live setup socket.
2. Force the ring receive path to fail. The cheapest lever is to make
   `from_host.try_receive` return `Err`, which `try_recv_with`
   (`ring_transport.rs:696-698`) maps straight to `RingClientError`. A failpoint
   or a corrupted grant would do it.
3. On the host side, observe whether `record_peer_death` was called. Assert it was
   not, which is the property, and assert independently that the client did retire
   with `eof`, which establishes the client knew something was wrong.
4. The pair is required. Asserting only the host side would be consistent with a
   client that never failed at all.

## Investigation log

### Q: Should the bridge suppress the goodbye on its failure breaks?

- Sources examined: `client.rs:1866-1893`, `setup_socket.rs:340-352`,
  `connection.rs:195-206`.
- Findings: suppressing it is a two-line change: set a flag on the fault breaks
  and skip `:1890-1892`, leaving `shutdown(Both)` to produce an EOF. The host
  would then record `PeerClose::UnexpectedEof` and fire `record_peer_death`, which
  is the honest signal. The cost is that a fault and a hard crash become
  indistinguishable from each other, which is a smaller loss than a fault and a
  clean exit being indistinguishable.
- Missing evidence: whether `record_peer_death` feeds an alarm whose sensitivity
  would change materially. That is a 2b or operational question.
- Conclusion: needs human input. The mechanism is clear and cheap; whether the
  host wants the extra peer-death signal is not mine to decide.

### Q: Does the frame-level connection Goodbye give the host a second signal?

- Sources examined: `client.rs:699-710` (the connection `Goodbye` in `close`),
  `client.rs:1397` (inbound channel-0 `Goodbye` handling), `connection.rs:199`.
- Findings: yes in principle, and the two signals are independent: the frame-level
  Goodbye travels the ring, and the setup-socket Goodbye travels the socket. On a
  ring fault the frame-level one cannot be sent at all, so the host has only the
  socket signal, which lies. On a clean close both should arrive, which is what
  makes the inverse record possible.
- Missing evidence: whether the host correlates the two. `connection.rs:199-206`
  keys only on the socket, so at that site it does not.
- Conclusion: resolved with answer. The host's peer-death classification consults
  only the setup socket, so the frame-level Goodbye does not repair it.
