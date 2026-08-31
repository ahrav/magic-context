# render-a-composition-order-is-fixed-and-each-unit-appears-once

## Discovery trigger

Mapping the rendering pipeline required knowing every site that appends to the
served array. Enumerating them showed the array is built by straight-line code
with exactly five append sites, which makes the ordering and once-only property
statable and cheap to check.

## Evidence trail

All references read back at `HEAD` `e447c927`.

`build_output_with_tags_inner` (`crates/mc-module/src/transform.rs:11678-12156`)
is the only function that builds the served array. `out` is allocated at `:11695`
with `Vec::with_capacity(4 + req.messages.len())` — the `4` is m0, m1, and a
two-message todo pair.

The five `out.push` sites, in source order, which is also emission order:

| Site | Unit | Gate |
| --- | --- | --- |
| `:11733` | m0 | `!req.is_subagent` (`:11709`) and `frozen_units.by_key("m0")` is `Some` (`:11710`) |
| `:11754` | m1 | same `!req.is_subagent`, and `frozen_units.by_key("m1")` is `Some` (`:11735`) |
| `:11830` | unanchored synthetic todo pair, two messages | `synthetic_todo_enabled` (`:11804`) and `pair.anchor_mid.is_none()` (`:11808`) |
| `:12089` | one retained tail message | the retention filter at `:11856-11862` and the `present` gate at `:12037-12039` |
| `:12117` | anchored synthetic todo pair, two messages | `synthetic_todo_enabled && !inserted_synthetic_todo` (`:12091`), `pair.anchor_mid.is_some()`, and `synthetic_todo_render_anchor == Some(msg.mid)` (`:12092-12095`) |

The tail loop is `for msg in req.messages.iter().filter(|m| !m.ck.meta.synthetic)`
(`:11842-11846`). There is no `sort`, no `reverse`, no index arithmetic, and no
second pass over `req.messages`. So the emitted tail is a subsequence of
`req.messages` in request order.

Once-only for the tail follows from the loop visiting each message at most once
and pushing at most one message per iteration.

Once-only for the anchored todo pair follows from `inserted_synthetic_todo`,
declared `false` at `:11840`, tested at `:12091` and set at `:12119`.

Mutual exclusion of the two todo branches: the unanchored branch filters
`pair.anchor_mid.is_none()` (`:11808`) and the anchored branch requires
`pair.anchor_mid.is_some()` (`:12093`), on the same `meta.synthetic_todo`
reference. They cannot both fire.

Post-loop, `:12125-12133` turns a missed anchored insertion into
`TransformError::SyntheticTodoAnchorMissing`, so a placement failure is
reported rather than absorbed. This is the only such report in the splice.

The last transformation is `out = enforce_unique_tool_use_ids(out, &req.session_id)`
at `:12147`. In a release build it can remove blocks and drop an emptied message
(`:11297-11299`); it never adds, reorders, or duplicates.

Ordering is meaningful, not incidental: `prev_assistant` (`:11707`, updated at
`:11829`, `:12088`, `:12116`) feeds `first_assistant_in_run` (`:11875`), which is
hashed into the output identity (`:11058`) and drives the serializer residual
(`:12047`). So a reorder would change bytes, not just position.

## Failure scenario

A future change adds a second append path — for example emitting a message both
from the cache-hit arm and the fresh arm — and one message appears twice. The
provider sees a duplicated turn, the prefix diverges from the cached prefix at
that point, and the prompt cache is busted for the rest of the session. A
reorder has the same effect with no duplicate to grep for.

## Timing windows and dependencies

None. The splice borrows every input immutably and runs on one thread. The only
non-argument reads are `Instant::now()` for timings and the `eprintln!` in the
duplicate belt, neither of which reaches the bytes.

## What a test must construct

1. A request whose `messages` include synthetic and non-synthetic entries, some
   inside coverage and some outside, plus a `meta.synthetic_todo` with
   `anchor_mid` set to a mid in the tail.
2. Render, then assert:
   - the non-synthetic emitted mids are a subsequence of `req.messages`'s mids in
     order;
   - no mid appears twice in the emitted array;
   - the todo call and result appear exactly once, adjacent, immediately after
     the anchor message.
3. Repeat with `anchor_mid = None` and assert the pair appears before every tail
   message.
4. Repeat with `req.is_subagent = true` and assert neither m0 nor m1 is present.

## Investigation log

### Q: Can the anchored and unanchored synthetic-todo branches both fire in one pass?

- Sources examined: `transform.rs:11804-11833`, `:12091-12121`, and the
  `meta.synthetic_todo` field they both read.
- Findings: both read the same `Option<SyntheticTodoPair>`. The unanchored branch
  filters on `pair.anchor_mid.is_none()`; the anchored branch requires
  `pair.anchor_mid.is_some()`. The predicates partition.
- Missing evidence: none.
- Conclusion: resolved with answer — no. At most one pair is emitted per pass.

### Q: Does the cache-hit arm bypass the retention filter?

- Sources examined: `transform.rs:11856-11862` (retention filter, before the
  identity and the lookup), `:11903-11908` (the lookup).
- Findings: the filter `continue`s before any cache work, so a message excluded
  by coverage is never looked up and never emitted, cached or not.
- Missing evidence: none.
- Conclusion: resolved with answer — no bypass.
