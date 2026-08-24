//! U3 harness-boundary tests (plan `broca_subprocess` scope): exact adapter
//! argv/env/stdin contracts, private file modes, closed parser
//! vocabularies, bounded/redacted failures, and process-group reaping.
//!
//! `harness = false`: this binary re-executes itself as the OpenCode and Pi
//! stand-in executables. `MC_BROCA_FIXTURE_MODE` in the environment routes
//! `main` into a fixture behavior (argv capture, scripted NDJSON
//! transcripts, floods, hangs, signal handling, forked grandchildren, and
//! cleanup sabotage) instead of the test list — argv is fully owned by the
//! adapter under test, which the default libtest harness cannot survive.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mc_host::broca::backend::{
    BackendEvent, BackendRequest, BackendTerminal, ErrorClass, EventSink, FinishReason, Harness,
    LlmExecutionBackend, SinkStatus,
};
use mc_host::broca::opencode::{
    OpenCodeBackend, OpenCodeRuntime, MAGIC_CONTEXT_BROCA_CHILD_ENV, OPENCODE_BROCA_AGENT,
};
use mc_host::broca::pi::{
    pi_model_ref, PiBackend, PiRuntimeDescriptor, BROCA_MAX_OUTPUT_TOKENS_ENV,
    BROCA_TEMPERATURE_ENV, MAGIC_CONTEXT_PI_SUBAGENT_ENV, PI_BROCA_EXTENSION_BYTES,
    PI_BROCA_EXTENSION_FILE,
};
use mc_host::broca::protocol::SendRequest;
use mc_host::broca::subprocess::{
    merge_cleanup, CleanupFailure, EnvSnapshot, PrivateDir, SubprocessLimits,
};
use mc_host::broca::supervisor::{SessionKey, Supervisor};
use mc_host::CancellationToken;

const FIXTURE_MODE_ENV: &str = "MC_BROCA_FIXTURE_MODE";
const OUT_ENV: &str = "MC_FIXTURE_OUT";
const TRANSCRIPT_FILE_ENV: &str = "MC_FIXTURE_TRANSCRIPT_FILE";
const STDERR_ENV: &str = "MC_FIXTURE_STDERR";
const EXIT_ENV: &str = "MC_FIXTURE_EXIT";
const BEHAVIOR_ENV: &str = "MC_FIXTURE_BEHAVIOR";
const SECRET_ENV: &str = "MC_FIXTURE_SECRET";
const SABOTAGE_ENV: &str = "MC_FIXTURE_SABOTAGE_CLEANUP";
const GROUP_PID_ENV: &str = "MC_FIXTURE_GROUP_PID";

const PROMPT_SENTINEL: &str = "PROMPT-SENTINEL user text";
const SYSTEM_SENTINEL: &str = "SYSTEM-SENTINEL system role";
const CREDENTIAL_SENTINEL: &str = "credential-sentinel-value";

fn main() {
    if let Ok(mode) = std::env::var(FIXTURE_MODE_ENV) {
        fixture::run(&mode);
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let filter = args.iter().find(|arg| !arg.starts_with('-')).cloned();
    let exact = args.iter().any(|arg| arg == "--exact");
    let tests: &[(&str, fn())] = &[
        (
            "opencode_argv_env_stdin_contract",
            opencode_argv_env_stdin_contract,
        ),
        (
            "opencode_hostile_project_untouched",
            opencode_hostile_project_untouched,
        ),
        ("pi_argv_privacy_contract", pi_argv_privacy_contract),
        ("pi_provider_alias_mapping", pi_provider_alias_mapping),
        (
            "pi_alias_credential_failure_retries_canonical_provider",
            pi_alias_credential_failure_retries_canonical_provider,
        ),
        (
            "pi_project_pi_resources_ignored",
            pi_project_pi_resources_ignored,
        ),
        (
            "pi_broca_hook_owns_generation_controls",
            pi_broca_hook_owns_generation_controls,
        ),
        (
            "success_transcripts_align_across_harnesses",
            success_transcripts_align_across_harnesses,
        ),
        (
            "provider_error_metadata_preserved",
            provider_error_metadata_preserved,
        ),
        (
            "hostile_retry_delays_are_clamped",
            hostile_retry_delays_are_clamped,
        ),
        (
            "opencode_oversized_inline_config_rejected_before_spawn",
            opencode_oversized_inline_config_rejected_before_spawn,
        ),
        (
            "malformed_outputs_one_bounded_failure",
            malformed_outputs_one_bounded_failure,
        ),
        (
            "output_flood_stopped_and_redacted",
            output_flood_stopped_and_redacted,
        ),
        (
            "timeout_reaps_leader_and_grandchild",
            timeout_reaps_leader_and_grandchild,
        ),
        (
            "pi_lingering_child_drained_after_terminal",
            pi_lingering_child_drained_after_terminal,
        ),
        ("pi_auxiliary_events_ignored", pi_auxiliary_events_ignored),
        (
            "pi_agent_end_compatibility_terminal",
            pi_agent_end_compatibility_terminal,
        ),
        (
            "pi_extension_stdout_noise_skipped",
            pi_extension_stdout_noise_skipped,
        ),
        (
            "pi_tool_requesting_stop_is_not_terminal",
            pi_tool_requesting_stop_is_not_terminal,
        ),
        (
            "undelivered_prompt_rejects_clean_transcript",
            undelivered_prompt_rejects_clean_transcript,
        ),
        (
            "cancel_reaps_group_with_sigterm_first",
            cancel_reaps_group_with_sigterm_first,
        ),
        (
            "sigkill_escalation_when_term_ignored",
            sigkill_escalation_when_term_ignored,
        ),
        (
            "supervisor_delete_reaps_group",
            supervisor_delete_reaps_group,
        ),
        (
            "supervisor_shutdown_reaps_group",
            supervisor_shutdown_reaps_group,
        ),
        (
            "private_paths_forced_modes_under_umask",
            private_paths_forced_modes_under_umask,
        ),
        ("private_dir_contract", private_dir_contract),
        (
            "cleanup_failure_never_unqualified_success",
            cleanup_failure_never_unqualified_success,
        ),
        (
            "env_snapshot_strips_launch_identity",
            env_snapshot_strips_launch_identity,
        ),
        ("merge_cleanup_contract", merge_cleanup_contract),
        (
            "pi_auto_retry_supersedes_the_failed_attempts_terminal",
            pi_auto_retry_supersedes_the_failed_attempts_terminal,
        ),
        (
            "oversized_json_structure_rejected_without_capping_prose",
            oversized_json_structure_rejected_without_capping_prose,
        ),
        (
            "group_registry_sweep_kills_only_dead_owner_groups",
            group_registry_sweep_kills_only_dead_owner_groups,
        ),
    ];
    // cargo-nextest requires each `--list --format terse` output line to end in `: test`.
    if args.iter().any(|arg| arg == "--list") {
        for (name, _) in tests {
            println!("{name}: test");
        }
        return;
    }
    let mut failed = Vec::new();
    let mut ran = 0usize;
    for (name, test) in tests {
        if let Some(filter) = &filter {
            let matched = if exact {
                name == filter
            } else {
                name.contains(filter.as_str())
            };
            if !matched {
                continue;
            }
        }
        ran += 1;
        print!("test {name} ... ");
        let _ = std::io::stdout().flush();
        match std::panic::catch_unwind(test) {
            Ok(()) => println!("ok"),
            Err(_) => {
                println!("FAILED");
                failed.push(*name);
            }
        }
    }
    println!("\nbroca_subprocess: {ran} run, {} failed", failed.len());
    if !failed.is_empty() {
        for name in &failed {
            eprintln!("failed: {name}");
        }
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Fixture side: the re-executed binary standing in for opencode/pi.
// ---------------------------------------------------------------------------

mod fixture {
    use super::*;

    pub fn run(mode: &str) {
        match mode {
            "harness" => harness(),
            "grandchild" => grandchild(),
            "record_group" => record_group(),
            other => {
                eprintln!("unknown fixture mode {other}");
                std::process::exit(70);
            }
        }
    }

    /// Stands in for a host that crashes after spawning: records the given
    /// leader's group in the crash registry and exits WITHOUT running
    /// destructors, so the record survives like it would a real crash.
    fn record_group() {
        let leader: i32 = std::env::var(GROUP_PID_ENV)
            .ok()
            .and_then(|pid| pid.parse().ok())
            .expect("fixture leader pid");
        let record = mc_host::broca::subprocess::group_registry::GroupRecord::record(leader)
            .expect("record leader group");
        std::mem::forget(record);
        std::process::exit(0);
    }

    fn out_dir() -> Option<PathBuf> {
        std::env::var_os(OUT_ENV).map(PathBuf::from)
    }

    fn argv() -> Vec<String> {
        std::env::args().skip(1).collect()
    }

    fn flag_value(args: &[String], flag: &str) -> Option<PathBuf> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .map(PathBuf::from)
    }

    fn mode_bits(path: &Path) -> u32 {
        fs::symlink_metadata(path)
            .map(|meta| meta.permissions().mode() & 0o7777)
            .unwrap_or(0)
    }

    fn is_symlink(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
    }

    /// Records everything the adapter handed this child: argv, environment,
    /// stdin, cwd, pid, and copies + stat facts for the private
    /// system-prompt and bundled-hook files (they are deleted after the
    /// run, so the child's view is the only observable one).
    fn capture(out: &Path, stdin: &[u8]) {
        let args = argv();
        fs::write(
            out.join("argv.json"),
            serde_json::to_vec(&args).expect("argv serializes"),
        )
        .expect("write argv");
        let env: BTreeMap<String, String> = std::env::vars().collect();
        fs::write(
            out.join("env.json"),
            serde_json::to_vec(&env).expect("env serializes"),
        )
        .expect("write env");
        fs::write(out.join("stdin.bin"), stdin).expect("write stdin");
        fs::write(
            out.join("cwd.txt"),
            std::env::current_dir()
                .expect("cwd")
                .to_string_lossy()
                .as_bytes(),
        )
        .expect("write cwd");
        fs::write(out.join("leader.pid"), std::process::id().to_string()).expect("write pid");

        let mut stats = serde_json::Map::new();
        if let Some(path) = flag_value(&args, "--system-prompt") {
            let _ = fs::copy(&path, out.join("system-prompt.copy"));
            stats.insert("sysprompt_file_mode".into(), mode_bits(&path).into());
            stats.insert("sysprompt_file_symlink".into(), is_symlink(&path).into());
            if let Some(dir) = path.parent() {
                stats.insert("sysprompt_dir_mode".into(), mode_bits(dir).into());
                stats.insert("sysprompt_dir_symlink".into(), is_symlink(dir).into());
            }
        }
        let hook = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| *arg == "--extension")
            .filter_map(|(index, _)| args.get(index + 1))
            .next_back();
        if let Some(hook) = hook {
            let hook = PathBuf::from(hook);
            let _ = fs::copy(&hook, out.join("hook.copy"));
            stats.insert("hook_file_mode".into(), mode_bits(&hook).into());
            stats.insert("hook_file_symlink".into(), is_symlink(&hook).into());
        }
        fs::write(
            out.join("stats.json"),
            serde_json::to_vec(&serde_json::Value::Object(stats)).expect("stats serialize"),
        )
        .expect("write stats");
    }

    /// Makes the adapter's private dir undeletable: a populated directory
    /// with no owner write bit fails `remove_dir_all` (children cannot be
    /// unlinked), which is the cleanup-failure injection the tests use.
    fn sabotage_cleanup(args: &[String]) {
        let Some(private_file) = flag_value(args, "--system-prompt") else {
            return;
        };
        if let Some(dir) = private_file.parent() {
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o555));
        }
    }

    fn print_transcript_and_exit() -> ! {
        if let Some(path) = std::env::var_os(TRANSCRIPT_FILE_ENV) {
            let bytes = fs::read(path).expect("read transcript");
            std::io::stdout()
                .write_all(&bytes)
                .expect("write transcript");
        }
        if let Ok(stderr) = std::env::var(STDERR_ENV) {
            eprint!("{stderr}");
        }
        let code = std::env::var(EXIT_ENV)
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or(0);
        std::process::exit(code);
    }

    /// The Pi print-mode shutdown gap: the complete transcript is written
    /// and flushed, but the leader neither closes its pipes nor exits.
    fn print_transcript_then_hang() -> ! {
        if let Some(path) = std::env::var_os(TRANSCRIPT_FILE_ENV) {
            let bytes = fs::read(path).expect("read transcript");
            let mut stdout = std::io::stdout();
            stdout.write_all(&bytes).expect("write transcript");
            stdout.flush().expect("flush transcript");
        }
        hang();
    }

    /// A child that answers without the question: stdin is replaced with
    /// /dev/null (closing the prompt pipe's read end) before a complete,
    /// valid transcript is printed and the process exits cleanly.
    fn ignore_stdin_print_transcript() -> ! {
        let devnull = fs::File::open("/dev/null").expect("open /dev/null");
        rustix::stdio::dup2_stdin(&devnull).expect("replace stdin");
        print_transcript_and_exit();
    }

    /// Models credentials that live under the canonical provider rather
    /// than the subscription alias: the first invocation fails with a
    /// credential error and the retry (marker present) succeeds.
    fn alias_auth_retry(out: PathBuf) -> ! {
        let marker = out.join("alias-attempted");
        let lines: Vec<serde_json::Value> = if marker.exists() {
            vec![
                serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
                serde_json::json!({"type": "agent_start"}),
                serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "canonical answer"}]}}),
            ]
        } else {
            fs::write(&marker, b"1").expect("write alias marker");
            vec![
                serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
                serde_json::json!({"type": "agent_start"}),
                serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "error", "errorMessage": "No API key found for provider", "content": []}}),
            ]
        };
        let mut stdout = std::io::stdout();
        for line in lines {
            let bytes = serde_json::to_string(&line).expect("line");
            stdout.write_all(bytes.as_bytes()).expect("write line");
            stdout.write_all(b"\n").expect("write newline");
        }
        std::process::exit(0);
    }

    fn flood(secret: &str, to_stderr: bool) -> ! {
        let line = format!("{{\"type\":\"noise\",\"secret\":\"{secret}\"}}\n");
        let stdout = std::io::stdout();
        let stderr = std::io::stderr();
        loop {
            let failed = if to_stderr {
                stderr.lock().write_all(line.as_bytes()).is_err()
            } else {
                stdout.lock().write_all(line.as_bytes()).is_err()
            };
            if failed {
                break;
            }
        }
        // The pipe died under us: stay alive so only a group signal ends
        // the run, which is exactly what the flood tests assert.
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }

    fn hang() -> ! {
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }

    fn tokio_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("fixture runtime")
    }

    /// Leader that ignores SIGTERM forever: proves the SIGKILL escalation
    /// path. Writes `term-armed` once the handler is live and `got-sigterm`
    /// on each delivery.
    fn hang_ignore_term(out: Option<PathBuf>) -> ! {
        let rt = tokio_rt();
        rt.block_on(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal stream");
            if let Some(out) = &out {
                let _ = fs::write(out.join("term-armed"), b"1");
            }
            loop {
                term.recv().await;
                if let Some(out) = &out {
                    let _ = fs::write(out.join("got-sigterm"), b"1");
                }
            }
        });
        unreachable!("ignore-term loop never returns");
    }

    /// Leader that forks a grandchild into the same process group and then
    /// hangs; group termination must take both (AE6).
    fn spawn_grandchild_then_hang(out: PathBuf) -> ! {
        // The leader outlives the grandchild's exit so the SIGKILL sweep cannot race the grandchild's marker write. commentlint: allow(JUDGE)
        let rt = tokio_rt();
        rt.block_on(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("leader signal stream");
            let mut child = tokio::process::Command::new(std::env::current_exe().expect("self"))
                .env(FIXTURE_MODE_ENV, "grandchild")
                .env(OUT_ENV, &out)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn grandchild");
            fs::write(
                out.join("grandchild.pid"),
                child.id().expect("grandchild pid").to_string(),
            )
            .expect("write pid");
            term.recv().await;
            let _ = child.wait().await;
        });
        std::process::exit(0);
    }

    fn harness() {
        // Checked before the stdin drain below: this behavior models a child
        // that produces its transcript without ever consuming the prompt.
        if std::env::var(BEHAVIOR_ENV).as_deref() == Ok("ignore_stdin_print_transcript") {
            ignore_stdin_print_transcript();
        }
        let mut stdin = Vec::new();
        std::io::stdin()
            .read_to_end(&mut stdin)
            .expect("read stdin");
        let out = out_dir();
        if let Some(out) = &out {
            capture(out, &stdin);
        }
        if std::env::var_os(SABOTAGE_ENV).is_some() {
            sabotage_cleanup(&argv());
        }
        match std::env::var(BEHAVIOR_ENV).as_deref() {
            Ok("flood_stdout") => {
                flood(&std::env::var(SECRET_ENV).unwrap_or_default(), false);
            }
            Ok("flood_stderr") => {
                flood(&std::env::var(SECRET_ENV).unwrap_or_default(), true);
            }
            Ok("hang") => hang(),
            Ok("transcript_then_hang") => print_transcript_then_hang(),
            Ok("alias_auth_retry") => {
                alias_auth_retry(out.expect("alias fixture needs an out dir"));
            }
            // "ignore_stdin_print_transcript" is dispatched before the stdin
            // drain at the top of this function.
            Ok("hang_ignore_term") => hang_ignore_term(out),
            Ok("grandchild_hang") => {
                spawn_grandchild_then_hang(out.expect("grandchild fixtures need an out dir"));
            }
            _ => print_transcript_and_exit(),
        }
    }

    /// The grandchild: signals readiness, then converts one SIGTERM into a
    /// marker file so tests can prove the graceful signal reached the whole
    /// group, not only the leader.
    fn grandchild() {
        let out = PathBuf::from(std::env::var_os(OUT_ENV).expect("grandchild out dir"));
        let rt = tokio_rt();
        rt.block_on(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal stream");
            let _ = fs::write(out.join("grandchild-ready"), b"1");
            term.recv().await;
            let _ = fs::write(out.join("grandchild-sigterm"), b"1");
        });
    }
}

// ---------------------------------------------------------------------------
// Test-side helpers.
// ---------------------------------------------------------------------------

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime")
}

fn os(value: &str) -> OsString {
    OsString::from(value)
}

fn fixture_exe() -> PathBuf {
    std::env::current_exe().expect("test executable")
}

/// A daemon-startup snapshot carrying a fake provider credential (must
/// reach the child) and host launch-identity variables (must not), plus the
/// fixture control variables for this run.
fn fixture_snapshot(extra: &[(&str, &str)]) -> EnvSnapshot {
    let mut vars = vec![
        (os(FIXTURE_MODE_ENV), os("harness")),
        (os("FAKE_PROVIDER_KEY"), os(CREDENTIAL_SENTINEL)),
        (os("SUBC_MODULE_ID"), os("host-identity")),
        (os("SUBC_LAUNCH_NONCE"), os("host-nonce")),
    ];
    for (name, value) in extra {
        vars.push((os(name), os(value)));
    }
    EnvSnapshot::from_vars(vars)
}

fn collecting_sink() -> (EventSink, Arc<Mutex<Vec<BackendEvent>>>) {
    let store: Arc<Mutex<Vec<BackendEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_store = Arc::clone(&store);
    let sink = EventSink::new(Arc::new(move |event| {
        sink_store.lock().expect("sink store").push(event);
        SinkStatus::Accepted
    }));
    (sink, store)
}

fn request(
    project_root: &Path,
    harness: Harness,
    model: &str,
    system: Option<&str>,
) -> BackendRequest {
    let (provider, model) = model.split_once('/').expect("canonical model");
    BackendRequest {
        prompt: PROMPT_SENTINEL.to_owned(),
        system: system.map(ToOwned::to_owned),
        provider: provider.to_owned(),
        model: model.to_owned(),
        max_output_tokens: 32_000,
        temperature: 0.25,
        project_root: project_root.to_path_buf(),
        harness,
        session: "session-1".to_owned(),
        run_id: "run-1".to_owned(),
    }
}

fn quick_limits() -> SubprocessLimits {
    SubprocessLimits {
        run_timeout: Duration::from_secs(20),
        termination_grace: Duration::from_secs(2),
        drain_grace: Duration::from_secs(2),
        max_stdout_bytes: 4 * 1024 * 1024,
        max_stderr_bytes: 64 * 1024,
    }
}

fn write_transcript(dir: &Path, name: &str, lines: &[serde_json::Value]) -> PathBuf {
    let mut bytes = Vec::new();
    for line in lines {
        bytes.extend_from_slice(serde_json::to_string(line).expect("line").as_bytes());
        bytes.push(b'\n');
    }
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write transcript");
    path
}

fn opencode_success_lines(text: &str) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "step_start", "timestamp": 1, "sessionID": "ses_x", "part": {"type": "step-start"}}),
        serde_json::json!({"type": "text", "timestamp": 2, "sessionID": "ses_x", "part": {"type": "text", "text": text}}),
        serde_json::json!({"type": "step_finish", "timestamp": 3, "sessionID": "ses_x", "part": {"type": "step-finish", "reason": "stop", "tokens": {"input": 1, "output": 2}}}),
    ]
}

fn pi_success_lines(text: &str, stop_reason: &str) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
        serde_json::json!({"type": "agent_start"}),
        serde_json::json!({"type": "turn_start"}),
        serde_json::json!({"type": "message_start", "message": {"role": "assistant", "content": []}}),
        serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": stop_reason, "content": [{"type": "text", "text": text}]}}),
        serde_json::json!({"type": "turn_end"}),
        // Modern Pi closes with the authoritative agent_end array; the
        // subprocess terminal probe arms the drain kill only on this shape.
        serde_json::json!({"type": "agent_end", "messages": [{"role": "assistant", "stopReason": stop_reason, "content": [{"type": "text", "text": text}]}]}),
    ]
}

fn pi_error_lines(error_message: &str) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
        serde_json::json!({"type": "agent_start"}),
        serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "error", "errorMessage": error_message, "content": []}}),
    ]
}

struct RunSetup {
    out: tempfile::TempDir,
    project: tempfile::TempDir,
    scratch: tempfile::TempDir,
}

impl RunSetup {
    fn new() -> Self {
        Self {
            out: tempfile::tempdir().expect("out dir"),
            project: tempfile::tempdir().expect("project dir"),
            scratch: tempfile::tempdir().expect("scratch dir"),
        }
    }

    fn base_vars(&self) -> Vec<(String, String)> {
        vec![(
            OUT_ENV.to_owned(),
            self.out.path().to_string_lossy().into_owned(),
        )]
    }

    fn snapshot(&self, extra: &[(&str, &str)]) -> EnvSnapshot {
        let mut vars: Vec<(&str, &str)> = Vec::new();
        let base = self.base_vars();
        for (name, value) in &base {
            vars.push((name.as_str(), value.as_str()));
        }
        vars.extend_from_slice(extra);
        fixture_snapshot(&vars)
    }

    fn argv(&self) -> Vec<String> {
        serde_json::from_slice(&fs::read(self.out.path().join("argv.json")).expect("argv"))
            .expect("argv json")
    }

    fn env(&self) -> BTreeMap<String, String> {
        serde_json::from_slice(&fs::read(self.out.path().join("env.json")).expect("env"))
            .expect("env json")
    }

    fn stdin(&self) -> Vec<u8> {
        fs::read(self.out.path().join("stdin.bin")).expect("stdin")
    }

    fn stats(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.out.path().join("stats.json")).expect("stats"))
            .expect("stats json")
    }
}

fn opencode_backend(
    setup: &RunSetup,
    extra: &[(&str, &str)],
    variant_args: Vec<String>,
) -> OpenCodeBackend {
    OpenCodeBackend::with_limits(
        OpenCodeRuntime {
            executable: fixture_exe(),
            variant_args,
        },
        setup.snapshot(extra),
        quick_limits(),
    )
}

fn pi_backend(
    setup: &RunSetup,
    extra: &[(&str, &str)],
    provider_extensions: Vec<PathBuf>,
    thinking: Option<&str>,
) -> PiBackend {
    pi_backend_with_limits(setup, extra, provider_extensions, thinking, quick_limits())
}

fn pi_backend_with_limits(
    setup: &RunSetup,
    extra: &[(&str, &str)],
    provider_extensions: Vec<PathBuf>,
    thinking: Option<&str>,
    limits: SubprocessLimits,
) -> PiBackend {
    PiBackend::with_limits(
        PiRuntimeDescriptor {
            executable: fixture_exe(),
            provider_extensions,
        },
        setup.snapshot(extra),
        thinking.map(ToOwned::to_owned),
        limits,
    )
}

fn execute(
    backend: &dyn LlmExecutionBackend,
    request: BackendRequest,
) -> (BackendTerminal, Vec<BackendEvent>) {
    execute_with_cancel(backend, request, &CancellationToken::new())
}

fn execute_with_cancel(
    backend: &dyn LlmExecutionBackend,
    request: BackendRequest,
    cancel: &CancellationToken,
) -> (BackendTerminal, Vec<BackendEvent>) {
    let (sink, store) = collecting_sink();
    let terminal = rt().block_on(backend.execute(request, sink, cancel.clone()));
    let events = store.lock().expect("events").clone();
    (terminal, events)
}

fn failed(terminal: &BackendTerminal) -> &mc_host::broca::backend::BackendError {
    match terminal {
        BackendTerminal::Failed(error) => error,
        other => panic!("expected a failed terminal, got {other:?}"),
    }
}

fn assert_process_gone(pid: u32) {
    let Some(pid) = rustix::process::Pid::from_raw(i32::try_from(pid).expect("pid fits")) else {
        return;
    };
    for _ in 0..200 {
        if rustix::process::test_kill_process(pid).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("process {pid:?} is still alive");
}

/// Zero-retry leader probe: polling would also pass when the leader is
/// reaped after the lifecycle call returned. A recycled PID would make the
/// probe succeed spuriously.
fn assert_leader_already_reaped(pid: u32) {
    let Some(pid) = rustix::process::Pid::from_raw(i32::try_from(pid).expect("pid fits")) else {
        return;
    };
    assert!(
        rustix::process::test_kill_process(pid).is_err(),
        "leader {pid:?} still observable after the lifecycle call returned"
    );
}

fn read_pid(path: &Path) -> u32 {
    fs::read_to_string(path)
        .expect("pid file")
        .trim()
        .parse()
        .expect("pid parses")
}

fn wait_for_file(path: &Path, budget: Duration) {
    let deadline = Instant::now() + budget;
    while !path.exists() {
        assert!(Instant::now() < deadline, "file {path:?} never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Restores the process umask on drop so a panicking test cannot poison the
/// sequential tests that follow it.
struct UmaskGuard {
    previous: rustix::fs::Mode,
}

impl UmaskGuard {
    fn set(mask: u32) -> Self {
        Self {
            previous: rustix::process::umask(rustix::fs::Mode::from_raw_mode(mask)),
        }
    }
}

impl Drop for UmaskGuard {
    fn drop(&mut self) {
        rustix::process::umask(self.previous);
    }
}

/// Un-sabotages and removes the private dir a cleanup-failure test left
/// behind, located through the captured `--system-prompt` argv value.
fn repair_sabotaged_dir(setup: &RunSetup) {
    let args = setup.argv();
    let private_file = args
        .iter()
        .position(|arg| arg == "--system-prompt")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .expect("system prompt path captured");
    let dir = private_file.parent().expect("private dir").to_path_buf();
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    let _ = fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// OpenCode adapter contract (R15, R17, R19; KTD7).
// ---------------------------------------------------------------------------

fn opencode_argv_env_stdin_contract() {
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "success.ndjson",
        &opencode_success_lines("Hello from fixture"),
    );
    let backend = opencode_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        vec!["--variant".to_owned(), "fast".to_owned()],
    );
    let request = request(
        setup.project.path(),
        Harness::OpenCode,
        "anthropic/claude-test",
        Some(SYSTEM_SENTINEL),
    );
    let (terminal, events) = execute(&backend, request);
    assert_eq!(
        terminal,
        BackendTerminal::Completed {
            finish_reason: FinishReason::Completed
        }
    );
    assert_eq!(
        events,
        vec![BackendEvent::AssistantText {
            text: "Hello from fixture".to_owned(),
            finish_reason: None,
        }]
    );

    // Exact argv: fixed flags first, configured variant args appended.
    assert_eq!(
        setup.argv(),
        vec![
            "run",
            "--model",
            "anthropic/claude-test",
            "--agent",
            OPENCODE_BROCA_AGENT,
            "--format",
            "json",
            "--variant",
            "fast",
        ]
    );

    let env = setup.env();
    let db = PathBuf::from(env.get("OPENCODE_DB").expect("isolated db"));
    assert_eq!(db.file_name().and_then(|n| n.to_str()), Some("opencode.db"));
    let private_dir = db.parent().expect("db parent");
    assert!(
        private_dir
            .file_name()
            .and_then(|n| n.to_str())
            .expect("dir name")
            .starts_with("mc-broca-opencode-"),
        "db must live in the per-run private dir: {private_dir:?}"
    );
    assert!(
        !private_dir.exists(),
        "the private dir must be cleaned up after the run"
    );
    assert_eq!(
        env.get("OPENCODE_DISABLE_PROJECT_CONFIG")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        env.get(MAGIC_CONTEXT_BROCA_CHILD_ENV).map(String::as_str),
        Some("1")
    );
    assert_eq!(
        env.get("FAKE_PROVIDER_KEY").map(String::as_str),
        Some(CREDENTIAL_SENTINEL),
        "provider credentials from the startup snapshot must reach the child"
    );
    assert!(!env.contains_key("SUBC_MODULE_ID"));
    assert!(!env.contains_key("SUBC_LAUNCH_NONCE"));

    let config: serde_json::Value =
        serde_json::from_str(env.get("OPENCODE_CONFIG_CONTENT").expect("inline config"))
            .expect("config parses");
    let agent = &config["agent"][OPENCODE_BROCA_AGENT];
    assert_eq!(agent["mode"], "primary");
    assert_eq!(agent["tools"], serde_json::json!({"*": false}));
    assert_eq!(agent["prompt"], SYSTEM_SENTINEL);
    assert_eq!(agent["temperature"], 0.25);
    assert_eq!(
        config["provider"]["anthropic"]["models"]["claude-test"]["limit"]["output"],
        32_000
    );

    assert_eq!(setup.stdin(), PROMPT_SENTINEL.as_bytes());
    let cwd = fs::read_to_string(setup.out.path().join("cwd.txt")).expect("cwd");
    assert_eq!(PathBuf::from(cwd), setup.project.path());
}

fn opencode_hostile_project_untouched() {
    let setup = RunSetup::new();
    let hostile_config = setup.project.path().join("opencode.json");
    let hostile_plugin_dir = setup.project.path().join(".opencode/plugin");
    fs::create_dir_all(&hostile_plugin_dir).expect("hostile dir");
    let hostile_plugin = hostile_plugin_dir.join("evil.js");
    let hostile_db = setup.project.path().join("opencode.db");
    fs::write(&hostile_config, br#"{"agent":{"evil":{}}}"#).expect("hostile config");
    fs::write(&hostile_plugin, b"throw new Error('evil')").expect("hostile plugin");
    fs::write(&hostile_db, b"ordinary user database bytes").expect("hostile db");

    let transcript = write_transcript(
        setup.scratch.path(),
        "success.ndjson",
        &opencode_success_lines("ok"),
    );
    let backend = opencode_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        Vec::new(),
    );
    let request = request(
        setup.project.path(),
        Harness::OpenCode,
        "anthropic/claude-test",
        None,
    );
    let (terminal, _) = execute(&backend, request);
    assert!(matches!(terminal, BackendTerminal::Completed { .. }));

    // The hostile project state is byte-identical and the child was pointed
    // entirely elsewhere (AE11).
    assert_eq!(
        fs::read(&hostile_config).expect("config"),
        br#"{"agent":{"evil":{}}}"#
    );
    assert_eq!(
        fs::read(&hostile_plugin).expect("plugin"),
        b"throw new Error('evil')"
    );
    assert_eq!(
        fs::read(&hostile_db).expect("db"),
        b"ordinary user database bytes"
    );
    let env = setup.env();
    assert!(
        !env.get("OPENCODE_DB")
            .expect("db")
            .starts_with(&setup.project.path().to_string_lossy().into_owned()),
        "the isolated db must not live in the project"
    );
    assert_eq!(
        env.get("OPENCODE_DISABLE_PROJECT_CONFIG")
            .map(String::as_str),
        Some("1")
    );
    // No system prompt: the zero-tool agent config must omit the key
    // rather than carry an empty role.
    let config: serde_json::Value =
        serde_json::from_str(env.get("OPENCODE_CONFIG_CONTENT").expect("config"))
            .expect("config parses");
    assert!(config["agent"][OPENCODE_BROCA_AGENT]
        .get("prompt")
        .is_none());
}

// ---------------------------------------------------------------------------
// Pi adapter contract (R16, R17, R19; KTD8).
// ---------------------------------------------------------------------------

fn pi_argv_privacy_contract() {
    let setup = RunSetup::new();
    let provider_a = setup.scratch.path().join("provider-a.js");
    let provider_b = setup.scratch.path().join("provider-b.js");
    fs::write(&provider_a, b"// provider a").expect("ext a");
    fs::write(&provider_b, b"// provider b").expect("ext b");
    let transcript = write_transcript(
        setup.scratch.path(),
        "success.ndjson",
        &pi_success_lines("hi", "stop"),
    );
    let backend = pi_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        vec![provider_a.clone(), provider_b.clone()],
        Some("low"),
    );
    let request = request(
        setup.project.path(),
        Harness::Pi,
        "openai/gpt-5-test",
        Some(SYSTEM_SENTINEL),
    );
    let (terminal, events) = execute(&backend, request);
    assert!(matches!(terminal, BackendTerminal::Completed { .. }));
    assert_eq!(events.len(), 1);

    let args = setup.argv();
    assert_eq!(
        args[..9],
        [
            "--print",
            "--mode",
            "json",
            "--no-session",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-tools",
            "--no-approve",
        ]
    );
    assert_eq!(args[9], "--no-extensions");
    // Descriptor extensions in order, bundled hook LAST (R16, KTD8).
    let extensions: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| *arg == "--extension")
        .filter_map(|(index, _)| args.get(index + 1))
        .collect();
    assert_eq!(extensions.len(), 3);
    assert_eq!(extensions[0], &provider_a.to_string_lossy());
    assert_eq!(extensions[1], &provider_b.to_string_lossy());
    assert!(extensions[2].ends_with(PI_BROCA_EXTENSION_FILE));
    // Known provider alias translation happens at the argv edge (openai ->
    // openai-codex), never in the canonical request.
    let model_index = args
        .iter()
        .position(|arg| arg == "--model")
        .expect("model flag");
    assert_eq!(args[model_index + 1], "openai-codex/gpt-5-test");
    let thinking_index = args
        .iter()
        .position(|arg| arg == "--thinking")
        .expect("thinking flag");
    assert_eq!(args[thinking_index + 1], "low");
    // The prompt rides stdin only: no positional message may follow the
    // final flag value.
    assert_eq!(args.last().map(String::as_str), Some("low"));
    assert!(!args.iter().any(|arg| arg.contains(PROMPT_SENTINEL)));
    assert_eq!(setup.stdin(), PROMPT_SENTINEL.as_bytes());

    // The private system prompt and materialized hook are the compiled-in
    // bytes at owner-only modes (R17, KTD8).
    assert_eq!(
        fs::read(setup.out.path().join("system-prompt.copy")).expect("system copy"),
        SYSTEM_SENTINEL.as_bytes()
    );
    assert_eq!(
        fs::read(setup.out.path().join("hook.copy")).expect("hook copy"),
        PI_BROCA_EXTENSION_BYTES
    );
    let stats = setup.stats();
    assert_eq!(stats["sysprompt_file_mode"], 0o600);
    assert_eq!(stats["sysprompt_dir_mode"], 0o700);
    assert_eq!(stats["hook_file_mode"], 0o600);
    assert_eq!(stats["sysprompt_file_symlink"], false);
    assert_eq!(stats["sysprompt_dir_symlink"], false);

    let env = setup.env();
    assert_eq!(
        env.get(MAGIC_CONTEXT_PI_SUBAGENT_ENV).map(String::as_str),
        Some("1")
    );
    assert_eq!(
        env.get(BROCA_MAX_OUTPUT_TOKENS_ENV).map(String::as_str),
        Some("32000")
    );
    assert_eq!(
        env.get(BROCA_TEMPERATURE_ENV).map(String::as_str),
        Some("0.25")
    );
    assert_eq!(
        env.get("FAKE_PROVIDER_KEY").map(String::as_str),
        Some(CREDENTIAL_SENTINEL)
    );
    assert!(!env.contains_key("SUBC_MODULE_ID"));
    assert!(!env.contains_key("SUBC_LAUNCH_NONCE"));

    // The private dir is gone after the run.
    let private_dir = PathBuf::from(extensions[2])
        .parent()
        .expect("dir")
        .to_path_buf();
    assert!(!private_dir.exists());
}

fn pi_provider_alias_mapping() {
    assert_eq!(pi_model_ref("openai", "gpt-5"), "openai-codex/gpt-5");
    assert_eq!(
        pi_model_ref("google", "gemini-x"),
        "google-antigravity/gemini-x"
    );
    // Unknown providers pass through unchanged.
    assert_eq!(pi_model_ref("acme", "foo"), "acme/foo");
    assert_eq!(pi_model_ref("anthropic", "claude"), "anthropic/claude");

    // Prove the translated and preserved forms reach argv, not only the
    // pure mapping helper.
    for (model, expected) in [
        ("google/gemini-x", "google-antigravity/gemini-x"),
        ("acme/foo", "acme/foo"),
    ] {
        let setup = RunSetup::new();
        let transcript = write_transcript(
            setup.scratch.path(),
            "success.ndjson",
            &pi_success_lines("hi", "stop"),
        );
        let backend = pi_backend(
            &setup,
            &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
            Vec::new(),
            None,
        );
        let request = request(setup.project.path(), Harness::Pi, model, None);
        let (terminal, _) = execute(&backend, request);
        assert!(matches!(terminal, BackendTerminal::Completed { .. }));
        let args = setup.argv();
        let model_index = args.iter().position(|arg| arg == "--model").expect("model");
        assert_eq!(args[model_index + 1], expected, "model {model}");
        // Without a configured thinking level the flag is absent.
        assert!(!args.iter().any(|arg| arg == "--thinking"));
        // Without a system prompt no private prompt file is passed.
        assert!(!args.iter().any(|arg| arg == "--system-prompt"));
    }
}

fn pi_project_pi_resources_ignored() {
    let setup = RunSetup::new();
    let pi_dir = setup.project.path().join(".pi/extensions");
    fs::create_dir_all(&pi_dir).expect("project .pi");
    let hostile_settings = setup.project.path().join(".pi/settings.json");
    let hostile_extension = pi_dir.join("hostile.js");
    fs::write(&hostile_settings, br#"{"extensions":["hostile.js"]}"#).expect("settings");
    fs::write(&hostile_extension, b"// hostile").expect("hostile ext");

    let transcript = write_transcript(
        setup.scratch.path(),
        "success.ndjson",
        &pi_success_lines("hi", "stop"),
    );
    let backend = pi_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        Vec::new(),
        None,
    );
    let request = request(setup.project.path(), Harness::Pi, "acme/foo", None);
    let (terminal, _) = execute(&backend, request);
    assert!(matches!(terminal, BackendTerminal::Completed { .. }));

    let args = setup.argv();
    // Discovery stays disabled and no project-owned path is loaded (AE12):
    // the only --extension value is the bundled hook.
    assert!(args.iter().any(|arg| arg == "--no-extensions"));
    assert!(args.iter().any(|arg| arg == "--no-approve"));
    let extensions: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| *arg == "--extension")
        .filter_map(|(index, _)| args.get(index + 1))
        .collect();
    assert_eq!(extensions.len(), 1);
    assert!(extensions[0].ends_with(PI_BROCA_EXTENSION_FILE));
    assert!(!args
        .iter()
        .any(|arg| arg.contains(&*setup.project.path().join(".pi").to_string_lossy())));
    // Project files stay byte-identical.
    assert_eq!(
        fs::read(&hostile_settings).expect("settings"),
        br#"{"extensions":["hostile.js"]}"#
    );
    assert_eq!(fs::read(&hostile_extension).expect("ext"), b"// hostile");
    // The Magic Context guard is set, so full plugin startup cannot run.
    assert_eq!(
        setup
            .env()
            .get(MAGIC_CONTEXT_PI_SUBAGENT_ENV)
            .map(String::as_str),
        Some("1")
    );
}

/// Runs the bundled hook's `before_provider_request` logic under a real
/// JavaScript runtime (node, falling back to bun) with a fixture provider
/// extension registered FIRST — mirroring Pi's load-ordered handler chain —
/// and asserts the hook rewrites, preserves, and rejects as specified.
fn pi_broca_hook_owns_generation_controls() {
    let scratch = tempfile::tempdir().expect("scratch");
    let hook_path = scratch.path().join(PI_BROCA_EXTENSION_FILE);
    fs::write(&hook_path, PI_BROCA_EXTENSION_BYTES).expect("materialize hook");
    let driver_path = scratch.path().join("driver.mjs");
    // The apply() chain below models the docs-specified handler semantics (returned value replaces the payload, undefined keeps it) from packages/pi-plugin/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md#before_provider_request. commentlint: allow(JUDGE)
    let driver = format!(
        r#"import hook from "file://{hook}";
const handlers = [];
const pi = {{ on(name, fn) {{ if (name === "before_provider_request") handlers.push(fn); }} }};
// Fixture provider extension: registered first, rewrites the payload first.
handlers.push((event) => ({{ ...event.payload, temperature: 9, providerTouched: true }}));
hook(pi);
function apply(payload) {{
  let event = {{ payload }};
  for (const handler of handlers) {{
    const replaced = handler(event);
    if (replaced !== undefined) event = {{ payload: replaced }};
  }}
  return event.payload;
}}
console.log(JSON.stringify(apply({{ model: "m", max_tokens: 4096, temperature: 0.7, messages: [], keep: "yes" }})));
console.log(JSON.stringify(apply({{ contents: [], generationConfig: {{ maxOutputTokens: 999, temperature: 1.9, topK: 3 }}, keep: "g" }})));
console.log(JSON.stringify(apply({{ model: "m", max_completion_tokens: 8192, max_tokens: 4096, messages: [] }})));
try {{ apply({{ foo: "bar" }}); console.log("ACCEPTED"); }} catch {{ console.log("REJECTED"); }}
"#,
        hook = hook_path.to_string_lossy()
    );
    fs::write(&driver_path, driver).expect("driver");

    let output = ["node", "bun"]
        .iter()
        .find_map(|runtime| {
            std::process::Command::new(runtime)
                .arg(&driver_path)
                .env(BROCA_MAX_OUTPUT_TOKENS_ENV, "32000")
                .env(BROCA_TEMPERATURE_ENV, "0.25")
                .output()
                .ok()
        })
        .expect("a JavaScript runtime (node or bun) is required for the hook fixture");
    assert!(
        output.status.success(),
        "hook driver failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("driver output");
    let mut lines = stdout.lines();

    // OpenAI-style shape: the hook replaces the provider extension's values
    // and preserves every unrelated field.
    let openai: serde_json::Value =
        serde_json::from_str(lines.next().expect("openai line")).expect("openai json");
    assert_eq!(openai["max_tokens"], 32_000);
    assert_eq!(openai["temperature"], 0.25);
    assert_eq!(openai["keep"], "yes");
    assert_eq!(openai["model"], "m");
    assert_eq!(openai["providerTouched"], true);

    // Gemini-style shape: replacement happens inside generationConfig,
    // sibling config fields survive.
    let gemini: serde_json::Value =
        serde_json::from_str(lines.next().expect("gemini line")).expect("gemini json");
    assert_eq!(gemini["generationConfig"]["maxOutputTokens"], 32_000);
    assert_eq!(gemini["generationConfig"]["temperature"], 0.25);
    assert_eq!(gemini["generationConfig"]["topK"], 3);
    assert_eq!(gemini["keep"], "g");

    // Ambiguous shape: every recognized spelling is capped, so no earlier
    // extension's larger limit survives in the field the provider honors.
    let mixed: serde_json::Value =
        serde_json::from_str(lines.next().expect("mixed line")).expect("mixed json");
    assert_eq!(mixed["max_completion_tokens"], 32_000);
    assert_eq!(mixed["max_tokens"], 32_000);
    assert_eq!(mixed["temperature"], 0.25);

    // Unknown shape: rejected, never silently uncapped.
    assert_eq!(lines.next(), Some("REJECTED"));
}

// ---------------------------------------------------------------------------
// Parser vocabulary and canonical metadata (R18).
// ---------------------------------------------------------------------------

fn success_transcripts_align_across_harnesses() {
    const ANSWER: &str = "The canonical answer";
    let oc_setup = RunSetup::new();
    let oc_transcript = write_transcript(
        oc_setup.scratch.path(),
        "success.ndjson",
        &opencode_success_lines(ANSWER),
    );
    let oc_backend = opencode_backend(
        &oc_setup,
        &[(TRANSCRIPT_FILE_ENV, &oc_transcript.to_string_lossy())],
        Vec::new(),
    );
    let (oc_terminal, oc_events) = execute(
        &oc_backend,
        request(
            oc_setup.project.path(),
            Harness::OpenCode,
            "anthropic/claude-test",
            None,
        ),
    );

    let pi_setup = RunSetup::new();
    let pi_transcript = write_transcript(
        pi_setup.scratch.path(),
        "success.ndjson",
        &pi_success_lines(ANSWER, "stop"),
    );
    let pi_backend = pi_backend(
        &pi_setup,
        &[(TRANSCRIPT_FILE_ENV, &pi_transcript.to_string_lossy())],
        Vec::new(),
        None,
    );
    let (pi_terminal, pi_events) = execute(
        &pi_backend,
        request(
            pi_setup.project.path(),
            Harness::Pi,
            "anthropic/claude-test",
            None,
        ),
    );

    // Identical canonical text and completion metadata from both harness
    // wire families.
    assert_eq!(oc_terminal, pi_terminal);
    assert_eq!(oc_events, pi_events);
    assert_eq!(
        oc_events,
        vec![BackendEvent::AssistantText {
            text: ANSWER.to_owned(),
            finish_reason: None,
        }]
    );
}

fn run_opencode_transcript(lines: &[serde_json::Value]) -> (BackendTerminal, Vec<BackendEvent>) {
    let setup = RunSetup::new();
    let transcript = write_transcript(setup.scratch.path(), "t.ndjson", lines);
    let backend = opencode_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        Vec::new(),
    );
    execute(
        &backend,
        request(
            setup.project.path(),
            Harness::OpenCode,
            "anthropic/claude-test",
            None,
        ),
    )
}

fn run_pi_transcript(lines: &[serde_json::Value]) -> (BackendTerminal, Vec<BackendEvent>) {
    let setup = RunSetup::new();
    let transcript = write_transcript(setup.scratch.path(), "t.ndjson", lines);
    let backend = pi_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        Vec::new(),
        None,
    );
    execute(
        &backend,
        request(
            setup.project.path(),
            Harness::Pi,
            "anthropic/claude-test",
            None,
        ),
    )
}

fn provider_error_metadata_preserved() {
    // Transient rate limit with an explicit retry delay (AE13).
    let (terminal, _) = run_opencode_transcript(&[serde_json::json!({
        "type": "error",
        "timestamp": 1,
        "sessionID": "ses_x",
        "error": {"name": "APIError", "data": {"message": "Rate limit exceeded", "statusCode": 429, "retryAfter": 120, "isRetryable": true}},
    })]);
    let error = failed(&terminal);
    assert_eq!(error.class, ErrorClass::Transient);
    assert_eq!(error.retry_after_secs, Some(120));
    assert_eq!(error.provider_code.as_deref(), Some("APIError"));
    // Provider text steers classification but never rides the wire (R19):
    // the emitted message is host-authored and structural.
    assert!(
        !error.message.contains("Rate limit exceeded"),
        "provider text must not be forwarded: {:?}",
        error.message
    );
    assert!(error.message.contains("status 429"));

    // Authentication failure by status code.
    let (terminal, _) = run_opencode_transcript(&[serde_json::json!({
        "type": "error",
        "error": {"name": "APIError", "data": {"message": "Invalid credentials", "statusCode": 401}},
    })]);
    assert_eq!(failed(&terminal).class, ErrorClass::AuthRequired);

    // Permanent provider rejection.
    let (terminal, _) = run_opencode_transcript(&[serde_json::json!({
        "type": "error",
        "error": {"name": "BadRequestError", "data": {"message": "model does not exist"}},
    })]);
    let error = failed(&terminal);
    assert_eq!(error.class, ErrorClass::Permanent);
    assert_eq!(error.retry_after_secs, None);

    // A length-capped completion is a completion, not an error (AE13); the
    // exact length-class spelling survives.
    let (terminal, events) = run_opencode_transcript(&[
        serde_json::json!({"type": "text", "part": {"type": "text", "text": "truncated"}}),
        serde_json::json!({"type": "step_finish", "part": {"type": "step-finish", "reason": "length"}}),
    ]);
    assert_eq!(
        terminal,
        BackendTerminal::Completed {
            finish_reason: FinishReason::Length
        }
    );
    assert_eq!(events.len(), 1);

    // Pi length cap: the unit carries the length-class step reason the
    // producer's `length_capped` detection reads.
    let (terminal, events) = run_pi_transcript(&pi_success_lines("truncated", "length"));
    assert_eq!(
        terminal,
        BackendTerminal::Completed {
            finish_reason: FinishReason::Length
        }
    );
    assert_eq!(
        events,
        vec![BackendEvent::AssistantText {
            text: "truncated".to_owned(),
            finish_reason: Some(FinishReason::Length),
        }]
    );

    // Pi context overflow classified from the provider message.
    let (terminal, _) = run_pi_transcript(&pi_error_lines(
        "prompt is too long: maximum context exceeded",
    ));
    assert_eq!(failed(&terminal).class, ErrorClass::ContextOverflow);

    // Pi transient failure with parsed retry delay.
    let (terminal, _) = run_pi_transcript(&pi_error_lines(
        "provider overloaded, retry after 45 seconds",
    ));
    let error = failed(&terminal);
    assert_eq!(error.class, ErrorClass::Transient);
    assert_eq!(error.retry_after_secs, Some(45));

    // Pi auth failure classified from the provider message.
    let (terminal, _) = run_pi_transcript(&pi_error_lines("No API key found for openai-codex"));
    assert_eq!(failed(&terminal).class, ErrorClass::AuthRequired);
}

/// Provider-supplied retry delays clamp to 3600 seconds: the text and the
/// `retryAfter` field are untrusted inputs.
fn hostile_retry_delays_are_clamped() {
    let (terminal, _) = run_opencode_transcript(&[serde_json::json!({
        "type": "error",
        "error": {"name": "APIError", "data": {"message": "Rate limit exceeded", "statusCode": 429, "retryAfter": 99_999_999_999u64, "isRetryable": true}},
    })]);
    assert_eq!(failed(&terminal).retry_after_secs, Some(3600));

    let (terminal, _) = run_opencode_transcript(&[serde_json::json!({
        "type": "error",
        "error": {"name": "APIError", "data": {"message": "overloaded, retrying after 99999999999 seconds"}},
    })]);
    assert_eq!(failed(&terminal).retry_after_secs, Some(3600));

    let (terminal, _) = run_pi_transcript(&pi_error_lines(
        "provider overloaded, retry after 99999999999 seconds",
    ));
    assert_eq!(failed(&terminal).retry_after_secs, Some(3600));

    // A sane delay under the ceiling passes through unclamped.
    let (terminal, _) = run_pi_transcript(&pi_error_lines("overloaded, retry after 45 seconds"));
    assert_eq!(failed(&terminal).retry_after_secs, Some(45));

    // A number that merely follows the word "retry" without an explicit
    // delay form is a request id or status reference, never a durable
    // backoff.
    let (terminal, _) = run_pi_transcript(&pi_error_lines(
        "temporarily overloaded, please retry. request id 8412345",
    ));
    assert_eq!(failed(&terminal).retry_after_secs, None);

    // Units convert: minutes scale to seconds.
    let (terminal, _) = run_pi_transcript(&pi_error_lines("rate limited, retry in 2 minutes"));
    assert_eq!(failed(&terminal).retry_after_secs, Some(120));
}

/// A contract-valid send can carry a `system` prompt whose inline OpenCode
/// config exceeds Linux's per-env-string MAX_ARG_STRLEN; the adapter must
/// reject it with a structured message before any child exists.
fn opencode_oversized_inline_config_rejected_before_spawn() {
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "success.ndjson",
        &opencode_success_lines("never reached"),
    );
    let backend = opencode_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
        Vec::new(),
    );
    let oversized_system = "s".repeat(mc_host::broca::config::MAX_OPENCODE_CONFIG_BYTES + 1);
    let request = request(
        setup.project.path(),
        Harness::OpenCode,
        "anthropic/claude-test",
        Some(&oversized_system),
    );
    let (terminal, events) = execute(&backend, request);
    let error = failed(&terminal);
    assert_eq!(error.class, ErrorClass::Permanent);
    assert!(
        error.message.contains("environment-string ceiling"),
        "{:?}",
        error.message
    );
    assert!(
        !error.message.contains("ssss"),
        "the oversized system prompt must not leak into the diagnostic"
    );
    assert!(events.is_empty());
    assert!(
        !setup.out.path().join("argv.json").exists(),
        "the rejection must land before any child was spawned"
    );
}

fn malformed_outputs_one_bounded_failure() {
    const LINE_SECRET: &str = "SECRET-LINE-SENTINEL";

    let assert_bounded = |terminal: &BackendTerminal, needle: &str| {
        let error = failed(terminal);
        assert!(
            error.message.contains(needle),
            "expected {needle:?} in {:?}",
            error.message
        );
        assert!(
            !error.message.contains(LINE_SECRET),
            "raw output leaked into diagnostics"
        );
        assert!(
            !error.message.contains(PROMPT_SENTINEL),
            "prompt leaked into diagnostics"
        );
        assert!(error.message.len() < 300, "diagnostic is unbounded");
    };

    // Malformed JSON after valid text (AE10).
    let setup = RunSetup::new();
    let path = setup.scratch.path().join("malformed.ndjson");
    fs::write(
        &path,
        format!(
            "{}\n{LINE_SECRET} not json {{\n",
            serde_json::json!({"type": "text", "part": {"type": "text", "text": "ok"}})
        ),
    )
    .expect("transcript");
    let backend = opencode_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &path.to_string_lossy())],
        Vec::new(),
    );
    let (terminal, _) = execute(
        &backend,
        request(setup.project.path(), Harness::OpenCode, "anthropic/m", None),
    );
    assert_bounded(&terminal, "malformed json at line 2");

    // Non-UTF-8 output.
    let setup = RunSetup::new();
    let path = setup.scratch.path().join("binary.ndjson");
    fs::write(&path, [0xFF, 0xFE, 0x00, b'\n']).expect("transcript");
    let backend = opencode_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &path.to_string_lossy())],
        Vec::new(),
    );
    let (terminal, _) = execute(
        &backend,
        request(setup.project.path(), Harness::OpenCode, "anthropic/m", None),
    );
    assert_bounded(&terminal, "non-utf8 output at line 1");

    // Early EOF: a clean exit with no terminal event.
    let (terminal, _) = run_pi_transcript(&pi_success_lines("hi", "stop")[..4]);
    assert_bounded(&terminal, "without a terminal event");

    // Nonzero exit beats even a complete transcript.
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "t.ndjson",
        &opencode_success_lines("ok"),
    );
    let backend = opencode_backend(
        &setup,
        &[
            (TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy()),
            (EXIT_ENV, "3"),
        ],
        Vec::new(),
    );
    let (terminal, _) = execute(
        &backend,
        request(setup.project.path(), Harness::OpenCode, "anthropic/m", None),
    );
    assert_bounded(&terminal, "exited with status 3");

    // Contradictory terminals: success then error.
    let mut lines = opencode_success_lines("ok");
    lines.push(serde_json::json!({
        "type": "error",
        "error": {"name": "APIError", "data": {"message": "late failure"}},
    }));
    let (terminal, _) = run_opencode_transcript(&lines);
    assert_bounded(&terminal, "contradictory terminal");

    // Content after the terminal: a settled run cannot grow its answer.
    let mut lines = opencode_success_lines("ok");
    lines.push(serde_json::json!({
        "type": "text",
        "timestamp": 4,
        "sessionID": "ses_x",
        "part": {"type": "text", "text": "post-terminal smuggle"},
    }));
    let (terminal, _) = run_opencode_transcript(&lines);
    assert_bounded(&terminal, "text event after the terminal at line 4");

    // A tool invocation in a zero-tool run is a contract failure, not
    // lifecycle metadata.
    let mut lines = opencode_success_lines("ok");
    lines.insert(
        1,
        serde_json::json!({
            "type": "tool_use",
            "timestamp": 2,
            "sessionID": "ses_x",
            "part": {"type": "tool-use", "name": "read"},
        }),
    );
    let (terminal, _) = run_opencode_transcript(&lines);
    assert_bounded(&terminal, "tool_use event in a tool-less run at line 2");

    // Unknown event types fail closed (risk table: JSON vocabulary drift).
    let (terminal, _) = run_pi_transcript(&[serde_json::json!({"type": "wire_novelty"})]);
    assert_bounded(&terminal, "unknown event type at line 1");

    // Pi tool activity in a zero-tool run is a contract failure, matching
    // the OpenCode tool_use rule.
    let mut lines = pi_success_lines("tooled", "stop");
    lines.insert(
        2,
        serde_json::json!({"type": "tool_execution_start", "toolCallId": "t1", "toolName": "read", "args": {}}),
    );
    let (terminal, _) = run_pi_transcript(&lines);
    assert_bounded(
        &terminal,
        "tool execution event in a tool-less run at line 3",
    );
}

fn output_flood_stopped_and_redacted() {
    const FLOOD_SECRET: &str = "FLOOD-SECRET-SENTINEL";
    for behavior in ["flood_stdout", "flood_stderr"] {
        let setup = RunSetup::new();
        let limits = SubprocessLimits {
            run_timeout: Duration::from_secs(30),
            termination_grace: Duration::from_secs(2),
            drain_grace: Duration::from_millis(200),
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 16 * 1024,
        };
        let backend = pi_backend_with_limits(
            &setup,
            &[(BEHAVIOR_ENV, behavior), (SECRET_ENV, FLOOD_SECRET)],
            Vec::new(),
            None,
            limits,
        );
        let started = Instant::now();
        let (terminal, _) = execute(
            &backend,
            request(setup.project.path(), Harness::Pi, "anthropic/m", None),
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(20),
            "{behavior}: the flood was stopped by the byte bound, not the timeout ({elapsed:?})"
        );
        let error = failed(&terminal);
        assert!(
            error.message.contains("bounded output limit"),
            "{behavior}: {:?}",
            error.message
        );
        assert!(!error.message.contains(FLOOD_SECRET));
        assert!(!error.message.contains(PROMPT_SENTINEL));
        // The leader is reaped before execute resolves.
        assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
    }
}

// ---------------------------------------------------------------------------
// Process-group lifecycle (R10, R17; KTD6).
// ---------------------------------------------------------------------------

fn timeout_reaps_leader_and_grandchild() {
    let setup = RunSetup::new();
    let limits = SubprocessLimits {
        run_timeout: Duration::from_millis(1500),
        termination_grace: Duration::from_secs(2),
        drain_grace: Duration::from_millis(200),
        max_stdout_bytes: 1024 * 1024,
        max_stderr_bytes: 64 * 1024,
    };
    let backend = pi_backend_with_limits(
        &setup,
        &[(BEHAVIOR_ENV, "grandchild_hang")],
        Vec::new(),
        None,
        limits,
    );
    let (terminal, _) = execute(
        &backend,
        request(setup.project.path(), Harness::Pi, "anthropic/m", None),
    );
    let error = failed(&terminal);
    assert!(error.message.contains("timed out"), "{:?}", error.message);
    assert_eq!(error.class, ErrorClass::Transient);
    assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
    assert_process_gone(read_pid(&setup.out.path().join("grandchild.pid")));
}

/// A Pi child that finishes its transcript but never closes its pipes (the
/// print-mode shutdown gap) ends as a drain kill carrying the completed
/// answer, not a run-timeout failure that discards it.
fn pi_lingering_child_drained_after_terminal() {
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "linger.ndjson",
        &pi_success_lines("late exit", "stop"),
    );
    let limits = SubprocessLimits {
        run_timeout: Duration::from_secs(30),
        termination_grace: Duration::from_secs(2),
        drain_grace: Duration::from_millis(200),
        max_stdout_bytes: 1024 * 1024,
        max_stderr_bytes: 64 * 1024,
    };
    let backend = pi_backend_with_limits(
        &setup,
        &[
            (TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy()),
            (BEHAVIOR_ENV, "transcript_then_hang"),
        ],
        Vec::new(),
        None,
        limits,
    );
    let started = Instant::now();
    let (terminal, events) = execute(
        &backend,
        request(setup.project.path(), Harness::Pi, "anthropic/m", None),
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "the drain grace, not the run timeout, must end the lingering child ({:?})",
        started.elapsed()
    );
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "late exit")
    ));
    assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
}

/// Pi's documented auxiliary print-mode events (thinking, retry, queue,
/// tool, compaction, and session-state notifications) ride alongside the
/// decisive transcript on ordinary runs and must not fail it.
fn pi_auxiliary_events_ignored() {
    let mut lines = pi_success_lines("aux answer", "stop");
    lines.insert(
        2,
        serde_json::json!({"type": "thinking_level_changed", "thinkingLevel": "high"}),
    );
    lines.insert(
        3,
        serde_json::json!({"type": "queue_update", "steering": [], "followUp": []}),
    );
    lines.insert(
        4,
        serde_json::json!({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 10, "errorMessage": "overloaded"}),
    );
    lines.insert(
        5,
        serde_json::json!({"type": "auto_retry_end", "success": true, "attempt": 1}),
    );
    lines.insert(6, serde_json::json!({"type": "session_info_changed"}));
    lines.insert(
        7,
        serde_json::json!({"type": "message_update", "message": {"role": "assistant", "content": []}}),
    );
    lines.push(serde_json::json!({"type": "agent_end", "messages": []}));
    let (terminal, events) = run_pi_transcript(&lines);
    assert!(
        matches!(
            terminal,
            BackendTerminal::Completed {
                finish_reason: FinishReason::Completed
            }
        ),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "aux answer")
    ));
}

/// An older Pi delivers its final assistant state only in `agent_end`'s
/// authoritative messages array; the parser accepts that compatibility
/// shape, and when both spellings appear the `agent_end` decision replaces
/// the provisional `message_end` one.
fn pi_agent_end_compatibility_terminal() {
    let (terminal, events) = run_pi_transcript(&[
        serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
        serde_json::json!({"type": "agent_start"}),
        serde_json::json!({"type": "agent_end", "messages": [
            {"role": "user", "content": [{"type": "text", "text": "q"}]},
            {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "compat answer"}]},
        ]}),
    ]);
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "compat answer")
    ));

    // Both spellings, differing final state: agent_end is authoritative.
    let mut lines = pi_success_lines("provisional answer", "stop");
    lines.push(serde_json::json!({"type": "agent_end", "messages": [
        {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "authoritative answer"}]},
    ]}));
    let (terminal, events) = run_pi_transcript(&lines);
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "authoritative answer")
    ));
    assert!(!events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "provisional answer")
    ));
}

/// Co-loaded provider extensions write plain-text banners to Pi's stdout;
/// lines that do not claim to be JSON are noise, while a line that starts
/// with `{` but fails to parse still fails the run closed.
fn pi_extension_stdout_noise_skipped() {
    let setup = RunSetup::new();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"[Worker] Ready\n");
    for line in pi_success_lines("noisy answer", "stop") {
        bytes.extend_from_slice(serde_json::to_string(&line).expect("line").as_bytes());
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(b"provider banner: shutting down\n");
    let path = setup.scratch.path().join("noisy.ndjson");
    fs::write(&path, bytes).expect("transcript");
    let backend = pi_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &path.to_string_lossy())],
        Vec::new(),
        None,
    );
    let (terminal, events) = execute(
        &backend,
        request(setup.project.path(), Harness::Pi, "anthropic/m", None),
    );
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "noisy answer")
    ));

    // A malformed line that claims to be a JSON event is corruption, not
    // noise.
    let setup = RunSetup::new();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"{broken json\n");
    for line in pi_success_lines("unreached", "stop") {
        bytes.extend_from_slice(serde_json::to_string(&line).expect("line").as_bytes());
        bytes.push(b'\n');
    }
    let path = setup.scratch.path().join("claimed.ndjson");
    fs::write(&path, bytes).expect("transcript");
    let backend = pi_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &path.to_string_lossy())],
        Vec::new(),
        None,
    );
    let (terminal, _) = execute(
        &backend,
        request(setup.project.path(), Harness::Pi, "anthropic/m", None),
    );
    let error = failed(&terminal);
    assert!(
        error.message.contains("malformed json at line 1"),
        "{:?}",
        error.message
    );
}

/// A credential failure under the subscription alias retries the canonical
/// provider once (`subagent-runner.ts`'s alias-then-canonical order), so a
/// user authenticated through the direct API-key provider still completes
/// Rust-mode historian and classify runs.
fn pi_alias_credential_failure_retries_canonical_provider() {
    let setup = RunSetup::new();
    let backend = pi_backend(
        &setup,
        &[(BEHAVIOR_ENV, "alias_auth_retry")],
        Vec::new(),
        None,
    );
    let (terminal, events) = execute(
        &backend,
        request(setup.project.path(), Harness::Pi, "openai/m", None),
    );
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "canonical answer")
    ));
    // The retry's argv capture carries the canonical reference, not the
    // alias the first attempt used.
    let args = setup.argv();
    assert!(args.iter().any(|arg| arg == "openai/m"), "{args:?}");
    assert!(!args.iter().any(|arg| arg == "openai-codex/m"), "{args:?}");
    assert!(setup.out.path().join("alias-attempted").exists());
}

/// A completion that still carries a `toolCall` block is an intermediate
/// turn shape, never this tool-less run's terminal: text beside an
/// unexecuted tool request must not be published as the answer.
fn pi_tool_requesting_stop_is_not_terminal() {
    // Followed by a real terminal: the run completes with the final text.
    let mut lines = vec![
        serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
        serde_json::json!({"type": "agent_start"}),
        serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [
            {"type": "text", "text": "let me check"},
            {"type": "toolCall", "name": "read_file"},
        ]}}),
    ];
    let terminal_line = serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "real answer"}]}});
    lines.push(terminal_line);
    let (terminal, events) = run_pi_transcript(&lines);
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "{terminal:?}"
    );
    assert!(events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "real answer")
    ));
    assert!(!events.iter().any(
        |event| matches!(event, BackendEvent::AssistantText { text, .. } if text == "let me check")
    ));

    // Alone: no terminal ever arrives, so the run fails closed.
    let (terminal, _) = run_pi_transcript(&[
        serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
        serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [
            {"type": "toolCall", "name": "read_file"},
        ]}}),
    ]);
    let error = failed(&terminal);
    assert!(
        error.message.contains("without a terminal event"),
        "{:?}",
        error.message
    );
}

/// A child that emits a valid transcript without consuming the prompt (its
/// stdin closes before delivery completes) answered a question it never
/// received; the run must fail rather than accept the transcript.
fn undelivered_prompt_rejects_clean_transcript() {
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "unread.ndjson",
        &pi_success_lines("answer without a question", "stop"),
    );
    let backend = pi_backend(
        &setup,
        &[
            (TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy()),
            (BEHAVIOR_ENV, "ignore_stdin_print_transcript"),
        ],
        Vec::new(),
        None,
    );
    // The prompt must exceed the pipe buffer so an unread prompt cannot be
    // absorbed by the kernel and counted as delivered.
    let mut request = request(setup.project.path(), Harness::Pi, "anthropic/m", None);
    request.prompt = "p".repeat(1024 * 1024);
    let (terminal, _) = execute(&backend, request);
    let error = failed(&terminal);
    assert!(
        error.message.contains("prompt delivery failed"),
        "{:?}",
        error.message
    );
}

fn cancel_reaps_group_with_sigterm_first() {
    let setup = RunSetup::new();
    let backend = pi_backend(
        &setup,
        &[(BEHAVIOR_ENV, "grandchild_hang")],
        Vec::new(),
        None,
    );
    let cancel = CancellationToken::new();
    let request = request(setup.project.path(), Harness::Pi, "anthropic/m", None);

    let runtime = rt();
    let (sink, _store) = collecting_sink();
    let terminal = runtime.block_on(async {
        // Spawning `backend.execute` starts the child before this task
        // waits for `grandchild-ready`.
        let run = tokio::spawn(backend.execute(request, sink, cancel.clone()));
        let waiter = {
            let ready = setup.out.path().join("grandchild-ready");
            tokio::task::spawn_blocking(move || wait_for_file(&ready, Duration::from_secs(10)))
        };
        waiter.await.expect("grandchild readiness");
        cancel.cancel();
        run.await.expect("run task joins")
    });
    assert!(matches!(terminal, BackendTerminal::Failed(_)));
    assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
    assert_process_gone(read_pid(&setup.out.path().join("grandchild.pid")));
    // The grandchild observed SIGTERM: the graceful signal went to the
    // whole group, not only the direct child (AE6).
    wait_for_file(
        &setup.out.path().join("grandchild-sigterm"),
        Duration::from_secs(5),
    );
}

fn sigkill_escalation_when_term_ignored() {
    let setup = RunSetup::new();
    let limits = SubprocessLimits {
        run_timeout: Duration::from_secs(30),
        termination_grace: Duration::from_millis(500),
        drain_grace: Duration::from_millis(200),
        max_stdout_bytes: 1024 * 1024,
        max_stderr_bytes: 64 * 1024,
    };
    let backend = pi_backend_with_limits(
        &setup,
        &[(BEHAVIOR_ENV, "hang_ignore_term")],
        Vec::new(),
        None,
        limits,
    );
    let cancel = CancellationToken::new();
    let request = request(setup.project.path(), Harness::Pi, "anthropic/m", None);
    let runtime = rt();
    let (sink, _store) = collecting_sink();
    let started = Instant::now();
    let terminal = runtime.block_on(async {
        let run = tokio::spawn(backend.execute(request, sink, cancel.clone()));
        let waiter = {
            let armed = setup.out.path().join("term-armed");
            tokio::task::spawn_blocking(move || wait_for_file(&armed, Duration::from_secs(10)))
        };
        waiter.await.expect("term handler armed");
        cancel.cancel();
        run.await.expect("run task joins")
    });
    assert!(matches!(terminal, BackendTerminal::Failed(_)));
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "escalation must be bounded by the grace period"
    );
    // The leader saw and ignored SIGTERM; only SIGKILL ended it.
    assert!(setup.out.path().join("got-sigterm").exists());
    assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
}

fn broca_send_request() -> (SendRequest, Vec<u8>) {
    (
        SendRequest {
            prompt: PROMPT_SENTINEL.to_owned(),
            system: None,
            provider: "anthropic".to_owned(),
            model: "m".to_owned(),
            max_output_tokens: 32_000,
            temperature: 0.25,
        },
        b"frozen-send-bytes".to_vec(),
    )
}

fn supervisor_delete_reaps_group() {
    let setup = RunSetup::new();
    let backend = pi_backend(
        &setup,
        &[(BEHAVIOR_ENV, "grandchild_hang")],
        Vec::new(),
        None,
    );
    let supervisor = Supervisor::new(Arc::new(backend));
    let key = SessionKey {
        project_root: setup.project.path().to_path_buf(),
        harness: Harness::Pi,
        session: "delete-session".to_owned(),
    };
    let runtime = rt();
    runtime.block_on(async {
        let (send, body) = broca_send_request();
        supervisor.send(&key, send, &body).expect("send admits");
        let ready = setup.out.path().join("grandchild-ready");
        tokio::task::spawn_blocking(move || wait_for_file(&ready, Duration::from_secs(10)))
            .await
            .expect("grandchild readiness");
        // Delete resolves only after the backend future finished, which the
        // runner ties to a reaped leader (R10).
        supervisor.delete(&key).await.expect("delete succeeds");
    });
    assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
    assert_process_gone(read_pid(&setup.out.path().join("grandchild.pid")));
}

fn supervisor_shutdown_reaps_group() {
    let setup = RunSetup::new();
    let backend = pi_backend(
        &setup,
        &[(BEHAVIOR_ENV, "grandchild_hang")],
        Vec::new(),
        None,
    );
    let supervisor = Supervisor::new(Arc::new(backend));
    let key = SessionKey {
        project_root: setup.project.path().to_path_buf(),
        harness: Harness::Pi,
        session: "shutdown-session".to_owned(),
    };
    let runtime = rt();
    runtime.block_on(async {
        let (send, body) = broca_send_request();
        supervisor.send(&key, send, &body).expect("send admits");
        let ready = setup.out.path().join("grandchild-ready");
        tokio::task::spawn_blocking(move || wait_for_file(&ready, Duration::from_secs(10)))
            .await
            .expect("grandchild readiness");
        supervisor.shutdown().await;
    });
    assert_leader_already_reaped(read_pid(&setup.out.path().join("leader.pid")));
    assert_process_gone(read_pid(&setup.out.path().join("grandchild.pid")));
}

// ---------------------------------------------------------------------------
// Private files, umask independence, and cleanup observability (R17, R19).
// ---------------------------------------------------------------------------

fn private_paths_forced_modes_under_umask() {
    for mask in [0o000u32, 0o077] {
        let _guard = UmaskGuard::set(mask);
        let setup = RunSetup::new();
        let transcript = write_transcript(
            setup.scratch.path(),
            "success.ndjson",
            &pi_success_lines("hi", "stop"),
        );
        let backend = pi_backend(
            &setup,
            &[(TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy())],
            Vec::new(),
            None,
        );
        let request = request(
            setup.project.path(),
            Harness::Pi,
            "anthropic/m",
            Some(SYSTEM_SENTINEL),
        );
        let (terminal, _) = execute(&backend, request);
        assert!(matches!(terminal, BackendTerminal::Completed { .. }));
        let stats = setup.stats();
        assert_eq!(stats["sysprompt_file_mode"], 0o600, "umask {mask:o}");
        assert_eq!(stats["sysprompt_dir_mode"], 0o700, "umask {mask:o}");
        assert_eq!(stats["hook_file_mode"], 0o600, "umask {mask:o}");
        assert_eq!(stats["sysprompt_file_symlink"], false);
        assert_eq!(stats["sysprompt_dir_symlink"], false);
        assert_eq!(stats["hook_file_symlink"], false);
    }
}

fn private_dir_contract() {
    let dir = PrivateDir::create("mc-broca-test").expect("create");
    let dir_meta = fs::symlink_metadata(dir.path()).expect("dir meta");
    assert!(dir_meta.file_type().is_dir());
    assert!(!dir_meta.file_type().is_symlink());
    assert_eq!(dir_meta.permissions().mode() & 0o7777, 0o700);

    let file = dir
        .write_private("secret.txt", b"secret bytes")
        .expect("write");
    let file_meta = fs::symlink_metadata(&file).expect("file meta");
    assert!(file_meta.file_type().is_file());
    assert!(!file_meta.file_type().is_symlink());
    assert_eq!(file_meta.permissions().mode() & 0o7777, 0o600);
    // A second write to the same name is refused: files are fresh-only.
    assert!(dir.write_private("secret.txt", b"again").is_err());

    let path = dir.path().to_path_buf();
    dir.cleanup().expect("cleanup succeeds");
    assert!(!path.exists());
}

fn cleanup_failure_never_unqualified_success() {
    // Success path: the run completed, cleanup failed — the result must not
    // be an unqualified success and must name both facts (R19).
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "success.ndjson",
        &pi_success_lines("hi", "stop"),
    );
    let backend = pi_backend(
        &setup,
        &[
            (TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy()),
            (SABOTAGE_ENV, "1"),
        ],
        Vec::new(),
        None,
    );
    let request_success = request(
        setup.project.path(),
        Harness::Pi,
        "anthropic/m",
        Some(SYSTEM_SENTINEL),
    );
    let (terminal, _) = execute(&backend, request_success);
    let error = failed(&terminal);
    assert!(
        error.message.contains("run completed"),
        "{:?}",
        error.message
    );
    assert!(
        error.message.contains("cleanup failed"),
        "{:?}",
        error.message
    );
    assert!(!error.message.contains(SYSTEM_SENTINEL));
    assert!(!error.message.contains(PROMPT_SENTINEL));
    assert!(error.message.len() < 300);
    repair_sabotaged_dir(&setup);

    // Failure path: the primary classified error survives with the cleanup
    // evidence appended, not masked (risk table: cleanup masking).
    let setup = RunSetup::new();
    let transcript = write_transcript(
        setup.scratch.path(),
        "error.ndjson",
        &pi_error_lines("No API key found for provider"),
    );
    let backend = pi_backend(
        &setup,
        &[
            (TRANSCRIPT_FILE_ENV, &transcript.to_string_lossy()),
            (SABOTAGE_ENV, "1"),
        ],
        Vec::new(),
        None,
    );
    let request_failure = request(
        setup.project.path(),
        Harness::Pi,
        "anthropic/m",
        Some(SYSTEM_SENTINEL),
    );
    let (terminal, _) = execute(&backend, request_failure);
    let error = failed(&terminal);
    assert_eq!(error.class, ErrorClass::AuthRequired);
    // The provider text steered classification (AuthRequired above) but is
    // redacted from the wire message (R19).
    assert!(!error.message.contains("No API key found"));
    assert!(error.message.contains("stopped with reason \"error\""));
    assert!(
        error.message.contains("cleanup failed"),
        "{:?}",
        error.message
    );
    repair_sabotaged_dir(&setup);
}

fn env_snapshot_strips_launch_identity() {
    let snapshot = EnvSnapshot::from_vars(vec![
        (os("SUBC_MODULE_ID"), os("evil")),
        (os("SUBC_LAUNCH_NONCE"), os("evil")),
        (os("KEEP_ME"), os("value")),
    ]);
    let names: Vec<String> = snapshot
        .vars()
        .iter()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["KEEP_ME"]);
}

/// A harness line's JSON node count is bounded before any DOM is built: an
/// array of tiny values amplifies far past its byte length, which the
/// capture budget does not model. Prose commas inside strings are content,
/// not structure, and must never trip the bound.
fn oversized_json_structure_rejected_without_capping_prose() {
    // Node flood: ~40k array elements in an otherwise-ignored lifecycle
    // event, well past the 32_768 bound but only ~80 KB of bytes.
    let flood = format!(
        "{{\"type\":\"session\",\"id\":\"s\",\"pad\":[{}]}}",
        vec!["0"; 40_000].join(",")
    );
    let setup = RunSetup::new();
    let path = setup.scratch.path().join("flood.ndjson");
    fs::write(&path, format!("{flood}\n")).expect("transcript");
    let backend = pi_backend(
        &setup,
        &[(TRANSCRIPT_FILE_ENV, &path.to_string_lossy())],
        Vec::new(),
        None,
    );
    let (terminal, _) = execute(
        &backend,
        request(setup.project.path(), Harness::Pi, "anthropic/m", None),
    );
    let error = failed(&terminal);
    assert!(
        error.message.contains("json structure too large at line 1"),
        "a node flood must end as one bounded parse failure: {:?}",
        error.message
    );
    assert!(error.message.len() < 300, "diagnostic is unbounded");

    // The same comma count as prose inside an assistant message: content,
    // not structure — this must still parse and deliver its text.
    let prose = "a,".repeat(40_000);
    let (terminal, events) = run_pi_transcript(&pi_success_lines(&prose, "stop"));
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "prose commas must not trip the structural bound: {terminal:?}"
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, BackendEvent::AssistantText { text, .. } if text == &prose)));
}

/// Pi's automatic retry emits a terminal `message_end` for the failed
/// attempt and another for the retry, so `message_end` decisions are
/// provisional: the last one wins and only its text is published. Treating
/// them as committed terminals rejected a legitimately retried run as a
/// contradictory transcript.
fn pi_auto_retry_supersedes_the_failed_attempts_terminal() {
    let mut lines = vec![
        serde_json::json!({"type": "session", "id": "s", "version": "1", "timestamp": 1, "cwd": "/"}),
        serde_json::json!({"type": "agent_start"}),
        // Failed attempt: a terminal error message_end...
        serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "error", "errorMessage": "provider overloaded", "content": [{"type": "text", "text": "PARTIAL-DISCARDED"}]}}),
        serde_json::json!({"type": "auto_retry_start"}),
        serde_json::json!({"type": "auto_retry_end"}),
        // ...then the retry's own terminal.
        serde_json::json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "retried answer"}]}}),
    ];
    let (terminal, events) = run_pi_transcript(&lines);
    assert!(
        matches!(terminal, BackendTerminal::Completed { .. }),
        "the retry's terminal must supersede the failed attempt's: {terminal:?}"
    );
    let texts: Vec<&str> = events
        .iter()
        .map(|event| match event {
            BackendEvent::AssistantText { text, .. } => text.as_str(),
        })
        .collect();
    assert_eq!(
        texts,
        vec!["retried answer"],
        "only the winning attempt's text may be published"
    );

    // The authoritative agent_end still overrides the last provisional one.
    lines.push(serde_json::json!({"type": "agent_end", "messages": [{"role": "assistant", "stopReason": "error", "errorMessage": "final state failed", "content": []}]}));
    let (terminal, _) = run_pi_transcript(&lines);
    assert!(
        matches!(terminal, BackendTerminal::Failed(_)),
        "agent_end stays authoritative over provisional message_end: {terminal:?}"
    );
}

fn merge_cleanup_contract() {
    let completed = BackendTerminal::Completed {
        finish_reason: FinishReason::Completed,
    };
    // Clean cleanup: the terminal passes through untouched.
    assert_eq!(merge_cleanup(completed.clone(), Ok(())), completed);
    // Failed cleanup after success: no unqualified success survives.
    let failure = CleanupFailure {
        kind: std::io::ErrorKind::PermissionDenied,
    };
    let merged = merge_cleanup(completed, Err(failure));
    let error = failed(&merged);
    assert_eq!(error.class, ErrorClass::Transient);
    assert!(error.message.contains("run completed (completed)"));
    assert!(error.message.contains("cleanup failed"));
}

/// The crash sweep kills a recorded group only when its recording host is
/// dead and its leader is provably the recorded process; records owned by
/// a live host survive untouched, so concurrent hosts never sweep each
/// other's live runs.
fn group_registry_sweep_kills_only_dead_owner_groups() {
    use std::os::unix::process::CommandExt;

    use mc_host::broca::subprocess::group_registry::{sweep_orphaned_groups, GroupRecord};

    let spawn_leader = || {
        let mut cmd = std::process::Command::new("/bin/sleep");
        cmd.arg("30");
        cmd.process_group(0);
        cmd.spawn().expect("spawn sleep leader")
    };
    fn wait_sigkilled(child: &mut std::process::Child, what: &str) {
        use std::os::unix::process::ExitStatusExt;
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().expect("wait child") {
                break status;
            }
            assert!(Instant::now() < deadline, "{what} survived the sweep");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.signal(), Some(9), "{what} must die by SIGKILL");
    }

    // Orphan: recorded by a stand-in host (the record_group fixture) that
    // exits without cleanup, exactly like a crashed host.
    let mut orphan = spawn_leader();
    let status = std::process::Command::new(std::env::current_exe().expect("current exe"))
        .env(FIXTURE_MODE_ENV, "record_group")
        .env(GROUP_PID_ENV, orphan.id().to_string())
        .status()
        .expect("run record_group fixture");
    assert!(status.success(), "fixture host failed: {status:?}");

    // Survivor: recorded by THIS process, which is alive during the sweep.
    let mut survivor = spawn_leader();
    let survivor_record =
        GroupRecord::record(i32::try_from(survivor.id()).expect("pid fits")).expect("record");

    assert!(
        sweep_orphaned_groups() >= 1,
        "sweep must kill at least the orphaned group"
    );
    wait_sigkilled(&mut orphan, "the orphan leader");

    assert!(
        survivor.try_wait().expect("poll survivor").is_none(),
        "the sweep must not touch a live host's group"
    );

    drop(survivor_record);
    let _ = survivor.kill();
    let _ = survivor.wait();

    // Zombie owner: the recording host exited but stays unreaped — a
    // crashed host can linger as a zombie while its supervisor already
    // runs the replacement. The sweep must treat it as dead.
    let mut zombie_orphan = spawn_leader();
    let mut recorder = std::process::Command::new(std::env::current_exe().expect("current exe"))
        .env(FIXTURE_MODE_ENV, "record_group")
        .env(GROUP_PID_ENV, zombie_orphan.id().to_string())
        .spawn()
        .expect("spawn record_group fixture");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = fs::read_to_string(format!("/proc/{}/stat", recorder.id()))
            .ok()
            .and_then(|stat| {
                stat.rsplit_once(')')
                    .and_then(|(_, rest)| rest.split_ascii_whitespace().next().map(str::to_owned))
            });
        if state.as_deref() == Some("Z") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "recorder never became a zombie: {state:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        sweep_orphaned_groups() >= 1,
        "a zombie owner must count as dead"
    );
    wait_sigkilled(&mut zombie_orphan, "the zombie-owned leader");
    let _ = recorder.wait();

    // Leaderless orphan: the leader exits after forking a grandchild into
    // its group — the shape pdeathsig leaves behind when it kills only the
    // leader. The sweep must still kill the surviving group member.
    let mut leader = std::process::Command::new("/bin/sh");
    leader.args(["-c", "sleep 30 & echo $!; sleep 2"]);
    leader.process_group(0);
    leader.stdout(std::process::Stdio::piped());
    let mut leader = leader.spawn().expect("spawn leaderless-group shell");
    let grandchild: i32 = {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::BufReader::new(leader.stdout.take().expect("piped stdout"))
            .read_line(&mut line)
            .expect("read grandchild pid");
        line.trim().parse().expect("grandchild pid")
    };
    // Record while the leader is still alive (its `sleep 2` window), from
    // a stand-in host that then dies.
    let status = std::process::Command::new(std::env::current_exe().expect("current exe"))
        .env(FIXTURE_MODE_ENV, "record_group")
        .env(GROUP_PID_ENV, leader.id().to_string())
        .status()
        .expect("run record_group fixture");
    assert!(status.success(), "fixture host failed: {status:?}");
    let leader_exit = leader.wait().expect("leader exits on its own");
    assert!(leader_exit.success(), "shell leader must exit cleanly");

    assert!(
        sweep_orphaned_groups() >= 1,
        "sweep must kill the leaderless group"
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // Killed and reaped by init: /proc entry gone (or briefly zombie).
        let state = fs::read_to_string(format!("/proc/{grandchild}/stat"))
            .ok()
            .and_then(|stat| {
                stat.rsplit_once(')')
                    .and_then(|(_, rest)| rest.split_ascii_whitespace().next().map(str::to_owned))
            });
        match state.as_deref() {
            None | Some("Z") => break,
            Some(_) => {}
        }
        assert!(
            Instant::now() < deadline,
            "leaderless grandchild survived the sweep"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
