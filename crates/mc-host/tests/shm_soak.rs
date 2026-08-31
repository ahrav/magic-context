//!
//! CI.
//!
//! The ring provider never reclaims active charges after a peer dies.
//! A candidate whose peer dies mid-flight retains active charges until its endpoint closes.
//! A `Goodbye`-driven clean endpoint closure, not killing or reaping, returns the candidate's exact admission charges.
//! The parent proves exact logical conservation, zero quarantined charges, and no surviving descendants before the next cycle.
//!
//! Clean cycles prove clean-close charge conservation and crash-side OS hygiene, not dead-peer charge reclamation; `killed_victim_holding_active_charges_is_never_reclaimed` verifies that active charges are never reclaimed after a victim is killed.
//!
//! # Envelope
//! Twenty unmeasured warmup cycles run first.
//! Three equal consecutive OS snapshots freeze the envelope for each long-lived role.
//! The daemon and harness parent each provide the snapshots that freeze the envelope.
//! Measurement checks logical counters every cycle and OS counters every ten cycles and on the final cycle.
//! The measurement phase never updates the envelope.
//! envelope.
//!
//!
//! Failure output names only the role, cycle number, counter kind, and expected and actual counts.
//! expected/actual counts.

mod support;

use std::fmt;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use support::process_resources::{observe, ResourceCounts};

/// `serial_soak_lock` serializes all tests in this binary because plain `cargo test` runs them in one process.
/// Tests would otherwise race fd, mapping, and thread counters in the shared process.
/// Callers acquire `serial_soak_lock` before building any runtime.
fn serial_soak_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const STABLE_DEADLINE: Duration = Duration::from_secs(15);
const SAMPLE_INTERVAL: Duration = Duration::from_millis(25);

fn wait_counts(pid: u32, what: &str, predicate: impl Fn(ResourceCounts) -> bool) {
    let deadline = Instant::now() + STABLE_DEADLINE;
    loop {
        let counts = observe(pid).unwrap_or_else(|error| panic!("{error}"));
        if predicate(counts) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "resource counters did not reach {what} within the bounded wait"
        );
        std::thread::sleep(SAMPLE_INTERVAL);
    }
}

fn stable_counts(pid: u32) -> ResourceCounts {
    let deadline = Instant::now() + STABLE_DEADLINE;
    let mut streak: Option<(ResourceCounts, u32)> = None;
    loop {
        let counts = observe(pid).unwrap_or_else(|error| panic!("{error}"));
        streak = match streak {
            Some((held, seen)) if held == counts => {
                if seen + 1 >= 3 {
                    return counts;
                }
                Some((held, seen + 1))
            }
            _ => Some((counts, 1)),
        };
        assert!(
            Instant::now() < deadline,
            "resource counters did not stabilize within the bounded wait"
        );
        std::thread::sleep(SAMPLE_INTERVAL);
    }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

#[test]
fn observer_reports_fd_delta_and_return_to_baseline() {
    let _serial = serial_soak_lock();
    let pid = std::process::id();
    let baseline = stable_counts(pid);
    let held = std::fs::File::open(std::env::current_exe().expect("test executable path"))
        .expect("open one known fd");
    wait_counts(pid, "one extra fd", |counts| counts.fds == baseline.fds + 1);
    drop(held);
    wait_counts(pid, "the fd baseline", |counts| counts.fds == baseline.fds);
}

/// neighbor.
struct TestMapping {
    address: *mut libc::c_void,
    length: usize,
    #[cfg(target_os = "linux")]
    fd: libc::c_int,
}

impl TestMapping {
    #[cfg(target_os = "linux")]
    const FD_DELTA: u64 = 1;
    #[cfg(not(target_os = "linux"))]
    const FD_DELTA: u64 = 0;

    fn create() -> Self {
        let length = 1 << 16;
        #[cfg(target_os = "linux")]
        unsafe {
            let fd = libc::memfd_create(c"mc-soak-observer-self-test".as_ptr(), 0);
            assert!(fd >= 0, "memfd for the mapping self-test");
            assert_eq!(
                libc::ftruncate(fd, length as libc::off_t),
                0,
                "size the memfd"
            );
            let address = libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            );
            assert_ne!(address, libc::MAP_FAILED, "map the memfd");
            Self {
                address,
                length,
                fd,
            }
        }
        #[cfg(not(target_os = "linux"))]
        unsafe {
            let address = libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED | libc::MAP_ANON,
                -1,
                0,
            );
            assert_ne!(address, libc::MAP_FAILED, "map one anonymous region");
            Self { address, length }
        }
    }

    fn dispose(self) {
        unsafe {
            assert_eq!(libc::munmap(self.address, self.length), 0, "unmap");
            #[cfg(target_os = "linux")]
            assert_eq!(libc::close(self.fd), 0, "close the memfd");
        }
    }
}

#[test]
fn observer_reports_mapping_delta_and_return_to_baseline() {
    let _serial = serial_soak_lock();
    let pid = std::process::id();
    let baseline = stable_counts(pid);
    let mapping = TestMapping::create();
    wait_counts(pid, "one extra mapped region", |counts| {
        counts.mapped_regions == baseline.mapped_regions + 1
            && counts.fds == baseline.fds + TestMapping::FD_DELTA
    });
    mapping.dispose();
    wait_counts(pid, "the mapping baseline", |counts| {
        counts.mapped_regions == baseline.mapped_regions && counts.fds == baseline.fds
    });
}

#[test]
fn observer_reports_thread_delta_and_return_to_baseline() {
    let _serial = serial_soak_lock();
    let pid = std::process::id();
    let baseline = stable_counts(pid);
    let (release, held) = std::sync::mpsc::channel::<()>();
    let worker = std::thread::spawn(move || {
        let _ = held.recv();
    });
    wait_counts(pid, "one extra thread", |counts| {
        counts.threads == baseline.threads + 1
    });
    release.send(()).expect("release the held thread");
    worker.join().expect("join the held thread");
    wait_counts(pid, "the thread baseline", |counts| {
        counts.threads == baseline.threads
    });
}

#[test]
fn observer_fails_on_an_unobservable_pid() {
    let _serial = serial_soak_lock();
    let mut child = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .arg("--list")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn a short-lived child");
    let pid = child.id();
    let status = child.wait().expect("reap the short-lived child");
    assert!(status.success(), "the short-lived child exits cleanly");
    let error = observe(pid).expect_err("a reaped pid is unobservable");
    let text = format!("{error}");
    assert!(
        text.contains("counter"),
        "the failure names only the counter kind"
    );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
#[test]
#[ignore = "daemon role for the shm soak harness"]
fn shm_role_daemon() {
    support::shm_process::daemon_role();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "victim role for the shm soak harness"]
fn shm_role_victim() {
    support::shm_process::victim_role();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "leaky fixture role for the descendant check"]
fn shm_soak_role_leaky() {
    if std::env::var(soak::ENV_LEAKY_ROLE).is_err() {
        return;
    }
    let child = std::process::Command::new("/bin/sleep")
        .arg("3600")
        .spawn()
        .expect("spawn the leaked descendant");
    drop(child);
    support::shm_process::emit_record("child_leaked");
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

#[cfg(target_os = "linux")]
mod soak {
    use super::*;
    use std::path::Path;

    use mc_host::shm_provider::qualified_test_profile;
    use support::shm_process::{
        commit_shm_peer, daemon_info, goodbye_header, live_descendants, negotiate_grant,
        shm_roundtrip, spawn_role, spawn_victim, start_daemon, start_daemon_with, DaemonSoakStats,
        Observer, RoleProcess,
    };

    pub const BUDGET: Duration = Duration::from_secs(10);
    const WARMUP_CYCLES: u64 = 20;
    const OS_CHECK_INTERVAL: u64 = 10;
    pub const ENV_LEAKY_ROLE: &str = "MC_SHM_SOAK_LEAKY_ROLE";

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------

    /// only (R17).
    #[derive(Debug, PartialEq, Eq)]
    pub struct SoakViolation {
        pub role: &'static str,
        pub cycle: u64,
        pub counter: &'static str,
        pub expected: u64,
        pub actual: u64,
    }

    impl fmt::Display for SoakViolation {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(
                formatter,
                "soak violation: role {} cycle {} counter {} expected {} actual {}",
                self.role, self.cycle, self.counter, self.expected, self.actual
            )
        }
    }

    pub fn check_descendants(
        role: &'static str,
        cycle: u64,
        pid: u32,
        allowed: &[u32],
    ) -> Result<(), SoakViolation> {
        let strays = live_descendants(pid)
            .into_iter()
            .filter(|descendant| !allowed.contains(descendant))
            .count() as u64;
        if strays == 0 {
            return Ok(());
        }
        Err(SoakViolation {
            role,
            cycle,
            counter: "descendants",
            expected: 0,
            actual: strays,
        })
    }

    fn check_envelope(
        role: &'static str,
        cycle: u64,
        pid: u32,
        envelope: ResourceCounts,
    ) -> Result<(), SoakViolation> {
        let deadline = Instant::now() + BUDGET;
        loop {
            let counts = observe(pid).unwrap_or_else(|error| panic!("{error}"));
            let excess = counts
                .counters()
                .into_iter()
                .zip(envelope.counters())
                .find(|(actual, frozen)| actual.1 > frozen.1);
            let Some((actual, frozen)) = excess else {
                return Ok(());
            };
            if Instant::now() >= deadline {
                return Err(SoakViolation {
                    role,
                    cycle,
                    counter: actual.0,
                    expected: frozen.1,
                    actual: actual.1,
                });
            }
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    }

    pub fn wait_soak_stats(
        daemon: &mut RoleProcess,
        what: &str,
        predicate: impl Fn(&DaemonSoakStats) -> bool,
    ) -> DaemonSoakStats {
        let deadline = Instant::now() + STABLE_DEADLINE;
        loop {
            let stats = daemon.query_soak_stats();
            if predicate(&stats) {
                return stats;
            }
            assert!(
                Instant::now() < deadline,
                "daemon accounting did not reach {what} within the bounded wait"
            );
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    }

    fn wait_logical_baseline(daemon: &mut RoleProcess, cycle: u64) {
        let deadline = Instant::now() + STABLE_DEADLINE;
        loop {
            let stats = daemon.query_soak_stats();
            let conserved = stats.active == [0; 4]
                && stats.quarantined == [0; 4]
                && stats.preparations == cycle
                && stats.readiness == "Ready";
            if conserved {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "cycle {cycle}: daemon logical counters did not return exactly to baseline \
                 (active={:?} quarantined={:?} preparations expected {cycle} actual {})",
                stats.active,
                stats.quarantined,
                stats.preparations
            );
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    }

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------

    pub struct SoakConfig {
        pub measured_cycles: u64,
        pub os_check_interval: u64,
        pub leak_fd_every: Option<u64>,
    }

    async fn run_cycle(
        daemon: &mut RoleProcess,
        observer: &mut Observer,
        data_root: &Path,
        daemon_pid: u32,
        completed: u64,
    ) {
        let session = format!("victim-soak-{completed}");
        let mut victim = spawn_victim(data_root, "roundtrip_park", &session, None);
        victim.expect_record("barrier idle_committed");
        victim.expect_record("terminal ok");
        victim.expect_record("closed");
        if let Err(violation) = check_descendants("victim", completed, victim.pid(), &[]) {
            panic!("{violation}");
        }
        victim.kill();
        let window = victim.reap_killed();
        wait_logical_baseline(daemon, completed);
        observer.roundtrip(256, 5, window.remaining()).await;
        victim.teardown();
        if let Err(violation) =
            check_descendants("parent", completed, std::process::id(), &[daemon_pid])
        {
            panic!("{violation}");
        }
    }

    pub async fn run_soak(config: SoakConfig) -> Result<(), SoakViolation> {
        let data_root = tempfile::tempdir().expect("data root");
        let mut daemon = start_daemon(data_root.path());
        let daemon_pid = daemon.pid();
        let parent_pid = std::process::id();
        let info = daemon_info(data_root.path());
        let mut observer = Observer::connect(&info, "observer-soak").await;
        observer.roundtrip(512, 7, BUDGET).await;

        let mut completed = 0u64;
        for _ in 0..WARMUP_CYCLES {
            completed += 1;
            run_cycle(
                &mut daemon,
                &mut observer,
                data_root.path(),
                daemon_pid,
                completed,
            )
            .await;
        }
        // updates it.
        let daemon_envelope = stable_counts(daemon_pid);
        let parent_envelope = stable_counts(parent_pid);

        for cycle in 1..=config.measured_cycles {
            if let Some(every) = config.leak_fd_every {
                if cycle % every == 0 {
                    daemon.send_command("leak_fd");
                    daemon.wait_for_record("leaked");
                }
            }
            completed += 1;
            run_cycle(
                &mut daemon,
                &mut observer,
                data_root.path(),
                daemon_pid,
                completed,
            )
            .await;
            if cycle % config.os_check_interval == 0 || cycle == config.measured_cycles {
                check_envelope("daemon", cycle, daemon_pid, daemon_envelope)?;
                check_envelope("parent", cycle, parent_pid, parent_envelope)?;
            }
        }
        observer.roundtrip(512, 9, BUDGET).await;
        daemon.teardown();
        Ok(())
    }

    fn soak_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("soak runtime")
    }

    // -----------------------------------------------------------------------
    // Scenarios.
    // -----------------------------------------------------------------------

    #[test]
    fn role_liveness_check_detects_a_leaked_descendant() {
        let _serial = serial_soak_lock();
        let mut leaky = spawn_role(
            "leaky",
            "shm_soak_role_leaky",
            &[(ENV_LEAKY_ROLE, "1".to_owned())],
        );
        leaky.expect_record("child_leaked");
        let violation = check_descendants("leaky", 0, leaky.pid(), &[])
            .expect_err("the descendant check must report the leaked child");
        assert_eq!(violation.role, "leaky");
        assert_eq!(violation.counter, "descendants");
        assert_eq!(violation.actual, 1);
        for descendant in live_descendants(leaky.pid()) {
            unsafe {
                libc::kill(descendant as libc::pid_t, libc::SIGKILL);
            }
        }
        leaky.teardown();
    }

    #[test]
    fn soak_smoke_conserves_charges_and_stays_inside_the_envelope() {
        let _serial = serial_soak_lock();
        soak_runtime().block_on(async {
            run_soak(SoakConfig {
                measured_cycles: 5,
                os_check_interval: 5,
                leak_fd_every: None,
            })
            .await
            .unwrap_or_else(|violation| panic!("{violation}"));
        });
    }

    #[test]
    fn injected_fd_leak_breaches_the_frozen_envelope() {
        let _serial = serial_soak_lock();
        soak_runtime().block_on(async {
            let violation = run_soak(SoakConfig {
                measured_cycles: 10,
                os_check_interval: 1,
                leak_fd_every: Some(1),
            })
            .await
            .expect_err("a leaked duplicated fd every cycle must breach the frozen envelope");
            assert_eq!(violation.role, "daemon");
            assert_eq!(violation.counter, "fds");
            assert!(violation.actual > violation.expected);
        });
    }

    #[test]
    #[ignore = "opt-in full resource soak; run via the shm-soak nextest profile"]
    fn full_soak_cycles_conserve_resources() {
        let _serial = serial_soak_lock();
        let measured: u64 = match std::env::var("MC_SHM_SOAK_CYCLES") {
            Ok(raw) => raw
                .parse()
                .expect("MC_SHM_SOAK_CYCLES must be an unsigned integer"),
            Err(_) => 1000,
        };
        assert!(
            measured > 0,
            "MC_SHM_SOAK_CYCLES must be a positive cycle count"
        );
        soak_runtime().block_on(async {
            run_soak(SoakConfig {
                measured_cycles: measured,
                os_check_interval: OS_CHECK_INTERVAL,
                leak_fd_every: None,
            })
            .await
            .unwrap_or_else(|violation| panic!("{violation}"));
        });
    }

    #[test]
    fn quarantine_exhaustion_retains_exact_charges_and_creates_no_resources() {
        let _serial = serial_soak_lock();
        soak_runtime().block_on(async {
            let data_root = tempfile::tempdir().expect("data root");
            // The frozen cap admits exactly two candidates.
            let mut daemon = start_daemon_with(data_root.path(), 2);
            let info = daemon_info(data_root.path());
            let mut observer = Observer::connect(&info, "observer-quarantine").await;
            observer.roundtrip(512, 7, BUDGET).await;

            let charges = qualified_test_profile().charges();
            let retained = |count: u64| {
                [
                    charges.descriptors * count,
                    charges.arena_bytes * count,
                    charges.leases * count,
                    charges.mappings * count,
                ]
            };
            for count in 1..=2u64 {
                wait_soak_stats(&mut daemon, "readiness Ready", |stats| {
                    stats.readiness == "Ready"
                });
                daemon.send_command("quarantine_next_close");
                daemon.wait_for_record("quarantine_armed");
                let peer = commit_shm_peer(&info).await;
                tokio::task::block_in_place(|| {
                    shm_roundtrip(&peer, &format!("quarantine-{count}"));
                    peer.send(goodbye_header(), &[]).expect("publish goodbye");
                });
                drop(peer);
                // Each accepted quarantine consumes one charge.
                wait_soak_stats(&mut daemon, "exact retained charges", |stats| {
                    stats.quarantined == retained(count) && stats.active == [0; 4]
                });
                observer.roundtrip(256, 9, BUDGET).await;
            }
            // After two quarantines, the next offer is rejected with `unavailable`.
            let exhausted = wait_soak_stats(&mut daemon, "readiness Quarantined", |stats| {
                stats.readiness == "Quarantined"
            });
            assert_eq!(exhausted.quarantined, retained(2));
            let preparations_before = exhausted.preparations;
            let os_before = stable_counts(daemon.pid());

            let (probe, selection) = negotiate_grant(&info).await;
            assert_eq!(selection["selected"]["transport"], "tcp");
            assert_eq!(selection["reason"], "unavailable");
            drop(probe);
            wait_counts(daemon.pid(), "the pre-attempt OS baseline", |counts| {
                counts.fds == os_before.fds && counts.mapped_regions == os_before.mapped_regions
            });
            let after = stable_counts(daemon.pid());
            assert!(
                after.threads <= os_before.threads,
                "the excess attempt must create no worker thread"
            );
            let stats = daemon.query_soak_stats();
            assert_eq!(stats.preparations, preparations_before);
            assert_eq!(stats.quarantined, retained(2));
            assert_eq!(stats.active, [0; 4]);
            assert_eq!(stats.readiness, "Quarantined");

            observer.roundtrip(1024, 42, BUDGET).await;
            daemon.teardown();
        });
    }
}
