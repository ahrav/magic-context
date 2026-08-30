# Sub-part 2f property catalog: runtime assembly and the configuration contract

Scope: what is constructed, in what order, with what defaults, and what a
misconfiguration does. Five files, 3,246 lines, all re-derived with `wc -l` at
`HEAD`: `crates/mc-host/src/runtime.rs` (1,344), `harness_closure.rs` (1,122),
`config.rs` (674), `lib.rs` (87), `file_mode.rs` (19).

Production and test halves: `runtime.rs` production is `1-1298` with a 46-line
test module at `1299-1344`; `config.rs` production is `1-462` with its tests at
`463-674`. `harness_closure.rs`, `lib.rs`, and `file_mode.rs` have **no test
module at all**, which for a 1,122-line security-relevant filesystem module is a
finding in its own right and is carried in
[existing-checks.md](existing-checks.md).

Boundary context, read but not mined: `connection.rs` is Part 2a's file and is
cited only as the consumer of four configured deadlines (`:125`, `:145`, `:158`,
`:177`, `:279`). `dispatch.rs`, `routing.rs`, and `handler.rs` are sub-part 2e's.
`crates/mc-module/src/bin/ck_mc_host/serve.rs` is outside the crate and is cited
because it is the **sole production `HostConfig` construction site and the only
non-test caller of `runtime::run`**; without it no reachability label in this
sub-part could be justified.

**This is a post-refactor surface, and unusually for this catalog it is a clean
one.** Grepping all five files for `tcp_frame_channel`,
`transport_negotiation`, `transport_provider`, `provider_recovery`,
`frame_read`, `shm_provider`, `negotiate`, `Serveable`, `transport selection`,
and `fallback` returns **zero hits**, so **no documentation or comment in this
sub-part describes a deleted mechanism**. `lib.rs` is the file most likely to
hold a stale reference, since it is the module manifest the refactor edited, and
it is clean: it declares `ring_transport` and `setup_socket` as `#[doc(hidden)]
pub mod` (`:20-21`, `:34-35`) and names no deleted module.
`config.rs:213`'s `transport_setup_deadline` survives and still names a live
mechanism, the mandatory ring setup of protocol Section 7.7. Four commits carry
the refactor:

| Commit | Subject |
| --- | --- |
| `0f336d3c` | `refactor(shm): collapse to fixed ring transport` |
| `d8bde128` | `feat(host): add authenticated ring setup socket` |
| `793a973e` | `build(shm): require packaged native transport` |
| `ed487e11` | `refactor(host): make ring transport mandatory` |

Two residuals of the opposite shape, recorded so a later pass does not miscount
them as stale. Both are **forward** references to unbuilt work:
`runtime.rs:3-5` says future wiring in `magic-context-c50.4` will map
SIGINT/SIGTERM, and no signal handling was deleted because none has been
written; and `config.rs:5-6` says CLI and config-file exposure belongs to
`magic-context-c50.8`, which is the reason the configuration contract is doc
comments.

Provenance in [../README.md](../README.md). System
`/local/home/ahrav/scratch/magic-context`, branch
`feat/shared-memory-release-gate-audit`, `HEAD` = `e447c927`, confirmed with
`git log -1`. Both lens agents read and verified their line references at that
commit. Scope and CI findings come from
[../part-2-rescope/scope-map-and-risk-ranking.md](../part-2-rescope/scope-map-and-risk-ranking.md).

**Where lens B re-derived a citation lens A made, lens B's line numbers and
figures win.** Three differences, all verified again by this synthesis by
printing the lines, plus one cross-part correction of its own.

- **The forced-shutdown floor is about 100 seconds, not about 70.** Lens A's
  observation O3 states the mechanism correctly — `runtime.rs:1148` computes one
  absolute deadline, `:1214`'s `timeout_at` is entered only when it has already
  expired, and `:1223` then arms a *fresh* `lifecycle_callback_deadline
  .saturating_mul(2)` awaited at `:1224` — and then reads the total as 60 s
  added after 10 s. Lens B composed the whole sequence and found the floor is
  about **100 seconds** counting only the drain (`:1200`, 10 s), the doubled
  chain (`:1223-1224`, 60 s), and `run_handler_shutdown` (`:1240`, 30 s at
  `:1276`), and about **160 seconds** counting one of the two
  `force_close_all_routes` calls (`:1206`, `:1216`) that no timeout wraps.
  Lens B's figures are used below and in the record's surrounding prose; the
  record body itself is verbatim from lens A and states the bound in the units
  the code bounds, which is unaffected.
- **`activation_in_progress` is `runtime.rs:1051-1071`, not `:1051-1074`.**
  Lens A cited the wider span in two places.
- **`config.rs` carries 10 in-crate tests and `runtime.rs` 1, for 11 in the
  sub-part.** Lens A did not count them; lens B enumerated the sites. Used
  throughout.
- **This synthesis corrects one cross-part citation of its own.** Part 2a's
  catalog cites `config.rs:296` for `liveness: None` in two places (its
  reachability section and its Group K preamble). The line is **`config.rs:294`**
  at `HEAD`, printed and confirmed as `liveness: None,` inside
  `HostConfig::default`. Lens A of this sub-part cites `:294` and is right. The
  correction changes nothing about 2a's conclusion; it is recorded because the
  cross-part settlement below leans on that exact line.

## What this part is about

Six facts frame every record here. The first is the artifact siblings depend on.
The second settles a question three parts have left open. The third is the
recurring shape this catalog has now found twice. The fourth is why the
configuration contract cannot be checked. The fifth is the one-sentence verdict
on the defaults. The sixth is the coverage position, which is the weakest of the
three sub-parts.

### The construction conditionality map

Reproduced in full, because sibling sub-parts depend on it for their reachability
labels and because the answer is short: **only three things are conditional, and
nothing is `cfg`-gated.** `run` (`runtime.rs:630`) delegates to
`run_with_publish_hook` (`:641`). "Unconditional" means reached on every path
that gets that far, with no config key, feature flag, or `cfg` gating it.

| # | Component or step | Site | Condition |
| --- | --- | --- | --- |
| 1 | Process panic hook | `:647` | **Unconditional, and before config validation.** `Once`-guarded inside `panic_boundary::install` (`panic_boundary.rs:39`), so idempotent across repeated `run` calls |
| 2 | `HostConfig::validate` | `:648` | Unconditional. First rejection point |
| 3 | `InstanceGuard::acquire` retry loop | `:656-679` | Unconditional. 4 attempts, 25 ms apart (`instance.rs:674-675`), so a 75 ms budget; not configurable |
| 4 | `Starting` lifecycle record | `:680-682` | Unconditional |
| 5 | `Arc::new(handler)` | `:684` | Unconditional |
| 6 | `install_connection_key` | `:685` | Unconditional. Handler learns the auth key before any listener exists |
| 7 | `manifests()` / `resource_declarations()` | `:686-687` | Unconditional, both inside `redact_sync` |
| 8 | `TargetIndex` + `Reservations` | `:688` via `build_target_index` (`:496`) | Unconditional. Refuses 0 or >3 manifests (`:500`), mismatched declaration count (`:506`), duplicate module id (`:526`), class/reservation disagreement (`:535-554`), unsupported or duplicate role (`:588`, `:592`), no routable role (`:599`), and a manifest set with no `tool_provider` (`:610-617`) |
| 9 | Reservation feasibility gates | `:693`, `:698`, `:708` | Unconditional |
| 10 | `CatalogCache::new_bounded` | `:718` | Unconditional, bounded during serialization at `MAX_BODY_LEN` |
| 11 | Resident-byte floor gate | `:733-740` | Unconditional. **Load-bearing for step 18** |
| 12 | `initialize` callback | `:752` | Unconditional, `AbortOnDropHandle`, raced against `shutdown` (`:756-764`) and `lifecycle_callback_deadline` (`:761`) |
| 13 | `PrePublicationCleanup` | `:826` | Unconditional once initialization returned `Ok` |
| 14 | Setup socket bind | `:836` | **Skipped if `shutdown` already cancelled** (`:831` returns `Ok(None)`) |
| 15 | Publication + `Running` record | `:842`, `:847-849` | Same condition as 14. The `Running` write is best-effort; its failure is discarded |
| 16 | `process_limits(max_connections)` | `:872` | Unconditional. Checked multiplication; overflow is `InitFailed` |
| 17 | `RingTransport` | `:876` | **Unconditional.** Confirms Part 2b's finding at the same line, unchanged at this commit |
| 17a | `ring.set_publish_hook` | `:879-881` | **Conditional and test-only.** Reachable only through `run_with_publish_hook`, which is `#[doc(hidden)]` (`:640`); `run` passes `None` (`:635`) |
| 18 | `HostShared` | `:882-927` | Unconditional. Contains the unchecked ingress subtraction (`:896-902`) |
| 18a | `ingress_budget` | `:896-902` | Unconditional. `max_resident_bytes − EGRESS − SCRATCH − catalog − retained`, **unchecked**; step 11 is its only guard |
| 18b | `scratch_budget`, `egress_budget` | `:903-904` | Unconditional, fixed constants, **never derived from config** |
| 18c | `pending_permits`, `task_permits` | `:905-910` | Unconditional. Configured limit minus the reserved carve-out |
| 18d | `reserved_pending_permits`, `reserved_task_permits` | `:911-912` | Unconditional **construction**, zero-permit when no module declared a reservation, and then never entered |
| 18e | `health_snapshot` | `:889-893` | Unconditional. Seeded `Degraded` with `components: {}` |
| 18f | `liveness` | `:886` | Unconditional **copy**; the subsystem it feeds is conditional (see 22) |
| 18g | `shutdown_latch`, `tracker`, `AbortRegistry` | `:915-919` | Unconditional |
| 19 | `AbandonGuard` | `:929-931` | Unconditional |
| 20 | Activation task | `:932` | **Unconditional.** Tracked, abort-exempt, not awaited by startup |
| 21 | Health task | `:933` | **Unconditional.** No config key disables it. `liveness: None` does not suppress it |
| 22 | Liveness loop | `connection.rs:279-284` | **Conditional on `shared.liveness.is_some()`**, which is `None` by default (`config.rs:294`) and `None` in production (`serve.rs:593`) |
| 23 | Accept loop | `:934` | Unconditional. 100 ms fixed `ACCEPT_ERROR_BACKOFF` (`:965`), not configurable |
| 24 | Setup-socket unlink | `:935` | Unconditional, result discarded |
| 25 | `shutdown_sequence` | `:936` | Unconditional |
| — | `HarnessClosureStore` | — | **Never constructed by this crate.** Zero Rust references to `HarnessClosureStore`, `ClosureCandidate`, or `HarnessClosureStore::open` anywhere under `crates/mc-host/src`. Its production constructor is `serve.rs:162` and `:349`, in `mc-module`, and both discard the error with `.ok()` |

Three conclusions siblings can rely on, quoted from lens A because they are what
the map is for.

1. **Nothing in the host runtime is feature-gated or `cfg`-gated.** The only
   conditional construction in the entire sequence is `set_publish_hook`
   (test-only), the setup-socket bind and publish pair (skipped on an
   already-cancelled token), and the per-connection liveness loop.
2. **The activation task and the health task are unconditional.** A record about
   either is `default-production` regardless of configuration.
3. **The liveness loop is not reached in production.** Not merely
   `explicit-config-only`: the sole non-test caller of `run` never sets the
   policy.

`RingTransport` at `:876` deserves separate emphasis because three sibling
sub-parts cite it: it is built **unconditionally**, printed and confirmed here as
`let ring = Arc::new(crate::ring_transport::RingTransport::for_ring_profile(`.
The ring is not optional, not selected, and not gated, which is the same verdict
2b and 2d reached against the `RING_PROFILE = "mc-host-test-ring-v1"` name and
the "Thread-confined peer endpoint for integration tests" doc comment.

### This sub-part settles a cross-part question

**Liveness is `None` by default and production never overrides it, so no ping is
ever sent and Part 2a's liveness records are unreachable in production.** Stated
plainly because three parts have carried it as an open question and the answer is
now determined by a line outside the crate.

The chain is three facts, each verified. `HostConfig::default` sets
`liveness: None` at `config.rs:294`, printed and confirmed. The liveness loop is
spawned only under `shared.liveness.is_some()` at `connection.rs:279`. And the
sole production `HostConfig` construction, `serve.rs:582-593`, overrides only
`max_resident_bytes` and then falls through to `..HostConfig::default()` at
`:593`, printed and confirmed, so the production host inherits `None`. No other
non-test caller of `runtime::run` exists.

Part 2a labelled its three liveness-dependent records `explicit-config-only` on
the narrower ground that nothing *in this crate* opts in
(`part-2a-host-lifecycle/catalog.md:46-51`). This sub-part strengthens that to
the production claim, and the three records it applies to are exactly the three
`explicit-config-only` records in 2a's catalog, confirmed by enumerating that
catalog's `Reachability:` lines:

- [../part-2a-host-lifecycle/catalog.md#a-timely-pong-sustains-the-generation-within-a-bounded-round](../part-2a-host-lifecycle/catalog.md#a-timely-pong-sustains-the-generation-within-a-bounded-round),
  2a's liveness record proper.
- [../part-2a-host-lifecycle/catalog.md#slow-egress-alone-does-not-retire-a-probed-generation](../part-2a-host-lifecycle/catalog.md#slow-egress-alone-does-not-retire-a-probed-generation).
- [../part-2a-host-lifecycle/catalog.md#a-setup-pong-is-required-and-forbidden-in-the-same-window](../part-2a-host-lifecycle/catalog.md#a-setup-pong-is-required-and-forbidden-in-the-same-window),
  **the pong pre-answer record**, whose enabling state its own
  `Required faults and enabling state:` line gives as `liveness: Some(..)` in
  `HostConfig`.

So all three are reachable only from `tests/lifecycle.rs:402` and
`tests/client.rs:64`, and a production incarnation cannot enter any of them. Two
consequences follow and both belong on the record. First, the host has **no
application-level liveness detection at all** by default: a silently wedged peer
is discovered only by the ring's own path, which Part 2d established shares one
code (`eof`) with a clean host exit. Second, `invalidate_on_missed` is the one
flag whose only `true` value in the repository is in a test
(`tests/client.rs:67`), against a comment at `config.rs:236-238` saying it must
stay `false` until `magic-context-c50.4`, so the code path the stated policy
forbids is the only one exercised.

### Two fixed bounds judge configurable ones

Both are the shape Part 2a found with its 60-second freshness window, where a
hardcoded value governs an operator-settable one and the fixed value wins. **Two
recurrences in one sub-part, in the same direction, makes this the catalog's
second-most repeated finding after the success-shaped error path.** Part 2a's is
[../part-2a-host-lifecycle/catalog.md#phase-evidence-outlives-a-long-phase](../part-2a-host-lifecycle/catalog.md#phase-evidence-outlives-a-long-phase),
where the record is written once per phase transition and compared against a
fixed, non-configurable 60-second window while the frame and lifecycle deadlines
are settable to 365 days.

**First, a hardcoded 50 millisecond probe interval replaces the configured health
interval whenever a handler-authored string reports a starting state, so the
handler sets the host's probe rate, unbounded.** `runtime.rs:1129-1133`, printed
and confirmed:

```
let interval = if activation_in_progress {
    Duration::from_millis(50)
} else {
    shared.timing.health_interval
};
```

The predicate `activation_in_progress` (`:1051-1071`) walks the report's own
metrics and returns true when any component's `metrics.storage_state` or
`metrics.synapse_state` equals the string `"starting"`. That report is handler
output: `McHostHandler::health` returns a `HealthReport` (`handler.rs:591`) whose
`metrics` field is `Option<serde_json::Value>` (`:194`), entirely
handler-authored. So a handler that keeps reporting `starting` moves the host
from its configured `health_interval` — 30 s by default (`config.rs:229`),
settable to 365 days (`config.rs:81`, `:360`) — to a hardcoded 50 ms, a
600-fold increase, for as long as it keeps reporting that string. Nothing caps
the duration, counts the fast probes, or re-reads the configured value while the
fast path is active. Two aggravating details: the 50 ms is a bare literal rather
than a named constant, so it is invisible to anyone reading `HostTiming`; and
each probe invokes the handler's `health` callback under `lifecycle_join`
(`:1117`), where an overrun is host-fatal (`handler.rs:554-556`), so the fast
path raises callback frequency 600-fold and keeps every invocation on a
fatal-if-slow path. The design intent is legible — fast polling during
activation is how the host notices storage becoming ready, and protocol `:596`
requires the host to stay usable while storage opens — but the trigger is
untrusted input from the component being probed, and the knob is silently
overridden rather than clamped.

**Second, a doubled callback deadline is armed after the shutdown deadline
already expired, so 10 seconds configured allows a floor of about 100 seconds,
or about 160 with two untimed route closes.** `runtime.rs:1223`, printed and
confirmed as
`let lifecycle_chain = shared.timing.lifecycle_callback_deadline.saturating_mul(2);`,
armed at `:1224` with a fresh `timeout(...)` rather than a
`timeout_at(deadline, ...)`. The ordering is what makes it a finding: `deadline`
is computed once at `:1148` as `Instant::now() + shutdown_deadline`, the drain at
`:1200` consumes it, and the `timeout_at` at `:1214` is entered only when the
deadline is already in the past. Composing the stages at defaults
(`shutdown_deadline` 10 s, `config.rs:228`; `lifecycle_callback_deadline` 30 s,
`:225`):

| Stage | Site | Bound |
| --- | --- | --- |
| Graceful drain | `:1200` | 10 s (`shutdown_deadline`) |
| `abort_all` + `force_close_all_routes` | `:1205-1206` | **unbounded by `deadline`**; internally 30 s (`dispatch.rs:1434`) then 30 s in `run_route_gone` |
| `timeout_at(deadline, tracker.wait())` | `:1214` | about 0, deadline already passed |
| `abort_all` + `force_close_all_routes` again | `:1215-1216` | same shape |
| Doubled lifecycle chain | `:1223-1224` | 60 s |
| `run_handler_shutdown` | `:1240` | 30 s (`:1276`) |

**Floor: about 100 seconds for a configured 10**, counting only the drain, the
doubled chain, and the handler callback; about **160** counting one untimed
`force_close_all_routes`. Two secondary consequences.
`HostError::ShutdownDeadlineExpired`'s own doc comment (`runtime.rs:42-44`) says
"Host tasks could not be reaped within the shutdown deadline even after aborts",
and it is returned after roughly ten times that deadline. And the client gives up
long before: `CLIENT_SHUTDOWN_TIMEOUT` is 5 s (`client.rs:51`, protocol `:741`),
so a correct graceful shutdown presents to a conforming client as a timeout. The
comments at `:1217-1222` and `:1228-1233` argue the trade explicitly and well —
releasing the instance fence while a lifecycle callback still owns the handler
would let a successor start against the predecessor's in-flight cleanup — and the
finding is not that the choice is wrong. It is that the choice is unbounded by
the knob the operator was told bounds it, and the rule it breaks is stated as
`MUST NOT` at protocol `:731`: "Every operation owns one absolute deadline;
per-stage timers MUST NOT multiply it."

A third site multiplies in the same way and is a refinement of Part 2c's finding
rather than a new one: `transport_setup_deadline` is armed twice, serially, at
`connection.rs:158` for `ring.prepare` and again at `:177` for `activate_server`,
so with `auth_deadline` consumed first at `:125` the host's serial pre-service
budget at defaults is 2 + 2 + 2 = **6 seconds** against a documented client
whole-handshake deadline of 2 s (protocol `:737`). Part 2c's
`existing-checks.md:569-575` recorded 4 s, which counts
`transport_setup_deadline` once.

### The configuration contract is doc comments only

**There is no configuration reference document.** Both lenses searched
independently and agree. Every key name in `HostLimits`, `HostTiming`,
`LivenessPolicy`, `HostInit`, and `HostConfig` was grepped across `docs/`, and
**no file names any of them except `max_resident_bytes`**
(`docs/mc-host-wire-protocol.md:423`, and there only to say the cap covers
Synapse parse scratch as a named logical payload). Every other hit is inside
`docs/properties/`, which is this catalog's own working material and is not a
contract. `docs/perf/mc-host-baseline.md:36-38` restates a handful of default
values as a description of one perf run and `:48` explicitly tells a reader to
record the current `HostConfig::default()` rather than copying the old value, so
it is a self-dating snapshot rather than a specification. `config.rs:5-6` says
why this is intentional: CLI or config-file exposure "belongs to the spawn/doctor
integration (`magic-context-c50.8`), not this crate."

That raises the evidentiary weight of the doc comments in `config.rs` and makes
each contradiction a contradiction with the only available authority. It also
means the protocol specification is being used as a configuration contract it was
not written to be, which is why the "Documented" column below is answered from
the specification's normative statements about the *behaviour* each key controls.

**And all 10 `config.rs` tests prove rejection rather than use.** The ten sites
are `:467`, `:472`, `:502`, `:520`, `:550`, `:564`, `:576`, `:603`, `:636`,
`:646`, and lens B's verdict is the load-bearing one: none proves that an
*accepted* configuration is then used as configured. That is exactly the class
both fixed-bound findings above fall into, and it is not a class a rejection test
can catch.

The table below is lens A's, reproduced in full. Columns: code default; what
`docs/mc-host-wire-protocol.md` says; the bound `validate` enforces; and whether
the key changes host behaviour.

| Key | Code default | Documented | Enforced bound | Takes effect |
| --- | --- | --- | --- | --- |
| `max_handshakes` | 32 (`config.rs:128`) | Value deliberately unspecified: "Slot count is finite deployment policy, not a wire constant" (`:161`) | nonzero, ≤ `Semaphore::MAX_PERMITS` (`config.rs:156-167`) | Yes — `runtime.rs:913` |
| `max_connections` | 64 (`:129`) | "A deployment MAY cap concurrent connections" (`:290`), no value | same | Yes — `:872` and `:914`. **Two consumers**: it also scales every shared-memory resource limit |
| `max_routes` | 1024 (`:130`) | "MAY cap ... routes" (`:290`), no value | same, plus ≤ `u16::MAX` (`config.rs:168-174`) | Yes — `:895` |
| `max_pending_requests` | 1024 (`:131`) | "MAY cap ... pending correlations" (`:290`), no value | same | Yes — `:693`, `:906` |
| `max_handler_tasks` | 256 (`:132`) | "MAY cap ... handler tasks" (`:290`), no value | same | Yes — `:698`, `:707`, `:909` |
| `max_resident_bytes` | 385,942,805 (`:140`, computed) | Described at `:423` as an accounting boundary over named payloads, not an exact RSS claim; no value given | ≥ `MIN_RESIDENT_BYTES` = 318,833,941 (`config.rs:175`), ≤ `min(Semaphore::MAX_PERMITS, u32::MAX)` (`:185-191`), plus the startup floor at `runtime.rs:736` | Yes — `:897`. **Raises only the admission pool**; the egress and scratch slices are constants |
| `writer_queue_frames` | 64 (`:141`) | Not documented for the host. `:742-743` gives 256 data + 32 reserved as *managed client* defaults | nonzero, ≤ `Semaphore::MAX_PERMITS` | Yes — `connection.rs:145` |
| `auth_deadline` | 2 s (`:223`) | "Recommended host default is 2 seconds" (`:159`) — **the only host default the specification states** | nonzero, ≤ 365 days (`config.rs:356-363`) | Yes — `connection.rs:125` |
| `frame_deadline` | 30 s (`:224`) | 30 s appears at `:738` but that table is scoped "Managed Rust and TypeScript client defaults" (`:733`) | same | Yes — `connection.rs:146`, then `ring_transport.rs` |
| `lifecycle_callback_deadline` | 30 s (`:225`) | Not documented | same | Yes — `runtime.rs:184`, `:761`, `:1084`, `:1276`, `dispatch.rs:1140`. **Also doubled at `runtime.rs:1223`** |
| `route_close_budget` | 5 s (`:226`) | "finite close budget" (`:296`, `:691`), no value | same | Yes — `dispatch.rs:1348`, `:1358` |
| `transport_setup_deadline` | 2 s (`:227`) | Not documented as a host key. `:737` gives the client one 2 s deadline covering descriptor transfer and ring attachment | same | Yes — `connection.rs:158` **and** `:177`, armed twice serially |
| `shutdown_deadline` | 10 s (`:228`) | Not documented for the host. `:741` gives 5 s as the *client* shutdown deadline | same | Yes — `runtime.rs:1148`. **Exceeded on the forced path** by `:1223` |
| `health_interval` | 30 s (`:229`) | §9.3 (`:679-685`) describes the probe; no interval | same | Yes — `runtime.rs:1132`, **but only in the `else` branch**; `:1130` substitutes a fixed 50 ms |
| `liveness` | `None` (`:294`) | "A missed Pong invalidates the connection only under host's bounded liveness policy" (`:681`) — absence permitted | if `Some`, both periods nonzero and ≤ 365 days (`config.rs:364-377`) | Yes when `Some` (`connection.rs:279`). **Never `Some` in production** |
| `liveness.invalidate_on_missed` | n/a; `false` at both call sites | Not documented | none | Yes — `connection.rs:830`. `config.rs:236-238` states it must stay `false` until `magic-context-c50.4` |
| `data_dir` | `None`, so XDG (`:288`) | `${dataDir}/cortexkit/...` layout is normative (`:143-147`) | **none** | Yes — `runtime.rs:660` |
| `daemon_ver` | `mc-host/{CARGO_PKG_VERSION}` (`:289`) | Published as `daemon_ver`, echoed in the proof; `auth.rs:132-133` says it is not an authentication input | nonempty (`config.rs:302`); worst-case auth and connection-file size (`:314-340`) | Yes — `:842`, `:926` |
| `payload_manifest_digest` | SHA-256 of zero bytes (`:84-85`, `:290`) | Required persisted identity; `lifecycle.rs:378` treats an *empty* digest as legacy | 64 lowercase hex (`config.rs:305`) | Yes — `:661` |
| `init.storage` | `None` (`HostInit::default`) | "The handler deserializes it; the host never reads it" (`config.rs:252-253`) | none | Pass-through — moved out at `:751`, handed to `initialize` |
| `init.subc_capabilities` | `Vec::new()` (`:250`) | Not documented | none | **No.** Zero readers repo-wide. Only written (`serve.rs:487`, two test sites, both `Vec::new()`) and `Debug`-formatted (`config.rs:262`) |

**Totals in Part 4f's categories.** 21 keys in scope.

- **Documented and matching: 1.** `auth_deadline` at 2 s (`:159` versus
  `config.rs:223`).
- **Documented as policy with the value deliberately left open: 6.**
  `max_handshakes`, `max_connections`, `max_routes`, `max_pending_requests`,
  `max_handler_tasks`, `route_close_budget`. These are not divergences; the
  specification says the host owns the number.
- **Documented behaviour, undocumented value: 3.** `max_resident_bytes`,
  `liveness`, `payload_manifest_digest`.
- **Undocumented but effective: 10.** `frame_deadline`,
  `lifecycle_callback_deadline`, `transport_setup_deadline`,
  `shutdown_deadline`, `health_interval`, `writer_queue_frames`,
  `invalidate_on_missed`, `data_dir`, `daemon_ver`, `init.storage`.
- **Inert: 1.** `init.subc_capabilities`.
- **Absent everywhere: 0.** No key is documented that does not exist.
- **Divergent: 0 strictly, 3 by adjacency.** No documented host default
  contradicts its code default. But three host keys sit next to a *client*
  default of a different value in the same specification section, with nothing
  relating them.

The three adjacency cases are the ones that bite, and lens B gave each a verdict:

| Domain | Host default | Client default | Verdict |
| --- | --- | --- | --- |
| Shutdown | `shutdown_deadline` 10 s (`config.rs:228`) | `CLIENT_SHUTDOWN_TIMEOUT` 5 s (`client.rs:51`, protocol `:741`) | **Worst.** The client abandons its close at 5 s while the host is still legitimately draining to 10 s, so a correct graceful shutdown presents to the client as a timeout |
| Authentication | `auth_deadline` 2 s (`:223`) | `CLIENT_HANDSHAKE_TIMEOUT` 2 s (`client.rs:43`), spanning discovery, authentication, descriptor transfer, and ring attach | The host's authentication **stage alone** can consume the client's whole budget. Protocol `:747` names this: the two values "are not independent" and a deployment needing the full host window "MUST raise the client handshake deadline above it" |
| Transport setup | `transport_setup_deadline` 2 s (`:227`) | the same 2 s client handshake | A **second** host stage individually equal to the client's entire budget |

`frame_deadline` is the control case: 30 s on both sides (`config.rs:224`,
`client.rs:45`), the one domain where the two defaults agree, which shows the
divergences are not a systematic offset. `HostConfig::validate` (`:300-379`)
checks each duration for zero and for `MAX_CONFIG_DURATION` and **never compares
a host key against a client key**, and it performs no cross-field check of any
kind. Two further unenforced bounds belong with it: `data_dir` has no length or
shape validation at all, its practical bound being `AF_UNIX` `sun_path` enforced
only by `bind_owner_only` failing at `runtime.rs:836` *after* validation passed
and *after* the instance lock was taken; and only two of the eight startup gates
live in `validate`, because the reservation feasibility gates (`:693`, `:698`,
`:708`) and the resident floor (`:736`) are handler-dependent. So "the config
validated" never implies "this host can start."

### The default configuration is safe for capacity and not for detection

One sentence, because it is the operational summary of everything above.

On the **capacity** side the defaults are conservative and internally consistent,
and the arithmetic was verified independently by lens A from `wire.rs:28`
(`HEADER_LEN = 21`) and `wire.rs:371`/`:35` (`MAX_BODY_LEN = 67,108,864`):
`EGRESS_RESERVED_BYTES` = 67,108,885, `SCRATCH_RESERVED_BYTES` = 184,616,192,
`MIN_RESIDENT_BYTES` = 318,833,941 (304 MiB), default `max_resident_bytes` =
385,942,805 (368 MiB), and the admission pool at defaults before catalog and
retained subtraction is 134,217,728, exactly 2 × `MAX_BODY_LEN`. Nothing silently
clamps: every out-of-range value returns a `ConfigError` naming the offending key
(`config.rs:158`, `:161`, `:169`, `:176`, `:187`, `:358`, `:361`) and every
`Display` arm prints the configured and maximum values (`:420-457`).

On the **detection** side the same defaults arm nothing. No liveness probe is
started, so a wedged peer is invisible at the application layer. The health
snapshot is seeded `Degraded` with an empty `components` map (`runtime.rs:889-893`)
and the health task is spawned one line before `accept_loop` (`:933` versus
`:934`), so a client can be served, and can read `host.status`
(`connection.rs:691-695`), before the first probe returns — for up to
`lifecycle_callback_deadline`, 30 s at defaults, under a slow `handler.health`.
The distinguishing signal exists, because `build_target_index` requires one to
three manifests (`:500`) and `composite.rs:334-348` emits one entry per
component so a real report is never empty, but it is incidental and unasserted,
and no field marks "not yet probed". And a closure-store open failure is
swallowed into `None` at `serve.rs:162` and `:349`, so a permissions or symlink
problem on the closure root presents as "no harness available" rather than as
"the closure store is insecure".

### Coverage: the weakest source-resident position of the three sub-parts

**11 in-crate tests reach 3,246 lines, none runs in CI, and there are zero
doctests.** The 11 are 10 in `config.rs` (`:467`, `:472`, `:502`, `:520`,
`:550`, `:564`, `:576`, `:603`, `:636`, `:646`) and 1 in `runtime.rs` (`:1326`,
`stalled_generations_share_one_shutdown_goodbye_deadline`).
`harness_closure.rs`, `lib.rs`, and `file_mode.rs` have none. Four integration
binaries carry this sub-part's claims — `tests/synapse_bundle.rs` (24 tests),
`tests/harness_closure.rs` (15), `tests/ipc_budget_topology.rs` (9),
`tests/activation.rs` (4) — and CI names none of them.

2e owns four CI-executed `compile_fail` doctests and 2b owns two; **2f owns
none**, and that is the largest structural gap in its inventory, because
`ci.yml:190` runs `cargo test -p mc-host --doc` and `config.rs`,
`harness_closure.rs`, and `lib.rs` are all `pub mod` (`lib.rs:14`, `:17`,
`:18`), so a doctest added to any 2f file would execute in CI today. For a
sub-part whose entire contract is doc comments, the one CI lane it could reach is
the one it does not use.

`tests/lifecycle.rs` (35 tests, 1,846 lines) is CI-named and does reach
`runtime.rs` transitively, since `run` is how any host starts. It is Part 2a
scope and its subject is lifecycle records and publication rather than the
configuration contract. Recorded so a later pass does not credit it as coverage
for this sub-part's claims, and does not overlook that it is the one CI-executed
path that touches these files at all.

**Three quiet areas frame the fault map.** Carried in full in
[existing-checks.md](existing-checks.md).

1. **`harness_closure.rs` is 1,122 lines of untrusted-manifest filesystem code
   with zero in-crate tests.** It validates untrusted manifests
   (`validate_manifest`, `:231`), materializes content-addressed trees through
   `openat`/`renameat_with`/`unlinkat` with explicit modes (`:14-16`), verifies
   file hashes and modes (`:826`, `:859`), checks directory ownership (`:919`),
   prunes a store (`:554`), enforces five hard caps (`MAX_MANIFEST_BYTES` 16 MiB,
   `MAX_NODES` 65,536, `MAX_PATH_BYTES` 4096, `MAX_STRING_BYTES` 1024,
   `:25-28`), and guards against sticky bits and non-regular files (`:29-32`).
   None of that is exercised by anything CI runs, its one test binary is
   unnamed, and `:400`'s `.expect` makes a validation gap a panic rather than a
   rejection.
2. **The configuration contract is proven only by rejection.** `config.rs` is the
   only authority for twenty of the twenty-one keys, its ten tests all prove
   rejection, none runs in CI, and the file has no doctest even though one would.
   `HostTiming`'s seven keys are validated for zero and overflow at `:341-363`
   and for nothing else, so `shutdown_deadline` is proven nonzero and never
   proven to bound shutdown.
3. **The forced shutdown path makes five unbounded or re-armed decisions and is
   tested nowhere.** `runtime.rs:1144-1244` calls `force_close_all_routes` twice
   (`:1206`, `:1216`) with no enclosing timeout, re-arms a doubled deadline after
   the original expired (`:1223`), trips the fatal latch on one branch (`:1234`),
   and runs the handler callback on another (`:1240`), returning `false` from
   three separate places. The comments are unusually careful and each argues its
   own ordering correctly. What is quiet is that the *composition* of those
   stages, which is what an operator experiences as "shutdown took a hundred
   seconds", is argued nowhere and tested nowhere.

## Reachability

**Thirteen records are `default-production` and one is `explicit-config-only`.**
No record here is `test-only`. The labels rest on the construction conditionality
map above plus three facts, per METHOD rule 4.

1. **`runtime::run` is production and has exactly one non-test caller.**
   `crates/mc-module/src/bin/ck_mc_host/serve.rs` builds the composite at `:575`
   and calls `mc_host::run` at `:632`, and that binary is described by its own
   manifest as the production lifecycle and serve executable.
2. **Nothing in the sequence is `cfg`-gated.** The map's three conditional steps
   are `set_publish_hook` (test-only, reachable only through the `#[doc(hidden)]`
   `run_with_publish_hook`), the setup-socket bind and publish pair (skipped on an
   already-cancelled token, which is itself a `default-production` state), and the
   per-connection liveness loop.
3. **The one `explicit-config-only` label is
   [rt-a-every-published-configuration-field-changes-host-behaviour](#rt-a-every-published-configuration-field-changes-host-behaviour),
   and lens A's reasoning is that the property is about what an *embedder* can
   set rather than about what the production binary does set.** Its subject is the
   published surface, and its one violator, `HostInit::subc_capabilities`, is
   written as `Vec::new()` at all four construction sites, so a default
   production host never populates it.

One asymmetry to state explicitly, because it is the opposite of what the
`runtime.rs:118-119` comment implies. The reserved admission pools are
**`default-production` reachable**, not dormant: `broca/mod.rs:164-177` returns a
`ResourceDeclaration` with `route_class: RouteClass::Reserved` and 96/96 counts
(`broca/config.rs:185`, `:188`), the comment at `broca/mod.rs:169-170` makes it
deliberate and unconditional, `composite.rs:10-13` fixes the direct profile's
tertiary as `broca/management_surface`, and `serve.rs:575` composes it. So the
comment's second clause is false and its first clause is true only of a
composition that excludes Broca. Sub-part 2e reached the same verdict
independently. The record this bears on,
[rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration](#rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration),
is worded conditionally ("When no linked module declares a reserved
allocation") and is therefore unaffected as written; the correction is carried
here rather than edited into it.

## Index

Fourteen records, in the order lens A proposed them. Lens B proposed none by
design; it built the 20-claim register and the check inventory.

| Slug | Type | Confidence |
| --- | --- | --- |
| [rt-a-startup-refuses-every-configuration-it-cannot-fund](#rt-a-startup-refuses-every-configuration-it-cannot-fund) | safety | high |
| [rt-a-the-ingress-pool-derivation-cannot-underflow](#rt-a-the-ingress-pool-derivation-cannot-underflow) | safety | high |
| [rt-a-no-configured-limit-is-silently-clamped](#rt-a-no-configured-limit-is-silently-clamped) | safety | high |
| [rt-a-the-default-configuration-arms-no-liveness-probe](#rt-a-the-default-configuration-arms-no-liveness-probe) | safety | high |
| [rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval](#rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval) | safety | high |
| [rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline](#rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline) | safety | high |
| [rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline](#rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline) | safety | high |
| [rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one](#rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one) | safety | high |
| [rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration](#rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration) | safety | high |
| [rt-a-every-published-configuration-field-changes-host-behaviour](#rt-a-every-published-configuration-field-changes-host-behaviour) | safety | high |
| [rt-a-configuration-is-frozen-for-the-incarnation](#rt-a-configuration-is-frozen-for-the-incarnation) | safety | high |
| [rt-a-a-closure-store-open-failure-is-classified-not-swallowed](#rt-a-a-closure-store-open-failure-is-classified-not-swallowed) | safety | medium |
| [rt-a-the-activation-fast-probe-interval-is-entered](#rt-a-the-activation-fast-probe-interval-is-entered) | reachability | high |
| [rt-a-an-initialized-handler-drains-without-publishing](#rt-a-an-initialized-handler-drains-without-publishing) | reachability | high |

Semantics distribution: eleven `always`, one `always-or-unreached`, two
`sometimes`. No `reachable`, no `unreachable`. Type distribution: twelve safety,
two reachability, no liveness. Reachability distribution: thirteen
`default-production`, one `explicit-config-only`. Confidence: thirteen high, one
medium.

**The five group headings below are this synthesis's own**, chosen by shared
mechanism rather than by the order records were proposed. Grouping reorders the
records relative to the index; the index is the record-order artifact. Record
bodies are verbatim from lens A. Two formatting-only changes were applied
uniformly: fields are wrapped to about 80 columns, since lens A's 2f records were
written on single long lines, and evidence links are rewritten from the lens
file's `../evidence/` form to `evidence/<slug>.md` so they resolve from this
directory. No wording was changed. Where a record's prose says "per the map
above", the map it means is the construction conditionality map in the leading
section of this file.

---

## Group A: what startup refuses to fund

Three records on the eight startup gates and the one piece of arithmetic they
protect. The first is the joint postcondition at `HostShared` construction, which
four existing tests cover one gate at a time and none asserts together. The
second is the unchecked subtraction that derives `ingress_budget`, whose only
guard sits 160 lines earlier. The third is that no out-of-range value is ever
clamped, which is the premise the other two rely on. Grouped because all three
are about the boundary between "the configuration validated" and "this host can
start", and that boundary is not where `validate` is.

### rt-a-startup-refuses-every-configuration-it-cannot-fund

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `handler_contract.rs:323`
`reservations_must_leave_one_general_slot_in_each_pool`, `:375`
`class_and_reservation_mismatches_fail_startup`, `:408`
`parked_general_task_bound_must_leave_one_free_slot`, and `:437`
`retained_declaration_raises_the_resident_floor_exactly` each cover one gate; the
joint postcondition at the construction site is unasserted
Guarantee: If `run` reaches `HostShared` construction, every permit count and
byte quantity it computes is non-negative, within `Semaphore::MAX_PERMITS`, and
leaves at least one maximum request body of ingress headroom.
Check: `always` — at `runtime.rs:882`, assert
`max_pending_requests > reservations.pending`,
`max_handler_tasks > reservations.tasks`,
`general_task_holds < max_handler_tasks - reservations.tasks`, and
`max_resident_bytes >= MIN_RESIDENT_BYTES + catalog_resident + retained_bytes`.
`always` rather than `always-or-unreached` because this construction is on every
successful startup path with no condition, per the map above.
Fault/timing angle: none. Startup is single-threaded here and the inputs are
fixed by the time the gates run.
Required faults and enabling state: a handler whose `resource_declarations` sum
approaches or exceeds a configured limit. `handler_contract.rs:302-320` already
builds one.
Confidence: high — [evidence](evidence/rt-a-startup-refuses-every-configuration-it-cannot-fund.md).
I traced all eight gates and verified each line, and computed the byte arithmetic
independently.
Existing check: four tests, each covering one gate; none asserts the conjunction
at the use site. Status `unaudited`.
Impact: a wrapped subtraction at `runtime.rs:896-912` reaching `Semaphore::new`
or `ByteBudget::new` panics during `HostShared` construction, after the transport
is published, so a client can discover a dead endpoint.
Open questions: None.

### rt-a-the-ingress-pool-derivation-cannot-underflow

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test relates `config.rs:23-24` to `runtime.rs:896-902`;
`config.rs:520-548` asserts the floor decomposition but never the runtime
subtraction
Guarantee: The unchecked subtraction that derives `ingress_budget` never
underflows, and its result is never below one `MAX_BODY_LEN`.
Check: `always` — immediately before `runtime.rs:896`, assert
`max_resident_bytes >= EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES +
catalog_resident + retained_bytes + MAX_BODY_LEN`. `always` because the
subtraction is unconditional; the guard being 160 lines earlier is exactly why
the assertion belongs at the consumer.
Fault/timing angle: none, but the coupling is a maintenance window rather than a
runtime one: any independent edit to `MIN_RESIDENT_BYTES` or to the subtrahend
list breaks it silently in release builds.
Required faults and enabling state: a `max_resident_bytes` exactly at the
handler-dependent floor, plus a non-zero `retained_resident_bytes` declaration
and a non-trivial catalog. `handler_contract.rs:437` constructs the floor case.
Confidence: high — [evidence](evidence/rt-a-the-ingress-pool-derivation-cannot-underflow.md).
Verified the gate, the constant's definition, and the arithmetic; confirmed
`ByteBudget::new` casts and would panic.
Existing check: `config.rs:520-548`
`the_resident_cap_splits_into_three_non_overlapping_pools` covers the constant
decomposition only. Status `unaudited`.
Impact: release-mode `u64` wrap producing a near-`u64::MAX` budget, then a panic
inside `Semaphore::new` after publication.
Open questions: None.

### rt-a-no-configured-limit-is-silently-clamped

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `config.rs:503`, `:551`, `:565`, `:577`, `:604`, `:637`,
`:647` cover rejection for individual keys; no test asserts that no path clamps
Guarantee: An out-of-range limit or duration is rejected with an error naming the
offending key, never clamped to a bound the caller cannot observe.
Check: `always` — for every field of `HostLimits`, `HostTiming`, and
`LivenessPolicy`, set it one step outside its bound and assert `validate` returns
`Err` whose `Display` names that field, and that no accepted `HostConfig` differs
from the submitted one in any field. `always` because it must hold on every
validation.
Fault/timing angle: none.
Required faults and enabling state: none. Pure function of a constructed
`HostConfig`.
Confidence: high — [evidence](evidence/rt-a-no-configured-limit-is-silently-clamped.md).
Read every branch of both validators and every `Display` arm. The one silent
narrowing found is `file_mode.rs:18`, outside `HostConfig`.
Existing check: seven unit tests in `config.rs`, per key, not exhaustive over
fields. Status `unaudited`.
Impact: an operator who sets a value and gets a different one silently loses the
ability to reason about the host's capacity, which is the premise of
`config.rs:87-88`.
Open questions:
- `file_mode::raw_mode` is `pub(crate)` and shared with `generation.rs`, which is
  Part 2a's file. Whether that caller upholds the "already within `0o7777`"
  precondition is unverified from here. (needs Part 2a)

---

## Group B: fixed bounds that outrank configured ones

Three records on the same shape, in the same direction: a value the operator
cannot set governs a value the operator can. The first is the 50 millisecond
probe interval, whose switch is handler-controlled and unbounded. The second is
`transport_setup_deadline` armed twice serially, so one configured duration
bounds two stages. The third is the doubled callback deadline armed after the
shutdown deadline already expired. Grouped because all three violate the same
normative rule — protocol `:731`'s "per-stage timers MUST NOT multiply it" — and
because in all three the code carries a written justification that is sound while
the consequence for the knob is unstated.

### rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `tests/lifecycle.rs:165` sets `health_interval` to 50 ms,
which coincides with the hardcoded value and therefore cannot distinguish the two
branches
Guarantee: The health probe cadence is either the configured `health_interval` or
the fixed 50 ms activation cadence, and which one applies is a stated function of
the component-reported activation state rather than an unbounded override of
operator configuration.
Check: `always` — at `runtime.rs:1129`, assert that the selected interval equals
`health_interval` whenever `activation_in_progress` is false, and record the
number of consecutive iterations that selected 50 ms so a campaign can bound it.
`always` because the selection happens on every loop iteration.
Fault/timing angle: the window is unbounded. The predicate at `:1051-1074` is
driven entirely by handler-authored strings in the previous report's metrics, so
nothing in the host limits how long the fixed cadence persists. A handler that
never leaves `starting` holds it forever.
Required faults and enabling state: a handler whose `health` report carries
`metrics.components.<id>.metrics.storage_state == "starting"` or
`synapse_state == "starting"`, plus a `health_interval` distinguishable from
50 ms. `tests/lifecycle.rs:165` must change its value to make the two branches
separable.
Confidence: high — [evidence](evidence/rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval.md).
Verified the branch, the predicate, the single `health_interval` consumer, and
that `MAX_CONFIG_DURATION` admits 365 days.
Existing check: none that separates the branches. Status `unaudited`.
Impact: an operator who raises `health_interval` to reduce probe load gets no
relief while any component reports `starting`, and 20 handler callbacks per
second continue. This is Part 2a's hardcoded-60-second shape in the same
direction.

> Synthesis note on one citation inside this record, carried here rather than
> edited into it. The predicate's span is `runtime.rs:1051-1071`, which lens B
> re-derived and this synthesis confirmed. The record's `Fault/timing angle:`
> says `:1051-1074`. The finding is unaffected; only the span moves.

Open questions:
- Should the fast cadence carry its own bound, or is an unbounded
  handler-controlled override intended? (needs human input)

### rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — 2c's `fault-map.md:180` reaches one of the two
`transport_setup_deadline` sites; nothing measures the serial sum
Guarantee: The host's total pre-service budget for one accepted socket is a
stated function of the configured deadlines, and the specification's coupling
warning accounts for every stage that consumes one.
Check: `always` — measure wall-clock from `run_connection` entry
(`connection.rs:115`) to the return of `activate_server` (`:177`) on a peer that
stalls maximally at each stage, and assert the total is at most
`auth_deadline + 2 * transport_setup_deadline`. `always` because the bound must
hold on every accepted socket.
Fault/timing angle: three serial windows: `auth_deadline` at `:125`,
`transport_setup_deadline` at `:158` for `prepare`, and
`transport_setup_deadline` again at `:177` for `activate_server`. At defaults
that is 6 s against a documented client budget of 2 s.
Required faults and enabling state: a peer that stalls inside authentication,
then inside descriptor transfer. 2c's `fault-map.md:52` describes the fixture and
notes it does not exist.
Confidence: high — [evidence](evidence/rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline.md).
Verified all three sites and confirmed `HostConfig::validate` performs no
cross-field check.
Existing check: none. Part 2c's `existing-checks.md:569-575` records the coupling
as a documentation gap with the figure 4 s. Status `unaudited`.
Impact: a client conforming to the documented 2 s handshake deadline abandons a
host that is still inside a budget the host considers valid, producing an
`outcome_unknown` class the specification's coupling note was written to prevent.
Open questions: None.

### rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/lifecycle.rs:714-715` sets both
`lifecycle_callback_deadline` and `shutdown_deadline`, so the forced path is
reachable; no assertion bounds the total
Guarantee: `run` returns within a stated function of the configured deadlines,
and that function is documented wherever `shutdown_deadline` is described.
Check: `always` — from the shutdown token's cancellation to `run`'s return on the
forced path, assert elapsed time is at most
`shutdown_deadline + 2 * lifecycle_callback_deadline`. `always` because it must
hold on every forced shutdown, and stated in the units the code bounds
(`runtime.rs:1148` and `:1223`).
Fault/timing angle: `:1214` fails, then `:1224` awaits a second, fresh budget
computed at `:1223` as `lifecycle_callback_deadline.saturating_mul(2)`. At
defaults, 60 s added after a 10 s deadline expired. `saturating_mul` means a
`lifecycle_callback_deadline` above half of `MAX_CONFIG_DURATION` yields a budget
the validator would itself reject.
Required faults and enabling state: a tracked task that survives the shutdown
deadline. `tests/lifecycle.rs:678` and `:714` build the non-yielding-callback
shape.
Confidence: high — [evidence](evidence/rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline.md).
Verified both deadline sites and read the justifying comment at `:1217-1222`.
Existing check: none bounding the total. Status `unaudited`.
Impact: a supervisor that budgets `shutdown_deadline` for a stop, plus the
documented client 5 s, kills the host during a cleanup phase the host considers
in-budget, which is precisely the window `:1217-1222` says must not be
interrupted.
Open questions:
- `saturating_mul(2)` can produce a duration the validator rejects as an input.
  Whether the derived budget should be clamped to `MAX_CONFIG_DURATION` is
  unresolved. It cannot overflow, so this is a coherence question rather than a
  defect.

> Synthesis note on the figure this record's check implies, carried here rather
> than edited into it. The check's bound,
> `shutdown_deadline + 2 * lifecycle_callback_deadline`, is 70 s at defaults and
> is the right bound to assert because it is stated in the units the code bounds.
> The *observed* floor is higher. Lens B composed all six stages and found about
> **100 seconds** counting the drain (`:1200`), the doubled chain
> (`:1223-1224`), and `run_handler_shutdown` (`:1240`, 30 s at `:1276`), and
> about **160** counting one of the two `force_close_all_routes` calls (`:1206`,
> `:1216`) that no timeout wraps. Both figures exceed the record's bound, which
> means an oracle written to the check as stated would **fail** on a correct
> build: `run_handler_shutdown`'s own 30 s is outside the two terms. That is a
> refinement a later pass should apply to the check line, and it is recorded here
> rather than applied because the record text is preserved verbatim.

---

## Group C: the detection the default configuration does not arm

Three records on what a default host cannot see. The first is that no liveness
probe is armed at all, which is the reachability label for every liveness
property in the catalog. The second is that a `host.status` served before the
first health probe is distinguishable from a genuinely degraded one only by an
incidental empty map. The third is the reachability of the activation fast-probe
situation, without which the override in Group B cannot be measured. Grouped
because all three are about the host's own view of itself, and because in all
three the signal either does not exist or exists by accident.

### rt-a-the-default-configuration-arms-no-liveness-probe

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `tests/lifecycle.rs:496` `liveness_is_disabled_by_default`
asserts no Ping arrives within 500 ms on a default host
Guarantee: With `liveness` unset, the host arms no Ping timer, sends no Ping, and
never invalidates a connection for a missing Pong.
Check: `always` — whenever `shared.liveness.is_none()`, assert no `liveness_loop`
task was spawned for any generation, and no frame of type `Ping` was ever
enqueued. `always` because the absence must hold for the whole incarnation, not
merely at one observation.
Fault/timing angle: the window is the whole incarnation. A default host cannot
detect a silently wedged peer through Ping at all; peer death is discovered only
by the ring's own path.
Required faults and enabling state: a default `HostConfig`. That is the
production configuration.
Confidence: high — [evidence](evidence/rt-a-the-default-configuration-arms-no-liveness-probe.md).
Verified `config.rs:294`, the single spawn condition at `connection.rs:279`, and
that `serve.rs:582-593` reaches `HostConfig::default` for this field.
Existing check: `tests/lifecycle.rs:496`. Status `unaudited`.
Impact: this is the reachability label for every liveness property in the
catalog. Any record whose enabling state is a `LivenessPolicy` is reachable only
from `tests/lifecycle.rs:402` or `tests/client.rs:64`, never from production.
Open questions:
- `config.rs:236-238` says `invalidate_on_missed` stays `false` until
  `magic-context-c50.4`. `tests/client.rs:67` sets it `true`. So the only code
  path that ever invalidates on a missed Pong is a test. Whether that is intended
  coverage of a future default or an accidental divergence from the stated policy
  is a design question. (needs human input)

### rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads `host.status` before the first probe completes
Guarantee: An authenticated `host.status` served before any health probe has
completed is distinguishable from one reporting a genuinely degraded component.
Check: `always` — whenever the `host.status` response reports `degraded`, assert
that either `metrics.components` is non-empty or an explicit not-yet-probed
marker is present. `always` because a client may read the snapshot at any moment,
including the first.
Fault/timing angle: the window opens at `runtime.rs:933`, when the health task is
spawned, and closes when the first probe stores a report at `:1120-1123`.
`accept_loop` starts one line later at `:934`, so the window is genuinely
client-visible, and it lasts up to `lifecycle_callback_deadline` (30 s at
defaults) under a slow `handler.health`.
Required faults and enabling state: a handler whose first `health` call blocks,
plus a client that authenticates and issues `host.status` inside that window.
`tests/lifecycle.rs:579` already builds a slow-callback handler.
Confidence: high — [evidence](evidence/rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one.md).
Verified the seed, the reader, the spawn ordering, and that a real report always
carries at least one component.
Existing check: none. Status `unaudited`.
Impact: a supervisor gating traffic on `host.status` reads `degraded` from a
healthy host and may withhold traffic or restart it. The distinguishing signal
exists but is incidental and unasserted, so a change to either the seed or the
composite's report shape removes it silently.
Open questions: None.

### rt-a-the-activation-fast-probe-interval-is-entered

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test constructs a component report carrying
`storage_state` or `synapse_state` equal to `starting` and observes the branch
Guarantee: The activation-in-progress fast probe cadence is entered at least once
per campaign, so its handler-controlled predicate and its 50 ms interval are
exercised rather than assumed.
Check: `sometimes` — a marker at `runtime.rs:1130`, fired when the fixed interval
is selected. `sometimes` and not `reachable` because this is situation coverage: a
campaign can execute the health loop thousands of times, and even execute the
`if` at `:1129`, while never producing the operational state the branch
represents, which is a component that has published `starting` in its health
metrics. Line coverage of the conditional does not witness that state.
Fault/timing angle: the situation requires a real post-publication activation
window. `spawn_activation_task` (`:932`) runs `handler.activate()` with
deliberately no lifecycle deadline (`:981-983`), so the window's length is
component-determined.
Required faults and enabling state: a handler or composite whose `health` reports
a component with `metrics.storage_state == "starting"`, observed by the probe at
`:1092` before activation completes. `tests/activation.rs` is the natural host for
the fixture.
Confidence: high — [evidence](evidence/rt-a-the-activation-fast-probe-interval-is-entered.md).
Verified the predicate, both metric keys, the branch, and that a real composite
report populates `components`.
Existing check: none. Status `unaudited`.
Impact: if the situation is never produced, the 50 ms path and the predicate that
selects it ship unexercised, and the override in
`rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval` cannot be
measured at all.
Open questions: None.

---

## Group D: the configuration surface, frozen and mostly effective

Three records on the surface itself rather than on any one key. The first is that
every published field reaches a consumer, with one violator. The second is that
nothing changes value after `HostShared` construction, which is the assumption 55
or more records across the catalog rest on. The third is that the reserved pools
are correctly gated when nothing declares a reservation. Grouped because all
three are properties of the wiring rather than of any value, and because two of
the three are discharged by enumeration rather than by a fault.

### rt-a-every-published-configuration-field-changes-host-behaviour

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — nothing enumerates the fields against their consumers
Guarantee: Every field an embedder can set on `HostConfig`, `HostLimits`,
`HostTiming`, `LivenessPolicy`, or `HostInit` reaches at least one consumer, so
setting it changes some observable host behaviour.
Check: `always` — for each public configuration field, assert at least one read
site outside `config.rs` and outside a `Debug` implementation. `always` because
it is a property of the surface, evaluated once per field.
Fault/timing angle: none. This is a static property of the wiring.
Required faults and enabling state: none. The check is an enumeration, best
expressed as a test that names each field and its consumer, or as a review gate.
Confidence: high — [evidence](evidence/rt-a-every-published-configuration-field-changes-host-behaviour.md).
Grepped each of the 21 fields across the whole repository. One violator:
`HostInit::subc_capabilities` (`config.rs:250`), read nowhere, written as
`Vec::new()` at all four construction sites.
Existing check: none. Status `unaudited`.
Impact: an embedder who populates `subc_capabilities` believes it advertises
capabilities and it does nothing. Its `Debug` appearance at `config.rs:262` makes
it look load-bearing in diagnostics.
Open questions:
- Is `subc_capabilities` a placeholder for `magic-context-c50` work, in which
  case the record documents an accepted gap, or a wiring omission?
  `config.rs:246-247` says `HostInit` is "handed to the linked handler", so a
  handler outside this repository could read it. (needs human input)

> Synthesis note sharpening this record's `Impact:` with a fact lens B added,
> carried here rather than edited into it. `subc_capabilities` is not merely
> inert; it is **the one field the redaction impl does not redact**.
> `HostInit`'s hand-written `Debug` exists specifically to redact, because the
> comment at `config.rs:258-260` says the storage descriptor "can carry
> credentials or deployment secrets" so diagnostics get "presence and bounded
> structure only", and `:263` accordingly renders `storage` as `.is_some()`.
> Directly above it, `:262` renders `subc_capabilities` in full. Today that
> prints `[]` and leaks nothing, and `HostConfig` derives `Debug` (`:268`) so the
> render reaches any diagnostic that formats a `HostConfig`. So the first
> population of the field lands on the wrong side of conformance vector V24 by
> default, which is a stronger reason to record it than inertness alone.

### rt-a-configuration-is-frozen-for-the-incarnation

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test mutates a config after startup, because no API
permits it
Guarantee: No configured limit, deadline, or policy changes value between
`HostShared` construction and `run`'s return.
Check: `always` — capture `shared.limits`, `shared.timing`, and
`shared.liveness` immediately after `runtime.rs:927` and assert equality at
`run`'s return, and assert no interior mutability exists on those fields.
`always` because every config-dependent property in the catalog depends on it
holding continuously.
Fault/timing angle: none by construction. `limits`, `timing`, and `liveness` are
plain owned values on `HostShared` (`runtime.rs:96-98`), not behind a lock or
atomic, and `HostShared` is shared as `Arc` without interior mutability on those
fields.
Required faults and enabling state: none. The property is structural; the check
is a compile-time or review-level assertion rather than a runtime one.
Confidence: high — [evidence](evidence/rt-a-configuration-is-frozen-for-the-incarnation.md).
Verified the clone sites, the moved `init`, and that no read of `config` follows
`:926`.
Existing check: none. Status `unaudited`.
Impact: if a reload path were ever added, every sibling record that treats a
limit as constant would need re-verification. Recording it now fixes the
assumption explicitly instead of leaving it implicit in 55-plus records across
the catalog.
Open questions: None.

### rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `handler_contract.rs:636`
`zero_reservation_handlers_keep_single_pool_admission` and `:375`
`class_and_reservation_mismatches_fail_startup` cover the pair from the admission
side
Guarantee: When no linked module declares a reserved allocation, the reserved
admission pools hold zero permits and no route ever attempts to acquire from
them.
Check: `always-or-unreached` — assert that an acquisition against
`reserved_pending_permits` or `reserved_task_permits` occurs only for a route
whose class is `Reserved`, and that no such route exists when
`reservations.pending == 0`. `always-or-unreached` rather than `unreachable`,
because the pools are legitimately entered on a host that does declare a
reservation; the obligation is that entry is safe and correctly gated, not that
the code is dead.
Fault/timing angle: an acquisition against a zero-permit `Semaphore` blocks
forever rather than failing, so the failure mode is a permanently parked dispatch
task rather than an error. The gate is `build_target_index`'s class/reservation
agreement check at `runtime.rs:535-554`.
Required faults and enabling state: a manifest set whose declared `route_class`
disagrees with its reserved counts. `handler_contract.rs:378-388` constructs both
directions.
Confidence: high — [evidence](evidence/rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration.md).
Verified both construction sites, the agreement gate, and the doc comment at
`runtime.rs:117-121` that states the claim.
Existing check: two tests from the admission side; neither asserts the no-entry
half directly. Status `unaudited`.
Impact: a route that reaches a zero-permit pool parks indefinitely with no error
frame, which presents as a hung request rather than a refusal.
Open questions: None.

> Synthesis note on the doc comment this record cites, carried here rather than
> edited into it. The record's guarantee is conditional and therefore correct as
> written, but the comment at `runtime.rs:117-119` that it verifies against is
> **false in the composed production host**. The comment says the reserved pools
> are "Zero-permit when no module declared a reservation, and then unreachable
> because every route is general-class". `broca/mod.rs:164-177` declares
> `route_class: RouteClass::Reserved` with 96/96 counts (`broca/config.rs:185`,
> `:188`), `composite.rs:10-13` fixes the direct profile's tertiary as
> `broca/management_surface`, and `serve.rs:575` composes it. So the second
> clause is false and the first is true only of a composition that excludes
> Broca. Sub-part 2e's lens B reached the same verdict independently and both
> lenses report it as the fourth misleading comment in this crate; neither
> verified the three prior instances, so **the ordinal is inherited and
> unconfirmed** while the contradiction itself is verified.

---

## Group E: paths nobody owns

Two records on code that runs at startup and belongs to no test. The first is the
harness closure store, 1,122 lines whose only two production constructions
discard their error with `.ok()` in a file outside this crate. The second is the
pre-publication drain, the path a handler takes when it initialized successfully
and the host then never published a transport. Grouped because both are startup
paths whose failure is invisible, and because in both cases lens A's own
confidence or open question records that the answer lives outside this sub-part's
footprint.

### rt-a-a-closure-store-open-failure-is-classified-not-swallowed

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `tests/harness_closure.rs` covers `open` succeeding and
`validate`/`materialize` failing; no test exercises `open` failing on the
production path
Guarantee: A failure to open the harness closure store is reported with its
distinct cause, not collapsed into an absent store that silently selects a
different execution backend.
Check: `always` — whenever `HarnessClosureStore::open` returns `Err`, assert that
the resulting host startup carries a classified unavailability reason naming that
cause. `always` because every open failure must be classified; the store's
absence is a legitimate state, but an indistinguishable one is not.
Fault/timing angle: none timing-related. The window is startup. `open` fails on a
symlinked or non-owner-only ancestor, a wrong mode, a non-directory, or a
creation failure, each with a distinct `&'static str`
(`harness_closure.rs:1044`, `:1052`, `:1067`, `:1074`, `:1076`, and
`verify_owned_directory` at `:923`).
Required faults and enabling state: a
`${dataDir}/cortexkit/mc-host-harness-closures` path that is a symlink,
group-writable, or owned by another uid. `tests/instance_security.rs` already
builds hostile-path fixtures for the sibling walk in `instance.rs`.
Confidence: medium — [evidence](evidence/rt-a-a-closure-store-open-failure-is-classified-not-swallowed.md).
The `.ok()` at both sites and the distinct error strings are verified. Medium
because the two call sites are in
`crates/mc-module/src/bin/ck_mc_host/serve.rs`, outside this sub-part's
footprint, so I read only their immediate context and did not trace what the
downstream backend selection ultimately reports to an operator.
Existing check: none on the failure path. Status `unaudited`.
Impact: a permissions or symlink problem on the closure root presents as "no
harness available" rather than "the closure store is insecure", so an operator
investigates the wrong subsystem. This is Part 4f's silent-degradation shape.
Open questions:
- Does `harness_backend` (`serve.rs:344`) ultimately surface any distinguishable
  reason to an operator, or does the `None` terminate in a generic
  unavailability? Unresolved; needs the `mc-module` binary pass, which is outside
  this footprint.

### rt-a-an-initialized-handler-drains-without-publishing

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the bind and publish failure paths at `runtime.rs:836` and
`:842` have no fixture
Guarantee: The state in which a handler completed initialization and then drained
without the host ever publishing a transport occurs at least once per campaign,
so `PrePublicationCleanup::finish` runs against a fully initialized handler.
Check: `sometimes` — a marker inside `PrePublicationCleanup::finish`
(`runtime.rs:351`), fired only when initialization had returned `Ok`.
`sometimes` and not `reachable` because `finish` is also reached from the
initialization-failure arms at `:789` and `:803`, so a campaign can cover the
function's lines while never producing the operational state that matters: a
*successfully* initialized handler being drained with nothing published. That
distinction is exactly what `:821-825` says the grouping exists to protect.
Fault/timing angle: three entries. `bind_owner_only` failing at `:836`; `publish`
failing at `:843`; and the shutdown token already cancelled at `:831`, which
returns `Ok(None)` and drains through `:856`. The third is the cheapest to
construct.
Required faults and enabling state: for the cheapest form, cancel the shutdown
token between the return of `initialize` and the `is_cancelled` check at `:831`.
For the bind form, occupy or make unwritable the `setup.sock` path inside the
guard's directory. For the publish form, a connection-file write failure.
Confidence: high — [evidence](evidence/rt-a-an-initialized-handler-drains-without-publishing.md).
Verified all three entries, the shared `finish` path, and that `finish` demotes
the phase at `:355-357` before the drain.
Existing check: none. Status `unaudited`.
Impact: this path runs the handler shutdown callback for a handler that never
served a request, while the instance lock is still held. If the callback assumes
publication occurred, or assumes at least one connection existed, the failure
surfaces only here. It is also the path that decides whether a failed startup
leaves a lock behind.
Open questions: None.

---

## Relationship map

Grouped by shared mechanism rather than by the headings above, because the
sharpest relationships cross groups. **Every dominance statement below is a
hypothesis** about which oracle subsumes which, offered to order the work, not a
verified claim. None has been tested, and none can be tested by anything CI runs
today: this sub-part has zero CI-executed source-resident checks and zero
CI-named integration binaries, and the one CI-named binary that reaches these
files at all, `tests/lifecycle.rs`, is Part 2a's and tests lifecycle records
rather than the configuration contract.

- **One validator, three things it does not check.**
  [rt-a-no-configured-limit-is-silently-clamped](#rt-a-no-configured-limit-is-silently-clamped),
  [rt-a-startup-refuses-every-configuration-it-cannot-fund](#rt-a-startup-refuses-every-configuration-it-cannot-fund),
  [rt-a-the-ingress-pool-derivation-cannot-underflow](#rt-a-the-ingress-pool-derivation-cannot-underflow).
  `HostConfig::validate` checks each field in isolation and nothing else: no
  cross-field relationship, no handler-dependent feasibility, no arithmetic at
  the consumer. Hypothesis: an assertion battery placed at `runtime.rs:882`,
  immediately before `HostShared` construction, *dominates the second and third
  outright*, because both of their checks are stated at that exact site and the
  third's whole point is that its guard belongs at the consumer rather than 160
  lines earlier. It dominates the first **not at all**: no-silent-clamping is a
  property of `validate`'s return value, and a battery at the construction site
  runs only on configurations that already passed. The two need two oracles in
  two places, which is worth saying because they read as one cluster.
- **Two fixed bounds and the situation that measures one of them.**
  [rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval](#rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval),
  [rt-a-the-activation-fast-probe-interval-is-entered](#rt-a-the-activation-fast-probe-interval-is-entered),
  [rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline](#rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline),
  [rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline](#rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline).
  All four are the same shape at different sites, and protocol `:731` is the one
  rule all four bear on. Hypothesis: the fast-probe reachability record is a
  **strict prerequisite** of the fixed-probe-interval record rather than
  dominated by it, because the override cannot be measured until the situation is
  produced, and a `health_interval` distinguishable from 50 ms is the one fixture
  change both need (`tests/lifecycle.rs:165` currently sets exactly 50 ms, which
  makes the two branches inseparable). Hypothesis: nothing dominates across the
  three sites. A clamp on the 50 ms path says nothing about the shutdown chain, a
  `timeout_at` at `:1224` says nothing about `connection.rs:158`, and a
  cross-field check in `validate` cannot see any of the three, because all three
  multiply at the *consumer* rather than at the configuration boundary. That is
  the argument for a single review-level census of every `timeout` and
  `timeout_at` in the crate against the key each names, which would dominate all
  three as a static check while proving none of their runtime bounds.
- **The default configuration read from two directions.**
  [rt-a-the-default-configuration-arms-no-liveness-probe](#rt-a-the-default-configuration-arms-no-liveness-probe),
  [rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one](#rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one).
  Both are about what a default host can observe about its own health. The first
  is already `Exercised: yes`, uniquely in this catalog, because
  `tests/lifecycle.rs:496` asserts no Ping arrives within 500 ms. Hypothesis: it
  dominates **nothing**, and that is the interesting part: proving the probe is
  absent says nothing about whether the *other* health signal, the snapshot, is
  interpretable. Conversely the snapshot record needs a slow first `health`
  callback (`tests/lifecycle.rs:579` already builds one) and does not care about
  liveness at all. Two adjacent detection gaps with no shared oracle.
- **Two enumerations that fix assumptions the rest of the catalog rests on.**
  [rt-a-every-published-configuration-field-changes-host-behaviour](#rt-a-every-published-configuration-field-changes-host-behaviour),
  [rt-a-configuration-is-frozen-for-the-incarnation](#rt-a-configuration-is-frozen-for-the-incarnation).
  Neither needs a fault and both are discharged by reading the tree. Hypothesis:
  the frozen-configuration record *dominates every config-dependent record in
  every sibling sub-part* in the weak sense that it licenses their treatment of a
  limit as constant, and it is dominated by nothing, because no runtime oracle
  can observe the absence of a reload path that does not exist. The
  every-field record is the complement: it proves the surface is wired, and its
  one violator is the only field where an embedder's action has no effect. Worth
  building as one census pass, since both walk the same 21 fields.
- **Two startup paths whose failure is invisible.**
  [rt-a-a-closure-store-open-failure-is-classified-not-swallowed](#rt-a-a-closure-store-open-failure-is-classified-not-swallowed),
  [rt-a-an-initialized-handler-drains-without-publishing](#rt-a-an-initialized-handler-drains-without-publishing).
  Both run before any request is served and both are unobserved. Hypothesis: they
  dominate each other not at all, and they fail for opposite reasons. The closure
  record's oracle is blocked *outside* this sub-part, at `serve.rs:162` and
  `:349` where the `.ok()` discards a well-built closed error vocabulary, which
  is why it is the catalog's only `medium`. The drain record's oracle is
  constructible *inside* it, by cancelling the shutdown token between
  `initialize`'s return and the `is_cancelled` check at `:831`, which is the
  cheapest of its three entries. So one is cheap and unbuilt, the other is
  expensive and needs a pass nobody has scheduled.
- **The reserved pools, cited by three sub-parts.**
  [rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration](#rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration).
  Standing alone because its relationship is across parts rather than within
  this one. Its guarantee is conditional on no module declaring a reservation;
  Broca declares one, so 2e's
  [../part-2e-request-path/catalog.md#req-a-both-admission-classes-and-the-rejection-bound-saturate](../part-2e-request-path/catalog.md#req-a-both-admission-classes-and-the-rejection-bound-saturate)
  owns the live half, namely that reserved *task* exhaustion is constructed by no
  test. Hypothesis: 2e's five-state saturation campaign *dominates this record's
  entry half*, because a campaign that saturates the reserved task pool has
  necessarily observed that only `Reserved`-class routes acquire from it. It does
  not dominate the zero-permit half, which is about a composition that excludes
  Broca and which no in-tree production configuration produces.
