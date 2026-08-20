//! Job capacity, retention, route-independence, restart fencing, and
//! shutdown ownership for the Synapse lane.

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use mc_host::synapse::jobs::{AdmitOutcome, BatchItem, JobTable, PollOutcome};
use mc_host::synapse::SynapseLimits;
use support::synapse::{
    batch_params, call, constraints, items, open_synapse_route, ready_component, request_key,
    test_lane, DeterministicEngine, SynapseHost, BUDGET,
};

async fn wait_ready(
    client: &mut support::raw_client::RawClient,
    channel: u16,
    epoch: u32,
    job_id: &str,
    key: &str,
) -> serde_json::Value {
    let lane = test_lane();
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let mut params = constraints(&lane);
        params["job_id"] = job_id.into();
        params["request_key"] = key.into();
        params["cursor"] = serde_json::Value::Null;
        let frame = call(client, channel, epoch, "embed.result", params).await;
        let body = frame.json();
        if body["result"]["vectors"].is_array() || body["code"].is_string() {
            return body;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "job {job_id} never became ready"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn admission_count_boundary_is_exact_and_never_evicts_live_work() {
    let engine = DeterministicEngine::new();
    engine.set_delay(Duration::from_millis(300));
    let limits = SynapseLimits {
        max_queued_jobs: 2,
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    // Two admitted (one running, one queued) fill the class exactly.
    for (id, text) in [("a", "job one"), ("b", "job two")] {
        let frame = call(
            &mut client,
            channel,
            epoch,
            "embed.batch",
            batch_params(&lane, &items(&[(id, text)])),
        )
        .await;
        assert!(frame.json()["result"]["job_id"].is_string());
    }
    // The third is refused rather than displacing live work.
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("c", "job three")])),
    )
    .await;
    assert_eq!(frame.error_code(), "queue_full");

    // Once the backlog drains, admission reopens.
    tokio::time::sleep(Duration::from_millis(900)).await;
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("c", "job three")])),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn queued_byte_boundary_is_exact_and_releases_on_completion() {
    let engine = DeterministicEngine::new();
    engine.set_delay(Duration::from_millis(200));
    let limits = SynapseLimits {
        max_queued_request_bytes: 8,
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    // Exactly eight queued text bytes are accepted.
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("a", "12345678")])),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());

    // One more byte is refused while those bytes are still queued.
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("b", "x")])),
    )
    .await;
    assert_eq!(frame.error_code(), "queue_full");

    // Results replace inputs, releasing the queued bytes.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("b", "x")])),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn completed_jobs_evict_oldest_first_under_count_pressure() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        max_retained_jobs: 1,
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine, limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let first_page = items(&[("a", "first job")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &first_page),
    )
    .await;
    let first_job = frame.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    let first_key = request_key(&lane, &first_page);
    let body = wait_ready(&mut client, channel, epoch, &first_job, &first_key).await;
    assert!(body["result"]["done"].as_bool().expect("done"));

    // A second completion displaces the oldest retained job.
    let second_page = items(&[("b", "second job")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &second_page),
    )
    .await;
    let second_job = frame.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    let second_key = request_key(&lane, &second_page);
    let body = wait_ready(&mut client, channel, epoch, &second_job, &second_key).await;
    assert!(body["result"]["done"].as_bool().expect("done"));

    // The evicted job is now indistinguishable from a restart.
    let mut params = constraints(&lane);
    params["job_id"] = first_job.into();
    params["request_key"] = first_key.into();
    params["cursor"] = serde_json::Value::Null;
    let frame = call(&mut client, channel, epoch, "embed.result", params).await;
    assert_eq!(frame.error_code(), "module_restarted");

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn expired_jobs_return_module_restarted() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        retention: Duration::from_millis(100),
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine, limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let page = items(&[("a", "expiring job")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    let job_id = frame.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    let key = request_key(&lane, &page);
    wait_ready(&mut client, channel, epoch, &job_id, &key).await;

    tokio::time::sleep(Duration::from_millis(250)).await;
    let mut params = constraints(&lane);
    params["job_id"] = job_id.into();
    params["request_key"] = key.into();
    params["cursor"] = serde_json::Value::Null;
    let frame = call(&mut client, channel, epoch, "embed.result", params).await;
    assert_eq!(frame.error_code(), "module_restarted");

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn jobs_survive_route_loss_and_serve_a_fresh_route() {
    let engine = DeterministicEngine::new();
    engine.set_delay(Duration::from_millis(200));
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let page = items(&[("a", "surviving job")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    let job_id = frame.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    let key = request_key(&lane, &page);

    // Close the route while the job runs; the accepted job must not care.
    client
        .send_frame(support::raw_client::TY_GOODBYE, 0, channel, epoch, 0, b"")
        .await
        .expect("route goodbye");

    let (channel, epoch) = open_synapse_route(&mut client).await;
    let body = wait_ready(&mut client, channel, epoch, &job_id, &key).await;
    assert_eq!(body["result"]["done"], true);
    assert_eq!(body["result"]["vectors"][0]["id"], "a");
    assert_eq!(engine.calls.load(Ordering::SeqCst), 1);

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn cancelled_query_before_cpu_admission_runs_no_inference() {
    let engine = DeterministicEngine::new();
    engine.set_delay(Duration::from_millis(400));
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    // Occupy the single CPU permit with a batch job.
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("a", "cpu hog")])),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());

    // Queue a query behind it, then cancel it before it can start.
    let mut params = constraints(&lane);
    params["text"] = "never embedded".into();
    let corr = client.next_corr();
    let body = serde_json::to_vec(&serde_json::json!({"method": "embed.query", "params": params}))
        .expect("request serializes");
    client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            &body,
        )
        .await
        .expect("send query");
    tokio::time::sleep(Duration::from_millis(50)).await;
    client
        .send_frame(support::raw_client::TY_CANCEL, 0, channel, epoch, corr, b"")
        .await
        .expect("send cancel");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.corr, corr);
    assert_eq!(frame.error_code(), "cancelled");

    // Only the batch ran; the cancelled queued query never reached the
    // engine.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(engine.calls.load(Ordering::SeqCst), 1);
    assert_eq!(engine.texts_embedded.load(Ordering::SeqCst), 1);

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn queued_query_wait_is_bounded_by_its_deadline() {
    let engine = DeterministicEngine::new();
    engine.set_delay(Duration::from_millis(400));
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("a", "cpu hog")])),
    )
    .await;
    assert!(frame.json()["result"]["job_id"].is_string());
    let started_by = tokio::time::Instant::now() + BUDGET;
    while engine.calls.load(Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < started_by,
            "batch inference never started"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let mut params = constraints(&lane);
    params["text"] = "deadline-bound query".into();
    params["deadline_ms"] = 50.into();
    let frame = tokio::time::timeout(
        BUDGET,
        call(&mut client, channel, epoch, "embed.query", params),
    )
    .await
    .expect("deadline-bound query must not hang");
    assert_eq!(frame.error_code(), "timeout");

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        engine.calls.load(Ordering::SeqCst),
        1,
        "a query whose queue deadline expires must not reach inference"
    );
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn failed_jobs_report_their_stored_error() {
    let engine = DeterministicEngine::new();
    engine.fail_next(mc_host::synapse::inference::InferenceError::Invariant(
        "vector is not L2-normalized".to_owned(),
    ));
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let page = items(&[("a", "will fail")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    let job_id = frame.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    let key = request_key(&lane, &page);

    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let mut params = constraints(&lane);
        params["job_id"] = job_id.clone().into();
        params["request_key"] = key.clone().into();
        params["cursor"] = serde_json::Value::Null;
        let frame = call(&mut client, channel, epoch, "embed.result", params).await;
        if frame.ty == 5 {
            assert_eq!(frame.error_code(), "artifact_invalid");
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "job never failed");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // The invariant failure marked the lane failing: new work is refused
    // and later binds reject.
    let mut params = constraints(&lane);
    params["text"] = "after failure".into();
    let frame = call(&mut client, channel, epoch, "embed.query", params).await;
    assert_eq!(frame.error_code(), "artifact_invalid");

    let err = client
        .route_open_target(
            "management_surface",
            "synapse",
            "/workspace/project",
            "h",
            "s2",
        )
        .await
        .expect_err("failing lanes reject binds");
    assert_eq!(err, "artifact_invalid");

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn shutdown_with_queued_running_and_retained_jobs_is_graceful() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    // One retained completed job.
    let done_page = items(&[("done", "finished work")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &done_page),
    )
    .await;
    let done_job = frame.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    wait_ready(
        &mut client,
        channel,
        epoch,
        &done_job,
        &request_key(&lane, &done_page),
    )
    .await;

    // One running and one queued job.
    engine.set_delay(Duration::from_millis(300));
    for (id, text) in [("run", "running work"), ("wait", "queued work")] {
        let frame = call(
            &mut client,
            channel,
            epoch,
            "embed.batch",
            batch_params(&lane, &items(&[(id, text)])),
        )
        .await;
        assert!(frame.json()["result"]["job_id"].is_string());
    }
    // Shutdown must observe the second job mid-flight, so wait until it has
    // entered the native call before cancelling.
    let deadline = tokio::time::Instant::now() + BUDGET;
    while engine.calls.load(Ordering::SeqCst) < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "running job never started"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Graceful shutdown joins the running native call, cancels the queued
    // wrapper, and releases retention before the handler drops.
    host.shutdown().await.expect("graceful shutdown");

    // The queued job never ran: one call for the retained job, one for the
    // running job.
    assert_eq!(engine.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn a_vector_count_that_disagrees_with_the_job_fails_only_that_job() {
    // Pairing results with item metadata indexes by position, so an engine
    // that returns a different count would index out of bounds while the job
    // table's lock is held — poisoning it for every later caller, including
    // shutdown's admission close. The engine trait is an open seam, so the
    // table cannot assume the count was validated upstream.
    let jobs = JobTable::new(SynapseLimits::default());
    let batch = |id: &str| {
        vec![BatchItem {
            id: id.to_owned(),
            content_sha256: "0".repeat(64),
            text: "alpha".to_owned(),
        }]
    };

    let AdmitOutcome::Admitted { job_id, seq } = jobs.admit("key-1".to_owned(), batch("item:0"))
    else {
        panic!("the first job is admitted");
    };
    jobs.start(seq).expect("the job starts");
    // Two vectors for a one-item job.
    jobs.publish_ready(seq, vec![vec![0.5, 0.5], vec![0.5, 0.5]]);

    match jobs.poll(&job_id, "key-1", None) {
        PollOutcome::Failed { code, message } => {
            assert_eq!(code, "artifact_invalid");
            assert!(
                message.contains("item count"),
                "message {message:?} does not name the count disagreement"
            );
        }
        other => panic!(
            "expected a failed job, got {:?}",
            std::mem::discriminant(&other)
        ),
    }

    // The table survives: a later job still admits, publishes, and serves.
    let AdmitOutcome::Admitted { job_id, seq } = jobs.admit("key-2".to_owned(), batch("item:1"))
    else {
        panic!("the second job is admitted");
    };
    jobs.start(seq).expect("the job starts");
    jobs.publish_ready(seq, vec![vec![1.0, 0.0]]);
    match jobs.poll(&job_id, "key-2", None) {
        PollOutcome::Page(page) => {
            assert!(page.done);
            assert_eq!(page.vectors.len(), 1);
            assert_eq!(page.vectors[0].0, "item:1");
        }
        _ => panic!("expected a served page after the failed job"),
    }
}
