#![cfg(feature = "test-support")]
//! Deterministic CAS protocol fault battery.
//!
//! This suite proves process-crash and injected-error behavior on the developer
//! filesystem. It does not prove power-loss ordering, torn-write handling, or
//! cold-device persistence.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use mc_store::kernel::{
    ArtifactDeletionFault, ArtifactDeletionHook, ArtifactDeletionIdentity, ArtifactDeletionKind,
    ArtifactDeletionRequest, ArtifactErrorKind, ArtifactGcFault, ArtifactIngestFault,
    ArtifactIngestHook, ArtifactIngestRequest, CommitIntent, DomainSpec, KernelStore,
    ProviderEgress, RepositoryProvenance, Sensitivity,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const CHILD_MODE: &str = "MC_CAS_FAULT_CHILD_MODE";
const CHILD_ROOT: &str = "MC_CAS_FAULT_CHILD_ROOT";
const CHILD_BARRIER: &str = "MC_CAS_CRASH_BARRIER";
const INGEST_CRASH_POINT: &str = "ingest.070.object.rename.after";
const PURGE_CRASH_POINT: &str = "purge.020.reference.commit.after";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Driver {
    ReturnValue,
    ProcessKill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProtocolPoint {
    id: &'static str,
    operation: &'static str,
    persistent_edge: &'static str,
    driver: Driver,
}

const PROTOCOL: &[ProtocolPoint] = &[
    ProtocolPoint {
        id: "ingest.010.tmp.write.before",
        operation: "ingest",
        persistent_edge: "write redacted bytes to owner-only temp",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "ingest.020.tmp.fsync.before",
        operation: "ingest",
        persistent_edge: "fsync complete temp bytes",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "ingest.030.reservation.commit.before",
        operation: "ingest",
        persistent_edge: "commit live hash reservation",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "ingest.040.object.rename.before",
        operation: "ingest",
        persistent_edge: "rename temp to final hash path",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "ingest.050.object.directories-fsync.after",
        operation: "ingest",
        persistent_edge: "sync destination shard and temp directory",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "ingest.060.reference.commit.before",
        operation: "ingest",
        persistent_edge: "consume reservation and publish canonical reference",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "ingest.070.object.rename.after",
        operation: "ingest",
        persistent_edge: "published object exists before reference commit",
        driver: Driver::ProcessKill,
    },
    ProtocolPoint {
        id: "delete.010.reference.commit.before",
        operation: "delete",
        persistent_edge: "invalidate references and publish propagation barrier",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "purge.010.intent.append-fsync.before",
        operation: "purge",
        persistent_edge: "append and fsync purge intent",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "purge.020.reference.commit.after",
        operation: "purge",
        persistent_edge: "tombstone and pending unlink committed",
        driver: Driver::ProcessKill,
    },
    ProtocolPoint {
        id: "purge.030.object.unlink.before",
        operation: "purge",
        persistent_edge: "unlink object and sync shard",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "gc.010.reclaim-reservation.commit.after",
        operation: "gc",
        persistent_edge: "commit reclaiming reservation",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "gc.020.object.unlink.before",
        operation: "gc",
        persistent_edge: "unlink unreferenced object and sync shard",
        driver: Driver::ReturnValue,
    },
    ProtocolPoint {
        id: "gc.030.reclaim-clear.commit.before",
        operation: "gc",
        persistent_edge: "clear reclaiming reservation after unlink",
        driver: Driver::ReturnValue,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticState {
    canonical_refs: Vec<(String, String, String, i64, Option<i64>)>,
    reservations: Vec<(String, String)>,
    tombstones: Vec<String>,
    pending_unlinks: Vec<String>,
    barriers: Vec<(String, String, i64, bool)>,
    barrier_consumers: Vec<(String, String, i64, Option<i64>, bool)>,
    objects: Vec<(String, u64)>,
    usage_bytes: u64,
}

impl SemanticState {
    fn read(root: &Path) -> Self {
        let connection = Connection::open(root.join("core.sqlite")).unwrap();
        let canonical_refs = rows(&connection, "SELECT evidence_id,artifact_digest,artifact_reference,created_commit_seq,invalidated_commit_seq FROM evidence_meta ORDER BY evidence_id", |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        });
        let reservations = rows(&connection, "SELECT artifact_digest,state FROM artifact_ingestion_reservations ORDER BY artifact_digest,reservation_id", |row| Ok((row.get(0)?, row.get(1)?)));
        let tombstones = rows(
            &connection,
            "SELECT artifact_digest FROM artifact_purge_tombstones ORDER BY artifact_digest",
            |row| row.get(0),
        );
        let pending_unlinks = rows(
            &connection,
            "SELECT artifact_digest FROM artifact_pending_unlinks ORDER BY artifact_digest",
            |row| row.get(0),
        );
        let barriers = rows(&connection, "SELECT barrier_id,artifact_digest,delete_commit_seq,completed_at IS NOT NULL FROM deletion_backfill_barriers ORDER BY barrier_id", |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)));
        let barrier_consumers = rows(&connection, "SELECT bc.barrier_id,bc.consumer_id,bc.required_checkpoint_commit_seq,c.checkpoint_commit_seq,EXISTS(SELECT 1 FROM consumer_abandonments a WHERE a.barrier_id=bc.barrier_id AND a.consumer_id=bc.consumer_id) FROM deletion_backfill_barrier_consumers bc LEFT JOIN outbox_consumers c USING(consumer_id) ORDER BY bc.barrier_id,bc.consumer_id", |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)));
        let objects = scan_objects(root);
        let usage_bytes = objects.iter().map(|(_, bytes)| bytes).sum();
        Self {
            canonical_refs,
            reservations,
            tombstones,
            pending_unlinks,
            barriers,
            barrier_consumers,
            objects,
            usage_bytes,
        }
    }
}

fn rows<T>(
    connection: &Connection,
    sql: &str,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    connection
        .prepare(sql)
        .unwrap()
        .query_map([], map)
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "cas-fault-battery".into(),
        operation_key: key.into(),
        request_digest: format!("{:x}", Sha256::digest(key.as_bytes())),
        actor: "test".into(),
        cause: "fault-proof".into(),
    }
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain".into(),
                object_id: "domain-object".into(),
                name: "fixture".into(),
                source_kind: "fixture".into(),
                source_id: "domain".into(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok("domain".into())
        })
        .unwrap();
}

fn ingest_request(key: &str, payload: &[u8]) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key),
        payload: payload.to_vec(),
        evidence_id: format!("evidence-{key}"),
        object_id: format!("object-{key}"),
        object_kind: "evidence".into(),
        domain_id: "domain".into(),
        source_kind: "repository".into(),
        source_id: format!("src/{key}"),
        source_revision: 1,
        media_type: "text/plain".into(),
        retention_class: "canonical".into(),
        retain_until: None,
        asserted_sensitivity: Sensitivity::Normal,
        provider_egress: ProviderEgress::RemoteAllowed,
        provenance: Some(RepositoryProvenance {
            repository_id: "repo".into(),
            revision: "abc123".into(),
        }),
    }
}

fn purge_request(key: &str, digest: &str) -> ArtifactDeletionRequest {
    ArtifactDeletionRequest {
        intent: intent(key),
        identity: ArtifactDeletionIdentity::Digest(digest.into()),
        kind: ArtifactDeletionKind::Purge,
        operator_id: Some("operator".into()),
        target_locator: Some("incident://fault-proof".into()),
        reason: Some("proof".into()),
        deleted_at: 42,
    }
}

fn object_path(root: &Path, digest: &str) -> PathBuf {
    root.join("artifacts/objects")
        .join(&digest[..2])
        .join(&digest[2..])
}

fn scan_objects(root: &Path) -> Vec<(String, u64)> {
    let mut result = Vec::new();
    for shard in fs::read_dir(root.join("artifacts/objects")).unwrap() {
        let shard = shard.unwrap();
        if !shard.file_type().unwrap().is_dir() {
            continue;
        }
        let prefix = shard.file_name().into_string().unwrap();
        for entry in fs::read_dir(shard.path()).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_file() {
                continue;
            }
            let digest = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let bytes = fs::read(entry.path()).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                digest,
                "object hash mismatch"
            );
            result.push((digest, bytes.len() as u64));
        }
    }
    result.sort();
    result
}

fn scan_temp_names(root: &Path) -> Vec<String> {
    let mut names = fs::read_dir(root.join("artifacts/tmp"))
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.unwrap();
            entry
                .file_type()
                .unwrap()
                .is_file()
                .then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}

/// `KernelStore::open` sweeps `artifacts/tmp`, so a leaked temp is only
/// observable before the next open.
fn assert_no_leaked_temps(root: &Path, context: &str) {
    assert_eq!(
        scan_temp_names(root),
        Vec::<String>::new(),
        "{context} leaked a temp file"
    );
}

fn assert_semantic_oracle(root: &Path) -> SemanticState {
    let store = KernelStore::open(root).unwrap();
    let reconciled_usage = store.artifact_budget_facts().unwrap().usage_bytes;
    drop(store);
    let state = SemanticState::read(root);
    for (_, digest, reference, _, invalidated) in &state.canonical_refs {
        if invalidated.is_none() {
            assert_eq!(
                reference,
                &format!("objects/{}/{}", &digest[..2], &digest[2..])
            );
            assert!(
                object_path(root, digest).is_file(),
                "live canonical reference lacks object {digest}"
            );
        }
    }
    for digest in &state.tombstones {
        assert!(
            !object_path(root, digest).exists(),
            "acknowledged purge resurrected {digest}"
        );
    }
    assert_eq!(reconciled_usage, state.usage_bytes);
    state
}

fn recover_twice(root: &Path) -> SemanticState {
    let first = assert_semantic_oracle(root);
    let second = assert_semantic_oracle(root);
    assert_eq!(first, second, "second recovery changed semantic state");
    first
}

fn assert_drives(driven: &[&str], driver: Driver, operations: &[&str]) {
    let declared = PROTOCOL
        .iter()
        .filter(|point| point.driver == driver && operations.contains(&point.operation))
        .collect::<Vec<_>>();
    let expected = declared
        .iter()
        .map(|point| point.id)
        .collect::<std::collections::BTreeSet<_>>();
    let driven = driven
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        driven,
        expected,
        "{operations:?}/{driver:?} coverage drifted from the declared protocol: {}",
        declared
            .iter()
            .map(|point| format!("{} = {}", point.id, point.persistent_edge))
            .collect::<Vec<_>>()
            .join("; ")
    );
}

#[test]
fn protocol_descriptor_ids_are_unique() {
    let ids = PROTOCOL
        .iter()
        .map(|point| point.id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), PROTOCOL.len());
}

#[test]
fn return_value_fault_table_latches_eio_and_never_publishes_a_reference() {
    let mut driven = Vec::new();
    for (point, fault) in [
        ("ingest.010.tmp.write.before", ArtifactIngestFault::Write),
        ("ingest.020.tmp.fsync.before", ArtifactIngestFault::FileSync),
        (
            "ingest.030.reservation.commit.before",
            ArtifactIngestFault::ReservationCommit,
        ),
        (
            "ingest.040.object.rename.before",
            ArtifactIngestFault::Rename,
        ),
        (
            "ingest.050.object.directories-fsync.after",
            ArtifactIngestFault::AfterDirectorySync,
        ),
        (
            "ingest.060.reference.commit.before",
            ArtifactIngestFault::AfterEvents,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = KernelStore::open(root.path()).unwrap();
        seed_domain(&store);
        let error = store
            .ingest_artifact_with_fault_for_test(ingest_request(point, point.as_bytes()), fault)
            .unwrap_err();
        assert!(
            matches!(
                error.kind(),
                ArtifactErrorKind::IngestionFailClosed | ArtifactErrorKind::ReferenceCommit
            ),
            "{point}: {error}"
        );
        let state = SemanticState::read(root.path());
        assert!(state.canonical_refs.is_empty(), "{point}");
        assert!(
            state.objects.is_empty(),
            "{point} left an unreferenced object: {:?}",
            state.objects
        );
        assert!(
            state.reservations.is_empty(),
            "{point} left a reservation: {:?}",
            state.reservations
        );
        assert_no_leaked_temps(root.path(), point);
        // The two transaction faults leave the store usable; the rest fail closed.
        if fault == ArtifactIngestFault::ReservationCommit
            || fault == ArtifactIngestFault::AfterEvents
        {
            store
                .ingest_artifact(ingest_request(&format!("usable-{point}"), b"usable"))
                .unwrap_or_else(|error| panic!("{point} left the store unusable: {error}"));
        } else {
            assert_eq!(
                store
                    .ingest_artifact(ingest_request("latched", b"latched"))
                    .unwrap_err()
                    .kind(),
                ArtifactErrorKind::IngestionFailClosed,
                "{point}"
            );
        }
        driven.push(point);
    }
    assert_drives(&driven, Driver::ReturnValue, &["ingest"]);
}

#[test]
fn purge_and_gc_fault_table_preserves_pending_work_and_converges() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ingest_request("unlink", b"unlink"))
        .unwrap();
    let error = store
        .delete_artifact_with_fault_for_test(
            purge_request("purge-unlink", &handle.digest),
            ArtifactDeletionFault::Unlink,
        )
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::PurgeUnlinkPending);
    drop(store);
    let recovered = recover_twice(root.path());
    assert!(recovered.tombstones.contains(&handle.digest));

    let mut driven = Vec::new();
    for (point, fault) in [
        (
            "gc.010.reclaim-reservation.commit.after",
            ArtifactGcFault::AfterReclaiming,
        ),
        ("gc.020.object.unlink.before", ArtifactGcFault::Unlink),
        (
            "gc.030.reclaim-clear.commit.before",
            ArtifactGcFault::AfterUnlink,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = KernelStore::open(root.path()).unwrap();
        seed_domain(&store);
        let handle = store.ingest_artifact(ingest_request("gc", b"gc")).unwrap();
        store
            .delete_artifact(ArtifactDeletionRequest {
                kind: ArtifactDeletionKind::Delete,
                operator_id: None,
                target_locator: None,
                reason: None,
                ..purge_request("delete", &handle.digest)
            })
            .unwrap();
        let deleted_at: i64 = Connection::open(root.path().join("core.sqlite"))
            .unwrap()
            .query_row("SELECT MAX(recorded_at) FROM commit_log", [], |row| {
                row.get(0)
            })
            .unwrap();
        let outcome =
            store.run_staging_maintenance_with_fault_for_test(deleted_at + 15 * DAY_MS, fault);
        match fault {
            ArtifactGcFault::AfterReclaiming | ArtifactGcFault::AfterUnlink => {
                assert!(outcome.is_err(), "{fault:?} did not abort the pass");
            }
            ArtifactGcFault::Unlink => {
                let result =
                    outcome.unwrap_or_else(|error| panic!("{fault:?} aborted the pass: {error:?}"));
                assert!(
                    result.artifact_gc.failed_candidates >= 1,
                    "{fault:?} was not counted as a failed candidate"
                );
            }
        }
        drop(store);
        let recovered = recover_twice(root.path());
        assert!(
            !recovered
                .objects
                .iter()
                .any(|(digest, _)| digest == &handle.digest),
            "{fault:?}"
        );
        assert!(
            !recovered
                .reservations
                .iter()
                .any(|(digest, _)| digest == &handle.digest),
            "{fault:?}"
        );
        driven.push(point);
    }
    assert_drives(&driven, Driver::ReturnValue, &["gc"]);
}

#[test]
fn deletion_return_faults_separate_intent_envelope_and_unlink_outcomes() {
    let mut driven = Vec::new();
    for (point, fault, expected, committed) in [
        (
            "purge.010.intent.append-fsync.before",
            ArtifactDeletionFault::IntentAppend,
            ArtifactErrorKind::PurgeIntent,
            false,
        ),
        (
            "delete.010.reference.commit.before",
            ArtifactDeletionFault::BeforeCommit,
            ArtifactErrorKind::ReferenceCommit,
            false,
        ),
        (
            "purge.030.object.unlink.before",
            ArtifactDeletionFault::Unlink,
            ArtifactErrorKind::PurgeUnlinkPending,
            true,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = KernelStore::open(root.path()).unwrap();
        seed_domain(&store);
        let handle = store
            .ingest_artifact(ingest_request("deletion-fault", b"deletion fault"))
            .unwrap();
        let error = store
            .delete_artifact_with_fault_for_test(
                purge_request("purge-fault", &handle.digest),
                fault,
            )
            .unwrap_err();
        assert_eq!(error.kind(), expected, "{fault:?}");
        let state = SemanticState::read(root.path());
        assert_eq!(
            state.tombstones.contains(&handle.digest),
            committed,
            "{fault:?}"
        );
        assert_eq!(
            state.pending_unlinks.contains(&handle.digest),
            committed,
            "{fault:?}"
        );
        // A rolled-back deletion must leave the reference live, not half-invalidated.
        if !committed {
            assert!(
                state
                    .canonical_refs
                    .iter()
                    .any(|(_, digest, _, _, invalidated)| digest == &handle.digest
                        && invalidated.is_none()),
                "{fault:?} invalidated a reference without committing"
            );
            assert!(state.barriers.is_empty(), "{fault:?} published a barrier");
        }
        driven.push(point);
    }
    assert_drives(&driven, Driver::ReturnValue, &["delete", "purge"]);
}

#[test]
fn fixed_seed_selected_failpoints_replay_the_full_lifecycle() {
    let faults = [
        ArtifactIngestFault::Write,
        ArtifactIngestFault::FileSync,
        ArtifactIngestFault::ReservationCommit,
        ArtifactIngestFault::Rename,
        ArtifactIngestFault::AfterDirectorySync,
        ArtifactIngestFault::AfterEvents,
    ];
    for (run, fault) in faults.into_iter().enumerate() {
        let run = i64::try_from(run).unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = KernelStore::open(root.path()).unwrap();
        seed_domain(&store);
        assert!(store
            .ingest_artifact_with_fault_for_test(
                ingest_request(&format!("fault-{run}"), b"lifecycle"),
                fault
            )
            .is_err());
        drop(store);

        let store = KernelStore::open(root.path()).unwrap();
        let first = store
            .ingest_artifact(ingest_request(&format!("first-{run}"), b"lifecycle"))
            .unwrap();
        let deletion = store
            .delete_artifact(ArtifactDeletionRequest {
                kind: ArtifactDeletionKind::Delete,
                operator_id: None,
                target_locator: None,
                reason: None,
                ..purge_request(&format!("delete-{run}"), &first.digest)
            })
            .unwrap();
        let recorded_at: i64 = Connection::open(root.path().join("core.sqlite"))
            .unwrap()
            .query_row(
                "SELECT recorded_at FROM commit_log WHERE commit_seq=?1",
                [deletion.commit_seq],
                |row| row.get(0),
            )
            .unwrap();
        store
            .run_staging_maintenance(recorded_at + 15 * DAY_MS)
            .unwrap();
        assert!(
            !object_path(root.path(), &first.digest).exists(),
            "run {run}, {fault:?}"
        );

        let second = store
            .ingest_artifact(ingest_request(&format!("second-{run}"), b"lifecycle"))
            .unwrap();
        let purge = store
            .delete_artifact(purge_request(&format!("purge-{run}"), &second.digest))
            .unwrap();
        store
            .commit(intent(&format!("clear-{run}")), |envelope| {
                envelope.abandon_deletion_barrier(
                    &purge.barrier_id,
                    "operator",
                    "no consumers",
                    100 + run,
                )?;
                Ok("cleared".into())
            })
            .unwrap();
        assert!(store.deletion_barrier(&purge.barrier_id).unwrap().cleared);
        assert!(!object_path(root.path(), &second.digest).exists());
        drop(store);
        recover_twice(root.path());
    }
}

#[test]
fn commit_failure_cleanup_preserves_a_surviving_dedup_reservation() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"shared reservation";
    let digest = format!("{:x}", Sha256::digest(payload));
    let db = root.path().join("core.sqlite");
    let error = store.ingest_artifact_with_protocol_hook_for_test(
        ingest_request("failing", payload),
        Some(ArtifactIngestFault::AfterEvents),
        |hook| if hook == ArtifactIngestHook::AfterPublish {
            Connection::open(&db).unwrap().execute(
                "INSERT INTO artifact_ingestion_reservations(reservation_id,artifact_digest,artifact_reference,state,writer_epoch,created_at,heartbeat_at,lease_expires_at) VALUES ('survivor',?1,?2,'Live',?3,0,0,?4)",
                params![digest, format!("objects/{}/{}", &digest[..2], &digest[2..]), i64::try_from(store.lease_epoch()).unwrap(), i64::MAX],
            ).unwrap();
        },
    ).unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::ReferenceCommit);
    assert!(object_path(root.path(), &digest).is_file());
    assert_eq!(
        SemanticState::read(root.path()).reservations,
        vec![(digest, "Live".into())]
    );
}

#[test]
fn successful_reference_consumes_its_reservation_atomically() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ingest_request("atomic", b"atomic"))
        .unwrap();
    let state = SemanticState::read(root.path());
    assert!(state
        .canonical_refs
        .iter()
        .any(|(_, digest, _, _, invalidated)| digest == &handle.digest && invalidated.is_none()));
    assert!(!state
        .reservations
        .iter()
        .any(|(digest, _)| digest == &handle.digest));
}

#[test]
fn startup_leaves_reservations_whose_digest_still_has_reference_history() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ingest_request("startup-history", b"startup history"))
        .unwrap();
    store
        .delete_artifact(ArtifactDeletionRequest {
            kind: ArtifactDeletionKind::Delete,
            operator_id: None,
            target_locator: None,
            reason: None,
            ..purge_request("startup-history-delete", &handle.digest)
        })
        .unwrap();
    insert_stale_live_reservation(root.path(), &handle.digest, store.lease_epoch());
    drop(store);

    let reopened = KernelStore::open(root.path()).unwrap();
    assert!(object_path(root.path(), &handle.digest).is_file());
    assert_eq!(
        SemanticState::read(root.path()).reservations,
        vec![(handle.digest, "Live".into())],
        "invalidated reference history must not be classified at startup"
    );
    drop(reopened);
}

#[test]
fn expired_reference_history_reclaims_past_a_prior_epoch_reservation_lease() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(ingest_request("stale-lease", b"stale lease"))
        .unwrap();
    let deletion = store
        .delete_artifact(ArtifactDeletionRequest {
            kind: ArtifactDeletionKind::Delete,
            operator_id: None,
            target_locator: None,
            reason: None,
            ..purge_request("stale-lease-delete", &handle.digest)
        })
        .unwrap();
    let deleted_at: i64 = Connection::open(root.path().join("core.sqlite"))
        .unwrap()
        .query_row(
            "SELECT recorded_at FROM commit_log WHERE commit_seq=?1",
            [deletion.commit_seq],
            |row| row.get(0),
        )
        .unwrap();
    insert_stale_live_reservation(root.path(), &handle.digest, store.lease_epoch());
    drop(store);

    let store = KernelStore::open(root.path()).unwrap();
    store
        .run_staging_maintenance(deleted_at + 15 * DAY_MS)
        .unwrap();
    let state = SemanticState::read(root.path());
    assert!(
        !object_path(root.path(), &handle.digest).is_file(),
        "unexpired lease from a dead writer blocked reclamation"
    );
    assert!(
        state.reservations.is_empty(),
        "reclaimed digest left a reservation: {:?}",
        state.reservations
    );
    drop(store);
    recover_twice(root.path());
}

fn insert_stale_live_reservation(root: &Path, digest: &str, lease_epoch: u64) {
    Connection::open(root.join("core.sqlite"))
        .unwrap()
        .execute(
            "INSERT INTO artifact_ingestion_reservations(
                 reservation_id,artifact_digest,artifact_reference,state,writer_epoch,
                 created_at,heartbeat_at,lease_expires_at
             ) VALUES ('prior-live',?1,?2,'Live',?3,1,1,?4)",
            params![
                digest,
                format!("objects/{}/{}", &digest[..2], &digest[2..]),
                i64::try_from(lease_epoch).unwrap(),
                i64::MAX
            ],
        )
        .unwrap();
}

#[test]
fn crash_windows_recover_idempotently_and_match_no_crash_execution() {
    let crashed = tempfile::tempdir().unwrap();
    run_crash_child(crashed.path(), "post-rename");
    let crashed_state = recover_twice(crashed.path());

    let expected = tempfile::tempdir().unwrap();
    let store = KernelStore::open(expected.path()).unwrap();
    seed_domain(&store);
    drop(store);
    assert_eq!(crashed_state, recover_twice(expected.path()));

    let crashed = tempfile::tempdir().unwrap();
    run_crash_child(crashed.path(), "post-purge-commit");
    let crashed_state = recover_twice(crashed.path());

    let expected = tempfile::tempdir().unwrap();
    let store = KernelStore::open(expected.path()).unwrap();
    seed_domain(&store);
    let expected_handle = store
        .ingest_artifact(ingest_request("purge-target", b"purge target"))
        .unwrap();
    store
        .delete_artifact(purge_request("purge-crash", &expected_handle.digest))
        .unwrap();
    drop(store);
    assert_eq!(crashed_state, recover_twice(expected.path()));

    assert_drives(
        &[INGEST_CRASH_POINT, PURGE_CRASH_POINT],
        Driver::ProcessKill,
        &["ingest", "purge"],
    );
}

/// Re-executed by `run_crash_child` with `--exact`; a direct run returns early.
#[test]
fn crash_child_entrypoint_reexecuted_by_the_parent() {
    let Ok(mode) = std::env::var(CHILD_MODE) else {
        return;
    };
    let root = PathBuf::from(std::env::var_os(CHILD_ROOT).unwrap());
    let store = KernelStore::open(&root).unwrap();
    seed_domain(&store);
    match mode.as_str() {
        "post-rename" => {
            let _ = store.ingest_artifact_with_protocol_hook_for_test(
                ingest_request("crash-ingest", b"crash ingest"),
                None,
                |hook| {
                    if hook == ArtifactIngestHook::AfterPublish {
                        crash_barrier(INGEST_CRASH_POINT)
                    }
                },
            );
        }
        "post-purge-commit" => {
            let handle = store
                .ingest_artifact(ingest_request("purge-target", b"purge target"))
                .unwrap();
            let _ = store.delete_artifact_with_hook_for_test(
                purge_request("purge-crash", &handle.digest),
                |hook| {
                    if hook == ArtifactDeletionHook::AfterCommit {
                        crash_barrier(PURGE_CRASH_POINT)
                    }
                },
            );
        }
        other => panic!("unknown child mode {other}"),
    }
    panic!("child crossed crash barrier");
}

fn crash_barrier(point: &str) -> ! {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{CHILD_BARRIER} {point}").unwrap();
    stdout.flush().unwrap();
    drop(stdout);
    loop {
        std::thread::park();
    }
}

fn run_crash_child(root: &Path, mode: &str) {
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "crash_child_entrypoint_reexecuted_by_the_parent",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_MODE, mode)
            .env(CHILD_ROOT, root)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let line = BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
            .find(|line| line.contains(CHILD_BARRIER));
        let _ = tx.send(line);
    });
    rx.recv_timeout(Duration::from_secs(60))
        .expect("child barrier timeout")
        .expect("child exited before barrier");
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
