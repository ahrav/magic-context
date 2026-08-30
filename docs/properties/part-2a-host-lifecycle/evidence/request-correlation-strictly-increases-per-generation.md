# request-correlation-strictly-increases-per-generation

## Discovery trigger

The rule is enforced in two places and asserted in neither. `connection.rs` tests the watermark
twice — once on the rejected-frame path at `:426-429` and once on the accepted-request path at
`:469-472` — but the structure that actually depends on the rule, the pending map, is written by
`dispatch.rs:893` with `HashMap::insert`, whose returned `Option<PendingEntry>` is discarded. The
guarantee that a pending key is unique therefore lives one function away from the code that would
break if it were not, with no local evidence at the insert that the key was free.

## Evidence trail

`crates/mc-host/src/connection.rs:391` seeds the counter: `let mut watermark: u64 =
setup.initial_watermark;`, with the comment at `:388-390` naming the rule — "any non-increasing
Request closes the generation before dispatch (protocol §8.3, V44)". Two guards read it:

- Accepted requests, `:469-472`: `if header.corr <= watermark { return ReadExit::Peer; }` then
  `watermark = header.corr;`. This precedes the channel-0 split at `:473`, so it covers control and
  routed requests alike — the catalog's claim on that point is verified.
- Rejected frames, `:426-429`: the same `corr <= watermark` test and the same advance, on the
  `InboundEvent::Rejected` arm. The comment at `:421-422` states the ordering intent: "The watermark
  still applies first."

The dependent structure is `pending: Mutex<HashMap<PendingKey, PendingEntry>>`
(`connection.rs:114`), keyed by `pub type PendingKey = (u16, u32, u64)` (`connection.rs:46`) — the
channel, epoch, and correlation triple. `crates/mc-host/src/dispatch.rs:892-899` builds the key and
inserts:

```
let key: PendingKey = (route.channel, route.epoch, corr);
gen.pending.lock().expect("pending lock").insert(
    key,
    PendingEntry { cancel: cancel.clone(), settlement: Arc::clone(&settlement) },
);
```

The return value is dropped. Nothing at that site distinguishes a fresh key from a collision.

`docs/mc-host-wire-protocol.md:750` is the contract, and it states the reason the host cannot rely
on the sender: "Sender-side no-reuse alone cannot stop a buggy client: a reused correlation on a
different route keys a distinct pending entry and would dispatch a mutating handler operation
twice. The host therefore enforces the monotonic allocation rule on ingress with a per-generation
watermark." The same line exempts the other frame types: "`Cancel`, `Pong`, and `Goodbye` reference
existing identities and are exempt."

## Failure scenario

A weakened or removed watermark does not fail loudly. A second request reusing a live correlation on
the same route overwrites the pending entry at `dispatch.rs:893`; the displaced `PendingEntry` is
dropped, so its `CancellationToken` and `Settlement` become unreachable while the first request's
handler still runs. The first terminal to arrive settles against the surviving entry and
`remove_pending` (`dispatch.rs:1074-1075`) clears it, so the second terminal finds nothing and is
dropped. A `Cancel` for that correlation reaches whichever entry currently occupies the key, not
necessarily the request the client meant to cancel.

## Timing windows and dependencies

No concurrency window on the ingress half: the watermark is a local `u64` on the read task's stack
(`:391`), read and advanced only by that one task, so there is no interleaving to construct. The
insert is reached from the same reader path. The exposure is therefore entirely a code-structure
exposure — the invariant is upheld by two guards in a different file from the one that consumes it —
rather than a race. It depends on `setup.initial_watermark`, which is `0` for an ordinary connection
(`:805`) and `COMMIT_CORRELATION` for a promoted candidate (`:815`); see
`promoted-generation-refuses-the-setup-correlations` for that seed.

## What a test must construct

The first clause is covered: `tests/dispatch.rs:211`
`a_non_increasing_correlation_closes_the_generation_before_dispatch` loops over `["repeat",
"lower"]` (`:212`), so both shapes of violation are driven. That test is in `tests/dispatch.rs`.

The second clause has no test. It needs an assertion at the insert itself — that the returned
`Option` is `None` — because no black-box client behaviour can distinguish "the watermark rejected
the reuse" from "the watermark let it through and the insert overwrote silently". A mutation that
weakens only the `<=` to `<` at `:469` while leaving `dispatch.rs:893` alone is the discriminating
fault, and it would survive the existing test only if the test's "repeat" case did not cover it — it
does, so the watermark half is mutation-covered and the insert half is not.

## Investigation log

### Q: Does the watermark check precede the channel-0 control split, so control requests are covered too?

- Sources examined: `crates/mc-host/src/connection.rs:465-480` read directly at HEAD.
- Findings: `:469-471` returns `ReadExit::Peer` on `header.corr <= watermark`, `:472` advances, and
  the split `if header.channel == 0` is at `:473`. Both control and routed requests pass the guard
  before any dispatch.
- Missing evidence: none.
- Conclusion: resolved with answer. Confirmed as the catalog states.

### Q: Does the pending insert discard its return value, or is there a check elsewhere in the same function?

- Sources examined: `crates/mc-host/src/dispatch.rs:885-902`; `grep -rn "pending.lock"` across
  `crates/mc-host/src/`.
- Findings: `:893` is a bare `.insert(...)` statement; the value is discarded. The other five
  `pending.lock()` sites are `:1075` (`remove`), `:1309-1312` (key snapshot), `:1353`, and `:1457`
  (`handle_cancel`) — all reads or removals, none of which would observe a collision either. No
  assertion, `debug_assert`, or counter anywhere records that the key was free.
- Missing evidence: none.
- Conclusion: resolved with answer. The insert is unguarded, and correctness rests entirely on the
  two watermark guards in `connection.rs`.
