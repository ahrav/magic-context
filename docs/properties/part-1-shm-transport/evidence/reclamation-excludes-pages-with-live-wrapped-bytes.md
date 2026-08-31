# reclamation-excludes-pages-with-live-wrapped-bytes

## Discovery trigger

Fix commit `b3e10a256` "keep reclamation off pages containing live wrapped
bytes". Before it, `removal_ranges` rounded its start *down* to a page
boundary, so `MADV_REMOVE` could zero the head of a page whose leading bytes
still belonged to an unreleased frame. Lead only; re-verified at HEAD.

## Evidence trail

- Reclamation is producer-driven: `reclaim_completed`
  (`crates/mc-shm-transport/src/backend/ring.rs:1470-1571`) walks the
  contiguous completed prefix, validates each descriptor, and computes
  `[reclaimed, new_reclaimed)` as the logical byte run to return.
- `removal_ranges` (`:221-273`) converts that run to physical ranges. The
  fixed start rounds *up*: a `logical_start` not on a page boundary advances
  to the next boundary (`:243-249`); the end rounds *down* (`:250`); an
  empty result short-circuits (`:251-253`). At the arena wrap the run splits
  into at most two ranges (`:257-259`), both inside the arena.
- Consequence: `remove_pages` (`:279-287`, `MADV_REMOVE`) only ever touches
  pages every byte of which lies inside the released run. A page shared with
  a live neighbor — including the page holding the tail of a wrapped frame's
  first span — is left resident.
- The one trailing exception is explicitly guarded (`:1533-1548`): the
  partial page at `reclaimed` is removed only when
  `arena_write == new_reclaimed` (nothing live anywhere ahead, `:1534`) and
  the run crossed that page's boundary (`:1535-1536`). Under that guard the
  page contains only released bytes plus dead slack.
- Failure containment: a nonzero `madvise` return quarantines before any
  capacity is published (`:1514-1517` via the `remove` closure), and
  `arena_reclaimed` is stored only after every removal succeeded
  (`:1557-1563`, "capacity becomes visible only after every removal
  succeeds").

## Failure scenario

Frame A ends mid-page; frame B starts on the same page and is still leased.
A is released and reclaimed. With round-down, `MADV_REMOVE` covers the shared
page and B's leading bytes read back as zeros — silent data corruption in a
frame the receiver already validated, with no error anywhere. The wrap
variant is the same defect where B is the second span of a frame that
wrapped the arena end.

## Timing windows and dependencies

No interleaving is required: the defect class is arithmetic, reachable
single-threaded. Dependencies: the runtime page size (`system_page_size`,
`:288-299`) — a 16 KiB host makes partial-page sharing far more common — and
the FIFO ordering that `reclaim_completed` enforces
(`allocation_start == reclaimed + run_len`, `:1495-1500`), which is what
makes "everything before `new_reclaimed` is dead" a sound premise.

## What a test must construct

- The pure function: partial pages at both ends and a wrap split. Exists:
  `removal_ranges_exclude_partial_pages_and_split_once_at_wrap`
  (`ring.rs:2279-2297`) sweeps 4/16/64 KiB pages, asserts a sub-page run
  removes nothing, an unaligned run removes only its interior page, and a
  wrapping run splits into two exact ranges.
- The live-neighbor oracle: reclaim beside a held lease, then read the
  neighbor's bytes back. Exists:
  `partial_page_reclaim_preserves_live_neighbor` (`:2337-2353`).
- The eventual-progress complement: sub-page releases still converge to
  whole-page removal (`repeated_subpage_releases_eventually_remove_complete_pages`,
  `:2319-2335`) and removed pages read back as zeros
  (`reclaimed_pages_leave_residency_and_reuse_as_zeroes`, `:2300-2317`).
- Not yet constructed: the trailing-partial-page exception (`:1533-1548`)
  under a *wrapped* `arena_write` — every existing case reaches it with a
  linear cursor — and any of this on a non-4096-page host (fault class F11).

## Investigation log

### Q: is the trailing-page exception sound when the cursor wrapped?

- Sources examined: `:1533-1548`; `logical_page % arena_bytes` mapping at
  `:1540-1542`.
- Findings: the guard compares logical (unwrapped, monotone) values, and the
  physical offset is derived by modulo, so the mapping is consistent; but
  `arena_write == new_reclaimed` with both mid-lap is a state no test
  constructs, and the equality is between values a hostile peer cannot forge
  only because both pages are producer-owned.
- Conclusion: unresolved, needs a test that reaches the exception with a
  wrapped cursor.
