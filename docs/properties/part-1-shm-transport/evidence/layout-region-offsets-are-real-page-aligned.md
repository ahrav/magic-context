# layout-region-offsets-are-real-page-aligned

## Discovery trigger

`Layout::new` aligns two region offsets to `PAGE_SIZE` and then adds `PAGE_SIZE`
once more for the lifecycle page. `PAGE_SIZE` is a compile-time `4096`. The crate
also has a `system_page_size()` helper that reads `sysconf(_SC_PAGESIZE)`, and
exactly one caller uses it. So the layout's page arithmetic and the kernel's page
granularity are two different numbers on any host whose page is not 4096.

## Evidence trail

`crates/mc-shm-transport/src/backend/ring.rs:28` declares
`const PAGE_SIZE: usize = 4096`. `Layout::new` (`:141-182`) uses `CACHELINE`
(128) for the three control pages and `PAGE_SIZE` for the rest: `arena =
align_up(slots + slot_bytes, PAGE_SIZE)` (`:158-163`), `lifecycle =
align_up(arena + arena_bytes, PAGE_SIZE)` (`:164-169`), and `total =
lifecycle.checked_add(PAGE_SIZE)` (`:170-172`). `system_page_size()`
(`:194-200`) exists and falls back to `PAGE_SIZE`, but its only caller is
`verify_prefaulted` (`:1009`), which uses it to size the `mincore` residency
vector. No layout arithmetic consults it.

`total` is what leaves the crate. `Ring::create_in` passes it to
`Mapping::create(layout.total)` (`:569`), which `ftruncate`s the object to that
length (`:1734` on Linux, `:1784` on macOS) and `mmap`s exactly `len`
(`:224-234`). It is also published in the grant as `total_bytes` (`:566`) and
re-derived on the attaching side by `checked_layout`, which requires
`layout.total == total` (`:478-480`). So both sides agree on a number computed
from a constant neither of them checks against the kernel.

I computed the layout for the three profiles that exist in the tree —
`lease_limited_profile` depth 2 (`tests/ring.rs:43`), `qualified_test_profile`
depth 8 (`crates/mc-host/src/ring_transport.rs:824`), and `ring_profile` depth 32
(`src/profile.rs:681`) — all with `arena_bytes = MIN_ARENA_BYTES = 67_108_864`
(`src/arena.rs:4-6`), using `size_of::<DescriptorSlot>() = 256` and 128 for each
of the three control pages. Depth 2 and depth 8 produce identical offsets because
both slot regions fit inside the first 4096 bytes.

| | depth 2 and 8 | depth 32 |
| --- | --- | --- |
| slots | 384 | 384 |
| arena | 4096 | 12288 |
| lifecycle | 67112960 | 67121152 |
| total | 67117056 | 67125248 |

Under a 4096-byte page every one of `arena`, `lifecycle`, and `total` is a
multiple of the page size, the lifecycle page occupies a real page alone, and the
arena ends exactly where the lifecycle page begins. Under a 16384-byte page, with
the same as-built offsets, `arena % 16384` is 4096 for depth 2 and 8 and 12288 for
depth 32; `lifecycle % 16384` is the same; and `total % 16384` is 8192 for depth 2
and 8 but 0 for depth 32. Depth 32 satisfies the total-is-a-page-multiple property
by coincidence, since 67125248 is exactly 4097 × 16384. Had `Layout::new` used
16384, arena would be 16384 and lifecycle 67125248 for every depth, and total would
be 67141632 — 24576 bytes larger than the depth-2 and depth-8 figure and 16384
larger than the depth-32 figure.

## Failure scenario

On a 16 KiB-page host the lifecycle page stops being a page. For depth 8, real
page 4096 spans bytes 67108864 to 67125248; the lifecycle structure sits at
67112960 for 128 bytes (`LifecyclePage` is 128 bytes, `:117-129`), and the arena's
final 4096 bytes — bytes 67108864 to 67112960, peer-writable payload — occupy the
first quarter of that same real page. For depth 32 the shared prefix is 12288
bytes. The lifecycle page holds the magic, the layout version, the geometry
echoed by `validate_lifecycle`, the incarnation, the lane, and the `quarantined`
flag. Any reasoning or mechanism with page granularity — `mprotect` to make the
control page read-only to one role, `mincore` residency attributed per region,
`madvise` on the arena, or a hardware watchpoint — now covers arena payload and
lifecycle state as one unit and cannot separate them. The arena's start is
likewise not on a real page boundary, so it shares its first real page with the
three control pages and the entire descriptor-slot array.

The second divergence is the mapping tail. For depth 2 and 8, `total` of
67117056 is not a multiple of 16384, so `mmap` and `ftruncate` round the mapping
up to 67125248 and 8192 bytes are addressable past `mapping.len`. `ptr_at`
bounds-checks every typed access against `self.len` (`:283-290`), and both
prefault walks stop at `len`, so those 8192 bytes are mapped, writable, and never
initialised — reachable only through a pointer computed outside `ptr_at`.
`Mapping::drop` munmaps `len` (`:302-306`), which the kernel rounds up, so they
are released.

## Timing windows and dependencies

No fault and no race. This is fixed at construction and holds for the mapping's
lifetime. The enabling condition is purely environmental: a host whose
`sysconf(_SC_PAGESIZE)` is not 4096, which means Apple Silicon macOS or an
aarch64 Linux kernel built with 16 KiB or 64 KiB pages. It shares that condition
with `page-size-dependent-setup-runs-on-a-non-4096-page-host`, and on macOS it is
gated behind `macos-object-creation-outcome-is-attributed`, since creation must
succeed before a layout is mapped at all.

## What a test must construct

A ring created on a host whose page size is not 4096, asserting that `arena`,
`lifecycle`, and `total` are each multiples of `system_page_size()`. The offsets
are private, so this needs either an accessor or a unit test inside the module,
alongside the existing `residency_vector_len` test (`:1790-1800`). The stronger
form is a pure test that does not need special hardware: call the layout
computation with an injected page size of 16384 and 65536 and assert the same
three divisibility conditions, which fails today at HEAD because the page size is
not injectable. A depth sweep matters — depth 32 passes the `total` condition and
fails the other two, so a single-depth test can conclude the wrong thing. The tail
arm asserts `total % system_page_size() == 0`, which is what removes the 8192
addressable bytes past `len`.

## Investigation log

### Q: Is the layout total required to be a multiple of the real page size, or only of 4096?

- Sources examined: `ring.rs:27-28`, `:116-182`, `:186-204`, `:215-245`,
  `:266-289`, `:461-478`, `:544-590`, `:1009`, `:1672-1677`, `:1729`, `:1779`,
  `:1785-1795`; `src/arena.rs:4-6`, `:225-236`; `src/profile.rs:681-684`;
  `tests/ring.rs:20-55`; `crates/mc-host/src/ring_transport.rs:821-827`; the diff
  of `a5568707` restricted to the page-size change. The offsets in the table were
  computed by replicating `Layout::new` with verified struct sizes
  (`size_of::<DescriptorSlot>() = 256`, 128 for each control page,
  `size_of::<SharedDescriptor>() = 120`), not read from a run.
- Findings: not required by any in-tree caller. `mmap` accepts a non-page-multiple
  length and rounds up; `ftruncate` accepts one; `munmap` accepts one; and
  `residency_vector_len` (`:204-205`) already computes `div_ceil` against the
  runtime size, so `mincore`'s vector is correctly sized regardless. The
  consequences are the shared real page between the lifecycle structure and the
  arena tail, the non-page-aligned arena start, and the addressable slack past
  `len` — none of which is an immediate memory-safety violation, and all of which
  break the region separation the 4096 alignment was evidently there to create.
- Missing evidence: nothing in the repository states why `arena` and `lifecycle`
  are page-aligned rather than cacheline-aligned like the three control pages. If
  the intent is only cacheline separation then 4096 is over-alignment and the
  16 KiB divergence is harmless; if the intent is page separation then it is a
  defect. No comment, plan, or traceability entry records the intent.
- Conclusion: resolved with answer on the arithmetic, unresolved on the
  requirement. The divergence is exact and reproducible; whether page separation
  is a contract needs the design owner.
