//! Owner-provisioned model bundle: strict manifest schema, artifact
//! confinement, and byte-hash verification before any model construction.

use std::path::{Path, PathBuf};

use super::protocol::sha256_hex;

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_MODEL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SIDE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EXTERNAL_INITIALIZERS: usize = 16;
const MAX_ARTIFACT_NAME_BYTES: usize = 255;
const MAX_PROVENANCE_BYTES: usize = 8 * 1024;
const MAX_DIMS: u64 = 16_384;
const MAX_MAX_TOKENS: u64 = 1_048_576;
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
/// never carries file contents or hashes.
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
    pub onnx: Vec<u8>,
    pub initializers: Vec<(String, Vec<u8>)>,
    pub tokenizer_file: Vec<u8>,
    pub config_file: Vec<u8>,
    pub special_tokens_map_file: Vec<u8>,
    pub tokenizer_config_file: Vec<u8>,
    pub corpus: Corpus,
}

pub fn load_bundle(dir: &Path) -> Result<VerifiedBundle, BundleError> {
    let metadata =
        std::fs::symlink_metadata(dir).map_err(|_| err("bundle directory is missing"))?;
    if !metadata.is_dir() {
        return Err(err("bundle path is not a directory"));
    }

    let manifest_bytes = read_artifact(dir, "manifest.json", MAX_MANIFEST_BYTES)?;
    let manifest = parse_manifest(&manifest_bytes)?;
    validate_manifest(&manifest)?;

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
        let bytes = read_artifact(dir, &artifact.name, cap)?;
        let digest = sha256_hex(&bytes);
        if digest != artifact.sha256 {
            return Err(err(format!("artifact hash mismatch: {}", artifact.name)));
        }
        Ok(bytes)
    };

    let onnx = read_verified(&manifest.model_file, MAX_MODEL_BYTES)?;
    let mut initializers = Vec::with_capacity(manifest.external_initializers.len());
    for artifact in &manifest.external_initializers {
        initializers.push((
            artifact.name.clone(),
            read_verified(artifact, MAX_MODEL_BYTES)?,
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

    Ok(VerifiedBundle {
        manifest,
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
    validate_hash(&manifest.fingerprint)?;
    if manifest.dims == 0 || manifest.dims > MAX_DIMS {
        return Err(err("dims out of bounds"));
    }
    if manifest.max_tokens == 0 || manifest.max_tokens > MAX_MAX_TOKENS {
        return Err(err("max_tokens out of bounds"));
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
    validate_hash(&artifact.sha256)
}

fn validate_hash(hash: &str) -> Result<(), BundleError> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(err("hash is not 64 lowercase hex characters"));
    }
    // A placeholder hash can never be produced by hashing real bytes, and
    // accepting one would certify artifacts nobody hashed.
    if hash.bytes().all(|b| b == hash.as_bytes()[0]) {
        return Err(err("hash is a placeholder"));
    }
    Ok(())
}

fn read_artifact(dir: &Path, name: &str, cap: u64) -> Result<Vec<u8>, BundleError> {
    let path: PathBuf = dir.join(name);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| err(format!("artifact is missing: {name}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(err(format!("artifact is not a regular file: {name}")));
    }
    if metadata.len() > cap {
        return Err(err(format!("artifact exceeds its size bound: {name}")));
    }
    std::fs::read(&path).map_err(|_| err(format!("artifact read failed: {name}")))
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
