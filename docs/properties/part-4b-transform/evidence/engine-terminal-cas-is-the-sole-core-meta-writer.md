# engine-terminal-cas-is-the-sole-core-meta-writer

## Discovery trigger

The task asked for the commit point "precisely". Locating it meant enumerating
every `store.` call inside `apply_once` (`crates/mc-module/src/transform.rs:3222-5697`)
rather than trusting the module header. The enumeration turned up one terminal
commit, three early-return commits, and two durable writes that are neither.

## Evidence trail

Every reference read back at `HEAD` `76cd6f41`.

The mutation region opens with two clones:

- `transform.rs:4369` — `let mut core = loaded.core.clone();`
- `transform.rs:4371` — `let mut meta = loaded.meta.clone();`

`loaded` comes from the declared read linearization point,
`store.load_transform_snapshot(&req.session_id)?` at `transform.rs:3387`. That
call is one read transaction taken under the store connection mutex
(`mc-store/src/lib.rs:5531-5546`).

The code states the intended contract itself at `transform.rs:3505-3507`:
"Decisions from this request stay in memory until the final cache-state
compare-and-swap accepts the pass."

The terminal commit:

- `transform.rs:5555` — `let state_changed = core != loaded.core || meta != loaded.meta;`
- `transform.rs:5559-5561` — `commit_required = state_changed ||
  !consumed_drop_ids.is_empty() || !pending_overlays.is_empty()`
- `transform.rs:5562` — `let row_version = if commit_required {`
- `transform.rs:5565` — `store.commit_transform(`
- `transform.rs:5569` — `expected: commit_expected`
- `transform.rs:5601-5602` — the `else` arm returns
  `loaded.row_version.unwrap_or(0)` without touching the store.

`commit_transform` (`mc-store/src/lib.rs:7260`) runs the whole write set in one
fenced transaction: the CAS read and check at `:7352-7367`, the claim-vector
predicate at `:7368-7377`, the compartment predicate at `:7378-7387`, then
`mc_cache_state` at `:7390-7399`, `mc_pass_trace` at `:7402-7468`,
`mc_transform_session_roots` at `:7470-7481`, new `mc_tags` at `:7483-7515`,
overlay tables at `:7527-7580`, the reduce ledger at `:7582-7591`, and pending
drop deletions at `:7592-7597`. On CAS failure it returns
`CommitOutcome::CasConflict` from an empty transaction (`:7366`, comment at
`:7365`: "Empty txn (commits nothing); the caller re-loads and re-steps").

Complete list of `store.` calls in `:3222-5697` that write:

| Line | Call | Kind |
| --- | --- | --- |
| `3312` | `descend_lineage` | durable, pre-CAS, own transaction |
| `3609` | `commit_transform` | early return, `pending_rewrite` pass-through |
| `3720` | `commit_transform` | early return, `pending_rewrite` arm |
| `4646` | `truncate_compartments_for_revert` | durable, pre-CAS, own transaction |
| `5565` | `commit_transform` | the terminal commit |

Everything else is a read: `load` (`:3301`), `load_transform_snapshot`
(`:3387`), `max_compartment_end_ordinal` (`:3429`), `has_compartments`
(`:3553`, `:4054`), `load_compartments` (`:3558`, `:4072`, `:4564`, `:4643`,
`:4666`, `:4900`, `:5060`), `load_pending_agent_drops` (`:3834`).

The two pre-CAS writes are the exceptions and have their own records:
[lineage-descent-write-precedes-the-array-validity-guards](lineage-descent-write-precedes-the-array-validity-guards.md)
and
[revert-truncate-commits-outside-the-terminal-cas](revert-truncate-commits-outside-the-terminal-cas.md).
`:3609` and `:3720` are early `return`s, so at most one of them plus the
terminal commit can be reached, and never both.

## Failure scenario

A pass renders successfully, mutates `core` and `meta` in memory, and then hits
`enforce_unique_tool_use_ids` or `assert_no_orphaned_tool_arcs` or a
`CoverageGap` during the output build. If any of that had written durable state
first, the next pass would load a `core`/`meta` pair no pass ever accepted:
`frozen_units` describing bytes never served, or a `coverage_ordinal` past the
last real fold. Both are the wedged-cache failure the module header's
poison-resistance invariants exist to prevent, and both are unobservable from
the response.

## Timing windows and dependencies

Window: `transform.rs:4369` to `:5565`, about 1,200 lines. Inside it live the
m0/m1 composition, the cache-core step, the tag overlay application, the output
build, and both output integrity guards. Nothing in that window is supposed to
be durable.

Dependencies: the store connection mutex
(`../commons/crates/cortexkit-store/src/lib.rs:189`) makes each transaction
atomic in-process; the `row_version` CAS makes the commit conditional on the
row not having moved.

## What a test must construct

1. Open a store, seed a session so `meta.initialized` is true and compartments
   exist.
2. Capture `(row_version, core_state, meta)` by reading the row directly.
3. Drive `transform` with an array crafted to raise each error variant in turn.
   `ReservedId` needs a live block whose flat id starts with `mc_`
   (`transform.rs:3363-3365`, `RESERVED_ID_PREFIX` at `:91`).
   `DuplicateBlockId` needs two identical flat ids (`:3355`).
   `OrdinalViolation` needs non-increasing non-synthetic ordinals (`:3371`).
   `ReductionConflict` needs a re-decided reduction whose payload differs from
   the frozen one (`:4283`, guard body `:6813-6825`).
   `FrozenRedTargetVanish` needs a frozen `red:` target whose mid is live but
   whose exact block id is not (`:5813-5815`).
4. After each `Err`, re-read the row and assert the triple is unchanged.
5. The two exception paths must be excluded from this assertion or the test
   fails for the reason the sibling records document, which is the point.

## Investigation log

### Q: Should `apply_additive_only` be held to the same obligation as a separate record?

- Sources examined: `transform.rs:2711-3219`, `:3234`, `:3108-3141`,
  `config.rs:88`, `:123`, `:913-925`,
  `packages/plugin/src/config/agent-disable.ts:31-35`,
  `packages/cli/src/commands/setup-opencode.ts:45-57`.
- Findings: `apply_additive_only` has exactly one commit (`:3113`) with
  `expected: loaded.row_version` and no mid-pass durable write, so it satisfies
  the obligation trivially. It is selected only when `compaction_enabled` is
  false. The Rust default is `true` (`config.rs:123`) and the config test
  `compaction_enabled_defaults_true_and_is_user_tier_only` (`:913`) pins it. The
  shipped setup path agrees: `isCompactionEnabled` returns
  `config.compaction?.enabled !== false`
  (`packages/plugin/src/config/agent-disable.ts:34`), so an absent value means
  enabled, and `resolveCompactionEnabledForWriter`
  (`packages/cli/src/commands/setup-opencode.ts:45-57`) uses that. Both the
  config default and the shipped setup path therefore make `apply_once` the
  default-production engine.
- Missing evidence: none for the reachability question.
- Conclusion: resolved with answer — `apply_once` is `default-production`,
  `apply_additive_only` is `explicit-config-only`. Whether the additive engine
  deserves its own record is a scoping preference, not a fact; left as a lens
  open question.
