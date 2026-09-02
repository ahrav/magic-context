//! Randomized operation model: one generated history is run clean in root A
//! and perturbed in root B (duplicates, restarts, faulted-then-retried
//! commits), then both roots must agree under the cross-root digest and every
//! envelope commit in B must expose exactly the object set the in-memory
//! reference model predicts at that `commit_seq`.
//!
//! Steps are self-contained (`{ op, duplicate_after, restart_after,
//! fault_then_retry }`) so proptest can delete any step and the remaining
//! history still shrinks to a valid one. Operation targets are abstract
//! indices resolved against the model's live sets when the step runs; a
//! target with no live candidate falls back to a fresh domain insert so every
//! step does real work in both roots.
//!
//! Operations split by capability, because their idempotency mechanisms
//! differ: envelope operations return a `CommitReceipt` and replay by intent;
//! CAS operations are idempotent by digest and intent; control operations are
//! idempotent under double invocation. Only envelope operations feed the
//! reference object set, and only object kinds envelope operations create are
//! compared, so CAS effects on the registry never leak into the comparison.
//! Applicability and read-repair are excluded: their identities embed the
//! absolute checkout path, so two roots can never agree on them. Secret
//! artifacts are excluded too: redaction rewrites their bytes before the CAS
//! write, so the reference model could not predict the stored object.

use std::collections::BTreeMap;

use mc_kernel::{Envelope, EventKind, KernelError, Sensitivity};
use proptest::prelude::*;

use crate::canonical_state::{digest, Profile};
use crate::fixtures::{
    admit_request, admitted_domain, code_observation, decision, deletion, domain, ingest, intent,
    observation, root_domain, staging, subject_request, LEASE_MS,
};
use crate::harness::Proof;

/// Abstract operation with unresolved targets.
#[derive(Debug, Clone)]
pub enum Op {
    InsertDomain,
    CorrectDomain(u8),
    RetireDomain(u8),
    Stage,
    Admit(u8),
    Reject(u8),
    Supersede(u8),
    InsertDecision,
    InsertObservation(u8),
    CorrectDecision(u8),
    Ingest { sensitive: bool },
    Delete(u8),
    RegisterConsumer,
    Acknowledge(u8),
    RebuildAlignment,
}

#[derive(Debug, Clone)]
pub struct Step {
    pub op: Op,
    pub duplicate_after: bool,
    pub restart_after: bool,
    pub fault_then_retry: bool,
}

pub fn step() -> impl Strategy<Value = Step> {
    let op = prop_oneof![
        3 => Just(Op::InsertDomain),
        2 => any::<u8>().prop_map(Op::CorrectDomain),
        1 => any::<u8>().prop_map(Op::RetireDomain),
        2 => Just(Op::Stage),
        2 => any::<u8>().prop_map(Op::Admit),
        1 => any::<u8>().prop_map(Op::Reject),
        1 => any::<u8>().prop_map(Op::Supersede),
        2 => Just(Op::InsertDecision),
        2 => any::<u8>().prop_map(Op::InsertObservation),
        1 => any::<u8>().prop_map(Op::CorrectDecision),
        2 => any::<bool>().prop_map(|sensitive| Op::Ingest { sensitive }),
        1 => any::<u8>().prop_map(Op::Delete),
        1 => Just(Op::RegisterConsumer),
        1 => any::<u8>().prop_map(Op::Acknowledge),
        1 => Just(Op::RebuildAlignment),
    ];
    (op, any::<bool>(), any::<bool>(), any::<bool>()).prop_map(
        |(op, duplicate_after, restart_after, fault_then_retry)| Step {
            op,
            duplicate_after,
            restart_after,
            fault_then_retry,
        },
    )
}

/// Object kinds the reference set tracks; every other kind belongs to CAS.
const TRACKED_KINDS: &[&str] = &["domain", "decision", "observation"];

/// What the reference model predicts `known_as_of` reports for a live object.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Expected {
    kind: &'static str,
    created_commit_seq: i64,
}

type ObjectSet = BTreeMap<String, Expected>;

/// Live sets a run resolves abstract targets against, plus the reference
/// object set keyed by envelope `commit_seq`.
#[derive(Default)]
struct Model {
    next: usize,
    domains: Vec<String>,
    admitted: Vec<String>,
    staged: Vec<String>,
    decisions: Vec<String>,
    artifacts: Vec<(String, String)>,
    consumers: Vec<String>,
    objects: ObjectSet,
    expected: BTreeMap<i64, ObjectSet>,
    staged_at: i64,
}

impl Model {
    /// The identifier ordinal the next landed operation uses. A faulted
    /// attempt peeks at it without consuming it, so the retry that follows
    /// mints exactly the identifiers the fault attempted.
    fn ordinal(&mut self, attempt: Attempt) -> usize {
        match attempt {
            Attempt::Fault => self.next + 1,
            Attempt::Land => {
                self.next += 1;
                self.next
            }
        }
    }

    fn pick(items: &[String], index: u8) -> Option<&String> {
        (!items.is_empty()).then(|| &items[usize::from(index) % items.len()])
    }

    fn add(&mut self, object_id: String, kind: &'static str, created_commit_seq: i64) {
        self.objects.insert(
            object_id,
            Expected {
                kind,
                created_commit_seq,
            },
        );
    }
}

/// Whether an application should land or be driven through the fault hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attempt {
    Land,
    Fault,
}

/// What one applied step left behind for the perturbation flags to reuse.
enum Applied {
    /// A landed envelope commit: `commit_seq` plus the recorded intent index
    /// a duplicate replays.
    Envelope { commit_seq: i64, intent: usize },
    /// A CAS or control call; the closure repeats the exact same call.
    Repeat(Box<dyn Fn(&Proof)>),
}

pub struct Outcome {
    pub duplicates_replayed: usize,
    pub faults_injected: usize,
}

/// Runs `steps` clean in A and perturbed in B and asserts the two agree.
pub fn run(steps: &[Step]) -> Outcome {
    let staged_at = crate::fixtures::now_ms();
    let mut clean = Proof::open();
    let mut clean_model = Model {
        staged_at,
        ..Model::default()
    };
    seed(&mut clean, &mut clean_model);
    for step in steps {
        apply(&mut clean, &mut clean_model, &step.op, Attempt::Land);
    }
    check_reference(&clean, &clean_model);

    let mut perturbed = Proof::open();
    let mut model = Model {
        staged_at,
        ..Model::default()
    };
    seed(&mut perturbed, &mut model);
    let mut outcome = Outcome {
        duplicates_replayed: 0,
        faults_injected: 0,
    };
    for step in steps {
        if step.fault_then_retry && supports_fault(&step.op, &model) {
            outcome.faults_injected += 1;
            assert!(
                apply(&mut perturbed, &mut model, &step.op, Attempt::Fault).is_none(),
                "a faulted attempt landed"
            );
        }
        let applied = apply(&mut perturbed, &mut model, &step.op, Attempt::Land)
            .expect("a landing attempt applies");
        if step.duplicate_after {
            let before = perturbed.digest();
            match &applied {
                Applied::Envelope { commit_seq, intent } => {
                    let receipt = perturbed.replay(*intent);
                    assert!(
                        receipt.replayed,
                        "duplicate intent was not served as a replay"
                    );
                    assert_eq!(receipt.commit_seq, *commit_seq);
                    outcome.duplicates_replayed += 1;
                }
                Applied::Repeat(again) => again(&perturbed),
            }
            assert_eq!(
                perturbed.digest(),
                before,
                "duplicate changed canonical state"
            );
        }
        if step.restart_after {
            perturbed.restart();
        }
    }
    check_reference(&perturbed, &model);
    digest(perturbed.path(), Profile::CrossRoot).assert_same(
        &digest(clean.path(), Profile::CrossRoot),
        "perturbed history diverged from the clean run",
    );
    outcome
}

fn seed(proof: &mut Proof, model: &mut Model) {
    let (receipt, _) = proof.commit(intent("seed-domain"), |envelope| {
        envelope.insert_domain(root_domain())?;
        Ok(String::new())
    });
    model.add(root_domain().object_id, "domain", receipt.commit_seq);
}

/// Envelope operations fault through the rollback hook; a deletion with a
/// live artifact faults before its reference commit. Everything else has no
/// fault window the kernel exposes.
fn supports_fault(op: &Op, model: &Model) -> bool {
    match op {
        Op::Stage | Op::Ingest { .. } | Op::RebuildAlignment => false,
        Op::Acknowledge(_) => model.consumers.is_empty(),
        _ => true,
    }
}

/// Applies `op` once; `None` is a faulted attempt that landed nothing. The
/// model advances only on a landing application, so a faulted attempt and the
/// retry after it resolve to the same identifiers.
///
/// Resolution happens inside each arm so the concrete identifiers a duplicate
/// or fault reuses are the ones the model recorded.
fn apply(proof: &mut Proof, model: &mut Model, op: &Op, attempt: Attempt) -> Option<Applied> {
    match op {
        Op::InsertDomain => insert_domain(proof, model, attempt),
        Op::CorrectDomain(index) => {
            let Some(old) = Model::pick(&model.domains, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let replacement = domain(model.ordinal(attempt));
            let key = format!("correct-{old}-{}", replacement.object_id);
            let (target, spec) = (old.clone(), replacement.clone());
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.correct_domain(&target, spec)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, seq| {
                model.domains.retain(|id| id != &old);
                model.objects.remove(&old);
                model.domains.push(replacement.object_id.clone());
                model.add(replacement.object_id, "domain", seq);
            })
        }
        Op::RetireDomain(index) => {
            let Some(old) = Model::pick(&model.domains, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let key = format!("retire-{old}");
            let target = old.clone();
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.retire_domain(&target)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, _| {
                model.domains.retain(|id| id != &old);
                model.objects.remove(&old);
            })
        }
        Op::Stage => {
            let index = model.ordinal(Attempt::Land);
            let run = format!("run-{index}");
            let candidate = format!("candidate-{index}");
            let mut spec = staging(&run, &candidate, &format!("name-{candidate}"));
            spec.recorded_at = model.staged_at;
            spec.lease_expires_at = model.staged_at + LEASE_MS;
            proof.store().stage_candidate(spec.clone()).unwrap();
            model.staged.push(candidate);
            Some(Applied::Repeat(Box::new(move |proof| {
                proof.store().stage_candidate(spec.clone()).unwrap();
            })))
        }
        Op::Admit(index) => {
            let Some(candidate) = Model::pick(&model.staged, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let trigger = code_observation(&candidate);
            let observation_id = trigger.object_id.clone();
            let admitted = admitted_domain(&candidate, &format!("name-{candidate}"));
            let key = format!("admit-{candidate}");
            let (candidate_id, spec) = (candidate.clone(), admitted.clone());
            let applied = envelope(proof, &key, attempt, move |envelope| {
                let request = admit_request(&candidate_id, &trigger.observation_id);
                envelope.insert_observation(trigger)?;
                let decision = envelope.admit_domain_candidate(request, spec)?;
                Ok(decision.admission_decision_id)
            });
            record_envelope(model, applied, |model, seq| {
                model.staged.retain(|id| id != &candidate);
                model.admitted.push(admitted.object_id.clone());
                model.add(observation_id, "observation", seq);
                model.add(admitted.object_id, "domain", seq);
            })
        }
        Op::Reject(index) => {
            let Some(candidate) = Model::pick(&model.staged, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let key = format!("reject-{candidate}");
            let candidate_id = candidate.clone();
            let applied = envelope(proof, &key, attempt, move |envelope| {
                let mut request = admit_request(&candidate_id, "");
                request.source_class = Some(mc_kernel::SourceClass::UntrustedRepoText);
                request.taint_class = Some(mc_kernel::TaintClass::RepoUntrustedText);
                request.event.kind = EventKind::ExplicitReject;
                request.event.trigger_object_id = None;
                envelope.record_admission(request)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, _| {
                model.staged.retain(|id| id != &candidate);
            })
        }
        Op::Supersede(index) => {
            let Some(old) = Model::pick(&model.admitted, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let successor = model.ordinal(attempt);
            let replacement = admitted_domain(&format!("successor-{successor}"), "successor");
            let key = format!("supersede-{old}-{successor}");
            let (target, spec) = (old.clone(), replacement.clone());
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.supersede_domain(subject_request(&target, EventKind::Replace), spec)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, seq| {
                model.admitted.retain(|id| id != &old);
                model.objects.remove(&old);
                model.add(replacement.object_id, "domain", seq);
            })
        }
        Op::InsertDecision => {
            let index = model.ordinal(attempt);
            let spec = decision(index);
            let key = format!("decision-{index}");
            let object_id = spec.object_id.clone();
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.insert_decision(spec)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, seq| {
                model.decisions.push(object_id.clone());
                model.add(object_id, "decision", seq);
            })
        }
        Op::InsertObservation(index) => {
            let Some(target) = Model::pick(&model.decisions, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let ordinal = model.ordinal(attempt);
            let spec = observation(ordinal, &target);
            let key = format!("observation-{ordinal}");
            let object_id = spec.object_id.clone();
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.insert_observation(spec)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, seq| {
                model.add(object_id, "observation", seq);
            })
        }
        Op::CorrectDecision(index) => {
            let Some(old) = Model::pick(&model.decisions, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let ordinal = model.ordinal(attempt);
            let spec = decision(ordinal);
            let key = format!("correct-decision-{old}-{ordinal}");
            let (target, replacement, object_id) =
                (old.clone(), spec.clone(), spec.object_id.clone());
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.correct_decision(&target, replacement)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, seq| {
                model.decisions.retain(|id| id != &old);
                model.objects.remove(&old);
                model.decisions.push(object_id.clone());
                model.add(object_id, "decision", seq);
            })
        }
        Op::Ingest { sensitive } => {
            let index = model.ordinal(Attempt::Land);
            let key = format!("artifact-{index}");
            let sensitivity = if *sensitive {
                Sensitivity::Sensitive
            } else {
                Sensitivity::Normal
            };
            let request = ingest(&key, key.as_bytes(), sensitivity);
            let handle = proof.store().ingest_artifact(request.clone()).unwrap();
            model.artifacts.push((key, handle.digest.clone()));
            Some(Applied::Repeat(Box::new(move |proof| {
                let again = proof.store().ingest_artifact(request.clone()).unwrap();
                assert_eq!(again.digest, handle.digest);
            })))
        }
        Op::Delete(index) => {
            if model.artifacts.is_empty() {
                return insert_domain(proof, model, attempt);
            }
            let (key, digest) =
                model.artifacts[usize::from(*index) % model.artifacts.len()].clone();
            let request = deletion(&format!("delete-{key}"), &digest);
            if attempt == Attempt::Fault {
                proof.fault_deletion(request);
                return None;
            }
            let result = proof
                .store()
                .delete_artifact(request.clone())
                .unwrap_or_else(|error| panic!("delete {key}: {error:?}"));
            assert!(!result.already_applied);
            model.artifacts.retain(|(k, _)| k != &key);
            Some(Applied::Repeat(Box::new(move |proof| {
                let again = proof.store().delete_artifact(request.clone()).unwrap();
                assert!(again.already_applied, "duplicate deletion applied again");
                assert_eq!(again.commit_seq, result.commit_seq);
            })))
        }
        Op::RegisterConsumer => {
            let index = model.ordinal(attempt);
            let consumer = format!("consumer-{index}");
            let key = format!("register-{consumer}");
            let id = consumer.clone();
            let applied = envelope(proof, &key, attempt, move |envelope| {
                envelope.register_outbox_consumer(&id, 10)?;
                Ok(String::new())
            });
            record_envelope(model, applied, |model, _| {
                model.consumers.push(consumer);
            })
        }
        Op::Acknowledge(index) => {
            let Some(consumer) = Model::pick(&model.consumers, *index).cloned() else {
                return insert_domain(proof, model, attempt);
            };
            let tip = proof.tip();
            proof
                .store()
                .acknowledge_outbox(&consumer, tip, 20)
                .unwrap();
            Some(Applied::Repeat(Box::new(move |proof| {
                proof
                    .store()
                    .acknowledge_outbox(&consumer, tip, 20)
                    .unwrap();
            })))
        }
        Op::RebuildAlignment => {
            proof.store().rebuild_alignment().unwrap();
            Some(Applied::Repeat(Box::new(|proof| {
                proof.store().rebuild_alignment().unwrap();
            })))
        }
    }
}

fn insert_domain(proof: &mut Proof, model: &mut Model, attempt: Attempt) -> Option<Applied> {
    let index = model.ordinal(attempt);
    let spec = domain(index);
    let key = format!("insert-{index}");
    let object_id = spec.object_id.clone();
    let applied = envelope(proof, &key, attempt, move |envelope| {
        envelope.insert_domain(spec)?;
        Ok(String::new())
    });
    record_envelope(model, applied, |model, seq| {
        model.domains.push(object_id.clone());
        model.add(object_id, "domain", seq);
    })
}

/// Commits (or faults) one envelope operation under `key`. A landed commit
/// yields `(commit_seq, replayed, intent index)`; a faulted attempt yields
/// `None`.
fn envelope(
    proof: &mut Proof,
    key: &str,
    attempt: Attempt,
    operation: impl FnOnce(&mut Envelope<'_>) -> Result<String, KernelError>,
) -> Option<(i64, bool, usize)> {
    if attempt == Attempt::Fault {
        proof.fault(intent(key), operation);
        return None;
    }
    let (receipt, index) = proof.commit(intent(key), operation);
    Some((receipt.commit_seq, receipt.replayed, index))
}

/// Advances the model for a freshly landed commit and records the expected
/// object set at its `commit_seq`. Every key the model mints is unique, so a
/// first application served as a replay is a kernel defect, not a state to
/// absorb.
fn record_envelope(
    model: &mut Model,
    applied: Option<(i64, bool, usize)>,
    advance: impl FnOnce(&mut Model, i64),
) -> Option<Applied> {
    let (commit_seq, replayed, intent) = applied?;
    assert!(
        !replayed,
        "first application at {commit_seq} was served as a replay"
    );
    advance(model, commit_seq);
    model.expected.insert(commit_seq, model.objects.clone());
    Some(Applied::Envelope { commit_seq, intent })
}

/// Compares `known_as_of` with the reference at every recorded envelope
/// commit and at the tip, so the last step's effect is checked even when it
/// was not an envelope operation.
fn check_reference(proof: &Proof, model: &Model) {
    assert!(
        !model.expected.is_empty(),
        "history landed no envelope commit"
    );
    let tip = proof.tip();
    for (commit_seq, expected) in model.expected.iter().chain([(&tip, &model.objects)]) {
        let actual = proof
            .store()
            .known_as_of(*commit_seq)
            .unwrap()
            .objects
            .into_iter()
            .filter_map(|row| {
                let kind = TRACKED_KINDS
                    .iter()
                    .find(|kind| **kind == row.object_kind)
                    .copied()?;
                Some((
                    row.object_id,
                    Expected {
                        kind,
                        created_commit_seq: row.created_commit_seq,
                    },
                ))
            })
            .collect::<ObjectSet>();
        assert_eq!(&actual, expected, "object set at commit_seq {commit_seq}");
    }
}
