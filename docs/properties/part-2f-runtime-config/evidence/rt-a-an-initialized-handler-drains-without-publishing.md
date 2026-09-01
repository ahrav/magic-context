# rt-a-an-initialized-handler-drains-without-publishing

## Discovery trigger

`runtime.rs:821-825` carries an unusually explicit comment about why the
post-initialization steps are grouped rather than each returning through `?`. It
names an obligation — drain the handler before the guard drops — and identifies
`AbandonGuard` as taking that duty over later. The window between those two
owners is `PrePublicationCleanup`, and I could not find a test that enters it
with initialization already successful.

## Evidence trail

The comment, `runtime.rs:821-825`:

> Initialization has run, so every early return from here must drain the handler
> before `guard` drops: a completed initialize can have opened stores or started
> handler-owned work, and only the shutdown callback stops it. `AbandonGuard`
> takes that duty over once it exists, which is why these steps are grouped
> instead of each returning through `?`.

The owner, created at `:826`:

```
let mut cleanup = PrePublicationCleanup::new(guard, handler);
```

Three entries into `finish`, all inside or immediately after the `setup` async
block at `:827-852`:

**Entry A, already-cancelled shutdown.** `:831-833`:

```
if shutdown.is_cancelled() {
    return Ok(None);
}
```

with the reason at `:828-830`: "Shutdown between initialization and publication:
nothing was published and no route work exists, so this is the graceful outcome —
the initialized handler still has to be drained." The `Ok(None)` arm at `:855-858`
calls `cleanup.finish().await` and returns `Ok(())`.

**Entry B, bind failure.** `:835-836`:

```
let setup_socket = cleanup.guard_mut().dir_path().join("setup.sock");
let listener =
    crate::setup_socket::bind_owner_only(&setup_socket).map_err(HostError::Io)?;
```

The `?` propagates out of the async block into the `Err(err)` arm at `:859-862`,
which calls `cleanup.finish().await` and returns the error.

**Entry C, publication failure.** `:840-843`:

```
cleanup
    .guard_mut()
    .publish(&setup_socket, &config.daemon_ver)
    .map_err(HostError::Instance)?;
```

Same path as B.

Note what is *not* an entry: the `Running` phase rewrite at `:847-849` discards
its result (`let _ = cleanup.guard_mut().write_lifecycle_record(..)`), with the
reason at `:845-846`: "Best effort: transport is already published, so a failed
phase rewrite must not tear down a serving host — probes then observe a fresh
`starting` record, which ages to `wedged` honestly."

`finish` itself, `:351-365`:

```
async fn finish(mut self) {
    if let Some(guard) = self.guard.as_mut() {
        guard.begin_stopping();
    }
    self.shutdown = Some(spawn_handler_shutdown(
        self.handler.take().expect("armed startup cleanup"),
    ));
    let shutdown = self.shutdown.as_mut().expect("started startup cleanup");
    let _ = shutdown.await;
    drop(self.shutdown.take());
    drop(self.guard.take());
}
```

with the phase-demotion rule at `:352-354`: "Every `finish` is a teardown: demote
the phase before the drain so probes report `stopping` rather than a stale
`starting` that would expire to `wedged` under a slow handler shutdown (protocol
§12)."

**Why this is `sometimes` and not `reachable`.** `finish` is also reached from two
earlier arms where initialization *failed*:

- `:789` — `PrePublicationCleanup::new(guard, handler).finish().await` in the
  `Ok(Ok(Err(err)))` arm, initialization returned an error.
- `:803` — same call in the `Ok(Err(join_err))` arm, initialization panicked or
  was aborted.

So a campaign that only ever fails initialization covers every line of `finish`,
`spawn_handler_shutdown` (`:320-325`), and `begin_stopping` — while never
producing the operational state the `:821-825` comment exists for, which is a
**successfully** initialized handler being drained with nothing published. That
distinction is situation coverage, not location coverage.

Two further exits from the same region are *not* this situation and are worth
separating. `:774-778` and `:812-816` call `retain_lock_until_stopped`, which is a
different owner with different semantics (unbounded detached wait, initialization
interrupted rather than complete).

## Failure scenario

The handler's `initialize` completes. It has opened a store, taken a storage
lease, and spawned component-owned work on its own tracker — exactly what
`:785-788` describes: "a composite's primary may have initialized successfully
before its secondary failed, and only the shutdown callback stops it."

Then `bind_owner_only` fails at `:836`, because a stale `setup.sock` occupies the
path from a previous incarnation that died without reaching `:935`
(`let _ = std::fs::remove_file(setup_socket)`), or because the runtime directory
lost write permission.

`finish` runs the handler's `shutdown` callback. If that callback assumes
publication occurred, or assumes at least one connection was served, or assumes
`activate` ran — and `activate` did *not* run, because `spawn_activation_task` is
at `:932`, well past this point — it can panic or misbehave. The panic is
contained by `redact_sync`/`redact` inside `spawn_handler_shutdown` (`:322-323`),
so it becomes a redacted diagnostic rather than a crash, and `finish`'s
`let _ = shutdown.await` (`:362`) discards the `JoinError`. So a shutdown-callback
panic on this path is silently swallowed and the host still returns the *bind*
error.

Consequences that follow: component-owned work may not be drained, and the
instance guard drops at `:364` regardless, releasing the single-instance fence
while that work could still be running. A successor acquiring the lock 75 ms
later (`instance.rs:674-675`) initializes the same data directory beside it.

That is the precise hazard `retain_lock_until_stopped`'s doc (`:281-290`) says the
unbounded wait exists to prevent on the *interrupted*-initialize path. `finish`
does await the callback, so it is not unbounded — but it awaits without a
deadline and discards the outcome, so a callback that never returns holds `run`
forever, and one that panics is indistinguishable from one that succeeded.

## Timing windows and dependencies

Entry A is a race with the shutdown token, checked once at `:831`. A cancellation
arriving one instruction later takes entry B or C's path, or none, and the host
publishes and proceeds to `accept_loop`, which returns immediately at
`:1021`.

Entries B and C are not races; they are I/O failures.

Ordering that matters: `begin_stopping` at `:355-357` happens *before* the drain,
so a probe during the drain sees `stopping`. On entries B and C the host was never
`Running` — `:847-849` is after the failure point in both cases — so the phase
goes `Starting` to `Stopping` without an intervening `Running`. Any probe-side
record that assumes a monotone `Starting → Running → Stopping` sequence needs to
accommodate that, and Part 2a owns the phase machine.

Dependency on `Drop`. `PrePublicationCleanup` also has a `Drop` impl
(`:375-393`) that spawns cleanup if the value is dropped while still armed, and it
reuses `self.shutdown` if `finish` already started one (`:384-386`). So the
`finish`-versus-`Drop` split is load-bearing: `finish` takes both `Option`s
(`:363-364`), leaving `Drop`'s `let Some(mut guard) = self.guard.take() else { return; }`
(`:377-379`) to short-circuit. If `finish` ever failed to take the guard, the
handler shutdown would be spawned twice. That is the field-drop-order analogue
Part 2a found, in a different type, and it is asserted nowhere.

## What a test must construct

Entry A is cheapest and needs no I/O manipulation: a handler whose `initialize`
returns `Ok` and signals the test, and a `CancellationToken` cancelled on that
signal. Then assert `run` returns `Ok(())` and that the handler's `shutdown` was
invoked exactly once while `initialize` had succeeded.

Entry B needs the `setup.sock` path inside the guard's directory to be
unbindable. A directory at that path, or a read-only parent, both work. The path
is `guard.dir_path().join("setup.sock")` (`:834`), and `data_dir` is settable, so a
test can pre-create the obstruction.

Entry C needs a connection-file write failure, which is the hardest of the three
and probably not worth building.

The marker goes inside `finish` (`:351`), carrying whether initialization had
succeeded. Semantics `sometimes`, asserting the situation occurred at least once
per campaign. The oracle at that marker asserts the independent preconditions —
initialization returned `Ok`, and no publication exists — not any consequence.

Two assertions worth adding alongside, on the same fixture:

1. The handler's `shutdown` is invoked exactly once, never twice, distinguishing
   the `finish` path from the `Drop` path.
2. `activate` was never invoked, since `spawn_activation_task` is at `:932`. That
   pins the contract a shutdown callback on this path must tolerate.

## Investigation log

### Q: is `finish` already covered by an existing test through the initialization-failure arms?

- Sources examined: `tests/handler_contract.rs`, `tests/lifecycle.rs`,
  `tests/synapse_bundle.rs:923`.
- Findings: `synapse_bundle.rs:923` asserts `Err(HostError::InitFailed(_))`, and
  `handler_contract.rs:332` and `:396` do the same. Those reach `finish` through
  `:789` — but only for configurations refused by the *gates* at `:693`-`:740`,
  which return before `PrePublicationCleanup` exists at `:826`. Let me be precise:
  the gate returns at `:694`, `:699`, `:709`, `:721`, and `:737` are plain
  `return Err(..)` with `guard` still owned locally, so they do not construct
  `PrePublicationCleanup` at all and do not run the shutdown callback.
- Missing evidence: whether any test makes `initialize` itself return `Err` or
  panic, which is what reaches `:789` or `:803`.
- Conclusion: unresolved on the exact coverage of `:789` and `:803`; resolved on
  the situation this record names. Even if a test does reach `finish` via a failed
  initialize, that is the wrong state — the record requires a *successful* one.
  This also surfaces a separate observation: the five gate returns before `:826`
  drop the guard without running the shutdown callback, which is correct because
  `initialize` has not run yet, and it is why `:821-825` marks that exact boundary.

### Q: does `finish` bound the shutdown callback?

- Sources examined: `:351-365`, `:320-325`.
- Findings: no. `let _ = shutdown.await;` at `:362` has no `timeout`. A handler
  whose `shutdown` never returns holds `run` indefinitely on this path, unlike
  `run_handler_shutdown` (`:1276`) which applies
  `lifecycle_callback_deadline`.
- Missing evidence: none.
- Conclusion: resolved with answer — unbounded, and inconsistent with the other
  shutdown-callback invocation site. Whether that is deliberate is unclear; the
  comment at `:281-290` justifies unbounded waits on the *lock*-holding paths by
  arguing a bound would release the fence beside live handler code, and the same
  argument applies here, since `finish` drops the guard at `:364`. So it is
  probably intentional and unstated.

### Q: does the `Drop` impl risk a second shutdown callback after `finish`?

- Sources examined: `:351-365`, `:375-393`.
- Findings: `finish` takes `self.shutdown` at `:363` and `self.guard` at `:364`.
  `Drop` returns early at `:377-379` when `self.guard` is `None`. Since `finish`
  consumes `self` by value, `Drop` still runs on the moved value at the end of
  `finish`, and finds `guard` already taken. So exactly one callback.
- Missing evidence: none.
- Conclusion: resolved with answer — correct today, and it depends entirely on
  `finish` taking the guard. Nothing asserts it. That is the field-drop-order
  hazard Part 2a flagged in a different type, recurring here.
