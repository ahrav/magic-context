# Lens A, sub-part 2c: the authenticated setup socket and peer identity

Attention focus: the setup socket as a trust boundary. How a peer proves who it
is, what that proof buys it, and at exactly which instruction it becomes able to
map host shared memory. The peer is treated as hostile throughout, the way Part 1
treated a hostile peer sharing memory.

Code read at `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, commit `e447c927`. Every line reference
below was opened and confirmed at that commit.

In scope for this lens: `crates/mc-host/src/setup_socket.rs` (826),
`crates/mc-host/src/auth.rs` (1,112), `crates/mc-host/src/connection_file.rs`
(471), the credential-minting and publication parts of
`crates/mc-host/src/instance.rs`, and `packages/mc-shm-native/src/setup.rs` (433)
as the peer half. Boundary context only, not re-mined: `connection.rs`
(Part 2a's file, but it is the sole caller of both halves and the authorization
point lives in it), `runtime.rs:834-850` and `:1017-1046` (2f's file, but the
listener and the handshake bound live there), `ring_transport.rs:636-656` and
`client.rs:346-369` (2b and 2d), `packages/mc-shm-native/src/lib.rs:491-629`.

Not re-cataloged, cited instead: Part 1's
`attach-refuses-a-quarantined-object`, `attach-binds-geometry-to-a-local-profile`,
`quarantine-authority-survives-peer-writes`,
`native-boundary-not-weaker-than-its-wrapper`,
`test-only-surface-absent-from-the-shipped-addon`, and
`runtime-directory-authentication-is-a-precondition-not-a-container`; Part 2a's
`authentication-and-capacity-rejections-are-observable`.

## Setup protocol map

One `SOCK_STREAM` `AF_UNIX` connection carries two protocols back to back on the
same stream. There is no framing change between them: both use a 4-byte
little-endian length prefix followed by JSON. They differ only in their length
cap, 4,096 for authentication (`auth.rs:18`) and 16,384 for setup
(`setup_socket.rs:24`).

Phase 0, before any peer byte. The host binds the listener at
`${dataDir}/cortexkit/run/setup.sock` (`runtime.rs:834`, path from
`instance.rs:177-179`) through `bind_owner_only` (`setup_socket.rs:27-50`), then
publishes the connection file naming that path plus the 32-byte key and the
16-byte daemon id (`instance.rs:315-345`). The accept loop takes an
unauthenticated handshake permit before spawning anything and closes the socket
without reading a byte when none is free (`runtime.rs:1035-1040`).

| # | Direction | Message | What the sender proves | What the receiver grants |
| --- | --- | --- | --- | --- |
| 1 | peer to host | `ClientHello { client_nonce, role }` (`auth.rs:26-29`) | nothing; `role` is parsed and discarded (`auth.rs:70-83`, doc `:215`) | nothing |
| 2 | host to peer | `ServerProof { daemon_id, server_nonce, daemon_ver, server_proof }` (`auth.rs:31-37`) | host holds the key: `HMAC-SHA256(key, "subc-server-v1" ‖ client_nonce ‖ server_nonce ‖ daemon_id)` (`auth.rs:246-252`) | nothing; the host has not yet authenticated the peer |
| 3 | peer to host | `ClientAuth { client_auth }` (`auth.rs:55-58`) | peer holds the key, under the same nonce pair and the `"subc-client-v1"` domain (`auth.rs:268-274`) | **everything.** Host returns `Authenticated` (`auth.rs:279`) |
| — | host internal | acquire connection permit, release handshake permit (`connection.rs:137-141`) | — | authenticated capacity |
| — | host internal | `ring.prepare` on a blocking thread, bounded by `transport_setup_deadline` (`connection.rs:146-164`) | — | two memfds and a `WireDescriptor` |
| — | host internal | mint a fresh 32-byte hex activation token (`connection.rs:165`, `:212-226`) | — | — |
| 4 | host to peer | `GrantMessage { wire_version, descriptor_schema, activation_token, descriptor }` **plus exactly two fds in one `SCM_RIGHTS`** (`setup_socket.rs:132-175`, called first thing in `activate_server` at `:249-260`) | nothing new | **the ring.** The peer now holds mappable descriptors |
| 5 | peer to host | `Activate { wire_version, descriptor_schema, activation_token }` (`setup_socket.rs:64-68`) | that the peer read message 4 and echoed it back | `Activated`, after a constant-time token compare (`setup_socket.rs:266-276`) |
| 6 | host to peer | `Activated` (`setup_socket.rs:76`) | — | permission to proceed to commit |
| 7 | peer to host | `Commit` (`setup_socket.rs:69`) | nothing | `Committed` |
| 8 | host to peer | `Committed` (`setup_socket.rs:77`) | — | the host records attachment and activation (`connection.rs:186-188`) and starts the ring |
| 9 | peer to host | `Goodbye`, or EOF, or anything else (`setup_socket.rs:70`, `:345-353`) | — | a `PeerClose` classification: `Goodbye`, `UnexpectedEof`, or `ProtocolError` |

**The exact point at which a peer becomes authorized to map shared memory:**
`crates/mc-host/src/connection.rs:130-133`, the `if auth.is_err() { return; }`
that follows `authenticate_server`. That is the only gate. Everything after it is
unconditional from the peer's point of view: `connection.rs:146-164` builds the
ring, and `setup_socket.rs:249-260` — the *first* statement of `activate_server`
— sends the grant and both file descriptors before reading a single setup-phase
byte from the peer. So authorization to map is exactly "possession of the 32-byte
connection-file key", proved once in message 3.

The activation token is not an authorization credential. The host mints it
(`connection.rs:165`), hands it to the peer inside the very message that carries
the descriptors (`setup_socket.rs:254`), and then checks that the peer echoed it
back (`:266-276`). A peer that fails or skips the echo has already received the
descriptors. `crates/mc-host/tests/shm_failure_modes.rs:44-58` constructs exactly
that peer on the real host: authenticate, `receive_grant`, then
`std::future::pending()` forever, never sending `Activate`.

## Identity map

There are five things that could be called identity on this path. Only one of
them is verified, and it is a bearer secret rather than a name.

| Identifier | Where it comes from | Caller-supplied? | Verified? | Replayable? |
| --- | --- | --- | --- | --- |
| Connection key, 32 bytes | `getrandom` in `InstanceGuard::acquire` (`instance.rs:263-264`), published in the connection file (`instance.rs:326`) | no, host-minted | it is the verification input, via HMAC (`auth.rs:268-277`) | across connections **within one incarnation, yes by design** — it is a bearer credential with no per-use state. Across incarnations no; see below |
| `daemon_id`, 16 bytes | `getrandom` in the same call (`instance.rs:265-266`) | no | folded into both proofs (`auth.rs:151`) and separately compared by the peer against its connection-file snapshot (`auth.rs:336-338`; native `setup.rs:201`) | it changes every incarnation, so a captured transcript does not carry forward |
| `client_nonce`, 32 bytes | peer's `getrandom` (`auth.rs:313`; native `setup.rs:181-182`) | **yes, entirely peer-chosen** | never checked for freshness, uniqueness, or non-repetition | the peer may repeat it freely; harmless because the host's own nonce is fresh |
| `server_nonce`, 32 bytes | host `getrandom` per handshake (`auth.rs:245`, `:379-383`) | no | not checked against history, only freshly drawn | this is the replay defence (doc `mc-host-wire-protocol.md:177`) |
| `role`, a string | peer | **yes** | no. Parsed, then discarded; the type that carries the outcome is a unit struct with a comment saying so (`auth.rs:70-83`) | irrelevant, it grants nothing |
| Activation token, 32 hex bytes | host `getrandom` per connection (`connection.rs:212-226`) | no | constant-time compared once (`setup_socket.rs:267-272`) | scoped to the connection that minted it; see record 5 |

Peer identity in the sense of "which process is this" is **not established at
all**. There is no `SO_PEERCRED`, no `getsockopt(SO_PEERCRED)`, no pid or uid
check anywhere on the accept path; `runtime.rs:1022` discards the peer address.
The published `pid` field (`connection_file.rs:39`) travels host-to-peer, never
the reverse. The trust model is therefore "any process that can read the
connection file is the client", which the wire doc states directly at `:29` and
in its key-reader paragraph. Module identity, which *is* attested, travels a
different path (`auth.rs:80-81`, spawn nonces at `route.open`), out of scope here.

Replay across incarnations, the hazard the task asked to test hardest: the
credential does **not** carry across. `InstanceGuard::acquire` draws a fresh key
and a fresh daemon id on every host start (`instance.rs:263-267`), and the
comment at `:222-231` says credentials are minted only after the lock race is
won. A peer holding a previous incarnation's connection-file snapshot fails at
`InvalidServerProof` (`auth.rs:333-335`) or `DaemonIdMismatch` (`:336-338`), and
in both cases it refuses to emit `ClientAuth`, so no grant is possible. What is
**not** proven anywhere is that a *stale grant* is refused: the two descriptors
handed out in message 4 are ordinary file descriptors over ordinary memfds, and
nothing in the setup protocol revokes them. See records 4 and 10.

## Observations

Every reference below was opened at `e447c927`.

1. `connection.rs:130-133` is the sole authorization gate. `setup_socket.rs:249`
   sends descriptors as `activate_server`'s first action, so the ordering
   "authenticate, then hand over memory" is enforced only by that one early
   return in a different file.
2. `setup_socket.rs:44-48`: `UnixListener::bind` runs before
   `set_permissions(0o600)`. Between those two lines the socket carries
   `0777 & ~umask`. The containing directory is unconditionally `fchmod`ed to
   `0700` (`instance.rs:560-573`), which is what makes the window unexploitable
   by a different uid.
3. `setup_socket.rs:30-32` gates a pre-existing occupant on three clauses at
   once: it must be a socket, owned by the effective uid, and exactly mode
   `0600`. Only one of the failing shapes is tested (`:494-501`, a regular
   file). Symlink, wrong mode, and wrong owner are untested.
4. `setup_socket.rs:39` unlinks the stale socket and `:44` binds. Between them a
   same-uid attacker can take the name; the result is `EADDRINUSE`, the host
   fails to start, and no connection file is published. Fail-closed, but a
   same-uid denial primitive.
5. The socket path is fully predictable: `${dataDir}/cortexkit/run/setup.sock`,
   from `instance.rs:167`, `:177-179` and `runtime.rs:834`. No random component.
6. `client.rs:347` and native `setup.rs:106` both `connect` with no check on the
   socket's owner, mode, or type. Impersonation is defeated downstream instead,
   by the peer's verification of `server_proof`, `daemon_id` and `daemon_ver`
   before it emits `ClientAuth` (`auth.rs:326-348`; native `setup.rs:200-205`).
7. `auth.rs:245` draws a fresh `server_nonce` per handshake; the peer's
   `client_nonce` is never inspected. Replay of a captured `ClientAuth` therefore
   fails on nonce mismatch, not on any explicit anti-replay check.
8. `auth.rs:242` validates the key length before the first read, and
   `auth.rs:422-428` caps the length prefix before allocating. `setup_socket.rs:361`
   and `:378` do the same for the setup phase. No unbounded allocation on either
   protocol.
9. `read_message_unbounded` (`setup_socket.rs:355-367`) is **length**-bounded at
   `:361` and only **time**-unbounded. That resolves the re-scope document's open
   question at `part-2-rescope/scope-map-and-risk-ranking.md:744-746`: the name
   is misleading, not a missing bound. Time-unboundedness is deliberate, because
   the caller is the peer-lifetime sentinel and it sits under a
   `read_cancel`-armed `select!` (`connection.rs:196-206`).
10. `runtime.rs:1035-1040` bounds unauthenticated work at `max_handshakes`,
    default 32 (`config.rs:128`); authenticated work at `max_connections`,
    default 64 (`:129`). The permit swap at `connection.rs:137-141` means the
    post-auth descriptor transfer is charged to the *connection* class, so
    `activate_server`'s 2-second window (`config.rs:227`) is bounded by 64, not
    by 32.
11. Abandoned-setup cleanup is explicit on three of four early exits:
    `connection.rs:166-169` and `:180-185` both `sender.discard()` and
    `root.cancel()`. The `prepare` timeout exit at `:157-164` has no handle to
    discard, because the `PreparedRing` is dropped inside a detached
    `spawn_blocking` task that tokio cannot abort.
12. Received descriptors do not leak on the two rejection paths that return
    before draining ancillary data. `setup_socket.rs:205-207` returns on `CTRUNC`
    with fds still in the buffer, and rustix's
    `impl Drop for RecvAncillaryBuffer` calls `clear` which drains and drops
    every message (rustix 1.1.4, `src/net/send_recv/msg.rs:477-479`, `:490-494`).
    Verified in the vendored crate source, not assumed.
13. Native `setup::connect` validates far more than the host's own
    `activate_client`: wire version and schema (`setup.rs:115-119`), grant
    decode (`:120-121`), profile, and grant distinctness (`:122-124`). The host's
    `activate_client` (`setup_socket.rs:302-306`) checks wire version and schema
    only and returns the descriptor as an unvalidated `serde_json::Value`.
14. `ring_transport.rs:642-650`, the managed Rust client's attach, checks the
    profile and that the two grants have **equal geometry**. It never checks that
    they are **distinct**, and it takes no process-wide claim. Native
    `lib.rs:534-537` and `:582-584` both reject equal grants, and both take
    `GrantReservation::claim` (`:539-549`, `:585-588`).
15. `lib.rs:491` `attach` remains a published napi export taking caller-supplied
    raw fd integers (`:510-513`) and reaching the same channel registry as the
    authenticated `connect_setup` (`:571`). Both are surfaced in TypeScript
    (`packages/mc-shm-native/index.ts:526-529`, `:531-534`); only `connectSetup`
    is used by the shipped frame channel
    (`packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:77`).
16. `auth.rs:39-53` and `:60-68` hand-write `Debug` to redact proof bytes;
    `connection_file.rs:43-55` and `instance.rs:33-38` do the same for the key.
    This is Part 2a's redaction discipline holding on the new files.

## Candidate properties

14 records. Reachability was determined per record, per METHOD rule 4.

### setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof

Type: safety
Reachability: default-production — `run_connection` is the only accept-path body
(`runtime.rs:1042-1044`), the ring is mandatory after the refactor, and
`config.rs:223` gives `auth_deadline` a shipped default.
Status: active
Exercised: partial — three integration tests prove an unauthenticated socket
receives no bytes; none instruments the descriptor-send site itself.
Guarantee: A `SCM_RIGHTS` message carrying ring descriptors is never written to a
setup socket on which `authenticate_server` has not returned `Ok`.
Check: `always` — instrument `send_grant` (`setup_socket.rs:151-159`); every
invocation is preceded on that same stream by an `Ok(Authenticated)` from
`auth.rs:279`. `always` because it is a per-send ordering invariant with no
optional path and no eventual convergence; a single violation is a full loss of
the boundary.
Fault/timing angle: none in the ordering itself, it is straight-line. The window
worth attacking is `connection.rs:130-133`: it discriminates on `is_err()`, so
any future refactor that makes `authenticate_server` return `Ok` on a partial
handshake silently opens the gate.
Required faults and enabling state: a peer that connects and then presents a
malformed `ClientHello`, a short nonce, a wrong `ClientAuth`, or nothing at all,
while the send site is instrumented.
Confidence: high — [evidence](../evidence/setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof.md).
Verified: `authenticate_server` is called at `connection.rs:120-129` and its
error return exits at `:130-133`; `activate_server` is reached only at `:170`;
`send_grant` is `activate_server`'s first statement (`setup_socket.rs:249`).
Existing check: `crates/mc-host/tests/lifecycle.rs:1643-1673`
`shutdown_requires_authentication_and_a_valid_shape` and
`crates/mc-host/tests/protocol_vectors.rs:294`
`malformed_and_wrong_proof_handshakes_close_without_envelope_traffic` both assert
no byte reaches an unauthenticated socket, which subsumes descriptors. Status
unaudited.
Impact: a peer with no credential obtains read-write mappings of host memory.
Part 1 established the whole object is mapped `PROT_READ|PROT_WRITE` with no
`F_SEAL_WRITE` (`quarantine-authority-survives-peer-writes`), so this is
arbitrary write access to host transport state, not merely disclosure.
Open questions: None.

### setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token

Type: safety
Reachability: default-production — same path as the record above.
Status: active
Exercised: partial — `shm_failure_modes.rs:44-58` constructs the peer that takes
the descriptors and never activates, but it asserts capacity return, not the
authority question.
Guarantee: The activation token is not a mapping gate. A peer that has proved key
possession can map the ring whether or not it ever presents a correct token, and
no host-side check between message 3 and message 4 can refuse it.
Check: `always` — for a peer that authenticates and then sends nothing, a wrong
token, or a truncated `Activate`, the two descriptors it already holds still map
successfully. Stated as `always` because it is a standing property of the message
order at `setup_socket.rs:249-276` rather than an occasional outcome.
Fault/timing angle: the window is from the host's `sendmsg` at
`setup_socket.rs:151-159` to its token compare at `:267-272`, which is at least
one peer round trip wide and is bounded only by `transport_setup_deadline`,
2 seconds by default (`config.rs:227`).
Required faults and enabling state: a peer that completes authentication, calls
`receive_grant`, and then diverges from the protocol. `shm_failure_modes.rs:44-58`
already builds it; the missing part is mapping the received fds and writing.
Confidence: high — [evidence](../evidence/setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token.md).
Verified: `activate_server` sends before it reads (`setup_socket.rs:249-261`);
the token is minted by the host (`connection.rs:165`, `:216-226`) and travels
inside the same message as the descriptors (`setup_socket.rs:254`).
Existing check: none for the authority claim. `setup_socket.rs:768-808`
`client_rejects_stale_identity_without_activate_write_or_returned_descriptors`
proves the well-behaved client does not *return* descriptors it rejected; it does
not and cannot prove a hostile peer lacks them.
Impact: the security argument for the setup socket rests entirely on the
connection file's `0600` mode and the runtime directory's `0700` mode. Any future
design that treats the token as a second factor, for example to fence a
compromised key, would be relying on a check that runs after the asset is gone.
Open questions:
- Was descriptor-before-validation chosen so the host need not hold the ring
  while waiting on a peer round trip, or is it incidental? Reordering to
  `Activate`-then-grant would make the token a real gate, at the cost of one
  extra round trip inside the setup deadline. (needs human input)

### setup-a-a-captured-client-proof-never-authenticates-twice

Type: safety
Reachability: default-production.
Status: active
Exercised: partial — nonce freshness is asserted; no test replays a captured
`ClientAuth`.
Guarantee: Bytes captured from one successful handshake, replayed verbatim as
`ClientHello` then `ClientAuth` on a fresh connection to the same live host, are
refused with `InvalidClientAuth`.
Check: `always` — record a full transcript, open a new connection, send the
recorded `ClientHello` and then the recorded `ClientAuth` without recomputing,
and assert `AuthError::InvalidClientAuth` from `auth.rs:275-277` specifically,
not merely a closed socket. `always` because every handshake must resist it.
Fault/timing angle: none temporal. The defence is structural: the host draws a
fresh `server_nonce` at `auth.rs:245` and folds it into the expected proof at
`:268-274`, so a replay matches only if the same nonce recurs. The peer's
`client_nonce` is fully attacker-controlled and never inspected, which is why the
server nonce carries the whole burden.
Required faults and enabling state: a passive observer of one handshake. On a
Unix socket that means a same-uid process able to trace the peer, so this is a
defence-in-depth property under the stated trust model.
Confidence: high — [evidence](../evidence/setup-a-a-captured-client-proof-never-authenticates-twice.md).
Verified: `random_nonce` at `auth.rs:379-383` is a direct `getrandom` per call,
called once per `authenticate_server_inner` at `:245`; nothing caches or reuses
it.
Existing check: `auth.rs:924-939` `repeated_handshakes_receive_fresh_server_nonces`
asserts distinctness across two handshakes. It never attempts a replay, so it
proves the precondition and not the property. Status unaudited.
Impact: if the nonce ever became derived, fixed, or counter-based, one observed
transcript would become a permanent credential for that incarnation, and it would
still satisfy the existing test if the counter merely incremented.
Open questions:
- `client_nonce` is unchecked. Should the host reject an all-zero or repeated
  client nonce, or is server-nonce freshness genuinely sufficient? The doc claims
  sufficiency at `mc-host-wire-protocol.md:177`. (needs human input)

### setup-a-credentials-do-not-survive-a-host-incarnation

Type: safety
Reachability: default-production — `InstanceGuard::acquire` runs on every host
start (`runtime.rs` startup path), and the fields it mints are the only ones the
handshake consults (`runtime.rs:913` region, `connection.rs:120-129`).
Status: active
Exercised: not yet — no test authenticates against incarnation N+1 using
incarnation N's snapshot.
Guarantee: A connection-file snapshot from a previous host incarnation
authenticates against no later incarnation, and the peer refuses before it emits
`ClientAuth`.
Check: `always` — capture a snapshot, restart the host, dial the new socket with
the old snapshot, and assert the peer fails at `InvalidServerProof`
(`auth.rs:333-335`) or `DaemonIdMismatch` (`:336-338`) and that no `ClientAuth`
frame was written. `always` because it must hold for every pair of incarnations.
Fault/timing angle: the interesting window is a host restart while a client holds
a cached `ConnectionInfo`. The client is not required to re-read the file, so
this is the realistic path into the property rather than an attack.
Required faults and enabling state: two host incarnations in the same data
directory, plus a peer that reuses the earlier snapshot.
Confidence: high — [evidence](../evidence/setup-a-credentials-do-not-survive-a-host-incarnation.md).
Verified: key and daemon id are each a fresh `getrandom` inside `acquire`
(`instance.rs:263-266`), the ordering comment at `:222-231` states credentials
are minted after the lock is won, and `ConnectionInfo` carries both by value
(`connection_file.rs:37-38`) so nothing persistent backs them.
Existing check: none direct. `auth.rs:385-403` claims two bootstrap tests
"named for key rotation and singleton probing" carry the always-false coverage;
those are in other files and were not located in this pass, so the claim is
unverified here.
Impact: without per-incarnation rotation, an old snapshot would be a permanent
bearer credential, and `daemon_ver` fencing (`auth.rs:346-348`) would be the only
thing distinguishing incarnations.
Open questions:
- Where are the two bootstrap tests named at `auth.rs:390-392`? Not found in
  `crates/mc-host/tests/` in this pass. Locating them changes this record's
  `Existing check` line. (unresolved, needs a repository-wide test search)

### setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it

Type: safety
Reachability: default-production.
Status: active
Exercised: partial — the matching and mismatching wire-identity cases are tested
in-crate; the cross-connection token case is not.
Guarantee: An activation token accepted on one connection is refused on every
other connection, and no connection accepts a second `Activate`.
Check: `always` — run two setups concurrently, feed connection A's token to
connection B, and assert `SetupError::InvalidActivation` from
`setup_socket.rs:275`. Separately, send `Activate` twice on one connection and
assert the second is `SetupError::InvalidMessage` from `:283`. `always` because
both are per-connection invariants.
Fault/timing angle: two setups overlapping inside the same
`transport_setup_deadline`. `max_handshakes` defaults to 32 and
`max_connections` to 64 (`config.rs:128-129`), so overlap is the normal case
rather than a rare one.
Required faults and enabling state: two peers that both authenticate and then
swap the tokens they received.
Confidence: high — [evidence](../evidence/setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it.md).
Verified: the token is drawn per `run_connection` at `connection.rs:165` from a
32-byte `getrandom` (`:216-226`), compared with `subtle::ConstantTimeEq` at
`setup_socket.rs:267-272`, and `activate_server` reads exactly one message in the
`Activate` position (`:261-280`) then only accepts `Commit` (`:281-284`).
Existing check: `setup_socket.rs:725-765`
`stale_wire_or_descriptor_schema_is_invalid_identity` covers the wire-version and
schema half of the same match arm, giving `InvalidIdentity` but never
`InvalidActivation`. So the token comparison itself has **no** negative test.
Status unaudited.
Impact: the token is what makes "one grant, one activation" observable. If the
comparison were always-true, activation would stop distinguishing the peer that
received a grant from any other authenticated peer, and the doc's "one-use
activation token" (`mc-host-wire-protocol.md:561`) would be vacuous.
Open questions:
- The token is compared but never *consumed* into any store. "One-use" holds only
  because each connection mints its own. Is that the intended reading of
  `mc-host-wire-protocol.md:561`? (needs human input)

### setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid

Type: safety
Reachability: default-production — `bind_owner_only` is called unconditionally at
`runtime.rs:836` on the publication path.
Status: active
Exercised: partial — the final mode is asserted; the interval before the chmod is
not.
Guarantee: From the instant the setup socket appears in the filesystem until it
is unlinked, no principal outside the effective uid can connect to it.
Check: `always` — under a permissive umask such as `0o000`, sample the socket's
mode from a concurrent observer between `bind` and `set_permissions`, and assert
either that the mode is already `0600` or that the containing directory denies
traversal to every other uid. `always` because the exposure is instantaneous and
a single sample inside the window is a violation.
Fault/timing angle: the window is exactly `setup_socket.rs:44` to `:45`. `bind`
creates the socket with `0777 & ~umask`; the tightening is a separate syscall
afterwards. The mitigation is not in this file: `instance.rs:560-573`
unconditionally `fchmod`s the containing runtime directory to `0700`, so the
window is closed by the parent rather than by the socket's own mode.
Required faults and enabling state: a permissive umask in the host's process, and
an observer sampling the mode. Demonstrating actual cross-uid connectability
additionally needs a second uid, which may be unconstructible in CI and should be
recorded as such rather than skipped silently.
Confidence: high — [evidence](../evidence/setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid.md).
Verified: the bind-then-chmod order at `setup_socket.rs:44-48`, the failure
rollback that unlinks on a failed chmod at `:45-47`, and the parent's
unconditional `fchmod(0o700)` at `instance.rs:560-573`.
Existing check: `setup_socket.rs:480-491` `setup_socket_is_owner_only` asserts the
mode after `bind_owner_only` returns, so it covers the end state and not the
window. `instance.rs:979` `permissive_umask_still_yields_owner_only_dir_and_file`
covers the directory and the connection file under a permissive umask but not the
socket. Status unaudited.
Impact: low today, because the parent directory is the real gate. The property is
worth holding because the socket's own mode is the layer a reader would believe,
and a future change that moves the socket out of the `0700` directory would
inherit an unprotected window.
Open questions:
- Would binding through a temporary name and `renameat` into place, or setting
  the umask around the bind, be preferred to relying on the parent directory?
  (needs human input)

### setup-a-a-hostile-occupant-of-the-socket-path-fails-closed

Type: safety
Reachability: default-production.
Status: active
Exercised: partial — one of four failing occupant shapes is tested.
Guarantee: `bind_owner_only` refuses every pre-existing occupant that is not a
socket owned by the effective uid at exactly mode `0600`, refuses without
following links, and never removes an occupant it refused.
Check: `always` — for each of a dangling symlink, a symlink to a live socket, a
socket at mode `0666`, a socket owned by another uid, a directory, and a FIFO,
assert `io::ErrorKind::PermissionDenied` and assert the occupant is still present
afterwards. `always` because it is a per-call invariant over adversary-chosen
filesystem state. This is the same shape as Part 1's
`runtime-directory-authentication-is-a-precondition-not-a-container`, whose
finding was that the conjunction is never negative-tested.
Fault/timing angle: two windows. `symlink_metadata` at `setup_socket.rs:28` to
`remove_file` at `:39`, and `remove_file` at `:39` to `bind` at `:44`. The second
lets a same-uid attacker take the name and force `EADDRINUSE`; the outcome is a
failed start with no connection file published, so it is a denial primitive and
not an impersonation.
Required faults and enabling state: filesystem state planted at the socket path
before the host starts. Four of the six shapes are constructible unprivileged in
a temporary directory. The wrong-owner case needs a second uid.
Confidence: high — [evidence](../evidence/setup-a-a-hostile-occupant-of-the-socket-path-fails-closed.md).
Verified: `symlink_metadata` and not `metadata`, so a symlink is classified as a
symlink and fails the `is_socket()` clause (`setup_socket.rs:28-32`); the three
clauses are one conjunction at `:30-32`; the refusal at `:33-38` precedes the
unlink at `:39`.
Existing check: `setup_socket.rs:493-501`
`insecure_stale_occupant_is_not_replaced` covers the regular-file case and does
assert the occupant survives. Symlink, wrong mode, wrong owner, directory and
FIFO are untested. Status unaudited.
Impact: a mode or owner clause that silently stopped being evaluated would let
the host adopt and then unlink an attacker-planted object, or bind over a live
socket. The conjunction is exactly the shape that passes for the wrong reason
when one clause is dropped.
Open questions:
- The stale-socket branch removes and rebinds. Is there a case where the occupant
  is a *live* socket of a still-running incarnation that lost its lock, and
  should the instance lock be consulted before the unlink? (needs human input)

### setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof

Type: safety
Reachability: default-production — both peer implementations connect without
inspecting the socket (`client.rs:347`, native `setup.rs:106`).
Status: active
Exercised: partial — the in-crate unit suite covers the three refusal reasons
individually.
Guarantee: A listener that occupies the published socket path without holding the
connection key learns nothing from a peer and receives no `ClientAuth`.
Check: `always` — stand up a listener that answers `ClientHello` with a
syntactically valid `ServerProof` carrying a wrong proof, a wrong `daemon_id`, or
a wrong `daemon_ver`, and assert the peer writes exactly one message, the
`ClientHello`, and then closes. `always` because it must hold on every dial.
Fault/timing angle: none. The peer performs all three checks
(`auth.rs:326-348`; native `setup.rs:200-205`) before the `write_message` at
`auth.rs:357-363`, so the ordering is straight-line and the property is about
that ordering not regressing.
Required faults and enabling state: an impostor listener. Constructible in-process
with `UnixStream::pair`, which is what the existing tests do.
Confidence: high — [evidence](../evidence/setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof.md).
Verified: all three peer checks precede the `ClientAuth` write in both
implementations, and the native side short-circuits them into one `if` with
`ct_eq` on the proof and the daemon id (`setup.rs:200-205`).
Existing check: `auth.rs:1022-1073` `rejected_server_sends_no_client_auth`,
driven by `:1074-1081` `invalid_server_proof_sends_no_client_auth` and
`:1082-1089` `daemon_id_mismatch_sends_no_client_auth`. `auth.rs:394-395` also
names `foreign_server_reused_port_never_receives_client_auth` as the always-true
guard for the comparison. The `daemon_ver` mismatch case is not visibly covered
by the two named tests. Status unaudited.
Impact: this is the only thing standing between a same-uid squatter and a peer's
`ClientAuth`, because neither peer checks the socket's ownership or mode before
connecting. A leaked `ClientAuth` is not directly a credential, since it is
nonce-bound, but it is an oracle on the key.
Open questions:
- Should the peer stat the socket for owner and mode before connecting, as the
  connection-file reader already does for the file (`connection_file.rs:267-287`)?
  It would be defence in depth over a check the mutual proof already carries.
  (needs human input)

### setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released

Type: safety
Reachability: default-production — the bound is `config.rs:128`, default 32, with
no opt-in.
Status: active
Exercised: partial — two lifecycle tests cover saturation and non-starvation.
Guarantee: The number of connections that have been accepted but not yet
authenticated never exceeds `max_handshakes`, excess accepts are closed without
reading a client byte, and every terminal outcome releases the slot.
Check: `always` — with `max_handshakes = 1`, hold the slot with a socket that
never speaks, assert a second accept closes with no bytes read, then release the
squatter and assert the slot becomes available. Enumerate every exit from
`run_connection` before `drop(handshake_permit)` and assert each releases:
auth error (`connection.rs:130-133`) and connection-permit exhaustion
(`:137-139`). `always` because the bound must hold at every instant.
Fault/timing angle: the permit swap at `connection.rs:137-141` acquires the
connection permit *before* releasing the handshake permit, so a peer is briefly
charged to both classes. The consequence is that the post-auth descriptor
transfer, bounded by `transport_setup_deadline` at 2 seconds
(`config.rs:227`), is charged to `max_connections` and not to `max_handshakes`.
Required faults and enabling state: a squatter that authenticates and stalls, and
a squatter that never speaks; both already exist in the test support
(`tests/support/raw_client.rs:878`).
Confidence: high — [evidence](../evidence/setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released.md).
Verified: `try_acquire_owned` before spawn at `runtime.rs:1037-1040`, the
`drop(stream)` on failure at `:1038`, and the two pre-swap exits in
`connection.rs`.
Existing check: `crates/mc-host/tests/lifecycle.rs:237`
`saturated_handshake_capacity_closes_without_reading_client_bytes` and `:337`
`an_unauthenticated_flood_cannot_starve_established_work`;
`crates/mc-host/tests/handler_contract.rs:256` asserts the default is positive.
Status unaudited.
Impact: without the bound an unauthenticated peer drives unbounded task and
descriptor growth. `mc-host-wire-protocol.md:161` states the requirement as a
MUST, and the code satisfies it; the residual is the class-crossing window.
Open questions:
- Should the 2-second post-auth setup window have its own bound rather than
  sharing `max_connections`? Sixty-four concurrent stalled setups each hold a
  prepared ring, which is 128 MiB of arena per connection by
  `mc-host-shm-transport.md:77`. (needs human input)

### setup-a-an-abandoned-setup-strands-no-ring-charge

Type: safety
Reachability: default-production.
Status: active
Exercised: partial — SIGKILL after `receive_grant` is covered; the `prepare`
timeout path is not.
Guarantee: Every exit from `run_connection` that occurs after `ring.prepare`
succeeds and before activation completes releases the prepared ring's charge, so
repeated abandoned setups do not ratchet capacity.
Check: `always` — drive N abandoned setups through each distinct exit and assert
the ring accounting reported at `ring_transport.rs:199-203` returns to its
pre-attempt value. `always` because the accounting must balance after every
attempt, not eventually.
Fault/timing angle: one exit is not covered by the discard pattern. The
`timeout_at` at `connection.rs:157-164` abandons a `spawn_blocking` task that
tokio cannot abort, so the `PreparedRing` is dropped inside the detached task and
the surrounding code has no `sender` to `discard()` or `root` to `cancel()`.
Whether `Drop` alone releases the charge is a Part 1 and 2b question; this record
names the exit and requires the balance to be shown.
Required faults and enabling state: a `transport_setup_deadline` short enough for
`ring.prepare` to miss it, which needs either a configured near-zero deadline or
injected slowness in `prepare`. The other three exits need a peer that stalls
after `receive_grant`, which `shm_failure_modes.rs:44-58` already builds.
Confidence: medium — [evidence](../evidence/setup-a-an-abandoned-setup-strands-no-ring-charge.md).
Verified by inspection: the discard-and-cancel pairs at `connection.rs:166-169`
and `:180-185`, and their absence at `:157-164`. Not verified: whether dropping a
`PreparedRing` releases the charge. Part 1's
`charge-release-never-silently-strands` is the neighbouring obligation and should
be cited rather than restated.
Existing check: `crates/mc-host/tests/shm_failure_modes.rs:232-245`
`setup_active_and_idle_sigkill_each_return_exact_capacity` and `:247-263`
`repeated_crashes_do_not_ratchet_single_connection_capacity` cover a killed peer
in the `setup` role, which is the post-grant pre-activation state. Neither
reaches the `prepare` timeout. Status unaudited.
Impact: with `max_connections = 1` a single stranded charge is a permanent
denial. The existing tests were written for exactly that reason, so the
uncovered exit is a gap in an otherwise deliberate campaign.
Open questions:
- Does dropping a `PreparedRing` inside a detached `spawn_blocking` release the
  admission charge, or does that require `sender.discard()`? Answering it needs
  `ring_transport.rs` and the transport crate. (unresolved, needs 2b)

### setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable

Type: safety
Reachability: default-production — `observe_peer` runs for the whole life of
every activated connection (`connection.rs:196-206`).
Status: active
Exercised: partial — the two `PeerClose` outcomes are tested; the cap and the
cancellation are not.
Guarantee: The post-commit sentinel read never allocates more than
`MAX_SETUP_MESSAGE_LEN`, whatever length the peer declares, and it always yields
to `read_cancel`.
Check: `always` — declare a length of `u32::MAX` and assert
`SetupError::MessageTooLarge` with no allocation of that size; separately, cancel
`read_cancel` while the sentinel is parked and assert the task exits. `always`
because both must hold on every sentinel read.
Fault/timing angle: `read_message_unbounded` (`setup_socket.rs:355-367`) has no
deadline, so a peer that sends three of four length bytes and stops parks the read
forever. That is intentional: the sentinel's purpose is to notice the peer, and
its bound is cancellation rather than time. The name is the hazard, not the
behaviour, and it resolves the re-scope open question at
`part-2-rescope/scope-map-and-risk-ranking.md:744-746`.
Required faults and enabling state: a peer that completes commit and then sends a
huge length prefix, and separately one that sends a partial prefix and stalls
while the connection is cancelled.
Confidence: high — [evidence](../evidence/setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable.md).
Verified: the cap at `setup_socket.rs:361-363` precedes the `vec![0u8; len]` at
`:364`, and the `select!` at `connection.rs:196-206` is `biased` with
`read_cancel` first.
Existing check: `setup_socket.rs:810-825`
`goodbye_and_eof_have_distinct_outcomes` covers the `Goodbye` and EOF
classifications. `:599-651` `activation_and_commit_complete_on_setup_socket`
covers the `ProtocolError` classification. None covers the cap or the
cancellation. Status unaudited.
Impact: the cap is the only thing between a post-commit peer and a 4 GiB
allocation, and the sentinel is the one read on this socket with no deadline, so
the two properties are what keep an idle authenticated connection cheap.
Open questions:
- Should `read_message_unbounded` be renamed to say what it actually is,
  time-unbounded and length-capped? The current name invites the exact wrong
  conclusion, and the re-scope document drew it. (needs human input)

### setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection

Type: safety
Reachability: default-production for the native path
(`shm-frame-channel.ts:77`); the managed Rust peer is the `mc_host::Client`
surface reached from `client.rs:346`, also production for embedders.
Status: active
Exercised: not yet — no test drives a malformed grant at the managed Rust peer.
Guarantee: Every grant-level rejection the native peer performs is also performed
by the managed Rust peer, so choosing the Rust client cannot admit a descriptor
the native addon would refuse.
Check: `always` — for each native rejection reason, construct the grant that
triggers it and assert the managed Rust path also refuses. Enumerated from the
native side: wire version (`setup.rs:115`), descriptor schema (`:116`), grant hex
and decode (`:120-121`), profile (`:122`), grant distinctness (`:122`), and the
process-wide claim (`lib.rs:585-588`). `always` because it is a per-descriptor
invariant, the same shape as Part 1's
`native-boundary-not-weaker-than-its-wrapper`.
Fault/timing angle: none temporal. The exposure is a divergence in two
independently maintained validation lists.
Required faults and enabling state: a host, or a stand-in, that emits a grant
naming two identical grant strings, or a second concurrent attach of the same
grant in one process.
Confidence: high — [evidence](../evidence/setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection.md).
Verified: two divergences. First, `ring_transport.rs:646-650` compares
`from_host_grant.geometry() != to_host_grant.geometry()` and rejects on
*inequality*, whereas native `setup.rs:122` and `lib.rs:582-584` reject on grant
*equality*; the two checks are not the same predicate and the managed path admits
the aliased pair the native path refuses. Second, native `lib.rs:539-549` and
`:585-588` take a process-wide `GrantReservation::claim`; the managed Rust path
takes no claim at all. `setup_socket.rs:302-306`, the managed peer's setup step,
checks only wire version and schema and returns the descriptor as an
unvalidated `serde_json::Value`.
Existing check: none on the managed Rust peer. Part 1's
`native-boundary-not-weaker-than-its-wrapper` recorded the mirror-image gap and
is still the reference for method.
Impact: **the asymmetry Part 1 found has inverted rather than closed.** The
refactor added `packages/mc-shm-native/src/setup.rs` and moved profile, decode,
alias and replay-claim checks into the native boundary, so the native side is now
the stronger one. The weaker boundary is the managed Rust client. Part 1's record
should be re-read with that in mind rather than assumed still-oriented.
Open questions:
- Can an aliased grant pair actually arise? The only producer is
  `ring_transport.rs:324-327`, which encodes two distinct rings, so today this is
  latent. It becomes live under a rogue or impersonating host, which is the
  threat model this lens is written against.

### setup-a-only-an-authenticated-grant-enters-the-native-channel-registry

Type: safety
Reachability: default-production for `connect_setup`; `attach` is the surface
under test and is exported without a cfg gate.
Status: active
Exercised: not yet — no test asserts the shipped wrapper never reaches `attach`.
Guarantee: In a shipped configuration every channel inserted into the native
registry originates from `connect_setup`, which authenticated over the setup
socket, and never from `attach`, which takes caller-supplied descriptors and
authenticates nothing.
Check: `always` — instrument both insertion sites (`lib.rs:550-556` and
`:589-596`) and assert that a full shipped-wrapper run inserts only through
`connect_setup`. `always` rather than `unreachable` because `attach` is a
published export that tests and embedders may legitimately call; the forbidden
thing is a *state*, a registry entry with no authenticated provenance, and
METHOD's rule for a forbidden state with no dedicated detection point is
`always(!X)`.
Fault/timing angle: none. This is a call-graph property.
Required faults and enabling state: none beyond running the shipped wrapper with
both sites instrumented.
Confidence: high — [evidence](../evidence/setup-a-only-an-authenticated-grant-enters-the-native-channel-registry.md).
Verified: `attach` at `lib.rs:491` reads `hostToPeerFd` and `peerToHostFd` as
caller-supplied integers (`:510-513`) and never touches a socket;
`connect_setup` at `:571` calls `setup::connect` which performs the three-message
handshake (`setup.rs:107-113`). Both end in `insert_channel` on the same
`REGISTRY`. `index.ts:526-529` and `:531-534` expose both;
`shm-frame-channel.ts:77` uses only `connectSetup`.
Existing check: Part 1's `test-only-surface-absent-from-the-shipped-addon` is the
neighbouring property and should be checked for whether it already covers
`attach`. `attach` carries no `#[cfg(test)]` and no `#[doc(hidden)]`, so on the
face of it that record does not reach it. Status unaudited.
Impact: `attach` is a fully authenticated-path bypass reachable from JavaScript
in the same process. Under the same-uid trust model that is not a privilege
escalation, but it does mean the setup socket is not the only way into the ring,
and any reasoning that starts "the peer must have authenticated" is unsound for
in-process callers.
Open questions:
- Is `attach` intended as production surface, test surface, or a
  worker-thread re-attach path? `create_test_pair` at `lib.rs:631` suggests the
  test reading. (needs human input)

### setup-a-concurrent-setup-saturation-is-reached

Type: reachability
Reachability: default-production — reaching it needs only enough concurrent
peers, both bounds ship enabled.
Status: active
Exercised: not yet — the saturation tests pin `max_handshakes` to 1 or 4 and use
sockets that never speak, so they never produce the mixed state.
Guarantee: A campaign actually reaches the state in which the unauthenticated
handshake class is saturated at the same time as at least one authenticated
connection sits between the descriptor send and the `Activated` reply.
Check: `sometimes` — a marker fires when, at one observation, handshake permits
available equals zero **and** at least one connection is inside
`activate_server` between `setup_socket.rs:260` and `:273`. The two clauses are
independent preconditions of the vulnerable window, so the marker still fires on
a correct implementation, per the coverage-check rule. `sometimes` and not
`reachable` because a campaign can execute every line of both bounding paths
while never producing the concurrent operational state that makes the
class-crossing window at `connection.rs:137-141` observable.
Fault/timing angle: this record exists because records
`setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released`,
`setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it` and
`setup-a-an-abandoned-setup-strands-no-ring-charge` are all vacuous unless
concurrent setups overlap. With `max_handshakes = 1` they cannot.
Required faults and enabling state: `max_handshakes` and `max_connections` both
above 1, more concurrent dialers than `max_handshakes`, and at least one dialer
that authenticates and then delays its `Activate` inside the setup deadline.
Confidence: high — [evidence](../evidence/setup-a-concurrent-setup-saturation-is-reached.md).
Verified: the two existing saturation tests set `max_handshakes` to 1
(`tests/lifecycle.rs:239`) and 4 (`:339`) and both use squatters that never
speak (`:243-244`, `:355-357`), so neither can populate the second clause.
Existing check: none. The two lifecycle tests establish the first clause only.
Impact: without this marker the bounding and scoping records can pass on a
campaign that never ran two setups at once, which is the same vacuity Part 1's
Group M records were introduced to prevent.
Open questions: None.

## Contract-vs-code leads

1. **Descriptor transfer precedes validation, and the doc says so.**
   `docs/mc-host-shm-transport.md:40-45` orders setup as authenticate, admit
   charge, transfer descriptors, validate, attach and commit. The code matches:
   `setup_socket.rs:249-260` transfers before `:261-276` validates. So this is
   **not** a disagreement. What the docs never state is the consequence, that a
   token mismatch retires the connection only after the peer holds mappable
   descriptors, which `mc-host-wire-protocol.md:563` reads as if it prevented
   access. Recorded as
   `setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token`.
2. **"One-use activation token."** `mc-host-wire-protocol.md:561` says setup
   "validates the fixed release identity and one-use activation token". The code
   has no use-tracking state: `setup_socket.rs:267-272` compares once, and
   single-use holds only because `connection.rs:165` mints a fresh token per
   connection and `:261-284` accepts exactly one `Activate`. The property is real
   but its mechanism is structural, not a consumed nonce. Flagged, not resolved.
3. **The published socket path in the doc's example does not match the code.**
   `mc-host-wire-protocol.md:76` shows `"setup_socket":
   "/run/user/1000/cortexkit/mc-host.sock"`. The code produces
   `${dataDir}/cortexkit/run/setup.sock` (`instance.rs:167`, `:177-179`,
   `runtime.rs:834`). Both the directory shape and the file name differ, and the
   same document's `:70` says clients read
   `${dataDir}/cortexkit/run/subc-connection.json`, so the example contradicts
   its own section. Low impact, since the path is read from the file rather than
   constructed, but it is a concrete doc lag.
4. **Host-side profile acceptance has no host-side enforcement.**
   `mc-host-wire-protocol.md:563` says "Setup accepts only the release's current
   wire version, descriptor schema, and ring profile." `activate_server`
   (`setup_socket.rs:261-284`) validates wire version, schema and token, and
   never the profile. The profile is validated only by the peer
   (native `setup.rs:122`, managed `ring_transport.rs:642-644`). Defensible,
   since the host is the profile's sole producer, but the sentence as written
   describes a host check that does not exist.
5. **Nonce non-reuse is asserted as a MUST and is only probabilistic.**
   `mc-host-wire-protocol.md:177` says both nonces MUST NOT be reused within or
   across connections or host incarnations. `auth.rs:379-383` draws 32 fresh
   bytes per call with no history, which satisfies the intent at a 2^-256
   collision bound but is not an enforced non-reuse. More materially, the MUST is
   stated for *both* nonces and the host never inspects `client_nonce`
   (`auth.rs:244-252`), so the peer's half of the MUST is unenforceable by the
   host.
6. **The two-second budgets are stated as coupled and are configured
   independently.** `mc-host-wire-protocol.md:747` states the client's whole-
   handshake deadline and the host's authentication deadline are "not
   independent". In code they are two separate fields with the same default,
   `auth_deadline` and `transport_setup_deadline` (`config.rs:223`, `:227`),
   and the host consumes them in sequence, so a peer's single 2-second budget
   faces a host that may spend up to 4 seconds. The doc names the hazard; nothing
   in `config.rs` validates the relationship.

## Open questions

1. Should the setup socket use `SO_PEERCRED` to bind the peer's uid, given that
   the whole trust model is same-user? It would turn "anyone who read the file"
   into "anyone who read the file and runs as us", which is what the doc already
   claims at `mc-host-wire-protocol.md:29`. (needs human input)
2. Is the descriptor-before-token order deliberate? See record 2's open question.
   (needs human input)
3. Where are the two bootstrap tests that `auth.rs:390-392` names as the
   always-false coverage for the proof comparison? Not found under
   `crates/mc-host/tests/` in this pass. (unresolved, needs a repository-wide
   search)
4. Does dropping a `PreparedRing` inside a detached `spawn_blocking` release its
   admission charge? This decides the confidence of
   `setup-a-an-abandoned-setup-strands-no-ring-charge`. (unresolved, needs 2b)
5. Part 1's `native-boundary-not-weaker-than-its-wrapper` was written before
   `packages/mc-shm-native/src/setup.rs` existed. Its `Impact` line says the
   native descriptor type structurally omits `candidateId` and so drops the
   replay fence. `attach` now takes `GrantReservation::claim`
   (`lib.rs:539-549`), which is a different and narrower fence, covering only
   concurrently live grants. Whether that record's status changes is a Part 1
   revision, not this lens's call. (needs human input)
6. Is `attach` production surface? See record 13. (needs human input)
7. The re-scope document's open question at
   `part-2-rescope/scope-map-and-risk-ranking.md:738-740` asked whether
   `packages/mc-shm-native/src/setup.rs` belongs to Part 1 or to 2c. This lens
   treated it as 2c per the proposal, and the file's records are written as the
   peer half of the setup protocol rather than as transport records. If the
   answer is Part 1, records 12 and 13 move. (needs human input)
8. **A bias this lens is aware of and did not correct.** The semantics
   distribution is 13 `always` and one `sometimes`, with no `liveness` record and
   no `unreachable`. That partly reflects the subject: a trust boundary is mostly
   per-evaluation invariants, and the two failure modes that matter, a gate that
   admits and a bound that leaks, are both `always`. But it is also the shape a
   single-lens pass produces, and the absence of any liveness record here is
   suspicious given that the setup path has two deadlines and a sentinel with
   none. Whether "a stalled setup is torn down within
   `transport_setup_deadline`, observed as a bounded attempt count rather than a
   generous timeout" deserves its own liveness record is left for synthesis.
   (surfaced for the portfolio evaluation)
