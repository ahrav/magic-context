use super::envelope::{object_row_from, DomainSpec, Envelope, ObjectRow, PendingChange};
use super::redaction::{identity, record, redact};
use super::{map_sqlite, KernelError, KernelStore, Sensitivity};
use crate::current_time_ms;
use rusqlite::{params, OptionalExtension};

pub const POLICY_REVISION: i64 = 1;
#[cfg(test)]
const REVISION_1_SOURCE_DIGEST: &str =
    "0034e16f91e7481bd59a6e728d125d7c47dbff1844a0466c39f3e9ef8cc62d1c";

// policy-digest:vocabulary-start
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
    pub trigger_object_id: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionRequest {
    pub candidate_id: Option<String>,
    pub subject_object_id: Option<String>,
    pub source_class: Option<SourceClass>,
    pub taint_class: Option<TaintClass>,
    pub event: AdmissionEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionDomainSpec {
    pub domain_id: String,
    pub object_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionDecision {
    pub admission_decision_id: String,
    pub historical_maturity: Maturity,
    pub effective_maturity: Maturity,
    pub disposition: Disposition,
    pub visibility: VisibilityRow,
    pub sensitivity: Sensitivity,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleRow {
    pub object: ObjectRow,
    pub visibility: SurfaceVisibility,
    pub labeled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleAsOf {
    pub known_as_of: i64,
    pub tip: i64,
    pub rows: Vec<VisibleRow>,
}

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

struct SubjectFacts {
    candidate_id: Option<String>,
    subject_object_id: Option<String>,
    source_kind: String,
    source_id: String,
    source_revision: i64,
    domain_id: String,
    sensitivity: Sensitivity,
    provenance_kind: Option<String>,
    candidate_kind: Option<String>,
    candidate_payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) enum AdmissionKey {
    Object(String),
    Source {
        kind: String,
        id: String,
        revision: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StoredAdmission {
    decision: PriorDecision,
    approval_object_id: Option<String>,
}

struct PreparedDecision {
    facts: SubjectFacts,
    source_class: SourceClass,
    taint_class: TaintClass,
    event: AdmissionEvent,
    evaluation: Evaluation,
}

impl Envelope<'_> {
    #[cfg(feature = "test-support")]
    pub fn insert_admission_observation_for_test(
        &mut self,
        object_id: &str,
        observation_kind: &str,
        domain_id: &str,
        source_kind: &str,
        source_id: &str,
        source_revision: i64,
    ) -> Result<(), KernelError> {
        if source_revision < 0 || !matches!(observation_kind, "code_present" | "config_present") {
            return Err(KernelError::AdmissionPolicy);
        }
        let object_id = identity(object_id)?;
        let domain_id = identity(domain_id)?;
        let source_kind = identity(source_kind)?;
        let source_id = identity(source_id)?;
        self.tx
            .execute(
                "INSERT INTO object_registry(
                     object_id,object_kind,domain_id,source_kind,source_id,source_revision,
                     created_commit_seq,sensitivity_class
                 ) VALUES (?1,'observation',?2,?3,?4,?5,?6,'normal')",
                params![
                    object_id,
                    domain_id,
                    source_kind,
                    source_id,
                    source_revision,
                    self.commit_seq
                ],
            )
            .map_err(map_sqlite)?;
        self.tx
            .execute(
                "INSERT INTO observations(
                     observation_id,object_id,observation_kind,observation_payload,observed_at,
                     created_commit_seq,sensitivity_class
                 ) VALUES (?1,?1,?2,X'7b7d',?3,?3,'normal')",
                params![object_id, observation_kind, self.commit_seq],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn record_admission(
        &mut self,
        request: AdmissionRequest,
    ) -> Result<Option<AdmissionDecision>, KernelError> {
        if let Some(error) = self.already_poisoned() {
            return Err(error);
        }
        let result = self.record_admission_inner(request);
        self.poison(result)
    }

    fn record_admission_inner(
        &mut self,
        request: AdmissionRequest,
    ) -> Result<Option<AdmissionDecision>, KernelError> {
        if request.subject_object_id.is_some()
            && matches!(request.event.kind, EventKind::Correct | EventKind::Replace)
        {
            return Err(KernelError::AdmissionPolicy);
        }
        let prepared = self.prepare_admission(request)?;
        if prepared.evaluation.no_op {
            return Ok(None);
        }
        self.write_admission(prepared, None).map(Some)
    }

    pub fn admit_domain_candidate(
        &mut self,
        request: AdmissionRequest,
        domain: AdmissionDomainSpec,
    ) -> Result<AdmissionDecision, KernelError> {
        if let Some(error) = self.already_poisoned() {
            return Err(error);
        }
        let result = self.admit_domain_candidate_inner(request, domain);
        self.poison(result)
    }

    fn admit_domain_candidate_inner(
        &mut self,
        request: AdmissionRequest,
        domain: AdmissionDomainSpec,
    ) -> Result<AdmissionDecision, KernelError> {
        let prepared = self.prepare_admission(request)?;
        if prepared.facts.candidate_id.is_none()
            || prepared.facts.subject_object_id.is_some()
            || prepared.evaluation.no_op
        {
            return Err(KernelError::AdmissionPolicy);
        }
        if prepared.evaluation.outcome == Outcome::Deny
            || prepared.evaluation.disposition != Disposition::Active
        {
            return self.write_admission(prepared, None);
        }
        if prepared.facts.candidate_kind.as_deref() != Some("domain")
            || prepared.facts.candidate_payload.as_deref() != Some(domain.name.as_str())
        {
            return Err(KernelError::AdmissionPolicy);
        }
        let object = ObjectRow {
            object_id: domain.object_id.clone(),
            object_kind: "domain".to_string(),
            domain_id: domain.domain_id.clone(),
            source_kind: prepared.facts.source_kind.clone(),
            source_id: prepared.facts.source_id.clone(),
            source_revision: prepared.facts.source_revision,
            created_commit_seq: self.commit_seq,
            invalidated_commit_seq: None,
            superseded_by: None,
            sensitivity: prepared.evaluation.sensitivity,
        };
        self.insert_domain(DomainSpec {
            domain_id: domain.domain_id,
            object_id: domain.object_id,
            name: domain.name,
            source_kind: prepared.facts.source_kind.clone(),
            source_id: prepared.facts.source_id.clone(),
            source_revision: prepared.facts.source_revision,
            sensitivity: prepared.evaluation.sensitivity,
        })?;
        self.write_admission(prepared, Some(object))
    }

    pub fn supersede_domain(
        &mut self,
        request: AdmissionRequest,
        replacement: AdmissionDomainSpec,
    ) -> Result<AdmissionDecision, KernelError> {
        if let Some(error) = self.already_poisoned() {
            return Err(error);
        }
        let result = self.supersede_domain_inner(request, replacement);
        self.poison(result)
    }

    fn supersede_domain_inner(
        &mut self,
        request: AdmissionRequest,
        replacement: AdmissionDomainSpec,
    ) -> Result<AdmissionDecision, KernelError> {
        let prepared = self.prepare_admission(request)?;
        if prepared.facts.candidate_id.is_some()
            || prepared.evaluation.no_op
            || !matches!(prepared.event.kind, EventKind::Correct | EventKind::Replace)
        {
            return Err(KernelError::AdmissionPolicy);
        }
        let replaced_object_id = prepared
            .facts
            .subject_object_id
            .clone()
            .ok_or(KernelError::AdmissionPolicy)?;
        self.correct_domain(
            &replaced_object_id,
            DomainSpec {
                domain_id: replacement.domain_id,
                object_id: replacement.object_id,
                name: replacement.name,
                source_kind: prepared.facts.source_kind.clone(),
                source_id: prepared.facts.source_id.clone(),
                source_revision: prepared.facts.source_revision,
                sensitivity: prepared.evaluation.sensitivity,
            },
        )?;
        if prepared.event.kind == EventKind::Replace {
            self.changes
                .last_mut()
                .ok_or(KernelError::AdmissionPolicy)?
                .kind = "replace";
        }
        self.write_admission(prepared, None)
    }

    pub fn revoke_approval(
        &mut self,
        approval_object_id: &str,
        reason: &str,
    ) -> Result<Vec<AdmissionDecision>, KernelError> {
        if let Some(error) = self.already_poisoned() {
            return Err(error);
        }
        let result = self.revoke_approval_inner(approval_object_id, reason);
        self.poison(result)
    }

    fn revoke_approval_inner(
        &mut self,
        approval_object_id: &str,
        reason: &str,
    ) -> Result<Vec<AdmissionDecision>, KernelError> {
        const MAX_DEPENDENTS: usize = 1_024;

        if reason.trim().is_empty() {
            return Err(KernelError::AdmissionPolicy);
        }
        let approval_object_id = identity(approval_object_id)?;
        let approval = self
            .tx
            .query_row(
                "SELECT o.object_id,o.object_kind,o.domain_id,o.source_kind,o.source_id,
                        o.source_revision,o.created_commit_seq,NULL,NULL,o.sensitivity_class
                 FROM object_registry o
                 JOIN decisions d ON d.object_id=o.object_id
                WHERE o.object_id=?1 AND o.object_kind='decision'
                   AND o.invalidated_commit_seq IS NULL
                   AND d.decision_kind='adr_accepted'
                   AND d.invalidated_commit_seq IS NULL",
                [approval_object_id.as_str()],
                object_row_from,
            )
            .optional()
            .map_err(map_sqlite)?
            .ok_or(KernelError::NotFound)?;
        let dependents = {
            let mut statement = self
                .tx
                .prepare(
                    "SELECT a.subject_object_id,a.source_class,a.taint_class
                     FROM admission_decisions a
                     WHERE a.approval_object_id=?1
                       AND a.subject_object_id IS NOT NULL
                       AND a.commit_seq IS NOT NULL
                       AND NOT EXISTS (
                           SELECT 1 FROM admission_decisions newer
                           WHERE newer.subject_object_id=a.subject_object_id
                             AND newer.commit_seq IS NOT NULL
                             AND (
                                 newer.commit_seq>a.commit_seq
                                 OR (
                                     newer.commit_seq=a.commit_seq
                                     AND newer.admission_decision_id>a.admission_decision_id
                                 )
                             )
                       )
                     ORDER BY a.subject_object_id",
                )
                .map_err(map_sqlite)?;
            let rows = statement
                .query_map([approval_object_id.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(map_sqlite)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite)?;
            rows
        };
        if dependents.len() > MAX_DEPENDENTS {
            return Err(KernelError::AdmissionPolicy);
        }
        let registry = self
            .tx
            .execute(
                "UPDATE object_registry SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, approval_object_id],
            )
            .map_err(map_sqlite)?;
        let decision = self
            .tx
            .execute(
                "UPDATE decisions SET invalidated_commit_seq=?1
                 WHERE object_id=?2 AND invalidated_commit_seq IS NULL",
                params![self.commit_seq, approval_object_id],
            )
            .map_err(map_sqlite)?;
        if registry != 1 || decision != 1 {
            return Err(KernelError::NotFound);
        }
        let mut invalidated = approval;
        invalidated.invalidated_commit_seq = Some(self.commit_seq);
        self.changes.push(PendingChange {
            object: invalidated,
            kind: "approval_revoke",
            replaced_object_id: None,
            redactions: Vec::new(),
            audit: None,
        });

        let mut decisions = Vec::with_capacity(dependents.len());
        for (subject_object_id, source_class, taint_class) in dependents {
            let request = AdmissionRequest {
                candidate_id: None,
                subject_object_id: Some(subject_object_id),
                source_class: Some(SourceClass::try_from(source_class.as_str())?),
                taint_class: Some(TaintClass::try_from(taint_class.as_str())?),
                event: AdmissionEvent {
                    kind: EventKind::ApprovalRevoked,
                    trigger_object_id: None,
                    approval_object_id: None,
                    evidence_id: None,
                    reason: reason.to_string(),
                },
            };
            if let Some(decision) = self.record_admission_inner(request)? {
                decisions.push(decision);
            }
        }
        Ok(decisions)
    }

    fn prepare_admission(
        &self,
        mut request: AdmissionRequest,
    ) -> Result<PreparedDecision, KernelError> {
        let source_class = request.source_class.ok_or(KernelError::AdmissionPolicy)?;
        let taint_class = request.taint_class.ok_or(KernelError::AdmissionPolicy)?;
        if request.event.reason.trim().is_empty()
            || request.candidate_id.is_some() == request.subject_object_id.is_some()
        {
            return Err(KernelError::AdmissionPolicy);
        }
        let facts = if let Some(candidate_id) = request.candidate_id.as_deref() {
            load_candidate_facts(self, candidate_id)?
        } else {
            load_subject_facts(
                self,
                request
                    .subject_object_id
                    .as_deref()
                    .ok_or(KernelError::AdmissionPolicy)?,
            )?
        };
        validate_provenance(source_class, taint_class, facts.provenance_kind.as_deref())?;
        let stored = load_prior_decision(self, &facts)?;
        let prior = stored.as_ref().map(|stored| stored.decision);
        if request.event.approval_object_id.is_none()
            && !matches!(
                request.event.kind,
                EventKind::ApprovalRevoked | EventKind::Correct | EventKind::Replace
            )
        {
            request.event.approval_object_id = stored
                .as_ref()
                .and_then(|stored| stored.approval_object_id.clone());
        }
        let approval_valid = validate_approval(
            self,
            request.event.approval_object_id.as_deref(),
            facts.subject_object_id.as_deref(),
        )?;
        let trigger_valid = validate_trigger(self, &request.event, &facts)?;
        let evaluation = evaluate_admission(EvaluationInputs {
            source_class,
            taint_class,
            prior,
            candidate_sensitivity: facts.sensitivity,
            predecessor_sensitivity: None,
            approval_valid,
            event: if trigger_valid {
                request.event.kind
            } else {
                EventKind::Other
            },
            has_evidence: request.event.evidence_id.is_some(),
        })?;
        Ok(PreparedDecision {
            facts,
            source_class,
            taint_class,
            event: request.event,
            evaluation,
        })
    }

    fn write_admission(
        &mut self,
        prepared: PreparedDecision,
        materialized: Option<ObjectRow>,
    ) -> Result<AdmissionDecision, KernelError> {
        let latest_key = prepared.facts.key();
        let latest = StoredAdmission {
            decision: PriorDecision {
                historical_maturity: prepared.evaluation.historical_maturity,
                effective_maturity: prepared.evaluation.effective_maturity.get(),
                disposition: prepared.evaluation.disposition,
                outcome: prepared.evaluation.outcome,
                source_class: prepared.source_class,
                taint_class: prepared.taint_class,
                sensitivity: prepared.evaluation.sensitivity,
            },
            approval_object_id: prepared.event.approval_object_id.clone(),
        };
        let admission_decision_id = format!("{}:{:020}", self.commit_seq, self.admission_ordinal);
        self.admission_ordinal = self
            .admission_ordinal
            .checked_add(1)
            .ok_or(KernelError::AdmissionPolicy)?;
        let source_kind = identity(&prepared.facts.source_kind)?;
        let source_id = identity(&prepared.facts.source_id)?;
        let reason = redact(&prepared.event.reason);
        let evidence_id = prepared
            .event
            .evidence_id
            .as_deref()
            .map(identity)
            .transpose()?;
        let approval_object_id = prepared
            .event
            .approval_object_id
            .as_deref()
            .map(identity)
            .transpose()?;
        let trigger_object_id = prepared
            .event
            .trigger_object_id
            .as_deref()
            .map(identity)
            .transpose()?;
        let subject_object_id = materialized
            .as_ref()
            .map(|object| object.object_id.clone())
            .or(prepared.facts.subject_object_id.clone());
        self.tx
            .execute(
                "INSERT INTO admission_decisions(
                     admission_decision_id,candidate_id,subject_object_id,source_kind,source_id,
                     source_revision,source_class,taint_class,maturity,disposition,visibility,
                     policy_revision,reason,evidence_id,approval_object_id,commit_seq,decided_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![
                    admission_decision_id,
                    prepared.facts.candidate_id,
                    subject_object_id,
                    source_kind,
                    source_id,
                    prepared.facts.source_revision,
                    prepared.source_class.as_str(),
                    prepared.taint_class.as_str(),
                    prepared.evaluation.historical_maturity.as_str(),
                    prepared.evaluation.disposition.as_str(),
                    prepared.evaluation.visibility.as_str(),
                    POLICY_REVISION,
                    reason.text,
                    evidence_id,
                    approval_object_id,
                    self.commit_seq,
                    current_time_ms(),
                ],
            )
            .map_err(map_sqlite)?;
        record(
            self.tx,
            "admission_decision",
            &admission_decision_id,
            "reason",
            &reason,
            Some(self.commit_seq),
        )?;

        let audit = serde_json::json!({
            "outcome": prepared.evaluation.outcome.as_str(),
            "historical_maturity": prepared.evaluation.historical_maturity.as_str(),
            "effective_maturity": prepared.evaluation.effective_maturity.get().as_str(),
            "disposition": prepared.evaluation.disposition.as_str(),
            "visibility": prepared.evaluation.visibility.as_str(),
            "sensitivity": prepared.evaluation.sensitivity.as_str(),
            "policy_revision": POLICY_REVISION,
            "trigger_object_id": trigger_object_id,
        });
        self.changes.push(PendingChange {
            object: ObjectRow {
                object_id: admission_decision_id.clone(),
                object_kind: "admission_decision".to_string(),
                domain_id: materialized
                    .as_ref()
                    .map_or(prepared.facts.domain_id, |object| object.domain_id.clone()),
                source_kind,
                source_id,
                source_revision: prepared.facts.source_revision,
                created_commit_seq: self.commit_seq,
                invalidated_commit_seq: None,
                superseded_by: None,
                sensitivity: prepared.evaluation.sensitivity,
            },
            kind: prepared.evaluation.outcome.as_str(),
            replaced_object_id: None,
            redactions: vec![("reason".to_string(), reason)],
            audit: Some(audit),
        });
        self.admission_latest.insert(latest_key, latest);
        Ok(AdmissionDecision {
            admission_decision_id,
            historical_maturity: prepared.evaluation.historical_maturity,
            effective_maturity: prepared.evaluation.effective_maturity.get(),
            disposition: prepared.evaluation.disposition,
            visibility: prepared.evaluation.visibility,
            sensitivity: prepared.evaluation.sensitivity,
            outcome: prepared.evaluation.outcome,
        })
    }
}

impl SubjectFacts {
    fn key(&self) -> AdmissionKey {
        self.subject_object_id.as_ref().map_or_else(
            || AdmissionKey::Source {
                kind: self.source_kind.clone(),
                id: self.source_id.clone(),
                revision: self.source_revision,
            },
            |object_id| AdmissionKey::Object(object_id.clone()),
        )
    }
}

fn load_candidate_facts(
    envelope: &Envelope<'_>,
    candidate_id: &str,
) -> Result<SubjectFacts, KernelError> {
    let candidate_id = identity(candidate_id)?;
    let (source_kind, source_id, source_revision, sensitivity, provenance, candidate_kind, payload) =
        envelope
            .tx
            .query_row(
                "SELECT r.source_kind,r.source_id,r.source_revision,c.sensitivity_class,
                    c.provenance_witness,c.candidate_kind,c.payload
             FROM candidates c
             JOIN extraction_runs r USING(extraction_run_id)
             WHERE c.candidate_id=?1",
                [candidate_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?
            .ok_or(KernelError::NotFound)?;
    let provenance: serde_json::Value =
        serde_json::from_slice(&provenance).map_err(|_| KernelError::AdmissionPolicy)?;
    let payload = String::from_utf8(payload).map_err(|_| KernelError::AdmissionPolicy)?;
    Ok(SubjectFacts {
        candidate_id: Some(candidate_id),
        subject_object_id: None,
        source_kind: source_kind.ok_or(KernelError::AdmissionPolicy)?,
        source_id: source_id.ok_or(KernelError::AdmissionPolicy)?,
        source_revision: source_revision.ok_or(KernelError::AdmissionPolicy)?,
        domain_id: "kernel-staging".to_string(),
        sensitivity: Sensitivity::from_stored(&sensitivity),
        provenance_kind: provenance
            .get("kind")
            .and_then(|kind| kind.as_str())
            .map(str::to_string),
        candidate_kind: Some(candidate_kind),
        candidate_payload: Some(payload),
    })
}

fn load_subject_facts(
    envelope: &Envelope<'_>,
    subject_object_id: &str,
) -> Result<SubjectFacts, KernelError> {
    let subject_object_id = identity(subject_object_id)?;
    envelope
        .tx
        .query_row(
            "SELECT domain_id,source_kind,source_id,source_revision,sensitivity_class
             FROM object_registry WHERE object_id=?1",
            [subject_object_id.as_str()],
            |row| {
                Ok(SubjectFacts {
                    candidate_id: None,
                    subject_object_id: Some(subject_object_id.clone()),
                    domain_id: row.get(0)?,
                    source_kind: row.get(1)?,
                    source_id: row.get(2)?,
                    source_revision: row.get(3)?,
                    sensitivity: Sensitivity::from_stored(&row.get::<_, String>(4)?),
                    provenance_kind: None,
                    candidate_kind: None,
                    candidate_payload: None,
                })
            },
        )
        .optional()
        .map_err(map_sqlite)?
        .ok_or(KernelError::NotFound)
}

fn load_prior_decision(
    envelope: &Envelope<'_>,
    facts: &SubjectFacts,
) -> Result<Option<StoredAdmission>, KernelError> {
    let key = facts.key();
    if let Some(prior) = envelope.admission_latest.get(&key) {
        return Ok(Some(prior.clone()));
    }
    let row = if let Some(subject_object_id) = facts.subject_object_id.as_deref() {
        envelope.tx.query_row(
            "SELECT admission_decision_id,maturity,disposition,source_class,taint_class,
                    approval_object_id
             FROM admission_decisions
             WHERE subject_object_id=?1 AND commit_seq IS NOT NULL
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1",
            [subject_object_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
    } else {
        envelope.tx.query_row(
            "SELECT admission_decision_id,maturity,disposition,source_class,taint_class,
                    approval_object_id
             FROM admission_decisions
             WHERE source_kind=?1 AND source_id=?2 AND source_revision=?3
               AND commit_seq IS NOT NULL
             ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1",
            params![facts.source_kind, facts.source_id, facts.source_revision],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
    }
    .optional()
    .map_err(map_sqlite)?;
    let Some((decision_id, maturity, disposition, source_class, taint_class, approval_object_id)) =
        row
    else {
        return Ok(None);
    };
    let payload = envelope
        .tx
        .query_row(
            "SELECT payload FROM change_event WHERE object_id=?1
             ORDER BY commit_seq DESC,ordinal DESC LIMIT 1",
            [decision_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(map_sqlite)?;
    let audit = payload
        .as_deref()
        .and_then(|payload| serde_json::from_slice::<serde_json::Value>(payload).ok())
        .and_then(|payload| payload.get("audit").cloned());
    let outcome = audit
        .as_ref()
        .and_then(|audit| audit.get("outcome"))
        .and_then(|value| value.as_str())
        .and_then(|value| Outcome::try_from(value).ok())
        .unwrap_or(Outcome::Deny);
    let sensitivity = audit
        .as_ref()
        .and_then(|audit| audit.get("sensitivity"))
        .and_then(|value| value.as_str())
        .map_or(Sensitivity::Secret, Sensitivity::from_stored);
    let effective_maturity = audit
        .as_ref()
        .and_then(|audit| audit.get("effective_maturity"))
        .and_then(|value| value.as_str())
        .and_then(|value| Maturity::try_from(value).ok())
        .unwrap_or(Maturity::Candidate);
    Ok(Some(StoredAdmission {
        decision: PriorDecision {
            historical_maturity: Maturity::try_from(maturity.as_str())
                .unwrap_or(Maturity::Candidate),
            effective_maturity,
            disposition: Disposition::try_from(disposition.as_str())
                .unwrap_or(Disposition::Quarantined),
            outcome,
            source_class: SourceClass::try_from(source_class.as_str())?,
            taint_class: TaintClass::try_from(taint_class.as_str())?,
            sensitivity,
        },
        approval_object_id,
    }))
}

fn validate_provenance(
    source_class: SourceClass,
    taint_class: TaintClass,
    provenance_kind: Option<&str>,
) -> Result<(), KernelError> {
    let valid = match provenance_kind {
        None => true,
        Some("repository") => {
            source_class != SourceClass::ExplicitUser && taint_class != TaintClass::UserExplicit
        }
        Some("unclassified") => !matches!(
            source_class,
            SourceClass::ExplicitUser
                | SourceClass::TrustedLocalCode
                | SourceClass::TrustedToolResult
        ),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(KernelError::AdmissionPolicy)
    }
}

fn validate_approval(
    envelope: &Envelope<'_>,
    approval_object_id: Option<&str>,
    subject_object_id: Option<&str>,
) -> Result<bool, KernelError> {
    let Some(approval_object_id) = approval_object_id else {
        return Ok(false);
    };
    let approval_object_id = identity(approval_object_id)?;
    if subject_object_id == Some(approval_object_id.as_str()) {
        return Ok(false);
    }
    envelope
        .tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM object_registry o
                 JOIN decisions d ON d.object_id=o.object_id
                 JOIN admission_decisions a ON a.subject_object_id=o.object_id
                 WHERE o.object_id=?1 AND o.object_kind='decision'
                   AND o.invalidated_commit_seq IS NULL
                   AND d.decision_kind='adr_accepted'
                   AND d.invalidated_commit_seq IS NULL
                   AND a.taint_class='user_explicit'
                   AND a.maturity IN ('approved','enforced')
                   AND a.disposition='active'
                   AND a.visibility='automatic'
                   AND a.commit_seq IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM admission_decisions newer
                       WHERE newer.subject_object_id=a.subject_object_id
                         AND newer.commit_seq IS NOT NULL
                         AND (
                             newer.commit_seq>a.commit_seq
                             OR (
                                 newer.commit_seq=a.commit_seq
                                 AND newer.admission_decision_id>a.admission_decision_id
                             )
                         )
                   )
             )",
            [approval_object_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(map_sqlite)
}

fn validate_trigger(
    envelope: &Envelope<'_>,
    event: &AdmissionEvent,
    facts: &SubjectFacts,
) -> Result<bool, KernelError> {
    match event.kind {
        EventKind::CodeObserved | EventKind::ConfigObserved => {
            let Some(trigger_object_id) = event.trigger_object_id.as_deref() else {
                return Ok(false);
            };
            let trigger_object_id = identity(trigger_object_id)?;
            let expected = if event.kind == EventKind::CodeObserved {
                "code_present"
            } else {
                "config_present"
            };
            envelope
                .tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1
                         FROM object_registry o
                         JOIN observations observed ON observed.object_id=o.object_id
                         WHERE o.object_id=?1 AND o.object_kind='observation'
                           AND o.invalidated_commit_seq IS NULL
                           AND o.source_kind=?3
                           AND o.source_id=?4
                           AND o.source_revision=?5
                           AND observed.observation_kind=?2
                           AND observed.invalidated_commit_seq IS NULL
                     )",
                    params![
                        trigger_object_id,
                        expected,
                        facts.source_kind,
                        facts.source_id,
                        facts.source_revision
                    ],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(map_sqlite)
        }
        // kh8.4 owns the passing-artifact writer. A bare evidence reference cannot
        // establish that contract, so enforcement remains closed until that seam exists.
        EventKind::Enforce => Ok(false),
        _ => Ok(true),
    }
}

impl KernelStore {
    /// Serving reads must use this filtered view; `known_as_of` remains an audit/replay view.
    pub fn visible_as_of(
        &self,
        surface: Surface,
        requested: i64,
    ) -> Result<VisibleAsOf, KernelError> {
        let (tip, rows) = self.read_snapshot(requested, |tx| {
            let mut statement = tx
                .prepare(
                    "SELECT o.object_id,o.object_kind,o.domain_id,o.source_kind,o.source_id,
                            o.source_revision,o.created_commit_seq,NULL,NULL,o.sensitivity_class,
                            a.maturity,a.disposition,a.visibility,a.taint_class
                     FROM object_registry o
                     JOIN admission_decisions a ON a.subject_object_id=o.object_id
                     WHERE o.created_commit_seq<=?1
                       AND (o.invalidated_commit_seq IS NULL OR ?1<o.invalidated_commit_seq)
                       AND a.commit_seq IS NOT NULL
                       AND a.commit_seq<=?1
                       AND NOT EXISTS (
                           SELECT 1 FROM admission_decisions newer
                           WHERE newer.subject_object_id=a.subject_object_id
                             AND newer.commit_seq IS NOT NULL
                             AND newer.commit_seq<=?1
                             AND (
                                 newer.commit_seq>a.commit_seq
                                 OR (
                                     newer.commit_seq=a.commit_seq
                                     AND newer.admission_decision_id>a.admission_decision_id
                                 )
                             )
                       )
                     ORDER BY o.object_id",
                )
                .map_err(map_sqlite)?;
            let rows = statement
                .query_map([requested], |row| {
                    let mut object = object_row_from(row)?;
                    object.sensitivity =
                        match TaintClass::try_from(row.get::<_, String>(13)?.as_str()) {
                            Ok(taint) => object.sensitivity.max(sensitivity_floor(taint)),
                            Err(_) => Sensitivity::Secret,
                        };
                    let maturity = Maturity::try_from(row.get::<_, String>(10)?.as_str())
                        .unwrap_or(Maturity::Candidate);
                    let disposition = Disposition::try_from(row.get::<_, String>(11)?.as_str())
                        .unwrap_or(Disposition::Quarantined);
                    let stored_visibility =
                        VisibilityRow::try_from(row.get::<_, String>(12)?.as_str()).ok();
                    let expected_visibility = visibility_row(maturity, disposition);
                    let visibility_row = match (stored_visibility, expected_visibility) {
                        (None | Some(VisibilityRow::AuditOnly), _)
                        | (_, VisibilityRow::AuditOnly) => VisibilityRow::AuditOnly,
                        (Some(VisibilityRow::ReviewOnly), _) | (_, VisibilityRow::ReviewOnly) => {
                            VisibilityRow::ReviewOnly
                        }
                        (Some(VisibilityRow::ExplicitLabeled), _)
                        | (_, VisibilityRow::ExplicitLabeled) => VisibilityRow::ExplicitLabeled,
                        (Some(VisibilityRow::Automatic), VisibilityRow::Automatic) => {
                            VisibilityRow::Automatic
                        }
                    };
                    let visibility =
                        surface_visibility(visibility_row, surface, object.sensitivity);
                    Ok((object, visibility))
                })
                .map_err(map_sqlite)?
                .filter_map(|row| match row {
                    Ok((_object, SurfaceVisibility::Hidden)) => None,
                    Ok((object, visibility)) => Some(Ok(VisibleRow {
                        object,
                        visibility,
                        labeled: visibility == SurfaceVisibility::Labeled,
                    })),
                    Err(error) => Some(Err(error)),
                })
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite)?;
            Ok(rows)
        })?;
        Ok(VisibleAsOf {
            known_as_of: requested,
            tip,
            rows,
        })
    }
}

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
