# Rust-mode SUBC transport overhead report (2026-08-10)

## Executive result

The observed `transport - module` gap is not 145 ms of socket or relay overhead. The plugin's `module` field is only `TransformTimings.total`, whose timer starts inside `apply_once` and stops before substantial handler work. Correlating the 13 plugin pass records with `mc-pass-timing` records from the module decomposes the steady median as follows:

| Component | p50 | p95 | Included in plugin `module`? |
| --- | ---: | ---: | --- |
| Core transform (`timings.total`) | 75.0 ms | 86.7 ms | Yes |
| Historian trigger work | 8.5 ms | 10.2 ms | No |
| Native response attachment | **100.1 ms** | **111.1 ms** | No |
| Response JSON encode/splice | 2.0 ms | 2.4 ms | No |
| Known module work | **185.4 ms** | **210.3 ms** | Only the first row |
| Plugin `rust.transport` | 228.1 ms | 432.6 ms | Whole call |
| Remaining unpartitioned time | **40.5 ms** | 240.9 ms | No |

The ~151 ms median gap between `rust.transport` and `module` is therefore 73% known but misattributed module work: 100.1 ms native attachment, 8.5 ms trigger work, and 2.0 ms response encoding. Only 40.5 ms median remains for module ingress/prelude, queue residence, four socket/relay legs, client response decoding, and OpenCode event-loop scheduling together.

An idle standalone probe puts the complete client → daemon → module echo → daemon → client path at 0.28-0.38 ms p50 for 1-32 KiB payloads. The transport itself has no 145 ms fixed floor.

## Measurement design

`packages/plugin/scripts/probe-mc-host-transport.ts` is deliberately one long-lived Bun process using one established `McHostClient` connection and one reused route. Every sweep arm warms the route five times and then times 50 individual sequential round-trips. It does **not** spawn a process per sample; process startup would add a roughly 60 ms floor with about 90 ms spread and make this discriminator blind. Connection, route-open, and route-close times are reported separately.

The sweep uses the production request settings (`Priority.Background`, `AdmissionClass.Normal`) and exact serialized request-body sizes of 1, 4, 8, 16, and 32 KiB. A small interactive health arm is a control. The script also instruments `SubcModuleTransport` only within the probe process to timestamp its global correctness FIFO before enqueue, after dequeue, and after response. No production source or live durable module state is changed; `health`, `echo`, and read-only `session.status` are used.

Command:

```sh
cd packages/plugin
bun scripts/probe-mc-host-transport.ts
```

Live run: 2026-08-10T09:42:06Z, daemon 0.3.0 on loopback TCP, 50 samples per arm.

## Standalone probe results

| Arm | Request / response bytes | min | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| health, interactive | 25 / 309 | 0.165 ms | 0.313 ms | 0.513 ms |
| health, background/normal | 25 / 309 | 0.118 ms | 0.261 ms | 0.553 ms |
| echo 1 KiB, background/normal | 1,024 / 1,043 | 0.120 ms | 0.278 ms | 0.457 ms |
| echo 4 KiB, background/normal | 4,096 / 4,115 | 0.099 ms | 0.286 ms | 1.164 ms |
| echo 8 KiB, background/normal | 8,192 / 8,211 | 0.186 ms | 0.286 ms | 1.036 ms |
| echo 16 KiB, background/normal | 16,384 / 16,403 | 0.136 ms | 0.297 ms | 0.947 ms |
| echo 32 KiB, background/normal | 32,768 / 32,787 | 0.211 ms | 0.377 ms | 0.952 ms |

Setup was 6.748 ms to connect/authenticate, 1.550 ms to open the route, and 0.347 ms to close it. These costs are not paid per request.

The same process measured event-loop delay at 0.058 ms p50, 0.251 ms p95, and 3.454 ms maximum. Separate codec proxies were negligible: at 16 KiB, JSON stringify and parse were both 0.001 ms p50 and 0.002 ms p95; at 32 KiB they were 0.003/0.003 ms and 0.004/0.005 ms respectively. Frame construction, syscalls, daemon routing, module `Value` decode and echo encode, response reassembly, and promise resolution are all inside the sub-millisecond round-trip numbers.

### Nagle/delayed ACK result

The expected signature is absent. The 4/8/16 KiB p50s are 0.286/0.286/0.297 ms; there is no step at the 8 KiB Tokio `BufWriter` boundary and no ~40 ms quantization. Above that boundary, the relevant Rust write shape is a 21-byte header emitted before a direct large-body write, not a trailing small write. The TypeScript consumer sets `TCP_NODELAY`, while the daemon/Rust socket paths currently do not.

A clean 8 KiB step could account for about 40 ms, not 217 ms with a 216 ms spread. Thus Nagle could at most be a contributor even if another platform reproduces the step. This run rejects it as a contributor on the measured loopback path. If a future sweep does show the step, the fixes are `set_nodelay(true)` on the Rust sockets and/or a single-buffer or vectored header+body write. Enlarging `BufWriter` is not a fix; it only moves the same defect to a larger boundary.

## Historical pass decomposition

The 13 steady SOFT+ passes from 07:26:14-07:28:25Z had:

| Field | min | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| Plugin pass elapsed | 246.3 ms | 282.6 ms | 622.6 ms | 622.6 ms |
| `rust.transport` | 216.4 ms | 228.1 ms | 432.6 ms | 432.6 ms |
| Reported `module` | 69.2 ms | 75.0 ms | 86.7 ms | 86.7 ms |
| `transport - module` | 145.8 ms | 151.3 ms | 353.6 ms | 353.6 ms |
| `state_sync` | 6.1 ms | 28.7 ms | 238.5 ms | 238.5 ms |
| `other` | 0.9 ms | 1.1 ms | 164.8 ms | 164.8 ms |

With 13 samples, nearest-rank p95 is the maximum. The 216 ms transport spread and 208 ms residual spread are incompatible with a fixed protocol quantum.

Correlating each pass to the module's own timing line gives the detailed split:

| Plugin transport | Core total | Trigger | Native attach | Response encode | Known module | Remaining |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 216.4 | 69.2 | 8.5 | 100.1 | 1.9 | 179.7 | 36.7 |
| 246.1 | 81.6 | 9.8 | 109.3 | 2.4 | 203.1 | 43.0 |
| 245.0 | 83.9 | 9.8 | 105.0 | 2.1 | 200.8 | 44.2 |
| 218.1 | 72.2 | 8.0 | 98.5 | 1.9 | 180.6 | 37.5 |
| 432.6 | 79.0 | 9.1 | 101.5 | 2.1 | 191.7 | 240.9 |
| 220.8 | 75.0 | 8.0 | 98.5 | 1.7 | 183.2 | 37.6 |
| 217.0 | 69.5 | 9.3 | 99.5 | 1.6 | 179.9 | 37.1 |
| 216.9 | 70.5 | 7.6 | 99.0 | 1.8 | 178.9 | 38.0 |
| 255.7 | 86.7 | 10.2 | 111.1 | 2.3 | 210.3 | 45.4 |
| 228.1 | 76.8 | 8.8 | 100.0 | 2.0 | 187.6 | 40.5 |
| 220.9 | 74.8 | 8.4 | 98.7 | 1.8 | 183.7 | 37.2 |
| 240.3 | 74.0 | 8.3 | 101.1 | 2.0 | 185.4 | 54.9 |
| 242.2 | 75.8 | 8.2 | 100.7 | 2.1 | 186.8 | 55.4 |

### What `module` excludes

`McHandler::handle` receives an already assembled body, enforces the cap, and decodes it to `serde_json::Value`. Transform dispatch then converts the value to `TransformRequest`, validates/binds the route, expands a tail delta, updates snapshot/route state, and performs store prelude calls. None of that is covered by `timings.total`.

That timer starts at `transform.rs::apply_once` and stops immediately before the `TransformResponse` is constructed. After it stops, the handler still performs historian trigger handling, clones the served messages, decodes the OpenCode sidecar, runs a full `encode_opencode_with_transition_state`, clears native reasoning, updates traces and response observations, retains the transform snapshot, serializes the response, splices canonical CK message bytes, and returns the frame. The one-line module log measures `trigger_ms`, `post_attach_ms`, and `response_encode` separately, but the plugin records only `timings.total` as `module`.

The dominant 98.5-111.1 ms `post_attach` stage is the full native-message attachment path in `attach_native_messages_with_tags`, not transport.

## Relay and queue path

The steady request path is:

1. `SubcModuleTransport.call` enters a process-global correctness FIFO, reuses a cached client and `(session, canonical root)` route, stringifies the body, and writes a 21-byte binary envelope plus JSON body.
2. The daemon connection loop reads frames serially, acquires route flow credit, relays directly to the provider connection, and wakes its single egress writer.
3. The Rust provider SDK receives the routed body and calls `McHandler::handle`.
4. The module decodes, handles, and encodes the response; the daemon relays it back; the TypeScript client demultiplexes by `(channel, epoch, correlation)`, parses JSON, and resolves the promise.

There is no daemon forward-path polling, tick, or batching timer. Forwarding drains with `try_recv` and otherwise waits for scheduler wakeup. The 60-second watchdog and 2-second close-drain grace do not affect healthy requests. `EXPEDITE` admission bits are not wired to behavior and are not a proposed fix.

The module advertises `Concurrency::ModuleManaged`, which gives each route 32 daemon flow credits. The daemon acquires a credit before forwarding and releases it only after forwarding the terminal module response. This is per route, not a module-global execution limit.

The Rust SDK reads the entire opaque frame body, validates its epoch, spawns a Tokio task, and waits for one of 64 module-global handler permits before calling `ModuleHandler::handle`; the permit remains held through terminal-response sending. The module itself starts a Tokio `current_thread` runtime, so spawned handlers are cooperative tasks on one OS thread. Once a handler enters the synchronous transform or native-attachment section, it does not yield and blocks all other SDK tasks and frame reads. Queue residence can therefore occur in three places before `apply_once`: daemon route credit, SDK permit/task scheduling, and `McHandler` decode/prelude. All are excluded from `module`, and current logs cannot partition them.

### Plugin FIFO

`SubcModuleTransport.acquireCorrectnessLane` is global to the transport instance, not keyed by session or method, and permits 16 waiters. Status polls, state sync, tools, and transforms therefore serialize even for unrelated sessions.

The probe warmed eight unrelated `session.status` routes, launched one call per session concurrently, and instrumented the existing lane in-process:

| Phase | min | p50 | p95 |
| --- | ---: | ---: | ---: |
| FIFO queue wait | 0.125 ms | 3.713 ms | 6.582 ms |
| Dequeue to response | 0.268 ms | 0.409 ms | 2.884 ms |
| Whole call | 0.659 ms | 4.093 ms | 6.850 ms |

This proves unrelated calls share the FIFO, but it does not prove the historical transform waited there because no queue-residence stamp existed in that run. Under idle load the queue cost is single-digit milliseconds; behind a real transform it can inherit the preceding call's full service time.

## OpenCode event-loop evidence

The standalone event loop is quiet and the wire is sub-millisecond. The loaded OpenCode process is not:

- During the 432.6 ms transport outlier, an unrelated synchronous TypeScript transform occupied 130.5 ms inside the measured transport interval.
- Immediately after that module response resolved and application completed, another unrelated transform occupied 102.8 ms before the target pass log was emitted; `other` recorded 164.8 ms.
- The 238.5 ms `state_sync` span contains an unrelated 177.1 ms transform.
- The 128.0 ms `state_sync` span contains an unrelated 71.1 ms transform.

The in-process-versus-standalone comparison therefore convicts loaded event-loop scheduling as a variable tail contributor. It does not explain the 100 ms steady native attachment, which occurs in the Rust module and is independently timed.

## `state_sync` spikes

`syncModuleState` initializes `stateSyncDeltas` as a local variable on every call. Because the caller supplies no cached capability, every pass first awaits `stateSyncCapabilities`, which sends a read-only `session.status` request through the same global FIFO. It then builds a watermark/delta payload; if there is no change it returns without sending `state_sync`.

The row-version sequence distinguishes the paths:

| Pass | `state_sync` | Row-version movement | Interpretation |
| --- | ---: | ---: | --- |
| 07:27:53 | 6.1 ms | 2221 → 2222 | No state-sync commit; only the transform committed |
| 07:27:30 | 238.5 ms | 2218 → 2219 | No state-sync commit; overlapped 177.1 ms unrelated transform |
| 07:28:17 | 128.0 ms | 2223 → 2224 | No state-sync commit; overlapped 71.1 ms unrelated transform |
| 07:27:39 | 39.8 ms | 2219 → 2221 | One additional state-sync commit is consistent with the extra row-version increment |

The 128/238 ms cases were not changefeed drains or memory-mirror applications. Their trigger was the unconditional per-pass capability/status await on a loaded event loop (with possible FIFO residence), followed by a no-change result.

## Ranked fixes and expected wins

1. **Make native attachment incremental or reusable.** Avoid cloning/re-encoding the full served array in `attach_native_messages_with_tags` on every two-message tail delta. Cache the encoded native prefix using the same response/fingerprint frontier as serialized CK output, or teach the codec to borrow/reuse unchanged messages. Expected steady win: **80-100 ms p50**, bounded by the measured 98.5-111.1 ms stage.
2. **Cache `state_sync_deltas` by live module connection/generation.** Do not issue `session.status` before every no-change watermark check. Expected idle win is small (<1 ms wire time), but it removes the await that admitted the observed 71-177 ms event-loop stalls; expected tail win on affected passes is **70-238 ms**, with the no-change stage approaching its 6.1 ms clean case.
3. **Instrument, then shard the plugin correctness FIFO where safe.** Add flag-gated `queued_at`, `dequeued_at`, `request_sent`, and `response_received` stamps with method/session/correlation and queue depth. If production traces show cross-session contention, retain same-session ordering but use per-session lanes for unrelated status/tool/transform traffic. Expected idle win is only the measured 3.7 ms p50 at eight-way contention; expected loaded win can be one preceding request, **~180-430 ms**.
4. **Move long synchronous OpenCode transforms off the socket-owning event loop or yield them in bounded chunks.** The logs directly show 71-177 ms stalls inside awaited Rust stages and 102.8 ms after a response. Expected win is primarily p95/outlier reduction: **~70-165 ms** in the observed overlaps.
5. **Bound and expose module SDK queue residence; then move synchronous handler work off the current-thread reactor if it is material.** The SDK's 64 spawned-task permits do not provide parallelism on this runtime, and a module pass occupies roughly 179-210 ms when the omitted stages are counted. A bounded blocking worker/per-session lane can keep frame ingress and response egress responsive without blindly running 32 concurrent SQLite transforms per route. Expected win under multi-client queueing is up to one or more full **~180-210 ms** services; idle win is zero.
6. **Do not attribute this incident to Nagle.** The required sweep is flat across 8 KiB and the historical spread is not 40 ms quantized. If another host produces a clean step, land `set_nodelay(true)` and/or vectored header+body writes, with an expected **~40 ms** win on affected frames. Do not enlarge `BufWriter`.

No change is recommended for route caching, JSON serialization, `EXPEDITE`, or daemon timers. They are either already correct, negligible, unwired, or absent.

## Correlated timing request for SUBC

The remaining steady 36.7-55.4 ms and the 240.9 ms outlier cannot be partitioned with current telemetry. A flag-gated correlation trace is warranted, but only after the plugin queue stamps above are present. For each `(connection, channel, epoch, correlation)`, ask SUBC/provider SDK to emit:

- daemon consumer frame fully read;
- route flow credit acquired / scheduler dequeued;
- provider write flushed;
- provider frame fully read and handler entered;
- handler returned and provider response write flushed;
- daemon provider response fully read;
- consumer write flushed;
- client frame dispatched and promise resolved.

The trace must use comparable monotonic timestamps and include body/response byte counts. No daemon per-frame timing exists today. These stamps will separate daemon scheduler/egress backpressure, module SDK queue wait and decode, socket delay, and client reassembly without adding a speculative production timer or changing admission policy.

## Source map

- `packages/plugin/src/hooks/magic-context/module-transport.ts`: `stateSyncCapabilities`, `acquireCorrectnessLane`, `call`, `ensureRoute`.
- `packages/plugin/src/hooks/magic-context/module-state-sync.ts`: `syncModuleState`.
- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts`: `callModule`, state-sync and transport stage timers.
- `@cortexkit/subc-client/src/client.ts`: correlation mux, request send, route reuse.
- `@cortexkit/subc-client/src/socket.ts`: client socket and `setNoDelay(true)`.
- `@cortexkit/subc-client/src/envelope.ts`: 21-byte frame envelope and JSON body encoding.
- `crates/subc-core/src/server.rs`: `connection_loop`, `drain_writer`.
- `crates/subc-core/src/router.rs`: `route_for_connection`, `ForwardBackend::handle_bound`, `FrameSink::send`.
- `crates/subc-core/src/forwarding.rs`: `ChannelFlow` and module-managed credit.
- `crates/subc-transport/src/frame_io.rs`: Tokio buffered frame read/write.
- `crates/subc-client-rs/src/lib.rs`: `serve_with`, `module_loop`, `spawn_data_request`, 64-handler permit.
- `crates/mc-module/src/main.rs`: current-thread Tokio runtime and `serve_with`.
- `crates/mc-module/src/lib.rs`: `McHandler::handle`, transform dispatch, `attach_native_messages_with_tags`, `respond_transform`.
- `crates/mc-module/src/transform.rs`: `apply_once` timer and pass timing line.
