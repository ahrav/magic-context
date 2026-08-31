# Lens B: claimed guarantees and existing checks for the CLI surface

Sub-part 5d, lens B. Attention focus: what the CLI *promises* and what
mechanically *checks* it. Two jobs. Job 1 mines every checkable guarantee from
`--help` text, command descriptions, doc comments, error and remediation
strings, and the `README`. Job 2 inventories the checks, with the destructive
operations and the wizard writes as the two tables that matter.

Provenance: `/local/home/ahrav/scratch/magic-context`, `HEAD` = `e447c927`.
Method contract in [../../METHOD.md](../../METHOD.md). Scope and CI reality from
[../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:568-604](../../part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md)
and `:290-370`. Format modelled on
[../../part-5a-storage/existing-checks.md](../../part-5a-storage/existing-checks.md).
Sibling: [lens-a-cli-and-destructive.md](lens-a-cli-and-destructive.md).

Every line reference below was read back at `HEAD`. Where this lens ran a
command rather than read a file, it says so; three findings rest on observed
test output rather than on a reading, and they are marked.

## Claims register

Twenty claims, capped by consequence. Status is one of **holds** (code
implements the claim on the path the claim covers), **narrower than it reads**
(the claim is true on one path and false on another the reader would include),
**contradicted** (code does the opposite on the claim's own path), or **no
implementing code** (nothing in the tree implements the promise).

Source class: `help` is `--help` or `usageText()` output, `desc` is a one-line
command description a user sees without asking for help, `doc` is a doc comment
or in-code comment, `err` is an error or remediation string, `readme` is
`README.md`.

| # | Source | Claim | Status |
| --- | --- | --- | --- |
| C1 | doc `doctor-opencode.ts:1250-1251` | "The schema compatibility check runs before integrity checks so a newer schema can never be reported healthy by an older CLI." | **Contradicted.** The open at `:1252` passes `{readonly:true}`, and `database-access.ts:143-153` skips the whole family classification for a read-only open. Only the version lane at `:154-161` runs. A database whose marker carries a newer `format_epoch` while its version lane equals this build's fence reaches `pass("Opened the shared DB with a supported schema")` at `:1257`, while `storage-db.ts:669` refuses that same database on the epoch arm |
| C2 | doc `database-access.ts:113-116` | "Applies the shared schema fence immediately after opening context.db. No query or migration write may run until this check accepts the persisted version." | **Narrower than it reads.** "The shared schema fence" is a two-arm condition at `storage-db.ts:669`; the read-only path applies one arm. The write path applies both (`:122-138` pre-open, `:143-153` classification, `:154-161` version). The doc comment does not distinguish them |
| C3 | help `migrate-session.ts:447` | "--yes Skip the 'OpenCode stopped?' confirmation" | **Contradicted, in both directions.** `skipConfirm` is bound at `:463` and read at exactly one site, `:576`. The "OpenCode stopped?" prompt at `:605-608` is unguarded, so `--yes` does not do what the help says. It *does* silently bypass a different prompt the help never mentions: the git-target-resolves-to-`global` confirmation at `:579-582`, whose decline path returns 1 at `:583-586`. So the flag is inert where advertised and active where undocumented |
| C4 | help `doctor-reset-db.ts:542`, doc `:2-3` | "Reset never migrates or salvages data and never touches a supported database." | **Narrower than it reads.** Holds for a family that classifies `current`. A family whose only defect is a newer marker epoch classifies `unsupported` at `database-access.ts:344-349`, because `:340-342` requires `family === "current"` and nothing types the direction of an epoch mismatch. `ResettableFamilyState` at `doctor-reset-db.ts:381-385` admits `unsupported`. "Supported" silently means "supported by *this* build" |
| C5 | err `storage-db.ts:678` | "Do not reset this database: a newer binary owns it." | **Contradicted by a sibling command.** This is remediation advice that the product's own `doctor reset-db` will disregard, per C4. Both sides cited; not resolved here. Lens A's lead L1 |
| C6 | doc `doctor-reset-db.ts:14-17` | The classification the command "acts on — and reports to the operator for confirmation — is the one taken after the first holder inspection finds no live holder." | **Narrower than it reads.** Holds for the apply path: `recheckUnderExclusivity` at `:595` and again at `:623`, with `reportResetPlan` built from the recheck at `:601`. The `--dry-run` arm returns at `:579-586`, before the holder inspection at `:588`, so the preview a user is told to trust is built from the earlier, racy reading taken at `:560` |
| C7 | doc `doctor-reset-db.ts:76-77` (`RETENTION_NOTE`) | "Quarantine is logical abandonment, not secure erasure; the quarantined files are retained at that path until you delete them yourself." | **Holds**, and is load-bearing for reading every reset record as logical rather than physical loss. Nothing in the tree ever deletes a quarantine directory and no doctor check reports their size; `allocateQuarantineDirPath` (`:100-108`) will allocate up to 10,000 siblings |
| C8 | help `doctor-repair-db.ts:499-501` | "If salvage is impossible, an empty reset is offered with a separate confirmation." | **Narrower than it reads.** Accurate for the fresh-empty arm, whose `confirm` is at `:702-705`. Silent about the salvage arm, which reaches `activateReplacement` at `:664` with no prompt at all. A reader takes "a separate confirmation" to imply the first arm had one |
| C9 | desc `dispatch.ts:63` | "doctor repair-db  Back up and salvage a corrupted shared database" | **Narrower than it reads.** True and incomplete: the command renames the live `context.db`, `-wal`, and `-shm` aside and installs a rebuilt database in their place (`doctor-repair-db.ts:453-475`, called at `:664`) without asking. The word "back up" is honest — two copies survive (`:557-568`, `:663-668`) — but nothing in the description or the help says the live file is replaced unprompted |
| C10 | help `doctor-repair-db.ts:502-504` | "Salvage needs a sqlite3 shell built with SQLITE_ENABLE_DBPAGE_VTAB; without one, the command backs up and stops without modifying the database." | **Holds.** `defaultSqliteExecutable()` (`:113-115`) resolves `MAGIC_CONTEXT_SQLITE3` or bare `sqlite3`, and `migrateAndCheckRecoveredDatabase` refuses at `:344-351` and `:359-366`. This is also the capability that makes the only real-destruction test for this command conditional; see the destructive table |
| C11 | desc `dispatch.ts:64` | "doctor reset-db  Abandon an unsupported database family (--dry-run/--yes)" | **Holds** as a flag contract. `printHelp` at `doctor-reset-db.ts:539-546` documents all three flags and `runResetDbCli` (`:662-670`) throws on an unrecognised one. Contrast `runRepairDbCli` (`doctor-repair-db.ts:754-763`), which accepts any flag and discards it, so `doctor repair-db --dry-run` performs a real repair |
| C12 | desc `dispatch.ts:62` | "doctor merge-identity  Merge project rows (--from ID --to ID [--dry-run] [--yes])" | **Holds.** `doctor-merge-identity.ts:84-89` refuses without `--yes` and returns 2 with a remediation string naming both alternatives |
| C13 | out `doctor-merge-identity.ts:68` | Dry run prints "no database writes performed" | **Narrower than it reads**, by the repository's own standard. The dry run opens the real path read-only (`:77`), and `doctor-repair-db.ts:124-125` states as a design fact that "A read-only SQLite open can rewrite an existing SHM file, so the probe runs against a private scratch copy of the family." `database-access.ts:322-330` and `doctor-repair-db.ts:131-136` both take that scratch copy; merge-identity's dry run does not |
| C14 | desc `dispatch.ts:45` | "doctor  Check and fix configuration issues" | **Narrower than it reads.** Plain `doctor` physically unlinks staged migration files: `doctor.ts:81` calls `sweepPendingMigrations`, which for a `phase='staged'` row runs `fs.unlinkSync(row.stage_path)` at `migrate.ts:376`. The only place this is disclosed to a user is `doctor migrate --help` (`migrate.ts:1594-1598`); neither `usageText()` nor the README mentions it, and `doctor` has no `--dry-run` |
| C15 | doc `doctor.ts:37-45` | A published reset marker "promises that initialization stays blocked until the reset is completed or rolled back", so `doctor` must "stop before any database is opened" | **Holds.** The marker check at `:46-51` precedes the sweep open at `:73` and the adapter loop at `:100`, and returns 1. The comment also states why warning-and-continuing broke the promise, which makes the ordering a claim rather than an accident |
| C16 | doc `doctor.ts:64-68` | The sweep "runs exactly once per doctor invocation" because the journal "lives in the SHARED cortexkit DB (harness-agnostic)" | **Holds**, and it documents the cross-harness blast radius as deliberate: `doctor --harness opencode` reconciles an interrupted Pi migration. Lens A's O8 reads this as a surprise; the comment shows it is intended. Two guards narrow it further: `:73` opens through `openExistingContextDatabaseForMutation`, so the full family classification at `database-access.ts:143-153` runs and a refused family is skipped silently at `:74-78`. The sweep cannot unlink anything on a database this build refuses |
| C17 | doc `setup-opencode.ts:38-43`, `doctor-opencode.ts:70-75` | On config-load failure the writer "returns `false` so the writer/fixer skip any native compaction write/flip (never assuming either mode)", and this is "distinct from the boot/TUI path, which fails toward mode-on" | **Holds** as written (`setup-opencode.ts:45-57`, `doctor-opencode.ts:76-91`), with **no implementing check**. No test in `packages/cli` reaches either `catch` arm; see the wizard-content table |
| C18 | readme `README.md:72`, `:74`, `:83`, `:119` | "The wizard ... adds the plugin, disables built-in compaction"; "Setup turns it off"; and the manual-setup block shows `"compaction": {"auto": false, "prune": false}` verbatim | **Holds.** The unprompted write at `setup-opencode.ts:517-522` is the documented contract, and it is gated: `resolveCompactionEnabledForWriter` (`:45-57`) reads the user's own `compaction.enabled` through the shared accessor `isCompactionEnabled` (`plugin/src/config/agent-disable.ts:31-35`), so a user who has already opted out gets the "Compaction-off mode active — leaving native compaction config untouched" branch at `:530-532`. **This corrects the sibling lens**; see the leads section |
| C19 | readme `README.md:120-121` | "OMP native compaction ... OMP setup turns it off transactionally"; "OMP automatic memory ... OMP setup sets it to `off`" | **Narrower than it reads**, in the safe direction. Both changes are prompted, and declining **aborts** the wizard: `setup-omp.ts:64-74` for compaction and `:75-87` for the memory backend, each returning `false`. "Transactionally" is accurate — `:107-133` applies the changes with a reverse-order rollback closure |
| C20 | readme `README.md:143` | "You can watch it happen in OpenCode's TUI, where a live sidebar shows the context breakdown by source, historian status, and memory counts" | **Narrower than it reads.** The sidebar needs a plugin entry in `tui.json`, written only by `addPluginToTuiConfig` (`setup-opencode.ts:166-198`) from the wizard at `:555`. README's manual-setup section (`:78-96`) lists `opencode.jsonc` and `magic-context.jsonc` only, so a documented manual install gets no sidebar and is not told why |

**Counts.** 20 claims.

- **8 hold as written**: C7, C10, C11, C12, C15, C16, C17, C18.
- **9 are narrower than they read**: C2, C4, C6, C8, C9, C13, C14, C19, C20.
- **3 are contradicted**: C1 and C3 on their own path, and C5 by a sibling
  command rather than by its own code.
- **0 have no implementing code at all.** **1** has implementing code but no
  implementing check anywhere: C17's two config-load-failure arms.

Of the three contradicted claims, **2 are help-text or command-description
claims** contradicted by code (C3, and C5's `doctor reset-db` disregard of the
`storage-db.ts:678` remediation string); C1 is a code-comment claim. Counting
strictly the surface the task names — `--help` output and command descriptions —
the answer is **1** (C3), with two adjacent help-surface defects tabulated in the
next section.

One claim outside the register because its consequence is documentation-only but
its shape is instructive: `formatUnsupportedFormatResetGuidance`
(`database-repair-guidance.ts:5-7`) is the only string in the tree that tells an
operator to preview a reset with `--dry-run`, and a repository-wide search at
`HEAD` finds exactly one occurrence, its own definition. That is a claim with
**no calling code**, so no user ever reads it. Lens A's O13 and L4.

## Help-text claims contradicted by code

One primary case and three adjacent ones. The primary case is where the text is
`--help` output and code on that exact path does something else. The adjacent
cases are defects on the same help surface: a flag a sibling command documents
and this one silently discards, and two exit codes that report an outcome that
did not happen.

| Claim | Text | Code | Direction |
| --- | --- | --- | --- |
| C3 | `migrate-session.ts:447` advertises `--yes` for the "OpenCode stopped?" confirmation | `:605-608` is unguarded; `skipConfirm` is read only at `:576` | Code is **safer** than the text at the named gate, and **less safe** than the text at the unnamed one. A wrapper script passing `--yes` for unattended use hangs on `:605`, and an operator who reads only the help does not know `--yes` also waives the `global`-project warning |
| C11-adjacent | `dispatch.ts:64` documents `--dry-run` for `reset-db`; a user generalises to its sibling | `runRepairDbCli` (`doctor-repair-db.ts:754-763`) handles `--help`, then calls `runRepairDb(options)` with the argument array discarded, so `doctor repair-db --dry-run` performs a real repair | Code is **less safe**. `runResetDbCli` (`:662-670`) and `parseMigrateArgs` (`migrate.ts:1560`, "Unknown migrate flag") both reject unknown flags, so `repair-db` is the one outlier |
| C10-adjacent | `doctor-repair-db.ts:758-761` returns `REPAIR_DB_EXIT.salvaged` for `--help` | `:46-51` declares `salvaged` to mean a database was repaired | Reporting only. `doctor-reset-db.ts:653-655` has the same shape but returns `RESET_DB_EXIT.ok`, a weaker claim, and `:662-670` then rejects every unrecognised flag, which is the check `runRepairDbCli:754-763` lacks entirely |
| C8-adjacent | `doctor-repair-db.ts:499-501` distinguishes salvage from "an empty reset", and `:46-51` declares `salvaged: 0` against `unsalvageable: 2` | The fresh-empty arm returns `REPAIR_DB_EXIT.salvaged` at `:742`, the same code the real salvage returns at `:672`, after a prompt whose own text says it "discards all unrecovered data from the active database" (`:703`) | Reporting, but consequential for automation. A wrapper script cannot distinguish "your data was recovered" from "your data was discarded and replaced with an empty database"; both are exit 0. The human-readable outro does distinguish them (`:671` versus `:741`) |

C1 and C2 are doc-comment contradictions, not help-text ones, and are the
higher-consequence pair. They are listed in the register and elaborated below.

## Contract-vs-code leads

**M1. A code comment states the exact property the read-only open does not
have.** `doctor-opencode.ts:1250-1251` is not an inference about the doctor's
behaviour; it is the author writing down the guarantee: "a newer schema can
never be reported healthy by an older CLI." The next line opens read-only
(`:1252`), which is the mode `database-access.ts:143-153` gates the family
classification behind. Then `checkStorageVersionFence`
(`lib/storage-versions.ts`) compares the version lane and nothing else, so the
fence line printed to the operator reports agreement while the plugin's own
`storage-db.ts:669` refuses the same file. This is the sharpest
contract-versus-code pair in 5d because the contract is written in the
imperative-guarantee voice and sits two lines above the call that breaks it.
Feeds `cli-a-doctor-never-passes-a-database-the-plugin-refuses`.

**M2. Correction to the sibling lens on the OpenCode compaction write.** Lens A
(`:101`, `:51-53`) reads `setup-opencode.ts:517-522` writing
`compaction:{auto:false,prune:false}` unprompted as an asymmetry against
`setup-omp.ts:64-73`, which asks. Verified at `HEAD`, the documented contract
points the other way. The unprompted OpenCode write is stated four times in the
README (`:72`, `:74`, `:83`, `:119`), including a rationale at `:74` and a
byte-for-byte manual-setup equivalent at `:83`, and it is gated by the user's
own `compaction.enabled` through the shared accessor
(`setup-opencode.ts:45-57` → `plugin/src/config/agent-disable.ts:31-35`), with
an explicit "leaving native compaction config untouched" branch at `:530-532`.
The OMP prompt is the **undocumented** deviation: `README.md:120-121` presents
the OMP change as something setup does, not something it asks about, while
`setup-omp.ts:69-72` and `:80-85` abort the wizard on a decline. Both sides
cited. The synthesis pass should carry the corrected direction, because the
record `cli-a-wizard-never-changes-harness-behaviour-unprompted` reads
differently once the unprompted path is the documented one. The genuinely
undocumented unprompted write in this wizard is the `tui.json` plugin entry
(C20), not the compaction block.

**M3. The dry-run "no writes" claim is contradicted by the repository's own
model of a read-only open.** `doctor-repair-db.ts:124-125` and
`database-access.ts:296-306` both treat a read-only open of a live family as
mutating enough to require a private scratch copy, and the second explains at
length why the copy is opened read-write. Against that standard,
`doctor-merge-identity.ts:68`'s "no database writes performed" and
`doctor-opencode.ts:1252`'s read-only open of the live `context.db` are both
unqualified. `doctor-reset-db.test.ts:145` is titled "read-only inspection
distinguishes every family without changing bytes" and asserts it for reset,
which is the command that takes the copy. Nothing asserts it for the two that
do not.

**M4. `migrate`'s remedy is foreclosed by an import guard in the same
repository.** `migrate.ts:1404-1406` throws "context.db has no
migration_pending journal (shared schema older than v78). Run a harness session
once so the plugin can upgrade the schema, then retry doctor migrate."
`storage-db.ts:711-712` states there is no migration lane and old databases are
refused rather than migrated. This lens found the mechanical enforcement:
`packages/cli/src/lib/migration-import-guard.test.ts` scans `packages/cli/src`,
`packages/plugin/src`, and `packages/pi-plugin/src` for any `runMigrations`
import against an allow-list that is **empty**
(`ALLOWED_RUN_MIGRATIONS_IMPORTS = new Set<string>([])`), and asserts no
offenders. So the advertised remedy is not merely unlikely, it is CI-enforced
impossible on the TypeScript side, and the version in the message predates the
fence by twelve. Lens A's L3, now with the guard cited.

**M5. The OpenCode doctor computes a failure count and then does not use it.**
`doctor-opencode.ts:634` declares `failCount`, `:645-646` increments both
`failCount` and `issues` inside the `fail()` helper, and `:1429` prints
`Summary: PASS ... / WARN ... / FAIL ${failCount}`. The exit chain at
`:1430-1441` reads only `issues` and `fixed`, and the `issues > 0 && fixed > 0`
arm at `:1432-1433` falls through to `return 0` at `:1441`. Nothing subtracts a
fix from `issues`, and `fixed` is incremented at fourteen independent sites
(`:800`, `:806`, `:820`, `:827`, `:892`, `:900`, `:934`, `:964`, `:976`,
`:1068`, `:1078`, `:1114`, `:1144`, `:1197`, `:1334`). So one migrated
deprecated config key plus five failed checks prints "FAIL 5" and exits 0. The
Pi doctor derives its code from a second pass (`doctor-pi.ts:1081`, `:1085`) and
the OMP doctor does the same (`doctor-omp.ts:461`, `:474`). Feeds
`cli-a-opencode-doctor-exit-code-reflects-unresolved-failures` and
`cli-a-doctor-fixes-and-fails-in-the-same-pass`.

## Conventionally-enforced-only claims

Claims nothing mechanical checks, held only by an author following a pattern.

- **The write-phase rollback pattern.** `setup-pi.ts:461-491` wraps its write
  phase and rolls back the plugin entry and the host config at `:483-490`;
  `setup-omp.ts:107-133` builds a matching reverse-order rollback for its two
  `omp config set` calls. `setup-opencode.ts:516-577` has no `try`, and its own
  comment at `:402-403` describes the stronger property it does not implement
  for a mid-write failure. Nothing checks that a new wizard adopts the pattern.
- **The "re-check after repair" pattern.** Pi (`doctor-pi.ts:1061-1081`) and OMP
  (`doctor-omp.ts:470-474`) re-run health checks after repairing and derive the
  exit code from the second pass. OpenCode does not. No shared helper or test
  enforces the shape, which is why M5 is possible at all.
- **The scratch-copy convention for read-only classification.** M3. Two of four
  read-only inspection sites take the copy; the convention is stated in a
  comment, not in a helper that all callers must use.
- **The one-`confirm`-per-destructive-arm convention.** `reset-db` confirms at
  `doctor-reset-db.ts:603-607` with default `false`; `repair-db`'s fresh-empty
  arm confirms at `:702-705` with default `false`; `repair-db`'s salvage arm and
  the `doctor` migration sweep confirm nothing. Nothing enumerates the
  destructive entry points and asserts each has a gate.
- **Exit-code tables versus cancellation.** `RESET_DB_EXIT.declined` is 2
  (`doctor-reset-db.ts:44-49`) and an explicit no returns it (`:608-611`), while
  a Ctrl-C at the same prompt reaches `dispatch.ts:163` and returns 0.
  `REPAIR_DB_EXIT.unsalvageable` has the same hole at
  `doctor-repair-db.ts:706-710`. Both mappings are deliberate in isolation and
  no check compares them. Lens A's O12 and L8.
- **The `[dry-run] would ...` disclosure convention.** `setup-opencode.ts:308`,
  `:310-311`, `:481-482`, `:507`, `setup-omp.ts:99-103`, and
  `migrate-session.ts:592-601` all narrate what a real run would do. Nothing
  checks that the narration matches the write set, and C6 is the case where a
  preview is built from a different reading than the apply.

## Existing-check inventory

Status is `unaudited` for every entry, per METHOD.md. An existing check never
removes a property from the catalog.

### CI reality for this sub-part

Unchanged from Part 5a's finding and re-verified here. All `packages/cli` tests
run in one step:

```
.github/workflows/ci.yml:256      - name: Test
.github/workflows/ci.yml:257        run: bun run test
```

Root `package.json`'s `test` script is
`sh scripts/test-shard.sh packages/plugin && bun run --cwd packages/pi-plugin test && bun run --cwd packages/cli test && bun run --cwd packages/retina-local-fs test`.
`packages/cli`'s own `test` is a bare `bun test`, which discovers all 36
`*.test.ts` files under `packages/cli/src`. The step sits in the `check-plugin`
job (`ci.yml:225-227`, `runs-on: ubuntu-latest`). This is a reading of the
configuration; this lens cannot observe a CI run.

So the Part 5a framing holds for 5d: coverage is not the discriminator, because
every test file executes on every push. What discriminates here is *which
behaviour* the executing tests reach, which is what the next two tables are for.

### Test files and counts in scope (with CI status and workflow line refs)

Production line counts are `wc -l` at `HEAD`. Declared cases are top-level
`it(`/`test(`/`salvageIt(` declarations; **executed** cases were obtained by
running each file with `bun test` at `HEAD` on this machine, and differ from
declared where a loop expands or a conditional skip fires.

| Scope unit | Prod | Test file | Test lines | Declared | Executed | Runs in CI |
| --- | --- | --- | --- | --- | --- | --- |
| `commands/migrate.ts` | 1,694 | `migrate.test.ts` | 1,411 | 29 | 29 | Yes, `ci.yml:257` |
| `commands/doctor-opencode.ts` | 1,442 | `doctor-opencode.test.ts` | 369 | 19 | 19 | Yes |
| `commands/doctor-pi.ts` | 1,098 | `doctor-pi.test.ts` | 719 | 14 | 14 | Yes |
| `lib/diagnostics-opencode.ts` | 947 | **none found** | 0 | 0 | 0 | n/a |
| `commands/doctor-repair-db.ts` | 763 | `doctor-repair-db.test.ts` | 556 | 8 | **6 pass, 2 skip** | Yes |
| `commands/doctor-reset-db.ts` | 677 | `doctor-reset-db.test.ts` | 801 | 15 | 15 | Yes |
| `commands/migrate-session.ts` | 657 | `migrate-session.test.ts` | 558 | 17 | 20 | Yes |
| `commands/setup-opencode.ts` | 604 | `setup-opencode.test.ts` | 216 | 9 | 9 | Yes |
| `lib/diagnostics-pi.ts` | 581 | `diagnostics-pi.test.ts` | 108 | 2 | 2 | Yes |
| `commands/setup-pi.ts` | 513 | `setup-pi.test.ts` | 470 | 13 | 13 | Yes |
| `commands/doctor-omp.ts` | 475 | `doctor-omp.test.ts` | 280 | 6 | 6 | Yes |
| `lib/database-access.ts` | 362 | `database-access.test.ts` | 86 | 4 | 4 | Yes |
| `lib/migrate-dreamer-v2-doctor.ts` | 279 | `migrate-dreamer-v2-doctor.test.ts` | 158 | 10 | 10 | Yes |
| `commands/setup-omp.ts` | 152 | `setup-omp.test.ts` | 209 | 5 | 5 | Yes |
| `commands/setup.ts` | 103 | **none found** | 0 | 0 | 0 | n/a |
| `lib/dreamer-setup.ts` | 149 | `dreamer-setup.test.ts` | 118 | 4 | 4 | Yes |
| **Totals** | **10,496** | **14 files** | **6,059** | **155** | **156 pass, 2 skip** | **Yes** |

The 10,496 total confirms lens A's correction to the scope map's 9,262. The
1,234-line difference is arithmetic in the scope map, not a stale reading.

**Two in-scope units have no sibling test file.** `setup.ts` (103) is a harness
resolver and dispatcher whose two branches are each covered through the
per-harness wizards; its zero is thin rather than alarming.
`lib/diagnostics-opencode.ts` (947, 10 exports) is the largest untested unit in
5d and its zero is a gap; see the quiet areas.

Files outside the scope set whose tests bear on 5d claims, counted the same way:

| File | Test file | Test lines | Executed | Bearing |
| --- | --- | --- | --- | --- |
| `commands/doctor.ts` (211) | **none found** | 0 | 0 | The only production caller of the migration sweep (`:81`) and of `runClear` (`:34`). C14, C15, C16 all live here and none is tested |
| `commands/doctor-merge-identity.ts` (102) | `doctor-merge-identity.test.ts` | 96 | 2 | The fourth destructive command. Both cases pass `--yes` |
| `commands/doctor-authority.ts` (237) | **none found** | 0 | 0 | `doctor drain-authority`, reachable at `dispatch.ts:114-130` |
| `commands/doctor-opencode-cache.ts` (113) | via `doctor-opencode.test.ts:202-335` | — | 6 | Real `rmSync` of plugin cache roots |
| `dispatch.ts` (165) | `index.test.ts` | 219 | 6 | `usageText` (2 refs) and `dispatchCli` (6). The claim source for C9, C11, C12, C14 |
| `lib/redaction.ts` | `redaction.test.ts` | 196 | 11 | The sanitising primitives `diagnostics-opencode.ts:34` imports |
| `lib/logs-opencode.ts` | `logs-opencode.test.ts` | 522 | 41 | Imports `DiagnosticReport` as a **type only** (`:7`) |
| `lib/migration-import-guard.ts` (n/a) | `migration-import-guard.test.ts` | 44 | 1 | M4. A source scan over three packages with an empty allow-list |
| `lib/cli-hardening.test.ts` | — | 73 | 5 | Harness-override rejection, config-path selection, dev-path plugin entry matching |
| `lib/storage-versions.ts` (74) | `storage-versions.test.ts` | 111 | 6 | `checkStorageVersionFence`, the version-lane-only comparison behind C1 |

### Destructive operation versus the test that exercises it

The column that matters is the last one. **Real** means a test drives the
irreversible or file-moving action and asserts its effect on disk. **Dry**
means the test drives only the preview arm. **Refusal** means the test asserts
the command declined and left bytes unchanged, which is valuable and is not
evidence about the destructive path. **Exit-code only** means the test asserts a
return value without inspecting disk.

| Destructive operation | Primary code | Test | Kind |
| --- | --- | --- | --- |
| `reset-db` quarantine: move `-journal`, `-wal`, `-shm`, main, then marker into `${dbPath}.mc-quarantine-<stamp>/` | `doctor-reset-db.ts:292-369` | `doctor-reset-db.test.ts:323-368` (crash after each move resumes idempotently), `:538-578` (sidecar-first order, 0700/0600), `:675-733` (confirmation describes the re-checked classification), `:580-602` (fresh bootstrap needs a distinct incarnation) | **Real**, four separate cases. Each asserts `RESET_DB_EXIT.ok` and a real `.mc-quarantine-` directory (`:319`, `:355`, `:562`, `:593`, `:706`) |
| `reset-db --dry-run` | `doctor-reset-db.ts:579-586` | `doctor-reset-db.test.ts:238-268`, asserting the exact family, identities, incarnation, and destination path (`:264`) | **Dry**, correctly. Note C6: the arm under test returns before the holder inspection |
| `reset-db` decline and refusal arms | Sixteen non-`ok` returns in `doctor-reset-db.ts`: refusals at `:227`, `:233`, `:242`, `:254`, `:461`, `:478`, `:576`, `:592`; declines at `:533` and `:611`; failures at `:270`, `:504`, `:581`, `:600`, `:627`, `:643` | `doctor-reset-db.test.ts:270-288`, `:290-321`, `:370-407`, `:409-463`, `:465-493`, `:495-536`, `:604-673`, `:735-800` | **Refusal**, eight cases, several asserting no quarantine directory exists (`:490`, `:533`, `:663`) |
| `repair-db` salvage arm: rename live `context.db`/`-wal`/`-shm` to `${dbPath}.corrupt-original-<stamp>*` and install the `.recover`ed rebuild | `doctor-repair-db.ts:453-475`, called at `:664` | `doctor-repair-db.test.ts:275-352`, registered through `salvageIt` (`:252`). Asserts the installed database's integrity and row counts (`:299-330`) and that both the pre-run backup and the moved originals carry the pre-repair digest (`:332-338`) | **Real, but conditionally skipped.** `probeRecoverCapability` (`:226-249`) probes `sqlite_dbpage` at file load; when absent, `salvageIt` becomes `it.skip` and a meta-test at `:270-272` records the reason. **Observed at `HEAD` on this machine: 6 pass, 2 skip** — no `sqlite3` on `PATH`. Whether it runs on `ubuntu-latest` depends on that runner's `sqlite3` build; `ci.yml` installs none (zero `sqlite3` or `apt-get` matches in the workflow). Unresolved without a CI observation |
| `repair-db` unsalvageable arm, sources preserved | `:686-710` | `doctor-repair-db.test.ts:357-389`, also `salvageIt`. Asserts all three source digests unchanged (`:376`) and three backups taken (`:377-382`) | **Refusal**, and skipped under the same condition |
| `repair-db` fresh-empty arm: rename originals aside, install a newly composed empty schema | `prepareFreshDatabase` (`:407-447`), activation at `:728-742`, gated by `confirm` at `:702-705` | **None found.** Every `MockPrompts([true])` in the file (`:400`, `:439`, `:481`) answers a prompt on a *refusal* path. The only test reaching `:702-705` supplies `MockPrompts([false])` (`:366`) and asserts "Reset declined" (`:387`) | **Refusal only.** The confirmed destroy-and-replace arm has no test in either configuration |
| `repair-db` CLI wrapper flag handling | `runRepairDbCli` (`:754-763`) | **None found.** No test in the repository references `runRepairDbCli` | **None.** This is where C11's defect lives |
| Plain `doctor` migration sweep: `unlinkSync(row.stage_path)` for `phase='staged'`, `renameSync(stage → final)` for `phase='db_committed'`, journal row deleted in all three reconciled arms | `migrate.ts:327-380`, unlink at `:376`, rename at `:362` | `migrate.test.ts:1053-1165`, six cases covering every arm: `:1087` "staged + stage file ⇒ rolls back (stage removed, row deleted)", `:1101`, `:1112` "db_committed + stage file ⇒ rolls forward", `:1131`, `:1145` "reported lost and the row is kept", `:1159` | **Real** at the function level, all five arms |
| The sweep's invocation from plain `doctor` | `doctor.ts:69-97` | **None found.** No `doctor.test.ts` exists | **None** at the call site. So C14's surprise — that `doctor` unlinks — is untested exactly where it becomes user-visible, including the reset-marker precondition at `:46-51` (C15) and the fence-refusal skip at `:74-78` (C16) |
| `doctor migrate`: `DELETE FROM compartments` and `DELETE FROM session_facts` for the target session inside the commit transaction | `migrate.ts:1157-1164`, rationale at `:1151-1156` | `migrate.test.ts:944-1005` "replay after a post-commit crash reuses the journal identity and upserts shared state", plus `:1007-1050` and `:876-908` | **Real.** The DELETEs are a replay-idempotency device and the replay tests are the path that exercises them |
| `doctor migrate-session` apply: `UPDATE session` in `opencode.db`, then `session_projects` upsert, embedding re-stamp, and cached `m0`/`m1` clear in `context.db` | `migrate-session.ts:313-319`, `:349-384` | `migrate-session.test.ts:383-421` (session row updated, context re-stamped, cached m0/m1 cleared), `:423-442` (schema-resilient column set), `:456-477`, `:509-557`, plus `:479-492` "compensates the OpenCode move when the context.db transaction fails (no split-brain)" and `:494-505` "refuses to apply when the OpenCode session row is missing (no half-migration)" | **Real**, six cases, driven through `applyMigrateSession`. `:479-492` partially answers lens A's open question 5: the compensation *is* exercised. What is not exercised is the CLI layer above it — no test references `runMigrateSessionCli`, so the `--yes` binding (`:463`), the git/`global` prompt (`:579-582`), and the "OpenCode stopped?" gate (`:605-608`) are all untested. C3's defect sits in that untested layer |
| `doctor merge-identity`: rewrite the identity column of every project-scoped table | `doctor-merge-identity.ts:94-96` → `mergeProjectIdentities` | `doctor-merge-identity.test.ts:69-95` calls `runMergeIdentityCli` with `--yes` and asserts exit 0 and a `project_state` row for the target | **Real invocation, zero-row effect.** Observed while running the file at `HEAD`: the command prints "rows changed: 0" for every audited table. The fixture seeds no source rows, so no test drives an actual identity rewrite. `:39-67` is a refusal case asserting an unchanged file digest (`:66`). The `--yes` refusal at `:84-89` is untested — both cases pass `--yes` |
| `doctor --clear`: `rmSync(path, {recursive:true, force:true})` on selected cache directories | `doctor.ts:184-201`, picker and confirm at `:173-181` | **None found** (no `doctor.test.ts`) | **None**. Target is a regenerable npm cache |
| `doctor --force` cache arm | `doctor-opencode.ts:1320-1355` → `clearPluginCache` (`doctor-opencode-cache.ts:36`) | `doctor-opencode.test.ts:202-335`, six cases including `:279-295` "force-clears existing cache even when plugin npm latest is unavailable" and `:297-334` "reports the actually-failed root and clears the rest when one root fails" | **Real**, six cases. Regenerable cache |
| Legacy config-location migration: copy then `unlinkSync` the legacy source | `config/migrate-config-location.ts:472`, called at `setup-opencode.ts:313` and `doctor-opencode.ts:620` | **None found in `packages/cli`.** The mechanism lives in `packages/plugin`, outside 5d | **None** at either 5d call site. `setup-opencode.ts:314-319` checks the refusal; `doctor-opencode.ts:620` discards the return value, unlike `doctor-omp.ts:454-456`/`:463-468` and `doctor-pi.ts:1044` |

**Tally.** The table has fifteen rows, but three of them (`reset-db --dry-run`,
`reset-db`'s refusal arms, `repair-db`'s CLI wrapper) are not themselves
destructive and are listed because they are what the coverage consists of, and
two rows describe one operation at two sites (the sweep's function and its call
site). So **ten distinct destructive or mutating operations**:

| Operation | Real-destruction test |
| --- | --- |
| `reset-db` quarantine | **Yes**, four cases |
| `repair-db` salvage live swap | **Yes, conditionally skipped** — observed skipped at `HEAD` here |
| `repair-db` fresh-empty activation | **No** |
| Migration sweep unlink and rename | **Yes** at the function level; **no** at the `doctor.ts:81` call site |
| `doctor migrate` target-row DELETE | **Yes** |
| `migrate-session` two-database apply | **Yes**, six cases, but only below the untested CLI layer |
| `merge-identity` identity rewrite | **Invocation yes, effect zero** — the non-dry test changes 0 rows |
| `doctor --clear` cache `rmSync` | **No** |
| `doctor --force` cache `rmSync` | **Yes**, six cases |
| Legacy config-location copy-then-unlink | **No** at either 5d call site |

So **six of ten** have a test that drives the real destruction; **five of ten**
if the conditionally-skipped salvage test is excluded, which it must be on any
machine without a capability-bearing `sqlite3`. A seventh, `merge-identity`,
invokes the destructive path for real but with a fixture that produces no
change. **Three have no test that reaches the destructive path at all**:
`repair-db`'s fresh-empty activation, `doctor --clear`, and the legacy
config-location migration — and a fourth, the migration sweep, is covered as a
function but not as the thing plain `doctor` does to you.

### Wizard content assertions

For each wizard, whether a test asserts the *content* it writes rather than that
it completed. The distinction matters because a wizard's product is bytes in
someone else's config file.

| Wizard | Drives the full flow? | Content asserted? | Detail |
| --- | --- | --- | --- |
| OpenCode (`setup-opencode.ts`) | **No.** No test references `runSetup` from this module | **Partly, at the writer level** | `setup-opencode.test.ts` imports four exported writers (`:6-11`) and reads files back: `opencode.jsonc` and `tui.json` merged content (`:55`, `:59`, `:69`), byte-for-byte non-reformatting of an existing config (`:213-214`), malformed config left unchanged (`:41`), DCP removal (`:88-89`), and four compaction-mode cases asserting the exact written block (`:124`, `:137`, `:145`, `:162`, `:168`). `writeMagicContextConfig` is imported (`:10`) and called exactly once, at `:32`, inside "leaves malformed existing config unchanged" — so its **output is never asserted**. Nothing covers the dreamer/sidekick `disable`-key encoding, `dreamer.tasks`, or `cache_ttl` |
| Pi (`setup-pi.ts`) | **Yes.** `runSetup` is referenced ten times | **Yes** | `setup-pi.test.ts:143-470` drives `runSetup({prompts, env})` with injected prompts and asserts written content: Pi settings `packages` entry (`:291`), `magic-context.jsonc` parsed content (`:248`, `:293`, `:348`, `:382`), malformed settings preserved byte-for-byte (`:169`), plus version-gate and not-found flows (`:412`, `:437`) |
| OMP (`setup-omp.ts`) | **Partly.** Tests drive `__test.OMP_HOST.beforeWrite` (`:105`, `:129`, `:149`, `:171`, `:194`), the hook that owns the native-settings changes, not `runSetup` | **Yes** | `setup-omp.test.ts` asserts the written native-settings state file after each scenario (`:113`, `:119`, `:138`, `:157`, `:180`, `:203`), including the rollback path (`:143` "Restored OMP compaction.enabled=true"), the project-config refusal (`:184`), and the `PI_CONFIG_FILES` overlay refusal (`:207`) |
| Dreamer sub-wizard (`dreamer-setup.ts`) | **Yes**, `runDreamerSetup` | **Yes**, at the return-value level | `dreamer-setup.test.ts:65-117`: recommended-defaults returns no tasks so schema defaults apply, declining runs the per-task loop and writes every schedule, the Disabled preset writes an empty schedule, the Custom preset drops to validated raw cron |
| Unified entry (`setup.ts`) | **No** | **No** | No test file. The `--dry-run` propagation at `:18`, `:47`, the per-harness dispatch at `:63-72`, and the next-steps text at `:74-102` are untested |

**Tally.** **Three of five** wizards have a content assertion on what they write
(Pi, OMP, dreamer), and a fourth (OpenCode) has content assertions on its
individual file writers but none on its Magic Context config writer and none on
the flow that orders them. Counting whole wizards whose *end-to-end* run is
driven and whose output is asserted: **one**, Pi.

Two claims in the register have no wizard-level check at all. C17's config-load
failure arms (`setup-opencode.ts:49-56`, `doctor-opencode.ts:80-90`) are reached
by no test in `packages/cli`. C20's `tui.json` write is asserted at the writer
level (`setup-opencode.test.ts:59`) but nothing checks it against the README's
manual-setup instructions, which omit it.

### Type-level and lint gates

| Gate | Reference | Scope and strength |
| --- | --- | --- |
| Workspace typecheck | `ci.yml:245`, `bun run typecheck` → `bun run --cwd packages/cli typecheck` → `tsc --noEmit` | `packages/cli/tsconfig.json` sets `strict: true`. It does **not** set `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, or `noImplicitOverride`, so indexed access is unchecked — directly relevant to the argument parsers, e.g. `valueAfter` in `migrate-session.ts:429-435` and `doctor-merge-identity.ts:21-29`, both of which index `args[index + 1]` |
| Typecheck scope limit | `packages/cli/tsconfig.json` `exclude` | **`src/**/*.test.ts` and `src/**/__tests__/**` are excluded.** So `ci.yml:245` never typechecks any of the 36 CLI test files. A test that stops compiling is caught only by `bun test` at `:257`, which transpiles without typechecking |
| Plugin typecheck | `ci.yml:217` | `packages/plugin` only. No bearing on 5d |
| Lint | `ci.yml:248`, `bun run lint` → `biome check src` for `packages/cli` | Observed at `HEAD`: "Checked 88 files in 72ms", exit 0, zero diagnostics. Configured rules are Biome `recommended: true` plus `useConst: error`. The two rules most relevant to CLI safety are **warn, not error**: `noNonNullAssertion` and `noExplicitAny` (`packages/cli/biome.json`), and both are switched fully off for test files by the override block. `biome check` does not fail on warnings without `--error-on-warnings`, which `ci.yml:248` does not pass, so a future violation of either rule would not fail the job |
| Formatter | `biome.json` `formatter`, `lineWidth: 100`, four-space indent | Enforced through the same `biome check`, so formatting drift does fail CI |
| Source-scan structural gate | `lib/migration-import-guard.test.ts` | One case, "keeps runMigrations imports inside the pinned boot allow-list". Scans `packages/cli/src`, `packages/plugin/src`, `packages/pi-plugin/src` for a `runMigrations` import against an **empty** allow-list and asserts zero offenders. This is the mechanical enforcement of `storage-db.ts:711-712`'s no-migration-lane contract, and M4's basis |
| Build gate | `ci.yml:250-251`, `bun run build` | `packages/cli`'s `build` bundles `src/index.ts`. Catches an unresolvable import; asserts nothing about behaviour |
| Explicit "none found" | — | **No property-based, fuzz, or snapshot tooling** in any file named in this inventory. No `fast-check`, no `insta`-style golden files, no generator-driven case. **No mutation-testing gate.** **No coverage gate.** **No test that enumerates the destructive entry points** and asserts each has a confirmation. **No test that compares the three doctors' exit-code derivations.** **No `--help` output assertion anywhere**: `index.test.ts` references `usageText` twice, and no test asserts any of `printHelp` in `doctor-reset-db.ts:538`, `doctor-repair-db.ts:495`, `printMigrateSessionHelp` in `migrate-session.ts:437`, or `printMigrateHelp` in `migrate.ts:1565`. C3, C8, C9, and C14 are all claims in text that no check reads |

## Suspiciously quiet areas

Ranked by durable consequence against check density.

1. **`lib/diagnostics-opencode.ts`: 947 lines, 10 exports, zero behavioural
   tests.** The largest untested unit in 5d. Its ratio is
   undefined; the worst finite ratios in the scope set are its own Pi twin
   `diagnostics-pi.ts` at 5.4 production lines per test line (581 against 108,
   2 cases), then `database-access.ts` at 4.2 (362 against 86), then
   `doctor-opencode.ts` at 3.9 (1,442 against 369). Every other in-scope unit is
   below 3. The only test-file reference in the tree
   is a **type** import (`logs-opencode.test.ts:7`). Its consequence is
   specific: `collectDiagnostics` (`:729-813`) and
   `renderDiagnosticsMarkdown` (`:814+`) assemble the bundle that
   `doctor --issue` posts to a public GitHub issue, and they decide field by
   field which values pass through `sanitizeString` (`:269-271`),
   `sanitizeValue` (`:273-275`), and `sanitizeDiagnosticText` (`:601`, `:707`).
   The shared primitives in `lib/redaction.ts` *are* tested (`redaction.test.ts`,
   11 cases), so the gap is the assembly, not the sanitiser. Its Pi twin has the
   assembly test this lacks: `diagnostics-pi.test.ts:41-53` "preserves numeric
   thresholds while redacting string secrets" and `:55-107` path resolution.
   At 2 cases against 581 production lines the twin is thin rather than well
   covered, so this is a comparison between none and little. A
   field added to `DiagnosticReport` without a sanitiser call is caught by
   nothing.

2. **The two unconfirmed destructive paths, and specifically the untested one.**
   `repair-db`'s salvage-arm live swap and the plain-`doctor` migration sweep
   both run with no prompt. Their coverage is opposite. The swap has a genuinely
   good test that asserts the moved originals' digests and the installed
   database's contents (`doctor-repair-db.test.ts:275-352`) — but it is
   registered through `salvageIt` and **skipped on this machine at `HEAD`, 6
   pass 2 skip**, so whether the repository's single most destructive unprompted
   operation is exercised at all depends on a runner property `ci.yml` neither
   installs nor asserts. The sweep is the inverse: its five reconciliation arms
   are covered thoroughly at the function level (`migrate.test.ts:1053-1165`),
   while its **call site has no test file whatsoever**, so nothing checks the
   reset-marker precondition (`doctor.ts:46-51`), the fence-refusal skip
   (`:74-78`), the once-per-invocation ordering (`:69-79`), or that the `LOST`
   arm surfaces as `log.error` (`:83`). `doctor.ts` is 211 lines, holds three
   register claims, is reached by every `doctor` invocation, and has zero tests.

3. **The exit-code divergence between the three doctors.** `doctor-opencode.ts`
   returns 1 from exactly one of four arms (`:1436-1438`) and prints a `FAIL`
   count it never reads (`:1429`, M5), while `doctor-pi.ts:1081`/`:1085` and
   `doctor-omp.ts:461`/`:474` derive from `fail > 0` after a re-check. The
   asymmetry sits precisely where the suite does not look: `runDoctor` is
   referenced 15 times in `doctor-pi.test.ts` and 7 times in
   `doctor-omp.test.ts` and **zero times** for OpenCode, whose 19 cases all
   exercise exported helpers — legacy `enabled` migration, dreamer-compatibility
   warnings, and cache clearing. Both OpenCode-specific findings in this
   sub-part, the missing write-phase rollback and the exit chain, are in the two
   entry points with no end-to-end test. This confirms lens A's O14 by direct
   symbol count.

4. **The CLI argument layer of the three destructive commands.** No test in the
   repository references `runResetDbCli`, `runRepairDbCli`, or
   `runMigrateSessionCli`. That layer is where C3's inert `--yes` lives, where
   C11's flag-discarding wrapper lives, and where the `--help` text that
   supplies eight of the twenty register claims is printed. `runMigrateCli` and
   `runMergeIdentityCli` are the two that *are* tested, and they are the two
   that validate their flags.

5. **`commands/doctor-authority.ts`, 237 lines, no test file.**
   `doctor drain-authority <project>` is reachable at `dispatch.ts:114-130` and
   moves memory and note authority from the module to TypeScript — a durable
   authority transition. Neither lens reached it, which is a scoping observation
   rather than a claim that it is safe. It is also one of the four files lens A
   found missing from the scope map's 15-unit list.

6. **`writeMagicContextConfig`, 68 lines, imported by a test that never asserts
   its output.** `setup-opencode.ts:234-302` encodes enablement as the absence
   of a key: `:263` deletes `dreamer.enabled`, `:265` or `:276` sets or clears
   `dreamer.disable`, `:281`/`:283`/`:289` mirror it for sidekick, `:272-274`
   writes `dreamer.tasks`, `:293-299` adds `cache_ttl`. Lens A established that
   the runtime reads exactly the `disable` form
   (`plugin/src/config/agent-disable.ts:11-17`), so the encoding is correct. It
   is also unasserted: the function's single test-file call (`:32`) asserts only
   that a malformed file is left alone, and lens A's O11 — that a re-run cannot
   retract `cache_ttl`, `dreamer.model`, or `dreamer.tasks` — has no check.

7. **Every `[dry-run] would ...` string.** Eleven of them across
   `setup-opencode.ts` (`:308`, `:310-311`, `:481`, `:482`, `:507`),
   `setup-omp.ts:99-103`, and `migrate-session.ts:592-601`. They are the entire
   basis on which a user decides whether to run the real thing, and no test
   asserts that any of them matches the write set the real run performs. C6 is
   the one case where the mismatch is structural rather than hypothetical.

## Open questions

1. **Does `doctor-repair-db.test.ts`'s salvage pair execute on
   `ubuntu-latest`?** This determines whether the repository's most destructive
   unprompted operation has any coverage in CI. Observed here: skipped, because
   no `sqlite3` is on `PATH`. `ci.yml` installs no `sqlite3` (zero matches for
   `sqlite3` or `apt-get` in the workflow) and sets no
   `MAGIC_CONTEXT_SQLITE3`, so the answer depends entirely on the runner image
   shipping a `sqlite3` built with `SQLITE_ENABLE_DBPAGE_VTAB`. Unresolved; a CI
   log or an image manifest settles it. If the answer is no, the operation is
   untested everywhere and the finding's severity changes materially.
2. **Should `ci.yml` assert the salvage capability rather than skip on it?** The
   skip is carefully built — `probeRecoverCapability` (`:226-249`) throws on an
   unrecognised answer so a broken probe cannot masquerade as an absent
   capability, and `:270-272` registers a meta-test naming the reason. The
   design question is whether a destructive-path test may be optional at all.
   (needs human input)
3. **Which side of C18 is the contract?** `README.md:72`/`:74`/`:83`/`:119`
   documents the OpenCode compaction write as unprompted; `setup-omp.ts:64-87`
   prompts and aborts for the equivalent OMP change, and `README.md:120-121`
   describes that as something setup does. Either the OMP prompt should go, or
   the README should describe it. This lens does not resolve it, per METHOD.md
   rule 3, and flags that lens A's record
   `cli-a-wizard-never-changes-harness-behaviour-unprompted` was framed against
   the opposite reading. (needs human input)
4. **Is `doctor-merge-identity.test.ts:69-95` intended as a real-merge test?**
   Observed while running it: the command reports "rows changed: 0" for every
   audited table, so the assertion at `:89-94` — that a `project_state` row
   exists for `dir:target` — can pass without a single identity rewrite. Either
   the fixture should seed source rows or the test's name should not read as an
   end-to-end merge. Unresolved, needs a fixture decision.
5. **Should the register treat `README.md` as a contract of equal weight to
   `--help`?** Four of the twenty claims are README-only (C18, C19, C20, and
   part of C14's absence). The README is the only place a user reads before
   installing, and `dispatch.ts:74`'s `--dry-run` note shows the two surfaces
   already disagree in scope. The synthesis pass should decide whether a
   README-only claim can support a catalog record on its own. (needs human
   input)
6. **Does `tsc`'s exclusion of test files matter for this sub-part?**
   `packages/cli/tsconfig.json` excludes `src/**/*.test.ts`, so 6,059 lines of
   in-scope test code are never typechecked. The consequence is bounded — a
   type error that `bun test` tolerates cannot corrupt user data — but a test
   whose fixture drifts out of shape with a production type would keep passing
   for the wrong reason. Recorded rather than resolved; it belongs to a test-
   adequacy pass, not to discovery.
7. **Reference check on lens A.** Every lens A citation this lens re-read is
   exact: `doctor-opencode.ts:1430-1441` and `:1432-1433`;
   `database-access.ts:143-153`, `:154-161`, `:307-362`, `:340-342`, `:343`,
   `:344-349`; `doctor-reset-db.ts:2-3`, `:14-17`, `:44-49`, `:76-77`,
   `:381-385`, `:539`, `:579-586`, `:603-607`, `:608-611`, `:662-670`;
   `doctor-repair-db.ts:453-475`, `:495-507`, `:500`, `:702-705`, `:754-763`,
   `:758-761`; `migrate-session.ts:447`, `:463`, `:576`, `:605-608`, `:617-627`;
   `migrate.ts:341-347`, `:362`, `:376`, `:1404-1406`; `setup-omp.ts:64-73`,
   `:75-86`, `:106-131`, `:144-150`; `setup-opencode.ts:263`, `:281`, `:313`,
   `:402-403`, `:517-522`, `:555`; `doctor.ts:69-97`; `dispatch.ts:45`, `:163`.
   No correction needed. The one substantive disagreement is interpretive, not
   citational, and is M2.
