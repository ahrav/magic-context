# render-a-light-surface-fallback-notice-never-served

## Discovery trigger

Task: verify rather than trust configuration documentation. `prompt_surface.rs`
carries a user-facing notice string asserting that a configured feature is not
implemented yet. Checking whether the assets it refers to are absent showed they
are compiled in unconditionally.

## Evidence trail

All references read back at `HEAD` `e447c927`.

### The notice

`crates/mc-module/src/prompt_surface.rs:28`:

```
pub const LIGHT_FALLBACK_NOTICE: &str = "prompt_surface selected light, but built-in light assets are not available yet; using the byte-identical full guidance and tool descriptions until light assets ship.";
```

### The assets it refers to

`:30-58`:

```
30: pub(crate) const GUIDANCE_FULL_PRIMARY: &str = include_str!("../assets/guidance_primary.txt");
31: pub(crate) const GUIDANCE_FULL_NO_REDUCE: &str = include_str!("../assets/guidance_no_reduce.txt");
32:
33: const GUIDANCE_LIGHT_PRIMARY: Option<&str> =
34:     Some(include_str!("../assets/guidance_light_primary.txt"));
35: const GUIDANCE_LIGHT_NO_REDUCE: Option<&str> =
36:     Some(include_str!("../assets/guidance_light_no_reduce.txt"));
37: const TOOL_LIGHT_DESCRIPTIONS: Option<&[(&str, &str)]> = Some(&[
```

All three are `Option` constants that are unconditionally `Some`. The `Option`
wrapper is the seam the fallback was built around, and it is now permanently
filled.

### The two branches that become unproducible

`guidance_asset` (`:124-144`):

```
139:        PromptSurfacePreset::Light => GuidanceAsset {
140:            bytes: light.unwrap_or(full),
141:            fallback: light.is_none(),
142:        },
```

`light` is `Some` for both variants (`:129-132` selects between the two `Some`
constants), so `unwrap_or(full)` always yields the light bytes and `fallback` is
always `false`.

`tool_manifest_falls_back` (`:156-158`):

```
157:    preset == PromptSurfacePreset::Light && TOOL_LIGHT_DESCRIPTIONS.is_none()
```

always `false`.

### The consumers

Both are in `crates/mc-module/src/lib.rs`, which is sub-part 4c's line range
(`:7134-8005`); cited here as the consumers of a 4e-owned constant, not as 4e
material to analyse.

`handle_prompt_surface_manifest_value` (`:7594-7601`):

```
7594:            "served_preset": if prompt_surface::tool_manifest_falls_back(selection.preset) {
...
7599:            "preset_fallback": prompt_surface::tool_manifest_falls_back(selection.preset),
7600:            "fallback_notice": prompt_surface::tool_manifest_falls_back(selection.preset)
7601:                .then_some(prompt_surface::LIGHT_FALLBACK_NOTICE),
```

`handle_guidance_value` (`:7688`, `:7718-7720`):

```
7688:        let asset = prompt_surface::guidance_asset(selection.preset, variant);
...
7718:            "fallback_notice": asset.fallback.then_some(prompt_surface::LIGHT_FALLBACK_NOTICE),
...
7720:            "manifest_preset_fallback": prompt_surface::tool_manifest_falls_back(selection.preset),
```

So both response fields are permanently `null` / `false`, and the `served_preset`
branch at `:7594` never takes its fallback arm.

### The documentation side agrees the light surface ships

`docs/specs/prompt-surface/light-mapping.md:1-5` opens: "This table maps every
ratified checklist rule whose applicability includes `compressed` to one named,
exact line in the built-in light surface." The table then quotes the actual light
asset lines rule by rule (`G-001` through `T-011` and beyond). Sibling material in
the same directory: `light-validation/manifest.json` plus two per-model validation
records, `checklist.json`, `mutation-results.md`.

So the specification directory documents a shipped light surface, and the notice
string in the source says the opposite. The notice is the stale side.

### Reachability class

`PromptSurfacePreset` derives `Default` with `#[default] Full` (`:71-77`), so the
light preset is not the default and requires explicit configuration. That is why
this record is `explicit-config-only` rather than `default-production`, even though
the branch is unproducible under either setting.

### Existing coverage

`prompt_surface.rs:329-342`, `light_slots_serve_authored_guidance_and_descriptions`:

```
331:            let full = guidance_asset(PromptSurfacePreset::Full, variant);
332:            let light = guidance_asset(PromptSurfacePreset::Light, variant);
333:            assert_ne!(light.bytes.as_bytes(), full.bytes.as_bytes());
334:            assert!(!full.fallback);
335:            assert!(!light.fallback);
...
341:        assert!(!tool_manifest_falls_back(PromptSurfacePreset::Light));
342:        assert!(!tool_manifest_falls_back(PromptSurfacePreset::Full));
```

That is exactly the `unreachable` assertion this record wants, already written. It
runs on `cargo test -p mc-module --lib`, which CI does not invoke
(`docs/properties/part-4-module/_lenses/scope-map-and-risk-ranking.md:409-430`).

## Failure scenario

Not a behaviour defect. Two failure modes, both about trust:

1. A reader — human or agent — who greps for `prompt_surface` and finds the notice
   concludes the light preset is inert and that configuring it changes nothing.
   `light-mapping.md` says otherwise, and the assets prove otherwise. Acting on the
   notice means either skipping a working configuration or filing work that is
   already done.
2. If the light assets are ever removed from the build — a stripped package, a
   feature-gated asset directory — `guidance_asset` starts returning the full bytes
   with `fallback: true` and the manifest starts advertising `served_preset:
   "full"`. That would be silent apart from the notice, and the existing test would
   catch it only where the test runs, which is not CI.

## Timing windows and dependencies

None. Everything here is resolved at compile time.

## What a test must construct

The assertion already exists at `:333-342`. What is missing is execution. The
useful additions:

1. Get `cargo test -p mc-module --lib` into CI, or at minimum this one test, so
   the `unreachable` claim is checked on the artifact that ships.
2. Assert the notice's own claim, so the string cannot rot again: if
   `LIGHT_FALLBACK_NOTICE` is present in the binary, assert that
   `tool_manifest_falls_back(Light)` is `true` for some reachable configuration.
   It is not, so the correct resolution is to delete the notice and both consumers,
   or to comment them as a build-configuration tripwire.
3. Assert the manifest response's `served_preset` equals `"light"` when the light
   preset is configured, which is the caller-visible statement of the same fact.

## Investigation log

### Q: Are the light asset files actually present in the tree?

- Sources examined: the `include_str!` paths at `:34`, `:36`
  (`../assets/guidance_light_primary.txt`,
  `../assets/guidance_light_no_reduce.txt`).
- Findings: `include_str!` is a compile-time failure if the file is absent, and the
  crate compiles at `HEAD` — the existing test at `:329` exercises both constants.
  So both files exist.
- Missing evidence: none.
- Conclusion: resolved with answer — present.

### Q: Does the light surface differ from full, or is the notice's "byte-identical" claim accidentally true?

- Sources examined: `prostompt_surface.rs:333` (`assert_ne!(light.bytes,
  full.bytes)`), `:336-339` (the guidance content hashes must differ),
  `docs/specs/prompt-surface/light-mapping.md`.
- Findings: the test asserts the two differ, and the mapping document quotes
  distinct light lines. So the notice's "byte-identical" wording describes a state
  the code actively asserts against.
- Missing evidence: none.
- Conclusion: resolved with answer — light and full differ; the notice is stale on
  both counts.

### Q: Do the two `DEFAULT_HISTORY_BUDGET_TOKENS` constants matter here?

- Sources examined: `crates/mc-module/src/decay_render.rs:23` (`u32`),
  `crates/mc-module/src/memory_render.rs:16` (`f64`).
- Findings: unrelated to the light surface, but the same class of finding — two
  declarations of one name in two modules of the same sub-part, with the renderer's
  entry points taking `f64` (`decay_render.rs:70`) so the `u32` copy has no caller
  in 4e. Recorded in the lens file's contract-vs-code leads rather than as its own
  property, because there is no behaviour difference today.
- Missing evidence: whether the `u32` constant has a caller elsewhere in the
  workspace.
- Conclusion: unresolved and low value; noted so it is not rediscovered.
