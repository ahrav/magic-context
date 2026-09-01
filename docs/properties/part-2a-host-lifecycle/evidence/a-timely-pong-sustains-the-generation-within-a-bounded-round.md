# a-timely-pong-sustains-the-generation-within-a-bounded-round

## Discovery trigger

Gap G3 from `portfolio-evaluation.md`: all three existing liveness records concern
shutdown or lifecycle evidence, and nothing states the probe's own steady-state
contract. The catalog has records for pong pre-answering, correlation exhaustion,
and correlation cross-settling, so it covers the probe's adversarial edges while
never stating what the probe does when everything works.

## Evidence trail

The loop is `connection.rs:1345-1478`. Its spawn site is `connection.rs:291-300`,
gated on `if let Some(policy) = shared.liveness`.

Every bound is a `policy` field:

- `:1346` first tick at `Instant::now() + policy.ping_interval`.
- `:1355-1364` wake is `min(next_ping_at, min over probes of sent +
  pong_deadline)`, restricted at `:1358` to probes with `written_at.is_some()`.
- `:1370-1375` a probe is expired when
  `now.duration_since(probe.sent) >= policy.pong_deadline`, again restricted to
  `written_at.is_some()` at `:1372`.
- `:1376-1379` `if expired && policy.invalidate_on_missed { gen.token.cancel();
  return; }`.
- `:1399` re-arm at `now + policy.ping_interval`.

`config.rs:370-382` rejects a zero `ping_interval` or `pong_deadline` with
`ConfigError::ZeroDuration`, and rejects either above `MAX_CONFIG_DURATION`. So an
accepted policy always has strictly positive, finite bounds, which is what makes a
finite check legitimate here.

`probe.sent` has exactly two writers:

1. The insert at `:1403-1411` sets `sent: Instant::now()`, `written_at: None`,
   `answered_at: None`.
2. The write-completion hook at `:1426-1447` sets `probe.sent = completed_at`
   (`:1443`) and `probe.written_at = Some(completed_at)` (`:1444`).

The read loop's `Pong` arm (`:500-540`) mirrors the same split. With completion
recorded it evaluates `now.duration_since(probe.sent) < p.pong_deadline`
(`:519-522`) and removes the probe when inside. With completion unknown it parks
the arrival at `:535`.

Reachability label evidence: `config.rs:282` declares the option,
`config.rs:296` defaults it to `None`, and the only in-crate `liveness: Some(..)`
is `config.rs:664`, inside `#[cfg(test)]`. The integration harness also sets it
(`tests/client.rs:99-103` via `TestHost::start_with`, `tests/support/mod.rs:592`),
which is still test code. Label: `explicit-config-only`.

## Failure scenario

Direction (a) fails if a probe is expired despite a timely answer. The two ways
that can happen are a deadline evaluated against the enqueue instant rather than
the completion instant, and a probe left in the map after its Pong was accepted.
The consequence is a retired generation for a healthy peer, which is exactly the
outcome `config.rs:236-238` cites as its reason for defaulting
`invalidate_on_missed` to `false`.

Direction (b) fails if a silent peer keeps its generation. Concretely: if
`written_at` were never set because the completion hook did not run, `:1372`
filters the probe out of the expiry scan forever, so the loop keeps waking on the
tick, sees a non-empty `pings` map, takes the `continue` at `:1387-1392`, and never
issues another Ping. The generation then lives with no probe and no expiry. The
existing record `host-ping-correlation-exhaustion-retires-the-generation` covers a
different failure of the same map.

## Timing windows and dependencies

The window is `[write_completion, write_completion + pong_deadline)`. A Pong
inside it is accepted, at or after it is not. The check must assert both sides of
that boundary, and a wall-clock test cannot: `pong_deadline` in the existing
integration fixture is 80ms, well inside scheduler noise on a loaded CI runner.
Paused virtual time makes the boundary exact.

There is a second, looser dependency worth stating because it bounds nothing: the
time from Ping *issuance* to retirement is unbounded, because the deadline is
anchored at completion and admission itself can take up to `frame_deadline`
(default 30s, `config.rs:224`). So this record's bound is per-round, measured from
completion, and no total-detection-time bound exists. That is the subject of the
sibling record `slow-egress-alone-does-not-retire-a-probed-generation`.

`invalidate_on_missed` must be `true` for direction (b). With it `false`, `:1380-1386`
clears the map on expiry and the loop continues, so the generation survives a
missed Pong by design.

## What a test must construct

Both directions fit the existing in-crate duplex harness at
`connection.rs:1481` onward, so no new infrastructure is needed.

Direction (a):

1. `#[tokio::test(start_paused = true)]` with a policy of, say, 100ms interval and
   400ms deadline, `invalidate_on_missed: true`.
2. Drive a cooperative peer that reads each Ping and writes a Pong echoing its
   flag byte exactly, one virtual millisecond later.
3. Advance the clock by `k * ping_interval + pong_deadline` for a fixed small `k`,
   for example 5.
4. Assert `gen.token.is_cancelled()` is false, `gen.pings` is empty, and exactly
   `k` Pings were observed on the wire. The Ping count is the part
   `tests/client.rs` omits, and it is what stops the test passing when the probe
   never runs.

Direction (b):

1. Same setup, peer reads and never answers.
2. Capture the completion instant, advance to `completion + pong_deadline - 1ns`,
   assert not cancelled.
3. Advance the final nanosecond, assert `gen.token.is_cancelled()`.

## Investigation log

### Q: Should the retirement bound be stated from write completion or from Ping issuance?

- Sources examined: `connection.rs:1403-1411` (insert), `:1426-1447` (hook),
  `:1443-1444` (the re-anchor), `:1355-1364` and `:1370-1375` (both
  `written_at.is_some()` filters), the read-loop comment at `:527-534`,
  `frame_channel.rs:779-785` and `:819-823` (admission bound).
- Findings: the completion anchor is deliberate and documented. The comment at
  `:529-532` states the reason directly: "a Ping queued behind large frames would
  otherwise have its answer rejected before it was even written". Anchoring at
  issuance would charge the peer for the host's own queueing, which is a real
  defect the current design avoids. But the consequence is that total time from
  Ping issuance to detecting a dead peer is bounded only by `admission_timeout +
  frame_deadline + pong_deadline`, and the first two are the same 30 second
  default.
- Missing evidence: whether the protocol specifies a total detection bound. Not
  established in this pass.
- Conclusion: resolved with answer for this record. State the bound from write
  completion, because that is what the code bounds and the METHOD liveness rule
  requires the bound in the units the code uses. The absence of a total bound is
  carried as the record's open question rather than folded into the check, because
  it is a design question, not a check-construction question.
