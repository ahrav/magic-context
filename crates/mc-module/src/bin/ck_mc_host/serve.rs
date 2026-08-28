//! `ck-mc-host serve`: the daemon mode.
//!
//! Reads one bounded, strictly decoded startup envelope from stdin (the
//! launcher's intentional pipe), revalidates the staged generation named by
//! the envelope, composes the fixed Magic Context + Synapse + Broca profile,
//! and runs the existing mc-host runtime. Lock acquisition (lifetime fence
//! then runtime lock), the `starting` record, publication, and the
//! post-publication activation split all live inside `mc_host::run`.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mc_host::broca::backend::{
    BackendError, BackendFuture, BackendRequest, BackendTerminal, ErrorClass, EventSink,
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

use crate::spawn::MAX_ENVELOPE_BYTES;

const STORE_FILE: &str = "mc-store.db";
const MAX_DESCRIPTOR_ITEMS: usize = 32;
const MAX_DESCRIPTOR_ITEM_BYTES: usize = 4096;
const CREDENTIAL_NAMES: [&str; 3] = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"];

/// The bounded launcher-to-serve startup envelope (KTD18). Strict: unknown
/// fields are rejected, every path is absolute, and the whole document is
/// size-capped before decoding.
///
/// The launcher materializes qualified harness candidates before detach, so
/// this serve envelope carries only retained closure digests or closed
/// per-harness unavailability reasons. Source paths never cross into serve.
#[derive(serde::Serialize, serde::Deserialize)]
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

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum HarnessSnapshot {
    Ready { manifest_sha256: String },
    Unavailable { reason: HarnessUnavailableReason },
}

/// The closed set of per-harness unavailability reasons the launcher may
/// hand to serve. A typed enum (not a string) so serde rejects unknown
/// reasons at decode and every consumer match is exhaustiveness-checked —
/// a reason added to the producer without a consumer arm fails the build
/// instead of silently degrading to `descriptor_invalid`. Variants must
/// stay in the release contract's `harness_unavailable.reasons_by_precedence`.
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

/// Current startup envelope schema. Bumped whenever the envelope's decoded
/// shape changes so a cross-version launcher/serve pairing fails as a typed
/// schema mismatch instead of an opaque decode error.
pub const STARTUP_ENVELOPE_SCHEMA: u32 = 2;

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

    pub fn materialize_into_startup(
        self,
        data_dir: PathBuf,
        payload_manifest_digest: String,
    ) -> StartupEnvelope {
        let closure_root = data_dir.join("cortexkit").join("mc-host-harness-closures");
        let store = HarnessClosureStore::open(&closure_root).ok();
        // Closures are content-addressed and never referenced across starts
        // except through this envelope, so every digest the candidates do
        // not name — superseded harness versions and staging directories
        // orphaned by an interrupted copy — is reclaimed here, under the
        // launcher's start transaction. Without this each qualified harness
        // version retains its full runtime copy forever.
        if let Some(store) = store.as_ref() {
            let protected: BTreeSet<String> = [self.opencode.as_ref(), self.pi.as_ref()]
                .into_iter()
                .flatten()
                .map(|candidate| candidate.manifest_sha256.clone())
                .collect();
            let _ = store.prune(&protected);
        }
        let opencode = materialize_snapshot("opencode", self.opencode, store.as_ref());
        let pi = materialize_snapshot("pi", self.pi, store.as_ref());
        StartupEnvelope {
            schema: STARTUP_ENVELOPE_SCHEMA,
            data_dir,
            payload_manifest_digest,
            opencode,
            pi,
            credentials: self.credentials,
        }
    }
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
        // The reason set is closed by the `HarnessUnavailableReason` enum:
        // serde already rejected anything outside it during decode.
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
    // The variant mismatch has its own reason so operators see "this build
    // does not speak the qualified argument shape" rather than a generic
    // invalid descriptor.
    if manifest.argument_variant != "run_prompt" {
        return Err(HarnessUnavailableReason::ArgumentVariantInvalid);
    }
    Ok(manifest)
}

fn materialize_snapshot(
    harness: &str,
    candidate: Option<HarnessCandidate>,
    store: Option<&HarnessClosureStore>,
) -> Option<HarnessSnapshot> {
    let candidate = candidate?;
    let manifest = match qualified_manifest(harness, &candidate.manifest_sha256) {
        Ok(manifest) => manifest,
        Err(reason) => return Some(HarnessSnapshot::Unavailable { reason }),
    };
    let Some(store) = store else {
        return Some(HarnessSnapshot::Unavailable {
            reason: HarnessUnavailableReason::ClosureIncomplete,
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
            reason: HarnessUnavailableReason::ClosureIncomplete,
        }),
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
    // A terminal never sends EOF on its own, so reading to end would hang an
    // interactive `ck-mc-host start` forever. A TTY carries no envelope by
    // definition — the launcher always redirects or closes stdin — so treat it as
    // the absent envelope it is instead of blocking on a human.
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
    // The managed segment is the library's definition, not a second copy: a
    // rename here would otherwise leave the store outside the tree that
    // `mc_host::run` creates and validates.
    let managed =
        mc_host::managed_dir_path(Some(root)).map_err(|_| "managed directory path failed")?;
    // Mode is applied by mkdir(2) at creation rather than by a follow-up
    // chmod: `set_permissions` follows symlinks, so on a pre-existing
    // symlinked path it would change the mode of the target instead. The
    // authoritative owner-only creation and ancestor validation of this tree
    // stay with `mc_host::run`.
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
        let bundle_dir = generation.path().join(BUNDLE_DIR);
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
            ort_library: generation.path().join(ORT_LIBRARY),
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
    // The credential verifier fails closed on every Broca send, so it is
    // installed only when the launcher actually admitted credential rows —
    // an envelope with none (older parents, credential-less deployments)
    // keeps the harness lane on its pre-credential behavior instead of
    // hard-failing every send with `credential_snapshot_mismatch`.
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
        // Installed before the host future starts. Creating a stream inside the
        // spawned task races `mc_host::run`: a signal arriving before
        // registration takes the default disposition and kills the daemon
        // outright, so the runtime never observes the cancellation and the
        // fenced teardown in `mc_host::run` never runs. An installation failure
        // is also fatal to the shutdown path, so it fails startup here rather
        // than panicking a detached task and leaving `run` serving with no
        // signal handling and nothing reporting it.
        //
        // SIGINT is handled alongside SIGTERM: the spawn path resets every
        // inherited disposition to its default, so an interrupt from an operator
        // or a process supervisor would otherwise terminate the daemon without
        // draining routes and components.
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
