# Lens A: CLI wizards, doctor verdicts, and destructive database commands

Sub-part 5d, lens A. Attention focus: the two categories that outrank coverage
in this material. The wizards decide whether a subsystem is on, and the
destructive commands can abandon a user's database. Everything else in the CLI
is read in service of those two.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`
("refactor(shm): trim final review leftovers"). Method contract in
[../../METHOD.md](../../METHOD.md). Scope from
[../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:568-604](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md).
House style from [../../part-5a-storage/catalog.md](../../part-5a-storage/catalog.md).
Every line reference below was read at `HEAD` before it was written.

In this part `default-production` means reachable in a shipped install by an
ordinary user: the command is reachable from `dispatch.ts:106-158` without a
flag the release notes do not document, and the state it acts on arises without
editing a database or a config by hand. Each record states its own evidence.

## Two corrections to the scope map, carried here so later parts inherit them

**Line count.** The scope map records 5d as "15 units, 9,262 lines". The
sixteen files it lists (fifteen units, because `setup-omp.ts` and `setup.ts` are
grouped) sum to **10,496** lines at `HEAD` by `wc -l`. The difference is 1,234
lines and does not correspond to any single listed file, so it is arithmetic,
not a stale reading. No record changes.

**Four unlisted files carry destructive or mutating code.** The 15-unit list
omits `packages/cli/src/commands/doctor.ts` (211),
`doctor-merge-identity.ts` (102), `doctor-authority.ts` (237), and
`doctor-opencode-cache.ts` (113) — 663 lines. This matters because `doctor.ts`
is the **only** production caller of the migration sweep that deletes staged
files (`doctor.ts:69-97` calling `migrate.ts:327-380`), and
`doctor-merge-identity.ts` is a fourth destructive command with its own
confirmation model. The destructive code itself lives in in-scope files, so the
records below stay anchored in scope and cite these four as boundary callers.
`daemon.ts` remains correctly excluded as moving; see Open questions for what
that costs the Part 2a follow-up.

## What this lens found, in one paragraph

The destructive commands are not uniformly designed. `doctor reset-db` is the
most carefully built code in the sub-part: an interruption-safe marker, a
dev/inode-bound family verification, three separate refusals of a supported
database, and a post-confirmation reclassification whose reasoning is written
down at `doctor-reset-db.ts:614-622`. It is also the command that will abandon a
database a newer binary owns, because the classifier it consults never types the
direction of a format-epoch mismatch. `doctor repair-db` swaps the live database
with no confirmation at all and ignores every flag a user might type expecting a
preview. `doctor` itself deletes files. The OpenCode wizard turns off the
harness's own context manager without asking, while the OMP wizard asks for the
same change; and the OpenCode doctor exits `0` with unresolved failures while
the Pi and OMP doctors do not. Both OpenCode-specific asymmetries sit in the two
files with no end-to-end test in the suite.

## Destructive command table

Reversibility column: **logical** means the application loses the data but the
bytes remain on disk at a stated path; **physical** means bytes are unlinked.

| Command | What it deletes or overwrites | Confirmation | Reversible | Non-interactive |
| --- | --- | --- | --- | --- |
| `doctor reset-db` | Renames the whole `context.db` family (`-journal`, `-wal`, `-shm`, main, then the marker) into `${dbPath}.mc-quarantine-<stamp>/`, 0700 dir / 0600 files (`doctor-reset-db.ts:292-369`, order at `storage-format-epoch.ts:455-460`). Nothing is unlinked. | `confirm(..., false)` at `doctor-reset-db.ts:603-607`, default no; recovery arm at `:525-529`. **`--yes` skips it** (`:377`). | Logical. `RETENTION_NOTE` (`:76-77`) states the files stay until the user deletes them. Next open bootstraps fresh (`:365-367`). | **Yes**, `--yes` (`:673-674`). |
| `doctor reset-db --dry-run` | Nothing. Returns before the holder inspection and before marker publication (`:579-586`); recovery arm at `:520-524`. | None needed. | n/a | Yes. |
| `doctor repair-db` (salvage arm) | Renames live `context.db`, `-wal`, `-shm` to `${dbPath}.corrupt-original-<stamp>*` and installs the `.recover`ed rebuild in their place (`activateReplacement`, `doctor-repair-db.ts:453-475`, called at `:664`). Rows `.recover` could not attribute are absent from the installed database. | **None.** No prompt precedes `:664`. The only `confirm` in the file is `:702-705`, on the fresh-empty arm. | Logical, twice over: a pre-run backup bundle at `${dbPath}.corrupt-backup-<stamp>*` (`:557-568`) and the moved originals (`:663-668`). | Yes, trivially: there is no prompt to answer. `runRepairDbCli` (`:754-763`) accepts **any** flag and ignores it. |
| `doctor repair-db` (fresh-empty arm) | Same rename-aside, then installs a newly composed empty schema (`prepareFreshDatabase`, `:407-447`; activation `:728-742`). | `confirm(..., false)` at `:702-705`, default no. Re-checks holders after (`:712-715`). | Logical, same two copies. | No: the prompt has no bypass flag. |
| `doctor` (plain, and every `doctor <harness>`) | `sweepPendingMigrations` (`migrate.ts:327-380`), invoked at `doctor.ts:69-97`: for `phase='staged'` rows `fs.unlinkSync(row.stage_path)` (`migrate.ts:376`); for `phase='db_committed'` rows `fs.renameSync(stage → final)` (`:362`); deletes the journal row in all three reconciled arms. Also rewrites `magic-context.jsonc` whole-file when a deprecated key is present (`doctor-opencode.ts:979-981`). | **None**, on either. No `--dry-run` exists for `doctor`. | Staged-file unlink: **physical**, not recoverable. Config rewrite: no backup; `:783-789` documents accepted comment loss. | Yes; it is the default invocation. |
| `doctor migrate --from opencode --to pi\|omp --session <id>` | `DELETE FROM compartments` and `DELETE FROM session_facts` for `(session_id=<new pi id>, harness='pi')` inside the commit transaction (`migrate.ts:1158-1164`). Runs the sweep above first (`:1408`). Writes the session JSONL. | **None.** No prompt anywhere in `migrate.ts`. | The DELETEs target a freshly minted UUIDv7 or a journal-resumed id (`:1401-1428`), so in practice they delete only a prior attempt's rows. No backup is taken. | Yes; `--dry-run` exists (`:1558`) but no confirmation exists to bypass. |
| `doctor migrate-session --session <id> --to <dir>` | `UPDATE session` in `opencode.db` (`migrate-session.ts:313-319`); in `context.db` upserts `session_projects`, re-stamps `compartment_chunk_embeddings.project_path`, and nulls `session_meta.cached_m0_bytes`/`cached_m1_bytes` (`:349-384`). | `confirm(..., false)` at `:605-608`, default no. **`--yes` does not reach it** — `skipConfirm` (`:463`) is used only at `:575-587`, despite the help text at `:447`. | Yes: SQLite snapshots of both databases under write locks before apply (`:617-627`). | **No**, contrary to `:447`. |
| `doctor merge-identity --from <id> --to <id>` | Rewrites the identity column of every project-scoped table (`mergeProjectIdentities`, out of scope). File is `doctor-merge-identity.ts`, **not in the 15-unit list**. | No prompt at all; refuses without `--yes` and exits 2 (`:81-88`). | No backup taken. | **Yes**, `--yes`, fully unattended. |
| `doctor --clear` | `rmSync(path, {recursive: true, force: true})` on selected plugin cache directories (`doctor.ts:184-201`). | Multi-select picker plus `confirm("... This is irreversible.", false)` (`:173-181`). | No — but the target is a regenerable npm cache, not user data. | No. |
| `doctor --force` (cache arm) | Deletes plugin cache directories with no picker and no prompt (`doctor-opencode.ts:1320-1355` → `clearPluginCache`, `doctor-opencode-cache.ts:36`). | None. | No; regenerable cache. | Yes. |

Three readings of that table are load-bearing:

1. **Two destructive commands run fully unattended.** `doctor reset-db --yes`
   and `doctor merge-identity --yes`. Both require an explicit flag, which is
   the right shape.
2. **Two destructive operations run with no confirmation and no bypass flag,
   because there is nothing to bypass.** `doctor repair-db`'s salvage-arm swap
   and the migration sweep inside plain `doctor`. These are the ones that
   surprise: `doctor` is documented at `dispatch.ts:45` as "Check and fix
   configuration issues" and it unlinks files.
3. **The one command whose help promises a bypass does not have one.**
   `migrate-session.ts:447` advertises `--yes`; `:605-608` ignores it.

## Wizard decision map

Three entry points share one config writer shape. `setup.ts:17-61` resolves the
harness and dispatches (`:63-72`); `setup-omp.ts:144-150` delegates to
`setup-pi.ts`'s flow with an OMP environment.

| Decision | OpenCode (`setup-opencode.ts`) | Pi / OMP (`setup-pi.ts`, `setup-omp.ts`) |
| --- | --- | --- |
| Historian model | `pickModel` at `:445`, always asked, `:79-88` of `model-picker.ts` rejects empty input | `:403`, same picker |
| Dreamer on | `confirm("Enable dreamer?", true)` at `:449` — **default yes** | `:428-431` — **default yes** |
| Dreamer model + schedules | `runDreamerSetup` at `:453` only when enabled; `dreamer-setup.ts:112-118` defaults "use recommended schedules" to yes | `:437-441`, same |
| Sidekick on | `confirm("Enable sidekick?", false)` at `:459` — default no | `:442` — default no |
| Claude Max cache TTL | `confirm(..., false)` at `:474`, only when an `anthropic/` model was discovered (`:467`) | not asked |
| Embedding provider | not asked; local remains the default | `chooseEmbedding` at `:446`; picking local **clears** `model`/`endpoint`/`api_key` (`:271-278`, documented `:268-270`) |
| Harness native compaction | **never asked.** `:517-522` writes `compaction:{auto:false,prune:false}` into `opencode.jsonc` (`:148`, `:152-158`) whenever `compactionEnabled` is true | **asked.** `setup-omp.ts:64-73` confirms "Disable OMP native compaction?" and **aborts** if declined |
| Harness native memory backend | n/a | `setup-omp.ts:75-86`, confirms, aborts if declined |
| TUI sidebar plugin | **never asked.** `:555` adds it to `tui.json` unconditionally | n/a |
| Remove third-party `@tarquinen/opencode-dcp` | `confirm(..., true)` at `:227` — **default yes**, edits a foreign plugin list | n/a |
| Apply conflict fixes to OpenCode + OMO files | `confirm(..., true)` at `:426-429` — **default yes** | n/a |
| Disable oh-my-opencode hooks | `confirm(..., true)` at `:505`, first-install only (`:494`, rationale `:486-492`) | n/a |
| Legacy config-location migration | runs at `:313` **before the first prompt**; copies then `unlinkSync`es the legacy source (`config/migrate-config-location.ts:472`) | `setup-pi.ts` does not call it |

What the wizard writes, in order, at `setup-opencode.ts:516-577`:
`opencode.jsonc` (`:517`), conflict fixes to OpenCode and OMO (`:534-543`),
`magic-context.jsonc` (`:545`), `tui.json` (`:555`), OMO hook disables
(`:558-576`). Each write is individually atomic via `writeFileAtomic`; there is
no cross-file transaction and, unlike `setup-pi.ts:483-490`, **no rollback**.

Enablement is encoded as an absent key. `:263` deletes `dreamer.enabled`
unconditionally and `:281` deletes `sidekick.enabled`; enabling means deleting
`disable` (`:265`, `:283`) and disabling means setting it true (`:276`, `:289`).
The runtime reads exactly that: `agent-disable.ts:11-13` is
`!!config.dreamer && config.dreamer.disable !== true`, and `:15-17` mirrors it
for sidekick. So the delete is **safe** for the runtime — nothing reads
`enabled`, and the loader migrates a stale `enabled=false` in memory at
`:64-73`. This closes the scope map's focus-1 question in the wizard's favour.
The block-existence half is what matters instead: `!!config.dreamer` is false
when no `dreamer` block exists, so a missing `magic-context.jsonc` leaves
dreamer **off**. `:278` writes `config.dreamer = dreamer` unconditionally, so a
completed run always creates the block.

## Doctor diagnosis map

| Concern | OpenCode (`doctor-opencode.ts`) | Pi (`doctor-pi.ts`) | OMP (`doctor-omp.ts`) |
| --- | --- | --- | --- |
| Pending reset marker | checked upstream in `doctor.ts:46-51`, returns 1 before any DB open | same | same |
| Migration sweep | `doctor.ts:65-97`, once per invocation, before dispatch | same | same |
| Config-location migration | `:620`, return value **discarded** | `:1044`, warnings threaded into checks | `:454-456`, refusal blocks the config write at `:463-468` |
| Deprecated config keys | migrated and written back at `:767-985`, `fixed++` per key | via `repairPlan` | via `repairPlan` |
| Config parses / loads | `:726-764` | yes | yes |
| Plugin registered | `:987-1084` | yes | yes |
| Conflicts | `:1085-1138` | yes | yes |
| Embedding endpoint | live probe, `:1233-1240` → `:424-605` | `:699-714` | no |
| `context.db` opens | `openExistingContextDatabase(..., {readonly:true})` at `:1252` | `:597-601` | yes |
| Version-lane fence | `checkStorageVersionFence` at `:1261`; `UnsupportedSchemaVersionError` → `fail` at `:1305-1311` | `:600`, `:623-627` | via repair guidance |
| **Format-epoch fence** | **not checked at all** | **not checked** | **not checked** |
| `PRAGMA integrity_check` | `:1264-1278` | yes | yes |
| Re-check after repair | **no** | **yes**, `:1061-1081` | **yes**, `:470-474` |
| Exit code | `0` unless the final `else` at `:1436-1438` is taken | `first.fail > 0 ? 1 : 0` (`:1085`), `second.fail > 0 ? 1 : 0` (`:1081`) | `first.fail === 0 ? 0 : 1` (`:461`), `second.fail === 0 ? 0 : 1` (`:474`) |

The verdict can be wrong in the dangerous direction on two independent axes,
and only in the OpenCode doctor for one of them.

**Axis 1, exit code.** `doctor-opencode.ts:1430-1441` is a four-arm chain.
Only the last arm returns 1. The `issues > 0 && fixed > 0` arm (`:1432-1433`)
falls through to `return 0` at `:1441`, so a run that fixed one deprecated
config key and failed five checks exits 0 with the message
"Found 5 issue(s), fixed 1." The Pi and OMP doctors both re-run their checks
after repairing and derive the code from the second pass.

**Axis 2, what the read-only open proves.** `database-access.ts:117-180` gates
on `options.readonly`: the pre-open artifact gate is skipped at `:122-138` and
the whole format-family classification is skipped at `:143-153`. Only the
version-lane check at `:154-161` runs unconditionally. `checkStorageVersionFence`
(`storage-versions.ts:33-58`) compares nothing but the version lane. So a
database whose marker carries `format_epoch = 2` while its version lane reads 90
opens cleanly under doctor, gets `pass("Opened the shared DB with a supported
schema")` at `:1257`, and prints "Format fence: context.db and this build are
both v90" — while `storage-db.ts:669` refuses that same database on the epoch
arm and `:663-666` calls the epoch "the signal that actually distinguishes a
database this build is too old to read from one it must refuse".

Remediation advice can itself cause harm. `storage-db.ts:678` ends with "Do not
reset this database: a newer binary owns it." `doctor reset-db` will reset it;
see `cli-a-reset-db-abandons-a-newer-format-family` below.

## Observations

**O1. The family classifier reset-db consults never types the direction of a
mismatch.** `inspectDirectDatabaseFamilyState` (`database-access.ts:307-362`)
maps `classifyDatabaseFormatFamily`'s verdict onto four states: `current` only
when the family is `current` **and** an incarnation id is readable (`:340-342`),
`pristine` at `:343`, and **everything else** to `unsupported` (`:344-349`).
`classifyDatabaseFormatFamily` returns `malformed-marker` first (`storage-
format-epoch.ts:292-294`) and pushes an epoch-mismatch reason at `:313-317`
without comparing direction, ending at `:344` with `unsupported`. Reset's
`ResettableFamilyState` is `unsupported | corrupt` (`doctor-reset-db.ts:381-385`),
so both a newer epoch and an unreadable marker are resettable.

**O2. `readDirectFormatMarker` has eight routes to `malformed`.** Unreadable
table, zero rows, more than one row, epoch not a safe integer or below 1,
invalid incarnation id, non-hex manifest digest, invalid creation time, digest
mismatch (`storage-format-epoch.ts:190-234`). A newer binary that changes
`FORMAT_MARKER_DIGEST_PROTOCOL` (`:50`) or adds a marker column takes the digest
route. Both that route and a clean `format_epoch = 2` land in O1's resettable
set.

**O3. Reset's interruption safety is real and it is the best-built thing here.**
The marker is published before the final holder inspection (`doctor-reset-db.ts:
629-645`), binds dev/inode of every family file (`storage-format-epoch.ts:
505-521`, `:560-583`), and `verifyResetMarkerFamily` (`:857-930`) returns a
per-role status of `at-source` / `moved` / `missing` / `mismatch` plus
`anyMoved` and `inspectionComplete`. `executeQuarantine` re-inspects holders and
re-verifies before **every** move (`doctor-reset-db.ts:292-302`) and resumes an
already-moved role at `:309-318`. Size is deliberately not compared, with the
reasoning at `storage-format-epoch.ts:838-856`; the residual inode-reuse gap is
named at `doctor-reset-db.ts:614-622` and is why the post-confirmation
reclassification exists.

**O4. Reset re-classifies twice and acts on the later reading, but the dry run
does not.** `recheckUnderExclusivity` runs after the holder inspection (`:595`)
and again after confirmation (`:623`), and `reportResetPlan` is built from the
recheck (`:601`) so the prompt text and the quarantine cannot disagree — the
guarantee stated at `:14-17` and `:433-447`. The `--dry-run` arm returns at
`:579-586`, **before** the holder inspection at `:588`, so its preview is built
from the first, racy classification taken at `:560`.

**O5. `repair-db` reaches the live swap with no prompt.** Control flows
`:541-555` (family gate) → `:557-568` (backup) → `:604-609` (`.recover`) →
`:649` (validate) → `:654-659` (re-inspect holders) → `:660-672` (chmod, rename
originals aside, install). The first and only `confirm` in the file is at
`:702-705`, reached only after the salvage arm has already failed. `printHelp`
at `:500` says "If salvage is impossible, an empty reset is offered with a
separate confirmation" — accurate about the second arm, silent about the first.

**O6. `repair-db`'s CLI wrapper validates nothing.** `runRepairDbCli`
(`:754-763`) handles `--help` and then calls `runRepairDb(options)` with the
argument array discarded. `doctor repair-db --dry-run` performs a real repair.
`runResetDbCli` (`:662-670`) throws on any unrecognised flag, so a user who
learned `--dry-run` from `reset-db` gets opposite behaviour from its sibling.
`--help` also returns `REPAIR_DB_EXIT.salvaged` (`:758-761`), an exit value
named for an outcome that did not happen.

**O7. `repair-db`'s activation has no on-disk record of a partial move.**
`activateReplacement` (`:453-475`) moves main, then `-wal`, then `-shm` aside,
then renames the replacement into place at `:467`; its `catch` reverses the
moves best-effort at `:469-474`. A process death inside the loop leaves
`context.db` absent with `context.db-wal` present and nothing describing why.
That shape classifies as `orphan-artifacts` (`database-access.ts:310-320`), so
the next `doctor reset-db` offers to abandon the orphan sidecar while the real
data sits at `${dbPath}.corrupt-original-<stamp>` unmentioned. Reset publishes a
marker for exactly this reason; repair does not.

**O8. The migration sweep's blast radius is the whole journal.**
`sweepPendingMigrations` selects every row (`migrate.ts:341-347`) and reconciles
each by phase, unlinking staged files at `:376`. It is called from
`migrate.ts:1408` for the current key's run and from `doctor.ts:79-97` on every
plain `doctor` invocation. So `doctor` for harness A can delete the staged bytes
of an interrupted migration for harness B. The `lost` arm (`:368-370`) correctly
keeps rows it cannot reconcile.

**O9. The OpenCode wizard has no write-phase rollback; the Pi wizard does.**
`setup-opencode.ts:402-403` states "A cancelled wizard can then unwind without
leaving only some target files updated." Cancellation is honoured —
`handleCancel` throws `PromptCancelledError` (`prompts.ts:91-98`) and
`dispatch.ts:163` maps it to exit 0 — and every prompt precedes `:516`, so a
Ctrl-C leaves the five targets untouched. A **failure** inside `:516-577` does
not unwind: there is no `try` around it. `setup-pi.ts:461-491` wraps its write
phase and rolls back both the plugin entry and the host config changes at
`:483-490`. `setup-omp.ts:106-131` builds a matching rollback for its two `omp
config set` calls.

**O10. `migrateConfigLocationsForCli` runs before consent in both surfaces.**
`setup-opencode.ts:313` calls it before the first prompt and checks its refusal
(`:314-319`); `doctor-opencode.ts:620` calls it before `intro()` and **discards
the result**, unlike `doctor-omp.ts:454-456` which threads the refusal into
`:463-468`. The underlying migration copies then `unlinkSync`es the legacy
source (`config/migrate-config-location.ts:472`).

**O11. Re-running a wizard cannot retract three earlier answers.**
`writeMagicContextConfig` (`setup-opencode.ts:234-302`) adds `cache_ttl` entries
when `claudeMax` is true (`:293-299`) and never removes them when it is false;
`dreamer.model` is written when the dreamer is enabled (`:266-268`) and retained
verbatim when it is disabled, because the disable arm at `:275-277` only sets
`disable`; `dreamer.tasks` is written at `:272-274` and never cleared. The
declared-idempotent path is the schedule defaults (`dreamer-setup.ts:9-15`).

**O12. Cancelling a destructive confirmation exits 0.** `RESET_DB_EXIT` reserves
`declined = 2` (`doctor-reset-db.ts:44-49`) and an explicit "no" returns it
(`:608-611`). Ctrl-C at the same prompt throws through `confirm`
(`prompts.ts:149-153`) to `dispatch.ts:163`, which returns 0. A wrapper
script cannot distinguish "quarantine complete" from "operator aborted".

**O13. The exported unsupported-format guidance has no caller.**
`formatUnsupportedFormatResetGuidance` (`database-repair-guidance.ts:5-7`) is
the only text in the tree that tells an operator to preview a reset with
`--dry-run`. A repository-wide search at `HEAD` finds exactly one occurrence:
its own definition. `formatDatabaseRepairGuidance` (`:9-15`) is used at
`doctor-opencode.ts:1272`, `:1276`, `:1314`.

**O14. The OpenCode wizard and doctor are the two 5d entry points with no
end-to-end test.** `setup-opencode.test.ts` (216 lines) never mentions
`runSetup`; `doctor-opencode.test.ts` (369 lines) never mentions `runDoctor`.
Both test exported helpers only. `setup-pi.test.ts` references `runSetup` ten
times and `doctor-pi.test.ts` references `runDoctor` fifteen. So the two
findings that are OpenCode-specific — O9's missing rollback and the exit-code
chain — sit precisely where the suite does not look. This is a coverage-shape
observation, not an adequacy verdict.

**O15. `reset-db`'s test suite covers sixteen scenarios and none of them is a
newer family.** `doctor-reset-db.test.ts:144-767` covers dry run, decline,
rename failure, per-move crash resume, sidecar replacement, holder appearing
mid-run, identity replacement after confirmation, became-current,
sidecar-first order, incarnation distinctness, looks-unsupported-before-
exclusivity, confirmation-describes-recheck, and rival marker. Searching the
file for `malformed`, `epoch`, or `newer` returns one hit, an import at `:22`.

## Candidate properties

Fourteen records. Semantics: 12 `always` (three of them stated as `always(!X)`
over a forbidden on-disk state, per METHOD.md's rule that a forbidden state with
no dedicated detection point uses `always(!X)` rather than `unreachable`), 1
`sometimes`, 1 `reachable`, and no `always-or-unreached` or `unreachable`. Types:
12 safety, 2 reachability. Reachability: 14 `default-production`, 0
`explicit-config-only`, 0 `test-only`.

### cli-a-reset-db-never-abandons-a-current-family

Type: safety
Reachability: default-production — `doctor reset-db` is dispatched at
`dispatch.ts:139-142` with no gating flag, and `printHelp` at
`doctor-reset-db.ts:542` advertises the guarantee. The state it must refuse
(a healthy `context.db`) is the state of every working install.
Status: active
Exercised: partial — `doctor-reset-db.test.ts:604-674` ("a family that only
looks unsupported before exclusivity is preserved") and `:495-537` ("refuses
when the family becomes current during the confirmation prompt") cover the two
racy arms. `:145-198` covers read-only classification. No test asserts the
first-pass refusal at `doctor-reset-db.ts:571-577` on its own.
Guarantee: No `doctor reset-db` invocation moves any byte of a `context.db`
family that classifies as the current supported direct format, at any of the
three points where the classification is taken.
Check: `always` — for every invocation, if `inspectDirectDatabaseFamilyState`
returns `state === "current"` at entry (`:560`), after the holder inspection
(`:595`), or after the confirmation (`:623`), the return code is
`RESET_DB_EXIT.refused` and the digest of `context.db`, `-wal`, `-shm`,
`-journal`, and the marker path is unchanged. `always` because a single
violation is unrecoverable data loss; the guarantee must hold on every
invocation, not merely be reachable once.
Fault/timing angle: two windows, both handled. The first classification at
`:560` can be torn by a writer checkpointing between the probe copy's
per-suffix `copyFileSync` calls (`database-access.ts:327-330`), which is why
`recheckUnderExclusivity` exists (`:433-447`). The second window is the
confirmation prompt itself, open-ended, during which another process can
upgrade the family in place; `:614-622` documents this and `:623` closes it.
Required faults and enabling state: a healthy current `context.db`, plus for the
racy arms a concurrent writer that checkpoints during the probe copy, or an
in-place family replacement while the prompt is displayed.
Confidence: high — [evidence](../evidence/cli-a-reset-db-never-abandons-a-current-family.md).
Read all three refusal sites and confirmed no `renameSync` or `mkdirSync`
executes before `:637`.
Existing check: `doctor-reset-db.test.ts:495-537` and `:604-674`, run at
`ci.yml:257`. Status `unaudited`.
Impact: abandoning a healthy database costs the user every compartment, claim,
note, and memory the install has accumulated, with no migration lane to rebuild
from (`storage-db.ts:711-712`).
Open questions:
- The `--dry-run` arm returns at `:579-586` before either recheck, so a preview
  can report `unsupported` for a family a real run would refuse as `current`.
  Is the preview meant to be a faithful rehearsal? (needs human input)

### cli-a-reset-db-abandons-a-newer-format-family

Type: safety
Reachability: default-production — reachable with two shipped binaries sharing
one `~/.local/share/cortexkit/magic-context/context.db`, the pinned-plugin
scenario `storage-db.ts:678` names explicitly. No flag, no hand-edited
database: the newer binary writes its own marker.
Status: active
Exercised: not yet — `doctor-reset-db.test.ts` has no newer-format or
malformed-marker case; the only hit for those terms in the file is an import at
`:22` (O15).
Guarantee: `doctor reset-db` never quarantines a `context.db` family whose
format marker or version lane proves a newer binary owns it, which is the action
`storage-db.ts:678` forbids.
Check: `always(!X)` — for every completed quarantine, the marker epoch recorded
in the abandoned family was not greater than this build's `DIRECT_FORMAT_EPOCH`
and its version lane was not greater than `LATEST_SUPPORTED_VERSION`.
`always(!X)`, not `unreachable`: the forbidden thing is a **state** of the
quarantined family, and there is no code point dedicated to it — the quarantine
loop at `:292-329` is the same code for legitimate and illegitimate resets.
Fault/timing angle: none. No interleaving is needed; the classification is
deterministic given the on-disk marker.
Required faults and enabling state: a `context.db` carrying either
`mc_format_marker.format_epoch = 2` with a self-consistent digest, or a marker
row a newer `FORMAT_MARKER_DIGEST_PROTOCOL` makes unverifiable
(`storage-format-epoch.ts:50`, `:231-233`). Both are constructible offline and
both arise from an ordinary version skew.
Confidence: high — [evidence](../evidence/cli-a-reset-db-abandons-a-newer-format-family.md).
Traced `classifyDatabaseFormatFamily`'s two routes (`storage-format-epoch.ts:
292-294` for malformed, `:313-317` then `:344` for a mismatched epoch) into
`database-access.ts:344-349`'s collapse to `unsupported`, into
`doctor-reset-db.ts:381-385`'s resettable set. Confirmed no site in
`doctor-reset-db.ts` reads a format epoch or compares it to
`DIRECT_FORMAT_EPOCH`.
Existing check: none. `doctor-repair-db.ts:541-555` refuses `unsupported` and
routes the user to `reset-db`, so the sibling command actively steers traffic
into this path.
Impact: the exact loss the fence was built to prevent. The newer binary's
database is abandoned by an older CLI acting on advice that the plugin's own log
line tells the user not to follow. Recovery is manual: the operator must find
`${dbPath}.mc-quarantine-<stamp>/` and rename four files back.
Open questions:
- Should `inspectDirectDatabaseFamilyState` grow a fifth state, `newer`, so
  reset can refuse it the way it refuses `current` at `:571-577`? Or should
  reset call `refuseNewerSchemaFence` directly? (needs human input)
- Part 5a's `fence-a-unclassifiable-family-must-not-get-reset-guidance` records
  the guidance half of this pair from the plugin side. Confirm the two records
  are read as one chain and not deduplicated.

### cli-a-partial-quarantine-is-detectable-and-resumable

Type: safety
Reachability: default-production — the marker is published on the live path at
`doctor-reset-db.ts:637` for every non-dry-run reset that reaches confirmation.
Status: active
Exercised: yes — `doctor-reset-db.test.ts:290-322` injects a rename failure
immediately after publication, `:323-369` crashes after each family move and
asserts idempotent resume, `:370-408` replaces a sidecar between moves and
asserts the quarantine aborts with the file preserved, and `:735-767` asserts a
rival reset's marker is never disturbed.
Guarantee: After any interruption of `doctor reset-db`, the on-disk state is
either the original family plus a marker that names every remaining file and its
destination, or a complete quarantine; and a subsequent invocation classifies
that state as `reset-pending` and resumes or refuses without moving a file whose
identity changed.
Check: `always` — after an interruption at any point between `:637` and `:362`,
`readDatabaseResetMarker` returns `present` or the quarantine directory holds
every recorded role, and `verifyResetMarkerFamily(marker)` returns a status in
`{at-source, moved}` for every recorded role with `problems` empty, or a
non-empty `problems` list naming the changed role. `always` because
recoverability must hold at every interruption point, and the marker is what
makes the state self-describing rather than merely guessable.
Fault/timing angle: the window is `:637` to `:362`, four renames plus the marker
finalisation. Each rename is atomic because source and destination are in the
same directory (`:9-11`). `verifyResetMarkerFamily` compares dev/inode only and
deliberately ignores size at both locations, with the reasoning at
`storage-format-epoch.ts:838-856`; inode reuse by an in-place replacement can
therefore pass, which `:614-622` names as the residual gap.
Required faults and enabling state: a process kill or a `renameSync` failure at
each of the five move points, against an `unsupported` or `corrupt` family. The
test suite injects both through `deps.renameFile`.
Confidence: high — [evidence](../evidence/cli-a-partial-quarantine-is-detectable-and-resumable.md).
Read the publication order, the per-move re-verification at `:292-302`, the
resume arm at `:309-318`, and the rollback-only-when-nothing-moved condition at
`:222-228`.
Existing check: `doctor-reset-db.test.ts:290-408` and `:735-767`, at
`ci.yml:257`. Status `unaudited`.
Impact: if this fails, an interrupted reset leaves a family that neither
resumes nor bootstraps, and `doctor.ts:46-51` refuses to run at all until the
marker is resolved — a wedged install with no automated way out.
Open questions:
- Does any test kill the process between the last family move at `:328` and the
  marker finalisation at `:353`? Scenario 5 covers per-role crashes; the
  marker-move step is asserted at `:341-349` by identity change, not by
  interruption. Unresolved, needs a targeted case.

### cli-a-reset-db-dry-run-changes-nothing

Type: safety
Reachability: default-production — `--dry-run` is parsed at
`doctor-reset-db.ts:673` and documented at `:544`; `database-repair-guidance.ts:6`
tells operators to preview with it.
Status: active
Exercised: partial — `doctor-reset-db.test.ts:238-269` asserts the dry run
reports family, identities, incarnation, destination, and abandonment text, and
`:238-269` runs against an unsupported family. `:520-524`'s recovery-arm dry run
has no dedicated case. No test asserts that no marker file was created.
Guarantee: A `--dry-run` invocation creates no file, moves no file, publishes no
reset marker, and does not take a database write lock, on both the fresh and the
recovery arm.
Check: `always` — after `runResetDb({dryRun: true})`, the set of directory
entries beside `context.db` is unchanged, the digest of every family file is
unchanged, `readDatabaseResetMarker` returns the same status it returned before
the call, and the return code is `RESET_DB_EXIT.ok`. `always` because a preview
that writes is worse than no preview: it is the action the operator chose in
order to avoid acting.
Fault/timing angle: none for the guarantee. One subtlety worth asserting:
`captureResetPlan` (`:397-410`) calls `allocateQuarantineDirPath`, which probes
up to 10,000 candidate paths with `lstatSync` (`:100-108`) and creates none —
`ensureQuarantineDir` is only called from `moveIntoQuarantine` (`:131`) and the
resume arm (`:311`). Both are past the dry-run return.
Required faults and enabling state: an `unsupported` or `corrupt` family for the
fresh arm; a published marker for the recovery arm. No fault injection.
Confidence: high — [evidence](../evidence/cli-a-reset-db-dry-run-changes-nothing.md).
Traced both dry-run returns (`:579-586`, `:520-524`) and confirmed the only
mutating calls in the file — `mkdirSync` (`:113`), `chmodSync` (`:122`, `:137`,
`:312`, `:352`), `renameFile` (`:136`), `rmSync` (`:236`), and
`writeDatabaseResetMarker` (`:637`) — are all downstream of them.
Existing check: `doctor-reset-db.test.ts:238-269`, at `ci.yml:257`. Status
`unaudited`.
Impact: low if it holds, high if it does not: the documented safe rehearsal for
the most destructive command in the product.
Open questions:
- The dry run previews the classification from `:560`, taken before the holder
  inspection, while a real run acts on the one from `:595`. O4 records the gap.
  Should the dry run also run the holder inspection and the recheck, at the cost
  of making a preview refuse when a holder is live? (needs human input)

### cli-a-repair-db-live-swap-requires-confirmation

Type: safety
Reachability: default-production — `doctor repair-db` is dispatched at
`dispatch.ts:135-138` and is the advice `formatDatabaseRepairGuidance` gives at
`doctor-opencode.ts:1272`, `:1276`, and `:1314`, i.e. on any `integrity_check`
failure or open failure an ordinary user hits.
Status: active
Exercised: not yet — for the property as stated. `doctor-repair-db.test.ts`
(556 lines) exercises the salvage path, but there is no test asserting that a
prompt precedes the swap, because no prompt exists to assert.
Guarantee: No `doctor repair-db` invocation replaces the live `context.db` with
a `.recover`-derived rebuild until the operator has been shown the salvage rates
and has explicitly confirmed.
Check: `always(!X)` — for every invocation in which `activateReplacement`
(`doctor-repair-db.ts:453-475`) executes on the salvage arm, a `prompts.confirm`
call resolved true earlier in the same invocation. `always(!X)` on the state
"swap happened with no prior confirmation" rather than `unreachable` on `:664`:
`:664` **must** be reachable — it is how a successful repair completes — so the
forbidden thing is the absence of consent, not the line.
Fault/timing angle: no interleaving needed; this is unconditional control flow.
A related ordering choice is worth recording: `reportSalvageRates` runs at
`:667`, **after** `activateReplacement` at `:664`. The operator learns how many
rows were lost only once the lossy database is already installed.
Required faults and enabling state: a `context.db` corrupt enough that
`.recover` succeeds and the recovered image classifies as `current`, on a host
whose `sqlite3` has `SQLITE_ENABLE_DBPAGE_VTAB`. `.recover` is lossy by
construction — `:681-685` explains that the recoveries salvaging the most rows
are the ones that fail classification — so a partial salvage that passes is the
normal case, not the edge case.
Confidence: high — [evidence](../evidence/cli-a-repair-db-live-swap-requires-confirmation.md).
Enumerated every `confirm` in the file: exactly one, at `:702-705`, on the
fresh-empty arm. Confirmed no `PromptIO` method other than `log.*`, `intro`, and
`outro` is called before `:664`.
Existing check: none for consent. `:654-659` re-inspects holders before the
swap, and `:661-662` preserves the original file mode, so the swap is careful
about everything except whether it was asked for.
Impact: a user running the command the doctor recommended silently trades a
database with N rows for one with fewer, and reads the loss figures afterward.
The originals survive at `${dbPath}.corrupt-original-<stamp>*` and
`${dbPath}.corrupt-backup-<stamp>*`, so the loss is logical, but the operator
was never given the choice.
Open questions:
- Is the missing prompt deliberate, on the theory that a corrupt database has no
  value to preserve? `printHelp:500` describes only the second arm's
  confirmation, which reads as though the first arm's absence was not noticed.
  (needs human input)
- Should `reportSalvageRates` move before `activateReplacement` so the numbers
  can inform a decision? (needs human input)

### cli-a-repair-db-rejects-unrecognised-flags

Type: safety
Reachability: default-production — `runRepairDbCli` is the only entry from
`dispatch.ts:135-138`, and `--dry-run` is a flag the sibling command documents
at `doctor-reset-db.ts:544` and the shared guidance recommends at
`database-repair-guidance.ts:6`.
Status: active
Exercised: not yet — no test passes an unknown flag to `runRepairDbCli`.
Guarantee: `doctor repair-db` fails without touching the database when given any
flag it does not implement, so no flag a user believes is a preview can trigger
a live repair.
Check: `always` — for every `args` array containing a token starting with `--`
other than `--help`, `runRepairDbCli` throws or returns a non-zero code and
`runRepairDb` is not invoked. `always` because the property is about the
argument surface, evaluated on every invocation, and one silent acceptance is
one unwanted destructive run.
Fault/timing angle: none.
Required faults and enabling state: none. `doctor repair-db --dry-run` on any
install exhibits it.
Confidence: high — [evidence](../evidence/cli-a-repair-db-rejects-unrecognised-flags.md).
`runRepairDbCli` (`:754-763`) handles `--help` then calls
`runRepairDb(options)`; `args` is never inspected again and `RunRepairDbOptions`
(`:68-73`) has no `dryRun` field. Compared against `runResetDbCli`
(`:662-670`), which throws `Unknown doctor reset-db option`.
Existing check: none. `doctor-reset-db.test.ts` does not cover its own flag
validation either, so the two commands' opposite behaviours are both unasserted.
Impact: a user who previews with `reset-db --dry-run`, is told by `repair-db` to
use `reset-db`, and then tries `repair-db --dry-run` performs a real repair,
including the unconfirmed live swap in the previous record.
Open questions:
- `runRepairDbCli` returns `REPAIR_DB_EXIT.salvaged` for `--help` (`:758-761`).
  Should `--help` have its own code, given that a caller reading exit 0 as
  "salvaged" is now wrong twice? (needs human input)

### cli-a-repair-db-activation-is-self-describing

Type: safety
Reachability: default-production — reached by every successful salvage and every
confirmed fresh-empty reset (`doctor-repair-db.ts:664`, `:732`).
Status: active
Exercised: not yet — `doctor-repair-db.test.ts` has no case that interrupts
`activateReplacement` mid-loop.
Guarantee: An interruption during `activateReplacement` leaves on-disk state
from which the next command can tell that a repair was in progress and where the
original data went.
Check: `always(!X)` — after a process death at any point inside
`doctor-repair-db.ts:460-467`, there exists a file at the `context.db` path
whose contents or a sibling artifact names `${dbPath}.corrupt-original-<stamp>`.
`always(!X)` on the state "family split with no record", because the forbidden
condition is an on-disk state and no code point is dedicated to producing it.
Fault/timing angle: the window is the three-iteration loop at `:460-465` plus
the final rename at `:467`. `DATABASE_SUFFIXES` is `["", "-wal", "-shm"]`
(`:44`), so the **main** file moves first. A death after iteration one leaves
`context.db` absent and `context.db-wal` present. The `catch` at `:469-474`
reverses moves only for an in-process throw, and guards each reversal with
`existsSync(moved.to) && !existsSync(moved.from)`, so a rollback that itself
throws propagates and leaves the split.
Required faults and enabling state: a successful `.recover` whose recovered
image classifies as `current`, plus a kill between the main-file rename and the
replacement rename. Injectable only by patching `renameSync`; unlike
`ResetDbDeps` (`doctor-reset-db.ts:53-58`), `RepairDbDeps` (`:62-66`) exposes
`now`, `sqliteExecutable`, and `inspectHolders` but **not** `renameFile`, so this
window is not currently reachable from a test without a module mock.
Confidence: high — [evidence](../evidence/cli-a-repair-db-activation-is-self-describing.md).
Read `activateReplacement` in full and confirmed no marker, journal, or log file
is written before or during the moves. Confirmed the resulting shape classifies
as `orphan-artifacts` through `database-access.ts:310-320`.
Existing check: none. Compare `doctor-reset-db.ts:629-645`, which publishes a
marker before its first move for exactly this reason, and
`migrate.ts:1477-1500`, which advances a journal phase inside the transaction
for the same reason.
Impact: the next `doctor` refuses (`orphan-artifacts` fails the pre-open gate at
`database-access.ts:128-137`), and the next `doctor reset-db` offers to
**quarantine the orphan sidecar** while presenting no path to the user's actual
data sitting at `${dbPath}.corrupt-original-<stamp>`. The data survives, but
nothing on the machine says so.
Open questions:
- Should `activateReplacement` reuse the reset marker mechanism, or write a
  simpler breadcrumb? A shared primitive already exists in
  `storage-format-epoch.ts:560-583`. (needs human input)
- Should `RepairDbDeps` expose `renameFile` so this window becomes testable, as
  `ResetDbDeps` does? Unresolved, needs a design decision.

### cli-a-migration-sweep-acts-only-on-what-its-phase-proves

Type: safety
Reachability: default-production — `sweepPendingMigrations` runs on **every**
plain `doctor` invocation (`doctor.ts:69-97`) and before every
`doctor migrate` (`migrate.ts:1408`). The `migration_pending` table is part of
the registered current schema (`storage-session-runtime-schema.ts`), so the
journal exists in every healthy install.
Status: active
Exercised: partial — `migrate.test.ts` (1,411 lines) covers the sweep's four
arms. Not covered: a sweep invoked for migration key A while a row for an
unrelated key B is present, which is the shape `doctor.ts:79-97` always
produces.
Guarantee: The sweep deletes a staged file only when its journal phase proves
the shared-database state is absent, renames a staged file into place only when
its phase proves the state committed, and never removes a row whose bytes it
cannot account for.
Check: `always` — for every row the sweep processes: if it unlinked
`row.stage_path` then `row.phase === "staged"`; if it renamed
`row.stage_path → row.final_path` then `row.phase === "db_committed"`; and if it
deleted the row then either the final file existed, or one of the two preceding
conditions held. Rows in `report.lost` still exist in the table afterward.
`always` because every row must be reconciled correctly on every sweep; the
sweep is idempotent by design (`migrate.ts:327`) and runs constantly.
Fault/timing angle: the safety of the roll-back arm rests on a claim stated at
`:373-375` and implemented at `:1194-1200`: the phase advances to
`db_committed` **inside** the same transaction that writes the shared state, so
`phase === "staged"` proves absence. That is the invariant to attack — any code
path that writes the state and advances the phase in two transactions breaks the
roll-back arm into data loss.
Required faults and enabling state: journal rows in each phase with each
combination of stage-file and final-file presence. `migrate.test.ts` constructs
these directly; no process kill is needed because the journal is the record.
Confidence: high — [evidence](../evidence/cli-a-migration-sweep-acts-only-on-what-its-phase-proves.md).
Read `sweepPendingMigrations` (`:329-381`) against the commit transaction
(`:1146-1204`) and confirmed the phase advance at `:1194-1200` is inside the
`BEGIN IMMEDIATE` opened at `:1149`.
Existing check: `migrate.test.ts`, at `ci.yml:257`. Status `unaudited`.
Impact: a wrong roll-back arm unlinks the only copy of a migrated session's
bytes — the one **physically** irreversible deletion in the sub-part (see the
destructive command table).
Open questions:
- The sweep's blast radius is every row, not the current key (O8), so plain
  `doctor` can delete another harness's interrupted staged file. Is that
  intended — one shared journal, one reconciler — or should `doctor` sweep only
  rows whose `target_harness` matches an adapter it is running? (needs human
  input)
- `formatMigrationSweepLines` marks `LOST` rows as errors (`doctor.ts:83`), but
  nothing bounds how long a `lost` row stays in the table. Unresolved, needs a
  retention decision.

### cli-a-wizard-never-changes-harness-behaviour-unprompted

Type: safety
Reachability: default-production — `setup` is the documented first command
(`dispatch.ts:73`), and `setup-opencode.ts:517-522` and `:555` are unconditional
on the non-dry-run path with `compactionEnabled` resolved from config
(`:45-57`), which returns true for the default configuration.
Status: active
Exercised: partial — `setup-opencode.test.ts:112-171` covers the compaction
writer's two modes directly, and `:172-215` covers byte preservation. Nothing
covers whether the user was asked, because the flow function is untested (O14).
Guarantee: A setup wizard does not change a behaviour the harness already owns
without an explicit prompt naming that change.
Check: `always` — for every completed `runSetup`, every key the wizard wrote
outside `magic-context.jsonc` corresponds to a `confirm` or `selectOne` the user
answered in the same invocation. `always` because consent is per-invocation; the
question is not whether the wizard can ask but whether it always does.
Fault/timing angle: none. Straight-line control flow.
Required faults and enabling state: a fresh OpenCode install with a `tui.json`
and an `opencode.jsonc` and no Magic Context config. `compactionEnabled`
resolves true unless `compaction.enabled === false`
(`agent-disable.ts:24-35`), so the default install takes the writing arm.
Confidence: high — [evidence](../evidence/cli-a-wizard-never-changes-harness-behaviour-unprompted.md).
Enumerated every `confirm` in `setup-opencode.ts` (`:227`, `:329-332`,
`:426-429`, `:449`, `:459`, `:474`, `:505`) and matched them against every write
in `:516-577`. Two writes have no matching prompt:
`compaction:{auto:false,prune:false}` into `opencode.jsonc` (`:517-522` via
`:148`, `:152-158`) and the TUI sidebar plugin into `tui.json` (`:555`).
Compared against `setup-omp.ts:64-73`, which confirms the equivalent
`compaction.enabled` change and **aborts** when declined.
Existing check: `setup-opencode.test.ts:112-171` asserts the write happens in
mode-on and does not happen in mode-off. No check asserts a prompt. Status
`unaudited`.
Impact: the wizard disables the harness's own context manager. The reasoning is
sound and is printed after the fact (`:526-529`), but a user who declines every
other conflict prompt still loses native compaction, and the same product asks
for permission on OMP. The TUI plugin injection is lower stakes and equally
silent.
Open questions:
- Is the compaction write treated as constitutive of installing Magic Context
  rather than as a conflict fix, so no prompt applies? If so, why does OMP ask?
  (needs human input)

### cli-a-interrupted-opencode-wizard-leaves-no-half-configured-install

Type: reachability
Reachability: default-production — the write phase at `setup-opencode.ts:516-577`
runs on every non-dry-run `setup` for OpenCode; any I/O error inside it produces
the state.
Status: active
Exercised: not yet — `setup-opencode.test.ts` never calls `runSetup` (O14), so
no test reaches the write phase as a sequence.
Guarantee: A `setup` run that does not complete leaves either no change or a
configuration in which every subsystem the user declined is off and every
subsystem the user enabled is configured — never a registered plugin with no
Magic Context config.
Check: `reachable` — a test must execute the state in which
`addPluginToOpenCodeConfig` (`:517`) has committed and
`writeMagicContextConfig` (`:545`) has not, and then assert what the plugin
loader makes of it. This is location-and-path coverage of the partial-write
window; `reachable` rather than `sometimes` because the interesting thing is
that the window can be entered at all, and no test enters it today.
Fault/timing angle: the window spans `:517` to `:555`, four separate atomic
writes with no enclosing transaction and no `try`. `writeMagicContextConfig`
throws by design when the target is malformed (`:248` calls
`readJsoncConfigForUpdate`), and the precheck at `:378-382` runs before the
prompts, so a file that becomes malformed while the wizard is open lands
squarely in the window. The exception propagates through `setup.ts:47` to
`dispatch.ts:159-165`, which rethrows anything that is not a cancelled prompt.
Required faults and enabling state: a `magic-context.jsonc` that becomes
unparseable, or ENOSPC, or a kill, between `:523` and `:545`.
Confidence: high — [evidence](../evidence/cli-a-interrupted-opencode-wizard-leaves-no-half-configured-install.md).
Confirmed there is no `try` around `:516-577` and no rollback, and that
`setup-pi.ts:461-491` implements exactly the rollback this path lacks.
Existing check: none.
Impact: this reopens a question Part 4a closed. Part 4a resolved that a
completed setup cannot omit a historian model, because `pickModel` rejects empty
input (`model-picker.ts:85`) and both setup paths always write one
(`setup-opencode.ts:256-260`, `setup-pi.ts:242-246`). An **interrupted** setup
writes none, so the historian falls back to its chain — which
`setup-opencode.ts:585` already names as a legitimate state. The subsystem
directions are safe: `agent-disable.ts:11-13` requires the `dreamer` block to
exist, so a missing config leaves the dreamer **off** even if the user answered
yes, and sidekick likewise. The dangerous half is that native compaction is
already disabled in `opencode.jsonc` while the replacement is unconfigured.
Open questions:
- Should `runSetup` in `setup-opencode.ts` adopt the `setup-pi.ts:461-491`
  rollback, or should the write order be inverted so `magic-context.jsonc`
  lands before the plugin registration? (needs human input)
- Is "historian falls back to the chain" acceptable for an interrupted setup, or
  should Part 4a's reachability label be revisited for that case? Cite Part 4a;
  do not re-derive.

### cli-a-wizard-rerun-reflects-only-the-latest-answers

Type: safety
Reachability: default-production — re-running `setup` is the documented remedy
after a configuration change, and `setup-opencode.ts:370-373` computes
`hadExistingSetup` precisely to handle it.
Status: active
Exercised: partial — `setup-opencode.test.ts:65-92` covers merging a valid
existing config through `addPluginToOpenCodeConfig`.
`writeMagicContextConfig` appears once in the file, at `:32`, inside the
malformed-config case. No test re-runs it with flipped answers.
Guarantee: Running the wizard twice with different answers yields the
configuration the second run's answers describe, with no residue from the first.
Check: `always` — for any pair of answer sets A then B,
`writeMagicContextConfig(path, B)` applied after
`writeMagicContextConfig(path, A)` produces the same file as
`writeMagicContextConfig(path, B)` applied to the pre-A file. `always` because
the property is a per-invocation equivalence, and `always-or-unreached` would be
wrong: the re-run path is reached by design, not optionally.
Fault/timing angle: none.
Required faults and enabling state: none. Answer yes to Claude Max then no; or
enable the dreamer with a model then disable it.
Confidence: high — [evidence](../evidence/cli-a-wizard-rerun-reflects-only-the-latest-answers.md).
Read `writeMagicContextConfig` (`:234-302`) key by key. Three keys are
write-only: `cache_ttl` entries added at `:293-299` with no removal arm;
`dreamer.model` written at `:266-268` and retained by the disable arm at
`:275-277`, which sets only `disable`; `dreamer.tasks` written at `:272-274` and
never cleared. `sidekick.model` behaves the same way (`:284-286` versus
`:288-291`). By contrast `delete dreamer.enabled` (`:263`) and
`delete sidekick.enabled` (`:281`) are unconditional, so those two keys **are**
idempotent, and `agent-disable.ts:11-17` confirms nothing reads them.
Existing check: none for the re-run equivalence. Status `unaudited`.
Impact: bounded but real. A user who answers Claude Max yes and later no keeps a
59-minute cache TTL for two Anthropic models, which changes when context
operations run. A user who disables the dreamer keeps `dreamer.model` and
`dreamer.tasks` in the file, so the config reads as though the dreamer were
configured while `disable: true` silences it — the exact confusion
`checkUserMemoriesDreamerCompatibility` (`doctor-opencode.ts:160-175`) was
written to warn about for one task.
Open questions:
- Is retaining `dreamer.model` under `disable: true` deliberate, so re-enabling
  restores the prior model? If so, the same argument does not obviously cover
  `cache_ttl`. (needs human input)
- `setup-pi.ts:268-278` deliberately clears `model`/`endpoint`/`api_key` when the
  user picks local embeddings, with the rationale at `:268-270`. Should the
  OpenCode writer adopt that pattern for `cache_ttl`?

### cli-a-opencode-doctor-exit-code-reflects-unresolved-failures

Type: safety
Reachability: default-production — `magic-context doctor` with no flags is the
command every install runs (`dispatch.ts:75`), and `doctor.ts:110-114` dispatches
to `runOpenCodeDoctor` for an OpenCode install. Both counters move on ordinary
inputs: `fixed` increments on any deprecated config key (`:767-985`), `issues`
on any failed check.
Status: active
Exercised: not yet — `doctor-opencode.test.ts` never calls `runDoctor` (O14).
Guarantee: `doctor` exits non-zero whenever it reported a failure it did not
resolve.
Check: `always` — for every `runDoctor` return, if `failCount > 0` after the
final check then the return value is 1. `always` because the exit code is a
machine contract read once per invocation; a single wrong 0 is a green build over
a broken install.
Fault/timing angle: none. The defect is in a four-arm conditional at
`:1430-1441`.
Required faults and enabling state: one auto-fixable condition and one unfixable
condition present together. Both are ordinary: a legacy
`experimental.compaction_markers` or `dreamer.enabled` key supplies the fix
(`:767-985`, `:98-150`), and a missing plugin entry, a failed `integrity_check`,
or an unreachable embedding endpoint supplies the failure.
Confidence: high — [evidence](../evidence/cli-a-opencode-doctor-exit-code-reflects-unresolved-failures.md).
Read `:1430-1441`. The `issues > 0 && fixed > 0` arm at `:1432-1433` prints
"Found N issue(s), fixed M" and falls through to `return 0` at `:1441`; only the
final `else` at `:1436-1438` returns 1. Verified the two sibling doctors get it
right: `doctor-pi.ts:1085` is `return first.fail > 0 ? 1 : 0` and `:1081` is the
post-repair equivalent; `doctor-omp.ts:461` is
`return first.fail === 0 ? 0 : 1` and `:474` the post-repair equivalent. Both
siblings also re-run their checks after repairing (`doctor-pi.ts:1061-1081`,
`doctor-omp.ts:470-474`); the OpenCode doctor does not.
Existing check: none. `doctor-pi.test.ts` and `doctor-omp.test.ts` both drive
`runDoctor`; the OpenCode file drives only helpers.
Impact: `magic-context doctor && start-my-harness` succeeds against an install
with five unresolved failures because one deprecated key was cleaned. The
`Summary: PASS / WARN / FAIL` line at `:1429` is correct; the exit code
contradicts it.
Open questions:
- Should the OpenCode doctor adopt the sibling shape — re-run checks after fixes
  and derive the code from the second pass — or is the intent that "we changed
  something, restart and re-run" is not a failure? The message at `:1433` reads
  like the latter, and the two siblings disagree. (needs human input)

### cli-a-doctor-never-passes-a-database-the-plugin-refuses

Type: safety
Reachability: default-production — every doctor opens `context.db` read-only
(`doctor-opencode.ts:1252`, `doctor-pi.ts:597-601`), and the state it must catch
is the shared-database version skew `storage-db.ts:678` describes.
Status: active
Exercised: partial — the version-lane half is covered:
`storage-versions.ts:33-58` has both alarm arms, and
`doctor-opencode.ts:1305-1311` maps `UnsupportedSchemaVersionError` to `fail`.
The epoch half has no probe and therefore no test.
Guarantee: If the plugin's storage fence would refuse `context.db`, doctor
reports a failure rather than a pass.
Check: `always` — for every doctor run against a `context.db` for which
`refuseNewerSchemaFence` (`storage-db.ts:651-681`) would return true or
`classifyDatabaseFormatFamily` would return a family other than `current`,
`failCount > 0` and no `pass("Opened the shared DB with a supported schema")` is
emitted. `always` because a health verdict must be sound on every run; a
false pass is the dangerous direction named in the task framing.
Fault/timing angle: none. The gap is a static one: `openExistingContextDatabase`
branches on `options.readonly` and skips both the pre-open artifact gate
(`database-access.ts:122-138`) and the family classification (`:143-153`) when
read-only, leaving only the version check at `:154-161`.
`checkStorageVersionFence` compares nothing but the version lane
(`storage-versions.ts:38-53`).
Required faults and enabling state: a `context.db` whose
`mc_format_marker.format_epoch` is 2 with a self-consistent digest and whose
`schema_migrations` maximum below 10,000 is 90. Constructible offline; produced
in the field by a newer binary that bumps the epoch without the lane.
Confidence: high — [evidence](../evidence/cli-a-doctor-never-passes-a-database-the-plugin-refuses.md).
Traced the read-only open path and confirmed no epoch comparison exists anywhere
in `packages/cli/src`. The plugin's own comment at `storage-db.ts:663-666` calls
the epoch "the signal that actually distinguishes a database this build is too
old to read from one it must refuse", and doctor never reads it.
Existing check: `doctor-pi.test.ts` covers the version-lane fence lines. Nothing
covers the epoch. Status `unaudited`.
Impact: the operator asks the diagnostic tool whether the install is healthy and
is told yes, including the reassuring line "Format fence: context.db and this
build are both v90", while the plugin is refusing every open and logging
`storage fatal`. Part 5a's
`fence-a-refusal-is-a-null-return-not-a-throw` records that a refusal surfaces
as a silent `null`, so there is no user-visible crash to contradict the doctor.
Open questions:
- Should the read-only open run the family classification? The comment at
  `database-access.ts:123-127` explains why the **write** path avoids a
  whole-family temp copy, not why the read path skips classification entirely.
  (needs human input)
- Should `StorageVersions` grow a `context_db_format_epoch` field so the
  `storage_versions` block it mirrors carries the deciding signal? Unresolved,
  needs a schema decision on the status envelope.

### cli-a-doctor-fixes-and-fails-in-the-same-pass

Type: reachability
Reachability: default-production — both preconditions arise from ordinary
installs, as detailed below.
Status: active
Exercised: not yet — no test drives `runDoctor` for the OpenCode harness (O14).
Guarantee: A campaign observes at least one doctor run that both applied a fix
and left a failure unresolved, so the exit-code arm at
`doctor-opencode.ts:1432-1433` is exercised against real state rather than
reasoned about.
Check: `sometimes` — at least once per campaign, a `runDoctor` invocation
satisfies both independent preconditions: (a) the config contained at least one
key the deprecated-key migration rewrites, so `writeFileAtomic` at
`doctor-opencode.ts:979-981` executed; and (b) at least one check reached `fail`
for a condition the run does not repair. `sometimes`, not `reachable`: the arm's
**lines** are trivially coverable by setting two counters, but the operational
state that makes the arm wrong is "a real install that was partly repaired and
is still broken", and that is situation coverage. Per METHOD.md's coverage rule
this asserts the two independent preconditions, never the wrong exit code, so it
still fires on a corrected implementation.
Fault/timing angle: none. The two preconditions are independent by construction:
(a) is a property of the config file, (b) of the environment.
Required faults and enabling state: (a) a `magic-context.jsonc` containing
`experimental.compaction_markers`, top-level `compaction_markers`,
`dreamer.enabled`, `sidekick.enabled`, `historian.enabled`, or a legacy v1
dreamer shape — every one of which is a config an earlier release wrote, so an
upgrading user supplies it without doing anything. (b) any of: no plugin entry in
`opencode.jsonc`, a failing `PRAGMA integrity_check`, an unreachable embedding
endpoint, a broken `onnxruntime-node` under the default local provider
(`:406-422`), or a `context.db` newer than this CLI.
Confidence: high — [evidence](../evidence/cli-a-doctor-fixes-and-fails-in-the-same-pass.md).
Confirmed `fixed++` sites in the deprecated-key block and that `fail()` at
`:643-647` increments both `failCount` and `issues`, so the arm condition
`issues > 0 && fixed > 0` is satisfied by any (a)-and-(b) pair.
Existing check: none.
Impact: without this record the exit-code defect is a code-reading finding.
With it, the campaign has to produce the state, which also produces the evidence
that the state is common rather than contrived.
Open questions:
- Which (a) key should the fixture use? `dreamer.enabled=false` is the most
  likely in the field and is the only one whose migration emits a `log.warn`
  rather than `log.success` (`:126-131`), so it doubles as a warning-path case.
  Unresolved, needs a fixture decision.

## Contract-vs-code leads

**L1. The fence says do not reset; reset resets.** `storage-db.ts:678` ends the
newer-schema refusal with "Do not reset this database: a newer binary owns it",
and `:663-666` explains why. `doctor-reset-db.ts:381-385` makes every
non-`current`, non-`pristine`, non-`reset-pending` family resettable, and
nothing in the file reads a format epoch. Both sides cited; not resolved here.
Record: `cli-a-reset-db-abandons-a-newer-format-family`.

**L2. `migrate-session --yes` does nothing at the gate it names.**
`migrate-session.ts:447` prints "--yes Skip the 'OpenCode stopped?'
confirmation". `skipConfirm` is bound at `:463` and read only at `:576-581`, for
the unrelated git-versus-global warning. The "OpenCode stopped?" prompt at
`:605-608` is unguarded. The code is the safer of the two; the help text is
wrong. No record: the divergence is a documentation defect with no unsafe
direction, and the safe behaviour is already asserted implicitly by the absence
of a bypass.

**L3. `migrate` promises a schema upgrade that cannot happen.**
`migrate.ts:1404-1406` throws "context.db has no migration_pending journal
(shared schema older than v78). Run a harness session once so the plugin can
upgrade the schema, then retry doctor migrate."
`storage-db.ts:711-712` states "There is no migration lane: old databases are
refused, never migrated", and `LATEST_SUPPORTED_VERSION` is 90
(`storage-db.ts:98`, `migrations.ts:4-6`). A database old enough to lack the
journal is a database the plugin refuses, so the remedy is impossible and the
version in the message predates the fence by twelve.

**L4. The only guidance mentioning `--dry-run` has no caller.**
`formatUnsupportedFormatResetGuidance` (`database-repair-guidance.ts:5-7`) is
the sole text telling an operator to preview a reset. A repository-wide search
at `HEAD` returns one occurrence, its own definition. Meanwhile every live
guidance string — `storage-db.ts:701`, `:747`,
`storage-versions.ts:46-53`, `doctor-repair-db.ts:350`, `:364`, `:551` — names
`doctor reset-db` with no `--dry-run`. So the product recommends the destructive
command more often than it recommends previewing it.

**L5. `repair-db --help` reports success as "salvaged".**
`doctor-repair-db.ts:758-761` returns `REPAIR_DB_EXIT.salvaged`, whose declared
meaning at `:46-51` is that a database was repaired. Same shape at
`doctor-reset-db.ts:653-656`, which returns `RESET_DB_EXIT.ok` for `--help`;
`ok` is a weaker claim, so only the repair case is misleading.

**L6. The cancelled-wizard claim is narrower than it reads.**
`setup-opencode.ts:402-403`: "Collect every interactive choice before applying
setup writes. A cancelled wizard can then unwind without leaving only some
target files updated." True for cancellation, because `prompts.ts:91-98` throws
and every prompt precedes `:516`. Not true for a failure inside `:516-577`,
which has no `try`. `setup-pi.ts:461-491` implements the stronger property the
comment describes. Record:
`cli-a-interrupted-opencode-wizard-leaves-no-half-configured-install`.

**L7. `setup` and `doctor` migrate config locations before consent, and the
OpenCode doctor ignores the refusal.** `setup-opencode.ts:313` runs the
migration before the first prompt but checks its refusal at `:314-319`.
`doctor-opencode.ts:620` runs it and discards the return value.
`doctor-omp.ts:454-456` captures the refusal and uses it at `:463-468`;
`doctor-pi.ts:1044` threads the warnings into its checks. The migration copies
then `unlinkSync`es the legacy source (`config/migrate-config-location.ts:472`),
so the OpenCode doctor performs an unlinking file migration and cannot report
that it was refused. Not a record: the mechanism lives outside 5d's footprint.
Flagged for the synthesis pass.

**L8. Cancelling a destructive prompt is indistinguishable from success.**
`RESET_DB_EXIT.declined` is 2 (`doctor-reset-db.ts:44-49`) and an explicit "no"
returns it (`:608-611`). Ctrl-C at the same prompt reaches
`dispatch.ts:163`, which returns 0. `REPAIR_DB_EXIT.unsalvageable` is 2 and
has the same hole at `doctor-repair-db.ts:706-710`. Both sides cited: the exit
tables are deliberate and the cancellation mapping at `dispatch.ts:159-165` is
also deliberate, with a comment explaining why `return await` matters. They were
not designed against each other. Not a record; a design question.

## Open questions

1. **The Part 2a follow-up cannot be answered from 5d.** Part 2a's
   `an-observed-wedge-cause-reaches-the-operator` records that the CLI forwards
   one of thirteen distinguishable wedge reasons and collapses the rest, and
   that a probe error collapses to the same output. That CLI is
   `packages/cli/src/commands/daemon.ts`, which the scope map excludes from 5d
   as actively moving. A repository-wide search for `wedge` in
   `packages/cli/src` at `HEAD` returns four hits, all in
   `daemon.test.ts` (`:96`, `:111`, `:152`, `:166`), and `:166` asserts
   `"Daemon status: wedged (native_probe_unavailable)"` — a single parenthesised
   reason, consistent with Part 2a's finding. No in-scope 5d file reads the
   lifecycle probe. So the collapse is **not** established or refuted here; it
   needs a `daemon.ts` pass once that file settles. What an operator can
   diagnose from in-scope material is separately answered by
   `cli-a-doctor-never-passes-a-database-the-plugin-refuses`: for storage, less
   than the doctor claims.
2. **Should `doctor-merge-identity.ts`, `doctor.ts`, `doctor-authority.ts`, and
   `doctor-opencode-cache.ts` join 5d?** They hold 663 lines, a destructive
   command, the migration-sweep call site, and two cache deletions. Their
   omission is why the destructive command table has rows whose primary file is
   out of scope. (needs human input)
3. **Is quarantine "destruction"?** `doctor-reset-db.ts:2-3` says reset abandons
   a family "without migrating, salvaging, or deleting data", and `:76-77`
   promises retention. The prompt at `:606` says "All of its logical data will be
   lost to the application." Both are accurate at different layers, and the
   records above use "logical" for it. Confirm the synthesis pass keeps that
   distinction; collapsing it would make the reset records read as worse than
   they are and the repair records as better.
4. **Nothing in the tree ever deletes a quarantine directory.** Reset creates
   `${dbPath}.mc-quarantine-<stamp>/` and `allocateQuarantineDirPath`
   (`:100-108`) will allocate up to 10,000 suffixed siblings. Repeated resets
   accumulate full database copies in the storage directory with no retention
   policy and no doctor check reporting their size. Unresolved, needs a retention
   decision.
5. **Cross-database session move partial completion is undetectable.**
   `migrate-session.ts:295-299` states the compensation intent and `:328-347`
   implements it, but the compensation swallows its own failures and there is no
   journal, so a kill between the `opencode.db` commit at `:319` and the
   `context.db` commit at `:384` leaves the two databases inconsistent with no
   on-disk record. Mitigated by the mandatory pre-run snapshots at `:617-627`.
   Not promoted to a record to stay inside the 14-record budget; queued as a gap
   for the synthesis pass, which should weigh it against
   `cli-a-repair-db-activation-is-self-describing` since both are
   "partial destruction is detectable" instances.
6. **Does any 5d command need an effect-accounting bound?** METHOD.md's
   attempted-versus-acknowledged rule applies where a response can be lost. The
   destructive commands here are local and synchronous, so the only candidate is
   `migrate-session`'s two-database sequence, where the acknowledged count is
   the `opencode.db` commit and the attempted count includes the `context.db`
   transaction. Per-session-identity checks are the primary oracle there, not
   aggregate row totals. Recorded so the fault-map pass does not have to
   re-derive it.
