# pong-preanswer-rejected-in-every-mutex-order

## Discovery trigger

`PingProbe`'s doc comment makes an unconditional promise, and one of the two arms that implement it
does not test the thing the promise names. `connection.rs:57-58`:

```
/// Acceptance is decided by comparing WHEN the Pong was observed against WHEN
/// the Ping's write COMPLETED — never by which side won the `pings` mutex.
```

and `:65-67`:

```
/// * a Pong observed before `completed_at` is a pre-answer for a Ping whose
///   bytes did not yet exist, so it is discarded and the probe still demands
///   a real answer.
```

The hook's arm implements exactly that: `:1434` tests `answered_at >= completed_at`. The read loop's
arm does not. It tests only a deadline. So the promise holds in one mutex order and is unenforced in
the other — which is precisely the case the comment says the design does not depend on.

## Evidence trail

Four links, each re-verified at HEAD `1c193ae0`. `git diff d90e7811 HEAD` is empty, so every line
number the catalog recorded at `d90e7811` still resolves.

**1. `now` is sampled before the lock.** `crates/mc-host/src/connection.rs:504-506`:

```
504:                        let now = Instant::now();
505:                        let mut pings = gen.pings.lock().expect("pings lock");
506:                        match pings.get_mut(&header.corr) {
```

**2. The completion-recorded arm tests only the deadline.** `:512-526`. The arm is selected by
`Some(_)` at `:518` — the bound value is discarded, so `written_at`'s instant is never compared
against anything:

```
518:                                    Some(_) => {
519:                                        let in_deadline =
520:                                            shared.liveness.as_ref().is_none_or(|p| {
521:                                                now.duration_since(probe.sent) < p.pong_deadline
522:                                            });
523:                                        if in_deadline {
524:                                            pings.remove(&header.corr);
525:                                        }
526:                                    }
```

The catalog cites `:519-521` for the test; the statement spans `:519-522` and the comparison itself
is on `:521`. Correcting the range, not the claim.

**3. The hook overwrites `sent` with the completion instant.** `:1426-1449`. In the `_` arm at
`:1441-1445`:

```
1441:                    _ => {
1442:                        probe.answered_at = None;
1443:                        probe.sent = completed_at;
1444:                        probe.written_at = Some(completed_at);
1445:                    }
```

So after the hook runs, `probe.sent` and `probe.written_at` both hold `completed_at`, and `:521`
compares `now` against `completed_at`.

**4. `duration_since` saturates.** `connection.rs:15` is `use tokio::time::{timeout_at, Instant};`
— so every `Instant` in this file, including `now` at `:504` and `PingProbe::sent` at `:77`, is
`tokio::time::Instant`, not `std::time::Instant`. The pinned version is **tokio 1.53.1**
(`Cargo.lock`, `name = "tokio"` / `version = "1.53.1"`). In
`tokio-1.53.1/src/time/instant.rs:70-74`:

```
70:    /// Returns the amount of time elapsed from another instant to this one, or
71:    /// zero duration if that instant is later than this one.
72:    pub fn duration_since(&self, earlier: Instant) -> Duration {
73:        self.std.saturating_duration_since(earlier.std)
74:    }
```

tokio's `duration_since` is not std's; it delegates to `saturating_duration_since` unconditionally.
That makes the saturation independent of the Rust version — `std::time::Instant::duration_since` also
saturates in current Rust, but the argument here does not rest on it. With `completed_at > now`,
`:521` evaluates `0ns < pong_deadline`, which is true, and `:524` removes the probe.

**Where `completed_at` comes from.** `crates/mc-host/src/tcp_frame_channel.rs:366-378` captures it
inside the select arm at `:376`, `Some((result, Instant::now()))`, immediately after `write_all`
returns; the comment at `:362-365` states that intent. The hook is invoked at `:393-394`, after the
completion store at `:389-392`.

## Failure scenario

A peer that never reads its socket keeps a generation alive by answering probes it never received.
Correlations are sequential — `connection.rs:1399` `gen.next_ping_corr.fetch_add(1, Ordering::SeqCst)`
seeded at 1 (`:255`) — so the peer predicts the next correlation and emits its Pong early. The
losing interleaving:

1. `liveness_loop` inserts the probe with `written_at: None` (`:1403-1411`), then queues the frame
   (`:1450-1456`).
2. The peer's pre-answer Pong arrives. The read loop samples `now` at `:504` — call it `t0`.
3. The read loop is descheduled between `:504` and `:505`.
4. The writer finishes `write_all` and captures `completed_at = t1 > t0` (`tcp_frame_channel.rs:376`),
   then calls the hook (`:394`), which takes the pings lock (`:1427`). `answered_at` is still `None`,
   so the `_` arm runs: `sent = t1`, `written_at = Some(t1)`.
5. The read loop acquires the lock, takes the `Some(_)` arm at `:518`, computes
   `t0.duration_since(t1)` = `0ns`, and removes the probe at `:524`.

The probe is gone. The expiry sweep at `:1370-1375` finds nothing outstanding, so
`invalidate_on_missed` never fires. This defeats exactly the detection the design exists to provide,
and the guard that would catch it — `answered_at >= completed_at` — exists only in the hook's branch.

## Timing windows and dependencies

**The window is the two-instruction gap between `:504` and `:505`.** It is not an await point:
`connection.rs:10` imports `std::sync::Mutex`, and there is no `.await` anywhere between `:504` and
the end of the Pong arm at `:540`, so the guard cannot be held across a suspension and the read loop
cannot yield inside the window. Delay there must come from OS thread preemption.

**The lock is blocking, which widens the loss.** Because it is a `std::sync::Mutex`, a read loop that
reaches `:505` while the hook holds the lock parks the worker thread until the hook releases, then
proceeds with its already-stale `now`. So the interleaving does not require a preemption long enough
for the whole writer path — only long enough for the writer to travel `:376` → `:394` → `:1427` and
take an uncontended lock.

**The two parties are genuinely concurrent.** The hook runs in the writer task
(`tcp_frame_channel.rs:394`, per the comment at `connection.rs:1420-1423`), the Pong arm runs in the
read task, and the daemon runtime is `tokio::runtime::Builder::new_multi_thread().worker_threads(2)`
(`crates/mc-module/src/bin/ck-mc-host.rs:437-438`). Two workers is enough for the read task and the
writer task to run on separate threads simultaneously. On a current-thread runtime the interleaving
would be unreachable, because with no await in the window the writer could not interleave at all.

**One dependency substantially narrows practical reachability.** The whole probe path is gated on a
configured liveness policy: `connection.rs:291` `if let Some(policy) = shared.liveness.clone()`
guards the spawn at `:296`, and the default is `liveness: None` (`config.rs:296`). The only
`liveness: Some(..)` in `crates/mc-host/src/` is `config.rs:664`, inside the `#[cfg(test)]` module
that begins at `:469`. Nothing in `crates/mc-module/` configures it. So no shipped configuration in
this tree runs the liveness loop; the defect is live for an embedder that opts in, and dormant in the
daemon as built. That is a departure from the catalog's Part 2a framing that "every record here is
reachable in a shipped configuration unless marked otherwise", and this record needs that marking.

## What a test must construct

Not a client-visible scenario — the outcome is a probe silently removed, which no wire observation
distinguishes from a legitimate answer. The test has to reach inside.

A direct unit test on the two arms is enough and needs no scheduler race: build a `GenerationCore`,
insert a probe with `written_at: None`, run the hook's closure body with a `completed_at` in the
future relative to a captured `now`, then run the read loop's arm logic with that `now` and assert
the probe survives. The four in-file test constructors at `connection.rs:1524-1525` and `:1629-1630`
already build `pings` maps, so the fixture exists.

To drive it through the real tasks, the discriminating fault is a controlled delay between `:504` and
`:505` plus a peer that emits a Pong for correlation `n` before the host writes it. `tokio::time::pause`
makes `completed_at > now` constructible without racing wall time, since `tokio::time::Instant::now`
routes through the mock clock (`instant.rs:48-50`, `variant::now()`), but the blocking mutex in the
window means the ordering still has to be forced rather than merely made likely.

No test covers this. `tests/lifecycle.rs:400`
`ping_and_consumer_correlations_do_not_cross_settle` sends an *unmatched* Pong with correlation
`999_999` (`:465-468`), which falls to the `_ => {}` arm at `:538` and never reaches either branch of
`written_at`.

## Investigation log

### Q: Which `Instant` type is at `connection.rs:504`, and does the saturation argument survive it?

- Sources examined: `crates/mc-host/src/connection.rs:1-20`; `grep -n "Instant"` across that file;
  `Cargo.lock`; `tokio-1.53.1/src/time/instant.rs`.
- Findings: `connection.rs:15` imports `tokio::time::Instant`; no `std::time::Instant` import exists
  in the file, and `PingProbe`'s three fields at `:77-79` are the same type. tokio 1.53.1's
  `duration_since` (`instant.rs:72-73`) calls `self.std.saturating_duration_since(earlier.std)`, and
  its own doc comment at `:70-71` promises "zero duration if that instant is later than this one".
- Missing evidence: none.
- Conclusion: resolved with answer. `tokio::time::Instant` applies, and the saturation is explicit in
  tokio rather than inherited from std, so the link does not depend on the Rust version.

### Q: Is the pings lock ever held across an await, and can the hook and the read loop genuinely contend?

- Sources examined: all six `pings.lock()` sites (`connection.rs:505`, `:1357`, `:1371`, `:1381`,
  `:1403`, `:1427`); `connection.rs:500-540` and `:1345-1478`; `tcp_frame_channel.rs:340-399`;
  `crates/mc-module/src/bin/ck-mc-host.rs:437-438`.
- Findings: no site holds the guard across an await. The four liveness-loop sites are explicitly
  block-scoped (`:1356-1364`, `:1370-1375`, `:1380-1392`) or statement-temporaries (`:1403-1411`),
  and the `select!` awaits at `:1365-1368`, `:1457-1461`, and `:1468-1476` all sit outside those
  scopes. The read-loop guard at `:505` drops at `:540` with no await between. The hook runs in the
  writer task; the runtime has two workers.
- Missing evidence: none.
- Conclusion: resolved with answer. Contention is real, and because the mutex is `std::sync::Mutex`
  the contended read loop blocks and then proceeds with a stale `now` rather than re-sampling.

### Q: Is the absence of the guard on the read-loop side an oversight, or does the design comment cover it?

- Sources examined: `crates/mc-host/src/connection.rs:56-74` (the full `PingProbe` rationale);
  `:512-526`; `:1429-1446`.
- Findings: the comment's residual-case paragraph at `:71-74` excuses only "a peer that received the
  bytes but answers without reading them". The pre-answer case is addressed separately and
  unconditionally at `:65-67`, and `:57-58` explicitly disclaims dependence on the mutex order. The
  read-loop arm's own comment at `:513-517` says "`sent` is the completion instant, so the deadline
  applies here" — true, but it treats the deadline as the whole test, which is the gap.
- Missing evidence: whether this was intended. That is author intent, not a fact in the tree.
- Conclusion: unresolved — needs human input. The code and the comment disagree; which one is wrong
  is not decidable from the source.
