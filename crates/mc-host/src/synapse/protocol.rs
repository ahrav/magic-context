//! The four-operation Synapse application protocol: strict request
//! validation, the cross-language canonical request key, and response
//! encoding.

use std::borrow::Cow;

use sha2::{Digest, Sha256};

use super::jobs::{BatchItem, MAX_ITEM_ID_BYTES};
use super::LaneInfo;
use super::SynapseLimits;
use crate::control::check_string;

const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Whole-body structural depth cap (protocol §7.5.1): level eight is valid,
/// level nine is not.
const MAX_BODY_DEPTH: usize = 8;
const MAX_DIAGNOSTIC_BYTES: usize = 512;
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

/// Decoded `embed.batch` parameters. Built by [`BatchEnvelopeSeed`] rather
/// than derive because the item bound is runtime configuration and derive
/// cannot thread a seed into the `items` collection.
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

/// Decodes one typed shape out of the body, classifying every deserialization
/// failure — malformed JSON, wrong type, unknown field, duplicate key, missing
/// field — as a schema violation, which is the single classification all of
/// those carry.
fn decode<'a, T: serde::Deserialize<'a>>(body: &'a [u8]) -> Result<T, RequestError> {
    serde_json::from_slice(body).map_err(|err| schema(err.to_string()))
}

/// Borrows from the input when the JSON string has no escapes; the serde
/// blanket `Cow` impl always allocates, which derive's `#[serde(borrow)]`
/// avoids and this visitor reproduces for the hand-written batch path.
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

/// `{method, params}` envelope for `embed.batch`. Mirrors the derived
/// `MapOnly<RequiredParams<...>>` contract — object-only, closed, duplicate
/// fields rejected, `method` and `params` required — while carrying the
/// runtime item bound.
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

/// Collects at most `max_items` borrowed item shapes. The capacity is
/// allocated once up front from trusted configuration, so the accepted-item
/// collection never grows while elements decode.
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
                // The boundary element must fail before any of its fields,
                // strings, or hashes are visited; the refusing seed errors
                // the moment a next element begins.
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

/// Whole-body structural depth check preserving the former `value_depth`
/// convention: each open container counts one level and a scalar leaf
/// counts one more below its container. Keys count like their values, which
/// never changes the maximum because an object holding a key also holds that
/// key's value at the same level. Strings are skipped with backslash parity
/// so delimiters inside them never count. Deliberately not a validator:
/// syntax, UTF-8, duplicate keys, and schema stay with serde.
fn depth_exceeds(body: &[u8], max_depth: usize) -> bool {
    let mut open = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for &byte in body {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'{' | b'[' => {
                open += 1;
                if open > max_depth {
                    return true;
                }
            }
            b'}' | b']' => open = open.saturating_sub(1),
            b'"' => {
                if open >= max_depth {
                    return true;
                }
                in_string = true;
            }
            b',' | b':' | b' ' | b'\t' | b'\n' | b'\r' => {}
            // Any other byte outside a string starts or continues a scalar
            // token (number, true, false, null, or garbage serde rejects).
            _ => {
                if open >= max_depth {
                    return true;
                }
            }
        }
    }
    false
}

/// No-allocation checks that run before any deserializer byte is read:
/// binary rejection, the body cap, and the structural depth bound.
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

/// Typed decode after [`preflight`]. The host calls this with a resident
/// reservation already held; [`parse_request`] is the unreserved public
/// composition of both stages.
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
            // Every accepted item consumes at least RESERVE_MIN_ITEM_BODY_BYTES
            // of body (a 64-hex hash plus field skeleton), so tightening the
            // item cap by the body can never reject a batch the configured
            // cap would have accepted; it only stops a small request from
            // pre-allocating (and reserving) configuration-sized capacity.
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

pub fn parse_request(
    body: &[u8],
    binary: bool,
    lane: &LaneInfo,
    limits: &SynapseLimits,
) -> Result<Request, RequestError> {
    preflight(body, binary)?;
    decode_request(body, lane, limits)
}

/// Per-item headroom in the parse reservation, beyond the item's share of
/// the body-proportional terms: the borrowed `ItemParams` shape, the owned
/// `BatchItem` struct, the recomputed content hash plus its admission-time
/// copies, and canonical-key punctuation.
const RESERVE_PER_ITEM_BYTES: usize = 640;

/// Fixed headroom in the parse reservation: the canonical-key envelope,
/// digest workspace, request/canonical key strings, and the bounded parse
/// diagnostic.
const RESERVE_ENVELOPE_BYTES: usize = 4096;

/// Body-proportional peak factor: escape-decoded borrowed strings, owned
/// copies of the accepted strings, and canonical-key scratch can each reach
/// the body length and be live together.
const RESERVE_BODY_FACTOR: usize = 3;

/// Conservative floor on the serialized size of one decodable batch item.
/// The accepted shape carries a 64-hex `content_sha256` plus the quoted
/// field skeleton (over 100 bytes together), so a body of `n` bytes can
/// never decode into more than `n / 64 + 1` items. Understating the floor
/// only overstates the item bound, which keeps the reservation an upper
/// bound.
const RESERVE_MIN_ITEM_BODY_BYTES: usize = 64;

/// The most batch items a body of `body_len` bytes can decode into:
/// the configured cap, tightened by what the body could physically
/// contain. Shared by the parse reservation and the batch seed's
/// pre-allocation so both scale with the request, not the configuration.
fn body_item_bound(body_len: usize, max_batch_items: usize) -> usize {
    max_batch_items.min(body_len / RESERVE_MIN_ITEM_BODY_BYTES + 1)
}

/// Conservative upper bound on every parse-phase heap allocation for one
/// request body — the allocation phase ledger's maximum covered phase.
/// `None` on arithmetic overflow, which callers treat as unsatisfiable.
/// The per-item term is capped by the number of items the body could
/// physically contain, so a large configured `max_batch_items` cannot
/// inflate the method-independent reservation for small (or non-batch)
/// bodies past the ingress pool and wedge every request into `queue_full`.
pub(crate) fn parse_reservation_bytes(body_len: usize, limits: &SynapseLimits) -> Option<usize> {
    let item_bound = body_item_bound(body_len, limits.max_batch_items);
    body_len
        .checked_mul(RESERVE_BODY_FACTOR)?
        .checked_add(item_bound.checked_mul(RESERVE_PER_ITEM_BYTES)?)?
        .checked_add(RESERVE_ENVELOPE_BYTES)
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
    if params.items.is_empty() {
        return Err(schema("item count out of bounds"));
    }
    let mut items = Vec::with_capacity(params.items.len());
    let mut total_text_bytes = 0usize;
    for raw in &params.items {
        check_string("item id", &raw.0.id, MAX_ITEM_ID_BYTES, true).map_err(schema)?;
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
/// The model name is charged at its escaped length, the form the body holds:
/// the manifest bounds it at 128 bytes and constrains no character within
/// them, so it can expand sixfold. The fingerprint is hexadecimal and the
/// cursor is server-built from hexadecimal and digits, so both serialize
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

    // -----------------------------------------------------------------
    // Depth preflight: the scanner must reproduce the former `value_depth`
    // convention (root container 1, each nested container +1, scalar leaf
    // +1) without being confused by string content.
    // -----------------------------------------------------------------

    #[test]
    fn depth_eight_passes_and_depth_nine_fails() {
        // Seven open containers with a scalar leaf: whole-body depth 8.
        let depth8 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}"#;
        assert!(!depth_exceeds(depth8, MAX_BODY_DEPTH));
        // One more nesting level: depth 9.
        let depth9 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}"#;
        assert!(depth_exceeds(depth9, MAX_BODY_DEPTH));
        // An empty container is a level of its own but adds no scalar.
        let empty8 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{}}}}}}}}"#;
        assert!(!depth_exceeds(empty8, MAX_BODY_DEPTH));
        let empty9 = br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{}}}}}}}}}"#;
        assert!(depth_exceeds(empty9, MAX_BODY_DEPTH));
        // Arrays count like objects.
        let arrays9 = br#"{"a":[[[[[[[1]]]]]]]}"#;
        assert!(depth_exceeds(arrays9, MAX_BODY_DEPTH));
    }

    #[test]
    fn depth_counts_params_that_precede_method() {
        let deep_params_first =
            br#"{"params":{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}},"method":"models.list"}"#;
        assert!(depth_exceeds(deep_params_first, MAX_BODY_DEPTH));
        let error = parse_request(deep_params_first, false, &lane(), &SynapseLimits::default())
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
        // Odd backslash run: the quote is escaped and the string continues
        // over the braces.
        assert!(!depth_exceeds(
            br#"{"a":"x\"{{{{{{{{{{","b":1}"#,
            MAX_BODY_DEPTH
        ));
        // Even backslash run: the string really closes, and the following
        // containers must count.
        assert!(depth_exceeds(
            br#"{"a":"x\\","b":[[[[[[[[1]]]]]]]]}"#,
            MAX_BODY_DEPTH
        ));
    }

    #[test]
    fn a_scalar_at_the_container_limit_is_one_level_deeper() {
        // Eight open containers alone are exactly the limit…
        assert!(!depth_exceeds(
            br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{}}}}}}}}"#,
            8
        ));
        // …but any scalar (or key) inside the eighth is level nine.
        assert!(depth_exceeds(
            br#"{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}"#,
            8
        ));
    }

    // -----------------------------------------------------------------
    // Bounded batch decode.
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
        // The boundary element is deliberately invalid in every field — an
        // unknown key, a wrong hash, an over-long id — so any error other
        // than the count proves it was decoded.
        let overflow = format!(
            "[{},{},{{\"junk\":1,\"id\":\"{}\",\"content_sha256\":\"zzz\"}}]",
            item_json("a", "one"),
            item_json("b", "two"),
            "x".repeat(4096),
        );
        let error = parse_request(&batch_body(&lane, &overflow), false, &lane, &limits)
            .expect_err("the third element exceeds the bound");
        assert_eq!(error.code, "schema_violation");
        assert!(
            error.message.contains("item count out of bounds"),
            "{}",
            error.message
        );

        // Exactly the bound still parses.
        let exact = format!("[{},{}]", item_json("a", "one"), item_json("b", "two"));
        let key = canonical_request_key(&lane, &[item("a", "one"), item("b", "two")]);
        let body = String::from_utf8(batch_body(&lane, &exact))
            .expect("utf8")
            .replace(&"0".repeat(64), &key)
            .into_bytes();
        let request = parse_request(&body, false, &lane, &limits).expect("exact bound parses");
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
            let error = parse_request(&body, false, &lane, &limits).expect_err(case);
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
        let request = parse_request(&body, false, &lane, &limits).expect("escaped batch parses");
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
        let error = parse_request(&body, false, &lane, &limits)
            .expect_err("unknown top-level field is refused");
        assert_eq!(error.code, "schema_violation");
        assert!(error.message.len() <= MAX_DIAGNOSTIC_BYTES);
        assert!(error.message.capacity() <= 2 * MAX_DIAGNOSTIC_BYTES);
    }

    // -----------------------------------------------------------------
    // Parse reservation arithmetic.
    // -----------------------------------------------------------------

    #[test]
    fn the_maximum_default_reservation_fits_the_default_ingress_pool() {
        let bound = parse_reservation_bytes(MAX_BODY_BYTES, &SynapseLimits::default())
            .expect("the default bound is computable");
        let limits = crate::config::HostLimits::default();
        let ingress = limits.max_resident_bytes - crate::config::EGRESS_RESERVED_BYTES;
        // One maximum body charge plus its parse reservation must fit with
        // a megabyte to spare for a linked catalog.
        assert!(
            (bound + MAX_BODY_BYTES) as u64 + (1 << 20) <= ingress,
            "bound {bound} does not fit the default ingress pool {ingress}"
        );
    }

    #[test]
    fn reservation_arithmetic_is_checked() {
        let limits = SynapseLimits::default();
        assert!(parse_reservation_bytes(usize::MAX, &limits).is_none());
        // A huge configured max_batch_items cannot inflate the reservation
        // for a small body past what the body could physically contain:
        // the bound stays satisfiable, so the configuration cannot wedge
        // every request (including non-batch methods) into queue_full.
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
        // The bound is monotone in the body length.
        let small = parse_reservation_bytes(1024, &limits).expect("small");
        let large = parse_reservation_bytes(2048, &limits).expect("large");
        assert!(large > small);
    }

    /// The resident-byte guarantee rests on `parse_reservation_bytes`
    /// dominating the post-decode owned bytes the handler shrinks to:
    /// `ByteCharge::shrink_to` cannot grow a charge and `split_or_take`
    /// falls back to "take what is left", so an undersized reservation is a
    /// silent under-charge. This pins the dominance for the adversarial
    /// shapes most likely to break it: escape-heavy strings (where serde's
    /// decode scratch capacity, not the decoded length, is what the owned
    /// `String` keeps) and item metadata at its size limits.
    #[test]
    fn the_parse_reservation_dominates_post_decode_owned_bytes() {
        const RESPONSE_SCRATCH_BYTES: usize = super::super::RESPONSE_SCRATCH_BYTES;
        let limits = SynapseLimits::default();
        let lane = lane();

        // Query path: owned = text.capacity() + response scratch.
        for text_json in [
            "\\\"".repeat(4096),    // two body bytes per decoded byte
            "\\u0041".repeat(1024), // six body bytes per decoded byte
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
            let reservation =
                parse_reservation_bytes(body.len(), &limits).expect("bound is computable");
            let Request::EmbedQuery { text, .. } =
                parse_request(&body, false, &lane, &limits).expect("query parses")
            else {
                panic!("expected a query");
            };
            let owned = text.capacity() + RESPONSE_SCRATCH_BYTES;
            assert!(
                reservation >= owned,
                "reservation {reservation} does not dominate query owned bytes {owned}"
            );
        }

        // Batch path: owned exactly as `handle` sizes the shrink — the
        // job's input bytes plus both key capacities and response scratch.
        let items_json: Vec<String> = (0..8)
            .map(|index| {
                let decoded = "\"".repeat(512);
                format!(
                    "{{\"id\":\"{index:0>256}\",\"text\":\"{}\",\"content_sha256\":\"{}\"}}",
                    "\\\"".repeat(512),
                    sha256_hex(decoded.as_bytes()),
                )
            })
            .collect();
        let body = batch_body(&lane, &format!("[{}]", items_json.join(",")));
        let reservation =
            parse_reservation_bytes(body.len(), &limits).expect("bound is computable");
        let Request::EmbedBatch {
            request_key,
            canonical_key,
            items,
        } = parse_request(&body, false, &lane, &limits).expect("batch parses")
        else {
            panic!("expected a batch");
        };
        let owned = super::super::jobs::job_input_bytes(&request_key, &items)
            + request_key.capacity()
            + canonical_key.capacity()
            + RESPONSE_SCRATCH_BYTES;
        assert!(
            reservation >= owned,
            "reservation {reservation} does not dominate batch owned bytes {owned}"
        );
    }
}
