# uncertain-producer-start-authorizes-a-second-billable-run

## Discovery trigger

METHOD.md's effect-accounting rule asks for attempted and acknowledged counts
tracked separately on any path where a response can be lost. The historian's
effect is a producer run, which costs money and provider capacity. Reading the
fallback chain showed the output-failure branch has an explicit, carefully
argued proof requirement before it starts a second run, and the start-failure
branch has none. The asymmetry is the finding.

## Evidence trail

### The protected branch

`crates/mc-module/src/historian.rs:1369-1413`, the `await_output` failure arm:

- `:1370` `let cancel_result = producer.cancel(&handle.run_id).await;`
- `:1377-1385` `decide_producer_failure` produces `try_next_model`.
- `:1386-1397` persists the abandon with detail.
- `:1398-1400` the comment: "Fallback requires typed proof that the failed attempt
  is over. Transport failures and uncertain send outcomes cannot prove the
  cancellation reached and stopped the provider run."
- `:1401` `if decision.try_next_model && cancellation_confirmed_stopped(&cancel_result)`.
- `:1226-1240` `cancellation_confirmed_stopped` and its doc, which is unusually
  explicit: "Authorizing fallback starts a second potentially billable run, so this
  needs positive proof, not the absence of one known-bad code. ... `Ok(())` is the
  proof ... Every terminal error leaves the run's state unproven, so none of them
  authorize a second run."

Three tests cover this: `:3389` `unconfirmed_cancellation_stops_the_fallback_chain`,
`:3444` `uncertain_cancel_send_outcomes_stop_the_fallback_chain`, and `:3498`
`a_terminal_cancel_error_never_authorizes_fallback`.

### The unprotected branch

`crates/mc-module/src/historian.rs:1285-1329`, the `producer.start` failure arm:

- `:1290` `Err(err) => {`
- `:1291-1296` computes the completion-anchored backoff.
- `:1297-1305` `decide_producer_failure`.
- `:1306-1317` persists the abandon with detail
  `"producer start ({model}): {err:?}"`.
- `:1318-1322` `if decision.try_next_model { let cleanup = producer.close_attempt().await; ... continue; }`
- `:1323-1328` otherwise closes and returns.

There is no `cancel` call, no `cancellation_confirmed_stopped` check, and no
inspection of the send outcome. There cannot be a `cancel`, because `start` failed
and no run id is known.

### The decision function never sees the send outcome

`crates/mc-module/src/historian.rs:1052-1143` `decide_producer_failure` branches
on, in order: `err.is_cross_incarnation_unknown()` (`:1061-1068`),
`err.classification()` and its four classes (`:1069-1121`), `err.has_class_field()`
(`:1124-1131`), and finally the deprecated heuristic (`:1133-1142`). None of those
reads the send outcome.

`crates/mc-module/src/historian_producer.rs`:

- `:78-82` `enum HistorianSendOutcome { NotSent, OutcomeUnknown, Terminal }`.
- `:84-92` the `From<SendOutcome>` conversion, so the variant comes from
  `mc_host`.
- `:94-99` `HistorianCallFailure` carries `outcome`, `code`, and `message`.
- `:412-433` `heuristic_decision` reads `failure.code` and `failure.message` for
  `Call` failures, and `detail` for `RunFailed`. It never reads `failure.outcome`.
- `:392-400` `is_retryable_model_failure` likewise.

So an `OutcomeUnknown` start failure is indistinguishable, for fallback purposes,
from a `NotSent` one.

### Where `NotSent` is used deliberately

`historian_producer.rs:779-790` gates the start on `stop_requested()` and returns
`NotSent` with the comment "`NotSent` is exact: no frame has been queued on any
route yet." So the codebase does treat the outcome as meaningful; it just does not
consult it on the fallback decision.

### Why this is not a double publish

- The retry loops back to `:1256` and re-fires, which increments `firing_seq`
  (`:257`) and derives a new producer session id from it (`:1013-1035`).
- The orphaned first run's id is unknown, so nothing ever drains it and no output
  from it can reach `publish_output_from_awaiting`.
- The publish predicate binds `producer_run_id` (`mc-store:9400`), so even a
  recovered orphan output could not publish under the new firing.
- `run_historian_firing` returns immediately after the first successful publish
  (`:1456-1462`), so at most one publish per call.

The cost is therefore money, provider load, and a live run the module cannot
cancel, not a duplicated fold.

## Failure scenario

1. A configured chain of two models. The pressure path fires.
2. `start` for model A is sent, Broca receives it and begins a run, and the reply
   is lost. `mc_host` reports `SendOutcome::OutcomeUnknown` with a transient
   classification.
3. `decide_producer_failure` sees `ErrorClass::Transient` (`:1083-1099`), finds an
   eligible remaining model, and returns `try_next_model: true`.
4. `close_attempt` then `continue`. A second `start` runs for model B under a new
   `firing_seq`.
5. Two provider runs execute for one chunk. One publishes; the other completes and
   is never read, or is cancelled by Broca's own lifecycle, or runs to completion
   and bills.

Per-identity accounting for that firing: `attempted = 2`, `acknowledged = 1`,
observed provider runs `= 2`. The bound `acknowledged <= observed <= attempted`
holds, which is why the bounds are only a screen; the per-identity check is what
shows the orphan.

## Timing windows and dependencies

The window is the `start` request itself, bounded by `DEFAULT_REQUEST_TIMEOUT`
(30 s, `historian_producer.rs:29`). Dependencies:

- `mc_host`'s `SendOutcome` must be accurate about `OutcomeUnknown`. That is Part
  2b territory.
- Broca's own behaviour on an unacknowledged start: whether it begins the run
  before replying. If it replies first and only then starts, the window is empty.
  That is outside this repository.

## What a test must construct

1. A producer double with two models configured. The first `start` returns
   `HistorianProducerError::Call(HistorianCallFailure { outcome: OutcomeUnknown,
   ... })` with a transient class tag; the second succeeds and publishes.
2. The oracle lives at the fake, not in the module: count `start` calls and count
   runs the fake considers live. Assert `attempted == 2` and that the fake observed
   two live runs while the module acknowledged one.
3. A coverage marker asserting the independent preconditions rather than the
   defect: that a `start` failure carrying `OutcomeUnknown` occurred, and that the
   chain had an eligible remaining model. Both fire on a correct implementation and
   both are required for the window to exist.
4. Also assert the non-regression on the protected branch, which the three
   existing tests already do, so the two branches can be compared in one suite.

## Investigation log

### Q: Is the asymmetry deliberate, on the grounds that a start with no run id cannot be cancelled anyway?

- Sources examined: `crates/mc-module/src/historian.rs:1285-1329`, `:1369-1413`,
  `:1226-1240`, `:1052-1143`; `crates/mc-module/src/historian_producer.rs:78-99`,
  `:376-433`, `:752-800`; the three cancel-proof tests at `historian.rs:3389`,
  `:3444`, `:3498`; `historian.rs:2494`
  `cross_incarnation_unknown_records_completion_backoff_without_fallback`, which is
  the one place a start-side uncertainty **does** stop the chain.
- Findings: `:2494`'s test and the `is_cross_incarnation_unknown` branch at
  `:1061-1068` show the authors did think about start-side uncertainty, but only for
  the cross-incarnation case, where the run id is known to belong to a previous
  process. Plain `OutcomeUnknown` on a fresh start is not covered. The reasoning in
  `cancellation_confirmed_stopped`'s doc applies verbatim to it: "Authorizing
  fallback starts a second potentially billable run, so this needs positive proof."
- Missing evidence: whether Broca can start a run before acknowledging the start
  request. If it cannot, the window does not exist and this is a non-finding. That
  is determined outside this repository.
- Conclusion: needs human input. If the window is real, the mitigation is to refuse
  fallback when the start failure carries `OutcomeUnknown`, mirroring the output
  branch, rather than to attempt a cancel that has no target. Recording it as a
  property makes the accounting explicit either way.
