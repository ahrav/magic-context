# tstx-a-ordinal-paging-loop-is-uncounted

## Discovery trigger

Part 4b's third framing fact is that work per firing is bounded at nine
`apply_once` invocations "with one uncounted loop", the loop being
`load_cached_tags` (`mc-store:7644`, called from `transform.rs:3391`), whose two
exits are optimistic revalidations and whose attempts nothing counts. Part 4b
assigns the loop's body to 4e and the unbounded call to 4b.

Searching the 12 TypeScript units for the same shape — an unbounded loop whose
exits depend on state a concurrent writer controls — found exactly one, and unlike
Part 4b's it is inside this part's file set rather than adjacent to it.

## Evidence trail

Read at `HEAD` = `e447c927`.

**The loop.** `packages/plugin/src/hooks/magic-context/module-wire.ts:915-927`,
inside `resolveOrdinalsForModule` (`:870`):

```ts
let pageAnchor = anchor;
while (true) {
    const page = readRawSessionMessageOrdinalPage(
        args.sessionId,
        pageAnchor,
        MODULE_ORDINAL_PAGE_SIZE,
    );
    if (page.length === 0) break;
    newEntries.push(...page);
    const last = page[page.length - 1];
    pageAnchor = { timeCreated: last.timeCreated, id: last.id };
    if (page.length < MODULE_ORDINAL_PAGE_SIZE) break;
    await yieldToEventLoop();
}
```

Two exits, both at `:921` and `:925`, and both properties of the data:

- `page.length === 0` — the anchor is at the end of the table.
- `page.length < MODULE_ORDINAL_PAGE_SIZE` — a short page, so the table ended
  inside this page.

There is no iteration counter, no deadline, and no `newEntries.length` ceiling.

**It is the only such loop in the 12 units.** Searching for
`for (;;)`, `while (true)`, and bare `while (` across the file set:

| File | Loops found | Bounded? |
| --- | --- | --- |
| `transform.ts` | none | — |
| `transform-postprocess-phase.ts` | `:171`, `:509` | Yes, both `while (cond && index < messages.length)` shapes over a fixed array |
| `rust-mode-transform.ts` | `:666` | Yes, `while (isRecord(current) && !seen.has(current))` with a `seen` set at `:665`, so the cause-chain walk cannot cycle |
| `module-wire.ts` | `:915`, plus `:1016`, `:1021`, `:1240` | `:915` unbounded; the other three are backward index walks over a fixed array |

So `:915` is the single unbounded loop in 13,175 lines, which is worth stating
because it makes the finding narrow and actionable rather than a general concern.

**The mismatch check cannot break the loop.** `:929-934`, immediately after:

```ts
const currentStoredCount = getRawSessionStoredMessageCount(args.sessionId);
const expectedStoredCount = (storedCount ?? 0) + newEntries.length;
if (currentStoredCount !== expectedStoredCount) {
    memo.clear();
    return { ok: false, reason: "mismatch" };
}
```

This is the guard that detects concurrent growth, and it runs **after** the loop
completes. So it converts a detected race into a clean `ok: false` — which the
adapter handles by forcing a full send — but it cannot terminate a loop that never
reaches it.

**The loop does not block the process.** `await yieldToEventLoop()` at `:926`
returns control between pages, so the symptom of non-termination is an unbounded
`transform` pass rather than a frozen event loop. That matters for the failure
mode: the harness keeps running, the turn does not complete.

**The concurrent writer is real, not hypothetical.** Two independent statements in
the tree:

- `packages/plugin/src/hooks/magic-context/hook.ts:829-831`: "Chained
  process-globally per (store, domain): several plugin instances can share this
  database file, and interleaved pulls throw a cursor mismatch in `applyMirrorPage`."
- `packages/plugin/src/plugin/messages-transform.ts:20-25` treats `SQLITE_BUSY` as
  "Transient, expected from concurrent plugin processes (second OpenCode instance,
  long dreamer/historian child session, slow WAL checkpoint)".

So multiple writers against one session's tables is a documented operating
condition, and the `mismatch` return at `:932-933` exists because of it.

## Failure scenario

A session's raw-message table is being appended to while a pass resolves ordinals.

1. The loop reads a page of exactly `MODULE_ORDINAL_PAGE_SIZE` rows and does not
   take the short-page exit at `:925`.
2. It yields at `:926`.
3. During the yield, a writer appends at least `MODULE_ORDINAL_PAGE_SIZE` more rows
   past the new anchor.
4. The next read returns a full page again. Go to 2.

Each iteration also does `newEntries.push(...page)` at `:922`, so memory grows with
the number of iterations. The loop terminates as soon as one read returns fewer than
a full page, so this requires sustained writing at or above page granularity — a
backfill, a migration, a historian replaying a long transcript, or a second instance
importing a session.

The realistic outcome is therefore a long pass rather than a hang, and the honest
statement of the risk is: the loop's duration is a function of a writer the loop
does not control, and nothing caps it. Part 4b's `load_cached_tags` finding has the
same shape and the same honest framing.

Note what does *not* go wrong: correctness. The post-loop mismatch check at
`:929-934` catches the growth and returns `ok: false`, and the adapter responds by
setting `state.forceFullWire = true` and retrying with complete arrays
(`rust-mode-transform.ts:2483`). So a pass that finishes is correct. The exposure is
liveness only, which is why the record is typed `liveness` rather than `safety`.

## Timing windows and dependencies

The window is the duration of the loop, which is exactly the period during which the
race is live. `await yieldToEventLoop()` at `:926` widens it deliberately: yielding
is what makes the loop cooperative, and it is also what gives a concurrent writer a
scheduling point to append into.

METHOD.md's liveness rules require a bounded fault-free window and a bound stated in
the units the code bounds. The code bounds page reads, so the check is stated in page
reads: after the last append, at most one further read. That is provable from the
source — the read after the final append either returns a short page or an empty one
— which is what makes the property refutable by a finite test.

Dependencies:

- `MODULE_ORDINAL_PAGE_SIZE` is the granularity the adversary must match. It is 500
  (`module-wire.ts:26`), and a test must import it rather than hard-code 500, or the
  test silently stops being adversarial when the constant changes.
- `readRawSessionMessageOrdinalPage` and `getRawSessionStoredMessageCount` are
  imported readers over the raw session store, outside this file set. The property
  does not depend on their internals, only on the page-size contract.
- Reachability: `resolveOrdinalsForModule` is called only from the adapter
  (`rust-mode-transform.ts:2131`, `:2149`, `:2488`, `:2508`), so this is
  `explicit-config-only`.

## What a test must construct

1. **The bounded-window liveness test, which is the property.** Stub
   `readRawSessionMessageOrdinalPage` with a fake that returns full pages while a
   flag is set and a short page once it clears. Run the resolve under the flag for a
   fixed number of pages, clear the flag, then assert the resolve completes within one
   further page read. Counting reads is the oracle; a wall-clock timeout is not,
   because per METHOD.md a generous timeout cannot distinguish one recovery pass from
   a thousand.
2. **The adversarial case, to show the loop does not self-limit.** Same fake, flag
   never cleared, plus a read counter. Assert the count exceeds any fixed bound — for
   example 10,000 reads — then stop the test by clearing the flag. This asserts the
   absence of a bound rather than the presence of a hang, which is the honest claim
   and is decidable in a finite test.
3. **The mismatch control.** Let the loop finish, then have
   `getRawSessionStoredMessageCount` report a larger count than the loop accumulated.
   Assert `{ ok: false, reason: "mismatch" }` and that the memo was cleared (`:932`).
   This documents that correctness is preserved and keeps a future fix from being
   credited with fixing a safety problem that never existed.
4. **A coverage check for the operational situation.** Per METHOD.md, assert the
   independent preconditions: a rust-mode pass resolving ordinals, and at least one
   append to the same session's table observed between two page reads. Those
   co-occurring is the vulnerable state, and the marker fires on a correct
   implementation.

Case 2 is the one that establishes the finding; case 1 is the one that would keep a
fix honest.

## Investigation log

### Q: Part 4b's `sel-tag-hydration-terminates-once-tag-mutation-stops` is the same shape on the Rust side. Whether the two should share one bound is a design question.

- Sources examined: `module-wire.ts:915-927` and `:929-934`; Part 4b's catalog
  paragraph on bounded work, which names `load_cached_tags` (`mc-store:7644`, called
  at `transform.rs:3391`) as the uncounted loop and records that its two exits are
  optimistic revalidations; Part 4b's index entry for
  `sel-tag-hydration-terminates-once-tag-mutation-stops`, which the portfolio
  evaluation's refinement R2/R9 retyped to bounded liveness.
- Findings: the two loops are structurally the same — an optimistic reader that
  retries until the data stops moving, with no attempt counter — and Part 4b arrived
  at the same conclusion about how to state the property, namely a bounded fault-free
  window rather than an unbounded "eventually". That convergence is itself useful: it
  means the check shape is already agreed across the two parts and does not need
  relitigating. What differs is the retry trigger: Rust's is a revalidation failure,
  TypeScript's is a full page, so a shared numeric bound would mean different things
  on each side.
- Missing evidence: whether the project wants a uniform "no unbounded loop in a
  transform pass" rule, which would be a policy rather than a per-loop fix. I found no
  such rule stated in `docs/` or in `AUDIT-KNOWN-ISSUES.md`.
- Conclusion: needs human input on the policy, but not on the fix. The local fix is
  independent and small: an iteration cap that returns
  `{ ok: false, reason: "mismatch" }` on exhaustion reuses the existing failure path
  at `:932-933`, so the adapter already handles it (`forceFullWire` at
  `rust-mode-transform.ts:2483`) and no new error shape is introduced. Recommend
  proposing that as the concrete change and leaving the cross-part policy question
  open.

### Q: Is the loop reachable in a shipped install?

- Sources examined: the four call sites of `resolveOrdinalsForModule`
  (`rust-mode-transform.ts:2131`, `:2149`, `:2488`, `:2508`); the mode gate at
  `transform.ts:822`; `tstx-a-default-install-runs-the-typescript-renderer`.
- Findings: all four are inside the adapter, so the loop runs only under
  `transform_mode: "rust"`, which requires user-tier consent
  (`config/transform-mode.ts:34-39`) and which
  `release-review-resolution.md:31-32` calls an undocumented dev-only flag.
- Missing evidence: none for this question.
- Conclusion: resolved. `explicit-config-only`. That lowers the record's priority
  relative to the default-mode records but does not change its validity: the loop is
  in shipped code and reachable by configuration.
