mod support;

// Tests that drive `transport.negotiate` need an authenticated client that has not negotiated.
// `client()` negotiates TCP during connection establishment.
// Selection is sticky (§7.7.5), so a second negotiation on one generation closes the connection.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mc_host::provider_recovery::{
    CleanupOutcome, ProviderReadiness, ProviderRecovery, RecoveryBackend, SystemClock,
};
use mc_host::shm_provider::{
    qualified_test_parameters, qualified_test_profile, single_candidate_limits, ShmProvider,
    TestPeerError, TestShmPeer, SHM_CAPABILITY_VERSION, SHM_TRANSPORT,
};
use mc_host::transport_provider::{
    memory_candidate, InjectedProvider, PreflightEligibility, PreparedCandidate, ProviderContext,
    ProviderFailure, TransportProviders,
};
use mc_host::wire::{EnvelopeHeader, Flags, FrameType, Priority, PROTOCOL_VERSION};
use mc_shm_transport::profile::{
    AdmissionController, AdmissionError, HostLimits as ShmHostLimits, TargetProfile,
};
use support::raw_client::{RawClient, RawFrame, FLAGS_INTERACTIVE, TY_REQUEST, TY_RESPONSE};
use support::{TestHost, LINKED_MODULE_ID};

const BUDGET: Duration = Duration::from_secs(5);
const ROOT: &str = "/workspace/shm";

fn registry(provider: &Arc<ShmProvider>) -> TransportProviders {
    TransportProviders::with_injected(vec![Arc::clone(provider) as Arc<dyn InjectedProvider>])
}

fn offers(parameters: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "op": "transport.negotiate",
        "negotiation_version": 1,
        "offers": [
            {
                "transport": SHM_TRANSPORT,
                "capability_version": SHM_CAPABILITY_VERSION,
                "parameters": parameters
            },
            {"transport": "tcp", "capability_version": 1}
        ]
    })
}

async fn control_response(client: &mut RawClient, body: &serde_json::Value) -> RawFrame {
    let corr = client.control(body).await.expect("send control");
    client
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("control response")
        .1
}

fn request_header(channel: u16, epoch: u32, corr: u64, len: usize) -> EnvelopeHeader {
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

fn goodbye_header() -> EnvelopeHeader {
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

async fn wait_for_no_active(provider: &ShmProvider) {
    let deadline = tokio::time::Instant::now() + BUDGET;
    loop {
        if provider
            .accounting()
            .expect("accounting")
            .active
            .arena_bytes
            == 0
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "candidate did not close"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + BUDGET;
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn omitted_and_unqualified_profiles_fall_back_reasonless_without_side_effects() {
    let host = TestHost::start().await;
    let mut client = host.setup_client().await;
    let response = control_response(&mut client, &offers(qualified_test_parameters())).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert!(
        response.json().get("reason").is_none(),
        "permanent absence selects reasonless TCP (KTD6)"
    );
    host.shutdown_gracefully().await;

    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut client = host.setup_client().await;
    let response = control_response(&mut client, &offers(serde_json::json!({}))).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert!(
        response.json().get("reason").is_none(),
        "static profile ineligibility selects reasonless TCP (KTD6)"
    );
    assert_eq!(provider.preparation_count(), 0);
    assert_eq!(provider.recovery_cleanup_count(), 0);
    assert_eq!(
        provider
            .accounting()
            .expect("accounting")
            .active
            .arena_bytes,
        0
    );
    host.shutdown_gracefully().await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn admission_pressure_selects_tcp_with_exact_unavailable() {
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(ShmHostLimits {
        descriptors: 0,
        arena_bytes: 0,
        leases: 0,
        mappings: 0,
        pinned_workers: 0,
    }));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut client = host.setup_client().await;
    let response = control_response(&mut client, &offers(qualified_test_parameters())).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(
        response.json()["reason"],
        "unavailable",
        "admission pressure on an installed, statically eligible provider is dynamic (KTD6)"
    );
    assert_eq!(provider.preparation_count(), 0);
    assert_eq!(provider.recovery_cleanup_count(), 0);
    let accounting = provider.accounting().expect("accounting");
    assert_eq!(
        accounting.active,
        mc_shm_transport::profile::ResourceCharges::ZERO
    );
    assert_eq!(
        accounting.quarantined,
        mc_shm_transport::profile::ResourceCharges::ZERO
    );
    host.shutdown_gracefully().await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qualified_provider_grants_activates_correlates_and_closes() {
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut bootstrap = host.setup_client().await;
    let grant = control_response(&mut bootstrap, &offers(qualified_test_parameters())).await;
    assert_eq!(grant.ty, TY_RESPONSE);
    let grant = grant.json();
    assert_eq!(grant["selected"]["transport"], SHM_TRANSPORT);
    let token = grant["activation_token"]
        .as_str()
        .expect("activation token")
        .to_owned();
    let peer = tokio::task::block_in_place(|| {
        TestShmPeer::attach(&grant["descriptor"]).expect("attach candidate")
    });

    let activate = format!(
        r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{token}"}}"#
    )
    .into_bytes();
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 1, activate.len()), &activate)
            .expect("publish activate")
    });
    let (header, body) = tokio::task::block_in_place(|| peer.recv(BUDGET).expect("activate reply"));
    assert_eq!((header.ty, header.corr), (FrameType::Response, 1));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["op"],
        "transport.activate"
    );

    let commit = br#"{"op":"transport.commit","negotiation_version":1}"#;
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 2, commit.len()), commit)
            .expect("publish commit")
    });
    let (header, body) = tokio::task::block_in_place(|| peer.recv(BUDGET).expect("commit reply"));
    assert_eq!((header.ty, header.corr), (FrameType::Response, 2));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["op"],
        "transport.commit"
    );
    assert!(bootstrap.closed_within(BUDGET).await);

    let open = serde_json::to_vec(&serde_json::json!({
        "op": "route.open",
        "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
        "identity": {"project_root": ROOT, "harness": "opencode", "session": "shm"}
    }))
    .unwrap();
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 3, open.len()), &open)
            .expect("publish route open")
    });
    let (header, body) = tokio::task::block_in_place(|| peer.recv(BUDGET).expect("route reply"));
    assert_eq!((header.ty, header.corr), (FrameType::Response, 3));
    let opened: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let channel = u16::try_from(opened["route_channel"].as_u64().unwrap()).unwrap();
    let epoch = u32::try_from(opened["route_epoch"].as_u64().unwrap()).unwrap();

    let direct = serde_json::to_vec(&serde_json::json!({
        "mode": "direct_fill",
        "bytes": 4097,
        "value": 90
    }))
    .unwrap();
    tokio::task::block_in_place(|| {
        peer.send(request_header(channel, epoch, 4, direct.len()), &direct)
            .expect("publish direct request")
    });
    let (header, body) = tokio::task::block_in_place(|| peer.recv(BUDGET).expect("direct reply"));
    assert_eq!((header.ty, header.corr), (FrameType::Response, 4));
    assert_eq!(body, vec![90; 4097]);

    tokio::task::block_in_place(|| peer.send(goodbye_header(), &[]).expect("publish goodbye"));
    wait_for_no_active(&provider).await;
    let accounting = provider.accounting().expect("accounting");
    assert_eq!(accounting.active.arena_bytes, 0);
    assert_eq!(accounting.quarantined.arena_bytes, 0);
    assert_eq!(provider.preparation_count(), 1);
    host.shutdown_gracefully().await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quarantine_next_close_retains_charges_and_rejects_readmission() {
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut bootstrap = host.setup_client().await;
    let grant = control_response(&mut bootstrap, &offers(qualified_test_parameters())).await;
    let grant = grant.json();
    let token = grant["activation_token"]
        .as_str()
        .expect("activation token")
        .to_owned();
    let peer = tokio::task::block_in_place(|| {
        TestShmPeer::attach(&grant["descriptor"]).expect("attach candidate")
    });

    let activate = format!(
        r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{token}"}}"#
    )
    .into_bytes();
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 1, activate.len()), &activate)
            .expect("publish activate")
    });
    tokio::task::block_in_place(|| peer.recv(BUDGET).expect("activate reply"));
    let commit = br#"{"op":"transport.commit","negotiation_version":1}"#;
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 2, commit.len()), commit)
            .expect("publish commit")
    });
    tokio::task::block_in_place(|| peer.recv(BUDGET).expect("commit reply"));
    assert!(bootstrap.closed_within(BUDGET).await);

    provider.quarantine_next_close();
    tokio::task::block_in_place(|| peer.send(goodbye_header(), &[]).expect("publish goodbye"));
    wait_for_no_active(&provider).await;
    wait_for("quarantined readiness", || {
        provider.readiness() == ProviderReadiness::Quarantined
    })
    .await;
    let accounting = provider.accounting().expect("accounting");
    assert_eq!(accounting.active.arena_bytes, 0);
    assert_eq!(accounting.quarantined, provider.profile_charges());
    assert_eq!(provider.recovery_cleanup_count(), 1);
    assert_eq!(
        provider.preflight(Some(&qualified_test_parameters())),
        PreflightEligibility::DynamicallyUnavailable
    );
    host.shutdown_gracefully().await;
}

#[test]
fn admission_counts_active_plus_quarantined_commitments() {
    let profile = qualified_test_profile();
    let charge = profile.charges();
    let limits = ShmHostLimits {
        descriptors: charge.descriptors * 2,
        arena_bytes: charge.arena_bytes * 2,
        leases: charge.leases * 2,
        mappings: charge.mappings * 2,
        pinned_workers: 0,
    };
    let controller = Arc::new(AdmissionController::new(limits));
    let first = controller.admit(&profile, None).expect("first admission");
    let _quarantined = first.quarantine().expect("quarantine first");
    let _active = controller.admit(&profile, None).expect("second admission");
    assert_eq!(
        controller.can_admit(&profile, None),
        Err(AdmissionError::DescriptorLimit)
    );
    let snapshot = controller.snapshot().expect("snapshot");
    assert_eq!(snapshot.active.arena_bytes, charge.arena_bytes);
    assert_eq!(snapshot.quarantined.arena_bytes, charge.arena_bytes);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn failure_after_prepare_closes_without_tcp_fallback_or_replay() {
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut bootstrap = host.setup_client().await;
    let grant = control_response(&mut bootstrap, &offers(qualified_test_parameters())).await;
    assert_eq!(grant.json()["selected"]["transport"], SHM_TRANSPORT);
    assert_eq!(provider.preparation_count(), 1);

    let replay = serde_json::json!({
        "op": "route.open",
        "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
        "identity": {"project_root": ROOT, "harness": "opencode", "session": "no-replay"}
    });
    let body = serde_json::to_vec(&replay).unwrap();
    let corr = bootstrap.next_corr();
    bootstrap
        .send_frame(TY_REQUEST, FLAGS_INTERACTIVE, 0, 0, corr, &body)
        .await
        .expect("send post-prepare request");
    assert!(bootstrap.closed_within(BUDGET).await);
    assert!(
        host.handler.binds().is_empty(),
        "request must not replay on TCP"
    );
    wait_for_no_active(&provider).await;
    host.shutdown_gracefully().await;
}

#[cfg(target_os = "linux")]
#[test]
fn shared_memory_errors_and_debug_output_are_redacted() {
    let provider = ShmProvider::for_qualified_test_profile(single_candidate_limits());
    let sentinel = "CANARY-SHM-ENDPOINT-7f2d";
    let descriptor = serde_json::json!({
        "profile": sentinel,
        "candidate_id": 1,
        "pid": 1,
        "host_to_peer_fd": 1,
        "host_to_peer_grant": sentinel,
        "peer_to_host_fd": 2,
        "peer_to_host_grant": sentinel
    });
    let error = match TestShmPeer::attach(&descriptor) {
        Ok(_) => panic!("descriptor must fail"),
        Err(error) => error,
    };
    assert!(!format!("{error:?}").contains(sentinel));
    assert!(!error.to_string().contains(sentinel));
    assert!(!format!("{provider:?}").contains(sentinel));
    assert_eq!(format!("{:?}", TestPeerError), "TestPeerError(<redacted>)");
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const MATRIX_TRANSPORT: &str = "fake";

fn matrix_parameters() -> serde_json::Value {
    serde_json::json!({"profile": "matrix-v1"})
}

fn matrix_offers(parameters: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "op": "transport.negotiate",
        "negotiation_version": 1,
        "offers": [
            {
                "transport": MATRIX_TRANSPORT,
                "capability_version": 1,
                "parameters": parameters
            },
            {"transport": "tcp", "capability_version": 1}
        ]
    })
}

#[derive(Clone, Copy)]
enum MatrixMode {
    // Cleanup leaves readiness `Recovering`.
    Block,
    Uncertain,
}

struct MatrixBackend {
    mode: MatrixMode,
    cleanups: AtomicU64,
    probes: AtomicU64,
    admission: Arc<AdmissionController>,
    profile: Arc<TargetProfile>,
}

impl RecoveryBackend for MatrixBackend {
    fn cleanup(&self, _candidate_id: u64) -> CleanupOutcome {
        self.cleanups.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            MatrixMode::Block => loop {
                std::thread::park();
            },
            MatrixMode::Uncertain => CleanupOutcome::Uncertain,
        }
    }

    fn probe(&self) -> bool {
        self.probes.fetch_add(1, Ordering::SeqCst);
        true
    }

    fn admission_fits(&self) -> bool {
        self.admission.can_admit(&self.profile, None).is_ok()
    }
}

struct MatrixProvider {
    recovery: ProviderRecovery,
    backend: Arc<MatrixBackend>,
    admission: Arc<AdmissionController>,
    profile: Arc<TargetProfile>,
    prepared: AtomicU64,
    peers: Mutex<Vec<tokio::io::DuplexStream>>,
}

impl MatrixProvider {
    fn install(mode: MatrixMode, candidates: u64) -> Arc<Self> {
        let profile = Arc::new(qualified_test_profile());
        let charges = profile.charges();
        let admission = Arc::new(AdmissionController::new(ShmHostLimits {
            descriptors: charges.descriptors * candidates,
            arena_bytes: charges.arena_bytes * candidates,
            leases: charges.leases * candidates,
            mappings: charges.mappings * candidates,
            pinned_workers: 0,
        }));
        let backend = Arc::new(MatrixBackend {
            mode,
            cleanups: AtomicU64::new(0),
            probes: AtomicU64::new(0),
            admission: Arc::clone(&admission),
            profile: Arc::clone(&profile),
        });
        let recovery = ProviderRecovery::new(
            Arc::clone(&backend) as Arc<dyn RecoveryBackend>,
            Arc::new(SystemClock::new()),
        );
        Arc::new(Self {
            recovery,
            backend,
            admission,
            profile,
            prepared: AtomicU64::new(0),
            peers: Mutex::new(Vec::new()),
        })
    }

    fn counters(&self) -> (u64, u64, u64) {
        (
            self.backend.cleanups.load(Ordering::SeqCst),
            self.backend.probes.load(Ordering::SeqCst),
            self.prepared.load(Ordering::SeqCst),
        )
    }
}

impl InjectedProvider for MatrixProvider {
    fn transport(&self) -> &str {
        MATRIX_TRANSPORT
    }

    fn capability_version(&self) -> u32 {
        1
    }

    fn preflight(&self, parameters: Option<&serde_json::Value>) -> PreflightEligibility {
        if parameters != Some(&matrix_parameters()) {
            return PreflightEligibility::StaticallyOmitted;
        }
        if self.recovery.readiness() != ProviderReadiness::Ready
            || self.admission.can_admit(&self.profile, None).is_err()
        {
            return PreflightEligibility::DynamicallyUnavailable;
        }
        PreflightEligibility::Serveable
    }

    fn prepare(&self, ctx: &ProviderContext) -> Result<PreparedCandidate, ProviderFailure> {
        self.prepared.fetch_add(1, Ordering::SeqCst);
        let (candidate, peer) = memory_candidate(ctx, 4096);
        self.peers.lock().expect("peer lock").push(peer);
        Ok(PreparedCandidate {
            descriptor: serde_json::json!({}),
            candidate_id: 1,
            candidate,
        })
    }
}

async fn negotiate_matrix(
    provider: &Arc<MatrixProvider>,
    parameters: serde_json::Value,
) -> RawFrame {
    let registry =
        TransportProviders::with_injected(vec![Arc::clone(provider) as Arc<dyn InjectedProvider>]);
    let host = TestHost::start_with(move |config| config.transport_providers = registry).await;
    let mut client = host.setup_client().await;
    let response = control_response(&mut client, &matrix_offers(parameters)).await;
    host.shutdown_gracefully().await;
    response
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preflight_matrix_keeps_static_and_dynamic_states_distinct_and_side_effect_free() {
    // Only ready, statically eligible parameters create an offer.
    let provider = MatrixProvider::install(MatrixMode::Uncertain, 1);
    let response = negotiate_matrix(&provider, matrix_parameters()).await;
    assert_eq!(response.json()["selected"]["transport"], MATRIX_TRANSPORT);
    assert_eq!(provider.counters(), (0, 0, 1));

    // Ready but statically ineligible parameters fall back to reasonless TCP.
    let provider = MatrixProvider::install(MatrixMode::Uncertain, 1);
    let response = negotiate_matrix(&provider, serde_json::json!({})).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert!(response.json().get("reason").is_none());
    assert_eq!(provider.counters(), (0, 0, 0));

    // A recovering eligible offer reports `unavailable` without invoking cleanup, probing, preparation, or admission.
    // Preflight negotiation must not invoke cleanup, probing, preparation, or admission.
    let provider = MatrixProvider::install(MatrixMode::Block, 2);
    let suspect = provider.recovery.admit_candidate(
        1,
        provider
            .admission
            .admit(&provider.profile, None)
            .expect("suspect admission"),
    );
    provider.recovery.report_suspect(suspect);
    wait_for("blocked cleanup dispatch", || {
        provider.backend.cleanups.load(Ordering::SeqCst) == 1
    })
    .await;
    assert_eq!(provider.recovery.readiness(), ProviderReadiness::Recovering);
    let baseline = provider.counters();
    let accounting = provider.admission.snapshot().expect("snapshot");
    let response = negotiate_matrix(&provider, matrix_parameters()).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(response.json()["reason"], "unavailable");
    assert_eq!(provider.counters(), baseline);
    assert_eq!(provider.admission.snapshot().expect("snapshot"), accounting);
    assert_eq!(provider.recovery.readiness(), ProviderReadiness::Recovering);

    // Static ineligibility overrides recovering readiness.
    let response = negotiate_matrix(&provider, serde_json::json!({})).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert!(response.json().get("reason").is_none());
    assert_eq!(provider.counters(), baseline);

    // A quarantined, eligible offer returns exact `unavailable`.
    let provider = MatrixProvider::install(MatrixMode::Uncertain, 1);
    let suspect = provider.recovery.admit_candidate(
        1,
        provider
            .admission
            .admit(&provider.profile, None)
            .expect("suspect admission"),
    );
    provider.recovery.report_suspect(suspect);
    wait_for("quarantined readiness", || {
        provider.recovery.readiness() == ProviderReadiness::Quarantined
    })
    .await;
    let baseline = provider.counters();
    let accounting = provider.admission.snapshot().expect("snapshot");
    let response = negotiate_matrix(&provider, matrix_parameters()).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(response.json()["reason"], "unavailable");
    assert_eq!(provider.counters(), baseline);
    assert_eq!(provider.admission.snapshot().expect("snapshot"), accounting);

    // Admission saturation makes an otherwise eligible offer dynamically unavailable.
    let provider = MatrixProvider::install(MatrixMode::Uncertain, 1);
    let held = provider
        .admission
        .admit(&provider.profile, None)
        .expect("held admission");
    let response = negotiate_matrix(&provider, matrix_parameters()).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(response.json()["reason"], "unavailable");
    assert_eq!(provider.counters(), (0, 0, 0));
    held.release();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_outranks_capability_mismatch_across_offers() {
    // An unavailable eligible offer takes precedence over a version-mismatched sibling in either preference order.
    // An unavailable eligible offer and a version-mismatched sibling must fall back with `unavailable` in either preference order.
    // Only `unavailable` authorizes a client re-upgrade probe (§7.7.3).
    // Reporting a static mismatch instead of `unavailable` would suppress recovery probing.
    for unavailable_first in [true, false] {
        let provider = MatrixProvider::install(MatrixMode::Uncertain, 1);
        let held = provider
            .admission
            .admit(&provider.profile, None)
            .expect("held admission");
        let eligible = serde_json::json!({
            "transport": MATRIX_TRANSPORT,
            "capability_version": 1,
            "parameters": matrix_parameters()
        });
        let mismatched = serde_json::json!({
            "transport": MATRIX_TRANSPORT,
            "capability_version": 99,
            "parameters": matrix_parameters()
        });
        let mut offer_list = if unavailable_first {
            vec![eligible, mismatched]
        } else {
            vec![mismatched, eligible]
        };
        offer_list.push(serde_json::json!({"transport": "tcp", "capability_version": 1}));
        let body = serde_json::json!({
            "op": "transport.negotiate",
            "negotiation_version": 1,
            "offers": offer_list
        });
        let registry = TransportProviders::with_injected(vec![
            Arc::clone(&provider) as Arc<dyn InjectedProvider>
        ]);
        let host = TestHost::start_with(move |config| config.transport_providers = registry).await;
        let mut client = host.setup_client().await;
        let response = control_response(&mut client, &body).await;
        host.shutdown_gracefully().await;
        assert_eq!(response.json()["selected"]["transport"], "tcp");
        assert_eq!(response.json()["reason"], "unavailable");
        held.release();
    }
}

#[cfg(target_os = "linux")]
async fn commit_candidate(host: &TestHost) -> TestShmPeer {
    let mut bootstrap = host.setup_client().await;
    let grant = control_response(&mut bootstrap, &offers(qualified_test_parameters())).await;
    let grant = grant.json();
    assert_eq!(grant["selected"]["transport"], SHM_TRANSPORT);
    let token = grant["activation_token"]
        .as_str()
        .expect("activation token")
        .to_owned();
    let peer = tokio::task::block_in_place(|| {
        TestShmPeer::attach(&grant["descriptor"]).expect("attach candidate")
    });
    let activate = format!(
        r#"{{"op":"transport.activate","negotiation_version":1,"activation_token":"{token}"}}"#
    )
    .into_bytes();
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 1, activate.len()), &activate)
            .expect("publish activate")
    });
    tokio::task::block_in_place(|| peer.recv(BUDGET).expect("activate reply"));
    let commit = br#"{"op":"transport.commit","negotiation_version":1}"#;
    tokio::task::block_in_place(|| {
        peer.send(request_header(0, 0, 2, commit.len()), commit)
            .expect("publish commit")
    });
    tokio::task::block_in_place(|| peer.recv(BUDGET).expect("commit reply"));
    assert!(bootstrap.closed_within(BUDGET).await);
    peer
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readiness_changes_govern_new_offers_while_the_existing_candidate_serves() {
    let charges = qualified_test_profile().charges();
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(ShmHostLimits {
        descriptors: charges.descriptors * 2,
        arena_bytes: charges.arena_bytes * 2,
        leases: charges.leases * 2,
        mappings: charges.mappings * 2,
        pinned_workers: 0,
    }));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;

    let survivor = commit_candidate(&host).await;
    let victim = commit_candidate(&host).await;
    assert_eq!(provider.preparation_count(), 2);

    // A quarantined victim prevents admission when active quarantined charges plus one candidate exceed the frozen limits.
    // When active quarantined charges plus a new candidate exceed the frozen limits, readiness resolves to `Quarantined`.
    provider.quarantine_next_close();
    tokio::task::block_in_place(|| victim.send(goodbye_header(), &[]).expect("victim goodbye"));
    wait_for("quarantined readiness", || {
        provider.readiness() == ProviderReadiness::Quarantined
    })
    .await;
    assert_eq!(provider.recovery_cleanup_count(), 1);
    let accounting = provider.accounting().expect("accounting");
    assert_eq!(accounting.quarantined, provider.profile_charges());
    assert_eq!(accounting.active, provider.profile_charges());

    // The existing candidate continues serving traffic while readiness is `Quarantined`.
    // change (R6).
    let open = serde_json::to_vec(&serde_json::json!({
        "op": "route.open",
        "target": {"kind": "tool_provider", "module_id": LINKED_MODULE_ID},
        "identity": {"project_root": ROOT, "harness": "opencode", "session": "survivor"}
    }))
    .unwrap();
    tokio::task::block_in_place(|| {
        survivor
            .send(request_header(0, 0, 3, open.len()), &open)
            .expect("publish route open")
    });
    let (header, body) =
        tokio::task::block_in_place(|| survivor.recv(BUDGET).expect("route reply"));
    assert_eq!((header.ty, header.corr), (FrameType::Response, 3));
    let opened: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let channel = u16::try_from(opened["route_channel"].as_u64().unwrap()).unwrap();
    let epoch = u32::try_from(opened["route_epoch"].as_u64().unwrap()).unwrap();
    let direct = serde_json::to_vec(&serde_json::json!({
        "mode": "direct_fill",
        "bytes": 512,
        "value": 42
    }))
    .unwrap();
    tokio::task::block_in_place(|| {
        survivor
            .send(request_header(channel, epoch, 4, direct.len()), &direct)
            .expect("publish direct request")
    });
    let (header, body) =
        tokio::task::block_in_place(|| survivor.recv(BUDGET).expect("direct reply"));
    assert_eq!((header.ty, header.corr), (FrameType::Response, 4));
    assert_eq!(body, vec![42; 512]);

    // A new eligible offer is denied with `unavailable`, creates no worker or resource, and leaves the TCP generation healthy.
    let mut fresh = host.setup_client().await;
    let response = control_response(&mut fresh, &offers(qualified_test_parameters())).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(response.json()["reason"], "unavailable");
    assert_eq!(provider.preparation_count(), 2);
    assert_eq!(provider.recovery_cleanup_count(), 1);
    let (tcp_channel, tcp_epoch) = fresh
        .route_open(LINKED_MODULE_ID, ROOT, "opencode", "tcp-after-quarantine")
        .await
        .expect("tcp route after quarantine");
    let corr = fresh.next_corr();
    let body = serde_json::to_vec(&serde_json::json!({
        "mode": "direct_fill",
        "bytes": 64,
        "value": 7
    }))
    .unwrap();
    fresh
        .send_frame(
            TY_REQUEST,
            FLAGS_INTERACTIVE,
            tcp_channel,
            tcp_epoch,
            corr,
            &body,
        )
        .await
        .expect("send tcp request");
    let frame = fresh
        .frames_until_corr(corr, BUDGET)
        .await
        .expect("tcp terminal")
        .1;
    assert_eq!(frame.ty, TY_RESPONSE);
    assert_eq!(frame.body, vec![7; 64]);

    // The surviving candidate's clean close releases its active accounting charges; quarantined charges remain visible.
    tokio::task::block_in_place(|| {
        survivor
            .send(goodbye_header(), &[])
            .expect("survivor goodbye")
    });
    wait_for_no_active(&provider).await;
    let accounting = provider.accounting().expect("accounting");
    assert_eq!(accounting.active.arena_bytes, 0);
    assert_eq!(accounting.quarantined, provider.profile_charges());
    host.shutdown_gracefully().await;
}
