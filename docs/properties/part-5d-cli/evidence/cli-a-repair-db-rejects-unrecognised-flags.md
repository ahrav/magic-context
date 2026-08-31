# cli-a-repair-db-rejects-unrecognised-flags

## Discovery trigger

While filling the destructive command table's "non-interactive" column, both
database commands were read side by side. `doctor reset-db` validates its
arguments and throws on anything unknown. `doctor repair-db` does not read its
arguments at all beyond `--help`. Since the two commands recommend each other and
share a `--dry-run`-shaped vocabulary in the surrounding guidance, the asymmetry
is a live hazard rather than a style nit.

## Evidence trail

**The repair wrapper.** `runRepairDbCli`
(`packages/cli/src/commands/doctor-repair-db.ts:754-763`) is the whole surface:

- `:758-761` handles `--help` / `-h` by printing help and returning
  `REPAIR_DB_EXIT.salvaged`.
- `:762` is `return runRepairDb(options)`.

`args` is never inspected again. `options` is the second parameter
(`:756`), supplied by the dispatcher as `{}`, so nothing derived from the command
line reaches `runRepairDb`. `RunRepairDbOptions` (`:68-73`) declares `dbPath`,
`storageDir`, `prompts`, and `deps` — no `dryRun`, no `yes`. So even a wrapper
that did parse flags would have nowhere to put them.

**The reset wrapper, for contrast.** `runResetDbCli`
(`doctor-reset-db.ts:649-677`):

- `:653-656` handles `--help` / `-h`, returning `RESET_DB_EXIT.ok`.
- `:657-661` extracts `--db <value>` and throws `"--db requires a value"` when the
  value is absent or looks like another flag.
- `:662-670` loops over every argument, skipping `--db` and its value, allowing
  `--dry-run` and `--yes`, and throwing
  `` `Unknown doctor reset-db option: ${arg}` `` for anything else.
- `:671-676` forwards `dryRun`, `yes`, and `dbPath`.

**The dispatcher does not compensate.** `dispatch.ts:135-138` is
`if (rest[0] === "repair-db") { ... return await runRepairDbCli(rest.slice(1)); }`
with no validation of `rest`. The `catch` at `:159-165` converts only
`PromptCancelledError` to exit 0 and rethrows everything else, so the reset
command's throw does surface as an error; there is simply no throw to surface for
repair.

**Where the user learns `--dry-run`.** Three places, none of them repair-specific:
`dispatch.ts:64` lists "doctor reset-db    Abandon an unsupported database family
(--dry-run/--yes)"; `dispatch.ts:62` lists merge-identity with
`[--dry-run] [--yes]`; `database-repair-guidance.ts:6` says "run `doctor
reset-db` (preview with --dry-run)". And `doctor-repair-db.ts:551` is the message
that sends a user from repair to reset in the first place. So the vocabulary is
established by the commands adjacent to the one that ignores it.

**Where the ignored flag lands.** Nothing in `runRepairDb` is gated on a preview
mode, so a `doctor repair-db --dry-run` executes the full sequence recorded in
`cli-a-repair-db-live-swap-requires-confirmation`: the backup bundle at
`:557-568`, `.recover` at `:601-610`, and the unconfirmed
`activateReplacement` at `:664`.

**The help exit code.** `:758-761` returns `REPAIR_DB_EXIT.salvaged`, whose
declared meaning at `:46-51` is `salvaged: 0`. The numeric value is a correct
success code for `--help`; the named constant claims a database was repaired.
`doctor-reset-db.ts:653-656` has the same shape but returns `RESET_DB_EXIT.ok`,
which carries no such claim.

## Failure scenario

A user's doctor run reports a failing `integrity_check` and appends the repair
guidance. They run `doctor repair-db`, which classifies the family as neither
`current` nor `malformed-marker` and prints `:551`: "For a legacy or unsupported
family the only supported action is an explicit reset: run `doctor reset-db`."
They read the reset command's help, see `--dry-run`, and preview. The preview
tells them the reset abandons everything, which they do not want. They go back to
`repair-db` and, having just learned the flag, type
`doctor repair-db --dry-run` expecting the same courtesy.

The command takes no preview path. It copies a backup, runs `.recover`, and — if
the recovery classifies as `current` — renames the live database aside and
installs a lossy rebuild with no prompt. The user asked to look and performed a
repair.

A second, quieter variant: a script that passes `--dry-run` to every doctor
subcommand as a safety default gets a real repair from this one, and reads exit 0
as confirmation that nothing happened.

## Timing windows and dependencies

None. The defect is in argument handling and is deterministic.

One dependency is worth noting for whoever fixes it: adding validation to
`runRepairDbCli` is a behaviour change that could break a caller passing an
unrecognised argument today. A repository search finds one caller,
`dispatch.ts:137`, which passes `rest.slice(1)` straight through, so the blast
radius is limited to command lines users type. `doctor-repair-db.test.ts` calls
`runRepairDb` rather than `runRepairDbCli`, so no test asserts the current
permissiveness either.

## What a test must construct

Cheap and entirely offline; no database or `sqlite3` needed.

1. `await expect(runRepairDbCli(["--dry-run"])).rejects.toThrow(/[Uu]nknown/)`
   — the desired behaviour. At `HEAD` this instead attempts a real repair against
   the default storage path, which is itself a reason to write the test with an
   injected `dbPath`.
2. Safer form for the present state: pass
   `runRepairDbCli(["--dry-run"], {dbPath: <a path that does not exist>})` and
   assert the throw. Today it returns `REPAIR_DB_EXIT.failed` from the
   not-found branch at `:521-526`, proving the flag reached nothing.
3. `--yes`, `--db /tmp/x`, and a bare `foo` should all reject.
4. `--help` and `-h` must still return 0, and the test should pin the returned
   constant so a future rename of `salvaged` does not silently change the help
   contract.
5. A parallel test for `runResetDbCli` asserting its throw on an unknown flag,
   which is also missing today, so the two commands' argument contracts are
   asserted as a pair.

## Investigation log

### Q: Should `--help` have its own exit code, given that a caller reading exit 0 as "salvaged" is now wrong twice?

- Sources examined: `doctor-repair-db.ts:46-51` (`REPAIR_DB_EXIT`), `:758-761`;
  `doctor-reset-db.ts:44-49` (`RESET_DB_EXIT`), `:653-656`; `dispatch.ts:88-91`
  (top-level help returns 0).
- Findings: the two exit tables are shaped differently on purpose.
  `RESET_DB_EXIT` names its success `ok`, a neutral term that `--help` can borrow
  honestly. `REPAIR_DB_EXIT` names its success `salvaged`, an outcome claim, and
  the same value is returned by `--help` and by the fresh-empty install at `:742`
  — so `salvaged` already covers two outcomes that are not salvage. Renaming the
  constant to `ok` would fix the naming without changing any numeric contract,
  and is the smaller change than adding a fifth code.
- Missing evidence: whether any caller keys on the constant by name. Only
  `dispatch.ts:137` calls the CLI wrapper, and it treats the value as a plain
  number.
- Conclusion: needs human input, but the cheap option is a rename rather than a
  new code. Flagged so the fix is not over-scoped.

### Q: Would validating arguments break anything?

- Sources examined: `dispatch.ts:135-138`, `:159-165`;
  `doctor-repair-db.test.ts` for `runRepairDbCli` references.
- Findings: `doctor-repair-db.test.ts` exercises `runRepairDb`, not the CLI
  wrapper, so no test depends on permissiveness. `dispatch.ts:159-165` rethrows
  non-cancellation errors, which means a validation throw would surface as an
  unhandled error rather than a clean message and a non-zero code — the same
  shape `doctor reset-db` already produces, so the behaviour would at least be
  consistent between the siblings.
- Missing evidence: none.
- Conclusion: resolved with answer — no caller depends on the current behaviour,
  and adopting `runResetDbCli`'s loop verbatim would make the two commands agree.
