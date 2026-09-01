use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Pure,
    Mutating,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub execution_mode: ExecutionMode,
    pub schema: Value,
}

use super::{
    ctx_expand_description, ctx_expand_schema, ctx_memory_description, ctx_memory_schema,
    ctx_note_description, ctx_note_schema, ctx_search_description, ctx_search_schema,
};

pub const LIGHT_FALLBACK_NOTICE: &str = "prompt_surface selected light, but built-in light assets are not available yet; using the byte-identical full guidance and tool descriptions until light assets ship.";

pub(crate) const GUIDANCE_FULL_PRIMARY: &str = include_str!("../assets/guidance_primary.txt");
pub(crate) const GUIDANCE_FULL_NO_REDUCE: &str = include_str!("../assets/guidance_no_reduce.txt");

const GUIDANCE_LIGHT_PRIMARY: Option<&str> =
    Some(include_str!("../assets/guidance_light_primary.txt"));
const GUIDANCE_LIGHT_NO_REDUCE: Option<&str> =
    Some(include_str!("../assets/guidance_light_no_reduce.txt"));
const TOOL_LIGHT_DESCRIPTIONS: Option<&[(&str, &str)]> = Some(&[
    (
        "ctx_reduce",
        "Queue a tagged reduction request for asynchronous delivery.",
    ),
    (
        "ctx_memory",
        "Maintain standalone durable project facts: write new knowledge, update changed facts, archive obsolete facts, and merge duplicates.",
    ),
    (
        "ctx_search",
        "Before answering from memory, keyword-search saved memories, notes, and compacted summaries; this Claude Code leg is literal, not semantic.",
    ),
    (
        "ctx_expand",
        "Recover the persisted historian U:/A:/TC: transcript for a compacted conversation range.",
    ),
    (
        "ctx_note",
        "Save or inspect future session follow-ups; surface_condition is recorded but not evaluated on this Claude Code leg.",
    ),
]);

const CTX_REDUCE_DESCRIPTION: &str =
    "Acknowledge a tagged reduction request for asynchronous delivery";

pub const PROMPT_SURFACE_TOOL_IDS: [&str; 5] = [
    "ctx_reduce",
    "ctx_memory",
    "ctx_search",
    "ctx_expand",
    "ctx_note",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptSurfacePreset {
    #[default]
    Full,
    Light,
}

impl PromptSurfacePreset {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Light => "light",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidanceVariant {
    Full,
    NoReduce,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuidanceAsset {
    pub bytes: &'static str,
    pub fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSurfaceSelection {
    pub model_key: Option<String>,
    pub config_identity: String,
    pub preset: PromptSurfacePreset,
    pub guidance_override: Option<String>,
    pub tool_descriptions: BTreeMap<String, String>,
}

impl Default for PromptSurfaceSelection {
    fn default() -> Self {
        Self {
            model_key: None,
            config_identity: String::new(),
            preset: PromptSurfacePreset::Full,
            guidance_override: None,
            tool_descriptions: BTreeMap::new(),
        }
    }
}

pub fn guidance_asset(preset: PromptSurfacePreset, variant: GuidanceVariant) -> GuidanceAsset {
    let full = match variant {
        GuidanceVariant::Full => GUIDANCE_FULL_PRIMARY,
        GuidanceVariant::NoReduce => GUIDANCE_FULL_NO_REDUCE,
    };
    let light = match variant {
        GuidanceVariant::Full => GUIDANCE_LIGHT_PRIMARY,
        GuidanceVariant::NoReduce => GUIDANCE_LIGHT_NO_REDUCE,
    };

    match preset {
        PromptSurfacePreset::Full => GuidanceAsset {
            bytes: full,
            fallback: false,
        },
        PromptSurfacePreset::Light => GuidanceAsset {
            bytes: light.unwrap_or(full),
            fallback: light.is_none(),
        },
    }
}

pub fn is_known_tool_id(tool_id: &str) -> bool {
    PROMPT_SURFACE_TOOL_IDS.contains(&tool_id)
}

pub fn warn_ignored_unknown_tool_description(tool_id: &str) {
    eprintln!(
        "mc-module: config warning: prompt_surface.tool_descriptions.{tool_id} is not a known ctx_* tool ID; the override was ignored."
    );
}

pub fn tool_manifest_falls_back(preset: PromptSurfacePreset) -> bool {
    preset == PromptSurfacePreset::Light && TOOL_LIGHT_DESCRIPTIONS.is_none()
}

pub fn module_tools(selection: &PromptSurfaceSelection) -> Vec<Tool> {
    let description = |tool_id: &str, full: String| {
        selection
            .tool_descriptions
            .get(tool_id)
            .cloned()
            .or_else(|| {
                (selection.preset == PromptSurfacePreset::Light)
                    .then_some(TOOL_LIGHT_DESCRIPTIONS)
                    .flatten()
                    .and_then(|descriptions| {
                        descriptions
                            .iter()
                            .find_map(|(id, text)| (*id == tool_id).then(|| (*text).to_string()))
                    })
            })
            .unwrap_or(full)
    };

    vec![
        Tool {
            name: "transform".to_string(),
            description: Some(
                "Cache-stable context transform: folds compacted history into m0/m1 and applies frozen reductions".to_string(),
            ),
            execution_mode: ExecutionMode::Pure,
            schema: json!({ "type": "object" }),
        },
        Tool {
            name: "ctx_reduce".to_string(),
            description: Some(description(
                "ctx_reduce",
                CTX_REDUCE_DESCRIPTION.to_string(),
            )),
            execution_mode: ExecutionMode::Pure,
            // `PromptSurfaceSelection` may replace only top-level tool descriptions.
            schema: json!({
                "type": "object",
                "properties": {
                    "drop": { "type": "string" }
                },
                "required": ["drop"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: "ctx_memory".to_string(),
            description: Some(description("ctx_memory", ctx_memory_description())),
            execution_mode: ExecutionMode::Mutating,
            schema: ctx_memory_schema(),
        },
        Tool {
            name: "ctx_expand".to_string(),
            description: Some(description("ctx_expand", ctx_expand_description())),
            execution_mode: ExecutionMode::Pure,
            schema: ctx_expand_schema(),
        },
        Tool {
            name: "ctx_search".to_string(),
            description: Some(description("ctx_search", ctx_search_description())),
            execution_mode: ExecutionMode::Pure,
            schema: ctx_search_schema(),
        },
        Tool {
            name: "ctx_note".to_string(),
            description: Some(description("ctx_note", ctx_note_description())),
            execution_mode: ExecutionMode::Mutating,
            schema: ctx_note_schema(),
        },
    ]
}

pub fn session_tools(selection: &PromptSurfaceSelection) -> Vec<Tool> {
    module_tools(selection)
        .into_iter()
        .filter(|tool| is_known_tool_id(&tool.name))
        .collect()
}

pub fn selection_freeze_identity(selection: &PromptSurfaceSelection) -> String {
    if !selection.config_identity.is_empty() {
        return selection.config_identity.clone();
    }

    let mut hasher = Sha256::new();
    hash_part(&mut hasher, "preset", selection.preset.as_str());
    if let Some(guidance) = &selection.guidance_override {
        hash_part(&mut hasher, "guidance_override", guidance);
    }
    for (tool_id, description) in &selection.tool_descriptions {
        hash_part(&mut hasher, "tool", tool_id);
        hash_part(&mut hasher, "description", description);
    }
    format!("legacy{}", hex_digest(hasher.finalize()))
}

pub fn manifest_content_epoch(selection: &PromptSurfaceSelection) -> String {
    if selection.preset == PromptSurfacePreset::Full && selection.tool_descriptions.is_empty() {
        return String::new();
    }

    let mut hasher = Sha256::new();
    hash_part(&mut hasher, "preset", selection.preset.as_str());
    for tool in session_tools(selection) {
        hash_part(&mut hasher, "tool", &tool.name);
        hash_part(
            &mut hasher,
            "description",
            tool.description.as_deref().unwrap_or_default(),
        );
    }
    format!("pm{}", hex_digest(hasher.finalize()))
}

pub fn guidance_content_hash(text: &str, preset: PromptSurfacePreset) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    if preset == PromptSurfacePreset::Light {
        hasher.update(b"\n\0magic-context-prompt-surface:light");
    }
    hex_digest(hasher.finalize())
}

pub fn unified_content_epoch(
    system_prompt_hash: &str,
    selection: &PromptSurfaceSelection,
) -> String {
    let manifest_epoch = manifest_content_epoch(selection);
    if manifest_epoch.is_empty() {
        return String::new();
    }

    let mut hasher = Sha256::new();
    hash_part(&mut hasher, "guidance", system_prompt_hash);
    hash_part(&mut hasher, "manifest", &manifest_epoch);
    format!("ps{}", hex_digest(hasher.finalize()))
}

fn hash_part(hasher: &mut Sha256, label: &str, value: &str) {
    hasher.update(label.len().to_string().as_bytes());
    hasher.update(b":");
    hasher.update(label.as_bytes());
    hasher.update(b"=");
    hasher.update(value.len().to_string().as_bytes());
    hasher.update(b":");
    hasher.update(value.as_bytes());
    hasher.update(b";");
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_slots_serve_authored_guidance_and_descriptions() {
        for variant in [GuidanceVariant::Full, GuidanceVariant::NoReduce] {
            let full = guidance_asset(PromptSurfacePreset::Full, variant);
            let light = guidance_asset(PromptSurfacePreset::Light, variant);
            assert_ne!(light.bytes.as_bytes(), full.bytes.as_bytes());
            assert!(!full.fallback);
            assert!(!light.fallback);
            assert_ne!(
                guidance_content_hash(full.bytes, PromptSurfacePreset::Full),
                guidance_content_hash(light.bytes, PromptSurfacePreset::Light)
            );
        }
        assert!(!tool_manifest_falls_back(PromptSurfacePreset::Light));
        assert!(!tool_manifest_falls_back(PromptSurfacePreset::Full));

        let full_tools = session_tools(&PromptSurfaceSelection::default());
        let light_tools = session_tools(&PromptSurfaceSelection {
            preset: PromptSurfacePreset::Light,
            ..PromptSurfaceSelection::default()
        });
        assert_eq!(light_tools.len(), full_tools.len());
        for (light, full) in light_tools.iter().zip(full_tools) {
            assert_eq!(light.name, full.name);
            assert_eq!(light.schema, full.schema);
            assert_eq!(light.execution_mode, full.execution_mode);
            assert_ne!(light.description, full.description);
        }
    }

    #[test]
    fn default_full_manifest_is_legacy_inert_and_overrides_only_descriptions() {
        let full = PromptSurfaceSelection::default();
        assert!(manifest_content_epoch(&full).is_empty());
        assert!(unified_content_epoch("guidance", &full).is_empty());

        let mut selected = full.clone();
        selected.preset = PromptSurfacePreset::Light;
        selected.tool_descriptions.insert(
            "ctx_search".to_string(),
            "Replacement search prose.".to_string(),
        );
        let legacy = session_tools(&full);
        let tools = session_tools(&selected);
        assert_eq!(tools.len(), legacy.len());
        for (actual, expected) in tools.iter().zip(legacy) {
            assert_eq!(actual.name, expected.name);
            assert_eq!(actual.schema, expected.schema);
            assert_eq!(actual.execution_mode, expected.execution_mode);
        }
        assert_eq!(
            tools[3].description.as_deref(),
            Some("Replacement search prose.")
        );
        assert!(!manifest_content_epoch(&selected).is_empty());
        assert!(!unified_content_epoch("guidance", &selected).is_empty());
    }
}
