use std::cell::Cell;
use std::fmt;
use std::marker::PhantomData;
use std::mem::MaybeUninit;
use std::rc::Rc;

use iceoryx2::port::publisher::Publisher;
use iceoryx2::port::subscriber::Subscriber;
use iceoryx2::prelude::*;
use iceoryx2::sample::Sample;
use iceoryx2::sample_mut_uninit::SampleMutUninit;
use iceoryx2::service::port_factory::publish_subscribe::PortFactory;

use crate::arena::MAX_FRAME_BYTES;
use crate::descriptor::{
    BackendId, Incarnation, MemoryLayout, ReleaseIdentity, WIRE_V2_HEADER_BYTES,
};
use crate::profile::TargetProfile;

const PREFIX_BYTES: usize = 2 + WIRE_V2_HEADER_BYTES + 16 + 4 + 8 + 8;

/// Starting data-segment slice size for the publisher. Loans larger than the
/// current slice bound trigger a PowerOfTwo segment reallocation up to
/// `MAX_FRAME_BYTES`, so this hint only sets the initial footprint.
const INITIAL_SLICE_HINT_BYTES: usize = 64 * 1024;

type IpcService = iceoryx2::service::ipc::Service;
type ByteFactory = PortFactory<IpcService, [u8], ()>;
type BytePublisher = Publisher<IpcService, [u8], ()>;
type ByteSubscriber = Subscriber<IpcService, [u8], ()>;
type UninitByteSample = SampleMutUninit<IpcService, [MaybeUninit<u8>], ()>;
type ByteSample = Sample<IpcService, [u8], ()>;

/// iceoryx2 0.9.3 candidate with one complete-frame sample per publication.
pub struct IceoryxBackend {
    _node: iceoryx2::node::Node<IpcService>,
    _factory: ByteFactory,
    publisher: BytePublisher,
    subscriber: ByteSubscriber,
    incarnation: Incarnation,
    lane: u32,
    next_publish: Cell<u64>,
    next_receive: Cell<u64>,
    _not_send: PhantomData<Rc<()>>,
}

impl IceoryxBackend {
    /// Creates bounded static-allocation publisher and subscriber endpoints.
    pub fn create(profile: &TargetProfile, lane: u32) -> Result<Self, IceoryxError> {
        if profile.descriptor().backend() != BackendId::Iceoryx
            || profile.descriptor().memory_layout() != MemoryLayout::IceoryxSample
        {
            return Err(IceoryxError::ProfileMismatch);
        }
        let incarnation = Incarnation::random().map_err(|_| IceoryxError::SetupFailed)?;
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| IceoryxError::SetupFailed)?;
        let name = random
            .iter()
            .fold(String::from("mc-shm-"), |mut text, byte| {
                use std::fmt::Write;
                let _ = write!(text, "{byte:02x}");
                text
            });
        let service_name: ServiceName = name
            .as_str()
            .try_into()
            .map_err(|_| IceoryxError::SetupFailed)?;
        let node = NodeBuilder::new()
            .create::<IpcService>()
            .map_err(|_| IceoryxError::SetupFailed)?;
        let factory = node
            .service_builder(&service_name)
            .publish_subscribe::<[u8]>()
            .max_publishers(1)
            .max_subscribers(1)
            .subscriber_max_buffer_size(profile.descriptor_depth())
            .subscriber_max_borrowed_samples(profile.max_leases())
            .enable_safe_overflow(false)
            .history_size(0)
            .open_or_create()
            .map_err(|_| IceoryxError::SetupFailed)?;
        let subscriber = factory
            .subscriber_builder()
            .buffer_size(profile.descriptor_depth())
            .create()
            .map_err(|_| IceoryxError::SetupFailed)?;
        let publisher = factory
            .publisher_builder()
            // A static reservation would commit descriptor_depth + max_leases +
            // loaned samples at the full 64 MiB frame bound (hundreds of MiB,
            // zeroed at creation), failing outright on hosts with small
            // /dev/shm. Start from a small slice hint and let the segment grow
            // geometrically on demand; PowerOfTwo bounds the number of
            // reallocations (and thus segment ids) to log2 of the frame bound,
            // unlike BestFit which reallocates per distinct size.
            .initial_max_slice_len(
                INITIAL_SLICE_HINT_BYTES
                    .checked_add(PREFIX_BYTES)
                    .ok_or(IceoryxError::SetupFailed)?,
            )
            .max_loaned_samples(1)
            .allocation_strategy(AllocationStrategy::PowerOfTwo)
            .create()
            .map_err(|_| IceoryxError::SetupFailed)?;
        Ok(Self {
            _node: node,
            _factory: factory,
            publisher,
            subscriber,
            incarnation,
            lane,
            next_publish: Cell::new(0),
            next_receive: Cell::new(0),
            _not_send: PhantomData,
        })
    }

    /// Loans exact bounded sample storage for direct body production.
    pub fn try_reserve(
        &self,
        bound: usize,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
    ) -> Result<IceoryxProducerReservation<'_>, IceoryxProducerError> {
        if bound > MAX_FRAME_BYTES {
            return Err(IceoryxProducerError::BoundExceedsSample);
        }
        let sample_len = bound
            .checked_add(PREFIX_BYTES)
            .ok_or(IceoryxProducerError::BoundExceedsSample)?;
        let sample = self
            .publisher
            .loan_slice_uninit(sample_len)
            .map_err(|_| IceoryxProducerError::Exhausted)?;
        Ok(IceoryxProducerReservation {
            backend: self,
            sample: Some(sample),
            wire_header,
            bound,
            cursor: 0,
            _not_send: PhantomData,
        })
    }

    /// Acquires one sample and hides iceoryx fragment representation.
    pub fn try_receive(&self) -> Result<Option<IceoryxReceiveLease<'_>>, IceoryxError> {
        let Some(sample) = self
            .subscriber
            .receive()
            .map_err(|_| IceoryxError::ReceiveFailed)?
        else {
            return Ok(None);
        };
        let payload = sample.payload();
        if payload.len() < PREFIX_BYTES {
            return Err(IceoryxError::InvalidDescriptor);
        }
        let mut prefix = [0u8; PREFIX_BYTES];
        prefix.copy_from_slice(&payload[..PREFIX_BYTES]);
        let schema = u16::from_le_bytes([prefix[0], prefix[1]]);
        let mut wire_header = [0u8; WIRE_V2_HEADER_BYTES];
        wire_header.copy_from_slice(&prefix[2..2 + WIRE_V2_HEADER_BYTES]);
        let identity_offset = 2 + WIRE_V2_HEADER_BYTES;
        let incarnation = Incarnation::from_bytes(
            prefix[identity_offset..identity_offset + 16]
                .try_into()
                .map_err(|_| IceoryxError::InvalidDescriptor)?,
        );
        let lane_offset = identity_offset + 16;
        let lane = u32::from_le_bytes(
            prefix[lane_offset..lane_offset + 4]
                .try_into()
                .map_err(|_| IceoryxError::InvalidDescriptor)?,
        );
        let sequence_offset = lane_offset + 4;
        let sequence = u64::from_le_bytes(
            prefix[sequence_offset..sequence_offset + 8]
                .try_into()
                .map_err(|_| IceoryxError::InvalidDescriptor)?,
        );
        let body_len_offset = sequence_offset + 8;
        let body_len = u64::from_le_bytes(
            prefix[body_len_offset..body_len_offset + 8]
                .try_into()
                .map_err(|_| IceoryxError::InvalidDescriptor)?,
        );
        let expected = self
            .next_receive
            .get()
            .checked_add(1)
            .ok_or(IceoryxError::SequenceExhausted)?;
        let declared = u32::from_le_bytes([
            wire_header[0],
            wire_header[1],
            wire_header[2],
            wire_header[3],
        ]);
        if schema != crate::descriptor::DESCRIPTOR_SCHEMA_VERSION
            || incarnation != self.incarnation
            || lane != self.lane
            || sequence != expected
            || wire_header[4] != 2
            || u64::from(declared) != body_len
            || body_len > MAX_FRAME_BYTES as u64
            || usize::try_from(body_len)
                .ok()
                .and_then(|len| len.checked_add(PREFIX_BYTES))
                .is_none_or(|frame_len| frame_len > payload.len())
        {
            return Err(IceoryxError::InvalidDescriptor);
        }
        self.next_receive.set(expected);
        Ok(Some(IceoryxReceiveLease {
            sample,
            body_len: body_len as usize,
            identity: ReleaseIdentity::new(incarnation, lane, sequence),
            _backend: PhantomData,
            _not_send: PhantomData,
        }))
    }
}

impl fmt::Debug for IceoryxBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IceoryxBackend(<redacted>)")
    }
}

/// Direct cursor-tracked iceoryx sample producer.
#[must_use = "producer reservation must be committed or dropped"]
pub struct IceoryxProducerReservation<'backend> {
    backend: &'backend IceoryxBackend,
    sample: Option<UninitByteSample>,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    bound: usize,
    cursor: usize,
    _not_send: PhantomData<Rc<()>>,
}

impl IceoryxProducerReservation<'_> {
    /// Reserved body capacity.
    pub const fn capacity(&self) -> usize {
        self.bound
    }

    /// Body bytes written.
    pub const fn written(&self) -> usize {
        self.cursor
    }

    /// Remaining body capacity.
    pub const fn remaining(&self) -> usize {
        self.bound - self.cursor
    }

    /// Writes all bytes or rejects before modifying sample on overflow.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), IceoryxProducerError> {
        let end = self
            .cursor
            .checked_add(bytes.len())
            .ok_or(IceoryxProducerError::Overflow)?;
        if end > self.bound {
            self.sample.take();
            return Err(IceoryxProducerError::Overflow);
        }
        let sample = self.sample.as_mut().ok_or(IceoryxProducerError::Aborted)?;
        for (target, byte) in sample.payload_mut()[PREFIX_BYTES + self.cursor..PREFIX_BYTES + end]
            .iter_mut()
            .zip(bytes)
        {
            target.write(*byte);
        }
        self.cursor = end;
        Ok(())
    }

    /// Publishes exact committed sample length.
    pub fn commit(mut self, body_len: usize) -> Result<ReleaseIdentity, IceoryxProducerError> {
        if body_len > self.bound {
            self.sample.take();
            return Err(IceoryxProducerError::CommitOutsideReservation);
        }
        if body_len != self.cursor {
            self.sample.take();
            return Err(IceoryxProducerError::Underfill);
        }
        let declared = u32::from_le_bytes([
            self.wire_header[0],
            self.wire_header[1],
            self.wire_header[2],
            self.wire_header[3],
        ]);
        if declared as usize != body_len || self.wire_header[4] != 2 {
            self.sample.take();
            return Err(IceoryxProducerError::WireHeaderMismatch);
        }
        let sequence = self
            .backend
            .next_publish
            .get()
            .checked_add(1)
            .ok_or(IceoryxProducerError::SequenceExhausted)?;
        let identity = ReleaseIdentity::new(self.backend.incarnation, self.backend.lane, sequence);
        let sample = self.sample.as_mut().ok_or(IceoryxProducerError::Aborted)?;
        let payload = sample.payload_mut();
        let mut prefix = [0u8; PREFIX_BYTES];
        prefix[0..2].copy_from_slice(&crate::descriptor::DESCRIPTOR_SCHEMA_VERSION.to_le_bytes());
        prefix[2..2 + WIRE_V2_HEADER_BYTES].copy_from_slice(&self.wire_header);
        let identity_offset = 2 + WIRE_V2_HEADER_BYTES;
        prefix[identity_offset..identity_offset + 16]
            .copy_from_slice(&identity.incarnation().into_bytes());
        let lane_offset = identity_offset + 16;
        prefix[lane_offset..lane_offset + 4].copy_from_slice(&identity.lane().to_le_bytes());
        let sequence_offset = lane_offset + 4;
        prefix[sequence_offset..sequence_offset + 8]
            .copy_from_slice(&identity.sequence().to_le_bytes());
        let body_len_offset = sequence_offset + 8;
        prefix[body_len_offset..body_len_offset + 8]
            .copy_from_slice(&(body_len as u64).to_le_bytes());
        for (target, byte) in payload[..PREFIX_BYTES].iter_mut().zip(prefix) {
            target.write(byte);
        }
        for target in &mut payload[PREFIX_BYTES + body_len..] {
            target.write(0);
        }
        let sample = self.sample.take().ok_or(IceoryxProducerError::Aborted)?;
        // SAFETY: prefix and exact body range cover every byte in loaned sample.
        let sample = unsafe { sample.assume_init() };
        sample
            .send()
            .map_err(|_| IceoryxProducerError::PublicationFailed)?;
        self.backend.next_publish.set(sequence);
        Ok(identity)
    }
}

impl fmt::Debug for IceoryxProducerReservation<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IceoryxProducerReservation(<redacted>)")
    }
}

/// Scoped one-span iceoryx receive sample.
pub struct IceoryxReceiveLease<'backend> {
    sample: ByteSample,
    body_len: usize,
    identity: ReleaseIdentity,
    _backend: PhantomData<&'backend IceoryxBackend>,
    _not_send: PhantomData<Rc<()>>,
}

impl IceoryxReceiveLease<'_> {
    /// Exact committed body length.
    pub const fn len(&self) -> usize {
        self.body_len
    }

    /// Whether body is empty.
    pub const fn is_empty(&self) -> bool {
        self.body_len == 0
    }

    /// Iceoryx fragment details remain hidden behind one transport span.
    pub const fn segment_count(&self) -> usize {
        1
    }

    /// Returns bounded body span.
    pub fn segment(&self, index: usize) -> Option<&[u8]> {
        (index == 0).then_some(&self.sample.payload()[PREFIX_BYTES..PREFIX_BYTES + self.body_len])
    }

    /// Ends sample scope and returns storage to iceoryx2.
    pub fn release(self) {}

    /// Qualified sample release identity.
    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }
}

impl fmt::Debug for IceoryxReceiveLease<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IceoryxReceiveLease(<redacted>)")
    }
}

/// iceoryx setup or receive failure.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IceoryxError {
    /// Target profile does not select iceoryx sample layout.
    ProfileMismatch,
    /// Bounded endpoint setup failed.
    SetupFailed,
    /// Receive mechanism failed.
    ReceiveFailed,
    /// Metadata snapshot is malformed or stale.
    InvalidDescriptor,
    /// Sequence would wrap within incarnation.
    SequenceExhausted,
}

impl fmt::Debug for IceoryxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for IceoryxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ProfileMismatch => "target profile does not match iceoryx backend",
            Self::SetupFailed => "iceoryx endpoint setup failed",
            Self::ReceiveFailed => "iceoryx receive failed",
            Self::InvalidDescriptor => "iceoryx frame descriptor is invalid",
            Self::SequenceExhausted => "iceoryx release sequence exhausted",
        })
    }
}

impl std::error::Error for IceoryxError {}

/// iceoryx direct producer failure.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IceoryxProducerError {
    /// Bound exceeds legal sample payload.
    BoundExceedsSample,
    /// Loan pool has no capacity.
    Exhausted,
    /// Cursor would cross reserved bound.
    Overflow,
    /// Commit exceeds reservation.
    CommitOutsideReservation,
    /// Exact bound was not filled.
    Underfill,
    /// Reservation no longer owns a sample.
    Aborted,
    /// Sequence would wrap within incarnation.
    SequenceExhausted,
    /// Wire header disagrees with committed body.
    WireHeaderMismatch,
    /// Sample publication failed.
    PublicationFailed,
}

impl fmt::Debug for IceoryxProducerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for IceoryxProducerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BoundExceedsSample => "producer bound exceeds legal iceoryx sample",
            Self::Exhausted => "bounded iceoryx pool is exhausted",
            Self::Overflow => "producer cursor overflow",
            Self::CommitOutsideReservation => "commit exceeds reservation",
            Self::Underfill => "producer reservation is underfilled",
            Self::Aborted => "producer reservation is aborted",
            Self::SequenceExhausted => "release sequence exhausted",
            Self::WireHeaderMismatch => "wire header disagrees with committed body",
            Self::PublicationFailed => "iceoryx publication failed",
        })
    }
}

impl std::error::Error for IceoryxProducerError {}
