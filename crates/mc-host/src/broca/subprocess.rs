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
#[derive(Clone)]
pub struct EnvSnapshot {
    vars: Vec<(OsString, OsString)>,
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
            .collect();
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
/// `terminal_probe`, when supplied, inspects the captured stdout after each
/// read and reports whether a decisive transcript has already arrived. The
/// first hit rearms the run deadline to the drain grace, so a harness that
/// finishes its output without closing its pipes (the Pi print-mode
/// shutdown gap) ends as a drain kill with the completed transcript instead
/// of burning the whole run timeout and failing.
pub async fn run(
    spec: SubprocessSpec,
    limits: &SubprocessLimits,
    cancel: &CancellationToken,
    terminal_probe: Option<fn(&[u8]) -> bool>,
) -> io::Result<SubprocessResult> {
    let mut command = tokio::process::Command::new(&spec.executable);
    command
        .args(&spec.args)
        // No inherited environment: the child sees exactly the snapshot
        // plus adapter control variables (R17).
        .env_clear()
        .current_dir(&spec.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A fresh process group makes the whole harness descendant tree the
        // cancellation unit (KTD6); provider or extension grandchildren die
        // with the leader.
        .process_group(0)
        // Backstop only: every ordinary path below reaps explicitly.
        .kill_on_drop(true);
    for (name, value) in &spec.env {
        command.env(name, value);
    }

    let mut child = command.spawn()?;
    // With process_group(0) the leader's pid IS the group id.
    let group = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(rustix::process::Pid::from_raw);

    // Prompt delivery is concurrent with output draining: a child that
    // fills its stdout pipe before reading stdin must not deadlock us.
    // stdin is closed (dropped) after delivery so print-mode reads see EOF.
    let mut stdin_pipe = child.stdin.take();
    let prompt = spec.stdin;
    let stdin_task = tokio::spawn(async move {
        if let Some(mut stdin) = stdin_pipe.take() {
            let _ = stdin.write_all(&prompt).await;
            let _ = stdin.shutdown().await;
        }
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
                    if !terminal_seen && terminal_probe.is_some_and(|probe| probe(&stdout)) {
                        terminal_seen = true;
                        let drain_deadline = tokio::time::Instant::now() + limits.drain_grace;
                        if drain_deadline < deadline.deadline() {
                            deadline.as_mut().reset(drain_deadline);
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
    stdin_task.abort();
    Ok(SubprocessResult {
        stdout,
        stderr,
        end,
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
            // An error means the pid is not our waitable child anymore;
            // report exited so the caller proceeds to the final reap
            // instead of spinning on a pid it can never observe.
            Err(_) => return true,
            Ok(None) => {}
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

impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sensitive temp cleanup failed ({})", self.kind)
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
        let base = std::env::temp_dir();
        // Requesting 0700 at mkdir(2) closes the window where a permissive
        // umask would briefly leave the fresh directory group/world-visible
        // before the chmod below lands (R17).
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        for _ in 0..16 {
            let mut nonce = [0u8; 8];
            getrandom::getrandom(&mut nonce)
                .map_err(|_| io::Error::other("temp-dir nonce generation failed"))?;
            let candidate = base.join(format!("{prefix}-{:016x}", u64::from_le_bytes(nonce)));
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
        file.sync_all()?;
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
/// structural only.
pub(crate) fn spawn_failure(harness: HarnessName, err: &io::Error) -> BackendTerminal {
    BackendTerminal::Failed(BackendError {
        class: ErrorClass::Permanent,
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
    const AUTH: [&str; 6] = [
        "api key",
        "unauthorized",
        "authentication",
        "credential",
        "401",
        "forbidden",
    ];
    const OVERFLOW: [&str; 5] = [
        "context length",
        "context window",
        "prompt is too long",
        "maximum context",
        "context_length",
    ];
    const TRANSIENT: [&str; 10] = [
        "rate limit",
        "rate_limit",
        "429",
        "overloaded",
        "timeout",
        "timed out",
        "temporarily",
        "try again",
        "unavailable",
        "503",
    ];
    if AUTH.iter().any(|needle| lower.contains(needle)) {
        return ErrorClass::AuthRequired;
    }
    if OVERFLOW.iter().any(|needle| lower.contains(needle)) {
        return ErrorClass::ContextOverflow;
    }
    if TRANSIENT.iter().any(|needle| lower.contains(needle)) {
        return ErrorClass::Transient;
    }
    ErrorClass::Permanent
}

/// Ceiling on any retry delay extracted from provider output. The text is
/// untrusted: without a cap, hostile "retry after 99999999999" phrasing
/// would persist a durable historian backoff decades into the future.
pub(crate) const MAX_RETRY_AFTER_SECS: u64 = 3600;

/// Extracts a retry delay in seconds from "retry after 45s"-style phrasing:
/// the first digit run after the word "retry" (R18 retry metadata), clamped
/// to [`MAX_RETRY_AFTER_SECS`] because the source text is untrusted.
pub(crate) fn retry_after_secs_in_text(text: &str) -> Option<u64> {
    let lower = text.to_ascii_lowercase();
    let after = &lower[lower.find("retry")? + "retry".len()..];
    let start = after.find(|c: char| c.is_ascii_digit())?;
    let digits: String = after[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    // An over-long digit run overflows u64::from_str; treat it as the cap
    // rather than dropping the (real) retry signal entirely.
    Some(digits.parse().map_or(MAX_RETRY_AFTER_SECS, |secs: u64| {
        secs.min(MAX_RETRY_AFTER_SECS)
    }))
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
