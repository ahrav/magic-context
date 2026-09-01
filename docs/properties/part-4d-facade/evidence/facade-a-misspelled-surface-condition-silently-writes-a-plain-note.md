# facade-a-misspelled-surface-condition-silently-writes-a-plain-note

## Discovery trigger

Following the open-schema finding into a concrete consequence. The question was
whether any ignored argument key changes behaviour rather than merely being
dropped. `ctx_note`'s `surface_condition` is the case where it does, and the
resulting response reports success for an operation the module would otherwise
have refused.

## Evidence trail

`crates/mc-module/src/lib.rs`, all inside `handle_ctx_note_facade`
(`:11547-11916`).

- `:11552` — `facade_arguments(request, &["action", "content"])`. Open map, no
  key validation.
- `:11556-11563` — five `validate_string_cap` calls, one of them for
  `surface_condition` with `MAX_SHORT_FIELD_BYTES`. `validate_string_cap`
  (`:14403-14414`) is `if let Some(value) = args.get(key).and_then(Value::as_str)`
  — an absent key is `Ok(())`. So the cap check is silent on absence, correctly,
  but it is also the only place the key name appears before it is read.
- `:11564-11566` — action resolution:

      let action = string_arg(args, "action")
          .or_else(|| non_empty_string_arg(args, "content").map(|_| "write"))
          .unwrap_or("read");

  With `content` present and no explicit `action`, the action is `write`.
- `:11615-11617` — condition extraction:

      let condition = string_arg(args, "surface_condition")
          .map(str::trim)
          .filter(|value| !value.is_empty());

  A misspelled key yields `None` here, indistinguishably from an absent key.
- `:11618-11626` — the gate:

      if condition.is_some() && !self.has_live_note_evaluator(project, now) {
          return refuse_conditioned_note_without_evaluator(...)

  with the refusal text at `:11624`: "Error: Smart-note evaluation is
  unavailable for this Rust-authority project; the note was not written."
  The gate is `condition.is_some()`-guarded, so `None` skips it entirely.
- `:11631` — `if let Some(condition) = condition`. The smart-note branch
  (`:11631-11678`) calls `insert_project_note` with
  `surface_condition: Some(condition)` (`:11650`) and answers with the text at
  `:11669-11672`, which names the condition back to the caller.
- `:11679-11711` — the else branch calls `insert_note` with
  `surface_condition: None` (`:11698`) and answers
  `format!("Saved session note #{}.", note.id)` (`:11704`) with
  `is_error = false` (`:11705`).

The advertised schema declares the key:

- `:15960-15975` — `ctx_note_schema` lists `surface_condition` in `properties`
  with `maxLength: 4096` and the description "Optional externally checkable
  condition to record with the note. Evaluation arrives later." The root is
  `"additionalProperties": true` (`:15963`), so a near-miss spelling is a legal
  argument as far as the advertised schema is concerned.
- `:15786-15788` — `ctx_note_description` tells the model "surface_condition is
  accepted and recorded, but condition evaluation arrives later on this leg."

So the model is told the key is accepted and recorded, the schema permits any
neighbouring key, and the handler treats a near-miss as absence.

## Failure scenario

The evaluator is not live for the project, which is the state the refusal at
`:11624` exists to handle. A model emits:

    {"name":"ctx_note","arguments":{
       "action":"write",
       "content":"Ping the migration owner",
       "surfaceCondition":"the migration branch merges"}}

`string_arg(args, "surface_condition")` returns `None`. The gate at `:11618` is
skipped. The else branch at `:11679` writes an ordinary session note through
`insert_note` with `surface_condition: None`, and the response is
`{"content":[{"type":"text","text":"Saved session note #7."}],"isError":false}`.

The model asked for a note that fires when a condition holds and got a note that
never fires, reported as a plain success. Had it spelled the key correctly it
would have received an explicit refusal saying the note was not written. The
misspelling converts a refusal into a silent semantic downgrade, which is
strictly worse than either correct outcome.

The mirror case matters too: with a live evaluator, the correctly spelled key
takes the smart-note branch and the response text at `:11669-11672` echoes the
condition. So a caller comparing the two responses can tell them apart. Without
a live evaluator there is no such signal, because the plain branch's text
(`:11704`) is the same text a caller who never asked for a condition receives.

## Timing windows and dependencies

There is no interleaving window in the argument handling. There is a state
dependency that decides how bad the outcome is:

- With `has_live_note_evaluator(project, now)` true (`:11618`, registry at
  `:3828-3976`, 4c's range), a correctly spelled condition is recorded and a
  misspelled one is dropped. The failure is a lost condition and a response that
  does not mention one.
- With it false, a correctly spelled condition is refused outright, and a
  misspelled one is accepted. The failure is a refusal converted to a success.

`has_live_note_evaluator` depends on registration expiry, so the same request can
take different branches minutes apart. That makes the state a genuine campaign
requirement rather than a fixed configuration.

## What a test must construct

1. A bound facade route with a store, and no live note-evaluator registration
   for the project. `refuse_conditioned_note_without_evaluator` (`:15318-15339`)
   consults the mutation ledger first, so the command must carry either no
   `command_id` or an unseen one, otherwise the refusal is replaced by a replay.
2. Call `ctx_note` with `action: "write"`, non-empty `content`, and
   `surfaceCondition` (camelCase) set.
3. Assert the response is not a plain-success "Saved session note" with
   `isError: false`. Either the refusal text at `:11624` or a
   `bad_request`-style rejection naming the unknown key is acceptable; the
   assertion is that the outcome is not indistinguishable from an
   unconditioned write.
4. Positive control: the same call with `surface_condition` spelled correctly
   must produce the refusal, proving the gate is reachable in the test's state.
5. Negative control: the same call with neither key must produce the plain
   success, proving the test is not simply asserting that all writes fail.
6. A generalised form: for each key in `ctx_note_schema`'s `properties`, generate
   the camelCase and hyphenated variants and assert none of them produces a
   different durable outcome than the correctly spelled key without also
   producing a different response. That covers `note_id`, `compiled_provider`,
   `compile_status`, and `filter` in one pass.

## Investigation log

### Q: Is there any other near-miss key on this handler with the same shape?

- Sources examined: `lib.rs:11547-11916` in full; `note_condition_compile_args`
  (`:14451-14475`); the `filter` match (`:11716-11734`); the `note_id`
  extraction for `update` and `dismiss` (`:11878-11882` for dismiss).
- Findings: three distinct behaviours coexist on the same handler.
  `filter` rejects an unrecognised VALUE with an explicit error listing the legal
  values (`:11730-11733`), so a wrong value is caught while a wrong key name is
  not. `note_id` absence is caught for `dismiss` with "Error: 'note_id' is
  required when action is 'dismiss'." (`:11879-11881`), so absence is
  distinguished from presence there. `compile_status` rejects an unrecognised
  value (`:14461-14468`) but the whole compile group is optional and
  `note_condition_compile_args` returns `Ok(None)` when all four keys are absent
  (`:14458-14460`), so a misspelled `compile_status` silently drops the compile
  metadata exactly as a misspelled `surface_condition` drops the condition.
  `action` itself falls back to `read` when misspelled and `content` is absent
  (`:11566`), which turns a misspelled mutation into a read.
- Missing evidence: none needed for the record. The pattern is consistent: this
  handler validates values where it reads them and never validates key names.
- Conclusion: resolved. `surface_condition` is the sharpest case because it is
  the only one where a correctly spelled key can produce an explicit refusal, so
  the misspelling changes the outcome class rather than only the recorded
  fields. `compile_status` and `action` have the same shape with milder
  consequences and belong in the same test's generalised form.
