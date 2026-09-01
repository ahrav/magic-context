# mirror-generation-advances-exactly-one-per-touched-project

## Discovery trigger

The generation check computes its expectation from a boolean cast:

```
967  let increment = i64::from(touched.contains(project_id));
968  let expected = stored.project_generation.checked_add(increment)
```

(`cratesting/mc-store/src/claim_mirror.rs:967-971`, corrected below.) An
expectation of exactly `stored + 0` or `stored + 1` is a much stronger claim than
"monotonically increasing", and two other mechanisms in the tree turn out to
depend on it.

Correction: the path is `crates/mc-store/src/claim_mirror.rs`. The line numbers
`967-971` are correct.

## Evidence trail

`touched` is the set of projects any effect in the receipt names:

```
958  let touched = group
959      .effects
960      .iter()
961      .map(|effect| effect.project_id)
962      .collect::<BTreeSet<_>>();
```

(`claim_mirror.rs:958-962`.) The check then iterates every project the *mirror*
tracks, not every project the receipt names:

```
963  for (project_id, stored) in &stored_projects {
964      let key = project_id.to_string();
965      let found = group.vector.project_generations[&key];
966      let found_policy = group.vector.policy_generations[&key];
967      let increment = i64::from(touched.contains(project_id));
968      let expected = stored.project_generation.checked_add(increment)...;
972      let expected_policy = stored.policy_generation.checked_add(increment)...;
976      if found != expected { return ... GenerationMismatch ... }
983      if found_policy != expected_policy { return ... GenerationMismatch ... }
```

(`claim_mirror.rs:963-990`.) Three consequences follow from the shape:

1. An untouched project must present `stored + 0`. A receipt that bumps a project
   it does not touch is refused, so the generation vector cannot drift ahead.
2. Project and policy generations move in lockstep, since both use the same
   `increment`. They can never diverge, which raises Q5 in the lens.
3. The indexing at `:965-966` is unguarded, and is safe only because the
   project-set equality check ran first at `:942-957`. That check compares the
   vector's parsed project keys against `stored_projects.keys()`, so every
   iterated project is guaranteed present in both maps.

`checked_add` at `:968` and `:972` maps overflow to `rusqlite::Error::InvalidQuery`
rather than wrapping, and `validate_vector` already bounds generations to
`0..=MAX_SAFE_INTEGER` (`claim_mirror.rs:284-290`), so the arithmetic cannot wrap
into a passing comparison.

The write side matches the check. For each touched project, both the project row
and *every retained claim row in that project* are restamped:

```
1072 tx.execute("UPDATE mc_claim_mirror_claims
1074     SET project_generation = ?1, policy_generation = ?2
1075   WHERE database_incarnation_id = ?3 AND project_id = ?4", ...)
1083 tx.execute("UPDATE mc_claim_mirror_projects
1085     SET project_generation = ?1, policy_generation = ?2,
1086         acked_effect_id = ?3 ...", ...)
```

(`claim_mirror.rs:1072-1095`.) The comment at `:1066-1071` explains why the row
restamp covers untouched rows: the reseed comparison at `:802` compares whole
rows including these fields, so a stale stamp would make the next full
replacement compare unequal and return `ResetRequired`. Untouched *projects* are
absent from the `touched` loop entirely, so neither their project row nor their
claim rows move.

Snapshot-side consistency is enforced too: `validate_claim` requires every claim
in a snapshot or receipt to carry generations equal to its project's entry in the
accompanying vector (`claim_mirror.rs:332-347`), so a payload cannot present a row
whose stamps disagree with the vector it arrives under.

Production reachability is `claim.mirror.apply` at
`crates/mc-module/src/lib.rs:10053` calling `:10326`, outside any test module.

## Failure scenario

Two shapes, both permanent.

**Generation runs ahead.** A receipt bumps a project it does not touch. Without
the `increment` rule the mirror would accept it, and the project's stored
generation would exceed the authority's by one. Every subsequent receipt for that
project then presents `authority_gen = stored_gen`, which the check reads as
`expected = stored + 1` and refuses with `GenerationMismatch`. The project's lane
is wedged.

**Generation stalls.** A receipt touches a project but presents the unchanged
generation. Accepting it would leave two distinct authority states sharing one
mirror generation, which silently breaks the read fence in
`mirror-read-fence-relies-on-generation-advance`: `transform.rs:2008` compares
canonical vectors, so two different mirror contents would compare equal and the
double-read fence would pass over a mutation it should have caught.

In both cases the recovery is a reseed, which
`mirror-reset-cycle-requires-a-rebuild-grant` shows production cannot perform.

## Timing windows and dependencies

- No interleaving window; admission-time arithmetic.
- Depends on the project-set equality check at `:942-957` running first, or the
  map indexing at `:965-966` panics.
- Depended on by the reseed row-equality comparison at `:794-805` (via the row
  restamp at `:1072-1082`) and by the `transform.rs:1978-2011` read fence.
- Runs before the checkpoint chain check at `:992-1006`, so a receipt that is both
  a generation skip and a chain gap reports `GenerationMismatch`.

## What a test must construct

1. Seed a mirror with two projects, 41 and 42, at distinct known generations, and
   with at least two claim rows in project 41 so the untouched-row restamp is
   observable.
2. The arm no existing test covers: submit a receipt touching only project 41
   whose vector bumps *both* 41 and 42. Assert
   `GenerationMismatch { project_id: 42, expected: <stored>, found: <stored+1> }`.
3. Submit a receipt touching only 41 with the correct vector — 41 at `+1`, 42
   unchanged. Assert acceptance, then assert:
   - project 41's row and both of its claim rows carry the new generations,
   - project 42's row and its claim rows are untouched,
   - only project 41's `acked_effect_id` moved.
4. Off-by-two in each direction for a touched project. Both refused.
5. Policy generation moved independently of project generation for a touched
   project. Refused, which pins the lockstep rule and is the evidence for Q5.
6. Round-trip the coupling that matters: after the accepted receipt in step 3,
   build a full snapshot from the mirror's current vector and call
   `replace_claim_mirror_snapshot`. It must hit the byte-equality short circuit at
   `:800-805` and return `Ok`, not `ResetRequired`. That is what the restamp exists
   for and what `tests/claim_mirror.rs:528-590` covers for the single-project case.

## Investigation log

### Q: Must a policy-only change bump the project generation?

- Sources examined: `claim_mirror.rs:963-990` (lockstep `increment`), `:58-68`
  (`ClaimMirrorChangeKind` distinguishes `Applicability`, `Verification`,
  `Lifecycle`, `Derivation` from `Upsert`), `:114-116` (policy-only revocation
  removes a row by setting `claim: None`), `:1072-1082` (both stamps written from
  the same vector).
- Findings: the code makes the two counters strictly redundant. Because
  `increment` is shared, `policy_generation - project_generation` is invariant for
  a project's whole life under receipts. The change-kind enum implies the source
  distinguishes policy changes from content changes, so the second counter looks
  intended to move independently, but the mirror forbids it.
- Missing evidence: the host's reason for modelling two counters, and whether a
  future policy-only receipt is expected to bump only one.
- Conclusion: needs human input.

### Q: Can the indexing at `:965-966` panic?

- Sources examined: `claim_mirror.rs:942-957` (project-set equality), `:965-966`
  (unguarded `BTreeMap` index), `:246-294` (`validate_vector` requires the project
  and policy generation maps to name the same keys, `:263-271`).
- Findings: no. `validate_vector` guarantees both generation maps have identical
  key sets, and `:953` guarantees the vector's project set equals
  `stored_projects`' key set. The loop iterates `stored_projects`, so both indexed
  keys exist. The safety is real but entirely non-local — three checks in two
  functions.
- Missing evidence: none.
- Conclusion: resolved with answer — no panic, but the guarantee is non-local and
  would break if either earlier check were relaxed.
