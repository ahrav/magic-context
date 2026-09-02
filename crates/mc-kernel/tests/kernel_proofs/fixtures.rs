//! Spec builders shared by the proofs. Every builder yields values that pass
//! kernel validation as written, so a proof's body reads as the scenario it
//! proves rather than as field plumbing.
//!
//! The admission, decision, and observation builders have no caller in the
//! oracle proofs; the per-obligation proofs consume them.

#![allow(dead_code)]

use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use mc_kernel::{
    AdmissionDomainSpec, AdmissionEvent, AdmissionRequest, ArtifactDeletionIdentity,
    ArtifactDeletionKind, ArtifactDeletionRequest, ArtifactIngestRequest, CommitIntent,
    DecisionPayload, DecisionSpec, DomainSpec, EventKind, ObservationDependencySpec,
    ObservationPayload, ObservationSpec, ProviderEgress, RepositoryProvenance, Sensitivity,
    SourceClass, StagingCandidateSpec, TaintClass,
};

pub const DOMAIN: &str = "domain";
pub const DOMAIN_OBJECT: &str = "domain-object";
pub const LEASE_MS: i64 = 3_600_000;

pub fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

pub fn intent(key: &str) -> CommitIntent {
    CommitIntent {
        producer: "kernel-proofs".to_string(),
        operation_key: key.to_string(),
        request_digest: format!("{:x}", Sha256::digest(key.as_bytes())),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}

/// The fixture domain every other object hangs off.
pub fn root_domain() -> DomainSpec {
    DomainSpec {
        domain_id: DOMAIN.to_string(),
        object_id: DOMAIN_OBJECT.to_string(),
        name: "fixture".to_string(),
        source_kind: "fixture".to_string(),
        source_id: DOMAIN.to_string(),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

pub fn domain(index: usize) -> DomainSpec {
    DomainSpec {
        domain_id: format!("domain-{index}"),
        object_id: format!("object-{index}"),
        name: format!("name-{index}"),
        source_kind: "fixture".to_string(),
        source_id: format!("source-{index}"),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

pub fn staging(run: &str, candidate: &str, payload: &str) -> StagingCandidateSpec {
    let recorded_at = now_ms();
    StagingCandidateSpec {
        extraction_run_id: run.to_string(),
        candidate_id: candidate.to_string(),
        extractor: "fixture".to_string(),
        source_kind: "repo".to_string(),
        source_id: format!("source-{candidate}"),
        source_revision: 1,
        candidate_kind: "domain".to_string(),
        payload: payload.to_string(),
        provenance: Some(provenance()),
        recorded_at,
        lease_expires_at: recorded_at + LEASE_MS,
    }
}

pub fn provenance() -> RepositoryProvenance {
    RepositoryProvenance {
        repository_id: "repo".to_string(),
        revision: "abc123".to_string(),
    }
}

/// Admission request whose observed-code event lifts a trusted candidate to
/// `Verified`, the maturity `Surface::AutoInject` serves.
pub fn admit_request(candidate: &str, observation: &str) -> AdmissionRequest {
    AdmissionRequest {
        candidate_id: Some(candidate.to_string()),
        subject_object_id: None,
        source_class: Some(SourceClass::TrustedLocalCode),
        taint_class: Some(TaintClass::CurrentCode),
        event: AdmissionEvent {
            kind: EventKind::CodeObserved,
            trigger_object_id: Some(observation.to_string()),
            approval_object_id: None,
            evidence_id: None,
            reason: "host observed current code".to_string(),
        },
    }
}

/// Trigger observation for `candidate`: the kernel admits a candidate only
/// when a live `code_present` observation matches its source tuple.
pub fn code_observation(candidate: &str) -> ObservationSpec {
    ObservationSpec {
        observation_id: format!("observation-{candidate}"),
        object_id: format!("observation-{candidate}"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: "code_present".to_string(),
        payload: ObservationPayload {
            summary: "code present".to_string(),
            classification: "code_present".to_string(),
            detail: None,
        },
        observed_at: 1,
        dependencies: Vec::new(),
        source_kind: "repo".to_string(),
        source_id: format!("source-{candidate}"),
        source_revision: 1,
        sensitivity: Sensitivity::Normal,
    }
}

pub fn subject_request(object_id: &str, kind: EventKind) -> AdmissionRequest {
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

pub fn admitted_domain(candidate: &str, name: &str) -> AdmissionDomainSpec {
    AdmissionDomainSpec {
        domain_id: format!("domain-{candidate}"),
        object_id: format!("object-{candidate}"),
        name: name.to_string(),
    }
}

pub fn ingest(key: &str, payload: &[u8], sensitivity: Sensitivity) -> ArtifactIngestRequest {
    ArtifactIngestRequest {
        intent: intent(key),
        payload: payload.to_vec(),
        evidence_id: format!("evidence-{key}"),
        object_id: format!("evidence-object-{key}"),
        object_kind: "evidence".to_string(),
        domain_id: DOMAIN.to_string(),
        source_kind: "repository".to_string(),
        source_id: format!("src/{key}"),
        source_revision: 1,
        media_type: "text/plain".to_string(),
        retention_class: "canonical".to_string(),
        retain_until: None,
        asserted_sensitivity: sensitivity,
        provider_egress: ProviderEgress::RemoteAllowed,
        provenance: Some(provenance()),
    }
}

pub fn deletion(key: &str, digest: &str) -> ArtifactDeletionRequest {
    ArtifactDeletionRequest {
        intent: intent(key),
        identity: ArtifactDeletionIdentity::Digest(digest.to_string()),
        kind: ArtifactDeletionKind::Delete,
        operator_id: None,
        target_locator: None,
        reason: None,
        deleted_at: 42,
    }
}

pub fn decision(index: usize) -> DecisionSpec {
    DecisionSpec {
        decision_id: format!("decision-{index}"),
        object_id: format!("decision-object-{index}"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        decision_kind: "architecture".to_string(),
        payload: DecisionPayload {
            summary: format!("decision {index}"),
            rationale: format!("rationale {index}"),
        },
        source_kind: "fixture".to_string(),
        source_id: "decision-lineage".to_string(),
        source_revision: index as i64,
        sensitivity: Sensitivity::Normal,
    }
}

/// Observation implementing the decision whose object id is `implements`, so
/// alignment derives one row for the pair.
pub fn observation(index: usize, implements: &str) -> ObservationSpec {
    ObservationSpec {
        observation_id: format!("observation-{index}"),
        object_id: format!("observation-object-{index}"),
        domain_id: DOMAIN.to_string(),
        proposition_id: None,
        scope_id: None,
        anchor_id: None,
        evidence_id: None,
        observation_kind: "implementation".to_string(),
        payload: ObservationPayload {
            summary: format!("observation {index}"),
            classification: "implemented".to_string(),
            detail: None,
        },
        observed_at: index as i64,
        dependencies: vec![ObservationDependencySpec {
            dependency_object_id: implements.to_string(),
            dependency_kind: "implements".to_string(),
            dependency_payload: None,
        }],
        source_kind: "fixture".to_string(),
        source_id: "observation-lineage".to_string(),
        source_revision: index as i64,
        sensitivity: Sensitivity::Normal,
    }
}
