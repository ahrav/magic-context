# nudge-b-channel2-retirement-is-caller-asserted

## Discovery trigger

Task 3 asked who may create an overlay. The Claude Code Channel-2 arm answers
the mirror question badly: the caller may *retire* one, by echoing back a value the
module handed it one pass earlier, with nothing corroborating that the directive
was ever shown to the agent.

## Evidence trail

`HEAD` `e447c927`. All lines read back.

### The retirement paths

`crates/mc-module/src/transform.rs:9435-9502`,
`claude_code_channel2_directive`. Three ways a pending directive goes away, in
source order:

1. **Caller assertion**, `:9440-9448`:

```
    if channel2_delivered_id.is_some_and(|delivered_id| {
        meta.pending_channel2_directive
            .as_ref()
            .is_some_and(|pending| pending.directive_id == delivered_id)
    }) {
        meta.pending_channel2_directive = None;
    }
```

2. **Lease TTL**, `:9450-9458`:

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

`CHANNEL2_DIRECTIVE_LEASE_TTL_MS` is `10 * 60 * 1_000` (`:111`).

3. **Pressure collapse**, `:9479`: inside the replay block, when
   `channel2_token_aggregate` returns a value that no longer clears the floor and
   severity gates, `Some(_) => rearm_channel2_cycle(meta)`.

Plus the two external rearm helpers, `rearm_channel2_after_hard_fold`
(`:9412-9421`) and `rearm_channel2_after_measured_collapse` (`:9423-9433`), which
run earlier in the pass at `:5326-5333`.

### The input is caller-supplied and unvalidated

`transform.rs:814-816`:

```
    /// Claude Code gateway acknowledgement for the directive appended to the preceding request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel2_delivered_id: Option<String>,
```

It is a plain `Option<String>` on the wire (`:979-980` on the wire struct,
threaded at `:1061`), and it reaches `channel2_directives` as
`req.channel2_delivered_id.as_deref()` (`transform.rs:5525`). The only check is
string equality against the pending id.

### The id is not a secret

`channel2_directive_id` (`:9505-9513`):

```
fn channel2_directive_id(session_id: &str, arming_watermark: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"mc-channel2-directive-v1\0");
    hasher.update(session_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(arming_watermark.to_be_bytes());
    format!("{:x}", hasher.finalize())
}
```

Deterministic over `(session_id, arming_watermark)`. The watermark is
`meta.channel2_arming_watermark.saturating_add(1)` (`:9488`), stored at `:9495`.
The module returns the id to the caller in the response
(`Channel2Directive { text, directive_id, armed_at_ms }`, `:1127-1132`, placed at
`:5693`), so a caller does not need to derive it: it is handed over.

That is the correct read of the mechanism. It is a **correlation token**, so the
module can tell which directive an acknowledgement refers to across passes. It is
not, and does not claim to be, proof of delivery.

### What the module does while a directive is pending

`:9460-9481` replays the pending text rather than re-arming, as long as the
pressure aggregate is missing or still above the gates. So an unacknowledged
directive keeps being returned with the same id and the same `armed_at_ms`. That
is the intended idempotence, and it is what the OpenCode arm lacks.

## Failure scenario

A caller receives `channel2_directive { text, directive_id, armed_at_ms }`, decides
not to inject the reminder for its own reasons (the user is mid-stream, the session
is a subagent, the host's own predicate disagrees), and echoes
`channel2_delivered_id` on the next request anyway. The module clears the pending
directive at `:9447`. The agent is never told that a large span of the session is
about to be comparted, so it does not reduce spent tool output first, and the
archived span is the part that mattered. The whole cycle is lost until the next
arming, which requires pressure to fall below the gates and rise again
(`:9479`, then `:9484-9486`'s `channel2_pressure_latched` check).

The damage is bounded to one arming cycle, which is the right shape. The concern is
that the *primary* retirement path has no corroboration and the module has no way
to detect the pattern, because nothing counts arms or retirements
(see `nudge-b-overlay-suppression-and-firing-are-unreportable`).

## Timing windows and dependencies

The retirement is a same-pass decision. The interesting window is the ten minutes
of `CHANNEL2_DIRECTIVE_LEASE_TTL_MS`: inside it, only the caller's word retires
the directive; at the boundary, the TTL re-arms regardless of what the caller
claimed. So a caller that lies loses at most one cycle plus up to ten minutes.

Dependencies: `serializer_profile == "claude-code-anthropic"`, `ctx.now_ms`, and
`meta.pending_channel2_directive`.

## What a test must construct

All of it is reachable from a direct call to `channel2_directives`, since the arm
is a free function over borrowed inputs and a `&mut ModuleMeta`.

1. Arm a directive: call with the CC profile, a due pressure baseline, empty
   `channel2_delivered_id`, and a fresh `ModuleMeta`. Capture the returned
   `directive_id`.
2. Call again with the same inputs plus
   `channel2_delivered_id = Some(returned_id)`. Assert
   `meta.pending_channel2_directive.is_none()` afterwards, and assert the returned
   directive is a *new* arming with an incremented watermark rather than the old
   one. That pins the retirement semantics, which nothing currently does.
3. Call again with `channel2_delivered_id = Some("not-the-id".into())` and assert
   the pending directive survives and is replayed with the same id.
4. TTL arm: advance `now_ms` by `CHANNEL2_DIRECTIVE_LEASE_TTL_MS` and assert
   `rearm_channel2_cycle` ran, meaning `pending_channel2_directive` is `None` and
   `channel2_pressure_latched` is `false`.
5. Determinism: assert `channel2_directive_id(session, n)` is stable across calls
   and differs for `n` and `n + 1`.

None of these exist. `nudge_formula_tests` (`transform.rs:9629-9783`) covers the
Channel-1 band arithmetic only.

## Investigation log

### Q: Is the CC leg live?

- Sources examined: a repository grep for `"claude-code-anthropic"`. It appears in
  `crates/mc-module/src/healing.rs:35` and `:45` (the profile enum and parser), in
  `crates/mc-module/src/lib.rs:528` and `:552` (a profile-epoch comment and table
  entry), in `ARCHITECTURE.md:125` ("On verbatim-tail profiles (where
  `fold_is_only_reclaim` is true, e.g. `claude-code-anthropic`) ..."), and in
  roughly twenty Rust test fixtures. No TypeScript sender emits it; the only
  shipped sender emits `opencode-aisdk`
  (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:1339`), and
  `packages/pi-plugin/src/` does not set the field at all.
- Findings: the profile is fully implemented, has a dedicated epoch constant, and
  is described in `ARCHITECTURE.md` as a real deployment characteristic, which
  strongly suggests a proxy outside this repository drives it. But nothing in this
  tree proves it.
- Missing evidence: the CC proxy's request builder.
- Conclusion: needs human input. The record is labelled
  `explicit-config-only` on the basis that no in-tree sender selects the profile;
  if the leg is dead the label should become `test-only`, and if the proxy ships
  it is `default-production` for those sessions.

### Q: Could a directive id be predicted before it is issued?

- Sources examined: `:9505-9513` (the derivation), `:9488` and `:9495` (the
  watermark), `ModuleMeta`'s `channel2_arming_watermark` field, and every response
  field in `transform.rs:1520-1535`.
- Findings: the derivation needs `session_id` and the *next* watermark. The
  watermark is not exposed in any response field; only the resulting
  `directive_id` is (`:1130`, emitted at `:5693`). A caller who has seen id `k`
  cannot compute id `k+1` without knowing that the watermark increments by exactly
  one, which is public in the source, and knowing the current value, which it can
  infer by counting the distinct ids it has seen for that session. So prediction is
  feasible for a caller that has observed the sequence from the start.
- Missing evidence: none.
- Conclusion: resolved with answer. Prediction is feasible but pointless: the
  caller is already handed each id. The id is a correlation token, not a
  capability, and the record's concern is the absence of corroboration rather than
  forgeability.

### Q: Does anything outside the caller's word corroborate delivery?

- Sources examined: `:9435-9502` in full; the response assembly at `:5686-5695`;
  `TransformTimings` (`:1144-1310`); the commit fields at `:5561-5597`.
- Findings: no. The module never sees the served prompt after it returns, and the
  Channel-2 text is not spliced into the array by the module at all, so there is no
  fingerprint to compare against. This is structurally different from the four
  applied overlays, where `served_output_fingerprint`
  (`:5520`) records what the module itself emitted.
- Missing evidence: none.
- Conclusion: resolved with answer. Corroboration is impossible from the module's
  position. The TTL is the only independent bound, which makes it the load-bearing
  safety mechanism on this arm.
