//! Runs OpenCode as a hardened Broca subprocess.
//!
//! Each run uses a private `OPENCODE_DB`, inline configuration for one zero-tool
//! agent, disabled project configuration, the Broca child guard, and a prompt on
//! standard input. Runs do not access the user's database or project-controlled
//! configuration.

use std::ffi::OsString;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::backend::{
    self, BackendError, BackendEvent, BackendFuture, BackendRequest, BackendTerminal, ErrorClass,
    EventSink, FinishReason, Harness, LlmExecutionBackend,
};
use super::config::MAX_OPENCODE_CONFIG_BYTES;
use super::subprocess::{
    self, commit_terminal, EnvSnapshot, HarnessName, PrivateDir, SubprocessLimits, SubprocessSpec,
};
use crate::harness_closure::ValidatedHarnessClosure;

/// Environment guard that stops Broca children before plugin initialization.
///
/// `packages/plugin/src/index.ts` checks this value before configuration
/// migration, database access, hooks, timers, or RPC startup.
pub const MAGIC_CONTEXT_BROCA_CHILD_ENV: &str = "MAGIC_CONTEXT_BROCA_CHILD";

/// Inline agent name selected with `--agent`.
pub const OPENCODE_BROCA_AGENT: &str = "broca";

/// Trusted runtime closure used to launch OpenCode.
#[derive(Clone, Debug)]
pub struct OpenCodeRuntime {
    /// Validated closure containing the executable.
    pub closure: Arc<ValidatedHarnessClosure>,
    /// Node descriptor for the OpenCode executable.
    pub executable_node: String,
}

/// [`LlmExecutionBackend`] adapter for `opencode run`.
pub struct OpenCodeBackend {
    runtime: OpenCodeRuntime,
    limits: SubprocessLimits,
    env: EnvSnapshot,
}

impl OpenCodeBackend {
    /// Creates a backend with default subprocess limits.
    pub fn new(runtime: OpenCodeRuntime, env: EnvSnapshot) -> Self {
        Self::with_limits(runtime, env, SubprocessLimits::default())
    }

    /// Creates a backend with explicit subprocess limits.
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
        // Reject harness mismatches before using OpenCode-specific credentials.
        if request.harness != Harness::OpenCode {
            let terminal = backend::harness_mismatch(Harness::OpenCode, request.harness);
            return Box::pin(async move { terminal });
        }
        if events.emit(BackendEvent::HarnessDispatch {
            harness: Harness::OpenCode,
        }) == backend::SinkStatus::Closed
        {
            let terminal = backend::dispatch_closed(Harness::OpenCode);
            return Box::pin(async move { terminal });
        }
        let runtime = self.runtime.clone();
        let limits = self.limits.clone();
        let env = self.env.clone();
        Box::pin(run_opencode(runtime, limits, env, request, events, cancel))
    }
}

fn inline_config(request: &BackendRequest) -> String {
    let mut agent = serde_json::json!({
        "mode": "primary",
        // The wildcard disables every tool for this agent.
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
    let mut child_env = match env.provider_row("opencode", &request.provider) {
        Ok(row) => row,
        Err(error) => {
            return subprocess::credential_failure(HarnessName::OpenCode, error);
        }
    };
    let config_content = inline_config(&request);
    // Linux limits one environment string to `MAX_ARG_STRLEN`, about 128 KiB.
    // Reject oversized configuration before `exec(2)` can fail with `E2BIG`.
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

    let args = vec![
        "run".to_owned(),
        "--model".to_owned(),
        // OpenCode receives the canonical `provider/model` without alias mapping.
        format!("{}/{}", request.provider, request.model),
        "--agent".to_owned(),
        OPENCODE_BROCA_AGENT.to_owned(),
        "--format".to_owned(),
        "json".to_owned(),
    ];
    let executable_node = match runtime
        .closure
        .resolve_node_descriptor(&runtime.executable_node)
    {
        Ok(path) => path,
        Err(_) => {
            return subprocess::harness_unavailable_failure(
                HarnessName::OpenCode,
                "closure_incomplete",
            )
        }
    };

    child_env.push((
        OsString::from("OPENCODE_DB"),
        dir.path().join("opencode.db").into_os_string(),
    ));
    child_env.push((
        OsString::from("OPENCODE_CONFIG_CONTENT"),
        OsString::from(config_content),
    ));
    // Keep project configuration, `.opencode/` directories, and local rule files unread.
    child_env.push((
        OsString::from("OPENCODE_DISABLE_PROJECT_CONFIG"),
        OsString::from("1"),
    ));
    child_env.push((
        OsString::from(MAGIC_CONTEXT_BROCA_CHILD_ENV),
        OsString::from("1"),
    ));
    child_env.push((OsString::from("HOME"), dir.path().as_os_str().to_owned()));

    let spec = SubprocessSpec {
        executable: executable_node.path().to_path_buf(),
        args,
        env: child_env,
        working_dir: dir.path().to_path_buf(),
        stdin: request.prompt.clone().into_bytes(),
        // Inherit only the executable descriptor. No argument references the closure
        // directory, and exposing it would allow writes into the validated closure tree.
        inherit_fds: vec![executable_node.inherited_fd()],
    };

    // OpenCode closes its streams and exits after the run. EOF and the drain grace
    // bound the tail without a terminal probe.
    let result = match subprocess::run(spec, &limits, &cancel, None).await {
        Ok(result) => result,
        Err(err) => {
            return subprocess::merge_cleanup(
                subprocess::spawn_failure(HarnessName::OpenCode, &err),
                dir.cleanup(),
            )
        }
    };

    // Trust transcript output only after a clean end. `finalize` maps every
    // abnormal end to one canonical failure regardless of printed output.
    let parsed = subprocess::parse_clean_transcript(&result, &events, parse_opencode_transcript);
    subprocess::finalize(
        HarnessName::OpenCode,
        &result,
        parsed,
        &limits,
        dir.cleanup(),
    )
}

/// Parses the closed `opencode run --format json` event vocabulary.
///
/// The parser accepts `step_start`, `text`, `step_finish`, and `error`. It
/// recognizes and rejects `tool_use` because this path promises a zero-tool
/// transform. It rejects malformed JSON, non-UTF-8 input, unknown events or
/// finish reasons, contradictory terminals, and missing terminals without
/// quoting input lines in errors.
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
        // Bound node count before constructing a DOM that could exceed the capture budget.
        if !subprocess::json_nodes_within_bound(text) {
            return Err(format!("json structure too large at line {line_no}"));
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return Err(format!("malformed json at line {line_no}"));
        };
        let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
            return Err(format!("missing event type at line {line_no}"));
        };
        match event_type {
            "step_start" => {}
            // Reject tool execution before publishing any associated text.
            "tool_use" => {
                return Err(format!(
                    "tool_use event in a tool-less run at line {line_no}"
                ));
            }
            "text" => {
                // Completed or failed runs cannot add text after their terminal event.
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
                    Some("tool-calls") | None => continue,
                    Some("stop") => FinishReason::Completed,
                    // OpenCode's AI-SDK finish reason is `length`.
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

/// Maps one OpenCode error event to a classified backend failure.
///
/// Status, retryability, and bounded retry delay determine the failure class.
/// The provider's sanitized error name becomes the diagnostic code. Provider
/// message text guides classification but never enters the returned message.
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
        .map(|secs| secs.min(subprocess::MAX_RETRY_AFTER_SECS));
    BackendTerminal::Failed(BackendError {
        class,
        // The provider text affects classification but is excluded from `BackendError::message`.
        message: match status_code {
            Some(code) => format!("opencode provider reported an error (status {code})"),
            None => "opencode provider reported an error".to_owned(),
        },
        retry_after_secs,
        provider_code: name.and_then(subprocess::sanitized_provider_code),
    })
}
