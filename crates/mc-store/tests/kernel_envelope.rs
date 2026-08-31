#![cfg(feature = "test-support")]

use std::cell::Cell;

use mc_store::kernel::{
    AlignmentProjectionSpec, CommitFault, CommitIntent, DecisionPayload, DecisionSpec, DomainSpec,
    KernelError, KernelErrorKind, KernelStore, ObservationDependencySpec, ObservationPayload,
    ObservationSpec, Sensitivity,
};
use rusqlite::{Connection, OpenFlags};

fn intent(key: &str, digest_byte: char) -> CommitIntent {
    CommitIntent {
        producer: "kernel-envelope-test".to_string(),
        operation_key: key.to_string(),
        request_digest: digest_byte.to_string().repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn domain(index: usize) -> DomainSpec {
    DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: format!("name-{index}"),
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: i64::try_from(index).unwrap(),
        sensitivity: Sensitivity::Normal,
    }
}

fn inspect(root: &std::path::Path, sql: &str) -> i64 {
    let connection =
        Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn seed_projection_inputs(root: &std::path::Path) -> i64 {
    let store = KernelStore::open(root).unwrap();
    store
        .commit(intent("projection-domain", '0'), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "domain".to_string(),
                object_id: "domain-object".to_string(),
                name: "fixture".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("projection-pair", '1'), |envelope| {
            envelope.insert_decision(DecisionSpec {
                decision_id: "decision".to_string(),
                object_id: "decision-object".to_string(),
                domain_id: "domain".to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                decision_kind: "fixture".to_string(),
                payload: DecisionPayload {
                    summary: "fixture".to_string(),
                    rationale: "projection replacement test".to_string(),
                },
                source_kind: "fixture".to_string(),
                source_id: "decision".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            envelope.insert_observation(ObservationSpec {
                observation_id: "observation".to_string(),
                object_id: "observation-object".to_string(),
                domain_id: "domain".to_string(),
                proposition_id: None,
                scope_id: None,
                anchor_id: None,
                evidence_id: None,
                observation_kind: "fixture".to_string(),
                payload: ObservationPayload {
                    summary: "fixture".to_string(),
                    classification: "implemented".to_string(),
                    detail: None,
                },
                observed_at: 1,
                dependencies: vec![ObservationDependencySpec {
                    dependency_object_id: "decision-object".to_string(),
                    dependency_kind: "implements".to_string(),
                    dependency_payload: None,
                }],
                source_kind: "fixture".to_string(),
                source_id: "observation".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq
}

#[test]
fn multi_object_commit_allocates_one_sequence_and_atomic_outbox() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let receipt = store
        .commit(intent("multi", 'a'), |envelope| {
            envelope.insert_domain(domain(1))?;
            envelope.insert_domain(domain(2))?;
            Ok("stored-two".to_string())
        })
        .unwrap();

    assert_eq!(receipt.commit_seq, 1);
    assert!(!receipt.replayed);
    assert_eq!(store.known_as_of(1).unwrap().objects.len(), 2);
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM commit_log"),
        1
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM change_event"),
        2
    );
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM outbox"), 2);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(DISTINCT outbox_position) FROM outbox"
        ),
        2
    );
}

#[test]
fn fault_after_events_rolls_back_canonical_rows_events_outbox_and_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let error = store
        .commit_with_fault_for_test(intent("fault", 'b'), CommitFault::AfterEvents, |envelope| {
            envelope.insert_domain(domain(1))?;
            Ok("must-not-persist".to_string())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::Fault);

    for table in [
        "commit_log",
        "object_registry",
        "domains",
        "change_event",
        "outbox",
        "operation_receipts",
    ] {
        assert_eq!(
            inspect(directory.path(), &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table}"
        );
    }
}

#[test]
fn receipt_replay_is_effect_free_and_digest_conflict_is_typed() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let first = store
        .commit(intent("replay", 'c'), |envelope| {
            envelope.insert_domain(domain(1))?;
            Ok("concrete-result".to_string())
        })
        .unwrap();
    let called = Cell::new(false);
    let replay = store
        .commit(intent("replay", 'c'), |_| {
            called.set(true);
            Ok("different-result".to_string())
        })
        .unwrap();
    assert!(!called.get());
    assert!(replay.replayed);
    assert_eq!(replay.commit_seq, first.commit_seq);
    assert_eq!(replay.result, "concrete-result");
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM commit_log"),
        1
    );
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM outbox"), 1);

    let conflict = store
        .commit(intent("replay", 'd'), |_| Ok(String::new()))
        .unwrap_err();
    assert_eq!(conflict.kind(), KernelErrorKind::Conflict);
}

#[test]
fn known_as_of_matches_reference_history_and_masks_future_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("history-0", '1'), |envelope| {
            envelope.insert_domain(domain(0))?;
            Ok("v0".to_string())
        })
        .unwrap();
    let mut expected = vec!["object-0".to_string()];

    for step in 1_usize..24 {
        let previous = expected.last().unwrap().clone();
        store
            .commit(
                intent(
                    &format!("history-{step}"),
                    char::from_digit(u32::try_from(step % 10).unwrap(), 10).unwrap(),
                ),
                |envelope| {
                    envelope.correct_domain(&previous, domain(step))?;
                    Ok(format!("v{step}"))
                },
            )
            .unwrap();
        expected.push(format!("object-{step}"));
    }
    store
        .commit(intent("history-retire", 'e'), |envelope| {
            envelope.retire_domain(expected.last().unwrap())?;
            Ok("retired".to_string())
        })
        .unwrap();

    assert_eq!(store.known_as_of(0).unwrap().objects, Vec::new());
    for sequence in 1..=24 {
        let snapshot = store.known_as_of(sequence).unwrap();
        assert_eq!(snapshot.objects.len(), 1, "sequence {sequence}");
        assert_eq!(
            snapshot.objects[0].object_id,
            expected[usize::try_from(sequence - 1).unwrap()]
        );
        assert_eq!(snapshot.objects[0].invalidated_commit_seq, None);
        assert_eq!(snapshot.objects[0].superseded_by, None);
    }
    assert!(store.known_as_of(25).unwrap().objects.is_empty());
    assert_eq!(
        store.known_as_of(26).unwrap_err().kind(),
        KernelErrorKind::FutureSnapshot
    );
}

#[test]
fn historical_lookup_exposes_only_invalidation_metadata_known_by_requested_commit() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("historical-insert", '6'), |envelope| {
            envelope.insert_domain(domain(0))?;
            Ok("inserted".to_string())
        })
        .unwrap();
    store
        .commit(intent("historical-correct", '7'), |envelope| {
            envelope.correct_domain("object-0", domain(1))?;
            Ok("corrected".to_string())
        })
        .unwrap();
    store
        .commit(intent("historical-retire", '8'), |envelope| {
            envelope.retire_domain("object-1")?;
            Ok("retired".to_string())
        })
        .unwrap();

    let before = store.object_history_as_of(1).unwrap();
    assert_eq!(before.objects.len(), 1);
    assert_eq!(before.objects[0].object_id, "object-0");
    assert_eq!(before.objects[0].invalidated_commit_seq, None);
    assert_eq!(before.objects[0].superseded_by, None);

    let tip = store.object_history_as_of(3).unwrap();
    assert_eq!(tip.objects.len(), 2);
    let corrected = tip
        .objects
        .iter()
        .find(|row| row.object_id == "object-0")
        .unwrap();
    assert_eq!(corrected.invalidated_commit_seq, Some(2));
    assert_eq!(corrected.superseded_by.as_deref(), Some("object-1"));
    let deleted = tip
        .objects
        .iter()
        .find(|row| row.object_id == "object-1")
        .unwrap();
    assert_eq!(deleted.invalidated_commit_seq, Some(3));
    assert_eq!(deleted.superseded_by, None);

    assert_eq!(
        store.known_as_of(1).unwrap().objects[0].object_id,
        "object-0"
    );
    assert_eq!(
        store.known_as_of(2).unwrap().objects[0].object_id,
        "object-1"
    );
    assert!(store.known_as_of(3).unwrap().objects.is_empty());
}

#[test]
fn randomized_history_matches_reference_model() {
    #[derive(Clone)]
    struct Lifetime {
        id: String,
        created: i64,
        invalidated: Option<i64>,
    }

    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let mut seed = 0x5eed_u64;
    let mut next_id = 0_usize;
    let mut history: Vec<Lifetime> = Vec::new();
    let mut active: Vec<String> = Vec::new();

    for sequence in 1_i64..=64 {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let action = if active.is_empty() { 0 } else { seed % 3 };
        let key = format!("random-{sequence}");
        match action {
            0 => {
                let spec = domain(next_id);
                let id = spec.object_id.clone();
                store
                    .commit(intent(&key, '9'), |envelope| {
                        envelope.insert_domain(spec)?;
                        Ok(id.clone())
                    })
                    .unwrap();
                history.push(Lifetime {
                    id: id.clone(),
                    created: sequence,
                    invalidated: None,
                });
                active.push(id);
                next_id += 1;
            }
            1 => {
                let index = usize::try_from(seed).unwrap() % active.len();
                let old = active.swap_remove(index);
                let spec = domain(next_id);
                let new = spec.object_id.clone();
                store
                    .commit(intent(&key, '9'), |envelope| {
                        envelope.correct_domain(&old, spec)?;
                        Ok(new.clone())
                    })
                    .unwrap();
                history
                    .iter_mut()
                    .find(|row| row.id == old)
                    .unwrap()
                    .invalidated = Some(sequence);
                history.push(Lifetime {
                    id: new.clone(),
                    created: sequence,
                    invalidated: None,
                });
                active.push(new);
                next_id += 1;
            }
            _ => {
                let index = usize::try_from(seed).unwrap() % active.len();
                let retired = active.swap_remove(index);
                store
                    .commit(intent(&key, '9'), |envelope| {
                        envelope.retire_domain(&retired)?;
                        Ok(retired.clone())
                    })
                    .unwrap();
                history
                    .iter_mut()
                    .find(|row| row.id == retired)
                    .unwrap()
                    .invalidated = Some(sequence);
            }
        }
    }

    for sequence in 0_i64..=64 {
        let mut expected = history
            .iter()
            .filter(|row| {
                row.created <= sequence
                    && row
                        .invalidated
                        .is_none_or(|invalidated| sequence < invalidated)
            })
            .map(|row| row.id.clone())
            .collect::<Vec<_>>();
        expected.sort();
        let actual = store
            .known_as_of(sequence)
            .unwrap()
            .objects
            .into_iter()
            .map(|row| row.object_id)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "sequence {sequence}");
    }
}

#[test]
fn stale_writer_is_rejected_before_user_operation() {
    for delta in [-1_i64, 1] {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        let expected = i64::try_from(store.lease_epoch()).unwrap();
        store.set_writer_fence_for_test(expected + delta).unwrap();
        let called = Cell::new(false);
        let error = store
            .commit(intent(&format!("stale-{delta}"), 'f'), |_| {
                called.set(true);
                Ok(String::new())
            })
            .unwrap_err();
        assert_eq!(error, KernelError::FenceLost);
        assert!(!called.get());
    }
}

#[test]
fn envelope_persists_declared_sensitivity_across_canonical_and_outbox_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let mut normal = domain(1);
    normal.sensitivity = Sensitivity::Normal;
    let mut sensitive = domain(2);
    sensitive.sensitivity = Sensitivity::Sensitive;
    store
        .commit(intent("mixed-sensitivity", 'a'), |envelope| {
            envelope.insert_domain(normal)?;
            envelope.insert_domain(sensitive)?;
            Ok("stored".to_string())
        })
        .unwrap();
    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    for table in ["domains", "object_registry", "outbox"] {
        let values = connection
            .prepare(&format!(
                "SELECT object_id,sensitivity_class FROM {table} ORDER BY object_id"
            ))
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            values,
            [
                ("object-1".to_string(), "normal".to_string()),
                ("object-2".to_string(), "sensitive".to_string())
            ],
            "{table}"
        );
    }
}

#[test]
fn projection_full_replace_is_coordinator_side_and_creates_no_commit_or_events() {
    let directory = tempfile::tempdir().unwrap();
    let built_through_commit_seq = seed_projection_inputs(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    let baseline_commits = inspect(directory.path(), "SELECT COUNT(*) FROM commit_log");
    let baseline_events = inspect(directory.path(), "SELECT COUNT(*) FROM change_event");
    let baseline_outbox = inspect(directory.path(), "SELECT COUNT(*) FROM outbox");

    let first = AlignmentProjectionSpec {
        decision_id: "decision".to_string(),
        observation_id: "observation".to_string(),
        alignment_kind: "intended".to_string(),
        alignment_payload: Some("api_key=first-private-value".to_string()),
        built_through_commit_seq,
    };
    assert_eq!(
        store.replace_alignment_projection(&[first]).unwrap().rows,
        1
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM durable_text_redactions WHERE owner_kind='alignment_projection'"
        ),
        1
    );
    let second = AlignmentProjectionSpec {
        decision_id: "decision".to_string(),
        observation_id: "observation".to_string(),
        alignment_kind: "implemented".to_string(),
        alignment_payload: Some("password=second-private-value".to_string()),
        built_through_commit_seq,
    };
    assert_eq!(
        store.replace_alignment_projection(&[second]).unwrap().rows,
        1
    );

    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM commit_log"),
        baseline_commits
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM change_event"),
        baseline_events
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM outbox"),
        baseline_outbox
    );
    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let row: (String, String) = connection
        .query_row(
            "SELECT alignment_kind,alignment_payload FROM alignment_projection",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "implemented".to_string(),
            "password=<REDACTED:password>".to_string()
        )
    );
    let redactions = connection
        .prepare(
            "SELECT owner_id,field_name,secret_type FROM durable_text_redactions
             WHERE owner_kind='alignment_projection' ORDER BY detection_ordinal",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        redactions,
        [(
            "decision:observation".to_string(),
            "alignment_payload".to_string(),
            "password".to_string()
        )]
    );
}
