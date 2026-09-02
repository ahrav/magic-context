//! O9, no unauthorized provider egress, kernel half: `artifact_eligibility`
//! over the whole (sensitivity × egress class × destination × 1–3 merged
//! references) domain against a spec written independently of the code
//! path, the spec's own monotone restriction when a reference is added, the
//! unknown and dereferenced cases, and the admission surface hiding
//! sensitive rows on remote-capable surfaces. A daemon gate that turns these
//! decisions into refused requests is a separate surface with its own row.

use mc_kernel::{
    ArtifactDestination, ArtifactEligibility, ArtifactHandle, EligibilityDeniedReason, EventKind,
    ProviderEgress, Sensitivity, Surface, SurfaceVisibility,
};

use crate::fixtures::{
    code_observation, deletion, domain, ingest, intent, root_domain, subject_request,
};
use crate::harness::Proof;

/// Every (sensitivity, egress class) a reference can carry; the matrix
/// indexes into this so its keys stay `Ord` without deriving on kernel types.
const CLASSES: [(Sensitivity, ProviderEgress); 6] = [
    (Sensitivity::Normal, ProviderEgress::RemoteAllowed),
    (Sensitivity::Normal, ProviderEgress::LocalOnly),
    (Sensitivity::Sensitive, ProviderEgress::RemoteAllowed),
    (Sensitivity::Sensitive, ProviderEgress::LocalOnly),
    (Sensitivity::Secret, ProviderEgress::RemoteAllowed),
    (Sensitivity::Secret, ProviderEgress::LocalOnly),
];
const DESTINATIONS: [ArtifactDestination; 2] =
    [ArtifactDestination::Local, ArtifactDestination::Remote];

/// Expected decision, stated as the policy: the strictest reference governs;
/// secret never leaves; sensitive and unknown never go remote; a local-only
/// reference pins the object local.
fn expected(references: &[usize], destination: ArtifactDestination) -> ArtifactEligibility {
    use ArtifactEligibility::{Allowed, Denied};
    use EligibilityDeniedReason as Reason;
    if references.is_empty() {
        return match destination {
            ArtifactDestination::Local => Allowed,
            ArtifactDestination::Remote => Denied(Reason::UnknownSensitive),
        };
    }
    let classes = references.iter().map(|&index| CLASSES[index]);
    let secret = classes.clone().any(|(s, _)| s == Sensitivity::Secret);
    let sensitive = classes.clone().any(|(s, _)| s == Sensitivity::Sensitive);
    let local_only = classes.clone().any(|(_, e)| e == ProviderEgress::LocalOnly);
    if secret {
        return Denied(Reason::Secret);
    }
    match destination {
        ArtifactDestination::Local => Allowed,
        ArtifactDestination::Remote if sensitive => Denied(Reason::SensitiveRemote),
        ArtifactDestination::Remote if local_only => Denied(Reason::ProviderRestricted),
        ArtifactDestination::Remote => Allowed,
    }
}

/// Every multiset of one to three class indices, in canonical order.
fn reference_sets() -> Vec<Vec<usize>> {
    let mut sets = Vec::new();
    for a in 0..CLASSES.len() {
        sets.push(vec![a]);
        for b in a..CLASSES.len() {
            sets.push(vec![a, b]);
            for c in b..CLASSES.len() {
                sets.push(vec![a, b, c]);
            }
        }
    }
    sets
}

/// Ingests `references.len()` evidence rows over identical bytes so they
/// merge onto one digest, returning that digest's handle.
fn ingest_merged(proof: &Proof, point: usize, references: &[usize]) -> ArtifactHandle {
    let payload = format!("payload-{point}");
    let mut handle: Option<ArtifactHandle> = None;
    for (ordinal, &class) in references.iter().enumerate() {
        let (sensitivity, egress) = CLASSES[class];
        let mut request = ingest(
            &format!("point-{point}-{ordinal}"),
            payload.as_bytes(),
            sensitivity,
        );
        request.provider_egress = egress;
        let this = proof.store().ingest_artifact(request).unwrap();
        if let Some(first) = &handle {
            assert_eq!(first.digest, this.digest, "references did not merge");
        }
        handle.get_or_insert(this);
    }
    handle.unwrap()
}

#[test]
fn eligibility_matrix_is_exhaustive() {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    let sets = reference_sets();
    assert_eq!(sets.len(), 6 + 21 + 56);
    let mut allowed = 0;
    for (point, references) in sets.iter().enumerate() {
        let handle = ingest_merged(&proof, point, references);
        for destination in DESTINATIONS {
            let actual = proof
                .store()
                .artifact_eligibility(&handle, destination)
                .unwrap();
            assert_eq!(
                actual,
                expected(references, destination),
                "{references:?} to {destination:?}"
            );
            if actual == ArtifactEligibility::Allowed {
                allowed += 1;
            }
        }
    }
    // Positive control: the matrix is not uniformly denied.
    assert!(allowed > 0);
}

/// A property of the written policy itself: adding a reference to any set
/// never widens what is allowed. Holding for `expected` and matching the
/// exhaustive matrix together prove it for production.
#[test]
fn expected_policy_never_widens_when_a_reference_is_added() {
    let mut widened = 0;
    let mut narrowed = 0;
    for references in reference_sets() {
        if references.len() == 3 {
            continue;
        }
        for class in 0..CLASSES.len() {
            let mut wider = references.clone();
            wider.push(class);
            wider.sort_unstable();
            for destination in DESTINATIONS {
                let before = expected(&references, destination);
                let after = expected(&wider, destination);
                if after == ArtifactEligibility::Allowed && before != ArtifactEligibility::Allowed {
                    widened += 1;
                }
                if after != ArtifactEligibility::Allowed && before == ArtifactEligibility::Allowed {
                    narrowed += 1;
                }
            }
        }
    }
    assert_eq!(widened, 0);
    // Positive control: some additions do restrict, so the check is live.
    assert!(narrowed > 0);
}

#[test]
fn unknown_and_dereferenced_digests_allow_local_and_deny_remote() {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    let never = ArtifactHandle {
        digest: "a".repeat(64),
        evidence_id: "absent".to_string(),
    };
    for destination in DESTINATIONS {
        assert_eq!(
            proof
                .store()
                .artifact_eligibility(&never, destination)
                .unwrap(),
            expected(&[], destination)
        );
    }
    let handle = ingest_merged(&proof, 0, &[0]);
    assert_eq!(
        proof
            .store()
            .artifact_eligibility(&handle, ArtifactDestination::Remote)
            .unwrap(),
        ArtifactEligibility::Allowed,
        "positive control: a live normal reference is remote-eligible"
    );
    proof
        .store()
        .delete_artifact(deletion("dereference", &handle.digest))
        .unwrap();
    for destination in DESTINATIONS {
        assert_eq!(
            proof
                .store()
                .artifact_eligibility(&handle, destination)
                .unwrap(),
            expected(&[], destination)
        );
    }
}

#[test]
fn tombstone_denies_before_any_reference_is_consulted() {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    let handle = ingest_merged(&proof, 0, &[0]);
    let mut purge = deletion("purge", &handle.digest);
    purge.kind = mc_kernel::ArtifactDeletionKind::Purge;
    purge.operator_id = Some("operator".to_string());
    purge.target_locator = Some("incident://proof".to_string());
    purge.reason = Some("proof".to_string());
    proof.store().delete_artifact(purge).unwrap();
    for destination in DESTINATIONS {
        assert_eq!(
            proof
                .store()
                .artifact_eligibility(&handle, destination)
                .unwrap(),
            ArtifactEligibility::Denied(EligibilityDeniedReason::Tombstoned)
        );
    }
}

#[test]
fn admission_hides_sensitive_subjects_on_remote_capable_surfaces() {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    // Two subjects admitted by the same observed-code event differ only in
    // stored sensitivity, so any surface difference is the sensitivity gate.
    for (index, sensitivity) in [(1, Sensitivity::Normal), (2, Sensitivity::Sensitive)] {
        let mut spec = domain(index);
        spec.sensitivity = sensitivity;
        let object_id = spec.object_id.clone();
        proof.commit(intent(&format!("admit-{index}")), move |envelope| {
            let mut trigger = code_observation(&format!("subject-{index}"));
            trigger.source_kind = spec.source_kind.clone();
            trigger.source_id = spec.source_id.clone();
            trigger.source_revision = spec.source_revision;
            let mut request = subject_request(&object_id, EventKind::CodeObserved);
            request.event.trigger_object_id = Some(trigger.observation_id.clone());
            envelope.insert_domain(spec)?;
            envelope.insert_observation(trigger)?;
            envelope.record_admission(request)?;
            Ok(String::new())
        });
    }
    proof.restart();
    let tip = proof.tip();
    let visibility = |surface: Surface, object_id: &str| {
        proof
            .store()
            .visible_as_of(surface, tip)
            .unwrap()
            .rows
            .into_iter()
            .find(|row| row.object.object_id == object_id)
            .map(|row| row.visibility)
    };
    for surface in [
        Surface::AutoInject,
        Surface::AutoSearch,
        Surface::ExplicitSearch,
    ] {
        assert_eq!(
            visibility(surface, "object-1"),
            Some(SurfaceVisibility::Visible),
            "normal subject on {surface:?}"
        );
    }
    assert_eq!(visibility(Surface::AutoInject, "object-2"), None);
    assert_eq!(visibility(Surface::AutoSearch, "object-2"), None);
    assert_eq!(
        visibility(Surface::ExplicitSearch, "object-2"),
        Some(SurfaceVisibility::Visible)
    );
}
