#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::time::Duration;
use std::time::Instant;

use mc_shm_transport::backend::ring::{wire_v2_header, ProducerError, Ring, RingError, RingGrant};
use mc_shm_transport::descriptor::{
    HardwareProfileId, Incarnation, ReleaseIdentity, SchedulingMode, TransportDescriptor,
};
use mc_shm_transport::lease::LeaseError;
use mc_shm_transport::profile::{
    ring_profile, CompletionMode, ProducerTopology, ProfileConfig, TargetProfile, WorkerTopology,
};
use mc_shm_transport::MAX_FRAME_BYTES;

fn profile() -> TargetProfile {
    ring_profile(
        HardwareProfileId::new("ring-contract-host").unwrap(),
        SchedulingMode::ColdParkWake,
    )
    .unwrap()
}

fn lease_limited_profile() -> TargetProfile {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            SchedulingMode::ColdParkWake,
            HardwareProfileId::new("ring-lease-limit").unwrap(),
        ),
        descriptor_depth: 2,
        arena_bytes: MAX_FRAME_BYTES,
        max_spans: 2,
        max_leases: 1,
        mappings: 2,
        pinned_workers: 0,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .unwrap()
}

fn publish(ring: &Ring, body: &[u8]) -> ReleaseIdentity {
    let mut reservation = ring
        .try_reserve(body.len(), wire_v2_header(body.len()).unwrap())
        .unwrap();
    reservation.write(body).unwrap();
    reservation.commit(body.len()).unwrap()
}

#[test]
fn boundary_round_trips_include_wrap_and_exact_maximum() {
    let ring = Ring::create(&profile(), 7).unwrap();

    let mut underfilled = ring.try_reserve(8, wire_v2_header(8).unwrap()).unwrap();
    underfilled.write(&[1, 2, 3, 4]).unwrap();
    assert_eq!(underfilled.commit(8), Err(ProducerError::Underfill));
    assert!(ring.try_receive().unwrap().is_none());

    let mut overflow = ring.try_reserve(1, wire_v2_header(1).unwrap()).unwrap();
    assert_eq!(overflow.write(&[1, 2]), Err(ProducerError::Overflow));
    assert!(ring.try_receive().unwrap().is_none());

    let mut exact = ring.try_reserve(8, wire_v2_header(4).unwrap()).unwrap();
    exact.write(&[1, 2, 3, 4]).unwrap();
    exact.commit(4).unwrap();
    assert_eq!(
        ring.try_receive().unwrap().unwrap().to_vec().unwrap(),
        [1, 2, 3, 4]
    );

    let boundaries = [
        0,
        1,
        63,
        64,
        65,
        69,
        255,
        256,
        257,
        4095,
        4096,
        4097,
        16 * 1024 - 1,
        16 * 1024,
        16 * 1024 + 1,
        64 * 1024 - 1,
        64 * 1024,
        64 * 1024 + 1,
        1024 * 1024,
        2 * 1024 * 1024 - 1,
        2 * 1024 * 1024,
        2 * 1024 * 1024 + 1,
    ];
    for len in boundaries {
        let body: Vec<u8> = (0..len).map(|index| index as u8).collect();
        publish(&ring, &body);
        let lease = ring.try_receive().unwrap().unwrap();
        assert_eq!(lease.len(), len);
        assert_eq!(lease.to_vec().unwrap(), body);
        lease.release().unwrap();
    }

    let mut reservation = ring
        .try_reserve(MAX_FRAME_BYTES, wire_v2_header(MAX_FRAME_BYTES).unwrap())
        .unwrap();
    let chunk = vec![0xa5; 1024 * 1024];
    for _ in 0..64 {
        reservation.write(&chunk).unwrap();
    }
    reservation.commit(MAX_FRAME_BYTES).unwrap();
    let lease = ring.try_receive().unwrap().unwrap();
    assert_eq!(lease.len(), MAX_FRAME_BYTES);
    assert_eq!(lease.segment(0).unwrap().read_byte(0), Some(0xa5));
    let last = lease.segment(lease.segment_count() - 1).unwrap();
    assert_eq!(last.read_byte(last.len() - 1), Some(0xa5));
    lease.release().unwrap();

    assert_eq!(
        ring.try_reserve(MAX_FRAME_BYTES + 1, [0; 21]).unwrap_err(),
        ProducerError::BoundExceedsSpans
    );
    ring.try_reserve(0, wire_v2_header(0).unwrap())
        .unwrap()
        .abort();
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert!(descriptors.conserves(32));
    assert!(bytes.conserves(MAX_FRAME_BYTES as u64));
    assert_eq!(descriptors.free, 32);
    assert_eq!(bytes.free, MAX_FRAME_BYTES as u64);
}

#[test]
fn retained_oldest_lease_enforces_fifo_reclamation_and_release_validation() {
    let ring = Ring::create(&profile(), 11).unwrap();
    let first_len = 40 * 1024 * 1024;
    let second_len = MAX_FRAME_BYTES - first_len;

    let mut first = ring
        .try_reserve(first_len, wire_v2_header(first_len).unwrap())
        .unwrap();
    let chunk = vec![1; 1024 * 1024];
    for _ in 0..40 {
        first.write(&chunk).unwrap();
    }
    let first_id = first.commit(first_len).unwrap();
    let first_lease = ring.try_receive().unwrap().unwrap();

    let mut second = ring
        .try_reserve(second_len, wire_v2_header(second_len).unwrap())
        .unwrap();
    for _ in 0..24 {
        second.write(&chunk).unwrap();
    }
    let second_id = second.commit(second_len).unwrap();
    ring.try_receive().unwrap().unwrap().release().unwrap();

    assert_eq!(
        ring.release(ReleaseIdentity::new(
            Incarnation::from_bytes([99; 16]),
            first_id.lane(),
            first_id.sequence()
        )),
        Err(LeaseError::WrongIncarnation)
    );
    assert_eq!(
        ring.release(ReleaseIdentity::new(
            first_id.incarnation(),
            first_id.lane() + 1,
            first_id.sequence()
        )),
        Err(LeaseError::WrongLane)
    );
    assert_eq!(
        ring.release(ReleaseIdentity::new(
            first_id.incarnation(),
            first_id.lane(),
            first_id.sequence() + 99
        )),
        Err(LeaseError::InvalidSequence)
    );
    assert_eq!(ring.release(second_id), Err(LeaseError::DuplicateRelease));
    assert_eq!(
        ring.try_reserve(1, wire_v2_header(1).unwrap()).unwrap_err(),
        ProducerError::Exhausted
    );
    assert_eq!(
        ring.reserve_until(1, wire_v2_header(1).unwrap(), Instant::now())
            .unwrap_err(),
        ProducerError::Deadline
    );
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.receiver_leased, 1);
    assert_eq!(descriptors.release_pending, 1);
    assert_eq!(bytes.free, 0);

    first_lease.release().unwrap();
    let mut reservation = ring.try_reserve(1, wire_v2_header(1).unwrap()).unwrap();
    reservation.write(&[9]).unwrap();
    reservation.commit(1).unwrap();
    let lease = ring.try_receive().unwrap().unwrap();
    assert_eq!(lease.segment(0).unwrap().read_byte(0), Some(9));
    lease.release().unwrap();
}

#[test]
fn stale_lap_release_cannot_complete_recycled_slot() {
    let ring = Ring::create(&profile(), 13).unwrap();
    let depth = profile().descriptor_depth();

    let stale = publish(&ring, &[1]);
    ring.try_receive().unwrap().unwrap().release().unwrap();
    for value in 2..=depth {
        publish(&ring, &[value as u8]);
        ring.try_receive().unwrap().unwrap().release().unwrap();
    }

    publish(&ring, &[0xa5]);
    let fresh = ring.try_receive().unwrap().unwrap();
    assert_eq!(
        ring.release(stale),
        Err(LeaseError::InvalidSequence),
        "stale identity must not complete recycled slot"
    );
    assert_eq!(fresh.segment(0).unwrap().read_byte(0), Some(0xa5));
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.receiver_leased, 1);
    assert_eq!(descriptors.free, depth as u64 - 1);
    assert_eq!(bytes.receiver_leased, 1);
    fresh.release().unwrap();

    ring.try_reserve(0, wire_v2_header(0).unwrap())
        .unwrap()
        .abort();
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.free, depth as u64);
    assert_eq!(bytes.free, MAX_FRAME_BYTES as u64);
}

#[test]
fn quarantine_rejects_all_operations_and_reports_conservation() {
    let ring = Ring::create(&profile(), 17).unwrap();
    let identity = publish(&ring, &[1, 2, 3]);
    ring.enter_quarantine();

    assert_eq!(
        ring.try_reserve(1, wire_v2_header(1).unwrap()).unwrap_err(),
        ProducerError::Quarantined
    );
    assert!(matches!(ring.try_receive(), Err(RingError::Quarantined)));
    assert_eq!(ring.release(identity), Err(LeaseError::Quarantined));
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.quarantined, profile().descriptor_depth() as u64);
    assert_eq!(bytes.quarantined, MAX_FRAME_BYTES as u64);
    assert!(descriptors.conserves(profile().descriptor_depth() as u64));
    assert!(bytes.conserves(MAX_FRAME_BYTES as u64));
}

#[test]
fn probe_reads_shared_state_without_consuming_a_frame() {
    let ring = Ring::create(&profile(), 27).unwrap();
    publish(&ring, &[7]);
    ring.probe().unwrap();
    // The published frame is still receivable after the probe.
    let lease = ring.try_receive().unwrap().unwrap();
    assert_eq!(lease.segment(0).unwrap().read_byte(0), Some(7));
    lease.release().unwrap();
    ring.probe().unwrap();
    ring.enter_quarantine();
    assert!(matches!(ring.probe(), Err(RingError::Quarantined)));
}

#[test]
fn lease_limit_reports_backpressure_then_recovers_after_release() {
    let ring = Ring::create(&lease_limited_profile(), 18).unwrap();
    publish(&ring, &[1]);
    publish(&ring, &[2]);

    let first = ring.try_receive().unwrap().unwrap();
    assert!(
        ring.try_receive().unwrap().is_none(),
        "full lease set must read as no-frame backpressure, not an error"
    );
    first.release().unwrap();
    let second = ring.try_receive().unwrap().unwrap();
    assert_eq!(second.segment(0).unwrap().read_byte(0), Some(2));
    second.release().unwrap();
}

#[test]
fn one_span_profile_is_rejected_at_creation() {
    let profile = TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            SchedulingMode::ColdParkWake,
            HardwareProfileId::new("ring-one-span").unwrap(),
        ),
        descriptor_depth: 2,
        arena_bytes: MAX_FRAME_BYTES,
        max_spans: 1,
        max_leases: 1,
        mappings: 2,
        pinned_workers: 0,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .unwrap();
    assert!(matches!(
        Ring::create(&profile, 20),
        Err(RingError::ProfileMismatch)
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn sealed_object_prefault_repeated_setup_and_stress_conservation() {
    for lane in 0..3 {
        let ring = Ring::create(&profile(), lane).unwrap();
        assert_eq!(ring.mapping_count(), 1);
        assert!(ring.verify_prefaulted().unwrap());
        let smaller = (ring.object_size() - 1) as libc::off_t;
        let larger = (ring.object_size() + 1) as libc::off_t;
        assert_eq!(unsafe { libc::ftruncate(ring.raw_fd(), smaller) }, -1);
        assert_eq!(unsafe { libc::ftruncate(ring.raw_fd(), larger) }, -1);
    }

    let ring = Ring::create(&profile(), 19).unwrap();
    let mut state = 0x1234_5678u64;
    for _ in 0..2_000 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let len = (state as usize % 4096) + 1;
        let body = vec![state as u8; len];
        publish(&ring, &body);
        let lease = ring.try_receive().unwrap().unwrap();
        assert_eq!(lease.len(), len);
        assert_eq!(lease.segment(0).unwrap().read_byte(0), Some(state as u8));
        lease.release().unwrap();
        ring.try_reserve(0, wire_v2_header(0).unwrap())
            .unwrap()
            .abort();
        let (descriptors, bytes) = ring.conservation().unwrap();
        assert_eq!(descriptors.free, 32);
        assert_eq!(descriptors.published, 0);
        assert_eq!(bytes.free, MAX_FRAME_BYTES as u64);
    }
    ring.try_reserve(0, wire_v2_header(0).unwrap())
        .unwrap()
        .abort();
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.free, 32);
    assert_eq!(bytes.free, MAX_FRAME_BYTES as u64);
}

#[cfg(target_os = "linux")]
fn duplicate_fd(raw: i32) -> OwnedFd {
    // SAFETY: F_DUPFD_CLOEXEC duplicates the live test descriptor.
    let duplicated = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 0) };
    assert!(duplicated >= 0);
    // SAFETY: successful fcntl returned a new owned descriptor.
    unsafe { OwnedFd::from_raw_fd(duplicated) }
}

#[cfg(target_os = "linux")]
#[test]
fn artifact_mismatch_fails_before_mapping_and_unsealed_objects_are_rejected() {
    let ring = Ring::create(&profile(), 21).unwrap();
    let base = ring.grant().encode();

    // Layout-identity and geometry mismatches fail in the pure decoder before
    // an object descriptor can reach mapping or attachment.
    let mut version = base;
    version[0..2].copy_from_slice(&1u16.to_le_bytes());
    let mut zero_depth = base;
    zero_depth[22..30].copy_from_slice(&0u64.to_le_bytes());
    let mut small_arena = base;
    small_arena[30..38].copy_from_slice(&(MAX_FRAME_BYTES as u64 - 1).to_le_bytes());
    let mut zero_leases = base;
    zero_leases[38..46].copy_from_slice(&0u64.to_le_bytes());
    let mut excess_leases = base;
    excess_leases[38..46].copy_from_slice(&u64::MAX.to_le_bytes());
    let mut depth = base;
    depth[22..30].copy_from_slice(&31u64.to_le_bytes());
    let mut arena = base;
    arena[30..38].copy_from_slice(&(MAX_FRAME_BYTES as u64 + 4096).to_le_bytes());
    let mut total = base;
    total[46..54].copy_from_slice(&(ring.object_size() as u64 + 1).to_le_bytes());
    let mut reserved = base;
    reserved[54] = 1;
    for bytes in [
        version,
        zero_depth,
        small_arena,
        zero_leases,
        excess_leases,
        depth,
        arena,
        total,
        reserved,
    ] {
        assert_eq!(RingGrant::decode(bytes), Err(RingError::InvalidGrant));
    }

    // Identity tampering passes `RingGrant::decode` but `Ring::attach` rejects it.
    let mut incarnation = base;
    incarnation[2] ^= 1;
    let mut lane = base;
    lane[18] ^= 1;
    for bytes in [incarnation, lane] {
        let grant = RingGrant::decode(bytes).unwrap();
        assert!(matches!(
            Ring::attach(
                duplicate_fd(ring.raw_fd()),
                grant,
                SchedulingMode::ColdParkWake
            ),
            Err(RingError::InvalidGrant)
        ));
    }

    let name = c"mc-shm-unsealed-test";
    // SAFETY: static name and flags are valid for memfd_create.
    let raw = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as libc::c_int
    };
    assert!(raw >= 0);
    // SAFETY: successful memfd_create returned a new owned descriptor.
    let unsealed = unsafe { OwnedFd::from_raw_fd(raw) };
    assert_eq!(
        unsafe { libc::ftruncate(unsealed.as_raw_fd(), ring.object_size() as libc::off_t) },
        0
    );
    assert_eq!(unsafe { libc::fchmod(unsealed.as_raw_fd(), 0o600) }, 0);
    assert!(matches!(
        Ring::attach(unsealed, ring.grant(), SchedulingMode::ColdParkWake),
        Err(RingError::ObjectValidationFailed)
    ));
}

#[test]
fn grant_slice_rejects_every_truncation_point_and_one_byte_suffix() {
    let encoded_len = RingGrant::encoded_len();
    let valid = {
        let ring = Ring::create(&profile(), 25).unwrap();
        ring.grant().encode()
    };
    assert!(RingGrant::decode_slice(&valid).is_ok());

    for cut in 0..encoded_len {
        assert_eq!(
            RingGrant::decode_slice(&valid[..cut]),
            Err(RingError::InvalidGrant),
            "truncation at byte {cut} must be rejected"
        );
    }
    let mut suffixed = valid.to_vec();
    suffixed.push(0);
    assert_eq!(
        RingGrant::decode_slice(&suffixed),
        Err(RingError::InvalidGrant),
        "one-byte suffix must be rejected"
    );
    assert_eq!(
        RingGrant::decode_slice(&[]),
        Err(RingError::InvalidGrant),
        "empty grant must be rejected"
    );
}

/// The fuzz corpus seed `provider_grant/valid` doubles as the golden grant
/// fixture: one exact `RingGrant::encode` output carrying the frozen
/// ring-profile geometry.
#[test]
fn golden_grant_fixture_matches_the_frozen_ring_profile_encoding() {
    const GOLDEN_GRANT_HEX: &str = "0200d489c07ee46333a5fe7901df356f6f460000000020000000000000\
                                    0000000004000000002000000000000000004000040000000000000000";
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus/provider_grant/valid");
    let bytes = std::fs::read(path).expect("golden grant fixture is readable");
    let text: String = bytes.iter().fold(String::new(), |mut text, byte| {
        use std::fmt::Write;
        write!(text, "{byte:02x}").unwrap();
        text
    });
    assert_eq!(
        text,
        GOLDEN_GRANT_HEX.replace(char::is_whitespace, ""),
        "the checked-in fixture bytes moved; update the copy of this hex in \
         packages/plugin/src/shared/mc-host-client/shm-transport-provider.test.ts too"
    );
    let grant = RingGrant::decode_slice(&bytes).expect("golden grant fixture decodes");
    assert_eq!(
        grant.encode().as_slice(),
        bytes.as_slice(),
        "golden grant fixture must round-trip byte-exactly"
    );
    let frozen = profile();
    let field =
        |range: std::ops::Range<usize>| u64::from_le_bytes(bytes[range].try_into().unwrap());
    assert_eq!(
        u16::from_le_bytes([bytes[0], bytes[1]]),
        2,
        "layout version"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[18..22].try_into().unwrap()),
        0,
        "host-to-peer lane"
    );
    assert_eq!(field(22..30), frozen.descriptor_depth() as u64);
    assert_eq!(field(30..38), frozen.arena_bytes() as u64);
    assert_eq!(field(38..46), frozen.max_leases() as u64);
}

#[cfg(target_os = "linux")]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut text, byte| {
        use std::fmt::Write;
        write!(text, "{byte:02x}").unwrap();
        text
    })
}

#[cfg(target_os = "linux")]
fn decode_hex<const N: usize>(text: &str) -> [u8; N] {
    assert_eq!(text.len(), N * 2);
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap();
    }
    bytes
}

#[cfg(target_os = "linux")]
#[test]
fn two_process_zero_copy_exchange_uses_authenticated_grant() {
    let ring = Ring::create(&profile(), 23).unwrap();
    ring.set_inheritable(true).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "ring_child_exchange", "--nocapture"])
        .env("MC_SHM_CHILD_FD", ring.raw_fd().to_string())
        .env("MC_SHM_CHILD_GRANT", hex(&ring.grant().encode()))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    ring.set_inheritable(false).unwrap();

    let mut reservation = ring
        .try_reserve(MAX_FRAME_BYTES, wire_v2_header(MAX_FRAME_BYTES).unwrap())
        .unwrap();
    let chunk = vec![7; 1024 * 1024];
    for _ in 0..64 {
        reservation.write(&chunk).unwrap();
    }
    reservation.commit(MAX_FRAME_BYTES).unwrap();

    let waiting_since = Instant::now();
    ring.reserve_until(
        1,
        wire_v2_header(1).unwrap(),
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap()
    .abort();
    assert!(waiting_since.elapsed() >= Duration::from_millis(25));

    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("MC_SHM_CHILD_EXCHANGE_OK"), "{stdout}");
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.free, profile().descriptor_depth() as u64);
    assert_eq!(bytes.free, MAX_FRAME_BYTES as u64);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "child role for two_process_zero_copy_exchange_uses_authenticated_grant"]
fn ring_child_exchange() {
    let Ok(fd) = std::env::var("MC_SHM_CHILD_FD") else {
        return;
    };
    let grant = std::env::var("MC_SHM_CHILD_GRANT").unwrap();
    let grant = RingGrant::decode(decode_hex(&grant)).unwrap();
    let fd = unsafe { OwnedFd::from_raw_fd(fd.parse().unwrap()) };
    let ring = Ring::attach(fd, grant, SchedulingMode::ColdParkWake).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(lease) = ring.try_receive().unwrap() {
            assert_eq!(lease.len(), MAX_FRAME_BYTES);
            let first = lease.segment(0).unwrap();
            assert_eq!(first.read_byte(0), Some(7));
            assert_eq!(first.read_byte(first.len() - 1), Some(7));
            std::thread::sleep(Duration::from_millis(50));
            lease.release().unwrap();
            println!("MC_SHM_CHILD_EXCHANGE_OK");
            return;
        }
        assert!(Instant::now() < deadline, "parent never published frame");
        std::thread::sleep(Duration::from_millis(1));
    }
}
