use mc_shm_transport::arena::{ArenaCounts, ArenaSpan, SpanPlan, MAX_FRAME_BYTES};
use mc_shm_transport::descriptor::{
    BackendId, DescriptorCounts, DescriptorError, FrameDescriptor, HardwareProfileId, Incarnation,
    MemoryLayout, OwnershipMode, PlatformKind, ReleaseIdentity, RuntimeKind, SchedulingMode,
    TransportDescriptor, WorkloadClass, DESCRIPTOR_SCHEMA_VERSION, WIRE_V2_HEADER_BYTES,
};
use mc_shm_transport::lifecycle::{CloseState, Lifecycle, LifecycleError};
use mc_shm_transport::profile::{
    ring_profile, AdmissionController, AdmissionError, HostLimits, ResourceCharges,
};

fn header(len: usize) -> [u8; WIRE_V2_HEADER_BYTES] {
    let mut header = [0u8; WIRE_V2_HEADER_BYTES];
    header[..4].copy_from_slice(&(len as u32).to_le_bytes());
    header[4] = 2;
    header
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
    let controller = AdmissionController::new(HostLimits {
        descriptors: charges.descriptors,
        arena_bytes: charges.arena_bytes,
        leases: charges.leases,
        mappings: charges.mappings,
        pinned_workers: 0,
    });
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
    ));
}

#[test]
fn debug_and_errors_redact_every_sentinel() {
    let sentinel = "SENTINEL_descriptor_token_object_incarnation_address";
    let transport = TransportDescriptor::new(
        BackendId::Ring,
        MemoryLayout::TwoSpanWrap,
        OwnershipMode::DirectLeased,
        SchedulingMode::ColdParkWake,
        WorkloadClass::MixedDuplex,
        PlatformKind::Linux,
        RuntimeKind::Rust,
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
