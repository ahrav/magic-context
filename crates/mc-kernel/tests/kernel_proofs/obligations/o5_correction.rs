//! O5, append-only correction: over every chain length one through eight on
//! domains and decisions, appending a correction never rewrites an earlier
//! snapshot, every predecessor stays in the object history with its
//! invalidation, a faulted correction leaves history untouched, and a
//! correction naming an unknown predecessor lands nothing.

use std::collections::BTreeMap;

use mc_kernel::{DecisionRow, KernelError, ObjectRow};

use crate::fixtures::{decision, domain, intent, root_domain};
use crate::harness::Proof;

#[derive(Debug, Clone, Copy)]
enum Kind {
    Domain,
    Decision,
}

type Frozen = BTreeMap<i64, (Vec<ObjectRow>, Vec<ObjectRow>, Vec<DecisionRow>)>;

fn snapshots(proof: &Proof) -> Frozen {
    (0..=proof.tip())
        .map(|seq| {
            (
                seq,
                (
                    proof.store().known_as_of(seq).unwrap().objects,
                    proof.store().object_history_as_of(seq).unwrap().objects,
                    proof.store().slice_as_of(seq).unwrap().decisions,
                ),
            )
        })
        .collect()
}

/// The typed table's own lifecycle columns, which `content` excludes and the
/// registry assertions never read.
fn lifecycle(proof: &Proof, kind: Kind) -> BTreeMap<String, (Option<i64>, Option<String>)> {
    let table = match kind {
        Kind::Domain => "domains",
        Kind::Decision => "decisions",
    };
    proof
        .db()
        .prepare(&format!(
            "SELECT object_id,invalidated_commit_seq,superseded_by
             FROM {table} ORDER BY object_id"
        ))
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// `invalidated_commit_seq` and `superseded_by` are excluded because
/// corrections update predecessor rows.
fn content(proof: &Proof, kind: Kind) -> BTreeMap<String, String> {
    let table = match kind {
        Kind::Domain => "domains",
        Kind::Decision => "decisions",
    };
    let db = proof.db();
    // Reading the column list from the live schema covers columns added later.
    let columns = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .into_iter()
        .filter(|name| !matches!(name.as_str(), "invalidated_commit_seq" | "superseded_by"))
        .collect::<Vec<_>>();
    assert!(
        columns.len() >= 5,
        "{table} projection collapsed to {columns:?}"
    );
    // `quote` distinguishes NULL from an empty string.
    let projection = columns
        .iter()
        .map(|name| format!("quote({name})"))
        .collect::<Vec<_>>()
        .join("||'|'||");
    db.prepare(&format!(
        "SELECT object_id,{projection} FROM {table} ORDER BY object_id"
    ))
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

fn assert_successor_content(proof: &Proof, kind: Kind, object_id: &str, index: usize) {
    let (sql, expected) = match kind {
        Kind::Domain => (
            "SELECT domain_id||'|'||name FROM domains WHERE object_id=?1",
            vec![format!("domain-{index}"), format!("name-{index}")],
        ),
        Kind::Decision => (
            "SELECT decision_id||'|'||decision_kind||'|'||CAST(decision_payload AS TEXT)
             FROM decisions WHERE object_id=?1",
            vec![
                format!("decision-{index}"),
                "architecture".to_string(),
                format!("decision {index}"),
                format!("rationale {index}"),
            ],
        ),
    };
    let stored: String = proof
        .db()
        .query_row(sql, [object_id], |row| row.get(0))
        .unwrap();
    for value in expected {
        assert!(
            stored.contains(&value),
            "{object_id} lost {value:?} from its correction: {stored}"
        );
    }
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
        let frozen_content = content(&proof, kind);
        let old = chain.last().unwrap().clone();
        let new = correct(&mut proof, kind, &old, step + 2);
        invalidated_at.insert(old.clone(), proof.tip());
        chain.push(new.clone());
        // Every snapshot that existed before the correction is unchanged.
        for (seq, (known, history, decisions)) in &frozen {
            assert_eq!(
                &proof.store().known_as_of(*seq).unwrap().objects,
                known,
                "snapshot {seq}"
            );
            assert_eq!(
                &proof.store().object_history_as_of(*seq).unwrap().objects,
                history,
                "history snapshot {seq}"
            );
            assert_eq!(
                &proof.store().slice_as_of(*seq).unwrap().decisions,
                decisions,
                "decision slice {seq}"
            );
        }
        let after = content(&proof, kind);
        for (id, before) in &frozen_content {
            assert_eq!(
                after.get(id),
                Some(before),
                "correction rewrote the typed content of {id}"
            );
        }
        // Positive control.
        assert!(after.contains_key(&new), "{new} has no typed row");
        assert_eq!(after.len(), frozen_content.len() + 1);
        assert_successor_content(&proof, kind, &new, step + 2);
    }
    let tip = proof.tip();
    let history = proof.store().object_history_as_of(tip).unwrap();
    let typed = lifecycle(&proof, kind);
    for (index, id) in chain.iter().enumerate() {
        let row = history
            .objects
            .iter()
            .find(|row| &row.object_id == id)
            .unwrap_or_else(|| panic!("{id} missing from history"));
        let successor = chain.get(index + 1);
        assert_eq!(row.invalidated_commit_seq, invalidated_at.get(id).copied());
        assert_eq!(row.superseded_by.as_ref(), successor);
        // The typed table writes lifecycle columns separately from the registry.
        let (invalidated, typed_successor) = typed
            .get(id)
            .unwrap_or_else(|| panic!("{id} missing from the {kind:?} table"));
        assert_eq!(
            *invalidated,
            invalidated_at.get(id).copied(),
            "typed invalidation for {id}"
        );
        assert_eq!(
            typed_successor.as_ref(),
            successor,
            "typed successor for {id}"
        );
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
    // `slice_as_of` filters on the typed table's invalidation, so it serves
    // both members of a chain if that column goes unstamped.
    if matches!(kind, Kind::Decision) {
        let served = proof
            .store()
            .slice_as_of(tip)
            .unwrap()
            .decisions
            .into_iter()
            .map(|row| row.object_id)
            .collect::<Vec<_>>();
        assert_eq!(served, vec![chain.last().unwrap().clone()]);
    }

    // A superseded predecessor is no longer live, so correcting it again lands
    // nothing rather than creating a competing successor.
    let stale = chain[chain.len() - 2].clone();
    let before = proof.digest();
    // Chain indices stop at `length + 1`; these offsets stay clear of them.
    let stale_index = length + 200;
    let error = match kind {
        Kind::Domain => proof
            .store()
            .commit(intent("stale-domain"), move |envelope| {
                envelope.correct_domain(&stale, domain(stale_index))?;
                Ok(String::new())
            }),
        Kind::Decision => proof
            .store()
            .commit(intent("stale-decision"), move |envelope| {
                envelope.correct_decision(&stale, decision(stale_index))?;
                Ok(String::new())
            }),
    }
    .unwrap_err();
    assert_eq!(error, KernelError::NotFound);
    assert_eq!(proof.digest(), before);

    // A faulted correction changes neither history nor any snapshot.
    let frozen = snapshots(&proof);
    let frozen_content = content(&proof, kind);
    let frozen_lifecycle = lifecycle(&proof, kind);
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
    assert_eq!(content(&proof, kind), frozen_content);
    assert_eq!(lifecycle(&proof, kind), frozen_lifecycle);
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
