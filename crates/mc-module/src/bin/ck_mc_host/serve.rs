//! `ck-mc-host serve`: the daemon mode.
//!
//! Reads one bounded, strictly decoded startup envelope from stdin (the
//! launcher's intentional pipe), revalidates the staged generation named by
//! the envelope, composes the fixed Magic Context + Synapse + Broca profile,
//! and runs the existing mc-host runtime. Lock acquisition (lifetime fence
//! then runtime lock), the `starting` record, publication, and the
//! post-publication activation split all live inside `mc_host::run`.

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
use mc_host::broca::subprocess::EnvSnapshot;
use mc_host::broca::BrocaComponent;
use mc_host::generation::GenerationStore;
use mc_host::synapse::SynapseComponent;
use mc_host::{CancellationToken, HostConfig, HostInit, StaticComposite};

use crate::spawn::MAX_ENVELOPE_BYTES;

const STORE_FILE: &str = "mc-store.db";
const MAX_DESCRIPTOR_ITEMS: usize = 32;
const MAX_DESCRIPTOR_ITEM_BYTES: usize = 4096;

/// The bounded launcher-to-serve startup envelope (KTD18). Strict: unknown
/// fields are rejected, every path is absolute, and the whole document is
/// size-capped before decoding.
///
/// ponytail: KTD21's daemon-owned closure copies, typed argument variants,
/// and keyed credential-row fingerprints are deferred — none of that
/// machinery exists in mc-host's broca module yet. Today the envelope
/// carries only the strict optional harness descriptors the existing
/// OpenCode/Pi adapters consume; an absent descriptor maps to a typed
/// harness-unavailable terminal (`descriptor_absent`).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartupEnvelope {
    pub schema: u32,
    pub data_dir: PathBuf,
    pub payload_manifest_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode: Option<OpenCodeDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<PiDescriptor>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenCodeDescriptor {
    pub executable: PathBuf,
    #[serde(default)]
    pub variant_args: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PiDescriptor {
    pub executable: PathBuf,
    #[serde(default)]
    pub provider_extensions: Vec<PathBuf>,
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
        if let Some(opencode) = &self.opencode {
            validate_executable(&opencode.executable)?;
            if opencode.variant_args.len() > MAX_DESCRIPTOR_ITEMS
                || opencode
                    .variant_args
                    .iter()
                    .any(|arg| arg.is_empty() || arg.len() > MAX_DESCRIPTOR_ITEM_BYTES)
            {
                return Err("opencode descriptor arguments are out of bounds");
            }
        }
        if let Some(pi) = &self.pi {
            validate_executable(&pi.executable)?;
            if pi.provider_extensions.len() > MAX_DESCRIPTOR_ITEMS {
                return Err("pi descriptor extension list is out of bounds");
            }
            for extension in &pi.provider_extensions {
                validate_executable(extension)?;
            }
        }
        Ok(())
    }
}

fn validate_executable(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute() || path.as_os_str().is_empty() {
        return Err("descriptor paths must be absolute");
    }
    if path.as_os_str().len() > MAX_DESCRIPTOR_ITEM_BYTES {
        return Err("descriptor path is out of bounds");
    }
    Ok(())
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
    let opencode: Arc<dyn LlmExecutionBackend> = match &envelope.opencode {
        Some(descriptor) => Arc::new(OpenCodeBackend::new(
            OpenCodeRuntime {
                executable: descriptor.executable.clone(),
                variant_args: descriptor.variant_args.clone(),
            },
            env.clone(),
        )),
        None => Arc::new(UnavailableBackend {
            subreason: "descriptor_absent",
        }),
    };
    let pi: Arc<dyn LlmExecutionBackend> = match &envelope.pi {
        Some(descriptor) => Arc::new(PiBackend::new(
            PiRuntimeDescriptor {
                executable: descriptor.executable.clone(),
                provider_extensions: descriptor.provider_extensions.clone(),
            },
            env.clone(),
        )),
        None => Arc::new(UnavailableBackend {
            subreason: "descriptor_absent",
        }),
    };
    HarnessDispatchBackend::new(opencode, pi)
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
    store
        .validate(&envelope.payload_manifest_digest)
        .map_err(|_| "staged generation failed revalidation")?;

    let publication = mc_host::runtime_dir_path(Some(&root))
        .map_err(|_| "runtime directory resolution failed")?
        .join(mc_host::CONNECTION_FILE_NAME);
    let init = storage_init(&root)?;

    let env = EnvSnapshot::capture().map_err(|_| "environment snapshot exceeds bounds")?;
    let composite = StaticComposite::new(
        mc_module::McHandler::new_with_connection_file(Some(publication)),
        // ponytail: the certified Linux CPU Synapse lane needs U9-qualified
        // model/ORT bytes staged in the generation; until
        // `production_qualified` flips, the lane is explicitly disabled and
        // reports the closed unavailable reason instead of loading ORT.
        SynapseComponent::new(None),
        BrocaComponent::new(Arc::new(harness_backend(&envelope, &env))),
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
        // Installed before the host future starts. Creating the stream inside
        // the spawned task races `mc_host::run`: a SIGTERM arriving before
        // registration takes the default disposition and kills the daemon
        // outright, so the runtime never observes the cancellation and the
        // fenced teardown in `mc_host::run` never runs. An installation failure
        // is also fatal to the shutdown path, so it fails startup here rather
        // than panicking a detached task and leaving `run` serving with no
        // SIGTERM handling and nothing reporting it.
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|_| "SIGTERM handler installation failed")?;
        let signal_task = tokio::spawn(async move {
            if signal.recv().await.is_some() {
                signal_shutdown.cancel();
            }
        });
        let result = mc_host::run(composite, config, shutdown.clone()).await;
        signal_task.abort();
        let _ = signal_task.await;
        result.map_err(|_| "host runtime exited with an error")
    })
}
