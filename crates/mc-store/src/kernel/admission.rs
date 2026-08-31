use super::{KernelError, Sensitivity};

pub const POLICY_REVISION: i64 = 1;
#[cfg(test)]
const REVISION_1_SOURCE_DIGEST: &str =
    "2fc4df110aa4199e8f9abebe6d06bde0000a21648512d8022bafc8831bfe4f94";

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }

        impl TryFrom<&str> for $name {
            type Error = KernelError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(KernelError::AdmissionPolicy),
                }
            }
        }
    };
}

string_enum!(Maturity {
    Candidate => "candidate",
    Corroborated => "corroborated",
    Verified => "verified",
    Approved => "approved",
    Enforced => "enforced",
});

string_enum!(SourceClass {
    ExplicitUser => "explicit_user",
    TrustedLocalCode => "trusted_local_code",
    TrustedToolResult => "trusted_tool_result",
    UntrustedRepoText => "untrusted_repo_text",
    UntrustedWeb => "untrusted_web",
    ModelInference => "model_inference",
});

string_enum!(TaintClass {
    UserExplicit => "user_explicit",
    UserInferred => "user_inferred",
    CurrentCode => "current_code",
    CurrentTest => "current_test",
    CurrentConfig => "current_config",
    RepoUntrustedText => "repo_untrusted_text",
    ToolUntrustedOutput => "tool_untrusted_output",
    AssistantInference => "assistant_inference",
    DreamerInference => "dreamer_inference",
    Personal => "personal",
    Unclassifiable => "unclassifiable",
});

string_enum!(Disposition {
    Active => "active",
    Stale => "stale",
    Disputed => "disputed",
    Superseded => "superseded",
    Rejected => "rejected",
    Contradicted => "contradicted",
    Quarantined => "quarantined",
});

string_enum!(EventKind {
    ExplicitReject => "explicit_reject",
    Correct => "correct",
    Replace => "replace",
    AcceptedAdr => "accepted_adr",
    CodeObserved => "code_observed",
    ConfigObserved => "config_observed",
    Corroborate => "corroborate",
    Verify => "verify",
    Approve => "approve",
    Enforce => "enforce",
    ApprovalRevoked => "approval_revoked",
    MarkStale => "mark_stale",
    MarkDisputed => "mark_disputed",
    Contradict => "contradict",
    Quarantine => "quarantine",
    Other => "other",
});

string_enum!(VisibilityRow {
    ExplicitLabeled => "explicit_labeled",
    Automatic => "automatic",
    ReviewOnly => "review_only",
    AuditOnly => "audit_only",
});

string_enum!(Surface {
    AutoInject => "auto_inject",
    AutoSearch => "auto_search",
    ExplicitSearch => "explicit_search",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceVisibility {
    Hidden,
    Visible,
    Labeled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionEvent {
    pub kind: EventKind,
    pub approval_object_id: Option<String>,
    pub evidence_id: Option<String>,
    pub reason: String,
}

string_enum!(Outcome {
    Admit => "admit",
    Deny => "deny",
    Promote => "promote",
    DemoteSupport => "demote_support",
    Reject => "reject",
    Correct => "correct",
    Replace => "replace",
    Quarantine => "quarantine",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriorDecision {
    pub historical_maturity: Maturity,
    pub effective_maturity: Maturity,
    pub disposition: Disposition,
    pub outcome: Outcome,
    pub source_class: SourceClass,
    pub taint_class: TaintClass,
    pub sensitivity: Sensitivity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvaluationInputs {
    pub source_class: SourceClass,
    pub taint_class: TaintClass,
    pub prior: Option<PriorDecision>,
    pub candidate_sensitivity: Sensitivity,
    pub predecessor_sensitivity: Option<Sensitivity>,
    pub approval_valid: bool,
    pub event: EventKind,
    pub has_evidence: bool,
    pub remaining_support: Option<Maturity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectiveMaturity(Maturity);

impl EffectiveMaturity {
    pub const fn get(self) -> Maturity {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Evaluation {
    pub historical_maturity: Maturity,
    pub effective_maturity: EffectiveMaturity,
    pub disposition: Disposition,
    pub visibility: VisibilityRow,
    pub sensitivity: Sensitivity,
    pub outcome: Outcome,
}

// policy-digest:evaluator-start
pub fn evaluate_admission(input: EvaluationInputs) -> Result<Evaluation, KernelError> {
    if !source_allows_taint(input.source_class, input.taint_class) {
        return Err(KernelError::AdmissionPolicy);
    }
    if input.prior.is_some_and(|prior| {
        prior.source_class != input.source_class
            || prior.taint_class != input.taint_class
            || prior.effective_maturity.rank() > prior.historical_maturity.rank()
    }) {
        return Err(KernelError::AdmissionPolicy);
    }
    if input.event == EventKind::Enforce && !input.has_evidence {
        return Err(KernelError::AdmissionPolicy);
    }
    if matches!(input.event, EventKind::Correct | EventKind::Replace)
        && input.predecessor_sensitivity.is_none()
    {
        return Err(KernelError::AdmissionPolicy);
    }

    let current = input
        .prior
        .map_or(Maturity::Candidate, |prior| prior.historical_maturity);
    let current_effective = input
        .prior
        .map_or(Maturity::Candidate, |prior| prior.effective_maturity);
    let current_disposition = input
        .prior
        .map_or(Disposition::Active, |prior| prior.disposition);
    let remaining_support = match (input.event, input.remaining_support) {
        (EventKind::ApprovalRevoked, Some(remaining))
            if remaining.rank() <= current_effective.rank() =>
        {
            remaining
        }
        (EventKind::ApprovalRevoked, _) | (_, Some(_)) => {
            return Err(KernelError::AdmissionPolicy);
        }
        (_, None) => current_effective,
    };
    let ceiling = automatic_ceiling(input.source_class, input.taint_class);
    let (requested, requested_disposition, requested_outcome) = event_effect(input.event, current);
    let raises_support =
        event_can_raise_support(input.event) && requested.rank() > current_effective.rank();
    // A transition toward a less restrictive disposition requires approval.
    let relaxes_disposition = requested_disposition.is_some_and(|requested| {
        disposition_restrictiveness(requested) < disposition_restrictiveness(current_disposition)
    });
    let requires_approval = (event_can_raise_support(input.event)
        && (!auto_admit_event(input.event)
            || requested.rank() > admission_ceiling(input.event, ceiling).rank()))
        || relaxes_disposition;
    let denied = requires_approval && !input.approval_valid;
    let disposition = match requested_disposition {
        Some(requested) if !denied => requested,
        _ => current_disposition,
    };

    let target = if denied { current } else { requested };
    let historical = current.max(target);
    let supported = if input.event == EventKind::ApprovalRevoked {
        remaining_support
    } else if raises_support && !denied {
        requested
    } else {
        current_effective
    };
    // A non-active disposition withdraws support; history stays monotonic.
    let supported = if matches!(disposition, Disposition::Active) {
        supported
    } else {
        Maturity::Candidate
    };
    let effective = historical.min(supported);

    let sensitivity = sensitivity_floor(input.taint_class)
        .max(input.candidate_sensitivity)
        .max(
            input
                .prior
                .map_or(Sensitivity::Normal, |prior| prior.sensitivity),
        )
        .max(input.predecessor_sensitivity.unwrap_or(Sensitivity::Normal));

    let outcome = if denied {
        Outcome::Deny
    } else if historical.rank() > current.rank() || effective.rank() > current_effective.rank() {
        if input.prior.is_some() {
            Outcome::Promote
        } else {
            Outcome::Admit
        }
    } else {
        requested_outcome
    };

    let visibility = visibility_row(effective, disposition);

    Ok(Evaluation {
        historical_maturity: historical,
        effective_maturity: EffectiveMaturity(effective),
        disposition,
        visibility,
        sensitivity,
        outcome,
    })
}
// policy-digest:evaluator-end

// policy-digest:tables-start
impl Maturity {
    const fn rank(self) -> u8 {
        match self {
            Self::Candidate => 0,
            Self::Corroborated => 1,
            Self::Verified => 2,
            Self::Approved => 3,
            Self::Enforced => 4,
        }
    }

    const fn max(self, other: Self) -> Self {
        if self.rank() >= other.rank() {
            self
        } else {
            other
        }
    }

    const fn min(self, other: Self) -> Self {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }
}

pub const fn surface_visibility(
    row: VisibilityRow,
    surface: Surface,
    sensitivity: Sensitivity,
) -> SurfaceVisibility {
    if matches!(sensitivity, Sensitivity::Secret)
        || matches!(
            (sensitivity, surface),
            (
                Sensitivity::Sensitive,
                Surface::AutoInject | Surface::AutoSearch
            )
        )
    {
        return SurfaceVisibility::Hidden;
    }
    match (row, surface) {
        (VisibilityRow::Automatic, _) => SurfaceVisibility::Visible,
        (VisibilityRow::ExplicitLabeled, Surface::ExplicitSearch) => SurfaceVisibility::Labeled,
        _ => SurfaceVisibility::Hidden,
    }
}

// A `None` disposition leaves the prior disposition in place.
const fn event_effect(
    event: EventKind,
    current: Maturity,
) -> (Maturity, Option<Disposition>, Outcome) {
    match event {
        EventKind::ExplicitReject => (current, Some(Disposition::Rejected), Outcome::Reject),
        EventKind::Correct => (current, Some(Disposition::Superseded), Outcome::Correct),
        EventKind::Replace => (current, Some(Disposition::Superseded), Outcome::Replace),
        EventKind::AcceptedAdr | EventKind::Approve => (Maturity::Approved, None, Outcome::Promote),
        EventKind::Enforce => (Maturity::Enforced, None, Outcome::Promote),
        EventKind::CodeObserved | EventKind::ConfigObserved | EventKind::Verify => {
            (Maturity::Verified, None, Outcome::Promote)
        }
        EventKind::Corroborate => (Maturity::Corroborated, None, Outcome::Promote),
        EventKind::ApprovalRevoked => (current, None, Outcome::DemoteSupport),
        EventKind::MarkStale => (current, Some(Disposition::Stale), Outcome::Deny),
        EventKind::MarkDisputed => (current, Some(Disposition::Disputed), Outcome::Deny),
        EventKind::Contradict => (current, Some(Disposition::Contradicted), Outcome::Deny),
        EventKind::Quarantine => (current, Some(Disposition::Quarantined), Outcome::Quarantine),
        EventKind::Other => (current, None, Outcome::Deny),
    }
}

const fn disposition_restrictiveness(disposition: Disposition) -> u8 {
    match disposition {
        Disposition::Active => 0,
        Disposition::Stale | Disposition::Disputed | Disposition::Superseded => 1,
        Disposition::Rejected => 2,
        Disposition::Contradicted | Disposition::Quarantined => 3,
    }
}

const fn auto_admit_event(event: EventKind) -> bool {
    matches!(
        event,
        EventKind::ExplicitReject
            | EventKind::Correct
            | EventKind::Replace
            | EventKind::AcceptedAdr
            | EventKind::CodeObserved
            | EventKind::ConfigObserved
    )
}

const fn event_can_raise_support(event: EventKind) -> bool {
    matches!(
        event,
        EventKind::AcceptedAdr
            | EventKind::CodeObserved
            | EventKind::ConfigObserved
            | EventKind::Corroborate
            | EventKind::Verify
            | EventKind::Approve
            | EventKind::Enforce
    )
}

const fn automatic_ceiling(source: SourceClass, taint: TaintClass) -> Maturity {
    match (source, taint) {
        (SourceClass::ExplicitUser, TaintClass::UserExplicit | TaintClass::UserInferred)
        | (
            SourceClass::TrustedLocalCode | SourceClass::TrustedToolResult,
            TaintClass::CurrentCode | TaintClass::CurrentTest | TaintClass::CurrentConfig,
        ) => Maturity::Verified,
        (
            _,
            TaintClass::RepoUntrustedText
            | TaintClass::ToolUntrustedOutput
            | TaintClass::AssistantInference
            | TaintClass::DreamerInference
            | TaintClass::Personal
            | TaintClass::Unclassifiable,
        ) => Maturity::Candidate,
        _ => Maturity::Candidate,
    }
}

/// An accepted ADR with verified-or-higher automatic maturity reaches `Approved`
/// without a separate approval object.
const fn admission_ceiling(event: EventKind, automatic: Maturity) -> Maturity {
    match event {
        EventKind::AcceptedAdr if automatic.rank() >= Maturity::Verified.rank() => {
            Maturity::Approved
        }
        _ => automatic,
    }
}

const fn sensitivity_floor(taint: TaintClass) -> Sensitivity {
    match taint {
        TaintClass::Personal | TaintClass::Unclassifiable => Sensitivity::Sensitive,
        _ => Sensitivity::Normal,
    }
}

const fn visibility_row(maturity: Maturity, disposition: Disposition) -> VisibilityRow {
    match disposition {
        Disposition::Active if maturity.rank() >= Maturity::Verified.rank() => {
            VisibilityRow::Automatic
        }
        Disposition::Active
        | Disposition::Stale
        | Disposition::Disputed
        | Disposition::Superseded => VisibilityRow::ExplicitLabeled,
        Disposition::Rejected => VisibilityRow::ReviewOnly,
        Disposition::Contradicted | Disposition::Quarantined => VisibilityRow::AuditOnly,
    }
}

const fn source_allows_taint(source: SourceClass, taint: TaintClass) -> bool {
    match source {
        SourceClass::ExplicitUser => matches!(
            taint,
            TaintClass::UserExplicit | TaintClass::UserInferred | TaintClass::Personal
        ),
        SourceClass::TrustedLocalCode => matches!(
            taint,
            TaintClass::CurrentCode
                | TaintClass::CurrentTest
                | TaintClass::CurrentConfig
                | TaintClass::RepoUntrustedText
                | TaintClass::Personal
                | TaintClass::Unclassifiable
        ),
        SourceClass::TrustedToolResult => matches!(
            taint,
            TaintClass::CurrentCode
                | TaintClass::CurrentTest
                | TaintClass::CurrentConfig
                | TaintClass::ToolUntrustedOutput
                | TaintClass::Personal
                | TaintClass::Unclassifiable
        ),
        SourceClass::UntrustedRepoText => matches!(
            taint,
            TaintClass::RepoUntrustedText | TaintClass::Personal | TaintClass::Unclassifiable
        ),
        SourceClass::UntrustedWeb => matches!(
            taint,
            TaintClass::ToolUntrustedOutput | TaintClass::Personal | TaintClass::Unclassifiable
        ),
        SourceClass::ModelInference => matches!(
            taint,
            TaintClass::UserInferred
                | TaintClass::AssistantInference
                | TaintClass::DreamerInference
                | TaintClass::Personal
                | TaintClass::Unclassifiable
        ),
    }
}
// policy-digest:tables-end

const _: () = {
    assert!(Maturity::Candidate.rank() < Maturity::Corroborated.rank());
    assert!(Maturity::Corroborated.rank() < Maturity::Verified.rank());
    assert!(Maturity::Verified.rank() < Maturity::Approved.rank());
    assert!(Maturity::Approved.rank() < Maturity::Enforced.rank());
    assert!((Sensitivity::Normal as u8) < (Sensitivity::Sensitive as u8));
    assert!((Sensitivity::Sensitive as u8) < (Sensitivity::Secret as u8));
};

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn vocabularies_round_trip_and_reject_unknown_tokens() {
        macro_rules! check {
            ($type:ty) => {
                for value in <$type>::ALL {
                    assert_eq!(<$type>::try_from(value.as_str()), Ok(*value));
                }
                assert_eq!(
                    <$type>::try_from("unknown"),
                    Err(KernelError::AdmissionPolicy)
                );
            };
        }
        check!(Maturity);
        check!(SourceClass);
        check!(TaintClass);
        check!(Disposition);
        check!(EventKind);
        check!(VisibilityRow);
        check!(Surface);
        check!(Outcome);
    }

    #[test]
    fn every_legal_source_taint_pair_enforces_its_automatic_ceiling() {
        let mut legal_pairs = 0;
        for source_class in SourceClass::ALL {
            for taint_class in TaintClass::ALL {
                if !source_allows_taint(*source_class, *taint_class) {
                    continue;
                }
                legal_pairs += 1;
                let input = EvaluationInputs {
                    source_class: *source_class,
                    taint_class: *taint_class,
                    prior: None,
                    candidate_sensitivity: Sensitivity::Normal,
                    predecessor_sensitivity: None,
                    approval_valid: false,
                    event: EventKind::CodeObserved,
                    has_evidence: true,
                    remaining_support: None,
                };
                let automatic = evaluate_admission(input).unwrap();
                let expected = match (source_class, taint_class) {
                    (
                        SourceClass::ExplicitUser,
                        TaintClass::UserExplicit | TaintClass::UserInferred,
                    )
                    | (
                        SourceClass::TrustedLocalCode | SourceClass::TrustedToolResult,
                        TaintClass::CurrentCode
                        | TaintClass::CurrentTest
                        | TaintClass::CurrentConfig,
                    ) => Maturity::Verified,
                    _ => Maturity::Candidate,
                };
                assert_eq!(
                    automatic.historical_maturity, expected,
                    "{source_class:?}/{taint_class:?}"
                );
                assert_eq!(
                    evaluate_admission(EvaluationInputs {
                        approval_valid: true,
                        ..input
                    })
                    .unwrap()
                    .historical_maturity,
                    Maturity::Verified,
                    "{source_class:?}/{taint_class:?} with approval"
                );
            }
        }
        assert_eq!(legal_pairs, 26);
    }

    #[test]
    fn a_correction_requires_its_predecessor_sensitivity() {
        for event in [EventKind::Correct, EventKind::Replace] {
            let missing = EvaluationInputs {
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                prior: None,
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: None,
                approval_valid: true,
                event,
                has_evidence: true,
                remaining_support: None,
            };
            assert_eq!(
                evaluate_admission(missing),
                Err(KernelError::AdmissionPolicy),
                "{event:?}"
            );
            assert_eq!(
                evaluate_admission(EvaluationInputs {
                    predecessor_sensitivity: Some(Sensitivity::Secret),
                    ..missing
                })
                .unwrap()
                .sensitivity,
                Sensitivity::Secret,
                "{event:?}"
            );
        }
    }

    #[test]
    fn a_denied_transition_reports_denial_even_when_state_is_unchanged() {
        let prior = PriorDecision {
            historical_maturity: Maturity::Verified,
            effective_maturity: Maturity::Verified,
            disposition: Disposition::Active,
            outcome: Outcome::Admit,
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            sensitivity: Sensitivity::Normal,
        };
        let denied = evaluate_admission(EvaluationInputs {
            source_class: prior.source_class,
            taint_class: prior.taint_class,
            prior: Some(prior),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::Approve,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(denied.outcome, Outcome::Deny);
        assert_eq!(denied.historical_maturity, Maturity::Verified);
        assert_eq!(denied.effective_maturity.get(), Maturity::Verified);

        let repeated = evaluate_admission(EvaluationInputs {
            source_class: prior.source_class,
            taint_class: prior.taint_class,
            prior: Some(PriorDecision {
                outcome: Outcome::Deny,
                ..prior
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::Approve,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(repeated.outcome, Outcome::Deny);
    }

    #[test]
    fn an_authority_event_requires_approval_even_at_an_unchanged_rung() {
        let base = EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: Some(Sensitivity::Normal),
            approval_valid: false,
            event: EventKind::Other,
            has_evidence: true,
            remaining_support: None,
        };
        let settled = PriorDecision {
            historical_maturity: Maturity::Approved,
            effective_maturity: Maturity::Approved,
            disposition: Disposition::Active,
            outcome: Outcome::Promote,
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            sensitivity: Sensitivity::Normal,
        };
        for (prior, event) in [
            (settled, EventKind::Approve),
            (
                PriorDecision {
                    historical_maturity: Maturity::Enforced,
                    effective_maturity: Maturity::Enforced,
                    ..settled
                },
                EventKind::Enforce,
            ),
        ] {
            let unauthorized = EvaluationInputs {
                prior: Some(prior),
                event,
                ..base
            };
            let result = evaluate_admission(unauthorized).unwrap();
            assert_eq!(result.outcome, Outcome::Deny, "{event:?}");

            let authorized = evaluate_admission(EvaluationInputs {
                approval_valid: true,
                ..unauthorized
            })
            .unwrap();
            assert_eq!(authorized.outcome, prior.outcome, "{event:?}");
        }
    }

    #[test]
    fn only_closed_auto_admit_event_set_avoids_approval() {
        for event in EventKind::ALL {
            let result = evaluate_admission(EvaluationInputs {
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                prior: None,
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: Some(Sensitivity::Normal),
                approval_valid: false,
                event: *event,
                has_evidence: true,
                remaining_support: (*event == EventKind::ApprovalRevoked)
                    .then_some(Maturity::Candidate),
            });
            let result = result.unwrap();
            let admitted = matches!(
                event,
                EventKind::CodeObserved | EventKind::ConfigObserved | EventKind::AcceptedAdr
            );
            assert_eq!(
                result.historical_maturity.rank() > Maturity::Candidate.rank(),
                admitted,
                "{event:?}"
            );
        }
    }

    #[test]
    fn accepted_adr_admits_deterministic_sources_without_a_separate_approval() {
        let deterministic = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::AcceptedAdr,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(deterministic.historical_maturity, Maturity::Approved);
        assert_eq!(deterministic.effective_maturity.get(), Maturity::Approved);
        assert_eq!(deterministic.outcome, Outcome::Admit);

        // A source held to `Candidate` still requires an approval object.
        let inferred = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::ModelInference,
            taint_class: TaintClass::AssistantInference,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::AcceptedAdr,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(inferred.historical_maturity, Maturity::Candidate);
        assert_eq!(inferred.outcome, Outcome::Deny);
    }

    #[test]
    fn inference_ceiling_requires_authority_and_lifts_only_to_event_target() {
        let base = EvaluationInputs {
            source_class: SourceClass::ModelInference,
            taint_class: TaintClass::AssistantInference,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::Verify,
            has_evidence: true,
            remaining_support: None,
        };
        assert_eq!(
            evaluate_admission(base).unwrap().historical_maturity,
            Maturity::Candidate
        );
        assert_eq!(
            evaluate_admission(base).unwrap().disposition,
            Disposition::Active
        );
        assert_eq!(
            evaluate_admission(EvaluationInputs {
                approval_valid: true,
                ..base
            })
            .unwrap()
            .historical_maturity,
            Maturity::Verified
        );
    }

    #[test]
    fn support_loss_demotes_effective_maturity_without_rewriting_history() {
        let result = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::ModelInference,
            taint_class: TaintClass::AssistantInference,
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Approved,
                effective_maturity: Maturity::Approved,
                disposition: Disposition::Active,
                outcome: Outcome::Promote,
                source_class: SourceClass::ModelInference,
                taint_class: TaintClass::AssistantInference,
                sensitivity: Sensitivity::Normal,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::ApprovalRevoked,
            has_evidence: false,
            remaining_support: Some(Maturity::Candidate),
        })
        .unwrap();
        assert_eq!(result.historical_maturity, Maturity::Approved);
        assert_eq!(result.effective_maturity.get(), Maturity::Candidate);
        assert_eq!(result.outcome, Outcome::DemoteSupport);

        let later = evaluate_admission(EvaluationInputs {
            prior: Some(PriorDecision {
                historical_maturity: result.historical_maturity,
                effective_maturity: result.effective_maturity.get(),
                disposition: result.disposition,
                outcome: result.outcome,
                source_class: SourceClass::ModelInference,
                taint_class: TaintClass::AssistantInference,
                sensitivity: result.sensitivity,
            }),
            event: EventKind::Other,
            ..EvaluationInputs {
                source_class: SourceClass::ModelInference,
                taint_class: TaintClass::AssistantInference,
                prior: None,
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: None,
                approval_valid: false,
                event: EventKind::Other,
                has_evidence: false,
                remaining_support: None,
            }
        })
        .unwrap();
        assert_eq!(later.effective_maturity.get(), Maturity::Candidate);
        assert_eq!(later.visibility, VisibilityRow::ExplicitLabeled);
    }

    #[test]
    fn restrictive_disposition_and_origin_classification_are_sticky() {
        let prior = PriorDecision {
            historical_maturity: Maturity::Candidate,
            effective_maturity: Maturity::Candidate,
            disposition: Disposition::Rejected,
            outcome: Outcome::Reject,
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            sensitivity: Sensitivity::Normal,
        };
        let observed = evaluate_admission(EvaluationInputs {
            source_class: prior.source_class,
            taint_class: prior.taint_class,
            prior: Some(prior),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::CodeObserved,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(observed.disposition, Disposition::Rejected);
        assert_eq!(observed.visibility, VisibilityRow::ReviewOnly);

        assert_eq!(
            evaluate_admission(EvaluationInputs {
                source_class: SourceClass::ModelInference,
                taint_class: TaintClass::AssistantInference,
                prior: Some(prior),
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: None,
                approval_valid: false,
                event: EventKind::Other,
                has_evidence: false,
                remaining_support: None,
            }),
            Err(KernelError::AdmissionPolicy)
        );

        let quarantined = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::ModelInference,
            taint_class: TaintClass::AssistantInference,
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Approved,
                effective_maturity: Maturity::Candidate,
                disposition: Disposition::Active,
                outcome: Outcome::DemoteSupport,
                source_class: SourceClass::ModelInference,
                taint_class: TaintClass::AssistantInference,
                sensitivity: Sensitivity::Normal,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::Quarantine,
            has_evidence: false,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(quarantined.disposition, Disposition::Quarantined);
        assert_eq!(quarantined.effective_maturity.get(), Maturity::Candidate);
    }

    #[test]
    fn visibility_matrix_and_sensitivity_ceiling_are_total() {
        for maturity in Maturity::ALL {
            for disposition in Disposition::ALL {
                let row = visibility_row(*maturity, *disposition);
                for surface in Surface::ALL {
                    assert_eq!(
                        surface_visibility(row, *surface, Sensitivity::Secret),
                        SurfaceVisibility::Hidden
                    );
                }
            }
        }
        assert_eq!(
            surface_visibility(
                VisibilityRow::Automatic,
                Surface::AutoInject,
                Sensitivity::Sensitive
            ),
            SurfaceVisibility::Hidden
        );
        assert_eq!(
            surface_visibility(
                VisibilityRow::Automatic,
                Surface::ExplicitSearch,
                Sensitivity::Sensitive
            ),
            SurfaceVisibility::Visible
        );
    }

    #[test]
    fn personal_and_unclassifiable_never_resolve_to_normal() {
        for taint_class in [TaintClass::Personal, TaintClass::Unclassifiable] {
            let result = evaluate_admission(EvaluationInputs {
                source_class: SourceClass::ModelInference,
                taint_class,
                prior: None,
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: None,
                approval_valid: false,
                event: EventKind::Other,
                has_evidence: false,
                remaining_support: None,
            })
            .unwrap();
            assert!(result.sensitivity >= Sensitivity::Sensitive);
        }
    }

    #[test]
    fn relaxing_a_restrictive_disposition_requires_approval() {
        for prior_disposition in [
            Disposition::Rejected,
            Disposition::Contradicted,
            Disposition::Quarantined,
        ] {
            let prior = PriorDecision {
                historical_maturity: Maturity::Candidate,
                effective_maturity: Maturity::Candidate,
                disposition: prior_disposition,
                outcome: Outcome::Deny,
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                sensitivity: Sensitivity::Normal,
            };
            for event in EventKind::ALL {
                let result = evaluate_admission(EvaluationInputs {
                    source_class: prior.source_class,
                    taint_class: prior.taint_class,
                    prior: Some(prior),
                    candidate_sensitivity: Sensitivity::Normal,
                    predecessor_sensitivity: Some(Sensitivity::Normal),
                    approval_valid: false,
                    event: *event,
                    has_evidence: true,
                    remaining_support: (*event == EventKind::ApprovalRevoked)
                        .then_some(Maturity::Candidate),
                })
                .unwrap();
                assert!(
                    disposition_restrictiveness(result.disposition)
                        >= disposition_restrictiveness(prior_disposition),
                    "{prior_disposition:?} relaxed to {:?} by unapproved {event:?}",
                    result.disposition
                );
            }
        }

        let approved = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Candidate,
                effective_maturity: Maturity::Candidate,
                disposition: Disposition::Quarantined,
                outcome: Outcome::Quarantine,
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                sensitivity: Sensitivity::Normal,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: true,
            event: EventKind::MarkStale,
            has_evidence: false,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(approved.disposition, Disposition::Stale);
    }

    #[test]
    fn prior_with_effective_above_historical_is_rejected() {
        assert_eq!(
            evaluate_admission(EvaluationInputs {
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                prior: Some(PriorDecision {
                    historical_maturity: Maturity::Candidate,
                    effective_maturity: Maturity::Enforced,
                    disposition: Disposition::Active,
                    outcome: Outcome::Admit,
                    source_class: SourceClass::TrustedLocalCode,
                    taint_class: TaintClass::CurrentCode,
                    sensitivity: Sensitivity::Normal,
                }),
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: None,
                approval_valid: false,
                event: EventKind::Enforce,
                has_evidence: false,
                remaining_support: None,
            }),
            Err(KernelError::AdmissionPolicy)
        );
    }

    #[test]
    fn approval_revocation_never_raises_effective_maturity() {
        let result = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Approved,
                effective_maturity: Maturity::Candidate,
                disposition: Disposition::Active,
                outcome: Outcome::DemoteSupport,
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                sensitivity: Sensitivity::Normal,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::ApprovalRevoked,
            has_evidence: false,
            remaining_support: Some(Maturity::Candidate),
        })
        .unwrap();
        assert_eq!(result.effective_maturity.get(), Maturity::Candidate);
    }

    #[test]
    fn approval_revocation_requires_and_preserves_remaining_support() {
        let base = EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Approved,
                effective_maturity: Maturity::Approved,
                disposition: Disposition::Active,
                outcome: Outcome::Promote,
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                sensitivity: Sensitivity::Normal,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::ApprovalRevoked,
            has_evidence: false,
            remaining_support: None,
        };
        assert_eq!(evaluate_admission(base), Err(KernelError::AdmissionPolicy));

        let unsupported = evaluate_admission(EvaluationInputs {
            remaining_support: Some(Maturity::Enforced),
            ..base
        });
        assert_eq!(unsupported, Err(KernelError::AdmissionPolicy));

        for remaining in [Maturity::Candidate, Maturity::Corroborated] {
            let result = evaluate_admission(EvaluationInputs {
                remaining_support: Some(remaining),
                ..base
            })
            .unwrap();
            assert_eq!(result.effective_maturity.get(), remaining);
            assert_eq!(result.outcome, Outcome::DemoteSupport);
        }
    }

    #[test]
    fn correction_and_replacement_are_distinct_effects() {
        for (prior_outcome, event, expected) in [
            (Outcome::Correct, EventKind::Replace, Outcome::Replace),
            (Outcome::Replace, EventKind::Correct, Outcome::Correct),
        ] {
            let result = evaluate_admission(EvaluationInputs {
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                prior: Some(PriorDecision {
                    historical_maturity: Maturity::Verified,
                    effective_maturity: Maturity::Candidate,
                    disposition: Disposition::Superseded,
                    outcome: prior_outcome,
                    source_class: SourceClass::TrustedLocalCode,
                    taint_class: TaintClass::CurrentCode,
                    sensitivity: Sensitivity::Normal,
                }),
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: Some(Sensitivity::Normal),
                approval_valid: false,
                event,
                has_evidence: false,
                remaining_support: None,
            })
            .unwrap();
            assert_eq!(result.outcome, expected);
        }
    }

    #[test]
    fn repeated_events_keep_their_requested_outcome() {
        let first = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::CodeObserved,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(first.outcome, Outcome::Admit);

        let replay = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: Some(PriorDecision {
                historical_maturity: first.historical_maturity,
                effective_maturity: first.effective_maturity.get(),
                disposition: first.disposition,
                outcome: first.outcome,
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                sensitivity: first.sensitivity,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::CodeObserved,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(replay.outcome, Outcome::Promote);
    }

    #[test]
    fn enforce_without_evidence_is_invalid_regardless_of_approval() {
        for approval_valid in [false, true] {
            assert_eq!(
                evaluate_admission(EvaluationInputs {
                    source_class: SourceClass::TrustedLocalCode,
                    taint_class: TaintClass::CurrentCode,
                    prior: None,
                    candidate_sensitivity: Sensitivity::Normal,
                    predecessor_sensitivity: None,
                    approval_valid,
                    event: EventKind::Enforce,
                    has_evidence: false,
                    remaining_support: None,
                }),
                Err(KernelError::AdmissionPolicy),
                "approval_valid={approval_valid}"
            );
        }

        let enforced = PriorDecision {
            historical_maturity: Maturity::Enforced,
            effective_maturity: Maturity::Enforced,
            disposition: Disposition::Active,
            outcome: Outcome::Promote,
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            sensitivity: Sensitivity::Normal,
        };
        let replay = EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: Some(enforced),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: true,
            event: EventKind::Enforce,
            has_evidence: true,
            remaining_support: None,
        };
        assert_eq!(
            evaluate_admission(replay).unwrap().outcome,
            Outcome::Promote
        );

        assert_eq!(
            evaluate_admission(EvaluationInputs {
                has_evidence: false,
                remaining_support: None,
                ..replay
            }),
            Err(KernelError::AdmissionPolicy)
        );

        // A denied `Enforce` whose computed state equals its prior must not pass either.
        assert_eq!(
            evaluate_admission(EvaluationInputs {
                prior: Some(PriorDecision {
                    historical_maturity: Maturity::Candidate,
                    effective_maturity: Maturity::Candidate,
                    disposition: Disposition::Active,
                    outcome: Outcome::Deny,
                    source_class: SourceClass::TrustedLocalCode,
                    taint_class: TaintClass::CurrentCode,
                    sensitivity: Sensitivity::Normal,
                }),
                approval_valid: false,
                has_evidence: false,
                remaining_support: None,
                ..replay
            }),
            Err(KernelError::AdmissionPolicy)
        );
    }

    #[test]
    fn non_active_dispositions_withdraw_effective_support() {
        let promoted = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Candidate,
                effective_maturity: Maturity::Candidate,
                disposition: Disposition::Rejected,
                outcome: Outcome::Reject,
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                sensitivity: Sensitivity::Normal,
            }),
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: true,
            event: EventKind::Enforce,
            has_evidence: true,
            remaining_support: None,
        })
        .unwrap();
        assert_eq!(promoted.historical_maturity, Maturity::Enforced);
        assert_eq!(promoted.effective_maturity.get(), Maturity::Candidate);
        assert_eq!(promoted.disposition, Disposition::Rejected);
        assert_eq!(promoted.visibility, VisibilityRow::ReviewOnly);
    }

    #[test]
    fn policy_revision_matches_policy_content() {
        fn section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
            source
                .split_once(start)
                .and_then(|(_, tail)| tail.split_once(end))
                .map(|(section, _)| section)
                .unwrap()
        }
        let source = include_str!("admission.rs").replace("\r\n", "\n");
        let source = source.as_str();
        let mut policy = [
            Maturity::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            SourceClass::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            TaintClass::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            Disposition::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            EventKind::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            VisibilityRow::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            Surface::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            Sensitivity::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            Outcome::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
        ]
        .into_iter()
        .map(|values| values.join(","))
        .collect::<Vec<_>>()
        .join("\n");
        policy.push_str(section(
            source,
            "// policy-digest:evaluator-start",
            "// policy-digest:evaluator-end",
        ));
        policy.push_str(section(
            source,
            "// policy-digest:tables-start",
            "// policy-digest:tables-end",
        ));
        let digest = format!("{:x}", Sha256::digest(policy));
        assert_eq!(POLICY_REVISION, 1);
        assert_eq!(digest, REVISION_1_SOURCE_DIGEST);
    }
}
