# nudge-b-opencode-channel2-arm-has-no-module-side-latch

## Discovery trigger

Task 2 asked whether injection is idempotent with respect to a repeated render.
The Claude Code Channel-2 arm has an arming watermark, a directive id, and a lease
TTL, all of which exist to make it idempotent. Reading the OpenCode arm next
showed it has none of them, and that the module's own rearm helpers were written
for state the OpenCode arm never touches.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The two arms

`crates/mc-module/src/transform.rs:9337-9378`, `channel2_directives`:

```
9346:    match profile {
9347:        Some(SerializerProfile::OpencodeAiSdk) => {
9348:            if matches!(channel2_nudge_state, "pending" | "claimed" | "delivered") {
9349:                return Channel2DirectiveOutput::default();
9350:            }
9351:            let host_directives = channel2_pressure(input, meta)
9352:                .filter(|pressure| pressure.due)
9353:                .map(|pressure| HostDirectives {
9354:                    channel2_nudge: Some(Channel2NudgeDirective {
9355:                        text: build_channel2_host_reminder(
...
9366:        Some(SerializerProfile::ClaudeCodeAnthropic) => Channel2DirectiveOutput {
9367:            host_directives: None,
9368:            channel2_directive: claude_code_channel2_directive(
...
```

The OpenCode arm reads two things and writes nothing. `channel2_pressure`
(`:9380-9405`) takes `meta: &ModuleMeta`, an immutable borrow, so it cannot latch
even if it wanted to. The returned type is `Channel2NudgeDirective { text: String }`
(`:1123-1125`): no id, no timestamp, no watermark.

The Claude Code arm, by contrast, calls `claude_code_channel2_directive`
(`:9435-9502`) which takes `meta: &mut ModuleMeta` and maintains:

- `meta.pending_channel2_directive` (set at `:9497`, cleared at `:9447` and inside
  `rearm_channel2_cycle`).
- `meta.channel2_pressure_latched` (read at `:9483`, set at `:9496`).
- `meta.channel2_arming_watermark` (incremented at `:9488`, stored at `:9495`).
- `CHANNEL2_DIRECTIVE_LEASE_TTL_MS`, ten minutes (`:111`), checked at
  `:9450-9458`.

### The rearm helpers are inert on the shipped profile

`rearm_channel2_cycle` (`:9407-9410`):

```
fn rearm_channel2_cycle(meta: &mut ModuleMeta) {
    meta.pending_channel2_directive = None;
    meta.channel2_pressure_latched = false;
}
```

Both fields are Claude-Code-arm only. Its two callers,
`rearm_channel2_after_hard_fold` (`:9412-9421`) and
`rearm_channel2_after_measured_collapse` (`:9423-9433`), run unconditionally in
the transform body at `:5326-5333`, before `channel2_directives` at `:5522`. On
the OpenCode arm they clear state that is never read, so they have no observable
effect.

### The shipped profile is OpenCode

`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1339` sets
`serializer_profile: "opencode-aisdk"`. A repository-wide grep for
`"claude-code-anthropic"` finds it only in Rust tests, in
`ARCHITECTURE.md:125`, and in the profile-epoch table
(`crates/mc-module/src/lib.rs:552`). No TypeScript sender emits it.

### The host owns the lease and its reaper

`packages/plugin/src/features/magic-context/storage-meta-persisted.ts:1132-1146`
documents the state machine stored in the `channel2_nudge_state` column:
`''`, `'pending'`, `'claimed'`, `'delivered'`, with `Channel2NudgeState` declared
at `:1146`. `storage-db.ts:586-596`'s `healWedgedChannel2Claims` reaps stale
`'claimed'` rows back to `''`. The two rearm paths that clear `'delivered'` are
`channel2-cycle.ts:6-24` and `:26-33`, both via
`casChannel2NudgeState(db, sessionId, "delivered", "")`.

So the host mirrors the module's own rearm logic in TypeScript, and the module's
Rust copy is the vestigial one on this profile.

### Unrecognized state strings fail open

`:9348` matches three exact literals. Any other value, including `""` (the serde
default, `:812-813`), `"PENDING"`, `"expired"`, or a truncated string, falls
through to the pressure check and re-authorizes. The field's own doc at
`:810-812` says "A terminal or already-pending lease suppresses another module
directive until the host re-arms it", which is accurate only for the three
recognized values.

## Failure scenario

Three variants, in increasing plausibility.

1. **Host crash between response and lease write.** The module returns
   `host_directives.channel2_nudge`. The host injects the reminder and dies before
   `setChannel2NudgeState(db, sessionId, "pending")`. The next request carries
   `channel2_nudge_state: ""`, pressure is still high because the agent has not
   reduced anything yet, and the module authorizes the same reminder again. Repeat
   for as long as pressure holds.
2. **A caller that does not implement the field.** Any consumer of the module's
   transform API that sends `opencode-aisdk` without the lease column gets a
   `<system-reminder>` authorized on every single pass while reclaimable tokens
   stay above 50_000 and severity above 0.75
   (`tail_hygiene.rs:17-18`). The Claude Code arm would emit at most one per
   arming cycle in the same situation.
3. **A caller sending a stale or malformed value.** A host that writes
   `"Delivered"` with a capital D, or that stores an enum's integer instead of the
   string, silently disables suppression.

In all three cases the agent is nagged repeatedly with identical text, which is
the behaviour the arming watermark exists to prevent on the other arm.

## Timing windows and dependencies

The window is any gap in which the host's lease write does not land before the
next transform request. On a busy session that is a single request interval.

Dependencies: `serializer_profile`, `req.channel2_nudge_state`, and the tail
hygiene baseline. No durable module state participates.

## What a test must construct

The check is `always` with a coverage companion, and both halves are cheap because
`channel2_directives` is a free function over borrowed inputs.

1. Build a `Channel2DirectiveInput` whose baseline yields
   `reclaimable_tokens >= CHANNEL2_FLOOR_TOKENS` and severity at or above 0.75.
   `nudge_formula_tests`'s `nudge_meta` helper (`transform.rs:9641`) already
   constructs baselines of this shape for the Channel-1 tests.
2. Call `channel2_directives` twice with
   `profile = Some(SerializerProfile::OpencodeAiSdk)`, the same `meta`, and
   `channel2_nudge_state = ""`. Assert the second call returns
   `host_directives == None`. That assertion fails today.
3. As a control, call it twice with
   `profile = Some(SerializerProfile::ClaudeCodeAnthropic)` and assert the second
   call returns the *same* directive id rather than a new one, which is the
   behaviour `:9460-9478` provides.
4. Coverage companion: assert the independent preconditions were reached, namely
   `channel2_pressure(..).due == true` and
   `req.channel2_nudge_state.is_empty()`, plus the profile under test. Per
   `METHOD.md`'s coverage rule this must not assert the duplicate itself.

There is no Rust-side existing check. The host-side equivalents live in
`packages/plugin/src/hooks/magic-context/channel2-delivery.test.ts`.

## Investigation log

### Q: Is the delegation to the host deliberate?

- Sources examined: `transform.rs:3506-3511`, the comment that reads "Tags are
  also the durable token-accounting source for host directives. Keeping them
  available on non-CC profiles is render-neutral: overlay bytes remain gated by
  `tagging_active`, while the OpenCode host can receive the same ceiling
  decision."; `:9337-9378`; the host's own state machine doc
  (`storage-meta-persisted.ts:1132-1146`).
- Findings: the comment shows the author was thinking about the OpenCode host
  receiving the same decision, and the host does implement a full lease with a
  claim token and a stale-claim reaper, which is more machinery than the module's
  own arm has. So delegation looks intentional. What the comment does not address
  is what happens when the host's write does not land, which is the case the
  Claude Code arm's TTL covers and this arm does not.
- Missing evidence: no comment on the missing latch.
- Conclusion: needs human input on whether the module should hold a fallback
  latch. The delegation itself is clearly deliberate.

### Q: Can a module-authored `pending` lease wedge on the host?

- Sources examined:
  `packages/plugin/src/hooks/magic-context/channel2-delivery.ts:140-175`,
  `:98-110` (`clearPendingChannel2Intent`), `:246-256`;
  `channel2-cycle.ts:6-33`; `storage-db.ts:586-596`.
- Findings: `pending` is cleared in three host situations: a terminal subagent run
  (`channel2-delivery.ts:148-152`), a pre-delivery revalidation that finds the
  predicate no longer holds (`:165-170`), and a claim release. But the
  revalidation is skipped when the module supplied the text:
  `if (deps.directiveText === undefined && !evaluation.shouldTrigger)`
  (`:165`), with a comment at `:156-158` saying "A module directive is already
  validated by the module, so its lease skips this TypeScript baseline check and
  preserves its text." So for a module-authored directive in a primary session,
  `pending` clears only on successful delivery. `healWedgedChannel2Claims`
  (`storage-db.ts:589-592`) reaps `'claimed'`, not `'pending'`.
- Missing evidence: whether a primary session can fail to reach a delivery step
  boundary indefinitely.
- Conclusion: unresolved, host scope. Noted because it is the mirror-image risk:
  the module can over-authorize, and the host can under-deliver, and neither side
  has a bound the other can see.

### Q: Do the two rearm helpers have any effect on the OpenCode profile at all?

- Sources examined: `:9407-9410`, `:9412-9421`, `:9423-9433`, the call sites at
  `:5326-5333`, and every read of the two fields they clear
  (`pending_channel2_directive` at `:9443`, `:9451`, `:9460`; and
  `channel2_pressure_latched` at `:9483`).
- Findings: every read of both fields is inside
  `claude_code_channel2_directive`. On the OpenCode arm they are written and never
  read. One second-order effect remains: writing them changes `meta`, so
  `state_changed` (`:5555`) can become true and force a commit that would
  otherwise be skipped. Both helpers are conditional, so that only happens when
  their own preconditions hold.
- Missing evidence: none.
- Conclusion: resolved with answer. Functionally inert, with a marginal
  commit-forcing side effect.
