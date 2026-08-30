//! Rules run as a cascade: each rewrites the text its predecessors produced.
//! A later rule can match a replacement token and supersede an earlier span.
//! Arbitrating over original-input spans lets a lower-priority match block part of a real key.

use std::sync::LazyLock;

use regex::Regex;

pub const DETECTOR_ID: &str = "redaction-vocabulary-v1";

/// `Detection` records a redacted span in the original input.
///
/// `offset` and `length` are UTF-8 byte offsets into the input passed to [`redact_secret_text`].
/// Replacement tokens can differ in byte length from the secrets they cover.
/// JavaScript callers must convert these UTF-8 byte offsets to UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    pub detector_id: &'static str,
    pub secret_type: String,
    pub offset: usize,
    pub length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub text: String,
    pub detections: Vec<Detection>,
}

/// Character class matching JavaScript's non-`u` `\s`, which covers U+FEFF and omits U+0085.
const JS_SPACE: &str =
    r"\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// Secret-key names mark `name=value` and `"name": "value"` pairs for redaction.
///
/// The shared list keeps secret-name matching terms consistent across keyed rules.
const SECRET_WORDS: &str = "key|token|secret|password|auth|bearer|credential";

enum RuleKind {
    Fixed {
        secret_type: &'static str,
        replacement: &'static str,
    },
    /// Replaces the value in place, leaving the key, separator, and quotes.
    KeyedValue,
    /// Replaces `key <ws> = <ws> value` with `key=<token>`, dropping the surrounding whitespace.
    KeyedAssignment,
}

struct Rule {
    regexes: Vec<Regex>,
    kind: RuleKind,
}

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("redaction pattern is valid")
}

fn fixed(pattern: &str, secret_type: &'static str, replacement: &'static str) -> Rule {
    Rule {
        regexes: vec![compile(pattern)],
        kind: RuleKind::Fixed {
            secret_type,
            replacement,
        },
    }
}

fn keyed_value(patterns: &[String]) -> Rule {
    Rule {
        regexes: patterns.iter().map(|pattern| compile(pattern)).collect(),
        kind: RuleKind::KeyedValue,
    }
}

fn keyed_assignment(pattern: &str) -> Rule {
    Rule {
        regexes: vec![compile(pattern)],
        kind: RuleKind::KeyedAssignment,
    }
}

/// Ordered rules; an earlier rule claims a span before later ones see it.
///
/// `(?-u:\b)` and `(?i-u:…)` match JavaScript's ASCII word boundaries and non-`u` case folding.
static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let mut rules = vec![
        // `sk-ant-…` also satisfies the broader `sk-…` rule, so it runs first.
        fixed(
            r"(?-u:\b)sk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}",
            "anthropic_api_key",
            "<ANTHROPIC_API_KEY_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)sk-(?:proj-)?[A-Za-z0-9_-]{32,}",
            "openai_api_key",
            "<OPENAI_API_KEY_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)github_pat_[A-Za-z0-9_]{20,}",
            "github_pat",
            "<GITHUB_PAT_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}",
            "github_token",
            "<GITHUB_TOKEN_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)hf_[A-Za-z0-9]{30,}",
            "huggingface_token",
            "<HUGGINGFACE_TOKEN_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)(?:AKIA|ASIA)[0-9A-Z]{16}(?-u:\b)",
            "aws_access_key_id",
            "<AWS_ACCESS_KEY_ID_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)xox[abprsuvc]-[A-Za-z0-9-]{10,}",
            "slack_token",
            "<SLACK_TOKEN_REDACTED>",
        ),
        fixed(
            r"(?-u:\b)AIza[A-Za-z0-9_-]{35}(?-u:\b)",
            "google_api_key",
            "<GOOGLE_API_KEY_REDACTED>",
        ),
        // The named `value` group narrows replacement to the token, so the `Authorization: Bearer ` prefix stays readable.
        fixed(
            &format!(
                r"(?-u:\b)(?i-u:authorization)[{JS_SPACE}]*:[{JS_SPACE}]*(?i-u:bearer)[{JS_SPACE}]+(?P<value>[A-Za-z0-9._~+/=-]{{8,}})"
            ),
            "bearer",
            "<REDACTED:bearer>",
        ),
        fixed(
            r"(?-u:\b)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "jwt",
            "<JWT_REDACTED>",
        ),
    ];
    // `regex` rejects backreferences, so each quote pairing needs its own rule; enumerating the four leaves a mismatched `"key": 'value` unmatched.
    let quoted: Vec<String> = [("\"", "\""), ("'", "'"), ("\"", "'"), ("'", "\"")]
        .into_iter()
        .map(|(key_quote, value_quote)| {
            format!(
                r#"{key_quote}(?P<key>[^"']*(?i-u:{SECRET_WORDS})[^"']*){key_quote}[{JS_SPACE}]*:[{JS_SPACE}]*{value_quote}(?P<value>[^"']*){value_quote}"#
            )
        })
        .collect();
    rules.push(keyed_value(&quoted));
    rules.push(keyed_assignment(&format!(
        r#"(?-u:\b)(?P<key>[A-Za-z0-9_.-]*(?i-u:{SECRET_WORDS})[A-Za-z0-9_.-]*)[{JS_SPACE}]*=[{JS_SPACE}]*(?P<value>[^{JS_SPACE}'"`]+)"#
    )));
    rules
});

static SCALAR_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$")
        .expect("scalar diagnostic regex is valid")
});

static KEY_SEPARATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9_.-]+").expect("key separator regex is valid"));

/// A span of the working text: untouched input, or a replacement.
///
/// Both variants carry original-input byte offsets, so detections survive later rewrites.
/// Both variants carry original-input byte offsets, so detections survive later rewrites.
/// `detect_*` narrows to the secret itself when a rule rewrites more than the secret.
#[derive(Clone)]
enum Piece {
    Keep {
        start: usize,
        end: usize,
    },
    Redacted {
        start: usize,
        end: usize,
        detect_start: usize,
        detect_end: usize,
        secret_type: String,
        replacement: String,
    },
}

impl Piece {
    fn rendered_len(&self) -> usize {
        match self {
            Self::Keep { start, end } => end - start,
            Self::Redacted { replacement, .. } => replacement.len(),
        }
    }

    fn origin(&self) -> (usize, usize) {
        match self {
            Self::Keep { start, end } | Self::Redacted { start, end, .. } => (*start, *end),
        }
    }
}

struct Edit {
    start: usize,
    end: usize,
    detect_start: usize,
    detect_end: usize,
    secret_type: String,
    replacement: String,
}

// Scan all alternatives before applying edits so each match is selected from unmodified text.
fn scan(rule: &Rule, text: &str) -> Vec<Edit> {
    let mut edits = Vec::new();
    let mut position = 0;
    while position <= text.len() {
        let Some(captures) = rule
            .regexes
            .iter()
            .filter_map(|regex| regex.captures_at(text, position))
            .min_by_key(|captures| {
                captures
                    .get(0)
                    .expect("every capture has a whole match")
                    .start()
            })
        else {
            break;
        };
        let whole = captures.get(0).expect("every capture has a whole match");
        if let Some(edit) = build_edit(&rule.kind, &captures, whole) {
            edits.push(edit);
        }
        position = if whole.end() > whole.start() {
            whole.end()
        } else {
            whole.end() + 1
        };
    }
    edits
}

fn build_edit(
    kind: &RuleKind,
    captures: &regex::Captures<'_>,
    whole: regex::Match<'_>,
) -> Option<Edit> {
    match kind {
        RuleKind::Fixed {
            secret_type,
            replacement,
        } => {
            let span = captures.name("value").unwrap_or(whole);
            Some(Edit {
                start: span.start(),
                end: span.end(),
                detect_start: span.start(),
                detect_end: span.end(),
                secret_type: (*secret_type).to_owned(),
                replacement: (*replacement).to_owned(),
            })
        }
        RuleKind::KeyedValue | RuleKind::KeyedAssignment => {
            let key = captures.name("key").expect("keyed rule captures its key");
            let value = captures
                .name("value")
                .expect("keyed rule captures its value");
            if is_non_secret_scalar_value(value.as_str()) {
                return None;
            }
            let secret_type = redaction_type_for_key(key.as_str());
            let (start, end, replacement) = match kind {
                RuleKind::KeyedAssignment => (
                    whole.start(),
                    whole.end(),
                    format!("{}=<REDACTED:{secret_type}>", key.as_str()),
                ),
                _ => (
                    value.start(),
                    value.end(),
                    format!("<REDACTED:{secret_type}>"),
                ),
            };
            Some(Edit {
                start,
                end,
                detect_start: value.start(),
                detect_end: value.end(),
                secret_type,
                replacement,
            })
        }
    }
}

#[must_use]
pub fn redact_secret_text(input: &str) -> Redaction {
    let mut pieces = vec![Piece::Keep {
        start: 0,
        end: input.len(),
    }];

    for rule in RULES.iter() {
        let (text, starts) = render(input, &pieces);
        let edits = scan(rule, &text);
        if !edits.is_empty() {
            pieces = apply(input.len(), &pieces, &starts, edits);
        }
    }

    let mut text = String::with_capacity(input.len());
    let mut detections = Vec::new();
    for piece in &pieces {
        match piece {
            Piece::Keep { start, end } => text.push_str(&input[*start..*end]),
            Piece::Redacted {
                detect_start,
                detect_end,
                secret_type,
                replacement,
                ..
            } => {
                text.push_str(replacement);
                detections.push(Detection {
                    detector_id: DETECTOR_ID,
                    secret_type: secret_type.clone(),
                    offset: *detect_start,
                    length: detect_end - detect_start,
                });
            }
        }
    }

    Redaction { text, detections }
}

fn render(input: &str, pieces: &[Piece]) -> (String, Vec<usize>) {
    let mut text = String::with_capacity(input.len());
    let mut starts = Vec::with_capacity(pieces.len());
    for piece in pieces {
        starts.push(text.len());
        match piece {
            Piece::Keep { start, end } => text.push_str(&input[*start..*end]),
            Piece::Redacted { replacement, .. } => text.push_str(replacement),
        }
    }
    (text, starts)
}

struct Span {
    start: usize,
    end: usize,
    detect_start: usize,
    detect_end: usize,
    secret_type: String,
    replacement: String,
}

/// Rebuild `pieces` in original coordinates so each edit becomes one redacted span.
///
/// An edit touching a replacement swallows it whole, because a replacement token has no interior offsets mapping back to the original input.
/// Swallowing replacements makes later matches report the union of both spans and keeps spans disjoint when one rule matches several times in one piece.
fn apply(input_len: usize, pieces: &[Piece], starts: &[usize], edits: Vec<Edit>) -> Vec<Piece> {
    let mut spans: Vec<Span> = edits
        .into_iter()
        .map(|edit| {
            let start = map_start(starts, pieces, edit.start);
            let end = if edit.end > edit.start {
                map_end(starts, pieces, edit.end)
            } else {
                start
            };
            let detect_start = map_start(starts, pieces, edit.detect_start);
            let detect_end = if edit.detect_end > edit.detect_start {
                map_end(starts, pieces, edit.detect_end)
            } else {
                detect_start
            };
            Span {
                start,
                end,
                detect_start,
                detect_end,
                secret_type: edit.secret_type,
                replacement: edit.replacement,
            }
        })
        .collect();

    for piece in pieces {
        if let Piece::Redacted {
            start,
            end,
            detect_start,
            detect_end,
            secret_type,
            replacement,
        } = piece
        {
            let superseded = spans
                .iter()
                .any(|span| span.start < *end && *start < span.end);
            if !superseded {
                spans.push(Span {
                    start: *start,
                    end: *end,
                    detect_start: *detect_start,
                    detect_end: *detect_end,
                    secret_type: secret_type.clone(),
                    replacement: replacement.clone(),
                });
            }
        }
    }

    spans.sort_by_key(|span| (span.start, span.end));

    let mut out: Vec<Piece> = Vec::with_capacity(spans.len() * 2 + 1);
    let mut cursor = 0;
    for span in spans {
        if span.start < cursor {
            continue;
        }
        if span.start > cursor {
            out.push(Piece::Keep {
                start: cursor,
                end: span.start,
            });
        }
        out.push(Piece::Redacted {
            start: span.start,
            end: span.end,
            detect_start: span.detect_start,
            detect_end: span.detect_end,
            secret_type: span.secret_type,
            replacement: span.replacement,
        });
        cursor = span.end;
    }
    if cursor < input_len {
        out.push(Piece::Keep {
            start: cursor,
            end: input_len,
        });
    }
    out
}

fn map_start(starts: &[usize], pieces: &[Piece], position: usize) -> usize {
    match piece_at(starts, pieces, position) {
        Some(index) => match &pieces[index] {
            Piece::Keep { start, .. } => start + (position - starts[index]),
            Piece::Redacted { start, .. } => *start,
        },
        None => pieces.last().map_or(0, |piece| piece.origin().1),
    }
}

fn map_end(starts: &[usize], pieces: &[Piece], position: usize) -> usize {
    match piece_at(starts, pieces, position - 1) {
        Some(index) => match &pieces[index] {
            Piece::Keep { start, .. } => start + (position - starts[index]),
            Piece::Redacted { end, .. } => *end,
        },
        None => pieces.last().map_or(0, |piece| piece.origin().1),
    }
}

fn piece_at(starts: &[usize], pieces: &[Piece], position: usize) -> Option<usize> {
    pieces
        .iter()
        .enumerate()
        .find(|(index, piece)| {
            position >= starts[*index] && position < starts[*index] + piece.rendered_len()
        })
        .map(|(index, _)| index)
}

/// Same set as [`JS_SPACE`], for trimming; `str::trim` would use Unicode rules instead.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// A bare number, boolean, or null is never a credential.
///
/// A keyed rule can match because the KEY holds a word like `token` while the VALUE is a count or flag, as in `tokens.input=45000`.
/// Value-shaped rules still catch high-entropy secrets regardless of key name.
/// The exemption costs coverage: `password=123456` survives.
fn is_non_secret_scalar_value(value: &str) -> bool {
    let value = value.trim_matches(is_js_space);
    matches!(value, "true" | "false" | "null" | "undefined") || SCALAR_VALUE.is_match(value)
}

fn redaction_type_for_key(key: &str) -> String {
    let lowered = key.trim().to_lowercase();
    let normalized = KEY_SEPARATOR.replace_all(&lowered, "_");
    normalized
        .split('.')
        .rfind(|part| !part.is_empty())
        .unwrap_or("secret")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Vocabulary {
        schema: String,
        cases: Vec<FixtureCase>,
        exemptions: Vec<String>,
        known_misses: Vec<String>,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        name: String,
        input: String,
        expected_redacted: String,
        detections: Vec<FixtureDetection>,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct FixtureDetection {
        secret_type: String,
        offset: usize,
        length: usize,
    }

    fn vocabulary() -> Vocabulary {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/shared/fixtures/redaction-vocabulary-v1.json"
        ))
        .expect("shared redaction fixture is valid")
    }

    #[test]
    fn shared_vocabulary_matches() {
        let vocabulary = vocabulary();
        assert_eq!(vocabulary.schema, "magic-context.redaction-vocabulary/v1");

        for fixture in vocabulary.cases {
            let result = redact_secret_text(&fixture.input);
            assert_eq!(result.text, fixture.expected_redacted, "{}", fixture.name);
            let actual: Vec<_> = result
                .detections
                .iter()
                .map(|detection| FixtureDetection {
                    secret_type: detection.secret_type.clone(),
                    offset: detection.offset,
                    length: detection.length,
                })
                .collect();
            assert_eq!(actual, fixture.detections, "{}", fixture.name);
            assert!(result
                .detections
                .iter()
                .all(|detection| detection.detector_id == DETECTOR_ID));
        }
    }

    #[test]
    fn scalar_exemptions_and_known_misses_remain_unchanged() {
        let vocabulary = vocabulary();
        for input in vocabulary
            .exemptions
            .into_iter()
            .chain(vocabulary.known_misses)
        {
            assert_eq!(redact_secret_text(&input).text, input);
        }
    }

    #[test]
    fn detection_spans_address_the_original_input() {
        for fixture in vocabulary().cases {
            let result = redact_secret_text(&fixture.input);
            for detection in &result.detections {
                let end = detection.offset + detection.length;
                assert!(end <= fixture.input.len(), "{}", fixture.name);
                assert!(
                    fixture.input.is_char_boundary(detection.offset)
                        && fixture.input.is_char_boundary(end),
                    "{} span is not on a char boundary",
                    fixture.name
                );
            }
            for pair in result.detections.windows(2) {
                assert!(
                    pair[0].offset + pair[0].length <= pair[1].offset,
                    "{} detections overlap",
                    fixture.name
                );
            }
        }
    }

    #[test]
    fn overlapping_rules_never_leave_a_secret_fragment() {
        let payload = "B".repeat(40);
        let input = format!("AIza{}-sk-{payload}", "A".repeat(31));
        let result = redact_secret_text(&input);
        assert!(
            !result.text.contains(&payload),
            "leaked key payload: {}",
            result.text
        );
        assert_eq!(result.detections.len(), 1);
        assert_eq!(result.detections[0].secret_type, "openai_api_key");
    }

    #[test]
    fn cascade_lets_a_keyed_rule_supersede_a_value_rule() {
        let result = redact_secret_text("api_key=sk-proj-IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII");
        assert_eq!(result.text, "api_key=<REDACTED:api_key>");
        assert_eq!(result.detections[0].secret_type, "api_key");
    }

    #[test]
    fn word_boundaries_use_ascii_semantics() {
        let key = format!("sk-{}", "A".repeat(32));
        assert_eq!(
            redact_secret_text(&format!("é{key}")).text,
            "é<OPENAI_API_KEY_REDACTED>"
        );
        let embedded = format!("x{key}");
        assert_eq!(redact_secret_text(&embedded).text, embedded);
    }

    #[test]
    fn case_folding_uses_ascii_semantics() {
        assert_eq!(
            redact_secret_text("API_KEY=abcdefghijklmnop").text,
            "API_KEY=<REDACTED:api_key>"
        );
        let kelvin = "\u{212a}ey=abcdefghijklmnop";
        assert_eq!(redact_secret_text(kelvin).text, kelvin);
    }

    #[test]
    fn assignment_normalizes_whitespace_but_reports_only_the_value() {
        let result = redact_secret_text("secret = spaced-value");
        assert_eq!(result.text, "secret=<REDACTED:secret>");
        assert_eq!(result.detections[0].offset, 9);
        assert_eq!(result.detections[0].length, "spaced-value".len());
    }

    #[test]
    fn js_space_class_and_predicate_agree() {
        let class = Regex::new(&format!("^[{JS_SPACE}]$")).expect("class compiles");
        for code in (0..=0x3100u32).chain([0xfeff]) {
            let Some(character) = char::from_u32(code) else {
                continue;
            };
            assert_eq!(
                class.is_match(&character.to_string()),
                is_js_space(character),
                "disagreement on U+{code:04X}"
            );
        }
    }

    #[test]
    fn scalar_exemption_uses_ascii_digits_and_javascript_trimming() {
        // Arabic-Indic digits are not an exempt scalar, so the value stays redacted.
        assert_eq!(
            redact_secret_text("api_key=\u{664}\u{669}\u{660}\u{666}").text,
            "api_key=<REDACTED:api_key>"
        );
        // U+FEFF is whitespace to JavaScript, so trimming leaves an exempt count.
        assert_eq!(
            redact_secret_text("\"api_key\": \"4096\u{feff}\"").text,
            "\"api_key\": \"4096\u{feff}\""
        );
        // U+0085 is not whitespace to JavaScript, so the value is not a bare number.
        assert_eq!(
            redact_secret_text("\"api_key\": \"4096\u{85}\"").text,
            "\"api_key\": \"<REDACTED:api_key>\""
        );
    }

    #[test]
    fn separators_accept_javascript_whitespace() {
        assert_eq!(
            redact_secret_text("Authorization:\u{feff}Bearer abcdef123456").text,
            "Authorization:\u{feff}Bearer <REDACTED:bearer>"
        );
        assert_eq!(
            redact_secret_text("secret\u{feff}=\u{feff}value1234").text,
            "secret=<REDACTED:secret>"
        );
    }

    #[test]
    fn every_rule_compiles() {
        assert_eq!(RULES.len(), 12);
    }
}
