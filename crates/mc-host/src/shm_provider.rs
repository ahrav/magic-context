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
use std::sync::Arc;
use std::time::{Duration, Instant as StdInstant};

#[cfg(target_os = "linux")]
use mc_shm_transport::backend::ring::RingGrant;
use mc_shm_transport::backend::ring::{DuplexRing, ProducerReservation, Ring};
use mc_shm_transport::descriptor::{
    BackendId, HardwareProfileId, MemoryLayout, OwnershipMode, PlatformKind, RuntimeKind,
    SchedulingMode, TransportDescriptor, WorkloadClass,
};
use mc_shm_transport::profile::{
    AdmissionController, CompletionMode, HostLimits as ShmHostLimits, ProducerTopology,
    ProfileConfig, ResourceCharges, TargetProfile, WorkerTopology,
};
use subc_protocol::{decode_header, AdmissionClass, EnvelopeHeader, FrameType};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::frame_channel::{
    frame_sender, BoxedReceiver, CopyCounter, DirectFrame, FrameReceiver, InboundEvent,
    InboundFrame, OutboundFrame, ReadClose, RejectedFrame, SenderQueue, COMPLETE,
};
use crate::transport_provider::{
    Candidate, InjectedProvider, PreparedCandidate, ProviderContext, ProviderFailure,
};
use crate::wire::{ByteBudget, MAX_BODY_LEN, MAX_CONTROL_BODY_LEN};

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
}

impl ShmProvider {
    /// Builds provider with explicit process-wide admission limits.
    pub fn for_qualified_test_profile(limits: ShmHostLimits) -> Self {
        Self {
            profile: Arc::new(qualified_test_profile()),
            admission: Arc::new(AdmissionController::new(limits)),
            preparations: AtomicU64::new(0),
            quarantine_next_close: Arc::new(AtomicBool::new(false)),
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

    fn preflight(&self, parameters: Option<&serde_json::Value>) -> bool {
        cfg!(target_os = "linux")
            && Self::offer_is_exact(parameters)
            && self.admission.can_admit(&self.profile, None).is_ok()
    }

    fn prepare(&self, ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure> {
        if !cfg!(target_os = "linux") || !Self::offer_is_exact(ctx.offer_parameters()) {
            return Err(ProviderFailure::Unavailable);
        }
        let admission = self
            .admission
            .admit(&self.profile, None)
            .map_err(|_| ProviderFailure::Unavailable)?;
        self.preparations.fetch_add(1, Ordering::AcqRel);

        let candidate_id = NEXT_CANDIDATE_ID.fetch_add(1, Ordering::Relaxed);
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
                    ))
                }))
                .unwrap_or(false);
                if clean && !quarantine_next_close.swap(false, Ordering::AcqRel) {
                    admission.release();
                } else {
                    let _ = admission.quarantine();
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

async fn run_endpoint(
    rings: DuplexRing,
    mut queue: SenderQueue,
    inbound: mpsc::Sender<Result<InboundEvent, ReadClose>>,
    ingress: ByteBudget,
    frame_deadline: Duration,
    root: CancellationToken,
    read_cancel: CancellationToken,
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
            )
            .await
            {
                Ok(true) => received = true,
                Ok(false) => {}
                Err(close) => {
                    // Cancellation is ordinary retirement — the read side was
                    // told to stop mid-receive (or the inbound consumer is
                    // gone) and the local lease releases safely on drop — so
                    // it must not quarantine the admission charges: with
                    // single-candidate limits that would permanently block
                    // every later shared-memory candidate. Only structural
                    // faults are unclean.
                    let clean = matches!(close, ReadClose::Cancelled);
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
        if publish_one(&rings.first, queued, frame_deadline).is_err() {
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
            return Err(ReadClose::Corrupt(
                "body budget wait exceeded frame deadline",
            ));
        }
        // The budget wait services queued outbound frames: a slow ingress
        // drain holds only this receive, not the connection's sends, which
        // would otherwise miss their deadlines behind it.
        match queue.try_recv() {
            Ok(queued) => {
                if publish_one(&rings.first, queued, frame_deadline).is_err() {
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

fn validate_inbound_header(header: EnvelopeHeader) -> Result<(), ReadClose> {
    if header.len > MAX_BODY_LEN {
        return Err(ReadClose::Corrupt("body over interoperability cap"));
    }
    if header.ty.is_pure_header()
        && (header.flags.is_binary()
            || header.flags.is_last()
            || header.flags.admission_class() != Some(AdmissionClass::Normal))
    {
        return Err(ReadClose::Corrupt("invalid pure-header flags"));
    }
    if !matches!(
        header.ty,
        FrameType::Request | FrameType::Cancel | FrameType::Pong | FrameType::Goodbye
    ) {
        return Err(ReadClose::Corrupt("role-invalid frame type"));
    }
    Ok(())
}

fn publish_one(
    ring: &Ring,
    mut queued: crate::frame_channel::QueuedOutboundFrame,
    frame_deadline: Duration,
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
    let deadline = StdInstant::now() + frame_deadline;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match direct {
        Some(direct) => publish_direct(ring, direct, deadline),
        None => publish_owned(ring, &bytes, &tail, deadline),
    }));
    if !matches!(result, Ok(Ok(()))) {
        return Err(());
    }
    completion.store(COMPLETE, Ordering::Release);
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
    let (header, first_body) = bytes
        .split_at_checked(subc_protocol::HEADER_LEN)
        .ok_or(())?;
    let header: [u8; subc_protocol::HEADER_LEN] = header.try_into().map_err(|_| ())?;
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
    use subc_protocol::{Flags, Priority, PROTOCOL_VERSION};

    #[test]
    fn platform_preflight_is_side_effect_free() {
        let provider = ShmProvider::for_qualified_test_profile(single_candidate_limits());
        assert_eq!(
            provider.preflight(Some(&qualified_test_parameters())),
            cfg!(target_os = "linux")
        );
        assert_eq!(provider.preparation_count(), 0);
        let accounting = provider.accounting().unwrap();
        assert_eq!(accounting.active, ResourceCharges::ZERO);
        assert_eq!(accounting.quarantined, ResourceCharges::ZERO);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn copied_control_frame_records_one_host_adapter_copy() {
        let rings = DuplexRing::create(&qualified_test_profile()).unwrap();
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
        )
        .await
        .unwrap());
        let InboundEvent::Frame(frame) = received.recv().await.unwrap().unwrap() else {
            panic!("expected copied frame");
        };
        assert_eq!(frame.copy_counter().copies(), 1);
    }
}
