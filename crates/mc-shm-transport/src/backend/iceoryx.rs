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
use crate::backend::sample::{SamplePrefix, SAMPLE_PREFIX_BYTES};
use crate::descriptor::{
    BackendId, Incarnation, MemoryLayout, ReleaseIdentity, WIRE_V2_HEADER_BYTES,
};
use crate::profile::TargetProfile;

const PREFIX_BYTES: usize = SAMPLE_PREFIX_BYTES;

const INITIAL_SLICE_HINT_BYTES: usize = 64 * 1024;

type IpcService = iceoryx2::service::ipc::Service;
type ByteFactory = PortFactory<IpcService, [u8], ()>;
type BytePublisher = Publisher<IpcService, [u8], ()>;
type ByteSubscriber = Subscriber<IpcService, [u8], ()>;
type UninitByteSample = SampleMutUninit<IpcService, [MaybeUninit<u8>], ()>;
type ByteSample = Sample<IpcService, [u8], ()>;

/// Publishes one complete frame per sample.
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
    ///
    /// allocation.
    pub fn try_receive(&self) -> Result<Option<IceoryxReceiveLease<'_>>, IceoryxError> {
        let Some(sample) = self
            .subscriber
            .receive()
            .map_err(|_| IceoryxError::ReceiveFailed)?
        else {
            return Ok(None);
        };
        let expected_sequence = self
            .next_receive
            .get()
            .checked_add(1)
            .ok_or(IceoryxError::SequenceExhausted)?;
        let expected = ReleaseIdentity::new(self.incarnation, self.lane, expected_sequence);
        let payload = sample.payload();
        let validated = SamplePrefix::snapshot(payload)
            .and_then(|prefix| prefix.validate(payload.len(), expected))
            .map_err(|_| IceoryxError::InvalidDescriptor)?;
        self.next_receive.set(expected_sequence);
        Ok(Some(IceoryxReceiveLease {
            sample,
            body_len: validated.body_len(),
            identity: validated.identity(),
            _backend: PhantomData,
            _not_send: PhantomData,
        }))
    }
    /// `stale_node_observed` reports a `NodeState::Dead` without performing cleanup or creating ports or services.
    pub fn stale_node_observed() -> Result<bool, IceoryxError> {
        let mut observed = false;
        iceoryx2::node::Node::<IpcService>::list(Config::global_config(), |state| {
            if matches!(state, iceoryx2::node::NodeState::Dead(_)) {
                observed = true;
                return CallbackProgression::Stop;
            }
            CallbackProgression::Continue
        })
        .map_err(|_| IceoryxError::SetupFailed)?;
        Ok(observed)
    }
}

impl fmt::Debug for IceoryxBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IceoryxBackend(<redacted>)")
    }
}

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
    pub const fn capacity(&self) -> usize {
        self.bound
    }

    pub const fn written(&self) -> usize {
        self.cursor
    }

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

///
/// Bytes beyond the declared body, including provider-documented capacity slack, are unreachable.
pub struct IceoryxReceiveLease<'backend> {
    sample: ByteSample,
    body_len: usize,
    identity: ReleaseIdentity,
    _backend: PhantomData<&'backend IceoryxBackend>,
    _not_send: PhantomData<Rc<()>>,
}

impl IceoryxReceiveLease<'_> {
    pub const fn len(&self) -> usize {
        self.body_len
    }

    pub const fn is_empty(&self) -> bool {
        self.body_len == 0
    }

    /// Iceoryx fragment details remain hidden behind one transport span.
    pub const fn segment_count(&self) -> usize {
        1
    }

    pub fn segment(&self, index: usize) -> Option<&[u8]> {
        (index == 0).then_some(&self.sample.payload()[PREFIX_BYTES..PREFIX_BYTES + self.body_len])
    }

    /// Ends sample scope and returns storage to iceoryx2.
    pub fn release(self) {}

    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }
}

impl fmt::Debug for IceoryxReceiveLease<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IceoryxReceiveLease(<redacted>)")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IceoryxError {
    ProfileMismatch,
    SetupFailed,
    ReceiveFailed,
    InvalidDescriptor,
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IceoryxProducerError {
    BoundExceedsSample,
    Exhausted,
    Overflow,
    CommitOutsideReservation,
    Underfill,
    Aborted,
    SequenceExhausted,
    WireHeaderMismatch,
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
