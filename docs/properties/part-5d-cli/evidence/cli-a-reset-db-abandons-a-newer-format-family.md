# cli-a-reset-db-abandons-a-newer-format-family

## Discovery trigger

Part 3 recorded that the Rust store has a `doctor reset-db` guidance path, and
Part 5a recorded that the TypeScript fence refuses an unclassifiable database
with that same guidance while forbidding it on another arm. The task asks what
`doctor reset-db` actually does, and whether it can destroy data the fence was
protecting. Reading the fence's own message first made the question sharp:
`packages/plugin/src/features/magic-context/storage-db.ts:678` ends with
"Do not reset this database: a newer binary owns it." So the question is whether
`doctor reset-db` honours that sentence. It does not.

## Evidence trail

**The fence's two arms and what each recommends.**
`refuseNewerSchemaFence` (`storage-db.ts:651-681`) reads the version lane and the
marker epoch, collapsing a non-`present` marker to `0` at `:668`, and accepts
only when `persistedVersion <= latestSupportedVersion && persistedEpoch <=
DIRECT_FORMAT_EPOCH` (`:669`). On refusal it names the offending lane at
`:673-676` and logs the "Do not reset this database" line at `:678`. The comment
at `:663-666` states the reasoning outright: "The marker's format epoch is the
signal that actually distinguishes a database this build is too old to read from
one it must refuse: reset guidance for the former would destroy a family a newer
binary legitimately owns."

`recordFormatRefusal` (`:683-705`) runs the fence first and returns early when it
fires (`:689`). When it does not fire, it composes guidance: the `manifestOnly`
softened form requires `marker.status === "present"` (`:695-698`), and everything
else gets `:701`, "To abandon this database family and start fresh, run
'npx @cortexkit/magic-context@latest doctor reset-db'." The pre-open refusal at
`:747` uses the same unconditional sentence.

**What the CLI's classifier does with a newer family.**
`classifyDatabaseFormatFamily` (`storage-format-epoch.ts:288-345`) has two routes
that a newer binary's database can take:

- **Route A, unreadable marker.** `:292-294` returns
  `{family: "malformed-marker"}` as the very first branch, before any other
  check. `readDirectFormatMarker` (`:186-234`) reaches `malformed` through eight
  distinct conditions: unreadable marker table (`:198-203`), zero rows (`:204`),
  more than one row (`:205-207`), epoch not a safe integer or below 1
  (`:216-221`), invalid incarnation id (`:222-224`), non-hex manifest digest
  (`:225-227`), invalid creation time (`:228-230`), digest mismatch (`:231-233`).
  A newer binary that changes `FORMAT_MARKER_DIGEST_PROTOCOL` (`:50`) or adds a
  marker column takes the digest-mismatch or unreadable-table route.
- **Route B, a clean newer epoch.** A marker with `format_epoch = 2` and a
  self-consistent digest is `present`. `:313-317` pushes
  "marker format epoch 2 does not match expected 1" with **no direction
  comparison**, and `:344` returns `{family: "unsupported", reasons}`.

**Where the direction is lost.**
`inspectDirectDatabaseFamilyState`
(`packages/cli/src/lib/database-access.ts:307-362`) maps that verdict onto four
states. `current` requires `classification.family === "current"` **and** a
readable incarnation id (`:340-342`). `pristine` is `:343`. Everything else,
including both `malformed-marker` and `unsupported`, falls to `:344-349` as
`state: "unsupported"`.

**Where it becomes destructive.** `doctor-reset-db.ts:381-385` declares
`ResettableFamilyState` as `Extract<DirectDatabaseFamilyState, {state:
"unsupported"} | {state: "corrupt"}>`, with the comment "The two family states
reset may abandon; every other state exits early." `runResetDb` refuses
`current` (`:571-577`), returns early on `pristine` (`:566-570`), routes
`reset-pending` to recovery (`:563-565`), and hands everything else to the
confirmation at `:603-607` and then `executeQuarantine` (`:646`).

**Negative confirmation.** A read of `doctor-reset-db.ts` in full at `HEAD`
finds no reference to `DIRECT_FORMAT_EPOCH`, no `formatEpoch` comparison, and no
call to `refuseNewerSchemaFence`. Its imports from `storage-format-epoch`
(`:21-34`) are the marker and quarantine primitives only.

**The sibling command steers traffic here.**
`doctor-repair-db.ts:541-555` refuses any family that is neither `current` nor
`malformed-marker` and prints "For a legacy or unsupported family the only
supported action is an explicit reset: run `doctor reset-db`" (`:551`).
`migrateAndCheckRecoveredDatabase` says the same at `:350` and `:364`.
`storage-versions.ts:46-53` says it for a below-fence lane.

## Failure scenario

A user has Magic Context pinned in one project's `opencode.jsonc` and `@latest`
in another. The newer build bootstraps `context.db` and stamps
`mc_format_marker.format_epoch = 2`. The older build opens it, `:669` fails on
the epoch arm, and it logs the fence line ending "Do not reset this database: a
newer binary owns it." Part 5a's `fence-a-refusal-is-a-null-return-not-a-throw`
records that the refusal reaches the caller as `null`, so the user sees Magic
Context silently inactive rather than an error.

The user runs `magic-context doctor`, which reports the version lane as matching
(see `cli-a-doctor-never-passes-a-database-the-plugin-refuses`). The user then
runs `doctor repair-db`, which refuses and points at `doctor reset-db` (`:551`).
They run `doctor reset-db`. The state prints as `unsupported (unsupported)` with
the reason "marker format epoch 2 does not match expected 1". The prompt asks
"Abandon this database family into quarantine? All of its logical data will be
lost to the application." (`:606`, default no). The user, having been told twice
that reset is the only supported action, confirms. Four files move into
`${dbPath}.mc-quarantine-<stamp>/`. The next run of the **newer** build finds a
pristine path and bootstraps an empty database with a new incarnation
(`:365-367`).

Every step followed on-screen advice. The one message that would have stopped it
went to the plugin log, from a process the user had already concluded was broken.

## Timing windows and dependencies

No interleaving is required; the outcome is deterministic given the on-disk
marker. Two dependencies matter:

- The scenario needs the version lane to be **within** range while the epoch is
  out of range, otherwise `refuseNewerSchemaFence` would still fire but the CLI's
  `openExistingContextDatabase` version check (`database-access.ts:154-161`)
  would also fire and give the user a different message. A newer binary that
  bumps the epoch without bumping the migration lane produces exactly that,
  and since `LATEST_SUPPORTED_VERSION` is pinned to a retired lane constant
  (`storage-db.ts:98`, `migrations.ts:4-6`) the lane is expected to be stable
  across releases while the epoch is the moving part.
- Route A additionally does not need a newer epoch at all: any protocol or
  column change that makes the marker unverifiable lands in the resettable set
  while the version lane still reads 90.

## What a test must construct

1. Bootstrap a current-format `context.db` with this build.
2. Route B: `UPDATE mc_format_marker SET format_epoch = 2, marker_digest = <the
   digest recomputed over the new tuple>`. The digest helper is
   `computeMarkerDigest`, used by `buildDirectFormatMarker`; recomputing it keeps
   the marker `present` so the test exercises the epoch arm rather than route A.
   Also set `PRAGMA user_version = 2` if the test wants the family to be
   internally consistent; leaving it at 1 adds a second reason but does not
   change the family verdict.
3. Assert `inspectDirectDatabaseFamilyState` returns
   `{state: "unsupported", family: "unsupported"}` and that its `reasons`
   contain the epoch text. This is the fact the record turns on.
4. Assert `refuseNewerSchemaFence`-equivalent conditions hold: read the marker
   epoch and confirm `epoch > DIRECT_FORMAT_EPOCH`.
5. Call `runResetDb({dbPath, yes: true})` and assert the **desired** outcome:
   `RESET_DB_EXIT.refused` and every family digest unchanged. At `HEAD` this
   assertion fails, which is the point.
6. Route A: corrupt only `marker_digest`. Assert
   `readDirectFormatMarker` returns `malformed` and that the reset outcome is
   again refusal.

`ResetDbDeps` (`:53-58`) does not need stubbing for either case; both are
on-disk states.

## Investigation log

### Q: Should `inspectDirectDatabaseFamilyState` grow a fifth state, `newer`, or should reset call `refuseNewerSchemaFence` directly?

- Sources examined: `database-access.ts:215-237` (the `DirectDatabaseFamilyState`
  union), `:307-362`; `doctor-reset-db.ts:141-154` (`describeFamilyState`, a
  total switch over the union), `:381-385`, `:392-394`
  (`familyIncarnation`, which already special-cases `unsupported`);
  `storage-db.ts:651-681`.
- Findings: adding a `newer` state is mechanically contained — the union is
  consumed by `describeFamilyState` (a total switch, so the compiler finds every
  site), `recheckUnderExclusivity`, and `familyIncarnation`. Calling
  `refuseNewerSchemaFence` directly is harder: it takes an open `Database`
  (`:651-655`) and mutates the module-global rejection latch at `:672`, which the
  CLI has no business touching. A third option is for
  `classifyDatabaseFormatFamily` to return a directional family such as
  `newer-format`, which would also fix `doctor-repair-db.ts:541-555`, currently
  routing this case to reset. That is the widest fix and the one that keeps both
  runtimes reading one classifier.
- Missing evidence: whether any other consumer of `DatabaseFormatFamily` would
  need updating. The type is exported from `storage-format-epoch.ts:241-246` and
  is used across both packages; a full consumer census was not done.
- Conclusion: needs human input. Three viable shapes, and the choice determines
  whether `repair-db`'s routing is fixed at the same time.

### Q: Is this the same finding as Part 5a's `fence-a-unclassifiable-family-must-not-get-reset-guidance`?

- Sources examined: `docs/properties/part-5a-storage/catalog.md:482-519` (that
  record's index row and section), `storage-db.ts:683-705`, this record's trail.
- Findings: they are the two halves of one chain and neither subsumes the other.
  Part 5a's record is about the plugin **emitting** reset guidance for a family
  it cannot classify: its evidence is `manifestOnly` at `:695-698` failing for a
  malformed marker so `:701` recommends reset. This record is about the CLI
  **honouring** that recommendation destructively, and it holds even if the
  guidance were fixed, because the user can reach `doctor reset-db` from
  `repair-db:551`, from `storage-versions.ts:46-53`, or from the documentation.
  Fixing only the guidance would leave the destructive path open; fixing only
  the CLI would leave the plugin recommending a command that then refuses, which
  is safe but confusing.
- Missing evidence: none.
- Conclusion: resolved with answer — distinct records, one chain. The synthesis
  pass should cross-link them and must not deduplicate.

### Q: Does the operator see enough to stop themselves?

- Sources examined: `doctor-reset-db.ts:173-193` (`reportPlan`), `:182-183`
  (family label plus each reason), `:189-191` (the ALL-CAPS abandonment warning),
  `:192` plus `:76-77` (the retention note), `:606` (the prompt), `:378`
  (default false).
- Findings: the reason string "marker format epoch 2 does not match expected 1"
  **is** printed at `:183`, and the confirmation defaults to no. So an operator
  who reads the reason and knows what a format epoch is can stop. Nothing in the
  output says the direction is upward, nothing repeats the fence's
  "a newer binary owns it", and `--yes` skips the prompt entirely (`:377`).
- Missing evidence: none.
- Conclusion: resolved with answer — the information is present but unlabelled,
  and `--yes` removes even that. This is why the record's `Check` is on the
  quarantined family's state rather than on the prompt text.
