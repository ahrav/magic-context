# authentication-and-capacity-rejections-are-observable

## Discovery trigger

An operator lens over every path that closes a socket without serving it: ask what
an operator would see. Each rejection is a bare `return` or `drop`, so the trigger
was following the `Err`/`else` arm of each admission step and looking for the
counter, log line, or frame that never appears.

## Evidence trail

- **The crate has no logging or metrics dependency.**
  `crates/mc-host/Cargo.toml:13-25` lists `serde`, `hmac`, `subtle`, `serde_json`,
  `sha2`, `fastembed`, `ort`, `tokio`, `tokio-util`, `rustix`, `getrandom`, and
  `mc-shm-transport`. Dev-dependencies at `:27-35` add nothing relevant. A grep for
  `tracing` and `log::` across `crates/mc-host/src/` returns zero matches, so there
  is no channel to carry a rejection record even if one were emitted.
- The only stderr writer in production code is
  `crates/mc-host/src/panic_boundary.rs:43`, an `eprintln!` of a fixed redacted
  string inside the panic hook. So a stderr facility exists in the crate and is
  used for exactly one purpose; its absence on the rejection paths is specific to
  those paths.
- The other in-crate observability channel is `FatalCell`
  (`crates/mc-host/src/runtime.rs:65-88`), a first-failure latch carrying a
  message, drained at `runtime.rs:917`. No rejection path trips it.
- **The three discard sites.** All are in `crates/mc-host/src/connection.rs`,
  inside `run_connection`:
  1. *Authentication failure* — `:158-160`. `authenticate_server` is called at
     `:148-155` and the result is tested as `if auth.is_err() { return; }`. The
     `AuthError` is never bound to a name, so the failure stage is discarded with
     it. The peer sees only a clean FIN:
     `crates/mc-host/src/auth.rs:226-228` calls `teardown_failed_handshake`, which
     at `:207-212` does nothing but `stream.shutdown()` under the remaining
     deadline. No error frame, no counter.
  2. *Connection capacity exhaustion* — `:165-167`.
     `shared.connection_permits.clone().try_acquire_owned()` fails and the body is
     a bare `return`. This is post-authentication, so a client that proved its
     credentials is dropped with no frame. The comment at `:162-164` describes the
     linearization point and not the rejection.
  3. *Post-authentication drain refusal* — `:285-287`. Inside the connections-lock
     block, `if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled()
     { return None; }`. The generation is never registered and the caller unwinds
     with no terminal.
- A fourth, pre-authentication site behaves the same way:
  `crates/mc-host/src/runtime.rs:1012-1015`, handshake-permit exhaustion, is
  `drop(stream); continue;`. Its comment at `:1010-1011` justifies closing without
  reading a client byte and says nothing about recording it. The catalog names three
  classes and this is a fourth silent one, distinguished only by being pre-auth.
- **The peer address is never captured, though it is obtainable at site 1.**
  `runtime.rs:999` destructures the accept result as `let Ok((stream, _addr))`, so
  the accept-time address is discarded. A grep for `peer_addr` and `SocketAddr`
  across `crates/mc-host/src/` returns zero matches, so no path recovers it. But
  `stream` is still a whole `TcpStream` at `connection.rs:158`; the split happens
  later at `:177`, and `authenticate_server` borrows it as `&mut`. So
  `stream.peer_addr()` is in scope at the auth-failure return. **Refinement of the
  catalog:** the address is not "already dropped" in the sense of being
  unreachable — the accepted value is discarded and the socket-derived address is
  never asked for.
- Existing checks assert the close, never a record.
  `crates/mc-host/tests/lifecycle.rs:237`
  (`saturated_handshake_capacity_closes_without_reading_client_bytes`), `:282`
  (`saturated_connection_capacity_closes_after_authentication`), and `:337`
  (`an_unauthenticated_flood_cannot_starve_established_work`) cover the behaviour
  of sites 2 and 4. All three are in a file that runs in no CI job.

## Failure scenario

1. A client with a wrong or absent key connects repeatedly. Each attempt reaches
   `connection.rs:148`, fails, and returns at `:159`.
2. Nothing increments, nothing is written, and the `AuthError` variant — which
   distinguishes a malformed hello from a bad proof from a deadline expiry — is
   dropped at the `is_err()` test.
3. From the host's outside surface the run is identical to a run with no such
   client at all. A credential-probing campaign, a misconfigured deploy pushing a
   stale key, and an idle host are the same observation.
4. Independently, a host at `max_connections` drops each newly authenticated
   client at `:166`. The client observes a TCP close immediately after a successful
   handshake, indistinguishable from a network reset, and the operator observes
   nothing at all. The same holds for a client that authenticates during drain and
   is refused at `:286`.

## Timing windows and dependencies

No timing angle and no fault injection. Each site is a straight-line branch that
executes whenever its precondition holds, so all four are reachable in a shipped
TCP configuration: a wrong key for site 1, `max_connections` concurrent
authenticated connections for site 2, `max_handshakes` concurrent unauthenticated
sockets for site 4, and an accept landing after a committed `host.shutdown` for
site 3. Site 3's precondition is the same one
`admission-freeze-precedes-the-shutdown-commit` constructs, so the two records
share an enabling state. This is a reachability property: the check asserts that
some observable differs from the accepted case, and the fault map records it as
not non-vacuous today because no observable exists to differ.

## What a test must construct

For each of the four sites, two runs that differ only in the rejection, and an
assertion that some host-visible output differs. With today's code the honest form
is the negative: assert that no counter, no stderr line, and no frame distinguishes
the rejected run from a run without the rejected client, which fixes the current
behaviour as a documented fact rather than an accident. A positive form needs an
observable to exist first, so the test shape is determined by whichever channel is
chosen — a counter readable through `host.status`
(`crates/mc-host/src/control.rs:640`), a `FatalCell`-style latch, or stderr. The
auth case additionally needs a check that the recorded identifier is derivable at
`connection.rs:158`, since the accepted address is gone by then and only
`stream.peer_addr()` remains.

## Investigation log

### Q: (the catalog records none) Is the peer address recoverable at the authentication-failure return, or genuinely gone?

- Sources examined: `runtime.rs:992-1021`, `connection.rs:142-177`,
  `auth.rs:207-230`, and a crate-wide grep for `peer_addr` and `SocketAddr`.
- Findings: recoverable. The accept-time `SocketAddr` is discarded at
  `runtime.rs:999` by the `_addr` binding, and no code in the crate names
  `SocketAddr` or calls `peer_addr`. But `run_connection` owns the concrete
  `TcpStream` through `:176`, and the auth test at `:158` precedes the
  `into_split()` at `:177`, so the address is one method call away. The stronger
  claim in the catalog — that the address is dropped at accept and therefore
  unavailable — holds for the accepted value only.
- Missing evidence: no comment explains the `_addr` discard, so whether the
  address was deliberately not retained or simply unused is not determinable from
  the source.
- Conclusion: resolved as mechanism. The address is not captured anywhere; it is
  not unreachable at the failure point.
