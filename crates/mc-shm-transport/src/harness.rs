//! This module provides fuzz and corpus-replay entry points for strict byte decoders.
//!
//! Every function performs immutable byte decoding and has no file-descriptor, mapping, provider, or thread effects.

use crate::arena::{ArenaSpan, MAX_FRAME_BYTES};
use crate::backend::ring::RingGrant;
use crate::backend::sample::{SamplePrefix, SAMPLE_PREFIX_BYTES};
use crate::descriptor::{
    FrameDescriptor, Incarnation, ReleaseIdentity, MAX_SPANS, WIRE_V2_HEADER_BYTES,
};

pub const FRAME_DESCRIPTOR_BYTES: usize =
    2 + WIRE_V2_HEADER_BYTES + 16 + 4 + 8 + 8 + 8 + 8 + 1 + 32;

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(&bytes[offset..offset + 8]);
    u64::from_le_bytes(buffer)
}

///
/// Successful validation rejects descriptors whose spans exceed the arena bound.
pub fn frame_descriptor(bytes: &[u8]) -> bool {
    if bytes.len() != FRAME_DESCRIPTOR_BYTES {
        return false;
    }
    let schema = u16::from_le_bytes([bytes[0], bytes[1]]);
    let mut wire_header = [0u8; WIRE_V2_HEADER_BYTES];
    wire_header.copy_from_slice(&bytes[2..2 + WIRE_V2_HEADER_BYTES]);
    let identity_offset = 2 + WIRE_V2_HEADER_BYTES;
    let mut incarnation = [0u8; 16];
    incarnation.copy_from_slice(&bytes[identity_offset..identity_offset + 16]);
    let lane_offset = identity_offset + 16;
    let lane = u32::from_le_bytes([
        bytes[lane_offset],
        bytes[lane_offset + 1],
        bytes[lane_offset + 2],
        bytes[lane_offset + 3],
    ]);
    let sequence = read_u64(bytes, lane_offset + 4);
    let body_len = read_u64(bytes, lane_offset + 12);
    let allocation_start = read_u64(bytes, lane_offset + 20);
    let allocation_len = read_u64(bytes, lane_offset + 28);
    let span_count = bytes[lane_offset + 36];
    let spans_offset = lane_offset + 37;
    let spans = [
        ArenaSpan::from_untrusted(
            read_u64(bytes, spans_offset),
            read_u64(bytes, spans_offset + 8),
        ),
        ArenaSpan::from_untrusted(
            read_u64(bytes, spans_offset + 16),
            read_u64(bytes, spans_offset + 24),
        ),
    ];
    let identity = ReleaseIdentity::new(Incarnation::from_bytes(incarnation), lane, sequence);
    let descriptor = FrameDescriptor::from_untrusted(
        schema,
        wire_header,
        identity,
        body_len,
        allocation_start,
        allocation_len,
        span_count,
        spans,
    );

    let accepted = if let Ok(validated) = descriptor.validate(identity, MAX_FRAME_BYTES) {
        assert!(validated.body_len() <= MAX_FRAME_BYTES as u64);
        assert!((1..=MAX_SPANS as u8).contains(&validated.span_count()));
        let mut summed = 0u64;
        for index in 0..usize::from(validated.span_count()) {
            let span = validated.span(index).expect("validated span exists");
            let end = span
                .offset()
                .checked_add(span.len())
                .expect("validated span cannot overflow");
            assert!(end <= MAX_FRAME_BYTES as u64, "span crosses arena bound");
            summed = summed.checked_add(span.len()).expect("span sum overflow");
        }
        assert_eq!(summed, validated.body_len(), "spans disagree with body");
        true
    } else {
        false
    };

    // Flipping the decoded lane yields a distinct identity; validation must reject it because a fixed sentinel could match decoded input.
    let foreign = ReleaseIdentity::new(Incarnation::from_bytes(incarnation), lane ^ 1, sequence);
    assert!(
        descriptor.validate(foreign, MAX_FRAME_BYTES).is_err(),
        "foreign identity must be rejected"
    );
    accepted
}

///
pub fn provider_grant(bytes: &[u8]) -> bool {
    if let Ok(grant) = RingGrant::decode_slice(bytes) {
        assert_eq!(
            grant.encode().as_slice(),
            bytes,
            "accepted grant must round-trip byte-exactly"
        );
        true
    } else {
        false
    }
}

///
/// Successful validation yields a body range inside the allocation; bytes past the declared body remain outside the range.
pub fn provider_sample(bytes: &[u8]) -> bool {
    let Ok(prefix) = SamplePrefix::snapshot(bytes) else {
        return false;
    };
    let accepted = if let Ok(validated) = prefix.validate(bytes.len(), prefix.identity()) {
        let range = validated.body_range();
        assert_eq!(range.start, SAMPLE_PREFIX_BYTES);
        assert!(range.end >= range.start, "body range is inverted");
        assert!(
            range.end <= bytes.len(),
            "validated body range escapes the allocation"
        );
        assert_eq!(range.end - range.start, validated.body_len());
        true
    } else {
        false
    };
    // Flipping the snapshotted lane yields a distinct identity; validation must reject it because a fixed sentinel could match snapshotted input.
    let identity = prefix.identity();
    let foreign = ReleaseIdentity::new(
        identity.incarnation(),
        identity.lane() ^ 1,
        identity.sequence(),
    );
    assert!(
        prefix.validate(bytes.len(), foreign).is_err(),
        "foreign identity must be rejected"
    );
    accepted
}
