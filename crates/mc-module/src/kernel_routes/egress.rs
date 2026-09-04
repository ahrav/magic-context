//! `kernel.egress.decide`: whether an artifact may be handed to a provider,
//! decided from stored facts, the caller's own sensitivity assertion, and the
//! owning object's project scope. The decision is a value with no way to
//! dispatch, so a refusal is also proof that no request was made.

use mc_host::RouteHandle;
use mc_kernel::{
    ArtifactDestination, ArtifactEgressFacts, ArtifactEligibility, EligibilityDeniedReason,
    KernelError, KernelStore, Sensitivity,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::project::{stored_terms, ProjectBinding, ScopeFilter};
use super::{blocking, kernel_response, state_only, KernelOutcome};
use crate::dispatch::PreparedOutcome;
use crate::McHandler;

const OPERATION: &str = "kernel.egress.decide";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressDecision {
    Allowed,
    Refused(RefusalReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// The caller asserted a class laxer than the stored one.
    UnderDeclared,
    /// The owning object does not tie the artifact to the bound project: it is
    /// scoped elsewhere, cites other evidence, or is no longer live.
    WrongScope,
    Eligibility(EligibilityDeniedReason),
}

impl RefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnderDeclared => "under_declared",
            Self::WrongScope => "wrong_scope",
            Self::Eligibility(EligibilityDeniedReason::UnknownSensitive) => "unknown_sensitive",
            Self::Eligibility(EligibilityDeniedReason::SensitiveRemote) => "sensitive_remote",
            Self::Eligibility(EligibilityDeniedReason::ProviderRestricted) => "provider_restricted",
            Self::Eligibility(EligibilityDeniedReason::Secret) => "secret",
            Self::Eligibility(EligibilityDeniedReason::Tombstoned) => "tombstoned",
        }
    }
}

impl EgressDecision {
    pub fn to_json(self) -> Value {
        match self {
            Self::Allowed => json!("allowed"),
            Self::Refused(reason) => json!({"refused": reason.as_str()}),
        }
    }
}

/// A secret never leaves, whatever the caller asserted; an assertion laxer
/// than the stored class is refused as under-declaration before the
/// destination-specific denial it would otherwise map to, so the caller
/// learns its assertion was wrong rather than only that the destination was.
pub fn decide_egress(
    facts: &ArtifactEgressFacts,
    asserted: Sensitivity,
    scope_matches: bool,
) -> EgressDecision {
    if facts.eligibility == ArtifactEligibility::Denied(EligibilityDeniedReason::Secret) {
        return EgressDecision::Refused(RefusalReason::Eligibility(
            EligibilityDeniedReason::Secret,
        ));
    }
    if facts
        .stored_class
        .is_some_and(|(stored, _)| stored > asserted)
    {
        return EgressDecision::Refused(RefusalReason::UnderDeclared);
    }
    match facts.eligibility {
        ArtifactEligibility::Denied(reason) => {
            EgressDecision::Refused(RefusalReason::Eligibility(reason))
        }
        ArtifactEligibility::Allowed if !scope_matches => {
            EgressDecision::Refused(RefusalReason::WrongScope)
        }
        ArtifactEligibility::Allowed => EgressDecision::Allowed,
    }
}

#[derive(Debug, Deserialize)]
struct EgressRequest {
    artifact_digest: String,
    destination: String,
    asserted_sensitivity: Sensitivity,
    owning_object_id: String,
}

fn parse_destination(value: &str) -> Option<ArtifactDestination> {
    match value {
        "local" => Some(ArtifactDestination::Local),
        "remote" => Some(ArtifactDestination::Remote),
        _ => None,
    }
}

fn evaluate(
    store: &KernelStore,
    project: &ProjectBinding,
    request: &EgressRequest,
    destination: ArtifactDestination,
) -> Result<EgressDecision, KernelOutcome> {
    // The artifact's class and the owner's citation are read in one snapshot,
    // so an ingest that reclassifies the digest cannot land between them.
    let (_, mut candidates) = store
        .egress_candidates(
            &[(
                request.owning_object_id.clone(),
                Some(request.artifact_digest.clone()),
            )],
            destination,
        )
        .map_err(KernelOutcome::from)?;
    let candidate = candidates.pop().ok_or(KernelError::Io)?;
    let facts = candidate.artifact.ok_or(KernelError::Io)?;
    // Only a live, unsuperseded owner vouches. A retired or replaced object's
    // registry row still carries its scope and citation, so a candidate
    // retracted after selection would otherwise still be dispatched.
    let owner = candidate.state.as_ref().filter(|state| {
        state.object.invalidated_commit_seq.is_none() && state.object.superseded_by.is_none()
    });
    // Without the citation check any own-project object id would authorize
    // any digest.
    let cites_artifact = owner
        .and_then(|state| state.artifact_digest.as_deref())
        .is_some_and(|digest| digest == request.artifact_digest);
    let scope_id = owner.and_then(|state| state.scope_id.as_deref());
    let scope_matches = cites_artifact
        && ScopeFilter::new(project)
            .matches(scope_id, &mut stored_terms(store))
            .map_err(KernelOutcome::from)?;
    Ok(decide_egress(
        &facts,
        request.asserted_sensitivity,
        scope_matches,
    ))
}

impl McHandler {
    pub(crate) async fn handle_kernel_egress_decide(
        &self,
        channel: RouteHandle,
        request: &Value,
    ) -> PreparedOutcome {
        let scope = match self.kernel_route_scope(channel, request, OPERATION) {
            Ok(scope) => scope,
            Err(outcome) => return outcome,
        };
        let parsed = match serde_json::from_value::<EgressRequest>(request.clone()) {
            Ok(parsed) => parsed,
            Err(error) => {
                return crate::invalid_params_error(format!("invalid {OPERATION}: {error}"))
            }
        };
        let Some(destination) = parse_destination(&parsed.destination) else {
            return crate::invalid_params_error(format!(
                "{OPERATION} destination must be local or remote"
            ));
        };
        let store = scope.store;
        let project = scope.project;
        let decision =
            match blocking(move || evaluate(&store, &project, &parsed, destination)).await {
                Ok(Ok(decision)) => decision,
                Ok(Err(outcome)) | Err(outcome) => return state_only(outcome),
            };
        kernel_response(
            &KernelOutcome::Available,
            json!({"decision": decision.to_json()}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mc_kernel::ProviderEgress;

    fn facts(
        eligibility: ArtifactEligibility,
        stored_class: Option<(Sensitivity, ProviderEgress)>,
    ) -> ArtifactEgressFacts {
        ArtifactEgressFacts {
            eligibility,
            stored_class,
        }
    }

    const REMOTE_OK: ArtifactEligibility = ArtifactEligibility::Allowed;

    #[test]
    fn a_secret_is_refused_before_anything_else_is_consulted() {
        let secret = facts(
            ArtifactEligibility::Denied(EligibilityDeniedReason::Secret),
            Some((Sensitivity::Secret, ProviderEgress::RemoteAllowed)),
        );
        for asserted in Sensitivity::ALL {
            for scope_matches in [true, false] {
                assert_eq!(
                    decide_egress(&secret, *asserted, scope_matches),
                    EgressDecision::Refused(RefusalReason::Eligibility(
                        EligibilityDeniedReason::Secret
                    ))
                );
            }
        }
    }

    #[test]
    fn under_declaration_is_refused_before_the_destination_denial() {
        let sensitive_remote = facts(
            ArtifactEligibility::Denied(EligibilityDeniedReason::SensitiveRemote),
            Some((Sensitivity::Sensitive, ProviderEgress::RemoteAllowed)),
        );
        assert_eq!(
            decide_egress(&sensitive_remote, Sensitivity::Normal, true),
            EgressDecision::Refused(RefusalReason::UnderDeclared)
        );
        assert_eq!(
            decide_egress(&sensitive_remote, Sensitivity::Sensitive, true),
            EgressDecision::Refused(RefusalReason::Eligibility(
                EligibilityDeniedReason::SensitiveRemote
            ))
        );
        // Locally the same artifact is eligible, but the assertion is still wrong.
        let sensitive_local = facts(
            REMOTE_OK,
            Some((Sensitivity::Sensitive, ProviderEgress::RemoteAllowed)),
        );
        assert_eq!(
            decide_egress(&sensitive_local, Sensitivity::Normal, true),
            EgressDecision::Refused(RefusalReason::UnderDeclared)
        );
        assert_eq!(
            decide_egress(&sensitive_local, Sensitivity::Sensitive, true),
            EgressDecision::Allowed
        );
        // Over-declaring is not under-declaring.
        let normal = facts(
            REMOTE_OK,
            Some((Sensitivity::Normal, ProviderEgress::RemoteAllowed)),
        );
        assert_eq!(
            decide_egress(&normal, Sensitivity::Sensitive, true),
            EgressDecision::Allowed
        );
    }

    #[test]
    fn eligibility_denials_precede_scope_and_scope_precedes_allowed() {
        for reason in [
            EligibilityDeniedReason::UnknownSensitive,
            EligibilityDeniedReason::ProviderRestricted,
            EligibilityDeniedReason::Tombstoned,
        ] {
            let denied = facts(ArtifactEligibility::Denied(reason), None);
            for scope_matches in [true, false] {
                assert_eq!(
                    decide_egress(&denied, Sensitivity::Normal, scope_matches),
                    EgressDecision::Refused(RefusalReason::Eligibility(reason)),
                    "{reason:?}"
                );
            }
        }
        let normal = facts(
            REMOTE_OK,
            Some((Sensitivity::Normal, ProviderEgress::RemoteAllowed)),
        );
        assert_eq!(
            decide_egress(&normal, Sensitivity::Normal, false),
            EgressDecision::Refused(RefusalReason::WrongScope)
        );
        assert_eq!(
            decide_egress(&normal, Sensitivity::Normal, true),
            EgressDecision::Allowed
        );
    }

    #[test]
    fn wire_shape_is_allowed_or_a_snake_case_refusal() {
        assert_eq!(EgressDecision::Allowed.to_json(), json!("allowed"));
        assert_eq!(
            EgressDecision::Refused(RefusalReason::UnderDeclared).to_json(),
            json!({"refused": "under_declared"})
        );
        assert_eq!(
            EgressDecision::Refused(RefusalReason::Eligibility(
                EligibilityDeniedReason::UnknownSensitive
            ))
            .to_json(),
            json!({"refused": "unknown_sensitive"})
        );
    }
}
