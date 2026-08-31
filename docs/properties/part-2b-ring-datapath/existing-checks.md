# Sub-part 2b existing-check inventory

Every claim-bearing check for the host-side ring datapath:
`crates/mc-host/src/ring_transport.rs`, `wire.rs`, `frame_channel.rs`, and
`frame_channel/contract_tests.rs`, plus the integration binaries and CI steps
that reach them.

Provenance: branch `feat/shared-memory-release-gate-audit`, `HEAD` =
`e447c927`. Every count in this file was re-derived at that commit rather than
copied from the lens material: the four in-crate totals by grepping `#[test]`
and `#[tokio::test]`, the 24 integration binaries by listing
`crates/mc-host/tests/*.rs`, and the ten `TestHost` users by testing each binary
individually. All match lens B exactly.

**Every status below is `unaudited`.** An existing check never removes a
property from the catalog. Test adequacy belongs to
`/testing:invariant-test-review`; production guard adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory, and the correction to it

**35 in-crate tests reach this sub-part. None of them runs in CI.**

| Unit | Test module | Lines | Tests | Executed in CI |
| --- | --- | --- | --- | --- |
| `wire.rs` | `mod tests`, `:646-973` | 328 | **14** | **No** |
| `frame_channel/contract_tests.rs` | whole file, gated at `frame_channel.rs:27-28` | 701 | **14** | **No** |
| `ring_transport.rs` | `mod tests`, `:753-966` | 214 | **7** | **No** |
| `frame_channel.rs` | none | 0 | **0** | n/a |
| **Total in-crate** | | | **35** | **No** |

The reason is structural rather than an omission. Every `-p mc-host` invocation
in `ci.yml` carries a `--test <name>` filter, which selects one integration
binary and never builds the lib target. Re-verified at `HEAD`: the 13 `mc-host`
hits are `:87`, `:132`, `:133`, `:134`, `:168`, `:169`, `:178`, `:187`, `:190`,
`:211`, `:361`, `:442`, and `:461`, and none is an unfiltered or `--lib` run.
`:168-169` are `cargo build` steps, not test steps.

**The correction, and it changes the headline.** The re-scope's statement that no
in-crate check executes in CI is true of `#[test]` and `#[tokio::test]`
functions and false of doctests. `cargo test -p mc-host --doc` runs at
`ci.yml:190` under the step name "Rust lease non-escape" (`:189`), and it builds
and runs the lib target's doctests.

**Doctests: 2, and they are the only source-resident checks in this sub-part
that CI executes at all.** Both are `compile_fail`, both were printed and
confirmed at `HEAD`:

| Location | What it asserts |
| --- | --- |
| `frame_channel.rs:296-301` | `ReceiveLease::contiguous(&bytes)` cannot be passed to `fn require_send<T: Send>`, so `ReceiveLease` is not `Send` |
| `frame_channel.rs:303-308` | the same value cannot be passed to `fn require_static<T: 'static>`, so `ReceiveLease` is not `'static` |

The step name names them precisely. Together they hold the one claim in this
sub-part that has mechanical enforcement in CI: receive bytes are visible only
through a lexical, thread-confined lease. `wire.rs:4-14` is a ```text``` fence
and is not compiled, so it is not a check.

So the correct statement is: **no inline unit test in this sub-part runs in CI,
and two doctests do.**

### The in-crate contract suite, split by reach

`frame_channel_contract_suite!` is declared at `contract_tests.rs:415` and
invoked exactly once, at `:524`, against `RingFactory`. The two halves of the
file have different reach and are worth separating.

- **9 semantic scenarios** from the macro, instantiated against `RingFactory`.
  `RingFactory::connect` (`:498-521`) builds a **real** `RingTransport` and calls
  the production `prepare`, so these drive a real `DuplexRing` through production
  code. Scenario bodies: `:110` FIFO ordering, `:149` saturation and reserved
  control capacity, `:203` completion hooks, `:247` pre-admission cancellation,
  `:267` post-publication failure, `:306` graceful finish, `:330` discard, `:353`
  inbound ownership, `:386` Goodbye. Status unaudited.
- **5 in-process ownership tests** in `mod ownership_contract` (`:526-701`) at
  `:583`, `:591`, `:630`, `:673`, `:689`. These use synthetic spans and a
  `LeaseTracker`, not a ring. The module's own doc at `:6-7` states they "cannot
  be selected as a production transport". Status unaudited.

### `ring_transport.rs`, 7 tests

At `:769`, `:777`, `:821`, `:829`, `:838`, `:881`, `:928`. The five named in
catalog records are:

| Line | Test | What it covers |
| --- | --- | --- |
| `:770-775` | `construction_has_no_ring_side_effects` | the process-level owner holds no ring and no mapping |
| `:787-805` | the diagnostics shape test | the healthy branch of `diagnostics()` plus all five counters, including `quarantined.arena_bytes == 0` (`:800`), `reclamation.completed == 1` after a direct call (`:804`), and `exhaustion.observed == 0` (`:805`) |
| `:834` | (unnamed here) | uses `catch_unwind` inside a test to assert a **non**-panic, the inverse construction |
| `:881-926` | `copied_control_frame_records_one_host_adapter_copy` | one host-adapter copy per flattened body; uses `ByteBudget::new(1024)` (`:915`), so the ingress-budget wait is never entered |
| `:928-965` | `budget_wait_observes_read_cancellation` | cancellation observed inside the ingress-budget wait; uses `ByteBudget::new(0)` (`:949`) with an empty sender queue (`:944-945`), so the publish-from-wait branch never runs |

A second assertion that host quarantined accounting is zero sits at `:774`.
Status unaudited for all seven.

### `wire.rs`, 14 tests

At `:673`, `:679`, `:692`, `:702`, `:721`, `:744`, `:776`, `:794`, `:835`,
`:864`, `:888`, `:906`, `:938`, `:954`. These are the codec and byte-budget
tests: header encode and decode, the frozen prefix, malformed-input rejection,
and permit arithmetic. Status unaudited.

### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]` in the four scope files: none found. `should_panic`: none found.**
Grepped all four. No `loom`, `shuttle`, `miri`, `proptest`, `quickcheck`, or
`arbitrary` anywhere in this sub-part, so every in-crate check here is a
hand-written fixture case. There is no coverage measurement, so every placement
observation in this file is structural rather than measured.

One `#[ignore]` does exist in the integration layer and it matters: see the
`shm_soak` and `shm_role_client` rows below.

## Integration tests

No integration binary is dedicated to this sub-part. Coverage arrives through
the shared harness. `tests/support/mod.rs` starts a real host, and therefore a
real ring, and `tests/support/raw_client.rs` drives the peer side through
`RingClientEndpoint::attach_with_descriptors` (`raw_client.rs:644`, with helpers
at `:765` and `:814`).

**Ten of the 24 integration binaries use `support::TestHost` and therefore
exercise the ring datapath. Four are named in CI; six are not.** Re-verified by
testing each of the 24 binaries individually at `HEAD`.

| Binary | Tests | CI status |
| --- | --- | --- |
| `client.rs` | 6 | **named** — `ci.yml:132`, `:179`, `:187` |
| `lifecycle.rs` | 35 | **named** — `ci.yml:179`, `:187` |
| `shm_failure_modes.rs` | 6 | **named** — `ci.yml:133`, with `--test-threads=1` |
| `shm_soak.rs` | 2 | **partial** — `ci.yml:134-135` names `short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded` with `--exact`, so one of the two runs. The other, `release_eight_hour_source_tree_soak` (`:123`), carries `#[ignore = "eight-hour source-tree resource soak"]` (`:122`) |
| `protocol_vectors.rs` | 15 | unnamed |
| `dispatch.rs` | 20 | unnamed |
| `routing.rs` | 12 | unnamed |
| `handler_contract.rs` | 12 | unnamed |
| `host_roundtrip.rs` | 4 | unnamed |
| `instance_security.rs` | 15 | unnamed |

The six unnamed binaries are `protocol_vectors`, `dispatch`, `routing`,
`handler_contract`, `host_roundtrip`, and `instance_security`. Together they
hold 78 tests that start a real host and never run in automation.

**One addition this synthesis verified and neither lens recorded in the check
inventory.** `shm_failure_modes.rs` contains a real-process SIGKILL harness that
does run in CI. `Victim::spawn` (`:119-140`) re-execs the test binary with
`--ignored --exact shm_role_client --nocapture`, the child dispatches on the
`ROLE_ENV` variable at `:31-33` (an `#[ignore]`d test, so it never runs as an
ordinary case), and `Victim::kill` (`:141-147`) sends `SIGKILL` and asserts
`status.signal() == Some(libc::SIGKILL)`. Three roles exist: `setup`, `active`,
and `idle`, synchronized by a printed `READY <role>` barrier (`:111-114`,
consumed at `:130-138`). Two tests drive it:
`setup_active_and_idle_sigkill_each_return_exact_capacity` (`:233`) kills at
each of the three roles and asserts resources return to a baseline, and
`repeated_crashes_do_not_ratchet_single_connection_capacity` (`:248`) does
twelve alternating cycles. Both use `max_connections = 1`. This is the closest
existing check to
[ring-a-admission-charge-releases-on-every-endpoint-thread-exit](catalog.md#ring-a-admission-charge-releases-on-every-endpoint-thread-exit),
it asserts a resource baseline rather than a per-exit-path charge delta, and its
significance for constructability is worked through in
[fault-map.md](fault-map.md). Status unaudited.

Four further binaries name the setup socket but are not ring-datapath checks and
are not named in `ci.yml`: `perf_measurement.rs` (23 tests) and
`ipc_budget_evidence.rs` (14) are measurement and evidence-format suites, and
`perf_budget_runner.rs` (10) and `ipc_budget_topology.rs` (9) are likewise
unnamed.

**Publication-observability seams.** `support/mod.rs:597`
(`start_with_publish_hook`), `:614`, and `:650`
(`mc_host::run_with_publish_hook`), against the production installer
`RingTransport::set_publish_hook` (`ring_transport.rs:229`) and its invocation
site (`:568-572`). `lifecycle.rs` is the one binary that uses them.

## TypeScript-side gates

Four CI-run gates touch this sub-part's contract, all inside `shm-source-build`
(`ci.yml:137`). None executes Rust.

| Gate | Command | Line | What it covers here |
| --- | --- | --- | --- |
| Plugin shared-memory contracts | `bun test packages/plugin/src/shared/mc-host-client` | `:211` | `protocol.test.ts` (32 tests) pins the 21-byte header, frozen-prefix decode order, and the 64 MiB cap against literals in `protocol.ts:14`, `:18`. `shm-frame-channel.test.ts` (15) covers the nine terminal-class mappings at `:49-57` |
| Architecture audit | `bun test scripts/check-mc-shm-architecture.test.ts` and `bun run check:shm-architecture` | `:55`, `:58` | the deleted-transport grep gate |
| Plugin shared-memory lifetime (Node 24) | `bun run --cwd packages/plugin test:mc-shm:node` | `:214` | native lease and channel lifetime across the runtime boundary |
| Native behaviour | `bun run --cwd packages/mc-shm-native test:bun` and `test:node` | `:196`, `:203` | the peer half's mechanism gate, under `MC_SHM_NATIVE_CLAIMED_TARGET: "1"` |

One further gate has no Rust counterpart. `ci.yml:219-223`, "Reject prebuilt
native modules", runs `test -z "$(git ls-files '*.node')"`, then removes
`packages/mc-shm-native/mc_shm_native.node` and asserts its absence. Because the
removal runs *after* the four native and plugin steps, every CI TypeScript test
executes against a locally built addon. Status unaudited.

## Production assertions and guards, clustered

**Assertion density in this sub-part is near zero. Enforcement is by type and
returned value, not by assertion.**

**`assert!`, `assert_eq!`, `panic!`, `unreachable!`, and `todo!` in the
production halves of the four scope files: none found.**

**`debug_assert!`: 1.** `frame_channel.rs:188-191`, labelled "validated span
capacity must cover write", inside `ProducerReservation::write` after the span
walk. It is behind `debug_assertions`, so it is present in a debug build and
absent from a release one. CI builds debug (`ci.yml:168-169` carry no
`--release`), while `packages/mc-shm-native/index.ts:189-191` rejects a
non-release addon with `NativeStartupError("debug_build")`, so the two halves of
one deployment do not share a profile assumption. Which profile the distributed
`mc-host` binary uses is unresolved; it is an open question below, not a finding.
Status unaudited.

**`.unwrap()` in production halves: none found.** Every `unwrap` in the four
files is inside a `#[cfg(test)]` module.

**`.expect(`: 10, in four clusters.** All are infallible-by-construction or
contract statements rather than input validation.

| Cluster | Sites | Labels |
| --- | --- | --- |
| Static profile construction | 2 | `ring_transport.rs:45` `"static hardware profile is valid"`, `:57` `"static shared-memory profile is valid"` |
| Mutex acquisition | 6 | `ring_transport.rs:230`, `:252` `"publish hook lock"`; `frame_channel.rs:419`, `:429`, `:433`, `:441` `"lease tracker lock"` |
| Ownership invariant | 1 | `frame_channel.rs:286` `"a committed body always owns its charge"` |
| Semaphore invariant | 1 | `wire.rs:418` `"byte budget semaphore is never closed"` |

The last two state contracts rather than assumptions.
`frame_channel.rs:286` is covered by
`producer_failures_never_publish_and_return_each_charge_once`
(`contract_tests.rs:689`). `wire.rs:418` has **no** check that closes the
semaphore, so its label is unverified. Status unaudited for all ten.

**`catch_unwind`: 2, both on the endpoint thread and both load-bearing.**

- `ring_transport.rs:279-290` wraps the whole `run_endpoint` future. Its result
  is discarded with `let _ =` at `:279`, so an endpoint panic falls through to
  `admission.release()` (`:291`) and `done_tx.send(())` (`:292`): a panicking
  worker is reported to the host as orderly completion. Owned by
  [ring-a-endpoint-thread-panic-is-reported-as-orderly-completion](catalog.md#ring-a-endpoint-thread-panic-is-reported-as-orderly-completion).
- `:560-563` wraps one publication, converting a panic into `Err(())` and thence
  into channel retirement at `:447-451`.

A third layer sits inside `publish_direct` through
`crate::panic_boundary::redact_sync` (`:586-589`), which wraps only the direct
serializer and not the completion hooks. No check covers any of the three on the
ring thread; `panic_boundary.rs` itself is Part 2a scope. Status unaudited.

**`let _ =` discarded results: 8.** `ring_transport.rs:267` and `:273`
(initialization-channel sends on the two failure paths), `:279` (the
`catch_unwind` result), `:292` (`done_tx`), `:302` (`done_rx`), `:345` (a
`write!` into a `String`, infallible), `:396` and `:401` (inbound close
notifications). The last two discard a send failure on the very path that
reports a close reason, so a full inbound channel silently drops the
classification. Status unaudited.

**Typed rejection guards.** This is where the real enforcement lives.
`ReadClose::Corrupt` carries nine distinct `&'static str` reasons: six in
`ring_transport.rs` (`:467`, `:472`, `:477`, `:507`, `:521`, `:524`) and three in
`frame_channel.rs` (`:60` `"body over interoperability cap"`, `:67` `"invalid
pure-header flags"`, `:73` `"role-invalid frame type"`). Two of the nine share
one string: `:477` and `:524` both emit `"shared-memory completion failed"` from
different release sites, so the string does not identify which path failed.
`RingUnavailable` (`ring_transport.rs:114-122`) and `RingClientError`
(`:737-751`) each collapse every cause into one opaque value with a hand-written
redacting `Debug` (`:739-743`). Status unaudited.

**Explicit "none found" for the remaining categories.** No fuzz target reaches
these four files. No benchmark asserts a behavioural claim here. No
`#[should_panic]`, no `#[ignore]` in the scope files, no snapshot or golden
fixture, no differential harness against the TypeScript peer implementation, and
no coverage instrumentation. There is also **no in-crate test in
`frame_channel.rs` itself**: its 807 lines carry the two `compile_fail` doctests
and nothing else, with all its behavioural coverage delegated to the
`contract_tests.rs` sibling module.

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any executed
check proves.

1. **The entire 14-test semantic contract suite is well-built and unexecuted.**
   This is the quietest thing in the sub-part, and not because coverage is thin.
   `contract_tests.rs` holds the only checks anywhere on FIFO admission ordering
   (`:110`), saturation and reserved control capacity (`:149`), completion-hook
   exactly-once ordering (`:203`), pre-admission cancellation (`:247`),
   post-publication failure (`:267`), graceful drain (`:306`), discard charge
   release (`:330`), inbound ownership (`:353`), and Goodbye (`:386`). Nine of
   the fourteen drive a **real** `DuplexRing` through the production `prepare`,
   because `RingFactory::connect` (`:498-521`) builds a real `RingTransport`. The
   suite is designed for exactly the job this catalog needs done. It is
   `#[cfg(test)]` in the lib target (`frame_channel.rs:27-28`), and no `ci.yml`
   step builds the `mc-host` lib test target, so it runs only on a developer's
   laptop. That is the failure mode a coverage count cannot show: the problem is
   not missing tests, it is good tests with no automation behind them. Everything
   below is second-order until this changes, because anything added is added to a
   suite nothing executes.

2. **`prepare`'s four uncounted failure paths are unobservable in production and
   unreachable in test, while `diagnostics()` still says healthy.**
   `ring_transport.rs:264-270` (runtime or `DuplexRing::create` failure),
   `:271-275` (descriptor marshalling), `:294-296` (thread spawn), and `:297`
   (initialization-channel loss) each return `RingUnavailable` without touching
   `exhaustions` or any other counter. `diagnostics()` derives `state` solely
   from `self.accounting()` (`:176-190`), which cannot observe any of them, so
   the report stays `state: "healthy"`, `error_class: null`, all counters zero.
   And no test drives any of the four, because there is no seam to fail
   `tokio::runtime::Builder::build`, `DuplexRing::create`, `worker_descriptor`,
   or `thread::Builder::spawn`. So the branch that turns a host into a
   connection-refusing black box with a clean bill of health is invisible from
   both sides at once: production cannot report it and no test can reach it. Only
   the fifth cause, admission exhaustion, is counted (`:239-242`), and the one
   existing assertion on it checks that the counter is zero on a fresh transport
   (`:805`).

3. **Nothing publishes a 64 MiB frame through a real ring, and the geometry
   makes that tight.** The maximum-size conformance obligation is checked only
   over synthetic spans in the ownership half of the contract suite
   (`contract_tests.rs:673-679`), never against real ring geometry. Against the
   real geometry the numbers leave no slack, and this synthesis verified both
   constants. `MAX_FRAME_BYTES` is `64 * 1024 * 1024`
   (`crates/mc-shm-transport/src/arena.rs:4`) and `MIN_ARENA_BYTES` is defined as
   exactly `MAX_FRAME_BYTES` (`:6`), which `ring_transport.rs:48` uses as
   `arena_bytes`. So **the arena is exactly 64 MiB per direction, one in-flight
   maximum body consumes all of it, and the profile's eight descriptor slots
   (`DESCRIPTOR_DEPTH = 8` at `:32`, `max_leases` at `:50`) collapse to a single
   usable frame.** Whether `reserve_until` then blocks until the frame deadline
   or fails immediately is undetermined by any check in this sub-part, and the
   answer decides whether a maximal frame degrades throughput or retires the
   connection. Note the interaction with
   [ring-a-publish-failure-is-reported-as-a-clean-peer-close](catalog.md#ring-a-publish-failure-is-reported-as-a-clean-peer-close):
   if it fails, the cause is erased to `()` and arrives as a clean peer EOF.

## Sampling limits on this inventory

Stated so a later pass knows what was and was not looked at.

- Test counts are grep counts of `#[test]` and `#[tokio::test]` attributes, not
  execution counts. A macro-expanded case counts once per expansion site, which
  is why the contract suite's nine scenarios plus five ownership tests total
  fourteen attributes rather than fourteen distinct source functions.
- CI reach was determined from workflow content only. Whether
  `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`) are
  **required** status checks for merge is repository settings and is not
  verifiable from this tree. Carried forward unresolved from the re-scope.
- `scripts/check-mc-shm-architecture.test.ts` was not read. It is the gate
  keeping the deleted transports deleted, and several catalog records assume
  nothing reintroduces a fallback path. Lens B read the script it tests and
  recorded three limits: it skips `.test.ts` files (`:48`), never walks
  `crates/mc-host/tests/`, matches names rather than semantics, and never reads
  `docs/`. The test file itself remains unexamined.
- The six unnamed `TestHost` binaries were counted, not read. Their 78 tests may
  contain checks relevant to catalog records; this inventory establishes only
  that they start a real ring and that CI does not run them.

## Open questions

- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs all 35 in-crate checks here, which is the majority of this sub-part's
  coverage. Lens B flagged that the 4e inventory records the same question as
  unresolved across five sub-parts
  (`../part-4e-rendering/existing-checks.md:840-846`). This synthesis did not
  decide it silently: the `Exercised:` lines in `catalog.md` are inherited
  verbatim from the lens records, which use `partial` when a test exists and
  `not yet` when none does, and that convention is what needs ratifying.
  (needs human input)
- Does the distributed `mc-host` artifact ship debug or release? It decides
  whether the single `debug_assert!` (`frame_channel.rs:188`) exists in
  production. CI builds debug (`ci.yml:168-169`), while the addon loader refuses
  a non-release addon (`packages/mc-shm-native/index.ts:189-191`). Needs the
  release pipeline, not this tree. (needs human input)
- Does `wire.rs:418`'s label, "byte budget semaphore is never closed", hold? It
  is the one `.expect` in this sub-part with no covering check, and closing the
  semaphore is the only way to falsify it.

---

## Checks cited by the four records carried from `part-2b-wire-and-channels`

Appended when the four wire-header records were carried into this sub-part; see
[catalog.md](catalog.md#group-g-the-wire-header-decode-contract) for the carry
and [../part-2b-wire-and-channels/README.md](../part-2b-wire-and-channels/README.md)
for the superseded directory. Nothing above changes. This section adds only the
named checks those four records cite, so every check they name is in the
inventory. Every location was re-verified at carry time.

**No new check was discovered.** All eight sites below are already counted in the
inventory above, in the `wire.rs`, 14 tests entry and the `protocol_vectors.rs`
row of the integration table. What was missing is which record each serves, and
two locations that had drifted.

### `wire.rs` tests, by the record they serve

Eight of the 14 tests already counted at `:673`, `:679`, `:692`, `:702`, `:721`,
`:744`, `:776`, `:794`, `:835`, `:864`, `:888`, `:906`, `:938`, `:954` are cited
by a carried record. The rows below give the `fn` line rather than the
attribute line, which is the form the records use.

| Site | Test | Record it serves |
| --- | --- | --- |
| `wire.rs:722-742` | `reject_truncated_headers_and_unsupported_versions` | decode totality; three inputs across gates 1, 2 and 3 |
| `wire.rs:745-774` | `reject_unknown_frame_type_and_reserved_flag_encodings` | decode totality and reserved encodings; four inputs across gates 4, 5, 6 and 7 |
| `wire.rs:703-719` | `little_endian_and_frozen_prefix_layout` | the bijection, encode direction only, distinctive ascending values, plus `buf.len() == HEADER_LEN` at `:718` |
| `wire.rs:680-690` | `round_trip_request` | the bijection, one fixture, encode-first |
| `wire.rs:693-700` | `round_trip_all_frame_types` | the bijection, twelve fixtures varying only `ty`, encode-first |
| `wire.rs:795-833` | `epoch_boundaries_round_trip_and_control_channel_epoch_is_reserved` | both halves of the channel-and-epoch pairing |
| `wire.rs:836-862` | `sheddable_rejected_on_every_illegal_frame_type` | the Sheddable cross-product, ten illegal types plus both legal ones at `:858-861` |

Status unaudited for all seven. None runs in CI, under `R0`.

**One location repaired.** The span of
`reject_unknown_frame_type_and_reserved_flag_encodings` is `:745-774`. Two of the
carried records wrote `:745-773`; `:773` is the `);` of the last assertion and the
closing brace is `:774`.

### `tests/protocol_vectors.rs`, and the two checks that moved

The binary is already in the integration table above at 15 tests, unnamed in CI.
Re-verified at carry time: still 15 tests, and now **762 lines rather than 976**.
`63c4d277` ("refactor(shm): enforce ring-only architecture") shrank it. Blob
hashes: `21f03055` at both `1c193ae0` and `793a973e`, `0cbd259e` at `e447c927`.

| Site | Test | Record it serves | Note |
| --- | --- | --- | --- |
| `:351` | `structural_corruption_is_rejected_before_dispatch` | reserved encodings, end to end | **Renamed and moved.** Was `structural_corruption_closes_silently` at `:512`. Verified a rename rather than a rewrite: the doc comment above it, the `struct Case { name, bytes }` declaration, and the first table entry `"unsupported version"` are all unchanged |
| `:504` | `pure_header_frames_accept_any_valid_priority` | reserved encodings, end to end | **Moved.** Was `:656`; name unchanged |
| `:143` | `committed_header_vectors_decode_to_their_documented_fields` | cited by the encoder record as what does *not* cover it | Asserts the document's committed byte vectors against the independent oracle `raw_client::decode_header` (`tests/support/raw_client.rs:286`), which is the decode direction over fixed inputs, not encoder refusal |

Status unaudited for all three.

### One category with nothing in it, stated explicitly

**Encoder-refusal checks: none found.** No test anywhere in the tree feeds
production encoder output back through `decode_header` plus
`validate_inbound_header` (`frame_channel.rs:58`). Verified by grepping every
`encode_owned_frame` and `encode_split_frame` call site
(`dispatch.rs:292`, `:329`, `:723`, `:802`, `:1458`, `connection.rs:779`, `:866`,
`client.rs:1329`, `:2092`, plus `wire.rs:615`) and every `decode_header` call site
(`ring_transport.rs:503`, `:730`, the test-only-hook site `:593`, `client.rs:1978`, plus the test-side
`raw_client.rs:286` and `:556`): no test composes one with the other. This is the
`Existing check: none.` on
[encoder-never-emits-a-frame-its-own-decoder-rejects](catalog.md#encoder-never-emits-a-frame-its-own-decoder-rejects).

**Fuzz targets for `wire::decode_header`: none found.** `find -type d -name fuzz`
over the repository returns one directory, `crates/mc-shm-transport/fuzz`, whose
three targets are `frame_descriptor.rs`, `provider_grant.rs` and
`provider_sample.rs`. All three are transport decoders and none reaches
`mc-host`'s codec. This is consistent with the "no property tooling" finding
above, which grepped the four scope files; this extends it to the fuzz
directory, which is outside them.

### One test-only encoder inside a production file

Recorded here because it is a fidelity observation about the check inventory
rather than about a record. `wire::encode_frame` carries `#[cfg(test)]` at
`wire.rs:541`, and its only two callers are
`frame_channel/contract_tests.rs:93` and `:163` — both already counted in the
14-test `contract_tests.rs` entry above. So the semantic contract suite builds
its frames with an encoder no production path uses, and the two differ on exactly
the property the byte budget depends on: `encode_owned_frame` does exact-size
growth (`:597-600`) under the comment at `:594-596` warning that amortized
`reserve` would double a full-capacity body, while `encode_frame` allocates fresh
with `Vec::with_capacity` at `:565`. Status unaudited. This corrects the carried
encoder record's own count of three production encoders down to two.
