//! `kernel.commit`: one idempotent envelope carrying a typed operation list,
//! checked against the caller's mutation tokens inside the same transaction
//! that applies it.
//!
//! Writes arriving here are classified server-side from `source_kind`; a
//! caller may lower the derived class but never raise it, and the resulting
//! pair must satisfy the kernel's admission rules. Every written row is
//! stamped with the bound project's scope and admitted under the derived
//! classes, so visibility follows the kernel's admission rules rather than
//! anything the caller asserts.

use std::time::{Duration, Instant};

use mc_host::RouteHandle;
use mc_kernel::{
    AdmissionEvent, AdmissionRequest, CommitIntent, CommitReceipt, DecisionPayload, DecisionSpec,
    Envelope, EventKind, KernelError, KernelStore, ObjectState, ObservationDependencySpec,
    ObservationPayload, ObservationSpec, Sensitivity, SourceClass, TaintClass, TokenCheck,
    TokenConflict, ALIGNMENT_DEPENDENCY_KIND,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::project::{IntentRequest, ProjectBinding, ScopeFilter};
use super::{blocking, kernel_response, state_only, ConflictReason, InvalidReason, KernelOutcome};
use crate::dispatch::PreparedOutcome;
use crate::McHandler;

const OPERATION: &str = "kernel.commit";
/// Namespace of this route's receipts within a project.
const RECEIPT_FAMILY: &str = "commit";
const DEFAULT_DEADLINE: Duration = Duration::from_secs(5);
const MAX_DEADLINE: Duration = Duration::from_secs(30);
/// The whole envelope runs inside one exclusive-writer transaction and
/// `deadline_ms` bounds only writer acquisition, so the operation count is
/// what bounds how long the writer is held.
const MAX_OPERATIONS: usize = 256;
/// Each token is one registry lookup inside the same writer transaction.
const MAX_TOKENS: usize = 1024;
/// Dependencies are summed across every observation in the request, since
/// each one is validated and inserted inside the same writer transaction.
pub const MAX_DEPENDENCIES: usize = 1024;
/// Reason recorded on the admission decision of every route-written object.
const ADMISSION_REASON: &str = "kernel.commit";

#[derive(Debug, Deserialize)]
struct CommitRequest {
    intent: IntentRequest,
    #[serde(default)]
    tokens: Vec<TokenRequest>,
    operations: Vec<Operation>,
    source_kind: String,
    #[serde(default)]
    asserted_source_class: Option<String>,
    #[serde(default)]
    asserted_taint_class: Option<String>,
    #[serde(default)]
    deadline_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenRequest {
    object_id: String,
    known_as_of: i64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    InsertDecision {
        spec: DecisionRequest,
    },
    SupersedeDecision {
        replaced_object_id: String,
        spec: DecisionRequest,
    },
    RetireDecision {
        object_id: String,
    },
    InsertObservation {
        spec: ObservationRequest,
    },
}

/// A decision as the wire carries it: `source_kind` comes from the request
/// and `scope_id` from the binding, so neither is accepted per row.
#[derive(Debug, Clone, Deserialize)]
struct DecisionRequest {
    decision_id: String,
    object_id: String,
    domain_id: String,
    #[serde(default)]
    proposition_id: Option<String>,
    #[serde(default)]
    anchor_id: Option<String>,
    #[serde(default)]
    evidence_id: Option<String>,
    decision_kind: String,
    payload: DecisionPayload,
    source_id: String,
    source_revision: i64,
    #[serde(default)]
    sensitivity: Option<Sensitivity>,
}

impl DecisionRequest {
    fn into_spec(self, source_kind: &str, scope_id: &str) -> DecisionSpec {
        DecisionSpec {
            decision_id: self.decision_id,
            object_id: self.object_id,
            domain_id: self.domain_id,
            proposition_id: self.proposition_id,
            scope_id: Some(scope_id.to_string()),
            anchor_id: self.anchor_id,
            evidence_id: self.evidence_id,
            decision_kind: self.decision_kind,
            payload: self.payload,
            source_kind: source_kind.to_string(),
            source_id: self.source_id,
            source_revision: self.source_revision,
            sensitivity: self.sensitivity.unwrap_or(Sensitivity::Normal),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ObservationRequest {
    observation_id: String,
    object_id: String,
    domain_id: String,
    #[serde(default)]
    proposition_id: Option<String>,
    #[serde(default)]
    anchor_id: Option<String>,
    #[serde(default)]
    evidence_id: Option<String>,
    observation_kind: String,
    payload: ObservationPayload,
    observed_at: i64,
    #[serde(default)]
    dependencies: Vec<DependencyRequest>,
    source_id: String,
    source_revision: i64,
    #[serde(default)]
    sensitivity: Option<Sensitivity>,
}

#[derive(Debug, Clone, Deserialize)]
struct DependencyRequest {
    dependency_object_id: String,
    dependency_kind: String,
    #[serde(default)]
    dependency_payload: Option<String>,
}

impl ObservationRequest {
    fn into_spec(self, source_kind: &str, scope_id: &str) -> ObservationSpec {
        ObservationSpec {
            observation_id: self.observation_id,
            object_id: self.object_id,
            domain_id: self.domain_id,
            proposition_id: self.proposition_id,
            scope_id: Some(scope_id.to_string()),
            anchor_id: self.anchor_id,
            evidence_id: self.evidence_id,
            observation_kind: self.observation_kind,
            payload: self.payload,
            observed_at: self.observed_at,
            dependencies: self
                .dependencies
                .into_iter()
                .map(|dependency| ObservationDependencySpec {
                    dependency_object_id: dependency.dependency_object_id,
                    dependency_kind: dependency.dependency_kind,
                    dependency_payload: dependency.dependency_payload,
                })
                .collect(),
            source_kind: source_kind.to_string(),
            source_id: self.source_id,
            source_revision: self.source_revision,
            sensitivity: self.sensitivity.unwrap_or(Sensitivity::Normal),
        }
    }
}

/// The closed table from a plugin route's `source_kind` to admission classes.
/// Everything a plugin relays is model output about something, so the source
/// class is always `ModelInference`; the taint class records what it is about.
pub(crate) fn derive_classes(source_kind: &str) -> Option<(SourceClass, TaintClass)> {
    match source_kind {
        "assistant" | "model" => {
            Some((SourceClass::ModelInference, TaintClass::AssistantInference))
        }
        "dreamer" => Some((SourceClass::ModelInference, TaintClass::DreamerInference)),
        "user" => Some((SourceClass::ModelInference, TaintClass::UserInferred)),
        _ => None,
    }
}

/// Lower is more trusted.
const fn source_rank(class: SourceClass) -> u8 {
    match class {
        SourceClass::ExplicitUser => 0,
        SourceClass::TrustedLocalCode => 1,
        SourceClass::TrustedToolResult => 2,
        SourceClass::UntrustedRepoText => 3,
        SourceClass::UntrustedWeb => 4,
        SourceClass::ModelInference => 5,
    }
}

/// Lower is more trusted.
const fn taint_rank(class: TaintClass) -> u8 {
    match class {
        TaintClass::UserExplicit => 0,
        TaintClass::CurrentCode | TaintClass::CurrentTest | TaintClass::CurrentConfig => 1,
        TaintClass::UserInferred => 2,
        TaintClass::RepoUntrustedText | TaintClass::ToolUntrustedOutput => 3,
        TaintClass::AssistantInference | TaintClass::DreamerInference => 4,
        TaintClass::Personal | TaintClass::Unclassifiable => 5,
    }
}

/// The classes a write is admitted under: the derived pair, lowered to any
/// asserted class that ranks at or below it. An assertion above the derived
/// class is refused rather than clamped so the caller learns its claim was not
/// accepted. A pair forbidden by the kernel's admission table is malformed
/// input.
pub(crate) fn resolve_classes(
    source_kind: &str,
    asserted_source: Option<&str>,
    asserted_taint: Option<&str>,
) -> Result<(SourceClass, TaintClass), InvalidReason> {
    let (derived_source, derived_taint) =
        derive_classes(source_kind).ok_or(InvalidReason::InvalidInput)?;
    let source = match asserted_source {
        None => derived_source,
        Some(asserted) => {
            let asserted =
                SourceClass::try_from(asserted).map_err(|_| InvalidReason::InvalidInput)?;
            if source_rank(asserted) < source_rank(derived_source) {
                return Err(InvalidReason::ClassOverDeclared);
            }
            asserted
        }
    };
    let taint = match asserted_taint {
        None => derived_taint,
        Some(asserted) => {
            let asserted =
                TaintClass::try_from(asserted).map_err(|_| InvalidReason::InvalidInput)?;
            if taint_rank(asserted) < taint_rank(derived_taint) {
                return Err(InvalidReason::ClassOverDeclared);
            }
            asserted
        }
    };
    if !source.allows(taint) {
        return Err(InvalidReason::InvalidInput);
    }
    Ok((source, taint))
}

struct CommitPlan {
    intent: CommitIntent,
    tokens: Vec<TokenRequest>,
    operations: Vec<Operation>,
    source_kind: String,
    classes: (SourceClass, TaintClass),
    project: ProjectBinding,
    deadline: Duration,
}

enum CommitFailure {
    Kernel(KernelError),
    Token(TokenConflict),
    OperationKeyReused,
    /// A storage constraint (a duplicate `object_id` or `decision_id`, a
    /// broken reference) rejected a write inside the envelope.
    StorageConstraint,
    /// A successor's revision did not advance past its predecessor's.
    RevisionNotAdvanced,
    /// The store holds a scope under this project's reserved id whose terms
    /// name a different project.
    ScopeReserved,
}

impl From<CommitFailure> for KernelOutcome {
    fn from(failure: CommitFailure) -> Self {
        match failure {
            CommitFailure::Kernel(error) => Self::from(error),
            CommitFailure::Token(TokenConflict::Advanced) => {
                Self::conflict(ConflictReason::KnownAsOfAdvanced)
            }
            CommitFailure::Token(TokenConflict::Retracted) => {
                Self::conflict(ConflictReason::Retracted)
            }
            CommitFailure::Token(TokenConflict::Superseded) => {
                Self::conflict(ConflictReason::Superseded)
            }
            CommitFailure::OperationKeyReused => Self::invalid(InvalidReason::OperationKeyReused),
            CommitFailure::StorageConstraint => Self::invalid(InvalidReason::AlreadyExists),
            CommitFailure::RevisionNotAdvanced => Self::invalid(InvalidReason::RevisionNotAdvanced),
            CommitFailure::ScopeReserved => Self::invalid(InvalidReason::ScopeReserved),
        }
    }
}

/// The receipt's result payload; a replay reads it back from the receipt.
#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct CommitResult {
    /// Every object the envelope wrote or re-pointed; each becomes a token.
    touched: Vec<String>,
    /// Each id identifies a survivor whose replacement spec names an existing
    /// live decision. The kernel discards that spec's content and only
    /// re-points the predecessor, leaving the survivor's row unchanged.
    merged: Vec<String>,
}

impl CommitResult {
    fn normalize(&mut self) {
        self.touched.sort();
        self.touched.dedup();
        self.merged.sort();
        self.merged.dedup();
    }
}

fn admit(
    envelope: &mut Envelope<'_>,
    object_id: &str,
    (source_class, taint_class): (SourceClass, TaintClass),
) -> Result<(), KernelError> {
    envelope.record_admission(AdmissionRequest {
        candidate_id: None,
        subject_object_id: Some(object_id.to_string()),
        source_class: Some(source_class),
        taint_class: Some(taint_class),
        event: AdmissionEvent {
            kind: EventKind::Other,
            trigger_object_id: None,
            approval_object_id: None,
            evidence_id: None,
            reason: ADMISSION_REASON.to_string(),
        },
    })?;
    Ok(())
}

/// Materializes the project scope the first time an operation needs it; the
/// check and the insert share the envelope's transaction, so two commits for
/// a new project cannot both insert it.
fn ensure_scope(
    envelope: &mut Envelope<'_>,
    project: &ProjectBinding,
    domain_id: &str,
    ready: &mut bool,
    refused: &mut Option<CommitFailure>,
) -> Result<(), KernelError> {
    if *ready {
        return Ok(());
    }
    let expected = project.scope_spec(domain_id);
    match envelope.scope_terms(&expected.scope_id)? {
        None => {
            envelope.insert_scope(expected)?;
        }
        Some(terms) if terms == expected.terms => {}
        Some(_) => {
            *refused = Some(CommitFailure::ScopeReserved);
            return Err(KernelError::Conflict);
        }
    }
    *ready = true;
    Ok(())
}

/// The object, when its scope names the bound project by the same algebra
/// `kernel.read` serves rows with, so every row a read hands a token for is
/// a row the same route may mutate. Returning `NotFound` for an out-of-scope
/// object, the same answer a missing object gets, prevents cross-project
/// object-id enumeration.
fn scoped_object_state(
    envelope: &Envelope<'_>,
    filter: &mut ScopeFilter,
    object_id: &str,
) -> Result<ObjectState, KernelError> {
    let state = envelope
        .object_state(object_id)?
        .ok_or(KernelError::NotFound)?;
    if !filter.matches(state.scope_id.as_deref(), &mut |scope_id| {
        envelope.scope_terms(scope_id)
    })? {
        return Err(KernelError::NotFound);
    }
    Ok(state)
}

/// `refused` records why `apply` returns `KernelError::Conflict`, since the
/// kernel raises that same error for storage constraints.
fn apply(
    envelope: &mut Envelope<'_>,
    filter: &mut ScopeFilter,
    plan: &CommitPlan,
    refused: &mut Option<CommitFailure>,
) -> Result<String, KernelError> {
    let scope_id = plan.project.scope_id();
    let mut scope_ready = false;
    let mut result = CommitResult::default();
    for operation in &plan.operations {
        match operation {
            Operation::InsertDecision { spec } => {
                ensure_scope(
                    envelope,
                    &plan.project,
                    &spec.domain_id,
                    &mut scope_ready,
                    refused,
                )?;
                let spec = spec.clone().into_spec(&plan.source_kind, &scope_id);
                let outcome = envelope.insert_decision(spec)?;
                admit(envelope, &outcome.object_id, plan.classes)?;
                result.touched.push(outcome.object_id);
            }
            Operation::SupersedeDecision {
                replaced_object_id,
                spec,
            } => {
                ensure_scope(
                    envelope,
                    &plan.project,
                    &spec.domain_id,
                    &mut scope_ready,
                    refused,
                )?;
                let predecessor = scoped_object_state(envelope, filter, replaced_object_id)?;
                // A live replacement must belong to the bound project too. Its
                // stored revision, not the spec's, is what the kernel compares.
                let (replacement_live, successor_revision) =
                    match envelope.object_state(&spec.object_id)? {
                        Some(state) if state.object.invalidated_commit_seq.is_none() => {
                            scoped_object_state(envelope, filter, &spec.object_id)?;
                            (true, state.object.source_revision)
                        }
                        _ => (false, spec.source_revision),
                    };
                if successor_revision <= predecessor.object.source_revision {
                    *refused = Some(CommitFailure::RevisionNotAdvanced);
                    return Err(KernelError::Conflict);
                }
                let spec = spec.clone().into_spec(&plan.source_kind, &scope_id);
                let outcome = envelope.supersede_decision(replaced_object_id, spec)?;
                if replacement_live {
                    result.merged.push(outcome.object_id.clone());
                } else {
                    admit(envelope, &outcome.object_id, plan.classes)?;
                }
                result.touched.push(replaced_object_id.clone());
                result.touched.push(outcome.object_id);
            }
            Operation::RetireDecision { object_id } => {
                scoped_object_state(envelope, filter, object_id)?;
                envelope.retire_decision(object_id)?;
                result.touched.push(object_id.clone());
            }
            Operation::InsertObservation { spec } => {
                ensure_scope(
                    envelope,
                    &plan.project,
                    &spec.domain_id,
                    &mut scope_ready,
                    refused,
                )?;
                // The alignment projection pairs an observation with the
                // decision its `implements` dependency names without comparing
                // scopes, so a foreign target would let this project alter
                // another project's derived results. Other dependency kinds
                // may cite any live registry object, as the kernel allows.
                for dependency in &spec.dependencies {
                    if dependency.dependency_kind == ALIGNMENT_DEPENDENCY_KIND {
                        scoped_object_state(envelope, filter, &dependency.dependency_object_id)?;
                    }
                }
                let spec = spec.clone().into_spec(&plan.source_kind, &scope_id);
                let outcome = envelope.insert_observation(spec)?;
                admit(envelope, &outcome.object_id, plan.classes)?;
                result.touched.push(outcome.object_id);
            }
        }
    }
    result.normalize();
    serde_json::to_string(&result).map_err(|_| KernelError::InvalidInput)
}

fn run(store: &KernelStore, plan: CommitPlan) -> Result<CommitReceipt, CommitFailure> {
    let mut entered = false;
    let mut refused = None;
    let mut filter = ScopeFilter::new(&plan.project);
    let result = store.commit_before(
        Instant::now() + plan.deadline,
        plan.intent.clone(),
        |envelope| {
            entered = true;
            for token in &plan.tokens {
                scoped_object_state(envelope, &mut filter, &token.object_id)?;
                if let TokenCheck::Conflict(conflict) =
                    envelope.check_token(&token.object_id, token.known_as_of)?
                {
                    refused = Some(CommitFailure::Token(conflict));
                    return Err(KernelError::Conflict);
                }
            }
            apply(envelope, &mut filter, &plan, &mut refused)
        },
    );
    match result {
        Ok(receipt) => Ok(receipt),
        Err(KernelError::Conflict) => match refused {
            Some(failure) => Err(failure),
            // The receipt lookup runs before the operation, so a conflict
            // raised without entering it is a reused `operation_key`.
            None if !entered => Err(CommitFailure::OperationKeyReused),
            None => Err(CommitFailure::StorageConstraint),
        },
        Err(error) => Err(CommitFailure::Kernel(error)),
    }
}

impl McHandler {
    pub(crate) async fn handle_kernel_commit(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        let scope = match self.kernel_route_scope(channel, request, OPERATION) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let parsed = match serde_json::from_value::<CommitRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => {
                return crate::invalid_params_error(format!("invalid {OPERATION}: {error}"))
            }
        };
        if parsed.operations.len() > MAX_OPERATIONS {
            return crate::invalid_params_error(format!(
                "{OPERATION} carries at most {MAX_OPERATIONS} operations"
            ));
        }
        if parsed.tokens.len() > MAX_TOKENS {
            return crate::invalid_params_error(format!(
                "{OPERATION} carries at most {MAX_TOKENS} tokens"
            ));
        }
        let dependencies: usize = parsed
            .operations
            .iter()
            .map(|operation| match operation {
                Operation::InsertObservation { spec } => spec.dependencies.len(),
                _ => 0,
            })
            .sum();
        if dependencies > MAX_DEPENDENCIES {
            return crate::invalid_params_error(format!(
                "{OPERATION} carries at most {MAX_DEPENDENCIES} observation dependencies"
            ));
        }
        let classes = match resolve_classes(
            &parsed.source_kind,
            parsed.asserted_source_class.as_deref(),
            parsed.asserted_taint_class.as_deref(),
        ) {
            Ok(classes) => classes,
            Err(reason) => return state_only(KernelOutcome::invalid(reason)),
        };
        let Some(intent) = parsed.intent.into_intent(&scope.project, RECEIPT_FAMILY) else {
            return crate::invalid_params_error(format!(
                "{OPERATION} intent.operation_key must not be blank"
            ));
        };
        let deadline = parsed
            .deadline_ms
            .map_or(DEFAULT_DEADLINE, Duration::from_millis)
            .min(MAX_DEADLINE);
        let plan = CommitPlan {
            intent,
            tokens: parsed.tokens,
            operations: parsed.operations,
            source_kind: parsed.source_kind,
            classes,
            project: scope.project,
            deadline,
        };
        let store = scope.store;
        let receipt = match blocking(move || run(&store, plan)).await {
            Ok(Ok(receipt)) => receipt,
            Ok(Err(failure)) => return state_only(KernelOutcome::from(failure)),
            Err(outcome) => return state_only(outcome),
        };
        let result: CommitResult =
            serde_json::from_str(&receipt.result).unwrap_or_else(|_| CommitResult::default());
        let tokens: Vec<Value> = result
            .touched
            .iter()
            .map(|object_id| json!({"object_id": object_id, "known_as_of": receipt.commit_seq}))
            .collect();
        kernel_response(
            &KernelOutcome::Available,
            json!({
                "receipt": {"commit_seq": receipt.commit_seq, "replayed": receipt.replayed},
                "known_as_of": receipt.commit_seq,
                "tokens": tokens,
                "merged": result.merged,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugin_write_is_capped_at_inference_classes() {
        assert_eq!(
            resolve_classes("assistant", None, None),
            Ok((SourceClass::ModelInference, TaintClass::AssistantInference))
        );
        assert_eq!(
            resolve_classes("assistant", Some("explicit_user"), None),
            Err(InvalidReason::ClassOverDeclared)
        );
        assert_eq!(
            resolve_classes("assistant", None, Some("current_code")),
            Err(InvalidReason::ClassOverDeclared)
        );
        // Lowering is allowed; an unknown class or source kind is malformed input.
        assert_eq!(
            resolve_classes("user", None, Some("personal")),
            Ok((SourceClass::ModelInference, TaintClass::Personal))
        );
        assert_eq!(
            resolve_classes("assistant", Some("oracle"), None),
            Err(InvalidReason::InvalidInput)
        );
        assert_eq!(
            resolve_classes("oracle", None, None),
            Err(InvalidReason::InvalidInput)
        );
    }

    #[test]
    fn every_source_class_has_one_rank() {
        let mut ranks: Vec<u8> = SourceClass::ALL
            .iter()
            .map(|class| source_rank(*class))
            .collect();
        ranks.sort_unstable();
        ranks.dedup();
        assert_eq!(ranks.len(), SourceClass::ALL.len());
        assert_eq!(source_rank(SourceClass::ModelInference), 5);
        assert!(TaintClass::ALL
            .iter()
            .all(|class| taint_rank(*class) <= taint_rank(TaintClass::Personal)));
    }

    #[test]
    fn a_pair_is_accepted_exactly_when_not_raised_and_legal_for_admission() {
        for source_kind in ["assistant", "model", "dreamer", "user"] {
            let (derived_source, derived_taint) = derive_classes(source_kind).unwrap();
            for source in SourceClass::ALL {
                for taint in TaintClass::ALL {
                    let outcome =
                        resolve_classes(source_kind, Some(source.as_str()), Some(taint.as_str()));
                    let raised = source_rank(*source) < source_rank(derived_source)
                        || taint_rank(*taint) < taint_rank(derived_taint);
                    let expected = if raised {
                        Err(InvalidReason::ClassOverDeclared)
                    } else if source.allows(*taint) {
                        Ok((*source, *taint))
                    } else {
                        Err(InvalidReason::InvalidInput)
                    };
                    assert_eq!(outcome, expected, "{source_kind} {source:?} {taint:?}");
                }
            }
        }
        // `user` derives a pair the table forbids only once lowered to a
        // repo or tool taint.
        assert!(resolve_classes("user", None, None).is_ok());
        assert_eq!(
            resolve_classes("user", None, Some("repo_untrusted_text")),
            Err(InvalidReason::InvalidInput)
        );
        assert_eq!(
            resolve_classes("user", None, Some("tool_untrusted_output")),
            Err(InvalidReason::InvalidInput)
        );
    }

    #[test]
    fn the_result_payload_round_trips_and_tolerates_an_unreadable_receipt() {
        let mut result = CommitResult {
            touched: vec!["b".to_string(), "a".to_string(), "b".to_string()],
            merged: vec!["c".to_string(), "c".to_string()],
        };
        result.normalize();
        assert_eq!(result.touched, ["a", "b"]);
        assert_eq!(result.merged, ["c"]);
        let encoded = serde_json::to_string(&result).unwrap();
        assert_eq!(
            serde_json::from_str::<CommitResult>(&encoded).unwrap(),
            result
        );
        assert_eq!(
            serde_json::from_str::<CommitResult>("[\"a\"]").unwrap_or_default(),
            CommitResult::default()
        );
    }
}
