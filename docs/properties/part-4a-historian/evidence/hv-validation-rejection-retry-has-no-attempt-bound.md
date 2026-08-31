# hv-validation-rejection-retry-has-no-attempt-bound

## Discovery trigger

Task item 2: on rejection, what happens to the run, is the rejection observable,
and can a rejected run retry indefinitely. The first two answers are good. The
third is not: the only limiter is a fixed 60-second cooldown, and the counter that
would surface the problem is never incremented on this path.

## Evidence trail

### The rejection path, end to end

`crates/mc-module/src/historian.rs:1666-1704`. Validation is called at
`:1673-1678`, or short-circuited to an error when the producer truncated
(`:1666-1671`). On `Err`:

```rust
Err(err) => {
    let failure_backoff_at_ms = completion_failure_backoff_at_ms(
        failure_started_at_ms, failure_backoff_at_ms, completion_now_ms(),
    );
    let cap_hint = if output.length_capped { " [output hit the length cap: ...]" } else { "" };
    persist_historian_state(store, session_id,
        abandon_with_detail(&validating, failure_backoff_at_ms,
            Some(format!("validate rejected: {err}{cap_hint}"))),
    )?;
    return Err(HistorianDriveError::Validation(err));
}
```

Fail-closed confirmed: no arm reaches `publish_validated_chunk` (`:1714`) without
`Ok` from `:1673`.

### The counter is not incremented

`abandon_with_detail` (`:352-361`):

```rust
HistorianDurableState {
    state: HistorianPhase::Idle,
    firing_seq: current.firing_seq,
    failure_backoff_at_ms: Some(failure_backoff_at_ms),
    last_failure: detail.or_else(|| current.last_failure.clone()),
    consecutive_publish_failures: current.consecutive_publish_failures,   // carried, NOT incremented
    ..HistorianDurableState::default()
}
```

The only increments in the tree are in the store, both inside abandon
transactions this path does not use:

- `mc-store/src/lib.rs:9264-9268`, conditional on a `count_publish_failure` flag.
- `mc-store/src/lib.rs:9323-9326`, unconditional, in a different transaction.

So `consecutive_publish_failures` stays at whatever it was through any number of
validation rejections. The user-visible health signal is derived from exactly that
counter: `lib.rs:6258-6261` builds the `publish_health` string and
`lib.rs:6359-6360` emits `consecutive_publish_failures` and
`publish_health_degraded: consecutive_publish_failures >= 3`. Both stay clean.

### The backoff does not escalate

`completion_failure_backoff_at_ms` (`historian.rs:1145-1154`):

```rust
let cooldown_ms = configured_backoff_at_ms.saturating_sub(started_at_ms).max(0);
completed_at_ms.saturating_add(cooldown_ms)
```

This RE-BASES the configured cooldown onto the completion time. It preserves the
interval; it does not multiply it. The configured interval traces back to
`now + HISTORIAN_FAILURE_BACKOFF_MS` at `lib.rs:4771`, `:5101`, `:5266`, with
`HISTORIAN_FAILURE_BACKOFF_MS = 60_000` (`historian.rs:30`). There is no
exponential term and no attempt-count input to the function.

Compare `classified_backoff_at_ms` (`historian.rs:1156-1166`), which DOES honour a
provider `retry_after_secs`. That path is for producer error classification, not
validation rejection, so the escalation machinery exists and is not wired to this
case.

### The gate on re-firing is time only

`lib.rs:5042-5047`:

```rust
if loaded.meta.historian.failure_backoff_at_ms.is_some_and(|backoff_at_ms| now < backoff_at_ms) {
    self.record_no_fire(&store, &parsed.session_id, &loaded, "backoff");
    return PreparedHistorianAction::Complete(HistorianDiagnostics { fired: false, ... });
}
```

Once `now >= backoff_at_ms`, the firing decision proceeds. Read the surrounding
`prepare_historian_fire` region (`lib.rs:4808-5184` per the scope map) for any
attempt cap: the no-fire reasons are threshold and state conditions, and no
counter of prior validation rejections participates. `firing_seq` is preserved
across abandons (`:355`, and the doc at `:346-347`: "The failed firing sequence is
kept so the next fire remains monotonic") but is used for monotonicity and
predicate matching, not as a budget.

### Retry WITHIN one firing is bounded

`historian.rs:1440-1450`:

```rust
Err(HistorianDriveError::Validation(err)) => {
    // Validation rejection is model-local output failure. Exhaust the
    // configured fallback chain before returning the final rejection.
    if has_eligible_model(&request.model_chain[index + 1..], &auth_blocked_providers) {
        let cleanup = producer.close_attempt().await;
        log_cleanup_failure(request.session_id, "attempt close", &cleanup);
        continue;
    }
    ...
}
```

So one firing costs up to `model_chain.len()` live model calls on a rejection. That
bound is explicit and documented. The unbounded dimension is firings, not attempts
within a firing.

### Observability, precisely

The reason IS durable: `last_failure` is set to `"validate rejected: {err}"` at
`:1699`. It surfaces two ways.

- `HistorianDiagnostics.last_failure`, populated at `lib.rs:5313`
  (`diagnostics.last_failure = loaded.meta.historian.last_failure.clone()`) and
  carried through the prepared-action arms (`lib.rs:4840`, `:4848`, `:5055`,
  `:5147`).
- `historian_status_summary` (`lib.rs:15464-15478`), which is ordered:

```rust
if state.state != HistorianPhase::Idle { return format!("fire seq {} {}", ...); }
if let Some(reason) = state.last_no_fire.as_deref() { return format!("no fire: {}", ...); }
if let Some(reason) = state.last_failure.as_deref() { return format!("failure: {}", ...); }
```

`last_no_fire` is checked BEFORE `last_failure`. `record_no_fire`
(`lib.rs:5323-5336`) writes `last_no_fire = "backoff"` on the first post-rejection
pass and does not clear `last_failure`. So the one-line summary flips from
`failure: validate rejected: ...` to `no fire: backoff` and stays there. The
detail is still in durable state and still in `HistorianDiagnostics`; it is the
summary line that goes quiet.

The machine-readable status block (`lib.rs:6358-6360`) never carried the reason at
all.

## Failure scenario

A user configures a small or heavily-quantised historian model, or a provider
starts returning a subtly different XML shape after a model version bump. Every
output is well formed enough to parse but fails one range check, say
`<unprocessed_from>` off by one (`:1054-1060`).

Timeline:

- t=0. Firing 1. Model A rejects. `has_eligible_model` finds model B, so B runs
  and also rejects. Chain exhausted. `abandon_with_detail` writes
  `last_failure = "validate rejected: ..."` and `failure_backoff_at_ms = t+60s`.
  `consecutive_publish_failures` unchanged.
- t=1s. Next transform pass. `lib.rs:5042-5047` declines, writes
  `last_no_fire = "backoff"`. The status summary now reads `no fire: backoff`.
- t=60s. Firing 2. Two more live model calls. Same rejection. Same 60s backoff.
- Repeat, indefinitely.

Steady state: two live model invocations per minute, per affected session, for as
long as the session lives. `publish_health_degraded` is false the whole time
because nothing increments the counter. The one-line status says `no fire:
backoff`, which reads like healthy throttling rather than a stuck loop. Nobody
compacts, so the session also never gets the context reduction the historian
exists to provide.

No data is corrupted. This is a cost, noise, and stuck-state failure, which is
why it is the one liveness record in this lens rather than a safety record.

## Timing windows and dependencies

The bounded fault-free window required by the liveness rules is naturally
available: stop changing configuration, then poll for N firing opportunities of
60 seconds each. The bound is stated in attempts (N firings), not as an unbounded
eventually, because a generous timeout could not distinguish one retry from a
thousand at a fixed interval.

Dependency on the pass cadence: firings are driven by transform passes
(`prepare_historian_fire`), so a quiet session retries only when the agent is
active. That bounds the rate but not the total.

## What a test must construct

This needs the store and the firing path, so it is heavier than the other records
in this lens, but it does not need a live model.

1. A `McStore` and an injected producer factory. The seam exists:
   `HistorianProducerFactory` (`lib.rs:3023-3030`) with
   `with_producer_factory` (`lib.rs:3676-3770`).
2. A stub producer returning a fixed, well-formed document that fails exactly one
   range check.
3. A controllable clock. `set_guidance_now_ms_for_test` exists
   (`lib.rs:4427-4532` region) for the guidance clock; the firing path's `now` and
   `completion_now_ms` (`historian.rs:1637`, a `fn() -> i64`) are the injection
   points that matter, and `completion_now_ms` being a plain function pointer makes
   it substitutable.
4. Drive N firings by advancing past each backoff. Assert the property: after N
   consecutive validation rejections, either the backoff interval has grown beyond
   `HISTORIAN_FAILURE_BACKOFF_MS` or `publish_health_degraded` is true. Today
   neither holds for any N.

Two cheaper unit-level assertions worth having regardless, both pure:

- `abandon_with_detail` with `consecutive_publish_failures: 5` returns 5, pinning
  the carry-forward so a future change to increment it is a visible diff.
- `completion_failure_backoff_at_ms(0, 60_000, 100_000) == 160_000`, pinning that
  the interval is preserved rather than escalated.

## Investigation log

### Q: Should a validation rejection increment consecutive_publish_failures?

- Sources examined: `mc-store/src/lib.rs:1517` (the field),
  `:9264-9268` and `:9323-9326` (the two increments), `:16637-16663` (a test
  asserting a successful publish resets it to 0), `historian.rs:323`
  (`next.consecutive_publish_failures = 0` on success), `:358` (the carry-forward),
  `lib.rs:6258-6261` and `:6359-6360` (the only user-visible consumer).
- Findings: The name and the store-side increment sites both point at "the publish
  transaction failed", which a validation rejection is not: validation rejects
  BEFORE the transaction. So the current behaviour is arguably correct for the
  field's meaning. The problem is that this field is the ONLY health signal the
  status block exposes, so a correct reading of the field produces a misleading
  overall picture.
- Missing evidence: whether operators are expected to read
  `historian_status_summary` (which the no-fire precedence masks) or the JSON block
  (which never had the reason).
- Conclusion: needs human input. The likely right answer is a separate counter for
  validation rejections rather than overloading this one, but that is a design
  decision about the operator contract.

### Q: Is there any escalation or circuit-breaking anywhere on the historian path that this record missed?

- Sources examined: `historian.rs:1145-1166` (both backoff functions),
  `:28-34` (the backoff constant and the three error-class prefixes:
  `chain-exhausted-permanent:`, `auth-required:`, `unknown-error-class:`),
  `lib.rs:4771`, `:5101`, `:5266`, `:5357-5382` (every construction of a failure
  backoff), `lib.rs:5042-5047`, `:6700`, `:6876` (every read of
  `failure_backoff_at_ms`).
- Findings: There IS a permanent-failure concept, signalled by the
  `chain-exhausted-permanent:` prefix (`historian.rs:32`), and
  `classified_backoff_at_ms` honours a provider-supplied `retry_after_secs`. Both
  are driven by producer error classification (`ErrorClassification` from
  `historian_producer`), not by validation outcomes. So the machinery for "stop
  trying" exists and validation rejection is not routed into it.
- Missing evidence: none needed for this conclusion.
- Conclusion: resolved with answer — no escalation applies to validation
  rejections. Notably, the fix has an existing shape to follow: classify a
  persistent validation rejection the way a permanent chain exhaustion is
  classified.
