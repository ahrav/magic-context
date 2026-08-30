//! Token counts stay comparable only if compression output is stable;
//! `reference` is a frozen copy of the current implementation and defines
//! expected behavior. Optimized output must match it byte for byte.
//!
//! `reference` mirrors `crates/mc-module/src/caveman.rs`.

#[allow(clippy::all, dead_code)]
mod reference {
    use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
    use memchr::memmem::Finder;
    use regex::Regex;
    use std::borrow::Cow;
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

    /// Byte-level twin of `has_word_boundary_before`/`after`. All needles are
    /// pure ASCII, so a match's edge offsets sit on char boundaries, and any
    /// UTF-8 lead or continuation byte (>= 0x80) is non-word exactly like the
    /// non-ASCII char it belongs to.
    #[inline]
    fn is_word_byte(b: u8) -> bool {
        b.is_ascii_alphanumeric() || b == b'_'
    }

    fn phrase_automaton(patterns: &[&str]) -> AhoCorasick {
        AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostFirst)
            .build(patterns)
            .expect("static pattern set builds")
    }

    fn filler_automaton() -> &'static AhoCorasick {
        static A: OnceLock<AhoCorasick> = OnceLock::new();
        A.get_or_init(|| phrase_automaton(FILLER_WORDS))
    }

    fn hedging_automaton() -> &'static AhoCorasick {
        static A: OnceLock<AhoCorasick> = OnceLock::new();
        A.get_or_init(|| phrase_automaton(HEDGING_PHRASES))
    }

    fn pleasantries_automaton() -> &'static AhoCorasick {
        static A: OnceLock<AhoCorasick> = OnceLock::new();
        A.get_or_init(|| phrase_automaton(PLEASANTRIES))
    }

    /// Drops every whole-word occurrence of the automaton's phrases, along with
    /// the whitespace run immediately preceding each dropped phrase.
    ///
    /// The automaton must be leftmost-first over a set in which no phrase is a
    /// prefix of another (asserted by `pattern_set_invariants`): at most one
    /// phrase can then match at a given start position, so the leftmost match is
    /// the same one a position-by-position scan selects. A candidate that fails a
    /// word-boundary check restarts the search one byte later, which keeps
    /// overlapping later candidates reachable.
    fn drop_phrases<'a>(text: &'a str, automaton: &AhoCorasick) -> Cow<'a, str> {
        let bytes = text.as_bytes();
        let mut out: Option<String> = None;
        // Bytes below `pending` are already emitted or dropped.
        let mut pending = 0usize;
        let mut search = 0usize;
        while search < bytes.len() {
            let Some(m) = automaton.find(&bytes[search..]) else {
                break;
            };
            let s = search + m.start();
            let e = search + m.end();
            let before_ok = s == 0 || !is_word_byte(bytes[s - 1]);
            let after_ok = e >= bytes.len() || !is_word_byte(bytes[e]);
            if !(before_ok && after_ok) {
                search = s + 1;
                continue;
            }
            // A dropped phrase absorbs the maximal Unicode-whitespace run
            // immediately before it, bounded by the previous drop point.
            let mut run_start = s;
            while run_start > pending {
                let ch = text[..run_start]
                    .chars()
                    .next_back()
                    .expect("run_start > 0 within text");
                if ch.is_whitespace() {
                    run_start -= ch.len_utf8();
                } else {
                    break;
                }
            }
            let out_ref = out.get_or_insert_with(|| String::with_capacity(text.len()));
            out_ref.push_str(&text[pending..run_start]);
            pending = e;
            search = e;
        }
        match out {
            None => Cow::Borrowed(text),
            Some(mut o) => {
                o.push_str(&text[pending..]);
                Cow::Owned(o)
            }
        }
    }

    /// Working text plus a lowercase byte shadow kept in exact sync. ASCII
    /// lowering is length-preserving, so shadow offsets equal text offsets, and
    /// a case-insensitive needle search over the shadow is an exact byte search.
    struct ShadowedText {
        text: String,
        shadow: Vec<u8>,
    }

    impl ShadowedText {
        fn new(text: String) -> Self {
            let shadow = text.bytes().map(|b| b.to_ascii_lowercase()).collect();
            Self { text, shadow }
        }
    }

    /// Replaces whole-word, ASCII-case-insensitive occurrences of the finder's
    /// needle. With `uppercase_first`, a match whose first source byte is an
    /// ASCII uppercase letter receives the replacement with its first letter
    /// uppercased (the abbreviation-pass case rule). A pass with no verified
    /// match leaves the buffers untouched.
    fn replace_word_phrase(
        buf: &mut ShadowedText,
        finder: &Finder<'_>,
        needle_len: usize,
        replacement: &str,
        uppercase_first: bool,
    ) {
        let mut pos = 0usize;
        let mut pending = 0usize;
        let mut out: Option<(String, Vec<u8>)> = None;
        while pos < buf.shadow.len() {
            let Some(off) = finder.find(&buf.shadow[pos..]) else {
                break;
            };
            let s = pos + off;
            let e = s + needle_len;
            let before_ok = s == 0 || !is_word_byte(buf.shadow[s - 1]);
            let after_ok = e >= buf.shadow.len() || !is_word_byte(buf.shadow[e]);
            if !(before_ok && after_ok) {
                pos = s + 1;
                continue;
            }
            let (out_text, out_shadow) = out.get_or_insert_with(|| {
                (
                    String::with_capacity(buf.text.len()),
                    Vec::with_capacity(buf.text.len()),
                )
            });
            out_text.push_str(&buf.text[pending..s]);
            out_shadow.extend_from_slice(&buf.shadow[pending..s]);
            if uppercase_first && buf.text.as_bytes()[s].is_ascii_uppercase() {
                let mut cased = replacement.to_string();
                if let Some(first) = cased.get_mut(0..1) {
                    first.make_ascii_uppercase();
                }
                out_text.push_str(&cased);
            } else {
                out_text.push_str(replacement);
            }
            out_shadow.extend(replacement.bytes().map(|b| b.to_ascii_lowercase()));
            pending = e;
            pos = e;
        }
        if let Some((mut out_text, mut out_shadow)) = out {
            out_text.push_str(&buf.text[pending..]);
            out_shadow.extend_from_slice(&buf.shadow[pending..]);
            buf.text = out_text;
            buf.shadow = out_shadow;
        }
    }

    /// Replaces case-sensitive literal occurrences of the finder's needle, with
    /// no word-boundary requirement. The finder must scan the original text, not
    /// the shadow, to preserve case sensitivity.
    fn replace_literal_phrase(
        buf: &mut ShadowedText,
        finder: &Finder<'_>,
        needle_len: usize,
        replacement: &str,
    ) {
        let mut pos = 0usize;
        let mut pending = 0usize;
        let mut out: Option<(String, Vec<u8>)> = None;
        while pos < buf.text.len() {
            let Some(off) = finder.find(&buf.text.as_bytes()[pos..]) else {
                break;
            };
            let s = pos + off;
            let e = s + needle_len;
            let (out_text, out_shadow) = out.get_or_insert_with(|| {
                (
                    String::with_capacity(buf.text.len()),
                    Vec::with_capacity(buf.text.len()),
                )
            });
            out_text.push_str(&buf.text[pending..s]);
            out_shadow.extend_from_slice(&buf.shadow[pending..s]);
            out_text.push_str(replacement);
            out_shadow.extend(replacement.bytes().map(|b| b.to_ascii_lowercase()));
            pending = e;
            pos = e;
        }
        if let Some((mut out_text, mut out_shadow)) = out {
            out_text.push_str(&buf.text[pending..]);
            out_shadow.extend_from_slice(&buf.shadow[pending..]);
            buf.text = out_text;
            buf.shadow = out_shadow;
        }
    }

    /// Counts whole-word occurrences, stopping at `limit`. The only caller
    /// compares the count against 3, so counting past the limit is wasted work.
    fn count_word_occurrences(
        buf: &ShadowedText,
        finder: &Finder<'_>,
        needle_len: usize,
        limit: usize,
    ) -> usize {
        let mut pos = 0usize;
        let mut count = 0usize;
        while pos < buf.shadow.len() {
            let Some(off) = finder.find(&buf.shadow[pos..]) else {
                break;
            };
            let s = pos + off;
            let e = s + needle_len;
            let before_ok = s == 0 || !is_word_byte(buf.shadow[s - 1]);
            let after_ok = e >= buf.shadow.len() || !is_word_byte(buf.shadow[e]);
            if before_ok && after_ok {
                count += 1;
                if count >= limit {
                    return count;
                }
                pos = e;
            } else {
                pos = s + 1;
            }
        }
        count
    }

    fn shortening_finders() -> &'static [Finder<'static>] {
        static F: OnceLock<Vec<Finder<'static>>> = OnceLock::new();
        F.get_or_init(|| {
            PHRASE_SHORTENINGS
                .iter()
                .map(|(phrase, _)| Finder::new(phrase.as_bytes()))
                .collect()
        })
    }

    fn connective_finders() -> &'static [Finder<'static>] {
        static F: OnceLock<Vec<Finder<'static>>> = OnceLock::new();
        F.get_or_init(|| {
            ULTRA_CONNECTIVE_REPLACEMENTS
                .iter()
                .map(|(phrase, _)| Finder::new(phrase.as_bytes()))
                .collect()
        })
    }

    fn abbreviation_finders() -> &'static [Finder<'static>] {
        static F: OnceLock<Vec<Finder<'static>>> = OnceLock::new();
        F.get_or_init(|| {
            ULTRA_ABBREVIATIONS
                .iter()
                .map(|(term, _)| Finder::new(term.as_bytes()))
                .collect()
        })
    }

    fn apply_phrase_shortenings(buf: &mut ShadowedText) {
        for (i, (phrase, replacement)) in PHRASE_SHORTENINGS.iter().enumerate() {
            replace_word_phrase(
                buf,
                &shortening_finders()[i],
                phrase.len(),
                replacement,
                false,
            );
        }
    }

    fn apply_ultra_connectives(buf: &mut ShadowedText) {
        for (i, (phrase, replacement)) in ULTRA_CONNECTIVE_REPLACEMENTS.iter().enumerate() {
            if phrase.starts_with(' ') && phrase.ends_with(' ') {
                replace_literal_phrase(buf, &connective_finders()[i], phrase.len(), replacement);
            } else {
                replace_word_phrase(
                    buf,
                    &connective_finders()[i],
                    phrase.len(),
                    replacement,
                    false,
                );
            }
        }
    }

    fn apply_ultra_abbreviations(buf: &mut ShadowedText) {
        for (i, (term, abbreviation)) in ULTRA_ABBREVIATIONS.iter().enumerate() {
            if count_word_occurrences(buf, &abbreviation_finders()[i], term.len(), 3) < 3 {
                continue;
            }
            replace_word_phrase(
                buf,
                &abbreviation_finders()[i],
                term.len(),
                abbreviation,
                true,
            );
        }
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
        let regex =
            IDENTIFIER.get_or_init(|| Regex::new(r"(?:msg|ses|toolu)_[A-Za-z0-9]+").unwrap());
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

    fn placeholder_marker_finder() -> &'static Finder<'static> {
        static F: OnceLock<Finder<'static>> = OnceLock::new();
        F.get_or_init(|| Finder::new(b"\0MC_PRES_"))
    }

    const PLACEHOLDER_MARKER_LEN: usize = "\u{0}MC_PRES_".len();

    /// Restores preserved regions in one left-to-right scan with recursive
    /// expansion of nested placeholders.
    ///
    /// Region `i`'s captured original can only embed placeholders with index
    /// less than `i`: later regions did not exist when `i` was captured, and
    /// matches within one protect pass never overlap. `max_idx` enforces that
    /// bound, so recursion strictly decreases and terminates. Text that merely
    /// resembles a placeholder — an out-of-bound index, malformed digits, or any
    /// byte mismatch against the canonical placeholder string — stays literal.
    fn restore_regions(text: &str, preserved: &[PreservedRegion]) -> String {
        if preserved.is_empty() {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len());
        restore_into(text, preserved, preserved.len(), &mut out);
        out
    }

    fn restore_into(text: &str, preserved: &[PreservedRegion], max_idx: usize, out: &mut String) {
        let bytes = text.as_bytes();
        let mut pos = 0usize;
        let mut pending = 0usize;
        while pos < bytes.len() {
            let Some(off) = placeholder_marker_finder().find(&bytes[pos..]) else {
                break;
            };
            let s = pos + off;
            let digits_start = s + PLACEHOLDER_MARKER_LEN;
            let mut j = digits_start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j == digits_start || j >= bytes.len() || bytes[j] != 0 {
                pos = s + 1;
                continue;
            }
            let idx: usize = std::str::from_utf8(&bytes[digits_start..j])
                .expect("digits are ascii")
                .parse()
                .unwrap_or(usize::MAX);
            let end = j + 1;
            if idx < max_idx && preserved[idx].placeholder.as_bytes() == &bytes[s..end] {
                out.push_str(&text[pending..s]);
                restore_into(&preserved[idx].original, preserved, idx, out);
                pending = end;
                pos = end;
            } else {
                pos = s + 1;
            }
        }
        out.push_str(&text[pending..]);
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
                        while end < text.len()
                            && next_char(text, end).is_some_and(char::is_whitespace)
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

    /// `AUXILIARIES` ordered longest-first, so multi-word forms ("has been") win
    /// over their embedded single words ("been") at the same position.
    fn sorted_auxiliaries() -> &'static [&'static str] {
        static SORTED: OnceLock<Vec<&'static str>> = OnceLock::new();
        SORTED.get_or_init(|| {
            let mut auxiliaries = AUXILIARIES.to_vec();
            auxiliaries.sort_by_key(|aux| std::cmp::Reverse(aux.len()));
            auxiliaries
        })
    }

    fn drop_auxiliaries(text: &str) -> String {
        let auxiliaries = sorted_auxiliaries();

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
                if aux_end >= text.len()
                    || !next_char(text, aux_end).is_some_and(char::is_whitespace)
                {
                    output.push_str(&text[cursor..aux_end]);
                    cursor = aux_end;
                    continue;
                }
                while aux_end < text.len()
                    && next_char(text, aux_end).is_some_and(char::is_whitespace)
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
        let joined = lines.join("\n");
        if !joined.contains("\n\n\n") {
            return joined;
        }
        // Cap every newline run at two, the fixpoint of "\n\n\n" -> "\n\n".
        let mut output = String::with_capacity(joined.len());
        let mut run = 0usize;
        for ch in joined.chars() {
            if ch == '\n' {
                run += 1;
                if run > 2 {
                    continue;
                }
            } else {
                run = 0;
            }
            output.push(ch);
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
            let a = drop_phrases(chunk, filler_automaton());
            let b = drop_phrases(&a, hedging_automaton());
            let c = drop_phrases(&b, pleasantries_automaton());

            let mut buf = ShadowedText::new(c.into_owned());
            apply_phrase_shortenings(&mut buf);
            if matches!(level, CavemanLevel::Full | CavemanLevel::Ultra) {
                let working = drop_auxiliaries(&buf.text);
                buf = ShadowedText::new(drop_articles(&working));
            }
            if level == CavemanLevel::Ultra {
                apply_ultra_connectives(&mut buf);
                apply_ultra_abbreviations(&mut buf);
            }
            buf.text
        });
        normalize_whitespace(&restore_regions(&transformed, &preserved))
            .trim()
            .to_string()
    }
}

use mc_module::caveman::{compress, CavemanLevel};
use proptest::prelude::*;

fn levels() -> [(CavemanLevel, reference::CavemanLevel); 3] {
    [
        (CavemanLevel::Lite, reference::CavemanLevel::Lite),
        (CavemanLevel::Full, reference::CavemanLevel::Full),
        (CavemanLevel::Ultra, reference::CavemanLevel::Ultra),
    ]
}

fn fragment() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("I just really wanted to basically explain the implementation clearly".to_string()),
        Just(
            "i think it seems the results are being computed, and in order to understand"
                .to_string()
        ),
        Just("please review this, thanks, kind of a bit urgent".to_string()),
        Just(
            "the historian will be summarized because of the compartment context message"
                .to_string()
        ),
        Just(
            "was were is are am be been being has been had been have been will be tested"
                .to_string()
        ),
        // `in order to` -> `to` creates `due to the fact that`, which a later pass turns
        // into `because`. A single-pass or reordered implementation stops at the first.
        Just("due in order to the fact that at this point in time it failed".to_string()),
        // Mixed-case phrase forms, matched ASCII-insensitively.
        Just("I JUST Really Basically wanted to Simply explain".to_string()),
        Just("I Think It Seems Maybe the results Are ok".to_string()),
        Just("Please review, Thanks, Kind Of A Bit urgent".to_string()),
        Just("In Order To understand At The Moment, Due To The Fact That".to_string()),
        Just("Was Were Has Been Have Been Will Be tested".to_string()),
        // Each term is repeated three times to trigger `ULTRA_ABBREVIATIONS`.
        Just("compression compression compression compressor compressor compressor".to_string(),),
        Just("compartments compartments compartments messages messages messages".to_string(),),
        Just("implemented implemented implemented".to_string()),
        Just("U: keep this user line untouched".to_string()),
        Just("`inline code with  spaces`".to_string()),
        Just("```rust\nfn nested() { let a = 1; }\n```".to_string()),
        // Protected regions contain removable phrases.
        Just("`fn f() { /* just really in order to */ }`".to_string()),
        Just(
            "```ts\n// i think just really in order to at the moment\nconst a = 1;\n```"
                .to_string()
        ),
        Just("https://example.com/really/long/path?query=1&flag".to_string()),
        Just("§7§ tag and msg_ABC123 plus deadbeefcafe1234 hash".to_string()),
        Just("src/some_dir/file_name.rs and ../rel/path.txt".to_string()),
        Just("   \t  ".to_string()),
        Just("\n\n\n\n".to_string()),
        Just("".to_string()),
        Just("ünïcödé √ text — with; emoji 🚀 and 中文".to_string()),
        Just("A an a THE The tHe words".to_string()),
        Just("configuration config repository database directory session".to_string()),
        Just("and then afterwards therefore however furthermore additionally".to_string()),
        Just("alpha as well as beta or gamma".to_string()),
        Just("\u{0}MC_PRES_0\u{0} literal placeholder collision".to_string()),
        Just("`fence with \u{0}MC_PRES_1\u{0} inside` and \u{0} stray NUL".to_string()),
        Just("https://url\u{0}MC_PRES_2\u{0}adjacent".to_string()),
        "[ -~]{0,40}".prop_map(|s| s),
        "\\PC{0,20}".prop_map(|s| s),
    ]
}

fn document() -> impl Strategy<Value = String> {
    (
        proptest::collection::vec(fragment(), 0..24),
        proptest::collection::vec(
            prop_oneof![
                Just(" "),
                Just("  "),
                Just("\n"),
                Just("\n\n"),
                Just("\n\n\n\n   \n"),
                Just(", "),
                Just(". "),
            ],
            0..24,
        ),
    )
        .prop_map(|(frags, seps)| {
            let mut doc = String::new();
            for (i, frag) in frags.iter().enumerate() {
                doc.push_str(frag);
                if let Some(sep) = seps.get(i) {
                    doc.push_str(sep);
                }
            }
            doc
        })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]
    #[test]
    fn optimized_matches_frozen_reference(doc in document()) {
        for (level, ref_level) in levels() {
            prop_assert_eq!(
                compress(&doc, level),
                reference::compress(&doc, ref_level),
                "level {:?} diverged on {:?}", level, doc
            );
        }
    }
}
