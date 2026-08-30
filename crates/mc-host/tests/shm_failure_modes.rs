#![cfg(unix)]

mod support;

use std::io::{BufRead, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use mc_host::{Client, RequestOptions, RouteIdentity, RouteTarget, TargetKind};
use support::TestHost;

const ROLE_ENV: &str = "MC_SHM_FAILURE_ROLE";
const PUBLICATION_ENV: &str = "MC_SHM_FAILURE_PUBLICATION";
const BUDGET: Duration = Duration::from_secs(10);
const RSS_TOLERANCE_BYTES: u64 = 1024 * 1024;

async fn serial_failure_test() -> tokio::sync::OwnedSemaphorePermit {
    static SERIAL: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    SERIAL
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .acquire_owned()
        .await
        .expect("failure-test semaphore remains open")
}

#[test]
#[ignore = "client role for shared-memory failure tests"]
fn shm_role_client() {
    let Ok(role) = std::env::var(ROLE_ENV) else {
        return;
    };
    let publication = PathBuf::from(std::env::var_os(PUBLICATION_ENV).expect("publication path"));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("client runtime");
    runtime.block_on(async move {
        if role == "setup" {
            let info = mc_host::read_connection_file(&publication).expect("discover host");
            let mut stream = tokio::net::UnixStream::connect(&info.setup_socket)
                .await
                .expect("connect setup socket");
            mc_host::authenticate_client(&mut stream, &info, BUDGET)
                .await
                .expect("authenticate setup socket");
            let deadline = tokio::time::Instant::now() + BUDGET;
            let (_grant, _descriptors) =
                mc_host::setup_socket::receive_grant(&mut stream, deadline)
                    .await
                    .expect("receive ring grant before activation");
            announce("READY setup");
            std::future::pending::<()>().await;
        }

        let deadline = Instant::now() + BUDGET;
        let client = loop {
            match Client::connect(&publication).await {
                Ok(client) => break client,
                Err(_) if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => panic!("activate ring: {error}"),
            }
        };
        if role == "active" {
            let route = client
                .open_route(
                    RouteTarget {
                        module_id: support::LINKED_MODULE_ID.to_owned(),
                        kind: TargetKind::ToolProvider,
                    },
                    RouteIdentity {
                        project_root: PathBuf::from("/tmp/shm-failure-mode"),
                        harness: "failure-mode".to_owned(),
                        session: "active".to_owned(),
                        consumer_module_id: None,
                        consumer_launch_nonce: None,
                        consumer_capabilities: Vec::new(),
                        admission_facts: None,
                        credential_fingerprints: Default::default(),
                    },
                )
                .await
                .expect("open route");
            let request = client.request(
                route,
                support::mode_body(serde_json::json!({"mode": "hang"})),
                RequestOptions {
                    timeout: Duration::from_secs(3600),
                    cancellation: None,
                },
            );
            tokio::pin!(request);
            tokio::select! {
                result = &mut request => panic!("active request settled before kill: {result:?}"),
                () = tokio::time::sleep(Duration::from_millis(100)) => announce("READY active"),
            }
            std::future::pending::<()>().await;
        }
        announce("READY idle");
        std::future::pending::<()>().await;
    });
}

fn announce(message: &str) {
    println!("{message}");
    std::io::stdout().flush().expect("flush role barrier");
}

struct Victim(Child);

impl Victim {
    fn spawn(publication: &Path, role: &str) -> Self {
        let child = Command::new(std::env::current_exe().expect("test executable"))
            .args(["--ignored", "--exact", "shm_role_client", "--nocapture"])
            .env(ROLE_ENV, role)
            .env(PUBLICATION_ENV, publication)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn victim");
        let mut victim = Self(child);
        let stdout = victim.0.stdout.take().expect("victim stdout");
        let expected = format!("READY {role}");
        let (announced, barrier) = std::sync::mpsc::channel();
        // `BufRead::lines()` cannot time out; a silent child would block
        // readiness. The reader thread lets `recv_timeout(BUDGET)` bound the
        // wait; a timeout drops `victim`, whose `Drop` kills the child.
        std::thread::Builder::new()
            .name("shm-victim-readiness".to_owned())
            .spawn(move || {
                for line in std::io::BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line == expected {
                        let _ = announced.send(true);
                        return;
                    }
                }
                let _ = announced.send(false);
            })
            .expect("spawn readiness reader");
        match barrier.recv_timeout(BUDGET) {
            Ok(true) => victim,
            Ok(false) => panic!("victim exited before {role}"),
            Err(_) => panic!("victim did not reach {role} within {BUDGET:?}"),
        }
    }

    fn kill(mut self) {
        self.0.kill().expect("SIGKILL victim");
        let status = self.0.wait().expect("reap victim");
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
}

impl Drop for Victim {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

async fn connect_after_reclamation(path: &Path) -> Client {
    let deadline = Instant::now() + BUDGET;
    loop {
        match Client::connect(path).await {
            Ok(client) => return client,
            Err(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(error) => panic!("ring capacity was not reclaimed: {error}"),
        }
    }
}

/// Waits for `host` to dispatch before killing, so the `active` case cannot
/// degrade into an idle disconnect. commentlint: allow(JUDGE)
async fn crash_victim(host: &TestHost, role: &str) {
    let dispatched_before = host.handler.dispatch_count();
    let victim = Victim::spawn(&host.publication_path(), role);
    if role == "active" {
        let deadline = Instant::now() + BUDGET;
        while host.handler.dispatch_count() == dispatched_before {
            assert!(
                Instant::now() < deadline,
                "host never dispatched the active request"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    victim.kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clean_close_returns_exact_single_connection_capacity() {
    let _serial = serial_failure_test().await;
    let host = TestHost::start_with(|config| config.limits.max_connections = 1).await;
    let client = Client::connect(host.publication_path()).await.unwrap();
    client.close().await.unwrap();
    let replacement = connect_after_reclamation(&host.publication_path()).await;
    replacement.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_active_and_idle_sigkill_each_return_exact_capacity() {
    let _serial = serial_failure_test().await;
    for role in ["setup", "active", "idle"] {
        let host = TestHost::start_with(|config| config.limits.max_connections = 1).await;
        crash_victim(&host, role).await;
        let replacement = connect_after_reclamation(&host.publication_path()).await;
        replacement.close().await.unwrap();
        host.shutdown_gracefully().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_crashes_do_not_ratchet_single_connection_capacity() {
    let _serial = serial_failure_test().await;
    let host = TestHost::start_with(|config| config.limits.max_connections = 1).await;
    // The test records the baseline after one crash cycle so first-cycle setup
    // does not affect a measured cycle. commentlint: allow(JUDGE)
    crash_victim(&host, "active").await;
    connect_after_reclamation(&host.publication_path())
        .await
        .close()
        .await
        .unwrap();
    let baseline = support::process_resources::stabilize(std::process::id(), BUDGET).await;

    for cycle in 0..12 {
        crash_victim(&host, if cycle % 2 == 0 { "active" } else { "idle" }).await;
        let probe = connect_after_reclamation(&host.publication_path()).await;
        probe.close().await.unwrap();
        // Readmission alone would still pass while descriptors, mappings, or
        // threads ratchet on every kill. commentlint: allow(JUDGE)
        support::process_resources::await_envelope(
            std::process::id(),
            baseline,
            RSS_TOLERANCE_BYTES,
            BUDGET,
            &format!("crash cycle {cycle}"),
        )
        .await;
    }
    host.shutdown_gracefully().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_capacity_succeeds_and_plus_one_creates_no_ring_resources() {
    let _serial = serial_failure_test().await;
    let host = TestHost::start_with(|config| config.limits.max_connections = 2).await;
    let first = Client::connect(host.publication_path()).await.unwrap();
    let second = Client::connect(host.publication_path()).await.unwrap();
    let before = support::process_resources::observe(std::process::id()).unwrap();

    assert!(Client::connect(host.publication_path()).await.is_err());
    support::process_resources::await_envelope(
        std::process::id(),
        before,
        RSS_TOLERANCE_BYTES,
        BUDGET,
        "rejected +1 attempt",
    )
    .await;

    first.close().await.unwrap();
    second.close().await.unwrap();
    host.shutdown_gracefully().await;
}

async fn echo_route(client: &Client, session: &str) -> mc_host::RouteHandle {
    client
        .open_route(
            RouteTarget {
                module_id: support::echo_host::ECHO_MODULE_ID.to_owned(),
                kind: TargetKind::ToolProvider,
            },
            RouteIdentity {
                project_root: PathBuf::from("/tmp/shm-restart"),
                harness: "failure-mode".to_owned(),
                session: session.to_owned(),
                consumer_module_id: None,
                consumer_launch_nonce: None,
                consumer_capabilities: Vec::new(),
                admission_facts: None,
                credential_fingerprints: Default::default(),
            },
        )
        .await
        .unwrap_or_else(|error| panic!("open {session} route: {error}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_restart_discards_old_rings_and_accepts_fresh_client() {
    let _serial = serial_failure_test().await;
    let data_root = tempfile::tempdir().expect("data root");
    let body = support::mode_body(serde_json::json!({"mode": "echo"}));
    let publication;
    // Keep the stale client connected: connection cleanup would reclaim its
    // ring before restart. commentlint: allow(JUDGE)
    let (stale, stale_route) = {
        let host = support::echo_host::InProcessHost::start(data_root.path());
        publication = host.publication.clone();
        let stale = Client::connect(&publication).await.unwrap();
        let route = echo_route(&stale, "stale").await;
        let response = stale
            .request(route, body.clone(), RequestOptions::default())
            .await
            .expect("first-generation ring request");
        assert_eq!(response.body, body, "stale ring served its own request");
        (stale, route)
    };
    let stale_daemon = stale.daemon_id();

    let host = support::echo_host::InProcessHost::start(data_root.path());
    assert!(
        stale
            .request(stale_route, body.clone(), RequestOptions::default())
            .await
            .is_err(),
        "stale generation stayed usable across the restart"
    );

    let fresh = connect_after_reclamation(&publication).await;
    // A successor that republished the predecessor's identity would hand this
    // client the discarded generation. commentlint: allow(JUDGE)
    assert_ne!(
        stale_daemon,
        fresh.daemon_id(),
        "successor reused the predecessor daemon identity"
    );
    let route = echo_route(&fresh, "fresh").await;
    let response = fresh
        .request(route, body.clone(), RequestOptions::default())
        .await
        .expect("successor ring request");
    assert_eq!(response.body, body);
    fresh.close().await.unwrap();
    drop(stale);
    drop(host);
}
