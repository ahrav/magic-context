# setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token

## Discovery trigger

`docs/mc-host-wire-protocol.md:563` lists "token mismatch" among the conditions
that "retire the connection before application traffic", which reads as though a
wrong activation token prevented the peer from reaching the ring. Reading
`activate_server` shows the descriptors are already gone by then.

## Evidence trail

All references at commit `e447c927`.

The activation token's whole life:

- Minted per connection: `connection.rs:165` calls `activation_token()`, defined
  at `:212-214`, which delegates to `activation_token_with` at `:216-226`. That
  fills 32 bytes from `getrandom` and hex-encodes them to 64 characters.
- Handed to the peer: `connection.rs:176` passes `token.as_str()` into
  `activate_server`, which copies it into the `GrantMessage` at
  `setup_socket.rs:254`.
- Sent: `setup_socket.rs:249-260` is `activate_server`'s first statement. It calls
  `send_grant`, which at `:148` attaches both ring descriptors as `SCM_RIGHTS` and
  at `:151-159` performs the `sendmsg`.
- Checked: `setup_socket.rs:261` reads the next message; `:266` compares wire
  version and schema; `:267-272` compares the presented token against the local
  one with `subtle::ConstantTimeEq`; `:275` returns
  `SetupError::InvalidActivation` on mismatch.

So the token travels to the peer inside the same message as the descriptors and
is verified one round trip later. There is no host-side check between the peer's
`ClientAuth` (`auth.rs:275-277`) and the `sendmsg`.

The consequence is already constructed in the test tree. `crates/mc-host/tests/
shm_failure_modes.rs:44-58`, the `setup` role:

```
let mut stream = tokio::net::UnixStream::connect(&info.setup_socket)...
mc_host::authenticate_client(&mut stream, &info, BUDGET)...
let (_grant, _descriptors) = mc_host::setup_socket::receive_grant(&mut stream, deadline)...
announce("READY setup");
std::future::pending::<()>().await;
```

This peer authenticates, takes the grant and both descriptors, and then never
sends `Activate`. It holds mappable descriptors for its whole life. The test uses
it to assert capacity return after `SIGKILL` (`:232-245`), not to assert anything
about authority, but it proves the state is reachable on the real host.

`receive_grant` is public API: `crates/mc-host/src/lib.rs:35` declares
`pub mod setup_socket`, and the test reaches it as
`mc_host::setup_socket::receive_grant`.

## Failure scenario

The scenario is not a bug, it is a misread contract. Someone reasons: "the
activation token is a second factor, so even if the connection key leaks, an
attacker cannot activate a ring." That is false. The attacker authenticates once
with the leaked key, calls `receive_grant`, and maps both objects. The token check
it then fails costs it only the host-side generation, which it did not need.

The realized damage depends on what the mapped object permits. Part 1's
`quarantine-authority-survives-peer-writes` records that the whole object is
mapped read-write with no write seal, and
`no-rust-reference-over-peer-writable-payload` records that the host must not hold
Rust references over it. So an unactivated peer holding descriptors is exactly the
hostile-peer-sharing-memory case Part 1 mined, reached without ever activating.

## Timing windows and dependencies

The window opens at `setup_socket.rs:151-159` and closes at `:275`, when the host
gives up. Its width is one peer round trip, bounded above by
`transport_setup_deadline`, default 2 seconds (`config.rs:227`). During it the
host holds a prepared ring and the peer holds the descriptors.

After the window closes the host executes `connection.rs:180-185`,
`sender.discard()` and `root.cancel()`, and returns. The peer's descriptors are
unaffected: they are independent open file descriptions in another process. There
is no revocation step anywhere in the setup protocol.

Depends on nothing temporal. Depends on `send_grant` remaining
`activate_server`'s first statement.

## What a test must construct

Extend the existing `setup` role in `shm_failure_modes.rs` rather than writing a
new harness:

1. authenticate and `receive_grant` as it already does;
2. decode the grant's two hex grant strings and `Ring::attach` both descriptors;
3. write a recognisable byte pattern into the peer-to-host arena;
4. only then send a *wrong* `Activate` token and assert the host returns
   `SetupError::InvalidActivation`;
5. assert the write from step 3 is observable, proving the mapping was live
   before the token was ever checked.

The oracle is step 5. Asserting only that the token was rejected proves the
opposite of the property.

A negative control matters here: the same sequence with the *correct* token must
also show the write, so the test cannot pass merely because the rejection path
tears something down.

## Investigation log

### Q: Does any host-side check sit between `ClientAuth` and the `sendmsg`?

- Sources examined: `connection.rs:130-190`, `setup_socket.rs:237-260`,
  `auth.rs:232-280`.
- Findings: three early returns exist at `connection.rs:137-139`, `:157-164` and
  `:165-169`. All three are host resource failures: connection permit exhausted,
  `ring.prepare` failed or timed out, and `getrandom` failed. None inspects
  anything the peer sent.
- Missing evidence: none.
- Conclusion: resolved. No peer-facing check exists in that interval.

### Q: Is the descriptor-before-validation order a documented contract or an accident?

- Sources examined: `docs/mc-host-shm-transport.md:38-49`,
  `docs/mc-host-wire-protocol.md:559-564`.
- Findings: `mc-host-shm-transport.md:40-45` numbers the phases explicitly:
  1 authenticate, 2 admit charge, 3 transfer descriptors, 4 validate profile,
  wire version, schema, grants and token, 5 attach and commit. So transfer before
  validation is documented, and the code matches. What no document states is that
  step 4 is therefore peer-side only, and that a step-4 failure does not undo
  step 3.
- Missing evidence: no design note explains why the order was chosen. Git
  archaeology was not performed.
- Conclusion: resolved as "documented order, undocumented consequence". Recorded
  as lead 1 in the lens's contract-vs-code section rather than as a disagreement.

### Q: Could the host defer the descriptor send until after `Activate`?

- Sources examined: `setup_socket.rs:237-285`, `:288-331`.
- Findings: mechanically yes. The peer's `Activate` echoes only `wire_version`,
  `descriptor_schema` and `activation_token`, all of which the host could send in
  a token-only first message, with the descriptors following the verified
  `Activate`. That would cost one extra round trip inside the same deadline and
  would make the token a real gate.
- Missing evidence: whether the current order was chosen for latency, for
  simplicity, or without deliberation.
- Conclusion: needs human input. Recorded as the record's open question.
