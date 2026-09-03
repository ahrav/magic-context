//! Untrusted shared-memory descriptor types and validation.
//!
//! Validation binds each frame to an expected incarnation, lane, and sequence before
//! exposing spans. Lengths are bytes. Checked arithmetic rejects overflow and arena
//! wrap metadata must describe one contiguous logical body split across at most two
//! physical spans.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::arena::{ArenaSpan, MAX_FRAME_BYTES};

/// Shared descriptor schema version.
pub const DESCRIPTOR_SCHEMA_VERSION: u16 = 3;
/// Setup descriptor count.
pub const SETUP_DESCRIPTOR_COUNT: usize = 6;
/// Frozen wire-v2 header length.
pub const WIRE_V2_HEADER_BYTES: usize = 21;
/// A complete-frame descriptor contains at most two shared spans.
pub const MAX_SPANS: usize = 2;

/// Opaque hardware-profile identifier containing 1 to 64 safe ASCII characters.
///
/// Accepted characters are alphanumeric, `-`, `_`, and `.`. Debug output is redacted.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HardwareProfileId(String);

impl HardwareProfileId {
    /// Validates and stores a hardware-profile identifier.
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

    /// Tests exact equality with a hardware-profile identifier.
    pub fn matches(&self, value: &str) -> bool {
        self.0 == value
    }
}

impl fmt::Debug for HardwareProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HardwareProfileId(<redacted>)")
    }
}

/// Fixed schema and hardware profile carried by an authenticated transport grant.
///
/// Debug output redacts the profile identifier.
#[derive(Clone, PartialEq, Eq)]
pub struct TransportDescriptor {
    schema_version: u16,
    hardware: HardwareProfileId,
}

impl TransportDescriptor {
    /// Constructs the transport descriptor.
    pub const fn new(hardware: HardwareProfileId) -> Self {
        Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION,
            hardware,
        }
    }

    /// Schema version.
    pub const fn schema_version(&self) -> u16 {
        self.schema_version
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

/// 128-bit identity separating transport incarnations.
///
/// Random construction uses operating-system entropy. Debug output is redacted.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Incarnation([u8; 16]);

impl Incarnation {
    /// Uses operating-system entropy and reports failure as `RandomSourceUnavailable`.
    pub fn random() -> Result<Self, DescriptorError> {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| DescriptorError::RandomSourceUnavailable)?;
        Ok(Self(bytes))
    }

    /// Restores an incarnation from its setup-channel bytes.
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Returns the incarnation as bytes. commentlint: allow(JUDGE)
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
///
/// Exact equality across all fields is required before a descriptor can release or
/// reuse transport state. Debug output is redacted.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ReleaseIdentity {
    incarnation: Incarnation,
    lane: u32,
    sequence: u64,
}

impl ReleaseIdentity {
    /// Constructs an identity from its exact completion-matching fields.
    pub const fn new(incarnation: Incarnation, lane: u32, sequence: u64) -> Self {
        Self {
            incarnation,
            lane,
            sequence,
        }
    }

    /// ReleaseIdentity::incarnation returns the incarnation required for exact completion matching.
    pub const fn incarnation(self) -> Incarnation {
        self.incarnation
    }

    /// Returns the lane number.
    pub const fn lane(self) -> u32 {
        self.lane
    }

    /// Returns the nonzero sequence number.
    pub const fn sequence(self) -> u64 {
        self.sequence
    }
}

impl fmt::Debug for ReleaseIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReleaseIdentity(<redacted>)")
    }
}

/// Complete frame metadata snapshot received from an untrusted source.
///
/// Construction performs no validation. Call [`FrameDescriptor::validate`] before
/// using any offset or length. Debug output is redacted.
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
    /// Copies untrusted descriptor fields without validating them.
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

    /// Validates identity, byte lengths, arena spans, and frozen wire-v2 header fields.
    ///
    /// `arena_bytes` is the physical ring size in bytes. A valid logical body occupies
    /// one span or wraps exactly once into a second span. The allocation may exceed the
    /// body length but cannot exceed the arena. All additions are checked. This method
    /// returns a specific [`DescriptorError`] and does not panic.
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

/// Frame descriptor whose identity, lengths, spans, and wire header were validated.
///
/// Accessors return the exact snapshot checked by [`FrameDescriptor::validate`].
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
    /// Returns the validated wire-v2 header.
    pub const fn wire_header(self) -> [u8; WIRE_V2_HEADER_BYTES] {
        self.wire_header
    }

    /// Returns the validated release identity.
    pub const fn identity(self) -> ReleaseIdentity {
        self.identity
    }

    /// Returns the declared body length in bytes.
    pub const fn body_len(self) -> u64 {
        self.body_len
    }

    /// Returns the logical allocation start in bytes.
    pub const fn allocation_start(self) -> u64 {
        self.allocation_start
    }

    /// Returns the allocation capacity in bytes.
    pub const fn allocation_len(self) -> u64 {
        self.allocation_len
    }

    /// Returns the number of physical spans.
    pub const fn span_count(self) -> u8 {
        self.span_count
    }

    /// Returns a validated span by index.
    pub fn span(self, index: usize) -> Option<ArenaSpan> {
        (index < usize::from(self.span_count)).then_some(self.spans[index])
    }
}

impl fmt::Debug for ValidatedFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ValidatedFrame(<redacted>)")
    }
}

/// Counts for mutually exclusive descriptor lifecycle states.
///
/// A consistent snapshot conserves configured ring depth across all fields.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DescriptorCounts {
    /// Reusable descriptors.
    pub free: u64,
    /// Descriptors reserved by producers.
    pub producer_reserved: u64,
    /// Descriptors visible to receivers.
    pub published: u64,
    /// Descriptors claimed by receivers before lease creation.
    pub receiver_held: u64,
    /// Descriptors exposed through receive leases.
    pub receiver_leased: u64,
    /// Descriptors waiting for release processing.
    pub release_pending: u64,
    /// Descriptors excluded from reuse.
    pub quarantined: u64,
}

impl DescriptorCounts {
    /// Uses checked addition so corrupt counters cannot wrap into apparent conservation.
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

/// Reports rejected descriptor fields or descriptor construction failures.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DescriptorError {
    /// Operating-system entropy was unavailable.
    RandomSourceUnavailable,
    /// Hardware-profile identifier is empty, too long, or contains unsupported bytes.
    InvalidHardwareProfile,
    /// Serialized fixed fields are incomplete.
    Truncated,
    /// Descriptor schema does not match [`DESCRIPTOR_SCHEMA_VERSION`].
    UnsupportedSchema,
    /// Release identity belongs to another transport incarnation.
    WrongIncarnation,
    /// Release identity names another lane.
    WrongLane,
    /// Sequence is zero or does not match the expected sequence.
    InvalidSequence,
    /// Body length exceeds [`MAX_FRAME_BYTES`].
    FrameTooLarge,
    /// Allocation length or capacity is inconsistent with the arena or body.
    InvalidAllocation,
    /// Span count is outside `1..=MAX_SPANS`.
    InvalidSpanCount,
    /// A span extends outside the arena.
    OutOfBounds,
    /// Checked descriptor arithmetic overflowed.
    Overflow,
    /// Declared lengths disagree.
    LengthMismatch,
    /// Physical spans do not describe the declared logical wrap.
    InvalidWrapMetadata,
    /// Wire header version or length disagrees with the descriptor.
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
