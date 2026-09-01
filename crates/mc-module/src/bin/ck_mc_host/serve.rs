//! `ck-mc-host serve` runs as a daemon.
//!
//! The daemon reads one size-capped, strictly decoded startup envelope from the launcher's pipe.
//! The daemon revalidates the staged generation named by the envelope.
//! The daemon composes the fixed Magic Context, Synapse, and Broca profile.
//! `mc_host::run` acquires the lifetime fence before the runtime lock and writes the `starting` record before publication.
//! `mc_host::run` performs activation after publication.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mc_host::broca::backend::{
    BackendError, BackendFuture, BackendRequest, BackendTerminal, ErrorClass, EventSink, Harness,
    HarnessDispatchBackend, LlmExecutionBackend,
};
use mc_host::broca::opencode::{OpenCodeBackend, OpenCodeRuntime};
use mc_host::broca::pi::{PiBackend, PiRuntimeDescriptor};
use mc_host::broca::subprocess::{
    EnvSnapshot, CREDENTIAL_ROW_CAP_BYTES, CREDENTIAL_VALUE_CAP_BYTES,
};
use mc_host::broca::BrocaComponent;
use mc_host::generation::{GenerationStore, ValidatedGeneration};
use mc_host::harness_closure::{
    manifest_digest, ClosureCandidate, ClosureManifest, HarnessClosureStore,
    ValidatedHarnessClosure,
};
use mc_host::synapse::{SynapseComponent, SynapseConfig, SynapseLimits};
use mc_host::{CancellationToken, HostConfig, HostInit, StaticComposite};
use sha2::{Digest, Sha256};

use crate::spawn::MAX_ENVELOPE_BYTES;

const STORE_FILE: &str = "mc-store.db";
const ACTIVE_HARNESS_SELECTION: &str = "active-selection.json";
const ACTIVE_SELECTION_CREDENTIAL_DOMAIN: &[u8] = b"mc-host-active-selection-credential-v1";
const MAX_DESCRIPTOR_ITEMS: usize = 32;
const MAX_DESCRIPTOR_ITEM_BYTES: usize = 4096;
const CREDENTIAL_NAMES: [&str; 3] = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"];

/// The startup envelope is size-capped before decoding.
/// Startup-envelope decoding rejects unknown fields and requires absolute paths.
///
/// The launcher materializes qualified harness candidates before detaching.
/// The serve envelope carries retained closure digests or per-harness unavailability reasons.
/// The serve envelope carries no source paths.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartupEnvelope {
    pub schema: u32,
    pub data_dir: PathBuf,
    pub payload_manifest_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode: Option<HarnessSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<HarnessSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub credentials: BTreeMap<String, String>,
}

/// The launcher receives parent input.
/// The launcher adds its admitted data root and selected generation digest before invoking `serve`.
/// The launcher sends the immutable snapshot only through stdin and the native pipe.
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LauncherEnvelope {
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode: Option<HarnessCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<HarnessCandidate>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub credentials: BTreeMap<String, String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HarnessCandidate {
    pub manifest_sha256: String,
    pub source_roots: BTreeMap<String, PathBuf>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum HarnessSnapshot {
    Ready { manifest_sha256: String },
    Unavailable { reason: HarnessUnavailableReason },
}

/// The launcher may hand `serve` only the defined per-harness unavailability reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessUnavailableReason {
    DescriptorInvalid,
    ClosureIncomplete,
    ArgumentVariantInvalid,
}

impl HarnessUnavailableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DescriptorInvalid => "descriptor_invalid",
            Self::ClosureIncomplete => "closure_incomplete",
            Self::ArgumentVariantInvalid => "argument_variant_invalid",
        }
    }
}

pub const STARTUP_ENVELOPE_SCHEMA: u32 = 2;

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct HarnessSelection {
    schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opencode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pi: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    credential_identities: BTreeMap<String, String>,
}

pub struct PreparedLauncherEnvelope {
    data_dir: PathBuf,
    closure_root: PathBuf,
    selection: HarnessSelection,
    opencode: Option<HarnessSnapshot>,
    pi: Option<HarnessSnapshot>,
    credentials: BTreeMap<String, String>,
    pub changed: bool,
}

pub enum SelectionMode<'a> {
    Fresh,
    Running {
        credential_identity_key: &'a [u8; 32],
        require_previous_credentials: bool,
    },
}

impl PreparedLauncherEnvelope {
    pub fn to_startup(&self, payload_manifest_digest: String) -> StartupEnvelope {
        StartupEnvelope {
            schema: STARTUP_ENVELOPE_SCHEMA,
            data_dir: self.data_dir.clone(),
            payload_manifest_digest,
            opencode: self.opencode.clone(),
            pi: self.pi.clone(),
            credentials: self.credentials.clone(),
        }
    }

    pub fn commit_selection(&self, publication: &Path) -> Result<(), &'static str> {
        let key = credential_identity_key(publication)?;
        let mut selection = self.selection.clone();
        selection.credential_identities = credential_identities(&self.credentials, &key);
        write_selection(&self.closure_root, &selection)
    }
}

impl StartupEnvelope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema != STARTUP_ENVELOPE_SCHEMA {
            return Err("unsupported startup envelope schema");
        }
        if !self.data_dir.is_absolute() {
            return Err("startup envelope data_dir must be absolute");
        }
        if !mc_host::is_canonical_payload_digest(&self.payload_manifest_digest) {
            return Err("startup envelope payload digest is noncanonical");
        }
        validate_snapshot(self.opencode.as_ref())?;
        validate_snapshot(self.pi.as_ref())?;
        validate_credentials(&self.credentials)?;
        Ok(())
    }
}

impl LauncherEnvelope {
    pub fn empty() -> Self {
        Self {
            schema: 1,
            ..Self::default()
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema != 1 {
            return Err("unsupported launcher envelope schema");
        }
        validate_candidate(self.opencode.as_ref())?;
        validate_candidate(self.pi.as_ref())?;
        validate_credentials(&self.credentials)
    }

    pub fn prepare(
        self,
        data_dir: PathBuf,
        mode: SelectionMode<'_>,
    ) -> Result<PreparedLauncherEnvelope, &'static str> {
        let closure_root = data_dir.join("cortexkit").join("mc-host-harness-closures");
        let store = HarnessClosureStore::open(&closure_root).ok();
        // The validator memoizes results because recorded, supplied, and merged selections can cite the same digest; each `validate` re-hashes the closure tree.
        // The recorded, supplied, and merged selections can cite the same digest.
        // Each `validate` re-hashes the entire closure tree.
        let mut validator = ClosureValidator::new(store.as_ref());
        let running = matches!(mode, SelectionMode::Running { .. });
        let (previous, mut credential_identities, require_previous_credentials) = match mode {
            SelectionMode::Fresh => {
                // A successful fresh start replaces the previous selection.
                // A selection is stale when its cited closure no longer qualifies or validates.
                // A successful start commits a replacement selection.
                read_selection(&closure_root, &mut validator)?;
                (
                    HarnessSelection {
                        schema: 1,
                        ..HarnessSelection::default()
                    },
                    BTreeMap::new(),
                    false,
                )
            }
            SelectionMode::Running {
                credential_identity_key,
                require_previous_credentials,
            } => (
                match read_selection(&closure_root, &mut validator)? {
                    SelectionState::Active(previous) => previous,
                    SelectionState::Absent => HarnessSelection {
                        schema: 1,
                        ..HarnessSelection::default()
                    },
                    // The validator rejects a committed selection whose closure this binary cannot qualify or validate.
                    // A committed selection cannot be merged when this binary cannot qualify or validate its closure.
                    // `stop` clears stale selections.
                    // A fresh start replaces stale selections.
                    SelectionState::Stale => return Err("active harness selection is stale"),
                },
                credential_identities(&self.credentials, credential_identity_key),
                require_previous_credentials,
            ),
        };
        if running && !require_previous_credentials && self.credentials.is_empty() {
            credential_identities = previous.credential_identities.clone();
        }
        let supplied_opencode = self.opencode.is_some();
        let supplied_pi = self.pi.is_some();
        let candidate_digests: BTreeSet<String> = [self.opencode.as_ref(), self.pi.as_ref()]
            .into_iter()
            .flatten()
            .map(|candidate| candidate.manifest_sha256.clone())
            .collect();
        let opencode_candidate = materialize_snapshot("opencode", self.opencode, &mut validator);
        let pi_candidate = materialize_snapshot("pi", self.pi, &mut validator);
        if running
            && ((supplied_opencode
                && matches!(
                    &opencode_candidate,
                    Some(HarnessSnapshot::Unavailable { .. })
                ))
                || (supplied_pi
                    && matches!(&pi_candidate, Some(HarnessSnapshot::Unavailable { .. }))))
        {
            return Err("new owner supplied an unavailable harness descriptor");
        }
        let next_opencode = match &opencode_candidate {
            Some(HarnessSnapshot::Ready { manifest_sha256 }) => Some(manifest_sha256.clone()),
            _ => None,
        };
        let next_pi = match &pi_candidate {
            Some(HarnessSnapshot::Ready { manifest_sha256 }) => Some(manifest_sha256.clone()),
            _ => None,
        };
        let (selection, changed) = merge_selection(
            &previous,
            next_opencode,
            next_pi,
            credential_identities,
            require_previous_credentials,
        )?;
        let opencode = selected_snapshot(
            "opencode",
            selection.opencode.as_deref(),
            opencode_candidate,
            &mut validator,
        );
        let pi = selected_snapshot("pi", selection.pi.as_deref(), pi_candidate, &mut validator);
        // Pruning runs after validation and materialization.
        // The pruner protects every digest referenced by the active, candidate, or merged selection from pruning.
        // failed validation cannot delete the only recoverable closure.
        if let Some(store) = store.as_ref() {
            let mut protected = candidate_digests;
            protected.extend(previous.opencode.iter().cloned());
            protected.extend(previous.pi.iter().cloned());
            protected.extend(selection.opencode.iter().cloned());
            protected.extend(selection.pi.iter().cloned());
            store
                .prune(&protected)
                .map_err(|_| "harness closure prune failed")?;
        }
        Ok(PreparedLauncherEnvelope {
            data_dir,
            closure_root,
            selection,
            opencode,
            pi,
            credentials: self.credentials,
            changed,
        })
    }
}

fn merge_selection(
    previous: &HarnessSelection,
    opencode: Option<String>,
    pi: Option<String>,
    credential_identities: BTreeMap<String, String>,
    require_previous_credentials: bool,
) -> Result<(HarnessSelection, bool), &'static str> {
    let mut selection = previous.clone();
    if let Some(opencode) = opencode {
        selection.opencode = Some(opencode);
    }
    if let Some(pi) = pi {
        selection.pi = Some(pi);
    }
    let changed = selection.opencode != previous.opencode
        || selection.pi != previous.pi
        || credential_identities != previous.credential_identities;
    if require_previous_credentials && changed {
        return Err("restart cannot change the active harness selection");
    }
    if changed
        && previous
            .credential_identities
            .iter()
            .any(|(name, identity)| credential_identities.get(name) != Some(identity))
    {
        return Err("new owner cannot preserve the active credential source");
    }
    selection.credential_identities = credential_identities;
    Ok((selection, changed))
}

fn credential_identities(
    credentials: &BTreeMap<String, String>,
    connection_key: &[u8; 32],
) -> BTreeMap<String, String> {
    let derived = hmac_sha256(connection_key, &[ACTIVE_SELECTION_CREDENTIAL_DOMAIN]);
    credentials
        .iter()
        .map(|(name, value)| {
            let name_len = (name.len() as u64).to_be_bytes();
            let value_len = (value.len() as u64).to_be_bytes();
            let identity = hmac_sha256(
                &derived,
                &[&name_len, name.as_bytes(), &value_len, value.as_bytes()],
            )
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
            (name.clone(), identity)
        })
        .collect()
}

fn hmac_sha256(key: &[u8], segments: &[&[u8]]) -> [u8; 32] {
    debug_assert!(key.len() <= 64);
    let mut inner_pad = [0x36; 64];
    let mut outer_pad = [0x5c; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    for segment in segments {
        inner.update(segment);
    }
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    outer.finalize().into()
}

pub fn credential_identity_key(publication: &Path) -> Result<[u8; 32], &'static str> {
    let info =
        mc_host::read_connection_file(publication).map_err(|_| "connection key is unavailable")?;
    info.key
        .as_slice()
        .try_into()
        .map_err(|_| "connection key is invalid")
}

fn validate_credentials(credentials: &BTreeMap<String, String>) -> Result<(), &'static str> {
    let mut row_bytes = 0usize;
    for (name, value) in credentials {
        if !CREDENTIAL_NAMES.contains(&name.as_str()) {
            return Err("credential source contains an unsupported variable");
        }
        if value.is_empty() {
            return Err("credential source contains an empty value");
        }
        if value.len() > CREDENTIAL_VALUE_CAP_BYTES {
            return Err("credential value exceeds its size cap");
        }
        row_bytes = row_bytes
            .checked_add(name.len())
            .and_then(|bytes| bytes.checked_add(value.len()))
            .ok_or("credential row size overflow")?;
    }
    if row_bytes > CREDENTIAL_ROW_CAP_BYTES {
        return Err("credential row exceeds its size cap");
    }
    Ok(())
}

fn validate_candidate(candidate: Option<&HarnessCandidate>) -> Result<(), &'static str> {
    let Some(candidate) = candidate else {
        return Ok(());
    };
    if !mc_host::is_canonical_payload_digest(&candidate.manifest_sha256) {
        return Err("harness manifest digest is noncanonical");
    }
    if candidate.source_roots.is_empty() || candidate.source_roots.len() > MAX_DESCRIPTOR_ITEMS {
        return Err("harness source-root map is out of bounds");
    }
    for (name, path) in &candidate.source_roots {
        if name.is_empty()
            || name.len() > 128
            || !name.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
            })
        {
            return Err("harness source-root name is invalid");
        }
        if !path.is_absolute()
            || path.as_os_str().is_empty()
            || path.as_os_str().len() > MAX_DESCRIPTOR_ITEM_BYTES
        {
            return Err("harness source-root path is invalid");
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: Option<&HarnessSnapshot>) -> Result<(), &'static str> {
    match snapshot {
        None => Ok(()),
        Some(HarnessSnapshot::Ready { manifest_sha256 }) => {
            if mc_host::is_canonical_payload_digest(manifest_sha256) {
                Ok(())
            } else {
                Err("harness snapshot digest is noncanonical")
            }
        }
        Some(HarnessSnapshot::Unavailable { .. }) => Ok(()),
    }
}

fn qualified_manifest(
    harness: &str,
    expected_digest: &str,
) -> Result<ClosureManifest, HarnessUnavailableReason> {
    let (_, _, bytes) = mc_module::production_inputs::QUALIFIED_HARNESS_CLOSURES
        .iter()
        .find(|(name, digest, _)| *name == harness && *digest == expected_digest)
        .ok_or(HarnessUnavailableReason::DescriptorInvalid)?;
    let manifest: ClosureManifest =
        serde_json::from_str(bytes).map_err(|_| HarnessUnavailableReason::DescriptorInvalid)?;
    if manifest.harness != harness
        || manifest_digest(&manifest)
            .map_err(|_| HarnessUnavailableReason::DescriptorInvalid)?
            .as_str()
            != expected_digest
    {
        return Err(HarnessUnavailableReason::DescriptorInvalid);
    }
    // invalid descriptor.
    if manifest.argument_variant != "run_prompt" {
        return Err(HarnessUnavailableReason::ArgumentVariantInvalid);
    }
    Ok(manifest)
}

///
///
struct ClosureValidator<'a> {
    store: Option<&'a HarnessClosureStore>,
    validated: BTreeMap<String, bool>,
}

impl<'a> ClosureValidator<'a> {
    fn new(store: Option<&'a HarnessClosureStore>) -> Self {
        Self {
            store,
            validated: BTreeMap::new(),
        }
    }

    fn store(&self) -> Option<&'a HarnessClosureStore> {
        self.store
    }

    fn is_valid(&mut self, digest: &str) -> bool {
        if let Some(known) = self.validated.get(digest) {
            return *known;
        }
        let valid = self
            .store
            .and_then(|store| store.validate(digest).ok())
            .is_some();
        self.validated.insert(digest.to_owned(), valid);
        valid
    }

    /// The validator records digests validated by `materialize`.
    fn note_valid(&mut self, digest: &str) {
        self.validated.insert(digest.to_owned(), true);
    }
}

fn materialize_snapshot(
    harness: &str,
    candidate: Option<HarnessCandidate>,
    validator: &mut ClosureValidator<'_>,
) -> Option<HarnessSnapshot> {
    let candidate = candidate?;
    let manifest = match qualified_manifest(harness, &candidate.manifest_sha256) {
        Ok(manifest) => manifest,
        Err(reason) => return Some(HarnessSnapshot::Unavailable { reason }),
    };
    let Some(store) = validator.store() else {
        return Some(HarnessSnapshot::Unavailable {
            reason: HarnessUnavailableReason::ClosureIncomplete,
        });
    };
    if validator.is_valid(&candidate.manifest_sha256) {
        return Some(HarnessSnapshot::Ready {
            manifest_sha256: candidate.manifest_sha256,
        });
    }
    let closure = ClosureCandidate {
        manifest,
        source_roots: candidate.source_roots,
    };
    match store.materialize(&closure) {
        Ok(validated) => {
            validator.note_valid(validated.digest());
            Some(HarnessSnapshot::Ready {
                manifest_sha256: validated.digest().to_owned(),
            })
        }
        Err(_) => Some(HarnessSnapshot::Unavailable {
            reason: HarnessUnavailableReason::ClosureIncomplete,
        }),
    }
}

fn selected_snapshot(
    harness: &str,
    digest: Option<&str>,
    candidate: Option<HarnessSnapshot>,
    validator: &mut ClosureValidator<'_>,
) -> Option<HarnessSnapshot> {
    if matches!(candidate, Some(HarnessSnapshot::Unavailable { .. })) {
        return candidate;
    }
    let digest = digest?;
    if qualified_manifest(harness, digest).is_err() || !validator.is_valid(digest) {
        return Some(HarnessSnapshot::Unavailable {
            reason: HarnessUnavailableReason::ClosureIncomplete,
        });
    }
    Some(HarnessSnapshot::Ready {
        manifest_sha256: digest.to_owned(),
    })
}

///
enum SelectionState {
    Absent,
    Active(HarnessSelection),
    Stale,
}

fn read_selection(
    closure_root: &Path,
    validator: &mut ClosureValidator<'_>,
) -> Result<SelectionState, &'static str> {
    let path = closure_root.join(ACTIVE_HARNESS_SELECTION);
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SelectionState::Absent)
        }
        Err(_) => return Err("active harness selection is unreadable"),
    };
    let metadata = file
        .metadata()
        .map_err(|_| "active harness selection is unreadable")?;
    let root_metadata =
        std::fs::metadata(closure_root).map_err(|_| "active harness selection is unreadable")?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_ENVELOPE_BYTES as u64
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.nlink() != 1
        || metadata.uid() != root_metadata.uid()
    {
        return Err("active harness selection is invalid");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "active harness selection is unreadable")?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "active harness selection is invalid")?;
    if value.get("schema").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("unsupported active harness selection schema");
    }
    let selection: HarnessSelection =
        serde_json::from_value(value).map_err(|_| "active harness selection is invalid")?;
    if selection.schema != 1
        || selection
            .credential_identities
            .iter()
            .any(|(name, identity)| {
                !CREDENTIAL_NAMES.contains(&name.as_str())
                    || !mc_host::is_canonical_payload_digest(identity)
            })
    {
        return Err("active harness selection is invalid");
    }
    for (harness, digest) in [
        ("opencode", selection.opencode.as_deref()),
        ("pi", selection.pi.as_deref()),
    ] {
        if let Some(digest) = digest {
            if qualified_manifest(harness, digest).is_err() || !validator.is_valid(digest) {
                return Ok(SelectionState::Stale);
            }
        }
    }
    Ok(SelectionState::Active(selection))
}

fn write_selection(closure_root: &Path, selection: &HarnessSelection) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(selection).map_err(|_| "selection serialization failed")?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "active harness selection clock failed")?
        .as_nanos();
    let temp = closure_root.join(format!(
        ".{ACTIVE_HARNESS_SELECTION}.{}.{nonce}.tmp",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|_| "active harness selection temp creation failed")?;
    let final_path = closure_root.join(ACTIVE_HARNESS_SELECTION);
    let mut promoted = false;
    let result = (|| {
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "active harness selection write failed")?;
        std::fs::rename(&temp, &final_path)
            .map_err(|_| "active harness selection promotion failed")?;
        promoted = true;
        #[cfg(debug_assertions)]
        if std::env::var_os("CK_MC_HOST_TEST_FAIL_SELECTION_FSYNC").is_some() {
            return Err("injected active selection fsync failure");
        }
        std::fs::File::open(closure_root)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "active harness selection fsync failed")
    })();
    if !promoted {
        let _ = std::fs::remove_file(temp);
    } else if result.is_err() {
        let _ = std::fs::remove_file(&final_path);
        let _ = std::fs::File::open(closure_root).and_then(|dir| dir.sync_all());
    }
    result
}

pub fn clear_active_selection() -> Result<(), &'static str> {
    let data_dir = mc_host::data_dir_path(None)
        .ok()
        .ok_or("active harness selection root is unavailable")?;
    let closure_root = data_dir.join("cortexkit").join("mc-host-harness-closures");
    let path = closure_root.join(ACTIVE_HARNESS_SELECTION);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("active harness selection is unreadable"),
    }
    let store = HarnessClosureStore::open(&closure_root)
        .map_err(|_| "active harness selection root is unavailable")?;
    read_selection(&closure_root, &mut ClosureValidator::new(Some(&store)))?;
    #[cfg(debug_assertions)]
    if std::env::var_os("CK_MC_HOST_TEST_FAIL_SELECTION_REMOVAL").is_some() {
        return Err("injected active selection removal failure");
    }
    match std::fs::remove_file(path) {
        Ok(()) => std::fs::File::open(closure_root)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "active harness selection fsync failed"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("active harness selection removal failed"),
    }
}

struct UnavailableBackend {
    subreason: &'static str,
}

impl LlmExecutionBackend for UnavailableBackend {
    fn execute(
        &self,
        _request: BackendRequest,
        _events: EventSink,
        _cancel: CancellationToken,
    ) -> BackendFuture {
        let message = format!("harness_unavailable: {}", self.subreason);
        Box::pin(async move {
            BackendTerminal::Failed(BackendError {
                class: ErrorClass::Permanent,
                message,
                retry_after_secs: None,
                provider_code: None,
            })
        })
    }

    fn unavailable_reason(&self, _harness: Harness) -> Option<&'static str> {
        Some(self.subreason)
    }
}

fn harness_backend(envelope: &StartupEnvelope, env: &EnvSnapshot) -> HarnessDispatchBackend {
    let closure_root = envelope
        .data_dir
        .join("cortexkit")
        .join("mc-host-harness-closures");
    let store = HarnessClosureStore::open(&closure_root).ok();

    let opencode: Arc<dyn LlmExecutionBackend> =
        match open_snapshot(envelope.opencode.as_ref(), "opencode", store.as_ref()) {
            Ok(closure) => match closure.manifest().executable.clone() {
                Some(executable_node) => Arc::new(OpenCodeBackend::new(
                    OpenCodeRuntime {
                        closure,
                        executable_node,
                    },
                    env.clone(),
                )),
                None => unavailable("closure_incomplete"),
            },
            Err(reason) => unavailable(reason),
        };
    let pi: Arc<dyn LlmExecutionBackend> =
        match open_snapshot(envelope.pi.as_ref(), "pi", store.as_ref()) {
            Ok(closure) => {
                let manifest = closure.manifest();
                match (manifest.interpreter.clone(), manifest.entrypoint.clone()) {
                    (Some(interpreter_node), Some(entrypoint_node)) => {
                        let provider_extension_nodes = manifest.extensions.clone();
                        Arc::new(PiBackend::new(
                            PiRuntimeDescriptor {
                                closure,
                                interpreter_node,
                                entrypoint_node,
                                provider_extension_nodes,
                            },
                            env.clone(),
                        ))
                    }
                    _ => unavailable("closure_incomplete"),
                }
            }
            Err(reason) => unavailable(reason),
        };
    HarnessDispatchBackend::new(opencode, pi)
}

fn unavailable(reason: &'static str) -> Arc<dyn LlmExecutionBackend> {
    Arc::new(UnavailableBackend { subreason: reason })
}

fn open_snapshot(
    snapshot: Option<&HarnessSnapshot>,
    harness: &str,
    store: Option<&HarnessClosureStore>,
) -> Result<Arc<ValidatedHarnessClosure>, &'static str> {
    let Some(snapshot) = snapshot else {
        return Err("descriptor_absent");
    };
    match snapshot {
        HarnessSnapshot::Unavailable { reason } => Err(reason.as_str()),
        HarnessSnapshot::Ready { manifest_sha256 } => {
            let store = store.ok_or("closure_incomplete")?;
            let closure = store
                .validate(manifest_sha256)
                .map_err(|_| "closure_incomplete")?;
            if closure.manifest().harness != harness {
                return Err("descriptor_invalid");
            }
            if closure.manifest().argument_variant != "run_prompt" {
                return Err("argument_variant_invalid");
            }
            Ok(Arc::new(closure))
        }
    }
}

fn read_envelope() -> Result<StartupEnvelope, &'static str> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_ENVELOPE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "startup envelope read failed")?;
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err("startup envelope exceeds size bound");
    }
    let envelope: StartupEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| "startup envelope is malformed")?;
    envelope.validate()?;
    Ok(envelope)
}

pub fn read_launcher_envelope() -> Result<LauncherEnvelope, &'static str> {
    if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return Ok(LauncherEnvelope::empty());
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_ENVELOPE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "launcher envelope read failed")?;
    if bytes.is_empty() {
        return Ok(LauncherEnvelope::empty());
    }
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err("launcher envelope exceeds size bound");
    }
    let envelope: LauncherEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| "launcher envelope is malformed")?;
    envelope.validate()?;
    Ok(envelope)
}

fn storage_init(root: &Path) -> Result<HostInit, &'static str> {
    let managed =
        mc_host::managed_dir_path(Some(root)).map_err(|_| "managed directory path failed")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&managed)
        .map_err(|_| "managed directory creation failed")?;
    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context".to_owned(),
        storage_namespace: "mc_cache".to_owned(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: managed.join(STORE_FILE).to_string_lossy().into_owned(),
        },
    };
    Ok(HostInit {
        subc_capabilities: Vec::new(),
        storage: Some(serde_json::to_value(descriptor).expect("storage descriptor serializes")),
    })
}

fn synapse_component(generation: &ValidatedGeneration) -> SynapseComponent {
    #[cfg(target_os = "macos")]
    {
        let _ = generation;
        return SynapseComponent::unsupported("synapse_unsupported");
    }
    #[cfg(not(target_os = "macos"))]
    {
        const BUNDLE_DIR: &str = "payload/model/gte-modernbert-base-f16";
        const ORT_LIBRARY: &str = "payload/ort/libonnxruntime.so";
        let Some(ort) = generation
            .manifest
            .files
            .iter()
            .find(|entry| entry.path == ORT_LIBRARY)
        else {
            return SynapseComponent::new(None);
        };
        let descriptor_root = generation.descriptor_root_path();
        let bundle_dir = descriptor_root.join(BUNDLE_DIR);
        // The generation manifest carries `bundle_manifest.sha256` forward because it authenticates the bundle; otherwise, a replaced bundle can remain self-consistent while serving different embeddings.
        // The generation manifest carries `bundle_manifest.sha256` forward because it authenticates the bundle; otherwise, a replaced bundle can remain self-consistent while serving different embeddings.
        // The generation manifest carries `bundle_manifest.sha256` forward because it authenticates the bundle; otherwise, a replaced bundle can remain self-consistent while serving different embeddings.
        let Some(bundle_manifest) = generation
            .manifest
            .files
            .iter()
            .find(|entry| entry.path == format!("{BUNDLE_DIR}/manifest.json"))
        else {
            return SynapseComponent::new(None);
        };
        SynapseComponent::new(Some(SynapseConfig {
            bundle_dir,
            ort_library: descriptor_root.join(ORT_LIBRARY),
            bundle_manifest_sha256: Some(bundle_manifest.sha256.clone()),
            ort_library_sha256: ort.sha256.clone(),
            limits: SynapseLimits::default(),
        }))
    }
}

pub fn run() -> Result<(), &'static str> {
    let envelope = read_envelope()?;
    let root = envelope.data_dir.clone();

    // The daemon serves only the generation selected by the envelope.
    let store = GenerationStore::open_probe(Some(&root))
        .map_err(|_| "generation store probe failed")?
        .ok_or("generation store is missing")?;
    let generation = store
        .validate(&envelope.payload_manifest_digest)
        .map_err(|_| "staged generation failed revalidation")?;

    let publication = mc_host::runtime_dir_path(Some(&root))
        .map_err(|_| "runtime directory resolution failed")?
        .join(mc_host::CONNECTION_FILE_NAME);
    let init = storage_init(&root)?;

    let env = EnvSnapshot::capture_from(
        envelope
            .credentials
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value))),
    )
    .map_err(|_| "credential snapshot exceeds bounds")?;
    let synapse = synapse_component(&generation);
    let backend: Arc<dyn LlmExecutionBackend> = Arc::new(harness_backend(&envelope, &env));
    let broca = if envelope.credentials.is_empty() {
        BrocaComponent::new(backend)
    } else {
        BrocaComponent::new_with_credentials(backend, env.clone())
    };
    let composite = StaticComposite::new(
        mc_module::McHandler::new_with_connection_file(Some(publication)),
        synapse,
        broca,
    )
    .map_err(|_| "composite construction failed")?;

    let config = HostConfig {
        data_dir: Some(root),
        daemon_ver: mc_module::release_contract::DAEMON_VERSION.to_owned(),
        payload_manifest_digest: envelope.payload_manifest_digest.clone(),
        init,
        limits: mc_host::HostLimits {
            max_resident_bytes: mc_host::HostLimits::default().max_resident_bytes
                + mc_module::DECLARED_RETAINED_RESIDENT_BYTES
                + mc_host::broca::config::DECLARED_RETAINED_RESIDENT_BYTES,
            ..mc_host::HostLimits::default()
        },
        ..HostConfig::default()
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .map_err(|_| "tokio runtime construction failed")?;
    let shutdown = CancellationToken::new();
    runtime.block_on(async {
        let signal_shutdown = shutdown.clone();
        //
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|_| "SIGTERM handler installation failed")?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .map_err(|_| "SIGINT handler installation failed")?;
        let signal_task = tokio::spawn(async move {
            let received = tokio::select! {
                signal = terminate.recv() => signal,
                signal = interrupt.recv() => signal,
            };
            if received.is_some() {
                signal_shutdown.cancel();
            }
        });
        let result = mc_host::run(composite, config, shutdown.clone()).await;
        signal_task.abort();
        let _ = signal_task.await;
        result.map_err(|_| "host runtime exited with an error")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_mac_matches_hmac_sha256() {
        let digest = hmac_sha256(b"key", &[b"The quick brown fox jumps over the lazy dog"]);
        let encoded: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            encoded,
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn harness_selection_merges_without_losing_prior_credentials() {
        let key = [7; 32];
        let previous_credentials =
            BTreeMap::from([("ANTHROPIC_API_KEY".to_owned(), "shared-secret".to_owned())]);
        let previous = HarnessSelection {
            schema: 1,
            opencode: Some("a".repeat(64)),
            pi: None,
            credential_identities: credential_identities(&previous_credentials, &key),
        };
        let credentials = BTreeMap::from([
            ("ANTHROPIC_API_KEY".to_owned(), "shared-secret".to_owned()),
            ("OPENAI_API_KEY".to_owned(), "second-secret".to_owned()),
        ]);
        let (merged, changed) = merge_selection(
            &previous,
            None,
            Some("b".repeat(64)),
            credential_identities(&credentials, &key),
            false,
        )
        .expect("qualified second owner merges");
        assert!(changed);
        assert_eq!(merged.opencode, previous.opencode);
        assert_eq!(merged.pi, Some("b".repeat(64)));
        assert!(merged
            .credential_identities
            .contains_key("ANTHROPIC_API_KEY"));
        assert!(merged.credential_identities.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn harness_selection_requires_exact_prior_credentials() {
        let key = [9; 32];
        let previous_credentials =
            BTreeMap::from([("ANTHROPIC_API_KEY".to_owned(), "first-secret".to_owned())]);
        let previous = HarnessSelection {
            schema: 1,
            opencode: Some("a".repeat(64)),
            pi: None,
            credential_identities: credential_identities(&previous_credentials, &key),
        };
        assert!(merge_selection(
            &previous,
            None,
            Some("b".repeat(64)),
            credential_identities(
                &BTreeMap::from([("OPENAI_API_KEY".to_owned(), "other-secret".to_owned())]),
                &key,
            ),
            false,
        )
        .is_err());
        assert!(merge_selection(
            &previous,
            None,
            None,
            credential_identities(
                &BTreeMap::from([(
                    "ANTHROPIC_API_KEY".to_owned(),
                    "different-secret".to_owned()
                )]),
                &key,
            ),
            true,
        )
        .is_err());
    }

    #[test]
    fn harness_restart_refuses_a_new_descriptor_even_with_exact_credentials() {
        let key = [10; 32];
        let credentials =
            BTreeMap::from([("ANTHROPIC_API_KEY".to_owned(), "shared-secret".to_owned())]);
        let previous = HarnessSelection {
            schema: 1,
            opencode: Some("a".repeat(64)),
            pi: None,
            credential_identities: credential_identities(&credentials, &key),
        };
        assert!(merge_selection(
            &previous,
            None,
            Some("b".repeat(64)),
            credential_identities(&credentials, &key),
            true,
        )
        .is_err());
    }

    #[test]
    fn harness_selection_persists_only_digests_and_keyed_credential_identities() {
        let root = tempfile::tempdir().expect("selection root");
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700))
            .expect("selection root mode");
        let store = HarnessClosureStore::open(root.path()).expect("closure store");
        let credentials = BTreeMap::from([(
            "ANTHROPIC_API_KEY".to_owned(),
            "credential-value".to_owned(),
        )]);
        let selection = HarnessSelection {
            schema: 1,
            opencode: None,
            pi: None,
            credential_identities: credential_identities(&credentials, &[11; 32]),
        };
        write_selection(root.path(), &selection).expect("write selection");
        let loaded = match read_selection(root.path(), &mut ClosureValidator::new(Some(&store)))
            .expect("read selection")
        {
            SelectionState::Active(loaded) => loaded,
            _ => panic!("a committed selection must read back as active"),
        };
        assert_eq!(loaded, selection);
        let bytes =
            std::fs::read(root.path().join(ACTIVE_HARNESS_SELECTION)).expect("selection bytes");
        assert!(!String::from_utf8_lossy(&bytes).contains("credential-value"));
        assert!(!String::from_utf8_lossy(&bytes).contains("first-secret"));
        let mode = std::fs::metadata(root.path().join(ACTIVE_HARNESS_SELECTION))
            .expect("selection metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    fn plant_stale_selection(closure_root: &Path) {
        std::fs::create_dir_all(closure_root).expect("closure root");
        std::fs::set_permissions(closure_root, std::fs::Permissions::from_mode(0o700))
            .expect("closure root mode");
        write_selection(
            closure_root,
            &HarnessSelection {
                schema: 1,
                opencode: Some("f".repeat(64)),
                pi: None,
                credential_identities: BTreeMap::new(),
            },
        )
        .expect("write stale selection");
    }

    #[test]
    fn a_selection_citing_an_unqualified_closure_reads_as_stale_not_invalid() {
        let root = tempfile::tempdir().expect("selection root");
        let closure_root = root.path().join("closures");
        plant_stale_selection(&closure_root);
        let store = HarnessClosureStore::open(&closure_root).expect("closure store");
        assert!(matches!(
            read_selection(&closure_root, &mut ClosureValidator::new(Some(&store)))
                .expect("stale selection reads"),
            SelectionState::Stale
        ));
    }

    #[test]
    fn fresh_prepare_ignores_a_stale_selection_and_running_prepare_refuses_it() {
        let root = tempfile::tempdir().expect("data root");
        let data_dir = root.path().to_path_buf();
        let closure_root = data_dir.join("cortexkit").join("mc-host-harness-closures");
        plant_stale_selection(&closure_root);

        let envelope = || LauncherEnvelope {
            schema: 1,
            opencode: None,
            pi: None,
            credentials: BTreeMap::new(),
        };
        let prepared = envelope()
            .prepare(data_dir.clone(), SelectionMode::Fresh)
            .expect("fresh start ignores a stale selection");
        assert!(!prepared.changed);
        match envelope().prepare(
            data_dir,
            SelectionMode::Running {
                credential_identity_key: &[12; 32],
                require_previous_credentials: true,
            },
        ) {
            Err(reason) => assert_eq!(reason, "active harness selection is stale"),
            Ok(_) => panic!("running merge must refuse a stale selection"),
        }
    }

    #[test]
    fn the_closure_validator_answers_each_digest_once() {
        let root = tempfile::tempdir().expect("closure root");
        let closure_root = root.path().join("closures");
        std::fs::create_dir_all(&closure_root).expect("closure root");
        std::fs::set_permissions(&closure_root, std::fs::Permissions::from_mode(0o700))
            .expect("closure root mode");
        let store = HarnessClosureStore::open(&closure_root).expect("closure store");
        let absent = "f".repeat(64);

        let mut validator = ClosureValidator::new(Some(&store));
        assert!(!validator.is_valid(&absent));
        assert!(!validator.is_valid(&absent));
        assert_eq!(validator.validated.len(), 1);
        assert_eq!(validator.validated.get(&absent), Some(&false));

        validator.note_valid(&absent);
        assert!(validator.is_valid(&absent));
        assert_eq!(validator.validated.len(), 1);

        let mut storeless = ClosureValidator::new(None);
        assert!(!storeless.is_valid(&absent));
        assert!(storeless.store().is_none());
    }
}
