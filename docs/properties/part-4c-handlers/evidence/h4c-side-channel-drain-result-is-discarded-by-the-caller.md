# h4c-side-channel-drain-result-is-discarded-by-the-caller

## Discovery trigger

METHOD.md's effect-accounting rule requires attempted and acknowledged effects to
be tracked separately when a response can be lost. Scanning this lens's scope for
places where the store already computes that pair and the module throws it away,
`drain_historian_side_channels` at `crates/mc-module/src/lib.rs:8252` is bound to
`let _` while the store fills in three counters for it.

References are to `crates/mc-module/src/lib.rs` unless the store is named.
Verified at `HEAD` `b5dc778e`; `mc-module` is unchanged between `76cd6f41` and
`b5dc778e`.

## Evidence trail

**The discard.**

```
8249        // A previous publish may have committed while one independent side channel failed.
8250        // Retry on normal traffic rather than creating another background timer.
8251        let side_channel_drain_started_at = Instant::now();
8252        let _ = store.drain_historian_side_channels(
8253            &parsed.session_id,
8254            pass_now,
8255            HISTORIAN_SIDE_CHANNEL_DRAIN_PER_KIND,
8256        );
8257        let side_channel_drain_ms = side_channel_drain_started_at.elapsed().as_secs_f64() * 1_000.0;
```

The comment establishes the intent: this is a retry-on-traffic mechanism for
deliveries that failed after a previous publish. So repeated failure is exactly the
state it exists to handle, and exactly the state whose rate is discarded.

Note `side_channel_drain_ms` at `:8257`: the handler measures how long the drain
took and keeps that, while discarding what the drain did.

**What the store returns.**

```
9551    pub fn drain_historian_side_channels(
9552        &self,
9553        session_id: &str,
9554        now_ms: i64,
9555        per_kind_limit: usize,
9556    ) -> Result<HistorianSideChannelDrainResult, McStoreError> {
9557        let mut result = HistorianSideChannelDrainResult::default();
9558        let mut bookkeeping_error = None;
9559        self.delete_delivered_historian_side_channels(session_id)?;
```

(`crates/mc-store/src/lib.rs:9551-9559`.) And the per-row accounting:

```
9571            for row in rows {
9572                result.attempted += 1;
9573                match self.deliver_historian_side_channel(&row, now_ms) {
9574                    Ok(()) => {
9575                        result.succeeded += 1;
9576                        if let Err(error) = self.delete_delivered_historian_side_channel(&row) {
9577                            bookkeeping_error.get_or_insert(error);
9578                        }
9579                    }
9580                    Err(error) => {
9581                        result.failed += 1;
```

(`crates/mc-store/src/lib.rs:9571-9581`.) So `attempted`, `succeeded`, and
`failed` are all computed. The `let _` at module `:8252` discards all three, and
also discards the `Err` arm of the `Result`, which covers the
`delete_delivered_historian_side_channels` failure at store `:9559`.

**The operator surface exists.** This bounds the finding and is the reason this
record is an observability gap rather than silent loss:

```
30071        let status =
30072            call_dispatch_request(&handler, json!({ "kind": "status", "session_id": "ses" })).await;
30073        assert_eq!(status["historian"]["side_channel_pending_count"], 1);
30074        assert!(status["historian"]["side_channel_last_failure"]
30075            .as_str()
30076            .is_some_and(|error| error.contains("event")));
```

The test is `status_diagnostics_surface_pending_historian_side_channel_failure` at
`:30037`, and it uses the store seam `fail_next_historian_side_channel_for_test`
at `:30041`. So an operator polling `status` sees a pending count and the last
failure string.

**What the caller sees.** Nothing. The transform response is assembled from
`result.response` at `:8521` with `response.historian = Some(diagnostics)` at
`:8528`. The diagnostics come from the historian trigger path, not from the drain
result, which was discarded 270 lines earlier.

## Failure scenario

1. A historian publish commits, and one side channel, for example the event
   channel, fails to deliver. A row remains due.
2. Normal traffic continues. Every transform pass calls the drain at `:8252`.
3. The delivery keeps failing, perhaps because the destination is
   misconfigured.
4. Each pass attempts one or more deliveries, fails them, and discards the
   counters. The transform response is unaffected, as designed.
5. An operator polling `status` sees `side_channel_pending_count` stuck at a
   nonzero value and a `side_channel_last_failure` string. That is a *level*
   signal: it says work is outstanding.
6. What no surface reports is the *rate*: how many deliveries were attempted and
   how many succeeded on a given pass. A channel failing every attempt on every
   pass and a channel with one stale row that is never retried both present as a
   nonzero pending count.

The distinction matters because the mechanism's whole design, per the comment at
`:8249-8250`, is "retry on normal traffic". Whether that retry is running and
failing, or not running at all, is the question the discarded counters would
answer.

## Timing windows and dependencies

No interleaving. The discard is unconditional on every transform pass.

Dependency: whether `side_channel_pending_count` distinguishes "never attempted"
from "attempted and failed". If it does, this record collapses to a minor
convenience gap. `historian_status_summary` assembles that field and lives at
`:15447-15736` per the region map, which is 4d's range, so this lens did not read
it.

Dependency: `HISTORIAN_SIDE_CHANNEL_DRAIN_PER_KIND`, passed at `:8255`. Store
`:9560-9562` returns early with a zeroed result when the limit is 0, so a
misconfigured limit would also present as a discarded no-op. The constant is in
the `:596-669` budget block.

## What a test must construct

- A session with a due historian side-channel row and a delivery that fails.
  `:30037-30076` already constructs exactly this and is the natural base.
- A transform pass driven over that session, so `:8252` runs with work available.
- Oracle: this property is about reportability, so the oracle is a surface check
  rather than a state check. Assert that when the store's drain reports
  `failed > 0`, some response field reports a nonzero pending or failed count for
  that session. The existing test already establishes the `status` half; the gap is
  that nothing asserts the per-pass half because no per-pass field exists.
- Per METHOD.md's effect accounting: the honest oracle here is a bounds screen.
  For one session, observed successful deliveries must be at most the attempted
  count and at least the acknowledged count. The store computes both bounds and the
  module discards them, so today the screen cannot be built from the transform path
  at all. That is the finding, stated as a testability fact.
- Do not pair `always(!failed_silently)` with `sometimes(failed_silently)`;
  METHOD.md forbids it. Assert the preconditions: a due row exists, and a pass ran.

## Investigation log

### Q: Does `side_channel_pending_count` distinguish "never attempted" from "attempted and failed"?

- Sources examined: `:30073-30076` for what the field reports in the one covered
  scenario; the region map entry for `historian_status_summary` at `:15447-15736`;
  the store's counter arithmetic at `crates/mc-store/src/lib.rs:9571-9581`.
- Findings: the test asserts a pending count of 1 *and* a nonempty
  `side_channel_last_failure` containing the failing kind. The presence of a
  last-failure string suggests the store records failure detail per row, so an
  attempted-and-failed row is distinguishable from an untouched one at the store
  level. Whether `status` exposes that distinction cleanly is a different question.
- Missing evidence: the body of `historian_status_summary`, in 4d's range.
- Conclusion: unresolved, needs 4d. The likely answer is that the level signal is
  adequate for an operator and the rate signal is genuinely absent. Recording the
  record at that reduced severity rather than claiming silent loss.

### Q: Is the `let _` deliberate?

- Sources examined: the comment at `:8249-8250`; the comparable discards at
  `:8262` and `:8332`, both of which have a justifying comment at `:8258-8261`;
  `record_no_fire`'s documented discard at `:5321-5322` and `:5335`.
- Findings: this file discards store results in several places and usually says
  why. The `:8249-8250` comment explains why the drain runs here, not why its result
  is dropped. The neighbouring trace discard at `:8262` *is* justified, by
  `:8258-8261`, on the grounds that "a trace failure must never change the transform
  result". That reasoning transfers to the drain: a drain failure must not fail the
  pass. Dropping the *result* is a weaker claim than dropping the *error*, and the
  comment covers only the latter.
- Missing evidence: none needed. The reasoning for not failing the pass is sound and
  documented by analogy; the reasoning for not reporting the counters anywhere is
  absent.
- Conclusion: resolved with a narrowed answer. Not failing the pass is deliberate
  and correct. Not surfacing `attempted`/`succeeded`/`failed` is an unexamined
  consequence of using `let _` to achieve it.
