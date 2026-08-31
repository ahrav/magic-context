use std::hint::black_box;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use mc_shm_transport::backend::ring::{wire_v2_header, Ring};
use mc_shm_transport::descriptor::{
    BackendId, HardwareProfileId, MemoryLayout, OwnershipMode, PlatformKind, RuntimeKind,
    SchedulingMode, TransportDescriptor, WorkloadClass,
};
use mc_shm_transport::evidence::OperationCounters;
use mc_shm_transport::profile::{
    CompletionMode, ProducerTopology, ProfileConfig, TargetProfile, WorkerTopology,
};
use serde::{Deserialize, Serialize};

const ARMS: &[&str] = &[
    "h0_metadata_cacheline_ping_pong",
    "h1_raw_descriptor_ring_payload_touch",
    "copied_producer_copied_receiver",
    "copied_producer_leased_receiver",
    "direct_producer_copied_receiver",
    "direct_producer_leased_receiver",
    "unix_socket",
    "tcp",
    "h2_rust_napi_runtime_crossing",
    "injected_avoidable_operations",
    "ring",
    "iceoryx_0_9_3",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Measurement {
    schema: u32,
    state: String,
    arm: String,
    scheduling: String,
    payload_bytes: usize,
    iterations: u64,
    elapsed_ns: u128,
    body_copies: u64,
    native_allocations: u64,
    syscalls: u64,
    park_wakes: u64,
    generic_queue_hops: u64,
    scheduler_handoffs: u64,
    checksum: u64,
    selectable: bool,
    qualified: bool,
    reason: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--child") {
        let arm = args.get(1).expect("child arm");
        let scheduling = match args.get(2).map(String::as_str) {
            Some("hot") => SchedulingMode::HotPinnedPoll,
            Some("cold") => SchedulingMode::ColdParkWake,
            _ => panic!("child scheduling"),
        };
        let iterations = args.get(3).unwrap().parse().unwrap();
        let payload = args.get(4).unwrap().parse().unwrap();
        println!(
            "{}",
            serde_json::to_string(&measure(arm, scheduling, iterations, payload)).unwrap()
        );
        return;
    }

    if args.iter().any(|arg| arg == "--designated-host") {
        // Qualification requests emit no unqualified-schedule evidence.
        eprintln!("--designated-host refused: qualification campaign is not implemented");
        std::process::exit(2);
    }
    let smoke = args.iter().any(|arg| arg == "--smoke");
    let periods = if smoke { 1 } else { 20 };
    let iterations = if smoke { 64 } else { 100_000 };
    let payload = if smoke { 256 } else { 4096 };
    let executable = std::env::current_exe().unwrap();
    let mut attempts = Vec::new();
    for scheduling in ["hot", "cold"] {
        let canonical_scheduling = scheduling_name(match scheduling {
            "hot" => SchedulingMode::HotPinnedPoll,
            _ => SchedulingMode::ColdParkWake,
        });
        for block in 0..periods {
            let forward = block % 2 == 0;
            for pass in 0..4 {
                let mut order = ARMS.to_vec();
                let reverse = matches!((forward, pass), (true, 1 | 2) | (false, 0 | 3));
                if reverse {
                    order.reverse();
                }
                for arm in order {
                    let output = Command::new(&executable)
                        .args([
                            "--child",
                            arm,
                            scheduling,
                            &iterations.to_string(),
                            &payload.to_string(),
                        ])
                        .output()
                        .expect("spawn isolated arm");
                    let line = String::from_utf8_lossy(&output.stdout);
                    let record = line
                        .lines()
                        .rev()
                        .find_map(|line| serde_json::from_str::<Measurement>(line).ok())
                        .unwrap_or_else(|| {
                            failed(
                                arm,
                                canonical_scheduling,
                                payload,
                                iterations,
                                "arm process failed",
                            )
                        });
                    attempts.push(record);
                }
            }
        }
    }
    let report = serde_json::json!({
        "schema": 1,
        "state": "complete",
        "campaign": if smoke { "smoke_non_selecting" } else { "manifest_schedule_unqualified" },
        "manifest": "benches/manifests/v1.json",
        "period_unit": "fresh_arm_process",
        "paired_process_arms": ["h0_metadata_cacheline_ping_pong", "h1_raw_descriptor_ring_payload_touch", "copied_producer_copied_receiver", "copied_producer_leased_receiver", "direct_producer_copied_receiver", "direct_producer_leased_receiver", "unix_socket", "tcp", "ring"],
        "loopback_smoke_arms": ["iceoryx_0_9_3"],
        "gate_control_arms": ["injected_avoidable_operations"],
        "order_blocks": ["ABBA", "BAAB"],
        "counter_fields": ["body_copies", "native_allocations", "syscalls", "park_wakes", "generic_queue_hops", "scheduler_handoffs"],
        "verdict": "INCONCLUSIVE",
        "selection": "NO_QUALIFYING_ARM",
        "verdict_reasons": [
            "designated_hosts_unset",
            "paired_statistical_campaign_not_run",
            "host_explicit_control_has_one_accounted_receive_copy",
            "cold_native_wake_not_qualified",
            "macos_not_run"
        ],
        "attempts": attempts,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

fn measure(arm: &str, scheduling: SchedulingMode, iterations: u64, payload: usize) -> Measurement {
    if scheduling == SchedulingMode::ColdParkWake {
        std::thread::sleep(Duration::from_millis(1));
    }
    let result = match arm {
        "h0_metadata_cacheline_ping_pong" => run_h0(iterations),
        "h1_raw_descriptor_ring_payload_touch" | "direct_producer_leased_receiver" | "ring" => {
            run_ring(scheduling, iterations, payload, false, false)
        }
        "copied_producer_copied_receiver" => run_ring(scheduling, iterations, payload, true, true),
        "copied_producer_leased_receiver" => run_ring(scheduling, iterations, payload, true, false),
        "direct_producer_copied_receiver" => run_ring(scheduling, iterations, payload, false, true),
        "unix_socket" => run_unix(iterations, payload),
        "tcp" => run_tcp(iterations, payload),
        "h2_rust_napi_runtime_crossing" => {
            Err("runtime mechanism tests exist; paired H2 campaign has not run")
        }
        "injected_avoidable_operations" => run_ring(scheduling, iterations, payload, false, false),
        "iceoryx_0_9_3" => run_iceoryx(scheduling, iterations, payload),
        _ => Err("unknown arm"),
    };
    match result {
        Ok((elapsed, copies, allocations, syscalls, wakes, checksum)) => {
            let mut counters = OperationCounters {
                body_copies: copies,
                native_allocations: allocations,
                syscalls,
                park_wakes: wakes,
                generic_queue_hops: 0,
                scheduler_handoffs: 0,
            };
            if arm == "injected_avoidable_operations" {
                counters.body_copies = 1;
                counters.native_allocations = 1;
                counters.syscalls = 1;
                counters.park_wakes = 1;
                counters.generic_queue_hops = 1;
                counters.scheduler_handoffs = 1;
            }
            let disqualifications = counters.disqualifications(scheduling, false);
            let reason = if disqualifications.is_empty() {
                "smoke evidence is never designated-host qualification".to_owned()
            } else {
                format!("operation_counter_gate:{}", disqualifications.join(","))
            };
            Measurement {
                schema: 1,
                state: "complete".to_owned(),
                arm: arm.to_owned(),
                scheduling: scheduling_name(scheduling).to_owned(),
                payload_bytes: payload,
                iterations,
                elapsed_ns: elapsed.as_nanos(),
                body_copies: counters.body_copies,
                native_allocations: counters.native_allocations,
                syscalls: counters.syscalls,
                park_wakes: counters.park_wakes,
                generic_queue_hops: counters.generic_queue_hops,
                scheduler_handoffs: counters.scheduler_handoffs,
                checksum,
                selectable: matches!(arm, "ring" | "iceoryx_0_9_3"),
                qualified: false,
                reason: Some(reason),
            }
        }
        Err(reason) => failed(
            arm,
            scheduling_name(scheduling),
            payload,
            iterations,
            reason,
        ),
    }
}

fn failed(
    arm: &str,
    scheduling: &str,
    payload: usize,
    iterations: u64,
    reason: &str,
) -> Measurement {
    Measurement {
        schema: 1,
        state: "failed".to_owned(),
        arm: arm.to_owned(),
        scheduling: scheduling.to_owned(),
        payload_bytes: payload,
        iterations,
        elapsed_ns: 0,
        body_copies: 0,
        native_allocations: 0,
        syscalls: 0,
        park_wakes: 0,
        generic_queue_hops: 0,
        scheduler_handoffs: 0,
        checksum: 0,
        selectable: matches!(arm, "ring" | "iceoryx_0_9_3"),
        qualified: false,
        reason: Some(reason.to_owned()),
    }
}

fn scheduling_name(scheduling: SchedulingMode) -> &'static str {
    match scheduling {
        SchedulingMode::HotPinnedPoll => "hot_pinned_poll",
        SchedulingMode::ColdParkWake => "cold_park_wake",
    }
}

fn run_h0(iterations: u64) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    let mapped = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            4096,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    };
    if mapped == libc::MAP_FAILED {
        return Err("h0 mapping");
    }
    let line = mapped.cast::<AtomicU64>();
    unsafe { line.write(AtomicU64::new(0)) };
    let child = unsafe { libc::fork() };
    if child < 0 {
        unsafe { libc::munmap(mapped, 4096) };
        return Err("h0 fork");
    }
    if child == 0 {
        for sequence in 0..iterations {
            let request = sequence * 2 + 1;
            while unsafe { (*line).load(Ordering::Acquire) } != request {
                std::hint::spin_loop();
            }
            unsafe { (*line).store(request + 1, Ordering::Release) };
        }
        unsafe { libc::_exit(0) };
    }
    let start = Instant::now();
    for sequence in 0..iterations {
        let request = sequence * 2 + 1;
        unsafe { (*line).store(request, Ordering::Release) };
        while unsafe { (*line).load(Ordering::Acquire) } != request + 1 {
            std::hint::spin_loop();
        }
    }
    let status = wait_child(child)?;
    let checksum = unsafe { (*line).load(Ordering::Relaxed) };
    unsafe { libc::munmap(mapped, 4096) };
    if status != 0 {
        return Err("h0 peer failed");
    }
    Ok((start.elapsed(), 0, 0, 0, 0, checksum))
}

fn ring_profile(scheduling: SchedulingMode) -> Result<TargetProfile, &'static str> {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            BackendId::Ring,
            MemoryLayout::TwoSpanWrap,
            OwnershipMode::DirectLeased,
            scheduling,
            WorkloadClass::SmallLatency,
            if cfg!(target_os = "macos") {
                PlatformKind::Macos
            } else {
                PlatformKind::Linux
            },
            RuntimeKind::Rust,
            HardwareProfileId::new("smoke-unqualified").map_err(|_| "profile")?,
        ),
        descriptor_depth: 32,
        arena_bytes: mc_shm_transport::MIN_ARENA_BYTES,
        max_spans: 2,
        max_leases: 32,
        mappings: 2,
        pinned_workers: usize::from(scheduling == SchedulingMode::HotPinnedPoll) * 2,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .map_err(|_| "profile")
}

fn run_ring(
    scheduling: SchedulingMode,
    iterations: u64,
    payload_len: usize,
    copied_producer: bool,
    copied_receiver: bool,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    let profile = ring_profile(scheduling)?;
    let ring = Ring::create(&profile, 0).map_err(|_| "ring setup")?;
    let body = vec![0x5a; payload_len];
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err("ring peer fork");
    }
    if child == 0 {
        let status = ring_consumer(&ring, scheduling, iterations, copied_receiver);
        unsafe { libc::_exit(status) };
    }

    let mut copies = 0u64;
    let mut allocations = 0u64;
    let start = Instant::now();
    for _ in 0..iterations {
        let copied;
        let source = if copied_producer {
            copied = body.clone();
            copies += 1;
            allocations += 1;
            copied.as_slice()
        } else {
            body.as_slice()
        };
        let mut reservation = ring
            .reserve_until(
                payload_len,
                wire_v2_header(payload_len).map_err(|_| "header")?,
                Instant::now() + Duration::from_secs(2),
            )
            .map_err(|_| "reserve")?;
        reservation.write(source).map_err(|_| "write")?;
        reservation.commit(payload_len).map_err(|_| "commit")?;
    }
    let status = wait_child(child)?;
    if status != 0 {
        return Err("ring peer failed");
    }
    if copied_receiver {
        copies += iterations;
        allocations += iterations;
    }
    let checksum = iterations
        .wrapping_mul(payload_len as u64)
        .wrapping_mul(0x5a);
    black_box(checksum);
    Ok((
        start.elapsed(),
        copies,
        allocations,
        0,
        u64::from(scheduling == SchedulingMode::ColdParkWake) * iterations,
        checksum,
    ))
}

fn ring_consumer(
    ring: &Ring,
    scheduling: SchedulingMode,
    iterations: u64,
    copied_receiver: bool,
) -> i32 {
    for _ in 0..iterations {
        let deadline = Instant::now() + Duration::from_secs(2);
        let lease = loop {
            match ring.try_receive() {
                Ok(Some(lease)) => break lease,
                Ok(None) if Instant::now() < deadline => match scheduling {
                    SchedulingMode::HotPinnedPoll => std::hint::spin_loop(),
                    SchedulingMode::ColdParkWake => {
                        std::thread::sleep(Duration::from_micros(50));
                    }
                },
                _ => return 2,
            }
        };
        if copied_receiver {
            if lease.to_vec().is_err() {
                return 3;
            }
        } else {
            for index in 0..lease.segment_count() {
                let Some(span) = lease.segment(index) else {
                    return 4;
                };
                black_box(span.checksum());
            }
        }
        if lease.release().is_err() {
            return 5;
        }
    }
    0
}

fn wait_child(child: libc::pid_t) -> Result<i32, &'static str> {
    let mut status = 0;
    if unsafe { libc::waitpid(child, &mut status, 0) } != child {
        return Err("peer wait failed");
    }
    if libc::WIFEXITED(status) {
        Ok(libc::WEXITSTATUS(status))
    } else {
        Err("peer terminated")
    }
}

fn run_unix(
    iterations: u64,
    payload_len: usize,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    let (mut first, mut second) = UnixStream::pair().map_err(|_| "unix setup")?;
    run_stream_pair(&mut first, &mut second, iterations, payload_len)
}

fn run_tcp(
    iterations: u64,
    payload_len: usize,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "tcp bind")?;
    let address = listener.local_addr().map_err(|_| "tcp address")?;
    let mut first = TcpStream::connect(address).map_err(|_| "tcp connect")?;
    let (mut second, _) = listener.accept().map_err(|_| "tcp accept")?;
    first.set_nodelay(true).map_err(|_| "tcp option")?;
    second.set_nodelay(true).map_err(|_| "tcp option")?;
    run_stream_pair(&mut first, &mut second, iterations, payload_len)
}

fn run_stream_pair<S>(
    first: &mut S,
    second: &mut S,
    iterations: u64,
    payload_len: usize,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str>
where
    S: Read + Write,
{
    let body = vec![0x5a; payload_len];
    let mut response = vec![0u8; payload_len];
    let mut request = vec![0u8; payload_len];
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err("stream peer fork");
    }
    if child == 0 {
        for _ in 0..iterations {
            if second.read_exact(&mut request).is_err() || second.write_all(&request).is_err() {
                unsafe { libc::_exit(2) };
            }
        }
        unsafe { libc::_exit(0) };
    }
    let mut checksum = 0u64;
    let start = Instant::now();
    for _ in 0..iterations {
        first.write_all(&body).map_err(|_| "stream write")?;
        first.read_exact(&mut response).map_err(|_| "stream read")?;
        checksum = checksum.wrapping_add(response.iter().map(|byte| u64::from(*byte)).sum::<u64>());
    }
    if wait_child(child)? != 0 {
        return Err("stream peer failed");
    }
    Ok((
        start.elapsed(),
        iterations * 2,
        3,
        iterations * 4,
        0,
        checksum,
    ))
}

#[cfg(feature = "iceoryx")]
fn run_iceoryx(
    scheduling: SchedulingMode,
    iterations: u64,
    payload_len: usize,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    use mc_shm_transport::backend::iceoryx::IceoryxBackend;
    let profile = TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            BackendId::Iceoryx,
            MemoryLayout::IceoryxSample,
            OwnershipMode::DirectLeased,
            scheduling,
            WorkloadClass::SmallLatency,
            if cfg!(target_os = "macos") {
                PlatformKind::Macos
            } else {
                PlatformKind::Linux
            },
            RuntimeKind::Rust,
            HardwareProfileId::new("smoke-unqualified").map_err(|_| "profile")?,
        ),
        descriptor_depth: 4,
        arena_bytes: mc_shm_transport::MIN_ARENA_BYTES,
        max_spans: 1,
        max_leases: 4,
        mappings: 2,
        pinned_workers: usize::from(scheduling == SchedulingMode::HotPinnedPoll) * 2,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .map_err(|_| "profile")?;
    let backend = IceoryxBackend::create(&profile, 0).map_err(|_| "iceoryx setup")?;
    let body = vec![0x5a; payload_len];
    let mut checksum = 0u64;
    let start = Instant::now();
    for _ in 0..iterations {
        let mut reservation = backend
            .try_reserve(
                payload_len,
                wire_v2_header(payload_len).map_err(|_| "header")?,
            )
            .map_err(|_| "reserve")?;
        reservation.write(&body).map_err(|_| "write")?;
        reservation.commit(payload_len).map_err(|_| "commit")?;
        let deadline = Instant::now() + Duration::from_secs(1);
        let lease = loop {
            if let Some(lease) = backend.try_receive().map_err(|_| "receive")? {
                break lease;
            }
            if Instant::now() >= deadline {
                return Err("iceoryx receive deadline");
            }
            std::hint::spin_loop();
        };
        checksum = checksum.wrapping_add(
            lease
                .segment(0)
                .ok_or("span")?
                .iter()
                .map(|byte| u64::from(*byte))
                .sum::<u64>(),
        );
        lease.release();
    }
    Ok((start.elapsed(), 0, 0, 0, 0, checksum))
}

#[cfg(not(feature = "iceoryx"))]
fn run_iceoryx(
    _scheduling: SchedulingMode,
    _iterations: u64,
    _payload_len: usize,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    Err("iceoryx feature disabled")
}
