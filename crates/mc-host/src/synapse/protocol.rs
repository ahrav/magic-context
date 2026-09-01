//! Synapse validates four request operations, canonicalizes request keys across languages, and encodes responses.
//! encoding.

use std::borrow::Cow;

use sha2::{Digest, Sha256};

use super::jobs::{BatchItem, MAX_ITEM_ID_BYTES};
use super::LaneInfo;
use super::SynapseLimits;
use crate::control::check_string;

pub(crate) const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// `MAX_BODY_DEPTH` permits structural depth 8 and rejects depth 9.
const MAX_BODY_DEPTH: usize = 8;
const MAX_DIAGNOSTIC_BYTES: usize = 512;
pub(crate) const MAX_JOB_ID_BYTES: usize = 128;
pub(crate) const MAX_CURSOR_BYTES: usize = 128;
pub(crate) const MAX_DEADLINE_MS: u64 = 3_600_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestError {
    pub code: &'static str,
    pub message: String,
}

pub(crate) fn schema(message: impl Into<String>) -> RequestError {
    let mut message = message.into();
    if message.len() > MAX_DIAGNOSTIC_BYTES {
        let mut end = MAX_DIAGNOSTIC_BYTES;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        // Truncation alone keeps the original capacity allocated.
        message.shrink_to_fit();
    }
    RequestError {
        code: "schema_violation",
        message,
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
// Typed deserialization avoids materializing a `serde_json::Value` tree.
// ---------------------------------------------------------------------------

/// `params` is skipped because its schema depends on `method`; `IgnoredAny` avoids materializing it.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MethodEnvelope<'a> {
    #[serde(borrow)]
    pub(crate) method: Cow<'a, str>,
    #[serde(default, rename = "params")]
    _params: serde::de::IgnoredAny,
}

/// A derived `Deserialize` accepts JSON sequences and fills fields positionally.
/// `MapOnly` rejects sequences because a sequence could replace an object.
/// `MapOnly` rejects arrays where the request body, `params`, or a batch item requires an object.
pub(crate) struct MapOnly<T>(pub(crate) T);

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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OptionalParams<P> {
    #[serde(rename = "method")]
    _method: serde::de::IgnoredAny,
    #[serde(default, rename = "params")]
    _params: MapOnly<P>,
}

/// `RequiredParams` rejects an absent `params` field.
/// An absent `params` field is a schema violation rather than a defaulted constraint set.
/// Defaulting `params` would substitute lane constraints.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RequiredParams<P> {
    #[serde(rename = "method")]
    _method: serde::de::IgnoredAny,
    pub(crate) params: MapOnly<P>,
}

#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoParams {}

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

/// `BatchEnvelopeSeed` builds decoded `embed.batch` parameters because the item bound is runtime configuration.
/// Derived `Deserialize` cannot pass a seed into the `items` collection.
struct BatchParams<'a> {
    model: Cow<'a, str>,
    required_fingerprint: Cow<'a, str>,
    required_epoch: u64,
    allow_equivalent: bool,
    accept_declared: bool,
    request_key: Cow<'a, str>,
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

/// The request decoder classifies malformed JSON and typed-deserialization failures as `schema_violation`.
/// those carry.
fn decode<'a, T: serde::Deserialize<'a>>(body: &'a [u8]) -> Result<T, RequestError> {
    serde_json::from_slice(body).map_err(|err| schema(err.to_string()))
}

/// `BorrowedCow` borrows unescaped JSON strings from the input.
/// The blanket `Cow` deserialization implementation always allocates.
/// `BorrowedCow` avoids allocation for the hand-written batch path.
struct BorrowedCow<'de>(Cow<'de, str>);

impl<'de> serde::Deserialize<'de> for BorrowedCow<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct CowVisitor;

        impl<'de> serde::de::Visitor<'de> for CowVisitor {
            type Value = BorrowedCow<'de>;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string")
            }

            fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(BorrowedCow(Cow::Borrowed(v)))
            }

            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(BorrowedCow(Cow::Owned(v.to_owned())))
            }

            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(BorrowedCow(Cow::Owned(v)))
            }
        }

        deserializer.deserialize_str(CowVisitor)
    }
}

fn put<T, E: serde::de::Error>(
    slot: &mut Option<T>,
    field: &'static str,
    value: T,
) -> Result<(), E> {
    if slot.is_some() {
        return Err(E::duplicate_field(field));
    }
    *slot = Some(value);
    Ok(())
}

/// `embed.batch` uses a `{method, params}` envelope.
/// The envelope accepts only objects, rejects unknown and duplicate fields, and requires `method` and `params`.
/// `BatchEnvelopeSeed` carries the runtime item bound.
struct BatchEnvelopeSeed {
    max_items: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for BatchEnvelopeSeed {
    type Value = BatchParams<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        struct EnvelopeVisitor {
            max_items: usize,
        }

        impl<'de> serde::de::Visitor<'de> for EnvelopeVisitor {
            type Value = BatchParams<'de>;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                use serde::de::Error;
                let mut saw_method = false;
                let mut params: Option<BatchParams<'de>> = None;
                while let Some(key) = map.next_key::<BorrowedCow<'de>>()? {
                    match key.0.as_ref() {
                        "method" => {
                            if saw_method {
                                return Err(A::Error::duplicate_field("method"));
                            }
                            saw_method = true;
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                        "params" => {
                            if params.is_some() {
                                return Err(A::Error::duplicate_field("params"));
                            }
                            params = Some(map.next_value_seed(BatchParamsSeed {
                                max_items: self.max_items,
                            })?);
                        }
                        other => return Err(A::Error::unknown_field(other, &["method", "params"])),
                    }
                }
                if !saw_method {
                    return Err(A::Error::missing_field("method"));
                }
                params.ok_or_else(|| A::Error::missing_field("params"))
            }
        }

        deserializer.deserialize_map(EnvelopeVisitor {
            max_items: self.max_items,
        })
    }
}

struct BatchParamsSeed {
    max_items: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for BatchParamsSeed {
    type Value = BatchParams<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        struct ParamsVisitor {
            max_items: usize,
        }

        const FIELDS: &[&str] = &[
            "model",
            "required_fingerprint",
            "required_epoch",
            "allow_equivalent",
            "accept_declared",
            "request_key",
            "items",
        ];

        impl<'de> serde::de::Visitor<'de> for ParamsVisitor {
            type Value = BatchParams<'de>;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                use serde::de::Error;
                let mut model = None;
                let mut required_fingerprint = None;
                let mut required_epoch = None;
                let mut allow_equivalent = None;
                let mut accept_declared = None;
                let mut request_key = None;
                let mut items = None;
                while let Some(key) = map.next_key::<BorrowedCow<'de>>()? {
                    match key.0.as_ref() {
                        "model" => {
                            put(&mut model, "model", map.next_value::<BorrowedCow<'de>>()?.0)?
                        }
                        "required_fingerprint" => put(
                            &mut required_fingerprint,
                            "required_fingerprint",
                            map.next_value::<BorrowedCow<'de>>()?.0,
                        )?,
                        "required_epoch" => put(
                            &mut required_epoch,
                            "required_epoch",
                            map.next_value::<u64>()?,
                        )?,
                        "allow_equivalent" => put(
                            &mut allow_equivalent,
                            "allow_equivalent",
                            map.next_value::<bool>()?,
                        )?,
                        "accept_declared" => put(
                            &mut accept_declared,
                            "accept_declared",
                            map.next_value::<bool>()?,
                        )?,
                        "request_key" => put(
                            &mut request_key,
                            "request_key",
                            map.next_value::<BorrowedCow<'de>>()?.0,
                        )?,
                        "items" => put(
                            &mut items,
                            "items",
                            map.next_value_seed(BoundedItemsSeed {
                                max_items: self.max_items,
                            })?,
                        )?,
                        other => return Err(A::Error::unknown_field(other, FIELDS)),
                    }
                }
                Ok(BatchParams {
                    model: model.ok_or_else(|| A::Error::missing_field("model"))?,
                    required_fingerprint: required_fingerprint
                        .ok_or_else(|| A::Error::missing_field("required_fingerprint"))?,
                    required_epoch: required_epoch
                        .ok_or_else(|| A::Error::missing_field("required_epoch"))?,
                    allow_equivalent: allow_equivalent
                        .ok_or_else(|| A::Error::missing_field("allow_equivalent"))?,
                    accept_declared: accept_declared
                        .ok_or_else(|| A::Error::missing_field("accept_declared"))?,
                    request_key: request_key
                        .ok_or_else(|| A::Error::missing_field("request_key"))?,
                    items: items.ok_or_else(|| A::Error::missing_field("items"))?,
                })
            }
        }

        deserializer.deserialize_map(ParamsVisitor {
            max_items: self.max_items,
        })
    }
}

/// `items` contains at most `max_items` borrowed item shapes.
/// `max_items` sets the initial `Vec` capacity, so accepted items do not reallocate while decoding.
struct BoundedItemsSeed {
    max_items: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for BoundedItemsSeed {
    type Value = Vec<MapOnly<ItemParams<'de>>>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        struct ItemsVisitor {
            max_items: usize,
        }

        impl<'de> serde::de::Visitor<'de> for ItemsVisitor {
            type Value = Vec<MapOnly<ItemParams<'de>>>;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an array of batch items")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut items = Vec::with_capacity(self.max_items);
                while items.len() < self.max_items {
                    match seq.next_element::<MapOnly<ItemParams<'de>>>()? {
                        Some(item) => items.push(item),
                        None => return Ok(items),
                    }
                }
                // `RefuseElement` fails before the boundary element's fields, strings, or hashes are visited.
                seq.next_element_seed(RefuseElement)?;
                Ok(items)
            }
        }

        deserializer.deserialize_seq(ItemsVisitor {
            max_items: self.max_items,
        })
    }
}

struct RefuseElement;

impl<'de> serde::de::DeserializeSeed<'de> for RefuseElement {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, _deserializer: D) -> Result<(), D::Error> {
        Err(serde::de::Error::custom("item count out of bounds"))
    }
}

fn decode_batch<'a>(body: &'a [u8], max_items: usize) -> Result<BatchParams<'a>, RequestError> {
    use serde::de::DeserializeSeed;
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let params = BatchEnvelopeSeed { max_items }
        .deserialize(&mut deserializer)
        .map_err(|err| schema(err.to_string()))?;
    deserializer.end().map_err(|err| schema(err.to_string()))?;
    Ok(params)
}

/// `value_depth` counts each open container as one level and each scalar as one additional level.
/// `value_depth` counts object keys at the same depth as their values.
/// Counting keys cannot increase the maximum depth because each object also contains each key's value at that depth.
/// `preflight` does not validate syntax, UTF-8, duplicate keys, or schema; serde does.
pub(crate) fn depth_exceeds(body: &[u8], max_depth: usize) -> bool {
    let mut open = 0usize;
    let mut index = 0usize;
    while index < body.len() {
        match body[index] {
            b'{' | b'[' => {
                open += 1;
                if open > max_depth {
                    return true;
                }
                index += 1;
            }
            b'}' | b']' => {
                open = open.saturating_sub(1);
                index += 1;
            }
            b'"' => {
                if open >= max_depth {
                    return true;
                }
                index += 1;
                // The scanner searches string bodies only for quotes and backslashes to avoid per-byte dispatch for item text.
                // Only quotes terminate strings, and only backslashes escape bytes.
                let closed = loop {
                    let Some(offset) = body[index..]
                        .iter()
                        .position(|&byte| byte == b'"' || byte == b'\\')
                    else {
                        break false;
                    };
                    let byte = body[index + offset];
                    index += offset + 1;
                    if byte == b'"' {
                        break true;
                    }
                    // A backslash consumes the following byte, so that byte cannot close the string.
                    // Consuming the byte after each backslash preserves backslash parity.
                    if index >= body.len() {
                        break false;
                    }
                    index += 1;
                };
                if !closed {
                    // Unterminated string: serde reports the syntax error.
                    return false;
                }
            }
            b',' | b':' | b' ' | b'\t' | b'\n' | b'\r' => index += 1,
            // `depth_exceeds` treats every other byte outside a string as part of a scalar token; Serde rejects invalid tokens.
            _ => {
                if open >= max_depth {
                    return true;
                }
                index += 1;
            }
        }
    }
    false
}

/// `preflight` rejects binary bodies, oversized bodies, and excessive structural depth before deserialization reads a byte.
pub(crate) fn preflight(body: &[u8], binary: bool) -> Result<(), RequestError> {
    if binary {
        return Err(schema("synapse requests are JSON only"));
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(schema("request body exceeds the profile cap"));
    }
    if depth_exceeds(body, MAX_BODY_DEPTH) {
        return Err(schema("request body too deeply nested"));
    }
    Ok(())
}

pub(crate) fn decode_request(
    body: &[u8],
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    let envelope: MapOnly<MethodEnvelope> = decode(body)?;
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
            let params = decode_batch(body, body_item_bound(body.len(), limits.max_batch_items))?;
            parse_batch(params, lane, limits)
        }
        "embed.result" => {
            let envelope: MapOnly<RequiredParams<ResultParams<'_>>> = decode(body)?;
            parse_result(envelope.0.params.0, lane)
        }
        _ => Err(schema("unsupported synapse method")),
    }
}

#[doc(hidden)]
pub fn parse_request_unreserved(
    body: &[u8],
    binary: bool,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    preflight(body, binary)?;
    decode_request(body, lane, limits)
}

/// clients retry.
pub(crate) fn unservable_body_error(
    body_len: usize,
    required: usize,
    capacity: usize,
) -> RequestError {
    schema(format!(
        "request body of {body_len} bytes needs {required} resident bytes, \
         above this host's {capacity}-byte resident capacity"
    ))
}

const RESERVE_PER_ITEM_BYTES: usize = 640;

/// diagnostic.
const RESERVE_ENVELOPE_BYTES: usize = 4096;

const RESERVE_BODY_FACTOR: usize = 3;

/// bound.
const RESERVE_MIN_ITEM_BODY_BYTES: usize = 64;

fn body_item_bound(body_len: usize, max_batch_items: usize) -> usize {
    max_batch_items.min(body_len / RESERVE_MIN_ITEM_BODY_BYTES + 1)
}

pub(crate) fn parse_reservation_bytes(body_len: usize, limits: &SynapseLimits) -> Option<usize> {
    let item_bound = body_item_bound(body_len, limits.max_batch_items);
    body_len
        .checked_mul(RESERVE_BODY_FACTOR)?
        .checked_add(item_bound.checked_mul(RESERVE_PER_ITEM_BYTES)?)?
        .checked_add(RESERVE_ENVELOPE_BYTES)
}

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
    if params.items.is_empty() {
        return Err(schema("item count out of bounds"));
    }
    let mut items = Vec::with_capacity(params.items.len());
    let mut total_text_bytes = 0usize;
    for raw in &params.items {
        check_string("item id", &raw.0.id, MAX_ITEM_ID_BYTES, true).map_err(schema)?;
        check_string("item text", &raw.0.text, limits.max_text_bytes, true).map_err(schema)?;
        total_text_bytes += raw.0.text.len();
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
// ---------------------------------------------------------------------------

pub fn models_list_body(lane: &LaneInfo) -> Vec<u8> {
    let body = serde_json::json!({
        "result": {
            "models": [{
                "model": lane.model,
                "fingerprint": lane.fingerprint,
                "table_epoch": lane.table_epoch,
                "dims": lane.dims,
                "execution_provider": lane.execution_provider,
                "max_input_tokens": lane.max_tokens,
                "max_input_bytes": lane.max_text_bytes,
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

const VECTOR_BODY_ENVELOPE: usize = 256;

/// `vector_body_reservation` upper-bounds serialized vector-body length using the job table's per-item accounting.
/// A page that satisfies the job table's page cap fits the reservation.
/// The reservation charges `lane.model` at its escaped length; the manifest permits 128 unconstrained bytes, which can occupy 768 escaped bytes.
/// TODO: Charge `next_cursor` at its escaped length.
/// unchanged.
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
        + super::jobs::escaped_string_bytes(&lane.model)
        + lane.fingerprint.len()
        + next_cursor.map_or(0, str::len)
        + VECTOR_BODY_ENVELOPE
}

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
            execution_provider: "cpu",
            max_tokens: 512,
            max_text_bytes: 1024 * 1024,
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

    // -----------------------------------------------------------------
    // The scanner counts the root container as 1, each nested container as +1, and a scalar leaf as +1.
    // The scanner ignores container delimiters inside strings.
    // -----------------------------------------------------------------

    #[test]
    fn depth_eight_passes_and_depth_nine_fails() {
        let depth8 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}"#;
        assert!(!depth_exceeds(depth8, MAX_BODY_DEPTH));
        let depth9 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}"#;
        assert!(depth_exceeds(depth9, MAX_BODY_DEPTH));
        // An empty container is a level of its own but adds no scalar.
        let empty8 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{}}}}}}}}"#;
        assert!(!depth_exceeds(empty8, MAX_BODY_DEPTH));
        let empty9 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{}}}}}}}}}"#;
        assert!(depth_exceeds(empty9, MAX_BODY_DEPTH));
        let arrays9 = br#"{"a":[[[[[[[1]]]]]]]}"#;
        assert!(depth_exceeds(arrays9, MAX_BODY_DEPTH));
    }

    #[test]
    fn depth_counts_params_that_precede_method() {
        let deep_params_first =
            br#"{"params":{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}},"method":"models.list"}"#;
        assert!(depth_exceeds(deep_params_first, MAX_BODY_DEPTH));
        let error =
            parse_request_unreserved(deep_params_first, false, &lane(), &SynapseLimits::default())
                .expect_err("depth nine is rejected before typed decode");
        assert_eq!(error.code, "schema_violation");
        assert!(error.message.contains("deeply nested"), "{}", error.message);
    }

    #[test]
    fn delimiters_inside_strings_never_count_toward_depth() {
        assert!(!depth_exceeds(
            br#"{"a":"}}}}}}}}}}{{{{[[[[]]]]"}"#,
            MAX_BODY_DEPTH
        ));
        assert!(!depth_exceeds(
            br#"{"a":"x\"{{{{{{{{{{","b":1}"#,
            MAX_BODY_DEPTH
        ));
        assert!(depth_exceeds(
            br#"{"a":"x\\","b":[[[[[[[[1]]]]]]]]}"#,
            MAX_BODY_DEPTH
        ));
    }

    #[test]
    fn a_scalar_at_the_container_limit_is_one_level_deeper() {
        // Eight open containers are exactly the depth limit.
        assert!(!depth_exceeds(
            br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{}}}}}}}}"#,
            8
        ));
        // A scalar or key inside the eighth open container has depth 9.
        assert!(depth_exceeds(
            br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}"#,
            8
        ));
    }

    // -----------------------------------------------------------------
    // -----------------------------------------------------------------

    fn batch_body(lane: &LaneInfo, items_json: &str) -> Vec<u8> {
        format!(
            concat!(
                "{{\"method\":\"embed.batch\",\"params\":{{",
                "\"model\":\"{}\",\"required_fingerprint\":\"{}\",",
                "\"required_epoch\":{},\"allow_equivalent\":false,",
                "\"accept_declared\":false,\"request_key\":\"{}\",",
                "\"items\":{}}}}}"
            ),
            lane.model,
            lane.fingerprint,
            lane.table_epoch,
            "0".repeat(64),
            items_json,
        )
        .into_bytes()
    }

    fn item_json(id: &str, text: &str) -> String {
        format!(
            "{{\"id\":\"{id}\",\"text\":\"{text}\",\"content_sha256\":\"{}\"}}",
            sha256_hex(text.as_bytes())
        )
    }

    #[test]
    fn the_item_after_the_bound_is_refused_before_its_fields_are_read() {
        let limits = SynapseLimits {
            max_batch_items: 2,
            ..SynapseLimits::default()
        };
        let lane = lane();
        // The boundary element has an unknown key, invalid hash, and overlong ID; only a count error proves the decoder skipped it.
        let overflow = format!(
            "[{},{},{{\"junk\":1,\"id\":\"{}\",\"content_sha256\":\"zzz\"}}]",
            item_json("a", "one"),
            item_json("b", "two"),
            "x".repeat(4096),
        );
        let error = parse_request_unreserved(&batch_body(&lane, &overflow), false, &lane, &limits)
            .expect_err("the third element exceeds the bound");
        assert_eq!(error.code, "schema_violation");
        assert!(
            error.message.contains("item count out of bounds"),
            "{}",
            error.message
        );

        let exact = format!("[{},{}]", item_json("a", "one"), item_json("b", "two"));
        let key = canonical_request_key(&lane, &[item("a", "one"), item("b", "two")]);
        let body = String::from_utf8(batch_body(&lane, &exact))
            .expect("utf8")
            .replace(&"0".repeat(64), &key)
            .into_bytes();
        let request =
            parse_request_unreserved(&body, false, &lane, &limits).expect("exact bound parses");
        let Request::EmbedBatch { items, .. } = request else {
            panic!("expected a batch");
        };
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn the_seeded_batch_path_keeps_strict_schema_behavior() {
        let limits = SynapseLimits::default();
        let lane = lane();
        let ok_items = format!("[{}]", item_json("a", "one"));
        for (case, body) in [
            (
                "duplicate params",
                b"{\"method\":\"embed.batch\",\"params\":{},\"params\":{}}".to_vec(),
            ),
            (
                "duplicate model",
                String::from_utf8(batch_body(&lane, &ok_items))
                    .expect("utf8")
                    .replace("\"model\":", "\"model\":\"x\",\"model\":")
                    .into_bytes(),
            ),
            (
                "unknown params field",
                String::from_utf8(batch_body(&lane, &ok_items))
                    .expect("utf8")
                    .replace("\"items\":", "\"extra\":1,\"items\":")
                    .into_bytes(),
            ),
            (
                "array params",
                b"{\"method\":\"embed.batch\",\"params\":[]}".to_vec(),
            ),
            (
                "array item",
                batch_body(&lane, "[[\"a\",\"one\",\"hash\"]]"),
            ),
            (
                "missing items",
                String::from_utf8(batch_body(&lane, &ok_items))
                    .expect("utf8")
                    .replace(&format!(",\"items\":{ok_items}"), "")
                    .into_bytes(),
            ),
            (
                "wrong epoch type",
                String::from_utf8(batch_body(&lane, &ok_items))
                    .expect("utf8")
                    .replace("\"required_epoch\":1", "\"required_epoch\":\"1\"")
                    .into_bytes(),
            ),
            ("trailing content", {
                let mut body = batch_body(&lane, &ok_items);
                body.extend_from_slice(b" {}");
                body
            }),
        ] {
            let error = parse_request_unreserved(&body, false, &lane, &limits).expect_err(case);
            assert_eq!(error.code, "schema_violation", "{case}: {}", error.message);
        }
    }

    #[test]
    fn escaped_strings_decode_through_the_seeded_batch_path() {
        let limits = SynapseLimits::default();
        let lane = lane();
        let id = "id \"q\"\\\u{fc}\n";
        let text = "caf\u{e9} \"quoted\" \n tab\t";
        let expected = item(id, text);
        let key = canonical_request_key(&lane, std::slice::from_ref(&expected));
        let body = serde_json::to_vec(&serde_json::json!({
            "method": "embed.batch",
            "params": {
                "model": lane.model,
                "required_fingerprint": lane.fingerprint,
                "required_epoch": lane.table_epoch,
                "allow_equivalent": false,
                "accept_declared": false,
                "request_key": key,
                "items": [{
                    "id": id,
                    "text": text,
                    "content_sha256": expected.content_sha256,
                }],
            },
        }))
        .expect("body serializes");
        let request =
            parse_request_unreserved(&body, false, &lane, &limits).expect("escaped batch parses");
        let Request::EmbedBatch { items, .. } = request else {
            panic!("expected a batch");
        };
        assert_eq!(items, vec![expected]);
    }

    #[test]
    fn oversized_diagnostics_are_bounded_while_still_charged() {
        let limits = SynapseLimits::default();
        let lane = lane();
        let long_field = "k".repeat(1024 * 1024);
        let body = format!("{{\"method\":\"models.list\",\"{long_field}\":1}}").into_bytes();
        let error = parse_request_unreserved(&body, false, &lane, &limits)
            .expect_err("unknown top-level field is refused");
        assert_eq!(error.code, "schema_violation");
        assert!(error.message.len() <= MAX_DIAGNOSTIC_BYTES);
        assert!(error.message.capacity() <= 2 * MAX_DIAGNOSTIC_BYTES);
    }

    // -----------------------------------------------------------------
    // -----------------------------------------------------------------

    #[test]
    fn the_maximum_reservation_fits_the_scratch_pool_at_every_legal_config() {
        let bound = parse_reservation_bytes(MAX_BODY_BYTES, &SynapseLimits::default())
            .expect("the default bound is computable");
        let scratch =
            crate::config::SCRATCH_RESERVED_BYTES - crate::config::RETAINED_METADATA_RESERVED_BYTES;
        assert!(
            bound as u64 <= scratch,
            "the worst-case reservation {bound} does not fit the reservable \
             scratch {scratch}; SCRATCH_RESERVED_BYTES must cover \
             RESERVE_BODY_FACTOR * MAX_BODY_BYTES plus per-item, envelope, \
             and retained-metadata headroom"
        );
        let limits = crate::config::HostLimits::default();
        assert!(
            limits.max_resident_bytes >= crate::config::MIN_RESIDENT_BYTES,
            "the default config must satisfy its own floor"
        );
        assert!(
            MAX_BODY_BYTES as u64 <= crate::wire::MAX_BODY_LEN as u64,
            "the protocol body cap must fit one frame body"
        );
    }

    #[test]
    fn reservation_arithmetic_is_checked() {
        let limits = SynapseLimits::default();
        assert!(parse_reservation_bytes(usize::MAX, &limits).is_none());
        let absurd = SynapseLimits {
            max_batch_items: usize::MAX,
            ..SynapseLimits::default()
        };
        let bounded = parse_reservation_bytes(1024, &absurd).expect("bounded by the body");
        assert_eq!(
            bounded,
            parse_reservation_bytes(1024, &limits).expect("default"),
            "for a small body the item term is body-derived, not config-derived"
        );
        let small = parse_reservation_bytes(1024, &limits).expect("small");
        let large = parse_reservation_bytes(2048, &limits).expect("large");
        assert!(large > small);
    }

    #[test]
    fn an_absurd_item_cap_still_decodes_a_small_batch() {
        let limits = SynapseLimits {
            max_batch_items: usize::MAX,
            ..SynapseLimits::default()
        };
        let lane = lane();
        let exact = format!("[{},{}]", item_json("a", "one"), item_json("b", "two"));
        let key = canonical_request_key(&lane, &[item("a", "one"), item("b", "two")]);
        let body = String::from_utf8(batch_body(&lane, &exact))
            .expect("utf8")
            .replace(&"0".repeat(64), &key)
            .into_bytes();
        let request =
            parse_request_unreserved(&body, false, &lane, &limits).expect("small batch parses");
        let Request::EmbedBatch { items, .. } = request else {
            panic!("expected a batch");
        };
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn the_parse_reservation_dominates_post_decode_owned_bytes() {
        let limits = SynapseLimits::default();
        let lane = lane();

        let dominates = |body: &[u8], case: &str| {
            let reservation =
                parse_reservation_bytes(body.len(), &limits).expect("bound is computable");
            let request =
                parse_request_unreserved(body, false, &lane, &limits).expect("body parses");
            let owned = super::super::owned_input_bytes(&request);
            assert!(
                reservation >= owned,
                "{case}: reservation {reservation} does not dominate owned bytes {owned}"
            );
        };

        for (case, text_json) in [
            ("query quote escapes", "\\\"".repeat(4096)), // two body bytes per decoded byte
            ("query unicode escapes", "\\u0041".repeat(1024)), // six body bytes per decoded byte
        ] {
            let body = format!(
                concat!(
                    "{{\"method\":\"embed.query\",\"params\":{{",
                    "\"model\":\"{}\",\"required_fingerprint\":\"{}\",",
                    "\"required_epoch\":{},\"allow_equivalent\":false,",
                    "\"accept_declared\":false,\"text\":\"{}\"}}}}"
                ),
                lane.model, lane.fingerprint, lane.table_epoch, text_json,
            )
            .into_bytes();
            dominates(&body, case);
        }

        let items_json: Vec<String> = (0..limits.max_batch_items)
            .map(|index| {
                let decoded = "\"".repeat(512);
                format!(
                    "{{\"id\":\"{index:0>width$}\",\"text\":\"{}\",\"content_sha256\":\"{}\"}}",
                    "\\\"".repeat(512),
                    sha256_hex(decoded.as_bytes()),
                    width = MAX_ITEM_ID_BYTES,
                )
            })
            .collect();
        dominates(
            &batch_body(&lane, &format!("[{}]", items_json.join(","))),
            "batch at the item and id bounds",
        );
        dominates(
            &batch_body(&lane, &format!("[{}]", item_json("a", "one"))),
            "minimal batch",
        );

        let result_body = serde_json::to_vec(&serde_json::json!({
            "method": "embed.result",
            "params": {
                "model": lane.model,
                "required_fingerprint": lane.fingerprint,
                "required_epoch": lane.table_epoch,
                "allow_equivalent": false,
                "accept_declared": false,
                "job_id": "j".repeat(MAX_JOB_ID_BYTES),
                "request_key": "0".repeat(64),
                "cursor": "c".repeat(MAX_CURSOR_BYTES),
            },
        }))
        .expect("body serializes");
        dominates(&result_body, "result at the id and cursor caps");

        dominates(br#"{"method":"models.list"}"#, "models.list");
    }
}
