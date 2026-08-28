#![cfg(feature = "bench-topology")]

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mc_host::synapse::inference::InferenceError;
use mc_host::synapse::{
    BenchTopology, EmbeddingEngine, SynapseComponent, SynapseLimits, SynapseObserver,
};
use support::raw_client::TY_ERROR;
use support::synapse::{
    batch_params, call, constraints, items, open_synapse_route, ready_topology, request_key,
    test_lane, DeterministicEngine, SynapseHost, BUDGET,
};

async fn wait_for_calls(engine: &DeterministicEngine, count: usize) {
    let deadline = tokio::time::Instant::now() + BUDGET;
    while engine.calls.load(Ordering::SeqCst) < count {
        assert!(
            tokio::time::Instant::now() < deadline,
            "engine call timeout"
        );
        tokio::task::yield_now().await;
    }
}

async fn wait_for_job_error(
    client: &mut support::raw_client::RawClient,
    channel: u16,
    epoch: u32,
    lane: &mc_host::synapse::LaneInfo,
    job_id: &str,
    key: &str,
) -> String {
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let mut params = constraints(lane);
        params["job_id"] = job_id.into();
        params["request_key"] = key.into();
        params["cursor"] = serde_json::Value::Null;
        let frame = call(client, channel, epoch, "embed.result", params).await;
        if frame.ty == TY_ERROR {
            return frame.error_code();
        }
        assert!(tokio::time::Instant::now() < deadline, "job error timeout");
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn every_topology_condemns_the_lane_after_an_invariant_failure() {
    let topologies = [
        BenchTopology::B0,
        BenchTopology::T1 { intra_threads: 2 },
        BenchTopology::T2,
        BenchTopology::T3 { chunk_rows: 1 },
        BenchTopology::T4 { permits: 2 },
    ];
    for topology in topologies {
        let engine = DeterministicEngine::new();
        engine.fail_next(InferenceError::Invariant("broken instance".to_owned()));
        let host = SynapseHost::start(ready_topology(
            engine.clone(),
            SynapseLimits::default(),
            topology,
        ))
        .await;
        let mut client = host.client().await;
        let (channel, epoch) = open_synapse_route(&mut client).await;
        let lane = test_lane();
        let first = items(&[("first", "alpha")]);
        let key = request_key(&lane, &first);
        let descriptor = call(
            &mut client,
            channel,
            epoch,
            "embed.batch",
            batch_params(&lane, &first),
        )
        .await
        .json();
        let job_id = descriptor["result"]["job_id"].as_str().expect("job id");
        assert_eq!(
            wait_for_job_error(&mut client, channel, epoch, &lane, job_id, &key).await,
            "artifact_invalid"
        );

        let rejected = call(
            &mut client,
            channel,
            epoch,
            "embed.batch",
            batch_params(&lane, &items(&[("second", "beta")])),
        )
        .await;
        assert_eq!(rejected.error_code(), "artifact_invalid");
        assert_eq!(engine.calls.load(Ordering::SeqCst), 1);
        host.shutdown().await.expect("graceful shutdown");
    }
}

#[tokio::test]
async fn t2_alternates_classes_when_both_are_waiting() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    let limits = SynapseLimits {
        max_waiting_queries: 1,
        ..Default::default()
    };
    let observer = Arc::new(SynapseObserver::new());
    let component = SynapseComponent::ready_with_engine_bench(
        test_lane(),
        engine.clone(),
        limits,
        BenchTopology::T2,
        Some(observer.clone()),
    )
    .expect("T2 component");
    let host = SynapseHost::start(component).await;
    let mut batch_client = host.client().await;
    let (batch_channel, batch_epoch) = open_synapse_route(&mut batch_client).await;
    let lane = test_lane();

    call(
        &mut batch_client,
        batch_channel,
        batch_epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("first", "first batch")])),
    )
    .await;
    wait_for_calls(&engine, 1).await;
    let info = host.info.clone();
    let query = tokio::spawn(async move {
        let mut client = support::raw_client::RawClient::connect(&info)
            .await
            .expect("query client");
        let (channel, epoch) = open_synapse_route(&mut client).await;
        let mut params = constraints(&test_lane());
        params["text"] = "interactive query".into();
        params["deadline_ms"] = 5_000.into();
        call(&mut client, channel, epoch, "embed.query", params).await
    });
    while observer.snapshot().query_queued == 0 {
        tokio::task::yield_now().await;
    }
    call(
        &mut batch_client,
        batch_channel,
        batch_epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("second", "second batch")])),
    )
    .await;
    while observer.snapshot().batch_queued == 0 {
        tokio::task::yield_now().await;
    }
    DeterministicEngine::release_calls(&gate);
    query.await.expect("query task");
    wait_for_calls(&engine, 3).await;

    assert_eq!(
        engine.call_texts.lock().expect("call texts").as_slice(),
        ["first batch", "interactive query", "second batch"]
    );
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn t3_reenters_the_lane_for_every_chunk() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_topology(
        engine.clone(),
        SynapseLimits::default(),
        BenchTopology::T3 { chunk_rows: 2 },
    ))
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();
    let page = items(&[
        ("0", "zero"),
        ("1", "one"),
        ("2", "two"),
        ("3", "three"),
        ("4", "four"),
    ]);
    let key = request_key(&lane, &page);
    let descriptor = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await
    .json();
    let job_id = descriptor["result"]["job_id"]
        .as_str()
        .expect("job id")
        .to_owned();
    wait_for_calls(&engine, 3).await;

    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let mut params = constraints(&lane);
        params["job_id"] = job_id.clone().into();
        params["request_key"] = key.clone().into();
        params["cursor"] = serde_json::Value::Null;
        let result = call(&mut client, channel, epoch, "embed.result", params)
            .await
            .json();
        if result["result"]["vectors"].is_array() {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "job result timeout");
        tokio::task::yield_now().await;
    }
    assert_eq!(engine.calls.load(Ordering::SeqCst), 3);
    host.shutdown().await.expect("graceful shutdown");
}

struct InterleavingEngine {
    first_released: (std::sync::Mutex<bool>, std::sync::Condvar),
    call_texts: std::sync::Mutex<Vec<String>>,
}

impl InterleavingEngine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            first_released: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
            call_texts: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn release_first(&self) {
        let (released, wake) = &self.first_released;
        *released.lock().expect("release lock") = true;
        wake.notify_all();
    }
}

impl EmbeddingEngine for InterleavingEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        self.call_texts
            .lock()
            .expect("call texts")
            .extend(texts.iter().map(|text| (*text).to_owned()));
        if texts == ["zero"] {
            let (released, wake) = &self.first_released;
            let mut released = released.lock().expect("release lock");
            while !*released {
                released = wake.wait(released).expect("release wait");
            }
        }
        if texts == ["interactive failure"] {
            return Err(InferenceError::Invariant("query condemned lane".to_owned()));
        }
        Ok(texts.iter().map(|_| vec![1.0; 8]).collect())
    }
}

#[tokio::test]
async fn t3_rechecks_lane_failure_between_chunks() {
    let engine = InterleavingEngine::new();
    let observer = Arc::new(SynapseObserver::new());
    let component = SynapseComponent::ready_with_engine_bench(
        test_lane(),
        engine.clone(),
        SynapseLimits {
            max_waiting_queries: 1,
            ..Default::default()
        },
        BenchTopology::T3 { chunk_rows: 1 },
        Some(observer.clone()),
    )
    .expect("T3 component");
    let host = SynapseHost::start(component).await;
    let mut batch_client = host.client().await;
    let (batch_channel, batch_epoch) = open_synapse_route(&mut batch_client).await;
    let lane = test_lane();
    let page = items(&[("0", "zero"), ("1", "one"), ("2", "two")]);
    let key = request_key(&lane, &page);
    let descriptor = call(
        &mut batch_client,
        batch_channel,
        batch_epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await
    .json();
    let job_id = descriptor["result"]["job_id"]
        .as_str()
        .expect("job id")
        .to_owned();
    while engine.call_texts.lock().expect("call texts").is_empty() {
        tokio::task::yield_now().await;
    }

    let info = host.info.clone();
    let query = tokio::spawn(async move {
        let mut client = support::raw_client::RawClient::connect(&info)
            .await
            .expect("query client");
        let (channel, epoch) = open_synapse_route(&mut client).await;
        let mut params = constraints(&test_lane());
        params["text"] = "interactive failure".into();
        params["deadline_ms"] = 5_000.into();
        call(&mut client, channel, epoch, "embed.query", params).await
    });
    while observer.snapshot().query_queued == 0 {
        tokio::task::yield_now().await;
    }
    tokio::task::yield_now().await;
    engine.release_first();
    assert_eq!(
        query.await.expect("query task").error_code(),
        "artifact_invalid"
    );
    assert_eq!(
        wait_for_job_error(
            &mut batch_client,
            batch_channel,
            batch_epoch,
            &lane,
            &job_id,
            &key,
        )
        .await,
        "artifact_invalid"
    );
    assert_eq!(
        engine.call_texts.lock().expect("call texts").as_slice(),
        ["zero", "interactive failure"]
    );
    host.shutdown().await.expect("graceful shutdown");
}

struct SerializingEngine {
    lock: std::sync::Mutex<()>,
    calls: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
}

struct ConcurrentEngine {
    released: (std::sync::Mutex<bool>, std::sync::Condvar),
    calls: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
}

impl ConcurrentEngine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            released: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
            calls: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        })
    }

    fn release(&self) {
        let (released, wake) = &self.released;
        *released.lock().expect("release lock") = true;
        wake.notify_all();
    }
}

impl EmbeddingEngine for ConcurrentEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (released, wake) = &self.released;
        let mut released = released.lock().expect("release lock");
        while !*released {
            released = wake.wait(released).expect("release wait");
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        Ok(texts.iter().map(|_| vec![1.0; 8]).collect())
    }
}

#[tokio::test]
async fn t4_serves_two_calls_concurrently_and_shutdown_joins_both() {
    let engine = ConcurrentEngine::new();
    let host = SynapseHost::start(ready_topology(
        engine.clone(),
        SynapseLimits::default(),
        BenchTopology::T4 { permits: 2 },
    ))
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();
    for (id, text) in [("a", "alpha"), ("b", "beta")] {
        call(
            &mut client,
            channel,
            epoch,
            "embed.batch",
            batch_params(&lane, &items(&[(id, text)])),
        )
        .await;
    }
    let deadline = tokio::time::Instant::now() + BUDGET;
    while engine.calls.load(Ordering::SeqCst) < 2 {
        assert!(tokio::time::Instant::now() < deadline, "service timeout");
        tokio::task::yield_now().await;
    }
    assert_eq!(engine.peak.load(Ordering::SeqCst), 2);

    let shutdown = tokio::spawn(host.shutdown());
    tokio::task::yield_now().await;
    assert!(!shutdown.is_finished(), "shutdown must join native calls");
    engine.release();
    shutdown
        .await
        .expect("shutdown task joins")
        .expect("graceful shutdown");
}

impl SerializingEngine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            lock: std::sync::Mutex::new(()),
            calls: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        })
    }
}

impl EmbeddingEngine for SerializingEngine {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, InferenceError> {
        let _lock = self.lock.lock().expect("serialization lock");
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50));
        let result = Ok(texts
            .iter()
            .map(|_| vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
            .collect());
        self.active.fetch_sub(1, Ordering::SeqCst);
        result
    }
}

#[tokio::test]
async fn t5_detects_serialized_service_behind_two_permits() {
    let engine = SerializingEngine::new();
    let host = SynapseHost::start(ready_topology(
        engine.clone(),
        SynapseLimits::default(),
        BenchTopology::T5 { permits: 2 },
    ))
    .await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();
    for (id, text) in [("a", "alpha"), ("b", "beta")] {
        call(
            &mut client,
            channel,
            epoch,
            "embed.batch",
            batch_params(&lane, &items(&[(id, text)])),
        )
        .await;
    }
    let deadline = tokio::time::Instant::now() + BUDGET;
    while engine.calls.load(Ordering::SeqCst) < 2 {
        assert!(tokio::time::Instant::now() < deadline, "service timeout");
        tokio::task::yield_now().await;
    }
    assert_eq!(engine.peak.load(Ordering::SeqCst), 1);
    host.shutdown().await.expect("graceful shutdown");
}
