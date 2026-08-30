# page-size-dependent-setup-runs-on-a-non-4096-page-host

## Discovery trigger

Commit `a5568707` fixed a page-size defect by replacing `self.mapping.len
.div_ceil(PAGE_SIZE)` with `residency_vector_len(self.mapping.len,
system_page_size())` in `verify_prefaulted`, and added a unit test for the new
helper. It changed nothing else. Three page-size notions survive in the tree and
only one of them reads the kernel, so the fix repaired the consumer of the page
size while leaving the producers on a constant.

## Evidence trail

The three notions, in `crates/mc-shm-transport`:

1. `const PAGE_SIZE: usize = 4096` (`src/backend/ring.rs:28`), used by
   `Layout::new` at `:164`, `:170`, `:172`, and by `prefault_read` at `:1673`.
2. A bare literal `let page = 4096usize` (`src/arena.rs:229`), used by the
   `prefault` write walk at `:230`. This one does not even reference the constant,
   so a change to `PAGE_SIZE` would not reach it.
3. `system_page_size()` (`src/backend/ring.rs:194-200`), which reads
   `sysconf(_SC_PAGESIZE)` and falls back to `PAGE_SIZE`. Its sole caller is
   `verify_prefaulted` at `:1009`.

`verify_prefaulted` is a hard gate on creation, not a diagnostic:
`Ring::create_in` returns `PrefaultFailed` if it reports false (`:586-588`). That
is why the pre-`a5568707` form was a real defect. With a 16 KiB page and the
depth-8 layout, `mapping.len` is 67117056; the old code sized the vector
`67117056 / 4096 = 16386` entries, `mincore` writes only
`ceil(67117056 / 16384) = 4097`, and the remaining 12289 entries stay zero, so
`residency.into_iter().all(|entry| entry & 1 == 1)` (`:1019`) is false and every
creation fails. At depth 32 the numbers are 16388 written down to 4097, leaving
12291. The current form computes 4097 directly and matches what `mincore` writes.

The two prefault walks are not defective in the same direction, and this is worth
recording because it is the reason the half-fix went unnoticed. Both step by 4096
over `0..len`. Where the real page is larger, stepping by a smaller amount touches
every real page several times: it over-touches, never under-touches. For the
depth-8 layout the last offset `prefault_read` visits is 67112960, which lies
inside real page 4096 (67108864 to 67125248), the same real page that contains
`len`. `arena::prefault` additionally writes `base.add(len - 1)` (`:235`). So
residency is complete and `verify_prefaulted` agrees. The cost is four times the
volatile accesses needed on a 16 KiB host, which is waste rather than
incorrectness. The direction that would break coverage — a real page smaller than
4096 — does not occur on either supported target.

No host in CI exercises any of this. `.github/workflows/ci.yml:132` builds
`[ubuntu-latest, macos-latest]`. The Linux step (`:159-166`) runs
`cargo nextest run -p mc-shm-native -p mc-shm-transport` with no target filter, so
it runs the lib target and therefore
`residency_vector_tracks_runtime_page_size` (`src/backend/ring.rs:1785-1795`) —
but on an x86-64 runner whose page size is 4096, where the assertion about 16384
is a property of the pure function and not of any mapping. The macOS step
(`:168-175`) runs `cargo nextest run -p mc-shm-transport --test contract --test
fuzz_corpus`; `--test` selects integration targets, so the lib target is excluded
and even that pure test does not run on macOS. Neither step runs `tests/ring.rs`
on macOS, and `tests/contract.rs` and `tests/fuzz_corpus.rs` construct no `Ring`.

## Failure scenario

The only in-tree evidence that any page-size code is correct is a pure-function
assertion on a 4096-page host. The end-to-end path — `Layout::new`, `ftruncate`,
`mmap`, both prefault walks, `mincore`, and the `PrefaultFailed` gate — has never
run together on a host where the constant and the kernel disagree. That is the
exact configuration where the previous defect lived, and it is the configuration
where the residual defects in `layout-region-offsets-are-real-page-aligned` take
effect. A subsequent change that reintroduces a 4096 assumption into the residency
path, or that starts depending on the arena or lifecycle offsets being real pages,
is invisible to CI.

The gap is sharpened by where the 16 KiB page actually occurs. `macos-latest` maps
to Apple Silicon runners, whose page size is 16384, so CI already provisions a
16 KiB host every run — and it is precisely the host on which no `Ring` is ever
constructed, because `Ring::create` fails there for an unattributed reason. The
one platform that would have caught the original defect is the one platform where
the code does not execute.

## Timing windows and dependencies

No fault and no race; the condition is environmental and constant for a host. This
record is coverage for `layout-region-offsets-are-real-page-aligned`, which states
the substantive alignment property, and it is blocked on macOS by
`macos-object-creation-outcome-is-attributed`. On Linux it is not blocked: an
aarch64 runner with a 16 KiB or 64 KiB kernel would execute the whole path today.

## What a test must construct

Execution of `Ring::create` to completion on a host whose
`sysconf(_SC_PAGESIZE)` is not 4096, asserting that `verify_prefaulted` returns
true rather than that creation merely does not error — the gate already conflates
the two, so the assertion has to read the probe. The cheap construction is an
aarch64 Linux job with a 16 KiB or 64 KiB page kernel added to the CI matrix, which
needs no macOS work. The alternative is making the page size injectable so the
whole layout-and-prefault path can be driven at 16384 and 65536 on any host; that
also unblocks the pure arms in
`layout-region-offsets-are-real-page-aligned`. A second, independent arm is to add
`--test ring` to the macOS command, which does not by itself establish page-size
coverage but does put the 16 KiB host in contact with the code.

This is location and environment coverage, so the assertion must be that the path
executed and its own probe passed. It must not assert a page-size violation.

## Investigation log

### Q: Did `a5568707` leave any page-size-dependent code on the constant, and does any of it under-cover pages rather than over-cover them?

- Sources examined: `git show a5568707 -- crates/mc-shm-transport/src/backend/ring.rs`
  in full; `src/backend/ring.rs:28`, `:141-182`, `:194-204`, `:574-593`,
  `:1008-1022`, `:1672-1677`, `:1785-1795`; `src/arena.rs:221-236`; every
  occurrence of `PAGE_SIZE`, `system_page_size`, `residency_vector_len`, and
  `4096` in the crate; `.github/workflows/ci.yml:126-177`; the import lists of
  `tests/contract.rs` and `tests/fuzz_corpus.rs`. Residency-vector and offset
  figures were computed, not observed.
- Findings: the fix touched `verify_prefaulted` and added `system_page_size` plus
  `residency_vector_len` and its test. `Layout::new` and both prefault walks were
  left on 4096, and `src/arena.rs:229` is a separate literal rather than the
  constant. Of the three residual sites, the two prefault walks over-touch and are
  therefore harmless in the direction that matters; the layout arithmetic is the
  load-bearing one. The `mincore` mismatch that the fix repaired reproduces exactly
  in arithmetic at both depths.
- Missing evidence: that `macos-latest` provisions arm64 with a 16384-byte page is
  external to this repository. I could not query the runner image from here, and
  the workflow pins only the label. If the label still resolved to an x86-64
  image, CI would have no 16 KiB host at all, which strengthens rather than weakens
  the record. Whether the arena and lifecycle offsets are contractually pages is
  the open design question, and it belongs to
  `layout-region-offsets-are-real-page-aligned`.
- Conclusion: resolved with answer. Three page-size sources, one of them reading
  the kernel, and no end-to-end execution on a host where they differ. The
  half-fix is confirmed from the diff rather than inferred from the current state.
