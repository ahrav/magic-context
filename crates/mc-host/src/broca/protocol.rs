//!

use crate::control::check_string;
use crate::synapse::protocol::{
    depth_exceeds, schema, MapOnly, MethodEnvelope, NoParams, OptionalParams, RequiredParams,
};

pub use crate::synapse::protocol::RequestError;

use super::backend::{BackendError, FinishReason, Harness};
use super::config::{MAX_OUTPUT_TOKENS_BOUND, MAX_SEND_BODY_BYTES, TEMPERATURE_RANGE};

const MAX_BODY_DEPTH: usize = 8;
/// The encoder caps error-unit diagnostics at 512 bytes to preserve terminal replay headroom.
const MAX_UNIT_DIAGNOSTIC_BYTES: usize = 512;
pub const MAX_RUN_ID_BYTES: usize = 128;
const MAX_MODEL_FIELD_BYTES: usize = 256;

pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_MISSING: &str = "missing";

#[derive(Debug, PartialEq)]
pub enum Request {
    Send(SendRequest),
    Subscribe,
    Status { run_id: String },
    Cancel { run_id: String },
    Delete,
}

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
        // Prompt and system text are caller-private content:
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
// Closed request structs reject unknown and duplicate fields.
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

/// `tools` must be present and equal `[]`.
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

/// The pre-deserialization checks allocate nothing and read no body bytes.
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

fn decode_request(body: &[u8]) -> Result<Request, RequestError> {
    let envelope: MapOnly<MethodEnvelope> = decode(body)?;
    match envelope.0.method.as_ref() {
        "session.send" => {
            let envelope: MapOnly<RequiredParams<SendParams>> = decode(body)?;
            parse_send(envelope.0.params.0)
        }
        "session.subscribe" => {
            let envelope: MapOnly<RequiredParams<SubscribeParams>> = decode(body)?;
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
            let _: MapOnly<OptionalParams<NoParams>> = decode(body)?;
            Ok(Request::Delete)
        }
        _ => Err(schema("unsupported broca method")),
    }
}

pub fn parse_request(body: &[u8], binary: bool) -> Result<Request, RequestError> {
    preflight(body, binary)?;
    decode_request(body)
}

fn parse_run_id(params: RunIdParams) -> Result<String, RequestError> {
    check_string("run_id", &params.run_id, MAX_RUN_ID_BYTES, true).map_err(schema)?;
    Ok(params.run_id)
}

fn parse_send(params: SendParams) -> Result<Request, RequestError> {
    // The body cap bounds `prompt` and `system`; `check_string` enforces nonempty, NUL-free values.
    check_string("prompt", &params.prompt, MAX_SEND_BODY_BYTES, true).map_err(schema)?;
    let model = params.model.0;
    check_string("provider", &model.provider, MAX_MODEL_FIELD_BYTES, true).map_err(schema)?;
    check_string("model", &model.model, MAX_MODEL_FIELD_BYTES, true).map_err(schema)?;
    // Reject `/` in `provider` because canonical `provider/model` splits at the first slash.
    if model.provider.contains('/') {
        return Err(schema("provider must not contain '/'"));
    }
    // Reject leading `-` in `provider` and `model`: `--model provider/model` would otherwise pass request data as a CLI option.
    // The request validator applies the leading-dash restriction before adapter argv construction so every adapter enforces it.
    if model.provider.starts_with('-') {
        return Err(schema("provider must not start with '-'"));
    }
    if model.model.starts_with('-') {
        return Err(schema("model must not start with '-'"));
    }
    let system = match params.system {
        None => None,
        Some(system) => {
            // Reject empty `system`: producers omit it, so accepting `""` would create a second encoding for absence.
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
// Response and event field names must remain compatible with `HistorianProducer`'s `unit_*` helpers and `classify_run_state`.
// ---------------------------------------------------------------------------

pub fn send_response_body(run_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "run_id": run_id })).expect("send response serializes")
}

pub fn status_response_body(run_id: &str, state: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "run_id": run_id, "state": state }))
        .expect("status response serializes")
}

pub fn ok_response_body() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true })).expect("ok response serializes")
}

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

/// `assistant_message_unit` emits the nested content-block shape consumed by `unit_text`.
/// `finish_reason` is unit-level rather than nested under `message`.
/// Length-class finish reasons use the unit-level `finish_reason` field.
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

/// `run_finished` is the successful in-band terminal.
/// Preserving length-class reasons prevents length-capped completions from being reported as errors.
pub fn run_finished_unit(run_id: &str, finish_reason: FinishReason) -> Vec<u8> {
    control_event(serde_json::json!({
        "type": "run_finished",
        "run_id": run_id,
        "finish_reason": finish_reason.as_wire_str(),
    }))
}

/// `error` is the classified in-band error terminal.
/// `bounded` prevents provider messages from exceeding the diagnostic byte limit after JSON escaping.
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

/// `bounded` counts JSON-escaped bytes before truncating diagnostics.
/// `bounded` charges two bytes for `"`, `\\`, and short JSON escapes.
/// Other ASCII control characters require six JSON-escaped bytes.
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
