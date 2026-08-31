# rt-a-the-default-configuration-arms-no-liveness-probe

## Discovery trigger

The task brief asks whether any default enables a surface that should be opt-in.
I checked the inverse as well, and found the more consequential case: a default
that *disables* a detection subsystem, in a repository where several sibling
records depend on that subsystem running.

## Evidence trail

`config.rs:281-282`:

```
/// `None` sends no Pings at all.
pub liveness: Option<LivenessPolicy>,
```

`config.rs:294`, inside `impl Default for HostConfig`:

```
liveness: None,
```

The single spawn condition, `connection.rs:279-284`:

```
if let Some(policy) = shared.liveness.clone() {
    ...
    shared.spawn_tracked(gen.read_tasks.track_future(liveness_loop(
```

So with `None`, `liveness_loop` (`connection.rs:799`) is never spawned, and
nothing arms `policy.ping_interval` (`:804`, `:843`, `:852`) or evaluates
`policy.pong_deadline` (`:815`, `:827`) or `policy.invalidate_on_missed`
(`:830`).

The value reaches `HostShared` unconditionally at `runtime.rs:886`
(`liveness: config.liveness.clone()`), so the field always exists; only the loop
is conditional.

**The production configuration never sets it.** The sole non-test caller of
`mc_host::run` is `crates/mc-module/src/bin/ck_mc_host/serve.rs:582-593`:

```
let config = HostConfig {
    data_dir: Some(root),
    daemon_ver: mc_module::release_contract::DAEMON_VERSION.to_owned(),
    payload_manifest_digest: envelope.payload_manifest_digest.clone(),
    init,
    limits: mc_host::HostLimits { max_resident_bytes: ..., ..Default::default() },
    ..HostConfig::default()
};
```

`liveness` falls under `..HostConfig::default()`, so it is `None` in production.

The only two sites in the repository that set it are tests:
`tests/lifecycle.rs:402-406` (`ping_interval` 50 ms, `invalidate_on_missed`
false) and `tests/client.rs:64-68` (`ping_interval` 20 ms,
`invalidate_on_missed` **true**).

There is a direct test of this property: `tests/lifecycle.rs:494-513`
`liveness_is_disabled_by_default` starts a default host, opens a route, and
asserts that `client.expect_frame()` times out within 500 ms, with the message
"a default host must not send Ping".

The specification permits the absence. `docs/mc-host-wire-protocol.md:681`: "A
missed Pong invalidates the connection only under host's bounded liveness
policy." No policy, no invalidation. `:685` describes handler health as a
separate, host-internal mechanism, which is the health task at
`runtime.rs:933` and is unconditional.

## Failure scenario

Not a defect in the host. The consequence is a coverage and reachability one.

A peer process is `SIGSTOP`ed, or wedges inside its own event loop while holding
its ring endpoints open. It never closes the socket, so no EOF arrives. It never
sends a frame, and `docs/mc-host-wire-protocol.md:294` states that "waiting for
the next frame on an idle connection is unbounded at the framing layer; idle
lifetime is governed separately by liveness policy". With `liveness: None` there
is no liveness policy, so the generation persists holding one of 64 connection
permits (`runtime.rs:914`) and its writer queue until the process dies and the
ring's own peer-death path notices.

The catalog consequence is larger. Part 2a holds several liveness records —
`a-timely-pong-sustains-the-generation-within-a-bounded-round`,
`slow-egress-alone-does-not-retire-a-probed-generation`,
`host-ping-correlation-exhaustion-retires-the-generation`,
`pong-preanswer-rejected-in-every-mutex-order`,
`ping-and-consumer-correlations-cannot-cross-settle`. Every one of them requires
`liveness: Some(..)`, which no production configuration produces. Their
reachability label is therefore fixed by this record.

## Timing windows and dependencies

The window is the whole incarnation. There is no point at which a default host
begins probing.

`invalidate_on_missed` adds a second layer. Even a configured policy does not
retire a connection unless the flag is `true` (`connection.rs:830`), and
`config.rs:236-238` states the flag "stays `false` until the raw Rust historian
client can answer Ping (`magic-context-c50.4`); enabling it before then would
kill healthy long-running awaits (protocol §9.3)". So there are two independent
gates, and the repository's only `true` value is in a test
(`tests/client.rs:67`).

Dependency: peer-death detection in the absence of Ping falls entirely to the
ring transport. Part 1's `dead-peer-charges-are-reclaimed-or-declared` evidence
already cites `config.rs:282` and `:296` for exactly this reason, so the
dependency is recognised across part boundaries.

## What a test must construct

The negative half already exists and is adequate for the "no Ping" claim:
`tests/lifecycle.rs:494-513`.

What is missing is an assertion that no `liveness_loop` task is spawned, rather
than that no Ping frame is observed. The current test's 500 ms window is shorter
than any plausible `ping_interval`, so it would pass even if the loop were
spawned with a long interval. A task-level marker at `connection.rs:284`, fired
only when the loop is spawned, with `always(!fired)` under a default config, is
the stronger oracle and does not depend on a timeout.

For the coverage side, a `sometimes` marker asserting that at least one campaign
run *does* spawn the loop would make the explicit-config-only path's exercise
visible, and would fail loudly if `tests/lifecycle.rs:402` were ever deleted.

## Investigation log

### Q: is the health task also gated on `liveness`?

- Sources examined: `runtime.rs:932-933`, `:1050-1140`, `config.rs:217`, `:229`.
- Findings: no. `spawn_health_task` is called unconditionally at `:933`, and its
  loop reads `shared.timing.health_interval`, which is a `HostTiming` field with
  no `Option` wrapper and a 30 s default. Handler health and consumer liveness
  are entirely separate mechanisms, which matches
  `docs/mc-host-wire-protocol.md:679-685` treating them in separate paragraphs.
- Missing evidence: none.
- Conclusion: resolved with answer — the health task is `default-production`;
  only the Ping/Pong loop is opt-in.

### Q: does any non-test caller of `run` exist besides `serve.rs`?

- Sources examined: repository-wide search for `mc_host::run`,
  `runtime::run`, and `run_with_publish_hook`.
- Findings: `serve.rs` is the only binary caller. `run_with_publish_hook` is
  `#[doc(hidden)]` (`runtime.rs:640`) and exists for transport contract tests.
  `mc-module/examples/direct_host_fixture.rs` is an example, not a shipped
  binary.
- Missing evidence: none, though I did not audit whether any downstream
  repository embeds `mc_host` and sets `liveness`. `lib.rs:57` exports
  `LivenessPolicy` publicly, so an external embedder could.
- Conclusion: resolved with answer for this repository — `None` in production.
  The label `default-production` on the "no Ping" guarantee is correct, and the
  liveness subsystem itself is reachable only from tests here.
