# client-a-a-duplicate-host-bind-collapses-two-routes-into-one-handle

## Discovery trigger

Task 2 asked for "every place it treats a host response as trustworthy without
validating it." `parse_route_open` validates the shape of a route handle but not its
novelty, and the container it lands in silently absorbs a repeat.

## Evidence trail

`parse_route_open` checks four things and nothing else:

```
2167: fn parse_route_open(body: &[u8]) -> Result<RouteHandle, CallError> {
2168:     let value = serde_json::from_slice::<Value>(body).map_err(|_| { ... })?;
2175:     if value.get("op").and_then(Value::as_str) != Some("route.open") {
...
2182:     let channel = value
2183:         .get("route_channel")
2184:         .and_then(Value::as_u64)
2185:         .and_then(|value| u16::try_from(value).ok())
2186:         .filter(|value| *value != 0)
...
2194:     let epoch = value
2195:         .get("route_epoch")
2196:         .and_then(Value::as_u64)
2197:         .and_then(|value| u32::try_from(value).ok())
2198:         .filter(|value| *value != 0)
...
2206:     Ok(RouteHandle { channel, epoch })
```

Valid JSON, `op == "route.open"`, a nonzero `u16` channel, a nonzero `u32` epoch. It
is a pure function of the body with no access to `routes`, so it cannot check
novelty even in principle.

The container absorbs a repeat:

```
944:    routes: Mutex<HashSet<RouteHandle>>,
```

`RouteHandle` derives `Hash` and `Eq` (`handler.rs`, imported at
`client.rs:34`), so `routes.insert(handle)` at `:507` returns `false` for a value
already present and leaves the set unchanged. The return value is discarded.

`settle_route` can remove it only once:

```
1623:    fn settle_route(&self, route: RouteHandle) -> bool {
1624:        let pending = {
1625:            let _admission = lock_unpoisoned(&self.admission);
1626:            let mut pending = lock_unpoisoned(&self.pending);
1627:            if !lock_unpoisoned(&self.routes).remove(&route) {
1628:                return false;
1629:            }
1630:            let keys: Vec<_> = pending
1631:                .keys()
1632:                .copied()
1633:                .filter(|key| key.route() == route)
1634:                .collect();
```

The `remove` at `:1627` is the idempotence gate, and the `filter` at `:1633`
collects every pending key on that route regardless of which caller owns it. So one
`close_route` settles both callers' work with `route_gone` (`:1643`) and the second
`close_route` returns `Ok(())` early at `:567` having done nothing.

The late-bind reclaimer cannot help either:

```
1572:    fn release_stranded_route(&self, body: &[u8]) {
1573:        let Ok(route) = parse_route_open(body) else {
1574:            return;
1575:        };
1576:        if lock_unpoisoned(&self.routes).contains(&route) {
1577:            return;
1578:        }
```

The early return at `:1576` is correct for the case §8.2 describes, and the doc says
so at `docs/mc-host-wire-protocol.md:650`: "A bind already present in the client
route cache belongs to a caller that received it and MUST NOT be released this way."
The consequence here is that a genuine duplicate bind, which is present in the
cache, is never released.

## Failure scenario

Caller A calls `open_route` and receives `(7, 77)`. It is inserted at `:507`.
Caller B calls `open_route` for a different target. The host, through a bug or
because a hostile peer occupies the setup path, answers with `(7, 77)` again.
`parse_route_open` accepts it, `routes.insert` returns `false`, and caller B
receives `Ok(RouteHandle { channel: 7, epoch: 77 })`.

Both callers now believe they own route `(7, 77)`. They issue requests on it; each
request's `PendingKey` (`:872-876`) is distinguished by correlation, so the
terminals route correctly and nothing visible goes wrong yet.

Caller A calls `close_route((7, 77))`. `settle_route` collects every pending key
whose `route() == (7, 77)`, which includes caller B's, and settles them all with
`route_gone`. Caller B's in-flight requests fail for a reason it cannot explain, and
its subsequent requests get `route_not_live` from `require_route` (`:731-737`).

On the host side the second bind is never released, because the client sends one
route `Goodbye` for the shared handle and `release_stranded_route` skips it. If the
host tracks two bindings under one identity, one leaks for the life of the
generation.

Part 2c established that epochs are host-minted and that a granted descriptor is
never revoked, so the client has no independent basis on which to reject a repeated
handle. It could only detect the repeat locally, which is exactly the check that is
missing.

## Timing windows and dependencies

No fault timing is required for the collapse itself; it is a set-semantics
consequence. The damage is worst when the two opens overlap, because caller B then
has no way to learn that its handle predates its own request.

Related to `client-a-live-route-handles-are-bounded-only-by-the-host`: both follow
from `routes` being a plain `HashSet` with no admission discipline on insert.

Contrast with the adjacent malformed case, which the client does handle: a
successful `route.open` whose body names no route retires the generation at `:486`,
with the reasoning spelled out at `:475-482`. The author considered one class of
unusable host response and not the other.

## What a test must construct

1. A peer that answers two distinct `route.open` correlations with an identical
   `route_channel` and `route_epoch`. The fixture pattern is available from
   `a_duplicate_bind_terminal_never_closes_an_owned_route` (`:3587`) and
   `an_abandoned_control_open_releases_a_late_bound_route` (`:3503`), which already
   build `route.open` response bodies.
2. Assert both `open_route` calls returned `Ok` with equal handles, and that
   `lock_unpoisoned(&inner.routes).len() == 1`. That is the collapse.
3. Admit one request per caller on that route, then call `close_route` once. Assert
   both callers' requests were settled with `route_gone`, which is the
   cross-caller interference.
4. Assert the second `close_route` returns `Ok(())` without emitting a frame, by
   draining `control_rx` and counting exactly one `Goodbye`. That is the host-side
   leak.
5. Do not assert that the host leaked; the client cannot observe it. Assert the
   client-observable precondition, which is the single `Goodbye`.

## Investigation log

### Q: Should `open_route` retire on a duplicate handle?

- Sources examined: `client.rs:483-509` (the success path including the existing
  retire-on-malformed at `:486`), the   reasoning comment at `:475-482`,
  `docs/mc-host-wire-protocol.md:650`.
- Findings: the two cases are structurally the same. A body naming no route and a
  body naming an already-owned route are both host responses the client cannot turn
  into a usable, releasable handle. The existing remedy for the first is to retire,
  on the stated ground that "Retiring here is what obliges the host to settle every
  route on this generation (§11.2), including the unnameable one." The identical
  argument applies to the duplicate. Against that, retiring is a heavy remedy and a
  duplicate could in principle be a legitimate host answer if the host treats a
  repeated `route.open` for the same target as idempotent, which the doc does not
  say it does.
- Missing evidence: whether the host ever answers two `route.open` calls with one
  handle deliberately. That is 2e's control handler.
- Conclusion: needs human input. The symmetry argument is strong but the question of
  whether the host intends handle sharing is a design question I cannot settle from
  the client side.

### Q: Does `close`'s bulk drain have the same collapse?

- Sources examined: `close` (`:682-712`), specifically
  `let routes: Vec<_> = lock_unpoisoned(&self.inner.routes).drain().collect();` at
  `:684` and the loop at `:685-698`.
- Findings: `drain` yields each distinct handle once, so `close` sends exactly one
  `Goodbye` per set entry, which is one for the collapsed pair. Same host-side leak,
  reached by a different path. `settle_all("owner_close")` at `:683` runs before the
  drain and settles every pending request regardless of route, so the cross-caller
  interference does not add anything new on the close path.
- Missing evidence: none.
- Conclusion: resolved with answer. `close` exhibits the host-side leak but not the
  surprising cross-caller settlement, because on close every caller is being
  settled anyway.
