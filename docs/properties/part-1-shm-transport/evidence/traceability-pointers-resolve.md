# traceability-pointers-resolve

## Discovery trigger

`docs/evidence/mc-shm-traceability-v1.json` carries `current_verdict:
"INCONCLUSIVE"` and a `status_vocabulary` in which `PASS` means "Executable
local contract has passing coverage." A `PASS` is therefore a claim about a
named test. The resolution of every such name was re-run mechanically at
`9c1eb4d1`.

## Evidence trail

Method: every string under `requirements[].evidence[]` and
`acceptance_examples[].evidence[]` was collected. Strings containing `#` were
split on the first `#` into a path and a fragment; the path was resolved
relative to the repository root and the fragment was checked as a literal
substring of the file.

Totals at `9c1eb4d1`:

- 83 evidence strings in all, 51 containing `#`, 29 distinct after
  deduplication.
- 18 of the 29 resolve by literal substring; 11 do not.
- The 11 unresolved pointers account for 17 of the 51 citation instances.
- Of the 32 strings without a fragment (9 distinct), 8 name paths that exist.
  The ninth is `https://github.com/ahrav/magic-context/actions/runs/32809287468`,
  a CI run URL rather than a tree path; it is not a defect and is excluded from
  the counts below.

### Class (a): definitively stale Rust test names — 2 distinct, 4 instances

| Cited fragment | Real name at HEAD | Cited by |
| --- | --- | --- |
| `crates/mc-shm-transport/tests/ring.rs#lease_limit_rejects_then_recovers_after_release` | `lease_limit_reports_backpressure_then_recovers_after_release` (`tests/ring.rs:279`) | R11 (PASS) |
| `crates/mc-host/tests/shm_transport.rs#omitted_and_unqualified_profiles_fall_back_without_side_effects` | `omitted_and_unqualified_profiles_fall_back_reasonless_without_side_effects` (`tests/shm_transport.rs:117`) | R3 (PASS), R14 (PASS), AE2 (PASS) |

Both files exist; only the test names are wrong. Each real name is a strict
superstring of the cited one with an inserted word (`reports_backpressure_then`
for `rejects_then`, `reasonless_` before `without`), which is the signature of a
rename that did not propagate.

### Class (b): markdown heading anchors — 2 distinct, 3 instances

| Cited fragment | Heading at HEAD | Cited by |
| --- | --- | --- |
| `docs/mc-host-shm-transport.md#trusted-peer-boundary` | `## Trusted-peer boundary` (line 114) | R19 (PARTIAL), AE11 (BLOCKED) |
| `docs/perf/mc-shm-hardware-envelope.md#evidence-boundary` | `## Evidence boundary` (line 115) | R19 (PARTIAL) |

Both resolve correctly under GitHub-style anchor derivation — lowercase the
heading, replace spaces with hyphens. They fail only the literal-substring
check. These are not stale.

### Class (c): TypeScript tests under a different citation convention — 7 distinct, 10 instances

Tests in these files are declared with human-readable sentence names. The cited
fragment is that name with spaces replaced by underscores and commas removed.
Every one of the seven maps to an existing declaration:

| Cited fragment | Declaration at HEAD |
| --- | --- |
| `...shm-frame-channel.test.ts#omits_unsupported_and_non-qualified_profiles_without_registration` | `test("omits unsupported and non-qualified profiles without registration"` (line 214) |
| `...#propagates_JSON_and_binary_leases_without_owned-adapter_copies` | line 224 |
| `...#callback_failure_underfill_and_overflow_publish_nothing` | `test("callback failure, underfill, and overflow publish nothing"` (line 320) |
| `...#native_reservation_publishes_directly_and_cannot_cancel_after_publication` | line 378 |
| `...#owned_receive_adapter_records_exactly_one_copy` | line 402 |
| `...#close_reports_quarantine_and_rejects_alias_cleanup_failure` | line 426 |
| `...test-support/frame-channel-contract.ts#underfill_overflow_and_abort_return_reservations_without_publication` | `name: "underfill, overflow, and abort return reservations without publication"` (line 556) |

The convention could never satisfy a literal substring check: the source spells
these names with spaces, so a snake_case fragment is absent by construction.
Note the seven span **two** files, not one — six in `shm-frame-channel.test.ts`
and one in `test-support/frame-channel-contract.ts`, where the declaration is a
`name:` field on a shared contract scenario rather than a `test(...)` call.

Class totals: (a) 2, (b) 2, (c) 7 — 11 distinct, 4 + 3 + 10 = 17 instances.

## Failure scenario

A rename lands in `tests/ring.rs`. Nothing in the tree reads the traceability
record, so CI stays green. R11 continues to read `PASS` with an evidence
pointer to a test name that no longer exists. A reviewer approving a release
gate follows the pointer, finds nothing, and cannot tell whether the coverage
was deleted, renamed, or never existed. Class (a) is that scenario, already
realised twice, once propagated to three rows.

## Timing windows and dependencies

None. Detachment happens at the moment of the rename and is permanent, because
no check couples the record to the tree. The only dependency is that the class
(b) and class (c) pointers must not be treated as the same defect as class (a):
they resolve under their own conventions, and a checker that flags all 11
equally would produce nine false positives and hide the two real ones.

## What a test must construct

A resolver run in CI that, per evidence string:

1. Skips strings whose path component is a URL.
2. Asserts the path exists.
3. Dispatches on file extension for the fragment check — Rust: `fn <fragment>`
   must appear; Markdown: the fragment must match a heading under GitHub anchor
   derivation; TypeScript: the fragment must match a `test(...)`, `it(...)`, or
   `name:` string under the space-to-underscore, comma-dropping transform.
4. Fails on any unresolved pointer, reporting the citing requirement id and its
   status so a `PASS` resting on a dead pointer is named.

The negative control is a deliberate rename in a fixture file, asserting the
resolver fails. Without it the resolver could pass by resolving nothing.

## Investigation log

### Q: What is the intended citation convention for TypeScript tests and markdown anchors? Snake-case fragments do not appear literally in those files, so the seven-plus-two remainder cannot be classified without that answer.

- Sources examined: all 29 distinct fragment pointers resolved mechanically;
  `packages/plugin/src/shared/mc-host-client/shm-frame-channel.test.ts` test
  declarations (lines 203-527);
  `packages/plugin/src/shared/mc-host-client/test-support/frame-channel-contract.ts`
  scenario `name:` fields (lines 180-611); headings of
  `docs/mc-host-shm-transport.md` and `docs/perf/mc-shm-hardware-envelope.md`.
- Findings: the convention is recoverable from the data even though it is not
  written down. All seven TypeScript fragments map 1:1 onto an existing
  declaration under one transform (spaces to underscores, commas dropped), and
  both markdown fragments map onto an existing heading under standard GitHub
  anchor derivation. There is no residue — no TypeScript or markdown fragment
  that fails to find a target.
- Missing evidence: no document in the tree states the convention, so it is
  inferred from a complete 1:1 mapping rather than declared. If a future
  TypeScript test were renamed, this inference alone could not distinguish
  "convention" from "stale" for that pointer.
- Conclusion: resolved with answer for classification purposes. Classes (b) and
  (c) are convention, not staleness; class (a) is staleness. The nine
  convention pointers are correct today. Whether the convention should be
  written down, or the record switched to a literal-resolvable form, remains a
  choice for the record's owner and is not required to close this property.
