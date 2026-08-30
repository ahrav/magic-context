# attach-validation-is-not-platform-weakened

## Discovery trigger

`Mapping::attach` calls `validate_seals` behind `#[cfg(target_os = "linux")]`, and
`validate_object` decides its file-type check with `cfg!(target_os = "linux")`.
Both of the checks that establish *what kind of object* is being mapped and
*whether it can still change size* are therefore Linux-only. The attach entry
point itself is not gated, so macOS compiles a public attach with strictly fewer
admission conditions than Linux.

## Evidence trail

In `crates/mc-shm-transport/src/backend/ring.rs`, `Mapping::attach` (`:249-274`)
runs `validate_object(&fd, len)` (`:250`) then
`#[cfg(target_os = "linux")] validate_seals(&fd)?` (`:251-252`) before `mmap`.
`validate_seals` (`:1705-1714`) is itself `#[cfg(target_os = "linux")]` and
requires `F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL`. Its counterpart on the
create side, `seal_object` (`:1743-1751`), is also `#[cfg(target_os = "linux")]`
and is invoked from `Ring::create_in` inside a `#[cfg(target_os = "linux")]` block
together with a second `validate_object` call (`:573-577`). macOS runs neither.
There is no macOS substitute: `create_macos_shm` (`:1753-1788`) has no sealing
step, and Darwin has no `F_SEAL_*` family to call.

`validate_object` (`:1677-1703`) computes `type_valid` at `:1689-1693`:

    let type_valid = if cfg!(target_os = "linux") {
        stat.st_mode & libc::S_IFMT == libc::S_IFREG
    } else {
        true
    };

so on macOS the type predicate is a constant `true`, and the surviving
conditions at `:1694-1701` are `st_uid == geteuid()`, `st_size >= 0`,
`st_size as usize == expected_len`, and `st_mode & 0o077 == 0`. The carve-out's
justification is the comment at `:1686-1688`, which asserts that Darwin populates
`st_mode` for `shm_open` descriptors from the creation mode alone without
file-type bits. That is a claim in a comment; no check in the tree executes it,
and the macOS CI step does not run the file that would (see
`macos-object-creation-outcome-is-attributed`).

What compensates on macOS is not a check but an absence of handles. The `Mapping`
struct carries `fd: OwnedFd` only under `#[cfg(target_os = "linux")]`
(`:207-212`), and both constructors `drop(fd)` immediately after `mmap` under
`#[cfg(target_os = "macos")]` (`:238-239`, `:268-269`). `create_macos_shm` also
`shm_unlink`s the name before returning (`:1779`). So a macOS ring object has no
name and, after construction, no descriptor: `Ring::raw_fd` (`:619-622`),
`Ring::attachment` (`:625-640`), `Ring::set_inheritable` (`:642`), and the whole
`RingAttachment` type (`:497-518`) are `#[cfg(target_os = "linux")]`. Both
`attach_ring` helpers that would supply a descriptor go through
`/proc/{pid}/fd/{fd}` and are Linux-gated
(`packages/mc-shm-native/src/lib.rs:237-246`,
`crates/mc-host/src/shm_provider.rs:779-789`), and `create_test_pair` returns an
error on non-Linux (`packages/mc-shm-native/src/lib.rs:552-560`). macOS thus gets
size immutability by unreachability, not by sealing.

## Failure scenario

`Ring::attach` (`:593-611`) is `pub` and compiled on macOS, so the weakening is
already in the public surface even though no in-tree caller can reach it there.
Any macOS descriptor source added later — an fd over a Unix socket via
`SCM_RIGHTS`, which is the natural Darwin replacement for `/proc`, or a caller
outside this workspace — lands on an attach that accepts a descriptor of *any*
type whose uid, exact size, and permission bits match, and that never checks
whether the object can still shrink. Two consequences follow. A regular file on
disk of exactly `grant.total_bytes`, mode `0600`, owned by the euid, passes
`validate_object` and is mapped `MAP_SHARED | PROT_READ | PROT_WRITE`, putting the
ring on persistent storage. And a peer retaining a descriptor can `ftruncate` the
object smaller after validation, so accesses to the mapped tail fault with
`SIGBUS` — precisely the outcome `F_SEAL_SHRINK` exists to prevent on Linux.

## Timing windows and dependencies

The type gap has no window; it holds at every macOS attach. The shrink gap has
one: the interval between `validate_object`'s `fstat` (`:1681`) and any later read
of the mapping, which is the mapping's whole lifetime because nothing re-checks.
On Linux that window is closed by seals rather than by re-checking, which is why
removing seals removes the guarantee rather than merely the assertion. This record
depends on `macos-object-creation-outcome-is-attributed`: while creation fails,
the weakening is latent.

## What a test must construct

Three arms, all on macOS, all needing `tests/ring.rs` in the macOS command.
Premise arm: assert that no macOS API in the crate yields an `OwnedFd` for a ring
object, so the current safety rests on unreachability and is recorded as such.
Type arm: build a regular file of exactly the grant's `total_bytes` with mode
`0600` owned by the euid, hand it to `Ring::attach` with a self-consistent grant,
and assert refusal. Today that assertion fails, which pins the gap. Shrink arm:
retain a second descriptor to a shm object, attach, `ftruncate` it shorter, and
assert either that attach refused or that the shorter object is detected before
any tail access. A control on Linux must show the same two arms refused by
`validate_object` and `validate_seals` respectively, so the macOS failures are
attributable to the missing checks and not to the test setup.

## Investigation log

### Q: Is the macOS attach genuinely reachable, or is the missing seal check harmless because no descriptor can exist?

- Sources examined: `ring.rs:207-212`, `:215-245`, `:249-274`, `:278-281`,
  `:497-518`, `:544-590`, `:593-611`, `:619-640`, `:642`, `:1677-1703`,
  `:1705-1714`, `:1743-1751`, `:1753-1788`; every `target_os` occurrence in
  `crates/mc-shm-transport/src`, `packages/mc-shm-native/src`, and
  `crates/mc-host/src/shm_provider.rs`; both `attach_ring` helpers;
  `create_test_pair`; `docs/mc-host-shm-transport.md:117` for the trusted-peer
  boundary; `docs/evidence/mc-shm-traceability-v1.json:48`.
- Findings: unreachable in-tree today. No macOS code path produces an `OwnedFd`
  for a ring object, so the missing seal check cannot currently be exercised. But
  the crate builds only for Linux and macOS — `Mapping::create` (`:216-220`) binds
  `fd` under those two cfgs and nothing else, so any third target fails to compile
  — and `Ring::attach` is exported on macOS regardless. The protection is
  structural absence of handles, not a stated decision.
- Missing evidence: the Darwin `st_mode` premise at `:1686-1688` is unverified. If
  it is wrong, the carve-out discards a check that would have worked, and a
  `S_IFMT == 0 || S_IFMT == S_IFREG` form would have covered both platforms. I
  could not run `fstat` on a Darwin `shm_open` descriptor.
- Conclusion: resolved with answer, qualified. The asymmetry is real and verified
  from cfg attributes. Its current impact is nil because attach is unreachable on
  macOS; the property exists so that adding a Darwin descriptor path is forced to
  supply a substitute for seals rather than inheriting an attach that has none.
