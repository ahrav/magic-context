# validated-spans-are-disjoint-and-inside-the-arena

## Discovery trigger

`FrameDescriptor::validate` never mentions overlap. The fuzz oracle in
`crates/mc-shm-transport/src/harness.rs` asserts each span's end against the
arena bound and asserts the span lengths sum to the body length, but it never
compares span 0 against span 1. Since every descriptor field is peer-writable,
"two spans over the same bytes" is a shape an attacker would try, so the question
is whether the accept path excludes it and by what argument.

## Evidence trail

All references are to `crates/mc-shm-transport/src/descriptor.rs`,
`FrameDescriptor::validate` (`:332-433`), in evaluation order.

- `:363-365` — `body_len > MAX_FRAME_BYTES` is rejected as `FrameTooLarge`.
- `:367-369` — one combined guard: `arena_bytes == 0 || allocation_len >
  arena_bytes || allocation_len < body_len` rejects as `InvalidAllocation`. This
  is where `body_len <= allocation_len <= arena_bytes` is established.
- `:373-375` — `span_count` must be in `1..=MAX_SPANS`, so `1` or `2`.
- `:376-378` — `spans[0].offset != allocation_start % arena_bytes` rejects as
  `InvalidWrapMetadata`. `allocation_start` is itself an untrusted field, so this
  ties span 0's offset to another attacker-chosen value, not to a trusted one.
- `:380-386` — `first_end = spans[0].offset + spans[0].len` is computed with
  `checked_add` and rejected if `first_end > arena_bytes` (`OutOfBounds`).
- `:387-393` — `summed = spans[0].len + spans[1].len` and `summed != body_len`
  rejects as `LengthMismatch`.
- `:401-410` — the two-span arm. Five conditions, any one of which rejects:
  `spans[0].is_empty()` (`:402`), `spans[1].is_empty()` (`:403`), `first_end !=
  arena_bytes` (`:404`), `spans[1].offset != 0` (`:405`), `spans[1].len >
  arena_bytes` (`:406`).
- `:395-400` — the one-span arm requires `spans[1] == ArenaSpan::default()`, so
  the single-span case is trivially disjoint and in-bounds via `:384`.
- `crates/mc-shm-transport/src/harness.rs:75` — the fuzz target calls
  `descriptor.validate(identity, MAX_FRAME_BYTES)`. The arena argument is the
  constant floor, never anything larger.
- `crates/mc-shm-transport/src/harness.rs:76-89` — the accept-path assertions:
  body bound, span count, per-span `end <= MAX_FRAME_BYTES`, and `summed ==
  body_len`. No pairwise comparison.
- `crates/mc-shm-transport/tests/contract.rs:63` and `:643` — the two tabled
  negative tests. Neither constructs an overlapping pair.

## The derivation

Write span 0 as `[o0, o0 + l0)` and span 1 as `[o1, o1 + l1)`. For `span_count ==
2`, the accepted conditions give:

1. `l0 >= 1` and `l1 >= 1` — from `:402-403`.
2. `o0 + l0 == arena_bytes` — from `:404`, so `o0 == arena_bytes - l0`.
3. `o1 == 0` — from `:405`, so span 1 is `[0, l1)`.
4. `l0 + l1 == body_len` — from `:391`.
5. `body_len <= allocation_len <= arena_bytes` — from `:367`.

Chaining 4 and 5 gives `l0 + l1 <= arena_bytes`, hence `l1 <= arena_bytes - l0`.
Substituting 2 gives `l1 <= o0`. Span 1's end is `l1` by 3, and span 0's start is
`o0`, so `span1.end <= span0.start` and the two are disjoint. Both are inside the
arena: span 0 by 2, and span 1 because `l1 <= o0 <= arena_bytes`. Disjointness is
therefore a consequence of four independent guards evaluated in three separate
places, never a stated condition.

Each of conditions 2, 3, and 4 is individually load-bearing:

- Relax 2 (`first_end != arena_bytes`), keeping only `:384`'s `first_end <=
  arena_bytes`: with `arena_bytes = 100`, `allocation_start = 10`,
  `allocation_len = 100`, `body_len = 90`, `spans[0] = (10, 10)`, `spans[1] =
  (0, 80)`, every remaining guard passes and `[0, 80)` overlaps `[10, 20)`.
- Relax 4 (the sum check): `l1` becomes unconstrained above, so with `o0 + l0 ==
  arena_bytes` any `l1 > o0` overlaps.
- Relax 3 (`spans[1].offset != 0`): with `arena_bytes = 100`, `spans[0] = (90,
  10)`, `spans[1] = (90, 10)`, `body_len = 20` — both spans are the same range.

Condition 3 is the one whose relaxation does the most damage, and is the answer
to "which single condition, if relaxed, re-opens overlap" in the strongest
sense: `:405` is the *only* constraint on span 1's position anywhere in
`validate`. `:406` bounds `spans[1].len` alone, and there is no
`spans[1].offset + spans[1].len <= arena_bytes` check. So removing `:405` breaks
both disjointness and the in-arena claim at once — a span could sit wholly
outside the arena — whereas removing `:404` or `:391` breaks only disjointness,
with span 0 still bounded by `:384`.

## Failure scenario

A peer writes a descriptor whose two spans cover the same arena bytes. If the
conjunction above were ever weakened, `try_receive` would build two `LeaseSpan`s
over one range (`ring.rs:816-823`), the addon would expose two writable external
ArrayBuffers aliasing the same memory
(`packages/mc-shm-native/src/lib.rs:865-868`), and `to_vec` would produce a body
whose two halves are the same bytes. No guard downstream re-checks disjointness:
`lease_span` (`ring.rs:1088-1104`) bounds each span independently.

## Timing windows and dependencies

None. This is a pure decoding property over one snapshot read
(`ring.rs:801`, `:1125`). The exposure is structural rather than temporal: the
guarantee is an emergent consequence of guards written for other purposes, so any
refactor that reorders, merges, or relaxes one of them silently removes it.
Related to `reclaim-advance-bounded-by-the-producer-reservation`, which consumes
the same validated record but trusts a different field of it.

## What a test must construct

Two things the current fuzz target does not do. First, `arena_bytes >
MAX_FRAME_BYTES`, so that `:404`'s `first_end == arena_bytes` and `:367`'s
`allocation_len <= arena_bytes` are genuinely distinct bounds rather than
coincident constants. Second, an explicit pairwise assertion on the accept path:
for every accepted descriptor with `span_count == 2`, assert `spans[1].offset +
spans[1].len <= spans[0].offset` and that both spans lie in `[0, arena_bytes)`.
Coverage checks `shm_two_span_frame_validated` and
`shm_arena_larger_than_minimum_validated` witness that the non-trivial shape is
actually reached; neither asserts the violation, so both still fire on a correct
implementation.

## Investigation log

### Q: none recorded — the catalog lists "Open questions: None".

The record carries no open question, so this log records the one thing that had
to be settled to accept the record's claim as written.

- Sources examined: `descriptor.rs:332-433` in full;
  `crates/mc-shm-transport/src/arena.rs:88-115` for whether the producer's
  `SpanPlan::reserve` could be the real source of disjointness;
  `harness.rs:56-100`; `tests/contract.rs:63` and `:643`.
- Findings: the catalog names three conditions and says "relaxing any one
  re-opens overlap". That is correct, and the derivation above supplies the
  counterexamples it did not. The catalog's line citations `:367`, `:387-393`,
  and `:401-409` all resolve; `:401-409` is the two-span arm whose closing brace
  is at `:410`, so the arm is `:401-410`. `SpanPlan::reserve` does produce
  disjoint spans, but it runs on the producer only and its output is re-read from
  peer-writable memory before validation, so it cannot be the source of the
  guarantee.
- Missing evidence: none for the derivation. What is missing is any assertion of
  it — no test, fuzz oracle, or production guard states disjointness.
- Conclusion: resolved with answer. Disjointness holds at HEAD as a derived
  consequence; `:405` is the single condition whose relaxation also breaks the
  in-arena claim, because it is the only bound on span 1's offset.
