# fence-a-env-override-relaxes-only-the-version-arm

## Discovery trigger

Task 3 asks whether the fence can be bypassed by any other open path in the
package. The first thing found was not another path but a documented input that
moves the fence itself: `getRuntimeLatestSupportedVersion` reads an environment
variable.

## Evidence trail

`packages/plugin/src/features/magic-context/storage-db.ts:213-225`:

```
function getRuntimeLatestSupportedVersion(options?: OpenDatabaseOptions): number {
    if (options?.latestSupportedVersion !== undefined) {
        return options.latestSupportedVersion;
    }
    const override = process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION;
    if (override) {
        const parsed = Number.parseInt(override, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return LATEST_SUPPORTED_VERSION;
}
```

Three sources in precedence order: the per-call option (`:214-216`), the
environment variable (`:217-223`), the constant (`:224`).

`MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION` has exactly one reference in the
repository, this one. So there is no config-schema entry, no doctor surface, and
no documentation of it in code.

The resolved value flows to `openDatabase:837` and `openDatabaseAsync:878`, then
to `openDirectDatabase`'s fourth parameter (`:734`), then to both fence call
sites (`:769`, `:777`) as `latestSupportedVersion`.

Inside the fence, the value is used in exactly one comparison, the first conjunct
at `:669`:

```
    if (persistedVersion <= latestSupportedVersion && persistedEpoch <= DIRECT_FORMAT_EPOCH) {
```

The second conjunct compares against `DIRECT_FORMAT_EPOCH`, imported from
`storage-format-epoch.ts` (`storage-db.ts:41`) where it is
`export const DIRECT_FORMAT_EPOCH = 1` (`:45`). Nothing in
`getRuntimeLatestSupportedVersion` or `OpenDatabaseOptions` (`:160-163`, whose
only fields are `dbPath` and `latestSupportedVersion`) can change it.

So raising the ceiling relaxes the version arm and leaves the epoch arm intact.
Given that `storage-db.ts:663-666` calls the epoch "the signal that actually
distinguishes a database this build is too old to read from one it must refuse",
the more important arm is the non-overridable one. That is the safe arrangement.

Two secondary observations on the parse:

- `Number.parseInt("999x", 10)` is `999`, and `Number.isFinite(999)` is `true`,
  so a trailing-garbage value is accepted as its numeric prefix rather than
  rejected.
- `Number.parseInt("abc", 10)` is `NaN` and `Number.isFinite(NaN)` is `false`, so
  a wholly non-numeric value correctly falls through to the constant at `:224`.
- A negative value such as `"-1"` parses to `-1` and is finite, so it is
  accepted and would refuse every database including a freshly bootstrapped one
  at version 90.

The boot log at `:206-211` reports `supported_fence=v${supportedVersion}`, but
`finishDatabaseOpen:569` passes `LATEST_SUPPORTED_VERSION`, the constant, not the
runtime value. So an operator who set the override sees the compiled ceiling in
the boot log, not the one that was applied.

## Failure scenario

An operator hits a version-lane refusal and finds the variable, perhaps from a
support thread rather than documentation since none exists. They set
`MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION=9999` to unblock a session. The version
arm now passes for any lane below the fork floor. If the newer binary that owns
the database advanced only the version lane, the older binary now opens and
writes it, which is the exact outcome `:678` warns against.

If the newer binary also bumped the marker epoch, the epoch arm still refuses,
and the operator cannot override it. That is the designed containment.

A typo scenario: `MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION=90x` silently becomes
`90`, which happens to be correct. `=9 0` becomes `9`, which refuses a healthy
database at version 90 and presents as a fence rejection with
`supportedVersion: 9`, a confusing report.

## Timing windows and dependencies

No timing window. The read is a plain `process.env` access per open call, so a
mid-process change to the variable takes effect on the next open that is not a
cache hit. Cache hits at `:840-851` and `:881-886` return the existing handle
without consulting it at all, which is covered by
`fence-a-telemetry-connection-outlives-the-fence`.

Dependencies: `DIRECT_FORMAT_EPOCH`'s status as a module constant. If a future
change made the epoch overridable through the same mechanism, this property would
be invalidated rather than merely weakened.

## What a test must construct

1. Save and restore `process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION` around
   the test. No existing test touches it, so no fixture exists.
2. Case A, the guarantee: build a database with `format_epoch: 2` and a valid
   digest, and `schema_migrations` at 91. Set the override to `9999`. Assert the
   open still returns `null` and `getSchemaFenceRejection()` is non-null. The
   epoch arm must carry the refusal alone.
3. Case B, the relaxation is real: same database but `format_epoch: 1` and
   `schema_migrations` at 91. With the override unset, assert refusal. With the
   override at `9999`, assert the open succeeds. This documents the override's
   effect rather than asserting it is safe.
4. Case C, the parse: assert the behaviour of `"999x"`, `"abc"` and `"-1"`
   against `getRuntimeLatestSupportedVersion`. It is not exported, so this needs
   either an export or an observation through `getSchemaFenceRejection()`'s
   `supportedVersion` field, which does carry the resolved value (`:672`).

Case C is the cheapest oracle: `supportedVersion` in the latch is the resolved
runtime ceiling, so a refusal against a version-91 database reveals what the
override parsed to.

## Investigation log

### Q: Should the override reject a non-numeric suffix?

- Sources examined: `storage-db.ts:217-223`, and the single-reference search for
  the variable name across `packages/` and `docs/`.
- Findings: the guard is `Number.isFinite(parsed)`, which is the right check for
  rejecting `NaN` but does not detect that `parseInt` stopped early.
  `Number.parseInt` is the deliberate choice over `Number()`, which would return
  `NaN` for `"999x"` and thus reject it. There is no comment explaining the
  choice. There is also no schema validation, because the variable is not in the
  config schema; the only config-schema-backed storage knobs are the PRAGMA
  values at `:479-482`.
- Missing evidence: whether the variable is intended as an operator-facing knob
  or as a test seam. It is not in any test, and `options.latestSupportedVersion`
  already exists as the test seam, which argues it is operator-facing. But an
  undocumented operator knob that can disarm a data-safety fence is an odd
  artifact.
- Conclusion: unresolved, needs a decision on whether the variable is supported
  surface. If it is, it needs strict parsing, a lower bound, and documentation.
  If it is not, `options.latestSupportedVersion` already covers testing and the
  env read could go.

### Q: Does the boot log report the applied ceiling?

- Sources examined: `storage-db.ts:206-211` (`formatSchemaFenceBootLog`),
  `:568-570` (the call site inside `finishDatabaseOpen`).
- Findings: no. `:569` is
  `log(formatSchemaFenceBootLog(getPersistedSchemaVersion(db), LATEST_SUPPORTED_VERSION))`,
  passing the module constant. The function's doc comment at `:205` says "Log the
  upstream-lane version so operators can compare it to this build's fence", and
  "this build's fence" is arguably the constant, so the call is consistent with
  its own doc. But an operator who set the override and compares the log to the
  behaviour will be misled.
- Missing evidence: none.
- Conclusion: resolved with answer. The boot log reports the compiled constant,
  not the resolved runtime ceiling. Worth a contract-vs-code note if the override
  is supported surface.

### Q: Is the option form used anywhere in production?

- Sources examined: `OpenDatabaseOptions` (`:160-163`), the three `openDatabase`
  overloads (`:829-832`), `:837`, `:878`.
- Findings: the option is part of the public overload set, so any of the call
  sites could pass it. I did not enumerate the call sites; the comment at
  `:476-478` says there are 27.
- Missing evidence: the call-site enumeration.
- Conclusion: unresolved, needs a call-site sweep. If a production caller passes
  `latestSupportedVersion`, this record's reachability changes from
  `explicit-config-only` to `default-production`.
