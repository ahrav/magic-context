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
        let deadline = Instant::now() + BUDGET;
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.expect("victim output");
            if line == format!("READY {role}") {
                return victim;
            }
            assert!(Instant::now() < deadline, "victim did not reach {role}");
        }
        panic!("victim exited before {role}");
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
        Victim::spawn(&host.publication_path(), role).kill();
        let replacement = connect_after_reclamation(&host.publication_path()).await;
        replacement.close().await.unwrap();
        host.shutdown_gracefully().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_crashes_do_not_ratchet_single_connection_capacity() {
    let _serial = serial_failure_test().await;
    let host = TestHost::start_with(|config| config.limits.max_connections = 1).await;
    for cycle in 0..12 {
        Victim::spawn(
            &host.publication_path(),
            if cycle % 2 == 0 { "active" } else { "idle" },
        )
        .kill();
        let probe = connect_after_reclamation(&host.publication_path()).await;
        probe.close().await.unwrap();
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
    let deadline = Instant::now() + BUDGET;
    loop {
        let after = support::process_resources::observe(std::process::id()).unwrap();
        if after.fds == before.fds
            && after.mapped_regions == before.mapped_regions
            && after.threads == before.threads
            && after.rss_bytes <= before.rss_bytes.saturating_add(1024 * 1024)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "rejected +1 attempt retained resources"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    first.close().await.unwrap();
    second.close().await.unwrap();
    host.shutdown_gracefully().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_restart_discards_old_rings_and_accepts_fresh_client() {
    let _serial = serial_failure_test().await;
    let data_root = tempfile::tempdir().expect("data root");
    let publication;
    {
        let host = support::echo_host::InProcessHost::start(data_root.path());
        publication = host.publication.clone();
        let client = Client::connect(&publication).await.unwrap();
        client.close().await.unwrap();
    }
    let host = support::echo_host::InProcessHost::start(data_root.path());
    let client = Client::connect(&publication).await.unwrap();
    client.close().await.unwrap();
    drop(host);
}
