# hv-importance-unbounded-then-truncating-cast

## Discovery trigger

Task item 4 asks about output whose declared counts disagree with its content.
`<unprocessed_from>` is the well-guarded declared value, cross-checked at
`crates/mc-module/src/historian_validate.rs:1054-1074`. The other declared
numeric is `importance`, which the gate parses and never checks. Following it to
storage found a truncating `u64 -> i32` cast.

## Evidence trail

The full path of an `importance` value, every step read at HEAD.

1. Regex, no bound: `historian_validate.rs:1193-1196`

```rust
fn attr_importance_regex() -> &'static Regex {
    RE.get_or_init(|| Regex::new(r#"\bimportance="(\d+)""#).unwrap())
}
```

`\d+` with no length limit and no value range.

2. Capture into `u64`: `:306` calls `capture_u64(attr_importance_regex(), attrs)`,
   and `capture_u64` (`:1106-1110`) does `m.as_str().parse::<u64>().ok()`. A value
   above `u64::MAX` returns `None` and defaults later; anything in `u64` range is
   accepted verbatim.

3. Stored on the parsed struct as `Option<u64>`: `:134`, assigned at `:327` and
   `:344`.

4. Copied to the validated struct unchanged: `:976` `importance: compartment.importance`.
   `ValidatedCompartment.importance` is `Option<u64>` (`:220`).

5. Never validated. Read all of `validate_parsed_compartments` (`:983-1084`) and
   `validate_historian_output` (`:450-641`): `importance` appears in neither. No
   range check, no clamp, no reject.

6. Truncating narrow at the publish projection, `historian.rs:57`:

```rust
importance: c.importance.map(|i| i as i32).unwrap_or(50),
```

`i` is `u64`; `as i32` truncates to the low 32 bits and reinterprets as signed.
`4294967295u64 as i32 == -1`. `2147483648u64 as i32 == i32::MIN`.

7. Stored as-is. `StoredCompartment.importance` is `i32`
   (`mc-store/src/lib.rs:2763`); the insert binds `c.importance as i64`
   (`:12288`). The schema is `importance INTEGER NOT NULL DEFAULT 50`
   (`:455`) with no CHECK constraint. Read at `:7950` as
   `r.get::<_, Option<i64>>(13)?.unwrap_or(50) as i32`. No clamp at any store
   layer.

8. Clamped only at render, `decay_render.rs:269-272`:

```rust
let importance = compartments[original_index]
    .importance
    .unwrap_or(50)
    .clamp(1, 100);
```

So a wrapped negative becomes `1`, the LOWEST importance, feeding `DecayInput`
(`:273-276`) and `compute_budget_pressure` (`:277-281`).

The documented band is 1..=100. `decay_render.rs:27` says "`importance` defaults
to 50 when absent"; `historian_prompt.rs:17` defines
`SEED_BANDS: [(85, 100), (60, 84), (30, 59), (10, 29), (1, 9)]` and
`seed_band_index` (`:127-138`) returns band 0 for `> 100` and the last band
otherwise, so a negative lands in the `(1, 9)` band there too.

## Failure scenario

The model emits an otherwise perfect compartment for the most consequential
stretch of the session and marks it maximally important, but formats the number
wrongly, for example as a scaled integer:

```
<compartment start="1" end="20" title="Root cause of the outage" episode_type="incident" importance="4294967295"><p1>...</p1></compartment>
```

Gate: no importance check exists, so every one of the 22 rejecting checks passes
on ordinals and tiers alone. The compartment publishes.

Projection: `4294967295u64 as i32` is `-1`. The durable row holds
`importance = -1`.

Render: `(-1).clamp(1, 100)` is `1`. The compartment the model called maximally
important is now the least important input to the decay curve, so it is the first
to be demoted to a denser paraphrase tier under budget pressure, and the first
trimmed if a trim occurs. The precise inversion the model tried to prevent.

Prompt feedback: `seed_band_index(-1)` returns the last band, so if this row is
ever used as a calibration reference it teaches the next run that this content is
low importance.

The failure is silent at every step. No log, no counter, no status field. The
durable row is simply wrong, and every reader that clamps will read it as
lowest-importance rather than noticing the impossible value.

## Timing windows and dependencies

None. Single-firing input admission.

The dependency that turns a wrong number into a wrong OUTCOME is
`decay_render.rs:271`'s clamp. If it clamped to `50` (the documented default) the
consequence would be neutral; clamping to `1` maps every out-of-band value to the
worst end of the scale. Note the clamp is correct as a defensive measure for its
own contract; the defect is upstream.

## What a test must construct

Two tests, both cheap:

1. Gate level, direct unit test. Chunk `1..=20`, one compartment with
   `importance="4294967295"`, valid tiers and `<unprocessed_from>21</unprocessed_from>`.
   Assert the property: `validated.compartments[0].importance` is within `1..=100`
   or the call returned `Err`. Today it returns `Ok` with `Some(4294967295)`,
   which is the finding.
2. Projection level. Call `to_stored_compartment` with
   `importance: Some(4294967295)` and assert `stored.importance >= 1`. Today it is
   `-1`. This one is worth having separately because it catches the cast even if
   the gate later grows a clamp instead of a reject.

A boundary table is the right shape here, since the interesting values are few
and known: `0`, `1`, `50`, `100`, `101`, `i32::MAX as u64`,
`i32::MAX as u64 + 1`, `u32::MAX as u64`, `u64::MAX`. Note `importance="0"` is
also out of the documented band and is admitted today, clamping to `1` at render,
so the low end matters as much as the overflow.

## Investigation log

### Q: Are there stored-compartment consumers besides decay_render that read importance without clamping?

- Sources examined: `rg -n "importance" crates/mc-store/src/lib.rs` (hits at
  `:455`, `:2763`, `:5721`, `:7950`, `:7966`, `:8029`, `:8067`, `:8104`, `:8709`,
  `:8713`, `:8763`, `:12256`, `:12267`, `:12288`, `:12362`, `:12379`),
  `mc-store/src/lib.rs:9877-9881` (the memory render ordering comment: "by
  importance descending then id ascending (the budget-trim order — highest
  importance survives a trim)"), `decay_render.rs:269-272`,
  `historian_prompt.rs:127-138`.
- Findings: The store hits are schema, struct field, column lists in SELECT and
  INSERT statements, and binds. None applies a range check. The `:9877-9881`
  comment describes an importance-ordered trim, which means a negative value sorts
  last and is trimmed first, an unclamped consumer with a real consequence, though
  that ordering is documented for MEMORY rows rather than compartment rows.
- Missing evidence: whether the memory trim ordering at `:9877-9881` ever sees a
  value derived from a compartment's `importance`. Facts promoted from the
  historian carry their own category and content
  (`historian_validate.rs:140-150`) with no importance field, so the two look
  independent, but the promotion projection in `historian.rs` was not fully
  traced in this pass.
- Conclusion: unresolved, needs a sweep of `mc-store` compartment and memory
  readers. What IS established: no store-layer clamp exists, so any consumer that
  does not clamp for itself reads the wrong value.

### Q: Does the TypeScript side bound importance, making this a Rust-only divergence?

- Sources examined: `testdata/validate-golden.json` (all 16 cases inspected for
  their importance values), `historian_validate.rs:1367-1375` (the test helper,
  which hardcodes `importance="50"`), `historian.rs:1912` and `:4008-4009`,
  `:4076` (inline fixtures, using `50` and `60`).
- Findings: Every fixture in the tree uses an in-band value, so the golden oracle
  never exercises an out-of-band one and cannot tell us what TypeScript does. The
  golden therefore does not constrain a Rust-side clamp: adding one would change
  no recorded verdict.
- Missing evidence: the TypeScript validator source.
- Conclusion: unresolved, needs the TypeScript validator. Usefully, the answer does
  not block a fix, because no golden case would change.
