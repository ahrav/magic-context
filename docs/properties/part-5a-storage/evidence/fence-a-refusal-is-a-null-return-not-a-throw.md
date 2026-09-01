# fence-a-refusal-is-a-null-return-not-a-throw

## Discovery trigger

The Part 5 scope map describes the fence as "enforced at `:678`, which throws a
message ending 'Do not reset this database: a newer binary owns it.'"
(`docs/properties/part-5-ts-surfaces/_lenses/scope-map-and-risk-ranking.md:143-147`).
Verifying that reference against `HEAD` showed `:678` is a template string
inside a `log(...)` call. The delivery mechanism is a `null` return, and that
changes both what a test asserts and what a caller must handle.

## Evidence trail

`packages/plugin/src/features/magic-context/storage-db.ts:677-680`:

```
    log(
        `[magic-context] storage fatal: refusing to open ${dbPath}; its ${lane} is newer than this binary supports. ...`,
    );
    return true;
```

`:677` is `log(`, `:678` is the message, `:679` closes the call, `:680` returns
`true`. There is no `throw` in `refuseNewerSchemaFence` (`:651-681`).

Both call sites convert `true` to a `null` return:

- `recordFormatRefusal:689` — `if (refuseNewerSchemaFence(...)) return;`, and
  the caller at `:769-771` then does `closeQuietly(db); return null;`.
- `openDirectDatabase:777-780` — `closeQuietly(db); return null;`.

The only `throw` reachable from `openDatabase` is `:860-862`, inside the `catch`
at `:855`, which handles a genuine open error. `openDirectDatabase`'s own
`catch` at `:790-793` closes and rethrows, so a fatal open error propagates; a
fence refusal never enters that path because `:779` returns normally.

The doc comment on `openDatabase` states the two-outcome contract explicitly at
`:822-827`: "The return type is therefore `Database | null`, and callers MUST
both null-check the result AND be prepared for a throw". `:811-820` enumerates
the three failure modes and assigns the fence to the `null` arm: "**Format
refusal** ... or it carries a newer format fence than this binary supports):
returns `null` with the detail recorded in the refusal latches."

Existing tests all assert the null form: `storage-db.test.ts:368`, `:459`,
`:494` are each `expect(openDatabase(dbPath)).toBeNull()`. The
not-a-database case at `:498` onward is the one that expects a throw, which is
consistent with `:819-820`.

## Failure scenario

A caller wraps `openDatabase` in `try/catch` and treats the absence of a throw
as success, then uses the returned value. In TypeScript the `Database | null`
type makes that a compile error under `strictNullChecks`, so the realistic
failure is subtler: a caller null-checks but reads the latch too late. The
latches are cleared at the top of every open attempt (`:838-839` for the sync
path, `:879-880` for the async path), so an intervening `openDatabase` on any
other path erases the rejection record before the first caller reports it.

`hook.ts:263-283` reads both latches immediately after the null check, in the
same block, which is correct. `index.ts:414` reads `getSchemaFenceRejection()`
much later in plugin startup, after `refreshModelLimitsFromApi` is kicked off at
`:405`. Whether any open happens in between is not established here.

## Timing windows and dependencies

The window is between the fence's latch write at `:672` and the consumer's read.
Any `openDatabase` or `openDatabaseAsync` call in that window resets the latch
to `null` at `:838-839` or `:879-880`, including a call that then succeeds.

`config/latch-permanence-guard.test.ts:133` registers
`storage-db.ts:lastSchemaFenceRejection` in a latch-permanence registry, which
suggests the project already treats this latch's lifetime as a property worth
guarding. I did not read that test's semantics.

## What a test must construct

1. A newer-fence `context.db` as in
   `fence-a-older-binary-never-writes-a-newer-database`.
2. Assert `openDatabase(dbPath)` returns `null` and does **not** throw. The
   negative half matters: wrap in a `try` and fail the test if the `catch` runs.
3. Assert `getSchemaFenceRejection()` is non-null immediately.
4. For the latch-lifetime half: after the refusal, call `openDatabase` on a
   different, healthy path, then assert whether the first path's rejection is
   still readable. It will not be, because the latch is a single module-level
   variable, not keyed by path. That is the finding to record rather than to
   assert as correct.

## Investigation log

### Q: Should the scope map be corrected, or was an earlier revision throwing?

- Sources examined: `storage-db.ts:651-681` at `HEAD` = `e447c927`; the scope
  map's own provenance line, which states the same `HEAD`; the three failure
  modes documented at `storage-db.ts:811-820`.
- Findings: at this `HEAD` the fence logs and returns `true`. The message text
  the scope map quotes is verbatim from `:678`, so the reference is to the right
  line; only the verb is wrong. The doc comment at `:816-818` independently
  confirms the fence belongs to the `null` arm, not the throwing arm, so the
  code and its own documentation agree with each other and disagree with the
  scope map.
- Missing evidence: the git history of `refuseNewerSchemaFence`. I did not run
  `git log -L` on the function.
- Conclusion: needs human input on whether to amend the scope map. The code
  claim is resolved: it logs and returns, it does not throw.

### Q: Is the latch's single-variable, path-agnostic design a defect?

- Sources examined: `storage-db.ts:72` (declaration), `:672` (write),
  `:838-839` and `:879-880` (clears), `:81-86` (reader), `hook.ts:263-268`,
  `index.ts:414-421`, `pi-plugin/src/index.ts:793-794`.
- Findings: the latch is `let lastSchemaFenceRejection` with no path key, while
  `databases` (`:59`) and `pathByDatabase` (`:63`) are both path-keyed. A
  process that opens more than one `context.db` path, which the explicit-`dbPath`
  overload at `:830` permits, can only report the most recent refusal. All three
  consumers read it once, near a null check, so the practical exposure depends
  on whether any of them opens twice.
- Missing evidence: whether any shipped path opens two distinct database paths in
  one process. The scope map notes "the 27 openDatabase call sites"
  (`storage-db.ts:476-478`), which I did not enumerate.
- Conclusion: unresolved, needs an enumeration of the 27 call sites to establish
  whether two distinct paths are ever opened in one process.

### Q: Does the surfaced message name the real reason when the epoch arm fires?

- Sources examined: `storage-db.ts:672` (latch payload), `:673-676` (lane
  selection for the log), `:81-86` (latch shape), `index.ts:414-421`,
  `hook.ts:269-274`.
- Findings: the log message at `:678` interpolates `lane`, which correctly names
  the epoch when `persistedEpoch > DIRECT_FORMAT_EPOCH` (`:674-675`). The latch
  at `:672` records only `{ persistedVersion, supportedVersion }`. When the
  epoch arm alone fired, `persistedVersion` can equal `supportedVersion`, so the
  structured payload the user-facing surfaces consume reports an equal pair with
  no indication of the epoch.
- Missing evidence: the rendering in `sendSchemaFenceWarning`
  (`plugin/conflict-warning-hook`), which I did not read.
- Conclusion: resolved with answer for the latch; unresolved for the rendered
  text. The latch drops the epoch. Whether the rendered warning is therefore
  misleading depends on `sendSchemaFenceWarning`, unread.
