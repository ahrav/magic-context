//! Bounded channel-0 control handling: strict JSON validation, operation
//! classification, `catalog.list`, and `route.open` request parsing.
//!
//! Every byte limit here is enforced before handler callbacks, route
//! reservation, or filesystem work (protocol §7.1). Metadata never grants
//! authority; the bearer key already did.

use std::path::PathBuf;

use crate::handler::{ManifestSnapshot, RouteIdentity};

pub const CODE_INVALID_CONTROL_REQUEST: &str = "invalid_control_request";
pub const CODE_UNSUPPORTED_OPERATION: &str = "unsupported_operation";
pub const CODE_UNKNOWN_MODULE: &str = "unknown_module";
pub const CODE_TARGET_UNAVAILABLE: &str = "target_unavailable";
pub const CODE_UNKNOWN_CHANNEL: &str = "unknown_channel";
pub const CODE_SERVER_BUSY: &str = "server_busy";
pub const CODE_CANCELLED: &str = "cancelled";
pub const CODE_INTERNAL_ERROR: &str = "internal_error";

pub const OP_ROUTE_OPEN: &str = subc_control::ops::ROUTE_OPEN;
pub const OP_CATALOG_LIST: &str = subc_control::ops::CATALOG_LIST;

/// The only routable target kind in the direct profile. `route.open` succeeds
/// only for a role the linked manifest actually advertises, so startup
/// rejects a manifest without it rather than publishing a catalog that
/// contradicts route admission (protocol §7.2).
pub const TARGET_KIND_TOOL_PROVIDER: &str = "tool_provider";

const MAX_OP_LEN: usize = 64;
const MAX_MODULE_ID_LEN: usize = 128;
const MAX_PROJECT_ROOT_LEN: usize = 4096;
const MAX_HARNESS_LEN: usize = 128;
const MAX_SESSION_LEN: usize = 256;
const MAX_LAUNCH_NONCE_LEN: usize = 256;
const MAX_CAPABILITY_LEN: usize = 64;
const MAX_CAPABILITIES: usize = 32;
const MAX_ADMISSION_FACTS_BYTES: usize = 8192;
const MAX_ADMISSION_FACTS_DEPTH: usize = 32;
/// Whole-request nesting bound: the root object plus a maximal
/// `admission_facts` subtree. Unknown fields count toward nesting limits
/// (protocol §7.1), so the bound applies to the complete control object
/// before dispatching on `op`.
const MAX_CONTROL_DEPTH: usize = MAX_ADMISSION_FACTS_DEPTH + 1;

/// Catalog-state generation. Static until catalog content can change at
/// runtime, which the direct-linked profile has no mechanism for.
pub const CATALOG_GENERATION: u64 = 1;

/// What a validated channel-0 request asks the host to do.
#[derive(Debug, PartialEq)]
pub enum ControlAction {
    CatalogList {
        module_id_filter: Option<String>,
    },
    RouteOpen {
        identity: RouteIdentity,
    },
    /// Semantic rejection with a trustworthy correlation; one terminal.
    Reject {
        code: &'static str,
        message: String,
    },
}

fn invalid(message: &str) -> ControlAction {
    ControlAction::Reject {
        code: CODE_INVALID_CONTROL_REQUEST,
        message: message.to_owned(),
    }
}

/// Validates and classifies one complete channel-0 `Request` body.
///
/// `binary` is the frame's encoding bit: channel 0 accepts JSON only.
/// `linked_module_id` is the only routable module.
pub fn parse_control(body: &[u8], binary: bool, linked_module_id: &str) -> ControlAction {
    if binary {
        return invalid("control channel accepts JSON only");
    }
    let root = match strict_json::parse(body) {
        Ok(value) => value,
        Err(err) => return invalid(err.as_str()),
    };
    let serde_json::Value::Object(fields) = root else {
        return invalid("control request must be a JSON object");
    };
    if fields
        .values()
        .map(value_depth)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        > MAX_CONTROL_DEPTH
    {
        return invalid("control request too deeply nested");
    }

    let Some(op) = fields.get("op") else {
        return invalid("missing op");
    };
    let Some(op) = op.as_str() else {
        return invalid("op must be a string");
    };
    if let Err(err) = check_string("op", op, MAX_OP_LEN, true) {
        return invalid(&err);
    }

    match op {
        OP_CATALOG_LIST => parse_catalog_list(&fields),
        OP_ROUTE_OPEN => parse_route_open(&fields, linked_module_id),
        _ => ControlAction::Reject {
            code: CODE_UNSUPPORTED_OPERATION,
            message: "operation is not supported by this host".to_owned(),
        },
    }
}

fn parse_catalog_list(fields: &serde_json::Map<String, serde_json::Value>) -> ControlAction {
    let filter = match fields.get("module_id") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(id)) => {
            if let Err(err) = check_string("module_id", id, MAX_MODULE_ID_LEN, true) {
                return invalid(&err);
            }
            Some(id.clone())
        }
        Some(_) => return invalid("module_id must be a string"),
    };
    ControlAction::CatalogList {
        module_id_filter: filter,
    }
}

fn parse_route_open(
    fields: &serde_json::Map<String, serde_json::Value>,
    linked_module_id: &str,
) -> ControlAction {
    let Some(serde_json::Value::Object(target)) = fields.get("target") else {
        return invalid("target must be an object");
    };
    let Some(serde_json::Value::String(kind)) = target.get("kind") else {
        return invalid("target.kind must be a string");
    };
    let Some(serde_json::Value::String(module_id)) = target.get("module_id") else {
        return invalid("target.module_id must be a string");
    };
    if let Err(err) = check_string("target.module_id", module_id, MAX_MODULE_ID_LEN, true) {
        return invalid(&err);
    }

    let Some(serde_json::Value::Object(identity)) = fields.get("identity") else {
        return invalid("identity must be an object");
    };
    let Some(serde_json::Value::String(project_root)) = identity.get("project_root") else {
        return invalid("identity.project_root must be a string");
    };
    if let Err(err) = check_string("project_root", project_root, MAX_PROJECT_ROOT_LEN, true) {
        return invalid(&err);
    }
    if !project_root.starts_with('/') {
        return invalid("project_root must be an absolute path");
    }
    let Some(serde_json::Value::String(harness)) = identity.get("harness") else {
        return invalid("identity.harness must be a string");
    };
    if let Err(err) = check_string("harness", harness, MAX_HARNESS_LEN, true) {
        return invalid(&err);
    }
    let Some(serde_json::Value::String(session)) = identity.get("session") else {
        return invalid("identity.session must be a string");
    };
    if let Err(err) = check_string("session", session, MAX_SESSION_LEN, true) {
        return invalid(&err);
    }

    let (consumer_module_id, consumer_launch_nonce) = match fields.get("consumer_identity") {
        None | Some(serde_json::Value::Null) => (None, None),
        Some(serde_json::Value::Object(ci)) => {
            let Some(serde_json::Value::String(module)) = ci.get("module_id") else {
                return invalid("consumer_identity.module_id must be a string");
            };
            if let Err(err) = check_string(
                "consumer_identity.module_id",
                module,
                MAX_MODULE_ID_LEN,
                false,
            ) {
                return invalid(&err);
            }
            let Some(serde_json::Value::String(nonce)) = ci.get("launch_nonce") else {
                return invalid("consumer_identity.launch_nonce must be a string");
            };
            if let Err(err) = check_string(
                "consumer_identity.launch_nonce",
                nonce,
                MAX_LAUNCH_NONCE_LEN,
                false,
            ) {
                return invalid(&err);
            }
            (Some(module.clone()), Some(nonce.clone()))
        }
        Some(_) => return invalid("consumer_identity must be an object"),
    };

    let consumer_capabilities = match fields.get("consumer_capabilities") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(entries)) => {
            if entries.len() > MAX_CAPABILITIES {
                return invalid("too many consumer capabilities");
            }
            let mut out = Vec::with_capacity(entries.len());
            for entry in entries {
                let Some(capability) = entry.as_str() else {
                    return invalid("consumer capability must be a string");
                };
                if let Err(err) =
                    check_string("consumer capability", capability, MAX_CAPABILITY_LEN, false)
                {
                    return invalid(&err);
                }
                out.push(capability.to_owned());
            }
            out
        }
        Some(_) => return invalid("consumer_capabilities must be an array"),
    };

    let admission_facts = match fields.get("admission_facts") {
        None => None,
        Some(facts) => {
            let compact = serde_json::to_vec(facts).expect("Value serialization cannot fail");
            if compact.len() > MAX_ADMISSION_FACTS_BYTES {
                return invalid("admission_facts too large");
            }
            if value_depth(facts) > MAX_ADMISSION_FACTS_DEPTH {
                return invalid("admission_facts too deeply nested");
            }
            Some(facts.clone())
        }
    };

    // Classification runs only after every bound held, so a hostile body
    // cannot pick its rejection code to probe the catalog cheaply.
    if kind != TARGET_KIND_TOOL_PROVIDER {
        return ControlAction::Reject {
            code: CODE_TARGET_UNAVAILABLE,
            message: "target kind is not routable on this host".to_owned(),
        };
    }
    if module_id != linked_module_id {
        return ControlAction::Reject {
            code: CODE_UNKNOWN_MODULE,
            message: format!("module {module_id} is unavailable"),
        };
    }

    ControlAction::RouteOpen {
        identity: RouteIdentity {
            project_root: PathBuf::from(project_root),
            harness: harness.clone(),
            session: session.clone(),
            consumer_module_id,
            consumer_launch_nonce,
            consumer_capabilities,
            admission_facts,
        },
    }
}

/// Validates the linked manifest's module ID against the same constraints
/// `route.open` applies to the client-supplied target, so startup rejects a
/// manifest advertising a module that no conforming request could ever bind.
pub(crate) fn validate_manifest_module_id(module_id: &str) -> Result<(), String> {
    check_string("manifest module_id", module_id, MAX_MODULE_ID_LEN, true)
}

fn check_string(
    field: &str,
    value: &str,
    max_bytes: usize,
    require_nonempty: bool,
) -> Result<(), String> {
    if require_nonempty && value.is_empty() {
        return Err(format!("{field} must be nonempty"));
    }
    if value.len() > max_bytes {
        return Err(format!("{field} exceeds {max_bytes} bytes"));
    }
    if value.contains('\0') {
        return Err(format!("{field} contains NUL"));
    }
    Ok(())
}

/// Depth of a JSON value: 1 at the subtree root, +1 per nested object/array
/// level (protocol §7.1).
fn value_depth(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => 1 + items.iter().map(value_depth).max().unwrap_or(0),
        serde_json::Value::Object(map) => 1 + map.values().map(value_depth).max().unwrap_or(0),
        _ => 1,
    }
}

/// Immutable `catalog.list` bodies serialized before the host is published.
///
/// The direct-linked profile has one static module, so every valid filter
/// resolves to either the complete catalog or one canonical empty catalog.
pub struct CatalogCache {
    module_id: Box<str>,
    full: Box<[u8]>,
    empty: Box<[u8]>,
}

impl CatalogCache {
    pub fn new(manifest: &ManifestSnapshot) -> Self {
        Self {
            module_id: manifest.module_id.clone().into_boxed_str(),
            full: serialize_catalog_response(manifest, true),
            empty: serialize_catalog_response(manifest, false),
        }
    }

    /// Selects cached bytes without allocating. Unknown filters yield an empty
    /// list, not an error (protocol §7.3).
    pub fn body(&self, module_id_filter: Option<&str>) -> &[u8] {
        match module_id_filter {
            None => &self.full,
            Some(filter) if filter == self.module_id.as_ref() => &self.full,
            Some(_) => &self.empty,
        }
    }

    pub fn max_body_len(&self) -> usize {
        self.full.len().max(self.empty.len())
    }
}

fn serialize_catalog_response(manifest: &ManifestSnapshot, include: bool) -> Box<[u8]> {
    let modules = if include {
        vec![serde_json::json!({
            "module_id": manifest.module_id,
            "module_version": manifest.module_version,
            "roles": manifest.provides,
            "control_ops": manifest.control_ops,
        })]
    } else {
        Vec::new()
    };
    serde_json::to_vec(&serde_json::json!({
        "op": OP_CATALOG_LIST,
        "generation": CATALOG_GENERATION,
        "modules": modules,
        "subc_ops": [OP_ROUTE_OPEN, OP_CATALOG_LIST],
    }))
    .expect("catalog response serialization cannot fail")
    .into_boxed_slice()
}

/// Tagged `route.open` success response, built from the published control
/// shape so its tag and field names cannot drift.
pub fn route_open_response_json(channel: u16, epoch: u32) -> Vec<u8> {
    serde_json::to_vec(&subc_control::ClientControlResponse::RouteOpen {
        route_channel: channel,
        route_epoch: epoch,
    })
    .expect("route response serialization cannot fail")
}

/// Canonical `ErrorBody` JSON (protocol §7.4).
pub fn error_body_json(code: &str, message: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "code": code,
        "message": message,
    }))
    .expect("error body serialization cannot fail")
}

/// Strict JSON parsing: UTF-8 only (serde_json enforces), rejects duplicate
/// object keys outright. A conforming client never sends duplicates, and
/// accepting repeated fields would make handling depend on decoder or field
/// order (protocol §7.1).
mod strict_json {
    use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
    use serde_json::Value;
    use std::fmt;

    pub fn parse(bytes: &[u8]) -> Result<Value, ParseError> {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        let value = StrictValue
            .deserialize(&mut deserializer)
            .map_err(|_| ParseError)?;
        deserializer.end().map_err(|_| ParseError)?;
        Ok(value)
    }

    pub struct ParseError;

    impl ParseError {
        pub fn as_str(&self) -> &'static str {
            "malformed control JSON"
        }
    }

    struct StrictValue;

    impl<'de> DeserializeSeed<'de> for StrictValue {
        type Value = Value;

        fn deserialize<D>(self, deserializer: D) -> Result<Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(StrictVisitor)
        }
    }

    struct StrictVisitor;

    impl<'de> Visitor<'de> for StrictVisitor {
        type Value = Value;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "a JSON value without duplicate object keys")
        }

        fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
            Ok(Value::Bool(v))
        }

        fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
            Ok(Value::from(v))
        }

        fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
            Ok(Value::from(v))
        }

        fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
            Ok(Value::from(v))
        }

        fn visit_str<E>(self, v: &str) -> Result<Value, E> {
            Ok(Value::String(v.to_owned()))
        }

        fn visit_string<E>(self, v: String) -> Result<Value, E> {
            Ok(Value::String(v))
        }

        fn visit_unit<E>(self) -> Result<Value, E> {
            Ok(Value::Null)
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut items = Vec::new();
            while let Some(item) = seq.next_element_seed(StrictValue)? {
                items.push(item);
            }
            Ok(Value::Array(items))
        }

        fn visit_map<A>(self, mut map: A) -> Result<Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut object = serde_json::Map::new();
            while let Some(key) = map.next_key::<String>()? {
                let value = map.next_value_seed(StrictValue)?;
                if object.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate object key"));
                }
            }
            Ok(Value::Object(object))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINKED: &str = "magic-context";

    fn reject_code(action: ControlAction) -> &'static str {
        match action {
            ControlAction::Reject { code, .. } => code,
            other => panic!("expected rejection, got {other:?}"),
        }
    }

    fn minimal_route_open() -> serde_json::Value {
        serde_json::json!({
            "op": "route.open",
            "target": {"kind": "tool_provider", "module_id": LINKED},
            "identity": {
                "project_root": "/workspace/project",
                "harness": "opencode",
                "session": "session-1"
            }
        })
    }

    fn parse(value: &serde_json::Value) -> ControlAction {
        parse_control(&serde_json::to_vec(value).unwrap(), false, LINKED)
    }

    #[test]
    fn canonical_route_open_parses() {
        let ControlAction::RouteOpen { identity } = parse(&minimal_route_open()) else {
            panic!("expected route open");
        };
        assert_eq!(identity.project_root, PathBuf::from("/workspace/project"));
        assert_eq!(identity.harness, "opencode");
        assert_eq!(identity.session, "session-1");
        assert!(identity.consumer_capabilities.is_empty());
        assert!(identity.admission_facts.is_none());
    }

    #[test]
    fn binary_flag_on_control_is_semantic_rejection() {
        let action = parse_control(b"{}", true, LINKED);
        assert_eq!(reject_code(action), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn malformed_json_and_non_object_roots_are_rejected() {
        for body in [&b"{"[..], b"[1,2]", b"\xff\xfe", b"null", b"{} trailing"] {
            let action = parse_control(body, false, LINKED);
            assert_eq!(reject_code(action), CODE_INVALID_CONTROL_REQUEST);
        }
    }

    #[test]
    fn duplicate_recognized_field_is_rejected_before_classification() {
        let body = br#"{"op":"route.open","op":"catalog.list","target":{},"identity":{}}"#;
        let action = parse_control(body, false, LINKED);
        assert_eq!(reject_code(action), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn unknown_op_is_unsupported_operation_not_invalid() {
        let action = parse(&serde_json::json!({"op": "server.describe"}));
        assert_eq!(reject_code(action), CODE_UNSUPPORTED_OPERATION);
    }

    #[test]
    fn op_bounds_are_structural() {
        let long_op = "x".repeat(MAX_OP_LEN + 1);
        for op in [String::new(), long_op, "bad\0op".to_owned()] {
            let action = parse(&serde_json::json!({"op": op}));
            assert_eq!(reject_code(action), CODE_INVALID_CONTROL_REQUEST);
        }
        // Exactly 64 bytes is structurally valid — classified as unsupported.
        let action = parse(&serde_json::json!({"op": "y".repeat(MAX_OP_LEN)}));
        assert_eq!(reject_code(action), CODE_UNSUPPORTED_OPERATION);
    }

    #[test]
    fn string_bounds_accept_max_and_reject_max_plus_one() {
        let mut request = minimal_route_open();
        request["identity"]["session"] = serde_json::Value::String("s".repeat(MAX_SESSION_LEN));
        assert!(matches!(parse(&request), ControlAction::RouteOpen { .. }));

        request["identity"]["session"] = serde_json::Value::String("s".repeat(MAX_SESSION_LEN + 1));
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);

        request["identity"]["session"] = serde_json::Value::String("se\0ssion".to_owned());
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn relative_project_root_is_rejected() {
        let mut request = minimal_route_open();
        request["identity"]["project_root"] = serde_json::Value::String("relative/path".to_owned());
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn capability_bounds_are_exact() {
        let mut request = minimal_route_open();
        request["consumer_capabilities"] = serde_json::Value::Array(vec![
            serde_json::Value::String(
                "c".repeat(MAX_CAPABILITY_LEN)
            );
            MAX_CAPABILITIES
        ]);
        assert!(matches!(parse(&request), ControlAction::RouteOpen { .. }));

        request["consumer_capabilities"] =
            serde_json::Value::Array(vec![
                serde_json::Value::String("c".to_owned());
                MAX_CAPABILITIES + 1
            ]);
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);

        request["consumer_capabilities"] =
            serde_json::Value::Array(vec![serde_json::Value::String(
                "c".repeat(MAX_CAPABILITY_LEN + 1),
            )]);
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn admission_facts_bounds_are_exact() {
        fn nested(depth: usize) -> serde_json::Value {
            let mut value = serde_json::json!(1);
            for _ in 1..depth {
                value = serde_json::json!([value]);
            }
            value
        }
        let mut request = minimal_route_open();

        request["admission_facts"] = nested(MAX_ADMISSION_FACTS_DEPTH);
        assert!(matches!(parse(&request), ControlAction::RouteOpen { .. }));

        request["admission_facts"] = nested(MAX_ADMISSION_FACTS_DEPTH + 1);
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);

        // Compact size boundary: a string of N bytes serializes to N+2.
        request["admission_facts"] =
            serde_json::Value::String("f".repeat(MAX_ADMISSION_FACTS_BYTES - 2));
        assert!(matches!(parse(&request), ControlAction::RouteOpen { .. }));

        request["admission_facts"] =
            serde_json::Value::String("f".repeat(MAX_ADMISSION_FACTS_BYTES - 1));
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn ignored_field_nesting_is_bounded() {
        fn nested(depth: usize) -> serde_json::Value {
            let mut value = serde_json::json!(1);
            for _ in 1..depth {
                value = serde_json::json!([value]);
            }
            value
        }

        // Unknown fields count toward nesting limits (protocol §7.1): the
        // same subtree depth admission_facts allows is accepted, one more is
        // rejected before dispatching on `op`.
        let mut request = minimal_route_open();
        request["forward_compat"] = nested(MAX_ADMISSION_FACTS_DEPTH);
        assert!(matches!(parse(&request), ControlAction::RouteOpen { .. }));

        request["forward_compat"] = nested(MAX_ADMISSION_FACTS_DEPTH + 1);
        assert_eq!(reject_code(parse(&request)), CODE_INVALID_CONTROL_REQUEST);

        let mut catalog = serde_json::json!({ "op": OP_CATALOG_LIST });
        catalog["ignored"] = nested(MAX_ADMISSION_FACTS_DEPTH + 1);
        assert_eq!(reject_code(parse(&catalog)), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn unsupported_target_kind_is_target_unavailable() {
        for kind in ["management_surface", "internal_service", "mystery_kind"] {
            let mut request = minimal_route_open();
            request["target"]["kind"] = serde_json::Value::String(kind.to_owned());
            if kind == "internal_service" {
                request["target"]["service_id"] = serde_json::Value::String("svc".to_owned());
            }
            assert_eq!(reject_code(parse(&request)), CODE_TARGET_UNAVAILABLE);
        }
    }

    #[test]
    fn unknown_module_id_is_unknown_module() {
        let mut request = minimal_route_open();
        request["target"]["module_id"] = serde_json::Value::String("thalamus".to_owned());
        assert_eq!(reject_code(parse(&request)), CODE_UNKNOWN_MODULE);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let mut request = minimal_route_open();
        request["future_extension"] = serde_json::json!({"a": 1});
        assert!(matches!(parse(&request), ControlAction::RouteOpen { .. }));
    }

    #[test]
    fn catalog_filters() {
        assert_eq!(
            parse(&serde_json::json!({"op": "catalog.list"})),
            ControlAction::CatalogList {
                module_id_filter: None
            }
        );
        assert_eq!(
            parse(&serde_json::json!({"op": "catalog.list", "module_id": "not-linked"})),
            ControlAction::CatalogList {
                module_id_filter: Some("not-linked".to_owned())
            }
        );
        let action = parse(&serde_json::json!({"op": "catalog.list", "module_id": 7}));
        assert_eq!(reject_code(action), CODE_INVALID_CONTROL_REQUEST);
    }

    #[test]
    fn route_open_response_keeps_its_tag() {
        let decoded: serde_json::Value =
            serde_json::from_slice(&route_open_response_json(7, 77)).unwrap();
        assert_eq!(decoded["op"], "route.open");
        assert_eq!(decoded["route_channel"], 7);
        assert_eq!(decoded["route_epoch"], 77);
    }

    #[test]
    fn catalog_response_is_lossless_and_truthful() {
        let role = serde_json::json!({
            "role": "tool_provider",
            "tools": [{"name": "ctx_reduce", "schema": {"type": "object"}}]
        });
        let manifest = ManifestSnapshot {
            module_id: LINKED.to_owned(),
            module_version: "9.9.9".to_owned(),
            provides: vec![role.clone()],
            control_ops: vec!["mc.reload".to_owned()],
        };
        let catalog = CatalogCache::new(&manifest);
        let unfiltered_body = catalog.body(None);
        assert!(
            std::ptr::eq(unfiltered_body, catalog.body(None)),
            "repeated catalog requests must reuse startup serialization"
        );
        assert!(
            std::ptr::eq(unfiltered_body, catalog.body(Some(LINKED))),
            "an exact filter must reuse the full catalog serialization"
        );
        let unfiltered: serde_json::Value = serde_json::from_slice(unfiltered_body).unwrap();
        assert_eq!(unfiltered["op"], "catalog.list");
        assert_eq!(unfiltered["generation"], CATALOG_GENERATION);
        assert_eq!(unfiltered["modules"].as_array().unwrap().len(), 1);
        assert_eq!(unfiltered["modules"][0]["module_id"], LINKED);
        assert_eq!(unfiltered["modules"][0]["module_version"], "9.9.9");
        assert_eq!(unfiltered["modules"][0]["roles"], serde_json::json!([role]));
        assert_eq!(
            unfiltered["modules"][0]["control_ops"],
            serde_json::json!(["mc.reload"])
        );
        assert_eq!(
            unfiltered["subc_ops"],
            serde_json::json!(["route.open", "catalog.list"])
        );
        // wake.create must stay absent until implemented (protocol AE10).
        assert!(!unfiltered.to_string().contains("wake.create"));

        let filtered: serde_json::Value =
            serde_json::from_slice(catalog.body(Some(LINKED))).unwrap();
        assert_eq!(filtered["modules"].as_array().unwrap().len(), 1);

        let unknown_body = catalog.body(Some("nope"));
        assert!(
            std::ptr::eq(unknown_body, catalog.body(Some("also-nope"))),
            "all unknown filters must reuse one empty catalog serialization"
        );
        let unknown: serde_json::Value = serde_json::from_slice(unknown_body).unwrap();
        assert_eq!(unknown["modules"].as_array().unwrap().len(), 0);
    }
}
