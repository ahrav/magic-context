#![cfg(unix)]
#![forbid(unsafe_code)]

mod support;

use mc_core::CoreState;
use mc_host::TargetKind;
use mc_store::{McStore, McStoreError, ModuleMeta};
use support::direct_host::{storage_descriptor, wait_for_store, FixtureProcess};

#[tokio::test]
async fn competing_pass_counter_survives_direct_primary_lifecycle_and_reopen() {
    let root = tempfile::tempdir().expect("state root");
    let descriptor = storage_descriptor(root.path());
    let store = McStore::open(&descriptor).expect("seed store opens");
    let session = "module-counter";
    let core = CoreState::default();
    let initial = ModuleMeta {
        boundary_divergence_pending_count: 0,
        ..Default::default()
    };
    store
        .commit(session, None, &core, &initial)
        .expect("initial state commits");

    let winner = store.load(session).expect("winner snapshot");
    let loser = store.load(session).expect("loser snapshot");
    let mut winner_meta = winner.meta.clone();
    winner_meta.boundary_divergence_pending_count = 1;
    store
        .commit(session, winner.row_version, &winner.core, &winner_meta)
        .expect("winner commits");

    let mut loser_meta = loser.meta.clone();
    loser_meta.boundary_divergence_pending_count = 1;
    assert!(matches!(
        store.commit(session, loser.row_version, &loser.core, &loser_meta),
        Err(McStoreError::CasConflict {
            expected: Some(1),
            found: 2
        })
    ));
    drop(store);

    let fixture = FixtureProcess::start_at(root.path().to_path_buf());
    let client = fixture.client().await;
    let route = fixture
        .open_route(&client, "magic-context", TargetKind::ToolProvider, session)
        .await;
    let status = wait_for_store(&client, route, session).await;
    assert_eq!(status["session_id"], session);
    client.close().await.expect("managed client closes");
    fixture.shutdown();

    let reopened = McStore::open(&descriptor).expect("store reopens after fixture drain");
    assert_eq!(
        reopened
            .load(session)
            .expect("state reloads")
            .meta
            .boundary_divergence_pending_count,
        1
    );
}
