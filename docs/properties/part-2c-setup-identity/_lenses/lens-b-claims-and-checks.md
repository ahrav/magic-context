# Part 2c lens B: claim register and existing-check inventory

Attention focus: what the sub-part *promises*, and what mechanically holds each
promise. Claim sources are the doc comments in the scope files, the error and
close-reason strings they emit, `docs/mc-host-shm-transport.md`,
`docs/mc-host-wire-protocol.md`, and — per the task's additional instruction —
`packages/mc-shm-native/src/setup.rs` and its TypeScript wrapper
`packages/mc-shm-native/index.ts`, mined for claims about the boundary itself.
No property records; no evidence files. Method contract in
[../../METHOD.md](../../METHOD.md).

Scope: `crates/mc-host/src/setup_socket.rs` (826), `auth.rs` (1,112),
`instance.rs` (1,423), `connection_file.rs` (471), plus
`packages/mc-shm-native/src/setup.rs` (433) as the peer half. 3,832 in-crate
lines, 4,265 with the peer half; `wc -l` at `HEAD`.

Provenance. Code read from `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`. Every line
reference below was printed from that tree before being written.

**The headline of this lens is a claim with no implementing code, and it is a
doc comment rather than a document.** `auth.rs:693-698` states that the
TypeScript client asserts its handshake against the same fixed proof vectors, in
the file `packages/plugin/src/shared/mc-host-client/auth.test.ts`, and calls the
pair "a cross-language contract". That file does not exist. Neither does
`auth.ts`. Both were deleted by `ed487e11` — the same commit that made the ring
mandatory — at 365 and 314 lines respectively, verified with
`git show --stat ed487e11`. The only surviving trace is
`packages/plugin/dist/shared/mc-host-client/auth.d.ts`, an untracked build
artifact under a `dist/` path that `.gitignore:16` excludes. This is the
inversion the re-scope's peer-half assignment anticipated: authentication left
the managed TypeScript client and now lives in the native addon
(`packages/mc-shm-native/src/setup.rs:174-220`), so the doc comment's stated
enforcement mechanism is gone while its claim of cross-language pinning remains.
Recorded in full under "Documentation describing deleted mechanisms".

## Shared context, verified rather than restated

The re-scope's CI findings were re-derived, not copied; all hold. The
line-level refinements and the one correction are identical to those recorded in
the 2b sibling lens
([../../part-2b-ring-datapath/_lenses/lens-b-claims-and-checks.md](../../part-2b-ring-datapath/_lenses/lens-b-claims-and-checks.md)),
so they are stated once there and only the two facts that differ for this
sub-part appear here.

**First difference, and it is the sharpest structural fact in this inventory.**
The re-scope's rule that every `-p mc-host` run carries a `--test` filter is
confirmed, and it means the 49 in-crate tests across this sub-part's four
`mc-host` files never execute in CI. But the peer half is in a different crate,
and `ci.yml:177` runs `cargo nextest run -p mc-shm-native -p mc-shm-transport`
**unfiltered** on Linux, with `cargo nextest run -p mc-shm-native` likewise
unfiltered on macOS (`:184`). So the 2 in-crate tests in
`packages/mc-shm-native/src/setup.rs` — including the one that pins the
committed proof vectors — do run in CI, while the 11 in `auth.rs` that pin the
same construction on the host side do not. **The two halves of one
two-party protocol have opposite CI status.**

**Second difference.** `cargo test -p mc-host --doc` (`ci.yml:190`) executes the
lib target's doctests, but this sub-part has none: grepping `/// ```` and
`//! ```` across `setup_socket.rs`, `auth.rs`, `instance.rs` and
`connection_file.rs` returns zero fences. So unlike 2b, this sub-part has
**no source-resident check that CI executes at all** on the `mc-host` side.

The three findings the task asked this lens to engage were each verified.

- **The socket is mode `0600` applied after `bind`, and the three-clause occupant
  gate has only its regular-file branch tested.** Confirmed.
  `bind_owner_only` binds at `setup_socket.rs:44` and only then calls
  `set_permissions(0o600)` at `:45`, removing the socket if the chmod fails
  (`:46-47`). The safety argument rests on the parent directory: `instance.rs`
  applies `fchmod(0o700)` unconditionally to the validated runtime-directory
  descriptor at `:571-572` (the sibling's cited `:560-573` is the enclosing
  block, whose owner and directory-type checks are at `:561-570`). The occupant
  gate at `:30-32` is a conjunction of three clauses — `is_socket()`, `uid()`
  equals the effective uid, and `mode() & 0o777 == 0o600` — and the sole test
  (`insecure_stale_occupant_is_not_replaced`, `:494`) plants a regular file
  (`:497`), so only `is_socket()` is exercised. Engaged as claim C6 and quiet
  area Q2.
- **A granted descriptor is never revoked, and the activation token travels
  inside the grant so it cannot gate mapping.** Confirmed.
  `activate_server` puts the token in the `GrantMessage` that carries the two
  descriptors (`setup_socket.rs:249-260`, token at `:254`), and `send_grant`
  transfers both in one `sendmsg` with `SCM_RIGHTS` (`:151-159`). The host's own
  copies are dropped at `connection.rs:186`, after activation, and no code path
  reclaims the peer's copies. Engaged as claim C9 and lead L2.
- **The native-versus-managed asymmetry has inverted.** Confirmed, and it runs
  deeper than the deleted `auth.ts`. See claim C12 and lead L1: the *native*
  peer validates the ring profile and rejects identical grants
  (`packages/mc-shm-native/src/setup.rs:122`), while the *managed Rust* peer's
  `activate_client` validates neither (`setup_socket.rs:302-306`).

## Claims register

20 claims, ordered by consequence. `Where stated` is the claim source;
`Implementing code` is where the obligation is discharged, or `NOT FOUND`.

### C1 — the setup socket carries authentication and descriptor transfer only, and can never carry application frames

Where stated: `setup_socket.rs:3-5` ("This module deliberately has no dependency
on application frame types or decoders. Its closed message set ..."),
`docs/mc-host-shm-transport.md:5` ("Application frames never use the setup
socket"), `docs/mc-host-wire-protocol.md:28`, `:561` ("It has no
application-envelope decoder or router").

Implementing code: the closed message set at `setup_socket.rs:52-78` —
`GrantMessage`, `ClientMessage` (`Activate`/`Commit`/`Goodbye`), `ServerMessage`
(`Activated`/`Committed`) — plus the absence of any `crate::wire` frame import.
`ClientMessage` carries `deny_unknown_fields` (`:62`), so an unmodelled field is
rejected.

Existing check: `application_message_is_not_a_setup_message`
(`setup_socket.rs:569`). In-crate, never runs in CI.

### C2 — one absolute deadline bounds the whole handshake, not each stage

Where stated: `auth.rs:155-159`, explicitly reasoning about the failure mode —
"Passing a bare `Duration` to each step instead would let a slow peer spend the
full budget on every length read AND every body read — multiplying the real
bound" — and `docs/mc-host-wire-protocol.md:159` ("one absolute deadline across
every length read, body read, write, comparison, descriptor transfer, and
failed-handshake shutdown").

Implementing code: the `Deadline` type at `auth.rs:155-197`, with `remaining` at
`:178` and the clamped teardown variant at `:191-192`; the error-path teardown
policy at `:198-206`.

Existing check: `an_unrepresentable_auth_deadline_is_rejected_not_panicked`
(`auth.rs`, in the `#[cfg(test)]` module at `:633`) covers the fallible
constructor the doc comment justifies at `:167-170`. In-crate.

### C3 — the proof construction is `HMAC-SHA256(key, domain || client_nonce || server_nonce || daemon_id)`, pinned by committed vectors on both sides

Where stated: `docs/mc-host-wire-protocol.md:186-190` (the byte formula and the
worked vectors at `:176-184`), `auth.rs:398-403`
(`committed_wire_vectors_pin_the_proof_construction` "reddens for a constant
proof AND for one that folds only part of its input").

Implementing code: host side `auth::compute_proof` (exported at `lib.rs:42`);
peer side `proof` at `packages/mc-shm-native/src/setup.rs:222-235`, with the two
domain constants at `:20-21`.

Existing check: **both sides pin the same literal vectors, and only one side
runs in CI.** Host: `committed_wire_vectors_pin_the_proof_construction`
(`auth.rs`), in-crate, never in CI. Peer:
`auth_proofs_match_committed_wire_vectors`
(`packages/mc-shm-native/src/setup.rs:401-432`), which asserts the same 32-byte
arrays as `docs/mc-host-wire-protocol.md:180` and `:182`, and **does** run in CI
through `ci.yml:177` and `:184`. So the construction is CI-pinned, but only from
the peer's implementation.

### C4 — `role` is unverified reporting metadata and never grants authority

Where stated: `auth.rs:70-81`, at length: "`Authenticated` ... Deliberately
empty: everything else in the handshake transcript is client-asserted and
unverified. `ClientHello.role` in particular is parsed and then discarded — any
peer holding the key can claim any role, so it must never decide admission,
capacity, or privilege." Also `docs/mc-host-wire-protocol.md:190` and `:26-28`.

Implementing code: the empty `Authenticated` struct (`auth.rs:70` onward) and
`connection.rs:128-131`, which comments the same rule at the one place a role
could have branched. The peer sends the literal `role: "client"`
(`packages/mc-shm-native/src/setup.rs:187`).

Existing check: none direct. No test presents two different roles with the same
valid key and asserts identical admission. The claim is held by the type having
no fields.

### C5 — the 32-byte connection key is a bearer capability and every key reader is stop-capable

Where stated: `docs/mc-host-wire-protocol.md:26` — "Possession grants every
direct-profile operation — including host-global `host.shutdown` ... a
diagnostic or proxy principal that holds the bearer is not read-only, whatever
its role label or mount permissions claim."

Implementing code: this is a *negative* architectural claim: nothing in
`auth.rs` or `setup_socket.rs` narrows a key holder's authority, which is what
makes it true. `KEY_LEN` is `32` (`lib.rs:59-60`, from `connection_file.rs`) and
publication requires exactly 32 bytes.

Existing check: none. The claim's whole content is that no check exists, which
makes it unfalsifiable as written and a documentation-only obligation on
deployers.

### C6 — the setup socket is never connectable outside the owning uid

Where stated: `docs/mc-host-shm-transport.md:5` ("owner-only Unix setup
socket"), `docs/mc-host-wire-protocol.md:28`, `:157` ("owner-only setup
socket"), and the function name `bind_owner_only`.

Implementing code: `setup_socket.rs:27-50`. Note the order: the listener is bound
at `:44` and the mode narrowed at `:45`, so between those two lines the socket
exists at the umask-derived mode. The gate that makes the window safe is not in
this file — it is the unconditional `fchmod(&current, 0o700)` on the runtime
directory at `instance.rs:571-572`, reached through the validated,
`O_NOFOLLOW`-anchored descriptor the module doc describes at `instance.rs:4-7`.
The socket path is derived from that same directory at `runtime.rs:834` and
passed to `bind_owner_only` at `:836`.

Existing check: `setup_socket_is_owner_only` (`setup_socket.rs:481`) asserts the
final mode is `0o600` (`:490`). It cannot observe the pre-chmod window.
`restrictive_umask_preserves_required_owner_permissions`
(`tests/instance_security.rs:15`) and its subprocess child (`:34`) cover the
umask direction at the publication level. Both in-crate or in an unnamed binary.

### C7 — exactly two ring descriptors transfer, and duplicate, extra, missing or truncated ancillary data fails closed

Where stated: `docs/mc-host-shm-transport.md:42` ("Transfer exactly two mapping
descriptors"), `docs/mc-host-wire-protocol.md:561` ("transfers exactly two ring
mapping descriptors"), `:562` ("malformed ancillary data, duplicate or extra
descriptors ... retires the connection"), `setup_socket.rs:131` and `:177`.

Implementing code: `RING_DESCRIPTOR_COUNT = 2` (`setup_socket.rs:25`);
`receive_grant` checks `CTRUNC` at `:205-207`, zero bytes at `:208-210`, rejects
a non-`ScmRights` ancillary message at `:217`, under-count at `:220-222`,
over-count at `:223-225`, and sets `CLOEXEC` on each at `:226-228`. The receive
buffer is deliberately sized for `RING_DESCRIPTOR_COUNT + 1` (`:184`) so an
extra descriptor is *received and rejected* rather than silently truncated.

Existing check: four tests, the densest cluster in the sub-part —
`grant_transfers_exactly_two_descriptors` (`:451`),
`grant_without_ancillary_descriptors_is_rejected` (`:504`),
`grant_with_extra_descriptor_is_rejected` (`:518`),
`truncated_ancillary_data_is_rejected` (`:543`). All in-crate, none in CI.

### C8 — setup accepts only the release's current wire version, descriptor schema, and ring profile

Where stated: `docs/mc-host-wire-protocol.md:561` ("Setup accepts only the
release's current wire version, descriptor schema, and ring profile"),
`docs/mc-host-shm-transport.md:9-13` (the three fixed values),
`setup_socket.rs:287` ("the sole current ring").

Implementing code: **two of the three on the managed path, three of three on the
native path.** Host `activate_server` compares the presented wire version and
schema at `setup_socket.rs:266`. Managed `activate_client` checks wire version
and schema at `:302-306` and **does not check the profile**; the profile check
happens later, in 2b scope, at `ring_transport.rs:642-644`. The native peer
checks all three plus grant distinctness in one expression
(`packages/mc-shm-native/src/setup.rs:115-124`). See lead L1.

Existing check: `stale_wire_or_descriptor_schema_is_invalid_identity` (`:725`)
and `client_rejects_stale_identity_without_activate_write_or_returned_descriptors`
(`:768`). In-crate. Peer side:
`grant_message_accepts_tagged_setup_envelope`
(`packages/mc-shm-native/src/setup.rs:382`), which runs in CI but asserts only
that a well-formed envelope decodes.

### C9 — activation is one-use and token-gated

Where stated: `docs/mc-host-wire-protocol.md:561` ("validates the fixed release
identity and one-use activation token"), `:562` ("token mismatch ... retires the
connection before application traffic"),
`docs/mc-host-shm-transport.md:43`.

Implementing code: the token is 32 CSPRNG bytes hex-encoded per connection
(`connection.rs:212-222`), compared in constant time at `setup_socket.rs:267-272`
with `InvalidActivation` on mismatch (`:275`). The "one-use" half is
structural rather than enforced: the token exists only for the lifetime of one
`activate_server` call and is never stored, so there is nothing to replay it
against.

**The gating claim does not survive the transfer order.** The token is sent
inside the same `GrantMessage` that carries the descriptors
(`setup_socket.rs:249-260`), so a peer holds both mapping file descriptors before
it has presented any token. Whatever the token gates, it is not the mapping. See
lead L2.

Existing check: `activation_and_commit_complete_on_setup_socket` (`:600`) and
`authenticated_setup_transfers_and_commits_descriptors` (`:654`). In-crate.
`activation_token_with(|_| Err(()))` is driven under `catch_unwind` at
`connection.rs:942`, which is Part 2a scope.

### C10 — credentials are fresh per host incarnation and never survive one

Where stated: `docs/mc-host-wire-protocol.md:105` ("generate a fresh 32-byte key
and 16-byte daemon ID for every host incarnation"), `:47` ("one process lifetime
with one fresh key and daemon ID"), `instance.rs:28-30`, `:223-226` ("credentials
never exist for an incarnation that lost a lock race").

Implementing code: `instance.rs:182-232`, the guard construction ordering —
lifetime fence, directory, lock, then mint.

Existing check: `restart_rotates_credentials_and_invalidates_old_state`
(`tests/host_roundtrip.rs:153`) is the load-bearing one, and its binary is
**unnamed** in `ci.yml`. `no_secret_bearing_temp_files_survive_startup`
(`tests/instance_security.rs:227`) and `startup_errors_render_without_key_material`
(`:243`) cover the leak direction; that binary is also unnamed.

### C11 — key bytes never appear in formatting, errors, panics, metrics or diagnostics

Where stated: `docs/mc-host-wire-protocol.md:109` ("redact key bytes in logs,
errors, panic formatting, metrics, and diagnostics"), `instance.rs:28-30` ("Its
`Debug` implementation redacts the bytes, and the type intentionally has no
`Display` implementation (protocol V24)"), `:45-46` ("Variants carry paths and
operation names but never key bytes"), `auth.rs:60-61`, `connection_file.rs:6`.

Implementing code: the redacting `Debug` on the key type (`instance.rs:28`
region), the `ServerProof`/`ClientAuth` redaction noted at `auth.rs:60-61`, and
`SetupError`'s `Display` (`setup_socket.rs:106-120`), which maps all nine
variants to fixed strings carrying no peer data.

Existing check: `proof_debug_output_never_carries_the_proof_bytes` (`auth.rs`),
`wrong_client_proof_is_rejected_and_error_carries_no_secrets` (`auth.rs`),
`startup_errors_render_without_key_material`
(`tests/instance_security.rs:243`).

### C12 — the managed Rust client repeats every native-peer rejection

Where stated: `docs/mc-host-shm-transport.md:83` — "Managed Rust clients use the
same setup protocol, ring profile, wire version, and descriptor schema."

Implementing code: **partially NOT FOUND, and the gap has a polarity flip in
it.** Three native checks have no managed counterpart at the same layer.

| Native peer check | Site | Managed Rust equivalent |
| --- | --- | --- |
| `grant.descriptor.profile != PROFILE` | `mc-shm-native/src/setup.rs:122` | not in `activate_client`; deferred to `ring_transport.rs:642` |
| `host_to_peer_grant == peer_to_host_grant` rejected | `mc-shm-native/src/setup.rs:122` | **no equivalent.** `ring_transport.rs:648` instead rejects when the two geometries *differ* — the opposite test. Identical grants pass the managed check and fail the native one |
| separate `MAX_AUTH_MESSAGE_LEN` of 4,096 for auth messages | `mc-shm-native/src/setup.rs:18`, applied at `:190`, `:192`, `:218` | the host's `setup_socket.rs` has only `MAX_SETUP_MESSAGE_LEN` (16 KiB, `:24`); the 4,096 auth cap lives in `auth.rs` (`MAX_AUTH_MESSAGE_LEN`, exported at `lib.rs:44`) |

Existing check: none. Nothing compares the two peers' rejection sets. Engaged as
lead L1.

### C13 — the connection file is read through one descriptor-anchored snapshot, bounded before parsing, with replacement rejected

Where stated: `connection_file.rs:3-6`, `docs/mc-host-wire-protocol.md:92-98`
(the five-step client obligation), `:100` ("The validated descriptor snapshot is
the sole source of credentials and setup-socket authority. A client MUST NOT
validate by pathname and then reopen that pathname").

Implementing code: `connection_file.rs:180-182` (`read_for_client`) and the
constants `MAX_CONNECTION_FILE_LEN`, `SCHEMA_VERSION`, `KEY_LEN`, `MIN_KEY_LEN`,
`DAEMON_ID_LEN` (exported at `lib.rs:58-61`).

Existing check: `discovery_validates_the_publication_the_way_a_client_must`
(`tests/instance_security.rs:80`),
`discovery_requires_numeric_wire_version_two` (`:117`),
`discovery_rejects_symlink_and_hard_link_publications` (`:154`). Binary
**unnamed** in `ci.yml`. The TypeScript twin `connection-file.test.ts` (27 tests)
**does** run in CI (`ci.yml:211`).

### C14 — every mutation is anchored to one validated directory descriptor, so a path swap cannot redirect it

Where stated: `instance.rs:4-7` — "path-based operations never cross the security
boundary, so a concurrent path/symlink swap cannot redirect a create, rename, or
unlink outside that directory (plan KTD4, protocol §4.2)" — and
`docs/mc-host-wire-protocol.md:112-114`.

Implementing code: the directory-validation walk ending at `instance.rs:561-573`,
and the atomic install helper documented at `:576-581` ("unique owner-only
`O_EXCL` temp, exact-mode `fchmod`, full write, fsync, then rename").

Existing check: `a_planted_symlink_at_the_record_name_is_replaced_not_followed`
(`tests/instance_security.rs:301`),
`a_replaced_publication_survives_the_old_incarnation_cleanup` (`:196`),
`publication_is_an_owner_only_regular_file_in_an_owner_only_dir` (`:65`). Binary
unnamed.

### C15 — shutdown removal is fenced by daemon identity under the held lock

Where stated: `docs/mc-host-wire-protocol.md:116` ("Before unlinking, the host
MUST reread metadata without following links and confirm that the file is its own
publication, including matching daemon ID. An old process MUST NOT remove a
replacement host's credential"), `instance.rs:205-207`, `:185-189`.

Implementing code: the retained publication identity at `instance.rs:205-207`
and the `Drop` cleanup described at `:185-189`.

Existing check: `shutdown_removes_the_publication_and_releases_the_lock`
(`tests/instance_security.rs:168`),
`lifecycle_record_is_owner_only_and_removed_at_shutdown` (`:281`),
`coordination_locks_are_owner_only_and_survive_teardown` (`:393`). Binary
unnamed.

### C16 — every setup message is length-prefixed and capped before allocation

Where stated: `docs/mc-host-wire-protocol.md:163` ("Length MUST be at most
4,096. Length 4,096 is valid; 4,097 is rejected before allocation"),
`setup_socket.rs:24`.

Implementing code: four readers, and they do not agree on which cap they apply.
`encode_message` (`setup_socket.rs:430-439`) caps outbound at
`MAX_SETUP_MESSAGE_LEN` = 16 KiB; `read_message` (`:369-386`) and
`read_message_unbounded` (`:355-367`) both check `len > MAX_SETUP_MESSAGE_LEN`
before allocating (`:361`, `:378`); `read_message_from_prefix` (`:388-416`) adds
a `checked_add` for the total (`:404`) and rejects a prefix longer than the
declared frame (`:405-407`). The 4,096 auth cap the wire document states is
enforced in `auth.rs`, not here.

**`read_message_unbounded` is bounded.** The re-scope left open whether the name
signalled a missing bound (`scope-map-and-risk-ranking.md:744-746`). It does not:
`:361-363` applies the same `MAX_SETUP_MESSAGE_LEN` check as `read_message`. The
word `unbounded` refers to the *deadline*, not the length — it is the only reader
with no `timeout_at`, because it is the peer-lifetime sentinel that must block
indefinitely (`:344-353`). The name is misleading; the bound is present. Resolved.

Existing check: `over_cap_auth_message_is_rejected_before_allocation`
(`auth.rs`) covers the 4,096 path. Nothing covers the 16 KiB path in
`setup_socket.rs`, and nothing covers `read_message_from_prefix`'s
prefix-longer-than-total branch (`:405-407`).

### C17 — clean Goodbye and unexpected closure are distinct outcomes

Where stated: `docs/mc-host-shm-transport.md:49` ("Clean `Goodbye` and
unexpected setup-socket closure are distinct. Unexpected closure records peer
death, cancels ring work, and tears down the exact connection"),
`setup_socket.rs:333` ("the only legal post-commit setup message"), `:344`.

Implementing code: `PeerClose` has three variants (`setup_socket.rs:80-85`) and
`observe_peer` (`:345-353`) maps `Goodbye` to `PeerClose::Goodbye`, an
`UnexpectedEof` io error to `PeerClose::UnexpectedEof`, and everything else —
including a timeout, a malformed message, and an oversize length — to
`PeerClose::ProtocolError` (`:351`). The consumer at `connection.rs:199-204`
collapses the three back to two: anything other than `Goodbye` records peer
death.

Existing check: `goodbye_and_eof_have_distinct_outcomes`
(`setup_socket.rs:811`). In-crate. Nothing reaches the `ProtocolError` arm.

### C18 — the peer-lifetime sentinel keeps the setup socket open after commit

Where stated: `docs/mc-host-shm-transport.md:45` ("Keep the setup socket open as
the peer-lifetime sentinel"), `docs/mc-host-wire-protocol.md:28` ("remains open
as a peer-lifetime sentinel").

Implementing code: `connection.rs:196-204` selects `observe_peer` against the
read-cancellation token inside a tracked read task, and the `stream` is moved into
that task rather than dropped after `activate_server` returns.

Existing check: none in this sub-part. The lifetime behaviour is exercised
end-to-end by `tests/shm_failure_modes.rs`
(`setup_active_and_idle_sigkill_each_return_exact_capacity`, `:233`;
`repeated_crashes_do_not_ratchet_single_connection_capacity`, `:248`), which is
**named** in CI (`ci.yml:133`).

### C19 — the addon's manifest and checksum are verified before loading, and a debug or wrong-target binary is refused

Where stated: `docs/mc-host-shm-transport.md:83` ("The package manifest and
addon checksum are verified before loading. Build profile and target identity are
checked before setup"), `:15`, `:87` ("A missing package, addon, manifest,
checksum, or platform capability fails the gate; unsupported or omitted results
are not success states").

Implementing code: `packages/mc-shm-native/index.ts:151-187`
(`packageAddonPath`: manifest existence `:161-163`, package-and-target identity
`:168-173`, checksum shape `:175-177`, addon existence `:179-181`, SHA-256
comparison `:182-185`), then `requireAddon` (`:189-210`) checking
`buildProfile() !== "release"` (`:199-201`) and
`buildTarget() !== platform.nativeTarget` (`:202-204`), with the nine-member
closed reason set at `:22-31`.

**The verified path is not the path CI exercises.** `requireAddon` prefers a
local sibling addon: `:194-197` tests `existsSync(localPath)` for
`./mc_shm_native.node` and calls `packageAddonPath` only in the `else`. CI builds
exactly that file (`ci.yml:193`, `bun run --cwd packages/mc-shm-native
build:source`) before every native and plugin test step, and removes it only
afterwards (`:219-223`). So the manifest and checksum branch — five of the nine
failure reasons — is skipped in every CI run. The profile and target checks
(`:199-204`) do run. See quiet area Q4.

Existing check: `shm-frame-channel.test.ts:49-53` asserts the *classification* of
four `NativeStartupError` reasons, constructed directly rather than produced by
the loader. Runs in CI (`ci.yml:211`). No check constructs a manifest with a
wrong checksum and observes `checksum_mismatch` from `packageAddonPath`.

### C20 — macOS lacks the Linux size-seal contract, so a same-user descriptor holder is trusted not to resize

Where stated: `docs/mc-host-shm-transport.md:85` — "Linux seals ring objects
against size changes. macOS does not provide the same seal contract, so a
same-user process that holds a shared-memory descriptor remains trusted not to
resize it after validation. macOS release remains blocked until designated-host
attachment tests prove the platform's resize behavior."

Implementing code: nothing in this sub-part. The claim is a *stated trust
assumption* plus a release block, and the descriptor transfer that hands out the
trusted descriptor is `setup_socket.rs:132-175`.

Existing check: **none found, by design** — the doc states the proving test does
not exist ("release remains blocked until designated-host attachment tests
prove"). Recorded so a later pass does not read the absence as an oversight. The
macOS CI legs (`ci.yml:181-187`) build and run `mc-shm-native`,
`mc-shm-transport --test contract --test fuzz_corpus`, and `mc-host --test client
--test lifecycle`, none of which is a resize test.

## Contract-vs-code leads

Four leads, recorded with both sides cited and not resolved.

**L1 — the managed Rust peer and the native peer accept different grants, and on
one check the polarity is reversed.** `docs/mc-host-shm-transport.md:83` promises
"Managed Rust clients use the same setup protocol, ring profile, wire version,
and descriptor schema." Three concrete divergences are tabulated under claim C12.
The reversed one deserves restating because a reader scanning for a *missing*
check will not find it: the native peer rejects a grant where
`host_to_peer_grant == peer_to_host_grant`
(`packages/mc-shm-native/src/setup.rs:122`) — a single ring presented as two
directions. The managed Rust peer's nearest check is
`from_host_grant.geometry() != to_host_grant.geometry()`
(`ring_transport.rs:648`), which rejects grants whose *geometries differ*. Two
identical grants have identical geometry, so they pass. The managed client accepts
exactly the input the native client is coded to refuse. Whether that input is
reachable from a non-malicious host is undetermined; the host always emits two
distinct rings (`ring_transport.rs:327-328`).

**L2 — the activation token cannot gate what the contract implies it gates.**
`docs/mc-host-wire-protocol.md:561` lists validation of the "one-use activation
token" alongside descriptor transfer as part of what setup completes before the
wire becomes active, and the state diagram at `:565-575` puts
`Attaching --> Active` behind "descriptors and identity validate; activation
commits". In code, `send_grant` transfers the two descriptors and the token in a
single `sendmsg` (`setup_socket.rs:138-164`, grant assembled at `:251-256`), so
the peer's `[OwnedFd; 2]` is already in hand when it first speaks
`Activate` (`:307-316`). The token therefore gates the host's *acknowledgement*,
not the peer's *capability*. Confirmed from the sibling's 2c lens-A finding and
extended: nothing revokes the descriptors on `InvalidActivation`
(`:275`) either — the host drops only its own copies, at `connection.rs:186`.

**L3 — the doctor's five terminal classes are one contract implemented on two
sides with a 1:4 split, and the four are produced by regular expressions over
error text.** `docs/mc-host-shm-transport.md:53-59` states the set and `:71` says
"Client diagnostics use the same terminal-class set". Exactly one of the five
literals exists under `crates/` (`ring_transport.rs:187`, 2b scope); the other
four are produced only by
`packages/plugin/src/shared/mc-host-client/shared-memory-failure.ts:10-30`. For
this sub-part the sharp part is where the matched strings are minted:
`/identity mismatch/i` (`:19`) matches
`packages/mc-shm-native/src/setup.rs:366` ("shared-memory identity mismatch"),
and the default `setup_failure` (`:30`) absorbs `:360` ("shared-memory setup
failed") and `:373` ("shared-memory setup deadline expired"). So a *timeout* and
a *malformed grant* classify identically, and renaming any of the three Rust
strings silently reclassifies a terminal class with no build failure. Also
recorded in the 2b sibling lens; the string producers are 2c scope.

**L4 — `SetupError` has nine variants and the peer sees three outcomes.** The
host distinguishes `Io`, `Timeout`, `MessageTooLarge`, `InvalidMessage`,
`InvalidIdentity`, `InvalidActivation`, `MissingDescriptors`,
`DuplicateDescriptors`, `TruncatedAncillary` (`setup_socket.rs:88-98`), each with
its own `Display` string (`:108-118`). The peer half collapses everything into
three `io::Error` constructors: `invalid()` (`InvalidData`),
`identity_mismatch()` (`PermissionDenied`), `timed_out()` (`TimedOut`)
(`packages/mc-shm-native/src/setup.rs:359-375`). Nine host-side distinctions
reach the peer as at most three, and then as at most two terminal classes
through L3. `docs/mc-host-shm-transport.md:73` requires peer-controlled text be
"reduced to a closed class or redacted and length-bounded", which the collapse
satisfies; what it does not satisfy is any diagnosability claim, and none is
made. Recorded as a lead rather than a finding because the contract is silent.

## Documentation describing deleted mechanisms

**Two, both in `auth.rs` doc comments, and both cite tests by name.** This is the
category the task predicted would be non-empty here, and it is the only place in
either sub-part where it is.

**D1 — `auth.rs:693-698` cites a TypeScript test file deleted by the refactor.**
The comment reads: "The TypeScript client asserts its handshake against the same
fixed vectors (`packages/plugin/src/shared/mc-host-client/auth.test.ts`), so they
form a cross-language contract: changing the domain separator, the field order,
or the MAC breaks the build here, where the change is being made, instead of
surfacing as a handshake failure against a peer that has not been rebuilt."

Verified: `packages/plugin/src/shared/mc-host-client/auth.test.ts` does not
exist. `auth.ts` does not exist. `git show --stat ed487e11` shows both deleted in
the commit that made the ring mandatory, at 365 and 314 lines. A repository-wide
search for `auth.test.ts` returns nothing outside `node_modules`. A search for
`subc-server-v1` in TypeScript returns two hits, neither a handshake
implementation: `packages/plugin/scripts/mc-host-client-boundary.test.ts:221`
uses the string as a *forbidden-name fixture*, and
`packages/plugin/dist/shared/mc-host-client/auth.d.ts:24-25` is an untracked
build artifact under a `dist/` path excluded by `.gitignore:16`.

Why it matters beyond a stale path. The comment's stated *mechanism* — "breaks
the build here, where the change is being made" — was the reason a host-side
developer could trust the domain constants. That mechanism is gone. What replaced
it is a *different* cross-language pin: the native peer's
`auth_proofs_match_committed_wire_vectors`
(`packages/mc-shm-native/src/setup.rs:401`), which asserts the same literal
vectors, is in a different crate, and — unlike the host's own vector test — runs
in CI (`ci.yml:177`, `:184`). So the contract survived and moved, and the comment
now names the one location where it no longer lives. Per METHOD rule 3 the
disagreement is recorded, not resolved in the comment's favour.

**D2 — `auth.rs:394-396` cites a test that does not exist anywhere in the tree.**
The comment reads: "ALWAYS-TRUE is caught by
`foreign_server_reused_port_never_receives_client_auth` — the case where a client
must refuse a server that cannot produce the proof. Named for the refusal, and it
holds that direction directly."

Verified: a repository-wide grep for that identifier returns exactly one hit —
the comment itself, `auth.rs:394`. No such test exists in `crates/`,
`packages/`, or the integration binaries. Two surviving tests in `auth.rs` hold
the same direction under different names, `invalid_server_proof_sends_no_client_auth`
and `daemon_id_mismatch_sends_no_client_auth`, so the *coverage* is probably
intact while the *citation* is not. This is a weaker finding than D1 — a renamed
test rather than a deleted mechanism — but it sits inside a 19-line comment
(`auth.rs:385-403`) whose entire purpose is to explain which named tests fence
the two mutation directions of a proof comparison. A comment that exists to make
mutation coverage auditable, naming a test that cannot be found, defeats its own
purpose.

The neighbouring claim in the same comment is also worth a later pass:
`auth.rs:389-392` says the ALWAYS-FALSE direction is "caught by the handshake
integration tests and by two bootstrap tests -- named for key rotation and
singleton probing, so this is coverage carried by tests about something else.
Narrowing either would remove it silently." The two plausible referents are
`restart_rotates_credentials_and_invalidates_old_state`
(`tests/host_roundtrip.rs:153`) and
`probe_observes_running_then_stopped_across_an_incarnation`
(`tests/lifecycle.rs:1713`). Neither is named for authentication, which is the
comment's own point. **One runs in CI and one does not**: `lifecycle` is named at
`ci.yml:179` and `:187`; `host_roundtrip` is named nowhere. So half of the
deliberately-incidental coverage the comment relies on is not executed by CI, and
the comment's warning about silent removal applies with more force than it
states.

**Elsewhere: none found.** No doc comment in `setup_socket.rs`, `instance.rs`,
`connection_file.rs` or `packages/mc-shm-native/src/setup.rs` names a deleted
file or mechanism. `docs/mc-host-shm-transport.md` and
`docs/mc-host-wire-protocol.md` were audited against the deletion set
(`scope-map-and-risk-ranking.md:40-48`) and describe no removed machinery; the
wire document's transport-selector statements are negative claims the deletion
made true (`:583-585`).

## Conventionally-enforced-only claims

Nine, each stated somewhere and mechanically checked nowhere, or checked only by
name.

1. **The proof construction is defined three times.** `docs/mc-host-wire-protocol.md:186-190`
   (prose formula), `auth.rs` (`compute_proof`, host), and
   `packages/mc-shm-native/src/setup.rs:222-235` (peer). The two code definitions
   agree only because both assert the same committed literals; nothing derives
   one from the other, and only the peer's assertion runs in CI.
2. **The two domain separators are duplicated literals.**
   `SERVER_PROOF_DOMAIN` and `CLIENT_AUTH_DOMAIN` are exported from `auth.rs`
   (`lib.rs:43-44`) and redefined at
   `packages/mc-shm-native/src/setup.rs:20-21`.
   `docs/mc-host-wire-protocol.md:14` states they "MUST NOT be renamed without a
   separately versioned wire or lifecycle migration" — enforced by prose plus,
   partially, the forbidden-name fixture at
   `packages/plugin/scripts/mc-host-client-boundary.test.ts:221`.
3. **`MAX_SETUP_MESSAGE_LEN` is 16 KiB in two crates, independently.**
   `setup_socket.rs:24` and `packages/mc-shm-native/src/setup.rs:19`. No
   cross-check. A widening on one side produces a peer that sends what the other
   rejects.
4. **`MAX_AUTH_MESSAGE_LEN` is 4,096 in two crates, and the wire document is the
   only place that says the two must match.** `auth.rs` (exported at
   `lib.rs:44`) and `packages/mc-shm-native/src/setup.rs:18`, against
   `docs/mc-host-wire-protocol.md:163`.
5. **`RING_DESCRIPTOR_COUNT = 2` is a named constant on the host
   (`setup_socket.rs:25`) and a bare `2` on the peer**
   (`packages/mc-shm-native/src/setup.rs:255`, with `ScmRights(3)` at `:240`).
6. **The connection-file shape is re-declared in TypeScript as literals.**
   `connection-file.ts:30-33` restates `MAX_CONNECTION_FILE_LEN = 65_536`,
   `CONNECTION_FILE_SCHEMA = 1`, `KEY_LEN = 32`, `DAEMON_ID_LEN = 16` against
   `lib.rs:58-61`. No test parses the Rust constants.
7. **The ring profile string is defined three times.**
   `ring_transport.rs:31`, `packages/mc-shm-native/src/lib.rs:27` (`PROFILE`),
   `packages/mc-shm-native/index.ts:8` (`QUALIFIED_TEST_PROFILE`). The value is
   the release identity `docs/mc-host-shm-transport.md:11` fixes.
8. **The nine-member `NativeStartupFailureReason` set and the five-member
   `SharedMemoryTerminalClass` set are related only by a `switch`-shaped
   expression.** `packages/mc-shm-native/index.ts:22-31` against
   `types.ts:69-73`, joined at `shared-memory-failure.ts:14`, which maps every
   reason except `missing_addon` to `setup_failure`. Adding a tenth reason
   silently classifies as `setup_failure`.
9. **The architecture gate never reads `docs/`.**
   `scripts/check-mc-shm-architecture.ts:7-23` lists five source roots, one file
   and six manifests; no documentation path appears. It also skips `.test.ts`
   (`:48`) and never walks `crates/mc-host/tests/`. So both findings D1 and D2 —
   documentation naming deleted code — are outside every mechanical gate this
   repository has. Its one non-grep property is that `:59` fails when a required
   audit input is *missing*, which pins the continued existence of
   `packages/mc-shm-native/index.ts` and the five roots.

## Existing-check inventory

Every status is `unaudited`. Per METHOD an existing check never removes a
property from the catalog.

### In-crate tests (clustered, counts, line ranges; note they never run in CI)

**51 in-crate tests reach this sub-part. 49 of them never run in CI; the 2 in the
peer half do.** The 49 are excluded structurally: every `-p mc-host` invocation
in `ci.yml` carries a `--test <name>` filter, selecting one integration binary
and excluding the lib target. The 2 are included for the same structural reason
in reverse: `ci.yml:177` runs `cargo nextest run -p mc-shm-native
-p mc-shm-transport` with no filter on Linux, and `:184` runs
`cargo nextest run -p mc-shm-native` with no filter on macOS.

| Unit | Test module | Lines | Tests | CI |
| --- | --- | --- | --- | --- |
| `instance.rs` | `mod tests`, from `:889` | 535 | **22** | no |
| `setup_socket.rs` | `mod tests`, `:441-826` | 386 (47% of file) | **12** | no |
| `auth.rs` | `mod tests`, from `:633` | 480 | **11** | no |
| `connection_file.rs` | `mod tests`, `:337-471` | 135 | **4** | no |
| `packages/mc-shm-native/src/setup.rs` | `mod tests`, `:377-433` | 57 | **2** | **yes** |

The `setup_socket.rs` twelve, clustered by what they gate — this is the
sub-part's own coverage shape:

| Cluster | Tests | Sites |
| --- | --- | --- |
| Descriptor transfer | 4 | `:451`, `:504`, `:518`, `:543` |
| Identity and activation | 4 | `:600`, `:654`, `:725`, `:768` |
| Socket permissions and occupant | 2 | `:481`, `:494` |
| Message-set isolation | 1 | `:569` |
| Peer close disposition | 1 | `:811` |

The `auth.rs` eleven cover proof redaction, deadline representability, the
committed vectors, server-nonce freshness, wrong-client-proof rejection, the
4,096 cap before allocation, no-`ClientAuth`-on-invalid-server-proof,
no-`ClientAuth`-on-daemon-ID-mismatch, and short-key rejection before any read.
Two support helpers are documented as deliberate fault seams: the
length-prefix-only writer at `:773-775` (stalls the peer mid-message to exercise
the within-stage deadline) and the handshake driver at `:883-884`.

**Doctests: none found.** Zero `/// ```` or `//! ```` fences across the four
`mc-host` scope files, so `cargo test -p mc-host --doc` (`ci.yml:190`) covers
nothing here. This is the difference from sibling 2b, whose two `compile_fail`
doctests are its only CI-executed source-resident checks.

**`#[ignore]`: none found. `should_panic`: none found.** Across all five files.

**One test is a source-text scanner rather than a behavioural test.**
`mode_arithmetic_goes_through_the_portable_accessor`
(`connection_file.rs:346`) reads `include_str!("connection_file.rs")` and
`include_str!("instance.rs")`, splits each on the literal
`"#[cfg(test)]\nmod tests {"` (`:353`) to isolate the production half, and
forbids direct `st_mode` access outside the cfg-gated accessor. Its doc comment
(`:341-345`) records why: the bug it prevents "reached CI as a macOS-only
failure". Recorded because a split on a formatting-sensitive literal is brittle
in a way a later `cargo fmt` change could silently vacate — the test would find
no split point, take `.next()`, and scan the whole file including its own tests.

### Integration tests (with CI named/unnamed status and workflow line refs)

No integration binary is dedicated to this sub-part. Six of the 24 exercise the
setup socket, authentication, or publication path; **3 are named in CI and 3 are
not**, and the split runs against the claims.

| Binary | Tests | Reaches | CI status |
| --- | --- | --- | --- |
| `lifecycle.rs` | 35 | setup socket, auth, lifecycle record | **named** — `ci.yml:179`, `:187` |
| `client.rs` | 6 | `activate_client`, full attach | **named** — `ci.yml:132`, `:179`, `:187` |
| `shm_failure_modes.rs` | 6 | auth, setup, peer death, capacity | **named** — `ci.yml:133`, `--test-threads=1` |
| `instance_security.rs` | 15 | publication, discovery, permissions, cleanup | **unnamed** |
| `host_roundtrip.rs` | 4 | credential rotation, concurrent clients | **unnamed** |
| `activation.rs` | 4 | bootstrap-before-publication ordering | **unnamed** |

**The unnamed three carry the claims with no other coverage.**
`instance_security.rs` is the sole home of C13, C14 and C15 — descriptor-anchored
discovery, symlink and replacement safety, and fenced shutdown removal — 15 tests
across `:15`, `:34`, `:65`, `:80`, `:117`, `:154`, `:168`, `:196`, `:227`,
`:243`, `:281`, `:301`, `:339`, `:393`, `:424`. `host_roundtrip.rs:153` is the
sole home of C10's rotation half and one of the two "bootstrap tests" the
`auth.rs:389-392` mutation argument depends on. `activation.rs` holds the
publication-ordering claim (`:378`,
`bootstrap_precedes_publication_and_activation_follows_it`).

`instance_security.rs:339`,
`exactly_one_unsafe_escape_hatch_exists_in_the_crate`, is a second source-text
scanner, pinning the `#![deny(unsafe_code)]` exception documented at
`lib.rs:3-8`. In an unnamed binary.

Three further binaries name the setup socket without asserting its contract:
`tests/perf_measurement.rs` (23), `tests/ipc_budget_evidence.rs` (14), and the
shared harness `tests/support/raw_client.rs`, which drives
`mc_host::setup_socket::activate_client` at `:329` and connects at `:353` and
`:879`. None is named in `ci.yml`.

### TypeScript-side gates

Six CI-run gates touch this sub-part's boundary. All are inside
`shm-source-build` (`ci.yml:137`) except the architecture audit.

| Gate | Command | Line | What it covers here |
| --- | --- | --- | --- |
| Plugin shared-memory contracts | `bun test packages/plugin/src/shared/mc-host-client` | `:211` | `connection-file.test.ts` (27) is the CI-executed twin of claim C13; `credential-fingerprint.test.ts` (3); `deadline.test.ts` (15); `owner.test.ts` (4); `shm-frame-channel.test.ts` (15), including the nine terminal-class mappings at `:49-57` |
| Native behaviour (Bun) | `bun run --cwd packages/mc-shm-native test:bun` | `:196` | `tests/suite.test.ts` imports `capability.ts`, `mechanism.ts`, `runtime.ts`; 8 `test(` calls in `mechanism.ts`. Runs under `MC_SHM_NATIVE_CLAIMED_TARGET: "1"` (`:197`) |
| Native behaviour (Node 24) | `bun run --cwd packages/mc-shm-native test:node` | `:203` | same suite through `tests/runtime.ts` |
| Mandatory capability activation | `test:capability:bun` and `test:capability:node` | `:206-208` | `tests/capability.ts` asserts either an ACTIVATED outcome or a TERMINAL_STARTUP_FAILURE with a reason, and that no channel leaks either way |
| Plugin shared-memory lifetime (Node 24) | `bun run --cwd packages/plugin test:mc-shm:node` | `:214` | native lease and channel lifetime across the runtime boundary |
| Architecture audit | `bun test scripts/check-mc-shm-architecture.test.ts`, `bun run check:shm-architecture` | `:55`, `:58` | the forbidden-name gate; scans `packages/plugin/src/shared/mc-host-client` and `packages/mc-shm-native/src` among its five roots |

Two more `mc-host-client` gates run outside `shm-source-build`:
`mc-host-client-interop` (`ci.yml:442`) runs the Node 24 smoke at `:461`, and
`ci.yml:216-217` typechecks the plugin.

**`MC_SHM_NATIVE_CLAIMED_TARGET` inverts the mechanism gate from tolerant to
strict, and only on two of the six.** `tests/mechanism.ts:19` reads it; with the
flag set, `requiredAddonPath` throws when the local addon is absent (`:24`) and
the capability probe must return `available: true` (`:31`). It is set at
`ci.yml:197` and `:202` only. `test:capability:*` (`:206-208`) runs without it,
so the capability leg accepts a TERMINAL_STARTUP_FAILURE as a pass
(`tests/capability.ts:27-39`).

**One gate has no Rust counterpart and shapes claim C19.** `ci.yml:219-223`,
"Reject prebuilt native modules", runs `test -z "$(git ls-files '*.node')"` —
verified: zero paths at `HEAD` — then removes
`packages/mc-shm-native/mc_shm_native.node` and asserts its absence. Because the
removal runs *after* the four native and plugin test steps, every CI TypeScript
test executes against a locally built addon and therefore through
`index.ts:194-197`'s local branch, never through `packageAddonPath`.

### Production assertions and guards (clustered)

**Assertion density is near zero on both sides of the boundary. Enforcement is
typed rejection and constant-time comparison.**

**`assert!` / `assert_eq!` / `panic!` / `debug_assert!` / `unreachable!` in
production halves: none found**, across `setup_socket.rs`, `auth.rs`,
`connection_file.rs`, `instance.rs` and
`packages/mc-shm-native/src/setup.rs`.

**`.expect(`: 3, in two clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Infallible slice-to-array | 2 | `setup_socket.rs:400` and `packages/mc-shm-native/src/setup.rs:290`, both `"four-byte prefix"`, each guarded by a preceding `while prefix.len() < 4` loop |
| HMAC key acceptance | 1 | `packages/mc-shm-native/src/setup.rs:229` `"HMAC accepts every key length"` |

The third is the only one stating a library contract rather than a local
invariant, and it is reached before the key length is validated by the caller —
`connect` checks `key.len() != 32` at `:102-104`, so the `expect` is unreachable
in practice, not by construction.

**`.unwrap()`: none found** in any production half.

**`catch_unwind`: none found.** Unlike 2b, this sub-part has no panic boundary of
its own; `connection.rs:942` wraps `activation_token_with` in a test, which is
Part 2a scope.

**Discarded results (`let _ =`): 5, and three are on the teardown path.**
`setup_socket.rs:46` (removing a socket whose chmod failed — a failure here
leaves an over-permissive socket at the path and returns the chmod error),
`:336` and `:337` (`goodbye_client` discards both the write and the shutdown),
and `packages/mc-shm-native/src/setup.rs:165` and `:171` (the peer's `goodbye`,
same shape). So a clean Goodbye is best-effort on both sides, which is what makes
`PeerClose::UnexpectedEof` reachable without a peer crash. `goodbye_client`
also uses a hardcoded 100 ms deadline (`setup_socket.rs:335`, mirrored at
`packages/mc-shm-native/src/setup.rs:164`) that no configuration reaches.

**Constant-time comparisons: 4, and they are the sub-part's real guards.**
Host: `subtle::ConstantTimeEq::ct_eq` on the activation token
(`setup_socket.rs:267-272`). Peer: `ct_eq` on the server proof
(`packages/mc-shm-native/src/setup.rs:200`) and on the daemon ID (`:201`).
`auth.rs:385-387` states the design reason — "a proof check has the failure mode
where a suite proves only that it can say NO" — and the client proof is compared
in constant time on the host side per `docs/mc-host-wire-protocol.md:190`.
**One comparison in the chain is not constant-time and the wire document says it
need not be**: `server.daemon_ver != expected_daemon_ver`
(`packages/mc-shm-native/src/setup.rs:202`) is a plain string comparison, which
`:190-192` of the wire document covers by classifying version binding as
"snapshot binding, not cryptographic authentication".

**Typed rejection guards.** `SetupError` (`setup_socket.rs:88-98`) is nine
variants with fixed `Display` strings (`:108-118`) and a `source()` that exposes
only the inner `io::Error` (`:123-128`). `PeerClose` (`:80-85`) is three. The
peer collapses to three `io::Error` constructors
(`packages/mc-shm-native/src/setup.rs:359-375`). `NativeStartupError`
(`packages/mc-shm-native/index.ts:34-39`) carries a nine-member closed reason and
a message built only from that reason.

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.

1. **The occupant gate is a three-clause conjunction with one clause tested, and
   it decides whether the host binds over a hostile socket.**
   `setup_socket.rs:30-32` admits removal of an existing path entry only when it
   is a socket, owned by the effective uid, and mode exactly `0o600`. The sole
   test plants a regular file (`:497`), so the uid clause and the mode clause are
   both unexercised — and the mode clause is the interesting one, because a
   *same-uid socket at mode `0o666`* is exactly the residue a previous
   incarnation running under a permissive umask would leave. Nothing plants a
   FIFO, a directory, a symlink, or a `0o666` socket. `instance.rs:571-572`
   narrows the parent to `0o700` and makes the whole class unreachable from
   outside the uid, which is the argument for why the gap is tolerable; nothing
   states that argument in either file, and nothing tests the composition.

2. **49 of the 51 in-crate tests run nowhere but a developer's laptop, and the
   two that run in CI are the peer's.** The asymmetry is the finding, not the
   count. The host's `committed_wire_vectors_pin_the_proof_construction` and the
   peer's `auth_proofs_match_committed_wire_vectors`
   (`packages/mc-shm-native/src/setup.rs:401`) assert the same 64 literal bytes
   from `docs/mc-host-wire-protocol.md:180` and `:182`. Only the peer's runs. So
   the CI-enforced authority for the proof construction is the implementation
   that is *not* the host, in a crate the host does not depend on for
   authentication, while the host's own 11 auth tests — including
   server-nonce freshness, the 4,096 pre-allocation cap, and both no-`ClientAuth`
   refusal directions — are unexecuted.

3. **`observe_peer`'s `ProtocolError` arm is unreachable from any test, and it is
   the arm a hostile peer would drive.** `setup_socket.rs:351` catches everything
   that is neither `Goodbye` nor `UnexpectedEof`: a malformed post-commit
   message, an oversize length, a non-`UnexpectedEof` io error. The only test
   covers the two named outcomes (`:811`). Downstream,
   `connection.rs:199-204` treats `ProtocolError` identically to
   `UnexpectedEof`, so the third variant has no observable consequence — which
   makes the question whether it should exist, and no check can currently tell.

4. **The manifest-and-checksum branch is five of nine failure reasons and CI
   never enters it.** `packages/mc-shm-native/index.ts:151-187` implements
   `missing_manifest`, `wrong_platform_payload`, `missing_checksum`,
   `missing_addon` and `checksum_mismatch`. `requireAddon` reaches it only when
   `existsSync(localPath)` is false (`:194-197`), and every CI native and plugin
   step runs after `build:source` created that file (`ci.yml:193`). The four
   reasons `shm-frame-channel.test.ts:49-53` exercises are constructed as
   `new NativeStartupError(...)` directly, not produced by the loader. So the
   verification `docs/mc-host-shm-transport.md:83` promises "before loading" has
   its classification tested and its *production* untested, and the
   `release:contract:check` and payload gates elsewhere in `ci.yml` are the only
   thing standing in for it.

5. **Nothing revokes a transferred descriptor on any post-transfer failure.**
   `activate_server` can fail after `send_grant` succeeded — on
   `InvalidActivation` (`setup_socket.rs:275`), `InvalidIdentity` (`:278`),
   `InvalidMessage` (`:279`, `:283`), or a `Timeout` in either
   `read_message`. In every case the peer keeps both mapping file descriptors,
   and the host's response is to drop its own copies (`connection.rs:186`
   is reached only on success; on failure the `descriptors` array falls out of
   scope) plus `sender.discard()` and `root.cancel()`
   (`connection.rs:180-183`). No test asserts what the peer can still do with the
   mappings after a refused activation, and the ring's own size seal
   (`docs/mc-host-shm-transport.md:85`) is the only stated containment — which
   the same document says macOS does not provide.

6. **`read_message_from_prefix` is the one reader with two branches no test
   reaches.** `setup_socket.rs:405-407` rejects a prefix longer than the declared
   total, and `:410-414` conditionally reads the remainder only when the received
   bytes fall short. Both branches exist because `recvmsg` may deliver the grant
   body and its length prefix in one read with the descriptors
   (`:232`), which is a genuinely awkward interleaving. Neither the
   over-long-prefix rejection nor the short-read continuation is exercised; the
   four descriptor tests all send a single well-formed message.

7. **The 16 KiB setup cap is never driven, on either side.**
   `MAX_SETUP_MESSAGE_LEN` (`setup_socket.rs:24`) gates
   `encode_message` (`:432`), `read_message` (`:378`),
   `read_message_unbounded` (`:361`) and `read_message_from_prefix` (`:401`,
   `:404`). The only cap test in the sub-part is
   `over_cap_auth_message_is_rejected_before_allocation` in `auth.rs`, which
   drives the 4,096 auth cap. A grant whose `descriptor` value pushes the
   envelope past 16 KiB would be refused at `encode_message` on the host's own
   send path — a self-inflicted failure — and nothing measures the current
   envelope's headroom against the cap.

8. **`activation.rs` holds the startup-ordering claim and is named in no
   workflow.** Four tests at `:144`, `:236`, `:274`, `:378`, covering
   transport-publishes-before-blocked-activation,
   activation-invariant-failure-reaches-the-fatal-channel,
   expected-artifact-faults-degrade-only-their-lane, and
   bootstrap-precedes-publication. These are the checks on
   `docs/mc-host-wire-protocol.md:586-593`, the normative seven-step startup
   order, and on `:600` ("Publication therefore means transport-ready, not
   storage-ready"). None runs in CI.

## Open questions

- Should the two `auth.rs` citations (D1, D2) be corrected, or do they signal
  that the host-side vector test should be promoted into a CI-named binary now
  that its cross-language partner has moved to `mc-shm-native`? This is a
  remediation decision and METHOD rule 6 forbids resolving it here. (needs human
  input)
- Does `packages/mc-shm-native/src/setup.rs` belong to Part 1 or 2c? Carried
  forward unresolved from `scope-map-and-risk-ranking.md:738-740`. This lens
  assumed 2c per the task's instruction to mine it, and the assumption changed
  the inventory materially: it is the only unit in this sub-part whose tests run
  in CI. If Part 1 owns it, this sub-part has **zero** CI-executed source-resident
  checks. (needs human input)
- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs 49 of the 51 in-crate checks above. Raised identically in the 2b
  sibling lens and in five prior sub-parts
  (`../../part-4e-rendering/existing-checks.md:840-846`). (needs human input)
- Is the polarity difference in lead L1 (`==` rejected natively versus
  `!=` geometry rejected in managed Rust) a real gap or two checks with different
  purposes that happen to look adjacent? Deciding it needs the `RingGrant`
  equality and `geometry()` semantics from `mc-shm-transport`, which is Part 1
  scope. Unresolved.
- Should `ci.yml` name `instance_security`, `host_roundtrip` and `activation`?
  They carry claims C10, C13, C14, C15 and the startup-order contract with no
  other coverage. This is a CI-policy decision, not a discovery finding.
- Are `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`)
  required status checks for merge? Unverifiable from workflow content. Carried
  forward from `scope-map-and-risk-ranking.md:750-752`.
- Does `mode_arithmetic_goes_through_the_portable_accessor`
  (`connection_file.rs:346`) still find its split point under the repository's
  current `rustfmt` settings? It splits on the literal
  `"#[cfg(test)]\nmod tests {"` (`:353`) and silently scans its own test module
  if that string ever stops appearing verbatim. Verified present today in both
  scanned files; the fragility is the open item.
