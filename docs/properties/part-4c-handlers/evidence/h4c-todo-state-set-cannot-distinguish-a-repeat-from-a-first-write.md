# h4c-todo-state-set-cannot-distinguish-a-repeat-from-a-first-write

## Discovery trigger

The lens's second task asks, per handler, whether a repeat is distinguishable from
a first delivery. `handle_todo_state_set_value`
(`crates/mc-module/src/lib.rs:5935-5974`) collapses both of the store's outcome
variants into one response literal, and the discarded variant carries a
`row_version` the caller could have used.

References are to `crates/mc-module/src/lib.rs` unless the store is named.
Verified at `HEAD` `b5dc778e`; `mc-module` is unchanged between `76cd6f41` and
`b5dc778e`.

## Evidence trail

**The collapse.**

```
5965        match store.set_todo_state(&session_id, &normalized, owner_message_id, &state_hash) {
5966            Ok(TodoStateSetOutcome::Updated { .. }) | Ok(TodoStateSetOutcome::Noop) => {
5967                respond(json!({ "ok": true }))
5968            }
5969            Err(error) => PreparedOutcome::Error {
5970                code: "store_write_failed".to_string(),
5971                message: error.to_string(),
5972            },
5973        }
```

The `..` in `Updated { .. }` at `:5966` is where the `row_version` is dropped.

**What the store distinguishes.**

```
2738    pub enum TodoStateSetOutcome {
2739        Updated { row_version: u64 },
2740        Noop,
2741    }
```

(`crates/mc-store/src/lib.rs:2738-2741`.)

**The `Noop` predicate is a genuine content-keyed match.** This is the check that
keeps this record at low severity:

```
6737            if loaded.meta.last_todo_state_owner_message_id.as_deref() == Some(owner_message_id)
6738                && loaded.meta.last_todo_state_hash.as_deref() == Some(state_hash)
...
6740                return Ok(TodoStateSetOutcome::Noop);
```

(`crates/mc-store/src/lib.rs:6737-6740`.) Both the owner and the hash must match.
A different owner with the same content, or the same owner with different content,
takes the update path at `:6744-6748`. So `Noop` cannot mask a lost write.

**The identity is content-derived, not caller-supplied.** The handler computes it:

```
5957        let Some(normalized) = crate::injection::normalize_todo_state_json(state_json) else {
5958            return invalid_params_error("state_json must be a JSON todo array");
5959        };
5960        let state_hash = sha256_hex(normalized.as_bytes());
```

Normalisation at `:5957` before hashing at `:5960` is the right order: it means two
semantically identical todo arrays with different whitespace or key order produce
the same hash and so the same `Noop`. Validation precedes the write, as it does
across this lens's scope.

**Validation ordering, for the record's fourth task.** `management_binding` runs
first (`:5940-5944`), then `state_json` presence (`:5945-5947`), then the 1 MiB cap
(`:5948-5950`), then `owner_message_id` presence and its 1..=128 byte bound
(`:5951-5956`), then normalisation (`:5957`), and only then the store call at
`:5965`. No partial state is possible from an invalid input because nothing is
written until every check passes.

**The existing test locks in the current shape.**

```
27192        assert_eq!(
27193            call_dispatch_request(&handler, todo.clone()).await,
27194            json!({ "ok": true })
27195        );
```

then, after checking the stored owner and hash at `:27197-27201`:

```
27203            call_dispatch_request(&handler, todo).await,
27204            json!({ "ok": true })
27205        );
27206
```

and

```
27208        assert_eq!(store.load("ses").unwrap().row_version, first_version);
```

The test is `management_todo_flush_and_recomp_contracts_are_replay_safe` at
`:27182`. It asserts the response is byte-identical on the repeat and that
`row_version` did not move, which proves the no-op is real and simultaneously makes
the collapsed response the de facto written contract.

## Failure scenario

There is no data-loss scenario, and saying so plainly is more useful than
inventing one. The consequence is informational:

1. A caller sets a todo state for `owner_message_id = "m1"`.
2. `:5966` returns `{ok: true}`. The caller does not learn the new `row_version`.
3. The caller retries after a lost response. `:5966` returns `{ok: true}` again.
4. The caller cannot tell whether its first attempt landed, and has no
   `row_version` from either call to use as a local fence for a later
   read-modify-write.

A second, sharper case: a caller believes it is writing a *new* state but its
normalised content happens to equal the stored one for the same owner. The store
returns `Noop`, the caller sees `{ok: true}`, and it concludes its write was
applied as new. Because the content is identical the durable state is what the
caller wanted, so this remains informational.

## Timing windows and dependencies

None. No fault, no interleaving, no clock. The gap is visible on the second
delivery of any identical request.

Dependency: none on `mc-store` beyond the two facts quoted above, both of which
were read directly.

## What a test must construct

- Two identical `todo_state.set` requests. `:27182` already does exactly this, so
  the construction cost is zero; what changes is the assertion.
- Oracle: assert the two responses are distinguishable, either by a `duplicate` or
  `updated` boolean or by the presence of `row_version` on the first. Note that
  adopting this oracle requires *editing* `:27192-27206`, which currently asserts
  the opposite. Per METHOD.md this record does not fix anything, but a synthesis
  pass should know that the existing test and the proposed property are in direct
  conflict.
- No coverage-check form is needed; nothing hazardous has to be constructed.
- The cheapest useful strengthening is narrower than a contract change: assert that
  the store returned `Updated` on the first call and `Noop` on the second, at the
  store boundary rather than through the handler. That proves the store's
  distinction exists without committing to a response-shape change, and it is a
  strictly additive assertion.

## Investigation log

### Q: Is the collapsed response a deliberate contract?

- Sources examined: the handler at `:5935-5974` for any doc comment, of which there
  is none; the test at `:27182-27208`; the three sibling handlers that do report
  duplication, at `:5679-5685`, `:5875-5877`, and `:6015-6021`.
- Findings: the test asserts `json!({ "ok": true })` exactly, twice. An exact-match
  assertion on a whole response object is a strong statement that the shape is
  intended, stronger than a field-by-field check would be. Against that, three
  siblings in the same file expose duplication explicitly, so the house style is not
  to collapse.
- Missing evidence: whether the consuming sender needs the distinction. That sender
  is outside the Rust crates.
- Conclusion: needs human input. The test is evidence of intent about the *shape*;
  it is not evidence that the collapse was weighed against the siblings' pattern.
  Recorded as a contract-vs-code lead (L6 in the lens) on the grounds that the only
  written contract is an assertion in a test CI does not run.

### Q: Can `Noop` ever mask a write that should have happened?

- Sources examined: `crates/mc-store/src/lib.rs:6737-6740` for the predicate,
  `:6744-6748` for the update path.
- Findings: the predicate is a conjunction over owner and hash. Any difference in
  either falls through to the update. The hash is over the *normalised* content
  (module `:5957-5960`), so formatting differences collapse correctly rather than
  causing spurious updates.
- Missing evidence: none.
- Conclusion: resolved with answer, negatively. `Noop` is a true content-keyed
  no-op. This is why the record is severity-low and why I have not claimed a
  correctness defect.

### Q: Does the discarded `row_version` matter to any caller?

- Sources examined: `TodoStateSetOutcome::Updated { row_version }` at store
  `:2739`; the handler's `..` at module `:5966`; the response at `:5967`.
- Findings: other handlers in this scope do return a version-like value to the
  caller, for example `apply_state_sync_wire` returns `row_version` at `:9296`. So
  the field is considered caller-relevant elsewhere in the same file.
- Missing evidence: whether the todo sender performs any read-modify-write that
  would need a fence.
- Conclusion: unresolved, needs the sender. The asymmetry with `:9296` is recorded
  as the supporting observation.
