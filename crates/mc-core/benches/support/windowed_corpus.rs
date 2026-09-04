//! Deterministic corpora for the windowed redaction bench and its semantic oracle.
//!
//! Every generator is a pure function of `(size, seed)`, so the bench and the
//! oracle see identical bytes. Credential shapes are assembled from fragments
//! so no literal here matches a detector.

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
            out.push_str("password=hunter7B9xQ");
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

/// One secret per 4 KiB, so a 64 MiB payload stays below the detection cap
/// only when the caller passes a cap at least as large. The bench passes
/// `usize::MAX`-like caps; the oracle records the cap it used.
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

/// `code_keywords_clean` with 0.5% random invalid UTF-8 bytes: lossy path.
pub fn invalid_utf8_bytes(bytes: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng::new(seed ^ 0x51);
    let mut out = code_keywords_clean(bytes, seed).into_bytes();
    let count = out.len() / 200;
    for _ in 0..count {
        let at = rng.below(out.len());
        // Continuation or truncated lead bytes are never valid on their own.
        out[at] = match rng.below(3) {
            0 => 0x80 + (rng.below(64) as u8),
            1 => 0xC0 + (rng.below(32) as u8),
            _ => 0xF5 + (rng.below(11) as u8),
        };
    }
    out
}

/// `π` and `\u{fffd}` runs positioned across every window boundary.
///
/// Windows start on line boundaries, so the runs are laid down with newlines at
/// intervals that keep the boundaries landing inside a run.
pub fn multibyte_edges(bytes: usize, seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    // 512 KiB windows, 96 KiB overlap: boundaries fall near every
    // (512 - 96) KiB and within the MIN_WINDOW_ADVANCE range. A run every
    // 64 KiB guarantees a run under each of them.
    let run_stride = 64 * 1024;
    let mut next_run = run_stride - 4 * 1024;
    while out.len() < bytes {
        if out.len() >= next_run {
            let glyph = if rng.below(2) == 0 { "π" } else { "\u{fffd}" };
            for _ in 0..(8 * 1024 / glyph.len()) {
                out.push_str(glyph);
            }
            out.push_str(" token=π\u{fffd}π ");
            next_run += run_stride;
        }
        for _ in 0..8 {
            out.push_str(rng.pick(PROSE_WORDS));
            out.push(' ');
        }
        out.push('\n');
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

/// Every text corpus by name, in bench order.
pub const TEXT_CORPORA: &[(&str, Generator)] = &[
    ("prose_clean", prose_clean),
    ("code_keywords_clean", code_keywords_clean),
    ("json_config_clean", json_config_clean),
    ("secret_sparse", secret_sparse),
    ("secret_dense", secret_dense),
    ("single_long_line", single_long_line),
    ("short_lines", short_lines),
    ("multibyte_edges", multibyte_edges),
];

pub const MIB: usize = 1024 * 1024;

/// Sizes every cell is measured at.
pub const SIZES: &[usize] = &[MIB, 8 * MIB, 64 * MIB];

/// Seed derivation keeps each (corpus, size) cell distinct and stable.
pub fn seed_for(name: &str, size: usize) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in name.bytes().chain(size.to_le_bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}
