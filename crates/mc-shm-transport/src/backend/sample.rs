//! This module passes only each declared body to the wire decoder.
//!
//! `validate` returns only the declared body range.
//! Allocation capacity beyond the declared body is slack.
//! Validation excludes capacity slack from the body range.
//! Capacity slack must not reach the wire decoder.
//!
//! Payload bytes must remain unchanged after publication and through decoding.
//! Decoders do not prevent payload mutation.

use std::ops::Range;

use crate::arena::MAX_FRAME_BYTES;
use crate::descriptor::{
    DescriptorError, Incarnation, ReleaseIdentity, DESCRIPTOR_SCHEMA_VERSION, WIRE_V2_HEADER_BYTES,
};

///
pub const SAMPLE_PREFIX_BYTES: usize = 2 + WIRE_V2_HEADER_BYTES + 16 + 4 + 8 + 8;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SamplePrefix {
    schema: u16,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    body_len: u64,
}

impl SamplePrefix {
    ///
    /// `validate` checks the declared body against the full allocation length.
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

    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }

    ///
    /// `allocation_len` includes both the declared body and any capacity slack.
    /// The declared body must fit within `allocation_len`.
    /// Capacity slack stays outside the returned range.
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ValidatedSample {
    identity: ReleaseIdentity,
    body_len: usize,
}

impl ValidatedSample {
    pub const fn identity(&self) -> ReleaseIdentity {
        self.identity
    }

    /// `body_len` equals the declared body length.
    pub const fn body_len(&self) -> usize {
        self.body_len
    }

    /// `body_range` contains exactly the declared body within the allocation.
    /// Capacity slack past `body_range.end` must not reach the wire decoder.
    pub const fn body_range(&self) -> Range<usize> {
        SAMPLE_PREFIX_BYTES..SAMPLE_PREFIX_BYTES + self.body_len
    }
}

impl std::fmt::Debug for ValidatedSample {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ValidatedSample(<redacted>)")
    }
}
