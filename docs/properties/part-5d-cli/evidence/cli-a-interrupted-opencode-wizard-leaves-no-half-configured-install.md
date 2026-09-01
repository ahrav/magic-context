# cli-a-interrupted-opencode-wizard-leaves-no-half-configured-install

## Discovery trigger

Part 4a resolved a reachability question using these wizards: a completed setup
cannot omit a historian model, because the model picker requires nonempty input
and both setup paths always write one. The task asks what else the wizards
decide, which made the complement worth checking: what an **incomplete** setup
writes. The OpenCode wizard's own comment claims the answer is nothing, and the
Pi wizard implements a stronger version of that claim than the OpenCode one does.

## Evidence trail

**The documented claim.** `packages/cli/src/commands/setup-opencode.ts:402-403`:
"Collect every interactive choice before applying setup writes. A cancelled
wizard can then unwind without leaving only some target files updated."

**The claim holds for cancellation.** Every prompt in the OpenCode wizard is at
`:227`, `:329-332`, `:426-429`, `:445`, `:449`, `:459`, `:474`, or `:505` — all
before the commit block at `:516`. `confirm` (`lib/prompts.ts:149-153`) and
`text` (`:155`) both call `handleCancel`, which on `isCancel` calls
`clackCancel` and throws `PromptCancelledError` (`:91-98`). The comment there
states the intent: "Let the command unwind normally so setup can avoid later
writes and close any resources it owns instead of terminating the process here."
`dispatch.ts:159-165` catches it and returns 0, with a comment at `:160-162`
explaining that `return await` is load-bearing for that catch to see the
rejection. So Ctrl-C at any prompt leaves the five targets untouched.

**The claim does not hold for a failure inside the commit block.** `:516-577` is
`if (!dryRun) { ... }` with no `try`. The writes run in order:

1. `:517-522` `addPluginToOpenCodeConfig` — registers the plugin and, in mode-on,
   sets `compaction.auto` and `compaction.prune` to false.
2. `:534-543` `fixConflicts` for the accepted conflict fixes.
3. `:545-553` `writeMagicContextConfig` — the only write that creates
   `magic-context.jsonc`.
4. `:555` `addPluginToTuiConfig`.
5. `:558-576` `fixConflicts` for the OMO hook disables.

Each individual write is atomic: `addPluginToOpenCodeConfig` ends in
`writeFileAtomic` (`:163`, and `:93` on the create path),
`writeMagicContextConfig` at `:301`, `addPluginToTuiConfig` at `:172` and `:197`.
There is no cross-file transaction and no compensating action.

**Step 3 can throw after step 1 has committed.** `writeMagicContextConfig:248`
opens with `readJsoncConfigForUpdate(configPath)`, whose contract is stated at
`:247`: "A malformed existing file must abort rather than become an empty
config." The precheck `assertJsoncConfigsParseable` (`:378-382`) runs before the
prompts, so a `magic-context.jsonc` that becomes malformed while the wizard is
open — another tool writing it, or a partially applied manual edit — lands
squarely between steps 1 and 3. ENOSPC or a permission change does the same.

**The exception escapes uncaught.** `setup.ts:47` is
`const code = await dispatchSetup(adapter, dryRun);` with no `try`;
`dispatch.ts:106-109` dispatches `setup` inside the outer `try`, whose `catch` at
`:159-165` rethrows anything that is not a `PromptCancelledError`.

**The Pi wizard implements the stronger claim.** `setup-pi.ts:461-491` wraps its
write phase in `try`, and its `catch` at `:483-490` calls
`host.rollbackPluginEntry(registration)` when the registration succeeded and then
`await rollbackHost()`, the closure `beforeWrite` returned. `setup-omp.ts` builds
that closure at `:106-131`, restoring each applied `omp config set` in reverse,
and `:133-140` uninstalls or disables the plugin entry it added.

**What the resulting state means to the runtime.** The subsystem directions are
safe, and this is worth stating because it is not obvious:

- `isDreamerRunnable` is `!!config.dreamer && config.dreamer.disable !== true`
  (`packages/plugin/src/config/agent-disable.ts:11-13`). With no
  `magic-context.jsonc` there is no `dreamer` block, so `!!config.dreamer` is
  false and the dreamer does **not** run — even though the user answered yes at
  `:449`. `isSidekickRunnable` is the same shape (`:15-17`).
- The historian falls back to its chain. `setup-opencode.ts:585` already renders
  that as a legitimate summary state: `historianModel ? ... : "Historian:
  fallback chain"`.
- `isCompactionEnabled` is `config.compaction?.enabled !== false` (`:34`), so with
  no config Magic Context's own compaction mode is on.

The dangerous half is therefore not a subsystem being enabled; it is that step 1
already disabled the harness's native compaction while step 3 never ran.

## Failure scenario

A user runs `setup` on OpenCode. They answer every prompt. Between the plugin
registration at `:517` and the config write at `:545`, an editor with an open
`magic-context.jsonc` buffer saves a version with a trailing comma.
`readJsoncConfigForUpdate` at `:248` throws. The exception propagates through
`setup.ts:47` and `dispatch.ts:159-165` to the process.

State on disk: `opencode.jsonc` has the Magic Context plugin entry and
`compaction: {auto: false, prune: false}`. `magic-context.jsonc` is malformed and
has no historian, dreamer, or sidekick keys. `tui.json` is untouched, so the
sidebar the user expects is absent. No summary was printed, because `:579-594` is
past the throw.

The user restarts OpenCode. The plugin loads. Native compaction is off. Magic
Context's own compaction is on by default, so the window is managed, but by a
component configured entirely by schema defaults with a historian on the fallback
chain and a dreamer the user asked for silently absent. Re-running `setup` is the
right move and will work — `:378-382` will now fail fast on the malformed file
with a clear message ("Setup stopped — fix the malformed config and rerun
setup.", `:385`) — but nothing tells the user that the previous run half
completed.

## Timing windows and dependencies

- Window: `:517` (first commit) to `:576` (last commit). Four atomic writes, no
  enclosing transaction.
- The most damaging sub-window is `:523` to `:545`: plugin registered and native
  compaction disabled, Magic Context config absent.
- Dependency on ordering. The plugin entry is written first and the Magic Context
  config third. Inverting them would make the failure mode benign: a config with
  no plugin entry is inert. That is the cheapest fix and is worth stating
  alongside the rollback option.
- Dependency on `assertJsoncConfigsParseable` running before the prompts
  (`:375-388`). Because it does, the *ordinary* malformed-file case is caught
  early and this window requires a change during the wizard's lifetime. That
  narrows reachability without removing it; ENOSPC and permission changes need no
  concurrent editor.
- Cancellation is **not** in the window. Recording that explicitly matters,
  because the file's comment invites the reader to assume the two cases are the
  same and they are not.

## What a test must construct

1. Fixture: `opencode.jsonc` with `{plugin: []}`, a valid `magic-context.jsonc`,
   a `tui.json`.
2. Mock the prompt module so every `confirm` returns true and the picker returns
   a model id. (`runSetup` in `setup-opencode.ts:305` takes only `dryRun` and
   imports its prompts directly at `:33`, so module mocking is required. The
   absence of a `prompts` parameter is itself the reason no flow test exists.)
3. Make step 3 fail. The cleanest injection is a `chmod 0o400` on
   `magic-context.jsonc` immediately before `runSetup`, or a mock of
   `writeFileAtomic` that throws on its second call.
4. Assert the desired outcome: either `opencode.jsonc` has no plugin entry and no
   `compaction` key (full unwind), or it has both and `magic-context.jsonc` was
   written (full completion). At `HEAD` neither holds.
5. Assert the runtime reading of the partial state so the record's Impact
   paragraph is checked rather than asserted: load the config through
   `loadPluginConfig` and assert `isDreamerRunnable` is false. This is the
   direction that is currently safe, and pinning it prevents a future change to
   `agent-disable.ts:11-13` — for instance defaulting the dreamer on when the
   block is absent — from turning a partial setup into an unrequested subsystem.
6. Cross-harness pin: `setup-pi.test.ts` already drives `runSetup`; add a case
   that makes `writeMagicContextConfig` throw and assert
   `rollbackPluginEntry` and the `beforeWrite` rollback both ran. That asserts the
   behaviour the OpenCode path lacks, in the file that can already test it.

## Investigation log

### Q: Should the OpenCode wizard adopt the `setup-pi.ts:461-491` rollback, or should the write order be inverted?

- Sources examined: `setup-opencode.ts:516-577`, `:402-403`;
  `setup-pi.ts:448-459` (`beforeWrite` and its `false` handling), `:461-491`
  (the guarded write phase and its `catch`); `setup-omp.ts:106-131`, `:133-140`.
- Findings: inversion is cheaper and covers the damaging sub-window: writing
  `magic-context.jsonc` before touching `opencode.jsonc` makes a failure leave an
  unreferenced config, which is inert and which a re-run overwrites. It does not
  cover a failure at step 4 or 5, which leave a registered plugin with a written
  config — a benign state. A rollback is more complete but harder here than on
  Pi, because Pi's rollback targets are a package registration and two `omp
  config set` calls, whereas OpenCode's targets are surgical JSONC text edits
  (`appendJsoncArrayValues`, `setJsoncValue`) whose inverse is not obviously
  available. Reverting them would mean snapshotting the original file bytes before
  the first write and restoring them, which is a different mechanism than Pi's.
- Missing evidence: whether snapshot-and-restore of the pre-write bytes is
  acceptable given that `fixConflicts` also edits OMO files, so a full unwind
  spans more than the wizard's own targets.
- Conclusion: needs human input. Inversion is the small, immediately-correct
  change; a full unwind needs a byte-snapshot design decision covering
  `fixConflicts`'s targets too.

### Q: Is "historian falls back to the chain" acceptable for an interrupted setup, or should Part 4a's reachability label be revisited?

- Sources examined: `docs/properties/part-4a-historian/catalog.md` index (read
  for the relevant row only, per the task's instruction not to re-derive Part 4a);
  `model-picker.ts:79-88` (the nonempty validator at `:85`);
  `setup-opencode.ts:256-260`, `:585`; `setup-pi.ts:242-246`.
- Findings: Part 4a's premise is about a **completed** setup and it is correct:
  the picker rejects empty input, and both writers set `historian.model`
  unconditionally when a model was picked. This record does not contradict it. It
  identifies a different state — no `magic-context.jsonc` at all — in which the
  historian model is absent not because the wizard omitted it but because the
  wizard never got to write anything. `setup-opencode.ts:585` shows the fallback
  chain is a supported configuration, so the state is degraded rather than
  invalid.
- Missing evidence: whether the fallback chain is documented as supported
  anywhere outside that summary string. Not established here.
- Conclusion: resolved with answer — Part 4a's label stands for completed setups
  and needs no revision. The interrupted case is a distinct state, degraded but
  not invalid, and the cross-reference should be recorded so a later reader does
  not read this record as overturning Part 4a. Cited, not re-derived.
