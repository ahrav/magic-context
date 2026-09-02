//! `Proof` owns one store root and drives the three perturbations every proof
//! needs: `restart` (drop the handle, reopen the same root), `replay`
//! (resubmit a recorded intent), and `fault` (drive an operation through an
//! in-process fault hook, then prove the rollback durable across a restart).
//!
//! Query methods return owned values so no borrow of the store outlives a
//! `restart`. `restart` takes the handle out before reopening because a
//! second open while the first handle is alive returns `KernelError::Held`.

#![allow(dead_code)]

use std::path::Path;

use mc_kernel::{
    ArtifactDeletionFault, ArtifactDeletionRequest, ArtifactErrorKind, CommitIntent, CommitReceipt,
    Envelope, KernelError, KernelStore, RestoreFault,
};
use rusqlite::Connection;
use tempfile::TempDir;

use crate::canonical_state::{digest, CanonicalDigest, Profile};

pub struct Proof {
    root: TempDir,
    store: Option<KernelStore>,
    intents: Vec<CommitIntent>,
}

impl Proof {
    pub fn open() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = KernelStore::open(root.path()).unwrap();
        Self {
            root,
            store: Some(store),
            intents: Vec::new(),
        }
    }

    pub fn path(&self) -> &Path {
        self.root.path()
    }

    pub fn store(&self) -> &KernelStore {
        self.store.as_ref().expect("store is open between restarts")
    }

    pub fn digest(&self) -> CanonicalDigest {
        digest(self.path(), Profile::SameRoot)
    }

    /// A second connection to `core.sqlite` for inspecting rows the public
    /// API does not expose; the store's own handle stays open beside it.
    pub fn db(&self) -> Connection {
        Connection::open(self.path().join("core.sqlite")).unwrap()
    }

    pub fn count_table(&self, table: &str) -> i64 {
        self.db()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    pub fn tip(&self) -> i64 {
        self.store().facts(0).unwrap().commit_seq
    }

    /// Drops the live handle and reopens the same root.
    pub fn restart(&mut self) {
        drop(self.store.take());
        self.store = Some(KernelStore::open(self.path()).unwrap());
    }

    /// Commits `operation` under `intent`, recording the intent for `replay`.
    /// Returns the receipt and the index the intent was recorded at.
    pub fn commit(
        &mut self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    ) -> (CommitReceipt, usize) {
        let receipt = self
            .store()
            .commit(intent.clone(), operation)
            .unwrap_or_else(|error| panic!("commit {}: {error:?}", intent.operation_key));
        self.intents.push(intent);
        (receipt, self.intents.len() - 1)
    }

    /// Resubmits recorded intent `index` with an operation that must not run:
    /// a replay is served from the receipt, never re-executed.
    pub fn replay(&self, index: usize) -> CommitReceipt {
        self.store()
            .commit(self.intents[index].clone(), |_| {
                panic!("replayed intent re-executed its operation")
            })
            .unwrap()
    }

    /// Drives `operation` through the envelope fault hook, which fires after
    /// change events are written and before outbox rows. Asserts the failure
    /// is the injected fault, the canonical digest is unchanged, and the
    /// rollback survives a restart.
    pub fn fault(
        &mut self,
        intent: CommitIntent,
        operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
    ) {
        let before = self.digest();
        let error = self
            .store()
            .commit_with_fault_after_events_for_test(intent, operation)
            .unwrap_err();
        assert_eq!(error, KernelError::Fault);
        self.assert_rolled_back(&before);
    }

    /// Same contract as `fault` for the deletion fault that fires before the
    /// reference commit, which surfaces as a `ReferenceCommit` error.
    pub fn fault_deletion(&mut self, request: ArtifactDeletionRequest) {
        let before = self.digest();
        let error = self
            .store()
            .delete_artifact_with_fault_for_test(request, ArtifactDeletionFault::BeforeCommit)
            .unwrap_err();
        assert_eq!(error.kind(), ArtifactErrorKind::ReferenceCommit);
        self.assert_rolled_back(&before);
    }

    /// Drives a restore through `fault`, asserts the error the fault
    /// produces, restarts so recovery runs, and returns the settled digest.
    pub fn fault_restore(&mut self, backup: &Path, fault: RestoreFault) -> CanonicalDigest {
        let error = self
            .store()
            .restore_with_fault_for_test(backup, fault)
            .unwrap_err();
        let expected = match fault {
            RestoreFault::BeforeDisplace | RestoreFault::AfterDisplace => KernelError::Fault,
            RestoreFault::RecoveryFailure => KernelError::InvalidRestore,
        };
        assert_eq!(error, expected, "{fault:?}");
        self.restart();
        self.digest()
    }

    fn assert_rolled_back(&mut self, before: &CanonicalDigest) {
        self.digest()
            .assert_same(before, "fault left canonical state changed");
        self.restart();
        self.digest()
            .assert_same(before, "rolled-back state did not survive restart");
    }
}

#[cfg(test)]
mod tests {
    use mc_kernel::{KernelError, KernelStore};

    use super::Proof;
    use crate::fixtures::{domain, intent, root_domain};

    #[test]
    fn fault_on_domain_insert_leaves_no_trace_before_or_after_restart() {
        let mut proof = Proof::open();
        proof.commit(intent("seed"), |envelope| {
            envelope.insert_domain(root_domain())?;
            Ok(String::new())
        });
        let commits = proof.count_table("commit_log");
        let outbox = proof.count_table("outbox");
        proof.fault(intent("faulted"), |envelope| {
            envelope.insert_domain(domain(1))?;
            Ok(String::new())
        });
        assert_eq!(proof.count_table("commit_log"), commits);
        assert_eq!(proof.count_table("outbox"), outbox);
        assert_eq!(proof.tip(), commits);
        // Positive control: the same operation lands when not faulted.
        let (receipt, _) = proof.commit(intent("faulted"), |envelope| {
            envelope.insert_domain(domain(1))?;
            Ok(String::new())
        });
        assert_eq!(receipt.commit_seq, commits + 1);
        assert!(!receipt.replayed);
    }

    #[test]
    fn open_while_held_fails_and_restart_takes_the_handle_first() {
        let mut proof = Proof::open();
        assert_eq!(
            KernelStore::open(proof.path()).unwrap_err(),
            KernelError::Held
        );
        proof.restart();
        assert_eq!(
            KernelStore::open(proof.path()).unwrap_err(),
            KernelError::Held
        );
    }

    #[test]
    fn fault_on_three_object_correction_lands_no_events_and_keeps_known_as_of() {
        let mut proof = Proof::open();
        proof.commit(intent("seed"), |envelope| {
            envelope.insert_domain(root_domain())?;
            envelope.insert_domain(domain(1))?;
            envelope.insert_domain(domain(2))?;
            envelope.insert_domain(domain(3))?;
            Ok(String::new())
        });
        let tip = proof.tip();
        let known = proof.store().known_as_of(tip).unwrap();
        let events = proof.count_table("change_event");
        proof.fault(intent("correct-three"), |envelope| {
            envelope.correct_domain("object-1", domain(11))?;
            envelope.correct_domain("object-2", domain(12))?;
            envelope.correct_domain("object-3", domain(13))?;
            Ok(String::new())
        });
        assert_eq!(proof.count_table("change_event"), events);
        assert_eq!(proof.store().known_as_of(tip).unwrap(), known);
        assert_eq!(
            proof.store().known_as_of(tip + 1).unwrap_err(),
            KernelError::FutureSnapshot
        );
    }

    #[test]
    fn replay_returns_the_original_receipt_without_running_the_operation() {
        let mut proof = Proof::open();
        let (receipt, index) = proof.commit(intent("seed"), |envelope| {
            envelope.insert_domain(root_domain())?;
            Ok("seeded".to_string())
        });
        let before = proof.digest();
        let replayed = proof.replay(index);
        assert!(replayed.replayed);
        assert_eq!(replayed.commit_seq, receipt.commit_seq);
        assert_eq!(replayed.result, receipt.result);
        assert_eq!(proof.digest(), before);
    }
}
