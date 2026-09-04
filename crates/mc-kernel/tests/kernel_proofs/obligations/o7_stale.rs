//! O7, no stale result reaching injection, kernel half: a candidate admitted
//! at `N` and retracted or superseded at `N+1` is excluded by
//! `visible_as_of(AutoInject, tip)` while `visible_as_of(AutoInject, N)`
//! still includes it, before and after a restart. Lag facts are proven in
//! `kernel_facts.rs`; the stale marker and abstention that a daemon route
//! derives from them belong to that route.
//!
//! Deleting the admitted subject's trigger evidence does not exclude it at
//! the tip, because `visible_as_of` never consults evidence liveness; the
//! kernel emits `admission_state` propagation work for a consumer to record
//! the new decision. The registry tracks that variant as its own row.

use mc_kernel::{EventKind, Surface, SurfaceVisibility};

use crate::fixtures::{
    admit_request, admitted_domain, code_observation, intent, root_domain, staging, subject_request,
};
use crate::harness::Proof;

const CANDIDATE: &str = "candidate-1";

/// Returns whether `object_id` is visible for auto-injection at commit `as_of`.
fn served(proof: &Proof, as_of: i64, object_id: &str) -> bool {
    proof
        .store()
        .visible_as_of(Surface::AutoInject, as_of)
        .unwrap()
        .rows
        .iter()
        .any(|row| {
            row.object.object_id == object_id && row.visibility == SurfaceVisibility::Visible
        })
}

/// Admits the fixture candidate and returns `(proof, object_id, N)`.
fn admitted() -> (Proof, String, i64) {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    proof
        .store()
        .stage_candidate(staging("run-1", CANDIDATE, "name"))
        .unwrap();
    let admitted = admitted_domain(CANDIDATE, "name");
    let object_id = admitted.object_id.clone();
    let (receipt, _) = proof.commit(intent("admit"), |envelope| {
        let trigger = code_observation(CANDIDATE);
        let request = admit_request(CANDIDATE, &trigger.observation_id);
        envelope.insert_observation(trigger)?;
        envelope.admit_domain_candidate(request, admitted)?;
        Ok(String::new())
    });
    assert!(
        served(&proof, receipt.commit_seq, &object_id),
        "positive control"
    );
    (proof, object_id, receipt.commit_seq)
}

/// Checks the stale-result invariant before and after reopening the same store.
fn assert_excluded_at_tip_included_at_admission(
    proof: &mut Proof,
    object_id: &str,
    admitted_at: i64,
) {
    for _ in 0..2 {
        let tip = proof.tip();
        assert!(tip > admitted_at);
        assert!(
            !served(proof, tip, object_id),
            "stale subject served at tip"
        );
        assert!(
            served(proof, admitted_at, object_id),
            "history rewritten at N"
        );
        proof.restart();
    }
}

#[test]
fn retracted_subject_is_excluded_at_tip_but_served_at_its_admission_snapshot() {
    let (mut proof, object_id, admitted_at) = admitted();
    let subject = object_id.clone();
    proof.commit(intent("retract"), move |envelope| {
        envelope.record_admission(subject_request(&subject, EventKind::MarkStale))?;
        Ok(String::new())
    });
    assert_excluded_at_tip_included_at_admission(&mut proof, &object_id, admitted_at);
}

#[test]
fn superseded_subject_is_excluded_at_tip_but_served_at_its_admission_snapshot() {
    let (mut proof, object_id, admitted_at) = admitted();
    let subject = object_id.clone();
    proof.commit(intent("supersede"), move |envelope| {
        envelope.supersede_domain(
            subject_request(&subject, EventKind::Replace),
            admitted_domain("successor", "successor"),
        )?;
        Ok(String::new())
    });
    assert_excluded_at_tip_included_at_admission(&mut proof, &object_id, admitted_at);
    // The unadmitted successor is not served either: supersession replaces
    // the subject without granting its replacement a decision.
    assert!(!served(&proof, proof.tip(), "object-successor"));
}
