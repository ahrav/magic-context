mod support;

use std::time::{Duration, Instant};

use mc_host::{Client, RequestOptions, RouteIdentity, RouteTarget, TargetKind};
use support::process_resources::{observe, ResourceCounts};
use support::TestHost;

const QUIESCENCE: Duration = Duration::from_secs(10);
const RSS_TOLERANCE_BYTES: u64 = 16 * 1024 * 1024;

fn stable_counts(pid: u32) -> ResourceCounts {
    let deadline = Instant::now() + QUIESCENCE;
    let mut previous = None;
    let mut equal = 0;
    loop {
        let counts = observe(pid).expect("observe process resources");
        if previous == Some(counts) {
            equal += 1;
            if equal == 2 {
                return counts;
            }
        } else {
            previous = Some(counts);
            equal = 0;
        }
        assert!(
            Instant::now() < deadline,
            "resource counters did not stabilize"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_envelope(pid: u32, baseline: ResourceCounts) {
    let deadline = Instant::now() + QUIESCENCE;
    loop {
        let counts = observe(pid).expect("observe process resources");
        if counts.fds == baseline.fds
            && counts.mapped_regions == baseline.mapped_regions
            && counts.threads == baseline.threads
            && counts.rss_bytes <= baseline.rss_bytes.saturating_add(RSS_TOLERANCE_BYTES)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "resources did not return to envelope: baseline={baseline:?} actual={counts:?}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

async fn cycle(host: &TestHost, ordinal: u64) {
    let deadline = Instant::now() + QUIESCENCE;
    let client = loop {
        match Client::connect(host.publication_path()).await {
            Ok(client) => break client,
            Err(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("connect ring: {error}"),
        }
    };
    let route = client
        .open_route(
            RouteTarget {
                module_id: support::LINKED_MODULE_ID.to_owned(),
                kind: TargetKind::ToolProvider,
            },
            RouteIdentity {
                project_root: "/tmp/shm-soak".into(),
                harness: "shm-soak".to_owned(),
                session: format!("cycle-{ordinal}"),
                consumer_module_id: None,
                consumer_launch_nonce: None,
                consumer_capabilities: Vec::new(),
                admission_facts: None,
                credential_fingerprints: Default::default(),
            },
        )
        .await
        .expect("open route");
    let body = support::mode_body(serde_json::json!({"mode": "echo", "cycle": ordinal}));
    let response = client
        .request(route, body.clone(), RequestOptions::default())
        .await
        .expect("ring request");
    assert_eq!(response.body, body);
    client.close_route(route).await.expect("close route");
    client.close().await.expect("close client");
}

async fn run_soak(cycles: Option<u64>, duration: Option<Duration>) {
    let host = TestHost::start_with(|config| config.limits.max_connections = 1).await;
    for ordinal in 0..4 {
        cycle(&host, ordinal).await;
    }
    let baseline = stable_counts(std::process::id());
    let started = Instant::now();
    let mut ordinal = 0;
    loop {
        if cycles.is_some_and(|limit| ordinal >= limit)
            || duration.is_some_and(|limit| started.elapsed() >= limit)
        {
            break;
        }
        cycle(&host, ordinal).await;
        wait_for_envelope(std::process::id(), baseline);
        ordinal += 1;
    }
    assert!(ordinal > 0, "soak must execute at least one measured cycle");
    host.shutdown_gracefully().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn short_soak_keeps_fd_mapping_thread_and_rss_envelopes_bounded() {
    run_soak(Some(8), None).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "eight-hour source-tree resource soak"]
async fn release_eight_hour_source_tree_soak() {
    let seconds = std::env::var("MC_SHM_SOAK_SECONDS")
        .map(|value| {
            value
                .parse::<u64>()
                .expect("MC_SHM_SOAK_SECONDS must be an integer")
        })
        .unwrap_or(8 * 60 * 60);
    assert!(seconds > 0, "MC_SHM_SOAK_SECONDS must be positive");
    run_soak(None, Some(Duration::from_secs(seconds))).await;
}
