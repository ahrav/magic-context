# runtime-directory-authentication-is-a-precondition-not-a-container

## Discovery trigger

`RuntimeDir` (`crates/mc-shm-transport/src/backend/ring.rs:291-377`) reads like a
security-load-bearing component: a 128-bit random name, `mkdir` at `0o700`, an
`O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` descriptor held open, an inode cross-check
between the by-path and by-fd views, an owner check, a file-type check, a mode
check, and a `validate()` that repeats all five before every ring creation. The
inventory reports no negative test for any of it
(`docs/properties/part-1-shm-transport/existing-checks.md:170`). Before writing a
property about it, the scoping question had to be settled: what is actually inside
the directory the authentication protects. The answer is nothing, on either
platform.

## Evidence trail

Authentication. `create_in` (`:316-359`) draws 16 random bytes (`:317-318`),
builds `root.join("mc-shm-{suffix}")` (`:326`), calls `mkdir` with `0o700`
(`:330`), opens the result with `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` (`:333-337`)
and removes the directory if the open fails (`:341`), then stats both views —
`symlink_metadata` by path (`:345`) and `File::metadata` by fd (`:346`) — and
requires all five of: both views are directories, the inodes are equal, the fd's
owner is the effective uid, and the fd's mode is exactly `0o700` (`:349-357`), on
failure removing the directory and returning `RingError::ObjectValidationFailed`.
`validate()` (`:362-381`) re-evaluates the identical five clauses in positive
form. `Ring::create_in` calls it at `:549`, before any object exists, so both
directions of a `DuplexRing` (`:1416-1426`) re-authenticate the one shared
directory.

What is inside it. Nothing, ever. `RuntimeDir`'s only public items are
`create_in` and `validate`; `path` and `fd` are private (`:310-311`) with no
accessor, so no caller can name a location inside it. `Ring::create_in` does not
pass the directory to object creation: it calls `Mapping::create(layout.total)`
(`:569`), whose signature takes a length and no path (`:216`).

On Linux the object is an anonymous memfd. `create_linux_memfd`
(`:1717-1741`) calls `memfd_create` with `MFD_CLOEXEC|MFD_ALLOW_SEALING`
(`:1720-1726`), then `ftruncate` and `fchmod(0o600)` (`:1734-1736`). A memfd has
no filesystem name at all, so the directory cannot be its container even in
principle.

On macOS the object is not in the directory either. `create_macos_shm`
(`:1753-1788`) calls `shm_open` with the name `/mc-shm-<32 hex>`
(`:1757-1772`) — the global POSIX shared-memory namespace, not a path under
`root` — and `shm_unlink`s it immediately (`:1779`), leaving only the descriptor.

What the object's confidentiality does rest on: the anonymity or immediate
unlinking above, mode `0o600`, the fd-only `validate_object` check of owner,
exact size, type on Linux, and `st_mode & 0o077 == 0` (`:1677-1702`), the seals
`F_SEAL_GROW|SHRINK|SEAL` on Linux (`:1744-1751`, verified on attach at
`:1706-1714`), and the `/proc/<pid>/fd` handoff. None of these consult the
directory.

The root is `std::env::temp_dir()` (`:537`, `:1418`), so `TMPDIR` selects it.

Teardown is not authenticated. `Drop` (`:390-394`) calls
`std::fs::remove_dir(&self.path)` — by path, not `unlinkat` on the held
descriptor, and with no `validate()` first.

Do not confuse this with the host's runtime directory. `mc_host::runtime_dir_path`
(`crates/mc-host/src/instance.rs:178-180`) is `data_dir/run`, it does hold files —
connection files — and it has negative tests
(`crates/mc-host/tests/instance_security.rs:48`, `:108`, `:158`, `:211`). The
transport's `RuntimeDir` is a different, unrelated object.

## Failure scenario

The reachable consequence of a tampered directory is a refusal, not a leak. An
attacker who can win the window between `mkdir` (`:330`) and the open (`:333`) —
or who can change the directory's mode or owner between `create_in` and a later
`validate()` — makes `Ring::create_in` return `ObjectValidationFailed` at `:549`,
so the shared-memory candidate fails to prepare and the host falls back. The
converse, an attacker who defeats the checks, gains nothing against the object:
there is no object inside the directory to reach on either platform.

The residual is the unauthenticated teardown. If `TMPDIR` names a directory the
attacker can write and that lacks the sticky bit, the attacker can `rmdir` our
empty directory and re-create their own at the same name, and our `Drop` will
remove theirs. `rmdir` on a path whose final component is a symlink fails with
`ENOTDIR`, so this cannot be redirected to delete a directory elsewhere; it is a
narrow denial primitive against a same-user process, inside a trust model that
already grants a same-user peer write access to the mapped payload
(`docs/mc-host-shm-transport.md:116`).

The scenario worth guarding against is not an attack but a belief: a future
change that stores something real under this directory — a bootstrap file, a
macOS object path, a lock — would inherit the authentication as if it had always
covered contents, when what exists today covers only the container.

## Timing windows and dependencies

Two windows exist and both are narrow. The first is `mkdir` at `:330` to the
`O_DIRECTORY|O_NOFOLLOW` open at `:333`, closed after the fact by the inode
equality check at `:351`, which detects a swap rather than preventing it. The
second is between any `validate()` and the operation that follows it, unbounded in
principle but immediately followed by object creation that does not use the
directory, which is why the window carries no weight. No dependency on other Part
1 records. The macOS-side facts overlap gap G2, which has no properties yet.

## What a test must construct

Four negative cases against `RuntimeDir::validate`, none of which needs a fault
harness — a temporary root and ordinary filesystem calls suffice: `chmod 0o755`
on the directory, `chown` where the environment permits it, replacing the
directory with a fresh one of the same name so the inode differs from the held
descriptor, and replacing it with a symlink to another directory. Each must assert
`ObjectValidationFailed` specifically, not merely an error, since
`ObjectSetupFailed` is the neighbouring variant and a test asserting `is_err()`
would pass on the wrong branch. A fifth case covers `create_in` itself:
pre-create the target path so `mkdir` fails, and assert no directory is left
behind. The happy path needs nothing new — every `Ring::create` in
`crates/mc-shm-transport/tests/ring.rs` (for example `:67`, `:150`, `:257`) runs
`create_in` and `validate` already, which is why the absence of a negative case
went unnoticed. Worth adding beside them: an assertion that the directory is
empty at drop, which is the check that fails first if a future change starts
storing something there and inherits a guarantee this record says it does not
have.

## Investigation log

### Q: Is the validated runtime directory used on Linux at all, or is the validation load-bearing only on macOS?

- Sources examined: `ring.rs:291-377` for the whole `RuntimeDir` type and its
  public surface; `:542-549` and `:1418-1428` for both creation sites;
  `:551-557` for the `validate()` call; `:216-247` for `Mapping::create`;
  `:1712-1736` for `create_linux_memfd`; `:1748-1783` for `create_macos_shm`;
  `:1677-1702` for `validate_object`; a repository-wide grep for `RuntimeDir`,
  which returns only the definition, the two creation sites, the `Ring` field at
  `:538`, and the `DuplexRing` field at `:1414`, and nothing in
  `crates/mc-shm-transport/tests/`.
- Findings: it is not used on Linux, and it is not used on macOS either. Linux
  objects are anonymous memfds with no filesystem name (`:1715-1721`); macOS
  objects live in the global `shm_open` namespace under a `/`-prefixed name and
  are unlinked immediately (`:1752-1774`). `Mapping::create` takes only a length.
  `RuntimeDir` exposes no path or fd, so nothing can be placed inside it. Its
  entire observable effect is the fail-closed precondition at `:557`, an empty
  `0o700` directory in `temp_dir()` for the ring's lifetime, and `remove_dir` at
  `:375` — consistent with `remove_dir` succeeding, which requires the directory
  to be empty.
- Missing evidence: the intent. The type is named and shaped as though it were a
  container, and the macOS branch could plausibly have been meant to create the
  object under it before `shm_open` was chosen. Git archaeology on the commit that
  introduced `create_macos_shm` was not performed.
- Conclusion: resolved. The property is real and untested, but it is a
  defence-in-depth precondition, not a confidentiality boundary, on both
  platforms. That fixes its priority as low and its impact as availability-only,
  and it is the reason the record is written to say what the authentication does
  *not* cover.
