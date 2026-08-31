# hv-side-channel-anchor-out-of-range-drops-silently

## Discovery trigger

Task item 3 asks which content-integrity invariants the code ACTUALLY asserts.
The side-channel anchor bound is the one real "no fabricated references" check in
the module, so it deserved a close read. The read showed the check exists and its
disposition is a silent filter, not a rejection or a counted drop.

## Evidence trail

The bound, `crates/mc-module/src/historian_validate.rs:1086-1098`:

```rust
fn keep_side_channel(
    origin_compartment_index: Option<u64>,
    persisted_count: u64,
    discarded_last: bool,
) -> bool {
    if discarded_last {
        return false;
    }
    match origin_compartment_index {
        Some(index) => (1..=persisted_count).contains(&index),
        None => !discarded_last,
    }
}
```

This is a genuine anti-fabrication check: an anchor must name a compartment that
actually persisted in THIS run, 1-based. `source_compartment`
(`historian.rs:69-78`) relies on it, doing
`origin.and_then(|i| i.checked_sub(1)).and_then(|i| compartments.get(i as usize))`,
so an out-of-range anchor would simply resolve to `None` there.

Its disposition at all four call sites is `.filter`, so a rejected item vanishes:

- facts, `:573-584`
- events, `:589-599`
- primer candidates, `:600-612`
- user observations, `:613-624`

None returns `Err`. None increments a counter. None logs. Grepped the module for
any logging or metric facility: `historian_validate.rs` imports only `BTreeMap`,
`OnceLock`, `regex`, `serde`, and one `crate::boundary` function (`:11-17`), so it
structurally cannot report a drop.

A second, undocumented truncation sits in the same expression chain, `:600-612`:

```rust
let primer_candidates = parsed.primer_candidates.into_iter()
    .filter(|candidate| { ... })
    .take(1)
    .collect();
```

`.take(1)` at `:611`. No comment explains it; the comment block at `:585-588`
above discusses discard-last anchor invalidation, not a primer cap. Compare the
`PrimerCandidate` doc at `:163-170`, which describes the anchor and says nothing
about a one-per-run limit. So a model that emits three primer questions has two
silently discarded.

Two further behaviours in the same block, both documented, recorded so they are
not mistaken for defects:

- `force_keep_last_compartment` suppresses facts, primers, and observations
  entirely via the `!options.force_keep_last_compartment &&` conjunct
  (`:577`, `:604`, `:617`), while events use a different rule that retains
  earlier anchored events (`:593-597`). The comment at `:585-588` explains this.
- `discarded_last` suppresses every side channel via the early return at
  `:1091-1093`. Also explained at `:585-588`, and covered by
  `discarded_last_suppresses_every_side_channel_for_the_whole_run` (`:1815`).

Dead code note: because `:1091-1093` returns early when `discarded_last` is true,
the `None => !discarded_last` arm at `:1096` can only ever be reached with
`discarded_last == false`, so it always evaluates to `true`. Harmless, but it
makes the function look like it handles a case it does not.

Reachability of each channel by default:

- facts: `memory_enabled` defaults true (`config.rs:124`) and `auto_promote`
  defaults true (`config.rs:126`); `ValidateOptions` defaults both true
  (`:108-109`). Reachable by default.
- events, primer candidates: no config gate in `ValidateOptions`. Reachable by
  default.
- user observations: `user_memory_collection_enabled` defaults FALSE
  (`config.rs:127`, `:110`), and publish only stores them when
  `collect_user_memory_candidates` is set (`historian.rs:1724`, documented at
  `:422-423`). So the observation channel is off by default and the practical
  exposure is facts, events, and primers.

## Failure scenario

Chunk 60..=99. The model emits four compartments and five facts, anchoring two of
them to compartment 4:

```
<facts><PROJECT_RULES>
* [origin_compartment="4"] The deploy script requires the vault token to be exported first.
* [origin_compartment="2"] Tests run with --test-threads=1.
</PROJECT_RULES></facts>
```

The anchor prefix is parsed by `split_anchor_prefix` (`:1136-1146`) via
`side_channel_anchor_regex` (`:1295-1303`), which accepts
`[origin_compartment="4"]`.

Now discard-last fires: four compartments, lookahead distance 0, so `:555` pops
the fourth and `discarded_last` becomes true. `persisted_count` is 3 (`:572`).

`keep_side_channel` returns `false` for BOTH facts, because the early return at
`:1091-1093` fires on `discarded_last` regardless of the anchor. Both facts are
filtered at `:576-583`. The vault-token rule, which the model correctly extracted
and correctly anchored, is gone.

That case is documented (`:585-588`: "A discarded lookahead compartment
invalidates the whole producer output's anchors"), so the intent is defensible.
The undocumented case is the narrower one: with `discarded_last == false` and
`persisted_count == 3`, a fact anchored to `4` is dropped by
`(1..=3).contains(&4) == false` at `:1095`, silently, with no signal.

Consequence either way: a fact the model produced is not stored, and nothing
distinguishes that from a model that produced no facts. Operationally, the
symptom is "the fact table stops growing", with no counter to attribute it. The
status block (`lib.rs:6358-6360`) reports only publish-failure counts, and
`last_failure` is not set because the run SUCCEEDED.

## Timing windows and dependencies

No interleaving. The dependency is on `discarded_last`, which is decided at
`:539-558` in the same call, so the anchor bound and the discard decision
interact within one validation pass. That coupling is the reason a per-run counter
would be genuinely informative: it would separate "anchors were out of range"
from "the run discarded its last compartment", which today produce identical
observable output (nothing).

## What a test must construct

The filtering behaviour is already partly covered:
`zero_side_channel_anchor_is_suppressed` (`:1774`) and the golden case "events
beyond persisted compartment count are filtered". Neither asserts observability.

To construct the property:

1. Chunk `60..=99`, four contiguous compartments, `in_emergency: true` so
   discard-last does NOT fire and `discarded_last` stays false, isolating the
   anchor bound from the discard rule.
2. Facts anchored to `1`, `4`, and `5`, plus one unanchored.
3. Assert the accepted facts are exactly the `1` and the unanchored one, which
   holds today, AND assert that the two dropped items are reported. The second
   assertion has nothing to observe today, which is the finding. The cheapest
   observable is to change the return type to carry a drop count, which is a
   remediation and out of scope here; the record's job is to state the obligation.

For the `.take(1)` primer cap, a separate table test: emit 1, 2, and 3 primer
candidates all anchored in range with `discarded_last == false`, and assert the
accepted count. Today it is `min(n, 1)`. Writing that down converts an
undocumented behaviour into a pinned one.

## Investigation log

### Q: Should `.take(1)` on primers be a documented cap or a reject when more than one survives?

- Sources examined: `historian_validate.rs:600-612` (the expression),
  `:163-170` (`PrimerCandidate` and its doc, which mentions only the 1-based
  anchor), `:585-588` (the nearby comment, which is about anchor invalidation),
  `:231` (`ValidatedChunk.primer_candidates`, no doc comment), `historian.rs:96-121`
  (`to_store_primer` area, reached via `source_compartment`),
  `historian_prompt.rs` (searched for a primer count constant; `SEED_FLOOR = 4`
  and `SESSION_REF_WINDOW = 6` exist at `:13-15`, no primer constant).
- Findings: The cap is real, silent, and undocumented. No constant names it, so it
  is not a tunable. The `Vec` type on both `ParsedCompartmentOutput.primer_candidates`
  (`:198`) and `ValidatedChunk.primer_candidates` (`:231`) advertises a plural that
  the gate reduces to at most one.
- Missing evidence: whether the durable primer table is designed for one row per
  run. That is a `mc-store` schema question not read in this pass.
- Conclusion: needs human input. Either disposition is defensible; what is not
  defensible is a silent `.take(1)` behind a plural type with no comment.

### Q: Is the anchor bound the only anti-fabrication check in the module?

- Sources examined: all of `historian_validate.rs:264-1098`, looking for any check
  that compares a model-supplied reference against a known set.
- Findings: Three checks compare model output against a known set:
  `:941-957` (endpoint ordinals must exist as chunk lines), `:1021-1032`
  (endpoints must be present ordinals), and `:1094-1097` (anchors must name a
  persisted compartment). The first two are ordinal-existence checks that also
  serve contiguity; the third exists only to bound a reference. Everything else is
  ordering, bounds, or presence.
- Missing evidence: none needed.
- Conclusion: resolved with answer — yes, `:1094-1097` is the only check whose sole
  purpose is to reject a fabricated reference, and its disposition is a filter.
  That is worth stating plainly, because "the gate checks references" is true of
  exactly one field pair and false of all body text.
