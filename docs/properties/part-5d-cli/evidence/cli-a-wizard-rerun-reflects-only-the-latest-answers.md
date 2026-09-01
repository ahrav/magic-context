# cli-a-wizard-rerun-reflects-only-the-latest-answers

## Discovery trigger

The task asks whether re-running a wizard is idempotent. Reading
`writeMagicContextConfig` key by key to answer that produced a split result: the
two keys the scope map flagged as suspicious (`dreamer.enabled`,
`sidekick.enabled`) are handled correctly and unconditionally, while three keys
nobody had flagged are write-only.

## Evidence trail

**The writer.** `packages/cli/src/commands/setup-opencode.ts:234-302`. It reads
the existing file with `readJsoncConfigForUpdate` at `:248`, mutates the parsed
object, and writes the whole file with `writeFileAtomic` at `:301`. Because the
parse is `comment-json`, comments survive the round trip; the concern here is
values, not formatting.

**Idempotent keys.**

| Key | Enable arm | Disable arm | Idempotent? |
| --- | --- | --- | --- |
| `$schema` | set when absent, `:251-254` | n/a | yes, converges |
| `historian.model` | set when a model was picked, `:256-260` | n/a; a model is always picked | yes |
| `dreamer.enabled` | `delete` unconditionally, `:263` | same `delete`, same line | yes |
| `dreamer.disable` | `delete`, `:265` | `= true`, `:276` | yes, both directions written |
| `sidekick.enabled` | `delete` unconditionally, `:281` | same line | yes |
| `sidekick.disable` | `delete`, `:283` | `= true`, `:289` | yes |

**Write-only keys.**

| Key | Written | Removed when the answer flips | Lines |
| --- | --- | --- | --- |
| `dreamer.model` | when `dreamerEnabled && dreamerModel` | **never**; the else arm at `:275-277` sets only `disable` | `:266-268` |
| `dreamer.tasks` | when `options.dreamerTasks` is present | **never** | `:272-274` |
| `sidekick.model` | when `sidekickEnabled && sidekickModel` | **never**; the else arm at `:288-291` sets only `disable` | `:284-286` |
| `cache_ttl.default` | `"5m"` when absent and `claudeMax` | **never** | `:294-295` |
| `cache_ttl["anthropic/claude-sonnet-4-6"]` | `"59m"` when `claudeMax` | **never** | `:296` |
| `cache_ttl["anthropic/claude-opus-4-6"]` | `"59m"` when `claudeMax` | **never** | `:297` |

`:293` is `if (options.claudeMax) {` and there is no `else`, so a `false` answer
is a no-op rather than a retraction.

**`dreamer.tasks` has a second asymmetry.** `runDreamerSetup` returns `tasks`
only when the user declines the recommended schedules
(`dreamer-setup.ts:112-118`), and the comment at `:9-15` and
`setup-opencode.ts:269-271` both state the intent: leave `tasks` unset so schema
defaults apply and the config stays small. So a user who customises schedules
once and later accepts the recommendations keeps their old custom `tasks` record,
and the wizard reports "Dreamer: enabled" in the summary (`:586-588`) with no
mention of the retained schedules.

**Why the `enabled` deletes are safe.** The scope map's focus 1 asked what the
runtime reads. `packages/plugin/src/config/agent-disable.ts`:

- `isDreamerRunnable` is `!!config.dreamer && config.dreamer.disable !== true`
  (`:11-13`); `isSidekickRunnable` is the same shape (`:15-17`). Neither reads
  `enabled`.
- `migrateLegacyEnabledForAgent` (`:46-84`) deletes `enabled` in memory at `:54`
  and, for `dreamer` and `sidekick`, converts a legacy `enabled === false` into
  `disable = true` with a warning (`:64-73`, `:74-83`). `historian.enabled` is
  removed with a success message (`:56-59`).

So the wizard's unconditional deletes agree with the loader, and
`doctor-opencode.ts:98-150` persists the same migration on disk. The scope map's
concern that "the wizard's delete silently changes behaviour" does not hold.

**The comparable Pi writer is closer to idempotent by construction.**
`setup-pi.ts:216-280` builds each block with `compactObject` over a spread of the
existing block plus explicit `undefined`s: `disable: options.dreamerEnabled ?
undefined : true` (`:250`), `enabled: undefined` (`:251`), `tasks:
options.dreamerEnabled ? options.dreamerTasks : undefined` (`:254`). Since
`compactObject` drops `undefined` keys (`:150-156`), disabling the dreamer there
clears `tasks`. `dreamer.model` still survives, because the spread reinstates it
and `:249` only overwrites when a model was supplied. And the embedding block is
the one place where a retraction is explicit and documented: `:268-278` clears
`model`, `endpoint`, and `api_key` when the provider is `local`, with the comment
at `:268-270` — "A local choice clears the remote-provider keys AND any explicitly
pinned model a previous setup run wrote, so re-running the wizard restores the
plugin's default-model behavior instead of preserving a stale pin." That is the
pattern this record wants applied to `cache_ttl`.

## Failure scenario

A Claude Max subscriber runs `setup`, answers yes at `:474`, and gets
`cache_ttl: {default: "5m", "anthropic/claude-sonnet-4-6": "59m",
"anthropic/claude-opus-4-6": "59m"}`. Six months later the subscription lapses.
They re-run `setup` and answer no. The `cache_ttl` block is unchanged, so Magic
Context continues to assume a 59-minute prompt cache for those two models and
defers context operations accordingly. The wizard's summary (`:580-592`) does not
list `cache_ttl` at all, so nothing on screen contradicts the user's belief that
they answered the question.

Second scenario, closer to a support burden: a user enables the dreamer with
model X, customises every task schedule, then re-runs `setup` and disables the
dreamer. `magic-context.jsonc` now reads
`dreamer: {disable: true, model: "X", tasks: {...twelve entries...}}`. The block
looks fully configured and is entirely inert. `checkUserMemoriesDreamerCompatibility`
(`doctor-opencode.ts:160-175`) warns about exactly one instance of this shape —
a scheduled `review-user-memories` under `disable: true` — which is evidence the
confusion is real and that the general case is unaddressed.

## Timing windows and dependencies

No timing angle; this is per-invocation value semantics.

Two dependencies:

- The property is about `writeMagicContextConfig` alone. The other writers in the
  commit block are convergent by construction:
  `addPluginToOpenCodeConfig` guards each edit with a `changed` flag and only
  writes when something differs (`:98`, `:163`), and `addPluginToTuiConfig`
  returns early when an entry already exists (`:190-192`).
- The claim "the `enabled` deletes are safe" depends on
  `agent-disable.ts:11-17` remaining the only readers. There is precedent for
  enforcing that mechanically: `compaction-accessor-guard.test.ts` asserts no
  non-schema source file reads `compaction.enabled` directly, with the accessor
  declared the only reader at `agent-disable.ts:23-30`. No equivalent guard
  exists for `dreamer.enabled` or `sidekick.enabled`.

## What a test must construct

Unlike the other wizard records, this one needs no flow harness:
`writeMagicContextConfig` is exported and already imported by
`setup-opencode.test.ts:10`.

1. Call `writeMagicContextConfig(path, A)` with
   `{historianModel: "m", dreamerEnabled: true, dreamerModel: "d",
   dreamerTasks: {verify: {schedule: "0 9 * * *"}}, sidekickEnabled: true,
   sidekickModel: "s", claudeMax: true}`.
2. Call `writeMagicContextConfig(path, B)` with the same historian and everything
   else off: `dreamerEnabled: false, dreamerModel: null, dreamerTasks:
   undefined, sidekickEnabled: false, sidekickModel: null, claudeMax: false`.
3. Call `writeMagicContextConfig(freshPath, B)` on an empty file.
4. Assert the two results are deeply equal. At `HEAD` they differ by
   `dreamer.model`, `dreamer.tasks`, `sidekick.model`, and three `cache_ttl`
   entries.
5. Assert the both-directions keys explicitly so a fix cannot regress them:
   after B, `dreamer.disable === true`, `sidekick.disable === true`, and
   `"enabled" in config.dreamer === false`.
6. Add the A→B→A round trip and assert equality with a single A, which catches an
   over-eager fix that deletes a key it should have preserved.
7. Consider a guard test in the style of `compaction-accessor-guard.test.ts`
   asserting that no non-schema source file reads `dreamer.enabled` or
   `sidekick.enabled`, which is what makes step 5's deletes provably harmless
   rather than harmless-today.

## Investigation log

### Q: Is retaining `dreamer.model` under `disable: true` deliberate, so re-enabling restores the prior model?

- Sources examined: `setup-opencode.ts:262-278` (the dreamer block), `:275-277`
  (the disable arm), `:280-291` (sidekick, same shape); `setup-pi.ts:246-255`
  (the `compactObject` form, which clears `tasks` but keeps `model`);
  `dreamer-setup.ts:9-15` and `setup-opencode.ts:269-271` (the
  keep-`tasks`-unset intent); `agent-disable.ts:11-13`.
- Findings: there is a coherent argument for retaining `model` — a disabled agent
  with a remembered model is a friendlier re-enable, and `isDreamerRunnable`
  ignores `model` entirely so the retention is inert. That argument does **not**
  extend to `cache_ttl`, which is read by the caching layer regardless of any
  agent's enabled state, so a stale `59m` changes behaviour rather than merely
  sitting in the file. It also does not extend cleanly to `tasks`: the two
  comments state a positive intent to leave `tasks` unset so schema defaults
  apply, and retaining a custom record after the user accepted the recommended
  schedules contradicts that intent within the same wizard run.
- Missing evidence: no comment addresses the disable-arm retention for `model` or
  `tasks`, and none addresses `cache_ttl` retraction at all.
- Conclusion: needs human input for `model`; the `cache_ttl` and `tasks` cases
  look like oversights rather than choices, and the `setup-pi.ts:268-278`
  embedding block is a worked precedent for how to retract.

### Q: Should the OpenCode writer adopt `setup-pi.ts`'s explicit-clear pattern for `cache_ttl`?

- Sources examined: `setup-pi.ts:268-278` and its comment at `:268-270`;
  `setup-opencode.ts:293-299`; `:466-478` (the Claude Max prompt and its
  `hasAnthropic` gate at `:467`).
- Findings: the pattern transfers directly — an `else` arm on `:293` deleting the
  two model keys and leaving `cache_ttl.default` alone would do it. One
  complication: the prompt only appears when an `anthropic/` model was discovered
  (`:467`), so a user whose model list changes between runs is never asked and an
  unconditional `else` would then delete entries the user may have set by hand.
  The safe form retracts only when the question was asked and answered no, which
  means threading a tri-state rather than a boolean, or scoping the retraction to
  the two exact keys the wizard writes and only when `hasAnthropic` is true.
- Missing evidence: whether users are expected to hand-edit `cache_ttl`. The
  schema permits arbitrary model keys, so probably yes, which is why the
  narrow-scope form is the right one.
- Conclusion: resolved with answer — yes, adopt it, scoped to the two keys the
  wizard writes and gated on the prompt having been shown. Recorded so a fix does
  not delete hand-written entries.
