# Part 2c fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

Same rules as the earlier parts: safety checks must hold *while* their faults are
active; liveness checks need a bounded fault-free window, **stated in a unit the
code bounds — attempts, deadlines, or an explicit interval**; a rare branch needs
deterministic injection to be reachable at all; and coverage checks assert
independent preconditions, never the violation.

The liveness clause is spelled out because an earlier revision of this part read it
as excluding deadlines and therefore carried no liveness record at all. It admits
them, and the part now has two: the deadline record and the sentinel's
cancellation record, both in Group S4 below.

Three framing points specific to this part.

**First, the dominant obstacle is not a missing fault.** It is that 49 of the 51
in-crate tests in this scope execute in no job, and three of the six integration
binaries that reach the boundary are named in no workflow. The availability column
below therefore describes what a developer can construct locally. Two things in
this scope are protected by automation: the peer half's 2 tests
(`ci.yml:177`, `:184`) and the three named integration binaries (`:132`, `:133`,
`:179`, `:187`).

**Second, the hardest fault in this part already exists as a checked-in fixture.**
`tests/shm_failure_modes.rs:44-58` builds a peer that authenticates against the
real host, calls `receive_grant`, and then parks on `std::future::pending()`
forever without sending `Activate`. That is the exact adversary the boundary's
sharpest records are about, it runs in CI today through `ci.yml:133`, and it was
written for a capacity question rather than an authority one. Several records are
therefore exercisable immediately, by adding an assertion to a state the suite
already reaches rather than by building a new harness.

**Third, one availability claim in the lens files is pessimistic and is corrected
here.** Lens A records the `prepare`-timeout exit
(`connection.rs:157-164`) as needing "either a configured near-zero deadline or
injected slowness in `prepare`", written as if both were obstacles. The configured
form is available today: `transport_setup_deadline` is an ordinary field on
`HostTiming` (`config.rs:227`) and integration tests already set its siblings
through the `start_with` closure (`tests/lifecycle.rs:165`,
`tests/activation.rs:127-128`). So the exit is reachable. What remains blocked on
2b is the record's **oracle**, not its construction, and that distinction is
preserved rather than collapsed.

## Fault classes required

`S0` is listed first because it is the cheapest capability in this part and it is
not a fault at all.

| Class | Description | Available today |
| --- | --- | --- |
| **S0** test execution in CI | Any workflow job that builds and runs the `mc-host` lib target, or that names `instance_security`, `host_roundtrip`, or `activation` | **Split, and the split runs along a crate boundary.** *No* for the `mc-host` half: every `-p mc-host` invocation carries a `--test <name>` filter (`ci.yml:132`, `:133`, `:134`, `:178-179`, `:187`, `:190`), which selects one integration binary and does not build `--lib`, so 49 in-crate tests are never compiled. Zero doctests exist in the four scope files, so `cargo test -p mc-host --doc` (`:190`) covers nothing here, and the one `debug_assert!` (`instance.rs:592-595`) is both release-stripped and in an unbuilt module. Grepping all five workflow files for the three unnamed binaries returns nothing, costing 23 further test functions. *Yes* for the peer half: `ci.yml:177` and `:184` run `-p mc-shm-native` unfiltered. **Cost: a workflow change and no new infrastructure** |
| **S1** a peer that takes descriptors and never activates | Authenticate, `receive_grant`, then diverge from the protocol: send nothing, a wrong token, or a truncated `Activate` | **Yes, and it already exists.** `tests/shm_failure_modes.rs:44-58` is exactly this peer, in the `setup` role, on the real host, and it runs in CI (`ci.yml:133`). What no test does is *map the received descriptors and write through them*, which is the step that turns a capacity fixture into an authority oracle. The fds come back from `mc_host::setup_socket::receive_grant` as an `[OwnedFd; 2]`, and `mc-shm-transport`'s `Ring::attach` is the same call the managed client makes at `ring_transport.rs:651-654`. **Capability present; the assertion is missing** |
| **S2** a captured proof replayed within and across incarnations | *Within:* record a full transcript, open a fresh connection to the same live host, and resend the recorded `ClientHello` and `ClientAuth` without recomputing. *Across:* capture a `ConnectionInfo` snapshot, restart the host in the same data directory, and dial the new socket with the old snapshot | **Yes for both, and both need only a fixture.** *Within:* the handshake driver at `auth.rs:883-884` and the raw harness at `tests/support/raw_client.rs:353`, `:879` both drive a handshake byte-wise, and `auth.rs:1022-1073` already stands up a scripted counterparty over `UnixStream::pair`. The oracle must assert `AuthError::InvalidClientAuth` from `auth.rs:275-277` specifically, not merely a closed socket. *Across:* `tests/host_roundtrip.rs:153` `restart_rotates_credentials_and_invalidates_old_state` already restarts a host in one data directory, so the two-incarnation state exists; the missing half is a peer that reuses the earlier snapshot and an assertion that it fails at `InvalidServerProof` (`auth.rs:333-335`) or `DaemonIdMismatch` (`:336-338`) **before** writing `ClientAuth`. Note the binary is unnamed in CI, so this capability sits behind S0 |
| **S3** a hostile occupant at the socket path, in each of its three clauses | Filesystem state planted at `${dataDir}/cortexkit/run/setup.sock` before `bind_owner_only` runs, one shape per failing clause of the conjunction at `setup_socket.rs:30-32` | **Partial, and the partition is by privilege.** *`is_socket()` clause: yes, and tested* — `insecure_stale_occupant_is_not_replaced` (`:494-501`) plants a regular file at `:497`. Also unprivileged and untested: a dangling symlink, a symlink to a live socket, a directory, and a FIFO, all four constructible in a `tempfile::tempdir()` exactly as the existing test does. *mode clause: yes, unprivileged, untested* — `std::fs::set_permissions` on a socket the test binds itself produces a same-uid `0o666` socket, which is the residue a previous incarnation under a permissive umask leaves. *uid clause: no* — a socket owned by another uid needs a second uid, which is likely unconstructible in ordinary CI and should be recorded as such rather than skipped silently. The two timing windows in the same function, `:28` to `:39` and `:39` to `:44`, are constructible with a second thread in-process |
| **S4** concurrent setup saturation | Handshake permits exhausted at the same instant that at least one authenticated connection sits inside `activate_server` between the descriptor send (`setup_socket.rs:260`) and the token compare (`:273`) | **Partial: the capability exists, the fixture does not.** Both bounds are ordinary config fields, `max_handshakes` = 32 (`config.rs:128`) and `max_connections` = 64 (`:129`), and the two existing saturation tests already set the first through `start_with` (`tests/lifecycle.rs:239` sets 1, `:339` sets 4). Neither can populate the second clause, because both use squatters that never speak (`:243-244`, `:355-357`). What is missing is one fixture: a dialer that authenticates and then delays its `Activate` inside the 2-second `transport_setup_deadline` (`config.rs:227`). That is `tests/shm_failure_modes.rs:44-58` with a bounded sleep instead of `pending()`. **The second clause also needs an observation point inside `activate_server`, which is a host-source marker that does not exist** |
| **S5** an abandoned setup | An exit from `run_connection` after `ring.prepare` succeeded and before activation completed, on each of four distinct paths | **Partial, and only the oracle is blocked.** *Three exits: yes.* `connection.rs:166-169` and `:180-185` both pair `sender.discard()` with `root.cancel()`, and the peer that reaches them is S1's, plus the SIGKILL form which `tests/shm_failure_modes.rs:232-245` and `:247-263` already drive in the `setup` role. *Fourth exit: constructible, contrary to lens A.* The `timeout_at` at `connection.rs:157-164` is reached by setting `config.timing.transport_setup_deadline` near zero through the `start_with` closure, the same mechanism `tests/lifecycle.rs:165` uses for `health_interval`. No injected slowness is required. **What is blocked is whether dropping a `PreparedRing` inside a detached `spawn_blocking` releases the admission charge**, which needs `ring_transport.rs` and the transport crate. That is a 2b question and is left open rather than answered |
| **S6** a manifest or checksum mismatch | A load of the addon that goes through `packageAddonPath` (`packages/mc-shm-native/index.ts:151-187`) rather than the local sibling, with a planted manifest that fails one of its five checks | **Constructible locally; structurally unreachable in CI as configured.** `requireAddon` (`:189-210`) prefers the local addon: `existsSync(localPath)` at `:194-196` short-circuits, and `packageAddonPath` runs only in the `else` at `:197`. `ci.yml:193` runs `build:source` to create exactly that file before all four native and plugin steps, and `:219-223` removes it only afterwards, so five of the nine reasons in the closed set at `:22-31` are never produced. The four reasons `shm-frame-channel.test.ts:49-53` exercises are constructed as `new NativeStartupError(...)`, not produced by the loader. **Cost: a fixture plus a CI step ordering change, not new infrastructure** |

One availability caveat that cuts across S1, S4 and S5. All three route through a
real host process, so the harness cost is `TestHost::start_with` plus a scripted
peer, and the scripted peer already exists in two shapes:
`tests/support/raw_client.rs` (byte-level, unnamed in CI) and the subprocess client
in `tests/shm_failure_modes.rs` (named in CI). Preferring the second keeps a new
oracle inside an executing binary, which matters more here than harness elegance
while S0 is open.

## Map

All 16 records, after the portfolio disposition added two: the deadline liveness
record, and the sentinel's cancellation clause split out of its safety sibling.
**"Non-vacuous today" means a developer can construct the required state with the
current harness.** It does not mean the check runs anywhere; for 14 of the 16 the
only checks that exist are in unexecuted modules or unnamed binaries.

Reachability is recorded per record in `catalog.md`, with its own evidence clause,
and is not asserted in a blanket claim here. Fifteen records are
`default-production`: the accept path (`runtime.rs:1042-1044` into `connection.rs`)
is the only accept-path body, the ring is mandatory after `ed487e11`, and every
bound and deadline the records depend on ships with a default
(`config.rs:128-129`, `:223`, `:227`). One record is **not** uniform and this map
previously flattened it.
`setup-a-only-an-authenticated-grant-enters-the-native-channel-registry` is
`default-production` for `connect_setup`, reached from `shm-frame-channel.ts:77`,
while its actual subject `attach` is a published napi export
(`packages/mc-shm-native/src/lib.rs:490-491`, exported at `index.ts:526-529`)
**compiled with no shipped-plugin caller** — a grep of `packages/plugin/src` at
`HEAD` finds no non-test `.attach(` call. That is stated rather than resolved to
`default-production`, because it is exactly the fact that makes the record's
guarantee provable only over the shipped plugin path and false as a universal
claim.
`setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection` is genuinely
production on both halves: the native path through `shm-frame-channel.ts:77` and
the managed Rust path for embedders through `client.rs:346`.

### Group S1: the one authorization gate

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| setup-a-no-descriptor-leaves-the-host-without-a-verified-client-proof | A peer that connects and then presents a malformed `ClientHello`, a short nonce, a wrong `ClientAuth`, or nothing at all, with the `sendmsg` at `setup_socket.rs:151-159` observed. The misbehaving peers exist: `tests/lifecycle.rs:1643-1673` and `tests/protocol_vectors.rs:294` both drive them and assert no byte reaches the socket, which subsumes descriptors (S0 for execution) | **Yes** — the adversary and the observable both exist; the marker at the send site does not |
| setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token | A peer that authenticates, calls `receive_grant`, then diverges: sends nothing, a wrong token, or a truncated `Activate`. Then **map the two received fds and write through them** (S1). `tests/shm_failure_modes.rs:44-58` builds every step except the map-and-write | **Yes** — the fixture is checked in and runs in CI; one `Ring::attach` and one write turn it into the oracle |
| setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it | Two peers that both authenticate and then swap the tokens they received, asserting `SetupError::InvalidActivation` from `setup_socket.rs:275` (S4 for the overlap). Separately, one connection sending `Activate` twice, asserting `SetupError::InvalidMessage` from `:283`, which needs no concurrency at all | **Yes** — the double-`Activate` half needs one connection; the cross-connection half needs S4's dialer, which is a variation on an existing fixture |

### Group S2: credential freshness and proof refusal

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| setup-a-a-captured-client-proof-never-authenticates-twice | A passive observer of one handshake, then a fresh connection replaying the recorded `ClientHello` and `ClientAuth` verbatim (S2, within-incarnation half). The oracle must name `AuthError::InvalidClientAuth` (`auth.rs:275-277`), because a closed socket is also what a malformed frame produces | **Yes** — `auth.rs:1022-1073` already scripts a counterparty over `UnixStream::pair`; only the record-and-resend is new |
| setup-a-credentials-do-not-survive-a-host-incarnation | Two host incarnations in one data directory plus a peer reusing the earlier `ConnectionInfo` (S2, across-incarnation half). Assert the peer fails at `InvalidServerProof` (`auth.rs:333-335`) or `DaemonIdMismatch` (`:336-338`) and that **no `ClientAuth` frame was written** | **Yes** — `tests/host_roundtrip.rs:153` already restarts a host in one directory. The binary is unnamed, so the result sits behind S0 |
| setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof | An impostor listener answering `ClientHello` with a syntactically valid `ServerProof` carrying a wrong proof, a wrong `daemon_id`, or a wrong `daemon_ver`. Assert the peer writes exactly one message and then closes | **Yes** — this is the one record whose adversary is already constructed. `auth.rs:1022-1073` `rejected_server_sends_no_client_auth` is driven for two of the three reasons (`:1074-1081`, `:1082-1089`); the `daemon_ver` case is the visible gap |

### Group S3: the socket as a filesystem object

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid | A permissive umask such as `0o000` in the host process, and a concurrent observer sampling the socket's mode between `bind` (`setup_socket.rs:44`) and `set_permissions` (`:45`). Demonstrating actual cross-uid connectability additionally needs a second uid (S3, uid clause) | **Partial** — the window sample is constructible with a second thread and a permissive umask, as `instance.rs:979` already does for the directory and the file. The cross-uid demonstration is likely unconstructible in CI and should be recorded as a limit rather than skipped |
| setup-a-a-hostile-occupant-of-the-socket-path-fails-closed | Filesystem state planted at the socket path per failing clause: a dangling symlink, a symlink to a live socket, a `0o666` socket, a socket owned by another uid, a directory, and a FIFO. Assert `io::ErrorKind::PermissionDenied` **and** that the occupant is still present afterwards (S3) | **Partial** — four of the six shapes are unprivileged in a temporary directory and the existing test's structure (`:494-501`) already asserts survival, so parameterizing it covers them. The wrong-owner shape needs a second uid |

### Group S4: bounded work, abandoned setups, and the sentinel

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released | With `max_handshakes = 1`, a squatter that never speaks holding the slot, a second accept asserted to close with no bytes read, then release and re-acquisition. Plus an enumeration of every exit before `drop(handshake_permit)`: the auth error at `connection.rs:130-133` and the connection-permit exhaustion at `:137-139` | **Yes** — both squatter shapes exist in the test support (`tests/support/raw_client.rs:878`) and two lifecycle tests already drive saturation and non-starvation (`tests/lifecycle.rs:237`, `:337`) |
| setup-a-an-abandoned-setup-strands-no-ring-charge | N abandoned setups through each of four exits, asserting the accounting at `ring_transport.rs:199-203` returns to its pre-attempt value. Three exits need S1's stalling peer, already built. The fourth needs `ring.prepare` to miss `config.timing.transport_setup_deadline` (S5) | **Partial, and for a different reason than this row previously gave.** The oracle is no longer blocked: dropping the `PreparedRing` drops the sole `mpsc::Sender` (`frame_channel.rs:685-694`), `run_endpoint` returns on `queue.recv() == None` (`ring_transport.rs:437-440`), and `admission.release()` runs at `:291`. **The 2b dependency is closed and the record is now `high` confidence.** What keeps it partial is construction of the fourth exit: a near-zero deadline does **not** deterministically force the `prepare` timeout, because `timeout_at(Instant::now() + deadline, prepared)` races the timer against a `spawn_blocking` task that may already have completed, so a fast `prepare` wins and the test silently exercises the normal path. Deterministic reach needs injected slowness inside `prepare` (2b's R1, no seam) or a barrier holding the blocking task |
| setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline | A peer that authenticates, calls `receive_grant`, and then stalls anywhere in the post-grant exchange, with **all peer activity stopped** so the window is fault-free, then a poll until the host releases the connection and an assertion on the elapsed bound measured from the deadline anchor at `setup_socket.rs:246-248` (S1). A shortened `transport_setup_deadline` through `TestHost::start_with` makes the window cheap to observe | **Yes** — `tests/shm_failure_modes.rs:44-58` is this peer, against a real host, in CI (`ci.yml:133`). Only the timing assertion is new. Note the contrast with the `prepare`-timeout exit two rows up: that one races a timer against `spawn_blocking` and is not deterministic, while this one fires on the peer's silence and is |
| setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap | A peer that completes commit and then declares a length of `u32::MAX`, asserting `SetupError::MessageTooLarge` with no allocation of that size (the cap is at `setup_socket.rs:361-363`, before the `vec![0u8; len]` at `:364`) | **Yes** — in-process over a socket pair, the shape `goodbye_and_eof_have_distinct_outcomes` (`:810-825`) already uses |
| setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input | A peer that sends a partial length prefix and stalls, then a cancellation of `read_cancel` while the sentinel is parked, then **no further peer byte** and a poll of the generation's tracked task set until empty, with the poll cap stated as an explicit attempt count. The bound is a cancellation edge plus one poll of the `biased` select (`connection.rs:196-206`, `read_cancel` first at `:198`), not a duration | **Yes** — same socket-pair shape, and the cancellation token is already reachable from the test side. This row is new: the obligation was previously the trailing clause of the row above, where it had no bound and no separate construction |
| setup-a-concurrent-setup-saturation-is-reached | `max_handshakes` and `max_connections` both above 1, more concurrent dialers than `max_handshakes`, and at least one dialer that authenticates and then delays its `Activate` inside the setup deadline (S4) | **Yes** for the state; the marker's second clause needs an observation point inside `activate_server` between `setup_socket.rs:260` and `:273`, which is a host-source change |

### Group S5: the two peer halves

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection | A host, or a stand-in, emitting a grant that names two identical grant strings, plus a second concurrent attach of the same grant in one process. Enumerated from the native side: wire version (`packages/mc-shm-native/src/setup.rs:115`), schema (`:116`), grant hex and decode (`:120-121`), profile and distinctness (`:122`), and the process-wide claim (`lib.rs:591-594`) | **Yes** — `mc_host::setup_socket::activate_client` is `pub` and already driven by `tests/support/raw_client.rs:329`, so a hand-built `GrantMessage` reaches the managed path directly with no host at all |
| setup-a-only-an-authenticated-grant-enters-the-native-channel-registry | A full **shipped-plugin** run with both registry insertion sites instrumented, the `insert_channel` calls at `packages/mc-shm-native/src/lib.rs:551` (from `attach`) and `:612` (from `connect_setup`), asserting every insert originated from `connect_setup`. **No fault of any kind is required.** Note the scope: the guarantee is now explicitly over the shipped plugin path, because a claim quantified over the callers of a published napi export is not falsifiable by any campaign and is false for an arbitrary embedder | **Partial** — the shipped-plugin run already happens in CI (`ci.yml:206-208`, `:214`) and the call-graph half is settled by reading: `grep` over `packages/plugin/src` finds no non-test `.attach(` caller, and `shm-frame-channel.ts:77` uses only `connectSetup`. The campaign observation still needs a marker inside the addon that does not exist. Part 1's `test-only-surface-absent-from-the-shipped-addon` should be checked for whether it already reaches `attach`; `attach` carries no `#[cfg(test)]` and no `#[doc(hidden)]`, so on the face of it that record does not |

**Totals: 12 of 16 are non-vacuous today, 4 are partial, and none is unreachable.**
Two records were added by the portfolio disposition and both are non-vacuous, which
is why the numerator moved by two and the partial count did not: the deadline
liveness record is an assertion on a fixture that already runs in CI, and the
sentinel's cancellation record is an in-process socket-pair exchange.

The four partials fail for three different reasons, and the distinction matters for
sequencing: two need a second uid (a CI environment limit), one needs a marker seam
inside the native addon (a code change), and one needs a deterministic way to force
the `prepare` timeout (a race, not a missing capability). **The last of those four
changed reason under the disposition.**
`setup-a-an-abandoned-setup-strands-no-ring-charge` was partial because its oracle
was blocked on a 2b charge-release question; that question is now answered and the
record is `high`, so it stays partial only because setting a near-zero deadline
races the timer against `spawn_blocking` rather than forcing the exit. Nothing here
is blocked on a fault-injection capability the repository lacks.

## Coverage checks

### The one `sometimes` record already in the catalog, verified for compliance

Lens A produced exactly one `sometimes` record,
`setup-a-concurrent-setup-saturation-is-reached`, and it is a coverage check rather
than a property claim. It is **not duplicated below.** It is verified here against
METHOD.md's coverage-check rules, because a coverage check that asserts the
violation is worse than no coverage check.

- **It does not assert the violation.** Its two clauses are handshake permits
  available equals zero, and at least one connection inside `activate_server`
  between `setup_socket.rs:260` and `:273`. Both are legal operational states. The
  first is what saturation *is*, and `max_handshakes` exists to produce it; the
  second is the ordinary interior of every accepted setup. A correct
  implementation reaches both.
- **It is not paired with an `always(!X)` on the same predicate.** The neighbouring
  invariant, `setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released`,
  asserts that the count never *exceeds* `max_handshakes`. Reaching the bound and
  exceeding it are different predicates, so observing saturation cannot require
  observing the defect. Compliant.
- **`sometimes` is the right semantics, not `reachable`.** A campaign can execute
  every line of both bounding paths while never producing two overlapping setups.
  The record says this and the existing tests prove it: `tests/lifecycle.rs:239`
  and `:339` execute the saturation path with `max_handshakes` at 1 and 4 and
  squatters that never authenticate, so they cover the location and never the
  situation. That is exactly the distinction METHOD.md draws.
- **One refinement.** The record describes the marker but does not name it, and
  METHOD.md requires marker names to be constant and globally unique. Assign
  `setup_handshake_saturated_while_a_grant_awaited_activation`. Constant, unique,
  and never constructed dynamically.

### Coverage checks to add

Each asserts a precondition a **correct** implementation still satisfies, so it
fires without a defect present. Names are constants, globally unique, and never
built dynamically.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `setup_descriptors_transferred_to_an_authenticated_peer` | `send_grant` completed on a stream where `authenticate_server` returned `Ok(Authenticated)` (`auth.rs:279`) | The ordinary shape of every accepted setup. It is the independent precondition of the ordering invariant, stated without asserting the ordering |
| `auth_refused_a_connection_before_any_descriptor_send` | `connection.rs:130-133` returned on `is_err()` | Legal and expected: a malformed peer is a normal input, and refusing it is the gate working |
| `setup_peer_held_descriptors_without_sending_activate` | A connection reached the `Activate` read (`setup_socket.rs:261`) and timed out or read a non-`Activate` message | Legal: a peer can crash or be killed between grant and activate, which `tests/shm_failure_modes.rs:232-245` already produces deliberately. This is the precondition of the mapping-authority record, not the record |
| `setup_activation_token_compare_returned_false` | The constant-time compare at `setup_socket.rs:267-272` yielded false, producing `InvalidActivation` at `:275` | Legal: a version-skewed or buggy peer echoes the wrong token, and refusing it is correct. Recording the refusal says nothing about whether the token gates mapping |
| `setup_two_connections_held_distinct_activation_tokens_concurrently` | Two live connections each held a token minted by `connection.rs:212-226`, and the two differed | The independent precondition of token scoping. Legal and true by construction, since each connection mints its own |
| `auth_replayed_a_recorded_client_hello_and_client_auth` | A campaign resent a byte-identical recorded pair on a fresh connection | Records the *input*, not the outcome. Legal by construction and the precondition of any replay claim |
| `instance_two_incarnations_published_distinct_keys_in_one_data_directory` | Two `InstanceGuard::acquire` calls in one directory produced different key bytes (`instance.rs:263-264`) | The documented behaviour (`docs/mc-host-wire-protocol.md:105`), so observing it is a fact about the code rather than an outcome. Do not compare the bytes in a message; compare fingerprints |
| `setup_socket_bound_under_a_permissive_umask` | `bind_owner_only` ran with the process umask at `0o000` | A legal environment. It is the precondition of the bind-then-chmod window, asserted without sampling a mode |
| `setup_socket_parent_directory_observed_at_mode_0700` | The runtime directory carried `0o700` at the instant the socket existed (`instance.rs:571-572`) | The compensating control, and observing it is what makes the window record's "unexploitable" claim auditable instead of asserted |
| `setup_occupant_gate_refused_a_non_socket_occupant` | The conjunction at `setup_socket.rs:30-32` failed on its `is_socket()` clause | Legal: a stale non-socket at the path is normal crash residue, and refusing it is the gate working. Already reachable via `:494-501` |
| `setup_occupant_gate_refused_a_wrong_mode_socket_occupant` | The same conjunction failed on its mode clause with a same-uid socket at `0o666` | Legal and the specific residue a previous incarnation under a permissive umask leaves. This is the clause with no test |
| `setup_prepare_missed_the_transport_setup_deadline` | The `timeout_at` at `connection.rs:157-164` fired | Legal: a slow or loaded host misses a 2-second budget, and the timeout exists for it. This is the precondition of the uncovered charge-release exit, asserted without any claim about the charge |
| `setup_sentinel_read_rejected_an_oversize_declared_length` | `read_message_unbounded` returned `MessageTooLarge` from the cap at `setup_socket.rs:361-363` | Legal: an oversize declaration is ordinary hostile or buggy input, and the cap exists for it |
| `setup_read_cancel_fired_while_the_sentinel_was_parked` | `read_cancel` was signalled while `observe_peer` was blocked in `read_exact` | Legal and the ordinary shutdown shape. It is the precondition of the cancellability clause, not the clause |
| `native_channel_registry_reached_from_two_distinct_routes` | More than one distinct call site inserted into the addon registry during a campaign | Legal and true today: `attach` (`packages/mc-shm-native/src/lib.rs:491`) and `connect_setup` (`:571`) both reach it. This is the structural precondition of an unauthenticated registry entry, stated without asserting one occurred |
| `managed_rust_peer_received_an_aliased_grant_pair` | `activate_client` or `RingClientEndpoint::attach` was handed a descriptor naming two identical grant strings | A legal input shape from a rogue or impersonating host, which is the threat model these records are written against. Asserting the input is present says nothing about what the managed path returns |

### Anti-patterns to avoid in this part specifically

Four pairings are forbidden by METHOD.md's rule, and each is tempting here because
in every case the defect is easier to name than its precondition.

- Do not pair `always(!descriptor_sent_without_verified_proof)` with
  `sometimes(descriptor_sent_without_verified_proof)`. That marker can only fire by
  observing the boundary breach. Assert
  `setup_descriptors_transferred_to_an_authenticated_peer` and
  `auth_refused_a_connection_before_any_descriptor_send` instead: two independent
  preconditions, both legal, both present on a correct implementation.
- Do not pair `always(!token_accepted_on_a_foreign_connection)` with
  `sometimes(token_accepted_on_a_foreign_connection)`. Assert
  `setup_two_connections_held_distinct_activation_tokens_concurrently` and
  `setup_activation_token_compare_returned_false`.
- Do not pair `always(!registry_entry_without_authenticated_provenance)` with
  `sometimes(registry_entry_without_authenticated_provenance)`. Assert
  `native_channel_registry_reached_from_two_distinct_routes`, which is the
  structural precondition and is true today with both routes behaving correctly.
- Do not pair `always(hostile_occupant_refused)` with
  `sometimes(hostile_occupant_adopted)`. Assert the two per-clause refusal markers
  instead. The refusal claim is already a total `always` over the adversary's
  input domain, so a companion `sometimes` on adoption adds nothing and can only
  fire on a defect.

### One placement constraint on every marker here

**Place the marker where the precondition becomes true, not after the code has
finished depending on it.** This part has a specific trap for that rule: a marker
placed after `send_grant` returns (`setup_socket.rs:260`) has already been preceded
by the `sendmsg` at `:151-159`, so both descriptors are gone. The precondition for
`setup_descriptors_transferred_to_an_authenticated_peer` becomes true at the send
site, and the precondition for `auth_refused_a_connection_before_any_descriptor_send`
becomes true at `connection.rs:130-133`, before `activate_server` is reached at
`:170`. A marker at either of those two points is sound; a marker on the far side
of the transfer records a fact about a boundary that has already been crossed.

## Leverage ranking, by cheapest valid oracle

Ranked by the cost of the cheapest oracle that yields a valid result, not by
records unblocked per capability. Records-per-capability would put the concurrent
dialer at the top, and that is the wrong answer while S0 is open, because anything
added to an `mc-host` in-crate module is added to a suite no automation executes.

**State this plainly: the two cheapest items here are not faults.** They are
running the tests that already exist, and adding one assertion to a fixture that
already runs in CI.

1. **S0, executing what already exists.** A workflow change and nothing else:
   `cargo nextest run -p mc-host --lib` alongside the existing filtered steps
   (`ci.yml:178-179`, `:187`), plus naming `instance_security`, `host_roundtrip`
   and `activation`. It unblocks **zero** new records and **protects 72 existing
   test functions**: 22 in `instance.rs`, 12 in `setup_socket.rs`, 11 in `auth.rs`,
   4 in `connection_file.rs`, and 23 across the three unnamed binaries. It also
   makes the sub-part's only assertion (`instance.rs:592-595`) reachable in a debug
   build. Nothing below matters as much until this is done. Note the second-order
   effect: it would also make the host's own
   `committed_wire_vectors_pin_the_proof_construction` executable, which is the
   direct answer to quiet area 2 and needs no new test at all.

2. **One assertion on a CI-executing fixture: map the descriptors the stalling peer
   already holds.** `tests/shm_failure_modes.rs:44-58` authenticates, calls
   `receive_grant`, and parks. Adding a `Ring::attach` on the two received fds and
   a write turns a capacity fixture into the oracle for
   `setup-a-mapping-authority-derives-only-from-the-key-never-from-the-token`,
   inside a binary CI already names (`ci.yml:133`). **One record, no new harness,
   no new fault, and it lands in an executing job.** This is the single highest
   leverage item in the part per line of test code. The same fixture carries a
   second record for one more assertion: timing how long the host tolerates the
   stall discharges
   `setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline`,
   which needs the peer to stop rather than any fault. Two records, one fixture,
   both in CI.

3. **One new fixture: a dialer that authenticates then delays `Activate`.** A
   bounded sleep where `tests/shm_failure_modes.rs:58` has `pending()`. It supplies
   the missing clause of S4 and serves four records at once:
   `setup-a-concurrent-setup-saturation-is-reached`,
   `setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it`,
   `setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released`, and
   the three covered exits of `setup-a-an-abandoned-setup-strands-no-ring-charge`.
   It is the cheapest *fault* capability in the part and the only one that
   de-vacuums a cluster.

4. **In-process socket-pair oracles, no host required.** Three records are pure
   protocol exchanges over `UnixStream::pair`, the shape `auth.rs:1022-1073` and
   `setup_socket.rs:810-825` already use:
   `setup-a-a-captured-client-proof-never-authenticates-twice` (record and resend),
   `setup-a-a-rogue-listener-at-the-published-path-obtains-no-client-proof` (add
   the missing `daemon_ver` case to an existing driver), and the two sentinel
   records, `setup-a-the-peer-lifetime-sentinel-allocates-under-a-cap` (declare
   `u32::MAX`) and
   `setup-a-the-peer-lifetime-sentinel-exits-on-cancellation-without-further-peer-input`
   (park a partial prefix, then cancel). No process, no timing, no filesystem. That
   is four records, not three, after the sentinel split.

5. **Parameterizing one existing occupant test.** `insecure_stale_occupant_is_not_replaced`
   (`setup_socket.rs:494-501`) already plants an object and asserts survival.
   Turning its body into a loop over a dangling symlink, a symlink to a live
   socket, a `0o666` socket, a directory, and a FIFO covers four of the six shapes
   of `setup-a-a-hostile-occupant-of-the-socket-path-fails-closed` and closes the
   untested mode clause, which is the interesting one.

6. **A hand-built grant against `activate_client`.** `activate_client` is `pub` and
   already driven by `tests/support/raw_client.rs:329`, so
   `setup-a-the-managed-rust-peer-repeats-every-native-peer-rejection` needs no
   host: construct a `GrantMessage` naming two identical grant strings and assert
   the managed path's disposition against the native peer's. The right form is a
   differential table over the native rejection list
   (`packages/mc-shm-native/src/setup.rs:115-124`, `lib.rs:588-594`), which is the
   method Part 1's `native-boundary-not-weaker-than-its-wrapper` established even
   though its polarity has since inverted.

7. **Two config-only constructions.** A near-zero
   `config.timing.transport_setup_deadline` reaches the uncovered `prepare`-timeout
   exit, and a `0o000` umask plus a sampling thread reaches the bind-then-chmod
   window. Both are one-line `start_with` changes. They are ranked below the items
   above because in each case the *oracle* is the harder half: the first is blocked
   on 2b, and the second's strong form needs a second uid.

8. **A marker seam inside the native addon.** `setup-a-only-an-authenticated-grant-enters-the-native-channel-registry`
   needs an observation point at the two insertion sites in
   `packages/mc-shm-native/src/lib.rs`. That is a source change to a shipped
   artifact rather than a test change, which is why it ranks here despite requiring
   no fault at all.

9. **A CI ordering change plus a fixture for S6.** Producing
   `checksum_mismatch` out of `packageAddonPath` needs a load that does not find
   the local addon, which means running one native test step before
   `ci.yml:193`'s `build:source` or after the `:219-223` removal. Ranked last among
   actionable items because it touches CI structure and covers a claim
   (`docs/mc-host-shm-transport.md:83`) whose classification is already tested.

**Two items are not on this list because they cannot be ranked by cost.** A second
uid, which the wrong-owner occupant clause and the strong form of the cross-uid
connectability record both need, is an environment capability rather than a test;
record it as a limit rather than skipping it silently. And the charge-release
question under
`setup-a-an-abandoned-setup-strands-no-ring-charge` is a dependency on sub-part 2b,
not work that can be scheduled here. Both are stated so a later pass does not read
their absence from this ranking as a judgment that they do not matter.
