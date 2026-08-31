# dec-a-malformed-config-silently-resolves-to-defaults-and-stops-the-historian

## Discovery trigger

Task 6 asks whether a malformed configuration value is rejected, clamped, or
silently accepted, and whether the caller learns which. Tracing the read path
before the merge path showed that the question has an answer one level earlier
than expected: a malformed *file* never reaches the merge at all, and the merge is
the only thing that produces warnings.

## Evidence trail

The read. `config.rs:254-266`:

```
fn read_tier_cached(cache: &mut TierConfig, path: PathBuf) -> Option<Value> {
    let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
    if cache.path == path && cache.mtime == mtime {
        return cache.value.clone();
    }
    cache.path = path.clone();
    cache.mtime = mtime;
    cache.value = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&strip_jsonc(&raw)).ok(),
        Err(_) => None,
    };
    cache.value.clone()
}
```

Two error paths collapse into one value. A parse failure becomes `None` via `.ok()`
at `:262`. A read failure becomes `None` at `:263`. An absent file also becomes
`None`. All three are indistinguishable to every caller.

The caller. `ConfigCache::effective_for_paths` (`:228-238`):

```
let user = read_tier_cached(&mut self.user, user_path.to_path_buf());
let project = read_tier_cached(&mut self.project, project_path);
let (mut effective, mut warnings) = merge_tiers_with_warnings(user.as_ref(), project.as_ref());
resolve_user_guidance_override(&mut effective, user.as_ref(), user_path, &mut warnings);
emit_warnings(warnings);
```

`merge_tiers_with_warnings` (`:373-573`) is the only warning source, and it takes
`Option<&Value>`. With `None` for both tiers it returns
`(McModuleConfig::default(), Vec::new())`: no user block runs (`:380`), no project
block runs (`:514`), and the only work left is the clamp at `:568-570` and the
dedup at `:571`. So a malformed file produces exactly the same result as no file,
including an empty warning vector.

`emit_warnings` (`:275-279`) prints to stderr and drops the vector:

```
fn emit_warnings(warnings: Vec<String>) {
    for warning in warnings {
        eprintln!("mc-module: config warning: {warning}");
    }
}
```

so even a real warning is not returned to the caller. `effective_for_paths`
returns `McModuleConfig` only.

The downstream consequence is concrete because one default is empty rather than
benign. `config.rs:121`:

```
model_chain: Vec::new(),
```

and `lib.rs:5020-5028`, inside `prepare_historian_fire`:

```
if cfg.model_chain.is_empty() {
    self.record_no_fire(&store, &parsed.session_id, &loaded, "no_models");
    return PreparedHistorianAction::Complete(HistorianDiagnostics {
        fired: false,
        reason: trigger_reason,
        no_fire: Some("no_models".to_string()),
        ...
```

The same guard exists on the wrapup path at `lib.rs:5230`. So the historian
evaluates its trigger, decides it should fire, and then declines because it has no
model, recording a reason that describes a symptom rather than the cause.

`strip_jsonc` (`:640-713`) does not rescue a genuine syntax error. It removes line
comments, block comments, and trailing commas while tracking string state. An
unterminated string leaves the quote in place (`:648-659` keeps pushing while
`in_string`), and the resulting text fails to parse. An unterminated block comment
is consumed to end of input (`:673-680` clamps with `(i + 2).min(chars.len())`), so
the tail of the file disappears, which can also produce invalid JSON.

## Failure scenario

A user edits `~/.config/cortexkit/magic-context.jsonc` to change their historian
model. They leave a stray character, most simply a missing closing brace or an
unescaped quote inside a string. The file is still readable and still looks right
at a glance.

On the next transform pass, `read_tier_cached` reads it, `strip_jsonc` returns
text, `serde_json::from_str` fails, `.ok()` yields `None`. `merge_tiers_with_warnings`
returns the defaults. `model_chain` is empty. `prepare_historian_fire` records
`no_fire: "no_models"`.

From then on the historian never fires. Compartments stop being written, so the
`m1` watermark never advances, so the conversation grows until the force band or
the emergency band takes over and drops content instead of summarizing it. The
user's own model configuration is sitting in the file, syntactically broken, and
the only diagnostic anywhere says `no_models`.

Every other default is benign by comparison: `execute_threshold_percentage` falls
back to the documented `65`, `cache_ttl` to `"5m"`, `memory_enabled` to `true`. The
empty `model_chain` is the one default that is a disabled feature rather than a
sensible value.

## Timing windows and dependencies

The parse itself has no window. The mtime cache introduces a separate one.
`read_tier_cached` keys on `(path, mtime)` at `:256`, so a byte change that does
not move the modification timestamp is not observed. Filesystems with coarse mtime
granularity make that reachable for an edit-save-edit-save sequence inside one
tick. That window is a distinct concern and is listed as an open question on the
record rather than folded into it.

A transient `fs::read_to_string` failure has the same effect for exactly one
resolution, and because the cache stores `None` keyed on the current mtime, it
persists until the mtime changes.

## What a test must construct

Three assertions, all cheap. `config.rs:1191-1229`
(`mtime_cache_reuses_unchanged_reads_and_invalidates_on_mtime_change`) already
builds a real `tempfile::tempdir` with a user file and a project file, so the
fixture exists.

1. Write a syntactically invalid user file, call `effective_for_paths`, and assert
   that the result is distinguishable from the no-file case. Today it is not, so
   the assertion has to be on a new signal: either a returned warning or a new
   field. Stated as a property, the test asserts "a present-but-unparseable file
   produces a warning naming the path".
2. Write a valid file, then an invalid one with a changed mtime, and assert the
   effective config does not silently revert to `model_chain: Vec::new()` without
   a signal.
3. At the handler layer, drive `prepare_historian_fire` with a config whose
   `model_chain` is empty and assert the `no_fire` reason. That part already
   works; the test documents that `no_models` is what a parse failure looks like
   from outside.

## Investigation log

### Q: Is there a last-known-good fallback anywhere?

- Sources examined: `ConfigCache` (`config.rs:215-220`) holds `effective:
  McModuleConfig`; `effective_for_paths` overwrites it at `:236` before returning
  a clone at `:237`. `TierConfig` (`:208-213`) holds `value: Option<Value>` and is
  overwritten at `:263` regardless of outcome.
- Findings: no. The cached `effective` field is written on every call, including
  the failing one, so the previous good value is discarded. The struct looks like
  it could hold a last-known-good but does not use it that way; nothing reads
  `self.effective` other than the write at `:236`.
- Missing evidence: none.
- Conclusion: resolved with answer. There is no last-known-good, and the field
  that could serve as one is unused.

### Q: Does any other component validate the config file and report?

- Sources examined: `CONFIGURATION.md:110` describes doctors that "report `PASS X
  / WARN Y / FAIL Z` summary counts"; `:16` describes a migration that "warns you
  to consolidate by hand". `rg` for `doctor` in `crates/mc-module/src` finds the
  mandatory-ring doctor work named in the scope map's provenance line, not a
  config validator.
- Findings: the documented doctor is a plugin-side capability. Nothing inside
  `mc-module` validates its own config file, and the module is the component that
  reads it directly, by design: `config.rs:2-3` says it "intentionally reads user
  and project tiers directly instead of depending on a daemon config plane".
- Missing evidence: whether the TypeScript doctor parses the same file with the
  same JSONC dialect. If it does, a user who runs the doctor would see the error,
  but nothing prompts them to.
- Conclusion: unresolved, needs a look at the plugin doctor, which is outside 4f
  scope. The record stands on the module's own behaviour.
