//! Wire-level conformance for the four Synapse operations over a real
//! authenticated route, using the deterministic test engine.

mod support;

use support::synapse::{
    batch_params, call, constraints, items, open_synapse_route, ready_component, request_key,
    send_call, sha256_hex, test_lane, DeterministicEngine, SynapseHost, BUDGET,
};

use mc_host::synapse::{protocol, SynapseLimits};

const TY_ERROR: u8 = 5;

async fn spawn_query(
    host: &SynapseHost,
    lane: &mc_host::synapse::LaneInfo,
    text: &str,
    deadline_ms: u64,
) -> tokio::task::JoinHandle<support::raw_client::RawFrame> {
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let mut params = constraints(lane);
    params["text"] = text.into();
    params["deadline_ms"] = deadline_ms.into();
    let corr = send_call(&mut client, channel, epoch, "embed.query", params).await;
    tokio::spawn(async move {
        client
            .frames_until_corr(corr, BUDGET)
            .await
            .expect("query terminal")
            .1
    })
}

async fn yield_until(predicate: impl Fn() -> bool) {
    for _ in 0..10_000 {
        if predicate() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("condition did not become true");
}

/// Limits admitting `max_waiting_queries` waiters. Waiting queries and the
/// queued-batch budget share one scratch pool; the default 64 MiB queued
/// budget leaves no waiter headroom, so it is shrunk to 8 MiB.
fn waiter_limits(max_waiting_queries: usize) -> SynapseLimits {
    SynapseLimits {
        max_waiting_queries,
        max_queued_request_bytes: 8 * 1024 * 1024,
        ..SynapseLimits::default()
    }
}

fn keep_paused_clock_manual() -> (
    std::sync::Arc<std::sync::atomic::AtomicBool>,
    tokio::task::JoinHandle<()>,
) {
    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let task_running = std::sync::Arc::clone(&running);
    let task = tokio::spawn(async move {
        while task_running.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    });
    (running, task)
}

#[tokio::test(start_paused = true)]
async fn bounded_query_waiters_are_fifo_and_reject_bound_plus_one() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    let limits = SynapseLimits {
        query_retry_after_ms: 73,
        ..waiter_limits(2)
    };
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let (clock_running, clock_task) = keep_paused_clock_manual();
    let lane = test_lane();

    let first = spawn_query(&host, &lane, "first", 30_000).await;
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    // Each waiter travels its own connection, so admission order follows when
    // its task reaches the socket rather than the spawn order here. A waiter
    // blocks before the engine, so `engine.calls` cannot witness its arrival
    // and there is nothing for `yield_until` to observe; a single yield is one
    // scheduler turn, which need not carry a spawn through write, dispatch,
    // and semaphore acquisition. Draining the queue the way the rest of this
    // suite does keeps the FIFO assertion below from depending on how many
    // await points that path happens to contain.
    let second = spawn_query(&host, &lane, "second", 30_000).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let third = spawn_query(&host, &lane, "third", 30_000).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let fourth = spawn_query(&host, &lane, "fourth", 30_000).await;
    yield_until(|| fourth.is_finished()).await;
    let rejected = fourth.await.expect("fourth query task");
    assert_eq!(rejected.error_code(), "queue_full");
    assert_eq!(rejected.json()["retry_after_ms"], 73);

    DeterministicEngine::release_calls(&gate);
    for query in [first, second, third] {
        assert_eq!(
            query.await.expect("query task").ty,
            support::raw_client::TY_RESPONSE
        );
    }
    assert_eq!(
        *engine.call_texts.lock().expect("call text lock"),
        ["first", "second", "third"]
    );
    host.shutdown().await.expect("graceful shutdown");
    clock_running.store(false, std::sync::atomic::Ordering::SeqCst);
    clock_task.await.expect("clock keeper task");
}

#[tokio::test(start_paused = true)]
async fn expired_waiter_releases_its_slot_without_engine_work() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    let limits = waiter_limits(1);
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let (clock_running, clock_task) = keep_paused_clock_manual();
    let lane = test_lane();

    let first = spawn_query(&host, &lane, "running", 30_000).await;
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    let mut expired_client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut expired_client).await;
    let mut expired_params = constraints(&lane);
    expired_params["text"] = "expired".into();
    expired_params["deadline_ms"] = 10.into();
    let expired_corr = send_call(
        &mut expired_client,
        channel,
        epoch,
        "embed.query",
        expired_params,
    )
    .await;
    let mut barrier_params = constraints(&lane);
    barrier_params["text"] = "barrier".into();
    barrier_params["deadline_ms"] = 30_000.into();
    let barrier_corr = send_call(
        &mut expired_client,
        channel,
        epoch,
        "embed.query",
        barrier_params,
    )
    .await;
    let barrier = expired_client
        .frames_until_corr(barrier_corr, BUDGET)
        .await
        .expect("waiter barrier terminal")
        .1;
    assert_eq!(barrier.error_code(), "queue_full");
    tokio::time::advance(std::time::Duration::from_millis(11)).await;
    let expired_terminal = expired_client
        .frames_until_corr(expired_corr, BUDGET)
        .await
        .expect("expired query terminal")
        .1;
    assert_eq!(expired_terminal.error_code(), "timeout");
    // The queued-waiter arm (the worker's deadline while waiting for the
    // CPU permit) and the awaiting-result arm carry distinct messages; a
    // waiter that never started must report the queued expiry.
    assert_eq!(
        expired_terminal.json()["message"],
        "the query deadline expired while queued"
    );
    assert_eq!(engine.calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    let replacement = spawn_query(&host, &lane, "replacement", 30_000).await;
    tokio::task::yield_now().await;
    DeterministicEngine::release_calls(&gate);
    assert_eq!(
        first.await.expect("first query task").ty,
        support::raw_client::TY_RESPONSE
    );
    assert_eq!(
        replacement.await.expect("replacement query task").ty,
        support::raw_client::TY_RESPONSE
    );
    assert_eq!(
        *engine.call_texts.lock().expect("call text lock"),
        ["running", "replacement"]
    );
    host.shutdown().await.expect("graceful shutdown");
    clock_running.store(false, std::sync::atomic::Ordering::SeqCst);
    clock_task.await.expect("clock keeper task");
}

#[tokio::test(start_paused = true)]
async fn mixed_batch_and_query_waiters_share_fifo_cpu_without_starvation() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    let limits = waiter_limits(2);
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let (clock_running, clock_task) = keep_paused_clock_manual();
    let lane = test_lane();

    let first = spawn_query(&host, &lane, "query-first", 30_000).await;
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    let second = spawn_query(&host, &lane, "query-second", 30_000).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }

    let mut batch_client = host.client().await;
    let (batch_channel, batch_epoch) = open_synapse_route(&mut batch_client).await;
    let batch = call(
        &mut batch_client,
        batch_channel,
        batch_epoch,
        "embed.batch",
        batch_params(&lane, &items(&[("batch", "batch-middle")])),
    )
    .await;
    assert!(batch.json()["result"]["job_id"].is_string());
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let third = spawn_query(&host, &lane, "query-third", 30_000).await;

    DeterministicEngine::release_calls(&gate);
    for query in [first, second, third] {
        assert_eq!(
            query.await.expect("query task").ty,
            support::raw_client::TY_RESPONSE
        );
    }
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 4).await;
    assert_eq!(
        *engine.call_texts.lock().expect("call text lock"),
        ["query-first", "query-second", "batch-middle", "query-third"]
    );

    host.shutdown().await.expect("graceful shutdown");
    clock_running.store(false, std::sync::atomic::Ordering::SeqCst);
    clock_task.await.expect("clock keeper task");
}

#[tokio::test(start_paused = true)]
async fn shutdown_cancels_waiters_but_drains_started_query() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    let limits = waiter_limits(1);
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let (clock_running, clock_task) = keep_paused_clock_manual();
    let lane = test_lane();

    let started = spawn_query(&host, &lane, "started", 30_000).await;
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    let mut waiting_client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut waiting_client).await;
    let mut waiting_params = constraints(&lane);
    waiting_params["text"] = "waiting".into();
    waiting_params["deadline_ms"] = 30_000.into();
    let waiting_corr = send_call(
        &mut waiting_client,
        channel,
        epoch,
        "embed.query",
        waiting_params,
    )
    .await;

    // Same-generation FIFO makes this a barrier: the second query can report
    // overload only after the first query occupies the sole waiter slot.
    let mut overflow_params = constraints(&lane);
    overflow_params["text"] = "overflow".into();
    overflow_params["deadline_ms"] = 30_000.into();
    let overflow_corr = send_call(
        &mut waiting_client,
        channel,
        epoch,
        "embed.query",
        overflow_params,
    )
    .await;
    let overflow = waiting_client
        .frames_until_corr(overflow_corr, BUDGET)
        .await
        .expect("waiter barrier terminal")
        .1;
    assert_eq!(overflow.error_code(), "queue_full");

    let shutdown = tokio::spawn(host.shutdown());
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert!(
        !shutdown.is_finished(),
        "shutdown must drain the started call"
    );
    assert_eq!(engine.calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    DeterministicEngine::release_calls(&gate);
    shutdown
        .await
        .expect("shutdown task")
        .expect("graceful shutdown");
    let _started_terminal = started.await.expect("started query task");
    let waiting_terminal = waiting_client
        .frames_until_corr(waiting_corr, BUDGET)
        .await
        .expect("waiting query terminal")
        .1;
    assert_eq!(waiting_terminal.error_code(), "cancelled");
    // Two producers emit `cancelled`: route settlement's generation cancel
    // ("request cancelled") and the component's own shutdown arm ("the host
    // is shutting down"). Host shutdown settles routes — cancelling admitted
    // work — before the composite's shutdown callback cancels the synapse
    // closing token, so the dispatcher's message is the one a client
    // observes; pinning it keeps this test honest about which producer
    // cancelled the waiter.
    assert_eq!(waiting_terminal.json()["message"], "request cancelled");
    assert_eq!(
        *engine.call_texts.lock().expect("call text lock"),
        ["started"]
    );
    clock_running.store(false, std::sync::atomic::Ordering::SeqCst);
    clock_task.await.expect("clock keeper task");
}

#[tokio::test(start_paused = true)]
async fn route_loss_drops_queued_query_without_engine_work_and_releases_slot() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    let limits = waiter_limits(1);
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let (clock_running, clock_task) = keep_paused_clock_manual();
    let lane = test_lane();

    let started = spawn_query(&host, &lane, "started", 30_000).await;
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 1).await;

    let mut lost = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut lost).await;
    let mut params = constraints(&lane);
    params["text"] = "lost".into();
    params["deadline_ms"] = 30_000.into();
    let corr = lost.next_corr();
    let body = serde_json::to_vec(&serde_json::json!({"method": "embed.query", "params": params}))
        .expect("request serializes");
    lost.send_frame(
        support::raw_client::TY_REQUEST,
        support::raw_client::FLAGS_INTERACTIVE,
        channel,
        epoch,
        corr,
        &body,
    )
    .await
    .expect("send queued query");
    // Positive occupancy proof: with two permits (one running, one waiter),
    // a third query rejecting `queue_full` proves the lost query was
    // admitted and holds the waiter slot — without it, a scheduling race
    // could kill the route before admission and pass this test vacuously.
    // (An admitted probe would park behind the gated engine, so a vacuous
    // run now fails loudly instead of passing.)
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let probe = spawn_query(&host, &lane, "probe", 30_000).await;
    let probe_terminal = probe.await.expect("probe query task");
    assert_eq!(probe_terminal.ty, TY_ERROR);
    assert_eq!(probe_terminal.error_code(), "queue_full");
    lost.send_frame(support::raw_client::TY_GOODBYE, 0, channel, epoch, 0, b"")
        .await
        .expect("close queued query route");
    drop(lost);
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(engine.calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    let replacement = spawn_query(&host, &lane, "replacement", 30_000).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    DeterministicEngine::release_calls(&gate);
    let _ = started.await.expect("started query task");
    assert_eq!(
        replacement.await.expect("replacement query task").ty,
        support::raw_client::TY_RESPONSE
    );
    assert_eq!(
        *engine.call_texts.lock().expect("call text lock"),
        ["started", "replacement"]
    );

    host.shutdown().await.expect("graceful shutdown");
    clock_running.store(false, std::sync::atomic::Ordering::SeqCst);
    clock_task.await.expect("clock keeper task");
}

/// The startup scratch formula's promise holds at runtime: at the largest
/// feasible `max_waiting_queries` for these limits, boundary+1 concurrent
/// queries each carrying a maximal text are all admitted — none is rejected
/// `queue_full` by resident accounting — and each returns a response.
#[tokio::test(start_paused = true)]
async fn boundary_waiters_with_maximal_texts_are_all_admitted() {
    let engine = DeterministicEngine::new();
    let gate = engine.block_calls();
    // The feasible boundary under the startup scratch formula, pinned so a
    // formula or pool change must recompute it deliberately:
    //   reservable = SCRATCH_RESERVED_BYTES (184,616,192)
    //              - RETAINED_METADATA_RESERVED_BYTES (2,097,152) = 182,519,040
    //   per waiter slot   = 2 * max_text_bytes + 256          =   2,097,408
    //   queued text bytes = max_queued_request_bytes          =   8,388,608
    //   queued metadata   = 64 jobs * (2*64 + 64 * 960)       =   3,940,352
    //   worst parse       = 3 * 32 MiB + 64 * 640 + 4096      = 100,708,352
    //   K + 1 <= (182,519,040 - 113,037,312) / 2,097,408 = 33.13 -> K = 32
    const BOUNDARY: usize = 32;
    mc_host::synapse::SynapseComponent::ready_with_engine(
        test_lane(),
        engine.clone(),
        waiter_limits(BOUNDARY),
    )
    .expect("the boundary configuration is feasible");
    let error = match mc_host::synapse::SynapseComponent::ready_with_engine(
        test_lane(),
        engine.clone(),
        waiter_limits(BOUNDARY + 1),
    ) {
        Ok(_) => panic!("one waiter past the boundary must fail validation"),
        Err(error) => error,
    };
    assert!(error
        .to_string()
        .contains("query admission capacity requires"));

    let host = SynapseHost::start(ready_component(engine.clone(), waiter_limits(BOUNDARY))).await;
    let (clock_running, clock_task) = keep_paused_clock_manual();
    let lane = test_lane();
    let text = "x".repeat(lane.max_text_bytes);

    let first = spawn_query(&host, &lane, &text, 30_000).await;
    yield_until(|| engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    let mut waiters = Vec::new();
    for _ in 0..BOUNDARY {
        waiters.push(spawn_query(&host, &lane, &text, 30_000).await);
        tokio::task::yield_now().await;
    }
    // Every waiter holds its decoded maximal text while the engine gate is
    // closed, so all boundary+1 charges coexist in the scratch pool here.
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "queued queries must not reach inference while the gate is closed"
    );

    DeterministicEngine::release_calls(&gate);
    let terminal = first.await.expect("first query task");
    assert_eq!(
        terminal.ty,
        support::raw_client::TY_RESPONSE,
        "first query rejected: {}",
        String::from_utf8_lossy(&terminal.body)
    );
    for waiter in waiters {
        let terminal = waiter.await.expect("waiter query task");
        assert_eq!(
            terminal.ty,
            support::raw_client::TY_RESPONSE,
            "an admitted maximal query was rejected: {}",
            String::from_utf8_lossy(&terminal.body)
        );
    }
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        BOUNDARY + 1,
        "every admitted query runs inference exactly once"
    );

    host.shutdown().await.expect("graceful shutdown");
    clock_running.store(false, std::sync::atomic::Ordering::SeqCst);
    clock_task.await.expect("clock keeper task");
}

#[tokio::test]
async fn models_list_returns_exactly_the_certified_entry() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        max_text_bytes: 123_456,
        ..SynapseLimits::default()
    };
    let advertised_max_text_bytes = limits.max_text_bytes;
    let host = SynapseHost::start(ready_component(engine, limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;

    let frame = call(
        &mut client,
        channel,
        epoch,
        "models.list",
        serde_json::json!({}),
    )
    .await;
    let body = frame.json();
    let models = body["result"]["models"].as_array().expect("models array");
    assert_eq!(models.len(), 1);
    let lane = test_lane();
    assert_eq!(models[0]["model"], lane.model);
    assert_eq!(models[0]["fingerprint"], lane.fingerprint);
    assert_eq!(models[0]["table_epoch"], lane.table_epoch);
    assert_eq!(models[0]["dims"], lane.dims);
    assert_eq!(models[0]["max_input_tokens"], lane.max_tokens);
    assert_eq!(models[0]["max_input_bytes"], advertised_max_text_bytes);
    assert_eq!(models[0]["certified"], true);
    assert_eq!(models[0]["status"], "ready");
    assert_eq!(models[0]["recommended_batch"]["rows"], 16);
    assert_eq!(models[0]["recommended_batch"]["token_budget"], 8192);
    // No legacy aliases: the canonical schema owns the response.
    assert!(body["result"].get("entries").is_none());
    assert!(models[0].get("model_id").is_none());

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn embed_query_returns_a_bound_vector() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let mut params = constraints(&lane);
    params["text"] = "hello world".into();
    params["deadline_ms"] = 3000.into();
    let frame = call(&mut client, channel, epoch, "embed.query", params).await;
    let result = &frame.json()["result"];
    assert_eq!(result["model"], lane.model);
    assert_eq!(result["fingerprint"], lane.fingerprint);
    assert_eq!(result["table_epoch"], lane.table_epoch);
    assert_eq!(result["dims"], lane.dims);
    assert_eq!(result["done"], true);
    let vectors = result["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 1);
    assert_eq!(vectors[0]["id"], "query");
    assert_eq!(vectors[0]["content_sha256"], sha256_hex("hello world"));
    let vector: Vec<f32> = vectors[0]["vector"]
        .as_array()
        .expect("vector")
        .iter()
        .map(|v| v.as_f64().expect("component") as f32)
        .collect();
    assert_eq!(vector, engine.vector_for("hello world"));

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn query_overload_preserves_tool_provider_capacity() {
    let engine = DeterministicEngine::new();
    engine.set_delay(std::time::Duration::from_secs(2));
    let limits = SynapseLimits {
        query_retry_after_ms: 73,
        ..SynapseLimits::default()
    };
    let host = SynapseHost::start_with(ready_component(engine.clone(), limits), |config| {
        config.limits.max_handler_tasks = 2
    })
    .await;
    let lane = test_lane();

    let mut first_client = host.client().await;
    let (first_channel, first_epoch) = open_synapse_route(&mut first_client).await;
    let mut first_params = constraints(&lane);
    first_params["text"] = "slow query".into();
    first_params["deadline_ms"] = 3000.into();
    let first = tokio::spawn(async move {
        call(
            &mut first_client,
            first_channel,
            first_epoch,
            "embed.query",
            first_params,
        )
        .await
    });

    let started_by = tokio::time::Instant::now() + BUDGET;
    while engine.calls.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < started_by,
            "first query never reached inference"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    let mut overload_client = host.client().await;
    let (overload_channel, overload_epoch) = open_synapse_route(&mut overload_client).await;
    let mut overload_params = constraints(&lane);
    overload_params["text"] = "queued query".into();
    overload_params["deadline_ms"] = 3000.into();
    let overloaded = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        call(
            &mut overload_client,
            overload_channel,
            overload_epoch,
            "embed.query",
            overload_params,
        ),
    )
    .await
    .expect("query overload must reject promptly");
    assert_eq!(overloaded.error_code(), "queue_full");
    assert_eq!(overloaded.json()["retry_after_ms"], 73);
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "an overloaded query must not reach inference"
    );

    let mut tool_client = host.client().await;
    let (tool_channel, tool_epoch) = tool_client
        .route_open("magic-context", "/workspace/project", "opencode", "tool")
        .await
        .expect("tool-provider route");
    let corr = tool_client.next_corr();
    tool_client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            tool_channel,
            tool_epoch,
            corr,
            b"tool request",
        )
        .await
        .expect("send tool-provider request");
    let (_, tool_frame) = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        tool_client.frames_until_corr(corr, BUDGET),
    )
    .await
    .expect("tool-provider request must retain capacity")
    .expect("tool-provider terminal");
    assert_eq!(tool_frame.ty, support::raw_client::TY_RESPONSE);
    assert_eq!(tool_frame.body, b"tool request");

    let first = first.await.expect("first query task");
    assert_eq!(first.ty, support::raw_client::TY_RESPONSE);
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn embed_query_rejects_every_constraint_violation() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let base = |edit: fn(&mut serde_json::Value)| {
        let mut params = constraints(&lane);
        params["text"] = "hello".into();
        edit(&mut params);
        params
    };

    for (params, expected) in [
        (
            base(|p| p["model"] = "other-model".into()),
            "substitution_rejected",
        ),
        (
            base(|p| p["required_fingerprint"] = "different".into()),
            "substitution_rejected",
        ),
        (
            base(|p| p["required_epoch"] = 2.into()),
            "substitution_rejected",
        ),
        (
            base(|p| p["allow_equivalent"] = true.into()),
            "substitution_rejected",
        ),
        (
            base(|p| p["accept_declared"] = true.into()),
            "substitution_rejected",
        ),
        (
            base(|p| p["allow_equivalent"] = 1.into()),
            "schema_violation",
        ),
        (base(|p| p["text"] = 7.into()), "schema_violation"),
        (base(|p| p["text"] = "".into()), "schema_violation"),
        (base(|p| p["deadline_ms"] = 0.into()), "schema_violation"),
        (base(|p| p["unknown_extra"] = 1.into()), "schema_violation"),
        (
            base(|p| {
                p.as_object_mut().expect("object").remove("model");
            }),
            "schema_violation",
        ),
    ] {
        let frame = call(&mut client, channel, epoch, "embed.query", params).await;
        assert_eq!(frame.ty, TY_ERROR);
        assert_eq!(frame.error_code(), expected);
    }

    // Over-limit text is refused before hashing or inference.
    let mut params = constraints(&lane);
    params["text"] = "x".repeat(1024 * 1024 + 1).into();
    let frame = call(&mut client, channel, epoch, "embed.query", params).await;
    assert_eq!(frame.error_code(), "schema_violation");

    // Unsupported methods and malformed envelopes.
    let frame = call(
        &mut client,
        channel,
        epoch,
        "jobs.cancel",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(frame.error_code(), "schema_violation");

    let corr = client.next_corr();
    client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            br#"{"method":"models.list","method":"embed.query"}"#,
        )
        .await
        .expect("send duplicate-key request");
    let frame = client.frame_within(BUDGET).await.expect("terminal");
    assert_eq!(frame.error_code(), "schema_violation");

    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no invalid request may reach inference"
    );
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn embed_batch_always_returns_a_job_descriptor() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let page = items(&[("item:0", "first text"), ("item:1", "second text")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    let result = &frame.json()["result"];
    let job_id = result["job_id"].as_str().expect("job_id").to_owned();
    assert!(!job_id.is_empty());
    assert_eq!(result["request_key"], request_key(&lane, &page));
    assert_eq!(result["done"], false);
    assert!(result["retry_after_ms"].as_u64().expect("retry delay") > 0);
    assert!(
        result.get("vectors").is_none(),
        "vectors arrive only through embed.result"
    );

    // Vectors appear only through embed.result, in request order.
    let deadline = tokio::time::Instant::now() + BUDGET;
    let result = loop {
        let mut params = constraints(&lane);
        params["job_id"] = job_id.clone().into();
        params["request_key"] = request_key(&lane, &page).into();
        params["cursor"] = serde_json::Value::Null;
        let frame = call(&mut client, channel, epoch, "embed.result", params).await;
        let body = frame.json();
        if body["result"]["done"] == true {
            break body;
        }
        assert_eq!(body["result"]["done"], false);
        assert!(body["result"]["status"].is_string());
        assert!(
            tokio::time::Instant::now() < deadline,
            "job never became ready"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    let vectors = result["result"]["vectors"].as_array().expect("vectors");
    assert_eq!(vectors.len(), 2);
    assert_eq!(vectors[0]["id"], "item:0");
    assert_eq!(vectors[0]["content_sha256"], sha256_hex("first text"));
    assert_eq!(vectors[1]["id"], "item:1");
    assert_eq!(result["result"]["fingerprint"], lane.fingerprint);
    assert!(result["result"].get("next_cursor").is_none());

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn batch_result_over_retention_cap_is_rejected_before_inference() {
    let engine = DeterministicEngine::new();
    // Eight f32 components, one ID byte, and one 64-byte content hash.
    let limits = SynapseLimits {
        max_retained_result_bytes: 8 * 4 + 1 + 64,
        ..SynapseLimits::default()
    };
    let error = match mc_host::synapse::SynapseComponent::ready_with_engine(
        test_lane(),
        engine.clone(),
        limits,
    ) {
        Ok(_) => panic!("an unservable retained-result cap must fail startup"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("maximum batch result"));
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "oversized result must be rejected before inference"
    );
}

#[tokio::test]
async fn embed_batch_validation_creates_no_job_and_no_inference() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        max_batch_items: 4,
        max_batch_text_bytes: 64,
        max_text_bytes: 32,
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine.clone(), limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    // Wrong supplied content hash.
    let page = items(&[("item:0", "text")]);
    let mut params = batch_params(&lane, &page);
    params["items"][0]["content_sha256"] = sha256_hex("other text").into();
    let frame = call(&mut client, channel, epoch, "embed.batch", params).await;
    assert_eq!(frame.error_code(), "schema_violation");

    // Wrong supplied request key.
    let mut params = batch_params(&lane, &page);
    params["request_key"] = sha256_hex("not the canonical key").into();
    let frame = call(&mut client, channel, epoch, "embed.batch", params).await;
    assert_eq!(frame.error_code(), "schema_violation");

    // Duplicate item IDs.
    let page = items(&[("dup", "a"), ("dup", "b")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    assert_eq!(frame.error_code(), "schema_violation");

    // One item past the count bound.
    let page = items(&[("a", "1"), ("b", "2"), ("c", "3"), ("d", "4"), ("e", "5")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    assert_eq!(frame.error_code(), "schema_violation");

    // One item over the per-text bound.
    let long = "x".repeat(33);
    let page = items(&[("a", long.as_str())]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    assert_eq!(frame.error_code(), "schema_violation");

    // Aggregate text over the batch bound.
    let chunk = "y".repeat(32);
    let page = items(&[("a", chunk.as_str()), ("b", chunk.as_str()), ("c", "z")]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    assert_eq!(frame.error_code(), "schema_violation");

    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "rejected batches must not run inference"
    );
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn exact_boundary_batches_are_accepted() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        max_batch_items: 4,
        max_batch_text_bytes: 64,
        max_text_bytes: 32,
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine, limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let sixteen = "z".repeat(16);
    let page = items(&[
        ("a", sixteen.as_str()),
        ("b", sixteen.as_str()),
        ("c", sixteen.as_str()),
        ("d", sixteen.as_str()),
    ]);
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.batch",
        batch_params(&lane, &page),
    )
    .await;
    assert!(
        frame.json()["result"]["job_id"].is_string(),
        "exact count and byte boundaries admit"
    );
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn equal_replays_reuse_one_job_and_one_inference() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    engine.set_delay(std::time::Duration::from_millis(100));
    let page = items(&[("item:0", "replay me")]);
    let params = batch_params(&lane, &page);

    // Replay while queued or running.
    let first = call(&mut client, channel, epoch, "embed.batch", params.clone()).await;
    let job_id = first.json()["result"]["job_id"]
        .as_str()
        .expect("job")
        .to_owned();
    let second = call(&mut client, channel, epoch, "embed.batch", params.clone()).await;
    assert_eq!(second.json()["result"]["job_id"], job_id.as_str());

    // Replay after completion.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let third = call(&mut client, channel, epoch, "embed.batch", params.clone()).await;
    assert_eq!(third.json()["result"]["job_id"], job_id.as_str());
    assert_eq!(third.json()["result"]["status"], "ready");

    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "equal replays run inference exactly once"
    );

    // The retained key resent with any payload difference (order, IDs,
    // texts, hashes) is a permanent conflict and never reruns the job.
    for other in [
        items(&[("item:0", "different text")]),
        items(&[("item:1", "replay me")]),
        items(&[("item:0", "replay me"), ("item:1", "extra")]),
    ] {
        let mut conflicting = batch_params(&lane, &other);
        conflicting["request_key"] = request_key(&lane, &page).into();
        let frame = call(&mut client, channel, epoch, "embed.batch", conflicting).await;
        assert_eq!(frame.error_code(), "idempotency_conflict");
    }
    // An unretained key that fails the canonical check is a schema fault.
    let mut fresh = batch_params(&lane, &items(&[("item:9", "fresh text")]));
    fresh["request_key"] = sha256_hex("some other key").into();
    let frame = call(&mut client, channel, epoch, "embed.batch", fresh).await;
    assert_eq!(frame.error_code(), "schema_violation");
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "conflicts never replace or rerun the retained job"
    );

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn result_pages_preserve_order_and_cursor_discipline() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        max_page_vectors: 2,
        ..Default::default()
    };
    let host = SynapseHost::start(ready_component(engine, limits)).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let page = items(&[
        ("i0", "text zero"),
        ("i1", "text one"),
        ("i2", "text two"),
        ("i3", "text three"),
        ("i4", "text four"),
    ]);
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

    let poll = |cursor: serde_json::Value| {
        let mut params = constraints(&lane);
        params["job_id"] = job_id.clone().into();
        params["request_key"] = key.clone().into();
        params["cursor"] = cursor;
        params
    };

    // Wait for readiness.
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        let frame = call(
            &mut client,
            channel,
            epoch,
            "embed.result",
            poll(serde_json::Value::Null),
        )
        .await;
        if frame.json()["result"]["vectors"].is_array() {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let mut collected = Vec::new();
    let mut cursor = serde_json::Value::Null;
    let mut pages = 0;
    loop {
        let frame = call(
            &mut client,
            channel,
            epoch,
            "embed.result",
            poll(cursor.clone()),
        )
        .await;
        let body = frame.json();
        let result = &body["result"];
        pages += 1;
        for vector in result["vectors"].as_array().expect("vectors") {
            collected.push(vector["id"].as_str().expect("id").to_owned());
        }
        if result["done"] == true {
            assert!(result.get("next_cursor").is_none());
            break;
        }
        assert_eq!(result["done"], false);
        cursor = result["next_cursor"].clone();
        assert!(cursor.is_string(), "non-final pages carry a cursor");
    }
    assert_eq!(pages, 3);
    assert_eq!(collected, vec!["i0", "i1", "i2", "i3", "i4"]);

    // Malformed, cross-job, and past-end cursors are schema violations.
    for bad in [
        serde_json::Value::String("not-a-cursor".to_owned()),
        serde_json::Value::String(format!("{job_id}:3")),
        serde_json::Value::String(format!("{job_id}:999")),
        serde_json::Value::String("ffffffffffffffff-9:2".to_owned()),
    ] {
        let frame = call(&mut client, channel, epoch, "embed.result", poll(bad)).await;
        assert_eq!(frame.error_code(), "schema_violation");
    }

    // Re-reading a previously issued page boundary is allowed (a lost
    // response is retried with the same cursor).
    let frame = call(
        &mut client,
        channel,
        epoch,
        "embed.result",
        poll(serde_json::Value::String(format!("{job_id}:2"))),
    )
    .await;
    let body = frame.json();
    assert_eq!(body["result"]["vectors"][0]["id"], "i2");

    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn maximum_page_with_escaped_ids_fits_its_output_reservation() {
    let engine = DeterministicEngine::new();
    let lane = test_lane();
    let page: Vec<(String, String)> = (0..16)
        .map(|index| {
            let id = format!("{}{index:04x}", "\"\\\n\u{0001}".repeat(63));
            assert_eq!(id.len(), 256);
            (id, format!("text {index}"))
        })
        .collect();
    let vectors: Vec<Vec<f32>> = page
        .iter()
        .map(|(_, text)| engine.vector_for(text))
        .collect();
    let hashes: Vec<String> = page.iter().map(|(_, text)| sha256_hex(text)).collect();
    let views: Vec<protocol::VectorItemView<'_>> = page
        .iter()
        .zip(&hashes)
        .zip(&vectors)
        .map(|(((id, _), hash), vector)| protocol::VectorItemView {
            id,
            content_sha256: hash,
            vector,
        })
        .collect();
    let reservation = protocol::vector_body_reservation(&lane, &views, None);
    let mut encoded = Vec::new();
    protocol::write_vector_body(&mut encoded, &lane, &views, true, None)
        .expect("vector body serializes");
    assert!(
        encoded.len() <= reservation,
        "encoded body {} exceeds reservation {reservation}",
        encoded.len()
    );

    let host = SynapseHost::start(ready_component(engine, SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
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
        assert_ne!(frame.ty, TY_ERROR, "escaped IDs must not exhaust output");
        let body = frame.json();
        if let Some(vectors) = body["result"]["vectors"].as_array() {
            assert_eq!(vectors.len(), page.len());
            for (actual, (expected, _)) in vectors.iter().zip(&page) {
                assert_eq!(actual["id"], expected.as_str());
            }
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "job never ready");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    host.shutdown().await.expect("graceful shutdown");
}

/// The manifest bounds the model name at 128 bytes and constrains no
/// character within them, so a name of control characters serializes to six
/// bytes each. The reservation holds the serialized body, so it charges the
/// escaped length; charging the source bytes undercounts by 640 and the
/// buffer runs out mid-serialization.
#[test]
fn a_model_name_needing_escapes_fits_its_output_reservation() {
    let engine = DeterministicEngine::new();
    let mut lane = test_lane();
    lane.model = "\u{0001}".repeat(128);
    assert_eq!(lane.model.len(), 128, "the manifest model-name maximum");

    let hash = sha256_hex("text");
    let vector = engine.vector_for("text");
    let views = [protocol::VectorItemView {
        id: "i0",
        content_sha256: &hash,
        vector: &vector,
    }];

    let reservation = protocol::vector_body_reservation(&lane, &views, None);
    let mut encoded = Vec::new();
    protocol::write_vector_body(&mut encoded, &lane, &views, true, None)
        .expect("vector body serializes");
    assert!(
        encoded.len() <= reservation,
        "encoded body {} exceeds reservation {reservation}",
        encoded.len()
    );
}

#[tokio::test]
async fn unknown_and_foreign_jobs_are_module_restarted() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine, SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    for job_id in ["deadbeefdeadbeef-1", "0011223344556677-42", "no-dash-here"] {
        let mut params = constraints(&lane);
        params["job_id"] = job_id.into();
        params["request_key"] = sha256_hex("any").into();
        params["cursor"] = serde_json::Value::Null;
        let frame = call(&mut client, channel, epoch, "embed.result", params).await;
        assert_eq!(frame.error_code(), "module_restarted", "job {job_id}");
    }
    host.shutdown().await.expect("graceful shutdown");
}

#[tokio::test]
async fn wrong_request_key_for_a_live_job_is_a_schema_violation() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine, SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let page = items(&[("item:0", "keyed text")]);
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

    let mut params = constraints(&lane);
    params["job_id"] = job_id.into();
    params["request_key"] = sha256_hex("a different key").into();
    params["cursor"] = serde_json::Value::Null;
    let frame = call(&mut client, channel, epoch, "embed.result", params).await;
    assert_eq!(frame.error_code(), "schema_violation");

    host.shutdown().await.expect("graceful shutdown");
}

/// An out-of-envelope top-level field can carry an array of arbitrarily many
/// two-byte elements. A `serde_json::Value` node costs 32 bytes, so admitting
/// the field and materializing its value spends an order of magnitude more
/// transient memory than the body the ingress charge covers. Refusing the
/// field at its key leaves the array unread.
#[test]
fn an_unknown_top_level_field_is_rejected_without_reading_its_value() {
    let lane = test_lane();
    let limits = SynapseLimits::default();

    let elements = 4 * 1024 * 1024;
    let mut body = Vec::with_capacity(elements * 2 + 64);
    body.extend_from_slice(br#"{"method":"models.list","x":["#);
    for _ in 0..elements {
        body.extend_from_slice(b"0,");
    }
    body.truncate(body.len() - 1);
    body.extend_from_slice(b"]}");
    assert!(
        body.len() < 32 * 1024 * 1024,
        "the payload must stay under the body cap so the schema is the rejecting rule"
    );

    let error = protocol::parse_request_unreserved(&body, false, &lane, &limits)
        .expect_err("a field outside the request envelope is refused");
    assert_eq!(error.code, "schema_violation");

    // The identical request without that field still parses, so the rejection
    // is the unknown field and not the request shape.
    let accepted =
        protocol::parse_request_unreserved(br#"{"method":"models.list"}"#, false, &lane, &limits)
            .expect("the envelope without out-of-schema fields is accepted");
    assert_eq!(accepted, protocol::Request::ModelsList);
}

/// A routed request nested nine levels deep — with `params` preceding
/// `method` and delimiters hidden inside strings — is refused at the depth
/// preflight, while string content never counts toward depth.
#[tokio::test]
async fn a_routed_depth_nine_request_is_a_schema_violation() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine.clone(), SynapseLimits::default())).await;
    let mut client = host.client().await;
    let (channel, epoch) = open_synapse_route(&mut client).await;
    let lane = test_lane();

    let depth9: &[u8] =
        br#"{"params":{"a":"}}}}{{{{","b":{"c":{"d":{"e":{"f":{"g":1}}}}}},"method":"embed.query"}"#;
    let corr = client.next_corr();
    client
        .send_frame(
            support::raw_client::TY_REQUEST,
            support::raw_client::FLAGS_INTERACTIVE,
            channel,
            epoch,
            corr,
            depth9,
        )
        .await
        .expect("send depth-nine request");
    let (_, frame) = client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("terminal");
    assert_eq!(frame.error_code(), "schema_violation");

    // The same structural characters inside a string are payload, not depth:
    // an equivalent query with a delimiter-heavy text still embeds.
    let mut params = constraints(&lane);
    params["text"] = "}}}}}}}}{{{{[[[[]]]]".into();
    let frame = call(&mut client, channel, epoch, "embed.query", params).await;
    assert_eq!(frame.json()["result"]["done"], true);

    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the depth-nine request must never reach inference"
    );
    host.shutdown().await.expect("graceful shutdown");
}

/// A configuration advertising a request whose parse reservation exceeds the
/// fixed scratch ceiling is rejected before the ready-engine seam publishes.
#[tokio::test]
async fn a_body_above_resident_capacity_is_a_permanent_size_violation() {
    let engine = DeterministicEngine::new();
    let limits = SynapseLimits {
        // Inflating the per-item term pushes the maximal advertised body's
        // reservation past the fixed scratch pool.
        max_batch_items: 10_000_000,
        max_text_bytes: 30 * 1024 * 1024,
        max_batch_text_bytes: 30 * 1024 * 1024,
        max_retained_result_bytes: u64::MAX,
        ..SynapseLimits::default()
    };
    let error = match mc_host::synapse::SynapseComponent::ready_with_engine(
        test_lane(),
        engine.clone(),
        limits,
    ) {
        Ok(_) => panic!("an unservable parse reservation must fail startup"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("parse reservation"));
    assert_eq!(
        engine.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a startup-rejected lane must not reach inference"
    );
}
