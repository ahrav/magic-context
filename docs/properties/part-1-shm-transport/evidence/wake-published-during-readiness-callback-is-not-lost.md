# wake-published-during-readiness-callback-is-not-lost

## Discovery trigger

Three fix commits inside PR #131's branch: `ee73e7034` "preserve data wakes
published during readiness callbacks", `72284f04d` "redispatch readiness after
callback-side publication", `a51f019cf` "allow one readiness notification
while the prior callback returns". Leads only; mechanism re-verified at HEAD.

## Evidence trail

- The reactor allows one in-flight callback: after a successful dispatch the
  `mc-shm-readiness` thread blocks in `wait_until_handled`
  (`packages/mc-shm-native/src/scheduling.rs:52-68`) until JS acknowledges.
  During that window an epoll edge on a channel doorbell is not observed.
- The acknowledgement itself is the recovery point. `readiness_handled`
  (`packages/mc-shm-native/src/lib.rs:1135-1157`) walks every registered
  channel, calls `complete_data_wait` (drains the coalesced token,
  `ring.rs:857-862`) then `arm_data_wait` (`ring.rs:828-854`). `arm_data_wait`
  returns `Ok(false)` when data or a generation change is already visible —
  exactly the state a publication during the callback leaves behind — and
  `readiness_handled` converts `Ok(false)` or `Err` into `redispatch = true`
  (`lib.rs:1149-1152`).
- The JS side re-enters on that value: `dispatchReadiness`
  (`packages/mc-shm-native/index.ts:515-527`) runs
  `if (loaded?.readinessHandled()) queueMicrotask(dispatchReadiness)` in a
  `finally`, so a true return is a guaranteed next dispatch even when a
  handler threw. The raw-addon test drives the same contract manually
  (`mechanism.ts:254` `if (addon.readinessHandled()) queueMicrotask(onReady)`).
- A kick raised while the callback is pending is also preserved:
  `wait_until_handled` returning true with `kick` still set rewrites the
  control eventfd (`scheduling.rs:178-181`), so the reactor loop sees a
  control edge on its next `epoll::wait` instead of dropping the kick.
- Publisher side: `commit_reservation` signals the data doorbell through
  `signal_wake` (`ring.rs:1622`), which bumps the shared generation
  unconditionally (`:1426`) and writes the eventfd only when a parked epoch
  existed (`:1427-1429`). The generation bump is what `arm_data_wait`'s
  recheck observes even when no eventfd byte was written.

## Failure scenario

Peer publishes frame N+1 while the JS callback for frame N is running. The
doorbell token for N+1 is either coalesced into the token the callback is
about to drain, or never written because no epoch was parked. Without the
re-arm-and-redispatch contract, the consumer parks again and sleeps until an
unrelated event: a delivered frame sits invisible with no error and no
backpressure signal, indistinguishable from an idle channel.

## Timing windows and dependencies

The window is the whole callback execution: from the reactor's `pending` CAS
(`scheduling.rs:169-172`) to `handled()` (`:279-282`). Bounded recovery: one
`readiness_handled` call. The property depends on every acknowledger honoring
the boolean; a caller that ignores a true return reintroduces the lost wake
(the raw addon API makes this the caller's obligation; `index.ts` honors it).

## What a test must construct

A publication strictly inside a callback, then an assertion that a second
callback delivers it with no further publication. Exists:
`readiness acknowledgement preserves a frame published during callback`
(`packages/mc-shm-native/tests/mechanism.ts:211-276`) publishes frame 2 from
callback 1 and requires `received == [1, 2]` and `callbacks == 2`. Not yet
constructed: the same race through the `NativeChannel.startReadiness` wrapper
with multiple registered channels, and a kick raised by `poll`'s empty-path
re-arm (`lib.rs:1226-1235`) landing during a pending callback.

## Investigation log

### Q: can a saturated eventfd counter drop the wake?

- Sources examined: `Doorbell::signal` (`ring.rs:416-428`).
- Findings: `EAGAIN` on write means the counter is at its maximum, which
  already reads as `POLLIN`; treating it as success loses nothing.
- Conclusion: resolved with answer — no.

### Q: is the generation bump alone sufficient when no epoch is parked?

- Sources examined: `signal_wake` (`ring.rs:1418-1432`), `arm_data_wait`
  rechecks (`:840-853`).
- Findings: an unparked consumer is by definition about to run
  `data_available` or `arm_data_wait`, both of which observe the published
  cursor or the changed generation before blocking.
- Conclusion: resolved with answer — yes, for consumers using the arm
  protocol; a consumer blocking on the raw fd without arming would race, and
  none exists at HEAD.
