# Part 4d Lens A: the facade surface and response assembly

One attention focus: the boundary where a caller request enters `McHandler` and
where a response is assembled, and what that boundary validates, guarantees, and
leaks. A sibling lens owns note evaluation (`smart_note_evaluation.rs`, the
`note.evaluation.*` protocol at `lib.rs:10880-11481`, and note delivery at
`lib.rs:11483-11545`); this lens touches those only as validation contrast.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md). Scope and region map from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md).

Scope consumed, all six units of sub-part 4d: `src/lib.rs:10042-11917`,
`src/lib.rs:11919-16001`, `src/dispatch.rs` (whole), `src/memory_tool.rs`
(whole), `src/project_docs.rs` (whole), and `src/smart_note_evaluation.rs` read
only for the validation-strictness comparison. `src/lib.rs:16001-30517` was read
as evidence for existing checks. Every line reference below was read back at
`HEAD` individually; the two corrections found are noted inline.

## Facade map

### There is exactly one entry point and three routing surfaces below it

`CompositeComponent::handle` (`lib.rs:11963-11997`) is the only request entry.
It does four things in a fixed order before any handler sees the body:

1. `enforce_request_byte_cap(ctx.body.as_slice())` (`:11964`, defined at
   `:14375-14391`). Bodies at or under 1 MiB
   (`MAX_FACADE_FRAME_BYTES`, `:14279`) pass. A larger body is re-probed with
   `RequestMethodProbe` (`:14289-14305`) and admitted up to 32 MiB
   (`MAX_TRANSFORM_FRAME_BYTES`, `:14284`) only if the probe calls it
   transform-class.
2. `value_footprint_bound(ctx.body.as_slice())` (`:11979`, defined at
   `:14329-14357`) counts an upper bound on the `serde_json::Value` tree the
   body will occupy, by classifying every byte as inside or outside a string.
3. `ctx.try_reserve_resident(footprint)` (`:11982`). The charge is taken
   BEFORE `from_slice`, and the two refusal arms are distinguished: above the
   host ceiling is permanent (`request_too_large_error`, `:14360-14365`, code
   `invalid_params`), below it but currently unavailable is retryable
   (`resident_capacity_error`, `:14368-14373`, code `queue_full`).
4. `serde_json::from_slice::<Value>(...).unwrap_or(Value::Null)` (`:11991`).
   A body that is not valid JSON becomes `Value::Null` rather than an error
   here; it fails later in `unrecognized_request_error` with the
   `non-object JSON (null)` branch (`:12368`).

So the only checks that are genuinely uniform across every request are the byte
cap and the resident charge. Everything past that is per-surface.

`dispatch_value_with_inbound_bytes` (`:12239-12323`) then picks one of three
surfaces:

| Surface | Discriminator | Validation strictness |
| --- | --- | --- |
| Flat method body | `method`, else `kind` (`:12245-12248`) | Per-handler; `note.evaluation.*` alone uses a closed schema |
| MCP facade envelope | `name` AND `arguments` both present (`:12319`) | Open schema; `facade_arguments` clones and never rejects |
| Neither | falls through | `unrecognized_request_error` (`:12322`) |

The precedence is `method`/`kind` first, unconditionally. A body carrying both a
`kind` and a facade `name` routes on `kind` and the `name` is ignored; the
existing test
`facade_flat_envelope_precedence_keeps_kind_arm_and_gates_ctx_reduce_name`
(`:25299-25323`) asserts exactly that with `{kind:"echo", name:"ctx_memory"}`.

### The facade envelope routes eleven names, not two

`handle_facade_value` (`:10042-10060`) routes: `ctx_memory`, `ctx_search`,
`ctx_expand`, `ctx_reduce`, `ctx_note`, and six claim commands
(`claim.intent.stage`, `claim.intent.inspect`, `claim.intent.ack`,
`claim.effects.apply`, `claim.mirror.replace`, `claim.mirror.apply`). Anything
else falls to `unrecognized_request_error` (`:10058`).

### What each facade handler validates, in the order it validates it

| Handler | Route/scope gate | Argument decode | Field validation |
| --- | --- | --- | --- |
| `handle_ctx_reduce_facade` `:10482-10588` | `resolve_facade_scope` AFTER parsing `drop` (`:10493`, `:10501`) | `facade_arguments(request, &["drop"])` `:10487` | `parse_tag_range_string` `:10493`; nothing else |
| `handle_ctx_memory_facade` `:10590-10697` | `resolve_facade_scope` `:10601`; `dreamer_run_registered` for `list` `:10626` | `facade_arguments(request, &["action"])` `:10595` | claim-id shape `:10656-10661`; 1..=20 count `:10651`; `limit` clamp `:10667` |
| `handle_ctx_search_facade` `:10699-10759` | `resolve_facade_scope` `:10715` | `facade_arguments(request, &["query"])` `:10704` | non-empty `query` `:10708`; `MAX_QUERY_BYTES` `:10711`; `limit` clamp `:10714` |
| `handle_ctx_expand_facade` `:10761-10878` | `resolve_facade_scope` `:10770` | `facade_arguments(request, &["message","start"])` `:10766` | ordinal signs and order `:10823`; span and row caps `:10840-10847` |
| `handle_ctx_note_facade` `:11547-11916` | `resolve_facade_scope` `:11568`; vocabulary recheck for mutations `:11584-11591` | `facade_arguments(request, &["action","content"])` `:11552` | five string caps `:11556-11563`; `filter` enum `:11730`; `command_id` `:11592-11599` |
| `handle_claim_intent_stage` `:10082-10113` | `claim_route_root` `:10083`, and the root is PASSED to the store `:10123` (correction: the call is at `:10100`) | typed `serde_json::from_value` `:10090` | protocol and encoding version in `memory_tool` `:115-121` |
| `handle_claim_intent_inspect` `:10115-10151` | `claim_route_root` called and DISCARDED `:10120-10122` | typed `from_value` `:10127` | protocol version and `limit` 1..=10000 (`memory_tool.rs:140-145`) |
| `handle_claim_intent_ack` `:10153-10182` | `claim_route_root` called and DISCARDED `:10154-10156` | typed `from_value` `:10160` | protocol version (`memory_tool.rs:166`) |
| `handle_claim_effects_apply` `:10184-10255` | `claim_route_root` called and DISCARDED `:10185-10187` | hand-rolled `Map` walk `:10188` | protocol version `:10191`; consumer non-empty `:10198`; receipt/result cross-check `:10205-10250` |
| `handle_claim_mirror_replace` `:10257-10297` | `facade_binding` presence only `:10262` | typed `from_value` `:10271` | protocol version `:10273` |
| `handle_claim_mirror_apply` `:10299-10337` | `facade_binding` presence only `:10300` | typed `from_value` `:10309` | protocol version `:10311` (Part 3 owns receipt semantics) |

`resolve_facade_scope` (`:10387-10480`) is the real scope authority for the five
`ctx_*` tools: it resolves the conversation key (with the OpenCode
provenance bypass at `:10406-10409`), optionally binds the authority route for
writes (`:10434-10438`), and rejects a `memory_project` argument that disagrees
with the route's authority-managed project (`:10446-10454`). The six claim
handlers do not use it at all.

**Validation is not uniform.** Three independent strictness tiers coexist:

- Closed schema, unknown field rejected: `note_evaluation_body`
  (`:13885-13905`) walks every key and errors on anything outside its allow
  list, and requires `v == 2`. This is the only runtime closed-schema decode
  on any surface.
- Typed decode with `deny_unknown_fields`: the claim wire structs
  (`mc-core/src/claim_operation.rs:313,352,360,406,417,438,450,460,468,475`)
  and the two mirror request structs (`lib.rs:140`, `:147`).
- Open map clone, unknown field ignored: `facade_arguments` (`:14419-14435`)
  for all five `ctx_*` tools. The advertised schemas match that openness
  deliberately: `additionalProperties: true` at `:15846` (`ctx_memory`),
  `:15929` (`ctx_search`), `:15950` (`ctx_expand`), `:15963` (`ctx_note`).

## Response assembly map

### Three settlement shapes, one of which never occurs in production

`PreparedOutcome` (`dispatch.rs:206-210`) has `Response`, `Error`, and
`Streamed`. `settle_prepared_with` (`lib.rs:12150-12205`) maps them to
`PreparedSettlement`, and `settle_prepared` (`:12207-12222`) maps that to
`RequestOutcome`. Assembly order for a `Response`:

1. `output.measure()` (`:12168`). Counts the exact encoded length without
   retaining the bytes, capping as it counts (`dispatch.rs:141-157`,
   `330-346`, `352-357`). Failure becomes `code: "encode_failed"`.
2. cancellation check (`:12177`), then `reserve(measured.len())` (`:12183`),
   then a second cancellation check (`:12192`).
3. `measured.write_to(&mut body)` (`:12198`). `BoundedWriter`
   (`dispatch.rs:469-511`) refuses a write past the measured length, and
   `write_to` compares `written != self.len` and returns
   `LengthMismatch` (`dispatch.rs:270-277`).

`PreparedOutcome::Streamed` is never constructed in production: the only
occurrences are the two `matches!` discriminations at `lib.rs:9089` and `:9539`,
the settlement arm at `:12164`, an inline test at `:16132`, and
`tests/prepared_output.rs:109`. So `PreparedSettlement::Streamed` and
`RequestOutcome::Streamed` (`:12220`) are dormant arms.

### Fields that are always present

There is no single response envelope. Three families:

- MCP tool results, from `mcp_text_result` (`:13791-13796`): always exactly
  `content: [{type:"text", text}]` and `isError`. `tool_error_result`
  (`:13798-13800`) is `mcp_text_result(msg, true)`. `facade_text_response`
  (`:15282-15288`) produces the same two fields as bytes for the ledger.
- Typed errors, `PreparedOutcome::Error`: always `code` and `message`.
- Ad-hoc `respond(json!({...}))` bodies (`:13467-13469`), whose field set is
  per-handler. Examples in scope: `:10251-10254` (claim effects),
  `:10289-10294` (mirror replace), `:10327-10334` (mirror apply).

### The error path CAN produce a response that looks successful, in four ways

1. **`isError` lives inside a successful transport response.** Every
   `tool_error_result` is a `PreparedOutcome::Response` carrying `isError:
   true`. Assembly never inspects it. The one place that could act on it,
   the dispatch wedge detector, explicitly does not:
   `ticket.finish(matches!(outcome, PreparedOutcome::Error { .. }))`
   (`:7993`, 4c's range) counts only typed errors, and the facade never takes
   a ticket at all. `health()` (`:12003-12046`) therefore reports
   `HealthStatus::Ok` while every facade call fails, because
   `DispatchHealth::report` only degrades on staleness, never on
   `consecutive_errors` (`:403-407`, `:418-421`).
2. **Success without writing, `ctx_reduce`.** `handle_ctx_reduce_facade`
   returns `mcp_text_result(format!("Queued: {}.", ...), false)` (`:10587`)
   after the comment at `:10585-10586` states it "deliberately does not
   mutate" durable state. `isError` is false and no field distinguishes an
   acknowledgement from a delivery.
3. **Success without writing, `claim.effects.apply`.** `:10184-10255` never
   calls `self.store()`. It validates and returns `ackedEffectId` (`:10253`).
4. **An error text recorded as the command's durable success.** Two arms in
   `handle_ctx_note_facade` return `Ok(facade_text_response(..., true))` from
   inside the `with_facade_command` closure: the note CAS conflict
   (`:11865-11870`) and dismiss-not-found (`:11902-11907`). `Ok` is the
   ledger's commit signal (`mc-store/src/lib.rs:5022-5041`), so the failure
   text becomes the command's memoized outcome.

### Replay IS distinguishable, on three of four paths

`facade_command_outcome` (`:15290-15311`) inserts `"replayed": true` into a
`Duplicate` envelope (`:15303`). `stage_claim_intent` and
`acknowledge_claim_intent` return `replayed` from the store outcome
(`memory_tool.rs:131`, `:177`). `claim.mirror.apply` returns `replayed`
(`:10331`). `ctx_reduce` returns nothing of the kind, and neither does
`claim.effects.apply`.

## Observations

- `lib.rs:12344-12351`. The doc comment on `unrecognized_request_error` says
  "Only ctx_memory and ctx_search are accepted on that surface". The router at
  `:10046-10058` accepts eleven names. Stale doc, and it is the only prose
  statement of the facade's admitted name set.
- `lib.rs:12352-12362`. A body with an unknown `method` plus a valid facade
  `name`/`arguments` pair returns `code: "facade_envelope_not_supported"` with
  a message blaming the tool name, when the actual fault was the `method`
  field. The two-code design at `:12344-12351` is defeated for that shape.
- `lib.rs:14298-14304`. `RequestMethodProbe::is_transform_class` checks
  `kind == "transform"` OR `method == "state_sync"`. The router at
  `:12245-12248` accepts either field for either name. The shipped transform
  sender sets both (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1336-1337`),
  which is why the asymmetry is latent rather than live.
- `lib.rs:14419-14435`. `facade_arguments` has a second mode: when no primary
  field is present and `arguments.reduced == true`, it parses
  `arguments.summary` as JSON and, if that yields an object, uses it as the
  whole argument map. Model-authored text becomes the argument object. The
  TypeScript side has a hardened equivalent
  (`packages/plugin/src/tools/unwrap-imitated-reduced-args.ts:1-60`) with
  per-field rules and an undeclared-field rejection; the Rust side has none.
- `lib.rs:11564-11566`. `ctx_note`'s action defaults to `write` when `content`
  is non-empty and to `read` otherwise. A misspelled `surface_condition` key is
  dropped by `string_arg` (`:11615`), which skips the live-evaluator gate at
  `:11618` and takes the plain-note branch at `:11679-11711`, answering
  "Saved session note #N." with `isError: false`.
- `lib.rs:11592-11602`. A mutation with no recoverable `command_id` is accepted
  anyway; `log_missing_facade_command_id` (`:10339-10349`) prints once per
  session to stderr and the mutation proceeds unledgered. The message itself
  says "accepting for transport compatibility" (`:10346`).
- `lib.rs:10450` and `:11589`. Two facade error paths format an absolute
  `route_project_root` into caller-visible text: the vocabulary-mismatch error
  built in the module, and `McStoreError::FacadeProjectVocabularyMismatch`
  rendered through `tool_error_result` (Display at
  `mc-store/src/lib.rs:3509-3512`).
- `dispatch.rs:81-88`, `:192-203`, `:212-224`. All three `Debug` impls print
  only lengths and a source-kind tag; `PreparedOutcome::Error` prints
  `code_len` and `message_len`, never the strings. This is a real
  no-content-in-diagnostics discipline, and it is the opposite of the earlier
  parts' finding: here `Debug` is the redactor. The leak is on the response
  path, not the diagnostic path.
- `lib.rs:10068-10080` versus `:10120`, `:10154`, `:10185`. The doc comment
  says "Every claim handler must go through this" because "the bound route is
  the only trustworthy authority identity on the request". Only
  `handle_claim_intent_stage` uses the returned root (`:10100`); the other
  three discard it and pass only the caller-supplied `binding`.
- `mc-store/src/lib.rs:11140-11158`. `list_claim_intents` has no project,
  producer, or route predicate. `claim.intent.inspect` from any bound facade
  route can therefore read up to 10,000 intent rows, including each row's
  `result_json` (`memory_tool.rs:99-107`), across every project in the store.
- `project_docs.rs:59-75`. The header at `:10-11` claims the read-time
  re-check "close[s] the TOCTOU gap". The code re-runs `symlink_metadata`
  (`:69`) and then calls `fs::read_to_string` (`:73`), which follows symlinks.
  The window between `:70` and `:73` is narrowed, not closed. The comment at
  `:67-68` restates the closure claim.
- `lib.rs:13366-13381`. `respond_transform` has the guard the facade lacks:
  two conditions convert a nominally successful `TransformResponse` into a
  typed error. The transform lane refuses to look successful when it omitted
  content; no facade handler does the equivalent.
- `lib.rs:16044-16200`. `settle_prepared_with` has inline coverage at six call
  sites. `tests/prepared_output.rs` re-implements the settlement loop by hand
  (`:181-196`) instead of calling it, because the function is private.
- No inline test in `lib.rs:16001-30517` mentions `claim_intent` or
  `claim_effects`. The four claim-command facade handlers at `:10082-10255`
  have zero module-side coverage; the store side is covered by
  `crates/mc-store/tests/claim_intent_ledger.rs`, which CI does not run.

## Candidate properties

### facade-a-transform-class-byte-cap-probe-diverges-from-the-router

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test sends an over-1-MiB body whose class field
disagrees with the probe's field choice.
Guarantee: A body admitted under the 32 MiB transform ceiling is one the router
will route to the transform lane, and a body refused at the 1 MiB facade
ceiling is one the router would not have routed to the transform lane.
Check: `always` — for every body over `MAX_FACADE_FRAME_BYTES`, assert
`enforce_request_byte_cap` admits it if and only if
`dispatch_value_with_inbound_bytes` would select the `"transform"` or
`"state_sync"` arm for the same body. `always` because the cap runs on every
request and both sides are computable from the body alone.
Fault/timing angle: none. Pure input classification.
Required faults and enabling state: a body over 1 MiB carrying
`method: "transform"` without `kind`, or `kind: "state_sync"` without `method`.
Confidence: high — [evidence](../evidence/facade-a-transform-class-byte-cap-probe-diverges-from-the-router.md).
Verified `is_transform_class` reads `kind` for transform and `method` for
state_sync (`lib.rs:14298-14304`), verified the router accepts either field
(`:12245-12248`), and verified the shipped transform sender sets both
(`rust-mode-transform.ts:1336-1337`) while `module-state-sync.ts:1167` sets
only `method`.
Existing check: none for the disagreement. `lib.rs:25299-25323` covers field
precedence but only for a small body.
Impact: a large transform body from a caller that sets only `method` is refused
with "request body exceeds the 1 MiB limit", which names the wrong limit and
tells the caller nothing about the field it omitted.
Open questions:
- Is the field split deliberate, encoding that `state_sync` is method-only and
  `transform` is kind-primary, or an artifact of the two senders being written
  at different times? (needs human input)

### facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:25632-25641` asserts the open schema is
intentional for four tools, but no test asserts what happens to an unknown key
at runtime.
Guarantee: An argument key that no `ctx_*` handler reads never changes the
handler's behaviour and never produces a caller-visible diagnostic.
Check: `always` — for every `ctx_*` call, assert that adding an argument key
outside the handler's read set produces a byte-identical response to the call
without it. `always` rather than `unreachable` because the acceptance is a
state of the returned value, not a forbidden code point.
Fault/timing angle: none.
Required faults and enabling state: none. Any facade call with a spare key.
Confidence: high — [evidence](../evidence/facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic.md).
Verified `facade_arguments` clones the map with no key walk (`:14419-14435`),
verified all four advertised schemas set `additionalProperties: true`
(`:15846`, `:15929`, `:15950`, `:15963`), and verified the inline test at
`:25636-25641` asserts every tool except `ctx_reduce` "must preserve
compatibility arguments".
Existing check: `lib.rs:25632-25641`, status `unaudited`. It asserts the schema
shape, not the runtime consequence. Does not run in CI.
Impact: silent acceptance is the documented intent, so the risk is not the
acceptance but the absence of any signal: a caller cannot distinguish "the
module honoured my field" from "the module never looked at it".
Open questions:
- `ctx_reduce`'s advertised schema is closed (`prompt_surface.rs:197-204`) yet
  the handler accepts `command_id` and the `reduced`/`summary` envelope, none
  of which the schema permits. Which side is the contract? (needs human input)

### facade-a-misspelled-surface-condition-silently-writes-a-plain-note

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test writes a note with a near-miss condition key.
Guarantee: A `ctx_note` write that the caller intended as conditioned either
records the condition or refuses; it never reports plain-note success.
Check: `always` — assert that for every `ctx_note` write whose arguments
contain any key differing from `surface_condition` only by case, separator, or
a single edit, the response is not a plain `isError: false` "Saved session note
#N." `always` because it must hold on every write evaluated.
Fault/timing angle: none, but the enabling state matters: with no live
evaluator, the correctly spelled key refuses, so the misspelling converts a
refusal into a success.
Required faults and enabling state: a `ctx_note` write carrying
`surfaceCondition` (or similar) and non-empty `content`, with
`has_live_note_evaluator(project, now)` false.
Confidence: high — [evidence](../evidence/facade-a-misspelled-surface-condition-silently-writes-a-plain-note.md).
Traced `string_arg` returning `None` (`:11615`), the gate skipped (`:11618`),
the plain branch taken (`:11679-11711`), and the response text at `:11704`.
Existing check: none. `:11556-11563` caps the correctly named key's length but
never asserts presence.
Impact: the model asks for a note that fires on a condition and gets a note
that never fires, with a success message. The refusal text at `:11624` exists
precisely to prevent that outcome and is bypassed.
Open questions: None.

### facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no inline test drives the unwrap branch.
Guarantee: When `facade_arguments` unwraps a `reduced`/`summary` envelope, the
resulting argument map is subject to every validation the direct argument map
would have been subject to.
Check: `always-or-unreached` — assert that for every `ctx_*` handler, a call
whose real arguments are `A` and a call whose arguments are
`{reduced: true, summary: to_string(A)}` produce identical outcomes, including
identical cap rejections. `always-or-unreached` because the unwrap branch may
never run when the TypeScript side already unwrapped.
Fault/timing angle: none.
Required faults and enabling state: `arguments.reduced == true`, no primary
field of that tool present, and `arguments.summary` a string that parses to a
JSON object.
Confidence: medium — [evidence](../evidence/facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source.md).
Verified the branch and its guards (`:14421-14434`) and verified the hardened
TypeScript analogue exists
(`packages/plugin/src/tools/unwrap-imitated-reduced-args.ts:1-60`,
`:36-40`). Medium because I did not establish whether the plugin ever forwards
an un-unwrapped envelope to the module in a shipped configuration.
Existing check: none found on the Rust side.
Impact: the unwrapped map bypasses nothing structurally, but it is the one
place where the argument object's provenance is model text rather than the
harness, and no cap or shape check is applied to `summary` before parsing.
Open questions:
- Does the shipped plugin always unwrap before the module sees the body, making
  the Rust branch dead defence in depth? Unresolved, needs a trace of
  `unwrap-imitated-reduced-args` call sites against the module send path.

### facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:25445-25500` asserts the no-write behaviour and
the later delivery, so the behaviour is pinned; nothing asserts the
caller-visible ambiguity.
Guarantee: The number of drops actually queued for a session is at least the
number the response observer acknowledged as delivered and at most the number
`ctx_reduce` reported as "Queued".
Check: `always` — per session id, assert
`acknowledged_queued <= observed_pending_drops <= ctx_reduce_reported_queued`,
and separately assert that no `ctx_reduce` response claims a tag number that
`parse_tag_range_string` did not accept. `always` because it must hold at every
observation point; the two-sided bound is the effect-accounting form required
when the delivering message can be lost.
Fault/timing angle: the window between the `ctx_reduce` acknowledgement
(`:10587`) and the observer's `agent_drops.append`. If the response observer
never fires, the gap is permanent and the caller has no signal.
Required faults and enabling state: a `ctx_reduce` call with at least one
queueable tag, followed by a dropped or never-issued `agent_drops.append`.
Confidence: high — [evidence](../evidence/facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes.md).
Verified the handler performs only reads (`load_tags_for_session` `:10513`,
`load_pending_agent_drops` `:10517`), verified the response is
`isError: false` (`:10587`), and verified the existing test asserts
`load_pending_agent_drops` is empty after the acknowledgement (`:25474`).
Existing check: `lib.rs:25445-25500`
(`facade_ctx_reduce_ack_validates_unknown_queued_and_protected_tags_without_committing`),
status `unaudited`. Does not run in CI.
Impact: the model is told "Queued: drop 1; deferred drop 21" and cannot tell
whether the drop will ever happen. `command_id`, which the test supplies and
the delivery path honours (`:25486-25501`), is accepted and ignored by the
facade handler.
Open questions:
- Should the acknowledgement carry a delivery-pending marker so the caller can
  distinguish acknowledgement from effect? (needs human input)

### facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test in `mc-module` references
`handle_claim_effects_apply`.
Guarantee: An `ackedEffectId` returned by `claim.effects.apply` means the
module retained the effects up to that id, because the producer permanently
advances its outbox consumer checkpoint on that value alone.
Check: `always` — assert that for every accepted `claim.effects.apply`, some
durable module-side state changed, or that the module returns a code the
producer treats as non-advancing. `always` because it must hold on every
accepted call. Do not assert the negation; assert instead the two independent
preconditions that make the window real: (a) the request was accepted with an
`ackedEffectId` equal to the last effect id, and (b) no module store write
occurred during the call.
Fault/timing angle: none needed. The checkpoint advance is unconditional on the
ack.
Required faults and enabling state: none beyond the shipped drain path.
Confidence: high — [evidence](../evidence/facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect.md).
Verified `handle_claim_effects_apply` (`lib.rs:10184-10255`) never calls
`self.store()`; verified the producer advances
`claim_outbox_consumer_checkpoints` immediately after the ack
(`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2322-2340`);
verified the ack value is checked for equality on both sides
(`module-wire.ts:729-733`, `module-state-sync.ts:2323-2327`); verified the
consumer is a second, distinct consumer from the mirror one
(`module-state-sync.ts:1617`, `:1621`).
Existing check: none in `mc-module`. `mc-store` has no coverage of this path
either, because the path touches no store.
Impact: if the module was ever meant to retain claim effects under
`rust-module-claims-v1`, that retention is skipped permanently for every acked
prefix, and the producer's checkpoint makes it unrecoverable without a reset.
If the ack is deliberately validation-only, nothing in the module says so, and
the handler also never verifies that `consumer` is the consumer it expects
(`:10198-10204` checks only non-emptiness).
Open questions:
- Is `claim.effects.apply` intentionally a protocol-conformance ack, with the
  claim mirror as the only module-side writer? The handler name, the
  `ackedEffectId` field, and the producer's checkpoint advance all read as
  "applied". (needs human input)

### facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no `mc-module` test drives any claim-intent facade call.
Guarantee: A claim-intent facade call affects or reveals only intents whose
authority the calling route is bound to.
Check: `always` — with two routes bound to different project roots and an
intent staged from route A, assert that `claim.intent.inspect` on route B does
not return that intent and `claim.intent.ack` on route B does not transition
it. `always` because it must hold for every call on every route.
Fault/timing angle: none. Two concurrently bound routes are enough.
Required faults and enabling state: two facade routes bound to different
project roots in one module process, and a `binding` in the request that names
the other route's authority project and generation.
Confidence: high — [evidence](../evidence/facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity.md).
Verified `claim_route_root`'s result is discarded at `:10120-10122` and
`:10154-10156`; verified `inspect_claim_intents` and
`acknowledge_claim_intent` take no route argument (`memory_tool.rs:136-139`,
`:161-165`); verified `list_claim_intents` has no scope predicate
(`mc-store/src/lib.rs:11140-11158`); verified the ack path's only identity
check is `require_claim_intent_binding` against the STORED row
(`mc-store/src/lib.rs:3851-3885`), which compares the request against what was
written, not against the caller's route.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs` covers the store
transitions. Status `unaudited`, and CI does not run it. Nothing covers the
module-side route scoping.
Impact: `claim.intent.inspect` is a cross-project read of intent rows including
`result_json`. `claim.intent.ack` can drive another route's intent to
`context-committed`, `terminal-rejected`, or `acknowledged` if the caller can
reproduce that row's `request_digest` and binding, which `inspect` hands it in
the same response. The doc comment at `:10062-10067` asserts the opposite
guarantee.
Open questions:
- Is the ack's reliance on the stored binding intended as sufficient, on the
  reasoning that reproducing a 64-hex digest plus generation is itself proof of
  authority? If so the doc comment is wrong; if not the route root must be
  threaded through. (needs human input)

### facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no `mc-module` test drives a digest conflict.
Guarantee: A caller can tell from the error code alone whether its
`(producer, operation_key)` was reused for a different request body, as opposed
to hitting a transient store fault.
Check: `always` — assert that a `claim.intent.stage` whose identity already
exists with a different `request_digest` returns a code distinct from every
code the same handler emits for I/O, fence, and binding failures. `always`
because the classification must hold on every conflicting call.
Fault/timing angle: none. Two stages with the same identity and different
request bodies.
Required faults and enabling state: a second `claim.intent.stage` reusing
`(producer, operation_key)` with a body that hashes differently.
Confidence: high — [evidence](../evidence/facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault.md).
Verified the store detects the conflict and raises
`McStoreError::ClaimIntentIdentityConflict`
(`mc-store/src/lib.rs:11050-11052`, `:11165-11208`, mapped at `:4088-4094`);
verified the module collapses every `Err` into
`code: "claim_intent_stage_failed"` with the Display string as the message
(`lib.rs:10108-10111`), and the same for inspect (`:10146-10149`) and ack
(`:10177-10180`); verified the neighbouring `claim_mirror_error`
(`:13844-13857`) does the opposite and promotes two variants to distinct codes.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs` covers the store
outcome. Nothing covers the module's code mapping.
Impact: a genuine identity reuse, which is a caller bug that must not be
retried, is reported with the same code as a retryable store fault. The
distinction survives only in the free-text message.
Open questions:
- Should the three claim-intent handlers get a `claim_mirror_error`-style
  classifier? The variants exist and carry the producer and operation key
  (`mc-store/src/lib.rs:3420-3422`). (needs human input)

### facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test replays a command whose first attempt produced an
`isError: true` body.
Guarantee: A facade mutation whose first attempt failed for a transient reason
can still succeed when retried with the same `command_id`.
Check: `always` — assert that for every `command_id` whose ledgered response
carries `isError: true`, a retry either re-executes the mutation or returns a
code the caller can distinguish from a completed command. `always` because the
ledger is consulted on every mutation carrying a `command_id`.
Fault/timing angle: the concurrent-update window that produces
`NoteCasOutcome::Conflict`. The conflict is by definition transient, and the
memoization makes it permanent for that `command_id`.
Required faults and enabling state: a `ctx_note` `update` with a `command_id`
that loses a note CAS race, or a `dismiss` for a note id that is momentarily
absent, followed by a retry with the same `command_id`.
Confidence: high — [evidence](../evidence/facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes.md).
Verified both arms return `Ok(...)` with `is_error = true`
(`lib.rs:11865-11870`, `:11902-11907`); verified `with_facade_command` treats
the closure's `Ok` as the commit signal and inserts the bytes into
`mc_facade_mutation_ledger` (`mc-store/src/lib.rs:5022-5041`); verified a
later same-key call returns `Duplicate(response)` before running the closure
(`:5006-5019`); verified `facade_command_outcome` then adds
`"replayed": true` alongside the stored `content`/`isError` (`lib.rs:15298-15305`).
Existing check: none for the error-bearing case. The ledger's happy path is
covered by `ctx_reduce`-adjacent tests at `lib.rs:27555` and `:27668`, which
exercise `agent_drops.append`, not `ctx_note`.
Impact: the conflict text tells the caller to "retry with a fresh read", and
the retry returns the same conflict text forever unless the caller mints a new
`command_id`. The `replayed` marker is a sibling of `content`, so a model
reading only the text sees an unchanging failure.
Open questions:
- Should the closure return `Err` for these two arms so the transaction rolls
  back and nothing is ledgered? That changes the response the caller sees from
  an MCP error result to a typed error. (needs human input)

### facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/prepared_output.rs:249-278` constructs the
disagreement with a test-only inconsistent segment and asserts the error, but
that binary never runs in CI.
Guarantee: The response body the host reserves is either filled with exactly
the measured number of bytes or is never treated as a terminal response.
Check: `always` — assert that every `write_to` either returns
`Ok(n)` with `n == measured.len()` or returns `Err`, and that on `Err` the
settlement is `PreparedSettlement::Error`, never `Response`. `always` because
the serializer runs twice by design (`dispatch.rs:130-140`) and the two passes
must agree on every response.
Fault/timing angle: the gap between `measure()` (`lib.rs:12168`) and
`write_to` (`:12198`). Anything mutating the prepared source between them
breaks the equality; the sources are `Arc`-held and immutable, which is the
reason the property is expected to hold.
Required faults and enabling state: a prepared source whose measured length and
written length differ. Production has no such source, so a fault injection
seam is required; `PreparedSegment::inconsistent_for_test`
(`dispatch.rs:64-71`) is that seam.
Confidence: high — [evidence](../evidence/facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal.md).
Verified `BoundedWriter` refuses an over-length write
(`dispatch.rs:489-506`), verified the equality check and `LengthMismatch`
(`:270-277`), and verified `settle_prepared_with` maps a write error to
`PreparedSettlement::Error` (`lib.rs:12198-12203`).
Existing check: `crates/mc-module/tests/prepared_output.rs:249-278` and
`:230-247`, status `unaudited`. Neither runs in CI
(`.github/workflows/ci.yml:167-168` runs only `--test lifecycle_cli`).
Impact: a short body on a length-prefixed wire desynchronizes the frame stream.
The guard is the thing that prevents it, and it is proven only by an
uninvoked test.
Open questions:
- On `LengthMismatch` the reserved output buffer already holds the partial
  bytes; `tests/prepared_output.rs:274` asserts exactly that. Whether the host
  discards a reserved output frame when the module returns
  `RequestOutcome::error` is a Part 2b obligation. Unresolved, needs the
  `mc-host` reservation contract.

### facade-a-facade-error-text-carries-absolute-route-paths-to-the-model

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts what a facade error message may contain.
Guarantee: A facade response delivered to a language model carries no
filesystem path from the host that the model did not supply.
Check: `always` — assert that for every `ctx_*` and claim facade response, the
`content[0].text` and any `PreparedOutcome::Error` message contain no
substring matching an absolute path prefix of the bound
`binding.project_root`, unless that path appeared in the request arguments.
`always` because it must hold on every response evaluated.
Fault/timing angle: none.
Required faults and enabling state: a route whose authority-managed project
differs from its `route_project_root`, then any `ctx_note` mutation or a
`memory_project` argument that disagrees.
Confidence: high — [evidence](../evidence/facade-a-facade-error-text-carries-absolute-route-paths-to-the-model.md).
Verified `resolve_facade_scope` formats `route_project_root` into a returned
error message (`lib.rs:10446-10454`); verified
`enforce_facade_project_vocabulary`'s error reaches the caller through
`tool_error_result(format!("Error: {error}"))` (`lib.rs:11584-11590`) and that
its Display embeds `route_project_root`
(`mc-store/src/lib.rs:3502-3512`); verified `dispatch.rs`'s three `Debug` impls
deliberately print no content (`:81-88`, `:192-203`, `:212-224`), so the
project's own diagnostic discipline is stricter than its response discipline.
Existing check: none. `sanitize_status_text` (`lib.rs:15423-15441`) strips
control characters and caps length for status text, and is not applied to
facade error text.
Impact: the module's own filesystem layout enters the model's context and from
there the provider's prefix cache and any transcript. There is no stated
contract forbidding it, which is itself the finding: the redaction discipline
visible in `dispatch.rs` stops at the diagnostic boundary.
Open questions:
- Is there a documented rule anywhere that facade responses must not carry host
  paths? I found none in `crates/mc-module`, `crates/mc-host`, or `docs/`.
  Unresolved, needs the prompt-surface or security owner.

### facade-a-replayed-facade-mutation-occurs-in-a-campaign

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — the `Duplicate` arm has no dedicated marker.
Guarantee: A campaign that claims to cover facade response assembly reaches the
state where a facade mutation is answered from the durable ledger rather than
executed.
Check: `sometimes` — a constant marker
`FACADE_MUTATION_REPLAY_OBSERVED` fires when
`facade_command_outcome` takes the `Duplicate` arm and successfully re-parses
the stored envelope. `sometimes`, not `reachable`: executing the arm's lines
with a hand-built `Duplicate` value proves nothing, because the property under
test is that a real second call with the same `command_id` and a committed
first attempt occurred.
Fault/timing angle: the replay window is exactly what the ledger exists for: a
response lost after commit, a module restart, or a client retry.
Required faults and enabling state: a `ctx_note` mutation carrying a
`command_id` that commits, then the same `command_id` re-sent. The ledger
retains only the newest 512 commands per identity scope
(`mc-store/src/lib.rs:5042-5046`), so the retry must land inside that horizon.
Confidence: high — [evidence](../evidence/facade-a-replayed-facade-mutation-occurs-in-a-campaign.md).
Verified the `Duplicate` arm and its `replayed` insertion
(`lib.rs:15298-15306`), verified the ledger lookup precedes the mutation
(`mc-store/src/lib.rs:5006-5019`), and verified the retention bound
(`:5042-5046`).
Existing check: none that observes the arm. `refuse_conditioned_note_without_evaluator`
(`lib.rs:15318-15339`) deliberately consults the ledger before refusing, which
is a second route into the arm and equally uncovered.
Impact: without this situation, the three records that depend on ledger replay
semantics
(`facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes`,
and the replay-distinguishability claims behind
`facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes`) pass vacuously.
Open questions: None.

## Contract-vs-code leads

1. **The facade's admitted name set.** `lib.rs:12344-12351` says "Only
   ctx_memory and ctx_search are accepted on that surface"; `:10046-10057`
   routes eleven names, including five that write durable state.
2. **`ctx_reduce`'s advertised schema versus its accepted arguments.**
   `prompt_surface.rs:195-204` calls the shape "the Thalamus authorization
   contract" and declares `required: ["drop"]` with
   `additionalProperties: false`. The handler accepts `command_id`
   (exercised at `lib.rs:25472`), `memory_project` (read via
   `resolve_facade_scope` at `:10502`), and the `reduced`/`summary` envelope
   (`:10487` into `:14421-14434`). The inline test at `lib.rs:25652-25653`
   asserts `reduced` and `summary` are absent from every advertised schema,
   so the omission is deliberate.
3. **Who owns claim authority identity.** `lib.rs:10062-10067` states the
   bound route is "the only trustworthy authority identity on the request" and
   that "Every claim handler must go through this". Three of the four handlers
   fetch it and drop it (`:10120`, `:10154`, `:10185`).
4. **`project_docs.rs`'s TOCTOU claim.** The header says the regular-file and
   size check "is RE-DONE at read time to close the TOCTOU gap"
   (`:10-11`), and `:67-68` repeats it. The code re-stats at `:69-72` and then
   calls `fs::read_to_string` at `:73`, which follows symlinks. The window is
   narrowed, not closed. The guard's stated threat model is exfiltrating
   `~/.ssh/id_rsa` into the prompt (`:7-8`), and the file is read into the
   trusted m0 baseline through `m0_compose.rs:352` and `transform.rs:38`.
   Recommend synthesis promote this to a record; I left it as a lead to stay
   inside the 12-record budget and because the consumer is 4b's.
5. **`claim.effects.apply`'s name and response field.** `ackedEffectId`
   (`lib.rs:10253`) and the handler name both read as "applied"; nothing in
   the module writes anything. The producer treats the value as authority to
   advance a durable checkpoint
   (`module-state-sync.ts:2322-2340`).
6. **`drive-fault` dormancy.** `crates/mc-module/Cargo.toml:47-59` argues that
   the feature's absence from a default build "is the dormancy proof", which is
   a testable claim about the shipped artifact. The corruption site is inside
   my scope at `lib.rs:13353-13365`, in `respond_transform`. The scope map
   (`part-4-module/_lenses/scope-map-and-risk-ranking.md:684`) suggested one
   reachability record in 4d for it. I did not write it, for budget reasons;
   the record would be `Reachability: explicit-config-only`, `Check:
   unreachable` on `apply_drive_fault` in a default build, verified by symbol
   absence rather than by a runtime assertion. Recommend synthesis add it.

## Open questions

- Does the host discard a reserved output frame when the module returns
  `RequestOutcome::error` after `write_to` already wrote partial bytes into it?
  `tests/prepared_output.rs:274` asserts the partial bytes are present in the
  destination while the terminal stays `None`, so the module's half of the
  contract is "the caller must not treat it as terminal". The other half is
  Part 2b's. Unresolved, needs the `mc-host` reservation contract.
- `PreparedOutcome::Streamed` is constructed nowhere in production
  (`lib.rs:9089`, `:9539`, `:12164`, `:16132`;
  `tests/prepared_output.rs:109`). Is the streamed settlement path reserved for
  future use, or dead? If dead, `RequestOutcome::Streamed` at `:12220` is
  unreachable and should be recorded as such. (needs human input)
- `health()` (`lib.rs:12003-12046`) can report `HealthStatus::Ok` while every
  facade call returns `isError: true`, because only the transform lane takes a
  `TransformDispatchTicket` (`:7993`, 4c's range) and
  `DispatchHealth::report` degrades only on staleness (`:403-407`). Is facade
  error rate meant to be invisible to the health probe? (needs human input)
- Is `list_claim_intents`' lack of any scope predicate
  (`mc-store/src/lib.rs:11140-11158`) intended, given that
  `claim.intent.inspect` exposes it to any bound facade route? Part 3 owns the
  store side; this lens owns the exposure. Unresolved, needs a joint ruling
  with Part 3's synthesis.
- METHOD.md's `Exercised` values do not settle how to score a check that exists
  but never runs in CI. I used `partial` where a test asserts the exact
  behaviour and `not yet` otherwise, and named the CI status in every
  `Existing check` line. The scope map raised the same question at
  `part-4-module/_lenses/scope-map-and-risk-ranking.md:681`. Still needs a
  ruling. (needs human input)

## Corrections to references I was handed

- The task placed the claim intent ledger at `lib.rs:10082-10182`. At `HEAD`
  that range is exactly `handle_claim_intent_stage` through
  `handle_claim_intent_ack`, which is correct, but `claim_route_root`
  (`:10068-10080`) is part of the same contract and sits just above it. The
  scope map's row for the group says `10068-10182`
  (`part-4-module/_lenses/scope-map-and-risk-ranking.md:234`), which is the
  accurate span.
- The task said `tests/prepared_output.rs` tests `dispatch.rs` and does not run
  in CI. Both confirmed: the file imports only
  `mc_module::dispatch::{...}` (`:5-7`), and
  `.github/workflows/ci.yml:167-168` runs only
  `cargo test -p mc-module --test lifecycle_cli`.
- Part 3's finding that the transition write is silently dropped for a
  non-32-hex identity is confirmed at `mc-store/src/lib.rs:4118-4126`
  (`set_claim_intent_transition_tx` returns `Ok(())` when
  `!is_lower_hex(database_incarnation_id, 32)`). Its reachability from this
  lens's surface is answered in
  [../evidence/facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity.md](../evidence/facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity.md):
  no facade handler reaches it. The four callers are authority transitions
  reached through the flat `method` surface (`lib.rs:12255`, `:12257-12267`),
  which the shipped plugin drives from
  `packages/plugin/src/features/magic-context/context-authority.ts:829-1072`.
