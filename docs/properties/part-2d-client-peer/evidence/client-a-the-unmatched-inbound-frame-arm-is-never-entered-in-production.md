# client-a-the-unmatched-inbound-frame-arm-is-never-entered-in-production

## Discovery trigger

Cross-checking `dispatch`'s match arms against `validate_inbound`'s to confirm the
client's inbound classification is total. The two are total in different ways, and
the second one's fallback is dead in production.

## Evidence trail

`dispatch`'s arms and the variants each covers:

```
1387:        match header.ty {
1388:            FrameType::Ping => { ... }                                     -> 7
1397:            FrameType::Goodbye if header.channel == 0 => ...               -> 11
1398:            FrameType::Goodbye => { ... }                                  -> 11
1405:            FrameType::Push => {}                                          -> 2
1406:            FrameType::Response | FrameType::Error | FrameType::StreamEnd => { ... }  -> 1, 5, 4
1464:            FrameType::StreamData => { ... }                               -> 3
1557:            _ => self.retire("protocol_violation"),                        -> 0, 6, 8, 9, 10
1558:        }
```

So the catch-all at `:1557` covers `Request`, `Cancel`, `Pong`, `Hello`, and
`HelloAck` (`wire.rs:52-63`).

`validate_inbound` rejects all five before `dispatch` is ever called. Its arms cover
`Response | Error` (`:2022`), `StreamData | StreamEnd` (`:2038`), `Push` (`:2050`),
`Ping` (`:2057`), and `Goodbye` (`:2062`), with everything else falling to:

```
2067:        _ => return Err(()),
```

The single production caller of `dispatch` gates on that:

```
1977:    while let Some((header, body, charge)) = read.recv().await {
1978:        if validate_inbound(&header).is_err() || body.len() != header.len as usize {
1979:            inner.retire("protocol_violation");
1980:            return;
1981:        }
1982:        inner.dispatch(header, body, charge);
```

`grep` for `dispatch(` in `client.rs` returns the definition at `:1386`, the
production call at `:1982`, and sixteen calls inside `#[cfg(test)] mod tests`
(`:2265`): `:2595`, `:2779`, `:2832`, `:3282`, `:3334`, `:3362`, `:3399`, `:3467`,
`:3553`, `:3605`, `:3668`, `:3750`, `:3802`, `:3860`, `:3919`. That is the whole
caller set. So on the production path `:1557` is unreachable, and the only way to
reach it is the test module's direct calls, which bypass `validate_inbound`
entirely.

Both sites use the same retirement code, `protocol_violation`, so a reader of a
retirement code cannot tell which classification fired. That is consistent with
`client-a-a-retired-generation-forgets-why-it-retired`.

## Failure scenario

This record's guarantee is that the arm is not entered, so the scenario is what its
violation would mean. If someone added a `FrameType` arm to `validate_inbound` that
accepted, say, `Cancel`, without adding the matching `dispatch` arm, the frame would
pass validation and land at `:1557`, retiring the generation with the same code
`validate_inbound` would have used. The behaviour would be identical, so nothing
would fail, and the new arm would look like it worked while doing nothing.

The inverse is the real hazard. If someone removed a rejection from
`validate_inbound` intending to support a new frame type, and added the `dispatch`
arm, nothing checks that the two sets stay complementary. The classification decision
lives in two places with no shared source, and there is no assertion tying them
together.

A secondary consequence: the sixteen test call sites exercise `dispatch` with headers
that never passed `validate_inbound`, so the tests cover a wider input space than
production can produce. That is normal for a unit harness, but it means a test
asserting `dispatch` handles some header correctly is not evidence that the header can
occur.

## Timing windows and dependencies

No timing. This is a static reachability claim about one statement.

Depends on `client-a-a-host-originated-cancel-retires-the-generation`, which is the
one member of the residue whose rejection is questionable. If a `Cancel` arm were
added to both functions, the residue shrinks to four and the property still holds.

## What a test must construct

Per METHOD, `unreachable` semantics attach to a code location that must not execute,
which is exactly what this is:

1. A marker at `client.rs:1557` named constantly and uniquely, for example
   `client_dispatch_unmatched_frame_type`. It must never fire during any
   production-path campaign. Marker names must not be constructed dynamically.
2. Independently, an assertion that `validate_inbound` returned `Err` for each of the
   five residue types, which is the reason the marker cannot fire. Without that second
   half the marker's silence is uninformative: it would also stay silent if the
   campaign never sent any of those types at all.
3. The natural home for the second half is
   `inbound_validation_enforces_the_direct_profile_table` (`:2658`), which is already
   table-driven over frame types.
4. A stronger structural check is possible and worth suggesting: assert that the set
   of `FrameType` variants `dispatch` names explicitly and the set
   `validate_inbound` accepts are equal. That is the invariant the two sites are
   really maintaining, and it would catch a divergence in either direction.

## Investigation log

### Q: Is `dispatch` reachable from anywhere other than `ring_reader_loop`?

- Sources examined: `grep -n 'dispatch(' crates/mc-host/src/client.rs`, which returns
  `:1386` (definition), `:1982` (production), and sixteen sites all above `:2265`,
  which is `#[cfg(test)] mod tests`.
- Findings: `dispatch` is a private method on `Inner`, which is a private struct, and
  `lib.rs` does not export it. There is no other production caller in the file and
  none is possible outside it.
- Missing evidence: none.
- Conclusion: resolved with answer. `:1982` is the sole production caller, so
  `validate_inbound` is a total gate.

### Q: Does the `Goodbye` guard at `:1397` leave a gap?

- Sources examined: `:1397-1404`, `validate_inbound`'s `Goodbye` arm at `:2062-2066`.
- Findings: `:1397` matches `Goodbye` with `header.channel == 0` and `:1398` matches
  the rest, so `Goodbye` is fully covered by the two arms and never reaches `:1557`.
  `validate_inbound:2063` additionally rejects a `Goodbye` with a nonzero correlation
  or with a nonzero channel and zero epoch, so the routed arm at `:1398` always has a
  well-formed `(channel, epoch)` to build a `RouteHandle` from.
- Missing evidence: none.
- Conclusion: resolved with answer. No gap. The guarded-arm pattern is safe because
  the unguarded arm immediately follows.
