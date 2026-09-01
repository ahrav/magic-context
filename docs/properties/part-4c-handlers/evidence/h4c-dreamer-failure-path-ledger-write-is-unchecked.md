# h4c-dreamer-failure-path-ledger-write-is-unchecked

## Discovery trigger

`handle_dreamer_run_task` writes its ledger row twice, on two different exits, and
handles the result differently each time. The success path at
`crates/mc-module/src/lib.rs:10016` matches the result, orders a purge after
durability, and carries three comment blocks reasoning about exactly this. The
failure path at `:9989`, twenty-seven lines earlier, binds the same call to `let _`.

References are to `crates/mc-module/src/lib.rs` unless stated. Verified at `HEAD`
`b5dc778e`; `mc-module` is unchanged between `76cd6f41` and `b5dc778e`.

## Evidence trail

**The identity, validated before anything happens.**

```
9626        let Some(command_id) = request.get("command_id").and_then(Value::as_str) else {
9627            return invalid_params_error("dreamer.run_task requires command_id");
9628        };
9629        if command_id.trim().is_empty() || command_id.len() > 256 {
9630            return invalid_params_error("dreamer.run_task command_id must be 1-256 bytes");
9631        }
```

Plus a capability boundary on the task name, with the reasoning stated:

```
9621        if task != CLASSIFY_TASK {
9622            // Enumerating the task here is a capability boundary: callers cannot use this
9623            // route to select an arbitrary system prompt, model, or tool-enabled run.
9624            return invalid_params_error(format!("unknown dreamer task {task:?}"));
9625        }
```

And a generation fence on the authority:

```
9690        if authority.generation != authority_generation {
9691            return PreparedOutcome::Error {
9692                code: "authority_generation_mismatch".to_string(),
```

So validation precedes every effect, including the external model call. This handler
has the strongest input gate in the lens's scope.

**The failure path's unchecked write.**

```
9983        if output.is_none() {
9984            let response = json!({
9985                "ok": false,
9986                "code": "dreamer_run_failed",
9987                "message": if last_error.is_empty() { "classify producer has no usable model" } else { &last_error },
9988            });
9989            let _ = store.record_dream_task_command(
9990                &ledger_session,
9991                command_id,
9992                &response.to_string(),
9993                now_ms(),
9994            );
9995            return PreparedOutcome::Error {
9996                code: "dreamer_run_failed".to_string(),
9997                message: last_error,
9998            };
9999        }
```

Note that the handler *builds a response object* at `:9984-9988` specifically to
store as the command's recorded outcome, then discards whether the store accepted
it. The intent to record is unambiguous; only the result is dropped.

**The success path's checked write, with its reasoning.**

```
10016        match store.record_dream_task_command(
10017            &ledger_session,
10018            command_id,
10019            &response.to_string(),
10020            now_ms(),
10021        ) {
10022            Ok(recorded) => {
10023                // Purge only after the response is durable. A purge failure
10024                // here cannot fail the command — the recorded response is
10025                // already the command's outcome (any retry replays it) —
10026                // and the leftover session stays bounded by host terminal
10027                // retention.
10028                let _ = producer.purge_session(&child_session).await;
10029                replay_dream_task_response(&recorded.response_json)
10030            }
10031            // The completed session is left alive deliberately: with no
10032            // ledger row, a retry derives the same child session and can
10033            // recover the completed run instead of hitting a deletion
10034            // tombstone.
10035            Err(error) => PreparedOutcome::Error {
10036                code: "dreamer_ledger_failed".to_string(),
10037                message: error.to_string(),
10038            },
10039        }
10040    }
```

Three things here matter for the record. First, the distinct error code
`dreamer_ledger_failed` at `:10036`, which the failure path does not have: it
returns `dreamer_run_failed` at `:9996` whether or not the ledger write worked, so
the two conditions are indistinguishable to the caller. Second, the parenthetical
at `:10025`, "any retry replays it", states the ledger's purpose explicitly: it is
the replay contract. Third, `:10031-10034` shows the author thought about what a
*missing* ledger row means for a retry, and chose to leave the child session alive
so the retry can recover it. That reasoning is precisely what is absent at `:9989`.

**The replay mechanism, and the comment that makes this record decisive.** The
handler reads the ledger before it starts any producer run:

```
9816        // A ledger read failure must not look like "no record": replaying a
9817        // command whose durable response exists would start a second
9818        // billable run, so the read fails closed and the caller retries.
9819        match store.load_dream_task_command(&ledger_session, command_id) {
9820            Ok(Some(recorded)) => return replay_dream_task_response(&recorded.response_json),
9821            Ok(None) => {}
9822            Err(error) => {
9823                return PreparedOutcome::Error {
9824                    code: "dreamer_ledger_failed".to_string(),
9825                    message: error.to_string(),
9826                }
9827            }
9828        }
```

The producer is only constructed afterwards, at `:9848-9857`, and started at
`:9878`. So `:9819` is the replay guard for the whole billable run.

The comment at `:9816-9818` is the strongest single piece of evidence on this
record. The authors state the exact consequence of a missing ledger row: "replaying
a command whose durable response exists would start a second billable run". They
then make the *read* fail closed on error (`:9822-9827`) so that a read failure
cannot be mistaken for an absent row. The failure-path *write* at `:9989` is the
other half of that same protection, and it does not fail at all: its result is
discarded, so a write failure is indistinguishable from a write success and the
next delivery finds no row at `:9819`.

**The store makes the row write-once.**

```
6947                "INSERT OR IGNORE INTO mc_dream_task_commands
6948                     (session_id, command_id, response_json, created_at)
6949                 VALUES (?1, ?2, ?3, ?4)",
```

followed by an unconditional `SELECT` of the row
(`crates/mc-store/src/lib.rs:6945-6964`). `INSERT OR IGNORE` then read-back means a
second call with the same `(session_id, command_id)` returns the *first* recorded
response. So the ledger is correctly write-once and replay-stable once a row
exists. The only gap is the path that fails to create one.

## Failure scenario

1. A `dreamer.run_task` arrives with `command_id = "dream-3"`, a valid
   `authority_generation`, and a well-formed payload.
2. The authority checks at `:9684-9698` pass.
3. The classify run executes. Every candidate model fails, so `output.is_none()` at
   `:9983` is true. `last_error` holds the reason.
4. `:9989` attempts to record the failure response. The store write fails.
5. `:9995-9998` returns `dreamer_run_failed` with `last_error` as the message. The
   caller cannot tell that the ledger write also failed, because the success path's
   distinct code `dreamer_ledger_failed` (`:10036`) is not used here.
6. The caller retries `dream-3`. The replay guard at `:9819` finds no row and falls
   through at `:9821`. The handler walks the authority checks again, constructs a
   producer at `:9848`, and starts a second billable run at `:9878`.

Step 6 is the consequence the code's own comment at `:9816-9818` names: "a second
billable run". That comment is why this record is high confidence rather than
speculative. The authors identified the hazard, hardened the read against it by
failing closed at `:9822-9827`, and left the write that populates the row
unchecked.

The cost is what separates this handler from every other in this lens: the repeated
effect is an external, paid model call and another child session, not a local store
mutation.

Note the asymmetry in how the two ledger-write failures are reported. On the
success path a failed write yields `dreamer_ledger_failed` (`:10036`), a distinct
code that tells the caller the run happened but was not recorded. On the failure
path a failed write yields `dreamer_run_failed` (`:9996`), the same code as a
successful record, so the caller cannot distinguish "recorded as failed, do not
retry" from "not recorded, retry will re-run".

## Timing windows and dependencies

No interleaving. The `let _` is unconditional on the failure path.

Dependency: whether the store's `record_dream_task_command` can realistically fail
at that moment. If it shares a connection with the reads that already succeeded at
`:9638`, `:9653`, and `:9669`, the failure requires a store-level fault such as a
disk error or a lock timeout rather than a misconfiguration.

Dependency: whether the caller retries at all on `dreamer_run_failed`. The handler
returns the same code for "the models failed" and "the models failed and I could
not record it", so a sender that retries on that code retries in both cases and a
sender that does not, retries in neither.

## What a test must construct

- A route with a `memories` authority in `MODULE` state at a known generation, so
  the gate at `:9638-9698` passes. The four existing `dreamer_run_task_*` tests
  (`:25872`, `:25899`, `:25931`, `:25977`) plus the `dreamer_classify_outcome`
  helper at `:25798` already build this.
- A classify producer whose every model fails, so `output.is_none()` at `:9983`
  holds. `dreamer_run_task_requires_a_positive_timeout_ms` (`:25977`) suggests the
  fixture can control producer behaviour.
- A store fault on `record_dream_task_command`.
- Oracle: after any terminal `dreamer.run_task` response, assert a ledger row exists
  for `(ledger_session, command_id)`. This is the property statement and it is a
  direct read; it does not require observing a double model call.
- Coverage form for the preconditions, per METHOD.md: assert independently that the
  response code was `dreamer_run_failed` and that the classify run reached the
  `output.is_none()` branch. Both hold on a correct implementation.
- The stronger and cheaper oracle is a call counter on the producer: for one
  `command_id`, count model invocations across two deliveries and assert at most one.
  METHOD.md's effect accounting applies with the model call as the effect: observed
  invocations at least the acknowledged count, at most the attempted count, and the
  per-identity count is the primary oracle.

## Investigation log

### Q: Is the `let _` at `:9989` deliberate?

- Sources examined: `:9983-9999` for the failure path; `:10016-10039` for the
  success path with its three comments; `:10023-10027` and `:10031-10034`
  specifically; `record_no_fire`'s documented discard at `:5321-5322` and `:5335` as
  the house pattern for a deliberate drop.
- Findings: this file documents deliberate discards when they are deliberate.
  `record_no_fire` says "A CAS conflict just drops the diagnostic; it must never fail
  a pass". The dreamer success path devotes five lines to why a purge failure cannot
  fail the command and four more to why a missing ledger row means the child session
  must be left alive. Against that background, an undocumented `let _` on the same
  store call twenty-seven lines earlier reads as an oversight. But an absent comment
  is not proof, and there is a coherent alternative reading: a failed run has no
  useful output, so perhaps recording it is best-effort by design.
- Missing evidence: author intent. The two readings differ on whether a recorded
  `ok: false` response is meant to make the failure terminal. The fact that `:9984-9988`
  builds a full response object for storage argues it is, since a best-effort
  breadcrumb would not need the response shape.
- Conclusion: needs human input. Leaning toward oversight on the strength of
  `:9984-9988` constructing a replay-shaped response, and recorded as contract-vs-code
  lead L4 in the lens with both sides cited.

### Q: Does a recorded failure response actually stop a retry from re-running the model?

- Sources examined: the early ledger read at `:9819-9828` and its comment at
  `:9816-9818`; the producer construction at `:9848-9857` and start at `:9878`, both
  after that read; `record_dream_task_command` in the store at
  `crates/mc-store/src/lib.rs:6938-6965`; `load_dream_task_command` at
  `crates/mc-store/src/lib.rs:6914`.
- Findings: resolved in the affirmative, and more strongly than I first assumed. The
  handler *does* read the ledger before any billable work, at `:9819`, and returns the
  recorded response on a hit. The store's write is `INSERT OR IGNORE` followed by an
  unconditional read-back (`crates/mc-store/src/lib.rs:6947-6963`), so the row is
  write-once and a replay serves the first recorded response. The comment at
  `:9816-9818` states the hazard in the authors' own words: a missing row means "a
  second billable run". The read is deliberately hardened against that by failing
  closed on a read error (`:9822-9827`).
- Missing evidence: none. This question is closed.
- Conclusion: resolved with answer. The replay contract is real, complete, and
  documented, which makes the unchecked write at `:9989` a hole in a protection the
  authors built deliberately rather than a gap in a protection that never existed.
  This raises the record's confidence to high and removes the possibility, which I
  had left open, that the handler has no replay at all.
