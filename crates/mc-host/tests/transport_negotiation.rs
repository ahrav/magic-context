//! Negotiation version 1 acceptance/rejection matrix (U1): the exact bodies
//! and bounds pinned in `docs/mc-host-wire-protocol.md` §7.7, exercised
//! against the production decoders and encoders. The TypeScript suite in
//! `packages/plugin/src/shared/mc-host-client/transport-negotiation.test.ts`
//! mirrors this matrix vector-for-vector.

mod support;

use std::sync::Arc;
use std::time::Duration;

use mc_host::transport_provider::{
    GrantBinding, GrantRecord, GrantRejection, InjectedProvider, PreparedCandidate,
    ProviderContext, ProviderFailure, TransportProviders,
};
use support::fake_transport::{FakeProvider, RawCandidate, FAKE_TRANSPORT};
use support::raw_client::{
    self, RawFrame, FLAGS_INTERACTIVE, FLAGS_PURE_HEADER, TY_GOODBYE, TY_PING, TY_PONG, TY_REQUEST,
    TY_RESPONSE,
};
use support::{TestHost, LINKED_MODULE_ID};

use mc_host::transport_negotiation::{
    activate_response_json, commit_request_json, commit_response_json, decode_activate_request,
    decode_activate_response, decode_commit_request, decode_commit_response,
    decode_negotiate_request, decode_negotiate_response, encode_activate_request,
    encode_negotiate_request, encode_negotiate_response, ActivationToken, FallbackReason,
    NegotiateRequest, NegotiateResponse, NegotiationError, NegotiationErrorCode, SelectedTransport,
    TransportOffer, ACTIVATION_CORRELATION, COMMIT_CORRELATION, FIRST_APPLICATION_CORRELATION,
    MAX_OFFERS, MAX_OPAQUE_BYTES, MAX_OPAQUE_DEPTH, MAX_TRANSPORT_NAME_BYTES, NEGOTIATION_VERSION,
    TRANSPORT_TCP,
};

const VECTOR_TOKEN: &str = "00112233445566778899aabbccddeeff";

const REQ_TCP_ONLY: &str = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}]}"#;
const REQ_SHM_TCP: &str = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"shm","capability_version":1,"parameters":{}},{"transport":"tcp","capability_version":1}]}"#;
const RESP_TCP_DIRECT: &str = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1}}"#;
const RESP_TCP_FALLBACK: &str = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"reason":"capability_version_mismatch"}"#;
const RESP_GRANT: &str = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"00112233445566778899aabbccddeeff","descriptor":{}}"#;
const ACTIVATE_REQ: &str = r#"{"op":"transport.activate","negotiation_version":1,"activation_token":"00112233445566778899aabbccddeeff"}"#;
const ACTIVATE_RESP: &str = r#"{"op":"transport.activate","negotiation_version":1}"#;
const COMMIT_REQ: &str = r#"{"op":"transport.commit","negotiation_version":1}"#;
const COMMIT_RESP: &str = r#"{"op":"transport.commit","negotiation_version":1}"#;

fn tcp_offer(capability_version: u32) -> TransportOffer {
    TransportOffer {
        transport: TRANSPORT_TCP.to_owned(),
        capability_version,
        parameters: None,
    }
}

fn shm_offer(capability_version: u32) -> TransportOffer {
    TransportOffer {
        transport: "shm".to_owned(),
        capability_version,
        parameters: None,
    }
}

fn code(result: Result<impl Sized, NegotiationError>) -> NegotiationErrorCode {
    match result {
        Ok(_) => panic!("expected rejection"),
        Err(err) => err.code,
    }
}

#[test]
fn tcp_only_offer_and_selection_round_trip() {
    let request = decode_negotiate_request(REQ_TCP_ONLY.as_bytes()).expect("pinned request");
    assert_eq!(request.negotiation_version, NEGOTIATION_VERSION);
    assert_eq!(request.offers.len(), 1);
    assert_eq!(request.offers[0].transport, TRANSPORT_TCP);
    assert_eq!(request.offers[0].capability_version, 1);
    assert!(request.offers[0].parameters.is_none());
    assert_eq!(
        encode_negotiate_request(&request).expect("re-encode"),
        REQ_TCP_ONLY.as_bytes(),
        "encode must reproduce the pinned compact body byte-for-byte"
    );

    let response =
        decode_negotiate_response(RESP_TCP_DIRECT.as_bytes(), &request.offers).expect("selection");
    let NegotiateResponse::Tcp { reason } = &response else {
        panic!("expected a TCP selection");
    };
    assert_eq!(*reason, None, "a direct selection carries no reason");
    assert_eq!(
        encode_negotiate_response(&response, 1, 1).expect("re-encode"),
        RESP_TCP_DIRECT.as_bytes()
    );
}

#[test]
fn ordered_offers_preserve_order_and_selection_must_be_exact() {
    let request = decode_negotiate_request(REQ_SHM_TCP.as_bytes()).expect("pinned request");
    assert_eq!(request.offers.len(), 2);
    assert_eq!(
        request.offers[0].transport, "shm",
        "client order is preserved"
    );
    assert_eq!(request.offers[1].transport, TRANSPORT_TCP);
    assert_eq!(
        request.offers[0].parameters,
        Some(serde_json::json!({})),
        "opaque parameters survive decoding"
    );
    assert_eq!(
        encode_negotiate_request(&request).expect("re-encode"),
        REQ_SHM_TCP.as_bytes()
    );

    // The grant names the exact offered shm entry.
    let response =
        decode_negotiate_response(RESP_GRANT.as_bytes(), &request.offers).expect("grant");
    let NegotiateResponse::Grant {
        selected,
        activation_token,
        descriptor,
    } = &response
    else {
        panic!("expected a grant");
    };
    assert_eq!(selected.transport, "shm");
    assert_eq!(selected.capability_version, 1);
    assert_eq!(activation_token.as_str(), VECTOR_TOKEN);
    assert_eq!(descriptor, &serde_json::json!({}));
    assert_eq!(
        encode_negotiate_response(&response, 1, 1).expect("re-encode"),
        RESP_GRANT.as_bytes()
    );
}

#[test]
fn version_mismatches_encode_the_documented_tcp_fallback_reasons() {
    let offers = [shm_offer(1), tcp_offer(1)];
    let response =
        decode_negotiate_response(RESP_TCP_FALLBACK.as_bytes(), &offers).expect("fallback");
    let NegotiateResponse::Tcp { reason } = &response else {
        panic!("expected a TCP fallback");
    };
    assert_eq!(*reason, Some(FallbackReason::CapabilityVersionMismatch));
    assert_eq!(
        encode_negotiate_response(&response, 1, 1).expect("re-encode"),
        RESP_TCP_FALLBACK.as_bytes()
    );

    // The closed table is pinned to §7.7.3's two literals rather than derived
    // from the enum: a value the enum accepts but the table omits is exactly the
    // fail-open this checks for.
    for (name, expected) in [
        ("unavailable", FallbackReason::Unavailable),
        (
            "capability_version_mismatch",
            FallbackReason::CapabilityVersionMismatch,
        ),
    ] {
        assert_eq!(FallbackReason::parse(name), Some(expected));
        assert_eq!(expected.as_str(), name);
        let body = format!(
            r#"{{"op":"transport.negotiate","negotiation_version":1,"selected":{{"transport":"tcp","capability_version":1}},"reason":"{name}"}}"#
        );
        let NegotiateResponse::Tcp { reason } =
            decode_negotiate_response(body.as_bytes(), &offers).expect("closed reason")
        else {
            panic!("expected TCP");
        };
        assert_eq!(reason, Some(expected));
    }
    // §7.7.3 names these as not fallback evidence: a TCP selection carrying one
    // must fail closed rather than commit the generation to TCP.
    for rejected in [
        "switching_transports",
        "negotiation_version_mismatch",
        "connection_in_use",
        "unsupported_operation",
    ] {
        let body = format!(
            r#"{{"op":"transport.negotiate","negotiation_version":1,"selected":{{"transport":"tcp","capability_version":1}},"reason":"{rejected}"}}"#
        );
        assert_eq!(
            code(decode_negotiate_response(body.as_bytes(), &offers)),
            NegotiationErrorCode::InvalidReason,
            "{rejected} must not be accepted as fallback evidence"
        );
        assert_eq!(FallbackReason::parse(rejected), None);
    }
}

#[test]
fn version_bounds_accept_1_and_u32_max_and_reject_everything_else() {
    fn request_with_version(version: &str) -> String {
        format!(
            r#"{{"op":"transport.negotiate","negotiation_version":{version},"offers":[{{"transport":"tcp","capability_version":{version}}}]}}"#
        )
    }

    for version in ["1", "4294967295"] {
        let request = decode_negotiate_request(request_with_version(version).as_bytes())
            .unwrap_or_else(|err| panic!("version {version} must decode: {err}"));
        assert_eq!(request.negotiation_version.to_string(), version);
        assert_eq!(request.offers[0].capability_version.to_string(), version);
    }

    // Zero, fractions, exponent forms, negatives, and over-u32 values fail.
    for version in [
        "0",
        "1.5",
        "1.0",
        "1e2",
        "-1",
        "4294967296",
        "\"1\"",
        "null",
    ] {
        let err = decode_negotiate_request(request_with_version(version).as_bytes())
            .expect_err("must reject");
        assert!(
            matches!(
                err.code,
                NegotiationErrorCode::InvalidVersion | NegotiationErrorCode::InvalidType
            ),
            "version {version} rejected with unexpected code {:?}",
            err.code
        );
        assert!(
            matches!(err.code, NegotiationErrorCode::InvalidType)
                == matches!(version, "\"1\"" | "null"),
            "non-numbers are invalid_type, numbers out of range are invalid_version: {version}"
        );
    }

    // A well-formed unsupported request version still decodes: the mismatch
    // fallback is host policy, not grammar.
    let v2 = r#"{"op":"transport.negotiate","negotiation_version":2,"offers":[{"transport":"tcp","capability_version":1}]}"#;
    assert_eq!(
        decode_negotiate_request(v2.as_bytes())
            .expect("valid grammar")
            .negotiation_version,
        2
    );
    // A response version other than 1 is rejected by the client decoder.
    let resp_v2 = r#"{"op":"transport.negotiate","negotiation_version":2,"selected":{"transport":"tcp","capability_version":1}}"#;
    assert_eq!(
        code(decode_negotiate_response(
            resp_v2.as_bytes(),
            &[tcp_offer(1)]
        )),
        NegotiationErrorCode::InvalidVersion
    );
}

#[test]
fn transport_name_bounds_are_exact() {
    fn request_with_transport(name: &str) -> String {
        format!(
            r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{{"transport":"{name}","capability_version":1}},{{"transport":"tcp","capability_version":1}}]}}"#
        )
    }

    let max_name = format!("a{}", "b".repeat(MAX_TRANSPORT_NAME_BYTES - 1));
    for name in ["a", max_name.as_str(), "shm", "io.x2_a-b"] {
        let request = decode_negotiate_request(request_with_transport(name).as_bytes())
            .unwrap_or_else(|err| panic!("transport {name:?} must decode: {err}"));
        assert_eq!(request.offers[0].transport, name);
    }

    let too_long = format!("a{}", "b".repeat(MAX_TRANSPORT_NAME_BYTES));
    for name in [
        "",
        "A",
        "shM",
        "café",
        "sh m",
        "sh+m",
        "1shm",
        ".shm",
        "-shm",
        "_shm",
        too_long.as_str(),
    ] {
        assert_eq!(
            code(decode_negotiate_request(
                request_with_transport(name).as_bytes()
            )),
            NegotiationErrorCode::InvalidTransportName,
            "transport {name:?} must be rejected"
        );
    }
}

#[test]
fn duplicate_keys_are_rejected_at_every_depth_before_typed_decoding() {
    // Root object.
    let root = r#"{"op":"transport.negotiate","op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}]}"#;
    // Inside an offer object.
    let offer = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","transport":"tcp","capability_version":1}]}"#;
    // Inside opaque parameters, nested one level down. The offer is otherwise
    // invalid too (bad version), proving the parse-level rejection wins
    // before any typed decoding could classify the version.
    let parameters = r#"{"op":"transport.negotiate","negotiation_version":0,"offers":[{"transport":"tcp","capability_version":1,"parameters":{"nested":{"k":1,"k":2}}}]}"#;
    for body in [root, offer, parameters] {
        assert_eq!(
            code(decode_negotiate_request(body.as_bytes())),
            NegotiationErrorCode::MalformedJson,
            "duplicate keys must fail as malformed JSON before typed decoding"
        );
    }

    // Inside an opaque grant descriptor.
    let descriptor = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"00112233445566778899aabbccddeeff","descriptor":{"a":{"k":1,"k":2}}}"#;
    assert_eq!(
        code(decode_negotiate_response(
            descriptor.as_bytes(),
            &[shm_offer(1), tcp_offer(1)]
        )),
        NegotiationErrorCode::MalformedJson
    );
}

#[test]
fn offer_list_bounds_are_exact() {
    // Duplicate (transport, capability_version) identity.
    let duplicate = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1},{"transport":"tcp","capability_version":1}]}"#;
    assert_eq!(
        code(decode_negotiate_request(duplicate.as_bytes())),
        NegotiationErrorCode::DuplicateOffer
    );
    // The same transport at a different capability version is a distinct
    // identity and stays valid.
    let two_versions = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1},{"transport":"tcp","capability_version":2}]}"#;
    assert_eq!(
        decode_negotiate_request(two_versions.as_bytes())
            .expect("distinct identities")
            .offers
            .len(),
        2
    );

    // Missing required tcp fallback.
    let no_tcp = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"shm","capability_version":1}]}"#;
    assert_eq!(
        code(decode_negotiate_request(no_tcp.as_bytes())),
        NegotiationErrorCode::MissingTcpOffer
    );

    // Exactly 8 offers pass; 9 fail; 0 fail.
    fn offers_body(count: usize) -> String {
        let mut offers: Vec<String> = (1..count)
            .map(|i| format!(r#"{{"transport":"t{i}","capability_version":1}}"#))
            .collect();
        offers.push(r#"{"transport":"tcp","capability_version":1}"#.to_owned());
        format!(
            r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{}]}}"#,
            offers.join(",")
        )
    }
    assert_eq!(
        decode_negotiate_request(offers_body(MAX_OFFERS).as_bytes())
            .expect("eight offers")
            .offers
            .len(),
        MAX_OFFERS
    );
    assert_eq!(
        code(decode_negotiate_request(
            offers_body(MAX_OFFERS + 1).as_bytes()
        )),
        NegotiationErrorCode::InvalidOfferCount
    );
    let empty = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[]}"#;
    assert_eq!(
        code(decode_negotiate_request(empty.as_bytes())),
        NegotiationErrorCode::InvalidOfferCount
    );
}

#[test]
fn opaque_value_bounds_are_exact() {
    fn request_with_parameters(parameters: &str) -> String {
        format!(
            r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{{"transport":"tcp","capability_version":1,"parameters":{parameters}}}]}}"#
        )
    }
    fn nested_objects(depth: usize) -> String {
        let mut value = String::from("{}");
        for _ in 1..depth {
            value = format!(r#"{{"n":{value}}}"#);
        }
        value
    }

    // Depth: 8 levels valid, 9 rejected (protocol §7.1 counting).
    let at_depth = nested_objects(MAX_OPAQUE_DEPTH);
    decode_negotiate_request(request_with_parameters(&at_depth).as_bytes())
        .expect("depth 8 parameters");
    let over_depth = nested_objects(MAX_OPAQUE_DEPTH + 1);
    assert_eq!(
        code(decode_negotiate_request(
            request_with_parameters(&over_depth).as_bytes()
        )),
        NegotiationErrorCode::OpaqueTooDeep
    );
    // A scalar in the deepest container adds no level (§7.1 counting).
    let scalar_leaf = nested_objects(MAX_OPAQUE_DEPTH).replace("{}", r#"{"v":1}"#);
    decode_negotiate_request(request_with_parameters(&scalar_leaf).as_bytes())
        .expect("depth 8 parameters with a scalar leaf");

    // Compact size: a {"p":"<pad>"} object serializes to pad + 8 bytes.
    let at_cap = format!(r#"{{"p":"{}"}}"#, "x".repeat(MAX_OPAQUE_BYTES - 8));
    assert_eq!(at_cap.len(), MAX_OPAQUE_BYTES);
    decode_negotiate_request(request_with_parameters(&at_cap).as_bytes())
        .expect("parameters at the 8 KiB sub-cap");
    let over_cap = format!(r#"{{"p":"{}"}}"#, "x".repeat(MAX_OPAQUE_BYTES - 7));
    assert_eq!(
        code(decode_negotiate_request(
            request_with_parameters(&over_cap).as_bytes()
        )),
        NegotiationErrorCode::OpaqueTooLarge
    );

    // Opaque values must be JSON objects.
    for parameters in ["[]", "1", "\"x\"", "null", "true"] {
        assert_eq!(
            code(decode_negotiate_request(
                request_with_parameters(parameters).as_bytes()
            )),
            NegotiationErrorCode::InvalidType
        );
    }

    // The same bounds govern a grant descriptor.
    fn grant_with_descriptor(descriptor: &str) -> String {
        format!(
            r#"{{"op":"transport.negotiate","negotiation_version":1,"selected":{{"transport":"shm","capability_version":1}},"activation_token":"{VECTOR_TOKEN}","descriptor":{descriptor}}}"#
        )
    }
    let offers = [shm_offer(1), tcp_offer(1)];
    decode_negotiate_response(grant_with_descriptor(&at_depth).as_bytes(), &offers)
        .expect("descriptor at depth 8");
    assert_eq!(
        code(decode_negotiate_response(
            grant_with_descriptor(&over_depth).as_bytes(),
            &offers
        )),
        NegotiationErrorCode::OpaqueTooDeep
    );
    assert_eq!(
        code(decode_negotiate_response(
            grant_with_descriptor(&over_cap).as_bytes(),
            &offers
        )),
        NegotiationErrorCode::OpaqueTooLarge
    );
}

#[test]
fn grant_and_tcp_selection_field_mixes_are_closed() {
    let offers = [shm_offer(1), tcp_offer(1)];

    // A non-TCP grant requires BOTH descriptor and activation_token.
    let no_token = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"descriptor":{}}"#;
    assert_eq!(
        code(decode_negotiate_response(no_token.as_bytes(), &offers)),
        NegotiationErrorCode::MissingField
    );
    let no_descriptor = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"00112233445566778899aabbccddeeff"}"#;
    assert_eq!(
        code(decode_negotiate_response(no_descriptor.as_bytes(), &offers)),
        NegotiationErrorCode::MissingField
    );

    // A TCP selection carrying either grant field is rejected.
    let tcp_with_token = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"activation_token":"00112233445566778899aabbccddeeff"}"#;
    assert_eq!(
        code(decode_negotiate_response(
            tcp_with_token.as_bytes(),
            &offers
        )),
        NegotiationErrorCode::UnexpectedField
    );
    let tcp_with_descriptor = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":1},"descriptor":{}}"#;
    assert_eq!(
        code(decode_negotiate_response(
            tcp_with_descriptor.as_bytes(),
            &offers
        )),
        NegotiationErrorCode::UnexpectedField
    );

    // A grant carrying a fallback reason is rejected.
    let grant_with_reason = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"shm","capability_version":1},"activation_token":"00112233445566778899aabbccddeeff","descriptor":{},"reason":"unavailable"}"#;
    assert_eq!(
        code(decode_negotiate_response(
            grant_with_reason.as_bytes(),
            &offers
        )),
        NegotiationErrorCode::UnexpectedField
    );

    // Field sets are closed: any unknown field is malformed (§7.7.1).
    let unknown_field = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1}],"future":1}"#;
    assert_eq!(
        code(decode_negotiate_request(unknown_field.as_bytes())),
        NegotiationErrorCode::UnexpectedField
    );
    let unknown_offer_field = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1,"extra":1}]}"#;
    assert_eq!(
        code(decode_negotiate_request(unknown_offer_field.as_bytes())),
        NegotiationErrorCode::UnexpectedField
    );
}

#[test]
fn unoffered_selections_are_rejected_by_the_client_decoder() {
    let offers = [shm_offer(1), tcp_offer(1)];
    // Unoffered transport.
    let wrong_transport = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"uds","capability_version":1}}"#;
    assert_eq!(
        code(decode_negotiate_response(
            wrong_transport.as_bytes(),
            &offers
        )),
        NegotiationErrorCode::UnofferedSelection
    );
    // Offered transport at an unoffered capability version.
    let wrong_version = r#"{"op":"transport.negotiate","negotiation_version":1,"selected":{"transport":"tcp","capability_version":2}}"#;
    assert_eq!(
        code(decode_negotiate_response(wrong_version.as_bytes(), &offers)),
        NegotiationErrorCode::UnofferedSelection
    );
}

#[test]
fn activation_and_commit_pin_their_correlations_and_bodies() {
    assert_eq!(ACTIVATION_CORRELATION, 1);
    assert_eq!(COMMIT_CORRELATION, 2);
    assert_eq!(FIRST_APPLICATION_CORRELATION, 3);

    let activate = decode_activate_request(ACTIVATE_REQ.as_bytes()).expect("pinned activate");
    assert_eq!(activate.activation_token.as_str(), VECTOR_TOKEN);
    assert_eq!(
        encode_activate_request(&activate.activation_token),
        ACTIVATE_REQ.as_bytes()
    );

    decode_activate_response(ACTIVATE_RESP.as_bytes()).expect("pinned activate response");
    assert_eq!(activate_response_json(), ACTIVATE_RESP.as_bytes());
    decode_commit_request(COMMIT_REQ.as_bytes()).expect("pinned commit request");
    assert_eq!(commit_request_json(), COMMIT_REQ.as_bytes());
    decode_commit_response(COMMIT_RESP.as_bytes()).expect("pinned commit response");
    assert_eq!(commit_response_json(), COMMIT_RESP.as_bytes());

    // Tagged responses carry no provider data: any extra field is malformed.
    let padded_response = r#"{"op":"transport.activate","negotiation_version":1,"descriptor":{}}"#;
    assert_eq!(
        code(decode_activate_response(padded_response.as_bytes())),
        NegotiationErrorCode::UnexpectedField
    );
    let padded_commit = r#"{"op":"transport.commit","negotiation_version":1,"note":"x"}"#;
    assert_eq!(
        code(decode_commit_response(padded_commit.as_bytes())),
        NegotiationErrorCode::UnexpectedField
    );

    // The token form is exact: 32 lowercase hex characters.
    assert!(ActivationToken::parse(VECTOR_TOKEN).is_some());
    for bad in [
        "00112233445566778899aabbccddeef",   // 31
        "00112233445566778899aabbccddeeff0", // 33
        "00112233445566778899AABBCCDDEEFF",  // uppercase
        "00112233445566778899aabbccddeegg",  // non-hex
        "",
    ] {
        assert!(
            ActivationToken::parse(bad).is_none(),
            "token {bad:?} must be rejected"
        );
        let body = format!(
            r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{bad}"}}"#
        );
        assert_eq!(
            code(decode_activate_request(body.as_bytes())),
            NegotiationErrorCode::InvalidActivationToken
        );
    }

    // Wrong operation tags and versions are rejected on the candidate path.
    assert_eq!(
        code(decode_activate_request(COMMIT_REQ.as_bytes())),
        NegotiationErrorCode::WrongOperation
    );
    let v2_commit = r#"{"op":"transport.commit","negotiation_version":2}"#;
    assert_eq!(
        code(decode_commit_request(v2_commit.as_bytes())),
        NegotiationErrorCode::InvalidVersion
    );
}

#[test]
fn parse_failures_expose_bounded_codes_and_paths_without_provider_bytes() {
    const SENTINEL: &str = "SENTINEL-PROVIDER-SECRET";

    // A failing body whose opaque value carries a sentinel: too deep.
    let too_deep = format!(
        r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{{"transport":"tcp","capability_version":1,"parameters":{{"a":{{"b":{{"c":{{"d":{{"e":{{"f":{{"g":{{"h":{{"i":"{SENTINEL}"}}}}}}}}}}}}}}}}}}}}]}}"#
    );
    let err = decode_negotiate_request(too_deep.as_bytes()).expect_err("must reject");
    assert_eq!(err.code, NegotiationErrorCode::OpaqueTooDeep);
    assert_eq!(err.path, "offers[0].parameters");
    for rendered in [format!("{err}"), format!("{err:?}")] {
        assert!(
            !rendered.contains(SENTINEL),
            "errors must never retain provider bytes: {rendered}"
        );
    }

    // A hostile unknown key is not echoed into the error path.
    let hostile_key = format!(
        r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{{"transport":"tcp","capability_version":1}}],"{SENTINEL}":1}}"#
    );
    let err = decode_negotiate_request(hostile_key.as_bytes()).expect_err("must reject");
    assert_eq!(err.code, NegotiationErrorCode::UnexpectedField);
    assert!(!format!("{err} {err:?}").contains(SENTINEL));

    // Successful decodes redact opaque values and tokens in Debug output.
    let request_body = format!(
        r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{{"transport":"tcp","capability_version":1,"parameters":{{"secret":"{SENTINEL}"}}}}]}}"#
    );
    let request = decode_negotiate_request(request_body.as_bytes()).expect("valid request");
    assert!(!format!("{request:?}").contains(SENTINEL));

    let grant_body = format!(
        r#"{{"op":"transport.negotiate","negotiation_version":1,"selected":{{"transport":"shm","capability_version":1}},"activation_token":"{VECTOR_TOKEN}","descriptor":{{"secret":"{SENTINEL}"}}}}"#
    );
    let grant = decode_negotiate_response(grant_body.as_bytes(), &[shm_offer(1), tcp_offer(1)])
        .expect("valid grant");
    let rendered = format!("{grant:?}");
    assert!(!rendered.contains(SENTINEL), "descriptor must be redacted");
    assert!(
        !rendered.contains(VECTOR_TOKEN),
        "the activation token must be redacted"
    );
}

#[test]
fn encoders_refuse_out_of_contract_values() {
    // Missing tcp fallback.
    let no_tcp = NegotiateRequest {
        negotiation_version: NEGOTIATION_VERSION,
        offers: vec![shm_offer(1)],
    };
    assert_eq!(
        code(encode_negotiate_request(&no_tcp)),
        NegotiationErrorCode::MissingTcpOffer
    );
    // Too many offers.
    let mut offers: Vec<TransportOffer> = (0..MAX_OFFERS)
        .map(|i| TransportOffer {
            transport: format!("t{i}"),
            capability_version: 1,
            parameters: None,
        })
        .collect();
    offers.push(tcp_offer(1));
    assert_eq!(
        code(encode_negotiate_request(&NegotiateRequest {
            negotiation_version: NEGOTIATION_VERSION,
            offers,
        })),
        NegotiationErrorCode::InvalidOfferCount
    );
    // Invalid transport name.
    assert_eq!(
        code(encode_negotiate_request(&NegotiateRequest {
            negotiation_version: NEGOTIATION_VERSION,
            offers: vec![
                TransportOffer {
                    transport: "SHM".to_owned(),
                    capability_version: 1,
                    parameters: None,
                },
                tcp_offer(1),
            ],
        })),
        NegotiationErrorCode::InvalidTransportName
    );
    // A grant may never name tcp.
    let token = ActivationToken::parse(VECTOR_TOKEN).expect("vector token");
    assert_eq!(
        code(encode_negotiate_response(
            &NegotiateResponse::Grant {
                selected: SelectedTransport {
                    transport: TRANSPORT_TCP.to_owned(),
                    capability_version: 1,
                },
                activation_token: token,
                descriptor: serde_json::json!({}),
            },
            1,
            1,
        )),
        NegotiationErrorCode::InvalidTransportName
    );
}

// ---------------------------------------------------------------------------
// U4: host selection, legacy omission, and injected candidate activation.
// ---------------------------------------------------------------------------

const HOST_BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/project";
const COMMIT_BODY: &[u8] = br#"{"op":"transport.commit","negotiation_version":1}"#;

fn negotiate_body(offers: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"op": "transport.negotiate", "negotiation_version": 1, "offers": offers})
}

fn tcp_only_offers() -> serde_json::Value {
    serde_json::json!([{"transport": "tcp", "capability_version": 1}])
}

fn fake_and_tcp_offers() -> serde_json::Value {
    serde_json::json!([
        {"transport": FAKE_TRANSPORT, "capability_version": 1},
        {"transport": "tcp", "capability_version": 1}
    ])
}

fn activate_body(token: &str) -> Vec<u8> {
    format!(r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{token}"}}"#)
        .into_bytes()
}

/// Sends one control request and returns its terminal, skipping host Pings.
async fn control_response(
    client: &mut raw_client::RawClient,
    body: &serde_json::Value,
) -> RawFrame {
    let corr = client.control(body).await.expect("send control");
    let (skipped, frame) = client
        .frames_until_corr(corr, HOST_BUDGET)
        .await
        .expect("one terminal");
    assert!(
        skipped.iter().all(|frame| frame.ty == TY_PING),
        "only Pings may precede the terminal: {skipped:?}"
    );
    frame
}

/// Negotiates a fake-provider grant and returns the bootstrap client, the
/// candidate's raw peer driver, and the granted activation token.
async fn grant_over(
    host: &TestHost,
    peers: &mut tokio::sync::mpsc::UnboundedReceiver<tokio::io::DuplexStream>,
) -> (raw_client::RawClient, RawCandidate, String) {
    let mut client = host.setup_client().await;
    let frame = control_response(&mut client, &negotiate_body(fake_and_tcp_offers())).await;
    assert_eq!(frame.ty, TY_RESPONSE, "grant expected: {frame:?}");
    let json = frame.json();
    assert_eq!(json["op"], "transport.negotiate");
    assert_eq!(json["selected"]["transport"], FAKE_TRANSPORT);
    assert_eq!(json["selected"]["capability_version"], 1);
    let token = json["activation_token"].as_str().expect("token").to_owned();
    assert_eq!(token.len(), 32);
    assert!(token
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let peer = tokio::time::timeout(HOST_BUDGET, peers.recv())
        .await
        .expect("candidate prepared within budget")
        .expect("candidate peer");
    (client, RawCandidate::new(peer), token)
}

async fn activate_ok(candidate: &mut RawCandidate, token: &str) {
    candidate
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            0,
            0,
            1,
            &activate_body(token),
        )
        .await
        .expect("send activate");
    let response = candidate
        .frame_within(HOST_BUDGET)
        .await
        .expect("activation response");
    assert_eq!((response.ty, response.corr), (TY_RESPONSE, 1));
    assert_eq!(response.json()["op"], "transport.activate");
}

async fn commit_ok(candidate: &mut RawCandidate) {
    candidate
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, 2, COMMIT_BODY)
        .await
        .expect("send commit");
    let response = candidate
        .frame_within(HOST_BUDGET)
        .await
        .expect("commit response");
    assert_eq!((response.ty, response.corr), (TY_RESPONSE, 2));
    assert_eq!(response.json()["op"], "transport.commit");
}

#[tokio::test]
async fn tcp_only_selection_is_exact_and_the_generation_serves_requests() {
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;

    let frame = control_response(&mut client, &negotiate_body(tcp_only_offers())).await;
    assert_eq!(frame.ty, TY_RESPONSE);
    let json = frame.json();
    assert_eq!(json["op"], "transport.negotiate");
    assert_eq!(json["negotiation_version"], 1);
    assert_eq!(json["selected"]["transport"], "tcp");
    assert_eq!(json["selected"]["capability_version"], 1);
    assert!(
        json.get("reason").is_none(),
        "a direct selection has no reason"
    );
    assert!(json.get("activation_token").is_none());
    assert!(json.get("descriptor").is_none());

    let (channel, epoch) = client
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "negotiated")
        .await
        .expect("route after negotiation");
    let corr = client.next_corr();
    let body = support::echo_body("after-negotiation");
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, corr, &body)
        .await
        .expect("send echo");
    let frame = client
        .frame_within(HOST_BUDGET)
        .await
        .expect("echo terminal");
    assert_eq!((frame.ty, frame.corr), (TY_RESPONSE, corr));
    assert_eq!(frame.body, body);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn unprovided_non_tcp_offer_selects_reasonless_tcp() {
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;

    let offers = serde_json::json!([
        {"transport": "shm", "capability_version": 1, "parameters": {}},
        {"transport": "tcp", "capability_version": 1}
    ]);
    let frame = control_response(&mut client, &negotiate_body(offers)).await;
    assert_eq!(frame.ty, TY_RESPONSE);
    let json = frame.json();
    assert_eq!(json["selected"]["transport"], "tcp");
    assert_eq!(json["selected"]["capability_version"], 1);
    assert!(
        json.get("reason").is_none(),
        "permanent absence is a static omission, not `unavailable` (KTD6)"
    );

    let frame = control_response(&mut client, &serde_json::json!({"op": "catalog.list"})).await;
    assert_eq!(frame.ty, TY_RESPONSE, "the generation stays usable");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn negotiation_version_mismatch_retires_but_capability_mismatch_falls_back() {
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;
    client
        .control(&serde_json::json!({
            "op": "transport.negotiate",
            "negotiation_version": 2,
            "offers": [{"transport": "tcp", "capability_version": 1}]
        }))
        .await
        .expect("send mismatched negotiation");
    assert!(client.closed_within(HOST_BUDGET).await);
    host.shutdown_gracefully().await;

    // The fake transport is installed at capability 2 but offered at 1.
    let (provider, _peers) = FakeProvider::install(2, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;
    let mut client = host.setup_client().await;
    let frame = control_response(&mut client, &negotiate_body(fake_and_tcp_offers())).await;
    assert_eq!(frame.ty, TY_RESPONSE);
    let json = frame.json();
    assert_eq!(json["selected"]["transport"], "tcp");
    assert_eq!(json["reason"], "capability_version_mismatch");
    assert_eq!(provider.prepared_count(), 0);
    let frame = control_response(&mut client, &serde_json::json!({"op": "catalog.list"})).await;
    assert_eq!(frame.ty, TY_RESPONSE, "the generation stays usable");
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn application_before_negotiation_retires_without_side_effects() {
    for body in [
        serde_json::json!({"op": "catalog.list"}),
        serde_json::json!({"op": "host.shutdown"}),
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
            "identity": {"project_root": ROOT, "harness": "opencode", "session": "setup"}
        }),
        serde_json::json!({"op": "unknown.operation"}),
    ] {
        let host = TestHost::start().await;
        let mut client = host.setup_client().await;
        client.control(&body).await.expect("send setup violation");
        assert!(client.closed_within(HOST_BUDGET).await);
        assert!(host.handler.binds().is_empty());

        let mut negotiated = host.client().await;
        let frame =
            control_response(&mut negotiated, &serde_json::json!({"op": "catalog.list"})).await;
        assert_eq!(frame.ty, TY_RESPONSE);
        host.shutdown_gracefully().await;
    }

    let host = TestHost::start().await;
    let mut client = host.setup_client().await;
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 1, 1, 1, b"{}")
        .await
        .expect("send routed setup violation");
    assert!(client.closed_within(HOST_BUDGET).await);
    assert!(host.handler.binds().is_empty());
    host.shutdown_gracefully().await;

    let host = TestHost::start().await;
    let mut client = host.setup_client().await;
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, 1, &vec![b' '; 65_537])
        .await
        .expect("send oversized setup violation");
    assert!(client.closed_within(HOST_BUDGET).await);
    assert!(host.handler.binds().is_empty());
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn normal_raw_client_returns_after_tcp_negotiation() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let frame = control_response(&mut client, &serde_json::json!({"op": "catalog.list"})).await;
    assert_eq!(frame.ty, TY_RESPONSE);
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn repeated_negotiation_after_negotiated_tcp_selection_retires() {
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;

    let frame = control_response(&mut client, &negotiate_body(tcp_only_offers())).await;
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.json()["selected"]["transport"], "tcp");

    let _ = client
        .control(&negotiate_body(tcp_only_offers()))
        .await
        .expect("send repeated negotiation");
    assert!(
        client.closed_within(HOST_BUDGET).await,
        "negotiation after a negotiated TCP selection is a protocol failure"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn stalled_provider_prepare_fails_setup_within_the_deadline() {
    // A provider whose KTD9 attachment gate blocks must not pin the
    // connection past the configured setup budget: the deadline exists
    // before any provider code runs and `prepare` executes off the
    // connection task.
    struct StallingProvider;
    impl InjectedProvider for StallingProvider {
        fn transport(&self) -> &str {
            FAKE_TRANSPORT
        }
        fn capability_version(&self) -> u32 {
            1
        }
        fn prepare(&self, _ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure> {
            std::thread::sleep(Duration::from_millis(800));
            Err(ProviderFailure::Unavailable)
        }
    }
    let registry = TransportProviders::with_injected(vec![Arc::new(StallingProvider)]);
    let host = TestHost::start_with(move |config| {
        config.transport_providers = registry;
        config.timing.transport_setup_deadline = Duration::from_millis(100);
    })
    .await;
    let mut client = host.setup_client().await;
    let _ = client
        .control(&negotiate_body(fake_and_tcp_offers()))
        .await
        .expect("send negotiation");
    assert!(
        // Shorter than the provider's 800 ms stall: only the 100 ms setup
        // deadline can close the connection this early, so the assertion
        // discriminates the deadline from the provider's own late error.
        client.closed_within(Duration::from_millis(400)).await,
        "a stalled provider gate fails the setup closed within the deadline"
    );
    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn duplicate_key_negotiation_settles_with_its_terminal_and_retires() {
    // Strict-parse failures (duplicate keys at any depth) inside a
    // negotiation-family body take the authoritative-terminal-and-close
    // path, never the generic rejection that would commit TCP and leave the
    // generation usable (§7.7.1).
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;

    let dup = r#"{"op":"transport.negotiate","negotiation_version":1,"offers":[{"transport":"tcp","capability_version":1,"parameters":{"a":1,"a":2}}]}"#;
    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, corr, dup.as_bytes())
        .await
        .expect("send duplicate-key negotiation");
    let frame = client.frame_within(HOST_BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "invalid_control_request");
    assert!(
        client.closed_within(HOST_BUDGET).await,
        "malformed negotiation retires the generation after its terminal"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn malformed_negotiation_settles_with_its_terminal_and_never_reaches_dispatch() {
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;

    let missing_tcp = serde_json::json!({
        "op": "transport.negotiate",
        "negotiation_version": 1,
        "offers": [{"transport": "shm", "capability_version": 1}]
    });
    let corr = client.control(&missing_tcp).await.expect("send");
    let frame = client.frame_within(HOST_BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "invalid_control_request");
    assert!(
        client.closed_within(HOST_BUDGET).await,
        "malformed negotiation retires the generation after its terminal"
    );
    assert_eq!(host.handler.dispatch_count(), 0);
    assert!(host.handler.binds().is_empty());

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn injected_grant_activates_commits_and_serves_application_traffic() {
    let (provider, mut peers) =
        FakeProvider::install(1, serde_json::json!({"kind": "fake"}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;

    let mut client = host.setup_client().await;
    let frame = control_response(&mut client, &negotiate_body(fake_and_tcp_offers())).await;
    let json = frame.json();
    assert_eq!(json["descriptor"], serde_json::json!({"kind": "fake"}));
    let token = json["activation_token"].as_str().expect("token").to_owned();
    let peer = peers.recv().await.expect("candidate peer");
    let mut candidate = RawCandidate::new(peer);

    activate_ok(&mut candidate, &token).await;
    commit_ok(&mut candidate).await;

    assert!(
        client.closed_within(HOST_BUDGET).await,
        "promotion retires the bootstrap"
    );

    // The first application request uses correlation 3 (§7.7.4).
    let route_open = serde_json::json!({
        "op": "route.open",
        "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
        "identity": {"project_root": ROOT, "harness": "opencode", "session": "candidate"}
    });
    candidate
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            0,
            0,
            3,
            &serde_json::to_vec(&route_open).expect("body"),
        )
        .await
        .expect("send route.open");
    let response = candidate
        .frame_within(HOST_BUDGET)
        .await
        .expect("route response");
    assert_eq!((response.ty, response.corr), (TY_RESPONSE, 3));
    let json = response.json();
    assert_eq!(json["op"], "route.open");
    let channel = u16::try_from(json["route_channel"].as_u64().expect("channel")).expect("u16");
    let epoch = u32::try_from(json["route_epoch"].as_u64().expect("epoch")).expect("u32");

    let body = support::echo_body("on-candidate");
    candidate
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, channel, epoch, 4, &body)
        .await
        .expect("send echo");
    let response = candidate.frame_within(HOST_BUDGET).await.expect("echo");
    assert_eq!((response.ty, response.corr), (TY_RESPONSE, 4));
    assert_eq!(response.body, body);

    candidate
        .send_frame(TY_GOODBYE, FLAGS_PURE_HEADER, 0, 0, 0, &[])
        .await
        .expect("send goodbye");
    assert!(candidate.closed_within(HOST_BUDGET).await);

    host.shutdown_gracefully().await;
}

#[test]
fn grant_record_rejects_wrong_tokens_and_every_mismatched_binding_field() {
    let token = ActivationToken::parse(VECTOR_TOKEN).expect("vector token");
    let binding = GrantBinding {
        daemon_id: [3; 16],
        bootstrap_generation: 7,
        negotiation_correlation: 1,
        transport: FAKE_TRANSPORT.to_owned(),
        capability_version: 1,
        candidate_id: 9,
    };
    let record = GrantRecord::new(binding.clone(), token.clone());

    let wrong_token = ActivationToken::parse("ffeeddccbbaa99887766554433221100").expect("token");
    assert_eq!(
        record.consume(&wrong_token, &binding),
        Err(GrantRejection::TokenMismatch)
    );

    type Mutation = fn(&mut GrantBinding);
    let mutations: [Mutation; 6] = [
        |b| b.daemon_id = [4; 16],
        |b| b.bootstrap_generation += 1,
        |b| b.negotiation_correlation += 1,
        |b| b.transport = "other".to_owned(),
        |b| b.capability_version += 1,
        |b| b.candidate_id += 1,
    ];
    for mutate in mutations {
        let mut wrong = binding.clone();
        mutate(&mut wrong);
        assert_eq!(
            record.consume(&token, &wrong),
            Err(GrantRejection::BindingMismatch)
        );
    }

    // None of the rejections consumed the record; concurrent duplicate
    // activations consume it exactly once.
    let record = Arc::new(record);
    let attempts: Vec<std::thread::JoinHandle<bool>> = (0..8)
        .map(|_| {
            let record = Arc::clone(&record);
            let token = token.clone();
            let binding = binding.clone();
            std::thread::spawn(move || record.consume(&token, &binding).is_ok())
        })
        .collect();
    let successes = attempts
        .into_iter()
        .map(|handle| handle.join().expect("thread"))
        .filter(|ok| *ok)
        .count();
    assert_eq!(
        successes, 1,
        "exactly one concurrent activation may consume"
    );
}

#[tokio::test]
async fn ktd9_attachment_failures_fail_closed_before_any_candidate_exists() {
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;

    for failure in [
        ProviderFailure::OwnerAccessDenied,
        ProviderFailure::ExclusiveAttachmentViolated,
        ProviderFailure::StaleIncarnation,
        ProviderFailure::StaleDescriptor,
    ] {
        provider.fail_next(failure);
        let mut client = host.setup_client().await;
        let _ = client
            .control(&negotiate_body(fake_and_tcp_offers()))
            .await
            .expect("send negotiation");
        let frames = client.drain_until_close(HOST_BUDGET).await;
        assert!(
            frames.is_empty(),
            "an attachment failure must fail closed with no selection: {frames:?}"
        );
    }
    assert_eq!(provider.prepared_count(), 0);
    assert!(peers.try_recv().is_err(), "no candidate may be yielded");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn queue_admission_alone_does_not_promote_until_local_completion() {
    // A 16-byte transport buffer: the commit response cannot finish writing
    // until this test reads it, separating admission from local completion.
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 16);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;

    let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
    activate_ok(&mut candidate, &token).await;

    candidate
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, 2, COMMIT_BODY)
        .await
        .expect("send commit");
    // The response is admitted and partially written, but its local
    // completion is stalled on this unread stream: no promotion yet.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !client.closed_within(Duration::from_millis(200)).await,
        "the bootstrap must stay live until the commit response completes locally"
    );

    let response = candidate
        .frame_within(HOST_BUDGET)
        .await
        .expect("commit response");
    assert_eq!((response.ty, response.corr), (TY_RESPONSE, 2));
    assert!(
        client.closed_within(HOST_BUDGET).await,
        "local completion of the exact commit response promotes"
    );

    drop(candidate);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn application_frame_before_promotion_fails_setup_instead_of_dispatching() {
    // The same 16-byte transport buffer stall as the admission test above:
    // the commit response is admitted but short of local completion.
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 16);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| {
        config.transport_providers = registry;
        config.timing.transport_setup_deadline = Duration::from_millis(500);
    })
    .await;

    let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
    activate_ok(&mut candidate, &token).await;
    candidate
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, 2, COMMIT_BODY)
        .await
        .expect("send commit");
    tokio::time::sleep(Duration::from_millis(100)).await;

    // An application Request at correlation 3 while promotion is still
    // pending: an un-promoted host never consumes it, so this bounded write
    // can only finish by failing once setup closes; a mutant that promoted
    // at queue admission consumes and answers it instead.
    let premature = tokio::time::timeout(
        Duration::from_secs(2),
        candidate.send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            0,
            0,
            3,
            br#"{"op":"catalog.list"}"#,
        ),
    )
    .await;
    assert!(
        !matches!(premature, Ok(Ok(()))),
        "the host consumed an application frame before promotion"
    );

    let outcome = candidate.frame_within(HOST_BUDGET).await;
    assert!(
        outcome.is_err(),
        "no frame may complete after a premature application frame: {outcome:?}"
    );
    assert!(
        client.closed_within(HOST_BUDGET).await,
        "the bootstrap must close with the failed setup"
    );

    drop(candidate);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn liveness_hands_off_from_bootstrap_to_candidate_around_the_grant() {
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| {
        config.transport_providers = registry;
        config.timing.transport_setup_deadline = Duration::from_secs(5);
        config.liveness = Some(mc_host::LivenessPolicy {
            ping_interval: Duration::from_millis(100),
            pong_deadline: Duration::from_secs(2),
            invalidate_on_missed: false,
        });
    })
    .await;
    let mut client = host.setup_client().await;

    // Bootstrap liveness runs before negotiation.
    let ping = client
        .frame_within(HOST_BUDGET)
        .await
        .expect("bootstrap ping");
    assert_eq!(ping.ty, TY_PING);
    client
        .send_frame(TY_PONG, ping.flags, 0, 0, ping.corr, &[])
        .await
        .expect("answer ping");

    let frame = control_response(&mut client, &negotiate_body(fake_and_tcp_offers())).await;
    let token = frame.json()["activation_token"]
        .as_str()
        .expect("token")
        .to_owned();
    let peer = peers.recv().await.expect("candidate peer");
    let mut candidate = RawCandidate::new(peer);

    // Bootstrap liveness was stopped and joined before the grant: several
    // ping intervals pass with no bootstrap frame.
    assert!(
        client
            .frame_within(Duration::from_millis(350))
            .await
            .is_err(),
        "no bootstrap Ping may follow the grant"
    );

    activate_ok(&mut candidate, &token).await;
    // No candidate Ping before commit.
    assert!(
        candidate.quiet_for(Duration::from_millis(350)).await,
        "no candidate Ping may start before commit"
    );
    commit_ok(&mut candidate).await;
    assert!(client.closed_within(HOST_BUDGET).await);

    // Candidate liveness starts after promotion.
    let ping = candidate
        .frame_within(HOST_BUDGET)
        .await
        .expect("candidate ping");
    assert_eq!(ping.ty, TY_PING);
    candidate
        .send_frame(TY_PONG, ping.flags, 0, 0, ping.corr, &[])
        .await
        .expect("answer candidate ping");

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn activation_failures_retire_candidate_and_bootstrap_without_tcp_continuation() {
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;

    // Wrong token (valid form, wrong value): rejected with no response.
    {
        let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
        let wrong: String = token
            .chars()
            .map(|c| if c == '0' { '1' } else { '0' })
            .collect();
        candidate
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                0,
                0,
                1,
                &activate_body(&wrong),
            )
            .await
            .expect("send wrong token");
        assert!(candidate.closed_within(HOST_BUDGET).await);
        assert!(client.closed_within(HOST_BUDGET).await);
    }

    // Wrong setup correlation.
    {
        let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
        candidate
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                0,
                0,
                5,
                &activate_body(&token),
            )
            .await
            .expect("send at wrong correlation");
        assert!(candidate.closed_within(HOST_BUDGET).await);
        assert!(client.closed_within(HOST_BUDGET).await);
    }

    // Nonzero epoch: candidate control identity is exactly 0/0/corr (§7.7.4).
    {
        let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
        candidate
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                0,
                7,
                1,
                &activate_body(&token),
            )
            .await
            .expect("send with nonzero epoch");
        assert!(candidate.closed_within(HOST_BUDGET).await);
        assert!(client.closed_within(HOST_BUDGET).await);
    }

    // Duplicate activation where the commit belongs.
    {
        let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
        activate_ok(&mut candidate, &token).await;
        candidate
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                0,
                0,
                2,
                &activate_body(&token),
            )
            .await
            .expect("send duplicate activation");
        assert!(candidate.closed_within(HOST_BUDGET).await);
        assert!(client.closed_within(HOST_BUDGET).await);
    }

    // An application frame before commit.
    {
        let (mut client, mut candidate, token) = grant_over(&host, &mut peers).await;
        activate_ok(&mut candidate, &token).await;
        candidate
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                7,
                1,
                2,
                &support::echo_body("early"),
            )
            .await
            .expect("send early application frame");
        assert!(candidate.closed_within(HOST_BUDGET).await);
        assert!(client.closed_within(HOST_BUDGET).await);
    }

    // Candidate channel loss.
    {
        let (mut client, candidate, _token) = grant_over(&host, &mut peers).await;
        drop(candidate);
        assert!(client.closed_within(HOST_BUDGET).await);
    }

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn activation_timeout_retires_candidate_and_bootstrap() {
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| {
        config.transport_providers = registry;
        config.timing.transport_setup_deadline = Duration::from_millis(250);
    })
    .await;

    let (mut client, mut candidate, _token) = grant_over(&host, &mut peers).await;
    // Send nothing: the immutable setup deadline expires.
    assert!(candidate.closed_within(HOST_BUDGET).await);
    assert!(client.closed_within(HOST_BUDGET).await);

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn max_connections_bounds_prepared_candidates_and_failure_releases_them() {
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| {
        config.transport_providers = registry;
        config.limits.max_connections = 1;
    })
    .await;

    let (mut client, candidate, _token) = grant_over(&host, &mut peers).await;

    // The setup retains the sole connection permit: a second authenticated
    // connection is refused while the candidate is prepared.
    let mut second = raw_client::RawClient::connect_setup_only(&host.info)
        .await
        .expect("handshake completes");
    assert!(
        second.closed_within(HOST_BUDGET).await,
        "no permit while a candidate is prepared"
    );

    // Failing the candidate releases the permit for a fresh connection.
    drop(candidate);
    assert!(client.closed_within(HOST_BUDGET).await);
    let deadline = tokio::time::Instant::now() + HOST_BUDGET;
    loop {
        let mut third = raw_client::RawClient::connect(&host.info)
            .await
            .expect("handshake completes");
        if let Ok(corr) = third
            .control(&serde_json::json!({"op": "catalog.list"}))
            .await
        {
            if let Ok(frame) = third.frame_within(Duration::from_secs(1)).await {
                assert_eq!(frame.corr, corr);
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the connection permit was not released"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn a_second_candidate_on_one_setup_is_rejected() {
    let (provider, mut peers) = FakeProvider::install(1, serde_json::json!({}), 64 * 1024);
    let registry = FakeProvider::registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;

    let (mut client, mut candidate, _token) = grant_over(&host, &mut peers).await;
    let _ = client
        .control(&negotiate_body(fake_and_tcp_offers()))
        .await
        .expect("send second negotiation");
    assert!(client.closed_within(HOST_BUDGET).await);
    assert!(candidate.closed_within(HOST_BUDGET).await);
    assert_eq!(
        provider.prepared_count(),
        1,
        "no second candidate is prepared"
    );

    host.shutdown_gracefully().await;
}

#[tokio::test]
async fn sentinel_provider_data_stays_off_diagnostic_surfaces() {
    const SENTINEL: &str = "SENTINEL-PROVIDER-SECRET";
    let host = TestHost::start().await;

    // A malformed negotiation whose unknown field name carries the sentinel
    // gets the bounded terminal with no sentinel bytes echoed.
    let mut client = host.setup_client().await;
    let body = format!(
        r#"{{"op":"transport.negotiate","negotiation_version":1,"offers":[{{"transport":"tcp","capability_version":1}}],"{SENTINEL}":1}}"#
    );
    let corr = client.next_corr();
    client
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, corr, body.as_bytes())
        .await
        .expect("send hostile body");
    let frame = client.frame_within(HOST_BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "invalid_control_request");
    assert!(!String::from_utf8_lossy(&frame.body).contains(SENTINEL));
    assert!(client.closed_within(HOST_BUDGET).await);

    // Offer parameters carrying the sentinel never reach the fallback
    // response.
    let mut client = host.setup_client().await;
    let offers = serde_json::json!([
        {"transport": "shm", "capability_version": 1, "parameters": {"secret": SENTINEL}},
        {"transport": "tcp", "capability_version": 1}
    ]);
    let frame = control_response(&mut client, &negotiate_body(offers)).await;
    assert!(
        frame.json().get("reason").is_none(),
        "an absent provider selects reasonless TCP"
    );
    assert!(!String::from_utf8_lossy(&frame.body).contains(SENTINEL));

    // Grant records and provider failures format without token or provider
    // bytes.
    let record = GrantRecord::new(
        GrantBinding {
            daemon_id: [0; 16],
            bootstrap_generation: 1,
            negotiation_correlation: 1,
            transport: FAKE_TRANSPORT.to_owned(),
            capability_version: 1,
            candidate_id: 1,
        },
        ActivationToken::parse(VECTOR_TOKEN).expect("vector token"),
    );
    let rendered = format!("{record:?}");
    assert!(!rendered.contains(VECTOR_TOKEN), "token must be redacted");
    let registry = TransportProviders::default();
    assert!(!format!("{registry:?}").contains(SENTINEL));
    for failure in [
        ProviderFailure::OwnerAccessDenied,
        ProviderFailure::ExclusiveAttachmentViolated,
        ProviderFailure::StaleIncarnation,
        ProviderFailure::StaleDescriptor,
        ProviderFailure::Unavailable,
    ] {
        assert!(!format!("{failure:?}").contains(SENTINEL));
    }

    host.shutdown_gracefully().await;
}
