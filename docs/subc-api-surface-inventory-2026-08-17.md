# Historical `subc` API Surface Inventory

Task: `magic-context-c50.1` (epic `magic-context-c50`, hand-rolled Rust module host)
Date: 2026-08-17
Plan: `docs/plans-archive/2026-08-17-0505-subc-api-surface-spike-plan.md`
Final disposition: direct migration completed by the direct `mc-host` boundary plan dated 2026-08-24.

## Final decision

`mc-host` is the single production authority for wire, authentication, discovery, control, routing, component lifecycle, and managed Rust clients. `mc-module` implements the host-owned component contract directly. Production Rust and TypeScript callers use host-owned APIs. No `subc-*` compatibility crate, alias, shim, published dependency, provider process, or fallback API is recommended or supported.

The inventories below and `docs/evidence/subc-compiler-closure/` remain historical proof of the surface that the migration had to close. `docs/evidence/subc-surface-probe/` remains an excluded historical crate and is not an implementation dependency. Old option analysis is retained only to explain the spike's evidence and must not be read as current architecture guidance.

## Historical spike decision (superseded)

On 2026-08-17, the spike favored adopting compatible local crates because published MIT sources matched 83 of 86 enumerated `mc-module` requirements and isolated three deltas. The later direct-boundary decision superseded that recommendation after the compiler-closure inventory made a complete direct port tractable. No production compatibility layer was retained.

## Evidence Provenance

Repository revision: `2bfea5d03adf96cc33f6015ef9061bcaad631d5b` (branch `main`).

| Dependency | Locked / installed | Latest published | Registry evidence |
| --- | ---: | ---: | --- |
| `subc-protocol` | 0.12.0 | 0.10.0 | index.crates.io lists 0.1.0 … 0.10.0 |
| `subc-transport` | 0.5.1 | 0.5.0 | index.crates.io lists 0.1.0 … 0.5.0 |
| `subc-control` | 0.1.2 | 0.1.1 | index.crates.io lists 0.1.0, 0.1.1 |
| `subc-client-rs` | 0.3.1 | 0.3.0 | index.crates.io lists 0.3.0 only |
| `subc-core` | 0.3.1 | **unpublished** | index.crates.io returns `NoSuchKey` |
| `@cortexkit/subc-client` | 0.4.1 | 0.4.1 (exact) | `bun.lock` integrity `sha512-kHLx5L/iefnbR/fiETQsCGGCegoQ/rcr70J7r/RfPakci6G1lEcTcK5V67o6WGWs4IOizkCM2tPa4ew8cp1tzA==` |

Artifact checksums (SHA-256) for the sources compared against:

```text
9074dce10cda1e8b0bfd15acd89a8196311d6d43fcebbcd8bd0c6f5f1f5f0e2e  subc-client-0.4.1.tgz
93494364301293386caf99849b76024e98b5ef6a14ccef8660c4a052545a0169  subc-client-rs-0.3.0.crate
226b6eb603c230bfdee64b9f1ce9e032523dbecde2eb9977e609163b15f8fbbf  subc-control-0.1.1.crate
d13feabcd80d43ea9e12819f0e5b28f06c2be21de475bc0d0b7fe97ec27d7c6f  subc-protocol-0.10.0.crate
dcc815910039de920bb680edd1a2c5743c86fe7a51e24c83c1db94da950874ab  subc-transport-0.5.0.crate
```

All four published crates carry `license = "MIT"`, `repository =
"https://github.com/cortexkit/subconscious"`, and the same
`.cargo_vcs_info.json` commit `47f5a69f5be620c4eef4b6e923e3a534e9341352`, so they are one
coherent cut of the same upstream tree rather than four independently drifting snapshots.
Published `subc-client-rs` 0.3.0 depends on `subc-protocol ^0.10`, `subc-transport ^0.5`,
and `subc-control ^0.1`, so the four-crate set resolves from crates.io with no sibling
checkout at all.

Reproduction artifacts in this repository:

- `docs/evidence/verify-rust-surface.py` + `.out` — per-row presence check against the
  published crate sources (86 results, one per published-crate row: 84 present,
  2 absent).
- `docs/evidence/verify-ts-surface.py` + `.out` — per-row presence check against the exact
  npm 0.4.1 declarations (34 present, 0 absent).
- `docs/evidence/subc-surface-probe/` — a compiling Rust probe that replays every
  `mc-module` construction, trait impl, match, and options literal against the **published**
  crates. `cargo check --all-targets` succeeds.
- `docs/evidence/subc-surface-probe/delta-ledger.txt` — the compiler output when the probe
  is flipped to `mc-module`'s exact forms, isolating the deltas to exactly three errors.

## Historical compiler closure: complete (2026-08-24)

The disposable-stub compiler pass (plan step 4) ran on 2026-08-24 with the `../commons`
and `../subconscious` siblings restored, at revision
`e1a09a549e6560543b906e73521f484c01010fb8` (task `magic-context-c50.12`, plan
`2026-08-24-0115-fix-subc-compiler-closure-plan.md`). Every Cargo-discovered `mc-module`
target (lib, `ck-mc`, the lib unit-test harness, `boundary_counter_durability`,
`broca_roundtrip`, `real_daemon`) compiled first against the real sibling dependencies
and then against strict stubs seeded from this inventory, finishing with
`cargo test -p mc-module --all-targets --all-features --no-run`. After `main` advanced
(PR #28 merge), the full pass was repeated clean at the current tip `574569d5` with no
additional demanded items. Evidence — combined compiler log, per-diagnostic ledger, and
the final stubs — lives in `docs/evidence/subc-compiler-closure/`.

The pass demanded exactly two items beyond the seeded surface, both satisfied by the
published MIT sources (see the ledger): `FrameType::Ping` (new row, the deliberate
positive control) and `PartialEq` on `manifest::ConsumerRole` (amended row). A follow-up
derive-strictness sweep (ledger entry 3) stripped every un-demanded derive from the
stubs and re-ran the pass, folding the compiler-demanded trait surface (`Clone`,
`Debug`, `PartialEq`, `std::error::Error` on specific rows) into the row shapes — all
present in the published sources, so no status changed. The enumeration below is
therefore mechanically proven **complete** for the current code, not just correct
per-row: with those reconciliations the inventory *is* the compile footprint. The
completeness gate on `magic-context-c50.4` is cleared.

## Historical Rust inventory

86 API rows across four crates, plus one declared-only dependency edge. Every row's build
target is the `mc_module` lib unless noted. Weight legend: **T** type-only, **P**
protocol-visible, **L** lifecycle-critical, **E** error/recovery-critical.

### `subc-protocol` (36 rows) — locked 0.12.0, compared against 0.10.0

| Item | Site | Class | Required shape / behavior | Status | Weight |
| --- | --- | --- | --- | --- | --- |
| `BindIdentity` | `historian_producer.rs`, `session_resolver.rs`, `tests/real_daemon.rs` | prod + test | struct `{ project_root: PathBuf, harness: String, session: String }`; `Clone` (the resolver clones it per call); daemon validates `project_root` against the real tree | exact | P |
| `RouteTarget` | same | prod + test | serde `tag = "kind"`, snake_case; `Clone`; `PartialEq + Debug` (unit-test `assert_eq!`) | exact | P |
| `RouteTarget::ManagementSurface` | `historian_producer.rs`, `session_resolver.rs` | prod | `{ module_id }`; routes the thalamus and broca management surfaces | exact | P |
| `RouteTarget::ToolProvider` | `tests/real_daemon.rs` | test | `{ module_id }` | exact | P |
| `ErrorBody` | `historian_producer.rs` | prod | pub `code`, `message` read by `From<ErrorBody> for ProducerErrorBody` | exact | E |
| `ErrorBody::new(code, message)` | `historian.rs:3337` | test | 2-arg associated constructor | **changed** (absent in 0.10.0) | E |
| `Flags` / `Flags::new` | `historian_producer.rs` | prod | `new(binary: bool, priority: Priority, last: bool)` | exact | P |
| `Frame` | `historian_producer.rs` | prod | `{ header, body }`, both pub | exact | P |
| `Frame::build` | `historian_producer.rs` | prod | `(ty, flags, channel, epoch, corr, body) -> Result<Frame, FrameBuildError>`; must reject bodies over the max so no unreadable frame is emitted | exact | P |
| `FrameBuildError` | `historian_producer.rs` | prod | `From` source for the producer error enum; `std::error::Error` (returned from `source()`) | exact | E |
| `FrameType` | `historian_producer.rs` | prod | variants `Request`, `Response`, `Error`, `StreamData`, `StreamEnd`, `Goodbye` used; `Copy + PartialEq` for matching; `Debug` for test assertions | exact | P |
| `FrameType::Ping` | `tests/broca_roundtrip.rs:544` | test | the fake daemon's frame filter compares `frame.header.ty != FrameType::Ping` | exact | P |
| `EnvelopeHeader` fields | `historian_producer.rs` | prod | `frame.header.{ty, channel, epoch, corr}` drive corr/route demultiplexing | exact | P |
| `Priority::Interactive` | `historian_producer.rs` | prod | stamped on every producer frame | exact | P |
| `PROTOCOL_VERSION` | `lib.rs` manifest, `historian_producer.rs` test | prod + test | `u8`, sent in the manifest and the fake connection file | exact | P |
| `SUBC_MODULE_ID_ENV` | `main.rs` (bin), `historian_producer.rs`, `tests/real_daemon.rs` | prod + test | `"SUBC_MODULE_ID"`; overrides the default module id and feeds consumer identity | exact | L |
| `SUBC_LAUNCH_NONCE_ENV` | `historian_producer.rs`, `tests/real_daemon.rs` | prod + test | `"SUBC_LAUNCH_NONCE"`; supervised-launch claim | exact | L |
| `ModuleHelloAckBody` | `lib.rs::on_hello_ack` | prod | ack body reference | exact | L |
| `ModuleHelloAckBody.storage` | `lib.rs::on_hello_ack` | prod | `Option<Value>` deserialized into `StorageDescriptor`; absent means standalone dev descriptor | exact | L |
| `manifest::ModuleManifest` | `lib.rs::manifest` | prod | struct literal with `module_id, module_version, protocol_ver, trust_tier, provides, consumes, bindings` and **no** `scheduled_tasks` | **changed** (0.10.0 requires `scheduled_tasks`) | P |
| `manifest::TrustTier::FirstParty` | `lib.rs` | prod | — | exact | T |
| `manifest::ProviderRole::ToolProvider` | `lib.rs` | prod | `{ tools, identity_scope, concurrency, emits_push, sub_supervises }` | exact | P |
| `manifest::ConsumerRole::ServiceClient` | `lib.rs` | prod + test | `{ of: Vec<String> }` = `["thalamus"]`; `PartialEq + Debug` needed — a unit test compares `manifest().consumes` with `assert_eq!` (lib.rs:16853) | exact | P |
| `manifest::Bindings` | `lib.rs` | prod | `{ storage, vault_grants, identity }` | exact | P |
| `manifest::StorageBinding` | `lib.rs` | prod | `{ kind, scope, owns_schema: true }` | exact | P |
| `manifest::StorageKind::Sqlite` | `lib.rs` | prod | — | exact | T |
| `manifest::StorageScope::Project` | `lib.rs` | prod | — | exact | T |
| `manifest::IdentityBinding` | `lib.rs` | prod | `{ requires: [Project], optional: [Session] }` | exact | P |
| `manifest::IdentityScope` | `lib.rs` | prod | `Project`, `Session` | exact | T |
| `manifest::Concurrency::ModuleManaged` | `lib.rs` | prod | the module, not the daemon, serializes its lanes | exact | L |
| `manifest::Tool` | `prompt_surface.rs` (6 literals), `lib.rs:20945` | prod | `{ name, description: Option<String>, execution_mode, schema: Value }`; **also deserialized** back off a module response, so serde must round-trip | exact | P |
| `manifest::ExecutionMode` | `prompt_surface.rs` | prod | `Pure`, `Mutating`; `PartialEq + Debug` needed by prompt-surface test `assert_eq!`. The advertised shape is the Thalamus authorization contract | exact | P |

### `subc-transport` (14 rows) — locked 0.5.1, compared against 0.5.0

| Item | Site | Class | Required shape / behavior | Status | Weight |
| --- | --- | --- | --- | --- | --- |
| `authenticate_client` | `historian_producer.rs::connect` | prod | `(&mut stream, &ConnectionInfo, Duration)`; pre-envelope HMAC handshake | exact | L |
| `connection_file::read` | `historian_producer.rs::connect` | prod | `-> Result<ConnectionInfo, ConnectionFileError>`; discovery + key load | exact | L |
| `ConnectionInfo` (read side) | `historian_producer.rs` | prod | `.endpoints.first()`, `endpoint.host`, `endpoint.port` | exact | P |
| `read_frame` | `historian_producer.rs` | prod | `-> Result<Option<Frame>, FrameIoError>`; `None` = peer closed, which the producer maps to `UnexpectedStreamEnd` | exact | E |
| `write_frame` | `historian_producer.rs` | prod | `(&mut stream, &Frame)` | exact | P |
| `AuthError` | `historian_producer.rs` | prod | producer error variant; `std::error::Error` (returned from `source()`) | exact | E |
| `ConnectionFileError` | `historian_producer.rs` | prod | producer error variant, carried with the path; `std::error::Error` (returned from `source()`) | exact | E |
| `FrameIoError` | `historian_producer.rs` | prod | `From` source for the producer error enum; `std::error::Error` (returned from `source()`) | exact | E |
| `authenticate_server` | `historian_producer.rs` unit tests | test | `(&mut stream, &key, &daemon_id, ver, Duration)` | exact | L |
| `generate_key` | `historian_producer.rs` unit tests | test | `-> Result<Vec<u8>, _>` | exact | T |
| `generate_daemon_id` | `historian_producer.rs` unit tests | test | `-> Result<[u8; 16], _>` | exact | T |
| `write_atomic` | `historian_producer.rs` unit tests | test | writes a `ConnectionInfo` a real client can read | exact | L |
| `ConnectionInfo` (write side) | `historian_producer.rs` unit tests | test | literal `{ schema, wire_version, endpoints, key, daemon_id, pid, daemon_ver }` | exact | P |
| `Endpoint`, `SCHEMA_VERSION` | `historian_producer.rs` unit tests | test | `{ host, port }`; `u32` schema tag | exact | P |

### `subc-control` (5 rows) — locked 0.1.2, compared against 0.1.1

| Item | Site | Class | Required shape / behavior | Status | Weight |
| --- | --- | --- | --- | --- | --- |
| `ClientControlRequest` | `historian_producer.rs` (+ its unit-test fake daemon) | prod + test | serde-tagged control envelope on channel 0 | exact | P |
| `ClientControlRequest::RouteOpen` | same | prod + test | `{ target, identity, consumer_identity, consumer_capabilities, admission_facts }` | exact | P |
| `ClientControlResponse::RouteOpen` | same | prod + test | `{ route_channel: u16, route_epoch: u32 }`; the producer binds every later frame to that pair; `Debug` (test `panic!("… {other:?}")` at `tests/broca_roundtrip.rs:591:58`) | exact | L |
| `ConsumerIdentity` | `historian_producer.rs` | prod | `{ module_id, launch_nonce }`, sent only when both env vars are non-empty | exact | L |
| `RouteOpen.admission_facts` | `historian_producer.rs` | prod | `Option<Value>`, sent as `None` | exact | T |

### `subc-client-rs` (31 rows) — locked 0.3.1, compared against 0.3.0

| Item | Site | Class | Required shape / behavior | Status | Weight |
| --- | --- | --- | --- | --- | --- |
| `async_trait` re-export | `lib.rs`, `session_resolver.rs`, `historian.rs` (3 sites, path form) | prod + test | Re-exported attribute macro applied to **`mc-module`'s own** traits (`HistorianProducerDriver`, `SessionResolver`) — not only to SDK traits | exact | T |
| `ModuleHandler` | `lib.rs:11244` | prod | trait impl for `McHandler` | exact | L |
| `ModuleHandler::handle` | `lib.rs:11289` | prod | `(RequestCtx, Vec<u8>) -> HandlerOutcome`; each request must run in its own task so one slow handler cannot head-of-line-block another route | exact | L |
| `ModuleHandler::on_hello_ack` | `lib.rs:11249` | prod | called **once** after HELLO_ACK; the single-writer store open is started here, never at construction | exact | L |
| `ModuleHandler::on_bind` | `lib.rs:11265` | prod | decision-only, must not emit route traffic; records `{project_root, harness, session}` per channel | exact | L |
| `ModuleHandler::on_route_gone` | `lib.rs:11285` | prod | drops the channel's binding so a reused channel cannot resolve a stale project | exact | L |
| `ModuleHandler::health` | `lib.rs:11255` | prod | invoked on a **separate channel-0 health task**; must be atomics-only (no store, no handler lock, no disk) | exact | L |
| `HandlerOutcome` | `lib.rs` (350 occurrences) | prod + test | the module's entire response type; `Debug` (unit tests format `{other:?}`) | exact | L |
| `HandlerOutcome::Response(Vec<u8>)` | `lib.rs` (86) | prod + test | opaque response bytes | exact | P |
| `HandlerOutcome::Error { code, message }` | `lib.rs` (174) | prod + test | becomes a wire Error frame carrying `ErrorBody` | exact | E |
| `HandlerOutcome::ErrorWithDetail { code, .. }` | `lib.rs` (5 match arms, never constructed) | prod + test | matched for exhaustiveness only; a `code: String` field is the sole proven requirement | **changed** (absent in 0.3.0; remaining fields `private/unknown`) | E |
| `HandlerOutcome::Streamed` | `lib.rs` (5) | prod + test | unit variant; the serve code sends the StreamEnd terminal | exact | P |
| `HealthReport` | `lib.rs:284, 412` | prod | `{ status, detail: Option<String>, metrics: Option<Value> }`; `detail` is display-only, `metrics` is the lane snapshot | exact | L |
| `HealthStatus` | `lib.rs` (11) | prod + test | `Ok`, `Degraded` used; `PartialEq + Debug` needed by test `assert_eq!` | exact | L |
| `RequestCtx` | `lib.rs:11289` | prod | opaque; **not constructible outside the transport**, which is why `dispatch_value` exists as the testable seam | exact | L |
| `RequestCtx::route_handle()` | `lib.rs:11295` | prod | `-> RouteHandle` (by value) | exact | P |
| `RouteBindRequest` | `lib.rs:11265` | prod | `.handle.channel`, `.identity.{project_root, harness, session}` | exact | P |
| `RouteHandle` | `lib.rs:11285` | prod | `.channel: u16` | exact | P |
| `BindDecision` / `::accept()` | `lib.rs:11280` | prod | accept every route; project resolution, not authorization | exact | L |
| `serve_with` | `main.rs` (bin `ck-mc`) | prod | `(&Path, ModuleManifest, H) -> Result<(), E>` where the opaque error `E` must implement `std::error::Error + Send + Sync` — `main` propagates it with `?` into `Box<dyn Error + Send + Sync>` (published `SubcModuleError` satisfies this); owns `--subc` connect, auth, HELLO{manifest}, HELLO_ACK, and dispatch | exact | L |
| `SubcConsumer` | `session_resolver.rs`, `tests/real_daemon.rs` | prod + test | consumer role | exact | L |
| `SubcConsumer::connect` | same | prod + test | `(&Path, ConsumerOptions)`; the opaque error must implement `Display` — `session_resolver.rs:97` maps it with `error.to_string()` (published `ConsumerError` implements `Display` + `Error`) | exact | L |
| `SubcConsumer::call` | same | prod + test | `(RouteTarget, BindIdentity, Vec<u8>, CallOptions) -> Result<Vec<u8>, CallError>`; managed route.open + request + terminal wait, with route-open retry | exact | E |
| `SubcConsumer::close_route` | `session_resolver.rs` | prod | `(RouteTarget, BindIdentity, CloseRouteOptions)` | exact | L |
| `SubcConsumer::close` | `session_resolver.rs`, `tests/real_daemon.rs` | prod + test | `async`, no result | exact | L |
| `ConsumerOptions` | `session_resolver.rs`, `tests/real_daemon.rs` | prod + test | literal `{ handshake_timeout, call_timeout, reconnect_backoff, restored_debounce }` (all four set, no `..default()`) | exact | L |
| `CallOptions` | `session_resolver.rs`, `tests/real_daemon.rs` | prod + test | `{ timeout, route_retry, route_retry_deadline, ..Default::default() }` — needs both the fields and a `Default` | exact | L |
| `CloseRouteOptions::default()` | `session_resolver.rs` | prod | default = close immediately, settling in-flight as at-most-once failures | exact | E |
| `RetryBackoff` | `session_resolver.rs`, `tests/real_daemon.rs` | prod + test | `{ base, cap, max_attempts }`; `max_attempts` counts the first attempt | exact | E |
| `CallError` | `session_resolver.rs` | prod | `Display` + `Debug`; the resolver maps it to its own error | exact | E |
| `CallError::Module(ErrorBody)` | `session_resolver.rs:186` | prod | matched with a `body.code == "session_resolve_timeout"` guard; application rejections must arrive as ordinary response bytes, **not** this variant | exact | E |

### `subc-core` (1 declared-only edge)

`[dev-dependencies] subc-core = { workspace = true }` in `crates/mc-module/Cargo.toml`.
There is **no** `use subc_core` anywhere in the repository. The real requirement is a
**binary**: `tests/real_daemon.rs:84` shells out to `cargo build -p subc-core --bins` in
the sibling workspace to produce `target/debug/ck-subc`, then spawns it. Status:
`private/unknown` — unpublished, and its internals must not be inferred from adjacent
crates. Weight: **L** (test infrastructure only). This is the one row that the
compatible-crate path cannot satisfy by adoption, and it is exactly what `mc-host` is for.

### Not API surface

`crates/mc-module/src/transform.rs` matches `subc` only in four test *names*
(`subc_reversibility_*`). No import, no call. Classified as non-API so the sweep is
closed.

## Historical TypeScript inventory

The installed version **is** the latest published version, so every row below is verified
against the exact 0.4.1 source and declarations; all 34 are `exact`.

### Primary production surface

| File | Imported exports | Methods / behavior required |
| --- | --- | --- |
| `packages/plugin/src/hooks/magic-context/module-transport.ts` | `AdmissionClass`, `BindIdentity` (type), `isConsumerReconnectTransient`, `Priority`, `RouteHandle` (type), `RouteTarget` (type), `SocketClosedError`, `SocketTimeoutError`, `StaleRouteHandleError`, `SubcClient` | `SubcClient.connect({ connectionFile, handshakeTimeoutMs })`; `routeOpen(target, identity)`; `request(handle, body, { priority, admissionClass, timeoutMs })`; `closeRoute(handle)` |
| `packages/plugin/src/features/magic-context/memory/embedding-synapse.ts` | `connectionFileExists`, `SubcCallError`, `SubcClient` | `SubcClient.connect({ connectionFile })`; managed `call<T>(moduleId, method, params, { timeoutMs, targetKind: "management_surface", identity })`; `close()`; `SubcCallError.kind === "outcome_unknown"` |
| `packages/plugin/src/features/magic-context/smart-notes/wake-plane.ts` | `connectionFileExists`, `SubcClient` | `SubcClient.connect({ connectionFile, handshakeTimeoutMs })`; `catalogList()`; `close()` |

Wire-visible error and identity contracts the production code depends on:

- **Stale/dead route detection is duck-typed on purpose.** `module-transport.ts` walks the
  `cause` chain and matches `code ∈ {stale_route_handle, route_closed, unknown_channel,
  unrecognized_channel, route_gone}`, `name === "StaleRouteHandleError"`, and the literal
  message `route handle (N, N) is not live on the current connection`, *because a plugin
  bundle can carry a different copy of `subc-client` than the client that threw*. Any
  replacement must keep those codes and that message text, not merely the classes.
- **Connection-failure classification** additionally matches `ENOENT`, `ECONNREFUSED`,
  `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `request_deadline`,
  `deadline_exceeded_no_drop_observed`, `connection_dropped`, plus the locally minted
  `SUBC_CONNECTION_BACKOFF`, and the messages `client closed` / `connection closed` /
  `closed the connection`.
- **`SubcCallError.kind` three-way semantics** (`not_sent` | `outcome_unknown` |
  `terminal`) are load-bearing: `embedding-synapse.ts` refuses to auto-retry
  `outcome_unknown` unless embeddings were explicitly declared retryable.
- **Managed-call identity** crosses the boundary as `{ project_root, harness, session }`
  with `targetKind: "management_surface"`; `module-transport.ts` uses
  `{ kind: "tool_provider", module_id }` and canonicalizes `project_root` with
  `realpathSync.native` before binding, because the module canonicalizes on *its*
  filesystem view.
- **Catalog capability probing** reads `CatalogEntry.control_ops` and must fail *open*:
  only an affirmative `wake.create` entry disables standalone smart notes.
- **Connection-file discovery** is `${dataDir}/cortexkit/run/subc-connection.json` via
  `connectionFileExists`.

### Validation-only surface (tooling and tests — must not inflate the production set)

| File | Class | Additional items beyond the production set |
| --- | --- | --- |
| `packages/plugin/src/hooks/magic-context/module-transport.test.ts` | test | `HEADER_LEN`, `PROTOCOL_VERSION`, `SERVER_PROOF_DOMAIN` (the test speaks the raw envelope and auth handshake to a fake server) |
| `packages/plugin/scripts/probe-subc-transport.ts` | tooling | `RequestOptions` type; `closeRoute`, `close` |
| `packages/plugin/scripts/drive-preseed.ts` | tooling | none (`connect`/`routeOpen`/`request`/`close`) |
| `packages/e2e-tests/src/rust-runner/hermetic-subc.ts` | test | none (`connect`/`routeOpen`/`request`/`closeRoute`/`close`) |
| `packages/e2e-tests/src/rust-runner/fake-broca.ts` | test | **the whole provider half**: `SubcProvider`, `managementSurfaceManifest`, `ProviderRequestContext` (incl. `ctx.emit`), `RouteBindRequest` |

`fake-broca.ts` is the widest single requirement on the TypeScript side, and it is
test-only: a replacement must either keep a provider-side TS API or that hermetic e2e lane
has to be rebuilt. Recorded here rather than promoted into the production surface.

Sweep closure: 8 files across `packages/` import `@cortexkit/subc-client` directly (listed
above). The other 28 files matching `subc` reference only env vars, connection-file paths,
config keys, or prose.

## Historical compatibility matrix

| | Rows | exact | changed | absent | private/unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| `subc-protocol` | 36 | 34 | 2 | 0 | 0 |
| `subc-transport` | 14 | 14 | 0 | 0 | 0 |
| `subc-control` | 5 | 5 | 0 | 0 | 0 |
| `subc-client-rs` | 31 | 30 | 1 | 0 | 0 |
| `subc-core` | 1 | 0 | 0 | 0 | 1 |
| **Rust total** | **87** | **83** | **3** | **0** | **1** |
| `@cortexkit/subc-client` | 34 | 34 | 0 | 0 | 0 |

The three deltas, each isolated to one `rustc` error in
`docs/evidence/subc-surface-probe/delta-ledger.txt`:

1. `error[E0063]: missing field 'scheduled_tasks' in initializer of 'ModuleManifest'` —
   0.12.0 dropped the field that 0.10.0 requires. Fix: drop it from the vendored struct.
2. `error[E0599]: no variant named 'ErrorWithDetail' found for enum 'HandlerOutcome'` —
   added after 0.3.0. `mc-module` only *matches* it (`{ code, .. }`, 5 arms) and never
   constructs it, so any variant carrying `code: String` satisfies every call site. The
   remaining fields stay `private/unknown`.
3. `error[E0599]: no associated function 'new' found for struct 'ErrorBody'` — a 2-arg
   constructor added after 0.10.0, used once, in a test. Fix: add three lines.

## Historical shim rationale (superseded)

This table records why the 2026-08-17 spike initially favored shims. It is not a current recommendation; the direct migration is final.

| Criterion | Finding | Favors |
| --- | --- | --- |
| Surface breadth | 87 Rust rows, but 83 are shape-identical to MIT source we can take as-is; the module never touches daemon-internal APIs | shims |
| Semantic depth | The heavy semantics (route.open control plane, epoch/channel demux, at-most-once classification, health probing, bind lifecycle) live on the **daemon** side, which `mc-host` must implement under *either* option. Adoption moves zero semantics into a compatibility layer | shims |
| Published-source delta | 83 exact / 3 changed / 0 absent; all three deltas are one-liners, but they point in different directions: `HandlerOutcome::ErrorWithDetail` and `ErrorBody::new` are additive (add a variant, add a constructor), while `ModuleManifest` is subtractive (the ported struct must omit `scheduled_tasks`, which published 0.10.0 requires) | shims |
| Ownership boundary | `subc` types are load-bearing inside core module logic — `HandlerOutcome` at 350 sites in `lib.rs`, and `subc_client_rs::async_trait` applied to `mc-module`'s **own** traits in `historian.rs`. Rewriting the boundary means editing core logic that has nothing to do with transport | shims |
| Verification cost | The compiler-closure pass (`docs/evidence/subc-compiler-closure/`) verified adoption's surface directly against rustc, and adoption keeps the existing `mc-module` test suite as the regression oracle instead of invalidating it — a rewrite would be verified no better | shims |

Rejected-option rationale: a boundary rewrite would require re-deriving the wire contract
that the MIT `subc-protocol` source already states exactly, renaming `HandlerOutcome` and
the manifest types through 350+ sites of unrelated transform logic, and discarding
`mc-module`'s existing tests as the regression oracle — all to reach a surface that is
already 96% shape-identical to freely licensed source. No third option is introduced: the
crates.io-vs-vendored choice is an implementation detail *inside* the shim path.

## Historical downstream constraints

### `magic-context-c50.2` (minimal wire protocol + handshake)

The protocol is not a blank sheet. It must reproduce, because `mc-module` speaks it
directly from `historian_producer.rs` rather than only through the SDK:

- the fixed-size envelope header (`ver, ty, flags, channel, epoch, corr, len`) with a body
  cap enforced on the write side, and `PROTOCOL_VERSION`;
- `FrameType` at least `{Request, Response, Error, StreamData, StreamEnd, Goodbye}`;
- `Flags::new(binary, priority, last)` with `Priority::Interactive`;
- channel-0 control JSON: `route.open` request `{target, identity, consumer_identity,
  consumer_capabilities, admission_facts}` → response `{route_channel, route_epoch}`;
- the registration lifecycle of HELLO{manifest} → HELLO_ACK{storage descriptor},
  preserved as a host-constructed synthetic `ModuleHelloAckBody` plus exactly-once
  handler initialization; wire `Hello`/`HelloAck` stay decodable for numeric
  compatibility but are role-invalid on consumer connections
  (`docs/mc-host-wire-protocol.md` Sections 6.2, 8.1);
- handler health, preserved as a host-internal `McHandler::health` callback on a
  dedicated control task independent of the request path; consumer liveness is
  pure-header `Ping`/`Pong`, and no client-visible channel-0 health operation exists
  (`docs/mc-host-wire-protocol.md` Sections 7.4, 9.3);
- the pre-envelope auth handshake and connection-file format (`SERVER_PROOF_DOMAIN`,
  `CLIENT_AUTH_DOMAIN`, `schema`, `endpoints`, `key`, `daemon_id`, `pid`, `daemon_ver`).
  The TS fake-peer test exercises these exports but imports the package's own proof/header
  helpers, so independent conformance vectors must pin their literal bytes;
- `unknown_module` remains a **terminal** Error for one `route.open` correlation,
  not a transport failure. Published `subc-client-rs` 0.3.0 may issue a fresh
  `route.open` with a new correlation under its bounded route-retry policy; the
  private 0.3.1 behavior described by `tests/real_daemon.rs` is unverified drift,
  not authority for disabling managed retries.

MIT source for all of the above is in the four published crates, so c50.2 is a
*confirm-and-trim* exercise rather than a design-from-scratch one.

### `magic-context-c50.4` (Rust boundary port)

> Superseded alongside the Decision section above: c50.4 now ports `mc-module`
> directly to the mc-host SDK with **no** `subc-*` compatibility crates — do not
> vendor or depend on the published crates as the implementation. The bullets
> below are preserved as the original adoption-path analysis; what carries over
> to the direct port is the inventory itself (the port's coverage checklist),
> the three deltas as wire-behavior facts, and the `subc-core` analysis.

- ~~Vendor or depend on published~~ `subc-protocol` 0.10.0, `subc-transport` 0.5.0,
  `subc-control` 0.1.1, `subc-client-rs` 0.3.0 (all MIT, one upstream commit)
  remain the reference sources for wire semantics only.
- Apply exactly the three deltas above.
- Do **not** treat `docs/evidence/subc-surface-probe/` as the implementation; it is
  evidence and stays excluded from the workspace.
- Gate cleared 2026-08-24: the disposable-stub compiler pass ran with `../commons`
  restored (`docs/evidence/subc-compiler-closure/`). Enumeration *completeness* is now
  compiler-proven for the current code; the two demanded items (`FrameType::Ping`,
  `PartialEq` on `ConsumerRole`) are additive and present in the published sources.
- `subc-core` cannot be adopted. `tests/real_daemon.rs` needs a spawnable
  daemon binary that answers `--version`, writes `subc-connection.json` under
  `XDG_RUNTIME_DIR`, honors `SUBC_PORT=0`, and reads `cortexkit/subc.jsonc` under
  `XDG_CONFIG_HOME` — that is `mc-host`'s acceptance contract. The real daemon's
  spawned-module registration is satisfied by direct linking plus the synthetic
  handshake (`docs/mc-host-wire-protocol.md` Section 8.1), not by a wire HELLO
  path. The binary alone does not make the test runnable: the test still spawns
  a module process and polls `wait_for_module_registration` before its first
  route (`tests/real_daemon.rs`), a provider-registration path the direct
  profile removes (`Hello` from a consumer is role-invalid). The mc-module
  build/test task (`magic-context-c50.4`) owns updating the test to the
  directly-linked host — dropping the module spawn and registration wait —
  since no provider compatibility path is retained.

### `magic-context-c50.5` (TypeScript client boundary)

- No API inference needed: 0.4.1 is the exact published version, all 34 rows verified.
- The wire-visible error identity is the real contract, not the class hierarchy — keep the
  route-failure `code` set and the `route handle (N, N) is not live on the current
  connection` message text, since detection is duck-typed across bundle copies.
- Preserve `SubcCallError.kind`'s three-way send-outcome semantics; `outcome_unknown` must
  stay non-retryable by default.
- Keep `CatalogEntry.control_ops` and fail-open catalog probing.
- The provider half (`SubcProvider`, `managementSurfaceManifest`,
  `ProviderRequestContext.emit`) is required by the hermetic e2e lane only; decide
  explicitly whether to keep it or rebuild `fake-broca.ts`.

## Unresolved Unknowns

1. **Enumeration completeness** — resolved 2026-08-24 by the compiler-closure pass
   (`docs/evidence/subc-compiler-closure/`): every current `mc-module` target compiles
   against inventory-only stubs, so the enumeration is complete for the current code.
2. **`HandlerOutcome::ErrorWithDetail`'s full shape** — only `code: String` is proven.
3. **`subc-core` internals** — unpublished; deliberately not inferred.
4. **`subc-protocol` 0.10.0 → 0.12.0 drift beyond the used surface** — two minor versions
   of unobserved change that this inventory does not, and need not, characterize.
