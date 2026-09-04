//! Frozen Criterion suite for the `kernel.*` routes and the kernel primitives
//! they call. Existing cases are never edited, only added to, so a baseline
//! binary and a candidate binary always time the same work.
//!
//! # Estimand
//!
//! Every route case times one synchronous in-process call through the route
//! dispatcher: `McHandler::dispatch_value_for_test(route, request)` followed
//! by `PreparedOutput::measure` + `write_to` into a reusable byte buffer, the
//! same encoding the transport performs. That boundary covers request
//! deserialization, project binding, the blocking-pool hop, every SQLite
//! statement, the scope filter, response construction, and JSON encoding. It
//! excludes ring framing, base64 encoding on the client, and network. The
//! arrival model is not applicable: one caller, no concurrency, so the
//! reported time is service time of one logical request.
//!
//! Warm state: the store is open, every SQLite page touched by the case is in
//! the page cache, the secret scanner is constructed, and the tokio runtime
//! and blocking pool are warm. Cold variants are named `cold` and clear the
//! state they measure (the eligibility verdict cache) in the batch setup,
//! outside the timed region.
//!
//! Input distributions:
//! - `read/{n}-rows/{narrow,wide}-scope`: `n` live decisions, each admitted
//!   for `explicit_search`. `narrow` gives every row the route's own project
//!   scope so the filter visits one scope and every row serializes; `wide`
//!   spreads rows over 64 distinct scopes, one of which is the project's, so
//!   the filter loads 64 scopes and serializes `n/64` rows. `n` bounds the
//!   registry the route reads; a plugin session reads a project's whole
//!   surface at once, so the row count is the production knob.
//! - `commit/{k}-ops`: one envelope of `k` operations, three quarters
//!   `insert_decision`, one quarter `insert_observation`, with one token per
//!   16 operations naming a pre-existing row. Each iteration uses a fresh
//!   operation key and fresh object ids, so the envelope is never replayed.
//! - `commit/replay`: the same envelope re-sent; the route answers from the
//!   receipt without entering the operation.
//! - `eligibility/{n}-candidates/{cold,warm}`: `n` candidates from a
//!   population of live decisions with one artifact-citing row in eight.
//!   `cold` clears the verdict cache before each call; `warm` sends the same
//!   batch twice and times the second.
//! - `egress/decide/{outcome}`: one decision per outcome the gate can produce,
//!   so a refusal path is never mistaken for the allow path.
//! - `ingest/page/{bytes}`: one `page` call carrying `bytes` of base64 text,
//!   staged against an upload begun in the batch setup.
//! - `ingest/finish/{bytes}`: `begin` + pages run in setup; the timed call is
//!   `finish`: assemble, digest, redact, `ingest_artifact`. The store's CAS
//!   fills by `bytes` per iteration, so the group runs few samples.
//! - `redaction/{clean,dense}/{bytes}`: the kernel's windowed redactor over
//!   `bytes` of UTF-8 with zero or one keyed secret per 4 KiB, timed directly
//!   through `mc_core::redaction::redact_windowed_durable_text` since the
//!   ingest path calls exactly that.
//!
//! # Statistic
//!
//! Criterion reports mean, median, and slope per cell. The comparison harness
//! reads the **median** of each cell and compares baseline and candidate
//! binaries across process replicates; Criterion's own within-process CI is a
//! subsample and is not the keep/discard evidence.
//!
//! `MC_KERNEL_ROUTES_PROFILE=<case-prefix>` bypasses Criterion and repeats the
//! named case for ten seconds so `perf record` has a stable window.

use std::cell::RefCell;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion, Throughput};
use mc_host::{
    BindOutcome, CompositeComponent, HostInit, PrimaryComponent, RouteHandle, RouteIdentity,
};
use mc_kernel::{
    AdmissionEvent, AdmissionRequest, ArtifactIngestRequest, CommitIntent, DecisionPayload,
    DecisionSpec, DomainSpec, EventKind, KernelStore, ProviderEgress, RepositoryProvenance,
    ScopeSpec, ScopeTermSpec, Sensitivity, SourceClass, TaintClass,
};
use mc_module::dispatch::PreparedOutcome;
use mc_module::kernel_routes::KernelState;
use mc_module::{dev_descriptor_at, McHandler};
use serde_json::{json, Value};
use sha2::Digest as _;

const SESSION: &str = "session-bench";
const DOMAIN: &str = "domain";
const SECRET_LINE: &str = "password=hunter-two-very-secret-value-0123456789\n";
const FILLER_LINE: &str = "plain filler line without any credential words 0123\n";
const PAGE_BYTES_MAX: usize = 16 * 1024 * 1024;

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}

// ---------------------------------------------------------------------------
// Daemon fixture: an open handler bound to one project, driven in-process.
// ---------------------------------------------------------------------------

struct Daemon {
    _data: tempfile::TempDir,
    handler: McHandler,
    route: RouteHandle,
    project: PathBuf,
    runtime: tokio::runtime::Runtime,
    /// Reused output buffer, so the timed region allocates only what the
    /// route itself allocates.
    encoded: RefCell<Vec<u8>>,
}

impl Daemon {
    fn start() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        let data = tempfile::tempdir().expect("tempdir");
        let descriptor = dev_descriptor_at(data.path().to_str().unwrap());
        let handler = McHandler::new();
        handler.disable_kernel_sampler_for_test();
        let project = data.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let route = RouteHandle {
            channel: 7,
            epoch: 1,
        };
        runtime.block_on(async {
            PrimaryComponent::initialize(
                &handler,
                HostInit {
                    subc_capabilities: Vec::new(),
                    storage: Some(serde_json::to_value(&descriptor).unwrap()),
                },
            )
            .await
            .unwrap();
            PrimaryComponent::activate(&handler).await.unwrap();
            let started = Instant::now();
            while handler.kernel_state() != KernelState::Ready {
                assert!(
                    started.elapsed() < Duration::from_secs(20),
                    "kernel never opened"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let identity = RouteIdentity {
                project_root: project.clone(),
                harness: "bench".to_owned(),
                session: SESSION.to_owned(),
                consumer_module_id: None,
                consumer_launch_nonce: None,
                consumer_capabilities: Vec::new(),
                admission_facts: None,
                credential_fingerprints: std::collections::BTreeMap::new(),
            };
            assert!(matches!(
                handler.bind(route, identity).await,
                BindOutcome::Accept
            ));
        });
        let daemon = Self {
            _data: data,
            handler,
            route,
            project,
            runtime,
            encoded: RefCell::new(Vec::with_capacity(1 << 20)),
        };
        seed_domain(&daemon.store());
        daemon
    }

    fn store(&self) -> Arc<KernelStore> {
        self.handler.kernel_store_for_test().unwrap()
    }

    /// One routed call, encoded as the transport would encode it. Returns the
    /// encoded length so the caller can black-box it.
    fn call(&self, request: Value) -> usize {
        let outcome = self
            .runtime
            .block_on(self.handler.dispatch_value_for_test(self.route, request));
        match outcome {
            PreparedOutcome::Response(output) => {
                let mut encoded = self.encoded.borrow_mut();
                encoded.clear();
                let measured = output.measure().expect("response measures");
                measured.write_to(&mut *encoded).expect("response encodes");
                encoded.len()
            }
            PreparedOutcome::Error { code, message } => {
                panic!("kernel route answered {code}: {message}")
            }
            PreparedOutcome::Streamed => panic!("kernel route streamed"),
        }
    }

    /// The same call, parsed back, for fixtures that need a field of the answer.
    fn call_json(&self, request: Value) -> Value {
        self.call(request);
        serde_json::from_slice(&self.encoded.borrow()).expect("response is JSON")
    }

    fn assert_available(&self, request: Value) -> Value {
        let response = self.call_json(request);
        assert_eq!(
            response["state"]["kind"], "available",
            "route answered {response}"
        );
        response
    }

    fn base(&self, method: &str) -> Value {
        json!({
            "method": method,
            "v": 1,
            "session_id": SESSION,
            "project_root": self.project.to_str().unwrap(),
        })
    }

    fn shutdown(self) {
        let Self {
            handler, runtime, ..
        } = self;
        runtime.block_on(handler.shutdown()).unwrap();
    }

    /// The scope id the route materialized for this project, learned from a
    /// first route write.
    fn project_scope_id(&self) -> String {
        let response = self.assert_available(commit_request(
            self,
            "seed-scope",
            vec![insert_decision_op("seed", 0)],
            vec![],
        ));
        assert_eq!(response["receipt"]["replayed"], false);
        let read = self.assert_available(read_request(self, "explicit_search"));
        read["rows"][0]["scope_id"]
            .as_str()
            .expect("seed row carries the project scope")
            .to_string()
    }
}

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-routes-bench".to_string(),
        operation_key: key.to_string(),
        request_digest: "c".repeat(64),
        actor: "bench".to_string(),
        cause: "bench".to_string(),
    }
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("seed-domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: DOMAIN.to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: DOMAIN.to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
}

fn wire_intent(key: &str) -> Value {
    json!({
        "producer": "plugin",
        "operation_key": key,
        "request_digest": sha256_hex(key.as_bytes()),
        "actor": "assistant",
        "cause": "ctx_memory",
    })
}

fn insert_decision_op(prefix: &str, index: usize) -> Value {
    json!({"op": "insert_decision", "spec": {
        "decision_id": format!("{prefix}-decision-{index}"),
        "object_id": format!("{prefix}-decision-object-{index}"),
        "domain_id": DOMAIN,
        "decision_kind": "memory",
        "payload": {
            "summary": format!("decision {index} summarises a remembered fact about the project"),
            "rationale": format!("because the assistant observed it in turn {index}"),
        },
        "source_id": "memory-lineage",
        "source_revision": index as i64 + 1,
    }})
}

fn insert_observation_op(prefix: &str, index: usize) -> Value {
    json!({"op": "insert_observation", "spec": {
        "observation_id": format!("{prefix}-observation-{index}"),
        "object_id": format!("{prefix}-observation-object-{index}"),
        "domain_id": DOMAIN,
        "observation_kind": "code_present",
        "payload": {"summary": format!("code present {index}"), "classification": "code_present"},
        "observed_at": index as i64 + 1,
        "source_id": "observation-lineage",
        "source_revision": index as i64 + 1,
    }})
}

fn commit_request(daemon: &Daemon, key: &str, operations: Vec<Value>, tokens: Vec<Value>) -> Value {
    let mut request = daemon.base("kernel.commit");
    request["intent"] = wire_intent(key);
    request["tokens"] = json!(tokens);
    request["operations"] = json!(operations);
    request["source_kind"] = json!("assistant");
    request
}

fn read_request(daemon: &Daemon, surface: &str) -> Value {
    let mut request = daemon.base("kernel.read");
    request["surface"] = json!(surface);
    request["as_of"] = Value::Null;
    request["gated"] = json!(false);
    request
}

/// A decision written straight into the store under `scope_id`, admitted so
/// `explicit_search` serves it.
fn store_decision(index: usize, scope_id: &str, evidence_id: Option<&str>) -> DecisionSpec {
    DecisionSpec {
        decision_id: format!("store-decision-{index}"),
        object_id: format!("store-decision-object-{index}"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: Some(scope_id.to_string()),
        anchor_id: None,
        evidence_id: evidence_id.map(str::to_string),
        decision_kind: "architecture".to_string(),
        payload: DecisionPayload {
            summary: format!("decision {index} summarises a remembered fact about the project"),
            rationale: format!("because the assistant observed it in turn {index}"),
        },
        source_kind: "repo".to_string(),
        source_id: format!("lineage-{}", index % 97),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

fn admission(subject: &str) -> AdmissionRequest {
    AdmissionRequest {
        candidate_id: None,
        subject_object_id: Some(subject.to_string()),
        source_class: Some(SourceClass::ModelInference),
        taint_class: Some(TaintClass::AssistantInference),
        event: AdmissionEvent {
            kind: EventKind::Other,
            trigger_object_id: None,
            approval_object_id: None,
            evidence_id: None,
            reason: "bench".to_string(),
        },
    }
}

fn project_scope_spec(scope_id: &str, digest: &str) -> ScopeSpec {
    ScopeSpec {
        scope_id: scope_id.to_string(),
        object_id: scope_id.to_string(),
        domain_id: DOMAIN.to_string(),
        source_kind: "fixture".to_string(),
        source_id: scope_id.to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
        terms: vec![ScopeTermSpec {
            dimension: "project".to_string(),
            operator: "exact".to_string(),
            exact_value: Some(digest.to_string()),
            ..ScopeTermSpec::default()
        }],
    }
}

/// Writes `count` admitted decisions in batches of 256, spread over
/// `scope_ids` round-robin. Returns the object ids written.
fn seed_decisions(
    store: &KernelStore,
    first: usize,
    count: usize,
    scope_ids: &[String],
) -> Vec<String> {
    let mut ids = Vec::with_capacity(count);
    let mut index = first;
    let end = first + count;
    while index < end {
        let batch_end = (index + 256).min(end);
        let batch: Vec<usize> = (index..batch_end).collect();
        store
            .commit(intent(&format!("seed-decisions-{index}")), |envelope| {
                for &i in &batch {
                    let scope_id = &scope_ids[i % scope_ids.len()];
                    let spec = store_decision(i, scope_id, None);
                    let object_id = spec.object_id.clone();
                    envelope.insert_decision(spec)?;
                    envelope.record_admission(admission(&object_id))?;
                }
                Ok(String::new())
            })
            .unwrap();
        ids.extend(batch.iter().map(|i| format!("store-decision-object-{i}")));
        index = batch_end;
    }
    ids
}

/// Materializes `count` foreign project scopes beside the route's own.
fn seed_foreign_scopes(store: &KernelStore, count: usize) -> Vec<String> {
    let scopes: Vec<(String, String)> = (0..count)
        .map(|i| {
            let digest = sha256_hex(format!("/other/project/{i}").as_bytes());
            (format!("project:{digest}"), digest)
        })
        .collect();
    store
        .commit(intent("seed-foreign-scopes"), |envelope| {
            for (scope_id, digest) in &scopes {
                envelope.insert_scope(project_scope_spec(scope_id, digest))?;
            }
            Ok(String::new())
        })
        .unwrap();
    scopes.into_iter().map(|(scope_id, _)| scope_id).collect()
}

fn ingest_request(key: &str, payload: &[u8], evidence_id: &str) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key),
        payload: payload.to_vec(),
        evidence_id: evidence_id.to_string(),
        object_id: format!("evidence-object-{key}"),
        object_kind: "evidence".to_string(),
        domain_id: DOMAIN.to_string(),
        source_kind: "repository".to_string(),
        source_id: format!("src/{key}"),
        source_revision: 1,
        media_type: "text/plain".to_string(),
        retention_class: "canonical".to_string(),
        retain_until: None,
        asserted_sensitivity: Sensitivity::Normal,
        provider_egress: ProviderEgress::RemoteAllowed,
        provenance: Some(RepositoryProvenance {
            repository_id: "repo".to_string(),
            revision: "abc123".to_string(),
        }),
    }
}

/// `total` bytes of ASCII lines with one `SECRET_LINE` per `secret_every`
/// bytes when `secret_every > 0`.
fn text_payload(total: usize, secret_every: usize) -> Vec<u8> {
    let mut text = String::with_capacity(total + FILLER_LINE.len() + SECRET_LINE.len());
    let mut next_secret = secret_every;
    while text.len() < total {
        if secret_every > 0 && text.len() >= next_secret {
            text.push_str(SECRET_LINE);
            next_secret += secret_every;
        } else {
            text.push_str(FILLER_LINE);
        }
    }
    text.truncate(total);
    text.into_bytes()
}

/// `MC_KERNEL_ROUTES_GROUPS=read,commit` limits the run to the named groups
/// so a filtered run does not pay every other group's fixture setup.
fn group_enabled(group: &str) -> bool {
    match std::env::var("MC_KERNEL_ROUTES_GROUPS") {
        Ok(list) if !list.is_empty() => list.split(',').any(|g| g.trim() == group),
        _ => true,
    }
}

fn profile_target() -> Option<String> {
    std::env::var("MC_KERNEL_ROUTES_PROFILE")
        .ok()
        .filter(|s| !s.is_empty())
}

/// When a profile target is set, runs `body` for ten seconds if `case` matches
/// it and returns `true` either way so the caller skips Criterion.
fn profile_or_bench(case: &str, mut body: impl FnMut()) -> bool {
    let Some(target) = profile_target() else {
        return false;
    };
    if !case.starts_with(target.as_str()) {
        return true;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut iterations = 0u64;
    while Instant::now() < deadline {
        body();
        iterations += 1;
    }
    eprintln!("profiled {case}: {iterations} iterations");
    true
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

fn bench_read(c: &mut Criterion) {
    if !group_enabled("read") {
        return;
    }
    let mut group = c.benchmark_group("read");
    for rows in [10usize, 1_000, 50_000] {
        for (shape, scope_count) in [("narrow-scope", 1usize), ("wide-scope", 64)] {
            let daemon = Daemon::start();
            let own_scope = daemon.project_scope_id();
            let mut scopes = vec![own_scope];
            if scope_count > 1 {
                scopes.extend(seed_foreign_scopes(&daemon.store(), scope_count - 1));
            }
            seed_decisions(&daemon.store(), 0, rows, &scopes);
            let request = read_request(&daemon, "explicit_search");
            let response = daemon.assert_available(request.clone());
            let served = response["rows"].as_array().unwrap().len();
            // One seed row plus every row on the project's own scope.
            assert_eq!(served, 1 + rows.div_ceil(scope_count), "{shape} {rows}");
            let case = format!("read/{rows}-rows/{shape}");
            if profile_or_bench(&case, || {
                black_box(daemon.call(request.clone()));
            }) {
                daemon.shutdown();
                continue;
            }
            group.sample_size(if rows >= 50_000 { 10 } else { 30 });
            group.throughput(Throughput::Elements(served as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("{rows}-rows"), shape),
                &request,
                |b, request| b.iter(|| black_box(daemon.call(request.clone()))),
            );
            daemon.shutdown();
        }
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

fn commit_envelope(daemon: &Daemon, key: &str, ops: usize, token_ids: &[(String, i64)]) -> Value {
    let operations: Vec<Value> = (0..ops)
        .map(|i| {
            if i % 4 == 3 {
                insert_observation_op(key, i)
            } else {
                insert_decision_op(key, i)
            }
        })
        .collect();
    let tokens: Vec<Value> = token_ids
        .iter()
        .take(ops.div_ceil(16))
        .map(|(object_id, known_as_of)| json!({"object_id": object_id, "known_as_of": known_as_of}))
        .collect();
    commit_request(daemon, key, operations, tokens)
}

fn bench_commit(c: &mut Criterion) {
    if !group_enabled("commit") {
        return;
    }
    let mut group = c.benchmark_group("commit");
    for ops in [1usize, 16, 128] {
        let daemon = Daemon::start();
        let own_scope = daemon.project_scope_id();
        // Token targets: rows the route may mutate, with the tip they were read at.
        let targets = seed_decisions(&daemon.store(), 0, 16, std::slice::from_ref(&own_scope));
        let tip = daemon.store().tip().unwrap();
        let token_ids: Vec<(String, i64)> = targets.into_iter().map(|id| (id, tip)).collect();
        let mut counter = 0usize;
        let case = format!("commit/{ops}-ops");
        if profile_or_bench(&case, || {
            counter += 1;
            let request = commit_envelope(&daemon, &format!("p{counter}"), ops, &token_ids);
            black_box(daemon.call(request));
        }) {
            daemon.shutdown();
            continue;
        }
        group.sample_size(if ops >= 128 { 10 } else { 20 });
        group.throughput(Throughput::Elements(ops as u64));
        group.bench_function(BenchmarkId::new(format!("{ops}-ops"), "fresh"), |b| {
            b.iter_batched(
                || {
                    counter += 1;
                    commit_envelope(&daemon, &format!("k{counter}"), ops, &token_ids)
                },
                |request| black_box(daemon.call(request)),
                BatchSize::PerIteration,
            )
        });
        daemon.shutdown();
    }

    // Replay: the receipt answers without entering the operation.
    let daemon = Daemon::start();
    let own_scope = daemon.project_scope_id();
    let targets = seed_decisions(&daemon.store(), 0, 16, std::slice::from_ref(&own_scope));
    let tip = daemon.store().tip().unwrap();
    let token_ids: Vec<(String, i64)> = targets.into_iter().map(|id| (id, tip)).collect();
    let request = commit_envelope(&daemon, "replayed", 16, &token_ids);
    let first = daemon.assert_available(request.clone());
    assert_eq!(first["receipt"]["replayed"], false);
    let again = daemon.assert_available(request.clone());
    assert_eq!(again["receipt"]["replayed"], true);
    if !profile_or_bench("commit/replay", || {
        black_box(daemon.call(request.clone()));
    }) {
        group.sample_size(20);
        group.bench_with_input(
            BenchmarkId::new("replay", "16-ops"),
            &request,
            |b, request| b.iter(|| black_box(daemon.call(request.clone()))),
        );
    }
    daemon.shutdown();
    group.finish();
}

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------

fn eligibility_request(daemon: &Daemon, candidates: &[Value]) -> Value {
    let mut request = daemon.base("kernel.eligibility.batch");
    request["destination"] = json!("remote");
    request["candidates"] = json!(candidates);
    request
}

fn bench_eligibility(c: &mut Criterion) {
    if !group_enabled("eligibility") {
        return;
    }
    let mut group = c.benchmark_group("eligibility");
    for count in [1usize, 64, 1024] {
        let daemon = Daemon::start();
        let own_scope = daemon.project_scope_id();
        let store = daemon.store();
        // One artifact, cited by every eighth candidate through its evidence.
        let artifact = store
            .ingest_artifact(ingest_request(
                "cited",
                b"public artifact bytes",
                "evidence-cited",
            ))
            .unwrap();
        let ids = seed_decisions(&store, 0, count, std::slice::from_ref(&own_scope));
        let citing: Vec<String> = (0..count)
            .filter(|i| i % 8 == 7)
            .map(|i| format!("citing-decision-object-{i}"))
            .collect();
        if !citing.is_empty() {
            store
                .commit(intent("seed-citing"), |envelope| {
                    for (n, object_id) in citing.iter().enumerate() {
                        let mut spec =
                            store_decision(100_000 + n, &own_scope, Some("evidence-cited"));
                        spec.object_id = object_id.clone();
                        spec.decision_id = format!("citing-decision-{n}");
                        envelope.insert_decision(spec)?;
                        envelope.record_admission(admission(object_id))?;
                    }
                    Ok(String::new())
                })
                .unwrap();
        }
        let candidates: Vec<Value> = (0..count)
            .map(|i| {
                if i % 8 == 7 {
                    json!({
                        "object_id": format!("citing-decision-object-{i}"),
                        "source_revision": 1,
                        "artifact_digest": artifact.digest,
                    })
                } else {
                    json!({"object_id": ids[i], "source_revision": 1})
                }
            })
            .collect();
        let request = eligibility_request(&daemon, &candidates);
        let response = daemon.assert_available(request.clone());
        let verdicts = response["verdicts"].as_array().unwrap();
        assert_eq!(verdicts.len(), count);
        assert!(verdicts.iter().all(|v| v["verdict"] == "ok"), "{response}");
        drop(store);

        let cold = format!("eligibility/{count}-candidates/cold");
        if !profile_or_bench(&cold, || {
            daemon.handler.clear_eligibility_cache_for_test();
            black_box(daemon.call(request.clone()));
        }) {
            group.sample_size(if count >= 1024 { 10 } else { 30 });
            group.throughput(Throughput::Elements(count as u64));
            group.bench_with_input(
                BenchmarkId::new(format!("{count}-candidates"), "cold"),
                &request,
                |b, request| {
                    b.iter_batched(
                        || {
                            daemon.handler.clear_eligibility_cache_for_test();
                            request.clone()
                        },
                        |request| black_box(daemon.call(request)),
                        BatchSize::PerIteration,
                    )
                },
            );
        }
        let warm = daemon.assert_available(request.clone());
        assert_eq!(warm["cache_hits"], count, "{warm}");
        let warm_case = format!("eligibility/{count}-candidates/warm");
        if profile_or_bench(&warm_case, || {
            black_box(daemon.call(request.clone()));
        }) {
            daemon.shutdown();
            continue;
        }
        group.sample_size(if count >= 1024 { 10 } else { 30 });
        group.throughput(Throughput::Elements(count as u64));
        group.bench_with_input(
            BenchmarkId::new(format!("{count}-candidates"), "warm"),
            &request,
            |b, request| b.iter(|| black_box(daemon.call(request.clone()))),
        );
        daemon.shutdown();
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// egress
// ---------------------------------------------------------------------------

fn egress_request(
    daemon: &Daemon,
    digest: &str,
    destination: &str,
    asserted: &str,
    owning_object_id: &str,
) -> Value {
    let mut request = daemon.base("kernel.egress.decide");
    request["artifact_digest"] = json!(digest);
    request["destination"] = json!(destination);
    request["asserted_sensitivity"] = json!(asserted);
    request["owning_object_id"] = json!(owning_object_id);
    request
}

fn bench_egress(c: &mut Criterion) {
    if !group_enabled("egress") {
        return;
    }
    let mut group = c.benchmark_group("egress");
    let daemon = Daemon::start();
    let own_scope = daemon.project_scope_id();
    let store = daemon.store();
    let normal = store
        .ingest_artifact(ingest_request("normal", b"public bytes", "evidence-normal"))
        .unwrap();
    let mut sensitive_request = ingest_request("sensitive", b"private bytes", "evidence-sensitive");
    sensitive_request.asserted_sensitivity = Sensitivity::Sensitive;
    let sensitive = store.ingest_artifact(sensitive_request).unwrap();
    let mut secret_request = ingest_request("secret", b"classified bytes", "evidence-secret");
    secret_request.asserted_sensitivity = Sensitivity::Secret;
    let secret = store.ingest_artifact(secret_request).unwrap();
    let mut local_only_request =
        ingest_request("local-only", b"local bytes", "evidence-local-only");
    local_only_request.provider_egress = ProviderEgress::LocalOnly;
    let local_only = store.ingest_artifact(local_only_request).unwrap();
    let foreign_scope = seed_foreign_scopes(&store, 1).remove(0);
    store
        .commit(intent("seed-owners"), |envelope| {
            for (n, (evidence, scope)) in [
                ("evidence-normal", &own_scope),
                ("evidence-sensitive", &own_scope),
                ("evidence-secret", &own_scope),
                ("evidence-local-only", &own_scope),
                ("evidence-normal", &foreign_scope),
            ]
            .into_iter()
            .enumerate()
            {
                let mut spec = store_decision(200_000 + n, scope, Some(evidence));
                spec.object_id = format!("owner-{n}");
                spec.decision_id = format!("owner-decision-{n}");
                envelope.insert_decision(spec)?;
                envelope.record_admission(admission(&format!("owner-{n}")))?;
            }
            Ok(String::new())
        })
        .unwrap();
    drop(store);

    let cases: Vec<(&str, Value, Value)> = vec![
        (
            "allowed",
            egress_request(&daemon, &normal.digest, "remote", "normal", "owner-0"),
            json!("allowed"),
        ),
        (
            "under_declared",
            egress_request(&daemon, &sensitive.digest, "local", "normal", "owner-1"),
            json!({"refused": "under_declared"}),
        ),
        (
            "sensitive_remote",
            egress_request(&daemon, &sensitive.digest, "remote", "sensitive", "owner-1"),
            json!({"refused": "sensitive_remote"}),
        ),
        (
            "secret",
            egress_request(&daemon, &secret.digest, "local", "secret", "owner-2"),
            json!({"refused": "secret"}),
        ),
        (
            "provider_restricted",
            egress_request(&daemon, &local_only.digest, "remote", "normal", "owner-3"),
            json!({"refused": "provider_restricted"}),
        ),
        (
            "wrong_scope",
            egress_request(&daemon, &normal.digest, "remote", "normal", "owner-4"),
            json!({"refused": "wrong_scope"}),
        ),
        (
            "unknown_sensitive",
            egress_request(&daemon, &"0".repeat(64), "remote", "normal", "owner-0"),
            json!({"refused": "unknown_sensitive"}),
        ),
    ];
    group.sample_size(30);
    for (name, request, expected) in cases {
        let response = daemon.assert_available(request.clone());
        assert_eq!(response["decision"], expected, "{name}: {response}");
        let case = format!("egress/decide/{name}");
        if profile_or_bench(&case, || {
            black_box(daemon.call(request.clone()));
        }) {
            continue;
        }
        group.bench_with_input(BenchmarkId::new("decide", name), &request, |b, request| {
            b.iter(|| black_box(daemon.call(request.clone())))
        });
    }
    daemon.shutdown();
    group.finish();
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

fn ingest_begin_request(
    daemon: &Daemon,
    upload_id: &str,
    payload: &[u8],
    page_count: u32,
) -> Value {
    let mut request = daemon.base("kernel.artifact.ingest.begin");
    request["upload_id"] = json!(upload_id);
    request["total_bytes"] = json!(payload.len());
    request["page_count"] = json!(page_count);
    request["payload_digest"] = json!(sha256_hex(payload));
    request["intent"] = wire_intent(upload_id);
    request["request"] = json!({
        "evidence_id": format!("evidence-{upload_id}"),
        "object_id": format!("evidence-object-{upload_id}"),
        "object_kind": "evidence",
        "domain_id": DOMAIN,
        "source_kind": "repository",
        "source_id": format!("src/{upload_id}"),
        "source_revision": 1,
        "media_type": "text/plain",
        "retention_class": "canonical",
        "asserted_sensitivity": "normal",
        "provider_egress": "remote_allowed",
        "provenance": {"repository_id": "repo", "revision": "abc123"},
    });
    request
}

fn ingest_page_request(daemon: &Daemon, upload_id: &str, index: u32, bytes: &[u8]) -> Value {
    let mut request = daemon.base("kernel.artifact.ingest.page");
    request["upload_id"] = json!(upload_id);
    request["index"] = json!(index);
    request["bytes_base64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    request["page_digest"] = json!(sha256_hex(bytes));
    request
}

fn ingest_finish_request(daemon: &Daemon, upload_id: &str) -> Value {
    let mut request = daemon.base("kernel.artifact.ingest.finish");
    request["upload_id"] = json!(upload_id);
    request
}

/// Re-keys a `begin` request to `upload_id`, keeping its declared layout.
fn rekey_begin(begin: &Value, upload_id: &str) -> Value {
    let mut begin = begin.clone();
    begin["upload_id"] = json!(upload_id);
    begin["intent"] = wire_intent(upload_id);
    begin["request"]["evidence_id"] = json!(format!("evidence-{upload_id}"));
    begin["request"]["object_id"] = json!(format!("evidence-object-{upload_id}"));
    begin
}

fn bench_ingest_page(c: &mut Criterion) {
    if !group_enabled("ingest/page") {
        return;
    }
    let mut group = c.benchmark_group("ingest/page");
    for (label, bytes) in [
        ("4k", 4 * 1024usize),
        ("256k", 256 * 1024),
        ("PAGE_BYTES_MAX", PAGE_BYTES_MAX),
    ] {
        let daemon = Daemon::start();
        // One page of `bytes` inside a two-page upload, so `page` never
        // completes it and `finish` is never reached. Each iteration begins a
        // fresh upload on the route: a `begin` with a new id replaces the
        // previous upload, so the page is staged rather than re-acknowledged.
        let payload = text_payload(bytes * 2, 0);
        let (first, _) = payload.split_at(bytes);
        let page = ingest_page_request(&daemon, "u", 0, first);
        let begin = ingest_begin_request(&daemon, "u", &payload, 2);
        daemon.assert_available(begin.clone());
        let staged = daemon.assert_available(page.clone());
        assert_eq!(staged["received_pages"], 1, "{staged}");
        let mut counter = 0usize;
        let case = format!("ingest/page/{label}");
        if profile_or_bench(&case, || {
            counter += 1;
            let id = format!("u{counter}");
            daemon.call(rekey_begin(&begin, &id));
            let mut page = page.clone();
            page["upload_id"] = json!(id);
            black_box(daemon.call(page));
        }) {
            daemon.shutdown();
            continue;
        }
        group.sample_size(if bytes >= PAGE_BYTES_MAX { 10 } else { 20 });
        group.throughput(Throughput::Bytes(bytes as u64));
        group.bench_function(BenchmarkId::new("page", label), |b| {
            b.iter_batched(
                || {
                    counter += 1;
                    let id = format!("u{counter}");
                    daemon.call(rekey_begin(&begin, &id));
                    let mut page = page.clone();
                    page["upload_id"] = json!(id);
                    page
                },
                |page| black_box(daemon.call(page)),
                BatchSize::PerIteration,
            )
        });
        daemon.shutdown();
    }
    group.finish();
}

fn bench_ingest_finish(c: &mut Criterion) {
    if !group_enabled("ingest/finish") {
        return;
    }
    let mut group = c.benchmark_group("ingest/finish");
    for (label, bytes) in [("1MiB", 1usize << 20), ("64MiB", 64usize << 20)] {
        let daemon = Daemon::start();
        let payload = text_payload(bytes, 0);
        let page_count = bytes.div_ceil(PAGE_BYTES_MAX) as u32;
        let pages: Vec<Value> = payload
            .chunks(PAGE_BYTES_MAX)
            .enumerate()
            .map(|(i, chunk)| ingest_page_request(&daemon, "u", i as u32, chunk))
            .collect();
        let begin = ingest_begin_request(&daemon, "u", &payload, page_count);
        let mut counter = 0usize;
        // Every iteration ingests distinct bytes so the CAS never dedups: the
        // last line carries the counter, which changes the payload digest and
        // the last page's digest.
        let stage = |daemon: &Daemon, counter: usize| -> Value {
            let id = format!("u{counter}");
            let mut payload = payload.clone();
            let tag = format!("{counter:016}");
            let n = payload.len();
            payload[n - 17..n - 1].copy_from_slice(tag.as_bytes());
            let mut begin = rekey_begin(&begin, &id);
            begin["payload_digest"] = json!(sha256_hex(&payload));
            daemon.assert_available(begin);
            let last = pages.len() - 1;
            for (i, chunk) in payload.chunks(PAGE_BYTES_MAX).enumerate() {
                let mut page = pages[i].clone();
                page["upload_id"] = json!(id);
                if i == last {
                    page["bytes_base64"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(chunk));
                    page["page_digest"] = json!(sha256_hex(chunk));
                }
                daemon.assert_available(page);
            }
            ingest_finish_request(daemon, &id)
        };
        let case = format!("ingest/finish/{label}");
        if profile_or_bench(&case, || {
            counter += 1;
            let finish = stage(&daemon, counter);
            black_box(daemon.call(finish));
        }) {
            daemon.shutdown();
            continue;
        }
        group.sample_size(10);
        group.throughput(Throughput::Bytes(bytes as u64));
        group.bench_function(BenchmarkId::new("finish", label), |b| {
            b.iter_batched(
                || {
                    counter += 1;
                    stage(&daemon, counter)
                },
                |finish| black_box(daemon.call(finish)),
                BatchSize::PerIteration,
            )
        });
        daemon.shutdown();
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// redaction (the ingest path's windowed scan, timed alone)
// ---------------------------------------------------------------------------

fn bench_redaction(c: &mut Criterion) {
    if !group_enabled("redaction") {
        return;
    }
    let mut group = c.benchmark_group("redaction");
    for (label, bytes) in [("64k", 64usize << 10), ("4M", 4usize << 20)] {
        for (shape, secret_every) in [("clean", 0usize), ("dense", 4096)] {
            let payload = text_payload(bytes, secret_every);
            let text = std::str::from_utf8(&payload).unwrap().to_string();
            let redaction =
                mc_core::redaction::redact_windowed_durable_text(&text, 65_536).unwrap();
            assert_eq!(redaction.detections.is_empty(), secret_every == 0);
            let case = format!("redaction/{shape}/{label}");
            if profile_or_bench(&case, || {
                black_box(
                    mc_core::redaction::redact_windowed_durable_text(black_box(&text), 65_536)
                        .unwrap(),
                );
            }) {
                continue;
            }
            group.sample_size(if bytes >= (4 << 20) { 10 } else { 30 });
            group.throughput(Throughput::Bytes(bytes as u64));
            group.bench_with_input(BenchmarkId::new(shape, label), &text, |b, text| {
                b.iter(|| {
                    black_box(
                        mc_core::redaction::redact_windowed_durable_text(black_box(text), 65_536)
                            .unwrap(),
                    )
                })
            });
        }
    }
    group.finish();
}

fn configure() -> Criterion {
    Criterion::default()
        .warm_up_time(Duration::from_millis(500))
        .measurement_time(Duration::from_secs(3))
        .noise_threshold(0.02)
}

criterion_group! {
    name = benches;
    config = configure();
    targets = bench_read, bench_commit, bench_eligibility, bench_egress,
              bench_ingest_page, bench_ingest_finish, bench_redaction
}
criterion_main!(benches);
