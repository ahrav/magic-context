# setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it

## Discovery trigger

`docs/mc-host-wire-protocol.md:561` calls the token "one-use". The code has no
use-tracking state at all, so whatever single-use property holds must come from
the token's scope rather than from consumption. That is worth pinning, because the
token comparison has no negative test.

## Evidence trail

All references at commit `e447c927`.

Minting, `crates/mc-host/src/connection.rs`:

- `:165-169`: `let Ok(token) = activation_token() else { sender.discard();
  root.cancel(); return; };`. Called once per `run_connection` invocation, so once
  per accepted-and-authenticated socket.
- `:212-214`: `activation_token()` wraps `activation_token_with` with
  `getrandom::getrandom`.
- `:216-226`: 32 random bytes, hex-encoded into a 64-character `String`.

Checking, `crates/mc-host/src/setup_socket.rs:261-284`:

- `:261` reads exactly one message into `ClientMessage`.
- `:262-266` matches the `Activate` variant with a guard requiring
  `presented_wire == wire_version && presented_schema == descriptor_schema`.
- `:267-272` compares the presented token against the local one with
  `subtle::ConstantTimeEq::ct_eq` over `as_bytes()`.
- `:273` writes `ServerMessage::Activated` on match; `:275` returns
  `SetupError::InvalidActivation` on mismatch.
- `:278` returns `SetupError::InvalidIdentity` when the guard failed, so a
  version or schema mismatch is a *different* error from a token mismatch.
- `:279` returns `SetupError::InvalidMessage` for any other variant, so `Commit`
  or `Goodbye` in the `Activate` position is refused.
- `:281-284` reads the second message and accepts only `Commit`. A second
  `Activate` lands in the `_` arm and yields `InvalidMessage`.

So on one connection the token is compared once and only once, and there is no
state that would let a second `Activate` be evaluated.

Cross-connection scoping rests entirely on `connection.rs:165` being per-call. The
`ClientMessage` enum carries no connection identifier
(`setup_socket.rs:63-71`), so the token *is* the only thing binding an `Activate`
to the grant that preceded it, and it binds only because each connection holds a
different one in a local variable. Nothing global is consulted.

`deny_unknown_fields` on `ClientMessage` (`setup_socket.rs:62`) means a peer
cannot smuggle extra fields into `Activate`.

## Failure scenario

Two failure shapes.

Always-true comparison. If `ct_eq` were replaced by a length check, or the
comparison inverted into a match on `is_ok()`, any authenticated peer could
activate any connection's grant. Since the host is single-writer per generation,
the visible consequence would be two peers driving generations they did not
receive descriptors for, and the "one grant, one activation" accounting at
`connection.rs:186-188` (`record_attachment`, `record_activation`) would stop
distinguishing them.

Shared token. If the token were hoisted to a per-host value, for example cached in
`HostShared` to avoid a `getrandom` per connection, then a peer that captured one
token would be able to activate any future connection's grant. Every existing test
would still pass, because they all use a single connection and the literal string
`"token"`.

That second shape is the reason this record exists. Six of the in-crate tests pass
the literal `"token"` on both sides (`setup_socket.rs:461`, `:579`, `:610`,
`:623`, `:676`, `:704`, `:754`, `:785`), so a hoisted token is invisible to the
whole unit suite.

## Timing windows and dependencies

Two concurrent setups inside the same `transport_setup_deadline` window, default
2 seconds (`config.rs:227`). Overlap is the normal operating state, not a rare
interleaving: `max_handshakes` defaults to 32 and `max_connections` to 64
(`config.rs:128-129`).

The window for a cross-feed is from the moment connection A's grant is sent
(`setup_socket.rs:151-159`) to the moment connection B's `activate_server` gives
up. Both peers must be inside their setup deadlines at once.

Depends on `setup-a-concurrent-setup-saturation-is-reached` being satisfied by
the campaign, otherwise the cross-connection half of this property cannot be
evaluated at all.

## What a test must construct

Cross-connection case, needing two peers:

1. Start a host with `max_handshakes` and `max_connections` both at least 2.
2. Peer A and peer B each authenticate and call `receive_grant`, retaining their
   grants. Neither activates yet.
3. Peer A sends an `Activate` carrying **B's** token, with A's own correct wire
   version and schema so the guard at `setup_socket.rs:266` passes and the failure
   is attributable to the token and not to the guard.
4. Assert A's connection fails with `SetupError::InvalidActivation`
   (`:275`), distinguished from `InvalidIdentity` (`:278`).
5. Assert B can still activate normally afterwards, so the test proves scoping
   rather than a host that broke.

Second `Activate` case, one peer:

1. authenticate, `receive_grant`, send a correct `Activate`, read `Activated`;
2. send a second correct `Activate`;
3. assert `SetupError::InvalidMessage` (`:283`), not `InvalidActivation`, because
   the second message is read in the `Commit` position.

Both cases must assert the specific error variant. The unit suite's existing habit
of asserting `matches!(..., Err(SetupError::InvalidIdentity))`
(`setup_socket.rs:760-763`) is the right shape; it just never targets the token.

## Investigation log

### Q: Is the token compared anywhere other than `setup_socket.rs:267-272`?

- Sources examined: a search for `activation_token` across `crates/mc-host/src/`
  and `packages/mc-shm-native/src/`.
- Findings: host side, the field is declared at `setup_socket.rs:57` and `:67`,
  populated at `:254` and `:312`, and compared at `:268-269`. Peer side, native
  `setup.rs:48`, `:56`, `:130`, `:267`, `:273` carry it and echo it at `:130`
  without comparing anything. The managed Rust peer echoes it at
  `setup_socket.rs:312` likewise.
- Missing evidence: none.
- Conclusion: resolved. Exactly one comparison exists, on the host, and the peer
  is a pure echo. So the token proves to the host only that the peer read the
  grant.

### Q: Does the token have any single-use enforcement?

- Sources examined: `connection.rs:165-226`, `setup_socket.rs:237-285`, and a
  search for any set, map, or counter keyed on the token.
- Findings: none exists. `activate_server` holds it as a `&str` parameter and the
  caller holds the `String` in a local. It is dropped when `run_connection`
  returns.
- Missing evidence: none.
- Conclusion: resolved. "One-use" in `mc-host-wire-protocol.md:561` is satisfied
  structurally, by per-connection minting plus a single read in the `Activate`
  position, not by consumption. Recorded as lens lead 2 and as the record's open
  question, because a reader could reasonably expect a consumed nonce.

### Q: Could the guard at `setup_socket.rs:266` mask a token mismatch?

- Sources examined: `setup_socket.rs:261-280`.
- Findings: yes, and it matters for test design. If the presented wire version or
  schema is wrong, control reaches `:278` and returns `InvalidIdentity` without
  ever comparing the token. A cross-feed test that also mismatched the version
  would pass while proving nothing about the token.
- Missing evidence: none.
- Conclusion: resolved. The test's step 3 is written to keep the version and
  schema correct so the failure is attributable.
