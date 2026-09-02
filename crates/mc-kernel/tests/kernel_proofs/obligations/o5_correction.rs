//! O5, append-only correction: over every chain length one through eight on
//! domains and decisions, appending a correction never rewrites an earlier
//! snapshot, every predecessor stays in the object history with its
//! invalidation, a faulted correction leaves history untouched, and a
//! correction naming an unknown predecessor lands nothing.

use std::collections::BTreeMap;

use mc_kernel::{KernelError, ObjectRow};

use crate::fixtures::{decision, domain, intent, root_domain};
use crate::harness::Proof;

#[derive(Debug, Clone, Copy)]
enum Kind {
    Domain,
    Decision,
}

/// Object rows per snapshot; `tip` is dropped because it advances with every
/// commit and is not part of the snapshot's content.
fn snapshots(proof: &Proof) -> BTreeMap<i64, Vec<ObjectRow>> {
    (0..=proof.tip())
        .map(|seq| (seq, proof.store().known_as_of(seq).unwrap().objects))
        .collect()
}

fn correct(proof: &mut Proof, kind: Kind, old: &str, index: usize) -> String {
    let key = format!("correct-{old}-{index}");
    let (new_id, receipt) = match kind {
        Kind::Domain => {
            let spec = domain(index);
            let id = spec.object_id.clone();
            let (receipt, _) = proof.commit(intent(&key), move |envelope| {
                envelope.correct_domain(old, spec)?;
                Ok(String::new())
            });
            (id, receipt)
        }
        Kind::Decision => {
            let spec = decision(index);
            let id = spec.object_id.clone();
            let (receipt, _) = proof.commit(intent(&key), move |envelope| {
                envelope.correct_decision(old, spec)?;
                Ok(String::new())
            });
            (id, receipt)
        }
    };
    assert!(!receipt.replayed);
    new_id
}

fn insert(proof: &mut Proof, kind: Kind, index: usize) -> String {
    match kind {
        Kind::Domain => {
            let spec = domain(index);
            let id = spec.object_id.clone();
            proof.commit(intent(&format!("insert-{index}")), move |envelope| {
                envelope.insert_domain(spec)?;
                Ok(String::new())
            });
            id
        }
        Kind::Decision => {
            let spec = decision(index);
            let id = spec.object_id.clone();
            proof.commit(intent(&format!("insert-{index}")), move |envelope| {
                envelope.insert_decision(spec)?;
                Ok(String::new())
            });
            id
        }
    }
}

fn run_chain(kind: Kind, length: usize) {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    let mut chain = vec![insert(&mut proof, kind, 1)];
    let mut invalidated_at: BTreeMap<String, i64> = BTreeMap::new();
    for step in 0..length {
        let frozen = snapshots(&proof);
        let old = chain.last().unwrap().clone();
        let new = correct(&mut proof, kind, &old, step + 2);
        invalidated_at.insert(old.clone(), proof.tip());
        chain.push(new);
        // Every snapshot that existed before the correction is unchanged.
        for (seq, before) in &frozen {
            assert_eq!(
                &proof.store().known_as_of(*seq).unwrap().objects,
                before,
                "snapshot {seq}"
            );
        }
    }
    let tip = proof.tip();
    let history = proof.store().object_history_as_of(tip).unwrap();
    for (index, id) in chain.iter().enumerate() {
        let row = history
            .objects
            .iter()
            .find(|row| &row.object_id == id)
            .unwrap_or_else(|| panic!("{id} missing from history"));
        let successor = chain.get(index + 1);
        assert_eq!(row.invalidated_commit_seq, invalidated_at.get(id).copied());
        assert_eq!(row.superseded_by.as_ref(), successor);
    }
    // Only the chain head is live at the tip.
    let live = proof
        .store()
        .known_as_of(tip)
        .unwrap()
        .objects
        .into_iter()
        .filter(|row| chain.contains(&row.object_id))
        .map(|row| row.object_id)
        .collect::<Vec<_>>();
    assert_eq!(live, vec![chain.last().unwrap().clone()]);

    // A faulted correction changes neither history nor any snapshot.
    let frozen = snapshots(&proof);
    let head = chain.last().unwrap().clone();
    let fault_index = length + 100;
    match kind {
        Kind::Domain => proof.fault(intent("faulted"), move |envelope| {
            envelope.correct_domain(&head, domain(fault_index))?;
            Ok(String::new())
        }),
        Kind::Decision => proof.fault(intent("faulted"), move |envelope| {
            envelope.correct_decision(&head, decision(fault_index))?;
            Ok(String::new())
        }),
    }
    assert_eq!(snapshots(&proof), frozen);
    assert_eq!(
        proof.store().object_history_as_of(tip).unwrap().objects,
        history.objects
    );
}

/// Chain lengths one through eight over both correctable kinds is a sixteen-
/// point space, so it is walked exhaustively rather than sampled.
#[test]
fn correction_chains_preserve_every_prior_snapshot_and_predecessor() {
    for kind in [Kind::Domain, Kind::Decision] {
        for length in 1..=8 {
            run_chain(kind, length);
        }
    }
}

#[test]
fn correction_naming_an_unknown_predecessor_lands_nothing() {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        envelope.insert_domain(domain(1))?;
        Ok(String::new())
    });
    let before = proof.digest();
    let error = proof
        .store()
        .commit(intent("unknown"), |envelope| {
            envelope.correct_domain("object-missing", domain(2))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::NotFound);
    assert_eq!(proof.digest(), before);
    let error = proof
        .store()
        .commit(intent("unknown-decision"), |envelope| {
            envelope.correct_decision("decision-missing", decision(2))?;
            Ok(String::new())
        })
        .unwrap_err();
    assert_eq!(error, KernelError::NotFound);
    assert_eq!(proof.digest(), before);
}
