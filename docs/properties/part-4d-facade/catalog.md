# Part 4d property catalog: the facade surface, note evaluation, and response assembly

Scope: about 9,000 lines. `crates/mc-module/src/lib.rs:10042-11917` and
`:11919-16001` are the facade regions, which include the claim intent ledger
handlers at `:10082-10182` and the `note.evaluation.*` protocol at
`:10880-11481`; `crates/mc-module/src/dispatch.rs` (whole) is response assembly;
`crates/mc-module/src/smart_note_evaluation.rs` (1,851 lines, of which 951-1851
is the inline test module) is the note reducer and its selectors; and
`src/memory_tool.rs` and `src/project_docs.rs` are read in full as facade
dependencies. `lib.rs:16001-30517` was read as evidence for existing checks
rather than cataloged. Store-side lifecycle context in
`crates/mc-store/src/lib.rs` is cited throughout because most durable note and
claim state lives there.

One boundary is worth stating because a record sits either side of it.
`claim_route_root` (`:10068-10080`) is part of the claim contract and sits just
above the ledger handlers; the scope map's row for the group says `10068-10182`,
which is the accurate span.

Provenance. This catalog was **reconstructed from the lens files** after the
working tree was cleaned while it was untracked. Every record below is taken
verbatim from `_lenses/lens-a-facade-and-assembly.md` (twelve records,
`facade-a-` prefix, plus the facade map and the response-assembly map) or
`_lenses/lens-b-note-evaluation.md` (twelve records, `note-b-` prefix, plus the
note lifecycle map and the evaluation decision map).
`_lenses/lens-c-claims-and-checks.md` proposed no records and supplied the
coverage context. Record text is reproduced as written by the lens agents, with
formatting adjusted (evidence links repointed from `../evidence/` to
`evidence/`) and with exactly the thirteen refinements
[portfolio-evaluation.md](portfolio-evaluation.md) records as applied, plus the
one factual correction it records alongside them. No claim was re-derived and no
line reference was re-verified against source during reconstruction; the line
references are the lens agents' own, read back individually at `HEAD`.

`HEAD` is `e447c927` ("refactor(shm): trim final review leftovers"), which both
lens agents and all three sibling artifacts state. The one CI step that matters
moved across `76cd6f41..HEAD`: `cargo test -p mc-module --test lifecycle_cli` is
`ci.yml:168` at `76cd6f41` and `ci.yml:172` at `HEAD`, and records cite whichever
the lens agent used.

Reachability provenance. **All 25 records are `default-production`**, and the
derivation is one shared pair of facts plus one subsystem-specific chain. Every
facade handler cited is reached from `handle_facade_value` (`:10042-10060`), whose
`match name` at `:10046` routes eleven names and carries no `#[cfg]` attribute,
and the seven `note.evaluation.*` methods are routed with no `cfg` and no Cargo
feature (`:12282-12296`). Reaching the note reducer additionally requires a live
registration, because a claim is the only thing `complete` will apply
(`mc-store:13569-13573`), and registration requires `MODULE` notes authority on
the bound route (`:3908-3936`). The shipped registrant is the plugin's bridge
(`packages/plugin/src/hooks/magic-context/hook.ts:1015-1213`, registering at
`:1210`), which returns early unless `dreamerRunnable` (`:1024`) and unless the
`evaluate-smart-notes` schedule is non-empty (`:1029`); the schema does not
default the `dreamer` block
(`packages/plugin/src/config/schema/magic-context.ts:707`), but the shipped setup
wizard writes it unconditionally
(`packages/cli/src/commands/setup-opencode.ts:262-278`) and defaults the prompt
to yes (`:449`), leaving `tasks` unset so the non-empty `"0 3 * * *"` schema
default applies. A hand-authored config with no `dreamer` block leaves the
subsystem dormant, and the module fails closed rather than open in that case,
refusing conditioned writes at `:11618-11626`. The only feature-gated tests in
the part are the eight `drive-fault` cases.

## Facade map

### There is exactly one entry point and three routing surfaces below it

`CompositeComponent::handle` (`:11963-11997`) is the only request entry. It does
four things in a fixed order before any handler sees the body:

1. `enforce_request_byte_cap(ctx.body.as_slice())` (`:11964`, defined at
   `:14375-14391`). Bodies at or under 1 MiB (`MAX_FACADE_FRAME_BYTES`, `:14279`)
   pass. A larger body is re-probed with `RequestMethodProbe` (`:14289-14305`) and
   admitted up to 32 MiB (`MAX_TRANSFORM_FRAME_BYTES`, `:14284`) only if the
   probe calls it transform-class. Above 32 MiB even a transform-class body is
   refused (`:14386-14388`).
2. `value_footprint_bound(ctx.body.as_slice())` (`:11979`, defined at
   `:14329-14357`) counts an upper bound on the `serde_json::Value` tree the body
   will occupy, by classifying every byte as inside or outside a string.
3. `ctx.try_reserve_resident(footprint)` (`:11982`). The charge is taken BEFORE
   `from_slice`, and the two refusal arms are distinguished: above the host
   ceiling is permanent (`request_too_large_error`, `:14360-14365`, code
   `invalid_params`), below it but currently unavailable is retryable
   (`resident_capacity_error`, `:14368-14373`, code `queue_full`).
4. `serde_json::from_slice::<Value>(...).unwrap_or(Value::Null)` (`:11991`). A
   body that is not valid JSON becomes `Value::Null` rather than an error here; it
   fails later in `unrecognized_request_error` with the `non-object JSON (null)`
   branch (`:12368`).

So the only checks genuinely uniform across every request are the byte cap and the
resident charge. Everything past that is per-surface.
`dispatch_value_with_inbound_bytes` (`:12239-12323`) then picks one of three:

| Surface | Discriminator | Validation strictness |
| --- | --- | --- |
| Flat method body | `method`, else `kind` (`:12245-12248`) | Per-handler; `note.evaluation.*` alone uses a closed schema |
| MCP facade envelope | `name` AND `arguments` both present (`:12319`) | Open schema; `facade_arguments` clones and never rejects |
| Neither | falls through | `unrecognized_request_error` (`:12322`) |

The precedence is `method`/`kind` first, unconditionally. A body carrying both a
`kind` and a facade `name` routes on `kind` and the `name` is ignored, which
`facade_flat_envelope_precedence_keeps_kind_arm_and_gates_ctx_reduce_name`
(`:25299-25323`) asserts with `{kind:"echo", name:"ctx_memory"}`.

### The facade envelope routes eleven names, not two

`handle_facade_value` (`:10042-10060`) routes `ctx_memory`, `ctx_search`,
`ctx_expand`, `ctx_reduce`, `ctx_note`, and six claim commands
(`claim.intent.stage`, `claim.intent.inspect`, `claim.intent.ack`,
`claim.effects.apply`, `claim.mirror.replace`, `claim.mirror.apply`). Anything
else falls to `unrecognized_request_error` (`:10058`). The doc comment on
`unrecognized_request_error` (`:12344-12351`) says "Only ctx_memory and ctx_search
are accepted on that surface", which is stale and is the only prose statement of
the admitted name set.

### What each facade handler validates, in the order it validates it

| Handler | Route/scope gate | Argument decode | Field validation |
| --- | --- | --- | --- |
| `handle_ctx_reduce_facade` `:10482-10588` | `resolve_facade_scope` AFTER parsing `drop` (`:10493`, `:10501`) | `facade_arguments(request, &["drop"])` `:10487` | `parse_tag_range_string` `:10493`; nothing else |
| `handle_ctx_memory_facade` `:10590-10697` | `resolve_facade_scope` `:10601`; `dreamer_run_registered` for `list` `:10626` | `facade_arguments(request, &["action"])` `:10595` | claim-id shape `:10656-10661`; 1..=20 count `:10651`; `limit` clamp `:10667` |
| `handle_ctx_search_facade` `:10699-10759` | `resolve_facade_scope` `:10715` | `facade_arguments(request, &["query"])` `:10704` | non-empty `query` `:10708`; `MAX_QUERY_BYTES` `:10711`; `limit` clamp `:10714` |
| `handle_ctx_expand_facade` `:10761-10878` | `resolve_facade_scope` `:10770` | `facade_arguments(request, &["message","start"])` `:10766` | ordinal signs and order `:10823`; span and row caps `:10840-10847` |
| `handle_ctx_note_facade` `:11547-11916` | `resolve_facade_scope` `:11568`; vocabulary recheck for mutations `:11584-11591` | `facade_arguments(request, &["action","content"])` `:11552` | five string caps `:11556-11563`; `filter` enum `:11730`; `command_id` `:11592-11599` |
| `handle_claim_intent_stage` `:10082-10113` | `claim_route_root` `:10083`, and the root is PASSED to the store at `:10100` | typed `serde_json::from_value` `:10090` | protocol and encoding version in `memory_tool` `:115-121` |
| `handle_claim_intent_inspect` `:10115-10151` | `claim_route_root` called and DISCARDED `:10120-10122` | typed `from_value` `:10127` | protocol version and `limit` 1..=10000 (`memory_tool.rs:140-145`) |
| `handle_claim_intent_ack` `:10153-10182` | `claim_route_root` called and DISCARDED `:10154-10156` | typed `from_value` `:10160` | protocol version (`memory_tool.rs:166`) |
| `handle_claim_effects_apply` `:10184-10255` | `claim_route_root` called and DISCARDED `:10185-10187` | hand-rolled `Map` walk `:10188` | protocol version `:10191`; consumer non-empty `:10198`; receipt/result cross-check `:10205-10250` |
| `handle_claim_mirror_replace` `:10257-10297` | `facade_binding` presence only `:10262` | typed `from_value` `:10271` | protocol version `:10273` |
| `handle_claim_mirror_apply` `:10299-10337` | `facade_binding` presence only `:10300` | typed `from_value` `:10309` | protocol version `:10311` (Part 3 owns receipt semantics) |

`resolve_facade_scope` (`:10387-10480`) is the real scope authority for the five
`ctx_*` tools: it resolves the conversation key (with the OpenCode provenance
bypass at `:10406-10409`), optionally binds the authority route for writes
(`:10434-10438`), and rejects a `memory_project` argument that disagrees with the
route's authority-managed project (`:10446-10454`). The six claim handlers do not
use it at all.

## Response assembly map

### Three settlement shapes, one of which never occurs in production

`PreparedOutcome` (`dispatch.rs:206-210`) has `Response`, `Error`, and
`Streamed`. `settle_prepared_with` (`:12150-12205`) maps them to
`PreparedSettlement`, and `settle_prepared` (`:12207-12222`) maps that to
`RequestOutcome`. Assembly order for a `Response`:

1. `output.measure()` (`:12168`). Counts the exact encoded length without
   retaining the bytes, capping as it counts (`dispatch.rs:141-157`, `330-346`,
   `352-357`). Failure becomes `code: "encode_failed"`.
2. cancellation check (`:12177`), then `reserve(measured.len())` (`:12183`), then
   a second cancellation check (`:12192`).
3. `measured.write_to(&mut body)` (`:12198`). `BoundedWriter`
   (`dispatch.rs:469-511`) refuses a write past the measured length, and
   `write_to` compares `written != self.len` and returns `LengthMismatch`
   (`dispatch.rs:270-277`).

`PreparedOutcome::Streamed` is never constructed in production: the only
occurrences are the two `matches!` discriminations at `:9089` and `:9539`, the
settlement arm at `:12164`, an inline test at `:16132`, and
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
  per-handler. Examples in scope: `:10251-10254` (claim effects), `:10289-10294`
  (mirror replace), `:10327-10334` (mirror apply).

### Replay is distinguishable, on three of four paths

`facade_command_outcome` (`:15290-15311`) inserts `"replayed": true` into a
`Duplicate` envelope (`:15303`). `stage_claim_intent` and
`acknowledge_claim_intent` return `replayed` from the store outcome
(`memory_tool.rs:131`, `:177`). `claim.mirror.apply` returns `replayed`
(`:10331`). `ctx_reduce` returns nothing of the kind, and neither does
`claim.effects.apply`.

## Note lifecycle map

`mc_notes` rows carry a `type` column. `insert_note` (`mc-store:10130-10164`)
writes `type = 'session'` with `status = 'active'`. `insert_project_note`
(`:10166-10200`) writes `type = 'smart'` with `status = 'pending'` when a
non-empty `surface_condition` is present and `'active'` otherwise
(`:10183-10189`). Only `type = 'smart'` rows with `status = 'pending'` are ever
evaluated: the candidate query is
`WHERE project_path = ?1 AND type = 'smart' AND status = 'pending'`
(`:13292-13297`).

`apply_note_evaluation_outcome` (`:14193-14277`) lifts the stored row into
`SmartNoteLifecycleState` (`:14213-14243`), runs the reducer (`:14244`), and
writes every reduced field back through `NoteEvalReducedState` (`:14247-14276`).
Nothing is discarded and nothing is derived at read time: the whole decision is
materialized into columns. Two fields are set outside the reducer,
`compiled_source_revision` and `compiled_project_path`, stamped from the claim
only when the outcome carried an artifact and otherwise preserved
(`:14245-14252`).

| Transition | Entry point | Durable writes |
| --- | --- | --- |
| create, plain | `ctx_note` write with no condition (`:11679-11711`) | `type='session'`, `status='active'` (`mc-store:10152-10157`) |
| create, conditioned | `ctx_note` write with condition (`:11629-11677`) | `type='smart'`, `status='pending'`, condition, compile hints (`mc-store:10192-10199`) |
| update | `update_note_cas` (`:11837-11871`, store `:10409-10505`) | content and/or condition, `status_version + 1`, `state_version + 1`; on a compiler edit also `source_revision + 1`, `status='pending'`, and the entire check lifecycle NULLed (`mc-store:12844-12871`) |
| supersede | none | there is no supersession relation between notes; a re-authored condition is an in-place update, not a new row |
| evaluate | `note.evaluation.complete` (`:11334-11405`) | the 20 reduced projection fields plus the two compile-provenance fields |
| expire (claim) | `collect_note_eval_ledgers_tx` (`mc-store:13119-13157`) | claim rows only; the note row is never touched by claim expiry |
| dismiss | `dismiss_note` (`mc-store:4551-4605`, `:10507-10563`) | `status='dismissed'`, `dismissed_at`, `dismissal_resolution`, content with the resolution appended (`:4574-4577`), version bumps, and a claim fence |
| delete | `DELETE FROM mc_notes WHERE context_store_uuid = ?1 AND project_path = ?2` (`mc-store:11393`) | the row; this is session-delete and recomp territory, owned by Parts 3 and 4c |

Both `update_note_cas` and `dismiss_note` call
`fence_active_note_claims_tx(..., "stale", ...)` (`mc-store:4543`, `:4602`,
`:10500`, `:10558`), so an in-flight claim cannot apply an outcome across an edit
or a dismissal.

## Evaluation decision map

Selection reads `SmartNoteSelectionSnapshot`
(`smart_note_evaluation.rs:682-702`): 11 fields, deliberately excluding the
artifact body ("Only artifact PRESENCE affects selection", `:690-692`), built from
the store's narrow candidate projection by `smart_note_selection_snapshot`
(`:13963-13985`), which defaults a NULL `check_status` to `"uncompiled"` and a
NULL `policy_version` to `0`, so an unmigrated row lands in the compile phase
rather than being silently skipped. Reduction reads the full
`SmartNoteLifecycleState`, the phase-scoped outcome, `note_id`, `now`, and a
timezone. Selection returns `Option<(note_id, phase_name, successor_cycle)>`
(`:900-949`); reduction returns `SmartNoteReduction` (`:347-352`), the complete
next state plus a `surfaced` boolean.

| Phase | Selector | Eligibility | Order key |
| --- | --- | --- | --- |
| due | `get_due_compiled_smart_note_checks` `:711-731` | pending, compiled, has artifact, on-policy, unquarantined, `check_next_due_at <= now` | `(check_next_due_at, id)` `:728` |
| compile | `get_smart_notes_needing_compilation` `:735-755` | pending, due, and (`uncompiled` or `failing` or no artifact or off-policy) | `(created_at, id)` `:752` |
| liveness | `get_stale_compiled_smart_notes` `:759-783` | pending, compiled, on-policy, false for at least 7 days, last liveness at least 24h ago | `(check_false_since_at, id)` `:780` |
| fallback | `get_fallback_smart_notes` `:788-806` | pending and `check_status == "fallback"` — **no time predicate at all** | `(last_checked_at.is_some(), last_checked_at, id)` `:797-803` |

`eligible` (`:704-707`) additionally drops a note whose `compile_status` is
already `"compiled"` when the caller set `retina_handoff`. Backoff coverage is
uneven, and the two blanks are two records: `fallback` with a `False` outcome
writes no durable delay (`:647-656`), and `liveness` with `network_failed` moves
only `check_last_liveness_at` (`:591-593`, `:623-626`).

Three guards make illegal transitions unrepresentable, each at a different layer.
Phase is type-scoped, so a `CompileOutcome` cannot be handed to `reduce_due`
(`:338-344`, intent stated at `:337`), and the wire decoder enforces the same
pairing by exhaustive match (`:14089-14107`). The phase must match the claim
(`:14197-14202`). And the note must be the note that was claimed:
`complete_note_evaluation` refuses unless `note.source_revision`,
`note.state_version`, and `note.status == "pending"` all agree with the claim
(`mc-store:13569-13573`). What is **not** re-checked at completion time is the
phase's own eligibility predicate, and that gap is closed indirectly: every path
that could change `check_status` under a live claim also bumps `state_version` and
fences the claim, so the version fence is load-bearing for phase-precondition
safety.

## What this part is about

**Facade validation is not uniform.** Three independent strictness tiers coexist
below one entry point (`:11963`):

- **A runtime closed schema.** `note_evaluation_body` (`:13894-13900`) walks every
  key and errors on anything outside its per-method allow list, and requires
  `v == 2`. This is the only runtime closed-schema decode on any surface, and it
  is the note-evaluation protocol's.
- **Typed decode rejecting unknown fields.** The claim wire structs carry
  `deny_unknown_fields`
  (`mc-core/src/claim_operation.rs:313,352,360,406,417,438,450,460,468,475`), as do
  the two mirror request structs (`lib.rs:140`, `:147`).
- **An open map clone that rejects nothing.** `facade_arguments` (`:14419-14435`)
  serves all five `ctx_*` tools and never walks a key. The advertised schemas
  match that openness deliberately, with `additionalProperties: true` at
  `:15846` (`ctx_memory`), `:15929` (`ctx_search`), `:15950` (`ctx_expand`), and
  `:15963` (`ctx_note`).

One narrowing is applied here rather than left implicit (D13). An earlier version
of this section said the inline test at `:25636-25641` asserts that the silent
acceptance is intentional. Read at `HEAD`, that assertion is
`if name != "ctx_reduce" { assert_ne!(tool.schema.get("additionalProperties"), Some(&json!(false)), "{name} must preserve compatibility arguments") }`,
which is a statement about the advertised manifest's `additionalProperties`
value. It proves **advertised openness**: the schema must not be closed. It does
not prove that a handler ignores an unknown key, that the ignoring is silent, or
that a call with a spare key returns bytes identical to one without it. A separate
comment at `:25636-25641` does assert the silent acceptance is intentional rather
than accidental, and the two claims are not the same claim.

That distinction matters because two records live on either side of the line the
code itself draws, and stating it once here stops them from contradicting each
other (D4). A key resembling nothing the handler reads is a **compatibility key**;
serving it silently is the advertised posture and the correct diagnostic is none. A
key within one edit, one case change, or one separator change of a key the handler
does read is a **typo**; nothing advertises tolerance for it, no test pins it, and
the correct diagnostic is one that names it.

**Six error paths present as success, and one of them has a test.** The tested one
is `ctx_reduce`, covered in this crate by
`facade_ctx_reduce_ack_validates_unknown_queued_and_protected_tags_without_committing`
(`:25445-25474`), which drives `ctx_reduce` through the facade and asserts at
`:25474` that `load_pending_agent_drops` is empty after the acknowledgement.
(Corrected this revision: an earlier version credited `claim.effects.apply`, which
has no test on either side of the language boundary, and left the actually-tested
path looking uncovered.) The other five are `claim.effects.apply`, which never
calls `self.store()` and returns `ackedEffectId` (`:10184-10255`); two
`handle_ctx_note_facade` arms that return `Ok(facade_text_response(..., true))`
from inside the ledger closure, the note CAS conflict (`:11865-11870`) and
dismiss-not-found (`:11902-11907`); and the two `handle_ctx_expand_facade`
unrecoverable-content answers at `:10804-10809` and `:10832-10838`, which
`portfolio-evaluation.md` queues as gap G1 rather than records. Underneath all of
them, `isError` lives inside a successful transport response and assembly never
inspects it: `health()` (`:12003-12046`) can report `HealthStatus::Ok` while every
facade call fails, because only the transform lane takes a
`TransformDispatchTicket` (`:7993`, 4c's range) and `DispatchHealth::report`
degrades only on staleness (`dispatch.rs:403-407`, `:418-421`).

**A cross-language dependency is untested from both sides, and the shape of that
is worth stating precisely, because an earlier draft overstated it.** All three
artifacts once said "each half is checked against a fake of the other". That is
three claims and each needs separate treatment (D10):

- **The Rust half is not checked against anything.** `claim_effects` appears twice
  in `lib.rs`, at `:10051` (dispatch) and `:10184` (handler), and zero times in
  either test module. There is **no Rust test at all** for a fake to be the
  counterparty of, so "checked against a fake" overstated it in the most
  consequential possible direction.
- **The producer is checked against a fake delivery, and that part was right.**
  The fake is an inline closure, not a stub file: `drainClaimEffectPrefix` is
  called at `module-state-sync.test.ts:1405` with a `deliver` option whose body
  spans `:1409-1415` and returns
  `{ ackedEffectId: receipt.effects.at(-1)?.id ?? 0 }` at `:1414`. The drain's
  ordering and per-receipt checkpoint atomicity are genuinely covered. No module
  behaviour is.
- **The real composition is absent.** `direct_host.rs` contains zero 4d method
  literals, so there is nothing to extend.

Two further facts sharpen it. Citations previously carried as claim-effects
coverage are coverage of a **different contract**: `module-wire.test.ts:345`,
`:414` and `:427` are all arguments to `decodeClaimMirrorReceiptResponse`
(defined at `module-wire.ts:737`), and `module-state-sync.test.ts:1510` sits
inside `class DeterministicClaimMirrorFacade` (opening at `:1444`). They share the
field name `ackedEffectId` with the claim-effects path and nothing else. And the
claim-effects wire validator itself, `decodeClaimEffectDeliveryResponse`
(`module-wire.ts:717-735`, with the skipped-checkpoint throw at `:730-732`), has
**zero test references anywhere** in `packages/plugin`, so the ack equality check
the whole contract rests on is untested on the side that was described as tested.

The mitigation is real and bounds the exposure. The checkpoint advance rejects a
regression and a beyond-tail value (`storage-claim-operations.ts:2218-2243`), so
the failure mode is **skipped effects rather than fabricated ones**: a producer
cannot be talked into acknowledging effects that do not exist, only into moving
past effects the module never retained.

**Note evaluation is deterministic and pure in-module, and its timezone is a
documented call-site choice rather than reducer impurity.** The module header's
purity claim holds for the file: no `unsafe`, no interior mutability, no global
state, no clock read, and no map iteration, with every ordering an explicit
`sort_by_key` ending in `id` and jitter a pure FNV-1a over a `{note_id}:{hash}`
seed (`:262-274`). The production call site passes a process-local timezone at
`:14244`, and that is a **call-site portability question rather than a purity
violation** (D12), because the reducer's own contract explicitly includes the
timezone: `smart_note_evaluation.rs:8-10` reads "Pure functions throughout:
callers supply the pre-state, a phase-scoped outcome, the transition clock, and a
timezone (cron matching is a wall-clock concept; production passes the
machine-local zone)". An earlier draft quoted that sentence up to "and a timezone"
and stopped one clause early, which turned a documented design into an alleged
impurity. What survives is smaller and better posed, and is not nothing: whether a
durable schedule field may be host-local at all. Per METHOD.md rule 3 the
documentation establishes the contract and not its correctness.

**Notes are unbounded.** There is no per-project count cap: neither `insert_note`
(`mc-store:10130-10164`) nor `insert_project_note` (`:10166-10200`) counts
existing rows, no reaper deletes notes by age or volume, and the candidate query
has no `LIMIT` (`:13291-13301`). This is the counterpoint to the one place the
recurring missing-reaper finding does not apply: the claim and acquisition ledgers
are both capped and reaped (`NOTE_EVAL_LEDGER_CAP` at `mc-store:2946`, checked at
`:13307-13313` and `:13355-13358`; `collect_note_eval_ledgers_tx` at
`:13119-13157` deletes rows and says why at `:13143-13147`). A dismissed note is
the retirement counterpart: `dismiss_note` UPDATEs and never DELETEs and appends
rather than replaces the resolution, so the content stays readable through
`filter: "dismissed"`, and nothing returns it to `pending` — readable but never
restorable.

### Coverage

There are **102 in-crate claim-bearing checks in scope**, plus **10 in
`crates/mc-module/tests/prepared_output.rs`**. **None of the 112 executes in
CI.** Unlike 4c there is not even an integration binary that drives the facade
through a real `McHandler`. So every `Existing check:` line below is a local-only
check, and "partial" in an `Exercised:` line means a test exists on a developer's
machine. Two consequences are load-bearing for individual records: no inline test
in `lib.rs:16001-30517` mentions `claim_intent` or `claim_effects`, so the four
claim-command facade handlers at `:10082-10255` have zero module-side coverage;
and `smart_note_evaluation.rs` contains zero `tracing`, `log`, `warn!`, `debug!`,
or metric calls, as does the whole note-evaluation protocol at `:10880-11560`, so
the only production assertion anywhere in the path is a `debug_assert!` at
`:11251-11254` that is compiled out of a release build.

### Refinements applied

`portfolio-evaluation.md` records **thirteen refinements, all applied, none
rejected**, plus one factual correction, taking the record count **24 to 25**.
One change accounts for the count:

- **D11** splits `facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect`
  into a module-local half, which keeps the slug, and a new record
  `facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed`
  carrying the cross-language composition. The two halves were provably
  distinguishable by exactly the test that matters: one is constructible today
  with one call and a before-and-after store read, and the other is the only
  record in the part no harness can reach. The same refinement removed a METHOD.md
  violation from the surviving record's check, a precondition ("no module store
  write occurred during the call") that is satisfiable only when the defect is
  present.

The other twelve edit fields rather than counts. **Five of them fix oracles that
passed while the defect they were written for was present**, which is the highest
value class this method produces: **D5** on the `ctx_reduce` bound, which collapsed
to `0 <= 0 <= reported` on exactly the permanent-gap case it existed for; **D2** on
the byte-cap equivalence, which quantified over 40 MiB bodies the cap is right to
refuse; **D9** on the fallback backoff, which demanded a durable delay after a
`Met` completion that removes the note from the candidate set; **D8** on the
unbounded-candidate check, which asserted a constant the product never declared and
so could not be run at all; and D11's precondition above. **D3** fixes two
byte-comparison oracles that cannot be two sequential mutating calls, because the
store mints identifiers into the response text (`:11704`) and a shared
`command_id` makes the second response one field larger (`:15303`). **D4** resolves
the polarity contradiction between the open-key and misspelled-condition records on
the line drawn in the prose above. **D6** names the previously anonymous cursor
marker `NOTE_CYCLE_EXHAUSTED_NO_WORK_OBSERVED`. **D7** removes an unevaluatable
documentation conjunct from the policy-version check. **D10**, **D12**, **D13**
and the factual correction rewrite the four prose claims stated above. **D1** edits
`fault-map.md` only, decomposing its "no fault" bucket into
`setup · calls · store read · harness`.

Final distributions after the disposition: **22 `always`, 1
`always-or-unreached`, 2 `sometimes`, 0 `reachable`, 0 `unreachable`**;
**23 safety, 0 liveness, 2 reachability**; **25 `default-production`, 0
`explicit-config-only`, 0 `test-only`**. `always(!X)` is counted as `always`,
following the convention Parts 4a through 4c used. The zero liveness count is not
a rounding artifact: `portfolio-evaluation.md` carries it as bias 1, because a
subsystem whose central mechanism is a fair-selection rotation the code itself
warns can "silently starve" (`:11245-11249`) has no bounded-progress record, and
whether it owes one is a scope decision nobody has made.

One process caveat, inherited and restated. METHOD.md step 7 requires records to
equal index rows to equal evidence files. Records and index rows both equal 25.
**Evidence files remain at 24**, because D11 added a record and the disposition was
forbidden from touching `evidence/`. Both halves of the split link
`evidence/facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect.md`
deliberately, so every link in this catalog resolves, but that file serves two
records and needs to become two. Separately,
`note-b-reducer-reads-process-local-timezone-for-durable-schedule` keeps a slug
D12 made imprecise, since the record is no longer about the reducer reading
anything; the slug is retained so the evidence link resolves, and the record says
so.

## Index

| Slug | Type | Confidence |
| --- | --- | --- |
| [facade-a-transform-class-byte-cap-probe-diverges-from-the-router](#facade-a-transform-class-byte-cap-probe-diverges-from-the-router) | safety | high |
| [facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic](#facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic) | safety | high |
| [facade-a-misspelled-surface-condition-silently-writes-a-plain-note](#facade-a-misspelled-surface-condition-silently-writes-a-plain-note) | safety | high |
| [facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source](#facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source) | safety | medium |
| [facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal](#facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal) | safety | high |
| [facade-a-facade-error-text-carries-absolute-route-paths-to-the-model](#facade-a-facade-error-text-carries-absolute-route-paths-to-the-model) | safety | high |
| [facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes](#facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes) | safety | high |
| [facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect](#facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect) | safety | high |
| [facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed](#facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed) | safety | high |
| [facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity](#facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity) | safety | high |
| [facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault](#facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault) | safety | high |
| [facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes](#facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes) | safety | high |
| [facade-a-replayed-facade-mutation-occurs-in-a-campaign](#facade-a-replayed-facade-mutation-occurs-in-a-campaign) | reachability | high |
| [note-b-reducer-reads-process-local-timezone-for-durable-schedule](#note-b-reducer-reads-process-local-timezone-for-durable-schedule) | safety | high |
| [note-b-selection-is-invariant-under-candidate-permutation](#note-b-selection-is-invariant-under-candidate-permutation) | safety | high |
| [note-b-completion-applies-only-under-the-claimed-revision-and-state-version](#note-b-completion-applies-only-under-the-claimed-revision-and-state-version) | safety | high |
| [note-b-check-failure-count-carries-across-compile-and-check-phases](#note-b-check-failure-count-carries-across-compile-and-check-phases) | safety | high |
| [note-b-fallback-phase-writes-no-durable-backoff](#note-b-fallback-phase-writes-no-durable-backoff) | safety | high |
| [note-b-liveness-network-failure-burns-the-window-with-no-durable-record](#note-b-liveness-network-failure-burns-the-window-with-no-durable-record) | safety | high |
| [note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll](#note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll) | safety | high |
| [note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration](#note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration) | safety | high |
| [note-b-registered-policy-version-never-reaches-selection](#note-b-registered-policy-version-never-reaches-selection) | safety | high |
| [note-b-excluded-note-is-not-reportable-by-any-surface](#note-b-excluded-note-is-not-reportable-by-any-surface) | safety | high |
| [note-b-dismissed-note-is-readable-but-never-returns-to-evaluation](#note-b-dismissed-note-is-readable-but-never-returns-to-evaluation) | safety | high |
| [note-b-cursor-exhausted-no-work-occurs-in-a-campaign](#note-b-cursor-exhausted-no-work-occurs-in-a-campaign) | reachability | high |

Group names below are this reconstruction's, chosen by mechanism, except where
`portfolio-evaluation.md` pins a letter: D4 places the open-key and
misspelled-condition records in Group A, and D10 and D11 place the claim-effects
records in Group C. The vocabulary follows `fault-map.md`'s own section headings
where they apply.

---

## Group A: facade validation and argument sourcing

Four records on what the facade accepts and where an argument map can come from.
They partition one mechanism, `facade_arguments` (`:14419-14435`) cloning a map it
never walks, into its four consequences: a byte cap whose class probe reads
different fields than the router, an unknown key served silently, a near-miss key
that converts a refusal into a success, and a second argument source whose
provenance is model text. The open-key and misspelled-condition records sit either
side of the compatibility-key versus typo line drawn in the section above, and both
name the diagnostic they expect so a later reader cannot re-merge them.

### facade-a-transform-class-byte-cap-probe-diverges-from-the-router

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test sends a body **between 1 MiB and 32 MiB** whose class field disagrees with the probe's field choice. (Narrowed this disposition, D2: the band matters, because outside it the equivalence does not hold and should not.)
Guarantee: Within the transform admission band, a body admitted above the 1 MiB facade ceiling is one the router will route to the transform lane, and a body refused at that ceiling is one the router would not have routed to the transform lane.
Check: `always` — for every body **strictly above `MAX_FACADE_FRAME_BYTES` and at most `MAX_TRANSFORM_FRAME_BYTES`**, assert `enforce_request_byte_cap` admits it if and only if `dispatch_value_with_inbound_bytes` would select the `"transform"` or `"state_sync"` arm for the same body. Bodies above the transform ceiling are out of scope in both directions. `always` because the cap runs on every request and both sides are computable from the body alone. The range restriction is a correction applied this disposition (D2): `enforce_request_byte_cap` (`:14375-14390`) has three outcomes, not two — under 1 MiB it admits everything (`:14376-14378`), between the ceilings it admits transform-class bodies (`:14382-14385`), and **above 32 MiB it refuses a transform-class body** with "request body exceeds the 32 MiB transform limit" (`:14386-14388`) — so for a 40 MiB body carrying `kind: "transform"` the router would select the transform arm, the cap correctly refuses it, and an unrestricted biconditional is false against an implementation doing exactly the right thing. The band is also where the finding lives, because it is the only band where the probe's field choice and the router's field acceptance can disagree about a body either would otherwise admit.
Fault/timing angle: none. Pure input classification.
Required faults and enabling state: a body **between 1 MiB and 32 MiB** carrying `method: "transform"` without `kind`, or `kind: "state_sync"` without `method`.
Confidence: high — [evidence](evidence/facade-a-transform-class-byte-cap-probe-diverges-from-the-router.md).
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
Exercised: not yet — corrected this disposition (D13). An earlier version said `lib.rs:25632-25641` asserts the open acceptance is intentional and scored the runtime consequence `partial` on that basis. That assertion is about the advertised manifest's `additionalProperties` value, not about runtime behaviour, so nothing exercises what happens to an unknown key at runtime.
Guarantee: An argument key that **resembles no key any `ctx_*` handler reads** — a compatibility key — never changes the handler's behaviour and never produces a caller-visible diagnostic.
Check: `always` — for every `ctx_*` call, assert that adding an argument key outside the handler's read set **and at edit distance greater than one from every key in that read set, ignoring case and separators**, produces an identical response to the call without it. Compare at the level that is stable rather than byte for byte on two sequential mutating calls: either drive the two calls against two independently cloned stores seeded to the same state, or compare the argument maps `facade_arguments` returns. A `command_id` must be absent from both calls or differ between them. `always` rather than `unreachable` because the acceptance is a state of the returned value, not a forbidden code point. Two corrections are folded in here. The edit-distance exclusion is D4: without it this check and `facade-a-misspelled-surface-condition-silently-writes-a-plain-note` contradict on a `ctx_note` write carrying `surfaceCondition`, one passing only if the response is unchanged and the other only if it is changed. The comparison level is D3: the store mints identifiers into the response text (`format!("Saved session note #{}.", note.id)` at `:11704`, insert at `:11690-11702`), so two sequential writes differ by construction, and a shared `command_id` makes the second response structurally one field larger because `facade_command_outcome`'s `Duplicate` arm inserts `"replayed": true` (`:15303`).
Fault/timing angle: none.
Required faults and enabling state: none. Any facade call with a spare key, plus two cloned stores if the tool under test mutates.
Confidence: high — [evidence](evidence/facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic.md).
Verified `facade_arguments` clones the map with no key walk (`:14419-14435`) and
verified all four advertised schemas set `additionalProperties: true`
(`:15846`, `:15929`, `:15950`, `:15963`).
Existing check: `lib.rs:25632-25641`, status `unaudited`. Its actual form is `assert_ne!(tool.schema.get("additionalProperties"), Some(&json!(false)), "{name} must preserve compatibility arguments")` guarded by `if name != "ctx_reduce"`, so it asserts **advertised openness** of the manifest and nothing about the handler's runtime treatment of an unknown key. Does not run in CI.
Impact: silent acceptance of a compatibility key is the advertised posture, so the risk is not the acceptance but the absence of any signal: a caller cannot distinguish "the module honoured my field" from "the module never looked at it". What is genuinely unpinned is the runtime behaviour itself, because the only existing assertion is about the manifest.
Open questions:

- `ctx_reduce`'s advertised schema is closed (`prompt_surface.rs:197-204`) yet
  the handler accepts `command_id` and the `reduced`/`summary` envelope, none
  of which the schema permits. Which side is the contract? (needs human input)

### facade-a-misspelled-surface-condition-silently-writes-a-plain-note

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test writes a note with a near-miss condition key.
Guarantee: A `ctx_note` write carrying a key within one edit, one case change, or one separator change of `surface_condition` — a typo rather than a compatibility key — either records the condition, or refuses, or answers with a diagnostic naming the unread key. It never reports plain-note success silently.
Check: `always` — assert that for every `ctx_note` write whose arguments contain any key differing from `surface_condition` only by case, separator, or a single edit, the response is not a plain `isError: false` "Saved session note #N." **and that the response names the unread key**. `always` because it must hold on every write evaluated. The diagnostic clause is a correction applied this disposition (D4): stating which diagnostic this record expects, against the sibling record's expectation of none for a compatibility key, is what keeps the two disjoint on the same input.
Fault/timing angle: none, but the enabling state matters: with no live evaluator, the correctly spelled key refuses, so the misspelling converts a refusal into a success.
Required faults and enabling state: a `ctx_note` write carrying `surfaceCondition` (or similar) and non-empty `content`, with `has_live_note_evaluator(project, now)` false.
Confidence: high — [evidence](evidence/facade-a-misspelled-surface-condition-silently-writes-a-plain-note.md).
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
Check: `always-or-unreached` — assert that for every `ctx_*` handler, a call whose real arguments are `A` and a call whose arguments are `{reduced: true, summary: to_string(A)}` produce identical outcomes, including identical cap rejections. Compare **at the parser level**, asserting that the two argument maps `facade_arguments` returns are equal, which tests the unwrap directly and never touches a store; if a response-level comparison is used instead, drive the two calls against two independently cloned stores and keep `command_id` absent from both or different between them. `always-or-unreached` because the unwrap branch may never run when the TypeScript side already unwrapped. The comparison level is a correction applied this disposition (D3), for the same two reasons as the sibling record: the store mints identifiers into the response text (`:11704`) and a shared `command_id` adds a `"replayed"` field (`:15303`), so a byte-for-byte comparison of two sequential mutating calls fails with no defect present. The parser-level form is strictly better here anyway.
Fault/timing angle: none.
Required faults and enabling state: `arguments.reduced == true`, no primary
field of that tool present, and `arguments.summary` a string that parses to a
JSON object.
Confidence: medium — [evidence](evidence/facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source.md).
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

## Group B: response assembly and what leaves the module

Two records on the boundary where a response becomes bytes. They are opposites in
maturity: the length equality between the two serializer passes is the part's
best-defended invariant, guarded in production by `BoundedWriter` and pinned by two
integration tests that never run, while the content discipline on the other side is
absent, so an error message may carry the host's own filesystem layout into the
model's context. `dispatch.rs`'s three `Debug` impls print only lengths and
source-kind tags (`:81-88`, `:192-203`, `:212-224`), which makes the project's
diagnostic discipline strictly stricter than its response discipline.

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
Confidence: high — [evidence](evidence/facade-a-measured-length-must-equal-written-body-or-nothing-is-terminal.md).
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
Confidence: high — [evidence](evidence/facade-a-facade-error-text-carries-absolute-route-paths-to-the-model.md).
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

## Group C: acknowledgements that write nothing

Three records on handlers that answer `isError: false` without touching durable
state. `ctx_reduce` says so in a comment (`:10585-10586`) and is the one of the
part's six success-shaped paths with a test. `claim.effects.apply` never calls
`self.store()` at all, and the producer treats its `ackedEffectId` as authority to
advance a durable checkpoint permanently. That second handler carries two
obligations of very different cost, which is why it is two records after the
independent evaluation: the module-local half is one call plus a before-and-after
store read, and the composition needs a process pair spanning two languages that
does not exist. Presenting them together produced a `Partial` verdict a reader
would read as "half the work is done" when one obligation is free and a different
one is impossible.

### facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `lib.rs:25445-25500` asserts the no-write behaviour and
the later delivery, so the behaviour is pinned; nothing asserts the
caller-visible ambiguity.
Guarantee: A `ctx_reduce` response discloses that it is an acknowledgement rather than a delivery, so a caller reading it cannot conclude that any drop was queued.
Check: `always` — for every `ctx_reduce` response reporting at least one tag as queued or deferred, assert the response carries a field distinguishing accepted-pending-delivery from queued, and that a caller reading only that field never concludes an effect landed while `load_pending_agent_drops` for that session is empty. Separately assert that no `ctx_reduce` response claims a tag number `parse_tag_range_string` did not accept. `always` because the disclosure obligation attaches to every response. This replaces an effect-accounting bound applied this disposition (D5), and the reason is worth keeping: the earlier check asserted `acknowledged_queued <= observed_pending_drops <= ctx_reduce_reported_queued`, citing METHOD.md's rule for paths where a delivering message can be lost. The rule is right and the quantity is wrong. `handle_ctx_reduce_facade` performs only reads and answers `mcp_text_result(format!("Queued: {}.", ...), false)` at `:10587`, so `observed_pending_drops` is 0, and in the scenario the `Fault/timing angle` names, where the observer never fires, `acknowledged_queued` is 0 as well. The assertion collapses to `0 <= 0 <= reported`, which holds for every reported count: the precise case the record exists to catch satisfies it most comfortably. Effect accounting is a screen on a path that *attempts* an effect, and this handler attempts none, so both bounds are zero and the screen constrains nothing.
Fault/timing angle: the window between the `ctx_reduce` acknowledgement
(`:10587`) and the observer's `agent_drops.append`. If the response observer
never fires, the gap is permanent and the caller has no signal.
Required faults and enabling state: a `ctx_reduce` call with at least one
queueable tag, followed by a dropped or never-issued `agent_drops.append`.
Confidence: high — [evidence](evidence/facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes.md).
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
Guarantee: An accepted `claim.effects.apply` either changes durable module-side state or returns a code the producer treats as non-advancing. (Narrowed this disposition, D11: the second obligation, that the producer's checkpoint therefore means what it claims, is now its own record, because it needs a harness that does not exist.)
Check: `always` — assert that for every accepted `claim.effects.apply`, some durable module-side state changed, or that the module returns a code the producer treats as non-advancing. `always` because it must hold on every accepted call. Do not assert the negation; the legal precondition is the acceptance alone, that the request was accepted with an `ackedEffectId` equal to the last effect id, which the fault map already carries as `CLAIM_EFFECTS_APPLY_ACCEPTED_A_RECEIPT`. A second precondition, "no module store write occurred during the call", was removed this disposition (D11) as a METHOD.md violation: a correct implementation that retained the effects would write, so that clause is satisfiable only when the defect is present, and the record had recited the rule in its own prose and then broken it in the next clause.
Fault/timing angle: none needed. The checkpoint advance is unconditional on the
ack.
Required faults and enabling state: none beyond the shipped drain path. One call plus a before-and-after store read.
Confidence: high — [evidence](evidence/facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect.md).
Verified `handle_claim_effects_apply` (`lib.rs:10184-10255`) never calls
`self.store()`; verified the producer advances
`claim_outbox_consumer_checkpoints` immediately after the ack
(`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2322-2340`);
verified the ack value is checked for equality on both sides
(`module-wire.ts:729-733`, `module-state-sync.ts:2323-2327`); verified the
consumer is a second, distinct consumer from the mirror one
(`module-state-sync.ts:1617`, `:1621`). This record shares its evidence file
with the composition record split off it, because both halves link the pre-split
file deliberately so no link breaks; per METHOD.md step 7 that file needs to
become two.
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

### facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed

Type: safety
Reachability: default-production — the module handler is routed at
`lib.rs:10051` with no `#[cfg]`, and the producer's drain and checkpoint advance
are on the shipped path
(`packages/plugin/src/hooks/magic-context/module-state-sync.ts:2322-2340`). The
record is `default-production` for the same reason as the record it was split
from; only its constructibility differs.
Status: active
Exercised: not yet, and **not constructible today**. This is the part's one
outright block. The module side has no test at all: `claim_effects` appears
twice in `lib.rs`, at `:10051` and `:10184`, and zero times in either test
module. The producer side is tested against a fake delivery closure, whose body
spans `module-state-sync.test.ts:1409-1415` and which returns
`{ ackedEffectId: receipt.effects.at(-1)?.id ?? 0 }` at `:1414`. The wire
validator that both sides rest on,
`decodeClaimEffectDeliveryResponse` (`module-wire.ts:717-735`, skipped-checkpoint
throw at `:730-732`), has zero test references anywhere in `packages/plugin`.
And the composition has no harness: `direct_host.rs` contains zero 4d method
literals.
Guarantee: The `ackedEffectId` the real module returns is the value on which the
real producer advances its durable outbox consumer checkpoint, so an
acknowledgement the module issues and a checkpoint the producer commits describe
the same effect prefix.
Check: `always` — with a real `McHandler` answering the real TypeScript drain
over the real transport, assert that after every delivery the producer's
committed `claim_outbox_consumer_checkpoints` value equals the `ackedEffectId`
the module returned, and that the module retained or explicitly declined every
effect at or below it. `always` because the correspondence must hold on every
delivery. The independent preconditions that make the window real are the two
sides existing at once: a module acceptance carrying an `ackedEffectId`, and a
producer checkpoint advance keyed to that value. Neither clause asserts a
violation.
Fault/timing angle: none needed for the correspondence itself. The mitigation
that bounds the exposure is a timing-free predicate: the checkpoint advance
rejects a regression and a beyond-tail value
(`storage-claim-operations.ts:2218-2243`), so the failure mode is skipped effects
rather than fabricated ones.
Required faults and enabling state: **a harness that does not exist** — a
cross-language process pair in which the real Rust module answers the real
TypeScript producer. No amount of in-crate work reaches it, which is exactly why
this obligation is a separate record: folding it into the module-local one made
an impossible obligation sit inside a bucket labelled cheap.
Confidence: high —
[evidence](evidence/facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect.md).
The mechanism is verified on both sides individually: the module handler never
calls `self.store()` (`lib.rs:10184-10255`), the producer advances the checkpoint
immediately after the ack (`module-state-sync.ts:2322-2340`), the ack value is
checked for equality on both sides (`module-wire.ts:729-733`,
`module-state-sync.ts:2323-2327`), and the consumer is distinct from the mirror
consumer (`module-state-sync.ts:1617`, `:1621`). What is not verified, and
cannot be today, is the composition. Two citations previously carried as
claim-effects coverage belong to the **mirror** contract and not to this one:
`module-wire.test.ts:345`, `:414` and `:427` are arguments to
`decodeClaimMirrorReceiptResponse` (`module-wire.ts:737`), and
`module-state-sync.test.ts:1510` sits inside `class DeterministicClaimMirrorFacade`
(`:1444`). This record shares its evidence file with the record it was split
from, which per METHOD.md step 7 needs to become two.
Existing check: none, on either side of the boundary, for the composition. The
producer's drain ordering and per-receipt checkpoint atomicity are covered
against the fake delivery closure at `module-state-sync.test.ts:1405-1415`; no
module behaviour is.
Impact: the contract's central equality is asserted by code on both sides and
witnessed by neither. The exposure is bounded to skipped effects by the
checkpoint's regression and beyond-tail rejections, so a producer cannot be
talked into acknowledging effects that never existed; what it can be talked into
is moving permanently past effects the module never retained.
Open questions:

- Is an end-to-end harness worth building for this contract alone, or should the
  module side first get any test at all, which would at least give the producer's
  fake a counterparty to be checked against? (needs human input)

## Group D: claim identity and the mutation ledger

Four records on identity: whose authority a claim call runs under, whether a
caller can classify why its claim was refused, and what the durable mutation
ledger memoizes as an outcome. The first two are on the four claim handlers that
have **zero module-side coverage**, and the doc comment at `:10062-10067` asserts
the guarantee the first record contradicts. The last is the group's vacuity
marker: three records here depend on ledger replay semantics, and without an
observed `Duplicate` arm all three pass on a campaign that never retries a
`command_id`.

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
Required faults and enabling state: two facade routes bound to different project roots in one module process, and a `binding` in the request that names the other route's authority project and generation. The oracle needs **two bindings and three calls**, not one: `claim.intent.stage` on route A, then `claim.intent.inspect` on route B, then `claim.intent.ack` on route B, because the guarantee covers both a cross-route read and a cross-route transition and one request can observe at most half of it. (Corrected this disposition, D1.)
Confidence: high — [evidence](evidence/facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity.md).
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
Fault/timing angle: none for the conflict itself. Two stages with the same identity and different request bodies produce it.
Required faults and enabling state: a second `claim.intent.stage` reusing
`(producer, operation_key)` with a body that hashes differently, **plus** a
genuine store failure on the same handler, so the two causes can be compared
rather than assumed distinguishable.
Confidence: high — [evidence](evidence/facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault.md).
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
Confidence: high — [evidence](evidence/facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes.md).
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
Confidence: high — [evidence](evidence/facade-a-replayed-facade-mutation-occurs-in-a-campaign.md).
Verified the `Duplicate` arm and its `replayed` insertion
(`lib.rs:15298-15306`), verified the ledger lookup precedes the mutation
(`mc-store/src/lib.rs:5006-5019`), and verified the retention bound
(`:5042-5046`).
Existing check: none that observes the arm. `refuse_conditioned_note_without_evaluator`
(`lib.rs:15318-15339`) deliberately consults the ledger before refusing, which
is a second route into the arm and equally uncovered.
Impact: without this situation, the three records that depend on ledger replay
semantics
([facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes](#facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes),
and the replay-distinguishability claims behind
[facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes](#facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes))
pass vacuously.
Open questions: None.

## Group E: note-evaluation determinism and the completion fence

Three records on whether the same note evaluated twice yields the same decision,
and on the one fence that makes a decision safe to apply at all. The first two are
positives under test: the reducer is pure over its declared inputs and selection is
invariant under candidate permutation because every `sort_by_key` ends in `id`. The
third is the fence three other records lean on, and it is load-bearing beyond its
own guarantee: because completion asserts only the phase name and not the phase's
eligibility predicate, the version fence is the sole protection for
phase-precondition safety. The one open question in the group is a call-site
portability decision, not a purity violation.

### note-b-reducer-reads-process-local-timezone-for-durable-schedule

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — the only reducer tests inject a fixed fixture zone, and a reducer differential cannot see this record anyway, because passing two zones to a pure function confirms documented behaviour rather than observing the call site's choice. (Sharpened this disposition, D12.)
Guarantee: A durable schedule field a note persists is a function of the note and its evaluation inputs, not of which host evaluated it. The reducer's purity is not in question: the timezone is a declared input of a pure function and production's use of the machine-local zone is documented at the same site. What is in question is the **call site's choice** to supply a host-local zone for a value that is then persisted.
Check: `always` — for a fixed `(pre, outcome, note_id, now)`, assert the persisted `check_next_due_at` is byte-identical across two evaluations whose only difference is the evaluating **process's** timezone. `always` because the persistence obligation applies to every reduction whose result is written. Note the level: the assertion is on what `apply_note_evaluation_outcome` (`:14193-14277`) writes, not on what `reduce_*` returns for two explicitly supplied zones, because the latter is documented behaviour and passes.
Fault/timing angle: none. The trigger is environmental, not temporal: a fleet of
mixed-timezone hosts, a laptop that changes zone, or a tzdata upgrade.
Required faults and enabling state: a smart note with a non-trivial `check_cron` (any cron that is not effectively-never), a `compiled_false` or `due false` outcome, and **two module processes** whose `chrono::Local` resolves differently. The two-process requirement is the whole cost of this record and cannot be avoided by varying the reducer's own argument.
Confidence: high — [evidence](evidence/note-b-reducer-reads-process-local-timezone-for-durable-schedule.md). Verified the `chrono::Local` argument at `lib.rs:14244`, the timezone's path into the schedule at `smart_note_evaluation.rs:246` and `:439`, and the fixture's pinned `America/Los_Angeles` consumed at `:1104-1108`. One quotation correction applied this disposition (D12): the purity claim at `smart_note_evaluation.rs:8-10` reads in full "Pure functions throughout: callers supply the pre-state, a phase-scoped outcome, the transition clock, and a timezone (cron matching is a wall-clock concept; production passes the machine-local zone)". An earlier version of this record stopped at "and a timezone", which turned a documented design into an alleged impurity. The slug is now imprecise, since the record is not about the reducer reading anything; it is retained deliberately so the evidence link resolves.
Existing check: `smart_note_evaluation_golden_matches_production_behaviour`
(`smart_note_evaluation.rs:1100-1188`) covers the schedule arithmetic under one
fixed zone. It cannot see this. Status `unaudited`. Not run in CI.
Impact: two hosts evaluating the same note write different durable
`check_next_due_at` values, so a note's next check time depends on which host
last touched it. The cross-language golden claim at
`smart_note_evaluation.rs:1-6` is scoped to one zone and does not cover it.
Open questions:

- Is host-local wall-clock cron intended to be the durable contract, meaning the
  divergence is by design, or should the zone be pinned per project so the
  schedule is stable across hosts? Per METHOD.md rule 3 the documentation
  establishes the contract and not its correctness, so this is a live portability
  decision rather than a settled one. (needs human input)

### note-b-selection-is-invariant-under-candidate-permutation

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the normative cycle traces
(`smart_note_evaluation.rs:1764-1851`) fix one candidate order and assert the
selected sequence; no test permutes the input.
Guarantee: The note and phase selected for a given cycle depend only on the
candidate set's contents, never on the order in which candidates are presented.
Check: `always` — assert that `select_smart_note_evaluation_cycle` returns the
same `(note_id, phase)` for a candidate slice and for every permutation of that
slice. `always` because the store's row order is an implementation detail that
must never change a decision.
Fault/timing angle: none.
Required faults and enabling state: at least two notes eligible for the same
phase whose primary sort key ties, so the `id` tiebreak is the only thing
deciding.
Confidence: high — [evidence](evidence/note-b-selection-is-invariant-under-candidate-permutation.md).
Read all four `sort_by_key` calls (`smart_note_evaluation.rs:728`, `:752`,
`:780`, `:797-803`) and confirmed each ends in `note.id`; confirmed the store
feeds `ORDER BY id` (`mc-store:13296`); confirmed no `HashMap` or `HashSet`
iteration anywhere in the module.
Existing check: `cycle_selection_prefers_due_then_compile_then_liveness_then_fallback`
(`smart_note_evaluation.rs:1577-1716`) and the normative trace replay
(`:1764-1851`). Both fix one order. Status `unaudited`. Not run in CI.
Impact: if a tiebreak were ever dropped, the acquisition decision would depend
on SQLite's row order, and the boot-ephemeral cursor plus the durable
acquisition ledger would disagree about which note a replayed acquisition
selected.
Open questions: None.

### note-b-completion-applies-only-under-the-claimed-revision-and-state-version

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `smart_note_revision_matrix_normative_matches_mc_store`
(`smart_note_evaluation.rs:1189-1526`) drives a revision and state-version
matrix against the real store.
Guarantee: An evaluation outcome is applied only to the exact note revision the
claim was issued against, so a note edited or dismissed mid-evaluation cannot
receive a decision computed from its old content.
Check: `always` — assert that for every applied completion,
`note.source_revision == claim.source_revision`,
`note.state_version == claim.state_version`, and `note.status == "pending"` held
at apply time, and that any mismatch yields a `stale` conflict with no note
write. `always` because it is the fence every other phase-precondition
guarantee rests on.
Fault/timing angle: the window is between the claim and the completion, which
spans a sandbox execution and, for compile and fallback, a model round trip. The
interleaving to construct is a `ctx_note update` or `dismiss` inside that
window.
Required faults and enabling state: an outstanding claim on a note, plus a
concurrent facade mutation of that note. No injected fault is needed.
Confidence: high — [evidence](evidence/note-b-completion-applies-only-under-the-claimed-revision-and-state-version.md).
Read the fence at `mc-store:13569-13573`, the `stale` terminal it produces
(`:13552-13561`), the reduced-status guard (`:13594-13606`), and the four
`fence_active_note_claims_tx` call sites on the mutation paths (`:4543`,
`:4602`, `:10500`, `:10558`). Confirmed the module side asserts only the phase
name (`lib.rs:14197-14202`), so the store fence is the sole protection for the
phase's eligibility predicate.
Existing check: `smart_note_revision_matrix_normative_matches_mc_store`
(`smart_note_evaluation.rs:1189-1526`), replaying
`testdata/smart-note-evaluation-normative.json`. Status `unaudited`. Not run in
CI.
Impact: if the fence regressed, a `due met` outcome computed against the old
condition would set `status = "ready"` and a host-derived `ready_reason` on a
note whose trigger text had since changed, surfacing the wrong note for the
wrong reason.
Open questions: None.

## Group F: phase accounting and the missing backoffs

Three records on the columns that decide how many model calls a note may consume.
`check_failure_count` is one column shared by two phases with two separate
thresholds (`MAX_COMPILATION_FAILURES` at `:36`, read at `:458`, and
`MAX_FAILURES_BEFORE_REAUTHOR` at `:38`, read at `:527` and `:539`), and neither
reducer resets the other's accumulation. Two phases then write no durable delay at
all, which the backoff table in the decision map above shows as its only two
blanks: `fallback` on a `False` outcome and `liveness` on `network_failed`. All
three records are cheap, all three are uncovered, and all three cost money when
they fire.

### note-b-check-failure-count-carries-across-compile-and-check-phases

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no fixture case drives a check failure and then a
compilation failure on the same note.
Guarantee: A note's compile-retry allowance is the allowance the compile phase
declares, independent of how many check failures the note accumulated
beforehand.
Check: `always` — for every note entering the compile phase, assert the number
of consecutive `compilation_failed` outcomes required to reach
`check_status == "fallback"` equals `MAX_COMPILATION_FAILURES`. `always`
because it must hold on every compile escalation evaluated.
Fault/timing angle: none, but the enabling state is a sequence: three
`due logic_failed` outcomes, then a recompile, then one `compilation_failed`.
Required faults and enabling state: a compiled note whose check returns
`logic_failed` three times (reaching `check_status == "failing"` with
`check_failure_count == 3`), then a compile-phase claim whose outcome is
`compilation_failed`.
Confidence: high — [evidence](evidence/note-b-check-failure-count-carries-across-compile-and-check-phases.md).
Traced `reduce_check_failure` incrementing the shared column
(`smart_note_evaluation.rs:525-531`), the `failing` status feeding the compile
selector (`:747`), and `reduce_compile` reading `pre.check_failure_count + 1`
against `MAX_COMPILATION_FAILURES` (`:455-462`). Confirmed the only reset is a
*successful* compile (`:486`).
Existing check: none. The golden's transition cases exercise each reducer arm
from a fresh pre-state, never across a phase change.
Impact: a note that reached `failing` gets one recompile attempt instead of
three, so a single transient compiler failure retires it to the read-only
fallback evaluator. Fallback never returns a note to `compiled`
(`smart_note_evaluation.rs:630-658`), so the demotion is permanent until the
condition is re-authored.
Open questions:

- Is the shared column intentional, on the reading that a note failing in either
  phase has burned the same trust budget? Both thresholds are 3, which is
  consistent with either intent. (needs human input)

### note-b-fallback-phase-writes-no-durable-backoff

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test polls a project whose only eligible note is in fallback and returns `False` from that fallback check. (Scoped this disposition, D9.)
Guarantee: Every phase completion that consumes a billable model call **and leaves the note re-selectable** writes a durable delay before that note can consume another.
Check: `always` — assert that after any `fallback` completion **whose outcome is `False`** the note's durable state advances at least one field that its own selector reads as a time gate. `always` because it must hold on every such completion evaluated. The restriction to the `False` arm is a correction applied this disposition (D9): `reduce_fallback` has two arms (`smart_note_evaluation.rs:636-657`), and the `Met` arm (`:637-646`) calls `ready_fields` and returns `surfaced: true`, so the note becomes `ready` and the candidate query, which selects only `status = 'pending'` (`mc-store:13293`), never offers it again. A completion that cannot recur needs no backoff, so quantifying over both arms asserts a requirement the code is right not to satisfy and the check would fail on correct behaviour. The record's own `Confidence` line had already scoped its evidence to the `False` arm; only the check over-quantified.
Fault/timing angle: the window is the cycle reset. A spent cursor answers
`no_work`, the store commits it fresh, the module resets the cursor
(`lib.rs:11258-11265`), and the next poll re-selects the same note.
Required faults and enabling state: one smart note with `check_status == "fallback"` **whose fallback evaluations return `False`**, and an evaluator that polls `note.evaluation.next` in a loop. No fault is required.
Confidence: high — [evidence](evidence/note-b-fallback-phase-writes-no-durable-backoff.md).
Confirmed `reduce_fallback`'s `False` arm writes only `last_checked_at`,
`updated_at`, and `check_status` (`smart_note_evaluation.rs:647-656`);
confirmed `get_fallback_smart_notes` has no `check_next_due_at` or
`check_quarantined_until` predicate (`:795`); confirmed the store adds no
per-note cooldown (`mc-store:13291-13301`); confirmed the fallback claim's cost
from the comment at `smart_note_evaluation.rs:818-821`.
Existing check: none. `MAX_FALLBACK_PER_RUN` (`:30`) bounds one cycle, not the
poll rate, and `attempted_fallback` (`:874`) is boot-ephemeral and reset with
the cycle.
Impact: a project with a small fallback set can be driven to one model call per
note per two polls indefinitely, with the poll rate set entirely by the
evaluator client. Every other phase has a durable delay; this one relies on an
in-memory list that a restart or a fresh `no_work` clears.
Open questions:

- Does the shipped evaluator worker impose its own inter-poll delay that bounds
  this in practice? The worker lives at
  `packages/plugin/src/features/magic-context/smart-notes/evaluator-worker.ts`
  and was not read in this pass. Unresolved, needs the worker's drain loop.

### note-b-liveness-network-failure-burns-the-window-with-no-durable-record

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test drives `liveness network_failed`.
Guarantee: A liveness attempt that failed for an environmental reason does not
consume the note's liveness opportunity, and is distinguishable in durable state
from an attempt that ran.
Check: `always` — assert that after a `liveness network_failed` completion
either `check_last_liveness_at` is unchanged or some other durable field records
the failure. `always` because it must hold on every liveness network failure
evaluated.
Fault/timing angle: the 24-hour `SMART_NOTE_CHECK_LIVENESS_RECHECK_MS` spacing
(`smart_note_evaluation.rs:26`) is what makes the consumed window expensive; the
next attempt is blocked for a day.
Required faults and enabling state: a compiled note false for at least 7 days
and outside the 24-hour spacing, claimed for `liveness`, whose sandbox check
cannot reach the network.
Confidence: high — [evidence](evidence/note-b-liveness-network-failure-burns-the-window-with-no-durable-record.md).
Confirmed `reduce_liveness` stamps `check_last_liveness_at = now` before
matching (`smart_note_evaluation.rs:591-593`) and that the `NetworkFailed` arm
returns that state unmodified (`:623-626`); contrasted with `reduce_due`'s
`NetworkFailed`, which routes through `reduce_check_failure` and writes a
counter and a quarantine (`:577-580`, `:536-547`); confirmed the spacing
predicate reads `check_last_liveness_at` (`:775-777`).
Existing check: none.
Impact: an evaluator with intermittent egress silently defers every staleness
escalation by 24 hours per blip, and nothing in the note, the response, or a log
says so. A note that should have been escalated to `failing` can stay
`compiled` and stale indefinitely while the operator sees a healthy check
status.
Open questions:

- Is burning the window deliberate, to keep a flapping network from hammering
  the liveness path? If so the missing record is still the finding, because
  `reduce_due` records the same condition and liveness does not. (needs human
  input)

## Group G: registration policy and unbounded growth

Three records on the registry and the candidate set it selects over. Two of them
are about a field that reads as a negotiated contract and is not one: the
registration's `policy_version` is validated, stored, bumped, echoed, and read
nowhere, and `retina_handoff` and `wake_owned` are read project-wide rather than
per registration, so one evaluator's policy governs another's selection. The third
is the growth term underneath both: every pending note is visited on every poll and
nothing caps how many pending notes there are. That absence is the counterpoint to
the ledgers, which are capped and reaped.

### note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test writes a large pending set and measures a poll.
Guarantee: The work an acquisition poll performs grows no faster than linearly in the pending set, and until a per-poll candidate ceiling is chosen that relation is the only bound there is.
Check: `always`, stated as an explicit scaling relation rather than against a constant: seed N and 2N pending notes into two identically prepared projects, poll each, and assert the number of rows the candidate query returns and the number of `SmartNoteSelectionSnapshot` values built are N and 2N respectively. `always` because it must hold on every poll evaluated. This replaces a check against "a declared constant" applied this disposition (D8): **there is no such constant.** The candidate query ends `ORDER BY id` with no `LIMIT` (`mc-store:13291-13301`), neither `insert_note` (`:10130-10164`) nor `insert_project_note` (`:10166-10200`) counts rows, and no reaper deletes notes by age or volume, so no finite workload could refute the earlier form. The scaling relation is refutable in both directions: a superlinear result refutes it, and so does a fix that makes growth sublinear, at which point the record should be restated against whatever bound the fix introduced.
Fault/timing angle: none. The growth is caller-driven and monotone.
Required faults and enabling state: a model or client that repeatedly calls `ctx_note` with a `surface_condition`, and no evaluator draining them, so each write lands as `status = 'pending'` and stays there. Two seeded sets at two sizes and two polls, per the scaling form of the check.
Confidence: high — [evidence](evidence/note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll.md).
Confirmed no count cap in `insert_note` (`mc-store:10130-10164`) or
`insert_project_note` (`:10166-10200`); confirmed the candidate query has no
`LIMIT` (`:13291-13301`); confirmed `smart_note_selection_snapshot` clones three
`String`s per note per poll (`lib.rs:13963-13985`); confirmed no reaper deletes
notes by age or volume, in contrast with the ledger reaper at
`mc-store:13119-13157`.
Existing check: none for note volume. `MAX_NOTE_CONTENT_BYTES` (`lib.rs:14395`)
bounds one note at 64 KiB, and `NOTE_EVAL_LEDGER_CAP` (`mc-store:2946`) bounds
in-flight claims. Neither bounds the pending note count.
Impact: per-poll cost is linear in the pending set with no ceiling, and the
pending set has no eviction. The snapshot's own doc comment
(`smart_note_evaluation.rs:690-692`) shows the per-poll cost was considered and
optimized, which makes the absent count cap the residual gap rather than an
oversight of the whole shape.
Open questions:

- Is there a cap or reaper elsewhere, for instance in a dreamer maintenance
  task outside this crate? I searched `mc-store` and `mc-module` and found
  none. Unresolved, needs a sweep of the plugin's maintenance tasks.
- What per-poll candidate ceiling should the product choose? Picking one and
  adding a `LIMIT` converts this record from a scaling oracle into an ordinary
  `always` against a named constant, which is a stronger property and a cheaper
  test, and retires the two-size seeding. (needs human input)

### note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration

Type: safety
Reachability: default-production
Status: active
Exercised: partial — the protocol tests register a single evaluator; none
registers two with conflicting policy.
Guarantee: An evaluator's acquisition decisions are governed by the policy that
evaluator registered, not by another registration's policy.
Check: `always` — with two live registrations for one project whose
`wake_owned` and `retina_handoff` differ, assert each `next` uses the calling
registration's own values. `always` because it must hold on every acquisition
evaluated.
Fault/timing angle: none, but the enabling state is a race in practice: two
plugin instances, or two worktrees of one repository, both bridging the same
project identity.
Required faults and enabling state: two `note.evaluation.register` calls for the
same authority project, from either the same or different routes, with
different `retina_handoff` or `wake_owned`.
Confidence: high — [evidence](evidence/note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration.md).
Read `live_note_evaluator_policy` accumulating with `|=` over every live entry
(`lib.rs:3889-3906`), its single call site at `:11166`, and confirmed
`registration.retina_handoff` and `registration.wake_owned` are read nowhere in
`handle_note_evaluation_next`. Confirmed registrations are keyed per project in
a `Vec` allowing up to 32 entries (`:2969`, `:10951-10956`).
Existing check: none.
Impact: one evaluator setting `wake_owned` vetoes every other evaluator's
acquisitions for that project (`lib.rs:11166-11172`), and one setting
`retina_handoff` narrows every other evaluator's eligibility filter through
`eligible` (`smart_note_evaluation.rs:704-707`). The hook comment at
`packages/plugin/src/hooks/magic-context/hook.ts:1030-1033` shows two worktrees
sharing one project identity is an anticipated configuration.
Open questions:

- Is the project-wide OR the intended semantics, on the reading that
  `wake_owned` describes a project-level wake plane rather than one evaluator's
  preference? The `NoteEvaluatorRegistration` doc comment (`lib.rs:2974-2976`)
  scopes the *project* to the route but says nothing about policy scope. (needs
  human input)

### note-b-registered-policy-version-never-reaches-selection

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test registers a `policy_version` that disagrees with
the module constant and checks the effect.
Guarantee: Changing a registration's `policy_version` changes something observable about which notes that registration is offered. (Narrowed this disposition, D7: the earlier form also promised that the field is "documented as informational", which is a review outcome rather than a runtime state.)
Check: `always` — assert that for two registrations differing only in `policy_version`, the set of notes each is offered is identical. `always` because it must hold on every acquisition evaluated. The documentation conjunct was removed this disposition (D7): no harness can evaluate whether a doc comment exists and says something adequate, and a check that cannot be evaluated is worse than a missing one because it will be marked done when the runnable half passes. That judgment is now an open question below.
Fault/timing angle: none.
Required faults and enabling state: two registrations with different
`policy_version` values, both non-negative, against a project holding notes at
`policy_version` 0 and 1.
Confidence: high — [evidence](evidence/note-b-registered-policy-version-never-reaches-selection.md).
Grepped every `policy_version` occurrence in `lib.rs:10880-11500`: the field is
validated at `:10916-10919`, stored at `:10964`, bumped at `:11045`, and echoed
at `:11050`, and read nowhere else. Selection compares the *note's*
`policy_version` against the module constant
(`smart_note_evaluation.rs:723`, `:749`, `:773`).
Existing check: none.
Impact: an evaluator running an older or newer compiled-check policy is admitted
and offered notes regardless, and the module has no way to refuse a mismatched
evaluator. A registration that echoes an accepted `policy_version` reads as a
negotiated contract and is not one. The bump at `:11045` further overwrites the
caller's registered value on any policy change, so the echoed number is not even
the value the caller sent.
Open questions:

- Is `policy_version` reserved for a future compiled-check policy negotiation,
  or is it vestigial from the retired `note.evaluate` protocol? (needs human
  input)
- If the field is deliberately inert, should that be stated at the registration
  handler, so a caller reading the closed schema does not read the echo as a
  negotiated contract? This is the documentation half D7 removed from the check.
  (needs human input)

## Group H: observability and retirement

Three records on what an operator can learn and what a user can undo. Note
evaluation emits nothing: `smart_note_evaluation.rs` and the whole protocol range
`:10880-11560` contain zero `tracing`, `log`, `warn!`, `debug!`, or metric calls,
and the only assertion is a `debug_assert!` at `:11251-11254` that release builds
drop. So a starved note and a legitimately-not-due note are indistinguishable from
every surface. Dismissal is the retirement counterpart and is the good half of the
same story, readable forever and never restorable. The group closes with the
cursor-exhaustion marker, without which the plumbing whose failure mode is silent
starvation is untested end to end.

### note-b-excluded-note-is-not-reportable-by-any-surface

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing asserts any observability on this path.
Guarantee: When an acquisition returns no work while eligible-looking notes
exist, the reason is attributable from outside the module.
Check: `always` — for every fresh `no_work` decision committed against a
non-empty candidate set, assert at least one durable or emitted signal names the
excluding cause. `always` because it must hold on every such decision
evaluated.
Fault/timing angle: none.
Required faults and enabling state: a non-empty pending smart-note set in which
every note is excluded by a phase predicate, a quarantine, a
`check_next_due_at` in the future, or the `attempted_fallback` list, plus one
`note.evaluation.next` poll.
Confidence: high — [evidence](evidence/note-b-excluded-note-is-not-reportable-by-any-surface.md).
Verified zero `tracing`, `log`, `warn!`, `debug!`, `info!`, `error!`, or
`trace!` calls in `smart_note_evaluation.rs` (whole-file grep, count 0) and in
`lib.rs:10880-11560` (range scan, no matches). Confirmed the only signals a
caller receives are `result: "no_work"`, `replayed`, and the optional
`cycle_exhausted` flag (`lib.rs:14017-14031`), none of which names a note or a
predicate. Confirmed the sole assertion is a `debug_assert!` at `:11251-11254`,
absent from release builds.
Existing check: none.
Impact: a note starved by an off-policy `policy_version`, a stuck quarantine, or
a mis-set `retina_handoff` from another registration is indistinguishable from a
note that is legitimately not due, from every surface an operator has. The facade
lens found several ways an error path can look successful in this same part; this
is the same shape one layer down, where the successful-looking answer is
`no_work`.
Open questions:

- Is note evaluation intended to be observable only through the evaluator
  client's own logging, given the client is the one that knows the phase
  semantics? If so, the module still cannot report a starved note, because the
  client never learns which notes were considered. (needs human input)

### note-b-dismissed-note-is-readable-but-never-returns-to-evaluation

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test dismisses a smart note and then reads it back with
`filter: "dismissed"`.
Guarantee: Dismissal is a retrievable retirement, not a destruction: the content
survives and is readable, and the note is permanently removed from evaluation.
Check: `always` — assert that after a successful dismissal the row still exists
with its pre-dismissal content as a prefix of its current content, that a
`ctx_note read` with `filter: "dismissed"` returns it, and that no facade action
returns it to `pending`, `ready`, or `active`. `always` because both halves must
hold on every dismissal evaluated.
Fault/timing angle: none for the read half. For the evaluation half the window
is a live claim at dismissal time, which `fence_active_note_claims_tx` must
close.
Required faults and enabling state: a smart note in `pending` or `ready`, a `ctx_note dismiss`, then a `ctx_note read` with `filter: "dismissed"` and a `ctx_note update` on the same id. The oracle needs **four calls**, not three: the create is not setup, because it is the call that establishes the pre-dismissal content the read half asserts is a prefix of the post-dismissal content, so without it the first conjunct has no baseline. (Corrected this disposition, D1.)
Confidence: high — [evidence](evidence/note-b-dismissed-note-is-readable-but-never-returns-to-evaluation.md).
Confirmed `dismiss_note` UPDATEs and never DELETEs, and appends rather than
replaces the resolution (`mc-store:4574-4596`); confirmed the dismissed status
is a readable filter (`lib.rs:11721`) and is inside the `filter: "all"` set
(`:11722-11729`); confirmed `update` rejects a dismissed note by filtering the
loaded status to `active | pending | ready | surfacing | surfaced`
(`lib.rs:11806-11813`, store `:10529`); confirmed the candidate query only ever
sees `status = 'pending'` (`mc-store:13293`); confirmed the claim fence at
`mc-store:4602`.
Existing check: none found for the dismissed round trip. The facade lens records
the dismiss-not-found arm at `lib.rs:11902-11907` as an error text memoized as a
command success; that is
[facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes](#facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes),
not this one.
Impact: this is the answer to "is a dropped note recoverable": yes for reading,
no for evaluation. If the fence at `mc-store:4602` regressed, a late `met`
completion would set `status = "ready"` on a dismissed note and resurrect it
into the surfacing path.
Open questions:

- Is the absence of an un-dismiss action deliberate? A user who dismisses by
  mistake can read the note but must re-author it. (needs human input)

### note-b-cursor-exhausted-no-work-occurs-in-a-campaign

Type: reachability
Reachability: default-production
Status: active
Exercised: partial — the normative cycle traces
(`smart_note_evaluation.rs:1764-1851`) drive cursor exhaustion in the pure
selector; nothing drives it through the store and the response.
Guarantee: A campaign reaches the state where an acquisition returns no work
because the fair-selection cursor is spent while real work remains, and the
`cycle_exhausted` flag is what distinguishes it from a drained queue.
Check: `sometimes` — a constant marker `NOTE_CYCLE_EXHAUSTED_NO_WORK_OBSERVED` fires when a fresh `no_work` response carries `cycle_exhausted: true` while the project holds at least one note that a fresh cycle would select. `sometimes` because this is situation coverage, not location coverage: a campaign can execute `lib.rs:11220-11229` and always compute `false`, never producing the operational state the branch exists for. The marker name is added this disposition (D6): the record previously stated its condition in prose and named nothing, while its sibling supplied `FACADE_MUTATION_REPLAY_OBSERVED`, and METHOD.md requires marker names to be constant, globally unique, and never constructed dynamically. The name is checked for uniqueness against that sibling and against `fault-map.md`'s coverage table.
Fault/timing angle: the window is one poll wide. The cursor is spent at the
moment of the poll and reset immediately afterwards
(`lib.rs:11258-11265`), so a campaign that polls once per drain never sees it.
Required faults and enabling state: a `Full`-mode slot cursor advanced past at
least one phase (so `phase_index > 0`, permanently skipping earlier phases for
this cycle, documented at `smart_note_evaluation.rs:864-868`), with work newly
eligible in a skipped phase, or the fallback quota spent with fallback notes
remaining. Then one more `note.evaluation.next` on that slot.
Confidence: high — [evidence](evidence/note-b-cursor-exhausted-no-work-occurs-in-a-campaign.md).
Traced the flag's computation from a *fresh* cycle (`lib.rs:11220-11229`), the
store persisting `"no_work_exhausted"` versus `"no_work"`
(`mc-store:13314-13328`), the replay decoding it back
(`mc-store:13300-13310`), and the response field (`lib.rs:14023-14030`).
Existing check: `smart_note_cycle_traces_normative_matches_selection_policy`
(`smart_note_evaluation.rs:1764-1851`) replaying
`testdata/smart-note-evaluation-normative.json`. It covers the pure selector's
exhaustion, not the durable classification or the response. Status `unaudited`.
Not run in CI.
Impact: without this state in a campaign, the `cycle_exhausted` plumbing is
untested end to end, and its failure mode is silent starvation. The comment at
`lib.rs:11215-11219` states the consequence directly: a cursor left mid-cycle by
a deadline-truncated drain would otherwise report the next drain's first poll as
a drained queue.
Open questions: None.

## Cross-part relationship

Two cross-part threads run through this catalog.

**The claim intent ledger is 4d's, and no 4c handler uses it.** Part 4c's
architectural note records that none of its fourteen mutating handlers consults
`memory_tool::stage_claim_intent`, `inspect_claim_intents`, or
`acknowledge_claim_intent`, and that each reinvents a narrower identity with no
request digest. The three handlers themselves are in this part, at `:10082-10182`,
and two records here are about their identity semantics rather than their absence
elsewhere:
[facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity](#facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity)
and
[facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault](#facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault).
The digest guard 4c wants is real (`mc-store:11049-11051`), and this part finds
that the module collapses its conflict into the same code as an I/O failure, so
adopting the ledger would give a 4c handler a protection whose refusal reason it
still could not classify.

**Part 3's silently-dropped transition write is not reachable from this surface.**
Part 3 establishes that `set_claim_intent_transition_tx` returns `Ok(())` when its
`is_lower_hex` guard fails (`mc-store:4118-4126`). No facade handler reaches it:
the four callers are authority transitions reached through the flat `method`
surface (`:12255`, `:12257-12267`), which the shipped plugin drives from
`packages/plugin/src/features/magic-context/context-authority.ts:829-1072`. That
puts the reachability question in 4c's range rather than this one.

**One 4c record's consumer lives here.** 4c's
`h4c-state-sync-durable-write-and-capability-flag-are-not-replayed-together` ends
with an in-memory note-evaluation capability flag that is never set on a retry, and
its consumer is `refuse_conditioned_note_without_evaluator` (`:15318-15339`),
inside this part's range and the same gate
[facade-a-misspelled-surface-condition-silently-writes-a-plain-note](#facade-a-misspelled-surface-condition-silently-writes-a-plain-note)
bypasses by a typo. So the refusal that protects a conditioned write can be
defeated from either side: the flag never gets set, or the key never gets read.

## Relationship map

Grouped by shared mechanism rather than by the section headings above, because
several of the sharpest relationships cross groups. Every dominance statement
below is a **hypothesis** about which oracle subsumes which, offered to guide
ordering, not a verified claim; none of them has been tested, because none of
these records has an executing check.

- **One open argument map, four consequences.**
  [facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic](#facade-a-open-tool-schemas-accept-unknown-argument-keys-without-diagnostic),
  [facade-a-misspelled-surface-condition-silently-writes-a-plain-note](#facade-a-misspelled-surface-condition-silently-writes-a-plain-note),
  [facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source](#facade-a-reduced-summary-envelope-is-an-unvalidated-argument-source),
  [facade-a-transform-class-byte-cap-probe-diverges-from-the-router](#facade-a-transform-class-byte-cap-probe-diverges-from-the-router).
  All four rest on `facade_arguments` (`:14419-14435`) cloning a map it never
  walks, or on the probe that decides which cap a body faces. After D4 the first
  two are deliberately disjoint rather than overlapping: the compatibility-key
  record excludes keys within one edit of a read key, and the typo record demands
  a diagnostic naming exactly those. Hypothesis: neither dominates the other, and
  a single implementation change — walking the key set and classifying each key as
  read, compatible, or near-miss — would satisfy both at once, which is why they
  are grouped. All three argument records share one harness constraint recorded in
  D3: never compare two sequential mutating calls byte for byte, because the store
  mints ids into the text (`:11704`) and a shared `command_id` adds a `replayed`
  field (`:15303`). Compare at the parser level or against two cloned stores.
- **An acknowledgement that is not an effect.**
  [facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes](#facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes),
  [facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect](#facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect),
  [facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed](#facade-a-claim-effects-ack-and-producer-checkpoint-advance-are-never-composed).
  Three records, one shape, three very different costs, and the cost spread is why
  the third exists. `ctx_reduce` and the claim-effects module half are each one
  call plus a store read; the composition needs a cross-language process pair that
  does not exist. Hypothesis: the module-local claim-effects record *does not*
  dominate the composition record, and that is the finding D11 made legible: a
  green module-local check says the module wrote something or declined, and says
  nothing about whether the producer's checkpoint means what it claims. Both
  records also share the corrected oracle discipline: effect accounting is a screen
  on a path that attempts an effect, and neither of these handlers attempts one, so
  a two-sided bound with both ends at zero constrains nothing.
- **Identity, and what a refusal tells the caller.**
  [facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity](#facade-a-claim-intent-inspect-and-ack-discard-the-bound-route-identity),
  [facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault](#facade-a-claim-intent-digest-conflict-is-indistinguishable-from-a-store-fault),
  [facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes](#facade-a-mutation-ledger-memoizes-error-bearing-responses-as-command-outcomes).
  Three records on durable identity records and the codes that describe them. The
  first two are on handlers with zero module-side coverage, so the first test
  written against either establishes the fixture for both. Hypothesis: the
  route-identity record *hypothetically dominates* nothing but is the most
  consequential, because it is the only record in the part whose failure crosses a
  project boundary; the digest-conflict record is strictly a classification
  property and its fix, a `claim_mirror_error`-style classifier, is already
  demonstrated 3,700 lines away (`:13844-13857`). The ledger-memoization record
  joins them because it is the same question at the response layer: the store
  distinguishes outcomes the module collapses.
- **Determinism, and the one place it leaks.**
  [note-b-selection-is-invariant-under-candidate-permutation](#note-b-selection-is-invariant-under-candidate-permutation),
  [note-b-reducer-reads-process-local-timezone-for-durable-schedule](#note-b-reducer-reads-process-local-timezone-for-durable-schedule),
  [note-b-completion-applies-only-under-the-claimed-revision-and-state-version](#note-b-completion-applies-only-under-the-claimed-revision-and-state-version).
  The purity cluster, and D12 changed its shape. The reducer is pure over its
  declared inputs and the timezone is one of them, so the permutation record and
  the timezone record are not two halves of one purity claim: the first is a
  property of the selector, and the second is a property of the **call site** that
  chooses what to pass. Hypothesis: no dominance, and a cost inversion worth
  noting. The permutation record is free, a pure-function property test over a
  permuted slice. The timezone record is the most expensive constructible record in
  the part, because a reducer differential cannot see it and two real processes with
  different `chrono::Local` are required. The completion fence sits with them
  because it is what makes any of the reducer's determinism matter: a deterministic
  decision applied to the wrong revision is still wrong.
- **A phase that spends a model call and writes no delay.**
  [note-b-fallback-phase-writes-no-durable-backoff](#note-b-fallback-phase-writes-no-durable-backoff),
  [note-b-liveness-network-failure-burns-the-window-with-no-durable-record](#note-b-liveness-network-failure-burns-the-window-with-no-durable-record),
  [note-b-check-failure-count-carries-across-compile-and-check-phases](#note-b-check-failure-count-carries-across-compile-and-check-phases).
  The two blanks in the backoff table plus the shared counter that decides how many
  attempts a note gets. Hypothesis: no dominance, but they compose into one
  scenario nobody has constructed. A note demoted to fallback by the shared counter
  (three `due logic_failed` outcomes then one `compilation_failed`) lands in the one
  phase that writes no durable delay, and fallback never returns a note to
  `compiled` (`:630-658`), so the composition is a permanent demotion into an
  unthrottled loop. Each record is cheap alone; the composition is the expensive
  claim and needs a sequenced workload rather than a seeded row.
- **A field, a policy, and a set that nobody bounds.**
  [note-b-registered-policy-version-never-reaches-selection](#note-b-registered-policy-version-never-reaches-selection),
  [note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration](#note-b-wake-owned-and-retina-handoff-are-project-wide-not-per-registration),
  [note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll](#note-b-pending-candidate-set-is-unbounded-and-fully-materialized-per-poll).
  Three records on the registry and its candidate set. The first two share one
  fixture, two registrations for one project, and are the cheapest pair in this
  group. Hypothesis: the `wake_owned` record *hypothetically dominates* the
  policy-version record's harness but not its claim, since both need the same two
  registrations and only one of them observes a selection difference. The growth
  record is outside that relation and, after D8, is the only record in the part whose
  oracle is a scaling relation rather than an invariant over one observation, which
  is also why a product decision on a per-poll ceiling would retire the shape of the
  test rather than merely strengthen it.
- **Situation coverage, so the rest is not vacuous.**
  [facade-a-replayed-facade-mutation-occurs-in-a-campaign](#facade-a-replayed-facade-mutation-occurs-in-a-campaign),
  [note-b-cursor-exhausted-no-work-occurs-in-a-campaign](#note-b-cursor-exhausted-no-work-occurs-in-a-campaign),
  [note-b-excluded-note-is-not-reportable-by-any-surface](#note-b-excluded-note-is-not-reportable-by-any-surface).
  The part's two `sometimes` records, plus the observability record whose subject is
  the same absence they witness. After D6 both markers are named and unique,
  `FACADE_MUTATION_REPLAY_OBSERVED` and `NOTE_CYCLE_EXHAUSTED_NO_WORK_OBSERVED`.
  Hypothesis: the replay marker *dominates* nothing but is a precondition for three
  ledger-dependent records, and the cursor marker is a precondition for nothing
  except the honesty of the `cycle_exhausted` plumbing, whose failure mode is silent
  starvation. The observability record is grouped with them because it is the reason
  both markers are hard: nothing in this subsystem emits anything, so a campaign
  that wants to witness a situation has to read durable state or the response, and
  those are the only two surfaces there are.

