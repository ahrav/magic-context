mod ingest;
mod read;

use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use super::{CommitIntent, RepositoryProvenance, Sensitivity};
use crate::kernel::durable_fs::open_or_create_secure_directory;
use crate::kernel::{KernelError, KernelStore};

pub(super) const DEFAULT_ARTIFACT_CAP: u64 = 4 * 1024 * 1024 * 1024;
pub(super) const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub(super) const MAX_PAYLOAD_DETECTIONS: usize = 4096;

#[cfg(feature = "test-support")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactIngestFault {
    AfterDirectorySync,
    AfterEvents,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderEgress {
    RemoteAllowed,
    LocalOnly,
}

impl ProviderEgress {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::RemoteAllowed => "remote_allowed",
            Self::LocalOnly => "local_only",
        }
    }

    pub(super) fn from_stored(value: &str) -> Self {
        match value {
            "remote_allowed" => Self::RemoteAllowed,
            _ => Self::LocalOnly,
        }
    }

    pub(super) fn restrictive(self, other: Self) -> Self {
        if self == Self::LocalOnly || other == Self::LocalOnly {
            Self::LocalOnly
        } else {
            Self::RemoteAllowed
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactIngestRequest {
    pub intent: CommitIntent,
    pub payload: Vec<u8>,
    pub evidence_id: String,
    pub object_id: String,
    pub object_kind: String,
    pub domain_id: String,
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: i64,
    pub media_type: String,
    pub retention_class: String,
    pub retain_until: Option<i64>,
    pub asserted_sensitivity: Sensitivity,
    pub provider_egress: ProviderEgress,
    pub provenance: Option<RepositoryProvenance>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactHandle {
    pub digest: String,
    pub evidence_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactDestination {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EligibilityDeniedReason {
    UnknownSensitive,
    SensitiveRemote,
    ProviderRestricted,
    Secret,
    Tombstoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactEligibility {
    Allowed,
    Denied(EligibilityDeniedReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactErrorKind {
    PayloadTooLarge,
    Capacity,
    StorageExhausted,
    IngestionFailClosed,
    ReAdmissionBlocked,
    MissingObject,
    CorruptObject,
    ReferenceUnavailable,
    ReferenceCommit,
    UnredactableSecret,
    DetectionLimit,
    InvalidInput,
}

pub struct ArtifactError {
    kind: ArtifactErrorKind,
    usage: Option<u64>,
    cap: Option<u64>,
    digest: Option<String>,
}

impl ArtifactError {
    pub fn kind(&self) -> ArtifactErrorKind {
        self.kind
    }

    pub fn usage(&self) -> Option<u64> {
        self.usage
    }

    pub fn cap(&self) -> Option<u64> {
        self.cap
    }

    pub fn digest(&self) -> Option<&str> {
        self.digest.as_deref()
    }

    pub(super) fn new(kind: ArtifactErrorKind) -> Self {
        Self {
            kind,
            usage: None,
            cap: None,
            digest: None,
        }
    }

    pub(super) fn capacity(usage: u64, cap: u64) -> Self {
        Self {
            kind: ArtifactErrorKind::Capacity,
            usage: Some(usage),
            cap: Some(cap),
            digest: None,
        }
    }

    pub(super) fn for_digest(kind: ArtifactErrorKind, digest: &str) -> Self {
        Self {
            kind,
            usage: None,
            cap: None,
            digest: Some(digest.to_string()),
        }
    }
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            ArtifactErrorKind::PayloadTooLarge => {
                formatter.write_str("artifact payload exceeds 64 MiB")
            }
            ArtifactErrorKind::Capacity => write!(
                formatter,
                "artifact capacity exceeded (usage={}, cap={})",
                self.usage.unwrap_or(0),
                self.cap.unwrap_or(0)
            ),
            ArtifactErrorKind::StorageExhausted => {
                formatter.write_str("artifact storage capacity is exhausted")
            }
            ArtifactErrorKind::IngestionFailClosed => {
                formatter.write_str("artifact ingestion is fail-closed until the store is reopened")
            }
            ArtifactErrorKind::ReAdmissionBlocked => write!(
                formatter,
                "artifact re-admission is blocked for digest {}",
                self.digest.as_deref().unwrap_or("unknown")
            ),
            ArtifactErrorKind::MissingObject => write!(
                formatter,
                "artifact object is missing for digest {}",
                self.digest.as_deref().unwrap_or("unknown")
            ),
            ArtifactErrorKind::CorruptObject => write!(
                formatter,
                "artifact object hash mismatch for digest {}",
                self.digest.as_deref().unwrap_or("unknown")
            ),
            ArtifactErrorKind::ReferenceUnavailable => {
                formatter.write_str("artifact reference is not live")
            }
            ArtifactErrorKind::ReferenceCommit => {
                formatter.write_str("artifact canonical reference commit failed")
            }
            ArtifactErrorKind::UnredactableSecret => formatter
                .write_str("artifact payload holds a recognized secret that cannot be redacted"),
            ArtifactErrorKind::DetectionLimit => write!(
                formatter,
                "artifact payload exceeds {MAX_PAYLOAD_DETECTIONS} recognized secrets"
            ),
            ArtifactErrorKind::InvalidInput => formatter.write_str("artifact input is invalid"),
        }
    }
}

impl fmt::Debug for ArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl std::error::Error for ArtifactError {}

pub(super) fn prepare_layout(root: &Path) -> Result<PathBuf, KernelError> {
    let root_directory = File::open(root).map_err(|_| KernelError::Io)?;
    let artifacts = open_or_create_secure_directory(&root_directory, "artifacts")
        .map_err(|_| KernelError::Io)?;
    open_or_create_secure_directory(&artifacts, "objects").map_err(|_| KernelError::Io)?;
    let tmp = open_or_create_secure_directory(&artifacts, "tmp").map_err(|_| KernelError::Io)?;
    for entry in std::fs::read_dir(root.join("artifacts/tmp")).map_err(|_| KernelError::Io)? {
        let entry = entry.map_err(|_| KernelError::Io)?;
        let file_type = entry.file_type().map_err(|_| KernelError::Io)?;
        if file_type.is_file() || file_type.is_symlink() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            crate::kernel::durable_fs::durable_unlink(&tmp, &name).map_err(|_| KernelError::Io)?;
        }
    }
    Ok(root.join("artifacts"))
}

impl KernelStore {
    pub(super) fn artifact_object_path(&self, digest: &str) -> PathBuf {
        self.artifacts_path
            .join("objects")
            .join(&digest[..2])
            .join(&digest[2..])
    }

    pub(super) fn cas_is_failed(&self) -> bool {
        self.cas_failed.load(Ordering::Acquire)
    }

    pub(super) fn latch_cas_failure(&self) {
        self.cas_failed.store(true, Ordering::Release);
    }
}

pub(super) fn read_capped(source: impl std::io::Read) -> std::io::Result<Option<Vec<u8>>> {
    let limit = u64::try_from(MAX_PAYLOAD_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    source.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Ok(None);
    }
    Ok(Some(bytes))
}

pub(super) fn is_artifact_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
