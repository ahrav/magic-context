//! Private complete-frame channel boundary between the connection engine and
//! a transport.
//!
//! The contract is directional: a cloneable [`FrameSender`] admits complete
//! outbound frames in FIFO order against one logical writer, and a
//! single-owner [`FrameReceiver`] yields complete, structurally validated
//! inbound frames. Payload ownership crosses the boundary with the frames
//! themselves — every body travels with the [`crate::wire::ByteCharge`] that
//! accounts for it, and the transport holds an outbound charge until the
//! bytes leave host memory (or forever drops it with the frame on discard).
//!
//! Shared lifecycle state (retirement, finish, discard, the generation root)
//! is carried by cancellation tokens cloned between the sender handles and
//! the transport's drain task, so either side observing failure retires the
//! other without a registry or mutable indirection. Role, correlation,
//! route, and terminal semantics stay above this boundary in the generation
//! engine; stream mechanics (framing, deadlines, drains, socket close) stay
//! below it in the transport.

use std::future::Future;

use subc_protocol::EnvelopeHeader;
use tokio::sync::mpsc;
use tokio::time::{timeout_at, Duration, Instant};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
pub(crate) mod contract_tests;

/// Why a generation must be retired without any further frame.
///
/// The engine branches only on the variant; the payloads are diagnostic
/// detail that tests assert on to pin which rule fired.
#[derive(Debug)]
#[allow(dead_code)]
pub enum ReadClose {
    /// Clean close at a frame boundary before any byte of the next frame:
    /// orderly close.
    CleanEof,
    /// Structural stream corruption or a read deadline expiry.
    Corrupt(&'static str),
    /// The generation or host was cancelled while reading.
    Cancelled,
    /// Transport-level I/O failure.
    Io(std::io::Error),
    /// The transport-owned realignment after a [`RejectedFrame`] event
    /// failed. The close is otherwise silent, but the engine's already
    /// queued authoritative terminal for the rejected correlation must still
    /// flush (protocol §7.1).
    RejectedDrainFailed,
}

/// One admitted inbound frame with its resident-byte charge. The charge
/// travels with the body: dropping the frame releases its bytes.
pub struct InboundFrame {
    pub header: EnvelopeHeader,
    pub body: Vec<u8>,
    pub charge: crate::wire::ByteCharge,
}

/// A frame the transport rejected structurally while preserving (or still
/// restoring) stream alignment, reported as a bounded event so raw reads
/// never cross the boundary.
///
/// The sole producer is an oversized channel-0 control declaration
/// (protocol §7.1): the header alone proves the violation, no body is ever
/// buffered, and the engine owes the correlation one early authoritative
/// `invalid_control_request` terminal. The transport drains the declared
/// body before yielding the next event; a failed drain surfaces as
/// [`ReadClose::RejectedDrainFailed`].
pub struct RejectedFrame {
    pub corr: u64,
}

pub enum InboundEvent {
    Frame(InboundFrame),
    Rejected(RejectedFrame),
}

/// Receive side of one connection's frame channel: single-owner, yielding
/// complete inbound frames and bounded rejected-frame events.
///
/// Waiting for the next event on an idle channel is unbounded; any per-frame
/// deadline (for TCP: absolute from the first received header byte) is owned
/// by the transport behind this boundary (protocol §6.3).
pub(crate) trait FrameReceiver: Send {
    fn recv(&mut self) -> impl Future<Output = Result<InboundEvent, ReadClose>> + Send;
}

pub(crate) trait DynFrameReceiver: Send {
    fn recv_dyn(
        &mut self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<InboundEvent, ReadClose>> + Send + '_>>;
}

impl<T: FrameReceiver> DynFrameReceiver for T {
    fn recv_dyn(
        &mut self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<InboundEvent, ReadClose>> + Send + '_>> {
        Box::pin(self.recv())
    }
}

pub(crate) struct BoxedReceiver(Box<dyn DynFrameReceiver>);

impl BoxedReceiver {
    pub(crate) fn new<T: FrameReceiver + 'static>(receiver: T) -> Self {
        Self(Box::new(receiver))
    }
}

impl FrameReceiver for BoxedReceiver {
    fn recv(&mut self) -> impl Future<Output = Result<InboundEvent, ReadClose>> + Send {
        self.0.recv_dyn()
    }
}

/// One encoded frame queued for the single logical writer, carrying its
/// resident-byte charge until the bytes leave host memory.
pub struct OutboundFrame {
    pub bytes: Vec<u8>,
    /// Body bytes written after `bytes` when the encode path skipped the
    /// header-prepend copy. Empty for fully encoded frames.
    pub tail: Vec<u8>,
    pub charge: crate::wire::ByteCharge,
    /// Local-completion hook: the transport runs it once the frame's bytes
    /// have fully reached local egress (for TCP: `write_all` returned),
    /// passing that instant — captured before the hook takes any lock, so
    /// receivers can compare a peer's answer against write COMPLETION rather
    /// than against lock ordering. Local completion never claims peer
    /// receipt. Senders that anchor state on delivery (Ping/Pong liveness)
    /// pass a hook; a channel that retires before publishing the frame
    /// drops the hook without running it.
    pub written: Option<Box<dyn FnOnce(Instant) + Send>>,
}

/// Sender half of one connection's frame channel: cloneable, admitting
/// complete outbound frames in FIFO order against bounded frame capacity.
#[derive(Clone)]
pub struct FrameSender {
    tx: mpsc::Sender<OutboundFrame>,
    retired: CancellationToken,
    generation: CancellationToken,
    discard: CancellationToken,
    finish: CancellationToken,
    admission_timeout: Duration,
}

impl FrameSender {
    /// Stops the channel after flushing what is already queued. Needed
    /// because a handler that retains a `RequestCtx` keeps an
    /// `Arc<GenerationCore>` — and therefore a sender clone — alive forever,
    /// so the transport's queue would never report closed and its drain task
    /// would outlive the connection until the shutdown deadline. Unlike
    /// `discard`, queued frames (drain terminals, Goodbye) are still
    /// published.
    pub fn finish(&self) {
        self.finish.cancel();
    }

    /// Retires the channel AND drops every queued frame. Peer-initiated and
    /// error retirement must close silently (protocol §6.3): cancelling
    /// producers stops new frames, but responses already queued would still
    /// flush to the peer without this. Graceful host shutdown never calls
    /// it — drain terminals and Goodbye must flush.
    pub fn discard(&self) {
        self.discard.cancel();
    }

    /// Queues one encoded frame. Waits for queue capacity, bounded by channel
    /// retirement; `Err` means the generation can no longer emit frames.
    pub async fn send(&self, frame: OutboundFrame) -> Result<(), WriterGone> {
        self.send_before(frame, self.admission_deadline()).await
    }

    pub fn admission_deadline(&self) -> Instant {
        Instant::now() + self.admission_timeout
    }

    /// Queues a frame under an existing operation deadline. Expiry retires the
    /// generation so no later output can overtake the failed admission.
    pub async fn send_before(
        &self,
        frame: OutboundFrame,
        deadline: Instant,
    ) -> Result<(), WriterGone> {
        tokio::select! {
            biased;
            () = self.retired.cancelled() => Err(WriterGone),
            sent = timeout_at(deadline, self.tx.send(frame)) => match sent {
                Ok(sent) => sent.map_err(|_| WriterGone),
                Err(_) => {
                    self.retired.cancel();
                    self.generation.cancel();
                    Err(WriterGone)
                }
            },
        }
    }

    /// True once the channel's write side has failed or shut down.
    pub fn is_retired(&self) -> bool {
        self.retired.is_cancelled()
    }
}

/// The single logical writer is gone: nothing sent through it can publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriterGone;

/// Queue and shared lifecycle state handed to a transport's drain task.
///
/// The drain contract: consume `rx` frames strictly in order, publish every
/// byte of one frame before any byte of the next, run each frame's `written`
/// hook at local completion, and on failure cancel `retired` AND
/// `generation` before exiting. `discard` aborts immediately, dropping
/// queued frames and their charges; `finish` flushes what is queued and then
/// exits without waiting for inert sender clones.
pub(crate) struct SenderQueue {
    pub rx: mpsc::Receiver<OutboundFrame>,
    pub retired: CancellationToken,
    pub generation: CancellationToken,
    pub discard: CancellationToken,
    pub finish: CancellationToken,
}

/// Creates the sender half of a frame channel plus the [`SenderQueue`] a
/// transport drains. `generation` is the engine's retirement root: the
/// transport cancels it when publication fails after admission.
pub(crate) fn frame_sender(
    queue_frames: usize,
    generation: CancellationToken,
    admission_timeout: Duration,
) -> (FrameSender, SenderQueue) {
    let (tx, rx) = mpsc::channel::<OutboundFrame>(queue_frames);
    let retired = CancellationToken::new();
    let discard = CancellationToken::new();
    let finish = CancellationToken::new();
    let sender = FrameSender {
        tx,
        retired: retired.clone(),
        generation: generation.clone(),
        discard: discard.clone(),
        finish: finish.clone(),
        admission_timeout,
    };
    let queue = SenderQueue {
        rx,
        retired,
        generation,
        discard,
        finish,
    };
    (sender, queue)
}
