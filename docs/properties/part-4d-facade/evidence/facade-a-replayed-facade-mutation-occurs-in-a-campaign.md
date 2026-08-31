# facade-a-replayed-facade-mutation-occurs-in-a-campaign

## Discovery trigger

METHOD.md requires at least one situation-coverage record so the other records
are not vacuous. Three of this lens's records depend on the durable facade
mutation ledger answering a request from a stored response rather than executing
it. That state has no marker anywhere, and a campaign that only ever sends fresh
`command_id` values would pass every assertion in those records without ever
reaching it.

## Discovery trigger, restated as the situation

The situation is: a facade mutation carrying a `command_id` commits and records a
response, and a LATER request with the same `(identity_scope, tool, action,
command_id)` is answered from that record without re-running the mutation.

## Evidence trail

### The code path

`crates/mc-store/src/lib.rs:4966-5060`, `with_facade_command`.

- `:5006-5019` — the ledger lookup runs FIRST, keyed on
  `(identity_scope, tool, action, command_id)`, and a hit returns
  `FacadeMutationOutcome::Duplicate(response)` before the mutation closure is
  ever called.
- `:5027-5041` — on a miss, the closure runs and its `Ok` bytes are inserted as
  `response_json`.
- `:5042-5046` — retention: "Keep only the newest 512 commands for each session
  identity. The command key remains unique while it is retained; old outcomes are
  intentionally forgettable because the host session has a bounded replay
  horizon." A `DELETE` enforces it.

`crates/mc-module/src/lib.rs:15290-15311`, `facade_command_outcome`:

- `:15298-15306` — the `Duplicate` arm re-parses the stored bytes and, if the
  result is an object, inserts `"replayed": true` and returns it through
  `respond`. If the bytes do not parse as JSON, or parse to a non-object, it
  returns them unchanged (`:15299-15301`, `:15306`), so the marker is not
  guaranteed.

The second, less obvious route into the same arm:

`:15313-15339` — `refuse_conditioned_note_without_evaluator` calls
`store.facade_mutation_ledger_response(identity_scope, "ctx_note", action, command_id)`
(`:15326`) and, on a hit, calls
`facade_command_outcome(Ok(FacadeMutationOutcome::Duplicate(stored)), "notes")`
(`:15329-15332`). Its doc comment (`:15313-15317`) explains why: "a retried
command whose original mutation committed (response lost, module restarted, lease
expired) must consult the durable response ledger here: the liveness gate
protects first-time mutations, never replays."

So the design anticipates three real causes of a replay: a lost response, a module
restart, and an expired evaluator lease.

### Where a `command_id` comes from

`:15246-15280` `command_id_from_facade_request` accepts seven field names, checked
on the request first and then on the arguments: `command_id`, `tool_use_id`,
`tool_call_id`, `toolCallId`, `call_id`, `callId`, `callID` (`:15250-15258`). It
trims, rejects empty (`:15271-15273`), and caps at
`MAX_AGENT_DROPS_COMMAND_ID_BYTES = 128` (`:14392`, checked at `:15274-15278`).

`ctx_note` resolves it only for mutations (`:11592-11599`) and, when it resolves
to `None`, proceeds anyway after a one-shot stderr warning
(`:11600-11602`, `log_missing_facade_command_id` at `:10339-10349`). So an
unledgered mutation is a legal outcome, which is why the situation needs a
positive marker rather than an inference from "a mutation happened".

### What is exercised today

- `lib.rs:27555`, `:27668`, `:27695`, `:27734`, `:27808` are the `command_id`
  tests. All five drive `ctx_reduce` plus `agent_drops.append`, and
  `agent_drops.append` has its own duplicate mechanism reporting
  `"duplicate": true` (`:25498-25501`), which is NOT the facade mutation ledger.
- Grepping `lib.rs:16001-30517` for `with_facade_command`,
  `FacadeMutationOutcome`, and `facade_mutation_ledger_response` is the way to
  confirm whether any inline test reaches the arm. I searched for
  `claim_intent` and `claim_effects` and found nothing; I did not run the
  `facade_mutation` search, so I record the coverage claim as unverified rather
  than asserting it.

## Failure scenario

There is no failure scenario for a coverage record. The consequence of the
situation NOT occurring is that other records pass vacuously:

- `facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes`
  asserts that a retry after a transient failure can still succeed. If no retry
  ever hits the ledger, the assertion never evaluates the branch it is about.
- The replay-distinguishability claim behind
  `facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes` contrasts
  `ctx_reduce`'s silence with the `replayed` marker other paths carry. That
  contrast is only meaningful if the marker is observed at least once.
- `refuse_conditioned_note_without_evaluator`'s entire reason to consult the
  ledger (`:15313-15317`) is unexercised, so its ordering claim, "the liveness
  gate protects first-time mutations, never replays", is untested.

## Timing windows and dependencies

The three causes the doc comment names map to three different constructions:

1. **Lost response.** The mutation commits and the response never reaches the
   caller. In-process this is simulated by discarding the first
   `PreparedOutcome` and re-issuing the same request.
2. **Module restart.** The ledger is durable in the store, so a new `McHandler`
   over the same store reaches the same rows. That construction also proves the
   ledger is not in-process state.
3. **Expired evaluator lease.** `has_live_note_evaluator` (`:11618`) flips to
   false, so a conditioned `ctx_note` write that previously committed now hits
   `refuse_conditioned_note_without_evaluator`, which finds the ledger row and
   replays the ORIGINAL SUCCESS instead of refusing. That is the most interesting
   of the three, because the replay overrides a gate that would otherwise reject.

The bound on the situation is the retention window: 512 commands per identity
scope (`mc-store/src/lib.rs:5042-5046`). A campaign that issues more than 512
distinct ledgered commands for one session before retrying will find the row
gone and get a fresh execution, so a soak-style campaign must retry inside that
horizon or the marker will not fire.

Reachability: default-production. `ctx_note` is advertised in a default build
(`manifest` at `lib.rs:15977-15991`, `prompt_surface::module_tools` at
`prompt_surface.rs:160-230`, default preset `Full` at
`prompt_surface.rs:112-122`), and nothing gates the ledger.

## What a test must construct

The marker, per METHOD.md's coverage rules. It asserts a precondition, never a
violation, and its name is a constant:

    FACADE_MUTATION_REPLAY_OBSERVED

It fires inside `facade_command_outcome`'s `Duplicate` arm
(`lib.rs:15298`) once the stored envelope has been successfully re-parsed as an
object, which is the point at which a genuine ledger replay is proven. Firing it
before the parse would also count the non-object fallback at `:15306`, which is a
different situation.

The campaign must reach it at least once. The cheapest construction:

1. A bound, authority-managed facade route with a store.
2. A `ctx_note` `write` with `command_id: "c1"` and `content`. Assert the
   response is a plain success.
3. The same call again with `command_id: "c1"`. Assert the response carries
   `"replayed": true` and that the note count did not increase, which is what
   proves the closure did not run.
4. A second construction that also exercises route 2, for the restart cause:
   drop the handler, build a new `McHandler` over the same store path, bind a
   route, and re-issue. That distinguishes durable-ledger replay from any
   in-process memo.
5. A third construction for the lease cause: commit a conditioned write with a
   live evaluator and `command_id: "c3"`, expire the evaluator registration, then
   re-issue with `command_id: "c3"`. Assert the response is the original success
   rather than the refusal at `:11624`, and that
   `FACADE_MUTATION_REPLAY_OBSERVED` fired. That case is the one the doc comment
   at `:15313-15317` exists to describe and is worth a dedicated test regardless
   of the marker.

Because this is `sometimes` rather than `reachable`, a test that constructs a
`FacadeMutationOutcome::Duplicate` value by hand and passes it to
`facade_command_outcome` does NOT satisfy it. The situation is a second real
request finding a committed first attempt, and only an end-to-end sequence
produces it.

## Investigation log

### Q: Does any existing inline test already reach the `Duplicate` arm?

- Sources examined: `lib.rs:27555`, `:27570`, `:27668`, `:27695`, `:27734`,
  `:27808`, the six `ctx_reduce`/`command_id` tests found by name;
  `lib.rs:25445-25505`, the mixed-delivery test, whose `duplicate: true`
  assertion at `:25498-25501` comes from `handle_agent_drops_value`, not from
  `facade_command_outcome`; `lib.rs:15290-15311` for the arm itself;
  `lib.rs:27570`, `ctx_reduce_no_targets_refuses_without_a_ledger_row`, whose
  name asserts the ABSENCE of a ledger row and so is evidence the suite is aware
  of the ledger.
- Findings: the `agent_drops.append` duplicate marker and the facade mutation
  ledger's `replayed` marker are two different mechanisms with similar-looking
  assertions, which makes a name-based search misleading. The one test whose name
  mentions a ledger row (`:27570`) is about its absence. I did not run an
  exhaustive search for `with_facade_command` or `FacadeMutationOutcome` inside
  the 14,000-line inline test module.
- Missing evidence: an exhaustive search of `lib.rs:16001-30517` for
  `facade_mutation`, `FacadeMutationOutcome`, `with_facade_command`, and
  `"replayed"`.
- Conclusion: unresolved, needs that search. The record's `Existing check` line
  therefore says "none that observes the arm" and names the two routes into it,
  rather than claiming zero coverage. If the search finds a test, the record stays
  and its `Exercised` field becomes `partial`, because a single happy-path replay
  does not cover the restart and lease-expiry causes.
