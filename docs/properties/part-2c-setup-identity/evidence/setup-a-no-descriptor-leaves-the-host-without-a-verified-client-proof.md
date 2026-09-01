# setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof

## Discovery trigger

The task asked for the exact point at which a peer becomes authorized to map
shared memory. Reading `setup_socket.rs` alone cannot answer it, because
`activate_server` performs no authentication of its own: it opens by sending the
grant. The gate is one early return in a different file.

## Evidence trail

All references at `/local/home/ahrav/scratch/magic-context`, commit `e447c927`.

- `crates/mc-host/src/runtime.rs:1017-1046` is the accept loop. It takes an
  unauthenticated handshake permit at `:1037` and, on success, spawns
  `run_connection` at `:1042-1044`. Nothing else is spawned per accepted socket.
- `crates/mc-host/src/connection.rs:115-119` is `run_connection`'s signature. Its
  first statement, `:120-129`, is `crate::auth::authenticate_server`.
- `crates/mc-host/src/connection.rs:130-133` is the gate:
  `if auth.is_err() { return; }`. There is no other conditional between the
  accept and the descriptor send.
- `crates/mc-host/src/connection.rs:170-185` is the only call to
  `crate::setup_socket::activate_server` in the crate. Confirmed by a
  repository-wide search: the other matches are `auth.rs` tests and
  `setup_socket.rs`'s own `#[cfg(test)]` module.
- `crates/mc-host/src/setup_socket.rs:237-248` is `activate_server`'s prologue,
  which computes the deadline. `:249-260` is its first action: `send_grant`.
- `crates/mc-host/src/setup_socket.rs:132-175` is `send_grant`. `:148` pushes the
  two borrowed descriptors into a `SendAncillaryMessage::ScmRights`, and
  `:151-159` performs the `sendmsg` that carries them.
- `crates/mc-host/src/auth.rs:232-280` is `authenticate_server_inner`. It returns
  `Ok(Authenticated)` only at `:279`, after the constant-time comparison at
  `:275-277` of the peer's `ClientAuth` against the locally recomputed proof
  (`:268-274`).

So the ordering is: peer proof verified at `auth.rs:275-277`, gate at
`connection.rs:130-133`, descriptors on the wire at `setup_socket.rs:151-159`.
No other path reaches the `sendmsg`.

## Failure scenario

A refactor that makes `authenticate_server` return `Ok` on any partial handshake,
for example by treating a clean EOF after `ServerProof` as a benign close, moves
the gate without touching `setup_socket.rs`. An unauthenticated peer then receives
two memfds. Part 1's `quarantine-authority-survives-peer-writes` established that
`Mapping::attach` maps the whole object `PROT_READ|PROT_WRITE` with seals of
`F_SEAL_GROW|SHRINK|SEAL` and no `F_SEAL_WRITE`, so the consequence is arbitrary
write access to host transport control pages, not only disclosure.

## Timing windows and dependencies

None. The sequence is straight-line inside one task with no interleaving. The
property's fragility is structural rather than temporal: the enforcement and the
protected action live in different files, and nothing in `setup_socket.rs`
records that its caller owes it an authenticated stream. The doc comment at
`connection.rs:106-113` states the obligation in prose.

Depends on `runtime.rs:1042-1044` remaining the only spawn site, and on
`connection.rs:170` remaining the only `activate_server` call site. Both were
verified by search, not assumed.

## What a test must construct

An instrumentation point at `setup_socket.rs:151-159` that records the stream
identity, and a second at `auth.rs:279`. Then for each of these peers, assert the
send site never fires:

1. connect and close immediately;
2. connect and send a 4-byte length prefix, then stall past `auth_deadline`;
3. connect and send `{not json` as the `ClientHello` body;
4. connect and send a valid `ClientHello` with a 16-byte `client_nonce`;
5. connect, complete `ClientHello`, then send a `ClientAuth` of 32 wrong bytes;
6. connect, complete `ClientHello`, then close before `ClientAuth`.

Cases 3, 4 and 5 already exist as socket-level assertions in
`crates/mc-host/tests/protocol_vectors.rs:294`; what is missing is the assertion
at the descriptor-send site rather than at the socket. The existing form asserts
that no byte arrives, which subsumes the property but cannot distinguish "the
descriptors were not sent" from "the descriptors were sent and the read raced".

The oracle must be the send site, not the socket, because `sendmsg` with
`SCM_RIGHTS` transfers descriptors even if the peer never reads the accompanying
bytes.

## Investigation log

### Q: Is `connection.rs:130-133` really the only gate before the descriptor send?

- Sources examined: `connection.rs:115-190`, `runtime.rs:1017-1046`,
  `setup_socket.rs:237-285`, plus a repository-wide search for `activate_server`
  and `send_grant`.
- Findings: between the gate and the send there are three statements that can
  return early, at `:137-139` (connection permit exhausted), `:157-164`
  (`prepare` failed or timed out) and `:165-169` (token generation failed). All
  three are host-side resource failures, none is a peer-authorization decision.
- Missing evidence: none.
- Conclusion: resolved. The gate is `connection.rs:130-133`, and the three later
  early returns are capacity and resource failures that only make the grant less
  likely, never more.

### Q: Does the existing test coverage actually reach the descriptor path?

- Sources examined: `crates/mc-host/tests/lifecycle.rs:1643-1673`,
  `crates/mc-host/tests/protocol_vectors.rs:290-320`,
  `crates/mc-host/tests/support/raw_client.rs:877-880`.
- Findings: both tests use `connect_unauthenticated` and assert either `Ok(0)` or
  `ConnectionReset` on a read. Since the grant is the first thing the host would
  write after authentication, a passing assertion does imply no grant was sent.
- Missing evidence: neither test inspects ancillary data, so a hypothetical bug
  that sent descriptors with zero payload bytes would satisfy both.
- Conclusion: resolved as partial coverage. Recorded as
  `Exercised: partial` with the ancillary-data gap named.
