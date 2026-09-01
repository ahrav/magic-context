//! Shared helpers for applicability integration tests: checkout snapshots,
//! anchor rows with capture payloads, and candidate scaffolding.

#![allow(dead_code)]

use mc_store::kernel::applicability::{
    capture_anchor_representation, snapshot_checkout, ApplicabilityCandidate, CheckoutSnapshot,
    EvalBudget,
};
use mc_store::kernel::{encode_anchor_captures, AnchorRowSpec, CommitIntent};

use super::git_fixtures::{materialize, set_head_detached, FixtureRepo};

/// Detaches HEAD at `commit`, materializes it, and snapshots the checkout.
pub fn checkout(fixture: &FixtureRepo, commit: gix::ObjectId) -> CheckoutSnapshot {
    set_head_detached(&fixture.repo, commit);
    materialize(&fixture.repo, commit);
    snapshot_checkout(&fixture.root, &EvalBudget::unbounded()).expect("snapshot succeeds")
}

/// A `reachable_from` anchor row carrying the capture-time representation
/// of `commit`, as anchor authoring would write it.
pub fn reachable_anchor(
    fixture: &FixtureRepo,
    anchor_id: &str,
    commit: gix::ObjectId,
) -> AnchorRowSpec {
    let capture = capture_anchor_representation(&fixture.repo, commit, &EvalBudget::unbounded())
        .expect("capture builds");
    AnchorRowSpec {
        anchor_id: anchor_id.to_string(),
        anchor_kind: "reachable_from".to_string(),
        reachable_from_oid: Some(commit.to_string()),
        payload: Some(encode_anchor_captures(&[capture])),
        ..AnchorRowSpec::default()
    }
}

/// A candidate with only identity set.
pub fn candidate(object_id: &str) -> ApplicabilityCandidate {
    ApplicabilityCandidate {
        object_id: object_id.to_string(),
        object_revision: 1,
        ..ApplicabilityCandidate::default()
    }
}

/// A commit intent with the given producer and a fixed-digit digest.
pub fn intent(producer: &str, key: &str, digest: char) -> CommitIntent {
    CommitIntent {
        producer: producer.to_string(),
        operation_key: key.to_string(),
        request_digest: digest.to_string().repeat(64),
        actor: "test".to_string(),
        cause: "proof".to_string(),
    }
}
