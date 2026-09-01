# tstx-a-default-install-runs-the-typescript-renderer

## Discovery trigger

The Part 5 scope map left an open question at
`scope-map-and-risk-ranking.md:751-755`: "Which transform path is the shipped
default? ... if `rust-mode-transform.ts` is the default then the CI-verified
TypeScript transform is largely dead code and the never-CI-verified Rust
transform is what users run, which would raise 5c above 5b." Every reachability
label in this sub-part depends on the answer, so it had to be settled before any
other record could be written. The task's `default-production` definition ("state
the evidence, including which implementation a default install actually runs")
makes it a record rather than a preamble, which METHOD.md rule 4 also requires.

## Evidence trail

Read at `HEAD` = `e447c927`.

**1. The schema default.** `packages/plugin/src/config/schema/magic-context.ts:672-677`:

```ts
transform_mode: z
    .enum(["ts", "rust"])
    .default("ts")
    .describe(
        'Experimental: routes the project through the direct mc-host Rust runtime (requires the user-level subc.connection_file path); "ts" is the current TypeScript pipeline.',
    ),
```

`.default("ts")` is `:674`. The type alias at `:478` is
`transform_mode: "ts" | "rust"`, so the field is never optional after parse.

**2. Both downgrades fail toward `ts`.** `packages/plugin/src/config/transform-mode.ts`
has exactly two early returns and both return `mode: "ts"`:

- `:22-27` — `configured === "rust" && !compactionEnabled` returns `ts` with
  `RUST_COMPACTION_OFF_WARNING` (`:12-13`).
- `:34-39` — `configured === "rust" && !userTierConfiguredRust && !userTierHasSubc`
  returns `ts` with `RUST_REQUIRES_USER_CONSENT_WARNING` (`:15-16`).

Only `:41` returns `args.configured` unchanged. So the function is
monotone toward `ts`: it can demote rust, never promote ts.

The comment at `:29-33` gives the reason the consent arm exists: "Rust mode may
demand-start the managed native host and hand it the user's provider credentials.
Project (repo-controlled) config alone must not activate that."

**3. The resolution overwrites the field.** `packages/plugin/src/config/index.ts:605-612`:

```ts
const resolvedTransformMode = resolveTransformMode({
    configured: config.transform_mode,
    userTierConfiguredRust: userLoaded?.config?.transform_mode === "rust",
    userTierHasSubc: hasUserTierSubcConfig(userLoaded?.config),
    compactionEnabled: isCompactionEnabled(config),
});
config.transform_mode = resolvedTransformMode.mode;
```

`:611` is the overwrite. This matters for the property's shape: every later
reader sees the resolved value, so there is exactly one place the decision is
made and no way for a downstream reader to reconstruct the pre-downgrade
intent.

`:607` is the key asymmetry — `userTierConfiguredRust` reads
`userLoaded?.config?.transform_mode`, the **user** tier specifically, while
`configured` at `:606` is the merged value. A project config that sets `rust`
therefore reaches `:34` with `userTierConfiguredRust === false`, and unless the
user tier independently supplies `subc`, it is demoted.

**4. Both dispatch sites read the resolved value.**
`packages/plugin/src/hooks/magic-context/transform.ts:672-673` builds the adapter
only when `deps.transformMode === "rust" && deps.rustModeModuleClient`, and
`:822` is `if (deps.transformMode === "rust")`. `hook.ts:1463` passes
`transformMode: deps.config.transform_mode`, the resolved field.

For a default config, `:822` is false, so control reaches `:861`
(`const reducedMode = sessionMeta.isSubagent`) and the whole TypeScript renderer
below it.

**5. Independent confirmation from a release decision record.**
`docs/specs/prompt-surface/decisions/release-review-resolution.md:30-32`:

> Resolution: the module surfaces (rust transform mode, CC-leg manifest)
> are not public-release surfaces — transform_mode:"rust" is an
> undocumented dev-only flag and the CC leg is our own managed
> deployment.

and `:38`: "npm users have no module in the path."

This is a second, independently authored source reaching the same conclusion by a
different route (release policy rather than config code), which is why the
record's confidence is high rather than medium.

## Failure scenario

The property fails if a default-constructed config resolves to `rust`. Two
concrete ways that could happen without a schema change:

1. `hasUserTierSubcConfig` returns true for a config the user did not author —
   for example if it inspects a shared CortexKit config file rather than the
   user's own tier. Then `:34`'s second disjunct is satisfied and a **project**
   config setting `rust` activates the managed host with the user's credentials,
   which is exactly what `:29-33` says must not happen.
2. A caller reads `config.transform_mode` before `config/index.ts:605-611` runs.
   The overwrite is the only enforcement; there is no branded type preventing a
   pre-resolution read.

Neither is claimed to be reachable. They are the shapes a test should close.

## Timing windows and dependencies

None. Resolution happens once during config load, and the resolved object is held
for the plugin-process lifetime, so the mode cannot flip mid-session. This is
what makes every other record in the part able to assume a fixed mode per pass.

Dependency: `isCompactionEnabled(config)` and `hasUserTierSubcConfig(userLoaded?.config)`
are both outside this part's file set. The property as stated does not depend on
their internals, because the default case reaches neither arm — `configured` is
`"ts"`, so both `:22` and `:34` short-circuit on their first conjunct.

## What a test must construct

The default case is cheap and should be asserted first:

1. Load a config with no `transform_mode` key through `config/index.ts`'s public
   loader. Assert the resolved `config.transform_mode === "ts"` and that
   `configWarnings` contains neither warning constant.
2. Load a config whose **project** tier sets `transform_mode: "rust"` and whose
   user tier sets nothing. Assert the resolved value is `"ts"` and that
   `configWarnings` contains `RUST_REQUIRES_USER_CONSENT_WARNING`. This is the
   security-relevant case named at `transform-mode.ts:29-33`.
3. For the reachability claim proper, drive `createTransform` with a
   default-resolved config and a **throwing** `rustModeModuleClient`. Assert the
   pass completes and the client was never called. That proves the rust arm at
   `:822` is not taken, rather than merely that the output looks like the
   TypeScript renderer's.

Step 3 is the one that makes this a `reachable` record rather than a config unit
test: it asserts which code path a default install executes, which is the premise
the rest of the part rests on.

## Investigation log

### Q: `magic-context.ts:675-676` describes `transform_mode` in the user-facing config schema, which `release-review-resolution.md:31-32` calls "an undocumented dev-only flag". Whether a schema-described flag counts as undocumented for release purposes is a policy question.

- Sources examined: `packages/plugin/src/config/schema/magic-context.ts:672-677`
  (the `.describe()` string); `docs/specs/prompt-surface/decisions/release-review-resolution.md:26-38`;
  `CONFIGURATION.md` searched for `transform_mode`, which appears once, at `:427`,
  documenting the compaction-off downgrade rather than the flag itself;
  `ARCHITECTURE.md:16` and `:26`, which both describe rust mode as an
  "Experimental Rust runtime mode. Gated by `transform_mode: \"rust\"`".
- Findings: the flag is described in the Zod schema, mentioned once in
  `CONFIGURATION.md` (only as the thing compaction-off overrides), and described
  twice in `ARCHITECTURE.md`. It has no `CONFIGURATION.md` entry of its own. So
  "undocumented" is defensible for the user-facing configuration reference and
  false for the architecture document and the schema.
- Missing evidence: whether the schema's `.describe()` strings are published
  anywhere users read — a generated settings reference, an editor completion
  source, or a JSON Schema export. I did not find a generator for it, but I did
  not search the build scripts exhaustively.
- Conclusion: needs human input. The record's own claim (a default install runs
  `ts`) does not depend on the answer, and is high confidence regardless. What
  depends on it is whether the part's seven `explicit-config-only` records
  describe a surface a user could plausibly turn on, which changes their priority
  but not their correctness.

### Q: Is `resolveTransformMode` the only place the mode is decided?

- Sources examined: `grep -rn "resolveTransformMode\|transformMode\|transform_mode"
  packages/plugin/src`, excluding `*.test.ts`, which returns 41 lines across 14
  files. Classified each.
- Findings: exactly one call site (`config/index.ts:605`) and one write
  (`:611`). Every other hit is a read: `hook.ts` (8 reads), `transform.ts` (3),
  `index.ts` (2), `rpc-handlers.ts` (2), `command-handler.ts` (2),
  `hook-handlers.ts` (2), `dream-timer.ts` (2), `dreamer/module-apply.ts` (2),
  `dreamer/task-executor.ts` (2), plus the schema, the resolver, and two comments.
  No second resolver and no second write.
- Missing evidence: none for this question.
- Conclusion: resolved. `config/index.ts:605-611` is the sole decision point, so
  the property has exactly one enforcement site and a test can target it
  directly.
