//! Harness-independent JSON shims shared by the per-harness codecs. The
//! codecs themselves stay parallel implementations (per-harness wire formats);
//! only helpers with nothing harness-specific live here.

use serde_json::{json, Map, Value};

use crate::ck_wire::{CkKind, CkWireBlock, MediaKind, OpaqueBlock};

use super::sidecar::stable_hash_prefix;

pub(crate) fn media_kind(media_type: &str) -> MediaKind {
    if media_type.starts_with("image/") {
        MediaKind::Image
    } else if media_type.starts_with("audio/") {
        MediaKind::Audio
    } else if media_type.starts_with("video/") {
        MediaKind::Video
    } else if media_type == "application/pdf" {
        MediaKind::Document
    } else {
        MediaKind::File
    }
}

pub(crate) fn opaque_arc(part: &Value) -> Option<Value> {
    let approval_id = string_field(part, "approvalId")?;
    let part_type = string_field(part, "type").unwrap_or_default();
    let role = if part_type.contains("response") {
        "Response"
    } else {
        "Request"
    };
    Some(json!({ "kind": "Approval", "id": approval_id, "role": role }))
}

pub(crate) fn opaque_block(
    harness: &str,
    kind: &str,
    raw: Value,
    arc: Option<Value>,
) -> CkWireBlock {
    CkWireBlock::bare(CkKind::Opaque(OpaqueBlock {
        source: json!({ "type": "harness", "harness": harness }),
        kind: kind.to_string(),
        raw,
        arc,
    }))
}

pub(crate) fn set_value(value: &mut Value, key: &str, next: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(key.to_string(), next);
    }
}

pub(crate) fn set_string(value: &mut Value, key: &str, text: &str) {
    set_value(value, key, Value::String(text.to_string()));
}

pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(crate) fn synth_tool_id(
    ordinal: u64,
    part_index: usize,
    tool_name: &str,
    input: &Value,
) -> String {
    format!(
        "synth-tool-{ordinal}-{part_index}-{tool_name}-{}",
        stable_hash_prefix(input, 12)
    )
}
