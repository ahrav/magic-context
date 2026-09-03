//! Golden compatibility checks against `ai-tokenizer`'s `claude` encoding.
//!
//! The plugin's TypeScript tokenizer generates the fixture. Exact token-ID
//! comparison detects encoding changes that token-count comparison would miss.
//! Fixture loading fails on malformed JSON, and an empty corpus is rejected.

use mc_tokenizer::{encode_ordinary, estimate_tokens};
use serde::Deserialize;

#[derive(Deserialize)]
struct GoldenCase {
    label: String,
    text: String,
    ids: Vec<u32>,
}

fn load_golden() -> Vec<GoldenCase> {
    let raw = include_str!("../testdata/token-golden.json");
    serde_json::from_str(raw).expect("token-golden.json is malformed")
}

#[test]
fn encode_ordinary_matches_ai_tokenizer_ids() {
    let cases = load_golden();
    assert!(!cases.is_empty(), "golden corpus is empty");
    let mut failures = Vec::new();
    for c in &cases {
        let got = encode_ordinary(&c.text);
        if got != c.ids {
            failures.push(format!(
                "case '{}': text={:?}\n  expected {:?}\n  got      {:?}",
                c.label, c.text, c.ids, got
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "token-ID mismatches vs ai-tokenizer (claude):\n{}",
        failures.join("\n")
    );
}

#[test]
fn estimate_tokens_matches_golden_counts() {
    for c in load_golden() {
        assert_eq!(
            estimate_tokens(&c.text),
            c.ids.len(),
            "estimate_tokens count mismatch for case '{}'",
            c.label
        );
    }
}

#[test]
fn empty_text_is_zero() {
    assert_eq!(estimate_tokens(""), 0);
}

#[test]
fn deterministic_across_calls() {
    let text = "Magic Context keeps a long session inside the context window.";
    let first = estimate_tokens(text);
    for _ in 0..1000 {
        assert_eq!(estimate_tokens(text), first);
    }
}
