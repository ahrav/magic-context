# mirror-project-effect-chain-detects-omission

## Discovery trigger

`ClaimMirrorEffect.previous_project_effect_id` has an unusually specific doc
comment: "the source outbox predecessor for this project, making omissions
detectable even when unrelated projects occupy intervening global effect IDs"
(`crates/mc-store/src/claim_mirror.rs:100-102`). That names a defect class the
obvious contiguity check cannot catch, so the two checks must be distinguished.

## Evidence trail

There are two independent ordering checks on a receipt's effects, and they catch
different things.

**Check one, global contiguity, in `validate_group`:**

```
435  let first_effect_id = group.effects.first().map(|effect| effect.effect_id);
437  for (index, effect) in group.effects.iter().enumerate() {
438      let expected_effect_id = i64::try_from(index)
440          .and_then(|index| first_effect_id.and_then(|first| first.checked_add(index)));
441      if expected_effect_id != Some(effect.effect_id) ... {
445          return Err(... "receipt effects must have contiguous positive IDs" ...)
```

(`claim_mirror.rs:435-448`.) This forces the effects *within one receipt* to be a
contiguous ascending run of global IDs. It says nothing about how that run relates
to what the mirror already absorbed, and nothing about per-project continuity.

**Check two, the per-project chain, in `apply_claim_mirror_receipt`:**

```
992  let mut checkpoints = stored_projects
993      .iter()
994      .map(|(project_id, state)| (*project_id, state.acked_effect_id))
995      .collect::<BTreeMap<_, _>>();
996  for effect in &group.effects {
997      let expected = checkpoints[&effect.project_id];
998      if effect.previous_project_effect_id != expected {
999          return Ok(Err(ClaimMirrorError::CheckpointMismatch {
1000             project_id: effect.project_id, expected,
1002             found: effect.previous_project_effect_id,
1003         }));
1004     }
1005     checkpoints.insert(effect.project_id, effect.effect_id);
1006 }
```

(`claim_mirror.rs:992-1006`.) The map is seeded from the *durable*
`acked_effect_id` per project (`read_project_states`, `:625-645`) and then walked
forward, so the check spans the boundary between what is already committed and what
this receipt claims. Because it is keyed per project, a receipt whose project-A
effects skip one of A's outbox positions is refused even though the global IDs are
contiguous, because unrelated project-B effects filled the gap.

The whole loop runs before any mutation: the first write is the per-effect upsert
at `claim_mirror.rs:1051-1061`, and the checkpoint loop at `:992-1006` returns on
the first mismatch, so a receipt with a gap anywhere is refused whole. The
`checkpoints` map's final values are what get written at `:1091`, so a validated
chain is exactly what advances the durable position.

Field-level range validation is weaker than the chain check and must not be
confused with it: `validate_group` only requires
`(0..effect.effect_id).contains(&effect.previous_project_effect_id)`
(`claim_mirror.rs:454-461`), so any predecessor below the effect's own ID passes
static validation. Only the durable comparison at `:998` ties it to reality.

The reseed path sets the same field: `replace_claim_mirror_snapshot` writes
`acked_effect_id` from `snapshot.project_checkpoints[&project_id]`
(`claim_mirror.rs:842`), and `validate_snapshot` requires the checkpoint map to
name exactly the generation-vector projects (`:371-381`) and to be in the safe
range (`:382-392`). So the chain's origin after a reseed is the snapshot's declared
checkpoint, not zero.

Production reachability is `claim.mirror.apply` at
`crates/mc-module/src/lib.rs:10053`, calling
`store.apply_claim_mirror_receipt` at `:10326`, outside any test module.

## Failure scenario

The authority's outbox reader drops one row while streaming a receipt group, then
renumbers the remainder so the group still looks contiguous. Project 41's effects
in this receipt are outbox positions 12 and 14; position 13 was lost. Project 42's
effects occupy the global IDs between them, so
`claim_mirror.rs:435-448` sees a clean contiguous global run and passes.

The per-project chain catches it: after absorbing 41's effect at position 12, the
running checkpoint for 41 is that effect's ID, and 41's next effect declares
`previous_project_effect_id` pointing at position 13, which the mirror never saw.
`CheckpointMismatch { project_id: 41, expected: <12's id>, found: <13's id> }`.

Without the chain check the receipt would be accepted, and project 41's
`acked_effect_id` would jump to position 14's ID (`claim_mirror.rs:1091`). The
claim carried by position 13 would be permanently absent from the mirror, and no
future receipt could reintroduce it, because every future receipt's predecessor
would point at 14 or later. That is the "omits a claim the authority has"
divergence, made unrecoverable — and unrecoverable is literal here, because
`mirror-reset-cycle-requires-a-rebuild-grant` shows production has no reseed path.

## Timing windows and dependencies

- No interleaving window. This is an admission-time structural check.
- Dependency: `read_project_states` (`claim_mirror.rs:625-645`) reads inside the
  same transaction as the check (`:942`, transaction at `:885`), so a concurrent
  apply cannot shift the baseline mid-check.
- Dependency: the project-set equality check at `:942-957` runs first, so
  `checkpoints[&effect.project_id]` at `:997` cannot panic on a missing key —
  every effect's project is validated to exist in `stored_projects` before the
  indexing. Worth noting because the indexing is unguarded.
- Interaction: the generation check at `:963-990` runs before the chain check, so a
  receipt that is both a generation skip and a chain gap reports
  `GenerationMismatch`.

## What a test must construct

1. Seed a mirror with two projects, 41 and 42, at known nonzero checkpoints.
2. The case the existing test misses: build one receipt whose effects interleave
   the two projects, and omit one of project 41's positions while project 42's
   effects occupy the intervening global IDs. Global contiguity must still hold, so
   only `claim_mirror.rs:998` can refuse it. Assert
   `CheckpointMismatch { project_id: 41, .. }` with the right expected and found
   values.
3. Assert the mirror is unchanged after the refusal, including both projects'
   `acked_effect_id`.
4. Reordering: same effects, project 41's two effects swapped. Must be refused.
5. Wrong origin: a receipt whose first effect for project 41 declares a predecessor
   below the stored `acked_effect_id`. Must be refused, proving the check is an
   equality against the durable value and not a `>=`.
6. Negative control: the correct chain must be accepted, and afterwards each
   project's `acked_effect_id` must equal that project's *last* effect ID in the
   receipt, not the receipt's global last effect ID. That distinction is what
   `:1005` and `:1091` implement together.

## Investigation log

### Q: Can a source legitimately emit `0` as a predecessor after a reseed with a nonzero checkpoint?

- Sources examined: `claim_mirror.rs:454-461` (static range validation permits
  `0`), `:842` (reseed writes `acked_effect_id` from the snapshot's checkpoint),
  `:371-392` (`validate_snapshot` allows any checkpoint in `0..=MAX_SAFE_INTEGER`),
  `:998` (equality against the durable value).
- Findings: the two are inconsistent by construction. Static validation accepts
  `0` for any effect, but if the reseed set a nonzero checkpoint then a `0`
  predecessor is a `CheckpointMismatch`. So `0` is only ever valid for a project
  whose checkpoint is genuinely `0`. Nothing in this crate prevents a host from
  emitting `0` after a nonzero reseed; it would simply be refused.
- Missing evidence: whether the host derives the predecessor from its own outbox
  or resets it after a rebuild. That is host-side.
- Conclusion: needs human input.

### Q: Does the chain check protect against a duplicated effect inside one receipt?

- Sources examined: `claim_mirror.rs:449-453` (effect keys must be nonempty and
  unique within the group), `:435-448` (global contiguity), `:992-1006` (the
  chain).
- Findings: yes, doubly. Duplicate `effect_key` is refused at `:449-453`, and a
  repeated `effect_id` breaks global contiguity at `:441`. The chain check adds
  nothing here; its unique contribution is cross-receipt and per-project.
- Missing evidence: none.
- Conclusion: resolved with answer — duplicates are caught by the key-uniqueness
  and contiguity checks, not by the chain.
