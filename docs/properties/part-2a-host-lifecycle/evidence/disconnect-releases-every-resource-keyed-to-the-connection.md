# disconnect-releases-every-resource-keyed-to-the-connection

Verified at `1c193ae0`. The catalog cites `d90e7811`; HEAD moved to the merge
commit `1c193ae0` and `git diff d90e7811 HEAD` is empty for `connection.rs`,
`shm_provider.rs`, `transport_provider.rs`, `runtime.rs`, and both cited test
files.

## Discovery trigger

The two arms of the promotion decision are asymmetric. The un-promoted arm reaps
explicitly — discard the sender, cancel the root, join the I/O task — and its
comment says so. The promoted arm does none of that; it delegates everything to
`serve_generation`, which is correct as long as `serve_generation` runs. But
`serve_generation` has an early return that fires *before* the read loop, and on
that path it releases nothing it was handed.

## Evidence trail

- `connection.rs:226-234`, the un-promoted arm. The comment at `:227-228` states
  the ownership rule: "The candidate never promoted: reap it here so the setup owner
  — not the provider — is what guarantees resource release." Three explicit
  releases: `handoff.sender.discard()` (`:229`), `handoff.root.cancel()` (`:230`),
  and the I/O join at `:231-233`.
- `connection.rs:208-225`, the promoted arm. It builds the promoted generation with
  the candidate's own tokens — `handoff.root.clone()` as `token` (`:213`),
  `handoff.read_cancel.clone()` as `read_cancel` (`:214`), `handoff.sender.clone()`
  as `writer` (`:215`) — then calls `serve_generation` and discards its result
  (`:217-224`). So for the promoted generation, `gen.token` **is** the candidate's
  root; there is no separate token to cancel.
- `connection.rs:279-289`, the early return. Under the `connections` lock, `:285`
  tests `shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled()`
  and `:286` `return None`. This is before the read loop is ever polled — the
  tracked future is created at `:276-278` and awaited at `:304`.
- What that return releases, by drop: `io_task` (`AbortOnDropHandle`, aborting the
  candidate I/O task), the un-polled `read_task` future, `writer_finish`
  (`:272`, a `FrameSender` clone), the `channel` receiver, and the local
  `Arc<GenerationCore>`. What it does **not** do: `gen.token.cancel()` — so
  `handoff.root` is never cancelled — `gen.writer.discard()`, and
  `writer_finish.finish()` (`:354`, unreached). Contrast `:319-320` and `:329-330`,
  the two normal retirement points, which call both.
- The documented contract the early return skips: `transport_provider.rs:76-77`
  annotates `Candidate.root` as "Candidate generation root: cancelling retires the
  candidate." That is the provider-facing promise.
- The candidate driver has its own reap on failure — `connection.rs:1192-1197`
  does `handoff.sender.discard(); handoff.root.cancel();` — which is why
  `tests/transport_negotiation.rs:1522` passes. That path is the *failed* exchange;
  a succeeded exchange takes `:1185-1191`, which deliberately touches only the
  bootstrap.
- Permits are safe on every path: `handshake_permit` is dropped at
  `connection.rs:168` and `_connection_permit` at `:169` is a `run_connection`
  local, released when the task returns regardless of which arm ran.
- Registry is safe on this path: the bootstrap's entry was already removed at
  `dispatch.rs:1390`, and the promoted generation returns at `:286` before the
  insert at `:288`, so neither id is left behind.
- Existing checks, confirmed: `tests/lifecycle.rs:1722`
  `shutdown_during_candidate_setup_reaps_both_channels` lands the drain during
  setup, so the candidate driver's own reap at `connection.rs:1192-1197` fires and
  the promoted arm is never entered. `tests/transport_negotiation.rs:1522`
  `max_connections_bounds_prepared_candidates_and_failure_releases_them` covers the
  failure path. Neither lands in the post-commit, pre-registration window.

## Failure scenario

1. A connection negotiates a non-TCP transport. `run_candidate_setup` completes the
   activate/commit exchange, stores the receiver in the promotion slot
   (`connection.rs:1186`), and retires the bootstrap (`:1189-1190`).
2. The bootstrap's `serve_generation` finishes teardown and returns the handoff
   (`:345-362`). `run_connection` takes the `Some(receiver)` branch and builds the
   promoted generation over `handoff.root` (`:211-216`).
3. A committed `host.shutdown` or a signal drives `shutdown_sequence`; `draining`
   is stored at `runtime.rs:1129`.
4. The promoted `serve_generation` reaches `connection.rs:285`, observes
   `draining`, and returns `None` at `:286`. `handoff.root` is never cancelled;
   `handoff.sender` is never discarded or finished.
5. Consequence, as the provider contract reads it: a candidate transport whose
   documented retirement signal never fired. Release then depends on whatever
   secondary termination path the provider happens to have, rather than on the
   root the contract is written against. A provider that watches only `root` — the
   one thing `transport_provider.rs:76` tells it to watch — holds its rings,
   mappings, and custody charges for the host's remaining lifetime.

## Timing windows and dependencies

The window is between the candidate driver's commit completion
(`connection.rs:1186`, after `written_rx.await` at `:1171`) and the promoted
generation's registration check at `:285`. It spans the whole of the bootstrap's
teardown — `close_generation` at `:345`, the writer join at `:361`, the handoff
unwrap at `:198-206` — so it is wide, with several awaits. Two hard dependencies.
First, a configured non-TCP provider: `transport_provider.rs:157-158` states
"`Default` (production) is empty: TCP is the implicit bootstrap transport and the
only production channel", so on a default deployment `serve_generation` returns no
handoff at `connection.rs:198` and this window does not exist. That is a material
narrowing of the catalog's "reachable in a shipped configuration" framing for
*this* record. Second, a drain landing inside it. Shares the early return at `:286`
with `at-most-one-registered-generation-per-connection`, which reasons about the
same instant from the registry side — that record's missing Goodbye and this
record's uncancelled root are two consequences of one return.

## What a test must construct

A committed shutdown landing between the candidate's commit completion and the
promoted generation's registration (fault class H1). Concretely: the `FakeProvider`
harness from `tests/lifecycle.rs:1722`, driven through a *successful* activate and
commit; a scheduling point after `connection.rs:1186` stores the receiver and
before `:285` reads `draining`; `host.shutdown` committed while the task is held
there; then release. The oracle must be per-resource, and asserted directly rather
than through a shutdown that completes:

- `handoff.root.is_cancelled()` after the connection task ends — this is the
  assertion that fails today.
- A provider-side witness that does not depend on the root: for the fake provider,
  a flag set in its release path, asserted set.
- Both permits returned: assert `handshake_permits` and `connection_permits`
  available counts are at baseline.
- `shared.connections` contains neither of the socket's two ids.
- A `Weak` to the promoted `GenerationCore` fails to upgrade.

A second test worth having with no new machinery: a fake provider whose release is
driven *only* by `root.cancelled()`, run through the ordinary non-draining promoted
path, to prove the contract is honoured when the early return does not fire. That
turns this record's hazard into a differential result. Coverage checks to emit:
`host_shutdown_landed_between_commit_and_promotion` and
`host_candidate_root_cancelled_on_every_exit`.

## Investigation log

### Q: Does any provider's release depend on root cancellation? That decides whether this leaks today.

- Sources examined: `crates/mc-host/src/transport_provider.rs:70-88` (the
  `Candidate` contract), `:150-172` (the registry and its `Default`), `:302-332`
  (`memory_candidate`, the test-only constructor);
  `crates/mc-host/src/shm_provider.rs:287-397` (`prepare`, including the worker
  thread at `:319-373` and what `Candidate.io` actually is at `:383-385`),
  `:460-544` (`run_endpoint`), `:546-620` (`receive_one`);
  `crates/mc-host/src/connection.rs:1041-1096`, `:1130-1199`, `:196-236`,
  `:263-290`; `crates/mc-host/src/config.rs:284`, `:297`;
  `crates/mc-host/src/runtime.rs:870`. Repo-wide `grep -rn "Candidate {"
  crates/mc-host/src/`, which finds exactly two constructors — `shm_provider.rs:389`
  and `transport_provider.rs:323`.
- Findings: for the only in-tree production provider the answer is **no — release
  has two independent paths that do not need the root**, so this does not leak
  today.
  - The shm provider runs its endpoint on a dedicated OS thread with its own
    current-thread runtime (`shm_provider.rs:319-322`), and `Candidate.io` is only
    `async { let _ = done_rx.await; }` (`:383-385`). So aborting the tracked I/O
    task does not stop the worker; it stops waiting for it. Release lives after
    `run_endpoint` returns, at `:364-371` (`custody.release()` or
    `report_suspect`).
  - `run_endpoint` returns on `() = root.cancelled()` (`:527`) — the contract path
    — but also when `queue.recv()` yields `None` (`:530`, all `FrameSender` clones
    dropped) and when `receive_one`'s `inbound.send` fails because the receiver was
    dropped (`:574` and `:617`, `.map_err(|_| ReadClose::Cancelled)?`, handled at
    `:489-503` where `ReadClose::Cancelled` is classed `clean` and `root.cancel()`
    is called by the worker itself at `:501`). The early return at
    `connection.rs:286` drops the `channel` receiver and, once `run_connection`
    returns, the last sender clone — so both of those fire.
  - `memory_candidate` (`transport_provider.rs:305-332`) is `#[cfg]`-free but
    documented as the only way tests construct a `Candidate`, and its `io` is the
    ordinary `TcpFrameChannel` writer, which ends on sender drop.
  - Scope narrowing that matters more than the leak: `transport_provider.rs:157-158`
    documents `TransportProviders::default()` as empty in production, and
    `config.rs:297` confirms the default. The promoted path therefore requires an
    injected provider, so today this window is reachable only under test or a
    non-default embedding.
- Missing evidence: whether any provider *outside* this repository relies on the
  root. `InjectedProvider` is a public trait and `Candidate.root` is documented as
  the retirement signal, so a conforming third-party provider that watches only the
  root would leak on this path; I cannot enumerate out-of-tree implementors.
- Conclusion: partially resolved. Resolved for in-tree providers — no leak today,
  because shm release is driven by receiver and sender drop rather than by the
  root, and the path is provider-gated in the first place. Unresolved for the
  contract: `transport_provider.rs:76` promises that cancelling the root retires the
  candidate, and the early return at `connection.rs:286` does not honour that
  promise. Whether that gap matters needs human input on whether out-of-tree
  providers exist or are supported.
