# admission-freeze-precedes-the-shutdown-commit

## Discovery trigger

A happens-before lens over the advertised stop point: `host.shutdown` answers
success, so the host has promised it stopped admitting. Ask which store makes
that true, and whether it precedes the cancellation the response is correlated
with. Following `draining` backwards shows it is written by the shutdown
*sequence*, not by the commit, and the sequence runs strictly later.

## Evidence trail

- The repaired defect is `0fe5eba1`, "fix(mc-host): freeze admission at the
  shutdown commit point" (2026-08-22, `connection.rs` +6/-1, `dispatch.rs`
  +10/-2). Its message states the shape: the committed response cancels the
  shutdown token, but `draining` is stored later, so a request pipelined behind
  that response could reach routed dispatch or `route.open` and start new handler
  work after the advertised admission-cancellation point.
- The window is structural, not incidental. `crates/mc-host/src/runtime.rs:910-911`
  runs `accept_loop(...).await` and only then `shutdown_sequence(...)`; the accept
  loop returns solely on `shared.shutdown.cancelled()` (`runtime.rs:996`). So the
  freeze at `runtime.rs:1127-1130` — the `draining` store and
  `registry.freeze_admission()` — cannot execute until after the token is already
  cancelled. `shutdown_sequence` itself begins at `runtime.rs:1119`; the catalog's
  `~1127` cites the freeze block, not the function.
- Before the repair, the three gates read `draining` alone. The diff replaces each
  with a two-term read. Current sites: `crates/mc-host/src/connection.rs:285`
  (generation registration, comment at `:281-284`),
  `crates/mc-host/src/dispatch.rs:821` (routed dispatch, comment at `:817-820`),
  and `dispatch.rs:1089` (`open_route`, comment at `:1087-1088`). Each reads
  `shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled()`.
  **Verified: the registration gate reads both terms.**
- A companion commit `86913952`, "fix(mc-host): report server_busy when the
  shutdown fence wins registration", added a fourth two-term read at
  `dispatch.rs:1062` so a registration refused by the freeze reports
  `server_busy` rather than `unknown_channel`. `git blame -L 1056,1063` attributes
  it to that commit, not to `0fe5eba1`.
- The authoritative fence is the registry flag, not the atomic:
  `crates/mc-host/src/routing.rs:209-211` is `freeze_admission`, setting
  `accepting = false` under the registry lock, and `routing.rs:294-307` is
  `register_dispatch`, returning `None` when `!inner.accepting` under that same
  lock. The comment at `:301-304` says the shared lock is what makes the fence
  atomic with the freeze.
- The commit-point ordering is `dispatch.rs:729-731`, in that order:
  `draining.store(true, SeqCst)`, `registry.freeze_admission()`, then
  `commit.acknowledge()`. The comment at `:723-728` states the requirement.
- **The freeze is the caller's duty, unenforced by the type.**
  `crates/mc-host/src/lifecycle.rs:1274-1283` is `CommitOnAck::new`, taking only a
  latch and a `CancellationToken`; `:1285-1289` is `acknowledge`, which does
  exactly `latch.commit()` then `shutdown.cancel()`. No registry handle exists in
  the struct (`:1267-1271`), so nothing in the type system prevents a second
  construction site from cancelling without freezing. `dispatch.rs:731` is the
  only production `acknowledge()` call in the crate.

## Failure scenario

1. An authenticated client sends `host.shutdown`. The owner enqueues the
   committing response and its hook.
2. In a hypothetical hook that cancelled before freezing — or on the
   pre-`0fe5eba1` code, where the freeze was only in `shutdown_sequence` —
   `shutdown.cancel()` runs while `accepting` is still true and `draining` is
   still false.
3. A socket already accepted at `runtime.rs:1017-1019` authenticates
   (`connection.rs:148-160`), takes a connection permit (`:165`), and reaches the
   registration gate at `:285`. Reading `draining` alone it sees `false` and
   inserts at `:288`.
4. That generation then opens a route or dispatches, `register_dispatch` still
   has `accepting == true`, and handler work begins after the host answered that
   it had stopped admitting. The current two-term read refuses at step 3 instead.

## Timing windows and dependencies

Two windows exist and only one is closed by the hook's internal order. Inside the
hook, `:729-731` makes the freeze precede the cancellation, so a dispatch that
passed the flag checks earlier still meets a frozen registry. The other window
belongs to every *other* token cancellation: `runtime.rs:84` (fatal trip),
`runtime.rs:424` (`AbandonGuard::drop`), and `runtime.rs:1189` (inside the
sequence, after the drain). Those cancel without freezing, and the freeze arrives
only at `runtime.rs:1127-1130` after the accept loop unwinds. For those paths the
guarantee rests entirely on the token term added by `0fe5eba1`. Reaching a
violation needs a socket accepted and authenticated inside that window, which
requires multi-thread scheduling (fault class H1). The four in-crate latch tests
cannot observe any of it: `CommitOnAck` has no registry, so they exercise the
latch and the token but never `accepting`.

## What a test must construct

A running host with a live registry, one authenticated `host.shutdown`, and a
second connection whose accept lands before the commit and whose authentication
completes after it. Assert that the second connection registers no generation —
observable as no `route.open` succeeding and no handler invocation — and that any
routed frame it sends is refused with `server_busy`. Separately, assert the
ordering directly: at the moment `shared.shutdown.is_cancelled()` first observes
true, `registry` admission is already frozen. A registry-visible probe or a
test-only observer on `freeze_admission` is needed, because the effect is
otherwise only inferable from a refusal. A negative case should hold a dispatch
task suspended between `dispatch.rs:821` and `register_dispatch`, then commit,
and assert the registration is refused at `routing.rs:305`.

## Investigation log

### Q: (the catalog records none) Does any path cancel the shutdown token without an accompanying freeze?

- Sources examined: `runtime.rs:78-88`, `:419-430`, `:910-911`, `:996`,
  `:1119-1130`, `:1189`, `lifecycle.rs:1285-1289`, and every
  `shared.shutdown.cancel()` site in `crates/mc-host/src/`.
- Findings: yes, three. The fatal trip at `runtime.rs:84`, `AbandonGuard::drop` at
  `:424`, and the post-drain cancel at `:1189` all cancel without freezing.
  Only the first two matter, and for both the freeze follows once the accept loop
  returns and `shutdown_sequence` reaches `:1127-1130`. The guarantee as worded —
  "at the instant the commit cancels the shutdown token, registry admission is
  already frozen" — is about the latch commit, and it holds; the broader claim
  that a cancelled token always implies a frozen registry does not.
- Missing evidence: no comment ties the fatal and abandon paths to the same fence
  argument, and no test covers a fatal trip racing a registration.
- Conclusion: resolved for the commit path, and it narrows the property. The gates
  read the token precisely because cancellation and freezing are not simultaneous
  on the non-commit paths.
