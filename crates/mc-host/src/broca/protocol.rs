//! The five-operation Broca application protocol (R3, R6-R8): strict
//! bounded request decoding and the canonical response/event encoders whose
//! JSON shapes `mc-module`'s `HistorianProducer` consumes today.
//!
//! Reuses the strict envelope, object-only, and depth-scanning machinery
//! from `crate::synapse::protocol` rather than a second parsing stack: both
//! surfaces must classify malformed, duplicate-keyed, over-depth,
//! over-bound, binary, unknown-method, and unknown-field bodies identically,
//! before any state exists (R3).

use crate::control::check_string;
use crate::synapse::protocol::{
    depth_exceeds, schema, MapOnly, MethodEnvelope, NoParams, OptionalParams, RequiredParams,
};

pub use crate::synapse::protocol::RequestError;

use super::backend::{BackendError, FinishReason, Harness};
use super::config::{MAX_OUTPUT_TOKENS_BOUND, MAX_SEND_BODY_BYTES, TEMPERATURE_RANGE};

/// Whole-body structural depth cap, matching the profile convention set by
/// the Synapse surface: level eight is valid, level nine is not.
const MAX_BODY_DEPTH: usize = 8;
/// Bound on encoded diagnostic strings inside error units, so a provider
/// failure can never bloat replay past the terminal headroom (R12, R19).
const MAX_UNIT_DIAGNOSTIC_BYTES: usize = 512;
pub const MAX_RUN_ID_BYTES: usize = 128;
const MAX_MODEL_FIELD_BYTES: usize = 256;

/// Exact `run.status` vocabulary (R7). No aliases, no substrings: producers
/// switch on these strings verbatim.
pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_MISSING: &str = "missing";

/// One strictly decoded Broca operation. Anything not representable here was
/// rejected before any run state could exist (R3).
#[derive(Debug, PartialEq)]
pub enum Request {
    Send(SendRequest),
    Subscribe,
    Status { run_id: String },
    Cancel { run_id: String },
    Delete,
}

/// Validated `session.send` parameters (R6). Owned strings because the
/// supervisor retains them for the run's lifetime anyway; at the 512 KiB
/// body cap the owned copy is cheap enough that borrowing buys nothing.
#[derive(Clone, PartialEq)]
pub struct SendRequest {
    pub prompt: String,
    pub system: Option<String>,
    pub provider: String,
    pub model: String,
    pub max_output_tokens: u64,
    pub temperature: f64,
}

impl SendRequest {
    /// Logical bytes the supervisor retains for this request while the run
    /// exists — the term R12's "immutable request bytes" charges.
    pub(crate) fn retained_bytes(&self) -> usize {
        self.prompt
            .len()
            .saturating_add(self.system.as_ref().map_or(0, String::len))
            .saturating_add(self.provider.len())
            .saturating_add(self.model.len())
    }
}

impl std::fmt::Debug for SendRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Prompt and system text are the caller's private content (R19):
        // diagnostics report lengths only.
        f.debug_struct("SendRequest")
            .field("prompt_len", &self.prompt.len())
            .field("system_len", &self.system.as_ref().map(String::len))
            .field("provider_len", &self.provider.len())
            .field("model_len", &self.model.len())
            .field("max_output_tokens", &self.max_output_tokens)
            .field("temperature", &self.temperature)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Request schema. Closed structs throughout: `deny_unknown_fields` refuses
// junk at the key, derived deserialization rejects duplicate fields, and
// `MapOnly` refuses the positional-sequence form for every object.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SendParams {
    prompt: String,
    model: MapOnly<ModelParams>,
    #[serde(rename = "tools")]
    _tools: EmptyTools,
    generation: MapOnly<GenerationParams>,
    #[serde(default)]
    system: Option<String>,
}

/// The nested `{provider, model}` object `HistorianProducer` sends after
/// splitting its canonical `provider/model` string at the first slash.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelParams {
    provider: String,
    model: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerationParams {
    max_output_tokens: u64,
    temperature: f64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SubscribeParams {
    from: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RunIdParams {
    run_id: String,
}

/// Accepts exactly `[]`. R6 requires an *empty* tools array — a present key
/// proving the caller holds the tool-less contract — so the first element,
/// whatever it is, fails the whole request before it is even decoded.
struct EmptyTools;

impl<'de> serde::Deserialize<'de> for EmptyTools {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EmptyVisitor;

        impl<'de> serde::de::Visitor<'de> for EmptyVisitor {
            type Value = EmptyTools;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an empty tools array")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                    return Err(serde::de::Error::custom("tools must be an empty array"));
                }
                Ok(EmptyTools)
            }
        }

        deserializer.deserialize_seq(EmptyVisitor)
    }
}

fn decode<'a, T: serde::Deserialize<'a>>(body: &'a [u8]) -> Result<T, RequestError> {
    serde_json::from_slice(body).map_err(|err| schema(err.to_string()))
}

/// No-allocation checks that run before any deserializer byte is read:
/// binary rejection, the 512 KiB body cap, and the structural depth bound
/// (R3, R6). Runs before the supervisor is ever consulted, so an oversize
/// body is rejected before backend admission.
fn preflight(body: &[u8], binary: bool) -> Result<(), RequestError> {
    if binary {
        return Err(schema("broca requests are JSON only"));
    }
    if body.len() > MAX_SEND_BODY_BYTES {
        return Err(schema("request body exceeds the 512 KiB cap"));
    }
    if depth_exceeds(body, MAX_BODY_DEPTH) {
        return Err(schema("request body too deeply nested"));
    }
    Ok(())
}

/// Typed decode after [`preflight`]. Only the five contract methods exist;
/// anything else is refused without creating state (R3).
fn decode_request(body: &[u8]) -> Result<Request, RequestError> {
    let envelope: MapOnly<MethodEnvelope> = decode(body)?;
    match envelope.0.method.as_ref() {
        "session.send" => {
            let envelope: MapOnly<RequiredParams<SendParams>> = decode(body)?;
            parse_send(envelope.0.params.0)
        }
        "session.subscribe" => {
            let envelope: MapOnly<RequiredParams<SubscribeParams>> = decode(body)?;
            // `start` is the only supported replay origin: cursor replay is
            // exclusive and can drop units on reattach, which is why the
            // producer always re-drains from the beginning (R8).
            if envelope.0.params.0.from != "start" {
                return Err(schema("subscribe supports only from=\"start\""));
            }
            Ok(Request::Subscribe)
        }
        "run.status" => {
            let envelope: MapOnly<RequiredParams<RunIdParams>> = decode(body)?;
            let run_id = parse_run_id(envelope.0.params.0)?;
            Ok(Request::Status { run_id })
        }
        "run.cancel" => {
            let envelope: MapOnly<RequiredParams<RunIdParams>> = decode(body)?;
            let run_id = parse_run_id(envelope.0.params.0)?;
            Ok(Request::Cancel { run_id })
        }
        "session.delete" => {
            // The session is the route identity; the producer sends empty
            // params and nothing else is accepted.
            let _: MapOnly<OptionalParams<NoParams>> = decode(body)?;
            Ok(Request::Delete)
        }
        _ => Err(schema("unsupported broca method")),
    }
}

/// [`preflight`] plus [`decode_request`], for callers that hold the whole
/// body — the composition the component's `handle` uses.
pub fn parse_request(body: &[u8], binary: bool) -> Result<Request, RequestError> {
    preflight(body, binary)?;
    decode_request(body)
}

fn parse_run_id(params: RunIdParams) -> Result<String, RequestError> {
    check_string("run_id", &params.run_id, MAX_RUN_ID_BYTES, true).map_err(schema)?;
    Ok(params.run_id)
}

fn parse_send(params: SendParams) -> Result<Request, RequestError> {
    // The body cap already bounds prompt and system size; check_string adds
    // the nonempty and NUL rules.
    check_string("prompt", &params.prompt, MAX_SEND_BODY_BYTES, true).map_err(schema)?;
    let model = params.model.0;
    check_string("provider", &model.provider, MAX_MODEL_FIELD_BYTES, true).map_err(schema)?;
    check_string("model", &model.model, MAX_MODEL_FIELD_BYTES, true).map_err(schema)?;
    // The canonical form splits at the FIRST slash, so a slash inside the
    // provider segment could never have come from a canonical string and
    // would make the round trip ambiguous.
    if model.provider.contains('/') {
        return Err(schema("provider must not contain '/'"));
    }
    // Both fields become one argv token (`--model provider/model`) for the
    // harness CLI. A leading '-' would make that token flag-shaped to the
    // child's own argument parser, turning request data into an option —
    // rejected here, before any adapter builds argv, so no adapter can
    // forget the rule.
    if model.provider.starts_with('-') {
        return Err(schema("provider must not start with '-'"));
    }
    if model.model.starts_with('-') {
        return Err(schema("model must not start with '-'"));
    }
    let system = match params.system {
        None => None,
        Some(system) => {
            // The wire's empty-as-absent rule: producers omit an empty
            // system, so an explicit empty string is a malformed request
            // rather than a second spelling of "absent".
            check_string("system", &system, MAX_SEND_BODY_BYTES, true).map_err(schema)?;
            Some(system)
        }
    };
    let generation = params.generation.0;
    if generation.max_output_tokens == 0 || generation.max_output_tokens > MAX_OUTPUT_TOKENS_BOUND {
        return Err(schema("max_output_tokens out of bounds"));
    }
    if !generation.temperature.is_finite() || !TEMPERATURE_RANGE.contains(&generation.temperature) {
        return Err(schema("temperature out of bounds"));
    }
    Ok(Request::Send(SendRequest {
        prompt: params.prompt,
        system,
        provider: model.provider,
        model: model.model,
        max_output_tokens: generation.max_output_tokens,
        temperature: generation.temperature,
    }))
}

// ---------------------------------------------------------------------------
// Response and event encoding. Field names are pinned by what
// `HistorianProducer` parses today (its `unit_*` helpers and
// `classify_run_state`); changing any name here breaks the Rust consumer.
// ---------------------------------------------------------------------------

pub fn send_response_body(run_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "run_id": run_id })).expect("send response serializes")
}

pub fn status_response_body(run_id: &str, state: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "run_id": run_id, "state": state }))
        .expect("status response serializes")
}

/// Shared by `run.cancel` and `session.delete`: both settle unary after
/// their lifecycle work completes, and the producer discards the body.
pub fn ok_response_body() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true })).expect("ok response serializes")
}

/// Wraps a unit in the `{kind: "control", unit}` envelope the producer's
/// `control_unit` helper unwraps.
fn control_event(unit: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "kind": "control", "unit": unit }))
        .expect("control event serializes")
}

pub fn run_started_unit(run_id: &str) -> Vec<u8> {
    control_event(serde_json::json!({ "type": "run_started", "run_id": run_id }))
}

pub fn harness_dispatch_unit(run_id: &str, harness: Harness) -> Vec<u8> {
    control_event(serde_json::json!({
        "type": "harness_dispatch",
        "run_id": run_id,
        "harness": harness.as_str(),
    }))
}

/// Assistant text in the nested content-block shape the producer's
/// `unit_text` extracts; a step-level length-class finish reason rides the
/// unit's own `finish_reason` field (R18).
pub fn assistant_message_unit(
    run_id: &str,
    text: &str,
    finish_reason: Option<FinishReason>,
) -> Vec<u8> {
    let mut unit = serde_json::json!({
        "type": "assistant_message",
        "run_id": run_id,
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": text }],
        },
    });
    if let Some(reason) = finish_reason {
        unit["finish_reason"] = reason.as_wire_str().into();
    }
    control_event(unit)
}

/// The successful in-band terminal (R8). Length-class reasons survive here
/// verbatim so a length-capped completion never masquerades as an error.
pub fn run_finished_unit(run_id: &str, finish_reason: FinishReason) -> Vec<u8> {
    control_event(serde_json::json!({
        "type": "run_finished",
        "run_id": run_id,
        "finish_reason": finish_reason.as_wire_str(),
    }))
}

/// The classified in-band error terminal (R8, R18). The producer reads
/// `class`, `message`, and `retry_after_secs` from the nested `error`
/// object; the message is truncated so a provider failure cannot outgrow the
/// terminal headroom or leak unbounded provider output (R12, R19).
pub fn error_unit(run_id: &str, error: &BackendError) -> Vec<u8> {
    let mut body = serde_json::json!({
        "class": error.class.as_wire_str(),
        "message": bounded(&error.message),
    });
    if let Some(secs) = error.retry_after_secs {
        body["retry_after_secs"] = secs.into();
    }
    if let Some(code) = &error.provider_code {
        body["provider_code"] = bounded(code).into();
    }
    control_event(serde_json::json!({
        "type": "error",
        "run_id": run_id,
        "error": body,
    }))
}

/// Truncates a diagnostic so its JSON-ENCODED form stays within
/// [`MAX_UNIT_DIAGNOSTIC_BYTES`]: escaping expands `"`/`\\` and short-escape
/// controls to two bytes and other control characters to six (`\u00XX`), so
/// a raw-byte bound alone would let two 512-byte fields encode to ~6 KiB and
/// overrun the terminal headroom charged at admission.
fn bounded(value: &str) -> &str {
    let mut encoded = 0usize;
    for (index, c) in value.char_indices() {
        encoded += match c {
            '"' | '\\' | '\n' | '\r' | '\t' | '\x08' | '\x0c' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        };
        if encoded > MAX_UNIT_DIAGNOSTIC_BYTES {
            return &value[..index];
        }
    }
    value
}
