#![cfg(feature = "test-support")]

use mc_store::kernel::{
    AdmissionDomainSpec, AdmissionEvent, AdmissionRequest, CommitIntent, DomainSpec, EventKind,
    KernelError, KernelStore, RepositoryProvenance, Sensitivity, SourceClass, StagingCandidateSpec,
    StagingTerminalState, Surface, TaintClass, STAGING_RETENTION_MS,
};
use rusqlite::{Connection, OpenFlags};

fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-admission-test".to_string(),
        operation_key: key.to_string(),
        request_digest: "a".repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

fn stage(store: &KernelStore, candidate_id: &str) {
    stage_from(store, candidate_id, &format!("source-{candidate_id}"));
}

fn stage_from(store: &KernelStore, candidate_id: &str, source_id: &str) {
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: format!("run-{candidate_id}"),
            candidate_id: candidate_id.to_string(),
            extractor: "fixture".to_string(),
            source_kind: "repo".to_string(),
            source_id: source_id.to_string(),
            source_revision: 1,
            candidate_kind: "domain".to_string(),
            payload: format!("name-{candidate_id}"),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: now,
            lease_expires_at: now + 60_000,
        })
        .unwrap();
}

fn request(candidate_id: &str) -> AdmissionRequest {
    AdmissionRequest {
        candidate_id: Some(candidate_id.to_string()),
        subject_object_id: None,
        source_class: Some(SourceClass::TrustedLocalCode),
        taint_class: Some(TaintClass::CurrentCode),
        event: AdmissionEvent {
            kind: EventKind::CodeObserved,
            trigger_object_id: Some(format!("observation-{candidate_id}")),
            approval_object_id: None,
            evidence_id: None,
            reason: "host observed current code".to_string(),
        },
    }
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

fn insert_subject(
    store: &KernelStore,
    key: &str,
    sensitivity: Sensitivity,
    event: Option<EventKind>,
) -> i64 {
    store
        .commit(intent(key), |envelope| {
            let domain_id = format!("domain-{key}");
            let object_id = format!("object-{key}");
            envelope.insert_domain(DomainSpec {
                domain_id: domain_id.clone(),
                object_id: object_id.clone(),
                name: key.to_string(),
                source_kind: "fixture".to_string(),
                source_id: format!("source-{key}"),
                source_revision: 1,
                sensitivity,
            })?;
            if let Some(event) = event {
                let mut request = subject_request(&object_id, event);
                if matches!(event, EventKind::CodeObserved | EventKind::ConfigObserved) {
                    let observation_id = format!("observation-{key}");
                    envelope.insert_admission_observation_for_test(
                        &observation_id,
                        if event == EventKind::CodeObserved {
                            "code_present"
                        } else {
                            "config_present"
                        },
                        &domain_id,
                        "fixture",
                        &format!("source-{key}"),
                        1,
                    )?;
                    request.event.trigger_object_id = Some(observation_id);
                }
                envelope.record_admission(request)?;
            }
            Ok(String::new())
        })
        .unwrap()
        .commit_seq
}

fn inspect(root: &std::path::Path, sql: &str) -> i64 {
    Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

fn inspect_text(root: &std::path::Path, sql: &str) -> String {
    Connection::open_with_flags(root.join("core.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

fn seed_approval(root: &std::path::Path) {
    let store = KernelStore::open(root).unwrap();
    store
        .commit(intent("approval-domain"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "approval-domain".to_string(),
                object_id: "approval-domain-object".to_string(),
                name: "approval domain".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "approval-domain".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    drop(store);
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'approval','decision','approval-domain','fixture','approval',1,1,'normal'
             );
             INSERT INTO decisions(
                 decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                 sensitivity_class
             ) VALUES ('approval-decision','approval','adr_accepted',X'7b7d',1,'normal');
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'approval-admission','approval','fixture','approval',1,'explicit_user',
                 'user_explicit','approved','approved','active','automatic','normal',1,'fixture',1,1
             );",
        )
        .unwrap();
}

#[test]
fn candidate_admission_is_atomic_and_receipt_replay_is_effect_free() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "candidate");

    let first = store
        .commit(intent("admit"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-candidate",
                "code_present",
                "domain",
                "repo",
                "source-candidate",
                1,
            )?;
            let decision = envelope.admit_domain_candidate(
                request("candidate"),
                AdmissionDomainSpec {
                    domain_id: "domain".to_string(),
                    object_id: "object".to_string(),
                    name: "name-candidate".to_string(),
                },
            )?;
            Ok(decision.admission_decision_id)
        })
        .unwrap();
    let replay = store
        .commit(intent("admit"), |_| panic!("replay must not execute"))
        .unwrap();

    assert_eq!(replay.commit_seq, first.commit_seq);
    assert!(replay.replayed);
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM domains"), 1);
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
        1
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM change_event"),
        2
    );
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM outbox"), 2);
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT json_extract(payload,'$.audit.outcome')
             FROM outbox WHERE object_kind='admission_decision'"
        ),
        "admit"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT json_extract(payload,'$.audit.visibility')
             FROM outbox WHERE object_kind='admission_decision'"
        ),
        "automatic"
    );
}

#[test]
fn missing_classification_rolls_back_commit_and_all_effects() {
    for missing_source in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        stage(&store, "unclassified");
        let mut request = request("unclassified");
        if missing_source {
            request.source_class = None;
        } else {
            request.taint_class = None;
        }

        let error = store
            .commit(intent("missing-class"), |envelope| {
                envelope.record_admission(request)?;
                Ok(String::new())
            })
            .unwrap_err();
        assert_eq!(error, KernelError::AdmissionPolicy);
        for table in [
            "commit_log",
            "domains",
            "object_registry",
            "admission_decisions",
            "change_event",
            "outbox",
            "operation_receipts",
        ] {
            assert_eq!(
                inspect(directory.path(), &format!("SELECT COUNT(*) FROM {table}")),
                0,
                "{table} missing_source={missing_source}"
            );
        }
    }
}

#[test]
fn duplicate_rejection_is_a_no_op_and_keeps_the_first_audit_row() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "rejected");
    let rejected = AdmissionRequest {
        candidate_id: Some("rejected".to_string()),
        subject_object_id: None,
        source_class: Some(SourceClass::UntrustedRepoText),
        taint_class: Some(TaintClass::RepoUntrustedText),
        event: AdmissionEvent {
            kind: EventKind::ExplicitReject,
            trigger_object_id: None,
            approval_object_id: None,
            evidence_id: None,
            reason: "explicit rejection".to_string(),
        },
    };
    store
        .commit(intent("reject-1"), |envelope| {
            assert!(envelope.record_admission(rejected.clone())?.is_some());
            Ok(String::new())
        })
        .unwrap();
    let original = inspect_text(
        directory.path(),
        "SELECT json_array(
             admission_decision_id,candidate_id,subject_object_id,source_kind,source_id,
             source_revision,source_class,taint_class,maturity,disposition,visibility,
             policy_revision,reason,evidence_id,approval_object_id,commit_seq,decided_at
         ) FROM admission_decisions",
    );
    store
        .commit(intent("reject-2"), |envelope| {
            assert!(envelope.record_admission(rejected)?.is_none());
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT json_array(
                 admission_decision_id,candidate_id,subject_object_id,source_kind,source_id,
                 source_revision,source_class,taint_class,maturity,disposition,visibility,
                 policy_revision,reason,evidence_id,approval_object_id,commit_seq,decided_at
             ) FROM admission_decisions"
        ),
        original
    );

    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
        1
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM change_event"),
        1
    );
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM outbox"), 1);
}

#[test]
fn replacement_preserves_predecessor_history_and_leaves_successor_unadmitted() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "original");
    store
        .commit(intent("original"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-original",
                "code_present",
                "domain-original",
                "repo",
                "source-original",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("original"),
                AdmissionDomainSpec {
                    domain_id: "domain-original".to_string(),
                    object_id: "object-original".to_string(),
                    name: "name-original".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("replace"), |envelope| {
            envelope.supersede_domain(
                subject_request("object-original", EventKind::Replace),
                AdmissionDomainSpec {
                    domain_id: "domain-successor".to_string(),
                    object_id: "object-successor".to_string(),
                    name: "successor".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();

    let live = store.known_as_of(2).unwrap();
    assert_eq!(
        live.objects
            .iter()
            .filter(|object| object.object_kind == "domain")
            .map(|object| object.object_id.as_str())
            .collect::<Vec<_>>(),
        vec!["object-successor"]
    );
    let history = store.object_history_as_of(2).unwrap();
    assert_eq!(
        history
            .objects
            .iter()
            .filter(|object| object.object_kind == "domain")
            .count(),
        2
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='object-successor'"
        ),
        0
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='object-original'"
        ),
        2
    );
}

#[test]
fn approval_revocation_fans_out_support_demotion_without_rewriting_history() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    for candidate in ["dependent-a", "dependent-b"] {
        stage(&store, candidate);
        let mut approved = request(candidate);
        approved.source_class = Some(SourceClass::ModelInference);
        approved.taint_class = Some(TaintClass::AssistantInference);
        approved.event.kind = EventKind::Verify;
        approved.event.approval_object_id = Some("approval".to_string());
        store
            .commit(intent(candidate), |envelope| {
                envelope.admit_domain_candidate(
                    approved,
                    AdmissionDomainSpec {
                        domain_id: format!("domain-{candidate}"),
                        object_id: format!("object-{candidate}"),
                        name: format!("name-{candidate}"),
                    },
                )?;
                Ok(String::new())
            })
            .unwrap();
    }
    let mut laundered = subject_request("object-dependent-a", EventKind::Other);
    laundered.source_class = Some(SourceClass::TrustedLocalCode);
    laundered.taint_class = Some(TaintClass::CurrentCode);
    assert_eq!(
        store
            .commit(intent("launder"), |envelope| {
                envelope.record_admission(laundered)?;
                Ok(String::new())
            })
            .unwrap_err(),
        KernelError::AdmissionPolicy
    );
    store
        .commit(intent("neutral-before-revoke"), |envelope| {
            let mut neutral = subject_request("object-dependent-a", EventKind::Other);
            neutral.source_class = Some(SourceClass::ModelInference);
            neutral.taint_class = Some(TaintClass::AssistantInference);
            envelope.record_admission(neutral)?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='object-dependent-a'
               AND commit_seq=4 AND approval_object_id='approval'"
        ),
        1
    );

    let receipt = store
        .commit(intent("revoke"), |envelope| {
            let decisions = envelope.revoke_approval("approval", "authority revoked")?;
            assert_eq!(decisions.len(), 2);
            assert!(decisions
                .iter()
                .all(|decision| decision.historical_maturity.as_str() == "verified"));
            assert!(decisions
                .iter()
                .all(|decision| decision.effective_maturity.as_str() == "candidate"));
            assert!(decisions
                .iter()
                .all(|decision| decision.outcome.as_str() == "demote_support"));
            Ok(String::new())
        })
        .unwrap();

    assert_eq!(receipt.commit_seq, 5);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE commit_seq=5 AND maturity='verified' AND visibility='explicit_labeled'"
        ),
        2
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry
             WHERE object_id='approval' AND invalidated_commit_seq=5"
        ),
        1
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM change_event WHERE commit_seq=5"
        ),
        3
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM change_event
             WHERE commit_seq=5 AND change_kind='demote_support'"
        ),
        2
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM outbox WHERE commit_seq=5"
        ),
        3
    );
    store
        .commit(intent("after-revoke"), |envelope| {
            let mut later = subject_request("object-dependent-a", EventKind::Other);
            later.source_class = Some(SourceClass::ModelInference);
            later.taint_class = Some(TaintClass::AssistantInference);
            let decision = envelope.record_admission(later)?.unwrap();
            assert_eq!(decision.historical_maturity.as_str(), "verified");
            assert_eq!(decision.effective_maturity.as_str(), "candidate");
            assert_eq!(decision.visibility.as_str(), "explicit_labeled");
            Ok(String::new())
        })
        .unwrap();
}

#[test]
fn quarantined_approval_cannot_authorize_a_candidate() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    let quarantined = AdmissionRequest {
        candidate_id: None,
        subject_object_id: Some("approval".to_string()),
        source_class: Some(SourceClass::ExplicitUser),
        taint_class: Some(TaintClass::UserExplicit),
        event: AdmissionEvent {
            kind: EventKind::Quarantine,
            trigger_object_id: None,
            approval_object_id: None,
            evidence_id: None,
            reason: "approval quarantined".to_string(),
        },
    };
    store
        .commit(intent("quarantine-approval"), |envelope| {
            envelope.record_admission(quarantined)?;
            Ok(String::new())
        })
        .unwrap();
    stage(&store, "blocked-by-quarantine");
    let mut approved = request("blocked-by-quarantine");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("blocked-by-quarantine"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "blocked-domain".to_string(),
                    object_id: "blocked-object".to_string(),
                    name: "name-blocked-by-quarantine".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='blocked-object'"
        ),
        0
    );
}

#[test]
fn injected_failure_rolls_back_domain_decision_events_outbox_and_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "fault");
    assert_eq!(
        store
            .commit_with_fault_after_events_for_test(intent("fault"), |envelope| {
                envelope.insert_admission_observation_for_test(
                    "observation-fault",
                    "code_present",
                    "fault-domain",
                    "repo",
                    "source-fault",
                    1,
                )?;
                envelope.admit_domain_candidate(
                    request("fault"),
                    AdmissionDomainSpec {
                        domain_id: "fault-domain".to_string(),
                        object_id: "fault-object".to_string(),
                        name: "name-fault".to_string(),
                    },
                )?;
                Ok(String::new())
            })
            .unwrap_err(),
        KernelError::Fault
    );
    for table in [
        "commit_log",
        "domains",
        "object_registry",
        "admission_decisions",
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
fn unvalidated_observation_denies_without_materializing_candidate() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "unvalidated");
    let mut unvalidated = request("unvalidated");
    unvalidated.event.trigger_object_id = None;
    let receipt = store
        .commit(intent("unvalidated"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                unvalidated,
                AdmissionDomainSpec {
                    domain_id: "domain-unvalidated".to_string(),
                    object_id: "object-unvalidated".to_string(),
                    name: "name-unvalidated".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(receipt.commit_seq, 1);
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM domains"), 0);
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
        1
    );
}

#[test]
fn observation_from_another_source_cannot_authorize_candidate() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "candidate-b");
    store
        .commit(intent("cross-source-trigger"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "trigger-domain".to_string(),
                object_id: "trigger-domain-object".to_string(),
                name: "trigger".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "trigger".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            envelope.insert_admission_observation_for_test(
                "observation-candidate-b",
                "code_present",
                "trigger-domain",
                "repo",
                "source-candidate-a",
                1,
            )?;
            let decision = envelope.admit_domain_candidate(
                request("candidate-b"),
                AdmissionDomainSpec {
                    domain_id: "domain-candidate-b".to_string(),
                    object_id: "object-candidate-b".to_string(),
                    name: "name-candidate-b".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-candidate-b'"
        ),
        0
    );
}

#[test]
fn candidate_payload_mismatch_rolls_back_admission() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "bound");
    let error = store
        .commit(intent("bound"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-bound",
                "code_present",
                "domain-bound",
                "repo",
                "source-bound",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("bound"),
                AdmissionDomainSpec {
                    domain_id: "domain-bound".to_string(),
                    object_id: "object-bound".to_string(),
                    name: "different-content".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
        0
    );
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM domains"), 0);
}

#[test]
fn generic_object_replacement_is_rejected_without_canonical_effect() {
    for event in [EventKind::Correct, EventKind::Replace] {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        store
            .commit(intent("replace-base"), |envelope| {
                envelope.insert_domain(DomainSpec {
                    domain_id: "replace-domain".to_string(),
                    object_id: "replace-object".to_string(),
                    name: "replace base".to_string(),
                    source_kind: "fixture".to_string(),
                    source_id: "replace".to_string(),
                    source_revision: 1,
                    sensitivity: Sensitivity::Normal,
                })?;
                Ok(String::new())
            })
            .unwrap();
        assert_eq!(
            store
                .commit(intent("replace-invalid"), |envelope| {
                    envelope.record_admission(subject_request("replace-object", event))?;
                    Ok(String::new())
                })
                .unwrap_err(),
            KernelError::AdmissionPolicy
        );
        assert_eq!(store.known_as_of(1).unwrap().objects.len(), 1);
    }
}

#[test]
fn correction_preserves_predecessor_history_and_emits_both_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "corrected");
    store
        .commit(intent("corrected-base"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-corrected",
                "code_present",
                "corrected-domain",
                "repo",
                "source-corrected",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("corrected"),
                AdmissionDomainSpec {
                    domain_id: "corrected-domain".to_string(),
                    object_id: "corrected-object".to_string(),
                    name: "name-corrected".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("correct"), |envelope| {
            envelope.supersede_domain(
                subject_request("corrected-object", EventKind::Correct),
                AdmissionDomainSpec {
                    domain_id: "successor-domain".to_string(),
                    object_id: "successor-object".to_string(),
                    name: "corrected successor".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();

    assert_eq!(
        store
            .object_history_as_of(2)
            .unwrap()
            .objects
            .iter()
            .filter(|object| object.object_kind == "domain")
            .count(),
        2
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM change_event WHERE commit_seq=2"
        ),
        2
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM outbox WHERE commit_seq=2"
        ),
        2
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='corrected-object' AND disposition='superseded'"
        ),
        1
    );
}

#[test]
fn same_envelope_prior_and_double_digit_ordinal_choose_the_last_decision() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("ordinal-base"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "ordinal-domain".to_string(),
                object_id: "ordinal-object".to_string(),
                name: "ordinal".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "ordinal".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("ordinal-decisions"), |envelope| {
            for ordinal in 0..11 {
                let event = if ordinal % 2 == 0 {
                    EventKind::MarkStale
                } else {
                    EventKind::MarkDisputed
                };
                let decision = envelope
                    .record_admission(subject_request("ordinal-object", event))?
                    .unwrap();
                assert_eq!(decision.admission_decision_id, format!("2:{ordinal:020}"));
            }
            assert!(envelope
                .record_admission(subject_request("ordinal-object", EventKind::MarkStale,))?
                .is_none());
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("ordinal-latest"), |envelope| {
            assert!(envelope
                .record_admission(subject_request("ordinal-object", EventKind::MarkStale,))?
                .is_none());
            Ok(String::new())
        })
        .unwrap();
}

#[test]
fn visible_reads_exclude_decisionless_objects_and_apply_maturity_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    insert_subject(&store, "undecided", Sensitivity::Normal, None);
    insert_subject(
        &store,
        "candidate",
        Sensitivity::Normal,
        Some(EventKind::Other),
    );
    insert_subject(
        &store,
        "verified",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );

    let auto = store.visible_as_of(Surface::AutoInject, 3).unwrap();
    assert_eq!(auto.rows.len(), 1);
    assert_eq!(auto.rows[0].object.object_id, "object-verified");
    assert!(!auto.rows[0].labeled);
    let explicit = store.visible_as_of(Surface::ExplicitSearch, 3).unwrap();
    assert_eq!(
        explicit
            .rows
            .iter()
            .map(|row| (row.object.object_id.as_str(), row.labeled))
            .collect::<Vec<_>>(),
        vec![("object-candidate", true), ("object-verified", false)]
    );
    assert_eq!(
        store
            .known_as_of(3)
            .unwrap()
            .objects
            .iter()
            .filter(|object| object.object_kind == "domain")
            .count(),
        3
    );
}

#[test]
fn dispositions_and_sensitivity_only_reduce_visibility() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    insert_subject(
        &store,
        "stale",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    store
        .commit(intent("mark-stale"), |envelope| {
            envelope.record_admission(subject_request("object-stale", EventKind::MarkStale))?;
            Ok(String::new())
        })
        .unwrap();
    insert_subject(
        &store,
        "sensitive",
        Sensitivity::Sensitive,
        Some(EventKind::CodeObserved),
    );
    insert_subject(
        &store,
        "secret",
        Sensitivity::Secret,
        Some(EventKind::CodeObserved),
    );

    assert!(store
        .visible_as_of(Surface::AutoSearch, 4)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        store
            .visible_as_of(Surface::ExplicitSearch, 4)
            .unwrap()
            .rows
            .iter()
            .map(|row| (row.object.object_id.as_str(), row.labeled))
            .collect::<Vec<_>>(),
        vec![("object-sensitive", false), ("object-stale", true)]
    );
}

#[test]
fn taint_sensitivity_floor_applies_to_existing_canonical_objects() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("personal"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "personal-domain".to_string(),
                object_id: "personal-object".to_string(),
                name: "personal".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "personal".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            envelope.record_admission(AdmissionRequest {
                candidate_id: None,
                subject_object_id: Some("personal-object".to_string()),
                source_class: Some(SourceClass::ModelInference),
                taint_class: Some(TaintClass::Personal),
                event: AdmissionEvent {
                    kind: EventKind::Other,
                    trigger_object_id: None,
                    approval_object_id: None,
                    evidence_id: None,
                    reason: "personal".to_string(),
                },
            })?;
            Ok(String::new())
        })
        .unwrap();
    assert!(store
        .visible_as_of(Surface::AutoSearch, 1)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        store
            .visible_as_of(Surface::ExplicitSearch, 1)
            .unwrap()
            .rows[0]
            .object
            .object_id,
        "personal-object"
    );
}

#[test]
fn visibility_is_time_travel_safe_across_support_loss() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "timed");
    let mut approved = request("timed");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("timed"), |envelope| {
            envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "domain-timed".to_string(),
                    object_id: "object-timed".to_string(),
                    name: "name-timed".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("timed-revoke"), |envelope| {
            envelope.revoke_approval("approval", "revoked")?;
            Ok(String::new())
        })
        .unwrap();

    assert!(store
        .visible_as_of(Surface::AutoInject, 2)
        .unwrap()
        .rows
        .iter()
        .any(|row| row.object.object_id == "object-timed"));
    assert!(store
        .visible_as_of(Surface::AutoInject, 3)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        store
            .visible_as_of(Surface::ExplicitSearch, 3)
            .unwrap()
            .rows[0]
            .object
            .object_id,
        "object-timed"
    );
}

#[test]
fn every_non_active_disposition_has_the_contracted_surface_row() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    for (key, event) in [
        ("disputed", EventKind::MarkDisputed),
        ("superseded", EventKind::Other),
        ("rejected", EventKind::ExplicitReject),
        ("contradicted", EventKind::Contradict),
        ("quarantined", EventKind::Quarantine),
    ] {
        insert_subject(&store, key, Sensitivity::Normal, Some(event));
    }
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE admission_decisions
             SET disposition='superseded',visibility='explicit_labeled'
             WHERE subject_object_id='object-superseded'",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    assert!(store
        .visible_as_of(Surface::AutoSearch, 5)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        store
            .visible_as_of(Surface::ExplicitSearch, 5)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.object.object_id.as_str())
            .collect::<Vec<_>>(),
        vec!["object-disputed", "object-superseded"]
    );
}

#[test]
fn malformed_stored_policy_and_sensitivity_fail_closed_without_read_error() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    insert_subject(
        &store,
        "bad-policy",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    insert_subject(
        &store,
        "null-sequence",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE admission_decisions
             SET maturity='future',effective_maturity='future',disposition='future',
                 visibility='future',policy_revision=0
             WHERE subject_object_id='object-bad-policy'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE admission_decisions SET commit_seq=NULL
             WHERE subject_object_id='object-null-sequence'",
            [],
        )
        .unwrap();
    connection
        .execute_batch(
            "INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'object-bad-sensitivity','fixture','domain-null-sequence','fixture',
                 'bad-sensitivity',1,2,'future'
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'bad-sensitivity-decision','object-bad-sensitivity','fixture',
                 'bad-sensitivity',1,'trusted_local_code','current_code','verified','verified',
                 'active','automatic','normal',1,'fixture',2,2
             );
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'object-inconsistent','fixture','domain-null-sequence','fixture',
                 'inconsistent',1,2,'normal'
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'inconsistent-decision','object-inconsistent','fixture','inconsistent',1,
                 'trusted_local_code','current_code','verified','verified','rejected',
                 'automatic','normal',1,'fixture',2,2
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    assert!(store
        .visible_as_of(Surface::ExplicitSearch, 2)
        .unwrap()
        .rows
        .is_empty());
}

#[test]
fn valid_old_policy_revision_uses_current_surface_mapping() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    insert_subject(
        &store,
        "old-policy",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE admission_decisions SET policy_revision=0
             WHERE subject_object_id='object-old-policy'",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    assert_eq!(
        store.visible_as_of(Surface::AutoInject, 1).unwrap().rows[0]
            .object
            .object_id,
        "object-old-policy"
    );
}

#[test]
fn rejection_survives_candidate_retention_and_applies_to_re_staged_source() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_from(&store, "old-candidate", "stable-source");
    let rejected = |candidate_id: &str| AdmissionRequest {
        candidate_id: Some(candidate_id.to_string()),
        subject_object_id: None,
        source_class: Some(SourceClass::UntrustedRepoText),
        taint_class: Some(TaintClass::RepoUntrustedText),
        event: AdmissionEvent {
            kind: EventKind::ExplicitReject,
            trigger_object_id: None,
            approval_object_id: None,
            evidence_id: None,
            reason: "remember rejection".to_string(),
        },
    };
    store
        .commit(intent("remember-rejection"), |envelope| {
            envelope.record_admission(rejected("old-candidate"))?;
            Ok(String::new())
        })
        .unwrap();
    let terminal_at: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .finish_staging_run(
            "run-old-candidate",
            StagingTerminalState::Completed,
            terminal_at,
        )
        .unwrap();
    assert_eq!(
        store
            .delete_aged_staging_runs(terminal_at + STAGING_RETENTION_MS)
            .unwrap(),
        1
    );
    stage_from(&store, "new-candidate", "stable-source");
    store
        .commit(intent("remembered-rejection"), |envelope| {
            assert!(envelope
                .record_admission(rejected("new-candidate"))?
                .is_none());
            Ok(String::new())
        })
        .unwrap();

    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE source_id='stable-source'"
        ),
        1
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE source_id='stable-source' AND candidate_id IS NULL"
        ),
        1
    );
}

#[test]
fn source_level_rejection_shadows_a_previously_admitted_object() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_from(&store, "first", "shared-source");
    let admitted = store
        .commit(intent("admit-first"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-first",
                "code_present",
                "domain-shadowed",
                "repo",
                "shared-source",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("first"),
                AdmissionDomainSpec {
                    domain_id: "domain-shadowed".to_string(),
                    object_id: "object-shadowed".to_string(),
                    name: "name-first".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    stage_from(&store, "second", "shared-source");
    let rejected = store
        .commit(intent("reject-shared"), |envelope| {
            envelope.record_admission(AdmissionRequest {
                candidate_id: Some("second".to_string()),
                subject_object_id: None,
                source_class: Some(SourceClass::TrustedLocalCode),
                taint_class: Some(TaintClass::CurrentCode),
                event: AdmissionEvent {
                    kind: EventKind::ExplicitReject,
                    trigger_object_id: None,
                    approval_object_id: None,
                    evidence_id: None,
                    reason: "reject the shared source".to_string(),
                },
            })?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    let reobserved = store
        .commit(intent("observe-shadowed-again"), |envelope| {
            let mut request = subject_request("object-shadowed", EventKind::CodeObserved);
            request.event.trigger_object_id = Some("observation-first".to_string());
            envelope.record_admission(request)?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    assert!(store
        .visible_as_of(Surface::AutoInject, admitted)
        .unwrap()
        .rows
        .iter()
        .any(|row| row.object.object_id == "object-shadowed"));
    assert!(store
        .visible_as_of(Surface::AutoInject, rejected)
        .unwrap()
        .rows
        .is_empty());
    assert!(store
        .visible_as_of(Surface::ExplicitSearch, rejected)
        .unwrap()
        .rows
        .is_empty());
    assert!(store
        .visible_as_of(Surface::AutoInject, reobserved)
        .unwrap()
        .rows
        .is_empty());
    assert!(store
        .visible_as_of(Surface::ExplicitSearch, reobserved)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition FROM admission_decisions
             WHERE subject_object_id='object-shadowed'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "rejected"
    );
}

#[test]
fn stored_classifications_the_evaluator_forbids_never_serve() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let seq = insert_subject(
        &store,
        "anchor",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'object-illegal-pair','fixture','domain-anchor','fixture','illegal-pair',1,1,
                 'normal'
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'illegal-pair-decision','object-illegal-pair','fixture','illegal-pair',1,
                 'untrusted_web','current_code','verified','verified','active','automatic','normal',1,
                 'fixture',1,1
             );
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'object-unknown-source','fixture','domain-anchor','fixture','unknown-source',1,1,
                 'normal'
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'unknown-source-decision','object-unknown-source','fixture','unknown-source',1,
                 'future_source','current_code','verified','verified','active','automatic','normal',1,
                 'fixture',1,1
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
        assert_eq!(
            store
                .visible_as_of(surface, seq)
                .unwrap()
                .rows
                .iter()
                .map(|row| row.object.object_id.clone())
                .collect::<Vec<_>>(),
            vec!["object-anchor".to_string()]
        );
    }
}

#[test]
fn newer_policy_revision_fails_closed_while_older_still_serves() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let older = insert_subject(
        &store,
        "older-revision",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    let newer = insert_subject(
        &store,
        "newer-revision",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "UPDATE admission_decisions SET policy_revision=0
             WHERE subject_object_id='object-older-revision';
             UPDATE admission_decisions SET policy_revision=2
             WHERE subject_object_id='object-newer-revision';",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    assert_eq!(
        store
            .visible_as_of(Surface::AutoInject, older)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.object.object_id.clone())
            .collect::<Vec<_>>(),
        vec!["object-older-revision".to_string()]
    );
    assert_eq!(
        store
            .visible_as_of(Surface::ExplicitSearch, newer)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.object.object_id.clone())
            .collect::<Vec<_>>(),
        vec!["object-older-revision".to_string()]
    );
}

#[test]
fn superseded_replacement_serves_only_after_its_own_decision() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "original");
    let admitted = store
        .commit(intent("original"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-original",
                "code_present",
                "domain-original",
                "repo",
                "source-original",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("original"),
                AdmissionDomainSpec {
                    domain_id: "domain-original".to_string(),
                    object_id: "object-original".to_string(),
                    name: "name-original".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    let replaced = store
        .commit(intent("replace"), |envelope| {
            envelope.supersede_domain(
                subject_request("object-original", EventKind::Replace),
                AdmissionDomainSpec {
                    domain_id: "domain-successor".to_string(),
                    object_id: "object-successor".to_string(),
                    name: "successor".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    let observed = store
        .commit(intent("observe-successor"), |envelope| {
            let mut request = subject_request("object-successor", EventKind::CodeObserved);
            request.event.trigger_object_id = Some("observation-original".to_string());
            envelope.record_admission(request)?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    assert!(store
        .visible_as_of(Surface::AutoInject, admitted)
        .unwrap()
        .rows
        .iter()
        .any(|row| row.object.object_id == "object-original"));
    assert!(store
        .visible_as_of(Surface::AutoInject, replaced)
        .unwrap()
        .rows
        .is_empty());
    assert!(store
        .visible_as_of(Surface::ExplicitSearch, replaced)
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        store
            .visible_as_of(Surface::AutoInject, observed)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.object.object_id.as_str())
            .collect::<Vec<_>>(),
        vec!["object-successor"]
    );
}

#[test]
fn governing_decision_sensitivity_hides_an_object_the_registry_calls_normal() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_from(&store, "plain", "mixed-source");
    let admitted = store
        .commit(intent("admit-plain"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-plain",
                "code_present",
                "domain-mixed",
                "repo",
                "mixed-source",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("plain"),
                AdmissionDomainSpec {
                    domain_id: "domain-mixed".to_string(),
                    object_id: "object-mixed".to_string(),
                    name: "name-plain".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-secret".to_string(),
            candidate_id: "secret".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "repo".to_string(),
            source_id: "mixed-source".to_string(),
            source_revision: 1,
            candidate_kind: "domain".to_string(),
            payload: "name-secret".to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: now,
            lease_expires_at: now + 60_000,
        })
        .unwrap();
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE candidates SET sensitivity_class='secret' WHERE candidate_id='secret'",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();
    let governed = store
        .commit(intent("observe-secret"), |envelope| {
            let mut request = request("secret");
            request.event.trigger_object_id = Some("observation-plain".to_string());
            envelope.record_admission(request)?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    // The registry row is still `normal`; only the governing decision is secret.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT sensitivity_class FROM object_registry WHERE object_id='object-mixed'"
        ),
        "normal"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT sensitivity_class FROM admission_decisions
             WHERE subject_object_id IS NULL AND source_id='mixed-source'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "secret"
    );
    assert!(store
        .visible_as_of(Surface::AutoInject, admitted)
        .unwrap()
        .rows
        .iter()
        .any(|row| row.object.object_id == "object-mixed"));
    for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
        assert!(
            store
                .visible_as_of(surface, governed)
                .unwrap()
                .rows
                .is_empty(),
            "a secret governing decision must hide the object it governs"
        );
    }
}

#[test]
fn decisions_bound_to_another_source_lineage_never_serve() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let seq = insert_subject(
        &store,
        "anchor",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // A decision naming the anchor object but a foreign source lineage must
    // neither govern it nor satisfy its own-decision gate.
    connection
        .execute_batch(
            "INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'alien-lineage-decision','object-anchor','fixture','not-the-anchor-source',9,
                 'trusted_local_code','current_code','enforced','enforced','active','automatic',
                 'normal',1,'fixture',1,1
             );
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'object-alien-only','fixture','domain-anchor','fixture','alien-only',1,1,'normal'
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'alien-only-decision','object-alien-only','fixture','some-other-source',1,
                 'trusted_local_code','current_code','verified','verified','active','automatic',
                 'normal',1,'fixture',1,1
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    // The anchor still serves from its own correctly-bound decision, and the
    // object whose only decision is foreign never serves at all.
    assert_eq!(
        store
            .visible_as_of(Surface::AutoInject, seq)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.object.object_id.clone())
            .collect::<Vec<_>>(),
        vec!["object-anchor".to_string()]
    );
}

#[test]
fn serving_reads_seek_source_decisions_by_lineage_not_by_null_subject() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    insert_subject(
        &store,
        "planned",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    // Without a lineage-ordered partial index SQLite seeks `subject_object_id IS
    // NULL` and then scans every source decision once per object.
    let mut statement = connection
        .prepare(
            "EXPLAIN QUERY PLAN
             SELECT a.admission_decision_id,a.commit_seq
             FROM admission_decisions a
             WHERE a.subject_object_id IS NULL
               AND a.source_kind=?1 AND a.source_id=?2 AND a.source_revision=?3
               AND a.commit_seq IS NOT NULL AND a.commit_seq<=?4",
        )
        .unwrap();
    let plan = statement
        .query_map(
            rusqlite::params!["fixture", "source-planned", 1_i64, 1_i64],
            |row| row.get::<_, String>(3),
        )
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();

    assert!(
        plan.iter()
            .any(|step| step.contains("idx_admission_source_latest")),
        "source-level lookup must seek the lineage index: {plan:?}"
    );
    assert!(
        !plan.iter().any(|step| step.contains("SCAN a")),
        "source-level lookup must not scan: {plan:?}"
    );
}
