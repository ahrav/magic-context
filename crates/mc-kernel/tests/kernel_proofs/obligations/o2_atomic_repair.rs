//! O2, atomic multi-object repair under `known_as_of`: a concurrent reader
//! polling `known_as_of` while a three-object correction is mid-envelope sees
//! the complete pre-state or the complete post-state, never a mix; the
//! correction replays from its receipt, survives a restart at the same
//! snapshot, and lands nothing when faulted. Two observations written in one
//! envelope share one `commit_seq`.

use std::collections::BTreeSet;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use mc_kernel::KernelStore;

use crate::fixtures::{decision, domain, intent, observation, root_domain};
use crate::harness::Proof;

/// Bound on every cross-thread wait, so a reader that blocks behind the open
/// writer fails the test instead of hanging the binary.
const HANDSHAKE: Duration = Duration::from_secs(30);

const OLD: [&str; 3] = ["object-1", "object-2", "object-3"];
const NEW: [&str; 3] = ["object-11", "object-12", "object-13"];

fn live_domains(store: &KernelStore, as_of: i64) -> BTreeSet<String> {
    store
        .known_as_of(as_of)
        .unwrap()
        .objects
        .into_iter()
        .filter(|row| row.object_kind == "domain" && row.object_id != root_domain().object_id)
        .map(|row| row.object_id)
        .collect()
}

fn seeded() -> Proof {
    let mut proof = Proof::open();
    proof.commit(intent("seed"), |envelope| {
        envelope.insert_domain(root_domain())?;
        envelope.insert_domain(domain(1))?;
        envelope.insert_domain(domain(2))?;
        envelope.insert_domain(domain(3))?;
        Ok(String::new())
    });
    proof
}

fn set(ids: [&str; 3]) -> BTreeSet<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

#[test]
fn concurrent_reader_never_observes_a_partial_three_object_correction() {
    let mut proof = seeded();
    let pre = set(OLD);
    let post = set(NEW);
    assert_eq!(
        live_domains(proof.store(), proof.tip()),
        pre,
        "positive control"
    );
    let (written_tx, written_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();

    let store = proof.store();
    let tip_before = proof.tip();
    let (receipt, polls) = thread::scope(|scope| {
        let writer = scope.spawn(move || {
            store
                .commit(intent("correct-three"), move |envelope| {
                    envelope.correct_domain(OLD[0], domain(11))?;
                    envelope.correct_domain(OLD[1], domain(12))?;
                    envelope.correct_domain(OLD[2], domain(13))?;
                    written_tx.send(()).unwrap();
                    release_rx
                        .recv_timeout(HANDSHAKE)
                        .expect("poller never released the envelope");
                    Ok(String::new())
                })
                .unwrap()
        });
        let poller = scope.spawn(move || {
            // Sample while the third write sits in the open envelope, release
            // it, then keep sampling until the commit is observed at the tip.
            written_rx
                .recv_timeout(HANDSHAKE)
                .expect("writer never reached its third write");
            let mut samples = Vec::new();
            for _ in 0..16 {
                samples.push(live_domains(store, store.facts(0).unwrap().commit_seq));
                thread::yield_now();
            }
            release_tx.send(()).unwrap();
            let deadline = Instant::now() + HANDSHAKE;
            loop {
                assert!(Instant::now() < deadline, "commit never became visible");
                let tip = store.facts(0).unwrap().commit_seq;
                let sample = live_domains(store, tip);
                // Skipping consecutive identical snapshots bounds `samples`
                // until `deadline`.
                if samples.last() != Some(&sample) {
                    samples.push(sample);
                }
                if tip > tip_before {
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
            samples
        });
        // Joining `poller` first reports its assertion failure before the
        // writer's dropped-channel panic.
        let polls = poller.join().unwrap();
        (writer.join().unwrap(), polls)
    });

    assert!(!receipt.replayed);
    let mut saw_pre = false;
    let mut saw_post = false;
    for sample in &polls {
        if sample == &pre {
            saw_pre = true;
        } else if sample == &post {
            saw_post = true;
        } else {
            panic!("mixed snapshot observed: {sample:?}");
        }
    }
    assert!(saw_pre, "poller never sampled the pre-state");
    assert!(saw_post, "poller never sampled the post-state");
    assert_eq!(live_domains(proof.store(), receipt.commit_seq), post);
    assert_eq!(live_domains(proof.store(), receipt.commit_seq - 1), pre);

    // Replay is effect-free and served from the receipt.
    let digest = proof.digest();
    let replayed = proof
        .store()
        .commit(intent("correct-three"), |_| {
            panic!("replay re-ran the correction")
        })
        .unwrap();
    assert!(replayed.replayed);
    assert_eq!(replayed.commit_seq, receipt.commit_seq);
    assert_eq!(proof.digest(), digest);

    proof.restart();
    assert_eq!(live_domains(proof.store(), receipt.commit_seq), post);
    assert_eq!(live_domains(proof.store(), receipt.commit_seq - 1), pre);
}

#[test]
fn faulted_three_object_correction_lands_no_object_and_survives_restart() {
    let mut proof = seeded();
    let tip = proof.tip();
    proof.fault(intent("correct-three"), |envelope| {
        envelope.correct_domain(OLD[0], domain(11))?;
        envelope.correct_domain(OLD[1], domain(12))?;
        envelope.correct_domain(OLD[2], domain(13))?;
        Ok(String::new())
    });
    assert_eq!(proof.tip(), tip);
    assert_eq!(live_domains(proof.store(), tip), set(OLD));
}

#[test]
fn two_observations_in_one_envelope_share_one_commit_seq() {
    let mut proof = seeded();
    proof.commit(intent("decision"), |envelope| {
        envelope.insert_decision(decision(1))?;
        Ok(String::new())
    });
    let (receipt, _) = proof.commit(intent("pair"), |envelope| {
        envelope.insert_observation(observation(1, "decision-object-1"))?;
        envelope.insert_observation(observation(2, "decision-object-1"))?;
        Ok(String::new())
    });
    let check = |proof: &Proof| {
        let slice = proof.store().slice_as_of(receipt.commit_seq).unwrap();
        let pair = slice
            .observations
            .iter()
            .filter(|row| row.created_commit_seq == receipt.commit_seq)
            .map(|row| row.observation_id.clone())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            pair,
            BTreeSet::from(["observation-1".to_string(), "observation-2".to_string()])
        );
        let earlier = proof.store().slice_as_of(receipt.commit_seq - 1).unwrap();
        assert!(earlier.observations.is_empty());
        let alignment = proof.store().alignment_as_of(receipt.commit_seq).unwrap();
        assert_eq!(alignment.rows.len(), 2);
    };
    check(&proof);
    proof.restart();
    check(&proof);
}
