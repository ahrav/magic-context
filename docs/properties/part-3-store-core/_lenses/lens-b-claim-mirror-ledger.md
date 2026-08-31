# Lens B: the claim mirror and the claim intent ledger

Working material, not a deliverable. Attention focus: the committed-claim mirror
and the staged claim-intent ledger, specifically their state, idempotency,
replay, and reconciliation semantics. Other failure families appear only where
they intersect this focus.

System `/local/home/ahrav/scratch/magic-context` at `ed487e11`. Every line
reference below was read at that commit. The working tree carries modifications
only under `.beads/` and untracked `docs/properties/` and `docs/research/`, so no
cited source file is dirty.

Primary sources:

- `crates/mc-store/src/claim_mirror.rs` (1,152 lines), the whole mirror.
- `crates/mc-store/src/lib.rs`, the intent ledger: schema at `1215-1249`, helpers
  at `3783-3960` and `4047-4145`, public surface at `11023-11348`.
- `crates/mc-core/src/claim_operation.rs:350-402`, the identity and lifecycle
  vocabulary.
- `crates/mc-store/tests/claim_mirror.rs` (625 lines) and
  `crates/mc-store/tests/claim_intent_ledger.rs` (401 lines), read as a map.

## Observations

### O1. The mirror is a projection, and the code says so in three places

The mirror is a **projection** of an authority that lives outside this store. It
is not a cache and not a second source of truth. Three independent pieces of code
decide this:

1. The module doc states it directly (`claim_mirror.rs:1-6`): "Rebuildable
   committed-claim mirror. This projection is deliberately separate from the
   staged claim-intent ledger."
2. Every mutation is **push-only from the source**. There is no read-through, no
   fill, no miss path, and no method that derives a mirror row from anything in
   `mc_cache`. The only two writers are
   `replace_claim_mirror_snapshot` (`claim_mirror.rs:756-860`) and
   `apply_claim_mirror_receipt` (`claim_mirror.rs:863-1124`), and both take a
   fully hydrated payload minted elsewhere. A cache would have a fill path; a
   second authority would have an originating write. Neither exists.
3. Mutations are described in **source** terms, not local terms:
   `ClaimMirrorChangeKind` is "Source outbox change that caused a committed
   mirror refresh" (`claim_mirror.rs:58-68`), `ClaimMirrorEffect` carries
   `previous_project_effect_id`, "the source outbox predecessor for this project"
   (`claim_mirror.rs:100-107`), and `ClaimMirrorProjectState.acked_effect_id`
   records how far the projection has consumed that outbox
   (`claim_mirror.rs:130-136`).

The authoritative copy is the host's claim store, reached over the
`claim.mirror.replace` and `claim.mirror.apply` facade calls dispatched at
`crates/mc-module/src/lib.rs:10052-10053` and invoked at `:10288` and `:10326`.
Neither line sits under a `#[cfg(test)]` module, so the projection is fed in
default production. The mirror's own transport version is deliberately
independent of its payload version (`claim_mirror.rs:24-28`).

The word "rebuildable" in the module title is the operative property: the mirror
holds no fact that cannot be reconstructed from the source, which is why
`clear_claim_mirror` (`claim_mirror.rs:702-708`) can drop all four tables
outright while the intent ledger is explicitly left alone
(`claim_mirror.rs:1126-1127`).

### O2. What can diverge, and the three mechanisms that constrain it

The mirror's per-project position is `acked_effect_id`
(`claim_mirror.rs:130-136`, column at `lib.rs:1267`). Divergence from the source
is constrained inside `apply_claim_mirror_receipt` by three independent checks,
in this order:

| Check | Lines | What it catches |
| --- | --- | --- |
| Project-set equality | `claim_mirror.rs:942-957` | A receipt vector naming a project the mirror does not track, or omitting one it does. |
| Generation advance | `claim_mirror.rs:963-990` | A skipped or duplicated receipt: each project's incoming generation must be `stored + 1` when the receipt touches it and `stored + 0` when it does not. Policy generation is checked with the same rule. |
| Per-project effect chain | `claim_mirror.rs:992-1006` | A dropped effect *inside* an accepted receipt. `previous_project_effect_id` must equal the running checkpoint for that project, so a gap is refused even when unrelated projects occupy the intervening global effect IDs. |

Two more constraints run per effect at `claim_mirror.rs:1008-1050`: a public
claim may not change projects (`:1018-1024`), its revision may not regress
(`:1028-1033`), and an equal revision arriving under a different locator is
refused because the locator embeds the content digest (`:1038-1043`, with the
reasoning in the comment at `:1034-1037`). Revocation must name the current
revision (`:1044-1049`).

Ordering between mirror and authority is therefore **defined but one-directional**:
the mirror accepts only the immediate successor of its own committed position,
and it never queries the authority. There is no reconciliation pass, no digest
comparison against the source, and no repair path. Divergence is *prevented at
admission*, never *detected after the fact*. The only recovery is a full reseed,
which O5 shows is unreachable in production.

### O3. Receipt replay is deduplicated by digest, and the dedup table never prunes

`apply_claim_mirror_receipt` looks up `(incarnation, receipt_id)` in
`mc_claim_mirror_receipts` before doing any work (`claim_mirror.rs:921-940`). On
a hit it compares the stored `group_digest` against a freshly computed one:

- Equal bytes return `ClaimMirrorApplyResult { replayed: true,
  applied_effect_count: 0 }` (`:930-934`), a no-op success.
- Different bytes return `ReceiptConflict` (`:935-939`).

The digest is computed over the canonical JSON of the entire group, including its
vector and every effect (`claim_mirror.rs:501-505`), so the conflict check covers
the whole payload rather than a header. The whole apply runs inside one
`with_conn_fenced` IMMEDIATE transaction (`claim_mirror.rs:885`, implementation at
`../commons/crates/cortexkit-store/src/lib.rs:185-192`), so the effects, the
project-state updates, and the dedup row commit atomically. A crash mid-apply
leaves no partial receipt.

`mc_claim_mirror_receipts` (`lib.rs:1299-1310`) has no retention column and no
pruning statement anywhere; the only deletion is the wholesale
`clear_claim_mirror` (`claim_mirror.rs:703`). The dedup ledger therefore grows
without bound for the life of an incarnation. That is sound for correctness and
open as an operational question (Q4).

### O4. The intent ledger: identity, lifecycle, and who writes each transition

An intent is one durable row in `mc_claim_intents` (`lib.rs:1215-1235`) recording
a claim command that was staged *before* the host mutated `context.db`.

**Identity.** The primary key is `(producer, operation_key)` (`lib.rs:1230`),
exactly the two fields of `ClaimCommandIdentity`
(`mc-core/src/claim_operation.rs:350-356`). Nothing else participates in the key.
Two other identities are carried and *verified* but not keyed:

- `request_digest`, 64 hex (`lib.rs:1223`). A mismatch on the same key is
  `IdentityConflict` at stage (`lib.rs:11049-11051`) and at acknowledge
  (`:11209-11211`). This is what stops one operation key being reused for a
  different request.
- `ClaimIntentBinding` — `database_incarnation_id`, `format_epoch`,
  `authority_project`, `authority_generation`
  (`mc-core/src/claim_operation.rs:358-366`). Checked field by field by
  `require_claim_intent_binding` (`lib.rs:3851-3886`); a mismatch is
  `BindingMismatch`.

**Lifecycle.** Four states (`lib.rs:1224-1226`,
`mc-core/src/claim_operation.rs:368-402`): `staged`, `context-committed`,
`acknowledged`, `terminal-rejected`. `is_unresolved` is `staged |
context-committed` (`:399-401`), and that pair is what gates every reset
(`lib.rs:11319-11327`, `claim_mirror.rs:693-700`). A table CHECK ties
`result_json` presence to the state: NULL exactly when `staged`
(`lib.rs:1231-1234`).

The transition table is a single `match` at `lib.rs:11225-11255`:

| From | Ack kind | To |
| --- | --- | --- |
| `staged` | `ContextCommitted` | `context-committed` |
| `staged` | `TerminalRejected` | `terminal-rejected` |
| `context-committed` | `Acknowledged` | `acknowledged` |
| `acknowledged`, `terminal-rejected` | `Acknowledged` | no-op, `replayed: true` (`:11235-11236`) |
| same state, same `result_json` | matching kind | no-op, `replayed: true` (`:11237-11243`) |
| anything else | | `Transition` error (`:11244-11254`) |

So `terminal-rejected` is unreachable from `context-committed` and from
`acknowledged`: a committed claim can never be retroactively rejected. Both
terminal states are absorbing.

**Who writes.** `stage_claim_intent` (`lib.rs:11023-11119`) writes the only
`staged` row. `acknowledge_claim_intent` (`lib.rs:11165-11288`) writes every
other transition. Both run inside `with_conn_fenced`. Nothing else in the tree
updates `mc_claim_intents`.

### O5. The intent-control row has two writers, and only one of them works

`mc_claim_intent_controls` (`lib.rs:1240-1249`) is a single row holding a
`transition_state` of `accepting`, `draining`, or `resetting`. It is read in four
places and it gates the mirror's whole reset cycle:

| Reader | Line | Effect when the row is **absent** |
| --- | --- | --- |
| `claim_intent_stage_fence` | `lib.rs:4052-4061` | Fence passes. Fail-open. |
| `apply_claim_mirror_receipt` | `claim_mirror.rs:908-919` | `accepting` gate skipped entirely. Fail-open. |
| `replace_claim_mirror_snapshot` | `claim_mirror.rs:777-814` | Any non-identical replacement of an existing mirror returns `ResetRequired`. Fail-closed. |
| `delete_claim_mirror` | `claim_mirror.rs:1136-1147` | `unwrap_or(false)` means not-resetting, so `ResetRequired`. Fail-closed. |

There are two writers.

**Writer 1, `set_claim_intent_transition_tx` (`lib.rs:4118-4145`), never fires in
production.** Its first statement is
`if !is_lower_hex(database_incarnation_id, 32) { return Ok(()) }`
(`lib.rs:4124-4126`) — a silent success that writes nothing. All four call sites
pass `context_store_uuid`, not a 32-hex incarnation: `lib.rs:11436` (`resetting`),
`:11642` (`accepting` or `resetting`), `:11740` and `:11792` (`draining`).
`is_lower_hex` requires exactly 32 chars of `[0-9a-f]`
(`mc-core/src/claim_operation.rs:173-178`). The test suite documents the
production shape of that argument explicitly at
`tests/claim_intent_ledger.rs:11-15`: "Production mints the context store UUID
(`randomUUID()`) separately from the format marker's 32-hex database
incarnation", with `STORE_UUID` a 36-character dashed UUID at `:15`. A dashed
UUID fails `is_lower_hex`, so all four authority transitions silently write
nothing.

**Writer 2, `begin_claim_store_rebuild` (`lib.rs:11304-11348`), validates its
argument properly (`:11310-11314`) and writes `resetting` (`:11328-11338`) — but
it has no production caller.** `grep` across `crates/` and `packages/` finds it
referenced only at `tests/claim_intent_ledger.rs:299,313` and
`tests/claim_mirror.rs:331,454,498`, plus two doc-comment mentions
(`claim_mirror.rs:219,754`). No facade method, no host handler.

The consequence is that in default production `mc_claim_intent_controls` is
**never populated**, so the mirror's fail-closed readers latch: an existing
mirror can never be replaced with different content, and it can never be
deleted. The fail-open readers simply never engage.

The ledger's own drain fence survives this, because it does not depend on the
control row: `claim_intent_stage_fence` also resolves the live authority from the
bound route and refuses anything that is not `MODULE`
(`lib.rs:4062-4073`). The tests know this and say so at
`tests/claim_intent_ledger.rs:178-179`: "PREPARING is not MODULE, so the
route-resolved fence refuses the stage on the authority row itself rather than
relying on the transition-control row." So O5 is a mirror problem, not a ledger
problem.

### O6. Restart: everything is trusted from disk, nothing is reconstructed

On reopen, the mirror is read straight out of SQLite. `claim_mirror_state`
(`claim_mirror.rs:712-739`) reads `mc_claim_mirror_state` plus every row of
`mc_claim_mirror_projects`; `list_claim_mirror` (`:742-750`) reads
`mc_claim_mirror_claims`. There is no replay, no verification against the
authority, and no digest recomputation at open. `tests/claim_mirror.rs:482-517`
confirms the round trip survives a close and reopen.

Three identities bind the durable state:

- `database_incarnation_id`, in the primary key of all three data tables
  (`lib.rs:1268`, `:1289`, `:1309`). A receipt for another incarnation is
  `IncarnationMismatch` (`claim_mirror.rs:897-902`). This is what stops a mirror
  from a previous database life being read as current.
- `workspace_epoch`, compared for exact equality on every receipt
  (`claim_mirror.rs:903-907`).
- The per-project generation pair, which must advance by exactly one
  (`claim_mirror.rs:963-990`).

`mc_claim_mirror_state.updated_at_ms` is written on seed (`claim_mirror.rs:827`)
and on every receipt (`:1114-1117`) but is **never read**: no `SELECT` in the tree
retrieves it (verified by grepping every reference to `mc_claim_mirror_state`).
There is no time-based freshness test anywhere.

### O7. Stale-mirror detection is per-caller, and one caller has none

A stale mirror is distinguishable **only where the caller supplies an expected
snapshot vector**. Three production read paths, three different strengths:

1. **Atomic, inside the fenced commit.** `lib.rs:7368-7377` re-reads the mirror
   vector via `snapshot_vector_from_connection` inside the same
   `with_conn_fenced` transaction as the CAS and converts a mismatch into
   `CasConflict`. This is the only genuinely atomic freshness check.
2. **Optimistic double-read.** `crates/mc-module/src/transform.rs:1978-2011`
   reads the state, compares its canonical vector against the host-supplied
   `lane.snapshot_vector` (`:1988-1990`), lists the claims (`:1995-1999`), then
   re-reads the state and re-compares (`:2004-2010`), bailing out on any
   difference. `crates/mc-module/src/historian_chunk.rs:563-608` does the same
   shape but compares the whole `ClaimMirrorState` for equality at `:605`, which
   is strictly stronger than transform's canonical-vector comparison because it
   also covers `acked_effect_id`.
3. **No check at all.** `crates/mc-module/src/memory_tool.rs:57-67`
   (`list_committed_claims`) reads `claim_mirror_state()` solely to obtain
   `database_incarnation_id`, then lists claims. It takes no expected vector and
   performs no comparison. On this path a mirror that is arbitrarily far behind
   the authority is indistinguishable from a current one.

So the answer to "can a stale mirror be mistaken for a current one" is: no on the
commit path, no on the two assembly paths that receive an expected vector, and
**yes** on `list_committed_claims`.

### O8. Transform's read fence is load-bearing on a coupling it does not state

`transform.rs:2008` compares only the canonical snapshot vector, which
`snapshot_vector_value` (`mc-core/src/claim_operation.rs:330-337`) builds from
incarnation, workspace epoch, vector version, and the two generation maps. It
does **not** include `acked_effect_id`. That comparison is a sufficient
change-detector only because `apply_claim_mirror_receipt` guarantees every
touched project's generation advances (`claim_mirror.rs:963-990`), and
`acked_effect_id` changes only for touched projects (`:1064-1096`). The coupling
holds today. Nothing states it at either site, and `historian_chunk.rs:605`
independently chose the stronger comparison, which suggests the two authors did
not agree on what the fence needed.

A closely related coupling is documented, in the opposite direction: the comment
at `claim_mirror.rs:1066-1071` explains that *every retained row* in a touched
project must be restamped with the receipt's generations, because row equality in
the reseed comparison (`:802`) includes those fields, and leaving them stale
would make the next full replacement compare unequal and return `ResetRequired`.
`tests/claim_mirror.rs:519-527` is the regression test and states the same
reasoning.

## State map

| Item | Location | Keyed by | Lifetime | Invalidated by |
| --- | --- | --- | --- | --- |
| Mirror incarnation and epoch | `mc_claim_mirror_state`, `lib.rs:1251-1259`; read `claim_mirror.rs:712-739` | singleton `id = 1` | From seed until `clear_claim_mirror` | `clear_claim_mirror` (`claim_mirror.rs:706`), reached from `replace_claim_mirror_snapshot:816` or `delete_claim_mirror:1148` |
| Per-project generations and outbox checkpoint | `mc_claim_mirror_projects`, `lib.rs:1261-1269` | `(database_incarnation_id, project_id)` | Same as mirror state | Receipt touching that project (`claim_mirror.rs:1083-1095`); full reseed |
| Committed claim rows | `mc_claim_mirror_claims`, `lib.rs:1271-1295` | `(database_incarnation_id, public_claim_id)`, plus `UNIQUE (incarnation, revision_locator)` at `:1290` | Until superseded, revoked, or reseeded | Upsert (`claim_mirror.rs:1051-1052`), revocation delete (`:1053-1061`), generation restamp (`:1072-1082`), reseed |
| Receipt dedup ledger | `mc_claim_mirror_receipts`, `lib.rs:1299-1309` | `(database_incarnation_id, receipt_id)` | Unbounded; never pruned | `clear_claim_mirror` only (`claim_mirror.rs:703`) |
| Claim intent | `mc_claim_intents`, `lib.rs:1215-1235` | `(producer, operation_key)` (`:1230`) | Durable past terminal state; survives mirror delete (`claim_mirror.rs:1126-1127`, asserted `tests/claim_mirror.rs:457`) | Nothing. No delete statement exists for this table. |
| Intent transition control | `mc_claim_intent_controls`, `lib.rs:1240-1249` | singleton `id = 1` | Written only by `begin_claim_store_rebuild` in practice (O5) | `set_claim_intent_transition_tx:4127-4143` (dead in production), `claim_mirror.rs:849-856` (`resetting` to `accepting`) |
| In-flight receipt checkpoints | local `BTreeMap`, `claim_mirror.rs:992-1006` | `project_id` | One transaction | Transaction end |

## Candidate properties

### mirror-receipt-replay-applies-effects-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:177-250` applies one receipt and replays the identical bytes, asserting `applied_effect_count` then `replayed`. It does not cover a replay interleaved with an intervening receipt, a replay after reopen, or a replay racing a concurrent apply.
Guarantee: For one `(database_incarnation_id, receipt_id)`, the mirror absorbs that receipt's effects exactly once no matter how many times `apply_claim_mirror_receipt` is called with the same bytes.
Check: `always` — after any number of applies of a fixed receipt, per public claim ID the mirror row equals the row implied by applying the effect set once, and the project's `acked_effect_id` equals the receipt's last effect ID for that project; count `replayed: false` returns and assert exactly one. `always` because the dedup lookup at `claim_mirror.rs:921-928` runs on every call, so the property is evaluable at every apply rather than only on an optional path.
Fault/timing angle: The window is between the caller issuing the apply and observing its result. A lost response makes the caller retry with identical bytes, which is the whole reason the dedup row exists. Because the dedup insert (`claim_mirror.rs:1097-1113`) and the effects share one IMMEDIATE transaction (`:885`), a crash cannot leave effects applied without the dedup row.
Required faults and enabling state: A seeded mirror (`replace_claim_mirror_snapshot` first, or `NotSeeded` at `:894-896`). Then a dropped or delayed apply response, and a caller retry. To exercise the interesting variant, apply receipt N, apply receipt N+1, then replay N.
Confidence: high — [evidence](evidence/mirror-receipt-replay-applies-effects-once.md). Read the dedup lookup, the digest computation over the whole canonical group, and the single-transaction boundary; confirmed `with_conn_fenced` is one IMMEDIATE transaction.
Existing check: `crates/mc-store/tests/claim_mirror.rs:177-250` (`u10_scenario_2_complete_receipt_group_is_atomic_and_replay_safe`), status `unaudited`.
Impact: A replayed receipt applied twice would double-advance `acked_effect_id`, which then rejects the genuine next receipt with `CheckpointMismatch` and wedges the claim lane for that project until a reseed, which O5 shows production cannot perform.
Open questions:
- Does the facade retry `claim.mirror.apply` on a lost response, and with byte-identical bytes? `mc-module/src/lib.rs:10326` is the call site; the retry policy above it was not traced in this pass.

### mirror-receipt-conflict-rejects-divergent-replay

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reuses a receipt ID with different bytes. `tests/claim_mirror.rs:223-232` replays identical bytes only; `:592-624` covers a different guard (equal revision, different content, fresh receipt).
Guarantee: A second receipt presenting an already-recorded `receipt_id` with any different byte is refused with `ReceiptConflict` and mutates nothing.
Check: `always` — for every apply whose `receipt_id` is already present, the result is `ReceiptConflict` unless the recomputed group digest equals the stored one, and the mirror is byte-identical before and after the refused call. `always` rather than `always-or-unreached` because the comparison at `claim_mirror.rs:929-939` is on the same unconditional path as the accepted-replay case.
Fault/timing angle: None required. This is an admission check, not a race. The relevant hazard is a source that reuses receipt IDs across a rebuild it did not announce.
Required faults and enabling state: A seeded mirror with receipt R applied. Then apply a group with `receipt_id = R` and any altered field: a changed effect payload, a different vector, a different `expected_effect_count`.
Confidence: high — [evidence](evidence/mirror-receipt-conflict-rejects-divergent-replay.md). Verified the digest at `claim_mirror.rs:501-505` covers the serialized whole group, so no field is outside the comparison.
Existing check: none for the conflict arm. The identical-replay arm is covered at `tests/claim_mirror.rs:223-232`, status `unaudited`.
Impact: Without it, a source that restarted its receipt numbering would have its new effects silently swallowed as a replay, and the mirror would diverge from the authority with no error and no detection point.
Open questions: None.

### mirror-project-effect-chain-detects-omission

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:304-320` skips one effect and asserts `CheckpointMismatch`. Only the single-project, single-gap case; no multi-project interleave where another project occupies the intervening global effect IDs, which is the case the design comment at `claim_mirror.rs:100-102` names as the reason the field exists.
Guarantee: A receipt that omits an effect, reorders effects, or starts from the wrong position is refused, so the mirror's `acked_effect_id` only ever advances along the source's per-project effect chain with no gap.
Check: `always` — for each effect in receipt order, `previous_project_effect_id` equals the running checkpoint for that project, seeded from the stored `acked_effect_id`; the whole group is refused otherwise. `always` because `claim_mirror.rs:992-1006` walks every effect of every accepted receipt.
Fault/timing angle: None. Admission-time structural check. It is the mirror's only defence against a source that drops an effect while still numbering the rest correctly, since the group-level count check (`claim_mirror.rs:426-433`) only catches a count that disagrees with the array length.
Required faults and enabling state: A seeded mirror with at least two projects. Build a receipt whose effects for project A skip one of A's outbox positions while project B's effects occupy the intervening global IDs, so the contiguous-global-ID check at `claim_mirror.rs:435-448` still passes and only the per-project chain can catch it.
Confidence: high — [evidence](evidence/mirror-project-effect-chain-detects-omission.md). Traced both the contiguity check and the per-project chain and confirmed they catch different classes.
Existing check: `crates/mc-store/tests/claim_mirror.rs:304-320`, status `unaudited`.
Impact: A silently accepted omission leaves the mirror missing a claim the authority has, with `acked_effect_id` advanced past it, so no future receipt can repair it. That is the "omits one it does have" divergence, made permanent.
Open questions:
- `previous_project_effect_id` is validated only as `0 <= value < effect_id` (`claim_mirror.rs:454-461`). Is a source permitted to emit `0` for a project's first effect after a reseed whose checkpoint is nonzero? The reseed sets `acked_effect_id` from `project_checkpoints` (`:842`), so a nonzero checkpoint plus a `0` predecessor is a `CheckpointMismatch`. Whether the host can produce that pair is a host-side question. (needs human input)

### mirror-generation-advances-exactly-one-per-touched-project

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_mirror.rs:290-303` asserts one wrong generation is refused, and `:528-591` asserts untouched rows are restamped. Neither covers the untouched-project arm, where a receipt must present `stored + 0` for a project it does not touch.
Guarantee: An accepted receipt advances each touched project's `project_generation` and `policy_generation` by exactly one and leaves untouched projects unchanged, so the mirror's generation vector is a faithful counter of receipts applied per project.
Check: `always` — for every accepted receipt, for every project the mirror tracks, the receipt's generation equals the stored generation plus one when the receipt names that project and plus zero when it does not, and the same for policy generation. `always` because `claim_mirror.rs:963-990` iterates every stored project on every accepted apply.
Fault/timing angle: None directly. The property matters because two *other* mechanisms depend on it: the reseed row-equality comparison (`claim_mirror.rs:794-805`) and the optimistic read fence at `transform.rs:2008` (see `mirror-read-fence-relies-on-generation-advance`).
Required faults and enabling state: A seeded mirror with two projects at known generations. Submit receipts that touch one, the other, and neither, and submit off-by-one and off-by-two vectors in each direction.
Confidence: high — [evidence](evidence/mirror-generation-advances-exactly-one-per-touched-project.md). Read the `increment = i64::from(touched.contains(project_id))` construction and both mismatch arms.
Existing check: `crates/mc-store/tests/claim_mirror.rs:252-342` and `:528-591`, status `unaudited`.
Impact: A generation that advances by the wrong amount breaks the reseed comparison, producing a permanent `ResetRequired` that production cannot clear, and silently weakens the read fence that consumers rely on to notice a mirror change.
Open questions:
- Policy generation is required to move in lockstep with project generation (`claim_mirror.rs:972-989`), yet `ClaimMirrorChangeKind` distinguishes an `Applicability` or `Verification` change from an `Upsert` (`:58-68`). Is a policy-only change really required to bump the project generation too? Nothing in this crate explains why the two counters cannot move independently. (needs human input)

### mirror-read-fence-relies-on-generation-advance

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — nothing constructs a mirror mutation that changes `acked_effect_id` without changing a generation, which is the only case that would distinguish the two fence strengths.
Guarantee: The optimistic double-read fence in `transform.rs` detects every mirror mutation that lands between its two state reads, even though it compares only the canonical snapshot vector and not `acked_effect_id`.
Check: `always` — for every mirror mutation, the canonical snapshot vector before and after differ. Equivalently: no accepted mutation changes any project's `acked_effect_id` while leaving that project's generation pair unchanged. `always` because it must hold for every mutation for the fence to be sound; there is no optional path.
Fault/timing angle: The window is `transform.rs:1978` to `:2004`, three separate store calls with no shared transaction. A receipt applied concurrently in that window must be caught by the `:2008` comparison. `historian_chunk.rs:605` compares the whole `ClaimMirrorState` and so does not depend on this property; `transform.rs` does.
Required faults and enabling state: A seeded mirror and a concurrent `apply_claim_mirror_receipt` landing between the two `claim_mirror_state()` calls. The coverage form asserts the independent preconditions: the fence executed both reads, and at least one receipt committed between them.
Confidence: medium — [evidence](evidence/mirror-read-fence-relies-on-generation-advance.md). The coupling holds in the code as read: `:963-990` forces a generation bump for touched projects and `:1064-1096` restamps only touched projects. Confidence is medium because neither site documents the dependency and I could not find a design note stating it is intended to be permanent.
Existing check: none. `transform.rs:1978-2011` is the mechanism, not a check of it.
Impact: If a future mutation advanced a checkpoint without a generation bump, `transform.rs` would serve claim memory assembled from a mirror that changed mid-read, and the mismatch would be invisible. `historian_chunk.rs` would still catch it, so the two paths would disagree.
Open questions:
- Why do `transform.rs:2008` and `historian_chunk.rs:605` compare different things? If the full-state comparison is correct, transform's is weaker than intended; if the vector comparison is correct, historian's is needlessly strict and will bail out more often. (needs human input)

### mirror-reset-cycle-requires-a-rebuild-grant

Type: reachability
Reachability: test-only
Status: active
Exercised: yes — `tests/claim_mirror.rs:377-458` and `:482-517` drive the whole cycle, and `tests/claim_intent_ledger.rs:288-335` drives the grant. Every one of these calls `begin_claim_store_rebuild` directly from test code.
Guarantee: The mirror's destructive paths — dropping all four tables and reseeding with different content — execute only after `begin_claim_store_rebuild` has set `transition_state = 'resetting'`.
Check: `reachable` — the reseed's clear-and-insert at `claim_mirror.rs:816` and the delete's clear at `:1148` are each executed at least once per campaign by a path that begins at a production entry point. `reachable` and not `always` because this is location coverage: the claim under test is that these two code points can be reached at all from something production can call.
Fault/timing angle: None. This is a reachability claim about the production call graph, not a race.
Required faults and enabling state: None. It needs a production caller of `begin_claim_store_rebuild`, and searching `crates/` and `packages/` finds none: the only references are `tests/claim_intent_ledger.rs:299,313`, `tests/claim_mirror.rs:331,454,498`, and two doc comments at `claim_mirror.rs:219,754`.
Confidence: high — [evidence](evidence/mirror-reset-cycle-requires-a-rebuild-grant.md). Verified the absence of a production caller by grep across both source trees, and verified the two fail-closed readers latch when the control row is absent: `claim_mirror.rs:806-808` and `:1136-1147` with its `unwrap_or(false)`.
Existing check: `crates/mc-store/tests/claim_mirror.rs:377-458`, `:461-479`, `:482-517`; `crates/mc-store/tests/claim_intent_ledger.rs:288-335`. All status `unaudited`. Every one supplies the grant from test code, so none of them witnesses production reachability.
Impact: In production the mirror is write-once per incarnation. Once seeded, any snapshot that is not byte-identical returns `ResetRequired` (`claim_mirror.rs:806-808`) and `delete_claim_mirror` always returns `ResetRequired`. A mirror that has diverged, or a source that wants to re-baseline, has no recovery short of a new `database_incarnation_id`. The doc comments at `claim_mirror.rs:754-755` and `:1126-1127` describe an operable reset cycle that production cannot enter.
Open questions:
- Is `begin_claim_store_rebuild` intended to be reachable from the host, and if so through which facade method? Nothing in `mc-module` exposes it. (needs human input)
- Does a new `database_incarnation_id` fully substitute for a reset? The data tables are all keyed by incarnation (`lib.rs:1268`, `:1289`, `:1309`), so a fresh incarnation gives a clean namespace, but `replace_claim_mirror_snapshot` also compares the control row's incarnation (`claim_mirror.rs:778-785`), and old rows are never garbage-collected.

### mirror-accepting-gate-is-skipped-when-control-is-absent

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test applies a receipt while the control row says `draining`, and no test asserts that an absent control row permits an apply. The absent-row case is the production default (`mirror-reset-cycle-requires-a-rebuild-grant`), so every existing apply test runs through it without asserting it.
Guarantee: A receipt is applied only when the intent ledger is not mid-reset, and when the ledger's state cannot be determined the mirror refuses rather than proceeds.
Check: `always-or-unreached` — whenever the control row exists, an apply succeeds only if `transition_state = 'accepting'`; when it does not exist, the apply must be refused. `always-or-unreached` because the gate at `claim_mirror.rs:908-919` sits behind `if let Some(control)`, so it is an optional path that must be safe when taken and must not be silently bypassed when not.
Fault/timing angle: The window is a reset in progress: `begin_claim_store_rebuild` has set `resetting`, and a receipt minted before the reset arrives afterwards. With the row present the gate refuses it with `ResetRequired`. With the row absent there is no gate.
Required faults and enabling state: A seeded mirror. Case one: set the control to `draining` or `resetting`, then apply a valid receipt, and assert `ResetRequired`. Case two: no control row at all, then apply, and observe that it succeeds.
Confidence: high — [evidence](evidence/mirror-accepting-gate-is-skipped-when-control-is-absent.md). Read the `if let Some(control)` shape and compared it against the two fail-closed readers. `delete_claim_mirror:1143-1144` uses `.optional()?.unwrap_or(false)`, which treats an absent row as not-resetting and refuses; `apply_claim_mirror_receipt:908-919` treats an absent row as permission. The asymmetry is in one file, twelve lines apart in behaviour.
Existing check: none.
Impact: Today the absent row is the production norm and no reset ever runs, so the hole is latent. If `begin_claim_store_rebuild` is ever wired to production, this becomes the difference between a reset that fences in-flight receipts and one that races them.
Open questions:
- Is fail-open correct here on the reasoning that a store with no control row has no ledger to fence? If so, the reasoning is nowhere in the file, and the neighbouring `delete_claim_mirror` chose the opposite default.

### intent-control-transition-write-is-silently-dropped

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test asserts that a control row appears after an authority transition. `tests/claim_intent_ledger.rs:178-179` and `:169-228` deliberately assert the *authority-row* fence instead, and the comment at `:11-15` shows the fixture was built to make the control row absent.
Guarantee: A request to move the intent ledger's transition state either records the new state or reports a failure. It never returns success having written nothing.
Check: `always` — for every call to `set_claim_intent_transition_tx` that returns `Ok`, `mc_claim_intent_controls` afterwards holds the requested `transition_state`. `always` because the function has exactly one success contract and the property must hold on every call.
Fault/timing angle: None. It is an unconditional early return, not a race.
Required faults and enabling state: None beyond an authority transition on the `memories` domain with a `context_store_uuid` that is not 32 lowercase hex. `authority_begin_prepare` (`lib.rs:11434-11440`), `authority_finish_prepare` (`:11640-11651`), and both `authority_begin_drain` arms (`:11738-11744`, `:11790-11796`) all pass `context_store_uuid`. A dashed UUID is the production shape per `tests/claim_intent_ledger.rs:11-15`.
Confidence: high — [evidence](evidence/intent-control-transition-write-is-silently-dropped.md). Verified `is_lower_hex` requires exactly 32 chars of `[0-9a-f]` (`mc-core/src/claim_operation.rs:173-178`), verified all four call sites pass `context_store_uuid`, and verified the test suite's own comment states production mints that value as `randomUUID()`.
Existing check: none.
Impact: The `draining` and `accepting` states are never recorded from authority transitions, so three of the mirror's four control-row readers never see the state the authority is actually in. The visible consequences are `mirror-reset-cycle-requires-a-rebuild-grant` and `mirror-accepting-gate-is-skipped-when-control-is-absent`. A second consequence is that the column named `database_incarnation_id` (`lib.rs:1242-1243`) would, if the guard ever passed, hold a `context_store_uuid`, which `claim_mirror.rs:778-785` and `:909-915` compare for equality against a real incarnation ID and would reject.
Open questions:
- Is the early return a deliberate "callers may pass a non-incarnation identity, ignore it" contract, or an unnoticed mismatch between the parameter's name and what every caller supplies? The parameter is named `database_incarnation_id` and every call site passes `context_store_uuid`, which `lib.rs:4062-4065` explicitly says are minted independently. (needs human input)

### intent-identity-is-producer-and-operation-key

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_intent_ledger.rs:133-166` covers restart survival (`:148-151`), an incarnation binding mismatch (`:153-161`), and a digest conflict (`:162-165`). `format_epoch`, `authority_project`, and `authority_generation` mismatches on an existing row are not covered, and neither is a second producer using the same `operation_key`.
Guarantee: One intent is identified by `(producer, operation_key)` alone; a second request under that key is accepted as a replay only if its request digest and all four binding fields match the stored row, and is otherwise refused without mutating it.
Check: `always` — for every stage or acknowledge against an existing key, the call returns `IdentityConflict` on a digest mismatch, `BindingMismatch` on any binding field mismatch, and only otherwise proceeds; the stored row is unchanged in both refusal cases. `always` because both checks run unconditionally ahead of any mutation at `lib.rs:11049-11063` and `:11209-11223`.
Fault/timing angle: None required for the identity checks. The identity matters under retry: a producer that reuses an operation key for a semantically different request must be refused rather than silently served the earlier result.
Required faults and enabling state: A staged intent. Then re-stage the same key with a different request body, with each of the four binding fields altered in turn, and acknowledge with a wrong digest.
Confidence: high — [evidence](evidence/intent-identity-is-producer-and-operation-key.md). Read the primary key, both refusal sites, and `require_claim_intent_binding`'s field list.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs:133-166`, status `unaudited`.
Impact: If the digest check were bypassed, a reused operation key would return another request's committed result to the caller, which is a wrong-answer bug rather than a lost-work bug. `producer` is caller-supplied and unvalidated beyond length (`lib.rs:1216`, `:3838-3847`), so the namespace's integrity is entirely the caller's to maintain.
Open questions:
- Is `producer` authenticated anywhere above this layer? Within `mc-store` it is an opaque 1..=256-byte string, so any caller can stage into any producer's namespace. Not traced in this pass.

### intent-terminal-state-is-entered-at-most-once

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_intent_ledger.rs:85-131` walks staged to context-committed to acknowledged, and `:169-228` and `:346-401` reach terminal-rejected. No test attempts an illegal transition out of a terminal state, and none asserts that a repeated acknowledge of a terminal row is a no-op rather than a rewrite.
Guarantee: `acknowledged` and `terminal-rejected` are absorbing: once entered, no acknowledgement changes the row's state or its `result_json`, and a committed intent can never become rejected.
Check: `always` — for every acknowledge against a row already in a terminal state, either the call returns `replayed: true` with the row byte-identical, or it returns a `Transition` error; the row's `state` and `result_json` are unchanged in both cases. `always` because the transition `match` at `lib.rs:11225-11255` is total and evaluated on every acknowledge.
Fault/timing angle: The window is a lost acknowledgement response causing a retry, which must be a no-op, versus a genuinely late duplicate acknowledgement of a different kind, which must be an error. Both land in the same `match`.
Required faults and enabling state: A staged intent. Drive it to each terminal state and then attempt every combination of `ClaimIntentAckKind` against it, including `TerminalRejected` against `context-committed` and against `acknowledged`, which must both fail.
Confidence: high — [evidence](evidence/intent-terminal-state-is-entered-at-most-once.md). Enumerated all twelve `(kind, state)` pairs against the `match` arms and confirmed the `UPDATE` at `:11256-11268` is reached only when `next_state` is `Some`.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs:85-131`, `:169-228`, `:346-401`. All status `unaudited`.
Impact: A terminal state that could be re-entered or overwritten would let a rejection replace a committed result, or let a retry rewrite `result_json` under a caller that already read the first value.
Open questions:
- `(Acknowledged, TerminalRejected)` returns `replayed: true` and writes nothing (`lib.rs:11235-11236`), so the fact that a rejection was delivered to its producer is recorded nowhere. Is settlement of a rejection meant to be observable? The doc at `mc-core/src/claim_operation.rs:368-369` calls `acknowledged` "transport settlement, not a second semantic claim state", which argues the no-op is deliberate, but then a rejection's settlement is simply unobservable.

### intent-staged-replay-produces-one-context-effect

Type: safety
Reachability: default-production
Status: active
Exercised: partial — `tests/claim_intent_ledger.rs:337-401` proves a staged replay is refused once the authority is draining, which is the fence, not the effect count. Nothing in this crate observes the context effect, because the effect lands in a different database.
Guarantee: A crash between staging an intent and recording its context commit is recoverable, and the recovery replay produces at most one durable context effect for that intent.
Check: `always` — per `(producer, operation_key)`, the number of durable context effects attributable to that intent is at most the number of stage attempts that passed the fence and at least the number of intents that reached `context-committed`. Per-identity equality against the intent's own `result_json` effect list is the primary oracle; the attempted-versus-acknowledged bounds are the cheap screen. `always` because the property must hold for every intent, and per-identity because aggregate effect totals cancel across intents.
Fault/timing angle: Two distinct windows, and only the second is dangerous. Staging commits in one `with_conn_fenced` transaction in `mc_cache` (`lib.rs:11037`); the context mutation lands in `context.db`; the acknowledgement is a third transaction (`:11195`). A crash after staging and before the mutation leaves `staged`, and the replay correctly re-runs the mutation. A crash **after** the mutation and before the acknowledgement also leaves `staged`, and the replay re-runs the mutation a second time. The comment at `lib.rs:11064-11070` states plainly that "a replay goes on to execute the context mutation", so the store deliberately does not make this decision; idempotence must come from the context mutation being keyed by the same identity.
Required faults and enabling state: A route at `MODULE` authority. Stage an intent, apply the context mutation, then kill the process before `acknowledge_claim_intent` with `ContextCommitted`. Restart and replay the same stage. Count durable effects for that identity.
Confidence: medium — [evidence](evidence/intent-staged-replay-produces-one-context-effect.md). The two windows and the replay path are verified in this crate. Confidence is medium because the effect side lives in `context.db` behind the host, which this pass did not read, so whether the mutation is idempotent under the same operation key is unresolved.
Existing check: `crates/mc-store/tests/claim_intent_ledger.rs:337-401` covers the drain fence on replay, status `unaudited`. No check covers the effect count.
Impact: If the context mutation is not idempotent under the operation key, a crash in the second window produces a duplicate claim effect, and the mirror will faithfully project it. The ledger records one intent, so the duplication is invisible from the store side.
Open questions:
- Is the context mutation keyed by `(producer, operation_key)` such that re-execution is a no-op? Unresolved; needs the host's claim-apply path, which is outside this scope. (needs human input)
- Should the ledger record an intermediate "mutation attempted" state to close the second window? That is a design decision. (needs human input)

### mirror-staleness-undetectable-on-memory-tool-read-path

Type: safety
Reachability: default-production
Status: active
Exercised: not yet — no test reads through `list_committed_claims` with a mirror deliberately behind the authority, because nothing in the store can express "behind the authority".
Guarantee: Every production consumer of committed mirror claims either verifies the mirror's snapshot vector against an expected value or is documented as accepting arbitrarily stale data.
Check: `always` — for every production read of `list_claim_mirror`, the reading function either compares the mirror's canonical snapshot vector against a caller-supplied expected vector, or carries an explicit statement that staleness is acceptable. `always` because it is a property of the whole read surface, evaluable at every read site.
Fault/timing angle: The window is unbounded: there is no freshness bound anywhere. `mc_claim_mirror_state.updated_at_ms` is written at `claim_mirror.rs:827` and `:1114-1117` and never read by any statement in the tree, so age is not even observable.
Required faults and enabling state: A seeded mirror plus a source that stops delivering receipts, for example because a receipt was refused with `CheckpointMismatch` and the lane wedged. Then read through `list_committed_claims`.
Confidence: high — [evidence](evidence/mirror-staleness-undetectable-on-memory-tool-read-path.md). Enumerated the production read sites: `lib.rs:7368-7377` (atomic, in-transaction), `transform.rs:1978-2011` (optimistic double-read against an expected vector), `historian_chunk.rs:563-608` (same, stronger comparison), and `memory_tool.rs:57-67` (no comparison). Verified `updated_at_ms` is written but never selected.
Existing check: none for the unfenced path. The fenced paths are mechanisms, not checks.
Impact: `list_committed_claims` can surface committed claim memory from a wedged mirror indefinitely, with no error and no signal to the caller, while the two assembly paths correctly go quiet. The system degrades inconsistently: some surfaces notice, one does not.
Open questions:
- Is `list_committed_claims` a tool-facing read where the caller already knows the mirror may lag? Its signature takes no expected vector, so it cannot check even if it wanted to. Whether that is intended is a design decision. (needs human input)

## Contract-vs-code leads

### L1. `set_claim_intent_transition_tx` is named for one identity and called with another

Code: the parameter is `database_incarnation_id: &str` (`lib.rs:4120`), and the
guard requires 32 lowercase hex (`:4124`). All four call sites pass
`context_store_uuid` (`:11436`, `:11642`, `:11740`, `:11792`).

Contract, from the same file: `lib.rs:4062-4065` states that `mc_authority` "is
keyed by `context_store_uuid`, which the host mints independently of the format
marker's `database_incarnation_id`", and warns that keying a lookup by the wrong
one "matches no row and fails open". The test suite states the production shape
at `tests/claim_intent_ledger.rs:11-15`.

So the file documents that these two identities are different, and then passes
one where the other is named. The guard turns the mismatch into a silent no-op
rather than an error. Both sides cited; not resolved here. See
`intent-control-transition-write-is-silently-dropped`.

### L2. The documented reset cycle has no production entry point

Contract: `claim_mirror.rs:754-755` says "Replacing existing state requires
`begin_claim_store_rebuild`", `:219-220` renders `ResetRequired` as "claim mirror
replacement requires begin_claim_store_rebuild", and `:1126-1127` describes
`delete_claim_mirror` as usable once the ledger "must already be frozen in
`resetting`".

Code: `begin_claim_store_rebuild` (`lib.rs:11304-11348`) is called only from
tests. The facade exposes `claim.mirror.replace` and `claim.mirror.apply`
(`mc-module/src/lib.rs:10052-10053`) and nothing else. Both fail-closed readers
therefore latch permanently in production.

The doc comments describe a real and correct protocol. Nothing wires it up. See
`mirror-reset-cycle-requires-a-rebuild-grant`.

### L3. Absent control row means "refuse" in one method and "permit" twelve lines away

`delete_claim_mirror` reads the control row with
`.optional()?.unwrap_or(false)` (`claim_mirror.rs:1143-1144`) and refuses when
absent. `apply_claim_mirror_receipt` reads it with `if let Some(control)`
(`:908-919`) and permits when absent. `replace_claim_mirror_snapshot` uses
`matches!(control.as_ref(), Some((_, state)) if state == "resetting")`
(`:806`), which also refuses when absent.

Two of the three fail closed, one fails open, and no comment explains the
difference. See `mirror-accepting-gate-is-skipped-when-control-is-absent`.

### L4. A replay with different result bytes is reported as a state-transition error

Code: the idempotent-replay arms at `lib.rs:11237-11243` are guarded by
`record.result_json.as_deref() == result_json`. When the state matches but the
bytes differ, the guard fails and control reaches the `_` arm at `:11244-11254`,
which returns `Transition { expected: "staged", found: "context-committed" }`.

The row is not in the wrong state; the caller supplied different result bytes for
an already-settled intent. That is an identity conflict in substance, and
`ClaimIntentTxnOutcome::IdentityConflict` (`lib.rs:3894-3897`) exists for exactly
this shape. The error a caller receives names the wrong cause and reports an
"expected" state the row was never required to be in. No test covers this arm.

### L5. Two read fences over the same state compare different things

`transform.rs:2008` compares canonical snapshot vectors.
`historian_chunk.rs:605` compares the whole `ClaimMirrorState`, which also covers
`acked_effect_id`. Both are guarding the same non-atomic read of the same tables
for the same purpose. One of them is wrong about what the fence needs. See
`mirror-read-fence-relies-on-generation-advance` and Q2.

### L6. The module doc's drain precondition is enforced on a different table

Contract: `claim_mirror.rs:3-6` says "Full reseeds require the intent ledger to be
drained."

Code: both reset paths enforce this by counting `mc_claim_intents` rows in
`('staged', 'context-committed')` (`claim_mirror.rs:693-700`, called at `:764`
and `:1130`). That matches the contract and is a correct reading of "drained".
The wrinkle is that "drained" in the *authority* sense is a different thing,
tracked in `mc_authority.state = 'DRAINING'` and gated at `lib.rs:4071-4073`. The
two senses share a word and are enforced on different tables. Recorded because
the overlap is easy to misread, not because either side is wrong.

## Open questions

### Q1. Does the facade retry `claim.mirror.apply` with byte-identical bytes?

Sources examined: `mc-module/src/lib.rs:10299-10336` (the handler),
`claim_mirror.rs:921-940` (the dedup contract).
Findings: the store's dedup is byte-exact on the canonical group digest, so a
retry that re-serializes with any difference becomes `ReceiptConflict` rather
than a benign replay. The handler decodes a caller-supplied payload; it does not
re-mint it.
Missing evidence: the host-side sender and its retry policy, which are outside
this scope.
Conclusion: unresolved, needs the host claim-outbox sender.

### Q2. Which read fence is correct, transform's or historian's?

Sources examined: `transform.rs:1978-2011`, `historian_chunk.rs:563-608`,
`claim_mirror.rs:963-990` and `:1064-1096`,
`mc-core/src/claim_operation.rs:330-337`.
Findings: today the two are equivalent in effect, because every accepted receipt
bumps the generation of exactly the projects whose `acked_effect_id` it changes.
The comparison at `transform.rs:2008` is therefore sufficient by consequence, not
by construction. Neither site records the dependency.
Missing evidence: a design note stating whether the generation-per-effect
coupling is a permanent invariant.
Conclusion: needs human input.

### Q3. Is `begin_claim_store_rebuild` meant to be reachable in production?

Sources examined: `grep` for the symbol across `crates/` and `packages/`;
`mc-module/src/lib.rs:10040-10060` (the facade dispatch table);
`claim_mirror.rs:219`, `:754`.
Findings: no production caller and no facade method. The doc comments describe
the grant as a precondition for two documented operations that production
consequently cannot perform.
Missing evidence: whether a new `database_incarnation_id` is the intended
production substitute for a reset, and whether rows under retired incarnations
are ever collected.
Conclusion: needs human input.

### Q4. Is the unbounded receipt dedup ledger acceptable?

Sources examined: `lib.rs:1299-1310` (schema, no retention column),
`claim_mirror.rs:1097-1113` (the only insert), `:703` (the only delete).
Findings: one row per receipt per incarnation, forever, since the only deletion
is the wholesale clear that Q3 shows production cannot reach. Each row holds a
64-char digest and a canonical vector JSON, so the growth is proportional to
receipt count times project count.
Missing evidence: expected receipt rate in production, and whether any operator
tooling prunes `mc_cache` out of band.
Conclusion: unresolved, needs a production receipt-rate figure.

### Q5. Must a policy-only change bump the project generation?

Sources examined: `claim_mirror.rs:963-990` (lockstep requirement),
`:58-68` (`ClaimMirrorChangeKind` distinguishes `Applicability`, `Verification`,
`Lifecycle` from `Upsert`), `:114-116` (policy-only revocation).
Findings: the code requires `project_generation` and `policy_generation` to move
by the same increment on every touched project, so the two counters can never
diverge, which makes the separate `policy_generation` column carry no
information the project generation does not already carry.
Missing evidence: the host's reason for modelling two counters.
Conclusion: needs human input.

### Q6. Is `producer` authenticated above `mc-store`?

Sources examined: `lib.rs:1216` (length CHECK only), `:3838-3847` (length
validation only), `:11087-11104` (insert).
Findings: within this crate `producer` is an opaque caller-supplied string and
forms half the intent primary key, so any caller can stage into any producer's
namespace.
Missing evidence: the facade's authentication of the `producer` field.
Conclusion: unresolved, needs the `mc-module` claim-intent handler.
