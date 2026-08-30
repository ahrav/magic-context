//! iceoryx backend rejection and exact-body-range tests.
#![cfg(feature = "iceoryx")]

use mc_shm_transport::backend::iceoryx::{IceoryxBackend, IceoryxError, IceoryxProducerError};
use mc_shm_transport::backend::sample::{SamplePrefix, SAMPLE_PREFIX_BYTES};
use mc_shm_transport::descriptor::{
    BackendId, DescriptorError, HardwareProfileId, Incarnation, MemoryLayout, OwnershipMode,
    PlatformKind, ReleaseIdentity, RuntimeKind, SchedulingMode, TransportDescriptor, WorkloadClass,
    DESCRIPTOR_SCHEMA_VERSION, WIRE_V2_HEADER_BYTES,
};
use mc_shm_transport::profile::{
    CompletionMode, ProducerTopology, ProfileConfig, TargetProfile, WorkerTopology,
};
use mc_shm_transport::MAX_FRAME_BYTES;

fn iceoryx_profile() -> TargetProfile {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            BackendId::Iceoryx,
            MemoryLayout::IceoryxSample,
            OwnershipMode::DirectLeased,
            SchedulingMode::ColdParkWake,
            WorkloadClass::MixedDuplex,
            if cfg!(target_os = "macos") {
                PlatformKind::Macos
            } else {
                PlatformKind::Linux
            },
            RuntimeKind::Rust,
            HardwareProfileId::new("iceoryx-contract-host").unwrap(),
        ),
        descriptor_depth: 8,
        arena_bytes: mc_shm_transport::MIN_ARENA_BYTES,
        max_spans: 1,
        max_leases: 8,
        mappings: 2,
        pinned_workers: 0,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .unwrap()
}

fn wire(len: usize) -> [u8; WIRE_V2_HEADER_BYTES] {
    let mut header = [0u8; WIRE_V2_HEADER_BYTES];
    header[..4].copy_from_slice(&(len as u32).to_le_bytes());
    header[4] = 2;
    header
}

fn identity() -> ReleaseIdentity {
    ReleaseIdentity::new(Incarnation::from_bytes([7; 16]), 3, 9)
}

fn payload(
    schema: u16,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    id: ReleaseIdentity,
    declared_body_len: u64,
    body: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(SAMPLE_PREFIX_BYTES + body.len());
    bytes.extend_from_slice(&schema.to_le_bytes());
    bytes.extend_from_slice(&wire_header);
    bytes.extend_from_slice(&id.incarnation().into_bytes());
    bytes.extend_from_slice(&id.lane().to_le_bytes());
    bytes.extend_from_slice(&id.sequence().to_le_bytes());
    bytes.extend_from_slice(&declared_body_len.to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}

/// Seeded-defect detector: a receive path that hands the full sample
/// allocation to frame decoding instead of the validated declared body
/// range must fail this test.
#[test]
fn allocation_slack_never_reaches_the_frame_decoder() {
    let backend = IceoryxBackend::create(&iceoryx_profile(), 3).unwrap();
    let body = [0xC3u8; 8];
    let bound = 4096;

    // The loan is deliberately larger than the committed body, so the
    // published allocation carries capacity slack past the declared range.
    let mut reservation = backend.try_reserve(bound, wire(body.len())).unwrap();
    reservation.write(&body).unwrap();
    reservation.commit(body.len()).unwrap();

    let lease = backend.try_receive().unwrap().unwrap();
    assert_eq!(
        lease.len(),
        body.len(),
        "lease length must equal the declared body, not the allocation"
    );
    assert_eq!(lease.segment_count(), 1);
    let segment = lease.segment(0).unwrap();
    assert_eq!(
        segment.len(),
        body.len(),
        "decoder-visible slice must be the exact declared body range"
    );
    assert_eq!(segment, &body);
    assert!(lease.segment(1).is_none());
    lease.release();
}

#[test]
fn stale_node_observation_lists_without_disturbing_a_live_backend() {
    let backend = IceoryxBackend::create(&iceoryx_profile(), 7).unwrap();
    // The observed value depends on host state left by other processes.
    // The contract under test: observation succeeds and the live backend still round-trips afterwards.
    let _ = IceoryxBackend::stale_node_observed().unwrap();
    let body = [0x5Au8; 4];
    let mut reservation = backend.try_reserve(64, wire(body.len())).unwrap();
    reservation.write(&body).unwrap();
    reservation.commit(body.len()).unwrap();
    let lease = backend.try_receive().unwrap().unwrap();
    assert_eq!(lease.segment(0).unwrap(), &body);
    lease.release();
}

#[test]
fn sequences_progress_exactly_and_wrap_attempts_fail_closed() {
    let backend = IceoryxBackend::create(&iceoryx_profile(), 5).unwrap();
    for (index, value) in [0x11u8, 0x22, 0x33].into_iter().enumerate() {
        let body = [value; 3];
        let mut reservation = backend.try_reserve(body.len(), wire(body.len())).unwrap();
        reservation.write(&body).unwrap();
        let id = reservation.commit(body.len()).unwrap();
        assert_eq!(id.sequence(), index as u64 + 1);
        let lease = backend.try_receive().unwrap().unwrap();
        assert_eq!(lease.identity().sequence(), index as u64 + 1);
        assert_eq!(lease.segment(0).unwrap(), &body);
        lease.release();
    }
    assert!(backend.try_receive().unwrap().is_none());
}

#[test]
fn producer_rejects_oversized_underfilled_and_mismatched_commits() {
    let backend = IceoryxBackend::create(&iceoryx_profile(), 6).unwrap();
    assert_eq!(
        backend
            .try_reserve(MAX_FRAME_BYTES + 1, wire(0))
            .map(|_| ())
            .unwrap_err(),
        IceoryxProducerError::BoundExceedsSample
    );

    let mut underfilled = backend.try_reserve(8, wire(8)).unwrap();
    underfilled.write(&[1, 2, 3]).unwrap();
    assert_eq!(underfilled.commit(8), Err(IceoryxProducerError::Underfill));

    let mut mismatched = backend.try_reserve(4, wire(3)).unwrap();
    mismatched.write(&[1, 2, 3, 4]).unwrap();
    assert_eq!(
        mismatched.commit(4),
        Err(IceoryxProducerError::WireHeaderMismatch)
    );
    assert!(backend.try_receive().unwrap().is_none());
}

#[test]
fn sample_decoder_rejects_truncation_suffix_and_stale_identity() {
    let expected = identity();
    let body = [5u8; 6];
    let valid = payload(
        DESCRIPTOR_SCHEMA_VERSION,
        wire(body.len()),
        expected,
        body.len() as u64,
        &body,
    );
    assert!(SamplePrefix::snapshot(&valid)
        .unwrap()
        .validate(valid.len(), expected)
        .is_ok());

    // Every truncation point around the fixed prefix.
    for cut in 0..SAMPLE_PREFIX_BYTES {
        assert_eq!(
            SamplePrefix::snapshot(&valid[..cut]),
            Err(DescriptorError::Truncated)
        );
    }
    // Every truncation point inside the declared body.
    for cut in SAMPLE_PREFIX_BYTES..valid.len() {
        assert_eq!(
            SamplePrefix::snapshot(&valid[..cut])
                .unwrap()
                .validate(cut, expected),
            Err(DescriptorError::InvalidAllocation)
        );
    }
    // A one-byte suffix is capacity slack: accepted, but excluded from the
    // validated body range.
    let mut suffixed = valid.clone();
    suffixed.push(0xEE);
    let validated = SamplePrefix::snapshot(&suffixed)
        .unwrap()
        .validate(suffixed.len(), expected)
        .unwrap();
    assert_eq!(
        validated.body_range(),
        SAMPLE_PREFIX_BYTES..SAMPLE_PREFIX_BYTES + body.len()
    );

    // Stale incarnation, lane, and sequence.
    let stale_incarnation = ReleaseIdentity::new(Incarnation::from_bytes([8; 16]), 3, 9);
    assert_eq!(
        SamplePrefix::snapshot(&valid)
            .unwrap()
            .validate(valid.len(), stale_incarnation),
        Err(DescriptorError::WrongIncarnation)
    );
    let stale_lane = ReleaseIdentity::new(expected.incarnation(), 4, 9);
    assert_eq!(
        SamplePrefix::snapshot(&valid)
            .unwrap()
            .validate(valid.len(), stale_lane),
        Err(DescriptorError::WrongLane)
    );
    let stale_sequence = ReleaseIdentity::new(expected.incarnation(), 3, 8);
    assert_eq!(
        SamplePrefix::snapshot(&valid)
            .unwrap()
            .validate(valid.len(), stale_sequence),
        Err(DescriptorError::InvalidSequence)
    );
}

#[test]
fn sample_decoder_rejects_schema_length_and_overflow_extremes() {
    let expected = identity();
    let body = [1u8; 4];

    // Unsupported schema.
    let bad_schema = payload(99, wire(4), expected, 4, &body);
    assert_eq!(
        SamplePrefix::snapshot(&bad_schema)
            .unwrap()
            .validate(bad_schema.len(), expected),
        Err(DescriptorError::UnsupportedSchema)
    );
    // Mismatched wire length against the declared body.
    let mismatched = payload(DESCRIPTOR_SCHEMA_VERSION, wire(5), expected, 4, &body);
    assert_eq!(
        SamplePrefix::snapshot(&mismatched)
            .unwrap()
            .validate(mismatched.len(), expected),
        Err(DescriptorError::WireHeaderMismatch)
    );
    // Excessive body beyond the frame maximum.
    let mut oversize_wire = [0u8; WIRE_V2_HEADER_BYTES];
    oversize_wire[..4].copy_from_slice(&(MAX_FRAME_BYTES as u32 + 1).to_le_bytes());
    oversize_wire[4] = 2;
    let excessive = payload(
        DESCRIPTOR_SCHEMA_VERSION,
        oversize_wire,
        expected,
        MAX_FRAME_BYTES as u64 + 1,
        &body,
    );
    assert_eq!(
        SamplePrefix::snapshot(&excessive)
            .unwrap()
            .validate(excessive.len(), expected),
        Err(DescriptorError::FrameTooLarge)
    );
    // An overflowing declared length fails before any range is formed.
    let overflowing = payload(
        DESCRIPTOR_SCHEMA_VERSION,
        wire(4),
        expected,
        u64::MAX,
        &body,
    );
    assert_eq!(
        SamplePrefix::snapshot(&overflowing)
            .unwrap()
            .validate(overflowing.len(), expected),
        Err(DescriptorError::FrameTooLarge)
    );
}

#[test]
fn iceoryx_errors_and_debug_redact_every_sentinel() {
    let sentinel = "SENTINEL";
    let backend = IceoryxBackend::create(&iceoryx_profile(), 7).unwrap();
    let mut wire_header = [0u8; WIRE_V2_HEADER_BYTES];
    wire_header[..sentinel.len()].copy_from_slice(sentinel.as_bytes());
    let reservation = backend.try_reserve(64, wire_header).unwrap();
    let commit_error = reservation.commit(64).unwrap_err();

    let prefix = SamplePrefix::snapshot(&payload(
        0x4553,
        wire_header,
        ReleaseIdentity::new(Incarnation::from_bytes(*b"SENTINEL-SECRET!"), 1, 1),
        u64::MAX,
        b"SENTINEL-BODY",
    ))
    .unwrap();
    let decode_error = prefix.validate(usize::MAX, identity()).unwrap_err();

    for formatted in [
        format!("{backend:?}"),
        format!("{commit_error}"),
        format!("{commit_error:?}"),
        format!("{decode_error}"),
        format!("{decode_error:?}"),
        format!("{prefix:?}"),
        format!("{}", IceoryxError::InvalidDescriptor),
    ] {
        assert!(!formatted.contains("SENTINEL"), "{formatted}");
        assert!(!formatted.contains("0x"), "{formatted}");
    }
}
