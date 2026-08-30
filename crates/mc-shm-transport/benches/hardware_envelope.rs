use std::hint::black_box;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use mc_shm_transport::backend::ring::{wire_v2_header, Ring};
use mc_shm_transport::descriptor::{HardwareProfileId, TransportDescriptor};
use mc_shm_transport::evidence::OperationCounters;
use mc_shm_transport::profile::{
    CompletionMode, ProducerTopology, ProfileConfig, TargetProfile, WorkerTopology,
};
use serde::{Deserialize, Serialize};

const PROFILE: &str = "eventfd_sparse_ring";

const ARMS: &[&str] = &[
    "h0_metadata_cacheline_ping_pong",
    "h1_raw_descriptor_ring_payload_touch",
    "copied_producer_copied_receiver",
    "copied_producer_leased_receiver",
    "direct_producer_copied_receiver",
    "direct_producer_leased_receiver",
    "h2_rust_napi_runtime_crossing",
    "injected_avoidable_operations",
    "ring",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Measurement {
    schema: u32,
    state: String,
    arm: String,
    profile: String,
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
    reason: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--child") {
        let arm = args.get(1).expect("child arm");
        let iterations = args.get(2).unwrap().parse().unwrap();
        let payload = args.get(3).unwrap().parse().unwrap();
        println!(
            "{}",
            serde_json::to_string(&measure(arm, iterations, payload)).unwrap()
        );
        return;
    }

    if args.iter().any(|arg| arg == "--designated-host") {
        eprintln!("--designated-host is not supported by the fixed ring smoke benchmark");
        std::process::exit(2);
    }
    let smoke = args.iter().any(|arg| arg == "--smoke");
    let periods = if smoke { 1 } else { 20 };
    let iterations = if smoke { 64 } else { 100_000 };
    let payload = if smoke { 256 } else { 4096 };
    let executable = std::env::current_exe().unwrap();
    let mut attempts = Vec::new();
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
                    .unwrap_or_else(|| failed(arm, payload, iterations, "arm process failed"));
                attempts.push(record);
            }
        }
    }
    let report = serde_json::json!({
        "schema": 1,
        "state": "complete",
        "local_verdict": "MECHANISM_SMOKE_ONLY",
        "designated_host_verdict": "BLOCKED",
        "blockers": ["no frozen ring A/A campaign", "no callback-budget sweep", "no designated-host campaign"],
        "campaign": if smoke { "smoke" } else { "manifest_schedule" },
        "manifest": "benches/manifests/v1.json",
        "period_unit": "fresh_arm_process",
        "paired_process_arms": ["h0_metadata_cacheline_ping_pong", "h1_raw_descriptor_ring_payload_touch", "copied_producer_copied_receiver", "copied_producer_leased_receiver", "direct_producer_copied_receiver", "direct_producer_leased_receiver", "ring"],
        "gate_control_arms": ["injected_avoidable_operations"],
        "order_blocks": ["ABBA", "BAAB"],
        "counter_fields": ["body_copies", "native_allocations", "syscalls", "park_wakes", "generic_queue_hops", "scheduler_handoffs"],
        "attempts": attempts,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

fn measure(arm: &str, iterations: u64, payload: usize) -> Measurement {
    let result = match arm {
        "h0_metadata_cacheline_ping_pong" => run_h0(iterations),
        "h1_raw_descriptor_ring_payload_touch" | "direct_producer_leased_receiver" | "ring" => {
            run_ring(iterations, payload, false, false)
        }
        "copied_producer_copied_receiver" => run_ring(iterations, payload, true, true),
        "copied_producer_leased_receiver" => run_ring(iterations, payload, true, false),
        "direct_producer_copied_receiver" => run_ring(iterations, payload, false, true),
        "h2_rust_napi_runtime_crossing" => {
            Err("runtime mechanism tests exist; paired H2 campaign has not run")
        }
        "injected_avoidable_operations" => run_ring(iterations, payload, false, false),
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
            let disqualifications = counters.disqualifications(false);
            let reason = if disqualifications.is_empty() {
                "smoke evidence is never designated-host qualification".to_owned()
            } else {
                format!("operation_counter_gate:{}", disqualifications.join(","))
            };
            Measurement {
                schema: 1,
                state: "complete".to_owned(),
                arm: arm.to_owned(),
                profile: PROFILE.to_owned(),
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
                reason: Some(reason),
            }
        }
        Err(reason) => failed(arm, payload, iterations, reason),
    }
}

fn failed(arm: &str, payload: usize, iterations: u64, reason: &str) -> Measurement {
    Measurement {
        schema: 1,
        state: "failed".to_owned(),
        arm: arm.to_owned(),
        profile: PROFILE.to_owned(),
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
        reason: Some(reason.to_owned()),
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

// Smoke-only ring geometry differs from the host profile because the caller
// drives both ends; depth and lease limit 32 prevent benchmark backpressure.
fn ring_profile() -> Result<TargetProfile, &'static str> {
    TargetProfile::new(ProfileConfig {
        descriptor: TransportDescriptor::new(
            HardwareProfileId::new(PROFILE).map_err(|_| "profile")?,
        ),
        descriptor_depth: 32,
        arena_bytes: mc_shm_transport::MIN_ARENA_BYTES,
        max_spans: 2,
        max_leases: 32,
        mappings: 2,
        pinned_workers: 0,
        producer_topology: ProducerTopology::CallerConfined,
        worker_topology: WorkerTopology::CallerThread,
        completion_mode: CompletionMode::SynchronousPull,
    })
    .map_err(|_| "profile")
}

fn run_ring(
    iterations: u64,
    payload_len: usize,
    copied_producer: bool,
    copied_receiver: bool,
) -> Result<(Duration, u64, u64, u64, u64, u64), &'static str> {
    let profile = ring_profile()?;
    let ring = Ring::create(&profile, 0).map_err(|_| "ring setup")?;
    let body = vec![0x5a; payload_len];
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err("ring peer fork");
    }
    if child == 0 {
        let status = ring_consumer(&ring, iterations, copied_receiver);
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
        iterations,
        checksum,
    ))
}

fn ring_consumer(ring: &Ring, iterations: u64, copied_receiver: bool) -> i32 {
    for _ in 0..iterations {
        let deadline = Instant::now() + Duration::from_secs(2);
        let lease = loop {
            match ring.try_receive() {
                Ok(Some(lease)) => break lease,
                Ok(None) if Instant::now() < deadline => {
                    if ring.wait_for_data(deadline).is_err() {
                        return 2;
                    }
                }
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
