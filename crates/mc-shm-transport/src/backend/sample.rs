//! Pure exact-consumption decoding of complete-frame sample metadata.
//!
//! Every field is snapshotted into bounded local immutable values before any
//! validation, and validation never returns a view outside the declared body
//! range. A provider allocation may carry documented capacity slack beyond
//! the declared body; that slack is excluded from the validated body range
//! and must never reach the wire decoder.
//!
//! Post-publication concurrent mutation of already-published payload bytes
//! by the authenticated same-user peer is a peer-contract violation (R4);
//! these decoders do not claim protection against it.

use std::ops::Range;

use crate::arena::MAX_FRAME_BYTES;
use crate::descriptor::{
    DescriptorError, Incarnation, ReleaseIdentity, DESCRIPTOR_SCHEMA_VERSION, WIRE_V2_HEADER_BYTES,
};

/// Fixed metadata prefix length before each sample body.
///
/// Layout: schema `u16` | wire-v2 header | incarnation `[u8; 16]` |
/// lane `u32` | sequence `u64` | body length `u64`, all little endian.
pub const SAMPLE_PREFIX_BYTES: usize = 2 + WIRE_V2_HEADER_BYTES + 16 + 4 + 8 + 8;

/// Bounded immutable snapshot of one untrusted sample prefix.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SamplePrefix {
    schema: u16,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    body_len: u64,
}

impl SamplePrefix {
    /// Snapshots the fixed prefix from one untrusted sample payload.
    ///
    /// Reads only the fixed prefix range and rejects truncated payloads.
    /// Bytes beyond the prefix are not inspected here; `validate` bounds
    /// the declared body against the full allocation length.
    pub fn snapshot(payload: &[u8]) -> Result<Self, DescriptorError> {
        let prefix: &[u8; SAMPLE_PREFIX_BYTES] = payload
            .get(..SAMPLE_PREFIX_BYTES)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(DescriptorError::Truncated)?;
        let schema = u16::from_le_bytes([prefix[0], prefix[1]]);
        let mut wire_header = [0u8; WIRE_V2_HEADER_BYTES];
        wire_header.copy_from_slice(&prefix[2..2 + WIRE_V2_HEADER_BYTES]);
        let identity_offset = 2 + WIRE_V2_HEADER_BYTES;
        let mut incarnation = [0u8; 16];
        incarnation.copy_from_slice(&prefix[identity_offset..identity_offset + 16]);
        let lane_offset = identity_offset + 16;
        let mut lane = [0u8; 4];
        lane.copy_from_slice(&prefix[lane_offset..lane_offset + 4]);
        let sequence_offset = lane_offset + 4;
        let mut sequence = [0u8; 8];
        sequence.copy_from_slice(&prefix[sequence_offset..sequence_offset + 8]);
        let body_len_offset = sequence_offset + 8;
        let mut body_len = [0u8; 8];
        body_len.copy_from_slice(&prefix[body_len_offset..body_len_offset + 8]);
        Ok(Self {
            schema,
            wire_header,
            identity: ReleaseIdentity::new(
                Incarnation::from_bytes(incarnation),
                u32::from_le_bytes(lane),
                u64::from_le_bytes(sequence),
            ),
            body_len: u64::from_le_bytes(body_len),
        })
    }

    /// Snapshotted release identity. Never include it in diagnostics.
    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }

    /// Validates the snapshot and returns the exact declared body range.
    ///
    /// `allocation_len` is the full sample allocation length. The declared
    /// body must fit inside it; remaining allocation bytes are documented
    /// capacity slack and stay outside the returned range.
    pub fn validate(
        &self,
        allocation_len: usize,
        expected: ReleaseIdentity,
    ) -> Result<ValidatedSample, DescriptorError> {
        if self.schema != DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorError::UnsupportedSchema);
        }
        if self.identity.sequence() == 0 {
            return Err(DescriptorError::InvalidSequence);
        }
        if self.identity.incarnation() != expected.incarnation() {
            return Err(DescriptorError::WrongIncarnation);
        }
        if self.identity.lane() != expected.lane() {
            return Err(DescriptorError::WrongLane);
        }
        if self.identity.sequence() != expected.sequence() {
            return Err(DescriptorError::InvalidSequence);
        }
        if self.body_len > MAX_FRAME_BYTES as u64 {
            return Err(DescriptorError::FrameTooLarge);
        }
        let declared = u32::from_le_bytes([
            self.wire_header[0],
            self.wire_header[1],
            self.wire_header[2],
            self.wire_header[3],
        ]);
        if u64::from(declared) != self.body_len || self.wire_header[4] != 2 {
            return Err(DescriptorError::WireHeaderMismatch);
        }
        let body_len = usize::try_from(self.body_len).map_err(|_| DescriptorError::Overflow)?;
        let body_end = SAMPLE_PREFIX_BYTES
            .checked_add(body_len)
            .ok_or(DescriptorError::Overflow)?;
        if body_end > allocation_len {
            return Err(DescriptorError::InvalidAllocation);
        }
        Ok(ValidatedSample {
            wire_header: self.wire_header,
            identity: self.identity,
            body_len,
        })
    }
}

impl std::fmt::Debug for SamplePrefix {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SamplePrefix(<redacted>)")
    }
}

/// Validated sample metadata with the exact declared body range.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ValidatedSample {
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    body_len: usize,
}

impl ValidatedSample {
    /// Frozen wire-v2 header.
    pub const fn wire_header(&self) -> [u8; WIRE_V2_HEADER_BYTES] {
        self.wire_header
    }

    /// Qualified release identity.
    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }

    /// Exact declared body length.
    pub const fn body_len(&self) -> usize {
        self.body_len
    }

    /// Exact declared body range within the allocation. Capacity slack past
    /// the end of this range must never reach the wire decoder.
    pub const fn body_range(&self) -> Range<usize> {
        SAMPLE_PREFIX_BYTES..SAMPLE_PREFIX_BYTES + self.body_len
    }
}

impl std::fmt::Debug for ValidatedSample {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ValidatedSample(<redacted>)")
    }
}
