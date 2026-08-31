# the-panic-hook-cannot-itself-fail

## Discovery trigger

The redaction hook's entire output is one `eprintln!`, and `eprintln!` panics when the write fails. A
panic raised inside a panic hook is a nested panic, which aborts. So the hook that exists to make a
callback panic *safe to report* converts that panic into a process abort whenever stderr cannot be
written — and the daemon's stderr is a file on disk, which makes "cannot be written" an ordinary
operational condition rather than a hypothetical.

## Evidence trail

The hook body, `crates/mc-host/src/panic_boundary.rs:41-47`:

```
std::panic::set_hook(Box::new(move |info| {
    if callback_is_polling() {
        eprintln!("{REDACTED_DIAGNOSTIC}");
    } else {
        previous(info);
    }
}));
```

`:43` is the only output on the redacted branch. There is no `write!` to a captured handle, no
`Result` inspection, no fallback.

**`eprintln!` panics on write error.** In Rust 1.94.1, `library/std/src/io/stdio.rs:1155-1167`:

```
1164:    if let Err(e) = global_s().write_fmt(args) {
1165:        panic!("failed printing to {label}: {e}");
1166:    }
```

`eprintln!` expands to `_eprint`, which calls `print_to` with the `"stderr"` label. An `ENOSPC`,
`EDQUOT`, `EIO`, or `EPIPE` from that write becomes a panic.

**A panic inside the hook aborts.** `library/std/src/panicking.rs:793-813`:

```
793:    let must_abort = panic_count::increase(true);
795:    // Check if we need to abort immediately.
796:    if let Some(must_abort) = must_abort {
797:        match must_abort {
798:            panic_count::MustAbort::PanicInHook => {
...
803:                rtprintpanic!(
804:                    "panicked at {location}:\n{message}\nthread panicked while processing panic. aborting.\n"
805:                );
806:            }
...
813:        crate::process::abort();
```

`MustAbort::PanicInHook` is exactly this case, and `:813` is `process::abort()` — not an unwind, not a
`HostError`, no destructors.

**The daemon's stderr is a log file.** `crates/mc-module/src/bin/ck-mc-host.rs:424-428` resolves
`daemon_log_path()` to `coordination_dir_path(None)?.join("daemon.log")`, and
`crates/mc-module/src/bin/ck_mc_host/spawn.rs` opens it (`:40-53`) and redirects both standard
streams into it in the child:

```
249:                || libc::dup2(log_fd.as_raw_fd(), 1) < 0
250:                || libc::dup2(log_fd.as_raw_fd(), 2) < 0
```

The comment at `spawn.rs:61` describes the descriptor as the one the child will "append all of its
stdout and stderr to". So fd 2 in the running daemon is a regular file, opened for append, in the
coordination directory.

`panic = "unwind"` is the operative mode: the workspace `Cargo.toml` declares no `panic` key and no
`[profile]` override, so a callback panic normally unwinds and is caught. The abort is the deviation.

## Failure scenario

A handler callback panics while the filesystem holding the coordination directory is full. The hook
runs, `callback_is_polling()` returns true, `eprintln!` attempts the append, the write returns
`ENOSPC`, `stdio.rs:1165` panics, `panic_count::increase` reports `PanicInHook`, and
`panicking.rs:813` aborts the process.

The consequence is not a lost log line. It is that the abort bypasses every teardown ordering the
lifecycle establishes: the stopping demotion never runs, so the publication record and the running
record survive on disk, and a launcher inspecting them sees a live daemon that no longer exists. The
teardown that would have demoted the incarnation is skipped precisely because the diagnostic path
failed.

The coincidence is not far-fetched: a full disk is the condition the coordination directory's own
storage-exhaustion handling exists to name, and the log file lives in that same directory, so disk
exhaustion and log-write failure share a cause.

A second trigger has a different shape. If fd 2 is a pipe whose reader has stopped draining — an
operator running the daemon under a supervisor or a `tee` that stalls — the write blocks instead of
failing. There is no abort; the panicking thread parks inside the hook, holding whatever the
unwinding path would otherwise have released. That is a stall, not a crash, and it is invisible in the
log by construction.

## Timing windows and dependencies

The window is the duration of one `write` syscall on fd 2, entered from inside a panic hook. It is
unbounded above for the pipe case and short for the `ENOSPC` case, but the `ENOSPC` case does not need
a window at all — it fails deterministically once the filesystem is full.

Dependencies: a callback panic must occur under the guard (see
`every-callback-invocation-is-inside-the-redaction-guard`, which owns the inventory of the 27 call
sites that can produce one), and fd 2 must be unwritable or non-draining. The two are independent, so
this is a coincidence rather than a race. Nothing in the hook mediates between them — there is no
`try_lock`, no timeout, and no non-blocking mode on the inherited descriptor.

Note that the guard's own `try_with(...).unwrap_or(false)` at `:32-33` is the one place the hook is
already defensive: a destroyed thread-local degrades to the prior hook rather than panicking. The
output line has no equivalent.

## What a test must construct

Two experiments, both requiring a subprocess because the observable is process exit status.

For the write-failure case: run a child that installs the hook, redirects its own fd 2 to a
descriptor whose writes fail, then panics inside a `redact_sync` body. Assert the child's exit status
is a signal-death consistent with `abort` (`SIGABRT`) rather than a clean exit. A small tmpfs filled
to capacity gives a real `ENOSPC` on a regular file, which matches production shape; a full pipe with
`O_NONBLOCK` gives `EAGAIN`, which is a different errno but the same `Err` branch at `stdio.rs:1164`.

For the blocking case: redirect fd 2 to a pipe, never read it, write enough to fill the pipe buffer,
then trigger a callback panic. Assert the child does not exit within a deadline. This is a liveness
assertion and needs a timeout, not an equality.

The `tests/dispatch.rs` subprocess pattern at `:605-630` is the right harness shape — it already
re-executes the test binary with an env marker (`:606-610`) and inspects `output.status` (`:611-616`)
— but it asserts `status.success()`, which is the opposite of what these two need.

No test covers either case. There is no test in the tree that makes a write to fd 2 fail.

## Investigation log

### Q: Does `eprintln!` actually panic on a write error in the toolchain in use, or is that folklore?

- Sources examined: `library/std/src/io/stdio.rs:1155-1167` from the local 1.94.1 toolchain source
  (`rustc --version` reports 1.94.1); `grep -n "failed printing to"` on that file.
- Findings: `print_to` at `:1155` writes via `global_s().write_fmt(args)` and, on `Err`, executes
  `panic!("failed printing to {label}: {e}")` at `:1165`. The one escape is
  `print_to_buffer_if_capture_used` at `:1159`, which returns early when the test harness's output
  capture is active — that path uses `let _ = ... write_fmt(args)` (`:1176`) and discards the error.
- Missing evidence: none.
- Conclusion: resolved with answer. It panics in a normal process. Notably, under `cargo test` output
  capture it does *not*, so a naive in-process test would prove nothing and a subprocess is mandatory.

### Q: Is a panic inside a panic hook an abort, or does it unwind and get caught?

- Sources examined: `library/std/src/panicking.rs:790-816`; `grep -n "while processing panic\|
  panic_count"` on that file.
- Findings: `panic_count::increase(true)` at `:793` returns `Some(MustAbort::PanicInHook)` for a panic
  raised while the hook is running; the match arm at `:798-806` prints "thread panicked while
  processing panic. aborting." and control falls to `crate::process::abort()` at `:813`. The message is
  formatted from `payload.as_str()` only (`:802`), deliberately avoiding user formatting code.
- Missing evidence: none.
- Conclusion: resolved with answer. Abort, unconditionally, before the hook dispatch at `:816`.

### Q: Where does the daemon's stderr actually go — is the disk-full trigger real or assumed?

- Sources examined: `crates/mc-module/src/bin/ck-mc-host.rs:424-428`, `:733-737`;
  `crates/mc-module/src/bin/ck_mc_host/spawn.rs:37-53`, `:136-151`, `:249-250`.
- Findings: real. `daemon_log_path()` returns `<coordination dir>/daemon.log` (`:428`), `open_log`
  opens it with owner-only permissions and symlink refusal (`:40-53`), and the child `dup2`s that
  descriptor over both fd 1 and fd 2 (`:249-250`). The daemon's stderr is therefore a regular file on
  the same filesystem as the coordination directory.
- Missing evidence: whether an `ENOSPC` on that filesystem has been observed in practice alongside a
  callback panic. That is an operational history question, not a source question, and it is why this
  record's confidence is medium rather than high.
- Conclusion: resolved with answer for the mechanism; the coincidence remains plausible rather than
  demonstrated.
