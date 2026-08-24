//! Private complete-frame channel boundary between the connection engine and
//! a transport.
//!
//! The contract is directional: a cloneable [`FrameSender`] admits complete
//! outbound frames in FIFO order against one logical writer, and a
//! single-owner [`FrameReceiver`] yields complete, structurally validated
//! inbound frames. Direct producers fill bounded transport spans through a
//! cursor and commit one exact length. Receive bytes are visible only through
//! a lexical [`ReceiveLease`]; compatibility consumers must use the explicit
//! copying adapter before entering asynchronous work.

use std::future::Future;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use subc_protocol::EnvelopeHeader;
use tokio::sync::mpsc;
use tokio::time::{timeout_at, Duration, Instant};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
pub(crate) mod contract_tests;

/// Why a generation must be retired without any further frame.
#[derive(Debug)]
#[allow(dead_code)]
pub enum ReadClose {
    /// Clean close at a frame boundary before any byte of the next frame.
    CleanEof,
    /// Structural stream corruption or a read deadline expiry.
    Corrupt(&'static str),
    /// The generation or host was cancelled while reading.
    Cancelled,
    /// Transport-level I/O failure.
    Io(std::io::Error),
    /// Realignment after a rejected frame failed.
    RejectedDrainFailed,
}

/// Observable count of explicit transport-byte copies.
///
/// Direct/leased paths leave this at zero. TCP and compatibility adapters add
/// exactly one for each body they copy into owned semantic storage.
#[derive(Clone, Default)]
pub struct CopyCounter(Arc<AtomicU64>);

impl CopyCounter {
    pub fn copies(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    fn record_copy(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

/// Errors from a bounded producer reservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProducerError {
    /// Reserved spans cannot cover the requested bound.
    BoundExceedsSpans,
    /// A write would cross the checked bound.
    Overflow,
    /// Committed length is greater than the reservation.
    CommitOutsideReservation,
    /// Cursor does not equal the committed exact length.
    Underfill,
    /// An earlier error already aborted the reservation.
    Aborted,
}

/// Cursor-tracked direct producer over backend-owned spans.
///
/// `C` is the backend's descriptor/byte charge guard. It moves into
/// [`ProducedBody`] on success and drops immediately on constructor failure,
/// overflow, underfill, explicit abort, or ordinary drop. This makes charge
/// return an ownership property instead of a caller convention.
#[must_use = "producer reservations must be committed or aborted"]
pub struct ProducerReservation<'storage, C> {
    spans: &'storage mut [&'storage mut [u8]],
    bound: usize,
    cursor: usize,
    charge: Option<C>,
    aborted: bool,
}

impl<'storage, C> ProducerReservation<'storage, C> {
    pub fn new(
        spans: &'storage mut [&'storage mut [u8]],
        bound: usize,
        charge: C,
    ) -> Result<Self, ProducerError> {
        let capacity = spans
            .iter()
            .try_fold(0usize, |total, span| total.checked_add(span.len()));
        if capacity.is_none_or(|capacity| bound > capacity) {
            return Err(ProducerError::BoundExceedsSpans);
        }
        Ok(Self {
            spans,
            bound,
            cursor: 0,
            charge: Some(charge),
            aborted: false,
        })
    }

    pub fn capacity(&self) -> usize {
        self.bound
    }

    pub fn written(&self) -> usize {
        self.cursor
    }

    pub fn remaining(&self) -> usize {
        self.bound.saturating_sub(self.cursor)
    }

    /// Writes all bytes or aborts without modifying any span.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), ProducerError> {
        if self.aborted {
            return Err(ProducerError::Aborted);
        }
        let Some(end) = self.cursor.checked_add(bytes.len()) else {
            self.abort_on_error();
            return Err(ProducerError::Overflow);
        };
        if end > self.bound {
            self.abort_on_error();
            return Err(ProducerError::Overflow);
        }

        let mut source = bytes;
        let mut absolute = self.cursor;
        for span in self.spans.iter_mut() {
            if source.is_empty() {
                break;
            }
            if absolute >= span.len() {
                absolute -= span.len();
                continue;
            }
            let available = span.len() - absolute;
            let take = available.min(source.len());
            span[absolute..absolute + take].copy_from_slice(&source[..take]);
            source = &source[take..];
            absolute = 0;
        }
        debug_assert!(
            source.is_empty(),
            "validated span capacity must cover write"
        );
        self.cursor = end;
        Ok(())
    }

    /// Commits exactly `body_len` bytes. No producer view survives this
    /// consuming transition.
    pub fn commit(mut self, body_len: usize) -> Result<ProducedBody<'storage, C>, ProducerError> {
        if self.aborted {
            return Err(ProducerError::Aborted);
        }
        if body_len > self.bound {
            self.abort_on_error();
            return Err(ProducerError::CommitOutsideReservation);
        }
        if self.cursor != body_len {
            self.abort_on_error();
            return Err(ProducerError::Underfill);
        }
        Ok(ProducedBody {
            spans: std::mem::take(&mut self.spans),
            len: body_len,
            charge: self.charge.take(),
        })
    }

    /// Explicitly returns the reservation and all attached charges.
    pub fn abort(mut self) {
        self.abort_on_error();
    }

    fn abort_on_error(&mut self) {
        self.aborted = true;
        drop(self.charge.take());
    }
}

/// Exact committed producer body. Backends publish from these segments, then
/// drop the value to return its descriptor and byte charges once.
#[must_use = "a committed body must be published or discarded"]
pub struct ProducedBody<'storage, C> {
    spans: &'storage mut [&'storage mut [u8]],
    len: usize,
    charge: Option<C>,
}

impl<C> ProducedBody<'_, C> {
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn segment_count(&self) -> usize {
        let mut remaining = self.len;
        let mut count = 0;
        for span in self.spans.iter() {
            if remaining == 0 {
                break;
            }
            if span.is_empty() {
                continue;
            }
            count += 1;
            remaining = remaining.saturating_sub(span.len());
        }
        count
    }

    pub fn segment(&self, index: usize) -> Option<&[u8]> {
        let mut remaining = self.len;
        for (current, span) in self
            .spans
            .iter()
            .filter(|span| !span.is_empty())
            .enumerate()
        {
            if remaining == 0 {
                break;
            }
            let take = remaining.min(span.len());
            if current == index {
                return Some(&span[..take]);
            }
            remaining -= take;
        }
        None
    }

    /// Releases storage and returns the backend charge guard to its owner.
    pub fn into_charge(mut self) -> C {
        self.charge
            .take()
            .expect("a committed body always owns its charge")
    }
}

/// Segmented transport-byte view whose lifetime is lexical and which is
/// deliberately `!Send` through its `Rc` marker.
///
/// The type borrows both spans, so it is also non-`'static`. Only values
/// decoded from the bytes may leave the synchronous scope.
pub struct ReceiveLease<'lease> {
    first: &'lease [u8],
    second: Option<&'lease [u8]>,
    tracker: Option<LeaseTracker>,
    _not_send: PhantomData<Rc<()>>,
}

impl<'lease> ReceiveLease<'lease> {
    pub fn contiguous(bytes: &'lease [u8]) -> Self {
        Self::segmented(bytes, None)
    }

    pub fn segmented(first: &'lease [u8], second: Option<&'lease [u8]>) -> Self {
        Self {
            first,
            second,
            tracker: None,
            _not_send: PhantomData,
        }
    }

    fn tracked(first: &'lease [u8], second: Option<&'lease [u8]>, tracker: LeaseTracker) -> Self {
        tracker.acquire();
        Self {
            first,
            second,
            tracker: Some(tracker),
            _not_send: PhantomData,
        }
    }

    pub fn len(&self) -> usize {
        self.first
            .len()
            .saturating_add(self.second.map_or(0, <[u8]>::len))
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn segment_count(&self) -> usize {
        usize::from(!self.first.is_empty())
            + usize::from(self.second.is_some_and(|s| !s.is_empty()))
    }

    pub fn segment(&self, index: usize) -> Option<&[u8]> {
        match (index, self.first.is_empty()) {
            (0, false) => Some(self.first),
            (0, true) => self.second.filter(|segment| !segment.is_empty()),
            (1, false) => self.second.filter(|segment| !segment.is_empty()),
            _ => None,
        }
    }

    pub fn contiguous_bytes(&self) -> Option<&[u8]> {
        self.second.is_none().then_some(self.first)
    }

    /// Explicit compatibility adapter. One call records one body copy even
    /// when the body is empty.
    pub fn to_owned(&self, counter: &CopyCounter) -> Vec<u8> {
        let mut body = Vec::with_capacity(self.len());
        body.extend_from_slice(self.first);
        if let Some(second) = self.second {
            body.extend_from_slice(second);
        }
        counter.record_copy();
        body
    }
}

impl Drop for ReceiveLease<'_> {
    fn drop(&mut self) {
        if let Some(tracker) = self.tracker.take() {
            tracker.release();
        }
    }
}

#[derive(Default)]
struct LeaseState {
    active: usize,
    quarantined: bool,
}

/// Testable close gate used by transport implementations to prevent reuse
/// while a receive lease is active.
#[derive(Clone, Default)]
pub struct LeaseTracker(Arc<Mutex<LeaseState>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseClose {
    Drained,
    Quarantined,
}

impl LeaseTracker {
    pub fn lease<'lease>(
        &self,
        first: &'lease [u8],
        second: Option<&'lease [u8]>,
    ) -> ReceiveLease<'lease> {
        ReceiveLease::tracked(first, second, self.clone())
    }

    /// Close never reports reusable storage while any lexical lease is live.
    /// U1 has no backend wait primitive, so active storage takes the allowed
    /// bounded-quarantine branch.
    pub fn close(&self) -> LeaseClose {
        let mut state = self.0.lock().expect("lease tracker lock");
        if state.active == 0 && !state.quarantined {
            LeaseClose::Drained
        } else {
            state.quarantined = true;
            LeaseClose::Quarantined
        }
    }

    pub fn active(&self) -> usize {
        self.0.lock().expect("lease tracker lock").active
    }

    pub fn is_quarantined(&self) -> bool {
        self.0.lock().expect("lease tracker lock").quarantined
    }

    fn acquire(&self) {
        self.0.lock().expect("lease tracker lock").active += 1;
    }

    fn release(&self) {
        let mut state = self.0.lock().expect("lease tracker lock");
        state.active = state.active.saturating_sub(1);
    }
}

/// Transport-owned body storage. The current TCP adapter is contiguous;
/// candidate backends may supply two arena spans without flattening.
enum ReceiveBody {
    Contiguous(Vec<u8>),
    Segmented(Vec<u8>, Vec<u8>),
}

/// One admitted inbound frame. Body bytes can only be observed through
/// [`InboundFrame::with_lease`] or copied through [`InboundFrame::into_owned`].
pub struct InboundFrame {
    pub header: EnvelopeHeader,
    body: ReceiveBody,
    charge: crate::wire::ByteCharge,
    copies: CopyCounter,
}

impl InboundFrame {
    pub(crate) fn contiguous(
        header: EnvelopeHeader,
        body: Vec<u8>,
        charge: crate::wire::ByteCharge,
        copies: CopyCounter,
    ) -> Self {
        Self {
            header,
            body: ReceiveBody::Contiguous(body),
            charge,
            copies,
        }
    }

    #[allow(dead_code, reason = "shared-memory backends supply wrapped bodies")]
    pub(crate) fn segmented(
        header: EnvelopeHeader,
        first: Vec<u8>,
        second: Vec<u8>,
        charge: crate::wire::ByteCharge,
        copies: CopyCounter,
    ) -> Self {
        Self {
            header,
            body: ReceiveBody::Segmented(first, second),
            charge,
            copies,
        }
    }

    #[cfg(test)]
    pub(crate) fn copy_counter(&self) -> CopyCounter {
        self.copies.clone()
    }

    pub fn body_len(&self) -> usize {
        match &self.body {
            ReceiveBody::Contiguous(body) => body.len(),
            ReceiveBody::Segmented(first, second) => first.len().saturating_add(second.len()),
        }
    }

    /// Runs transport-byte decoding inside a non-escaping lexical scope.
    pub fn with_lease<T>(&self, decode: impl for<'lease> FnOnce(ReceiveLease<'lease>) -> T) -> T {
        match &self.body {
            ReceiveBody::Contiguous(body) => decode(ReceiveLease::contiguous(body)),
            ReceiveBody::Segmented(first, second) => {
                decode(ReceiveLease::segmented(first, Some(second)))
            }
        }
    }

    /// TCP/compatibility adapter. Copy completes synchronously, then this
    /// method drops transport storage before returning owned semantic bytes.
    pub fn into_owned(self) -> OwnedInboundFrame {
        let body = self.with_lease(|lease| lease.to_owned(&self.copies));
        let Self {
            header,
            charge,
            copies: _,
            body: transport_body,
        } = self;
        drop(transport_body);
        OwnedInboundFrame {
            header,
            body,
            charge,
        }
    }
}

/// Owned semantic input allowed to enter asynchronous handler work.
pub struct OwnedInboundFrame {
    pub header: EnvelopeHeader,
    pub body: Vec<u8>,
    pub charge: crate::wire::ByteCharge,
}

/// Bounded rejected-frame event.
pub struct RejectedFrame {
    pub corr: u64,
}

pub enum InboundEvent {
    Frame(InboundFrame),
    Rejected(RejectedFrame),
}

/// Receive side of one connection's frame channel.
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

/// One encoded frame queued for the single logical writer.
pub struct OutboundFrame {
    pub bytes: Vec<u8>,
    /// Body bytes written after `bytes` when encoding avoided a prepend copy.
    pub tail: Vec<u8>,
    pub charge: crate::wire::ByteCharge,
    /// Local-completion hook, run after every frame byte reaches local egress.
    pub written: Option<Box<dyn FnOnce(Instant) + Send>>,
}

const QUEUED: u8 = 0;
const CANCELLED: u8 = 1;
const PUBLISHED: u8 = 2;
pub(crate) const COMPLETE: u8 = 3;

pub(crate) struct QueuedOutboundFrame {
    pub(crate) frame: OutboundFrame,
    pub(crate) state: Arc<AtomicU8>,
    on_publish: Option<Box<dyn FnOnce() + Send>>,
}

impl QueuedOutboundFrame {
    pub(crate) fn begin_publication(&mut self) -> bool {
        if self
            .state
            .compare_exchange(QUEUED, PUBLISHED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        if let Some(on_publish) = self.on_publish.take() {
            on_publish();
        }
        true
    }
}

/// Cancellation classification at the irreversible publication boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    NotSent,
    PossibleSend,
}

/// Ticket for one admitted complete frame.
#[derive(Clone)]
pub struct FrameSendTicket {
    state: Arc<AtomicU8>,
}

impl FrameSendTicket {
    pub fn cancel(&self) -> SendOutcome {
        match self
            .state
            .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => SendOutcome::NotSent,
            Err(_) => SendOutcome::PossibleSend,
        }
    }
}

/// Sender half of one connection's frame channel.
#[derive(Clone)]
pub struct FrameSender {
    tx: mpsc::Sender<QueuedOutboundFrame>,
    retired: CancellationToken,
    generation: CancellationToken,
    discard: CancellationToken,
    finish: CancellationToken,
    admission_timeout: Duration,
}

impl FrameSender {
    pub fn finish(&self) {
        self.finish.cancel();
    }

    pub fn discard(&self) {
        self.discard.cancel();
    }

    /// Legacy admission adapter for callers that do not need a ticket.
    pub async fn send(&self, frame: OutboundFrame) -> Result<(), WriterGone> {
        self.send_before(frame, self.admission_deadline()).await
    }

    pub fn admission_deadline(&self) -> Instant {
        Instant::now() + self.admission_timeout
    }

    /// Legacy admission adapter for callers that do not need a ticket.
    pub async fn send_before(
        &self,
        frame: OutboundFrame,
        deadline: Instant,
    ) -> Result<(), WriterGone> {
        self.send_ticket_before(frame, deadline, None)
            .await
            .map(drop)
    }

    /// Admits a complete frame and returns a cancellation ticket. `on_publish`
    /// runs exactly once immediately before transport publication begins.
    pub async fn send_ticket_before(
        &self,
        frame: OutboundFrame,
        deadline: Instant,
        on_publish: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<FrameSendTicket, WriterGone> {
        let state = Arc::new(AtomicU8::new(QUEUED));
        let queued = QueuedOutboundFrame {
            frame,
            state: Arc::clone(&state),
            on_publish,
        };
        tokio::select! {
            biased;
            () = self.retired.cancelled() => Err(WriterGone),
            sent = timeout_at(deadline, self.tx.send(queued)) => match sent {
                Ok(sent) => sent
                    .map(|()| FrameSendTicket { state })
                    .map_err(|_| WriterGone),
                Err(_) => {
                    self.retired.cancel();
                    self.generation.cancel();
                    Err(WriterGone)
                }
            },
        }
    }

    pub fn is_retired(&self) -> bool {
        self.retired.is_cancelled()
    }
}

/// The single logical writer is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriterGone;

/// Queue and lifecycle state handed to a transport drain task.
pub(crate) struct SenderQueue {
    rx: mpsc::Receiver<QueuedOutboundFrame>,
    pub retired: CancellationToken,
    pub generation: CancellationToken,
    pub discard: CancellationToken,
    pub finish: CancellationToken,
}

impl SenderQueue {
    pub(crate) async fn recv(&mut self) -> Option<QueuedOutboundFrame> {
        self.rx.recv().await
    }

    pub(crate) fn try_recv(&mut self) -> Result<QueuedOutboundFrame, mpsc::error::TryRecvError> {
        self.rx.try_recv()
    }
}

/// Creates a bounded sender and its transport-owned drain queue.
pub(crate) fn frame_sender(
    queue_frames: usize,
    generation: CancellationToken,
    admission_timeout: Duration,
) -> (FrameSender, SenderQueue) {
    let (tx, rx) = mpsc::channel::<QueuedOutboundFrame>(queue_frames);
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
