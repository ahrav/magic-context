# setup-a-a-stalled-setup-is-torn-down-within-the-transport-setup-deadline

## Discovery trigger

The part's first revision rejected this candidate in its relationship map, on the
argument that a bound expressed as a wall-clock duration (`config.rs:227`) is not
one of the units METHOD.md admits. The portfolio evaluation reopened it: METHOD.md
says "State the bound in the units the code actually bounds: attempts, deadlines,
or an explicit interval", so a deadline is the second admissible unit, named
expressly. What the rule forbids is an unbounded "eventually" and a generous
timeout that cannot distinguish one recovery pass from a thousand. This bound is
neither. The record was added by that disposition, which was scoped to
`catalog.md`, `fault-map.md`, and `portfolio-evaluation.md` and forbidden from
writing under `evidence/`, so this file lands after the record rather than with it.

The substantive question behind the candidate is narrower than "is setup bounded".
It is whether the bound is a *single* bound or a per-message one, because those two
constructions differ by an unbounded factor against a peer that dribbles bytes.

## Evidence trail

All references at commit `e447c927`.

`crates/mc-host/src/setup_socket.rs`, `activate_server`:

- `:246-248` computes `deadline = Instant::now().checked_add(timeout)` **once**,
  mapping arithmetic overflow to `SetupError::Timeout`. This is the anchor: one
  absolute `Instant`, taken before any post-grant I/O.
- `:249-260` passes that same `deadline` to `send_grant`.
- `:261` the `Activate` read: `read_message(stream, deadline)`.
- `:273` the `Activated` write: `write_message(stream, &ServerMessage::Activated,
  deadline)`.
- `:281` the `Commit` read: `read_message(stream, deadline)`.
- `:282` the `Committed` write: `write_message(stream, &ServerMessage::Committed,
  deadline)`.

No call site recomputes `Instant::now()`, and no call site adds to `deadline`. The
same value reaches all four message positions plus the grant send.

`read_message` (`:369-386`) enforces it on **both** of its reads, not just the
first: `timeout_at(deadline, stream.read_exact(&mut len))` at `:374-376` for the
four length bytes, and `timeout_at(deadline, stream.read_exact(&mut body))` at
`:382-384` for the body, each mapping expiry to `SetupError::Timeout`. So a peer
that sends three of four length bytes and stops is refused at the same wall-clock
instant as a peer that sends nothing at all. `send_grant` is enforced the same way,
wrapping `stream.writable()` in `timeout_at(deadline, ..)` at `:142-144` inside its
send loop.

The value and the teardown, in `crates/mc-host/src/connection.rs`:

- `:170-179` calls `activate_server` on every authenticated connection, passing
  `shared.timing.transport_setup_deadline` at `:177`. There is no opt-in and no
  alternative branch.
- `:180-185`: `activate_server` returning `Err` runs `sender.discard()` and
  `root.cancel()` and returns, which drops the permits and releases the ring charge
  through the mechanism recorded in
  `setup-a-an-abandoned-setup-strands-no-ring-charge`.
- `crates/mc-host/src/config.rs:227` ships `transport_setup_deadline: Duration::
  from_secs(2)` in `HostTiming::default`.

## Failure scenario

A peer authenticates, calls `receive_grant`, takes the descriptors, and then stops.
The host is holding a prepared ring, a handshake permit, and a connection permit
for that peer.

If the deadline were per-message rather than absolute, the peer would hold all
three indefinitely at a cost of one byte per interval: each byte restarts the
window. Sixty-four such peers, the `max_connections` default, would hold
sixty-four prepared rings for as long as they cared to keep dribbling. The
regression that produces this is small and plausible: recomputing `Instant::now()
+ timeout` inside `read_message`, or per call site, instead of threading the
anchored `Instant` down. Nothing in the current code asserts against it, and the
resulting code would still look correct at every individual call site.

## Timing windows and dependencies

The window opens at `setup_socket.rs:246-248` and closes when any of the five I/O
points expires. Because the anchor is absolute, the window's length does not depend
on how the peer distributes its silence across the exchange, which is the whole
content of the property.

The window is fault-free once the peer stops: no injected fault, no scheduling
race, and no timer-versus-task interleaving is needed. The peer's silence alone
makes the deadline fire. That distinguishes this exit from the `prepare`-timeout
exit at `connection.rs:157-164`, which races `timeout_at` against a
`spawn_blocking` task; see the investigation log.

Dependency: the release half of the guarantee, that permits and the ring charge
come back, rests on `setup-a-an-abandoned-setup-strands-no-ring-charge`. This
record owns the *bound*; that record owns the *release*.

## What a test must construct

The peer already exists. `crates/mc-host/tests/shm_failure_modes.rs:44-58` is the
`setup` role: it reads the connection file, authenticates, calls `receive_grant`,
announces `READY setup`, and then parks on `std::future::pending::<()>().await`
forever. It runs against a real host in CI, at `.github/workflows/ci.yml:133`.
Only the timing assertion is new.

1. Shorten `config.timing.transport_setup_deadline` through the `TestHost::
   start_with` closure so the window is cheap to observe.
2. Drive the `setup` role to its `READY setup` announcement, then **stop all peer
   activity**. That is what makes the window fault-free.
3. Poll until the host has released the connection, and assert the elapsed time is
   within one `transport_setup_deadline` measured from the anchor.

The per-message regression needs its own case, because step 2 does not catch it: a
peer that sends one length byte per shortened-deadline interval and never
completes a message. Under the current single-anchor construction it is refused at
the same instant as a silent peer; under a per-message construction it is not.

`tests/shm_failure_modes.rs:232-245`
(`setup_active_and_idle_sigkill_each_return_exact_capacity`) is not this test. It
asserts capacity returns after a peer is killed, which is a different exit and
carries no timing claim.

## Investigation log

### Q: Is the bound a single absolute deadline or a per-message one?

- Sources examined: `setup_socket.rs:246-248`, `:249-260`, `:261`, `:273`, `:281`,
  `:282`, and `read_message` at `:369-386`.
- Findings: single and absolute. One `Instant` is computed at `:246-248` and passed
  by value to every subsequent I/O point; both `read_exact` calls inside
  `read_message` are wrapped in `timeout_at` against it. There is no accumulation
  across messages and no per-read restart.
- Missing evidence: none for `activate_server`. The client-side `activate_client`
  (`:288`) was not traced; this record is about the host.
- Conclusion: resolved. The property is a regression property over a construction
  that already holds, which is why `Exercised:` is `not yet` rather than partial.

### Q: Does shortening `transport_setup_deadline` make the test cheap, or racy?

- Sources examined: `connection.rs:145-164`, `:170-185`, the `start_with`
  precedent at `tests/lifecycle.rs:165`, and the sibling record
  `setup-a-an-abandoned-setup-strands-no-ring-charge`.
- Findings: safe for *this* exit, and it must not be assumed safe for the other
  one. The exit this record measures is `activate_server` returning
  `SetupError::Timeout` at `:180`, which fires on the peer's silence. The
  `prepare`-timeout exit at `:157-164` is different: a sibling pass established
  that **a near-zero deadline does not deterministically force it**, because
  `timeout_at(Instant::now() + deadline, prepared)` races the timer against a
  `spawn_blocking` task that may already have completed, so a fast `prepare` wins,
  the connection proceeds normally, and the test would pass having exercised the
  wrong path while flaking in both directions. Reaching that exit deterministically
  needs injected slowness inside `prepare`, which has no seam, or a barrier holding
  the blocking task.
- Missing evidence: how short is too short. Both exits read the same
  `transport_setup_deadline` field (`:158` and `:177`), so a value low enough to
  race `ring.prepare` would start diverting connections into the `:163-164` return
  before they ever reach `activate_server`, and this record's assertion would stop
  observing its own exit. The crossing point is a function of `prepare` cost on the
  target machine and was not measured.
- Conclusion: unresolved, needs a measured floor for the shortened deadline. Not
  resolved here, and deliberately not resolved by picking a number: the sibling
  pass's non-determinism finding is preserved as stated rather than argued away.

### Q: Should the post-grant exchange have a tighter deadline than the pre-grant?

- Sources examined: `config.rs:227`, `connection.rs:158` and `:177`, and
  `setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released`.
- Findings: both halves currently share one `transport_setup_deadline`, but only
  the post-grant half holds a prepared ring, and that half is charged to
  `max_connections` (64) rather than to `max_handshakes` (32). So the exposure the
  shared value buys is 64 concurrent prepared rings for up to 2 seconds.
- Missing evidence: none technical. This is a budget question, not a code question.
- Conclusion: needs human input. Carried as the record's open question.
