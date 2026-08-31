# setup-a-concurrent-setup-saturation-is-reached

## Discovery trigger

Three records in this lens are about what happens when setups overlap: the
handshake bound, the activation token's connection scope, and abandoned-setup
charge release. All three can pass on a campaign that never ran two setups at once.
The two existing saturation tests pin `max_handshakes` to 1 and 4 and use squatters
that never speak, so they cannot produce the state.

## Evidence trail

All references at commit `e447c927`.

The two bounds and their defaults:

- `crates/mc-host/src/runtime.rs:913`,
  `handshake_permits: Arc::new(Semaphore::new(config.limits.max_handshakes))`,
  default 32 (`config.rs:128`).
- `:914`,
  `connection_permits: Arc::new(Semaphore::new(config.limits.max_connections))`,
  default 64 (`config.rs:129`).

The class-crossing interval, `crates/mc-host/src/connection.rs:137-141`: the
connection permit is acquired at `:137` and the handshake permit is dropped at
`:140`, so a peer is briefly charged to both. With only one setup in flight that
interval is unobservable in aggregate, because the two classes never contend.

The window this record needs to see populated is inside `activate_server`: from the
`sendmsg` that hands over the descriptors (`setup_socket.rs:151-159`, reached from
`:249-260`) to the `Activated` write at `:273`. A connection in that window holds a
prepared ring, a connection permit, and two descriptors the peer already has.

What the existing tests do:

- `crates/mc-host/tests/lifecycle.rs:237`
  `saturated_handshake_capacity_closes_without_reading_client_bytes` sets
  `config.limits.max_handshakes = 1` at `:239`, occupies the single slot with
  `raw_client::connect_unauthenticated` at `:244`, and the comment at `:243` says
  "Occupy the only handshake slot with a socket that never speaks". It asserts the
  second accept closes without a read (`:252-253`) and that the slot is released
  (`:273`).
- `crates/mc-host/tests/lifecycle.rs:337`
  `an_unauthenticated_flood_cannot_starve_established_work` sets
  `max_handshakes = 4` at `:339` and, at `:355-357`, opens sockets whose own
  comment says "Never speak: each socket squats a handshake slot until the
  absolute auth deadline expires."

Neither test's squatters authenticate, so neither can put a connection into the
`activate_server` window while the handshake class is full. With
`max_handshakes = 1` it is arithmetically impossible: the one slot is held by a
peer that will never authenticate.

`raw_client::connect_unauthenticated` at
`crates/mc-host/tests/support/raw_client.rs:878` is documented at `:877` as being
for "admission and handshake-deadline tests", which matches: it returns a raw
stream and does not authenticate.

The authenticated-and-delayed peer does exist elsewhere:
`crates/mc-host/tests/shm_failure_modes.rs:44-58` authenticates, calls
`receive_grant`, and then parks on `std::future::pending()`. That is the second
clause's ingredient, and it lives in a different test binary from the saturation
tests.

## Failure scenario

Not a defect in the system. A defect in the campaign.

Suppose the activation token were hoisted to a per-host value. Cross-connection
token acceptance becomes possible, but no test that runs one setup at a time can
observe it, and the whole in-crate unit suite passes the literal string `"token"`
on both sides (`setup_socket.rs:461`, `:579`, `:610`, `:623`, `:676`, `:704`,
`:754`, `:785`), so the change is invisible there too.

Suppose the `prepare` timeout exit stranded a charge. With `max_connections = 64`
and setups running one at a time, sixty-four leaks are needed before a connect
probe fails, and the ratchet test that would notice
(`shm_failure_modes.rs:247-263`) exercises a different exit.

Suppose the class-crossing interval at `connection.rs:137-141` had its order
reversed, releasing the handshake permit before acquiring the connection permit.
That opens a window in which a peer is charged to neither class, so a burst can
exceed both bounds. Observing it requires the handshake class to be full at the
moment a peer promotes, which is precisely the state this record asks for.

This is the same vacuity that Part 1's Group M records were introduced to prevent:
liveness and bounding properties that a campaign satisfies without ever producing
the operational state they describe.

## Timing windows and dependencies

The state is a conjunction of two independent conditions observed at one instant:

1. `handshake_permits.available_permits() == 0`;
2. at least one connection is inside `activate_server` between the descriptor send
   (`setup_socket.rs:260`) and the `Activated` write (`:273`).

They are independent because the first is driven by unauthenticated dialers and the
second by an authenticated one, and by `connection.rs:140` the authenticated peer no
longer holds a handshake permit. So a correct implementation can and should reach
the conjunction, which is what makes it a legal coverage marker rather than a
disguised violation check. Nothing here asserts a defect.

Both bounds must be above 1 for the conjunction to be satisfiable. With
`max_handshakes = 1` the single slot is either the squatter's or the promoting
peer's, never both.

## What a test must construct

1. Start a host with `max_handshakes = 4` and `max_connections` at least 2. Four is
   enough to make the class fillable while leaving the arithmetic clear.
2. Start one dialer that authenticates, calls `receive_grant`, and then delays
   before sending `Activate`. The delay must be shorter than
   `transport_setup_deadline`, 2 seconds by default (`config.rs:227`), so the
   connection is inside the window rather than past it.
3. Start five dialers that connect and never speak, so the handshake class
   saturates and at least one accept is refused.
4. Fire the marker when both conditions hold at one observation. The marker name is
   a fixed constant, for example `SETUP_SATURATED_WITH_INFLIGHT_GRANT`, never built
   from run-time values.
5. Assert the marker fired at least once across the campaign.

Observation points: condition 1 from `Semaphore::available_permits` on
`shared.handshake_permits`, condition 2 from an instrumentation hook between
`setup_socket.rs:260` and `:261`.

The two conditions must be sampled together. Sampling them separately and
concluding the conjunction occurred is the standard way this kind of marker becomes
a lie.

Once this record is satisfied, the three dependent records become worth trusting:
`setup-a-unauthenticated-setup-work-is-bounded-and-every-slot-is-released`,
`setup-a-an-activation-token-is-scoped-to-the-connection-that-minted-it`, and
`setup-a-an-abandoned-setup-strands-no-ring-charge`.

## Investigation log

### Q: Can either existing saturation test reach the conjunction?

- Sources examined: `crates/mc-host/tests/lifecycle.rs:237-275`, `:334-360`,
  `crates/mc-host/tests/support/raw_client.rs:877-880`.
- Findings: no. The first sets `max_handshakes = 1`, so the conjunction is
  arithmetically unreachable. The second sets 4 but every dialer is
  `connect_unauthenticated` and, per its own comment at `:356`, never speaks, so
  condition 2 is never populated.
- Missing evidence: `lifecycle.rs:360` onward was not read, so a later phase of the
  flood test might authenticate. The comment at `:355-357` reads as though it does
  not.
- Conclusion: resolved as "not reached", with the unread tail noted.

### Q: Is `sometimes` the right semantics rather than `reachable`?

- Sources examined: METHOD's check-semantics table and its rule that "a campaign
  can execute a branch's lines while never producing the operational state the
  branch represents".
- Findings: every line involved already executes. `runtime.rs:1037-1040`'s refusal
  branch runs in `lifecycle.rs:237`. `connection.rs:137-141` runs on every
  successful connection. `setup_socket.rs:249-273` runs in several unit tests. What
  never occurs is the two of them being true at once.
- Missing evidence: none.
- Conclusion: resolved. This is situation coverage, not location coverage, so
  `sometimes`.

### Q: Does the marker risk being a disguised violation check?

- Sources examined: METHOD's coverage-check rules.
- Findings: the two conditions are independent preconditions of the vulnerable
  window rather than the window's failure. A correct host reaches both routinely
  under load. Neither clause mentions the token, the charge, or the permit count
  crossing a bound, so the marker cannot fire only by observing a defect.
- Missing evidence: none.
- Conclusion: resolved. The marker is valid under the coverage-check rules.
