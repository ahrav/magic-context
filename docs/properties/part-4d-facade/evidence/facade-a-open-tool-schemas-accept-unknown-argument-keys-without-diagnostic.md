# facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic

## Discovery trigger

The task asked explicitly whether an unknown or malformed request field is
rejected or silently ignored, because silent acceptance is a recurring finding
in this repo. The answer here is unusual: silent acceptance is not an oversight.
It is the declared contract, asserted by an existing test, and the finding is
what that costs.

## Evidence trail

Runtime decode, `crates/mc-module/src/lib.rs`

- `:14416-14435` — `facade_arguments`. It fetches `request["arguments"]`, checks
  it is an object, and returns `Some(arguments.clone())`. There is no key walk
  and no allow list. The only conditional logic is the reduced-envelope unwrap
  (covered by a separate record).
- `:14437-14481` — `string_arg`, `non_empty_string_arg`, `i64_arg`,
  `usize_arg`. Each is `args.get(key).and_then(...)`. A key the handler never
  names is never observed.
- `:10487`, `:10595`, `:10704`, `:10766`, `:11552` — the five `ctx_*` handlers
  call `facade_arguments` with only their primary-field hints. The hints steer
  the unwrap decision; they are not a schema.

Advertised schemas, same file:

- `:15790-15924` `ctx_memory_schema`, root `"additionalProperties": true` at
  `:15846`. Two nested objects are closed: `mutation_token` at `:15793` and the
  anti-memory arm at `:15829`.
- `:15926-15948` `ctx_search_schema`, `"additionalProperties": true` at
  `:15929`.
- `:15948-15958` `ctx_expand_schema`, `"additionalProperties": true` at
  `:15950`.
- `:15960-15975` `ctx_note_schema`, `"additionalProperties": true` at `:15963`.

The schemas reach the model through `manifest` (`:15977-15991`) calling
`prompt_surface::module_tools` (`prompt_surface.rs:160-230`).

The contrasting tier, in the same file:

- `:13882-13905` — `note_evaluation_body`. Doc comment: "Closed-schema decode
  for the flat note.evaluation.* bodies: unknown fields are rejected before any
  waiter or store allocation". The loop at `:13894-13900` errors with
  `unknown field '{key}'` for any key outside `method`, `kind`, and the caller's
  allow list, and `:13901-13903` requires `v == 2`.
- `mc-core/src/claim_operation.rs:313,352,360,406,417,438,450,460,468,475` —
  ten `deny_unknown_fields` structs, used by the three claim-intent handlers
  through `serde_json::from_value` (`lib.rs:10090`, `:10127`, `:10160`).
- `lib.rs:140` and `:147` — `ClaimMirrorSnapshotRequest` and
  `ClaimMirrorReceiptRequest`, both `deny_unknown_fields`.

The intent is explicit in the test suite:

- `:25632-25641` — for every advertised tool except `ctx_reduce`:

      assert_ne!(
          tool.schema.get("additionalProperties"),
          Some(&json!(false)),
          "{name} must preserve compatibility arguments"
      );

  So openness is pinned as a requirement, not tolerated as a default.
- `:25652-25653` — the same test asserts `reduced` and `summary` are absent from
  every advertised schema, so two argument keys the module does read are
  deliberately undeclared.

## Failure scenario

There is no crash and no wrong write. The failure is informational, and it has
two shapes.

First, a caller cannot distinguish honoured from ignored. A model that emits
`{"action":"write","content":"...","importance":90}` on `ctx_note` receives
"Saved session note #7." with `isError: false`. The `importance` key was
dropped by `facade_arguments`' clone-and-never-read path. Nothing in the response
says so.

Second, a near-miss key silently changes semantics rather than merely being
ignored. That case is sharp enough to warrant its own record; see
[facade-a-misspelled-surface-condition-silently-writes-a-plain-note.md](facade-a-misspelled-surface-condition-silently-writes-a-plain-note.md).

The `ctx_reduce` exception makes the inconsistency concrete. Its advertised
schema is closed (`prompt_surface.rs:197-204`, with the comment at `:195-196`
calling the shape "the Thalamus authorization contract"), yet the handler reads
`memory_project` through `resolve_facade_scope` (`lib.rs:10502`) and the inline
test supplies `command_id` (`lib.rs:25472`, in a call at `:25466-25470`), neither
of which the closed schema permits. So the one tool that advertises a closed
schema accepts at least two keys the schema forbids, and the module still never
rejects them.

## Timing windows and dependencies

None. This is a pure function of one request body.

The dependency worth naming is the advertisement path: the model sees the schema
from `manifest`, and the default `PromptSurfaceSelection` preset is `Full`
(`prompt_surface.rs:112-122`), so all six tools including the four open-schema
ones are advertised in a default build. Config default `memory_enabled: true`
(`config.rs:124`) means the `ctx_memory` gate at `lib.rs:10608-10610` is open by
default too.

## What a test must construct

1. Bind a facade route and install a store.
2. For each of `ctx_memory`, `ctx_search`, `ctx_expand`, `ctx_note`, call the
   handler twice with identical valid arguments, the second time with one extra
   key drawn from outside the handler's read set, and assert the two
   `PreparedOutcome::Response` bodies are byte-identical after normalising any
   id or timestamp the handler mints.
3. A stronger form: derive the read set mechanically. For each tool, take the
   advertised schema's `properties` keys as the declared set, take the keys the
   handler actually reads as the observed set, and assert the two agree. That
   test would currently fail on `ctx_note` (`memory_project` is declared and
   read, `command_id` is read and undeclared) and on `ctx_reduce`, which is the
   useful signal.
4. A negative control for the closed tier: call a `note.evaluation.*` method
   with one extra key and assert `bad_request` with `unknown field`. That proves
   the test is measuring a real difference between the two surfaces rather than
   a property of the test harness.

## Investigation log

### Q: `ctx_reduce`'s advertised schema is closed yet the handler accepts `command_id` and the reduced envelope. Which side is the contract?

- Sources examined: `prompt_surface.rs:188-205`, the whole `ctx_reduce` `Tool`
  including the comment at `:195-196`; `lib.rs:10482-10588`, the handler, for
  every key it reads; `lib.rs:10502`, the `resolve_facade_scope` call that reads
  `memory_project`; `lib.rs:25445-25500`, the existing test, which supplies
  `command_id` and asserts the acknowledgement text; `lib.rs:25636-25641`, the
  manifest test's explicit `ctx_reduce` exemption; `lib.rs:14419-14435`, the
  unwrap path reached from `:10487`.
- Findings: the comment at `prompt_surface.rs:195-196` says "This exact
  advertised shape is the Thalamus authorization contract. Prompt-surface
  selection may replace only the top-level description." That is a strong claim
  about the advertised shape being load-bearing for authorization somewhere
  outside this crate. The handler nevertheless reads two keys the shape forbids,
  and one of them, `command_id`, it reads only to ignore: `handle_ctx_reduce_facade`
  contains no `command_id_from_facade_request` call, so the key is accepted by
  `facade_arguments`, never consulted, and honoured later by
  `handle_agent_drops_value` on the delivery leg (`lib.rs:25486-25501`).
- Missing evidence: what "Thalamus" validates the advertised shape against, and
  whether an authorization layer outside this repository rejects a `ctx_reduce`
  call carrying `command_id`. I found no Thalamus code or config in this tree.
- Conclusion: needs human input. If the advertised closed shape is enforced
  upstream, then `command_id` on `ctx_reduce` is unreachable in production and
  the inline test at `:25445` exercises a shape production cannot send. If it is
  not enforced, the schema is wrong. Either way one of the two must change, and
  the choice depends on a system outside this repository.
