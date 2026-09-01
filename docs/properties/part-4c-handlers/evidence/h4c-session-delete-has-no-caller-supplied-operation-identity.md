# h4c-session-delete-has-no-caller-supplied-operation-identity

## Discovery trigger

Building the handler table for this lens, the Identity column filled in for every
durable handler except one. `session.recomp` takes a `command_id`
(`crates/mc-module/src/lib.rs:6005-6010`), `agent_drops.append` takes a
`command_id` (`:5783`), `state_import` takes an `import_id` (`:5639`), the
authority handlers take a generation fence, `state_sync` takes a sequence fence.
`handle_session_delete_value` (`:6126-6161`) takes nothing, and it is the most
destructive of the set.

References are to `crates/mc-module/src/lib.rs` unless stated. Verified at `HEAD`
`b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The whole handler.**

```
6126    fn handle_session_delete_value(
6127        &self,
6128        channel: RouteHandle,
6129        request: &Value,
6130    ) -> PreparedOutcome {
6131        let (session_id, binding) =
6132            match self.management_binding(channel, request, "session.delete") {
6133                Ok(scope) => scope,
6134                Err(outcome) => return outcome,
6135            };
6136        let store = match self.store() {
6137            Some(store) => store,
6138            None => return store_unavailable_error(),
6139        };
6140        match store.delete_session(&session_id, &binding.project_root.to_string_lossy()) {
6141            Ok(deleted_rows) => {
6142                self.reattaching_sessions
...
6154                respond(json!({ "ok": true, "deleted_rows": deleted_rows }))
```

Every input comes from `management_binding` or the binding. No request field is
read beyond what that helper reads.

**What `management_binding` requires.**

```
5898        if request.get("v").and_then(Value::as_u64) != Some(1) {
...
5904        let Some(session_id) = request.get("session_id").and_then(Value::as_str) else {
...
5910        if session_id.trim().is_empty() {
```

(`:5898-5915`, then a route-binding resolution at `:5916-5931`.) So the complete
input surface is `v` and `session_id`. There is no `command_id` field and no
ledger read.

**The contrast, in the same `impl` and within thirty lines.** `session.recomp`
reads a ledger row before acting:

```
6015        match store.load_recomp_command(&session_id, command_id) {
6016            Ok(Some(row)) => {
6017                return respond(json!({
6018                    "ok": true,
6019                    "disposition": row.disposition,
6020                }));
```

`agent_drops.append` gets an explicit duplicate verdict from the store:

```
5875            Ok(outcome) if outcome.duplicate => {
5876                respond(json!({ "ok": true, "queued": 0, "duplicate": true }))
5877            }
```

`state_import` preflights on its caller-supplied id:

```
5678        match store.preflight_state_import(&parsed.session_id, &parsed.import_id) {
5679            Ok(StateImportPreflight::Duplicate { imported }) => {
5680                discard(self);
5681                return respond(json!({
5682                    "ok": true,
5683                    "imported": imported,
5684                    "duplicate": true,
5685                }));
```

So three sibling handlers in the same file demonstrate the pattern that
`session.delete` omits. The omission is not a house-wide absence of the concept.

**The in-memory cleanup is unconditional on success.** `:6142-6153` removes the
session from `reattaching_sessions`, `wrapup_sessions`, and `recomp_sessions`.
Those are in-memory latches, so a repeat delivery re-removes nothing and this part
is naturally idempotent. Only the durable half is at issue.

**The response differs between deliveries.** `deleted_rows` at `:6154` is the
store's row count. A first delivery against a populated session returns a positive
number; a repeat returns zero, since the rows are gone. Both are `ok: true`.

## Failure scenario

1. A caller sends `session.delete` for `ses-42`.
2. `:6140` deletes the rows and returns, say, 17.
3. The response is lost: the transport drops it, the caller times out, or the
   module is killed after the commit and before `settle_prepared`.
4. The caller retries. There is no `command_id`, so there is no ledger to consult
   and no preflight to hit. `:6140` runs again and returns 0.
5. The caller receives `{ok: true, deleted_rows: 0}`.

The caller now cannot distinguish three states it might be in: its own first
attempt succeeded and this is the replay; the session never existed; or someone
else deleted the session between its two attempts. All three produce the identical
response.

The practical damage is bounded because delete is terminal and idempotent in
effect: nothing is destroyed twice, because there is nothing left the second time.
What is absent is the retry *contract*, not the retry *safety*.

## Timing windows and dependencies

No interleaving needed and no store fault needed. A lost response is sufficient,
and a lost response is a normal condition on any transport.

Dependency: whether `deleted_rows == 0` is intended as the duplicate marker.
Nothing documents it as one, and the reading collides with the legitimate case of
deleting a session that had no rows.

Dependency, unresolved: whether `delete_session` writes a tombstone. If it does,
a repeat could in principle be recognised. Nothing in the handler reads one, and
the store's behaviour is Part 3's scope.

## What a test must construct

- A populated session bound to a route.
  `session_delete_clears_durable_state_for_the_bound_lineage` (`:27420`) already
  builds this and performs one delete, so it is the base fixture.
- A second, identical delete request. No fault injection required; the test can
  simply call the handler twice, which is what makes this the cheapest record in
  this lens to exercise.
- Oracle: assert that the second response either equals the first or carries an
  explicit duplicate marker. On the current code neither holds, because
  `deleted_rows` differs and no marker exists. This oracle does not require
  observing corruption; it compares two responses.
- METHOD.md coverage form is unnecessary here because the property is directly
  checkable without constructing a hazardous state. The independent preconditions,
  should a coverage marker be wanted anyway, are: the session had at least one
  durable row before the first delete, and two deliveries carried identical request
  bodies.
- Per-identity effect accounting cannot be applied, which is itself the finding:
  there is no identity to key the count on. The bounds screen (observed effects at
  least acknowledged, at most attempted) can still be run per session id.

## Investigation log

### Q: Is `deleted_rows == 0` intended as the duplicate signal?

- Sources examined: `:6154` for the field; `:6140-6141` for its provenance; the
  three sibling handlers at `:5679-5685`, `:5875-5877`, and `:6015-6021`, all of
  which use an explicit `duplicate` or `disposition` field rather than a count;
  `session_delete_clears_durable_state_for_the_bound_lineage` (`:27420`).
- Findings: every sibling that reports duplication does so with a named field. If
  `deleted_rows == 0` were the intended marker, it would be the only handler using
  an implicit numeric signal, and it would be ambiguous with an empty session.
- Missing evidence: any doc comment on `handle_session_delete_value`. There is
  none; the function starts at `:6126` with no preceding comment.
- Conclusion: resolved with answer, negatively. `deleted_rows` is a result count,
  not a duplicate marker, and nothing documents it as one. The handler has no
  duplicate signal.

### Q: Is the absence deliberate because delete is idempotent in effect?

- Sources examined: the handler body; the in-memory latch removals at `:6142-6153`.
- Findings: this is the strongest defence of the current code and it is partly
  right. Deleting twice destroys nothing extra. But the caller's problem is not
  safety, it is knowing what happened, and the differing `deleted_rows` actively
  misleads: a caller that logs "deleted 0 rows" after a successful delete has
  recorded a false fact about its own operation.
- Missing evidence: whether any caller acts on `deleted_rows`. The senders are
  outside the Rust crates.
- Conclusion: unresolved on consequence, resolved on mechanism. Recorded at the
  severity the evidence supports: a missing retry contract with a misleading
  response field, not data loss.

### Q: Does `management_binding` gate this enough that an accidental repeat is unlikely?

- Sources examined: `:5892-5933`.
- Findings: it requires a live route binding matching the session. So a repeat must
  come from the same bound route, which narrows the sender set but does not prevent
  a retry after a lost response, which is the scenario at issue.
- Missing evidence: none.
- Conclusion: resolved with answer. The binding requirement does not close the
  window.
