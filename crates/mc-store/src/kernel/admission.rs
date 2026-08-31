use super::{KernelError, Sensitivity};

pub const POLICY_REVISION: i64 = 1;
#[cfg(test)]
const REVISION_1_SOURCE_DIGEST: &str =
    "0034e16f91e7481bd59a6e728d125d7c47dbff1844a0466c39f3e9ef8cc62d1c";

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
    pub no_op: bool,
}

// policy-digest:evaluator-start
pub fn evaluate_admission(input: EvaluationInputs) -> Result<Evaluation, KernelError> {
    if !source_allows_taint(input.source_class, input.taint_class) {
        return Err(KernelError::AdmissionPolicy);
    }
    if input.prior.is_some_and(|prior| {
        prior.source_class != input.source_class || prior.taint_class != input.taint_class
    }) {
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
    let ceiling = automatic_ceiling(input.source_class, input.taint_class);
    let (requested, requested_disposition, requested_outcome) = event_effect(input.event, current);
    let raises_support =
        event_can_raise_support(input.event) && requested.rank() > current_effective.rank();
    let requires_approval =
        raises_support && (!auto_admit_event(input.event) || requested.rank() > ceiling.rank());
    let denied = requires_approval && !input.approval_valid;
    let disposition = if denied || !event_sets_disposition(input.event) {
        current_disposition
    } else {
        requested_disposition
    };

    let target = if denied { current } else { requested };
    let historical = current.max(target);
    let supported = if input.event == EventKind::ApprovalRevoked {
        ceiling
    } else if raises_support && !denied {
        requested
    } else {
        current_effective
    };
    let effective = historical.min(supported);
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

    if input.event == EventKind::Enforce && input.approval_valid && !input.has_evidence {
        return Err(KernelError::AdmissionPolicy);
    }

    let sensitivity = sensitivity_floor(input.taint_class)
        .max(input.candidate_sensitivity)
        .max(
            input
                .prior
                .map_or(Sensitivity::Normal, |prior| prior.sensitivity),
        )
        .max(input.predecessor_sensitivity.unwrap_or(Sensitivity::Normal));
    let visibility = visibility_row(effective, disposition);
    let no_op = input.prior.is_some_and(|prior| {
        prior.historical_maturity == historical
            && prior.effective_maturity == effective
            && prior.disposition == disposition
            && prior.outcome == outcome
            && prior.sensitivity == sensitivity
    });

    Ok(Evaluation {
        historical_maturity: historical,
        effective_maturity: EffectiveMaturity(effective),
        disposition,
        visibility,
        sensitivity,
        outcome,
        no_op,
    })
}
// policy-digest:evaluator-end

// policy-digest:tables-start
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

const fn event_effect(event: EventKind, current: Maturity) -> (Maturity, Disposition, Outcome) {
    match event {
        EventKind::ExplicitReject => (current, Disposition::Rejected, Outcome::Reject),
        EventKind::Correct => (current, Disposition::Superseded, Outcome::Correct),
        EventKind::Replace => (current, Disposition::Superseded, Outcome::Replace),
        EventKind::AcceptedAdr | EventKind::Approve => {
            (Maturity::Approved, Disposition::Active, Outcome::Promote)
        }
        EventKind::Enforce => (Maturity::Enforced, Disposition::Active, Outcome::Promote),
        EventKind::CodeObserved | EventKind::ConfigObserved | EventKind::Verify => {
            (Maturity::Verified, Disposition::Active, Outcome::Promote)
        }
        EventKind::Corroborate => (
            Maturity::Corroborated,
            Disposition::Active,
            Outcome::Promote,
        ),
        EventKind::ApprovalRevoked => (current, Disposition::Active, Outcome::DemoteSupport),
        EventKind::MarkStale => (current, Disposition::Stale, Outcome::Deny),
        EventKind::MarkDisputed => (current, Disposition::Disputed, Outcome::Deny),
        EventKind::Contradict => (current, Disposition::Contradicted, Outcome::Deny),
        EventKind::Quarantine => (current, Disposition::Quarantined, Outcome::Quarantine),
        EventKind::Other => (current, Disposition::Active, Outcome::Deny),
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

const fn event_sets_disposition(event: EventKind) -> bool {
    matches!(
        event,
        EventKind::ExplicitReject
            | EventKind::Correct
            | EventKind::Replace
            | EventKind::MarkStale
            | EventKind::MarkDisputed
            | EventKind::Contradict
            | EventKind::Quarantine
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
    fn only_closed_auto_admit_event_set_avoids_approval() {
        for event in EventKind::ALL {
            let result = evaluate_admission(EvaluationInputs {
                source_class: SourceClass::TrustedLocalCode,
                taint_class: TaintClass::CurrentCode,
                prior: None,
                candidate_sensitivity: Sensitivity::Normal,
                predecessor_sensitivity: None,
                approval_valid: false,
                event: *event,
                has_evidence: false,
            });
            let result = result.unwrap();
            let admitted = matches!(event, EventKind::CodeObserved | EventKind::ConfigObserved);
            assert_eq!(
                result.historical_maturity.rank() > Maturity::Candidate.rank(),
                admitted,
                "{event:?}"
            );
        }
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
            })
            .unwrap();
            assert!(result.sensitivity >= Sensitivity::Sensitive);
        }
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
        let source = include_str!("admission.rs");
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
