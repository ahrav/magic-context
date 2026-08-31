# Part 4d Lens C: claimed guarantees and the existing-check inventory

Two jobs, one attention focus each. Job 1 mines every checkable guarantee the
repository states about the facade contract, the advertised tool schemas, the
response shape, note evaluation, and the claim intent ledger. Job 2 enumerates
every claim-bearing check that reaches sub-part 4d.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md). Scope and region map from
[../../part-4-module/_lenses/scope-map-and-risk-ranking.md](../../part-4-module/_lenses/scope-map-and-risk-ranking.md).
Format model: [../../part-4c-handlers/existing-checks.md](../../part-4c-handlers/existing-checks.md).

Scope consumed, all six units: `src/lib.rs:10042-11917`,
`src/lib.rs:11919-16001`, `src/dispatch.rs`, `src/smart_note_evaluation.rs`,
`src/memory_tool.rs`, `src/project_docs.rs`, plus the claim intent ledger at
`lib.rs:10082-10182`. `src/lib.rs:16001-30517` was read as check evidence.
`src/prompt_surface.rs` and `src/memory_render.rs` were read only where they
consume or contradict a 4d-owned schema; the scope map assigns both to 4e and
that boundary is named at every citation.

Sibling lens: [lens-a-facade-and-assembly.md](lens-a-facade-and-assembly.md).
The task named two sibling lens files; only lens A exists at `HEAD`, so the
note-evaluation lens is either unwritten or concurrent. This lens therefore
covers note-evaluation claims rather than assume they are taken, and flags the
overlap risk in the open questions. This lens proposes **no property records**
by instruction; every finding below is a lead or an inventory row.

Per METHOD.md rule 3, a documented guarantee is a claim under test. Nothing
below is imported as truth because a doc comment, a schema, or a spec asserts
it. Every line reference was read back individually at `HEAD`; corrections to
references handed to this lens are in the final section.

---

## Claims register

25 claims, ranked by consequence. Each carries a verbatim short quote with its
source reference, the property the quote implies, and where the implementation
is (or `NOT FOUND`). Two lower-consequence claims were folded into neighbours
to stay inside the cap; they are named where folded.

### C1 — the cross-language drift gate is half-wired

> "Both replay the frozen characterization fixture
> `crates/mc-module/testdata/smart-note-evaluation-golden.json` (transitions,
> DST schedule vectors, phase selection)."
> — `packages/plugin/src/features/magic-context/smart-notes/PARITY.md:16`

Also stated by the module itself: "Both implementations replay the frozen
fixture ... so lifecycle behavior cannot drift between languages"
(`smart_note_evaluation.rs:5-6`).

Implied property: for every case in the shared fixture, the Rust reducer and
the TypeScript reducer produce the same lifecycle result, and a regression on
either side fails a check.

Implementation: **partial.** The fixture holds `constants` (13),
`transition_cases` (23), `schedule_cases` (16) and `selection_cases` (9),
counted from `testdata/smart-note-evaluation-golden.json`. The Rust replay
`smart_note_evaluation_golden_matches_production_behaviour`
(`smart_note_evaluation.rs:1101`) asserts all four groups: constants at
`:1110-1122`, the backoff ladder at `:1123-1130`, transitions at `:1132`,
schedules at `:1145`, selections at `:1156`. The TypeScript replay
`evaluation-state.test.ts` is 136 lines with 3 `it()` blocks and iterates
`golden.transition_cases` only (`:105`); it never reads `schedule_cases` or
`selection_cases`. So the DST schedule vectors and the phase selectors are
pinned by exactly one replay, and per Job 2 that replay runs nowhere.

### C2 — the Rust authority recomputes the artifact digest rather than trusting it

> "The Rust authority never executes note-authored code; it recomputes the
> canonical artifact digest (condition, code, manifest, cron separated by NUL
> bytes, SHA-256) from its authoritative condition before persisting any
> compile outcome."
> — `PARITY.md:18`

Restated in the module: "The digest for compile outcomes is recomputed from the
authoritative note condition rather than trusted from the wire"
(`lib.rs:14190-14192`), and "Delegates to the single definition in `mc-store` so
the admission gate here and the v51 artifact repair there can never disagree
about what the digest is" (`lib.rs:14174-14177`).

Implied property: no compile outcome is persisted whose `check_hash` differs
from the digest recomputed from the stored condition, and the module never
evaluates wire-supplied code.

Implementation: `lib.rs:14174-14177` (`smart_note_check_digest`, delegating to
`mc-store`), the wire-side format gate `artifact 'check_hash' must be 64
lowercase hex characters` (`:14157`), and the reducer-side rejection
`check_hash does not match the canonical artifact digest` (`:14217`) inside
`apply_note_evaluation_outcome` (`:14190-14277`). FOUND.

### C3 — a conditioned note write fails closed without a live evaluator

> "conditioned `ctx_note` writes fail closed without a live protocol-2.0
> registration" — `PARITY.md:19`

The caller-visible form of the same claim is an assertion about durable state:

> "Smart-note evaluation is unavailable for this Rust-authority project; the
> note was not written." — `lib.rs:11624` (and `:11835`, "not updated")

Implied property: when `has_live_note_evaluator` is false and a
`surface_condition` is present, no note row is inserted or updated.

Implementation: `lib.rs:11618-11626` for `write`, `:11829-11836` for `update`
(gated on `condition_changed` at `:11829`), both routed through
`refuse_conditioned_note_without_evaluator`
(`:15313-15339`), whose own doc states the ordering that makes the claim
non-trivial: "`with_facade_command` replays recorded outcomes only after this
gate ... the liveness gate protects first-time mutations, never replays"
(`:15313-15317`). FOUND, with the replay carve-out stated in the same place.

### C4 — the advertised tool description denies the evaluation the code performs

> "surface_condition is accepted and recorded, but condition evaluation arrives
> later on this leg." — `lib.rs:15787` (`ctx_note_description`)

The light-preset variant says the same: "surface_condition is recorded but not
evaluated on this Claude Code leg" (`prompt_surface.rs:56-57`, 4e file).

Implied property: recording a `surface_condition` neither triggers evaluation
nor changes whether the write succeeds.

Implementation: **contradicted on both halves.** A conditioned write is refused
outright when no evaluator is live (`lib.rs:11618-11626`, claim C3), and the
whole `note.evaluation.*` protocol at `:10880-11481` exists to evaluate the
recorded condition. So the string the model reads understates the contract in
the direction that matters: the model is told the field is inert, and the field
can turn a successful write into a refusal.

### C5 — `ctx_reduce`'s closed schema is an authorizer contract, and the handler's tolerance is deliberate

> "This exact advertised shape is the Thalamus authorization contract.
> Prompt-surface selection may replace only the top-level description."
> — `prompt_surface.rs:195-196` (4e file, schema literal at `:197-204`)

The reason the handler may accept keys the schema forbids is written down, in a
test comment:

> "ctx_reduce is the one AUTHORIZER-PINNED schema: Thalamus exact-matches the
> canonical closed shape and fails closed on any deviation, silently disabling
> the tagging surface. Its imitated-args tolerance lives in the execution
> unwrap, not the advertised schema."
> — `lib.rs:25574-25578`

Implied property: the advertised bytes stay canonical, and argument tolerance
is a property of the handler, not of the advertisement.

Implementation: the advertised half is gated byte-for-byte at
`lib.rs:25579-25588`. The handler half accepts `command_id` (`:25467` supplies
it), `memory_project` (read through `resolve_facade_scope` at `:10493`,
`:10501`), and the `reduced`/`summary` envelope (`:10487` into `:14421-14434`).
This **resolves lens A's open question** on which side is the contract: both
are, deliberately, and the split is stated. It does not establish that the two
halves agree; nothing asserts the handler's accepted key set.

### C6 — the fair-selection cursor moves exactly once per fresh committed claim

> "The cursor advances exactly once per fresh committed claim and resets only on
> a fresh durable `no_work`. Replayed claims, recovered slot claims, replayed
> `no_work`, `busy`, expiry, terminal replay, invalid identity, authority
> change, and store failures leave it unchanged, so acquisition replay stays
> idempotent." — `PARITY.md:36-40`

The module states the same as a precondition: "The caller commits the proposed
successor only after the store durably commits a fresh claim, and resets the
cycle only after a fresh durable `no_work`, so replays, recovery, and failures
never move the cursor" (`smart_note_evaluation.rs:854-860`).

Implied property: cursor position is a function of durably committed fresh
claims alone.

Implementation: `lib.rs:11186-11256`, guarded by the one runtime assertion in
this half of the scope — `debug_assert!(proposed_cycle.is_some(), "fresh claim
committed without a proposed cycle update")` (`:11250-11253`), whose comment
names the failure it exists to catch: "stopped decrementing and fair rotation
silently starves" (`:11248-11249`). FOUND, and the guard is compiled out of
release.

### C7 — note evaluation is the one runtime closed schema

> "Closed-schema decode for the flat note.evaluation.* bodies: unknown fields
> are rejected before any waiter or store allocation, and every body must carry
> the protocol marker `v: 2`." — `lib.rs:13882-13884`

Implied property: an unknown key on a `note.evaluation.*` body is rejected, and
the rejection precedes any allocation of a waiter or a store handle.

Implementation: `note_evaluation_body` (`:13885-13905`), with the two rejections
verbatim at `:13897` (`unknown field '{key}'`) and `:13902` (`'v' must be 2`).
FOUND. The ordering half of the claim ("before any waiter or store allocation")
is a call-site property, not a property of the decoder, and nothing states it at
the call sites.

### C8 — measure and write must agree or nothing is terminal

> "The serializer therefore runs twice — once to size the reservation, once to
> fill it — and `write_to`'s length check turns any disagreement between the two
> passes into an error rather than a short body." — `dispatch.rs:130-140`

Implied property: every prepared response either writes exactly the measured
byte count or returns an error; a short body never reaches the wire.

Implementation: `dispatch.rs:250-277` (the equality check and `LengthMismatch`),
`:430-432` (the cap check precedes buffering), `:469-511` (`BoundedWriter`
refusing an over-length write). FOUND, and this is the best-tested claim in the
sub-part (see `tests/prepared_output.rs` in Job 2).

### C9 — the wire cap is derived, not restated

> "Derived from the host's own cap rather than restated: this value gates output
> preparation while `mc-host` gates frame admission, so a literal here could
> drift and make the two disagree about what fits on the wire."
> — `dispatch.rs:7-11`

Implied property: the module's output cap equals the host's frame-body cap by
construction.

Implementation: `dispatch.rs:12`,
`pub const MAX_WIRE_BODY_BYTES: usize = mc_host::MAX_FRAME_BODY_LEN as usize;`,
against `mc-host/src/wire.rs:35` (`64 * 1024 * 1024`). FOUND by construction; no
test is needed and none exists for the derivation itself.

### C10 — the transform frame cap restates the number C9 refuses to restate

> "Transform-class requests carry a session's full message array. The transport
> frame ceiling is 64 MiB; half that leaves headroom for envelope overhead while
> still admitting the largest observed live sessions." — `lib.rs:14280-14283`

Implied property: `MAX_TRANSFORM_FRAME_BYTES` is half the host frame ceiling.

Implementation: `lib.rs:14284`, `const MAX_TRANSFORM_FRAME_BYTES: usize = 32 *
1024 * 1024;`. Correct at `HEAD` (64 MiB / 2), and a hard literal with the
relationship stated only in prose. This is the exact drift C9 was written to
prevent, one file over. `MAX_FACADE_FRAME_BYTES` (`:14279`) has no stated
derivation at all.

### C11 — the advertised category enum is derived, but two other hand-kept lists exist

> "The advertised enum is derived, never hand-written: every advertised category
> must match a oneOf write arm ... A second hand-kept list could drift and
> advertise a category no arm accepts." — `lib.rs:15815-15818`

Implied property: no category is advertised that no write arm accepts.

Implementation: `lib.rs:15819-15826` derives `all_categories` from
`positive_categories` (`:15808-15814`) plus `REJECTED_APPROACH`, and the
relation is asserted at `:25614-25629`. FOUND for the stated scope. The claim's
own reasoning is nonetheless live elsewhere: `positive_categories` is itself
hand-written at `:15808`, and 4e's `memory_render.rs` carries two more
hand-kept lists — `MEMORY_CATEGORY_ORDER` (5, `:32-38`) and
`POSITIVE_MEMORY_CATEGORIES` (**12**, `:40-53`). The read path filters on the
12-entry list (`memory_tool.rs:72-77`), so the advertised 5 are a strict subset
of what a read accepts, and `REJECTED_APPROACH` is advertised as writable while
being excluded from every read result. Cross-part; 4e owns the lists.

### C12 — `ctx_memory` is advertised as mutating and refuses every mutation

> "Create standalone facts, revise changed claims, archive or restore lifecycle
> state, and merge duplicate claims through the host commit path."
> — `lib.rs:15775` (`ctx_memory_description`)

The tool is advertised `ExecutionMode::Mutating` (`prompt_surface.rs:209`), its
schema carries `create` and `revise` `oneOf` arms with required `content` or
`antiMemory` (`lib.rs:15874-15907`) and both `mutationToken` and
`mutationTokens` definitions (`:15864-15869`). The spec agrees:

> "Use create, get, revise, archive, restore, or merge; list remains
> dreamer-only." — `docs/specs/prompt-surface/load-bearing-rules-checklist.md:1197`

Implied property: the five mutating actions are executable through this tool.

Implementation: **all five are refused**, `"Error: claim mutations require the
host claim-operation commit path."` (`lib.rs:10692-10694`). `mutationToken` and
`mutationTokens` are never read by the handler, so the schema's `maxItems: 100`
(`:15867`) is advertised and unenforced. The refusal is intentional and pinned
by `facade_advertises_anti_memory_but_keeps_mutation_host_owned`
(`lib.rs:25762`), which asserts `isError == true` and the message text
(`:25786-25790`). So the code and its test agree; the advertisement is the odd
one out, and nothing checks the advertisement against the refusal.

### C13 — `ctx_search` advertises two corpora it does not search

> "Keyword-search saved project memories, session notes, and summarized
> conversation history." — `lib.rs:15779` (`ctx_search_description`)

> "Search compacted messages, git commits, and notes while filtering claims
> already rendered in project-memory ... broad project-memory retrieval stays
> disabled until the claim retrieval projection is active."
> — `load-bearing-rules-checklist.md:1221`

Implied property: a `ctx_search` result set can include project memories and
git commits.

Implementation: `NOT FOUND` for both. `memory_tool::search_compartments_and_notes_for_session`
(`memory_tool.rs:211-248`) reads exactly `search_compartments_like` (`:224`) and
`search_notes_like` (`:229`); `list_committed_claims` is never called from the
search path, and no git source exists in the module. The spec's own hedge
("broad project-memory retrieval stays disabled") licenses the memory half, but
the description the model actually reads promises it, and the two docs disagree
with each other before either disagrees with the code.

### C14 — `ctx_expand` message mode promises full recovery the fallback cannot give

> "returns the FULL untruncated content of the message"
> — `load-bearing-rules-checklist.md:1079` (rule T-009, source evidence)

> "Recover one message by ordinal in full from the cached raw request when
> available, otherwise its persisted historian chunk transcript."
> — `lib.rs:15955` (`ctx_expand_schema`, `message` description)

The module contradicts the fallback half twice, in its own words:

> "The durable transcript fallback above remains available when the snapshot is
> gone, but it intentionally cannot recover raw tool input or output bytes."
> — `lib.rs:14538-14540`

> "This Claude Code leg can recover the historian chunk-builder view, not full
> raw messages; tool calls may be summarized and long text may have been
> truncated before summarization." — `lib.rs:14525`

Implied property: `message=N` returns the complete original message including
tool input and output.

Implementation: FOUND only on the cached-snapshot path
(`lib.rs:10783-10792`). On the durable path (`:10793-10811`) the guarantee is
explicitly disclaimed by the code. The schema's word "in full" attaches to the
cached branch and is silently inherited by the fallback branch in the same
sentence.

### C15 — the expand budget identifies where to continue in one of two modes

> "Return a raw transcript capped at about 15K tokens and identify where to
> continue." — `load-bearing-rules-checklist.md:1029` (rule T-007)

Implied property: a truncated expand result tells the caller how to fetch the
remainder.

Implementation: **partial.** Verbose mode does both: the budget is
`CTX_EXPAND_VERBOSE_TOKEN_BUDGET` (`lib.rs:14806`, `15_000`) and the marker
names the continuation, `"Truncated at message {} (budget: ~{...} tokens). Call
again with start={} end={end} verbose=true for more."` (`:14866`). Default
range mode caps but does not point: `CTX_EXPAND_TRUNCATION_MARKER` is
`"\n\n[truncated at the ~15,000-token ctx_expand budget]"` (`:14401`), applied
at `:14483-14494` and `:14496-14513`, with no ordinal.

### C16 — the token budget is enforced as bytes at four bytes per token

> "[truncated at the ~15,000-token ctx_expand budget]" — `lib.rs:14401`

Implied property: the default expand result is bounded by roughly 15,000 tokens.

Implementation: `lib.rs:14398`,
`const CTX_EXPAND_BYTE_BUDGET: usize = 15_000 * 4;` — 60,000 bytes. The four
bytes per token is a proxy stated nowhere; it is close for ASCII prose and wrong
by a factor of about three for dense multi-byte text, in the safe direction
(fewer tokens than advertised). The existing check
`expand_output_is_bounded_to_the_typescript_token_budget` (`:25657`) asserts the
byte bound, not the token claim.

### C17 — three schema `maxLength` values are enforced in bytes, not characters

> `"query": { "type": "string", "maxLength": 1024 ... }` — `lib.rs:15931-15935`
> `"content": { "type": "string", "maxLength": 65536 ... }` — `lib.rs:15966`
> `"surface_condition": { "type": "string", "maxLength": 4096 ... }` — `lib.rs:15971`

Implied property: an argument that satisfies the advertised `maxLength` is
accepted.

Implementation: enforced in **bytes** by `validate_string_cap` against
`MAX_QUERY_BYTES = 1024` (`:14397`, applied `:10711`),
`MAX_NOTE_CONTENT_BYTES = 64 * 1024` (`:14395`, applied `:11556`), and
`MAX_SHORT_FIELD_BYTES = 4 * 1024` (`:14396`, applied `:11557`). JSON Schema
`maxLength` counts characters, so a 1,024-character CJK query satisfies the
advertised schema and is rejected by the module with `'query' exceeds the
1024-byte limit` (`:14410`). The numbers match; the units do not. `ctx_memory`'s
own `content` `maxLength` (`:15856`) is enforced nowhere, because mutations are
refused before any cap runs (C12).

### C18 — three sources disagree about whether `ctx_reduce` queues or acknowledges

> "Mark it discardable; release is queued and delayed until context space is
> needed." — `load-bearing-rules-checklist.md:884` (rule T-001)
> "Queue a tagged reduction request for asynchronous delivery."
> — `prompt_surface.rs:40-42` (light description, 4e file)
> "Acknowledge a tagged reduction request for asynchronous delivery"
> — `prompt_surface.rs:60-61` (`CTX_REDUCE_DESCRIPTION`, full preset)

Implied property: a successful `ctx_reduce` call has queued the named tags.

Implementation: the module writes nothing —
`"...deliberately does not mutate it. The response observer owns asynchronous
delivery on this facade."` (`lib.rs:10585-10586`), then
`mcp_text_result(format!("Queued: {}.", ...), false)` (`:10587`). The tool is
advertised `ExecutionMode::Pure` (`prompt_surface.rs:194`), which is the one
advertisement consistent with the code. So the honest statement is the full
description and the execution mode; the light description, the spec rule, and
the response text all assert an effect the module does not perform. Lens A owns
the record (`facade-a-ctx-reduce-acknowledges-a-queue-it-never-writes`); this
register adds that the contradiction is four-way and that the `Pure` mode
declaration is the exculpating side.

### C19 — every claim handler must resolve authority from the bound route

> "Every claim handler must go through this. The claim wire carries
> caller-supplied identity (`binding.authorityProject`,
> `binding.databaseIncarnationId`), so the bound route is the only trustworthy
> authority identity on the request." — `lib.rs:10062-10067`

Implied property: no claim facade call acts on an authority identity the caller
supplied.

Implementation: `claim_route_root` (`:10068-10080`) is called by all four
intent and effects handlers, and its result is used by exactly one:
`handle_claim_intent_stage` passes `&route_root` to the store (`:10100`).
`handle_claim_intent_inspect` (`:10120-10122`), `handle_claim_intent_ack`
(`:10154-10156`) and `handle_claim_effects_apply` (`:10185-10187`) discard it,
keeping only the presence check. `handle_claim_mirror_replace` and
`handle_claim_mirror_apply` do not call it at all (`:10262`, `:10300`).
Verified independently of lens A, which owns the record.

### C20 — the admitted facade name set is stated three ways and no two agree

> "Only ctx_memory and ctx_search are accepted on that surface; unsupported
> names keep a distinct error so a policy or routing mistake is diagnosable from
> the code alone." — `lib.rs:12344-12351`

The router admits **eleven** names (`:10046-10057`): five `ctx_*` and six claim
commands. The manifest advertises **six** tools (`prompt_surface.rs:179-230`):
the five `ctx_*` plus `transform`, which is not a facade name at all, and
`session_tools` (`:233-238`) filters `transform` back out through
`is_known_tool_id` (`:146-148`, over `PROMPT_SURFACE_TOOL_IDS`, 5 entries at
`:63-69`). So six routable names are advertised nowhere, one advertised tool is
not routable on this surface, and the only prose statement of the set names two.

Implied property: the advertised tool set equals the accepted facade name set.
Implementation: `NOT FOUND` in either direction. Folded here: the manifest's own
adjacent claims `"emits_push": false` and `"sub_supervises": false` with
`control_ops: Vec::new()` (`lib.rs:15981-15990`), which are checkable and
unchecked.

### C21 — facade mutations are said to be rechecked inside the store transaction

> "Shared visibility is read-only for primary agents; facade mutations require
> project ownership, which the store rechecks inside the mutation transaction."
> — `memory_tool.rs:1-6`

Implied property: a facade mutation's project ownership is validated inside the
transaction that performs it, not only before it.

Implementation: partial and asymmetric. `ctx_note` calls
`store.enforce_facade_project_vocabulary` **before** opening the command
(`lib.rs:11584-11591`), and the in-transaction recheck lives in `mc-store`
(Part 3 boundary). `ctx_memory` has no mutation path to recheck (C12). So the
module-side half of the claim is a pre-check, and the "inside the transaction"
half is asserted about a crate this sub-part does not own.

### C22 — the project-docs TOCTOU gap is claimed closed

> "the regular-file + size check is RE-DONE at read time to close the TOCTOU gap
> between fingerprint and read" — `project_docs.rs:10-11`, restated at `:59-60`

Implied property: no symlinked or oversized doc can be read into the trusted m0
baseline, regardless of interleaving.

Implementation: `project_docs.rs:59-75`. Lens A owns the finding that the window
is narrowed rather than closed (`symlink_metadata` at `:69`, then
`fs::read_to_string` at `:73`, which follows symlinks). Verified. Added here:
the file's existing checks cover the fingerprint-time skip
(`symlinked_doc_is_skipped`, `:168`) and the size skip (`oversized_doc_is_skipped`,
`:188`), and neither swaps the path between the stat and the read, so the
re-check that the claim rests on has no test.

### C23 — the module never touches the host's context.db

> "The module never opens or attaches the host's context.db — the TypeScript
> plugin owns that file exclusively — so `context_db_schema_version` is null on
> this surface and the plugin's RPC/doctor surface reports the live value
> instead." — `lib.rs:15447-15455`

Implied property: no code path in the module opens or attaches `context.db`, and
the status envelope's `context_db_schema_version` is always null.

Implementation: `storage_versions_block` (`:15447` onward) supplies the null;
the negative half ("never opens or attaches") is a whole-crate absence claim
with no guard. FOUND for the field, `NOT FOUND` for the prohibition.

### C24 — wall-clock now is read once and frozen so rendered bytes cannot drift

> "Used ONLY to set the frozen expiry cutoff on a HARD (the first
> materialization freezes it into meta); every later pass reads the frozen
> value, never this, so expiry never drifts the rendered bytes between passes."
> — `lib.rs:12389-12391`

Implied property: `now_ms()` influences rendered output only on the first
materializing pass.

Implementation: the freeze is in 4b/4c territory; the claim as written is a
usage restriction on a 4d helper (`now_ms`, `:12392` onward) and nothing in 4d
enforces it. `now_ms()` is in fact called from the facade mutation paths
(`:11582`) where no freeze applies, so the "ONLY" is a statement about the
transform lane that the helper's own doc generalizes.

### C25 — a length-capped classifier generation is rejected even when it parses

> "A length-capped generation is rejected even when its truncated prefix parses,
> because the caller refuses `truncated` output — accepting one would write a
> durable response no caller can use and leave the remaining chain unavailable
> to every retry." — `lib.rs:13164-13169`

Implied property: no truncated classifier output is ever persisted as a dreamer
response.

Implementation: the accept predicate at `:13164` onward, with
`length_capped_or_invalid` in the same region (`:13058-13202`). FOUND. Folded
here: the neighbouring `"recorded dreamer response is not valid JSON"`
(`:13184`) and the `"raw-only fence"` marker (`:13208`), both of which state
contracts and neither of which is named by any test.

---

## Contract-vs-code leads

Leads, not records. Numbered for reference by the synthesis pass. Leads that
duplicate lens A are omitted; where this lens verified or sharpened one of lens
A's, that is said explicitly.

1. **Two more success-shaped error paths than lens A found.** Lens A lists four
   ways an error path presents as success. `ctx_expand` adds two more, both
   `mcp_text_result(..., false)`: `"Message {message} is no longer recoverable
   from persisted chunk transcripts."` (`lib.rs:10804-10809`) and `"No compacted
   compartments found in range {start}-{end}."` (`:10832-10838`). Each is a
   recovery failure delivered with `isError: false` and no field distinguishing
   it from a hit. The same text appears a third time inside the range renderer
   (`:14638`) and a fourth as `"No messages found in range {start}-{end}."`
   (`:14717`, `:15000`). So the count for the sub-part is six, not four, and two
   of the six are on the tool whose entire purpose is recovering content the
   agent already lost.

2. **`ctx_note` honours five keys its advertised schema is pinned to exclude.**
   The handler caps and reads `compiled_provider`, `compiled_config`,
   `compiled_at` and `compile_status` (`lib.rs:11558-11560`, `:14456-14474`) and
   accepts `command_id` (`:11592-11599`), while the advertised property set is
   asserted to be exactly the eight keys `action, content, note_id, limit,
   offset, filter, surface_condition, memory_project`
   (`:25559-25571`, asserted at `:25650`). `additionalProperties: true`
   (`:15963`) makes the acceptance legal, and the test makes the omission
   deliberate, so this is a documented-by-test convention rather than a defect.
   It is a lead because the convention is stated only as an assertion on the
   schema and nothing states the handler's accepted set anywhere.

3. **The facade byte-budget rationale is attached to the wrong item.** The doc
   comment "The facade byte budget exists for agent tool calls; transform-class
   requests legitimately carry a session's full message array ... Method
   sniffing on raw bytes avoids parsing multi-MiB JSON just to reject it"
   (`lib.rs:14307-14310`) sits immediately above the second doc comment for
   `VALUE_NODE_SLACK` (`:14311-14313`), with no item between them. Rustdoc
   renders both as the docs for `VALUE_NODE_SLACK` (`:14314`), so the only
   written rationale for `enforce_request_byte_cap`'s two-tier design documents
   a growth-slack constant instead. Low consequence, mechanical to confirm.

4. **The advertised `category` enum is never validated on the read path.**
   `handle_ctx_memory_facade` reads `category` with `string_arg` and passes it
   straight to `list_committed_claims` (`lib.rs:10671-10673`), which compares it
   for equality against the stored attribute (`memory_tool.rs:80-84`). A
   category outside the advertised enum is therefore accepted and returns an
   empty result set with `isError: false`. The advertised enum
   (`lib.rs:15852-15855`) constrains nothing at runtime.

5. **`REJECTED_APPROACH` is advertised as writable and excluded from every
   read.** The schema's second `oneOf` arm requires `category: REJECTED_APPROACH`
   plus `antiMemory` (`lib.rs:15883-15890`), and the read path drops any row
   whose category is outside the 12-entry `POSITIVE_MEMORY_CATEGORIES`
   (`memory_tool.rs:72-77`, list at 4e's `memory_render.rs:40-53`). The
   exclusion is intentional and tested — `list_committed_claims_excludes_anti_memory_even_when_requested`
   (`memory_tool.rs:396`) — so the code and its test agree and the schema does
   not. Nothing checks the schema against the filter.

6. **`memory_tool.rs`'s id doc names a result kind that does not exist.**
   "memory row id for memory results, compartment sequence for compartment
   results, and note id for note results" (`memory_tool.rs:192-193`) describes
   three kinds; `MemorySearchSourceKind` has `CompartmentTitle`,
   `CompartmentBody`, `Note` (`:183-187`) and no memory variant. Separately, the
   `id` is emitted to the model (`lib.rs:10745`) while `ctx_memory`'s own
   description instructs "never use local row IDs" (`:15775`). Stale doc plus a
   surface-level tension worth one sentence in the catalog.

7. **`unreachable!()` on a settlement arm the type system already excludes.**
   `settle_prepared_with`'s `let ... else` re-matches the outcome it just failed
   to destructure and panics on `PreparedOutcome::Response(_)`
   (`lib.rs:12161-12167`). It is genuinely unreachable as written. It is a lead
   because it is one of only two `unreachable!` sites in the whole 4d production
   surface and it sits on the response path every reply passes through; a future
   refactor of the `else` block turns a compile-time impossibility into a
   production panic. The other site, `unreachable!("the connect-failure CAS loop
   returns from both attempts")` (`:15735`), is the sole written statement of
   that loop's invariant.

8. **`ctx_note`'s advertised `offset` and the 100-note limit.** The schema
   advertises `limit` maximum 100 and `offset` minimum 0 with default 0
   (`lib.rs:15968-15969`), and `note_facade_pages_ready_notes_beyond_one_hundred_with_shared_offset_semantics`
   (`:25028`) is the check that names the paging contract. Worth confirming in
   synthesis whether the advertised bounds and the test's "shared offset
   semantics" describe the same rule; this lens did not read the body.

9. **`wake_owned` is claimed permanently false against the direct host.**
   "Against the direct host, `wake_owned` stays false and standalone evaluation
   remains active in both authority modes" (`PARITY.md:90`), and `wake_owned`
   appears at five sites in the 4d range. The claim is a reachability statement
   about a shipped configuration and has one named test,
   `note_evaluation_wake_owned_suppression_records_no_durable_decision`
   (`lib.rs:23632`).

10. **The fixture-regeneration gate is documentation only.** "Regenerate with
    `bun crates/mc-module/gen/gen-smart-note-evaluation-golden.ts`; a
    regeneration diff means a semantic change and requires review. The generator
    pins frozen copies of the legacy writers so neither reducer is its own
    oracle." (`PARITY.md:16`). No workflow regenerates the fixture and diffs it,
    so a fixture that drifts from the legacy writers it was generated from is
    caught by review alone. The "neither reducer is its own oracle" property is
    a claim about the generator, and this lens did not open it.

---

## Conventionally-enforced-only claims

Eight, each enforced by nothing stronger than a convention a reader must notice.

1. **Four hand-written mutex labels on the note-evaluator registry.**
   `"note evaluator registrations mutex"` (`lib.rs:10946`, `:11022`, `:11082`)
   and `"note evaluator slot cycle mutex"` (`:11186`). Each `.expect` is
   infallible only while no thread panics holding that lock; a mislabelled lock
   produces a misleading panic and nothing notices. Same shape as 4c's 36
   labels, at a twelfth the count.

2. **`ctx_note`'s five unadvertised-but-honoured keys** (lead 2). The convention
   is "the schema is the compatibility surface, the handler is wider", stated
   only as an assertion at `lib.rs:25650`.

3. **The `MAX_TRANSFORM_FRAME_BYTES` derivation** (C10). "Half of 64 MiB" lives
   in prose at `lib.rs:14280-14283`; the constant is a literal.

4. **The `dispatch.rs` no-content-in-diagnostics discipline.** All three `Debug`
   impls print lengths and kind tags only (`:81-88`, `:192-203`, `:212-224`, per
   lens A). It is a discipline applied three times and stated nowhere, and the
   response path does the opposite (lens A's route-path record).

5. **The advertised-versus-accepted name set** (C20). No mechanism ties
   `handle_facade_value`'s match arms to `module_tools`; the sole prose statement
   is stale.

6. **`context_db_schema_version` is null because the module never attaches the
   file** (C23). The prohibition is a whole-crate absence with no guard.

7. **The `"raw-only fence"` marker** (`lib.rs:13208`) and `"recorded dreamer
   response is not valid JSON"` (`:13184`). Both name contracts; neither appears
   in any test.

8. **`ExecutionMode` as a mutation declaration.** `ctx_reduce` and `ctx_expand`
   are `Pure`, `ctx_memory` and `ctx_note` are `Mutating`
   (`prompt_surface.rs:194`, `:215`, `:209`, `:227`). Nothing checks a handler
   against its declared mode, and `ctx_memory` is the counter-example: declared
   `Mutating`, refuses every mutation.

---

## Existing-check inventory

Every status below is **unaudited**. An existing check does not remove a
property from the catalog; adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for production
guards.

### In-crate tests (clustered, counts, line ranges, attribution method)

**The headline: 88 claim-bearing in-crate tests reach 4d, spanning
`lib.rs:16041-27808` plus 14 file-local tests in the three 4d files that have
their own test modules. None of the 102 runs in CI.**

#### Attribution method, stated in full

`lib.rs` is 30,517 lines with two flat `#[cfg(test)]` modules and no inner
`mod`, so a test's subject cannot be read off its location. The attribution
below is mechanical, in four steps, and reproduces 4c's method so the two
inventories are comparable:

1. **Enumerate.** All `#[test]`, `#[tokio::test]` and `#[tokio::test(...)]`
   attributes from `:16001` on. Re-counted at `HEAD`: **256**. This reconciles
   exactly with 4c's 256 and the scope map's 248 + 8.
2. **Resolve.** Each attribute resolved forward to its `fn` line: 248 whose `fn`
   lines span `:16041-30278` in `mod tests`, 8 spanning `:30320-30516` in
   `mod release_contract_tests`. First is
   `production_settlement_reserves_before_write_and_returns_exact_body`
   (`:16041`), last is
   `state_sync_epoch_compatibility_requires_the_exact_numeric_epoch` (`:30488`).
3. **Brace-match.** Each body brace-matched to its closing line with string
   literals stripped, so a test's extent is its real body rather than the gap to
   the next attribute.
4. **Fixpoint over helpers.** 4d production identifiers and method literals
   matched inside each body, then a fixpoint taken over the **117 non-test
   functions** in the test modules, so a test that reaches the facade only
   through a request builder is attributed transitively. 4c counted 119 by the
   same description; the two-function difference is a detector edge on
   attribute-adjacent `fn` lines and is not material to any count below.

The result is three tiers that **bracket** the truth rather than pin it:

| Tier | Tests | What it measures |
| --- | --- | --- |
| **Reach** | **232** of 256 | Executes at least one line of 4d production code, transitively |
| **Op-specific (helper fixpoint)** | **88** | Names a 4d-owned tool, claim command, note-evaluation method, settlement API, byte cap, schema, expand renderer, or smart-note contract |
| **Op-specific (direct body match)** | **65** | The same rule without the helper fixpoint |
| **Name rule** | **49** | Test name matches the 4d vocabulary |

**The 232 is inflated and the reason is structural.** `PreparedOutcome` is the
return type of every handler in the crate, and `mcp_text_result` / `respond`
are how they all answer, so a symbol-reach tier over 4d catches nearly every
handler test in the file. The 88 is the number to use; the 65 and the 49 bound
it from below.

**Reconciling 4c's "28 tests attributed to 4d".** That number is not 4d's
total and is not wrong. 4c subtracted 51 tests from their 120 op-specific set
by test name, of which 28 went to 4d, so their 28 is the size of the *overlap
they handed over* — tests that reach 4c production code and whose names say
facade, `ctx_*`, note evaluation, native attachment, prepared output, schemas,
or byte caps. Reproducing that rule independently: **11** of this lens's
4d-symbol tests also touch a 4c symbol by direct body match, and **49** of all
256 match the 4c-stated name vocabulary. Neither reproduces 28 exactly, because
4c's rule was applied to their own 120-set rather than to all 256, and they said
so ("its boundary is approximate at the edges"). The honest statement is that
4d's own claim-bearing count is 88, that 11 to 49 of those are shared with 4c
depending on the rule, and that 28 sits inside that band. **No correction is
issued**; the numbers measure different things.

#### Clusters

| Cluster | Tests | Line range | Notes |
| --- | --- | --- | --- |
| native attachment plumbing | 20 | `:19261-21839` | Largest cluster in scope. The caches are 4c's, the plumbing at `:12450-13055` is 4d's |
| note-evaluation protocol | 17 | `:23111-24290` | The best-covered 4d-owned protocol; 12 of the 17 name a cycle or quota rule |
| `ctx_note` | 14 | `:17067-25531` | Includes the ledger-replay test at `:23243` |
| `ctx_reduce` | 9 | `:17067-27570` | Five of the nine are the `command_id` family at `:27555-27808`, which 4c also claims |
| `respond_transform` and status helpers | 8 | `:16198-19294` | `usage_numbers`, `projected_post_drop_percentage`; the two historian-trigger tests are 4a's assertions reaching a 4d helper |
| `drive-fault` | 8 | `:18965-19113` | Feature-gated; `explicit-config-only` |
| `ctx_memory` | 7 | `:17067-25762` | Includes the mutation-refusal gate at `:25762` |
| `ctx_search` | 6 | `:17067-25531` | |
| `ctx_expand` | 6 | `:17067-25657` | Includes both budget checks, `:24517` and `:25657` |
| smart-note selection types | 6 | `:23904-24241` | Reach `SmartNoteCycleMode` / `SmartNoteSelectionCycle` (26 occurrences) |
| prepared settlement | 4 | `:16041-16150` | The only tests of `settle_prepared_with` |
| tool schemas and manifest | 4 | `:17067-25931` | `:25531` is the contract gate |
| request byte caps | 3 | `:17542-17589` | `:17542`, `:17567`, and one transitive |
| facade argument extraction | 1 | `:25333` | `facade_arguments_preserve_decorated_reduced_fields` |

Named checks the leads and lens A records lean on, verified by name and `fn`
line at `HEAD`:

| Line | Test | Pins |
| --- | --- | --- |
| `:16041` | `production_settlement_reserves_before_write_and_returns_exact_body` | Reserve-before-write ordering |
| `:16150` | `production_settlement_cancellation_and_denial_emit_no_body` | The cancellation and reserve-denial arms |
| `:17542` | `request_byte_cap_widens_for_transform_class_only` | The two-tier cap, small bodies only |
| `:17567` | `value_footprint_counts_nodes_outside_strings_only` | The footprint bound's counting rule |
| `:23111` | `smart_note_writes_require_a_live_protocol_v2_registration` | C3's fail-closed gate |
| `:23243` | `conditioned_write_replays_recorded_response_without_live_evaluator` | A recorded **success** replaying past the liveness gate |
| `:23295` | `note_evaluator_registration_rejects_wrong_versions_and_stale_credentials` | The four-way identity match at `:13877` |
| `:23381` | `note_evaluator_route_teardown_withdraws_registrations` | `PARITY.md:19`'s boot-ephemeral claim |
| `:23524` | `note_evaluation_rejects_forged_oversized_and_phase_smuggled_completions` | C2's digest recompute plus the phase pairing at `:14086`, `:14105` |
| `:23904` | `note_evaluation_replayed_and_recovered_claims_leave_cycles_unchanged` | C6's replay-idempotence half |
| `:23976` | `note_evaluation_fresh_no_work_resets_and_replayed_no_work_does_not` | C6's reset rule |
| `:24048` | `note_evaluation_spent_cycle_no_work_reports_cycle_exhausted` | The `cycle_exhausted` distinction (`PARITY.md:41-52`) |
| `:24290` | `note_evaluation_fallback_rotates_before_reclaiming_checked_notes` | C26-class fallback determinism |
| `:24341` | `ctx_expand_and_ctx_note_facades_are_session_scoped` | Facade session scoping |
| `:24901` | `note_evaluate_verdict_writes_are_protocol_retired` | The `protocol_retired` code |
| `:25028` | `note_facade_pages_ready_notes_beyond_one_hundred_with_shared_offset_semantics` | Lead 8's paging contract |
| `:25299` | `facade_flat_envelope_precedence_keeps_kind_arm_and_gates_ctx_reduce_name` | `method`/`kind` precedence over `name` |
| `:25325` | `ctx_reduce_range_parser_rejects_unbounded_and_oversized_ranges` | `MAX_RANGE_ELEMENTS` (`:15166`) |
| `:25333` | `facade_arguments_preserve_decorated_reduced_fields` | The **non**-unwrap half of the reduced envelope |
| `:25445` | `facade_ctx_reduce_ack_validates_unknown_queued_and_protected_tags_without_committing` | C18's no-write behaviour |
| `:25531` | `ctx_manifest_schemas_accept_unknown_args_without_advertising_reduced_fields` | The whole schema contract: C5, C11, and the per-tool field sets |
| `:25657` | `expand_output_is_bounded_to_the_typescript_token_budget` | C16's byte bound |
| `:25713` | `facade_never_panics_on_malformed_memory_arguments` | Total-function behaviour on bad arguments |
| `:25762` | `facade_advertises_anti_memory_but_keeps_mutation_host_owned` | C12's refusal |

#### File-local tests in the four 4d files

The scope map assigns four whole files to 4d, and three of them carry their own
test modules that no `lib.rs` count reaches. This is a category 4c did not have
to handle.

| File | `#[cfg(test)] mod` | Tests | What they cover |
| --- | --- | --- | --- |
| `smart_note_evaluation.rs` (1,851 lines) | `:951` | **7** | `:1101` replays the shared golden (13 constants, backoff ladder, 23 transitions, 16 schedules, 9 selections); `:1190` and `:1765` replay `smart-note-evaluation-normative.json` (revision matrix, cycle traces); `:1528`, `:1549` the UTF-16 truncation rule; `:1558` extreme cron instants; `:1578` phase preference |
| `project_docs.rs` (232 lines) | `:120` | **6** | `:132` empty, `:139` render and hash, `:152` canonicalization, `:168` symlink skip, `:188` size skip, `:212` golden |
| `memory_tool.rs` (447 lines) | `:361` | **1** | `:396` `list_committed_claims_excludes_anti_memory_even_when_requested` — the sole check behind lead 5 |
| `dispatch.rs` (511 lines) | none | **0** | Its only checks are the integration binary below |

That is **14 file-local tests**, giving 102 in-crate checks for 4d in total.
`smart_note_evaluation.rs` is the densest claim-per-test surface in the
sub-part: 7 test functions carry roughly 48 fixture cases plus two normative
matrices over 950 production lines.

#### Targets in scope with zero test-module references

Re-counted at `HEAD` by matching each identifier across the whole file and again
over `:16001-30517` only.

| Target | Occurrences in file | In the test modules |
| --- | --- | --- |
| `claim_intent` (all four handlers, `:10068-10182`) | 15 | **0** |
| `claim_effects` (`handle_claim_effects_apply`, `:10184-10255`) | 2 | **0** |
| `claim.mirror` / `claim_mirror` (`:10257-10337`) | 28 / 20 | **0** (Part 3 covers the store side) |
| `note.delivery` / `handle_note_delivery_value` (`:11483-11545`) | 5 / 3 | **0** |
| `with_facade_command` | 5 | **0** |
| `facade_command_outcome` (`:15290-15311`) | 6 | **0** |
| `command_id_from_facade_request` (`:15246`) | 2 | **0** |
| `assemble_transform_page*` (`:13587-13699`) | 4 | **0** |
| `assemble_state_sync_seed` (`:13701-13784`) | 2 | **0** |
| `canonical_value` (`:15341-15372`) | 6 | **0** |
| `module_tools` | 1 | **0** |
| `project_docs` | 1 | **0** (6 file-local) |
| `smart_note_evaluation` | 6 | **0** (7 file-local) |

The mutation-ledger row deserves a note. `with_facade_command`,
`facade_command_outcome` and `command_id_from_facade_request` have zero symbol
references in the test modules, yet the ledger **is** exercised — through the
`ctx_note` request path, by `:23243`. So the ledger has behavioural coverage and
no unit coverage, which is why a symbol scan alone would have called it
untested. Stated so a later pass does not repeat either mistake.

#### `#[ignore]`, `should_panic`, and property tooling

**`#[ignore]`: none found** in `lib.rs` or the four 4d files.

**`should_panic`: 2 of the file's 4 fall in 4d's native-attachment plumbing**,
`:20646` and `:20695`, both asserting `"incremental native attachment cache
drift"` — the message of the production `assert_eq!` at `:13004-13007`. They are
the only tests in scope whose oracle is a panic.

**Property, mutation and concurrency tooling: none found.** Zero occurrences of
`proptest`, `quickcheck`, `loom`, `shuttle` or `miri` in the 4d files or
`lib.rs`. No `mutants.toml`, no coverage configuration, no `mc-module` entry in
`.config/nextest.toml`. Every placement statement in this file is structural
rather than measured. The one exception in spirit is the golden and normative
fixtures, which are table-driven and are the closest thing to generated coverage
in the sub-part.

### Integration and CI status (with workflow line refs)

**One integration binary is in 4d scope, it is the strongest check in the
sub-part, and CI does not run it.**

`tests/prepared_output.rs` (282 lines, **10 tests**) imports only
`mc_module::dispatch::{PreparedOutcome, PreparedOutput, PreparedOutputError,
PreparedSegment, MAX_WIRE_BODY_BYTES}` (`:5-7`) and nothing else from the crate.
Confirmed: it tests `dispatch.rs`, which the scope map assigns to 4d, and 4c
correctly declined it. What it covers, by test:

| Line | Test | Pins |
| --- | --- | --- |
| `:18` | `json_measurement_matches_small_and_facade_sized_bytes` | Measurement equals encoded length at two sizes |
| `:35` | `transform_segments_preserve_existing_golden_bytes` | Segment bytes are replayed verbatim |
| `:87` | `cached_bytes_copy_only_after_destination_reservation` | No copy before reservation |
| `:104` | `typed_errors_and_stream_markers_have_no_prepared_body` | `Error` and `Streamed` reserve nothing |
| `:134` | `exactly_at_wire_cap_succeeds_without_destination_allocation` | The cap boundary, inclusive |
| `:148` | `cap_plus_one_and_arithmetic_overflow_fail_before_write` | Cap+1 and overflow fail during counting |
| `:200` | `cancellation_before_reservation_or_write_emits_nothing` | Both cancellation windows |
| `:207` | `reserve_denial_emits_nothing` | The denial arm |
| `:234` | `destination_failure_retains_no_partial_terminal` | A write error yields no terminal |
| `:254` | `inconsistent_source_reports_length_mismatch_without_emission` | C8, via `PreparedSegment::inconsistent_for_test` |

Ten tests, all ten on C8's family, and the file re-implements the settlement
loop by hand (`:181-196`, per lens A) because `settle_prepared_with` is private.

The other six binaries are out of scope for 4d. Counting 4d method literals and
type names in each: `boundary_counter_durability.rs` 0, `broca_roundtrip.rs` 0,
`direct_host.rs` **0**, `host_adapter.rs` 1, `lifecycle_cli.rs` 0,
`release_contract_conformance.rs` 0. So `direct_host.rs`, which 4c counts as its
best end-to-end coverage, never touches a facade name — the facade has **no**
end-to-end coverage through a real `McHandler` at all.

**CI, verified at `HEAD` against all five files in `.github/workflows/`:**

- The only `mc-module` test invocation in any workflow is
  `cargo test -p mc-module --test lifecycle_cli`, at **`ci.yml:172` at `HEAD`**
  and **`ci.yml:168` at `76cd6f41`**. Both numbers confirmed by
  `git show 76cd6f41:.github/workflows/ci.yml`. `--test lifecycle_cli` selects
  one integration binary and does not build `--lib`, so no in-crate `mc-module`
  test compiles. The step above it is build-only,
  `cargo build -p mc-module --bin ck-mc-host` (`:169` at `HEAD`, `:165` at
  `76cd6f41`).
- The only other `mc-module` mention in `ci.yml` is a comment at `:361`.
- There is no `cargo test -p mc-module --lib`, no `cargo nextest run -p
  mc-module`, and no `--workspace` test job.

The drift the task named is real and now has three recorded values: the scope
map cites this step at `:167-168`, lens A at `:171-172`, and it is `:172` at
`HEAD` and `:168` at `76cd6f41`. All are the same step; only the file moved.

Consequence for 4d: **all 102 in-crate checks and all 10
`prepared_output.rs` checks run only on a developer's machine.** Every
`Existing check:` line in this part inherits 4c's unresolved question about
whether that scores as `partial` or `not yet`.

### TypeScript-side gates

`ci.yml:257` runs `bun run test`, which sweeps every `*.test.ts` under the
plugin tree. Four TypeScript files gate contracts this sub-part implements, and
**none of them tests this Rust code.** Whether each is a parallel
implementation or a fake of the module is stated per row, because the
distinction decides what the CI green light means.

| File | Relationship to 4d | What it actually tests |
| --- | --- | --- |
| `packages/plugin/src/features/magic-context/smart-notes/evaluation-state.test.ts` (136 lines, 3 `it()`) | **Parallel implementation, shared fixture.** The one genuine cross-language gate in scope | Replays `crates/mc-module/testdata/smart-note-evaluation-golden.json` (`:54`) but iterates `transition_cases` only (`:105`). The TypeScript reducer, not the Rust port. `schedule_cases` and `selection_cases` are untouched — C1 |
| `packages/plugin/src/features/magic-context/storage-notes.test.ts` | Parallel implementation, shared normative fixture | References `smart-note-evaluation-normative.json` (`:206`), the same fixture the Rust `:1190` and `:1765` tests replay |
| `packages/plugin/src/hooks/magic-context/module-state-sync.test.ts` | **Fake of this module.** Producer side of the claim-effects ack | `:1400` "delivers earlier effects first and checkpoints each receipt group atomically" and `:1424` "rejects a checkpoint that would split a receipt group" drive a stubbed `deliver` that fabricates the ack at `:1414` and `:1510`. Never invokes a Cargo target |
| `packages/plugin/src/hooks/magic-context/module-wire.test.ts` | **Fake of this module.** Wire-level ack validation | Literal `ackedEffectId: 30` / `31` at `:345`, `:355`, `:414`, `:427` |

**The cross-language acknowledgement dependency has no test from either side.**
Traced end to end: the module returns `ackedEffectId` without touching the store
(`lib.rs:10184-10255`, lens A); `module-wire.ts:725-733` throws `"claim effect
delivery response skipped checkpoint ..."` unless the value equals the expected
effect id; `module-state-sync.ts:2318-2327` repeats that check and then advances
the checkpoint inside a transaction (`:2328-2345`). Zero Rust tests reference
`handle_claim_effects_apply` or `claim_effects`. The TypeScript producer is
CI-tested against a stub that always returns the value the producer expects. So
each side's half is checked against a fake of the other, and the composition —
a real module ack advancing a real durable checkpoint — is checked nowhere.

One correction to lens A's record, in the module's favour: the advance is not
unbounded. `advanceOutboxCheckpoint`
(`packages/plugin/src/features/magic-context/memory/storage-claim-operations.ts:2216-2254`)
rejects a non-safe-integer or negative id (`:2218-2219`), rejects a regression
(`:2222-2224`), and rejects an id "beyond the outbox tail" (`:2241-2243`). So a
module ack cannot advance the checkpoint past effects the producer has not
written; it can only skip effects the producer has. That narrows the blast
radius of `facade-a-claim-effects-apply-acks-a-durable-checkpoint-with-no-module-effect`
without removing it, and those guards are covered by
`storage-claim-operations.test.ts` (12 `ackedEffectId` sites, `:852-1077`) under
`ci.yml:257`.

The asymmetry 4c found holds here and is sharper: the fixture is **shared**, so
"lifecycle behavior cannot drift between languages" is true only if both
replays run. One runs on every pull request; the other runs nowhere, and it is
the one that covers two of the fixture's three case groups.

### Production assertions and guards (clustered)

Measured over production lines only: `lib.rs:10042-11917` and
`:11919-16001`, plus the four whole 4d files.

**Runtime assertions: three, of which two are compiled out of release.**

| Site | Guard | Release? |
| --- | --- | --- |
| `lib.rs:11250-11253` | `debug_assert!(proposed_cycle.is_some(), "fresh claim committed without a proposed cycle update")` — C6's invariant, with the starvation failure named at `:11248-11249` | **No** |
| `lib.rs:13127-13130` | `debug_assert!(response.native_messages.is_some() \|\| response.native_messages_delta.is_some(), "successful serve_native response must carry full or delta native content")` | **No** |
| `lib.rs:13004-13007` | `assert_eq!(incremental_bytes, full_bytes, "incremental native attachment cache drift")` — the differential check behind the two `should_panic` tests | **Yes** |

So the one unconditional runtime assertion in 9,000 lines is a differential
equality on the native attachment path, and it is inside a differential block
whose enabling flag this lens did not trace. Zero compile-time `const _`
assertions in scope, unlike 4c's budget ceiling.

**Panicking sites: two `unreachable!`, zero `panic!`, zero `todo!`, zero
`unimplemented!`** in the two `lib.rs` ranges. `:12165` on
`PreparedOutcome::Response` in `settle_prepared_with`'s re-match (lead 7), and
`:15735` on the connect-failure CAS loop. Zero `.unwrap()` in either range.

**`.expect(`: 40 across the two `lib.rs` ranges** — 4 in `:10042-11917`
(`:10946`, `:11022`, `:11082`, `:11186`, all four note-evaluator mutex labels)
and 36 in `:11919-16001`, concentrated in the health and status envelope
(`:12053-12099`, 14 sites) and the native serializers (`:13003`, `:13005`,
`:12588`). The three named non-mutex labels are `"full native output must
serialize"`, `"incremental native output must serialize"` and `"OpenCode
sidecar metadata must serialize"`. None has a named test.

**The four 4d files.** `dispatch.rs`: 2 `.expect(`, zero `unwrap`, zero
`panic!`, zero assertions — the safest file in the sub-part, and the guard it
relies on is a returned `Err` (C8). `smart_note_evaluation.rs`: 19 `.expect(`,
19 `.unwrap()`, 14 `panic!` — all inside the `#[cfg(test)] mod` at `:951` and
its fixture parsing, so the production half of the file has none.
`project_docs.rs`: 1 `.expect(`, 15 `.unwrap()`, all in the test module at
`:120`. `memory_tool.rs`: 3 `.unwrap()`.

**Typed rejection guards: about 35 distinct error codes, and this is where the
invariants live.** With one release-time assertion in 9,000 lines, every other
guarantee is a `Result` or a typed code, so a violated invariant becomes a code
a caller may or may not surface. Counted over `:10042-16001`: the most-used are
`note_store_failed` (5 sites, collapsing every store failure on the
note-evaluation protocol), `encode_failed` (4), `route_unbound` (3),
`claim_intent_encode_failed` (3), `bad_request` (3). The note-evaluation
protocol contributes `protocol_unsupported`, `protocol_retired`,
`positive_wait_unsupported`, `registration_unknown`. The claim ledger's three
codes are one per handler — `claim_intent_stage_failed`,
`claim_intent_inspect_failed`, `claim_intent_ack_failed` — each collapsing every
`Err` including the identity conflict (lens A's record). Two codes exist purely
to convert a nominally successful transform into a typed error,
`transform_native_response_omitted` and `transform_delta_unexpanded`
(`respond_transform`, `:13366-13381`), which is the guard lens A correctly
observes the facade lacks.

**Response fields carrying a semantic promise: seven.** Counted over
`:10042-16001`: `ok` (6 sites), `replayed` (5), `wake_owned` (5), `dismissed`
(4), `ackedEffectId` (2), `isError` (2, the two constructors at `:13791-13800`),
`cycle_exhausted` (1). `replayed` is the only idempotency signal on the facade
and it appears on three of eleven routed names (lens A); `cycle_exhausted` is
the single-site field carrying the two-cause `no_work` distinction
`PARITY.md:41-52` spends twelve lines on.

**Discarded results: three `let _` sites in `:11919-16001`** — `:12337`,
`:12539`, `:12617` — and **zero in `:10042-11917`**. Lower than 4c's six, and
this lens did not read whether each is licensed by a comment.

**Test seams in scope: one, and it is the only reason C8 is provable.**
`PreparedSegment::inconsistent_for_test` (`dispatch.rs:64-71`, doc at `:64`:
"Constructs a deliberately inconsistent segment for length-check tests"), used
by `prepared_output.rs:254`. Production has no source whose measured and written
lengths differ, so without this seam the length check would be unfalsifiable.

---

## Suspiciously quiet areas

Ranked by the gap between what the code decides and what any check proves.
Attention paid, as instructed, to the success-shaped error paths.

1. **The claim intent ledger and claim effects are the quietest thing in 4d and
   two of them are the success-shaped paths.** `claim_intent` has 15 whole-file
   occurrences and **0** in the test modules; `claim_effects` has 2 and **0**.
   That covers `:10068-10255`, 188 production lines routing four facade names,
   three of which discard the route identity their own doc calls "the only
   trustworthy authority identity" (C19). Of lens A's four success-shaped error
   paths, `claim.effects.apply` is the one with **no test on either side of the
   language boundary** (see the TypeScript section), and the module's own doc
   says nothing about the ack being validation-only.

2. **Six success-shaped error paths, one tested.** Tallying lens A's four plus
   lead 1's two: `isError` inside a transport success (no test asserts
   `health()` stays `Ok` while the facade fails); `ctx_reduce`'s queued
   acknowledgement (**tested** at `:25445`, which asserts the no-write
   behaviour); `claim.effects.apply`'s ack (untested, item 1); the two
   error-text-as-durable-outcome note arms at `:11865-11870` and `:11902-11907`
   (untested — `:23243` proves a recorded **success** replays and nothing
   replays a recorded failure); and `ctx_expand`'s two unrecoverable-content
   answers at `:10804-10809` and `:10832-10838` (untested as *classification* —
   `:24517` and `:25657` cover the budget, not the `isError` value). So one of
   six has a check, and it is the one whose behaviour was deliberate.

3. **`handle_note_delivery_value` has zero references.** 63 production lines
   (`:11483-11545`) carrying three rejections including `"delivery
   acknowledgement session_id does not match the channel binding"` (`:11516`),
   which is a cross-session guard, and `note.delivery` appears 5 times in the
   file and 0 in the tests. This is the delivery half of the note lifecycle
   whose acquisition half has 17 tests.

4. **The claim mirror facade handlers have zero module-side references** and
   Part 3 owns the store side. `claim.mirror` appears 28 times in the file and 0
   in the test modules. The boundary is real and recorded in the scope map
   (`:667`), but the module-side protocol-version gates at `:10279` and `:10317`
   and the presence-only route check at `:10262`, `:10300` are on 4d's side of
   it and nothing in either crate covers them.

5. **Page and seed reassembly has zero references and seven distinct
   rejections.** `assemble_transform_page*` (4 occurrences, 0 in tests),
   `assemble_state_sync_seed` (2, 0), spanning `:13587-13784`, with the
   continuation-marker rejections at `:13584`, `:13601`, `:13606`, `:13612`,
   `:13619`, `:13627`, `:13655`. 4c found the paged-transform *protocol* to be
   its quietest surface with a CI-gated TypeScript sender; the reassembly half
   sits in 4d and is equally quiet. The two halves of one protocol are
   unowned in two adjacent sub-parts.

6. **`canonical_value` has zero references** (6 occurrences, `:15341-15372`).
   Canonicalization is what makes the facade command ledger's identity stable
   across argument reorderings; nothing pins it.

7. **The DST schedule vectors and phase selectors are pinned by one replay that
   runs nowhere.** C1. 16 schedule cases and 9 selection cases in a fixture
   whose entire purpose is preventing cross-language drift, asserted only by
   `smart_note_evaluation.rs:1145` and `:1156`, in a test module CI never
   compiles, while the TypeScript half of the contract is checked on every pull
   request over the 23 transition cases only.

8. **The project-docs TOCTOU re-check has no test.** C22. The guard's stated
   threat model is exfiltrating `~/.ssh/id_rsa` into the trusted m0 baseline
   (`project_docs.rs:7-8`), the file has six tests, and none of them interleaves
   anything between the stat at `:69` and the read at `:73`. The claim that the
   gap is *closed* is the strongest security claim in the sub-part and rests on
   the one line no test exercises.

9. **`facade_arguments`' unwrap branch is unreached and its sibling is
   tested.** `:25333` proves the precedence half — with a primary field present,
   the `reduced`/`summary` envelope is preserved verbatim and a stray key
   survives — and no test drives the branch where the envelope becomes the
   argument map (`:14421-14434`). This **confirms** lens A's `Exercised: not
   yet` and supplies the nearest existing check its record records as "none
   found on the Rust side".

10. **The facade has no end-to-end coverage through a real `McHandler`.**
    `direct_host.rs` has zero 4d method literals; `host_adapter.rs` has one. 4c
    could point at three integration tests driving real handlers across a
    process restart. 4d has ten integration tests, all on `dispatch.rs`, and
    zero on the eleven routed facade names.

11. **One unconditional runtime assertion in about 9,000 production lines.**
    `:13004`. The other two guards are `debug_assert!` and one of them is the
    sole enforcement of C6's cursor invariant, which `PARITY.md` spends
    seventeen lines specifying.

12. **Four hand-written mutex labels with no consistency check.** Same shape as
    4c's finding at a twelfth the count. Listed because the enforcement is zero,
    not because the consequence is large.

---

## Open questions

- Does a second sibling lens own note evaluation? The task named two sibling
  files and only `lens-a-facade-and-assembly.md` exists at `HEAD`, while lens A
  states a note-evaluation lens owns `smart_note_evaluation.rs`, the
  `note.evaluation.*` protocol at `lib.rs:10880-11481`, and note delivery at
  `:11483-11545`. This lens covered note-evaluation *claims and checks* rather
  than leave the register incomplete. If that lens lands, C1, C2, C3, C6, C7,
  the 17-test cluster, the 7 file-local `smart_note_evaluation.rs` tests, and
  quiet areas 3 and 7 will need dedup at synthesis. (needs human input)
- Is `claim.effects.apply` intended as a protocol-conformance ack? Lens A asks
  this and this lens adds the evidence that decides how urgent it is: no test on
  either side of the language boundary covers the composition, and the
  TypeScript checkpoint guards
  (`storage-claim-operations.ts:2218-2243`) bound the damage to *skipped*
  effects rather than fabricated ones. (needs human input)
- Should the TypeScript golden replay be extended to `schedule_cases` and
  `selection_cases`, or is the Rust-only replay of those two groups deliberate
  because the TypeScript reducer does not own scheduling? `PARITY.md:87` lists
  "shared Rust cron/schedule primitive" as *deferred* ownership
  (`magic-context-pml.1`), which suggests the asymmetry is known. Unresolved,
  needs the smart-notes owner.
- Which side of C17 is the contract, characters or bytes? Three advertised
  `maxLength` values match their byte caps numerically, so the mismatch only
  fires on multi-byte input. Fixing the schema and fixing the cap are both
  breaking changes in one direction. (needs human input)
- Is `ctx_search`'s advertised project-memory search planned or abandoned? C13.
  `load-bearing-rules-checklist.md:1221` says "broad project-memory retrieval
  stays disabled until the claim retrieval projection is active", which reads as
  planned; `lib.rs:15779` promises it to the model today. Unresolved, needs the
  prompt-surface owner.
- Does the repository want a check tying `handle_facade_value`'s match arms to
  `module_tools`? C20 is the only claim in this register that is false in both
  directions, and `:25531` already proves the schema side is gate-able.
  (needs human input)
- METHOD.md's `Exercised` values still do not settle how to score a check that
  exists and never runs in CI. It governs all 112 checks inventoried here. 4c
  raised it, the scope map raised it at `:681`, lens A raised it. Still needs a
  ruling. (needs human input)

---

## Corrections to references I was handed

- **`ci.yml` drift, three values, all real.** The `mc-module` test step is
  `ci.yml:172` at `HEAD` and `ci.yml:168` at `76cd6f41`, exactly as the task
  states; both confirmed. The scope map cites `:167-168` (`:414`) and lens A
  cites `:171-172` (`:796-800`). All four numbers describe the same step.
- **`tests/prepared_output.rs` confirmed in 4d scope.** It imports only
  `mc_module::dispatch::{...}` (`:5-7`) and covers C8's family with 10 tests
  (table above). 4c's decision to exclude it (`existing-checks.md:128`, `:524`)
  is correct.
- **The prior pass's "28 tests attributed to 4d" is not corrected.** It measures
  the 4c-to-4d hand-off, not 4d's total. 4d's independent claim-bearing count is
  **88** in-crate plus **14** file-local; the 4c-overlapping subset is 11 by
  direct symbol match and up to 49 by their name rule, and 28 sits inside that
  band. Reasoning in the attribution section.
- **`conditioned_write_replays_recorded_response_without_live_evaluator` is at
  `lib.rs:23243`, not `:23242`.** Lens A cites `:23242-23292`; `:23242` is the
  `#[tokio::test(flavor = "current_thread")]` attribute and the `fn` line is
  `:23243`. The substance is unchanged.
- **Lens A's `:25632-25641` and `:25652-25653` are both inside one test.** The
  enclosing function is
  `ctx_manifest_schemas_accept_unknown_args_without_advertising_reduced_fields`
  at **`:25531`**, running to about `:25654`. Citing `:25531` gives a later pass
  the whole gate, which asserts five separate things (C5, C11, per-tool field
  sets, the open-schema posture, and the absence of `reduced`/`summary` from
  `properties`).
- **Lens A's open question on `ctx_reduce`'s schema is answered in-repo.** The
  comment at `:25574-25578` states that the closed schema is the authorizer
  contract and that "its imitated-args tolerance lives in the execution unwrap,
  not the advertised schema". Per METHOD.md rule 3 that settles intent, not
  correctness: nothing asserts the handler's accepted key set.
- **Lens A's "none found on the Rust side" for the reduced-envelope record has a
  near miss.** `facade_arguments_preserve_decorated_reduced_fields` (`:25333`)
  pins the non-unwrap precedence half. The unwrap branch remains unreached, so
  the record's `Exercised` value is right and its `Existing check` line should
  name `:25333`.
- **The claim intent ledger span.** The task places it at `lib.rs:10082-10182`,
  which is exactly `handle_claim_intent_stage` through
  `handle_claim_intent_ack`. Lens A already notes the scope map's `10068-10182`
  (`:234`) includes `claim_route_root`, which C19 depends on. This lens uses
  `:10068-10182` for the contract and `:10082-10182` for the handlers.
