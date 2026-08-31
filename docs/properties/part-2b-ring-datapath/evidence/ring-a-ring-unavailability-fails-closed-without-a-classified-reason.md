# ring-a-ring-unavailability-fails-closed-without-a-classified-reason

## Discovery trigger

The lens task asks what happens when the ring is unavailable, now that the
negotiated-transport fallback is deleted, and whether the host fails closed or
degrades silently. `docs/mc-host-shm-transport.md:7` is explicit about the
intent: "There is no runtime transport selector, alternate shared-memory
backend, compatibility reader, or degraded data path. A transport failure is
terminal for the affected connection." Reading `prepare` and its one caller
confirms the fail-closed half and disproves the reportable half.

## Evidence trail

**Five distinct producers of `RingUnavailable`, in `prepare`
(`crates/mc-host/src/ring_transport.rs:233-313`).**

| Cause | Site | Counter |
| --- | --- | --- |
| Admission exhausted | `:239-242` | `exhaustions.fetch_add(1, Relaxed)` at `:240` |
| Tokio runtime build or `DuplexRing::create` failure | `:260-270` | none |
| `worker_descriptor` failure | `:271-275` | none |
| `std::thread::Builder::spawn` failure | `:294-296` | none |
| Init channel `recv` failure | `:297` | none |

`RingUnavailable` itself (`:113-122`) is a unit struct. Its `Display` is the
fixed string "shared-memory ring is unavailable" (`:118`) and it carries no
cause field, so the five causes are indistinguishable to the caller by
construction, not by accident of handling.

**The single caller.** `connection.rs:147-162`:

```
let prepared =
    tokio::task::spawn_blocking(move || ring.prepare(ingress, queue_frames, frame_deadline));
let Ok(Ok(Ok(PreparedRing { .. }))) = timeout_at(
    Instant::now() + shared.timing.transport_setup_deadline,
    prepared,
)
.await
else {
    return;
};
```

Three nested `Ok`s: the `timeout_at`, the `JoinHandle`, and the
`Result<PreparedRing, RingUnavailable>`. Any failure among the three takes the
same bare `return`.

**The fail-closed half holds.** That `return` is at `connection.rs:163`, before
`crate::setup_socket::activate_server` at `connection.rs:170`. So no activation
commits, no descriptors are transferred, and no application frame can flow. There
is no alternative branch anywhere in the function. This matches the doc.

**The reportability half does not.** The `return` emits no `ServerMessage`, logs
nothing, and touches no counter. The peer observes only a closed setup socket:
`client.rs:367` calls `setup_socket::activate_client`, whose failure becomes
`ClientError::new("setup_failed", "shared-memory setup failed")` at
`client.rs:369`. That is the same code and message the client produces for
other distinct setup failures at `client.rs:372` and `:375`, so the client
cannot distinguish either.

Host-side, `diagnostics()` (`:153-207`) reports `state: "healthy"` whenever
`accounting()` succeeds (`:176-184`), regardless of `exhaustion.observed`. So a
host that has refused every connection for capacity reports healthy with a
non-zero exhaustion count, and a host that cannot create shared-memory objects
at all reports healthy with every counter at zero.

**The timeout path has an extra wrinkle.** `spawn_blocking` work cannot be
cancelled. When `timeout_at` fires at `connection.rs:158-164`, the blocking task
keeps running, `prepare` eventually succeeds, and the resulting `PreparedRing` is
dropped inside the blocking task. Dropping a `CancellationToken` does not cancel
it, so neither `root` nor `read_cancel` fires. Teardown of the abandoned endpoint
thread therefore falls to sender-drop: dropping `PreparedRing.sender`
(`:106`) closes the mpsc, and `run_endpoint`'s `queue.recv()` yields `None` and
returns at `:436-439`. That arm lives inside the `select!` at `:422-442`, which
`run_endpoint` only reaches when the previous `receive_one` returned `Ok(false)`.
Since the peer never attached on this path, `try_receive` returns `Ok(None)`
immediately (`:464-470`), so `Ok(false)` is the first outcome and the thread does
exit promptly. The dependency is real but not triggered here; it is triggered in
`ring-a-cancellation-close-requires-an-empty-inbound-observation`.

## Failure scenario

Total silent outage. A host is deployed where `/dev/shm` is unavailable, or the
per-process fd limit is below the two mappings plus two grant descriptors a
connection needs, so `DuplexRing::create` fails at `:263` every time.

Every client connect authenticates successfully (auth is
`connection.rs:120-131`, entirely before `prepare`), acquires a connection permit
(`:136-140`), reaches `prepare`, and is dropped at `:161`. The client reports
`setup_failed`. The host reports `state: "healthy"` with all five counters at
zero, because the only counter on the unavailability paths is `exhaustions`, and
this is not exhaustion.

An operator running `magic-context daemon doctor` gets a healthy report from a
host that cannot serve a single request. That is the worst shape a diagnostic can
take: not wrong in detail, wrong in conclusion.

## Timing windows and dependencies

The fail-closed half has no window; it is straight-line ordering between
`connection.rs:163` and `:170`.

The reportability half has no window either. It is a static absence of counters
and messages.

The timeout path has a window: `transport_setup_deadline` versus the real
duration of `prepare`. `prepare` blocks on `initialized_rx.recv()` at `:297`,
which waits for the endpoint thread to build a Tokio runtime (`:257-259`), create
two shared-memory objects (`:263`), and marshal two descriptors (`:271`). Under
memory pressure or fd pressure that can be slow, and the timeout would fire on a
`prepare` that is going to succeed.

Dependencies: `ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`
covers the diagnostics half of this in its own right;
`ring-a-admission-charge-releases-on-every-endpoint-thread-exit` covers whether
the charge comes back on each of these paths.

## What a test must construct

Fail-closed half, cheap and worth having: a test that forces `prepare` to fail
and asserts that `activate_server` was never called and the peer received no
`ServerMessage`. The cheapest forcing function is admission exhaustion, since
`per_connection_limits()` (`:61-73`) times one connection is exactly what
`RingFactory` uses (`frame_channel/contract_tests.rs:501-503`): prepare once,
then prepare again on the same transport and require `Err`.

Reportability half, per cause:

- Exhaustion: as above, then assert `diagnostics()["exhaustion"]["observed"]`
  incremented and that the connection refusal is attributable.
- `DuplexRing::create`, `worker_descriptor`, spawn, and init-channel failures:
  each needs an injection point. There is none. A test-only
  `#[cfg(test)]` failure switch on `prepare` would cover all four with one
  mechanism, at the cost of a production `cfg`.

Timeout path: set `transport_setup_deadline` very low in `HostConfig` and assert
that the abandoned endpoint thread terminates and its charge returns within a
bounded interval.

Existing checks: `ring_transport.rs:805` asserts
`diagnostics["exhaustion"]["observed"] == 0` on a fresh transport, which does not
exercise the increment. Nothing covers the other four causes.
`tests/shm_failure_modes` is named in CI (`ci.yml:133`), so it is the right home
for whatever is added; I did not read it in this pass, which is why the record's
`Exercised:` field says partial rather than not-yet.

## Investigation log

### Q: Should `RingUnavailable` carry a closed cause class matching the doctor's five terminal classes?

- Sources examined: `ring_transport.rs:113-122` (the unit struct and its fixed
  `Display`), the five producer sites, `docs/mc-host-shm-transport.md:53-59` (the
  five doctor classes), `packages/plugin/src/shared/mc-host-client/types.ts:69-73`
  (the same five as a TypeScript union).
- Findings: the mapping is nearly one to one. Admission exhaustion maps to
  `resource_exhaustion`. `DuplexRing::create`, `worker_descriptor`, spawn, and
  init-channel failures all map to `setup_failure`. So a two-variant enum would
  already close the gap for the host's own paths, and `missing_addon` and
  `identity_mismatch` are peer-side classes the host learns about only through a
  failed `activate_server`, which is `setup_socket.rs` territory and therefore
  sub-part 2c's.
- Missing evidence: whether the doctor's classes are meant to be host-produced
  at all; see the parallel question in
  `ring-a-host-doctor-emits-one-of-five-declared-terminal-classes`.
- Conclusion: resolved on feasibility, unresolved on whether it is wanted. A
  two-variant cause enum on `RingUnavailable` plus a
  `resource_exhaustion`/`setup_failure` branch in `diagnostics()` would close
  the host half. Whether the doc's taxonomy is the host's contract is the open
  design question.

### Q: On the `prepare` timeout path, should the connection task cancel the ring it abandoned?

- Sources examined: `connection.rs:147-162`; `ring_transport.rs:304-312` (what
  `PreparedRing` carries); `tokio_util::sync::CancellationToken` drop semantics
  (dropping does not cancel); `ring_transport.rs:436-439` (the `queue.recv()`
  arm); `:464-470` (`try_receive` on an unattached ring).
- Findings: on this specific path the abandoned thread does exit promptly,
  because an unattached ring makes `receive_one` return `Ok(false)` on the first
  pass, which reaches the `select!` where the closed-sender arm lives. So there
  is no leak today. But the reasoning is three steps deep and depends on the peer
  never having attached, which is true only because the timeout fired before
  `activate_server`. A future change that moved the timeout after activation
  would silently turn this into a leak.
- Missing evidence: none needed.
- Conclusion: resolved. No current defect; the safety is incidental rather than
  structural, and an explicit cancel on the abandoned `PreparedRing` would make
  it structural. Recorded as an open question in the lens rather than as its own
  record, because the property does not currently fail.
