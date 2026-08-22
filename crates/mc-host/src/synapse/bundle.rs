//! Owner-provisioned model bundle: strict manifest schema, artifact
//! confinement, and byte-hash verification before any model construction.

use std::io::Read;
use std::path::{Path, PathBuf};

use rustix::fs::{Mode, OFlags};

use super::protocol::sha256_hex;
use super::{jobs, SynapseLimits};

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// Aggregate byte budget for all model weights a loaded bundle retains: the
/// ONNX graph plus every external initializer together. One budget bounds
/// the total because every buffer stays resident for the component's
/// lifetime, and an oversized bundle must degrade only this lane, never
/// exhaust host memory.
const MAX_MODEL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SIDE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EXTERNAL_INITIALIZERS: usize = 16;
const MAX_ARTIFACT_NAME_BYTES: usize = 255;
const MAX_PROVENANCE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_DIMS: u64 = 16_384;
const MAX_MAX_TOKENS: u64 = 1_048_576;
/// The epoch crosses the wire as a JSON number and the TypeScript client holds
/// it in a double, which rounds above this value while the host keeps the
/// exact integer. A rounded epoch reaches the host as a different
/// `required_epoch` and a different canonical request key, so every embedding
/// request would be rejected for a constraint mismatch the owner cannot see.
const MAX_TABLE_EPOCH: u64 = 9_007_199_254_740_991;
const MAX_CORPUS_ITEMS: usize = 256;
const MAX_CORPUS_TEXT_BYTES: usize = 1024 * 1024;

/// Output names FastEmbed's precedence machinery accepts as `&'static str`;
/// a manifest may only select one of these or a bounded index.
const OUTPUT_NAME_ALLOWLIST: &[&str] = &[
    "text_embeds",
    "last_hidden_state",
    "sentence_embedding",
    "token_embeddings",
];
const MAX_OUTPUT_INDEX: u64 = 7;

/// Why a bundle was refused. The message is a stable, bounded reason that
/// never carries artifact bytes; the fingerprint-mismatch reason alone
/// includes the expected canonical digest, which owners need to repair
/// their manifest.
#[derive(Debug, Clone)]
pub struct BundleError(pub String);

impl std::fmt::Display for BundleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid synapse bundle: {}", self.0)
    }
}

impl std::error::Error for BundleError {}

fn err(reason: impl Into<String>) -> BundleError {
    BundleError(reason.into())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub name: String,
    pub sha256: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenizerRefs {
    pub tokenizer: ArtifactRef,
    pub config: ArtifactRef,
    pub special_tokens_map: ArtifactRef,
    pub tokenizer_config: ArtifactRef,
}

impl TokenizerRefs {
    fn all(&self) -> [&ArtifactRef; 4] {
        [
            &self.tokenizer,
            &self.config,
            &self.special_tokens_map,
            &self.tokenizer_config,
        ]
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputSelector {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub index: Option<u64>,
    #[serde(default)]
    pub only_one: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecommendedBatch {
    pub rows: u32,
    pub token_budget: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleManifest {
    pub schema_version: u64,
    pub model: String,
    pub fingerprint: String,
    pub table_epoch: u64,
    pub dims: u64,
    pub pooling: String,
    pub quantization: String,
    pub output: OutputSelector,
    pub max_tokens: u64,
    pub provenance: serde_json::Value,
    pub recommended_batch: RecommendedBatch,
    pub model_file: ArtifactRef,
    pub external_initializers: Vec<ArtifactRef>,
    pub tokenizer: TokenizerRefs,
    pub corpus: ArtifactRef,
}

#[derive(Debug, Clone)]
pub enum SelectedOutput {
    OnlyOne,
    ByOrder(usize),
    ByName(&'static str),
}

impl BundleManifest {
    /// Resolves the manifest's bounded output selector against the closed
    /// FastEmbed vocabulary.
    pub fn selected_output(&self) -> Result<SelectedOutput, BundleError> {
        match (&self.output.name, self.output.index, self.output.only_one) {
            (Some(name), None, None) => OUTPUT_NAME_ALLOWLIST
                .iter()
                .find(|allowed| *allowed == name)
                .map(|allowed| SelectedOutput::ByName(allowed))
                .ok_or_else(|| err("output name is not allowlisted")),
            (None, Some(index), None) => {
                if index > MAX_OUTPUT_INDEX {
                    return Err(err("output index exceeds the bound"));
                }
                Ok(SelectedOutput::ByOrder(index as usize))
            }
            (None, None, Some(true)) => Ok(SelectedOutput::OnlyOne),
            _ => Err(err(
                "output selector must be exactly one of name, index, or only_one",
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CorpusItem {
    pub text: String,
    pub expected: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct Corpus {
    pub tolerance: f32,
    pub items: Vec<CorpusItem>,
}

/// A bundle whose every artifact byte was read once, confined to the bundle
/// directory, and verified against its manifest hash.
pub struct VerifiedBundle {
    pub manifest: BundleManifest,
    pub max_text_bytes: usize,
    pub onnx: Vec<u8>,
    pub initializers: Vec<(String, Vec<u8>)>,
    pub tokenizer_file: Vec<u8>,
    pub config_file: Vec<u8>,
    pub special_tokens_map_file: Vec<u8>,
    pub tokenizer_config_file: Vec<u8>,
    pub corpus: Corpus,
}

pub fn load_bundle(dir: &Path, limits: &SynapseLimits) -> Result<VerifiedBundle, BundleError> {
    let metadata =
        std::fs::symlink_metadata(dir).map_err(|_| err("bundle directory is missing"))?;
    if !metadata.is_dir() {
        return Err(err("bundle path is not a directory"));
    }

    let manifest_bytes = read_artifact(dir, "manifest.json", MAX_MANIFEST_BYTES)?;
    let manifest = parse_manifest(&manifest_bytes)?;
    validate_manifest(&manifest)?;
    validate_serving_limits(&manifest, limits)?;

    let mut listed: Vec<&ArtifactRef> = vec![&manifest.model_file, &manifest.corpus];
    listed.extend(manifest.external_initializers.iter());
    listed.extend(manifest.tokenizer.all());
    let mut seen_names: Vec<&str> = vec!["manifest.json"];
    for artifact in &listed {
        validate_artifact_ref(artifact)?;
        if seen_names.contains(&artifact.name.as_str()) {
            return Err(err("duplicate artifact name in manifest"));
        }
        seen_names.push(&artifact.name);
    }
    reject_unlisted_entries(dir, &seen_names)?;

    let read_verified = |artifact: &ArtifactRef, cap: u64| -> Result<Vec<u8>, BundleError> {
        read_verified_open(open_artifact(dir, &artifact.name)?, artifact, cap)
    };

    // Metadata-only pre-check over the very descriptors the reads below draw
    // from: an oversized weight total fails here, before any large read makes
    // the bytes resident, and each descriptor's own length bounds its read.
    let mut weights = Vec::with_capacity(1 + manifest.external_initializers.len());
    weights.push(open_artifact(dir, &manifest.model_file.name)?);
    for artifact in &manifest.external_initializers {
        weights.push(open_artifact(dir, &artifact.name)?);
    }
    validate_weights_budget(weights.iter().map(|weight| weight.len), MAX_MODEL_BYTES)?;

    let mut weights = weights.into_iter();
    let onnx = read_verified_open(
        weights.next().expect("the model file is opened first"),
        &manifest.model_file,
        MAX_MODEL_BYTES,
    )?;
    let mut initializers = Vec::with_capacity(manifest.external_initializers.len());
    for artifact in &manifest.external_initializers {
        initializers.push((
            artifact.name.clone(),
            read_verified_open(
                weights
                    .next()
                    .expect("one descriptor is opened per initializer"),
                artifact,
                MAX_MODEL_BYTES,
            )?,
        ));
    }
    let tokenizer_file = read_verified(&manifest.tokenizer.tokenizer, MAX_SIDE_FILE_BYTES)?;
    let config_file = read_verified(&manifest.tokenizer.config, MAX_SIDE_FILE_BYTES)?;
    let special_tokens_map_file =
        read_verified(&manifest.tokenizer.special_tokens_map, MAX_SIDE_FILE_BYTES)?;
    let tokenizer_config_file =
        read_verified(&manifest.tokenizer.tokenizer_config, MAX_SIDE_FILE_BYTES)?;
    let corpus_bytes = read_verified(&manifest.corpus, MAX_SIDE_FILE_BYTES)?;

    validate_tokenizer_config(&tokenizer_config_file, manifest.max_tokens)?;
    let corpus = parse_corpus(&corpus_bytes, manifest.dims as usize)?;

    // The fingerprint must be derived from the embedding-space fields, not
    // merely well-formed: every artifact byte is verified against its
    // manifest hash above, so binding the fingerprint to those hashes makes
    // it impossible to edit the space and keep the old lane identity. Field
    // checks run first so a specific fault reports its own reason; this is
    // the final coherence gate.
    let expected = canonical_fingerprint(&manifest);
    if manifest.fingerprint != expected {
        return Err(err(format!(
            "manifest fingerprint does not match the canonical embedding-space fingerprint \
             (expected {expected})"
        )));
    }

    Ok(VerifiedBundle {
        manifest,
        max_text_bytes: limits.max_text_bytes,
        onnx,
        initializers,
        tokenizer_file,
        config_file,
        special_tokens_map_file,
        tokenizer_config_file,
        corpus,
    })
}

fn parse_manifest(bytes: &[u8]) -> Result<BundleManifest, BundleError> {
    // Two-stage parse: the strict pass rejects duplicate keys, which
    // serde_json would otherwise silently resolve by field order.
    let value = crate::control::strict_json::parse(bytes)
        .map_err(|_| err("manifest is not strict JSON"))?;
    serde_json::from_value(value).map_err(|_| err("manifest schema invalid"))
}

fn validate_manifest(manifest: &BundleManifest) -> Result<(), BundleError> {
    if manifest.schema_version != 1 {
        return Err(err("unsupported manifest schema version"));
    }
    if manifest.model.is_empty() || manifest.model.len() > 128 {
        return Err(err("model name out of bounds"));
    }
    validate_sha256_hex(&manifest.fingerprint).map_err(err)?;
    if manifest.dims == 0 || manifest.dims > MAX_DIMS {
        return Err(err("dims out of bounds"));
    }
    if manifest.max_tokens == 0 || manifest.max_tokens > MAX_MAX_TOKENS {
        return Err(err("max_tokens out of bounds"));
    }
    if manifest.table_epoch > MAX_TABLE_EPOCH {
        return Err(err("table_epoch out of bounds"));
    }
    if !matches!(manifest.pooling.as_str(), "mean" | "cls") {
        return Err(err("unsupported pooling"));
    }
    if !matches!(
        manifest.quantization.as_str(),
        "none" | "static" | "dynamic"
    ) {
        return Err(err("unsupported quantization"));
    }
    manifest.selected_output()?;
    if manifest.recommended_batch.rows == 0 || manifest.recommended_batch.token_budget == 0 {
        return Err(err("recommended batch policy must be nonzero"));
    }
    if manifest.external_initializers.len() > MAX_EXTERNAL_INITIALIZERS {
        return Err(err("too many external initializers"));
    }
    let provenance_bytes = serde_json::to_vec(&manifest.provenance)
        .map_err(|_| err("provenance serialization failed"))?;
    if provenance_bytes.len() > MAX_PROVENANCE_BYTES {
        return Err(err("provenance too large"));
    }
    Ok(())
}

fn validate_serving_limits(
    manifest: &BundleManifest,
    limits: &SynapseLimits,
) -> Result<(), BundleError> {
    if limits.max_text_bytes < 4 {
        return Err(err("host max text bytes must hold one UTF-8 code point"));
    }
    if limits.max_batch_items == 0 {
        return Err(err("host max batch items must be nonzero"));
    }
    if limits.max_batch_text_bytes < limits.max_text_bytes {
        return Err(err(
            "host max batch text bytes are below the advertised max text bytes",
        ));
    }
    if limits.max_retained_jobs == 0 {
        return Err(err("host retained job count must be nonzero"));
    }
    if u64::try_from(limits.max_batch_text_bytes)
        .map(|max_batch_text_bytes| limits.max_queued_request_bytes < max_batch_text_bytes)
        .unwrap_or(true)
    {
        return Err(err(
            "host queued request bytes are below the max batch text bytes",
        ));
    }
    // A tokenizer token can span multiple UTF-8 bytes, so no token-to-byte
    // conversion is universally safe. The validated byte cap travels with
    // the bundle and is advertised beside max_tokens instead.

    let recommended_rows = manifest.recommended_batch.rows as usize;
    if recommended_rows > limits.max_batch_items {
        return Err(err(format!(
            "recommended batch rows ({recommended_rows}) exceed the host's max batch items ({})",
            limits.max_batch_items
        )));
    }

    let max_result_bytes = jobs::max_result_bytes(limits.max_batch_items, manifest.dims as usize)
        .ok_or_else(|| err("maximum retained result size overflows"))?;
    if max_result_bytes > limits.max_retained_result_bytes {
        return Err(err(format!(
            "maximum batch result ({max_result_bytes} bytes) exceeds the host's retained-result \
             limit ({} bytes)",
            limits.max_retained_result_bytes
        )));
    }

    // The result-page metadata reservation is a fixed function of these
    // limits, taken from the scratch pool on every `embed.result` — while
    // that request still holds its own decoded charge: up to twice the
    // validated job-id and cursor lengths plus the 64-byte request key
    // (decode scratch can retain up to double the decoded length as
    // capacity) and the response scratch. A combined maximum above the
    // pool's ceiling would make every poll fail `queue_full` forever even
    // on an idle host — a permanent, config-induced outage that must
    // reject at startup instead of surfacing one request at a time.
    let page_meta_bytes = limits
        .page_item_bound()
        .saturating_mul(jobs::MAX_ITEM_ID_BYTES + jobs::CONTENT_SHA256_BYTES);
    let result_request_bytes = 2
        * (super::protocol::MAX_JOB_ID_BYTES + super::protocol::MAX_CURSOR_BYTES + 64)
        + super::RESPONSE_SCRATCH_BYTES;
    let result_worst_case = page_meta_bytes.saturating_add(result_request_bytes);
    if result_worst_case as u64 > crate::config::SCRATCH_RESERVED_BYTES {
        return Err(err(format!(
            "worst-case result-page metadata plus its request charge ({result_worst_case} \
             bytes) exceeds the reserved scratch pool ({} bytes); lower max_page_vectors \
             or max_batch_items",
            crate::config::SCRATCH_RESERVED_BYTES
        )));
    }

    // The parse reservation is method-independent (the method cannot be
    // decoded before reserving without unaccounted allocations), so its
    // per-item term applies to every request. A body that decodes into a
    // valid request under these limits is bounded by what they advertise:
    // JSON escaping expands one text byte to at most six (`\u00XX`), and
    // each batch item adds at most an escaped id, its hash, and the field
    // skeleton — all capped by the preflight body maximum. If the worst
    // advertised body's reservation exceeds the scratch pool, a request
    // within advertised limits is permanently unservable, so the
    // configuration rejects here instead of one request at a time.
    const ESCAPED_BYTE_FACTOR: usize = 6;
    const ITEM_BODY_ENVELOPE_BYTES: usize = 2048;
    const BODY_ENVELOPE_BYTES: usize = 4096;
    let worst_query_body = super::protocol::MAX_BODY_BYTES.min(
        limits
            .max_text_bytes
            .saturating_mul(ESCAPED_BYTE_FACTOR)
            .saturating_add(BODY_ENVELOPE_BYTES),
    );
    let worst_batch_body = super::protocol::MAX_BODY_BYTES.min(
        limits
            .max_batch_text_bytes
            .saturating_mul(ESCAPED_BYTE_FACTOR)
            .saturating_add(
                limits
                    .max_batch_items
                    .saturating_mul(ITEM_BODY_ENVELOPE_BYTES),
            )
            .saturating_add(BODY_ENVELOPE_BYTES),
    );
    for worst_body in [worst_query_body, worst_batch_body] {
        let reservation = super::protocol::parse_reservation_bytes(worst_body, limits)
            .ok_or_else(|| err("the worst-case parse reservation overflows"))?;
        if reservation as u64 > crate::config::SCRATCH_RESERVED_BYTES {
            return Err(err(format!(
                "the parse reservation for a maximal advertised request ({reservation} bytes \
                 for a {worst_body}-byte body) exceeds the reserved scratch pool ({} bytes); \
                 lower max_batch_items or the text limits",
                crate::config::SCRATCH_RESERVED_BYTES
            )));
        }
    }
    Ok(())
}

fn validate_artifact_ref(artifact: &ArtifactRef) -> Result<(), BundleError> {
    let name = &artifact.name;
    if name.is_empty() || name.len() > MAX_ARTIFACT_NAME_BYTES {
        return Err(err("artifact name out of bounds"));
    }
    // Bare file names only: path separators or dot-relative names could
    // escape the bundle directory, and request data never reaches here to
    // pick them, so any such name is owner error, not routing.
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(err("artifact name contains a path separator"));
    }
    if name == "." || name == ".." || name == "manifest.json" {
        return Err(err("artifact name is reserved"));
    }
    validate_sha256_hex(&artifact.sha256).map_err(err)
}

pub(crate) fn validate_sha256_hex(hash: &str) -> Result<(), &'static str> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("hash is not 64 lowercase hex characters");
    }
    // A placeholder hash can never be produced by hashing real bytes, and
    // accepting one would certify artifacts nobody hashed.
    if hash.bytes().all(|b| b == hash.as_bytes()[0]) {
        return Err("hash is a placeholder");
    }
    Ok(())
}

/// The canonical lane fingerprint: SHA-256 over a versioned, newline-joined
/// `key=value` serialization of exactly the manifest fields that determine
/// the embedding space — artifact hashes, external-initializer names, pooling,
/// quantization, output selection, truncation length, dimensions, and the
/// destination-table epoch. Fields that cannot change a served vector (model name,
/// provenance, `recommended_batch`) are excluded, so tuning them never
/// forces a new lane identity. Packaging tools mirror the exact byte layout.
///
/// Assumes an already-validated manifest. Initializer names are byte-length
/// prefixed, so delimiters inside a legal filename cannot forge another field.
pub fn canonical_fingerprint(manifest: &BundleManifest) -> String {
    let output = match (
        &manifest.output.name,
        manifest.output.index,
        manifest.output.only_one,
    ) {
        (Some(name), None, None) => format!("name:{name}"),
        (None, Some(index), None) => format!("index:{index}"),
        (None, None, Some(true)) => "only_one".to_owned(),
        // validate_manifest rejects every other combination before the
        // fingerprint comparison, so this arm never reaches enforcement.
        _ => "unselected".to_owned(),
    };
    let mut lines = String::from("mc-synapse-fingerprint-v2");
    let mut line = |key: &str, value: &str| {
        lines.push('\n');
        lines.push_str(key);
        lines.push('=');
        lines.push_str(value);
    };
    line("model_file", &manifest.model_file.sha256);
    for artifact in &manifest.external_initializers {
        line(
            "external_initializer",
            &format!(
                "{}:{}:{}",
                artifact.name.len(),
                artifact.name,
                artifact.sha256
            ),
        );
    }
    line("tokenizer", &manifest.tokenizer.tokenizer.sha256);
    line("config", &manifest.tokenizer.config.sha256);
    line(
        "special_tokens_map",
        &manifest.tokenizer.special_tokens_map.sha256,
    );
    line(
        "tokenizer_config",
        &manifest.tokenizer.tokenizer_config.sha256,
    );
    line("pooling", &manifest.pooling);
    line("quantization", &manifest.quantization);
    line("output", &output);
    line("max_tokens", &manifest.max_tokens.to_string());
    line("dims", &manifest.dims.to_string());
    line("table_epoch", &manifest.table_epoch.to_string());
    line("corpus", &manifest.corpus.sha256);
    sha256_hex(lines.as_bytes())
}

/// One confined artifact held open for reading, paired with the length its
/// own descriptor reports.
///
/// Validation and reading share this descriptor because a path resolved twice
/// can name two different files: bytes fetched through a second lookup are not
/// the bytes whose type and length were checked, so a regular file that passes
/// the bound can be replaced by a symlink or a far larger file before the
/// read. Pinning the descriptor makes the checked file the read file.
#[derive(Debug)]
pub(crate) struct OpenRegularFile {
    pub(crate) file: std::fs::File,
    pub(crate) len: u64,
}

#[derive(Debug)]
pub(crate) enum OpenRegularFileError {
    Missing,
    NotRegular,
}

impl OpenRegularFile {
    pub(crate) fn read(self) -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(self.len as usize);
        self.file.take(self.len).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}

/// Opens one path without following its final component and pins the checked
/// regular file to a descriptor. Callers read this descriptor so replacement
/// of the path cannot change the bytes after validation.
pub(crate) fn open_regular_file(path: &Path) -> Result<OpenRegularFile, OpenRegularFileError> {
    let fd = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|errno| {
        if errno == rustix::io::Errno::LOOP {
            OpenRegularFileError::NotRegular
        } else {
            OpenRegularFileError::Missing
        }
    })?;
    let file = std::fs::File::from(fd);
    let metadata = file.metadata().map_err(|_| OpenRegularFileError::Missing)?;
    if !metadata.is_file() {
        return Err(OpenRegularFileError::NotRegular);
    }
    Ok(OpenRegularFile {
        file,
        len: metadata.len(),
    })
}

/// Opens one confined artifact without following a symlink at the final
/// component, then validates the descriptor's own metadata.
fn open_artifact(dir: &Path, name: &str) -> Result<OpenRegularFile, BundleError> {
    let path: PathBuf = dir.join(name);
    // NOFOLLOW turns a symlink into an open failure rather than a redirect.
    // NONBLOCK keeps the open itself from parking: a FIFO planted under an
    // artifact name would otherwise block until a writer appears, before
    // `fstat` can reject it as a non-regular file.
    open_regular_file(&path).map_err(|error| match error {
        OpenRegularFileError::Missing => err(format!("artifact is missing: {name}")),
        OpenRegularFileError::NotRegular => err(format!("artifact is not a regular file: {name}")),
    })
}

/// Reads at most the length this descriptor reported. Growth after the length
/// check truncates the read into a hash mismatch instead of an allocation the
/// bound never authorized.
fn read_open_artifact(open: OpenRegularFile, name: &str) -> Result<Vec<u8>, BundleError> {
    open.read()
        .map_err(|_| err(format!("artifact read failed: {name}")))
}

/// Bound-checks, reads, and hash-verifies one opened artifact.
fn read_verified_open(
    open: OpenRegularFile,
    artifact: &ArtifactRef,
    cap: u64,
) -> Result<Vec<u8>, BundleError> {
    let name = &artifact.name;
    if open.len > cap {
        return Err(err(format!("artifact exceeds its size bound: {name}")));
    }
    let bytes = read_open_artifact(open, name)?;
    if sha256_hex(&bytes) != artifact.sha256 {
        return Err(err(format!("artifact hash mismatch: {name}")));
    }
    Ok(bytes)
}

/// Rejects a weight set whose total exceeds `budget`. Saturating addition:
/// a sum that would overflow is by definition over any real budget.
fn validate_weights_budget(
    lengths: impl IntoIterator<Item = u64>,
    budget: u64,
) -> Result<(), BundleError> {
    let mut total: u64 = 0;
    for length in lengths {
        total = total.saturating_add(length);
        if total > budget {
            return Err(err("model weights exceed the aggregate byte budget"));
        }
    }
    Ok(())
}

fn read_artifact(dir: &Path, name: &str, cap: u64) -> Result<Vec<u8>, BundleError> {
    let open = open_artifact(dir, name)?;
    if open.len > cap {
        return Err(err(format!("artifact exceeds its size bound: {name}")));
    }
    read_open_artifact(open, name)
}

fn reject_unlisted_entries(dir: &Path, listed: &[&str]) -> Result<(), BundleError> {
    let entries = std::fs::read_dir(dir).map_err(|_| err("bundle directory read failed"))?;
    for entry in entries {
        let entry = entry.map_err(|_| err("bundle directory read failed"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(err("bundle contains a non-UTF-8 entry"));
        };
        if !listed.contains(&name) {
            return Err(err(format!("bundle contains an unlisted entry: {name}")));
        }
    }
    Ok(())
}

fn validate_tokenizer_config(bytes: &[u8], max_tokens: u64) -> Result<(), BundleError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| err("tokenizer_config is not JSON"))?;
    let declared = value
        .get("model_max_length")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| err("tokenizer_config lacks model_max_length"))?;
    // Two competing maximum lengths would make the truncation boundary
    // depend on which one a code path consults.
    if declared != max_tokens {
        return Err(err(
            "tokenizer_config model_max_length disagrees with manifest max_tokens",
        ));
    }
    if value
        .get("pad_token")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err(err("tokenizer_config lacks pad_token"));
    }
    Ok(())
}

fn parse_corpus(bytes: &[u8], dims: usize) -> Result<Corpus, BundleError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RawCorpus {
        tolerance: f32,
        items: Vec<RawItem>,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RawItem {
        text: String,
        expected: Vec<f32>,
    }

    let raw: RawCorpus = serde_json::from_slice(bytes).map_err(|_| err("corpus schema invalid"))?;
    if !(raw.tolerance.is_finite() && raw.tolerance > 0.0 && raw.tolerance <= 0.1) {
        return Err(err("corpus tolerance out of bounds"));
    }
    if raw.items.is_empty() || raw.items.len() > MAX_CORPUS_ITEMS {
        return Err(err("corpus item count out of bounds"));
    }
    let mut items = Vec::with_capacity(raw.items.len());
    for item in raw.items {
        if item.text.is_empty() || item.text.len() > MAX_CORPUS_TEXT_BYTES {
            return Err(err("corpus text out of bounds"));
        }
        if item.expected.len() != dims || item.expected.iter().any(|v| !v.is_finite()) {
            return Err(err("corpus expected vector invalid"));
        }
        items.push(CorpusItem {
            text: item.text,
            expected: item.expected,
        });
    }
    Ok(Corpus {
        tolerance: raw.tolerance,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> BundleManifest {
        let artifact = |name: &str| ArtifactRef {
            name: name.to_owned(),
            sha256: sha256_hex(name.as_bytes()),
        };
        BundleManifest {
            schema_version: 1,
            model: "test-model".to_owned(),
            fingerprint: sha256_hex(b"fingerprint"),
            table_epoch: 1,
            dims: 8,
            pooling: "mean".to_owned(),
            quantization: "none".to_owned(),
            output: OutputSelector {
                name: Some("last_hidden_state".to_owned()),
                index: None,
                only_one: None,
            },
            max_tokens: 8,
            provenance: serde_json::Value::Null,
            recommended_batch: RecommendedBatch {
                rows: 1,
                token_budget: 8,
            },
            model_file: artifact("model.onnx"),
            external_initializers: vec![artifact("first.bin"), artifact("second.bin")],
            tokenizer: TokenizerRefs {
                tokenizer: artifact("tokenizer.json"),
                config: artifact("config.json"),
                special_tokens_map: artifact("special_tokens_map.json"),
                tokenizer_config: artifact("tokenizer_config.json"),
            },
            corpus: artifact("corpus.json"),
        }
    }

    #[test]
    fn fingerprint_binds_initializer_names_to_their_hashes() {
        let mut manifest = manifest();

        let hashes_before: Vec<_> = manifest
            .external_initializers
            .iter()
            .map(|artifact| artifact.sha256.clone())
            .collect();
        let fingerprint_before = canonical_fingerprint(&manifest);
        let (first, rest) = manifest
            .external_initializers
            .split_first_mut()
            .expect("test manifest has initializers");
        std::mem::swap(&mut first.name, &mut rest[0].name);

        assert_eq!(
            hashes_before,
            manifest
                .external_initializers
                .iter()
                .map(|artifact| artifact.sha256.clone())
                .collect::<Vec<_>>()
        );
        assert_ne!(fingerprint_before, canonical_fingerprint(&manifest));
    }

    #[test]
    fn maximum_batch_result_must_fit_retention() {
        let mut manifest = manifest();
        manifest.dims = MAX_DIMS;
        manifest.recommended_batch.rows = 64;
        let mut limits = SynapseLimits::default();
        let exact = jobs::max_result_bytes(limits.max_batch_items, manifest.dims as usize)
            .expect("bounded result size");

        assert!(limits.max_retained_result_bytes >= exact);
        assert!(validate_serving_limits(&manifest, &limits).is_ok());

        limits.max_retained_result_bytes = exact;
        assert!(validate_serving_limits(&manifest, &limits).is_ok());

        limits.max_retained_result_bytes = exact - 1;
        let error = validate_serving_limits(&manifest, &limits)
            .expect_err("one byte below the maximum result is invalid");
        assert!(error.0.contains("maximum batch result"));
    }

    /// A page-metadata bound that (together with the poll request's own
    /// decoded charge) exceeds the fixed scratch pool would fail every
    /// `embed.result` with `queue_full` forever — a permanent
    /// config-induced outage — so the configuration must reject at
    /// startup.
    #[test]
    fn a_page_bound_above_the_scratch_pool_is_rejected() {
        let manifest = manifest();
        let per_item = (jobs::MAX_ITEM_ID_BYTES + jobs::CONTENT_SHA256_BYTES) as u64;
        // Fits the pool by itself, but not alongside the request's own
        // charge — the boundary a page-only check would wave through.
        let boundary = (crate::config::SCRATCH_RESERVED_BYTES / per_item) as usize;
        let limits = SynapseLimits {
            max_page_vectors: boundary,
            max_batch_items: boundary,
            max_retained_result_bytes: u64::MAX,
            ..SynapseLimits::default()
        };
        let error = validate_serving_limits(&manifest, &limits)
            .expect_err("a page bound above the scratch pool is a permanent outage");
        assert!(error.0.contains("result-page metadata"));

        // The bound is clamped by max_batch_items, so an oversized
        // max_page_vectors alone stays valid.
        let limits = SynapseLimits {
            max_page_vectors: boundary,
            ..SynapseLimits::default()
        };
        assert!(validate_serving_limits(&manifest, &limits).is_ok());
    }

    /// A configuration whose advertised limits permit a request the fixed
    /// scratch pool can never fund — the method-independent per-item
    /// headroom applied to a large advertised body — must reject at
    /// startup, not one `schema_violation` at a time.
    #[test]
    fn an_unservable_advertised_request_is_rejected_at_startup() {
        let manifest = manifest();
        let limits = SynapseLimits {
            max_text_bytes: 8 * 1024 * 1024,
            max_batch_items: 131_073,
            max_retained_result_bytes: u64::MAX,
            ..SynapseLimits::default()
        };
        let error = validate_serving_limits(&manifest, &limits)
            .expect_err("an unservable advertised request is a permanent outage");
        assert!(error.0.contains("parse reservation"));

        // A large advertised query alone (default item cap) stays valid:
        // the reservation's item term is what overflows the pool.
        let limits = SynapseLimits {
            max_text_bytes: 8 * 1024 * 1024,
            ..SynapseLimits::default()
        };
        assert!(validate_serving_limits(&manifest, &limits).is_ok());
    }

    #[test]
    fn weights_budget_accepts_up_to_and_rejects_over_the_cap() {
        assert!(validate_weights_budget([], 10).is_ok());
        assert!(validate_weights_budget([4, 6], 10).is_ok());
        assert!(validate_weights_budget([4, 7], 10).is_err());
        assert!(validate_weights_budget([11], 10).is_err());
        // Sixteen small initializers each under a per-file view of the cap
        // still fail in aggregate.
        assert!(validate_weights_budget(vec![1u64; 16], 10).is_err());
    }

    #[test]
    fn weights_budget_saturates_instead_of_overflowing() {
        assert!(validate_weights_budget([u64::MAX, u64::MAX], u64::MAX - 1).is_err());
    }

    #[test]
    fn a_read_cannot_exceed_the_length_its_own_descriptor_validated() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("artifact.bin");
        std::fs::write(&path, b"small").expect("write");

        let open = open_artifact(dir.path(), "artifact.bin").expect("open");
        assert_eq!(open.len, 5);

        // The file grows on the same inode between the length check and the
        // read, which is the window a second path lookup would read through.
        std::fs::write(&path, vec![b'x'; 1 << 20]).expect("grow");

        let bytes = read_open_artifact(open, "artifact.bin").expect("read");
        assert_eq!(bytes.len(), 5, "the read is capped at the validated length");
    }

    #[test]
    fn a_symlinked_artifact_never_opens() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("target.bin"), b"payload").expect("write");
        std::os::unix::fs::symlink("target.bin", dir.path().join("artifact.bin")).expect("symlink");

        let error = open_artifact(dir.path(), "artifact.bin").expect_err("symlink is refused");
        assert!(
            error.0.contains("not a regular file"),
            "reason {:?} does not name the file-type refusal",
            error.0
        );
    }
}
