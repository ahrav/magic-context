//! The one shared hardened subprocess runner both harness adapters use
//! (KTD6, R17, R19).
//!
//! Everything security-relevant about running a harness child lives here so
//! OpenCode and Pi cannot drift apart: no shell, a dedicated Unix process
//! group as the cancellation unit, a daemon-startup environment snapshot
//! with host launch-identity variables removed, prompt delivery over stdin,
//! private `0700`/`0600` temp files, bounded concurrent stdout/stderr
//! draining, timeout, graceful group termination with SIGKILL escalation,
//! leader reaping before completion, and redacted structural diagnostics
//! only.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::backend::{
    BackendError, BackendEvent, BackendTerminal, ErrorClass, EventSink, SinkStatus,
};

/// Host launch-identity variables stripped from every child environment
/// (R17): a harness child inheriting these could reconnect to the daemon as
/// the supervised module itself.
pub const HOST_LAUNCH_IDENTITY_VARS: [&str; 2] = [
    subc_protocol::SUBC_MODULE_ID_ENV,
    subc_protocol::SUBC_LAUNCH_NONCE_ENV,
];

/// Immutable copy of the daemon-startup environment (R17): provider
/// credentials and user configuration are trusted inputs, while the host's
/// launch-identity variables are removed at capture so no later composition
/// step can forget to strip them.
///
/// The variable list is behind an `Arc`, so the per-run clones taken by
/// backend `execute` paths and the Pi provider fallback share one
/// allocation: concurrent runs retain one environment-sized buffer total,
/// not one per handle.
#[derive(Clone)]
pub struct EnvSnapshot {
    vars: Arc<[(OsString, OsString)]>,
}

impl EnvSnapshot {
    /// Captures the current process environment once — call at daemon
    /// startup, not per run, so request handling can never observe
    /// request-derived environment mutations.
    pub fn capture() -> Self {
        Self::from_vars(std::env::vars_os())
    }

    /// Builds a snapshot from explicit variables (test seam). The identity
    /// strip applies here too, so a snapshot can never carry
    /// `SUBC_MODULE_ID`/`SUBC_LAUNCH_NONCE` regardless of construction path.
    pub fn from_vars(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        let vars = vars
            .into_iter()
            .filter(|(name, _)| {
                !HOST_LAUNCH_IDENTITY_VARS
                    .iter()
                    .any(|identity| OsStr::new(identity) == name.as_os_str())
            })
            .collect::<Vec<_>>()
            .into();
        Self { vars }
    }

    pub fn vars(&self) -> &[(OsString, OsString)] {
        &self.vars
    }
}

impl std::fmt::Debug for EnvSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Environment values are credentials (R19): report the count only.
        f.debug_struct("EnvSnapshot")
            .field("var_count", &self.vars.len())
            .finish()
    }
}

/// Shared execution bounds for one harness run. Defaults match the module
/// transport ceiling; tests shrink them to keep hang and flood fixtures
/// fast.
#[derive(Clone, Debug)]
pub struct SubprocessLimits {
    /// Whole-run wall-clock bound; an elapsed run is terminated and mapped
    /// to one failed terminal (R18).
    pub run_timeout: Duration,
    /// Grace between the group SIGTERM and the SIGKILL escalation (R10).
    pub termination_grace: Duration,
    /// Grace between clean stream EOF and forced termination, for CLIs that
    /// finish their output but linger instead of exiting (the Pi print-mode
    /// shutdown gap mirrored from `subagent-runner.ts`).
    pub drain_grace: Duration,
    /// Bounded stdout retention (R17/AE10); a flooding child is stopped.
    pub max_stdout_bytes: usize,
    /// Bounded stderr retention (R17); stderr is diagnostics-only.
    pub max_stderr_bytes: usize,
}

impl Default for SubprocessLimits {
    fn default() -> Self {
        Self {
            run_timeout: Duration::from_secs(660),
            termination_grace: Duration::from_secs(5),
            drain_grace: Duration::from_secs(2),
            max_stdout_bytes: 4 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }
}

/// One fully specified child invocation. The prompt travels only through
/// `stdin` (R17) — argv carries flags and trusted paths, never caller text.
pub struct SubprocessSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
    /// The complete child environment (the child is spawned with
    /// `env_clear`): snapshot variables first, adapter-owned control
    /// variables last so they win on collision.
    pub env: Vec<(OsString, OsString)>,
    pub working_dir: PathBuf,
    pub stdin: Vec<u8>,
}

/// How a child run ended, structurally. Diagnostics built from this carry no
/// child output (R19).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubprocessEnd {
    /// Natural exit with a code.
    Exited(i32),
    /// The transcript is complete but the leader lingered — either its
    /// streams closed cleanly and it outlived the drain grace, or the
    /// terminal probe recognized a decisive transcript while the child kept
    /// its pipes open — and it was terminated; parsers treat this like a
    /// clean exit because the transcript is complete.
    DrainKilled,
    /// Killed by a signal we did not send.
    Signaled,
    TimedOut,
    Cancelled,
    StdoutOverflow,
    StderrOverflow,
}

/// Bounded captured output plus the structural end state.
pub struct SubprocessResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub end: SubprocessEnd,
    /// Whether the whole prompt reached the child's stdin before it closed.
    /// A transcript produced without the full prompt answers a truncated
    /// question, so parsers refuse it even when the end state looks clean.
    pub prompt_delivered: bool,
}

/// Spawns and supervises one harness child (KTD6). Returns after the leader
/// is reaped on every path, including timeout, cancellation, and overflow,
/// so lifecycle completion upstream can never observe a live child (R10).
///
/// `terminal_probe`, when supplied, inspects each region of newly completed
/// stdout lines exactly once and reports whether it contains a decisive
/// terminal event — the total probing cost stays linear in the transcript.
/// The first hit rearms the run deadline to the drain grace, so a harness
/// that finishes its output without closing its pipes (the Pi print-mode
/// shutdown gap) ends as a drain kill with the completed transcript instead
/// of burning the whole run timeout and failing.
pub async fn run(
    spec: SubprocessSpec,
    limits: &SubprocessLimits,
    cancel: &CancellationToken,
    terminal_probe: Option<fn(&[u8]) -> bool>,
) -> io::Result<SubprocessResult> {
    let SubprocessSpec {
        executable,
        args,
        env,
        working_dir,
        stdin: prompt,
    } = spec;
    let mut command = tokio::process::Command::new(&executable);
    command
        .args(&args)
        // No inherited environment: the child sees exactly the snapshot
        // plus adapter control variables (R17).
        .env_clear()
        .current_dir(&working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A fresh process group makes the whole harness descendant tree the
        // cancellation unit (KTD6); provider or extension grandchildren die
        // with the leader.
        .process_group(0)
        // Backstop only: every ordinary path below reaps explicitly.
        .kill_on_drop(true);
    // Crash-safe fate binding: the leader asks the kernel to SIGKILL it if
    // the spawning host thread dies, covering host crashes and SIGKILLs
    // that never run the drop backstop — otherwise an orphaned harness
    // keeps executing a billable run that the replacement host reports as
    // `missing`, and recovery could refire it. `pdeathsig` covers only the
    // leader; the startup sweep in [`group_registry`] handles descendants
    // that survive it, and the group sweep covers every ordinary path.
    //
    // The parent check closes the window where the host dies between fork
    // and prctl. It compares against the host's own pid captured pre-fork —
    // not against init — so a host legitimately running as PID 1 (container
    // entrypoint) still spawns; only an actual re-parent aborts.
    let host_pid = std::process::id();
    // SAFETY: the hook runs post-fork/pre-exec, where only async-signal-safe
    // operations are permitted. All three calls are raw syscalls (prctl,
    // getppid) with no allocation, locking, or libc state access.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(move || {
            rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))?;
            let parent = rustix::process::getppid().map(|pid| pid.as_raw_nonzero().get() as u32);
            if parent == Some(host_pid) {
                Ok(())
            } else {
                Err(io::Error::other("host exited before spawn completed"))
            }
        });
    }
    for (name, value) in &env {
        command.env(name, value);
    }

    let mut child = command.spawn()?;
    // The `Command` and the adapter's env vector each hold a full copy of
    // the child environment, which can approach the platform exec limit;
    // both are freed as soon as the child exists so concurrent runs retain
    // no environment-sized allocations for their lifetime (the spawned
    // child keeps its own kernel-side copy, and `kill_on_drop` transferred
    // to the `Child` at spawn).
    drop(command);
    drop(env);
    drop(args);
    drop(executable);
    drop(working_dir);
    // With process_group(0) the leader's pid IS the group id.
    let group = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(rustix::process::Pid::from_raw);
    // Crash-ownership registration is a barrier before prompt delivery,
    // and it fails closed: both harnesses start their billable provider
    // request only after reading the prompt from stdin, so no billable
    // work can exist without a durable registry record for the replacement
    // host to sweep. If the record cannot be written, the group is killed
    // before any prompt bytes flow — pre-prompt descendants are the only
    // residue of a crash in this window, and they hold no billable
    // request. `Drop` removes the record on every exit of this function
    // once the group has been reaped in-process. (No fsync: the record
    // only needs to survive a host-process crash — power loss kills the
    // children with it.)
    let group_record =
        group.and_then(|g| group_registry::GroupRecord::record(g.as_raw_nonzero().get()));
    if group_record.is_none() {
        kill_group(group, rustix::process::Signal::KILL);
        // Covers the (theoretical) missing-group-id case kill_group skips.
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(io::Error::other(
            "crash-ownership registration failed before prompt delivery",
        ));
    }
    let _group_record = group_record;

    // Prompt delivery is concurrent with output draining: a child that
    // fills its stdout pipe before reading stdin must not deadlock us.
    // stdin is closed (dropped) after delivery so print-mode reads see EOF.
    let mut stdin_pipe = child.stdin.take();
    let mut stdin_task = tokio::spawn(async move {
        let Some(mut stdin) = stdin_pipe.take() else {
            return true;
        };
        let written = stdin.write_all(&prompt).await.is_ok();
        stdin.shutdown().await.is_ok() && written
    });

    let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut stdout_chunk = [0u8; 8192];
    let mut stderr_chunk = [0u8; 8192];
    let deadline = tokio::time::sleep(limits.run_timeout);
    tokio::pin!(deadline);
    let mut terminal_seen = false;
    // Everything before this offset has already been probed; each complete
    // line is inspected exactly once no matter how the reads chunk it.
    let mut probed_to = 0usize;

    // One loop drains both streams concurrently under their byte caps while
    // watching the timeout and the cancellation token (R17).
    let abnormal = loop {
        if !stdout_open && !stderr_open {
            break None;
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => break Some(SubprocessEnd::Cancelled),
            // After the probe fires the (rearmed) deadline is the drain
            // grace: the transcript is complete, so a still-open pipe is the
            // shutdown gap, not a timeout.
            () = &mut deadline => break Some(if terminal_seen {
                SubprocessEnd::DrainKilled
            } else {
                SubprocessEnd::TimedOut
            }),
            read = stdout_pipe.read(&mut stdout_chunk), if stdout_open => match read {
                Ok(0) | Err(_) => stdout_open = false,
                Ok(n) => {
                    if stdout.len() + n > limits.max_stdout_bytes {
                        break Some(SubprocessEnd::StdoutOverflow);
                    }
                    stdout.extend_from_slice(&stdout_chunk[..n]);
                    if !terminal_seen {
                        if let Some(probe) = terminal_probe {
                            // Only the newly appended bytes are searched for
                            // a line end: everything between `probed_to` and
                            // this chunk was already searched on its own
                            // arrival and held no newline, so a single long
                            // line cannot make the search quadratic.
                            let appended_at = stdout.len() - n;
                            if let Some(last_newline) = stdout[appended_at..]
                                .iter()
                                .rposition(|byte| *byte == b'\n')
                            {
                                let end = appended_at + last_newline + 1;
                                if probe(&stdout[probed_to..end]) {
                                    terminal_seen = true;
                                    let drain_deadline =
                                        tokio::time::Instant::now() + limits.drain_grace;
                                    if drain_deadline < deadline.deadline() {
                                        deadline.as_mut().reset(drain_deadline);
                                    }
                                }
                                probed_to = end;
                            }
                        }
                    }
                }
            },
            read = stderr_pipe.read(&mut stderr_chunk), if stderr_open => match read {
                Ok(0) | Err(_) => stderr_open = false,
                Ok(n) => {
                    if stderr.len() + n > limits.max_stderr_bytes {
                        break Some(SubprocessEnd::StderrOverflow);
                    }
                    stderr.extend_from_slice(&stderr_chunk[..n]);
                }
            },
        }
    };

    let end = match abnormal {
        Some(end) => {
            terminate_group(group, &mut child, limits.termination_grace).await;
            end
        }
        None => {
            // Clean EOF on both streams: give the leader a bounded grace to
            // exit on its own before forcing it (the transcript is already
            // complete either way). The exit is observed WITHOUT reaping so
            // the zombie leader keeps the pgid pinned while the descendant
            // sweep runs — a reaped leader with no surviving descendants
            // frees the pgid for reuse, and a post-reap sweep could SIGKILL
            // an unrelated recycled process group.
            if wait_exited_unreaped(group, limits.drain_grace).await {
                kill_group(group, rustix::process::Signal::KILL);
                child
                    .wait()
                    .await
                    .map_or(SubprocessEnd::DrainKilled, |status| {
                        status
                            .code()
                            .map_or(SubprocessEnd::Signaled, SubprocessEnd::Exited)
                    })
            } else {
                terminate_group(group, &mut child, limits.termination_grace).await;
                SubprocessEnd::DrainKilled
            }
        }
    };
    // The whole process group is dead on every path above, so the writer
    // settles promptly: it either finished long ago or its pipe just broke.
    // An incomplete write means the child produced its output without the
    // full prompt; the result records that so parsers can refuse the
    // transcript. The timeout is a backstop against an inherited stdin fd
    // surviving the sweep and counts as non-delivery.
    let prompt_delivered = match tokio::time::timeout(Duration::from_secs(1), &mut stdin_task).await
    {
        Ok(joined) => joined.unwrap_or(false),
        Err(_) => {
            stdin_task.abort();
            false
        }
    };
    Ok(SubprocessResult {
        stdout,
        stderr,
        end,
        prompt_delivered,
    })
}

fn kill_group(group: Option<rustix::process::Pid>, signal: rustix::process::Signal) {
    if let Some(group) = group {
        // ESRCH (already gone) is the success case here.
        let _ = rustix::process::kill_process_group(group, signal);
    }
}

/// Waits up to `budget` for the leader to exit WITHOUT reaping it, via
/// `waitid(..., WNOWAIT)`: the unreaped zombie keeps the process group id
/// pinned, which is what makes the callers' descendant sweep race-free
/// against pid/pgid recycling. Returns false when the leader is still
/// running at the deadline (or when no pid is available to poll).
async fn wait_exited_unreaped(group: Option<rustix::process::Pid>, budget: Duration) -> bool {
    let Some(pid) = group else {
        // No pid means no pgid to sweep either, so the caller's fallback
        // (direct kill-and-reap) is already race-free.
        return false;
    };
    // ponytail: 10ms poll instead of SIGCHLD plumbing — tokio owns the
    // child's SIGCHLD handling, and a bounded poll is a few syscalls per
    // run; switch to pidfd if runs-per-second ever makes this measurable.
    const POLL: Duration = Duration::from_millis(10);
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let options = rustix::process::WaitIdOptions::EXITED
            | rustix::process::WaitIdOptions::NOWAIT
            | rustix::process::WaitIdOptions::NOHANG;
        match rustix::process::waitid(rustix::process::WaitId::Pid(pid), options) {
            Ok(Some(_)) => return true,
            // Only "not our waitable child anymore" proves the leader is
            // gone. Any other errno (EINTR under concurrent SIGCHLD, for
            // instance) proves nothing: reporting exited there would skip
            // the documented SIGTERM-then-grace path for a child that is
            // still shutting down cleanly, so keep polling until the
            // deadline decides.
            Err(rustix::io::Errno::CHILD | rustix::io::Errno::SRCH) => return true,
            Err(_) | Ok(None) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Graceful group termination: SIGTERM the whole group, escalate to SIGKILL
/// after the bounded grace, sweep the group, and reap the leader before
/// returning (R10). The final group SIGKILL is sent while the leader is
/// still an unreaped zombie — the zombie pins the pgid, so the sweep can
/// never target a recycled process group.
async fn terminate_group(
    group: Option<rustix::process::Pid>,
    child: &mut tokio::process::Child,
    grace: Duration,
) {
    kill_group(group, rustix::process::Signal::TERM);
    if group.is_none() {
        let _ = child.start_kill();
    }
    if !wait_exited_unreaped(group, grace).await {
        kill_group(group, rustix::process::Signal::KILL);
        let _ = child.start_kill();
        // SIGKILL cannot be caught, so the leader dies promptly; the bound
        // only guards against pathological kernel states wedging the run.
        let _ = wait_exited_unreaped(group, grace).await;
    }
    kill_group(group, rustix::process::Signal::KILL);
    let _ = child.wait().await;
}

/// A sensitive-file cleanup failure, reduced to a bounded structural fact
/// (R19): the error kind only, never a path or file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupFailure {
    pub kind: io::ErrorKind,
}

/// The one spelling of a cleanup failure inside a terminal's message. Both
/// the producer of that text ([`CleanupFailure`]'s `Display`) and its only
/// consumer (the Pi provider-fallback gate, which must not retry over a run
/// that left private prompt material on disk) name this constant, so a
/// rewording cannot silently change retry behavior.
pub(crate) const CLEANUP_FAILURE_MARKER: &str = "cleanup failed";

impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sensitive temp {CLEANUP_FAILURE_MARKER} ({})", self.kind)
    }
}

/// A fresh private temp directory forced to `0700` regardless of the
/// inherited umask, holding this run's sensitive files (R17). Cleanup is
/// explicit and fallible so a failure stays observable (R19); `Drop` only
/// backstops early-return paths best-effort.
pub struct PrivateDir {
    path: Option<PathBuf>,
}

impl PrivateDir {
    pub fn create(prefix: &str) -> io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        // Rooted in the crash-swept run root, and named with the creating
        // host's identity, so a directory holding a run's hidden prompt and
        // transcript can be proven stale and removed after a crash instead
        // of persisting until someone clears /tmp (R17/R19).
        let base = group_registry::private_run_root()?;
        let owner_pid = std::process::id();
        let owner_start = group_registry::owner_start_time()?;
        // Requesting 0700 at mkdir(2) closes the window where a permissive
        // umask would briefly leave the fresh directory group/world-visible
        // before the chmod below lands (R17).
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        for _ in 0..16 {
            let mut nonce = [0u8; 8];
            getrandom::getrandom(&mut nonce)
                .map_err(|_| io::Error::other("temp-dir nonce generation failed"))?;
            let candidate = base.join(format!(
                "{prefix}-{owner_pid}-{owner_start}-{:016x}",
                u64::from_le_bytes(nonce)
            ));
            // `create` fails on any existing entry, including a planted
            // symlink, so success proves the path is fresh and ours.
            match builder.create(&candidate) {
                Ok(()) => {
                    // mkdir(2) modes are still umask-filtered; force exactly
                    // 0700 regardless of the inherited umask (R17).
                    fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700))?;
                    let meta = fs::symlink_metadata(&candidate)?;
                    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
                        return Err(io::Error::other("private temp path is not a fresh dir"));
                    }
                    return Ok(Self {
                        path: Some(candidate),
                    });
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
                Err(err) => return Err(err),
            }
        }
        Err(io::Error::other("could not allocate a fresh private dir"))
    }

    pub fn path(&self) -> &Path {
        self.path.as_deref().expect("live until cleanup")
    }

    /// Creates `name` inside the directory as a fresh regular file forced
    /// to `0600` regardless of the inherited umask (R17).
    pub fn write_private(&self, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
        use std::io::Write;
        let path = self.path().join(name);
        // `create_new` refuses existing entries and symlinks: fresh and ours.
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(bytes)?;
        // Deliberately no fsync: this file exists only for the child that
        // reads it moments later and is unlinked when the run ends, so
        // durability across power loss is worthless here — while fsync is
        // the one operation on this path that can genuinely stall an async
        // worker under I/O pressure. A later open(2) in another process
        // sees these bytes without it. The remaining operations are
        // bounded metadata syscalls (create, chmod, statx, and at most two
        // unlinks plus an rmdir at cleanup).
        drop(file);
        // The open(2) mode is umask-filtered; force exactly 0600 (R17).
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let meta = fs::symlink_metadata(&path)?;
        if !meta.file_type().is_file() || meta.file_type().is_symlink() {
            return Err(io::Error::other("private temp file is not a fresh file"));
        }
        Ok(path)
    }

    /// Removes the directory and everything in it. The result must reach
    /// the run terminal (R19): callers merge it via [`merge_cleanup`].
    pub fn cleanup(mut self) -> Result<(), CleanupFailure> {
        let path = self.path.take().expect("cleanup runs once");
        fs::remove_dir_all(&path).map_err(|err| CleanupFailure { kind: err.kind() })
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// Folds a cleanup result into the run terminal (R19): cleanup failure is
/// observable on the failure path and prevents an unqualified success on
/// the success path — a completed run whose sensitive files may still exist
/// is reported as one classified failure naming both facts.
pub fn merge_cleanup(
    terminal: BackendTerminal,
    cleanup: Result<(), CleanupFailure>,
) -> BackendTerminal {
    let Err(failure) = cleanup else {
        return terminal;
    };
    match terminal {
        BackendTerminal::Completed { finish_reason } => BackendTerminal::Failed(BackendError {
            class: ErrorClass::Transient,
            message: format!(
                "run completed ({}) but {failure}; success withheld",
                finish_reason.as_wire_str()
            ),
            retry_after_secs: None,
            provider_code: None,
        }),
        BackendTerminal::Failed(mut error) => {
            error.message = format!("{}; additionally {failure}", error.message);
            BackendTerminal::Failed(error)
        }
    }
}

/// Maps a spawn failure to the run terminal (missing executables are run
/// failures, not host failures — plan assumption). The message is
/// structural only. Process-table and memory pressure clear on their own,
/// so those kinds stay retryable; configuration failures (missing
/// executable, permissions) are permanent.
pub(crate) fn spawn_failure(harness: HarnessName, err: &io::Error) -> BackendTerminal {
    let class = match err.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::OutOfMemory => ErrorClass::Transient,
        _ => ErrorClass::Permanent,
    };
    BackendTerminal::Failed(BackendError {
        class,
        message: format!(
            "{} backend executable could not be spawned ({})",
            harness.name(),
            err.kind()
        ),
        retry_after_secs: None,
        provider_code: None,
    })
}

/// Tiny name carrier so shared diagnostics never format request content.
#[derive(Debug, Clone, Copy)]
pub(crate) enum HarnessName {
    OpenCode,
    Pi,
}

impl HarnessName {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }
}

/// Maps an abnormal structural end to one canonical failed terminal (R18).
/// Returns `None` for ends the parser should interpret from the transcript.
/// Classification may consult bounded stderr for the error class, but the
/// message never quotes child output (R19).
pub(crate) fn abnormal_end_terminal(
    harness: HarnessName,
    end: SubprocessEnd,
    stderr: &[u8],
    limits: &SubprocessLimits,
) -> Option<BackendTerminal> {
    let name = harness.name();
    let error = match end {
        SubprocessEnd::Exited(0) | SubprocessEnd::DrainKilled => return None,
        SubprocessEnd::Exited(code) => {
            let stderr_text = String::from_utf8_lossy(stderr);
            BackendError {
                class: classify_failure_text(&stderr_text),
                message: format!("{name} backend exited with status {code}"),
                retry_after_secs: retry_after_secs_in_text(&stderr_text),
                provider_code: None,
            }
        }
        SubprocessEnd::Signaled => BackendError {
            class: ErrorClass::Permanent,
            message: format!("{name} backend was terminated by a signal"),
            retry_after_secs: None,
            provider_code: None,
        },
        SubprocessEnd::TimedOut => BackendError {
            class: ErrorClass::Transient,
            message: format!(
                "{name} backend timed out after {}s",
                limits.run_timeout.as_secs()
            ),
            retry_after_secs: None,
            provider_code: None,
        },
        SubprocessEnd::Cancelled => BackendError {
            // The supervisor's first-terminal-wins arbitration replaces this
            // with its own cancellation terminal; the class is a formality.
            class: ErrorClass::Transient,
            message: format!("{name} backend run was cancelled"),
            retry_after_secs: None,
            provider_code: None,
        },
        SubprocessEnd::StdoutOverflow | SubprocessEnd::StderrOverflow => BackendError {
            class: ErrorClass::Permanent,
            message: format!("{name} backend exceeded its bounded output limit"),
            retry_after_secs: None,
            provider_code: None,
        },
    };
    Some(BackendTerminal::Failed(error))
}

/// A bounded parse failure: structural position only, never line content
/// (R19). Every malformed-output shape funnels here so R18's "one canonical
/// failed terminal" holds.
pub(crate) fn parse_failure(harness: HarnessName, detail: &str) -> BackendTerminal {
    BackendTerminal::Failed(BackendError {
        class: ErrorClass::Permanent,
        message: format!("{} backend output rejected: {detail}", harness.name()),
        retry_after_secs: None,
        provider_code: None,
    })
}

/// Closed keyword classification for provider failure text (R18). Ordering
/// matters: authentication and context-overflow phrasing often also
/// mentions retries, so those classes are checked first.
pub(crate) fn classify_failure_text(text: &str) -> ErrorClass {
    let lower = text.to_ascii_lowercase();
    const AUTH: [&str; 5] = [
        "api key",
        "unauthorized",
        "authentication",
        "credential",
        "forbidden",
    ];
    const AUTH_CODES: [&str; 2] = ["401", "403"];
    // Broca-path provider text never leaves this process (the wire message
    // is host-authored, R19), so this list — not the module scheduler's
    // regex set, which only sees text on its own non-Broca paths — is the
    // sole classifier for these failures. It therefore mirrors every
    // phrasing that set recognizes, as plain substrings: the `\d+` patterns
    // reduce to their literal prefixes, which is what actually discriminates.
    const OVERFLOW: [&str; 20] = [
        "context length",
        "context window",
        "prompt is too long",
        "prompt too long",
        "maximum context",
        "context_length",
        "context length exceeded",
        "input is too long",
        "input token count",
        "maximum prompt length is",
        "reduce the length of the messages",
        "maximum model length is",
        "exceeds the limit of",
        "exceeds the available context size",
        "greater than the context length",
        "exceeded model token limit",
        "request entity too large",
        "too large for model with",
        "model_context_window_exceeded",
        "context size has been exceeded",
    ];
    const TRANSIENT: [&str; 8] = [
        "rate limit",
        "rate_limit",
        "overloaded",
        "timeout",
        "timed out",
        "temporarily",
        "try again",
        "unavailable",
    ];
    const TRANSIENT_CODES: [&str; 3] = ["429", "503", "529"];
    if AUTH.iter().any(|needle| lower.contains(needle))
        || AUTH_CODES
            .iter()
            .any(|code| contains_status_code(&lower, code))
    {
        return ErrorClass::AuthRequired;
    }
    if OVERFLOW.iter().any(|needle| lower.contains(needle)) {
        return ErrorClass::ContextOverflow;
    }
    if TRANSIENT.iter().any(|needle| lower.contains(needle))
        || TRANSIENT_CODES
            .iter()
            .any(|code| contains_status_code(&lower, code))
    {
        return ErrorClass::Transient;
    }
    ErrorClass::Permanent
}

/// Whether `haystack` contains `code` as a standalone token rather than as
/// digits inside a longer identifier. A plain substring match reads `401`
/// out of an unrelated request id like `req-40123` or `req-x401abc`, and
/// misreading a provider failure as `AuthRequired` is expensive: the
/// historian path treats it as fatal for every remaining model from that
/// provider, and the Pi adapter spends a canonical-provider retry on it.
/// Boundaries are non-alphanumeric on both sides, so `status 401`, `(401)`,
/// and `401:` match while `x401abc` does not.
fn contains_status_code(haystack: &str, code: &str) -> bool {
    haystack.match_indices(code).any(|(index, _)| {
        let before = haystack[..index].chars().next_back();
        let after = haystack[index + code.len()..].chars().next();
        before.is_none_or(|c| !c.is_ascii_alphanumeric())
            && after.is_none_or(|c| !c.is_ascii_alphanumeric())
    })
}

/// Ceiling on any retry delay extracted from provider output. The text is
/// untrusted: without a cap, hostile "retry after 99999999999" phrasing
/// would persist a durable historian backoff decades into the future.
pub(crate) const MAX_RETRY_AFTER_SECS: u64 = 3600;

/// Extracts a retry delay in seconds from provider failure text (R18 retry
/// metadata), clamped to [`MAX_RETRY_AFTER_SECS`] because the source text
/// is untrusted. Only an explicit delay form counts — `retry after <n>`,
/// `retry in <n>`, `retrying after <n>`, `Retry-After: <n>`, or an echoed
/// `retryAfter` field, with an optional unit — so an unrelated number later
/// in the message (a request id, a status reference) is never persisted as
/// a durable backoff.
///
/// Single pass, O(1) extra memory beyond the lowercased copy: a provider
/// error can be MiBs, and materializing per-token metadata would multiply
/// this scan's declared one-transcript budget by the token count.
pub(crate) fn retry_after_secs_in_text(text: &str) -> Option<u64> {
    let lower = text.to_ascii_lowercase();
    let mut saw_verb = false;
    let mut saw_delay_keyword = false;
    let mut pending: Option<u64> = None;
    let tokens = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty());
    for token in tokens {
        // A bare number already rode an explicit delay form; this token is
        // either its unit or unrelated prose (which means seconds).
        if let Some(value) = pending {
            return Some(apply_delay_unit(value, token));
        }
        if saw_delay_keyword {
            saw_delay_keyword = false;
            if let Some((value, unit)) = split_delay_number(token) {
                if unit.is_empty() {
                    pending = Some(value);
                    continue;
                }
                return Some(apply_delay_unit(value, unit));
            }
            // Not a number: fall through and re-evaluate this token below.
        }
        if saw_verb {
            saw_verb = false;
            if matches!(token, "after" | "in") {
                saw_delay_keyword = true;
                continue;
            }
        }
        match token {
            // Closed verb vocabulary: prefix matching would also catch
            // "retrieval after 300 items".
            "retry" | "retries" | "retried" | "retrying" => saw_verb = true,
            // A lowered `retryAfter` field echo carries the delay keyword
            // glued to the verb.
            "retryafter" => saw_delay_keyword = true,
            _ => {}
        }
    }
    pending.map(|value| value.min(MAX_RETRY_AFTER_SECS))
}

/// Splits one token into its leading digit run and the remaining glued
/// unit. An over-long digit run overflows `u64::from_str`; treat it as the
/// cap rather than dropping the (real) retry signal entirely.
fn split_delay_number(token: &str) -> Option<(u64, &str)> {
    let digits_end = token
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(token.len());
    if digits_end == 0 {
        return None;
    }
    let value = token[..digits_end].parse().unwrap_or(MAX_RETRY_AFTER_SECS);
    Some((value, &token[digits_end..]))
}

/// Converts a delay to clamped seconds given its (possibly empty) unit.
fn apply_delay_unit(value: u64, unit: &str) -> u64 {
    let secs = match unit {
        // A bare number after an explicit delay keyword means seconds.
        "" | "s" | "sec" | "secs" | "second" | "seconds" => value,
        "ms" | "millisecond" | "milliseconds" => value.div_ceil(1000).max(1),
        "m" | "min" | "mins" | "minute" | "minutes" => value.saturating_mul(60),
        "h" | "hr" | "hrs" | "hour" | "hours" => value.saturating_mul(3600),
        // The following token is prose, not a unit; the number still rode
        // an explicit delay form, so it counts as seconds.
        _ => value,
    };
    secs.min(MAX_RETRY_AFTER_SECS)
}

/// Ceiling on JSON structural cardinality in one harness output line.
///
/// An untyped `serde_json::Value` parse allocates a node per array element
/// and object entry, so a line of tiny values (`[0,0,0,...]`) amplifies far
/// beyond its byte length — the capture budget models a parsed line as
/// transcript-sized, not as a node graph. Bounding the node count keeps the
/// worst-case DOM on the order of a megabyte, inside the existing
/// per-backend capture headroom, without capping line LENGTH (a legitimate
/// assistant message is one long line).
///
/// Generous for the closed print-mode vocabulary: a real event carries
/// message and content-block structure in the tens to low thousands.
pub(crate) const MAX_LINE_JSON_NODES: usize = 32_768;

/// Whether `text` stays within [`MAX_LINE_JSON_NODES`]. Counts only
/// structural punctuation OUTSIDE string literals: prose commas in an
/// assistant message are content, not nodes, and must never trip the bound.
/// Single pass, no allocation.
pub(crate) fn json_nodes_within_bound(text: &str) -> bool {
    let mut nodes = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in text.as_bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            // Each opener or separator admits at most one more node.
            b'{' | b'[' | b',' => {
                nodes += 1;
                if nodes > MAX_LINE_JSON_NODES {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

/// Admits a provider-supplied error code onto the wire only in short
/// identifier shape: provider output can echo prompt or credential content
/// (R19), so anything beyond `[A-Za-z0-9_.-]{1,64}` is dropped rather than
/// forwarded.
pub(crate) fn sanitized_provider_code(code: &str) -> Option<String> {
    (!code.is_empty()
        && code.len() <= 64
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
    .then(|| code.to_owned())
}

/// First terminal wins; any second terminal is contradictory and fails the
/// whole run (R18) — an error after a claimed success must never be
/// reported as completed, and vice versa. Shared by both harness parsers so
/// the contradictory-terminal spelling cannot drift.
pub(crate) fn commit_terminal(
    slot: &mut Option<BackendTerminal>,
    terminal: BackendTerminal,
    line_no: usize,
) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("contradictory terminal at line {line_no}"));
    }
    *slot = Some(terminal);
    Ok(())
}

/// The shared post-run gate (KTD6): a transcript is trusted only after a
/// clean end; the parsed events are emitted until the sink closes; every
/// abnormal end yields the exact "transcript unavailable" detail so
/// `finalize` maps it to one canonical failure.
pub(crate) fn parse_clean_transcript(
    result: &SubprocessResult,
    events: &EventSink,
    parse: impl FnOnce(&[u8]) -> Result<(Vec<BackendEvent>, BackendTerminal), String>,
) -> Result<BackendTerminal, String> {
    if !matches!(
        result.end,
        SubprocessEnd::Exited(0) | SubprocessEnd::DrainKilled
    ) {
        return Err("transcript unavailable".to_owned());
    }
    // A syntactically valid transcript from a child that never received the
    // whole prompt answers a truncated question; refusing it here turns a
    // silent wrong answer into one bounded failure.
    if !result.prompt_delivered {
        return Err("prompt delivery failed before the child closed stdin".to_owned());
    }
    let (parsed_events, terminal) = parse(&result.stdout)?;
    for event in parsed_events {
        if events.emit(event) == SinkStatus::Closed {
            break;
        }
    }
    Ok(terminal)
}

/// The shared adapter tail (KTD6): abnormal ends win, then the parsed
/// transcript terminal, then bounded parse failure — and cleanup is merged
/// last so it is observable on every path (R19).
pub(crate) fn finalize(
    harness: HarnessName,
    result: &SubprocessResult,
    parsed: Result<BackendTerminal, String>,
    limits: &SubprocessLimits,
    cleanup: Result<(), CleanupFailure>,
) -> BackendTerminal {
    let terminal = match abnormal_end_terminal(harness, result.end, &result.stderr, limits) {
        Some(terminal) => terminal,
        None => match parsed {
            Ok(terminal) => terminal,
            Err(detail) => parse_failure(harness, &detail),
        },
    };
    merge_cleanup(terminal, cleanup)
}

/// Crash-orphan registry: one file per live harness process group, so a
/// replacement host can kill groups a crashed predecessor left behind.
///
/// `pdeathsig` fate-binds only the group leader — provider or extension
/// descendants survive it and can keep executing a billable request that
/// the replacement host reports as `missing` (and recovery would refire).
/// The sweep closes that gap at the only crash-safe point available to an
/// unprivileged host: the next startup, before any status can be answered.
///
/// Kill authority is deliberately narrow. An entry's group is killed only
/// when the recording host is provably dead AND the group is provably the
/// recorded one: either the leader still runs with the recorded pid, start
/// time, and boot id — or the leader is gone but processes remain in its
/// group, which the kernel's pgid reservation proves are descendants of
/// the recorded run (a pid in use as a pgid is not reallocated, so a
/// reissued leader pid conversely proves the whole group is gone). The
/// remaining TOCTOU — the group emptying between the membership check and
/// the kill — is the same window every `kill(-pgid)` caller accepts.
pub mod group_registry {
    use std::os::unix::fs::MetadataExt;

    use super::*;

    /// Reads a process's start time (clock ticks since boot, field 22 of
    /// `/proc/<pid>/stat`). `Ok(None)` means the pid provably does not
    /// exist; `Err` means the answer is UNKNOWN (a transient read failure or
    /// an unreadable stat format) and callers must not guess, because both
    /// "owner is dead" and "leader is gone" are kill/unlink decisions.
    fn proc_start_time(pid: i32) -> io::Result<Option<u64>> {
        proc_stat_fields(pid).map(|fields| fields.map(|(_, start)| start))
    }

    /// Like [`proc_start_time`], but treats a zombie as dead: a crashed
    /// host can linger unreaped (same pid, same start time) while its
    /// supervisor already runs the replacement, and a zombie cannot be
    /// holding runs.
    fn proc_live_start_time(pid: i32) -> io::Result<Option<u64>> {
        Ok(proc_stat_fields(pid)?.and_then(|(state, start)| (state != 'Z').then_some(start)))
    }

    /// The process state character and start time from `/proc/<pid>/stat`.
    /// The comm field may contain spaces and parentheses, so everything
    /// after the LAST ')' is unambiguous: state is the first field there and
    /// starttime the 20th.
    fn proc_stat_fields(pid: i32) -> io::Result<Option<(char, u64)>> {
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            // The only proof that a pid is gone.
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let unreadable = || io::Error::other("unreadable /proc stat format");
        let rest = stat.rsplit_once(')').ok_or_else(unreadable)?.1;
        let mut fields = rest.split_ascii_whitespace();
        let state = fields
            .next()
            .and_then(|field| field.chars().next())
            .ok_or_else(unreadable)?;
        let start = fields
            .nth(18)
            .ok_or_else(unreadable)?
            .parse()
            .map_err(|_| unreadable())?;
        Ok(Some((state, start)))
    }

    /// Whether any live process still belongs to process group `pgid`.
    /// Used only after the group's recorded leader is gone: the kernel
    /// keeps a pgid reserved while the group has members, so survivors
    /// found here can only be members of the recorded group. A scan that
    /// cannot be completed is an error, never "no members" — that answer
    /// would both skip the kill and delete the record proving the orphan
    /// exists.
    fn group_has_members(pgid: i32) -> io::Result<bool> {
        for proc_entry in fs::read_dir("/proc")? {
            let Some(pid) = proc_entry?
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            // A process that exits mid-scan is simply not a member.
            match proc_stat_pgrp(pid) {
                Ok(Some(pgrp)) if pgrp == pgid => return Ok(true),
                Ok(_) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
        Ok(false)
    }

    /// The process group of `pid` (field 5 of `/proc/<pid>/stat`, the third
    /// field after comm).
    fn proc_stat_pgrp(pid: i32) -> io::Result<Option<i32>> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let unreadable = || io::Error::other("unreadable /proc stat format");
        let rest = stat.rsplit_once(')').ok_or_else(unreadable)?.1;
        let pgrp = rest
            .split_ascii_whitespace()
            .nth(2)
            .ok_or_else(unreadable)?
            .parse()
            .map_err(|_| unreadable())?;
        Ok(Some(pgrp))
    }

    /// The current boot's identity. Fallible on purpose: substituting a
    /// placeholder would make every existing record compare as a different
    /// boot, and the sweep would delete them all without checking or
    /// killing their groups — destroying the evidence AND skipping the kill
    /// in one step.
    fn boot_id() -> io::Result<String> {
        Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_owned())
    }

    /// The registry directory, shared by every host incarnation of this
    /// uid. Pre-existing directories are accepted only when they are a
    /// real directory we own with no group/world access — the sweep kills
    /// processes named by these files, so a directory another uid can
    /// write into would be a kill-by-proxy primitive.
    ///
    /// Rooted at a literal `/tmp`, NOT `std::env::temp_dir()`: crash
    /// ownership is only transferable if every incarnation derives the same
    /// path, and `temp_dir()` follows `TMPDIR`, so a replacement launched
    /// with a different environment would sweep an empty registry and let
    /// recovery refire while the predecessor's descendants still run. A
    /// per-service private `/tmp` namespace (systemd `PrivateTmp`) is
    /// still shared by predecessor and successor of that same service,
    /// which is exactly the scope this needs.
    fn registry_dir() -> io::Result<PathBuf> {
        use std::os::unix::fs::DirBuilderExt;
        let uid = rustix::process::getuid().as_raw();
        let dir = PathBuf::from(format!("/tmp/mc-broca-groups-{uid}"));
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(&dir) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
        let meta = fs::symlink_metadata(&dir)?;
        if !meta.file_type().is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != uid
            || meta.mode() & 0o077 != 0
        {
            return Err(io::Error::other("group registry dir is not private"));
        }
        Ok(dir)
    }

    struct Entry {
        boot_id: String,
        leader_pid: i32,
        leader_start: u64,
        owner_pid: i32,
        owner_start: u64,
    }

    impl Entry {
        fn parse(text: &str) -> Option<Self> {
            let mut lines = text.lines();
            if lines.next()? != "v1" {
                return None;
            }
            let boot_id = lines.next()?.to_owned();
            let pid_line = |lines: &mut std::str::Lines| -> Option<(i32, u64)> {
                let (pid, start) = lines.next()?.split_once(' ')?;
                Some((pid.parse().ok()?, start.parse().ok()?))
            };
            let (leader_pid, leader_start) = pid_line(&mut lines)?;
            let (owner_pid, owner_start) = pid_line(&mut lines)?;
            Some(Self {
                boot_id,
                leader_pid,
                leader_start,
                owner_pid,
                owner_start,
            })
        }
    }

    /// A live registry entry. Removal is by `Drop`, so holding one in the
    /// spawning function's scope covers every exit path — once the group
    /// is reaped in-process, the crash record must not outlive it.
    pub struct GroupRecord {
        path: PathBuf,
    }

    impl GroupRecord {
        /// Records `leader_pid`'s group, or `None` when the record cannot be
        /// written or either process's identity cannot be established. The
        /// spawner treats `None` as fatal for the run and kills the group
        /// before delivering the prompt, so no billable work exists without
        /// a durable record.
        pub fn record(leader_pid: i32) -> Option<Self> {
            let leader_start = proc_start_time(leader_pid).ok().flatten()?;
            let owner_pid = std::process::id() as i32;
            let owner_start = proc_start_time(owner_pid).ok().flatten()?;
            let dir = registry_dir().ok()?;
            let mut nonce = [0u8; 8];
            getrandom::getrandom(&mut nonce).ok()?;
            let path = dir.join(format!("{leader_pid}-{:016x}", u64::from_le_bytes(nonce)));
            let body = format!(
                "v1\n{}\n{leader_pid} {leader_start}\n{owner_pid} {owner_start}\n",
                boot_id().ok()?
            );
            fs::write(&path, body).ok()?;
            Some(Self { path })
        }
    }

    impl Drop for GroupRecord {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    /// Kills process groups recorded by dead host incarnations and removes
    /// their entries; returns how many groups were signalled. Entries whose
    /// owning host is still alive are left untouched, so concurrent hosts
    /// (including test processes) never sweep each other's live runs.
    ///
    /// Fails closed on every ambiguity: an unreadable registry, an
    /// unreadable record, or a `/proc` lookup that cannot answer whether a
    /// process exists all propagate, and the record is left in place. The
    /// caller must keep the component unavailable, because both
    /// alternatives are worse than refusing to start — reading an unknown
    /// as "no orphan" lets recovery refire a run whose descendant is still
    /// executing, and unlinking a record after a failed scan destroys the
    /// only evidence that the orphan exists.
    pub fn sweep_orphaned_groups() -> io::Result<usize> {
        let dir = registry_dir()?;
        let current_boot = boot_id()?;
        let mut killed = 0;
        for file in fs::read_dir(&dir)? {
            let path = file?.path();
            // Records are files; the sibling `runs/` tree is swept
            // separately by `sweep_orphaned_run_dirs`.
            if !path.is_file() {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                // A record removed by its own owner between the listing and
                // this read is not an error.
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => return Err(err),
            };
            // Content that was read successfully but does not parse names no
            // group and can only be garbage; removing it is safe.
            let Some(entry) = Entry::parse(&text) else {
                remove_swept_record(&path)?;
                continue;
            };
            // A different boot means every recorded process is gone and
            // both pids may have been reissued: never kill, just clean up.
            if entry.boot_id != current_boot {
                remove_swept_record(&path)?;
                continue;
            }
            if proc_live_start_time(entry.owner_pid)? == Some(entry.owner_start) {
                continue;
            }
            let group_live = match proc_start_time(entry.leader_pid)? {
                // Same pid and start time: provably the recorded leader.
                Some(start) if start == entry.leader_start => true,
                // The leader's pid was reissued to another process. That is
                // impossible while the recorded group still has members (a
                // pid in use as a pgid is not reallocated), so the group is
                // provably gone.
                Some(_) => false,
                // The leader was reaped (pdeathsig kills only the leader).
                // Members keep the pgid reserved, so any process still in
                // that group can only be a surviving descendant of the
                // recorded run.
                None => group_has_members(entry.leader_pid)?,
            };
            if group_live {
                if let Some(group) = rustix::process::Pid::from_raw(entry.leader_pid) {
                    rustix::process::kill_process_group(group, rustix::process::Signal::KILL)?;
                    killed += 1;
                }
            }
            remove_swept_record(&path)?;
        }
        Ok(killed)
    }

    /// Removes a record whose group has been resolved. A record already gone
    /// (a concurrent host's `Drop`) is success; anything else would leave
    /// the sweep unable to prove it finished.
    fn remove_swept_record(path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// This host's start time, for tagging the run directories it owns.
    pub(crate) fn owner_start_time() -> io::Result<u64> {
        let owner_pid = std::process::id() as i32;
        proc_start_time(owner_pid)?.ok_or_else(|| io::Error::other("this process has no stat"))
    }

    /// Root for per-run private directories, inside the same private
    /// per-uid tree as the crash records so a crashed host's sensitive run
    /// files can be swept by the same startup pass.
    pub fn private_run_root() -> io::Result<PathBuf> {
        use std::os::unix::fs::DirBuilderExt;
        let root = registry_dir()?.join("runs");
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(&root) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
        let meta = fs::symlink_metadata(&root)?;
        if !meta.file_type().is_dir() || meta.file_type().is_symlink() || meta.mode() & 0o077 != 0 {
            return Err(io::Error::other("private run root is not private"));
        }
        Ok(root)
    }

    /// Removes per-run private directories left behind by dead hosts, and
    /// returns how many were removed. A crash skips `PrivateDir`'s cleanup
    /// and its `Drop`, so a run's hidden prompt and transcript would
    /// otherwise stay on disk indefinitely and accumulate across crashes
    /// (R17/R19).
    ///
    /// A directory is removed only when its recorded owner is provably gone,
    /// by the same pid-plus-start-time proof the group sweep uses, so a
    /// concurrent host's live run directories are never touched. Fails
    /// closed for the same reason: deleting a live run's private files
    /// would break the run, and leaving an unverifiable one is a bounded
    /// disk cost.
    pub fn sweep_orphaned_run_dirs() -> io::Result<usize> {
        let root = private_run_root()?;
        let mut removed = 0;
        for entry in fs::read_dir(&root)? {
            let path = entry?.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            // `<prefix>-<owner pid>-<owner start>-<nonce>`: the owner
            // identity is the last two fields before the nonce.
            let mut fields = name.rsplitn(4, '-');
            let (Some(_nonce), Some(start), Some(pid)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let (Ok(pid), Ok(start)) = (pid.parse::<i32>(), start.parse::<u64>()) else {
                continue;
            };
            if proc_start_time(pid)? == Some(start) {
                continue;
            }
            match fs::remove_dir_all(&path) {
                Ok(()) => removed += 1,
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
        Ok(removed)
    }
}
