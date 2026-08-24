//! The Pi subprocess adapter (KTD8, R16).
//!
//! Print-mode JSON with no persisted session, no tools, a private `0600`
//! system-prompt file, an explicit model with canonical-to-Pi provider
//! prefix mapping, and an optional thinking level. Extension discovery is
//! disabled (`--no-approve --no-extensions`); only the trusted runtime
//! descriptor's ordered daemon-owner provider extensions load, followed by
//! the bundled Broca payload hook LAST so it owns the final generation
//! contract. The existing Magic Context Pi recursion guard suppresses full
//! plugin startup in the child.

use std::ffi::OsString;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::backend::{
    BackendError, BackendEvent, BackendFuture, BackendRequest, BackendTerminal, EventSink,
    FinishReason, LlmExecutionBackend,
};
use super::subprocess::{
    self, commit_terminal, EnvSnapshot, HarnessName, PrivateDir, SubprocessLimits, SubprocessSpec,
};

/// The existing Magic Context Pi recursion guard
/// (`packages/pi-plugin/src/index.ts` checks it and returns before full
/// extension registration).
pub const MAGIC_CONTEXT_PI_SUBAGENT_ENV: &str = "MAGIC_CONTEXT_PI_SUBAGENT";

/// Adapter-owned control variables carrying the requested generation values
/// to the bundled payload hook. Bounded numbers only — never request text.
pub const BROCA_MAX_OUTPUT_TOKENS_ENV: &str = "MC_BROCA_MAX_OUTPUT_TOKENS";
pub const BROCA_TEMPERATURE_ENV: &str = "MC_BROCA_TEMPERATURE";

/// The bundled Broca payload hook (KTD8), embedded at compile time and
/// materialized per run into an owner-only temp file loaded as the FINAL
/// explicit extension.
pub const PI_BROCA_EXTENSION_BYTES: &[u8] = include_bytes!("../../assets/pi-broca-extension.mjs");

/// File name the hook is materialized under inside the run's private dir.
pub const PI_BROCA_EXTENSION_FILE: &str = "pi-broca-extension.mjs";

/// Trusted Pi runtime descriptor: the installed absolute executable plus
/// the ordered daemon-owner provider-extension paths. `magic-context-c50.8`
/// resolves the real installed paths; this crate defines and fixture-tests
/// the contract (plan assumption).
#[derive(Clone, Debug)]
pub struct PiRuntimeDescriptor {
    /// Trusted absolute path to the Pi CLI entry.
    pub executable: PathBuf,
    /// Ordered daemon-owner provider extensions, loaded explicitly in this
    /// order BEFORE the bundled Broca hook (R16).
    pub provider_extensions: Vec<PathBuf>,
}

/// [`LlmExecutionBackend`] adapter that runs Pi print-mode JSON under the
/// shared hardened subprocess runner.
pub struct PiBackend {
    descriptor: PiRuntimeDescriptor,
    /// Optional `--thinking <level>` (R16); absent means Pi's own
    /// resolution runs.
    thinking_level: Option<String>,
    limits: SubprocessLimits,
    env: EnvSnapshot,
}

impl PiBackend {
    pub fn new(descriptor: PiRuntimeDescriptor, env: EnvSnapshot) -> Self {
        Self::with_limits(descriptor, env, None, SubprocessLimits::default())
    }

    pub fn with_limits(
        descriptor: PiRuntimeDescriptor,
        env: EnvSnapshot,
        thinking_level: Option<String>,
        limits: SubprocessLimits,
    ) -> Self {
        Self {
            descriptor,
            thinking_level,
            limits,
            env,
        }
    }
}

impl LlmExecutionBackend for PiBackend {
    fn execute(
        &self,
        request: BackendRequest,
        events: EventSink,
        cancel: CancellationToken,
    ) -> BackendFuture {
        let descriptor = self.descriptor.clone();
        let thinking_level = self.thinking_level.clone();
        let limits = self.limits.clone();
        let env = self.env.clone();
        Box::pin(run_pi(
            descriptor,
            thinking_level,
            limits,
            env,
            request,
            events,
            cancel,
        ))
    }
}

/// Canonical-to-Pi provider prefix mapping (plan "OpenCode and Pi
/// selection"), mirroring `harness-provider-map.ts`: known auth-plugin
/// aliases translate, unknown providers pass through unchanged.
pub fn pi_model_ref(provider: &str, model: &str) -> String {
    let pi_provider = match provider {
        "openai" => "openai-codex",
        "google" => "google-antigravity",
        other => other,
    };
    format!("{pi_provider}/{model}")
}

async fn run_pi(
    descriptor: PiRuntimeDescriptor,
    thinking_level: Option<String>,
    limits: SubprocessLimits,
    env: EnvSnapshot,
    request: BackendRequest,
    events: EventSink,
    cancel: CancellationToken,
) -> BackendTerminal {
    let dir = match PrivateDir::create("mc-broca-pi") {
        Ok(dir) => dir,
        Err(err) => return subprocess::spawn_failure(HarnessName::Pi, &err),
    };
    // The bundled hook is materialized privately per run (0600 file inside
    // the 0700 dir) rather than shipped as an installed file: the loaded
    // bytes are exactly the compiled-in asset, so no installed path can be
    // swapped underneath the daemon (KTD8).
    let hook_path = match dir.write_private(PI_BROCA_EXTENSION_FILE, PI_BROCA_EXTENSION_BYTES) {
        Ok(path) => path,
        Err(err) => {
            return subprocess::merge_cleanup(
                subprocess::spawn_failure(HarnessName::Pi, &err),
                dir.cleanup(),
            )
        }
    };
    // The system prompt is caller-private content (R19): a private 0600
    // file, never argv.
    let system_prompt_path = match &request.system {
        None => None,
        Some(system) => match dir.write_private("system-prompt.txt", system.as_bytes()) {
            Ok(path) => Some(path),
            Err(err) => {
                return subprocess::merge_cleanup(
                    subprocess::spawn_failure(HarnessName::Pi, &err),
                    dir.cleanup(),
                )
            }
        },
    };

    // Argument order mirrors `subagent-runner.ts`'s print-mode pattern:
    // fixed mode flags, isolation flags, explicit extensions (descriptor
    // order, bundled hook last), private system prompt, model, thinking.
    // The prompt travels only over stdin, so no positional message exists.
    let mut args = vec![
        "--print".to_owned(),
        "--mode".to_owned(),
        "json".to_owned(),
        // No persisted session (R16): the result comes back over stdout and
        // hidden model work must not appear in the user's session picker.
        "--no-session".to_owned(),
        "--no-skills".to_owned(),
        "--no-prompt-templates".to_owned(),
        "--no-context-files".to_owned(),
        // Closed tool surface (R28): the run is a pure prompt-to-text
        // transform.
        "--no-tools".to_owned(),
        // `--no-approve` keeps project-local settings and extensions
        // untrusted for the run; `--no-extensions` disables discovery so
        // ONLY the explicit `--extension` list below loads (R16).
        "--no-approve".to_owned(),
        "--no-extensions".to_owned(),
    ];
    for extension in &descriptor.provider_extensions {
        args.push("--extension".to_owned());
        args.push(extension.to_string_lossy().into_owned());
    }
    args.push("--extension".to_owned());
    args.push(hook_path.to_string_lossy().into_owned());
    if let Some(path) = &system_prompt_path {
        args.push("--system-prompt".to_owned());
        args.push(path.to_string_lossy().into_owned());
    }
    args.push("--model".to_owned());
    args.push(pi_model_ref(&request.provider, &request.model));
    if let Some(level) = &thinking_level {
        args.push("--thinking".to_owned());
        args.push(level.clone());
    }

    let mut child_env: Vec<(OsString, OsString)> = env.vars().to_vec();
    child_env.push((
        OsString::from(MAGIC_CONTEXT_PI_SUBAGENT_ENV),
        OsString::from("1"),
    ));
    child_env.push((
        OsString::from(BROCA_MAX_OUTPUT_TOKENS_ENV),
        OsString::from(request.max_output_tokens.to_string()),
    ));
    child_env.push((
        OsString::from(BROCA_TEMPERATURE_ENV),
        OsString::from(request.temperature.to_string()),
    ));

    let spec = SubprocessSpec {
        executable: descriptor.executable,
        args,
        env: child_env,
        working_dir: request.project_root.clone(),
        stdin: request.prompt.clone().into_bytes(),
    };

    let result = match subprocess::run(spec, &limits, &cancel).await {
        Ok(result) => result,
        Err(err) => {
            return subprocess::merge_cleanup(
                subprocess::spawn_failure(HarnessName::Pi, &err),
                dir.cleanup(),
            )
        }
    };

    let parsed = subprocess::parse_clean_transcript(&result, &events, parse_pi_transcript);
    subprocess::finalize(HarnessName::Pi, &result, parsed, &limits, dir.cleanup())
}

/// Parses the closed Pi print-mode JSON vocabulary (R18): `session`,
/// `agent_start`, `turn_start`, `turn_end`, `message_start`, and
/// `message_end`. The terminal assistant `message_end` (stopReason `stop`,
/// `length`, `error`, or `aborted` with no tool calls — the run is
/// tool-less) decides the run. Anything else fails to one bounded terminal
/// whose detail never quotes the line (R19).
fn parse_pi_transcript(stdout: &[u8]) -> Result<(Vec<BackendEvent>, BackendTerminal), String> {
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
            "session" | "agent_start" | "turn_start" | "turn_end" | "message_start" => {}
            "message_end" => {
                let Some(message) = value.get("message") else {
                    return Err(format!("message_end without message at line {line_no}"));
                };
                if message.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
                    continue;
                }
                let stop_reason = message
                    .get("stopReason")
                    .and_then(serde_json::Value::as_str);
                let text = assistant_text(message);
                match stop_reason {
                    // Intermediate assistant turns (no tools run here, but
                    // the vocabulary tolerates the spelling) are ignored for
                    // the terminal decision.
                    None | Some("toolUse") => {}
                    Some("stop") => {
                        events.push(BackendEvent::AssistantText {
                            text,
                            finish_reason: None,
                        });
                        commit_terminal(
                            &mut terminal,
                            BackendTerminal::Completed {
                                finish_reason: FinishReason::Completed,
                            },
                            line_no,
                        )?;
                    }
                    // A length stop is still a completion (AE13): the exact
                    // length-class reason rides both the unit and the
                    // terminal so producer policy sees `length_capped`.
                    Some("length") => {
                        events.push(BackendEvent::AssistantText {
                            text,
                            finish_reason: Some(FinishReason::Length),
                        });
                        commit_terminal(
                            &mut terminal,
                            BackendTerminal::Completed {
                                finish_reason: FinishReason::Length,
                            },
                            line_no,
                        )?;
                    }
                    Some(reason @ ("error" | "aborted")) => {
                        let message_text = message
                            .get("errorMessage")
                            .and_then(serde_json::Value::as_str)
                            .map_or_else(
                                || format!("pi assistant stopped with reason \"{reason}\""),
                                ToOwned::to_owned,
                            );
                        commit_terminal(
                            &mut terminal,
                            BackendTerminal::Failed(BackendError {
                                class: subprocess::classify_failure_text(&message_text),
                                retry_after_secs: subprocess::retry_after_secs_in_text(
                                    &message_text,
                                ),
                                message: message_text,
                                provider_code: None,
                            }),
                            line_no,
                        )?;
                    }
                    Some(_) => {
                        return Err(format!("unknown stop reason at line {line_no}"));
                    }
                }
            }
            _ => return Err(format!("unknown event type at line {line_no}")),
        }
    }
    let Some(terminal) = terminal else {
        return Err("output ended without a terminal event".to_owned());
    };
    Ok((events, terminal))
}

/// Concatenates the `{type: "text"}` blocks of one Pi assistant message —
/// the same extraction `extractFinalAssistant` performs in
/// `subagent-runner.ts` (reasoning and tool blocks are excluded).
fn assistant_text(message: &serde_json::Value) -> String {
    let Some(content) = message.get("content").and_then(serde_json::Value::as_array) else {
        return String::new();
    };
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
            if let Some(part) = block.get("text").and_then(serde_json::Value::as_str) {
                text.push_str(part);
            }
        }
    }
    text
}
