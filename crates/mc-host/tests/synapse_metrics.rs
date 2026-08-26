//! Wire-level attribution checks for Synapse's fixed-cardinality snapshot.

mod support;

use std::sync::Arc;
use std::time::Duration;

use mc_host::synapse::inference::InferenceError;
use mc_host::synapse::{
    BatchWaitOutcome, HistogramSnapshot, PollMetricOutcome, QueryWaitOutcome, QueueFullReason,
    SynapseLimits, SynapseMetrics, SynapseMetricsSnapshot, HISTOGRAM_EDGES_MS,
};
use support::raw_client::{RawClient, RawFrame};
use support::synapse::{
    batch_params, call, constraints, items, open_synapse_route, ready_component, request_key,
    test_lane, EngineGate, GatedEngine, SynapseHost, BUDGET,
};

const TIMING_FLOOR: Duration = Duration::from_millis(20);

struct Harness {
    host: SynapseHost,
    client: RawClient,
    channel: u16,
    epoch: u32,
    metrics: Arc<SynapseMetrics>,
    engine: Arc<GatedEngine>,
    gate: EngineGate,
}

impl Harness {
    async fn start(limits: SynapseLimits) -> Self {
        let (engine, gate) = GatedEngine::new();
        let component = ready_component(engine.clone(), limits);
        let metrics = component.metrics_handle();
        let host = SynapseHost::start(component).await;
        let mut client = host.client().await;
        let (channel, epoch) = open_synapse_route(&mut client).await;
        Self {
            host,
            client,
            channel,
            epoch,
            metrics,
            engine,
            gate,
        }
    }
}

fn query_params(text: &str, deadline_ms: u64) -> serde_json::Value {
    let mut params = constraints(&test_lane());
    params["text"] = text.into();
    params["deadline_ms"] = deadline_ms.into();
    params
}

fn result_params(job_id: &str, request_key: &str, cursor: Option<&str>) -> serde_json::Value {
    let mut params = constraints(&test_lane());
    params["job_id"] = job_id.into();
    params["request_key"] = request_key.into();
    params["cursor"] = cursor.map_or(serde_json::Value::Null, Into::into);
    params
}

async fn snapshot_when(
    metrics: &SynapseMetrics,
    predicate: impl Fn(&SynapseMetricsSnapshot) -> bool,
) -> SynapseMetricsSnapshot {
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let snapshot = metrics.snapshot();
        if predicate(&snapshot) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "metrics did not quiesce: {snapshot:?}"
        );
        tokio::task::yield_now().await;
    }
}

fn assert_one_at_or_above(histogram: HistogramSnapshot, floor: Duration) {
    assert_eq!(histogram.count, 1);
    assert_eq!(histogram.buckets.iter().sum::<u64>(), 1);
    let first_eligible = HISTOGRAM_EDGES_MS
        .iter()
        .take_while(|edge| Duration::from_millis(**edge) <= floor)
        .count();
    assert_eq!(
        histogram.buckets[first_eligible..].iter().sum::<u64>(),
        1,
        "observation fell below {floor:?}: {histogram:?}"
    );
}

async fn poll(
    client: &mut RawClient,
    channel: u16,
    epoch: u32,
    job_id: &str,
    key: &str,
    cursor: Option<&str>,
) -> RawFrame {
    call(
        client,
        channel,
        epoch,
        "embed.result",
        result_params(job_id, key, cursor),
    )
    .await
}

#[tokio::test]
async fn query_wait_hold_and_inference_are_separate_observations() {
    let mut harness = Harness::start(SynapseLimits::default()).await;
    let lane = test_lane();
    let blocker = items(&[("blocker", "batch holds the cpu")]);
    let frame = call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &blocker),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());
    assert_eq!(harness.gate.started().await, 1);

    let mut query_client = harness.host.client().await;
    let (channel, epoch) = open_synapse_route(&mut query_client).await;
    let query = tokio::spawn(async move {
        call(
            &mut query_client,
            channel,
            epoch,
            "embed.query",
            query_params("waits behind batch", 3_000),
        )
        .await
    });
    snapshot_when(&harness.metrics, |snapshot| {
        snapshot.free_query_permits == 0 && snapshot.cpu_wait_outcome.query.iter().sum::<u64>() == 0
    })
    .await;

    tokio::time::sleep(TIMING_FLOOR).await;
    harness.gate.release();
    assert_eq!(harness.gate.started().await, 1);
    tokio::time::sleep(TIMING_FLOOR).await;
    harness.gate.release();
    assert_eq!(
        query.await.expect("query task").json()["result"]["done"],
        true
    );

    let snapshot = snapshot_when(&harness.metrics, |snapshot| {
        snapshot.cpu_wait_outcome.query[QueryWaitOutcome::Granted.slot()] == 1
            && snapshot.cpu_wait_outcome.query.iter().sum::<u64>() == 1
            && snapshot.cpu_wait.query.count == 1
            && snapshot.cpu_hold.query.count == 1
            && snapshot.inference.query.count == 1
            && snapshot.free_cpu_permits == 1
            && snapshot.free_query_permits == 1
    })
    .await;
    assert_one_at_or_above(snapshot.cpu_wait.query, TIMING_FLOOR);
    assert_one_at_or_above(snapshot.cpu_hold.query, TIMING_FLOOR);
    assert_one_at_or_above(snapshot.inference.query, TIMING_FLOOR);
    assert_eq!(snapshot.cpu_wait.query.count, snapshot.cpu_hold.query.count);

    harness.host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn batch_wait_hold_inference_and_item_count_are_separate() {
    let mut harness = Harness::start(SynapseLimits::default()).await;
    let mut query_client = harness.host.client().await;
    let (query_channel, query_epoch) = open_synapse_route(&mut query_client).await;
    let query = tokio::spawn(async move {
        call(
            &mut query_client,
            query_channel,
            query_epoch,
            "embed.query",
            query_params("query holds the cpu", 3_000),
        )
        .await
    });
    assert_eq!(harness.gate.started().await, 1);

    let lane = test_lane();
    let page = items(&[("i0", "zero"), ("i1", "one"), ("i2", "two")]);
    let frame = call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());
    snapshot_when(&harness.metrics, |snapshot| {
        snapshot.jobs_active == 1 && snapshot.cpu_wait_outcome.batch.iter().sum::<u64>() == 0
    })
    .await;

    tokio::time::sleep(TIMING_FLOOR).await;
    harness.gate.release();
    assert_eq!(
        query.await.expect("query task").json()["result"]["done"],
        true
    );
    assert_eq!(harness.gate.started().await, 3);
    tokio::time::sleep(TIMING_FLOOR).await;
    harness.gate.release();

    let snapshot = snapshot_when(&harness.metrics, |snapshot| {
        snapshot.cpu_wait_outcome.batch[BatchWaitOutcome::Granted.slot()] == 1
            && snapshot.cpu_wait_outcome.batch.iter().sum::<u64>() == 1
            && snapshot.cpu_wait.batch.count == 1
            && snapshot.cpu_hold.batch.count == 1
            && snapshot.inference.batch.count == 1
            && snapshot.batch_items_embedded == 3
            && snapshot.jobs_retained == 1
    })
    .await;
    assert_one_at_or_above(snapshot.cpu_wait.batch, TIMING_FLOOR);
    assert_one_at_or_above(snapshot.cpu_hold.batch, TIMING_FLOOR);
    assert_one_at_or_above(snapshot.inference.batch, TIMING_FLOOR);
    assert_eq!(snapshot.cpu_wait.batch.count, snapshot.cpu_hold.batch.count);

    harness.host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn lane_failure_after_grant_records_hold_without_inference() {
    let mut harness = Harness::start(SynapseLimits::default()).await;
    harness
        .engine
        .fail_next(InferenceError::Invariant("test lane failure".to_owned()));
    let lane = test_lane();
    let blocker = items(&[("blocker", "fails while holding cpu")]);
    let frame = call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &blocker),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());
    assert_eq!(harness.gate.started().await, 1);

    let mut query_client = harness.host.client().await;
    let (channel, epoch) = open_synapse_route(&mut query_client).await;
    let query = tokio::spawn(async move {
        call(
            &mut query_client,
            channel,
            epoch,
            "embed.query",
            query_params("must not enter failed lane", 3_000),
        )
        .await
    });
    snapshot_when(&harness.metrics, |snapshot| {
        snapshot.free_query_permits == 0
    })
    .await;
    harness.gate.release();
    assert_eq!(
        query.await.expect("query task").error_code(),
        "artifact_invalid"
    );

    let snapshot = snapshot_when(&harness.metrics, |snapshot| {
        snapshot.cpu_wait_outcome.query[QueryWaitOutcome::Granted.slot()] == 1
            && snapshot.cpu_wait_outcome.query.iter().sum::<u64>() == 1
            && snapshot.cpu_wait.query.count == 1
            && snapshot.cpu_hold.query.count == 1
    })
    .await;
    assert_eq!(snapshot.inference.query.count, 0);
    assert_eq!(harness.engine.calls(), 1);

    harness.host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn deadline_while_queued_records_one_terminal_and_no_wait_histogram() {
    let mut harness = Harness::start(SynapseLimits::default()).await;
    let lane = test_lane();
    let blocker = items(&[("blocker", "holds cpu past query deadline")]);
    call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &blocker),
    )
    .await;
    assert_eq!(harness.gate.started().await, 1);

    let mut query_client = harness.host.client().await;
    let (channel, epoch) = open_synapse_route(&mut query_client).await;
    let query = tokio::spawn(async move {
        call(
            &mut query_client,
            channel,
            epoch,
            "embed.query",
            query_params("deadline race", 100),
        )
        .await
    });
    snapshot_when(&harness.metrics, |snapshot| {
        snapshot.free_query_permits == 0
    })
    .await;
    assert_eq!(query.await.expect("query task").error_code(), "timeout");

    let snapshot = snapshot_when(&harness.metrics, |snapshot| {
        snapshot.cpu_wait_outcome.query[QueryWaitOutcome::Timeout.slot()]
            + snapshot.cpu_wait_outcome.query[QueryWaitOutcome::WaiterGone.slot()]
            == 1
    })
    .await;
    assert_eq!(snapshot.cpu_wait_outcome.query.iter().sum::<u64>(), 1);
    assert_eq!(snapshot.cpu_wait.query.count, 0);
    assert_eq!(snapshot.cpu_hold.query.count, 0);

    harness.gate.release();
    snapshot_when(&harness.metrics, |snapshot| snapshot.jobs_retained == 1).await;
    harness.host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn saturated_job_table_attributes_one_job_admission_rejection() {
    let limits = SynapseLimits {
        max_queued_jobs: 1,
        ..SynapseLimits::default()
    };
    let mut harness = Harness::start(limits).await;
    let lane = test_lane();
    let first = items(&[("first", "occupies the only job slot")]);
    call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &first),
    )
    .await;
    assert_eq!(harness.gate.started().await, 1);

    let second = items(&[("second", "must be rejected")]);
    let frame = call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &second),
    )
    .await;
    assert_eq!(frame.error_code(), "queue_full");
    let snapshot = harness.metrics.snapshot();
    assert_eq!(snapshot.queue_full[QueueFullReason::JobAdmission.slot()], 1);
    assert_eq!(snapshot.queue_full.iter().sum::<u64>(), 1);
    assert_eq!(snapshot.jobs_active, 1);

    harness.gate.release();
    snapshot_when(&harness.metrics, |snapshot| snapshot.jobs_retained == 1).await;
    assert_eq!(harness.engine.calls(), 1);
    harness.host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn poll_outcomes_count_once_per_wire_request() {
    let limits = SynapseLimits {
        max_page_vectors: 2,
        ..SynapseLimits::default()
    };
    let mut harness = Harness::start(limits).await;
    let mut query_client = harness.host.client().await;
    let (query_channel, query_epoch) = open_synapse_route(&mut query_client).await;
    let query = tokio::spawn(async move {
        call(
            &mut query_client,
            query_channel,
            query_epoch,
            "embed.query",
            query_params("holds cpu while batch queues", 3_000),
        )
        .await
    });
    assert_eq!(harness.gate.started().await, 1);

    let lane = test_lane();
    let page = items(&[
        ("i0", "zero"),
        ("i1", "one"),
        ("i2", "two"),
        ("i3", "three"),
        ("i4", "four"),
    ]);
    let admitted = call(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    let body = admitted.json();
    let job_id = body["result"]["job_id"]
        .as_str()
        .expect("job id")
        .to_owned();
    let key = request_key(&lane, &page);
    assert_eq!(
        poll(
            &mut harness.client,
            harness.channel,
            harness.epoch,
            &job_id,
            &key,
            None,
        )
        .await
        .json()["result"]["status"],
        "queued"
    );

    harness.gate.release();
    assert_eq!(
        query.await.expect("query task").json()["result"]["done"],
        true
    );
    assert_eq!(harness.gate.started().await, 5);
    assert_eq!(
        poll(
            &mut harness.client,
            harness.channel,
            harness.epoch,
            &job_id,
            &key,
            None,
        )
        .await
        .json()["result"]["status"],
        "running"
    );
    harness.gate.release();
    snapshot_when(&harness.metrics, |snapshot| snapshot.jobs_retained == 1).await;

    let mut cursor = None;
    let mut pages = 0;
    loop {
        let frame = poll(
            &mut harness.client,
            harness.channel,
            harness.epoch,
            &job_id,
            &key,
            cursor.as_deref(),
        )
        .await;
        let body = frame.json();
        pages += 1;
        if body["result"]["done"] == true {
            break;
        }
        cursor = Some(
            body["result"]["next_cursor"]
                .as_str()
                .expect("next cursor")
                .to_owned(),
        );
    }
    assert_eq!(pages, 3);

    let restarted = poll(
        &mut harness.client,
        harness.channel,
        harness.epoch,
        "deadbeefdeadbeef-1",
        &key,
        None,
    )
    .await;
    assert_eq!(restarted.error_code(), "module_restarted");

    let requests = 6;
    let snapshot = snapshot_when(&harness.metrics, |snapshot| {
        snapshot.poll_outcome.iter().sum::<u64>()
            + snapshot.queue_full[QueueFullReason::ResultPageResident.slot()]
            == requests
    })
    .await;
    assert_eq!(
        snapshot.poll_outcome[PollMetricOutcome::PendingQueued.slot()],
        1
    );
    assert_eq!(
        snapshot.poll_outcome[PollMetricOutcome::PendingRunning.slot()],
        1
    );
    assert_eq!(snapshot.poll_outcome[PollMetricOutcome::Page.slot()], 3);
    assert_eq!(
        snapshot.poll_outcome[PollMetricOutcome::Restarted.slot()],
        1
    );
    assert_eq!(
        snapshot.queue_full[QueueFullReason::ResultPageResident.slot()],
        0
    );

    harness.host.shutdown().await.expect("graceful shutdown");
}

#[test]
fn histogram_edges_match_the_published_contract() {
    assert_eq!(
        HISTOGRAM_EDGES_MS,
        [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000]
    );
}

#[test]
fn serialized_snapshot_has_stable_integer_only_shape() {
    let (engine, _gate) = GatedEngine::new();
    let component = ready_component(engine, SynapseLimits::default());
    let actual = serde_json::to_value(component.metrics()).expect("snapshot serializes");
    let histogram = || {
        serde_json::json!({
            "buckets": vec![0; mc_host::synapse::HISTOGRAM_BUCKETS],
            "count": 0,
            "sum_us": 0,
        })
    };
    let expected = serde_json::json!({
        "cpu_wait": {"query": histogram(), "batch": histogram()},
        "cpu_hold": {"query": histogram(), "batch": histogram()},
        "inference": {"query": histogram(), "batch": histogram()},
        "cpu_wait_outcome": {"query": [0, 0, 0, 0], "batch": [0, 0, 0]},
        "queue_full": [0, 0, 0, 0, 0, 0],
        "poll_outcome": [0, 0, 0, 0, 0, 0, 0],
        "batch_items_embedded": 0,
        "free_cpu_permits": 1,
        "free_query_permits": 1,
        "jobs_active": 0,
        "jobs_retained": 0,
        "queued_text_bytes": 0,
        "retained_result_bytes": 0,
    });
    assert_eq!(actual, expected);
}
