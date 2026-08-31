# rt-a-the-serial-setup-budget-triples-the-configured-transport-deadline

## Discovery trigger

Building the configuration table's "takes effect" column. Every other key has
one or two consumers. `transport_setup_deadline` has two, and they are serial on
the same task, which means the configured value bounds a stage rather than an
operation. `docs/mc-host-wire-protocol.md:731` forbids exactly that.

## Evidence trail

Three serial windows inside `run_connection` (`connection.rs:115`), each
verified:

`connection.rs:120-127` — authentication:

```
let auth = crate::auth::authenticate_server(
    &mut stream,
    shared.auth_key.bytes(),
    &shared.daemon_id,
    &shared.daemon_ver,
    shared.timing.auth_deadline,
)
.await;
```

`connection.rs:157-164` — ring preparation, a **fresh** absolute deadline:

```
timeout_at(
    Instant::now() + shared.timing.transport_setup_deadline,
    prepared,
)
```

`connection.rs:170-178` — activation, the **same duration again**:

```
if crate::setup_socket::activate_server(
    &mut stream,
    &descriptors,
    &descriptor,
    crate::wire::PROTOCOL_VERSION,
    mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
    token.as_str(),
    shared.timing.transport_setup_deadline,
)
```

Nothing between `:127` and `:170` carries a deadline forward. The `Instant::now()`
at `:158` is evaluated after authentication returned, and `:177` passes a
`Duration`, not an `Instant`, so `activate_server` arms its own budget from
whenever it is called.

At the defaults in `config.rs:223` and `:227`, both 2 seconds, the host's total
pre-service budget is 2 + 2 + 2 = 6 seconds.

The documented client side, `docs/mc-host-wire-protocol.md:737`:

> | discovery, setup-socket authentication, descriptor transfer, and ring
> attachment | one 2 s absolute handshake deadline |

That single 2 s deadline covers all three host stages. And `:747` warns:

> The 2-second handshake deadline spans discovery, setup-socket authentication,
> descriptor transfer, validation, and ring attachment together, while Section
> 5.1's recommended host authentication deadline is also 2 seconds. A deployment
> that needs the full host window for authentication MUST raise the client
> handshake deadline above it, because these two values are not independent.

The warning names one host stage, authentication. It does not name
`transport_setup_deadline` at all, let alone twice.

The general rule it sits under, `:731`:

> Every operation owns one absolute deadline; per-stage timers MUST NOT multiply
> it.

**No cross-field validation exists.** `HostConfig::validate` (`config.rs:300-379`)
validates each duration independently against zero and `MAX_CONFIG_DURATION`
(`:341-363`). There is no arithmetic relating `auth_deadline` and
`transport_setup_deadline`, and no field in `HostConfig` records a client budget
to compare against.

Prior coverage: Part 2c recorded this in
`part-2c-setup-identity/existing-checks.md:569-575` under "The two-second budgets
stated as coupled", concluding "a peer's single 2-second budget faces a host that
may spend up to 4 seconds" and noting "Nothing in `config.rs` validates the
relationship." The figure counts `transport_setup_deadline` once. Both sites arm
it, so the figure is 6, not 4. This record is a correction to that finding, not
an independent one.

## Failure scenario

A loaded host. A peer authenticates in 1.8 s, inside the host's 2 s
`auth_deadline`. `ring.prepare` on a `spawn_blocking` thread takes 1.5 s under
memory pressure, inside the host's fresh 2 s. `activate_server`'s descriptor
transfer and token compare take 0.9 s, inside the third 2 s.

The host considers all three stages successful and has a live authenticated
generation with ring endpoints granted. Total elapsed: 4.2 s.

A conforming client abandoned the handshake at 2.0 s. It closes its socket and
reports a discovery or handshake failure. The host, having succeeded, holds one
of 64 connection permits (`runtime.rs:914`), a ring admission charge, and a
prepared endpoint pair, until it notices the peer is gone.

`docs/mc-host-wire-protocol.md:296` says "Unexpected setup-socket EOF has
equivalent retirement effect but no peer drain guarantee", so the generation is
retired — but the client retries, and the same arithmetic applies again. Under
sustained load the host burns handshake and connection permits on peers that have
already given up, which is the failure the §11:747 warning was written to
prevent.

## Timing windows and dependencies

Three windows, strictly serial on one task, with the second and third both
derived from the same configured duration. The task is spawned per accepted
socket at `runtime.rs:1042-1044`.

The `spawn_blocking` at `connection.rs:145-147` matters for the second window:
`timeout_at` at `:158` cancels the *join*, not the blocking thread. Part 2c
records the consequence for the ring admission charge in
`setup-a-an-abandoned-setup-strands-no-ring-charge` and leaves the charge-release
question open pending 2b. That is their obligation; here it only means the second
window's expiry does not immediately free the resources it was bounding.

Dependencies: `max_handshakes` (32) bounds how many sockets can occupy these
windows at once (`runtime.rs:913`). The handshake permit is held across all of
authentication and dropped at `connection.rs:140`, only after
`connection_permits` was acquired at `:137`, so the 6-second budget is held
against the handshake pool for its first portion and the connection pool
thereafter.

## What a test must construct

A peer that stalls maximally at each stage in turn, and a measurement of
wall-clock from `run_connection` entry to `activate_server`'s return.

Part 2c already scoped the fixture and recorded that it does not exist:
`part-2c-setup-identity/fault-map.md:52` describes "a dialer that authenticates
and then delays its `Activate` inside the 2-second `transport_setup_deadline`",
and says it is `tests/shm_failure_modes.rs:44-58` with a bounded sleep instead of
`pending()`. `fault-map.md:53` and `:180` confirm the `prepare` timeout at
`:157-164` is reachable by setting `transport_setup_deadline` near zero through
the `start_with` closure, with no injected slowness.

So the construction is cheap. What is missing is the oracle: assert the total is
at most `auth_deadline + 2 * transport_setup_deadline`, and assert it is *not*
at most `auth_deadline + transport_setup_deadline`, which is what a reader of
§11:747 would predict.

Under `#[tokio::test(start_paused = true)]` the three stages can be separated
exactly, since `timeout_at` and `timeout` both use the virtual clock.

The cheapest production guard is a validation check, but it cannot be written:
`HostConfig` has no field for the client's budget. The honest alternative is a
documentation fix plus a test that pins the host-side sum, so a future stage
added to this path shows up as a changed number.

## Investigation log

### Q: does `activate_server` re-derive an absolute deadline from the duration, or share one?

- Sources examined: `connection.rs:170-178`, and the signature at
  `setup_socket.rs:237`.
- Findings: `:177` passes `shared.timing.transport_setup_deadline`, a `Duration`.
  A `Duration` carries no origin, so the callee must convert it to an `Instant`
  relative to its own entry. There is no way for it to inherit the deadline armed
  at `:158`.
- Missing evidence: the body of `activate_server`, which is 2c's file. I read the
  signature and the call site only.
- Conclusion: resolved with answer for the arithmetic — passing a `Duration`
  makes a shared absolute deadline impossible. Whether `activate_server`
  subdivides it further is 2c's question; if it does, the total only grows.

### Q: is there any host-side field that could express the client's budget?

- Sources examined: `config.rs:196-232` (`HostTiming`), `:268-283` (`HostConfig`).
- Findings: none. Every field is a host-owned budget. `client.rs`'s exported
  constants (`lib.rs:48-52`, including `CLIENT_HANDSHAKE_TIMEOUT`) are the
  client's own and are not readable by `HostConfig::validate` as configuration.
- Missing evidence: none.
- Conclusion: resolved with answer — the cross-field check the specification
  implies cannot be written against the current type. Either `HostTiming` gains a
  declared peer budget, or the coupling stays a documentation obligation.

### Q: does 2c already own this, making the record a duplicate?

- Sources examined: `part-2c-setup-identity/existing-checks.md:569-575`,
  `catalog.md:634`, `:667`, `:711`, `fault-map.md:34`, `:52`, `:53`, `:180`,
  `:293`.
- Findings: 2c records it in `existing-checks.md` as a contract-versus-code
  observation with the figure 4 s, and treats `transport_setup_deadline` in
  several records as an enabling knob. No 2c record asserts the serial sum, and
  no 2c record states it is armed twice.
- Missing evidence: none.
- Conclusion: resolved with answer — not a duplicate. This record corrects 2c's
  figure and promotes the observation to a property. Synthesis should
  cross-reference rather than merge, and 2c's `existing-checks.md` line needs the
  figure amended by whoever owns that file.
