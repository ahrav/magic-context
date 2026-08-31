# Lens B: the nudge overlay's own lifecycle and the injection surface

Part 4e sub-part, second lens. `HEAD` `e447c927`. Every `file:line` in this file
was read back at that commit.

Scope taken: what gets injected into a served request, when, on whose authority,
and what bounds it. The sibling lens
[`lens-a-rendered-output.md`](lens-a-rendered-output.md) owns how the result is
rendered, the tag numbering authorities, the composition order, and the user-hint
character caps. This lens does not restate any of its twelve records.

Primary files: `crates/mc-module/src/injection.rs` (911 lines), the overlay
regions of `crates/mc-module/src/transform.rs`, the overlay tables and commit
path in `crates/mc-store/src/lib.rs`, and the two harness encoders in
`crates/mc-module/src/codec/`. `boundary.rs` turned out to hold nothing on this
subject: it contains one occurrence of the word "synthetic" (`:559`) and that is
a comment about a threshold, so it is cited nowhere below.

## Overlay lifecycle map

There are five distinct injected things. They do not share a lifecycle, and the
differences are where the properties live.

### 1. The tag prefix (`§N§`)

Owned by the sibling lens. Named here only because it shares the
`TagOverlayState` container (`transform.rs:1724-1729`) and the single application
site, so its ordering interacts with the other four.

### 2. The temporal marker (`<!-- +5m -->`)

- **What it is.** An HTML comment prepended to the first text block of an
  authored user message, encoding the gap since the previous provider response
  (`transform.rs:8205`). Only minted when the gap clears
  `TEMPORAL_AWARENESS_THRESHOLD_MS` (5 minutes, `:112`); otherwise a row with an
  empty `marker_text` is still written to record the decision
  (`:8707-8717`).
- **Created by.** `compute_active_overlay_decisions` (`:8574`), inside the loop
  at `:8641-8719`. Requires `temporal_enabled`, which is
  `tagging_active && ctx.temporal_awareness` (`:3525`).
- **Persisted as.** One `mc_temporal_marks` row per block
  (`mc-store/src/lib.rs:608-617`), primary key `(session_id, block_id)`.
- **First-apply gate.** Yes. The commit only inserts when the message ordinal is
  strictly above the stored overlay frontier
  (`mc-store/src/lib.rs:7526-7541`), which is the mechanism whose stated purpose
  is "to avoid first-applying overlays to closed turns"
  (`mc-store/src/lib.rs:6506-6507`).
- **Consumed.** On every render, for as long as the block is in the projection
  (`transform.rs:8245-8247`). Never marked consumed.
- **Retired by.** Nothing except a lineage descent, which deletes and then
  re-copies the rows to the descended key (`mc-store/src/lib.rs:8642-8654`,
  `:8736-8739`). There is no age or count reaper.

### 3. The auto-search user hint (`<ctx-search-hint>`)

- **What it is.** Up to three caveman-compressed fragments of stored compartment
  bodies, wrapped in a `<ctx-search-hint>` element and **appended to the user's
  own text block** (`transform.rs:9084-9117`, applied at `:8249-8250` via
  `append_user_hint_to_block` at `:8345-8355`).
- **Created by.** `maybe_decide_live_user_hint` (`:8766-8823`), called at
  `:4442` when `auto_search_active` (`:3519`).
- **Persisted as.** One `mc_user_hints` row per block
  (`mc-store/src/lib.rs:592-601`), primary key `(session_id, block_id)`. An
  empty-text row is a durable "decided, nothing to say" record and suppresses
  future queries for that block (`transform.rs:8794`, filter at `:8157-8161`).
- **First-apply gate.** Two of them. The overlay frontier at commit
  (`mc-store/src/lib.rs:7541-7546`), and a second render-time guard:
  `user_hint_target_was_served` (`transform.rs:8565-8572`) parks the hint in
  `meta.pending_user_hint_block_ids` when the target block already appears in
  `served_output_fingerprint` and this is not a bust pass (`:4452-4459`).
- **Consumed.** On every render while the row is present and non-empty and the
  block is not parked.
- **Retired by.** One reaper exists, and it is caller-driven: when the host sets
  `user_hints_replace_session`, the store deletes every stored hint absent from
  the host's batch (`mc-store/src/lib.rs:7736-7760`). The field's own doc
  explains why (`:3263-3268`). No age or count reaper.

### 4. The Channel-1 reminder (`<system-reminder>` appended to a tool result)

- **What it is.** A `<system-reminder>` block appended to the text of a tail tool
  result, telling the agent how many unreduced tokens have built up and naming up
  to four reclaimable tags (`transform.rs:9841-9860`, applied at `:8251-8252`
  via `append_channel1_to_block` at `:8356-8361`).
- **Created by.** `maybe_append_channel1_nudge` (`:9142-9177`), called at `:5335`
  whenever `tagging_active`. **There is no bust-pass gate on this call.**
- **Persisted as.** One `mc_channel1_appends` row per block
  (`mc-store/src/lib.rs:563-572`), primary key `(session_id, block_id)`. The
  production write is the `INSERT OR IGNORE` inside the transform commit
  (`:7559-7573`); `append_channel1_nudge` (`:6461-6478`) carries
  `allow(dead_code)` outside test builds and is not a production path.
- **First-apply gate.** **None.** Unlike the temporal mark and the user hint, the
  Channel-1 insert at `mc-store/src/lib.rs:7559-7573` is not wrapped in the
  `previous_frontier` comparison, and nothing consults
  `served_output_fingerprint`. The target selector only requires the block to be
  in the tail (`transform.rs:9798`, `is_tail` at `:6471-6473`), which admits a
  block a previous render already served. Record
  `nudge-b-channel1-append-first-applies-without-a-frontier-gate`.
- **Consumed.** On every render, forever, for any loaded row whose block is still
  in the projection. `tag_overlay_state` (`:8161-8165`) applies no filter at all
  to the Channel-1 map, not even the empty-text filter the temporal and hint maps
  use.
- **Retired by.** Nothing. Record
  `nudge-b-channel1-append-rows-have-no-reaper`.
- **Refire suppression.** Two mechanisms. `existing_blocks`
  (`:9159-9163`) prevents a second row on the same block, so a refire lands on a
  different block. `decide_channel1`'s escalation-or-cadence gate
  (`:9607-9612`) is the real throttle. The third documented mechanism,
  `channel1_reduce_suppressed`, is never set outside a test. Record
  `nudge-b-channel1-suppression-flag-is-never-set`.

### 5. The Channel-2 directive

This is the one overlay the module does **not** apply. It authorizes the host to
inject, and returns the text in the response (`transform.rs:5692-5693`). Two
completely different lifecycles, selected by serializer profile at `:9346-9377`.

**OpenCode arm (`SerializerProfile::OpencodeAiSdk`, `:9347-9365`).**

- Suppressed only by the caller's echoed `channel2_nudge_state` string being one
  of `"pending" | "claimed" | "delivered"` (`:9348`).
- Carries **no directive id, no lease, no arming watermark, and no TTL**. The
  returned shape is `Channel2NudgeDirective { text }` (`:1122-1125`).
- Writes **no** module state. `channel2_pressure` takes `&ModuleMeta`
  (`:9380-9383`) and does not set `channel2_pressure_latched`.
- Consequence: the module's own two rearm paths,
  `rearm_channel2_after_hard_fold` (`:9412-9421`) and
  `rearm_channel2_after_measured_collapse` (`:9423-9433`), clear state
  (`rearm_channel2_cycle`, `:9407-9410`) that this arm never reads. They are
  inert for the only profile the shipped host sends. Record
  `nudge-b-opencode-channel2-arm-has-no-module-side-latch`.
- The host owns the lease and its reaper
  (`packages/plugin/src/features/magic-context/storage-meta-persisted.ts:1132-1146`,
  `storage-db.ts:586-596`).

**Claude Code arm (`SerializerProfile::ClaudeCodeAnthropic`, `:9366-9376`).**

- `claude_code_channel2_directive` (`:9435-9502`) keeps a durable
  `meta.pending_channel2_directive` with a `directive_id` derived from
  `(session_id, arming_watermark)` (`channel2_directive_id`, `:9505-9513`), an
  `armed_at_ms`, and a monotonically increasing `arming_watermark` (`:9490`,
  `:9494`).
- Retired by three paths: the caller echoing a matching
  `channel2_delivered_id` (`:9440-9448`), the
  `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` expiry of 10 minutes (`:111`, checked at
  `:9450-9458`), and pressure falling below the gate (`:9479`).
- Record `nudge-b-channel2-retirement-is-caller-asserted`.

### 6. The synthetic todowrite pair

The heaviest injection in the crate: two whole messages, an assistant `ToolCall`
and a `tool` `ToolResult`, inserted into the served array.

- **What it is.** `SyntheticTodo` (`injection.rs:66-76`), built byte-exactly from
  a normalized todo-state JSON by `build_synthetic_todo_pair`
  (`injection.rs:133-192`). The call id is
  `mc_synthetic_todo_<sha256[:16]>` of the normalized state
  (`injection.rs:121-125`), so the bytes are a pure function of the state.
  Timestamps are pinned to `SYNTHETIC_TIMESTAMP = 0` (`injection.rs:29`,
  `:355-358`) so the pair is stable across passes.
- **Created by.** `advance_synthetic_todo` (`transform.rs:7442-7475`), which
  calls `advance_injection_from_meta` and on `Replace` freezes the pair with an
  anchor mid (`:7458-7460`). The state it builds from is
  `ModuleMeta::last_todo_state`, captured from the visible tail by
  `capture_todo_state_on_bust` (`injection.rs:206-222`).
- **Persisted as.** `ModuleMeta::synthetic_todo`, a `FrozenSyntheticTodoPair`
  (`injection.rs:81-88`), inside the cache-state row. Not a separate table.
- **Consumed.** Rendered on every pass while frozen and
  `synthetic_todo_enabled`. Two mutually exclusive insertion sites: unanchored
  before the tail loop (`transform.rs:11804-11832`) and anchored inside it
  (`:12091-12121`), guarded by `inserted_synthetic_todo`.
- **Retired by.** `InjectionOutcome::Clear` on a bust pass when the current state
  is empty or all-terminal (`injection.rs:325-331`, applied at
  `transform.rs:7461`); and by the stale-anchor drop in
  `reanchor_kept_synthetic_todo_if_folded_or_shrunk`
  (`transform.rs:7495-7500`). A defer pass can never clear it
  (`injection.rs:306-312`). Record
  `nudge-b-frozen-todo-pair-retires-only-on-a-bust`.

### Can an overlay be consumed twice, or never?

**Never consumed: yes, and this is the normal steady state.** None of the five
overlays has a consumption record. A `mc_channel1_appends`, `mc_temporal_marks`,
or `mc_user_hints` row is re-applied on every render for as long as its block is
in the projection, and is never marked used. "Consumption" is not a state
transition in this design; it is a per-render read. The only thing that stops a
row rendering is the block leaving the projection, which leaves the row in the
database indefinitely.

**Consumed twice within one render: no, by construction.** All four applied
overlays live in `BTreeMap<String, _>` keyed by `block_id`
(`transform.rs:1724-1729`), so at most one string of each kind exists per block,
and each mutator is idempotent against its own output: the temporal mutator
checks `starts_with` (`:8338`), the hint mutator checks `ends_with` (`:8350`),
and the Channel-1 mutator checks `ends_with` (`:8364`, `:8375`). The synthetic
pair is fenced by `inserted_synthetic_todo` (`:12091`, set at `:12119`), and a
frozen pair whose anchor never rendered is a hard error, not a silent skip
(`:12125-12132`).

**Consumed twice across renders: yes, and for Channel-1 that is a defect.** A
Channel-1 row with no frontier gate can be first-applied to a block a previous
render already served, which changes bytes the provider has already cached. That
is the one place where "applied again" is not the intended replay. Record
`nudge-b-channel1-append-first-applies-without-a-frontier-gate`.

## Injection decision map

### What decides that the synthetic pair is injected

Three independent inputs, read in this order:

1. `is_bust_pass` (`transform.rs:4439`) — derived from the pass plan, not from
   the caller. A defer pass short-circuits to `Keep` or `None`
   (`injection.rs:306-312`) and never builds.
2. `todo_synthesis_verdict(req)` (`transform.rs:2626-2630`) — collapses
   `req.todo_tool_present: Option<bool>` to `Some(unwrap_or(false))`. A
   `Some(false)` verdict substitutes the literal `"[]"` for the persisted state
   (`injection.rs:314-318`), which drives a `Clear`.
3. `meta.last_todo_state` — durable per-session, so an aged-out todowrite keeps
   injecting until another bust captures a new view (`injection.rs:224-228`,
   test at `:707-721`).

**Deterministic:** yes, and provably so. Every function in `injection.rs` is
pure over its arguments; the only impure input is the hash, which is SHA-256 over
the normalized state. `transition_is_deterministic` (`injection.rs:834-849`)
asserts two identical calls agree and that the built pair equals a fresh build.
`key_order_scrambling_keeps_call_id_stable` (`:851-864`) asserts the
normalization erases JSON key order and extra fields.

**Idempotent across a repeated render:** yes. Same state plus same frozen unit
yields `Keep`, asserted by `same_state_bust_is_idempotent`
(`injection.rs:615-624`). The `Replace` arm is only taken when the call id
differs (`:333-340`), and the call id is a function of the state alone.

### What decides that a Channel-1 reminder is injected

`decide_channel1` (`transform.rs:9562-9622`) over `TailHygieneBaseline` plus two
durable memo fields. The gates, in order: baseline evaluable and not
generation-invalidated (`:9590-9592`); the suppression flag (`:9593-9595`, never
set); floors `CHANNEL1_MIN_TOKENS = 60_000` and `CHANNEL1_FLOOR_TOKENS = 25_000`
(`tail_hygiene.rs:15-16`, checked at `transform.rs:9596-9598`); severity above
`CHANNEL1_GENTLE_FRACTION = 0.20` (`:110`, checked `:9599-9601`); the band
ladder (`:9603-9609`); and finally escalation-or-cadence (`:9610-9613`) where
the cadence step is `max(25_000, 0.08 * tail_tokens)`
(`channel1_refire_tokens`, `:9624-9627`).

**Deterministic:** yes over `(baseline, meta)`. Both `active_tags_for_nudge`
(`:9248`) and the hygiene rows are explicitly sorted (`:9244`, `:9275`), and
`oldest_reclaimable_hint` (`:9825-9839`) takes the first four in that order.

**Idempotent across a repeated render:** only because of durable state, not
because of the decision. The first firing writes
`meta.channel1_last_nudge_undropped` and `..._level` (`:9154-9155`) and inserts
the row; the second pass then fails the cadence gate and finds the block in
`existing_blocks`. If the commit does not land, the identical request
re-evaluates identically and produces the identical row, so a retry is safe. But
note that `:9154-9155` write the memo **before** the fire check, so a quiet
evaluation also mutates `meta` and therefore forces a commit
(`state_changed` at `:5555`, `commit_required` at `:5558-5559`).

### What decides that a Channel-2 directive is authorized

On the OpenCode arm: the caller's `channel2_nudge_state` string
(`transform.rs:9348`) and `channel2_pressure` clearing
`CHANNEL2_FLOOR_TOKENS = 50_000` and `CHANNEL2_SEVERITY_THRESHOLD = 0.75`
(`tail_hygiene.rs:17-18`, checked `transform.rs:9385-9388`).

**Idempotent across a repeated render: no.** With no module-side latch, an
identical request with an empty `channel2_nudge_state` returns the directive
again on every pass. The suppression is entirely the caller's to assert.

### Trust classification of the injection inputs

| Input | Source | Module validation |
| --- | --- | --- |
| `todo_tool_present` | caller | collapsed to a bool, `None` treated as false (`transform.rs:2628-2629`) |
| `channel2_nudge_state` | caller | three string literals matched, anything else fails open (`:9348`) |
| `channel2_delivered_id` | caller | compared to the pending id, otherwise unverified (`:9440-9445`) |
| `todo_synthetic_anchor` | caller, via state sync | `pair.call_id == seed.call_id` after a local rebuild (`lib.rs:9174-9176`) |
| `auto_search_hint_decisions` | caller, via state sync | `valid_drop_seed_block_id` per row (`mc-store/src/lib.rs:7762-7765`, fn at `:4636`) |
| tail `todowrite` ToolCall input | caller / agent | `normalize_todo_state_json` (`injection.rs:110-118`), whole state rejected on any malformed item |
| tool-call ids in ingress | caller / harness | prefix-only namespace check (`injection.rs:195-197`) |

The `todo_synthetic_anchor` check is worth stating precisely because it is easy
to over-read: it is a **self-consistency checksum**, not authentication. The
caller supplies `state_json`, the module rebuilds the pair from it, and the
supplied `call_id` must equal the hash of what was rebuilt. A caller who computes
the hash correctly can seed any todo `content` string it likes, and those strings
reach the provider array verbatim.

## Observations

`file:line` for everything. All read back at `HEAD` `e447c927`.

1. `transform.rs:2626-2630` — `todo_synthesis_verdict` returns
   `Some(req.todo_tool_present.unwrap_or(false))`. It can never return `None`.
   Every production call to the injection API goes through it (`:4155`,
   `:4529`, `:4826`, `:7454`).
2. `injection.rs:205`, `:228`, `:299` — three doc comments state that a missing
   availability verdict "fails open for legacy senders". `transform.rs:738-741`
   states the opposite for the same field: "None is a provisional or
   legacy-sender verdict and fails closed". The code implements fail-closed.
3. `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1945-1951`
   and `:2023-2024` — the shipped host always computes
   `todoToolPresent` as a `boolean` and always sends it, so the absent-field
   case does not arise there either.
4. `mc-store/src/lib.rs:2458-2461` — `channel1_reduce_suppressed` is documented
   as "Set by ctx_reduce after the agent has acted on a reminder." A repository
   grep finds exactly six occurrences of the identifier: the field itself, three
   production reads (`transform.rs:9156`, `:9565`, `:9593`), one production
   clear (`transform.rs:9157`), and one write to `true`, at
   `transform.rs:23577`, inside a `#[test]`.
5. `transform.rs:9156-9160` — `was_suppressed` is read, the flag is cleared, and
   the function returns `None` with no record anywhere that a nudge was
   suppressed. Same shape as the sibling's record 2.
6. `transform.rs:5335` — `maybe_append_channel1_nudge` is called under
   `if tagging_active` alone. There is no `is_bust_pass` condition, and
   `refresh_tail_hygiene_baseline` (`tail_hygiene.rs:636-690`) returns an
   `evaluable: true` baseline on a non-busting refresh whenever the measured
   prefix still matches (`:665-682`), so the decision can fire on a defer pass.
7. `mc-store/src/lib.rs:7526-7541` versus `:7541-7546` versus `:7559-7573` —
   temporal marks and the user hint are both gated on
   `previous_frontier`; the Channel-1 insert is not. The frontier's documented
   purpose is at `:6506-6507`.
8. `transform.rs:9798` — the Channel-1 target selector requires
   `is_tail(block.ordinal, meta.coverage_ordinal)`, which is
   `ordinal > coverage` (`:6471-6473`). A block served on an earlier pass is
   still in the tail.
9. `transform.rs:8161-8165` — `channel1_by_block_id` is built with no filter.
   The sibling maps for temporal (`:8152-8156`) and user hint (`:8157-8161`)
   both filter empty text, and the hint map also filters the parked set.
10. `mc-store/src/lib.rs` — a grep for the three overlay tables finds no
    `DELETE` other than `mc_user_hints`' host-driven replace-delete (`:7754`)
    and the lineage-descent wipe of the target key (`:8642-8654`), which is
    immediately followed by a copy from the source key (`:8736-8751`). There is
    no age reaper, no count cap, and no byte cap for any of the three.
11. `transform.rs:9347-9365` — the OpenCode Channel-2 arm reads
    `channel2_nudge_state` and `channel2_pressure`, and writes nothing. It never
    consults or sets `meta.channel2_pressure_latched`, which only the Claude Code
    arm uses (`:9483`, `:9493`).
12. `transform.rs:9412-9433` — both module rearm helpers call
    `rearm_channel2_cycle` (`:9407-9410`), which clears
    `pending_channel2_directive` and `channel2_pressure_latched`. Neither field
    is read by the OpenCode arm, so on the only profile the shipped host sends
    (`rust-mode-transform.ts:1339`) both helpers have no observable effect.
13. `transform.rs:9440-9448` — the Claude Code arm retires the pending directive
    when `channel2_delivered_id` matches `pending.directive_id`. The id is
    returned to the caller in the response (`:5692-5693`), so echoing it back is
    trivially available; nothing else corroborates delivery.
14. `transform.rs:9505-9513` — `channel2_directive_id` is
    `sha256("mc-channel2-directive-v1\0" || session_id || "\0" ||
    arming_watermark.to_be_bytes())`. Deterministic, and derivable by anyone who
    knows the session id and the watermark.
15. `transform.rs:9549-9555` versus `:9557-9560` —
    `build_channel2_reminder_text` returns bare prose;
    `build_channel2_host_reminder` wraps the same prose in `<system-reminder>`.
    The Claude Code arm returns the bare form (`:9491`), so the provenance
    wrapper on that arm is the host's responsibility.
16. `transform.rs:2405-2421` — `normalize_synthetic_todo_ingress` force-sets
    `meta.synthetic = true` on any inbound message containing a `ToolCall` or
    `ToolResult` whose id starts with `mc_synthetic_todo_`
    (`is_synthetic_todo_id`, `injection.rs:195-197`, prefix-only and asserted so
    at `:906-910`). A synthetic message is then excluded from the tail loop
    (`transform.rs:12126-12128`) and from overlay application (`:8222-8224`).
    Nothing in the response records the reclassification.
17. `crates/mc-module/src/codec/opencode.rs:388` and `:916-947` — the OpenCode
    encoder collapses the injected pair into a single part carrying
    `"syntheticTodoMarker": true` (`:946`). The `synthetic: true` part field is
    only set for `role == "user"` messages (`:993-997`), so the pair relies on
    the todo marker.
18. `crates/mc-module/src/codec/pi.rs:582-607` — the pi encoder emits no
    synthetic marker of any kind; the injected assistant half becomes an
    ordinary `role: "assistant"` entry with `"stopReason": "stop"`
    (`:596-604`). `encode_pi` has no caller outside `codec/mod.rs`'s own tests
    (`codec/mod.rs:208-209`, `:249`), so the pi encode path is not on a
    production route today.
19. `mc-store/src/lib.rs:59-75` — `HarnessMeta::synthetic` is serialized on the
    CK wire, so the host can always distinguish the injected pair from real
    agent work. That distinction stops at the host; nothing in the module marks
    the pair for the model.
20. `transform.rs:8521-8538` — `is_system_reminder_transport_message` decides
    injected-versus-authored purely from text shape, and its own comment says
    so: "CK intentionally has no transport-origin field for this Claude Code
    shape ... the narrowest safe discriminator is a message made entirely of
    balanced reminder wrappers." `is_authored_user_message` (`:8541-8550`) is
    built on it and gates the temporal marker, the user hint, and the authored
    user tail window.
21. `transform.rs:8989-8997` — `has_stacked_user_hint_augmentation` suppresses a
    new hint when the raw prompt already contains `<sidekick-augmentation>`,
    `<ctx-search-hint>`, or `<ctx-search-auto>`. It inspects the user's own
    bytes, so a user who types one of those strings suppresses the feature, and
    a user who types the full envelope produces something the model cannot tell
    from an injected hint.
22. `transform.rs:8843-8961` — `run_user_hint_lexical_search` reads only
    `store.load_compartment_candidates` (`:8866`). No notes and no commits are
    searched, which does not match the schema description of the feature (see
    the contract leads).
23. `transform.rs:1145-1310` — `TransformTimings` carries `tag_mint_new`
    (`:1218`) but no count for Channel-1 firings or suppressions, temporal marks
    minted, user-hint decisions, or Channel-2 arms and retirements. Only per-stage
    milliseconds exist for those (`:1182-1187`, `:1203-1212`).
24. `transform.rs:8230-8254` — the per-block mutator order is tag prefix,
    temporal prefix, user hint, Channel-1 reminder. Because the tag is prepended
    first and the temporal comment second, the served text of a user block that
    carries both begins with the comment and then the tag.
25. `transform.rs:9174-9176` — the reminder's `fired_at_ms` is `ctx.now_ms`, and
    `load_channel1_appends` orders by `fired_at_ms ASC, block_id ASC`
    (`mc-store/src/lib.rs:6484-6489`). Two rows written in the same millisecond
    are ordered by block id, so the load order is total and deterministic even
    under a coarse clock.

## Candidate properties

### nudge-b-frozen-todo-pair-retires-only-on-a-bust

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `defer_never_clears_but_bust_does` (`injection.rs:600-613`)
and `defer_after_capture_replays_frozen_bytes` (`:739-771`) assert exactly this
for `advance_injection`. Neither covers the `transform.rs` wrapper, and no
`mc-module` lib test runs in CI.
Guarantee: A frozen synthetic todo pair changes or disappears only on a
cache-busting pass; on a defer pass its bytes are replayed verbatim.
Check: `always` — for every pass with `is_bust_pass == false`, assert
`meta.synthetic_todo` before the pass equals `meta.synthetic_todo` after it, and
that the two emitted synthetic messages are byte-identical to the previous
render's. `always` because a defer pass that mutates the pair rewrites a prefix
the provider has already cached, which is wrong on every occurrence.
Fault/timing angle: The window is one pass. The hazard is a plan
misclassification, not an interleaving.
Required faults and enabling state: `req.todo_tool_present == Some(true)`,
`meta.last_todo_state` populated, a frozen pair present, and a pass whose plan is
not `Hard`, `MigrateHard`, or `Soft` (`transform.rs:4435-4439`). Then a second
pass with a *different* visible todowrite state on the same plan.
Confidence: high — [evidence](../evidence/nudge-b-frozen-todo-pair-retires-only-on-a-bust.md).
Verified the defer short-circuit at `injection.rs:306-312`, the `Clear` arm at
`:325-331` and its only caller `transform.rs:7461`, and the stale-anchor drop at
`transform.rs:7495-7500`. Verified that `capture_todo_state_on_bust` also
refuses on a non-bust pass (`injection.rs:212-214`), so the metadata cannot move
either.
Existing check: `injection.rs:600-613`, `:739-771`, `:585-598`; none run in CI.
Impact: A defer pass that swapped the pair would change bytes mid-prefix,
busting the provider prompt cache and, on Anthropic, presenting a tool result the
model never asked for at a position it has already reasoned past.
Open questions:
- The stale-anchor arm at `transform.rs:7495-7500` drops the pair on a *bust*
  when the anchor vanished without a coverage move. Can the same vanish happen
  on a defer pass, where `reanchor_kept_synthetic_todo_if_folded_or_shrunk` is
  not called (`:7462-7470`)? If so the render then fails with
  `SyntheticTodoAnchorMissing` (`:12125-12132`) rather than dropping. Unresolved,
  needs a pass-plan trace.

### nudge-b-todo-availability-fail-open-is-unreachable

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `provisional_verdict_keeps_capture_and_composition_fail_open`
(`injection.rs:626-644`) and `aged_out_todowrite_injects_from_module_meta`
(`:706-721`) both pass `None` directly to the injection API and assert the
fail-open behaviour. No test drives that behaviour through
`todo_synthesis_verdict`, and none runs in CI.
Guarantee: The injection API's documented fail-open-on-missing-verdict path
either is reachable from a production request, or the documentation is corrected.
Check: `always-or-unreached` — assert that whenever
`advance_injection`/`capture_todo_state_on_bust` are entered from a production
call site, `todo_tool_present` is `Some(_)`; and separately assert that when it
is `None` the fail-open branch is safe. `always-or-unreached` is the right
semantics because the branch is a documented optional path that may legitimately
never execute, but must be correct if a future call site does reach it.
Fault/timing angle: None.
Required faults and enabling state: To reach the branch at all, a caller of
`advance_injection` that is not `todo_synthesis_verdict`. None exists today
(`transform.rs:4155`, `:4529`, `:4826`, `:7454` are the four production sites and
all four route through it).
Confidence: high — [evidence](../evidence/nudge-b-todo-availability-fail-open-is-unreachable.md).
Verified `todo_synthesis_verdict` at `transform.rs:2626-2630`, enumerated its
four production callers by grep, and verified the shipped host always sends a
boolean (`rust-mode-transform.ts:1945-1951`, `:2023-2024`,
`resolveCombinedTodowriteVerdict` returns `Promise<boolean>` at `:141-171`).
Existing check: `injection.rs:626-644`, `:646-659`, `:706-721`; none run in CI.
Impact: Low as a live bug, high as a maintenance trap. Three doc comments in
`injection.rs` describe behaviour the crate cannot exhibit and that a fourth doc
comment in `transform.rs` explicitly forbids. A future caller that trusts the
`injection.rs` wording would manufacture a synthetic tool call without host
authority, which is precisely what `transform.rs:739-741` says must never happen.
Open questions:
- Which of the two doc comments is the intended contract? Fail-closed is what
  ships and is the safer reading; the `injection.rs` wording is at minimum
  stale. (needs human input)

### nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `synthetic_id_detection_is_prefix_only`
(`injection.rs:906-910`) pins the prefix-only rule. Nothing tests what
`normalize_synthetic_todo_ingress` does to a non-module message that happens to
carry such an id, and no `mc-module` lib test runs in CI.
Guarantee: A message the module removes from the served array because its
tool-call id falls in the synthetic namespace is either genuinely module-authored,
or the removal is reported.
Check: `always` — for every pass, assert that the set of mids
`normalize_synthetic_todo_ingress` marks synthetic is a subset of the mids the
module itself injected in an earlier render, or else that the response carries a
field naming each reclassified mid. `always` because silently deleting an
authored message from the provider array is wrong on every occurrence.
Fault/timing angle: None. It runs once per request at `transform.rs:3243`.
Required faults and enabling state: One inbound `CkIngressMessage` with
`meta.synthetic == false` containing a `ToolCall` or `ToolResult` whose id starts
with `mc_synthetic_todo_`. The benign producer is the harness replaying our own
injected pair. The adversarial producer is any path that lets a tool-call id be
chosen upstream.
Confidence: medium — [evidence](../evidence/nudge-b-synthetic-namespace-reclassifies-ingress-without-a-report.md).
The mechanism is verified from source: the force-set at
`transform.rs:2414-2415`, the tail-loop exclusion at `:12126-12128`, and the
overlay exclusion at `:8222-8224`. What is not established is whether any
production path lets a non-module actor choose a tool-call id, which is a harness
codec question and therefore 4f scope.
Existing check: `injection.rs:906-910`; does not run in CI.
Impact: A whole message leaves the served conversation with no error and no
response field. If it carried a real tool result, the matching tool call becomes
an orphan, which is exactly the shape the sibling lens found has no production
detection (`render-a-orphan-tool-arc-has-no-production-detection`).
Open questions:
- Can a tool-call id reaching `decode_opencode` or `decode_pi` be chosen by
  anything other than the harness itself? Unresolved, needs 4f.
- Is the prefix check deliberately loose so that a pair frozen under an older
  hash scheme still round-trips? The comment at `transform.rs:2405` does not say.
  (needs human input)

### nudge-b-injected-todo-pair-carries-no-provider-visible-provenance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `ck_pair_byte_determinism_golden` (`injection.rs:866-904`)
asserts `meta.synthetic` is set on both halves, and
`serve_native_golden_preserves_ingress_and_pins_synthetic_shapes`
(`codec/mod.rs:93-127`) pins the encoded shape. Neither asserts anything about
what the model can distinguish.
Guarantee: Content the module injects into the served conversation is
distinguishable from content the user or the agent authored, at the layer that
consumes it.
Check: `always` — for every emitted message, assert that either it corresponds
to an ingress message, or it carries a provenance marker on the surface its
consumer reads. `always` because an unmarked injection misattributes authorship
on every pass it is served. Pair it with a coverage check asserting the
independent preconditions: a pass in which `meta.synthetic_todo` is `Some` and
`synthetic_todo_enabled` is true, plus the serializer profile under test.
Fault/timing angle: None.
Required faults and enabling state: A frozen pair and `synthetic_todo_enabled`
(`transform.rs:5388-5389` passes `tail_reclaim_enabled && !req.is_subagent`).
Confidence: high — [evidence](../evidence/nudge-b-injected-todo-pair-carries-no-provider-visible-provenance.md).
Verified three layers. CK wire: `HarnessMeta::synthetic` is serialized
(`mc-store/src/lib.rs:64-65`), so the host can always tell. OpenCode native
encode: `"syntheticTodoMarker": true` (`codec/opencode.rs:946`, reached from
`:388`). Provider array: the module does not build it, and the only marker that
survives into the tool-call id is the `mc_synthetic_todo_` prefix
(`injection.rs:23`, `:139`). The pi encoder emits nothing (`codec/pi.rs:582-607`)
but has no production caller, verified by grep.
Existing check: `codec/mod.rs:93-127`, `:290-297`; neither runs in CI.
Impact: The model is shown an assistant `todowrite` call and result it never
made, with a `completed` status and a zero timestamp
(`injection.rs:345`, `:355-358`). It cannot tell that from its own work, so it
may reason about the todo list as something it already did. The three text
overlays are better off: Channel-1 and Channel-2 carry `<system-reminder>`
(`transform.rs:9859`, `:9559`), the hint carries `<ctx-search-hint>`
(`:9111`), and the temporal mark is an HTML comment (`:8205`). All four of those
markers are plain text a user or a tool result can forge, so they are a
convention, not a boundary.
Open questions:
- Is the `mc_synthetic_todo_` id prefix intended as the provenance marker for
  the model? It is deterministic and visible in the Anthropic `tool_use` id, so
  it is a real signal, but nothing documents it as one. (needs human input)
- Does the OpenCode host propagate `syntheticTodoMarker` into anything the model
  sees, or only into its own storage? Host scope, outside 4e. Unresolved.

### nudge-b-channel1-append-first-applies-without-a-frontier-gate

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`transform.rs:23551-23590`) exercises firing and replay, but every block it
targets is newly added, so it never constructs the previously-served case. It
does not run in CI.
Guarantee: An overlay is first-applied only to a block that no earlier render has
served, so an accepted pass never rewrites bytes already in the provider prefix.
Check: `always` — for every accepted pass, assert that each newly inserted
overlay row's `block_id` is absent from
`loaded.meta.served_output_fingerprint`. `always` because a retroactive prefix
edit is a cache-correctness failure on every occurrence, not only under a race.
Fault/timing angle: None strictly required. The interesting window is a defer
pass, where the pass is contractually not supposed to change replayed bytes at
all.
Required faults and enabling state: `tagging_active` (needs
`serializer_profile` in `{opencode-aisdk, claude-code-anthropic}` and
`tool_present`, `lib.rs:568-577`, plus the persisted-or-bootstrap condition at
`transform.rs:3503-3504`); a hygiene baseline that fires `decide_channel1`; and
the newest eligible tail tool result being one an earlier pass already served.
The last condition is constructible: newer tool results are excluded when their
output is JSON (`tool_result_can_carry_channel1`, `:9809-9823` rejects `Json`,
`ErrorJson`, `ExecutionDenied`), when they are frozen `red:` targets
(`:9799`), or when they already carry a row (`:9800`), and `max_by_key`
(`:9804`) then falls back to an older block.
Confidence: high — [evidence](../evidence/nudge-b-channel1-append-first-applies-without-a-frontier-gate.md).
Verified the three-way asymmetry at the commit site: temporal gated at
`mc-store/src/lib.rs:7526-7541`, user hint gated at `:7541-7546`, Channel-1
ungated at `:7559-7573`. Verified the frontier's stated purpose at `:6506-6507`.
Verified `is_tail` admits a served block (`transform.rs:6471-6473`, used at
`:9798`), and that `refresh_tail_hygiene_baseline` keeps the baseline evaluable
on a non-busting refresh (`tail_hygiene.rs:665-682`), so the firing pass need not
be a bust.
Existing check: `transform.rs:23551-23590`; does not run in CI.
Impact: A `<system-reminder>` appears inside a tool result the provider has
already cached, so the prefix diverges and the whole cached prompt is discarded.
On the divergence path this also shows up as a served-fingerprint mismatch
(`transform.rs:5513-5520`), which is a report of the symptom, not a prevention.
Open questions:
- Is the missing gate deliberate on the grounds that Channel-1 only ever targets
  a fresh tool result? The selector does not encode that assumption, and the
  three fallback conditions above defeat it. (needs human input)
- Does the served-output divergence record (`divergence::first_divergence`,
  `:5513`) actually fire for this case, and is it surfaced anywhere an operator
  reads? Unresolved, needs `divergence.rs`, which is 4b/4c scope.

### nudge-b-channel1-append-rows-have-no-reaper

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts a bound on the row count, and none observes
the table across a long session.
Guarantee: The durable overlay tables are bounded, and something removes a row
whose purpose is spent.
Check: `always` — assert `count(mc_channel1_appends WHERE session_id = ?)` stays
at or below an explicit documented bound across a session, and that a row whose
target block has left the projection is eventually removed within a stated number
of passes. `always` on the bound because exceeding it is wrong whenever it
happens; the removal half needs the bound stated in passes, per the liveness
rule, and no such bound exists in the code today.
Fault/timing angle: None. This is accumulation over a long session, not a race.
Required faults and enabling state: `tagging_active`, and a session long enough
for `decide_channel1` to clear the escalation-or-cadence gate repeatedly. The
cadence step is `max(25_000, 0.08 * tail_tokens)` tokens of newly unreduced tool
output (`transform.rs:9624-9627`), so each additional row costs the agent that
much unreduced growth.
Confidence: high — [evidence](../evidence/nudge-b-channel1-append-rows-have-no-reaper.md).
Verified by grepping every statement touching the three overlay tables in
`mc-store/src/lib.rs`: the only `DELETE`s are the host-driven
`user_hints_replace_session` replace-delete (`:7754-7759`) and the
lineage-descent wipe of the *target* key (`:8642-8654`), which is immediately
undone by a copy from the source key (`:8736-8751`). No age predicate, no count
cap, no byte cap, and no `PRAGMA`-level bound exists for
`mc_channel1_appends` or `mc_temporal_marks`.
Existing check: none.
Impact: Two costs. The database grows by one row of roughly 300 reminder bytes
per firing forever, which is the same unbounded-caller-driven-growth shape prior
parts recorded. More importantly a stale row is inert only while its block is out
of the projection; if a block id is ever reconstructed on a later pass the old
reminder reappears, quoting a token count from a session state that no longer
exists.
Open questions:
- Can a `block_id` be reconstructed after leaving the projection? Block ids are
  `ck_wire::block_id(&message_id, block_index)`, so a message that re-enters the
  request with the same mid and block layout would collide. Whether that happens
  depends on the projection cache and lineage handling, which is 4b scope.
  Unresolved, needs 4b.
- Should the reaper key on the overlay frontier, on tag retirement, or on
  compartment coverage? A design decision. (needs human input)

### nudge-b-channel1-suppression-flag-is-never-set

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `channel1_hygiene_ratio_nudge_replays_and_suppresses_refire`
(`transform.rs:23551-23590`) covers the suppression *effect*, but only by writing
the flag directly into the store at `:23577`. That is the only write to `true`
in the repository. The test does not run in CI.
Guarantee: The documented ctx_reduce feedback loop exists: after the agent acts
on a reminder, the next transform suppresses new Channel-1 appends.
Check: `always` — assert that on any pass following a `ctx_reduce` that froze at
least one reduction, `decide_channel1` takes the suppressed arm
(`transform.rs:9593-9595`) on the next transform for that session. `always`
because the documented contract is unconditional once the antecedent holds.
Fault/timing angle: The window is between the `ctx_reduce` facade commit and the
next transform pass. If the flag were ever set, the clear at
`transform.rs:9157` would consume it on the first `tagging_active` pass, so the
suppression is a single-pass token.
Required faults and enabling state: A `ctx_reduce` call that applies a reduction,
followed by a `tagging_active` transform pass. The suppression cannot be observed
because nothing sets the flag.
Confidence: high — [evidence](../evidence/nudge-b-channel1-suppression-flag-is-never-set.md).
`git grep reduce_suppressed` over the whole worktree returns six lines: the field
(`mc-store/src/lib.rs:2461`), three reads (`transform.rs:9156`, `:9565`,
`:9593`), one clear to `false` (`transform.rs:9157`), and one write to `true`
inside `#[test]` (`transform.rs:23577`). The TypeScript side has no
`reduceSuppressed` equivalent, checked by the same grep.
Existing check: `transform.rs:23551-23590`; does not run in CI and only reaches
the code by writing the store directly.
Impact: The agent that complies with a reminder gets no credit for it. Refire is
throttled only by the cadence gate, which keys on `reclaimable_tokens` growth
(`:9610-9611`). Since a compliant reduction *lowers* reclaimable tokens, the
`reset_cycle` arm at `:9565-9566` fires instead and zeroes the memo, which
re-arms the ladder from `Gentle`. So compliance resets the nudge cycle rather
than suppressing it, which is a different behaviour from the documented one.
Open questions:
- Was the writer removed, or never written? `mc_store::ModuleMeta` carries the
  field with `#[serde(default)]` (`:2460`), so a stored `true` from an older
  writer would still be honoured. Whether such a writer ever shipped needs the
  history. (needs human input)

### nudge-b-opencode-channel2-arm-has-no-module-side-latch

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — `nudge_formula_tests` (`transform.rs:9629-9783`) covers the
band arithmetic only. No test drives `channel2_directives` twice with the same
inputs on the OpenCode arm.
Guarantee: A Channel-2 authorization is emitted at most once per arming cycle, so
a repeated render does not re-authorize an injection the host has already
performed.
Check: `always` — for two consecutive passes with identical inputs and a
`channel2_nudge_state` the caller did not change, assert the second pass returns
`host_directives == None`. `always` because a duplicate authorization is wrong on
every occurrence. Pair it with a coverage check on the independent preconditions:
`SerializerProfile::OpencodeAiSdk`, `channel2_pressure(..).due == true`, and
`req.channel2_nudge_state.is_empty()`.
Fault/timing angle: The window is any pass sequence in which the host's lease
write does not land before the next transform: a crashed host between the
response and its `setChannel2NudgeState`, a lost response, or a caller that
simply never implements the field.
Required faults and enabling state: `serializer_profile == "opencode-aisdk"`,
reclaimable tokens at or above `CHANNEL2_FLOOR_TOKENS` (50_000,
`tail_hygiene.rs:17`), severity at or above 0.75 (`:18`), and an empty or
unrecognized `channel2_nudge_state`.
Confidence: high — [evidence](../evidence/nudge-b-opencode-channel2-arm-has-no-module-side-latch.md).
Verified the arm reads only `channel2_nudge_state` and pressure
(`transform.rs:9347-9365`), that `channel2_pressure` takes `&ModuleMeta` and so
cannot latch (`:9380-9383`), that `channel2_pressure_latched` is read and written
only in the Claude Code arm (`:9483`, `:9493`), and that both module rearm
helpers clear state this arm never reads (`:9407-9410`, `:9412-9433`). Verified
the shipped host sends `opencode-aisdk`
(`rust-mode-transform.ts:1339`) and owns the lease and its stale-claim reaper
(`storage-meta-persisted.ts:1132-1146`, `storage-db.ts:586-596`).
Existing check: none on the Rust side. The host side has
`packages/plugin/src/hooks/magic-context/channel2-delivery.test.ts`.
Impact: On the profile that actually ships, the module's idempotence for
Channel-2 is entirely delegated to the caller with no verification and no
fallback. A caller that never sets the field gets a `<system-reminder>` injected
on every pass while pressure is high, which is the nagging failure mode the
arming watermark exists to prevent on the other arm. It also means the two
module rearm helpers are dead code in the shipped configuration, which is a
maintenance hazard: a reader sees a rearm protocol that is not wired up.
Open questions:
- Is the delegation deliberate, with the module treating the OpenCode host as
  the sole lease owner? The comment at `transform.rs:3509-3511` says tags are
  kept available on non-CC profiles so "the OpenCode host can receive the same
  ceiling decision", which reads as deliberate. It does not address the missing
  latch. (needs human input)
- The host clears a `pending` lease pre-delivery only when it authored the text
  itself; a module-supplied `directiveText` deliberately skips revalidation
  (`channel2-delivery.ts:155-166`). Can a module-authored `pending` wedge? Host
  scope. Unresolved.

### nudge-b-channel2-retirement-is-caller-asserted

Type: safety
Reachability: explicit-config-only
Status: active
Exercised: not yet — no test drives `claude_code_channel2_directive` with a
`channel2_delivered_id`.
Guarantee: A pending Channel-2 directive is retired only when it was actually
delivered, or else the retirement is bounded so a lost directive is re-armed.
Check: `always` — assert that `meta.pending_channel2_directive` transitions to
`None` only via a matching `channel2_delivered_id`, the lease TTL, or a pressure
collapse, and that no other input clears it. `always` because a directive retired
without delivery is silently lost every time it happens.
Fault/timing angle: The retirement is a same-pass decision, but the interesting
window is the 10 minutes of `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` (`:111`): inside
it, only the caller's word retires the directive; outside it, the TTL re-arms
regardless of what the caller said.
Required faults and enabling state: `serializer_profile ==
"claude-code-anthropic"`. This is the reason for the `explicit-config-only`
label: the string appears in `crates/mc-module` tests, in `ARCHITECTURE.md:125`,
and in the profile-epoch table (`lib.rs:552`), but no TypeScript sender in this
repository emits it. The only shipped sender emits `opencode-aisdk`
(`rust-mode-transform.ts:1339`). `ARCHITECTURE.md:125` describes a CC leg as a
real deployment, so the arm is presumably reachable from a proxy outside this
tree.
Confidence: medium — [evidence](../evidence/nudge-b-channel2-retirement-is-caller-asserted.md).
The mechanism is verified from source: the delivered-id comparison at
`transform.rs:9440-9448`, the TTL at `:9450-9458`, the pressure collapse at
`:9479`, and the id derivation at `:9505-9513`. What is not established is
whether the CC leg is live and, if so, whether the proxy has an independent
record of delivery. Both are outside this tree.
Existing check: none.
Impact: A caller can retire a directive it never delivered by echoing an id the
module handed it one pass earlier, and the agent then never sees the housekeeping
warning for that cycle. The TTL bounds the damage to one arming cycle, which is
the right shape; the concern is that the primary retirement path has no
corroboration at all.
Open questions:
- Is the CC leg live? If not, this whole arm plus `channel2_directive_id`, the
  arming watermark, and the lease TTL are unreached in the shipped
  configuration, which would change the label to something closer to
  `test-only`. Unresolved, needs deployment knowledge. (needs human input)
- The `arming_watermark` is monotonic per session (`:9489-9494`) and the id is a
  hash over `(session_id, watermark)`. Is the watermark ever exposed so an id
  could be predicted before it is issued? Not from the transform response, which
  only carries the id itself. Recorded as resolved in the evidence file.

### nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `empty_user_hint_decision_skips_future_queries`
(`transform.rs:23075-23090`) and the query-sanitization tests
(`:23030-23133`) cover the decision and the query. Nothing asserts anything
about the authorship boundary of the appended bytes.
Guarantee: Text the module appends to a user's message is attributable to the
module rather than to the user, on the surface the model reads.
Check: `always` — for every emitted `role: "user"` text block, assert that the
block's bytes equal the ingress bytes plus only prefixes and suffixes that carry
a provenance envelope, and that the envelope cannot be produced by ingress bytes
alone. `always` because a misattributed sentence is wrong every time it is
served. Pair it with a coverage check on the preconditions: `auto_search_active`,
a hint decision with non-empty text, and the target block rendering in this pass.
Fault/timing angle: None.
Required faults and enabling state: Default configuration is enough.
`memory.auto_search.enabled` defaults to `true`
(`CONFIGURATION.md:682`, `assets/magic-context.schema.json:1607-1612`,
`transform.rs:865-867`), `auto_search_active` needs only a non-subagent request
(`:3519`), the prompt must clear `DEFAULT_AUTO_SEARCH_MIN_PROMPT_CHARS` of 20
(`config.rs:40`, checked `:8806`), at least two non-stopword tokens must match
(`USER_HINT_MIN_MATCHED_TOKENS`, `:118`, checked `:8861`), and the top score
must clear `DEFAULT_AUTO_SEARCH_SCORE_THRESHOLD` of 0.6 (`config.rs:39`, checked
`:8955-8959`).
Confidence: high — [evidence](../evidence/nudge-b-auto-search-hint-injects-unauthored-text-into-a-user-block.md).
Verified the append target is the user's own text block
(`transform.rs:8249-8250`, `append_user_hint_to_block` at `:8345-8355` pushes
onto `CkKind::Text`), that the envelope is the plain string
`<ctx-search-hint>` (`:9111`), and that the same string in ingress bytes is
treated as an existing augmentation (`has_stacked_user_hint_augmentation`,
`:8989-8997`), which proves the envelope is forgeable from the user side.
Verified the injected fragments come from stored compartment bodies
(`run_user_hint_lexical_search` reads only `load_compartment_candidates`,
`:8866`), so the content is earlier-conversation material this turn's author did
not write.
Existing check: `transform.rs:23075-23090`, `:23030-23048`, `:23049-23073`;
none run in CI.
Impact: The provider sees a user message that ends with three fragments of
earlier conversation plus the instruction "If the fragments above seem relevant
to the current request, you may run ctx_search to retrieve full context"
(`:9109`). Attributed to the user, that reads as the user's own instruction. The
module's own code shows it knows this is a text convention and not a boundary:
`is_system_reminder_transport_message`'s comment says CK "intentionally has no
transport-origin field" and settles for a text-shape discriminator
(`:8525-8527`).
Open questions:
- Is a caller-supplied value causing this? Yes, indirectly and by design: the
  user's own prompt is the search query, so the caller's bytes select which
  unauthored content gets injected. Recorded as resolved in the evidence file.
- Should the envelope be structural, for example a separate block with a typed
  kind, rather than a text marker? That changes the provider prefix and so is a
  design decision. (needs human input)

### nudge-b-overlay-suppression-and-firing-are-unreportable

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing asserts the observability of an overlay decision.
Guarantee: Every overlay decision that changes what the agent sees, or that
suppresses something the agent would have seen, is observable in the response.
Check: `always` — for every accepted pass, assert that the response carries a
count for each of: Channel-1 fired, Channel-1 suppressed, temporal marks minted,
user-hint decisions taken, user-hint decisions parked, Channel-2 armed, and
Channel-2 retired. `always` because an unreportable decision is unobservable on
every pass, and the whole class of defects above is invisible without it.
Fault/timing angle: None.
Required faults and enabling state: None. Any `tagging_active` pass exercises it.
Confidence: high — [evidence](../evidence/nudge-b-overlay-suppression-and-firing-are-unreportable.md).
Read the whole of `TransformTimings` (`transform.rs:1144-1310`) and confirmed it
carries `tag_mint_candidates`, `tag_mint_new`, and
`tag_mint_tokenized_bytes` (`:1217-1221`) but no count field for any other
overlay. Confirmed the four overlay stages contribute milliseconds only
(`:1182-1187` for the store reads, `:1203` for `user_hint`, `:1211-1212` for
`tag_overlay` and `temporal`). Confirmed `format_pass_timing_line`
(`:1315-1400`) emits those timings and no overlay counts. Confirmed the
suppression return at `:9156-9160` writes nothing.
Existing check: none. This is the same shape as the sibling's
`render-a-emptied-tail-message-drops-without-a-report`, on a different path.
Impact: Every other record in this lens is hard to detect in production for the
same reason. A Channel-1 nudge that fires on a served block, a hint parked
forever because a bust never comes, a Channel-2 directive retired without
delivery: none of them leave a counter. The only adjacent signal is the
served-output divergence record (`:5513-5520`), which reports the byte symptom
without naming the cause.
Open questions:
- Is `tag_mint_new` the intended precedent, meaning the other overlays were
  simply never given counters, or is there a deliberate reason tags are counted
  and reminders are not? (needs human input)

### nudge-b-one-block-carries-several-overlay-kinds

Type: reachability
Reachability: default-production
Status: active
Exercised: not yet — `tag_overlay_replays_stably_and_new_tail_gets_next_number`
(`transform.rs:23307`) and the Channel-1 test (`:23551`) each exercise one
overlay kind at a time. No test constructs a block carrying three.
Guarantee: A campaign reaches the state where one block carries more than one
overlay kind at once, so the fixed mutator order and the interaction between
envelopes is actually exercised.
Check: `sometimes` — assert that at least once per campaign a single `block_id`
appears in two or more of `tag_by_block_id`, `temporal_by_block_id`,
`user_hint_by_block_id`, `channel1_by_block_id` on the same accepted pass, and
separately at least once in three of them. `sometimes` and not `reachable`
because `apply_tag_overlay_to_message`'s lines execute on every tagging pass;
what a campaign can easily miss is the operational *situation* of a
multiply-overlaid block, which is where the ordering and the envelope
interactions live.
Fault/timing angle: None. This is situation coverage, not a race.
Required faults and enabling state: Two reachable combinations. On an authored
user text block: a minted tag, a gap above 5 minutes since the previous response
so the temporal marker is non-empty (`transform.rs:8168-8173`), and a hint
decision with non-empty text. That needs `temporal_active`
(`tagging_active && ctx.temporal_awareness`, `:3525`; `temporal_awareness`
defaults on per `CONFIGURATION.md:644`) plus `auto_search_active`. On a tool
result block: a minted tag plus a Channel-1 reminder, which needs the tool result
to be text-bearing (`tool_result_can_carry_channel1`, `:9809-9823`) and
`decide_channel1` to fire.
Confidence: high — [evidence](../evidence/nudge-b-one-block-carries-several-overlay-kinds.md).
Verified the four maps are independent `BTreeMap`s keyed by the same
`block_id` (`:1724-1729`), that all four are consulted for the same `block`
inside one loop iteration (`:8233-8254`), and that the order is fixed: tag
prefix, temporal prefix, user hint, Channel-1. Verified the consequence of that
order, that the temporal comment ends up outside the tag prefix in the served
bytes, by reading `prepend_tag` (`:8395-8399`) and
`prepend_temporal_to_block` (`:8334-8343`).
Existing check: `transform.rs:23307`, `:23551`; neither covers the combination,
and neither runs in CI.
Impact: Without this situation, three interactions go untested. First, whether
`strip_tag_prefix` (`:8404-8406`) still inverts `prepend_tag` when a temporal
comment precedes the tag. Second, whether a user block ending in a hint envelope
and beginning with a tag confuses the imitation defence on a later pass. Third,
whether the sibling's index-shift hazard
(`render-a-overlay-targets-stale-indices-after-full-drop-filter`) misapplies two
or three overlays at once rather than one.
Open questions:
- Can a single block ever carry all four? A tool result is not eligible for the
  temporal marker (that requires an authored user message, `:8642-8647`) and not
  eligible for the user hint (that requires `role == "user"`, `:8789`), so the
  answer is no: the maximum is three on a user text block and two on a tool
  result. Recorded as resolved in the evidence file.

## Contract-vs-code leads

1. **`injection.rs` says a missing availability verdict fails open;
   `transform.rs` says it fails closed; the code fails closed.**
   Contract side A: `injection.rs:205` — "A missing availability verdict fails
   open for legacy senders." Repeated at `:228` ("A frozen unavailable verdict
   makes the state effectively empty only on a bust") and `:299` ("an absent
   verdict fails open for legacy senders").
   Contract side B: `transform.rs:738-741` — "None is a provisional or
   legacy-sender verdict and fails closed: missing authority must never
   manufacture a synthetic tool call."
   Code side: `todo_synthesis_verdict` (`transform.rs:2626-2630`) collapses the
   `Option` with `unwrap_or(false)` before it reaches the injection API, and its
   own comment states the intent: "Normalize both explicit denial and missing
   host authority to the injection API's unavailable verdict." Every production
   call site routes through it. Do not resolve in favour of `injection.rs`: the
   code and the `transform.rs` comment agree, and the `injection.rs` wording
   describes a path its own tests reach only by calling it directly. Record
   `nudge-b-todo-availability-fail-open-is-unreachable`.

2. **`channel1_reduce_suppressed` is documented as written by `ctx_reduce` and is
   written by nothing.**
   Contract side: `mc-store/src/lib.rs:2458-2460` — "Set by ctx_reduce after the
   agent has acted on a reminder. The next transform suppresses new Channel-1
   appends while still replaying every stored append row."
   Code side: the only write to `true` in the worktree is
   `transform.rs:23577`, inside a `#[test]`. Three production reads exist
   (`:9156`, `:9565`, `:9593`) and one production clear to `false` (`:9157`).
   The second half of the doc sentence is accurate: stored rows do keep
   replaying, because the suppression only guards the new-append path. Record
   `nudge-b-channel1-suppression-flag-is-never-set`.

3. **The overlay frontier is documented as protecting closed turns from
   first-applied overlays, and one of the three overlays bypasses it.**
   Contract side: `mc-store/src/lib.rs:6506-6507` — "Read the ordinal frontier
   used to avoid first-applying overlays to closed turns." Reinforced by
   `transform.rs:8721-8723`: "Do not advance the frontier past a user whose
   temporal decision could not be evaluated."
   Code side: inside one commit transaction, temporal marks are gated on
   `previous_frontier` (`mc-store/src/lib.rs:7526-7541`) and the user hint is
   gated on it (`:7541-7546`), while the Channel-1 append is inserted
   unconditionally (`:7559-7573`). Record
   `nudge-b-channel1-append-first-applies-without-a-frontier-gate`.

4. **The auto-search hint is documented as searching memories, conversation, and
   commits; it searches only compartments.**
   Contract side: `assets/magic-context.schema.json:1607` — "transform-time
   ctx_search on each new user message"; `:1612` — "when relevant memories,
   conversation, or commits are found". `packages/docs/src/content/docs/reference/configuration.md:119-120`
   repeats both. `README.md:200` says it "run[s] a background `ctx_search` each
   turn".
   Code side: `run_user_hint_lexical_search` (`transform.rs:8843-8961`) reads
   exactly one source, `store.load_compartment_candidates` (`:8866`), and scores
   it with a local inverse-document-frequency sum (`:8898-8946`). No note table
   and no commit index is consulted, and it is not the `ctx_search` code path at
   all. The comment at `:9111-9112` half-acknowledges this: "Native search
   returns memory and compartment results only, so it does not emit commit
   SHA/age metadata." That sentence describes a different search than the one
   the function performs. Not itself a safety defect, but the configuration doc
   overstates the feature's reach, and a user disabling it to stop notes from
   leaking into prompts is solving the wrong problem.

5. **`render_synthetic_todo_pair` marks provenance on one encoder; the other
   encoder marks nothing and is not wired up.**
   Contract side: `codec/sidecar.rs:331-339` — `is_synthetic_part` accepts
   either a `synthetic` field or a `syntheticTodoMarker` field, which reads as a
   two-encoder contract.
   Code side: only `codec/opencode.rs` produces `syntheticTodoMarker`
   (`:946`, reached from `:388`). `codec/pi.rs`'s `encode_new_message`
   (`:582-607`) produces no marker, and `encode_pi` has no caller outside
   `codec/mod.rs`'s tests. So the decoder is prepared for a shape only one
   encoder emits, and the other encoder is not on a production route. Flagged
   because it makes the provenance story profile-dependent in a way no comment
   states. Record
   `nudge-b-injected-todo-pair-carries-no-provider-visible-provenance`.

6. **`append_channel1_nudge` presents as the Channel-1 write path and is dead
   outside tests.**
   Contract side: `mc-store/src/lib.rs:6459` — "Insert one Channel-1 append row
   if this block has not already received one," on a `pub(crate)` method.
   Code side: `:6460` carries
   `#[cfg_attr(not(any(test, feature = "test-support")), allow(dead_code))]`, and
   the production insert is the copy inside `commit_transform`
   (`:7559-7573`). Two `INSERT OR IGNORE` statements against the same table with
   the same column list, one of which never runs in a release build. Not a
   behaviour difference today; flagged because a change to one is invisible to
   the other, the same shape as the sibling's fifth lead.

## Open questions

- Can a `block_id` be reconstructed after its block has left the projection? If
  yes, a stale `mc_channel1_appends` or `mc_user_hints` row can resurface and
  re-inject text that quotes a token count from a state that no longer exists.
  Block ids are `(message_id, block_index)` pairs, so the answer depends on the
  projection cache and lineage handling. Unresolved, needs 4b.
- Is the `claude-code-anthropic` leg live? The whole Channel-2 lease machinery,
  `channel2_directive_id`, the arming watermark, and
  `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` exist only on that arm, and no sender in this
  repository emits the profile string. `ARCHITECTURE.md:125` describes the leg as
  real. This changes the reachability label on
  `nudge-b-channel2-retirement-is-caller-asserted`. Unresolved, needs deployment
  knowledge. (needs human input)
- Does a defer pass whose synthetic-todo anchor has vanished fail the render?
  `reanchor_kept_synthetic_todo_if_folded_or_shrunk` is called only under
  `is_bust_pass` (`transform.rs:7462-7470`), so on a defer pass the stale pair
  survives into `build_output_with_tags_inner`, where a missing anchor is
  `TransformError::SyntheticTodoAnchorMissing` (`:12125-12132`) rather than a
  drop. Whether a defer pass can lose an anchor at all needs a pass-plan trace.
  Unresolved.
- Should the `<system-reminder>` and `<ctx-search-hint>` envelopes be treated as
  a security boundary? They are not one today: any tool result or user message
  can contain the same bytes, and
  `is_system_reminder_transport_message`'s own comment concedes that text shape
  is the only discriminator available (`:8525-8527`). Making them structural
  would change the provider prefix for every existing session. (needs human
  input)
- Does the served-output divergence record (`divergence::first_divergence`,
  `transform.rs:5513-5520`) surface anywhere an operator reads? It is the only
  existing signal that would catch a retroactive Channel-1 append. Unresolved,
  needs `divergence.rs`, which is 4b/4c scope.
