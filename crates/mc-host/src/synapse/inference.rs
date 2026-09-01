//! This CPU-only backend owns dynamic ORT initialization and performs a structural startup probe and semantic certification against the bundle corpus.
//! corpus.

#[cfg(target_os = "linux")]
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use fastembed::{
    InitOptionsUserDefined, OutputKey, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};

#[cfg(target_os = "linux")]
use super::bundle::{open_regular_file, validate_sha256_hex, OpenRegularFileError};
use super::bundle::{Corpus, SelectedOutput, VerifiedBundle};

/// `NORM_TOLERANCE` permits a returned vector's L2 norm to differ from 1.0 by at most 1e-3; larger deviations are invariant failures.
const NORM_TOLERANCE: f32 = 1e-3;
/// CPU ONNX Runtime contains executable code and static runtime tables, not model weights.
/// The 512 MiB limit bounds the verification source buffer and sealed memfd copy to 1 GiB.
const MAX_ORT_LIBRARY_BYTES: u64 = 512 * 1024 * 1024;

/// `OrtIdentity` binds a library path to certified SHA-256 bytes, so `ensure_ort` rejects a different build before calling `ort::init_from`.
#[derive(Debug, Clone)]
pub struct OrtIdentity {
    pub library: PathBuf,
    pub sha256: String,
}

/// `Input` errors reject the affected request.
/// `Artifact` errors disable the component.
/// `Invariant` errors mark the component failing and prevent suspect vectors from being returned.
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

/// `ORT_COMMITTED` permits one process-global ORT identity because dynamic loading is first-wins; its mutex lets only one racing initializer commit.
static ORT_COMMITTED: Mutex<Option<OrtIdentity>> = Mutex::new(None);

#[cfg(target_os = "linux")]
struct VerifiedOrtLibrary {
    file: std::fs::File,
}

#[cfg(target_os = "linux")]
impl VerifiedOrtLibrary {
    fn load_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd;

        PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }
}

#[cfg(target_os = "linux")]
fn ensure_ort(identity: &OrtIdentity) -> Result<(), InferenceError> {
    // An invalid `identity` reports a verification error even after another initializer commits a different identity.
    let verified = verify_ort_library(identity)?;
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
    let builder = ort::init_from(verified.load_path())
        .map_err(|_| InferenceError::Artifact("ONNX Runtime library failed to load".to_owned()))?;
    if !builder.commit() {
        // `ort` was initialized before the certified library could be selected.
        return Err(InferenceError::Artifact(
            "ONNX Runtime environment was already initialized".to_owned(),
        ));
    }
    *committed = Some(identity.clone());
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn ensure_ort(_identity: &OrtIdentity) -> Result<(), InferenceError> {
    Err(InferenceError::Artifact(
        "secure ONNX Runtime staging requires Linux".to_owned(),
    ))
}

#[cfg(target_os = "linux")]
fn verify_ort_library(identity: &OrtIdentity) -> Result<VerifiedOrtLibrary, InferenceError> {
    validate_sha256_hex(&identity.sha256).map_err(|_| {
        InferenceError::Artifact("expected ONNX Runtime hash is not a real digest".to_owned())
    })?;
    let open = open_regular_file(&identity.library).map_err(|error| match error {
        OpenRegularFileError::Missing => {
            InferenceError::Artifact("ONNX Runtime library is missing".to_owned())
        }
        OpenRegularFileError::NotRegular => {
            InferenceError::Artifact("ONNX Runtime library is not a regular file".to_owned())
        }
    })?;
    if open.len > MAX_ORT_LIBRARY_BYTES {
        return Err(InferenceError::Artifact(
            "ONNX Runtime library exceeds the size bound".to_owned(),
        ));
    }
    let bytes = open
        .read()
        .map_err(|_| InferenceError::Artifact("ONNX Runtime library read failed".to_owned()))?;
    if super::protocol::sha256_hex(&bytes) != identity.sha256 {
        return Err(InferenceError::Artifact(
            "ONNX Runtime library hash mismatch".to_owned(),
        ));
    }

    let flags = rustix::fs::MemfdFlags::CLOEXEC
        | rustix::fs::MemfdFlags::ALLOW_SEALING
        | rustix::fs::MemfdFlags::EXEC;
    let fd = rustix::fs::memfd_create("mc-host-onnxruntime", flags).or_else(|error| {
        if error == rustix::io::Errno::INVAL {
            // Linux before MFD_EXEC treats memfds as executable by default.
            rustix::fs::memfd_create(
                "mc-host-onnxruntime",
                rustix::fs::MemfdFlags::CLOEXEC | rustix::fs::MemfdFlags::ALLOW_SEALING,
            )
        } else {
            Err(error)
        }
    });
    let mut file =
        std::fs::File::from(fd.map_err(|_| {
            InferenceError::Artifact("ONNX Runtime memfd creation failed".to_owned())
        })?);
    file.write_all(&bytes)
        .map_err(|_| InferenceError::Artifact("ONNX Runtime memfd write failed".to_owned()))?;
    drop(bytes);
    rustix::fs::fcntl_add_seals(
        &file,
        rustix::fs::SealFlags::SHRINK
            | rustix::fs::SealFlags::GROW
            | rustix::fs::SealFlags::WRITE
            | rustix::fs::SealFlags::SEAL,
    )
    .map_err(|_| InferenceError::Artifact("ONNX Runtime memfd sealing failed".to_owned()))?;
    Ok(VerifiedOrtLibrary { file })
}

/// The model mutex serializes `TextEmbedding::embed` because it requires `&mut`; the CPU permit prevents callers from queueing on that mutex.
pub struct Backend {
    model: Mutex<TextEmbedding>,
    dims: usize,
}

impl Backend {
    pub fn load(bundle: VerifiedBundle, ort: &OrtIdentity) -> Result<Self, InferenceError> {
        ensure_ort(ort)?;

        let VerifiedBundle {
            manifest,
            max_text_bytes: _,
            onnx,
            initializers,
            tokenizer_file,
            config_file,
            special_tokens_map_file,
            tokenizer_config_file,
            corpus,
        } = bundle;
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
            onnx,
            TokenizerFiles {
                tokenizer_file,
                config_file,
                special_tokens_map_file,
                tokenizer_config_file,
            },
        )
        .with_pooling(pooling)
        .with_quantization(quantization);
        for (name, buffer) in initializers {
            model = model.with_external_initializer(name, buffer);
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
        backend.certify(&corpus)?;
        Ok(backend)
    }

    /// embed blocks while running native inference over one ordered page of texts.
    /// embed returns one finite, unit-norm vector with `dims` components for each input text.
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
            // embed rejects zero-token inputs because mean pooling would divide by an all-zero attention mask.
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

    /// certify uses a corpus that detects incorrect output selection, pooling, and truncation.
    /// certify rejects structurally healthy models with semantically incorrect output.
    /// load rejects semantically wrong models before returning a backend that can serve vectors.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn source_replacement_cannot_change_verified_loader_bytes() {
        let source_dir = tempfile::tempdir().expect("source directory");
        let source = source_dir.path().join("libonnxruntime.so");
        let replacement = source_dir.path().join("replacement.so");
        let verified_bytes = b"certified ONNX Runtime bytes";
        let replacement_bytes = b"unverified replacement bytes";
        std::fs::write(&source, verified_bytes).expect("write source");
        let identity = OrtIdentity {
            library: source.clone(),
            sha256: super::super::protocol::sha256_hex(verified_bytes),
        };
        let verified = verify_ort_library(&identity).expect("verified staging");
        let seals = rustix::fs::fcntl_get_seals(&verified.file).expect("read memfd seals");
        assert!(seals.contains(
            rustix::fs::SealFlags::SHRINK
                | rustix::fs::SealFlags::GROW
                | rustix::fs::SealFlags::WRITE
                | rustix::fs::SealFlags::SEAL
        ));
        let mut writer = verified.file.try_clone().expect("clone memfd");
        assert!(writer.write_all(b"replacement").is_err());

        std::fs::write(&replacement, replacement_bytes).expect("write replacement");
        std::fs::rename(&replacement, &source).expect("replace source");

        let loaded_path = verified.load_path().to_path_buf();
        assert_ne!(loaded_path, source);
        assert!(loaded_path.starts_with("/proc/self/fd"));
        let loaded_bytes = std::fs::read(&loaded_path).expect("read loader path");
        assert_eq!(loaded_bytes, verified_bytes);
        assert_eq!(
            super::super::protocol::sha256_hex(&loaded_bytes),
            identity.sha256
        );

        assert_eq!(
            std::fs::read(&source).expect("read replaced source"),
            replacement_bytes
        );

        drop(verified);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn oversized_sparse_ort_library_fails_before_reading_or_allocating_its_length() {
        let source_dir = tempfile::tempdir().expect("source directory");
        let source = source_dir.path().join("oversized-libonnxruntime.so");
        std::fs::File::create(&source)
            .expect("create sparse library")
            .set_len(MAX_ORT_LIBRARY_BYTES + 1)
            .expect("size sparse library");
        let identity = OrtIdentity {
            library: source,
            sha256: super::super::protocol::sha256_hex(b"unread oversized library"),
        };

        let error = match verify_ort_library(&identity) {
            Err(error) => error,
            Ok(_) => panic!("oversized library is accepted"),
        };
        match error {
            InferenceError::Artifact(reason) => assert!(
                reason.contains("size bound"),
                "reason {reason:?} does not identify the descriptor-length bound"
            ),
            other => panic!("expected artifact error, got {other}"),
        }
    }
}
