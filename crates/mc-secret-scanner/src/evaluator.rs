use regex::bytes::Captures;

use crate::api::REVISION;
use crate::rules::{
    EntropySpec, LocalContextSpec, OfflineValidationKind, OfflineValidationSpec, Rule, RuleSet,
};
use crate::{
    Finding, LimitExhausted, RuleSource, ScanError, ScanLimits, ScanProfile, ScanReport, TextSpan,
};

enum Abort {
    Work,
    Invalid(ScanError),
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

    'rules: for rule in rules.preselect(profile, bytes) {
        if add_work(&mut work, bytes.len(), limits.max_work_bytes).is_err() {
            limits_hit = Some(LimitExhausted::Work);
            break 'rules;
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
    let value = input
        .as_bytes()
        .get(value_span.start()..value_span.end())
        .ok_or(ScanError::InvalidSpan)?;
    if value.is_empty() {
        return Ok(None);
    }
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
        let mut matched = false;
        for key in keywords {
            if contains_charged_ignore_case(window, key.as_bytes(), work, limits)? {
                matched = true;
                break;
            }
        }
        if !matched {
            return Ok(None);
        }
    }
    if let Some(values) = &rule.declaration.value_suppressors_any {
        for item in values {
            if contains_charged(value, item.as_bytes(), work, limits)? {
                return Ok(None);
            }
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
    if rule.source == RuleSource::Upstream
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

// Unnamed captures hold secrets; named captures mark header fields. Ignore named captures so header-only rules return their whole match.
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

fn contains_charged(
    haystack: &[u8],
    needle: &[u8],
    work: &mut usize,
    limits: ScanLimits,
) -> Result<bool, Abort> {
    add_work(work, haystack.len(), limits.max_work_bytes)?;
    Ok(!needle.is_empty() && memchr::memmem::find(haystack, needle).is_some())
}

// Corpus rule patterns carry `(?i)`, so a case-sensitive keyword gate drops a
// secret whose key is spelled in mixed case. Value suppressors stay
// case-sensitive because widening them would suppress findings instead.
// commentlint: allow(JUDGE)
fn contains_charged_ignore_case(
    haystack: &[u8],
    needle: &[u8],
    work: &mut usize,
    limits: ScanLimits,
) -> Result<bool, Abort> {
    add_work(work, haystack.len(), limits.max_work_bytes)?;
    Ok(find_ignore_ascii_case(haystack, needle))
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

fn has_secret_key_token(key: &[u8]) -> bool {
    const TOKENS: &[&[u8]] = &[
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
        // Use exact token matches to avoid matching unrelated identifiers such as `monkey`, `turkey`, `keyboard`, `author`, `secretary`, and `tokenizer`.
        b"apikey",
        b"apikeys",
        b"apisecret",
        b"apitoken",
        b"apitokens",
        b"authkey",
        b"authsecret",
        b"authtoken",
        b"accesskey",
        b"accesskeys",
        b"accesssecret",
        b"accesstoken",
        b"accesstokens",
        b"appkey",
        b"appsecret",
        b"apptoken",
        b"bearertoken",
        b"clientkey",
        b"clientsecret",
        b"clienttoken",
        b"encryptionkey",
        b"privatekey",
        b"privatekeys",
        b"refreshtoken",
        b"refreshtokens",
        b"secretkey",
        b"secretkeys",
        b"secrettoken",
        b"sessionkey",
        b"sessionsecret",
        b"sessiontoken",
        b"signingkey",
        b"signingsecret",
    ];
    key_tokens(key).any(|token| TOKENS.iter().any(|word| token.eq_ignore_ascii_case(word)))
}

fn key_tokens(key: &[u8]) -> impl Iterator<Item = &[u8]> {
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

fn lowercase_percent(bytes: &[u8]) -> usize {
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

// `is_scalar` ignores ASCII case because languages capitalize null-like and boolean values differently; otherwise `password=None` is reported as a secret.
const SCALAR_KEYWORDS: &[&str] = &[
    "true",
    "false",
    "null",
    "undefined",
    "none",
    "nil",
    "nan",
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
    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let integer_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == integer_start {
        return false;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction_start {
            return false;
        }
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
        for key in keys {
            if contains_charged_ignore_case(before, key.as_bytes(), work, limits)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    Ok(true)
}

fn is_uuid(value: &[u8]) -> bool {
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

fn base62_u32(bytes: &[u8]) -> Option<u32> {
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

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn parse_hex_u32(bytes: &[u8]) -> Option<u32> {
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

fn validate_slack(value: &[u8]) -> OfflineVerdict {
    if value.len() < 10 {
        return OfflineVerdict::Indeterminate;
    }
    let prefix = &value[..4];
    if value.get(4) != Some(&b'-') && !value.starts_with(b"xoxe.xox") {
        return OfflineVerdict::Indeterminate;
    }
    if matches!(
        prefix,
        b"xoxb" | b"xoxp" | b"xoxo" | b"xoxs" | b"xoxa" | b"xoxr"
    ) || prefix.eq_ignore_ascii_case(b"xapp")
        || prefix.eq_ignore_ascii_case(b"xoxe")
    {
        OfflineVerdict::Valid
    } else {
        OfflineVerdict::Indeterminate
    }
}

fn base64_prefix(input: &[u8], prefix: &[u8]) -> bool {
    decode_prefix(input, prefix, false)
}

fn base64url_prefix(input: &[u8], prefix: &[u8]) -> bool {
    decode_prefix(input, prefix, true)
}

fn decode_prefix(input: &[u8], prefix: &[u8], url: bool) -> bool {
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
        ] {
            assert!(is_scalar(scalar.as_bytes()), "{scalar:?}");
        }
        for secret in [
            "12x",
            "hunter2",
            "true-blue",
            "nilpotent",
            "nonement",
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
