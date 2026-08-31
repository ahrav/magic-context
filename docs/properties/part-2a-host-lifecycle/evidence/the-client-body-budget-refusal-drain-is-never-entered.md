# the-client-body-budget-refusal-drain-is-never-entered

## Discovery trigger

Gap G2 asked whether every caller of `frame_read` satisfies the no-resume
obligation, "including in `client.rs`". Walking the client's three call sites
turned up a fourth thing: one of them, `drain_until` at `client.rs:2012-2021`,
has exactly one call site and that site is guarded by a condition its own comment
claims cannot occur. Per rule 3 of `../../METHOD.md` a documented guarantee is a
claim under test, so the claim was checked rather than accepted.

## Evidence trail

All references at `1c193ae0`; the cited files are byte-identical to `d90e7811`.

The branch, `client.rs:1970-1973`:

```
:1970    let Some(charge) = inner.read_budget.charge(header.len as usize) else {
:1971        drain_until(read, header.len as usize, deadline, &inner.cancel).await?;
:1972        return Err(());
:1973    };
```

The claim, `client.rs:1965-1969`: "The reservation covers the framing maximum and
belongs to the reader alone, so a valid frame is never refused because a consumer
is holding queued bytes. A refusal here therefore means the header declared more
than the framing maximum, which `validate_inbound` has already rejected — it
survives only as the structural guard for that invariant."

Four steps, each verified:

1. **The cap equals the framing maximum.**
   `pub const CLIENT_INBOUND_FRAME_BYTES: usize = MAX_BODY_LEN as usize;`
   (`client.rs:88`). The counter is built with it at `:403` and again in the test
   helper at `:2429`. `MAX_BODY_LEN` is 64 MiB (`wire.rs:371`, `:35`).
2. **A larger declaration is rejected earlier.** `validate_inbound` returns
   `Err(())` for `header.len > MAX_BODY_LEN` at `client.rs:2040`, and it is called
   at `:1957`, thirteen lines before the charge. It also rejects a channel-0 body
   over `MAX_CONTROL_BODY_LEN` at `:2048`.
3. **`charge` refuses only when something is already held.**
   `ByteCounter::charge` (`client.rs:1770-1781`) returns `None` on
   `used.checked_add(bytes)` overflow or `next > self.cap`. With
   `cap == MAX_BODY_LEN` and `bytes <= MAX_BODY_LEN` from step 2, a refusal
   requires `used > 0`.
4. **`used` is zero at every read.** The charge is created at `:1970`, moved into
   `InboundFrame` at `:1975-1979`, returned to `reader_loop`, and passed to
   `dispatch` at `:1903`. `dispatch` (`:1393`) is a synchronous `fn` with no
   await, so it completes before the loop's next `read_active_frame` call. Every
   arm releases the charge:
   - `Ping` (`:1395-1403`), `Goodbye` (`:1404-1411`), `Push` (`:1412`): the
     charge is an owned parameter, dropped at function exit.
   - `Response | Error | StreamEnd` (`:1413-1470`): explicit `drop(charge)` at
     `:1433`, or the early `return` at `:1431` for an unmatched terminal, which
     drops it.
   - `StreamData` (`:1471-...`): explicit `drop(charge)` at `:1530`, or the early
     `return` at `:1479` when no pending entry matches.

   Retained stream bytes are charged to a *different* counter,
   `retained_budget.charge(body.len())` at `:1523`, which is exactly why the two
   exist separately. The field comment at `:956-961` states it: "Reserved for the
   body of the one frame the reader is decoding. Separate from `retained_budget`
   so queue retention can never deny an otherwise valid inbound frame."

`ByteCharge`'s release is a `Drop` impl over a `Weak<ByteCounter>`
(`client.rs:1789-1792`), so dropping it decrements `used`.

One more thing to rule out: is `reader_loop` the only user of this counter's read
path? `read_active_frame` has three call sites, `client.rs:1893` in `reader_loop`
and the two in-crate tests at `:3650` and `:3683`. There is one `reader_loop` per
`Inner`, so there is one reader per counter and no concurrent charge.

So the branch cannot execute: `used == 0` and `bytes <= cap` at every charge.

## Failure scenario

The branch firing is itself the failure signal, so the scenario is a regression
that makes step 4 false. Two concrete shapes:

1. A future `dispatch` arm retains the read charge instead of the retained
   charge, for instance by moving `charge` into a `ChargedItem` at `:1524-1528`
   rather than taking a fresh `retained_budget` charge at `:1523`. Then a queued
   stream item holds up to 64 MiB of the *read* reservation, and the next frame's
   charge is refused for a legal frame. The client would drain the body, return
   `Err(())`, and retire the connection with `"protocol_violation"`
   (`:1897-1899`) for a frame that was entirely valid.
2. `dispatch` becomes `async` and holds the charge across an await. Then a slow
   consumer stalls the reader, which is the exact coupling the two-counter split
   was introduced to prevent.

In both cases the observable today is a mis-attributed close: the peer is blamed
for a protocol violation caused by local budget accounting. Nothing counts or
logs the branch, so the only symptom is unexplained client retirements.

## Timing windows and dependencies

None today, and that is the substance of the finding. `dispatch` is synchronous
and runs to completion between reads, so there is no interleaving in which
`used > 0` at a charge. The unreachability is structural, not probabilistic.

The dependency is entirely on step 4 remaining true, which is a property of
`dispatch`'s body rather than of any type. That is what makes an assertion on the
branch worth more than the prose comment: the comment cannot fail.

## What a test must construct

Nothing needs to be constructed to prove the property; it follows from the four
steps. What is needed is a tripwire, and it is one line:

1. Add `debug_assert!(false, "read reservation is reader-exclusive")` at the top
   of the `else` arm at `client.rs:1971`, or increment a counter there.
2. Run the ordinary inbound suite. Any future regression in step 4 then fails a
   debug build instead of silently mis-attributing a close.

An adversarial test that *forces* the branch is also possible and more durable,
though it needs a seam: construct an `Inner` via `test_inner`, take a charge
directly from `inner.read_budget` for `MAX_BODY_LEN` bytes and hold it, then call
`read_active_frame` with a legal small frame. The branch then fires and the test
can assert what the client does: drains the body, returns `Err(())`, and leaves
the stream aligned. That documents the guard's behaviour rather than its
unreachability, which is useful precisely because the behaviour is otherwise
never observed. `client.rs:4031` and `:4089` already take direct charges from
`read_budget` in tests, so the seam exists.

Note what such a test would reveal, and it is the record's open question: the
realignment is discarded. `read_active_frame` returns `Err(())` at `:1972`, and
`reader_loop` breaks at `:1897-1900` after `inner.retire("protocol_violation")`.
So the drain's stated purpose at `client.rs:2010-2011` — "so the failure is
reported against a stream still aligned on a header boundary" — is a promise no
code consumes.

## Investigation log

### Q: Is the comment's unreachability claim true?

- Sources examined: `client.rs:88` (the cap constant), `:403` and `:2429` (the
  counter constructions), `:956-961` (the field comments), `:1757-1787`
  (`ByteCounter`), `:1789-1810` (`ByteCharge` and its `Drop`), `:1890-1908`
  (`reader_loop`), `:1919-1980` (`read_active_frame`), `:1393-1560` (every
  `dispatch` arm), `:2039-2050` (`validate_inbound`), `wire.rs:35`, `:371`.
- Findings: true, on the four steps above. The load-bearing one is step 4, and it
  holds because `dispatch` is synchronous and every arm either explicitly drops
  the charge (`:1433`, `:1530`) or drops it by ownership at return. The
  two-counter split at `:1523` is what keeps retained stream bytes off the read
  reservation.
- Missing evidence: none for the current tree. The claim is about a code shape
  rather than a runtime condition, so it was settled by reading every arm rather
  than by testing.
- Conclusion: resolved. The branch is unreachable, and the comment's
  characterization of it as a structural guard is accurate.

### Q: Would the drain accomplish anything if the branch did fire?

- Sources examined: `client.rs:1971-1972`, `:2010-2021` (`drain_until` and its
  doc), `:1890-1908` (`reader_loop`), `:1982-1984` (`read_exact_until`'s doc,
  which states the client's reconnect-not-resume policy).
- Findings: no. The drain realigns the stream, then `:1972` returns `Err(())`,
  then `reader_loop` retires the connection at `:1897-1899` and breaks. Nothing
  reads the realigned stream. The client's own policy at `:1982-1984` says it
  "resynchronizes by reconnecting, never by guessing where the next header
  begins", which is consistent with discarding the realignment but makes the
  drain redundant.
- Missing evidence: none.
- Conclusion: resolved. Two dead claims hang off an unreachable branch: the
  drain's realignment purpose, and the branch's own value beyond being a
  tripwire. Whether to keep the drain is a design decision, recorded as the
  record's open question.
