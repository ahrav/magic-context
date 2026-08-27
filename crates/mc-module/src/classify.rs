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
/// Every chain entry is a potential billable provider run (each failed
/// attempt advances to the next model), so the request-supplied chain is
/// capped before any run starts — otherwise the wire path's only bound on
/// sequential provider attempts would be the request body's byte ceiling.
pub const MAX_CLASSIFY_MODEL_CHAIN: usize = 8;
/// Classifier generation calibration, kept separate from historian calibration.
pub const CLASSIFY_TEMPERATURE: f64 = 0.1;
pub const CLASSIFY_MAX_OUTPUT_TOKENS: u32 = 32_000;
pub const CLASSIFY_AWAIT_TIMEOUT: Duration = Duration::from_secs(600);
pub const CLASSIFY_RECOVERY_TIMEOUT: Duration = Duration::from_secs(60);
/// Work `handle_dreamer_run_task` still has to do AFTER the payload deadline
/// expires, and therefore the margin a caller must leave between its own
/// transport budget and the `timeout_ms` it sends.
///
/// The deadline bounds the start, await, and re-drain windows, so the last of
/// them returns at the deadline. What follows is bounded but not free:
/// `HistorianProducer::purge_session` wraps its whole `session.delete` plus
/// `close` in `request_timeout` (30s), the host then reaps the Broca
/// subprocess group under `SubprocessLimits::termination_grace` (5s between
/// SIGTERM and SIGKILL), and the ledger write plus response dispatch need
/// slack on top. A caller whose transport budget equals `timeout_ms` cancels
/// inside that window: the handler task is dropped between the producer run
/// and the purge, so nothing is recorded, no fallback can complete, and the
/// attempt's billable run stays alive holding the memory-pool prompt.
pub const CLASSIFY_CLEANUP_RESERVE: Duration = Duration::from_secs(40);

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

/// The scope vocabulary a classify entry may carry, mirroring `SCOPES` in
/// `classify-prompt.ts`.
const CLASSIFY_SCOPES: [&str; 3] = ["project", "ecosystem", "universe"];

fn memory_entry_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<memory\b([^>]*)/?>").expect("memory entry pattern"))
}

/// Deliberately as permissive as `parseClassifyManifest`'s own
/// `\bclaim\s*=\s*"([^"]+)"`: the well-formedness check below, not this
/// pattern, is what separates a claim identity from arbitrary text. A
/// narrower pattern would silently reclassify a malformed identity as "no
/// claim attribute" and lose that diagnostic.
fn claim_attr_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bclaim\s*=\s*"([^"]+)""#).expect("claim attribute pattern"))
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

/// The body of the classify root element, or `None` when the envelope is
/// absent or unterminated.
///
/// Deliberately the same syntax the caller accepts
/// (`extractCompleteManifestBody` in `manifest-parser.ts`): case-insensitive
/// and attribute-tolerant, so `<Classify>` or `<classify version="1">` is a
/// valid envelope here too. A stricter reader would advance the fallback
/// chain — and eventually fail the command — over output the authority
/// parses fine.
fn classify_body(text: &str) -> Option<&str> {
    classify_root_pattern()
        .captures(text)
        .and_then(|caps| caps.get(1))
        .map(|body| body.as_str())
}

/// Whether one attempt's output is an acceptable classify manifest for
/// `expected` — the public claim IDs this attempt actually asked about.
///
/// This is the accept predicate for a chain attempt, so it has to live here
/// rather than only in the TypeScript caller: the module decides whether to
/// advance to the next model AND whether to write the durable command
/// response. Accepting on envelope presence alone let an enveloped-but-
/// invalid manifest end the chain and be ledgered, after which the caller's
/// own validation threw too late to reach a fallback model and every retry
/// replayed the same invalid manifest.
///
/// The rules mirror `parseClassifyManifest`/`validateClassifyManifest` in
/// `classify-prompt.ts`, which stays the authority for INTERPRETING and
/// applying values; both sides are pinned by tests. Identity is the claim's
/// opaque public ID — the same `claim="mcm_..."` attribute
/// `CLASSIFY_SYSTEM_PROMPT` demands.
///
/// Diagnostics name counts the caller supplied, and claim IDs only after
/// `is_valid_public_claim_id` proves them to be `mcm_` plus 32 lowercase hex
/// — a fixed-shape opaque token that cannot carry pool text. That check runs
/// before any other per-entry rule so no diagnostic can echo a
/// model-controlled string.
pub fn validate_classify_manifest(text: &str, expected: &BTreeSet<String>) -> Result<(), String> {
    let body = classify_body(text).ok_or("no complete classify envelope")?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut entries = 0usize;
    for captures in memory_entry_pattern().captures_iter(body) {
        entries += 1;
        let attrs = captures.get(1).map_or("", |group| group.as_str());
        let claim = claim_attr_pattern()
            .captures(attrs)
            .map(|caps| caps[1].to_owned())
            .ok_or("manifest entry is missing a claim id")?;
        if !mc_core::claim_operation::is_valid_public_claim_id(&claim) {
            return Err("manifest entry carries a malformed claim id".to_owned());
        }
        let importance = importance_attr_pattern()
            .captures(attrs)
            .and_then(|caps| caps[1].parse::<u32>().ok());
        let scope = scope_attr_pattern()
            .captures(attrs)
            .map(|caps| caps[1].to_ascii_lowercase());
        let shareable = shareable_attr_pattern().is_match(attrs);
        if let Some(scope) = &scope {
            if !CLASSIFY_SCOPES.contains(&scope.as_str()) {
                return Err(format!("manifest entry {claim} carries an unknown scope"));
            }
        }
        if importance.is_none() && scope.is_none() && !shareable {
            return Err(format!(
                "manifest entry {claim} carries no classification fields"
            ));
        }
        if !seen.insert(claim.clone()) {
            return Err(format!("manifest repeats entry {claim}"));
        }
    }
    // Content that parsed to nothing is an unrecognized shape, not an empty
    // classification.
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

/// Derives the deterministic Broca child session for one classify attempt.
/// `ledger_session` is part of the identity because the durable ledger
/// scopes commands to `(ledger_session, command_id)`: two module sessions
/// in the same authority project may reuse a `command_id`, and their
/// attempts must never attach to (or purge) each other's runs.
pub fn attempt_child_session_id(
    project: &str,
    ledger_session: &str,
    command_id: &str,
    attempt: usize,
    model: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project.as_bytes());
    hasher.update([0]);
    hasher.update(ledger_session.as_bytes());
    hasher.update([0]);
    hasher.update(command_id.as_bytes());
    hasher.update([0]);
    hasher.update((attempt as u64).to_le_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
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

    /// A well-formed public claim ID, distinct per `seed`.
    fn claim(seed: u8) -> String {
        format!("mcm_{}", format!("{seed:02x}").repeat(16))
    }

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

    /// The envelope syntax must match what the caller's parser accepts, or
    /// this gate would advance the chain over output the authority parses.
    #[test]
    fn manifest_root_matching_mirrors_the_caller_parser() {
        let one = claim(1);
        let expected: BTreeSet<String> = [one.clone()].into_iter().collect();
        let entry = format!("<memory claim=\"{one}\" scope=\"project\"/>");
        for text in [
            format!("<classify>{entry}</classify>"),
            // Case-insensitive root, as `extractCompleteManifestBody` is.
            format!("<Classify>{entry}</Classify>"),
            // Attributes on the root are tolerated there too.
            format!("<classify version=\"1\">{entry}</classify>"),
            // Surrounding prose is ignored: the root is located, not anchored.
            format!("here you go:\n<classify>{entry}</classify>\ndone"),
        ] {
            assert_eq!(
                validate_classify_manifest(&text, &expected),
                Ok(()),
                "must accept {text:?}"
            );
        }
        // Provider outage text carries no envelope at all.
        assert!(validate_classify_manifest("All Antigravity endpoints failed", &expected).is_err());
    }

    #[test]
    fn manifest_validation_accepts_exact_coverage_and_rejects_every_invalid_shape() {
        let (one, two, three) = (claim(1), claim(2), claim(3));
        let expected: BTreeSet<String> = [one.clone(), two.clone()].into_iter().collect();
        let ok = format!(
            "<classify><memory claim=\"{one}\" importance=\"80\" scope=\"project\"/>\
             <memory claim=\"{two}\" shareable=\"false\"/></classify>"
        );
        assert_eq!(validate_classify_manifest(&ok, &expected), Ok(()));

        // An empty request is satisfied only by an empty manifest.
        assert_eq!(
            validate_classify_manifest("<classify></classify>", &BTreeSet::new()),
            Ok(())
        );

        // Each of these previously ended the chain and got ledgered as this
        // command's durable response, so the caller's later validation threw
        // with no fallback model left to try.
        for (label, text) in [
            ("no envelope", "All Antigravity endpoints failed".to_owned()),
            (
                "unterminated envelope",
                format!("<classify><memory claim=\"{one}\" scope=\"project\"/>"),
            ),
            (
                "missing memory",
                format!("<classify><memory claim=\"{one}\" scope=\"project\"/></classify>"),
            ),
            (
                "extra memory",
                format!(
                    "<classify><memory claim=\"{one}\" scope=\"project\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/>\
                     <memory claim=\"{three}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                "duplicate claim",
                format!(
                    "<classify><memory claim=\"{one}\" scope=\"project\"/>\
                     <memory claim=\"{one}\" scope=\"project\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                "missing claim attribute",
                format!(
                    "<classify><memory scope=\"project\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                // The retired integer identity is no longer an identity at all.
                "numeric id instead of a claim",
                format!(
                    "<classify><memory id=\"1\" scope=\"project\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                "malformed claim id",
                format!(
                    "<classify><memory claim=\"mcm_short\" scope=\"project\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                "unprefixed claim id",
                format!(
                    "<classify><memory claim=\"{}\" scope=\"project\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>",
                    &one[4..]
                ),
            ),
            (
                "unknown scope",
                format!(
                    "<classify><memory claim=\"{one}\" scope=\"galaxy\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                "no classification fields",
                format!(
                    "<classify><memory claim=\"{one}\"/>\
                     <memory claim=\"{two}\" scope=\"project\"/></classify>"
                ),
            ),
            (
                "unrecognized body",
                "<classify>I classified them all, trust me.</classify>".to_owned(),
            ),
        ] {
            assert!(
                validate_classify_manifest(&text, &expected).is_err(),
                "{label} must not be accepted as a successful attempt"
            );
        }
    }

    #[test]
    fn manifest_validation_diagnostics_never_quote_the_manifest() {
        let expected: BTreeSet<String> = [claim(7)].into_iter().collect();
        let secret = "POOL-SECRET-SENTINEL";
        for text in [
            format!("<classify>{secret}</classify>"),
            // A claim attribute is model-controlled text until
            // `is_valid_public_claim_id` bounds its shape, so the
            // well-formedness rejection must not echo it either.
            format!("<classify><memory claim=\"{secret}\" importance=\"80\"/></classify>"),
            format!(
                "<classify><memory claim=\"{secret}\" scope=\"galaxy\"/>\
                 <memory claim=\"{secret}\"/></classify>"
            ),
        ] {
            let detail = validate_classify_manifest(&text, &expected).expect_err("rejected");
            assert!(!detail.contains(secret), "manifest text leaked: {detail}");
        }
    }

    #[test]
    fn child_ids_are_stable_per_attempt_and_distinct_across_attempt_identity() {
        assert_eq!(
            attempt_child_session_id("project", "ses", "command", 0, "prov/model-a"),
            attempt_child_session_id("project", "ses", "command", 0, "prov/model-a"),
            "a retry of the same attempt must reuse its session"
        );
        let base = attempt_child_session_id("project", "ses", "command", 0, "prov/model-a");
        assert_ne!(
            base,
            attempt_child_session_id("project", "ses", "command", 1, "prov/model-b"),
            "fallback attempts must use distinct sessions"
        );
        assert_ne!(
            base,
            attempt_child_session_id("project", "ses", "command", 1, "prov/model-a"),
            "the attempt slot alone must separate sessions"
        );
        assert_ne!(
            base,
            attempt_child_session_id("project", "ses", "command", 0, "prov/model-b"),
            "the model alone must separate sessions"
        );
        assert_ne!(
            base,
            attempt_child_session_id("other", "ses", "command", 0, "prov/model-a")
        );
        assert_ne!(
            base,
            attempt_child_session_id("project", "other", "command", 0, "prov/model-a"),
            "the ledger session alone must separate sessions: commands are \
             scoped to (ledger_session, command_id)"
        );
        assert_ne!(
            base,
            attempt_child_session_id("project", "ses", "other", 0, "prov/model-a")
        );
        assert!(base.starts_with("mc-dreamer:classify:"));
    }
}
