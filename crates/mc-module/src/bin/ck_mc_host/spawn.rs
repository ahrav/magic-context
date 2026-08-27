//! Detached daemon spawn for `ck-mc-host start`/`restart`.
//!
//! The only module in this binary allowed to use `unsafe`: `fork`, session
//! separation, stdio redirection, descriptor closure, and the fd-based
//! `fexecve` re-exec all live here so `mc-host` itself keeps
//! `#![deny(unsafe_code)]`.
//!
//! ponytail: KTD18's full flow fexecve's the STAGED GENERATION's launcher
//! binary. Dev/test payloads staged today are not executables (production
//! payloads are unqualified, U9 `production_qualified:false`), so this spawn
//! boundary re-execs the already-running launcher through a retained,
//! descriptor-validated `/proc/self/exe` fd — same fd-exec mechanism, no
//! pathname fallback. Switch the retained fd to
//! `ValidatedGeneration::open_verified_file("bin/ck-mc-host")` when U6/U9
//! qualify real payloads.
#![allow(unsafe_code)]

use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

/// Bounded static spawn failure; never carries tainted native error text.
#[derive(Debug)]
pub struct SpawnError(#[allow(dead_code)] pub &'static str);

/// Hard bound on the startup envelope a parent may hand to `serve`. Kept at
/// the classic pipe capacity so the post-fork write cannot block behind a
/// child that never execs.
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;

fn cvt(ret: libc::c_int, what: &'static str) -> Result<libc::c_int, SpawnError> {
    if ret < 0 {
        Err(SpawnError(what))
    } else {
        Ok(ret)
    }
}

/// Opens the owner-only daemon log, refusing hostile shapes: no symlink
/// following, regular file only, single hard link, owned by this UID,
/// owner-only mode.
fn open_log(log_path: &Path) -> Result<OwnedFd, SpawnError> {
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(log_path)
        .map_err(|_| SpawnError("daemon log open failed"))?;
    let meta = file
        .metadata()
        .map_err(|_| SpawnError("daemon log stat failed"))?;
    // SAFETY: geteuid never fails and has no memory effects.
    let euid = unsafe { libc::geteuid() };
    // `nlink == 1` is part of the predicate, matching the managed state files:
    // a second hard link at this name is another file that the daemon would
    // append all of its stdout and stderr to, and that the normalization below
    // would re-mode through the shared inode.
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != euid || meta.mode() & 0o077 != 0 {
        return Err(SpawnError("daemon log failed security checks"));
    }
    // The create mode is filtered by the process umask, which can strip owner
    // bits and leave a newly created log at 0000. That passes the check above,
    // because only group and other bits are tested, and the already-open
    // descriptor still writes — but the next start or restart cannot reopen the
    // log and fails before spawning. Normalize through the descriptor we just
    // validated as our own, never through the pathname.
    // SAFETY: `file` is a live owned descriptor validated above as a regular
    // file we own; fchmod has no memory effects.
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } < 0 {
        return Err(SpawnError("daemon log chmod failed"));
    }
    Ok(OwnedFd::from(file))
}

/// Relocates a descriptor to a number strictly above stderr.
///
/// The child's redirection sequence assigns fds 0, 1, and 2, and `dup2`
/// closes its target before duplicating. If the launcher was invoked with any
/// of 0/1/2 already closed, a descriptor opened here would occupy one of
/// those slots and be destroyed by the very sequence that reads it: with fd 0
/// closed, `log_fd` lands at 0, `dup2(pipe_r, 0)` closes it, and the
/// following `dup2(log_fd, 1)` then duplicates the pipe's read end into
/// stdout. Hoisting every child-side descriptor above 2 first makes each
/// source disjoint from every target.
fn relocate_above_stderr(fd: OwnedFd) -> Result<OwnedFd, SpawnError> {
    if fd.as_raw_fd() > 2 {
        return Ok(fd);
    }
    // SAFETY: `fd` is an owned live descriptor; F_DUPFD_CLOEXEC returns a new
    // owned descriptor at or above the requested minimum, or -1.
    let raw = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    let raw = cvt(raw, "descriptor relocation failed")?;
    // SAFETY: `raw` was just returned by F_DUPFD_CLOEXEC and is owned here;
    // the original `fd` is dropped at the end of this scope.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

/// Highest descriptor number the pre-5.9 close fallback must reach.
///
/// `close_range` closes an open-ended range in one call; the fallback loop
/// cannot, so its ceiling has to come from the process limit rather than a
/// guessed constant. A supervisor or shell that hands this launcher a
/// high-numbered non-CLOEXEC socket, pipe, lock, or sensitive file would
/// otherwise leak it into a long-lived daemon and keep that resource alive
/// indefinitely. Resolved before `fork` so the child does nothing but close.
fn close_fallback_ceiling() -> libc::c_int {
    // Descriptor numbers are bounded by RLIMIT_NOFILE's soft limit, so closing
    // up to it covers every descriptor that can exist. RLIM_INFINITY and absurd
    // limits are clamped: the loop must terminate in bounded time.
    const CLAMP: u64 = 1 << 20;
    const FLOOR: u64 = 8192;
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes into the caller-provided struct and has no other
    // memory effects.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } < 0 {
        return FLOOR as libc::c_int;
    }
    // `rlim_t` widths differ across the supported targets, so the comparison is
    // done in u64 regardless of the local alias.
    #[allow(clippy::unnecessary_cast)]
    let soft = limit.rlim_cur as u64;
    soft.clamp(FLOOR, CLAMP) as libc::c_int
}

/// Forks a fully detached `ck-mc-host serve` daemon and writes the bounded
/// startup envelope to its stdin pipe. The child: new session, owner-only
/// umask, cwd `/`, default signal dispositions with no signals blocked, stdin
/// from the envelope pipe, stdout/stderr appended to the owner-only log, every
/// other inherited descriptor closed, empty environment, and `fexecve` of the
/// retained verified executable fd — the pathname is never re-resolved after
/// validation.
///
/// Success here proves only that the spawn was issued; the caller must wait
/// on publication evidence, never on the child PID.
pub fn spawn_detached(log_path: &Path, envelope: &[u8]) -> Result<(), SpawnError> {
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(SpawnError("startup envelope exceeds size bound"));
    }
    let log_fd = relocate_above_stderr(open_log(log_path)?)?;
    // Retained executable identity: the fd is validated (regular, owned)
    // and execution uses only this open file description.
    let exe = std::fs::File::open("/proc/self/exe")
        .map_err(|_| SpawnError("executable self-descriptor open failed"))?;
    let exe_meta = exe
        .metadata()
        .map_err(|_| SpawnError("executable stat failed"))?;
    // SAFETY: geteuid never fails and has no memory effects.
    let euid = unsafe { libc::geteuid() };
    if !exe_meta.is_file() || exe_meta.uid() != euid {
        return Err(SpawnError("executable failed identity checks"));
    }
    let exe_fd = relocate_above_stderr(OwnedFd::from(exe))?;

    let mut pipe_fds = [0 as libc::c_int; 2];
    // SAFETY: pipe2 writes exactly two descriptors into the array.
    cvt(
        unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) },
        "envelope pipe creation failed",
    )?;
    // SAFETY: the descriptors were just returned by pipe2 and are owned here.
    let (pipe_r, pipe_w) = unsafe {
        (
            OwnedFd::from_raw_fd(pipe_fds[0]),
            OwnedFd::from_raw_fd(pipe_fds[1]),
        )
    };
    // The read end is a `dup2` source in the child, so it must not sit in a
    // slot the sequence assigns. A same-fd `dup2(0, 0)` would also leave the
    // pipe's `O_CLOEXEC` set, closing the daemon's stdin across the exec.
    let pipe_r = relocate_above_stderr(pipe_r)?;

    // Everything the child touches is prepared before fork: with tokio
    // worker threads alive, the child may only use async-signal-safe calls
    // (no allocation) until exec.
    let argv0 = CString::new("ck-mc-host").expect("static argv");
    let argv1 = CString::new("serve").expect("static argv");
    let argv: [*const libc::c_char; 3] = [argv0.as_ptr(), argv1.as_ptr(), std::ptr::null()];
    // Minimal environment: serve takes every input from the envelope.
    let envp: [*const libc::c_char; 1] = [std::ptr::null()];
    let root = CString::new("/").expect("static path");
    let close_ceiling = close_fallback_ceiling();
    // Empty signal mask for the child. `exec` resets caught signals to their
    // default disposition but preserves both ignored dispositions and the
    // blocked-signal mask, so a launcher invoked with SIGCHLD ignored would give
    // the daemon a disposition that auto-reaps Broca subprocesses before Tokio
    // can wait for them, and a launcher invoked with SIGTERM blocked would give
    // it a daemon that never observes its own termination signal.
    let mut empty_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: sigemptyset initializes the caller-provided set and has no other
    // memory effects.
    unsafe {
        libc::sigemptyset(&mut empty_mask);
    }
    // Highest signal number to reset, resolved before fork so the child makes
    // no library call that could consult allocator or lock state.
    let max_signal = libc::SIGRTMAX();

    // SAFETY: fork with a multithreaded parent; the child performs only
    // async-signal-safe operations (setsid/umask/chdir/signal/sigprocmask/
    // dup2/fcntl/close_range/close/fexecve/_exit) before exec, on descriptors
    // and buffers prepared above.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(SpawnError("fork failed"));
    }
    if pid == 0 {
        // Child: detach and re-exec. Any failure is _exit; the parent
        // observes it as a publication timeout.
        unsafe {
            libc::setsid();
            libc::umask(0o077);
            libc::chdir(root.as_ptr());
            // Restore every signal to its default disposition and unblock all
            // signals: the daemon must start from a known signal state rather
            // than inheriting whatever the launcher's invoker had installed.
            // SIGKILL and SIGSTOP cannot be reset; signal() reports EINVAL for
            // them, which is harmless here.
            for signum in 1..=max_signal {
                libc::signal(signum, libc::SIG_DFL);
            }
            libc::sigprocmask(libc::SIG_SETMASK, &empty_mask, std::ptr::null_mut());
            if libc::dup2(pipe_r.as_raw_fd(), 0) < 0
                || libc::dup2(log_fd.as_raw_fd(), 1) < 0
                || libc::dup2(log_fd.as_raw_fd(), 2) < 0
            {
                libc::_exit(125);
            }
            // Pin the executable at fd 3 with CLOEXEC clear (dup2 clears it;
            // a same-fd dup2 would not, so clear explicitly instead).
            if exe_fd.as_raw_fd() == 3 {
                if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    libc::_exit(125);
                }
            } else if libc::dup2(exe_fd.as_raw_fd(), 3) < 0 {
                libc::_exit(125);
            }
            // Close every other inherited descriptor. close_range needs
            // kernel >= 5.9; the plan floor is 4.18, so fall back to a
            // bounded close loop up to the process descriptor limit.
            if libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) < 0 {
                for fd in 4..=close_ceiling {
                    libc::close(fd);
                }
            }
            libc::fexecve(3, argv.as_ptr(), envp.as_ptr());
            libc::_exit(127);
        }
    }

    // Parent: hand over the envelope and drop every child-side descriptor.
    drop(pipe_r);
    drop(exe_fd);
    drop(log_fd);
    let mut writer = std::fs::File::from(pipe_w);
    writer
        .write_all(envelope)
        .and_then(|()| writer.flush())
        .map_err(|_| SpawnError("startup envelope delivery failed"))?;
    Ok(())
}

/// Ignores SIGPIPE in the launcher process so a child that dies before
/// consuming the envelope surfaces as a write error, not a fatal signal.
pub fn ignore_sigpipe() {
    // SAFETY: installing SIG_IGN for SIGPIPE is async-signal-safe and has no
    // preconditions.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}
