//! `ck-mc-host serve`: the daemon mode.
//!
//! Reads one bounded, strictly decoded startup envelope from stdin (the
//! launcher's intentional pipe), revalidates the staged generation named by
//! the envelope, composes the fixed Magic Context + Synapse + Broca profile,
//! and runs the existing mc-host runtime. Lock acquisition (lifetime fence
//! then runtime lock), the `starting` record, publication, and the
//! post-publication activation split all live inside `mc_host::run`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use hmac::{Hmac, Mac};
use mc_host::broca::backend::{
    BackendError, BackendFuture, BackendRequest, BackendTerminal, ErrorClass, EventSink,
    HarnessDispatchBackend, LlmExecutionBackend,
};
use mc_host::broca::opencode::{OpenCodeBackend, OpenCodeRuntime};
use mc_host::broca::pi::{PiBackend, PiRuntimeDescriptor};
use mc_host::broca::subprocess::EnvSnapshot;
use mc_host::broca::BrocaComponent;
use mc_host::generation::{GenerationStore, ValidatedGeneration};
use mc_host::harness_closure::{
    manifest_digest, ClosureCandidate, ClosureManifest, HarnessClosureStore,
    ValidatedHarnessClosure,
};
use mc_host::synapse::{SynapseComponent, SynapseConfig, SynapseLimits};
use mc_host::{CancellationToken, HostConfig, HostInit, StaticComposite};
use sha2::Sha256;

use crate::spawn::MAX_ENVELOPE_BYTES;

const STORE_FILE: &str = "mc-store.db";
const ACTIVE_HARNESS_SELECTION: &str = "active-selection.json";
const ACTIVE_SELECTION_CREDENTIAL_DOMAIN: &[u8] = b"mc-host-active-selection-credential-v1";
const MAX_DESCRIPTOR_ITEMS: usize = 32;
const MAX_DESCRIPTOR_ITEM_BYTES: usize = 4096;
const CREDENTIAL_VALUE_CAP_BYTES: usize = 16 * 1024;
const CREDENTIAL_ROW_CAP_BYTES: usize = 64 * 1024;
const CREDENTIAL_NAMES: [&str; 3] = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"];

/// The bounded launcher-to-serve startup envelope (KTD18). Strict: unknown
/// fields are rejected, every path is absolute, and the whole document is
/// size-capped before decoding.
///
/// The launcher materializes qualified harness candidates before detach, so
/// this serve envelope carries only retained closure digests or closed
/// per-harness unavailability reasons. Source paths never cross into serve.
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

/// Parent-to-launcher input. The launcher adds its admitted data root and
/// selected generation digest before handing the immutable snapshot to
/// `serve`; values travel only through stdin and the intentional native pipe.
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
    Unavailable { reason: String },
}

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
            schema: 1,
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
        if self.schema != 1 {
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
        let running = matches!(mode, SelectionMode::Running { .. });
        let (previous, mut credential_identities, require_previous_credentials) = match mode {
            SelectionMode::Fresh => {
                read_selection(&closure_root, store.as_ref())?;
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
                read_selection(&closure_root, store.as_ref())?,
                credential_identities(&self.credentials, credential_identity_key),
                require_previous_credentials,
            ),
        };
        if running && !require_previous_credentials && self.credentials.is_empty() {
            credential_identities = previous.credential_identities.clone();
        }
        let supplied_opencode = self.opencode.is_some();
        let supplied_pi = self.pi.is_some();
        let opencode_candidate = materialize_snapshot("opencode", self.opencode, store.as_ref());
        let pi_candidate = materialize_snapshot("pi", self.pi, store.as_ref());
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
            store.as_ref(),
        );
        let pi = selected_snapshot("pi", selection.pi.as_deref(), pi_candidate, store.as_ref());
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
    if (changed || require_previous_credentials)
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
    let mut derive =
        Hmac::<Sha256>::new_from_slice(connection_key).expect("HMAC accepts any key length");
    derive.update(ACTIVE_SELECTION_CREDENTIAL_DOMAIN);
    let derived = derive.finalize().into_bytes();
    credentials
        .iter()
        .map(|(name, value)| {
            let mut mac =
                Hmac::<Sha256>::new_from_slice(&derived).expect("HMAC accepts any key length");
            mac.update(&(name.len() as u64).to_be_bytes());
            mac.update(name.as_bytes());
            mac.update(&(value.len() as u64).to_be_bytes());
            mac.update(value.as_bytes());
            let identity = mac
                .finalize()
                .into_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            (name.clone(), identity)
        })
        .collect()
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
        Some(HarnessSnapshot::Unavailable { reason })
            if matches!(
                reason.as_str(),
                "descriptor_invalid" | "closure_incomplete" | "argument_variant_invalid"
            ) =>
        {
            Ok(())
        }
        Some(HarnessSnapshot::Unavailable { .. }) => {
            Err("harness snapshot unavailable reason is invalid")
        }
    }
}

fn qualified_manifest(harness: &str, expected_digest: &str) -> Option<ClosureManifest> {
    let (_, _, bytes) = mc_module::production_inputs::QUALIFIED_HARNESS_CLOSURES
        .iter()
        .find(|(name, digest, _)| *name == harness && *digest == expected_digest)?;
    let manifest: ClosureManifest = serde_json::from_str(bytes).ok()?;
    if manifest.harness != harness
        || manifest.argument_variant != "run_prompt"
        || manifest_digest(&manifest).ok()?.as_str() != expected_digest
    {
        return None;
    }
    Some(manifest)
}

fn materialize_snapshot(
    harness: &str,
    candidate: Option<HarnessCandidate>,
    store: Option<&HarnessClosureStore>,
) -> Option<HarnessSnapshot> {
    let candidate = candidate?;
    let Some(manifest) = qualified_manifest(harness, &candidate.manifest_sha256) else {
        return Some(HarnessSnapshot::Unavailable {
            reason: "descriptor_invalid".to_owned(),
        });
    };
    let Some(store) = store else {
        return Some(HarnessSnapshot::Unavailable {
            reason: "closure_incomplete".to_owned(),
        });
    };
    let closure = ClosureCandidate {
        manifest,
        source_roots: candidate.source_roots,
    };
    match store.materialize(&closure) {
        Ok(validated) => Some(HarnessSnapshot::Ready {
            manifest_sha256: validated.digest().to_owned(),
        }),
        Err(_) => Some(HarnessSnapshot::Unavailable {
            reason: "closure_incomplete".to_owned(),
        }),
    }
}

fn selected_snapshot(
    harness: &str,
    digest: Option<&str>,
    candidate: Option<HarnessSnapshot>,
    store: Option<&HarnessClosureStore>,
) -> Option<HarnessSnapshot> {
    if matches!(candidate, Some(HarnessSnapshot::Unavailable { .. })) {
        return candidate;
    }
    let digest = digest?;
    if qualified_manifest(harness, digest).is_none()
        || store
            .and_then(|store| store.validate(digest).ok())
            .is_none()
    {
        return Some(HarnessSnapshot::Unavailable {
            reason: "closure_incomplete".to_owned(),
        });
    }
    Some(HarnessSnapshot::Ready {
        manifest_sha256: digest.to_owned(),
    })
}

fn read_selection(
    closure_root: &Path,
    store: Option<&HarnessClosureStore>,
) -> Result<HarnessSelection, &'static str> {
    let path = closure_root.join(ACTIVE_HARNESS_SELECTION);
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HarnessSelection {
                schema: 1,
                ..HarnessSelection::default()
            })
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
            if qualified_manifest(harness, digest).is_none()
                || store
                    .and_then(|store| store.validate(digest).ok())
                    .is_none()
            {
                return Err("active harness selection is invalid");
            }
        }
    }
    Ok(selection)
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
    let data_dir = mc_host::runtime_dir_path(None)
        .ok()
        .and_then(|run_dir| {
            run_dir
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
        })
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
    read_selection(&closure_root, Some(&store))?;
    match std::fs::remove_file(path) {
        Ok(()) => std::fs::File::open(closure_root)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "active harness selection fsync failed"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("active harness selection removal failed"),
    }
}

/// Typed stand-in for a harness with no startup descriptor: every run
/// resolves to one host-authored permanent failure carrying the closed
/// `harness_unavailable` subreason and nothing else.
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
        HarnessSnapshot::Unavailable { reason } => match reason.as_str() {
            "descriptor_invalid" => Err("descriptor_invalid"),
            "closure_incomplete" => Err("closure_incomplete"),
            "argument_variant_invalid" => Err("argument_variant_invalid"),
            _ => Err("descriptor_invalid"),
        },
        HarnessSnapshot::Ready { manifest_sha256 } => {
            let store = store.ok_or("closure_incomplete")?;
            let closure = store
                .validate(manifest_sha256)
                .map_err(|_| "closure_incomplete")?;
            if closure.manifest().harness != harness
                || closure.manifest().argument_variant != "run_prompt"
            {
                return Err("descriptor_invalid");
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
    let managed = root.join("cortexkit");
    std::fs::create_dir_all(&managed).map_err(|_| "managed directory creation failed")?;
    std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "managed directory permissions failed")?;
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
        if !generation
            .manifest
            .files
            .iter()
            .any(|entry| entry.path == format!("{BUNDLE_DIR}/manifest.json"))
        {
            return SynapseComponent::new(None);
        }
        SynapseComponent::new(Some(SynapseConfig {
            bundle_dir,
            ort_library: descriptor_root.join(ORT_LIBRARY),
            ort_library_sha256: ort.sha256.clone(),
            limits: SynapseLimits::default(),
        }))
    }
}

/// Runs the daemon. Errors are bounded static strings written to stderr by
/// `main` — which detached start redirects to the owner-only daemon log.
pub fn run() -> Result<(), &'static str> {
    let envelope = read_envelope()?;
    let root = envelope.data_dir.clone();

    // Revalidate the staged generation named by the envelope before serving
    // (U2 approach step 5). Serve never selects another generation.
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
    let composite = StaticComposite::new(
        mc_module::McHandler::new_with_connection_file(Some(publication)),
        synapse,
        BrocaComponent::new_with_credentials(
            Arc::new(harness_backend(&envelope, &env)),
            env.clone(),
        ),
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
        let signal_task = tokio::spawn(async move {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler installs");
            let mut interrupt =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                    .expect("SIGINT handler installs");
            if tokio::select! {
                received = terminate.recv() => received,
                received = interrupt.recv() => received,
            }
            .is_some()
            {
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
        let loaded = read_selection(root.path(), Some(&store)).expect("read selection");
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
}
