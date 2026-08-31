use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    },
};

use cortexkit_cache_core::{CoreState, DurabilityClass, FrozenUnit};
use mc_core::claim_operation::{
    sha256_hex_utf8, ClaimCommandIdentity, ClaimIntentBinding, SnapshotVector,
};
use mc_store::claim_mirror::{
    ClaimMirrorError, ClaimMirrorLifecycle, ClaimMirrorSnapshot, CommittedClaimMirrorRow,
    CLAIM_MIRROR_VERSION,
};
use mc_store::{
    AuthoritySeedRow, FacadeMutationOutcome, LineageAnchor, LineageConstituent,
    LineageDescentDisposition, LineageDescentRequest, McStore, ModuleMeta, NoteEvaluationInput,
    NoteInput, NoteTransitionInput, NoteWriteInput, StoredCompartment, TailHygieneBaseline,
    DURABLE_WRITE_REGISTRY,
};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Fixture {
    schema: String,
    content: Vec<ContentCase>,
    integrity_reject: String,
}

#[derive(Deserialize)]
struct ContentCase {
    input: String,
    stored: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/durable-field-policy-v1.json")).unwrap()
}

fn audit_counts(path: &std::path::Path) -> (i64, i64, i64, i64) {
    let connection = Connection::open(path.join("store.db")).unwrap();
    connection
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM mc_scan_batches),
                 (SELECT COUNT(*) FROM mc_field_scans),
                 (SELECT COUNT(*) FROM mc_scan_owner_copies),
                 (SELECT COUNT(*) FROM mc_scan_detections)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
}

fn store_family_bytes(root: &std::path::Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name().to_string_lossy().starts_with("store.db")
            && entry.file_type().unwrap().is_file()
        {
            bytes.extend(std::fs::read(entry.path()).unwrap());
        }
    }
    assert!(!bytes.is_empty());
    assert!(bytes
        .windows(b"SQLite format 3".len())
        .any(|window| window == b"SQLite format 3"));
    bytes
}

#[test]
fn active_note_scan_audit_is_atomic_complete_and_opaque() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-scan-audit");
    let store = McStore::open(&descriptor).unwrap();
    store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "plain content",
            surface_condition: Some("password=surface-secret"),
            anchor_block_id: Some("block-1"),
            now_ms: 1,
        })
        .unwrap();

    assert_eq!(audit_counts(temp.path()), (1, 3, 3, 1));
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let ids = connection
        .prepare(
            "SELECT b.scan_batch_id,s.scan_id,o.owner_copy_id,o.field_id,s.finding_count
               FROM mc_scan_batches b
               JOIN mc_field_scans s USING(scan_batch_id)
               JOIN mc_scan_owner_copies o USING(scan_id)
              ORDER BY o.field_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        ids.iter().map(|row| row.3.as_str()).collect::<Vec<_>>(),
        vec!["anchor_block_id", "content", "surface_condition"]
    );
    for (batch_id, scan_id, owner_copy_id, _, _) in &ids {
        for id in [batch_id, scan_id, owner_copy_id] {
            assert_eq!(id.len(), 32);
            assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(!id.contains("project"));
            assert!(!id.contains("secret"));
        }
    }
    let private_owner_material: Vec<(String, String)> = connection
        .prepare(
            "SELECT scope_key,owner_key FROM mc_scan_owner_scopes
             JOIN mc_scan_domain_owners USING(owner_scope_id)",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!private_owner_material.is_empty());
    for (scope_key, owner_key) in private_owner_material {
        for value in [scope_key, owner_key] {
            assert_eq!(value.len(), 64);
            assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(!value.contains("project"));
            assert!(!value.contains("session"));
        }
    }
    assert_eq!(
        ids.iter().map(|row| row.4).collect::<Vec<_>>(),
        vec![0, 0, 1]
    );
    let family = store_family_bytes(temp.path());
    for forbidden in ["surface-secret", "password=surface-secret"] {
        assert!(!family
            .windows(forbidden.len())
            .any(|window| window == forbidden.as_bytes()));
    }
    let columns = connection
        .prepare("PRAGMA table_info(mc_scan_detections)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(!columns.iter().any(|column| {
        ["offset", "length", "start", "end"]
            .iter()
            .any(|forbidden| column.contains(forbidden))
    }));
    drop(connection);
    drop(store);
    let reopened = McStore::open(&descriptor).unwrap();
    assert_eq!(audit_counts(temp.path()), (1, 3, 3, 1));
    drop(reopened);
}

#[test]
fn active_scan_audit_expires_with_its_session_note_owner() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-scan-retention");
    let store = McStore::open(&descriptor).unwrap();
    store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "password=retained-secret",
            surface_condition: None,
            anchor_block_id: None,
            now_ms: 1,
        })
        .unwrap();
    assert_eq!(audit_counts(temp.path()), (1, 1, 1, 1));

    store.delete_session("session", "project").unwrap();

    assert_eq!(audit_counts(temp.path()), (0, 0, 0, 0));
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let owner_counts = connection
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM mc_scan_owner_scopes),
                 (SELECT COUNT(*) FROM mc_scan_domain_owners)",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .unwrap();
    store
        .append_compartments(
            "source",
            &[StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 3,
                start_message_id: "m1#0".to_string(),
                end_message_id: "m3#0".to_string(),
                content: "copied password=compartment-secret".to_string(),
                ..StoredCompartment::default()
            }],
        )
        .unwrap();
    assert_eq!(owner_counts, (0, 0));
}

#[test]
fn active_scan_audit_survives_until_its_last_owner_expires() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-scan-shared-retention");
    let store = McStore::open(&descriptor).unwrap();
    let note_id = store
        .seed_authority_rows(
            "store-uuid",
            "project",
            "notes",
            &[AuthoritySeedRow {
                source_row_id: 1,
                snapshot: json!({
                    "id": 1,
                    "project_path": "project",
                    "session_id": "source-session",
                    "content": "plain note",
                    "status": "ready"
                }),
            }],
        )
        .unwrap()[0];
    store
        .claim_note_delivery("project", "delivery-session", "fingerprint", "pass", 2)
        .unwrap();

    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let batch_id: String = connection
        .query_row(
            "SELECT b.scan_batch_id
               FROM mc_scan_batches b
               JOIN mc_field_scans s USING (scan_batch_id)
               JOIN mc_scan_owner_copies c USING (scan_id)
              WHERE b.owner_kind = 'notes'
              GROUP BY b.scan_batch_id
             HAVING COUNT(DISTINCT c.domain_owner_id) = 2
              LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(connection);

    store.delete_session("delivery-session", "project").unwrap();
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let remaining_owners: i64 = connection
        .query_row(
            "SELECT COUNT(DISTINCT c.domain_owner_id)
               FROM mc_field_scans s
               JOIN mc_scan_owner_copies c USING (scan_id)
              WHERE s.scan_batch_id = ?1",
            [&batch_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining_owners, 1);
    drop(connection);

    assert_eq!(
        store
            .read_project_notes("project", None, &["surfacing"], 10, 0)
            .unwrap()[0]
            .id,
        note_id
    );
    store
        .authority_begin_prepare("store-uuid", "project", "notes")
        .unwrap();
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let retained: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM mc_scan_batches WHERE scan_batch_id = ?1",
            [&batch_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 0);
}

#[test]
fn lineage_copy_links_source_scans_without_rescanning_and_survives_source_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-lineage-scan-links");
    let store = McStore::open(&descriptor).unwrap();
    store
        .commit(
            "source",
            None,
            &CoreState {
                boundary_id: "password=lineage-secret".to_string(),
                ..CoreState::default()
            },
            &ModuleMeta {
                initialized: true,
                newest_live_ordinal: 3,
                coverage_ordinal: Some(3),
                ..ModuleMeta::default()
            },
        )
        .unwrap();

    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let source_scan_ids = connection
        .prepare(
            "SELECT DISTINCT copies.scan_id
               FROM mc_scan_owner_copies copies
               JOIN mc_scan_domain_owners owners USING(domain_owner_id)
               JOIN mc_scan_owner_scopes scopes USING(owner_scope_id)
              WHERE scopes.scope_kind='session'",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .unwrap();
    assert!(!source_scan_ids.is_empty());
    let copied_content_scans_before: i64 = connection
        .query_row(
            "SELECT COUNT(DISTINCT scans.scan_id)
               FROM mc_field_scans scans
               JOIN mc_scan_owner_copies copies USING(scan_id)
              WHERE copies.field_id='content' AND scans.finding_count>0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(connection);

    let constituents = [LineageConstituent {
        prior_key: "source".to_string(),
        new_key: "target".to_string(),
        epoch: 1,
    }];
    let anchor = LineageAnchor {
        block_id: "summary#1".to_string(),
        message_id: "summary".to_string(),
        content_hash: "abc123".to_string(),
        ordinal: 1,
    };
    let outcome = store
        .descend_lineage(LineageDescentRequest {
            target_key: "target",
            expected_target_row_version: None,
            edge_id: 1,
            prior_key: "source",
            prior_epoch: 0,
            new_epoch: 1,
            constituents: &constituents,
            compaction_observed: true,
            anchor: Some(&anchor),
            now_ms: 2,
        })
        .unwrap();
    assert_eq!(outcome.disposition, LineageDescentDisposition::Descended);

    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let copied_content_scans_after: i64 = connection
        .query_row(
            "SELECT COUNT(DISTINCT scans.scan_id)
               FROM mc_field_scans scans
               JOIN mc_scan_owner_copies copies USING(scan_id)
              WHERE copies.field_id='content' AND scans.finding_count>0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(copied_content_scans_after, copied_content_scans_before);
    for scan_id in &source_scan_ids {
        let owner_count: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT domain_owner_id)
                   FROM mc_scan_owner_copies WHERE scan_id=?1",
                [scan_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner_count, 2, "source scan was not linked to target");
    }
    drop(connection);

    store.delete_session("source", "project").unwrap();
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    for scan_id in source_scan_ids {
        let retained: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM mc_field_scans WHERE scan_id=?1",
                [scan_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 1, "target did not retain linked source scan");
    }
}

#[test]
fn sqlite_online_backup_preserves_active_scan_audit_rows() {
    let source = tempfile::tempdir().unwrap();
    let source_descriptor = McStore::test_descriptor(source.path(), "production-scan-backup");
    let store = McStore::open(&source_descriptor).unwrap();
    store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "password=backup-secret",
            surface_condition: Some("plain condition"),
            anchor_block_id: None,
            now_ms: 1,
        })
        .unwrap();
    let expected = audit_counts(source.path());
    drop(store);

    let restored = tempfile::tempdir().unwrap();
    let source_connection = Connection::open(source.path().join("store.db")).unwrap();
    let mut restored_connection = Connection::open(restored.path().join("store.db")).unwrap();
    {
        let backup = Backup::new(&source_connection, &mut restored_connection).unwrap();
        loop {
            match backup.step(64).unwrap() {
                StepResult::Done => break,
                StepResult::More | StepResult::Busy | StepResult::Locked => {
                    std::thread::yield_now();
                }
                _ => panic!("unexpected SQLite backup result"),
            }
        }
    }
    drop(restored_connection);
    drop(source_connection);

    let restored_descriptor = McStore::test_descriptor(restored.path(), "production-scan-restore");
    let restored_store = McStore::open(&restored_descriptor).unwrap();
    assert_eq!(audit_counts(restored.path()), expected);
    assert_eq!(
        restored_store
            .read_notes("project", "session", 10, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn concurrent_facade_duplicate_persists_one_active_scan_batch() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-scan-concurrent");
    let store = Arc::new(McStore::open(&descriptor).unwrap());
    let start = Arc::new(Barrier::new(3));
    let invoked = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let store = Arc::clone(&store);
        let start = Arc::clone(&start);
        let invoked = Arc::clone(&invoked);
        workers.push(std::thread::spawn(move || {
            start.wait();
            store
                .with_facade_command(
                    "route",
                    "project",
                    "notes",
                    "scope",
                    "tool",
                    "write",
                    Some("same-command"),
                    |_| {
                        invoked.fetch_add(1, Ordering::SeqCst);
                        Ok(br#"{"result":"plain"}"#.to_vec())
                    },
                )
                .unwrap()
        }));
    }
    start.wait();
    let outcomes = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(invoked.load(Ordering::SeqCst), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, FacadeMutationOutcome::Applied(_)))
            .count(),
        1
    );
    assert_eq!(audit_counts(temp.path()).0, 1);
}

#[test]
fn durable_write_registry_references_real_bindings_and_checked_tests() {
    let store_source = include_str!("../src/lib.rs");
    let claim_mirror_source = include_str!("../src/claim_mirror.rs");
    let found = DURABLE_WRITE_REGISTRY
        .iter()
        .map(|entry| entry.family)
        .collect::<BTreeSet<_>>();
    assert_eq!(found.len(), DURABLE_WRITE_REGISTRY.len());
    assert_eq!(found.len(), 25);
    assert!(!store_source.contains("PreparedWrite::new(\""));
    assert!(!claim_mirror_source.contains("PreparedWrite::new(\""));

    let test_sources = [
        include_str!("production_redaction.rs"),
        store_source,
        include_str!("kernel_redaction.rs"),
        include_str!("kernel_envelope.rs"),
        include_str!("kernel_outbox.rs"),
        include_str!("kernel_schema.rs"),
    ]
    .join("\n");
    for entry in DURABLE_WRITE_REGISTRY {
        assert!(!entry.preparation.trim().is_empty());
        let test_name = entry.test.rsplit("::").next().unwrap();
        let top_level_test = format!("#[test]\nfn {test_name}(");
        let nested_test = format!("#[test]\n    fn {test_name}(");
        assert!(
            test_sources.contains(&top_level_test) || test_sources.contains(&nested_test),
            "{:?} references missing #[test] function {}",
            entry.family,
            entry.test
        );
    }
}

#[test]
fn cache_state_redacts_payloads_preserves_existing_ids_and_rejects_integrity() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-cache-state");
    let store = McStore::open(&descriptor).unwrap();
    let core = CoreState {
        version: 1,
        boundary_id: "boundary".to_string(),
        frozen_units: vec![FrozenUnit {
            key: "unit".to_string(),
            kind: "drop".to_string(),
            frozen_payload: "password=payload-secret".to_string(),
            durability_class: DurabilityClass::Episode,
            reset_rule: "run_started".to_string(),
        }],
        ..CoreState::default()
    };
    store
        .commit("session", None, &core, &ModuleMeta::default())
        .unwrap();
    let loaded = store.load("session").unwrap();
    assert_eq!(
        loaded.core.frozen_units[0].frozen_payload,
        "password=<REDACTED:password>"
    );

    let mut existing_identity = core;
    existing_identity.boundary_id = "password=legacy-boundary".to_string();
    store
        .commit(
            "existing-identity",
            None,
            &existing_identity,
            &ModuleMeta::default(),
        )
        .unwrap();
    assert_eq!(
        store.load("existing-identity").unwrap().core.boundary_id,
        "password=legacy-boundary"
    );

    let error = store
        .commit(
            "password=new-session",
            None,
            &CoreState::default(),
            &ModuleMeta::default(),
        )
        .unwrap_err();
    assert!(
        matches!(error, mc_store::McStoreError::Redaction(_)),
        "{error:?}"
    );
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    connection
        .execute(
            "INSERT INTO mc_cache_state(session_id, row_version, core_state, meta)
             VALUES (?1, 0, ?2, ?3)",
            rusqlite::params![
                "password=legacy-session",
                serde_json::to_string(&CoreState::default()).unwrap(),
                serde_json::to_string(&ModuleMeta::default()).unwrap()
            ],
        )
        .unwrap();
    drop(connection);
    store
        .commit(
            "password=legacy-session",
            Some(0),
            &CoreState::default(),
            &ModuleMeta::default(),
        )
        .unwrap();

    let meta = ModuleMeta {
        tail_hygiene_baseline: Some(TailHygieneBaseline {
            content_signature: "password=signature-secret".to_string(),
            ..TailHygieneBaseline::default()
        }),
        ..ModuleMeta::default()
    };
    let error = store
        .commit("rejected", None, &CoreState::default(), &meta)
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
    assert!(!error.to_string().contains("signature-secret"));
    assert!(store.load("rejected").unwrap().row_version.is_none());
}

#[test]
fn transform_diagnostics_redact_before_persistence() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-diagnostic");
    let store = McStore::open(&descriptor).unwrap();
    store
        .trace_pass_rejected("session", "password=trace-secret", 1)
        .unwrap();
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let stored: String = connection
        .query_row("SELECT last_reject_error FROM mc_pass_trace", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(stored, "password=<REDACTED:password>");
}

#[test]
fn authority_routes_reject_new_secret_identities_and_preserve_exact_existing_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-authority-route");
    let store = McStore::open(&descriptor).unwrap();

    let error = store
        .bind_authority_route("store", "project", "password=new-route")
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));

    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    connection
        .execute(
            "INSERT INTO mc_authority(context_store_uuid, project, domain, state)
             VALUES (?1, ?2, 'notes', 'TS')",
            ["password=legacy-store", "password=legacy-project"],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO mc_authority_route_bindings(route_project_root, context_store_uuid, project)
             VALUES (?1, ?2, ?3)",
            [
                "password=legacy-route",
                "password=legacy-store",
                "password=legacy-project",
            ],
        )
        .unwrap();
    drop(connection);

    store
        .bind_authority_route(
            "password=legacy-store",
            "password=legacy-project",
            "password=legacy-route",
        )
        .unwrap();
}

#[test]
fn mural_artifacts_reject_secret_bytes_hashes_and_new_identity() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-mural");
    let store = McStore::open(&descriptor).unwrap();

    for (project, data, hash) in [
        (
            "password=project-secret",
            "data:image/png;base64,YQ==",
            "hash",
        ),
        ("project", "password=mural-secret", "hash"),
        (
            "project",
            "data:image/png;base64,YQ==",
            "password=hash-secret",
        ),
    ] {
        let error = store
            .upsert_project_mural_artifact(project, data.as_bytes(), hash, 1)
            .unwrap_err();
        assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
        assert!(!error.to_string().contains("secret"));
    }
    assert!(store
        .load_project_mural_artifact("project")
        .unwrap()
        .is_none());
}

#[test]
fn authority_creation_and_checksums_reject_secret_material() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-authority");
    let store = McStore::open(&descriptor).unwrap();

    let error = store
        .authority_begin_prepare("password=store-secret", "project", "notes")
        .unwrap_err();
    assert!(
        matches!(error, mc_store::McStoreError::Redaction(_)),
        "{error:?}"
    );
    assert!(store
        .authority_status("password=store-secret", "project", "notes")
        .unwrap()
        .is_none());

    let preparing = store
        .authority_begin_prepare("0123456789abcdef0123456789abcdef", "project", "notes")
        .unwrap();
    let error = store
        .authority_verify_prepare(
            "0123456789abcdef0123456789abcdef",
            "project",
            "notes",
            preparing.generation,
            "password=checksum-secret",
            "clean-checksum",
        )
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
    assert!(!error.to_string().contains("checksum-secret"));

    let ready = store
        .authority_begin_prepare("legacy-store", "legacy-project", "notes")
        .unwrap();
    store
        .authority_finish_prepare(
            "legacy-store",
            "legacy-project",
            "notes",
            ready.generation,
            "hash",
            "hash",
            true,
        )
        .unwrap();
    store
        .authority_begin_drain(
            "legacy-store",
            "legacy-project",
            "notes",
            "clean-lease",
            100,
            0,
        )
        .unwrap();
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    connection
        .execute(
            "UPDATE mc_authority SET coordinator_lease = 'password=legacy-lease'
              WHERE context_store_uuid = 'legacy-store' AND project = 'legacy-project'
                AND domain = 'notes'",
            [],
        )
        .unwrap();
    drop(connection);
    store
        .authority_begin_drain(
            "legacy-store",
            "legacy-project",
            "notes",
            "password=legacy-lease",
            200,
            0,
        )
        .unwrap();
    let error = store
        .authority_begin_drain(
            "legacy-store",
            "legacy-project",
            "notes",
            "password=new-lease",
            300,
            0,
        )
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
}

#[test]
fn note_fields_follow_content_and_integrity_policy() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-note-fields");
    let store = McStore::open(&descriptor).unwrap();
    let note = store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "ordinary",
            surface_condition: Some("password=condition-secret"),
            anchor_block_id: Some("anchor"),
            now_ms: 1,
        })
        .unwrap();
    assert_eq!(
        note.surface_condition.as_deref(),
        Some("password=<REDACTED:password>")
    );

    let error = store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "ordinary",
            surface_condition: None,
            anchor_block_id: Some("password=anchor-secret"),
            now_ms: 2,
        })
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
    assert!(!error.to_string().contains("anchor-secret"));

    let error = store
        .insert_project_note(NoteWriteInput {
            project_path: "project",
            route_project_root: None,
            session_id: Some("session"),
            content: "ordinary",
            surface_condition: None,
            anchor_block_id: None,
            anchor_ordinal: None,
            compiled_provider: Some("password=provider-secret"),
            compiled_config: None,
            compiled_at: None,
            compile_status: None,
            now_ms: 3,
        })
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
    assert!(!error.to_string().contains("provider-secret"));
}

#[test]
fn active_note_writes_redact_before_persistence() {
    let fixture = fixture();
    assert_eq!(fixture.schema, "magic-context.durable-field-policy/v1");
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-note");
    let store = McStore::open(&descriptor).unwrap();

    for (index, case) in fixture.content.iter().enumerate() {
        let session = format!("session-{index}");
        store
            .insert_note(NoteInput {
                project_path: "project",
                route_project_root: None,
                session_id: &session,
                content: &case.input,
                surface_condition: None,
                anchor_block_id: None,
                now_ms: index as i64,
            })
            .unwrap();
        let notes = store.read_notes("project", &session, 10, 0).unwrap();
        assert_eq!(notes[0].content, case.stored);
    }
}

#[test]
fn transaction_produced_facade_text_is_redacted_and_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-facade");
    let store = McStore::open(&descriptor).unwrap();
    let outcome = store
        .with_facade_command(
            "route",
            "project",
            "notes",
            "scope",
            "tool",
            "write",
            Some("command-1"),
            |_| Ok(br#"{"result":"password=hunter-two"}"#.to_vec()),
        )
        .unwrap();
    let FacadeMutationOutcome::Applied(response) = outcome else {
        panic!("first facade command must apply");
    };
    assert_eq!(
        std::str::from_utf8(&response).unwrap(),
        r#"{"result":"password=<REDACTED:password>"}"#
    );
    let persisted_response: Vec<u8> = Connection::open(temp.path().join("store.db"))
        .unwrap()
        .query_row(
            "SELECT response_json FROM mc_facade_mutation_ledger WHERE command_id='command-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted_response, response);
    let committed_audit = audit_counts(temp.path());
    let replay = store
        .with_facade_command(
            "route",
            "project",
            "notes",
            "scope",
            "tool",
            "write",
            Some("command-1"),
            |_| panic!("replay must not invoke mutation"),
        )
        .unwrap();
    assert_eq!(replay, FacadeMutationOutcome::Duplicate(response));
    assert_eq!(audit_counts(temp.path()), committed_audit);

    let oversized = store.with_facade_command(
        "route",
        "project",
        "notes",
        "scope",
        "tool",
        "write",
        Some("command-2"),
        |_| Ok(vec![b'x'; 512 * 1024 + 1]),
    );
    assert!(matches!(
        oversized,
        Err(mc_store::McStoreError::Redaction(
            mc_core::redaction::RedactionErrorKind::InputLimit
        ))
    ));
    assert_eq!(audit_counts(temp.path()), committed_audit);

    let mut invoked = false;
    let error = store
        .with_facade_command(
            "route",
            "project",
            "notes",
            "scope",
            "password=tool-secret",
            "write",
            None,
            |_| {
                invoked = true;
                Ok(Vec::new())
            },
        )
        .unwrap_err();
    assert!(matches!(error, mc_store::McStoreError::Redaction(_)));
    assert!(!invoked);

    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    connection
        .execute(
            "INSERT INTO mc_facade_mutation_ledger
                 (identity_scope, tool, action, command_id, response_json, created_at_ms)
             VALUES ('legacy-scope', 'password=legacy-tool', 'password=legacy-action',
                     'legacy-command', X'7B7D', 1)",
            [],
        )
        .unwrap();
    drop(connection);
    let replay = store
        .with_facade_command(
            "route",
            "project",
            "notes",
            "legacy-scope",
            "password=legacy-tool",
            "password=legacy-action",
            Some("legacy-command"),
            |_| panic!("exact replay must not invoke mutation"),
        )
        .unwrap();
    assert_eq!(replay, FacadeMutationOutcome::Duplicate(b"{}".to_vec()));
    let existing = store
        .with_facade_command(
            "route",
            "project",
            "notes",
            "legacy-scope",
            "password=legacy-tool",
            "password=legacy-action",
            Some("next-command"),
            |_| Ok(b"{}".to_vec()),
        )
        .unwrap();
    assert_eq!(existing, FacadeMutationOutcome::Applied(b"{}".to_vec()));
}

#[test]
fn integrity_bound_claim_content_rejects_without_identity_collapse() {
    let fixture = fixture();
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-claim");
    let store = McStore::open(&descriptor).unwrap();
    let content_digest = sha256_hex_utf8(&fixture.integrity_reject);
    let claim_id = "mcm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let claim = CommittedClaimMirrorRow {
        public_claim_id: claim_id.to_string(),
        project_id: 1,
        revision_locator: format!("{claim_id}/r1/{content_digest}"),
        content: fixture.integrity_reject.clone(),
        content_digest,
        attributes: json!({"category": "workflow"}),
        lifecycle: ClaimMirrorLifecycle::Active,
        applicability: json!({"streams": []}),
        policy: json!({"policyVersion": 1}),
        provenance_label: None,
        project_generation: 1,
        policy_generation: 1,
    };
    let generations = BTreeMap::from([("1".to_string(), 1)]);
    let snapshot = ClaimMirrorSnapshot {
        mirror_version: CLAIM_MIRROR_VERSION,
        vector: SnapshotVector {
            vector_version: 1,
            database_incarnation_id: "0123456789abcdef0123456789abcdef".to_string(),
            workspace_epoch: "epoch".to_string(),
            project_generations: generations.clone(),
            policy_generations: generations,
        },
        project_checkpoints: BTreeMap::from([(1, 0)]),
        claims: vec![claim],
    };
    let error = store
        .replace_claim_mirror_snapshot(&snapshot, 1)
        .unwrap_err();
    assert!(matches!(error, ClaimMirrorError::Redaction(_)));
    let diagnostic = error.to_string();
    assert!(!diagnostic.contains(&fixture.integrity_reject));
    assert!(!diagnostic.contains("integrity-sentinel"));
    assert!(store.claim_mirror_state().unwrap().is_none());

    let mut secret_epoch_snapshot = snapshot.clone();
    secret_epoch_snapshot.vector.workspace_epoch = "password=workspace-secret".to_string();
    secret_epoch_snapshot.claims.clear();
    let error = store
        .replace_claim_mirror_snapshot(&secret_epoch_snapshot, 1)
        .unwrap_err();
    assert!(matches!(error, ClaimMirrorError::Redaction(_)));
    assert!(!error.to_string().contains("workspace-secret"));
    assert!(store.claim_mirror_state().unwrap().is_none());

    let clean_content = "clean claim content";
    let clean_digest = sha256_hex_utf8(clean_content);
    let structured = CommittedClaimMirrorRow {
        public_claim_id: claim_id.to_string(),
        project_id: 1,
        revision_locator: format!("{claim_id}/r1/{clean_digest}"),
        content: clean_content.to_string(),
        content_digest: clean_digest,
        attributes: json!({"category":"password=attribute-secret"}),
        lifecycle: ClaimMirrorLifecycle::Active,
        applicability: json!({"streams": []}),
        policy: json!({"policyVersion": 1}),
        provenance_label: None,
        project_generation: 1,
        policy_generation: 1,
    };
    let structured_snapshot = ClaimMirrorSnapshot {
        claims: vec![structured],
        ..snapshot
    };
    let error = store
        .replace_claim_mirror_snapshot(&structured_snapshot, 1)
        .unwrap_err();
    assert!(matches!(error, ClaimMirrorError::Redaction(_)));
    assert!(!error.to_string().contains("attribute-secret"));
    assert!(store.claim_mirror_state().unwrap().is_none());

    let mut keyed = structured_snapshot.claims[0].clone();
    keyed.attributes = json!({"password=hunter-two": "clean"});
    let keyed_snapshot = ClaimMirrorSnapshot {
        claims: vec![keyed],
        ..structured_snapshot
    };
    let error = store
        .replace_claim_mirror_snapshot(&keyed_snapshot, 2)
        .unwrap_err();
    assert!(matches!(error, ClaimMirrorError::Redaction(_)));
    assert!(!error.to_string().contains("hunter-two"));
    assert!(store.claim_mirror_state().unwrap().is_none());
}

#[test]
fn new_idempotency_identities_reject_without_substitution_or_collapse() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-identity");
    let store = McStore::open(&descriptor).unwrap();
    let mut accepted_invocations = 0;
    for command_id in ["clean-command-one", "clean-command-two"] {
        let outcome = store
            .with_facade_command(
                "route",
                "project",
                "notes",
                "scope",
                "tool",
                "write",
                Some(command_id),
                |_| {
                    accepted_invocations += 1;
                    Ok(command_id.as_bytes().to_vec())
                },
            )
            .unwrap();
        assert!(matches!(outcome, FacadeMutationOutcome::Applied(_)));
    }
    assert_eq!(accepted_invocations, 2);
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    let accepted: (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),COUNT(DISTINCT command_id)
               FROM mc_facade_mutation_ledger
              WHERE command_id IN ('clean-command-one','clean-command-two')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(accepted, (2, 2));
    drop(connection);

    let mut invoked = false;
    for command_id in ["password=first-identity", "password=second-identity"] {
        let result = store.with_facade_command(
            "route",
            "project",
            "notes",
            "scope",
            "tool",
            "write",
            Some(command_id),
            |_| {
                invoked = true;
                Ok(Vec::new())
            },
        );
        let diagnostic = result.unwrap_err().to_string();
        assert!(!diagnostic.contains(command_id));
        assert!(!diagnostic.contains("first-identity"));
        assert!(!diagnostic.contains("second-identity"));
    }
    assert!(!invoked);
    let connection = Connection::open(temp.path().join("store.db")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM mc_facade_mutation_ledger",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .unwrap(),
        2
    );
}

#[test]
fn compartment_content_redacts_and_new_message_identities_reject() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-compartment");
    let store = McStore::open(&descriptor).unwrap();
    let compartment = StoredCompartment {
        sequence: 1,
        start_message: 1,
        end_message: 2,
        start_message_id: "message-1".to_string(),
        end_message_id: "message-2".to_string(),
        title: "password=title-secret".to_string(),
        content: "password=content-secret".to_string(),
        p1: Some("password=p1-secret".to_string()),
        ..StoredCompartment::default()
    };

    store
        .replace_compartments("session", std::slice::from_ref(&compartment))
        .unwrap();
    let stored = store.load_compartments("session").unwrap();
    assert_eq!(stored[0].title, "password=<REDACTED:password>");
    assert_eq!(stored[0].content, "password=<REDACTED:password>");
    assert_eq!(
        stored[0].p1.as_deref(),
        Some("password=<REDACTED:password>")
    );

    let rejected = StoredCompartment {
        start_message_id: "password=identity-secret".to_string(),
        ..compartment
    };
    let error = store
        .append_compartments("session", &[rejected])
        .unwrap_err();
    assert!(!error.to_string().contains("identity-secret"));
    assert_eq!(store.load_compartments("session").unwrap().len(), 1);
}

#[test]
fn note_transition_content_redacts_and_compiled_artifacts_reject() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-note-state");
    let store = McStore::open(&descriptor).unwrap();
    let note = store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "ordinary note",
            surface_condition: None,
            anchor_block_id: None,
            now_ms: 1,
        })
        .unwrap();
    let applied = store
        .transition_note(NoteTransitionInput {
            project_path: "project",
            note_id: note.id,
            from_status: "active",
            source_revision: note.status_version,
            to_status: "dismissed",
            result: Some("password=resolution-secret"),
            now_ms: 2,
        })
        .unwrap();
    let mc_store::NoteCasOutcome::Applied(applied) = applied else {
        panic!("note transition must apply");
    };
    assert_eq!(
        applied.dismissal_resolution.as_deref(),
        Some("password=<REDACTED:password>")
    );

    let pending = store
        .insert_note(NoteInput {
            project_path: "project",
            route_project_root: None,
            session_id: "session",
            content: "smart note",
            surface_condition: Some("always"),
            anchor_block_id: None,
            now_ms: 3,
        })
        .unwrap();
    let error = store
        .write_note_evaluation(NoteEvaluationInput {
            project_path: "project",
            note_id: pending.id,
            source_revision: pending.status_version,
            verdict: false,
            compiled_check: Some("password=compiled-secret"),
            manifest_json: None,
            check_hash: None,
            next_due_at: None,
            now_ms: 4,
        })
        .unwrap_err();
    assert!(!error.to_string().contains("compiled-secret"));
}

#[test]
fn fresh_claim_intent_identities_and_integrity_payloads_reject() {
    let temp = tempfile::tempdir().unwrap();
    let descriptor = McStore::test_descriptor(temp.path(), "production-redaction-claim-intent");
    let store = McStore::open(&descriptor).unwrap();
    let binding = ClaimIntentBinding {
        database_incarnation_id: "0123456789abcdef0123456789abcdef".to_string(),
        format_epoch: 1,
        authority_project: "project".to_string(),
        authority_generation: 1,
    };
    let secret_identity = ClaimCommandIdentity {
        producer: "producer".to_string(),
        operation_key: "password=operation-secret".to_string(),
    };
    let error = store
        .stage_claim_intent("route", &binding, &secret_identity, &json!({}), 1)
        .unwrap_err();
    assert!(!error.to_string().contains("operation-secret"));

    let clean_identity = ClaimCommandIdentity {
        producer: "producer".to_string(),
        operation_key: "operation".to_string(),
    };
    let error = store
        .stage_claim_intent(
            "route",
            &binding,
            &clean_identity,
            &json!({"content":"password=request-secret"}),
            1,
        )
        .unwrap_err();
    assert!(!error.to_string().contains("request-secret"));
    assert!(store
        .inspect_claim_intent(&clean_identity)
        .unwrap()
        .is_none());
}
