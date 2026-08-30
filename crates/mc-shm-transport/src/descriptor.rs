use std::fmt;

use serde::{Deserialize, Serialize};

use crate::arena::{ArenaSpan, MAX_FRAME_BYTES};

/// Shared descriptor schema version.
pub const DESCRIPTOR_SCHEMA_VERSION: u16 = 1;
/// Frozen wire-v2 header length.
pub const WIRE_V2_HEADER_BYTES: usize = 21;
/// Maximum shared spans in one complete-frame descriptor.
pub const MAX_SPANS: usize = 2;

/// Worker scheduling selected before admission.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulingMode {
    /// Dedicated workers poll continuously on verified physical cores.
    HotPinnedPoll,
    /// Endpoints park and wake for cold traffic.
    ColdParkWake,
}

/// Validated opaque hardware-profile identifier.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HardwareProfileId(String);

impl HardwareProfileId {
    /// Validates one manifest-owned identifier.
    pub fn new(value: impl Into<String>) -> Result<Self, DescriptorError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(DescriptorError::InvalidHardwareProfile);
        }
        Ok(Self(value))
    }

    /// Compares identifier without exposing it through formatting.
    pub fn matches(&self, value: &str) -> bool {
        self.0 == value
    }
}

impl fmt::Debug for HardwareProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HardwareProfileId(<redacted>)")
    }
}

/// Fixed ring profile identity carried by an authenticated grant.
#[derive(Clone, PartialEq, Eq)]
pub struct TransportDescriptor {
    schema_version: u16,
    scheduling: SchedulingMode,
    hardware: HardwareProfileId,
}

impl TransportDescriptor {
    /// Constructs the current ring descriptor.
    pub const fn new(scheduling: SchedulingMode, hardware: HardwareProfileId) -> Self {
        Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION,
            scheduling,
            hardware,
        }
    }

    /// Schema version.
    pub const fn schema_version(&self) -> u16 {
        self.schema_version
    }

    /// Selected scheduling.
    pub const fn scheduling(&self) -> SchedulingMode {
        self.scheduling
    }

    /// Tests equality with expected hardware-profile identifier.
    pub fn hardware_matches(&self, expected: &str) -> bool {
        self.hardware.matches(expected)
    }
}

impl fmt::Debug for TransportDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TransportDescriptor(<redacted>)")
    }
}

/// Fresh per-candidate 128-bit identity.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Incarnation([u8; 16]);

impl Incarnation {
    /// Draws an identity from the operating-system random source.
    pub fn random() -> Result<Self, DescriptorError> {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| DescriptorError::RandomSourceUnavailable)?;
        Ok(Self(bytes))
    }

    /// Builds an identity received over an authenticated setup channel.
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Returns setup-channel representation. Never include it in diagnostics.
    pub const fn into_bytes(self) -> [u8; 16] {
        self.0
    }
}

impl fmt::Debug for Incarnation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Incarnation(<redacted>)")
    }
}

/// Completion identity qualified by incarnation, lane, and sequence.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ReleaseIdentity {
    incarnation: Incarnation,
    lane: u32,
    sequence: u64,
}

impl ReleaseIdentity {
    /// Constructs a release identity. Sequence zero is rejected during validation.
    pub const fn new(incarnation: Incarnation, lane: u32, sequence: u64) -> Self {
        Self {
            incarnation,
            lane,
            sequence,
        }
    }

    /// Incarnation used for exact completion matching.
    pub const fn incarnation(self) -> Incarnation {
        self.incarnation
    }

    /// Physical lane identifier.
    pub const fn lane(self) -> u32 {
        self.lane
    }

    /// Non-wrapping sequence within incarnation.
    pub const fn sequence(self) -> u64 {
        self.sequence
    }
}

impl fmt::Debug for ReleaseIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReleaseIdentity(<redacted>)")
    }
}

/// One untrusted complete-frame metadata snapshot.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct FrameDescriptor {
    schema_version: u16,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    body_len: u64,
    allocation_start: u64,
    allocation_len: u64,
    span_count: u8,
    spans: [ArenaSpan; MAX_SPANS],
}

impl FrameDescriptor {
    /// Builds a descriptor from one local metadata snapshot.
    #[allow(
        clippy::too_many_arguments,
        reason = "models fixed shared descriptor fields"
    )]
    pub const fn from_untrusted(
        schema_version: u16,
        wire_header: [u8; WIRE_V2_HEADER_BYTES],
        identity: ReleaseIdentity,
        body_len: u64,
        allocation_start: u64,
        allocation_len: u64,
        span_count: u8,
        spans: [ArenaSpan; MAX_SPANS],
    ) -> Self {
        Self {
            schema_version,
            wire_header,
            identity,
            body_len,
            allocation_start,
            allocation_len,
            span_count,
            spans,
        }
    }

    /// Validates snapshot against expected release identity and arena capacity.
    pub fn validate(
        self,
        expected: ReleaseIdentity,
        arena_bytes: usize,
    ) -> Result<ValidatedFrame, DescriptorError> {
        let Self {
            schema_version,
            wire_header,
            identity,
            body_len,
            allocation_start,
            allocation_len,
            span_count,
            spans,
        } = self;

        if schema_version != DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorError::UnsupportedSchema);
        }
        if identity.sequence == 0 {
            return Err(DescriptorError::InvalidSequence);
        }
        if identity.incarnation != expected.incarnation {
            return Err(DescriptorError::WrongIncarnation);
        }
        if identity.lane != expected.lane {
            return Err(DescriptorError::WrongLane);
        }
        if identity.sequence != expected.sequence {
            return Err(DescriptorError::InvalidSequence);
        }
        if body_len > MAX_FRAME_BYTES as u64 {
            return Err(DescriptorError::FrameTooLarge);
        }
        let arena_bytes = u64::try_from(arena_bytes).map_err(|_| DescriptorError::Overflow)?;
        if arena_bytes == 0 || allocation_len > arena_bytes || allocation_len < body_len {
            return Err(DescriptorError::InvalidAllocation);
        }
        allocation_start
            .checked_add(allocation_len)
            .ok_or(DescriptorError::Overflow)?;
        if !(1..=MAX_SPANS as u8).contains(&span_count) {
            return Err(DescriptorError::InvalidSpanCount);
        }
        if spans[0].offset != allocation_start % arena_bytes {
            return Err(DescriptorError::InvalidWrapMetadata);
        }

        let first_end = spans[0]
            .offset
            .checked_add(spans[0].len)
            .ok_or(DescriptorError::Overflow)?;
        if first_end > arena_bytes {
            return Err(DescriptorError::OutOfBounds);
        }
        let summed = spans[0]
            .len
            .checked_add(spans[1].len)
            .ok_or(DescriptorError::Overflow)?;
        if summed != body_len {
            return Err(DescriptorError::LengthMismatch);
        }

        match span_count {
            1 => {
                if spans[1] != ArenaSpan::default() {
                    return Err(DescriptorError::InvalidWrapMetadata);
                }
            }
            2 => {
                if spans[0].is_empty()
                    || spans[1].is_empty()
                    || first_end != arena_bytes
                    || spans[1].offset != 0
                    || spans[1].len > arena_bytes
                {
                    return Err(DescriptorError::InvalidWrapMetadata);
                }
            }
            _ => return Err(DescriptorError::InvalidSpanCount),
        }

        let declared_len = u32::from_le_bytes([
            wire_header[0],
            wire_header[1],
            wire_header[2],
            wire_header[3],
        ]);
        if u64::from(declared_len) != body_len || wire_header[4] != 2 {
            return Err(DescriptorError::WireHeaderMismatch);
        }

        Ok(ValidatedFrame {
            wire_header,
            identity,
            body_len,
            allocation_start,
            allocation_len,
            span_count,
            spans,
        })
    }
}

impl fmt::Debug for FrameDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FrameDescriptor(<redacted>)")
    }
}

/// Validated local frame metadata.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ValidatedFrame {
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    body_len: u64,
    allocation_start: u64,
    allocation_len: u64,
    span_count: u8,
    spans: [ArenaSpan; MAX_SPANS],
}

impl ValidatedFrame {
    /// Frozen wire-v2 header.
    pub const fn wire_header(self) -> [u8; WIRE_V2_HEADER_BYTES] {
        self.wire_header
    }

    /// Qualified release identity.
    pub const fn identity(self) -> ReleaseIdentity {
        self.identity
    }

    /// Exact committed body length.
    pub const fn body_len(self) -> u64 {
        self.body_len
    }

    /// Monotonic arena allocation start.
    pub const fn allocation_start(self) -> u64 {
        self.allocation_start
    }

    /// Reserved bytes reclaimed on completion.
    pub const fn allocation_len(self) -> u64 {
        self.allocation_len
    }

    /// Number of body spans.
    pub const fn span_count(self) -> u8 {
        self.span_count
    }

    /// Returns one validated body span.
    pub fn span(self, index: usize) -> Option<ArenaSpan> {
        (index < usize::from(self.span_count)).then_some(self.spans[index])
    }
}

impl fmt::Debug for ValidatedFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ValidatedFrame(<redacted>)")
    }
}

/// Descriptor-state snapshot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DescriptorCounts {
    /// Reusable descriptors.
    pub free: u64,
    /// Descriptor held by current producer reservation.
    pub producer_reserved: u64,
    /// Published descriptors not acquired by receiver.
    pub published: u64,
    /// Descriptor undergoing receiver validation.
    pub receiver_held: u64,
    /// Descriptors visible through receive leases.
    pub receiver_leased: u64,
    /// Released descriptors awaiting FIFO reclamation.
    pub release_pending: u64,
    /// Descriptors permanently withheld after quarantine.
    pub quarantined: u64,
}

impl DescriptorCounts {
    /// Checks exact descriptor conservation against configured depth.
    pub fn conserves(self, depth: u64) -> bool {
        [
            self.free,
            self.producer_reserved,
            self.published,
            self.receiver_held,
            self.receiver_leased,
            self.release_pending,
            self.quarantined,
        ]
        .into_iter()
        .try_fold(0u64, u64::checked_add)
            == Some(depth)
    }
}

/// Descriptor validation or construction failure.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DescriptorError {
    /// Operating-system random source failed.
    RandomSourceUnavailable,
    /// Hardware-profile identifier is malformed.
    InvalidHardwareProfile,
    /// Fixed structure is shorter than its declared layout.
    Truncated,
    /// Descriptor schema is unsupported.
    UnsupportedSchema,
    /// Release belongs to another incarnation.
    WrongIncarnation,
    /// Release belongs to another lane.
    WrongLane,
    /// Sequence is stale, duplicated, zero, or unexpected.
    InvalidSequence,
    /// Frame exceeds protocol maximum.
    FrameTooLarge,
    /// Arena allocation metadata is invalid.
    InvalidAllocation,
    /// Descriptor has invalid span count.
    InvalidSpanCount,
    /// Span crosses arena bounds.
    OutOfBounds,
    /// Offset or length arithmetic overflowed.
    Overflow,
    /// Body span lengths do not equal committed length.
    LengthMismatch,
    /// Wrapped-span metadata is inconsistent.
    InvalidWrapMetadata,
    /// Wire header version or declared length disagrees with descriptor.
    WireHeaderMismatch,
}

impl fmt::Debug for DescriptorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for DescriptorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::RandomSourceUnavailable => "operating-system random source unavailable",
            Self::InvalidHardwareProfile => "hardware profile identifier is invalid",
            Self::Truncated => "fixed structure is truncated",
            Self::UnsupportedSchema => "descriptor schema is unsupported",
            Self::WrongIncarnation => "release identity does not match incarnation",
            Self::WrongLane => "release identity does not match lane",
            Self::InvalidSequence => "release sequence is invalid",
            Self::FrameTooLarge => "frame exceeds protocol maximum",
            Self::InvalidAllocation => "arena allocation is invalid",
            Self::InvalidSpanCount => "descriptor span count is invalid",
            Self::OutOfBounds => "descriptor span is outside arena",
            Self::Overflow => "descriptor arithmetic overflow",
            Self::LengthMismatch => "descriptor lengths disagree",
            Self::InvalidWrapMetadata => "descriptor wrap metadata is invalid",
            Self::WireHeaderMismatch => "wire header disagrees with descriptor",
        })
    }
}

impl std::error::Error for DescriptorError {}
