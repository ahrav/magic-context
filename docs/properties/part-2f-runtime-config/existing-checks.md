# Sub-part 2f existing-check inventory

Every claim-bearing check for runtime assembly and the configuration contract:
`crates/mc-host/src/runtime.rs` (1,344 lines), `harness_closure.rs` (1,122),
`config.rs` (674), `lib.rs` (87), `file_mode.rs` (19), the four integration
binaries that carry this sub-part's claims, and the CI steps that reach any of
them.

Provenance: system `/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`. Counts come from
lens B, which derived each by extracting the production half of each file and
grepping it so no test-module hit is included. This synthesis re-derived the file
lengths with `wc -l`, the `#[cfg(test)]` boundaries by grep, the `ci.yml` hit
list by grep, and four load-bearing line references by printing them
(`config.rs:294`, `runtime.rs:876`, `:1130`, `:1223`, plus `serve.rs:593`).

**Every status below is `unaudited`.** An existing check never removes a property
from the catalog. Test adequacy belongs to `/testing:invariant-test-review`;
production guard adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

## The coverage fact that frames this inventory

**11 in-crate tests reach 3,246 lines, none of them runs in CI, and there are
zero doctests. This is the weakest source-resident position of the three
sub-parts.** 2e owns four CI-executed `compile_fail` doctests and 2b owns two; 2f
owns none.

| Unit | Where | Production | Tests | Executed in CI |
| --- | --- | --- | --- | --- |
| `config.rs`, `mod tests` at `:463-674` | one module | `1-462` | **10** | **No** |
| `runtime.rs`, `mod tests` at `:1299-1344` | one module | `1-1298` | **1** | **No** |
| `harness_closure.rs` | no test module | all 1,122 | **0** | n/a |
| `lib.rs` | no test module | all 87 | **0** | n/a |
| `file_mode.rs` | no test module | all 19 | **0** | n/a |
| Four integration binaries | `tests/` | — | **52** | **No** |
| Doctests | none exist anywhere in the five files | — | **0** | n/a |

The reason none of the 11 runs is structural, and this pass re-derived it. Every
`-p mc-host` test invocation in `ci.yml` carries a `--test <name>` filter, which
selects one integration binary and never builds the lib target: `:132`, `:133`,
`:134-135`, `:178-179`, `:187`. The remaining `mc-host` hits are `:87` (a Bun
drift gate), `:168-169` (`cargo build`), `:190` (the doctest step), `:211`,
`:361`, `:442`, and `:461`. None is an unfiltered `cargo nextest run -p mc-host`
or a `--lib` run.

### In-crate tests, 11 in five clusters

| Cluster | Tests | Sites |
| --- | --- | --- |
| Limit and byte-budget bounds | **5** | `config.rs:502` `zero_limits_rejected`, `:520` `the_resident_cap_splits_into_three_non_overlapping_pools`, `:550` `byte_budget_below_interop_minimum_rejected`, `:564` `oversize_byte_budget_rejected`, `:576` `constructor_capacity_bounds_are_validated` |
| Duration bounds | **2** | `config.rs:636` `zero_durations_rejected`, `:646` `overflowing_durations_rejected` |
| Identity and digest validation | **2** | `config.rs:472` `noncanonical_payload_digests_are_rejected`, `:603` `daemon_version_boundary_keeps_auth_and_discovery_readable` |
| Defaults are self-consistent | **1** | `config.rs:467` `defaults_validate` |
| Shared shutdown Goodbye deadline | **1** | `runtime.rs:1326` `stalled_generations_share_one_shutdown_goodbye_deadline` |
| **Total in-crate** | **11** | |

**Two observations follow from that table, and both are load-bearing for the
catalog.**

First, **all 10 `config.rs` tests prove that validation rejects something; none
proves that an accepted configuration is then used as configured.** `:467`
`defaults_validate` proves acceptance, which is not the same as use. That is
exactly the class both fixed-bound findings fall into: a `shutdown_deadline` of
10 s is proven nonzero and never proven to bound shutdown, and a
`health_interval` of 30 s is proven in range and never proven to be the interval
the loop selects. No rejection test can catch either.

Second, **`runtime.rs:1326` is the only in-crate test in the sub-part that
touches the shutdown sequence, and its subject is the shared Goodbye deadline
rather than the drain composition at `:1200-1243`.** So the five unbounded or
re-armed decisions in `shutdown_sequence` have no in-crate coverage at all.

**`#[ignore]`, `should_panic`, `loom`, `shuttle`, `miri`, `proptest`,
`quickcheck`, `arbitrary`: none found** in any of the five files. No coverage
instrumentation, so every placement statement here is structural rather than
measured.

## Integration tests

**Four of the 24 binaries carry this sub-part's claims, and CI names none of
them.**

| Binary | Tests | Lines | Subject | CI status |
| --- | --- | --- | --- | --- |
| `tests/synapse_bundle.rs` | 24 | 936 | limit feasibility, named by `config.rs:63` | **unnamed** |
| `tests/harness_closure.rs` | 15 | 647 | the only exercise of `HarnessClosureStore` | **unnamed** |
| `tests/ipc_budget_topology.rs` | 9 | 296 | byte-pool separation | **unnamed** |
| `tests/activation.rs` | 4 | 412 | the activation path the fast-probe records depend on | **unnamed** |
| **Total** | **52** | 2,291 | | **0 named** |

The four binaries CI does name are `client` (`ci.yml:132`, `:179`, `:187`),
`lifecycle` (`:179`, `:187`), `shm_failure_modes` (`:133`), and `shm_soak`
(`:134-135`, one test by `--exact`). So **4 of 24 named, 20 unnamed**.

**`tests/lifecycle.rs` is the one CI-named binary that reaches these files at
all, and it must not be credited as coverage for this sub-part's claims.** It
holds 35 tests in 1,846 lines and does reach `runtime.rs` transitively, since
`run` is how any host starts. It is Part 2a scope and its subject is lifecycle
records and publication rather than the configuration contract. Recorded both
ways deliberately: a later pass should not credit it, and should not overlook
that it is the only CI-executed path through `runtime.rs`.

Several of its tests are nonetheless the fixtures this sub-part's records name,
which is why the two facts sit together:

| Site | What it supplies to a 2f record |
| --- | --- |
| `tests/lifecycle.rs:165` | sets `health_interval` to 50 ms, which **coincides with the hardcoded value** and therefore cannot distinguish the two branches at `runtime.rs:1129` |
| `:402` | one of the two `liveness: Some(..)` sites in the repository |
| `:496` | `liveness_is_disabled_by_default`, the one `Exercised: yes` in this catalog |
| `:579` | a slow-callback handler, which is the health-snapshot record's fixture |
| `:678`, `:714-715` | the non-yielding-callback shape that reaches the forced shutdown path, with both deadlines set |

**`tests/harness_closure.rs` deserves separate emphasis.** It is the **only**
place in the repository that constructs a `HarnessClosureStore` for test
purposes, at 11 sites (`:159`, `:182`, `:253`, `:277`, `:325`, `:414`, `:447`,
`:462`, `:477`, `:497`, plus `tests/broca_subprocess.rs:853`), each with
`.expect("store")`. So a 1,122-line module with zero in-crate tests and zero
doctests has exactly one test binary, and CI does not run it.

`tests/handler_contract.rs` is 2e's binary by subject but supplies four fixtures
this sub-part's records name — `:302-320` (a declaration sum near a limit),
`:323`, `:375`, `:408`, `:437`, and `:378-388`, `:636` — and it is also unnamed.

## Doctests

**None found.** `runtime.rs`, `harness_closure.rs`, `config.rs`, `lib.rs`, and
`file_mode.rs` contain **zero** doc fences of any kind. Verified by grepping
every ` ``` ` occurrence under `crates/mc-host/src/` and attributing each: the
crate's only fences are four `compile_fail` in `handler.rs` (2e scope), two
`compile_fail` in `frame_channel.rs` (2b scope), and two `text` fences that are
not compiled (`wire.rs:4-14`, `generation.rs:6-11`).

**This is the single largest structural gap in this inventory.** `ci.yml:190`
runs `cargo test -p mc-host --doc` under the step name "Rust lease non-escape",
printed and confirmed, and `config.rs`, `harness_closure.rs`, and `lib.rs` are
all `pub mod` (`lib.rs:14`, `:17`, `:18`), so a doctest added to any 2f file
would execute in CI today. For a sub-part whose entire contract is doc comments,
the one CI lane it could reach is the one it does not use.

## Production assertions and guards, clustered

Enforcement here is by returned `Result` and typed error. Counts were derived
from each file's production half only.

**`.expect(`: 18, in four clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Startup and abandon cleanup guards | 7 | `runtime.rs:348`, `:359`, `:361`, `:369`, `:370`, `:385` — `"armed startup cleanup"` / `"started startup cleanup"`; `:409`, `:415` — `"armed abandon guard"` |
| Mutex and lock invariants | 6 | `runtime.rs:79`, `:88` `"fatal lock"`; `:152`, `:215` `"abort lock"`; `:428`, `:1179` `"connections lock"` |
| Infallible serialization | 2 | `config.rs:320` `"fixed auth shape serializes"`, `:331` `"fixed publication shape serializes"` |
| Validated-above contracts | 2 | `harness_closure.rs:218` `"key was collected from this object"`, `:400` `"launch and dependency roots were checked above"` |

**The startup-cleanup cluster is the load-bearing one and the least
characterised.** Seven `.expect` sites across `:348-415` all assert that a
cleanup guard is in the state a prior step armed it into, which is a seven-site
sequencing contract with no test and no shared helper.
`harness_closure.rs:400` is the sharpest single label: it asserts that
`validate_manifest` already checked the roots, so a validation path that admits
an unchecked root converts a typed `HarnessClosureError` into a panic. Status
unaudited for all 18.

**One mixed policy worth recording.** `runtime.rs:1120-1123` writes the health
snapshot using `unwrap_or_else(std::sync::PoisonError::into_inner)`, so poisoning
is recovered there, while the six lock sites above propagate it. The file mixes
both policies with no comment on which applies where.

**`panic!`, `todo!`, `unimplemented!`, `unreachable!`, `assert!`, `assert_eq!`,
`debug_assert!`, `.unwrap()`, `catch_unwind`: none found** in the production half
of any of the five files. Enforcement is entirely `Result`-based, and the one
panic boundary the sub-part relies on lives in `panic_boundary.rs` (Part 2a
scope), reached through `crate::panic_boundary::redact` at
`runtime.rs:1273-1274`. This is a marked contrast with 2e, whose `routing.rs`
holds three unconditional production panics under a process-global mutex.

**`let _ =` discarded results: 7, in three clusters.**

| What is discarded | Sites |
| --- | --- |
| Awaited task and shutdown futures | `runtime.rs:302`, `:362`, `:388` |
| Startup cleanup call | `runtime.rs:847` |
| Filesystem teardown | `runtime.rs:935` (`std::fs::remove_file(setup_socket)`), `harness_closure.rs` 2 sites |

`runtime.rs:935` is the consequential one: the setup socket's removal is
best-effort with no local record, and a stale socket file is what a successor
incarnation would have to reconcile. Status unaudited.

**Checked and saturating arithmetic: 9.** `checked_` four times and
`saturating_` three times in `runtime.rs`, `checked_` twice in
`harness_closure.rs`. `runtime.rs:1223`'s `saturating_mul(2)` is one of the
three, and it is the only one where the saturation is not the point: the
multiplication itself is the finding.

**Typed rejection guards.** This is where the real enforcement lives.
`HostLimits::validate` (`config.rs:147`) and `HostConfig::validate` (`:300`)
return a `ConfigError` naming the offending key at `:158`, `:161`, `:169`,
`:176`, `:187`, `:358`, and `:361`, and every `Display` arm prints the configured
and maximum values (`:420-457`). `HarnessClosureError`
(`harness_closure.rs:162-166`) is a closed vocabulary carrying a single
`&'static str` behind one constructor, `invalid()` (`:182-184`), with a
`detail()` accessor (`:169`), and it enforces five hard caps
(`MAX_MANIFEST_BYTES` 16 MiB, `MAX_NODES` 65,536, `MAX_PATH_BYTES` 4096,
`MAX_STRING_BYTES` 1024, `:25-28`) plus sticky-bit and non-regular-file guards
(`:29-32`). Status unaudited.

**The one silent narrowing in the sub-part** is `file_mode::raw_mode`
(`file_mode.rs:18`), which masks with `0o7777`. Its doc comment (`:12-15`) states
that the mask documents a range rather than narrowing a value that could exceed
it, and within `harness_closure.rs` that holds: `validate_manifest` constrains
`mode` to exactly `0o600` or `0o700` (`:284-286`) before `copy_node` (`:704`) or
`write_new_file` (`:979`) reach it. The invariant is asserted in prose only, and
the function is `pub(crate)`, shared with `generation.rs`, which is Part 2a's
file.

**Explicit "none found".** No fuzz target reaches any of the five files;
`shm-hardening-optin.yml:78` runs `cargo +nightly fuzz run` but names no
`mc-host` target. No benchmark asserts a behavioural claim here. No snapshot or
golden fixture. No differential harness against the TypeScript peer. No coverage
instrumentation. No `#[ignore]` and no `should_panic`. No doctest, `text` fence,
or code fence of any kind.

**Clippy does not run in CI for any crate, by choice.** The `check-rust` job
(`ci.yml:463`) runs only `cargo fmt --check` (`:485`) and
`cargo check -p mc-core --no-default-features` (`:492`), and the comment at
`:481-483` gives the reason as the cortexkit sibling stubs. Recorded here because
a reader who assumes a lint gate exists would over-credit this sub-part's static
coverage.

## Claims with no implementing code

Four, from lens B's 20-claim register. One of the four is a deliberate negative
claim and is counted because a later pass would otherwise read it as a missing
feature.

| # | Claim | Source | Status |
| --- | --- | --- | --- |
| 2 | CLI or config-file exposure of these knobs belongs to `magic-context-c50.8`, not this crate | `config.rs:5-6` | **Nothing, and nothing should.** A negative claim; it is what makes doc comments the only contract |
| 9 | `subc_capabilities` is a host-to-handler capability channel | `config.rs:250` (field, undocumented) | **Nothing. Zero readers repo-wide** |
| 11 | Signal acquisition stays outside this crate; `magic-context-c50.4` will map SIGINT/SIGTERM | `runtime.rs:3-5` | **Nothing. No signal mapping exists**; the caller supplies a `CancellationToken` |
| 20, in-crate half | `HarnessClosureStore` is public host API | `lib.rs:18` (`pub mod`, no `#[doc(hidden)]`) | **Never constructed in-crate**; its only two production constructions discard the error |

Two register rows are actively **contradicted** by code rather than merely
unimplemented, and both are catalog findings:

| # | Claim | Source | Contradicted by |
| --- | --- | --- | --- |
| 4 | Every operation owns exactly one deadline; stages within it share the same budget | `config.rs:196-197`, protocol `:731` | `runtime.rs:1223`'s `saturating_mul(2)`, armed after the absolute deadline at `:1148` already expired |
| 13 | Reserved-class pools are zero-permit when no module declares a reservation, and then unreachable because every route is general-class | `runtime.rs:117-119` | `broca/mod.rs:164-177`, which declares `RouteClass::Reserved` with 96/96 counts (`broca/config.rs:185`, `:188`) |
| 17 | Health probes run at `health_interval` | `config.rs:216-217` | `runtime.rs:1130`, a hardcoded 50 ms selected whenever a handler-authored string says `starting` |

Row 15 is a third case of the same kind, and it is contradicted by the same code
as row 4: `HostError::ShutdownDeadlineExpired`'s doc comment
(`runtime.rs:42-44`) says host tasks "could not be reaped within the shutdown
deadline even after aborts", and it is returned on a path that can run roughly
ten times that deadline.

## Documentation describing deleted mechanisms

**None found.** Checked explicitly rather than assumed, because the refactor
deleted five files and 26,606 lines from this crate and prior lens work cited
several of them.

Grepping all five 2f files for `tcp_frame_channel`, `transport_negotiation`,
`transport_provider`, `provider_recovery`, `frame_read`, `shm_provider`,
`negotiate`, `Serveable`, `transport selection`, and `fallback` returns **zero
hits**. `config.rs`'s `transport_setup_deadline` (`:213`) survives and still names
a live mechanism, the mandatory ring setup of protocol Section 7.7. `lib.rs` is
the file most likely to hold a stale reference, since it is the module manifest
the refactor edited, and it is clean: it declares `ring_transport` and
`setup_socket` as `#[doc(hidden)] pub mod` (`:20-21`, `:34-35`) and no longer
names any deleted module, and its `unsafe_code` comment (`:3-7`) describes the
Broca `pre_exec` hook, which exists.

**Two residuals of the opposite shape, recorded so a later pass does not miscount
them as stale.** Both are forward references to unbuilt work rather than
descriptions of removed work:

1. `runtime.rs:3-5` — future production wiring in `magic-context-c50.4` "will map
   SIGINT/SIGTERM, while tests inject deterministic shutdown". No signal handling
   was deleted; none has been written. Register row 11.
2. `config.rs:5-6` — CLI and config-file exposure "belongs to the spawn/doctor
   integration (`magic-context-c50.8`), not this crate." Register row 2, and the
   reason the configuration contract is doc comments.

## Claims stated somewhere and checked mechanically nowhere

Six, each held by discipline rather than by a build step.

1. **Every host timing default is a literal restated in a normative table with no
   parser on either side.** `config.rs:220-232` against protocol `:735-743`.
   Three of the pairs disagree today — shutdown 10 s versus the client's 5 s,
   authentication 2 s against a client 2 s that spans four stages, and transport
   setup 2 s against the same client budget — and the disagreement is invisible to
   every gate in the repository. `frame_deadline` is the control case at 30 s on
   both sides.
2. **`MIN_RESIDENT_BYTES`' three-way composition is a comment plus an
   expression.** `config.rs:17-24` states the reasoning ("one maximum inbound
   body, one maximum encoded outbound frame, and one maximum request-scratch
   reservation must coexist") and `:23-24` sums the three constants. The in-crate
   test at `:520` is the only thing that checks the sum, and it never runs in CI.
   Nothing relates it to the consumer at `runtime.rs:896`.
3. **`SCRATCH_RESERVED_BYTES`' sizing rationale names Synapse limits it cannot
   see.** `config.rs:45-55` sizes the pool for "Synapse's worst parse reservation,
   full queued-batch budget, one admitted maximum query,
   `SYNAPSE_WAITER_HEADROOM_BYTES`, per-item/envelope headroom, and
   `RETAINED_METADATA_RESERVED_BYTES`", and `:63` says `tests/synapse_bundle.rs`
   "pins the resulting feasible boundary". That binary is not named in CI, so the
   coupling between this constant and Synapse's own limits is held by an ungated
   test plus prose.
4. **The 50 ms activation probe interval is a bare literal.** `runtime.rs:1130` is
   `Duration::from_millis(50)` with no named constant and no entry in
   `HostTiming`, so it does not appear in the configuration contract at all.
5. **`HarnessClosureError`'s closed vocabulary is discarded at both production
   call sites.** `harness_closure.rs:162-166` deliberately makes the error a single
   `&'static str` behind one constructor with a `detail()` accessor, which is a
   well-built bounded vocabulary. Both production consumers throw it away:
   `serve.rs:162` and `:349` are each
   `HarnessClosureStore::open(&closure_root).ok()`. A store that fails to open is
   therefore indistinguishable from one that was never configured.
6. **`file_mode::raw_mode`'s platform claim is prose only.** `file_mode.rs:9-15`
   explains that `RawMode` is `u32` on Linux and `u16` on Darwin and that "leaving
   it implicit compiles on Linux and fails on Darwin". The claim is load-bearing
   for a cross-platform build and is verified only by the macOS CI legs compiling
   (`ci.yml:137`'s matrix includes `macos-latest` and `macos-15-intel`), which is
   real coverage but incidental: nothing asserts the mask `0o7777` or the value
   range the comment argues for.

One further unasserted margin, recorded by lens A as an observation rather than
promoted to a record. `config.rs:325` sizes the published connection file using a
**placeholder** socket path, `setup_socket: "/tmp/mc-host.sock"`, 17 bytes, while
the real value is `guard.dir_path().join("setup.sock")` (`runtime.rs:834`),
derived from an operator-settable and unvalidated `data_dir`. It is currently
safe for two independent reasons — `MAX_AUTH_MESSAGE_LEN` is 4,096 and binds long
before `MAX_CONNECTION_FILE_LEN`'s 65,536 (`connection_file.rs:30`), and the
socket path is bounded by `AF_UNIX` `sun_path` at roughly 108 bytes, enforced by
`bind_owner_only` failing — and neither reason is stated at `config.rs:322-332`.
`MAX_CONNECTION_FILE_LEN` is enforced only on the read path
(`connection_file.rs:187-197`), never on the write.

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any check proves.

1. **`harness_closure.rs` is 1,122 lines of untrusted-manifest filesystem code
   with zero in-crate tests.** It validates untrusted manifests
   (`validate_manifest`, `:231`), materializes content-addressed trees through
   `openat`/`renameat_with`/`unlinkat` with explicit modes (`:14-16`), verifies
   file hashes and modes (`verify_node_file`, `:826`; `verify_secure_file`,
   `:859`), checks directory ownership (`verify_owned_directory`, `:919`), and
   prunes a store (`prune`, `:554`). It enforces five hard caps
   (`MAX_MANIFEST_BYTES` 16 MiB, `MAX_NODES` 65,536, `MAX_PATH_BYTES` 4096,
   `MAX_STRING_BYTES` 1024, `:25-28`) and guards against sticky bits and
   non-regular files (`S_IFMT`, `S_IFDIR`, `S_IFREG`, `S_ISVTX`, `:29-32`). None
   of that is exercised by anything CI runs: it has no test module, no doctest,
   and one unnamed test binary. `:400`'s
   `.expect("launch and dependency roots were checked above")` makes a validation
   gap a panic rather than a rejection. **This is the quietest area in either
   sub-part by the margin between consequence and coverage**, and it is
   compounded by the store never being constructed in-crate at all: its two
   production constructions are `serve.rs:162` and `:349`, both `.ok()`. Owned by
   [rt-a-a-closure-store-open-failure-is-classified-not-swallowed](catalog.md#rt-a-a-closure-store-open-failure-is-classified-not-swallowed),
   which is the catalog's only `medium` confidence record precisely because its
   two call sites are outside this footprint.

2. **The configuration contract is proven only by rejection.** `config.rs` is the
   only authority for twenty of the twenty-one keys, because no file in `docs/`
   names any of them except `max_resident_bytes`
   (`docs/mc-host-wire-protocol.md:423`). Its ten tests all prove that validation
   rejects something; none proves that an accepted configuration is then used as
   configured. None of the ten runs in CI. And the file has no doctest even though
   it is `pub mod` (`lib.rs:14`) and `ci.yml:190` would run one. The consequence
   is visible in the catalog: the two fixed-bound findings are both cases where an
   accepted configured value is silently not the value that governs, and neither
   is the kind of defect a rejection test can catch. `HostTiming`'s seven keys are
   validated for zero and overflow at `:341-363` and for nothing else, so
   `shutdown_deadline` is proven nonzero and never proven to bound shutdown. Owned
   by
   [rt-a-no-configured-limit-is-silently-clamped](catalog.md#rt-a-no-configured-limit-is-silently-clamped),
   [rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval](catalog.md#rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval),
   and
   [rt-a-every-published-configuration-field-changes-host-behaviour](catalog.md#rt-a-every-published-configuration-field-changes-host-behaviour).

3. **`shutdown_sequence`'s forced path makes five unbounded or re-armed decisions
   and the sub-part has one shutdown test, about a different deadline.**
   `runtime.rs:1144-1244` calls `force_close_all_routes` twice (`:1206`, `:1216`)
   with no enclosing timeout, re-arms a doubled deadline after the original
   expired (`:1223`), trips the fatal latch on one branch (`:1234`), and runs the
   handler callback on another (`:1240`), returning `false` from three separate
   places. The comments are unusually careful and each argues its own ordering
   correctly. What is quiet is that the *composition* of those stages, which is
   what an operator experiences as "shutdown took a hundred seconds", is argued
   nowhere and tested nowhere. The one in-crate test (`:1326`) covers the shared
   Goodbye deadline, and `tests/lifecycle.rs`, the only CI-named binary that
   reaches this file, tests lifecycle records rather than drain composition. Owned
   by
   [rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline](catalog.md#rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline),
   and it is also where sub-part 2e's unresolved question about un-swept pending
   entries after `force_close_all_routes` has to be answered.

## Sampling limits on this inventory

Stated so a later pass knows what was and was not looked at.

- Test counts are grep counts of attribute lines, not execution counts. The
  in-crate site lists come from lens B, which printed each; this synthesis
  re-derived the `#[cfg(test)]` module boundaries and the file lengths but did not
  re-print all 11 sites.
- CI reach was determined from workflow content only. Whether
  `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`) are
  **required** status checks for merge is repository settings and is not
  verifiable from this tree. That decides whether "unnamed in CI" means ungated or
  merely unexecuted-in-one-job. Carried forward unresolved from
  `../part-2-rescope/scope-map-and-risk-ranking.md:750-752`.
- The four integration binaries were counted and their subjects identified; only
  the `tests/lifecycle.rs` and `tests/handler_contract.rs` sites named by catalog
  records were read. `tests/synapse_bundle.rs`'s 24 tests and
  `tests/ipc_budget_topology.rs`'s 9 were not read, so this inventory establishes
  only their counts, subjects, and CI status.
- `harness_closure.rs` was read for its guard and cap structure, not line by line.
  Its 1,122 lines contain validation logic that a dedicated pass should audit
  against `tests/harness_closure.rs`'s 15 tests; this inventory establishes only
  that no in-crate check exists and that one ungated binary is the whole coverage.
- `serve.rs` was read only far enough to confirm the sole `HostConfig`
  construction (`:582-593`, with `..HostConfig::default()` at `:593` printed and
  confirmed), the `mc_host::run` call (`:632`), the composite build (`:575`), the
  `subc_capabilities` write (`:487`), and the two `HarnessClosureStore::open(..)
  .ok()` sites (`:162`, `:349`). What `harness_backend` (`:344`) reports to an
  operator was not traced, which is the catalog's one `medium` confidence.
- Whether this repository's release profile enables `debug-assertions` was not
  read. It does not bear on this sub-part directly, since the five files contain
  no `debug_assert`, but it does bear on 2e's `dispatch.rs:212`.

## Open questions

- Is a never-executed test `Exercised: partial` or `Exercised: not yet`? It
  governs all 11 in-crate and all 52 integration checks here. The 2b, 2d, and 2e
  inventories record the same question as unresolved, as does the 4e inventory
  across five sub-parts. This synthesis did not decide it silently: the
  `Exercised:` lines in `catalog.md` are inherited verbatim from lens A. (needs
  human input)
- Should `subc_capabilities` be removed or populated? It is public API
  (`config.rs:250`, re-exported through `lib.rs:57`), so removing it is a breaking
  change, and populating it lands in the one unredacted field of a
  redaction-purpose `Debug` impl. (needs human input)
- Is `runtime.rs:1223`'s doubled deadline intended to escape `shutdown_deadline`,
  or should the chain be armed against the original `deadline`? The comment at
  `:1217-1222` justifies waiting out the chain but does not address the budget it
  exceeds, and protocol `:731` states the rule as `MUST NOT`. (needs human input)
- Should the 50 ms activation probe be a named `HostTiming` field with an
  operator-visible bound, and should the fast path be capped in duration or in
  probe count? As written, an untrusted handler string controls host callback
  frequency indefinitely. (needs human input)
- Which of the three host-versus-client deadline divergences are deliberate?
  Protocol `:747` documents the authentication pair as a known coupling with an
  operator remedy; the 10 s versus 5 s shutdown pair is documented nowhere and
  makes a correct graceful shutdown look like a client timeout. (needs human
  input)
- Should `HarnessClosureStore::open`'s error reach a log or a startup failure
  instead of `.ok()` at `serve.rs:162` and `:349`? The error type was built as a
  closed bounded vocabulary specifically to be reportable. (needs human input)
- Is `HarnessClosureStore` intended as public API? `lib.rs:18` exports
  `harness_closure` as a plain `pub mod` with no `#[doc(hidden)]`, unlike
  `ring_transport` (`:20-21`) and `setup_socket` (`:34-35`), yet nothing in
  `mc-host/src/` constructs the store and both real constructions live in
  `mc-module`. (needs human input)
- Does the sub-part boundary in
  `../part-2-rescope/scope-map-and-risk-ranking.md:643` intend for the two
  `serve.rs` closure-store call sites to be cataloged here, or left to an
  `mc-module` binary pass that is not currently scheduled? As written, nobody owns
  them. (needs human input)
- Is any 32-bit target supported? `config.rs:185`'s ceiling is
  `min(Semaphore::MAX_PERMITS, u32::MAX)`, and `Semaphore::MAX_PERMITS` =
  536,870,911 binds on a 32-bit target, so a 32-bit deployment declaring more than
  about 144 MiB of retained bytes fails startup at `runtime.rs:736`. Nothing
  documents that the ceiling is target-dependent. If no 32-bit target is
  supported, the `min` and its comment at `:181-184` are dead and could say so.
  (unresolved, no target list found)
