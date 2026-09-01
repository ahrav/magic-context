# Sub-part 2f lens B: claims and checks

Attention focus: what the runtime and configuration surface *claims* about
itself, and what mechanically holds those claims. Claim sources are doc
comments in `runtime.rs` (1,344 lines), `harness_closure.rs` (1,122),
`config.rs` (674), `lib.rs` (87), and `file_mode.rs` (19); the error string
vocabulary those files mint; and any `docs/` file describing host
configuration.

Provenance: code read from `/local/home/ahrav/scratch/magic-context`, `HEAD` =
`e447c927`, branch `feat/shared-memory-release-gate-audit`. Every line
reference below was printed at that commit before being written. Method
contract in [../../METHOD.md](../../METHOD.md).

**The finding that frames this whole file, and it was verified rather than
inherited: there is no configuration reference document.** The sibling lens
reported it and this pass confirmed it by search. Every one of the seventeen
configurable keys (`HostLimits`' seven, `HostTiming`' seven, `LivenessPolicy`'
three) was grepped across `docs/`. The results:

- **`max_resident_bytes` is the only key any non-catalog `docs/` file names**,
  at `docs/mc-host-wire-protocol.md:423`, and there only to say that the cap
  covers Synapse parse scratch as a named logical payload.
- Every other hit is inside `docs/properties/`, which is this catalog's own
  working material and is not a contract.
- `docs/perf/mc-host-baseline.md:36-38` restates a handful of default *values*
  as a description of one perf run, and `:48` explicitly tells a reader to
  "record the current `HostConfig::default()` rather than copying that old
  value". It is a self-dating snapshot, not a specification.

So the doc comments in `config.rs` are the entire configuration contract, which
raises their evidentiary weight and makes each contradiction below a
contradiction with the only available authority. `config.rs:5-6` states why:
"CLI or config-file exposure of these knobs belongs to the spawn/doctor
integration (`magic-context-c50.8`), not this crate."

METHOD rule 3 still governs. A documented guarantee is a claim under test.

## Claims register

Twenty claims, capped by consequence. `Held by` names the mechanism that
actually enforces the claim, or records that none does.

| # | Claim | Source | Held by |
| --- | --- | --- | --- |
| 1 | Every capacity in the host is bounded by a value in `config.rs`; defaults are production-plausible | `config.rs:3-4` | `HostLimits::validate` (`:147`) and `HostConfig::validate` (`:300`) |
| 2 | CLI or config-file exposure of these knobs belongs to `magic-context-c50.8`, not this crate | `config.rs:5-6` | **Nothing, and nothing should.** A negative claim; recorded because it is what makes doc comments the only contract |
| 3 | All limits are independent gates: exhausting one class never consumes another | `config.rs:87-88` | Separate `Semaphore`s and `ByteBudget`s (`runtime.rs:108-123`); `config.rs:520` in-crate test covers the byte pools only |
| 4 | Every operation owns exactly one deadline; stages within it share the same budget | `config.rs:196-197`, protocol `:731` | **Contradicted at `runtime.rs:1223`.** See L3 |
| 5 | `max_resident_bytes` splits into three non-overlapping pools and is an accounting cap over named payloads, not a process-RSS claim | `config.rs:103-120` | `MIN_RESIDENT_BYTES` (`:23-24`), `validate` (`:175-191`), test `:520`. Named in protocol `:423` |
| 6 | Zero and unbounded durations are rejected at validation because `Instant + Duration` panics on overflow | `config.rs:76-81` | The seven-key loop at `:341-363` and the liveness pair at `:364-377`; tests `:636`, `:646` |
| 7 | `HostInit::storage` is opaque; the handler deserializes it and the host never reads it | `config.rs:251-253` | `serde_json::Value` passed through untouched |
| 8 | `HostInit`'s `Debug` reports presence and bounded structure only, because the storage descriptor can carry credentials (V24) | `config.rs:258-260` | Partial. `storage` renders as `.is_some()` (`:263`); **`subc_capabilities` renders in full** (`:262`) |
| 9 | `subc_capabilities` is a host-to-handler capability channel | `config.rs:250` (field, undocumented) | **Nothing. Zero readers repo-wide.** See L1 |
| 10 | `invalidate_on_missed` stays `false` until the raw Rust historian client can answer Ping; enabling it earlier would kill healthy long-running awaits | `config.rs:236-238` | `HostConfig::default()` sets `liveness: None` (`:294`), which sends no Pings at all. No check pins the flag |
| 11 | Signal acquisition stays outside this crate; `magic-context-c50.4` will map SIGINT/SIGTERM | `runtime.rs:3-5` | **Nothing. No signal mapping exists**; the caller supplies a `CancellationToken` |
| 12 | `ingress_budget` is the only budget with a blocking consumer, so nothing outliving a request may draw on it | `runtime.rs:106-107` | The `scratch_budget` split (`:109-111`) and `config.rs:36-43`'s rationale. Structural, no check |
| 13 | Reserved-class pools are zero-permit when no module declares a reservation, and then unreachable because every route is general-class | `runtime.rs:117-119` | **Contradicted by `broca/mod.rs:164-177`.** See L2 |
| 14 | The handler shutdown callback runs at most once per incarnation even when a `run` future is dropped mid-sequence | `runtime.rs:126-129`, `handler.rs:597` | `shutdown_callback_ran.swap(true, SeqCst)` (`:1265-1270`) |
| 15 | `ShutdownDeadlineExpired` means host tasks could not be reaped within the shutdown deadline even after aborts | `runtime.rs:42-44` | Returned on a path that can run roughly ten times that deadline. See L3 |
| 16 | The health report is informational; degraded storage must not make transport unready | `runtime.rs:1115-1116` | `Ok(None)`/`Err(_)` both `return` without unreadying (`:1126-1127`) |
| 17 | Health probes run at `health_interval` | `config.rs:216-217` | **Replaced by a hardcoded 50 ms whenever a handler-authored string says `starting`.** See L4 |
| 18 | A closure is immutable and content-addressed; its canonical manifest commits every launch root, dependency edge, extension position, source identity, file mode, size, and hash | `harness_closure.rs:3-5` | `validate_manifest` (`:231`), `manifest_digest` (`:187`), `canonical_manifest` (`:196`) |
| 19 | `HarnessClosureError` is a closed failure vocabulary carrying only a `&'static str` | `harness_closure.rs:162-166` | `detail: &'static str` and the single `invalid()` constructor (`:182-184`). Bounded by construction |
| 20 | `HarnessClosureStore` is public host API | `lib.rs:18` (`pub mod`, no `#[doc(hidden)]`) | **Never constructed in-crate**; its only two production constructions discard the error. See L5 |

**Claims with no implementing code: 4** (numbers 2, 9, 11, and 20's in-crate
half). Number 2 is a deliberate negative claim and is counted because a later
pass will otherwise read it as a missing feature; the other three are gaps.

## Contract-vs-code leads

Five, each verified at `HEAD` and ordered by consequence.

### L1. `HostInit::subc_capabilities` is inert, and it is the one field the redaction impl does not redact

`config.rs:250` declares `pub subc_capabilities: Vec<String>` with no doc
comment. A repo-wide search returns **six** occurrences and nothing else:

| Site | Role |
| --- | --- |
| `crates/mc-host/src/config.rs:250` | the declaration |
| `crates/mc-host/src/config.rs:262` | the `Debug` render |
| `crates/mc-module/src/bin/ck_mc_host/serve.rs:487` | write, `Vec::new()` |
| `crates/mc-module/examples/direct_host_fixture.rs:577` | write, `Vec::new()` |
| `crates/mc-module/tests/host_adapter.rs:29` | write, `Vec::new()` |
| `crates/mc-module/tests/host_adapter.rs:88` | write, `Vec::new()` |

So there are **zero readers anywhere in the repository**, all four writes are
empty, and `HostInit::default()` (`:248`, derived) also yields empty. One of
the four writes is production (`serve.rs:487`); the other three are a test and
an example. The field crosses the host-to-handler boundary that
`handler.rs:573`'s `initialize(&self, init: HostInit)` defines, and no
implementation of that method reads it.

The sharp part is the interaction with claim 8. `HostInit`'s hand-written
`Debug` exists specifically to redact: the comment at `:258-260` says the
storage descriptor "can carry credentials or deployment secrets" so diagnostics
get "presence and bounded structure only", and `:263` accordingly renders
`storage` as `.is_some()`. Directly above it, `:262` renders
`subc_capabilities` **in full**:

```
.field("subc_capabilities", &self.subc_capabilities)
```

Today that prints `[]` and leaks nothing. It is the only unbounded field in a
struct whose `Debug` was written to bound its fields, and `HostConfig` derives
`Debug` (`:268`) so the render reaches any diagnostic that formats a
`HostConfig`. An inert field is a low-consequence finding; an inert field that
is also the single hole in a redaction impl is worth a record, because the first
population of it lands on the wrong side of V24 by default.

### L2. A reserved-pool comment is contradicted by the only in-tree declarer

`runtime.rs:117-119`:

```
/// Reserved-class admission pools, sized by the checked declaration sums
/// (plan KTD2). Zero-permit when no module declared a reservation, and
/// then unreachable because every route is general-class.
```

Broca declares a reservation. `broca/mod.rs:164-177` returns:

```
ResourceDeclaration {
    reserved_handler_tasks: config::RESERVED_HANDLER_TASKS,
    reserved_pending_requests: config::RESERVED_PENDING_REQUESTS,
    retained_resident_bytes: config::DECLARED_RETAINED_RESIDENT_BYTES,
    general_task_hold_bound: 0,
    route_class: RouteClass::Reserved,
}
```

with `RESERVED_PENDING_REQUESTS = 96` (`broca/config.rs:185`) and
`RESERVED_HANDLER_TASKS = 96` (`:188`). The comment at
`broca/mod.rs:169-170` makes it deliberate and unconditional: "Constants rather
than limits so a test-shrunken supervisor still declares the product contract."

So in the composed host the reserved pools hold 96 permits each and every
Broca route dispatches against them. The comment's second clause is false, and
its first clause ("zero-permit when no module declared a reservation") is true
only of a composition that does not include Broca, which the direct profile
always does (`composite.rs:10-13` fixes the tertiary as
`broca/management_surface`).

Consequence: `reserved_pending_permits` and `reserved_task_permits`
(`runtime.rs:120-121`) are `default-production` reachable, not dormant. Any
record that inherits the comment's reachability claim would be mislabelled
under METHOD rule 4.

The sibling lens reports this as the fourth misleading comment in this crate.
This pass verified the contradiction directly and did **not** verify the three
prior instances, so the ordinal is inherited and unconfirmed.

### L3. The forced shutdown path multiplies the deadline the protocol forbids multiplying

Protocol `:731` opens Section 11 with the rule: "Every operation owns one
absolute deadline; per-stage timers MUST NOT multiply it." `config.rs:196-197`
restates it for this struct.

`runtime.rs:1223` multiplies it:

```
let lifecycle_chain = shared.timing.lifecycle_callback_deadline.saturating_mul(2);
```

and arms it at `:1224` with a fresh `timeout(...)`, not a `timeout_at(deadline,
...)`. Crucially this happens **after** the shutdown deadline has already
expired: `deadline` is computed once at `:1148` as `Instant::now() +
shutdown_deadline`, the drain at `:1200` consumes it, and the `timeout_at` at
`:1214` is entered only when the deadline is already in the past.

Composing the stages with defaults (`shutdown_deadline` 10 s at
`config.rs:228`, `lifecycle_callback_deadline` 30 s at `:225`):

| Stage | Site | Bound |
| --- | --- | --- |
| Graceful drain | `:1200` | 10 s (`shutdown_deadline`) |
| `abort_all` + `force_close_all_routes` | `:1205-1206` | **unbounded by `deadline`**; internally 30 s (`dispatch.rs:1434`) then 30 s in `run_route_gone` |
| `timeout_at(deadline, tracker.wait())` | `:1214` | ~0, deadline already passed |
| `abort_all` + `force_close_all_routes` again | `:1215-1216` | same shape as above |
| Doubled lifecycle chain | `:1223-1224` | 60 s |
| `run_handler_shutdown` | `:1240` | 30 s (`:1276`) |

**Floor: about 100 seconds for a configured 10, counting only the drain, the
doubled chain, and the handler callback.** Counting one of the two
`force_close_all_routes` calls, which no timeout wraps, it reaches roughly 160
seconds. The sibling's "about 100 seconds" is therefore the conservative
reading, and this pass records it as a floor rather than an estimate.

Two secondary consequences. `HostError::ShutdownDeadlineExpired`'s own doc
comment (`runtime.rs:42-44`) says "Host tasks could not be reaped within the
shutdown deadline even after aborts", which is returned after roughly ten times
that deadline, so claim 15 is contradicted by the same code. And the client
gives up long before: `CLIENT_SHUTDOWN_TIMEOUT` is 5 s (`client.rs:51`,
protocol `:741`).

The comments at `:1217-1222` and `:1228-1233` argue the trade explicitly and
well: releasing the instance fence while a lifecycle callback still owns the
handler would let a successor start against the predecessor's in-flight
cleanup, and the doctrine prefers the fatal latch over overlap. The finding is
not that the choice is wrong. It is that the choice is unbounded by the knob
the operator was told bounds it, and the normative rule it breaks is stated as
`MUST NOT`.

### L4. A handler-authored string sets the host's health probe rate, without bound

`runtime.rs:1129-1133`:

```
let interval = if activation_in_progress {
    Duration::from_millis(50)
} else {
    shared.timing.health_interval
};
```

`activation_in_progress` (`:1051-1071`) walks the report's own metrics and
returns true when any component's `metrics.storage_state` or
`metrics.synapse_state` equals the string `"starting"`.

That report is handler output. `McHostHandler::health` returns a `HealthReport`
(`handler.rs:591`) whose `metrics` field is `Option<serde_json::Value>`
(`:194`), entirely handler-authored. So a handler that reports
`storage_state: "starting"` moves the host from its configured
`health_interval` (30 s by default, `config.rs:229`) to a hardcoded 50 ms, a
600-fold increase, and it does so for as long as it keeps reporting that
string. Nothing caps the duration, counts the fast probes, or re-reads the
configured value while the fast path is active.

Two aggravating details. The 50 ms is a bare literal, not a named constant, so
it is invisible to anyone reading `HostTiming`. And each probe invokes the
handler's `health` callback under `lifecycle_join` (`:1117`), where an overrun
is host-fatal (`handler.rs:554-556`) — so the fast path both raises callback
frequency by 600x and keeps every invocation on a fatal-if-slow path.

The design intent is legible: fast polling during activation is how the host
notices storage becoming ready promptly, and protocol `:596` requires the host
to stay usable while storage opens. The gap is that the trigger is untrusted
input from the component being probed, and the configured knob is silently
overridden rather than clamped.

### L5. Three host timing keys sit beside contradicting client defaults

The two sides are independent literals with no cross-check. `config.rs`'s
`HostTiming` defaults (`:220-232`) against `client.rs`'s constants
(`:43-51`) and the normative table at protocol `:735-743`.

| Domain | Host default | Client default | Verdict |
| --- | --- | --- | --- |
| Shutdown | `shutdown_deadline` 10 s (`config.rs:228`) | `CLIENT_SHUTDOWN_TIMEOUT` 5 s (`client.rs:51`, protocol `:741`) | **Worst.** The client abandons its close at 5 s while the host is still legitimately draining to 10 s, so a correct graceful shutdown presents to the client as a timeout |
| Authentication | `auth_deadline` 2 s (`:223`) | `CLIENT_HANDSHAKE_TIMEOUT` 2 s (`client.rs:43`), which spans discovery, authentication, descriptor transfer, and ring attach | The host's authentication **stage alone** can consume the client's whole budget. Protocol `:747` names this: the two values "are not independent" and a deployment needing the full host window "MUST raise the client handshake deadline above it" |
| Transport setup | `transport_setup_deadline` 2 s (`:227`) | the same 2 s client handshake | A **second** host stage individually equal to the client's entire budget. Host-side worst case across both stages is 4 s against a 2 s client budget |

`frame_deadline` is the control case: 30 s on both sides (`config.rs:224`,
`client.rs:45`), and it is the one domain where the two defaults are
consistent, which shows the divergences above are not a systematic offset.

Protocol `:747` is the only place any of this is written down, it covers only
the authentication pair, and it states the remedy as an operator obligation
rather than a validated constraint. `HostConfig::validate` (`:300-379`) checks
each duration for zero and for `MAX_CONFIG_DURATION` and never compares a host
key against a client key.

## Documentation describing deleted mechanisms

**None found.** Checked explicitly rather than assumed, because the refactor
deleted five files and 26,606 lines from this crate and prior lens work cited
several of them.

Grepping all five 2f files (`runtime.rs`, `harness_closure.rs`, `config.rs`,
`lib.rs`, `file_mode.rs`) for `tcp_frame_channel`, `transport_negotiation`,
`transport_provider`, `provider_recovery`, `frame_read`, `shm_provider`,
`negotiate`, `Serveable`, `transport selection`, and `fallback` returns **zero
hits**. `config.rs`'s `transport_setup_deadline` (`:213`) survives and still
names a live mechanism: the mandatory ring setup of protocol Section 7.7.

`lib.rs` is the file most likely to hold a stale reference, since it is the
module manifest the refactor edited, and it is clean. It declares
`ring_transport` and `setup_socket` as `#[doc(hidden)] pub mod` (`:20-21`,
`:34-35`) and no longer names any deleted module. Its `unsafe_code` comment
(`:3-7`) describes the Broca `pre_exec` hook, which exists.

**Two residuals of the opposite shape, recorded so a later pass does not
miscount them as stale.** Both are forward references to unbuilt work, not
descriptions of removed work:

1. `runtime.rs:3-5` — "future production wiring in `magic-context-c50.4` will
   map SIGINT/SIGTERM, while tests inject deterministic shutdown." No signal
   handling was deleted; none has been written. Register row 11.
2. `config.rs:5-6` — CLI and config-file exposure "belongs to the spawn/doctor
   integration (`magic-context-c50.8`), not this crate." Register row 2, and
   the reason the configuration contract is doc comments.

## Conventionally-enforced-only claims

Six, each stated somewhere and checked by no build step.

1. **Every host timing default is a literal restated in a normative table with
   no parser on either side.** `config.rs:220-232` against protocol `:735-743`.
   Three of the pairs disagree today (L5), and the disagreement is invisible to
   every gate in the repository.

2. **`MIN_RESIDENT_BYTES`' three-way composition is a comment plus an
   expression.** `config.rs:17-24` states the reasoning ("one maximum inbound
   body, one maximum encoded outbound frame, and one maximum request-scratch
   reservation must coexist") and `:23-24` sums the three constants. The
   in-crate test at `:520`
   (`the_resident_cap_splits_into_three_non_overlapping_pools`) is the only
   thing that checks the sum, and it never runs in CI.

3. **`SCRATCH_RESERVED_BYTES`' sizing rationale names Synapse limits it cannot
   see.** `config.rs:45-55` sizes the pool for "Synapse's worst parse
   reservation, full queued-batch budget, one admitted maximum query,
   `SYNAPSE_WAITER_HEADROOM_BYTES`, per-item/envelope headroom, and
   `RETAINED_METADATA_RESERVED_BYTES`", and `:63` says
   `tests/synapse_bundle.rs` "pins the resulting feasible boundary". That
   binary is not named in CI, so the coupling between this constant and
   Synapse's own limits is held by an ungated test plus prose.

4. **The 50 ms activation probe interval is a bare literal.** `runtime.rs:1130`
   is `Duration::from_millis(50)` with no named constant and no entry in
   `HostTiming`, so it does not appear in the configuration contract at all.
   See L4.

5. **`HarnessClosureError`'s closed vocabulary is discarded at both production
   call sites.** `harness_closure.rs:162-166` deliberately makes the error a
   single `&'static str` behind one constructor (`invalid()`, `:182-184`) with a
   `detail()` accessor (`:169`), which is a well-built bounded vocabulary. Both
   production consumers throw it away: `serve.rs:162` and `:349` are each
   `HarnessClosureStore::open(&closure_root).ok()`. A store that fails to open
   is therefore indistinguishable from one that was never configured.

6. **`file_mode::raw_mode`'s platform claim is prose only.** `file_mode.rs:9-15`
   explains that `RawMode` is `u32` on Linux and `u16` on Darwin and that
   "leaving it implicit compiles on Linux and fails on Darwin". The claim is
   load-bearing for a cross-platform build and is verified only by the macOS CI
   legs compiling (`ci.yml:137` matrix includes `macos-latest` and
   `macos-15-intel`), which is real coverage but incidental: nothing asserts the
   mask `0o7777` or the value range the comment argues for.

## Existing-check inventory

**Every status below is `unaudited`.** An existing check never removes a
property from the catalog. Test adequacy belongs to
`/testing:invariant-test-review`; production guard adequacy belongs to
`/low-level-systems:defensive-assertions-and-invariant-guards`.

The framing fact: **11 in-crate tests reach 3,246 lines, none of them runs in
CI, and there are zero doctests.** This is the weakest source-resident position
of the three sub-parts. 2e owns four CI-executed `compile_fail` doctests and 2b
owns two; 2f owns none.

### In-crate tests

**11 tests across two of the five files. None runs in CI.**

| File | Test module | Production | Tests | Sites | CI |
| --- | --- | --- | --- | --- | --- |
| `config.rs` | `:463-674` | `1-462` | **10** | `:467`, `:472`, `:502`, `:520`, `:550`, `:564`, `:576`, `:603`, `:636`, `:646` | **No** |
| `runtime.rs` | `:1299-1344` | `1-1298` | **1** | `:1326` | **No** |
| `harness_closure.rs` | none | all 1,122 | **0** | | n/a |
| `lib.rs` | none | all 87 | **0** | | n/a |
| `file_mode.rs` | none | all 19 | **0** | | n/a |
| **Total** | | | **11** | | **0 in CI** |

Clustered by subject, all ten `config.rs` tests are validation-boundary tests
and the single `runtime.rs` test is a shutdown-deadline test:

| Cluster | Tests | Sites |
| --- | --- | --- |
| Limit and byte-budget bounds | **5** | `:502` `zero_limits_rejected`, `:520` `the_resident_cap_splits_into_three_non_overlapping_pools`, `:550` `byte_budget_below_interop_minimum_rejected`, `:564` `oversize_byte_budget_rejected`, `:576` `constructor_capacity_bounds_are_validated` |
| Duration bounds | **2** | `:636` `zero_durations_rejected`, `:646` `overflowing_durations_rejected` |
| Identity and digest validation | **2** | `:472` `noncanonical_payload_digests_are_rejected`, `:603` `daemon_version_boundary_keeps_auth_and_discovery_readable` |
| Defaults are self-consistent | **1** | `:467` `defaults_validate` |
| Shared shutdown Goodbye deadline | **1** | `runtime.rs:1326` `stalled_generations_share_one_shutdown_goodbye_deadline` |

Two observations follow from that table. First, `config.rs`'s ten tests all
prove that validation **rejects** something; none proves that an accepted
configuration is then **used** as configured, which is exactly the class L3 and
L4 fall into. Second, `runtime.rs:1326` is the only in-crate test in the
sub-part that exercises the shutdown sequence, and its subject is the Goodbye
deadline, not the drain composition at `:1200-1243`.

The reason none of the 11 runs in CI is structural, and this pass re-derived it.
Every `-p mc-host` test invocation in `ci.yml` carries a `--test <name>` filter,
which selects one integration binary and never builds the lib target: `:132`,
`:133`, `:134-135`, `:178-179`, `:187`. The remaining `mc-host` hits are `:87`,
`:168-169`, `:190`, `:211`, `:361`, `:442`, `:461`, and none is an unfiltered
`cargo nextest run -p mc-host` or a `--lib` run.

**`#[ignore]`, `should_panic`, `loom`, `shuttle`, `miri`, `proptest`,
`quickcheck`, `arbitrary`: none found** in any of the five files. No coverage
instrumentation, so every placement statement here is structural.

### Integration tests

**Four of the 24 binaries carry this sub-part's claims, and CI names none of
them.**

| Binary | Tests | Lines | Subject | CI status |
| --- | --- | --- | --- | --- |
| `tests/synapse_bundle.rs` | 24 | 936 | limit feasibility, named by `config.rs:63` | **unnamed** |
| `tests/harness_closure.rs` | 15 | 647 | the only exercise of `HarnessClosureStore` | **unnamed** |
| `tests/ipc_budget_topology.rs` | 9 | 296 | byte-pool separation | **unnamed** |
| `tests/activation.rs` | 4 | 412 | the activation path L4 depends on | **unnamed** |
| **Total** | **52** | 2,291 | | **0 named** |

The four binaries CI does name are `client` (`ci.yml:132`, `:179`, `:187`),
`lifecycle` (`:179`, `:187`), `shm_failure_modes` (`:133`), and `shm_soak`
(`:134-135`, one test by `--exact`). So **4 of 24 named, 20 unnamed**.

`tests/lifecycle.rs` (35 tests, 1,846 lines) is CI-named and does reach
`runtime.rs` transitively, since `run` (`runtime.rs:78` via `lib.rs:78`) is how
any host starts. It is Part 2a scope and its subject is lifecycle records and
publication, not the configuration contract. Recorded so a later pass does not
credit it as coverage for this sub-part's claims, and does not overlook that it
is the one CI-executed path that touches this file at all.

`tests/harness_closure.rs` deserves separate emphasis. It is the **only**
place in the repository that constructs a `HarnessClosureStore` for test
purposes, at 11 sites (`:159`, `:182`, `:253`, `:277`, `:325`, `:414`, `:447`,
`:462`, `:477`, `:497`, plus `tests/broca_subprocess.rs:853`), each with
`.expect("store")`. So a 1,122-line module with zero in-crate tests and zero
doctests has exactly one test binary, and CI does not run it.

### Doctests

**None found.** `runtime.rs`, `harness_closure.rs`, `config.rs`, `lib.rs`, and
`file_mode.rs` contain **zero** doc fences of any kind. Verified by grepping
every ` ``` ` occurrence under `crates/mc-host/src/` and attributing each: the
crate's only fences are four `compile_fail` in `handler.rs` (2e), two
`compile_fail` in `frame_channel.rs` (2b), and two `text` fences that are not
compiled (`wire.rs:4-14`, `generation.rs:6-11`).

This matters because `ci.yml:190` runs `cargo test -p mc-host --doc` under the
step name "Rust lease non-escape", and `handler.rs`, `harness_closure.rs`, and
`config.rs` are all `pub mod` (`lib.rs:14`, `:17`, `:18`), so a doctest added to
any 2f file would execute in CI. **The doctest step is the one CI lane this
sub-part could reach today and does not use.** For a sub-part whose entire
contract is doc comments, that is the single largest structural gap in this
inventory.

### Production assertions and guards

Enforcement here is by returned `Result` and typed error. Counts were derived
by extracting each file's production half and grepping it, so no test-module hit
is included.

**`.expect(`: 18, in four clusters.**

| Cluster | Sites | Labels |
| --- | --- | --- |
| Startup and abandon cleanup guards | 7 | `runtime.rs:348`, `:359`, `:361`, `:369`, `:370`, `:385` — `"armed startup cleanup"` / `"started startup cleanup"`; `:409`, `:415` — `"armed abandon guard"` |
| Mutex and lock invariants | 6 | `runtime.rs:79`, `:88` `"fatal lock"`; `:152`, `:215` `"abort lock"`; `:428`, `:1179` `"connections lock"` |
| Infallible serialization | 2 | `config.rs:320` `"fixed auth shape serializes"`, `:331` `"fixed publication shape serializes"` |
| Validated-above contracts | 2 | `harness_closure.rs:218` `"key was collected from this object"`, `:400` `"launch and dependency roots were checked above"` |

The startup-cleanup cluster is the load-bearing one and the least
characterised. Seven `.expect` sites across `:348-415` all assert that a
cleanup guard is in the state a prior step armed it into, which is a
seven-site sequencing contract with no test and no shared helper.
`harness_closure.rs:400` is the sharpest single label: it asserts that
`validate_manifest` already checked the roots, so a validation path that admits
an unchecked root converts a typed `HarnessClosureError` into a panic.

`runtime.rs:1120-1123` is the counter-example worth recording: the health
snapshot write uses `unwrap_or_else(std::sync::PoisonError::into_inner)` rather
than `.expect`, so poisoning is recovered there and propagated at the six lock
sites above. The file mixes both policies with no comment on which applies
where.

**`panic!`, `todo!`, `unimplemented!`, `unreachable!`, `assert!`,
`assert_eq!`, `debug_assert!`, `.unwrap()`, `catch_unwind`: none found** in the
production half of any of the five files. Enforcement is entirely
`Result`-based, and the one panic boundary the sub-part relies on lives in
`panic_boundary.rs` (Part 2a scope), reached through
`crate::panic_boundary::redact` at `runtime.rs:1273-1274`.

**`let _ =` discarded results: 7, in three clusters.**

| What is discarded | Sites |
| --- | --- |
| Awaited task and shutdown futures | `runtime.rs:302`, `:362`, `:388` |
| Startup cleanup call | `runtime.rs:847` |
| Filesystem teardown | `runtime.rs:935` (`std::fs::remove_file(setup_socket)`), `harness_closure.rs` 2 sites |

`runtime.rs:935` is the consequential one: the setup socket's removal is
best-effort with no local record, and a stale socket file is what a successor
incarnation would have to reconcile.

**Checked and saturating arithmetic: 9.** `checked_` four times and
`saturating_` three times in `runtime.rs`, `checked_` twice in
`harness_closure.rs`. `runtime.rs:1223`'s `saturating_mul(2)` is one of the
three, and it is the only one where the saturation is not the point: the
multiplication itself is the finding (L3).

**Explicit "none found".** No fuzz target reaches any of the five files;
`shm-hardening-optin.yml:78` runs `cargo +nightly fuzz run` but names no
`mc-host` target. No benchmark asserts a behavioural claim here. No snapshot or
golden fixture. No differential harness. No coverage instrumentation. **Clippy
does not run in CI for any crate, by choice**: the `check-rust` job
(`ci.yml:463`) runs only `cargo fmt --check` (`:485`) and
`cargo check -p mc-core --no-default-features` (`:492`), and the comment at
`:481-483` gives the reason as the cortexkit sibling stubs.

## Suspiciously quiet areas

Three, ranked by the gap between what the code decides and what any check
proves.

1. **`harness_closure.rs` is 1,122 lines of security-relevant filesystem code
   with zero in-crate tests, zero doctests, and one ungated test binary.** It
   validates untrusted manifests (`validate_manifest`, `:231`), materializes
   content-addressed trees through `openat`/`renameat_with`/`unlinkat` with
   explicit modes (`:14-16`), verifies file hashes and modes
   (`verify_node_file`, `:826`; `verify_secure_file`, `:859`), checks directory
   ownership (`verify_owned_directory`, `:919`), and prunes a store
   (`prune`, `:554`). It enforces five hard caps
   (`MAX_MANIFEST_BYTES` 16 MiB, `MAX_NODES` 65,536, `MAX_PATH_BYTES` 4096,
   `MAX_STRING_BYTES` 1024, `:25-28`) and guards against sticky bits and
   non-regular files (`S_IFMT`, `S_IFDIR`, `S_IFREG`, `S_ISVTX`, `:29-32`).
   None of that is exercised by anything CI runs. `tests/harness_closure.rs`
   (15 tests) is unnamed, and `harness_closure.rs:400`'s `.expect` makes a
   validation gap a panic rather than a rejection. This is the quietest area in
   either sub-part by the margin between consequence and coverage.

2. **The whole configuration contract is doc comments, and the one CI lane that
   could execute a claim about them is unused.** `config.rs` is the only
   authority for sixteen of the seventeen keys, its ten tests all prove
   rejection rather than use, none of the ten runs in CI, and the file has no
   doctest even though it is `pub mod` (`lib.rs:14`) and `ci.yml:190` would run
   one. The consequence is visible in this lens: L3 and L4 are both cases where
   an accepted configured value is silently not the value that governs, and
   neither is the kind of defect a rejection test can catch. `HostTiming`'s
   seven keys are validated for zero and overflow at `:341-363` and for nothing
   else, so `shutdown_deadline` is proven nonzero and never proven to bound
   shutdown.

3. **`shutdown_sequence`'s forced path makes five unbounded or re-armed
   decisions and the sub-part has one shutdown test, about a different
   deadline.** `runtime.rs:1144-1244` calls `force_close_all_routes` twice
   (`:1206`, `:1216`) with no enclosing timeout, re-arms a doubled deadline
   after the original expired (`:1223`), trips the fatal latch on one branch
   (`:1234`), and runs the handler callback on another (`:1240`), returning
   `false` from three separate places. The comments are unusually careful and
   each argues its ordering correctly. What is quiet is that the composition of
   those stages, which is what an operator experiences as "shutdown took a
   hundred seconds", is argued nowhere and tested nowhere. The one in-crate test
   (`:1326`) covers the shared Goodbye deadline, and `tests/lifecycle.rs`, the
   only CI-named binary that reaches this file, tests lifecycle records rather
   than drain composition.

## Open questions

- Should `subc_capabilities` be removed or populated? It is public API
  (`config.rs:250`, re-exported through `lib.rs:57`), so removing it is a
  breaking change, and populating it lands in the one unredacted field of a
  redaction-purpose `Debug` impl. Either direction is a design decision.
  (needs human input)
- Is `runtime.rs:1223`'s doubled deadline intended to escape `shutdown_deadline`,
  or should the chain be armed against the original `deadline`? The comment at
  `:1217-1222` justifies waiting out the chain but does not address the budget
  it exceeds, and protocol `:731` states the rule as `MUST NOT`.
  (needs human input)
- Should the 50 ms activation probe be a named `HostTiming` field with an
  operator-visible bound, and should the fast path be capped in duration or in
  probe count? As written, an untrusted handler string controls host callback
  frequency indefinitely. (needs human input)
- Which of the three host-versus-client deadline divergences are deliberate?
  Protocol `:747` documents the authentication pair as a known coupling with an
  operator remedy; the 10 s versus 5 s shutdown pair is documented nowhere and
  makes a correct graceful shutdown look like a client timeout.
  (needs human input)
- Should `HarnessClosureStore::open`'s error reach a log or a startup failure
  instead of `.ok()` at `serve.rs:162` and `:349`? The error type was built as a
  closed bounded vocabulary specifically to be reportable.
  (needs human input)
- Is `HarnessClosureStore` intended as public API? `lib.rs:18` exports
  `harness_closure` as a plain `pub mod` with no `#[doc(hidden)]`, unlike
  `ring_transport` (`:20-21`) and `setup_socket` (`:34-35`), yet nothing in
  `mc-host/src/` constructs the store and both real constructions live in
  `mc-module`. (needs human input)
- Are `shm-crash-recovery` (`ci.yml:111`) and `shm-source-build` (`:137`)
  required status checks for merge? It decides whether "unnamed in CI" means
  ungated or merely unexecuted-in-one-job. Unverifiable from workflow content;
  carried forward from
  [../../part-2-rescope/scope-map-and-risk-ranking.md:750-752](../../part-2-rescope/scope-map-and-risk-ranking.md).
  (unresolved, needs repository settings)
