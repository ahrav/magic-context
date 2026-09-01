# nudge-b-channel2-pending-directive-rearms-within-the-lease-ttl

## Discovery trigger

Not a lens pass. This record was created by refinement `R3` of the Part 4e
portfolio evaluation, which found that
`nudge-b-channel2-retirement-is-caller-asserted` mixed a safety claim with a
bounded-progress claim: its `Guarantee` read "retired only when it was actually
delivered, **or else the retirement is bounded** so a lost directive is re-armed",
and its `always` check listed the lease TTL alongside two other permitted
transitions. Bounded progress is liveness under METHOD.md's liveness rules and
cannot be asserted inside an `always`, so the bounded half became this record.

Provenance of the material below, stated because this file was not produced by a
discovery pass. Everything in the evidence trail, the failure scenario, the timing
section and the test construction is drawn from the parent record in `catalog.md`
and from `evidence/nudge-b-channel2-retirement-is-caller-asserted.md`, whose
"Evidence trail" section 2 quotes the TTL arm verbatim, whose "Timing windows and
dependencies" states the ten-minute window, and whose "What a test must construct"
step 4 is the construction this record needs. Nothing here is new discovery. What
is new is the framing as a bounded window rather than as one permitted transition,
plus four line references re-verified at `HEAD` for this file and two corrections
that verification produced. The parent's third investigation question, which
concluded that corroboration is impossible from the module's position, is the
reason this record matters rather than being a formality, and it is cited rather
than restated.

## Evidence trail

`HEAD` `e447c927`. All lines read back for this file.

### The bounded arm

`crates/mc-module/src/transform.rs:9450-9458`, inside
`claude_code_channel2_directive` (which opens at `:9434`):

```
    if meta
        .pending_channel2_directive
        .as_ref()
        .is_some_and(|pending| {
            now_ms.saturating_sub(pending.armed_at_ms) >= CHANNEL2_DIRECTIVE_LEASE_TTL_MS
        })
    {
        rearm_channel2_cycle(meta);
    }
```

The predicate is `:9454`. The action is `rearm_channel2_cycle(meta)` at `:9457`,
defined at `:9407-9410`, and it clears both fields:

```
fn rearm_channel2_cycle(meta: &mut ModuleMeta) {
    meta.pending_channel2_directive = None;
    meta.channel2_pressure_latched = false;
}
```

Clearing `channel2_pressure_latched` is what makes the next pass able to arm
again, because the arming path returns early on
`if !pressure.due || meta.channel2_pressure_latched` (`:9484-9486`). So the TTL is
a re-arm rather than a plain cancellation, which is why the record's guarantee is
about the arm becoming usable again and not only about the pending field emptying.

### The bound, in the unit the code bounds

`const CHANNEL2_DIRECTIVE_LEASE_TTL_MS: i64 = 10 * 60 * 1_000;` at `:111`. The
comparison is against `now_ms.saturating_sub(pending.armed_at_ms)`, so the unit is
milliseconds of the caller-supplied clock reaching the function as `now_ms`. That
is the bound METHOD.md's liveness rules require to be stated, and it is stated in
the code rather than proposed by this record, which distinguishes this liveness
record from its Channel-1 sibling.

### The deadline does not slide

`armed_at_ms` is written in exactly one place, `armed_at_ms: now_ms` at `:9492`
inside the arming block `:9488-9497`. While the directive stays pending the replay
block at `:9460-9481` returns `armed_at_ms: pending.armed_at_ms` in both of its
returning arms (`:9463-9466` when `channel2_token_aggregate` yields `None`, and
`:9473-9476` when the aggregate still clears the floor and severity gates). So a
replay pass does not restart the lease, and the deadline is fixed at arming. This
answers the record's second open question and is the one substantive fact this
file establishes that the parent file did not.

### Order of the three retirement causes in one pass

Source order inside the function is: caller assertion `:9442-9448`, TTL
`:9450-9458`, then the replay block whose `Some(_)` arm at `:9479` is the pressure
collapse. The caller-assertion arm sets `meta.pending_channel2_directive = None`
at `:9447`, so if a matching `channel2_delivered_id` arrives the TTL predicate
finds `None` and does not fire. Two causes therefore cannot both be credited for
one retirement, which matters for the test: the construction must supply no
`channel2_delivered_id`, or it proves the wrong arm.

## Failure scenario

A caller never implements the acknowledgement, or implements it and crashes
between receiving the response and sending the next request. Pressure stays above
the floor and severity gates. Without the TTL the replay block returns the same
`text`, the same `directive_id` and the same `armed_at_ms` on every pass for the
life of the session, and `channel2_pressure_latched` stays `true` so no new
directive can ever be armed. The agent sees one housekeeping warning repeated
indefinitely and the arm never re-arms to describe the session's actual state.

With the TTL the same sequence costs one lease interval. The parent record's
concern is that the primary retirement path has no corroboration; the corollary,
which is this record, is that the TTL is the only retirement cause the module can
reach without trusting the caller. The parent's third investigation question
established that corroboration is impossible from the module's position, because
the module never sees the served prompt after it returns and the Channel-2 text is
not spliced into the array by the module at all, so there is no fingerprint to
compare against. That makes the TTL load-bearing rather than a fallback.

The failure would be silent. Nothing counts arms or retirements, per
`nudge-b-overlay-suppression-and-firing-are-unreportable`, so a wedged arm
produces no counter and no timing field.

## Timing windows and dependencies

The window is the lease: ten minutes of `now_ms`. The fault is the absence of an
acknowledgement. The fault-free requirement inside the window is that nothing else
touches the directive, and there are three ways that requirement can be violated,
all of which invalidate the test rather than the property:

- The pressure aggregate falls below the gates, so `:9479` retires the directive
  as a collapse and the TTL never runs.
- `rearm_channel2_after_hard_fold` (`:9412-9421`) or
  `rearm_channel2_after_measured_collapse` (`:9423-9433`) fires earlier in the
  pass, at the call site the parent evidence file records as `:5326-5333`.
- The caller supplies a matching `channel2_delivered_id`, which retires at `:9447`
  before the TTL is evaluated.

Dependencies: `serializer_profile == "claude-code-anthropic"`, a caller-controlled
`ctx.now_ms`, and `meta.pending_channel2_directive` populated by an earlier arming.

## What a test must construct

Step 4 of the parent record's evidence file, made the whole of this record's
oracle rather than one assertion among five:

1. Arm a directive: call `channel2_directives` with the CC profile, a due pressure
   baseline, no `channel2_delivered_id`, and a fresh `ModuleMeta`. Capture
   `armed_at_ms` from the returned `Channel2Directive`.
2. Confirm the window is fault-free by calling again at
   `armed_at_ms + CHANNEL2_DIRECTIVE_LEASE_TTL_MS - 1` with the same pressure
   inputs and no delivered id, and asserting the directive is replayed with the
   same `directive_id` and the same `armed_at_ms`. This is the half that proves the
   later assertion is about the TTL and not about a collapse.
3. Advance `now_ms` to `armed_at_ms + CHANNEL2_DIRECTIVE_LEASE_TTL_MS`, call once
   more, and assert `meta.pending_channel2_directive.is_none()` and
   `meta.channel2_pressure_latched == false`.
4. Assert the arm is usable again: with pressure still due, the same pass or the
   next one returns a *new* arming whose `arming_watermark` is one higher and whose
   `directive_id` differs, rather than the old directive.

The whole construction is a direct call to `channel2_directives`, which is a free
function over borrowed inputs and a `&mut ModuleMeta`, so no store, no clock seam
and no second process is needed. The parent evidence file establishes that; this
file inherits it.

## Investigation log

### Q: Is the CC leg live?

- Sources examined: none newly. The parent record's evidence file investigated
  this and its finding is inherited unchanged: `"claude-code-anthropic"` appears in
  `crates/mc-module/src/healing.rs:35` and `:45`, in `crates/mc-module/src/lib.rs:528`
  and `:552`, in `ARCHITECTURE.md:125`, and in roughly twenty Rust test fixtures,
  while no TypeScript sender in this repository emits it and the only shipped sender
  emits `opencode-aisdk`
  (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1339`).
- Findings: the question is not narrowed by splitting the record. If the leg is
  dead this record is `test-only` along with its parent.
- Missing evidence: the CC proxy's request builder, outside this tree.
- Conclusion: needs human input. Inherited from the parent record, and the
  `explicit-config-only` label rests on the same basis.

### Q: Does any caller-reachable path reset `armed_at_ms`, sliding the deadline forward?

- Sources examined: every write to `armed_at_ms` in `transform.rs` (one, at
  `:9492`), the `PendingChannel2Directive` construction at `:9489-9494`, both
  returning arms of the replay block (`:9463-9466`, `:9473-9476`), and the
  `Channel2Directive` response type the caller receives.
- Findings: the field is set once, at arming, from `now_ms`. The replay arms copy
  it. No other assignment exists, and the caller supplies `now_ms` but has no field
  through which to supply `armed_at_ms`.
- Missing evidence: none.
- Conclusion: resolved with answer. The deadline is fixed at arming, so the bound
  is a real bound rather than a rolling one. This is what makes the check writable
  as a single bounded window instead of a polling loop with no fixed end.

### Q: Do the two external rearm helpers make the TTL redundant?

- Sources examined: `rearm_channel2_after_hard_fold` (`:9412-9421`),
  `rearm_channel2_after_measured_collapse` (`:9423-9433`), and the parent evidence
  file's note that both run earlier in the pass at `:5326-5333`.
- Findings: no. Both are conditional on session progress the wedge scenario
  excludes by construction: the first needs `hard_fold_executed` together with an
  advance in coverage, the second needs a refreshed baseline whose effective tail
  has fallen below `CHANNEL1_FLOOR_TOKENS`. A caller that never acknowledges while
  pressure stays high satisfies neither, which is exactly the state the TTL exists
  to end.
- Missing evidence: none.
- Conclusion: resolved with answer. The TTL is the only unconditional bound on the
  arm, which is the claim the record's `Impact` makes.
