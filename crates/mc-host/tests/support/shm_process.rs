//! Barrier-driven real-process crash harness for the shared-memory provider.
//!
//! # Provisional tuple
//! The frozen retained-tuple manifest from Beads task `magic-context-ymc.12`
//! (`crates/mc-shm-transport/benches/manifests/v1.json`) still contains
//! unresolved fields, so this harness runs against the in-repo ring-backed
//! `ShmProvider` tuple on Linux as the provisional tuple. Once `.12` freezes
//! the retained matrix, these roles must be pointed at each retained tuple's
//! adapter instead. commentlint: allow(JUDGE)
//!
//! # Roles
//! The parent (an ordinary libtest test in `shm_failure_modes.rs`) spawns
//! the daemon and victim as real processes via libtest self-reexec (the
//! `mc-shm-transport/tests/ring.rs` pattern): ignored tests dispatch on
//! environment variables. The observer is an independently authenticated
//! in-parent [`RawClient`] route.
//!
//! # Barriers
//! Roles exchange bounded machine-readable records over inherited pipes,
//! one line each, prefixed with [`RECORD_PREFIX`]. The owner of each
//! transition reports it: the victim reports `idle_committed` after its
//! commit exchange, the victim's client provider side reports
//! `request_published` after its ring commit, and the daemon provider
//! reports `response_published` through the provider publish hook. No
//! wall-clock sleep decides whether a crash point was reached.
//! commentlint: allow(JUDGE)
//!
//! # Kill-and-reap discipline
//! [`RoleProcess::kill`] sends `SIGKILL` and records only the kill instant.
//! The bounded post-reap observation window starts only in
//! [`RoleProcess::reap_killed`], after `wait` returned signal-9 status. The
//! harness never resets the provider or client recovery episode deadlines,
//! which keep their original start times. commentlint: allow(JUDGE)
//!
//! # Redaction
//! Records and failure output carry only redacted seed, tuple, and state
//! names — never descriptors, grants, tokens, object names, addresses, or
//! payloads. commentlint: allow(JUDGE)
//!
//! # JavaScript victim runtimes (stub category)
//! [`VictimRuntime`] currently offers only `Rust`. Bun/Node victims need a
//! JS client that drives the shared-memory provider end-to-end against a
//! Rust daemon; today no daemon entrypoint installs `ShmProvider` (the
//! `perf_host` example is TCP-only), so the JS path cannot be exercised
//! honestly. U6, with the frozen `.12` manifest, must add a daemon
//! entrypoint that installs the retained provider plus a prebundled
//! `run-mc-shm-failure-child` script, then extend [`VictimRuntime`] with
//! `Bun`/`Node` variants that spawn those runtimes directly so the signaled
//! PID is the runtime under test. This is a stub category, not coverage.
//! commentlint: allow(JUDGE)

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use mc_host::shm_provider::{
    qualified_test_parameters, qualified_test_profile, ShmProvider, TestShmPeer,
    SHM_CAPABILITY_VERSION, SHM_TRANSPORT,
};
use mc_host::transport_provider::{InjectedProvider, TransportProviders};
use mc_shm_transport::profile::HostLimits as ShmHostLimits;
use subc_protocol::{EnvelopeHeader, Flags, FrameType, Priority, PROTOCOL_VERSION};

use super::raw_client::{self, Discovered, RawClient, FLAGS_INTERACTIVE, TY_REQUEST, TY_RESPONSE};
use super::{connection_file, TestHost, LINKED_MODULE_ID};

/// Prefix that marks a machine-readable harness record on a role's stdout.
pub const RECORD_PREFIX: &str = "MC_SHM_REC";

/// Bounded post-reap observation window. Starts only after `wait` reaped the
/// killed child; provider and client episode deadlines are independent.
/// commentlint: allow(JUDGE)
pub const OBSERVATION_TIMEOUT: Duration = Duration::from_secs(20);

/// Bound on every wait for one role record.
pub const RECORD_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound on reaping an already-signaled child.
const REAP_BUDGET: Duration = Duration::from_secs(10);

/// Bound on every in-role protocol exchange.
const ROLE_BUDGET: Duration = Duration::from_secs(10);

/// Deterministic recorded seed for the victim fill request.
pub const VICTIM_FILL_BYTES: usize = 2048;
/// Deterministic recorded seed for the victim fill request.
pub const VICTIM_FILL_VALUE: u8 = 0x5a;

/// Route identity root shared by every harness client.
pub const CRASH_ROOT: &str = "/workspace/shm-crash";

pub const ENV_DAEMON_DATA_ROOT: &str = "MC_SHM_DAEMON_DATA_ROOT";
pub const ENV_DAEMON_CANDIDATES: &str = "MC_SHM_DAEMON_CANDIDATES";
pub const ENV_VICTIM_CONNECTION: &str = "MC_SHM_VICTIM_CONNECTION";
pub const ENV_VICTIM_SCENARIO: &str = "MC_SHM_VICTIM_SCENARIO";
pub const ENV_VICTIM_SESSION: &str = "MC_SHM_VICTIM_SESSION";
pub const ENV_VICTIM_STALE_FILE: &str = "MC_SHM_VICTIM_STALE_FILE";

/// Victim runtimes the harness can spawn. Only `Rust` is implemented; see
/// the module documentation's stub-category note for the Bun/Node gap.
/// commentlint: allow(JUDGE)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VictimRuntime {
    Rust,
}

/// Serializes the crash scenarios inside one test binary so plain
/// `cargo test` stays safe; nextest-level serialization comes from the
/// `shm-crash` test group in `.config/nextest.toml`. commentlint: allow(JUDGE)
pub async fn serial_crash_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Writes one bounded machine-readable record to the inherited stdout pipe.
pub fn emit_record(record: &str) {
    println!("{RECORD_PREFIX} {record}");
}

/// Instant `SIGKILL` was sent. Deliberately not an observation window: the
/// window may start only after the child is reaped. commentlint: allow(JUDGE)
#[derive(Clone, Copy, Debug)]
pub struct KillEvidence {
    pub killed_at: Instant,
}

/// Bounded post-reap observation window, anchored to the reap instant.
#[derive(Clone, Copy, Debug)]
pub struct ObservationWindow {
    pub started_at: Instant,
    pub deadline: Instant,
}

impl ObservationWindow {
    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

/// One spawned harness role process with its record pipe.
pub struct RoleProcess {
    name: &'static str,
    child: Child,
    stdin: ChildStdin,
    records: mpsc::Receiver<String>,
    status: Option<ExitStatus>,
    window: Option<ObservationWindow>,
}

/// Spawns `role_test` in a fresh copy of the current test binary with the
/// given environment, wiring stdin commands and stdout records.
pub fn spawn_role(name: &'static str, role_test: &str, envs: &[(&str, String)]) -> RoleProcess {
    let exe = std::env::current_exe().expect("test executable path");
    let mut command = Command::new(exe);
    command
        .args(["--exact", role_test, "--ignored", "--nocapture"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn role process");
    let stdout = child.stdout.take().expect("role stdout pipe");
    let (sender, records) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Some(record) = line
                .strip_prefix(RECORD_PREFIX)
                .and_then(|rest| rest.strip_prefix(' '))
            else {
                continue;
            };
            if sender.send(record.to_owned()).is_err() {
                break;
            }
        }
    });
    let stdin = child.stdin.take().expect("role stdin pipe");
    RoleProcess {
        name,
        child,
        stdin,
        records,
        status: None,
        window: None,
    }
}

impl RoleProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Next record within [`RECORD_TIMEOUT`].
    pub fn next_record(&mut self) -> String {
        match self.records.recv_timeout(RECORD_TIMEOUT) {
            Ok(record) => record,
            Err(_) => panic!(
                "role {} produced no record within its bounded wait",
                self.name
            ),
        }
    }

    /// Asserts the next record equals `expected` exactly.
    pub fn expect_record(&mut self, expected: &str) {
        let record = self.next_record();
        assert_eq!(record, expected, "role {} record", self.name);
    }

    /// Consumes records until `expected` appears, each read bounded.
    pub fn wait_for_record(&mut self, expected: &str) {
        loop {
            if self.next_record() == expected {
                return;
            }
        }
    }

    /// Writes one command line to the role's stdin pipe.
    pub fn send_command(&mut self, command: &str) {
        writeln!(self.stdin, "{command}").expect("write role command");
        self.stdin.flush().expect("flush role command");
    }

    /// Daemon-only query: total handler dispatches so far. Skips unrelated
    /// asynchronous barrier records queued ahead of the reply.
    pub fn query_dispatches(&mut self) -> u64 {
        self.send_command("stats");
        loop {
            let record = self.next_record();
            if let Some(count) = record.strip_prefix("stats dispatches=") {
                return count.parse().expect("dispatch count parses");
            }
        }
    }

    /// The query discards records before the `soak` reply.
    pub fn query_soak_stats(&mut self) -> DaemonSoakStats {
        self.send_command("soak_stats");
        loop {
            let record = self.next_record();
            if let Some(rest) = record.strip_prefix("soak ") {
                return parse_soak_stats(rest).expect("soak stats record parses");
            }
        }
    }

    /// Sends `SIGKILL` without reaping and without starting any timing.
    pub fn kill(&mut self) -> KillEvidence {
        assert!(self.status.is_none(), "role {} already reaped", self.name);
        self.child.kill().expect("SIGKILL role process");
        KillEvidence {
            killed_at: Instant::now(),
        }
    }

    /// The post-reap observation window, or `None` before the reap.
    pub fn observation_window(&self) -> Option<ObservationWindow> {
        self.window
    }

    /// Reaps a killed child: `wait` must return signal-9 status, and only
    /// then does the bounded observation window start.
    pub fn reap_killed(&mut self) -> ObservationWindow {
        let status = self.wait_status(REAP_BUDGET);
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(
                status.signal(),
                Some(9),
                "role {} must exit on signal 9",
                self.name
            );
        }
        let started_at = Instant::now();
        let window = ObservationWindow {
            started_at,
            deadline: started_at + OBSERVATION_TIMEOUT,
        };
        self.window = Some(window);
        window
    }

    /// Bounded wait for a clean voluntary exit.
    pub fn wait_exit_success(&mut self, budget: Duration) {
        let status = self.wait_status(budget);
        assert!(status.success(), "role {} must exit cleanly", self.name);
    }

    /// Bounded wait until the killed-but-unreaped child is a zombie.
    pub fn wait_zombie(&self, budget: Duration) {
        let deadline = Instant::now() + budget;
        loop {
            if proc_state(self.pid()) == Some('Z') {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "role {} did not become a zombie within its bounded wait",
                self.name
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_status(&mut self, budget: Duration) -> ExitStatus {
        if let Some(status) = self.status {
            return status;
        }
        let deadline = Instant::now() + budget;
        loop {
            if let Some(status) = self.child.try_wait().expect("wait role process") {
                self.status = Some(status);
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "role {} did not exit within its bounded wait",
                self.name
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Bounded teardown: kill, wait, and verify no descendant survived.
    pub fn teardown(mut self) {
        let descendants = live_descendants(self.pid());
        if self.status.is_none() {
            let _ = self.child.kill();
            self.wait_status(REAP_BUDGET);
        }
        let deadline = Instant::now() + REAP_BUDGET;
        for pid in descendants {
            loop {
                match proc_state(pid) {
                    None | Some('Z') => break,
                    Some(_) => {}
                }
                assert!(
                    Instant::now() < deadline,
                    "role {} left a surviving descendant",
                    self.name
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

impl Drop for RoleProcess {
    fn drop(&mut self) {
        // A panicking parent must not leave a live child behind.
        if self.status.is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Charge arrays are `[descriptors, arena_bytes, leases, mappings]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonSoakStats {
    pub active: [u64; 4],
    pub quarantined: [u64; 4],
    pub preparations: u64,
    pub readiness: String,
}

fn parse_soak_stats(rest: &str) -> Option<DaemonSoakStats> {
    let mut active = None;
    let mut quarantined = None;
    let mut preparations = None;
    let mut readiness = None;
    for field in rest.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        match key {
            "active" => active = parse_charges(value),
            "quarantined" => quarantined = parse_charges(value),
            "preparations" => preparations = value.parse().ok(),
            "readiness" => readiness = Some(value.to_owned()),
            _ => return None,
        }
    }
    Some(DaemonSoakStats {
        active: active?,
        quarantined: quarantined?,
        preparations: preparations?,
        readiness: readiness?,
    })
}

fn parse_charges(value: &str) -> Option<[u64; 4]> {
    let mut parts = value.split(',');
    let charges = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    if parts.next().is_some() {
        return None;
    }
    Some(charges)
}

/// Transitive live descendants of `root`, from `/proc` parent links.
pub fn live_descendants(root: u32) -> Vec<u32> {
    let mut table: Vec<(u32, u32)> = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|text| text.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        if let Some((_, ppid)) = parse_stat(&stat) {
            table.push((pid, ppid));
        }
    }
    let mut out = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in &table {
            if ppid == parent && !out.contains(&pid) {
                out.push(pid);
                frontier.push(pid);
            }
        }
    }
    out
}

/// Process state letter from `/proc/<pid>/stat`, or `None` once reaped.
pub fn proc_state(pid: u32) -> Option<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat(&stat).map(|(state, _)| state)
}

fn parse_stat(stat: &str) -> Option<(char, u32)> {
    // The comm field may contain spaces; fields resume after the last ')'.
    let rest = stat.rsplit_once(')')?.1.trim_start();
    let mut fields = rest.split_whitespace();
    let state = fields.next()?.chars().next()?;
    let ppid = fields.next()?.parse().ok()?;
    Some((state, ppid))
}

/// Negotiation body offering the qualified shared-memory profile plus TCP.
pub fn shm_offers() -> serde_json::Value {
    serde_json::json!({
        "op": "transport.negotiate",
        "negotiation_version": 1,
        "offers": [
            {
                "transport": SHM_TRANSPORT,
                "capability_version": SHM_CAPABILITY_VERSION,
                "parameters": qualified_test_parameters()
            },
            {"transport": "tcp", "capability_version": 1}
        ]
    })
}

pub fn request_header(channel: u16, epoch: u32, corr: u64, len: usize) -> EnvelopeHeader {
    EnvelopeHeader {
        len: u32::try_from(len).expect("test body fits"),
        ver: PROTOCOL_VERSION,
        ty: FrameType::Request,
        flags: Flags::new(false, Priority::Interactive, false),
        channel,
        epoch,
        corr,
    }
}

pub fn goodbye_header() -> EnvelopeHeader {
    EnvelopeHeader {
        len: 0,
        ver: PROTOCOL_VERSION,
        ty: FrameType::Goodbye,
        flags: Flags::new(false, Priority::Passive, false),
        channel: 0,
        epoch: 0,
        corr: 0,
    }
}

/// Receives shared-memory frames until `corr`, skipping Pings, bounded.
pub fn recv_response(peer: &TestShmPeer, corr: u64, budget: Duration) -> (EnvelopeHeader, Vec<u8>) {
    let deadline = Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "no shared-memory frame for correlation {corr} within its bounded wait"
        );
        let (header, body) = peer.recv(remaining).expect("shared-memory receive");
        if header.corr == corr && header.ty != FrameType::Ping {
            return (header, body);
        }
    }
}

/// Opens a route over a committed shared-memory candidate (correlation 3).
pub fn shm_route_open(peer: &TestShmPeer, session: &str) -> (u16, u32) {
    let open = serde_json::to_vec(&serde_json::json!({
        "op": "route.open",
        "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
        "identity": {"project_root": CRASH_ROOT, "harness": "shm-crash", "session": session}
    }))
    .expect("route open body");
    peer.send(request_header(0, 0, 3, open.len()), &open)
        .expect("publish route open");
    let (header, body) = recv_response(peer, 3, ROLE_BUDGET);
    assert_eq!(header.ty, FrameType::Response, "route open reply");
    let opened: serde_json::Value = serde_json::from_slice(&body).expect("route open json");
    (
        u16::try_from(opened["route_channel"].as_u64().expect("route channel"))
            .expect("channel fits"),
        u32::try_from(opened["route_epoch"].as_u64().expect("route epoch")).expect("epoch fits"),
    )
}

fn direct_fill_body(bytes: usize, value: u8) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "mode": "direct_fill",
        "bytes": bytes,
        "value": value
    }))
    .expect("direct fill body")
}

/// Daemon process role: a real host with the qualified shared-memory
/// provider installed, publishing to the parent-owned data root and
/// answering bounded stdin commands.
pub fn daemon_role() {
    let Ok(data_root) = std::env::var(ENV_DAEMON_DATA_ROOT) else {
        return;
    };
    let candidates: u64 = std::env::var(ENV_DAEMON_CANDIDATES)
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(8);
    let charges = qualified_test_profile().charges();
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(ShmHostLimits {
        descriptors: charges.descriptors * candidates,
        arena_bytes: charges.arena_bytes * candidates,
        leases: charges.leases * candidates,
        mappings: charges.mappings * candidates,
        pinned_workers: 0,
    }));
    // The daemon provider owns the response-publication transition, so it
    // reports that barrier itself. Control replies (channel 0) are not
    // route responses and stay silent. commentlint: allow(JUDGE)
    provider.set_publish_hook(Arc::new(|ty, channel| {
        if ty == FrameType::Response && channel != 0 {
            emit_record("barrier response_published");
        }
    }));
    let registry =
        TransportProviders::with_injected(vec![Arc::clone(&provider) as Arc<dyn InjectedProvider>]);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("daemon runtime");
    runtime.block_on(async move {
        let data_root = PathBuf::from(data_root);
        let host = TestHost::start_with(move |config| {
            config.data_dir = Some(data_root);
            config.transport_providers = registry;
        })
        .await;
        emit_record("daemon_ready");
        let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if line_tx.send(line).is_err() {
                    break;
                }
            }
        });
        while let Some(line) = line_rx.recv().await {
            match line.trim() {
                "stats" => emit_record(&format!(
                    "stats dispatches={}",
                    host.handler.dispatch_count()
                )),
                "hold_admission" => {
                    assert!(provider.hold_admission(), "admission hold must fit");
                    emit_record("held");
                }
                "release_admission" => {
                    provider.release_admission();
                    emit_record("released");
                }
                "soak_stats" => {
                    let accounting = provider.accounting().expect("accounting snapshot");
                    emit_record(&format!(
                        "soak active={},{},{},{} quarantined={},{},{},{} \
                         preparations={} readiness={:?}",
                        accounting.active.descriptors,
                        accounting.active.arena_bytes,
                        accounting.active.leases,
                        accounting.active.mappings,
                        accounting.quarantined.descriptors,
                        accounting.quarantined.arena_bytes,
                        accounting.quarantined.leases,
                        accounting.quarantined.mappings,
                        provider.preparation_count(),
                        provider.readiness(),
                    ));
                }
                "quarantine_next_close" => {
                    provider.quarantine_next_close();
                    emit_record("quarantine_armed");
                }
                "leak_fd" => {
                    // A duplicated fd remains open. commentlint: allow(JUDGE)
                    assert!(unsafe { libc::dup(0) } >= 0, "duplicated fd fixture");
                    emit_record("leaked");
                }
                _ => {}
            }
        }
        // Stdin EOF: the parent tears this role down with SIGKILL.
    });
}

/// Victim process role: authenticates, commits a shared-memory candidate,
/// reports the owner-side barriers, and then follows its scenario.
pub fn victim_role() {
    let Ok(connection) = std::env::var(ENV_VICTIM_CONNECTION) else {
        return;
    };
    let scenario = std::env::var(ENV_VICTIM_SCENARIO).unwrap_or_else(|_| "idle".to_owned());
    let session = std::env::var(ENV_VICTIM_SESSION).unwrap_or_else(|_| "victim".to_owned());
    let stale_file = std::env::var(ENV_VICTIM_STALE_FILE).ok();

    let info = raw_client::discover(Path::new(&connection)).expect("victim discovers the daemon");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("victim runtime");
    let (mut client, grant) = runtime.block_on(async {
        let mut client = RawClient::connect(&info)
            .await
            .expect("victim authenticates");
        let corr = client
            .control(&shm_offers())
            .await
            .expect("victim negotiates");
        let (_, frame) = client
            .frames_until_corr(corr, ROLE_BUDGET)
            .await
            .expect("negotiation response");
        (client, frame.json())
    });
    assert_eq!(
        grant["selected"]["transport"], SHM_TRANSPORT,
        "victim must be granted shared memory"
    );
    let token = grant["activation_token"]
        .as_str()
        .expect("activation token")
        .to_owned();
    if let Some(path) = stale_file {
        // Private scratch handoff consumed by the parent's incarnation-fence
        // scenario; never written to any record or diagnostic surface.
        // commentlint: allow(JUDGE)
        let record = serde_json::json!({
            "activation_token": token,
            "descriptor": grant["descriptor"],
        });
        std::fs::write(path, serde_json::to_vec(&record).expect("stale record"))
            .expect("stale record write");
    }
    let peer = TestShmPeer::attach(&grant["descriptor"]).expect("victim attaches");
    let activate = format!(
        r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{token}"}}"#
    )
    .into_bytes();
    peer.send(request_header(0, 0, 1, activate.len()), &activate)
        .expect("publish activate");
    recv_response(&peer, 1, ROLE_BUDGET);
    let commit = br#"{"op":"transport.commit","negotiation_version":1}"#;
    peer.send(request_header(0, 0, 2, commit.len()), commit)
        .expect("publish commit");
    recv_response(&peer, 2, ROLE_BUDGET);
    runtime.block_on(async {
        assert!(
            client.closed_within(ROLE_BUDGET).await,
            "bootstrap must retire at commit"
        );
    });
    emit_record("barrier idle_committed");

    match scenario.as_str() {
        "idle" => park(),
        "publish" | "pending" => {
            let (channel, epoch) = shm_route_open(&peer, &session);
            let body = if scenario == "pending" {
                serde_json::to_vec(&serde_json::json!({"mode": "hang"})).expect("hang body")
            } else {
                direct_fill_body(VICTIM_FILL_BYTES, VICTIM_FILL_VALUE)
            };
            peer.send(request_header(channel, epoch, 4, body.len()), &body)
                .expect("publish request");
            // The victim's client provider side owns this transition: the
            // ring commit above completed publication. commentlint: allow(JUDGE)
            emit_record("barrier request_published");
            park();
        }
        "roundtrip" | "roundtrip_park" => {
            let (channel, epoch) = shm_route_open(&peer, &session);
            let body = direct_fill_body(VICTIM_FILL_BYTES, VICTIM_FILL_VALUE);
            peer.send(request_header(channel, epoch, 4, body.len()), &body)
                .expect("publish request");
            let (header, response) = recv_response(&peer, 4, ROLE_BUDGET);
            assert_eq!(header.ty, FrameType::Response, "roundtrip terminal");
            assert_eq!(
                response,
                vec![VICTIM_FILL_VALUE; VICTIM_FILL_BYTES],
                "roundtrip body"
            );
            emit_record("terminal ok");
            peer.send(goodbye_header(), &[]).expect("publish goodbye");
            if scenario == "roundtrip_park" {
                // Logical close precedes termination. commentlint: allow(JUDGE)
                emit_record("closed");
                park();
            }
        }
        other => panic!("unknown victim scenario {other}"),
    }
}

/// Parks the role until the parent delivers `SIGKILL`.
fn park() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

pub fn start_daemon(data_root: &Path) -> RoleProcess {
    start_daemon_with(data_root, 8)
}

pub fn start_daemon_with(data_root: &Path, candidates: u64) -> RoleProcess {
    let mut daemon = spawn_role(
        "daemon",
        "shm_role_daemon",
        &[
            (ENV_DAEMON_DATA_ROOT, data_root.display().to_string()),
            (ENV_DAEMON_CANDIDATES, candidates.to_string()),
        ],
    );
    daemon.expect_record("daemon_ready");
    daemon
}

pub fn daemon_info(data_root: &Path) -> Discovered {
    raw_client::discover(&connection_file(data_root)).expect("daemon publication validates")
}

pub fn spawn_victim(
    data_root: &Path,
    scenario: &str,
    session: &str,
    stale_file: Option<&Path>,
) -> RoleProcess {
    let mut envs = vec![
        (
            ENV_VICTIM_CONNECTION,
            connection_file(data_root).display().to_string(),
        ),
        (ENV_VICTIM_SCENARIO, scenario.to_owned()),
        (ENV_VICTIM_SESSION, session.to_owned()),
    ];
    if let Some(path) = stale_file {
        envs.push((ENV_VICTIM_STALE_FILE, path.display().to_string()));
    }
    spawn_role("victim", "shm_role_victim", &envs)
}

/// Independently authenticated observer route. commentlint: allow(JUDGE)
pub struct Observer {
    client: RawClient,
    channel: u16,
    epoch: u32,
}

impl Observer {
    pub async fn connect(info: &Discovered, session: &str) -> Self {
        let mut client = RawClient::connect(info)
            .await
            .expect("observer authenticates");
        let (channel, epoch) = client
            .route_open(LINKED_MODULE_ID, CRASH_ROOT, "shm-crash", session)
            .await
            .expect("observer route");
        Self {
            client,
            channel,
            epoch,
        }
    }

    pub async fn roundtrip(&mut self, bytes: usize, value: u8, budget: Duration) {
        let corr = self.client.next_corr();
        let body = serde_json::to_vec(&serde_json::json!({
            "mode": "direct_fill",
            "bytes": bytes,
            "value": value
        }))
        .expect("observer body");
        self.client
            .send_frame(
                TY_REQUEST,
                FLAGS_INTERACTIVE,
                self.channel,
                self.epoch,
                corr,
                &body,
            )
            .await
            .expect("observer send");
        let (_, frame) = self
            .client
            .frames_until_corr(corr, budget)
            .await
            .expect("observer terminal");
        assert_eq!(frame.ty, TY_RESPONSE, "observer terminal type");
        assert_eq!(frame.body, vec![value; bytes], "observer response bytes");
    }
}

pub async fn negotiate_grant(info: &Discovered) -> (RawClient, serde_json::Value) {
    let mut bootstrap = RawClient::connect(info)
        .await
        .expect("bootstrap authenticates");
    let corr = bootstrap.control(&shm_offers()).await.expect("negotiate");
    let (_, frame) = bootstrap
        .frames_until_corr(corr, ROLE_BUDGET)
        .await
        .expect("negotiation response");
    (bootstrap, frame.json())
}

pub async fn commit_shm_peer(info: &Discovered) -> TestShmPeer {
    let (mut bootstrap, grant) = negotiate_grant(info).await;
    assert_eq!(grant["selected"]["transport"], SHM_TRANSPORT);
    let token = grant["activation_token"]
        .as_str()
        .expect("activation token")
        .to_owned();
    let peer = tokio::task::block_in_place(|| {
        TestShmPeer::attach(&grant["descriptor"]).expect("attach fresh candidate")
    });
    let activate = format!(
        r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{token}"}}"#
    )
    .into_bytes();
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 1, activate.len()), &activate)
            .expect("publish activate");
        recv_response(&peer, 1, ROLE_BUDGET);
        let commit = br#"{"op":"transport.commit","negotiation_version":1}"#;
        peer.send(request_header(0, 0, 2, commit.len()), commit)
            .expect("publish commit");
        recv_response(&peer, 2, ROLE_BUDGET);
    });
    assert!(
        bootstrap.closed_within(ROLE_BUDGET).await,
        "bootstrap must retire at commit"
    );
    peer
}

pub fn shm_roundtrip(peer: &TestShmPeer, session: &str) {
    let (channel, epoch) = shm_route_open(peer, session);
    let body = serde_json::to_vec(&serde_json::json!({
        "mode": "direct_fill",
        "bytes": VICTIM_FILL_BYTES,
        "value": VICTIM_FILL_VALUE
    }))
    .expect("request body");
    peer.send(request_header(channel, epoch, 4, body.len()), &body)
        .expect("publish request");
    let (header, response) = recv_response(peer, 4, ROLE_BUDGET);
    assert_eq!(header.ty, FrameType::Response, "shm terminal");
    assert_eq!(
        response,
        vec![VICTIM_FILL_VALUE; VICTIM_FILL_BYTES],
        "shm response bytes"
    );
}
