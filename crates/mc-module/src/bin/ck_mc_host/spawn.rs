//! Detached daemon spawn for `ck-mc-host start`/`restart`.
//!
//! The only module in this binary allowed to use `unsafe`: `fork`, session
//! separation, stdio redirection, descriptor closure, and the fd-based
//! `fexecve` re-exec all live here so `mc-host` itself keeps
//! `#![deny(unsafe_code)]`.
//!
//! Production re-execs the selected staged generation's retained verified
//! launcher descriptor. Dev fixtures that intentionally contain no launcher
//! fall back to the already-running test executable.
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
/// following, regular file only, owned by this UID, owner-only mode.
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
    if !meta.is_file() || meta.uid() != euid || meta.mode() & 0o077 != 0 {
        return Err(SpawnError("daemon log failed security checks"));
    }
    Ok(OwnedFd::from(file))
}

/// Forks a fully detached `ck-mc-host serve` daemon and writes the bounded
/// startup envelope to its stdin pipe. The child: new session, owner-only
/// umask, cwd `/`, stdin from the envelope pipe, stdout/stderr appended to
/// the owner-only log, every other inherited descriptor closed, empty
/// environment, and `fexecve` of the retained verified executable fd — the
/// pathname is never re-resolved after validation.
///
/// Success here proves only that the spawn was issued; the caller must wait
/// on publication evidence, never on the child PID.
pub fn spawn_detached(
    log_path: &Path,
    envelope: &[u8],
    generation_launcher: Option<OwnedFd>,
) -> Result<(), SpawnError> {
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(SpawnError("startup envelope exceeds size bound"));
    }
    let log_fd = open_log(log_path)?;
    let exe_fd = match generation_launcher {
        Some(fd) => fd,
        None => {
            let path = std::env::current_exe()
                .map_err(|_| SpawnError("test executable path unavailable"))?;
            let exe =
                std::fs::File::open(path).map_err(|_| SpawnError("test executable open failed"))?;
            let exe_meta = exe
                .metadata()
                .map_err(|_| SpawnError("test executable stat failed"))?;
            // SAFETY: geteuid never fails and has no memory effects.
            let euid = unsafe { libc::geteuid() };
            if !exe_meta.is_file() || exe_meta.uid() != euid {
                return Err(SpawnError("test executable failed identity checks"));
            }
            OwnedFd::from(exe)
        }
    };

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

    // Everything the child touches is prepared before fork: with tokio
    // worker threads alive, the child may only use async-signal-safe calls
    // (no allocation) until exec.
    let argv0 = CString::new("ck-mc-host").expect("static argv");
    let argv1 = CString::new("serve").expect("static argv");
    let argv: [*const libc::c_char; 3] = [argv0.as_ptr(), argv1.as_ptr(), std::ptr::null()];
    #[cfg(target_os = "macos")]
    let retained_path = CString::new("/dev/fd/3").expect("static retained path");
    // Minimal environment: serve takes every input from the envelope.
    let envp: [*const libc::c_char; 1] = [std::ptr::null()];
    let root = CString::new("/").expect("static path");

    // SAFETY: fork with a multithreaded parent; the child performs only
    // async-signal-safe operations (setsid/umask/chdir/signal/dup2/fcntl/
    // close_range/close/fexecve/_exit) before exec, on descriptors and
    // buffers prepared above.
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
            // The parent ignores SIGPIPE for its own envelope write; the
            // daemon must not inherit that through exec.
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
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
            // bounded loop above the CLI's descriptor ceiling.
            if libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) < 0 {
                for fd in 4..8192 {
                    libc::close(fd);
                }
            }
            #[cfg(target_os = "linux")]
            libc::fexecve(3, argv.as_ptr(), envp.as_ptr());
            #[cfg(target_os = "macos")]
            libc::execve(retained_path.as_ptr(), argv.as_ptr(), envp.as_ptr());
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
