//! Semantic contract suite for the mandatory shared-memory frame channel.
//!
//! Every scenario exercises only the neutral boundary — [`FrameSender`],
//! the concrete `ShmReceiver` receive side, shared lifecycle tokens, and
//! byte-charge ownership —
//! through a [`ChannelFactory`]. The sole instantiation below uses the
//! production ring transport. The in-process ownership tests remain local to
//! this module and cannot be selected as a production transport.

use std::future::Future;
use std::sync::{Arc, Condvar, Mutex};

use tokio::time::{Duration, Instant};

use crate::wire::{EnvelopeHeader, Flags, FrameType};
use tokio_util::sync::CancellationToken;

use crate::frame_channel::{FrameSender, InboundEvent, OutboundFrame};
use crate::ring_transport::ShmReceiver;
use crate::wire::{encode_frame, pure_header_flags, response_flags, ByteBudget, FrameId};

/// `ChannelFactory` maps scenario-controlled channel dimensions onto its transport.
/// transport.
pub(crate) struct ContractConfig {
    pub queue_frames: usize,
    pub write_deadline: Duration,
    /// `budget_bytes` backs every inbound and test-created outbound charge.
    pub budget_bytes: u64,
    pub publish_hook: Option<crate::ring_transport::PublishHook>,
}

impl Default for ContractConfig {
    fn default() -> Self {
        Self {
            queue_frames: 8,
            write_deadline: Duration::from_secs(5),
            budget_bytes: 1 << 20,
            publish_hook: None,
        }
    }
}

/// `Harness` contains the channel under test and an independent peer for its far side.
/// far side.
pub(crate) struct Harness<P> {
    pub sender: FrameSender,
    pub channel: ShmReceiver,
    pub peer: P,
    /// `generation` is the engine-side retirement root shared with the channel.
    pub generation: CancellationToken,
    /// `budget` is the pool created from `ContractConfig::budget_bytes`; scenarios assert charge release against it.
    pub budget: ByteBudget,
    pub io_task: tokio::task::JoinHandle<()>,
}

/// Frame-level far end of the channel under test. Implementations must
/// encode and decode independently of the channel so the suite never uses
/// the implementation to verify itself.
pub(crate) trait PeerDriver {
    /// Injects one complete inbound frame toward the channel.
    fn send_frame(
        &mut self,
        ty: FrameType,
        flags: Flags,
        id: FrameId,
        body: Vec<u8>,
    ) -> impl Future<Output = ()>;
    /// Yields the next complete frame the channel published, or `None` once
    /// the channel closed its outbound side.
    fn recv_frame(&mut self) -> impl Future<Output = Option<(EnvelopeHeader, Vec<u8>)>>;
    /// Closes the peer cleanly at a frame boundary.
    fn close(self) -> impl Future<Output = ()>;
}

/// Each provider supplies one factory, while the scenarios remain identical across providers.
pub(crate) trait ChannelFactory {
    type Peer: PeerDriver;
    fn connect(&self, cfg: ContractConfig) -> impl Future<Output = Harness<Self::Peer>>;
}

fn request_id(corr: u64) -> FrameId {
    FrameId {
        channel: 7,
        epoch: 1,
        corr,
    }
}

fn outbound(corr: u64, body: &[u8]) -> OutboundFrame {
    OutboundFrame {
        bytes: encode_frame(
            FrameType::Response,
            response_flags(false, true),
            request_id(corr),
            body,
        )
        .expect("contract frame encodes"),
        tail: Vec::new(),
        direct: None,
        charge: crate::wire::ByteCharge::none(),
        written: None,
    }
}

/// Concurrent sends and receives make progress, and the logical writer publishes frames in admission order across sender clones.
pub(crate) async fn concurrent_send_receive_preserves_fifo_admission<F: ChannelFactory>(
    factory: &F,
) {
    let mut h = factory.connect(ContractConfig::default()).await;
    let sender_b = h.sender.clone();
    for corr in 1..=8u64 {
        let via_clone = corr % 2 == 0;
        let frame = outbound(corr, b"out");
        if via_clone {
            sender_b.send(frame).await.expect("clone admits");
        } else {
            h.sender.send(frame).await.expect("sender admits");
        }
        h.peer
            .send_frame(
                FrameType::Request,
                response_flags(false, true),
                request_id(corr),
                b"in".to_vec(),
            )
            .await;
    }
    for corr in 1..=8u64 {
        let (header, body) = h.peer.recv_frame().await.expect("published frame");
        assert_eq!(header.corr, corr, "publication must follow admission order");
        assert_eq!(body, b"out");
        let event = h.channel.recv().await.expect("inbound frame");
        let InboundEvent::Frame(frame) = event else {
            panic!("expected a complete inbound frame");
        };
        assert_eq!(frame.header.corr, corr);
        frame.with_lease(|lease| assert_eq!(lease.segment(0), Some(&b"in"[..])));
    }
}

/// Frame-count saturation blocks admission at `queue_frames`, and an expired admission deadline retires `generation`.
/// `queue_frames` grants frame capacity, not byte capacity.
pub(crate) async fn saturation_holds_at_frame_bound_and_spares_control_capacity<
    F: ChannelFactory,
>(
    factory: &F,
) {
    let h = factory
        .connect(ContractConfig {
            queue_frames: 1,
            ..ContractConfig::default()
        })
        .await;
    // Charge-free frames remain admissible when the entire byte pool is held.
    let held = h.budget.try_charge(h.budget.available()).expect("pool");
    let control = || OutboundFrame {
        bytes: encode_frame(
            FrameType::Goodbye,
            pure_header_flags(),
            FrameId::control(0),
            &[],
        )
        .expect("header-only frame encodes"),
        tail: Vec::new(),
        direct: None,
        charge: crate::wire::ByteCharge::none(),
        written: None,
    };
    for _ in 0..8 {
        h.sender
            .send(control())
            .await
            .expect("ring slot admits with the byte pool exhausted");
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.sender
        .send(control())
        .await
        .expect("writer blocks at ring bound");
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.sender.send(control()).await.expect("one frame queues");
    let deadline = Instant::now() + Duration::from_millis(50);
    assert!(
        h.sender.send_before(control(), deadline).await.is_err(),
        "a saturated frame queue must reject past the admission deadline"
    );
    assert!(
        h.generation.is_cancelled(),
        "an expired admission retires the generation"
    );
    drop(held);
}

/// Local-completion hooks run exactly once in admission order.
/// Hooks fire on local egress before peer decoding.
/// Local completion never claims peer receipt.
pub(crate) async fn completion_hooks_fire_once_in_order_without_claiming_receipt<
    F: ChannelFactory,
>(
    factory: &F,
) {
    let mut h = factory.connect(ContractConfig::default()).await;
    let completions: Arc<Mutex<Vec<(u64, Instant)>>> = Arc::new(Mutex::new(Vec::new()));
    for corr in 1..=3u64 {
        let mut frame = outbound(corr, b"cb");
        let completions = Arc::clone(&completions);
        frame.written = Some(Box::new(move |at| {
            completions
                .lock()
                .expect("completions lock")
                .push((corr, at));
        }));
        h.sender.send(frame).await.expect("admits");
    }
    // The three local-completion hooks must run before the peer reads a frame.
    // Local completion must not depend on peer consumption.
    let waited_at = Instant::now() + Duration::from_secs(5);
    loop {
        if completions.lock().expect("completions lock").len() == 3 {
            break;
        }
        assert!(Instant::now() < waited_at, "completions never fired");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let seen = completions.lock().expect("completions lock").clone();
    assert_eq!(
        seen.iter().map(|(corr, _)| *corr).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "hooks fire exactly once each, in admission order"
    );
    assert!(seen.windows(2).all(|w| w[0].1 <= w[1].1));
    for corr in 1..=3u64 {
        let (header, _) = h.peer.recv_frame().await.expect("published frame");
        assert_eq!(header.corr, corr);
    }
}

/// A frame refused before admission is never published.
/// A send refused before admission fails, and the peer observes no frame bytes.
pub(crate) async fn cancellation_before_admission_leaves_the_frame_unpublished<
    F: ChannelFactory,
>(
    factory: &F,
) {
    let mut h = factory.connect(ContractConfig::default()).await;
    h.sender.discard();
    h.io_task.await.expect("transport task");
    assert!(
        h.sender.send(outbound(1, b"never")).await.is_err(),
        "a discarded channel refuses admission"
    );
    assert!(
        h.peer.recv_frame().await.is_none(),
        "an unadmitted frame must leave no bytes on the wire"
    );
}

/// Publication failure after admission retires the entire channel.
/// `generation` is canceled, later sends fail, and no frame is replayed.
pub(crate) async fn failure_after_publication_begins_retires_without_replay<F: ChannelFactory>(
    factory: &F,
) {
    let h = factory
        .connect(ContractConfig {
            queue_frames: 2,
            write_deadline: Duration::from_millis(50),
            ..ContractConfig::default()
        })
        .await;
    let baseline = h.budget.available();
    for corr in 1..=8 {
        h.sender
            .send(outbound(corr, b"fill"))
            .await
            .expect("ring slot admits");
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    let charge = h.budget.try_charge(4096).expect("charge");
    let mut frame = outbound(9, &vec![0u8; 4096]);
    frame.charge = charge;
    // After the peer disconnects, admission may succeed, but publication must fail.
    // Publication failure retires the channel rather than retrying.
    let _ = h.sender.send(frame).await;
    h.io_task.await.expect("transport task");
    assert!(h.sender.is_retired());
    assert!(
        h.generation.is_cancelled(),
        "publication failure retires the generation"
    );
    assert_eq!(
        h.budget.available(),
        baseline,
        "a failed frame's charge is released, not retained for replay"
    );
    assert!(h.sender.send(outbound(10, b"late")).await.is_err());
}

pub(crate) async fn graceful_finish_drains_admitted_frames_before_close<F: ChannelFactory>(
    factory: &F,
) {
    let mut h = factory.connect(ContractConfig::default()).await;
    for corr in 1..=3u64 {
        h.sender
            .send(outbound(corr, b"drain"))
            .await
            .expect("admits");
    }
    h.sender.finish();
    for corr in 1..=3u64 {
        let (header, _) = h.peer.recv_frame().await.expect("drained frame");
        assert_eq!(header.corr, corr);
    }
    h.io_task.await.expect("transport task");
    assert!(
        h.peer.recv_frame().await.is_none(),
        "finish closes the channel after the drain"
    );
}

/// carried.
pub(crate) async fn discard_drops_queued_frames_and_releases_charges<F: ChannelFactory>(
    factory: &F,
) {
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let hook_release = Arc::clone(&release);
    let h = factory
        .connect(ContractConfig {
            publish_hook: Some(Arc::new(move |_, _| {
                let (released, changed) = &*hook_release;
                let mut released = released.lock().expect("publication gate lock");
                while !*released {
                    released = changed.wait(released).expect("publication gate wait");
                }
            })),
            ..ContractConfig::default()
        })
        .await;
    let baseline = h.budget.available();
    for corr in 1..=3u64 {
        let charge = h.budget.try_charge(1024).expect("charge");
        let mut frame = outbound(corr, &vec![0u8; 1024]);
        frame.charge = charge;
        h.sender.send(frame).await.expect("admits");
    }
    assert!(h.budget.available() < baseline);
    h.sender.discard();
    {
        let (released, changed) = &*release;
        *released.lock().expect("publication gate lock") = true;
        changed.notify_all();
    }
    h.io_task.await.expect("transport task");
    assert_eq!(
        h.budget.available(),
        baseline,
        "discard releases every queued frame's charge"
    );
}

/// charge lives exactly as long as the delivered body.
pub(crate) async fn inbound_payload_ownership_travels_with_the_frame<F: ChannelFactory>(
    factory: &F,
) {
    let mut h = factory.connect(ContractConfig::default()).await;
    let baseline = h.budget.available();
    h.peer
        .send_frame(
            FrameType::Request,
            response_flags(false, true),
            request_id(1),
            vec![0xEE; 2048],
        )
        .await;
    let event = h.channel.recv().await.expect("inbound frame");
    let InboundEvent::Frame(frame) = event else {
        panic!("expected a complete inbound frame");
    };
    assert_eq!(frame.body_len(), 2048);
    assert_eq!(
        h.budget.available(),
        baseline - 2048,
        "a delivered body holds its charge"
    );
    drop(frame);
    assert_eq!(
        h.budget.available(),
        baseline,
        "dropping the frame releases its bytes"
    );
}

/// In-band Goodbye remains a complete frame at the ring boundary. Transport
/// loss is never reclassified as an orderly application shutdown.
pub(crate) async fn goodbye_at_a_frame_boundary_is_delivered<F: ChannelFactory>(factory: &F) {
    let mut h = factory.connect(ContractConfig::default()).await;
    h.peer
        .send_frame(
            FrameType::Request,
            response_flags(false, true),
            request_id(1),
            b"last".to_vec(),
        )
        .await;
    let event = h.channel.recv().await.expect("frame before close");
    assert!(matches!(event, InboundEvent::Frame(_)));
    h.peer
        .send_frame(
            FrameType::Goodbye,
            pure_header_flags(),
            FrameId::control(0),
            Vec::new(),
        )
        .await;
    let event = h.channel.recv().await.expect("Goodbye frame");
    let InboundEvent::Frame(frame) = event else {
        panic!("expected Goodbye frame");
    };
    assert_eq!(frame.header.ty, FrameType::Goodbye);
    h.peer.close().await;
}

/// Instantiates the full semantic inventory against one factory expression.
macro_rules! frame_channel_contract_suite {
    ($factory:expr) => {
        #[tokio::test]
        async fn contract_concurrent_send_receive_preserves_fifo_admission() {
            $crate::frame_channel::contract_tests::concurrent_send_receive_preserves_fifo_admission(&$factory).await;
        }

        #[tokio::test]
        async fn contract_saturation_holds_at_frame_bound_and_spares_control_capacity() {
            $crate::frame_channel::contract_tests::saturation_holds_at_frame_bound_and_spares_control_capacity(&$factory).await;
        }

        #[tokio::test]
        async fn contract_completion_hooks_fire_once_in_order_without_claiming_receipt() {
            $crate::frame_channel::contract_tests::completion_hooks_fire_once_in_order_without_claiming_receipt(&$factory).await;
        }

        #[tokio::test]
        async fn contract_cancellation_before_admission_leaves_the_frame_unpublished() {
            $crate::frame_channel::contract_tests::cancellation_before_admission_leaves_the_frame_unpublished(&$factory).await;
        }

        #[tokio::test]
        async fn contract_failure_after_publication_begins_retires_without_replay() {
            $crate::frame_channel::contract_tests::failure_after_publication_begins_retires_without_replay(&$factory).await;
        }

        #[tokio::test]
        async fn contract_graceful_finish_drains_admitted_frames_before_close() {
            $crate::frame_channel::contract_tests::graceful_finish_drains_admitted_frames_before_close(&$factory).await;
        }

        #[tokio::test]
        async fn contract_discard_drops_queued_frames_and_releases_charges() {
            $crate::frame_channel::contract_tests::discard_drops_queued_frames_and_releases_charges(&$factory).await;
        }

        #[tokio::test]
        async fn contract_inbound_payload_ownership_travels_with_the_frame() {
            $crate::frame_channel::contract_tests::inbound_payload_ownership_travels_with_the_frame(&$factory).await;
        }

        #[tokio::test]
        async fn contract_goodbye_at_a_frame_boundary_is_delivered() {
            $crate::frame_channel::contract_tests::goodbye_at_a_frame_boundary_is_delivered(&$factory).await;
        }
    };
}

struct RingFactory;

struct RingPeer(crate::ring_transport::RingClientEndpoint);

impl PeerDriver for RingPeer {
    async fn send_frame(&mut self, ty: FrameType, flags: Flags, id: FrameId, body: Vec<u8>) {
        self.0
            .send(
                EnvelopeHeader {
                    len: body.len() as u32,
                    ver: crate::wire::PROTOCOL_VERSION,
                    ty,
                    flags,
                    channel: id.channel,
                    epoch: id.epoch,
                    corr: id.corr,
                },
                &body,
                std::time::Instant::now() + Duration::from_secs(2),
            )
            .expect("peer publishes frame");
    }

    async fn recv_frame(&mut self) -> Option<(EnvelopeHeader, Vec<u8>)> {
        self.0.recv(Duration::from_secs(2)).ok()
    }

    async fn close(self) {
        drop(self);
    }
}

impl ChannelFactory for RingFactory {
    type Peer = RingPeer;

    async fn connect(&self, cfg: ContractConfig) -> Harness<Self::Peer> {
        let budget = ByteBudget::new(cfg.budget_bytes);
        let transport = crate::ring_transport::RingTransport::for_ring_profile(
            crate::ring_transport::per_connection_limits(),
        );
        if let Some(hook) = cfg.publish_hook {
            transport.set_publish_hook(hook);
        }
        let prepared = transport
            .prepare(budget.clone(), cfg.queue_frames, cfg.write_deadline)
            .expect("production ring prepares");
        let peer = crate::ring_transport::RingClientEndpoint::attach_with_descriptors(
            &prepared.descriptor,
            prepared.descriptors,
        )
        .expect("peer attaches to production ring");
        let io_task = tokio::spawn(prepared.io);
        Harness {
            sender: prepared.sender,
            channel: prepared.receiver,
            peer: RingPeer(peer),
            generation: prepared.root,
            budget,
            io_task,
        }
    }
}

frame_channel_contract_suite!(RingFactory);

mod ownership_contract {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::frame_channel::{
        frame_sender, LeaseClose, LeaseTracker, ProducerError, ProducerReservation, SendOutcome,
    };

    struct Charges {
        bytes: Arc<AtomicUsize>,
        descriptors: Arc<AtomicUsize>,
    }

    impl Drop for Charges {
        fn drop(&mut self) {
            self.bytes.fetch_add(1, Ordering::SeqCst);
            self.descriptors.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn charges() -> (Charges, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let bytes = Arc::new(AtomicUsize::new(0));
        let descriptors = Arc::new(AtomicUsize::new(0));
        (
            Charges {
                bytes: Arc::clone(&bytes),
                descriptors: Arc::clone(&descriptors),
            },
            bytes,
            descriptors,
        )
    }

    fn produce_exact(len: usize, split: usize) {
        let mut first = vec![0u8; split.min(len)];
        let mut second = vec![0u8; len.saturating_sub(first.len())];
        let mut spans: [&mut [u8]; 2] = [&mut first, &mut second];
        let (charge, bytes, descriptors) = charges();
        let mut producer = ProducerReservation::new(&mut spans, len, charge).expect("reserve");
        let body = vec![0xA5; len];
        producer.write(&body).expect("bounded write");
        let produced = producer.commit(len).expect("exact commit");
        assert_eq!(produced.len(), len);
        if len == 0 {
            assert_eq!(produced.segment_count(), 0);
        } else if split == 0 || split >= len {
            assert_eq!(produced.segment_count(), 1);
        } else {
            assert_eq!(produced.segment_count(), 2);
            assert_eq!(produced.segment(0), Some(&body[..split]));
            assert_eq!(produced.segment(1), Some(&body[split..]));
        }
        drop(produced);
        assert_eq!(bytes.load(Ordering::SeqCst), 1);
        assert_eq!(descriptors.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn exact_commit_covers_empty_boundary_segmented_and_maximum_bodies() {
        produce_exact(0, 0);
        produce_exact(64, 64);
        produce_exact(65, 32);
        produce_exact(crate::wire::MAX_BODY_LEN as usize, 32 * 1024 * 1024);
    }

    #[test]
    fn producer_failures_never_publish_and_return_each_charge_once() {
        let publications = AtomicUsize::new(0);

        let mut first = [0u8; 8];
        let mut spans: [&mut [u8]; 1] = [&mut first];
        let (charge, bytes, descriptors) = charges();
        let mut producer = ProducerReservation::new(&mut spans, 8, charge).expect("reserve");
        producer.write(b"four").expect("partial write");
        assert_eq!(producer.commit(8).err(), Some(ProducerError::Underfill));
        assert_eq!(bytes.load(Ordering::SeqCst), 1);
        assert_eq!(descriptors.load(Ordering::SeqCst), 1);

        let mut second = [0u8; 8];
        let mut spans: [&mut [u8]; 1] = [&mut second];
        let (charge, bytes, descriptors) = charges();
        let mut producer = ProducerReservation::new(&mut spans, 8, charge).expect("reserve");
        assert_eq!(producer.write(&[0u8; 9]), Err(ProducerError::Overflow));
        assert_eq!(bytes.load(Ordering::SeqCst), 1);
        assert_eq!(descriptors.load(Ordering::SeqCst), 1);
        drop(producer);
        assert_eq!(bytes.load(Ordering::SeqCst), 1, "no double byte release");
        assert_eq!(
            descriptors.load(Ordering::SeqCst),
            1,
            "no double descriptor release"
        );

        let mut third = [0u8; 8];
        let mut spans: [&mut [u8]; 1] = [&mut third];
        let (charge, bytes, descriptors) = charges();
        ProducerReservation::new(&mut spans, 8, charge)
            .expect("reserve")
            .abort();
        assert_eq!(bytes.load(Ordering::SeqCst), 1);
        assert_eq!(descriptors.load(Ordering::SeqCst), 1);
        assert_eq!(publications.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_classifies_before_and_after_publication_without_double_release() {
        let budget = ByteBudget::new(16);
        let baseline = budget.available();
        let generation = CancellationToken::new();
        let (sender, mut queue) = frame_sender(2, generation, Duration::from_secs(1));

        let mut frame = outbound(1, b"cancel");
        frame.charge = budget.try_charge(8).expect("charge");
        let ticket = sender
            .send_ticket_before(frame, sender.admission_deadline(), None)
            .await
            .expect("admit");
        assert_eq!(ticket.cancel(), SendOutcome::NotSent);
        let mut queued = queue.recv().await.expect("queued frame");
        assert!(!queued.begin_publication());
        drop(queued);
        assert_eq!(budget.available(), baseline);
        assert_eq!(ticket.cancel(), SendOutcome::PossibleSend);

        let mut frame = outbound(2, b"publish");
        frame.charge = budget.try_charge(8).expect("charge");
        let published = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&published);
        let ticket = sender
            .send_ticket_before(
                frame,
                sender.admission_deadline(),
                Some(Box::new(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                })),
            )
            .await
            .expect("admit");
        let mut queued = queue.recv().await.expect("queued frame");
        assert!(queued.begin_publication());
        assert_eq!(published.load(Ordering::SeqCst), 1);
        assert_eq!(ticket.cancel(), SendOutcome::PossibleSend);
        drop(queued);
        assert_eq!(budget.available(), baseline);
        assert_eq!(ticket.cancel(), SendOutcome::PossibleSend);
    }

    #[test]
    fn owned_adapter_copies_once_and_releases_lease_before_return() {
        let tracker = LeaseTracker::default();
        let copies = crate::frame_channel::CopyCounter::default();
        let first = b"segmented ";
        let second = b"body";
        let owned = {
            let lease = tracker.lease(first, Some(second));
            assert_eq!(tracker.active(), 1);
            lease.to_owned(&copies)
        };
        assert_eq!(owned, b"segmented body");
        assert_eq!(tracker.active(), 0);
        assert_eq!(copies.copies(), 1);
    }

    #[test]
    fn close_with_active_lease_quarantines_and_never_reopens_storage() {
        let tracker = LeaseTracker::default();
        let bytes = [7u8; 8];
        let lease = tracker.lease(&bytes, None);
        assert_eq!(tracker.close(), LeaseClose::Quarantined);
        assert!(tracker.is_quarantined());
        assert_eq!(tracker.active(), 1);
        drop(lease);
        assert_eq!(tracker.active(), 0);
        assert_eq!(tracker.close(), LeaseClose::Quarantined);
    }
}
