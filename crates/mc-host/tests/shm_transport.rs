mod support;

use std::sync::Arc;
use std::time::Duration;

use mc_host::shm_provider::{
    qualified_test_parameters, qualified_test_profile, single_candidate_limits, ShmProvider,
    TestPeerError, TestShmPeer, SHM_CAPABILITY_VERSION, SHM_TRANSPORT,
};
use mc_host::transport_provider::{InjectedProvider, TransportProviders};
use mc_shm_transport::profile::{AdmissionController, AdmissionError, HostLimits as ShmHostLimits};
use subc_protocol::{EnvelopeHeader, Flags, FrameType, Priority, PROTOCOL_VERSION};
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

#[tokio::test]
async fn omitted_and_unqualified_profiles_fall_back_without_side_effects() {
    let host = TestHost::start().await;
    let mut client = host.client().await;
    let response = control_response(&mut client, &offers(qualified_test_parameters())).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(response.json()["reason"], "unavailable");
    host.shutdown_gracefully().await;

    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut client = host.client().await;
    let response = control_response(&mut client, &offers(serde_json::json!({}))).await;
    assert_eq!(response.json()["selected"]["transport"], "tcp");
    assert_eq!(response.json()["reason"], "unavailable");
    assert_eq!(provider.preparation_count(), 0);
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn qualified_provider_grants_activates_correlates_and_closes() {
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut bootstrap = host.client().await;
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
    let mut bootstrap = host.client().await;
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
    let accounting = provider.accounting().expect("accounting");
    assert_eq!(accounting.active.arena_bytes, 0);
    assert_eq!(accounting.quarantined, provider.profile_charges());
    assert!(!provider.preflight(Some(&qualified_test_parameters())));
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

#[tokio::test]
async fn failure_after_prepare_closes_without_tcp_fallback_or_replay() {
    let provider = Arc::new(ShmProvider::for_qualified_test_profile(
        single_candidate_limits(),
    ));
    let providers = registry(&provider);
    let host = TestHost::start_with(move |config| config.transport_providers = providers).await;
    let mut bootstrap = host.client().await;
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
