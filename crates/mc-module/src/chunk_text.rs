//! Text-processing helpers shared by the two conversation-chunk builders
//! (`boundary.rs` over `BoundaryMsg` and `historian_chunk.rs` over
//! `FlatMessage`). The builders themselves are type-specific and stay in
//! their modules; everything here is type-independent string/JSON work, kept
//! in one place so role compaction, commit-hash extraction, and whitespace
//! normalization cannot drift between the transform boundary summary and the
//! historian chunk rendering.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

pub(crate) const MAX_COMMITS_PER_BLOCK: usize = 5;
pub(crate) const SYSTEM_DIRECTIVE_PREFIX: &str = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";
pub(crate) const OMO_INTERNAL_INITIATOR_MARKER: &str = "<!-- OMO_INTERNAL_INITIATOR -->";

#[derive(Debug, Clone)]
pub(crate) struct CompactedText {
    pub(crate) text: String,
    pub(crate) commit_hashes: Vec<String>,
}

pub(crate) fn compact_text_for_summary(text: String, role: &str) -> CompactedText {
    let commit_hashes = if role == "assistant" {
        extract_commit_hashes(&text)
    } else {
        Vec::new()
    };
    if commit_hashes.is_empty() || !commit_verb_regex().is_match(&text) {
        return CompactedText {
            text,
            commit_hashes,
        };
    }
    let compacted = {
        let without_hashes = commit_hash_extract_regex().replace_all(&text, "");
        let without_hashes = empty_parens_regex().replace_all(&without_hashes, "");
        let without_hashes = space_before_comma_regex().replace_all(&without_hashes, ",");
        let without_hashes = repeated_comma_regex().replace_all(&without_hashes, ", ");
        let without_hashes = repeated_space_regex().replace_all(&without_hashes, " ");
        let without_hashes = space_before_punct_regex().replace_all(&without_hashes, "$1");
        let trimmed = without_hashes.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    CompactedText {
        text: compacted.unwrap_or(text),
        commit_hashes,
    }
}

pub(crate) fn merge_commit_hashes(existing: &[String], next: &[String]) -> Vec<String> {
    if next.is_empty() {
        return existing.to_vec();
    }
    let mut merged = existing.to_vec();
    for hash in next {
        if merged.contains(hash) {
            continue;
        }
        merged.push(hash.clone());
        if merged.len() >= MAX_COMMITS_PER_BLOCK {
            break;
        }
    }
    merged
}

fn extract_commit_hashes(text: &str) -> Vec<String> {
    let mut hashes = Vec::new();
    for capture in commit_hash_extract_regex().captures_iter(text) {
        let Some(hash) = capture.get(1).map(|value| value.as_str().to_lowercase()) else {
            continue;
        };
        if hashes.contains(&hash) {
            continue;
        }
        hashes.push(hash);
        if hashes.len() >= MAX_COMMITS_PER_BLOCK {
            break;
        }
    }
    hashes
}

/// Chunk-block render line over the fields both builders' block types share.
pub(crate) fn format_block_line(
    role: &str,
    start_ordinal: u64,
    end_ordinal: u64,
    commit_hashes: &[String],
    parts: &[String],
) -> String {
    let range = if start_ordinal == end_ordinal {
        format!("[{start_ordinal}]")
    } else {
        format!("[{start_ordinal}-{end_ordinal}]")
    };
    let commit_suffix = if commit_hashes.is_empty() {
        String::new()
    } else {
        format!(" commits: {}", commit_hashes.join(", "))
    };
    format!("{} {}:{} {}", range, role, commit_suffix, parts.join(" / "))
}

pub(crate) fn extract_key_arg(input: &Value) -> Option<String> {
    let object = input.as_object()?;
    for key in ["filePath", "path", "pattern", "query"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            return Some(truncate_arg(value));
        }
    }
    for key in ["symbol", "module", "action"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            return Some(value.to_string());
        }
    }
    None
}

fn truncate_arg(value: &str) -> String {
    let max_len = 60;
    if value.chars().count() <= max_len {
        return value.to_string();
    }
    let mut out = value.chars().take(max_len).collect::<String>();
    out.push('…');
    out
}

pub(crate) fn clean_user_text(text: &str) -> String {
    clean_user_text_cow(text).trim().to_string()
}

pub(crate) fn clean_user_text_cow(text: &str) -> std::borrow::Cow<'_, str> {
    let without_reminders = system_reminder_regex().replace_all(text, "");
    if without_reminders.contains(OMO_INTERNAL_INITIATOR_MARKER) {
        std::borrow::Cow::Owned(without_reminders.replace(OMO_INTERNAL_INITIATOR_MARKER, ""))
    } else {
        without_reminders
    }
}

pub(crate) fn is_system_directive(text: &str) -> bool {
    text.trim_start().starts_with(SYSTEM_DIRECTIVE_PREFIX)
}

pub(crate) fn normalize_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for word in text.split_whitespace() {
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(word);
    }
    output
}

pub(crate) fn compact_role(role: &str) -> String {
    match role {
        "assistant" => "A".to_string(),
        "user" => "U".to_string(),
        _ => role
            .chars()
            .next()
            .map(|ch| ch.to_uppercase().collect::<String>())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "M".to_string()),
    }
}

fn system_reminder_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<system-reminder>[\s\S]*?</system-reminder>").unwrap())
}

fn commit_hash_extract_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)`?\b([0-9a-f]{7,12})\b`?").unwrap())
}

fn commit_verb_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b",
        )
        .unwrap()
    })
}

fn empty_parens_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\s*\)").unwrap())
}

fn space_before_comma_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+,").unwrap())
}

fn repeated_comma_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r",\s*,+").unwrap())
}

fn repeated_space_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s{2,}").unwrap())
}

fn space_before_punct_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+([,.;:])").unwrap())
}
