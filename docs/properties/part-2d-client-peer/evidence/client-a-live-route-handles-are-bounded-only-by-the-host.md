# client-a-live-route-handles-are-bounded-only-by-the-host

## Discovery trigger

Task 5 asked whether pending requests, buffers, or leases are bounded on the client
side and what reaps them, noting that "unbounded caller-driven growth and missing
reapers recur in every part of this catalog." Inventorying the client's caps showed
routes are the one collection with no cap.

## Evidence trail

The client declares exactly two collection caps:

```
53: pub const CLIENT_MAX_PENDING_REQUESTS: usize = 1_024;
55: pub const CLIENT_MAX_LIVE_STREAMS: usize = 64;
```

Both are enforced. `pending`:

```
1169:        if pending.len() >= CLIENT_MAX_PENDING_REQUESTS {
1170:            return Err(CallError::local(
1171:                SendOutcome::NotSent,
1172:                "pending_capacity",
1173:                "pending request capacity exhausted",
1174:            ));
1175:        }
```

`streams`:

```
1057:            let mut streams = lock_unpoisoned(&self.streams);
1058:            if *streams >= CLIENT_MAX_LIVE_STREAMS {
1059:                return Err(CallError::local(
1060:                    SendOutcome::NotSent,
1061:                    "stream_capacity",
1062:                    "live stream capacity exhausted",
1063:                ));
1064:            }
1065:            *streams += 1;
```

`routes` has no equivalent. The only production insert:

```
498:                    {
499:                        let mut routes = lock_unpoisoned(&self.inner.routes);
500:                        if self.inner.closed.load(Ordering::Acquire) {
501:                            return Err(CallError::local(
502:                                SendOutcome::NotSent,
503:                                "client_closed",
504:                                "client is closed",
505:                            ));
506:                        }
507:                        routes.insert(handle);
508:                    }
```

The guarded condition at `:500` is closure, not capacity. There is no
`CLIENT_MAX_LIVE_ROUTES` constant anywhere in the file; the only other
`routes.insert` sites are the eight test fixtures at `:2627`, `:2869`, `:2928`,
`:2972`, `:3020`, `:3387`, `:3433`, `:3640`, and `:3722`.

The byte budgets are all capped, for contrast: `queue_budget` (`:398`),
`control_budget` (`:399`), `_read_budget` (`:400`), and `retained_budget`
(`:401`), each a `ByteCounter` whose `charge` refuses above `cap` (`:1766-1768`).
So the omission is specific to route handles, which carry no byte weight locally.

Reapers exist and are complete for the cases they cover:

| Reaper | Site | Trigger |
| --- | --- | --- |
| `settle_route` | `:1623-1647`, removal at `:1627` | inbound route `Goodbye` (`:1403`), or `close_route` (`:566`) |
| `retire` | `:1673` | any generation retirement |
| `close` | `:684`, `drain()` | owner close |

There is no periodic or idle reaper, which is correct: a route is live until one of
those three events, so there is nothing for a timer to collect.

## Failure scenario

A caller loops on `open_route` without closing. Each success inserts a handle at
`:507`. Locally the cost is one `RouteHandle` per entry, which is six bytes of
payload in a `HashSet`, so the client-side memory growth is negligible and would
not be worth a record on its own.

The consequence is transitive. Each entry corresponds to a host-side route binding
and a global channel permit, which
`docs/mc-host-wire-protocol.md:658` describes as finite and whose exhaustion it
says returns `target_unavailable`: "`target_unavailable` is reserved for route
admission — `route.open` failures such as channel exhaustion (Section 8.2)". So the
looping caller exhausts the host rather than itself, and the client has no local
signal that it is doing so.

The interaction with `open_route`'s retry loop makes this worse.
`target_unavailable` is one of the four codes `:511-519` retries on. So a caller
that has exhausted host channels enters a 30-second retry loop against a condition
its own unclosed routes caused, with 25 ms doubling backoff capped at 500 ms
(`:459`, `:523-524`), which is roughly 60 further attempts.

## Timing windows and dependencies

No timing window. The growth is caller-driven and monotone until a reaper fires.

Depends on the host's route cap for the transitive bound, which is the open question
below. If the host has no cap either, the growth is unbounded on both sides.

Related to `client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle`,
which is the other consequence of `routes` being a plain `HashSet` with no
admission discipline.

## What a test must construct

1. A host, or a fake peer, that binds every `route.open` with a fresh
   `(channel, epoch)`.
2. Open routes in a loop without closing. Assert that `open_route` keeps succeeding
   past `CLIENT_MAX_PENDING_REQUESTS` and past `CLIENT_MAX_LIVE_STREAMS`, which
   establishes that neither existing cap incidentally bounds routes.
3. Assert `lock_unpoisoned(&inner.routes).len()` equals the number of successful
   opens, which is the property: no local refusal occurred.
4. Separately, to characterise the transitive bound, continue until the peer returns
   `target_unavailable` and record the count. That number is the real bound and it
   belongs in the host's catalog, not the client's.
5. Then assert the reapers: send one inbound route `Goodbye` and confirm exactly one
   entry left; call `close` and confirm the set is empty.

## Investigation log

### Q: Does the host cap concurrent routes per generation?

- Sources examined: `docs/mc-host-wire-protocol.md:658`, which requires finite
  limits for "live connections, routes, pending correlations, handler tasks, queued
  requests, and aggregate buffered bodies" and reserves `target_unavailable` for
  route-admission failures including channel exhaustion.
- Findings: the contract clearly intends a host-side cap and names the code the host
  returns when it trips. Whether the implementation has one is a `dispatch.rs` or
  `routing.rs` question, which sub-part 2e owns, and a `config.rs` question, which
  2f owns. I did not read either.
- Missing evidence: the host's route or channel cap and its enforcement site.
- Conclusion: unresolved, needs 2e or 2f. Note that even if the host caps, the
  client is still non-conforming against `:658`, which places the obligation on
  "implementations" without exempting one side.

### Q: Is `routes` consulted on a hot path where its size would matter?

- Sources examined: `require_route` (`:723-739`, lookup at `:731`), `admit`
  (`:1149-1161`, lookup at `:1154`), `release_stranded_route` (`:1576`),
  `settle_route` (`:1627`), `close` (`:684`).
- Findings: every access is a `HashSet` point operation except `close`'s `drain`,
  so size does not affect per-request cost. `settle_route` does scan `pending` at
  `:1630-1634` to find that route's keys, but `pending` is capped at 1024, so that
  scan is bounded regardless of route count.
- Missing evidence: none.
- Conclusion: resolved with answer. There is no local performance consequence, which
  confirms the impact is entirely transitive to the host.
