//! Pinned two-thread atomic ping-pong: the core-to-core cache-line
//! transfer floor.
//!
//! Two dedicated native threads on verified, distinct pinned CPUs exchange
//! a token through one padded atomic with acquire/release ordering. The
//! initiator times whole batches of full A-to-B-to-A round trips; per-batch
//! mean RTT is the retained observation. Timer overhead is measured and
//! retained as a bracket, never subtracted.

#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use super::linux_topology::{current_cpu, pin_current_thread};

/// One cache line (or two, on machines with adjacent-line prefetch) per
/// atomic so token traffic is the only coherence traffic.
#[repr(align(128))]
struct Padded(AtomicU64);

/// Fixed contract for one ping-pong collection.
#[derive(Debug, Clone, Copy)]
pub struct PingPongConfig {
    pub initiator_cpu: u32,
    pub responder_cpu: u32,
    /// Batches discarded before measurement begins.
    pub warmup_batches: u32,
    /// Measured batches retained as observations.
    pub batches: u32,
    /// Full round trips per batch.
    pub exchanges_per_batch: u32,
}

/// Observed CPUs before the first and after the last exchange on one
/// thread, proving where the work executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ObservedCpus {
    pub before: u32,
    pub after: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PingPongOutput {
    /// Mean full-RTT nanoseconds of each measured batch.
    pub batch_mean_rtt_ns: Vec<f64>,
    pub total_exchanges: u64,
    pub elapsed_ns: u64,
    /// Median cost of one bracketing `Instant::now()` pair, retained for
    /// context and never subtracted from batch results.
    pub clock_bracket_ns: u64,
    pub initiator: ObservedCpus,
    pub responder: ObservedCpus,
}

impl PingPongOutput {
    /// Exchanges per second over the measured window.
    pub fn exchanges_per_sec(&self) -> f64 {
        if self.elapsed_ns == 0 {
            return 0.0;
        }
        self.total_exchanges as f64 * 1e9 / self.elapsed_ns as f64
    }
}

/// Median elapsed nanoseconds of an empty `Instant::now()` bracket.
fn clock_bracket_ns() -> u64 {
    let mut samples: Vec<u64> = (0..1000)
        .map(|_| {
            let start = Instant::now();
            let end = Instant::now();
            end.duration_since(start).as_nanos() as u64
        })
        .collect();
    samples.sort_unstable();
    samples[samples.len() / 2]
}

/// Runs the finite ping-pong exchange and returns per-batch observations.
///
/// Token protocol: for exchange `i` (1-based), the initiator stores `2i-1`
/// (release) and spins for `2i` (acquire); the responder spins for `2i-1`
/// and stores `2i`. Both threads run the same finite count, so the
/// exchange terminates without a stop flag or timeout. Pin failures abort
/// both threads before any exchange.
pub fn run_ping_pong(cfg: PingPongConfig) -> Result<PingPongOutput, String> {
    if cfg.batches == 0 || cfg.exchanges_per_batch == 0 {
        return Err("batches and exchanges_per_batch must be nonzero".to_owned());
    }
    let token = Arc::new(Padded(AtomicU64::new(0)));
    let abort = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(Barrier::new(2));
    let total_batches = cfg
        .warmup_batches
        .checked_add(cfg.batches)
        .ok_or("warmup_batches + batches overflows u32")?;
    let total_exchanges = u64::from(total_batches) * u64::from(cfg.exchanges_per_batch);

    let responder = {
        let token = Arc::clone(&token);
        let abort = Arc::clone(&abort);
        let ready = Arc::clone(&ready);
        std::thread::spawn(move || -> Result<ObservedCpus, String> {
            if let Err(err) = pin_current_thread(cfg.responder_cpu) {
                abort.store(true, Ordering::Release);
                ready.wait();
                return Err(format!("responder pin: {err}"));
            }
            ready.wait();
            if abort.load(Ordering::Acquire) {
                return Err("aborted before exchange".to_owned());
            }
            let before = current_cpu();
            for i in 1..=total_exchanges {
                let want = 2 * i - 1;
                while token.0.load(Ordering::Acquire) != want {
                    std::hint::spin_loop();
                }
                token.0.store(2 * i, Ordering::Release);
            }
            Ok(ObservedCpus {
                before,
                after: current_cpu(),
            })
        })
    };

    let run_initiator = move || -> Result<(Vec<f64>, u64, ObservedCpus), String> {
        if let Err(err) = pin_current_thread(cfg.initiator_cpu) {
            abort.store(true, Ordering::Release);
            ready.wait();
            return Err(format!("initiator pin: {err}"));
        }
        ready.wait();
        if abort.load(Ordering::Acquire) {
            return Err("aborted before exchange".to_owned());
        }
        let before = current_cpu();
        let mut batch_means = Vec::with_capacity(cfg.batches as usize);
        let mut measured_ns = 0u64;
        let mut exchange = 0u64;
        for batch in 0..total_batches {
            let start = Instant::now();
            for _ in 0..cfg.exchanges_per_batch {
                exchange += 1;
                token.0.store(2 * exchange - 1, Ordering::Release);
                let want = 2 * exchange;
                while token.0.load(Ordering::Acquire) != want {
                    std::hint::spin_loop();
                }
            }
            let elapsed = start.elapsed().as_nanos() as u64;
            if batch >= cfg.warmup_batches {
                measured_ns += elapsed;
                batch_means.push(elapsed as f64 / f64::from(cfg.exchanges_per_batch));
            }
        }
        Ok((
            batch_means,
            measured_ns,
            ObservedCpus {
                before,
                after: current_cpu(),
            },
        ))
    };

    // The initiator gets its own thread so `pin_current_thread` never
    // confines the caller: pinning the calling thread would leave it
    // restricted to `initiator_cpu` for everything that runs after this
    // function returns, including spawned child processes that inherit
    // the affinity mask.
    let initiator_result = std::thread::spawn(run_initiator)
        .join()
        .map_err(|_| "initiator panicked")?;
    let responder_result = responder.join().map_err(|_| "responder panicked")?;
    // "aborted before exchange" from one thread is the symptom of the
    // other thread's pin failure; surface the error naming the root
    // cause instead of the abort marker.
    let ((batch_means, measured_ns, initiator_cpus), responder_cpus) =
        match (initiator_result, responder_result) {
            (Ok(initiator), Ok(responder_cpus)) => (initiator, responder_cpus),
            (Err(err), Ok(_)) | (Ok(_), Err(err)) => return Err(err),
            (Err(initiator_err), Err(responder_err)) => {
                return Err(if initiator_err.contains("aborted") {
                    responder_err
                } else {
                    initiator_err
                });
            }
        };

    Ok(PingPongOutput {
        batch_mean_rtt_ns: batch_means,
        total_exchanges: u64::from(cfg.batches) * u64::from(cfg.exchanges_per_batch),
        elapsed_ns: measured_ns,
        clock_bracket_ns: clock_bracket_ns(),
        initiator: initiator_cpus,
        responder: responder_cpus,
    })
}

/// Times `exchanges` full round trips on already-valid CPUs for Criterion's
/// `iter_custom`: one warmup-free timed window, no per-exchange
/// instrumentation.
pub fn timed_exchanges(
    initiator_cpu: u32,
    responder_cpu: u32,
    exchanges: u64,
) -> Result<Duration, String> {
    let exchanges = u32::try_from(exchanges).map_err(|_| "exchange count too large")?;
    let out = run_ping_pong(PingPongConfig {
        initiator_cpu,
        responder_cpu,
        warmup_batches: 0,
        batches: 1,
        exchanges_per_batch: exchanges.max(1),
    })?;
    Ok(Duration::from_nanos(out.elapsed_ns))
}
