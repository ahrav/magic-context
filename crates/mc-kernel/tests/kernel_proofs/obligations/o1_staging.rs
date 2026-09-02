//! O1, staging invisibility: a staged candidate reaches no serving surface,
//! no canonical snapshot, and no slice or alignment view until admission,
//! and that stays true across a restart.
//!
//! No surface row carries a domain name, so a payload-text needle would hold
//! whether or not staging leaked; the payload is asserted only in
//! `candidates`, and surfaces are checked for the id admission renders.

use mc_kernel::{Surface, SurfaceVisibility};

use crate::fixtures::{
    admit_request, admitted_domain, code_observation, decision, domain, intent, observation,
    root_domain, staging,
};
use crate::harness::Proof;

const CANDIDATE: &str = "candidate-1";
const TEXT: &str = "staged-only-text";

/// Every read surface must hold real rows (so absence is not the emptiness
/// of an unpopulated view) and none of them may mention `needle` in any
/// rendered field.
fn assert_absent_everywhere(proof: &Proof, needle: &str) {
    let tip = proof.tip();
    for surface in [
        Surface::AutoInject,
        Surface::AutoSearch,
        Surface::ExplicitSearch,
    ] {
        let visible = proof.store().visible_as_of(surface, tip).unwrap();
        assert!(!visible.rows.is_empty(), "{surface:?} served nothing");
        assert!(
            !format!("{visible:?}").contains(needle),
            "{surface:?} served the staged candidate: {visible:?}"
        );
    }
    let known = proof.store().known_as_of(tip).unwrap();
    assert!(!known.objects.is_empty());
    assert!(!format!("{known:?}").contains(needle));
    let slice = proof.store().slice_as_of(tip).unwrap();
    assert!(!slice.decisions.is_empty() && !slice.observations.is_empty());
    assert!(!format!("{slice:?}").contains(needle));
    let alignment = proof.store().alignment_as_of(tip).unwrap();
    assert!(!alignment.rows.is_empty());
    assert!(!format!("{alignment:?}").contains(needle));
}

/// Seeds one served subject, one decision with an implementing observation,
/// and the alignment projection, so every surface a staged candidate must be
/// absent from has rows to be absent from.
fn populated() -> Proof {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        envelope.insert_decision(decision(1))?;
        envelope.insert_observation(observation(1, "decision-object-1"))?;
        Ok(String::new())
    });
    proof
        .store()
        .stage_candidate(staging("run-served", "served", "served-name"))
        .unwrap();
    proof.commit(intent("admit-served"), |envelope| {
        let trigger = code_observation("served");
        let request = admit_request("served", &trigger.observation_id);
        envelope.insert_observation(trigger)?;
        envelope.admit_domain_candidate(request, admitted_domain("served", "served-name"))?;
        Ok(String::new())
    });
    proof.store().rebuild_alignment().unwrap();
    proof
}

fn staged_payload(proof: &Proof) -> String {
    proof
        .db()
        .query_row(
            "SELECT CAST(payload AS TEXT) FROM candidates WHERE candidate_id=?1",
            [CANDIDATE],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn staged_candidate_is_invisible_on_every_surface_until_admitted_across_restart() {
    let mut proof = populated();
    proof
        .store()
        .stage_candidate(staging("run-1", CANDIDATE, TEXT))
        .unwrap();
    // Positive control: the candidate text is durably staged.
    assert_eq!(staged_payload(&proof), TEXT);
    assert_absent_everywhere(&proof, CANDIDATE);
    proof.restart();
    assert_eq!(staged_payload(&proof), TEXT);
    assert_absent_everywhere(&proof, CANDIDATE);

    let admitted = admitted_domain(CANDIDATE, TEXT);
    let object_id = admitted.object_id.clone();
    proof.commit(intent("admit"), |envelope| {
        let trigger = code_observation(CANDIDATE);
        let request = admit_request(CANDIDATE, &trigger.observation_id);
        envelope.insert_observation(trigger)?;
        envelope.admit_domain_candidate(request, admitted)?;
        Ok(String::new())
    });
    let tip = proof.tip();
    for surface in [
        Surface::AutoInject,
        Surface::AutoSearch,
        Surface::ExplicitSearch,
    ] {
        let visible = proof.store().visible_as_of(surface, tip).unwrap();
        let row = visible
            .rows
            .iter()
            .find(|row| row.object.object_id == object_id)
            .unwrap_or_else(|| panic!("admitted object missing on {surface:?}"));
        assert_eq!(row.visibility, SurfaceVisibility::Visible);
    }
    assert!(proof
        .store()
        .known_as_of(tip)
        .unwrap()
        .objects
        .iter()
        .any(|row| row.object_id == object_id));
}

#[test]
fn canonical_object_without_an_admission_decision_stays_off_automatic_surfaces() {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        envelope.insert_domain(domain(1))?;
        Ok(String::new())
    });
    proof
        .store()
        .stage_candidate(staging("run-1", CANDIDATE, TEXT))
        .unwrap();
    let admitted = admitted_domain(CANDIDATE, TEXT);
    let admitted_id = admitted.object_id.clone();
    proof.commit(intent("admit"), |envelope| {
        let trigger = code_observation(CANDIDATE);
        let request = admit_request(CANDIDATE, &trigger.observation_id);
        envelope.insert_observation(trigger)?;
        envelope.admit_domain_candidate(request, admitted)?;
        Ok(String::new())
    });
    proof.restart();
    let tip = proof.tip();
    let known = proof.store().known_as_of(tip).unwrap();
    assert!(known.objects.iter().any(|row| row.object_id == "object-1"));
    for surface in [Surface::AutoInject, Surface::AutoSearch] {
        // `visible_as_of` excludes `Hidden` rows.
        let rows = proof.store().visible_as_of(surface, tip).unwrap().rows;
        let served = rows
            .iter()
            .map(|row| (row.object.object_id.as_str(), row.visibility))
            .collect::<Vec<_>>();
        assert!(
            !rows.iter().any(|row| row.object.object_id == "object-1"),
            "{surface:?} served the object with no admission decision: {served:?}"
        );
        let admitted_row = rows
            .iter()
            .find(|row| row.object.object_id == admitted_id)
            .unwrap_or_else(|| panic!("admitted object missing on {surface:?}: {served:?}"));
        assert_eq!(admitted_row.visibility, SurfaceVisibility::Visible);
    }
}
