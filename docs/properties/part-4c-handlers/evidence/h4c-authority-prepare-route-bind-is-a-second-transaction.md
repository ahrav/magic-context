# h4c-authority-prepare-route-bind-is-a-second-transaction

## Discovery trigger

`handle_authority_prepare_value` looked like a clean single-transaction handler:
one match over four phases, each calling exactly one store transition
(`crates/mc-module/src/lib.rs:7186-7245`). Then the success arm at `:7246-7259`
turned out to make a second store call, and to convert its failure into an error
response after the first transition is already durable.

All references are to `crates/mc-module/src/lib.rs` unless stated. Verified at
`HEAD` `b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The identity.** `authority_request_key(request)` at `:7177` yields
`(context_store_uuid, project, domain)`. Three of the four phases add an expected
generation fence: `complete` at `:7189-7192`, `ack` at `:7217-7220`, `abort` at
`:7229-7232`. `begin` at `:7187` takes none. So repeat delivery of `complete`,
`ack`, or `abort` is caught by the generation; repeat delivery of `begin` is not
fenced at the handler.

**Phase `complete` computes one side of its own checksum.** Worth recording because
it is the contrast used in a sibling record:

```
7197                let actual =
7198                    match store.authority_seed_checksum(context_store_uuid, project, domain) {
7199                        Ok(checksum) => checksum,
...
7207                store.authority_verify_prepare(
...
7212                    expected,
7213                    &actual,
7214                )
```

`expected` comes from the request (`:7193-7196`); `actual` is computed by the
store. That is the right shape.

**The second transaction.**

```
7246        match result {
7247            Ok(row) => {
7248                if row.state == "MODULE" {
7249                    if let Err(error) =
7250                        self.bind_authority_route(&store, channel, context_store_uuid, project)
7251                    {
7252                        return PreparedOutcome::Error {
7253                            code: "authority_route_binding_failed".to_string(),
7254                            message: error.to_string(),
7255                        };
7256                    }
7257                }
7258                respond(json!({ "ok": true, "authority": row }))
```

`result` at `:7246` is already committed: every arm at `:7187-7239` is a store
transition that returned `Ok(row)`. So `:7252-7255` returns an error describing a
request whose primary effect landed.

**`bind_authority_route` is durable, not in-memory.** This is the load-bearing
check, because an in-memory second step would not be an atomicity problem:

```
4407    /// Persist the route's transport-to-identity mapping when a route becomes bound to an
4408    /// authority-managed project. Unbound administrative calls have no route vocabulary to
4409    /// record and remain valid.
4410    fn bind_authority_route(
4411        &self,
4412        store: &McStore,
4413        channel: RouteHandle,
4414        context_store_uuid: &str,
4415        project: &str,
4416    ) -> Result<(), McStoreError> {
4417        let Ok(binding) = self.facade_binding(channel) else {
4418            return Ok(());
4419        };
4420        store.bind_authority_route(
4421            context_store_uuid,
4422            project,
4423            binding.project_root.to_string_lossy().as_ref(),
4424        )
4425    }
```

`store.bind_authority_route` at `:4420` and the `Result<(), McStoreError>` return
type at `:4416` settle it: this is a store write and its failure is a store error.

**A separate non-writing path in the same function.** `:4417-4419` returns
`Ok(())` without writing when `facade_binding(channel)` fails. Unlike the guidance
case, the doc comment at `:4408-4409` states this: "Unbound administrative calls
have no route vocabulary to record and remain valid." Contract and code agree, so
this is not a contract disagreement. It matters for test construction: a fault
must target `store.bind_authority_route`, not the binding lookup, or the function
returns `Ok` and the window never opens.

## Failure scenario

1. An authority for `(uuid, project, "memories")` is mid-prepare. The coordinator
   sends `authority.prepare` with `phase: "ack"` and the generation it observed.
2. `:7221-7226` calls `authority_ack_prepare`, which commits and returns a row
   whose `state` is `"MODULE"` and whose `generation` has advanced.
3. `:7248` is entered. `:7250` calls `bind_authority_route`. The channel has a
   facade binding, so `:4417` passes and `:4420` runs.
4. `store.bind_authority_route` fails.
5. `:7252-7255` returns `authority_route_binding_failed`.
6. The coordinator sees a failure and retries `ack` with its remembered
   generation. `:7217-7226` now rejects it, because the store's generation moved at
   step 2. The coordinator has an error, no route mapping, and a generation it can
   no longer use.

Recovery requires reading `authority.status` (`:7134-7167`) out of band to discover
that the transition actually landed.

## Timing windows and dependencies

The window is `:7246` to `:7250`: one branch test and one call. It is narrow in
wall-clock terms, so a crash landing in it is unlikely; the reachable trigger is a
store error on the bind, not a kill.

No concurrency is required. This is a two-step-commit shape, not a race.

Dependency: whether a missing route mapping is self-healing. If any later bound
call rewrites the mapping, the durable damage is transient and only the caller's
generation confusion persists. Nothing in this handler establishes that, and the
answer lives in whichever call sites write the mapping; `bind_authority_route` is
the only one reached from this lens's scope.

## What a test must construct

- An authority in a state where one of the four phases returns a row with
  `state == "MODULE"`. `ack` is the natural choice.
- A channel with a working `facade_binding`, so `:4417-4419` does not short-circuit.
  Without this the test passes vacuously: the bind returns `Ok(())` and no window
  exists. This is the trap in constructing the case.
- A store fault on `bind_authority_route` only.
- Oracle, per METHOD.md's coverage rules: do not assert the divergence. Assert the
  independent preconditions, namely that the response was an error with code
  `authority_route_binding_failed` and that `authority_status` for the same key
  reports `state == "MODULE"`. Both are readable facts that do not require
  observing a broken invariant, and together they establish the split.
- A stronger direct oracle is available and cheap: snapshot `(state, generation)`
  before the request, and after any error response assert the pair is unchanged.
  That is the property statement itself and it fires on the current code.

## Investigation log

### Q: Is the route mapping recoverable without operator action?

- Sources examined: `bind_authority_route` (`:4410-4425`), its single call site in
  this scope (`:7250`), the binding-resolution group at `:4305-4425`, and
  `bind_facade_route_for_write` named in the scope map at `:10339-10480` which is
  4d's range.
- Findings: within this lens's scope `:7250` is the only caller. The scope map
  lists another route-binding-for-write helper in 4d, so a second writer may exist.
- Missing evidence: whether `bind_facade_route_for_write` or any 4d path rewrites
  the same mapping.
- Conclusion: unresolved, needs 4d's account of the facade route-binding writes.
  The atomicity split is established regardless; recoverability is not.

### Q: Should the mapping be inside the transition's transaction?

- Sources examined: the four transition calls at `:7187-7239`, all of which take
  `(context_store_uuid, project, domain)` but not the route root; `:4423` where the
  route root comes from the channel's binding, which the store transition never
  sees.
- Findings: the transition functions have no parameter for the route root, so
  folding the mapping into them is a signature change, not a reordering. That is a
  design decision with a cost, not an obvious oversight.
- Missing evidence: whether the mapping is required for correctness or only for
  convenience of later lookups.
- Conclusion: needs human input.

### Q: Is `begin` without a generation fence a separate defect?

- Sources examined: `:7187` versus `:7189-7192`, `:7217-7220`, `:7229-7232`.
- Findings: `begin` is the only phase with no expected generation. Whether a
  repeated `begin` is idempotent depends on `authority_begin_prepare`, which this
  lens did not read.
- Missing evidence: `authority_begin_prepare`'s body in `mc-store`.
- Conclusion: unresolved, needs `mc-store`. Recorded here as an observation on the
  identity column of the handler table rather than promoted to its own record,
  because I could not establish an effect.
