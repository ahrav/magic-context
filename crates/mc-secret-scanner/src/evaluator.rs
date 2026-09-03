use aho_corasick::AhoCorasick;
use regex::bytes::Captures;

use crate::api::REVISION;
use crate::rules::{
    EntropySpec, LocalContextSpec, OfflineValidationKind, OfflineValidationSpec, Rule, RuleSet,
};
use crate::{
    Finding, LimitExhausted, RuleSource, ScanError, ScanLimits, ScanProfile, ScanReport, TextSpan,
};

#[derive(Debug)]
enum Abort {
    Work,
    Invalid(ScanError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CandidateSpans {
    full: TextSpan,
    value: TextSpan,
    key: Option<TextSpan>,
}

impl From<ScanError> for Abort {
    fn from(error: ScanError) -> Self {
        Self::Invalid(error)
    }
}

pub(crate) fn evaluate(
    rules: &RuleSet,
    profile: ScanProfile,
    limits: ScanLimits,
    semantic_digest: [u8; 32],
    input: &str,
) -> Result<ScanReport, ScanError> {
    if input.len() > limits.max_input_bytes {
        return Err(ScanError::InputLimitExceeded);
    }
    let bytes = input.as_bytes();
    let mut findings = Vec::new();
    let mut candidates = 0usize;
    let mut work = 0usize;
    let mut limits_hit = None;

    // Charge input bytes before preselection so `max_work_bytes` bounds preselection.
    if add_work(&mut work, bytes.len(), limits.max_work_bytes).is_err() {
        return Ok(ScanReport {
            findings,
            revision: REVISION,
            semantic_digest,
            candidates_evaluated: candidates,
            work_bytes: work,
            limits_hit: Some(LimitExhausted::Work),
        });
    }

    let input_is_ascii = input.is_ascii();

    'rules: for rule in rules.preselect(profile, bytes) {
        if add_work(&mut work, bytes.len(), limits.max_work_bytes).is_err() {
            limits_hit = Some(LimitExhausted::Work);
            break 'rules;
        }
        // The value group `("[a-z0-9=_\-]{8,20}")` makes a double quote a necessary byte of every match.
        if rule.declaration.name == "hashicorp-tf-password" && memchr::memchr(b'"', bytes).is_none()
        {
            continue;
        }
        if input_is_ascii {
            if let Some(form) = KeyedForm::for_rule(&rule.declaration.name) {
                let mut cursor = 0;
                while let Some(at) =
                    memchr::memchr(form.anchor(), &bytes[cursor..]).map(|offset| cursor + offset)
                {
                    match form.probe(input, at, cursor)? {
                        Probe::Candidate(spans) => {
                            cursor = spans.full.end();
                            if candidates >= limits.max_candidates {
                                limits_hit = Some(LimitExhausted::Candidates);
                                break 'rules;
                            }
                            candidates += 1;
                            // `candidate_spans` counts an empty value as a candidate and skips it; the fast path must charge the same candidate budget.
                            if spans.value.is_empty() {
                                continue;
                            }
                            match evaluate_candidate_spans(
                                rules, rule, spans, input, &mut work, limits,
                            ) {
                                Ok(Some(finding)) => findings.push(finding),
                                Ok(None) => {}
                                Err(Abort::Work) => {
                                    limits_hit = Some(LimitExhausted::Work);
                                    break 'rules;
                                }
                                Err(Abort::Invalid(error)) => return Err(error),
                            }
                        }
                        Probe::Skip(next) => {
                            debug_assert!(next > at, "a probe must advance past its anchor");
                            cursor = next;
                        }
                    }
                }
                continue;
            }
        }
        for captures in rule.regex.captures_iter(bytes) {
            if candidates >= limits.max_candidates {
                limits_hit = Some(LimitExhausted::Candidates);
                break 'rules;
            }
            candidates += 1;
            match evaluate_candidate(rules, rule, &captures, input, &mut work, limits) {
                Ok(Some(finding)) => findings.push(finding),
                Ok(None) => {}
                Err(Abort::Work) => {
                    limits_hit = Some(LimitExhausted::Work);
                    break 'rules;
                }
                Err(Abort::Invalid(error)) => return Err(error),
            }
        }
    }
    findings.sort_by(|left, right| {
        (
            left.full_span.start(),
            left.value_span.start(),
            left.rule_source,
            left.rule_id.as_str(),
            left.full_span.end(),
            left.value_span.end(),
        )
            .cmp(&(
                right.full_span.start(),
                right.value_span.start(),
                right.rule_source,
                right.rule_id.as_str(),
                right.full_span.end(),
                right.value_span.end(),
            ))
    });

    Ok(ScanReport {
        findings,
        revision: REVISION,
        semantic_digest,
        candidates_evaluated: candidates,
        work_bytes: work,
        limits_hit,
    })
}

fn evaluate_candidate(
    rules: &RuleSet,
    rule: &Rule,
    captures: &Captures<'_>,
    input: &str,
    work: &mut usize,
    limits: ScanLimits,
) -> Result<Option<Finding>, Abort> {
    let Some(spans) = candidate_spans(rule, captures, input)? else {
        return Ok(None);
    };
    evaluate_candidate_spans(rules, rule, spans, input, work, limits)
}

fn candidate_spans(
    rule: &Rule,
    captures: &Captures<'_>,
    input: &str,
) -> Result<Option<CandidateSpans>, Abort> {
    let full_match = captures.get(0).ok_or(ScanError::InvalidSpan)?;
    // A nonparticipating declared value, secret, or key group skips the candidate, rather than aborting the whole scan, reporting the whole match, or silently skipping the gate keyed on that group.
    let value_match = if let Some(name) = rule.declaration.value_group.as_deref() {
        match captures.name(name) {
            Some(value) => value,
            None => return Ok(None),
        }
    } else if let Some(group) = rule.declaration.secret_group {
        match captures.get(usize::from(group)) {
            Some(value) => value,
            None => return Ok(None),
        }
    } else if let Some(alternative) = first_unnamed_capture(rule, captures) {
        alternative
    } else {
        full_match
    };
    if value_match.is_empty() {
        return Ok(None);
    }
    let value_match = unquoted(rule, captures, value_match);
    let key_match = match rule.declaration.key_group.as_deref() {
        Some(name) => match captures.name(name) {
            Some(key) => Some(key),
            None => return Ok(None),
        },
        None => None,
    };

    let full_span = TextSpan::snapped(input, full_match.start(), full_match.end())?;
    let value_span = TextSpan::snapped(input, value_match.start(), value_match.end())?;
    let key_span = key_match
        .map(|value| TextSpan::snapped(input, value.start(), value.end()))
        .transpose()?;
    if !full_span.contains(value_span) || key_span.is_some_and(|span| !full_span.contains(span)) {
        return Err(ScanError::InvalidSpan.into());
    }
    Ok(Some(CandidateSpans {
        full: full_span,
        value: value_span,
        key: key_span,
    }))
}

fn evaluate_candidate_spans(
    rules: &RuleSet,
    rule: &Rule,
    spans: CandidateSpans,
    input: &str,
    work: &mut usize,
    limits: ScanLimits,
) -> Result<Option<Finding>, Abort> {
    let CandidateSpans {
        full: full_span,
        value: value_span,
        key: key_span,
    } = spans;
    let value = input
        .as_bytes()
        .get(value_span.start()..value_span.end())
        .ok_or(ScanError::InvalidSpan)?;
    if let Some(key) = key_span {
        let key = input
            .as_bytes()
            .get(key.start()..key.end())
            .ok_or(ScanError::InvalidSpan)?;
        if !has_secret_key_token(key) {
            return Ok(None);
        }
    }
    if rule.declaration.reject_scalars && is_scalar(value) {
        return Ok(None);
    }

    let mut radius = rule.declaration.radius;
    if let Some(two_phase) = &rule.declaration.two_phase {
        let seed_start = full_span.start().saturating_sub(two_phase.seed_radius);
        let seed_end = full_span
            .end()
            .saturating_add(two_phase.seed_radius)
            .min(input.len());
        let seed = input
            .as_bytes()
            .get(seed_start..seed_end)
            .ok_or(ScanError::InvalidSpan)?;
        add_work(work, seed.len(), limits.max_work_bytes)?;
        let mut confirmed = false;
        for item in &two_phase.confirm_any {
            if contains_charged_ignore_case(seed, item.as_bytes(), work, limits)? {
                confirmed = true;
                break;
            }
        }
        if !confirmed {
            return Ok(None);
        }
        radius = radius.max(two_phase.full_radius);
    }

    let window_start = full_span.start().saturating_sub(radius);
    let window_end = full_span.end().saturating_add(radius).min(input.len());
    let window = input
        .as_bytes()
        .get(window_start..window_end)
        .ok_or(ScanError::InvalidSpan)?;
    add_work(work, window.len(), limits.max_work_bytes)?;

    if let Some(needle) = &rule.declaration.must_contain {
        if !contains_charged_ignore_case(window, needle.as_bytes(), work, limits)? {
            return Ok(None);
        }
    }
    if let Some(keywords) = &rule.declaration.keywords_any {
        if !contains_any_charged_ignore_case(
            window,
            keywords,
            rule.keyword_matcher.as_ref(),
            work,
            limits,
        )? {
            return Ok(None);
        }
    }
    if let Some(values) = &rule.declaration.value_suppressors_any {
        if contains_any_charged_ignore_case(
            value,
            values,
            rule.suppressor_matcher.as_ref(),
            work,
            limits,
        )? {
            return Ok(None);
        }
    }

    let char_class = rule.declaration.char_class.as_ref().or_else(|| {
        rule.declaration
            .entropy
            .as_ref()
            .and_then(|entropy| (entropy.min_bits_per_byte >= 3.0).then_some(&DEFAULT_CHAR_CLASS))
    });
    if char_class.is_some_and(|spec| {
        window.len() >= usize::from(spec.min_window_len)
            && lowercase_percent(window) > usize::from(spec.max_lower_pct)
    }) {
        return Ok(None);
    }

    let entropy_measured = if let Some(spec) = &rule.declaration.entropy {
        match entropy_allows(spec, value) {
            EntropyOutcome::Failed => return Ok(None),
            EntropyOutcome::Bypassed => false,
            EntropyOutcome::Passed => true,
        }
    } else {
        false
    };
    if (rule.source == RuleSource::Upstream || rule.declaration.upstream_parity)
        && (rules.context_is_safelisted(window)
            || rules.value_is_safelisted(value)
            || (!rule.declaration.uuid_format_secret && is_uuid(value)))
    {
        return Ok(None);
    }
    if rule
        .declaration
        .local_context
        .as_ref()
        .map(|spec| local_context_allows(spec, input.as_bytes(), value_span, work, limits))
        .transpose()?
        .is_some_and(|allowed| !allowed)
    {
        return Ok(None);
    }

    let offline = rule
        .declaration
        .offline_validation
        .as_ref()
        .map(|spec| offline_verdict(spec, value));
    if matches!(offline, Some(OfflineVerdict::Invalid)) {
        return Ok(None);
    }
    let mut confidence = 0i8;
    if entropy_measured {
        confidence += 1;
    }
    if rule.declaration.keywords_any.is_some() {
        confidence += 2;
    }
    if rule.declaration.name == "generic-api-key" {
        confidence += 2;
    }
    if matches!(offline, Some(OfflineVerdict::Valid)) {
        confidence += 5;
    }
    // The confidence threshold requires entropy only when measured; otherwise values below `entropy.min_len` bypass entropy and create an undeclared credential minimum.
    let minimum = rule.declaration.min_confidence.unwrap_or({
        if rule.declaration.keywords_any.is_some() && entropy_measured {
            3
        } else if rule.declaration.keywords_any.is_some() {
            2
        } else {
            0
        }
    });
    if confidence < minimum {
        return Ok(None);
    }

    Ok(Some(Finding {
        rule_id: rule.declaration.name.clone(),
        rule_source: rule.source,
        full_span,
        value_span,
        key_span,
    }))
}

/// Parses the ASCII subset of one keyed overlay rule without regex matching.
///
/// Each variant mirrors one embedded `magic-keyed-*` regex. For ASCII input
/// `probe` must report exactly the candidates `Regex::captures_iter` reports
/// for that regex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyedForm {
    /// `key = value`, the value ending at a separator or shell delimiter.
    Assignment,
    /// `key = "value"`.
    AssignmentQuoted { value_quote: u8 },
    /// `"key": "value"`.
    QuotedKeyed { key_quote: u8, value_quote: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Probe {
    Candidate(CandidateSpans),
    /// No candidate is anchored in `at..next`; the next probe starts at `next`.
    Skip(usize),
}

impl KeyedForm {
    fn for_rule(name: &str) -> Option<Self> {
        match name {
            "magic-keyed-assignment" => Some(Self::Assignment),
            "magic-keyed-assignment-double-quoted" => {
                Some(Self::AssignmentQuoted { value_quote: b'"' })
            }
            "magic-keyed-assignment-single-quoted" => {
                Some(Self::AssignmentQuoted { value_quote: b'\'' })
            }
            "magic-keyed-double-quoted" => Some(Self::QuotedKeyed {
                key_quote: b'"',
                value_quote: b'"',
            }),
            "magic-keyed-single-quoted" => Some(Self::QuotedKeyed {
                key_quote: b'\'',
                value_quote: b'\'',
            }),
            "magic-keyed-double-single" => Some(Self::QuotedKeyed {
                key_quote: b'"',
                value_quote: b'\'',
            }),
            "magic-keyed-single-double" => Some(Self::QuotedKeyed {
                key_quote: b'\'',
                value_quote: b'"',
            }),
            _ => None,
        }
    }

    /// The byte every candidate of this form contains.
    fn anchor(self) -> u8 {
        match self {
            Self::Assignment | Self::AssignmentQuoted { .. } => b'=',
            Self::QuotedKeyed { key_quote, .. } => key_quote,
        }
    }

    /// Probes for the candidate anchored at `at`.
    ///
    /// `floor` is where `captures_iter` would resume after the previous
    /// candidate, so no reported span starts before it.
    fn probe(self, input: &str, at: usize, floor: usize) -> Result<Probe, ScanError> {
        let bytes = input.as_bytes();
        match self {
            Self::Assignment => {
                let Some((key_start, key_end)) = assignment_key(bytes, at, floor) else {
                    return Ok(Probe::Skip(at + 1));
                };
                let value_start = skip_rule_spaces(bytes, at + 1);
                let value_end = unquoted_value_end(bytes, value_start);
                if value_start == value_end {
                    return Ok(Probe::Skip(at + 1));
                }
                candidate(
                    input,
                    (key_start, value_end),
                    (value_start, value_end),
                    (key_start, key_end),
                )
            }
            Self::AssignmentQuoted { value_quote } => {
                let Some((key_start, key_end)) = assignment_key(bytes, at, floor) else {
                    return Ok(Probe::Skip(at + 1));
                };
                let value_quote_start = skip_rule_spaces(bytes, at + 1);
                if bytes.get(value_quote_start) != Some(&value_quote) {
                    return Ok(Probe::Skip(at + 1));
                }
                let value_start = value_quote_start + 1;
                match quoted_end(bytes, value_start, value_quote) {
                    Ok(value_end) => candidate(
                        input,
                        (key_start, value_end + 1),
                        (value_start, value_end),
                        (key_start, key_end),
                    ),
                    // An `=` inside this unclosed value opens its own value at a quote this walk consumed as escaped, so that value cannot close before `resume` either.
                    Err(resume) => Ok(Probe::Skip(resume)),
                }
            }
            Self::QuotedKeyed {
                key_quote,
                value_quote,
            } => {
                let key_start = at + 1;
                let key_end = match quoted_end(bytes, key_start, key_quote) {
                    Ok(end) => end,
                    // A key opening at an escaped quote inside this one is parsed in step with it, so it cannot close before `resume` either.
                    Err(resume) => return Ok(Probe::Skip(resume)),
                };
                // A key opening at an escaped quote inside this one is a suffix of this key that shares its closing quote, so it fails the same checks; the closing quote itself may open the next key.
                let skip = Probe::Skip(key_end);
                if !quoted_key_contains_keyword(&bytes[key_start..key_end]) {
                    return Ok(skip);
                }
                let separator = skip_rule_spaces(bytes, key_end + 1);
                if bytes.get(separator) != Some(&b':') {
                    return Ok(skip);
                }
                let value_quote_start = skip_rule_spaces(bytes, separator + 1);
                if bytes.get(value_quote_start) != Some(&value_quote) {
                    return Ok(skip);
                }
                let value_start = value_quote_start + 1;
                let Ok(value_end) = quoted_end(bytes, value_start, value_quote) else {
                    return Ok(skip);
                };
                candidate(
                    input,
                    (at, value_end + 1),
                    (value_start, value_end),
                    (key_start, key_end),
                )
            }
        }
    }
}

fn candidate(
    input: &str,
    (full_start, full_end): (usize, usize),
    (value_start, value_end): (usize, usize),
    (key_start, key_end): (usize, usize),
) -> Result<Probe, ScanError> {
    Ok(Probe::Candidate(CandidateSpans {
        full: TextSpan::snapped(input, full_start, full_end)?,
        value: TextSpan::snapped(input, value_start, value_end)?,
        key: Some(TextSpan::snapped(input, key_start, key_end)?),
    }))
}

/// Finds the key that `(?-u:\b)(?P<key>[A-Za-z0-9_.-]*(?:keyword)[A-Za-z0-9_.-]*)[sep]*=`
/// reports before the `=` at `equals` when the search starts at `floor`.
fn assignment_key(bytes: &[u8], equals: usize, floor: usize) -> Option<(usize, usize)> {
    let mut key_end = equals;
    while key_end > floor && is_rule_space_byte(bytes[key_end - 1]) {
        key_end -= 1;
    }
    let mut run_start = key_end;
    while run_start > floor && is_key_byte(bytes[run_start - 1]) {
        run_start -= 1;
    }
    // `\b` holds at a word byte only when the byte before it is not one; the byte before `floor` counts even though the search does not start there.
    let key_start = (run_start..key_end).find(|&index| {
        is_word_byte(bytes[index]) && (index == 0 || !is_word_byte(bytes[index - 1]))
    })?;
    contains_keyed_keyword(&bytes[key_start..key_end]).then_some((key_start, key_end))
}

fn skip_rule_spaces(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).copied().is_some_and(is_rule_space_byte) {
        index += 1;
    }
    index
}

/// Extends `(?:[^SEP'"`;&|<>()$\\]|\\.)+` from `start` and returns where it stops.
fn unquoted_value_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while let Some(&byte) = bytes.get(end) {
        match byte {
            // `.` never matches a newline, so a backslash before one, or at the end of input, escapes nothing and ends the value.
            b'\\' => match bytes.get(end + 1) {
                None | Some(b'\n') => break,
                Some(_) => end += 2,
            },
            b'\'' | b'"' | b'`' | b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')' | b'$' => break,
            _ if is_rule_space_byte(byte) => break,
            _ => end += 1,
        }
    }
    end
}

/// Finds the unescaped `quote` that closes `(?:[^QUOTE\\]|\\.)*` starting at `start`.
///
/// `Err(resume)` means no closing quote exists, and no section opening at a
/// quote inside `start..resume` closes either: those quotes are escaped, so a
/// section opening there is parsed in step with this one and stops where it
/// stopped. `.` never matches a newline, so a backslash before one, or at the
/// end of input, ends the section without closing it.
fn quoted_end(bytes: &[u8], start: usize, quote: u8) -> Result<usize, usize> {
    let mut cursor = start;
    while let Some(&byte) = bytes.get(cursor) {
        if byte == b'\\' {
            match bytes.get(cursor + 1) {
                None => return Err(bytes.len()),
                Some(b'\n') => return Err(cursor + 2),
                Some(_) => cursor += 2,
            }
        } else if byte == quote {
            return Ok(cursor);
        } else {
            cursor += 1;
        }
    }
    Err(bytes.len())
}

// The keyed overlay rules spell their separator and value-terminator class as `[\t\n\x0B\f\r ...]`, and `u8::is_ascii_whitespace` omits `\x0B`.
// These helpers run only for ASCII input, so the non-ASCII spellings in that class are unreachable here.
fn is_rule_space_byte(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | 0x0B | b'\x0C' | b'\r' | b' ')
}

fn is_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn contains_keyed_keyword(key: &[u8]) -> bool {
    (0..key.len()).any(|index| keyed_keyword_at(key, index))
}

// `(?:[^QUOTE\\]|\\.)*` parses left to right into single bytes and `\x` pairs, so the keyword alternation can only start on one of those unit boundaries.
fn quoted_key_contains_keyword(key: &[u8]) -> bool {
    let mut index = 0;
    while index < key.len() {
        if key[index] == b'\\' {
            index += 2;
            continue;
        }
        if keyed_keyword_at(key, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn keyed_keyword_at(key: &[u8], index: usize) -> bool {
    let keyword: &[u8] = match key[index].to_ascii_lowercase() {
        b'a' => b"auth",
        b'b' => b"bearer",
        b'c' => b"credential",
        b'k' => b"key",
        b'p' => b"password",
        b's' => b"secret",
        b't' => b"token",
        _ => return false,
    };
    key[index..]
        .get(..keyword.len())
        .is_some_and(|window| window.eq_ignore_ascii_case(keyword))
}

// Unnamed captures hold secrets; named captures mark header fields. Ignore named captures so header-only rules return their whole match.
// Fallback rules report an unnamed capture nested inside matching shell quotes; declared groups take precedence.
fn unquoted<'a>(
    rule: &Rule,
    captures: &Captures<'a>,
    selected: regex::bytes::Match<'a>,
) -> regex::bytes::Match<'a> {
    if rule.declaration.value_group.is_some() || rule.declaration.secret_group.is_some() {
        return selected;
    }
    let bytes = selected.as_bytes();
    let quoted = bytes.len() >= 2
        && matches!(bytes[0], b'\'' | b'"' | b'`')
        && bytes[bytes.len() - 1] == bytes[0];
    if !quoted {
        return selected;
    }
    rule.regex
        .capture_names()
        .enumerate()
        .skip(1)
        .filter(|(_, name)| name.is_none())
        .filter_map(|(index, _)| captures.get(index))
        .find(|inner| inner.start() == selected.start() + 1 && inner.end() == selected.end() - 1)
        .unwrap_or(selected)
}

fn first_unnamed_capture<'a>(
    rule: &Rule,
    captures: &Captures<'a>,
) -> Option<regex::bytes::Match<'a>> {
    rule.regex
        .capture_names()
        .enumerate()
        .skip(1)
        .filter(|(_, name)| name.is_none())
        .filter_map(|(index, _)| captures.get(index))
        .find(|value| !value.is_empty())
}

fn add_work(total: &mut usize, amount: usize, limit: usize) -> Result<(), Abort> {
    *total = total.checked_add(amount).ok_or(Abort::Work)?;
    if *total > limit {
        return Err(Abort::Work);
    }
    Ok(())
}

// Corpus and overlay lists spell each keyword and suppressor in lowercase and
// uppercase by hand, so a case-sensitive search misses the mixed-case spelling
// of both: it drops a secret keyed `ApiKey` and reports a value of `ChangeMe`.
fn contains_charged_ignore_case(
    haystack: &[u8],
    needle: &[u8],
    work: &mut usize,
    limits: ScanLimits,
) -> Result<bool, Abort> {
    add_work(work, haystack.len(), limits.max_work_bytes)?;
    Ok(find_ignore_ascii_case(haystack, needle))
}

fn contains_any_charged_ignore_case(
    haystack: &[u8],
    needles: &[String],
    matcher: Option<&AhoCorasick>,
    work: &mut usize,
    limits: ScanLimits,
) -> Result<bool, Abort> {
    let Some(matcher) = matcher else {
        return contains_any_charged_ignore_case_scalar(haystack, needles, work, limits);
    };
    let Some(full_charge) = haystack.len().checked_mul(needles.len()) else {
        return contains_any_charged_ignore_case_scalar(haystack, needles, work, limits);
    };
    if work
        .checked_add(full_charge)
        .is_none_or(|total| total > limits.max_work_bytes)
    {
        return contains_any_charged_ignore_case_scalar(haystack, needles, work, limits);
    }

    // Pattern 0 is the lowest possible index, so no later overlap can change `first_match`.
    let mut first_match: Option<usize> = None;
    for found in matcher.find_overlapping_iter(haystack) {
        let index = found.pattern().as_usize();
        if first_match.is_none_or(|lowest| index < lowest) {
            first_match = Some(index);
        }
        if index == 0 {
            break;
        }
    }
    let probes = first_match.map_or(needles.len(), |index| index + 1);
    *work += haystack.len() * probes;
    Ok(first_match.is_some())
}

fn contains_any_charged_ignore_case_scalar(
    haystack: &[u8],
    needles: &[String],
    work: &mut usize,
    limits: ScanLimits,
) -> Result<bool, Abort> {
    for needle in needles {
        if contains_charged_ignore_case(haystack, needle.as_bytes(), work, limits)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn find_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    let lower = needle[0].to_ascii_lowercase();
    let upper = needle[0].to_ascii_uppercase();
    let limit = haystack.len() - needle.len() + 1;
    let mut offset = 0;
    while offset < limit {
        let found = if lower == upper {
            memchr::memchr(lower, &haystack[offset..limit])
        } else {
            memchr::memchr2(lower, upper, &haystack[offset..limit])
        };
        let Some(position) = found else {
            return false;
        };
        let start = offset + position;
        if haystack[start..start + needle.len()].eq_ignore_ascii_case(needle) {
            return true;
        }
        offset = start + 1;
    }
    false
}

#[cfg(test)]
pub(crate) fn secret_key_words_for_test() -> &'static [&'static [u8]] {
    SECRET_KEY_WORDS
}

const SECRET_KEY_WORDS: &[&[u8]] = &[
    b"key",
    b"keys",
    b"token",
    b"tokens",
    b"secret",
    b"secrets",
    b"password",
    b"passwords",
    b"auth",
    b"authorization",
    b"bearer",
    b"credential",
    b"credentials",
];

// KEY_QUALIFIERS limits undelimited matches around a secret word: `monkey` and `whiskey` do not match because `mon` and `whis` are not qualifiers, and `keyboard` and `keywords` do not because `board` and `words` are not. `public` is excluded because public keys are not credentials.
const KEY_QUALIFIERS: &[&[u8]] = &[
    b"access",
    b"admin",
    b"api",
    b"app",
    b"application",
    b"auth",
    b"aws",
    b"azure",
    b"bearer",
    b"client",
    b"consumer",
    b"database",
    b"db",
    b"encryption",
    b"gcp",
    b"github",
    b"gitlab",
    b"hmac",
    b"jwt",
    b"master",
    b"oauth",
    b"private",
    b"refresh",
    b"root",
    b"secret",
    b"service",
    b"session",
    b"shared",
    b"signing",
    b"slack",
    b"stripe",
    b"twilio",
    b"user",
    b"vault",
    b"webhook",
    b"b64",
    b"base64",
    b"data",
    b"env",
    b"file",
    b"hash",
    b"hashes",
    b"hex",
    b"id",
    b"ids",
    b"name",
    b"names",
    b"path",
    b"plain",
    b"prefix",
    b"ref",
    b"string",
    b"text",
    b"value",
    b"values",
];

// A key naming the public half of a keypair is not a credential, and the marker
// has to apply across delimited tokens too: `public_key` splits into `public` and
// `key`, so excluding `public` from the qualifiers only covers `publickey`.
const NON_SECRET_KEY_MARKERS: &[&[u8]] = &[b"public", b"pubkey", b"publishable"];

fn has_secret_key_token(key: &[u8]) -> bool {
    if key_tokens(key).any(|token| {
        NON_SECRET_KEY_MARKERS
            .iter()
            .any(|marker| token.eq_ignore_ascii_case(marker))
    }) {
        return false;
    }
    key_tokens(key).any(|token| token_matches_any_key_name(token, SECRET_KEY_WORDS))
}

// Both qualifier walks run once per token rather than once per candidate split, so cost stays linear in the token length instead of quadratic.
fn token_matches_any_key_name<Name: AsRef<[u8]>>(token: &[u8], names: &[Name]) -> bool {
    if names
        .iter()
        .any(|name| token.eq_ignore_ascii_case(name.as_ref()))
    {
        return true;
    }
    let from_start = qualifier_reach(token, false);
    let to_end = qualifier_reach(token, true);
    names.iter().any(|name| {
        let name = name.as_ref();
        let Some(last) = token.len().checked_sub(name.len()) else {
            return false;
        };
        (0..=last).any(|start| {
            from_start[start]
                && to_end[start + name.len()]
                && token[start..start + name.len()].eq_ignore_ascii_case(name)
        })
    })
}

fn qualifier_reach(token: &[u8], reverse: bool) -> Vec<bool> {
    let mut reach = vec![false; token.len() + 1];
    let origin = if reverse { token.len() } else { 0 };
    reach[origin] = true;
    for step in 0..token.len() {
        let at = if reverse { token.len() - step } else { step };
        if !reach[at] {
            continue;
        }
        for qualifier in KEY_QUALIFIERS {
            let span = if reverse {
                at.checked_sub(qualifier.len()).map(|start| (start, at))
            } else {
                (at + qualifier.len() <= token.len()).then_some((at, at + qualifier.len()))
            };
            let Some((start, end)) = span else {
                continue;
            };
            if token[start..end].eq_ignore_ascii_case(qualifier) {
                reach[if reverse { start } else { end }] = true;
            }
        }
    }
    reach
}

pub(crate) fn key_tokens(key: &[u8]) -> impl Iterator<Item = &[u8]> {
    key.split(|byte| !byte.is_ascii_alphanumeric())
        .flat_map(|part| CamelTokens { remaining: part })
        .filter(|part| !part.is_empty())
}

struct CamelTokens<'a> {
    remaining: &'a [u8],
}

impl<'a> Iterator for CamelTokens<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }
        let split = (1..self.remaining.len()).find(|&index| {
            self.remaining[index].is_ascii_uppercase()
                && (self.remaining[index - 1].is_ascii_lowercase()
                    || self
                        .remaining
                        .get(index + 1)
                        .is_some_and(u8::is_ascii_lowercase))
        });
        let (token, remaining) = split.map_or((self.remaining, &[][..]), |index| {
            self.remaining.split_at(index)
        });
        self.remaining = remaining;
        Some(token)
    }
}

static DEFAULT_CHAR_CLASS: crate::rules::CharClassSpec = crate::rules::CharClassSpec {
    max_lower_pct: 95,
    min_window_len: 32,
};

pub(crate) fn lowercase_percent(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    bytes
        .iter()
        .filter(|byte| byte.is_ascii_lowercase())
        .count()
        .saturating_mul(100)
        / bytes.len()
}

enum EntropyOutcome {
    Failed,
    Bypassed,
    Passed,
}

fn entropy_allows(spec: &EntropySpec, value: &[u8]) -> EntropyOutcome {
    if value.len() < spec.min_len {
        return EntropyOutcome::Bypassed;
    }
    let value = &value[..value.len().min(spec.max_len)];
    let mut counts = [0usize; 256];
    for byte in value {
        counts[usize::from(*byte)] += 1;
    }
    let len = value.len() as f32;
    let mut shannon = 0.0f32;
    let mut max_count = 0usize;
    for count in counts.into_iter().filter(|count| *count > 0) {
        let probability = count as f32 / len;
        shannon -= probability * probability.log2();
        max_count = max_count.max(count);
    }
    if spec.digit_penalty && value.iter().all(u8::is_ascii_digit) && len > 1.0 {
        shannon -= 1.2 / len.log2();
    }
    if shannon < spec.min_bits_per_byte {
        return EntropyOutcome::Failed;
    }
    if spec
        .min_entropy_bits_per_byte
        .is_some_and(|minimum| len.log2() - (max_count as f32).log2() < minimum)
    {
        return EntropyOutcome::Failed;
    }
    EntropyOutcome::Passed
}

// `is_scalar` ignores ASCII case because languages capitalize null-like and boolean values differently; otherwise `password=None` is reported as a secret. The non-finite spellings carry their own sign because the decimal parser below never reaches them.
const SCALAR_KEYWORDS: &[&str] = &[
    "true",
    "false",
    "null",
    "undefined",
    "none",
    "nil",
    "nan",
    ".nan",
    "inf",
    "+inf",
    "-inf",
    ".inf",
    "+.inf",
    "-.inf",
    "infinity",
    "+infinity",
    "-infinity",
    "~",
];

// Quoted overlay rules keep `\\.` sequences as content, so a value spelled `\n` arrives as two bytes that `trim` leaves in place.
fn is_blank_with_escapes(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        let escaped = bytes[index] == b'\\'
            && bytes
                .get(index + 1)
                .is_some_and(|byte| matches!(byte, b'n' | b't' | b'r' | b'f' | b'v' | b'0' | b' '));
        if !escaped {
            return false;
        }
        index += 2;
    }
    true
}

// Hex-encoded credentials are also `0x`-prefixed, so a longer digit run stays a
// candidate: an Ethereum private key carries 64 hex digits. Modes, masks, and
// flags fit inside this bound.
const MAX_RADIX_SCALAR_DIGITS: usize = 8;

// A separator only counts between digits, so `1_000` is a literal while `_1`,
// `1_`, and `1__0` are not.
fn consume_digit_run(
    bytes: &[u8],
    index: &mut usize,
    digits: &mut usize,
    accepts: fn(&u8) -> bool,
) {
    while let Some(byte) = bytes.get(*index) {
        if accepts(byte) {
            *index += 1;
            *digits += 1;
            continue;
        }
        let separated = *byte == b'_' && *digits > 0 && bytes.get(*index + 1).is_some_and(accepts);
        if !separated {
            return;
        }
        *index += 1;
    }
}

fn is_radix_scalar(bytes: &[u8]) -> bool {
    let bytes = match bytes.first() {
        Some(b'+' | b'-') => &bytes[1..],
        _ => bytes,
    };
    if bytes.first() != Some(&b'0') {
        return false;
    }
    let Some(radix) = bytes.get(1) else {
        return false;
    };
    let digits = &bytes[2..];
    let accepts: fn(&u8) -> bool = match radix.to_ascii_lowercase() {
        b'x' => u8::is_ascii_hexdigit,
        b'o' => |byte: &u8| (b'0'..=b'7').contains(byte),
        b'b' => |byte: &u8| matches!(byte, b'0' | b'1'),
        _ => return false,
    };
    let mut index = 0usize;
    let mut count = 0usize;
    consume_digit_run(digits, &mut index, &mut count, accepts);
    index == digits.len() && count > 0 && count <= MAX_RADIX_SCALAR_DIGITS
}

fn is_scalar(value: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(value) else {
        return false;
    };
    let text = text.trim();
    if SCALAR_KEYWORDS
        .iter()
        .any(|keyword| text.eq_ignore_ascii_case(keyword))
    {
        return true;
    }
    if is_blank_with_escapes(text) {
        return true;
    }
    let bytes = text.as_bytes();
    if is_radix_scalar(bytes) {
        return true;
    }
    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    // Digits are counted across the point rather than required on its left, because `.5` and `5.` are decimal literals a configuration file can hold.
    let mut digits = 0usize;
    consume_digit_run(bytes, &mut index, &mut digits, u8::is_ascii_digit);
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        consume_digit_run(bytes, &mut index, &mut digits, u8::is_ascii_digit);
    }
    if digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

fn local_context_allows(
    spec: &LocalContextSpec,
    input: &[u8],
    value: TextSpan,
    work: &mut usize,
    limits: ScanLimits,
) -> Result<bool, Abort> {
    let start = value.start().saturating_sub(spec.lookbehind);
    let end = value.end().saturating_add(spec.lookahead).min(input.len());
    let Some(window) = input.get(start..end) else {
        return Ok(false);
    };
    let value_start = value.start() - start;
    let value_end = value.end() - start;
    if spec.require_quoted {
        let quoted = value_start
            .checked_sub(1)
            .and_then(|before| window.get(before).copied())
            .zip(window.get(value_end).copied())
            .is_some_and(|(left, right)| left == right && matches!(left, b'\'' | b'"' | b'`'));
        if !quoted {
            return Ok(false);
        }
    }
    let line_start = window[..value_start]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |position| position + 1);
    let before = &window[line_start..value_start];
    if spec.require_same_line_assignment
        && !before.iter().any(|byte| matches!(byte, b'=' | b':' | b'>'))
    {
        return Ok(false);
    }
    if let Some(keys) = &spec.key_names_any {
        add_work(work, before.len(), limits.max_work_bytes)?;
        // Compared per identifier token rather than as a substring, so the `key` inside `monkey` and the `auth` inside `author` do not satisfy the gate.
        let matched = key_tokens(before).any(|token| token_matches_any_key_name(token, keys));
        return Ok(matched);
    }
    Ok(true)
}

pub(crate) fn is_uuid(value: &[u8]) -> bool {
    value.len() == 36
        && value.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23) && *byte == b'-'
                || !matches!(index, 8 | 13 | 18 | 23) && byte.is_ascii_hexdigit()
        })
}

#[derive(Clone, Copy)]
enum OfflineVerdict {
    Valid,
    Invalid,
    Indeterminate,
}

fn offline_verdict(spec: &OfflineValidationSpec, value: &[u8]) -> OfflineVerdict {
    match spec.kind {
        OfflineValidationKind::Crc32Base62 => {
            let (Some(skip), Some(payload_len), Some(checksum_len)) =
                (spec.prefix_skip, spec.payload_len, spec.checksum_len)
            else {
                return OfflineVerdict::Indeterminate;
            };
            validate_crc32_base62(
                value,
                usize::from(skip),
                usize::from(payload_len),
                usize::from(checksum_len),
            )
        }
        OfflineValidationKind::GithubFineGrainedPat => {
            if value.len() < 93 || !starts_with_ignore_ascii_case(value, b"github_pat_") {
                OfflineVerdict::Indeterminate
            } else {
                crc_verdict(&value[..87], &value[87..93])
            }
        }
        // Compared case-insensitively because the rule pattern uses `(?i)`. A case-sensitive test returns `Indeterminate` for `GLSA_…`, which does not reject.
        OfflineValidationKind::GrafanaServiceAccount => {
            if value.len() < 46
                || !starts_with_ignore_ascii_case(value, b"glsa_")
                || value.get(37) != Some(&b'_')
            {
                OfflineVerdict::Indeterminate
            } else {
                checksum_verdict(&value[..37], parse_hex_u32(&value[38..46]))
            }
        }
        OfflineValidationKind::AwsAccessKey => validate_aws(value),
        OfflineValidationKind::SentryOrgToken => validate_sentry(value),
        OfflineValidationKind::PypiToken => validate_pypi(value),
        OfflineValidationKind::SlackToken => validate_slack(value),
    }
}

fn validate_crc32_base62(
    value: &[u8],
    skip: usize,
    payload: usize,
    checksum: usize,
) -> OfflineVerdict {
    let Some(required) = skip
        .checked_add(payload)
        .and_then(|size| size.checked_add(checksum))
    else {
        return OfflineVerdict::Indeterminate;
    };
    let Some(body) = value.get(skip..skip + payload) else {
        return OfflineVerdict::Indeterminate;
    };
    let Some(encoded) = value.get(skip + payload..required) else {
        return OfflineVerdict::Indeterminate;
    };
    crc_verdict(body, encoded)
}

fn crc_verdict(body: &[u8], encoded: &[u8]) -> OfflineVerdict {
    checksum_verdict(body, base62_u32(encoded))
}

// A checksum that does not decode as `u32` cannot represent a CRC32, so malformed or overflowing base-62 fields are invalid rather than unverifiable.
fn checksum_verdict(body: &[u8], expected: Option<u32>) -> OfflineVerdict {
    match expected {
        Some(expected) if crc32(body) == expected => OfflineVerdict::Valid,
        Some(_) | None => OfflineVerdict::Invalid,
    }
}

fn starts_with_ignore_ascii_case(value: &[u8], prefix: &[u8]) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

pub(crate) fn base62_u32(bytes: &[u8]) -> Option<u32> {
    let mut value = 0u64;
    for byte in bytes {
        let digit = match byte {
            b'0'..=b'9' => u64::from(byte - b'0'),
            b'A'..=b'Z' => u64::from(byte - b'A' + 10),
            b'a'..=b'z' => u64::from(byte - b'a' + 36),
            _ => return None,
        };
        value = value.checked_mul(62)?.checked_add(digit)?;
    }
    u32::try_from(value).ok()
}

pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

pub(crate) fn parse_hex_u32(bytes: &[u8]) -> Option<u32> {
    if bytes.len() != 8 {
        return None;
    }
    let mut value = 0u32;
    for byte in bytes {
        let digit = match byte {
            b'0'..=b'9' => u32::from(byte - b'0'),
            b'a'..=b'f' => u32::from(byte - b'a' + 10),
            b'A'..=b'F' => u32::from(byte - b'A' + 10),
            _ => return None,
        };
        value = value.checked_mul(16)?.checked_add(digit)?;
    }
    Some(value)
}

fn validate_aws(value: &[u8]) -> OfflineVerdict {
    if value.len() < 20 {
        return OfflineVerdict::Indeterminate;
    }
    let key = &value[..20];
    if !(key.starts_with(b"AKIA")
        || key.starts_with(b"ASIA")
        || key.starts_with(b"ABIA")
        || key.starts_with(b"ACCA")
        || key.starts_with(b"A3T"))
    {
        return OfflineVerdict::Indeterminate;
    }
    if key[4..]
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(byte))
    {
        OfflineVerdict::Valid
    } else {
        OfflineVerdict::Invalid
    }
}

fn validate_sentry(value: &[u8]) -> OfflineVerdict {
    if !value.starts_with(b"sntrys_") {
        return OfflineVerdict::Indeterminate;
    }
    let body = &value[7..];
    let Some(separator) = body.iter().rposition(|byte| *byte == b'_') else {
        return OfflineVerdict::Indeterminate;
    };
    if body.len().saturating_sub(separator + 1) < 43 {
        return OfflineVerdict::Indeterminate;
    }
    if base64_prefix(&body[..separator], b"{\"iat\":") {
        OfflineVerdict::Valid
    } else {
        OfflineVerdict::Invalid
    }
}

fn validate_pypi(value: &[u8]) -> OfflineVerdict {
    const HEADER: &[u8] = b"\x02\x01\x08pypi.org\x02";
    if !value.starts_with(b"pypi-") || value.len() < 21 {
        return OfflineVerdict::Indeterminate;
    }
    if base64url_prefix(&value[5..], HEADER) {
        OfflineVerdict::Valid
    } else {
        OfflineVerdict::Invalid
    }
}

// Unsupported prefixes and unparsable `xoxe` values return Indeterminate; malformed shapes for supported prefixes return Invalid. `xapp` requires only its first segment to start with a digit, while `xoxa` and `xoxr` allow one alphanumeric segment.
fn validate_slack(value: &[u8]) -> OfflineVerdict {
    if value.len() < 10 {
        return OfflineVerdict::Indeterminate;
    }
    let prefix = &value[..4];
    let body_start = if value.get(4) == Some(&b'-') {
        5
    } else if starts_with_ignore_ascii_case(value, b"xoxe.xox") {
        match value.iter().position(|byte| *byte == b'-') {
            Some(dash) => dash + 1,
            None => return OfflineVerdict::Indeterminate,
        }
    } else {
        return OfflineVerdict::Indeterminate;
    };
    let segments: Vec<&[u8]> = value[body_start..].split(|byte| *byte == b'-').collect();
    let leading = match segments.split_last() {
        Some((_, leading)) if !leading.is_empty() => leading,
        _ => &segments[..],
    };
    let starts_with_digit = |segment: &[u8]| segment.first().is_some_and(u8::is_ascii_digit);
    let shaped = if matches!(prefix, b"xoxa" | b"xoxr") {
        segments.first().is_some_and(|segment| {
            !segment.is_empty() && segment.iter().all(u8::is_ascii_alphanumeric)
        })
    } else if prefix.eq_ignore_ascii_case(b"xapp") {
        segments
            .first()
            .is_some_and(|segment| starts_with_digit(segment))
    } else if matches!(prefix, b"xoxb" | b"xoxp" | b"xoxo" | b"xoxs")
        || prefix.eq_ignore_ascii_case(b"xoxe")
    {
        leading.iter().all(|segment| starts_with_digit(segment))
    } else {
        return OfflineVerdict::Indeterminate;
    };
    if shaped {
        OfflineVerdict::Valid
    } else {
        OfflineVerdict::Invalid
    }
}

fn base64_prefix(input: &[u8], prefix: &[u8]) -> bool {
    decode_prefix(input, prefix, false)
}

fn base64url_prefix(input: &[u8], prefix: &[u8]) -> bool {
    decode_prefix(input, prefix, true)
}

pub(crate) fn decode_prefix(input: &[u8], prefix: &[u8], url: bool) -> bool {
    let mut bits = 0u32;
    let mut bit_count = 0u8;
    let mut output = 0usize;
    for byte in input {
        let value = match byte {
            b'A'..=b'Z' => u32::from(byte - b'A'),
            b'a'..=b'z' => u32::from(byte - b'a' + 26),
            b'0'..=b'9' => u32::from(byte - b'0' + 52),
            b'+' if !url => 62,
            b'/' if !url => 63,
            b'-' if url => 62,
            b'_' if url => 63,
            b'=' if !url => continue,
            _ => return false,
        };
        bits = (bits << 6) | value;
        bit_count += 6;
        while bit_count >= 8 {
            bit_count -= 8;
            let decoded = (bits >> bit_count) as u8;
            if prefix.get(output) != Some(&decoded) {
                return false;
            }
            output += 1;
            if output == prefix.len() {
                return true;
            }
            bits &= (1u32 << bit_count) - 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_classifier_is_closed() {
        for scalar in [
            "0",
            "-1.5",
            "+2e10",
            ".5",
            "-.25",
            "+.5",
            ".5e3",
            "5.",
            "-5.",
            "true",
            "false",
            "null",
            "undefined",
            "True",
            "FALSE",
            "None",
            "nil",
            "NaN",
            "~",
            "",
            "   ",
            "\t\n",
            "\\n",
            "\\t",
            "\\r\\n",
            " \\n ",
            "0x10",
            "0X1F",
            "0o755",
            "0b1010",
            "-0x10",
            "0xdeadbeef",
        ] {
            assert!(is_scalar(scalar.as_bytes()), "{scalar:?}");
        }
        for secret in [
            "12x",
            "hunter2",
            "true-blue",
            "nilpotent",
            "nonement",
            ".",
            "-.",
            ".x",
            "5.5.5",
            "0x",
            "0xz",
            "0o8",
            "0b2",
            "0x123456789",
            "0xdeadbeefcafe1234",
            "\\\\",
            "\\nhunter2",
            "\\x",
        ] {
            assert!(!is_scalar(secret.as_bytes()), "{secret:?}");
        }
    }

    #[test]
    fn crc32_matches_standard_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    fn alternation_rule(declaration: &str) -> Rule {
        let declaration: crate::rules::RuleDeclaration = serde_json::from_str(declaration).unwrap();
        let regex = regex::bytes::RegexBuilder::new(&declaration.regex)
            .unicode(false)
            .build()
            .unwrap();
        Rule {
            source: RuleSource::ConservativeOverlay,
            declaration,
            regex,
            keyword_matcher: None,
            suppressor_matcher: None,
        }
    }

    const KEYED_RULE_NAMES: [&str; 7] = [
        "magic-keyed-assignment",
        "magic-keyed-assignment-double-quoted",
        "magic-keyed-assignment-single-quoted",
        "magic-keyed-double-quoted",
        "magic-keyed-single-quoted",
        "magic-keyed-double-single",
        "magic-keyed-single-double",
    ];

    const KEYED_KEYWORDS: [&str; 7] = [
        "key",
        "token",
        "secret",
        "password",
        "auth",
        "bearer",
        "credential",
    ];

    const RULE_SPACE_BYTES: [u8; 6] = [b'\t', b'\n', 0x0B, b'\x0C', b'\r', b' '];

    const UNQUOTED_VALUE_TERMINATORS: [u8; 11] = *b"'\"`;&|<>()$";

    fn embedded_rule<'a>(rules: &'a RuleSet, name: &str) -> &'a Rule {
        rules
            .active(ScanProfile::Comprehensive)
            .find(|rule| rule.declaration.name == name)
            .unwrap_or_else(|| panic!("no embedded rule named {name}"))
    }

    /// Every regex match, including the empty-value ones `candidate_spans` counts but does not evaluate.
    fn regex_candidates(rule: &Rule, input: &str) -> Vec<CandidateSpans> {
        rule.regex
            .captures_iter(input.as_bytes())
            .map(|captures| {
                let group = |name: &str| {
                    let found = captures.name(name).unwrap();
                    TextSpan::snapped(input, found.start(), found.end()).unwrap()
                };
                let full = captures.get(0).unwrap();
                let spans = CandidateSpans {
                    full: TextSpan::snapped(input, full.start(), full.end()).unwrap(),
                    value: group("value"),
                    key: Some(group("key")),
                };
                let evaluated = candidate_spans(rule, &captures, input).unwrap();
                assert_eq!(evaluated, (!spans.value.is_empty()).then_some(spans));
                spans
            })
            .collect()
    }

    /// Replays the probe loop in `evaluate` and reports the candidates with the number of probes it took.
    fn fast_path_candidates(form: KeyedForm, input: &str) -> (Vec<CandidateSpans>, usize) {
        let bytes = input.as_bytes();
        let mut candidates = Vec::new();
        let mut probes = 0;
        let mut cursor = 0;
        while let Some(at) =
            memchr::memchr(form.anchor(), &bytes[cursor..]).map(|offset| cursor + offset)
        {
            probes += 1;
            match form.probe(input, at, cursor).unwrap() {
                Probe::Candidate(spans) => {
                    cursor = spans.full.end();
                    candidates.push(spans);
                }
                Probe::Skip(next) => {
                    assert!(next > at, "{form:?} did not advance past {at} in {input:?}");
                    cursor = next;
                }
            }
        }
        (candidates, probes)
    }

    fn assert_fast_path_replays_embedded_regex(rules: &RuleSet, input: &str) {
        for name in KEYED_RULE_NAMES {
            let rule = embedded_rule(rules, name);
            let form = KeyedForm::for_rule(name).unwrap();
            let (actual, _) = fast_path_candidates(form, input);
            assert_eq!(actual, regex_candidates(rule, input), "{name} on {input:?}");
        }
    }

    /// Every `magic-keyed-*` rule in the overlay has a fast path, and every fast path names an overlay rule.
    #[test]
    fn keyed_forms_and_embedded_keyed_rules_correspond() {
        let rules = RuleSet::from_embedded().unwrap();
        let mut embedded: Vec<_> = rules
            .active(ScanProfile::Comprehensive)
            .map(|rule| rule.declaration.name.as_str())
            .filter(|name| name.starts_with("magic-keyed"))
            .collect();
        embedded.sort_unstable();
        let mut forms = KEYED_RULE_NAMES.to_vec();
        forms.sort_unstable();
        assert_eq!(embedded, forms);
        for name in KEYED_RULE_NAMES {
            assert!(
                KeyedForm::for_rule(name).is_some(),
                "{name} has no fast path"
            );
        }
    }

    // `KeyedForm::probe` hand-codes each regex below, so a change to one of them must be paired with a change to the fast path.
    #[test]
    fn keyed_rule_regexes_are_pinned_to_the_fast_path() {
        let rules = RuleSet::from_embedded().unwrap();
        for (name, regex) in [
            (
                "magic-keyed-assignment",
                r#"(?i)(?-u:\b)(?P<key>[A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*(?P<value>(?:[^\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}'"`;&|<>()$\\]|\\.)+)"#,
            ),
            (
                "magic-keyed-assignment-double-quoted",
                r#"(?i)(?-u:\b)(?P<key>[A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*"(?P<value>(?:[^"\\]|\\.)*)""#,
            ),
            (
                "magic-keyed-assignment-single-quoted",
                r#"(?i)(?-u:\b)(?P<key>[A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*'(?P<value>(?:[^'\\]|\\.)*)'"#,
            ),
            (
                "magic-keyed-double-quoted",
                r#"(?i)"(?P<key>(?:[^"\\]|\\.)*(?:key|token|secret|password|auth|bearer|credential)(?:[^"\\]|\\.)*)"[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*:[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*"(?P<value>(?:[^"\\]|\\.)*)""#,
            ),
            (
                "magic-keyed-single-quoted",
                r#"(?i)'(?P<key>(?:[^'\\]|\\.)*(?:key|token|secret|password|auth|bearer|credential)(?:[^'\\]|\\.)*)'[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*:[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*'(?P<value>(?:[^'\\]|\\.)*)'"#,
            ),
            (
                "magic-keyed-double-single",
                r#"(?i)"(?P<key>(?:[^"\\]|\\.)*(?:key|token|secret|password|auth|bearer|credential)(?:[^"\\]|\\.)*)"[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*:[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*'(?P<value>(?:[^'\\]|\\.)*)'"#,
            ),
            (
                "magic-keyed-single-double",
                r#"(?i)'(?P<key>(?:[^'\\]|\\.)*(?:key|token|secret|password|auth|bearer|credential)(?:[^'\\]|\\.)*)'[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*:[\t\n\x0B\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*"(?P<value>(?:[^"\\]|\\.)*)""#,
            ),
        ] {
            assert_eq!(
                embedded_rule(&rules, name).declaration.regex,
                regex,
                "{name} changed; update `KeyedForm::probe` and its differential tests"
            );
        }
    }

    #[test]
    fn keyed_fast_paths_replay_embedded_regex_spans() {
        let rules = RuleSet::from_embedded().unwrap();
        for input in [
            "password=hunter2",
            "API_TOKEN = Ab3fGh1jKlMnOpQrStUv",
            "prefix password=abc\\ def next",
            "password=first token=second",
            "monkey=value",
            "xpassword=value",
            ".token=value",
            "-token=value",
            "a.password=value",
            "a-.password=value",
            "1.2.token=value",
            "token=one;password=two",
            "token=\"quoted\"",
            "token=single'quoted",
            "token=",
            "key=\"\"",
            "token=''",
            "\"key\":\"\"",
            "token=one\\",
            "token=\\",
            "token=one\\ two key=three",
            "token=abcdefghij12345\\\nplaceholder",
            "token=abcdefghij12345\\\nmore",
            "token=abcdefghij12345\\\rmore",
            "password = token = abcdefghij12345",
            "k=key = key = v",
            "password\x0B=secret",
            "password=\x0Bsecret",
            "api_key = \"secret\\\"value\" token=\"next\"",
            "api_key = 'secret\\'value' token='next'",
            "api_key = \"abcdefghij12345\\\nmore\"",
            "api_key = 'abcdefghij12345\\\nmore'",
            "api_key = \"abc\\",
            "api_key = \"abc",
            "password=\"\\\"password=\\\"password=\\\"",
            "\"api\\\"key\": \"secret\\\"value\" \"token\":\"next\"",
            "'api\\'key': 'secret\\'value' 'token':'next'",
            "\"api\\\"key\": 'secret\\'value' \"token\":'next'",
            "'api\\'key': \"secret\\\"value\" 'token':\"next\"",
            "\"a\\key\": \"Ab3fGh1jKlMnOpQrStUv\"",
            "\"\\\\key\": \"Ab3fGh1jKlMnOpQrStUv\"",
            "\"key\": \"AAAA\\\nBBBB\"password\": \"AbCdEf1234567890x\"",
            "\"a\\\n\"key\":\"v\"",
            "\"x\" \"password\":\"v\"",
            "\"x\\\" \"key\":\"v\"",
            "\"key\": x \"key\": x \"key\": \"v\"",
            "\"key\"\x0B:\"v\"",
            "\"key\": \"\\\"\\\"\\\"",
            "\"\\\"\\\"\\\"key\": x",
            "'password':\"v\" \"password\":'v'",
        ] {
            assert_fast_path_replays_embedded_regex(&rules, input);
        }
    }

    // Each rule's separators, keywords, and terminators are hand-coded in the fast path; the embedded regex is the oracle.
    #[test]
    fn keyed_fast_paths_accept_every_keyword_and_separator_the_rules_accept() {
        let rules = RuleSet::from_embedded().unwrap();
        let secret = "hunter2AbCdEf123456";
        for keyword in KEYED_KEYWORDS {
            for separator in RULE_SPACE_BYTES {
                let gap = char::from(separator);
                for (form, input) in [
                    (
                        "magic-keyed-assignment",
                        format!("x_{keyword}{gap}=x{secret}"),
                    ),
                    (
                        "magic-keyed-assignment",
                        format!("{keyword}={gap}x{secret}"),
                    ),
                    (
                        "magic-keyed-assignment-double-quoted",
                        format!("{keyword}={gap}\"x{secret}\""),
                    ),
                    (
                        "magic-keyed-assignment-single-quoted",
                        format!("{keyword}={gap}'x{secret}'"),
                    ),
                    (
                        "magic-keyed-double-quoted",
                        format!("\"{keyword}\"{gap}:\"x{secret}\""),
                    ),
                    (
                        "magic-keyed-single-quoted",
                        format!("'{keyword}'{gap}:'x{secret}'"),
                    ),
                    (
                        "magic-keyed-double-single",
                        format!("\"{keyword}\":{gap}'x{secret}'"),
                    ),
                    (
                        "magic-keyed-single-double",
                        format!("'{keyword}':{gap}\"x{secret}\""),
                    ),
                ] {
                    let rule = embedded_rule(&rules, form);
                    let expected = regex_candidates(rule, &input);
                    assert_eq!(expected.len(), 1, "{form} does not match {input:?}");
                    assert_fast_path_replays_embedded_regex(&rules, &input);
                    let report = evaluate(
                        &rules,
                        ScanProfile::Conservative,
                        ScanLimits::default(),
                        [0u8; 32],
                        &input,
                    )
                    .unwrap();
                    let reported: Vec<_> = report
                        .findings
                        .iter()
                        .filter(|finding| finding.rule_id == form)
                        .map(|finding| finding.value_span)
                        .collect();
                    assert_eq!(reported, [expected[0].value], "{form} on {input:?}");
                }
            }
        }
    }

    #[test]
    fn keyed_fast_path_stops_unquoted_values_at_every_terminator_the_rule_stops_at() {
        let rules = RuleSet::from_embedded().unwrap();
        let rule = embedded_rule(&rules, "magic-keyed-assignment");
        for terminator in UNQUOTED_VALUE_TERMINATORS
            .into_iter()
            .chain(RULE_SPACE_BYTES)
        {
            let input = format!("password=hunter2AbCdEf{}tail", char::from(terminator));
            let expected = regex_candidates(rule, &input);
            assert_eq!(expected.len(), 1, "{input:?}");
            assert_eq!(
                &input[expected[0].value.start()..expected[0].value.end()],
                "hunter2AbCdEf",
                "{input:?}"
            );
            assert_fast_path_replays_embedded_regex(&rules, &input);
        }
        for content in *b"#,./:=@\\" {
            let input = format!("password=hunter2{}AbCdEf", char::from(content));
            let expected = regex_candidates(rule, &input);
            assert_eq!(expected.len(), 1, "{input:?}");
            assert_fast_path_replays_embedded_regex(&rules, &input);
        }
    }

    // A probe that restarts one byte after a rejected anchor rescans every escaped quote in the rejected region, which is quadratic in the input.
    #[test]
    fn keyed_fast_paths_probe_each_rejected_region_once() {
        let rules = RuleSet::from_embedded().unwrap();
        let escaped_quotes = "\\\"".repeat(2_000);
        for (name, input, max_probes) in [
            (
                "magic-keyed-double-quoted",
                format!("\"key\"{escaped_quotes}"),
                3,
            ),
            (
                "magic-keyed-double-quoted",
                format!("\"key\": \"{escaped_quotes}"),
                4,
            ),
            (
                "magic-keyed-double-quoted",
                format!("\"{escaped_quotes}key\": x"),
                3,
            ),
            (
                "magic-keyed-assignment-double-quoted",
                format!("password=\"{}", "\\\"password=".repeat(2_000)),
                1,
            ),
            (
                "magic-keyed-double-quoted",
                format!("\"a\\\n{}", "\"key\": x".repeat(2_000)),
                4_001,
            ),
        ] {
            let form = KeyedForm::for_rule(name).unwrap();
            let (actual, probes) = fast_path_candidates(form, &input);
            assert!(
                probes <= max_probes,
                "{name} took {probes} probes on {input:.40?}"
            );
            assert_eq!(
                actual,
                regex_candidates(embedded_rule(&rules, name), &input)
            );
        }
    }

    // Pieces that exercise every keyword, separator, quote, escape, and terminator the keyed rules distinguish.
    const KEYED_INPUT_PIECES: [&str; 18] = [
        "key", "TOKEN", "Password", "=", ":", "\"", "'", "\\", "\n", "\x0B", " ", ";", "$", ".",
        "-", "_", "a", "Z9",
    ];

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(2_000))]
        #[test]
        fn keyed_fast_paths_replay_embedded_regex_spans_on_generated_input(
            pieces in proptest::collection::vec(0..KEYED_INPUT_PIECES.len(), 0..24)
        ) {
            let input: String = pieces.iter().map(|&piece| KEYED_INPUT_PIECES[piece]).collect();
            assert_fast_path_replays_embedded_regex(&EMBEDDED_RULES_FOR_TESTS, &input);
        }
    }

    static EMBEDDED_RULES_FOR_TESTS: std::sync::LazyLock<RuleSet> =
        std::sync::LazyLock::new(|| RuleSet::from_embedded().unwrap());

    // `evaluate` skips `hashicorp-tf-password` when the input holds no double quote; the rule's value group requires one.
    #[test]
    fn hashicorp_password_skip_requires_a_double_quote_in_every_match() {
        let rules = RuleSet::from_embedded().unwrap();
        let rule = embedded_rule(&rules, "hashicorp-tf-password");
        assert_eq!(
            rule.declaration.regex,
            r#"(?i)[\w.-]{0,50}?(?:administrator_login_password|password)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}("[a-z0-9=_\-]{8,20}")(?:[\x60'"\s;]|\\[nr]|$)"#,
            "hashicorp-tf-password changed; recheck the double-quote skip in `evaluate`"
        );
        let quoted = r#"password = "kq7v2m9xw4zt""#;
        assert_eq!(rule.regex.captures_iter(quoted.as_bytes()).count(), 1);
        for unquoted in [
            "password = 'kq7v2m9xw4zt'",
            "password = `kq7v2m9xw4zt`",
            "password = kq7v2m9xw4zt",
        ] {
            assert!(!rule.regex.is_match(unquoted.as_bytes()), "{unquoted:?}");
        }
        let report = evaluate(
            &rules,
            ScanProfile::Comprehensive,
            ScanLimits::default(),
            [0u8; 32],
            quoted,
        )
        .unwrap();
        assert!(
            report
                .findings
                .iter()
                .any(|finding| finding.rule_id == "hashicorp-tf-password"),
            "{:?}",
            report.findings
        );
    }

    #[test]
    fn prepared_case_insensitive_any_replays_scalar_work() {
        let needles = vec![
            "placeholder".to_owned(),
            "example".to_owned(),
            "changeme".to_owned(),
        ];
        assert_prepared_replays_scalar_work(
            &needles,
            &[
                b"ordinary text".as_slice(),
                b"EXAMPLE value".as_slice(),
                b"prefix ChangeMe".as_slice(),
            ],
        );
    }

    // Case-insensitive duplicate needles at one offset make scalar work stop at the lowest matching pattern index, not the number of reported matches.
    #[test]
    fn prepared_case_insensitive_any_replays_scalar_work_for_case_duplicate_needles() {
        let needles = vec![
            "placeholder".to_owned(),
            "PLACEHOLDER".to_owned(),
            "example".to_owned(),
            "EXAMPLE".to_owned(),
        ];
        assert_prepared_replays_scalar_work(
            &needles,
            &[
                b"ordinary text".as_slice(),
                b"placeholder value".as_slice(),
                b"PLACEHOLDER value".as_slice(),
                b"PlaceHolder value".as_slice(),
                b"an example and a PLACEHOLDER".as_slice(),
                b"an EXAMPLE only".as_slice(),
            ],
        );
    }

    fn assert_prepared_replays_scalar_work(needles: &[String], haystacks: &[&[u8]]) {
        let matcher = AhoCorasick::builder()
            .ascii_case_insensitive(true)
            .build(needles)
            .unwrap();
        for haystack in haystacks {
            for max_work_bytes in 0..=haystack.len() * needles.len() + 1 {
                let limits = ScanLimits {
                    max_work_bytes,
                    ..ScanLimits::default()
                };
                let mut scalar_work = 0;
                let scalar = contains_any_charged_ignore_case_scalar(
                    haystack,
                    needles,
                    &mut scalar_work,
                    limits,
                );
                let mut prepared_work = 0;
                let prepared = contains_any_charged_ignore_case(
                    haystack,
                    needles,
                    Some(&matcher),
                    &mut prepared_work,
                    limits,
                );
                assert_eq!(scalar_work, prepared_work);
                assert!(prepared_work <= max_work_bytes || prepared.is_err());
                assert_eq!(scalar.is_ok(), prepared.is_ok());
                if let (Ok(scalar), Ok(prepared)) = (scalar, prepared) {
                    assert_eq!(scalar, prepared);
                }
            }
        }
    }

    fn only_candidate(rule: &Rule, input: &str) -> Result<Option<Finding>, Abort> {
        let rules = RuleSet::from_embedded().unwrap();
        let captures = rule.regex.captures(input.as_bytes()).unwrap();
        let mut work = 0usize;
        evaluate_candidate(
            &rules,
            rule,
            &captures,
            input,
            &mut work,
            ScanLimits::default(),
        )
    }

    #[test]
    fn a_declared_value_group_that_does_not_participate_skips_the_candidate() {
        let rule = alternation_rule(
            r#"{"name":"t-value","regex":"(?:alpha=(?P<value>[A-Za-z0-9]{20})|beta)","anchors":["alpha"],"radius":16,"value_group":"value"}"#,
        );
        assert!(matches!(only_candidate(&rule, "beta"), Ok(None)));
        assert!(matches!(
            only_candidate(&rule, "alpha=Ab3fGh1jKlMnOpQrStUv"),
            Ok(Some(_))
        ));
    }

    #[test]
    fn a_declared_secret_group_that_does_not_participate_skips_the_candidate() {
        let rule = alternation_rule(
            r#"{"name":"t-secret","regex":"(?:alpha=([A-Za-z0-9]{20})|beta=[A-Za-z0-9]{20})","anchors":["alpha"],"radius":16,"secret_group":1}"#,
        );
        assert!(matches!(
            only_candidate(&rule, "beta=Ab3fGh1jKlMnOpQrStUv"),
            Ok(None)
        ));
        assert!(matches!(
            only_candidate(&rule, "alpha=Ab3fGh1jKlMnOpQrStUv"),
            Ok(Some(_))
        ));
    }

    #[test]
    fn a_declared_key_group_that_does_not_participate_skips_the_candidate() {
        let rule = alternation_rule(
            r#"{"name":"t-key","regex":"(?:(?P<key>[a-z_]*token)=[A-Za-z0-9]{20}|beta=[A-Za-z0-9]{20})","anchors":["token"],"radius":16,"key_group":"key"}"#,
        );
        assert!(matches!(
            only_candidate(&rule, "beta=Ab3fGh1jKlMnOpQrStUv"),
            Ok(None)
        ));
        assert!(matches!(
            only_candidate(&rule, "auth_token=Ab3fGh1jKlMnOpQrStUv"),
            Ok(Some(_))
        ));
    }
}
