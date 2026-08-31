#![cfg(feature = "test-support")]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use mc_store::kernel::{
    ArtifactDestination, ArtifactEligibility, ArtifactErrorKind, ArtifactHandle,
    ArtifactIngestFault, ArtifactIngestRequest, CommitIntent, DomainSpec, EligibilityDeniedReason,
    KernelStore, ProviderEgress, RepositoryProvenance, Sensitivity,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
const MIB: usize = 1024 * 1024;

fn assert_send_sync<T: Send + Sync>() {}

fn intent(key: &str, payload: &[u8]) -> CommitIntent {
    CommitIntent {
        producer: "kernel-cas-test".to_string(),
        operation_key: key.to_string(),
        request_digest: format!("{:x}", Sha256::digest(payload)),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("domain", b"domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain".to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok("domain".to_string())
        })
        .unwrap();
}

fn request(key: &str, payload: Vec<u8>) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key, &payload),
        payload,
        evidence_id: format!("evidence-{key}"),
        object_id: format!("evidence-object-{key}"),
        object_kind: "evidence".to_string(),
        domain_id: "domain".to_string(),
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

fn artifact_path(root: &std::path::Path, digest: &str) -> std::path::PathBuf {
    root.join("artifacts/objects")
        .join(&digest[..2])
        .join(&digest[2..])
}

fn invalidate_evidence(store: &KernelStore, root: &std::path::Path, evidence_id: &str) {
    // invalidated_commit_seq must reference a commit strictly later than the one
    // that created the row, so take a real later sequence rather than reusing
    // created_commit_seq.
    let commit_seq = store
        .commit(
            intent(&format!("invalidate-{evidence_id}"), evidence_id.as_bytes()),
            |_| Ok(evidence_id.to_string()),
        )
        .unwrap()
        .commit_seq;
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE evidence_meta SET invalidated_commit_seq=?2 WHERE evidence_id=?1",
            params![evidence_id, commit_seq],
        )
        .unwrap();
}

fn tree_bytes(path: &std::path::Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut pending = vec![path.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            pending.extend(
                fs::read_dir(path)
                    .unwrap()
                    .map(|entry| entry.unwrap().path()),
            );
        } else if metadata.is_file() {
            bytes.extend(fs::read(path).unwrap());
        }
    }
    bytes
}

#[test]
fn ingest_publishes_sharded_redacted_bytes_and_commits_live_reference() {
    assert_send_sync::<KernelStore>();
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = format!("prefix {SECRET} suffix").into_bytes();

    let handle = store.ingest_artifact(request("happy", payload)).unwrap();
    let stored = store.read_artifact(&handle).unwrap();

    assert!(!stored
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
    assert_eq!(format!("{:x}", Sha256::digest(&stored)), handle.digest);
    assert_eq!(
        fs::read(artifact_path(root.path(), &handle.digest)).unwrap(),
        stored
    );
    assert_eq!(
        fs::metadata(root.path().join("artifacts"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(!tree_bytes(root.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let row: (i64, i64, String, String) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM evidence_meta WHERE evidence_id=?1 AND invalidated_commit_seq IS NULL),
                    (SELECT COUNT(*) FROM artifact_ingestion_reservations WHERE artifact_digest=?2),
                    detector_id,secret_type
             FROM evidence_meta WHERE evidence_id=?1",
            params![handle.evidence_id, handle.digest],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            1,
            0,
            "redaction-vocabulary-v1".to_string(),
            "anthropic_api_key".to_string()
        )
    );
}

#[test]
fn payload_limit_is_inclusive() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);

    store
        .ingest_artifact(request("limit", vec![b'x'; 64 * MIB]))
        .unwrap();
    let error = store
        .ingest_artifact(request("over-limit", vec![b'x'; 64 * MIB + 1]))
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::PayloadTooLarge);
}

#[test]
fn dedup_merges_sensitivity_and_provider_restrictions_restrictively() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"same clean bytes".to_vec();
    let first = store
        .ingest_artifact(request("dedup-normal", payload.clone()))
        .unwrap();
    let mut restrictive = request("dedup-sensitive", payload);
    restrictive.asserted_sensitivity = Sensitivity::Sensitive;
    restrictive.provider_egress = ProviderEgress::LocalOnly;
    let second = store.ingest_artifact(restrictive).unwrap();

    assert_eq!(first.digest, second.digest);
    assert_eq!(
        store
            .artifact_eligibility(&first, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote)
    );
    assert_eq!(
        store
            .artifact_eligibility(&second, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote)
    );
    assert_eq!(
        fs::read_dir(artifact_path(root.path(), &first.digest).parent().unwrap())
            .unwrap()
            .count(),
        1
    );

    let other_payload = b"same public bytes".to_vec();
    let first = store
        .ingest_artifact(request("egress-open", other_payload.clone()))
        .unwrap();
    let mut local_only = request("egress-local", other_payload);
    local_only.provider_egress = ProviderEgress::LocalOnly;
    store.ingest_artifact(local_only).unwrap();
    assert_eq!(
        store
            .artifact_eligibility(&first, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::ProviderRestricted)
    );
}

#[test]
fn unproven_normal_and_non_utf8_are_clamped_sensitive() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let mut unproven = request("unproven", b"clean".to_vec());
    unproven.provenance = None;
    let unproven = store.ingest_artifact(unproven).unwrap();
    let binary = store
        .ingest_artifact(request("binary", vec![0xff, 0xfe, 0xfd]))
        .unwrap();

    for handle in [&unproven, &binary] {
        assert_eq!(
            store
                .artifact_eligibility(handle, ArtifactDestination::Remote)
                .unwrap(),
            ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote)
        );
        assert_eq!(
            store
                .artifact_eligibility(handle, ArtifactDestination::Local)
                .unwrap(),
            ArtifactEligibility::Allowed
        );
    }
}

#[test]
fn cap_error_reports_usage_and_cap_without_poisoning_reads() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open_with_artifact_cap_for_test(root.path(), 8).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(request("within-cap", b"12345678".to_vec()))
        .unwrap();
    let error = store
        .ingest_artifact(request("over-cap", b"9".to_vec()))
        .unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::Capacity);
    assert_eq!(error.usage(), Some(8));
    assert_eq!(error.cap(), Some(8));
    assert_eq!(store.read_artifact(&handle).unwrap(), b"12345678");
}

#[test]
fn invalidated_retained_object_still_consumes_cap() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open_with_artifact_cap_for_test(root.path(), 8).unwrap();
    seed_domain(&store);
    let retained = store
        .ingest_artifact(request("retained", b"12345678".to_vec()))
        .unwrap();
    invalidate_evidence(&store, root.path(), &retained.evidence_id);

    let error = store
        .ingest_artifact(request("over-retained-cap", b"9".to_vec()))
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::Capacity);
    assert_eq!(error.usage(), Some(8));
}

#[test]
fn read_rejects_missing_and_corrupt_objects() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let missing = store
        .ingest_artifact(request("missing", b"missing".to_vec()))
        .unwrap();
    fs::remove_file(artifact_path(root.path(), &missing.digest)).unwrap();
    assert_eq!(
        store.read_artifact(&missing).unwrap_err().kind(),
        ArtifactErrorKind::MissingObject
    );

    let corrupt = store
        .ingest_artifact(request("corrupt", b"correct".to_vec()))
        .unwrap();
    fs::write(artifact_path(root.path(), &corrupt.digest), b"wrong").unwrap();
    assert_eq!(
        store.read_artifact(&corrupt).unwrap_err().kind(),
        ArtifactErrorKind::CorruptObject
    );
}

#[test]
fn read_rejects_malformed_digests_without_path_derivation() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();

    for digest in ["abc".to_string(), format!("{}g", "a".repeat(63))] {
        let handle = ArtifactHandle {
            digest,
            evidence_id: "untrusted".to_string(),
        };
        assert_eq!(
            store.read_artifact(&handle).unwrap_err().kind(),
            ArtifactErrorKind::InvalidInput
        );
    }
}

#[test]
fn eligibility_matrix_includes_secret_unknown_and_tombstone() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let normal = store
        .ingest_artifact(request("normal", b"public".to_vec()))
        .unwrap();
    let mut sensitive_request = request("sensitive", b"private".to_vec());
    sensitive_request.asserted_sensitivity = Sensitivity::Sensitive;
    let sensitive = store.ingest_artifact(sensitive_request).unwrap();
    let mut secret_request = request("secret", b"classified".to_vec());
    secret_request.asserted_sensitivity = Sensitivity::Secret;
    let secret = store.ingest_artifact(secret_request).unwrap();

    assert_eq!(
        store
            .artifact_eligibility(&normal, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Allowed
    );
    assert_eq!(
        store
            .artifact_eligibility(&sensitive, ArtifactDestination::Local)
            .unwrap(),
        ArtifactEligibility::Allowed
    );
    assert_eq!(
        store
            .artifact_eligibility(&sensitive, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote)
    );
    assert_eq!(
        store
            .artifact_eligibility(&secret, ArtifactDestination::Local)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::Secret)
    );
    assert_eq!(
        store
            .artifact_eligibility(&secret, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::Secret)
    );
    let unknown = ArtifactHandle {
        digest: "a".repeat(64),
        evidence_id: "absent".to_string(),
    };
    assert_eq!(
        store
            .artifact_eligibility(&unknown, ArtifactDestination::Local)
            .unwrap(),
        ArtifactEligibility::Allowed
    );
    assert_eq!(
        store
            .artifact_eligibility(&unknown, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::UnknownSensitive)
    );

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let commit_seq: i64 = connection
        .query_row("SELECT MAX(commit_seq) FROM commit_log", [], |row| {
            row.get(0)
        })
        .unwrap();
    connection.execute(
        "INSERT INTO artifact_purge_tombstones(artifact_digest,artifact_reference,operator_id,reason,purged_at,commit_seq) VALUES (?1,?2,'operator','test',1,?3)",
        params![normal.digest, format!("objects/{}/{}", &normal.digest[..2], &normal.digest[2..]), commit_seq],
    ).unwrap();
    assert_eq!(
        store
            .artifact_eligibility(&normal, ArtifactDestination::Local)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::Tombstoned)
    );
    assert_eq!(
        store
            .artifact_eligibility(&normal, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::Tombstoned)
    );
    assert_eq!(
        store
            .ingest_artifact(request("tombstone-reingest", b"public".to_vec()))
            .unwrap_err()
            .kind(),
        ArtifactErrorKind::ReAdmissionBlocked
    );
}

#[test]
fn commit_failure_cleans_reference_and_errors_never_leak_payload() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = format!("payload {SECRET}").into_bytes();
    let error = store
        .ingest_artifact_with_fault_for_test(
            request("fault", payload),
            ArtifactIngestFault::AfterEvents,
        )
        .unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::ReferenceCommit);
    assert!(!error.to_string().contains(SECRET));
    assert!(!format!("{error:?}").contains(SECRET));
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM evidence_meta WHERE evidence_id='evidence-fault'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM artifact_ingestion_reservations",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn failed_repopulation_commit_keeps_invalidated_retained_object_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"retained dedup bytes".to_vec();
    let existing = store
        .ingest_artifact(request("dedup-existing", payload.clone()))
        .unwrap();
    invalidate_evidence(&store, root.path(), &existing.evidence_id);
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let commit_seq: i64 = connection
        .query_row(
            "SELECT created_commit_seq FROM evidence_meta WHERE evidence_id=?1",
            [&existing.evidence_id],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pins(
                 capture_pin_id,pin_kind,owner_id,commit_seq,lease_epoch,writer_epoch,
                 created_at,expires_at
             ) VALUES ('retained-pin','backup','test',?1,?2,?2,1,1000)",
            params![commit_seq, i64::try_from(store.lease_epoch()).unwrap()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO capture_pin_refs(capture_pin_id,evidence_id,expires_at)
             VALUES ('retained-pin',?1,1000)",
            [&existing.evidence_id],
        )
        .unwrap();
    drop(connection);
    let object_path = artifact_path(root.path(), &existing.digest);
    fs::remove_file(&object_path).unwrap();
    assert!(!object_path.exists());

    let error = store
        .ingest_artifact_with_fault_for_test(
            request("dedup-failed", payload),
            ArtifactIngestFault::AfterEvents,
        )
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::ReferenceCommit);
    assert!(object_path.is_file());
}

#[test]
fn directory_sync_failure_latches_ingestion_but_keeps_reads_available() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let healthy = store
        .ingest_artifact(request("before-fault", b"healthy".to_vec()))
        .unwrap();

    let error = store
        .ingest_artifact_with_fault_for_test(
            request("fsync-fault", b"faulted".to_vec()),
            ArtifactIngestFault::AfterDirectorySync,
        )
        .unwrap_err();
    assert_eq!(error.kind(), ArtifactErrorKind::IngestionFailClosed);
    assert_eq!(
        store
            .ingest_artifact(request("after-fault", b"blocked".to_vec()))
            .unwrap_err()
            .kind(),
        ArtifactErrorKind::IngestionFailClosed
    );
    assert_eq!(store.read_artifact(&healthy).unwrap(), b"healthy");

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM evidence_meta WHERE evidence_id='evidence-fsync-fault'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn reopen_reclaims_stale_temps() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    drop(store);
    let stale = root.path().join("artifacts/tmp/.stale.tmp");
    fs::write(&stale, b"stale").unwrap();
    fs::set_permissions(&stale, fs::Permissions::from_mode(0o600)).unwrap();

    let _store = KernelStore::open(root.path()).unwrap();
    assert!(!stale.exists());
}

fn staged_entries(root: &std::path::Path) -> usize {
    fs::read_dir(root.join("artifacts/tmp")).unwrap().count()
}

fn published_objects(root: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending = vec![root.join("artifacts/objects")];
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                pending.push(entry.path());
            } else {
                names.push(entry.file_name().into_string().unwrap());
            }
        }
    }
    names.sort();
    names
}

fn reservation_count(root: &std::path::Path) -> i64 {
    Connection::open(root.join("core.sqlite"))
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM artifact_ingestion_reservations",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn repeated_fence_loss_stages_no_surviving_payload() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    store.invalidate_writer_fence_for_test().unwrap();

    for attempt in 0..3 {
        let error = store
            .ingest_artifact(request(&format!("fence-{attempt}"), vec![b'p'; 4 * 1024]))
            .unwrap_err();
        assert_eq!(error.kind(), ArtifactErrorKind::ReferenceCommit);
    }

    assert_eq!(staged_entries(root.path()), 0);
    assert_eq!(published_objects(root.path()), Vec::<String>::new());
}

#[test]
fn replayed_intent_returns_the_committed_reference() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"replayed payload".to_vec();

    let first = store
        .ingest_artifact(request("replay", payload.clone()))
        .unwrap();
    let second = store.ingest_artifact(request("replay", payload)).unwrap();

    assert_eq!(second.digest, first.digest);
    assert_eq!(second.evidence_id, first.evidence_id);
    assert_eq!(
        store.read_artifact(&second).unwrap(),
        b"replayed payload".to_vec()
    );
    assert_eq!(published_objects(root.path()).len(), 1);
    assert_eq!(staged_entries(root.path()), 0);
    assert_eq!(reservation_count(root.path()), 0);
}

#[test]
fn replayed_intent_over_different_bytes_publishes_no_unreferenced_object() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let pinned = format!("{:x}", Sha256::digest(b"pinned-request"));

    let mut first = request("replay-mismatch", b"committed bytes".to_vec());
    first.intent.request_digest = pinned.clone();
    let handle = store.ingest_artifact(first).unwrap();
    let published = published_objects(root.path());

    let mut second = request("replay-mismatch", b"divergent bytes".to_vec());
    second.intent.request_digest = pinned;
    second.evidence_id = "evidence-replay-divergent".to_string();
    second.object_id = "evidence-object-replay-divergent".to_string();
    let error = store.ingest_artifact(second).unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::InvalidInput);
    assert_eq!(published_objects(root.path()), published);
    assert_eq!(staged_entries(root.path()), 0);
    assert_eq!(reservation_count(root.path()), 0);
    assert_eq!(
        store.read_artifact(&handle).unwrap(),
        b"committed bytes".to_vec()
    );
}

#[test]
fn invalidated_classification_still_restricts_re_admission_of_identical_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"classified by assertion".to_vec();

    let mut asserted = request("classified", payload.clone());
    asserted.asserted_sensitivity = Sensitivity::Secret;
    let first = store.ingest_artifact(asserted).unwrap();
    invalidate_evidence(&store, root.path(), &first.evidence_id);

    let mut relaxed = request("reclassified", payload);
    relaxed.asserted_sensitivity = Sensitivity::Normal;
    let second = store.ingest_artifact(relaxed).unwrap();

    assert_eq!(second.digest, first.digest);
    assert_eq!(
        store
            .artifact_eligibility(&second, ArtifactDestination::Local)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::Secret)
    );
}

#[test]
fn malformed_intent_digest_is_rejected_before_staging() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);

    let mut malformed = request("malformed-intent", b"payload".to_vec());
    malformed.intent.request_digest = "not-a-digest".to_string();
    let error = store.ingest_artifact(malformed).unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::InvalidInput);
    assert_eq!(staged_entries(root.path()), 0);
    assert_eq!(published_objects(root.path()), Vec::<String>::new());
    assert_eq!(reservation_count(root.path()), 0);
}

#[test]
fn uninspectable_payload_never_persists_a_recognized_secret() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let mut payload = vec![0xff, 0xfe];
    payload.extend_from_slice(format!("prefix {SECRET} suffix").as_bytes());

    let error = store
        .ingest_artifact(request("binary-secret", payload))
        .unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::UnredactableSecret);
    assert!(!format!("{error}").contains(SECRET));
    assert!(!tree_bytes(root.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
    assert_eq!(staged_entries(root.path()), 0);
    assert_eq!(published_objects(root.path()), Vec::<String>::new());
}

#[test]
fn uninspectable_payload_without_a_secret_still_ingests() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = vec![0xff, 0x00, 0xfe, 0x01, 0x80];

    let handle = store
        .ingest_artifact(request("binary-clean", payload.clone()))
        .unwrap();

    assert_eq!(store.read_artifact(&handle).unwrap(), payload);
    assert_eq!(
        store
            .artifact_eligibility(&handle, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote)
    );
}

#[test]
fn symlinked_object_is_not_admitted_as_a_verified_reference() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"symlink bait".to_vec();
    let digest = format!("{:x}", Sha256::digest(&payload));

    let outside = root.path().join("outside-the-cas");
    fs::write(&outside, &payload).unwrap();
    let shard = root.path().join("artifacts/objects").join(&digest[..2]);
    fs::create_dir_all(&shard).unwrap();
    fs::set_permissions(&shard, fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&outside, shard.join(&digest[2..])).unwrap();

    let error = store
        .ingest_artifact(request("symlink", payload))
        .unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::MissingObject);
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let references: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM evidence_meta WHERE artifact_digest=?1",
            [&digest],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(references, 0);
    assert_eq!(reservation_count(root.path()), 0);
    assert_eq!(staged_entries(root.path()), 0);
}

#[test]
fn hard_linked_object_is_not_admitted_as_a_verified_reference() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"hard link bait".to_vec();
    let digest = format!("{:x}", Sha256::digest(&payload));

    let outside = root.path().join("outside-alias");
    fs::write(&outside, &payload).unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
    let shard = root.path().join("artifacts/objects").join(&digest[..2]);
    fs::create_dir_all(&shard).unwrap();
    fs::set_permissions(&shard, fs::Permissions::from_mode(0o700)).unwrap();
    fs::hard_link(&outside, shard.join(&digest[2..])).unwrap();

    let error = store
        .ingest_artifact(request("hardlink", payload))
        .unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::MissingObject);
    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let references: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM evidence_meta WHERE artifact_digest=?1",
            [&digest],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(references, 0);
    assert_eq!(reservation_count(root.path()), 0);
}

#[test]
fn oversized_replaced_object_is_rejected_without_reading_it_whole() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let handle = store
        .ingest_artifact(request("oversize", b"small payload".to_vec()))
        .unwrap();

    let path = artifact_path(root.path(), &handle.digest);
    fs::write(&path, vec![b'z'; 64 * MIB + 1]).unwrap();
    let error = store.read_artifact(&handle).unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::CorruptObject);
}

#[test]
fn change_payload_redactions_cover_every_emitted_object_field() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);

    let mut tainted = request("ledger", b"ledger payload".to_vec());
    tainted.object_kind = format!("evidence key={SECRET}");
    tainted.source_kind = format!("repository token={SECRET}");
    let handle = store.ingest_artifact(tainted).unwrap();
    assert!(!handle.digest.is_empty());

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT field_name FROM durable_text_redactions
             WHERE owner_kind='outbox' ORDER BY field_name",
        )
        .unwrap();
    let fields = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect::<Vec<_>>();
    for expected in ["object_kind", "source_kind"] {
        assert!(
            fields.iter().any(|field| field == expected),
            "outbox redaction ledger is missing {expected}: {fields:?}"
        );
    }
}

#[test]
fn oversized_existing_object_is_rejected_during_ingest_verification() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);
    let payload = b"verification bait".to_vec();
    let digest = format!("{:x}", Sha256::digest(&payload));

    let shard = root.path().join("artifacts/objects").join(&digest[..2]);
    fs::create_dir_all(&shard).unwrap();
    fs::set_permissions(&shard, fs::Permissions::from_mode(0o700)).unwrap();
    let object = shard.join(&digest[2..]);
    fs::write(&object, vec![b'z'; 64 * MIB + 1]).unwrap();
    fs::set_permissions(&object, fs::Permissions::from_mode(0o600)).unwrap();

    let error = store
        .ingest_artifact(request("oversize-verify", payload))
        .unwrap_err();

    assert_eq!(error.kind(), ArtifactErrorKind::CorruptObject);
    assert_eq!(reservation_count(root.path()), 0);
    assert_eq!(staged_entries(root.path()), 0);
}

#[test]
fn evidence_metadata_redactions_reach_the_ledger() {
    let root = tempfile::tempdir().unwrap();
    let store = KernelStore::open(root.path()).unwrap();
    seed_domain(&store);

    let mut tainted = request("meta-ledger", b"metadata ledger".to_vec());
    tainted.media_type = format!("text/plain; key={SECRET}");
    tainted.retention_class = format!("canonical token={SECRET}");
    let handle = store.ingest_artifact(tainted).unwrap();

    let connection = Connection::open(root.path().join("core.sqlite")).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT field_name FROM durable_text_redactions
             WHERE owner_kind='evidence' AND owner_id=?1 ORDER BY field_name",
        )
        .unwrap();
    let fields = statement
        .query_map([&handle.evidence_id], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect::<Vec<_>>();
    for expected in ["media_type", "retention_class"] {
        assert!(
            fields.iter().any(|field| field == expected),
            "evidence ledger is missing {expected}: {fields:?}"
        );
    }
}
