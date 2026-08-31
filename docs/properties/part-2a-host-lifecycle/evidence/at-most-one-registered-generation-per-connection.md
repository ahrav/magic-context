# at-most-one-registered-generation-per-connection

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD moved to the merge
commit `1c193ae0` and `git diff d90e7811 HEAD` is empty for `connection.rs`,
`dispatch.rs`, `runtime.rs`, and `tests/lifecycle.rs`.

## Discovery trigger

A socket that negotiates a non-TCP transport mints two generation ids on one
`run_connection` stack, and the registry is a flat `HashMap<u64, _>` with no
per-socket grouping. Nothing in the type system says "one live entry per socket" —
the invariant is an emergent consequence of where the bootstrap's removal sits
relative to the promoted generation's insert. Reading those two points in order
shows they are not adjacent: there is a stretch of `run_connection` between them.

## Evidence trail

- `connection.rs:276-289` is the registration block. The insert at `:288`
  (`connections.insert(gen.id, Arc::clone(&gen));`) and the refusal check at
  `:285` are both inside the same critical section opened at `:280`
  (`shared.connections.lock()`), so no observer can see a half-applied
  registration.
- `connection.rs:285` is a two-clause gate:
  `if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled()`.
  The comment at `:281-284` states why the token clause exists: it closes the
  window between a committed `host.shutdown`, which cancels the token, and
  `shutdown_sequence` storing `draining`.
- `runtime.rs:1127-1129` stores `draining = true`, and it is stored **outside**
  the `connections` lock. The snapshot at `runtime.rs:1151-1157` then takes that
  lock. So the mutual exclusion between a late registration and the snapshot is
  the lock at `:1153`, while the ordering that makes refusal correct is the
  `SeqCst` store at `:1129` preceding it.
- Removal: the only site is `dispatch.rs:1386-1390` (`.connections.lock() ...
  .remove(&gen.id)`) at the end of `close_generation`, reached from
  `connection.rs:345`.
- The gap between the two entries is `connection.rs:345` through `:288` of the
  second `serve_generation` call, and it contains real work:
  `setup.handoff.take()` (`:349`), `drop(gen)` (`:350`),
  `writer_finish.finish()` (`:354`), the io-task join at `:361`, the return at
  `:362`, then `run_connection:198-216` (handoff unwrap, promotion slot take,
  second `new_generation`), then the second `serve_generation` entry. Every await
  in that stretch is a yield point at which a drain can land.
- `connection.rs:217-224` — the promoted `serve_generation`'s return value is
  discarded (`.await;`, no binding), so its early `return None` at `:286` is
  indistinguishable at the call site from an ordinary served-to-completion exit.
- Existing check, confirmed: `tests/lifecycle.rs:1722`
  `shutdown_during_candidate_setup_reaps_both_channels`. Its doc comment at
  `:1715-1721` claims the setup's registry membership is removed and the
  connection permit released. It lands the drain during *setup* — before the
  grant commits — not in the transfer window. Its file is named in no CI workflow.

## Failure scenario

The exclusion itself holds; the reachable scenario is the complementary gap the
same structure creates — a window in which *neither* id is registered:

1. A socket negotiates a non-TCP transport and the grant commits, so the
   candidate is prepared and the bootstrap's read loop returns.
2. The bootstrap's `serve_generation` runs `close_generation`
   (`connection.rs:345`), whose `remove(&gen.id)` at `dispatch.rs:1390` deletes
   the only registry entry for this socket.
3. Before the promoted generation reaches `connection.rs:288`, a committed
   `host.shutdown` or a signal drives `shutdown_sequence`. `draining` is stored
   at `runtime.rs:1129`, and the snapshot at `:1151-1157` collects generations
   under the lock. This socket contributes nothing to that vector.
4. The promoted `serve_generation` then reaches `:285`, observes
   `draining == true`, and returns `None` at `:286` without inserting.
5. Consequence: the socket receives no connection Goodbye — the Goodbye loop at
   `runtime.rs:1167-1169` iterates only the snapshot — and it is not reaped by the
   un-promoted arm at `connection.rs:226-234` either, because the code took the
   `Some(receiver)` branch. The peer sees the socket close with no protocol close
   frame. This is the same early return that
   `disconnect-releases-every-resource-keyed-to-the-connection` reasons about from
   the resource side.

## Timing windows and dependencies

Two distinct windows. The *exclusion* window — bootstrap still registered while
the promoted generation is being built — does not exist: the removal at
`dispatch.rs:1390` strictly precedes the second insert on one stack, with no
concurrency between them. The *neither-registered* window is real, spans
`connection.rs:345` to the second `:288`, and includes at least three awaits
(`:345`, `:361`, and the tracked-task joins inside `close_generation`), so it is
wide in wall-clock terms rather than instruction-narrow. Reaching it requires a
committed non-TCP grant, which requires a configured transport provider — on a
default TCP-only deployment `serve_generation` returns no handoff
(`connection.rs:198`) and the second registration never happens, so the window is
provider-gated. Interacts with `no-generation-registers-after-the-drain-snapshot`,
which owns the correctness of the `:285` refusal itself, and with
`generation-registry-entry-released-on-every-connection-exit`, which owns the
single-remover structure this record depends on.

## What a test must construct

A committed non-TCP grant plus a drain landing inside the transfer window (fault
class H1, multi-thread scheduling, unavailable today). Concretely: the
`FakeProvider` harness already used by `tests/lifecycle.rs:1722`, driven to a
*completed* commit rather than an interrupted setup; a scheduling point placed
after `close_generation` returns at `connection.rs:345` and before the second
`serve_generation` reaches `:285`; `host.shutdown` committed while the connection
task is held there; then release. Two oracles, asserted separately. For the
exclusion: instrument `connections.insert` at `:288` and assert it never returns
`Some(_)`, and sample the registry under the lock asserting at most one of the
socket's two ids is present. For the window: assert the peer socket observes
either exactly one connection Goodbye or a close with no Goodbye, and record which
— the current behaviour is the second, and the catalog's open question is whether
that is intended. Coverage checks to emit:
`host_drain_landed_in_generation_transfer_window` and
`host_promoted_registration_refused_by_draining`.

## Investigation log

### Q: Should the promoted generation receive a connection Goodbye when the host drains in the transfer window? Today it gets neither a Goodbye nor a reap.

- Sources examined: `crates/mc-host/src/connection.rs:196-236` (the promote/reap
  branch), `:276-289` (registration), `:345-362` (close and handoff);
  `crates/mc-host/src/runtime.rs:1119-1177` (the whole drain, including the
  Goodbye loop at `:1167-1169` and the token/rendezvous loops at `:1170-1175`);
  `crates/mc-host/src/dispatch.rs:1371-1391` and `:1434-1452`
  (`send_connection_goodbye`); `crates/mc-host/tests/lifecycle.rs:1715-1730`.
- Findings: the behavioural half of the question is settled and matches the
  catalog. `send_connection_goodbye` is called only from `runtime.rs:1168`, over
  the snapshot taken at `:1151-1157`; a generation absent from that snapshot
  cannot receive one. The reap at `connection.rs:229-230` is on the `None` arm
  only, so the `Some(receiver)` path that early-returns runs neither. Confirmed:
  in this window the promoted generation gets neither.
- Missing evidence: whether it *should*. This is a wire-protocol question — does
  §9.4 permit a socket close with no Goodbye when the host is draining, or does
  the drain owe every authenticated connection a Goodbye? The protocol sections
  the code cites (`§6.3`, `§9.4`, `§12`) are named in comments, but the normative
  text is not in this repository's scope files, and nothing in `docs/` that I read
  states the obligation for a connection that is mid-transfer at drain time.
- Conclusion: unresolved, needs human input. The code behaviour is established;
  the requirement it should be measured against is not, and choosing one would be
  inventing the protocol rather than reading it.
