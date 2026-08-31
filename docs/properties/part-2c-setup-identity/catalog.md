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

**A fourth refinement, on the native addon's line numbers, now applied to the
record text.** Two records cited `packages/mc-shm-native/src/lib.rs` a few lines
off. The earlier revision of this catalog recorded the corrections here and left
the record text alone, on the reasoning that the records were carried verbatim
from lens A. That was the wrong call: METHOD.md rule 1 requires the reference to
be corrected where it is written, and leaving a known-wrong number in a `Check:`
line sends a later reader to the wrong predicate. **The corrections are applied in
the records now, and this paragraph records what moved.** Re-derived at `HEAD` and
re-verified by grep for this disposition: in `attach` (`:491`) the
aliased-fd-or-grant rejection is `:533-535` (lens A: `:534-537`) and the
`GrantReservation::claim` is `:540-543` (lens A: `:539-549`); in `connect_setup`
(`:571`) the equal-grant rejection is `:588-590` (lens A: `:582-584`) and the
claim is `:591-594` (lens A: `:585-588`). The two registry insertion sites are the
`insert_channel` calls at `:551` and `:612`, not the `:550-556` and `:589-596`
ranges the records named; `:655` and `:672` are two further calls inside
`create_test_pair` (`:631`), which is a separate surface. Every finding the two
records state is unaffected: both predicates, both claims, and both insertion
sites exist where the records say they do in structure, and the counts are
unchanged.

## What this part is about

Seven facts frame every record below. They are stated with evidence because
several of them read as design decisions until the line is opened. One caution
about that framing, applied throughout after an independent evaluation refuted its
earlier form: **"undocumented" is a claim under test like any other, and the first
of the seven turned out to be documented.** Where a fact below is documented
design, the doc is cited and the record is a regression property rather than a
finding.

**Authority to map shared memory is possession of a 32-byte key and nothing
else, and this is documented design rather than a gap.** State the second half
first, because an earlier revision of this catalog did not and the framing was
refuted. `docs/mc-host-wire-protocol.md:27` says it outright: "The 32-byte
connection key is a bearer capability. Possession grants every direct-profile
operation ... Client `role`, `consumer_identity`, `project_root`, `harness`, and
`session` are claims or scoping metadata; none grants authority." The code says the
same thing in the same words. `Authenticated`'s doc comment (`auth.rs:70-81`) is a
deliberately empty struct explaining that "WHAT THIS PROVES: the peer possesses the
connection key ... Nothing more", and that `ClientHello.role` "is parsed and then
discarded — any peer holding the key can claim any role, so it must never decide
admission, capacity, or privilege". So there is **no second factor to bypass**, and
nothing below should be read as reporting one. What follows is the mechanism, which
is worth pinning against regression precisely because it is intended. The only gate
on the accept path is the `if auth.is_err() { return; }` at
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
`:540-543` and `:591-594` take a process-wide `GrantReservation::claim`. Those four
native line ranges are the corrected ones. The
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

16 records, listed in the order lens A discovered them, with the two records the
portfolio disposition added placed beside their siblings. The group sections below
re-present the same 16 by shared mechanism, so section order and index order
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
| [setup-a-an-abandoned-setup-strands-no-ring-charge](#setup-a-an-abandoned-setup-strands-no-ring-charge) | safety | high |
| [setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline](#setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline) | liveness | high |
| [setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap](#setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap) | safety | high |
| [setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input](#setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input) | liveness | high |
| [setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection](#setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection) | safety | high |
| [setup-a-only-an-authenticated-grant-enters-the-native-channel-registry](#setup-a-only-an-authenticated-grant-enters-the-native-channel-registry) | safety | high |
| [setup-a-concurrent-setup-saturation-is-reached](#setup-a-concurrent-setup-saturation-is-reached) | reachability | high |

Distribution after the portfolio disposition in
[portfolio-evaluation.md](portfolio-evaluation.md): **13 `safety`, 2 `liveness`, 1
`reachability`**; **15 `always` and 1 `sometimes`**; 16 high confidence and 0
medium. Reachability classes are 15 `default-production` plus one record whose
subject is a published export **compiled with no shipped-plugin caller**
(`setup-a-only-an-authenticated-grant-enters-the-native-channel-registry`); each
label carries its own evidence on the record, per METHOD.md rule 4.

Before the disposition this read 13 `safety` and 1 `reachability`, 13 `always` and
1 `sometimes`, all 14 `default-production`, with 1 medium confidence, **and no
`liveness` record at all**. That absence was defended in the relationship map on a
misreading of METHOD.md's liveness rule and has been corrected: the rule admits a
deadline as a bound, so the rejected candidate is now
[setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline](#setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline),
and the cancellation clause that had been smuggled into the sentinel safety record
is now [its own liveness record](#setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input)
with an explicit bound. There is still no `unreachable` record, and that remains
correct rather than a gap: no record here is about a forbidden code location.

**Group names below are this synthesis's, not the lens's.** Lens A produced 14
numbered records with no grouping. The five groups are chosen by the mechanism
that would break, because that is what decides which oracle subsumes which.

---

## Group S1: the one authorization gate and what possession of the key buys

Three records on the single `if auth.is_err()` at `connection.rs:130-133` and on
what the code does immediately after it. The first is the ordering invariant that
no descriptor precedes a verified proof. The second is the documented consequence
of a bearer-capability model, that once the proof lands the descriptors are
unconditional, so the activation token gates the host's acknowledgement and not the
peer's capability. The third is what the token does still buy: it distinguishes the
peer that received a grant from any other authenticated peer, one connection at a
time.

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
Guarantee: The activation token is not a mapping gate, and is not intended to be
one. A peer that has proved key possession can map the ring whether or not it ever
presents a correct token, and no host-side check between message 3 and message 4
can refuse it.
Check: `always` — for a peer that authenticates and then sends nothing, a wrong
token, or a truncated `Activate`, the two descriptors it already holds still map
successfully. Stated as `always` because it is a standing property of the message
order at `setup_socket.rs:249-276` rather than an occasional outcome.
**This is a regression property over documented design, not a report of a
second-factor bypass**, and an earlier revision of this record read as the latter.
The bearer-capability model is stated in `docs/mc-host-wire-protocol.md:27` and
restated in `auth.rs:70-81`, which says the handshake proves key possession and
"Nothing more". So the check is not "the token fails to gate mapping" — nothing
claims it does — but "the relationship between key possession and mapping
authority is still exactly one-to-one", which a future refactor could silently
break in either direction: by making a token check appear to gate mapping when it
runs after the descriptors are gone, or by admitting a peer that never proved key
possession at all.
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
Impact: the security argument for the setup socket rests on the connection file's
`0600` mode and the runtime directory's `0700` mode, which is what a bearer-key
model implies and what `docs/mc-host-wire-protocol.md:27` says: a key reader "MUST
therefore be trusted as the same local security principal as the host". The
consequence worth guarding is forward-looking rather than current. Any future
design that treats the token as a second factor — to fence a compromised key, for
example — would be relying on a check that runs after the asset is gone, and the
message order makes that mistake easy to make and hard to see. That is what this
record protects against, and it is the whole of its claim.
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

Six records on resource accounting across the boundary, plus the coverage marker
that keeps three of them from passing vacuously. This group grew by two under the
portfolio disposition: it gained the deadline record the earlier revision rejected,
and it gained the sentinel's cancellation clause as a record of its own.

The five substantive records follow one connection's charge from accept to death.
`runtime.rs:1035-1040` takes an unauthenticated handshake permit before spawning
anything, bounded at `max_handshakes` = 32 (`config.rs:128`). The swap at
`connection.rs:137-141` acquires the *connection* permit before releasing the
handshake permit, bounded at `max_connections` = 64 (`config.rs:129`), which is why
the post-auth descriptor transfer and its 2-second `transport_setup_deadline`
(`config.rs:227`) are charged to 64 rather than to 32. Then the prepared ring's own
charge must come back on every abandoned exit, and the same deadline bounds how
long a stalled peer can hold that ring at all — those two are the group's pair on
the same window, one about whether the charge returns and one about when. Finally
the post-commit sentinel must stay cheap for the whole life of an idle connection,
which splits into a length cap that is a safety invariant and an exit-on-cancellation
obligation that is a liveness one; the earlier revision carried both in one record
and the liveness half therefore carried no bound.

The last record is the reason the others are here as a group rather than
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
Reachability: default-production — `ring.prepare` runs on every authenticated
connection (`connection.rs:148`) and all four post-prepare exits are on that
ungated path; `transport_setup_deadline` ships with a 2-second default
(`config.rs:227`).
Status: active
Exercised: partial — SIGKILL after `receive_grant` is covered; the `prepare`
timeout path is not, and reaching it is a race rather than a configuration (see
`Required faults`).
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
**That exit does release the charge, and the mechanism is now established rather
than deferred to 2b.** Dropping the `PreparedRing` drops the `FrameSender` it
carries (`frame_channel.rs:685-694`), which is the sole holder of the queue's
`mpsc::Sender`, so the endpoint thread's `queue.recv()` returns `None` and
`run_endpoint` returns (`ring_transport.rs:437-440`). Control then reaches
`admission.release()` at `ring_transport.rs:291`, which sits outside the
`catch_unwind` at `:279-290` and runs on every exit. The `Admission` guard's own
`Drop` (`profile.rs:581-586`) is the backstop rather than the mechanism. So the
obligation this record states is met on all four exits, and the record is a
regression property rather than an open question about one of them.
Required faults and enabling state: three exits need a peer that stalls after
`receive_grant`, which `shm_failure_modes.rs:44-58` already builds. The fourth
needs `ring.prepare` to miss `transport_setup_deadline`, and **a near-zero
deadline does not deterministically force it.** `timeout_at(Instant::now() +
deadline, prepared)` races a timer against a `spawn_blocking` task that may
already have completed, so a fast `prepare` wins and the connection proceeds
normally; the test would pass having exercised the wrong path and would flake in
both directions. Reaching it deterministically needs either injected slowness
inside `prepare` — which is 2b's R1 and has no seam — or a barrier that holds the
blocking task past the deadline. That is why this record stays `partial`.
Confidence: high — [evidence](evidence/setup-a-an-abandoned-setup-strands-no-ring-charge.md).
Verified by inspection: the discard-and-cancel pairs at `connection.rs:166-169`
and `:180-185`, and their absence at `:157-164`. Verified for this disposition and
previously recorded as unverified: `FrameSender` holds the queue's only
`mpsc::Sender` (`frame_channel.rs:685-694`), `run_endpoint` returns when
`queue.recv()` yields `None` (`ring_transport.rs:437-440`), and
`admission.release()` at `:291` is unconditional and outside the `catch_unwind`.
Part 1's `charge-release-never-silently-strands` remains the neighbouring
obligation.
Existing check: `crates/mc-host/tests/shm_failure_modes.rs:232-245`
`setup_active_and_idle_sigkill_each_return_exact_capacity` and `:247-263`
`repeated_crashes_do_not_ratchet_single_connection_capacity` cover a killed peer
in the `setup` role, which is the post-grant pre-activation state. Neither
reaches the `prepare` timeout. Status unaudited.
Impact: with `max_connections = 1` a single stranded charge is a permanent
denial. The existing tests were written for exactly that reason, so the
uncovered exit is a gap in an otherwise deliberate campaign. What the mechanism
above changes is the shape of the gap: the risk is not that the charge is
stranded today, it is that the only thing returning it on that exit is a
channel-closure side effect three files away, which a refactor that gave the
endpoint thread another sender clone would silently remove.
Open questions:
- Should the `prepare`-timeout exit cancel the ring it abandoned explicitly,
  rather than relying on sender-drop closing the queue? The behaviour is correct
  today and the coupling is implicit. 2b records the same question from the
  transport side under
  `ring-a-ring-unavailability-fails-closed-without-a-classified-reason`.


### setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline

Type: liveness
Reachability: default-production — `activate_server` is called at
`connection.rs:170-179` on every authenticated connection and is passed
`shared.timing.transport_setup_deadline` (`:177`), which ships at 2 seconds
(`config.rs:227`). No opt-in and no alternative branch.
Status: active
Exercised: not yet — the existing stalling peer (`shm_failure_modes.rs:44-58`)
parks on `std::future::pending()` forever and the test asserts capacity return, so
nothing asserts that the host tore the setup down or when.
Guarantee: A peer that authenticates and then stalls anywhere in the post-grant
setup exchange has its connection torn down, and its handshake and connection
permits and ring charge released, within one `transport_setup_deadline` of the
grant send.
Check: `always` — evaluated at the close of an explicit bounded window. Drive a
peer that authenticates, calls `receive_grant`, and then sends nothing; **stop all
peer activity**, which is what makes the window fault-free; then poll until the
host has released the connection and assert it happened within
`transport_setup_deadline` measured from the deadline anchor. The bound is stated
in the unit the code bounds, a **single absolute deadline**:
`activate_server` computes `deadline = Instant::now() + timeout` **once**
(`setup_socket.rs:246-248`) and threads that same `Instant` through every
subsequent I/O — `send_grant` (`:249-260`), the `Activate` read (`:261`), the
`Activated` write (`:273`), the `Commit` read (`:281`), and the `Committed` write
(`:282`) — and `read_message` enforces it with `timeout_at` on **both** its
`read_exact` calls (`:374-376`, `:382-384`). So there is no accumulation across
messages: a peer that stalls at any of the four message positions, or at three of
four length bytes, is refused at the same wall-clock instant. `always` because the
bound must hold every time the window closes.
Fault/timing angle: the interesting property is that the deadline is *absolute
and shared*, not per-message. A per-message timeout would let a peer that
dribbles one byte per interval hold the setup open indefinitely; this construction
forbids that by design, and the property is that the single-anchor construction
does not regress into a per-read one. The teardown that follows is
`connection.rs:180-185`: `activate_server` returning `Err` runs `sender.discard()`
and `root.cancel()` and returns, which drops the permits and releases the ring
charge through the mechanism recorded in
[setup-a-an-abandoned-setup-strands-no-ring-charge](#setup-a-an-abandoned-setup-strands-no-ring-charge).
Required faults and enabling state: a peer that authenticates and then stalls in
the setup exchange. `tests/shm_failure_modes.rs:44-58` already builds exactly this
peer against a real host and runs in CI (`ci.yml:133`); the missing part is an
assertion on *when* the host gave up, not a new fixture. A shortened
`transport_setup_deadline` through `TestHost::start_with` makes the window cheap to
observe, and unlike the `prepare`-timeout exit this needs no race: the peer's
silence, not a scheduling outcome, is what makes the deadline fire.
Confidence: high — [evidence](evidence/setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline.md).
**Evidence file written**: this record was added by the portfolio
disposition, which was scoped to `catalog.md`, `fault-map.md`, and
`portfolio-evaluation.md` and forbidden from writing under `evidence/`. The link is
written to the schema's target so it resolves once the file lands, and the gap is
recorded in the process caveat of
[portfolio-evaluation.md](portfolio-evaluation.md). Everything the file would hold
is verified and stated here.
Verified: the single `deadline` computation at `setup_socket.rs:246-248` and its
reuse at `:249-260`, `:261`, `:273`, `:281`, and `:282`; `read_message`
(`:369-386`) wrapping both reads in `timeout_at(deadline, ..)` and mapping expiry
to `SetupError::Timeout`; `activate_server` being called with
`shared.timing.transport_setup_deadline` at `connection.rs:177`; the default of 2
seconds at `config.rs:227`; and the discard-and-cancel teardown at
`connection.rs:180-185`.
Existing check: none. `tests/shm_failure_modes.rs:232-245`
`setup_active_and_idle_sigkill_each_return_exact_capacity` asserts capacity returns
after a killed peer, which is a different exit and carries no timing claim.
Status unaudited.
Impact: **this is the part's only bound on how long an authenticated peer can hold
a prepared ring without completing setup**, and the resource it holds is the
expensive one. `setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released`
records that the post-auth setup window is charged to `max_connections` (64) rather
than to `max_handshakes` (32), and its own open question observes that 64
concurrent stalled setups each hold a prepared ring. Whether that is 2 seconds of
exposure or unbounded exposure is exactly this record, and nothing else in the
catalog states it.
Open questions:
- Should the post-grant exchange have a tighter deadline than the pre-grant one?
  Both halves currently share `transport_setup_deadline`, but only the post-grant
  half holds a prepared ring. (needs human input)


### setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap

Type: safety
Reachability: default-production — `observe_peer` runs for the whole life of
every activated connection (`connection.rs:196-206`), reached unconditionally
after commit; `MAX_SETUP_MESSAGE_LEN` is a compile-time constant
(`setup_socket.rs:24`) with no configuration behind it.
Status: active
Exercised: partial — the two `PeerClose` outcomes are tested; the cap is not.
Guarantee: The post-commit sentinel read never allocates more than
`MAX_SETUP_MESSAGE_LEN`, whatever length the peer declares.
Check: `always` — declare a length of `u32::MAX` and assert
`SetupError::MessageTooLarge` with no allocation of that size. `always` because it
must hold on every sentinel read.
**This record was split under the portfolio disposition.** It previously carried a
second clause, "and it always yields to `read_cancel`", which is a liveness
obligation about eventual task exit rather than a safety invariant about
allocation, and METHOD.md's schema gives each record exactly one `Type`. That
clause is now
[setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input](#setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input),
with an explicit bound, because smuggled into a safety record it had no bound at
all.
Fault/timing angle: none for the cap itself; the check at
`setup_socket.rs:361-363` precedes the allocation at `:364`, so the ordering is
straight-line and the property is that the ordering does not regress.
Required faults and enabling state: a peer that completes commit and then sends a
huge length prefix.
Confidence: high — [evidence](evidence/setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable.md).
Verified: the cap at `setup_socket.rs:361-363` precedes the `vec![0u8; len]` at
`:364`, and `MAX_SETUP_MESSAGE_LEN` is `16 * 1024` (`:24`).
Existing check: `setup_socket.rs:810-825`
`goodbye_and_eof_have_distinct_outcomes` covers the `Goodbye` and EOF
classifications. `:599-651` `activation_and_commit_complete_on_setup_socket`
covers the `ProtocolError` classification. None covers the cap. Status unaudited.
Impact: the cap is the only thing between a post-commit peer and a 4 GiB
allocation, on a read that has no deadline at all, so it is what keeps an idle
authenticated connection cheap.
Open questions:
- Should `read_message_unbounded` be renamed to say what it actually is,
  time-unbounded and length-capped? The current name invites the exact wrong
  conclusion, and the re-scope document drew it. (needs human input)


### setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input

Type: liveness
Reachability: default-production — the sentinel task is spawned for every
activated connection (`connection.rs:195-207`) and `read_cancel` is the
generation's own child token, cancelled on every close path including peer death
(`:203-204`) and generation teardown.
Status: active
Exercised: not yet — no test parks the sentinel and then cancels it. The two
`PeerClose` outcomes that are tested (`setup_socket.rs:810-825`) both arrive
through the peer rather than through cancellation.
Guarantee: Once `read_cancel` fires, the sentinel task completes without requiring
any further byte from the peer, even when it is parked mid-message.
Check: `always` — evaluated at the close of an explicit bounded window. Park the
sentinel by sending three of the four length-prefix bytes and stopping, cancel
`read_cancel`, **send nothing further**, then poll the generation's tracked task
set until it is empty and assert it emptied. The bound is stated in the unit the
code bounds, which is a **cancellation edge and one poll of a `biased` select**,
not a duration: `connection.rs:196-206` is `tokio::select!` with `biased` and
`peer_read_cancel.cancelled()` as its **first** arm (`:198`), so the cancellation
branch is chosen the next time the task is polled and the `observe_peer` future is
dropped where it stands. The polling cap is a test parameter and must be stated as
an explicit attempt count in the test, not as a generous timeout.
**This record exists because an earlier revision rejected it on a misreading of
METHOD.md, and the misreading is corrected here.** That revision argued no liveness
record could be written for this part because the available bounds are wall-clock
durations, "not an attempt count or an explicit interval the code reasons about".
METHOD.md's liveness rule says the opposite in its own words: "State the bound in
the units the code actually bounds: attempts, deadlines, or an explicit interval."
A deadline is an admissible bound. What the rule forbids is an unbounded
"eventually" and a generous timeout standing in for a bound, neither of which this
check or its sibling below uses.
Fault/timing angle: the whole property. `read_message_unbounded`
(`setup_socket.rs:355-367`) has no deadline, so a peer that sends a partial length
prefix and stops parks the read forever. That is intentional: the sentinel's
purpose is to notice the peer, and its bound is cancellation rather than time. The
name is the hazard, not the behaviour, and it resolves the re-scope open question at
`part-2-rescope/scope-map-and-risk-ranking.md:744-746`. The consequence is that
cancellation is the **only** exit from a parked sentinel, so if the `biased`
ordering were lost or the first arm removed, an idle connection would hold a task
and a socket until the peer chose to release them.
Required faults and enabling state: a peer that sends a partial length prefix and
then stalls, plus a cancellation of `read_cancel` while it is parked. Both halves
are in-process over a `UnixStream::pair`, the shape `setup_socket.rs:810-825`
already uses.
Confidence: high — [evidence](evidence/setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable.md).
Verified: `read_message_unbounded` (`:355-367`) applies no `timeout_at`, unlike
`read_message` (`:369-386`) which wraps both `read_exact` calls; the `select!` at
`connection.rs:196-206` is `biased` with `peer_read_cancel.cancelled()` first
(`:198`); `observe_peer` is `setup_socket.rs:345-353`. **Note the shared evidence
file:** this record and its safety sibling both link
`evidence/setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap-and-stays-cancellable.md`
so no link breaks, and that file needs splitting into two.
Existing check: none. `setup_socket.rs:810-825`
`goodbye_and_eof_have_distinct_outcomes` reaches `observe_peer` but always through
a peer-driven outcome, never through cancellation. Status unaudited.
Impact: this is the exit that makes an idle authenticated connection releasable on
the host's own schedule. Without it, teardown of a connection whose peer has gone
quiet mid-message depends on the peer, which is the one party a teardown path must
not depend on.
Open questions: None.


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
process-wide claim (`lib.rs:591-594` in `connect_setup`, `:540-543` in `attach`).
`always` because it is a per-descriptor invariant, the same shape as Part 1's
`native-boundary-not-weaker-than-its-wrapper`.
Fault/timing angle: none temporal. The exposure is a divergence in two
independently maintained validation lists.
Required faults and enabling state: a host, or a stand-in, that emits a grant
naming two identical grant strings, or a second concurrent attach of the same
grant in one process.
Confidence: high — [evidence](evidence/setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection.md).
Verified: two divergences, with the native-side line numbers corrected from lens A
per the provenance note above. First, `ring_transport.rs:646-650` compares
`from_host_grant.geometry() != to_host_grant.geometry()` and rejects on
*inequality*, whereas native `setup.rs:122` and `lib.rs:588-590` reject on grant
*equality*; the two checks are not the same predicate and the managed path admits
the aliased pair the native path refuses. Second, native `lib.rs:540-543`
(`attach`) and `:591-594` (`connect_setup`) take a process-wide
`GrantReservation::claim`; the managed Rust path takes no claim at all. `setup_socket.rs:302-306`, the managed peer's setup step,
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
Reachability: default-production for `connect_setup` (`lib.rs:571`), which the
shipped plugin reaches through `NativeChannel.connectSetup`
(`packages/mc-shm-native/index.ts:531-534`) from `shm-frame-channel.ts:77`.
**`attach` is compiled and exported with no shipped-plugin caller**, and that is
stated rather than defaulted: `attach` (`lib.rs:490-491`) carries no
`#[cfg(test)]` and no `#[doc(hidden)]`, `NativeChannel.attach` exports it at
`index.ts:526-529`, and a grep of `packages/plugin/src` at `HEAD` for
`NativeChannel.attach` and `.attach(` returns **no non-test caller**. So the
export is production surface by visibility and unreached by the shipped path,
which is neither `default-production` nor `test-only` and is the reason the
guarantee below is scoped the way it is.
Status: active
Exercised: not yet — no test asserts the shipped wrapper never reaches `attach`.
Guarantee: **In the shipped plugin path**, every channel inserted into the native
registry originates from `connect_setup`, which authenticated over the setup
socket, and never from `attach`, which takes caller-supplied descriptors and
authenticates nothing.
Check: `always` — instrument both insertion sites, the `insert_channel` calls at
`lib.rs:551` (from `attach`) and `:612` (from `connect_setup`), and assert that a
full shipped-plugin run inserts only through `connect_setup`. `always` rather than
`unreachable` because `attach` is a published export that tests and embedders may
legitimately call; the forbidden thing is a *state*, a registry entry with no
authenticated provenance, and METHOD's rule for a forbidden state with no
dedicated detection point is `always(!X)`.
**The scope of this guarantee is narrowed, and the narrowing matters.** An earlier
form of this record read as a claim over the addon as a whole. It cannot be one.
`attach` is a `#[napi]` export (`lib.rs:490-491`) reachable from any JavaScript in
the process, so no campaign can establish that *no* caller reaches it — a claim
universally quantified over the callers of a published API is not falsifiable by
running the shipped wrapper, and it is **false** as stated for an arbitrary
embedder, who may call `NativeChannel.attach` deliberately and correctly. What is
provable, and what this record now claims, is the narrower call-graph fact about
the **shipped plugin**: the only `NativeChannel` construction on the plugin's
frame-channel path is `connectSetup` (`shm-frame-channel.ts:77`), and a census
over `packages/plugin/src` finds no other. Stated plainly, so a later reader does
not recover the stronger claim: **an unauthenticated registry entry is reachable
in-process by design, and this property only says the shipped plugin does not
create one.**
Fault/timing angle: none. This is a call-graph property.
Required faults and enabling state: none beyond running the shipped plugin with
both sites instrumented.
Confidence: high — [evidence](evidence/setup-a-only-an-authenticated-grant-enters-the-native-channel-registry.md).
Verified: `attach` at `lib.rs:491` reads `hostToPeerFd` and `peerToHostFd` as
caller-supplied integers (`:510-513`) and never touches a socket;
`connect_setup` at `:571` calls `setup::connect` which performs the three-message
handshake (`setup.rs:107-113`). Both end in `insert_channel` on the same
`REGISTRY`, at `:551` and `:612`. `index.ts:526-529` and `:531-534` expose both;
`shm-frame-channel.ts:77` uses only `connectSetup`, and grepping
`packages/plugin/src` for any other `.attach(` call site returns nothing outside
tests.
Existing check: Part 1's `test-only-surface-absent-from-the-shipped-addon` is the
neighbouring property and should be checked for whether it already covers
`attach`. `attach` carries no `#[cfg(test)]` and no `#[doc(hidden)]`, so on the
face of it that record does not reach it. Status unaudited.
Impact: `attach` is an authenticated-path bypass reachable from JavaScript in the
same process. Under the same-uid trust model that is not a privilege escalation,
and it may well be intended surface — `create_test_pair` at `lib.rs:631` suggests
a test reading and a worker-thread re-attach reading is equally consistent with
the code. What it does mean, regardless of intent, is that **the setup socket is
not the only way into the ring**, so any reasoning of the form "the peer must have
authenticated to hold this ring" is unsound for in-process callers. That is the
consequence worth protecting against regression, and it is why this record stays
in the catalog after the narrowing.
Open questions:
- Is `attach` intended as production surface, test surface, or a
  worker-thread re-attach path? `create_test_pair` at `lib.rs:631` suggests the
  test reading. If it is test surface, the check strengthens to a build-time
  assertion that the shipped addon does not export it, which is Part 1's
  neighbouring record; if it is production surface, the narrowed guarantee above
  is the strongest form available. (needs human input)


## Relationship map

Grouped by shared mechanism rather than by the section headings above, because the
sharpest relationships cross groups. **Every dominance statement below is a
hypothesis** about which oracle subsumes which, offered to order the work, not a
verified claim. None has been tested, and for 14 of the 16 records no check
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

- **The one exit with no discard, and the question 2b has now answered.**
  [setup-a-an-abandoned-setup-strands-no-ring-charge](#setup-a-an-abandoned-setup-strands-no-ring-charge),
  [setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline](#setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline).
  Called out separately because it **was** the part's only medium-confidence record
  and the reason was a scope boundary rather than a weak reading. Three of the four
  post-prepare exits pair `sender.discard()` with `root.cancel()`
  (`connection.rs:166-169`, `:180-185`). The fourth, the `prepare` timeout at
  `:157-164`, has no handle to discard, because the `PreparedRing` is dropped inside
  a detached `spawn_blocking` task tokio cannot abort. **The 2b dependency is now
  closed and the record is `high`.** Dropping the `PreparedRing` drops the
  `FrameSender` it carries (`frame_channel.rs:685-694`), the sole holder of the
  queue's `mpsc::Sender`, so the endpoint thread's `queue.recv()` returns `None`,
  `run_endpoint` returns (`ring_transport.rs:437-440`), and `admission.release()`
  runs at `ring_transport.rs:291` outside the `catch_unwind`. Part 1's
  `charge-release-never-silently-strands` remains the neighbouring obligation.
  **What keeps the record partial is a different fact, and the lens's construction
  refinement was wrong about it.** That refinement said the exit "needs no injected
  slowness, because `config.timing.transport_setup_deadline` is an ordinary config
  field" (`tests/lifecycle.rs:165`, `tests/activation.rs:127-128`). Setting the
  field is indeed easy, but it does not *force* the timeout:
  `timeout_at(Instant::now() + deadline, prepared)` races a timer against a
  `spawn_blocking` task that may already have finished, so a fast `prepare` wins,
  the connection proceeds normally, and the test exercises the wrong path. The exit
  is reachable and not deterministically reachable, which are different claims.
  Hypothesis: the deadline record beside it *dominates nothing* here, because it
  bounds the post-grant exchange and this exit happens before the grant; the two
  are adjacent on the same config field rather than on the same window.

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

- **The absence that was not an absence: the two liveness records.**
  Lens A surfaced "no liveness record" against its own output and left it for
  synthesis. The earlier revision of this section answered it by declining to add
  one, on the reasoning that "a stalled setup is torn down within
  `transport_setup_deadline`" is "bounded by a wall-clock duration
  (`config.rs:227`), not by an attempt count or an explicit interval the code
  reasons about". **That reasoning was refuted by an independent evaluation and the
  refutation is correct.** METHOD.md's liveness rule names three admissible units
  and a deadline is the second of them: "State the bound in the units the code
  actually bounds: attempts, deadlines, or an explicit interval." What the rule
  forbids is an unbounded "eventually" and a generous timeout standing in for a
  bound. `transport_setup_deadline` is neither: it is a single absolute `Instant`
  the code computes once (`setup_socket.rs:246-248`) and enforces on every
  subsequent read and write, so it is a bound the code reasons about explicitly and
  in one place.
  So the part now has two liveness records, and they partition the two ways a
  stalled peer is released.
  [setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline](#setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline)
  is the deadline half, covering everything from the grant send to `Committed`.
  [setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input](#setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input)
  is the cancellation half, covering the one read that deliberately has no deadline
  (`read_message_unbounded`, `setup_socket.rs:355-367`), and its bound is a
  cancellation edge plus one poll of a `biased` select rather than any duration.
  Hypothesis: **no dominance in either direction**, and the reason is the reason
  they are two records. They bound different phases with different mechanisms, and
  the second was previously the trailing clause of a safety record where it had no
  bound at all — which is how a liveness obligation hides. Note what that means for
  the earlier revision's argument: it was right that restating the clause "with a
  generous timeout standing in for a bound" would violate the rule, and wrong to
  conclude that no bound existed. The bound is cancellation, and cancellation is
  observable.
