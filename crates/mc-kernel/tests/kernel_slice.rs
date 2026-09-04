#![cfg(feature = "test-support")]

use std::{cell::Cell, fs};

use mc_kernel::{
    AdmissionEvent, AdmissionRequest, ArtifactIngestRequest, CommitIntent, DecisionEventPayload,
    DecisionEventSpec, DecisionPayload, DecisionSpec, DomainSpec, EventKind, KernelError,
    KernelStore, ObservationDependencySpec, ObservationPayload, ObservationSpec, ProviderEgress,
    RepositoryProvenance, Sensitivity, SourceClass, TaintClass,
};
use rusqlite::{Connection, OpenFlags};

const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";

fn intent(key: &str, digest: char) -> CommitIntent {
    CommitIntent {
        producer: "kernel-slice-test".to_string(),
        operation_key: key.to_string(),
        request_digest: digest.to_string().repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain() -> DomainSpec {
    DomainSpec {
        domain_id: "domain".to_string(),
        object_id: "domain-object".to_string(),
        name: "fixture".to_string(),
        source_kind: "fixture".to_string(),
        source_id: "domain".to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

fn decision(index: i64) -> DecisionSpec {
    DecisionSpec {
        decision_id: format!("decision-{index}"),
        object_id: format!("decision-object-{index}"),
        domain_id: "domain".to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        decision_kind: "architecture".to_string(),
        payload: DecisionPayload {
            summary: format!("decision {index}"),
            rationale: format!("because {index}"),
        },
        source_kind: "fixture".to_string(),
        source_id: "decision".to_string(),
        source_revision: index,
        sensitivity: Sensitivity::Normal,
    }
}

fn observation(index: i64, dependency_object_id: &str) -> ObservationSpec {
    ObservationSpec {
        observation_id: format!("observation-{index}"),
        object_id: format!("observation-object-{index}"),
        domain_id: "domain".to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: "implementation".to_string(),
        payload: ObservationPayload {
            summary: format!("observed {index}"),
            classification: "implemented".to_string(),
            detail: None,
        },
        observed_at: index,
        dependencies: vec![ObservationDependencySpec {
            dependency_object_id: dependency_object_id.to_string(),
            dependency_kind: "implements".to_string(),
            dependency_payload: None,
        }],
        source_kind: "fixture".to_string(),
        source_id: "observation".to_string(),
        source_revision: index,
        sensitivity: Sensitivity::Normal,
    }
}

fn inspect_i64(root: &std::path::Path, sql: &str) -> i64 {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn family_bytes(root: &std::path::Path) -> Vec<u8> {
    let base = root.join("core.sqlite");
    [
        base.clone(),
        std::path::PathBuf::from(format!("{}-wal", base.display())),
    ]
    .into_iter()
    .filter_map(|path| fs::read(path).ok())
    .flatten()
    .collect()
}

fn seed_domain(store: &KernelStore) {
    store
        .commit(intent("domain", '0'), |envelope| {
            envelope.insert_domain(domain())?;
            Ok(String::new())
        })
        .unwrap();
}

#[test]
fn inserts_slice_rows_atomically_and_replay_is_effect_free() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);

    let receipt = store
        .commit(intent("insert", '1'), |envelope| {
            let decision = envelope.insert_decision(decision(1))?;
            let observation = envelope.insert_observation(observation(1, "decision-object-1"))?;
            Ok(format!(
                "[{},{}]",
                decision.result_json(),
                observation.result_json()
            ))
        })
        .unwrap();
    assert_eq!(receipt.commit_seq, 2);
    assert_eq!(
        inspect_i64(directory.path(), "SELECT COUNT(*) FROM decisions"),
        1
    );
    assert_eq!(
        inspect_i64(directory.path(), "SELECT COUNT(*) FROM observations"),
        1
    );
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM observation_dependencies"
        ),
        1
    );
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM change_event WHERE commit_seq=2"
        ),
        2
    );
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM outbox WHERE commit_seq=2"
        ),
        2
    );

    let called = Cell::new(false);
    let replay = store
        .commit(intent("insert", '1'), |_| {
            called.set(true);
            Ok(String::new())
        })
        .unwrap();
    assert!(replay.replayed);
    assert!(!called.get());
    assert_eq!(replay.result, receipt.result);
    assert_eq!(
        inspect_i64(directory.path(), "SELECT COUNT(*) FROM decisions"),
        1
    );
}

#[test]
fn slice_payloads_redact_before_storage_and_missing_parents_are_typed() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    let mut secret = decision(1);
    secret.payload.summary = format!("summary {SECRET}");
    store
        .commit(intent("secret", '2'), |envelope| {
            Ok(envelope.insert_decision(secret)?.result_json())
        })
        .unwrap();
    let mut secret_observation = observation(1, "decision-object-1");
    secret_observation.dependencies[0].dependency_payload = Some(format!("context {SECRET}"));
    store
        .commit(intent("secret-dependency", 'a'), |envelope| {
            Ok(envelope
                .insert_observation(secret_observation)?
                .result_json())
        })
        .unwrap();

    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    let payload: Vec<u8> = connection
        .query_row("SELECT decision_payload FROM decisions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!payload
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
    assert!(String::from_utf8(payload).unwrap().contains("REDACTED"));
    assert!(!family_bytes(directory.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
    let field: String = connection
        .query_row(
            "SELECT field_name FROM durable_text_redactions
             WHERE owner_kind='decisions' AND owner_id='decision-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(field, "decision_payload.summary");
    let dependency_field: String = connection
        .query_row(
            "SELECT field_name FROM durable_text_redactions
             WHERE owner_kind='observations' AND owner_id='observation-1'
               AND field_name='dependencies.0.dependency_payload'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(dependency_field, "dependencies.0.dependency_payload");

    let missing_domain = store
        .commit(intent("missing-domain", '3'), |envelope| {
            let mut spec = decision(2);
            spec.domain_id = "missing".to_string();
            envelope.insert_decision(spec)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(missing_domain, KernelError::NotFound);

    let missing_scope = store
        .commit(intent("missing-scope", '4'), |envelope| {
            let mut spec = decision(2);
            spec.scope_id = Some("missing".to_string());
            envelope.insert_decision(spec)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(missing_scope, KernelError::NotFound);

    let missing_dependency = store
        .commit(intent("missing-dependency", '5'), |envelope| {
            envelope.insert_observation(observation(1, "missing"))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(missing_dependency, KernelError::NotFound);
    let wrong_dependency_kind = store
        .commit(intent("non-decision-dependency", 'b'), |envelope| {
            envelope.insert_observation(observation(1, "domain-object"))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(wrong_dependency_kind, KernelError::NotFound);

    let duplicate = store
        .commit(intent("duplicate-source", '6'), |envelope| {
            envelope.insert_decision(decision(1))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(duplicate, KernelError::Conflict);
}

#[test]
fn events_allocate_per_decision_ordinals_replay_and_reject_dead_decisions() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("decisions", '5'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope.insert_decision(decision(2))?;
            Ok(String::new())
        })
        .unwrap();

    let append = |key: &str, digest: char, decision_id: &str, summary: &str| {
        store
            .commit(intent(key, digest), |envelope| {
                Ok(envelope
                    .append_decision_event(
                        decision_id,
                        DecisionEventSpec {
                            event_kind: "status".to_string(),
                            payload: DecisionEventPayload {
                                summary: summary.to_string(),
                            },
                            evidence_id: None,
                            recorded_at: 10,
                        },
                    )?
                    .result_json())
            })
            .unwrap()
    };
    assert!(append("event-1", '6', "decision-1", "one")
        .result
        .contains("\"event_ordinal\":1"));
    assert!(append("event-2", '7', "decision-1", "two")
        .result
        .contains("\"event_ordinal\":2"));
    assert!(append("event-other", '8', "decision-2", "one")
        .result
        .contains("\"event_ordinal\":1"));
    let replay = append("event-1", '6', "decision-1", "ignored");
    assert!(replay.replayed);
    assert!(replay.result.contains("\"event_ordinal\":1"));
    assert_eq!(
        inspect_i64(directory.path(), "SELECT COUNT(*) FROM decision_events"),
        3
    );

    store
        .commit(intent("retire", '9'), |envelope| {
            Ok(envelope.retire_decision("decision-object-1")?.result_json())
        })
        .unwrap();
    let error = store
        .commit(intent("event-dead", 'a'), |envelope| {
            envelope.append_decision_event(
                "decision-1",
                DecisionEventSpec {
                    event_kind: "status".to_string(),
                    payload: DecisionEventPayload {
                        summary: "late".to_string(),
                    },
                    evidence_id: None,
                    recorded_at: 11,
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::NotFound);

    drop(store);
    let store = KernelStore::open(directory.path()).unwrap();
    let after_restart = store
        .commit(intent("event-after-restart", 'b'), |envelope| {
            Ok(envelope
                .append_decision_event(
                    "decision-2",
                    DecisionEventSpec {
                        event_kind: "status".to_string(),
                        payload: DecisionEventPayload {
                            summary: "after restart".to_string(),
                        },
                        evidence_id: None,
                        recorded_at: 12,
                    },
                )?
                .result_json())
        })
        .unwrap();
    assert!(after_restart.result.contains("\"event_ordinal\":2"));
}

#[test]
fn decision_event_preserves_valid_evidence_identifier() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    let evidence_id = "evidence-id".to_string();
    let handle = store
        .ingest_artifact(ArtifactIngestRequest {
            intent: intent("evidence", '1'),
            payload: b"fixture evidence".to_vec(),
            evidence_id: evidence_id.clone(),
            object_id: "evidence-object".to_string(),
            object_kind: "evidence".to_string(),
            domain_id: "domain".to_string(),
            source_kind: "fixture".to_string(),
            source_id: "evidence".to_string(),
            source_revision: 1,
            media_type: "text/plain".to_string(),
            retention_class: "canonical".to_string(),
            retain_until: None,
            asserted_sensitivity: Sensitivity::Normal,
            provider_egress: ProviderEgress::RemoteAllowed,
            provenance: Some(RepositoryProvenance {
                repository_id: "fixture".to_string(),
                revision: "abc123".to_string(),
            }),
        })
        .unwrap();
    store
        .commit(intent("decision-with-evidence-event", '2'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope.append_decision_event(
                "decision-1",
                DecisionEventSpec {
                    event_kind: "status".to_string(),
                    payload: DecisionEventPayload {
                        summary: "accepted".to_string(),
                    },
                    evidence_id: Some(evidence_id),
                    recorded_at: 10,
                },
            )?;
            Ok(String::new())
        })
        .unwrap();

    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    let stored_evidence_id: String = connection
        .query_row(
            "SELECT evidence_id FROM decision_events
             WHERE decision_id='decision-1' AND event_ordinal=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_evidence_id, handle.evidence_id);
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM durable_text_redactions
             WHERE owner_kind='decision_events' AND owner_id='decision-1:1'
               AND field_name='evidence_id'"
        ),
        0
    );
}

#[test]
fn decisions_for_objects_as_of_returns_only_requested_live_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    let inserted = store
        .commit(intent("decisions", '1'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope.insert_decision(decision(2))?;
            envelope.insert_decision(decision(3))?;
            Ok(String::new())
        })
        .unwrap();
    let retired = store
        .commit(intent("retire", '2'), |envelope| {
            Ok(envelope.retire_decision("decision-object-2")?.result_json())
        })
        .unwrap();
    let tip = store.tip().unwrap();
    assert_eq!(tip, retired.commit_seq);

    let ids = |rows: Vec<mc_kernel::DecisionRow>| -> Vec<String> {
        let mut ids: Vec<String> = rows.into_iter().map(|row| row.object_id).collect();
        ids.sort();
        ids
    };
    let requested = [
        "decision-object-1".to_string(),
        "decision-object-2".to_string(),
        "decision-object-9".to_string(),
    ];

    assert_eq!(
        ids(store.decisions_for_objects_as_of(&requested, tip).unwrap()),
        ["decision-object-1"]
    );
    assert_eq!(
        ids(store
            .decisions_for_objects_as_of(&requested, inserted.commit_seq)
            .unwrap()),
        ["decision-object-1", "decision-object-2"]
    );
    let full = store.slice_as_of(tip).unwrap();
    assert_eq!(
        store
            .decisions_for_objects_as_of(&["decision-object-3".to_string()], tip)
            .unwrap(),
        full.decisions
            .into_iter()
            .filter(|row| row.object_id == "decision-object-3")
            .collect::<Vec<_>>()
    );

    assert!(store
        .decisions_for_objects_as_of(&[], tip)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .decisions_for_objects_as_of(&requested, tip + 1)
            .unwrap_err(),
        KernelError::FutureSnapshot
    );
    assert_eq!(
        store
            .decisions_for_objects_as_of(&requested, -1)
            .unwrap_err(),
        KernelError::InvalidInput
    );

    let many: Vec<String> = (0..1_200)
        .map(|index| format!("decision-object-{index}"))
        .collect();
    assert_eq!(
        ids(store.decisions_for_objects_as_of(&many, tip).unwrap()),
        ["decision-object-1", "decision-object-3"]
    );
}

#[test]
fn decision_payload_sizes_match_the_stored_payload_bytes_of_live_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("decisions", '1'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope.insert_decision(decision(2))?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("retire", '2'), |envelope| {
            Ok(envelope.retire_decision("decision-object-2")?.result_json())
        })
        .unwrap();
    let tip = store.tip().unwrap();
    let requested = [
        "decision-object-1".to_string(),
        "decision-object-2".to_string(),
        "decision-object-9".to_string(),
    ];

    let sizes = store.decision_payload_sizes_as_of(&requested, tip).unwrap();
    assert_eq!(sizes.len(), 1);
    let (object_id, size) = &sizes[0];
    assert_eq!(object_id, "decision-object-1");
    // The reported size is the stored payload's byte length, the quantity a caller budgets full loads by.
    let full = store
        .decisions_for_objects_as_of(&requested, tip)
        .unwrap()
        .remove(0);
    let stored = serde_json::to_vec(&full.payload).unwrap();
    assert_eq!(*size, stored.len() as u64);

    assert!(store
        .decision_payload_sizes_as_of(&[], tip)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .decision_payload_sizes_as_of(&requested, tip + 1)
            .unwrap_err(),
        KernelError::FutureSnapshot
    );
}

#[test]
fn corrections_preserve_old_rows_and_reauthor_observation_dependencies() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("seed-slice", 'b'), |envelope| {
            envelope.insert_decision(decision(1))?;
            let mut independent = decision(2);
            independent.source_id = "independent-decision".to_string();
            envelope.insert_decision(independent)?;
            envelope.insert_observation(observation(1, "decision-object-1"))?;
            Ok(String::new())
        })
        .unwrap();

    let before = store.known_as_of(2).unwrap();
    assert!(before
        .objects
        .iter()
        .any(|row| row.object_id == "decision-object-1"));
    assert!(!before
        .objects
        .iter()
        .any(|row| row.object_id == "decision-object-3"));
    store
        .commit(intent("correct", 'c'), |envelope| {
            let mut replacement = decision(3);
            replacement.source_revision = 2;
            envelope.correct_decision("decision-object-1", replacement)?;
            let mut replacement = observation(2, "decision-object-2");
            replacement.source_revision = 2;
            envelope.correct_observation("observation-object-1", replacement)?;
            Ok(String::new())
        })
        .unwrap();

    let after = store.known_as_of(3).unwrap();
    assert!(!after
        .objects
        .iter()
        .any(|row| row.object_id == "decision-object-1"));
    assert!(after
        .objects
        .iter()
        .any(|row| row.object_id == "decision-object-3"));

    assert_eq!(
        inspect_i64(directory.path(), "SELECT COUNT(*) FROM decisions"),
        3
    );
    assert_eq!(
        inspect_i64(directory.path(), "SELECT COUNT(*) FROM observations"),
        2
    );
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM observation_dependencies"
        ),
        2
    );
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    let corrected_dependency: String = connection
        .query_row(
            "SELECT dependency_object_id FROM observation_dependencies
             WHERE observation_id='observation-2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(corrected_dependency, "decision-object-2");
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM decisions
             WHERE decision_id='decision-1' AND invalidated_commit_seq=3
             AND superseded_by='decision-object-3'"
        ),
        1
    );

    let error = store
        .commit(intent("correct-dead", 'd'), |envelope| {
            envelope.correct_decision("decision-object-1", decision(4))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::NotFound);

    let unbumped = store
        .commit(intent("unbumped", 'e'), |envelope| {
            let mut replacement = decision(4);
            replacement.source_revision = 2;
            envelope.correct_decision("decision-object-3", replacement)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(unbumped, KernelError::Conflict);

    store
        .commit(intent("retire-observation", 'f'), |envelope| {
            Ok(envelope
                .retire_observation("observation-object-2")?
                .result_json())
        })
        .unwrap();
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM observations
             WHERE observation_id='observation-2' AND invalidated_commit_seq=4
             AND superseded_by IS NULL"
        ),
        1
    );
}

#[test]
fn correction_records_replaced_identifier_redactions_in_events_and_outbox() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    let replaced_object_id = format!("decision-{SECRET}");
    let mut original = decision(1);
    original.object_id = replaced_object_id.clone();
    store
        .commit(intent("secret-correction-seed", '1'), |envelope| {
            envelope.insert_decision(original)?;
            Ok(String::new())
        })
        .unwrap();
    let mut replacement = decision(2);
    replacement.source_revision = 2;
    store
        .commit(intent("secret-correction", '2'), |envelope| {
            envelope.correct_decision(&replaced_object_id, replacement)?;
            Ok(String::new())
        })
        .unwrap();

    for owner_kind in ["change_event", "outbox"] {
        let sql = format!(
            "SELECT COUNT(*) FROM durable_text_redactions
             WHERE owner_kind='{owner_kind}' AND field_name='replaced_object_id'"
        );
        assert_eq!(inspect_i64(directory.path(), &sql), 1, "{owner_kind}");
    }
    assert!(!family_bytes(directory.path())
        .windows(SECRET.len())
        .any(|window| window == SECRET.as_bytes()));
}

#[test]
fn a_replacement_id_carrying_a_secret_is_refused_rather_than_aliased() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    // Two live decisions whose ids would redact to the same placeholder.
    let mut first = decision(1);
    first.object_id = format!("first-{SECRET}");
    let mut second = decision(2);
    second.object_id = format!("second-{SECRET}");
    store
        .commit(intent("secret-ids", '1'), |envelope| {
            envelope.insert_decision(first)?;
            envelope.insert_decision(second)?;
            Ok(String::new())
        })
        .unwrap();
    let mut replacement = decision(3);
    replacement.object_id = format!("second-{SECRET}");
    replacement.source_revision = 2;
    let error = store
        .commit(intent("alias-fold", '2'), |envelope| {
            envelope.correct_decision(&format!("first-{SECRET}"), replacement)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::InvalidInput);
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM decisions WHERE invalidated_commit_seq IS NOT NULL"
        ),
        0,
        "no decision was folded into a placeholder survivor"
    );
}

#[test]
fn corrections_reject_cross_domain_replacements() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("second-domain", '1'), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain-2".to_string(),
                object_id: "domain-object-2".to_string(),
                name: "fixture-2".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "domain-2".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("cross-domain-seed", '2'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope.insert_observation(observation(1, "decision-object-1"))?;
            Ok(String::new())
        })
        .unwrap();

    let moved_decision = store
        .commit(intent("cross-domain-decision", '3'), |envelope| {
            let mut replacement = decision(2);
            replacement.domain_id = "domain-2".to_string();
            replacement.source_revision = 2;
            envelope.correct_decision("decision-object-1", replacement)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(moved_decision, KernelError::InvalidInput);

    let moved_observation = store
        .commit(intent("cross-domain-observation", '4'), |envelope| {
            let mut replacement = observation(2, "decision-object-1");
            replacement.domain_id = "domain-2".to_string();
            replacement.source_revision = 2;
            envelope.correct_observation("observation-object-1", replacement)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(moved_observation, KernelError::InvalidInput);

    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE invalidated_commit_seq IS NOT NULL"
        ),
        0
    );
}

fn subject_request(object_id: &str, kind: EventKind) -> AdmissionRequest {
    AdmissionRequest {
        candidate_id: None,
        subject_object_id: Some(object_id.to_string()),
        source_class: Some(SourceClass::TrustedLocalCode),
        taint_class: Some(TaintClass::CurrentCode),
        event: AdmissionEvent {
            kind,
            trigger_object_id: None,
            approval_object_id: None,
            evidence_id: None,
            reason: format!("{kind:?}"),
        },
    }
}

fn live_decision_objects(store: &KernelStore) -> Vec<(String, Option<String>)> {
    let tip = store.tip().unwrap();
    store
        .object_history_as_of(tip)
        .unwrap()
        .objects
        .into_iter()
        .filter(|object| object.object_kind == "decision")
        .map(|object| {
            (
                object.object_id,
                object
                    .invalidated_commit_seq
                    .map(|_| object.superseded_by.unwrap_or_default()),
            )
        })
        .collect()
}

#[test]
fn supersede_decision_replaces_a_live_predecessor_and_folds_merges_into_a_survivor() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("seed", '1'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope.insert_decision(decision(2))?;
            Ok(String::new())
        })
        .unwrap();

    // Revision: the replacement is a new row, the predecessor names it.
    let revised = store
        .commit(intent("revise", '2'), |envelope| {
            let outcome = envelope.supersede_decision("decision-object-1", decision(3))?;
            assert_eq!(outcome.object_id, "decision-object-3");
            Ok(String::new())
        })
        .unwrap();
    let live = store.known_as_of(revised.commit_seq).unwrap();
    let live_ids: Vec<_> = live
        .objects
        .iter()
        .filter(|object| object.object_kind == "decision")
        .map(|object| object.object_id.as_str())
        .collect();
    assert_eq!(live_ids, ["decision-object-2", "decision-object-3"]);
    assert!(live_decision_objects(&store).contains(&(
        "decision-object-1".to_string(),
        Some("decision-object-3".to_string())
    )));

    // Merge: two predecessors name one already-live survivor in one envelope;
    // no row is written for the survivor.
    store
        .commit(intent("survivor", '3'), |envelope| {
            envelope.insert_decision(decision(4))?;
            Ok(String::new())
        })
        .unwrap();
    let merged = store
        .commit(intent("merge", '4'), |envelope| {
            let first = envelope.supersede_decision("decision-object-2", decision(4))?;
            let second = envelope.supersede_decision("decision-object-3", decision(4))?;
            assert_eq!(first.decision_id, "decision-4");
            assert_eq!(second.object_id, "decision-object-4");
            Ok(String::new())
        })
        .unwrap();
    let live = store.known_as_of(merged.commit_seq).unwrap();
    let live_ids: Vec<_> = live
        .objects
        .iter()
        .filter(|object| object.object_kind == "decision")
        .map(|object| object.object_id.as_str())
        .collect();
    assert_eq!(live_ids, ["decision-object-4"]);
    let history = live_decision_objects(&store);
    for predecessor in ["decision-object-2", "decision-object-3"] {
        assert!(history.contains(&(
            predecessor.to_string(),
            Some("decision-object-4".to_string())
        )));
    }
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM decisions WHERE object_id='decision-object-4'"
        ),
        1
    );
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM change_event WHERE commit_seq=(SELECT MAX(commit_seq) FROM commit_log)"
        ),
        2
    );

    // A survivor cannot supersede itself.
    let self_reference = store
        .commit(intent("self", '5'), |envelope| {
            envelope.supersede_decision("decision-object-4", decision(4))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(self_reference, KernelError::InvalidInput);
}

#[test]
fn supersede_decision_refuses_a_quarantined_predecessor() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    seed_domain(&store);
    store
        .commit(intent("seed", '1'), |envelope| {
            envelope.insert_decision(decision(1))?;
            envelope
                .record_admission(subject_request("decision-object-1", EventKind::Quarantine))?;
            Ok(String::new())
        })
        .unwrap();

    let refused = store
        .commit(intent("supersede", '2'), |envelope| {
            envelope.supersede_decision("decision-object-1", decision(2))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(refused, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect_i64(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE invalidated_commit_seq IS NOT NULL"
        ),
        0
    );
    let missing = store
        .commit(intent("missing", '3'), |envelope| {
            envelope.supersede_decision("decision-object-9", decision(2))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(missing, KernelError::NotFound);
}
