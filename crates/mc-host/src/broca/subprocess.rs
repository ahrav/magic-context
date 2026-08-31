//!
//! OpenCode and Pi use this runner to prevent their subprocess-security behavior from diverging.
//! The runner does not invoke a shell and uses a dedicated Unix process group.
//! The runner uses a dedicated Unix process group as the cancellation unit and snapshots the daemon-startup environment.
//! The runner removes host launch-identity variables from its environment snapshot and delivers prompts over stdin.
//! The runner creates temp directories and files with `0700` and `0600` permissions and drains stdout and stderr concurrently with bounded buffers.
//! On timeout, the runner terminates the process group gracefully, then escalates to `SIGKILL`.
//! The runner reaps the process-group leader before reporting completion and emits only redacted structural diagnostics.
//! only.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::fd::RawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::backend::{
    BackendError, BackendEvent, BackendTerminal, ErrorClass, EventSink, SinkStatus,
};

/// Every child environment excludes the host launch-identity variables.
/// A harness child inheriting these variables could reconnect to the daemon as the supervised module.
pub const HOST_LAUNCH_IDENTITY_VARS: [&str; 2] = [
    crate::wire::SUBC_MODULE_ID_ENV,
    crate::wire::SUBC_LAUNCH_NONCE_ENV,
];

/// `EnvSnapshot` preserves an immutable copy of the daemon-startup environment.
/// `EnvSnapshot` treats provider credentials and user configuration as trusted inputs.
/// Capture removes host launch-identity variables so later environment composition cannot reintroduce them.
///
/// The `Arc` lets per-run `execute` clones and the Pi provider fallback share the environment allocation.
#[derive(Clone)]
pub struct EnvSnapshot {
    vars: Arc<[(OsString, OsString)]>,
}

/// This cap rejects credential values larger than 16 KiB.
pub const CREDENTIAL_VALUE_CAP_BYTES: usize = 16 * 1024;
/// This cap limits the combined byte length of an admitted credential set.
/// contract's `harness_unavailable.row_cap_bytes`.
pub const CREDENTIAL_ROW_CAP_BYTES: usize = 64 * 1024;
/// Every credential fingerprint includes this key-derivation domain.
pub const CREDENTIAL_FINGERPRINT_DOMAIN: &str = "subc-broca-credential-v1";
/// This identifier fixes the credential-fingerprint pre-image layout.
/// `credential_fingerprint.canonicalization`.
pub const CREDENTIAL_FINGERPRINT_CANONICALIZATION: &str = "harness-provider-name-length-value/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialRowError {
    ProviderUnsupported,
    CredentialMissing,
    CredentialValueTooLarge,
}

impl CredentialRowError {
    pub fn subreason(self) -> &'static str {
        match self {
            Self::ProviderUnsupported => "provider_unsupported",
            Self::CredentialMissing => "credential_missing",
            Self::CredentialValueTooLarge => "credential_value_too_large",
        }
    }
}

/// All provider canonicalization resolves through this function so aliases accepted during row selection remain accepted with the same canonical name during fingerprint derivation and send-time verification.
pub fn canonical_provider(
    harness: &str,
    provider: &str,
) -> Result<&'static str, CredentialRowError> {
    match (harness, provider) {
        ("pi", "google-antigravity") => Ok("google"),
        ("pi", "openai-codex") => Ok("openai"),
        ("opencode" | "pi", "anthropic") => Ok("anthropic"),
        ("opencode" | "pi", "google") => Ok("google"),
        ("opencode" | "pi", "openai") => Ok("openai"),
        _ => Err(CredentialRowError::ProviderUnsupported),
    }
}

impl EnvSnapshot {
    /// The constructor builds a bounded snapshot from explicit startup variables.
    /// Each variable is charged its string bytes plus `ENV_ENTRY_OVERHEAD_BYTES`, so many short variables cannot bypass the ceiling through per-entry container overhead.
    ///
    ///
    /// [`ENV_ENTRY_OVERHEAD_BYTES`]: super::config::ENV_ENTRY_OVERHEAD_BYTES
    /// [`MAX_ENV_SNAPSHOT_BYTES`]: super::config::MAX_ENV_SNAPSHOT_BYTES
    pub fn capture_from(vars: impl IntoIterator<Item = (OsString, OsString)>) -> io::Result<Self> {
        let snapshot = Self::from_vars(vars);
        let bytes: usize = snapshot
            .vars
            .iter()
            .map(|(name, value)| {
                name.as_os_str().len()
                    + value.as_os_str().len()
                    + 2
                    + super::config::ENV_ENTRY_OVERHEAD_BYTES
            })
            .sum();
        if bytes > super::config::MAX_ENV_SNAPSHOT_BYTES {
            return Err(io::Error::other(format!(
                "startup environment charges {bytes} bytes ({} variables), \
                 over the {} byte snapshot ceiling",
                snapshot.vars.len(),
                super::config::MAX_ENV_SNAPSHOT_BYTES
            )));
        }
        Ok(snapshot)
    }

    /// Snapshots never carry `SUBC_MODULE_ID` or `SUBC_LAUNCH_NONCE`.
    /// Snapshots exclude `SUBC_MODULE_ID` and `SUBC_LAUNCH_NONCE` regardless of construction path.
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

    /// No ambient loader, proxy, cloud-chain, package manager, HOME/XDG, PATH, or unrelated provider variable survives.
    pub fn provider_row(
        &self,
        harness: &str,
        provider: &str,
    ) -> Result<Vec<(OsString, OsString)>, CredentialRowError> {
        let variable = match canonical_provider(harness, provider)? {
            "anthropic" => "ANTHROPIC_API_KEY",
            "google" => "GEMINI_API_KEY",
            "openai" => "OPENAI_API_KEY",
            _ => return Err(CredentialRowError::ProviderUnsupported),
        };
        let Some((name, value)) = self
            .vars
            .iter()
            .find(|(name, _)| name.as_os_str() == OsStr::new(variable))
        else {
            return Err(CredentialRowError::CredentialMissing);
        };
        if value.is_empty() {
            return Err(CredentialRowError::CredentialMissing);
        }
        if value.len() > CREDENTIAL_VALUE_CAP_BYTES {
            return Err(CredentialRowError::CredentialValueTooLarge);
        }
        Ok(vec![(name.clone(), value.clone())])
    }

    pub fn credential_fingerprint(
        &self,
        connection_key: &[u8; 32],
        harness: &str,
        provider: &str,
    ) -> Result<String, CredentialRowError> {
        let canonical = canonical_provider(harness, provider)?;
        let row = self.provider_row(harness, canonical)?;
        let encoded = |field: &str| format!("{}:{field}", field.len());
        let mut message = encoded(CREDENTIAL_FINGERPRINT_CANONICALIZATION)
            + &encoded(harness)
            + &encoded(canonical);
        for (name, value) in row {
            let name = name.to_string_lossy();
            let value = value.to_string_lossy();
            message.push_str(&encoded(&name));
            message.push_str(&encoded(&value.len().to_string()));
            message.push_str(&encoded(&value));
        }
        let mut derive =
            Hmac::<Sha256>::new_from_slice(connection_key).expect("HMAC accepts any key length");
        derive.update(CREDENTIAL_FINGERPRINT_DOMAIN.as_bytes());
        let derived = derive.finalize().into_bytes();
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&derived).expect("HMAC accepts any key length");
        mac.update(message.as_bytes());
        Ok(mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
}

impl std::fmt::Debug for EnvSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Environment values are credentials; report only the count.
        f.debug_struct("EnvSnapshot")
            .field("var_count", &self.vars.len())
            .finish()
    }
}

/// `ExecutionBounds` applies to one harness run.
/// fast.
#[derive(Clone, Debug)]
pub struct SubprocessLimits {
    /// `timeout` terminates an elapsed run and maps it to one failed terminal.
    pub run_timeout: Duration,
    /// `termination_grace` delays group SIGKILL after group SIGTERM.
    pub termination_grace: Duration,
    /// `post_eof_grace` waits for the child to exit after clean stream EOF before forced termination.
    /// Clean stream EOF can precede process exit.
    pub drain_grace: Duration,
    /// `stdout_limit` stops a child that exceeds the retained stdout bound.
    pub max_stdout_bytes: usize,
    /// The runner retains bounded stderr for diagnostics only.
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

/// The prompt travels only through stdin.
/// `stdin` carries the prompt; argv carries flags and trusted paths, never caller text.
pub struct SubprocessSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
    /// The child uses `env_clear`; adapter-owned control variables follow snapshot variables and win collisions.
    pub env: Vec<(OsString, OsString)>,
    pub working_dir: PathBuf,
    pub stdin: Vec<u8>,
    /// `inherit_fds` retains descriptors referenced by child path arguments.
    pub inherit_fds: Vec<RawFd>,
}

/// child output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubprocessEnd {
    Exited(i32),
    /// DrainKilled means the transcript completed but the leader exceeded the drain grace or kept pipes open after a decisive probe; parsers treat it as a clean exit.
    /// DrainKilled applies when the leader outlives the drain grace after clean stream EOF.
    /// DrainKilled also applies when a terminal probe recognizes a decisive transcript while the child keeps its pipes open.
    DrainKilled,
    /// `Signaled` means `run` did not send the killing signal.
    Signaled,
    TimedOut,
    Cancelled,
    StdoutOverflow,
    StderrOverflow,
    /// CaptureFailed records a stdout read failure; parsers distrust the transcript even after a clean exit.
    CaptureFailed,
    /// A group signal failure other than "already gone" leaves the run unsettled because descendants may still execute billable requests.
    TeardownUnconfirmed,
}

/// ProbeSignal tells run whether newly completed stdout permits shortening the deadline to the drain grace without treating a retryable failure as final.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeSignal {
    /// `Quiet` provides no completion signal.
    Quiet,
    /// `Decisive` prevents later output from changing the terminal classification.
    Decisive,
    /// A retryable terminal failure arms the drain grace so a final failure retains its classification; ProbeSignal::Continues before the grace expires restores the full deadline.
    /// deadline.
    Provisional,
    /// ProbeSignal::Continues indicates that new work began, so provisional drain arming was premature.
    Continues,
}

pub struct SubprocessResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub end: SubprocessEnd,
    /// prompt_delivered is true only when the whole prompt reached the child's stdin before it closed; parsers reject transcripts otherwise, even after a clean end state.
    pub prompt_delivered: bool,
}

/// Returns after the leader is reaped on every path, including timeout, cancellation, and overflow, so lifecycle completion upstream can never observe a live child.
///
/// `terminal_probe` inspects each newly completed stdout-line region exactly once.
/// A terminal signal rearms the run deadline to the drain grace.
/// If the harness resumes before the grace expires, it is not killed during its retry.
pub async fn run(
    spec: SubprocessSpec,
    limits: &SubprocessLimits,
    cancel: &CancellationToken,
    terminal_probe: Option<fn(&[u8]) -> ProbeSignal>,
) -> io::Result<SubprocessResult> {
    let SubprocessSpec {
        executable,
        args,
        env,
        working_dir,
        stdin: prompt,
        inherit_fds,
    } = spec;
    let mut command = tokio::process::Command::new(&executable);
    command
        .args(&args)
        .env_clear()
        .current_dir(&working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A fresh process group makes the harness descendant tree the cancellation unit.
        // Group cleanup targets provider and extension grandchildren in the harness process group.
        .process_group(0)
        // Ordinary paths reap explicitly; `Drop` is only a backstop.
        .kill_on_drop(true);
    // On Linux, `pdeathsig` asks the kernel to SIGKILL the leader when its parent process dies.
    // Drop cleanup does not run after SIGKILL.
    // `pdeathsig` applies only to the leader.
    // The startup sweep in [`group_registry`] handles descendants that survive the leader.
    // Group cleanup handles descendants on ordinary termination paths.
    //
    // The parent check closes the window where the host dies between `fork` and `pdeathsig` setup.
    // The check compares the child's parent PID with `host_pid` captured before `fork`.
    // Comparing with `host_pid` permits a host running as PID 1.
    // The parent check aborts when the child no longer has `host_pid` as its parent.
    let host_pid = std::process::id();
    let child_inherit_fds = inherit_fds.clone();
    // SAFETY: `pre_exec` runs after `fork` and before `exec`, so its closure must avoid allocation and locking.
    #[allow(unsafe_code)]
    unsafe {
        command.pre_exec(move || {
            #[cfg(target_os = "linux")]
            rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL))?;
            let parent = rustix::process::getppid().map(|pid| pid.as_raw_nonzero().get() as u32);
            if parent != Some(host_pid) {
                return Err(io::Error::other("host exited before spawn completed"));
            }
            for fd in &child_inherit_fds {
                if libc::fcntl(*fd, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    for (name, value) in &env {
        command.env(name, value);
    }

    let mut child = command.spawn()?;
    // Dropping `command` and `env` releases their environment-sized allocations before concurrent runs continue.
    drop(command);
    drop(env);
    drop(args);
    drop(executable);
    drop(working_dir);
    drop(inherit_fds);
    // With process_group(0) the leader's pid IS the group id.
    let group = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(rustix::process::Pid::from_raw);
    // Crash-ownership registration is a barrier before prompt delivery.
    // Registration failure sends `KILL` before stdin delivery.
    let group_record =
        group.and_then(|g| group_registry::GroupRecord::record(g.as_raw_nonzero().get()));
    if group_record.is_none() {
        let signalled = kill_group(group, rustix::process::Signal::KILL).is_ok();
        // `child.start_kill()` covers a missing or unaddressable process group.
        let _ = child.start_kill();
        // `timeout` prevents an uninterruptible leader from blocking `work_done` waiters indefinitely.
        let members_gone = wait_other_members_gone(group, limits.termination_grace).await;
        let reaped = tokio::time::timeout(limits.termination_grace, child.wait())
            .await
            .is_ok();
        if !(signalled && members_gone && reaped) {
            // The registration-failure path returns `RegistrationTeardownUnproven` when teardown cannot be proven.
            // No prompt bytes have flowed because registration precedes stdin delivery.
            // The host cannot report the group as terminated until teardown is proven.
            return Err(io::Error::other(RegistrationTeardownUnproven));
        }
        return Err(io::Error::other(
            "crash-ownership registration failed before prompt delivery",
        ));
    }
    // `group_record` remains `Some` until teardown is proven, retaining the registry record.
    // The successor sweeps the group's descendants after this host exits.
    let mut group_record = group_record;

    // Concurrent prompt delivery and output draining prevent a child that fills stdout before reading stdin from deadlocking the host.
    // Prompt delivery drops stdin after writing so print-mode reads receive EOF.
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
    // `run_deadline` preserves the original timeout budget when provisional arming is revoked.
    let run_deadline = tokio::time::Instant::now() + limits.run_timeout;
    let deadline = tokio::time::sleep_until(run_deadline);
    tokio::pin!(deadline);
    let mut terminal_seen = false;
    let mut arming_revocable = false;
    // Bytes before `probed_to` have already been probed.
    // line is inspected exactly once no matter how the reads chunk it.
    let mut probed_to = 0usize;

    let abnormal = loop {
        if !stdout_open && !stderr_open {
            break None;
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => break Some(SubprocessEnd::Cancelled),
            // After the probe fires, the rearmed deadline limits drain grace because the transcript is complete.
            // After the transcript completes, an open pipe marks a shutdown gap rather than a run timeout.
            () = &mut deadline => break Some(if terminal_seen {
                SubprocessEnd::DrainKilled
            } else {
                SubprocessEnd::TimedOut
            }),
            read = stdout_pipe.read(&mut stdout_chunk), if stdout_open => match read {
                Ok(0) => stdout_open = false,
                // A read error is not EOF because the remaining transcript is unknown.
                // A parseable prefix and clean child exit could publish a truncated answer as success.
                // A truncated transcript could omit a contradictory terminal.
                Err(_) => break Some(SubprocessEnd::CaptureFailed),
                Ok(n) => {
                    if stdout.len() + n > limits.max_stdout_bytes {
                        break Some(SubprocessEnd::StdoutOverflow);
                    }
                    stdout.extend_from_slice(&stdout_chunk[..n]);
                    // Probing continues after revocable arming because revocation arrives later.
                    if !terminal_seen || arming_revocable {
                        if let Some(probe) = terminal_probe {
                            // Searching only new bytes prevents a long line from making newline search quadratic.
                            // Bytes preceding the newly appended chunk were already searched and contained no newline.
                            let appended_at = stdout.len() - n;
                            if let Some(last_newline) = stdout[appended_at..]
                                .iter()
                                .rposition(|byte| *byte == b'\n')
                            {
                                let end = appended_at + last_newline + 1;
                                match probe(&stdout[probed_to..end]) {
                                    ProbeSignal::Quiet => {}
                                    signal @ (ProbeSignal::Decisive
                                    | ProbeSignal::Provisional) => {
                                        terminal_seen = true;
                                        arming_revocable =
                                            signal == ProbeSignal::Provisional;
                                        let drain_deadline =
                                            tokio::time::Instant::now() + limits.drain_grace;
                                        if drain_deadline < deadline.deadline() {
                                            deadline.as_mut().reset(drain_deadline);
                                        }
                                    }
                                    // The code undoes only revocable arming.
                                    // A decisive terminal remains valid after subsequent output.
                                    // The restored deadline may already be past, ending the run as a timeout rather than granting retry free budget.
                                    ProbeSignal::Continues => {
                                        if arming_revocable {
                                            terminal_seen = false;
                                            arming_revocable = false;
                                            deadline.as_mut().reset(run_deadline);
                                        }
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

    let group_gone;
    let end = match abnormal {
        Some(end) => {
            group_gone = terminate_group(group, &mut child, limits.termination_grace)
                .await
                .is_ok();
            end
        }
        None => {
            // After both streams reach EOF, the code waits up to `limits.drain_grace` for the leader to exit without reaping it; its zombie pins the pgid until the descendant sweep completes.
            let exit = wait_exited_unreaped(group, limits.drain_grace).await;
            if exit != LeaderExit::Running {
                let signalled =
                    kill_group_fenced(group, exit, rustix::process::Signal::KILL).is_ok();
                // A fenced `KILL` only signals; the code retains the process-group fence until the sweep completes to prevent signaling a recycled pgid.
                // The teardown succeeds only after the process group is observed gone.
                // The teardown checks member disappearance while the unreaped leader pins the pgid.
                // the pgid.
                group_gone =
                    signalled && wait_other_members_gone(group, limits.termination_grace).await;
                child
                    .wait()
                    .await
                    .map_or(SubprocessEnd::DrainKilled, |status| {
                        status
                            .code()
                            .map_or(SubprocessEnd::Signaled, SubprocessEnd::Exited)
                    })
            } else {
                group_gone = terminate_group(group, &mut child, limits.termination_grace)
                    .await
                    .is_ok();
                SubprocessEnd::DrainKilled
            }
        }
    };
    // The host retains the record while descendants may still be running.
    let end = if group_gone {
        end
    } else {
        if let Some(record) = group_record.take() {
            record.retain();
        }
        SubprocessEnd::TeardownUnconfirmed
    };
    drop(group_record);

    // The timeout bounds the write when a surviving process retains stdin.
    // An incomplete write sets `prompt_delivered` to false.
    // A timeout caused by an inherited stdin fd surviving the sweep counts as non-delivery.
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

/// `ESRCH` means the group is already gone; any other failure may leave descendants running.
fn kill_group(
    group: Option<rustix::process::Pid>,
    signal: rustix::process::Signal,
) -> io::Result<()> {
    let Some(group) = group else { return Ok(()) };
    match rustix::process::kill_process_group(group, signal) {
        Ok(()) | Err(rustix::io::Errno::SRCH) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// against reuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaderExit {
    Running,
    /// An exited, unreaped leader's zombie holds the pgid, so group signals cannot reach a recycled group.
    ExitedFenced,
    /// If `SIGCHLD=SIG_IGN`, `SA_NOCLDWAIT`, or another in-process reaper has reaped the leader, no zombie fences the pgid.
    /// Without a zombie fence, the pgid may already belong to an unrelated group.
    ExitedUnfenced,
}

/// The function waits up to `budget` for the leader to exit without reaping it.
/// An unreaped zombie pins the process-group ID, preventing PID/PGID recycling during descendant sweeps.
async fn wait_exited_unreaped(group: Option<rustix::process::Pid>, budget: Duration) -> LeaderExit {
    let Some(pid) = group else {
        return LeaderExit::Running;
    };
    // Tokio owns the child's `SIGCHLD` handling, so the function uses a 10 ms bounded poll.
    const POLL: Duration = Duration::from_millis(10);
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let options = rustix::process::WaitIdOptions::EXITED
            | rustix::process::WaitIdOptions::NOWAIT
            | rustix::process::WaitIdOptions::NOHANG;
        match rustix::process::waitid(rustix::process::WaitId::Pid(pid), options) {
            Ok(Some(_)) => return LeaderExit::ExitedFenced,
            // `NotWaitable` proves that the leader exited.
            // deadline decides.
            Err(rustix::io::Errno::CHILD | rustix::io::Errno::SRCH) => {
                return LeaderExit::ExitedUnfenced
            }
            Err(_) | Ok(None) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return LeaderExit::Running;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Membership checks reduce, but cannot eliminate, recycled-pgid signaling.
///
/// A zombie leader pins the pgid, preventing reuse.
/// When the leader has been reaped, the numeric pgid may belong to an unrelated group.
/// Scan errors do not suppress the signal, prioritizing descendant cleanup over a possible leaked group.
/// The check-to-signal window can still target a recycled pgid; never signaling can leak descendants.
fn kill_group_fenced(
    group: Option<rustix::process::Pid>,
    exit: LeaderExit,
    signal: rustix::process::Signal,
) -> io::Result<()> {
    if exit == LeaderExit::ExitedUnfenced {
        let Some(pid) = group else { return Ok(()) };
        let pgid = pid.as_raw_nonzero().get();
        let live = group_registry::group_has_members(pgid)
            .or_else(|_| group_registry::group_has_members(pgid))
            .unwrap_or(true);
        if !live {
            return Ok(());
        }
    }
    kill_group(group, signal)
}

/// Callers must keep the leader unreaped so its zombie prevents pgid recycling during the poll.
/// Callers must keep the leader unreaped so its zombie prevents pgid recycling during the poll.
/// pgid.
/// Return `false` on deadline expiry; scan failures leave teardown unproven and continue polling.
async fn wait_other_members_gone(group: Option<rustix::process::Pid>, budget: Duration) -> bool {
    let Some(pid) = group else { return true };
    let pgid = pid.as_raw_nonzero().get();
    const POLL: Duration = Duration::from_millis(10);
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if matches!(group_registry::group_has_other_members(pgid), Ok(false)) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Send the final `SIGKILL` before reaping so the zombie pins the pgid.
async fn terminate_group(
    group: Option<rustix::process::Pid>,
    child: &mut tokio::process::Child,
    grace: Duration,
) -> io::Result<()> {
    kill_group(group, rustix::process::Signal::TERM)?;
    if group.is_none() {
        let _ = child.start_kill();
    }
    let mut exit = wait_exited_unreaped(group, grace).await;
    if exit == LeaderExit::Running {
        kill_group(group, rustix::process::Signal::KILL)?;
        let _ = child.start_kill();
        // SIGKILL cannot be caught; the bound limits time spent waiting for exit.
        exit = wait_exited_unreaped(group, grace).await;
    }
    let signalled = kill_group_fenced(group, exit, rustix::process::Signal::KILL);
    // Check that no other group members remain before reaping the leader so its zombie pins the pgid.
    // Wait for members to disappear rather than treating `SIGKILL` delivery as teardown proof.
    let members_gone = wait_other_members_gone(group, grace).await;
    // Bound `child.wait()` by `grace` to prevent an unreapable leader from blocking teardown indefinitely.
    if tokio::time::timeout(grace, child.wait()).await.is_err() {
        return Err(io::Error::other(
            "harness leader was not reapable within the termination grace",
        ));
    }
    if !members_gone {
        return Err(io::Error::other(
            "harness group members could not be confirmed stopped within the termination grace",
        ));
    }
    signalled
}

/// Report sensitive-file cleanup failures by error kind only; never include paths or file contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupFailure {
    pub kind: io::ErrorKind,
}

/// The provider fallback uses `CleanupFailure`'s `Display` text as its retry discriminator.
/// The Pi fallback gate does not retry after cleanup leaves private prompt material on disk.
pub(crate) const CLEANUP_FAILURE_MARKER: &str = "cleanup failed";

impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sensitive temp {CLEANUP_FAILURE_MARKER} ({})", self.kind)
    }
}

/// This run's sensitive files use a fresh directory forced to `0700` despite the inherited umask.
/// Cleanup failures remain observable because callers handle cleanup explicitly.
/// `Drop` backstops early-return paths with best-effort cleanup.
pub struct PrivateDir {
    path: Option<PathBuf>,
}

impl PrivateDir {
    pub fn create(prefix: &str) -> io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        // The crash sweeper removes directories in the run root whose names identify their creator.
        // The crash sweeper removes stale prompt and transcript directories.
        let base = group_registry::private_run_root()?;
        let owner_boot = group_registry::owner_boot_tag()?;
        let owner_pid = std::process::id();
        let owner_start = group_registry::owner_start_time()?;
        // Requesting `0700` at `mkdir(2)` prevents a permissive umask from exposing the new directory before `set_permissions` runs.
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        for _ in 0..16 {
            let mut nonce = [0u8; 8];
            getrandom::getrandom(&mut nonce)
                .map_err(|_| io::Error::other("temp-dir nonce generation failed"))?;
            let candidate = base.join(format!(
                "{prefix}-{owner_boot}-{owner_pid}-{owner_start}-{:016x}",
                u64::from_le_bytes(nonce)
            ));
            // `create` rejects existing entries, including symlinks, so success uses a previously absent pathname.
            match builder.create(&candidate) {
                Ok(()) => {
                    // `mkdir(2)` modes are umask-filtered, so `set_permissions` forces `0700`.
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

    /// Creates `name` as a fresh regular file forced to `0600` regardless of the inherited umask.
    pub fn write_private(&self, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
        use std::io::Write;
        let path = self.path().join(name);
        // `create_new` rejects existing entries and symlinks, so success uses a previously absent pathname.
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(bytes)?;
        // No `fsync`: the child reads this file before cleanup.
        drop(file);
        // The `open(2)` mode is umask-filtered, so `set_permissions` forces `0600`.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let meta = fs::symlink_metadata(&path)?;
        if !meta.file_type().is_file() || meta.file_type().is_symlink() {
            return Err(io::Error::other("private temp file is not a fresh file"));
        }
        Ok(path)
    }

    /// `merge_cleanup` propagates cleanup failures to the run terminal.
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

/// A cleanup failure converts a completed run to a failure because sensitive files may remain.
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
        // `merge_cleanup` must not downgrade an unresolved teardown failure.
        // Cancel and delete must not claim work stopped while teardown remains unresolved.
        BackendTerminal::FailedUnresolved(mut error) => {
            error.message = format!("{}; additionally {failure}", error.message);
            BackendTerminal::FailedUnresolved(error)
        }
    }
}

/// `RegistrationTeardownUnproven` marks a spawn error whose pre-prompt process group was not proven torn down.
/// Crash-ownership registration failure leaves no registry record for a successor to sweep.
/// The marker requires a missing registry record and a SIGKILLed group not confirmed gone within the grace period.
/// Cancel, delete, and shutdown latch `work_unresolved` for `BackendTerminal::FailedUnresolved`.
/// `work_unresolved` prevents shutdown from claiming an unproven teardown.
#[derive(Debug)]
struct RegistrationTeardownUnproven;

impl std::fmt::Display for RegistrationTeardownUnproven {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "crash-ownership registration failed and the process group \
             could not be confirmed stopped"
        )
    }
}

impl std::error::Error for RegistrationTeardownUnproven {}

pub(crate) fn spawn_failure(harness: HarnessName, err: &io::Error) -> BackendTerminal {
    if err
        .get_ref()
        .is_some_and(|inner| inner.is::<RegistrationTeardownUnproven>())
    {
        return BackendTerminal::FailedUnresolved(BackendError {
            class: ErrorClass::Transient,
            message: format!(
                "{} backend crash-ownership registration failed; the \
                 process group could not be confirmed stopped",
                harness.name()
            ),
            retry_after_secs: None,
            provider_code: None,
        });
    }
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

pub(crate) fn credential_failure(
    harness: HarnessName,
    error: CredentialRowError,
) -> BackendTerminal {
    harness_unavailable_failure(harness, error.subreason())
}

pub(crate) fn harness_unavailable_failure(
    harness: HarnessName,
    reason: &'static str,
) -> BackendTerminal {
    BackendTerminal::Failed(BackendError {
        class: ErrorClass::Permanent,
        message: format!("{} harness_unavailable: {}", harness.name(), reason),
        retry_after_secs: None,
        provider_code: None,
    })
}

/// A name carrier prevents shared diagnostics from formatting request content.
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

/// The parser returns `None` for ends it should interpret from the transcript.
/// Classification may use bounded stderr for the error class but never quote child output.
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
        // A pipe I/O failure does not classify the request, so a retry can succeed.
        SubprocessEnd::CaptureFailed => BackendError {
            class: ErrorClass::Transient,
            message: format!("{name} backend output capture failed"),
            retry_after_secs: None,
            provider_code: None,
        },
        // Signal denial is transient because a later run may be permitted.
        // The terminal must report that the work did not settle.
        // The supervisor must not treat `BackendTerminal::FailedUnresolved` as proof that the work stopped.
        SubprocessEnd::TeardownUnconfirmed => {
            return Some(BackendTerminal::FailedUnresolved(BackendError {
                class: ErrorClass::Transient,
                message: format!("{name} backend process group teardown was not confirmed"),
                retry_after_secs: None,
                provider_code: None,
            }));
        }
    };
    Some(BackendTerminal::Failed(error))
}

/// A bounded parse failure records structural position, never line content.
pub(crate) fn parse_failure(harness: HarnessName, detail: &str) -> BackendTerminal {
    BackendTerminal::Failed(BackendError {
        class: ErrorClass::Permanent,
        message: format!("{} backend output rejected: {detail}", harness.name()),
        retry_after_secs: None,
        provider_code: None,
    })
}

/// Authentication and context-overflow classes are checked first because their phrasing can also mention retries.
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

/// A substring match misreads `401` in `req-40123` or `req-x401abc`.
/// Boundaries are non-alphanumeric on both sides, so `status 401`, `(401)`, and `401:` match while `x401abc` does not.
fn contains_status_code(haystack: &str, code: &str) -> bool {
    haystack.match_indices(code).any(|(index, _)| {
        let before = haystack[..index].chars().next_back();
        let after = haystack[index + code.len()..].chars().next();
        before.is_none_or(|c| !c.is_ascii_alphanumeric())
            && after.is_none_or(|c| !c.is_ascii_alphanumeric())
    })
}

/// The parser caps retry delays from untrusted provider text.
pub(crate) const MAX_RETRY_AFTER_SECS: u64 = 3600;

/// The parser extracts only explicit retry delays from provider failure text and clamps them to [`MAX_RETRY_AFTER_SECS`].
///
pub(crate) fn retry_after_secs_in_text(text: &str) -> Option<u64> {
    let lower = text.to_ascii_lowercase();
    let mut saw_verb = false;
    let mut saw_delay_keyword = false;
    let mut pending: Option<u64> = None;
    let tokens = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty());
    for token in tokens {
        // After an explicit delay, an unrecognized following token leaves the delay in seconds.
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
        }
        if saw_verb {
            saw_verb = false;
            if matches!(token, "after" | "in") {
                saw_delay_keyword = true;
                continue;
            }
        }
        match token {
            // Exact matching prevents `retrieval after 300 items` from being parsed as a retry delay.
            "retry" | "retries" | "retried" | "retrying" => saw_verb = true,
            // `retryAfter` lowercases to `retryafter`, so it is treated as an explicit retry-delay marker.
            "retryafter" => saw_delay_keyword = true,
            _ => {}
        }
    }
    pending.map(|value| value.min(MAX_RETRY_AFTER_SECS))
}

/// A digit run that overflows `u64` clamps to `MAX_RETRY_AFTER_SECS` rather than discarding the retry signal.
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

fn apply_delay_unit(value: u64, unit: &str) -> u64 {
    let secs = match unit {
        // A bare number after an explicit delay keyword means seconds.
        "" | "s" | "sec" | "secs" | "second" | "seconds" => value,
        "ms" | "millisecond" | "milliseconds" => value.div_ceil(1000).max(1),
        "m" | "min" | "mins" | "minute" | "minutes" => value.saturating_mul(60),
        "h" | "hr" | "hrs" | "hour" | "hours" => value.saturating_mul(3600),
        // An unrecognized unit after an explicit delay form leaves the number in seconds.
        _ => value,
    };
    secs.min(MAX_RETRY_AFTER_SECS)
}

/// `MAX_LINE_JSON_NODES` caps structural JSON nodes in one harness output line.
///
/// Parsing untyped `serde_json::Value` allocates a node for each array element and object entry, so tiny values can exceed the capture budget's allocation model.
/// Bounding the node count prevents tiny JSON values from amplifying DOM allocation beyond the transcript-sized capture budget.
/// The bound limits node count without limiting line length.
///
pub(crate) const MAX_LINE_JSON_NODES: usize = 32_768;

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

/// The wire admits provider codes only if they match `[A-Za-z0-9_.-]{1,64}`.
/// forwarded.
pub(crate) fn sanitized_provider_code(code: &str) -> Option<String> {
    (!code.is_empty()
        && code.len() <= 64
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
    .then(|| code.to_owned())
}

/// A success terminal and an error terminal cannot both be reported.
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
    // Reject transcripts when stdin closes before the whole prompt is delivered; they may answer a truncated prompt.
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

/// Abnormal ends take precedence over parsed terminals and parse failures.
/// `finalize` merges cleanup last so cleanup failures are observable on every path.
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

/// The crash-orphan registry stores one file per live harness process group.
/// replacement host can kill groups a crashed predecessor left behind.
///
/// `pdeathsig` terminates only the group leader; provider and extension descendants can survive it.
/// Descendants can survive the host and continue executing after the leader exits.
/// The host sweeps orphaned groups at startup before answering status.
///
/// The orphan sweep kills an entry's group only when its recording host is dead and the group matches the recorded run.
/// A group matches its recorded run only if its leader's PID, start time, and boot ID match, or the leader is gone while processes remain in its group.
/// The group can empty between the membership check and `kill(-pgid)`.
pub mod group_registry {
    use std::os::unix::fs::MetadataExt;

    use super::*;

    /// The Linux `/proc/<pid>/stat` field 22 records a process start time in clock ticks since boot.
    /// For `/proc/<pid>/stat`, `Ok(None)` means the PID provably does not exist; `Err` means the answer is unknown.
    /// Callers must not guess on `Err`, because treating the owner or leader as gone can kill a live group or remove its registry entry.
    fn proc_start_time(pid: i32) -> io::Result<Option<u64>> {
        proc_stat_fields(pid).map(|fields| fields.map(|(_, start)| start))
    }

    /// A zombie counts as dead because an unreaped crashed host can retain its PID and start time.
    /// holding runs.
    fn proc_live_start_time(pid: i32) -> io::Result<Option<u64>> {
        Ok(proc_stat_fields(pid)?.and_then(|(state, start)| (state != 'Z').then_some(start)))
    }

    /// Parse after the last `)` because `comm` may contain spaces and parentheses.
    fn proc_stat_fields(pid: i32) -> io::Result<Option<(char, u64)>> {
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            // `NotFound` is the only condition treated as proof that the PID is gone.
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

    /// `group_has_members` checks whether any non-zombie process belongs to PGID `pgid`.
    /// `group_has_members` runs only after the recorded leader is gone.
    /// The kernel reserves a PGID while the group has members.
    /// Any non-zombie process found then belongs to the recorded group.
    /// Zombies do not count because they cannot execute work.
    /// A zombie is reaped by its parent or init independently of the sweep.
    /// A scan that cannot complete returns an error rather than “no members” so the sweep neither skips the kill nor deletes the orphan record.
    pub(crate) fn group_has_members(pgid: i32) -> io::Result<bool> {
        scan_group_members(pgid, None)
    }

    /// Exclude the leader because its unreaped zombie retains the PGID but cannot execute work.
    /// The deliberately unreaped zombie's `/proc` entry still names the PGID.
    /// The zombie prevents PGID reuse but cannot execute work.
    /// surviving member.
    pub(crate) fn group_has_other_members(pgid: i32) -> io::Result<bool> {
        scan_group_members(pgid, Some(pgid))
    }

    fn scan_group_members(pgid: i32, exclude_pid: Option<i32>) -> io::Result<bool> {
        for proc_entry in fs::read_dir("/proc")? {
            let Some(pid) = proc_entry?
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            if Some(pid) == exclude_pid {
                continue;
            }
            // A process that exits mid-scan is not a member.
            match proc_stat_pgrp_state(pid) {
                Ok(Some((pgrp, state))) if pgrp == pgid && state != 'Z' && state != 'X' => {
                    return Ok(true)
                }
                Ok(_) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
        Ok(false)
    }

    /// `/proc/<pid>/stat` stores state and process group as the first and third fields after `comm`.
    fn proc_stat_pgrp_state(pid: i32) -> io::Result<Option<(i32, char)>> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let unreadable = || io::Error::other("unreadable /proc stat format");
        let rest = stat.rsplit_once(')').ok_or_else(unreadable)?.1;
        let mut fields = rest.split_ascii_whitespace();
        let state = fields
            .next()
            .and_then(|field| field.chars().next())
            .ok_or_else(unreadable)?;
        let pgrp = fields
            .nth(1)
            .ok_or_else(unreadable)?
            .parse()
            .map_err(|_| unreadable())?;
        Ok(Some((pgrp, state)))
    }

    /// `boot_id` must not use a placeholder, because one would make existing records appear to come from a different boot.
    /// `sweep` would delete all records without checking or killing their groups if `boot_id` used a placeholder.
    fn boot_id() -> io::Result<String> {
        Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_owned())
    }

    /// The registry directory is shared by all host incarnations of the UID.
    /// The sweep kills groups named by registry files, so another UID must not be able to write the directory.
    ///
    /// `registry_dir` uses literal `/tmp` because `TMPDIR` can differ between predecessor and replacement.
    /// A replacement with a different `TMPDIR` would miss predecessor records, allowing recovery while descendant processes still run.
    /// `PrivateTmp` shares a service's `/tmp` namespace between predecessor and successor.
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

    /// Holding `GroupRecord` through spawning removes its file on `Drop` after in-process reaping, so the crash record cannot outlive the group.
    pub struct GroupRecord {
        path: PathBuf,
    }

    impl GroupRecord {
        /// `record` returns `None` if it cannot write the record or establish either process identity.
        /// The spawner kills the group before delivering the prompt when `record` returns `None`.
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

    impl GroupRecord {
        /// The caller retains the record if it cannot prove the group has exited; a later host sweep removes it.
        pub fn retain(self) {
            std::mem::forget(self);
        }
    }

    impl Drop for GroupRecord {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    /// `sweep` kills groups recorded by dead host incarnations and removes their entries.
    /// `sweep` leaves entries owned by live hosts untouched, so concurrent hosts do not sweep each other's runs.
    ///
    /// `sweep` propagates unreadable-registry, unreadable-record, and indeterminate `/proc` lookup errors without removing the record.
    /// Treating an unknown `/proc` result as "no orphan" can refire a run while its descendant executes.
    pub fn sweep_orphaned_groups() -> io::Result<usize> {
        let dir = registry_dir()?;
        let current_boot = boot_id()?;
        let mut killed = 0;
        for file in fs::read_dir(&dir)? {
            let path = file?.path();
            // Only regular files are registry records; `sweep_orphaned_run_dirs` sweeps `runs/`.
            if !path.is_file() {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                // `NotFound` means another process removed the record after directory enumeration.
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => return Err(err),
            };
            // A record that does not parse cannot identify a group.
            let Some(entry) = Entry::parse(&text) else {
                remove_swept_record(&path)?;
                continue;
            };
            // A record from a different boot must be removed without signaling because its PIDs may be reused.
            if entry.boot_id != current_boot {
                remove_swept_record(&path)?;
                continue;
            }
            if proc_live_start_time(entry.owner_pid)? == Some(entry.owner_start) {
                continue;
            }
            let group_live = match proc_start_time(entry.leader_pid)? {
                // Matching `leader_pid` and `leader_start` identifies the recorded leader.
                Some(start) if start == entry.leader_start => true,
                // A reused leader PID proves the recorded group is gone: a PID used as a PGID cannot be reallocated while group members remain.
                // provably gone.
                Some(_) => false,
                // The leader was reaped (pdeathsig kills only the leader).
                // Surviving members retain the PGID, so they are descendants of the recorded run.
                // recorded run.
                None => group_has_members(entry.leader_pid)?,
            };
            if group_live {
                if let Some(group) = rustix::process::Pid::from_raw(entry.leader_pid) {
                    match rustix::process::kill_process_group(group, rustix::process::Signal::KILL)
                    {
                        Ok(()) => killed += 1,
                        // `SRCH` means the group exited after membership verification; treat it as resolved rather than failing startup.
                        Err(rustix::io::Errno::SRCH) => {}
                        Err(err) => return Err(err.into()),
                    }
                }
                // The caller keeps the record after `SIGKILL` until membership drains, because surviving members could otherwise cause recovery to refire the run beside them.
                if !wait_group_empty_blocking(entry.leader_pid, SWEEP_MEMBER_GRACE)? {
                    return Err(io::Error::other(
                        "a swept group's members could not be confirmed stopped",
                    ));
                }
            }
            remove_swept_record(&path)?;
        }
        Ok(killed)
    }

    /// SIGKILL cannot be caught; members in uninterruptible kernel state can delay group removal.
    /// `SWEEP_MEMBER_GRACE` bounds the wait for uninterruptible members before startup fails closed.
    const SWEEP_MEMBER_GRACE: Duration = Duration::from_secs(5);

    /// The startup sweep runs before request work, so `wait_group_empty_blocking` may block until `budget` elapses.
    /// The startup sweep runs before request work, so blocking cannot starve requests.
    /// `group_has_members` errors propagate so an unverifiable scan never reads as empty.
    fn wait_group_empty_blocking(pgid: i32, budget: Duration) -> io::Result<bool> {
        let deadline = std::time::Instant::now() + budget;
        loop {
            if !group_has_members(pgid)? {
                return Ok(true);
            }
            if std::time::Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// `remove_swept_record` treats `NotFound` as success because the record is already absent.
    /// Any other removal error prevents the sweep from proving that the record was removed.
    fn remove_swept_record(path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// `owner_boot_tag` retains the first 16 alphanumeric characters of the boot ID for filename-safe run-directory names.
    pub(crate) fn owner_boot_tag() -> io::Result<String> {
        Ok(boot_id()?
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(16)
            .collect())
    }

    pub(crate) fn owner_start_time() -> io::Result<u64> {
        let owner_pid = std::process::id() as i32;
        proc_start_time(owner_pid)?.ok_or_else(|| io::Error::other("this process has no stat"))
    }

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

    /// `sweep_orphaned_run_dirs` removes a directory only after proving that its recorded owner is gone.
    /// (R17/R19).
    ///
    /// The sweep uses the recorded PID and start time to avoid deleting a live owner's directory.
    /// The sweep leaves unverifiable directories in place because deleting a live run's private files would break that run.
    /// disk cost.
    pub fn sweep_orphaned_run_dirs() -> io::Result<usize> {
        let root = private_run_root()?;
        let current_boot = owner_boot_tag()?;
        let mut removed = 0;
        for entry in fs::read_dir(&root)? {
            let path = entry?.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let mut fields = name.rsplitn(5, '-');
            let (Some(_nonce), Some(start), Some(pid), Some(boot)) =
                (fields.next(), fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let (Ok(pid), Ok(start)) = (pid.parse::<i32>(), start.parse::<u64>()) else {
                continue;
            };
            if boot != current_boot {
                remove_run_dir(&path, &mut removed)?;
                continue;
            }
            // Treat zombie owners as dead because they cannot use these files.
            if proc_live_start_time(pid)? == Some(start) {
                continue;
            }
            remove_run_dir(&path, &mut removed)?;
        }
        Ok(removed)
    }

    fn remove_run_dir(path: &Path, removed: &mut usize) -> io::Result<()> {
        match fs::remove_dir_all(path) {
            Ok(()) => {
                *removed += 1;
                Ok(())
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }
}
