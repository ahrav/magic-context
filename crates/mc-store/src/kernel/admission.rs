use super::envelope::{
    object_row_from, DomainSpec, Envelope, ObjectRow, PendingChange, OBJECT_ROW_COLUMNS,
};
use super::object_write;
use super::redaction::{identity, record, redact};
use super::{map_sqlite, KernelError, KernelStore, Sensitivity};
use crate::current_time_ms;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

pub const POLICY_REVISION: i64 = 1;
#[cfg(test)]
const REVISION_1_SOURCE_DIGEST: &str =
    "f464ffa934bdaa62f8ded420814d5575a08d51f9e85291bb3e3a0e015fd0b1ac";

/// The enclosing query must bind `o` to `object_registry`.
/// Serving and approval validation must agree on which decision governs an
/// object, or one of them honors a rejection the other ignores. `commit_bound`
/// pins serving to a snapshot; authority checks pass an empty bound to read the
/// latest committed decision.
fn governing_decision_for_object_sql(commit_bound: &str) -> String {
    format!(
        "(
    SELECT latest.admission_decision_id FROM (
        SELECT a.admission_decision_id,a.commit_seq
        FROM admission_decisions a
        WHERE a.subject_object_id=o.object_id
          AND a.source_kind=o.source_kind
          AND a.source_id=o.source_id
          AND a.source_revision=o.source_revision
          AND a.commit_seq IS NOT NULL
          {commit_bound}
        UNION ALL
        SELECT a.admission_decision_id,a.commit_seq
        FROM admission_decisions a
        WHERE a.subject_object_id IS NULL
          AND a.source_kind=o.source_kind
          AND a.source_id=o.source_id
          AND a.source_revision=o.source_revision
          AND a.commit_seq IS NOT NULL
          {commit_bound}
    ) latest
    ORDER BY latest.commit_seq DESC,latest.admission_decision_id DESC
    LIMIT 1
)"
    )
}

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
    /// Whether the approval cited by *this request* authorizes it.
    pub approval_valid: bool,
    /// Validity of the approval recorded on the *prior* decision, which bought any
    /// support above the automatic ceiling. `None` when the prior decision cited
    /// none. A caller's own citation cannot answer this question.
    pub supporting_authority: Option<bool>,
    /// Whether the subject is a live `adr_accepted` decision object.
    pub subject_is_accepted_decision: bool,
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
    /// Whether the cited approval is what lifted support to this decision's effective
    /// maturity. Compared against the carried maturity, so an approval that restores
    /// support a revoked predecessor had clamped still counts as supplying it.
    pub support_from_citation: bool,
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
    // Support above `ceiling` survives only while the authority that granted it does.
    // A self-approving accepted decision cites no approval, so its own accepted
    // status is that authority.
    let authority_holds = match input.supporting_authority {
        Some(valid) => valid,
        None => input.subject_is_accepted_decision,
    };
    let carried_effective = if current_effective.rank() > ceiling.rank() && !authority_holds {
        ceiling
    } else {
        current_effective
    };
    let (requested, requested_disposition, requested_outcome) = event_effect(input.event, current);
    let raises_support =
        event_can_raise_support(input.event) && requested.rank() > carried_effective.rank();
    // A transition toward a less restrictive disposition requires approval.
    let relaxes_disposition = requested_disposition.is_some_and(|requested| {
        disposition_restrictiveness(requested) < disposition_restrictiveness(current_disposition)
    });
    let requires_approval = (event_can_raise_support(input.event)
        && (!auto_admit_event(input.event)
            || requested.rank()
                > admission_ceiling(input.event, ceiling, input.subject_is_accepted_decision)
                    .rank()))
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
        carried_effective
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
    } else if effective.rank() < current_effective.rank() && requested_disposition.is_none() {
        Outcome::DemoteSupport
    } else {
        requested_outcome
    };

    let support_from_citation = raises_support && !denied && effective.rank() > ceiling.rank();
    let visibility = visibility_row(effective, disposition);

    Ok(Evaluation {
        historical_maturity: historical,
        effective_maturity: EffectiveMaturity(effective),
        disposition,
        visibility,
        sensitivity,
        outcome,
        support_from_citation,
    })
}
// policy-digest:evaluator-end

struct SubjectFacts {
    subject: AdmissionKey,
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
    Candidate(String),
    Object(String),
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
    /// Approval recorded as supporting the decision. An invalid citation cannot
    /// displace the prior decision's approval, which would strip a validly
    /// supported subject at its next decision.
    supporting_approval: Option<String>,
    evaluation: Evaluation,
}

// policy-digest:authority-start
/// Each approval may support at most 1,024 distinct subjects.
const MAX_APPROVAL_DEPENDENTS: usize = 1_024;

/// Total demotions one authority invalidation may perform. The transitive closure
/// over an authority graph is unbounded by the per-approval cap alone, and the whole
/// walk runs in the invalidating transaction.
const MAX_AUTHORITY_DEMOTIONS: usize = 4_096;

/// Selects rows of `admission_decisions a` with no later committed decision
/// for the same subject. `load_prior_decision` expresses this same rule as an
/// ordered single-row seek; the two formulations must stay equivalent.
const LATEST_SUBJECT_DECISION_PREDICATE: &str = "NOT EXISTS (
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
)";

/// Grant validation and revocation share this live-approval definition so an
/// object honored as an approval is always revocable.
const APPROVAL_OBJECT_PREDICATE: &str = "o.object_kind='decision'
   AND o.invalidated_commit_seq IS NULL
   AND d.decision_kind='adr_accepted'
   AND d.invalidated_commit_seq IS NULL";

/// Longest authority chain [`validate_approval`] walks, counted in hops from the
/// approval to its root. A chain of this many hops holds this many plus one members,
/// which is what the walk's row count is compared against.
///
/// The walk deliberately expands one hop past this bound so an over-long chain
/// produces one row more than the count permits. Stopping the expansion exactly at
/// the bound would cap the row count at the permitted value, leaving the gate unable
/// to fire and validating a long chain on a truncated prefix of its ancestors.
///
/// A chain is human-authored accepted decisions, so real ones are short; the bound
/// only stops a pathological graph from making validation unbounded.
const MAX_AUTHORITY_CHAIN_DEPTH: usize = 64;

/// Whether the object named by `?1` qualifies as a live approval in its own right.
/// Used per chain member, so it takes the id from the enclosing row rather than a
/// bound parameter.
/// The enclosing query must bind `o` to `object_registry`.
/// The latest source-scoped decision for an object's lineage. A rejection here
/// binds every object on the lineage, including one whose own later decision
/// would otherwise serve.
fn latest_lineage_decision_sql(commit_bound: &str) -> String {
    format!(
        "(
    SELECT a.admission_decision_id
    FROM admission_decisions a
    WHERE a.subject_object_id IS NULL
      AND a.source_kind=o.source_kind
      AND a.source_id=o.source_id
      AND a.source_revision=o.source_revision
      AND a.commit_seq IS NOT NULL
      {commit_bound}
    ORDER BY a.commit_seq DESC,a.admission_decision_id DESC
    LIMIT 1
)"
    )
}

/// The enclosing query must bind `o` to `object_registry`.
/// An object earns standing only from a decision about itself. A lineage
/// decision can restrict it or govern it, but never stand in for one it lacks.
fn own_decision_exists_sql(commit_bound: &str) -> String {
    format!(
        "EXISTS (
    SELECT 1 FROM admission_decisions own
    WHERE own.subject_object_id=o.object_id
      AND own.source_kind=o.source_kind
      AND own.source_id=o.source_id
      AND own.source_revision=o.source_revision
      AND own.commit_seq IS NOT NULL
      {commit_bound}
)"
    )
}

fn approval_qualifies_predicate(object_column: &str) -> String {
    let governing = governing_decision_for_object_sql("");
    let own_decision = own_decision_exists_sql("");
    format!(
        "EXISTS(
             SELECT 1
             FROM object_registry o
             JOIN decisions d ON d.object_id=o.object_id
             JOIN admission_decisions a ON a.admission_decision_id={governing}
             WHERE o.object_id={object_column} AND {APPROVAL_OBJECT_PREDICATE}
               AND a.taint_class='user_explicit'
               AND a.source_class='explicit_user'
               AND a.effective_maturity IN ('approved','enforced')
               AND a.disposition='active'
               AND a.visibility='automatic'
               AND a.policy_revision={POLICY_REVISION}
               AND {own_decision}
         )"
    )
}
// policy-digest:authority-end

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
        if let Some(error) = self.already_poisoned() {
            return Err(error);
        }
        let result = self.insert_admission_observation_for_test_inner(
            object_id,
            observation_kind,
            domain_id,
            source_kind,
            source_id,
            source_revision,
        );
        self.poison(result)
    }

    #[cfg(feature = "test-support")]
    fn insert_admission_observation_for_test_inner(
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
    ) -> Result<AdmissionDecision, KernelError> {
        if let Some(error) = self.already_poisoned() {
            return Err(error);
        }
        let result = self.record_admission_inner(request);
        self.poison(result)
    }

    fn record_admission_inner(
        &mut self,
        request: AdmissionRequest,
    ) -> Result<AdmissionDecision, KernelError> {
        if matches!(
            request.event.kind,
            EventKind::Correct | EventKind::Replace | EventKind::ApprovalRevoked
        ) {
            return Err(KernelError::AdmissionPolicy);
        }
        let subject_object_id = request.subject_object_id.clone();
        let reason = request.event.reason.clone();
        self.with_authority_cascade(subject_object_id.as_deref(), &reason, |envelope| {
            envelope.apply_admission(request)
        })
    }

    /// Writes a decision and, when it costs the subject the authority it held,
    /// demotes the dependents that were relying on it. Both callers must run the
    /// same cascade, so neither owns a copy of it.
    fn with_authority_cascade(
        &mut self,
        subject_object_id: Option<&str>,
        reason: &str,
        write: impl FnOnce(&mut Self) -> Result<AdmissionDecision, KernelError>,
    ) -> Result<AdmissionDecision, KernelError> {
        let granted_before = self.subject_grants_authority(subject_object_id)?;
        let decision = write(self)?;
        if granted_before {
            self.demote_dependents_if_authority_lost(subject_object_id, reason)?;
        }
        Ok(decision)
    }

    /// Most subjects are not decision objects, and the chain walk cannot make one an
    /// authority. Settling the object kind first keeps the recursive query off the
    /// path of every ordinary admission.
    pub(super) fn subject_grants_authority(
        &self,
        subject_object_id: Option<&str>,
    ) -> Result<bool, KernelError> {
        let Some(subject) = subject_object_id else {
            return Ok(false);
        };
        if !subject_is_accepted_decision(self, Some(subject))? {
            return Ok(false);
        }
        validate_approval(self, Some(subject), None)
    }

    /// Quarantine, contradiction, rejection, and supersession break an approval's
    /// authority exactly as revocation does, so dependents still citing it follow.
    pub(super) fn demote_dependents_if_authority_lost(
        &mut self,
        subject_object_id: Option<&str>,
        reason: &str,
    ) -> Result<(), KernelError> {
        let Some(subject) = subject_object_id else {
            return Ok(());
        };
        if validate_approval(self, Some(subject), None)? {
            return Ok(());
        }
        let subject = subject.to_string();
        self.demote_authority_dependents(&subject, reason)?;
        Ok(())
    }

    /// Writes a decision without the caller-event restrictions of
    /// [`Self::record_admission_inner`]. `ApprovalRevoked` lowers support to the
    /// automatic ceiling on its own authority, so only revocation may emit it.
    fn apply_admission(
        &mut self,
        request: AdmissionRequest,
    ) -> Result<AdmissionDecision, KernelError> {
        let prepared = self.prepare_admission(request)?;
        self.write_admission(prepared, None)
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
        if !matches!(
            request.event.kind,
            EventKind::AcceptedAdr
                | EventKind::CodeObserved
                | EventKind::ConfigObserved
                | EventKind::Corroborate
                | EventKind::Verify
                | EventKind::Approve
                | EventKind::Enforce
                | EventKind::ExplicitReject
                | EventKind::Contradict
                | EventKind::Quarantine
                | EventKind::MarkStale
                | EventKind::MarkDisputed
                | EventKind::Other
        ) {
            return Err(KernelError::AdmissionPolicy);
        }
        let prepared = self.prepare_admission(request)?;
        if prepared.facts.candidate_id().is_none() {
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
        let AdmissionKey::Object(replaced_object_id) = prepared.facts.subject.clone() else {
            return Err(KernelError::AdmissionPolicy);
        };
        if !matches!(prepared.event.kind, EventKind::Correct | EventKind::Replace) {
            return Err(KernelError::AdmissionPolicy);
        }
        // A replacement cannot bypass a predecessor with a quarantined,
        // rejected, or contradicted disposition.
        if load_prior_decision(self, &prepared.facts)?.is_some_and(|stored| {
            matches!(
                stored.decision.disposition,
                Disposition::Quarantined | Disposition::Rejected | Disposition::Contradicted
            )
        }) {
            return Err(KernelError::AdmissionPolicy);
        }
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
        let reason = prepared.event.reason.clone();
        self.with_authority_cascade(Some(&replaced_object_id), &reason, |envelope| {
            envelope.write_admission(prepared, None)
        })
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
        if reason.trim().is_empty() {
            return Err(KernelError::AdmissionPolicy);
        }
        let approval_object_id = identity(approval_object_id)?;
        let approval = self
            .tx
            .query_row(
                &format!(
                    "SELECT {OBJECT_ROW_COLUMNS}
                     FROM object_registry o
                     JOIN decisions d ON d.object_id=o.object_id
                     WHERE o.object_id=?1 AND {APPROVAL_OBJECT_PREDICATE}"
                ),
                [approval_object_id.as_str()],
                object_row_from,
            )
            .optional()
            .map_err(map_sqlite)?
            .ok_or(KernelError::NotFound)?;
        object_write::invalidate(
            self.tx,
            self.commit_seq,
            "decisions",
            "object_id",
            &approval_object_id,
        )?;
        let mut invalidated = approval;
        invalidated.invalidated_commit_seq = Some(self.commit_seq);
        let revocation_reason = redact(reason);
        let revocation_audit = serde_json::json!({
            "approval_object_id": approval_object_id,
            "reason": revocation_reason.text,
            "policy_revision": POLICY_REVISION,
        });
        self.changes.push(PendingChange {
            object: invalidated,
            kind: "approval_revoke",
            replaced_object_id: None,
            redactions: vec![("reason".to_string(), revocation_reason)],
            audit: Some(revocation_audit),
        });

        let audit_position = self.changes.len() - 1;
        let (decisions, deferred) =
            self.demote_authority_dependents(&approval_object_id, reason)?;
        if let Some(audit) = self
            .changes
            .get_mut(audit_position)
            .and_then(|change| change.audit.as_mut())
        {
            audit["demoted"] = serde_json::json!(decisions.len());
            audit["deferred"] = serde_json::json!(deferred);
        }
        Ok(decisions)
    }

    /// Demotes every subject whose support descends from `authority_object_id`.
    ///
    /// An authority chain is transitive: when A approves B and B approves C,
    /// invalidating A leaves C's chain broken. Demoting B alone stops B granting
    /// future admissions but leaves C surfaced, so the closure follows dependents
    /// that are themselves approvals until no live authority remains.
    ///
    /// `validate_approval` derives authority from the whole chain, so an unvisited
    /// descendant of a revoked root already grants nothing. This walk therefore only
    /// restores visibility, and may stop early without leaving live authority behind.
    ///
    /// No *policy* outcome fails it. Failing would roll back the invalidation that
    /// prompted it, leaving the root active and every identical retry failing on the
    /// same graph — a permanently unrevokable approval. So the two conditions that
    /// would otherwise abort are deferred and counted instead: dependents past
    /// [`MAX_AUTHORITY_DEMOTIONS`], and dependents whose latest decision was written
    /// under a superseded policy revision and so cannot be re-evaluated.
    ///
    /// An I/O error or a stored source/taint class outside the current vocabulary
    /// still propagates, because neither leaves a coherent transaction to commit.
    ///
    /// The walk runs inside the invalidating transaction, and this store admits one
    /// writer, so revoking a widely cited approval holds that writer for the whole
    /// cascade — a few statements per dependent, up to [`MAX_AUTHORITY_DEMOTIONS`] of
    /// them. That is accepted here because authority validity does not depend on the
    /// walk finishing: [`validate_approval`] reads the chain, so a deferred dependent
    /// already grants nothing. Chunking the visibility repair across transactions is
    /// the remaining work, not a correctness gap.
    fn demote_authority_dependents(
        &mut self,
        authority_object_id: &str,
        reason: &str,
    ) -> Result<(Vec<AdmissionDecision>, usize), KernelError> {
        let mut decisions = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut frontier = vec![authority_object_id.to_string()];
        let mut deferred = 0usize;
        visited.insert(authority_object_id.to_string());
        while let Some(authority) = frontier.pop() {
            for dependent in load_approval_dependents(self, &authority)? {
                if !visited.insert(dependent.0.clone()) {
                    continue;
                }
                if decisions.len() >= MAX_AUTHORITY_DEMOTIONS || dependent.3 != POLICY_REVISION {
                    deferred += 1;
                    continue;
                }
                let subject = dependent.0.clone();
                self.demote_one_dependent(dependent, reason, &mut decisions)?;
                // Any dependent may itself have granted authority; a non-approval
                // simply has no dependents of its own.
                frontier.push(subject);
            }
        }
        Ok((decisions, deferred))
    }

    fn demote_one_dependent(
        &mut self,
        dependent: (String, String, String, i64),
        reason: &str,
        decisions: &mut Vec<AdmissionDecision>,
    ) -> Result<(), KernelError> {
        let (subject_object_id, source_class, taint_class, _) = dependent;
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
        decisions.push(self.apply_admission(request)?);
        Ok(())
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
            // A materialized candidate's decisions belong to its canonical object; a
            // candidate-keyed decision after materialization would be disconnected
            // from that object's chain.
            if candidate_is_materialized(self, candidate_id)? {
                return Err(KernelError::AdmissionPolicy);
            }
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
        // `AcceptedAdr` on an accepted decision supplies its own support, so
        // inheriting a predecessor's approval would make that record's root authority
        // depend on an ancestor it no longer needs, and a revoked one would block it.
        if request.event.approval_object_id.is_none()
            && !matches!(
                request.event.kind,
                EventKind::ApprovalRevoked
                    | EventKind::Correct
                    | EventKind::Replace
                    | EventKind::AcceptedAdr
            )
        {
            request.event.approval_object_id = stored
                .as_ref()
                .and_then(|stored| stored.approval_object_id.clone());
        }
        let approval_valid = validate_approval(
            self,
            request.event.approval_object_id.as_deref(),
            facts.subject_object_id(),
        )?;
        // The chain walk is expensive, and the cited approval is usually the stored
        // one because `prepare_admission` back-fills it.
        let stored_approval = stored
            .as_ref()
            .and_then(|stored| stored.approval_object_id.as_deref());
        let supporting_authority = match stored_approval {
            Some(approval) if Some(approval) == request.event.approval_object_id.as_deref() => {
                Some(approval_valid)
            }
            Some(approval) => Some(validate_approval(
                self,
                Some(approval),
                facts.subject_object_id(),
            )?),
            None => None,
        };
        let trigger = validate_trigger(self, &request.event, &facts)?;
        // A trigger cannot admit content classified below itself.
        let trigger_sensitivity = trigger.flatten().unwrap_or(Sensitivity::Normal);
        // Revocation states the support that survives it rather than letting the
        // evaluator infer one: the automatic ceiling, never above what is held.
        let remaining_support = (request.event.kind == EventKind::ApprovalRevoked).then(|| {
            prior
                .map_or(Maturity::Candidate, |prior| prior.effective_maturity)
                .min(automatic_ceiling(source_class, taint_class))
        });
        // Succession composes the predecessor's sensitivity, which for these events
        // is the subject being replaced.
        let predecessor_sensitivity =
            matches!(request.event.kind, EventKind::Correct | EventKind::Replace)
                .then_some(facts.sensitivity);
        let evaluation = evaluate_admission(EvaluationInputs {
            source_class,
            taint_class,
            prior,
            candidate_sensitivity: facts.sensitivity.max(trigger_sensitivity),
            predecessor_sensitivity,
            remaining_support,
            approval_valid,
            supporting_authority,
            subject_is_accepted_decision: subject_is_accepted_decision(
                self,
                facts.subject_object_id(),
            )?,
            event: if trigger.is_some() {
                request.event.kind
            } else {
                EventKind::Other
            },
            has_evidence: request.event.evidence_id.is_some(),
        })?;
        // A citation that did not lift support contributed nothing, so it must not
        // displace the approval that did. That holds for a valid citation too:
        // revoking it would otherwise demote a subject whose real authority is
        // untouched. The evaluator answers this against the carried maturity, which
        // is what an approval restoring clamped support has to be measured against.
        let supporting_approval = if evaluation.support_from_citation {
            request.event.approval_object_id.clone()
        } else {
            stored
                .as_ref()
                .and_then(|stored| stored.approval_object_id.clone())
        };
        Ok(PreparedDecision {
            facts,
            source_class,
            taint_class,
            event: request.event,
            supporting_approval,
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
            approval_object_id: prepared.supporting_approval.clone(),
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
            .supporting_approval
            .as_deref()
            .map(identity)
            .transpose()?;
        let cited_approval_object_id = prepared
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
            .or_else(|| prepared.facts.subject_object_id().map(str::to_string));
        // An approval only grants support above the automatic ceiling, so a decision
        // resting at or below it derives nothing from the approval it cites. Stored
        // rather than re-derived in SQL, which would duplicate the ceiling table.
        let elevated_support = prepared.evaluation.effective_maturity.get().rank()
            > automatic_ceiling(prepared.source_class, prepared.taint_class).rank();
        if elevated_support {
            if let Some(approval) = approval_object_id.as_deref() {
                enforce_approval_dependent_cap(self, approval, subject_object_id.as_deref())?;
            }
        }
        let candidate_payload_digest = prepared
            .facts
            .candidate_payload
            .as_deref()
            .map(|payload| format!("{:x}", Sha256::digest(payload)));
        self.tx
            .execute(
                "INSERT INTO admission_decisions(
                     admission_decision_id,candidate_id,candidate_ref,candidate_kind,
                     candidate_payload_digest,subject_object_id,source_kind,source_id,
                     source_revision,source_class,taint_class,event_kind,maturity,
                     effective_maturity,disposition,visibility,outcome,sensitivity_class,
                     policy_revision,reason,evidence_id,approval_object_id,elevated_support,
                     commit_seq,decided_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                           ?20,?21,?22,?23,?24,?25)",
                params![
                    admission_decision_id,
                    prepared.facts.candidate_id(),
                    prepared.facts.candidate_id(),
                    prepared.facts.candidate_kind,
                    candidate_payload_digest,
                    subject_object_id,
                    source_kind,
                    source_id,
                    prepared.facts.source_revision,
                    prepared.source_class.as_str(),
                    prepared.taint_class.as_str(),
                    prepared.event.kind.as_str(),
                    prepared.evaluation.historical_maturity.as_str(),
                    prepared.evaluation.effective_maturity.get().as_str(),
                    prepared.evaluation.disposition.as_str(),
                    prepared.evaluation.visibility.as_str(),
                    prepared.evaluation.outcome.as_str(),
                    prepared.evaluation.sensitivity.as_str(),
                    POLICY_REVISION,
                    reason.text,
                    evidence_id,
                    approval_object_id,
                    elevated_support,
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
            "subject_object_id": subject_object_id,
            "candidate_id": prepared.facts.candidate_id(),
            "source_class": prepared.source_class.as_str(),
            "taint_class": prepared.taint_class.as_str(),
            "approval_object_id": approval_object_id,
            "cited_approval_object_id": cited_approval_object_id,
            "event_kind": prepared.event.kind.as_str(),
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
        if let Some(object) = materialized.as_ref() {
            self.admission_latest.insert(
                AdmissionKey::Object(object.object_id.clone()),
                latest.clone(),
            );
        }
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
        self.subject.clone()
    }

    fn candidate_id(&self) -> Option<&str> {
        match &self.subject {
            AdmissionKey::Candidate(candidate_id) => Some(candidate_id),
            AdmissionKey::Object(_) => None,
        }
    }

    fn subject_object_id(&self) -> Option<&str> {
        match &self.subject {
            AdmissionKey::Candidate(_) => None,
            AdmissionKey::Object(object_id) => Some(object_id),
        }
    }
}

/// A candidate binds to at most one canonical object.
///
/// Reads `candidate_ref`, not `candidate_id`: the latter carries `ON DELETE SET NULL`,
/// so the staging sweep erases it after the retention cutoff and a newly staged
/// candidate reusing that id would materialize a second object.
fn candidate_is_materialized(
    envelope: &Envelope<'_>,
    candidate_id: &str,
) -> Result<bool, KernelError> {
    envelope
        .tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM admission_decisions
                 WHERE candidate_ref=?1 AND subject_object_id IS NOT NULL
                   AND commit_seq IS NOT NULL
             )",
            [candidate_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(map_sqlite)
}

/// Maps failed, canceled, abandoned, and lease-expired active staging rows to
/// [`KernelError::NotFound`] because none can promote a candidate to canonical state.
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
             WHERE c.candidate_id=?1
               AND (c.terminal_state IS NULL OR c.terminal_state='completed')
               AND (r.terminal_state IS NULL OR r.terminal_state='completed')
               AND (c.terminal_state IS NOT NULL OR c.lease_expires_at>?2)
               AND (r.terminal_state IS NOT NULL OR r.lease_expires_at>?2)",
                params![candidate_id.as_str(), current_time_ms()],
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
        subject: AdmissionKey::Candidate(candidate_id),
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
             FROM object_registry
             WHERE object_id=?1 AND invalidated_commit_seq IS NULL",
            [subject_object_id.as_str()],
            |row| {
                Ok(SubjectFacts {
                    subject: AdmissionKey::Object(subject_object_id.clone()),
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

/// Object subjects include source history because `visible_as_of` evaluates both
/// histories. Skipping source history lets a later object decision override a
/// newer source rejection and restore visibility. commentlint: allow(JUDGE)
fn load_prior_decision(
    envelope: &Envelope<'_>,
    facts: &SubjectFacts,
) -> Result<Option<StoredAdmission>, KernelError> {
    let key = facts.key();
    if let Some(prior) = envelope.admission_latest.get(&key) {
        return Ok(Some(prior.clone()));
    }
    let (filter, key_value) = match &key {
        AdmissionKey::Candidate(candidate_id) => ("candidate_id=?1", candidate_id.as_str()),
        AdmissionKey::Object(object_id) => ("subject_object_id=?1", object_id.as_str()),
    };
    let row = envelope
        .tx
        .query_row(
            &format!(
                "SELECT maturity,effective_maturity,disposition,outcome,source_class,
                        taint_class,sensitivity_class,policy_revision,approval_object_id
                 FROM admission_decisions
                 WHERE {filter} AND commit_seq IS NOT NULL
                 ORDER BY commit_seq DESC,admission_decision_id DESC LIMIT 1"
            ),
            [key_value],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite)?;
    let Some((
        maturity,
        effective_maturity,
        disposition,
        outcome,
        source_class,
        taint_class,
        sensitivity,
        policy_revision,
        approval_object_id,
    )) = row
    else {
        return Ok(None);
    };
    // Rows with a different `policy_revision` are rejected because their
    // encoded values may have different semantics.
    if policy_revision != POLICY_REVISION {
        return Err(KernelError::AdmissionPolicy);
    }
    Ok(Some(StoredAdmission {
        decision: PriorDecision {
            historical_maturity: Maturity::try_from(maturity.as_str())?,
            effective_maturity: Maturity::try_from(effective_maturity.as_str())?,
            disposition: Disposition::try_from(disposition.as_str())?,
            outcome: Outcome::try_from(outcome.as_str())?,
            source_class: SourceClass::try_from(source_class.as_str())?,
            taint_class: TaintClass::try_from(taint_class.as_str())?,
            sensitivity: sensitivity_from_ledger(&sensitivity)?,
        },
        approval_object_id,
    }))
}

/// Strict counterpart of [`Sensitivity::from_stored`] for ledger rows: an
/// unknown value is an error, never a substituted default.
fn sensitivity_from_ledger(value: &str) -> Result<Sensitivity, KernelError> {
    let parsed = Sensitivity::from_stored(value);
    if parsed.as_str() == value {
        Ok(parsed)
    } else {
        Err(KernelError::AdmissionPolicy)
    }
}

/// Enforces [`MAX_APPROVAL_DEPENDENTS`] distinct dependent subjects per approval object.
/// Excluding `subject_object_id` keeps repeat decisions for an existing dependent admissible.
/// Counting only latest decisions releases capacity when a subject moves to another approval.
fn enforce_approval_dependent_cap(
    envelope: &Envelope<'_>,
    approval_object_id: &str,
    subject_object_id: Option<&str>,
) -> Result<(), KernelError> {
    let dependents: i64 = envelope
        .tx
        .query_row(
            &format!(
                "SELECT COUNT(DISTINCT a.subject_object_id) FROM admission_decisions a
                 JOIN object_registry o ON o.object_id=a.subject_object_id
                 WHERE a.approval_object_id=?1 AND a.subject_object_id IS NOT NULL
                   AND o.invalidated_commit_seq IS NULL
                   AND a.subject_object_id IS NOT ?2
                   AND a.elevated_support=1
                   AND a.commit_seq IS NOT NULL
                   AND {LATEST_SUBJECT_DECISION_PREDICATE}"
            ),
            params![approval_object_id, subject_object_id],
            |row| row.get(0),
        )
        .map_err(map_sqlite)?;
    let cap = i64::try_from(MAX_APPROVAL_DEPENDENTS).map_err(|_| KernelError::AdmissionPolicy)?;
    if dependents >= cap {
        return Err(KernelError::AdmissionPolicy);
    }
    Ok(())
}

/// Whether `subject_object_id` is a live `adr_accepted` decision object, the only
/// kind that can hold authority.
fn subject_is_accepted_decision(
    envelope: &Envelope<'_>,
    subject_object_id: Option<&str>,
) -> Result<bool, KernelError> {
    let Some(subject_object_id) = subject_object_id else {
        return Ok(false);
    };
    envelope
        .tx
        .query_row(
            &format!(
                "SELECT EXISTS(
                     SELECT 1
                     FROM object_registry o
                     JOIN decisions d ON d.object_id=o.object_id
                     WHERE o.object_id=?1 AND {APPROVAL_OBJECT_PREDICATE}
                 )"
            ),
            [subject_object_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(map_sqlite)
}

/// Subjects whose latest decision still cites `approval_object_id`.
///
/// `LIMIT` exceeds [`MAX_APPROVAL_DEPENDENTS`] by one so the caller can distinguish
/// a set at the cap from one over it, while bounding the allocation.
fn load_approval_dependents(
    envelope: &Envelope<'_>,
    approval_object_id: &str,
) -> Result<Vec<(String, String, String, i64)>, KernelError> {
    let mut statement = envelope
        .tx
        .prepare(&format!(
            "SELECT a.subject_object_id,a.source_class,a.taint_class,a.policy_revision
             FROM admission_decisions a
             JOIN object_registry o ON o.object_id=a.subject_object_id
             WHERE a.approval_object_id=?1
               AND a.subject_object_id IS NOT NULL
               AND o.invalidated_commit_seq IS NULL
               AND a.elevated_support=1
               AND a.commit_seq IS NOT NULL
               AND {LATEST_SUBJECT_DECISION_PREDICATE}
             ORDER BY a.subject_object_id
             LIMIT {limit}",
            limit = MAX_APPROVAL_DEPENDENTS + 1
        ))
        .map_err(map_sqlite)?;
    let dependents = statement
        .query_map([approval_object_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(map_sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(map_sqlite)?;
    if dependents.len() > MAX_APPROVAL_DEPENDENTS {
        return Err(KernelError::AdmissionPolicy);
    }
    Ok(dependents)
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

// policy-digest:chain-start
fn validate_approval(
    envelope: &Envelope<'_>,
    approval_object_id: Option<&str>,
    subject_object_id: Option<&str>,
) -> Result<bool, KernelError> {
    let Some(approval_object_id) = approval_object_id else {
        return Ok(false);
    };
    let approval_object_id = identity(approval_object_id)?;
    // Authority is transitive: an approval promoted by another approval holds no
    // authority once that ancestor loses its own. Deriving this from the chain makes
    // validity intrinsic, so revocation's demotion fan-out only has to restore
    // visibility and may skip work without leaving a live grant behind.
    //
    // The subject is rejected anywhere in that chain, not merely as the approval
    // itself. Granting from an approval that already descends from the subject would
    // close a cycle, and the resulting decision would hold a rung no valid authority
    // supports once the cycle is detected.
    let qualifies = approval_qualifies_predicate("chain.object_id");
    let member_qualifies = approval_qualifies_predicate("member.object_id");
    envelope
        .tx
        .query_row(
            &format!(
                "WITH RECURSIVE chain(object_id,depth) AS (
                     SELECT ?1,0
                     UNION
                     SELECT a.approval_object_id,chain.depth+1
                     FROM chain
                     JOIN admission_decisions a ON a.subject_object_id=chain.object_id
                     WHERE a.approval_object_id IS NOT NULL
                       AND a.commit_seq IS NOT NULL
                       AND a.policy_revision={POLICY_REVISION}
                       AND {LATEST_SUBJECT_DECISION_PREDICATE}
                       AND chain.depth<={MAX_AUTHORITY_CHAIN_DEPTH}
                       AND {qualifies}
                 )
                 SELECT (SELECT COUNT(*) FROM chain)<={MAX_AUTHORITY_CHAIN_DEPTH}+1
                    AND NOT EXISTS(
                            SELECT 1 FROM chain member WHERE NOT {member_qualifies}
                        )
                    AND NOT EXISTS(
                            SELECT 1 FROM chain member WHERE member.object_id=?2
                        )"
            ),
            params![approval_object_id, subject_object_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(map_sqlite)
}
// policy-digest:chain-end

/// A validated trigger reports the sensitivity it carries, which composes into the
/// admission so an observation cannot admit content less classified than itself.
///
/// `None` means the event has no trigger to satisfy, which is not a refusal.
type TriggerSensitivity = Option<Sensitivity>;

fn validate_trigger(
    envelope: &Envelope<'_>,
    event: &AdmissionEvent,
    facts: &SubjectFacts,
) -> Result<Option<TriggerSensitivity>, KernelError> {
    match event.kind {
        EventKind::CodeObserved | EventKind::ConfigObserved => {
            let Some(trigger_object_id) = event.trigger_object_id.as_deref() else {
                return Ok(None);
            };
            let trigger_object_id = identity(trigger_object_id)?;
            let expected = if event.kind == EventKind::CodeObserved {
                "code_present"
            } else {
                "config_present"
            };
            let sensitivity: Option<String> = envelope
                .tx
                .query_row(
                    "SELECT observed.sensitivity_class
                     FROM object_registry o
                     JOIN observations observed ON observed.object_id=o.object_id
                     LEFT JOIN evidence_meta backing
                            ON backing.evidence_id=observed.evidence_id
                     WHERE o.object_id=?1 AND o.object_kind='observation'
                       AND o.invalidated_commit_seq IS NULL
                       AND o.source_kind=?3
                       AND o.source_id=?4
                       AND o.source_revision=?5
                       AND observed.observation_kind=?2
                       AND observed.invalidated_commit_seq IS NULL
                       AND (
                           observed.evidence_id IS NULL
                           OR (
                               backing.evidence_id IS NOT NULL
                               AND backing.invalidated_commit_seq IS NULL
                           )
                       )",
                    params![
                        trigger_object_id,
                        expected,
                        facts.source_kind,
                        facts.source_id,
                        facts.source_revision
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite)?;
            match sensitivity {
                Some(class) => Ok(Some(Some(sensitivity_from_ledger(&class)?))),
                None => Ok(None),
            }
        }
        // kh8.4 owns the passing-artifact writer. A bare evidence reference cannot
        // establish that contract, so enforcement remains closed until that seam exists.
        EventKind::Enforce => Ok(None),
        _ => Ok(Some(None)),
    }
}

/// The strongest surface a single stored decision can justify, or `Hidden` when
/// the row cannot be interpreted. `prefix` selects the column alias group.
fn decided_row(
    row: &rusqlite::Row<'_>,
    prefix: &str,
) -> rusqlite::Result<Option<(VisibilityRow, Sensitivity)>> {
    let Some(revision) = row.get::<_, Option<i64>>(&*format!("{prefix}policy_revision"))? else {
        return Ok(None);
    };
    let taint = row
        .get::<_, Option<String>>(&*format!("{prefix}taint_class"))?
        .and_then(|value| TaintClass::try_from(value.as_str()).ok());
    let source = row
        .get::<_, Option<String>>(&*format!("{prefix}source_class"))?
        .and_then(|value| SourceClass::try_from(value.as_str()).ok());
    let sensitivity = Sensitivity::from_stored(
        &row.get::<_, Option<String>>(&*format!("{prefix}sensitivity_class"))?
            .unwrap_or_default(),
    );
    // A newer revision may attach meanings this binary cannot see, and a pairing
    // the evaluator forbids can only be corruption or an out-of-band write.
    let interpretable = revision <= POLICY_REVISION
        && match (source, taint) {
            (Some(source), Some(taint)) => source_allows_taint(source, taint),
            _ => false,
        };
    if !interpretable {
        return Ok(Some((VisibilityRow::AuditOnly, Sensitivity::Secret)));
    }
    let floor = taint.map_or(Sensitivity::Secret, sensitivity_floor);
    let stored = row
        .get::<_, Option<String>>(&*format!("{prefix}visibility"))?
        .and_then(|value| VisibilityRow::try_from(value.as_str()).ok());
    let expected = match (
        row.get::<_, Option<String>>(&*format!("{prefix}effective_maturity"))?
            .map(|value| Maturity::try_from(value.as_str())),
        row.get::<_, Option<String>>(&*format!("{prefix}disposition"))?
            .map(|value| Disposition::try_from(value.as_str())),
    ) {
        (Some(Ok(effective)), Some(Ok(disposition))) => {
            Some(visibility_row(effective, disposition))
        }
        _ => None,
    };
    Ok(Some((
        served_visibility_row(stored, expected),
        sensitivity.max(floor),
    )))
}

impl KernelStore {
    /// Serving reads must use this filtered view; `known_as_of` remains an audit/replay view.
    ///
    /// An object serves only after it has its own committed decision.
    /// Visibility uses the latest committed object- or source-level decision
    /// at or before the snapshot — the same prior the writer evaluates against
    /// — so a newer source-level rejection overrides an earlier object-level
    /// admission.
    ///
    /// Rows fail closed when the classification pairing is rejected.
    /// Rows fail closed when `policy_revision` exceeds `POLICY_REVISION`.
    /// Rows fail closed when the decision's source lineage differs from the registry.
    /// Lower revisions keep the current surface mapping.
    pub fn visible_as_of(
        &self,
        surface: Surface,
        requested: i64,
    ) -> Result<VisibleAsOf, KernelError> {
        let governing = governing_decision_for_object_sql("AND a.commit_seq<=:governing_as_of");
        let lineage = latest_lineage_decision_sql("AND a.commit_seq<=:governing_as_of");
        let own_decision = own_decision_exists_sql("AND own.commit_seq<=:governing_as_of");
        let (tip, rows) = self.read_snapshot(requested, |tx| {
            let mut statement = tx
                .prepare(&format!(
                    "SELECT o.object_id,o.object_kind,o.domain_id,o.source_kind,o.source_id,
                            o.source_revision,o.created_commit_seq,NULL,NULL,o.sensitivity_class,
                            d.effective_maturity AS d_effective_maturity,
                            d.disposition AS d_disposition,d.visibility AS d_visibility,
                            d.taint_class AS d_taint_class,d.source_class AS d_source_class,
                            d.policy_revision AS d_policy_revision,
                            d.sensitivity_class AS d_sensitivity_class,
                            s.effective_maturity AS s_effective_maturity,
                            s.disposition AS s_disposition,s.visibility AS s_visibility,
                            s.taint_class AS s_taint_class,s.source_class AS s_source_class,
                            s.policy_revision AS s_policy_revision,
                            s.sensitivity_class AS s_sensitivity_class
                     FROM object_registry o
                     JOIN admission_decisions d
                       ON d.admission_decision_id={governing}
                     LEFT JOIN admission_decisions s
                       ON s.admission_decision_id={lineage}
                     WHERE o.created_commit_seq<=:governing_as_of
                       AND (o.invalidated_commit_seq IS NULL
                            OR :governing_as_of<o.invalidated_commit_seq)
                       AND {own_decision}
                     ORDER BY o.object_id"
                ))
                .map_err(map_sqlite)?;
            let rows = statement
                .query_map(
                    rusqlite::named_params! { ":governing_as_of": requested },
                    |row| {
                        let mut object = object_row_from(row)?;
                        let (mut visibility_row_value, mut sensitivity) = decided_row(row, "d_")?
                            .unwrap_or((VisibilityRow::AuditOnly, Sensitivity::Secret));
                        // A lineage restriction outlives a newer decision about one
                        // object, so the served surface is the stricter of the two.
                        if let Some((lineage_row, lineage_sensitivity)) = decided_row(row, "s_")? {
                            visibility_row_value = served_visibility_row(
                                Some(visibility_row_value),
                                Some(lineage_row),
                            );
                            sensitivity = sensitivity.max(lineage_sensitivity);
                        }
                        object.sensitivity = object.sensitivity.max(sensitivity);
                        let visibility =
                            surface_visibility(visibility_row_value, surface, object.sensitivity);
                        Ok((object, visibility))
                    },
                )
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

pub const fn served_visibility_row(
    stored: Option<VisibilityRow>,
    expected: Option<VisibilityRow>,
) -> VisibilityRow {
    match (stored, expected) {
        (None, _) | (_, None) => VisibilityRow::AuditOnly,
        (Some(stored), Some(expected)) => match (stored, expected) {
            (VisibilityRow::AuditOnly, _) | (_, VisibilityRow::AuditOnly) => {
                VisibilityRow::AuditOnly
            }
            (VisibilityRow::ReviewOnly, _) | (_, VisibilityRow::ReviewOnly) => {
                VisibilityRow::ReviewOnly
            }
            (VisibilityRow::ExplicitLabeled, _) | (_, VisibilityRow::ExplicitLabeled) => {
                VisibilityRow::ExplicitLabeled
            }
            (VisibilityRow::Automatic, VisibilityRow::Automatic) => VisibilityRow::Automatic,
        },
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
/// `subject_is_accepted_decision` confines the accepted-record exception to the object kind that
/// can hold authority; without it any subject submitted under `AcceptedAdr` would self-approve.
const fn admission_ceiling(
    event: EventKind,
    automatic: Maturity,
    subject_is_accepted_decision: bool,
) -> Maturity {
    match event {
        EventKind::AcceptedAdr
            if subject_is_accepted_decision && automatic.rank() >= Maturity::Verified.rank() =>
        {
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
                    supporting_authority: None,
                    subject_is_accepted_decision: false,
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
                        supporting_authority: Some(true),
                        subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: true,
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
            supporting_authority: None,
            subject_is_accepted_decision: true,
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
            supporting_authority: None,
            subject_is_accepted_decision: true,
        })
        .unwrap();
        assert_eq!(inferred.historical_maturity, Maturity::Candidate);
        assert_eq!(inferred.outcome, Outcome::Deny);

        // The exception is confined to the object kind that can hold authority, so
        // any other subject submitted the same way still buys an approval.
        let impostor = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            event: EventKind::AcceptedAdr,
            has_evidence: true,
            remaining_support: None,
            supporting_authority: None,
            subject_is_accepted_decision: false,
        })
        .unwrap();
        assert_eq!(impostor.historical_maturity, Maturity::Candidate);
        assert_eq!(impostor.outcome, Outcome::Deny);
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                supporting_authority: Some(true),
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
                event: EventKind::Other,
                has_evidence: false,
                remaining_support: None,
            })
            .unwrap();
            assert!(result.sensitivity >= Sensitivity::Sensitive);
        }
    }

    /// Prior state for a subject that an approval lifted above its automatic ceiling.
    fn approved_prior() -> PriorDecision {
        PriorDecision {
            historical_maturity: Maturity::Approved,
            effective_maturity: Maturity::Approved,
            disposition: Disposition::Active,
            outcome: Outcome::Promote,
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            sensitivity: Sensitivity::Normal,
        }
    }

    fn trusted_code_input(event: EventKind) -> EvaluationInputs {
        EvaluationInputs {
            source_class: SourceClass::TrustedLocalCode,
            taint_class: TaintClass::CurrentCode,
            prior: None,
            candidate_sensitivity: Sensitivity::Normal,
            predecessor_sensitivity: None,
            approval_valid: false,
            supporting_authority: None,
            subject_is_accepted_decision: false,
            event,
            has_evidence: false,
            remaining_support: None,
        }
    }

    #[test]
    fn an_accepted_adr_roots_authority_only_from_an_accepted_decision_object() {
        let rooted = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::ExplicitUser,
            taint_class: TaintClass::UserExplicit,
            subject_is_accepted_decision: true,
            ..trusted_code_input(EventKind::AcceptedAdr)
        })
        .unwrap();
        assert_eq!(rooted.effective_maturity.get(), Maturity::Approved);
        assert_eq!(rooted.outcome, Outcome::Admit);
        assert_eq!(rooted.visibility, VisibilityRow::Automatic);

        // The exception is confined to accepted-decision objects; any other
        // subject submitted the same way must still buy authority.
        let impostor = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::ExplicitUser,
            taint_class: TaintClass::UserExplicit,
            subject_is_accepted_decision: false,
            ..trusted_code_input(EventKind::AcceptedAdr)
        })
        .unwrap();
        assert_eq!(impostor.outcome, Outcome::Deny);
        assert!(impostor.effective_maturity.get().rank() < Maturity::Approved.rank());

        // A pair whose automatic ceiling stays at `Candidate` still buys an approval,
        // even for an accepted decision object.
        let inferred = evaluate_admission(EvaluationInputs {
            source_class: SourceClass::ModelInference,
            taint_class: TaintClass::AssistantInference,
            subject_is_accepted_decision: true,
            ..trusted_code_input(EventKind::AcceptedAdr)
        })
        .unwrap();
        assert_eq!(inferred.outcome, Outcome::Deny);
        assert!(inferred.effective_maturity.get().rank() < Maturity::Approved.rank());
    }

    #[test]
    fn leaving_a_restricted_disposition_requires_authority() {
        for restricted in [
            Disposition::Rejected,
            Disposition::Contradicted,
            Disposition::Quarantined,
        ] {
            for event in [EventKind::MarkStale, EventKind::MarkDisputed] {
                let prior = PriorDecision {
                    disposition: restricted,
                    ..approved_prior()
                };
                let input = EvaluationInputs {
                    prior: Some(prior),
                    ..trusted_code_input(event)
                };
                let denied = evaluate_admission(input).unwrap();
                assert_eq!(denied.disposition, restricted, "{restricted:?}/{event:?}");
                assert_eq!(denied.outcome, Outcome::Deny, "{restricted:?}/{event:?}");

                let authorized = evaluate_admission(EvaluationInputs {
                    approval_valid: true,
                    supporting_authority: Some(true),
                    subject_is_accepted_decision: false,
                    ..input
                })
                .unwrap();
                assert_ne!(
                    authorized.disposition, restricted,
                    "{restricted:?}/{event:?}"
                );
            }
        }
    }

    #[test]
    fn an_authority_event_on_a_held_rung_is_denied_not_replayed() {
        for event in [EventKind::Approve, EventKind::Enforce] {
            let unauthorized = evaluate_admission(EvaluationInputs {
                prior: Some(approved_prior()),
                supporting_authority: Some(true),
                subject_is_accepted_decision: false,
                has_evidence: true,
                ..trusted_code_input(event)
            })
            .unwrap();
            assert_eq!(unauthorized.outcome, Outcome::Deny, "{event:?}");
        }
    }

    #[test]
    fn revoked_authority_cannot_carry_support_above_the_automatic_ceiling() {
        let input = EvaluationInputs {
            prior: Some(approved_prior()),
            // The prior decision's own approval no longer validates.
            supporting_authority: Some(false),
            ..trusted_code_input(EventKind::CodeObserved)
        };
        let demoted = evaluate_admission(input).unwrap();
        assert_eq!(demoted.historical_maturity, Maturity::Approved);
        assert_eq!(demoted.effective_maturity.get(), Maturity::Verified);
        assert_eq!(demoted.outcome, Outcome::DemoteSupport);

        // A still-valid supporting approval keeps the support it granted.
        let retained = evaluate_admission(EvaluationInputs {
            supporting_authority: Some(true),
            ..input
        })
        .unwrap();
        assert_eq!(retained.effective_maturity.get(), Maturity::Approved);

        // A caller citing a bogus approval cannot demote a subject whose own
        // supporting approval is untouched.
        let unforgeable = evaluate_admission(EvaluationInputs {
            approval_valid: false,
            supporting_authority: Some(true),
            ..trusted_code_input(EventKind::Other)
        })
        .unwrap();
        assert_eq!(unforgeable.effective_maturity.get(), Maturity::Candidate);
        let unforgeable = evaluate_admission(EvaluationInputs {
            prior: Some(approved_prior()),
            approval_valid: false,
            supporting_authority: Some(true),
            ..trusted_code_input(EventKind::Other)
        })
        .unwrap();
        assert_eq!(unforgeable.effective_maturity.get(), Maturity::Approved);
        assert_ne!(unforgeable.outcome, Outcome::DemoteSupport);

        // Support never lifted by an approval is not clamped.
        let uncited = evaluate_admission(EvaluationInputs {
            prior: Some(PriorDecision {
                historical_maturity: Maturity::Verified,
                effective_maturity: Maturity::Verified,
                ..approved_prior()
            }),
            ..trusted_code_input(EventKind::CodeObserved)
        })
        .unwrap();
        assert_eq!(uncited.effective_maturity.get(), Maturity::Verified);
    }

    #[test]
    fn an_event_that_names_a_disposition_keeps_its_own_outcome() {
        // A non-active disposition withdraws support, so effective maturity drops.
        // That must not relabel the event as a support demotion.
        for (event, expected, disposition) in [
            (
                EventKind::Quarantine,
                Outcome::Quarantine,
                Disposition::Quarantined,
            ),
            (
                EventKind::ExplicitReject,
                Outcome::Reject,
                Disposition::Rejected,
            ),
            (
                EventKind::Contradict,
                Outcome::Deny,
                Disposition::Contradicted,
            ),
            (EventKind::MarkStale, Outcome::Deny, Disposition::Stale),
            (
                EventKind::MarkDisputed,
                Outcome::Deny,
                Disposition::Disputed,
            ),
        ] {
            let result = evaluate_admission(EvaluationInputs {
                prior: Some(approved_prior()),
                supporting_authority: Some(true),
                approval_valid: true,
                ..trusted_code_input(event)
            })
            .unwrap();
            assert_eq!(result.disposition, disposition, "{event:?}");
            assert_eq!(result.outcome, expected, "{event:?}");
            assert!(
                result.effective_maturity.get().rank() < approved_prior().effective_maturity.rank(),
                "{event:?} should withdraw support"
            );
        }
    }

    #[test]
    fn a_support_only_change_still_reports_a_demotion() {
        let demoted = evaluate_admission(EvaluationInputs {
            prior: Some(approved_prior()),
            supporting_authority: Some(false),
            ..trusted_code_input(EventKind::CodeObserved)
        })
        .unwrap();
        assert_eq!(demoted.disposition, Disposition::Active);
        assert_eq!(demoted.outcome, Outcome::DemoteSupport);
    }

    #[test]
    fn a_self_approving_record_decays_once_its_accepted_status_is_gone() {
        let self_approved = PriorDecision {
            source_class: SourceClass::ExplicitUser,
            taint_class: TaintClass::UserExplicit,
            ..approved_prior()
        };
        let base = EvaluationInputs {
            source_class: SourceClass::ExplicitUser,
            taint_class: TaintClass::UserExplicit,
            prior: Some(self_approved),
            // A self-approving record cites no approval.
            supporting_authority: None,
            ..trusted_code_input(EventKind::CodeObserved)
        };
        let held = evaluate_admission(EvaluationInputs {
            subject_is_accepted_decision: true,
            ..base
        })
        .unwrap();
        assert_eq!(held.effective_maturity.get(), Maturity::Approved);

        // Once the backing accepted status is gone, the support it granted goes too.
        let decayed = evaluate_admission(EvaluationInputs {
            subject_is_accepted_decision: false,
            ..base
        })
        .unwrap();
        assert_eq!(decayed.effective_maturity.get(), Maturity::Verified);
        assert_eq!(decayed.outcome, Outcome::DemoteSupport);
    }

    #[test]
    fn distinct_denied_events_are_each_recorded() {
        let prior = PriorDecision {
            historical_maturity: Maturity::Candidate,
            effective_maturity: Maturity::Candidate,
            outcome: Outcome::Deny,
            ..approved_prior()
        };
        for event in [EventKind::Corroborate, EventKind::Verify] {
            let denied = evaluate_admission(EvaluationInputs {
                prior: Some(prior),
                ..trusted_code_input(event)
            })
            .unwrap();
            assert_eq!(denied.outcome, Outcome::Deny, "{event:?}");
            assert_eq!(denied.effective_maturity.get(), Maturity::Candidate);
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
                    supporting_authority: None,
                    subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
        };
        assert_eq!(evaluate_admission(base), Err(KernelError::AdmissionPolicy));

        let unsupported = evaluate_admission(EvaluationInputs {
            remaining_support: Some(Maturity::Enforced),
            supporting_authority: None,
            subject_is_accepted_decision: false,
            ..base
        });
        assert_eq!(unsupported, Err(KernelError::AdmissionPolicy));

        for remaining in [Maturity::Candidate, Maturity::Corroborated] {
            let result = evaluate_admission(EvaluationInputs {
                remaining_support: Some(remaining),
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
                    supporting_authority: None,
                    subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
        };
        assert_eq!(
            evaluate_admission(replay).unwrap().outcome,
            Outcome::Promote
        );

        assert_eq!(
            evaluate_admission(EvaluationInputs {
                has_evidence: false,
                remaining_support: None,
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
                supporting_authority: None,
                subject_is_accepted_decision: false,
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
            supporting_authority: None,
            subject_is_accepted_decision: false,
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
        // Authority validity is policy expressed in SQL, so it belongs under the
        // same tripwire as the evaluator and its tables.
        policy.push_str(section(
            source,
            "// policy-digest:authority-start",
            "// policy-digest:authority-end",
        ));
        policy.push_str(section(
            source,
            "// policy-digest:chain-start",
            "// policy-digest:chain-end",
        ));
        let digest = format!("{:x}", Sha256::digest(policy));
        assert_eq!(POLICY_REVISION, 1);
        assert_eq!(digest, REVISION_1_SOURCE_DIGEST);
    }
}
