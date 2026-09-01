# setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released

## Discovery trigger

`docs/mc-host-wire-protocol.md:161` states three MUSTs about unauthenticated
handshake slots. Unbounded caller-driven growth and missing releases recur across
every part of this catalog, so the MUSTs are worth checking against the code rather
than credited to the doc.

## Evidence trail

All references at commit `e447c927`.

The bound is created at `crates/mc-host/src/runtime.rs:913`:

```
handshake_permits: Arc::new(Semaphore::new(config.limits.max_handshakes)),
```

with the authenticated class beside it at `:914`,
`connection_permits: Arc::new(Semaphore::new(config.limits.max_connections))`.
Both fields are declared at `:122-123`. Defaults are `max_handshakes: 32` and
`max_connections: 64` (`config.rs:128-129`), and `config.rs:149-150` includes both
in whatever validation table that function builds.

Enforcement, `runtime.rs:1017-1046`:

```
1035:        // Bounded unauthenticated work: no permit means close without reading
1036:        // a single client byte (protocol §5.1, V11).
1037:        let Ok(permit) = shared.handshake_permits.clone().try_acquire_owned() else {
1038:            drop(stream);
1039:            continue;
1040:        };
```

`try_acquire_owned` and not `acquire_owned`, so the loop never parks on the
semaphore and keeps accepting. `drop(stream)` closes without a read. The permit is
moved into `run_connection` at `:1042-1044`.

Release, `crates/mc-host/src/connection.rs`:

- `:115-119` takes `handshake_permit: OwnedSemaphorePermit` by value, so every
  return releases it.
- `:130-133`: authentication error, return, permit dropped.
- `:137-139`: `connection_permits.try_acquire_owned()` failed, return, permit
  dropped.
- `:140`: `drop(handshake_permit)` explicitly, immediately after the connection
  permit is held.
- `:141`: `let _connection_permit = connection_permit;` binds the authenticated
  permit for the rest of the body.

So there are exactly two pre-swap exits and both release. Beyond `:140` the
handshake permit no longer exists.

The comment at `:134-136` names the ordering intent: "Authentication promotion
linearizes here: authenticated capacity is acquired before the generation becomes
visible anywhere, and only then is the handshake slot released."

Failed-handshake teardown is also bounded. `auth.rs:214-230` wraps
`authenticate_server_inner` and, on error, calls `teardown_failed_handshake`
(`:207-212`), which shuts the stream down under `deadline.remaining_or_zero()`
(`:193-195`). The doc comment at `:198-206` states why: the slot must be released
promptly rather than waiting out another full budget.

## Failure scenario

Two shapes.

Missing release. If `run_connection` took the permit by reference, or leaked it
into a detached task, a peer that connects and stalls would consume slots
permanently. After 32 such connections the host accepts and immediately closes
every subsequent socket, including legitimate ones, and the only recovery is a
restart. `lifecycle.rs:237` is the test that would catch it, and it does assert
the slot becomes available again (`:273`).

Class crossing. The permit swap at `:137-141` acquires the connection permit before
releasing the handshake permit. That is deliberate and correct for admission
linearization, but it has a consequence the doc does not discuss: everything after
`:140` is charged to `max_connections`, including `ring.prepare` and the whole of
`activate_server`. So the post-authentication setup phase, bounded in time by
`transport_setup_deadline` at 2 seconds (`config.rs:227`), is bounded in
concurrency by 64 rather than by 32. Each of those 64 holds a prepared ring, and
`docs/mc-host-shm-transport.md:77` puts one connection's profile at 16
descriptors, 128 MiB of arena, 16 receive leases, two mappings, two mapping file
descriptors and one endpoint worker. Sixty-four concurrently stalled setups is
therefore a large committed footprint held by authenticated but not-yet-activated
peers.

## Timing windows and dependencies

The interesting interval is `connection.rs:137` to `:140`, during which one peer
holds a permit in both classes. It is three statements wide with no blocking call,
so it is not adversary-extendable.

The exploitable interval is `:141` to `:186`, from acquiring the connection permit
to `drop(descriptors)`, bounded by `transport_setup_deadline`. A peer that
authenticates and then stalls holds a connection permit and a prepared ring for
that long. With `max_connections = 64` and a 2-second deadline, an attacker
holding the key can keep the authenticated class saturated indefinitely by
reconnecting. That is in-contract, since it already holds the key, but it is worth
recording as the shape of the residual.

Depends on `runtime.rs:1042-1044` remaining the only spawn site, and on the accept
loop's shutdown branch at `:1019-1023` returning rather than continuing, so
shutdown does not race the bound.

## What a test must construct

Bound and release, following the existing pattern:

1. `max_handshakes = 1`. Hold the slot with a socket that never speaks
   (`tests/support/raw_client.rs:878` `connect_unauthenticated`).
2. Connect a second socket, assert it closes with zero bytes read.
3. Drop the squatter, assert a third connection now proceeds to
   `ServerProof`.

Per-exit release, which the existing tests do not enumerate:

4. a peer that sends a wrong `ClientAuth`, exiting at `connection.rs:130-133`;
5. a peer that authenticates successfully while `max_connections` is already
   saturated, exiting at `:137-139`. This one needs `max_connections` smaller than
   `max_handshakes`, which is the inverse of the default relationship and must be
   configured deliberately.

For each, assert the handshake slot count returns to its initial value, observed
through `Semaphore::available_permits` or by successfully filling the class again.

Class-crossing observation, which is a `sometimes` obligation rather than a
pass or fail: instrument `:137` and `:140` and record whether any peer was ever
counted in both classes at once. That is covered by
`setup-a-concurrent-setup-saturation-is-reached`.

## Investigation log

### Q: Are there exits from `run_connection` before `:140` other than the two named?

- Sources examined: `connection.rs:115-141`.
- Findings: no. The body between `:120` and `:140` contains one `await` on
  `authenticate_server`, one `is_err()` test, one `try_acquire_owned`, and the
  explicit drop. No `?`, no panic-prone call. A panic inside
  `authenticate_server` would unwind and still run the permit's destructor, and
  `panic_boundary.rs` is Part 2a's file for that argument.
- Missing evidence: none.
- Conclusion: resolved. Two exits, both releasing, plus unwind safety by
  destructor.

### Q: Does the doc's third MUST, release on every outcome, hold for the success path?

- Sources examined: `mc-host-wire-protocol.md:161`, `connection.rs:140`.
- Findings: yes, and earlier than the doc requires. The doc says every success,
  parse failure, proof failure, timeout, EOF or shutdown must release its slot. The
  code releases on success at `:140`, immediately after promotion, rather than at
  the end of the connection. Failures release by destructor at their return.
- Missing evidence: none.
- Conclusion: resolved. The code satisfies the MUST.

### Q: Should the post-auth setup phase have its own bound?

- Sources examined: `connection.rs:137-186`, `config.rs:128-129`, `:223`, `:227`,
  `docs/mc-host-shm-transport.md:77`.
- Findings: it currently shares `max_connections`. A third class, or a smaller
  cap on connections that have not yet activated, would bound the committed-ring
  footprint independently of the steady-state connection count.
- Missing evidence: no design note on whether the shared bound was considered
  sufficient.
- Conclusion: needs human input. Recorded as the record's open question.
