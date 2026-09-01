# ping-and-consumer-correlations-cannot-cross-settle

## Discovery trigger

Two correlation namespaces share one connection and one `u64` space. The wire protocol explicitly
permits them to collide numerically, so the only question is whether the host's lookup structures
keep them apart. They do, and the mechanism is worth recording precisely because it is structural
rather than a comparison: there is no test anywhere that a correlation belongs to the right
namespace, because no such test is needed — the two namespaces are two different maps with two
different key types.

## Evidence trail

`crates/mc-host/src/connection.rs` declares both maps on `GenerationCore`, two lines apart:

- `:114` `pub pending: Mutex<HashMap<PendingKey, PendingEntry>>,`
- `:116` `pub pings: Mutex<HashMap<u64, PingProbe>>,`

`PendingKey` is `(u16, u32, u64)` (`:46`) — channel, epoch, correlation. The pings map is keyed by a
bare `u64`. The key types are not merely different values; they are different types, so a lookup in
one cannot be spelled against the other.

Pong handling reads only the pings map. `connection.rs:500-506`:

```
FrameType::Pong => {
    if header.channel != 0 || header.corr == 0 {
        return ReadExit::Peer;
    }
    let now = Instant::now();
    let mut pings = gen.pings.lock().expect("pings lock");
    match pings.get_mut(&header.corr) {
```

The only mutations in that arm are `pings.remove(&header.corr)` (`:524`) and `probe.answered_at =
Some(now)` (`:535`). The `pending` map is never named.

Consumer terminals read only the pending map, always by the full triple: `dispatch.rs:892-899`
inserts under `(route.channel, route.epoch, corr)`, `dispatch.rs:1074-1075` `remove_pending` removes
by `PendingKey`, and `dispatch.rs:1456-1457` `handle_cancel` locks `pending` and looks up by
`PendingKey`. No terminal path touches `pings`.

The pings map is written from three sites, all in the liveness path: the probe insert at
`connection.rs:1403-1411`, the expiry sweep at `:1370-1392`, and the write-completion hook at
`:1427-1447`. `grep -rn "pings.lock"` over `crates/mc-host/src/` returns exactly six sites —
`connection.rs:505`, `:1357`, `:1371`, `:1381`, `:1403`, `:1427` — and none of them is in
`dispatch.rs`.

`docs/mc-host-wire-protocol.md:748` states the contract this satisfies: "The two directions are
independent namespaces: a host `Ping` correlation MAY be numerically equal to a pending consumer
correlation on the same connection, and neither affects the other. Matching is direction-scoped by
frame type — `Response`, `Error`, `StreamData`, and `StreamEnd` settle only consumer-originated
requests; `Pong` settles only host-originated `Ping`."

## Failure scenario

A cross-settle would require one of two structural changes: unifying the two maps under a shared
key, or adding a `pending` lookup to the Pong arm. Under either, a client that observes or guesses a
live ping correlation and sends a request with the numerically equal correlation could have its own
terminal clear the liveness probe. The probe would be removed without the peer ever answering, the
expiry sweep at `:1370-1375` would find nothing outstanding, and read-liveness detection would
report a healthy peer. A client that stops draining its socket entirely could keep a generation
alive indefinitely by settling its own requests.

The reverse direction is equally blocked: a Pong cannot clear a pending request, so a peer cannot
cancel its own in-flight work by answering a probe.

## Timing windows and dependencies

None. The separation does not depend on ordering, on which task runs first, or on either mutex. The
two maps have independent `Mutex` guards, so the paths do not even contend. Two additional
independent filters narrow the Pong arm further: `:501` rejects any Pong with a nonzero channel or a
zero correlation, and `:511` requires `probe.flags == header.flags.0` before the probe is considered
at all.

This record depends on the ping namespace existing, which requires a configured liveness policy:
`connection.rs:291` gates the liveness task on `if let Some(policy) = shared.liveness.clone()`, and
the default is `liveness: None` (`config.rs:296`).

## What a test must construct

A consumer correlation numerically equal to a live ping correlation, driven while the probe is
outstanding, with an assertion that the probe survives the consumer terminal.

The existing test is `tests/lifecycle.rs:400`
`ping_and_consumer_correlations_do_not_cross_settle`. It configures liveness explicitly at
`:401-408` with `ping_interval: 50ms` and `pong_deadline: 30s`, so a probe is live and cannot expire
during the test. Note the catalog cites `tests/lifecycle.rs:468` for this test; `:468` is a line
inside the body — the `.expect("unmatched pong")` on a Pong sent with correlation `999_999`
(`:465-468`) — and the function itself begins at `:400`. That file runs in no CI workflow.

Because the separation is structural, the test that would actually protect it is a source- or
review-level assertion: the Pong arm names only `pings`, and no terminal path names `pings`. A
behavioural test passes for the right reason today but would keep passing under a refactor that
merged the maps if the merged key still happened to disambiguate.

## Investigation log

### Q: Does any terminal or cancel path touch the pings map, or any Pong path touch the pending map?

- Sources examined: `grep -rn "pings.lock\|\.pings\b"` and `grep -rn "pending.lock\|PendingKey"`
  across `crates/mc-host/src/`; `crates/mc-host/src/connection.rs:500-540`;
  `crates/mc-host/src/dispatch.rs:892-899`, `:1074-1075`, `:1456-1457`.
- Findings: six `pings.lock()` sites, all in `connection.rs`, all in the Pong arm or the liveness
  loop. The `pending` sites are all in `dispatch.rs` plus the declaration and constructors. No file
  contains both a `pings` and a `pending` access in the same function.
- Missing evidence: none.
- Conclusion: resolved with answer. The two namespaces are disjoint at the type level, not by
  comparison.

### Q: Can a numerically equal correlation reach the Pong arm at all, given the channel and flags filters?

- Sources examined: `crates/mc-host/src/connection.rs:500-511`.
- Findings: it can. `:501` requires `header.channel == 0`, which a Pong satisfies by construction,
  and `:511` requires the echoed flags to match the probe's. Neither filter inspects the
  correlation's provenance, so a numerically equal correlation does reach `pings.get_mut` at `:506`
  — it simply looks up a different map than a request would.
- Missing evidence: none.
- Conclusion: resolved with answer. The filters are not what provides the separation; the map
  boundary is.
