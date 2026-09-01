# fence-a-unclassifiable-family-must-not-get-reset-guidance

## Discovery trigger

`storage-db.ts:678` ends with "Do not reset this database: a newer binary owns
it." The comment at `:663-666` states the reason: "reset guidance for the former
would destroy a family a newer binary legitimately owns." Tracing which refusals
actually emit reset guidance showed that a family this binary cannot classify
takes the hard `doctor reset-db` branch.

## Evidence trail

`packages/plugin/src/features/magic-context/storage-db.ts:683-705` is
`recordFormatRefusal`. The guidance selection is `:695-701`:

```
    const manifestOnly =
        marker.status === "present" &&
        persistedEpoch === DIRECT_FORMAT_EPOCH &&
        classification.reasons.some((reason) => reason.includes("component manifest digest"));
    const guidance = manifestOnly
        ? "Align every Magic Context binary sharing this database on one revision first; run '... doctor reset-db' only to abandon the family deliberately."
        : "To abandon this database family and start fresh, run '... doctor reset-db'.";
```

`manifestOnly` requires `marker.status === "present"` at `:696`. A malformed
marker fails that test, so `guidance` takes `:701`, the unconditional
abandon-the-family string.

The path to that line for an unparseable marker:

1. `readDirectFormatMarker` returns `{ status: "malformed", reason }` from any of
   the branches at `storage-format-epoch.ts:194-232`.
2. `classifyDatabaseFormatFamily`'s **first** branch (`:190-192`) returns
   `{ family: "malformed-marker", reasons: [inspection.marker.reason] }`. It
   returns before any of the object-inventory, `application_id` or
   `user_version` comparisons at `:206-247`, so the only reason recorded is the
   marker's own parse failure.
3. `openDirectDatabase:765-767` sees a non-`current` family, calls
   `bootstrapUnderWriteLock`, which returns without writing because the
   post-lock recheck is not `pristine` (`:628`).
4. `:768-772` calls `recordFormatRefusal` and closes.
5. Inside, `:689` gives the fence first refusal. Per
   `fence-a-malformed-marker-reads-as-epoch-zero`, the epoch collapses to `0` at
   `:691`, so the fence declines unless the version arm fires.
6. `:702-704` logs the format refusal with `:701`'s guidance.

The destructive command is real. The Part 5 scope map records
`packages/cli/src/commands/doctor-reset-db.ts` at 677 lines and
`doctor-repair-db.ts` at 763, and notes that `storage-db.ts:818` routes the
refused case to `doctor reset-db`
(`docs/properties/part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:168-174`).
`storage-db.ts:817-818` reads: "Recovery is an explicit operator reset
(`doctor reset-db`) or a binary update — never an in-place migration."

## Failure scenario

A newer generation writes a marker this build cannot parse, for the reasons in
`fence-a-malformed-marker-reads-as-epoch-zero`, or a crash truncates the marker
row mid-update. The older binary refuses to open, which is correct, and logs:

> refusing to open .../context.db; the database is not the supported direct
> claims format (malformed-marker): marker digest mismatch. No data was changed.
> To abandon this database family and start fresh, run '... doctor reset-db'.

The user runs the command. If the cause was a newer binary, the newer binary's
database is destroyed, along with project memories, historian state, tags and the
claim outbox. `storage-db.ts:711-713` has already established there is no
migration lane, so nothing recovers the data afterwards.

The message does contain "No data was changed", which is true of the refusal
itself and is a reasonable thing to say. It does not warn that the family may
belong to a newer binary, which is the warning `:678` carries on the other path.

## Timing windows and dependencies

No timing window. The message is composed straight-line at `:690-704`.

Dependencies: `readDirectFormatMarker`'s three-way status, the
`malformed-marker` branch ordering at `storage-format-epoch.ts:190-192`, and the
epoch collapse at `storage-db.ts:691`. If the collapse were fixed so a malformed
marker refused as a fence rejection, `:689` would return early and this record's
failure would not be reachable. The two records share one fix.

`doctor-reset-db.ts` and `database-access.ts` are 5d scope. What reset verifies
before destroying is the other half of the blast radius and is unread here.

## What a test must construct

1. `context.db` with a valid `mc_format_marker` DDL and a row whose
   `marker_digest` is wrong, plus `schema_migrations` at exactly
   `LATEST_SUPPORTED_VERSION`, as in
   `fence-a-malformed-marker-reads-as-epoch-zero`.
2. Capture the logged line. `storage-db.test.ts` already asserts on refusal
   reasons via `getFormatRefusal()?.reasons.join("; ")` at `:390`, but the
   guidance string is only in the log, not in the latch, so the test needs a log
   capture seam.
3. Assert the guidance does not equal `:701`'s abandon-the-family string for a
   `malformed-marker` family.

A companion positive case is worth writing at the same time: the `manifestOnly`
branch at `:700` is the softened guidance and I found no test asserting it. Its
precondition is a `present` marker at epoch 1 whose
`component_manifest_digest` differs from this build's, which
`buildDirectFormatMarker` can produce by passing a different digest.

## Investigation log

### Q: Should `malformed-marker` receive a third guidance string?

- Sources examined: `storage-db.ts:678` (the do-not-reset warning), `:663-666`
  (the stated harm), `:695-701` (the two-way guidance selection),
  `storage-format-epoch.ts:190-192` (the family branch).
- Findings: the code already distinguishes three situations in prose. The fence
  path says do not reset. The manifest-only path says align binaries first and
  reset only deliberately, with the comment at `:693-694` explaining that a
  digest cannot be direction-typed. The residual path says reset. A malformed
  marker is exactly as direction-ambiguous as a digest mismatch: it may be older
  junk or a newer encoding, and a hash cannot tell you which. By the code's own
  reasoning at `:693-694` it should get the softened guidance at minimum.
- Missing evidence: whether `doctor reset-db` itself refuses when it detects a
  newer family, which would make the guidance safe in practice. That is
  `packages/cli/src/commands/doctor-reset-db.ts`, unread, 5d scope.
- Conclusion: needs human input on the guidance text. The structural finding is
  resolved: `manifestOnly` cannot be true for a malformed marker because `:696`
  requires `status === "present"`.

### Q: Does the refusal happen before any write, so the data is still there to
lose?

- Sources examined: `storage-db.ts:765-772`, `:611-641`,
  `storage-db.test.ts:373-396` and `:398-420`.
- Findings: yes. `bootstrapUnderWriteLock` returns without writing unless the
  post-lock family is `pristine` (`:628`), and the two unsupported-family tests
  assert the main-file digest and, in the WAL case, the `-wal` digest are
  unchanged (`:391`, `:414-415`). So the refusal is genuinely side-effect-free
  and the message's "No data was changed" is accurate.
- Missing evidence: an equivalent digest assertion for the `malformed-marker`
  family specifically. The existing tests cover `unsupported` and
  `orphan-artifacts` (`:255`), not `malformed-marker`.
- Conclusion: resolved with answer for `unsupported`; unresolved for
  `malformed-marker`, needs a test at that family. The code path is the same
  `:769-770` pair, so the inference is strong.

### Q: Can the fence and the format refusal both be recorded?

- Sources examined: `storage-db.ts:689`, `:692`, `:838-839`.
- Findings: no. `:689` returns early when the fence fires, so `:692` never runs
  and `lastFormatRefusal` stays `null`. Conversely a declining fence leaves
  `lastSchemaFenceRejection` `null` because `:672` did not execute. The existing
  tests assert exactly this exclusivity: `:370-371`, `:390-391`, `:466-467`,
  `:495-496` each assert one latch non-null and the other null.
- Missing evidence: none.
- Conclusion: resolved with answer. The two latches are mutually exclusive by
  construction, which means a consumer seeing a format refusal can conclude the
  fence declined, and that is the signal this record shows is misleading for a
  malformed marker.
