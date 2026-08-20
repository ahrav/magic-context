//! Wire-level conformance for the four Synapse operations over a real
//! authenticated route, using the deterministic test engine.

mod support;

use support::synapse::{
    batch_params, call, constraints, items, open_synapse_route, ready_component, request_key,
    sha256_hex, test_lane, DeterministicEngine, SynapseHost, BUDGET,
};

use mc_host::synapse::{protocol, SynapseLimits};

const TY_ERROR: u8 = 5;

#[tokio::test]
async fn models_list_returns_exactly_the_certified_entry() {
    let engine = DeterministicEngine::new();
    let host = SynapseHost::start(ready_component(engine, SynapseLimits::default())).await;
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
    let host = SynapseHost::start_with(
        ready_component(engine.clone(), SynapseLimits::default()),
        |config| config.limits.max_handler_tasks = 2,
    )
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
