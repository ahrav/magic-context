//! Every generator yields the same corpus for a given `(size, seed)`.
//! Credential shapes combine fragments so this file contains no complete detector-recognized secret literal.
//!
//! Verdict-only scans stop at the first finding, so secret-bearing corpora are excluded from verdict-only cells.
//! The bench asserts each corpus classification at setup.

use mc_core::redaction::{MAX_REDACTABLE_BYTES, WINDOW_OVERLAP_BYTES};

/// Splitmix64: fixed-width, platform independent.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9e37_79b9_7f4a_7c15)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    fn alnum(&mut self, out: &mut String, len: usize) {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for _ in 0..len {
            out.push(char::from(*self.pick(ALPHABET)));
        }
    }
}

/// English-like words that contain no rule anchor as a substring.
const PROSE_WORDS: &[&str] = &[
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "while", "reading", "logs",
    "from", "deploy", "pipeline", "stage", "output", "compile", "finished", "warning", "unused",
    "variable", "shadow", "request", "handler", "returned", "status", "duration", "millis", "and",
    "with", "that", "this", "were", "when", "there", "more", "about", "into", "than", "only",
    "other", "some", "could", "time", "these", "first", "such", "like", "even", "most", "after",
    "also", "made", "many", "must", "before", "back", "through", "where", "much", "well", "know",
    "should", "down", "work", "year", "because", "come", "give", "day",
];

/// English-like text, no keywords, short lines: prefilter rejection speed.
pub fn prose_clean(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    while out.len() < bytes {
        let words = 6 + rng.below(8);
        for index in 0..words {
            if index > 0 {
                out.push(' ');
            }
            out.push_str(rng.pick(PROSE_WORDS));
        }
        out.push('\n');
    }
    truncate(out, bytes)
}

/// Source code dense in `key`, `token`, `secret`, `password`, `auth`, `=`,
/// `:`, quotes and base64-looking strings, but no real secret. Every line is
/// built so scalars, suppressors, safelists, or low entropy reject it.
pub fn code_keywords_clean(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 128);
    let names = [
        "api_key",
        "apiKey",
        "auth_token",
        "secret",
        "password",
        "access_key",
        "client_secret",
        "token",
        "authorization",
        "credential",
        "private_key",
        "bearer_token",
        "session_key",
    ];
    let scalars = [
        "true",
        "false",
        "null",
        "None",
        "0",
        "1",
        "42",
        "3.14",
        "nil",
        "undefined",
    ];
    let placeholders = [
        "${API_KEY}",
        "{{ secret }}",
        "your-token-here",
        "changeme",
        "PLACEHOLDER",
        "example",
        "REDACTED",
        "todo",
        "notasecret",
        "xxxx",
        "${SECRET}",
        "dummy",
    ];
    while out.len() < bytes {
        match rng.below(9) {
            0 => {
                out.push_str("    ");
                out.push_str(rng.pick(&names));
                out.push_str(" = ");
                out.push_str(rng.pick(&scalars));
                out.push('\n');
            }
            1 => {
                out.push_str("  \"");
                out.push_str(rng.pick(&names));
                out.push_str("\": \"");
                out.push_str(rng.pick(&placeholders));
                out.push_str("\",\n");
            }
            2 => {
                out.push_str("export ");
                out.push_str(&rng.pick(&names).to_ascii_uppercase());
                out.push('=');
                out.push_str(rng.pick(&placeholders));
                out.push('\n');
            }
            3 => {
                out.push_str("if (!config.");
                out.push_str(rng.pick(&names));
                out.push_str(") { throw new Error(\"missing ");
                out.push_str(rng.pick(&names));
                out.push_str("\"); }\n");
            }
            4 => {
                // Base64-looking but all-lowercase: the char-class filter rejects it.
                out.push_str("const digest = \"");
                const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
                for _ in 0..40 {
                    out.push(char::from(*rng.pick(LOWER)));
                }
                out.push_str("\";\n");
            }
            5 => {
                out.push_str("// ");
                out.push_str(rng.pick(&names));
                out.push_str(": read the ");
                out.push_str(rng.pick(&names));
                out.push_str(" from the environment, never hardcode it\n");
            }
            6 => {
                out.push_str("auth.headers['Authorization'] = 'Bearer ' + ");
                out.push_str(rng.pick(&names));
                out.push_str(";\n");
            }
            7 => {
                out.push_str("def get_");
                out.push_str(rng.pick(&names));
                out.push_str("(self, key: str) -> str:\n    return self.");
                out.push_str(rng.pick(&names));
                out.push_str("[key]\n");
            }
            _ => {
                for _ in 0..5 {
                    out.push_str(rng.pick(PROSE_WORDS));
                    out.push(' ');
                }
                out.push('\n');
            }
        }
    }
    truncate(out, bytes)
}

/// JSON/YAML configuration with credential-shaped keys and placeholder values.
pub fn json_config_clean(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 128);
    let keys = [
        "database_password",
        "api_key",
        "apiKey",
        "aws_secret_access_key",
        "client_secret",
        "auth_token",
        "webhook_secret",
        "private_key_path",
        "token_endpoint",
        "session_secret",
    ];
    let values = [
        "${DATABASE_PASSWORD}",
        "{{API_KEY}}",
        "<REPLACE_WITH_YOUR_KEY>",
        "changeme",
        "null",
        "example-key",
        "dummy-token",
        "PLACEHOLDER",
        "REDACTED",
        "INSERT_YOUR_SECRET",
    ];
    out.push_str("{\n  \"services\": [\n");
    while out.len() < bytes {
        out.push_str("    {\n      \"name\": \"svc-");
        out.push_str(&rng.below(100_000).to_string());
        out.push_str("\",\n");
        for _ in 0..4 {
            out.push_str("      \"");
            out.push_str(rng.pick(&keys));
            out.push_str("\": \"");
            out.push_str(rng.pick(&values));
            out.push_str("\",\n");
        }
        out.push_str("      \"replicas\": ");
        out.push_str(&(1 + rng.below(9)).to_string());
        out.push_str("\n    },\n");
        out.push_str("    # yaml_style_password: ${VAULT_PASSWORD}\n");
    }
    truncate(out, bytes)
}

/// One credential-shaped line the scanner reports. Fragments only.
fn secret_line(rng: &mut Rng, out: &mut String) {
    match rng.below(4) {
        0 => {
            // Split across pushes: `password=` joined to a value in one source literal matches the keyed-assignment rule.
            out.push_str("password");
            out.push('=');
            out.push_str("hunter7B9xQ");
            rng.alnum(out, 12);
        }
        1 => {
            out.push_str("\"apiKey\": \"Sx9Kq2mB7Lw");
            rng.alnum(out, 12);
            out.push('"');
        }
        2 => {
            out.push_str("aws=AKIA");
            const B32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
            for _ in 0..16 {
                out.push(char::from(*rng.pick(B32)));
            }
        }
        _ => {
            out.push_str("token: ghp_");
            rng.alnum(out, 36);
        }
    }
    out.push('\n');
}

/// `prose_clean` plus one real secret per 4 MiB.
pub fn secret_sparse(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    let stride = 4 * 1024 * 1024;
    // Corpora smaller than half a stride still carry one secret, at their midpoint.
    let mut next_secret = (stride / 2).min(bytes / 2);
    while out.len() < bytes {
        if out.len() >= next_secret {
            secret_line(&mut rng, &mut out);
            next_secret += stride;
        }
        for _ in 0..8 {
            out.push_str(rng.pick(PROSE_WORDS));
            out.push(' ');
        }
        out.push('\n');
    }
    truncate(out, bytes)
}

/// One secret per 4 KiB: 256 detections per MiB, 4096 at 16 MiB.
///
/// The bench redacts under the kernel's 4096-detection cap, so 16 MiB is the largest size
/// that completes; larger inputs exit early with `DetectionLimit`.
pub fn secret_dense(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    let stride = 4 * 1024;
    let mut next_secret = stride / 2;
    while out.len() < bytes {
        if out.len() >= next_secret {
            secret_line(&mut rng, &mut out);
            next_secret += stride;
        }
        for _ in 0..8 {
            out.push_str(rng.pick(PROSE_WORDS));
            out.push(' ');
        }
        out.push('\n');
    }
    truncate(out, bytes)
}

/// One line, no `\n`, mixed content: exercises `MIN_WINDOW_ADVANCE_BYTES`.
pub fn single_long_line(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    let names = ["api_key", "token", "secret", "password", "auth"];
    while out.len() < bytes {
        match rng.below(6) {
            0 => {
                out.push_str(rng.pick(&names));
                out.push_str("=null ");
            }
            1 => {
                out.push('"');
                out.push_str(rng.pick(&names));
                out.push_str("\": \"${VALUE}\", ");
            }
            _ => {
                out.push_str(rng.pick(PROSE_WORDS));
                out.push(' ');
            }
        }
    }
    let mut out = truncate(out, bytes);
    debug_assert!(!out.contains('\n'));
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

/// 17-byte lines: line-boundary window placement.
pub fn short_lines(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    while out.len() < bytes {
        // 16 chars + newline.
        let mut line = String::with_capacity(17);
        while line.len() < 16 {
            let word = rng.pick(PROSE_WORDS);
            if line.len() + word.len() + 1 > 16 {
                while line.len() < 16 {
                    line.push('.');
                }
                break;
            }
            line.push_str(word);
            line.push(' ');
        }
        line.truncate(16);
        out.push_str(&line);
        out.push('\n');
    }
    truncate(out, bytes)
}

/// Returns `code_keywords_clean` with invalid UTF-8 injected only into prose-only lines.
///
/// Only prose-only lines preserve the keyword-clean corpus invariant.
pub fn invalid_utf8_bytes(bytes: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng::new(seed ^ 0x51);
    let mut out = code_keywords_clean(bytes, seed).into_bytes();
    let mut safe_ranges: Vec<(usize, usize)> = Vec::new();
    let mut line_start = 0usize;
    for (index, &byte) in out.iter().enumerate() {
        if byte == b'\n' {
            let line = &out[line_start..index];
            if !line.is_empty() && line.iter().all(|&b| b.is_ascii_lowercase() || b == b' ') {
                safe_ranges.push((line_start, index));
            }
            line_start = index + 1;
        }
    }
    assert!(
        !safe_ranges.is_empty(),
        "code_keywords_clean produced no prose-only line to corrupt"
    );
    let count = out.len() / 200;
    for _ in 0..count {
        let &(start, end) = rng.pick(&safe_ranges);
        let at = start + rng.below(end - start);
        // Continuation or truncated lead bytes are never valid on their own.
        out[at] = match rng.below(3) {
            0 => 0x80 + (rng.below(64) as u8),
            1 => 0xC0 + (rng.below(32) as u8),
            _ => 0xF5 + (rng.below(11) as u8),
        };
    }
    out
}

/// Each line begins with a padded `π` or `\u{fffd}` run that places `MAX_REDACTABLE_BYTES % LINE` inside a glyph.
///
/// `multibyte_edges` requires `scan_windows` in `mc_core::redaction` to start each window at a line start and end it `MAX_REDACTABLE_BYTES` later, clamped to a char boundary.
/// Each line has `LINE` bytes, and `LINE` does not exceed the minimum window advance. Every window start is therefore a multiple of `LINE`, and every non-final window end sits at line offset `MAX_REDACTABLE_BYTES % LINE`, which the run covers mid-glyph.
pub fn multibyte_edges(bytes: usize, seed: u64) -> String {
    const LINE: usize = 48 * 1024;
    const _: () = assert!(LINE <= (MAX_REDACTABLE_BYTES - WINDOW_OVERLAP_BYTES) / 2);
    const END_OFFSET: usize = MAX_REDACTABLE_BYTES % LINE;
    const RUN_END: usize = END_OFFSET + 4096;
    const _: () = assert!(END_OFFSET >= 2 && RUN_END + 256 < LINE);
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + LINE);
    while out.len() < bytes {
        let glyph = if rng.below(2) == 0 { "π" } else { "\u{fffd}" };
        let line_start = out.len();
        // Glyph boundaries sit at `pad + k * glyph.len()`; one pad byte keeps `END_OFFSET` off them.
        if END_OFFSET.is_multiple_of(glyph.len()) {
            out.push('.');
        }
        while out.len() - line_start < RUN_END {
            out.push_str(glyph);
        }
        out.push(' ');
        loop {
            let word = rng.pick(PROSE_WORDS);
            if out.len() - line_start + word.len() + 2 > LINE {
                break;
            }
            out.push_str(word);
            out.push(' ');
        }
        while out.len() - line_start < LINE - 1 {
            out.push('.');
        }
        out.push('\n');
        debug_assert_eq!(out.len() - line_start, LINE);
    }
    truncate(out, bytes)
}

fn truncate(mut text: String, bytes: usize) -> String {
    let mut index = bytes.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    text.truncate(index);
    text
}

pub type Generator = fn(usize, u64) -> String;

pub struct Corpus {
    pub name: &'static str,
    pub generate: Generator,
    /// Whether the scanner reports nothing on the corpus, so a verdict-only scan walks every byte.
    pub clean: bool,
}

/// Every text corpus by name, in bench order.
pub const TEXT_CORPORA: &[Corpus] = &[
    Corpus {
        name: "prose_clean",
        generate: prose_clean,
        clean: true,
    },
    Corpus {
        name: "code_keywords_clean",
        generate: code_keywords_clean,
        clean: true,
    },
    Corpus {
        name: "json_config_clean",
        generate: json_config_clean,
        clean: true,
    },
    Corpus {
        name: "secret_sparse",
        generate: secret_sparse,
        clean: false,
    },
    Corpus {
        name: "secret_dense",
        generate: secret_dense,
        clean: false,
    },
    Corpus {
        name: "single_long_line",
        generate: single_long_line,
        clean: true,
    },
    Corpus {
        name: "short_lines",
        generate: short_lines,
        clean: true,
    },
    Corpus {
        name: "multibyte_edges",
        generate: multibyte_edges,
        clean: true,
    },
];

pub const MIB: usize = 1024 * 1024;

/// Sizes every cell is measured at.
pub const SIZES: &[usize] = &[MIB, 8 * MIB, 64 * MIB];

/// Seed derivation keeps each (corpus, size) cell distinct and stable.
pub fn seed_for(name: &str, size: usize) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    // Fixed width: `usize::to_le_bytes` differs between 32- and 64-bit targets.
    for byte in name.bytes().chain((size as u64).to_le_bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}
