//! Explicit shared-memory transport provider for qualified test profiles.
//!
//! Production configuration never installs this provider. One dedicated OS
//! thread creates and owns both `!Send` ring endpoints. Host tasks exchange
//! frame tickets and completion notifications with that thread.

use std::fmt;
#[cfg(target_os = "linux")]
use std::fs::OpenOptions;
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as StdInstant};

use crate::wire::{decode_header, EnvelopeHeader, FrameType};
#[cfg(target_os = "linux")]
use mc_shm_transport::backend::ring::RingGrant;
use mc_shm_transport::backend::ring::{DuplexRing, ProducerReservation, Ring};
use mc_shm_transport::descriptor::{
    BackendId, HardwareProfileId, MemoryLayout, OwnershipMode, PlatformKind, RuntimeKind,
    SchedulingMode, TransportDescriptor, WorkloadClass,
};
use mc_shm_transport::profile::{
    Admission, AdmissionController, CompletionMode, HostLimits as ShmHostLimits, ProducerTopology,
    ProfileConfig, ResourceCharges, TargetProfile, WorkerTopology,
};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::frame_channel::{
    frame_sender, validate_inbound_header, BoxedReceiver, CopyCounter, DirectFrame, FrameReceiver,
    InboundEvent, InboundFrame, OutboundFrame, ReadClose, RejectedFrame, SenderQueue, COMPLETE,
};
use crate::provider_recovery::{
    CleanupOutcome, ProviderReadiness, ProviderRecovery, RecoveryBackend, SystemClock,
};
use crate::transport_provider::{
    Candidate, InjectedProvider, PreflightEligibility, PreparedCandidate, ProviderContext,
    ProviderFailure,
};
use crate::wire::{ByteBudget, MAX_CONTROL_BODY_LEN};

/// Explicit transport name used by the qualified provider.
pub const SHM_TRANSPORT: &str = "shm";
/// Capability version implemented by the qualified provider.
pub const SHM_CAPABILITY_VERSION: u32 = 1;
/// Only profile accepted by this pre-production provider.
pub const QUALIFIED_TEST_PROFILE: &str = "mc-host-test-ring-v1";

const HARDWARE_PROFILE: &str = "mc-host-test-ring-v1";
const DESCRIPTOR_DEPTH: usize = 8;
const POLL_INTERVAL: Duration = Duration::from_micros(50);

static NEXT_CANDIDATE_ID: AtomicU64 = AtomicU64::new(1);

/// Test-only observer invoked after each successful frame publication with
/// the published frame's type and channel. It receives no descriptors,
/// payloads, or provider data.
#[doc(hidden)]
pub type PublishHook = Arc<dyn Fn(FrameType, u16) + Send + Sync>;

/// Exact offer parameters required to select the test-only provider.
pub fn qualified_test_parameters() -> serde_json::Value {
    serde_json::json!({
        "backend": "ring",
        "profile": QUALIFIED_TEST_PROFILE,
        "scheduling": "cold_park_wake",
        "topology": "fused"
    })
}

pub fn qualified_test_profile() -> TargetProfile {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            BackendId::Ring,
            MemoryLayout::TwoSpanWrap,
            OwnershipMode::DirectLeased,
            SchedulingMode::ColdParkWake,
            WorkloadClass::MixedDuplex,
            if cfg!(target_os = "macos") {
                PlatformKind::Macos
            } else {
                PlatformKind::Linux
            },
            RuntimeKind::Rust,
            HardwareProfileId::new(HARDWARE_PROFILE).expect("static hardware profile is valid"),
        ),
        descriptor_depth: DESCRIPTOR_DEPTH,
        arena_bytes: mc_shm_transport::MIN_ARENA_BYTES,
        max_spans: 2,
        max_leases: DESCRIPTOR_DEPTH,
        mappings: 2,
        pinned_workers: 0,
        producer_topology: ProducerTopology::Arbitrated,
        worker_topology: WorkerTopology::Fused,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .expect("static shared-memory profile is valid")
}

/// Admission limits sufficient for one qualified candidate.
pub fn single_candidate_limits() -> ShmHostLimits {
    let charges = qualified_test_profile().charges();
    ShmHostLimits {
        descriptors: charges.descriptors,
        arena_bytes: charges.arena_bytes,
        leases: charges.leases,
        mappings: charges.mappings,
        pinned_workers: charges.pinned_workers,
    }
}

/// Explicit provider. Callers must install it through `TransportProviders`.
pub struct ShmProvider {
    profile: Arc<TargetProfile>,
    admission: Arc<AdmissionController>,
    preparations: AtomicU64,
    quarantine_next_close: Arc<AtomicBool>,
    recovery: ProviderRecovery,
    recovery_cleanups: Arc<AtomicU64>,
    publish_hook: Mutex<Option<PublishHook>>,
    held_admission: Mutex<Option<Admission>>,
}

/// Recovery primitives for the thread-confined ring endpoint. The rings die
/// with their endpoint thread, so a suspect close leaves alias state
/// uncertain: cleanup isolates instead of reclaiming. commentlint: allow(JUDGE)
struct ShmRecoveryBackend {
    profile: Arc<TargetProfile>,
    admission: Arc<AdmissionController>,
    cleanups: Arc<AtomicU64>,
}

impl RecoveryBackend for ShmRecoveryBackend {
    fn cleanup(&self, _candidate_id: u64) -> CleanupOutcome {
        self.cleanups.fetch_add(1, Ordering::AcqRel);
        CleanupOutcome::Uncertain
    }

    fn probe(&self) -> bool {
        // No shared state outlives the endpoint thread, so isolation alone
        // proves the provider side is clean.
        true
    }

    fn admission_fits(&self) -> bool {
        self.admission.can_admit(&self.profile, None).is_ok()
    }
}

impl ShmProvider {
    /// Builds provider with explicit process-wide admission limits.
    pub fn for_qualified_test_profile(limits: ShmHostLimits) -> Self {
        let profile = Arc::new(qualified_test_profile());
        let admission = Arc::new(AdmissionController::new(limits));
        let recovery_cleanups = Arc::new(AtomicU64::new(0));
        let backend = Arc::new(ShmRecoveryBackend {
            profile: Arc::clone(&profile),
            admission: Arc::clone(&admission),
            cleanups: Arc::clone(&recovery_cleanups),
        });
        let recovery = ProviderRecovery::new(backend, Arc::new(SystemClock::new()));
        Self {
            profile,
            admission,
            preparations: AtomicU64::new(0),
            quarantine_next_close: Arc::new(AtomicBool::new(false)),
            recovery,
            recovery_cleanups,
            publish_hook: Mutex::new(None),
            held_admission: Mutex::new(None),
        }
    }

    /// Aggregate profile charge used by admission tests.
    pub fn profile_charges(&self) -> ResourceCharges {
        self.profile.charges()
    }

    /// Number of preparations that passed side-effect-free preflight.
    pub fn preparation_count(&self) -> u64 {
        self.preparations.load(Ordering::Acquire)
    }

    /// Returns redacted aggregate admission accounting.
    pub fn accounting(
        &self,
    ) -> Result<
        mc_shm_transport::profile::AccountingSnapshot,
        mc_shm_transport::profile::AdmissionError,
    > {
        self.admission.snapshot()
    }

    /// Test hook: next endpoint close retains non-worker commitments.
    pub fn quarantine_next_close(&self) {
        self.quarantine_next_close.store(true, Ordering::Release);
    }

    /// Test hook: install a publication observer for candidates prepared
    /// after this call. The hook runs on the endpoint thread after the ring
    /// commit. commentlint: allow(JUDGE)
    #[doc(hidden)]
    pub fn set_publish_hook(&self, hook: PublishHook) {
        *self.publish_hook.lock().expect("publish hook lock") = Some(hook);
    }

    /// Test hook: hold one profile's admission charges so preflight reports
    /// exact dynamic unavailability. commentlint: allow(JUDGE)
    #[doc(hidden)]
    pub fn hold_admission(&self) -> bool {
        let mut held = self.held_admission.lock().expect("held admission lock");
        if held.is_some() {
            return false;
        }
        match self.admission.admit(&self.profile, None) {
            Ok(admission) => {
                *held = Some(admission);
                true
            }
            Err(_) => false,
        }
    }

    /// Test hook: end the admission hold. commentlint: allow(JUDGE)
    #[doc(hidden)]
    pub fn release_admission(&self) {
        if let Some(admission) = self
            .held_admission
            .lock()
            .expect("held admission lock")
            .take()
        {
            admission.release();
        }
    }

    /// Provider offer readiness (R6): governs new offers only.
    pub fn readiness(&self) -> ProviderReadiness {
        self.recovery.readiness()
    }

    /// Number of recovery cleanup calls the controller dispatched. Preflight
    /// must never move this counter (R6, seeded-defect detector).
    pub fn recovery_cleanup_count(&self) -> u64 {
        self.recovery_cleanups.load(Ordering::Acquire)
    }

    fn offer_is_exact(parameters: Option<&serde_json::Value>) -> bool {
        parameters == Some(&qualified_test_parameters())
    }
}

impl fmt::Debug for ShmProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShmProvider")
            .field("profile", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl InjectedProvider for ShmProvider {
    fn transport(&self) -> &str {
        SHM_TRANSPORT
    }

    fn capability_version(&self) -> u32 {
        SHM_CAPABILITY_VERSION
    }

    fn preflight(&self, parameters: Option<&serde_json::Value>) -> PreflightEligibility {
        if !cfg!(target_os = "linux") || !Self::offer_is_exact(parameters) {
            return PreflightEligibility::StaticallyOmitted;
        }
        if self.recovery.readiness() != ProviderReadiness::Ready
            || self.admission.can_admit(&self.profile, None).is_err()
        {
            return PreflightEligibility::DynamicallyUnavailable;
        }
        PreflightEligibility::Serveable
    }

    fn prepare(&self, ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure> {
        if !cfg!(target_os = "linux") || !Self::offer_is_exact(ctx.offer_parameters()) {
            return Err(ProviderFailure::Unavailable);
        }
        let candidate_id = NEXT_CANDIDATE_ID.fetch_add(1, Ordering::Relaxed);
        // Readiness and admission are one atomic decision under the
        // recovery lock: a suspect reported between a separate readiness
        // check and the admission would otherwise let this preparation
        // admit resources, create rings, and publish a grant into a
        // recovery episode (KTD6: `Recovering` is unoffered). Custody of
        // the exact admission charges moves into one lifecycle record
        // before the candidate is exposed (KTD4).
        let custody = self
            .recovery
            .admit_candidate_while_ready(candidate_id, &self.admission, &self.profile)
            .ok_or(ProviderFailure::Unavailable)?;
        self.preparations.fetch_add(1, Ordering::AcqRel);
        let recovery = self.recovery.clone();
        let root = CancellationToken::new();
        let read_cancel = root.child_token();
        let (sender, queue) = frame_sender(ctx.queue_frames, root.clone(), ctx.frame_deadline);
        let (inbound_tx, inbound_rx) = mpsc::channel(ctx.queue_frames);
        let (initialized_tx, initialized_rx) = std::sync::mpsc::sync_channel(1);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let profile = Arc::clone(&self.profile);
        let ingress = ctx.ingress.clone();
        let frame_deadline = ctx.frame_deadline;
        let worker_root = root.clone();
        let worker_read_cancel = read_cancel.clone();
        let quarantine_next_close = Arc::clone(&self.quarantine_next_close);
        let publish_hook = self.publish_hook.lock().expect("publish hook lock").clone();

        let spawned = std::thread::Builder::new()
            .name("mc-host-shm-endpoint".to_owned())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build();
                let rings = runtime
                    .as_ref()
                    .map_err(|_| ProviderFailure::Unavailable)
                    .and_then(|_| {
                        DuplexRing::create(&profile).map_err(|_| ProviderFailure::Unavailable)
                    });
                let (runtime, rings) = match (runtime, rings) {
                    (Ok(runtime), Ok(rings)) => (runtime, rings),
                    _ => {
                        let _ = initialized_tx.send(Err(ProviderFailure::Unavailable));
                        return;
                    }
                };
                let descriptor = worker_descriptor(candidate_id, &rings);
                let Ok(descriptor) = descriptor else {
                    let _ = initialized_tx.send(Err(ProviderFailure::Unavailable));
                    return;
                };
                if initialized_tx.send(Ok(descriptor)).is_err() {
                    return;
                }
                // An endpoint panic is an unclean close: catching it here
                // keeps this thread alive to take the quarantine branch
                // below instead of letting `Admission`'s drop return the
                // charges as clean capacity while ring mappings may still
                // exist.
                let clean = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runtime.block_on(run_endpoint(
                        rings,
                        queue,
                        inbound_tx,
                        ingress,
                        frame_deadline,
                        worker_root,
                        worker_read_cancel,
                        publish_hook,
                    ))
                }))
                .unwrap_or(false);
                if clean && !quarantine_next_close.swap(false, Ordering::AcqRel) {
                    let _ = custody.release();
                } else {
                    // Unclean close (or the forced test hook): the record
                    // becomes a suspect and the recovery controller decides
                    // between reclamation and isolation (KTD4).
                    recovery.report_suspect(custody);
                }
                let _ = done_tx.send(());
            });
        if spawned.is_err() {
            return Err(ProviderFailure::Unavailable);
        }
        let descriptor = initialized_rx
            .recv()
            .map_err(|_| ProviderFailure::Unavailable)??;
        let receiver = BoxedReceiver::new(ShmReceiver {
            inbound: inbound_rx,
        });
        let io = Box::pin(async move {
            let _ = done_rx.await;
        });
        Ok(PreparedCandidate {
            descriptor,
            candidate_id,
            candidate: Candidate {
                sender,
                receiver,
                io,
                root,
                read_cancel,
            },
        })
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct WireDescriptor {
    profile: String,
    pid: u32,
    host_to_peer_fd: i32,
    host_to_peer_grant: String,
    peer_to_host_fd: i32,
    peer_to_host_grant: String,
}

fn worker_descriptor(candidate_id: u64, rings: &DuplexRing) -> Result<serde_json::Value, ()> {
    #[cfg(target_os = "linux")]
    {
        let descriptor = WireDescriptor {
            profile: QUALIFIED_TEST_PROFILE.to_owned(),
            pid: std::process::id(),
            host_to_peer_fd: rings.first.raw_fd(),
            host_to_peer_grant: encode_hex(&rings.first.grant().encode()),
            peer_to_host_fd: rings.second.raw_fd(),
            peer_to_host_grant: encode_hex(&rings.second.grant().encode()),
        };
        let mut value = serde_json::to_value(descriptor).map_err(|_| ())?;
        value
            .as_object_mut()
            .ok_or(())?
            .insert("candidate_id".to_owned(), candidate_id.into());
        Ok(value)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (candidate_id, rings);
        Err(())
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

struct ShmReceiver {
    inbound: mpsc::Receiver<Result<InboundEvent, ReadClose>>,
}

impl FrameReceiver for ShmReceiver {
    async fn recv(&mut self) -> Result<InboundEvent, ReadClose> {
        self.inbound
            .recv()
            .await
            .unwrap_or(Err(ReadClose::CleanEof))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_endpoint(
    rings: DuplexRing,
    mut queue: SenderQueue,
    inbound: mpsc::Sender<Result<InboundEvent, ReadClose>>,
    ingress: ByteBudget,
    frame_deadline: Duration,
    root: CancellationToken,
    read_cancel: CancellationToken,
    publish_hook: Option<PublishHook>,
) -> bool {
    let discard = queue.discard.clone();
    let finish = queue.finish.clone();
    let mut finishing = false;
    loop {
        let mut received = false;
        if !read_cancel.is_cancelled() {
            match receive_one(
                &rings,
                &mut queue,
                &inbound,
                &ingress,
                frame_deadline,
                &read_cancel,
                publish_hook.as_ref(),
            )
            .await
            {
                Ok(true) => received = true,
                Ok(false) => {}
                Err(close) => {
                    // Cancellation and budget-timeout closes are ordinary
                    // backpressure or retirement — the read side was told to
                    // stop (or the inbound consumer is gone, or ingress is
                    // saturated) and the local lease releases safely on drop
                    // — so they must not quarantine the admission charges:
                    // with single-candidate limits that would permanently
                    // block every later shared-memory candidate. Only
                    // structural faults are unclean.
                    let clean = matches!(close, ReadClose::Cancelled | ReadClose::Overloaded);
                    let _ = inbound.send(Err(close)).await;
                    queue.retired.cancel();
                    root.cancel();
                    return clean;
                }
            }
        }

        let queued = if received {
            // Directions alternate under sustained inbound traffic: each
            // received frame is followed by at most one queued outbound
            // frame, taken without waiting, so a peer that refills the
            // inbound ring as slots release cannot starve responses, Pings,
            // and close frames while host-to-peer capacity is free.
            queue.try_recv().ok()
        } else if finishing {
            match queue.try_recv() {
                Ok(frame) => Some(frame),
                Err(_) => return true,
            }
        } else {
            tokio::select! {
                biased;
                () = discard.cancelled() => return true,
                () = finish.cancelled() => {
                    finishing = true;
                    None
                }
                () = root.cancelled() => return true,
                frame = queue.recv() => match frame {
                    Some(frame) => Some(frame),
                    None => return true,
                },
                () = tokio::time::sleep(POLL_INTERVAL) => None,
            }
        };
        let Some(queued) = queued else {
            continue;
        };
        if publish_one(&rings.first, queued, frame_deadline, publish_hook.as_ref()).is_err() {
            queue.retired.cancel();
            root.cancel();
            return false;
        }
    }
}

async fn receive_one(
    rings: &DuplexRing,
    queue: &mut SenderQueue,
    inbound: &mpsc::Sender<Result<InboundEvent, ReadClose>>,
    ingress: &ByteBudget,
    frame_deadline: Duration,
    read_cancel: &CancellationToken,
    publish_hook: Option<&PublishHook>,
) -> Result<bool, ReadClose> {
    let Some(lease) = rings
        .second
        .try_receive()
        .map_err(|_| ReadClose::Corrupt("shared-memory receive failed"))?
    else {
        return Ok(false);
    };
    let header = decode_header(&lease.wire_header())
        .map_err(|_| ReadClose::Corrupt("invalid shared-memory header"))?;
    validate_inbound_header(header)?;
    if header.ty == FrameType::Request && header.channel == 0 && header.len > MAX_CONTROL_BODY_LEN {
        lease
            .release()
            .map_err(|_| ReadClose::Corrupt("shared-memory completion failed"))?;
        inbound
            .send(Ok(InboundEvent::Rejected(RejectedFrame {
                corr: header.corr,
            })))
            .await
            .map_err(|_| ReadClose::Cancelled)?;
        return Ok(true);
    }

    let deadline = StdInstant::now() + frame_deadline;
    let charge = loop {
        if let Some(charge) = ingress.try_charge(header.len as usize) {
            break charge;
        }
        if read_cancel.is_cancelled() {
            return Err(ReadClose::Cancelled);
        }
        if StdInstant::now() >= deadline {
            // The peer and transport are healthy; only the ingress budget is
            // saturated. Overloaded retires the generation without branding
            // it corrupt, so the admission charge releases cleanly.
            return Err(ReadClose::Overloaded);
        }
        // The budget wait services queued outbound frames: a slow ingress
        // drain holds only this receive, not the connection's sends, which
        // would otherwise miss their deadlines behind it.
        match queue.try_recv() {
            Ok(queued) => {
                if publish_one(&rings.first, queued, frame_deadline, publish_hook).is_err() {
                    return Err(ReadClose::Corrupt("shared-memory publish failed"));
                }
            }
            Err(_) => std::thread::sleep(POLL_INTERVAL),
        }
    };
    let body = lease
        .to_vec()
        .map_err(|_| ReadClose::Corrupt("shared-memory lease failed"))?;
    lease
        .release()
        .map_err(|_| ReadClose::Corrupt("shared-memory completion failed"))?;
    let copies = CopyCounter::default();
    copies.record_copy();
    inbound
        .send(Ok(InboundEvent::Frame(InboundFrame::owned(
            header, body, charge, copies,
        ))))
        .await
        .map_err(|_| ReadClose::Cancelled)?;
    Ok(true)
}

fn publish_one(
    ring: &Ring,
    mut queued: crate::frame_channel::QueuedOutboundFrame,
    frame_deadline: Duration,
    publish_hook: Option<&PublishHook>,
) -> Result<(), ()> {
    if !queued.begin_publication() {
        return Ok(());
    }
    let completion = Arc::clone(&queued.state);
    let OutboundFrame {
        bytes,
        tail,
        direct,
        charge,
        written,
    } = queued.frame;
    let wire_header: Option<[u8; crate::wire::HEADER_LEN]> = match &direct {
        Some(direct) => Some(direct.header()),
        None => bytes
            .get(..crate::wire::HEADER_LEN)
            .and_then(|header| header.try_into().ok()),
    };
    let deadline = StdInstant::now() + frame_deadline;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match direct {
        Some(direct) => publish_direct(ring, direct, deadline),
        None => publish_owned(ring, &bytes, &tail, deadline),
    }));
    if !matches!(result, Ok(Ok(()))) {
        return Err(());
    }
    completion.store(COMPLETE, Ordering::Release);
    if let Some(hook) = publish_hook {
        if let Some(header) = wire_header.and_then(|header| decode_header(&header).ok()) {
            hook(header.ty, header.channel);
        }
    }
    if let Some(written) = written {
        written(Instant::now());
    }
    drop(charge);
    Ok(())
}

fn publish_direct(ring: &Ring, direct: DirectFrame, deadline: StdInstant) -> Result<(), ()> {
    let header = direct.header();
    let body_len = direct.body_len();
    let mut reservation = ring
        .reserve_until(body_len, header, deadline)
        .map_err(|_| ())?;
    let result = crate::panic_boundary::redact_sync(|| {
        let mut writer = ReservationWriter(&mut reservation);
        direct.serialize(&mut writer)
    });
    result.map_err(|_| ())?;
    reservation.commit(body_len).map_err(|_| ())?;
    Ok(())
}

fn publish_owned(ring: &Ring, bytes: &[u8], tail: &[u8], deadline: StdInstant) -> Result<(), ()> {
    let (header, first_body) = bytes.split_at_checked(crate::wire::HEADER_LEN).ok_or(())?;
    let header: [u8; crate::wire::HEADER_LEN] = header.try_into().map_err(|_| ())?;
    let body_len = first_body.len().checked_add(tail.len()).ok_or(())?;
    let mut reservation = ring
        .reserve_until(body_len, header, deadline)
        .map_err(|_| ())?;
    reservation.write(first_body).map_err(|_| ())?;
    reservation.write(tail).map_err(|_| ())?;
    reservation.commit(body_len).map_err(|_| ())?;
    Ok(())
}

struct ReservationWriter<'reservation, 'ring>(&'reservation mut ProducerReservation<'ring>);

impl io::Write for ReservationWriter<'_, '_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::WriteZero,
                "shared-memory reservation exhausted",
            )
        })?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Thread-confined peer endpoint for integration tests.
pub struct TestShmPeer {
    /// Peer-to-host producer direction.
    pub to_host: Ring,
    /// Host-to-peer consumer direction.
    pub from_host: Ring,
}

impl TestShmPeer {
    /// Attaches descriptor received over authenticated bootstrap.
    #[cfg(target_os = "linux")]
    pub fn attach(descriptor: &serde_json::Value) -> Result<Self, TestPeerError> {
        let mut descriptor = descriptor.clone();
        descriptor
            .as_object_mut()
            .ok_or(TestPeerError)?
            .remove("candidate_id");
        let descriptor: WireDescriptor =
            serde_json::from_value(descriptor).map_err(|_| TestPeerError)?;
        if descriptor.profile != QUALIFIED_TEST_PROFILE {
            return Err(TestPeerError);
        }
        let from_host = attach_ring(
            descriptor.pid,
            descriptor.host_to_peer_fd,
            &descriptor.host_to_peer_grant,
        )?;
        let to_host = attach_ring(
            descriptor.pid,
            descriptor.peer_to_host_fd,
            &descriptor.peer_to_host_grant,
        )?;
        Ok(Self { to_host, from_host })
    }

    /// Publishes one complete consumer frame.
    pub fn send(&self, header: EnvelopeHeader, body: &[u8]) -> Result<(), TestPeerError> {
        let mut reservation = self
            .to_host
            .reserve_until(
                body.len(),
                header.encode(),
                StdInstant::now() + Duration::from_secs(2),
            )
            .map_err(|_| TestPeerError)?;
        reservation.write(body).map_err(|_| TestPeerError)?;
        reservation.commit(body.len()).map_err(|_| TestPeerError)?;
        Ok(())
    }

    /// Waits for one complete host frame and records its completion.
    pub fn recv(&self, timeout: Duration) -> Result<(EnvelopeHeader, Vec<u8>), TestPeerError> {
        let deadline = StdInstant::now() + timeout;
        loop {
            if let Some(lease) = self.from_host.try_receive().map_err(|_| TestPeerError)? {
                let header = decode_header(&lease.wire_header()).map_err(|_| TestPeerError)?;
                let body = lease.to_vec().map_err(|_| TestPeerError)?;
                lease.release().map_err(|_| TestPeerError)?;
                return Ok((header, body));
            }
            if StdInstant::now() >= deadline {
                return Err(TestPeerError);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

#[cfg(target_os = "linux")]
fn attach_ring(pid: u32, fd: i32, grant: &str) -> Result<Ring, TestPeerError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("/proc/{pid}/fd/{fd}"))
        .map_err(|_| TestPeerError)?;
    let grant = RingGrant::decode(decode_hex(grant)?).map_err(|_| TestPeerError)?;
    Ring::attach(OwnedFd::from(file), grant, SchedulingMode::ColdParkWake)
        .map_err(|_| TestPeerError)
}

fn decode_hex<const N: usize>(text: &str) -> Result<[u8; N], TestPeerError> {
    if text.len() != N * 2 {
        return Err(TestPeerError);
    }
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte =
            u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).map_err(|_| TestPeerError)?;
    }
    Ok(bytes)
}

/// Redacted test-peer attachment or I/O failure.
#[derive(Clone, Copy)]
pub struct TestPeerError;

impl fmt::Debug for TestPeerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TestPeerError(<redacted>)")
    }
}

impl fmt::Display for TestPeerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("shared-memory peer operation failed")
    }
}

impl std::error::Error for TestPeerError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{Flags, Priority, PROTOCOL_VERSION};

    #[test]
    fn platform_preflight_is_side_effect_free() {
        let provider = ShmProvider::for_qualified_test_profile(single_candidate_limits());
        let expected = if cfg!(target_os = "linux") {
            PreflightEligibility::Serveable
        } else {
            PreflightEligibility::StaticallyOmitted
        };
        assert_eq!(
            provider.preflight(Some(&qualified_test_parameters())),
            expected
        );
        assert_eq!(
            provider.preflight(Some(&serde_json::json!({}))),
            PreflightEligibility::StaticallyOmitted
        );
        assert_eq!(provider.readiness(), ProviderReadiness::Ready);
        assert_eq!(provider.preparation_count(), 0);
        assert_eq!(provider.recovery_cleanup_count(), 0);
        let accounting = provider.accounting().unwrap();
        assert_eq!(accounting.active, ResourceCharges::ZERO);
        assert_eq!(accounting.quarantined, ResourceCharges::ZERO);
    }

    #[test]
    fn qualified_test_profile_pins_client_grant_geometry() {
        let profile = qualified_test_profile();
        assert_eq!(profile.descriptor_depth(), 8);
        assert_eq!(profile.max_leases(), 8);
        assert_eq!(profile.arena_bytes(), mc_shm_transport::MIN_ARENA_BYTES);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn copied_control_frame_records_one_host_adapter_copy() {
        let rings = DuplexRing::create(&qualified_test_profile()).unwrap();
        let encoded = rings.first.grant().encode();
        assert_eq!(u64::from_le_bytes(encoded[22..30].try_into().unwrap()), 8);
        assert_eq!(u64::from_le_bytes(encoded[38..46].try_into().unwrap()), 8);
        assert_eq!(
            u64::from_le_bytes(encoded[46..54].try_into().unwrap()),
            (mc_shm_transport::MIN_ARENA_BYTES + 8_192) as u64
        );
        let body = b"copy";
        let header = EnvelopeHeader {
            len: body.len() as u32,
            ver: PROTOCOL_VERSION,
            ty: FrameType::Request,
            flags: Flags::new(false, Priority::Interactive, false),
            channel: 0,
            epoch: 0,
            corr: 1,
        };
        let mut reservation = rings
            .second
            .try_reserve(body.len(), header.encode())
            .unwrap();
        reservation.write(body).unwrap();
        reservation.commit(body.len()).unwrap();

        let (_sender, mut queue) =
            frame_sender(1, CancellationToken::new(), Duration::from_secs(1));
        let (inbound, mut received) = mpsc::channel(1);
        assert!(receive_one(
            &rings,
            &mut queue,
            &inbound,
            &ByteBudget::new(1024),
            Duration::from_secs(1),
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap());
        let InboundEvent::Frame(frame) = received.recv().await.unwrap().unwrap() else {
            panic!("expected copied frame");
        };
        assert_eq!(frame.copy_counter().copies(), 1);
    }
}
