//! The four-operation Synapse application protocol: strict request
//! validation, the cross-language canonical request key, and response
//! encoding.

use sha2::{Digest, Sha256};

use super::jobs::BatchItem;
use super::LaneInfo;
use super::SynapseLimits;

const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_BODY_DEPTH: usize = 8;
const MAX_ID_BYTES: usize = 256;
const MAX_JOB_ID_BYTES: usize = 128;
const MAX_CURSOR_BYTES: usize = 128;
pub(crate) const MAX_DEADLINE_MS: u64 = 3_600_000;

/// One classified request failure: a stable application error code plus a
/// bounded diagnostic message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestError {
    pub code: &'static str,
    pub message: String,
}

fn schema(message: impl Into<String>) -> RequestError {
    RequestError {
        code: "schema_violation",
        message: message.into(),
    }
}

fn substitution(message: impl Into<String>) -> RequestError {
    RequestError {
        code: "substitution_rejected",
        message: message.into(),
    }
}

#[derive(Debug, PartialEq)]
pub enum Request {
    ModelsList,
    EmbedQuery {
        text: String,
        deadline_ms: Option<u64>,
    },
    EmbedBatch {
        request_key: String,
        canonical_key: String,
        items: Vec<BatchItem>,
    },
    EmbedResult {
        job_id: String,
        request_key: String,
        cursor: Option<String>,
    },
}

pub fn parse_request(
    body: &[u8],
    binary: bool,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    if binary {
        return Err(schema("synapse requests are JSON only"));
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(schema("request body exceeds the profile cap"));
    }
    let root = crate::control::strict_json::parse(body)
        .map_err(|_| schema("request body is not strict JSON"))?;
    let serde_json::Value::Object(fields) = root else {
        return Err(schema("request body must be a JSON object"));
    };
    if fields
        .values()
        .map(value_depth)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        > MAX_BODY_DEPTH
    {
        return Err(schema("request body too deeply nested"));
    }
    let Some(serde_json::Value::String(method)) = fields.get("method") else {
        return Err(schema("method must be a string"));
    };
    let params = match fields.get("params") {
        None => &serde_json::Map::new(),
        Some(serde_json::Value::Object(params)) => params,
        Some(_) => return Err(schema("params must be an object")),
    };
    match method.as_str() {
        "models.list" => {
            if !params.is_empty() {
                return Err(schema("models.list takes no parameters"));
            }
            Ok(Request::ModelsList)
        }
        "embed.query" => parse_query(params, lane, limits),
        "embed.batch" => parse_batch(params, lane, limits),
        "embed.result" => parse_result(params, lane),
        _ => Err(schema("unsupported synapse method")),
    }
}

/// Fixed lane constraints on every `embed.*` request: exact model,
/// fingerprint, epoch, and both substitution flags literally false. A wrong
/// value is a rejected substitution — the service never adapts to another
/// embedding space.
fn check_constraints(
    params: &serde_json::Map<String, serde_json::Value>,
    lane: &LaneInfo,
) -> Result<(), RequestError> {
    let Some(serde_json::Value::String(model)) = params.get("model") else {
        return Err(schema("model must be a string"));
    };
    if *model != lane.model {
        return Err(substitution("requested model is not served by this lane"));
    }
    let Some(serde_json::Value::String(fingerprint)) = params.get("required_fingerprint") else {
        return Err(schema("required_fingerprint must be a string"));
    };
    if *fingerprint != lane.fingerprint {
        return Err(substitution("required fingerprint does not match"));
    }
    let Some(epoch) = params.get("required_epoch").and_then(|v| v.as_u64()) else {
        return Err(schema("required_epoch must be an unsigned integer"));
    };
    if epoch != lane.table_epoch {
        return Err(substitution("required table epoch does not match"));
    }
    for flag in ["allow_equivalent", "accept_declared"] {
        match params.get(flag) {
            Some(serde_json::Value::Bool(false)) => {}
            Some(serde_json::Value::Bool(true)) => {
                return Err(substitution(format!("{flag} must be false")));
            }
            _ => return Err(schema(format!("{flag} must be a boolean"))),
        }
    }
    Ok(())
}

fn known_fields(
    params: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
) -> Result<(), RequestError> {
    for key in params.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(schema(format!("unexpected field: {key}")));
        }
    }
    Ok(())
}

const CONSTRAINT_FIELDS: [&str; 5] = [
    "model",
    "required_fingerprint",
    "required_epoch",
    "allow_equivalent",
    "accept_declared",
];

fn parse_query(
    params: &serde_json::Map<String, serde_json::Value>,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    let mut allowed = CONSTRAINT_FIELDS.to_vec();
    allowed.extend(["text", "deadline_ms"]);
    known_fields(params, &allowed)?;
    check_constraints(params, lane)?;
    let Some(serde_json::Value::String(text)) = params.get("text") else {
        return Err(schema("text must be a string"));
    };
    if text.is_empty() || text.len() > limits.max_text_bytes {
        return Err(schema("text length out of bounds"));
    }
    let deadline_ms = match params.get("deadline_ms") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let Some(ms) = value.as_u64() else {
                return Err(schema("deadline_ms must be an unsigned integer"));
            };
            if ms == 0 || ms > MAX_DEADLINE_MS {
                return Err(schema("deadline_ms out of bounds"));
            }
            Some(ms)
        }
    };
    Ok(Request::EmbedQuery {
        text: text.clone(),
        deadline_ms,
    })
}

fn parse_batch(
    params: &serde_json::Map<String, serde_json::Value>,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    let mut allowed = CONSTRAINT_FIELDS.to_vec();
    allowed.extend(["request_key", "items"]);
    known_fields(params, &allowed)?;
    check_constraints(params, lane)?;
    let Some(serde_json::Value::String(request_key)) = params.get("request_key") else {
        return Err(schema("request_key must be a string"));
    };
    if !is_lower_hex_64(request_key) {
        return Err(schema("request_key must be 64 lowercase hex characters"));
    }
    let Some(serde_json::Value::Array(raw_items)) = params.get("items") else {
        return Err(schema("items must be an array"));
    };
    if raw_items.is_empty() || raw_items.len() > limits.max_batch_items {
        return Err(schema("item count out of bounds"));
    }
    let mut items = Vec::with_capacity(raw_items.len());
    let mut total_text_bytes = 0usize;
    for raw in raw_items {
        let serde_json::Value::Object(fields) = raw else {
            return Err(schema("each item must be an object"));
        };
        known_fields(fields, &["id", "text", "content_sha256"])?;
        let Some(serde_json::Value::String(id)) = fields.get("id") else {
            return Err(schema("item id must be a string"));
        };
        if id.is_empty() || id.len() > MAX_ID_BYTES {
            return Err(schema("item id length out of bounds"));
        }
        let Some(serde_json::Value::String(text)) = fields.get("text") else {
            return Err(schema("item text must be a string"));
        };
        if text.is_empty() || text.len() > limits.max_text_bytes {
            return Err(schema("item text length out of bounds"));
        }
        total_text_bytes += text.len();
        let Some(serde_json::Value::String(supplied_hash)) = fields.get("content_sha256") else {
            return Err(schema("item content_sha256 must be a string"));
        };
        // Recomputed, never trusted: a wrong supplied hash would poison the
        // durable ledger's content identity.
        let actual = sha256_hex(text.as_bytes());
        if *supplied_hash != actual {
            return Err(schema("item content_sha256 does not match its text"));
        }
        if items.iter().any(|existing: &BatchItem| existing.id == *id) {
            return Err(schema("duplicate item id"));
        }
        items.push(BatchItem {
            id: id.clone(),
            content_sha256: actual,
            text: text.clone(),
        });
    }
    if total_text_bytes > limits.max_batch_text_bytes {
        return Err(schema("aggregate item text exceeds the batch cap"));
    }
    // The canonical/supplied comparison happens at admission, where a
    // mismatch against a RETAINED key classifies as idempotency_conflict
    // rather than schema_violation.
    let canonical_key = canonical_request_key(lane, &items);
    Ok(Request::EmbedBatch {
        request_key: request_key.clone(),
        canonical_key,
        items,
    })
}

fn parse_result(
    params: &serde_json::Map<String, serde_json::Value>,
    lane: &LaneInfo,
) -> Result<Request, RequestError> {
    let mut allowed = CONSTRAINT_FIELDS.to_vec();
    allowed.extend(["job_id", "request_key", "cursor"]);
    known_fields(params, &allowed)?;
    check_constraints(params, lane)?;
    let Some(serde_json::Value::String(job_id)) = params.get("job_id") else {
        return Err(schema("job_id must be a string"));
    };
    if job_id.is_empty() || job_id.len() > MAX_JOB_ID_BYTES {
        return Err(schema("job_id length out of bounds"));
    }
    let Some(serde_json::Value::String(request_key)) = params.get("request_key") else {
        return Err(schema("request_key must be a string"));
    };
    if !is_lower_hex_64(request_key) {
        return Err(schema("request_key must be 64 lowercase hex characters"));
    }
    let cursor = match params.get("cursor") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(cursor)) => {
            if cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES {
                return Err(schema("cursor length out of bounds"));
            }
            Some(cursor.clone())
        }
        Some(_) => return Err(schema("cursor must be a string or null")),
    };
    Ok(Request::EmbedResult {
        job_id: job_id.clone(),
        request_key: request_key.clone(),
        cursor,
    })
}

/// SHA-256 over the stable JSON object shared with the TypeScript
/// `getSynapseBatchRequestKey`: sorted keys, JavaScript `JSON.stringify`
/// string escaping (which `serde_json` matches byte for byte), ordered IDs,
/// and ordered recomputed content hashes.
pub fn canonical_request_key(lane: &LaneInfo, items: &[BatchItem]) -> String {
    let mut canonical = String::with_capacity(256);
    canonical
        .push_str("{\"accept_declared\":false,\"allow_equivalent\":false,\"content_sha256\":[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            canonical.push(',');
        }
        canonical.push_str(&json_string(&item.content_sha256));
    }
    canonical.push_str("],\"ids\":[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            canonical.push(',');
        }
        canonical.push_str(&json_string(&item.id));
    }
    canonical.push_str("],\"model\":");
    canonical.push_str(&json_string(&lane.model));
    canonical.push_str(",\"op\":\"embed.batch\",\"required_epoch\":");
    canonical.push_str(&lane.table_epoch.to_string());
    canonical.push_str(",\"required_fingerprint\":");
    canonical.push_str(&json_string(&lane.fingerprint));
    canonical.push('}');
    sha256_hex(canonical.as_bytes())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization cannot fail")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn value_depth(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => 1 + items.iter().map(value_depth).max().unwrap_or(0),
        serde_json::Value::Object(map) => 1 + map.values().map(value_depth).max().unwrap_or(0),
        _ => 1,
    }
}

// ---------------------------------------------------------------------------
// Response encoding. Every vector-bearing body carries the complete lane
// identity so the client can bind each vector to the requested space.
// ---------------------------------------------------------------------------

pub fn models_list_body(lane: &LaneInfo) -> Vec<u8> {
    let body = serde_json::json!({
        "result": {
            "models": [{
                "model": lane.model,
                "fingerprint": lane.fingerprint,
                "table_epoch": lane.table_epoch,
                "dims": lane.dims,
                "max_input_tokens": lane.max_tokens,
                "certified": true,
                "status": "ready",
                "provenance": lane.provenance,
                "recommended_batch": {
                    "rows": lane.recommended_rows,
                    "token_budget": lane.recommended_token_budget,
                },
            }],
        },
    });
    serde_json::to_vec(&body).expect("models.list body serializes")
}

/// One borrowed result item. Vector-bearing bodies are serialized straight
/// from the job table's own buffers: an intermediate `serde_json::Value` tree
/// holds roughly ten bytes per component, so materializing one for a
/// page-capped body would put megabytes outside the host's resident-byte
/// budget before any reservation exists.
pub struct VectorItemView<'a> {
    pub id: &'a str,
    pub content_sha256: &'a str,
    pub vector: &'a [f32],
}

#[derive(serde::Serialize)]
struct VectorItemBody<'a> {
    id: &'a str,
    content_sha256: &'a str,
    vector: &'a [f32],
}

#[derive(serde::Serialize)]
struct VectorResultBody<'a> {
    model: &'a str,
    fingerprint: &'a str,
    table_epoch: u64,
    dims: usize,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<&'a str>,
    vectors: VectorItemsBody<'a>,
}

#[derive(serde::Serialize)]
struct VectorBody<'a> {
    result: VectorResultBody<'a>,
}

/// Streams the item array without collecting an owned intermediate.
struct VectorItemsBody<'a>(&'a [VectorItemView<'a>]);

impl serde::Serialize for VectorItemsBody<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for item in self.0 {
            seq.serialize_element(&VectorItemBody {
                id: item.id,
                content_sha256: item.content_sha256,
                vector: item.vector,
            })?;
        }
        seq.end()
    }
}

/// Fixed JSON envelope around a vector-bearing body: the `result` wrapper,
/// the lane-identity and paging field names, and the array punctuation.
/// Deliberately generous, because this feeds an output reservation an
/// undercount would exhaust mid-serialization.
const VECTOR_BODY_ENVELOPE: usize = 256;

/// Upper bound on the serialized length of a vector-bearing body, built from
/// the same per-item accounting the job table splits pages with — so a page
/// that fit the page cap also fits the reservation taken from this estimate.
pub fn vector_body_reservation(
    lane: &LaneInfo,
    items: &[VectorItemView<'_>],
    next_cursor: Option<&str>,
) -> usize {
    let items: usize = items
        .iter()
        .map(|item| {
            super::jobs::JobTable::encoded_item_cost(
                item.vector.len(),
                item.id,
                item.content_sha256,
            )
        })
        .sum();
    items
        + lane.model.len()
        + lane.fingerprint.len()
        + next_cursor.map_or(0, str::len)
        + VECTOR_BODY_ENVELOPE
}

/// Serializes a vector-bearing body into caller-supplied output storage,
/// which the caller reserved from [`vector_body_reservation`].
pub fn write_vector_body<W: std::io::Write>(
    out: W,
    lane: &LaneInfo,
    items: &[VectorItemView<'_>],
    done: bool,
    next_cursor: Option<&str>,
) -> Result<(), serde_json::Error> {
    serde_json::to_writer(
        out,
        &VectorBody {
            result: VectorResultBody {
                model: &lane.model,
                fingerprint: &lane.fingerprint,
                table_epoch: lane.table_epoch,
                dims: lane.dims,
                done,
                next_cursor,
                vectors: VectorItemsBody(items),
            },
        },
    )
}

pub fn job_descriptor_body(
    job_id: &str,
    request_key: &str,
    status: &str,
    retry_after_ms: u64,
) -> Vec<u8> {
    let body = serde_json::json!({
        "result": {
            "job_id": job_id,
            "request_key": request_key,
            "done": false,
            "status": status,
            "retry_after_ms": retry_after_ms,
        },
    });
    serde_json::to_vec(&body).expect("job descriptor serializes")
}

pub fn pending_body(job_id: &str, status: &str, retry_after_ms: u64) -> Vec<u8> {
    let body = serde_json::json!({
        "result": {
            "job_id": job_id,
            "done": false,
            "status": status,
            "retry_after_ms": retry_after_ms,
        },
    });
    serde_json::to_vec(&body).expect("pending body serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane() -> LaneInfo {
        LaneInfo {
            model: "tiny-test-model".to_owned(),
            fingerprint: "fp-1".to_owned(),
            table_epoch: 1,
            dims: 8,
            max_tokens: 512,
            provenance: serde_json::Value::Null,
            recommended_rows: 16,
            recommended_token_budget: 8192,
        }
    }

    fn item(id: &str, text: &str) -> BatchItem {
        BatchItem {
            id: id.to_owned(),
            content_sha256: sha256_hex(text.as_bytes()),
            text: text.to_owned(),
        }
    }

    /// The protocol's committed golden vectors: JavaScript
    /// `getSynapseBatchRequestKey` produces these exact keys.
    #[test]
    fn request_key_matches_the_javascript_golden_vectors() {
        assert_eq!(
            canonical_request_key(&lane(), &[]),
            "581e663acbdeee7021b440822f8f054afa1089ca89f3be3585bf0e8032502186"
        );
        assert_eq!(
            canonical_request_key(
                &lane(),
                &[item("item:0", "hello world"), item("item:1", "second text")]
            ),
            "ce9a0b29a7c3339ba91851d71b1164f93a35ea6053629f1e9a97ac26c2c02ece"
        );
        let mut escaped_lane = lane();
        escaped_lane.table_epoch = 7;
        assert_eq!(
            canonical_request_key(
                &escaped_lane,
                &[item(
                    "id \"q\"\\\u{fc}\n",
                    "caf\u{e9} \u{2028} \"quoted\\\" \n tab\t"
                )]
            ),
            "abdb2e55e593fb0f05dfd9f01e3bbaba88f88452daa01cf19bb1ba43da933979"
        );
    }
}
