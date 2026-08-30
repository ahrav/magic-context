# setup-a-a-hostile-occupant-of-the-socket-path-fails-closed

## Discovery trigger

Part 1's `runtime-directory-authentication-is-a-precondition-not-a-container`
found a five-clause filesystem conjunction whose failing branches were never
negative-tested. `bind_owner_only` has the same shape: a three-clause conjunction
with one tested branch. The task asked whether this path repeats that shape. It
does.

## Evidence trail

All references at commit `e447c927`.

`crates/mc-host/src/setup_socket.rs:27-50`:

```
28:    match std::fs::symlink_metadata(path) {
29:        Ok(metadata) => {
30:            let secure_stale_socket = metadata.file_type().is_socket()
31:                && metadata.uid() == rustix::process::geteuid().as_raw()
32:                && metadata.mode() & 0o777 == 0o600;
33:            if !secure_stale_socket {
34:                return Err(io::Error::new(
35:                    io::ErrorKind::PermissionDenied,
36:                    "refusing insecure setup socket occupant",
37:                ));
38:            }
39:            std::fs::remove_file(path)?;
40:        }
41:        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
42:        Err(error) => return Err(error),
43:    }
44:    let listener = tokio::net::UnixListener::bind(path)?;
```

Three properties of this code matter.

First, `symlink_metadata` and not `metadata`. A symlink at the path is classified
as a symlink, so `is_socket()` is false and the function refuses. It does not
follow the link and therefore does not unlink the link's target. This is the same
no-follow discipline the connection-file reader uses via `OFlags::NOFOLLOW`
(`connection_file.rs:289-307`, specifically `:303`) and that `instance.rs` uses via
`HARDENED_DIR_FLAGS` (`:741`).

Second, the three clauses are one conjunction evaluated at `:30-32`, and the
refusal at `:33-38` precedes the unlink at `:39`. So a refused occupant is left
in place. That is exactly what the one existing negative test asserts.

Third, `Err(error) if error.kind() == NotFound` at `:41` is the only tolerated
error. Any other stat failure propagates at `:42`, so an `EACCES` on the parent
does not silently fall through to `bind`.

The mode comparison is `& 0o777 == 0o600`, so setuid, setgid and sticky bits are
masked out of the comparison. A socket at mode `4600` would be accepted. For a
socket inode that is inert, but it is worth stating because the analogous file
check `is_secure_regular` (`instance.rs:799`) and the directory check
`validate_directory` (`connection_file.rs:267-287`) use different mask shapes,
`mode & 0o077 == 0` in the directory case.

## Failure scenario

Drop any one clause and a distinct hazard opens.

Drop `is_socket()`: the host unlinks and rebinds over any owner-only object at
the path, including a regular file holding data. `insecure_stale_occupant_is_not_replaced`
(`setup_socket.rs:493-501`) is the test that would catch this, and it is the only
one present.

Drop the uid clause: the host unlinks another user's socket. On a sticky-bit
directory that fails; in the host's own `0700` runtime directory no other user can
create anything, so this clause is defence in depth. It becomes load-bearing if
the socket ever moves to a shared directory.

Drop the mode clause: the host adopts the path but, critically, it then binds its
own socket and applies `0600` at `:45`, so the end state is still correct. The
hazard is the unlink of a wide socket that some other component was serving.

Change `symlink_metadata` to `metadata`: a symlink pointing at an owner-only
socket elsewhere passes all three clauses, and `remove_file` at `:39` unlinks the
*symlink*, not the target, so the immediate damage is contained. A symlink to an
attacker-chosen path in a directory the host can write turns into a
delete-what-we-name primitive only if the target also satisfies the three clauses.
Narrow, same-uid, and worth a negative test precisely because reasoning about it
is this fiddly.

## Timing windows and dependencies

Two windows, both same-uid only, because the containing directory is `0700`
(`instance.rs:560-573`).

Window one: `symlink_metadata` at `:28` to `remove_file` at `:39`. A same-uid
attacker who replaces the object between them causes the host to unlink whatever
is there at `:39`. The three clauses were evaluated against the old inode.

Window two: `remove_file` at `:39` to `bind` at `:44`. A same-uid attacker who
binds its own socket at the name causes `bind` to fail with `EADDRINUSE`. The
error propagates through `runtime.rs:836` as `HostError::Io`, the publication at
`:842` never runs, and no connection file is written. So the outcome is a failed
start, which is fail-closed, but it is a reliable same-uid denial primitive
against host startup.

Neither window is adversary-extendable: no peer input and no blocking call sits
inside either.

Depends on the `0700` runtime directory for the cross-uid part of the argument,
and on `instance.rs:403-410`'s `Drop` for the stale-socket case actually arising:
a graceful shutdown removes the socket at `Drop`, and `runtime.rs:935` removes it
after the accept loop, so a stale socket implies a previous abnormal exit.

## What a test must construct

Six occupant shapes at the socket path, each asserted twice, once on the error and
once on the occupant's survival:

1. dangling symlink to a nonexistent path;
2. symlink to a live owner-only socket elsewhere, asserting the *target* still
   exists afterwards;
3. socket at mode `0666`;
4. socket at mode `0600` owned by another uid;
5. a directory;
6. a FIFO at mode `0600`.

For each: assert `io::ErrorKind::PermissionDenied` and assert the planted object
is still present. Shapes 1, 2, 3, 5 and 6 are constructible unprivileged in a
temporary directory. Shape 4 needs a second uid and should be recorded as
unconstructible rather than skipped silently if CI cannot provide one.

The positive control must also be present: a socket at exactly mode `0600` owned by
the effective uid is removed and replaced, and `bind_owner_only` succeeds. Without
it a mutation that made the function refuse everything would pass all six negative
cases.

Shape 6 has precedent: `connection_file.rs:395`
`a_fifo_is_rejected_rather_than_blocking_the_open` builds a FIFO with the POSIX
`mkfifo` utility because rustix gates `mkfifoat` away from Apple targets and the
crate is `deny(unsafe_code)`. The same technique applies here.

Window two is testable with a bind race, but the honest disposition is to record
it as a known same-uid denial rather than to build a flaky race test.

## Investigation log

### Q: Does the mode mask admit anything surprising?

- Sources examined: `setup_socket.rs:32`, `instance.rs:799-810`,
  `connection_file.rs:267-287`.
- Findings: `& 0o777` masks setuid, setgid and sticky. So `4600`, `2600` and
  `1600` all compare equal to `0600` and are accepted. The sibling checks use
  different shapes: `is_secure_regular` checks its own clause set, and
  `validate_directory` uses `mode & 0o077 == 0`, which permits any owner bits.
- Missing evidence: none.
- Conclusion: resolved. Inert for a socket inode, and recorded here so the
  divergence between the three mask shapes is visible rather than assumed
  uniform.

### Q: How often does a stale socket actually occur?

- Sources examined: `instance.rs:403-410`, `runtime.rs:935`.
- Findings: two removal sites. `runtime.rs:935` removes it after `accept_loop`
  returns, on the graceful path. `InstanceGuard::drop` (`instance.rs:404-406`)
  removes it as the abnormal-exit backstop, taking the path out of
  `self.setup_socket` first. So a stale socket at startup implies the previous
  incarnation died without running either, for example `SIGKILL`.
- Missing evidence: none.
- Conclusion: resolved. The stale-socket branch is a real recovery path, not dead
  code, which is why its clauses are worth negative-testing.

### Q: Is the shape genuinely the same as Part 1's runtime-directory record?

- Sources examined: `part-1-shm-transport/catalog.md`, the
  `runtime-directory-authentication-is-a-precondition-not-a-container` record.
- Findings: yes in form, different in stakes. That record's conjunction is five
  clauses over a directory, checked at two sites, with zero tests. Its impact was
  argued *low* because no object lives inside the directory on either platform, so
  defeating the check gains nothing. Here an object does live at the path, the
  socket the whole boundary runs over, so the impact argument does not transfer.
- Missing evidence: none.
- Conclusion: resolved. Cited rather than restated, and the stakes difference
  recorded.
