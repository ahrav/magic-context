# setup-a-the-setup-socket-is-never-connectable-outside-the-owning-uid

## Discovery trigger

`bind_owner_only` is named for the guarantee it provides, and its unit test
asserts mode `0600`. Reading the body shows the mode is applied by a second
syscall after the socket already exists in the filesystem.

## Evidence trail

All references at commit `e447c927`.

`crates/mc-host/src/setup_socket.rs:27-50`, the whole function. The relevant
sequence:

```
44:    let listener = tokio::net::UnixListener::bind(path)?;
45:    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
46:        let _ = std::fs::remove_file(path);
47:        return Err(error);
48:    }
```

`bind(2)` on an `AF_UNIX` path creates the socket inode with `0777 & ~umask`. With
a conventional umask of `022` that is `0755`; with `0000` it is `0777`. The
tightening at `:45` is a separate syscall, so between `:44` and `:45` the socket is
present with the umask-derived mode.

The rollback at `:46-47` is correct: a failed chmod unlinks the socket rather than
leaving a wide one in place.

The mitigation is not in this file. The containing directory is the host runtime
directory, resolved as `${dataDir}/cortexkit/run`:

- `crates/mc-host/src/instance.rs:167`: `MANAGED_DIR_NAME` is `"cortexkit"`.
- `:171-173`: `managed_dir_path` joins it to the data directory.
- `:177-179`: `runtime_dir_path` joins `"run"`.
- `crates/mc-host/src/runtime.rs:834`:
  `let setup_socket = cleanup.guard_mut().dir_path().join("setup.sock");`
- `crates/mc-host/src/runtime.rs:836`: `bind_owner_only(&setup_socket)`.

And `secure_runtime_dir` ends with an unconditional tightening,
`instance.rs:560-573`:

```
let owner_ok = stat.st_uid == rustix::process::geteuid().as_raw();
if !is_dir || !owner_ok { return Err(InstanceError::Insecure { ... }); }
rustix::fs::fchmod(&current, Mode::from_raw_mode(0o700))
```

So the leaf directory is owned by the effective uid and mode `0700` before the
socket is bound inside it. A different uid cannot traverse into the directory, so
it cannot reach the socket regardless of the socket's own mode during the window.

Intermediate components are only checked replacement-proof, not tightened; the
comment at `instance.rs:490-494` says so explicitly, because the host must not
chmod directories it does not own such as `/tmp` or `$HOME`. That is why the
guarantee has to be stated as "not connectable outside the owning uid" rather than
"mode is always 0600": the mode genuinely is not always `0600`, and the property
still holds.

`connect(2)` on a Unix socket requires write permission on the socket inode and
execute permission on every path component, so both layers are load-bearing.

## Failure scenario

Move the socket out of the `0700` directory, or add a code path that binds before
the directory is tightened, and the umask-derived window becomes a real cross-uid
exposure. During it any local user can `connect` and begin a handshake. They
cannot authenticate without the key, so the immediate consequence is a handshake
permit consumed from a class bounded at 32 by default (`config.rs:128`), which is
a denial primitive rather than a compromise. But it also means an unauthenticated
stranger can reach `authenticate_server` and drive its parser, which is the one
part of the boundary written to face untrusted bytes only from same-uid peers.

The insidious variant is a future change to the socket path. `runtime.rs:834`
constructs it by `join` on the guard's directory, so a refactor that puts the
socket in a shared location such as `/tmp` or `/run` would silently drop the only
real protection while `setup_socket_is_owner_only` continued to pass.

## Timing windows and dependencies

The window is exactly one statement wide, `setup_socket.rs:44` to `:45`. It is not
adversary-extendable: no peer input is involved and nothing blocks between the two
lines.

Depends on `secure_runtime_dir` having run before `bind_owner_only`. It has:
`instance.rs:248` inside `acquire`, which is far upstream of `runtime.rs:836`. It
also depends on `dir_path()` naming the directory that was tightened, which it
does, since `InstanceGuard` holds the same `dir_path` it validated
(`instance.rs:303-305` region).

Depends on the umask, which is process state the host does not set. A permissive
umask widens the window's mode but does not widen its duration.

## What a test must construct

Two parts, because the two layers fail independently.

Mode-window part, constructible unprivileged:

1. set the process umask to `0o000`;
2. spawn a thread that spins on `symlink_metadata(path).permissions().mode()` for
   the socket path;
3. call `bind_owner_only`;
4. assert every sample the observer captured is either absent or `0600`, **or**
   record explicitly that the sample raced and the assertion instead relies on the
   parent directory. A racy sampler is honest evidence here; a sampler that never
   catches the window and is reported as proof is not.

Parent-directory part, the one that actually carries the guarantee:

1. after `bind_owner_only` returns, walk from the data directory to the socket and
   assert the leaf directory is mode `0700` and owned by the effective uid;
2. assert the socket's own mode is `0600`.

Cross-uid part: attempt `connect` as a second uid and assert `EACCES`. This needs
a second uid or a container. If CI cannot provide one, record it as unconstructible
rather than skipping silently, which is the disposition Part 1 took for the
owner-change case in
`runtime-directory-authentication-is-a-precondition-not-a-container`.

## Investigation log

### Q: Is the umask window exploitable as the code stands?

- Sources examined: `setup_socket.rs:27-50`, `runtime.rs:834-836`,
  `instance.rs:167-179`, `:477-576`.
- Findings: no, because the containing directory is `fchmod`ed to `0700`
  unconditionally at `instance.rs:560-573` before the bind, and `connect` needs
  execute permission on every component. The exposure is real in the socket's own
  mode and unreachable in practice.
- Missing evidence: whether any deployment overrides the data directory to a
  location whose *intermediate* components are group- or world-writable.
  `instance.rs:490-494` says intermediates are checked replacement-proof but not
  tightened, and `is_safe_ancestor` (`:786-796`) was not read in full in this
  pass.
- Conclusion: resolved for the default layout, with the intermediate-component
  question left open and pointed at `is_safe_ancestor`.

### Q: Does the existing unit test cover the window?

- Sources examined: `setup_socket.rs:480-491`.
- Findings: `setup_socket_is_owner_only` calls `bind_owner_only` and then stats the
  path. It observes only the end state. It also runs in a `tempfile::tempdir()`,
  which is not `0700`, so it does not and cannot exercise the parent-directory
  layer.
- Missing evidence: none.
- Conclusion: resolved. Recorded as `Exercised: partial`, and
  `instance.rs:979` `permissive_umask_still_yields_owner_only_dir_and_file` noted
  as covering the directory and the connection file but not the socket.

### Q: Would binding through a temporary name and renaming be better?

- Sources examined: `setup_socket.rs:44-48`, `instance.rs:582-600` region
  (`write_atomic_owner_only`, which does exactly that for regular files).
- Findings: the crate already has the pattern for files: unique owner-only
  `O_EXCL` temp, exact-mode `fchmod`, then rename over the canonical name. For a
  listening socket the equivalent is bind-then-`renameat`, which works on Linux
  but changes the published path's inode identity mid-startup.
- Missing evidence: no design note on why the socket does not use the same
  pattern.
- Conclusion: needs human input. Recorded as the record's open question.

### Q: line-reference corrections made during this pass

- Sources examined: `crates/mc-host/src/instance.rs`, re-read line by line after
  a first draft cited the tightening block from a `sed` range rather than from
  exact line numbers.
- Findings: three citations were off and are corrected here and in the lens file.
  The validate-and-tighten block is `instance.rs:560-573`, not `:565-576`; the
  `fchmod` itself is `:571`. The intermediate-component comment starts at `:490`,
  so it is `:490-494`, not `:493-498`. `is_safe_ancestor` spans `:786-796`, not
  `:786-797`.
- Missing evidence: none.
- Conclusion: resolved. All three corrected. No claim changed as a result; only
  the pointers moved.
