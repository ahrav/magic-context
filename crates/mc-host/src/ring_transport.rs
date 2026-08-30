//! Mandatory shared-memory ring transport.
//!
//! One dedicated OS thread creates and owns both `!Send` ring endpoints. Host
//! tasks exchange frame tickets and completion notifications with that thread.

use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as StdInstant};
use std::{fmt, io};

use crate::wire::{decode_header, EnvelopeHeader, FrameType};
use mc_shm_transport::backend::ring::RingGrant;
use mc_shm_transport::backend::ring::{DuplexRing, ProducerReservation, Ring};
use mc_shm_transport::descriptor::{HardwareProfileId, SchedulingMode, TransportDescriptor};
use mc_shm_transport::profile::{
    AdmissionController, CompletionMode, HostLimits as ShmHostLimits, ProducerTopology,
    ProfileConfig, ResourceCharges, TargetProfile, WorkerTopology,
};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::frame_channel::{
    frame_sender, validate_inbound_header, BoxedReceiver, CopyCounter, DirectFrame, FrameReceiver,
    InboundEvent, InboundFrame, OutboundFrame, ReadClose, RejectedFrame, SenderQueue, COMPLETE,
};
use crate::wire::{ByteBudget, MAX_CONTROL_BODY_LEN};

/// Current ring profile accepted by every process in one release.
pub const RING_PROFILE: &str = "mc-host-test-ring-v1";
const DESCRIPTOR_DEPTH: usize = 8;
const POLL_INTERVAL: Duration = Duration::from_micros(50);

/// Test-only observer invoked after each successful frame publication with
/// the published frame's type and channel. It receives no descriptors,
/// payloads, or provider data.
#[doc(hidden)]
pub type PublishHook = Arc<dyn Fn(FrameType, u16) + Send + Sync>;

pub fn ring_profile() -> TargetProfile {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            SchedulingMode::ColdParkWake,
            HardwareProfileId::new(RING_PROFILE).expect("static hardware profile is valid"),
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

/// Admission limits sufficient for one connection.
pub fn per_connection_limits() -> ShmHostLimits {
    let charges = ring_profile().charges();
    ShmHostLimits {
        descriptors: charges.descriptors,
        arena_bytes: charges.arena_bytes,
        leases: charges.leases,
        mappings: charges.mappings,
        file_descriptors: charges.file_descriptors,
        workers: charges.workers,
        client_instances: charges.client_instances,
        pinned_workers: charges.pinned_workers,
    }
}

pub fn process_limits(connections: usize) -> Option<ShmHostLimits> {
    let count = u64::try_from(connections).ok()?;
    let one = per_connection_limits();
    Some(ShmHostLimits {
        descriptors: one.descriptors.checked_mul(count)?,
        arena_bytes: one.arena_bytes.checked_mul(count)?,
        leases: one.leases.checked_mul(count)?,
        mappings: one.mappings.checked_mul(count)?,
        file_descriptors: one.file_descriptors.checked_mul(count)?,
        workers: one.workers.checked_mul(count)?,
        client_instances: one.client_instances.checked_mul(count)?,
        pinned_workers: one.pinned_workers.checked_mul(count)?,
    })
}

/// Process-wide owner of ring admission and endpoint creation.
pub struct RingTransport {
    profile: Arc<TargetProfile>,
    admission: Arc<AdmissionController>,
    limits: ShmHostLimits,
    preparations: AtomicU64,
    activations: AtomicU64,
    peer_deaths: AtomicU64,
    reclamations: AtomicU64,
    exhaustions: AtomicU64,
    publish_hook: Mutex<Option<PublishHook>>,
}

pub(crate) struct PreparedRing {
    pub(crate) descriptor: serde_json::Value,
    pub(crate) descriptors: [OwnedFd; 2],
    pub(crate) sender: crate::frame_channel::FrameSender,
    pub(crate) receiver: BoxedReceiver,
    pub(crate) io: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    pub(crate) root: CancellationToken,
    pub(crate) read_cancel: CancellationToken,
}

#[derive(Debug, Clone, Copy)]
pub struct RingUnavailable;

impl std::fmt::Display for RingUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("shared-memory ring is unavailable")
    }
}

impl std::error::Error for RingUnavailable {}

impl RingTransport {
    /// Builds the process-wide transport with finite admission limits.
    pub fn for_ring_profile(limits: ShmHostLimits) -> Self {
        let profile = Arc::new(ring_profile());
        let admission = Arc::new(AdmissionController::new(limits));
        Self {
            profile,
            admission,
            limits,
            preparations: AtomicU64::new(0),
            activations: AtomicU64::new(0),
            peer_deaths: AtomicU64::new(0),
            reclamations: AtomicU64::new(0),
            exhaustions: AtomicU64::new(0),
            publish_hook: Mutex::new(None),
        }
    }

    /// Aggregate profile charge used by admission tests.
    pub fn profile_charges(&self) -> ResourceCharges {
        self.profile.charges()
    }

    /// Number of clients that completed fixed-ring attachment.
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

    /// Bounded, aggregate-only state for authenticated doctor output.
    pub fn diagnostics(&self) -> serde_json::Value {
        let charges = |value: ResourceCharges| {
            serde_json::json!({
                "descriptors": value.descriptors,
                "arena_bytes": value.arena_bytes,
                "leases": value.leases,
                "mappings": value.mappings,
                "file_descriptors": value.file_descriptors,
                "workers": value.workers,
                "client_instances": value.client_instances,
                "pinned_workers": value.pinned_workers,
            })
        };
        let limits = serde_json::json!({
            "descriptors": self.limits.descriptors,
            "arena_bytes": self.limits.arena_bytes,
            "leases": self.limits.leases,
            "mappings": self.limits.mappings,
            "file_descriptors": self.limits.file_descriptors,
            "workers": self.limits.workers,
            "client_instances": self.limits.client_instances,
            "pinned_workers": self.limits.pinned_workers,
        });
        let (state, error_class, accounting) = match self.accounting() {
            Ok(accounting) => (
                "healthy",
                serde_json::Value::Null,
                serde_json::json!({
                    "active": charges(accounting.active),
                    "quarantined": charges(accounting.quarantined),
                }),
            ),
            Err(_) => (
                "terminal",
                serde_json::Value::String("setup_failure".to_owned()),
                serde_json::Value::Null,
            ),
        };
        serde_json::json!({
            "state": state,
            "error_class": error_class,
            "artifact": {
                "profile": RING_PROFILE,
                "wire_version": crate::wire::PROTOCOL_VERSION,
                "descriptor_schema": mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION,
            },
            "bounds": limits,
            "accounting": accounting,
            "attachment": {"completed": self.preparations.load(Ordering::Acquire)},
            "activation": {"completed": self.activations.load(Ordering::Acquire)},
            "peer_death": {"observed": self.peer_deaths.load(Ordering::Acquire)},
            "reclamation": {"completed": self.reclamations.load(Ordering::Acquire)},
            "exhaustion": {"observed": self.exhaustions.load(Ordering::Acquire)},
        })
    }

    pub(crate) fn record_attachment(&self) {
        self.preparations.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_activation(&self) {
        self.activations.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_peer_death(&self) {
        self.peer_deaths.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_reclamation(&self) {
        self.reclamations.fetch_add(1, Ordering::Relaxed);
    }

    /// Test hook: install a publication observer for connections prepared
    /// after this call. The hook runs on the endpoint thread after the ring
    /// commit. commentlint: allow(JUDGE)
    #[doc(hidden)]
    pub fn set_publish_hook(&self, hook: PublishHook) {
        *self.publish_hook.lock().expect("publish hook lock") = Some(hook);
    }

    pub(crate) fn prepare(
        &self,
        ingress: ByteBudget,
        queue_frames: usize,
        frame_deadline: Duration,
    ) -> Result<PreparedRing, RingUnavailable> {
        let admission = self.admission.admit(&self.profile, None).map_err(|_| {
            self.exhaustions.fetch_add(1, Ordering::Relaxed);
            RingUnavailable
        })?;
        let root = CancellationToken::new();
        let read_cancel = root.child_token();
        let (sender, queue) = frame_sender(queue_frames, root.clone(), frame_deadline);
        let (inbound_tx, inbound_rx) = mpsc::channel(queue_frames);
        let (initialized_tx, initialized_rx) = std::sync::mpsc::sync_channel(1);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let profile = Arc::clone(&self.profile);
        let worker_root = root.clone();
        let worker_read_cancel = read_cancel.clone();
        let publish_hook = self.publish_hook.lock().expect("publish hook lock").clone();

        let spawned = std::thread::Builder::new()
            .name("mc-host-shm-endpoint".to_owned())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build();
                let rings = runtime
                    .as_ref()
                    .map_err(|_| RingUnavailable)
                    .and_then(|_| DuplexRing::create(&profile).map_err(|_| RingUnavailable));
                let (runtime, rings) = match (runtime, rings) {
                    (Ok(runtime), Ok(rings)) => (runtime, rings),
                    _ => {
                        let _ = initialized_tx.send(Err(RingUnavailable));
                        return;
                    }
                };
                let transfer = worker_descriptor(&rings);
                let Ok((descriptor, descriptors)) = transfer else {
                    let _ = initialized_tx.send(Err(RingUnavailable));
                    return;
                };
                if initialized_tx.send(Ok((descriptor, descriptors))).is_err() {
                    return;
                }
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
                }));
                admission.release();
                let _ = done_tx.send(());
            });
        if spawned.is_err() {
            return Err(RingUnavailable);
        }
        let (descriptor, descriptors) = initialized_rx.recv().map_err(|_| RingUnavailable)??;
        let receiver = BoxedReceiver::new(ShmReceiver {
            inbound: inbound_rx,
        });
        let io = Box::pin(async move {
            let _ = done_rx.await;
        });
        Ok(PreparedRing {
            descriptor,
            descriptors,
            sender,
            receiver,
            io,
            root,
            read_cancel,
        })
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct WireDescriptor {
    profile: String,
    host_to_peer_grant: String,
    peer_to_host_grant: String,
}

fn worker_descriptor(rings: &DuplexRing) -> Result<(serde_json::Value, [OwnedFd; 2]), ()> {
    let descriptor = WireDescriptor {
        profile: RING_PROFILE.to_owned(),
        host_to_peer_grant: encode_hex(&rings.first.grant().encode()),
        peer_to_host_grant: encode_hex(&rings.second.grant().encode()),
    };
    let descriptors = [
        rings.first.attachment().map_err(|_| ())?.into_parts().0,
        rings.second.attachment().map_err(|_| ())?.into_parts().0,
    ];
    Ok((
        serde_json::to_value(descriptor).map_err(|_| ())?,
        descriptors,
    ))
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
) {
    let discard = queue.discard.clone();
    let finish = queue.finish.clone();
    let mut inbound = Some(inbound);
    let mut finishing = false;
    loop {
        let mut received = false;
        if let Some(inbound_sender) = inbound.as_ref() {
            match receive_one(
                &rings,
                &mut queue,
                inbound_sender,
                &ingress,
                frame_deadline,
                &read_cancel,
                publish_hook.as_ref(),
            )
            .await
            {
                Ok(true) => received = true,
                Ok(false) => {
                    if read_cancel.is_cancelled() {
                        if let Some(inbound) = inbound.take() {
                            let _ = inbound.send(Err(ReadClose::Cancelled)).await;
                        }
                    }
                }
                Err(close) => {
                    let _ = inbound_sender.send(Err(close)).await;
                    queue.retired.cancel();
                    root.cancel();
                    return;
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
                Err(_) => return,
            }
        } else {
            tokio::select! {
                biased;
                () = discard.cancelled() => return,
                () = finish.cancelled() => {
                    finishing = true;
                    None
                }
                () = read_cancel.cancelled(), if inbound.is_some() => {
                    // Re-enter the receive path once after observing
                    // cancellation. It drains frames committed before the
                    // cancellation edge, then reports `Cancelled` after the
                    // first empty observation.
                    None
                }
                frame = queue.recv() => match frame {
                    Some(frame) => Some(frame),
                    None => return,
                },
                () = root.cancelled() => return,
                () = tokio::time::sleep(POLL_INTERVAL) => None,
            }
        };
        let Some(queued) = queued else {
            continue;
        };
        if publish_one(&rings.first, queued, frame_deadline, publish_hook.as_ref()).is_err() {
            queue.retired.cancel();
            root.cancel();
            return;
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
            Err(_) => {
                tokio::select! {
                    biased;
                    () = read_cancel.cancelled() => return Err(ReadClose::Cancelled),
                    () = tokio::time::sleep(POLL_INTERVAL) => {}
                }
            }
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
pub struct RingClientEndpoint {
    /// Peer-to-host producer direction.
    pub to_host: Ring,
    /// Host-to-peer consumer direction.
    pub from_host: Ring,
}

impl RingClientEndpoint {
    /// Attaches a descriptor and its setup-socket file descriptors.
    pub fn attach_with_descriptors(
        descriptor: &serde_json::Value,
        descriptors: [OwnedFd; 2],
    ) -> Result<Self, RingClientError> {
        let descriptor: WireDescriptor =
            serde_json::from_value(descriptor.clone()).map_err(|_| RingClientError)?;
        if descriptor.profile != RING_PROFILE {
            return Err(RingClientError);
        }
        let [from_host_fd, to_host_fd] = descriptors;
        let from_host_grant = decode_grant(&descriptor.host_to_peer_grant)?;
        let to_host_grant = decode_grant(&descriptor.peer_to_host_grant)?;
        if from_host_grant.geometry() != to_host_grant.geometry() {
            return Err(RingClientError);
        }
        let from_host = Ring::attach(from_host_fd, from_host_grant, SchedulingMode::ColdParkWake)
            .map_err(|_| RingClientError)?;
        let to_host = Ring::attach(to_host_fd, to_host_grant, SchedulingMode::ColdParkWake)
            .map_err(|_| RingClientError)?;
        Ok(Self { to_host, from_host })
    }

    /// Publishes one complete consumer frame.
    pub fn send(&self, header: EnvelopeHeader, body: &[u8]) -> Result<(), RingClientError> {
        let mut reservation = self
            .to_host
            .reserve_until(
                body.len(),
                header.encode(),
                StdInstant::now() + Duration::from_secs(2),
            )
            .map_err(|_| RingClientError)?;
        reservation.write(body).map_err(|_| RingClientError)?;
        reservation
            .commit(body.len())
            .map_err(|_| RingClientError)?;
        Ok(())
    }

    /// Waits for one complete host frame and records its completion.
    pub fn recv(&self, timeout: Duration) -> Result<(EnvelopeHeader, Vec<u8>), RingClientError> {
        let deadline = StdInstant::now() + timeout;
        loop {
            if let Some(frame) = self.try_recv()? {
                return Ok(frame);
            }
            if StdInstant::now() >= deadline {
                return Err(RingClientError);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    pub fn try_recv(&self) -> Result<Option<(EnvelopeHeader, Vec<u8>)>, RingClientError> {
        self.try_recv_with(|_| Some(()))
            .map(|frame| frame.map(|(header, body, ())| (header, body)))
    }

    pub(crate) fn try_recv_with<T>(
        &self,
        charge: impl FnOnce(usize) -> Option<T>,
    ) -> Result<Option<(EnvelopeHeader, Vec<u8>, T)>, RingClientError> {
        let Some(lease) = self.from_host.try_receive().map_err(|_| RingClientError)? else {
            return Ok(None);
        };
        let header = decode_header(&lease.wire_header()).map_err(|_| RingClientError)?;
        let Some(charge) = charge(lease.len()) else {
            lease.release().map_err(|_| RingClientError)?;
            return Err(RingClientError);
        };
        let body = lease.to_vec().map_err(|_| RingClientError)?;
        lease.release().map_err(|_| RingClientError)?;
        Ok(Some((header, body, charge)))
    }
}

fn decode_grant(grant: &str) -> Result<RingGrant, RingClientError> {
    RingGrant::decode(decode_hex(grant)?).map_err(|_| RingClientError)
}

fn decode_hex<const N: usize>(text: &str) -> Result<[u8; N], RingClientError> {
    let text = text.as_bytes();
    if text.len() != N * 2 {
        return Err(RingClientError);
    }
    fn nibble(byte: u8) -> Result<u8, RingClientError> {
        match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            _ => Err(RingClientError),
        }
    }
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = nibble(text[index * 2])? << 4 | nibble(text[index * 2 + 1])?;
    }
    Ok(bytes)
}

/// Redacted test-peer attachment or I/O failure.
#[derive(Clone, Copy)]
pub struct RingClientError;

impl fmt::Debug for RingClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RingClientError(<redacted>)")
    }
}

impl fmt::Display for RingClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("shared-memory peer operation failed")
    }
}

impl std::error::Error for RingClientError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{Flags, Priority, PROTOCOL_VERSION};

    struct TestCharge {
        used: Arc<std::sync::atomic::AtomicUsize>,
        bytes: usize,
    }

    impl Drop for TestCharge {
        fn drop(&mut self) {
            self.used.fetch_sub(self.bytes, Ordering::SeqCst);
        }
    }

    #[test]
    fn construction_has_no_ring_side_effects() {
        let transport = RingTransport::for_ring_profile(per_connection_limits());
        assert_eq!(transport.preparation_count(), 0);
        let accounting = transport.accounting().unwrap();
        assert_eq!(accounting.active, ResourceCharges::ZERO);
        assert_eq!(accounting.quarantined, ResourceCharges::ZERO);
    }

    #[test]
    fn diagnostics_report_fixed_identity_bounds_accounting_and_lifecycle_counts() {
        let limits = per_connection_limits();
        let transport = RingTransport::for_ring_profile(limits);
        transport.record_attachment();
        transport.record_activation();
        transport.record_peer_death();
        transport.record_reclamation();

        let diagnostics = transport.diagnostics();
        assert_eq!(diagnostics["state"], "healthy");
        assert_eq!(diagnostics["error_class"], serde_json::Value::Null);
        assert_eq!(diagnostics["artifact"]["profile"], RING_PROFILE);
        assert_eq!(
            diagnostics["artifact"]["wire_version"],
            crate::wire::PROTOCOL_VERSION
        );
        assert_eq!(
            diagnostics["artifact"]["descriptor_schema"],
            mc_shm_transport::descriptor::DESCRIPTOR_SCHEMA_VERSION
        );
        assert_eq!(diagnostics["bounds"]["arena_bytes"], limits.arena_bytes);
        assert_eq!(diagnostics["accounting"]["active"]["arena_bytes"], 0);
        assert_eq!(diagnostics["accounting"]["quarantined"]["arena_bytes"], 0);
        assert_eq!(diagnostics["attachment"]["completed"], 1);
        assert_eq!(diagnostics["activation"]["completed"], 1);
        assert_eq!(diagnostics["peer_death"]["observed"], 1);
        assert_eq!(diagnostics["reclamation"]["completed"], 1);
        assert_eq!(diagnostics["exhaustion"]["observed"], 0);

        let encoded = diagnostics.to_string();
        for secret_field in [
            "socket_path",
            "native_handle",
            "mapping_descriptor",
            "activation_token",
            "authentication_key",
            "payload",
            "mapped_address",
        ] {
            assert!(!encoded.contains(secret_field));
        }
    }

    #[test]
    fn ring_profile_pins_per_connection_grant_geometry() {
        let profile = ring_profile();
        assert_eq!(profile.descriptor_depth(), 8);
        assert_eq!(profile.max_leases(), 8);
        assert_eq!(profile.arena_bytes(), mc_shm_transport::MIN_ARENA_BYTES);
    }

    #[test]
    fn grant_hex_is_strict_lowercase_ascii_without_panics() {
        assert_eq!(decode_hex::<2>("00af").unwrap(), [0x00, 0xaf]);
        assert!(decode_hex::<2>("00AF").is_err());
        assert!(decode_hex::<1>("+0").is_err());
        let non_ascii = std::panic::catch_unwind(|| decode_hex::<2>("0é0"));
        assert!(matches!(non_ascii, Ok(Err(_))));
    }

    #[test]
    fn inbound_materialization_cannot_exceed_its_byte_budget() {
        let rings = DuplexRing::create(&ring_profile()).unwrap();
        let from_host = rings.first.attachment().unwrap().attach().unwrap();
        let to_host = rings.second.attachment().unwrap().attach().unwrap();
        let endpoint = RingClientEndpoint { to_host, from_host };
        let header = EnvelopeHeader {
            len: 1,
            ver: PROTOCOL_VERSION,
            ty: FrameType::Response,
            flags: Flags::new(false, Priority::Interactive, false),
            channel: 0,
            epoch: 0,
            corr: 1,
        };
        for byte in [1, 2] {
            let mut reservation = rings.first.try_reserve(1, header.encode()).unwrap();
            reservation.write(&[byte]).unwrap();
            reservation.commit(1).unwrap();
        }
        let used = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let charge = |bytes| {
            let previous = used.fetch_add(bytes, Ordering::SeqCst);
            if previous + bytes > 1 {
                used.fetch_sub(bytes, Ordering::SeqCst);
                None
            } else {
                Some(TestCharge {
                    used: Arc::clone(&used),
                    bytes,
                })
            }
        };

        let first = endpoint.try_recv_with(charge).unwrap().unwrap();
        assert_eq!(first.1, [1]);
        assert_eq!(used.load(Ordering::SeqCst), 1);
        assert!(endpoint.try_recv_with(charge).is_err());
        assert_eq!(used.load(Ordering::SeqCst), 1);
        drop(first);
        assert_eq!(used.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn copied_control_frame_records_one_host_adapter_copy() {
        let rings = DuplexRing::create(&ring_profile()).unwrap();
        let geometry = rings.first.grant().geometry();
        assert_eq!(geometry.descriptor_depth, 8);
        assert_eq!(geometry.max_leases, 8);
        assert_eq!(
            geometry.mapping_bytes,
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

    #[tokio::test(flavor = "current_thread")]
    async fn budget_wait_observes_read_cancellation() {
        let rings = DuplexRing::create(&ring_profile()).unwrap();
        let body = [7u8];
        let header = EnvelopeHeader {
            len: 1,
            ver: PROTOCOL_VERSION,
            ty: FrameType::Request,
            flags: Flags::new(false, Priority::Interactive, false),
            channel: 0,
            epoch: 0,
            corr: 1,
        };
        let mut reservation = rings.second.try_reserve(1, header.encode()).unwrap();
        reservation.write(&body).unwrap();
        reservation.commit(1).unwrap();
        let (_sender, mut queue) =
            frame_sender(1, CancellationToken::new(), Duration::from_secs(1));
        let (inbound, _received) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let cancellation = cancel.clone();
        let budget = ByteBudget::new(0);
        let receive = receive_one(
            &rings,
            &mut queue,
            &inbound,
            &budget,
            Duration::from_secs(1),
            &cancellation,
            None,
        );
        let cancel_after_poll = async move {
            tokio::task::yield_now().await;
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(receive, cancel_after_poll);
        assert!(matches!(result, Err(ReadClose::Cancelled)));
    }
}
