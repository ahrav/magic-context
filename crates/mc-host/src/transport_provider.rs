//! Private transport-provider registry and grant records (plan U4).
//!
//! Production construction contains TCP only: the default registry holds no
//! injected providers, so a production host can never grant a non-TCP
//! channel (R6). Injected providers exist for tests and must satisfy KTD9 —
//! owner-only endpoint access, exclusive peer attachment, provider-
//! incarnation fencing, and stale-descriptor rejection — before yielding a
//! candidate; any failure is a bounded [`ProviderFailure`] that fails the
//! setup closed (KTD6, R12).
//!
//! Everything here is `#[doc(hidden)]`: the module is a crate-internal seam
//! reachable only so the integration-test harness can inject fake providers
//! through `HostConfig` the same way it injects every other test knob.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::frame_channel::{BoxedReceiver, FrameSender};
use crate::transport_negotiation::ActivationToken;
use crate::wire::ByteBudget;

/// The host's TCP capability version: the only version the bootstrap
/// transport speaks, and the version every TCP selection names.
pub const TCP_CAPABILITY_VERSION: u32 = 1;

/// Bounded provider-failure taxonomy (KTD9 gate outcomes plus general
/// unavailability). Carries no provider payloads, descriptors, or endpoints,
/// so it is safe on every diagnostic surface (R14).
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

/// Host resources a provider may draw on while constructing a candidate
/// channel. Fields are crate-internal; injected providers pass the context
/// through to [`memory_candidate`] unchanged.
pub struct ProviderContext {
    pub(crate) ingress: ByteBudget,
    pub(crate) queue_frames: usize,
    pub(crate) frame_deadline: Duration,
}

/// One prepared, setup-only, non-routable candidate channel (host side).
/// Opaque outside the crate: tests obtain one from [`memory_candidate`].
pub struct Candidate {
    pub(crate) sender: FrameSender,
    pub(crate) receiver: BoxedReceiver,
    pub(crate) io: Pin<Box<dyn Future<Output = ()> + Send>>,
    /// Candidate generation root: cancelling retires the candidate.
    pub(crate) root: CancellationToken,
    pub(crate) read_cancel: CancellationToken,
}

/// What a provider yields once the KTD9 gate passed: a bounded opaque
/// descriptor for the client, a binding identity, and the candidate channel.
pub struct PreparedCandidate {
    pub descriptor: serde_json::Value,
    pub candidate_id: u64,
    pub candidate: Candidate,
}

impl fmt::Debug for PreparedCandidate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The descriptor is provider data and never reaches formatting (R14).
        f.debug_struct("PreparedCandidate")
            .field("descriptor", &"<opaque>")
            .field("candidate_id", &self.candidate_id)
            .finish_non_exhaustive()
    }
}

/// A test-injected transport provider. Implementations must run KTD9's
/// attachment gate inside `prepare` and fail with a bounded
/// [`ProviderFailure`] before yielding a candidate.
pub trait InjectedProvider: Send + Sync + 'static {
    fn transport(&self) -> &str;
    fn capability_version(&self) -> u32;
    fn prepare(&self, ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure>;
}

/// The host's provider registry. `Default` (production) is empty: TCP is the
/// implicit bootstrap transport and the only production channel.
#[derive(Clone, Default)]
pub struct TransportProviders {
    injected: Vec<Arc<dyn InjectedProvider>>,
}

impl TransportProviders {
    /// Test seam: a registry with injected providers beside implicit TCP.
    pub fn with_injected(injected: Vec<Arc<dyn InjectedProvider>>) -> Self {
        Self { injected }
    }

    /// Provider identity is `(transport, capability_version)`: the same
    /// transport may be installed at several capability versions, so a
    /// name-only match could return a mismatched sibling and hide a
    /// serveable provider.
    pub(crate) fn find(
        &self,
        transport: &str,
        capability_version: u32,
    ) -> Option<&Arc<dyn InjectedProvider>> {
        self.injected.iter().find(|provider| {
            provider.transport() == transport && provider.capability_version() == capability_version
        })
    }

    /// True when some provider serves `transport` at any capability version.
    /// Separates "unknown transport" from "known transport, wrong version"
    /// so the fallback reason names the real cause (§7.7.3).
    pub(crate) fn serves_transport(&self, transport: &str) -> bool {
        self.injected
            .iter()
            .any(|provider| provider.transport() == transport)
    }
}

impl fmt::Debug for TransportProviders {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.injected.iter().map(|p| p.transport()).collect();
        f.debug_struct("TransportProviders")
            .field("injected", &names)
            .finish()
    }
}

/// Builds a candidate channel over an in-memory duplex stream carrying the
/// ordinary v2 frame encoding, returning the peer half for the test to
/// drive. This is the only way tests can construct a [`Candidate`].
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
    pub(crate) fn new(ingress: ByteBudget, queue_frames: usize, frame_deadline: Duration) -> Self {
        Self {
            ingress,
            queue_frames,
            frame_deadline,
        }
    }
}

/// Everything a grant is bound to (KTD4): the token authorizes nothing by
/// itself — activation must present it on the exact candidate this record
/// names, inside the same daemon, bootstrap generation, and negotiation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantBinding {
    pub daemon_id: [u8; 16],
    pub bootstrap_generation: u64,
    pub negotiation_correlation: u64,
    pub transport: String,
    pub capability_version: u32,
    pub candidate_id: u64,
}

/// Why an activation did not consume the grant. Bounded; no token material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantRejection {
    TokenMismatch,
    BindingMismatch,
    AlreadyConsumed,
}

/// One-use grant record (KTD4). The token is compared in constant time and
/// the record is consumed atomically by exactly one matching activation.
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

    /// Validates and consumes the grant. The token comparison runs in
    /// constant time over the fixed 32-byte form; a mismatched token or
    /// binding never consumes the record, and a matching activation consumes
    /// it exactly once even under concurrent duplicates.
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

/// Mints a fresh 128-bit activation token from the OS CSPRNG as 32 lowercase
/// hexadecimal characters (protocol §7.7.2).
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
        // Neither rejection consumed the record.
        assert_eq!(record.consume(&good, &binding()), Ok(()));
        assert_eq!(
            record.consume(&good, &binding()),
            Err(GrantRejection::AlreadyConsumed)
        );
    }
}
