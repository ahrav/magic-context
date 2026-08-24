//! The OpenCode subprocess adapter (KTD7, R15).
//!
//! Every run is configured entirely from trusted ephemeral state: a private
//! per-run `OPENCODE_DB`, an inline `OPENCODE_CONFIG_CONTENT` registering
//! one zero-tool agent that carries the system role, project configuration
//! disabled, the Broca-child recursion guard set, and the prompt delivered
//! over stdin. The user's ordinary OpenCode database and any
//! project-controlled configuration are never read or written.

use std::ffi::OsString;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::backend::{
    BackendError, BackendEvent, BackendFuture, BackendRequest, BackendTerminal, ErrorClass,
    EventSink, FinishReason, LlmExecutionBackend,
};
use super::config::MAX_OPENCODE_CONFIG_BYTES;
use super::subprocess::{
    self, commit_terminal, EnvSnapshot, HarnessName, PrivateDir, SubprocessLimits, SubprocessSpec,
};

/// Environment guard the globally installed OpenCode plugin checks at the
/// very start of its entry (KTD7): a Broca child must exit Magic Context
/// initialization before configuration migration, database access, hooks,
/// timers, or RPC startup. The name mirrors the existing Pi guard
/// `MAGIC_CONTEXT_PI_SUBAGENT`; the literal is duplicated in
/// `packages/plugin/src/index.ts`.
pub const MAGIC_CONTEXT_BROCA_CHILD_ENV: &str = "MAGIC_CONTEXT_BROCA_CHILD";

/// The zero-tool agent name registered through the inline config and
/// selected with `--agent`.
pub const OPENCODE_BROCA_AGENT: &str = "broca";

/// Trusted OpenCode runtime descriptor. `magic-context-c50.8` resolves the
/// installed absolute executable path and any configured variant arguments;
/// this crate defines and tests the contract with fixtures.
#[derive(Clone, Debug)]
pub struct OpenCodeRuntime {
    /// Trusted absolute path to the `opencode` executable.
    pub executable: PathBuf,
    /// Configured variant arguments appended verbatim after the fixed argv
    /// (R15 "configured variant arguments").
    pub variant_args: Vec<String>,
}

/// [`LlmExecutionBackend`] adapter that runs `opencode run` under the
/// shared hardened subprocess runner.
pub struct OpenCodeBackend {
    runtime: OpenCodeRuntime,
    limits: SubprocessLimits,
    env: EnvSnapshot,
}

impl OpenCodeBackend {
    pub fn new(runtime: OpenCodeRuntime, env: EnvSnapshot) -> Self {
        Self::with_limits(runtime, env, SubprocessLimits::default())
    }

    pub fn with_limits(
        runtime: OpenCodeRuntime,
        env: EnvSnapshot,
        limits: SubprocessLimits,
    ) -> Self {
        Self {
            runtime,
            limits,
            env,
        }
    }
}

impl LlmExecutionBackend for OpenCodeBackend {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture {
        let runtime = self.runtime.clone();
        let limits = self.limits.clone();
        let env = self.env.clone();
        Box::pin(run_opencode(runtime, limits, env, request, events, cancel))
    }
}

/// The inline `OPENCODE_CONFIG_CONTENT` document (KTD7): one primary
/// zero-tool agent carrying the system role and temperature, plus a model
/// output-limit override carrying the bounded token budget (R6, R18).
fn inline_config(request: &BackendRequest) -> String {
    let mut agent = serde_json::json!({
        "mode": "primary",
        // `{"*": false}` disables every tool for the agent — R15's
        // zero-tool contract.
        "tools": { "*": false },
        "temperature": request.temperature,
    });
    if let Some(system) = &request.system {
        agent["prompt"] = serde_json::Value::String(system.clone());
    }
    let config = serde_json::json!({
        "agent": { OPENCODE_BROCA_AGENT: agent },
        "provider": {
            &request.provider: {
                "models": {
                    &request.model: {
                        "limit": { "output": request.max_output_tokens },
                    },
                },
            },
        },
    });
    serde_json::to_string(&config).expect("inline config serializes")
}

async fn run_opencode(
    runtime: OpenCodeRuntime,
    limits: SubprocessLimits,
    env: EnvSnapshot,
    request: BackendRequest,
    events: EventSink,
    cancel: CancellationToken,
) -> BackendTerminal {
    let config_content = inline_config(&request);
    // Linux caps one env string at MAX_ARG_STRLEN (~128 KiB); a config over
    // that fails exec(2) with E2BIG, an opaque permanent spawn failure.
    // Rejecting early names the real bound in the terminal instead.
    if config_content.len() > MAX_OPENCODE_CONFIG_BYTES {
        return BackendTerminal::Failed(BackendError {
            class: ErrorClass::Permanent,
            message: format!(
                "opencode inline config is {} bytes, over the {} byte environment-string ceiling (system prompt too large)",
                config_content.len(),
                MAX_OPENCODE_CONFIG_BYTES
            ),
            retry_after_secs: None,
            provider_code: None,
        });
    }
    let dir = match PrivateDir::create("mc-broca-opencode") {
        Ok(dir) => dir,
        Err(err) => return subprocess::spawn_failure(HarnessName::OpenCode, &err),
    };

    let mut args = vec![
        "run".to_owned(),
        "--model".to_owned(),
        // The canonical `provider/model` reaches OpenCode unchanged (plan
        // "OpenCode and Pi selection": no alias mapping on this side).
        format!("{}/{}", request.provider, request.model),
        "--agent".to_owned(),
        OPENCODE_BROCA_AGENT.to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    args.extend(runtime.variant_args.iter().cloned());

    let mut child_env: Vec<(OsString, OsString)> = env.vars().to_vec();
    child_env.push((
        OsString::from("OPENCODE_DB"),
        dir.path().join("opencode.db").into_os_string(),
    ));
    child_env.push((
        OsString::from("OPENCODE_CONFIG_CONTENT"),
        OsString::from(config_content),
    ));
    // Project config, `.opencode/` directories, and local rule files stay
    // unread (KTD7): hidden model work must not load project-controlled
    // behavior.
    child_env.push((
        OsString::from("OPENCODE_DISABLE_PROJECT_CONFIG"),
        OsString::from("1"),
    ));
    child_env.push((
        OsString::from(MAGIC_CONTEXT_BROCA_CHILD_ENV),
        OsString::from("1"),
    ));

    let spec = SubprocessSpec {
        executable: runtime.executable,
        args,
        env: child_env,
        working_dir: request.project_root.clone(),
        stdin: request.prompt.clone().into_bytes(),
    };

    // No terminal probe: the OpenCode CLI closes its streams and exits when
    // the run finishes, so EOF plus the drain grace already bound the tail.
    let result = match subprocess::run(spec, &limits, &cancel, None).await {
        Ok(result) => result,
        Err(err) => {
            return subprocess::merge_cleanup(
                subprocess::spawn_failure(HarnessName::OpenCode, &err),
                dir.cleanup(),
            )
        }
    };

    // A transcript is trusted only after a clean end; abnormal ends map to
    // one canonical failure in `finalize` regardless of what was printed.
    let parsed = subprocess::parse_clean_transcript(&result, &events, parse_opencode_transcript);
    subprocess::finalize(
        HarnessName::OpenCode,
        &result,
        parsed,
        &limits,
        dir.cleanup(),
    )
}

/// Parses the closed `opencode run --format json` vocabulary (R18):
/// `step_start`, `text`, `step_finish`, and `error`. A `tool_use` event is
/// recognized but rejected — this path is a zero-tool transform, so a tool
/// invocation is a contract failure, not lifecycle metadata. Anything
/// else — malformed JSON, non-UTF-8, unknown types, unknown finish reasons,
/// contradictory terminals, or a missing terminal — is rejected with a
/// structural detail that never quotes the line (R19).
fn parse_opencode_transcript(
    stdout: &[u8],
) -> Result<(Vec<BackendEvent>, BackendTerminal), String> {
    let mut events = Vec::new();
    let mut terminal: Option<BackendTerminal> = None;
    for (index, line) in stdout.split(|byte| *byte == b'\n').enumerate() {
        if line.is_empty() {
            continue;
        }
        let line_no = index + 1;
        let Ok(text) = std::str::from_utf8(line) else {
            return Err(format!("non-utf8 output at line {line_no}"));
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return Err(format!("malformed json at line {line_no}"));
        };
        let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
            return Err(format!("missing event type at line {line_no}"));
        };
        match event_type {
            "step_start" => {}
            // Broca advertises this path as a zero-tool prompt-to-text
            // transform: a tool invocation means the run executed something
            // the contract forbids, so its text must not be published.
            "tool_use" => {
                return Err(format!(
                    "tool_use event in a tool-less run at line {line_no}"
                ));
            }
            "text" => {
                // A completed or failed run cannot grow its answer: content
                // after the terminal is transcript corruption, and appending
                // it would extend what subscribers already saw settled.
                if terminal.is_some() {
                    return Err(format!("text event after the terminal at line {line_no}"));
                }
                let Some(text) = value
                    .get("part")
                    .and_then(|part| part.get("text"))
                    .and_then(serde_json::Value::as_str)
                else {
                    return Err(format!("text event without part.text at line {line_no}"));
                };
                events.push(BackendEvent::AssistantText {
                    text: text.to_owned(),
                    finish_reason: None,
                });
            }
            "step_finish" => {
                let reason = value
                    .get("part")
                    .and_then(|part| part.get("reason"))
                    .and_then(serde_json::Value::as_str);
                let finish_reason = match reason {
                    // A tool-calls step continues the run; a reason-less
                    // step is nonterminal in the supported vocabulary.
                    Some("tool-calls") | None => continue,
                    Some("stop") => FinishReason::Completed,
                    // The exact length-class spelling is preserved (R18):
                    // OpenCode's AI-SDK reason is "length".
                    Some("length") => FinishReason::Length,
                    Some(_) => {
                        return Err(format!("unknown finish reason at line {line_no}"));
                    }
                };
                commit_terminal(
                    &mut terminal,
                    BackendTerminal::Completed { finish_reason },
                    line_no,
                )?;
            }
            "error" => {
                commit_terminal(&mut terminal, error_terminal(&value), line_no)?;
            }
            _ => return Err(format!("unknown event type at line {line_no}")),
        }
    }
    let Some(terminal) = terminal else {
        return Err("output ended without a terminal event".to_owned());
    };
    Ok((events, terminal))
}

/// Maps one OpenCode `error` event to the classified failure the producer
/// consumes (R18): class, retry delay, and the provider's error name as the
/// diagnostic code. The message forwarded is the provider's bounded
/// human-readable message; the protocol encoder truncates it before replay.
fn error_terminal(value: &serde_json::Value) -> BackendTerminal {
    let error = value.get("error");
    let name = error
        .and_then(|error| error.get("name"))
        .and_then(serde_json::Value::as_str);
    let data = error.and_then(|error| error.get("data"));
    let message = data
        .and_then(|data| data.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("opencode reported an unclassified provider error");
    let status_code = data
        .and_then(|data| data.get("statusCode"))
        .and_then(serde_json::Value::as_u64);
    let retryable = data
        .and_then(|data| data.get("isRetryable"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let class = match status_code {
        Some(401 | 403) => ErrorClass::AuthRequired,
        Some(429) => ErrorClass::Transient,
        Some(code) if code >= 500 => ErrorClass::Transient,
        _ => {
            let class = subprocess::classify_failure_text(message);
            if class == ErrorClass::Permanent && retryable {
                ErrorClass::Transient
            } else {
                class
            }
        }
    };
    let retry_after_secs = data
        .and_then(|data| data.get("retryAfter"))
        .and_then(serde_json::Value::as_u64)
        .or_else(|| subprocess::retry_after_secs_in_text(message))
        // The provider-supplied field is as untrusted as the message text:
        // both are clamped so a hostile value cannot schedule a durable
        // backoff decades out.
        .map(|secs| secs.min(subprocess::MAX_RETRY_AFTER_SECS));
    BackendTerminal::Failed(BackendError {
        class,
        // Host-authored: the provider text above steers classification but
        // never rides the wire — it can echo prompt, memory-pool, or
        // credential content (R19).
        message: match status_code {
            Some(code) => format!("opencode provider reported an error (status {code})"),
            None => "opencode provider reported an error".to_owned(),
        },
        retry_after_secs,
        provider_code: name.and_then(subprocess::sanitized_provider_code),
    })
}
