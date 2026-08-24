//! Negotiation version 1 wire grammar: `transport.negotiate` offers and
//! selections plus the candidate-only `transport.activate` and
//! `transport.commit` exchanges (protocol §7.7).
//!
//! Leaf module: no connection, routing, or provider code. Decoding is
//! strict — closed field sets, exact bounds, and recursive duplicate-key
//! rejection (including inside the opaque provider `parameters` and
//! `descriptor` values) before any typed or opaque value is materialized.
//! Decode failures carry only a bounded code and a structural field path;
//! provider bytes, tokens, and descriptors never reach errors or formatting.

use std::fmt;

use crate::control::strict_json;

pub const OP_TRANSPORT_NEGOTIATE: &str = "transport.negotiate";
pub const OP_TRANSPORT_ACTIVATE: &str = "transport.activate";
pub const OP_TRANSPORT_COMMIT: &str = "transport.commit";

/// The negotiation grammar version this module implements.
pub const NEGOTIATION_VERSION: u32 = 1;
/// The required fallback transport name (protocol §7.7.2).
pub const TRANSPORT_TCP: &str = "tcp";
/// Offers are ordered by client preference, 1 to 8 entries.
pub const MAX_OFFERS: usize = 8;
/// Transport names are 1-32 ASCII bytes matching `^[a-z][a-z0-9._-]{0,31}$`.
pub const MAX_TRANSPORT_NAME_BYTES: usize = 32;
/// Opaque `parameters`/`descriptor` compact-JSON sub-cap (protocol §7.7.1).
pub const MAX_OPAQUE_BYTES: usize = 8192;
/// Opaque `parameters`/`descriptor` nesting bound, counted as in §7.1.
pub const MAX_OPAQUE_DEPTH: usize = 8;
/// Activation tokens are exactly 32 lowercase hexadecimal ASCII characters.
pub const ACTIVATION_TOKEN_LEN: usize = 32;

/// Candidate consumer correlation reserved for `transport.activate`.
pub const ACTIVATION_CORRELATION: u64 = 1;
/// Candidate consumer correlation reserved for `transport.commit`.
pub const COMMIT_CORRELATION: u64 = 2;
/// First candidate consumer correlation available to application requests.
pub const FIRST_APPLICATION_CORRELATION: u64 = 3;

/// Bounded decode/encode failure taxonomy. Stable snake-case wire names via
/// [`NegotiationErrorCode::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NegotiationErrorCode {
    MalformedJson,
    InvalidType,
    MissingField,
    UnexpectedField,
    InvalidVersion,
    InvalidTransportName,
    InvalidOfferCount,
    DuplicateOffer,
    MissingTcpOffer,
    OpaqueTooLarge,
    OpaqueTooDeep,
    InvalidActivationToken,
    InvalidReason,
    UnofferedSelection,
    WrongOperation,
}

impl NegotiationErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MalformedJson => "malformed_json",
            Self::InvalidType => "invalid_type",
            Self::MissingField => "missing_field",
            Self::UnexpectedField => "unexpected_field",
            Self::InvalidVersion => "invalid_version",
            Self::InvalidTransportName => "invalid_transport_name",
            Self::InvalidOfferCount => "invalid_offer_count",
            Self::DuplicateOffer => "duplicate_offer",
            Self::MissingTcpOffer => "missing_tcp_offer",
            Self::OpaqueTooLarge => "opaque_too_large",
            Self::OpaqueTooDeep => "opaque_too_deep",
            Self::InvalidActivationToken => "invalid_activation_token",
            Self::InvalidReason => "invalid_reason",
            Self::UnofferedSelection => "unoffered_selection",
            Self::WrongOperation => "wrong_operation",
        }
    }
}

/// One negotiation decode/encode failure: a bounded code plus a structural
/// field path built only from documented field names and offer indices.
/// Client-supplied bytes — unknown key names, provider parameters,
/// descriptors, and tokens — never appear here, in `Display`, or in `Debug`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegotiationError {
    pub code: NegotiationErrorCode,
    pub path: String,
}

impl NegotiationError {
    fn new(code: NegotiationErrorCode, path: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
        }
    }
}

impl fmt::Display for NegotiationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at {}", self.code.as_str(), self.path)
    }
}

impl std::error::Error for NegotiationError {}

/// Closed fallback vocabulary (protocol §7.7.3). Fallback always selects the
/// offered `tcp` entry; every other setup outcome fails closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
    Unavailable,
    NegotiationVersionMismatch,
    CapabilityVersionMismatch,
    ConnectionInUse,
}

impl FallbackReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::NegotiationVersionMismatch => "negotiation_version_mismatch",
            Self::CapabilityVersionMismatch => "capability_version_mismatch",
            Self::ConnectionInUse => "connection_in_use",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "unavailable" => Some(Self::Unavailable),
            "negotiation_version_mismatch" => Some(Self::NegotiationVersionMismatch),
            "capability_version_mismatch" => Some(Self::CapabilityVersionMismatch),
            "connection_in_use" => Some(Self::ConnectionInUse),
            _ => None,
        }
    }
}

/// One-use grant token: exactly 32 lowercase hexadecimal ASCII characters.
/// No `Display`, and `Debug` redacts, so the token cannot leak through
/// formatting (R14).
#[derive(Clone)]
pub struct ActivationToken(String);

// Constant-time equality: XOR-fold every byte pair instead of early-exiting on the first mismatch. commentlint: allow(JUDGE)
impl PartialEq for ActivationToken {
    fn eq(&self, other: &Self) -> bool {
        // The length guard keeps `zip` from truncating the comparison: without
        // it, tokens of unequal length sharing a prefix would compare equal.
        // Token length is a fixed public constant, so the early exit leaks
        // nothing.
        self.0.len() == other.0.len()
            && self
                .0
                .as_bytes()
                .iter()
                .zip(other.0.as_bytes())
                .fold(0u8, |acc, (x, y)| acc | (x ^ y))
                == 0
    }
}

impl Eq for ActivationToken {}

impl ActivationToken {
    pub fn parse(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != ACTIVATION_TOKEN_LEN {
            return None;
        }
        if !bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return None;
        }
        Some(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ActivationToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ActivationToken(<redacted>)")
    }
}

/// One ordered client offer. `parameters` is opaque provider data; `Debug`
/// redacts it.
#[derive(Clone, PartialEq)]
pub struct TransportOffer {
    pub transport: String,
    pub capability_version: u32,
    pub parameters: Option<serde_json::Value>,
}

impl fmt::Debug for TransportOffer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransportOffer")
            .field("transport", &self.transport)
            .field("capability_version", &self.capability_version)
            .field("parameters", &self.parameters.as_ref().map(|_| "<opaque>"))
            .finish()
    }
}

/// The validated `transport.negotiate` request.
#[derive(Debug, Clone, PartialEq)]
pub struct NegotiateRequest {
    pub negotiation_version: u32,
    pub offers: Vec<TransportOffer>,
}

/// The exact offered entry a response names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedTransport {
    pub transport: String,
    pub capability_version: u32,
}

/// The validated `transport.negotiate` response. The enum encodes the field
/// mix invariants: only a TCP selection may carry a `reason`, and only a
/// non-TCP grant carries the token/descriptor pair.
#[derive(Clone, PartialEq)]
pub enum NegotiateResponse {
    /// The offered `tcp` entry, directly or as an explicit fallback.
    Tcp { reason: Option<FallbackReason> },
    /// A non-TCP grant: exact offered entry, one-use token, and an opaque
    /// bounded provider descriptor.
    Grant {
        selected: SelectedTransport,
        activation_token: ActivationToken,
        descriptor: serde_json::Value,
    },
}

impl fmt::Debug for NegotiateResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Tcp { reason } => f.debug_struct("Tcp").field("reason", reason).finish(),
            Self::Grant {
                selected,
                activation_token,
                ..
            } => f
                .debug_struct("Grant")
                .field("selected", selected)
                .field("activation_token", activation_token)
                .field("descriptor", &"<opaque>")
                .finish(),
        }
    }
}

/// The validated candidate `transport.activate` request (correlation 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivateRequest {
    pub activation_token: ActivationToken,
}

fn parse_root(body: &[u8]) -> Result<serde_json::Map<String, serde_json::Value>, NegotiationError> {
    let root = strict_json::parse(body)
        .map_err(|_| NegotiationError::new(NegotiationErrorCode::MalformedJson, "body"))?;
    match root {
        serde_json::Value::Object(fields) => Ok(fields),
        _ => Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            "body",
        )),
    }
}

/// Rejects any key outside `allowed`. The unknown key itself is
/// client-supplied and is deliberately not echoed into the error path.
fn check_closed_fields(
    fields: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), NegotiationError> {
    for key in fields.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(NegotiationError::new(
                NegotiationErrorCode::UnexpectedField,
                path,
            ));
        }
    }
    Ok(())
}

fn require_op(
    fields: &serde_json::Map<String, serde_json::Value>,
    expected: &str,
) -> Result<(), NegotiationError> {
    let Some(op) = fields.get("op") else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            "op",
        ));
    };
    let Some(op) = op.as_str() else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            "op",
        ));
    };
    if op != expected {
        return Err(NegotiationError::new(
            NegotiationErrorCode::WrongOperation,
            "op",
        ));
    }
    Ok(())
}

/// A version field is a JSON integer in `1..=u32::MAX`. Zero, fractions,
/// exponent forms (which parse as floats), and larger values all fail.
fn require_version(
    fields: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    path: &str,
) -> Result<u32, NegotiationError> {
    let Some(value) = fields.get(key) else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            path,
        ));
    };
    let serde_json::Value::Number(number) = value else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            path,
        ));
    };
    match number.as_u64() {
        Some(version) if version >= 1 && version <= u64::from(u32::MAX) => Ok(version as u32),
        _ => Err(NegotiationError::new(
            NegotiationErrorCode::InvalidVersion,
            path,
        )),
    }
}

fn valid_transport_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_TRANSPORT_NAME_BYTES {
        return false;
    }
    bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

fn require_transport_name<'a>(
    fields: &'a serde_json::Map<String, serde_json::Value>,
    path_prefix: &str,
) -> Result<&'a str, NegotiationError> {
    let path = format!("{path_prefix}.transport");
    let Some(value) = fields.get("transport") else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            path,
        ));
    };
    let Some(name) = value.as_str() else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            path,
        ));
    };
    if !valid_transport_name(name) {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidTransportName,
            path,
        ));
    }
    Ok(name)
}

/// Opaque `parameters`/`descriptor` bounds: a JSON object at most
/// [`MAX_OPAQUE_BYTES`] compact bytes and [`MAX_OPAQUE_DEPTH`] levels deep.
/// Duplicate keys inside the value were already rejected by the strict parse.
fn check_opaque(value: &serde_json::Value, path: &str) -> Result<(), NegotiationError> {
    if !value.is_object() {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            path,
        ));
    }
    let compact = serde_json::to_vec(value).expect("Value serialization cannot fail");
    if compact.len() > MAX_OPAQUE_BYTES {
        return Err(NegotiationError::new(
            NegotiationErrorCode::OpaqueTooLarge,
            path,
        ));
    }
    if crate::control::value_depth(value) > MAX_OPAQUE_DEPTH {
        return Err(NegotiationError::new(
            NegotiationErrorCode::OpaqueTooDeep,
            path,
        ));
    }
    Ok(())
}

fn decode_offers(
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<TransportOffer>, NegotiationError> {
    let Some(value) = fields.get("offers") else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            "offers",
        ));
    };
    let serde_json::Value::Array(entries) = value else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            "offers",
        ));
    };
    if entries.is_empty() || entries.len() > MAX_OFFERS {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidOfferCount,
            "offers",
        ));
    }

    let mut offers: Vec<TransportOffer> = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let path = format!("offers[{index}]");
        let serde_json::Value::Object(offer) = entry else {
            return Err(NegotiationError::new(
                NegotiationErrorCode::InvalidType,
                path,
            ));
        };
        check_closed_fields(
            offer,
            &["transport", "capability_version", "parameters"],
            &path,
        )?;
        let transport = require_transport_name(offer, &path)?;
        let capability_version = require_version(
            offer,
            "capability_version",
            &format!("{path}.capability_version"),
        )?;
        let parameters = match offer.get("parameters") {
            None => None,
            Some(value) => {
                check_opaque(value, &format!("{path}.parameters"))?;
                Some(value.clone())
            }
        };
        if offers.iter().any(|prior| {
            prior.transport == transport && prior.capability_version == capability_version
        }) {
            return Err(NegotiationError::new(
                NegotiationErrorCode::DuplicateOffer,
                path,
            ));
        }
        offers.push(TransportOffer {
            transport: transport.to_owned(),
            capability_version,
            parameters,
        });
    }

    if !offers.iter().any(|offer| offer.transport == TRANSPORT_TCP) {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingTcpOffer,
            "offers",
        ));
    }
    Ok(offers)
}

/// Decodes and fully validates one `transport.negotiate` request body.
///
/// The strict duplicate-aware parse runs first, so repeated keys at any
/// depth — including inside opaque `parameters` — fail before any typed
/// decoding. An unsupported-but-valid `negotiation_version` decodes
/// successfully: the version-mismatch fallback is host policy, not grammar.
pub fn decode_negotiate_request(body: &[u8]) -> Result<NegotiateRequest, NegotiationError> {
    let fields = parse_root(body)?;
    check_closed_fields(&fields, &["op", "negotiation_version", "offers"], "body")?;
    require_op(&fields, OP_TRANSPORT_NEGOTIATE)?;
    let negotiation_version =
        require_version(&fields, "negotiation_version", "negotiation_version")?;
    let offers = decode_offers(&fields)?;
    Ok(NegotiateRequest {
        negotiation_version,
        offers,
    })
}

/// Decodes and fully validates one `transport.negotiate` response body
/// against the request's `offers`: the selection MUST name an exact offered
/// `(transport, capability_version)` entry (protocol §7.7.2).
pub fn decode_negotiate_response(
    body: &[u8],
    offers: &[TransportOffer],
) -> Result<NegotiateResponse, NegotiationError> {
    let fields = parse_root(body)?;
    check_closed_fields(
        &fields,
        &[
            "op",
            "negotiation_version",
            "selected",
            "reason",
            "activation_token",
            "descriptor",
        ],
        "body",
    )?;
    require_op(&fields, OP_TRANSPORT_NEGOTIATE)?;
    let version = require_version(&fields, "negotiation_version", "negotiation_version")?;
    if version != NEGOTIATION_VERSION {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidVersion,
            "negotiation_version",
        ));
    }

    let Some(selected_value) = fields.get("selected") else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            "selected",
        ));
    };
    let serde_json::Value::Object(selected_fields) = selected_value else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            "selected",
        ));
    };
    check_closed_fields(
        selected_fields,
        &["transport", "capability_version"],
        "selected",
    )?;
    let transport = require_transport_name(selected_fields, "selected")?;
    let capability_version = require_version(
        selected_fields,
        "capability_version",
        "selected.capability_version",
    )?;
    if !offers
        .iter()
        .any(|offer| offer.transport == transport && offer.capability_version == capability_version)
    {
        return Err(NegotiationError::new(
            NegotiationErrorCode::UnofferedSelection,
            "selected",
        ));
    }

    if transport == TRANSPORT_TCP {
        if fields.contains_key("activation_token") {
            return Err(NegotiationError::new(
                NegotiationErrorCode::UnexpectedField,
                "activation_token",
            ));
        }
        if fields.contains_key("descriptor") {
            return Err(NegotiationError::new(
                NegotiationErrorCode::UnexpectedField,
                "descriptor",
            ));
        }
        let reason = match fields.get("reason") {
            None => None,
            Some(value) => {
                let Some(reason) = value.as_str() else {
                    return Err(NegotiationError::new(
                        NegotiationErrorCode::InvalidType,
                        "reason",
                    ));
                };
                match FallbackReason::parse(reason) {
                    Some(reason) => Some(reason),
                    None => {
                        return Err(NegotiationError::new(
                            NegotiationErrorCode::InvalidReason,
                            "reason",
                        ))
                    }
                }
            }
        };
        return Ok(NegotiateResponse::Tcp { reason });
    }

    if fields.contains_key("reason") {
        return Err(NegotiationError::new(
            NegotiationErrorCode::UnexpectedField,
            "reason",
        ));
    }
    let activation_token = require_activation_token(&fields)?;
    let Some(descriptor) = fields.get("descriptor") else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            "descriptor",
        ));
    };
    check_opaque(descriptor, "descriptor")?;

    Ok(NegotiateResponse::Grant {
        selected: SelectedTransport {
            transport: transport.to_owned(),
            capability_version,
        },
        activation_token,
        descriptor: descriptor.clone(),
    })
}

/// Decodes one candidate `transport.activate` request body (correlation 1).
pub fn decode_activate_request(body: &[u8]) -> Result<ActivateRequest, NegotiationError> {
    let fields = parse_root(body)?;
    check_closed_fields(
        &fields,
        &["op", "negotiation_version", "activation_token"],
        "body",
    )?;
    require_op(&fields, OP_TRANSPORT_ACTIVATE)?;
    require_exact_version(&fields)?;
    let activation_token = require_activation_token(&fields)?;
    Ok(ActivateRequest { activation_token })
}

fn require_activation_token(
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<ActivationToken, NegotiationError> {
    let Some(token_value) = fields.get("activation_token") else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingField,
            "activation_token",
        ));
    };
    let Some(token) = token_value.as_str() else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidType,
            "activation_token",
        ));
    };
    let Some(activation_token) = ActivationToken::parse(token) else {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidActivationToken,
            "activation_token",
        ));
    };
    Ok(activation_token)
}

/// Decodes one tagged candidate `transport.activate` response body. Carries
/// no provider data: any additional field is malformed (protocol §7.7.4).
pub fn decode_activate_response(body: &[u8]) -> Result<(), NegotiationError> {
    decode_tagged_only(body, OP_TRANSPORT_ACTIVATE)
}

/// Decodes one candidate `transport.commit` request body (correlation 2).
pub fn decode_commit_request(body: &[u8]) -> Result<(), NegotiationError> {
    decode_tagged_only(body, OP_TRANSPORT_COMMIT)
}

/// Decodes one tagged candidate `transport.commit` response body.
pub fn decode_commit_response(body: &[u8]) -> Result<(), NegotiationError> {
    decode_tagged_only(body, OP_TRANSPORT_COMMIT)
}

fn decode_tagged_only(body: &[u8], op: &str) -> Result<(), NegotiationError> {
    let fields = parse_root(body)?;
    check_closed_fields(&fields, &["op", "negotiation_version"], "body")?;
    require_op(&fields, op)?;
    require_exact_version(&fields)?;
    Ok(())
}

fn require_exact_version(
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), NegotiationError> {
    let version = require_version(fields, "negotiation_version", "negotiation_version")?;
    if version != NEGOTIATION_VERSION {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidVersion,
            "negotiation_version",
        ));
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct WireOffer<'a> {
    transport: &'a str,
    capability_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<&'a serde_json::Value>,
}

#[derive(serde::Serialize)]
struct WireNegotiateRequest<'a> {
    op: &'static str,
    negotiation_version: u32,
    offers: Vec<WireOffer<'a>>,
}

#[derive(serde::Serialize)]
struct WireSelected<'a> {
    transport: &'a str,
    capability_version: u32,
}

#[derive(serde::Serialize)]
struct WireNegotiateResponse<'a> {
    op: &'static str,
    negotiation_version: u32,
    selected: WireSelected<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activation_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    descriptor: Option<&'a serde_json::Value>,
}

/// Encodes one compact canonical `transport.negotiate` request after
/// revalidating the same bounds the decoder enforces, so a conforming
/// encoder cannot emit out-of-contract bytes.
pub fn encode_negotiate_request(request: &NegotiateRequest) -> Result<Vec<u8>, NegotiationError> {
    if request.negotiation_version == 0 {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidVersion,
            "negotiation_version",
        ));
    }
    if request.offers.is_empty() || request.offers.len() > MAX_OFFERS {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidOfferCount,
            "offers",
        ));
    }
    let mut wire_offers = Vec::with_capacity(request.offers.len());
    for (index, offer) in request.offers.iter().enumerate() {
        let path = format!("offers[{index}]");
        if !valid_transport_name(&offer.transport) {
            return Err(NegotiationError::new(
                NegotiationErrorCode::InvalidTransportName,
                format!("{path}.transport"),
            ));
        }
        if offer.capability_version == 0 {
            return Err(NegotiationError::new(
                NegotiationErrorCode::InvalidVersion,
                format!("{path}.capability_version"),
            ));
        }
        if let Some(parameters) = &offer.parameters {
            check_opaque(parameters, &format!("{path}.parameters"))?;
        }
        if request.offers[..index].iter().any(|prior| {
            prior.transport == offer.transport
                && prior.capability_version == offer.capability_version
        }) {
            return Err(NegotiationError::new(
                NegotiationErrorCode::DuplicateOffer,
                path,
            ));
        }
        wire_offers.push(WireOffer {
            transport: &offer.transport,
            capability_version: offer.capability_version,
            parameters: offer.parameters.as_ref(),
        });
    }
    if !request
        .offers
        .iter()
        .any(|offer| offer.transport == TRANSPORT_TCP)
    {
        return Err(NegotiationError::new(
            NegotiationErrorCode::MissingTcpOffer,
            "offers",
        ));
    }
    Ok(serde_json::to_vec(&WireNegotiateRequest {
        op: OP_TRANSPORT_NEGOTIATE,
        negotiation_version: request.negotiation_version,
        offers: wire_offers,
    })
    .expect("negotiate request serialization cannot fail"))
}

/// Encodes one compact canonical `transport.negotiate` response. The TCP
/// selection names the required `tcp` offer entry with `capability_version`
/// taken from `tcp_capability_version` (the exact offered value).
///
/// `negotiation_version` is the *request's* grammar version, echoed per
/// §7.7.2. Echoing matters for the `negotiation_version_mismatch` fallback:
/// a peer speaking another version must be able to decode the response and
/// retain TCP (R8), which it cannot do if the host stamps its own version.
pub fn encode_negotiate_response(
    response: &NegotiateResponse,
    negotiation_version: u32,
    tcp_capability_version: u32,
) -> Result<Vec<u8>, NegotiationError> {
    if negotiation_version == 0 {
        return Err(NegotiationError::new(
            NegotiationErrorCode::InvalidVersion,
            "negotiation_version",
        ));
    }
    let wire = match response {
        NegotiateResponse::Tcp { reason } => {
            if tcp_capability_version == 0 {
                return Err(NegotiationError::new(
                    NegotiationErrorCode::InvalidVersion,
                    "selected.capability_version",
                ));
            }
            WireNegotiateResponse {
                op: OP_TRANSPORT_NEGOTIATE,
                negotiation_version,
                selected: WireSelected {
                    transport: TRANSPORT_TCP,
                    capability_version: tcp_capability_version,
                },
                reason: reason.map(|reason| reason.as_str()),
                activation_token: None,
                descriptor: None,
            }
        }
        NegotiateResponse::Grant {
            selected,
            activation_token,
            descriptor,
        } => {
            if !valid_transport_name(&selected.transport) || selected.transport == TRANSPORT_TCP {
                return Err(NegotiationError::new(
                    NegotiationErrorCode::InvalidTransportName,
                    "selected.transport",
                ));
            }
            if selected.capability_version == 0 {
                return Err(NegotiationError::new(
                    NegotiationErrorCode::InvalidVersion,
                    "selected.capability_version",
                ));
            }
            check_opaque(descriptor, "descriptor")?;
            WireNegotiateResponse {
                op: OP_TRANSPORT_NEGOTIATE,
                negotiation_version,
                selected: WireSelected {
                    transport: &selected.transport,
                    capability_version: selected.capability_version,
                },
                reason: None,
                activation_token: Some(activation_token.as_str()),
                descriptor: Some(descriptor),
            }
        }
    };
    Ok(serde_json::to_vec(&wire).expect("negotiate response serialization cannot fail"))
}

#[derive(serde::Serialize)]
struct WireActivateRequest<'a> {
    op: &'static str,
    negotiation_version: u32,
    activation_token: &'a str,
}

/// Encodes the candidate `transport.activate` request (correlation 1).
pub fn encode_activate_request(token: &ActivationToken) -> Vec<u8> {
    serde_json::to_vec(&WireActivateRequest {
        op: OP_TRANSPORT_ACTIVATE,
        negotiation_version: NEGOTIATION_VERSION,
        activation_token: token.as_str(),
    })
    .expect("activate request serialization cannot fail")
}

#[derive(serde::Serialize)]
struct WireTaggedBody {
    op: &'static str,
    negotiation_version: u32,
}

/// One `{op, negotiation_version}` candidate body. Built from the module
/// constants rather than a frozen literal so a `NEGOTIATION_VERSION` bump
/// cannot leave these emitting a version their own decoders reject.
fn tagged_body(op: &'static str) -> Vec<u8> {
    serde_json::to_vec(&WireTaggedBody {
        op,
        negotiation_version: NEGOTIATION_VERSION,
    })
    .expect("tagged negotiation body serialization cannot fail")
}

/// The tagged candidate `transport.activate` response (correlation 1).
pub fn activate_response_json() -> Vec<u8> {
    tagged_body(OP_TRANSPORT_ACTIVATE)
}

/// The candidate `transport.commit` request (correlation 2).
pub fn commit_request_json() -> Vec<u8> {
    tagged_body(OP_TRANSPORT_COMMIT)
}

/// The tagged candidate `transport.commit` response (correlation 2).
pub fn commit_response_json() -> Vec<u8> {
    tagged_body(OP_TRANSPORT_COMMIT)
}
