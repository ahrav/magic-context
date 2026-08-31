//!
//!

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::frame_channel::{BoxedReceiver, FrameSender};
use crate::transport_negotiation::ActivationToken;
use crate::wire::ByteBudget;

pub const TCP_CAPABILITY_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFailure {
    /// The endpoint could not be restricted to owner-only access.
    OwnerAccessDenied,
    /// Another peer is already attached to the candidate endpoint.
    ExclusiveAttachmentViolated,
    /// The provider incarnation behind the descriptor is stale.
    StaleIncarnation,
    /// The descriptor no longer names a live provider resource.
    StaleDescriptor,
    /// The provider cannot currently create a candidate.
    Unavailable,
}

/// ProviderContext supplies candidate-construction resources and the selected offer's advertised parameters.
pub struct ProviderContext {
    pub(crate) ingress: ByteBudget,
    pub(crate) queue_frames: usize,
    pub(crate) frame_deadline: Duration,
    pub(crate) offer_parameters: Option<serde_json::Value>,
}

impl ProviderContext {
    pub fn offer_parameters(&self) -> Option<&serde_json::Value> {
        self.offer_parameters.as_ref()
    }
}

pub struct Candidate {
    pub(crate) sender: FrameSender,
    pub(crate) receiver: BoxedReceiver,
    pub(crate) io: Pin<Box<dyn Future<Output = ()> + Send>>,
    pub(crate) root: CancellationToken,
    pub(crate) read_cancel: CancellationToken,
}

pub struct PreparedCandidate {
    pub descriptor: serde_json::Value,
    pub candidate_id: u64,
    pub candidate: Candidate,
}

impl fmt::Debug for PreparedCandidate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedCandidate")
            .field("descriptor", &"<opaque>")
            .field("candidate_id", &self.candidate_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightEligibility {
    Serveable,
    /// StaticallyOmitted denotes permanent absence or static ineligibility.
    StaticallyOmitted,
    /// DynamicallyUnavailable denotes transient readiness or admission pressure.
    DynamicallyUnavailable,
}

pub trait InjectedProvider: Send + Sync + 'static {
    fn transport(&self) -> &str;
    fn capability_version(&self) -> u32;

    /// Implementations must not create resources, run cleanup, or touch workers in `preflight`.
    /// Readiness changes govern new offers only, never existing candidates.
    fn preflight(&self, _parameters: Option<&serde_json::Value>) -> PreflightEligibility {
        PreflightEligibility::Serveable
    }

    fn prepare(&self, ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure>;
}

#[derive(Clone)]
struct ProviderEntry {
    transport: Box<str>,
    capability_version: u32,
    provider: Arc<dyn InjectedProvider>,
}

/// PrepareJob sends one provider preparation to the registry worker.
type PrepareJob = (
    Arc<dyn InjectedProvider>,
    ProviderContext,
    tokio::sync::oneshot::Sender<Result<PreparedCandidate, ProviderFailure>>,
);

/// Limits queued preparations so a hung `prepare` cannot cause unbounded reconnect memory growth.
const PREPARE_QUEUE_BOUND: usize = 8;

/// `prepare` runs on one dedicated OS thread; blocked calls queue later attempts without consuming Tokio or blocking-pool workers.
#[derive(Default)]
struct PrepareWorker {
    sender: Mutex<Option<std::sync::mpsc::SyncSender<PrepareJob>>>,
}

/// `Default` creates an empty production registry; TCP is the implicit bootstrap transport and the only production channel.
#[derive(Clone, Default)]
pub struct TransportProviders {
    injected: Vec<ProviderEntry>,
    worker: Arc<PrepareWorker>,
}

impl TransportProviders {
    /// The registry retains built-in TCP when tests inject providers.
    /// Provider metadata is snapshotted during registration, so slow metadata getters cannot stall read-loop negotiation before the setup deadline exists.
    ///
    /// # Panics
    ///
    /// A transport name outside the wire grammar, the reserved `tcp` name, or a duplicate `(transport, capability_version)` identity panics with a bounded message.
    /// Panic messages exclude provider-authored values.
    /// Validation failure prevents `TransportProviders` construction.
    pub fn with_injected(injected: Vec<Arc<dyn InjectedProvider>>) -> Self {
        // The registration path installs the panic redaction hook before invoking provider metadata getters.
        // A panicking metadata getter aborts registration.
        crate::panic_boundary::install();
        let entries: Vec<ProviderEntry> = injected
            .into_iter()
            .map(|provider| ProviderEntry {
                transport: crate::panic_boundary::redact_sync(|| provider.transport().into()),
                capability_version: crate::panic_boundary::redact_sync(|| {
                    provider.capability_version()
                }),
                provider,
            })
            .collect();
        for (index, entry) in entries.iter().enumerate() {
            assert!(
                crate::transport_negotiation::valid_transport_name(&entry.transport),
                "injected provider {index} has a transport name outside the wire grammar"
            );
            assert!(
                &*entry.transport != crate::transport_negotiation::TRANSPORT_TCP,
                "injected provider {index} uses the reserved tcp transport name"
            );
            assert!(
                !entries[..index].iter().any(|prior| {
                    prior.transport == entry.transport
                        && prior.capability_version == entry.capability_version
                }),
                "injected provider {index} duplicates an earlier (transport, capability_version)"
            );
        }
        Self {
            injected: entries,
            worker: Arc::new(PrepareWorker::default()),
        }
    }

    /// Dropping or timing out the receiver does not cancel the queued job.
    /// The dedicated worker can remain blocked in a job after the caller stops waiting.
    /// The caller's deadline governs how long it waits.
    pub(crate) fn prepare_on_worker(
        &self,
        provider: Arc<dyn InjectedProvider>,
        ctx: ProviderContext,
    ) -> tokio::sync::oneshot::Receiver<Result<PreparedCandidate, ProviderFailure>> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let mut sender = self.worker.sender.lock().expect("prepare worker lock");
        if sender.is_none() {
            let (job_tx, job_rx) = std::sync::mpsc::sync_channel::<PrepareJob>(PREPARE_QUEUE_BOUND);
            let spawned = std::thread::Builder::new()
                .name("mc-host-provider-prepare".to_owned())
                .spawn(move || {
                    while let Ok((provider, ctx, reply)) = job_rx.recv() {
                        // A panic while preparing one job does not terminate the worker.
                        let outcome =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                crate::panic_boundary::redact_sync(|| provider.prepare(&ctx))
                            }))
                            .unwrap_or(Err(ProviderFailure::Unavailable));
                        let _ = reply.send(outcome);
                    }
                });
            if spawned.is_ok() {
                *sender = Some(job_tx);
            }
            // A spawn failure closes the reply channel.
        }
        if let Some(job_tx) = sender.as_ref() {
            // A wedged worker cannot accumulate jobs beyond `PREPARE_QUEUE_BOUND`.
            // Dropping a rejected job's reply sender fails its setup immediately.
            let _ = job_tx.try_send((provider, ctx, reply_tx));
        }
        reply_rx
    }

    /// Providers are identified by `(transport, capability_version)`, not transport alone.
    /// A transport can have providers at multiple capability versions.
    /// A name-only lookup can select a provider at the wrong capability version.
    /// serveable provider.
    pub(crate) fn find(
        &self,
        transport: &str,
        capability_version: u32,
    ) -> Option<&Arc<dyn InjectedProvider>> {
        self.injected
            .iter()
            .find(|entry| {
                &*entry.transport == transport && entry.capability_version == capability_version
            })
            .map(|entry| &entry.provider)
    }

    /// A name-only lookup can report `true` for an unsupported capability version.
    /// Together, `find` and `serves_transport` distinguish an unknown transport from a known transport lacking the requested capability version.
    pub(crate) fn serves_transport(&self, transport: &str) -> bool {
        self.injected
            .iter()
            .any(|entry| &*entry.transport == transport)
    }
}

impl fmt::Debug for TransportProviders {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.injected.iter().map(|e| &*e.transport).collect();
        f.debug_struct("TransportProviders")
            .field("injected", &names)
            .finish()
    }
}

pub fn memory_candidate(
    ctx: &ProviderContext,
    buffer_bytes: usize,
) -> (Candidate, tokio::io::DuplexStream) {
    let (host, peer) = tokio::io::duplex(buffer_bytes);
    let (read, write) = tokio::io::split(host);
    let root = CancellationToken::new();
    let read_cancel = root.child_token();
    let (sender, channel, io) = crate::tcp_frame_channel::TcpFrameChannel::start(
        read,
        write,
        ctx.queue_frames,
        ctx.frame_deadline,
        ctx.ingress.clone(),
        root.clone(),
        read_cancel.clone(),
    );
    (
        Candidate {
            sender,
            receiver: BoxedReceiver::new(channel),
            io: Box::pin(io),
            root,
            read_cancel,
        },
        peer,
    )
}

impl ProviderContext {
    pub(crate) fn new(
        ingress: ByteBudget,
        queue_frames: usize,
        frame_deadline: Duration,
        offer_parameters: Option<serde_json::Value>,
    ) -> Self {
        Self {
            ingress,
            queue_frames,
            frame_deadline,
            offer_parameters,
        }
    }
}

/// A grant authorizes only an activation whose `GrantBinding` exactly matches the record.
/// An activation must present both the record's token and its exact `GrantBinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantBinding {
    pub daemon_id: [u8; 16],
    pub bootstrap_generation: u64,
    pub negotiation_correlation: u64,
    pub transport: String,
    pub capability_version: u32,
    pub candidate_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantRejection {
    TokenMismatch,
    BindingMismatch,
    AlreadyConsumed,
}

/// Exactly one matching activation atomically consumes the record.
pub struct GrantRecord {
    binding: GrantBinding,
    token: ActivationToken,
    consumed: AtomicBool,
}

impl GrantRecord {
    pub fn new(binding: GrantBinding, token: ActivationToken) -> Self {
        Self {
            binding,
            token,
            consumed: AtomicBool::new(false),
        }
    }

    /// Exactly one matching activation consumes the record despite concurrent duplicates.
    pub fn consume(
        &self,
        presented: &ActivationToken,
        binding: &GrantBinding,
    ) -> Result<(), GrantRejection> {
        if self.token != *presented {
            return Err(GrantRejection::TokenMismatch);
        }
        if self.binding != *binding {
            return Err(GrantRejection::BindingMismatch);
        }
        if self.consumed.swap(true, Ordering::SeqCst) {
            return Err(GrantRejection::AlreadyConsumed);
        }
        Ok(())
    }
}

impl fmt::Debug for GrantRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GrantRecord")
            .field("binding", &self.binding)
            .field("token", &"<redacted>")
            .field("consumed", &self.consumed.load(Ordering::SeqCst))
            .finish()
    }
}

pub(crate) fn fresh_activation_token() -> ActivationToken {
    use std::fmt::Write;
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).expect("OS CSPRNG is available");
    let mut hex = String::with_capacity(raw.len() * 2);
    for byte in raw {
        write!(hex, "{byte:02x}").expect("hex formatting cannot fail");
    }
    ActivationToken::parse(&hex).expect("freshly minted token has the exact wire form")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(s: &str) -> ActivationToken {
        ActivationToken::parse(s).expect("test token")
    }

    fn binding() -> GrantBinding {
        GrantBinding {
            daemon_id: [7; 16],
            bootstrap_generation: 3,
            negotiation_correlation: 1,
            transport: "fake".to_owned(),
            capability_version: 1,
            candidate_id: 1,
        }
    }

    #[test]
    fn fresh_tokens_have_the_wire_form_and_vary() {
        let a = fresh_activation_token();
        let b = fresh_activation_token();
        assert_eq!(a.as_str().len(), 32);
        assert_ne!(a.as_str(), b.as_str(), "CSPRNG tokens must not repeat");
    }

    #[test]
    fn grant_record_debug_redacts_the_token() {
        let record = GrantRecord::new(binding(), token("00112233445566778899aabbccddeeff"));
        let rendered = format!("{record:?}");
        assert!(!rendered.contains("00112233445566778899aabbccddeeff"));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn wrong_token_or_binding_never_consumes() {
        let good = token("00112233445566778899aabbccddeeff");
        let record = GrantRecord::new(binding(), good.clone());
        assert_eq!(
            record.consume(&token("ffeeddccbbaa99887766554433221100"), &binding()),
            Err(GrantRejection::TokenMismatch)
        );
        let mut wrong = binding();
        wrong.candidate_id = 99;
        assert_eq!(
            record.consume(&good, &wrong),
            Err(GrantRejection::BindingMismatch)
        );
        // `TokenMismatch` and `BindingMismatch` leave the record unconsumed.
        assert_eq!(record.consume(&good, &binding()), Ok(()));
        assert_eq!(
            record.consume(&good, &binding()),
            Err(GrantRejection::AlreadyConsumed)
        );
    }
}
