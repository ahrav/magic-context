# runtime-directory-revalidation-rejects-a-substituted-directory

## Discovery trigger

`RuntimeDir` (`crates/mc-shm-transport/src/backend/ring.rs:291-377`) is
security-shaped: a random 128-bit name, `mkdir` at 0700, an open with
`O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`, a five-way conjunction comparing the
by-path view against the by-descriptor view, and a `validate` method that
re-establishes the same conjunction before each use. Nothing in the repository
tests any of it — a search for `RuntimeDir` across `crates/` and `packages/`
finds only the declaration, the struct field, and the three call sites. That
raises two questions at once: does the conjunction actually reject a substituted
directory, and does the directory guard anything?

## Evidence trail

`create_in` (`:316-359`) generates 16 random bytes (`:317-318`), formats them as
hex into `mc-shm-<suffix>` under the caller's root (`:319-326`), and calls
`libc::mkdir` with mode 0700 (`:330`). It then opens the path read-only with
`O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC` (`:333-337`), removing the directory if
the open fails (`:340-343`). It takes `symlink_metadata` on the path (`:345`) and
`metadata` on the descriptor (`:346`), reads `geteuid` (`:348`), and requires all
five of: `by_path.is_dir()`, `by_fd.is_dir()`, `by_path.ino() == by_fd.ino()`,
`by_fd.uid() == current_uid`, and `by_fd.permissions().mode() & 0o777 == 0o700`
(`:349-354`). Any failure removes the directory and returns
`ObjectValidationFailed` (`:355-356`).

`validate` (`:362-381`) repeats exactly the same five conditions against the
retained descriptor and the retained path, and returns `ObjectValidationFailed`
otherwise. It does not remove the directory. `Drop` (`:390-394`) calls
`remove_dir` and discards the result.

Three call sites. `Ring::create` (`:536-541`) builds one under
`std::env::temp_dir()` and moves it into `owned_runtime_dir`. `Ring::create_in`
(`:544-549`) takes a `&RuntimeDir` and calls `runtime.validate()?` as its first
statement. `DuplexRing::create` (`:1417-1426`) builds one, creates both lanes
under it, and holds it in `_runtime` so it outlives them.

**The directory is never used again.** `Ring::create_in` does not pass it to
anything after `:549`; the object comes from `Mapping::create(layout.total)`
(`:569`), which on Linux calls `create_linux_memfd` (`:218`) and on macOS calls
`create_macos_shm` (`:220`).

`create_linux_memfd` (`:1716-1741`) calls `memfd_create` with the static name
`c"mc-shm-transport"` and `MFD_CLOEXEC | MFD_ALLOW_SEALING`, then `ftruncate` and
`fchmod` to 0600. A memfd has no filesystem path, so no directory can contain it.

`create_macos_shm` (`:1753-1788`) builds a random name `/mc-shm-<hex>`, calls
`shm_open` with `O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC` and mode 0600
(`:1766-1772`), and calls `shm_unlink` immediately (`:1779`). That name lives in
the POSIX shared-memory namespace, not in the runtime directory, and it is
removed before the object is mapped.

Authentication of the object itself is descriptor-based and independent of the
directory: `validate_object` (`:1677-1703`) fstats the descriptor and requires
matching effective uid, exact expected size, a regular-file type on Linux, and no
group or other permission bits; on Linux `validate_seals` (`:1706-1714`) then
requires `F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL`. Those run on both the create
path (`:222`) and the attach path (`:250-252`), which is what
`docs/mc-host-shm-transport.md:116` means by owner-only attachment establishing
same-user authentication.

## Failure scenario

The gate's own failure modes are what a negative test would pin. Between `mkdir`
at `:330` and `open` at `:336` the path is a name another process could act on. A
symlink substituted there is caught by `O_NOFOLLOW`. A different real directory
substituted there is caught by the uid check at `:352` if it belongs to another
user, and by the mode check at `:353` if its permissions differ. A `chmod` to
0755 after creation is caught by `validate` on the next `Ring::create_in`. A
`chown` cannot be performed by an unprivileged attacker. In a sticky temp
directory another user cannot remove our directory at all. None of these
conclusions is exercised; all of them are read off the code.

What the gate does not do is protect the shared object, because the object is not
in it on either platform. So the consequence of the gate being wrong is bounded
by what a wrong answer costs: a false rejection fails `Ring::create` or
`DuplexRing::create` with `ObjectValidationFailed`, which surfaces as
`RingUnavailable` at `crates/mc-host/src/ring_transport.rs:263` (`ProviderFailure`
was removed with `shm_provider.rs` in `ed487e11`) and
falls back to TCP. A false acceptance admits a directory the process then never
writes to. Because `create_in` reads its root from `std::env::temp_dir()`, a
hostile `TMPDIR` chooses where the empty directory is created and removed, and
`O_NOFOLLOW` covers only the final component — but with nothing stored there, the
reachable effect is denial of ring creation, not disclosure or substitution.

## Timing windows and dependencies

One window, the `mkdir`-then-`open` gap described above, narrowed by 128 bits of
name randomness. `validate` is called once per `Ring::create_in`, so between two
lanes of a `DuplexRing` there is a second window in which the directory could be
replaced; the second `validate` at `:549` is what closes it, and it is the only
reason the revalidation method exists.

No dependency on the quarantine, publication, or accounting groups. This is the
one property in the catalog about filesystem setup rather than shared-memory
state.

## What a test must construct

Five negative cases against `create_in` and the same five against `validate`,
since the conjunctions are duplicated rather than shared: replace the path with a
symlink to another directory; replace it with a different real directory;
replace it with a regular file; widen the mode to 0755; and present a directory
owned by another uid. The first four are constructible unprivileged in a
temporary root. The fifth needs a second user or a container, and may have to be
recorded as unconstructible in CI rather than skipped silently.

Two positive cases are also missing: that `create_in` removes the directory on
its own validation failure (`:355`) so a rejected attempt leaves nothing behind,
and that `Drop` removes it on the success path (`:392`).

## Investigation log

### Q: Is the validated runtime directory load-bearing on Linux, or only on macOS?

- Sources examined: `ring.rs:216-247` (`Mapping::create`), `:249-276`
  (`Mapping::attach`), `:299-377` (`RuntimeDir`), `:536-590`
  (`Ring::create`, `Ring::create_in`), `:1419-1428` (`DuplexRing::create`),
  `:1677-1703` (`validate_object`), `:1701-1709` (`validate_seals`),
  `:1711-1736` (`create_linux_memfd`), `:1748-1783` (`create_macos_shm`); a
  repository-wide search for `RuntimeDir`.
- Findings: it is load-bearing on **neither** platform. On Linux the object is an
  anonymous memfd with a fixed name and no path, so nothing can be placed in the
  directory. On macOS the object is a POSIX shared-memory segment named
  `/mc-shm-<hex>` in the shm namespace and `shm_unlink`ed at `:1774` before it is
  mapped, so the filesystem directory is equally irrelevant there. The directory
  is created, validated, held for the lifetime of the rings, and removed. It is
  a precondition gate on the process's ability to own a private 0700 directory,
  not a container for anything.
- Missing evidence: none for the platform question. What is unresolved is
  intent — whether the directory is a remnant of an earlier file-backed design,
  or a deliberate environment sanity check. The doc comment at `:543` says
  "Creates sealed, prefaulted active ring under fresh owner-only runtime
  directory", which reads as though the object is under the directory; it is not.
- Conclusion: resolved as a scoping fact. The record stands as an untested gate
  with no negative coverage, and its impact is low on every supported platform
  because the object it appears to guard is authenticated by descriptor instead.
