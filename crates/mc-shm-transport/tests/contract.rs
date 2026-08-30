use std::sync::Arc;

use mc_shm_transport::arena::{ArenaCounts, ArenaSpan, SpanPlan, MAX_FRAME_BYTES};
use mc_shm_transport::backend::sample::{SamplePrefix, SAMPLE_PREFIX_BYTES};
use mc_shm_transport::descriptor::{
    DescriptorCounts, DescriptorError, FrameDescriptor, HardwareProfileId, Incarnation,
    ReleaseIdentity, SchedulingMode, TransportDescriptor, DESCRIPTOR_SCHEMA_VERSION,
    WIRE_V2_HEADER_BYTES,
};
use mc_shm_transport::evidence::OperationCounters;
use mc_shm_transport::lifecycle::{CloseState, Lifecycle, LifecycleError};
use mc_shm_transport::profile::{
    ring_profile, AdmissionController, AdmissionError, HostLimits, ProfileConfig, ResourceCharges,
    TargetProfile, WorkerTopology,
};

fn header(len: usize) -> [u8; WIRE_V2_HEADER_BYTES] {
    let mut header = [0u8; WIRE_V2_HEADER_BYTES];
    header[..4].copy_from_slice(&(len as u32).to_le_bytes());
    header[4] = 2;
    header
}

fn sample_payload(
    schema: u16,
    wire_header: [u8; WIRE_V2_HEADER_BYTES],
    identity: ReleaseIdentity,
    declared_body_len: u64,
    body: &[u8],
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(SAMPLE_PREFIX_BYTES + body.len());
    payload.extend_from_slice(&schema.to_le_bytes());
    payload.extend_from_slice(&wire_header);
    payload.extend_from_slice(&identity.incarnation().into_bytes());
    payload.extend_from_slice(&identity.lane().to_le_bytes());
    payload.extend_from_slice(&identity.sequence().to_le_bytes());
    payload.extend_from_slice(&declared_body_len.to_le_bytes());
    payload.extend_from_slice(body);
    payload
}

fn identity() -> ReleaseIdentity {
    ReleaseIdentity::new(Incarnation::from_bytes([7; 16]), 3, 9)
}

fn valid_descriptor() -> FrameDescriptor {
    FrameDescriptor::from_untrusted(
        DESCRIPTOR_SCHEMA_VERSION,
        header(8),
        identity(),
        8,
        MAX_FRAME_BYTES as u64 - 4,
        8,
        2,
        [
            ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 4),
            ArenaSpan::from_untrusted(0, 4),
        ],
    )
}

#[test]
fn fixed_ring_identity_survives_profile_validation() {
    let profile = ring_profile(
        HardwareProfileId::new("fixed-ring-contract").unwrap(),
        SchedulingMode::ColdParkWake,
    )
    .unwrap();

    assert_eq!(
        profile.descriptor().schema_version(),
        DESCRIPTOR_SCHEMA_VERSION
    );
    assert_eq!(
        profile.descriptor().scheduling(),
        SchedulingMode::ColdParkWake
    );
    assert!(profile.descriptor().hardware_matches("fixed-ring-contract"));
}

#[test]
fn descriptor_rejects_every_untrusted_identity_and_span_failure() {
    assert!(valid_descriptor()
        .validate(identity(), MAX_FRAME_BYTES)
        .is_ok());

    let cases = [
        (
            FrameDescriptor::from_untrusted(
                99,
                header(8),
                identity(),
                8,
                MAX_FRAME_BYTES as u64 - 4,
                8,
                2,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 4),
                    ArenaSpan::from_untrusted(0, 4),
                ],
            ),
            DescriptorError::UnsupportedSchema,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(8),
                ReleaseIdentity::new(identity().incarnation(), identity().lane(), 0),
                8,
                MAX_FRAME_BYTES as u64 - 4,
                8,
                2,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 4),
                    ArenaSpan::from_untrusted(0, 4),
                ],
            ),
            DescriptorError::InvalidSequence,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(8),
                identity(),
                8,
                MAX_FRAME_BYTES as u64 - 3,
                8,
                2,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 4),
                    ArenaSpan::from_untrusted(0, 4),
                ],
            ),
            DescriptorError::InvalidWrapMetadata,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(8),
                identity(),
                8,
                MAX_FRAME_BYTES as u64 - 4,
                8,
                2,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 5),
                    ArenaSpan::from_untrusted(0, 3),
                ],
            ),
            DescriptorError::OutOfBounds,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(8),
                identity(),
                8,
                MAX_FRAME_BYTES as u64 - 4,
                8,
                1,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 8),
                    ArenaSpan::default(),
                ],
            ),
            DescriptorError::OutOfBounds,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(7),
                identity(),
                8,
                MAX_FRAME_BYTES as u64 - 4,
                8,
                2,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 4),
                    ArenaSpan::from_untrusted(0, 4),
                ],
            ),
            DescriptorError::WireHeaderMismatch,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(8),
                identity(),
                9,
                MAX_FRAME_BYTES as u64 - 4,
                9,
                2,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 4, 4),
                    ArenaSpan::from_untrusted(0, 4),
                ],
            ),
            DescriptorError::LengthMismatch,
        ),
        (
            FrameDescriptor::from_untrusted(
                DESCRIPTOR_SCHEMA_VERSION,
                header(0),
                identity(),
                0,
                u64::MAX,
                1,
                1,
                [
                    ArenaSpan::from_untrusted(MAX_FRAME_BYTES as u64 - 1, 0),
                    ArenaSpan::default(),
                ],
            ),
            DescriptorError::Overflow,
        ),
    ];
    for (descriptor, expected) in cases {
        assert_eq!(
            descriptor.validate(identity(), MAX_FRAME_BYTES),
            Err(expected)
        );
    }

    let wrong_incarnation = ReleaseIdentity::new(Incarnation::from_bytes([8; 16]), 3, 9);
    assert_eq!(
        valid_descriptor().validate(wrong_incarnation, MAX_FRAME_BYTES),
        Err(DescriptorError::WrongIncarnation)
    );
    let wrong_lane = ReleaseIdentity::new(identity().incarnation(), 4, 9);
    assert_eq!(
        valid_descriptor().validate(wrong_lane, MAX_FRAME_BYTES),
        Err(DescriptorError::WrongLane)
    );
    let wrong_sequence = ReleaseIdentity::new(identity().incarnation(), 3, 10);
    assert_eq!(
        valid_descriptor().validate(wrong_sequence, MAX_FRAME_BYTES),
        Err(DescriptorError::InvalidSequence)
    );
}

#[test]
fn arena_plans_wrap_and_conserves_all_states() {
    let plan = SpanPlan::reserve(
        MAX_FRAME_BYTES,
        MAX_FRAME_BYTES as u64 - 4,
        MAX_FRAME_BYTES as u64 - 4,
        8,
    )
    .unwrap();
    assert_eq!(plan.span_count(), 2);
    assert_eq!(plan.span(0).unwrap().len(), 4);
    assert_eq!(plan.span(1).unwrap().len(), 4);
    let prefix = plan.prefix(6).unwrap();
    assert_eq!(prefix.span(0).unwrap().len(), 4);
    assert_eq!(prefix.span(1).unwrap().len(), 2);

    assert!(ArenaCounts {
        free: 1,
        producer_reserved: 2,
        published: 3,
        receiver_held: 4,
        receiver_leased: 5,
        release_pending: 6,
        pad: 7,
        quarantined: 8,
    }
    .conserves(36));
    assert!(DescriptorCounts {
        free: 1,
        producer_reserved: 1,
        published: 1,
        receiver_held: 1,
        receiver_leased: 1,
        release_pending: 1,
        quarantined: 1,
    }
    .conserves(7));
}

#[test]
fn lifecycle_accepts_only_diagram_edges_and_quarantine_is_terminal() {
    assert_eq!(
        Lifecycle::new().advance(CloseState::ReleasingSamples),
        Err(LifecycleError::InvalidTransition)
    );

    let mut skipped_revoke = Lifecycle::new();
    skipped_revoke.advance(CloseState::Quiescing).unwrap();
    assert_eq!(
        skipped_revoke.advance(CloseState::RevokingJsOnEnv),
        Err(LifecycleError::InvalidTransition)
    );

    let mut late_quarantine = Lifecycle::new();
    for state in [
        CloseState::Quiescing,
        CloseState::DrainingPublished,
        CloseState::StoppingEnvScheduling,
        CloseState::RevokingJsOnEnv,
        CloseState::AsyncCleanupJoin,
    ] {
        late_quarantine.advance(state).unwrap();
    }
    assert_eq!(
        late_quarantine.advance(CloseState::Quarantined),
        Err(LifecycleError::InvalidTransition)
    );

    let mut lifecycle = Lifecycle::new();
    lifecycle.mark_prepared().unwrap();
    assert!(lifecycle.must_fail_closed());
    for state in [
        CloseState::Quiescing,
        CloseState::DrainingPublished,
        CloseState::StoppingEnvScheduling,
        CloseState::RevokingJsOnEnv,
        CloseState::AsyncCleanupJoin,
        CloseState::AwaitingRustScopes,
        CloseState::ReleasingSamples,
        CloseState::DroppingTransport,
        CloseState::Joined,
    ] {
        lifecycle.advance(state).unwrap();
    }
    assert!(lifecycle.reusable());
    assert_eq!(
        lifecycle.advance(CloseState::Open),
        Err(LifecycleError::Terminal)
    );

    let mut quarantined = Lifecycle::new();
    for state in [
        CloseState::Quiescing,
        CloseState::DrainingPublished,
        CloseState::StoppingEnvScheduling,
        CloseState::RevokingJsOnEnv,
        CloseState::Quarantined,
    ] {
        quarantined.advance(state).unwrap();
    }
    assert!(!quarantined.reusable());
    assert_eq!(
        quarantined.advance(CloseState::Joined),
        Err(LifecycleError::Terminal)
    );
}

#[test]
fn host_admission_retains_quarantined_commitments() {
    let profile = ring_profile(
        HardwareProfileId::new("contract-host").unwrap(),
        SchedulingMode::ColdParkWake,
    )
    .unwrap();
    let charges = profile.charges();
    let controller = Arc::new(AdmissionController::new(HostLimits {
        descriptors: charges.descriptors,
        arena_bytes: charges.arena_bytes,
        leases: charges.leases,
        mappings: charges.mappings,
        file_descriptors: charges.file_descriptors,
        workers: charges.workers,
        client_instances: charges.client_instances,
        pinned_workers: 0,
    }));
    let admission = controller.admit(&profile, None).unwrap();
    assert_eq!(controller.snapshot().unwrap().active, charges);
    let _quarantine = admission.quarantine().unwrap();
    assert_eq!(
        controller.snapshot().unwrap().quarantined,
        ResourceCharges {
            pinned_workers: 0,
            ..charges
        }
    );
    assert!(matches!(
        controller.admit(&profile, None),
        Err(AdmissionError::DescriptorLimit)
            | Err(AdmissionError::ArenaByteLimit)
            | Err(AdmissionError::LeaseLimit)
            | Err(AdmissionError::MappingLimit)
            | Err(AdmissionError::FileDescriptorLimit)
            | Err(AdmissionError::ClientInstanceLimit)
    ));
}

#[test]
fn exact_aggregate_capacity_admits_n_and_rejects_n_plus_one_without_charging() {
    let profile = ring_profile(
        HardwareProfileId::new("contract-capacity").unwrap(),
        SchedulingMode::ColdParkWake,
    )
    .unwrap();
    let one = profile.charges();
    let count = 3;
    let controller = Arc::new(AdmissionController::new(HostLimits {
        descriptors: one.descriptors * count,
        arena_bytes: one.arena_bytes * count,
        leases: one.leases * count,
        mappings: one.mappings * count,
        file_descriptors: one.file_descriptors * count,
        workers: one.workers * count,
        client_instances: one.client_instances * count,
        pinned_workers: one.pinned_workers * count,
    }));
    let admissions: Vec<_> = (0..count)
        .map(|_| {
            controller
                .admit(&profile, None)
                .expect("capacity admission")
        })
        .collect();
    let full = controller.snapshot().unwrap();
    assert_eq!(full.active.client_instances, count);
    assert!(matches!(
        controller.admit(&profile, None),
        Err(AdmissionError::DescriptorLimit)
            | Err(AdmissionError::ArenaByteLimit)
            | Err(AdmissionError::LeaseLimit)
            | Err(AdmissionError::MappingLimit)
            | Err(AdmissionError::FileDescriptorLimit)
            | Err(AdmissionError::WorkerLimit)
            | Err(AdmissionError::ClientInstanceLimit)
    ));
    assert_eq!(controller.snapshot().unwrap(), full);
    drop(admissions);
    let reclaimed = controller.snapshot().unwrap();
    assert_eq!(reclaimed.active, ResourceCharges::ZERO);
    assert_eq!(reclaimed.quarantined, ResourceCharges::ZERO);
}

fn span_profile(max_spans: usize) -> TargetProfile {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            SchedulingMode::ColdParkWake,
            HardwareProfileId::new("contract-spans").unwrap(),
        ),
        descriptor_depth: 8,
        arena_bytes: mc_shm_transport::MIN_ARENA_BYTES,
        max_spans,
        max_leases: 8,
        mappings: 2,
        pinned_workers: 0,
        worker_topology: WorkerTopology::CallerThread,
    })
    .unwrap()
}

#[test]
fn released_admissions_recompute_active_span_charge() {
    let wide = span_profile(2);
    let narrow = span_profile(1);
    let controller = Arc::new(AdmissionController::new(HostLimits {
        descriptors: 1024,
        arena_bytes: 1 << 30,
        leases: 1024,
        mappings: 1024,
        file_descriptors: 1024,
        workers: 1024,
        client_instances: 1024,
        pinned_workers: 0,
    }));

    // The active span charge is the maximum over live admissions: it drops
    // to the widest survivor on release and reaches zero only once every
    // admission is gone.
    let wide_admission = controller.admit(&wide, None).unwrap();
    let narrow_admission = controller.admit(&narrow, None).unwrap();
    assert_eq!(controller.snapshot().unwrap().active.spans_per_frame, 2);
    wide_admission.release();
    assert_eq!(controller.snapshot().unwrap().active.spans_per_frame, 1);
    drop(narrow_admission);
    assert_eq!(controller.snapshot().unwrap().active.spans_per_frame, 0);

    // Quarantine moves the span charge out of the active maximum too.
    let wide_admission = controller.admit(&wide, None).unwrap();
    let _quarantine = wide_admission.quarantine().unwrap();
    let snapshot = controller.snapshot().unwrap();
    assert_eq!(snapshot.active.spans_per_frame, 0);
    assert_eq!(snapshot.quarantined.spans_per_frame, 2);
}

#[test]
fn purity_gate_rejects_injected_copy_allocation_queue_and_wake() {
    let injected = OperationCounters {
        body_copies: 1,
        native_allocations: 1,
        syscalls: 1,
        park_wakes: 1,
        generic_queue_hops: 1,
        scheduler_handoffs: 1,
    };
    assert_eq!(
        injected.disqualifications(SchedulingMode::HotPinnedPoll, false),
        [
            "transport_body_copy",
            "native_transport_allocation",
            "generic_queue_hop",
            "timed_path_syscall",
            "unqualified_park_wake",
            "scheduler_handoff",
        ]
    );
    assert!(OperationCounters::default()
        .disqualifications(SchedulingMode::HotPinnedPoll, false)
        .is_empty());
}

#[test]
fn debug_and_errors_redact_every_sentinel() {
    let sentinel = "SENTINEL_descriptor_token_object_incarnation_address";
    let transport = TransportDescriptor::new(
        SchedulingMode::ColdParkWake,
        HardwareProfileId::new(sentinel).unwrap(),
    );
    let incarnation = Incarnation::from_bytes(*b"SENTINEL-SECRET!");
    let release = ReleaseIdentity::new(incarnation, 0x5345_4e54, 0x494e_454c);
    let descriptor = FrameDescriptor::from_untrusted(
        DESCRIPTOR_SCHEMA_VERSION,
        header(0),
        release,
        0,
        0,
        0,
        1,
        [ArenaSpan::default(), ArenaSpan::default()],
    );
    for formatted in [
        format!("{transport:?}"),
        format!("{incarnation:?}"),
        format!("{release:?}"),
        format!("{descriptor:?}"),
        format!("{:?}", DescriptorError::WrongIncarnation),
    ] {
        assert!(!formatted.contains("SENTINEL"));
        assert!(!formatted.contains(sentinel));
        assert!(!formatted.contains("0x"));
    }
}

fn sample_identity() -> ReleaseIdentity {
    ReleaseIdentity::new(Incarnation::from_bytes([7; 16]), 3, 9)
}

#[test]
fn sample_prefix_rejects_every_truncation_point_and_bounds_the_body() {
    let body = [1u8, 2, 3, 4];
    let payload = sample_payload(
        DESCRIPTOR_SCHEMA_VERSION,
        header(body.len()),
        sample_identity(),
        body.len() as u64,
        &body,
    );
    let validated = SamplePrefix::snapshot(&payload)
        .unwrap()
        .validate(payload.len(), sample_identity())
        .unwrap();
    assert_eq!(validated.body_range(), SAMPLE_PREFIX_BYTES..payload.len());
    assert_eq!(&payload[validated.body_range()], &body);

    for cut in 0..SAMPLE_PREFIX_BYTES {
        assert_eq!(
            SamplePrefix::snapshot(&payload[..cut]),
            Err(DescriptorError::Truncated),
            "prefix truncated at byte {cut} must be rejected"
        );
    }
    for cut in SAMPLE_PREFIX_BYTES..payload.len() {
        assert_eq!(
            SamplePrefix::snapshot(&payload[..cut])
                .unwrap()
                .validate(cut, sample_identity()),
            Err(DescriptorError::InvalidAllocation),
            "body truncated at byte {cut} must be rejected"
        );
    }

    // Documented capacity slack: extra allocation bytes are legal but stay
    // outside the validated body range.
    let mut slack = payload.clone();
    slack.extend_from_slice(&[0xEE; 7]);
    let validated = SamplePrefix::snapshot(&slack)
        .unwrap()
        .validate(slack.len(), sample_identity())
        .unwrap();
    assert_eq!(validated.body_len(), body.len());
    assert_eq!(
        validated.body_range().end,
        SAMPLE_PREFIX_BYTES + body.len(),
        "slack bytes must stay outside the validated body range"
    );
}

#[test]
fn sample_prefix_rejects_identity_schema_length_and_wire_failures() {
    let body = [9u8; 4];
    let expected = sample_identity();
    let base = |schema: u16, wire: [u8; WIRE_V2_HEADER_BYTES], id: ReleaseIdentity, len: u64| {
        sample_payload(schema, wire, id, len, &body)
    };

    let cases: [(Vec<u8>, ReleaseIdentity, DescriptorError); 8] = [
        (
            base(99, header(4), expected, 4),
            expected,
            DescriptorError::UnsupportedSchema,
        ),
        (
            base(
                DESCRIPTOR_SCHEMA_VERSION,
                header(4),
                ReleaseIdentity::new(expected.incarnation(), expected.lane(), 0),
                4,
            ),
            ReleaseIdentity::new(expected.incarnation(), expected.lane(), 0),
            DescriptorError::InvalidSequence,
        ),
        (
            base(
                DESCRIPTOR_SCHEMA_VERSION,
                header(4),
                ReleaseIdentity::new(Incarnation::from_bytes([8; 16]), expected.lane(), 9),
                4,
            ),
            expected,
            DescriptorError::WrongIncarnation,
        ),
        (
            base(
                DESCRIPTOR_SCHEMA_VERSION,
                header(4),
                ReleaseIdentity::new(expected.incarnation(), 4, 9),
                4,
            ),
            expected,
            DescriptorError::WrongLane,
        ),
        (
            base(
                DESCRIPTOR_SCHEMA_VERSION,
                header(4),
                ReleaseIdentity::new(expected.incarnation(), expected.lane(), 10),
                4,
            ),
            expected,
            DescriptorError::InvalidSequence,
        ),
        (
            base(
                DESCRIPTOR_SCHEMA_VERSION,
                header(4),
                expected,
                MAX_FRAME_BYTES as u64 + 1,
            ),
            expected,
            DescriptorError::FrameTooLarge,
        ),
        (
            base(DESCRIPTOR_SCHEMA_VERSION, header(5), expected, 4),
            expected,
            DescriptorError::WireHeaderMismatch,
        ),
        (
            {
                let mut wire = header(4);
                wire[4] = 1;
                base(DESCRIPTOR_SCHEMA_VERSION, wire, expected, 4)
            },
            expected,
            DescriptorError::WireHeaderMismatch,
        ),
    ];
    for (payload, expected_identity, error) in cases {
        assert_eq!(
            SamplePrefix::snapshot(&payload)
                .unwrap()
                .validate(payload.len(), expected_identity),
            Err(error)
        );
    }

    // An excessive declared body beyond the allocation is rejected even when
    // it stays under the frame maximum.
    let excessive = sample_payload(
        DESCRIPTOR_SCHEMA_VERSION,
        header(1024),
        expected,
        1024,
        &body,
    );
    assert_eq!(
        SamplePrefix::snapshot(&excessive)
            .unwrap()
            .validate(excessive.len(), expected),
        Err(DescriptorError::InvalidAllocation)
    );
}

#[test]
fn frame_descriptor_rejects_span_count_and_allocation_extremes() {
    let arena = MAX_FRAME_BYTES;
    let identity = identity();
    for span_count in [0u8, 3] {
        let descriptor = FrameDescriptor::from_untrusted(
            DESCRIPTOR_SCHEMA_VERSION,
            header(8),
            identity,
            8,
            0,
            8,
            span_count,
            [ArenaSpan::from_untrusted(0, 8), ArenaSpan::default()],
        );
        assert_eq!(
            descriptor.validate(identity, arena),
            Err(DescriptorError::InvalidSpanCount)
        );
    }
    let oversized_allocation = FrameDescriptor::from_untrusted(
        DESCRIPTOR_SCHEMA_VERSION,
        header(8),
        identity,
        8,
        0,
        arena as u64 + 1,
        1,
        [ArenaSpan::from_untrusted(0, 8), ArenaSpan::default()],
    );
    assert_eq!(
        oversized_allocation.validate(identity, arena),
        Err(DescriptorError::InvalidAllocation)
    );
    assert_eq!(
        valid_descriptor().validate(identity, 0),
        Err(DescriptorError::InvalidAllocation)
    );
}

#[test]
fn harness_replays_terminate_on_arbitrary_lengths() {
    use mc_shm_transport::harness;

    let lengths = [
        0usize,
        1,
        57,
        58,
        59,
        60,
        107,
        harness::FRAME_DESCRIPTOR_BYTES,
        harness::FRAME_DESCRIPTOR_BYTES + 1,
        256,
    ];
    for len in lengths {
        for fill in [0x00u8, 0xff] {
            let bytes = vec![fill; len];
            harness::frame_descriptor(&bytes);
            harness::provider_grant(&bytes);
            harness::provider_sample(&bytes);
        }
    }
}

#[test]
fn sample_errors_redact_every_sentinel() {
    // Provider-controlled bytes spell the sentinel across the wire header,
    // incarnation, and body fields.
    let sentinel = b"SENTINEL";
    let mut wire = [0u8; WIRE_V2_HEADER_BYTES];
    wire[..sentinel.len()].copy_from_slice(sentinel);
    let incarnation = Incarnation::from_bytes(*b"SENTINEL-SECRET!");
    let identity = ReleaseIdentity::new(incarnation, 0x5345_4e54, 0x494e_454c);
    let payload = sample_payload(0x4553, wire, identity, u64::MAX, b"SENTINEL-BODY");

    let prefix = SamplePrefix::snapshot(&payload).unwrap();
    let error = prefix
        .validate(payload.len(), sample_identity())
        .unwrap_err();
    for formatted in [
        format!("{prefix:?}"),
        format!("{error}"),
        format!("{error:?}"),
        format!("{:?}", DescriptorError::Truncated),
    ] {
        assert!(!formatted.contains("SENTINEL"));
        assert!(!formatted.contains("0x"));
    }
}
