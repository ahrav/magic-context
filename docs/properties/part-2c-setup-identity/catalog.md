# Part 2c property catalog: the authenticated setup socket and peer identity

Scope: the trust boundary a peer crosses to obtain mappable ring memory.
`crates/mc-host/src/setup_socket.rs` (826 lines) is the setup protocol and the
descriptor transfer. `crates/mc-host/src/auth.rs` (1,112) is the three-message
mutual proof. `crates/mc-host/src/instance.rs` (1,423) mints the credentials and
publishes them. `crates/mc-host/src/connection_file.rs` (471) is the publication
format and its client-side reader. **3,832 in-crate lines.** One external file is
in scope as the peer half and is cited throughout because it is the only unit here
whose tests execute in CI: `packages/mc-shm-native/src/setup.rs` (433), for
**4,265 total**.

Boundary context, read but not cataloged: `connection.rs` (Part 2a's file, but the
sole authorization gate lives in it at `:130-133` and the activation token is
minted in it at `:165`), `runtime.rs:834-850` and `:1017-1046` (2f's file, but the
listener and the handshake bound live there), `ring_transport.rs:636-656` and
`client.rs:346-369` (2b and 2d), and `packages/mc-shm-native/src/lib.rs:491-629`.

Provenance in [../README.md](../README.md). Method contract in
[../METHOD.md](../METHOD.md). Code read from
`/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Both lens agents read and verified
their line references at that commit, and this synthesis re-opened every reference
it restates in its own prose.

**This surface is post-refactor and almost entirely new.** Three of the four
refactor commits named in the re-scope reach it, and one of them created its
central file:

| Commit | Subject | Effect here |
| --- | --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` | fixed the ring profile and descriptor schema the setup protocol pins |
| `d8bde128` | `feat(host): add authenticated ring setup socket` | **added `setup_socket.rs`** |
| `793a973e` | `build(shm): require packaged native transport` | made the manifest and checksum gate the addon load path |
| `ed487e11` | `refactor(host): make ring transport mandatory` | made the ring the only transport, and **deleted the TypeScript handshake** (`auth.ts`, 314 lines; `auth.test.ts`, 365 lines) |

`setup_socket.rs` did not exist before `d8bde128`, so **nothing had ever been
cataloged against this boundary.** The re-scope records that directly:
`part-2-rescope/scope-map-and-risk-ranking.md:107` marks the file "new by
refactor, never scoped", and `:604` records "Salvage input: none. No lens file
covered either file." Every record below is a first pass, and no prior record is
being revised or inherited.

Three provenance refinements this synthesis made against the lens files, recorded
per METHOD.md rule 1 rather than silently applied. A fourth, on
`packages/mc-shm-native/src/lib.rs` line numbers, is recorded below the list
because it touches record text this synthesis may not edit.

- `send_grant` is not literally `activate_server`'s first *statement*. The
  deadline computation at `setup_socket.rs:246-248` precedes it. `send_grant` is
  the first statement that touches the peer, and the substance of the finding is
  unchanged: it completes at `:260` before the first `read_message` at `:261`.
- The `fchmod(0o700)` on the runtime directory is at `instance.rs:571-572`. The
  `:560-573` range cited in lens A and in the task is the enclosing block, whose
  owner and directory-type checks are at `:561-570`. Both are correct; the
  narrower citation is the one that does the work.
- Lens B's production-guard inventory undercounts. It reports zero assertions,
  three `.expect(`, four constant-time comparisons, and five `let _ =` in the
  production halves. Re-derived per file by cutting each at its last
  `#[cfg(test)]`, the figures are **one** `debug_assert!`
  (`instance.rs:592-595`), **five** `.expect(`, **five** constant-time
  comparisons, and **nine** `let _ =`. The corrections and their sites are in
  [existing-checks.md](existing-checks.md); none of them changes a record.

**A fourth refinement, on the native addon's line numbers.** Two records cite
`packages/mc-shm-native/src/lib.rs` a few lines off, and the records are carried
verbatim from lens A, so the correction is stated here rather than applied to the
record text. Re-derived at `HEAD`: in `attach` the aliased-fd-or-grant rejection is
`:533-535` (lens A: `:534-537`) and the `GrantReservation::claim` is `:540-543`
(lens A: `:539-549`); in `connect_setup` the equal-grant rejection is `:588-590`
(lens A: `:582-584`) and the claim is `:591-594` (lens A: `:585-588`). The two
registry insertion sites are the `insert_channel` calls at `:551` and `:612`, not
the `:550-556` and `:589-596` ranges the records name; `:655` and `:672` are two
further calls inside `create_test_pair` (`:631`), which is a separate surface.
Every finding the two records state is unaffected: both predicates, both claims,
and both insertion sites exist where the records say they do in structure, and the
counts are unchanged.

## What this part is about

Seven facts frame every record below. They are stated with evidence because five
of them read as design decisions until the line is opened, and then read as
consequences nobody wrote down.

**Authority to map shared memory is possession of a 32-byte key and nothing
else.** The only gate on the accept path is the `if auth.is_err() { return; }` at
`connection.rs:130-133`, immediately after `authenticate_server`. Everything past
it is unconditional from the peer's point of view. `connection.rs:146-164` builds
the ring, and `activate_server`'s first peer-facing statement is the `send_grant`
call at `setup_socket.rs:249-260`, which writes the grant and both file
descriptors in one `sendmsg` with `SCM_RIGHTS` (`:151-159`) before the first
`read_message` at `:261`. So both descriptors leave the host before any
setup-phase byte is read. The activation token cannot gate mapping, because the
host mints it (`connection.rs:165`, `:212-226`), ships it *inside* the same
`GrantMessage` that carries the descriptors (`setup_socket.rs:254`), and only then
checks that the peer echoed it back (`:266-276`). A peer that never echoes has
already been paid. That peer is not hypothetical: `tests/shm_failure_modes.rs:44-58`
builds it against the real host, authenticating at `:50`, calling `receive_grant`
at `:53-56`, and then parking on `std::future::pending()` forever at `:58` without
ever sending `Activate`.

**A granted descriptor is never revoked.** Nothing in the protocol takes it back.
`activate_server` can fail after `send_grant` succeeded, on `InvalidActivation`
(`setup_socket.rs:275`), `InvalidIdentity` (`:278`), `InvalidMessage` (`:279`,
`:283`), or a `Timeout` in either `read_message`, and in every one of those cases
the host's response is to drop *its own* copies and cancel its own work
(`connection.rs:180-185`). The peer keeps both mapping descriptors. They are
ordinary file descriptors over ordinary memfds; the only stated containment is the
Linux size seal, which `docs/mc-host-shm-transport.md:85` says macOS does not
provide.

**Credentials do not survive an incarnation, and that is the good news here.**
The 32-byte key and the 16-byte daemon id are each a fresh `getrandom` inside
`InstanceGuard::acquire` (`instance.rs:263-264` and `:265-266`), drawn after the
lock race is won on the reasoning stated at `:222-231`, and the server nonce is a
fresh `random_nonce()` per handshake (`auth.rs:245`, drawing at `:379-383`). So a
snapshot from a previous incarnation fails at `InvalidServerProof` or
`DaemonIdMismatch` before the peer emits `ClientAuth`, and a captured `ClientAuth`
replayed against a live host fails at `auth.rs:275-277`. **Neither is
negative-tested.** `auth.rs:924-939` asserts that two handshakes receive distinct
server nonces, which proves the precondition of replay resistance and never
attempts a replay; no test authenticates against incarnation N+1 with
incarnation N's snapshot.

**The socket is mode `0600` applied after `bind`.** `bind_owner_only` binds at
`setup_socket.rs:44` and narrows the mode at `:45`, rolling back with an unlink if
the chmod fails (`:46-47`). Between those two lines the socket exists at
`0777 & ~umask`, so a permissive umask opens a real window. It is unexploitable
only because the containing runtime directory is unconditionally `fchmod`ed to
`0700` (`instance.rs:571-572`, inside the validated `O_NOFOLLOW`-anchored walk the
module doc describes at `:4-7`). The socket's own mode is therefore not the gate a
reader would believe it is. The path is fully predictable, with no random
component: `${dataDir}/cortexkit/run/setup.sock`, from `instance.rs:167`,
`:177-179` and `runtime.rs:834`. And the pre-existing-occupant gate at
`setup_socket.rs:30-32` is a three-clause conjunction, requiring a socket, owned
by the effective uid, at exactly mode `0600`, of which only the `is_socket()`
clause is tested: the sole test plants a regular file (`:494-501`, planted at
`:497`). A same-uid socket at mode `0666`, which is exactly the residue a previous
incarnation under a permissive umask leaves, is untested.

**The native-versus-managed asymmetry Part 1 found still exists and has
inverted.** The refactor added `packages/mc-shm-native/src/setup.rs`, and the
native peer now validates wire version and schema (`:115-118`), decodes both
grants (`:120-121`), and rejects a wrong profile or an aliased grant pair in one
expression (`:122-124`), while `lib.rs:533-535` rejects an aliased fd or grant and
`:540-543` and `:591-594` take a process-wide `GrantReservation::claim`. The
managed Rust peer has none of that at the same layer: `activate_client`
(`setup_socket.rs:302-306`) checks wire version and schema only and returns the
descriptor as an unvalidated `serde_json::Value`, and `ring_transport.rs:642-650`
checks the profile and then rejects grants whose **geometries differ** (`:648`)
where the native side rejects grants that are **equal** (`setup.rs:122`,
`lib.rs:588-590`). Two identical grants have identical geometry, so they pass the
managed check and fail the native one. **On grant-distinctness the polarity is
reversed, not merely absent**, and the managed path takes no claim at all. Part 1's
`native-boundary-not-weaker-than-its-wrapper` recorded the mirror-image gap and
should be re-read rather than assumed still-oriented; the weaker boundary is now
the managed Rust client.

**Two auth doc comments cite a cross-language contract whose other half the
refactor deleted.** `auth.rs:693-698` states that the TypeScript client asserts
its handshake against the same fixed proof vectors in
`packages/plugin/src/shared/mc-host-client/auth.test.ts`, "so they form a
cross-language contract: changing the domain separator, the field order, or the
MAC breaks the build here, where the change is being made." That file does not
exist. Neither does `auth.ts`. `git show --stat ed487e11` shows both deleted at
365 and 314 lines by the commit that made the ring mandatory, and the surviving
directory listing confirms their absence. Separately, `auth.rs:394-396` names
`foreign_server_reused_port_never_receives_client_auth` as the always-true fence
on the proof comparison; a repository-wide grep for that identifier returns
exactly one hit, the comment itself. **The consequence is that the CI-enforced
authority for the proof construction is now the peer's implementation rather than
the host's.** The host's `committed_wire_vectors_pin_the_proof_construction` and
the peer's `auth_proofs_match_committed_wire_vectors`
(`packages/mc-shm-native/src/setup.rs:401-432`) assert the same literal vectors
from `docs/mc-host-wire-protocol.md:180` and `:182`; only the peer's runs. Per
METHOD.md rule 3 both disagreements are recorded with each side cited and neither
is resolved in the comment's favour.

### Coverage: the two halves of one protocol have opposite CI status

There are **51 in-crate tests** across the five scope files: 22 in `instance.rs`,
12 in `setup_socket.rs`, 11 in `auth.rs`, 4 in `connection_file.rs`, and 2 in
`packages/mc-shm-native/src/setup.rs`. Counts re-derived at `HEAD` by matching
`#[test]` and `#[tokio::test]` per file. **49 of them never run.**

The exclusion is structural, and so is the inclusion. Every `-p mc-host` test
invocation in `ci.yml` carries a `--test <name>` filter, which selects one
integration binary and does not build the lib target, so the 386-line test module
in `setup_socket.rs:441-826` and the other three `mc-host` modules are never
compiled in CI. The peer half is in a different crate, and `ci.yml:177` runs
`cargo nextest run -p mc-shm-native -p mc-shm-transport` **unfiltered** on Linux
with `cargo nextest run -p mc-shm-native` likewise unfiltered on macOS (`:184`).
So the 2 tests in the peer's `setup.rs` do run while the 11 in `auth.rs` that pin
the same proof construction on the host side do not.

**There is no other source-resident check.** `ci.yml:190` runs
`cargo test -p mc-host --doc`, but this sub-part has zero doctests: a grep for
`/// ``` ` and `//! ``` ` fences across `setup_socket.rs`, `auth.rs`,
`instance.rs` and `connection_file.rs` returns zero in each file, verified at
`HEAD`. The one `debug_assert!` in scope (`instance.rs:592-595`) is compiled out
of release builds and lives in a module CI does not build, so it fires nowhere in
CI either.

Six of the crate's 24 integration binaries reach this boundary, and the split runs
against the claims. **Three are named in CI and three are not.** `lifecycle.rs`
(35 tests, `ci.yml:179`, `:187`), `client.rs` (6, `:132`, `:179`, `:187`) and
`shm_failure_modes.rs` (6, `:133`) are named. `instance_security.rs` (15),
`host_roundtrip.rs` (4) and `activation.rs` (4) are named in no workflow, and
grepping all five workflow files for those three names returns nothing. Those
three unnamed binaries are the sole homes of descriptor-anchored discovery,
symlink and replacement safety, fenced shutdown removal, credential rotation, and
the normative startup order. Nothing else covers any of them.

## Index

14 records, listed in the order lens A discovered them. The group sections below
re-present the same 14 by shared mechanism, so section order and index order
differ deliberately; every record appears exactly once in each.

| Slug | Type | Confidence |
| --- | --- | --- |
| [setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof](#setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof) | safety | high |
| [setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token](#setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token) | safety | high |
| [setup-a-a-captured-client-proof-never-authenticates-twice](#setup-a-a-captured-client-proof-never-authenticates-twice) | safety | high |
| [setup-a-credentials-do-not-survive-a-host-incarnation](#setup-a-credentials-do-not-survive-a-host-incarnation) | safety | high |
| [setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it](#setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it) | safety | high |
| [setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid](#setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid) | safety | high |
| [setup-a-a-hostile-occupant-of-the-socket-path-fails-closed](#setup-a-a-hostile-occupant-of-the-socket-path-fails-closed) | safety | high |
| [setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof](#setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof) | safety | high |
| [setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released](#setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released) | safety | high |
| [setup-a-an-abandoned-setup-strands-no-ring-charge](#setup-a-an-abandoned-setup-strands-no-ring-charge) | safety | medium |
| [setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable](#setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable) | safety | high |
| [setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection](#setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection) | safety | high |
| [setup-a-only-an-authenticated-grant-enters-the-native-channel-registry](#setup-a-only-an-authenticated-grant-enters-the-native-channel-registry) | safety | high |
| [setup-a-concurrent-setup-saturation-is-reached](#setup-a-concurrent-setup-saturation-is-reached) | reachability | high |

Distribution: 13 `safety` and 1 `reachability`; 13 `always` and 1 `sometimes`; all
14 `default-production`; 13 high confidence and 1 medium. There is no `liveness`
record and no `unreachable` record, which lens A surfaced as a bias against its
own output rather than as a property of the subject. The absence is carried
forward for the portfolio evaluation and is discussed in the relationship map.

**Group names below are this synthesis's, not the lens's.** Lens A produced 14
numbered records with no grouping. The five groups are chosen by the mechanism
that would break, because that is what decides which oracle subsumes which.

---

## Group S1: the one authorization gate and what possession of the key buys

Three records on the single `if auth.is_err()` at `connection.rs:130-133` and on
what the code does immediately after it. The first is the ordering invariant that
no descriptor precedes a verified proof. The second is the consequence nobody
wrote down, that once the proof lands the descriptors are unconditional, so the
activation token gates the host's acknowledgement and not the peer's capability.
The third is what the token does still buy: it distinguishes the peer that
received a grant from any other authenticated peer, one connection at a time.

They are grouped because they are three readings of one straight-line sequence,
`connection.rs:120-170` into `setup_socket.rs:249-284`, and because the second and
third are the two halves of the doc's "one-use activation token" claim
(`docs/mc-host-wire-protocol.md:561`): the mechanism is real, and it is structural
rather than a consumed nonce.

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
Confidence: high — [evidence](evidence/setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof.md).
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
Confidence: high — [evidence](evidence/setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token.md).
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
Confidence: high — [evidence](evidence/setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it.md).
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


## Group S2: credential freshness and the two directions of proof refusal

Three records on the proof itself, and they partition the three ways it can be
attacked. A captured `ClientAuth` replayed against the live host that produced it.
A whole connection-file snapshot replayed against a *later* incarnation of the
host. And an impostor listener at the published path trying to extract a
`ClientAuth` from an honest peer.

The mechanism under all three is that only the host's own randomness carries any
freshness burden. The `server_nonce` is drawn per handshake (`auth.rs:245`), the
key and daemon id are drawn per incarnation (`instance.rs:263-266`), and the
peer-supplied `client_nonce` is never inspected for freshness, uniqueness, or
non-repetition. `role` is inspected even less: it is parsed and discarded
(`auth.rs:70-83`). So the first two records are refusals the host performs and the
third is a refusal the *peer* performs, which is why the third is the only one of
the three whose existing tests are direct.

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
Confidence: high — [evidence](evidence/setup-a-a-captured-client-proof-never-authenticates-twice.md).
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
Confidence: high — [evidence](evidence/setup-a-credentials-do-not-survive-a-host-incarnation.md).
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
Confidence: high — [evidence](evidence/setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof.md).
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


## Group S3: the socket as a filesystem object

Two records on `bind_owner_only` (`setup_socket.rs:27-50`), the twenty-four lines
that decide whether the setup socket is reachable at all. They are the same
mechanism seen from the two sides of the `bind` call: what the socket looks like
after it exists, and what the function does about something that was already
there.

Both records have the same shape and the same weakness. Each rests on a
conjunction or an ordering that is correct today for a reason stated in a
*different* file, `instance.rs:571-572`'s unconditional `fchmod(0o700)` on the
parent directory, and neither file states that dependency. And in both records the
untested residue is the clause a reader would most expect to be load-bearing: the
pre-chmod window in one, the mode and owner clauses of the occupant gate in the
other.

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
Confidence: high — [evidence](evidence/setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid.md).
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
Confidence: high — [evidence](evidence/setup-a-a-hostile-occupant-of-the-socket-path-fails-closed.md).
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


## Group S4: bounded unauthenticated work, abandoned setups, and the sentinel

Four records on resource accounting across the boundary, plus the coverage marker
that keeps three of them from passing vacuously.

The three substantive records follow one connection's charge from accept to death.
`runtime.rs:1035-1040` takes an unauthenticated handshake permit before spawning
anything, bounded at `max_handshakes` = 32 (`config.rs:128`). The swap at
`connection.rs:137-141` acquires the *connection* permit before releasing the
handshake permit, bounded at `max_connections` = 64 (`config.rs:129`), which is why
the post-auth descriptor transfer and its 2-second `transport_setup_deadline`
(`config.rs:227`) are charged to 64 rather than to 32. Then the prepared ring's own
charge must come back on every abandoned exit, and finally the post-commit
sentinel must stay cheap for the whole life of an idle connection.

The fourth record is the reason the other three are here as a group rather than
scattered. It is the part's only `reachability` record and its only `sometimes`
check, and it exists because the two existing saturation tests pin
`max_handshakes` to 1 (`tests/lifecycle.rs:239`) and 4 (`:339`) and use squatters
that never speak, so no campaign has yet produced two overlapping setups. Without
that state, the bounding record, the token-scoping record in Group S1, and the
charge-release record here can all pass on a run that never ran two setups at
once.

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
Confidence: high — [evidence](evidence/setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released.md).
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
Confidence: medium — [evidence](evidence/setup-a-an-abandoned-setup-strands-no-ring-charge.md).
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
Confidence: high — [evidence](evidence/setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable.md).
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
Confidence: high — [evidence](evidence/setup-a-concurrent-setup-saturation-is-reached.md).
Verified: the two existing saturation tests set `max_handshakes` to 1
(`tests/lifecycle.rs:239`) and 4 (`:339`) and both use squatters that never
speak (`:243-244`, `:355-357`), so neither can populate the second clause.
Existing check: none. The two lifecycle tests establish the first clause only.
Impact: without this marker the bounding and scoping records can pass on a
campaign that never ran two setups at once, which is the same vacuity Part 1's
Group M records were introduced to prevent.
Open questions: None.

## Group S5: the two peer halves and the inverted asymmetry

Two records on the far side of the boundary, and they are the part's two
`Exercised: not yet` records with no partial credit at all.

The first is the parity claim `docs/mc-host-shm-transport.md:83` makes, that
"Managed Rust clients use the same setup protocol, ring profile, wire version, and
descriptor schema." Three concrete divergences say otherwise, and one of them is a
reversed predicate rather than a missing check. The second is narrower and
sharper: `attach` (`packages/mc-shm-native/src/lib.rs:491`) is a published napi
export that takes caller-supplied raw fd integers (`:510-513`) and reaches the
same thread-local channel registry as the authenticated `connect_setup` (`:571`),
with no `#[cfg(test)]` and no `#[doc(hidden)]`. Both are exposed in TypeScript
(`packages/mc-shm-native/index.ts:526-529`, `:531-534`) and only `connectSetup` is
used by the shipped frame channel (`shm-frame-channel.ts:77`).

They are grouped because they share one consequence: any argument of the form "the
peer must have authenticated to hold this ring" is unsound for an in-process
caller, and the boundary that would have caught a bad grant is now the *native*
one, which the managed Rust client does not go through.

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
Confidence: high — [evidence](evidence/setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection.md).
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
Confidence: high — [evidence](evidence/setup-a-only-an-authenticated-grant-enters-the-native-channel-registry.md).
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


## Relationship map

Grouped by shared mechanism rather than by the section headings above, because the
sharpest relationships cross groups. **Every dominance statement below is a
hypothesis** about which oracle subsumes which, offered to order the work, not a
verified claim. None has been tested, and for 12 of the 14 records no check
executes anywhere, so nothing here has been measured.

- **The gate, and the fact that nothing after it is a gate.**
  [setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof](#setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof),
  [setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token](#setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token),
  [setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it](#setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it).
  One sequence read three ways. The first record is the only one of the three whose
  failure is a boundary breach; the other two describe what the boundary does not
  cover. Hypothesis: the first *dominates neither*, because it constrains the
  ordering `auth` then `send_grant` and says nothing about what happens between
  `send_grant` and the token compare, which is exactly the window the second
  record is about. The token-scoping record is the one with genuine test leverage
  in this cluster, because it is the only one with a negative outcome the host
  emits, `SetupError::InvalidActivation` (`setup_socket.rs:275`), and that outcome
  has no test at all today: `stale_wire_or_descriptor_schema_is_invalid_identity`
  (`:725-765`) covers the wire-version and schema half of the same match arm and
  yields `InvalidIdentity` instead.

- **Only the host's randomness is fresh.**
  [setup-a-a-captured-client-proof-never-authenticates-twice](#setup-a-a-captured-client-proof-never-authenticates-twice),
  [setup-a-credentials-do-not-survive-a-host-incarnation](#setup-a-credentials-do-not-survive-a-host-incarnation).
  Two replay horizons over one construction. Within an incarnation the defence is
  the per-handshake `server_nonce` (`auth.rs:245`); across incarnations it is the
  per-start key and daemon id (`instance.rs:263-266`). Hypothesis: the
  incarnation record *dominates* the within-incarnation one for the specific
  mutation "the nonce became derived or counter-based", because rotating
  credentials would still refuse the old snapshot; it does **not** dominate for
  the mutation that matters more, a fixed nonce inside one incarnation, which
  rotation does nothing about. Both are cheap and neither is a substitute for the
  other. Note what the existing test does here:
  `repeated_handshakes_receive_fresh_server_nonces` (`auth.rs:924-939`) asserts
  distinctness, which a merely-incrementing counter satisfies, so it would survive
  the mutation the record exists to catch.

- **Two impersonations, in opposite directions.**
  [setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof](#setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof),
  [setup-a-a-hostile-occupant-of-the-socket-path-fails-closed](#setup-a-a-hostile-occupant-of-the-socket-path-fails-closed),
  [setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid](#setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid).
  Three records about one filesystem name. The occupant record is the host
  refusing to adopt whatever is already at the path; the mode record is the host
  not leaving a window at the path it just created; the rogue-listener record is
  the peer refusing whatever answers at the path. Hypothesis: **no dominance in
  either direction**, and the interesting fact is the composition rather than any
  ordering. Neither peer checks the socket's owner, mode, or type before
  connecting (`client.rs:347`, native `setup.rs:106`), so the rogue-listener
  record is the *only* thing standing between a same-uid squatter and an honest
  peer's `ClientAuth`, and it is the one record in this cluster whose refusal
  reasons are individually tested (`auth.rs:1022-1073`, driven at `:1074-1081` and
  `:1082-1089`). The `daemon_ver` mismatch case is not visibly covered by either
  driver.

- **Every charge must come back, and the marker that proves anyone looked.**
  [setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released](#setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released),
  [setup-a-an-abandoned-setup-strands-no-ring-charge](#setup-a-an-abandoned-setup-strands-no-ring-charge),
  [setup-a-concurrent-setup-saturation-is-reached](#setup-a-concurrent-setup-saturation-is-reached),
  [setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it](#setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it).
  The reachability record is the load-bearing one, and it is load-bearing by
  being depended on rather than by dominating. Its own record says so: the
  bounding record, the token-scoping record, and the charge record are each
  vacuous unless two setups overlap, and with `max_handshakes = 1` they cannot.
  Hypothesis: the two saturation lifecycle tests
  (`tests/lifecycle.rs:237`, `:337`) establish the marker's first clause, permits
  exhausted, and cannot establish the second, a connection parked inside
  `activate_server`, because their squatters never authenticate. One harness
  change, a dialer that authenticates and then delays its `Activate` inside the
  2-second setup deadline, populates the second clause and serves all four
  records. That makes this the cheapest cluster in the part by leverage, and the
  fixture it needs is a small variation on one that already exists.

- **The one exit with no discard, and a question this part cannot answer.**
  [setup-a-an-abandoned-setup-strands-no-ring-charge](#setup-a-an-abandoned-setup-strands-no-ring-charge).
  Called out separately because it is the part's only medium-confidence record and
  the reason is a scope boundary, not a weak reading. Three of the four post-prepare
  exits pair `sender.discard()` with `root.cancel()` (`connection.rs:166-169`,
  `:180-185`). The fourth, the `prepare` timeout at `:157-164`, has no handle to
  discard, because the `PreparedRing` is dropped inside a detached `spawn_blocking`
  task tokio cannot abort. **Whether `Drop` alone releases the admission charge is
  a 2b question and is preserved as one here.** Part 1's
  `charge-release-never-silently-strands` is the neighbouring obligation. This
  catalog names the exit, requires the balance to be shown, and does not assert a
  verdict either way. One construction refinement over the lens: the exit needs no
  injected slowness, because `config.timing.transport_setup_deadline` is an
  ordinary config field that integration tests already set for its siblings
  (`tests/lifecycle.rs:165`, `tests/activation.rs:127-128`), so a near-zero
  deadline reaches it directly.

- **Two validation lists maintained independently, and one bypass around both.**
  [setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection](#setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection),
  [setup-a-only-an-authenticated-grant-enters-the-native-channel-registry](#setup-a-only-an-authenticated-grant-enters-the-native-channel-registry),
  [setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token](#setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token).
  The most important cluster here, and it is one finding attacked from three
  sides: **nothing downstream of the handshake can be relied on to have gone
  through the handshake.** The managed Rust peer omits checks the native peer
  performs and reverses one of them; `attach` reaches the registry with no
  handshake at all; and even on the authenticated path the descriptors precede
  validation. Hypothesis: making `attach` unreachable from the shipped wrapper
  would dominate the registry record and *nothing else*, because the managed Rust
  divergence is in a different crate and the descriptor-before-token order is in
  the host. Conversely, a single differential harness that runs one grant through
  both peer implementations and compares dispositions dominates the whole first
  record at once, and it is the same shape as Part 1's
  `native-boundary-not-weaker-than-its-wrapper`, whose method transfers directly
  even though its polarity no longer does.

- **The absence worth naming: no liveness record.**
  Lens A surfaced this against its own output and left it for synthesis, so it is
  answered here rather than silently inherited. This synthesis is **not** adding a
  liveness record, and the reason is that the candidate does not survive
  METHOD.md's liveness rule. "A stalled setup is torn down within
  `transport_setup_deadline`" is bounded by a wall-clock duration
  (`config.rs:227`), not by an attempt count or an explicit interval the code
  reasons about, and the part's one genuinely unbounded wait,
  `read_message_unbounded` (`setup_socket.rs:355-367`), is deliberately
  time-unbounded and bounded by cancellation instead, which is already the second
  clause of
  [setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable](#setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable).
  Writing "the sentinel task exits after `read_cancel` fires" as a separate
  liveness record would restate that clause with a generous timeout standing in
  for a bound, which the rule forbids. The distribution stays 13 `always` and one
  `sometimes`, and the bias is surfaced for the portfolio evaluation rather than
  papered over with a record that could not be refuted.
