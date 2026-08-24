//! Factory-parameterized semantic contract suite for frame channels.
//!
//! Every scenario exercises only the neutral boundary — [`FrameSender`],
//! [`FrameReceiver`], shared lifecycle tokens, and byte-charge ownership —
//! through a [`ChannelFactory`], so a later provider registers by
//! instantiating [`frame_channel_contract_suite!`] with its own factory and
//! runs the identical inventory. Transport-specific behavior (TCP
//! fragmentation, deadlines, oversize drains, socket close classes) lives in
//! the adapter's own tests instead.

use std::future::Future;
use std::sync::{Arc, Mutex};

use subc_protocol::{EnvelopeHeader, Flags, FrameType};
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::frame_channel::{FrameReceiver, FrameSender, InboundEvent, OutboundFrame, ReadClose};
use crate::wire::{encode_frame, pure_header_flags, response_flags, ByteBudget, FrameId};

/// Channel dimensions a scenario controls; the factory maps them onto its
/// transport.
pub(crate) struct ContractConfig {
    pub queue_frames: usize,
    pub write_deadline: Duration,
    /// Pool backing every inbound and test-created outbound charge.
    pub budget_bytes: u64,
    /// Outbound buffering between the channel and the peer. Scenarios that
    /// need backpressure set this small so unread frames stall publication;
    /// every real transport has finite buffering to map this onto.
    pub transport_buffer_bytes: usize,
}

impl Default for ContractConfig {
    fn default() -> Self {
        Self {
            queue_frames: 8,
            write_deadline: Duration::from_secs(5),
            budget_bytes: 1 << 20,
            transport_buffer_bytes: 1 << 20,
        }
    }
}

/// One connected channel under test plus the independent peer driving the
/// far side.
pub(crate) struct Harness<C, P> {
    pub sender: FrameSender,
    pub channel: C,
    pub peer: P,
    /// The engine-side retirement root shared with the channel.
    pub generation: CancellationToken,
    /// The pool `ContractConfig::budget_bytes` created; scenarios assert
    /// charge release against it.
    pub budget: ByteBudget,
    pub io_task: tokio::task::JoinHandle<()>,
}

/// Frame-level far end of the channel under test. Implementations must
/// encode and decode independently of the channel so the suite never uses
/// the implementation to verify itself.
pub(crate) trait PeerDriver: Send {
    /// Injects one complete inbound frame toward the channel.
    fn send_frame(
        &mut self,
        ty: FrameType,
        flags: Flags,
        id: FrameId,
        body: Vec<u8>,
    ) -> impl Future<Output = ()> + Send;
    /// Yields the next complete frame the channel published, or `None` once
    /// the channel closed its outbound side.
    fn recv_frame(&mut self) -> impl Future<Output = Option<(EnvelopeHeader, Vec<u8>)>> + Send;
    /// Closes the peer cleanly at a frame boundary.
    fn close(self) -> impl Future<Output = ()> + Send;
}

/// Builds connected channels for the semantic suite. Each provider supplies
/// one factory; the scenarios themselves never change per provider.
pub(crate) trait ChannelFactory {
    type Channel: FrameReceiver;
    type Peer: PeerDriver;
    fn connect(
        &self,
        cfg: ContractConfig,
    ) -> impl Future<Output = Harness<Self::Channel, Self::Peer>> + Send;
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
        charge: crate::wire::ByteCharge::none(),
        written: None,
    }
}

/// Concurrent sends and receives both make progress, and the single logical
/// writer publishes frames in exactly their admission order — including
/// admissions interleaved across sender clones.
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
        assert_eq!(frame.body, b"in");
    }
}

/// Frame-count saturation blocks admission at the queue bound and an expired
/// admission deadline retires the generation, while a charge-free control
/// frame still admits with the byte pool fully held: reserved control
/// capacity is a frame-count grant, not a byte grant.
pub(crate) async fn saturation_holds_at_frame_bound_and_spares_control_capacity<
    F: ChannelFactory,
>(
    factory: &F,
) {
    let h = factory
        .connect(ContractConfig {
            queue_frames: 1,
            transport_buffer_bytes: 1,
            ..ContractConfig::default()
        })
        .await;
    // Hold the entire byte pool: charge-free frames must remain admissible.
    let held = h.budget.try_charge(h.budget.available()).expect("pool");
    h.sender
        .send(OutboundFrame {
            bytes: encode_frame(
                FrameType::Goodbye,
                pure_header_flags(),
                FrameId::control(0),
                &[],
            )
            .expect("header-only frame encodes"),
            tail: Vec::new(),
            charge: crate::wire::ByteCharge::none(),
            written: None,
        })
        .await
        .expect("control frame admits with the byte pool exhausted");
    h.sender.send(outbound(1, b"x")).await.expect("queued");
    let deadline = Instant::now() + Duration::from_millis(50);
    assert!(
        h.sender
            .send_before(outbound(2, b"x"), deadline)
            .await
            .is_err(),
        "a saturated frame queue must reject past the admission deadline"
    );
    assert!(
        h.generation.is_cancelled(),
        "an expired admission retires the generation"
    );
    drop(held);
}

/// Local-completion hooks run exactly once, in admission order, and fire on
/// local egress alone — before the peer has decoded anything, so completion
/// never claims peer receipt.
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
    // Wait for all three completions WITHOUT the peer reading a frame: local
    // completion must not depend on (or assert) peer consumption.
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
    // Only now does the peer consume what completion already reported.
    for corr in 1..=3u64 {
        let (header, _) = h.peer.recv_frame().await.expect("published frame");
        assert_eq!(header.corr, corr);
    }
}

/// A frame refused before admission is never published: after discard, sends
/// fail and the peer observes no frame bytes at all.
pub(crate) async fn cancellation_before_admission_leaves_the_frame_unpublished<
    F: ChannelFactory,
>(
    factory: &F,
) {
    let mut h = factory.connect(ContractConfig::default()).await;
    h.sender.discard();
    h.io_task.await.expect("transport task");
    assert!(h.sender.is_retired());
    assert!(
        h.sender.send(outbound(1, b"never")).await.is_err(),
        "a discarded channel refuses admission"
    );
    assert!(
        h.peer.recv_frame().await.is_none(),
        "an unadmitted frame must leave no bytes on the wire"
    );
}

/// Publication failure after admission retires the whole channel — shared
/// lifecycle state flips, later sends fail, and nothing is replayed.
pub(crate) async fn failure_after_publication_begins_retires_without_replay<F: ChannelFactory>(
    factory: &F,
) {
    let h = factory.connect(ContractConfig::default()).await;
    let baseline = h.budget.available();
    // The peer disappears mid-connection; the next publication fails.
    h.peer.close().await;
    let charge = h.budget.try_charge(4096).expect("charge");
    let mut frame = outbound(1, &vec![0u8; 4096]);
    frame.charge = charge;
    // Admission may succeed (the queue is healthy); publication must fail
    // and retire rather than retry.
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
    assert!(h.sender.send(outbound(2, b"late")).await.is_err());
}

/// Graceful finish publishes everything already admitted, then closes.
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

/// Discard drops queued frames outright and releases every byte charge they
/// carried.
pub(crate) async fn discard_drops_queued_frames_and_releases_charges<F: ChannelFactory>(
    factory: &F,
) {
    let h = factory
        .connect(ContractConfig {
            transport_buffer_bytes: 1,
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
    h.io_task.await.expect("transport task");
    assert!(h.sender.is_retired());
    assert_eq!(
        h.budget.available(),
        baseline,
        "discard releases every queued frame's charge"
    );
}

/// Inbound frames arrive complete with transport-owned payloads: the byte
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
    assert_eq!(frame.body.len(), 2048);
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

/// A peer close at a frame boundary is an orderly clean close, distinct from
/// every corruption class.
pub(crate) async fn clean_close_at_a_frame_boundary_is_orderly<F: ChannelFactory>(factory: &F) {
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
    h.peer.close().await;
    let err = h.channel.recv().await.err().expect("close");
    assert!(
        matches!(err, ReadClose::CleanEof),
        "a boundary close must be classified as orderly"
    );
}

/// Instantiates the full semantic inventory against one factory expression.
/// A later provider registers here with one invocation; the scenarios above
/// stay untouched.
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
        async fn contract_clean_close_at_a_frame_boundary_is_orderly() {
            $crate::frame_channel::contract_tests::clean_close_at_a_frame_boundary_is_orderly(&$factory).await;
        }
    };
}

mod tcp {
    frame_channel_contract_suite!(crate::tcp_frame_channel::TcpChannelFactory);
}
