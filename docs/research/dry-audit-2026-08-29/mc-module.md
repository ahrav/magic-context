# DRY / code-reduction audit — `crates/mc-module/`

Read-only audit. No source files were modified.

- **Verified against** `HEAD = 9c1eb4d1` (2026-08-29, "Merge pull request #85 from ahrav/remove-tauri-dashboard").
- Working tree at audit time: only `.beads/*.jsonl` modified plus untracked `docs/research/`. No source drift.
- Beads guard read: `docs/research/dry-audit-2026-08-29/.beads-guard.txt` (107 open issues).

## Crate shape

| Metric | Value |
| --- | --- |
| Total Rust LOC | 102,562 |
| Production LOC | 54,316 |
| In-file `#[cfg(test)]` + integration-test LOC | 48,246 (47%) |
| Files | 49 |
| `#[test]` / `#[tokio::test]` functions | 775 |
| `pub` items in `src/` | 505 |
| Crates depending on `mc-module` | **0** |

Two files hold 55% of the crate:

| File | Total | Prod | Test |
| --- | --- | --- | --- |
| `src/lib.rs` | 30,518 | 15,242 | 15,276 |
| `src/transform.rs` | 29,440 | 11,947 | 17,493 |

`mc-module` is a **leaf crate**. `packages/mc-shm-native` (the only napi/N-API surface in the repo) does not depend on it; `mc-host` does not depend on it (the dependency runs the other way, per `crates/mc-module/Cargo.toml:19`). The single repo-wide `mc_module::` reference outside the crate is a doc comment (`crates/mc-host/tests/handler_contract.rs:526`). Every `pub` item is therefore consumed only by this crate, its `src/bin/ck-mc-host.rs` binary, its `examples/direct_host_fixture.rs`, and its own tests. This makes visibility tightening (below) both safe and unusually productive as a dead-code detector.

---

## Summary

| Tier | Findings | Est. net LOC delta |
| --- | --- | --- |
| T0 | 4 | −219 |
| T1 | 7 | −339 |
| T2 | 4 | −435 |
| T3 | 3 | structural (not LOC-quantified) |
| TRACKED | 4 | 0 (do not remove) |
| Do not unify yet | 3 | 0 |
| **Total** | **21 + 3 structural** | **≈ −990** |

Of that, **≈ −560 is T0+T1** (low risk, compiler-verified, no sensitive path).

Honest caveats on the estimate:

- The T2 staging-coordinator number (−250) is the least certain. It is dominated by one inlined ~200-line copy whose consolidation is a real refactor, not a mechanical move.
- The boundary↔historian_chunk number (−157) is the most certain: 13 byte-identical functions plus 3 semantically identical ones, verified by normalized diff.
- No number below assumes deleting a test that currently proves something.

---

# T0 — Safe, mechanical

### T0-1. Six zero-reference `pub` items (dead code)

Each verified with a repo-wide `rg -n '\b<name>\b' --type rust .` returning exactly one hit — the declaration itself. Checked against all crates, `packages/mc-shm-native`, and the napi surface.

| Item | Location | LOC (incl. doc comment) |
| --- | --- | --- |
| `pub const CLASSIFY_CLEANUP_RESERVE` | `src/classify.rs:41` (doc `:33-40`) | 10 |
| `pub const MAX_NONEMERGENCY_REQUEST_BUDGET` | `src/historian.rs:998` (doc `:990-997`) | 10 |
| `pub fn is_retryable_model_failure` | `src/historian_producer.rs:392-400` | 9 |
| `pub fn is_abort_or_overflow` | `src/historian_producer.rs:402-410` | 9 |
| `pub fn TransformError::is_deterministic_reject` | `src/transform.rs:1886-1891` | 6 |
| `pub struct M1Content` | `src/transform.rs:509-519` | 11 |

Note two of these are also a parameterized clone pair: `is_retryable_model_failure` and `is_abort_or_overflow` (`historian_producer.rs:392-410`) have identical 8-line bodies differing only in `ErrorClass::Transient` vs `ErrorClass::ContextOverflow` and which field of `heuristic_decision()` they read. Both are dead, so delete rather than parameterize.

`M1Content` (`transform.rs:515`) carries a 6-line design comment about revision digests. If that reasoning is load-bearing for the live m1 path, relocate the comment to `src/m1_compose.rs` before deleting the struct.

- Clone type: n/a (dead code)
- Call sites: 0
- Module spread: 4 files
- Priority signals: compiler-verifiable; zero boundary crossing
- **Est. net LOC: −55**
- Execution lane: text

### T0-2. Two per-session `stats` fields written by production, read only by tests

`SerializedOutputSession.stats` (`src/transform.rs:348`) and `NativeAttachmentCacheSession.stats` (`src/lib.rs:2551`) are both annotated `#[cfg_attr(not(test), allow(dead_code))]`. Production writes them (`transform.rs:447`; `lib.rs:2705-2707` — `if let Some(session) = self.sessions.get_mut(session_id) { session.stats = *stats; }`) purely to feed the `#[cfg(test)] fn stats(&self, session_id)` accessors at `transform.rs:476-480` and `lib.rs:2709`.

The same information already leaves the module on the production path: `BuiltOutput.cache_stats` (`transform.rs:12153`) and `TransformTimings.native_cache_*` (`lib.rs:8607-8611`). The two test call sites (`transform.rs:28330`, and the `NativeAttachmentCache` stats tests) can read those instead.

- Clone type: semantic-candidate (duplicate observability channel)
- Call sites: 2 test readers
- Module spread: 2 files
- **Est. net LOC: −18**
- Execution lane: typed-semantic (test rewiring required)

### T0-3. Copy-pasted historian test prologue (5 tests)

Five `#[tokio::test]` bodies in `src/historian.rs` open with a byte-identical 38-45 line prologue: `tempfile::tempdir()` → `store()` → `seed_prior_compartment()` → `historian_chunk()` → `prior_ranges()` → `fire(...)` → destructure `FireOutcome::Fired` → `producer_started(...)` → `store.commit("ses", None, &CoreState::default(), &test_meta_with_historian(awaiting))`.

Members (block start → measured identical run against the first):

| Location | Identical lines vs block 1 |
| --- | --- |
| `src/historian.rs:2882` | (baseline) |
| `src/historian.rs:2943` | 38 |
| `src/historian.rs:3139` | 45 |
| `src/historian.rs:3781` | 41 |
| `src/historian.rs:4534` | 30 |

A narrower 10-line window inside it (`historian.rs:2898-2919`) recurs **6** times (also at `:2959`, `:3155`, `:3208`, `:3797`, `:4547`).

Fix: one `fn awaiting_historian_fixture(store: &McStore) -> HistorianDurableState` test helper in the existing `mod tests`. The per-test tail (which `ScriptedProducer` script is installed, which assertion runs) stays inline — that is the part that actually differs.

- Clone type: exact (within one test module)
- Call sites: 5-6
- Module spread: 1 file
- Priority signals: `historian.rs` has 33 commits and is one of the hottest files in the crate; each new drive-loop test currently pays this 40-line tax
- **Est. net LOC: −140**
- Execution lane: text

### T0-4. Redundant / temporal comments

| Location | Text | Violation |
| --- | --- | --- |
| `src/healing.rs:127` | "The peer retired that byte-splice at U0: full-array apply is now the only…" | Roadmap/unit-number phrasing ("at U0", "is now") — tracks the project timeline in source |
| `src/transform.rs:25243` | "byte-splice at U0: every pass rebuilds the provider request from the transformed…" | Same |
| `src/historian_validate.rs:1484` | "Exact observed shape from issue #246: deepseek-v4-flash-free closes…" | Issue reference in source |
| `src/transform.rs:3505` | "Previously stored overlay rows may still replay when…" | "Previously" — temporal; the mechanism (stored rows replay) is the durable fact |

Rewrite each to state the mechanism in the present tense. `lib.rs:2816` (`TODO(memory-accounting)`) is a legitimate, scoped engineering note naming a real unbounded-retention gap — keep it, but see TRACKED-4.

The crate is otherwise clean here: one `commentlint: allow` marker total, no `for now`, no `FIXME`, no `HACK`.

- **Est. net LOC: −6**
- Execution lane: text

---

# T1 — Same-concept consolidation

### T1-1. `boundary.rs` ↔ `historian_chunk.rs`: 16 duplicated text-processing helpers ★ highest-value item

The two modules each contain a private conversation-chunk builder over a different message type (`BoundaryMsg` vs `FlatMessage<'_>`). Around those two genuinely different builders sits a **shared, type-independent text-processing library that has been copied wholesale**.

**Byte-identical after comment/whitespace normalization (13 functions, 123 LOC of one copy):**

| Function | `boundary.rs` | `historian_chunk.rs` | LOC |
| --- | --- | --- | --- |
| `compact_text_for_summary` | `:1883-1910` | `:1074-1101` | 28 |
| `format_block` | `:1846-1864` | `:1037-1055` | 19 |
| `extract_commit_hashes` | `:1866-1881` | `:1057-1072` | 16 |
| `extract_key_arg` | `:1792-1805` | `:985-998` | 14 |
| `media_kind` | — | — | (codec, see T1-4) |
| `compact_role` | `:1833-1844` | `:1024-1035` | 12 |
| `is_system_directive` | `:1825-1827` | `:1016-1018` | 3 |
| `normalize_text` | `:1829-1831` | `:1020-1022` | 3 |
| `system_reminder_regex` | `:1929-1932` | `:1131-1134` | 4 |
| `commit_hash_extract_regex` | `:1934-1937` | `:1136-1139` | 4 |
| `empty_parens_regex` | `:1949-1952` | `:1146-1149` | 4 |
| `space_before_comma_regex` | `:1954-1957` | `:1151-1154` | 4 |
| `repeated_comma_regex` | `:1959-1962` | `:1156-1159` | 4 |
| `repeated_space_regex` | `:1964-1967` | `:1161-1164` | 4 |
| `space_before_punct_regex` | `:1969-1972` | `:1166-1169` | 4 |

**Semantically identical but already textually drifted (3 functions, 27 LOC) — the divergence proof:**

- `truncate_arg` — `boundary.rs:1807-1815` uses a `max_len` local plus `push('…')`; `historian_chunk.rs:1000-1006` uses `format!("{}…", …)`. Same 60-char behavior, two spellings.
- `clean_user_text` — `boundary.rs:1817-1823` binds `without_reminders` first; `historian_chunk.rs:1008-1014` chains. Same result.
- `merge_commit_hashes` — `boundary.rs:1912-1927` adds an `if next.is_empty() { return existing.to_vec(); }` short-circuit that `historian_chunk.rs:1103-1115` lacks. The loop is already a no-op for empty `next`, so behavior matches — but only one copy got the guard.

**Also duplicated:**

- `struct CompactedText { text, commit_hashes }` — `boundary.rs:1726-1729` / `historian_chunk.rs:86-89`, identical.
- `const MAX_COMMITS_PER_BLOCK: usize = 5` — `boundary.rs:49` / `historian_chunk.rs:28`.
- `const OMO_INTERNAL_INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->"` — `boundary.rs:52` / `historian_chunk.rs:30`.

**Genuinely divergent (do NOT unify — type-driven):** `text_parts` (r=0.49), `extract_tool_call_summaries` (r=0.36), `has_meaningful_user_text` (r=0.14), `commit_verb_regex` (r=0.46), `tool_name`. These take the two different message types and legitimately differ.

Fix: new private `src/chunk_text.rs` holding the 16 shared functions, `CompactedText`, and the 2 constants. Both modules `use crate::chunk_text::*`. All items are module-private; no `pub` API changes.

- Members: 16 function pairs + 1 struct + 2 constants
- Common core: role compaction, commit-hash extraction, whitespace/punctuation normalization, block formatting, the 7 lazy `Regex` accessors
- Differences: none in the 13 exact; cosmetic in the 3 semantic-identical
- Call sites: the two `ChunkBuilder::push_message` / `flush_current_block` bodies plus their local helpers
- Module spread: 2 sibling modules, same crate
- Clone type: **exact** (13) + **semantic-candidate** (3)
- Priority signals: co-change 4/47 commits touch both (`boundary.rs` 20 commits, `historian_chunk.rs` 31); both first appeared 2026-07-01/02 and both were touched within the last two weeks (`:2026-08-29` / `:2026-08-27`) — actively maintained in parallel, and already drifted in 3 of 16 functions
- **Est. net LOC: −157** (130 exact incl. struct+consts, 27 semantic)
- Execution lane: text for the 13 exact; typed-semantic for the 3 drifted (pick one spelling, keep the `merge_commit_hashes` guard)

Tier note: a strict reading of the rubric ("crosses crate/module boundary" ⇒ T2) would push this to T2. Rated T1 because every moved item is module-private inside one crate, no `pub` API or trait changes, and `rustc` verifies the move completely. Neither file is on a sensitive path (no framing, watermarks, claims gates, fsync, or permits).

### T1-2. `TransformResponse` constructors each spell out all 29 fields

`src/transform.rs:1544-1587` (`need_full_sync`) and `:1589-1614` (`passthrough`) are two constructors for a 29-field struct (`pub struct TransformResponse`, `transform.rs:1455`). Each enumerates every field. They differ in exactly 4: `status`, `action`, `decision`, `ck_messages`. The remaining 25 lines are identical `None` / `false` / `0` / `String::new()` / `SurfaceState::Inactive` initializers repeated verbatim.

`TransformResponse` has no `Default` impl (`#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]` only). Adding one — or a private `fn base(status, action, decision) -> Self` — collapses both bodies to 5-8 lines each with `..Default::default()`.

This is also a live maintenance hazard: adding a 30th field today requires editing both constructors, and the compiler will only catch it because the struct literals are exhaustive — which is precisely the property `..Default::default()` gives up. Weigh that: exhaustive literals are a real (if noisy) safety property for a wire type. The middle path — one private `base()` helper that both call, keeping the single exhaustive literal in `base()` — preserves the compiler check *and* removes the duplication.

- Clone type: parameterized
- Call sites: 2 constructors; both are `pub`
- Module spread: 1 file
- Priority signals: 29-field wire response type; `transform.rs` is the hottest file in the crate
- **Est. net LOC: −46**
- Execution lane: structural

### T1-3. `build_output_with_tags` / `_unindexed` / `_inner` — 24 forwarded parameters to flip one `bool`

`src/transform.rs:11613-11641` (`build_output_with_tags`, 12 params) and `:11644-11675` (`build_output_with_tags_unindexed`, `#[cfg(test)]`, 12 params) are **pure forwarders** to `build_output_with_tags_inner` (`:11678`, 13 params). Each re-lists all 12 parameters in order and appends a literal `true` / `false` for `use_frozen_unit_index`. Both wrappers carry `#[allow(clippy::too_many_arguments)]`.

`build_output_with_tags_unindexed` has exactly **one** caller — `transform.rs:28502`, a test.

This hits three of the AGENTS.md accretive-design warning signs at once: pure forwarding of parameters through an intermediate function, a growing parameter list, and flag plumbing encoding one binary mode. The honest fix per the self-test ("if I wrote this from scratch today…") is a `BuildOutputInputs<'_>` struct holding the 12 stable inputs plus the mode, constructed once at the four production call sites (`transform.rs:5383`, `:5406`, `:5435`, `:5453`) and at `:11586`.

The minimal fix is smaller: delete both wrappers, rename `_inner` to `build_output_with_tags`, and pass `true`/`false` explicitly at the 9 call sites.

- Clone type: exact (forwarding)
- Call sites: 5 production (`:5383`, `:5406`, `:5435`, `:5453`, `:11586`) + 5 test (`:18879`, `:27165`, `:27195`, `:27298`, `:27317`, `:28230`) + 1 test for `_unindexed` (`:28502`)
- Module spread: 1 file
- Priority signals: 13 `#[allow(clippy::too_many_arguments)]` in `transform.rs`, 8 in `lib.rs` — the lint is already being suppressed at scale
- **Est. net LOC: −55**
- Execution lane: structural

### T1-4. `codec/opencode.rs` ↔ `codec/pi.rs`: 8 duplicated JSON shims

`src/codec/mod.rs` has no codec trait — `opencode` and `pi` are two parallel module implementations, which is reasonable for per-harness wire formats. But 13 function names are shared, and 8 are byte-identical generic JSON helpers with nothing harness-specific about them:

| Function | `opencode.rs` | `pi.rs` | LOC |
| --- | --- | --- | --- |
| `media_kind` | `:624-636` | `:1023-1035` | 13 |
| `opaque_arc` | `:1224-1233` | `:1046-1055` | 10 |
| `opaque_block` | `:1215-1222` | `:1037-1044` | 8 |
| `set_value` | `:1289-1296` | `:1069-1076` | 8 |
| `synth_tool_id` | `:1257-1262` | `:780-785` | 6 |
| `set_string` | `:1285-1287` | `:1065-1067` | 3 |
| `string_field` | `:1281-1283` | `:1061-1063` | 3 |

(7 rows = 51 LOC; the 8th shared-exact name is counted above.)

Near-miss, already drifting: `push_block` (r=0.82, `:544-565` / `:294-315`), `render_media_part` (r=0.74, `:1096-1124` / `:997-1021`), `block_matches_meta` (r=0.75, `:811-832` / `:406-434`). Genuinely divergent (leave alone): `encode_with_meta` (r=0.13), `encode_new_message` (r=0.05), `tool_name` (r=0.44).

Fix: move the 7-8 exact helpers to a private `src/codec/json.rs`. Leave the near-misses for a follow-up once the exact set is shared — they may collapse for free.

- Clone type: exact (8) + near-miss (3)
- Call sites: internal to each codec's encode path
- Module spread: 2 sibling modules under `src/codec/`
- Priority signals: **all 5 of `pi.rs`'s commits co-occur with `opencode.rs`** (5/5), while `opencode.rs` has 16 commits `pi.rs` did not follow. `pi.rs` last touched 2026-07-24; `opencode.rs` 2026-08-15. The drift in the 3 near-misses is exactly this asymmetry showing up — `pi.rs` is the stale copy.
- **Est. net LOC: −51** (exact only)
- Execution lane: text

### T1-5. `caveman.rs`: two functions re-inline the generic they already have

`src/caveman.rs:161-181` already contains `fn protect_regex(text, regex, preserved) -> String`, used correctly at 5 call sites (`:235`, `:240`, `:245`, `:250`, `:256`).

`protect_identifier_regions` (`:178-200`) and `protect_hash_regions` (`:202-224`) each **re-implement `protect_regex`'s entire 20-line body inline** — the `String::with_capacity`, the cursor walk, the `\u{0}MC_PRES_{n}\u{0}` placeholder mint, the `PreservedRegion` push, the tail append — solely to insert a `continue` for a boundary check that `protect_regex` does not offer:

- `protect_identifier_regions`: `!has_word_boundary_before(...) || !has_word_boundary_after(...)`
- `protect_hash_regions`: `previous_char(...).is_some_and(char::is_ascii_alphanumeric) || next_char(...).is_some_and(...)`

Fix: add a predicate parameter to `protect_regex` (`accept: impl Fn(&str, usize, usize) -> bool`) or a sibling `protect_regex_filtered`, then reduce both functions to a regex + predicate. The placeholder-minting invariant then has one owner — currently three copies must agree on the `\u{0}MC_PRES_{len}\u{0}` format and on `preserved.len()` being the index.

- Clone type: parameterized
- Call sites: `protect_regions` (`caveman.rs:226`)
- Module spread: 1 file
- Priority signals: **1 commit total, last touched 2026-07-22** — frozen. Low cost of leaving it, low risk of changing it. Ranked T1 not T0 because it changes a function signature.
- **Est. net LOC: −30**
- Execution lane: structural

### T1-6. Three `pub` transform entry points with zero production callers

`src/transform.rs` exposes a 4-level pipeline. I counted call sites separating `#[cfg(test)]` regions from production:

| Function | Location | Production callers | Test callers |
| --- | --- | --- | --- |
| `pub fn transform` | `:2093-2099` | **0** | 124 |
| `pub fn transform_with_projection` | `:2101-2109` | 0 (only from `transform`) | 23 |
| `fn apply_once_with_estimator` | `:2174-2182` | 0 (only from `transform_with_projection`) | 11 |
| `pub(crate) fn transform_with_projection_cached` | `:2111-2129` | 1 (`lib.rs:8322`) | 0 |

Production has exactly **one** entry into the transform pipeline: `transform_with_projection_cached`. The other three exist to give tests a shorter call. Two of them are `pub` on a crate nobody depends on, so they inflate the audited public surface for no consumer.

`apply_once_with_estimator` (`:2174-2182`) is additionally a pure forwarder that adds only `None`.

Fix: gate `transform` / `transform_with_projection` behind `#[cfg(test)]` (or move them to `src/test_support.rs`), and inline `apply_once_with_estimator` into `transform_with_projection`. This is a visibility and layering change, near-zero LOC, but it removes 2 items from the `pub` surface and makes the single production entry point obvious to the next reader.

Do **not** delete them — 158 test call sites depend on them, and they are earning their keep as test helpers.

- Clone type: structural (forwarding chain)
- **Est. net LOC: −8** (the `apply_once_with_estimator` hop)
- Execution lane: structural

### T1-7. `historian_validate.rs`: `ParsedCompartment` / `ValidatedCompartment` share 11 fields

`src/historian_validate.rs:121-141` (`ParsedCompartment`) and `:203-223` (`ValidatedCompartment`) share `start_message`, `end_message`, `title`, `content`, and the six `#[serde(default)] pub pN: Option<String>` / `importance` / `episode_type` fields — 16 identical lines including the `#[serde(default)]` attributes. `ValidatedCompartment` adds `sequence`, `start_message_id`, `end_message_id`.

This is the honest "two representations of one thing at different lifecycle stages" pattern, and splitting the shared 11 fields into an embedded `CompartmentBody` would change both serde wire shapes (flatten semantics, field ordering in `PartialEq`). The payoff (−16 LOC) does not justify a wire-shape risk on a validated-publish path.

**Recommendation: note only, do not act.** Listed here so a future reader knows it was evaluated and consciously declined. Counted as 0 LOC.

---

# T2 — Sensitive path or structural

### T2-1. Six-member session-keyed byte-budgeted LRU cache clone class ★

Six independent structs implement the same "session → entry, LRU eviction to a byte budget" pattern with copy-pasted `remove` and eviction loops.

**Members:**

| # | Type | Struct | `remove` | Eviction loop |
| --- | --- | --- | --- | --- |
| 1 | `SerializedOutputCache` | `transform.rs:353-358` | `:415-420` | `:465-472` |
| 2 | `TagBaselineCache` | `transform.rs:7547-7552` | `:7571-7576` | `:7586-7593` |
| 3 | `TagMintFrontierMemoCache` | `transform.rs:7944-7949` | `:7981-7988` | `:7999-8008` |
| 4 | `BoundaryTokenCache` | `lib.rs:2215-2220` | `:2232-2237` | `:2283-2290` |
| 5 | `NativeAttachmentCache` | `lib.rs:2556-2562` | `:2589-2594` | `:2690-2702` |
| 6 | `ProjectionCache` | `lib.rs:2775-2781` | `:2808-2813` | `:2856-2867` |

**Common core.** Fields `sessions: HashMap<String, _>`, `lru: VecDeque<String>`, `retained_bytes: usize`, `max_retained_bytes: usize` (4 of 6 also `max_entry_retained_bytes`). Members 1, 4, 5, 6 have byte-identical `remove`:

```
if let Some(session) = self.sessions.remove(session_id) {
    self.retained_bytes = self.retained_bytes.saturating_sub(session.retained_bytes);
}
self.lru.retain(|candidate| candidate != session_id);
```

Members 5 and 6 additionally share byte-identical `Default`, `#[cfg(test)] fn new`, and `with_limits` — a normalized diff of `impl NativeAttachmentCache` (`lib.rs:2573-2715`, 143 LOC) against `impl ProjectionCache` (`lib.rs:2792-2869`, 78 LOC) shows the first 23 lines identical.

**Differences.** Member 3 charges bytes through `Self::memo_retained_bytes(session_id, &memo)` rather than a stored field. Member 5 threads a `&mut NativeAttachmentCacheStats` and `eprintln!`s on `refused_store` / `degraded_store` / `evicted`. Member 4 has no per-entry cap. Members 2, 3 have no revert-epoch check.

**Latent divergence worth fixing regardless of consolidation.** `ProjectionCache`'s eviction loop (`lib.rs:2860-2863`) protects the just-inserted session from evicting itself:

```rust
if oldest == session_id {
    self.lru.push_back(oldest);
    break;
}
```

`NativeAttachmentCache` (`lib.rs:2690-2702`), `BoundaryTokenCache` (`lib.rs:2283-2290`), `SerializedOutputCache` (`transform.rs:465-472`), `TagBaselineCache` (`transform.rs:7586-7593`), and `TagMintFrontierMemoCache` (`transform.rs:7999-8008`) do **not**. In those five, an insert whose own charge exceeds `max_retained_bytes` can pop and drop the entry it just stored. Members 5 and 6 both guard the entry cap before insert, so the window is narrow; members 2, 3, 4 have no such guard. **This asymmetry should be resolved as a correctness question before any consolidation, and it is the strongest argument for one owner.**

**Impact note (why T2).** These caches back transform output serialization, native-attachment retention, boundary token counts, and projection reuse. Their byte accounting bounds process memory (see the sizing comment at `lib.rs:2294-2296` — "4,600 messages and 15,000 blocks … roughly 49 MiB"). A consolidation that changes when an entry is charged, evicted, or refused changes the retention envelope. Any change needs the existing per-cache retention tests to pass unmodified, plus a new test per member pinning the self-eviction behavior.

- Clone type: structural / parameterized
- Call sites: 6 owners; 5 are `McHandler` fields (`lib.rs:2897-2901`)
- Module spread: 2 files (`lib.rs`, `transform.rs`)
- Priority signals: sensitive (memory-retention bound); an open `TODO(memory-accounting)` at `lib.rs:2816` already flags the family as under-specified
- **Est. net LOC: −120** (one generic `SessionLruCache<E>` with a `retained_bytes` accessor; the stats/logging in member 5 stays at its call site)
- Execution lane: typed-semantic

### T2-2. Two publication fences differing only in a predicate and a string

`WrapupSnapshotPublicationFence` (`lib.rs:3288-3320`) and `ReattachSnapshotPublicationFence` (`lib.rs:3324-3357`).

**Common core:** identical 4 fields (`snapshots: Arc<Mutex<TransformSnapshotCache>>`, `session_id: String`, `generation: u64`, `#[cfg(test)] after_store_publish: ConnectFailureCommitHook`); identical `publish` body — take the snapshots lock, check a generation predicate, `store.publish_historian_chunk(request)`, run the test hook, return.

**Differences — exactly two:**

| | Predicate | Rejection reason |
| --- | --- | --- |
| Wrapup | `snapshots.ready_generation_matches(...)` | "transform snapshot generation changed before publication" |
| Reattach | `snapshots.generation_present_in_flight_or_ready(...)` | "transform snapshot state changed after reattach started" |

Fix: one `SnapshotPublicationFence { snapshots, session_id, generation, mode: FenceMode, .. }` where `FenceMode` selects predicate + reason. −35 LOC.

**Impact note (why T2).** This is a durability fence: the whole point is that validation and the SQLite write share one lock so a concurrent transform cannot retire the cached raw snapshot between check and write (see the comments at `lib.rs:3304-3305` and `:3341-3343`). Collapsing the two into one type must not widen the lock scope, must not reorder the check relative to `publish_historian_chunk`, and must keep the two rejection reasons distinct — operators use them to tell the two races apart. Requires the existing fence-rejection tests to pass byte-identically on the `reason` strings.

- Clone type: parameterized
- Call sites: 2 (both construct into `HistorianFiringTask.publication_fence`, `lib.rs:3375`)
- Module spread: 1 file
- Priority signals: sensitive (snapshot watermark + durability)
- **Est. net LOC: −35**
- Execution lane: typed-semantic

### T2-3. Chunked-staging state machine implemented 3× as a coordinator + a 4th time inline ★ largest single item

Three coordinators implement the same "receive indexed batches with digests, verify replay-idempotence, enforce order, enforce a byte cap, apply on the final batch" protocol:

| Coordinator | Pending struct | Phase enum | `stage` method | Size |
| --- | --- | --- | --- | --- |
| `StateSyncSeedCoordinator` | `PendingStateSyncSeed` `lib.rs:893-903` | `StateSyncSeedPhase` `:905-912` | *(none — inlined, see below)* | impl `:955-1020` |
| `TransformPageCoordinator` | `PendingTransformPage` `lib.rs:1023-1032` | `TransformPagePhase` `:1034-1040` | `:1173-1320` | impl `:1107-1320` = 214 LOC |
| `StateImportCoordinator` | `PendingStateImport` `lib.rs:1323-1331` | `StateImportPhase` `:1333-1338` | `:1430-1590` | impl `:1380-1622` = 243 LOC |

Each independently declares:

- a `Pending*` struct with `{id, total/batch_count, next_index/next_seq, digests: Vec<String>, items: Vec<_>, bytes, last_activity/queued_at_ms}`
- a `*Phase` enum `{ Idle, Collecting(Pending*), Applying { id, bytes } }`
- a `*Session { phase, completed: Option<Completed*> }` + a hand-written `Default` (`lib.rs:928-935` and `:1054-1061` are byte-identical modulo type names)
- a coordinator `{ sessions, total_staged_bytes, pending_*_count, max_staged_bytes }` + `Default`
- `phase_bytes`, `is_pending`, `release_phase`, `discard*`, `evict*_stale*` — `StateSyncSeedCoordinator::release_phase` (`lib.rs:979-987`) and `TransformPageCoordinator::release_phase` (`lib.rs:1119-1127`) are identical modulo the counter field name
- a `*StageError` enum: `TransformPageStageError { AttemptMismatch, DigestMismatch, OrderMismatch, BufferOverflow, InProgress }` (`lib.rs:1099-1105`) vs `StateImportStageError { Protocol { code, message }, Validation(_) }` (`:1372-1378`) vs `StateSyncSeed`'s inline string codes

**The fourth copy is inline.** `McHandler::handle_state_sync_value` (`lib.rs:8642-9125`, 484 LOC) declares a **local** `enum StageAction { Ack(usize), Apply { … } }` at `lib.rs:8845-8855` and then open-codes the entire staging state machine at `lib.rs:8857-9080` — attempt-mismatch check (`:8973-8985`), digest replay check (`:8987-9007`), order check (`:9008-9014`), byte-cap check (`:9015-9030`), complete/incomplete branch (`:9031-9068`). This is the same protocol `TransformPageCoordinator::stage` (`lib.rs:1173-1320`) already implements as a method, with string error codes (`"state_sync_seed_attempt_mismatch"`, `"state_sync_seed_digest_mismatch"`, `"state_sync_seed_order_mismatch"`, `"state_sync_seed_buffer_overflow"`) in place of the typed enum.

**Impact note (why T2, and why to sequence it carefully).** This is the module state-sync ingress path. Consolidating it changes:

- when `total_staged_bytes` is charged and released — the bound on handler-wide staging memory
- the ordering of the durable-metadata generation/seq check (`lib.rs:8817-8843`) relative to process-local state mutation, which is deliberately batch-zero-only ("A stale retry therefore cannot evict or allocate another live attempt", `lib.rs:8816-8817`)
- the stale-collector TTL eviction (`StateSyncSeedCoordinator::evict_stale_collectors`, `lib.rs:1000-1019` vs `StateImportCoordinator::evict_stale`, `:1395-1417`)
- the exact error codes on the wire

Recommended sequencing: **extract only the fourth (inline) copy into `StateSyncSeedCoordinator::stage`** first, mirroring `TransformPageCoordinator::stage`'s shape but keeping the string codes and the existing check order byte-for-byte. That alone shrinks `handle_state_sync_value` from 484 to ~250 LOC and makes the three coordinators comparable. Only then evaluate a generic `ChunkedStagingCoordinator<T, E>`.

See TRACKED-1 — this sits next to open bead `magic-context-q4i`.

- Clone type: structural (3 coordinators) + semantic (inline 4th copy)
- Call sites: `handle_state_sync_value` (`lib.rs:8642`), `handle_transform_page_value` (`:9335`), `handle_state_import_value` (`:5591`)
- Module spread: 1 file, but 3 distinct command handlers
- Priority signals: sensitive (module sync, snapshot watermarks, bounded staging); largest single duplication in the crate by LOC
- **Est. net LOC: −250** (≈ −200 from extracting the inline copy, ≈ −50 from sharing `Session`/`Default`/`release_phase`/`phase_bytes`/`is_pending`)
- Execution lane: typed-semantic

### T2-4. `historian.rs`: producer-failure handling duplicated in the drive loop

`src/historian.rs:1291-1330` (producer **start** failure) and `:1371-1412` (producer **output** failure) share a 19-line identical run followed by a near-identical tail. Verified by normalized diff: lines `1291-1309` are identical to `1371-1389`, then three single-line replacements, then `1319-1326` identical to `1402-1410`.

**Common core:**

```
let completed_at_ms = (request.completion_now_ms)();
let failure_backoff_at_ms = completion_failure_backoff_at_ms(
    request.now_ms, request.failure_backoff_at_ms, completed_at_ms);
let decision = decide_producer_failure(
    &err, model, &request.model_chain[index + 1..],
    &mut auth_blocked_providers, &mut all_failures_permanent,
    completed_at_ms, failure_backoff_at_ms);
persist_historian_state(request.store, request.session_id,
    abandon_with_detail(&<state>, decision.failure_backoff_at_ms,
        Some(prefixed_detail(decision.detail_prefix, format!("producer <phase> ({model}): {err:?}")))))?;
if decision.try_next_model … { producer.close_attempt(); log_cleanup_failure(…); continue; }
let close_result = producer.close().await;
return Err(HistorianDriveError::Producer(attach_cleanup(…)));
```

**Differences:** the abandoned state (`&fired` vs `&awaiting`), the phase word in the detail (`"producer start"` vs `"producer output"`), and the fallback guard — the output path additionally requires `cancellation_confirmed_stopped(&cancel_result)` (`:1401`) and wraps `attach_cleanup(attach_cleanup(err, cancel_result, "cancel"), close_result, "close")`.

`completion_failure_backoff_at_ms` is called from **6** sites (`historian.rs:1292`, `:1350`, `:1372`, `:1518`, `:1554`, `:1683`); `abandon_with_detail` from 7.

**Impact note (why T2).** This is the historian fallback-chain safety logic. The comment at `historian.rs:1398-1400` states the invariant explicitly: "Fallback requires typed proof that the failed attempt is over. Transport failures and uncertain send outcomes cannot prove the cancellation reached and stopped the provider run." A shared helper must **not** flatten the `cancellation_confirmed_stopped` asymmetry — the start path has no in-flight run to cancel, the output path does. Getting this wrong means starting a fallback model while the previous provider run is still billing. Any extraction needs the existing fallback-chain tests plus a new test asserting the start path does not gain, and the output path does not lose, the cancellation proof.

- Clone type: near-miss
- Call sites: 2 within `drive_historian_producer`
- Module spread: 1 file
- Priority signals: sensitive (provider billing, state persistence, backoff); `historian.rs` = 33 commits, high churn
- **Est. net LOC: −30**
- Execution lane: typed-semantic

---

# T3 — Own design pass

### T3-1. `src/lib.rs` — 15,242 production LOC, one 8,520-LOC `impl` block

`impl McHandler` spans `lib.rs:3398-11917` = **8,520 LOC in a single impl block** with 146 methods, 44 of which are `handle_*` command entry points.

**Internal seams (measured by method-name family and total LOC):**

| Family | Methods | LOC | Largest member |
| --- | --- | --- | --- |
| `handle_session_*` | 5 | 990 | `handle_session_wrapup_value` `:6594-7132` (539) |
| `handle_transform_*` | 5 | 891 | `handle_transform_unpaged_value` `:8007-8615` (609) |
| `handle_ctx_*` | 5 | 764 | `handle_ctx_note_facade` `:11547-11916` (370) |
| `handle_state_*` | 2 | 668 | `handle_state_sync_value` `:8642-9125` (484) |
| `handle_note_*` | 8 | 633 | `handle_note_evaluation_next` `:11097-11276` (180) |
| `prepare_*` | 2 | 495 | `prepare_historian_fire` `:4808-5184` (377) |
| `handle_dreamer_*` | 1 | 436 | `handle_dreamer_run_task` `:9605-10040` (436) |
| `handle_authority_*` | 4 | 291 | |
| `handle_claim_*` | 6 | 251 | |
| `handle_guidance_*` | 1 | 117 | |
| `handle_agent_*` | 1 | 115 | |
| `handle_status_*` | 1 | 89 | |

The axis of variation is **command family**, and it is already encoded in the method names. Nine of these families are independently coherent: they take a route binding, read/write the store, and return a `PreparedOutcome`. A split along `handle_<family>_*` → `src/handlers/<family>.rs` (each an `impl McHandler` block) is mechanical in Rust — inherent impls may be split across modules within a crate — and needs no visibility change because every one of these methods is private.

**Separately: the god-struct.** `pub struct McHandler` (`lib.rs:2873-2960`) has 47 fields, **11 of them `#[cfg(test)]`-only** (`fixed_config`, `guidance_now_ms`, `reduction_injection`, `between_transform_and_prepare`, `wrapup_operation_budget`, `unknown_module_retry_delay`, `status_snapshot_hook`, `state_sync_seed_now`, `state_sync_before_apply_hook`, `publication_fence_write_hook`, `transform_page_discard_logs`) plus 34 `_for_test` methods in the file. There are **309 `.lock()` calls in `lib.rs`** across ~40 distinct mutex-message strings (top: 30× `"transform snapshots mutex"`, 11× `"transform page mutex"`, 11× `"native attachment cache mutex"`). Each command handler locks 3-8 of these independently; nothing in the type system records a lock order.

The design question this raises — one that a DRY pass cannot answer — is whether the 11 test-only fields and 3 test-only interleave hooks (`between_transform_and_prepare`, `status_snapshot_hook`, `state_sync_before_apply_hook`) indicate that the concurrency interleavings under test are not otherwise reachable, i.e. whether the handler needs an explicit sequencing seam rather than three `Mutex<Option<Box<dyn FnOnce()>>>` slots.

Recommended first step, and only this step: split the 44 `handle_*` methods into `src/handlers/{session,transform,ctx,state,note,dreamer,authority,claim,misc}.rs` with no body changes. This is verifiable by `git diff --stat` showing pure moves, and it makes every subsequent finding in this report locally reviewable.

### T3-2. `src/transform.rs` — 11,947 production LOC, one 2,476-LOC function

`fn apply_once` (`transform.rs:3222-5697`) is **2,476 LOC in one function** with 8 parameters (2 of them `Option<>` mode flags, 1 an out-param `&mut bool`). It is the whole transform pass.

287 top-level production functions totalling 9,587 LOC. The largest:

| Function | Location | LOC |
| --- | --- | --- |
| `apply_once` | `:3222-5697` | 2,476 |
| `apply_additive_only` | `:2711-3219` | 509 |
| `build_output_with_tags_inner` | `:11678-12156` | 479 |
| `compute_active_overlay_decisions` | `:8574-8761` | 188 |
| `new_frozen_strip_units` | `:10181-10339` | 159 |
| `format_pass_timing_line` | `:1317-1443` | 127 |
| `run_user_hint_lexical_search` | `:8843-8964` | 122 |
| `resolve_boundary_state` | `:7167-7269` | 103 |

**Internal seams by prefix:** `apply_*` 11 fns / 3,382 LOC · `build_*` 5 / 540 · `tag_*` 19 / 354 · `new_*` 4 / 319 · `is_*` 21 / 198 · `strip_*` 6 / 135 · `render_*` 8 / 114 · `channel2_*` 4 / 85 · `frozen_*` 7 / 88.

The natural split is by pass stage: `transform/project.rs` (ingress normalization, projection, lineage anchors — `:2405-2630`), `transform/select.rs` (overlay/tag decisions — `:8574-9250`), `transform/output.rs` (`build_output_*`, strip units, block identity — `:10181-12462`), `transform/wire.rs` (`TransformRequest`/`TransformResponse`/`ServedMessage` and their serde — `:156-1620`), leaving `apply_once` as the coordinator in `transform/mod.rs`. `apply_once` itself needs decomposition along the same stages, which is a separate and larger job.

Note the test ratio here: 17,493 test LOC to 11,947 production LOC, 285 `#[test]` functions, 1,229 `.unwrap()` calls. Splitting the file forces splitting the 19 `#[cfg(test)]` blocks, which is the bulk of the mechanical work.

### T3-3. `pub` surface of a leaf crate: 505 items, 0 external consumers

`mc-module` declares 25 `pub mod`s (`lib.rs:8-37`) and 505 `pub` items in `src/`. No crate in the workspace depends on it (verified against every `Cargo.toml` and by repo-wide `mc_module::` search — 1 hit, a doc comment). The napi surface (`packages/mc-shm-native/src/{lib,napi_buffers,lifecycle}.rs`) does not reference it.

Consequence: `rustc`'s `dead_code` lint is almost entirely suppressed across this crate, because every unused item is `pub` and therefore "reachable". The 6 dead items in T0-1 were found by manual repo-wide token counting, not by the compiler. There are likely more: 29 further `pub` items have exactly one reference repo-wide (declaration + 1 use), including `historian_prompt.rs:114 fnv1a`, `:128 seed_band_index`, `:198 select_seeds`, `:218 render_session_ref_compartment`, `:267 render_session_references_block`, `memory_tool.rs:136 inspect_claim_intents`, `:211 search_compartments_and_notes_for_session`, `codec/sidecar.rs:68 message_for_index`, `:292 stable_hash`, `scheduler.rs:567 emergency_drain_exit_threshold`, `:677 detect_overflow_value`. Each of those single uses needs checking for whether it is a test-only use.

Recommended design pass: demote `pub mod` → `pub(crate) mod` for every module not reached from `src/bin/ck-mc-host.rs`, `examples/direct_host_fixture.rs`, or `tests/*.rs`; demote `pub fn`/`pub struct` → `pub(crate)` throughout; then let `cargo check` report the dead code. This is a one-time cost that converts an entire finding category from manual audit into a compiler gate. Do this **before** the T0/T1 deletions, so the compiler confirms them.

---

# TRACKED — do not remove

### TRACKED-1 — `magic-context-q4i`, `magic-context-a7v`, `magic-context-6bd` (module sync)

- **`acked_watermarks` on the state-sync wire** — `lib.rs:712` (`ModuleStateSyncWire.acked_watermarks: Option<Value>`), read at `:8778`, `:9226`, `:9285`. Do not remove or simplify the `Option` — precursor to `magic-context-q4i` ("mid-session compatibility events from held-open v85 writers bypass snapshot watermarks").
- **`ModuleWorkspaceWire` / `ModuleWorkspaceMemberWire`** — `lib.rs:1659-1668`. `ModuleWorkspaceMemberWire` is a one-field struct (`project_path: String`) and would otherwise read as over-abstraction. Do not collapse — precursor to `magic-context-a7v` ("prune policy-hidden foreign workspace rows from the native mirror") and `magic-context-6bd` ("workspace member prune protocol for the native memory mirror"), both of which will add fields here.
- **T2-3 (the chunked-staging clone class)** touches `StateSyncSeedCoordinator` and `handle_state_sync_value` directly. Sequence the extraction *after* q4i lands, or coordinate with it — do not refactor the state-sync staging path and change watermark handling in the same change.

### TRACKED-2 — `magic-context-x84`, `magic-context-658` (MODULE authority + claim policy)

`src/memory_render.rs:60-85` — `MirroredClaimMemory` and `MirroredClaimMemoryError` (`Inactive` / `MissingCategory` / `NonPositiveCategory` / `MissingImportance`). The four-variant error enum with a repeated `public_claim_id` field in every variant looks like a consolidation target (a single struct with a `kind` would be ~20 LOC shorter). **Do not remove or flatten** — precursor to `magic-context-x84` ("MODULE-authority native rendering needs a claim-policy decision channel") and `magic-context-658` ("Rust MODULE memory authority bypasses claim-policy visibility gates"). Both will extend this decision surface; x84 explicitly needs a *decision channel*, which is what these typed variants become.

### TRACKED-3 — `magic-context-c50` (hand-rolled Rust module host)

`src/bin/ck-mc-host.rs` and `src/bin/ck_mc_host/{serve,spawn}.rs`. The `instance_failure` → `DaemonResult` error block is repeated **9 times** (`:592-595`, `:1271-1274`, `:1278-1281`, `:1285-1288`, `:1453-1456`, `:1460-1463`, and `:1514-1517`/`:1522-1525` with `.with_effects(...)`), and `cmd_start` (`:1265-1300`) / `cmd_stop` (`:1444-1478`) share a ~25-line prologue (`Runtime::new` → `LifecycleTransactionLock::acquire_exclusive` → `settle_probe` → `quarantined_observation` → `match observed.state`). A `?`-style helper returning `Result<T, DaemonResult>` would remove ~35 LOC.

**Do not remove — precursor to `magic-context-c50`** ("Hand-rolled Rust module host: replace private subc daemon") and its children `c50.9` (E2E rust-mode suite against the hand-rolled host) and `c50.11` (LLM-runner route in `mc-host`). This lifecycle surface is being rewritten; consolidating it now creates a merge conflict against that epic for a ~35-LOC win. Also note `magic-context-1l7` ("derive the resident-byte ceiling from declarations instead of a Broca-shaped default") and `magic-context-89q` ("anchor lifecycle transaction lock to the evidence namespace") both touch this exact `LifecycleTransactionLock` path.

### TRACKED-4 — `magic-context-pml` epic (Rust feature parity) + the memory-accounting TODO

- `lib.rs:2816` `TODO(memory-accounting)` on `ProjectionCache::snapshot` — "add an active-clone budget for this `Arc` … A running transform can retain it after LRU eviction, so the cache-only charge cannot bound that in-flight allocation." Keep this comment. It documents a known unbounded-retention gap that T2-1's consolidation must preserve or fix, not silently drop.
- The `transform.rs` / `scheduler.rs` / dreamer surfaces are the target of `magic-context-pml.1`-`pml.7` (port dreamer scheduler, task bodies, TS-only dreamer tasks, embedding pipeline, tagger, git-commits ingestion, message index to Rust). `handle_dreamer_run_task` (`lib.rs:9605-10040`, 436 LOC) and the `tag_*` family in `transform.rs` (19 fns / 354 LOC) will both grow substantially. Do not restructure them for DRY ahead of that port.

### Already tracked elsewhere — not re-proposed

Per the audit brief, these were checked and are **outside this crate**, so no finding is raised:

- `magic-context-kp5` (outgoing-frame byte accounting ownership in `wire.rs`) — this crate has `src/ck_wire.rs`, not `wire.rs`; the byte-accounting owner lives in another crate. No `ck_wire.rs` finding raised.
- `magic-context-1or` (`RawClient::frames_until_corr` skipped frames) — `rg frames_until_corr crates/mc-module` returns nothing.
- `magic-context-18r` / `magic-context-chj` (duplicate Synapse hashing + scalar depth scan / duplicate Synapse tokenization) — `Synapse` appears in this crate only as CLI/serve wiring (`src/bin/ck-mc-host.rs`, `src/bin/ck_mc_host/serve.rs`, `examples/direct_host_fixture.rs`); the hashing and tokenization code is elsewhere.

---

# Do not unify yet

### DNU-1. `.lock().expect("<name> mutex")` — 309 occurrences in `lib.rs`

309 `.lock()` calls in `lib.rs`, 29 in `historian_producer.rs`, 13 in `transform.rs`. About 40 distinct panic messages, top: `"transform snapshots mutex"` (30), `"transform page mutex"` (11), `"native attachment cache mutex"` (11), `"note evaluator registrations mutex"` (10), `"state sync seed mutex"` (9), `"state import mutex"` (9).

**Why not now:** each message is a distinct, useful panic identifier, and the idiom is 1 line. Wrapping each field in a typed accessor (`fn snapshots(&self) -> MutexGuard<'_, TransformSnapshotCache>`) would add ~40 methods to remove ~0 net lines. The genuine problem here is not duplication — it is that 47 mutex fields with no encoded lock order sit behind 146 methods. That is T3-1's design question, not a DRY fix. **Weakly-coupled + sensitive (concurrency).**

### DNU-2. `ParsedCompartment` / `ValidatedCompartment` field overlap

See T1-7. 16 identical field lines including `#[serde(default)]` attributes, but extracting them changes two serde wire shapes on a validated-publish path for −16 LOC. **Sensitive + payoff too small.**

### DNU-3. Single-production-implementor traits

| Trait | Production impls | Test impls |
| --- | --- | --- |
| `SessionResolver` (`session_resolver.rs:33`) | 1 — `MissingSessionResolver` (`:45`, returns `Ok(None)`) | 1 — `FakeSessionResolver` (`lib.rs:17370`) |
| `ProducerConnection` (`historian_producer.rs:589`) | 1 — `ManagedConnection` (`:615`) | 1 — `FakeConnection` (`:1514`) |
| `ProducerConnector` (`historian_producer.rs:672`) | 1 — `ManagedConnector` (`:688`) | 1 — `FakeConnector` (`:1622`) |

Each is a one-production-implementor trait, which the rubric flags. But each is a genuine test-double seam over an out-of-process dependency (session resolution over transport; producer connection to the llm-runner). `MissingSessionResolver` is a deliberate null object for "this harness has no session mapping" — its one test (`session_resolver.rs:58-67`) asserts exactly that. `magic-context-c50.11` will add a second production `ProducerConnector` (the LLM-runner route replacing broca). **Do not collapse: earning their keep as effect boundaries, and one is about to gain a second implementor.**

(`HistorianPublicationFence` has 2 production impls — see T2-2. `HistorianProducerDriver` and `HistorianProducerFactory` have 4 impls each. Those are fine.)

---

# Dead code

| Item | Location | Evidence | Action |
| --- | --- | --- | --- |
| `pub const CLASSIFY_CLEANUP_RESERVE` | `classify.rs:41` | 1 repo-wide token occurrence | Delete (+8-line doc) |
| `pub const MAX_NONEMERGENCY_REQUEST_BUDGET` | `historian.rs:998` | 1 occurrence | Delete (+8-line doc) |
| `pub fn is_retryable_model_failure` | `historian_producer.rs:392` | 1 occurrence | Delete |
| `pub fn is_abort_or_overflow` | `historian_producer.rs:402` | 1 occurrence | Delete |
| `pub fn is_deterministic_reject` | `transform.rs:1887` | 1 occurrence | Delete |
| `pub struct M1Content` | `transform.rs:515` | 1 occurrence | Delete; relocate the revision-digest doc comment to `m1_compose.rs` if still accurate |
| `SerializedOutputSession.stats` | `transform.rs:348` | `#[cfg_attr(not(test), allow(dead_code))]`; only reader is `#[cfg(test)] fn stats` `:476` | Delete field + write at `:447`; point the test at `BuiltOutput.cache_stats` |
| `NativeAttachmentCacheSession.stats` | `lib.rs:2551` | Same pattern; only reader is `:2709` | Delete field + write at `:2705-2707`; point the test at `TransformTimings.native_cache_*` |

**Explicit `#[allow(dead_code)]` inventory** (all legitimate, no action):

| Location | Assessment |
| --- | --- |
| `tests/support/mod.rs:1` `#![allow(dead_code)]` | Shared test-support module; crate-level allow is correct here |
| `bin/ck_mc_host/spawn.rs:22` `SpawnError(#[allow(dead_code)] pub &'static str)` | Diagnostic payload carried for `Debug`; keep |
| `lib.rs:3675` `#[allow(dead_code)]` | On a `#[cfg(test)]` item |
| `lib.rs:4529`, `:4535` `#[cfg(test)] #[allow(dead_code)]` | `set_guidance_now_ms_for_test`, `inject_reductions_for_test` — test seams currently unused by any test. Candidates for deletion, but they belong to the `_for_test` family that T3-1 should decide about as a whole; not worth a separate 12-LOC finding |
| `transform.rs:348`, `lib.rs:2551` | Covered above |

**No stale `cfg` branches found.** The `drive-fault` feature (`Cargo.toml:47-60`) is intentionally default-off with a documented absence proof; `direct-host-fixture` gates a test fixture. Both are live and correctly gated.

**29 further single-reference `pub` items** exist (declaration + exactly one use repo-wide) and are likely partly dead-via-test-only-use. Full list is reproducible; resolving them properly requires T3-3's visibility tightening so the compiler can adjudicate. Notable: `historian_prompt.rs` has 5 of them (`fnv1a:114`, `seed_band_index:128`, `select_seeds:198`, `render_session_ref_compartment:218`, `render_session_references_block:267`) — that whole module's `pub` surface is worth one focused check.

---

# Test findings

775 tests. Overall quality is high — assertions are behavioral, oracles are mostly independent, and several suites are already correctly parameterized (`lib.rs:29793 assert_seeded_phase_recovers_then_refires_after_backoff` driving three phase tests at `:29822`/`:29827`/`:29832`; `transform.rs:27076 assert_fresh_reasoning_adjacency_is_skeletonized` driving `:27104`/`:27109`). **No sentinel-stub closures** (`|_, _| {}`, `|_| {}`) anywhere in the crate — a real positive signal.

### TEST-1 (T0). `historian.rs` — 40-line prologue copy-pasted across 5 tests

See T0-1/T0-3 above. `historian.rs:2882`, `:2943`, `:3139`, `:3781`, `:4534`. **−140 LOC.**

### TEST-2 (T0). Tautological assertion lines

| Location | Assertion | Verdict |
| --- | --- | --- |
| `config.rs:844` | `assert_eq!(DEFAULT_MEMORY_BUDGET_TOKENS, 4_000.0);` | **Tautological** — asserts a const equals its own literal. Line 845 (`assert_eq!(merge_tiers(None, None).memory_budget_tokens, 4_000.0)`) is the real test: it proves `merge_tiers` reaches the const. Delete line 844. |
| `lib.rs:17059-17063` | `assert_eq!(StoreOpenPolicy::default().wait_window, Duration::from_secs(60));` | **Borderline construct-then-read-back.** `StoreOpenPolicy::default()` (`lib.rs:267-275`) just copies `STORE_LEASE_WAIT_WINDOW`, so this asserts a const equals a literal one indirection away. It is defensible as a pin on an operational default that an operator would notice changing — but it proves nothing about behavior. Either delete, or strengthen it to assert the *observable* consequence (a store-open wait actually gives up at 60s), which the surrounding tests may already cover. |

### TEST-3 (note). Legitimate cross-boundary contract pins — keep

- `lib.rs:30432` `the_default_daemon_ver_matches_the_frozen_contract` — `mc_host::HostConfig::default().daemon_ver == release_contract::DAEMON_VERSION`. Reads like a tautology but pins a cross-crate contract. Keep.
- `config.rs:838-841` `default_threshold_matches_typescript_schema`, `config.rs:1088` `guidance_marker_validation_matches_the_typescript_line_rule`, `memory_render.rs:528` `render_order_is_a_prefix_of_the_positive_vocabulary` — all pin real invariants against an out-of-band schema. Keep.

### TEST-4 (note). No subsumed-test pairs found worth deleting

I looked specifically for weaker tests already covered by a stronger sibling (e.g. `scheduler.rs:1206 band_boundaries_are_non_vacuous` vs `:1251 pre_raise_thresholds_keep_the_exact_85_percent_force_band`; `divergence.rs:161/:168/:174`). In each case the pair tests distinct boundary conditions and neither strictly subsumes the other. **No deletions proposed.** The small tests in `compartment_coverage.rs:235-275`, `divergence.rs:161-176`, and `scheduler.rs:1206-1252` are all genuine boundary tests, not construct-then-read-back.

### TEST-5 (note). Test/production ratio in the two giant files

`transform.rs` is 17,493 test LOC to 11,947 production LOC (1.46:1) across 285 tests and 19 separate `#[cfg(test)]` blocks; `lib.rs` is 15,276 to 15,242 (1.00:1) across 97 tests. This is not a finding — the ratio is defensible for a wire-format-and-state-machine module. It is a **cost note for T3-1 and T3-2**: any file split must carve up 19 and 12 test blocks respectively, and that is the majority of the mechanical work in both.

---

# Comment violations

| Location | Text | Violation | Fix |
| --- | --- | --- | --- |
| `healing.rs:127` | "The peer retired that byte-splice at U0: full-array apply is now the only…" | Roadmap unit reference + "is now" — tracks project timeline in source | State the mechanism in present tense: "Full-array apply is the only supported path; the peer does not send byte-splices." |
| `transform.rs:25243` | "byte-splice at U0: every pass rebuilds the provider request from the transformed…" | Same | Same treatment |
| `historian_validate.rs:1484` | "Exact observed shape from issue #246: deepseek-v4-flash-free closes…" | Issue reference in source | Keep the observed shape, drop the issue number: "Observed shape: deepseek-v4-flash-free closes…" |
| `transform.rs:3505` | "Previously stored overlay rows may still replay when boundary-lineage validation…" | "Previously" — temporal framing of a durable fact | "Stored overlay rows can replay when boundary-lineage validation…" |

**Keep as-is:**

- `lib.rs:2816` `TODO(memory-accounting)` — scoped engineering note naming a real unbounded-retention gap in `ProjectionCache::snapshot`. Not a timeline reference. See TRACKED-4.
- `lib.rs:2294-2296` — the cache-budget sizing rationale ("4,600 messages and 15,000 blocks … roughly 49 MiB"). Explains a non-obvious constant. Exactly the kind of comment that should exist.
- `Cargo.toml:19`, `:41`, `:47-60` — the `commentlint: allow(JUDGE)` markers and the `drive-fault` absence proof. Load-bearing.
- `lib.rs:2879-2886` (`spawn_gate` — "Holds no state… A second boolean here would be state that must be flipped in lockstep with the token, and nothing would enforce that.") — documents a rejected alternative and why. Model comment.

The crate is in good shape here: zero `for now` / `FIXME` / `HACK` / `XXX`, one `commentlint: allow` in `src/`, and the `magic-context-*` strings that turned up are test module IDs and a hash-domain-separator literal, not bead references.

---

# Suggested execution order

1. **T3-3 visibility tightening first** (`pub` → `pub(crate)`). Converts dead-code detection from manual audit to a compiler gate and validates T0-1 mechanically.
2. **T0-1, T0-2, T0-4** — deletions and comment fixes, now compiler-confirmed. −79 LOC.
3. **T1-1** (`chunk_text.rs`) — biggest certain win, pure move of module-private items. −157 LOC.
4. **T1-4** (`codec/json.rs`), **T1-5** (caveman predicate), **T1-3** (`build_output_with_tags`), **T1-2** (`TransformResponse::base`), **T1-6** (transform entry visibility). −190 LOC.
5. **T0-3** (historian test fixture) — do after T1-1..T1-6 so the test churn lands once. −140 LOC.
6. **T3-1 handler split** (pure moves, `git diff --stat` verifiable). Makes everything below reviewable.
7. **T2-1** (cache class) — resolve the self-eviction asymmetry as a correctness question first, then consolidate.
8. **T2-2** (fences), **T2-4** (producer failure) — each with the impact-note test obligations.
9. **T2-3** (staging coordinators) — only the inline-copy extraction, and only after `magic-context-q4i` lands or in explicit coordination with it.
10. **T3-2** (`transform.rs` split, `apply_once` decomposition) — its own project, sequenced against the `magic-context-pml` epic.
