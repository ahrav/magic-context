# Part 2c existing-check inventory

Every claim-bearing check for the authenticated setup socket and peer identity:
`crates/mc-host/src/setup_socket.rs`, `auth.rs`, `instance.rs`,
`connection_file.rs`, and `packages/mc-shm-native/src/setup.rs` as the peer half.
Assembled from lens B's claim register and check inventory, with every count and
every headline reference re-derived at `HEAD` during synthesis.

Provenance: code read from `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`. Workflow references
are against `.github/workflows/ci.yml` at that commit.

**Every status below is `unaudited`.** An existing check never removes a property
from the catalog. Test adequacy belongs to `/testing:invariant-test-review` and
production assertion adequacy to
`/low-level-systems:defensive-assertions-and-invariant-guards`. This file records
what exists, where, and whether it executes. It does not judge whether any check
proves what its name says.

## The coverage fact that frames this inventory

**51 in-crate tests reach this sub-part. 49 of them never run in CI, and the 2
that do are the peer's.** Counts re-derived per file at `HEAD` by matching
`#[test]` and `#[tokio::test]`:

| Unit | Test module | Module lines | Tests | Runs in CI |
| --- | --- | --- | --- | --- |
| `crates/mc-host/src/instance.rs` | `mod tests`, from `:889` | 535 | **22** | no |
| `crates/mc-host/src/setup_socket.rs` | `mod tests`, `:441-826` | 386 (47% of the file) | **12** | no |
| `crates/mc-host/src/auth.rs` | `mod tests`, from `:633` | 480 | **11** | no |
| `crates/mc-host/src/connection_file.rs` | `mod tests`, `:337-471` | 135 | **4** | no |
| `packages/mc-shm-native/src/setup.rs` | `mod tests`, `:377-433` | 57 | **2** | **yes** |
| Total | | | **51** | **2** |

The exclusion and the inclusion are both structural, which is why the split runs
along a crate boundary rather than along any judgment about importance.

- Every `-p mc-host` test invocation in `ci.yml` carries a `--test <name>` filter.
  A `--test` filter selects one integration binary and does not build the lib
  target, so no `mc-host` in-crate unit test is compiled in CI, let alone run. The
  invocations are at `:132`, `:133`, `:134`, `:178-179`, `:187` and `:190`; none is
  an unfiltered `cargo nextest run -p mc-host` or a `--lib` run.
- `ci.yml:177` runs `cargo nextest run -p mc-shm-native -p mc-shm-transport`
  **unfiltered** on Linux, and `:184` runs `cargo nextest run -p mc-shm-native`
  likewise unfiltered on macOS. So the peer half's 2 tests execute on both
  platforms.

**Doctests: none found.** Zero `/// ``` ` or `//! ``` ` fences across
`setup_socket.rs`, `auth.rs`, `instance.rs` and `connection_file.rs`, verified per
file at `HEAD`. `ci.yml:190` runs `cargo test -p mc-host --doc` under the step name
"Rust lease non-escape", so it executes doctests that exist elsewhere in the crate
and covers nothing in this scope. **The `mc-host` side of this sub-part therefore
has no source-resident check that CI executes at all.**

**`#[ignore]`: none found. `should_panic`: none found.** Across all five files. No
`proptest`, `quickcheck`, `arbitrary`, `loom`, `shuttle`, or `miri` anywhere in
scope, so every check below is a hand-written case. There is no coverage
measurement, so every placement statement in this file is structural rather than
measured.

## In-crate tests, clustered

### `setup_socket.rs`, 12 tests

The clustering is the sub-part's own coverage shape: descriptor transfer is dense,
and the two checks that decide whether the socket is reachable at all get two
tests between them.

| Cluster | Tests | Sites |
| --- | --- | --- |
| Descriptor transfer | 4 | `:451` `grant_transfers_exactly_two_descriptors`, `:504` `grant_without_ancillary_descriptors_is_rejected`, `:518` `grant_with_extra_descriptor_is_rejected`, `:543` `truncated_ancillary_data_is_rejected` |
| Identity and activation | 4 | `:600` `activation_and_commit_complete_on_setup_socket`, `:654` `authenticated_setup_transfers_and_commits_descriptors`, `:725` `stale_wire_or_descriptor_schema_is_invalid_identity`, `:768` `client_rejects_stale_identity_without_activate_write_or_returned_descriptors` |
| Socket permissions and occupant | 2 | `:481` `setup_socket_is_owner_only`, `:494` `insecure_stale_occupant_is_not_replaced` |
| Message-set isolation | 1 | `:569` `application_message_is_not_a_setup_message` |
| Peer close disposition | 1 | `:811` `goodbye_and_eof_have_distinct_outcomes` |

Status for all twelve: `unaudited`. Three specific gaps are recorded in the quiet
areas below, because in each case a test covers one arm of a decision that has
more than one.

### `auth.rs`, 11 tests

Covering, per lens B's reading of the module: proof-`Debug` redaction, deadline
representability, the committed proof vectors, server-nonce freshness across two
handshakes, wrong-client-proof rejection with a secret-free error, the 4,096 cap
applied before allocation, both no-`ClientAuth` refusal directions, and short-key
rejection before any read. The two load-bearing sites for the catalog are
`:924-939` `repeated_handshakes_receive_fresh_server_nonces` and `:1022-1073`
`rejected_server_sends_no_client_auth`, driven by `:1074-1081`
`invalid_server_proof_sends_no_client_auth` and `:1082-1089`
`daemon_id_mismatch_sends_no_client_auth`. The `daemon_ver` mismatch case is not
visibly covered by either driver.

Two support helpers are documented as deliberate fault seams: the
length-prefix-only writer at `:773-775`, which stalls the peer mid-message to
exercise the within-stage deadline, and the handshake driver at `:883-884`. Status
for all eleven: `unaudited`.

### `instance.rs`, 22 tests, and `connection_file.rs`, 4

The largest in-crate suite in the sub-part and the smallest. Two of them are worth
naming individually because their status depends on something other than
correctness.

`instance.rs:979` `permissive_umask_still_yields_owner_only_dir_and_file` covers
the runtime directory and the connection file under a permissive umask. It does
**not** cover the setup socket, which is the object with the bind-then-chmod
window, and the socket is not created by `instance.rs`.

`connection_file.rs:346` `mode_arithmetic_goes_through_the_portable_accessor` is a
**source-text scanner rather than a behavioural test**. It reads
`include_str!("connection_file.rs")` and `include_str!("instance.rs")`, splits each
on the literal `"#[cfg(test)]\nmod tests {"` (`:353`) to isolate the production
half, and forbids direct `st_mode` access outside the cfg-gated accessor. Its doc
comment (`:341-345`) records that the bug it prevents "reached CI as a macOS-only
failure". Recorded because a split on a formatting-sensitive literal is brittle in
a specific way: if that string ever stops appearing verbatim the split finds no
point, `.next()` returns the whole file, and the scan silently includes the test
module it was written to exclude. Verified present today in both scanned files.

### `packages/mc-shm-native/src/setup.rs`, 2 tests, and they are the only two that run

- `:382` `grant_message_accepts_tagged_setup_envelope` asserts that a well-formed
  envelope decodes.
- `:401-432` `auth_proofs_match_committed_wire_vectors` asserts the same 32-byte
  literal arrays as `docs/mc-host-wire-protocol.md:180` and `:182` that the host's
  own `committed_wire_vectors_pin_the_proof_construction` asserts.

Both run through `ci.yml:177` and `:184`. Status: `unaudited`. The consequence is
quiet area 2 below.

## Integration tests, with CI named status

**No integration binary is dedicated to this sub-part.** Six of the crate's 24
exercise the setup socket, authentication, or publication path. Counts re-derived
at `HEAD`; the named/unnamed status was re-checked by grepping all five workflow
files for each binary name.

| Binary | Tests | Reaches | CI status |
| --- | --- | --- | --- |
| `tests/lifecycle.rs` | 35 | setup socket, auth, handshake capacity, lifecycle record | **named** — `ci.yml:179`, `:187` |
| `tests/client.rs` | 6 | `activate_client`, full attach | **named** — `ci.yml:132`, `:179`, `:187` |
| `tests/shm_failure_modes.rs` | 6 | auth, setup, peer death, capacity return | **named** — `ci.yml:133`, run with `--test-threads=1` |
| `tests/instance_security.rs` | 15 | publication, discovery, permissions, cleanup | **unnamed** |
| `tests/host_roundtrip.rs` | 4 | credential rotation, concurrent clients | **unnamed** |
| `tests/activation.rs` | 4 | bootstrap-before-publication ordering | **unnamed** |

**The unnamed three carry claims with no other coverage.** A grep for
`instance_security`, `host_roundtrip`, and `--test activation` across all five
workflow files returns nothing.

- `tests/instance_security.rs` is the **sole home** of descriptor-anchored
  discovery, symlink and replacement safety, and fenced shutdown removal. Its 15
  tests are at `:15`, `:34`, `:65`, `:80`, `:117`, `:154`, `:168`, `:196`, `:227`,
  `:243`, `:281`, `:301`, `:339`, `:393`, `:424`. The discovery cluster is `:80`
  `discovery_validates_the_publication_the_way_a_client_must`, `:117`
  `discovery_requires_numeric_wire_version_two`, and `:154`
  `discovery_rejects_symlink_and_hard_link_publications`. The mutation-safety
  cluster is `:301`
  `a_planted_symlink_at_the_record_name_is_replaced_not_followed`, `:196`
  `a_replaced_publication_survives_the_old_incarnation_cleanup`, and `:65`
  `publication_is_an_owner_only_regular_file_in_an_owner_only_dir`. The fenced
  removal cluster is `:168`
  `shutdown_removes_the_publication_and_releases_the_lock`, `:281`
  `lifecycle_record_is_owner_only_and_removed_at_shutdown`, and `:393`
  `coordination_locks_are_owner_only_and_survive_teardown`. `:339`
  `exactly_one_unsafe_escape_hatch_exists_in_the_crate` is a second source-text
  scanner, pinning the `#![deny(unsafe_code)]` exception documented at
  `lib.rs:3-8`.
- `tests/host_roundtrip.rs:153`
  `restart_rotates_credentials_and_invalidates_old_state` is the **sole home** of
  credential rotation, and it is one of the two unnamed "bootstrap tests" the
  mutation argument at `auth.rs:389-392` depends on.
- `tests/activation.rs` holds the startup-order claim, four tests at `:144`,
  `:236`, `:274`, and `:378`
  `bootstrap_precedes_publication_and_activation_follows_it`, against the
  normative seven-step order at `docs/mc-host-wire-protocol.md:586-593`.

Three further binaries touch the setup socket without asserting its contract:
`tests/perf_measurement.rs` (23), `tests/ipc_budget_evidence.rs` (14), and the
shared harness `tests/support/raw_client.rs`, which drives
`mc_host::setup_socket::activate_client` at `:329` and connects at `:353` and
`:879`. None is named in any workflow. `raw_client.rs` matters for the fault map
rather than as a check: it is where the squatter and dialer fixtures live.

Status for all six binaries and all three unnamed extras: `unaudited`.

## TypeScript-side gates

Six CI-run gates touch this boundary. All are inside `shm-source-build`
(`ci.yml:137`) except the architecture audit.

| Gate | Command | Line | What it covers here |
| --- | --- | --- | --- |
| Plugin shared-memory contracts | `bun test packages/plugin/src/shared/mc-host-client` | `:211` | `connection-file.test.ts` (27 tests) is the CI-executed twin of the connection-file reader contract; also `credential-fingerprint.test.ts` (3), `deadline.test.ts` (15), `owner.test.ts` (4), `shm-frame-channel.test.ts` (15) including the terminal-class mappings at `:49-57` |
| Native behaviour (Bun) | `bun run --cwd packages/mc-shm-native test:bun` | `:196` | `tests/suite.test.ts` through `capability.ts`, `mechanism.ts`, `runtime.ts`. Runs under `MC_SHM_NATIVE_CLAIMED_TARGET: "1"` (`:197`) |
| Native behaviour (Node 24) | `bun run --cwd packages/mc-shm-native test:node` | `:203` | same suite through `tests/runtime.ts`, also with the claimed-target flag (`:202`) |
| Mandatory capability activation | `test:capability:bun` and `test:capability:node` | `:206-208` | `tests/capability.ts` asserts either an ACTIVATED outcome or a TERMINAL_STARTUP_FAILURE with a reason, and that no channel leaks either way. Runs **without** the claimed-target flag |
| Plugin shared-memory lifetime (Node 24) | `bun run --cwd packages/plugin test:mc-shm:node` | `:214` | native lease and channel lifetime across the runtime boundary |
| Architecture audit | `bun test scripts/check-mc-shm-architecture.test.ts`, `bun run check:shm-architecture` | `:55`, `:58` | the forbidden-name gate, scanning `packages/plugin/src/shared/mc-host-client` and `packages/mc-shm-native/src` among its five roots |

Two more `mc-host-client` gates run outside `shm-source-build`:
`mc-host-client-interop` (`ci.yml:442`) runs the Node 24 smoke at `:461`, and
`ci.yml:216-217` typechecks the plugin.

**`MC_SHM_NATIVE_CLAIMED_TARGET` inverts the mechanism gate from tolerant to
strict, and only on two of the six.** `tests/mechanism.ts:19` reads it; with it
set, `requiredAddonPath` throws when the local addon is absent (`:24`) and the
capability probe must return `available: true` (`:31`). It is set at `ci.yml:197`
and `:202` only, so the two `test:capability:*` legs at `:206-208` accept a
TERMINAL_STARTUP_FAILURE as a pass (`tests/capability.ts:27-39`).

**One gate has no Rust counterpart and it is why quiet area 3 exists.**
`ci.yml:219-223`, "Reject prebuilt native modules", runs
`test -z "$(git ls-files '*.node')"`, then removes
`packages/mc-shm-native/mc_shm_native.node` and asserts its absence. The removal
runs **after** the four native and plugin test steps, and `ci.yml:193`
(`build:source`) creates that file **before** them.

Status for all eight TypeScript gates: `unaudited`.

## Production assertions and guards

**Assertion density is near zero on both sides of the boundary. Enforcement is
typed rejection and constant-time comparison.** Figures below were re-derived per
file by cutting each at its last `#[cfg(test)]` and counting only production lines:
`setup_socket.rs` (cut at `:441`), `auth.rs` (`:633`), `connection_file.rs`
(`:353`), `instance.rs` (`:889`), `packages/mc-shm-native/src/setup.rs` (`:377`).

**Four corrections to lens B's figures**, recorded per METHOD.md rule 1. Lens B
reported zero assertions of any kind, three `.expect(`, four constant-time
comparisons, and five `let _ =`. The re-derived figures are one `debug_assert!`,
five `.expect(`, five constant-time comparisons, and nine `let _ =`. All four
corrections are in the same direction, and the pattern is the same each time: lens
B enumerated the sites in `setup_socket.rs` and the peer's `setup.rs` and did not
re-scan `auth.rs` and `instance.rs` for the same shapes. None of the corrections
changes a catalog record.

**`assert!` / `assert_eq!` / `panic!` / `unreachable!` / `todo!` in production
halves: none found**, across all five files.

**`debug_assert!`: one, and it is the sub-part's only assertion of any kind.**
`instance.rs:592-595`, on the atomic-write helper:

```
debug_assert!(
    ATOMIC_WRITE_NAMES.contains(&name),
    "{name} is not registered in ATOMIC_WRITE_NAMES; its crashed temps would never be swept"
);
```

Its comment at `:588-591` states the reasoning: the stale-temp sweep reclaims a
crashed writer's attempts by name prefix, so an unregistered name would leak one
temp file per crashed write with nothing to reclaim it, and "the assertion makes an
unregistered name fail the first test that writes it." Two facts about its reach.
It is compiled out of release builds, and the tests it is written to fail are
`instance.rs`'s 22 in-crate tests, which CI does not build. So **the one assertion
in this sub-part fires in no CI job.** Status: `unaudited`; adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

**`.expect(`: five, in three clusters.**

| Cluster | Sites | Label |
| --- | --- | --- |
| Infallible slice-to-array | 2 | `setup_socket.rs:400` and `packages/mc-shm-native/src/setup.rs:290`, both `"four-byte prefix"`, each guarded by a preceding read that fills four bytes |
| HMAC key acceptance | 2 | `auth.rs:147` `"HMAC accepts keys of any length"` and `packages/mc-shm-native/src/setup.rs:229` `"HMAC accepts every key length"` |
| Infallible serialization | 1 | `instance.rs:332` `"connection info serialization cannot fail"`, on `serde_json::to_vec_pretty` of the `ConnectionInfo` about to be published |

The HMAC cluster is the one that states a library contract rather than a local
invariant, and it is worth correcting lens B's reading of it: **the same `expect`
exists on both sides**, not only on the peer. On the peer side `connect` checks
`key.len() != 32` at `:102-104` before reaching it; on the host side
`authenticate_server` calls `validate_key(key)` at `auth.rs:242` before the first
read. In both cases the `expect` is unreachable in practice through the caller
rather than unreachable by construction.

**`.unwrap()`: none found** in any production half.

**`catch_unwind`: none found.** This sub-part has no panic boundary of its own.
`connection.rs:942` wraps `activation_token_with` under `catch_unwind` in a test,
which is Part 2a scope.

**Constant-time comparisons: five, and they are the sub-part's real guards.**

| Side | Site | What it compares |
| --- | --- | --- |
| host | `auth.rs:404-406` `constant_time_eq`, called at `:275` | the expected `ClientAuth` against the presented one, yielding `AuthError::InvalidClientAuth` at `:276` |
| host | `setup_socket.rs:267-272` | the presented activation token against the minted one, yielding `SetupError::InvalidActivation` at `:275` |
| peer | `packages/mc-shm-native/src/setup.rs:200` | the expected server proof against the presented one |
| peer | `packages/mc-shm-native/src/setup.rs:201` | the expected daemon id against the presented one |

The host's `constant_time_eq` is the one lens B described in prose but omitted from
its count. `auth.rs:385-387` states the design reason for fencing both directions:
"a proof check has the failure mode where a suite proves only that it can say NO."

**One comparison in the chain is deliberately not constant-time.**
`server.daemon_ver != expected_daemon_ver`
(`packages/mc-shm-native/src/setup.rs:202`) is a plain string comparison, which
`docs/mc-host-wire-protocol.md:190-192` covers by classifying version binding as
"snapshot binding, not cryptographic authentication".

**Discarded results (`let _ =`): nine, and six are on a teardown or cleanup
path.**

| Site | What is discarded |
| --- | --- |
| `setup_socket.rs:46` | removing a socket whose chmod failed. A failure here leaves an over-permissive socket at the path and returns the chmod error |
| `setup_socket.rs:336`, `:337` | `goodbye_client` discards both the write and the shutdown |
| `packages/mc-shm-native/src/setup.rs:165`, `:171` | the peer's `goodbye`, same shape |
| `auth.rs:211` | `teardown_failed_handshake` discards the timed `stream.shutdown()` |
| `instance.rs:405` | `remove_file` on a cleanup path |
| `instance.rs:631`, `:848` | `unlinkat` on the temp-write rollback and the stale-temp sweep |

A clean `Goodbye` is therefore best-effort on both sides, which is what makes
`PeerClose::UnexpectedEof` reachable without a peer crash. `goodbye_client` also
uses a hardcoded 100 ms deadline (`setup_socket.rs:335`, mirrored at
`packages/mc-shm-native/src/setup.rs:164`) that no configuration reaches.

**Typed rejection guards.** `SetupError` (`setup_socket.rs:88-98`) is nine
variants with fixed `Display` strings (`:108-118`) and a `source()` exposing only
the inner `io::Error` (`:123-128`). `PeerClose` (`:80-85`) is three. The peer
collapses everything into three `io::Error` constructors, `invalid()`
(`InvalidData`), `identity_mismatch()` (`PermissionDenied`), and `timed_out()`
(`TimedOut`), at `packages/mc-shm-native/src/setup.rs:359-375`. So nine host-side
distinctions reach the peer as at most three. `NativeStartupError`
(`packages/mc-shm-native/index.ts:34-39`) carries a nine-member closed reason set
(`:22-31`) and a message built only from that reason.

**Length bounds before allocation, on both protocols.** `auth.rs:422-428` rejects
a prefix over `MAX_AUTH_MESSAGE_LEN` = 4,096 (`auth.rs:18`) before the
`vec![0u8; len]` at `:430`; `setup_socket.rs:361-363` and `:378` reject a prefix
over `MAX_SETUP_MESSAGE_LEN` = 16 KiB (`:24`) before their allocations.
`read_message_from_prefix` (`:388-416`) adds a `checked_add` for the total (`:404`)
and rejects a prefix longer than the declared frame (`:405-407`). **No unbounded
allocation exists on either protocol.**

**One name resolves an open question rather than reporting a bug.**
`read_message_unbounded` (`setup_socket.rs:355-367`) applies the same 16 KiB cap at
`:361` that `read_message` applies at `:378`. The word `unbounded` refers to the
**deadline**, not the length: it is the only reader with no `timeout_at`, because
it is the peer-lifetime sentinel that must block indefinitely under a
`read_cancel`-armed `select!` (`connection.rs:196-206`). This resolves the
re-scope's open question at
`part-2-rescope/scope-map-and-risk-ranking.md:744-746`, which asked whether the
name signalled a missing bound. It does not. The name is misleading; the bound is
present. Confirmed independently by both lenses and re-verified here at `:361-364`.

## Documentation describing deleted mechanisms

**Two, both in `auth.rs` doc comments, and both cite tests by name.** This
category is empty everywhere else in the sub-part, which is what makes it worth its
own section: these are the only two places where a comment's stated enforcement
mechanism no longer exists. Both are recorded per METHOD.md rule 3 with each side
cited and neither resolved in the comment's favour.

### D1 — `auth.rs:693-698` cites a TypeScript test file the refactor deleted

The comment, on `committed_wire_vectors_pin_the_proof_construction` at `:700`:

> The TypeScript client asserts its handshake against the same fixed vectors
> (`packages/plugin/src/shared/mc-host-client/auth.test.ts`), so they form a
> cross-language contract: changing the domain separator, the field order, or the
> MAC breaks the build here, where the change is being made, instead of surfacing
> as a handshake failure against a peer that has not been rebuilt.

Verified at `HEAD`: `packages/plugin/src/shared/mc-host-client/auth.test.ts` does
not exist, and neither does `auth.ts`. Listing the directory returns 22 entries and
neither name is among them. `git show --stat ed487e11` shows both deleted, at 365
and 314 lines, by the commit that made the ring transport mandatory. A
repository-wide search for `auth.test.ts` returns nothing outside `node_modules`.
A search for `subc-server-v1` in TypeScript returns two hits and neither is a
handshake implementation: `packages/plugin/scripts/mc-host-client-boundary.test.ts:221`
uses the string as a forbidden-name fixture, and
`packages/plugin/dist/shared/mc-host-client/auth.d.ts:24-25` is an untracked build
artifact under a `dist/` path excluded by `.gitignore:16`.

**Why this is more than a stale path.** The comment's stated *mechanism* is
"breaks the build here, where the change is being made", and that mechanism is what
let a host-side developer trust the domain constants. It is gone. What replaced it
is a different cross-language pin that lives on the other side: the peer's
`auth_proofs_match_committed_wire_vectors`
(`packages/mc-shm-native/src/setup.rs:401-432`) asserts the same literal vectors,
is in a crate the host does not depend on for authentication, and unlike the host's
own vector test it **runs in CI** (`ci.yml:177`, `:184`). So the contract survived
and moved, and the comment now names the one location where it no longer lives.
See quiet area 2.

### D2 — `auth.rs:394-396` cites a test that exists nowhere

The comment, inside the 19-line mutation-coverage argument at `:385-403`:

> ALWAYS-TRUE is caught by `foreign_server_reused_port_never_receives_client_auth`
> -- the case where a client must refuse a server that cannot produce the proof.
> Named for the refusal, and it holds that direction directly.

Verified: a repository-wide grep for that identifier across `crates/`,
`packages/`, and the integration binaries returns **exactly one hit, the comment
itself at `auth.rs:394`**. Two surviving tests in the same module hold the same
direction under different names, `invalid_server_proof_sends_no_client_auth`
(`:1074-1081`) and `daemon_id_mismatch_sends_no_client_auth` (`:1082-1089`), so the
*coverage* is probably intact while the *citation* is not. That makes this a weaker
finding than D1, a renamed test rather than a deleted mechanism. It is recorded
anyway because of where it sits: inside a comment whose entire purpose is to make
mutation coverage auditable by naming the tests that fence each direction. A
comment that exists to let a reader find the fences, naming a fence that cannot be
found, defeats its own purpose.

The neighbouring claim in the same comment carries a second-order problem.
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
deliberately-incidental coverage the comment relies on is not executed, and the
comment's warning about silent removal applies with more force than it states.

### Elsewhere: none found

No doc comment in `setup_socket.rs`, `instance.rs`, `connection_file.rs` or
`packages/mc-shm-native/src/setup.rs` names a deleted file or mechanism.
`docs/mc-host-shm-transport.md` and `docs/mc-host-wire-protocol.md` were audited
against the refactor's deletion set and describe no removed machinery; the wire
document's transport-selector statements are negative claims the deletion made
true.

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any check proves.

### 1. The occupant gate is a three-clause conjunction with one clause tested

`setup_socket.rs:30-32` admits removal of an existing path entry only when the
entry is a socket, owned by the effective uid, and at mode exactly `0o600`:

```
let secure_stale_socket = metadata.file_type().is_socket()
    && metadata.uid() == rustix::process::geteuid().as_raw()
    && metadata.mode() & 0o777 == 0o600;
```

This is the decision about whether the host binds over a hostile object, and it is
also the decision about whether it *unlinks* one. The refusal at `:33-38` precedes
the unlink at `:39`, and `symlink_metadata` at `:28` rather than `metadata` means a
symlink is classified as a symlink and fails the `is_socket()` clause rather than
being followed.

The sole test, `insecure_stale_occupant_is_not_replaced` (`:494-501`), plants a
**regular file** (`:497`). So `is_socket()` is the only clause exercised. The uid
clause and the mode clause are both unexercised, and **the mode clause is the
interesting one**: a same-uid socket at mode `0o666` is exactly the residue a
previous incarnation running under a permissive umask leaves behind, which is the
untested residue this area is really about. Nothing plants a `0o666` socket, a
symlink, a dangling symlink, a directory, or a FIFO.

The reason the gap is tolerable is real and is in another file:
`instance.rs:571-572` narrows the parent directory to `0o700` unconditionally,
making the whole cross-uid class unreachable. **Nothing states that argument in
either file, and nothing tests the composition.** Two further windows in the same
function have no test either: `symlink_metadata` at `:28` to `remove_file` at `:39`,
and `remove_file` at `:39` to `bind` at `:44`, the second of which lets a same-uid
process take the name and force `EADDRINUSE`, failing the host's start with no
connection file published.

### 2. The CI-enforced authority for the proof construction is the peer, not the host

49 of the 51 in-crate tests run nowhere but a developer's machine, and **the
asymmetry is the finding, not the count.**

The host's `committed_wire_vectors_pin_the_proof_construction` (`auth.rs:700`) and
the peer's `auth_proofs_match_committed_wire_vectors`
(`packages/mc-shm-native/src/setup.rs:401-432`) assert the same 64 literal bytes
from `docs/mc-host-wire-protocol.md:180` and `:182`. **Only the peer's runs.** The
proof construction is therefore CI-pinned from the implementation that is *not*
the host, in a crate the host does not depend on for authentication, while the
host's own 11 auth tests are unexecuted, including server-nonce freshness
(`auth.rs:924-939`), the 4,096 pre-allocation cap, and both no-`ClientAuth`
refusal directions (`:1074-1081`, `:1082-1089`).

The construction is defined three times and nothing derives one definition from
another: the prose formula at `docs/mc-host-wire-protocol.md:186-190`, the host's
`compute_proof` (exported at `lib.rs:42`), and the peer's `proof` at
`packages/mc-shm-native/src/setup.rs:222-235` with its own copies of the two domain
separators at `:20-21`. The same duplication pattern holds for four more constants
with no cross-check between crates: `MAX_SETUP_MESSAGE_LEN` = 16 KiB
(`setup_socket.rs:24` and peer `:19`), `MAX_AUTH_MESSAGE_LEN` = 4,096
(`auth.rs:18` and peer `:18`), `RING_DESCRIPTOR_COUNT` = 2 as a named constant on
the host (`setup_socket.rs:25`) and a bare `2` on the peer (`:255`, with
`ScmRights(3)` at `:240`), and the ring profile string, defined at
`ring_transport.rs:31`, `packages/mc-shm-native/src/lib.rs:27`, and
`packages/mc-shm-native/index.ts:8`.

The architecture gate that could have caught D1 and D2 does not look at
documentation. `scripts/check-mc-shm-architecture.ts:7-23` lists five source
roots, one file and six manifests, and no documentation path appears; it also skips
`.test.ts` (`:48`) and never walks `crates/mc-host/tests/`. So both findings above
sit outside every mechanical gate this repository has.

### 3. The manifest-and-checksum branch is five of nine failure reasons and CI never enters it

`packages/mc-shm-native/index.ts:151-187` (`packageAddonPath`) implements manifest
existence (`:161-163`), package-and-target identity (`:168-173`), checksum shape
(`:175-177`), addon existence (`:179-181`), and a SHA-256 comparison (`:182-185`).
That is `missing_manifest`, `wrong_platform_payload`, `missing_checksum`,
`missing_addon` and `checksum_mismatch`: **five of the nine members of the closed
reason set at `:22-31`.**

`requireAddon` (`:189-210`) reaches it only in an `else`. Verified at `HEAD`:

```
const localPath = new URL("./mc_shm_native.node", import.meta.url);
const addonPath = existsSync(localPath)
    ? fileURLToPath(localPath)
    : packageAddonPath(platform);
```

**CI builds exactly that file first.** `ci.yml:193` runs
`bun run --cwd packages/mc-shm-native build:source` before every native and plugin
test step, and `:219-223` removes it only afterwards. So every CI TypeScript test
executes through the local branch and never through `packageAddonPath`. The
profile and target checks that follow (`:199-201`, `:202-204`) do run.

`shm-frame-channel.test.ts:49-53` asserts the *classification* of four
`NativeStartupError` reasons, constructed directly as `new NativeStartupError(...)`
rather than produced by the loader. So the verification
`docs/mc-host-shm-transport.md:83` promises "before loading" has its
classification tested and its **production** untested. Nothing constructs a
manifest with a wrong checksum and observes `checksum_mismatch` come out of
`packageAddonPath`.

## Claims stated somewhere and checked nowhere

Recorded so a later pass does not read the absence of a check as the absence of a
claim. Each is `unaudited`.

- **`role` grants nothing.** `auth.rs:70-81` states at length that
  `ClientHello.role` "is parsed and then discarded -- any peer holding the key can
  claim any role, so it must never decide admission, capacity, or privilege", and
  `connection.rs:128-131` repeats the rule at the one place a role could have
  branched. **No test presents two different roles with the same valid key and
  asserts identical admission.** The claim is held by `Authenticated` being a unit
  struct with no fields.
- **The key is a bearer capability with no narrowing.**
  `docs/mc-host-wire-protocol.md:26` states that possession grants every
  direct-profile operation including `host.shutdown`, so "a diagnostic or proxy
  principal that holds the bearer is not read-only, whatever its role label or
  mount permissions claim." This is a negative architectural claim: nothing in
  `auth.rs` or `setup_socket.rs` narrows a key holder's authority, which is what
  makes it true. **None found, and none is possible as written**; it is a
  documentation-only obligation on deployers.
- **Host-side profile acceptance.** `docs/mc-host-wire-protocol.md:563` says
  "Setup accepts only the release's current wire version, descriptor schema, and
  ring profile." `activate_server` (`setup_socket.rs:261-284`) validates wire
  version, schema, and the token, and **never the profile**. The profile is
  validated only by the peer (native `setup.rs:122`, managed
  `ring_transport.rs:642-644`). Defensible, since the host is the profile's sole
  producer, but the sentence describes a host check that does not exist.
- **Nonce non-reuse as a MUST.** `docs/mc-host-wire-protocol.md:177` says both
  nonces MUST NOT be reused within or across connections or host incarnations.
  `auth.rs:379-383` draws 32 fresh bytes per call with no history, which satisfies
  the intent at a 2^-256 collision bound and is not an enforced non-reuse. More
  materially, the MUST is stated for *both* nonces and the host never inspects
  `client_nonce` (`auth.rs:244-252`), so the peer's half is unenforceable by the
  host.
- **The two-second budgets stated as coupled.**
  `docs/mc-host-wire-protocol.md:747` states the client's whole-handshake deadline
  and the host's authentication deadline are "not independent". In code they are
  two separate fields with the same default, `auth_deadline` (`config.rs:223`) and
  `transport_setup_deadline` (`:227`), consumed in sequence, so a peer's single
  2-second budget faces a host that may spend up to 4 seconds. **Nothing in
  `config.rs` validates the relationship.**
- **The macOS size-seal gap, and its check is absent by design.**
  `docs/mc-host-shm-transport.md:85` states that macOS does not provide the Linux
  size-seal contract, so "a same-user process that holds a shared-memory
  descriptor remains trusted not to resize it after validation. macOS release
  remains blocked until designated-host attachment tests prove the platform's
  resize behavior." **None found, and the document says the proving test does not
  exist.** Recorded so a later pass does not read the absence as an oversight. The
  macOS CI legs (`ci.yml:181-187`) build and run `mc-shm-native`,
  `mc-shm-transport --test contract --test fuzz_corpus`, and `mc-host --test client
  --test lifecycle`; none is a resize test.
- **The published socket path in the doc's example does not match the code.**
  `docs/mc-host-wire-protocol.md:76` shows
  `"setup_socket": "/run/user/1000/cortexkit/mc-host.sock"`. The code produces
  `${dataDir}/cortexkit/run/setup.sock` (`instance.rs:167`, `:177-179`,
  `runtime.rs:834`), and the same document's `:70` says clients read
  `${dataDir}/cortexkit/run/subc-connection.json`, so the example contradicts its
  own section. Low impact, because the path is read from the file rather than
  constructed, but it is a concrete doc lag with no gate.

## Sampling limits on this inventory

Four limits, stated so a later pass does not read absence as absence of risk.

- **Per-file test descriptions for `instance.rs` (22) and `connection_file.rs` (4)
  are inherited from lens B rather than re-enumerated here.** The counts were
  re-derived; the cluster descriptions were not. `setup_socket.rs`, `auth.rs`, and
  the peer half were re-checked site by site.
- **Whether any CI job is a required status check for merge is unverifiable from
  workflow content.** That is repository settings. It matters because three of the
  six relevant integration binaries are unnamed and the two jobs that matter here,
  `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`), may or may
  not gate a merge. Carried forward from
  `part-2-rescope/scope-map-and-risk-ranking.md:750-752`.
- **Whether a never-executed test is `Exercised: partial` or `Exercised: not yet`
  is an open convention question**, and it governs 49 of the 51 in-crate checks
  here. The catalog uses lens A's labels unchanged. Raised identically in the 2b
  sibling lens and in five prior sub-parts
  (`../part-4e-rendering/existing-checks.md:840-846`). (needs human input)
- **Whether `packages/mc-shm-native/src/setup.rs` belongs to Part 1 or to 2c is
  unresolved** and it changes this inventory materially. This pass treats it as 2c,
  per the re-scope proposal at
  `part-2-rescope/scope-map-and-risk-ranking.md:738-740`. It is the only unit in
  this sub-part whose tests run in CI, so **if Part 1 owns it, this sub-part has
  zero CI-executed source-resident checks.** (needs human input)
