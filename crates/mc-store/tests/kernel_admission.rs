#![cfg(feature = "test-support")]

use mc_store::kernel::{
    AdmissionDomainSpec, AdmissionEvent, AdmissionRequest, CommitIntent, DomainSpec, EventKind,
    KernelError, KernelStore, Maturity, RepositoryProvenance, Sensitivity, SourceClass,
    StagingCandidateSpec, StagingTerminalState, TaintClass,
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
    stage_in_run(
        store,
        &format!("run-{candidate_id}"),
        candidate_id,
        &format!("source-{candidate_id}"),
    );
}

fn stage_in_run(store: &KernelStore, run_id: &str, candidate_id: &str, source_id: &str) {
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: run_id.to_string(),
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
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'approval-admission','approval','fixture','approval',1,'explicit_user',
                 'user_explicit','approved','approved','active','automatic','admit','normal',
                 1,'fixture',1,1
             );",
        )
        .unwrap();
}

/// Seeds `approval-b`, an approval object whose own admission cites `approval`.
fn seed_dependent_approval(root: &std::path::Path) {
    let connection = Connection::open(root.join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'approval-b','decision','approval-domain','fixture','approval-b',1,1,'normal'
             );
             INSERT INTO decisions(
                 decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                 sensitivity_class
             ) VALUES ('approval-b-decision','approval-b','adr_accepted',X'7b7d',1,'normal');
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,approval_object_id,commit_seq,
                 decided_at
             ) VALUES (
                 'approval-b-admission','approval-b','fixture','approval-b',1,'explicit_user',
                 'user_explicit','approved','approved','active','automatic','admit','normal',
                 1,'fixture','approval',1,1
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
fn candidate_scoped_correction_and_replacement_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "corrected");
    for kind in [EventKind::Correct, EventKind::Replace] {
        let mut succession = request("corrected");
        succession.event.kind = kind;
        succession.event.trigger_object_id = None;
        let error = store
            .commit(intent(&format!("candidate-{kind:?}")), |envelope| {
                envelope.record_admission(succession.clone())?;
                Ok(String::new())
            })
            .unwrap_err();
        assert_eq!(error, KernelError::AdmissionPolicy, "{kind:?}");
    }
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
        0
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM change_event"),
        0
    );
}

#[test]
fn candidates_sharing_an_extraction_run_admit_independently() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_in_run(&store, "shared-run", "cand-a", "shared-source");
    stage_in_run(&store, "shared-run", "cand-b", "shared-source");
    for candidate in ["cand-a", "cand-b"] {
        let mut admit = request(candidate);
        admit.event.trigger_object_id = Some("observation-shared".to_string());
        let receipt = store
            .commit(intent(candidate), |envelope| {
                if candidate == "cand-a" {
                    envelope.insert_admission_observation_for_test(
                        "observation-shared",
                        "code_present",
                        "domain-cand-a",
                        "repo",
                        "shared-source",
                        1,
                    )?;
                }
                let decision = envelope.admit_domain_candidate(
                    admit.clone(),
                    AdmissionDomainSpec {
                        domain_id: format!("domain-{candidate}"),
                        object_id: format!("object-{candidate}"),
                        name: format!("name-{candidate}"),
                    },
                )?;
                Ok(decision.outcome.as_str().to_string())
            })
            .unwrap();
        assert_eq!(receipt.result, "admit", "{candidate}");
    }
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM domains"), 2);
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT candidate_kind FROM admission_decisions WHERE candidate_id='cand-a'"
        ),
        "domain"
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT length(candidate_payload_digest) FROM admission_decisions
             WHERE candidate_id='cand-a'"
        ),
        64
    );
}

#[test]
fn superseding_a_quarantined_predecessor_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "candidate");
    store
        .commit(intent("admit"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-candidate",
                "code_present",
                "domain",
                "repo",
                "source-candidate",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("candidate"),
                AdmissionDomainSpec {
                    domain_id: "domain".to_string(),
                    object_id: "object".to_string(),
                    name: "name-candidate".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("quarantine"), |envelope| {
            envelope.record_admission(subject_request("object", EventKind::Quarantine))?;
            Ok(String::new())
        })
        .unwrap();
    let succession = subject_request("object", EventKind::Correct);
    let error = store
        .commit(intent("supersede-quarantined"), |envelope| {
            envelope.supersede_domain(
                succession.clone(),
                AdmissionDomainSpec {
                    domain_id: "domain-v2".to_string(),
                    object_id: "object-v2".to_string(),
                    name: "laundered".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-v2'"
        ),
        0
    );
}

#[test]
fn same_envelope_subject_decision_after_admission_uses_the_recorded_prior() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "candidate");
    store
        .commit(intent("admit-then-decide"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-candidate",
                "code_present",
                "domain",
                "repo",
                "source-candidate",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("candidate"),
                AdmissionDomainSpec {
                    domain_id: "domain".to_string(),
                    object_id: "object".to_string(),
                    name: "name-candidate".to_string(),
                },
            )?;
            let decision = envelope
                .record_admission(subject_request("object", EventKind::MarkStale))?
                .unwrap();
            assert_eq!(decision.historical_maturity, Maturity::Verified);
            assert_eq!(decision.sensitivity, Sensitivity::Normal);
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='object' AND sensitivity_class='secret'"
        ),
        0
    );
}

#[test]
fn support_demoted_approval_loses_authorizing_power() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    let mut before = request("granted");
    before.source_class = Some(SourceClass::ModelInference);
    before.taint_class = Some(TaintClass::AssistantInference);
    before.event.kind = EventKind::Verify;
    before.event.trigger_object_id = None;
    before.event.approval_object_id = Some("approval-b".to_string());
    stage(&store, "granted");
    store
        .commit(intent("granted"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                before.clone(),
                AdmissionDomainSpec {
                    domain_id: "domain-granted".to_string(),
                    object_id: "object-granted".to_string(),
                    name: "name-granted".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "admit");
            Ok(String::new())
        })
        .unwrap();

    store
        .commit(intent("revoke-root"), |envelope| {
            envelope.revoke_approval("approval", "root authority withdrawn")?;
            Ok(String::new())
        })
        .unwrap();

    let mut after = request("orphaned");
    after.source_class = Some(SourceClass::ModelInference);
    after.taint_class = Some(TaintClass::AssistantInference);
    after.event.kind = EventKind::Verify;
    after.event.trigger_object_id = None;
    after.event.approval_object_id = Some("approval-b".to_string());
    stage(&store, "orphaned");
    store
        .commit(intent("orphaned"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                after.clone(),
                AdmissionDomainSpec {
                    domain_id: "domain-orphaned".to_string(),
                    object_id: "object-orphaned".to_string(),
                    name: "name-orphaned".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-orphaned'"
        ),
        0
    );
}

#[test]
fn approval_dependent_capacity_blocks_new_grants_and_keeps_revocation_possible() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    {
        let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let mut registry = connection
            .prepare(
                "INSERT INTO object_registry(
                     object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                     created_commit_seq,sensitivity_class
                 ) VALUES (?1,'domain','approval-domain','fixture',?1,1,1,'normal')",
            )
            .unwrap();
        let mut admission = connection
            .prepare(
                "INSERT INTO admission_decisions(
                     admission_decision_id,subject_object_id,source_kind,source_id,
                     source_revision,source_class,taint_class,maturity,effective_maturity,
                     disposition,visibility,outcome,sensitivity_class,policy_revision,reason,
                     approval_object_id,commit_seq,decided_at
                 ) VALUES (?1,?2,'fixture',?2,1,'model_inference','assistant_inference',
                           'verified','verified','active','explicit_labeled','promote',
                           'normal',1,'fixture','approval',1,1)",
            )
            .unwrap();
        for dependent in 0..1_024 {
            let subject = format!("dependent-{dependent:04}");
            registry.execute([subject.as_str()]).unwrap();
            admission
                .execute([
                    format!("admission-{dependent:04}").as_str(),
                    subject.as_str(),
                ])
                .unwrap();
        }
    }
    let store = KernelStore::open(directory.path()).unwrap();

    let mut blocked = request("overflow");
    blocked.source_class = Some(SourceClass::ModelInference);
    blocked.taint_class = Some(TaintClass::AssistantInference);
    blocked.event.kind = EventKind::Verify;
    blocked.event.trigger_object_id = None;
    blocked.event.approval_object_id = Some("approval".to_string());
    stage(&store, "overflow");
    let error = store
        .commit(intent("overflow"), |envelope| {
            envelope.admit_domain_candidate(
                blocked.clone(),
                AdmissionDomainSpec {
                    domain_id: "domain-overflow".to_string(),
                    object_id: "object-overflow".to_string(),
                    name: "name-overflow".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);

    // A dependent whose latest decision no longer cites the approval releases its
    // slot, so obsolete ledger history cannot exhaust a live approval forever.
    drop(store);
    {
        let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        connection
            .execute(
                "INSERT INTO admission_decisions(
                     admission_decision_id,subject_object_id,source_kind,source_id,
                     source_revision,source_class,taint_class,maturity,effective_maturity,
                     disposition,visibility,outcome,sensitivity_class,policy_revision,reason,
                     commit_seq,decided_at
                 ) VALUES ('admission-0000-moved','dependent-0000','fixture','dependent-0000',
                           1,'model_inference','assistant_inference','verified','verified',
                           'active','explicit_labeled','promote','normal',1,'moved on',1,2)",
                [],
            )
            .unwrap();
    }
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("overflow-after-release"), |envelope| {
            envelope.admit_domain_candidate(
                blocked,
                AdmissionDomainSpec {
                    domain_id: "domain-overflow".to_string(),
                    object_id: "object-overflow".to_string(),
                    name: "name-overflow".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();

    store
        .commit(intent("revoke-at-capacity"), |envelope| {
            let decisions = envelope.revoke_approval("approval", "withdrawn at capacity")?;
            assert_eq!(decisions.len(), 1_024);
            Ok(String::new())
        })
        .unwrap();
}

#[test]
fn ledger_rows_from_another_policy_revision_are_refused() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "candidate");
    store
        .commit(intent("admit"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-candidate",
                "code_present",
                "domain",
                "repo",
                "source-candidate",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("candidate"),
                AdmissionDomainSpec {
                    domain_id: "domain".to_string(),
                    object_id: "object".to_string(),
                    name: "name-candidate".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    drop(store);
    Connection::open(directory.path().join("core.sqlite"))
        .unwrap()
        .execute("UPDATE admission_decisions SET policy_revision=2", [])
        .unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let error = store
        .commit(intent("cross-revision"), |envelope| {
            envelope.record_admission(subject_request("object", EventKind::MarkStale))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
}

#[test]
fn unknown_ledger_vocabulary_is_refused_not_defaulted() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "candidate");
    store
        .commit(intent("admit"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-candidate",
                "code_present",
                "domain",
                "repo",
                "source-candidate",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("candidate"),
                AdmissionDomainSpec {
                    domain_id: "domain".to_string(),
                    object_id: "object".to_string(),
                    name: "name-candidate".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    drop(store);
    Connection::open(directory.path().join("core.sqlite"))
        .unwrap()
        .execute(
            "UPDATE admission_decisions SET sensitivity_class='mystery'",
            [],
        )
        .unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let error = store
        .commit(intent("unknown-vocabulary"), |envelope| {
            envelope.record_admission(subject_request("object", EventKind::MarkStale))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
}

/// Stages `candidate_id` and registers `kind` observation for its source at `revision`.
fn stage_with_observation(
    store: &KernelStore,
    candidate_id: &str,
    kind: &str,
    revision: i64,
    key: &str,
) {
    stage(store, candidate_id);
    store
        .commit(intent(key), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: format!("trigger-{candidate_id}"),
                object_id: format!("trigger-object-{candidate_id}"),
                name: format!("trigger {candidate_id}"),
                source_kind: "fixture".to_string(),
                source_id: format!("trigger-{candidate_id}"),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            envelope.insert_admission_observation_for_test(
                &format!("observation-{candidate_id}"),
                kind,
                &format!("trigger-{candidate_id}"),
                "repo",
                &format!("source-{candidate_id}"),
                revision,
            )?;
            Ok(String::new())
        })
        .unwrap();
}

fn admit(store: &KernelStore, request: AdmissionRequest, candidate_id: &str, key: &str) -> String {
    let outcome = std::cell::RefCell::new(String::new());
    store
        .commit(intent(key), |envelope| {
            let decision = envelope.admit_domain_candidate(
                request.clone(),
                AdmissionDomainSpec {
                    domain_id: format!("domain-{candidate_id}"),
                    object_id: format!("object-{candidate_id}"),
                    name: format!("name-{candidate_id}"),
                },
            )?;
            *outcome.borrow_mut() = decision.outcome.as_str().to_string();
            Ok(String::new())
        })
        .unwrap();
    outcome.into_inner()
}

#[test]
fn a_config_observation_authorizes_only_a_config_event() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "config", "config_present", 1, "config-trigger");

    // A `CodeObserved` event demands `code_present`, so a config observation cannot carry it.
    let mut mismatched = request("config");
    mismatched.taint_class = Some(TaintClass::CurrentConfig);
    assert_eq!(
        admit(&store, mismatched, "config", "config-as-code"),
        "deny"
    );

    let mut matched = request("config");
    matched.taint_class = Some(TaintClass::CurrentConfig);
    matched.event.kind = EventKind::ConfigObserved;
    assert_eq!(
        admit(&store, matched, "config", "config-as-config"),
        "promote"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='object-config'"
        ),
        "verified"
    );
}

#[test]
fn an_observation_at_another_source_revision_cannot_authorize() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    // `stage` pins the candidate at revision 1; the observation records revision 2.
    stage_with_observation(&store, "skewed", "code_present", 2, "skewed-trigger");
    assert_eq!(admit(&store, request("skewed"), "skewed", "skewed"), "deny");
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-skewed'"
        ),
        0
    );
}

#[test]
fn an_invalidated_observation_cannot_authorize() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "stale-obs", "code_present", 1, "stale-obs-trigger");
    // `invalidated_commit_seq` must reference a commit later than the observation's own.
    store
        .commit(intent("stale-obs-later-commit"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "later".to_string(),
                object_id: "later-object".to_string(),
                name: "later".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "later".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE observations
             SET invalidated_commit_seq=(SELECT MAX(commit_seq) FROM commit_log)
             WHERE observation_id='observation-stale-obs'",
            [],
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        admit(&store, request("stale-obs"), "stale-obs", "stale-obs"),
        "deny"
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM domains WHERE domain_id='domain-stale-obs'"
        ),
        0
    );
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}

/// `abandoned` is reached only by the lease sweep, so it has no `StagingTerminalState`.
#[derive(Debug, Clone, Copy)]
enum RunEnd {
    Terminal(StagingTerminalState),
    LeaseExpiry,
}

#[test]
fn a_candidate_from_a_terminated_run_cannot_reach_canonical_state() {
    for end in [
        RunEnd::Terminal(StagingTerminalState::Failed),
        RunEnd::Terminal(StagingTerminalState::Canceled),
        RunEnd::LeaseExpiry,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        stage_with_observation(&store, "doomed", "code_present", 1, "doomed-trigger");
        match end {
            RunEnd::Terminal(terminal) => {
                store
                    .finish_staging_run("run-doomed", terminal, now_ms() + 1_000)
                    .unwrap();
            }
            RunEnd::LeaseExpiry => {
                assert_eq!(
                    store
                        .abandon_expired_staging_runs(now_ms() + 120_000)
                        .unwrap(),
                    1
                );
            }
        }

        let error = store
            .commit(intent("doomed"), |envelope| {
                envelope.admit_domain_candidate(
                    request("doomed"),
                    AdmissionDomainSpec {
                        domain_id: "domain-doomed".to_string(),
                        object_id: "object-doomed".to_string(),
                        name: "name-doomed".to_string(),
                    },
                )?;
                Ok(String::new())
            })
            .unwrap_err();
        assert!(matches!(error, KernelError::NotFound), "{end:?}");
        assert_eq!(
            inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
            0,
            "{end:?}"
        );
    }
}

#[test]
fn an_approval_from_another_policy_revision_cannot_authorize() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE admission_decisions SET policy_revision=2
             WHERE admission_decision_id='approval-admission'",
            [],
        )
        .unwrap();
    drop(connection);

    stage(&store, "revision-skew");
    let mut approved = request("revision-skew");
    approved.event.kind = EventKind::Approve;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    assert_eq!(
        admit(&store, approved, "revision-skew", "revision-skew"),
        "deny"
    );
}

#[test]
fn revoking_an_approval_demotes_a_candidate_promoted_before_materialization() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "early", "code_present", 1, "early-trigger");

    // The approval promotes the candidate while it is still unmaterialized, so the
    // ledger row carries `candidate_id` and no `subject_object_id`.
    let mut approved = request("early");
    approved.event.kind = EventKind::Approve;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("promote-early"), |envelope| {
            let decision = envelope.record_admission(approved)?.unwrap();
            assert_eq!(decision.effective_maturity, Maturity::Approved);
            Ok(String::new())
        })
        .unwrap();

    store
        .commit(intent("revoke-early"), |envelope| {
            envelope.revoke_approval("approval", "authority withdrawn")?;
            Ok(String::new())
        })
        .unwrap();

    // Materialization after revocation keeps the historical rung but cannot
    // publish support the revoked approval no longer grants.
    store
        .commit(intent("materialize-early"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                request("early"),
                AdmissionDomainSpec {
                    domain_id: "domain-early".to_string(),
                    object_id: "object-early".to_string(),
                    name: "name-early".to_string(),
                },
            )?;
            assert_eq!(decision.historical_maturity, Maturity::Approved);
            assert_eq!(decision.effective_maturity, Maturity::Verified);
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='object-early'"
        ),
        "verified"
    );
}

#[test]
fn an_admission_event_carries_the_subject_it_changed() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "traced", "code_present", 1, "traced-trigger");
    assert_eq!(
        admit(&store, request("traced"), "traced", "traced"),
        "admit"
    );

    // `change_event` records the projector payload; `outbox` carries the same bytes.
    for table in ["change_event", "outbox"] {
        let payload = inspect_text(
            directory.path(),
            &format!(
                "SELECT CAST(payload AS TEXT) FROM {table}
                 WHERE CAST(payload AS TEXT) LIKE '%\"admission_decision\"%'"
            ),
        );
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let audit = &payload["audit"];
        assert_eq!(audit["subject_object_id"], "object-traced", "{table}");
        assert_eq!(audit["candidate_id"], "traced", "{table}");
        assert_eq!(audit["source_class"], "trusted_local_code", "{table}");
    }
}

#[test]
fn a_caller_cannot_manufacture_an_approval_revocation() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "victim", "code_present", 1, "victim-trigger");
    assert_eq!(
        admit(&store, request("victim"), "victim", "victim"),
        "admit"
    );

    let error = store
        .commit(intent("forged-revocation"), |envelope| {
            envelope
                .record_admission(subject_request("object-victim", EventKind::ApprovalRevoked))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-victim'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "automatic"
    );
}

#[test]
fn quarantining_an_approval_demotes_its_dependents() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "dependent");
    let mut promoted = request("dependent");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "dependent", "promote"), "admit");
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-dependent'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "automatic"
    );

    // Quarantining the approval breaks its authority, so the dependent cannot keep
    // the automatic visibility that authority bought.
    store
        .commit(intent("quarantine-approval"), |envelope| {
            let mut quarantine = subject_request("approval", EventKind::Quarantine);
            quarantine.source_class = Some(SourceClass::ExplicitUser);
            quarantine.taint_class = Some(TaintClass::UserExplicit);
            envelope.record_admission(quarantine)?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-dependent'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "explicit_labeled"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT outcome FROM admission_decisions
             WHERE subject_object_id='object-dependent'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "demote_support"
    );
}

#[test]
fn revocation_cascades_through_dependent_approvals() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    // `approval-b` is itself an approval whose authority descends from `approval`.
    stage(&store, "grandchild");
    let mut promoted = request("grandchild");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval-b".to_string());
    assert_eq!(admit(&store, promoted, "grandchild", "promote"), "admit");
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-grandchild'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "automatic"
    );

    // Revoking the root must reach the grandchild, not stop at `approval-b`.
    store
        .commit(intent("revoke-root"), |envelope| {
            let decisions = envelope.revoke_approval("approval", "root authority withdrawn")?;
            assert!(decisions.len() >= 2, "{decisions:?}");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-grandchild'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "explicit_labeled"
    );
}

#[test]
fn a_refused_decision_does_not_consume_approval_capacity() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "refused");

    // `missing-approval` never validates, so the decision is refused and must be
    // retained in the audit rather than rolled back by the dependent cap.
    let mut refused = request("refused");
    refused.source_class = Some(SourceClass::ModelInference);
    refused.taint_class = Some(TaintClass::AssistantInference);
    refused.event.kind = EventKind::Verify;
    refused.event.trigger_object_id = None;
    refused.event.approval_object_id = Some("approval-domain-object".to_string());
    store
        .commit(intent("refused"), |envelope| {
            let decision = envelope.record_admission(refused)?.unwrap();
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE candidate_id='refused' AND outcome='deny'"
        ),
        1
    );
}

#[test]
fn a_revocation_reason_survives_without_dependents() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("revoke-unused"), |envelope| {
            let decisions = envelope.revoke_approval("approval", "superseded by policy review")?;
            assert!(decisions.is_empty());
            Ok(String::new())
        })
        .unwrap();

    let payload = inspect_text(
        directory.path(),
        "SELECT CAST(payload AS TEXT) FROM change_event WHERE change_kind='approval_revoke'",
    );
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        payload["audit"]["approval_object_id"], "approval",
        "{payload}"
    );
    // The fan-out outcome is reported on the approval's own change, so a truncated
    // walk is observable rather than silent.
    assert_eq!(payload["audit"]["demoted"], 0, "{payload}");
    assert_eq!(payload["audit"]["truncated"], false, "{payload}");
    assert!(
        payload.to_string().contains("superseded by policy review"),
        "{payload}"
    );
}

#[test]
fn a_candidate_materializes_at_most_one_canonical_object() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "once", "code_present", 1, "once-trigger");
    assert_eq!(admit(&store, request("once"), "once", "once"), "admit");

    // The second admission is not a no-op: the first stored `admit` while an
    // identical request now evaluates to `promote`.
    let error = store
        .commit(intent("once-again"), |envelope| {
            envelope.admit_domain_candidate(
                request("once"),
                AdmissionDomainSpec {
                    domain_id: "domain-once-again".to_string(),
                    object_id: "object-once-again".to_string(),
                    name: "name-once".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-once-again'"
        ),
        0
    );
}

#[test]
fn a_bogus_citation_cannot_demote_a_validly_supported_subject() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "supported");
    let mut promoted = request("supported");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "supported", "promote"), "admit");

    // The subject's own approval is untouched, so citing an unrelated object must
    // not clamp its support.
    store
        .commit(intent("bogus-citation"), |envelope| {
            let mut forged = subject_request("object-supported", EventKind::Other);
            forged.source_class = Some(SourceClass::ModelInference);
            forged.taint_class = Some(TaintClass::AssistantInference);
            forged.event.approval_object_id = Some("approval-domain-object".to_string());
            envelope.record_admission(forged)?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='object-supported'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-supported'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "automatic"
    );
}

#[test]
fn only_an_accepted_decision_object_self_approves() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    // `approval-domain-object` is a domain, not an `adr_accepted` decision, so the
    // automatic root exception must not apply to it.
    store
        .commit(intent("impostor-adr"), |envelope| {
            let mut impostor = subject_request("approval-domain-object", EventKind::AcceptedAdr);
            impostor.source_class = Some(SourceClass::ExplicitUser);
            impostor.taint_class = Some(TaintClass::UserExplicit);
            let decision = envelope.record_admission(impostor)?.unwrap();
            assert_eq!(decision.outcome.as_str(), "deny");
            assert_ne!(decision.effective_maturity, Maturity::Approved);
            Ok(String::new())
        })
        .unwrap();
}

#[test]
fn a_successful_resubmission_with_new_evidence_is_recorded() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "evidenced", "code_present", 1, "evidenced-trigger");
    assert_eq!(
        admit(&store, request("evidenced"), "evidenced", "evidenced"),
        "admit"
    );
    let before = inspect(
        directory.path(),
        "SELECT COUNT(*) FROM admission_decisions WHERE subject_object_id='object-evidenced'",
    );

    // Re-observing with evidence attached carries information the resulting state
    // does not encode, so it must not fold into a replay.
    {
        let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 INSERT INTO object_registry(
                     object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                     created_commit_seq,sensitivity_class
                 ) VALUES (
                     'evidence-object','evidence','trigger-evidenced','repo','evidence',1,1,
                     'normal'
                 );
                 INSERT INTO evidence_meta(
                     evidence_id,object_id,artifact_reference,artifact_digest,byte_length,
                     media_type,retention_class,provider_egress_class,redaction_metadata,
                     created_commit_seq,sensitivity_class
                 ) VALUES (
                     'evidence-1','evidence-object','local','digest',1,'text/plain','durable',
                     'local',X'',1,'normal'
                 );",
            )
            .unwrap();
    }
    store
        .commit(intent("more-evidence"), |envelope| {
            let mut again = subject_request("object-evidenced", EventKind::CodeObserved);
            again.event.trigger_object_id = Some("observation-evidenced".to_string());
            again.event.evidence_id = Some("evidence-1".to_string());
            assert!(envelope.record_admission(again)?.is_some());
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions WHERE subject_object_id='object-evidenced'"
        ),
        before + 1
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='object-evidenced' AND evidence_id='evidence-1'"
        ),
        1
    );
}
