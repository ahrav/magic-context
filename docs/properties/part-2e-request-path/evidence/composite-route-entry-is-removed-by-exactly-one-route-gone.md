# composite-route-entry-is-removed-by-exactly-one-route-gone

Carried into this sub-part from the superseded `part-2b-wire-and-channels`, where
it was record 10 of `_lenses/lens-c-negotiation-provider.md` (`L599-636`). Every
`composite.rs` and `tests/composite_routing.rs` citation in the record was
re-verified line by line at `HEAD` = `e447c927` and **none needed repair**. What
the carry added is a resolution of the record's one open question, which turned
out to be answerable inside this sub-part rather than outside it.

## Discovery trigger

`StaticComposite` keeps its own route map, separate from the host's
`RouteRegistry`: `routes: Mutex<HashMap<RouteHandle, Child>>` at
`composite.rs:112`, initialized at `:134`. That map is the composite's only way to
answer "which child owns this handle", and it has exactly one insert and exactly
one remove. Whether those balance is not enforced by anything in `composite.rs`;
it is delegated to the host's promise to deliver `route_gone`.

## Evidence trail

**The insert, and why it is where it is.** `bind` is `composite.rs:242-275`. It
resolves the child by module id at `:248-253`, and for an unmapped module returns
`BindOutcome::Reject` at `:257-260` — **before** the insert, so that path adds
nothing and needs no removal. Then:

- `:262-265` — the comment stating the contract: "Inserted before the child
  observes the handle and retained through rejection, panic, and close-wins-bind:
  the host still owes exactly one route-gone for each of those outcomes, and that
  callback needs this entry to reach the same child."
- `:266-269` — the insert: `self.routes.lock().expect("composite route map")
  .insert(route, child)`.
- `:270-274` — the `match child` that awaits the child's own `bind` at `:271`,
  `:272` or `:273`.

So the insert precedes the `await`. A panic inside the child's `bind` leaves the
entry behind, which is deliberate and is the reason the comment names panic
explicitly.

**The removal, and its intentional window.** `route_gone` is
`composite.rs:289-303`:

- `:290` — `let child = self.child_of_route(route);`
- `:291-296` — the `match child`, whose three `Some` arms at `:292-294` dispatch
  to the owning child's `route_gone` and await it.
- `:295` — `None => return`, the unmapped arm, which returns **without touching
  the map**. This is what makes a spurious callback harmless: it cannot remove a
  different handle's entry.
- `:297-298` — the comment: "Removed only after the child's callback stopped, so
  the map can never claim a child is done with a handle it is still cleaning up."
- `:299-302` — the removal, `self.routes.lock().expect("composite route map")
  .remove(&route)`.

The record's `Fault/timing angle:` cites the comment and the removal together as
`:297-303`, the block from the comment to the function's closing brace. That is
the form used below where the record is quoted; the statement itself is
`:299-302`.

`handle` is `composite.rs:277-287` and consults the same map through
`child_of_route` (`:138`), with its own unmapped arm at `:282-285` returning
`RequestOutcome::error(CODE_INTERNAL_ERROR, "route is not mapped to a
component")`. Because the removal at `:299-302` follows the child's callback, a
request arriving for a handle mid-`route_gone` still resolves to the correct
child. That window is intentional.

**The at-most-one half has a named enforcer, on the runtime side.** This is new at
carry time and it strengthens the record. `run_route_gone`
(`dispatch.rs:1252-1278`) opens with `if !shared.registry.mark_gone_started(handle)
{ return true; }` at `:1256-1258`. `mark_gone_started` (`routing.rs:377-390`) sets
`occupant.gone_started = true` at `:388` under the registry lock and returns
`false` if the flag was already set, the epoch diverges, or the slot or occupant
is absent (`:380`, `:383`, `:385-387`). The comment at `routing.rs:52-54` states
the intent: the flag is "set under the registry lock immediately before the
route-gone callback task is spawned; guarantees exactly-once even when a graceful
closer and the forced shutdown path race". So a second `run_route_gone` for the
same handle returns `true` **without invoking the child callback**, and the
composite's removal cannot run twice. The upper bound of "exactly one" is
therefore enforced one layer up, not in `composite.rs`.

**The at-least-one half has three exceptions, and all three trip the fatal
latch.** Traced at carry time by reading every `run_route_gone` call site
(`dispatch.rs:1166`, `:1199`, `:1220`, `:1313`, `:1446`) and every early return
that skips one:

1. **`dispatch.rs:1174`** — `Err(LifecycleFailure { stopped: false })`, the bind
   is still executing past `lifecycle_callback_deadline`. The function returns
   with no `route_gone`. The comment at `:1171-1173` is explicit that this is
   deliberate: "running route-gone or freeing the channel would overlap it for the
   same handle. The latch is already tripped, so the route stays claimed and the
   incarnation terminates."
2. **`dispatch.rs:1440-1444`** — a dispatch task did not stop before route-gone.
   `shared.fatal.trip(..., "dispatch task did not stop before route-gone")` then
   `return`, before the `run_route_gone` at `:1446`.
3. **`run_route_gone` returning `false`** at `dispatch.rs:1276`
   (`Err(failure) => failure.stopped`). Here the child callback *was* invoked, but
   per the doc comment at `:1248-1251` a `false` means "its deadline expired inside
   a non-yielding poll". If the child's `route_gone` future never returns, the
   composite's `await` inside `:292-294` never completes and the removal at
   `:299-302` never runs.

All three trip the fatal latch, so the map entry outlives the route only for as
long as the incarnation is terminating. That is a weaker bound than the record's
`Impact:` assumes ("for the host's lifetime") but it is a bound.

**Existing coverage, both spans re-verified.**

| Site | Test | What it pins |
| --- | --- | --- |
| `:485-531` | `rejected_broca_bind_gets_exactly_one_broca_route_gone` (attribute `:485`, `fn` `:486`) | exactly one `route_gone` for a rejected bind |
| `:532-600` | `a_closed_route_handle_cannot_dispatch_to_stale_child_ownership` (attribute `:532`, `fn` `:533`) | a closed handle cannot dispatch to stale child ownership |

`tests/composite_routing.rs` is byte-identical across the lens-era commits and
`HEAD`: blob `2201b830` at `1c193ae0`, `793a973e` and `e447c927`, 1,049 lines and
16 tests at all three. The binary is unnamed in CI, so neither test runs there.

So of the three non-success bind outcomes the comment names, one has a test.
Panicking `bind` and close-wins-bind have none, and neither do the three
latch-tripping paths above.

**Reachability.** `serve.rs:575` constructs `StaticComposite::new(...)` and `:632`
passes it to `mc_host::run`; both re-printed at carry time. `composite.rs`
contains zero `#[cfg]` attributes, verified by grep, so no part of the file is
gated. The routed path that reaches `handle` and `route_gone` is Fact 1 of the
catalog's [Reachability](../catalog.md#reachability) section.

## Failure scenario

The record's own scenario is a bind path that yields no `route_gone`, leaking one
entry per connection. At carry time that scenario is confirmed to exist, in the
three latch-tripping forms above, and to be milder than stated because each is
accompanied by a terminating incarnation.

The sharper failure is the second half of the record's `Impact:`, and it does not
need a leak that lives forever. Take path 1: a handler's `bind` blocks past
`lifecycle_callback_deadline`. `dispatch.rs:1174` returns, the latch is tripped,
and the composite's map still holds `route → child`. The registry has *not*
finalized the route, so the channel is not freed for reuse — that is exactly what
the comment at `:1171-1173` is protecting. So during the shutdown window the map
entry is stale but the handle it names cannot be reissued, and `handle` for that
route resolves to a child that is still inside its own `bind`. What the
composite's `handle` does then is the child's business, and this record does not
extend to it.

The reuse hazard the record names needs the map entry to survive *and* the channel
to be freed. `finalize_close` (`routing.rs:276`) is what frees it, and every call
site is guarded by a `run_route_gone` that returned `true`
(`dispatch.rs:1167`, `:1200`, `:1222`, `:1314`, `:1447`). So on the paths where
the composite's entry leaks, the channel is not freed, and on the paths where the
channel is freed, the composite's `route_gone` ran. That is a real coupling and it
is not stated anywhere in `composite.rs` — the composite's own comment claims the
host "owes exactly one route-gone", which is the strong form, and the actual
protection for the reuse hazard is the weaker but sufficient
`finalize_close`-follows-`route_gone` ordering.

## Timing windows and dependencies

**The intentional window** is `composite.rs:291-303`: the child's `route_gone` has
been awaited but the map entry is still present. `handle` resolving during it is
correct behaviour, and the comment at `:296-297` says so.

**The unintentional window** is the three latch-tripping paths, where the entry is
present with no pending removal.

**The race the enforcer covers** is a graceful closer against the forced shutdown
path, both calling `run_route_gone` for one handle. `mark_gone_started`'s
compare-and-set under the registry lock (`routing.rs:377-390`) serializes them.
`routing.rs:392-396` describes the other half: the forced sweep only marks
mid-bind routes close-requested, because "their abort-exempt bind wrapper owns the
exactly-once route-gone".

Dependencies:

- On `dispatch.rs`'s `open_route` (`:1103` onward) and `run_route_gone`
  (`:1252-1278`) for the delivery promise. Both are in this sub-part's scope,
  which is why the record's open question was answerable here.
- On `routing.rs:377-390` for the exactly-once flag. That is 2e's scope too, via
  `routing.rs`.
- On [req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close](req-a-every-pending-entry-is-removed-by-its-owner-or-its-route-close.md),
  which is the structurally identical property one layer up over
  `connection.rs`'s `pending` map. The two are not the same map and neither
  dominates the other, but a campaign that builds the forced-shutdown state for
  that record produces path 2 above for this one, so they are cheapest built
  together.

## What a test must construct

The oracle is per-handle accounting, with total map size as a cheap screen — the
record's `Check:` is explicit that an insert and an unrelated remove cancel in the
total.

The obstacle is observability, and it is real: `routes` is a private field
(`composite.rs:112`) on a struct in a module with no test module of its own, and
`child_of_route` (`:138`) is a private method. So an integration test cannot read
the map. Three routes around that, in increasing cost:

1. **Count `route_gone` invocations at the child.** The existing test at
   `:485-531` already does exactly this for the rejected-bind case, using a child
   stub that records its calls. Extend the same stub to the two uncovered
   outcomes: a panicking `bind` (the child panics inside its own `bind`), and
   close-wins-bind. Assert exactly one `route_gone` per handle. This does not
   observe the map, but it observes the callback the removal is keyed to, which
   makes it a valid proxy **only** because `composite.rs:299-302` is
   unconditional once the `match` at `:291-296` returns. That dependency should be
   stated in the test, or the proxy silently becomes wrong if a condition is added.
2. **Observe `handle`'s unmapped arm.** After the expected removal, dispatch to
   the same handle and assert the `CODE_INTERNAL_ERROR` "route is not mapped to a
   component" from `:282-285`. This observes map *absence* through the public
   trait surface and needs no access to the field. It is the strongest available
   oracle for the removal actually happening, and no existing test uses it.
3. **A size screen, which needs a new accessor.** Only worth it if the per-handle
   oracles prove insufficient.

Faults needed: `C3` from the fault map supplies both bind-stop forms, and `C4`
supplies `CloseWins` and has no deterministic seam. For the three latch-tripping
paths, path 1 needs a `bind` that blocks past `lifecycle_callback_deadline` with a
shrunk `HostTiming`, path 2 needs the forced-shutdown state that
`tests/lifecycle.rs:678` and `:714` already build, and path 3 needs a child whose
`route_gone` does not return.

Note that all three latch paths terminate the host, so the oracle must be read
from the client's side or from the latch, not from a subsequent request.

## Investigation log

### Q: Does the host guarantee `route_gone` after a panicking `bind`, or only after `Reject` and close?

- Sources examined: `composite.rs:242-275` (`bind`, the insert, the comment at
  `:262-265`), `dispatch.rs:1103` onward (`open_route`), `:1140-1175` (the bind
  task, its watchdog, and `lifecycle_join`'s three arms), `:1177-1240`
  (the `Accept`/`CloseWins`/`Reject` arms), `:1252-1278` (`run_route_gone`),
  `runtime.rs:179-209` (`lifecycle_join`), `panic_boundary.rs:1-66` (the whole
  file), `routing.rs:377-390` (`mark_gone_started`).
- Findings: **yes, resolved.** The chain is: `handler.bind` is invoked inside
  `panic_boundary::redact_sync` at `dispatch.rs:1148`, and `redact_sync`
  (`panic_boundary.rs:52-55`) does **not** `catch_unwind` — it increments a
  thread-local depth counter through `CallbackPollGuard` (`:15-28`) so the
  process panic hook installed at `:38-49` prints a redacted line instead of the
  payload, then calls the closure directly. The same is true of the async
  `redact` at `:59-66`, which guards each individual poll. So a panic propagates
  out of the `spawn_lifecycle` task. `lifecycle_join` (`runtime.rs:179-209`)
  observes `Ok(Err(join_err))`, tests `join_err.is_panic()` at `:187`, trips the
  fatal latch at `:192-193`, and returns `Err(LifecycleFailure { stopped: true })`
  at `:194`. `dispatch.rs:1164` matches `Ok(None) | Err(LifecycleFailure {
  stopped: true })`, calls `take_rejected_bind` at `:1165` and `run_route_gone` at
  `:1166`. So the panicking-`bind` outcome does produce exactly one `route_gone`,
  and the comment at `composite.rs:262-265` is correct on all three outcomes it
  names.
- Missing evidence: none for the question as asked. The lens marked this "needs
  verification in the runtime" and the runtime file is `dispatch.rs`, which is
  inside this sub-part's own scope — so the question was answerable in the
  sub-part that absorbed the record, and would have been answered by the lens
  passes if they had carried it.
- Conclusion: resolved with answer. Yes, for all three named outcomes. See the
  next entry for what the resolution surfaced.

### Q: Are there bind or close outcomes the composite's comment does not name, on which the map entry is never removed?

- Sources examined: every `run_route_gone` call site (`dispatch.rs:1166`, `:1199`,
  `:1220`, `:1313`, `:1446`), every early return that skips one (`:1174`,
  `:1440-1444`), `run_route_gone`'s own return contract (`:1246-1251` doc comment,
  `:1274-1277` body), `finalize_close`'s five call sites (`:1167`, `:1200`,
  `:1222`, `:1314`, `:1447`) and its definition (`routing.rs:276`).
- Findings: three, listed in the evidence trail above. All three trip the fatal
  latch. And a fourth path exists that is *not* an exception and is worth
  recording as such: the unmapped-module `Reject` at `composite.rs:257-260`
  returns before the insert at `:266-269`, so it needs no removal.
  Separately, the reuse hazard in the record's `Impact:` is protected by an
  ordering the composite does not state: all five `finalize_close` call sites are
  guarded by a `run_route_gone` that returned `true`, so the channel is never
  freed on a path where the composite's entry leaked.
- Missing evidence: whether the latch-tripped incarnation's teardown drops the
  composite, which would drop the map with it. `StaticComposite` is owned by the
  value `serve.rs:575` builds and `:632` moves into `mc_host::run`, so its
  lifetime is the `run` call, but tracing whether `run` returns on every
  latch-tripping path was not done — that is 2a's and 2f's scope.
- Conclusion: unresolved, needs the fatal-latch teardown path traced in
  `part-2a-host-lifecycle` or `part-2f-runtime-config`. The bound is at worst a
  terminating incarnation rather than the host's lifetime, which is enough to
  state the finding without resolving it. Carried into the record as an open
  question marked "needs human input", because whether the terminating-incarnation
  bound is the intended answer is a design decision rather than a fact in the
  tree.
