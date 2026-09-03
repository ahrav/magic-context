//! Pins replacement spelling, overlap precedence, UTF-8 byte spans, label
//! bounds, input limits, and placeholder suppression for durable redaction.
//! Every reported span must fall on a character boundary in the original text.

use std::sync::OnceLock;

use mc_core::redaction::{
    detect_windowed_durable_bytes, detect_windowed_durable_text, redact_durable_text,
    redact_windowed_durable_text, RedactionErrorKind, Redactor, DETECTOR_ID, EDGE_MARGIN_BYTES,
    MAX_REDACTION_LABEL_BYTES, WINDOW_OVERLAP_BYTES,
};
use proptest::prelude::*;

fn redactor() -> &'static Redactor {
    static REDACTOR: OnceLock<Redactor> = OnceLock::new();
    REDACTOR.get_or_init(|| Redactor::new().unwrap())
}

#[test]
fn established_replacement_spelling_remains_stable() {
    assert_eq!(
        redact_durable_text("Authorization: Bearer abc123def456ghi789").text,
        "Authorization: Bearer <REDACTED:bearer>"
    );
    for (input, expected) in [
        (
            "x_auth_token=hunter-two",
            "x_auth_token=<REDACTED:x_auth_token>",
        ),
        (
            "client_secret=hunter-two",
            "client_secret=<REDACTED:client_secret>",
        ),
        ("aws_secret=hunter-two", "aws_secret=<REDACTED:aws_secret>"),
    ] {
        assert_eq!(redact_durable_text(input).text, expected, "{input}");
    }
}

#[test]
fn portable_scanner_is_authoritative() {
    let input =
        "provider AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";
    let redaction = redact_durable_text(input);
    assert_eq!(redaction.text, "provider <REDACTED:secret>");
    assert!(redaction
        .detections
        .iter()
        .all(|detection| detection.detector_id == DETECTOR_ID));
}

#[test]
fn concatenated_secret_keys_remain_redacted() {
    for input in [
        "apikey=hunter-two",
        "authtoken=hunter-two",
        r#"{"apikeys":"hunter-two"}"#,
    ] {
        let redaction = redact_durable_text(input);
        assert!(!redaction.detections.is_empty(), "{input}");
        assert!(!redaction.text.contains("hunter-two"), "{input}");
    }
}

#[test]
fn scalar_values_remain_visible() {
    for input in [
        "tokens.input=45000",
        "hasUsageTokens=true",
        "max_tokens=4096",
        r#"{"max_tokens":"4096"}"#,
    ] {
        assert_eq!(redact_durable_text(input).text, input);
    }
}

#[test]
fn oversized_input_is_rejected_by_direct_scans() {
    let input = "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES + 1);
    assert_eq!(
        redactor().redact(&input).unwrap_err().kind(),
        RedactionErrorKind::InputLimit
    );
}

#[test]
fn dense_maximum_input_succeeds() {
    let mut input = "password=x ".repeat(mc_secret_scanner::MAX_INPUT_BYTES / 11 + 1);
    input.truncate(mc_secret_scanner::MAX_INPUT_BYTES);
    let redaction = redactor().redact(&input).unwrap();
    assert!(!redaction.detections.is_empty());
}

/// An AWS access key ID with a shape the corpus rule accepts and no safelisted word.
const AWS_KEY: &str = "AKIAQYLPMN5HGZ3ABCDE";
const AGE_KEY: &str = "AGE-SECRET-KEY-1QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE";

#[test]
fn overlapping_findings_collapse_to_one_placeholder_over_their_union() {
    // A keyed value class admits `-`, so the keyed span reaches past the provider or
    // upstream shape nested inside it. Replacing per finding would emit a second
    // placeholder for the trailing bytes and leave them described as their own secret.
    for (input, expected, secret_type) in [
        (
            format!("token={AWS_KEY}-prod"),
            "token=<REDACTED:token>",
            "token",
        ),
        (
            format!("password={AGE_KEY}-prod"),
            "password=<REDACTED:password>",
            "password",
        ),
    ] {
        let redaction = redact_durable_text(&input);
        assert_eq!(redaction.text, expected, "{input}");
        assert_eq!(redaction.detections.len(), 1, "{input}");
        let detection = &redaction.detections[0];
        assert_eq!(detection.secret_type, secret_type, "{input}");
        // The detection covers the whole redacted region, so a consumer reading it
        // back against the pre-redaction text sees the bytes that were replaced.
        let value_start = input.find('=').unwrap() + 1;
        assert_eq!(detection.offset, value_start, "{input}");
        assert_eq!(detection.length, input.len() - value_start, "{input}");
        assert!(!redaction.text.contains("-prod"), "{input}");
    }
}

#[test]
fn a_key_name_supersedes_a_value_shape_on_the_same_span() {
    // The key name states the operator's intent for the value, so it outranks a
    // provider shape that matches the same bytes. Without a declared precedence the
    // winner would follow incidental finding order and flip on a regex edit.
    let redaction = redact_durable_text(&format!("token={AWS_KEY}"));
    assert_eq!(redaction.text, "token=<REDACTED:token>");
    assert_eq!(redaction.detections.len(), 1);
    assert_eq!(redaction.detections[0].secret_type, "token");
}

#[test]
fn a_value_shape_keeps_its_own_label_without_a_key_name() {
    for (input, expected, secret_type) in [
        (AWS_KEY, "<AWS_ACCESS_KEY_ID_REDACTED>", "aws_access_key_id"),
        (AGE_KEY, "<REDACTED:secret>", "secret"),
    ] {
        let redaction = redact_durable_text(input);
        assert_eq!(redaction.text, expected, "{input}");
        assert_eq!(redaction.detections.len(), 1, "{input}");
        assert_eq!(redaction.detections[0].secret_type, secret_type, "{input}");
    }
}

#[test]
fn only_the_value_span_is_replaced_around_an_assignment() {
    // The engine this replaces rewrote `key <ws> = <ws> value` as `key=<REDACTED:…>`,
    // collapsing the spacing because it replaced its whole match. Replacing only the
    // value span leaves the surrounding bytes, which are not secret, so the redacted
    // text is a minimal edit of the input rather than a reformatting of it. Pinned
    // here because the spelling of redacted text is a contract for anything that
    // parses or compares it.
    let redaction = redact_durable_text("secret = spaced-value");
    assert_eq!(redaction.text, "secret = <REDACTED:secret>");
    assert_eq!(redaction.detections.len(), 1);
    assert_eq!(redaction.detections[0].offset, 9);
    assert_eq!(redaction.detections[0].length, "spaced-value".len());
}

#[test]
fn a_structural_delimiter_ends_an_unquoted_value_and_quoting_covers_the_rest() {
    // An unquoted value ends at a shell delimiter. Accepting one as content would make a
    // trailing command or comment part of the candidate, and a suppressor word inside
    // that trailing text discards the whole finding, leaving the credential in place.
    // A credential holding a delimiter has to be quoted, and the quoted rules take it
    // whole, so this is where the two shapes divide rather than a gap in coverage.
    for delimiter in ['$', ';', '&', '|', '<', '>', '(', ')'] {
        let bare = format!("password=alpha{delimiter}bravo");
        let redaction = redact_durable_text(&bare);
        assert!(!redaction.detections.is_empty(), "{bare}");
        assert!(!redaction.text.contains("alpha"), "{bare}");

        let quoted = format!("password=\"alpha{delimiter}bravo\"");
        let redaction = redact_durable_text(&quoted);
        assert_eq!(
            redaction.text, "password=\"<REDACTED:password>\"",
            "{quoted}"
        );
    }
}

#[test]
fn trailing_text_cannot_suppress_a_credential() {
    // Suppressor words mark a placeholder value. If the candidate reached past the
    // value into a following command or comment, a suppressor word there would discard
    // the finding and publish the credential, which is worse than the truncation that
    // accepting the delimiter as content would have avoided.
    for suffix in [
        ";TODO",
        "|example",
        "&changeme",
        ";# placeholder",
        "|redacted",
    ] {
        let input = format!("password=alpha-bravo{suffix}");
        let redaction = redact_durable_text(&input);
        assert!(
            !redaction.text.contains("alpha-bravo"),
            "{input} published the credential as {:?}",
            redaction.text
        );
    }

    // A value that really is a placeholder is still suppressed.
    for input in [
        "password=changeme",
        "password=${SECRET}",
        "password=your-key-here",
    ] {
        assert_eq!(redact_durable_text(input).text, input, "{input}");
    }
}

#[test]
fn non_ascii_whitespace_around_a_separator_still_redacts() {
    // The scanner matches bytes with Unicode mode off, so `\s` covers only ASCII. A key
    // separated from its value by one of these would not match any rule, and an input
    // that matches nothing is returned unchanged, so the credential would survive.
    for separator in [
        '\u{a0}', '\u{1680}', '\u{2000}', '\u{2005}', '\u{200a}', '\u{2028}', '\u{2029}',
        '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ] {
        for input in [
            format!("password{separator}={separator}production-value"),
            format!("password{separator}=production-value"),
            format!(r#"{{"api_key"{separator}:{separator}"production-value"}}"#),
            format!("Authorization{separator}:{separator}Bearer{separator}abc123def456ghi789"),
        ] {
            let redaction = redact_durable_text(&input);
            assert!(
                !redaction.text.contains("production-value")
                    && !redaction.text.contains("abc123def456ghi789"),
                "U+{:04X} left the credential in {:?}",
                separator as u32,
                redaction.text
            );
        }
    }
}

#[test]
fn a_value_ends_at_the_same_whitespace_that_separates_it() {
    // A code point treated as a separator before the value must also end the value.
    // Accepting it as content makes the span run past the credential and replace the
    // text that follows, which is how an ASCII space and U+00A0 came to disagree.
    for separator in [
        '\u{a0}', '\u{1680}', '\u{2000}', '\u{2028}', '\u{202f}', '\u{3000}',
    ] {
        let input = format!("password=abc{separator}next");
        let redaction = redact_durable_text(&input);
        assert!(
            redaction.text.ends_with("next"),
            "U+{:04X} consumed the text after the value: {:?}",
            separator as u32,
            redaction.text
        );
        assert!(!redaction.text.contains("abc"), "{input}");
    }
    assert_eq!(
        redact_durable_text("password=abc next").text,
        "password=<REDACTED:password> next"
    );

    // U+0085 is Unicode `White_Space` but not whitespace to JavaScript, so it is content
    // here. Reading the Unicode set instead of the declared one would end the value at it
    // and publish the rest of the credential.
    assert_eq!(
        redact_durable_text("password=alpha\u{85}bravo").text,
        "password=<REDACTED:password>"
    );
}

#[test]
fn a_key_preceded_by_a_non_ascii_word_character_keeps_its_label() {
    // The leading word boundary is ASCII-only. A Unicode boundary does not hold between
    // a non-ASCII word character and the key name, so the key would go unrecognised and
    // the value would fall back to whatever less specific rule also matched it.
    for prefix in ['\u{3c0}', '\u{4e2d}', '\u{43f}', '\u{e9}'] {
        let input = format!("{prefix}password=production-value");
        let redaction = redact_durable_text(&input);
        assert_eq!(
            redaction.detections.first().map(|d| d.secret_type.as_str()),
            Some("password"),
            "{input} produced {:?}",
            redaction.text
        );
    }
}

#[test]
fn a_value_keeps_non_whitespace_characters_beyond_ascii() {
    // Ending a value at every multi-byte code point would truncate any credential
    // holding one, so only the whitespace set may end it.
    for value in [
        "abc\u{4e2d}\u{6587}",
        "abc\u{e9}def",
        "\u{5bc6}\u{7801}-1234",
    ] {
        let input = format!("password={value}");
        let redaction = redact_durable_text(&input);
        assert_eq!(redaction.text, "password=<REDACTED:password>", "{input}");
        assert_eq!(redaction.detections[0].length, value.len(), "{input}");
    }
}

#[test]
fn documentation_wording_near_a_credential_does_not_excuse_it() {
    // The safelist window spans 256 bytes, so a pattern matching only the mood of
    // the surrounding prose clears a live credential that merely sits near it.
    let secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
    for prose in [
        "for example: ",
        "sample config\n",
        "example config\n",
        "fixtures/live.env\n",
        "__tests__/live.env\n",
        "mocks/live.env\n",
    ] {
        let input = format!("{prose}{secret}");
        let redaction = redact_durable_text(&input);
        assert!(
            !redaction.text.contains(secret),
            "{input:?} produced {:?}",
            redaction.text
        );
    }
}

#[test]
fn a_placeholder_value_stays_unredacted_next_to_its_own_label() {
    // The value safelist, not the prose patterns above, is what keeps these quiet,
    // so removing a prose pattern must not start redacting them.
    for input in [
        "AKIAIOSFODNN7EXAMPLE",
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
        "password = ${DB_PASSWORD}",
        "example_key = ${DB_PASSWORD}",
        "api_token: changeme",
        "sha256 = abcdef0123456789abcdef0123456789",
    ] {
        let redaction = redact_durable_text(input);
        assert_eq!(
            redaction.text, input,
            "{input} produced {:?}",
            redaction.text
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn arbitrary_utf8_with_real_secret_has_valid_spans(
        prefix in ".{0,128}",
        suffix in ".{0,128}",
    ) {
        let input = format!("{prefix}\npassword=property-secret\n{suffix}");
        let redaction = redactor().redact(&input).unwrap();
        prop_assert!(!redaction.detections.is_empty());
        // Valid spans alone would also hold for an engine that reported the secret and
        // then emitted it verbatim, so assert the replacement actually happened.
        prop_assert!(redaction.text.contains("<REDACTED:password>"));
        prop_assert!(!redaction.text.contains("password=property-secret"));
        for detection in redaction.detections {
            let end = detection.offset + detection.length;
            prop_assert!(end <= input.len());
            prop_assert!(input.is_char_boundary(detection.offset));
            prop_assert!(input.is_char_boundary(end));
            prop_assert!(!detection.secret_type.is_empty());
        }
    }
}

/// A key name is captured out of untrusted text and has no length bound, so the label
/// derived from it must stay inside the ceiling a store's label column enforces.
#[test]
fn labels_stay_bounded_for_key_names_built_from_many_label_words() {
    for key in [
        "x_api_access_private_client_session_refresh_service_openai_anthropic_key",
        "secret_secret_secret_secret_secret_secret_secret_secret_secret_secret_secret",
        "authorization_authorization_authorization_authorization_authorization",
        "aws_secret_access_key",
    ] {
        let redaction = redact_durable_text(&format!("{key}=Ax7Ke9QpZr2mLw8T"));
        assert!(
            !redaction.detections.is_empty(),
            "expected a keyed detection for {key}"
        );
        for detection in &redaction.detections {
            assert!(
                !detection.secret_type.is_empty()
                    && detection.secret_type.len() <= MAX_REDACTION_LABEL_BYTES,
                "label {:?} for {key} is {} bytes, outside 1..={MAX_REDACTION_LABEL_BYTES}",
                detection.secret_type,
                detection.secret_type.len()
            );
            assert!(
                detection
                    .secret_type
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'),
                "label {:?} for {key} leaves the bounded shape",
                detection.secret_type
            );
        }
    }
}

/// Filler whose lines carry no secret vocabulary, sized so `target_offset`
/// falls at the start of a line, then `line` inserted there.
fn text_with_line_at(target_offset: usize, line: &str, total: usize) -> (String, usize) {
    const FILLER: &str = "plain filler line without any credential words 0123\n";
    let mut text = String::with_capacity(total + line.len() + FILLER.len());
    while text.len() + FILLER.len() <= target_offset {
        text.push_str(FILLER);
    }
    let offset = text.len();
    text.push_str(line);
    text.push('\n');
    while text.len() < total {
        text.push_str(FILLER);
    }
    (text, offset)
}

fn assert_single_windowed_detection(text: &str, secret_line: &str, line_offset: usize) {
    let redaction = redact_windowed_durable_text(text, usize::MAX).unwrap();
    assert_eq!(redaction.detections.len(), 1, "{:?}", redaction.detections);
    let value_start = line_offset + secret_line.find('=').unwrap() + 1;
    assert_eq!(redaction.detections[0].offset, value_start);
    assert_eq!(
        redaction.detections[0].length,
        secret_line.len() - secret_line.find('=').unwrap() - 1
    );
    assert!(!redaction.text.contains(AWS_KEY));
    assert!(redaction.text.contains("<REDACTED:token>"));
    // Everything outside the placeholder is unchanged.
    assert_eq!(
        redaction.text.len(),
        text.len() - AWS_KEY.len() + "<REDACTED:token>".len()
    );
}

#[test]
fn windowed_redaction_matches_direct_redaction_below_the_scan_limit() {
    let input = format!("token={AWS_KEY} and password=hunter-two");
    assert_eq!(
        redact_windowed_durable_text(&input, usize::MAX).unwrap(),
        redact_durable_text(&input)
    );
}

#[test]
fn windowed_redaction_reports_a_secret_in_the_overlap_once() {
    let secret_line = format!("token={AWS_KEY}");
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // The second window starts at a line boundary at or before `window -
    // overlap`, so a line just past that point is scanned by both windows.
    let (text, offset) = text_with_line_at(
        window - WINDOW_OVERLAP_BYTES + 4096,
        &secret_line,
        window + window / 2,
    );
    assert!(text.len() > window);
    assert_single_windowed_detection(&text, &secret_line, offset);
}

#[test]
fn windowed_redaction_redacts_a_secret_the_first_window_cuts_in_half() {
    let secret_line = format!("token={AWS_KEY}");
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // The first window ends exactly at `window`, inside the secret value; the
    // second window begins on an earlier line boundary and sees the whole line.
    let (text, offset) = text_with_line_at(
        window - secret_line.len() + AWS_KEY.len() / 2,
        &secret_line,
        window + window / 2,
    );
    assert!(offset < window && offset + secret_line.len() > window);
    assert_single_windowed_detection(&text, &secret_line, offset);
}

#[test]
fn windowed_redaction_finds_a_secret_deep_in_a_large_payload() {
    let secret_line = format!("token={AWS_KEY}");
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    let (text, offset) = text_with_line_at(5 * window + 777, &secret_line, 8 * window + 13);
    assert_single_windowed_detection(&text, &secret_line, offset);
}

#[test]
fn windowed_redaction_leaves_a_clean_large_payload_unchanged() {
    let (text, _) = text_with_line_at(0, "first", 3 * mc_secret_scanner::MAX_INPUT_BYTES);
    let redaction = redact_windowed_durable_text(&text, usize::MAX).unwrap();
    assert!(redaction.detections.is_empty());
    assert_eq!(redaction.text, text);
    assert_eq!(detect_windowed_durable_text(&text), Ok(false));
}

const PEM_BODY_LINE: &str = "MIIEpAIBAAKCAQEA7bq2k0v9xR3sY1nQ4dJ6fH8zL2mW5cP0uT9eG7iK3oB1aV\n";

/// PEM private key whose body holds at least `body_bytes`.
fn pem_private_key(body_bytes: usize) -> String {
    let mut pem = String::from("-----BEGIN RSA PRIVATE KEY-----\n");
    let body_start = pem.len();
    while pem.len() - body_start < body_bytes {
        pem.push_str(PEM_BODY_LINE);
    }
    pem.push_str("-----END RSA PRIVATE KEY-----");
    pem
}

#[test]
fn windowed_redaction_redacts_a_private_key_straddling_a_window_edge() {
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // Longer than the overlap's neighbours would tolerate without the match
    // bound, shorter than the bound itself, and cut by the first window's end.
    let pem = pem_private_key(20 * 1024);
    assert!(pem.len() < mc_secret_scanner::MAX_MATCH_BYTES);
    let (text, offset) = text_with_line_at(window - pem.len() / 2, &pem, 2 * window);
    assert!(offset < window && offset + pem.len() > window);

    let redaction = redact_windowed_durable_text(&text, usize::MAX).unwrap();
    assert_eq!(redaction.detections.len(), 1, "{:?}", redaction.detections);
    assert!(!redaction.text.contains("BEGIN RSA PRIVATE KEY"));
    assert!(!redaction.text.contains(PEM_BODY_LINE));
    assert_eq!(detect_windowed_durable_text(&text), Ok(true));
}

#[test]
fn a_match_past_the_scanner_bound_fails_closed_on_both_paths() {
    let pem = pem_private_key(mc_secret_scanner::MAX_MATCH_BYTES);
    assert!(pem.len() > mc_secret_scanner::MAX_MATCH_BYTES);
    assert!(pem.len() < mc_secret_scanner::MAX_INPUT_BYTES);
    // Direct redaction cannot describe the match, so the whole field is replaced.
    let direct = redact_durable_text(&pem);
    assert_eq!(direct.text, "<REDACTED:secret>");
    assert_eq!(direct.detections.len(), 1);
    assert_eq!(direct.detections[0].length, pem.len());
    assert_eq!(
        redactor().redact(&pem).map_err(|error| error.kind()),
        Err(RedactionErrorKind::MatchLimit)
    );

    // A window containing the full match returns `MatchLimit`; windowed redaction does not replace the field.
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    let (text, offset) = text_with_line_at(window / 4, &pem, 2 * window);
    assert!(offset + pem.len() < window);
    assert_eq!(
        redact_windowed_durable_text(&text, usize::MAX).map_err(|error| error.kind()),
        Err(RedactionErrorKind::MatchLimit)
    );
    assert_eq!(
        detect_windowed_durable_text(&text).map_err(|error| error.kind()),
        Err(RedactionErrorKind::MatchLimit)
    );
    assert_eq!(
        detect_windowed_durable_bytes(text.as_bytes()).map_err(|error| error.kind()),
        Err(RedactionErrorKind::MatchLimit)
    );

    let short = pem_private_key(4 * 1024);
    assert_eq!(redact_durable_text(&short).detections.len(), 1);
}

#[test]
fn a_match_past_the_scanner_bound_that_straddles_a_window_edge_is_still_refused() {
    // The match is longer than the scanner bound but shorter than the overlap,
    // so one window holds it whole and reports the limit.
    let pem = pem_private_key(mc_secret_scanner::MAX_MATCH_BYTES);
    assert!(pem.len() < WINDOW_OVERLAP_BYTES);
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    let (text, offset) = text_with_line_at(window - pem.len() / 2, &pem, 2 * window);
    assert!(offset < window && offset + pem.len() > window);
    assert_eq!(
        redact_windowed_durable_text(&text, usize::MAX).map_err(|error| error.kind()),
        Err(RedactionErrorKind::MatchLimit)
    );
}

#[test]
fn a_match_longer_than_the_overlap_that_straddles_a_window_edge_is_not_seen() {
    // No window contains the full match: the header and footer fall in different windows.
    let pem = pem_private_key(WINDOW_OVERLAP_BYTES + 4 * 1024);
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    let second_window_start = window - WINDOW_OVERLAP_BYTES;
    let (text, offset) = text_with_line_at(second_window_start - 2 * 1024, &pem, 3 * window);
    assert!(offset + 64 < second_window_start && offset + pem.len() > window);
    let windowed = redact_windowed_durable_text(&text, usize::MAX).unwrap();
    assert!(windowed.detections.is_empty());
    assert_eq!(windowed.text, text);
}

#[test]
fn windowed_redaction_stops_at_the_finding_limit_instead_of_replacing() {
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    let mut text = String::new();
    while text.len() < 2 * window {
        text.push_str("password=hunter-two-");
        text.push_str(&text.len().to_string());
        text.push('\n');
    }
    assert_eq!(
        redact_windowed_durable_text(&text, 8).map_err(|error| error.kind()),
        Err(RedactionErrorKind::FindingLimit)
    );
    assert_eq!(detect_windowed_durable_text(&text), Ok(true));
}

#[test]
fn direct_redaction_of_oversized_text_still_fails_closed() {
    let input = "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES + 1);
    let redaction = redact_durable_text(&input);
    assert_eq!(redaction.text, "<REDACTED:secret>");
    assert_eq!(redaction.detections.len(), 1);
    assert_eq!(redaction.detections[0].length, input.len());
}

/// A Hugging Face token shape whose trailing `\b` is satisfied only by an end of input.
/// Assembled at run time so the source holds no token-shaped literal.
fn hf_prefix_and_body() -> String {
    format!(" hf_{}{}", "QwErTyUiOpAsDfGhJkLzXcVbNm", "QwErTyUi")
}

#[test]
fn a_window_end_does_not_fabricate_a_word_boundary() {
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    let candidate = hf_prefix_and_body();
    // The candidate ends exactly where the first window ends, and letters
    // continue past it, so the whole input holds no `\b` there.
    let mut text = "a".repeat(window - candidate.len());
    text.push_str(&candidate);
    assert_eq!(text.len(), window);
    text.push_str(&"b".repeat(4096));

    let redaction = redact_windowed_durable_text(&text, usize::MAX).unwrap();
    assert!(
        redaction.detections.is_empty(),
        "{:?}",
        redaction.detections
    );
    assert_eq!(redaction.text, text);
    assert_eq!(detect_windowed_durable_text(&text), Ok(false));
    assert_eq!(detect_windowed_durable_bytes(text.as_bytes()), Ok(false));
}

#[test]
fn a_secret_inside_the_edge_margin_is_still_redacted_once() {
    let secret_line = format!("token={AWS_KEY}");
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // Deep inside the first window's right margin and well clear of the second
    // window's left margin, so only the second window may report it.
    let (text, offset) = text_with_line_at(
        window - EDGE_MARGIN_BYTES / 2,
        &secret_line,
        window + window / 2,
    );
    assert!(offset + secret_line.len() + EDGE_MARGIN_BYTES > window);
    assert!(offset + secret_line.len() < window);
    assert_single_windowed_detection(&text, &secret_line, offset);
    assert_eq!(detect_windowed_durable_bytes(text.as_bytes()), Ok(true));
}

#[test]
fn byte_detection_matches_the_lossy_text_verdict_on_a_wide_binary_payload() {
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // Every 0xff widens to three bytes, so the lossy text spans several windows
    // while the payload itself is under one.
    let mut clean = vec![0xff_u8; window];
    clean[window / 2] = b'\n';
    let lossy = String::from_utf8_lossy(&clean);
    assert!(lossy.len() > 2 * window);
    assert_eq!(detect_windowed_durable_text(&lossy), Ok(false));
    assert_eq!(detect_windowed_durable_bytes(&clean), Ok(false));

    for position in [0, window / 2 + 1, window - 30, window - AWS_KEY.len() - 7] {
        let mut leaking = clean.clone();
        let line = format!("token={AWS_KEY}\n");
        leaking[position..position + line.len()].copy_from_slice(line.as_bytes());
        let lossy = String::from_utf8_lossy(&leaking);
        assert_eq!(detect_windowed_durable_text(&lossy), Ok(true), "{position}");
        assert_eq!(
            detect_windowed_durable_bytes(&leaking),
            Ok(true),
            "{position}"
        );
    }
}

#[test]
fn byte_detection_handles_multibyte_characters_split_by_window_capacity() {
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // Three-byte characters never divide the window length evenly, so every
    // window boundary falls inside a character and must move back to fit.
    let mut text = "\u{20AC}".repeat(window);
    text.push_str("\ntoken=");
    text.push_str(AWS_KEY);
    text.push('\n');
    text.push_str(&"\u{20AC}".repeat(window / 3));
    assert_eq!(detect_windowed_durable_bytes(text.as_bytes()), Ok(true));
    assert_eq!(detect_windowed_durable_text(&text), Ok(true));

    let mut invalid = text.into_bytes();
    // Break one character in each third of the payload into invalid bytes.
    for index in [7usize, invalid.len() / 2, invalid.len() - 7] {
        invalid[index] = 0xff;
    }
    assert_eq!(detect_windowed_durable_bytes(&invalid), Ok(true));
    assert_eq!(
        detect_windowed_durable_text(&String::from_utf8_lossy(&invalid)),
        Ok(true)
    );
}

#[test]
fn a_finding_in_the_shared_overlap_counts_once_against_the_limit() {
    let secret_line = format!("token={AWS_KEY}");
    let window = mc_secret_scanner::MAX_INPUT_BYTES;
    // Inside both windows and clear of both edge margins.
    let (text, offset) = text_with_line_at(
        window - WINDOW_OVERLAP_BYTES + 2 * EDGE_MARGIN_BYTES,
        &secret_line,
        window + window / 2,
    );
    assert!(offset + secret_line.len() + EDGE_MARGIN_BYTES < window);
    // One secret can be several raw findings (a keyed rule and a provider rule
    // over the same bytes), so measure that count on a one-window text first.
    let (single, _) = text_with_line_at(1024, &secret_line, 8 * 1024);
    let per_secret = (1..=8)
        .find(|&limit| redact_windowed_durable_text(&single, limit).is_ok())
        .unwrap();
    let redaction = redact_windowed_durable_text(&text, per_secret).unwrap();
    assert_eq!(redaction.detections.len(), 1, "{:?}", redaction.detections);
    assert_eq!(redaction.detections[0].offset, offset + "token=".len());
}
