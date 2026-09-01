# Lens A — runtime assembly and the configuration contract

Sub-part `2f-runtime-and-config`. Attention focus: what is constructed, in what
order, with what defaults, and what a misconfiguration does. Claims and checks
belong to the sibling lens.

Code read at `e447c927` on `feat/shared-memory-release-gate-audit`. Scope files:
`runtime.rs` (1,344), `harness_closure.rs` (1,122), `config.rs` (674),
`lib.rs` (87), `file_mode.rs` (19). Every line reference below was verified
against that tree by extracting the cited line.

Two boundary files are cited but not mined: `connection.rs` (Part 2a's) for the
deadline consumers, and `crates/mc-module/src/bin/ck_mc_host/serve.rs` for the
sole production `HostConfig` construction site. Without the second, no
reachability label in this sub-part can be justified, because it is the only
non-test caller of `runtime::run`.

## Construction order and conditionality map

`run` (`runtime.rs:630`) delegates to `run_with_publish_hook` (`:641`). The
whole ordered sequence, with the condition each step is under. "Unconditional"
means: reached on every path that gets that far, with no config key, feature
flag, or `cfg` gating it.

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

Three conclusions siblings can rely on:

1. **Nothing in the host runtime is feature-gated or `cfg`-gated.** The only
   conditional construction in the entire sequence is `set_publish_hook`
   (test-only), the setup-socket bind/publish pair (skipped on an
   already-cancelled token), and the per-connection liveness loop.
2. **The activation task and the health task are unconditional.** A record
   about either is `default-production` regardless of configuration.
3. **The liveness loop is not reached in production.** Not merely
   `explicit-config-only`: the sole non-test caller of `run` never sets the
   policy. Records whose enabling state includes a `LivenessPolicy` are
   reachable only from `tests/lifecycle.rs:402` and `tests/client.rs:64`.

`harness_closure.rs` deserves a note because it is 35 percent of this
sub-part's lines. It is a self-contained content-addressed store with no
`#[cfg(test)]` module of its own and no in-crate constructor. Its production
consumers are `broca/pi.rs:49` and `broca/opencode.rs:40`, which hold an
`Arc<ValidatedHarnessClosure>` that someone else built. Its tests are
`crates/mc-host/tests/harness_closure.rs` and `tests/broca_subprocess.rs:853`,
plus one ignored qualification test driven by
`scripts/run-mc-host-closure-qualification.ts`. So its validation logic is
well covered as a library and completely unexercised as part of host startup.

## Configuration contract table

Documentation search: I grepped all of `docs/` for every key name in
`HostLimits`, `HostTiming`, `LivenessPolicy`, `HostInit`, and `HostConfig`.
**No file in `docs/` names any of them except `max_resident_bytes`**
(`docs/mc-host-wire-protocol.md:423`). There is no configuration reference
document. `config.rs:1-6` says so outright: CLI or config-file exposure
"belongs to the spawn/doctor integration (`magic-context-c50.8`), not this
crate." So the "documented default" column is answered from the protocol
specification's normative statements about the *behaviour* each key controls,
which is the only contract that exists.

Columns: code default; what `docs/mc-host-wire-protocol.md` says; the bound
`validate` enforces; and whether the key changes host behaviour.

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
  `max_handshakes`, `max_connections`, `max_routes`,
  `max_pending_requests`, `max_handler_tasks`, `route_close_budget`. These are
  not divergences; the specification says the host owns the number.
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
  relating them: host `frame_deadline` 30 s beside the client's 30 s (matching,
  so benign), host `shutdown_deadline` 10 s beside the client's 5 s, and host
  `writer_queue_frames` 64 beside the client's 256 + 32. The 10-versus-5 pair
  means a conforming client abandons cleanup while the host still drains.

Unenforced-bound observations, for the sibling lens:

- **`data_dir` has no length or shape validation.** Nothing in `config.rs`
  bounds it. Its practical bound is `AF_UNIX` `sun_path`, enforced only by
  `bind_owner_only` failing at `runtime.rs:836`, after validation passed and
  after the instance lock was taken.
- **`HostConfig::validate` performs no cross-field checks.** Not one. Every
  duration is validated in isolation against `MAX_CONFIG_DURATION`
  (`config.rs:356-363`), so `auth_deadline` and `transport_setup_deadline` can
  be set to any pair, and the sum that a peer actually faces is never computed.
- **Only two of eight startup gates live in `validate`.** The reservation
  feasibility gates (`runtime.rs:693`, `:698`, `:708`) and the resident floor
  (`:736`) are handler-dependent and therefore cannot live in `config.rs`. So
  "the config validated" never implies "this host can start."

## Observations

Ordered by leverage.

**O1. The fixed 50 ms probe interval overrides the configurable one.**
`runtime.rs:1129-1133` selects `Duration::from_millis(50)` whenever
`activation_in_progress(&report)` is true, otherwise `health_interval`. The
predicate (`:1051-1074`) is satisfied when any component's metrics carry
`storage_state == "starting"` or `synapse_state == "starting"`. Those strings
come from the handler's own health report. So a handler that keeps reporting
`starting` pins the host at a 20-probe-per-second cadence indefinitely, and the
operator's `health_interval` — settable to anything up to 365 days
(`config.rs:81`, `:360`) — has no effect for that whole period. This is the
shape Part 2a found with the 60-second freshness window: a hardcoded bound
governing an operator-settable one, in the same direction (the fixed value
wins), and here the switch is handler-controlled rather than host-controlled.

**O2. `transport_setup_deadline` is armed twice, serially.**
`connection.rs:158` wraps `ring.prepare` in
`timeout_at(Instant::now() + shared.timing.transport_setup_deadline, ...)`, and
`:177` passes `shared.timing.transport_setup_deadline` again to
`activate_server`. With `auth_deadline` consumed first at `:125`, the host's
serial pre-service budget at defaults is 2 + 2 + 2 = **6 seconds**, against a
documented client whole-handshake deadline of 2 s (`:737`). Part 2c's
`existing-checks.md:569-575` recorded this as "up to 4 seconds"; that figure
counts `transport_setup_deadline` once. Both sites arm it fresh, so the correct
figure is 6. This is a refinement of 2c's finding, not a new one, and I state it
as a correction rather than a separate discovery.

**O3. The forced shutdown path outlives `shutdown_deadline` by design.**
`runtime.rs:1148` computes one absolute deadline. When
`timeout_at(deadline, shared.tracker.wait())` fails at `:1214`, the code adds a
*second, fresh* budget: `lifecycle_callback_deadline.saturating_mul(2)` at
`:1223`, awaited at `:1224`. At defaults that is 60 s added after a 10 s
deadline already expired. The comment at `:1217-1222` explains why (a bind
wrapper chains two callbacks and the instance lock must outlive them), and the
reasoning is sound. What is unstated is that `shutdown_deadline` therefore does
not bound shutdown.

**O4. `subc_capabilities` is inert.** `config.rs:250` declares it `pub`;
`config.rs:262` formats it for `Debug`. Every construction site in the
repository passes `Vec::new()` — `serve.rs:487`,
`mc-module/tests/host_adapter.rs:29` and `:88`,
`mc-module/examples/direct_host_fixture.rs:577`. No code reads it. It reaches
the handler inside the moved `HostInit` (`runtime.rs:751`), so a future handler
could read it, but none does.

**O5. The ingress subtraction is unchecked and its guard is 160 lines away.**
`runtime.rs:896-902` computes
`max_resident_bytes − EGRESS_RESERVED − SCRATCH_RESERVED − catalog_resident − retained_bytes`
with plain `-`. Its only protection is the gate at `:736`, which requires
`max_resident_bytes >= MIN_RESIDENT_BYTES + catalog + retained`, and
`MIN_RESIDENT_BYTES` is by construction
`MAX_BODY_LEN + EGRESS_RESERVED + SCRATCH_RESERVED` (`config.rs:23-24`). The
arithmetic is correct: the result is always at least `MAX_BODY_LEN`. There is no
assertion at the subtraction site, and no test asserts the relationship between
`config.rs:23` and `runtime.rs:896`. If either changed independently, a release
build would wrap the `u64` and hand a colossal value to `ByteBudget::new`, whose
`max_bytes as usize` and `Semaphore::new` (`wire.rs:394-399`) would then panic
inside `HostShared` construction — after publication.

**O6. The seeded health snapshot is `Degraded`.** `runtime.rs:889-893` seeds
`status: Degraded, detail: None, metrics: Some({"components": {}})`. That value
is read directly by the authenticated `host.status` handler
(`connection.rs:691-695`). The health task is spawned at `:933`, one line before
`accept_loop` at `:934`, so a client can be served before the first probe
returns. The probe is bounded only by `lifecycle_callback_deadline`, 30 s at
defaults. The empty `components` map does distinguish the seed, because
`build_target_index` requires one to three manifests (`:500`) and
`composite.rs:334-348` emits one entry per component, so a real report is never
empty. Nothing asserts that, and no field marks "not yet probed."

**O7. Nothing silently clamps a limit or a duration.** Every out-of-range value
in `config.rs` returns a `ConfigError` naming the offending key
(`:158`, `:161`, `:169`, `:176`, `:187`, `:358`, `:361`), and every `Display`
arm prints the configured and maximum values (`:420-457`). The one silent
narrowing in this sub-part is `file_mode::raw_mode` (`file_mode.rs:18`), which
masks with `0o7777`. Its doc comment (`:12-15`) states the mask documents a
range rather than narrowing a value that could exceed it, and within
`harness_closure.rs` that holds: `validate_manifest` constrains `mode` to
exactly `0o600` or `0o700` (`:284-286`) before `copy_node` (`:704`) or
`write_new_file` (`:979`) reach it. The invariant is asserted in prose only, and
the function is `pub(crate)`, shared with `generation.rs`, which is Part 2a's
file and outside my footprint.

**O8. A closure-store open failure is swallowed into `None`.**
`serve.rs:162` and `:349` both write
`HarnessClosureStore::open(&closure_root).ok()`. `open` fails on a symlinked or
non-owner-only path component, a wrong mode, or a creation failure
(`harness_closure.rs:1019-1086`, all mapped through `invalid(...)` with a
distinct `&'static str`). Every one of those distinct reasons collapses to
`None`, and the downstream `harness_backend` then selects a different execution
path. This is exactly the shape Part 4f named: a malformed configuration
resolving silently to a degraded default that disables a subsystem, with the
diagnostic discarded at the call site.

**O9. The panic hook is installed before the config is validated.**
`runtime.rs:647` precedes `:648`. A `run` that returns
`HostError::Config` has still mutated a process-global. It is `Once`-guarded
(`panic_boundary.rs:39`) and inert without a `CallbackPollGuard`
(`panic_boundary.rs:42`), so the impact is confined to capturing whichever
`take_hook` was installed at that first call. Recorded as an ordering fact, not
promoted to a record.

**O10. Configuration is frozen at `HostShared` construction.**
`runtime.rs:884-886` clones `limits`, `timing`, and `liveness` into the shared
struct; `:926` clones `daemon_ver`; `:751` moves `init` out entirely. After
`:927` no code reads `config`. There is no reload path, no watch, no
`RwLock<HostConfig>`. Every config-dependent property in every sibling sub-part
can treat its value as constant for the incarnation.

**O11. `scratch_budget` and `egress_budget` are not configurable at all.**
`runtime.rs:903-904` passes the constants `SCRATCH_RESERVED_BYTES` (184,616,192)
and `EGRESS_RESERVED_BYTES` (67,108,885). Raising `max_resident_bytes` grows
only the admission pool. `config.rs:113-117` states this, and
`config.rs:520-548` pins it in a test. Worth restating because an operator
reading "aggregate bytes simultaneously resident" (`config.rs:103`) would
reasonably expect all three pools to scale.

**O12. Arithmetic check of the byte constants.** Verified by computation from
`wire.rs:28` (`HEADER_LEN = 21`) and `wire.rs:371` / `:35`
(`MAX_BODY_LEN = 67,108,864`): `EGRESS_RESERVED_BYTES` = 67,108,885,
`SCRATCH_RESERVED_BYTES` = 184,616,192, `MIN_RESIDENT_BYTES` = 318,833,941
(304 MiB), default `max_resident_bytes` = 385,942,805 (368 MiB), admission pool
at defaults before catalog and retained subtraction = 134,217,728, exactly
2 × `MAX_BODY_LEN`. Headroom to the validated ceiling is 3,909,024,490 on a
64-bit target and 150,928,106 on a 32-bit one, where
`Semaphore::MAX_PERMITS` = 536,870,911 binds instead of `u32::MAX`. So a 32-bit
deployment declaring more than about 144 MiB of retained bytes fails startup at
`runtime.rs:736`, and nothing documents that the ceiling is target-dependent.

## Candidate properties

### rt-a-startup-refuses-every-configuration-it-cannot-fund

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `handler_contract.rs:323` `reservations_must_leave_one_general_slot_in_each_pool`, `:375` `class_and_reservation_mismatches_fail_startup`, `:408` `parked_general_task_bound_must_leave_one_free_slot`, and `:437` `retained_declaration_raises_the_resident_floor_exactly` each cover one gate; the joint postcondition at the construction site is unasserted
Guarantee: If `run` reaches `HostShared` construction, every permit count and byte quantity it computes is non-negative, within `Semaphore::MAX_PERMITS`, and leaves at least one maximum request body of ingress headroom.
Check: `always` — at `runtime.rs:882`, assert `max_pending_requests > reservations.pending`, `max_handler_tasks > reservations.tasks`, `general_task_holds < max_handler_tasks - reservations.tasks`, and `max_resident_bytes >= MIN_RESIDENT_BYTES + catalog_resident + retained_bytes`. `always` rather than `always-or-unreached` because this construction is on every successful startup path with no condition, per the map above.
Fault/timing angle: none. Startup is single-threaded here and the inputs are fixed by the time the gates run.
Required faults and enabling state: a handler whose `resource_declarations` sum approaches or exceeds a configured limit. `handler_contract.rs:302-320` already builds one.
Confidence: high — [evidence](../evidence/rt-a-startup-refuses-every-configuration-it-cannot-fund.md). I traced all eight gates and verified each line, and computed the byte arithmetic independently.
Existing check: four tests, each covering one gate; none asserts the conjunction at the use site. Status `unaudited`.
Impact: a wrapped subtraction at `runtime.rs:896-912` reaching `Semaphore::new` or `ByteBudget::new` panics during `HostShared` construction, after the transport is published, so a client can discover a dead endpoint.
Open questions: None.

### rt-a-the-ingress-pool-derivation-cannot-underflow

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test relates `config.rs:23-24` to `runtime.rs:896-902`; `config.rs:520-548` asserts the floor decomposition but never the runtime subtraction
Guarantee: The unchecked subtraction that derives `ingress_budget` never underflows, and its result is never below one `MAX_BODY_LEN`.
Check: `always` — immediately before `runtime.rs:896`, assert `max_resident_bytes >= EGRESS_RESERVED_BYTES + SCRATCH_RESERVED_BYTES + catalog_resident + retained_bytes + MAX_BODY_LEN`. `always` because the subtraction is unconditional; the guard being 160 lines earlier is exactly why the assertion belongs at the consumer.
Fault/timing angle: none, but the coupling is a maintenance window rather than a runtime one: any independent edit to `MIN_RESIDENT_BYTES` or to the subtrahend list breaks it silently in release builds.
Required faults and enabling state: a `max_resident_bytes` exactly at the handler-dependent floor, plus a non-zero `retained_resident_bytes` declaration and a non-trivial catalog. `handler_contract.rs:437` constructs the floor case.
Confidence: high — [evidence](../evidence/rt-a-the-ingress-pool-derivation-cannot-underflow.md). Verified the gate, the constant's definition, and the arithmetic; confirmed `ByteBudget::new` casts and would panic.
Existing check: `config.rs:520-548` `the_resident_cap_splits_into_three_non_overlapping_pools` covers the constant decomposition only. Status `unaudited`.
Impact: release-mode `u64` wrap producing a near-`u64::MAX` budget, then a panic inside `Semaphore::new` after publication.
Open questions: None.

### rt-a-no-configured-limit-is-silently-clamped

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `config.rs:503`, `:551`, `:565`, `:577`, `:604`, `:637`, `:647` cover rejection for individual keys; no test asserts that no path clamps
Guarantee: An out-of-range limit or duration is rejected with an error naming the offending key, never clamped to a bound the caller cannot observe.
Check: `always` — for every field of `HostLimits`, `HostTiming`, and `LivenessPolicy`, set it one step outside its bound and assert `validate` returns `Err` whose `Display` names that field, and that no accepted `HostConfig` differs from the submitted one in any field. `always` because it must hold on every validation.
Fault/timing angle: none.
Required faults and enabling state: none. Pure function of a constructed `HostConfig`.
Confidence: high — [evidence](../evidence/rt-a-no-configured-limit-is-silently-clamped.md). Read every branch of both validators and every `Display` arm. The one silent narrowing found is `file_mode.rs:18`, outside `HostConfig`.
Existing check: seven unit tests in `config.rs`, per key, not exhaustive over fields. Status `unaudited`.
Impact: an operator who sets a value and gets a different one silently loses the ability to reason about the host's capacity, which is the premise of `config.rs:87-88`.
Open questions:
- `file_mode::raw_mode` is `pub(crate)` and shared with `generation.rs`, which is Part 2a's file. Whether that caller upholds the "already within `0o7777`" precondition is unverified from here. (needs Part 2a)

### rt-a-the-default-configuration-arms-no-liveness-probe

Type: safety
Reachability: default-production
Status: active
Exercised: yes — `tests/lifecycle.rs:496` `liveness_is_disabled_by_default` asserts no Ping arrives within 500 ms on a default host
Guarantee: With `liveness` unset, the host arms no Ping timer, sends no Ping, and never invalidates a connection for a missing Pong.
Check: `always` — whenever `shared.liveness.is_none()`, assert no `liveness_loop` task was spawned for any generation, and no frame of type `Ping` was ever enqueued. `always` because the absence must hold for the whole incarnation, not merely at one observation.
Fault/timing angle: the window is the whole incarnation. A default host cannot detect a silently wedged peer through Ping at all; peer death is discovered only by the ring's own path.
Required faults and enabling state: a default `HostConfig`. That is the production configuration.
Confidence: high — [evidence](../evidence/rt-a-the-default-configuration-arms-no-liveness-probe.md). Verified `config.rs:294`, the single spawn condition at `connection.rs:279`, and that `serve.rs:582-593` reaches `HostConfig::default` for this field.
Existing check: `tests/lifecycle.rs:496`. Status `unaudited`.
Impact: this is the reachability label for every liveness property in the catalog. Any record whose enabling state is a `LivenessPolicy` is reachable only from `tests/lifecycle.rs:402` or `tests/client.rs:64`, never from production.
Open questions:
- `config.rs:236-238` says `invalidate_on_missed` stays `false` until `magic-context-c50.4`. `tests/client.rs:67` sets it `true`. So the only code path that ever invalidates on a missed Pong is a test. Whether that is intended coverage of a future default or an accidental divergence from the stated policy is a design question. (needs human input)

### rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `tests/lifecycle.rs:165` sets `health_interval` to 50 ms, which coincides with the hardcoded value and therefore cannot distinguish the two branches
Guarantee: The health probe cadence is either the configured `health_interval` or the fixed 50 ms activation cadence, and which one applies is a stated function of the component-reported activation state rather than an unbounded override of operator configuration.
Check: `always` — at `runtime.rs:1129`, assert that the selected interval equals `health_interval` whenever `activation_in_progress` is false, and record the number of consecutive iterations that selected 50 ms so a campaign can bound it. `always` because the selection happens on every loop iteration.
Fault/timing angle: the window is unbounded. The predicate at `:1051-1074` is driven entirely by handler-authored strings in the previous report's metrics, so nothing in the host limits how long the fixed cadence persists. A handler that never leaves `starting` holds it forever.
Required faults and enabling state: a handler whose `health` report carries `metrics.components.<id>.metrics.storage_state == "starting"` or `synapse_state == "starting"`, plus a `health_interval` distinguishable from 50 ms. `tests/lifecycle.rs:165` must change its value to make the two branches separable.
Confidence: high — [evidence](../evidence/rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval.md). Verified the branch, the predicate, the single `health_interval` consumer, and that `MAX_CONFIG_DURATION` admits 365 days.
Existing check: none that separates the branches. Status `unaudited`.
Impact: an operator who raises `health_interval` to reduce probe load gets no relief while any component reports `starting`, and 20 handler callbacks per second continue. This is Part 2a's hardcoded-60-second shape in the same direction.
Open questions:
- Should the fast cadence carry its own bound, or is an unbounded handler-controlled override intended? (needs human input)

### rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — 2c's `fault-map.md:180` reaches one of the two `transport_setup_deadline` sites; nothing measures the serial sum
Guarantee: The host's total pre-service budget for one accepted socket is a stated function of the configured deadlines, and the specification's coupling warning accounts for every stage that consumes one.
Check: `always` — measure wall-clock from `run_connection` entry (`connection.rs:115`) to the return of `activate_server` (`:177`) on a peer that stalls maximally at each stage, and assert the total is at most `auth_deadline + 2 * transport_setup_deadline`. `always` because the bound must hold on every accepted socket.
Fault/timing angle: three serial windows: `auth_deadline` at `:125`, `transport_setup_deadline` at `:158` for `prepare`, and `transport_setup_deadline` again at `:177` for `activate_server`. At defaults that is 6 s against a documented client budget of 2 s.
Required faults and enabling state: a peer that stalls inside authentication, then inside descriptor transfer. 2c's `fault-map.md:52` describes the fixture and notes it does not exist.
Confidence: high — [evidence](../evidence/rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline.md). Verified all three sites and confirmed `HostConfig::validate` performs no cross-field check.
Existing check: none. Part 2c's `existing-checks.md:569-575` records the coupling as a documentation gap with the figure 4 s. Status `unaudited`.
Impact: a client conforming to the documented 2 s handshake deadline abandons a host that is still inside a budget the host considers valid, producing an `outcome_unknown` class the specification's coupling note was written to prevent.
Open questions: None.

### rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/lifecycle.rs:714-715` sets both `lifecycle_callback_deadline` and `shutdown_deadline`, so the forced path is reachable; no assertion bounds the total
Guarantee: `run` returns within a stated function of the configured deadlines, and that function is documented wherever `shutdown_deadline` is described.
Check: `always` — from the shutdown token's cancellation to `run`'s return on the forced path, assert elapsed time is at most `shutdown_deadline + 2 * lifecycle_callback_deadline`. `always` because it must hold on every forced shutdown, and stated in the units the code bounds (`runtime.rs:1148` and `:1223`).
Fault/timing angle: `:1214` fails, then `:1224` awaits a second, fresh budget computed at `:1223` as `lifecycle_callback_deadline.saturating_mul(2)`. At defaults, 60 s added after a 10 s deadline expired. `saturating_mul` means a `lifecycle_callback_deadline` above half of `MAX_CONFIG_DURATION` yields a budget the validator would itself reject.
Required faults and enabling state: a tracked task that survives the shutdown deadline. `tests/lifecycle.rs:678` and `:714` build the non-yielding-callback shape.
Confidence: high — [evidence](../evidence/rt-a-forced-shutdown-outlives-the-configured-shutdown-deadline.md). Verified both deadline sites and read the justifying comment at `:1217-1222`.
Existing check: none bounding the total. Status `unaudited`.
Impact: a supervisor that budgets `shutdown_deadline` for a stop, plus the documented client 5 s, kills the host during a cleanup phase the host considers in-budget, which is precisely the window `:1217-1222` says must not be interrupted.
Open questions:
- `saturating_mul(2)` can produce a duration the validator rejects as an input. Whether the derived budget should be clamped to `MAX_CONFIG_DURATION` is unresolved. It cannot overflow, so this is a coherence question rather than a defect.

### rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads `host.status` before the first probe completes
Guarantee: An authenticated `host.status` served before any health probe has completed is distinguishable from one reporting a genuinely degraded component.
Check: `always` — whenever the `host.status` response reports `degraded`, assert that either `metrics.components` is non-empty or an explicit not-yet-probed marker is present. `always` because a client may read the snapshot at any moment, including the first.
Fault/timing angle: the window opens at `runtime.rs:933`, when the health task is spawned, and closes when the first probe stores a report at `:1120-1123`. `accept_loop` starts one line later at `:934`, so the window is genuinely client-visible, and it lasts up to `lifecycle_callback_deadline` (30 s at defaults) under a slow `handler.health`.
Required faults and enabling state: a handler whose first `health` call blocks, plus a client that authenticates and issues `host.status` inside that window. `tests/lifecycle.rs:579` already builds a slow-callback handler.
Confidence: high — [evidence](../evidence/rt-a-an-unprobed-health-snapshot-is-distinguishable-from-a-degraded-one.md). Verified the seed, the reader, the spawn ordering, and that a real report always carries at least one component.
Existing check: none. Status `unaudited`.
Impact: a supervisor gating traffic on `host.status` reads `degraded` from a healthy host and may withhold traffic or restart it. The distinguishing signal exists but is incidental and unasserted, so a change to either the seed or the composite's report shape removes it silently.
Open questions: None.

### rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `handler_contract.rs:636` `zero_reservation_handlers_keep_single_pool_admission` and `:375` `class_and_reservation_mismatches_fail_startup` cover the pair from the admission side
Guarantee: When no linked module declares a reserved allocation, the reserved admission pools hold zero permits and no route ever attempts to acquire from them.
Check: `always-or-unreached` — assert that an acquisition against `reserved_pending_permits` or `reserved_task_permits` occurs only for a route whose class is `Reserved`, and that no such route exists when `reservations.pending == 0`. `always-or-unreached` rather than `unreachable`, because the pools are legitimately entered on a host that does declare a reservation; the obligation is that entry is safe and correctly gated, not that the code is dead.
Fault/timing angle: an acquisition against a zero-permit `Semaphore` blocks forever rather than failing, so the failure mode is a permanently parked dispatch task rather than an error. The gate is `build_target_index`'s class/reservation agreement check at `runtime.rs:535-554`.
Required faults and enabling state: a manifest set whose declared `route_class` disagrees with its reserved counts. `handler_contract.rs:378-388` constructs both directions.
Confidence: high — [evidence](../evidence/rt-a-reserved-pools-are-zero-permit-and-unentered-without-a-declaration.md). Verified both construction sites, the agreement gate, and the doc comment at `runtime.rs:117-121` that states the claim.
Existing check: two tests from the admission side; neither asserts the no-entry half directly. Status `unaudited`.
Impact: a route that reaches a zero-permit pool parks indefinitely with no error frame, which presents as a hung request rather than a refusal.
Open questions: None.

### rt-a-every-published-configuration-field-changes-host-behaviour

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — nothing enumerates the fields against their consumers
Guarantee: Every field an embedder can set on `HostConfig`, `HostLimits`, `HostTiming`, `LivenessPolicy`, or `HostInit` reaches at least one consumer, so setting it changes some observable host behaviour.
Check: `always` — for each public configuration field, assert at least one read site outside `config.rs` and outside a `Debug` implementation. `always` because it is a property of the surface, evaluated once per field.
Fault/timing angle: none. This is a static property of the wiring.
Required faults and enabling state: none. The check is an enumeration, best expressed as a test that names each field and its consumer, or as a review gate.
Confidence: high — [evidence](../evidence/rt-a-every-published-configuration-field-changes-host-behaviour.md). Grepped each of the 21 fields across the whole repository. One violator: `HostInit::subc_capabilities` (`config.rs:250`), read nowhere, written as `Vec::new()` at all four construction sites.
Existing check: none. Status `unaudited`.
Impact: an embedder who populates `subc_capabilities` believes it advertises capabilities and it does nothing. Its `Debug` appearance at `config.rs:262` makes it look load-bearing in diagnostics.
Open questions:
- Is `subc_capabilities` a placeholder for `magic-context-c50` work, in which case the record documents an accepted gap, or a wiring omission? `config.rs:246-247` says `HostInit` is "handed to the linked handler", so a handler outside this repository could read it. (needs human input)

### rt-a-configuration-is-frozen-for-the-incarnation

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test mutates a config after startup, because no API permits it
Guarantee: No configured limit, deadline, or policy changes value between `HostShared` construction and `run`'s return.
Check: `always` — capture `shared.limits`, `shared.timing`, and `shared.liveness` immediately after `runtime.rs:927` and assert equality at `run`'s return, and assert no interior mutability exists on those fields. `always` because every config-dependent property in the catalog depends on it holding continuously.
Fault/timing angle: none by construction. `limits`, `timing`, and `liveness` are plain owned values on `HostShared` (`runtime.rs:96-98`), not behind a lock or atomic, and `HostShared` is shared as `Arc` without interior mutability on those fields.
Required faults and enabling state: none. The property is structural; the check is a compile-time or review-level assertion rather than a runtime one.
Confidence: high — [evidence](../evidence/rt-a-configuration-is-frozen-for-the-incarnation.md). Verified the clone sites, the moved `init`, and that no read of `config` follows `:926`.
Existing check: none. Status `unaudited`.
Impact: if a reload path were ever added, every sibling record that treats a limit as constant would need re-verification. Recording it now fixes the assumption explicitly instead of leaving it implicit in 55-plus records across the catalog.
Open questions: None.

### rt-a-a-closure-store-open-failure-is-classified-not-swallowed

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `tests/harness_closure.rs` covers `open` succeeding and `validate`/`materialize` failing; no test exercises `open` failing on the production path
Guarantee: A failure to open the harness closure store is reported with its distinct cause, not collapsed into an absent store that silently selects a different execution backend.
Check: `always` — whenever `HarnessClosureStore::open` returns `Err`, assert that the resulting host startup carries a classified unavailability reason naming that cause. `always` because every open failure must be classified; the store's absence is a legitimate state, but an indistinguishable one is not.
Fault/timing angle: none timing-related. The window is startup. `open` fails on a symlinked or non-owner-only ancestor, a wrong mode, a non-directory, or a creation failure, each with a distinct `&'static str` (`harness_closure.rs:1044`, `:1052`, `:1067`, `:1074`, `:1076`, and `verify_owned_directory` at `:923`).
Required faults and enabling state: a `${dataDir}/cortexkit/mc-host-harness-closures` path that is a symlink, group-writable, or owned by another uid. `tests/instance_security.rs` already builds hostile-path fixtures for the sibling walk in `instance.rs`.
Confidence: medium — [evidence](../evidence/rt-a-a-closure-store-open-failure-is-classified-not-swallowed.md). The `.ok()` at both sites and the distinct error strings are verified. Medium because the two call sites are in `crates/mc-module/src/bin/ck_mc_host/serve.rs`, outside this sub-part's footprint, so I read only their immediate context and did not trace what the downstream backend selection ultimately reports to an operator.
Existing check: none on the failure path. Status `unaudited`.
Impact: a permissions or symlink problem on the closure root presents as "no harness available" rather than "the closure store is insecure", so an operator investigates the wrong subsystem. This is Part 4f's silent-degradation shape.
Open questions:
- Does `harness_backend` (`serve.rs:344`) ultimately surface any distinguishable reason to an operator, or does the `None` terminate in a generic unavailability? Unresolved; needs the `mc-module` binary pass, which is outside this footprint.

### rt-a-the-activation-fast-probe-interval-is-entered

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — no test constructs a component report carrying `storage_state` or `synapse_state` equal to `starting` and observes the branch
Guarantee: The activation-in-progress fast probe cadence is entered at least once per campaign, so its handler-controlled predicate and its 50 ms interval are exercised rather than assumed.
Check: `sometimes` — a marker at `runtime.rs:1130`, fired when the fixed interval is selected. `sometimes` and not `reachable` because this is situation coverage: a campaign can execute the health loop thousands of times, and even execute the `if` at `:1129`, while never producing the operational state the branch represents, which is a component that has published `starting` in its health metrics. Line coverage of the conditional does not witness that state.
Fault/timing angle: the situation requires a real post-publication activation window. `spawn_activation_task` (`:932`) runs `handler.activate()` with deliberately no lifecycle deadline (`:981-983`), so the window's length is component-determined.
Required faults and enabling state: a handler or composite whose `health` reports a component with `metrics.storage_state == "starting"`, observed by the probe at `:1092` before activation completes. `tests/activation.rs` is the natural host for the fixture.
Confidence: high — [evidence](../evidence/rt-a-the-activation-fast-probe-interval-is-entered.md). Verified the predicate, both metric keys, the branch, and that a real composite report populates `components`.
Existing check: none. Status `unaudited`.
Impact: if the situation is never produced, the 50 ms path and the predicate that selects it ship unexercised, and the override in `rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval` cannot be measured at all.
Open questions: None.

### rt-a-an-initialized-handler-drains-without-publishing

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the bind and publish failure paths at `runtime.rs:836` and `:842` have no fixture
Guarantee: The state in which a handler completed initialization and then drained without the host ever publishing a transport occurs at least once per campaign, so `PrePublicationCleanup::finish` runs against a fully initialized handler.
Check: `sometimes` — a marker inside `PrePublicationCleanup::finish` (`runtime.rs:351`), fired only when initialization had returned `Ok`. `sometimes` and not `reachable` because `finish` is also reached from the initialization-failure arms at `:789` and `:803`, so a campaign can cover the function's lines while never producing the operational state that matters: a *successfully* initialized handler being drained with nothing published. That distinction is exactly what `:821-825` says the grouping exists to protect.
Fault/timing angle: three entries. `bind_owner_only` failing at `:836`; `publish` failing at `:843`; and the shutdown token already cancelled at `:831`, which returns `Ok(None)` and drains through `:856`. The third is the cheapest to construct.
Required faults and enabling state: for the cheapest form, cancel the shutdown token between the return of `initialize` and the `is_cancelled` check at `:831`. For the bind form, occupy or make unwritable the `setup.sock` path inside the guard's directory. For the publish form, a connection-file write failure.
Confidence: high — [evidence](../evidence/rt-a-an-initialized-handler-drains-without-publishing.md). Verified all three entries, the shared `finish` path, and that `finish` demotes the phase at `:355-357` before the drain.
Existing check: none. Status `unaudited`.
Impact: this path runs the handler shutdown callback for a handler that never served a request, while the instance lock is still held. If the callback assumes publication occurred, or assumes at least one connection existed, the failure surfaces only here. It is also the path that decides whether a failed startup leaves a lock behind.
Open questions: None.

## Contract-vs-code leads

**L1. §11's no-multiplication rule versus two multiplying sites.**
`docs/mc-host-wire-protocol.md:731` states: "Every operation owns one absolute
deadline; per-stage timers MUST NOT multiply it." Two sites multiply.
`runtime.rs:1223` computes
`shared.timing.lifecycle_callback_deadline.saturating_mul(2)` and awaits it
*after* the absolute `shutdown_deadline` at `:1148` already expired.
`connection.rs:158` and `:177` each arm `transport_setup_deadline` fresh, so one
configured duration bounds two serial stages. Both have written justifications
in code (`runtime.rs:1217-1222`, and the ownership comment at
`connection.rs:113-114`). The specification's rule admits no exception. Not
resolved in favour of the document: the code's reasons are sound, and the
likelier defect is in the rule's scope.

**L2. §11:747's coupling warning under-counts the host's stages.**
`docs/mc-host-wire-protocol.md:747` warns that the client's 2 s whole-handshake
deadline and the host's 2 s authentication deadline "are not independent," and
tells a deployment to raise the client value. It names one host stage. The host
has three (`connection.rs:125`, `:158`, `:177`), totalling 6 s at defaults.
Part 2c recorded this with the figure 4 s
(`part-2c-setup-identity/existing-checks.md:569-575`); the correct figure is 6.
Nothing in `HostConfig::validate` relates any of the four values.

**L3. The host `shutdown_deadline` and the documented client shutdown deadline
disagree by 2×.** `docs/mc-host-wire-protocol.md:741` gives the managed client
"one 5 s absolute deadline" for shutdown and cleanup. `config.rs:228` gives the
host 10 s, and the forced path adds up to 60 s more (`runtime.rs:1223`). A
conforming client therefore abandons cleanup while the host is still draining
in-budget. The specification never states the relationship, and §12
(`:749-757`) describes the host's obligations without a value.

**L4. There is no configuration reference document.** Every capacity and
deadline that decides what the host *is* is undocumented outside `config.rs`
doc comments. `config.rs:1-6` states this is intentional and defers exposure to
`magic-context-c50.8`. The consequence is that 10 of 21 keys are
undocumented-but-effective, and the protocol specification is being used as a
configuration contract it was not written to be. Recorded so a later pass does
not read the absence as an oversight.

**L5. `config.rs:236-238` states a policy that a test violates.** The comment
says `invalidate_on_missed` "stays `false` until the raw Rust historian client
can answer Ping (`magic-context-c50.4`); enabling it before then would kill
healthy long-running awaits". `tests/client.rs:67` sets it `true`. Part 2a
already cites this comment in
`evidence/slow-egress-alone-does-not-retire-a-probed-generation.md:67-69`; the
new fact is that the flag's only `true` value in the repository is in a test,
so the code path the policy forbids is the only one exercised.

**L6. `config.rs:325` validates against a placeholder socket path.**
`HostConfig::validate` sizes the published connection file using
`setup_socket: "/tmp/mc-host.sock"`, 17 bytes. The real value is
`guard.dir_path().join("setup.sock")` (`runtime.rs:834`), derived from an
operator-settable and unvalidated `data_dir`. So the validated size is a proxy
for the published one. I investigated and it is currently safe, for two
independent reasons: `MAX_AUTH_MESSAGE_LEN` is 4,096 and binds long before
`MAX_CONNECTION_FILE_LEN`'s 65,536 (`connection_file.rs:30`), and the socket
path is bounded by `AF_UNIX` `sun_path` at roughly 108 bytes, enforced by
`bind_owner_only` failing. Neither reason is stated at `config.rs:322-332`, and
`MAX_CONNECTION_FILE_LEN` is enforced only on the read path
(`connection_file.rs:187-197`), never on the write. Recorded as an unasserted
margin rather than promoted to a record.

## Open questions

- Is the 50 ms activation probe cadence meant to have no bound, and no
  interaction with `health_interval` at all? `runtime.rs:1129-1133` gives the
  handler unilateral control over the host's probe rate. (needs human input)
- Should `HostConfig::validate` gain the one cross-field check the
  specification asks for, relating `auth_deadline + 2 * transport_setup_deadline`
  to a client budget? It cannot know the client's value, which may be why none
  exists. (needs human input)
- Is `HostInit::subc_capabilities` a placeholder or an omission? (needs human
  input; see the record's open question)
- `harness_closure.rs` is 1,122 lines with no in-crate constructor and no
  `#[cfg(test)]` module. Its production `open` sites are in `mc-module`, both
  with `.ok()`. Does the sub-part boundary in
  `part-2-rescope/scope-map-and-risk-ranking.md:643` intend for those two call
  sites to be cataloged here, or left to a `mc-module` binary pass that is not
  currently scheduled? As written, nobody owns them. (needs human input)
- The 32-bit ceiling is `Semaphore::MAX_PERMITS` = 536,870,911, not `u32::MAX`
  (`config.rs:185`), so a 32-bit deployment declaring more than about 144 MiB of
  retained bytes fails startup at `runtime.rs:736`. Is any 32-bit target
  supported? If not, the `min` at `:185` and its comment at `:181-184` are dead
  and could say so. Unresolved; I did not find a target list.
- Part 2a's `existing-checks.md` and this lens both touch `connection.rs:125`
  and `:158`. I cited them as deadline consumers only and mined no
  `connection.rs` behaviour. Confirm no double-cataloging before synthesis.
