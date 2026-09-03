//! Deterministic secret redaction backed by the in-tree scanner.

mod scanner;

use std::sync::LazyLock;

use mc_secret_scanner::{
    ConstructionError, LimitExhausted, ScanError, ScanLimits, ScanProfile, Scanner,
};

pub const DETECTOR_ID: &str = "mc-secret-scanner";

/// Longest text `redact_durable_text` can inspect.
///
/// Above this the scan fails and the whole value is replaced by one placeholder,
/// because text that cannot be inspected cannot be shown to be secret-free. A
/// caller that must preserve its content has to reject the value at this length
/// instead of redacting it, since the placeholder is not recoverable.
pub const MAX_REDACTABLE_BYTES: usize = mc_secret_scanner::MAX_INPUT_BYTES;

const LABEL_WORDS: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "auth",
    "authorization",
    "bearer",
    "credential",
];
const LABEL_QUALIFIERS: &[&str] = &[
    "api",
    "access",
    // A qualifier missing here is not a cosmetic gap: a compound name whose only label word
    // is the bare `key` reduces to a structural label, and a structural label skips content
    // scanning. `signing_key` must not be read the way `target_key` is.
    "signing",
    "signature",
    "webhook",
    "encryption",
    "hmac",
    "master",
    "refresh",
    "private",
    "client",
    "auth",
    "authorization",
    "secret",
    "bearer",
    "session",
    "refresh",
    "service",
    "x",
    "openai",
    "anthropic",
    "google",
    "github",
    "huggingface",
    "aws",
    "azure",
    // The scanner's KEY_QUALIFIERS carries these and its contract test requires names like
    // `dbapikey`, so a qualifier it recognises and this gate does not is a bypass. Only the
    // credential prefixes are mirrored: the scanner also lists payload and encoding words
    // (`hash`, `value`, `id`, `path`, `data`, `file`, `env`) for matching *after* a secret
    // word, and treating those as credential qualifiers would make `file_key` and `data_key`
    // credentials, which is the false positive the bare-`key` carve-out exists to avoid.
    "db",
    "database",
    "admin",
    "root",
    "app",
    "application",
    "consumer",
    "oauth",
    "jwt",
    "shared",
    "user",
    "vault",
    "gcp",
    "gitlab",
    "slack",
    "stripe",
    "twilio",
];
/// Payload and encoding words the scanner matches after a secret word.
/// `apikeyvalue` reads as `api_key_value`.
/// Rejecting them as label segments keeps `file_key`, `value_key`, and `keyid` structural.
const LABEL_AFFIXES: &[&str] = &[
    "b64", "base64", "data", "env", "file", "hash", "hex", "id", "name", "path", "plain", "prefix",
    "ref", "string", "text", "value",
];
/// Longest word in the three vocabularies plus a plural suffix bounds cover-scan spans.
const MAX_VOCABULARY_WORD_BYTES: usize = "authorization".len() + 1;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionErrorKind {
    Construction,
    InputLimit,
    CandidateLimit,
    WorkLimit,
    InvalidSpan,
    UnknownRule,
    /// A field that must stay verbatim was found to hold a secret, so the
    /// write is refused rather than redacted: redaction would alias
    /// distinct values onto one placeholder.
    SecretDetected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{}", redaction_error_message(.kind))]
pub struct RedactionError {
    pub(crate) kind: RedactionErrorKind,
}

impl RedactionError {
    #[must_use]
    pub const fn kind(self) -> RedactionErrorKind {
        self.kind
    }
}

fn redaction_error_message(kind: &RedactionErrorKind) -> &'static str {
    match kind {
        RedactionErrorKind::Construction => "secret redactor construction failed",
        RedactionErrorKind::InputLimit => "secret scan input limit exceeded",
        RedactionErrorKind::CandidateLimit => "secret scan candidate limit exceeded",
        RedactionErrorKind::WorkLimit => "secret scan work limit exceeded",
        RedactionErrorKind::InvalidSpan => "secret scan produced an invalid span",
        RedactionErrorKind::UnknownRule => "secret scan produced an unclassified rule",
        RedactionErrorKind::SecretDetected => "secret-bearing field was rejected",
    }
}

impl From<ConstructionError> for RedactionError {
    fn from(_: ConstructionError) -> Self {
        Self {
            kind: RedactionErrorKind::Construction,
        }
    }
}

impl From<ScanError> for RedactionError {
    fn from(error: ScanError) -> Self {
        let kind = match error {
            ScanError::InputLimitExceeded => RedactionErrorKind::InputLimit,
            ScanError::InvalidSpan => RedactionErrorKind::InvalidSpan,
        };
        Self { kind }
    }
}

pub struct Redactor {
    scanner: Scanner,
}

impl Redactor {
    pub fn new() -> Result<Self, RedactionError> {
        Self::with_limits(ScanLimits::default())
    }

    fn with_limits(limits: ScanLimits) -> Result<Self, RedactionError> {
        Ok(Self {
            scanner: Scanner::with_limits(ScanProfile::Comprehensive, limits)?,
        })
    }

    pub fn redact(&self, input: &str) -> Result<Redaction, RedactionError> {
        let report = self.scanner.scan(input)?;
        if let Some(limit) = report.limits_hit {
            return Err(RedactionError {
                kind: match limit {
                    LimitExhausted::Candidates => RedactionErrorKind::CandidateLimit,
                    LimitExhausted::Work => RedactionErrorKind::WorkLimit,
                },
            });
        }
        scanner::redact(input, &report.findings)
    }
}

static REDACTOR: LazyLock<Result<Redactor, RedactionError>> = LazyLock::new(Redactor::new);

/// Transaction bodies carry many fields at once, so they scan under higher
/// candidate and work ceilings than a single durable field. Without them a
/// large transaction would exhaust the default budget and be replaced whole.
const TRANSACTION_SCAN_LIMITS: ScanLimits = ScanLimits {
    max_input_bytes: mc_secret_scanner::MAX_INPUT_BYTES,
    max_candidates: 524_288,
    max_work_bytes: 1024 * 1024 * 1024,
};

const _: () = {
    let default = ScanLimits::DEFAULT;
    assert!(TRANSACTION_SCAN_LIMITS.max_candidates >= default.max_candidates);
    assert!(TRANSACTION_SCAN_LIMITS.max_work_bytes >= default.max_work_bytes);
    assert!(TRANSACTION_SCAN_LIMITS.max_input_bytes >= default.max_input_bytes);
};

static TRANSACTION_REDACTOR: LazyLock<Result<Redactor, RedactionError>> =
    LazyLock::new(|| Redactor::with_limits(TRANSACTION_SCAN_LIMITS));

pub fn redact_durable_text(input: &str) -> Redaction {
    redact_with(&REDACTOR, input)
}

fn redact_with(redactor: &Result<Redactor, RedactionError>, input: &str) -> Redaction {
    match redactor
        .as_ref()
        .map_err(|error| *error)
        .and_then(|redactor| redactor.redact(input))
    {
        Ok(redaction) => redaction,
        Err(_) => Redaction {
            text: "<REDACTED:secret>".to_owned(),
            detections: vec![Detection {
                detector_id: DETECTOR_ID,
                secret_type: "secret".to_owned(),
                offset: 0,
                length: input.len(),
            }],
        },
    }
}

/// Redacts a transaction body under the transaction ceilings. Fails closed
/// the same way `redact_durable_text` does.
pub fn redact_transaction_durable_text(input: &str) -> Redaction {
    redact_with(&TRANSACTION_REDACTOR, input)
}

/// Identifies the detector build that produced a redaction, for the audit
/// receipt a durable write records alongside it.
pub fn detector_revision() -> String {
    REDACTOR.as_ref().map_or_else(
        |_| "unavailable".to_owned(),
        |redactor| {
            let revision = redactor.scanner.revision();
            format!(
                "{}:{}:{}",
                revision.crate_version, revision.semantic_digest_version, revision.upstream_commit
            )
        },
    )
}

/// Digest of the rule semantics the detector ran, or `None` when the
/// detector could not be built.
pub fn detector_semantic_digest() -> Option<[u8; 32]> {
    REDACTOR
        .as_ref()
        .ok()
        .map(|redactor| redactor.scanner.semantic_digest())
}

/// Refuses `input` when the scanner classifies any of it as secret. Used
/// for fields that must stay verbatim, such as lookup keys and dedup
/// identities, where substituting a placeholder would merge distinct
/// values.
pub fn reject_secret_text(input: &str) -> Result<(), RedactionError> {
    reject(redact_durable_text(input))
}

/// Transaction-ceiling counterpart of `reject_secret_text`.
pub fn reject_transaction_secret_text(input: &str) -> Result<(), RedactionError> {
    reject(redact_transaction_durable_text(input))
}

fn reject(redaction: Redaction) -> Result<(), RedactionError> {
    if redaction.detections.is_empty() {
        Ok(())
    } else {
        Err(RedactionError {
            kind: RedactionErrorKind::SecretDetected,
        })
    }
}

/// Label for a key whose name alone marks its value secret, so a value
/// written under it is replaced even when the scanner finds nothing in it.
/// `None` when the name carries no secret word.
pub fn secret_key_label(key: &str) -> Option<String> {
    key_names_a_secret(key).then(|| redaction_type_for_key(key))
}

/// `key` and `keys` name JSON map entries rather than secrets. They are excluded
/// case-insensitively; `api_key` remains protected.
///
/// Recognition matches [`secret_shaped_json_key`], so a separator-free compound such as
/// `apikey` is protected too. A narrower test leaves that value neither substituted nor
/// refused, because the leaf scanner sees only the value and gains no key context from it.
pub fn protected_json_key_label(key: &str) -> Option<String> {
    secret_shaped_json_key(key).then(|| redaction_type_for_key(key))
}

/// Returns a label only when `key` has a credential qualifier.
///
/// `api_key` and `private_key` carry one.
/// `target_key` and `model_key` reduce to the bare `key` label and name structural rows.
pub fn qualified_secret_key_label(key: &str) -> Option<String> {
    secret_key_label(key).filter(|label| !matches!(label.as_str(), "key" | "keys"))
}

/// Whether a JSON field name has the shape the keyed scanner rules anchor on.
///
/// Keyed rules accept compound keys, unlike [`secret_key_label`].
/// Matching covers segments and the separator-free spelling of the same name.
/// Whole label words only: a substring test reads `author` as `auth`.
/// A substring test also misses `passWord`, whose split `pass_word` holds no label word.
///
/// `key` and `keys` are excluded case-insensitively, as in [`protected_json_key_label`].
pub fn secret_shaped_json_key(key: &str) -> bool {
    if matches!(key.to_ascii_lowercase().as_str(), "key" | "keys") {
        return false;
    }
    if key_names_a_secret(key) {
        // A name whose label reduces to the bare `key` carries no credential qualifier, so
        // it names a structural row: `target_key` and `stream_key`, not `api_key`. Reading
        // it as a credential refuses ordinary vocabulary, and disagreeing with
        // `qualified_secret_key_label` would make one name structural to the identity gate
        // and secret to this one.
        return !matches!(redaction_type_for_key(key).as_str(), "key" | "keys");
    }
    let joined = separate_words(key)
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>();
    undelimited_names_a_credential(&joined)
}

/// A full vocabulary cover must hold a label word and a non-`key` label segment.
///
/// A qualifier can precede the label and an affix can follow it.
/// [`vocabulary_reach`] searches both ends so `apikeyvalue` is classified like `api_key_value`.
/// A prefix-only walk classifies `apikeyvalue` as structural.
///
/// Affixes cover a name without qualifying it, so `keyvalue` and `keyid` stay structural
/// exactly as `key_value` and `key_id` do.
fn undelimited_names_a_credential(joined: &str) -> bool {
    let from_start = vocabulary_reach(joined, false);
    let to_end = vocabulary_reach(joined, true);
    if !from_start[joined.len()] {
        return false;
    }
    let mut names_a_label = false;
    let mut names_a_qualified_segment = false;
    for start in 0..joined.len() {
        if !from_start[start] {
            continue;
        }
        let last = (start + MAX_VOCABULARY_WORD_BYTES).min(joined.len());
        for end in start + 1..=last {
            if !to_end[end] {
                continue;
            }
            let word = &joined[start..end];
            if !names_a_vocabulary_word(word) {
                continue;
            }
            names_a_label |= names_a_label_word(word);
            names_a_qualified_segment |= is_label_segment(word) && plural_stem(word) != "key";
        }
    }
    names_a_label && names_a_qualified_segment
}

/// Returns positions reachable by a vocabulary cover from either end of `joined`.
/// A position both walks reach is a word boundary of some cover.
fn vocabulary_reach(joined: &str, reverse: bool) -> Vec<bool> {
    let length = joined.len();
    let mut reach = vec![false; length + 1];
    reach[if reverse { length } else { 0 }] = true;
    for step in 0..=length {
        let at = if reverse { length - step } else { step };
        if !reach[at] {
            continue;
        }
        for span in 1..=MAX_VOCABULARY_WORD_BYTES {
            let (start, end) = if reverse {
                match at.checked_sub(span) {
                    Some(start) => (start, at),
                    None => break,
                }
            } else if at + span <= length {
                (at, at + span)
            } else {
                break;
            };
            if names_a_vocabulary_word(&joined[start..end]) {
                reach[if reverse { start } else { end }] = true;
            }
        }
    }
    reach
}

/// Stemming `aws` yields `aw`, which no vocabulary holds, so a qualifier matches whole.
fn names_a_vocabulary_word(word: &str) -> bool {
    let stem = plural_stem(word);
    LABEL_WORDS.contains(&stem)
        || LABEL_QUALIFIERS.contains(&word)
        || LABEL_AFFIXES.contains(&word)
        || LABEL_AFFIXES.contains(&stem)
}

/// Whether `word` is a label word, tolerating a plural suffix as the segment test does.
fn names_a_label_word(word: &str) -> bool {
    LABEL_WORDS.contains(&plural_stem(word))
}

fn plural_stem(word: &str) -> &str {
    word.strip_suffix('s').unwrap_or(word)
}

fn key_names_a_secret(key: &str) -> bool {
    separate_words(key)
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|segment| {
            let stem = segment.strip_suffix('s').unwrap_or(segment);
            LABEL_WORDS.contains(&stem)
        })
}

#[must_use]
pub fn contains_redaction_token(text: &str) -> bool {
    text.contains("_REDACTED>") || text.contains("<REDACTED:")
}

pub const MAX_REDACTION_LABEL_BYTES: usize = 64;

fn redaction_type_for_key(key: &str) -> String {
    let label = separate_words(key)
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|segment| is_label_segment(segment))
        .collect::<Vec<_>>()
        .join("_");
    if label.is_empty() {
        return "secret".to_owned();
    }
    if label.len() <= MAX_REDACTION_LABEL_BYTES {
        return label;
    }
    // Truncate on a segment boundary so the label stays a `_`-joined run of whole label
    // words. Cutting mid-segment would invent a word that no key contained.
    match label[..=MAX_REDACTION_LABEL_BYTES].rfind('_') {
        Some(boundary) if boundary > 0 => label[..boundary].to_owned(),
        _ => "secret".to_owned(),
    }
}

/// Splits camel case so `apiKey` yields the same segments as `api_key`.
fn separate_words(key: &str) -> String {
    let characters = key.chars().collect::<Vec<_>>();
    let mut separated = String::with_capacity(key.len() + 8);
    for (index, character) in characters.iter().copied().enumerate() {
        let previous = index.checked_sub(1).map(|earlier| characters[earlier]);
        let lower_to_upper = character.is_ascii_uppercase()
            && previous
                .is_some_and(|earlier| earlier.is_ascii_lowercase() || earlier.is_ascii_digit());
        // `URLToken` ends an acronym at the last capital of the run, so the boundary sits
        // before a capital whose successor is lowercase. Without it the key stays one
        // segment, `urltoken`, and no label word matches.
        let acronym_to_word = character.is_ascii_uppercase()
            && previous.is_some_and(|earlier| earlier.is_ascii_uppercase())
            && characters
                .get(index + 1)
                .is_some_and(|next| next.is_ascii_lowercase());
        if lower_to_upper || acronym_to_word {
            separated.push('_');
        }
        separated.push(character);
    }
    separated
}

fn is_label_segment(segment: &str) -> bool {
    let stem = segment.strip_suffix('s').unwrap_or(segment);
    LABEL_WORDS.contains(&stem) || LABEL_QUALIFIERS.contains(&segment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_is_the_only_redaction_path() {
        let redaction = redact_durable_text("π password=hunter-two");
        assert_eq!(redaction.text, "π password=<REDACTED:password>");
        assert!(redaction
            .detections
            .iter()
            .all(|detection| detection.detector_id == DETECTOR_ID));
    }

    #[test]
    fn established_key_labels_remain_stable() {
        for (key, expected) in [
            ("x_auth_token", "x_auth_token"),
            ("client_secret", "client_secret"),
            ("aws_secret", "aws_secret"),
            ("apiKey", "api_key"),
            ("apikey", "secret"),
        ] {
            assert_eq!(redaction_type_for_key(key), expected, "{key}");
        }
    }

    #[test]
    fn scanner_limits_fail_closed() {
        let redactor = Redactor::with_limits(ScanLimits {
            max_work_bytes: 1,
            ..ScanLimits::default()
        })
        .unwrap();
        assert_eq!(
            redactor.redact("password=secret").unwrap_err().kind(),
            RedactionErrorKind::WorkLimit
        );
    }

    #[test]
    fn diagnostics_never_include_input() {
        let sentinel = "privacy-sentinel-password=secret";
        let input = format!(
            "{sentinel}{}",
            "x".repeat(mc_secret_scanner::MAX_INPUT_BYTES)
        );
        let error = Redactor::new()
            .unwrap()
            .redact(&input)
            .unwrap_err()
            .to_string();
        assert!(!error.contains(sentinel));
        assert!(!error.contains("secret="));
    }

    #[test]
    fn durable_redaction_hides_the_entire_field_on_scanner_failure() {
        let input = "password=sentinel".repeat(mc_secret_scanner::MAX_INPUT_BYTES);
        let redaction = redact_durable_text(&input);
        assert_eq!(redaction.text, "<REDACTED:secret>");
        assert_eq!(redaction.detections[0].length, input.len());
        assert!(!redaction.text.contains("sentinel"));
    }

    #[test]
    fn secret_shaped_keys_match_whole_label_words() {
        for key in [
            "passWord",
            "apikey",
            "authtoken",
            "api_key",
            "client_secret",
            "Authorization",
            "bearerToken",
        ] {
            assert!(
                secret_shaped_json_key(key),
                "expected {key} to be protected"
            );
        }
        for key in [
            "author",
            "authored_by",
            "key",
            "keys",
            "monkey",
            "keyboard",
            "display_path",
        ] {
            assert!(
                !secret_shaped_json_key(key),
                "expected {key} to stay writable"
            );
        }
    }

    #[test]
    fn only_qualified_key_names_mark_a_credential() {
        for key in [
            "api_key",
            "private_key",
            "access_key",
            "apiKey",
            "aws_secret_access_key",
        ] {
            assert!(
                qualified_secret_key_label(key).is_some(),
                "expected {key} to name a credential"
            );
        }
        for key in [
            "key",
            "keys",
            "last_model_key",
            "lineage_descent_target_key",
            "lineage_descent_source_key",
        ] {
            assert!(
                qualified_secret_key_label(key).is_none(),
                "expected {key} to name a structural row"
            );
        }
    }

    #[test]
    fn an_acronym_boundary_still_separates_label_words() {
        for key in ["URLToken", "SQLSecret", "APISecret", "AWSSecretKey"] {
            assert!(
                secret_shaped_json_key(key),
                "expected {key} to be protected"
            );
        }
    }

    #[test]
    fn a_bare_key_label_names_a_structural_row_everywhere() {
        // Both gates must agree: a name reducing to the bare `key` label is structural.
        for key in [
            "target_key",
            "stream_key",
            "key_id",
            "last_model_key",
            "primary_key",
        ] {
            assert!(
                !secret_shaped_json_key(key),
                "expected {key} to stay writable"
            );
            assert!(
                qualified_secret_key_label(key).is_none(),
                "{key} disagrees between the two gates"
            );
        }
        for key in ["api_key", "session_key", "private_key", "client_secret"] {
            assert!(secret_shaped_json_key(key), "expected {key} protected");
            assert!(
                qualified_secret_key_label(key).is_some(),
                "{key} disagrees between the two gates"
            );
        }
    }
}

#[cfg(test)]
mod qualifier_chain_tests {
    use super::*;

    /// The bare-`key` carve-out must only exempt names with no credential qualifier. A
    /// qualifier absent from `LABEL_QUALIFIERS` makes a credential name reduce to the
    /// structural label `key`, and a structural label skips content scanning entirely.
    #[test]
    fn a_credential_qualifier_keeps_a_key_name_scanned() {
        for key in [
            "signing_key",
            "signingKey",
            "webhook_key",
            "encryption_key",
            "hmac_key",
            "master_key",
            "refresh_token",
            "signature_key",
        ] {
            assert!(
                secret_shaped_json_key(key),
                "{key} carries a credential qualifier and must be scanned"
            );
            assert!(
                qualified_secret_key_label(key).is_some(),
                "{key} must resolve to a qualified label"
            );
        }

        // The carve-out itself must survive: these carry no credential qualifier.
        for key in [
            "target_key",
            "stream_key",
            "primary_key",
            "key_id",
            "last_model_key",
            "key",
        ] {
            assert!(
                !secret_shaped_json_key(key),
                "{key} names a structural row and must stay writable"
            );
            assert!(qualified_secret_key_label(key).is_none(), "{key}");
        }
    }

    /// An undelimited name can chain several qualifiers before its label word, so stripping
    /// only the first leaves a remainder that matches nothing.
    #[test]
    fn chained_qualifiers_still_reach_the_label_word() {
        for key in ["awssecretaccesskey", "awsaccesskey", "clientsecretkey"] {
            assert!(secret_shaped_json_key(key), "{key} must be scanned");
        }
    }

    /// This gate keeps its own qualifier vocabulary, so it can silently fall behind the
    /// scanner's. These names are the ones `mc-secret-scanner`'s own contract test requires
    /// the scanner to flag; a name the scanner treats as a credential must not be structural
    /// here, because structural means the value skips content scanning entirely.
    #[test]
    fn the_key_gate_agrees_with_the_scanner_contract_vocabulary() {
        for key in [
            "dbapikey",
            "databasepassword",
            "adminpassword",
            "rootpassword",
            "oauthtoken",
            "jwtsecret",
            "sharedsecret",
            "usertoken",
            "mastertoken",
            "servicekey",
            "vaultsecret",
            "slacktoken",
            "APIKEYVALUE",
            "tokenvalue",
            "secretname",
            "passwordhash",
        ] {
            assert!(
                secret_shaped_json_key(key),
                "the scanner flags {key}; this gate must not treat it as structural"
            );
        }

        // A payload word does not qualify a label word when it precedes or follows it.
        for key in [
            "file_key",
            "data_key",
            "env_key",
            "path_key",
            "value_key",
            "keyvalue",
            "keyid",
            "keyfile",
        ] {
            assert!(
                !secret_shaped_json_key(key),
                "{key} carries no credential qualifier and must stay writable"
            );
        }
    }

    /// Undelimited names follow delimiter-separated field-name semantics.
    /// A trailing qualifier is covered as well as a leading one.
    #[test]
    fn an_undelimited_name_is_gated_like_its_delimited_spelling() {
        for (delimited, undelimited) in [
            ("api_key_value", "apikeyvalue"),
            ("api_key_value", "APIKEYVALUE"),
            ("token_value", "tokenvalue"),
            ("secret_name", "secretname"),
            ("password_hash", "passwordhash"),
            ("aws_secret_access_key", "awssecretaccesskey"),
            ("api_keys", "apikeys"),
            ("key_value", "keyvalue"),
            ("key_id", "keyid"),
            ("key_file", "keyfile"),
            ("value_key", "valuekey"),
            ("file_key", "filekey"),
            ("data_key", "datakey"),
            ("public_key", "publickey"),
        ] {
            assert_eq!(
                secret_shaped_json_key(delimited),
                secret_shaped_json_key(undelimited),
                "{delimited} and {undelimited} name the same field"
            );
        }
    }

    /// The cover scan stops at [`MAX_VOCABULARY_WORD_BYTES`].
    #[test]
    fn the_vocabulary_stays_within_the_scan_bound() {
        for word in LABEL_WORDS
            .iter()
            .chain(LABEL_QUALIFIERS)
            .chain(LABEL_AFFIXES)
        {
            assert!(
                word.len() < MAX_VOCABULARY_WORD_BYTES,
                "{word} plus a plural exceeds the cover-scan span"
            );
        }
    }
}
