# client-a-every-in-flight-request-is-settled-with-a-classified-send-outcome

## Discovery trigger

Task 3 asked whether an in-flight request is failed, retried, or lost silently
when the host dies, and whether a retry can duplicate an effect. Tracing
`settle_all` showed the client gets this right, which makes it one of the two
positive records in this lens.

## Evidence trail

`retire` settles before it clears anything else:

```
1667:    fn retire(&self, code: &'static str) {
1668:        if self.retired.swap(true, Ordering::AcqRel) {
1669:            return;
1670:        }
1671:        self.closed.store(true, Ordering::Release);
1672:        self.settle_all(code);
```

The `swap` at `:1668` makes settlement happen at most once per generation, so no
pending entry can be settled twice by two concurrent retire callers.

`settle_all` takes the whole map under the admission mutex, then classifies:

```
1649:    fn settle_all(&self, code: &'static str) {
1650:        let pending = {
1651:            let _admission = lock_unpoisoned(&self.admission);
1652:            std::mem::take(&mut *lock_unpoisoned(&self.pending))
1653:        };
1654:        for (_, state) in pending {
1655:            let outcome = cancel_classification(&state.publish);
```

Holding `admission` at `:1651` is what excludes a concurrent `admit`, which takes
the same mutex at `:1140` and rechecks `retired` at `:1142` while holding it. So
no request can be admitted into a map that has already been taken.

Classification is a CAS, not a read:

```
2223: fn cancel_classification(state: &AtomicU8) -> SendOutcome {
2224:     if state
2225:         .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
2226:         .is_ok()
2227:     {
2228:         SendOutcome::NotSent
2229:     } else {
2230:         classify(state)
2231:     }
2232: }
```

The CAS races the writer's own claim:

```
2209: fn claim_for_write(state: &AtomicU8) -> bool {
2210:     state
2211:         .compare_exchange(QUEUED, WRITING, Ordering::AcqRel, Ordering::Acquire)
2212:         .is_ok()
2213: }
```

called from `writer_loop:1942`. Exactly one of the two CASes wins from `QUEUED`.
If `cancel_classification` wins, the writer's `claim_for_write` fails and
`writer_loop` skips the frame with `continue` at `:1944`, so the bytes provably
never leave. That is what makes `NotSent` sound. If the writer wins, the state is
`WRITING` and then `WRITTEN` (`:1967`), and `classify` (`:2215-2221`) maps both to
`OutcomeUnknown`.

Settlement funnels through one place. `finish_pending` (`:1592-1605`) sends on the
unary oneshot at `:1595` or on the stream terminal at `:1599`, and releases the
stream slot at `:1602`. Both are one-shot channels, so a second send is
impossible.

No retry path touches a request body. `request` is documented "The body is never
replayed" at `:531`, and the only retry loop in the file is `open_route`'s at
`:460-528`, which is covered by its own record.

## Failure scenario

This record is the property holding, so the scenario is what a violation would
look like. Suppose `settle_all` read the publish state with a plain load instead
of a CAS. A frame sitting at `QUEUED` would classify `NotSent`, and the writer,
still running because `cancel.cancel()` happens after `settle_all` at `:1674`,
could then claim and transmit it. The caller would have been told its request
provably never left while the host was executing it, and a caller acting on
`NotSent` replays. For a mutating operation that is a duplicated effect.

The CAS is what closes that window, and the ordering inside `retire` is what makes
the CAS necessary: settlement at `:1672` precedes cancellation at `:1674`, so the
writer is demonstrably still alive during settlement.

## Timing windows and dependencies

The window is between `settle_all`'s CAS and `writer_loop`'s claim, and it is
resolved by the hardware. `Ordering::AcqRel` on both sides gives the winner's
write visibility to the loser's failure load.

Effect accounting, per METHOD: attempted effects are the frames whose publish
state reached `WRITING` or later; acknowledged effects are the requests that
received a host terminal, which by definition are not in the map at settlement
time because `dispatch` removes the entry at `:1412` before sending. So every
entry `settle_all` sees is unacknowledged. Observed host-side effects must be at
least zero and at most the count of entries classified `OutcomeUnknown`. Per
METHOD the aggregate is only a screen; the oracle is per identity, because a
`NotSent` issued for one delivered request and an `OutcomeUnknown` issued for one
undelivered request cancel in the total.

## What a test must construct

1. Build an `Inner` and admit N requests, arranging the four publish states:
   `QUEUED` (writer not yet running), `WRITING` (writer claimed, completion
   withheld), `WRITTEN` (completion delivered), and `CANCELLED` (a prior
   `cancel_key`). The existing fixtures `test_inner` (`:2270`) and `unary_sender`
   (`:2310`) supply the scaffolding.
2. Call `retire` and collect one settlement per identity.
3. Assert per identity: exactly one settlement arrived; `NotSent` appears only for
   identities whose frame never reached the writer channel, checked by draining
   `data_rx` and confirming absence.
4. Assert the screen: the number of frames observed on `data_rx` is at least the
   number of `OutcomeUnknown` settlements and at most the total.
5. Repeat with two concurrent `retire` callers and assert settlements are still one
   per identity, which exercises the `swap` at `:1668`.

## Investigation log

### Q: Can a pending entry escape settlement entirely?

- Sources examined: every `pending.remove` and `pending.insert` site:
  `:1200` (insert in `admit`), `:1208` (rollback), `:1263` (`cancel_key`),
  `:1412` (`dispatch` terminal), `:1476` and `:1526` (`dispatch` stream error
  paths), `:1636` (`settle_route`), `:1652` (`settle_all`).
- Findings: every removal is followed by either `finish_pending` or a direct
  terminal send. `:1208` is the only removal without a settlement, and it is the
  rollback of an insert whose caller is still on the stack and receives an `Err`
  return instead. `UnaryAdmissionGuard::drop` (`:1718-1724`) covers the case where
  the caller's future is dropped mid-flight by calling `cancel_key`.
- Missing evidence: none.
- Conclusion: resolved with answer. No path removes an entry without settling its
  caller or returning the error synchronously.

### Q: Does the stream deadline watcher survive settlement?

- Sources examined: `PendingKind::Stream::_settled` (`:924-930`), the watcher spawn
  (`:1091-1108`), `finish_pending` (`:1597-1603`), the terminal branch in
  `dispatch` (`:1444-1461`).
- Findings: the `DropGuard` is held inside the pending entry, so dropping the entry
  cancels the `settled` token, and the watcher's biased first branch at `:1096`
  wins. The comment at `:924-930` explains this was chosen precisely because
  `dispatch:1459` settles the caller without going through `finish_pending`.
- Missing evidence: none.
- Conclusion: resolved with answer. `settle_all`'s drop of the entry retires the
  watcher on every path, so a settled stream cannot later cancel a correlation the
  host may have reused. `settled_stream_retires_its_deadline_watcher` (`:2564`)
  covers this.
