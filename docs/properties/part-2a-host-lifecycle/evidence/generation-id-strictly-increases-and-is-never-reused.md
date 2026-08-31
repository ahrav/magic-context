# generation-id-strictly-increases-and-is-never-reused

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD has since moved to the
merge commit `1c193ae0`, and `git diff d90e7811 HEAD` is empty for every file
cited below, so every line number here is valid for both.

## Discovery trigger

The generation id is not just a label. It is the ownership key two registries
arbitrate on: `shared.connections` is keyed by it, and the route registry decides
whether a close request is legitimate by comparing it. Both treat "same id" as
"same generation" with no secondary witness, so a repeated id is indistinguishable
from the original owner. A socket that negotiates a non-TCP transport mints *two*
ids, which makes the per-socket count non-obvious.

## Evidence trail

- `connection.rs:238-258` `new_generation` — the only constructor of
  `GenerationCore`. `:245` is the whole minting rule:
  `id: shared.gen_counter.fetch_add(1, Ordering::SeqCst),`. One `fetch_add`, no
  read-then-write, so concurrent accepts cannot collide.
- `runtime.rs:136` declares `pub gen_counter: AtomicU64`; `runtime.rs:898`
  initializes it as `AtomicU64::new(1)`, per `HostShared`, so the counter's
  lifetime is one host incarnation. Repo-wide `grep -rn gen_counter crates/`
  returns exactly these three lines — one declaration, one initializer, one use.
  This confirms the catalog's "exactly two references" claim.
- `connection.rs:188` and `connection.rs:211` are the two `new_generation` call
  sites: the bootstrap channel, and the promoted candidate after a committed
  grant. Both are on one `run_connection` stack, so a granted socket consumes two
  consecutive ids. **Correction:** the catalog's Group A prose puts the promote
  and reap block at "~198-235"; the promoted mint is at `:211`, inside `match
  promoted` at `:207-235`, and `let Some(handoff) = handoff else` is at `:198`.
- `runtime.rs:137` `pub connections: Mutex<HashMap<u64, Arc<GenerationCore>>>` —
  the id is the map key. Insert is `connection.rs:288`; the only removal is
  `dispatch.rs:1386-1390` inside `close_generation`. A duplicate key would make
  the insert an overwrite, silently dropping the earlier `Arc` from the registry
  while its task still runs.
- `routing.rs:218-223` `begin_close_generation(gen_id)` and `routing.rs:232`
  `begin_close_owned(handle, gen_id)` — the doc comment at `:230-231` states the
  ownership test outright: "A foreign handle is an idempotent no-op even when its
  channel and epoch are valid." The discriminator is the id alone.
- Callers of that test: `connection.rs:338` (pre-close marking),
  `connection.rs:566` (peer Goodbye on a route), `dispatch.rs:1378` (the second
  sweep inside `close_generation`).
- Existing check, confirmed: `routing.rs:535`
  `concurrent_generations_never_share_a_live_channel` builds `generation(1)` and
  `generation(2)` by hand (`:539-540`) and asserts channel exclusivity between
  them. It asserts nothing about minting.

## Failure scenario

No path in the current code produces a duplicate; the scenario is what a
regression would cost, and it is reachable through any change that stops routing
ids through `:245`:

1. Two ids compare equal — a hand-set id in a new construction path, a counter
   reset on reconfiguration, or `fetch_add` wrapping past `u64::MAX`.
2. The second generation's `connections.insert` at `:288` overwrites the first.
   The first `Arc<GenerationCore>` leaves the registry while its `serve_generation`
   task is still reading, so shutdown's snapshot (`runtime.rs:1151-1157`) never
   sees it and never sends it a Goodbye.
3. The first generation later reaches `close_generation`, whose
   `remove(&gen.id)` at `dispatch.rs:1386-1390` deletes the *second* generation's
   entry, and whose `begin_close_generation(gen.id)` sweep at `:1378` finalizes
   routes the second generation owns and is still dispatching on.
4. Consequence: a live generation with closed routes, terminals settling against
   the wrong connection's pending map, and a registry entry removed twice.

## Timing windows and dependencies

`fetch_add(1, SeqCst)` at `:245` is a single atomic, so there is no window in the
mint itself; the property's exposure is structural rather than temporal. The
guarantee is scoped to one incarnation because the counter is reinitialized to 1
at `runtime.rs:898` — id `1` recurs across incarnations by design, which is why
the daemon incarnation is separately fenced (Group E) rather than covered here.
Uniqueness across an incarnation depends on the `u64` not wrapping, which
`fetch_add` would do silently; at any plausible accept rate that bound is not
reachable, but it is a wrap and not a saturation. No configuration dependency.
This record is a precondition for
`at-most-one-registered-generation-per-connection` (which reasons about *which*
of a socket's two ids is registered) and for
`generation-registry-entry-released-on-every-connection-exit` (whose single
remover keys on the id).

## What a test must construct

Concurrency is the only interesting constructor, and no test in scope produces it:
every existing test hand-builds `id: 1` (fault class H1, unavailable — the tests
are current-thread while production is multi-thread). Concretely: a multi-thread
runtime, `max_connections` accepts driven in parallel, each socket completing a
non-TCP grant so both mint paths run, and an instrumented `new_generation` that
records `(observation order, id)`. The oracle is not "all ids distinct" — that is
too weak, since it passes for a non-monotonic sequence. Assert two things
separately: the multiset of minted ids has no repeat, and the sequence read under
the `connections` lock is strictly increasing. Add a negative assertion that
`connections.insert` at `:288` never returns `Some(_)`, which turns a duplicate
into a test failure at the moment of collision rather than at its consequence.
Coverage checks to emit: `host_two_generations_minted_for_one_socket` and
`host_concurrent_mints_observed`.

## Investigation log

The catalog records no open question for this record. The claim worth checking is
the one it makes about the counter's reachability.

### Q: Is `connection.rs:245` the only site that can set a generation id, and is the counter confined to one incarnation?

- Sources examined: `crates/mc-host/src/connection.rs:238-258`, `:188`, `:211`,
  `:280-289`; `crates/mc-host/src/runtime.rs:130-140`, `:890-905`;
  `crates/mc-host/src/dispatch.rs:1371-1391`;
  `crates/mc-host/src/routing.rs:218-232`; repo-wide `grep -rn "gen_counter"
  crates/` and `grep -rn "new_generation(" crates/mc-host/src/`.
- Findings: `GenerationCore` has exactly one constructor and the `id` field is
  written only at `:245`. `gen_counter` lives in `HostShared`, is created at
  `:898`, and is never reset, cloned, or read anywhere else. Nothing in the
  production path constructs a `GenerationCore` literal outside
  `new_generation`; the hand-built ids the catalog notes are all in `#[cfg(test)]`
  helpers (`routing.rs:539-540` is representative).
- Missing evidence: none for the code. What is missing is any executed proof —
  there is no instrumentation on the mint and no multi-thread test, so the
  monotonicity claim rests on reading a single `fetch_add` rather than on
  observation.
- Conclusion: resolved with answer — the mint is single-sourced and
  incarnation-scoped, so the property holds by construction today. It is
  unexercised, and the exposure is regression risk in a future second
  construction path rather than a live defect.
