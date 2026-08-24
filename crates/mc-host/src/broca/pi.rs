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
    BackendError, BackendEvent, BackendFuture, BackendRequest, BackendTerminal, ErrorClass,
    EventSink, FinishReason, LlmExecutionBackend,
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
        Box::pin(run_pi_with_provider_fallback(
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

/// Runs the aliased Pi provider first, then retries the canonical provider
/// once on a credential failure: a user authenticated through the direct
/// `openai`/`google` API-key providers has no credentials under the
/// subscription-extension aliases, and `subagent-runner.ts` resolves the
/// same ambiguity with the same alias-then-canonical order. Both attempts
/// share one wall-clock budget — the retry gets only the remainder — and a
/// first attempt whose private-directory cleanup failed forfeits the retry,
/// so a masking success can never hide material left on disk.
async fn run_pi_with_provider_fallback(
    descriptor: PiRuntimeDescriptor,
    thinking_level: Option<String>,
    limits: SubprocessLimits,
    env: EnvSnapshot,
    request: BackendRequest,
    events: EventSink,
    cancel: CancellationToken,
) -> BackendTerminal {
    let aliased = pi_model_ref(&request.provider, &request.model);
    let canonical = format!("{}/{}", request.provider, request.model);
    let started = tokio::time::Instant::now();
    let first = run_pi(
        descriptor.clone(),
        thinking_level.clone(),
        limits.clone(),
        env.clone(),
        request.clone(),
        events.clone(),
        cancel.clone(),
        aliased.clone(),
    )
    .await;
    // "cleanup failed" is the spelling `merge_cleanup` pins (and its
    // contract test asserts): an attempt that left private prompt material
    // on disk must surface that failure, not be replaced by a retry's
    // unqualified success.
    let credential_failure = matches!(
        &first,
        BackendTerminal::Failed(error) if error.class == ErrorClass::AuthRequired
            && !error.message.contains("cleanup failed")
    );
    if aliased == canonical || !credential_failure || cancel.is_cancelled() {
        return first;
    }
    let Some(remaining) = limits.run_timeout.checked_sub(started.elapsed()) else {
        return first;
    };
    if remaining.is_zero() {
        return first;
    }
    // The first terminal (and its potentially transcript-sized error text)
    // is no longer needed once the retry is committed; dropping it keeps
    // the concurrent-buffer peak inside the declared capture headroom.
    drop(first);
    let mut retry_limits = limits;
    retry_limits.run_timeout = remaining;
    run_pi(
        descriptor,
        thinking_level,
        retry_limits,
        env,
        request,
        events,
        cancel,
        canonical,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // One fully-specified child invocation; grouping would only rename the same set.
async fn run_pi(
    descriptor: PiRuntimeDescriptor,
    thinking_level: Option<String>,
    limits: SubprocessLimits,
    env: EnvSnapshot,
    request: BackendRequest,
    events: EventSink,
    cancel: CancellationToken,
    model_ref: String,
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
    args.push(model_ref);
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

    let result = match subprocess::run(spec, &limits, &cancel, Some(pi_terminal_probe)).await {
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

/// Reports whether a region of newly completed stdout lines contains the
/// decisive terminal event, so the drain loop can arm its grace instead of
/// waiting for pipe EOF: Pi's print mode often finishes the agent loop
/// without exiting (the shutdown gap `subagent-runner.ts` documents), and
/// its open stdout would otherwise hold the run until the full timeout and
/// discard the completed answer. The caller feeds each complete line
/// exactly once, so probing stays linear; arming early on a transcript the
/// full parse later rejects only shortens the wait for the same failure.
fn pi_terminal_probe(lines: &[u8]) -> bool {
    lines
        .split(|byte| *byte == b'\n')
        .any(pi_line_is_terminal_message_end)
}

/// One-line check for a decisive terminal — an assistant `message_end`
/// (stopReason `stop`, `length`, `error`, or `aborted`) or the `agent_end`
/// compatibility shape carrying a final assistant message — the probe-side
/// mirror of the terminal decision in [`parse_pi_transcript`], including
/// the rule that a completion still requesting tools is not this run's
/// terminal. Noise and malformed lines are simply not terminals here; the
/// full parse renders that verdict.
fn pi_line_is_terminal_message_end(line: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(line) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let message = match value.get("type").and_then(serde_json::Value::as_str) {
        Some("message_end") => value.get("message"),
        Some("agent_end") => value
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .and_then(|messages| {
                messages.iter().rev().find(|message| {
                    message.get("role").and_then(serde_json::Value::as_str) == Some("assistant")
                })
            }),
        _ => None,
    };
    let Some(message) = message else {
        return false;
    };
    if message.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
        return false;
    }
    match message
        .get("stopReason")
        .and_then(serde_json::Value::as_str)
    {
        Some("stop" | "length") => !message_requests_tools(message),
        Some("error" | "aborted") => true,
        _ => false,
    }
}

/// Parses the closed Pi print-mode JSON vocabulary (R18). The terminal
/// assistant `message_end` (stopReason `stop`, `length`, `error`, or
/// `aborted` with no tool calls — the run is tool-less) decides the run;
/// when no `message_end` terminal arrived, the `agent_end` compatibility
/// shape's final assistant message decides instead (the authoritative array
/// `subagent-runner.ts` reads on older Pi runtimes).
/// Documented nonterminal events that occur on ordinary tool-less runs
/// (lifecycle, compaction, retry, queue, and session-state notifications;
/// `--thinking` emits `thinking_level_changed`) are ignored, but
/// `tool_execution_*` events are rejected: this path is a zero-tool
/// transform, so observed tool activity is a transcript-contract failure —
/// the same rule the OpenCode parser applies to `tool_use`. Lines that do
/// not claim to be JSON objects are extension stdout noise (a co-loaded
/// provider extension printing "[Worker] Ready" — the classification
/// `subagent-runner.ts` uses) and are skipped; a line that starts with `{`
/// but fails to parse, or any undocumented event, still fails to one
/// bounded terminal whose detail never quotes the line (R19).
fn parse_pi_transcript(stdout: &[u8]) -> Result<(Vec<BackendEvent>, BackendTerminal), String> {
    let mut events = Vec::new();
    let mut terminal: Option<BackendTerminal> = None;
    for (index, line) in stdout.split(|byte| *byte == b'\n').enumerate() {
        if line.is_empty() {
            continue;
        }
        if line
            .iter()
            .find(|byte| !byte.is_ascii_whitespace())
            .copied()
            != Some(b'{')
        {
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
            "session"
            | "agent_start"
            | "turn_start"
            | "turn_end"
            | "message_start"
            | "message_update"
            | "compaction_start"
            | "compaction_end"
            | "auto_retry_start"
            | "auto_retry_end"
            | "queue_update"
            | "session_info_changed"
            | "thinking_level_changed" => {}
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                return Err(format!(
                    "tool execution event in a tool-less run at line {line_no}"
                ));
            }
            "message_end" => {
                let Some(message) = value.get("message") else {
                    return Err(format!("message_end without message at line {line_no}"));
                };
                if message.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
                    continue;
                }
                commit_assistant_message(&mut events, &mut terminal, message, line_no)?;
            }
            "agent_end" => {
                // Compatibility: an older Pi delivers its final state only
                // in `agent_end`'s authoritative messages array — the shape
                // `subagent-runner.ts` reads. A stream that already
                // committed its terminal via `message_end` keeps it, so the
                // two spellings never conflict.
                if terminal.is_some() {
                    continue;
                }
                let Some(message) = value
                    .get("messages")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|messages| {
                        messages.iter().rev().find(|message| {
                            message.get("role").and_then(serde_json::Value::as_str)
                                == Some("assistant")
                        })
                    })
                else {
                    continue;
                };
                commit_assistant_message(&mut events, &mut terminal, message, line_no)?;
            }
            _ => return Err(format!("unknown event type at line {line_no}")),
        }
    }
    let Some(terminal) = terminal else {
        return Err("output ended without a terminal event".to_owned());
    };
    Ok((events, terminal))
}

/// Applies the terminal decision for one assistant message, shared by
/// `message_end` and the `agent_end` compatibility shape: `stop` and
/// `length` complete the run unless the content still requests tools,
/// `error`/`aborted` fail it, and intermediate spellings are ignored.
fn commit_assistant_message(
    events: &mut Vec<BackendEvent>,
    terminal: &mut Option<BackendTerminal>,
    message: &serde_json::Value,
    line_no: usize,
) -> Result<(), String> {
    let stop_reason = message
        .get("stopReason")
        .and_then(serde_json::Value::as_str);
    let text = assistant_text(message);
    match stop_reason {
        // Intermediate assistant turns (no tools run here, but
        // the vocabulary tolerates the spelling) are ignored for
        // the terminal decision.
        None | Some("toolUse") => {}
        // A completion that still requests tools is an
        // intermediate turn shape, not this tool-less run's
        // terminal (`subagent-runner.ts` applies the same rule):
        // committing it would publish text beside an unexecuted
        // tool request as the answer.
        Some("stop" | "length") if message_requests_tools(message) => {}
        Some("stop") => {
            events.push(BackendEvent::AssistantText {
                text,
                finish_reason: None,
            });
            commit_terminal(
                terminal,
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
                terminal,
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
                terminal,
                BackendTerminal::Failed(BackendError {
                    class: subprocess::classify_failure_text(&message_text),
                    retry_after_secs: subprocess::retry_after_secs_in_text(&message_text),
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
    Ok(())
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

/// Whether an assistant message's content still carries a `toolCall` block:
/// `subagent-runner.ts` treats a stop as terminal only when no such block is
/// present, and this run executes without tools.
fn message_requests_tools(message: &serde_json::Value) -> bool {
    message
        .get("content")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|content| {
            content.iter().any(|block| {
                block.get("type").and_then(serde_json::Value::as_str) == Some("toolCall")
            })
        })
}
