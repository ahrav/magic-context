//! Zero-tool memory classification producer contract.
//!
//! The host still owns prompt rendering and XML parsing. This module owns the
//! provider-facing role and its fixed generation budget so callers cannot turn
//! this management surface into a generic arbitrary-prompt producer.

use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::OnceLock;
use std::time::Duration;

/// The only task currently accepted by `dreamer.run_task`.
pub const CLASSIFY_TASK: &str = "classify";
/// Host-rendered prompt bodies are bounded before they reach the provider leg.
pub const MAX_CLASSIFY_PROMPT_BYTES: usize = 256 * 1024;
pub const MAX_CLASSIFY_MODEL_CHAIN: usize = 8;
/// Classifier generation calibration, kept separate from historian calibration.
pub const CLASSIFY_TEMPERATURE: f64 = 0.1;
pub const CLASSIFY_MAX_OUTPUT_TOKENS: u32 = 32_000;
pub const CLASSIFY_AWAIT_TIMEOUT: Duration = Duration::from_secs(600);
pub const CLASSIFY_RECOVERY_TIMEOUT: Duration = Duration::from_secs(60);

/// This is deliberately a zero-tool system role. The host supplies the pool and
/// retains the parser because accepting a caller-selected role would reopen the
/// producer trust boundary.
pub const CLASSIFY_SYSTEM_PROMPT: &str = r#"You are a memory classifier for the magic-context system. You classify project memories by metadata only. You do NOT rewrite, merge, archive, verify, or create memories, and you do NOT read code — you judge each memory from its own text.

### How to score importance (1-100)
Importance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** — if most memories land in the same band, you have not classified them, you have just labelled them.

Use judgment, not a formula. Blend:
- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?
- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?

Most memories are ordinary working facts — they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A "real, true fact" is not automatically important — truth is not importance.

Rough anchors (not quotas — spread naturally within them): transient/obvious observations 1-30, ordinary helpful project facts 40-65, load-bearing rules/architecture/constraints 70-100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing — a niche, dated, or narrowly-scoped external quirk can sit lower even if it is a "constraint". Score the fact, not the label. If you assigned most of the pool to one band, re-read and differentiate.

### Scope
- `project` — only meaningful inside this repository/product (default when uncertain).
- `ecosystem` — useful to sibling projects in the same stack, harness, provider, or company ecosystem.
- `universe` — broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.

### Shareability
Shareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set `shareable="true"`. This is the COMMON case — most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals.

Keep `shareable="false"` only for what is tied to the USER or their machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope does NOT decide shareability. The host also fails closed and forces secret/credential/personal-path text to private regardless.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory claim="mcm_..." importance="75" scope="project" shareable="true"/>
<memory claim="mcm_..." importance="20" scope="universe" shareable="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false."#;

const CLASSIFY_SCOPES: [&str; 3] = ["project", "ecosystem", "universe"];

fn memory_entry_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<memory\b([^>]*)/?>").expect("memory entry pattern"))
}

fn claim_attr_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"\bclaim\s*=\s*"(mcm_[0-9a-f]{32})""#).expect("claim attribute pattern")
    })
}

fn importance_attr_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"\bimportance\s*=\s*"(\d+)""#).expect("importance attribute pattern")
    })
}

fn scope_attr_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)\bscope\s*=\s*"([a-z]+)""#).expect("scope attribute pattern")
    })
}

fn shareable_attr_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)\bshareable\s*=\s*"(true|false|1|0)""#)
            .expect("shareable attribute pattern")
    })
}

fn classify_root_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)<classify\b[^>]*>(.*?)</classify>").expect("classify root pattern")
    })
}

pub fn validate_classify_manifest(text: &str, expected: &BTreeSet<String>) -> Result<(), String> {
    let body = classify_root_pattern()
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|body| body.as_str())
        .ok_or("no complete classify envelope")?;
    let mut seen = BTreeSet::new();
    let mut entries = 0usize;
    for captures in memory_entry_pattern().captures_iter(body) {
        entries += 1;
        let attrs = captures.get(1).map_or("", |group| group.as_str());
        let claim = claim_attr_pattern()
            .captures(attrs)
            .map(|captures| captures[1].to_string())
            .ok_or("manifest entry is missing a public claim ID")?;
        let importance = importance_attr_pattern()
            .captures(attrs)
            .and_then(|captures| captures[1].parse::<u32>().ok());
        let scope = scope_attr_pattern()
            .captures(attrs)
            .map(|captures| captures[1].to_ascii_lowercase());
        if let Some(scope) = &scope {
            if !CLASSIFY_SCOPES.contains(&scope.as_str()) {
                return Err(format!("manifest entry {claim} carries an unknown scope"));
            }
        }
        if importance.is_none() && scope.is_none() && !shareable_attr_pattern().is_match(attrs) {
            return Err(format!(
                "manifest entry {claim} carries no classification fields"
            ));
        }
        if !seen.insert(claim.clone()) {
            return Err(format!("manifest repeats entry {claim}"));
        }
    }
    if entries == 0 && !body.trim().is_empty() {
        return Err("manifest body has no recognizable entries".to_owned());
    }
    if &seen != expected {
        return Err(format!(
            "manifest covers {} of the {} requested claims",
            seen.intersection(expected).count(),
            expected.len()
        ));
    }
    Ok(())
}

pub fn attempt_child_session_id(
    project: &str,
    ledger_session: &str,
    command_id: &str,
    attempt: usize,
    model: &str,
) -> String {
    let mut hasher = Sha256::new();
    for value in [project, ledger_session, command_id] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    hasher.update((attempt as u64).to_le_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
    let digest = hasher.finalize();
    format!("mc-dreamer:classify:{}", hex_prefix(&digest, 16))
}

/// Cheap producer-chain guard for completions that succeeded at the transport
/// layer but did not return even a classify manifest envelope. The TypeScript
/// host remains responsible for XML parsing, membership checks, and field validation.
pub fn has_manifest_envelope(text: &str) -> bool {
    let text = text.trim();
    text.contains("<classify>") && text.contains("</classify>")
}

/// Mint an opaque child id without exposing the command id or project path in
/// provider/session diagnostics. The registry, rather than this prefix, is the
/// transform exemption authority.
pub fn child_session_id(project: &str, command_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project.as_bytes());
    hasher.update([0]);
    hasher.update(command_id.as_bytes());
    let digest = hasher.finalize();
    format!("mc-dreamer:classify:{}", hex_prefix(&digest, 16))
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(count);
    for byte in bytes.iter().take(count.div_ceil(2)) {
        out.push(HEX[(byte >> 4) as usize] as char);
        if out.len() < count {
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out.truncate(count);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_envelope_rejects_provider_outage_text() {
        assert!(!has_manifest_envelope("All Antigravity endpoints failed"));
        assert!(has_manifest_envelope(
            "<classify><memory claim=\"mcm_test\"/></classify>"
        ));
    }

    #[test]
    fn child_ids_are_stable_but_lineage_scoped() {
        assert_eq!(
            child_session_id("project", "command"),
            child_session_id("project", "command")
        );
        assert_ne!(
            child_session_id("project", "command"),
            child_session_id("other", "command")
        );
        assert!(child_session_id("project", "command").starts_with("mc-dreamer:classify:"));
    }
}
