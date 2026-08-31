//! This crate ports ai-tokenizer's Claude encoding to Rust.
//!
//! `estimateTokens(text)` in the TS harness returns `Tokenizer(claudeEncoding).encode(text, "all").length`.
//! In TS `"all"` mode, special-token substrings are encoded as literal byte-BPE text.
//! In TS `"all"` mode, `<EOT>` encodes as four byte tokens rather than its special-token rank.
//! `encode_ordinary` and `count_ordinary` perform byte-BPE without special-token handling.
//!
//!

use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rustc_hash::FxHashMap;
use tiktoken_rs::{CoreBPE, Rank};

/// `include_str!` embeds the vocabulary at build time, avoiding runtime file reads and network fetches.
const CLAUDE_TIKTOKEN: &str = include_str!("../assets/claude.tiktoken");

/// `CLAUDE_PAT_STR` is the pattern that `CoreBPE` uses to pre-tokenize text before BPE merging.
const CLAUDE_PAT_STR: &str =
    r"'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+";

fn tokenizer() -> &'static CoreBPE {
    static TOKENIZER: OnceLock<CoreBPE> = OnceLock::new();
    TOKENIZER.get_or_init(|| {
        let mut encoder: FxHashMap<Vec<u8>, Rank> = FxHashMap::default();
        for line in CLAUDE_TIKTOKEN.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split(' ');
            let raw = parts.next().expect("vocab line missing token field");
            let rank_str = parts.next().expect("vocab line missing rank field");
            let bytes = STANDARD
                .decode(raw)
                .expect("vocab token is not valid base64");
            let rank: Rank = rank_str.parse().expect("vocab rank is not a u32");
            encoder.insert(bytes, rank);
        }
        // `CoreBPE` receives no special-token encoder because TS `encode(_, "all")` treats special-token substrings as ordinary byte-BPE text.
        CoreBPE::new(encoder, FxHashMap::default(), CLAUDE_PAT_STR)
            .expect("claude BPE construction failed (bad vocab or pattern)")
    })
}

pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    tokenizer().count_ordinary(text)
}

pub fn encode_ordinary(text: &str) -> Vec<Rank> {
    tokenizer().encode_ordinary(text)
}
