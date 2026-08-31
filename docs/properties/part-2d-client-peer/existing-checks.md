# Sub-part 2d existing-check inventory

Every claim-bearing check for the host's own client acting as a protocol peer:
`crates/mc-host/src/client.rs` (3,998 lines), the integration binary dedicated to
it, the binaries that use it as a fixture, and the CI steps that reach any of
them.

Provenance: system `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`. Every count in this
file was re-derived at that commit rather than copied from the lens material: the
in-crate total by grepping `#[test]` and `tokio::test` from `:2266` onward, the
40 cluster sites by printing each one and confirming it is a test `fn` line, the
integration tests by printing every `async fn` in `crates/mc-host/tests/client.rs`,
the 24 integration binaries by listing `crates/mc-host/tests/*.rs`, and the
fixture users by grepping each for `Client::connect`.

**Every status below is `unaudited`.** An existing check never removes a property
from the catalog. Test adequacy belongs to `/testing:invariant-test-review`;
production guard adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

**40 in-crate tests reach this sub-part. None of them runs in CI. There are zero
doctests. So no check resident in `client.rs` is executed by CI at all.**

| Unit | Test module | Lines | Tests | Executed in CI |
| --- | --- | --- | --- | --- |
| `client.rs`, `mod tests` at `:2266-3998` | one module | 1,733 | **40** | **No** |
| `client.rs` doctests | none exist | 0 | **0** | n/a |
| `crates/mc-host/tests/client.rs` | whole file | 243 | **6** | **Yes**, three times |

The reason the 40 do not run is structural rather than an omission. Every
`-p mc-host` invocation in `ci.yml` carries a `--test <name>` filter, which
selects one integration binary and never builds the lib target. Re-verified at
`HEAD`: the 13 `mc-host` hits are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`,
`:178`, `:187`, `:190`, `:211`, `:361`, `:442`, and `:461`, and `:168-169` are
`cargo build` steps rather than test steps.

**The doctest absence is load-bearing, and it is what separates 2d from 2b.**
`grep -c '```' crates/mc-host/src/client.rs` returns **0**: there is no code
fence, `text` fence, or `compile_fail` block anywhere in the file's 3,998 lines.
That matters because `cargo test -p mc-host --doc` **does** run, at `ci.yml:190`
under the step name "Rust lease non-escape", and it builds the lib target's
doctests. Sub-part 2b has exactly two, both `compile_fail`
(`frame_channel.rs:296-301` and `:303-308`), and they are its only CI-executed
source-resident checks. 2d has no equivalent. The sub-part's CI-executed coverage
is the six integration tests in `crates/mc-host/tests/client.rs`, plus the two
thread-count assertions in `tests/shm_soak.rs` and `tests/shm_failure_modes.rs`
recorded below. The original text said "entire ... is the six", which omitted the
latter two.

One count correction so a later pass does not repeat it. An initial pass of this
synthesis counted 38 in-crate tests by grepping `#[test]` and `#[tokio::test]`
literally, which misses the
`#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` forms at two sites.
Grepping `tokio::test` without the closing bracket returns 40, matching lens B.

### In-crate tests, 40 in nine clusters

**All 40 live in one `mod tests` at `:2266-3998`, spanning `:2328` to `:3993`,
and all 40 drive a synthetic `Inner`.** The fixture is `test_inner` (`:2270`),
which constructs `Arc::new(Inner { .. })` directly with a pre-populated route
set. A grep of the test module for `Client::connect`, `RingClientEndpoint`,
`start_ring_bridge`, or `TestHost` returns **zero** hits. So **no in-crate test
exercises `connect` (`:306`), `connect_info` (`:347`), the bridge thread
(`:1852-1895`), or a real ring.** Every one of the 40 sites below was printed and
confirmed to be a test `fn` line.

| Cluster | Tests | Sites |
| --- | --- | --- |
| Stream lifecycle, deadline watchers, queued-item charges | **9** | `:2564`, `:2810`, `:2867`, `:3304`, `:3381`, `:3426`, `:3631`, `:3717`, `:3834` |
| Cancellation versus writer and terminal races | **6** | `:2478`, `:2508`, `:2532`, `:2922`, `:2965`, `:3014` |
| Byte budgets and capacity-class separation | **5** | `:2621`, `:3155`, `:3196`, `:3225`, `:3777` |
| Redaction, spellings, typed rejection, charge release | **5** | `:2856`, `:3052`, `:3949`, `:3978`, `:3993` |
| Route lifecycle and late bind | **4** | `:3503`, `:3587`, `:3896`, `:3959` |
| Close and admission races | **3** | `:2365`, `:2414`, `:2456` |
| Inbound validation and control echo | **3** | `:2658`, `:2754`, `:3270` |
| Drop semantics | **3** | `:2898`, `:3090`, `:3121` |
| Correlation allocation and exhaustion | **2** | `:2328`, `:2338` |
| **Total in-crate** | **40** | |

The tests named by catalog records are:

| Line | Test | What it covers |
| --- | --- | --- |
| `:2328` | `max_correlation_is_used_once_then_exhausted` | the no-reuse half of the correlation contract; asserts nothing about `retired` |
| `:2338` | `real_admission_exhausts_after_max_without_second_charge_or_frame` | that exhaustion produces no second charge and no second frame; again silent on `retired` |
| `:2478` | `cancel_winning_queued_prevents_writer_claim_and_frame` | the `QUEUED -> CANCELLED` CAS winning against `claim_for_write`, for one request |
| `:2508` | `writer_winning_cancel_is_outcome_unknown_and_queues_cancel` | the same race with the writer winning, for one request |
| `:2658` | `inbound_validation_enforces_the_direct_profile_table` | the densest single test in the sub-part, `:2658-2751`, covering the per-type identity table. Of the five types in `validate_inbound`'s residue it asserts one, `FrameType::Request` at `:2750`; `Cancel`, `Pong`, `Hello`, and `HelloAck` are not mentioned |
| `:2754` | `a_ping_at_any_valid_priority_is_answered_with_an_exact_flag_echo` | the `Pong` success path and the exact flag echo (conformance vector V35). Does not cover the encode-failure branch at `:1329-1335` |
| `:3014` | `a_dropped_sender_after_an_absent_entry_reports_the_send_outcome` | single-request send-outcome reporting after the entry is gone |
| `:3090` | `dropped_unary_future_cleans_pending_and_possibly_sent_request` | single-request classification on future drop |
| `:3121` | `dropped_close_retires_and_repeated_close_joins_tasks` | that a dropped close retires and a repeated close still joins the two Tokio tasks. Asserts nothing about cause visibility and nothing about the bridge thread |
| `:3155` | `data_capacity_spares_control_reserve_and_does_not_burn_correlation` | one of the two `Correlations::restore` sites, plus the reserve separation |
| `:3196` | `control_exhaustion_retires_and_releases_all_queued_bytes` | that exhausting the control reserve retires and releases every queued byte |
| `:3225` | `data_saturation_never_starves_a_control_frame` | control admission under data saturation, which is queue-slot starvation and a different mechanism from bridge-thread egress backpressure |
| `:3270` | `stale_epoch_terminal_cannot_settle_reused_channel` | the epoch fence on `PendingKey` |
| `:3503` | `an_abandoned_control_open_releases_a_late_bound_route` | the §8.2 late-bind remedy, the largest test in the suite at 84 lines |
| `:3587` | `a_duplicate_bind_terminal_never_closes_an_owned_route` | the unmatched-terminal case and the already-cached early return at `:1576-1578`. Does not cover two successful opens returning one handle |
| `:3959` | `epoch_is_part_of_pending_key` | the same fence, structurally |
| `:3993` | `outcome_spellings_are_exact` | pins `not_sent`, `outcome_unknown`, `terminal` on the Rust side only |

**`#[ignore]`: none found. `should_panic`: none found.** Grepped the whole file.

**No property tooling of any kind.** No `loom`, `shuttle`, `miri`, `proptest`,
`quickcheck`, or `arbitrary` reaches this file, so every in-crate check here is a
hand-written fixture case. There is no coverage measurement, so every placement
observation in this file is structural rather than measured.

## Integration tests

**`crates/mc-host/tests/client.rs` holds 6 tests in 243 lines, and the binary is
named in CI three times.** This makes 2d better covered at the integration layer
than its siblings: 2b has no integration binary dedicated to it at all, while 2d
has one whose whole subject is this file. Every command below was printed from
`ci.yml` and confirmed.

| Workflow site | Command | Platform and job |
| --- | --- | --- |
| `ci.yml:132` | `cargo nextest run -p mc-host --test client`, step "Mandatory ring client suite" (`:131`) | Linux, job `shm-crash-recovery` (`:111`) |
| `ci.yml:178-179` | `cargo nextest run -p mc-host \` / `--test client --test lifecycle`, one wrapped command | `if: runner.os == 'Linux'`, job `shm-source-build` (`:137`) |
| `ci.yml:187` | `cargo nextest run -p mc-host --test client --test lifecycle`, step "Fixed-ring contracts (macOS)" (`:181`) | `if: runner.os == 'macOS'`, same job |

**Peer role versus fixture role: 6 of 6 exercise the client as a peer; 0 use it
purely as a fixture.** Every test constructs
`Client::connect(host.publication_path())` and asserts on the client's own
observable behaviour rather than on host state reached through it. Line numbers
below are the `async fn` lines, each printed and confirmed.

| Test | Line | What it proves about the client as a peer |
| --- | --- | --- |
| `authenticates_attaches_ring_routes_unary_and_closes` | `:31` | discovery, authentication, ring attach, `daemon_id` match, route open, unary round trip, route close, owner close |
| `ring_stream_and_control_traffic_share_one_live_generation` | `:62` | Ping/Pong under a real 20 ms `LivenessPolicy` (`:64-68`) concurrent with a hanging stream and an unrelated unary |
| `ring_terminal_is_typed_redacted_and_generation_remains_usable` | `:111` | a host `Error` becomes a typed terminal, the planted sentinel `CANARY-TERMINAL-BODY-7f31` (`:118`) is absent from both `Debug` and `Display` (`:133`), and the generation survives |
| `caller_cancellation_is_correlation_scoped` | `:149` | caller cancellation yields `NotSent` or `OutcomeUnknown` and leaves later requests independent |
| `request_deadline_is_one_absolute_owner_and_honors_overrides` | `:188` | the caller-overridable request deadline, and `deadline_expired` with `OutcomeUnknown` |
| `close_rejects_new_sends` | `:228` | post-close sends return `client_closed` with `NotSent` |

One test additionally makes two host-side fixture assertions:
`authenticates_attaches_ring_routes_unary_and_closes` reads the publication and
asserts `setup_socket` is present and `endpoints` is absent (`:35-36`). That is
the only host-shape assertion in the binary.

**Seven other integration binaries use the client as a fixture rather than as the
subject, and three of the seven are CI-named.** Counted by grepping each of the
24 binaries for `Client::connect`.

| Binary | `Client::connect` sites | CI status |
| --- | --- | --- |
| `shm_failure_modes.rs` | 9 | **named** — `ci.yml:133`, with `--test-threads=1` |
| `lifecycle.rs` | 7 | **named** — `ci.yml:179`, `:187` |
| `host_roundtrip.rs` | 3 | unnamed |
| `activation.rs` | 2 | unnamed |
| `composite_routing.rs` | 1 | unnamed |
| `protocol_vectors.rs` | 1 | unnamed |
| `shm_soak.rs` | 1 | **partial** — `ci.yml:134-135` names `short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded` with `--exact`, so one of that binary's two tests runs |

> **Correction to the framing handed to this synthesis.** The brief said seven
> fixture binaries with four CI-named. Three of the seven are named:
> `shm_failure_modes`, `lifecycle`, and `shm_soak` (partially). The four-count
> comes from lens B, which correctly reports "4 of those 8 are named in CI" while
> counting the **eight** binaries that touch `client.rs` at all — that is, the
> seven fixtures plus the subject binary `client.rs` itself. Both statements are
> true of different denominators. Stated in full because the difference is
> whether the fixture layer or the dedicated layer carries the CI coverage, and
> the answer is that `--test client` is the load-bearing invocation.

The shared harness also constructs the client: `tests/support/mod.rs` at 3 sites
and `tests/support/synapse.rs` at 1. So **8 of the 24 integration binaries touch
`client.rs` at all**, and 4 of those 8 are CI-named.

> **Two fixture binaries carry a claim-bearing assertion about this sub-part, and
> this inventory originally credited neither.** Added during disposition.
> `shm_soak.rs` and `shm_failure_modes.rs` were counted above by their
> `Client::connect` occurrences and classified as fixture users, which is how a
> real check went unrecorded. Both assert that the process **thread count returns
> to a post-close baseline** after real connect-and-close cycles:
> `shm_soak.rs:35-52` (`wait_for_envelope`, called after each `cycle` at
> `:54-92`) and `shm_failure_modes.rs:193-210` (`assert_resources_return_to`,
> called twice by `clean_close_returns_exact_single_connection_capacity` at
> `:218-230`). The client's detached bridge thread (`client.rs:1852-1895`) is one
> of those threads, so a thread that never exited would fail both assertions
> inside their budgets. Both are CI-executed at `ci.yml:130-135`. This is the only
> CI-executed evidence in the sub-part about the bridge thread, and it covers
> termination only: not which `break` fired, not the goodbye write, not the spin.
> Status `unaudited` for both. See quiet area 1 below and
> [portfolio-evaluation.md](portfolio-evaluation.md).

Two support fixtures bear on constructability and are recorded here because a
later pass will look for them. `tests/support/echo_host.rs` (121 lines) is an
in-process host runner with an echoing handler, described by its own module doc
as being for "tests that need a live ring endpoint without a child process". It
is a **real** host, not a frame-forging fake peer, so it cannot emit an arbitrary
inbound frame to the client. `tests/support/raw_client.rs` drives the **peer**
side against a real host, which is the mirror image of what 2d needs. **There is
no fake-host fixture in the tree that can hand the client a chosen frame over the
ring.** That single absence is what blocks three catalog records; see
[fault-map.md](fault-map.md).

## TypeScript-side gates

**No TypeScript gate bears on `client.rs`, and two gates are easy to mistake for
one that does.** Recorded explicitly so a synthesis or review pass does not
credit them.

| Gate | Command | Line | Why it does not cover this sub-part |
| --- | --- | --- | --- |
| Plugin shared-memory contracts (Bun) | `bun test packages/plugin/src/shared/mc-host-client` | `:211` | tests `McHostClient`, the *TypeScript* managed client. It is a sibling peer implementation of the same normative contract, not this Rust file. Its `errors.ts:12` and `:38` are the duplicate of the send-outcome spellings recorded below |
| mc-host client interop (Bun + Node 24) | `bun run --cwd packages/plugin test:mc-host-client:node` | `:461`, job `:442-443` | resolves to `bun scripts/run-mc-host-client-node.ts smoke` (`packages/plugin/package.json:43`). Drives the TypeScript client against a real host, so it exercises the *host*, not `mc_host::Client` |
| Plugin shared-memory lifetime (Node 24) | `bun run --cwd packages/plugin test:mc-shm:node` | `:214` | native lease and channel lifetime across the runtime boundary; 2b scope |
| mc-host release contract drift gate | `bun run release:contract:check` | `:87`, `:109` | pins the byte-coupled forms of the release contract, including the `include!`-able Rust constants that feed production epoch values. Verified not to reach here: `grep -rn 'include!' crates/mc-host/src/` returns **zero** hits, so no constant in `client.rs` is under this gate |

The consequence is that the two managed clients are bound by one normative
sentence each and checked by two independent, uncoupled suites. That is already a
live divergence on the queued-byte budget: the Rust client keeps a separate
control byte pool (`client.rs:399`, `:949`, funded by
`CLIENT_CONTROL_QUEUED_BYTES` at `:76`) while
`docs/mc-host-wire-protocol.md:745`'s shared-pool sentence still binds the
TypeScript side, so the two clients can have different self-teardown thresholds
under identical load. The code carries a written rationale for the divergence at
`client.rs:1336-1339` and `:63-70`; the document has not moved.

## Production assertions and guards, clustered

**Assertion density in the production half (`1-2264`) is zero. Enforcement is
entirely by returned value and typed state.** Every count below was re-derived by
extracting `1-2264` and grepping it.

**`assert!`, `assert_eq!`, `assert_ne!`, `debug_assert!`, `panic!`, `todo!`,
`unimplemented!`, and `.unwrap()` in the production half: none found.** Every
`unwrap` in the file is inside `mod tests`.

**`catch_unwind`: none found.** There is no panic boundary anywhere in this file,
unlike `ring_transport.rs`, which has two (`:279-290` and `:560-563`). Combined
with `lock_unpoisoned` (`client.rs:2242-2246`), which converts every mutex
poisoning into `PoisonError::into_inner`, a panic while holding an `Inner` mutex
is recovered rather than propagated, and a panic in `writer_loop` or
`ring_reader_loop` propagates as a `JoinError` into `join_tasks_until`, which
aborts and swallows it (`let _ = task.await`, `:1691`). No `retire` runs on that
path. Status unaudited.

**`unreachable!()`: 2.** `:1440` and `:1457`, both catch-all arms of the
terminal-type match inside `dispatch`, guarded by the outer
`Response | Error | StreamEnd` arm at `:1406`. They are the only production panic
sites in the file. They are unreachable today and become reachable if a future
arm is added to `:1406` without a matching arm inside. Nothing in the file states
the coupling between the two match sites. Status unaudited.

**`.expect(`: 3, in two clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Semaphore invariant | 1 | `:331` `"discovery semaphore is never closed"` |
| Pending-map invariant | 2 | `:1476`, `:1526`, both `"entry exists"` |

The two `"entry exists"` labels are the load-bearing ones: each follows a
`pending.remove(&key)` on a path that already matched the entry under the same
guard, so each states a contract rather than an assumption. Neither has a
dedicated check. `:331`'s semaphore is the `DISCOVERY_SLOTS` static (`:106-107`),
a `LazyLock` with no drop path, which is why it is never closed. Status unaudited
for all three.

**`let _ =` discarded results: 17, in five clusters.**

| What is discarded | Sites |
| --- | --- |
| Control-frame enqueue, including the `Pong` | `:1390`, `:1498`, `:1543` |
| Caller settlement sends, where the receiver may be gone | `:1442`, `:1459`, `:1595`, `:1599`, `:1970` |
| Local cancellation calls | `:867`, `:1099`, `:1104`, `:1721` |
| Bridge-thread I/O, including the setup-socket `Goodbye` | `:1860`, `:1872`, `:1891`, `:1893` |
| Aborted join result | `:1691` |

Two clusters are consequential. `:1390` is the `Pong` enqueue, so the one
`send_control` failure path that does not retire (`:1329-1335`) drops the frame
with no local trace. And `:1891` discards the `write_all` of the setup-socket
`Goodbye`, so even the departure signal the host reads as its peer-death
discriminator is best-effort with no local record of whether it left. Status
unaudited.

**Checked and saturating arithmetic: 9.** `checked_add` at `:1737`
(`Correlations::allocate`), `:1742` (`restore`'s rewind guard), `:1765`
(`ByteCounter::charge`), and `:1997` (`deadline_at`, which returns a typed
`invalid_timeout` at `:2000` rather than panicking).
`saturating_duration_since` at `:351`, `:365`, `:522` (the one-absolute-deadline
arithmetic). `saturating_sub` at `:1609` (`release_stream`) and `:1804` (charge
release). Status unaudited.

**Typed rejection guards.** This is where the real enforcement lives. The
production half mints 72 distinct snake_case string literals. The close-and-error
vocabulary is 8 retirement cause categories spelled with 10 literals
(`connection_goodbye`, `protocol_violation`, `eof`, `write_failed`,
`control_capacity_exhausted`, `invalid_route_response`,
`stranded_route_cleanup_failed`, plus `owner_drop`, `owner_close_dropped`, and
`shutdown_timeout`), 5 handshake failures (`handshake_timeout`,
`discovery_failed`, `dial_failed`, `authentication_failed`, `setup_failed`), 2
post-retirement constants (`connection_retired`, `generation_retired`), and 14
per-call local codes. Bounding is by `bounded_code` (`:2248-2259`), which filters
to `[A-Za-z0-9_.-]` and truncates at `MAX_ERROR_CODE_BYTES` = 128 (`:112`), with
message handling at `:169-175` against `MAX_ERROR_MESSAGE_BYTES` = 512 (`:113`).
Status unaudited.

**Explicit "none found" for the remaining categories.** No fuzz target reaches
`client.rs`. No benchmark asserts a behavioural claim here. No snapshot or golden
fixture. No differential harness against the TypeScript peer implementation. No
coverage instrumentation. No `#[ignore]` and no `should_panic` in the file. No
doctest, `text` fence, or code fence of any kind. And no check at any level
exercises `host_shutdown` (`:576-614`): no in-crate test calls it, and the six
integration tests stop the host through `host.shutdown_gracefully()`, a harness
path.

## Documentation describing deleted mechanisms

A distinct section because these are first-class findings, not stale-doc
footnotes. `ed487e11` removed 351 lines from `client.rs` and added 137, and the
deletions were the client's byte-stream half: `NEGOTIATION_CORRELATION`,
`READ_BUFFER_BYTES` ("Matches the framing layer's `tcp_frame_channel` read
buffer"), `reader_loop<R: AsyncRead>`, `read_active_frame`, `read_exact_until`,
`read_body_until`, `drain_until`, `negotiate_tcp`, `read_setup_frame`,
`read_setup_exact`, and three tests including
`an_unsupported_version_fails_at_the_frozen_prefix` and
`idle_header_is_unbounded_then_partial_frame_has_one_deadline`.

**Five statements describe those deleted mechanisms. One is in `client.rs`; four
are in the normative document.** All five were printed and confirmed at `HEAD`.
Doc references without a file are `docs/mc-host-wire-protocol.md`.

| # | Statement | Why it no longer describes this code |
| --- | --- | --- |
| 1 | `client.rs:44` — "Deadline for a frame after its first header byte. Idle header waits are unbounded." | The client has no first header byte. `ring_reader_loop` receives an already-decoded `(EnvelopeHeader, Vec<u8>, ByteCharge)` triple from the bridge (`:1977`) with no timeout at all. `CLIENT_FRAME_TIMEOUT` (`:45`) survives as a real 30-second bound, but its only production uses are the writer's per-frame publication deadline (`:1353`) and the await on it (`:1960`), so it bounds outbound publication rather than inbound frame completion |
| 2 | `:738` — "frame completion after first header byte \| one 30 s absolute deadline; idle first-header wait is unbounded" | The same mechanism, stated normatively for both managed clients. Neither managed client reads a byte stream any more, and the "unbounded idle wait" half now describes an unbounded `read.recv().await` that has no header/body distinction to be unbounded between |
| 3 | `:724` — "malformed framing / EOF \| no terminal possible \| classify pending writes from byte evidence; invalidate generation" | There is no byte evidence on the ring path. A ring write either completes or does not, and the surviving classifier is the three-state `publish` atomic (`client.rs:1939-1967`, `:2215-2231`). The classification obligation survives and is discharged by a **stronger** mechanism than byte evidence; only the evidence the sentence names is gone |
| 4 | `:852` (conformance vector V14) — "Partial header/body EOF \| Close as corruption; pending write outcomes use byte evidence" | The same, as a conformance vector. A partial header or body EOF is not constructible against the ring, because `:294` says "A published ring descriptor names one complete header and body" |
| 5 | `:296` — the client-side retirement list still contains "truncated declared frame" | Printed in full: the other items on that list are live on the ring path (unexpected setup-socket EOF, invalid ring descriptor, unsupported version, unknown type, invalid flags, nonzero channel-0 epoch, zero epoch on a routed channel, pure-header body, body declaration above 64 MiB). A truncated declared frame is unreachable for the reason `:294` gives, so this is a partially inherited list. Counted once |

**Checked and clear, so a later pass does not double-count.** The document's
transport-selector, provider-registration, and alternate-backend statements are
*negative* claims the deletion made true rather than descriptions of surviving
machinery: `:29` ("Remote transport is unsupported"), `:594` ("There is no
provider registration socket or transport-selection handshake"), and `:263-264`
(`Hello`/`HelloAck` retained as reserved-and-role-invalid numeric assignments
only). `:936` states the governing rule: "Any disagreement with old published or
private behavior is migration history, not permission to add a compatibility
branch."

**One residual of the opposite shape.** `:762-764` diagrams a client `Recovering`
state with "bounded backoff, reread file" (`:764`), and `client.rs` has no
reconnect path — but no reconnect path was deleted either. A `git diff` of
`ed487e11` shows no removed reconnect function, so this is a contract gap rather
than a deleted-mechanism finding. Recovery lives in
`crates/mc-module/src/historian_producer.rs:699`, outside this sub-part.

### Claims stated somewhere and checked mechanically nowhere

Six, recorded because each is held by discipline rather than by a build step.

1. **The three send-outcome spellings are duplicated in TypeScript as string
   literals.** `client.rs:129-131` mints `not_sent`, `outcome_unknown`, and
   `terminal`; `packages/plugin/src/shared/mc-host-client/errors.ts:12` restates
   them as a `readonly string[]` and `:38` as a union type, and the TypeScript
   retry policy branches on them (`mc-host-client/client.ts:323`, `:331`).
   `client.rs:126` calls the spellings "Stable spelling used by cross-language
   recovery policy". Two definitions, no cross-check.
   `outcome_spellings_are_exact` (`:3993`) pins the Rust half only, and it never
   runs in CI.
2. **The five client budgets are literals restated in the normative deadline
   table.** `client.rs:43-51` against `:737-743`. All five agree today and were
   verified line by line: 2 s handshake, 30 s frame, 30 s route open, 30 s
   request, 5 s shutdown. No test parses either side.
3. **The `host.shutdown` and `host.status` operation names are byte literals in
   several places each.** `client.rs:584` (`br#"{"op":"host.shutdown"}"#`), `:604`
   (the echo comparison), and the document's `:541` (the request example) and
   `:545` (the response example); same shape for `host.status`. A rename on either
   side changes the wire and fails no build. Lens B cited `:530` and `:551` for
   the document's two literals; both were printed and neither carries one, so the
   corrected references are `:541` and `:545`, found by grepping `host.shutdown`
   across the document. Section 7.6 itself opens at `:536`, which also corrects
   lens A's span of `:532-557` at its start.
4. **`MAX_ERROR_CODE_BYTES` = 128 and `MAX_ERROR_MESSAGE_BYTES` = 512 are stated
   nowhere normative.** `client.rs:112-113`. `:337` makes `code` stable and
   `message` diagnostic, and conformance vector V24 (`:862`) requires bounded
   observability, but neither fixes a number. The TypeScript client's bounds are
   independent.
5. **`CLIENT_DISCOVERY_SLOTS` = 64 is justified against Tokio's default
   512-thread blocking pool in prose only.** `client.rs:96-104`. The reasoning is
   explicit and good, and the subtle part is real: the permit is moved into the
   blocking closure (`:335`) so a detached worker still counts against the cap.
   Nothing asserts either number, so a runtime configured with a smaller blocking
   pool silently invalidates the argument, and nothing tests that a detached
   worker holds its permit.
6. **The 50-microsecond bridge poll is a bare literal.** `client.rs:1886` is
   `Duration::from_micros(50)`, not a named constant, and it is numerically the
   same value as `POLL_INTERVAL` (`ring_transport.rs:33`), which the 2b inventory
   records as one literal already serving three different waits. This is a fourth
   use with no shared definition.

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any check proves.
The framing point that applies to all three: the ranking is not about thin
coverage. The 40 in-crate tests are dense and well built, and the six integration
tests are real end-to-end peer exercises. What is quiet is a specific seam in each
case.

1. **The bridge OS thread is unjoined, and everything about it except its
   termination is unobserved.** `client.rs:1852-1895` spawns it, discards the
   handle (the only combinator applied to `spawn`'s result is `.map_err` at
   `:1895`), and the file has no other reference to it. It owns three things
   nothing else can reach: the ring attach (`:1855`), the completion signal every
   outbound frame waits on (`:1872`), and the setup-socket departure the host reads
   as its peer-death discriminator (`:1890-1893`). No in-crate test constructs it —
   zero hits for `start_ring_bridge` in `mod tests` — and none of the six
   `tests/client.rs` tests inspects the setup socket or thread state.

   **Correction applied during disposition: the original claim that it is
   "untested by anything" was false, and the counter-evidence was already in this
   file's own fixture table.** Two CI-executed integration tests observe the
   thread's **exit** through the process thread count. `tests/shm_soak.rs` drives a
   real `Client::connect` / `open_route` / `request` / `close_route` / `close`
   cycle (`:54-92`) and then polls `wait_for_envelope` (`:35-52`) until `threads`
   equals a post-close baseline; `tests/shm_failure_modes.rs` does the same through
   `assert_resources_return_to` (`:193-210`), called twice by
   `clean_close_returns_exact_single_connection_capacity` (`:218-230`) around a
   real connect and close. A bridge thread that never left its loop at `:1866`
   would hold the count above baseline until the budget expired and fail both. Both
   run in CI: `ci.yml:130-135` is one "Mandatory ring client suite" step whose
   three commands are `--test client`, `--test shm_failure_modes` (unfiltered, so
   `:218` runs), and `--test shm_soak` filtered to
   `short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded`, which is the
   test that calls `run_soak` and therefore `cycle`.

   So the seam is narrower than recorded and still real. What no check reaches:
   which of the five `break`s fired, whether `:1891` wrote anything, whether the
   goodbye's content distinguished the cause, and the 50-microsecond busy-poll
   (`:1886`, roughly 20 kHz per idle connection). Of the three normative claims
   that depend on this thread, one now has partial evidence — connection close as a
   bounded joined teardown (`:691`, `:741`) is contradicted rather than unchecked,
   since `join_tasks_until` demonstrably does not join this thread while the tests
   above show it does eventually exit — and two remain unchecked at that seam: that
   a clean `Goodbye` and an unexpected setup-socket loss are distinct (`:296`,
   `:691`), and that Ping/Pong is owned independently of application waits
   (`:683`). Owned by
   [client-a-a-close-completes-before-its-setup-goodbye-is-written](catalog.md#client-a-a-close-completes-before-its-setup-goodbye-is-written),
   [client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye](catalog.md#client-a-a-ring-failure-departs-the-setup-socket-as-a-clean-goodbye),
   and
   [client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget](catalog.md#client-a-pong-egress-is-not-bounded-by-any-client-side-liveness-budget).

2. **The retirement cause is discarded at exactly the point where it is the only
   diagnostic, and two tests pin the loss in place.** `retire` (`:1667`) receives
   one of eight cause categories and keeps none; `Inner` (`:934-960`) has room for
   a field and does not have one. The causes are not interchangeable: `eof`
   (`:1987`) and `connection_goodbye` (`:1397`) differ by whether the host exited
   cleanly, and `write_failed` (`:1954`, `:1963`) versus `protocol_violation`
   (`:1979`) differ by which side broke the contract. The observation window is
   `settle_all`'s loop (`:1654-1664`): a caller pending at that instant learns the
   cause, one arriving an instruction later cannot. What makes this quiet rather
   than merely absent is that two tests assert the two *constants* —
   `close_wins_against_admission_blocked_on_pending` (`:2365`) asserts
   `connection_retired` at `:2408`, and another asserts `generation_retired` at
   `:2556` and `:3043` — so the suite ratifies the erasure. Nothing asserts what a
   late caller can learn about the cause. Owned by
   [client-a-a-retired-generation-forgets-why-it-retired](catalog.md#client-a-a-retired-generation-forgets-why-it-retired)
   and
   [client-a-a-clean-host-close-and-a-transport-failure-share-one-code](catalog.md#client-a-a-clean-host-close-and-a-transport-failure-share-one-code).

3. **The route map is the one unbounded collection, it silently merges duplicate
   binds, and the bound it lacks is the one the document names.**
   `routes.insert(handle)` (`:507`) is the only insertion into an `Inner`
   collection with no capacity test: it checks `closed` (`:501`) and never
   `routes.len()`, while `pending` has a test at `:1169` and `streams` at
   `:1058`, and `:658` lists routes alongside both. Compounding it, `routes` is a
   `HashSet<RouteHandle>` (`:944`), so a duplicate host bind merges two callers
   onto one entry, and `release_stranded_route`'s already-cached early return
   (`:1576-1578`) — which is correct for the §8.2 case — means a genuine duplicate
   is never released either. Nothing tests either the growth or the merge. The two
   route tests that exist (`:3503`, `:3587`) cover the late-bind path, and neither
   runs in CI. Owned by
   [client-a-live-route-handles-are-bounded-only-by-the-host](catalog.md#client-a-live-route-handles-are-bounded-only-by-the-host)
   and
   [client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle](catalog.md#client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle).

## Sampling limits on this inventory

Stated so a later pass knows what was and was not looked at.

- Test counts are grep counts of attribute lines, not execution counts. All 40
  in-crate sites were individually printed and confirmed to be test `fn` lines,
  so the 40 is a count of distinct source functions rather than of macro
  expansions.
- CI reach was determined from workflow content only. Whether
  `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`) are
  **required** status checks for merge is repository settings and is not
  verifiable from this tree. That decides whether `--test client`'s three named
  invocations are gates or advisory, which is the difference between 2d being
  well covered and merely well tested. Carried forward unresolved from
  `../part-2-rescope/scope-map-and-risk-ranking.md:750-752`.
- The seven fixture binaries were counted by `Client::connect` occurrences, not
  read. **That sampling choice produced a false claim, and the correction is
  recorded above rather than hidden here:** `shm_soak.rs` and
  `shm_failure_modes.rs` each carry a thread-count assertion that bears directly
  on the bridge-thread quiet area, and counting occurrences instead of reading the
  bodies is exactly why quiet area 1 originally said the thread was "untested by
  anything". The remaining five fixture binaries are still unread, so the same
  class of omission may survive in them.
- `tests/support/echo_host.rs` was read only far enough to establish that it runs
  a real host with an echoing handler and cannot forge an inbound frame. Its
  remaining 100 lines were not examined.
- `crates/mc-module` was not read beyond confirming the three production
  `Client::connect` call sites that fix this sub-part's reachability class.
  Whether any consumer treats `host_shutdown`'s `Ok` as authority to start a
  replacement daemon is unresolved and is a catalog open question.

## Open questions

- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs all 40 in-crate checks here, which is 40 of the sub-part's 46
  claim-bearing tests. The 2b inventory records the same question as unresolved,
  as does the 4e inventory across five sub-parts. This synthesis did not decide it
  silently: the `Exercised:` lines in `catalog.md` are inherited verbatim from the
  lens records, which use `partial` when a test exists and `not yet` when none
  does, and that convention is what needs ratifying. (needs human input)
- Is `host_shutdown`'s use of `CLIENT_SHUTDOWN_TIMEOUT` as a *request* deadline
  (`client.rs:585`) deliberate? `:731` separates the request and shutdown deadline
  domains, `:740` gives the request domain 30 s and `:741` gives client shutdown
  5 s, and there is no comment at `:585`. A host slow to acknowledge therefore
  fails at 5 seconds with `deadline_expired` and `OutcomeUnknown`, which means the
  caller cannot tell whether the stop committed. (needs human input)
- Should the deleted-mechanism findings be documentation corrections or property
  records? Items 3 and 4 name "byte evidence" as the classification input, and the
  surviving mechanism is stronger than byte evidence, not weaker. A correction
  that simply deletes the phrase would lose the fact that the obligation is now
  discharged by a different and better mechanism. (needs human input)
- Can a panic in `writer_loop` or `ring_reader_loop` leave the generation live and
  every pending caller waiting to its own deadline? The absence of any
  `catch_unwind` in `1-2264` and the `let _ = task.await` at `:1691` argue yes,
  but proving it needs a panic seam that does not exist. (unresolved, needs an
  injectable panic point)
