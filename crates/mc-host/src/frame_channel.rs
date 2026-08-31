//! The module defines a private complete-frame channel boundary between the connection engine and a transport.
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
use std::io;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::wire::{AdmissionClass, EnvelopeHeader, FrameType};
use tokio::time::{timeout_at, Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::wire::MAX_BODY_LEN;

#[cfg(test)]
pub(crate) mod contract_tests;

/// ReadClose identifies why a generation is retired without another frame.
#[derive(Debug)]
#[allow(dead_code)]
pub enum ReadClose {
    /// CleanEof reports a clean close at a frame boundary before any byte of the next frame.
    CleanEof,
    /// Corrupt reports structural stream corruption or a read-deadline expiry.
    Corrupt(&'static str),
    /// The generation or host was cancelled while reading.
    Cancelled,
    /// A resource wait (ingress budget) outlasted its deadline: the peer
    /// and the transport are healthy, so retirement is clean backpressure,
    /// not a structural fault.
    Overloaded,
    Io(std::io::Error),
    /// RejectedDrainFailed reports failed realignment after a rejected frame.
    RejectedDrainFailed,
}

/// one place.
///
pub(crate) fn validate_inbound_header(header: EnvelopeHeader) -> Result<(), ReadClose> {
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

///
#[derive(Clone, Default)]
pub struct CopyCounter(Arc<AtomicU64>);

impl CopyCounter {
    pub fn copies(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    pub(crate) fn record_copy(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProducerError {
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

/// `ProducerReservation` writes directly into backend-owned spans and tracks its cursor.
///
/// `C` is the backend's descriptor/byte charge guard. It moves into
/// [`ProducedBody`] on success and drops immediately on constructor failure,
/// The charge guard drops on overflow, underfill, explicit abort, and ordinary drop.
/// `C` returns its charge when it drops.
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

    /// The method writes all bytes or aborts without modifying any span.
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

    /// `commit` drops the charge guard when `body_len > bound` or `cursor != body_len`.
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

    pub fn abort(mut self) {
        self.abort_on_error();
    }

    fn abort_on_error(&mut self) {
        self.aborted = true;
        drop(self.charge.take());
    }
}

/// Backends publish these segments, then drop the value to return its descriptor and byte charges once.
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

    pub fn into_charge(mut self) -> C {
        self.charge
            .take()
            .expect("a committed body always owns its charge")
    }
}

/// The `Rc` marker makes this view `!Send`.
///
/// The callback can return only values that do not borrow the leased bytes.
///
/// ```compile_fail
/// use mc_host::frame_channel::ReceiveLease;
/// fn require_send<T: Send>(_: T) {}
/// let bytes = [1u8, 2, 3];
/// require_send(ReceiveLease::contiguous(&bytes));
/// ```
///
/// ```compile_fail
/// use mc_host::frame_channel::ReceiveLease;
/// fn require_static<T: 'static>(_: T) {}
/// let bytes = [1u8, 2, 3];
/// require_static(ReceiveLease::contiguous(&bytes));
/// ```
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

    /// Each call records one body copy, including empty bodies.
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

/// A close gate prevents storage reuse while a receive lease is active.
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

/// Backends may supply two arena spans without flattening.
enum ReceiveBody {
    Contiguous(Vec<u8>),
    Segmented(Vec<u8>, Vec<u8>),
    Owned(Vec<u8>),
}

/// Body bytes are observable only through `InboundFrame::with_lease` or `InboundFrame::into_owned`.
/// `InboundFrame::into_owned` moves or copies body bytes into owned storage.
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

    pub(crate) fn owned(
        header: EnvelopeHeader,
        body: Vec<u8>,
        charge: crate::wire::ByteCharge,
        copies: CopyCounter,
    ) -> Self {
        Self {
            header,
            body: ReceiveBody::Owned(body),
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

    /// `CopyCounter` excludes copies made when an adapter flattens wrapped bodies into owned storage outside this module.
    pub(crate) fn copy_counter(&self) -> CopyCounter {
        self.copies.clone()
    }

    pub fn body_len(&self) -> usize {
        match &self.body {
            ReceiveBody::Contiguous(body) | ReceiveBody::Owned(body) => body.len(),
            ReceiveBody::Segmented(first, second) => first.len().saturating_add(second.len()),
        }
    }

    /// `with_lease` confines transport-byte decoding to a non-escaping lexical scope.
    pub fn with_lease<T>(&self, decode: impl for<'lease> FnOnce(ReceiveLease<'lease>) -> T) -> T {
        match &self.body {
            ReceiveBody::Contiguous(body) | ReceiveBody::Owned(body) => {
                decode(ReceiveLease::contiguous(body))
            }
            ReceiveBody::Segmented(first, second) => {
                decode(ReceiveLease::segmented(first, Some(second)))
            }
        }
    }

    /// Already-owned contiguous storage moves directly.
    /// `InboundFrame::into_owned` synchronously flattens segmented storage before returning.
    pub fn into_owned(self) -> OwnedInboundFrame {
        let Self {
            header,
            body,
            charge,
            copies,
        } = self;
        let body = match body {
            ReceiveBody::Contiguous(body) | ReceiveBody::Owned(body) => body,
            ReceiveBody::Segmented(first, second) => {
                ReceiveLease::segmented(&first, Some(&second)).to_owned(&copies)
            }
        };
        OwnedInboundFrame {
            header,
            body,
            charge,
        }
    }
}

/// Asynchronous handlers receive owned semantic input only.
pub struct OwnedInboundFrame {
    pub header: EnvelopeHeader,
    pub body: Vec<u8>,
    pub charge: crate::wire::ByteCharge,
}

pub struct RejectedFrame {
    pub corr: u64,
}

pub enum InboundEvent {
    Frame(InboundFrame),
    Rejected(RejectedFrame),
}

/// `FrameReceiver` receives frames from one connection's frame channel.
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

pub(crate) type DirectSerializer =
    Box<dyn FnOnce(&mut dyn io::Write) -> io::Result<()> + Send + 'static>;

pub struct DirectFrame {
    header: [u8; crate::wire::HEADER_LEN],
    body_len: usize,
    serializer: DirectSerializer,
}

impl DirectFrame {
    pub(crate) fn new(
        header: EnvelopeHeader,
        body_len: usize,
        serializer: DirectSerializer,
    ) -> Self {
        Self {
            header: header.encode(),
            body_len,
            serializer,
        }
    }

    pub(crate) const fn header(&self) -> [u8; crate::wire::HEADER_LEN] {
        self.header
    }

    pub(crate) const fn body_len(&self) -> usize {
        self.body_len
    }

    pub(crate) fn serialize(self, writer: &mut dyn io::Write) -> io::Result<()> {
        (self.serializer)(writer)
    }

    pub(crate) fn into_owned(self) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(crate::wire::HEADER_LEN + self.body_len);
        bytes.extend_from_slice(&self.header);
        {
            let mut writer = ExactWriter::new(&mut bytes, self.body_len);
            self.serialize(&mut writer)?;
            writer.finish()?;
        }
        Ok(bytes)
    }
}

pub(crate) struct ExactWriter<W> {
    inner: W,
    remaining: usize,
}

impl<W> ExactWriter<W> {
    pub(crate) const fn new(inner: W, len: usize) -> Self {
        Self {
            inner,
            remaining: len,
        }
    }

    pub(crate) fn finish(self) -> io::Result<()> {
        if self.remaining == 0 {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "direct serializer underfilled reservation",
            ))
        }
    }
}

impl<W: io::Write> io::Write for ExactWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "direct serializer exceeded reservation",
            ));
        }
        self.inner.write_all(bytes)?;
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// `OutboundFrame` queues one encoded frame for the single logical writer.
pub struct OutboundFrame {
    pub bytes: Vec<u8>,
    /// `tail` follows `bytes` when encoding avoids a prepend copy.
    pub tail: Vec<u8>,
    pub(crate) direct: Option<DirectFrame>,
    pub charge: crate::wire::ByteCharge,
    /// `written` runs after every frame byte reaches local egress.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    NotSent,
    PossibleSend,
}

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

    pub async fn send(&self, frame: OutboundFrame) -> Result<(), WriterGone> {
        self.send_before(frame, self.admission_deadline()).await
    }

    pub fn admission_deadline(&self) -> Instant {
        Instant::now() + self.admission_timeout
    }

    /// The adapter admits frames without returning cancellation tickets.
    pub async fn send_before(
        &self,
        frame: OutboundFrame,
        deadline: Instant,
    ) -> Result<(), WriterGone> {
        self.send_ticket_before(frame, deadline, None)
            .await
            .map(drop)
    }

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriterGone;

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
