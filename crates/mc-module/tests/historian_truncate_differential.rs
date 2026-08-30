//! Token counts are not monotonic in prefix length, so preserve this binary
//! search's probe sequence.
//!
//! `reference` mirrors `truncate_historian_input_if_needed` and `utf16_prefix` in
//! `crates/mc-module/src/historian_chunk.rs`.
//!
//! `reference` defines expected behavior; optimized output must match it.

mod reference {
    use mc_tokenizer::estimate_tokens;

    const HISTORIAN_TRUNCATION_MARKER: &str =
        "\n[… tokens truncated by Magic Context to fit the historian window …]";

    pub fn truncate_historian_input_if_needed(input: &str, token_budget: usize) -> String {
        if estimate_tokens(input) <= token_budget {
            return input.to_string();
        }

        let input_units: Vec<u16> = input.encode_utf16().collect();
        let mut lo = 0usize;
        let mut hi = input_units.len();
        let mut best = 0usize;
        while lo <= hi {
            let mid = (lo + hi) >> 1;
            let candidate = format!(
                "{}{}",
                utf16_prefix(&input_units, mid),
                HISTORIAN_TRUNCATION_MARKER
            );
            if estimate_tokens(&candidate) <= token_budget {
                best = mid;
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }

        format!(
            "{}{}",
            utf16_prefix(&input_units, best),
            HISTORIAN_TRUNCATION_MARKER
        )
    }

    fn utf16_prefix(units: &[u16], requested: usize) -> String {
        let mut end = requested.min(units.len());
        if end > 0 && (0xD800..=0xDBFF).contains(&units[end - 1]) {
            end -= 1;
        }
        String::from_utf16_lossy(&units[..end])
    }
}

use mc_module::historian_chunk::truncate_historian_input_if_needed;
use proptest::prelude::*;

fn fragment() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("The historian summarizes long sessions into compartments. ".to_string()),
        Just("code: `let x = 1;` and a fence\n```rust\nfn f() {}\n```\n".to_string()),
        Just("unicode: ünïcödé — 中文 🚀🧪 𝕊𝕦𝕣𝕣𝕠𝕘𝕒𝕥𝕖 pairs\n".to_string()),
        Just("   \t whitespace   runs \n\n\n".to_string()),
        Just("U: user line\nA: assistant line\nTC: tool call\n".to_string()),
        "[ -~]{0,60}".prop_map(|s| s),
        "\\PC{0,24}".prop_map(|s| s),
    ]
}

fn document() -> impl Strategy<Value = String> {
    proptest::collection::vec(fragment(), 0..24).prop_map(|frags| frags.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(192))]
    #[test]
    fn optimized_matches_frozen_reference(doc in document(), budget in 0usize..320) {
        prop_assert_eq!(
            truncate_historian_input_if_needed(&doc, budget),
            reference::truncate_historian_input_if_needed(&doc, budget),
            "diverged on budget {} doc {:?}", budget, doc
        );
    }
}
