#![cfg(feature = "test-support")]

use mc_store::kernel::{
    AdmissionDomainSpec, AdmissionEvent, AdmissionRequest, CommitIntent, DomainSpec, EventKind,
    KernelError, KernelStore, RepositoryProvenance, Sensitivity, SourceClass, StagingCandidateSpec,
    TaintClass,
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
            source_id: format!("source-{candidate_id}"),
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
                 source_class,taint_class,maturity,disposition,visibility,policy_revision,
                 reason,commit_seq,decided_at
             ) VALUES (
                 'approval-admission','approval','fixture','approval',1,'explicit_user',
                 'user_explicit','approved','active','automatic',1,'fixture',1,1
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
