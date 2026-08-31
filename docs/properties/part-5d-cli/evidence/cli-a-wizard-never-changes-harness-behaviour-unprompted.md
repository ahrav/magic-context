# cli-a-wizard-never-changes-harness-behaviour-unprompted

## Discovery trigger

The task asks what the wizards default, and specifically whether a default
enables a surface the user did not ask for. Building the wizard decision map by
walking every `confirm` in `setup-opencode.ts` and every write in its commit block
produced two writes with no matching prompt, and the comparison with
`setup-omp.ts` — which asks for the equivalent change and aborts when refused —
turned that from an omission into a cross-harness inconsistency.

## Evidence trail

**Every prompt in the OpenCode wizard.** Read at `HEAD`,
`packages/cli/src/commands/setup-opencode.ts`:

| Line | Prompt | Default |
| --- | --- | --- |
| `:227` | "Remove opencode-dcp from your config?" | **yes** |
| `:329-332` | "OpenCode not found on PATH. Continue setup anyway?" | no |
| `:426-429` | "Apply automatic conflict fixes to your OpenCode and OMO config files?" | **yes** |
| `:445` | historian model picker (`pickModel`) | n/a |
| `:449` | "Enable dreamer?" | **yes** |
| `:459` | "Enable sidekick?" | no |
| `:474` | "Do you have a Claude Max or Pro subscription?" | no |
| `:505` | "Disable these hooks in oh-my-opencode?" | **yes** |

`runDreamerSetup` adds "Use recommended task schedules?" defaulting to yes
(`dreamer-setup.ts:112-115`) and a per-task schedule picker when declined
(`:121-147`).

**Every write in the commit block, `:516-577`:**

| Line | Write | Matching prompt |
| --- | --- | --- |
| `:517-522` | `addPluginToOpenCodeConfig(opencodeConfig, format, removeDcp, compactionEnabled)` | `:227` for the `removeDcp` half only |
| `:534-543` | `fixConflicts(cwd, conflictFix, ...)` | `:426-429` |
| `:545-553` | `writeMagicContextConfig(magicContextConfig, ...)` | the model and enablement prompts |
| `:555` | `addPluginToTuiConfig(tuiConfig, tuiConfigFormat)` | **none** |
| `:558-576` | `fixConflicts(cwd, {omo*: true}, ...)` | `:505` |

**The unprompted compaction write.** `addPluginToOpenCodeConfig`
(`:69-164`) does two independent things. The plugin entry is the part the user
asked for by running setup. The compaction fields are not:

- New file: `:87-95` creates `{plugin: [PLUGIN_ENTRY]}` and, when
  `compactionEnabled`, adds `compaction: {auto: false, prune: false}` at `:90-92`.
- Existing file: `:143-161` runs only when `compactionEnabled`. If there is no
  `compaction` object it sets one at `:148`; otherwise it forces `auto` to false
  at `:152-155` and `prune` to false at `:156-159`, each only when the current
  value is not already false.
- `:141-142` documents the mode-off behaviour: "In compaction-off mode native
  fields are never changed."

`compactionEnabled` comes from `resolveCompactionEnabledForWriter` (`:45-57`),
which loads the plugin config through the same loader the plugin uses and calls
`isCompactionEnabled`. That accessor is
`config.compaction?.enabled !== false`
(`packages/plugin/src/config/agent-disable.ts:34`), so an absent config or an
absent `compaction` block yields **true**. A fresh install therefore takes the
writing arm. On loader failure `:49-56` warns and returns false, preserving
native fields — the safe direction, deliberately chosen and documented at
`:37-44`.

The user is told after the fact: `:526-529` logs "Disabled built-in compaction
(auto=false, prune=false)" and "Magic Context handles context management —
built-in compaction would interfere". The summary repeats it at `:582-584`.

**The unprompted TUI write.** `addPluginToTuiConfig` (`:166-198`) creates
`tui.json` with the plugin entry when absent (`:170-174`) or appends to the
existing `plugin` array (`:190-197`). It is called unconditionally at `:555`. The
only related output is the dry-run message at `:482` and the success line at
`:556`.

**What OMP does instead.** `setup-omp.ts`'s `beforeWrite` hook (`:45-133`):

- Reads `compaction.enabled` and `memory.backend` through the OMP binary
  (`:50-51`) and **refuses** if either is unreadable, with the reason
  "refusing to install two context managers blindly" (`:52-57`).
- Confirms "Disable OMP native compaction? Magic Context must own context
  management end to end." defaulting to yes (`:64-73`), and **returns false**
  (aborting setup) when declined, logging "OMP native compaction conflicts with
  Magic Context."
- Confirms the memory-backend change the same way (`:75-86`).
- Refuses to mutate the global config when effective settings come from a
  project or overlay source (`:87-95`).
- Builds a rollback closure that restores each applied `omp config set`
  (`:106-131`).

So the same product, for the same class of change, asks on one harness and does
not on the other. `setup-pi.ts` reaches `beforeWrite` at `:448-459` and honours a
`false` return at `:456-459`.

## Failure scenario

A user installs Magic Context on OpenCode to try it. They decline the DCP removal
(`:227`), decline the automatic conflict fixes (`:426-429`), decline the OMO hook
disables (`:505`), answer no to dreamer and sidekick, and finish the wizard
believing they have made a minimal, reversible change: one plugin entry.

Their `opencode.jsonc` now also has `compaction: {auto: false, prune: false}`,
and their `tui.json` has a second plugin entry. If they later remove the Magic
Context plugin entry, nothing restores either. Native compaction stays off, and
long sessions overflow with no window manager at all, because the component they
declined everything else about was the one that had silently taken over the
window and was then removed.

The severity depends on the removal being manual — `setup` has no uninstall
counterpart in `dispatch.ts:106-158` — so the residue is permanent until the user
finds it themselves.

## Timing windows and dependencies

No timing angle. The relevant dependency is the resolution of
`compactionEnabled`, and it has one property worth stating: the value is resolved
once at `:400`, before the prompts, and reused for `addPluginToOpenCodeConfig`
(`:521`), `detectConflicts` (`:414-416`), both `fixConflicts` calls (`:536`,
`:570`), and the summary (`:582`). So a single resolution governs the whole run,
which is correct and means a fix has one place to add a prompt.

A second dependency: `assertJsoncConfigsParseable` (`:378-382`) validates
`opencodeConfig`, `magicContextConfig`, and `tuiConfig` before any prompt, with
the comment "Fail before touching any setup target if one existing file is
malformed." So the wizard is careful not to corrupt these files; the gap is
consent, not integrity.

## What a test must construct

`setup-opencode.test.ts` never calls `runSetup`, so this needs the flow harness
that file does not have. `runSetup(dryRun = false)` takes no `prompts` parameter
— it imports `confirm`, `log`, `note`, `outro`, `spinner`, and `promptIO`
directly from `../lib/prompts` at `:33` — so a flow test needs module mocking.
That is itself a finding worth surfacing: `setup-pi.ts`'s `runSetup` accepts an
options object with `prompts` and `env` (`:70-82`), which is why `setup-pi.test.ts`
can drive it.

Given a mocked prompt module:

1. Fixture: an `opencode.jsonc` with only `{plugin: []}`, an existing `tui.json`
   with `{plugin: []}`, and no `magic-context.jsonc`.
2. Stub every `confirm` to return **false** and the model picker to return a
   fixed id.
3. Run `runSetup(false)`.
4. Assert `opencode.jsonc` contains the Magic Context plugin entry and does
   **not** contain a `compaction` key — the desired behaviour. At `HEAD` this
   fails.
5. Assert `tui.json`'s `plugin` array is unchanged — also the desired behaviour,
   also failing at `HEAD`.
6. Record every prompt message the stub saw and assert that for each key written
   outside `magic-context.jsonc`, some message mentions it. This is the general
   form of the check and survives future writes being added.
7. Cross-harness pin: assert `setup-omp.ts`'s `OMP_HOST.beforeWrite` returns
   `false` when the compaction confirm is declined, so the two harnesses'
   behaviours are asserted side by side and a future change cannot quietly align
   them downward.

Step 6 is the assertion the record's `Check` names; steps 4 and 5 are the two
instances it currently catches.

## Investigation log

### Q: Is the compaction write treated as constitutive of installing Magic Context rather than as a conflict fix, so no prompt applies?

- Sources examined: `setup-opencode.ts:143-161`, `:37-44` (the writer-mode
  doc comment), `:526-532` (the post-hoc log lines), `:582-584` (the summary),
  `:412-440` (the conflict-detection block, which **does** prompt),
  `packages/plugin/src/config/agent-disable.ts:24-35` (the accessor and its
  exclusivity comment), `setup-omp.ts:45-133`.
- Findings: there is real evidence for the "constitutive" reading. The write is
  inside `addPluginToOpenCodeConfig` rather than in `fixConflicts`, the log line
  at `:528` frames it as a consequence of Magic Context managing the window, and
  `resolveCompactionEnabledForWriter`'s doc at `:37-44` treats the mode as a
  property of the installation rather than a user choice at setup time. Against
  it: `detectConflicts`/`fixConflicts` covers `compactionAuto` and
  `compactionPrune` as conflicts (`:562-563` passes them explicitly in the OMO
  block), so the same two fields are modelled as conflicts elsewhere in the same
  file; and OMP asks. The strongest reading is that OpenCode's wizard predates
  the OMP one and the OMP author added consent that was never backported.
- Missing evidence: no comment addresses why OpenCode does not prompt. The
  `!hadExistingSetup` gate at `:494` has a defensive comment about a false
  positive auditors hit (`:486-492`), so the file's authors do annotate
  deliberate asymmetries — and this one is unannotated.
- Conclusion: needs human input. Two coherent designs; the inconsistency between
  harnesses is the defect either way, and resolving it downward (removing OMP's
  prompt) would be worse than resolving it upward.

### Q: Does the TUI plugin write have any user-visible consequence worth prompting for?

- Sources examined: `setup-opencode.ts:166-198`, `:555-556`, `:482`;
  `paths.detectConfigPaths` usage at `:369`; `:370-373` where `tuiConfigFormat`
  contributes to `hadExistingSetup`.
- Findings: the write adds a sidebar plugin to a second config file the user did
  not name. It is additive, guarded against duplicates (`:190-192`), and warns
  about unverifiable local paths (`:177-188`), so its integrity is good. Its
  consequence is a UI surface appearing in the harness. That is a lower-stakes
  change than disabling compaction and a reasonable thing to include in "install
  Magic Context", but it is also the clearest instance of the general property:
  a file the user never mentioned is edited with no message before the fact.
- Missing evidence: none.
- Conclusion: resolved with answer — lower severity than the compaction write,
  same shape. Kept inside this record rather than split out, because a single
  prompt-coverage check catches both.
