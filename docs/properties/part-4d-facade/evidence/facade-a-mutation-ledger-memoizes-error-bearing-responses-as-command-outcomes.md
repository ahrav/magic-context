# facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes

## Discovery trigger

Task 2 asked whether an error path can produce a response that looks successful.
The most consequential answer is not in the response the caller reads. It is in
what the durable facade mutation ledger records: two `ctx_note` arms hand a
failure text back to the ledger as the command's successful outcome, so the
failure becomes permanent for that `command_id`.

## Evidence trail

### The two arms

`crates/mc-module/src/lib.rs`, inside `handle_ctx_note_facade`.

The `update` action's CAS conflict, `:11858-11871`:

    NoteCasOutcome::Applied(note) => facade_text_response(
        format!("Updated note #{}: {}", note.id, note.content),
        false,
    ),
    NoteCasOutcome::Conflict { .. } => Ok(facade_text_response(
        format!(
            "Error: Note #{note_id} changed concurrently; retry with a fresh read."
        ),
        true,
    )?),

The `dismiss` action's not-found, `:11896-11908`:

    Some(_) => facade_text_response(
        format!("Note #{note_id} dismissed."),
        false,
    ),
    None => facade_text_response(
        format!(
            "Error: Note #{note_id} not found in your session/project or already dismissed."
        ),
        true,
    ),

Both are the closure's return value, and both are `Ok`. `facade_text_response`
(`:15282-15288`) serialises `{content:[{type:"text",text}], isError}` to
`Vec<u8>`; its second parameter is the `isError` value. So the closure returns
`Ok(bytes_that_say_isError_true)`.

### What the ledger does with an `Ok`

`crates/mc-store/src/lib.rs:4966-5060`, `with_facade_command`.

- `:5006-5019` — if a `command_id` is supplied, the ledger is consulted FIRST:

      let stored = tx.query_row(
          "SELECT response_json
             FROM mc_facade_mutation_ledger
            WHERE identity_scope = ?1 AND tool = ?2
              AND action = ?3 AND command_id = ?4", ...)
          .optional()?;
      if let Some(response) = stored {
          return Ok(FacadeMutationOutcome::Duplicate(response));
      }

  So a hit short-circuits before the mutation closure runs at all.
- `:5022-5026` — the closure runs, and only a closure `Err` becomes a
  `rusqlite` error that aborts the transaction:

      let response = mutation(&FacadeMutationTxn { tx }).map_err(|error| {
          rusqlite::Error::ToSqlConversionFailure(...)
      })?;

- `:5027-5041` — on `Ok`, the bytes are inserted into
  `mc_facade_mutation_ledger` as `response_json`, and the transaction commits.
- `:5042-5046` — retention: "Keep only the newest 512 commands for each session
  identity", enforced by a `DELETE` following the insert.

### What the caller sees on the replay

`lib.rs:15290-15311`, `facade_command_outcome`:

- `:15295-15297` — `Applied(bytes)` becomes
  `PreparedOutcome::Response(PreparedOutput::cached_bytes(bytes))`.
- `:15298-15306` — `Duplicate(bytes)` is re-parsed, and if it is an object,
  `"replayed": true` is inserted at the top level and the object is returned.

So the replay response is
`{content:[{type:"text",text:"Error: Note #7 changed concurrently; retry with a fresh read."}], isError:true, replayed:true}`.

### The second route into the same behaviour

`:15313-15339` — `refuse_conditioned_note_without_evaluator`. Its doc comment
says:

    /// `with_facade_command` replays recorded outcomes only after this gate, so a
    /// retried command whose original mutation committed (response lost, module
    /// restarted, lease expired) must consult the durable response ledger here:
    /// the liveness gate protects first-time mutations, never replays.

It calls `store.facade_mutation_ledger_response(...)` directly (`:15326`) and, on
a hit, routes through `facade_command_outcome(Ok(Duplicate(stored)), "notes")`
(`:15329-15332`). So the refusal path also honours a memoized error response.
That comment is the clearest statement in the file that the ledger is understood
as a replay of the ORIGINAL OUTCOME, whatever it was.

### Coverage

`lib.rs:27555`, `:27668`, `:27695`, `:27734`, `:27808` are the `command_id`
idempotency tests, and all of them exercise `ctx_reduce` plus
`agent_drops.append`, not `ctx_note`. Nothing replays a `ctx_note` command whose
first attempt produced `isError: true`.

## Failure scenario

1. A model calls `ctx_note` with `action: "update"`, `note_id: 7`, new content,
   and `command_id: "c1"`. The route is authority-managed for the project so the
   vocabulary check at `:11584-11591` passes, and `command_id_from_facade_request`
   (`:15246-15280`) resolves `"c1"`.
2. Another writer updates note 7 concurrently. `update_note_cas` returns
   `NoteCasOutcome::Conflict`. The closure returns `Ok` with the conflict text
   and `isError: true`.
3. `with_facade_command` inserts those bytes into the ledger under
   `(identity_scope=session, tool="ctx_note", action="update", command_id="c1")`
   and commits.
4. The model reads "Error: Note #7 changed concurrently; retry with a fresh
   read." and does exactly that: re-reads, then retries. If its harness reuses
   the same tool-call id, `command_id_from_facade_request` resolves `"c1"` again
   from any of the seven accepted field names (`:15250-15258`).
5. `with_facade_command` finds the ledger row at `:5017` and returns
   `Duplicate` WITHOUT running the mutation. The model receives the identical
   conflict text plus `replayed: true`, forever, until the row falls out of the
   512-command retention window.

The instruction in the error text is unachievable through the path that produced
it. The `replayed` marker is a sibling of `content` in the MCP envelope, so a
programmatic reader can detect the replay, but a model reading
`content[0].text` sees an unchanging failure with no hint that the module never
re-attempted.

The `dismiss` case has a sharper edge. "Not found in your session/project or
already dismissed" is a legitimate terminal answer if the note truly does not
exist, and memoizing it is arguably correct. But the same text is returned when
the note exists and is merely not yet visible to this session, which is a state
that can change. Both cases share one memoized response.

## Timing windows and dependencies

The window is the concurrent-update race that produces `NoteCasOutcome::Conflict`.
`with_facade_command` serialises facade mutations with
`self.facade_mutation_lock` (`mc-store/src/lib.rs:4977-4980`), so two facade
mutations cannot race each other. The conflicting writer must therefore come from
another path: the note evaluation protocol's completion writes, a dreamer run, or
a `note.evaluation.complete` claim. That makes the race real but not
facade-versus-facade, which matters for how a test constructs it.

Dependencies for reachability:

- Default-production. `ctx_note` is advertised by `manifest`
  (`lib.rs:15977-15991`) through `prompt_surface::module_tools`
  (`prompt_surface.rs:160-230`) with the default preset `Full`
  (`prompt_surface.rs:112-122`). `ctx_note` does not consult `memory_enabled`, so
  the `config.rs:124` default is not a gate here.
- A `command_id` must be resolvable. If none is,
  `log_missing_facade_command_id` (`:10339-10349`) prints once and the mutation
  runs unledgered, so this property does not apply to that case. The seven
  accepted field names at `:15250-15258` include `tool_use_id`,
  `toolCallId`, and `callID`, so most harnesses supply one.
- Retention: the row must still be within the newest 512 commands for the
  identity scope (`mc-store/src/lib.rs:5042-5046`).

## What a test must construct

1. A bound, authority-managed facade route with a store and one existing note.
2. Drive `ctx_note` `update` with a `command_id`, arranging a CAS conflict. The
   cheapest arrangement is to bump the note's version through a non-facade path
   between the handler's read and its CAS; the store has commit hooks for
   exactly this kind of detector test
   (`mc-store/src/lib.rs:5279-5281` documents one such one-shot callback for the
   compartment path), so a note-path equivalent may need adding, which is a test
   support change and out of scope for this pass.
3. Assert the first response carries `isError: true`.
4. Assert a ledger row now exists for that `command_id`, by calling
   `facade_mutation_ledger_response` directly.
5. Retry the same call with the same `command_id` and NO concurrent writer, so
   the mutation would now succeed. Assert the response is not the memoized
   conflict text. That is the property.
6. Control: the same sequence with a fresh `command_id` must succeed, proving the
   underlying update is possible and step 5 failed only because of the
   memoization.
7. Simpler variant that needs no race, for the `dismiss` arm: dismiss a
   nonexistent note id with `command_id: "c2"`, then create a note with that id
   and dismiss it again with `command_id: "c2"`. Assert the second call does not
   return the memoized not-found text. Note ids are store-assigned, so this
   variant needs the id to be predictable, which
   `insert_note`'s sequence makes feasible in a fresh fixture.

## Investigation log

### Q: Should the closure return `Err` for these two arms so the transaction rolls back and nothing is ledgered?

- Sources examined: `lib.rs:11858-11871` and `:11896-11908`, the two arms;
  `lib.rs:11631-11711`, the two `write` arms, both of which return `Ok` with
  `false`; `mc-store/src/lib.rs:5022-5026`, which shows a closure `Err` becomes
  a `rusqlite::Error::ToSqlConversionFailure` and aborts the whole transaction;
  `lib.rs:15290-15311`, `facade_command_outcome`, whose `Err` arm produces
  `tool_error_result(format!("Error: {error}"))` (`:15309`);
  `lib.rs:15313-15339`, the refusal path's doc comment, which is the design
  statement about what a replay means; the other closure bodies for
  comparison, all of which use `map_err(|error| error.to_string())?` for real
  store failures (`:11667`, `:11702`) so a genuine store error already takes the
  `Err` route.
- Findings: the codebase already distinguishes the two. A store failure inside
  the closure goes `Err` and is never ledgered; a business-logic failure goes
  `Ok` and is ledgered. That looks deliberate rather than accidental, and for
  `dismiss`-not-found it is defensible: the answer is stable. For a CAS conflict
  it is not, because the conflict is by construction transient and the text says
  so. Switching the conflict arm to `Err` would change the caller-visible shape
  from an MCP result with `isError: true` to a
  `PreparedOutcome::Error{code:"..."}` with the store error's Display, which is a
  different contract for the model and may break the plugin's decoders.
- Missing evidence: whether any consumer distinguishes an MCP `isError` result
  from a typed error on this path, and whether the plugin's `ctx_note` caller
  retries with a fresh `command_id` or the same one. The latter decides whether
  the memoization is observable in production at all.
- Conclusion: needs human input. The narrow fix is to make the CAS-conflict arm
  return `Err` while leaving `dismiss`-not-found as `Ok`, which requires agreeing
  that "transient" and "stable" failures belong on different sides of the ledger
  boundary. That is a contract decision, and it changes a caller-visible response
  shape.
