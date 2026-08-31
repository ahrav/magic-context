# reactor-callback-is-one-in-flight

## Discovery trigger

PR #131 introduced the readiness reactor; fix commit `a51f019cf` "allow one
readiness notification while the prior callback returns" shaped the pending
gate and the kick deferral. Leads only; re-verified at HEAD.

## Evidence trail

- The gate is a single `AtomicBool`. The reactor thread dispatches only
  through `pending.compare_exchange(false, true, ..)` followed by
  `callback.call` (`packages/mc-shm-native/src/scheduling.rs:169-175`); a
  failed CAS dispatches nothing, and a failed threadsafe call rolls the flag
  back (`:175-177`).
- After a successful dispatch the reactor blocks in `wait_until_handled`
  (`:52-68`): poll the control eventfd while `pending && !closing`. It
  cannot reach `epoll::wait` again — cannot observe another doorbell edge —
  until JS acknowledges.
- The acknowledgement is `handled()` (`:279-282`): store `pending = false`,
  write the control eventfd. Called from `readiness_handled`
  (`packages/mc-shm-native/src/lib.rs:1154`) after every channel has been
  re-armed, so the epoch where a second callback becomes possible starts
  only after the re-arm that makes it safe.
- A `kick` (`:284-287`) raised during the pending window does not dispatch;
  `wait_until_handled` returning true with `kick` set rewrites the control
  fd (`:178-181`), producing exactly one deferred pass through the loop.
- The error paths keep the callback path single-file too: an epoll failure
  dispatches one final callback only if the CAS succeeds (`:138-154`), and a
  `wait_until_handled` error fires one non-gated call and breaks
  (`:184-189`) — the sole call site that bypasses the CAS, on a path that
  terminates the thread.
- Why it matters downstream: `readiness_handled` walks a thread-confined
  `REGISTRY` (`lib.rs:1136-1156`) and the `Ring` is `!Send + !Sync`
  (`ring.rs:726` `PhantomData<Rc<()>>`); one-in-flight is what makes "at
  most one readiness closure touching the channels at a time" true, and the
  max-queue-size-2 threadsafe function (`scheduling.rs:97`) relies on calls
  being acknowledged, not accumulated.

## Failure scenario

Two unacknowledged callbacks in flight: the second `dispatchReadiness` runs
while the first is mid-walk. Both iterate every registered channel
(`index.ts:515-527`), interleaving `poll`/`readiness_handled` calls; the
registry's `try_borrow_mut` turns the overlap into "native channel is busy"
errors on a healthy channel, and a double `handled()` un-blocks a reactor
epoch whose re-arm never ran, which is a manufactured lost wake.

## Timing windows and dependencies

The protected window is dispatch-to-acknowledgement. The property depends on
JS calling `readinessHandled` exactly once per callback: the wrapper's
`finally` (`index.ts:524-526`) does this; a raw-addon consumer that calls it
twice per callback breaks the epoch pairing from the outside. The
`closing`/`failed` transitions bound the window at shutdown
(`wait_until_handled` exits on `closing`, `:58-66`).

## What a test must construct

Doorbell edges arriving while a callback is unacknowledged, then an exact
callback count. Exists in two halves:
`readiness acknowledgement preserves a frame published during callback`
(`packages/mc-shm-native/tests/mechanism.ts:211-276`) publishes during
callback 1 and asserts `callbacks === 2` — exactly one deferred dispatch,
not two; `pending_callback_waits_for_acknowledgement`
(`scheduling.rs:320-348`) pins that a control write alone does not release
the wait while `pending` holds. Not yet constructed: edges from *multiple*
registered channels landing in one pending window (the coalescing claim),
and a hostile double-`readinessHandled` probing the epoch pairing.

## Investigation log

### Q: is the non-CAS callback on the wait-error path a violation?

- Sources examined: `scheduling.rs:184-189`.
- Findings: it can overlap an unacknowledged callback only if
  `wait_until_handled` errored, which requires a poll failure on a live
  eventfd; the thread then breaks, `failed` is not set on this branch, but
  `ensure_healthy` (`:268-276`) is also not consulted by the JS dispatcher.
  One extra callback on a dying reactor is the worst case.
- Conclusion: resolved with answer — bounded single-shot exception on a
  terminal path; recorded in the catalog's open questions.

### Q: does `weak::<true>` let the callback vanish while pending?

- Sources examined: `:96-99` (builder), napi-rs weak threadsafe semantics.
- Findings: a collected callback makes `call` return non-Ok, which rolls
  `pending` back (`:175-177`); no permanent wedge.
- Conclusion: resolved with answer — no wedge; delivery stops when the JS
  side drops the function, which is shutdown behavior.
