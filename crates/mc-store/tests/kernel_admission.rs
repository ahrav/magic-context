#![cfg(feature = "test-support")]

use mc_store::kernel::{
    AdmissionDomainSpec, AdmissionEvent, AdmissionRequest, CommitIntent, DomainSpec, EventKind,
    KernelError, KernelStore, Maturity, RepositoryProvenance, Sensitivity, SourceClass,
    StagingCandidateSpec, StagingTerminalState, Surface, TaintClass, STAGING_RETENTION_MS,
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,elevated_support,commit_seq,
                 decided_at
             ) VALUES (
                 'approval-admission','approval','fixture','approval',1,'explicit_user',
                 'user_explicit','accepted_adr','approved','approved','active','automatic',
                 'admit','normal',1,'fixture',1,1,1
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,approval_object_id,
                 elevated_support,commit_seq,decided_at
             ) VALUES (
                 'approval-b-admission','approval-b','fixture','approval-b',1,'explicit_user',
                 'user_explicit','approve','approved','approved','active','automatic','admit',
                 'normal',1,'fixture','approval',1,1,1
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
fn duplicate_rejection_appends_and_keeps_the_first_audit_row() {
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
            envelope.record_admission(rejected.clone())?;
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
            envelope.record_admission(rejected)?;
            Ok(String::new())
        })
        .unwrap();
    // The second rejection is a distinct attempt and gets its own row, but the
    // first row is immutable.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT json_array(
                 admission_decision_id,candidate_id,subject_object_id,source_kind,source_id,
                 source_revision,source_class,taint_class,maturity,disposition,visibility,
                 policy_revision,reason,evidence_id,approval_object_id,commit_seq,decided_at
             ) FROM admission_decisions
             ORDER BY commit_seq,admission_decision_id LIMIT 1"
        ),
        original
    );

    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
        2
    );
    assert_eq!(
        inspect(directory.path(), "SELECT COUNT(*) FROM change_event"),
        2
    );
    assert_eq!(inspect(directory.path(), "SELECT COUNT(*) FROM outbox"), 2);
    // Both rows describe the same rejected state.
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE disposition='rejected' AND outcome='reject'"
        ),
        2
    );
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
            let decision = envelope.record_admission(later)?;
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
                let decision =
                    envelope.record_admission(subject_request("ordinal-object", event))?;
                assert_eq!(decision.admission_decision_id, format!("2:{ordinal:020}"));
            }
            let repeated = envelope
                .record_admission(subject_request("ordinal-object", EventKind::MarkStale))?;
            assert_eq!(
                repeated.admission_decision_id,
                format!("2:{:020}", 11),
                "a repeated event still consumes an ordinal"
            );
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("ordinal-latest"), |envelope| {
            let decision = envelope
                .record_admission(subject_request("ordinal-object", EventKind::MarkStale))?;
            assert_eq!(decision.admission_decision_id, "3:00000000000000000000");
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
            let decision =
                envelope.record_admission(subject_request("object", EventKind::MarkStale))?;
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
                     source_revision,source_class,taint_class,event_kind,maturity,effective_maturity,
                     disposition,visibility,outcome,sensitivity_class,policy_revision,reason,
                     approval_object_id,elevated_support,commit_seq,decided_at
                 ) VALUES (?1,?2,'fixture',?2,1,'model_inference','assistant_inference',
                           'verify','verified','verified','active','explicit_labeled','promote',
                           'normal',1,'fixture','approval',1,1,1)",
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
                     source_revision,source_class,taint_class,event_kind,maturity,effective_maturity,
                     disposition,visibility,outcome,sensitivity_class,policy_revision,reason,
                     elevated_support,commit_seq,decided_at
                 ) VALUES ('admission-0000-moved','dependent-0000','fixture','dependent-0000',
                           1,'model_inference','assistant_inference','verify','verified',
                           'verified','active','explicit_labeled','promote','normal',1,
                           'moved on',0,1,2)",
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
            let decision = envelope.record_admission(approved)?;
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
            let decision = envelope.record_admission(refused)?;
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
    // The fan-out outcome is reported on the approval's own change, so demotions it
    // could not perform are observable rather than silent.
    assert_eq!(payload["audit"]["demoted"], 0, "{payload}");
    assert_eq!(payload["audit"]["deferred"], 0, "{payload}");
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
            let decision = envelope.record_admission(impostor)?;
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
            envelope.record_admission(again)?;
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

#[test]
fn an_invalid_citation_does_not_replace_the_supporting_approval() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "carried");
    let mut promoted = request("carried");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "carried", "promote"), "admit");

    // A non-raising request citing an invalid approval must not record it as the
    // supporting authority, or the next uncited request inherits it and demotes.
    store
        .commit(intent("bogus-citation"), |envelope| {
            let mut forged = subject_request("object-carried", EventKind::Other);
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
            "SELECT approval_object_id FROM admission_decisions
             WHERE subject_object_id='object-carried'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "approval"
    );

    // The delayed poisoning path: an uncited follow-up must still see valid support.
    store
        .commit(intent("uncited-followup"), |envelope| {
            let mut followup = subject_request("object-carried", EventKind::Other);
            followup.source_class = Some(SourceClass::ModelInference);
            followup.taint_class = Some(TaintClass::AssistantInference);
            envelope.record_admission(followup)?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='object-carried'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );
}

#[test]
fn the_requested_event_kind_reaches_the_ledger_and_the_payload() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "kinded", "config_present", 1, "kinded-trigger");
    let mut config = request("kinded");
    config.taint_class = Some(TaintClass::CurrentConfig);
    config.event.kind = EventKind::ConfigObserved;
    assert_eq!(admit(&store, config, "kinded", "kinded"), "admit");

    // `CodeObserved`, `ConfigObserved`, and `Verify` all resolve to the same state,
    // so the outcome alone cannot identify which request produced the row.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT event_kind FROM admission_decisions
             WHERE subject_object_id='object-kinded'"
        ),
        "config_observed"
    );
    let payload = inspect_text(
        directory.path(),
        "SELECT CAST(payload AS TEXT) FROM change_event
         WHERE CAST(payload AS TEXT) LIKE '%\"admission_decision\"%'",
    );
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        payload["audit"]["event_kind"], "config_observed",
        "{payload}"
    );
}

#[test]
fn a_revoked_root_leaves_no_dependent_approval_able_to_grant() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("revoke-root"), |envelope| {
            envelope.revoke_approval("approval", "root authority withdrawn")?;
            Ok(String::new())
        })
        .unwrap();

    // `approval-b` held authority under `approval`. After revoking the root it must
    // no longer be able to promote anything, since `validate_approval` reads only
    // its own latest row.
    stage(&store, "post-revoke");
    let mut attempted = request("post-revoke");
    attempted.source_class = Some(SourceClass::ModelInference);
    attempted.taint_class = Some(TaintClass::AssistantInference);
    attempted.event.kind = EventKind::Verify;
    attempted.event.trigger_object_id = None;
    attempted.event.approval_object_id = Some("approval-b".to_string());
    assert_eq!(
        admit(&store, attempted, "post-revoke", "post-revoke"),
        "deny"
    );
}

#[test]
fn a_materialization_binding_survives_staging_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "reused", "code_present", 1, "reused-trigger");
    assert_eq!(
        admit(&store, request("reused"), "reused", "reused"),
        "admit"
    );

    // Retire the run and sweep it past the retention cutoff. `candidate_id` carries
    // ON DELETE SET NULL, so the sweep erases it from the historical decision.
    let terminal_at = now_ms() + 1_000;
    store
        .finish_staging_run("run-reused", StagingTerminalState::Completed, terminal_at)
        .unwrap();
    let mut swept = 0;
    while store
        .delete_aged_staging_runs(terminal_at + STAGING_RETENTION_MS)
        .unwrap()
        > 0
    {
        swept += 1;
        assert!(swept < 10, "the sweep should converge");
    }
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions WHERE candidate_id IS NULL"
        ),
        1,
        "the sweep must have cleared candidate_id"
    );

    // Re-staging the same candidate id must not mint a second canonical object.
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    let now = now_ms();
    connection
        .execute(
            "INSERT INTO extraction_runs(
                 extraction_run_id,extractor,source_kind,source_id,source_revision,
                 sensitivity_class,provenance_witness,redaction_metadata,started_at,
                 heartbeat_at,lease_expires_at
             ) VALUES ('run-reused-2','fixture','repo','source-reused',1,'normal',
                       ?1,X'7b7d',?2,?2,?3)",
            rusqlite::params![
                br#"{"kind":"repository","repository_id":"repo","revision":"abc123"}"#.to_vec(),
                now,
                now + 600_000
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO candidates(
                 candidate_id,extraction_run_id,candidate_kind,payload,sensitivity_class,
                 provenance_witness,redaction_metadata,created_at,heartbeat_at,lease_expires_at
             ) VALUES ('reused','run-reused-2','domain',?1,'normal',?2,X'7b7d',?3,?3,?4)",
            rusqlite::params![
                b"name-reused".to_vec(),
                br#"{"kind":"repository","repository_id":"repo","revision":"abc123"}"#.to_vec(),
                now,
                now + 600_000
            ],
        )
        .unwrap();
    drop(connection);

    let error = store
        .commit(intent("reused-again"), |envelope| {
            envelope.admit_domain_candidate(
                request("reused"),
                AdmissionDomainSpec {
                    domain_id: "domain-reused-again".to_string(),
                    object_id: "object-reused-again".to_string(),
                    name: "name-reused".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-reused-again'"
        ),
        0
    );
}

#[test]
fn revocation_survives_a_dependent_on_a_superseded_policy_revision() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "legacy");
    let mut promoted = request("legacy");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "legacy", "legacy"), "admit");

    // Age the dependent's latest decision into a superseded policy revision. It can
    // no longer be re-evaluated, and must not make the approval unrevokeable.
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE admission_decisions SET policy_revision=policy_revision+1
             WHERE subject_object_id='object-legacy'",
            [],
        )
        .unwrap();
    drop(connection);

    store
        .commit(intent("revoke-with-legacy"), |envelope| {
            let decisions = envelope.revoke_approval("approval", "withdrawn")?;
            assert!(decisions.is_empty(), "{decisions:?}");
            Ok(String::new())
        })
        .unwrap();

    // The root invalidation stands, so the approval cannot authorize anything more.
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry
             WHERE object_id='approval' AND invalidated_commit_seq IS NOT NULL"
        ),
        1
    );
    let payload = inspect_text(
        directory.path(),
        "SELECT CAST(payload AS TEXT) FROM change_event WHERE change_kind='approval_revoke'",
    );
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["audit"]["deferred"], 1, "{payload}");
}

#[test]
fn an_unvisited_descendant_of_a_revoked_root_grants_nothing() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    stage(&store, "orphan");
    // `invalidated_commit_seq` must exceed the approval's own, so advance the log.
    store
        .commit(intent("orphan-advance-log"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "orphan-advance".to_string(),
                object_id: "orphan-advance-object".to_string(),
                name: "orphan advance".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "orphan-advance".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    // Invalidate the root directly, so no fan-out runs at all. Authority is derived
    // from the chain, so `approval-b` must lose its grant regardless.
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "UPDATE object_registry
             SET invalidated_commit_seq=(SELECT MAX(commit_seq) FROM commit_log)
             WHERE object_id='approval';",
        )
        .unwrap();
    drop(connection);

    let mut attempted = request("orphan");
    attempted.source_class = Some(SourceClass::ModelInference);
    attempted.taint_class = Some(TaintClass::AssistantInference);
    attempted.event.kind = EventKind::Verify;
    attempted.event.trigger_object_id = None;
    attempted.event.approval_object_id = Some("approval-b".to_string());
    assert_eq!(admit(&store, attempted, "orphan", "orphan"), "deny");
}

#[test]
fn the_durable_candidate_binding_lookup_is_indexed() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "planned", "code_present", 1, "planned-trigger");
    assert_eq!(
        admit(&store, request("planned"), "planned", "planned"),
        "admit"
    );

    // The ledger is append-only, so this lookup must not degrade to a scan as it grows.
    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut statement = connection
        .prepare(
            "EXPLAIN QUERY PLAN
             SELECT 1 FROM admission_decisions
             WHERE candidate_ref='planned' AND subject_object_id IS NOT NULL
               AND commit_seq IS NOT NULL",
        )
        .unwrap();
    let plan = statement
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join(" | ");
    assert!(
        plan.contains("idx_admission_candidate_ref"),
        "expected the candidate_ref index, planner chose: {plan}"
    );
}

#[test]
fn materialization_refuses_internal_and_succession_events() {
    for kind in [
        EventKind::ApprovalRevoked,
        EventKind::Correct,
        EventKind::Replace,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = KernelStore::open(directory.path()).unwrap();
        stage(&store, "internal");
        let mut forged = request("internal");
        forged.event.kind = kind;
        forged.event.trigger_object_id = None;

        let error = store
            .commit(intent("internal"), |envelope| {
                envelope.admit_domain_candidate(
                    forged.clone(),
                    AdmissionDomainSpec {
                        domain_id: "domain-internal".to_string(),
                        object_id: "object-internal".to_string(),
                        name: "name-internal".to_string(),
                    },
                )?;
                Ok(String::new())
            })
            .unwrap_err();
        assert_eq!(error, KernelError::AdmissionPolicy, "{kind:?}");
        assert_eq!(
            inspect(directory.path(), "SELECT COUNT(*) FROM domains"),
            0,
            "{kind:?}"
        );
        assert_eq!(
            inspect(directory.path(), "SELECT COUNT(*) FROM admission_decisions"),
            0,
            "{kind:?}"
        );
    }
}

#[test]
fn quarantining_a_supported_subject_records_a_quarantine_not_a_demotion() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "supported-q");
    let mut promoted = request("supported-q");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "supported-q", "promote"), "admit");

    store
        .commit(intent("quarantine-supported"), |envelope| {
            let mut quarantine = subject_request("object-supported-q", EventKind::Quarantine);
            quarantine.source_class = Some(SourceClass::ModelInference);
            quarantine.taint_class = Some(TaintClass::AssistantInference);
            quarantine.event.approval_object_id = Some("approval".to_string());
            let decision = envelope.record_admission(quarantine)?;
            assert_eq!(decision.disposition.as_str(), "quarantined");
            assert_eq!(decision.outcome.as_str(), "quarantine");
            Ok(String::new())
        })
        .unwrap();

    // The immutable ledger row and the projector payload must agree with it.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT outcome FROM admission_decisions
             WHERE subject_object_id='object-supported-q'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "quarantine"
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM change_event WHERE change_kind='quarantine'"
        ),
        1
    );
}

/// `LATEST_SUBJECT_DECISION_PREDICATE` and `load_prior_decision`'s ordered seek are
/// two formulations of "latest decision for a subject". They must agree, including on
/// the tie-break between rows sharing a `commit_seq`, or a stale prior could drive one
/// path while the other reads the current row.
#[test]
fn both_latest_decision_formulations_choose_the_same_row() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    // Several decisions for one subject, including two in one commit so the
    // admission_decision_id tie-break is exercised rather than just commit_seq.
    stage(&store, "tied");
    let mut promoted = request("tied");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "tied", "tied"), "admit");
    store
        .commit(intent("tied-pair"), |envelope| {
            for kind in [EventKind::MarkStale, EventKind::MarkDisputed] {
                let mut event = subject_request("object-tied", kind);
                event.source_class = Some(SourceClass::ModelInference);
                event.taint_class = Some(TaintClass::AssistantInference);
                event.event.approval_object_id = Some("approval".to_string());
                envelope.record_admission(event)?;
            }
            Ok(String::new())
        })
        .unwrap();

    let connection = Connection::open_with_flags(
        directory.path().join("core.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let by_predicate: String = connection
        .query_row(
            "SELECT a.admission_decision_id FROM admission_decisions a
             WHERE a.subject_object_id='object-tied' AND a.commit_seq IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM admission_decisions newer
                   WHERE newer.subject_object_id=a.subject_object_id
                     AND newer.commit_seq IS NOT NULL
                     AND (
                         newer.commit_seq>a.commit_seq
                         OR (
                             newer.commit_seq=a.commit_seq
                             AND newer.admission_decision_id>a.admission_decision_id
                         )
                     )
               )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let by_seek: String = connection
        .query_row(
            "SELECT admission_decision_id FROM admission_decisions
             WHERE subject_object_id='object-tied' AND commit_seq IS NOT NULL
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(by_predicate, by_seek);

    // The predicate must also select exactly one row, not merely agree on one.
    let matched: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM admission_decisions a
             WHERE a.subject_object_id='object-tied' AND a.commit_seq IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM admission_decisions newer
                   WHERE newer.subject_object_id=a.subject_object_id
                     AND newer.commit_seq IS NOT NULL
                     AND (
                         newer.commit_seq>a.commit_seq
                         OR (
                             newer.commit_seq=a.commit_seq
                             AND newer.admission_decision_id>a.admission_decision_id
                         )
                     )
               )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(matched, 1);
}

#[test]
fn a_materialized_candidate_cannot_receive_candidate_keyed_decisions() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "bound", "code_present", 1, "bound-trigger");
    assert_eq!(admit(&store, request("bound"), "bound", "bound"), "admit");

    // Decisions for a materialized candidate belong to its object; a candidate-keyed
    // one would be invisible to that object's chain.
    let error = store
        .commit(intent("bound-orphan"), |envelope| {
            let mut orphaned = request("bound");
            orphaned.event.kind = EventKind::Corroborate;
            orphaned.event.trigger_object_id = None;
            envelope.record_admission(orphaned)?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::AdmissionPolicy);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions WHERE subject_object_id IS NULL"
        ),
        0
    );
}

#[test]
fn an_inert_citation_does_not_consume_approval_capacity() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    // A subject at candidate maturity citing a valid approval derives nothing from
    // it, so the audit row must not hold a dependent slot.
    store
        .commit(intent("inert-citation"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "inert".to_string(),
                object_id: "inert-object".to_string(),
                name: "inert".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "inert".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            let mut inert = subject_request("inert-object", EventKind::Other);
            inert.source_class = Some(SourceClass::ModelInference);
            inert.taint_class = Some(TaintClass::AssistantInference);
            inert.event.approval_object_id = Some("approval".to_string());
            let decision = envelope.record_admission(inert)?;
            assert_eq!(decision.effective_maturity, Maturity::Candidate);
            Ok(String::new())
        })
        .unwrap();

    // `approval_object_id` names the approval that supports the decision, so a
    // citation that supplied nothing does not occupy it.
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE subject_object_id='inert-object' AND approval_object_id IS NULL"
        ),
        1
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT elevated_support FROM admission_decisions
             WHERE subject_object_id='inert-object'"
        ),
        0
    );
    // What the caller cited is still attributable, from the event payload.
    let payload = inspect_text(
        directory.path(),
        "SELECT CAST(payload AS TEXT) FROM change_event
         WHERE CAST(payload AS TEXT) LIKE '%inert-object%'
           AND CAST(payload AS TEXT) LIKE '%cited_approval_object_id%'",
    );
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        payload["audit"]["cited_approval_object_id"], "approval",
        "{payload}"
    );
    // Revocation has nothing to demote for it either.
    store
        .commit(intent("revoke-after-inert"), |envelope| {
            let decisions = envelope.revoke_approval("approval", "withdrawn")?;
            assert!(decisions.is_empty(), "{decisions:?}");
            Ok(String::new())
        })
        .unwrap();
}

/// The chain walk expands one hop past `MAX_AUTHORITY_CHAIN_DEPTH` so the member
/// count can exceed what the gate permits. Stopping exactly at the bound caps the
/// count at the permitted value, and the gate then never fires — an over-long chain
/// would validate on a truncated prefix, leaving ancestors past the bound unchecked.
#[test]
fn an_authority_chain_past_the_depth_bound_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    let hops = 70;
    {
        let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // Each link is a live accepted decision approved by the previous one, so every
        // member qualifies on its own and only the chain's length can refuse it.
        for hop in 0..hops {
            let object = format!("chain-{hop:03}");
            let parent = if hop == 0 {
                "approval".to_string()
            } else {
                format!("chain-{:03}", hop - 1)
            };
            connection
                .execute(
                    "INSERT INTO object_registry(
                         object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                         created_commit_seq,sensitivity_class
                     ) VALUES (?1,'decision','approval-domain','fixture',?1,1,1,'normal')",
                    rusqlite::params![object],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO decisions(
                         decision_id,object_id,decision_kind,decision_payload,
                         created_commit_seq,sensitivity_class
                     ) VALUES (?1,?1,'adr_accepted',X'7b7d',1,'normal')",
                    rusqlite::params![object],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO admission_decisions(
                         admission_decision_id,subject_object_id,source_kind,source_id,
                         source_revision,source_class,taint_class,event_kind,maturity,
                         effective_maturity,disposition,visibility,outcome,sensitivity_class,
                         policy_revision,reason,approval_object_id,elevated_support,commit_seq,
                         decided_at
                     ) VALUES (?1,?1,'fixture',?1,1,'explicit_user','user_explicit','approve',
                               'approved','approved','active','automatic','admit','normal',1,
                               'fixture',?2,1,1,1)",
                    rusqlite::params![object, parent],
                )
                .unwrap();
        }
    }

    // A link inside the bound still authorizes.
    stage(&store, "shallow");
    let mut shallow = request("shallow");
    shallow.source_class = Some(SourceClass::ModelInference);
    shallow.taint_class = Some(TaintClass::AssistantInference);
    shallow.event.kind = EventKind::Verify;
    shallow.event.trigger_object_id = None;
    shallow.event.approval_object_id = Some("chain-000".to_string());
    assert_eq!(admit(&store, shallow, "shallow", "shallow"), "admit");

    // The deepest link sits past the bound, so its chain cannot be proven.
    stage(&store, "deep");
    let mut deep = request("deep");
    deep.source_class = Some(SourceClass::ModelInference);
    deep.taint_class = Some(TaintClass::AssistantInference);
    deep.event.kind = EventKind::Verify;
    deep.event.trigger_object_id = None;
    deep.event.approval_object_id = Some(format!("chain-{:03}", hops - 1));
    assert_eq!(admit(&store, deep, "deep", "deep"), "deny");
}

#[test]
fn an_unused_valid_citation_does_not_replace_the_supporting_approval() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "held");
    let mut promoted = request("held");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "held", "held"), "admit");

    // `approval-b` is valid but contributes nothing to a non-raising event, so it
    // must not become the recorded authority.
    store
        .commit(intent("unused-valid-citation"), |envelope| {
            let mut inert = subject_request("object-held", EventKind::Other);
            inert.source_class = Some(SourceClass::ModelInference);
            inert.taint_class = Some(TaintClass::AssistantInference);
            inert.event.approval_object_id = Some("approval-b".to_string());
            envelope.record_admission(inert)?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT approval_object_id FROM admission_decisions
             WHERE subject_object_id='object-held'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "approval"
    );

    // Revoking the uninvolved approval therefore leaves the subject supported.
    store
        .commit(intent("revoke-uninvolved"), |envelope| {
            envelope.revoke_approval("approval-b", "unrelated withdrawal")?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='object-held'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );
}

#[test]
fn a_citation_whose_chain_reaches_the_subject_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    // `approval-b` derives its authority from `approval`, so approving `approval`
    // while citing `approval-b` would close a cycle.
    store
        .commit(intent("cycle-attempt"), |envelope| {
            let mut cyclic = subject_request("approval", EventKind::Approve);
            cyclic.source_class = Some(SourceClass::ExplicitUser);
            cyclic.taint_class = Some(TaintClass::UserExplicit);
            cyclic.event.approval_object_id = Some("approval-b".to_string());
            let decision = envelope.record_admission(cyclic)?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();

    // Both links keep the authority they legitimately held.
    stage(&store, "after-cycle");
    let mut granted = request("after-cycle");
    granted.source_class = Some(SourceClass::ModelInference);
    granted.taint_class = Some(TaintClass::AssistantInference);
    granted.event.kind = EventKind::Verify;
    granted.event.trigger_object_id = None;
    granted.event.approval_object_id = Some("approval-b".to_string());
    assert_eq!(
        admit(&store, granted, "after-cycle", "after-cycle"),
        "admit"
    );
}

#[test]
fn a_retired_subject_cannot_acquire_new_visibility() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    store
        .commit(intent("retire-target"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "retired".to_string(),
                object_id: "retired-object".to_string(),
                name: "retired".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "retired".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    // Retire it through the public path so the invalidating commit really exists.
    store
        .commit(intent("retire-it"), |envelope| {
            envelope.retire_domain("retired-object")?;
            Ok(String::new())
        })
        .unwrap();

    let error = store
        .commit(intent("admit-retired"), |envelope| {
            envelope
                .record_admission(subject_request("retired-object", EventKind::CodeObserved))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::NotFound);
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions WHERE subject_object_id='retired-object'"
        ),
        0
    );
}

#[test]
fn retiring_an_approval_demotes_its_dependents() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "retire-dep");
    let mut promoted = request("retire-dep");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "retire-dep", "promote"), "admit");

    // `retire_decision` is a separate invalidation route and must run the same
    // cascade that `revoke_approval` does.
    store
        .commit(intent("retire-approval"), |envelope| {
            envelope.retire_decision("approval")?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility FROM admission_decisions
             WHERE subject_object_id='object-retire-dep'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "explicit_labeled"
    );
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'bad-sensitivity-decision','object-bad-sensitivity','fixture',
                 'bad-sensitivity',1,'trusted_local_code','current_code','other','verified','verified',
                 'active','automatic','admit','normal',1,'fixture',2,2
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'inconsistent-decision','object-inconsistent','fixture','inconsistent',1,
                 'trusted_local_code','current_code','other','verified','verified','rejected',
                 'automatic','reject','normal',1,'fixture',2,2
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
    stage_in_run(
        &store,
        "run-old-candidate",
        "old-candidate",
        "stable-source",
    );
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
    stage_in_run(
        &store,
        "run-new-candidate",
        "new-candidate",
        "stable-source",
    );
    store
        .commit(intent("remembered-rejection"), |envelope| {
            assert_eq!(
                envelope
                    .record_admission(rejected("new-candidate"))?
                    .disposition
                    .as_str(),
                "rejected"
            );
            Ok(String::new())
        })
        .unwrap();

    // Each candidate carries its own prior, so the re-staged one records a second
    // decision rather than folding into the first. Both are rejections, and the
    // retained first row has lost its purged candidate.
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM admission_decisions
             WHERE source_id='stable-source' AND disposition='rejected'"
        ),
        2
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
    stage_in_run(&store, "run-first", "first", "shared-source");
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
    stage_in_run(&store, "run-second", "second", "shared-source");
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
    // Prior selection is per object, so the re-observation records `active` for
    // the object itself. The lineage rejection is what withholds every surface.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition FROM admission_decisions
             WHERE subject_object_id='object-shadowed'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "active"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition FROM admission_decisions
             WHERE subject_object_id IS NULL AND source_id='shared-source'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "rejected"
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'illegal-pair-decision','object-illegal-pair','fixture','illegal-pair',1,
                 'untrusted_web','current_code','other','verified','verified','active','automatic','admit',
                 'normal',1,'fixture',1,1
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'unknown-source-decision','object-unknown-source','fixture','unknown-source',1,
                 'future_source','current_code','other','verified','verified','active','automatic','admit',
                 'normal',1,'fixture',1,1
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
fn governing_decision_sensitivity_hides_an_object_the_registry_calls_normal() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_in_run(&store, "run-plain", "plain", "mixed-source");
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
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'alien-lineage-decision','object-anchor','fixture','not-the-anchor-source',9,
                 'trusted_local_code','current_code','other','enforced','enforced','active','automatic',
                 'admit','normal',1,'fixture',1,1
             );
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES (
                 'object-alien-only','fixture','domain-anchor','fixture','alien-only',1,1,'normal'
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'alien-only-decision','object-alien-only','fixture','some-other-source',1,
                 'trusted_local_code','current_code','other','verified','verified','active','automatic',
                 'admit','normal',1,'fixture',1,1
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

#[test]
fn source_level_rejection_strips_an_approval_of_its_authority() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // A source-level rejection on the approval's own lineage ('fixture','approval',1).
    // Staging cannot produce this row: `validate_provenance` refuses `explicit_user`
    // for both witness kinds, and any other class would drift from the approval's
    // prior. A restored or imported database can still hold it.
    connection
        .execute(
            "INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,visibility,
                 outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'approval-lineage-rejection',NULL,'fixture','approval',1,'explicit_user',
                 'user_explicit','explicit_reject','approved','approved','rejected','review_only',
                 'reject','normal',1,'fixture',1,2
             )",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    stage(&store, "blocked-by-source-rejection");
    let mut approved = request("blocked-by-source-rejection");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("blocked-by-source-rejection"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "source-rejected-domain".to_string(),
                    object_id: "source-rejected-object".to_string(),
                    name: "name-blocked-by-source-rejection".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='source-rejected-object'"
        ),
        0
    );
}

#[test]
fn an_approval_restoring_clamped_support_becomes_the_recorded_authority() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    // An independent root, not a dependent of `approval`: revoking `approval` would
    // invalidate a descendant transitively, so it could not restore anything.
    {
        let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 INSERT INTO object_registry(
                     object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                     created_commit_seq,sensitivity_class
                 ) VALUES (
                     'approval-c','decision','approval-domain','fixture','approval-c',1,1,'normal'
                 );
                 INSERT INTO decisions(
                     decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                     sensitivity_class
                 ) VALUES ('approval-c-decision','approval-c','adr_accepted',X'7b7d',1,'normal');
                 INSERT INTO admission_decisions(
                     admission_decision_id,subject_object_id,source_kind,source_id,
                     source_revision,source_class,taint_class,event_kind,maturity,
                     effective_maturity,disposition,visibility,outcome,sensitivity_class,
                     policy_revision,reason,elevated_support,commit_seq,decided_at
                 ) VALUES (
                     'approval-c-admission','approval-c','fixture','approval-c',1,'explicit_user',
                     'user_explicit','accepted_adr','approved','approved','active','automatic',
                     'admit','normal',1,'fixture',1,1,1
                 );",
            )
            .unwrap();
    }
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "restored", "code_present", 1, "restored-trigger");

    // Promote the unmaterialized candidate under `approval`, then revoke it so the
    // carried support is clamped.
    let mut promoted = request("restored");
    promoted.event.kind = EventKind::Approve;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("restored-promote"), |envelope| {
            let decision = envelope.record_admission(promoted)?;
            assert_eq!(decision.effective_maturity, Maturity::Approved);
            Ok(String::new())
        })
        .unwrap();
    store
        .commit(intent("restored-revoke"), |envelope| {
            envelope.revoke_approval("approval", "withdrawn")?;
            Ok(String::new())
        })
        .unwrap();

    // Materializing with a different valid approval restores Approved, so that
    // approval — not the revoked one — is the recorded authority.
    let mut restored = request("restored");
    restored.event.kind = EventKind::Approve;
    restored.event.trigger_object_id = None;
    restored.event.approval_object_id = Some("approval-c".to_string());
    store
        .commit(intent("restored-materialize"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                restored,
                AdmissionDomainSpec {
                    domain_id: "domain-restored".to_string(),
                    object_id: "object-restored".to_string(),
                    name: "name-restored".to_string(),
                },
            )?;
            assert_eq!(decision.effective_maturity, Maturity::Approved);
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT approval_object_id FROM admission_decisions
             WHERE subject_object_id='object-restored'"
        ),
        "approval-c"
    );

    // So revoking the approval that actually supports it reaches the object. The
    // automatic ceiling for this pair is `Verified`, which is still automatically
    // visible, so the demotion shows in effective maturity rather than visibility.
    store
        .commit(intent("restored-revoke-c"), |envelope| {
            let demoted = envelope.revoke_approval("approval-c", "second withdrawal")?;
            assert_eq!(demoted.len(), 1, "{demoted:?}");
            assert_eq!(demoted[0].effective_maturity, Maturity::Verified);
            assert_eq!(demoted[0].outcome.as_str(), "demote_support");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='object-restored'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );
    // History is preserved: the object did reach Approved.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT maturity FROM admission_decisions
             WHERE subject_object_id='object-restored'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "approved"
    );
}

#[test]
fn retiring_a_dependent_releases_approval_capacity() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "released");
    let mut promoted = request("released");
    promoted.source_class = Some(SourceClass::ModelInference);
    promoted.taint_class = Some(TaintClass::AssistantInference);
    promoted.event.kind = EventKind::Verify;
    promoted.event.trigger_object_id = None;
    promoted.event.approval_object_id = Some("approval".to_string());
    assert_eq!(admit(&store, promoted, "released", "promote"), "admit");

    let counted = |root: &std::path::Path| {
        inspect(
            root,
            "SELECT COUNT(DISTINCT a.subject_object_id) FROM admission_decisions a
             JOIN object_registry o ON o.object_id=a.subject_object_id
             WHERE a.approval_object_id='approval' AND a.elevated_support=1
               AND o.invalidated_commit_seq IS NULL",
        )
    };
    assert_eq!(counted(directory.path()), 1);

    // Retiring the dependent must return its slot, matching the fan-out which
    // already skips invalidated objects.
    store
        .commit(intent("retire-dependent"), |envelope| {
            envelope.retire_domain("object-released")?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(counted(directory.path()), 0);
}

#[test]
fn an_approval_needs_standing_of_its_own_not_its_lineage() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // An accepted ADR with no decision about itself, sharing a lineage with an
    // approved source-scoped decision, plus one whose own governing decision
    // pairs a source class the evaluator forbids with `user_explicit`.
    connection
        .execute_batch(
            "INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES ('borrowed','decision','approval-domain','fixture','borrowed',1,1,'normal');
             INSERT INTO decisions(
                 decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                 sensitivity_class
             ) VALUES ('borrowed-decision','borrowed','adr_accepted',X'7b7d',1,'normal');
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'borrowed-lineage',NULL,'fixture','borrowed',1,'explicit_user','user_explicit',
                 'other','approved','approved','active','automatic','admit','normal',1,'fixture',
                 1,1
             );
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES ('illegal','decision','approval-domain','fixture','illegal',1,1,'normal');
             INSERT INTO decisions(
                 decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                 sensitivity_class
             ) VALUES ('illegal-decision','illegal','adr_accepted',X'7b7d',1,'normal');
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'illegal-admission','illegal','fixture','illegal',1,'untrusted_web',
                 'user_explicit','other','approved','approved','active','automatic','admit',
                 'normal',1,'fixture',1,1
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    for (authority, candidate, domain, object) in [
        (
            "borrowed",
            "borrows-standing",
            "borrowed-domain",
            "borrowed-object",
        ),
        (
            "illegal",
            "illegal-pairing",
            "illegal-domain",
            "illegal-object",
        ),
    ] {
        stage(&store, candidate);
        let mut approved = request(candidate);
        approved.source_class = Some(SourceClass::ModelInference);
        approved.taint_class = Some(TaintClass::AssistantInference);
        approved.event.kind = EventKind::Verify;
        approved.event.trigger_object_id = None;
        approved.event.approval_object_id = Some(authority.to_string());
        store
            .commit(intent(candidate), |envelope| {
                let decision = envelope.admit_domain_candidate(
                    approved,
                    AdmissionDomainSpec {
                        domain_id: domain.to_string(),
                        object_id: object.to_string(),
                        name: format!("name-{candidate}"),
                    },
                )?;
                assert_eq!(decision.outcome.as_str(), "deny", "authority {authority}");
                Ok(String::new())
            })
            .unwrap();
        assert_eq!(
            inspect(
                directory.path(),
                &format!("SELECT COUNT(*) FROM object_registry WHERE object_id='{object}'")
            ),
            0
        );
    }
}

#[test]
fn a_sensitive_trigger_classifies_the_object_it_admits() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(
        &store,
        "classified",
        "code_present",
        1,
        "classified-trigger",
    );
    // The candidate is normal but its supporting observation is not.
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "UPDATE observations SET sensitivity_class='secret'
             WHERE observation_id='observation-classified';",
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        admit(&store, request("classified"), "classified", "classified"),
        "admit"
    );
    // Both the decision and the object it materialized carry the trigger's class, so
    // the admitted content is not exposed below the classification that supported it.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT sensitivity_class FROM admission_decisions
             WHERE subject_object_id='object-classified'"
        ),
        "secret"
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT sensitivity_class FROM object_registry
             WHERE object_id='object-classified'"
        ),
        "secret"
    );
}

#[test]
fn a_trigger_whose_evidence_is_gone_cannot_admit() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_with_observation(&store, "unbacked", "code_present", 1, "unbacked-trigger");

    // Back the observation with evidence, then invalidate the evidence while leaving
    // the observation live — the state a deletion or purge leaves behind.
    store
        .commit(intent("unbacked-evidence"), |envelope| {
            envelope.insert_domain(DomainSpec {
                domain_id: "unbacked-ev".to_string(),
                object_id: "unbacked-ev-object".to_string(),
                name: "unbacked ev".to_string(),
                source_kind: "fixture".to_string(),
                source_id: "unbacked-ev".to_string(),
                source_revision: 1,
                sensitivity: Sensitivity::Normal,
            })?;
            Ok(String::new())
        })
        .unwrap();
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES ('ev-object','evidence','trigger-unbacked','repo','ev',1,1,'normal');
             INSERT INTO evidence_meta(
                 evidence_id,object_id,artifact_reference,artifact_digest,byte_length,media_type,
                 retention_class,provider_egress_class,redaction_metadata,created_commit_seq,
                 sensitivity_class
             ) VALUES ('ev-1','ev-object','local','digest',1,'text/plain','durable','local',X'',
                       1,'normal');
             UPDATE observations SET evidence_id='ev-1'
             WHERE observation_id='observation-unbacked';
             UPDATE evidence_meta
             SET invalidated_commit_seq=(SELECT MAX(commit_seq) FROM commit_log)
             WHERE evidence_id='ev-1';",
        )
        .unwrap();
    drop(connection);

    assert_eq!(
        admit(&store, request("unbacked"), "unbacked", "unbacked"),
        "deny"
    );
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='object-unbacked'"
        ),
        0
    );
}

#[test]
fn a_self_admitting_record_does_not_inherit_a_revoked_approval() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();

    // `approval-b` drew its support from `approval`; revoking the root demotes it.
    store
        .commit(intent("revoke-root-for-self"), |envelope| {
            envelope.revoke_approval("approval", "root withdrawn")?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='approval-b'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );

    // A self-admitting AcceptedAdr must not inherit the revoked approval, or its own
    // root authority would stay hostage to an ancestor it no longer needs.
    store
        .commit(intent("self-admit"), |envelope| {
            let mut self_admit = subject_request("approval-b", EventKind::AcceptedAdr);
            self_admit.source_class = Some(SourceClass::ExplicitUser);
            self_admit.taint_class = Some(TaintClass::UserExplicit);
            let decision = envelope.record_admission(self_admit)?;
            assert_eq!(decision.effective_maturity, Maturity::Approved);
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT COALESCE(approval_object_id,'none') FROM admission_decisions
             WHERE subject_object_id='approval-b'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "none"
    );

    // Having regained root authority on its own, it can grant again.
    stage(&store, "regranted");
    let mut granted = request("regranted");
    granted.source_class = Some(SourceClass::ModelInference);
    granted.taint_class = Some(TaintClass::AssistantInference);
    granted.event.kind = EventKind::Verify;
    granted.event.trigger_object_id = None;
    granted.event.approval_object_id = Some("approval-b".to_string());
    assert_eq!(admit(&store, granted, "regranted", "regranted"), "admit");
}

#[test]
fn a_hidden_approval_is_not_authority() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // Row-level `automatic` says nothing about sensitivity, so an accepted ADR can
    // be classified beyond every automatic surface and still look eligible.
    connection
        .execute_batch(
            "INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES ('secret-adr','decision','approval-domain','fixture','secret-adr',1,1,
                       'secret');
             INSERT INTO decisions(
                 decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                 sensitivity_class
             ) VALUES ('secret-adr-decision','secret-adr','adr_accepted',X'7b7d',1,'secret');
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'secret-adr-admission','secret-adr','fixture','secret-adr',1,'explicit_user',
                 'user_explicit','other','approved','approved','active','automatic','admit',
                 'secret',1,'fixture',1,1
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();
    // The stored row really does claim the automatic surface.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT visibility||'/'||sensitivity_class FROM admission_decisions
             WHERE subject_object_id='secret-adr'"
        ),
        "automatic/secret"
    );
    // And serving withholds it everywhere.
    assert!(store
        .visible_as_of(Surface::ExplicitSearch, 1)
        .unwrap()
        .rows
        .iter()
        .all(|row| row.object.object_id != "secret-adr"));

    stage(&store, "blocked-by-secret-authority");
    let mut approved = request("blocked-by-secret-authority");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("secret-adr".to_string());
    store
        .commit(intent("blocked-by-secret-authority"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "secret-authority-domain".to_string(),
                    object_id: "secret-authority-object".to_string(),
                    name: "name-blocked-by-secret-authority".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='secret-authority-object'"
        ),
        0
    );
}

#[test]
fn support_above_earned_history_never_serves() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let seq = insert_subject(
        &store,
        "impossible",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // Support clamps history; it cannot exceed it. Every other field stays valid.
    connection
        .execute(
            "UPDATE admission_decisions SET maturity='candidate',effective_maturity='verified'
             WHERE subject_object_id='object-impossible'",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition||'/'||visibility FROM admission_decisions
             WHERE subject_object_id='object-impossible'"
        ),
        "active/automatic"
    );
    for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
        assert!(
            store.visible_as_of(surface, seq).unwrap().rows.is_empty(),
            "effective maturity above historical must fail closed"
        );
    }
}

#[test]
fn an_object_restriction_survives_a_later_lineage_admission() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    stage_in_run(&store, "run-held", "held", "two-way-source");
    store
        .commit(intent("admit-held"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-held",
                "code_present",
                "domain-held",
                "repo",
                "two-way-source",
                1,
            )?;
            envelope.admit_domain_candidate(
                request("held"),
                AdmissionDomainSpec {
                    domain_id: "domain-held".to_string(),
                    object_id: "object-held".to_string(),
                    name: "name-held".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    let quarantined = store
        .commit(intent("quarantine-held"), |envelope| {
            envelope.record_admission(subject_request("object-held", EventKind::Quarantine))?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;
    // An unrelated candidate on the same lineage is admitted afterwards, so its
    // source-scoped decision is the newest row on that lineage.
    stage_in_run(&store, "run-sibling", "sibling", "two-way-source");
    let sibling = store
        .commit(intent("admit-sibling"), |envelope| {
            let mut request = request("sibling");
            request.event.trigger_object_id = Some("observation-held".to_string());
            envelope.record_admission(request)?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition||'/'||visibility FROM admission_decisions
             WHERE subject_object_id IS NULL AND source_id='two-way-source'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "active/automatic"
    );
    for seq in [quarantined, sibling] {
        for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
            assert!(
                store
                    .visible_as_of(surface, seq)
                    .unwrap()
                    .rows
                    .iter()
                    .all(|row| row.object.object_id != "object-held"),
                "a quarantined object must not be relaxed by a lineage admission"
            );
        }
    }
}

#[test]
fn standing_requires_an_own_decision_that_is_itself_valid() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let seq = insert_subject(
        &store,
        "unreadable",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // The object's only own decision becomes uninterpretable, while the lineage
    // gains a valid automatic decision that would otherwise carry it.
    connection
        .execute(
            "UPDATE admission_decisions SET policy_revision=99
             WHERE subject_object_id='object-unreadable'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'unreadable-lineage',NULL,'fixture','source-unreadable',1,'trusted_local_code',
                 'current_code','other','verified','verified','active','automatic','admit',
                 'normal',1,'fixture',1,1
             )",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
        assert!(
            store.visible_as_of(surface, seq).unwrap().rows.is_empty(),
            "a lineage decision must not carry an object whose own decision is unreadable"
        );
    }
}

#[test]
fn a_lineage_rejection_demotes_what_the_rejected_authority_supported() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    // A candidate promoted on the seeded approval's authority.
    stage(&store, "leans-on-approval");
    let mut approved = request("leans-on-approval");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("promote-on-approval"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "leaning-domain".to_string(),
                    object_id: "leaning-object".to_string(),
                    name: "name-leans-on-approval".to_string(),
                },
            )?;
            assert_eq!(decision.effective_maturity, Maturity::Verified);
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='leaning-object'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );

    // Reject the approval's own lineage through a candidate, which names no
    // subject. The rejection becomes the approval's governing decision and its
    // classification cannot carry authority, so the approval is unseated.
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-reject-lineage".to_string(),
            candidate_id: "reject-lineage".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "fixture".to_string(),
            source_id: "approval".to_string(),
            source_revision: 1,
            candidate_kind: "domain".to_string(),
            payload: "name-reject-lineage".to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: now,
            lease_expires_at: now + 60_000,
        })
        .unwrap();
    store
        .commit(intent("reject-approval-lineage"), |envelope| {
            envelope.record_admission(AdmissionRequest {
                candidate_id: Some("reject-lineage".to_string()),
                subject_object_id: None,
                source_class: Some(SourceClass::TrustedLocalCode),
                taint_class: Some(TaintClass::CurrentCode),
                event: AdmissionEvent {
                    kind: EventKind::ExplicitReject,
                    trigger_object_id: None,
                    approval_object_id: None,
                    evidence_id: None,
                    reason: "reject the approval's lineage".to_string(),
                },
            })?;
            Ok(String::new())
        })
        .unwrap();

    // The approval no longer authorizes anything new.
    stage(&store, "arrives-too-late");
    let mut late = request("arrives-too-late");
    late.source_class = Some(SourceClass::ModelInference);
    late.taint_class = Some(TaintClass::AssistantInference);
    late.event.kind = EventKind::Verify;
    late.event.trigger_object_id = None;
    late.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("arrives-too-late"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                late,
                AdmissionDomainSpec {
                    domain_id: "late-domain".to_string(),
                    object_id: "late-object".to_string(),
                    name: "name-arrives-too-late".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    drop(store);

    // And what it already supported lost that support in the same commit as the
    // rejection, rather than being left standing on a rejected authority.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='leaning-object'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "candidate"
    );
}

#[test]
fn a_weak_own_decision_is_not_rescued_by_a_qualifying_lineage_decision() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // The ADR's own decision stops at `verified`, so it never earned approval.
    // A newer decision on its lineage qualifies on every field.
    connection
        .execute_batch(
            "INSERT INTO object_registry(
                 object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                 created_commit_seq,sensitivity_class
             ) VALUES ('weak-adr','decision','approval-domain','fixture','weak-adr',1,1,'normal');
             INSERT INTO decisions(
                 decision_id,object_id,decision_kind,decision_payload,created_commit_seq,
                 sensitivity_class
             ) VALUES ('weak-adr-decision','weak-adr','adr_accepted',X'7b7d',1,'normal');
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'weak-adr-own','weak-adr','fixture','weak-adr',1,'explicit_user','user_explicit',
                 'other','verified','verified','active','automatic','admit','normal',1,'fixture',
                 1,1
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'weak-adr-zz-lineage',NULL,'fixture','weak-adr',1,'explicit_user',
                 'user_explicit','other','approved','approved','active','automatic','admit',
                 'normal',1,'fixture',1,2
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();
    // The lineage row really is the one the governing rule would pick.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT admission_decision_id FROM admission_decisions
             WHERE source_id='weak-adr'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "weak-adr-zz-lineage"
    );

    stage(&store, "leans-on-weak");
    let mut approved = request("leans-on-weak");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("weak-adr".to_string());
    store
        .commit(intent("leans-on-weak"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "weak-domain".to_string(),
                    object_id: "weak-object".to_string(),
                    name: "name-leans-on-weak".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='weak-object'"
        ),
        0
    );
}

#[test]
fn a_newer_own_decision_does_not_outrank_a_lineage_rejection_for_authority() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // The ADR is rejected at lineage scope, then records a newer own decision that
    // qualifies on every field. Serving still withholds it, so authority must too.
    connection
        .execute_batch(
            "INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'approval-a-lineage-reject',NULL,'fixture','approval',1,'explicit_user',
                 'user_explicit','explicit_reject','approved','approved','rejected','review_only',
                 'reject','normal',1,'fixture',1,2
             );
             INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'approval-z-own-later','approval','fixture','approval',1,'explicit_user',
                 'user_explicit','other','approved','approved','active','automatic','admit',
                 'normal',1,'fixture',1,3
             );",
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();
    // The own row really is the newer of the two.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT admission_decision_id FROM admission_decisions
             WHERE source_id='approval' ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "approval-z-own-later"
    );
    // And serving withholds the ADR, because the lineage rejection still applies.
    assert!(store
        .visible_as_of(Surface::ExplicitSearch, 1)
        .unwrap()
        .rows
        .iter()
        .all(|row| row.object.object_id != "approval"));

    stage(&store, "leans-on-rejected-lineage");
    let mut approved = request("leans-on-rejected-lineage");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("leans-on-rejected-lineage"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "rejected-lineage-domain".to_string(),
                    object_id: "rejected-lineage-object".to_string(),
                    name: "name-leans-on-rejected-lineage".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='rejected-lineage-object'"
        ),
        0
    );
}

#[test]
fn support_above_the_automatic_ceiling_needs_an_approval_to_serve() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    let seq = insert_subject(
        &store,
        "unbacked",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    drop(store);
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // `model_inference`/`assistant_inference` has an automatic ceiling of
    // `candidate`, so `verified` support is a level the evaluator only reaches on a
    // valid approval. This row names none.
    connection
        .execute(
            "UPDATE admission_decisions
             SET source_class='model_inference',taint_class='assistant_inference',
                 maturity='verified',effective_maturity='verified',
                 disposition='active',visibility='automatic',approval_object_id=NULL
             WHERE subject_object_id='object-unbacked'",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition||'/'||visibility||'/'||effective_maturity
             FROM admission_decisions WHERE subject_object_id='object-unbacked'"
        ),
        "active/automatic/verified"
    );
    for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
        assert!(
            store.visible_as_of(surface, seq).unwrap().rows.is_empty(),
            "support above the ceiling with no approval must fail closed"
        );
    }
}

#[test]
fn a_failed_domain_admission_still_cascades_authority_loss() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    // Something promoted on the seeded approval's authority.
    stage(&store, "rests-on-approval");
    let mut approved = request("rests-on-approval");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("promote-on-approval"), |envelope| {
            envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "resting-domain".to_string(),
                    object_id: "resting-object".to_string(),
                    name: "name-rests-on-approval".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='resting-object'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );

    // A rejection on the approval's lineage that never materializes an object still
    // writes a lineage decision, so it must run the same cascade.
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-reject-via-domain".to_string(),
            candidate_id: "reject-via-domain".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "fixture".to_string(),
            source_id: "approval".to_string(),
            source_revision: 1,
            candidate_kind: "domain".to_string(),
            payload: "name-reject-via-domain".to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: now,
            lease_expires_at: now + 60_000,
        })
        .unwrap();
    store
        .commit(intent("reject-via-domain"), |envelope| {
            let decision = envelope.admit_domain_candidate(
                AdmissionRequest {
                    candidate_id: Some("reject-via-domain".to_string()),
                    subject_object_id: None,
                    source_class: Some(SourceClass::TrustedLocalCode),
                    taint_class: Some(TaintClass::CurrentCode),
                    event: AdmissionEvent {
                        kind: EventKind::ExplicitReject,
                        trigger_object_id: None,
                        approval_object_id: None,
                        evidence_id: None,
                        reason: "reject the approval's lineage".to_string(),
                    },
                },
                AdmissionDomainSpec {
                    domain_id: "never-made-domain".to_string(),
                    object_id: "never-made-object".to_string(),
                    name: "name-reject-via-domain".to_string(),
                },
            )?;
            assert_eq!(decision.outcome.as_str(), "reject");
            Ok(String::new())
        })
        .unwrap();
    drop(store);

    // No object was materialized, and the demotion still reached the dependent.
    assert_eq!(
        inspect(
            directory.path(),
            "SELECT COUNT(*) FROM object_registry WHERE object_id='never-made-object'"
        ),
        0
    );
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='resting-object'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "candidate"
    );
}

#[test]
fn a_root_accepted_adr_serves_without_citing_an_approval() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    // `admission_ceiling` lifts an accepted decision to `approved` on its own, so
    // this row legitimately holds support above the automatic ceiling with no
    // approval named. Serving must not mistake that for unbacked support.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity||'/'||COALESCE(approval_object_id,'NULL')
             FROM admission_decisions WHERE subject_object_id='approval'"
        ),
        "approved/NULL"
    );
    assert!(
        store
            .visible_as_of(Surface::AutoInject, 1)
            .unwrap()
            .rows
            .iter()
            .any(|row| row.object.object_id == "approval"),
        "a root accepted ADR must still serve"
    );
}

#[test]
fn an_ordinary_lineage_observation_leaves_an_approval_and_its_dependents_alone() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    stage(&store, "kept-on-approval");
    let mut approved = request("kept-on-approval");
    approved.source_class = Some(SourceClass::ModelInference);
    approved.taint_class = Some(TaintClass::AssistantInference);
    approved.event.kind = EventKind::Verify;
    approved.event.trigger_object_id = None;
    approved.event.approval_object_id = Some("approval".to_string());
    store
        .commit(intent("promote-kept"), |envelope| {
            envelope.admit_domain_candidate(
                approved,
                AdmissionDomainSpec {
                    domain_id: "kept-domain".to_string(),
                    object_id: "kept-object".to_string(),
                    name: "name-kept-on-approval".to_string(),
                },
            )?;
            Ok(String::new())
        })
        .unwrap();

    // A harmless source-scoped observation on the approval's lineage.
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap();
    store
        .stage_candidate(StagingCandidateSpec {
            extraction_run_id: "run-benign".to_string(),
            candidate_id: "benign".to_string(),
            extractor: "fixture".to_string(),
            source_kind: "fixture".to_string(),
            source_id: "approval".to_string(),
            source_revision: 1,
            candidate_kind: "domain".to_string(),
            payload: "name-benign".to_string(),
            provenance: Some(RepositoryProvenance {
                repository_id: "repo".to_string(),
                revision: "abc123".to_string(),
            }),
            recorded_at: now,
            lease_expires_at: now + 60_000,
        })
        .unwrap();
    store
        .commit(intent("benign-lineage-observation"), |envelope| {
            envelope.insert_admission_observation_for_test(
                "observation-benign",
                "code_present",
                "approval-domain",
                "fixture",
                "approval",
                1,
            )?;
            let mut request = request("benign");
            request.event.trigger_object_id = Some("observation-benign".to_string());
            envelope.record_admission(request)?;
            Ok(String::new())
        })
        .unwrap();
    drop(store);

    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT disposition||'/'||visibility FROM admission_decisions
             WHERE subject_object_id IS NULL AND source_id='approval'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "active/automatic"
    );
    // The approval kept its authority, so nothing it supported was demoted.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT effective_maturity FROM admission_decisions
             WHERE subject_object_id='kept-object'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "verified"
    );
}

#[test]
fn a_decision_older_than_its_subject_grants_no_standing() {
    let directory = tempfile::tempdir().unwrap();
    let store = KernelStore::open(directory.path()).unwrap();
    insert_subject(
        &store,
        "anchor",
        Sensitivity::Normal,
        Some(EventKind::CodeObserved),
    );
    let seq = insert_subject(&store, "late", Sensitivity::Normal, None);
    drop(store);
    let created: i64 = {
        let connection = Connection::open_with_flags(
            directory.path().join("core.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection
            .query_row(
                "SELECT created_commit_seq FROM object_registry WHERE object_id='object-late'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert!(created > 1, "the object must be created after commit 1");
    let connection = Connection::open(directory.path().join("core.sqlite")).unwrap();
    // Correct lineage, correct subject, but recorded before the object existed.
    connection
        .execute(
            "INSERT INTO admission_decisions(
                 admission_decision_id,subject_object_id,source_kind,source_id,source_revision,
                 source_class,taint_class,event_kind,maturity,effective_maturity,disposition,
                 visibility,outcome,sensitivity_class,policy_revision,reason,commit_seq,decided_at
             ) VALUES (
                 'predates-subject','object-late','fixture','source-late',1,'trusted_local_code',
                 'current_code','other','verified','verified','active','automatic','admit',
                 'normal',1,'fixture',1,1
             )",
            [],
        )
        .unwrap();
    drop(connection);
    let store = KernelStore::open(directory.path()).unwrap();

    for surface in [Surface::AutoInject, Surface::ExplicitSearch] {
        assert!(
            store
                .visible_as_of(surface, seq)
                .unwrap()
                .rows
                .iter()
                .all(|row| row.object.object_id != "object-late"),
            "a decision older than its subject must not stand in for one"
        );
    }
}

#[test]
fn an_invalidated_approval_still_serves_at_its_own_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    let admitted = 1;
    assert!(store
        .visible_as_of(Surface::AutoInject, admitted)
        .unwrap()
        .rows
        .iter()
        .any(|row| row.object.object_id == "approval"));
    let revoked = store
        .commit(intent("revoke-for-time-travel"), |envelope| {
            envelope.revoke_approval("approval", "withdrawn")?;
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    // Self-authority is a property of the snapshot, not of the latest state, so the
    // earlier read must not change because the ADR was invalidated later.
    assert!(
        store
            .visible_as_of(Surface::AutoInject, admitted)
            .unwrap()
            .rows
            .iter()
            .any(|row| row.object.object_id == "approval"),
        "an ADR invalidated later must still serve at its own snapshot"
    );
    assert!(store
        .visible_as_of(Surface::AutoInject, revoked)
        .unwrap()
        .rows
        .iter()
        .all(|row| row.object.object_id != "approval"));
}

#[test]
fn a_denied_event_does_not_hide_the_authority_it_carried_forward() {
    let directory = tempfile::tempdir().unwrap();
    seed_approval(directory.path());
    seed_dependent_approval(directory.path());
    let store = KernelStore::open(directory.path()).unwrap();
    let before = store
        .visible_as_of(Surface::AutoInject, 1)
        .unwrap()
        .rows
        .iter()
        .map(|row| row.object.object_id.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        before,
        vec!["approval".to_string(), "approval-b".to_string()]
    );

    // A citation that closes a cycle is denied, but the denial still records a row.
    let denied = store
        .commit(intent("cycle-attempt"), |envelope| {
            let mut cyclic = subject_request("approval", EventKind::Approve);
            cyclic.source_class = Some(SourceClass::ExplicitUser);
            cyclic.taint_class = Some(TaintClass::UserExplicit);
            cyclic.event.approval_object_id = Some("approval-b".to_string());
            let decision = envelope.record_admission(cyclic)?;
            assert_eq!(decision.outcome.as_str(), "deny");
            Ok(String::new())
        })
        .unwrap()
        .commit_seq;

    // That row carries `approved` forward with no approval of its own, because the
    // approval that justified the level lives on the earlier row. Serving must not
    // read the carried level as support the subject never earned.
    assert_eq!(
        inspect_text(
            directory.path(),
            "SELECT outcome||'/'||effective_maturity||'/'||COALESCE(approval_object_id,'NULL')
             FROM admission_decisions WHERE subject_object_id='approval'
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
        ),
        "deny/approved/NULL"
    );
    assert_eq!(
        store
            .visible_as_of(Surface::AutoInject, denied)
            .unwrap()
            .rows
            .iter()
            .map(|row| row.object.object_id.clone())
            .collect::<Vec<_>>(),
        before,
        "a denial must not remove what was visible before it"
    );
}
