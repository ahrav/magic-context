//! `ck-mc-host start` and `restart` use this module to spawn detached daemons.
//!
//! `fork`, session separation, stdio redirection, descriptor closure, and fd-based `fexecve` re-exec live here so `mc-host` can deny unsafe code.
//! `#![deny(unsafe_code)]`.
//!
//! Production re-execs the selected staged generation's retained verified launcher descriptor; launcher-less dev fixtures re-exec the running test executable.
#![allow(unsafe_code)]

use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

/// `SpawnError` carries only static messages and never includes native error text.
#[derive(Debug)]
pub struct SpawnError(#[allow(dead_code)] pub &'static str);

/// `MAX_ENVELOPE_BYTES` matches pipe capacity so the post-fork write cannot block when the child never execs.
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;

fn cvt(ret: libc::c_int, what: &'static str) -> Result<libc::c_int, SpawnError> {
    if ret < 0 {
        Err(SpawnError(what))
    } else {
        Ok(ret)
    }
}

/// owner-only mode.
fn open_log(log_path: &Path) -> Result<OwnedFd, SpawnError> {
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        // `O_NONBLOCK` keeps a planted FIFO at this name from hanging the open
        // `O_NONBLOCK` does not bypass the regular-file check.
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(log_path)
        .map_err(|_| SpawnError("daemon log open failed"))?;
    let meta = file
        .metadata()
        .map_err(|_| SpawnError("daemon log stat failed"))?;
    // SAFETY: geteuid never fails and has no memory effects.
    let euid = unsafe { libc::geteuid() };
    // `nlink == 1` rejects hard links: another name could receive the daemon's stdout and stderr and share the inode re-moded below.
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != euid || meta.mode() & 0o077 != 0 {
        return Err(SpawnError("daemon log failed security checks"));
    }
    // `umask` can create the log as `0000`; it passes the group/other-mode check and writes through the open descriptor, but future opens fail. `fchmod` normalizes the validated descriptor without reopening `log_path`.
    // SAFETY: `file` is a live descriptor for the validated regular file we own, and `fchmod` has no memory effects.
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } < 0 {
        return Err(SpawnError("daemon log chmod failed"));
    }
    Ok(OwnedFd::from(file))
}

///
/// `relocate_above_stderr` moves every child-side source above fd 2 because `dup2` overwrites sources at fds 0–2.
fn relocate_above_stderr(fd: OwnedFd) -> Result<OwnedFd, SpawnError> {
    if fd.as_raw_fd() > 2 {
        return Ok(fd);
    }
    // SAFETY: `fd` is a live owned descriptor; `F_DUPFD_CLOEXEC` returns an owned descriptor at or above 3, or -1.
    let raw = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    let raw = cvt(raw, "descriptor relocation failed")?;
    // SAFETY: `raw` was returned by `F_DUPFD_CLOEXEC` and is owned here; `fd` is dropped at scope exit.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

/// The pre-5.9 close fallback closes descriptors through this number.
///
/// When `rlim_cur` is at most `CLAMP`, the fallback closes through `rlim_cur`.
/// Resolve the ceiling before `fork` to avoid querying resource limits in the child.
fn close_fallback_ceiling() -> libc::c_int {
    // `RLIM_INFINITY` and soft limits above `CLAMP` are clamped to `CLAMP`.
    const CLAMP: u64 = 1 << 20;
    const FLOOR: u64 = 8192;
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit` writes only to the caller-provided struct.
    // memory effects.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } < 0 {
        return FLOOR as libc::c_int;
    }
    // `rlim_t` widths differ across supported targets; compare `rlim_cur` as `u64`.
    #[allow(clippy::unnecessary_cast)]
    let soft = limit.rlim_cur as u64;
    soft.clamp(FLOOR, CLAMP) as libc::c_int
}

/// Spawns a detached `ck-mc-host serve` daemon and writes the bounded startup envelope to its stdin pipe.
/// validation.
///
/// A successful return proves only spawn issuance; callers must wait for publication evidence, not the child PID.
pub fn spawn_detached(
    log_path: &Path,
    envelope: &[u8],
    generation_launcher: Option<OwnedFd>,
) -> Result<(), SpawnError> {
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(SpawnError("startup envelope exceeds size bound"));
    }
    let log_fd = relocate_above_stderr(open_log(log_path)?)?;
    let exe_fd = match generation_launcher {
        Some(fd) => relocate_above_stderr(fd)?,
        None if test_self_exec_allowed() => {
            #[cfg(target_os = "linux")]
            let path = Path::new("/proc/self/exe").to_path_buf();
            #[cfg(target_os = "macos")]
            let path = std::env::current_exe()
                .map_err(|_| SpawnError("test executable path unavailable"))?;
            let exe =
                std::fs::File::open(path).map_err(|_| SpawnError("test executable open failed"))?;
            let exe_meta = exe
                .metadata()
                .map_err(|_| SpawnError("executable stat failed"))?;
            // SAFETY: geteuid never fails and has no memory effects.
            let euid = unsafe { libc::geteuid() };
            // Reject other-writable executables because any user can modify the retained inode before `fexecve`.
            if !exe_meta.is_file() || exe_meta.uid() != euid || exe_meta.mode() & 0o002 != 0 {
                return Err(SpawnError("executable failed identity checks"));
            }
            relocate_above_stderr(OwnedFd::from(exe))?
        }
        None => return Err(SpawnError("verified generation launcher is required")),
    };

    let mut pipe_fds = [0 as libc::c_int; 2];
    #[cfg(target_os = "linux")]
    // SAFETY: pipe2 writes exactly two descriptors into the array.
    cvt(
        unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) },
        "envelope pipe creation failed",
    )?;
    #[cfg(target_os = "macos")]
    // SAFETY: pipe writes exactly two descriptors into the array.
    cvt(
        unsafe { libc::pipe(pipe_fds.as_mut_ptr()) },
        "envelope pipe creation failed",
    )?;
    // SAFETY: the descriptors were just returned by pipe2/pipe and are owned here.
    let (pipe_r, pipe_w) = unsafe {
        (
            OwnedFd::from_raw_fd(pipe_fds[0]),
            OwnedFd::from_raw_fd(pipe_fds[1]),
        )
    };
    // On macOS, both `OwnedFd` values close if setting `FD_CLOEXEC` fails.
    // `pipe` cannot atomically set `FD_CLOEXEC`, so another thread can inherit the pipe ends by execing before the flag is set.
    #[cfg(target_os = "macos")]
    for fd in [pipe_r.as_raw_fd(), pipe_w.as_raw_fd()] {
        // SAFETY: fd is owned by pipe_r/pipe_w and open for this call.
        cvt(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            "envelope pipe cloexec failed",
        )?;
    }
    // `pipe_r` must not occupy a `dup2` destination slot because `dup2(0, 0)` preserves `FD_CLOEXEC`.
    let pipe_r = relocate_above_stderr(pipe_r)?;

    // `fork` must follow initialization of all non-async-signal-safe child state; with Tokio workers alive, the child may call only async-signal-safe, nonallocating functions until `exec`.
    let argv0 = CString::new("ck-mc-host").expect("static argv");
    let argv1 = CString::new("serve").expect("static argv");
    let argv: [*const libc::c_char; 3] = [argv0.as_ptr(), argv1.as_ptr(), std::ptr::null()];
    #[cfg(target_os = "macos")]
    let retained_path = CString::new("/dev/fd/3").expect("static retained path");
    let envp: [*const libc::c_char; 1] = [std::ptr::null()];
    let root = CString::new("/").expect("static path");
    let close_ceiling = close_fallback_ceiling();
    // `exec` preserves blocked signals, so the child must clear its signal mask before `exec`.
    // An ignored `SIGCHLD` disposition auto-reaps child processes before Tokio can wait for them.
    // A blocked `SIGTERM` leaves the daemon unable to observe its termination signal.
    let mut empty_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: `sigemptyset` initializes the caller-provided set.
    // memory effects.
    unsafe {
        libc::sigemptyset(&mut empty_mask);
    }
    // `max_signal` must be resolved before `fork` so the child makes no library call that could consult allocator or lock state.
    #[cfg(target_os = "linux")]
    let max_signal = libc::SIGRTMAX();
    // Darwin has no realtime signals or `libc::NSIG`; resetting signals above the highest named signal only returns `EINVAL`.
    #[cfg(not(target_os = "linux"))]
    let max_signal = libc::SIGUSR2;

    // SAFETY: After `fork`, the child uses only async-signal-safe operations on preallocated descriptors and buffers before `exec`.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(SpawnError("fork failed"));
    }
    if pid == 0 {
        // `_exit` avoids invoking non-async-signal-safe process-exit handling after `fork`.
        unsafe {
            libc::setsid();
            libc::umask(0o077);
            libc::chdir(root.as_ptr());
            // The child resets resettable signal dispositions and unblocks all signals so the daemon does not inherit the launcher's signal state.
            // `SIGKILL` and `SIGSTOP` cannot be reset; `signal` returns `EINVAL` for both.
            // The loop ignores EINVAL for SIGKILL and SIGSTOP.
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
            // `fd 3` must hold the executable with `FD_CLOEXEC` clear: `dup2` clears the flag unless both descriptors are fd 3.
            if exe_fd.as_raw_fd() == 3 {
                if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    libc::_exit(125);
                }
            } else if libc::dup2(exe_fd.as_raw_fd(), 3) < 0 {
                libc::_exit(125);
            }
            #[cfg(target_os = "linux")]
            let closed_range = libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) >= 0;
            #[cfg(not(target_os = "linux"))]
            let closed_range = false;
            if !closed_range {
                for fd in 4..=close_ceiling {
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

    // Closing the parent's copies prevents them from keeping the child's pipe ends open.
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

pub(super) fn test_self_exec_allowed() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("CK_MC_HOST_TEST_ALLOW_SELF_EXEC").is_some_and(|value| value == "1")
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// The launcher ignores `SIGPIPE` so a child that dies before consuming the envelope causes a write error instead of a fatal signal.
pub fn ignore_sigpipe() {
    // preconditions.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}
