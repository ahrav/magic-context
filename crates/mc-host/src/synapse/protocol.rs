//! The four-operation Synapse application protocol: strict request
//! validation, the cross-language canonical request key, and response
//! encoding.

use std::borrow::Cow;

use sha2::{Digest, Sha256};

use super::jobs::BatchItem;
use super::LaneInfo;
use super::SynapseLimits;
use crate::control::check_string;

const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
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

// ---------------------------------------------------------------------------
// Request schema. Every string field borrows out of the caller's body buffer,
// and every object is a closed struct: a `serde_json::Value` tree spends 32
// bytes per node on input elements as small as two bytes, so materializing one
// would put transient parse scratch an order of magnitude above the resident
// budget the already-charged body was admitted against. Typed deserialization
// keeps scratch proportional to the body, and `deny_unknown_fields` refuses
// junk at the key instead of allocating a node for it.
// ---------------------------------------------------------------------------

/// The envelope read to learn `method`. `params` is skipped rather than
/// decoded, because its schema is not known until `method` is: JSON object
/// order is not guaranteed, so `params` may precede it. `IgnoredAny` walks the
/// subtree without allocating or recursing.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MethodEnvelope<'a> {
    #[serde(borrow)]
    method: Cow<'a, str>,
    #[serde(default, rename = "params")]
    _params: serde::de::IgnoredAny,
}

/// Forces the object form. A derived `Deserialize` also accepts a JSON
/// sequence, filling fields positionally, which would admit an array in place
/// of the request body, its params, or a batch item.
struct MapOnly<T>(T);

impl<T: Default> Default for MapOnly<T> {
    fn default() -> Self {
        Self(T::default())
    }
}

impl<'de, T: serde::Deserialize<'de>> serde::Deserialize<'de> for MapOnly<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: serde::Deserialize<'de>> serde::de::Visitor<'de> for ObjectVisitor<T> {
            type Value = T;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map))
            }
        }

        deserializer
            .deserialize_map(ObjectVisitor(std::marker::PhantomData))
            .map(Self)
    }
}

/// Envelope for an operation whose parameters may be omitted entirely.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionalParams<P> {
    #[serde(rename = "method")]
    _method: serde::de::IgnoredAny,
    #[serde(default, rename = "params")]
    _params: MapOnly<P>,
}

/// Envelope for an operation whose parameters carry the mandatory lane
/// constraints, so an absent `params` is a schema violation rather than a
/// defaulted — and therefore substituted — set of constraints.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredParams<P> {
    #[serde(rename = "method")]
    _method: serde::de::IgnoredAny,
    params: MapOnly<P>,
}

#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct NoParams {}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryParams<'a> {
    #[serde(borrow)]
    model: Cow<'a, str>,
    #[serde(borrow)]
    required_fingerprint: Cow<'a, str>,
    required_epoch: u64,
    allow_equivalent: bool,
    accept_declared: bool,
    #[serde(borrow)]
    text: Cow<'a, str>,
    #[serde(default)]
    deadline_ms: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchParams<'a> {
    #[serde(borrow)]
    model: Cow<'a, str>,
    #[serde(borrow)]
    required_fingerprint: Cow<'a, str>,
    required_epoch: u64,
    allow_equivalent: bool,
    accept_declared: bool,
    #[serde(borrow)]
    request_key: Cow<'a, str>,
    #[serde(borrow)]
    items: Vec<MapOnly<ItemParams<'a>>>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemParams<'a> {
    #[serde(borrow)]
    id: Cow<'a, str>,
    #[serde(borrow)]
    text: Cow<'a, str>,
    #[serde(borrow)]
    content_sha256: Cow<'a, str>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultParams<'a> {
    #[serde(borrow)]
    model: Cow<'a, str>,
    #[serde(borrow)]
    required_fingerprint: Cow<'a, str>,
    required_epoch: u64,
    allow_equivalent: bool,
    accept_declared: bool,
    #[serde(borrow)]
    job_id: Cow<'a, str>,
    #[serde(borrow)]
    request_key: Cow<'a, str>,
    #[serde(default)]
    cursor: Option<Cow<'a, str>>,
}

/// Decodes one typed shape out of the body, classifying every deserialization
/// failure — malformed JSON, wrong type, unknown field, duplicate key, missing
/// field — as a schema violation, which is the single classification all of
/// those carry.
fn decode<'a, T: serde::Deserialize<'a>>(body: &'a [u8]) -> Result<T, RequestError> {
    serde_json::from_slice(body).map_err(|err| schema(err.to_string()))
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
    let envelope: MapOnly<MethodEnvelope> = decode(body)?;
    // Nesting needs no explicit depth cap: the schema bottoms out in scalars,
    // so a nested value in a scalar slot fails on its opening token, and an
    // unknown key is refused before its value is read.
    match envelope.0.method.as_ref() {
        "models.list" => {
            let _: MapOnly<OptionalParams<NoParams>> = decode(body)?;
            Ok(Request::ModelsList)
        }
        "embed.query" => {
            let envelope: MapOnly<RequiredParams<QueryParams<'_>>> = decode(body)?;
            parse_query(envelope.0.params.0, lane, limits)
        }
        "embed.batch" => {
            let envelope: MapOnly<RequiredParams<BatchParams<'_>>> = decode(body)?;
            parse_batch(envelope.0.params.0, lane, limits)
        }
        "embed.result" => {
            let envelope: MapOnly<RequiredParams<ResultParams<'_>>> = decode(body)?;
            parse_result(envelope.0.params.0, lane)
        }
        _ => Err(schema("unsupported synapse method")),
    }
}

/// Fixed lane constraints on every `embed.*` request: exact model,
/// fingerprint, epoch, and both substitution flags literally false. A wrong
/// value is a rejected substitution — the service never adapts to another
/// embedding space.
fn check_constraints(
    model: &str,
    fingerprint: &str,
    epoch: u64,
    allow_equivalent: bool,
    accept_declared: bool,
    lane: &LaneInfo,
) -> Result<(), RequestError> {
    if model != lane.model {
        return Err(substitution("requested model is not served by this lane"));
    }
    if fingerprint != lane.fingerprint {
        return Err(substitution("required fingerprint does not match"));
    }
    if epoch != lane.table_epoch {
        return Err(substitution("required table epoch does not match"));
    }
    for (flag, value) in [
        ("allow_equivalent", allow_equivalent),
        ("accept_declared", accept_declared),
    ] {
        if value {
            return Err(substitution(format!("{flag} must be false")));
        }
    }
    Ok(())
}

fn parse_query(
    params: QueryParams<'_>,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    check_constraints(
        &params.model,
        &params.required_fingerprint,
        params.required_epoch,
        params.allow_equivalent,
        params.accept_declared,
        lane,
    )?;
    check_string("text", &params.text, limits.max_text_bytes, true).map_err(schema)?;
    if let Some(ms) = params.deadline_ms {
        if ms == 0 || ms > MAX_DEADLINE_MS {
            return Err(schema("deadline_ms out of bounds"));
        }
    }
    Ok(Request::EmbedQuery {
        text: params.text.into_owned(),
        deadline_ms: params.deadline_ms,
    })
}

fn parse_batch(
    params: BatchParams<'_>,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    check_constraints(
        &params.model,
        &params.required_fingerprint,
        params.required_epoch,
        params.allow_equivalent,
        params.accept_declared,
        lane,
    )?;
    if !is_lower_hex_64(&params.request_key) {
        return Err(schema("request_key must be 64 lowercase hex characters"));
    }
    if params.items.is_empty() || params.items.len() > limits.max_batch_items {
        return Err(schema("item count out of bounds"));
    }
    let mut items = Vec::with_capacity(params.items.len());
    let mut total_text_bytes = 0usize;
    for raw in &params.items {
        check_string("item id", &raw.0.id, MAX_ID_BYTES, true).map_err(schema)?;
        check_string("item text", &raw.0.text, limits.max_text_bytes, true).map_err(schema)?;
        total_text_bytes += raw.0.text.len();
        // Recomputed, never trusted: a wrong supplied hash would poison the
        // durable ledger's content identity.
        let actual = sha256_hex(raw.0.text.as_bytes());
        if raw.0.content_sha256 != actual {
            return Err(schema("item content_sha256 does not match its text"));
        }
        if items
            .iter()
            .any(|existing: &BatchItem| existing.id == raw.0.id)
        {
            return Err(schema("duplicate item id"));
        }
        items.push(BatchItem {
            id: raw.0.id.to_string(),
            content_sha256: actual,
            text: raw.0.text.to_string(),
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
        request_key: params.request_key.into_owned(),
        canonical_key,
        items,
    })
}

fn parse_result(params: ResultParams<'_>, lane: &LaneInfo) -> Result<Request, RequestError> {
    check_constraints(
        &params.model,
        &params.required_fingerprint,
        params.required_epoch,
        params.allow_equivalent,
        params.accept_declared,
        lane,
    )?;
    check_string("job_id", &params.job_id, MAX_JOB_ID_BYTES, true).map_err(schema)?;
    if !is_lower_hex_64(&params.request_key) {
        return Err(schema("request_key must be 64 lowercase hex characters"));
    }
    let cursor = match params.cursor {
        None => None,
        Some(cursor) => {
            check_string("cursor", &cursor, MAX_CURSOR_BYTES, true).map_err(schema)?;
            Some(cursor.into_owned())
        }
    };
    Ok(Request::EmbedResult {
        job_id: params.job_id.into_owned(),
        request_key: params.request_key.into_owned(),
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
