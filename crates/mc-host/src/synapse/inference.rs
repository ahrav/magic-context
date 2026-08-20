//! CPU-only FastEmbed backend: application-owned dynamic ORT initialization,
//! structural startup probe, and semantic certification against the bundle
//! corpus.

use std::path::PathBuf;
use std::sync::Mutex;

use fastembed::{
    InitOptionsUserDefined, OutputKey, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};

use super::bundle::{Corpus, SelectedOutput, VerifiedBundle};

/// How far a returned vector's L2 norm may sit from 1.0 before the backend
/// treats it as an invariant failure rather than rounding noise.
const NORM_TOLERANCE: f32 = 1e-3;

/// The exact native runtime the owner certified: the library file plus the
/// SHA-256 of its bytes, so a nominally matching but different build is
/// refused before `ort` binds to it.
#[derive(Debug, Clone)]
pub struct OrtIdentity {
    pub library: PathBuf,
    pub sha256: String,
}

/// Backend failures split by blame: `Input` faults reject one request,
/// `Artifact` faults disable the component, and `Invariant` faults mark it
/// failing so no suspect vector is ever returned.
#[derive(Debug, Clone)]
pub enum InferenceError {
    Input(String),
    Artifact(String),
    Invariant(String),
}

impl std::fmt::Display for InferenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Input(reason) => write!(f, "invalid inference input: {reason}"),
            Self::Artifact(reason) => write!(f, "inference artifact failure: {reason}"),
            Self::Invariant(reason) => write!(f, "inference invariant failure: {reason}"),
        }
    }
}

impl std::error::Error for InferenceError {}

/// Committed process-global ORT identity. `ort` dynamic loading is
/// first-wins for the whole process, so exactly one identity may ever
/// commit; later callers must present the same one. The mutex serializes
/// racing initializers so only one of them performs the commit.
static ORT_COMMITTED: Mutex<Option<OrtIdentity>> = Mutex::new(None);

fn ensure_ort(identity: &OrtIdentity) -> Result<(), InferenceError> {
    // Verification precedes the committed-identity comparison, so an
    // invalid identity reports its verification error even after another
    // lane commits a different identity.
    verify_ort_library(identity)?;
    let mut committed = ORT_COMMITTED
        .lock()
        .map_err(|_| InferenceError::Invariant("ORT init state is poisoned".to_owned()))?;
    if let Some(existing) = committed.as_ref() {
        if existing.library == identity.library && existing.sha256 == identity.sha256 {
            return Ok(());
        }
        return Err(InferenceError::Artifact(
            "a different ONNX Runtime identity is already committed".to_owned(),
        ));
    }
    let builder = ort::init_from(&identity.library)
        .map_err(|_| InferenceError::Artifact("ONNX Runtime library failed to load".to_owned()))?;
    if !builder.commit() {
        // Something else already configured the process-global environment,
        // so the certified library choice can no longer take effect.
        return Err(InferenceError::Artifact(
            "ONNX Runtime environment was already initialized".to_owned(),
        ));
    }
    *committed = Some(identity.clone());
    Ok(())
}

fn verify_ort_library(identity: &OrtIdentity) -> Result<(), InferenceError> {
    if identity.sha256.len() != 64
        || !identity
            .sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || identity
            .sha256
            .bytes()
            .all(|b| b == identity.sha256.as_bytes()[0])
    {
        return Err(InferenceError::Artifact(
            "expected ONNX Runtime hash is not a real digest".to_owned(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&identity.library)
        .map_err(|_| InferenceError::Artifact("ONNX Runtime library is missing".to_owned()))?;
    if !metadata.is_file() {
        return Err(InferenceError::Artifact(
            "ONNX Runtime library is not a regular file".to_owned(),
        ));
    }
    let bytes = std::fs::read(&identity.library)
        .map_err(|_| InferenceError::Artifact("ONNX Runtime library read failed".to_owned()))?;
    if super::protocol::sha256_hex(&bytes) != identity.sha256 {
        return Err(InferenceError::Artifact(
            "ONNX Runtime library hash mismatch".to_owned(),
        ));
    }
    Ok(())
}

/// One loaded certified model. `TextEmbedding::embed` needs `&mut`, so the
/// mutex also serializes native inference; the CPU permit above this type
/// keeps callers from queueing on it.
pub struct Backend {
    model: Mutex<TextEmbedding>,
    dims: usize,
}

impl Backend {
    /// Blocking: initializes ORT, builds the FastEmbed model from verified
    /// bytes, then runs the structural probe and semantic certification
    /// before returning a usable backend.
    pub fn load(bundle: &VerifiedBundle, ort: &OrtIdentity) -> Result<Self, InferenceError> {
        ensure_ort(ort)?;

        let manifest = &bundle.manifest;
        let pooling = match manifest.pooling.as_str() {
            "mean" => Pooling::Mean,
            "cls" => Pooling::Cls,
            other => {
                return Err(InferenceError::Artifact(format!(
                    "unsupported pooling: {other}"
                )))
            }
        };
        let quantization = match manifest.quantization.as_str() {
            "none" => QuantizationMode::None,
            "static" => QuantizationMode::Static,
            "dynamic" => QuantizationMode::Dynamic,
            other => {
                return Err(InferenceError::Artifact(format!(
                    "unsupported quantization: {other}"
                )))
            }
        };
        let output_key = match manifest
            .selected_output()
            .map_err(|e| InferenceError::Artifact(e.0))?
        {
            SelectedOutput::OnlyOne => OutputKey::OnlyOne,
            SelectedOutput::ByOrder(index) => OutputKey::ByOrder(index),
            SelectedOutput::ByName(name) => OutputKey::ByName(name),
        };

        let mut model = UserDefinedEmbeddingModel::new(
            bundle.onnx.clone(),
            TokenizerFiles {
                tokenizer_file: bundle.tokenizer_file.clone(),
                config_file: bundle.config_file.clone(),
                special_tokens_map_file: bundle.special_tokens_map_file.clone(),
                tokenizer_config_file: bundle.tokenizer_config_file.clone(),
            },
        )
        .with_pooling(pooling)
        .with_quantization(quantization);
        for (name, buffer) in &bundle.initializers {
            model = model.with_external_initializer(name.clone(), buffer.clone());
        }
        model.output_key = Some(output_key);

        let options = InitOptionsUserDefined::new()
            .with_max_length(manifest.max_tokens as usize)
            // One intra-op thread matches the single CPU inference permit.
            .with_intra_threads(1);
        let embedder = TextEmbedding::try_new_from_user_defined(model, options)
            .map_err(|e| InferenceError::Artifact(format!("model construction failed: {e}")))?;

        let backend = Self {
            model: Mutex::new(embedder),
            dims: manifest.dims as usize,
        };
        backend.structural_probe()?;
        backend.certify(&bundle.corpus)?;
        Ok(backend)
    }

    /// Blocking native inference over one ordered page of texts. Every
    /// returned vector is validated: exact count, exact dimensions, finite
    /// components, and a unit L2 norm.
    pub fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        if texts.is_empty() {
            return Err(InferenceError::Input("no texts to embed".to_owned()));
        }
        let mut model = self
            .model
            .lock()
            .map_err(|_| InferenceError::Invariant("inference state is poisoned".to_owned()))?;
        for text in texts {
            if text.is_empty() {
                return Err(InferenceError::Input("text is empty".to_owned()));
            }
            let encoding = model
                .tokenizer
                .encode(*text, true)
                .map_err(|_| InferenceError::Input("text failed to tokenize".to_owned()))?;
            // Zero tokens would make mean pooling divide by an all-zero
            // attention mask, so the request is refused instead.
            if encoding.get_ids().is_empty() {
                return Err(InferenceError::Input(
                    "text tokenizes to zero tokens".to_owned(),
                ));
            }
        }
        let vectors = model
            .embed(texts, None)
            .map_err(|e| InferenceError::Invariant(format!("inference failed: {e}")))?;
        drop(model);
        if vectors.len() != texts.len() {
            return Err(InferenceError::Invariant(
                "inference returned a different item count".to_owned(),
            ));
        }
        for vector in &vectors {
            self.validate_vector(vector)?;
        }
        Ok(vectors)
    }

    fn validate_vector(&self, vector: &[f32]) -> Result<(), InferenceError> {
        if vector.len() != self.dims {
            return Err(InferenceError::Invariant(format!(
                "vector has {} dimensions, manifest requires {}",
                vector.len(),
                self.dims
            )));
        }
        if vector.iter().any(|v| !v.is_finite()) {
            return Err(InferenceError::Invariant(
                "vector contains a non-finite component".to_owned(),
            ));
        }
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        if (norm - 1.0).abs() > NORM_TOLERANCE {
            return Err(InferenceError::Invariant(
                "vector is not L2-normalized".to_owned(),
            ));
        }
        Ok(())
    }

    fn structural_probe(&self) -> Result<(), InferenceError> {
        let vectors = self.embed(&["structural probe"])?;
        if vectors.len() != 1 {
            return Err(InferenceError::Artifact(
                "structural probe returned a wrong item count".to_owned(),
            ));
        }
        Ok(())
    }

    /// Compares live output against the pinned corpus componentwise. The
    /// corpus is chosen to be sensitive to output selection, pooling, and
    /// truncation, so a structurally healthy but semantically wrong model
    /// fails here instead of serving vectors.
    fn certify(&self, corpus: &Corpus) -> Result<(), InferenceError> {
        for item in &corpus.items {
            let got = self.embed(&[item.text.as_str()])?;
            let got = &got[0];
            let mismatch = got
                .iter()
                .zip(&item.expected)
                .any(|(g, e)| (g - e).abs() > corpus.tolerance);
            if mismatch {
                return Err(InferenceError::Artifact(
                    "semantic certification failed".to_owned(),
                ));
            }
        }
        Ok(())
    }
}
