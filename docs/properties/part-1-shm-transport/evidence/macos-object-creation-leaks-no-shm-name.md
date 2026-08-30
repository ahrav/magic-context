# macos-object-creation-leaks-no-shm-name

## Discovery trigger

`create_macos_shm` creates a named object with `shm_open`, then removes the name
with `shm_unlink`, then sizes it with `ftruncate`. Commit `a5568707` moved the
unlink ahead of the truncate. That closes one leak window and opens a different
one: the unlink itself is now a fallible step whose failure exit leaves a named
object behind with no retained way to remove it.

## Evidence trail

`crates/mc-shm-transport/src/backend/ring.rs:1753-1788` runs, in order:
`getrandom` (`:1756`), name construction (`:1757-1764`), `shm_open` with
`O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC` and mode `0o600` (`:1766-1772`),
`OwnedFd::from_raw_fd` (`:1777`), `shm_unlink(name.as_ptr())` (`:1779`), and
`ftruncate` (`:1784`). The failure exits are:

- `shm_open` fails (`:1773-1775`) — no object, nothing to clean up.
- `shm_unlink` fails (`:1779-1781`) — the object exists **and** its name is still
  in the Darwin shared-memory namespace. The function returns
  `ObjectSetupFailed`; `fd` drops at the return, closing the descriptor and
  discarding the only handle. The name is now unreferenced by this process and no
  code in the tree will ever unlink it.
- `ftruncate` fails (`:1784-1786`) — the name is already gone, so dropping `fd`
  releases the object entirely. This is the window `a5568707` closed.

The diff confirms the direction of the change. Before `a5568707` the order was
`ftruncate` then `shm_unlink`, so an `ftruncate` failure returned with the name
still present; after it, an `shm_unlink` failure does. The leak moved rather than
disappearing, and it moved onto the step with no compensating cleanup.

Nothing else in the tree unlinks a shm name. `shm_unlink` appears exactly once in
`crates/mc-shm-transport/src`, at `:1779`. The contrast is `RuntimeDir`, which
owns its filesystem artifact and removes it in `Drop`
(`:388-392`, `std::fs::remove_dir`), and which also unwinds its own partial
construction on both validation failures (`:339-343`, `:348-352`). The shm object
has no equivalent owner: `Mapping` holds no `fd` field on macOS at all
(`:207-212`), and both constructors `drop(fd)` right after `mmap`
(`:238-239`, `:268-269`), so by the time `Mapping::create` returns there is no
descriptor and no name from which a cleanup could be driven.

The Linux path has no analogous exposure. `create_linux_memfd` (`:1716-1741`) uses
`memfd_create`, which produces an anonymous object with no namespace entry, so its
`ftruncate` and `fchmod` failure exit (`:1734-1738`) leaks nothing beyond the
descriptor that drops with it.

No CI job executes any of this. The macOS step (`.github/workflows/ci.yml:169-176`)
runs `--test contract --test fuzz_corpus`, neither of which constructs a `Ring`.

## Failure scenario

`shm_unlink` returns nonzero on a name the process just created successfully with
`O_EXCL`. The realistic triggers are resource-level: the Darwin shared-memory
namespace is a fixed-size table, and a process under an aggressive sandbox profile
or a low `RLIMIT` can see the unlink path fail where the open succeeded. Each such
failure permanently consumes one namespace slot and the object's backing pages for
the lifetime of the boot, because the name persists until something unlinks it and
nothing will. Repeated provider preparation attempts — the shape the recovery loop
produces — turn a single transient error into monotone exhaustion, after which
`shm_open` with `O_EXCL` begins failing for unrelated reasons and the failure is
reported as `ObjectSetupFailed`, the same variant, from a different line.

## Timing windows and dependencies

The window is the single statement at `:1779`, between a successful `shm_open` and
a successful `shm_unlink`. It requires no concurrency: the leak is a straight-line
error path, not a race. A crash between `:1772` and `:1779` produces the same
residue for the same reason, and that variant is wider — it spans the
`OwnedFd::from_raw_fd` at `:1777` as well. This record depends on
`macos-object-creation-outcome-is-attributed`: if the documented
`ObjectSetupFailed` originates at `:1773` then this path is never entered, and if
it originates at `:1779` then every macOS attempt leaks.

## What a test must construct

An `shm_unlink` failure with a successful `shm_open` ahead of it, then evidence
about the namespace. The direct construction is a failpoint on the unlink call, in
the style already used elsewhere in this workspace, asserting that the name is
absent afterwards. Without a failpoint, the observable arm is exhaustion: drive
creation-and-failure repeatedly and assert that the count of live shm names
returns to its starting value. Darwin exposes no `ls` over the shm namespace, so
the oracle has to be indirect — re-`shm_open` the exact leaked name with `O_EXCL`
and assert `EEXIST` does not occur, which requires the test to know the name and
therefore to drive `create_macos_shm` through a seam rather than through
`Ring::create`. A crash arm should also exist: kill the process between open and
unlink and assert the same absence, since that window is wider than the error
window.

## Investigation log

### Q: Did `a5568707` remove the name-leak window, or relocate it?

- Sources examined: `git show a5568707 -- crates/mc-shm-transport/src/backend/ring.rs`
  restricted to `create_macos_shm`; `ring.rs:1753-1788` at HEAD; `ring.rs:1716-1741`
  for the Linux comparison; `ring.rs:207-212`, `:238-239`, `:268-269` for
  descriptor retention; `ring.rs:316-392` for `RuntimeDir`'s ownership and unwind
  as the in-repo precedent; every occurrence of `shm_unlink` in the crate;
  `.github/workflows/ci.yml:159-176`.
- Findings: relocated. The pre-`a5568707` order left the name after an `ftruncate`
  failure; the post-`a5568707` order leaves it after an `shm_unlink` failure. The
  new window is narrower — one call instead of one call plus a conversion — but it
  is the one window with no cleanup available, because the fix's own ordering means
  the name is the last thing the function can still be holding when it fails.
  `RuntimeDir` demonstrates the pattern the shm path lacks: an owner with a `Drop`
  and an explicit unwind on each early return.
- Missing evidence: whether Darwin shm names survive the last descriptor close is
  the load-bearing external fact, and I could not test it. POSIX specifies that
  the name persists until `shm_unlink` regardless of open descriptors, which is
  what makes the residue permanent, but I did not confirm Darwin's conformance
  here. Whether `shm_unlink` can fail at all after a successful `O_EXCL`
  `shm_open` is likewise unverified; if it cannot, this record is invalidated and
  should be marked so rather than left open.
- Conclusion: resolved with answer on the code question, unresolved on the
  platform question. The asymmetry between the two error exits is verified from the
  diff and from HEAD. Whether the remaining exit is reachable needs a macOS run.
