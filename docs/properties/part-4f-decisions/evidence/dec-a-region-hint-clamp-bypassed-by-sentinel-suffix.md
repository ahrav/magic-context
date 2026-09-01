# dec-a-region-hint-clamp-bypassed-by-sentinel-suffix

## Discovery trigger

Task 3 asks for algebraic and metamorphic properties the domain actually claims, and
names idempotence as one to look for. `selection.rs:557` claims idempotence in a doc
comment, which makes it a checkable claim. Reading the implementation showed the
claim is true and that the mechanism delivering it also disables the clamp the
function exists to apply.

## Evidence trail

The claim. `selection.rs:556-557`:

```
/// Clamp a diff value to a region hint (edit_marker): first `EDIT_REGION_HINT_LEN`
/// UTF-16 units + the sentinel. Idempotent (already-hinted values pass through). Pure.
```

The implementation, `selection.rs:558-571`:

```
fn region_hint(value: &str) -> String {
    if value.ends_with(TRUNCATION_SENTINEL) {
        return value.to_string();
    }
    if utf16_len(value) > EDIT_REGION_HINT_LEN {
        format!(
            "{}{}",
            utf16_prefix(value, EDIT_REGION_HINT_LEN),
            TRUNCATION_SENTINEL
        )
    } else {
        value.to_string()
    }
}
```

with `EDIT_REGION_HINT_LEN = 40` (`:69`) and
`TRUNCATION_SENTINEL = "...[truncated]"` (`:71`).

**Idempotence holds.** Three cases:

- input already ends with the sentinel: `:559-561` returns it unchanged, so a second
  call returns it unchanged again;
- input longer than 40 UTF-16 units: the output ends with the sentinel by
  construction, so a second call takes the first arm;
- input at most 40 units and not sentinel-suffixed: returned unchanged, and a second
  call is identical.

**The clamp does not hold.** The first arm is a suffix test on the *content*, not a
marker the function itself placed. Any value whose real text ends with the literal
`...[truncated]` is returned verbatim at whatever length it happens to be. I
constructed a 5,014-character string ending with the sentinel and confirmed the
predicate `ends_with(TRUNCATION_SENTINEL)` is true for it, so the function takes the
short-circuit arm and returns all 5,014 characters.

The truncation helpers themselves are sound, which is worth stating because it
localises the defect. `utf16_prefix` (`transform.rs:9070-9082`):

```
pub(crate) fn utf16_prefix(text: &str, limit: usize) -> &str {
    let mut used = 0;
    let mut end = 0;
    for (start, character) in text.char_indices() {
        let next = used + character.len_utf16();
        if next > limit {
            break;
        }
        used = next;
        end = start + character.len_utf8();
    }
    &text[..end]
}
```

It advances whole characters and stops before exceeding the limit, so it can never
split a surrogate pair and can never slice off a character boundary. The existing
test pins exactly that, `selection.rs:2537-2549`:

```
fn edit_marker_region_hint_caps_utf16_and_backs_off_split_surrogate() {
    let split_astral = format!("{}😀tail", "a".repeat(39));
    assert_eq!(
        region_hint(&split_astral),
        format!("{}{}", "a".repeat(39), TRUNCATION_SENTINEL)
    );

    let complete_astral = format!("{}😀tail", "a".repeat(38));
    assert_eq!(
        region_hint(&complete_astral),
        format!("{}😀{}", "a".repeat(38), TRUNCATION_SENTINEL)
    );
}
```

Two of the three arms are covered. The sentinel arm is not.

**Where the value comes from.** `edit_marker_payload` (`selection.rs:577-595`):

```
for (key, value) in obj.iter_mut() {
    if FILE_PATH_KEYS.contains(&key.as_str()) { continue; }
    if !DIFF_KEYS.contains(&key.as_str()) { continue; }
    if let serde_json::Value::String(s) = value {
        *value = serde_json::Value::String(region_hint(s));
    }
}
canonical_json(&serde_json::Value::Object(obj))
```

`DIFF_KEYS` is `["oldString", "newString", "content", "old_string", "new_string"]`
(`:61-67`). These are the arguments of an `edit` or `write` tool call, so their content
is whatever the agent wrote or whatever it read out of the user's files. A source file
containing the literal `...[truncated]` at the end of an edited region is enough; no
adversary is needed, and the string is a common one in logs and in code that does its
own truncation.

**The gate.** `edit_marker_payload` is reached only through the supersession selector,
which is gated on `cfg.smart_drops`. `selection.rs:1229`, in the `EmergencyForce` arm:

```
if cfg.smart_drops && (!emergency_arc_ids.is_empty() || !two_pass_arc_ids.is_empty()) {
```

and `:1236`, in the `Execute` arm:

```
if cfg.smart_drops && (ctx.supersession_ride_available || !two_pass_arc_ids.is_empty())
{
```

`smart_drops` defaults to `false` (`config.rs:135`), and `CONFIGURATION.md:752`
documents that default. So the record is `explicit-config-only`.

**What the documentation promises.** `CONFIGURATION.md:761`, describing the smart-drop
classes:

> Superseded edits | When a file is edited more than once, the newest edit stays in
> full and each older edit is compressed to a marker that keeps its `filePath` and a
> short region hint of the diff, so the agent still sees which file and region it
> edited. This is the largest source of reclaimable bytes.

"a short region hint" and "the largest source of reclaimable bytes" are both false for
a sentinel-suffixed value: the older edit keeps its whole diff and reclaims nothing.

## Failure scenario

A user has `smart_drops: true`. They are working in a repository whose code writes
truncated log lines, so several source files contain the literal `...[truncated]`. In
one session the agent edits the same file three times, and in the second edit the
`oldString` argument happens to end on one of those lines.

On a pass where the supersession selector runs, the two older edits are selected. For
the edit whose `oldString` does not end with the sentinel, `region_hint` clamps it to
40 UTF-16 units plus the sentinel, reclaiming the rest. For the edit whose `oldString`
does end with the sentinel, `region_hint` returns the whole diff, which might be
thousands of characters.

The decision is then frozen. `selection.rs:1287-1289` explains that the shape is
"Decided ONCE here (freeze-time)", so the unclamped payload is what every subsequent
defer pass replays, verbatim, for the life of that frozen unit. The reclaim accounting
that chose to reduce the arc believed it would recover the arc's bytes; it recovered
almost none of them, and nothing detects the shortfall because the accounting is done
before the payload is built.

The severity is bounded: it wastes a reduction opportunity and leaves bytes in the
context. It does not corrupt state and it does not lose content. But it is a clamp
that harness-supplied content can walk past, which is the same shape as the
tag-imitation defences in 4e that exist precisely because content can imitate module
markers.

## Timing windows and dependencies

None within a pass. The cross-pass dependency is the freeze: because the payload is
decided once and replayed, a single unlucky value persists rather than being
reconsidered on the next pass.

## What a test must construct

One assertion, in the existing test's style:

```
let hostile = format!("{}{}", "x".repeat(5_000), TRUNCATION_SENTINEL);
let hinted = region_hint(&hostile);
assert!(utf16_len(&hinted) <= EDIT_REGION_HINT_LEN + utf16_len(TRUNCATION_SENTINEL));
```

which fails today, returning 5,014 units.

The idempotence half deserves its own assertion, because any fix must preserve it:

```
let once = region_hint(&long_value);
assert_eq!(region_hint(&once), once);
```

That passes today and would keep passing under a length-aware guard, but would fail
under a naive fix that dropped the suffix check entirely.

An end-to-end assertion through `edit_marker_payload` is worth adding too, because the
payload is the frozen artifact: build an `edit` input with an `oldString` ending in the
sentinel, call `edit_marker_payload`, and assert the serialized length is bounded.

## Investigation log

### Q: Should the guard test for a well-formed hint rather than a bare suffix?

- Sources examined: `selection.rs:556-571`; `:69` and `:71` (the constants); the
  parallel use of the same sentinel in `skeleton_payload` at `:688-692`, which appends
  it after a character-count clamp and has **no** suffix pre-check, so it re-clamps
  unconditionally and cannot be bypassed this way.
- Findings: `skeleton_payload` demonstrates that the suffix check is not required for
  correctness, only for idempotence. A length-aware guard would satisfy both: return
  unchanged only when the value ends with the sentinel **and** its UTF-16 length is at
  most `EDIT_REGION_HINT_LEN + utf16_len(TRUNCATION_SENTINEL)`. That preserves
  idempotence for genuinely hinted values and clamps everything else.
- Missing evidence: whether the TypeScript twin, which `selection.rs:575-576` names as
  `applyEditMarkerToInput`, has the same short-circuit. If it does, changing the Rust
  side alone would break the differential golden that `selection.rs:32-33` calls the
  arbiter.
- Conclusion: needs human input. The fix shape is clear; whether it can land without
  a coordinated change to the TypeScript twin is not.

### Q: Is the clamp reachable on a default build?

- Sources examined: `config.rs:135` (`smart_drops: false`); `CONFIGURATION.md:752`
  (documented default `false`) and `:767` ("The default stays off while cache
  stability is being validated in the wild. Requires a restart to take effect");
  `selection.rs:1229` and `:1236` (both gates).
- Findings: no. `edit_marker_payload` is unreachable without `smart_drops: true`, on
  both the emergency and the execute arm. Note that a project-tier config can set it
  (`config.rs:541-543`), which is the subject of
  `dec-a-project-tier-can-write-leaves-outside-the-documented-allow-list`, so the two
  records compose: a repository can enable the path, and the path has this hole.
- Missing evidence: none.
- Conclusion: resolved with answer. Reachability is `explicit-config-only`, with the
  evidence being the two `cfg.smart_drops` gates and the `false` default.
