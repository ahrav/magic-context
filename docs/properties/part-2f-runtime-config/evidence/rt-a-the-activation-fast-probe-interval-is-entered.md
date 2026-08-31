# rt-a-the-activation-fast-probe-interval-is-entered

## Discovery trigger

Paired with `rt-a-a-fixed-probe-interval-preempts-the-configured-health-interval`.
That record states the override exists. This one asks whether the situation that
triggers it is ever produced, because the override cannot be measured if it never
happens, and the branch's line coverage would not tell anyone.

## Evidence trail

The branch, `runtime.rs:1129-1133`:

```
let interval = if activation_in_progress {
    Duration::from_millis(50)
} else {
    shared.timing.health_interval
};
```

`activation_in_progress` is bound at `:1117-1128`, from the report the loop just
joined:

```
let activation_in_progress = match shared.lifecycle_join("health", probe).await {
    Ok(Some(report)) => {
        let activation_in_progress = activation_in_progress(&report);
        *shared.health_snapshot.write()... = report;
        activation_in_progress
    }
    Ok(None) => return,
    Err(_) => return,
};
```

The predicate is the nested `fn` at `:1051-1074`. It requires, in order:

1. `report.metrics` is `Some`.
2. That value has a `"components"` key.
3. That key's value is a JSON object.
4. At least one of its values has a `"metrics"` key whose value is an object.
5. That inner object has `"storage_state"` equal to the string `"starting"`, or
   `"synapse_state"` equal to `"starting"`.

Five conditions, all on handler-authored JSON. The host supplies only the three
string literals.

The producer side. `composite.rs:305` is `async fn health(&self) -> HealthReport`,
which builds `let mut components = serde_json::Map::new();` at `:334` and wraps it
at `:348` as `serde_json::json!({"components": components})`. So conditions 1
through 4 are satisfied by any composite host. Condition 5 is the situation, and
it is satisfied only while a component genuinely reports `starting`.

The window it tracks. `spawn_activation_task` (`runtime.rs:973-1011`) runs
`handler.activate()` after publication, with an explicit decision at `:981-983`:

> Abort-exempt: forced-shutdown `abort_all` must not turn an in-flight activation
> into a spurious task loss. The inner select self-bounds on the shutdown token
> instead; there is deliberately no lifecycle deadline here because model
> construction and certification own separate post-publication budgets.

So the activation window is component-determined and unbounded from the host's
side. That is what the fast probe cadence is for: to notice its completion
promptly.

The specification sanctions the state. `docs/mc-host-wire-protocol.md:685`:
"Waiting for a predecessor's storage lease reports `degraded` without making
transport unready."

Current coverage is zero. `tests/lifecycle.rs:165` sets
`config.timing.health_interval = Duration::from_millis(50)` — the same value as
the hardcoded literal — so even if that test happened to enter the branch, it
could not tell. No test in the repository constructs a component report carrying
`storage_state` or `synapse_state`. The only occurrences of those keys are the
host's own literals at `runtime.rs:1065` and `:1069`, and
`control.rs:1071` in a control-response test.

## Failure scenario

Not a runtime failure. A coverage failure with two consequences.

First, the predicate ships unexercised. It is a five-level chain of
`and_then`/`is_some_and` over untyped JSON, and a typo in either key string, a
change in the metrics nesting shape on the component side, or a component that
reports `"Starting"` with a capital would silently make it permanently `false`.
Nothing would notice: the host would simply use `health_interval` throughout,
which looks like correct behaviour.

Second, the override in the paired record becomes unmeasurable. If the situation
is never produced in any campaign, no test can establish how long the fast cadence
persists or that it ever ends, so the unbounded handler-controlled probe rate is
an untested path in production code.

The reverse direction matters too. If a component's metrics shape changes so that
the predicate becomes permanently `true`, the host probes at 50 ms forever and
`health_interval` is dead. That is also invisible without a check.

## Timing windows and dependencies

The situation window is the activation period, from `handler.activate()` starting
at `runtime.rs:985` to its completion at `:989`, and it is unbounded by design.

The predicate lags one probe. The order per iteration is: spawn the probe
(`:1091`), join it (`:1117`), store the report and evaluate the predicate
(`:1119-1123`), select the interval (`:1129`), sleep (`:1136`). So the fast cadence
begins one probe *after* the component starts reporting `starting`, and one extra
fast iteration occurs after it stops. A test counting iterations must expect that
offset.

Two ways the loop exits before the situation can occur, both at `:1126-1127`:
`Ok(None)` from shutdown cancellation (`:1100`) or a probe deadline expiry
(`:1105-1108`), and `Err(_)` from `lifecycle_join` tripping the fatal latch
(`:192`, `:204`). Either ends probing permanently, so a test must keep the handler
healthy and responsive while producing the `starting` metric.

Dependency: the first probe is issued immediately (`:1079` onward has no leading
sleep) and `spawn_health_task` is called at `:933`, one line before `accept_loop`
at `:934`. So the situation is reachable from the very first probe, which is the
easiest place to construct it.

## What a test must construct

A handler whose `health` returns, for a bounded number of calls, a report shaped:

```
metrics: Some(json!({"components": {"<id>": {"metrics": {"storage_state": "starting"}}}}))
```

then a report without it.

Three requirements beyond that:

1. `config.timing.health_interval` must differ from 50 ms, otherwise the branches
   are indistinguishable. Changing `tests/lifecycle.rs:165` away from
   `from_millis(50)` is the single edit that unblocks measurement, and it is worth
   doing regardless of this record.
2. `#[tokio::test(start_paused = true)]`, so the two cadences separate exactly on
   the virtual clock. Both `tokio::time::sleep` at `:1136` and the `timeout` at
   `:1101` use it.
3. A counter of probe invocations, on the handler side, so the test can assert the
   count matches the fast cadence during the window and the configured cadence
   after.

The marker is at `runtime.rs:1130`, fired when the fixed interval is selected.
Semantics `sometimes`, and deliberately not `reachable`: a campaign can execute
the `if` at `:1129` on every one of thousands of iterations, always taking the
`else`, and a line-coverage report would show `:1129` covered. What must be
witnessed is the operational state — a component that has published `starting` —
and that is situation coverage.

`tests/activation.rs` is the natural home, since it already drives the
post-publication activation path this situation belongs to.

## Investigation log

### Q: does any existing test produce a component report with these keys?

- Sources examined: repository-wide search for `storage_state` and
  `synapse_state`.
- Findings: `runtime.rs:1065` and `:1069` are the host's literals.
  `control.rs:1071` asserts on
  `response["metrics"]["components"]["magic-context"]["metrics"]["storage_state"]`
  inside a `control.rs` unit test, which exercises the response shape, not the
  health loop's predicate. No integration test sets the value to `"starting"` and
  runs the loop.
- Missing evidence: none.
- Conclusion: resolved with answer — the situation is never produced. The
  `control.rs` test does confirm the nesting shape the predicate expects, which is
  useful: it means conditions 1 through 4 are real and only condition 5 is
  missing.

### Q: is the 50 ms value reachable through configuration instead, making the branch moot?

- Sources examined: `config.rs:229`, `:356-363`, `tests/lifecycle.rs:165`.
- Findings: `health_interval` can be set to exactly 50 ms and one test does. That
  makes the *timing* identical but not the *path*: the branch taken is still
  determined by the predicate. So the branch is not moot, it is merely
  unobservable under that configuration.
- Missing evidence: none.
- Conclusion: resolved with answer — the coincidence at
  `tests/lifecycle.rs:165` is why no existing test can serve as partial coverage,
  and it is the first thing to change.

### Q: could the predicate be satisfied by a non-composite handler?

- Sources examined: `runtime.rs:500` (manifest count), `composite.rs:305-348`.
- Findings: `build_target_index` requires one to three manifests but does not
  require a composite. Any `McHostHandler` whose `health` emits the nesting would
  satisfy the predicate. The in-repository production handler is a
  `StaticComposite`, which does emit the outer shape.
- Missing evidence: none.
- Conclusion: resolved with answer — a test handler can satisfy the predicate
  directly without a composite, which makes the fixture cheaper than it first
  appears.
