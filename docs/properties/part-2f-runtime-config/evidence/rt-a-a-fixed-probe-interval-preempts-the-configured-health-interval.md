# rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval

## Discovery trigger

The task brief points at a shape Part 2a already found once: a hardcoded bound
judging an operator-settable one. Part 2a's instance was a 60-second freshness
window judging budgets settable to 365 days. I searched `runtime.rs` for fixed
`Duration` literals adjacent to configured ones. There are three, and one of
them does not merely sit beside the configured value; it replaces it.

## Evidence trail

`runtime.rs:1129-1133`, verified verbatim:

```
let interval = if activation_in_progress {
    Duration::from_millis(50)
} else {
    shared.timing.health_interval
};
```

`shared.timing.health_interval` has exactly one read site in the crate. I
grepped: `runtime.rs:1132` is it. So whenever the `if` takes the true branch, the
configured value has no consumer at all for that iteration.

The predicate, `runtime.rs:1051-1074`, is a nested closure over the *previous*
report's metrics:

```
fn activation_in_progress(report: &HealthReport) -> bool {
    let components = report.metrics.as_ref()
        .and_then(|metrics| metrics.get("components"))
        .and_then(serde_json::Value::as_object);
    components.is_some_and(|components| {
        components.values().any(|component| {
            let metrics = component.get("metrics").and_then(serde_json::Value::as_object);
            metrics.is_some_and(|metrics| {
                metrics.get("storage_state").and_then(serde_json::Value::as_str) == Some("starting")
                    || metrics.get("synapse_state").and_then(serde_json::Value::as_str) == Some("starting")
            })
        })
    })
}
```

Every input is handler-authored. `report` comes from
`crate::panic_boundary::redact(callback)` where `callback` is
`handler.health()` (`:1092`, `:1101`), and it is stored and evaluated at
`:1117-1125`. The two string keys and the literal `"starting"` are the only host
contribution. A component that emits `storage_state: "starting"` in its metrics
keeps the branch true.

The configured side's range: `config.rs:229` defaults `health_interval` to 30 s,
and `HostConfig::validate` admits anything from 1 nanosecond to
`MAX_CONFIG_DURATION`, which is `Duration::from_secs(365 * 24 * 60 * 60)`
(`config.rs:81`), enforced at `:356-363`. So the operator may set 365 days and
the host will probe 20 times per second regardless, for as long as a component
says `starting`.

Nothing bounds how long that is. `spawn_activation_task` (`:973`) runs
`handler.activate()` with an explicit decision *not* to impose a lifecycle
deadline, stated at `:981-983`: "there is deliberately no lifecycle deadline
here because model construction and certification own separate post-publication
budgets." The inner `select!` at `:986-1003` self-bounds only on the shutdown
token.

Each fast iteration is not free. `:1091` calls `shared.spawn_lifecycle`, which
spawns onto the tracker without an abort handle (`:162-168`), and `:1092` invokes
`handler.health()` inside the redaction guard. At 50 ms that is 20 handler
callbacks and 20 tracked task spawns per second.

The real report always populates `components`, so the predicate has real inputs
to work with: `composite.rs:334-348` builds one map entry per component, and
`build_target_index` requires one to three manifests (`runtime.rs:500`).

## Failure scenario

An operator deploys with `health_interval` raised to 5 minutes to reduce probe
load on a host whose components are expensive to interrogate. One component's
storage lease is held by a draining predecessor, so it reports
`storage_state: "starting"` — which
`docs/mc-host-wire-protocol.md:685` explicitly sanctions: "Waiting for a
predecessor's storage lease reports `degraded` without making transport
unready."

The predecessor's drain is bounded only by its own `shutdown_deadline` plus the
forced-path extension, and if it wedges, by nothing. Throughout that window the
host probes every 50 ms. The operator's 5-minute setting has no effect. Nothing
logs that the configured interval was overridden, and no metric distinguishes
the two cadences.

The inverse is also reachable and worse: a buggy or hostile component that never
clears `starting` pins the host at 20 probes per second for the entire
incarnation. The host has no defence, because the switch is a string in the
component's own report.

## Timing windows and dependencies

Window: unbounded, and host-external in origin. It opens the first time a probe
returns a report satisfying the predicate and closes when a probe returns one
that does not. Both transitions are decided by the handler.

Ordering: the predicate reads the report the loop just stored (`:1117-1125`),
then selects the interval (`:1129`), then sleeps (`:1136`). So the fast cadence
always lags one probe behind the state that justifies it, and one extra fast
iteration occurs after activation completes. That is correct behaviour and not a
defect; it matters for a test's expected iteration count.

Dependency on the exit paths: `Ok(None)` at `:1126` and `Err(_)` at `:1127` both
`return`, ending the loop permanently. `Ok(None)` arises from shutdown
cancellation (`:1100`) or a probe deadline expiry that already tripped the fatal
latch (`:1105-1108`). So a health-callback failure stops probing for the rest of
the incarnation rather than backing off.

## What a test must construct

Three pieces, none of which exists.

1. A handler whose `health` report carries
   `metrics.components.<id>.metrics.storage_state == "starting"` for a bounded
   number of probes, then clears it. `tests/activation.rs` is the natural home,
   since it already drives the post-publication activation path.
2. A `health_interval` distinguishable from 50 ms. `tests/lifecycle.rs:165`
   currently sets it to exactly `Duration::from_millis(50)`, which makes the two
   branches indistinguishable by timing. That is the single change that unblocks
   the whole record.
3. Under `#[tokio::test(start_paused = true)]`, count probe invocations while
   advancing the virtual clock, and assert the count matches the fast cadence
   during the window and the configured cadence after it.

The production-side guard is a counter of consecutive fast-cadence iterations,
exposed so a campaign can assert an explicit bound. Per the coverage rules, the
assertion is on the precondition — that the predicate's inputs came from a
component report — not on the override itself.

## Investigation log

### Q: does any other configured duration have a hardcoded competitor?

- Sources examined: `runtime.rs:965`, `:1130`, `:1223`, `instance.rs:674-675`.
- Findings: three other fixed durations exist. `ACCEPT_ERROR_BACKOFF` 100 ms
  (`:965`) has no configured counterpart, so it is a fixed policy rather than an
  override. The lock retry pair, 4 attempts at 25 ms (`instance.rs:674-675`), is
  fixed with no override and is documented as such at `runtime.rs:649-655`.
  `lifecycle_callback_deadline.saturating_mul(2)` at `:1223` *derives* from a
  configured value rather than replacing it, and is recorded separately.
- Missing evidence: none.
- Conclusion: resolved with answer — `:1130` is the only site where a fixed
  literal substitutes for a configured value.

### Q: is `health_interval` read anywhere else, so that the override is partial?

- Sources examined: repository-wide search for `health_interval`.
- Findings: two sites. `config.rs:217` and `:229` are the declaration and
  default. `runtime.rs:1132` is the only read. `tests/lifecycle.rs:165` writes
  it.
- Missing evidence: none.
- Conclusion: resolved with answer — the override is total for the duration of
  the window.

### Q: should the fast cadence be bounded, or is the unbounded form intended?

- Sources examined: `runtime.rs:981-983`, `:1129-1133`,
  `docs/mc-host-wire-protocol.md:679-685`.
- Findings: the comment at `:981-983` deliberately declines a deadline for
  activation, reasoning that post-publication budgets belong to the components.
  That justifies the *activation* being unbounded. It does not address the probe
  cadence that tracks it, and the specification says nothing about a probe
  interval at all.
- Missing evidence: a design statement about whether handler-controlled probe
  rate is acceptable.
- Conclusion: needs human input.
