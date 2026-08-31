# note-b-selection-is-invariant-under-candidate-permutation

## Discovery trigger

A sibling part established that this repository uses ordered maps and explicit
sorts wherever an artifact's order is load-bearing. My brief asked whether note
evaluation follows that discipline or diverges. It follows it, and the reason it
is worth a record rather than a footnote is that the boot-ephemeral selection
cursor and the durable acquisition ledger must agree about which note a given
poll selected, so a permutation-sensitive selector would desynchronize them
across a replay.

## Evidence trail

1. All four phase selectors sort explicitly and all four end the key with the
   note id:
   - `get_due_compiled_smart_note_checks`:
     `sort_by_key(|note| (note.check_next_due_at.unwrap_or(0), note.id))`
     (`crates/mc-module/src/smart_note_evaluation.rs:728`).
   - `get_smart_notes_needing_compilation`:
     `sort_by_key(|note| (note.created_at, note.id))` (`:752`).
   - `get_stale_compiled_smart_notes`:
     `sort_by_key(|note| (note.check_false_since_at.unwrap_or(0), note.id))`
     (`:780`).
   - `get_fallback_smart_notes`:
     `sort_by_key(|note| (note.last_checked_at.is_some(),
     note.last_checked_at.unwrap_or(0), note.id))` (`:797-803`).
2. `unwrap_or(0)` makes the `Option` keys total rather than leaving `None`
   ordering implicit, so a NULL column sorts first deterministically instead of
   depending on how `Option`'s ordering interacts with the surrounding tuple.
3. Note ids are unique (`mc_notes.id` is the rowid; the store selects by
   `tx.last_insert_rowid()` at
   `crates/mc-store/src/lib.rs:10163` and `:10199`), so the composite key is a
   total order and `sort_by_key`'s stability is not load-bearing.
4. The module contains no unordered-collection iteration at all. There is no
   `HashMap`, `HashSet`, `BTreeMap`, or `BTreeSet` in the file; the only
   collections are `Vec` and the `u64` bitmasks in `ParsedCron`
   (`:54-62`). The only iteration over caller data is
   `notes.iter().filter(...).collect()` in the four selectors, which preserves
   input order into a `Vec` that is then sorted.
5. The store presents candidates in a declared order:
   `ORDER BY id` on the candidate query (`mc-store:13296`). So even the
   pre-sort order is deterministic, which means the sorts are defence in depth
   rather than the sole guarantee.
6. `select_smart_note_evaluation_cycle` (`smart_note_evaluation.rs:900-949`)
   introduces one more ordering decision, the fallback exclusion:
   `get_fallback_smart_notes(notes, notes.len(), retina_handoff).into_iter()
   .find(|note| !cycle.attempted_fallback.contains(&note.id))` (`:932-937`).
   `find` on an already-sorted `Vec` picks the first non-excluded note in sort
   order, so the exclusion does not reintroduce order dependence.
   `attempted_fallback` is a `Vec<i64>` searched with `contains`, which is
   membership, not order.
7. The phase loop itself is over a `&'static` slice
   (`FULL_CYCLE_PROFILE` at `:843-848`, `NONBILLABLE_CYCLE_PROFILE` at
   `:849-852`), iterated with `.iter().enumerate().skip(cycle.phase_index)`
   (`:907`). Fixed order, no map.

## Failure scenario

The property holds today, so the scenario is what a regression would cause. Drop
the `note.id` tiebreak from `get_due_compiled_smart_note_checks`, leaving
`sort_by_key(|note| note.check_next_due_at.unwrap_or(0))`. Two notes share a
`check_next_due_at`, which is common because `next_smart_note_check_due_at`
clamps to the ceiling (`:255`) and many notes with no usable cron land on
`SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS` plus jitter drawn from a 121-second
window.

A poll selects one of them. The store commits the claim with that note id and
the acquisition id (`mc-store:13303-13345`). The response is lost. The client
retries with the same `acquisition_id`, and the store replays the recorded claim
(`mc-store:13212-13240`) rather than re-running selection, so the replay is
still correct. But the *cursor* advanced for one note and the *ledger* records
another only if selection is re-run, which happens on the `cycle_exhausted`
classification path (`lib.rs:11220-11229`): that second call runs selection
again against a fresh cycle on the same candidate slice. If the slice's order
were unstable between the two calls within one poll, the two runs would disagree
and `cycle_exhausted` could be computed for a different note than the one the
first run considered.

## Timing windows and dependencies

No interleaving. The dependency is a tie on the phase's primary sort key, which
requires two notes eligible for the same phase with equal `check_next_due_at`,
`created_at`, `check_false_since_at`, or `last_checked_at` depending on the
phase. `created_at` ties are the easiest to construct: two notes written in the
same millisecond, since both writes take `now_ms` from the same facade call's
`now` when batched, and `insert_project_note` stores it directly
(`mc-store:10197`).

## What a test must construct

1. Build a `Vec<SmartNoteSelectionSnapshot>` of at least three notes eligible for
   one phase, with the primary sort key equal across all of them and distinct
   ids.
2. Call `select_smart_note_evaluation_cycle` on the slice and record the
   returned `(note_id, phase)`.
3. For every permutation of the slice (three notes gives six permutations; a
   property test can sample from a larger set), call again with a freshly
   constructed cycle and assert the same `(note_id, phase)`.
4. Repeat per phase, so each of the four sort keys is exercised. The fallback
   phase needs a second assertion because of the `attempted_fallback` exclusion:
   drive two consecutive selections and assert the *sequence* of note ids is
   permutation-invariant, not just the first element.

This is a natural `proptest` shape: generate a set of snapshots, generate a
permutation, assert equality of the selection. No store, no clock, no faults.

## Investigation log

### Q: Does `sort_by_key`'s stability matter anywhere?

- Sources examined: the four `sort_by_key` calls, the uniqueness of `mc_notes.id`
  (`mc-store:10163`, `:10199`, and the `WHERE id = ?` predicates throughout),
  and the composite key shapes.
- Findings: no. Every key ends in `note.id`, and ids are unique within a project,
  so no two elements compare equal and stability is unobservable. That is the
  stronger design: it would still be correct under an unstable sort.
- Missing evidence: none.
- Conclusion: resolved with answer. Stability is not load-bearing.

### Q: Could the store's `ORDER BY id` ever be dropped, and would the sorts
still cover it?

- Sources examined: `mc-store:13291-13301` (the candidate query),
  `lib.rs:13963-13985` (`smart_note_selection_snapshot`, which maps rows to
  snapshots in iteration order), `lib.rs:11203-11207` (the closure that builds
  the snapshot `Vec`).
- Findings: yes, the sorts cover it. The snapshot `Vec` preserves whatever order
  the query returned, and every selector sorts before truncating. So the
  `ORDER BY id` is redundant for correctness. It is still worth keeping, because
  it makes the pre-sort state deterministic and therefore makes a failing test
  reproducible.
- Missing evidence: none.
- Conclusion: resolved with answer. Two independent guarantees, either sufficient.
