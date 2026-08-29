//! Deterministic caveman-style text compression.
//!
//! This is a byte-for-byte Rust port of
//! `packages/plugin/src/hooks/magic-context/caveman.ts`. Keep the transformation
//! order and ASCII word-boundary rules aligned with that source: the committed
//! differential fixture is the compatibility contract.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CavemanLevel {
    Lite,
    Full,
    Ultra,
}

#[derive(Debug, Clone)]
struct PreservedRegion {
    placeholder: String,
    original: String,
}

const FILLER_WORDS: &[&str] = &[
    "just",
    "really",
    "basically",
    "actually",
    "essentially",
    "simply",
    "clearly",
    "obviously",
    "quite",
    "very",
    "somewhat",
    "rather",
    "fairly",
    "sort of",
    "kind of",
    "a bit",
];

const HEDGING_PHRASES: &[&str] = &[
    "i think",
    "i believe",
    "i feel",
    "probably",
    "perhaps",
    "maybe",
    "it seems",
    "it appears",
    "arguably",
    "i suppose",
    "i guess",
];

const PLEASANTRIES: &[&str] = &["please", "thanks", "thank you", "kindly", "if possible"];

const AUXILIARIES: &[&str] = &[
    "was",
    "were",
    "is",
    "are",
    "am",
    "be",
    "been",
    "being",
    "has been",
    "had been",
    "have been",
    "will be",
    "would be",
    "could be",
    "should be",
    "might be",
    "may be",
];

const PHRASE_SHORTENINGS: &[(&str, &str)] = &[
    ("in order to", "to"),
    ("due to the fact that", "because"),
    ("at this point in time", "now"),
    ("at the moment", "now"),
    ("in the event that", "if"),
    ("for the purpose of", "for"),
    ("with regard to", "about"),
    ("in spite of the fact that", "though"),
    ("on the grounds that", "because"),
    ("for the reason that", "because"),
];

const ULTRA_CONNECTIVE_REPLACEMENTS: &[(&str, &str)] = &[
    ("and then", "→"),
    ("then after", "→"),
    ("afterwards", "→"),
    ("because of", "//"),
    ("therefore", "→"),
    ("because", "//"),
    ("however", "but"),
    ("furthermore", "+"),
    ("additionally", "+"),
    ("as well as", "+"),
    (" and ", " + "),
    (" or ", " | "),
];

const ULTRA_ABBREVIATIONS: &[(&str, &str)] = &[
    ("historian", "hist"),
    ("compartment", "cmpt"),
    ("compartments", "cmpts"),
    ("compressor", "cmp"),
    ("compression", "cmp"),
    ("context", "ctx"),
    ("message", "msg"),
    ("messages", "msgs"),
    ("session", "ses"),
    ("configuration", "cfg"),
    ("config", "cfg"),
    ("implementation", "impl"),
    ("implemented", "impl"),
    ("repository", "repo"),
    ("database", "db"),
    ("directory", "dir"),
];

fn is_ascii_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn previous_char(text: &str, offset: usize) -> Option<char> {
    text[..offset].chars().next_back()
}

fn next_char(text: &str, offset: usize) -> Option<char> {
    text[offset..].chars().next()
}

fn has_word_boundary_before(text: &str, offset: usize) -> bool {
    !previous_char(text, offset).is_some_and(is_ascii_word)
}

fn has_word_boundary_after(text: &str, offset: usize) -> bool {
    !next_char(text, offset).is_some_and(is_ascii_word)
}

fn ascii_eq_at(text: &str, offset: usize, needle: &str) -> bool {
    let Some(candidate) = text.get(offset..offset.saturating_add(needle.len())) else {
        return false;
    };
    candidate.len() == needle.len() && candidate.eq_ignore_ascii_case(needle)
}

fn find_phrase_at<'a>(text: &str, offset: usize, phrases: &'a [&'a str]) -> Option<&'a str> {
    phrases.iter().copied().find(|phrase| {
        ascii_eq_at(text, offset, phrase)
            && has_word_boundary_before(text, offset)
            && has_word_boundary_after(text, offset + phrase.len())
    })
}

fn protect_regex(text: &str, regex: &Regex, preserved: &mut Vec<PreservedRegion>) -> String {
    protect_regex_filtered(text, regex, preserved, |_, _, _| true)
}

/// Like `protect_regex`, but a match is preserved only when `accept(text,
/// start, end)` holds; rejected matches pass through unchanged. This keeps the
/// placeholder-minting invariant (`\u{0}MC_PRES_{index}\u{0}` with
/// `preserved.len()` as the index) in one owner.
fn protect_regex_filtered(
    text: &str,
    regex: &Regex,
    preserved: &mut Vec<PreservedRegion>,
    accept: impl Fn(&str, usize, usize) -> bool,
) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for matched in regex.find_iter(text) {
        if !accept(text, matched.start(), matched.end()) {
            continue;
        }
        output.push_str(&text[cursor..matched.start()]);
        let placeholder = format!("\u{0}MC_PRES_{}\u{0}", preserved.len());
        preserved.push(PreservedRegion {
            placeholder: placeholder.clone(),
            original: matched.as_str().to_string(),
        });
        output.push_str(&placeholder);
        cursor = matched.end();
    }
    output.push_str(&text[cursor..]);
    output
}

fn protect_identifier_regions(text: &str, preserved: &mut Vec<PreservedRegion>) -> String {
    static IDENTIFIER: OnceLock<Regex> = OnceLock::new();
    let regex = IDENTIFIER.get_or_init(|| Regex::new(r"(?:msg|ses|toolu)_[A-Za-z0-9]+").unwrap());
    protect_regex_filtered(text, regex, preserved, |text, start, end| {
        has_word_boundary_before(text, start) && has_word_boundary_after(text, end)
    })
}

fn protect_hash_regions(text: &str, preserved: &mut Vec<PreservedRegion>) -> String {
    static HASH: OnceLock<Regex> = OnceLock::new();
    let regex = HASH.get_or_init(|| Regex::new(r"[0-9a-fA-F]{7,40}").unwrap());
    protect_regex_filtered(text, regex, preserved, |text, start, end| {
        !previous_char(text, start).is_some_and(|ch| ch.is_ascii_alphanumeric())
            && !next_char(text, end).is_some_and(|ch| ch.is_ascii_alphanumeric())
    })
}

fn protect_regions(text: &str) -> (String, Vec<PreservedRegion>) {
    let mut preserved = Vec::new();
    let mut working = text.to_string();

    static FENCED: OnceLock<Regex> = OnceLock::new();
    static INLINE: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    working = protect_regex(
        &working,
        FENCED.get_or_init(|| Regex::new(r"(?s)```.*?```").unwrap()),
        &mut preserved,
    );
    working = protect_regex(
        &working,
        INLINE.get_or_init(|| Regex::new(r"`[^`\n]+`").unwrap()),
        &mut preserved,
    );
    working = protect_regex(
        &working,
        URL.get_or_init(|| Regex::new(r"https?://\S+").unwrap()),
        &mut preserved,
    );
    working = protect_regex(
        &working,
        TAG.get_or_init(|| Regex::new(r"§[0-9]+§").unwrap()),
        &mut preserved,
    );
    working = protect_identifier_regions(&working, &mut preserved);
    working = protect_regex(
        &working,
        PATH.get_or_init(|| {
            Regex::new(r"(?:\.{1,2}/)?(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_]{1,6}")
                .unwrap()
        }),
        &mut preserved,
    );
    working = protect_hash_regions(&working, &mut preserved);
    (working, preserved)
}

fn restore_regions(text: &str, preserved: &[PreservedRegion]) -> String {
    let mut working = text.to_string();
    for region in preserved.iter().rev() {
        working = working.replace(&region.placeholder, &region.original);
    }
    working
}

fn drop_phrases(text: &str, phrases: &[&str]) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if text[cursor..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
        {
            let mut phrase_start = cursor;
            while phrase_start < text.len()
                && next_char(text, phrase_start).is_some_and(char::is_whitespace)
            {
                phrase_start += next_char(text, phrase_start).unwrap().len_utf8();
            }
            if let Some(phrase) = find_phrase_at(text, phrase_start, phrases) {
                cursor = phrase_start + phrase.len();
                continue;
            }
        } else if let Some(phrase) = find_phrase_at(text, cursor, phrases) {
            cursor += phrase.len();
            continue;
        }
        let ch = next_char(text, cursor).expect("cursor is on a character boundary");
        output.push(ch);
        cursor += ch.len_utf8();
    }
    output
}

fn drop_articles(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(ch) = next_char(text, cursor) else {
            break;
        };
        if (ch == 't' || ch == 'T' || ch == 'a' || ch == 'A')
            && has_word_boundary_before(text, cursor)
        {
            let word = if ascii_eq_at(text, cursor, "the") {
                "the"
            } else if ascii_eq_at(text, cursor, "an") {
                "an"
            } else if ascii_eq_at(text, cursor, "a") {
                "a"
            } else {
                ""
            };
            if !word.is_empty() && has_word_boundary_after(text, cursor + word.len()) {
                let mut end = cursor + word.len();
                if end < text.len() && next_char(text, end).is_some_and(char::is_whitespace) {
                    while end < text.len() && next_char(text, end).is_some_and(char::is_whitespace)
                    {
                        end += next_char(text, end).unwrap().len_utf8();
                    }
                    cursor = end;
                    continue;
                }
            }
        }
        output.push(ch);
        cursor += ch.len_utf8();
    }
    collapse_ascii_spaces(&output)
}

fn collapse_ascii_spaces(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut previous_space = false;
    for ch in text.chars() {
        if ch == ' ' {
            if previous_space {
                continue;
            }
            previous_space = true;
        } else {
            previous_space = false;
        }
        output.push(ch);
    }
    output
}

fn matches_participle(text: &str, offset: usize) -> bool {
    let mut end = offset;
    while end < text.len() {
        let ch = next_char(text, end).unwrap();
        if !is_ascii_word(ch) {
            break;
        }
        end += ch.len_utf8();
    }
    if end == offset || !has_word_boundary_after(text, end) {
        return false;
    }
    let token = &text[offset..end].to_ascii_lowercase();
    ["ed", "en", "ing", "ized", "ised"]
        .iter()
        .any(|suffix| token.ends_with(suffix))
}

fn drop_auxiliaries(text: &str) -> String {
    let mut auxiliaries = AUXILIARIES.to_vec();
    auxiliaries.sort_by_key(|aux| std::cmp::Reverse(aux.len()));

    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(ch) = next_char(text, cursor) else {
            break;
        };
        if ch.is_whitespace() {
            let mut whitespace_end = cursor;
            while whitespace_end < text.len()
                && next_char(text, whitespace_end).is_some_and(char::is_whitespace)
            {
                whitespace_end += next_char(text, whitespace_end).unwrap().len_utf8();
            }
            let Some(aux) = auxiliaries.iter().find(|aux| {
                ascii_eq_at(text, whitespace_end, aux)
                    && has_word_boundary_before(text, whitespace_end)
                    && has_word_boundary_after(text, whitespace_end + aux.len())
            }) else {
                output.push_str(&text[cursor..whitespace_end]);
                cursor = whitespace_end;
                continue;
            };
            let mut aux_end = whitespace_end + aux.len();
            if aux_end >= text.len() || !next_char(text, aux_end).is_some_and(char::is_whitespace) {
                output.push_str(&text[cursor..aux_end]);
                cursor = aux_end;
                continue;
            }
            while aux_end < text.len() && next_char(text, aux_end).is_some_and(char::is_whitespace)
            {
                aux_end += next_char(text, aux_end).unwrap().len_utf8();
            }
            if matches_participle(text, aux_end) {
                output.push(' ');
                cursor = aux_end;
                continue;
            }
            output.push_str(&text[cursor..aux_end]);
            cursor = aux_end;
            continue;
        }
        output.push(ch);
        cursor += ch.len_utf8();
    }
    collapse_ascii_spaces(&output)
}

fn replace_word_phrase(text: &str, phrase: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if ascii_eq_at(text, cursor, phrase)
            && has_word_boundary_before(text, cursor)
            && has_word_boundary_after(text, cursor + phrase.len())
        {
            output.push_str(replacement);
            cursor += phrase.len();
        } else {
            let ch = next_char(text, cursor).unwrap();
            output.push(ch);
            cursor += ch.len_utf8();
        }
    }
    output
}

fn replace_literal_phrase(text: &str, phrase: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if text[cursor..].starts_with(phrase) {
            output.push_str(replacement);
            cursor += phrase.len();
        } else {
            let ch = next_char(text, cursor).unwrap();
            output.push(ch);
            cursor += ch.len_utf8();
        }
    }
    output
}

fn apply_phrase_shortenings(text: &str) -> String {
    PHRASE_SHORTENINGS
        .iter()
        .fold(text.to_string(), |working, (phrase, replacement)| {
            replace_word_phrase(&working, phrase, replacement)
        })
}

fn apply_ultra_connectives(text: &str) -> String {
    ULTRA_CONNECTIVE_REPLACEMENTS
        .iter()
        .fold(text.to_string(), |working, (phrase, replacement)| {
            if phrase.starts_with(' ') && phrase.ends_with(' ') {
                replace_literal_phrase(&working, phrase, replacement)
            } else {
                replace_word_phrase(&working, phrase, replacement)
            }
        })
}

fn count_word_occurrences(text: &str, term: &str) -> usize {
    let mut count = 0;
    let mut cursor = 0;
    while cursor < text.len() {
        if ascii_eq_at(text, cursor, term)
            && has_word_boundary_before(text, cursor)
            && has_word_boundary_after(text, cursor + term.len())
        {
            count += 1;
            cursor += term.len();
        } else {
            cursor += next_char(text, cursor).unwrap().len_utf8();
        }
    }
    count
}

fn apply_ultra_abbreviations(text: &str) -> String {
    ULTRA_ABBREVIATIONS
        .iter()
        .fold(text.to_string(), |working, (term, abbreviation)| {
            if count_word_occurrences(&working, term) < 3 {
                return working;
            }
            let mut output = String::with_capacity(working.len());
            let mut cursor = 0;
            while cursor < working.len() {
                if ascii_eq_at(&working, cursor, term)
                    && has_word_boundary_before(&working, cursor)
                    && has_word_boundary_after(&working, cursor + term.len())
                {
                    let first = working[cursor..].chars().next().unwrap();
                    if first.is_ascii_uppercase() {
                        let mut replacement = abbreviation.to_string();
                        if let Some(first) = replacement.get_mut(0..1) {
                            first.make_ascii_uppercase();
                        }
                        output.push_str(&replacement);
                    } else {
                        output.push_str(abbreviation);
                    }
                    cursor += term.len();
                } else {
                    let ch = next_char(&working, cursor).unwrap();
                    output.push(ch);
                    cursor += ch.len_utf8();
                }
            }
            output
        })
}

fn transform_preserving_user_lines(text: &str, transform: impl Fn(&str) -> String) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut output = Vec::with_capacity(lines.len());
    let mut buffer = Vec::new();
    for line in lines {
        if line.starts_with("U: ") {
            if !buffer.is_empty() {
                output.push(transform(&buffer.join("\n")));
                buffer.clear();
            }
            output.push(line.to_string());
        } else {
            buffer.push(line);
        }
    }
    if !buffer.is_empty() {
        output.push(transform(&buffer.join("\n")));
    }
    output.join("\n")
}

fn normalize_whitespace(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let mut normalized = String::with_capacity(line.len());
        let mut previous_space = false;
        for ch in line.chars() {
            if ch == ' ' || ch == '\t' {
                if previous_space {
                    continue;
                }
                normalized.push(' ');
                previous_space = true;
            } else {
                normalized.push(ch);
                previous_space = false;
            }
        }
        while normalized.ends_with([' ', '\t']) {
            normalized.pop();
        }
        lines.push(normalized);
    }
    let mut output = lines.join("\n");
    while output.contains("\n\n\n") {
        output = output.replace("\n\n\n", "\n\n");
    }
    output
}

/// Compress `text` using the same deterministic rules as the TypeScript oracle.
pub fn compress(text: &str, level: CavemanLevel) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let (protected_text, preserved) = protect_regions(text);
    let transformed = transform_preserving_user_lines(&protected_text, |chunk| {
        let mut working = drop_phrases(chunk, FILLER_WORDS);
        working = drop_phrases(&working, HEDGING_PHRASES);
        working = drop_phrases(&working, PLEASANTRIES);
        working = apply_phrase_shortenings(&working);
        if matches!(level, CavemanLevel::Full | CavemanLevel::Ultra) {
            working = drop_auxiliaries(&working);
            working = drop_articles(&working);
        }
        if level == CavemanLevel::Ultra {
            working = apply_ultra_connectives(&working);
            working = apply_ultra_abbreviations(&working);
        }
        working
    });
    normalize_whitespace(&restore_regions(&transformed, &preserved))
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct GoldenCase {
        text: String,
        lite: String,
        full: String,
        ultra: String,
    }

    #[test]
    fn differential_golden_matches_typescript_oracle() {
        let cases: Vec<GoldenCase> =
            serde_json::from_str(include_str!("../testdata/caveman-golden.json"))
                .expect("valid caveman golden");
        for case in cases {
            assert_eq!(
                compress(&case.text, CavemanLevel::Lite),
                case.lite,
                "lite: {:?}",
                case.text
            );
            assert_eq!(
                compress(&case.text, CavemanLevel::Full),
                case.full,
                "full: {:?}",
                case.text
            );
            assert_eq!(
                compress(&case.text, CavemanLevel::Ultra),
                case.ultra,
                "ultra: {:?}",
                case.text
            );
        }
    }
}
