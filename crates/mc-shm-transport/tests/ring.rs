#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd};
#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "linux")]
use std::time::Duration;
use std::time::Instant;

use mc_shm_transport::backend::ring::{wire_v2_header, ProducerError, Ring, RingGrant};
use mc_shm_transport::descriptor::{
    HardwareProfileId, Incarnation, ReleaseIdentity, SchedulingMode,
};
use mc_shm_transport::lease::LeaseError;
use mc_shm_transport::profile::ring_profile;
use mc_shm_transport::MAX_FRAME_BYTES;

fn profile() -> mc_shm_transport::profile::TargetProfile {
    ring_profile(
        HardwareProfileId::new("ring-contract-host").unwrap(),
        SchedulingMode::ColdParkWake,
    )
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
        let (descriptors, bytes) = ring.conservation().unwrap();
        assert!(descriptors.conserves(32));
        assert!(bytes.conserves(MAX_FRAME_BYTES as u64));
    }
    ring.try_reserve(0, wire_v2_header(0).unwrap())
        .unwrap()
        .abort();
    let (descriptors, bytes) = ring.conservation().unwrap();
    assert_eq!(descriptors.free, 32);
    assert_eq!(bytes.free, MAX_FRAME_BYTES as u64);
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
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "ring_child_exchange", "--nocapture"])
        .env("MC_SHM_CHILD_FD", ring.raw_fd().to_string())
        .env("MC_SHM_CHILD_GRANT", hex(&ring.grant().encode()))
        .spawn()
        .unwrap();
    ring.set_inheritable(false).unwrap();
    publish(&ring, &[1, 2, 3, 4]);
    assert!(child.wait().unwrap().success());
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
            assert_eq!(lease.len(), 4);
            assert_eq!(lease.segment(0).unwrap().checksum(), 10);
            lease.release().unwrap();
            return;
        }
        assert!(Instant::now() < deadline, "parent never published frame");
        std::thread::sleep(Duration::from_millis(1));
    }
}
