use mc_core::claim_operation::{
    canonical_json_encode, compute_applicability_heads_digest,
    compute_claim_operation_request_digest, compute_policy_heads_digest,
    decode_claim_operation_result, format_revision_locator, is_valid_public_claim_id,
    sha256_hex_utf8, ClaimMutationToken, PolicyHeadCounts, RevisionLocator, SnapshotVector,
    CLAIM_REQUEST_ENCODING_VERSION, CLAIM_RESULT_ENCODING_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const TOKEN_VERSION: u32 = 1;
const POLICY_VERSION: i64 = 1;
const POLICY_ACTOR: &str = "claim-operation-kernel";
const APPLICABILITY_STREAM_KEY: &str = "baseline:v1";
const APPLICABILITY_KEY_PROTOCOL: &str = "mc-applicability-stream-key-v1";
const TAINT_CLASSIFIER_METHOD: &str = "mc-taint-classifier-v1";

pub type AdapterResult<T> = Result<T, String>;

/// The only producer whose explicit-user observation may grant explicit-user
/// credit to a revision that changes content. Mirrored by
/// `EXPLICIT_USER_REVISION_PRODUCER` in
/// `packages/plugin/src/features/magic-context/memory/storage-claim-policy.ts`;
/// the conformance suite compares the two policies' verdicts, so a drift here
/// shows up as a maturity disagreement rather than passing silently.
pub const EXPLICIT_USER_REVISION_PRODUCER: &str = "dashboard:tauri";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationChannel {
    TauriExplicitUser,
    BearerHttp,
}

impl MutationChannel {
    fn producer(self) -> &'static str {
        match self {
            Self::TauriExplicitUser => EXPLICIT_USER_REVISION_PRODUCER,
            Self::BearerHttp => "dashboard:http",
        }
    }

    fn actor(self) -> &'static str {
        match self {
            Self::TauriExplicitUser => "dashboard:tauri:explicit-user",
            Self::BearerHttp => "dashboard:http:bearer",
        }
    }

    fn source_trust_class(self) -> &'static str {
        match self {
            Self::TauriExplicitUser => "explicit_user",
            Self::BearerHttp => "model_inference",
        }
    }

    fn origin_taint(self) -> &'static str {
        match self {
            Self::TauriExplicitUser => "USER_EXPLICIT",
            Self::BearerHttp => "ASSISTANT_INFERENCE",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimMutationTarget {
    pub revision_locator: String,
    pub mutation_token: ClaimMutationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviseClaimInput {
    pub target: ClaimMutationTarget,
    pub operation_key: String,
    pub content: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetLifecycleInput {
    pub target: ClaimMutationTarget,
    pub operation_key: String,
    pub lifecycle_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkArchiveInput {
    pub targets: Vec<ClaimMutationTarget>,
    pub operation_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLabel {
    pub independence_key: String,
    pub source_trust_class: String,
    pub extractor: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicabilityPath {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicabilitySymbol {
    pub protocol: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicabilityState {
    pub stream_key: String,
    pub owner_kind: String,
    pub branch_selector: Option<String>,
    pub context_fingerprint: Option<String>,
    pub sequence: i64,
    pub state: String,
    pub known_from: Option<i64>,
    pub recorded_at: i64,
    pub paths_state: String,
    pub dependency_fingerprint: Option<String>,
    pub dependency_protocol: Option<String>,
    pub verifier_spec: Option<String>,
    pub paths: Vec<ApplicabilityPath>,
    pub symbols: Vec<ApplicabilitySymbol>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimDispositions {
    pub stale: bool,
    pub disputed: bool,
    pub superseded: bool,
    pub rejected: bool,
    pub contradicted: bool,
    pub quarantined: bool,
}

impl ClaimDispositions {
    fn active_names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.stale {
            names.push("stale");
        }
        if self.disputed {
            names.push("disputed");
        }
        if self.superseded {
            names.push("superseded");
        }
        if self.rejected {
            names.push("rejected");
        }
        if self.contradicted {
            names.push("contradicted");
        }
        if self.quarantined {
            names.push("quarantined");
        }
        names
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPolicyView {
    pub effective_maturity: String,
    pub origin_taint: String,
    pub auto_eligible: bool,
    pub explicit_eligible: bool,
    pub hard_hidden: bool,
    pub policy_version: i64,
    pub generation: i64,
    pub dispositions: ClaimDispositions,
    pub explicit_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimTelemetry {
    pub seen_count: i64,
    pub retrieval_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMemory {
    pub public_claim_id: String,
    pub revision_locator: String,
    pub revision: i64,
    pub content: String,
    pub content_digest: String,
    pub revision_created_at: i64,
    pub project_identity: String,
    pub category: String,
    pub normalized_hash: String,
    pub importance: i64,
    pub memory_scope: String,
    pub sharing: String,
    pub expires_at: Option<i64>,
    pub lifecycle_state: String,
    pub evidence_labels: Vec<EvidenceLabel>,
    pub applicability: Vec<ApplicabilityState>,
    pub policy: ClaimPolicyView,
    pub telemetry: ClaimTelemetry,
    pub mutation_token: ClaimMutationToken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMemoryReadResult {
    pub outcome: String,
    pub claims: Vec<ClaimMemory>,
    pub snapshot_vector: Option<SnapshotVector>,
    pub stale_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMemoryStats {
    pub total: i64,
    pub active: i64,
    pub archived: i64,
    pub retired: i64,
    pub categories: Vec<ClaimCategoryCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimCategoryCount {
    pub category: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimProjectRow {
    pub identity: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMutationResponse {
    pub outcome: String,
    pub replayed: bool,
    pub request_digest: String,
    pub result_json: String,
    pub result: Value,
    pub refreshed_claims: Vec<ClaimMemory>,
    pub snapshot_vector: SnapshotVector,
}

#[derive(Debug, Clone)]
struct ClaimRef {
    claim_id: i64,
    project_id: i64,
    current_revision_id: i64,
    public_claim_id: String,
    revision: i64,
    content: String,
    content_digest: String,
}

#[derive(Debug, Clone)]
struct Effect {
    effect_key: String,
    project_id: i64,
    claim_id: i64,
    revision_id: Option<i64>,
    change_kind: String,
}

#[derive(Debug, Clone)]
enum Stage {
    Stale(String),
    Noop {
        payload: Value,
        mutation_token_public_ids: Vec<String>,
    },
    Effects {
        payload: Value,
        effects: Vec<Effect>,
        policy_revision_ids: Vec<i64>,
        mutation_token_public_ids: Vec<String>,
    },
}

#[derive(Debug)]
struct RunResult {
    outcome: String,
    replayed: bool,
    request_digest: String,
    result_json: String,
    result: Value,
}

fn sql<T>(result: rusqlite::Result<T>) -> AdapterResult<T> {
    result.map_err(|error| error.to_string())
}

fn valid_operation_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}

fn marker_incarnation(conn: &Connection) -> AdapterResult<String> {
    sql(conn.query_row(
        "SELECT database_incarnation_id FROM mc_format_marker WHERE id = 1",
        [],
        |row| row.get(0),
    ))
}

fn read_generations(
    conn: &Connection,
    project_ids: &[i64],
) -> AdapterResult<BTreeMap<String, i64>> {
    let mut generations = BTreeMap::new();
    for project_id in project_ids {
        let generation = sql(conn
            .query_row(
                "SELECT generation FROM claim_project_generations WHERE project_id = ?1",
                [project_id],
                |row| row.get(0),
            )
            .optional())?
        .unwrap_or(0);
        generations.insert(project_id.to_string(), generation);
    }
    Ok(generations)
}

fn read_snapshot_vector(conn: &Connection, project_ids: &[i64]) -> AdapterResult<SnapshotVector> {
    let mut ids = project_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let generations = read_generations(conn, &ids)?;
    Ok(SnapshotVector {
        vector_version: 1,
        database_incarnation_id: marker_incarnation(conn)?,
        workspace_epoch: String::new(),
        project_generations: generations.clone(),
        policy_generations: generations,
    })
}

fn lifecycle_head(conn: &Connection, claim_id: i64) -> AdapterResult<(i64, i64, String)> {
    sql(conn.query_row(
        "SELECT event_id, seq, state FROM claim_memory_lifecycle_heads WHERE claim_id = ?1",
        [claim_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ))
}

fn applicability_digest(conn: &Connection, revision_id: i64) -> AdapterResult<String> {
    let mut statement = sql(conn.prepare(
        "SELECT stream.stream_key, MAX(assertion.seq) \
         FROM claim_revision_applicability_streams stream \
         JOIN claim_revision_applicability_assertions assertion ON assertion.stream_id = stream.id \
         WHERE stream.revision_id = ?1 GROUP BY stream.id, stream.stream_key",
    ))?;
    let heads = sql(statement
        .query_map([revision_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<(String, i64)>>>()))?;
    compute_applicability_heads_digest(&heads).map_err(|error| error.to_string())
}

fn policy_counts(conn: &Connection, revision_id: i64) -> AdapterResult<PolicyHeadCounts> {
    let maturity_seq = sql(conn.query_row(
        "SELECT MAX(assertion.seq) FROM claim_maturity_streams stream \
             JOIN claim_maturity_assertions assertion ON assertion.stream_id = stream.id \
             WHERE stream.revision_id = ?1",
        [revision_id],
        |row| row.get::<_, Option<i64>>(0),
    ))?
    .unwrap_or(0);
    let count = |table: &str, predicate: &str| -> AdapterResult<i64> {
        let query = format!("SELECT COUNT(*) FROM {table} WHERE {predicate}");
        sql(conn.query_row(&query, [revision_id], |row| row.get(0)))
    };
    Ok(PolicyHeadCounts {
        maturity_seq,
        approval_count: count("claim_approval_actions", "revision_id = ?1")?,
        disposition_count: count("claim_disposition_events", "revision_id = ?1")?,
        artifact_count: count("claim_enforcement_artifacts", "revision_id = ?1")?,
        artifact_event_count: sql(conn.query_row(
            "SELECT COUNT(*) FROM claim_enforcement_artifact_events event \
             JOIN claim_enforcement_artifacts artifact ON artifact.id = event.artifact_id \
             WHERE artifact.revision_id = ?1",
            [revision_id],
            |row| row.get(0),
        ))?,
        verification_count: count("verification_events", "revision_id = ?1")?,
    })
}

fn mutation_token(conn: &Connection, claim: &ClaimRef) -> AdapterResult<ClaimMutationToken> {
    Ok(ClaimMutationToken {
        token_version: TOKEN_VERSION,
        public_claim_id: claim.public_claim_id.clone(),
        revision: claim.revision,
        content_digest: claim.content_digest.clone(),
        lifecycle_seq: lifecycle_head(conn, claim.claim_id)?.1,
        applicability_heads_digest: applicability_digest(conn, claim.current_revision_id)?,
        policy_heads_digest: compute_policy_heads_digest(&policy_counts(
            conn,
            claim.current_revision_id,
        )?)
        .map_err(|error| error.to_string())?,
    })
}

fn get_claim(conn: &Connection, public_claim_id: &str) -> AdapterResult<Option<ClaimRef>> {
    if !is_valid_public_claim_id(public_claim_id) {
        return Err(format!("invalid public claim ID: {public_claim_id}"));
    }
    sql(conn
        .query_row(
            "SELECT claim.id, claim.project_id, claim.current_revision_id, public.public_id, \
                    revision.revision, revision.content, revision.content_sha256 \
             FROM claim_public_ids public \
             JOIN claims claim ON claim.id = public.claim_id \
             JOIN claim_revisions revision ON revision.id = claim.current_revision_id \
                  AND revision.claim_id = claim.id \
             WHERE public.public_id = ?1",
            [public_claim_id],
            |row| {
                Ok(ClaimRef {
                    claim_id: row.get(0)?,
                    project_id: row.get(1)?,
                    current_revision_id: row.get(2)?,
                    public_claim_id: row.get(3)?,
                    revision: row.get(4)?,
                    content: row.get(5)?,
                    content_digest: row.get(6)?,
                })
            },
        )
        .optional())
}

fn current_locator(claim: &ClaimRef) -> AdapterResult<String> {
    format_revision_locator(&RevisionLocator {
        public_claim_id: claim.public_claim_id.clone(),
        revision: claim.revision,
        content_digest: claim.content_digest.clone(),
    })
    .ok_or_else(|| {
        format!(
            "claim {} has an invalid revision identity",
            claim.public_claim_id
        )
    })
}

fn validate_target(
    conn: &Connection,
    target: &ClaimMutationTarget,
) -> AdapterResult<Result<ClaimRef, String>> {
    let token = &target.mutation_token;
    if token.token_version != TOKEN_VERSION {
        return Err(format!(
            "unsupported claim mutation token version: {}",
            token.token_version
        ));
    }
    if token.public_claim_id.is_empty() {
        return Err("claim mutation token has an empty public claim ID".to_string());
    }
    let claim = get_claim(conn, &token.public_claim_id)?
        .ok_or_else(|| format!("unknown project-memory claim: {}", token.public_claim_id))?;
    // Retirement is terminal: a retired claim is outside every dashboard
    // mutation, so refuse it before any destination is considered.
    if lifecycle_head(conn, claim.claim_id)?.2 == "retired" {
        return Err(format!(
            "retired project-memory claim cannot be modified: {}",
            claim.public_claim_id
        ));
    }
    if token.revision != claim.revision || token.content_digest != claim.content_digest {
        return Ok(Err(format!(
            "revision: revision head moved from r{} to r{}",
            token.revision, claim.revision
        )));
    }
    if target.revision_locator != current_locator(&claim)? {
        return Ok(Err("revision: revision locator moved".to_string()));
    }
    let current = mutation_token(conn, &claim)?;
    if token.lifecycle_seq != current.lifecycle_seq {
        return Ok(Err("lifecycle: lifecycle head moved".to_string()));
    }
    if token.applicability_heads_digest != current.applicability_heads_digest {
        return Ok(Err("applicability: applicability heads moved".to_string()));
    }
    if token.policy_heads_digest != current.policy_heads_digest {
        return Ok(Err("policy: policy heads moved".to_string()));
    }
    Ok(Ok(claim))
}

fn explicit_disposition_active(
    conn: &Connection,
    revision_id: i64,
    disposition: &str,
) -> AdapterResult<bool> {
    let action: Option<String> = sql(conn
        .query_row(
            "SELECT action FROM claim_disposition_events \
             WHERE revision_id = ?1 AND disposition = ?2 ORDER BY id DESC LIMIT 1",
            params![revision_id, disposition],
            |row| row.get(0),
        )
        .optional())?;
    Ok(action.as_deref() == Some("assert"))
}

fn dispositions(conn: &Connection, revision_id: i64) -> AdapterResult<ClaimDispositions> {
    let verification: Option<String> = sql(conn
        .query_row(
            "SELECT outcome FROM verification_events \
             WHERE revision_id = ?1 AND outcome IN ('verified', 'stale', 'flagged') \
             ORDER BY id DESC LIMIT 1",
            [revision_id],
            |row| row.get(0),
        )
        .optional())?;
    let contradicted = sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM claim_conflicts \
         WHERE relation = 'contradicts' AND (left_revision_id = ?1 OR right_revision_id = ?1))",
        [revision_id],
        |row| row.get::<_, i64>(0),
    ))? != 0;
    let superseded = sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM claim_conflicts \
         WHERE relation = 'supersedes' AND right_revision_id = ?1)",
        [revision_id],
        |row| row.get::<_, i64>(0),
    ))? != 0;
    Ok(ClaimDispositions {
        stale: verification.as_deref() == Some("stale")
            || explicit_disposition_active(conn, revision_id, "stale")?,
        disputed: verification.as_deref() == Some("flagged")
            || explicit_disposition_active(conn, revision_id, "disputed")?,
        superseded,
        rejected: explicit_disposition_active(conn, revision_id, "rejected")?,
        contradicted,
        quarantined: explicit_disposition_active(conn, revision_id, "quarantined")?,
    })
}

fn read_policy(conn: &Connection, revision_id: i64) -> AdapterResult<ClaimPolicyView> {
    let row: Option<(String, String, i64, i64, i64, i64, i64)> = sql(conn
        .query_row(
            "SELECT effective_maturity, origin_taint, auto_eligible, explicit_eligible, \
                    hard_hidden, policy_version, generation \
             FROM claim_effective_policy WHERE revision_id = ?1",
            [revision_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional())?;
    let active = dispositions(conn, revision_id)?;
    let (maturity, taint, auto, explicit, hidden, version, generation, missing) = match row {
        Some((maturity, taint, auto, explicit, hidden, version, generation)) => (
            maturity,
            taint,
            auto != 0,
            explicit != 0,
            hidden != 0,
            version,
            generation,
            false,
        ),
        None => (
            "CANDIDATE".to_string(),
            "ASSISTANT_INFERENCE".to_string(),
            false,
            false,
            true,
            0,
            0,
            true,
        ),
    };
    let soft: Vec<&str> = active
        .active_names()
        .into_iter()
        .filter(|name| *name != "contradicted" && *name != "quarantined")
        .collect();
    let explicit_label = if auto && !missing && soft.is_empty() {
        None
    } else {
        let mut parts = vec![
            maturity.to_lowercase(),
            format!("taint:{}", taint.to_lowercase()),
        ];
        parts.extend(soft.into_iter().map(str::to_string));
        if missing {
            parts.push("policy:unknown".to_string());
        }
        Some(parts.join(" "))
    };
    Ok(ClaimPolicyView {
        effective_maturity: maturity,
        origin_taint: taint,
        auto_eligible: auto,
        explicit_eligible: explicit,
        hard_hidden: hidden,
        policy_version: version,
        generation,
        dispositions: active,
        explicit_label,
    })
}

fn read_evidence(conn: &Connection, revision_id: i64) -> AdapterResult<Vec<EvidenceLabel>> {
    let mut statement = sql(conn.prepare(
        "SELECT observation.independence_key, observation.source_trust_class, observation.extractor \
         FROM claim_evidence evidence \
         JOIN observations observation ON observation.id = evidence.observation_id \
         WHERE evidence.revision_id = ?1 ORDER BY observation.independence_key, observation.id",
    ))?;
    sql(statement
        .query_map([revision_id], |row| {
            Ok(EvidenceLabel {
                independence_key: row.get(0)?,
                source_trust_class: row.get(1)?,
                extractor: row.get(2)?,
            })
        })
        .and_then(|rows| rows.collect()))
}

fn read_applicability(
    conn: &Connection,
    revision_id: i64,
) -> AdapterResult<Vec<ApplicabilityState>> {
    #[derive(Debug)]
    struct Row {
        assertion_id: i64,
        stream_key: String,
        owner_kind: String,
        branch_selector: Option<String>,
        context_fingerprint: Option<String>,
        sequence: i64,
        state: String,
        known_from: Option<i64>,
        recorded_at: i64,
        paths_state: String,
        dependency_fingerprint: Option<String>,
        dependency_protocol: Option<String>,
        verifier_spec: Option<String>,
    }
    let mut statement = sql(conn.prepare(
        "SELECT assertion.id, stream.stream_key, stream.owner_kind, stream.branch_selector, \
                stream.context_fingerprint, assertion.seq, assertion.state, assertion.known_from, \
                assertion.recorded_at, assertion.paths_state, assertion.dependency_fingerprint, \
                assertion.dependency_protocol, assertion.verifier_spec \
         FROM claim_revision_applicability_streams stream \
         JOIN claim_revision_applicability_assertions assertion ON assertion.stream_id = stream.id \
         WHERE stream.revision_id = ?1 AND assertion.seq = ( \
             SELECT MAX(head.seq) FROM claim_revision_applicability_assertions head \
             WHERE head.stream_id = stream.id) ORDER BY stream.id",
    ))?;
    let rows = sql(statement
        .query_map([revision_id], |row| {
            Ok(Row {
                assertion_id: row.get(0)?,
                stream_key: row.get(1)?,
                owner_kind: row.get(2)?,
                branch_selector: row.get(3)?,
                context_fingerprint: row.get(4)?,
                sequence: row.get(5)?,
                state: row.get(6)?,
                known_from: row.get(7)?,
                recorded_at: row.get(8)?,
                paths_state: row.get(9)?,
                dependency_fingerprint: row.get(10)?,
                dependency_protocol: row.get(11)?,
                verifier_spec: row.get(12)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()))?;
    rows.into_iter()
        .map(|row| {
            let mut paths_statement = sql(conn.prepare(
                "SELECT kind, value FROM claim_revision_applicability_paths \
                 WHERE assertion_id = ?1 ORDER BY kind, value",
            ))?;
            let paths = sql(paths_statement
                .query_map([row.assertion_id], |path| {
                    Ok(ApplicabilityPath {
                        kind: path.get(0)?,
                        value: path.get(1)?,
                    })
                })
                .and_then(|paths| paths.collect()))?;
            let mut symbols_statement = sql(conn.prepare(
                "SELECT protocol, value FROM claim_revision_applicability_symbols \
                 WHERE assertion_id = ?1 ORDER BY protocol, value",
            ))?;
            let symbols = sql(symbols_statement
                .query_map([row.assertion_id], |symbol| {
                    Ok(ApplicabilitySymbol {
                        protocol: symbol.get(0)?,
                        value: symbol.get(1)?,
                    })
                })
                .and_then(|symbols| symbols.collect()))?;
            Ok(ApplicabilityState {
                stream_key: row.stream_key,
                owner_kind: row.owner_kind,
                branch_selector: row.branch_selector,
                context_fingerprint: row.context_fingerprint,
                sequence: row.sequence,
                state: row.state,
                known_from: row.known_from,
                recorded_at: row.recorded_at,
                paths_state: row.paths_state,
                dependency_fingerprint: row.dependency_fingerprint,
                dependency_protocol: row.dependency_protocol,
                verifier_spec: row.verifier_spec,
                paths,
                symbols,
            })
        })
        .collect()
}

fn hydrate_claim(conn: &Connection, public_claim_id: &str) -> AdapterResult<ClaimMemory> {
    let claim = get_claim(conn, public_claim_id)?
        .ok_or_else(|| format!("unknown project-memory claim: {public_claim_id}"))?;
    let max_revision: i64 = sql(conn.query_row(
        "SELECT MAX(revision) FROM claim_revisions WHERE claim_id = ?1",
        [claim.claim_id],
        |row| row.get(0),
    ))?;
    if max_revision != claim.revision {
        return Err(format!(
            "claim {} pointer targets revision {} but history reaches {max_revision}",
            claim.public_claim_id, claim.revision
        ));
    }
    let (
        project_identity,
        revision_created_at,
        category,
        normalized_hash,
        importance,
        memory_scope,
        sharing,
        expires_at,
    ): (
        String,
        i64,
        String,
        String,
        i64,
        String,
        String,
        Option<i64>,
    ) = sql(conn.query_row(
        "SELECT project.canonical_identity, revision.created_at, attributes.category, \
                attributes.normalized_hash, attributes.importance, attributes.memory_scope, \
                attributes.sharing, attributes.expires_at \
         FROM claim_revisions revision \
         JOIN claim_memory_revision_attributes attributes ON attributes.revision_id = revision.id \
         JOIN projects project ON project.id = attributes.project_id \
         WHERE revision.id = ?1 AND attributes.claim_id = ?2 AND attributes.project_id = ?3",
        params![claim.current_revision_id, claim.claim_id, claim.project_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        },
    ))?;
    let evidence_labels = read_evidence(conn, claim.current_revision_id)?;
    if evidence_labels.is_empty() {
        return Err(format!(
            "claim revision {} has no evidence rows",
            claim.current_revision_id
        ));
    }
    let telemetry = sql(conn
        .query_row(
            "SELECT seen_count, retrieval_count FROM claim_usage_stats WHERE claim_id = ?1",
            [claim.claim_id],
            |row| {
                Ok(ClaimTelemetry {
                    seen_count: row.get(0)?,
                    retrieval_count: row.get(1)?,
                })
            },
        )
        .optional())?
    .unwrap_or(ClaimTelemetry {
        seen_count: 0,
        retrieval_count: 0,
    });
    Ok(ClaimMemory {
        public_claim_id: claim.public_claim_id.clone(),
        revision_locator: current_locator(&claim)?,
        revision: claim.revision,
        content: claim.content.clone(),
        content_digest: claim.content_digest.clone(),
        revision_created_at,
        project_identity,
        category,
        normalized_hash,
        importance,
        memory_scope,
        sharing,
        expires_at,
        lifecycle_state: lifecycle_head(conn, claim.claim_id)?.2,
        evidence_labels,
        applicability: read_applicability(conn, claim.current_revision_id)?,
        policy: read_policy(conn, claim.current_revision_id)?,
        telemetry,
        mutation_token: mutation_token(conn, &claim)?,
    })
}

/// The single authority on whether a claim may be disclosed to an explicit
/// reader. It takes the facts it decides on rather than a whole `ClaimMemory`,
/// so a caller that only needs the verdict — the statistics aggregation — can
/// reach it without paying for evidence, applicability, telemetry and tokens.
/// Every surface that exposes a claim, or a number derived from one, routes
/// through here; a second implementation of these clauses is how hidden claims
/// leak into a count that no visible row explains.
fn claim_is_explicitly_visible(
    expires_at: Option<i64>,
    policy: &ClaimPolicyView,
    now_ms: i64,
) -> bool {
    let dispositions = &policy.dispositions;
    expires_at.is_none_or(|expires_at| expires_at > now_ms)
        && policy.explicit_eligible
        && !policy.hard_hidden
        && !dispositions.contradicted
        && !dispositions.quarantined
        && !dispositions.rejected
}

/// Projects a hydrated claim onto the facts above. Used by every path that
/// returns claims rather than a summary of them.
fn claim_memory_is_explicitly_visible(claim: &ClaimMemory, now_ms: i64) -> bool {
    claim_is_explicitly_visible(claim.expires_at, &claim.policy, now_ms)
}

/// Decides visibility for one revision without hydrating it. `read_policy`
/// supplies five of the six facts, so the fail-closed default for a missing
/// policy row and the latest-event-wins disposition rules stay in one place;
/// `expires_at` is read from the same attributes row `hydrate_claim` reads, and
/// like that path a revision with no attributes row is an error, not a hidden
/// claim.
fn revision_is_explicitly_visible(
    conn: &Connection,
    revision_id: i64,
    now_ms: i64,
) -> AdapterResult<bool> {
    let expires_at: Option<i64> = sql(conn.query_row(
        "SELECT expires_at FROM claim_memory_revision_attributes WHERE revision_id = ?1",
        [revision_id],
        |row| row.get(0),
    ))?;
    let policy = read_policy(conn, revision_id)?;
    Ok(claim_is_explicitly_visible(expires_at, &policy, now_ms))
}

/// One candidate head row. The read and statistics paths share this shape so
/// they provably enumerate the same rows before visibility is decided: the
/// lifecycle state and category are the head columns the filters above match
/// on, which is what makes a count reconcile with the list a filter produces.
struct ClaimCandidate {
    public_id: String,
    project_id: i64,
    revision_id: i64,
    lifecycle_state: String,
    category: String,
}

fn claim_candidates(
    conn: &Connection,
    project: Option<&str>,
    lifecycle: Option<&str>,
    category: Option<&str>,
    search: Option<&str>,
) -> AdapterResult<Vec<ClaimCandidate>> {
    let mut conditions = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(project) = project {
        values.push(Box::new(project.to_string()));
        conditions.push(format!("project.canonical_identity = ?{}", values.len()));
    }
    if let Some(lifecycle) = lifecycle {
        if !matches!(lifecycle, "active" | "archived" | "retired") {
            return Err(format!("unsupported claim lifecycle filter: {lifecycle}"));
        }
        values.push(Box::new(lifecycle.to_string()));
        conditions.push(format!("head.lifecycle_state = ?{}", values.len()));
    }
    if let Some(category) = category {
        values.push(Box::new(category.to_string()));
        conditions.push(format!("head.category = ?{}", values.len()));
    }
    if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
        values.push(Box::new(format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )));
        conditions.push(format!(
            "(revision.content LIKE ?{} ESCAPE '\\' OR head.category LIKE ?{} ESCAPE '\\')",
            values.len(),
            values.len()
        ));
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let query = format!(
        "SELECT public.public_id, claim.project_id, claim.current_revision_id, \
                head.lifecycle_state, head.category \
         FROM claim_memory_current_heads head \
         JOIN claims claim ON claim.id = head.claim_id \
         JOIN claim_public_ids public ON public.claim_id = claim.id \
         JOIN claim_revisions revision ON revision.id = head.revision_id AND revision.claim_id = claim.id \
         JOIN projects project ON project.id = claim.project_id \
         {where_clause} ORDER BY revision.created_at DESC, public.public_id"
    );
    let refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(Box::as_ref).collect();
    let mut statement = sql(conn.prepare(&query))?;
    sql(statement
        .query_map(refs.as_slice(), |row| {
            Ok(ClaimCandidate {
                public_id: row.get(0)?,
                project_id: row.get(1)?,
                revision_id: row.get(2)?,
                lifecycle_state: row.get(3)?,
                category: row.get(4)?,
            })
        })
        .and_then(|rows| rows.collect()))
}

#[allow(clippy::too_many_arguments)]
pub fn read_claim_memories(
    conn: &Connection,
    project: Option<&str>,
    lifecycle: Option<&str>,
    category: Option<&str>,
    search: Option<&str>,
    limit: i64,
    offset: i64,
) -> AdapterResult<ClaimMemoryReadResult> {
    if limit < 0 || offset < 0 {
        return Err("claim query limit and offset must be non-negative".to_string());
    }
    sql(conn.execute_batch("BEGIN DEFERRED"))?;
    let hydrated = (|| {
        let candidates = claim_candidates(conn, project, lifecycle, category, search)?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let claims = candidates
            .iter()
            .map(|candidate| hydrate_claim(conn, &candidate.public_id))
            .filter_map(|claim| match claim {
                Ok(claim) if claim_memory_is_explicitly_visible(&claim, now_ms) => Some(Ok(claim)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .skip(offset as usize)
            .take(limit as usize)
            .collect::<AdapterResult<Vec<_>>>()?;
        let project_ids = candidates
            .iter()
            .map(|candidate| candidate.project_id)
            .collect::<Vec<_>>();
        let vector = read_snapshot_vector(conn, &project_ids)?;
        Ok((claims, project_ids, vector))
    })();
    let (claims, project_ids, vector) = match hydrated {
        Ok(value) => {
            sql(conn.execute_batch("COMMIT"))?;
            value
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    };
    let fresh = read_snapshot_vector(conn, &project_ids)?;
    if fresh != vector {
        return Ok(ClaimMemoryReadResult {
            outcome: "stale".to_string(),
            claims: Vec::new(),
            snapshot_vector: None,
            stale_reasons: vec!["snapshot vector moved while claims were hydrated".to_string()],
        });
    }
    Ok(ClaimMemoryReadResult {
        outcome: "ok".to_string(),
        claims,
        snapshot_vector: Some(vector),
        stale_reasons: Vec::new(),
    })
}

/// Summarizes exactly the claims `read_claim_memories` would disclose.
///
/// The counts drive a header and a category filter, so they aggregate over the
/// same candidate rows the read path enumerates and admit a row only if
/// `claim_is_explicitly_visible` accepts it. Counting head rows directly would
/// publish expired, rejected, quarantined, contradicted and hard-hidden claims
/// as totals no visible row explains, and would offer a category filter whose
/// only members the list withholds.
///
/// Deciding visibility costs a handful of point lookups per candidate rather
/// than one aggregate, so the pass runs inside a deferred read transaction: the
/// four counts and the histogram then describe one snapshot instead of drifting
/// against concurrent writers across many more statements than before.
pub fn read_claim_memory_stats(
    conn: &Connection,
    project: Option<&str>,
) -> AdapterResult<ClaimMemoryStats> {
    let zeros = || ClaimMemoryStats {
        total: 0,
        active: 0,
        archived: 0,
        retired: 0,
        categories: Vec::new(),
    };
    // A project filter that names no project summarizes nothing, and resolving
    // it up front keeps that answer free of any candidate scan.
    if let Some(identity) = project {
        let resolved: Option<i64> = sql(conn
            .query_row(
                "SELECT id FROM projects WHERE canonical_identity = ?1",
                [identity],
                |row| row.get(0),
            )
            .optional())?;
        if resolved.is_none() {
            return Ok(zeros());
        }
    }
    sql(conn.execute_batch("BEGIN DEFERRED"))?;
    let aggregated = (|| {
        let candidates = claim_candidates(conn, project, None, None, None)?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut stats = zeros();
        let mut per_category: BTreeMap<String, i64> = BTreeMap::new();
        for candidate in &candidates {
            if !revision_is_explicitly_visible(conn, candidate.revision_id, now_ms)? {
                continue;
            }
            stats.total += 1;
            match candidate.lifecycle_state.as_str() {
                "active" => stats.active += 1,
                "archived" => stats.archived += 1,
                "retired" => stats.retired += 1,
                // The schema constrains head states to those three, so this arm
                // is unreachable in a conforming store and the buckets partition
                // the total. It counts toward the total only, as the replaced
                // per-state `COUNT(*)` queries did.
                _ => {}
            }
            *per_category.entry(candidate.category.clone()).or_default() += 1;
        }
        // `BTreeMap` yields categories in ascending order and `sort_by_key` is
        // stable, so this reproduces the order the replaced
        // `GROUP BY ... ORDER BY COUNT(*) DESC, category` handed the filter.
        stats.categories = per_category
            .into_iter()
            .map(|(category, count)| ClaimCategoryCount { category, count })
            .collect();
        stats
            .categories
            .sort_by_key(|entry| std::cmp::Reverse(entry.count));
        Ok(stats)
    })();
    match aggregated {
        Ok(stats) => {
            sql(conn.execute_batch("COMMIT"))?;
            Ok(stats)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn enumerate_claim_projects(conn: &Connection) -> AdapterResult<Vec<ClaimProjectRow>> {
    let mut statement = sql(conn.prepare(
        "SELECT DISTINCT project.canonical_identity \
         FROM claim_memory_current_heads head \
         JOIN projects project ON project.id = head.project_id \
         ORDER BY project.canonical_identity",
    ))?;
    sql(statement
        .query_map([], |row| {
            let identity: String = row.get(0)?;
            let display_name = identity
                .split_once(':')
                // Canonical identities carry filesystem names, so truncate by
                // characters: byte slicing splits multi-byte sequences.
                .map(|(prefix, rest)| match rest.char_indices().nth(10) {
                    Some((cut, _)) => format!("{prefix}:{}…", &rest[..cut]),
                    None => format!("{prefix}:{rest}"),
                })
                .unwrap_or_else(|| identity.clone());
            Ok(ClaimProjectRow {
                identity,
                display_name,
            })
        })
        .and_then(|rows| rows.collect()))
}

fn provenance_shape(channel: MutationChannel, operation_key: &str) -> Value {
    json!({
        "extractor": channel.producer(),
        "extractorRunId": operation_key,
        "extractorVersion": "1",
        "independenceKey": format!("{}:{operation_key}", channel.producer()),
        "sourceContent": operation_key,
        "sourceLocator": format!("dashboard://{}/{operation_key}", channel.producer()),
        "sourceSessionId": Value::Null,
        "sourceTrustClass": channel.source_trust_class(),
    })
}

fn token_shape(token: &ClaimMutationToken) -> Value {
    serde_json::to_value(token).expect("claim mutation token serializes")
}

fn payload_with_mutation_tokens(
    conn: &Connection,
    mut payload: Value,
    public_claim_ids: &[String],
) -> AdapterResult<Value> {
    if public_claim_ids.is_empty() {
        return Ok(payload);
    }
    let record = payload
        .as_object_mut()
        .ok_or("mutation-token results require an object payload")?;
    let mut seen = BTreeSet::new();
    let tokens = public_claim_ids
        .iter()
        .filter(|public_claim_id| seen.insert((*public_claim_id).clone()))
        .map(|public_claim_id| {
            let claim = get_claim(conn, public_claim_id)?
                .ok_or_else(|| format!("unknown project-memory claim: {public_claim_id}"))?;
            Ok(token_shape(&mutation_token(conn, &claim)?))
        })
        .collect::<AdapterResult<Vec<_>>>()?;
    record.insert("mutationTokens".to_string(), Value::Array(tokens));
    Ok(payload)
}

fn write_evidence(
    conn: &Connection,
    project_id: i64,
    channel: MutationChannel,
    operation_key: &str,
    extracted_text: &str,
    now_ms: i64,
) -> AdapterResult<i64> {
    sql(conn.execute(
        "INSERT INTO episodes (project_id, source_session_id, created_at) VALUES (?1, NULL, ?2)",
        params![project_id, now_ms],
    ))?;
    let episode_id = conn.last_insert_rowid();
    let source_content = operation_key;
    sql(conn.execute(
        "INSERT INTO source_spans \
         (episode_id, source_locator, content_sha256, start_offset, end_offset, raw_artifact_ref, created_at) \
         VALUES (?1, ?2, ?3, 0, ?4, NULL, ?5)",
        params![
            episode_id,
            format!("dashboard://{}/{}", channel.producer(), operation_key),
            sha256_hex_utf8(source_content),
            source_content.chars().count().max(1) as i64,
            now_ms
        ],
    ))?;
    let span_id = conn.last_insert_rowid();
    sql(conn.execute(
        "INSERT INTO observations \
         (source_span_id, extracted_text, content_sha256, extractor, extractor_version, \
          extractor_run_id, independence_key, source_trust_class, created_at) \
         VALUES (?1, ?2, ?3, ?4, '1', ?5, ?6, ?7, ?8)",
        params![
            span_id,
            extracted_text,
            sha256_hex_utf8(extracted_text),
            channel.producer(),
            operation_key,
            format!("{}:{operation_key}", channel.producer()),
            channel.source_trust_class(),
            now_ms
        ],
    ))?;
    Ok(conn.last_insert_rowid())
}

fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn normalize_hash(content: &str) -> String {
    let mut normalized = String::new();
    let mut pending_space = false;
    for character in content.to_lowercase().chars() {
        if is_javascript_whitespace(character) {
            pending_space = !normalized.is_empty();
        } else {
            if pending_space {
                normalized.push(' ');
                pending_space = false;
            }
            normalized.push(character);
        }
    }
    format!("{:032x}", md5::compute(normalized.as_bytes()))
}

fn ensure_baseline_applicability(
    conn: &Connection,
    revision_id: i64,
    project_id: i64,
    content_digest: &str,
    now_ms: i64,
) -> AdapterResult<()> {
    sql(conn.execute(
        "INSERT INTO claim_revision_applicability_streams \
         (revision_id, project_id, owner_kind, stream_key, key_protocol, source_digest, \
          branch_selector, context_fingerprint, created_at) \
         VALUES (?1, ?2, 'source', ?3, ?4, ?5, NULL, NULL, ?6)",
        params![
            revision_id,
            project_id,
            APPLICABILITY_STREAM_KEY,
            APPLICABILITY_KEY_PROTOCOL,
            content_digest,
            now_ms
        ],
    ))?;
    let stream_id = conn.last_insert_rowid();
    sql(conn.execute(
        "INSERT INTO claim_revision_applicability_assertions \
         (stream_id, seq, predecessor_id, state, valid_from_anchor_id, valid_until_anchor_id, \
          evaluated_against_anchor_id, known_from, recorded_at, paths_state, dependency_fingerprint, \
          dependency_protocol, verifier_spec) \
         VALUES (?1, 1, NULL, 'unknown', NULL, NULL, NULL, ?2, ?2, 'unknown', NULL, NULL, NULL)",
        params![stream_id, now_ms],
    ))?;
    Ok(())
}

fn insert_policy_subject(
    conn: &Connection,
    revision_id: i64,
    project_id: i64,
    observation_id: i64,
    channel: MutationChannel,
    content_digest: &str,
    now_ms: i64,
) -> AdapterResult<()> {
    sql(conn.execute(
        "INSERT INTO claim_revision_policy_subjects \
         (revision_id, project_id, claim_kind, origin_observation_id, origin_taint, \
          classification_method, source_digest, policy_version, created_at) \
         VALUES (?1, ?2, 'unknown', ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            revision_id,
            project_id,
            observation_id,
            channel.origin_taint(),
            TAINT_CLASSIFIER_METHOD,
            content_digest,
            POLICY_VERSION,
            now_ms
        ],
    ))?;
    Ok(())
}

fn maturity_rank(value: &str) -> i64 {
    match value {
        "CANDIDATE" => 0,
        "CORROBORATED" => 1,
        "VERIFIED" => 2,
        "APPROVED" => 3,
        "ENFORCED" => 4,
        _ => -1,
    }
}

fn append_maturity(
    conn: &Connection,
    revision_id: i64,
    project_id: i64,
    maturity: &str,
    now_ms: i64,
) -> AdapterResult<()> {
    let stream_id = match sql(conn
        .query_row(
            "SELECT id FROM claim_maturity_streams WHERE revision_id = ?1",
            [revision_id],
            |row| row.get::<_, i64>(0),
        )
        .optional())?
    {
        Some(id) => id,
        None => {
            sql(conn.execute(
                "INSERT INTO claim_maturity_streams (revision_id, project_id, created_at) VALUES (?1, ?2, ?3)",
                params![revision_id, project_id, now_ms],
            ))?;
            conn.last_insert_rowid()
        }
    };
    let head: Option<(i64, i64, String)> = sql(conn
        .query_row(
            "SELECT assertion.id, assertion.seq, assertion.maturity \
             FROM claim_maturity_assertions assertion WHERE assertion.stream_id = ?1 \
             ORDER BY assertion.seq DESC LIMIT 1",
            [stream_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional())?;
    if head
        .as_ref()
        .is_some_and(|(_, _, current)| maturity_rank(current) >= maturity_rank(maturity))
    {
        return Ok(());
    }
    sql(conn.execute(
        "INSERT INTO claim_maturity_assertions \
         (stream_id, seq, predecessor_id, maturity, actor, evidence_json, approval_action_id, \
          artifact_id, policy_version, recorded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7)",
        params![
            stream_id,
            head.as_ref().map_or(1, |(_, seq, _)| seq + 1),
            head.map(|(id, _, _)| id),
            maturity,
            POLICY_ACTOR,
            POLICY_VERSION,
            now_ms
        ],
    ))?;
    Ok(())
}

fn finalize_policy(
    conn: &Connection,
    revision_id: i64,
    generation: i64,
    now_ms: i64,
) -> AdapterResult<()> {
    let (claim_id, project_id, origin_taint): (i64, i64, String) = sql(conn.query_row(
        "SELECT revision.claim_id, subject.project_id, subject.origin_taint \
         FROM claim_revision_policy_subjects subject \
         JOIN claim_revisions revision ON revision.id = subject.revision_id \
         WHERE subject.revision_id = ?1",
        [revision_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ))?;
    append_maturity(conn, revision_id, project_id, "CANDIDATE", now_ms)?;
    // Explicit-user credit for a later revision needs a witness that the stamp
    // was authored FOR this revision, not inherited. Two of the three branches
    // predate this adapter: revision 1 carries its own stated provenance, and a
    // later revision whose bytes still equal revision 1's is the classification
    // path re-observing unchanged content. Neither admits a rewrite that
    // changes content.
    //
    // The third branch is this adapter's own write path. `write_evidence`
    // records the NEW content as the observation's `extracted_text`, so an
    // observation authored here has `content_sha256` equal to the revision it
    // supports. Requiring the producer as well as that digest match keeps the
    // defense the other branches provide: the hazard those branches guard is a
    // held-open pre-v86 writer copying a retained `user` trust class onto a
    // model-authored successor, and such a writer predates this producer string
    // entirely, so it cannot mint one. Without this branch a genuine dashboard
    // content edit — revision 2 with a new digest — silently loses explicit-user
    // credit and drops out of automatic injection.
    let explicit_user = sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM claim_evidence evidence \
         JOIN observations observation ON observation.id = evidence.observation_id \
         JOIN claim_revisions revision ON revision.id = evidence.revision_id \
         WHERE evidence.revision_id = ?1 AND evidence.relation = 'supports' \
           AND observation.source_trust_class = 'explicit_user' \
           AND (revision.revision = 1 \
                OR revision.content_sha256 = ( \
                    SELECT first.content_sha256 FROM claim_revisions first \
                    WHERE first.claim_id = revision.claim_id AND first.revision = 1) \
                OR (observation.extractor = ?2 \
                    AND observation.content_sha256 = revision.content_sha256)))",
        rusqlite::params![revision_id, EXPLICIT_USER_REVISION_PRODUCER],
        |row| row.get::<_, i64>(0),
    ))? != 0;
    let verified = sql(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM verification_events \
         WHERE revision_id = ?1 AND outcome = 'verified')",
        [revision_id],
        |row| row.get::<_, i64>(0),
    ))? != 0;
    let independent_groups: i64 = sql(conn.query_row(
        "SELECT COUNT(DISTINCT observation.independence_key) FROM claim_evidence evidence \
         JOIN observations observation ON observation.id = evidence.observation_id \
         WHERE evidence.revision_id = ?1 AND evidence.relation = 'supports'",
        [revision_id],
        |row| row.get(0),
    ))?;
    if independent_groups >= 2 {
        append_maturity(conn, revision_id, project_id, "CORROBORATED", now_ms)?;
    }
    if explicit_user || verified {
        append_maturity(conn, revision_id, project_id, "VERIFIED", now_ms)?;
    }
    let maturity: String = sql(conn.query_row(
        "SELECT assertion.maturity FROM claim_maturity_streams stream \
         JOIN claim_maturity_assertions assertion ON assertion.stream_id = stream.id \
         WHERE stream.revision_id = ?1 ORDER BY assertion.seq DESC LIMIT 1",
        [revision_id],
        |row| row.get(0),
    ))?;
    let active = dispositions(conn, revision_id)?;
    let hard_hidden = active.contradicted || active.quarantined;
    let soft_hidden = active.stale || active.disputed || active.superseded;
    let mature = maturity_rank(&maturity) >= maturity_rank("VERIFIED");
    let auto_eligible = mature && !hard_hidden && !soft_hidden && !active.rejected;
    let explicit_eligible = !hard_hidden && !active.rejected;
    let mut reasons = Vec::new();
    if hard_hidden {
        reasons.push("hard_hidden");
    }
    if !mature {
        reasons.push("maturity_below_automatic");
    }
    if reasons.is_empty() {
        reasons.push("eligible");
    }
    let disposition_names = active.active_names();
    sql(conn.execute(
        "INSERT INTO claim_effective_policy \
         (revision_id, claim_id, project_id, effective_maturity, origin_taint, auto_eligible, \
          explicit_eligible, hard_hidden, reason_codes_json, dispositions_json, policy_version, \
          generation, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(revision_id) DO UPDATE SET \
          effective_maturity=excluded.effective_maturity, origin_taint=excluded.origin_taint, \
          auto_eligible=excluded.auto_eligible, explicit_eligible=excluded.explicit_eligible, \
          hard_hidden=excluded.hard_hidden, reason_codes_json=excluded.reason_codes_json, \
          dispositions_json=excluded.dispositions_json, policy_version=excluded.policy_version, \
          generation=excluded.generation, updated_at=excluded.updated_at",
        params![
            revision_id,
            claim_id,
            project_id,
            maturity,
            origin_taint,
            i64::from(auto_eligible),
            i64::from(explicit_eligible),
            i64::from(hard_hidden),
            serde_json::to_string(&reasons).map_err(|error| error.to_string())?,
            serde_json::to_string(&disposition_names).map_err(|error| error.to_string())?,
            POLICY_VERSION,
            generation,
            now_ms
        ],
    ))?;
    Ok(())
}

fn allocate_generations(
    conn: &Connection,
    effects: &[Effect],
    now_ms: i64,
) -> AdapterResult<BTreeMap<i64, i64>> {
    let projects: BTreeSet<i64> = effects.iter().map(|effect| effect.project_id).collect();
    let mut generations = BTreeMap::new();
    for project_id in projects {
        let current = sql(conn
            .query_row(
                "SELECT generation FROM claim_project_generations WHERE project_id = ?1",
                [project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional())?;
        let generation = current.unwrap_or(0) + 1;
        if current.is_some() {
            sql(conn.execute(
                "UPDATE claim_project_generations SET generation = ?1, updated_at = ?2 WHERE project_id = ?3",
                params![generation, now_ms, project_id],
            ))?;
        } else {
            sql(conn.execute(
                "INSERT INTO claim_project_generations (project_id, generation, updated_at) VALUES (?1, ?2, ?3)",
                params![project_id, generation, now_ms],
            ))?;
        }
        generations.insert(project_id, generation);
    }
    Ok(generations)
}

fn stored_receipt(
    conn: &Connection,
    producer: &str,
    operation_key: &str,
) -> AdapterResult<Option<(String, String)>> {
    sql(conn
        .query_row(
            "SELECT request_digest, result_json FROM claim_operation_receipts \
             WHERE producer = ?1 AND operation_key = ?2",
            params![producer, operation_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())
}

fn run_operation<F>(
    conn: &mut Connection,
    channel: MutationChannel,
    operation_key: &str,
    request: Value,
    now_ms: i64,
    stage: F,
) -> AdapterResult<RunResult>
where
    F: FnOnce(&Connection) -> AdapterResult<Stage>,
{
    if !valid_operation_key(operation_key) {
        return Err("operation key must contain 1-256 bytes".to_string());
    }
    let request_digest =
        compute_claim_operation_request_digest(&request).map_err(|error| error.to_string())?;
    let tx = sql(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if let Some((stored_digest, result_json)) =
        stored_receipt(&tx, channel.producer(), operation_key)?
    {
        if stored_digest != request_digest {
            return Err(format!(
                "claim operation key reused with different input: {}/{}",
                channel.producer(),
                operation_key
            ));
        }
        let decoded =
            decode_claim_operation_result(&result_json).map_err(|error| error.to_string())?;
        let result: Value =
            serde_json::from_str(&result_json).map_err(|error| error.to_string())?;
        let outcome = decoded.outcome.as_str().to_string();
        sql(tx.commit())?;
        return Ok(RunResult {
            outcome,
            replayed: true,
            request_digest,
            result_json,
            result,
        });
    }

    let staged = stage(&tx)?;
    let mut effect_sources = Vec::new();
    let (outcome, stale_reason, payload, effects, generations) = match staged {
        Stage::Stale(reason) => (
            "stale".to_string(),
            Some(reason),
            Value::Null,
            Vec::new(),
            BTreeMap::new(),
        ),
        Stage::Noop {
            payload,
            mutation_token_public_ids,
        } => (
            "noop".to_string(),
            None,
            payload_with_mutation_tokens(&tx, payload, &mutation_token_public_ids)?,
            Vec::new(),
            BTreeMap::new(),
        ),
        Stage::Effects {
            payload,
            effects: staged_effects,
            policy_revision_ids,
            mutation_token_public_ids,
        } => {
            if staged_effects.is_empty() {
                return Err("effects operation declared no effects".to_string());
            }
            let allocations = allocate_generations(&tx, &staged_effects, now_ms)?;
            for revision_id in policy_revision_ids {
                let project_id: i64 = sql(tx.query_row(
                    "SELECT claim.project_id FROM claim_revisions revision \
                     JOIN claims claim ON claim.id = revision.claim_id WHERE revision.id = ?1",
                    [revision_id],
                    |row| row.get(0),
                ))?;
                finalize_policy(
                    &tx,
                    revision_id,
                    *allocations.get(&project_id).unwrap_or(&0),
                    now_ms,
                )?;
            }
            let result_effects = staged_effects
                .iter()
                .map(|effect| {
                    let revision_locator = effect
                        .revision_id
                        .map(|revision_id| {
                            sql(tx.query_row(
                                "SELECT public.public_id, revision.revision, revision.content_sha256 \
                                 FROM claim_revisions revision \
                                 JOIN claim_public_ids public ON public.claim_id = revision.claim_id \
                                 WHERE revision.id = ?1",
                                [revision_id],
                                |row| {
                                    Ok(RevisionLocator {
                                        public_claim_id: row.get(0)?,
                                        revision: row.get(1)?,
                                        content_digest: row.get(2)?,
                                    })
                                },
                            ))
                            .and_then(|locator| format_revision_locator(&locator).ok_or_else(|| "effect revision locator is invalid".to_string()))
                        })
                        .transpose()?;
                    Ok(json!({
                        "changeKind": effect.change_kind,
                        "effectKey": effect.effect_key,
                        "generation": allocations[&effect.project_id],
                        "projectId": effect.project_id,
                        "revisionLocator": revision_locator,
                    }))
                })
                .collect::<AdapterResult<Vec<_>>>()?;
            let generation_map = allocations
                .iter()
                .map(|(project_id, generation)| (project_id.to_string(), *generation))
                .collect::<BTreeMap<_, _>>();
            effect_sources = staged_effects;
            (
                "applied".to_string(),
                None,
                payload_with_mutation_tokens(&tx, payload, &mutation_token_public_ids)?,
                result_effects,
                generation_map,
            )
        }
    };
    let result_value = json!({
        "effects": effects,
        "generations": generations,
        "outcome": outcome,
        "payload": payload,
        "resultEncodingVersion": CLAIM_RESULT_ENCODING_VERSION,
        "staleReason": stale_reason,
    });
    let result_json = canonical_json_encode(&result_value).map_err(|error| error.to_string())?;
    decode_claim_operation_result(&result_json).map_err(|error| error.to_string())?;
    let effect_summary =
        canonical_json_encode(&result_value["effects"]).map_err(|error| error.to_string())?;
    let generation_vector =
        canonical_json_encode(&result_value["generations"]).map_err(|error| error.to_string())?;
    sql(tx.execute(
        "INSERT INTO claim_operation_receipts \
         (producer, operation_key, request_digest, request_encoding_version, result_encoding_version, \
          outcome, expected_effect_count, effect_summary_json, generation_vector_json, result_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![channel.producer(), operation_key, request_digest, CLAIM_REQUEST_ENCODING_VERSION, CLAIM_RESULT_ENCODING_VERSION, outcome, effects.len() as i64, effect_summary, generation_vector, result_json, now_ms],
    ))?;
    let receipt_id = tx.last_insert_rowid();
    if outcome == "applied" {
        let staged_effects = match &result_value["effects"] {
            Value::Array(values) => values,
            _ => unreachable!(),
        };
        for value in staged_effects {
            let effect_key = value["effectKey"].as_str().ok_or("effect key missing")?;
            let project_id = value["projectId"]
                .as_i64()
                .ok_or("effect project missing")?;
            let generation = value["generation"]
                .as_i64()
                .ok_or("effect generation missing")?;
            let source = effect_sources
                .iter()
                .find(|effect| effect.effect_key == effect_key)
                .ok_or("staged effect missing")?;
            sql(tx.execute(
                "INSERT INTO claim_operation_effects \
                 (receipt_id, effect_key, project_id, claim_id, revision_id, change_kind, generation, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![receipt_id, effect_key, project_id, source.claim_id, source.revision_id, source.change_kind, generation, now_ms],
            ))?;
        }
    }
    sql(tx.commit())?;
    Ok(RunResult {
        outcome,
        replayed: false,
        request_digest,
        result_json,
        result: result_value,
    })
}

fn claim_payload(claim: &ClaimRef) -> AdapterResult<Value> {
    Ok(json!({
        "contentDigest": claim.content_digest,
        "publicClaimId": claim.public_claim_id,
        "revision": claim.revision,
        "revisionLocator": current_locator(claim)?,
    }))
}

fn revise_stage(
    conn: &Connection,
    channel: MutationChannel,
    input: &ReviseClaimInput,
    now_ms: i64,
) -> AdapterResult<Stage> {
    let claim = match validate_target(conn, &input.target)? {
        Ok(claim) => claim,
        Err(reason) => return Ok(Stage::Stale(reason)),
    };
    if input.content.is_none() && input.category.is_none() {
        return Err("claim revision must change content or category".to_string());
    }
    if input
        .content
        .as_deref()
        .is_some_and(|content| content.trim().is_empty())
    {
        return Err("claim content must not be empty".to_string());
    }
    if input
        .category
        .as_deref()
        .is_some_and(|category| category.trim().is_empty())
    {
        return Err("claim category must not be empty".to_string());
    }
    let (current_category, importance, memory_scope, sharing, expires_at): (
        String,
        i64,
        String,
        String,
        Option<i64>,
    ) = sql(conn.query_row(
        "SELECT category, importance, memory_scope, sharing, expires_at \
         FROM claim_memory_revision_attributes WHERE revision_id = ?1",
        [claim.current_revision_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    ))?;
    let next_content = input.content.as_deref().unwrap_or(&claim.content);
    let next_category = input.category.as_deref().unwrap_or(&current_category);
    let observation_id = write_evidence(
        conn,
        claim.project_id,
        channel,
        &input.operation_key,
        next_content,
        now_ms,
    )?;
    if next_content == claim.content && next_category == current_category {
        sql(conn.execute(
            "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) \
             VALUES (?1, ?2, 'supports', ?3)",
            params![claim.current_revision_id, observation_id, now_ms],
        ))?;
        return Ok(Stage::Effects {
            payload: json!({"claim": claim_payload(&claim)?, "kind": "evidence_attached"}),
            effects: vec![Effect {
                effect_key: format!("evidence:{}:r{}", claim.public_claim_id, claim.revision),
                project_id: claim.project_id,
                claim_id: claim.claim_id,
                revision_id: Some(claim.current_revision_id),
                change_kind: "evidence".to_string(),
            }],
            policy_revision_ids: vec![claim.current_revision_id],
            mutation_token_public_ids: vec![claim.public_claim_id.clone()],
        });
    }
    let normalized_hash = normalize_hash(next_content);
    let duplicate: Option<String> = sql(conn
        .query_row(
            "SELECT public.public_id FROM claim_memory_current_heads head \
             JOIN claim_public_ids public ON public.claim_id = head.claim_id \
             WHERE head.project_id = ?1 AND head.category = ?2 AND head.normalized_hash = ?3 \
               AND head.lifecycle_state = 'active' AND head.claim_id <> ?4 LIMIT 1",
            params![
                claim.project_id,
                next_category,
                normalized_hash,
                claim.claim_id
            ],
            |row| row.get(0),
        )
        .optional())?;
    if let Some(duplicate) = duplicate {
        return Err(format!("live duplicate project-memory claim: {duplicate}"));
    }
    let max_revision: i64 = sql(conn.query_row(
        "SELECT MAX(revision) FROM claim_revisions WHERE claim_id = ?1",
        [claim.claim_id],
        |row| row.get(0),
    ))?;
    if max_revision != claim.revision {
        return Err("claim revision history is not at the current pointer".to_string());
    }
    let next_revision = claim.revision + 1;
    let content_digest = sha256_hex_utf8(next_content);
    sql(conn.execute(
        "INSERT INTO claim_revisions \
         (claim_id, revision, content, content_sha256, source_session_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![
            claim.claim_id,
            next_revision,
            next_content,
            content_digest,
            now_ms
        ],
    ))?;
    let revision_id = conn.last_insert_rowid();
    sql(conn.execute(
        "INSERT INTO claim_evidence (revision_id, observation_id, relation, created_at) \
         VALUES (?1, ?2, 'supports', ?3)",
        params![revision_id, observation_id, now_ms],
    ))?;
    ensure_baseline_applicability(conn, revision_id, claim.project_id, &content_digest, now_ms)?;
    sql(conn.execute(
        "INSERT INTO claim_memory_revision_attributes \
         (revision_id, claim_id, project_id, category, normalized_hash, importance, memory_scope, sharing, expires_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![revision_id, claim.claim_id, claim.project_id, next_category, normalized_hash, importance, memory_scope, sharing, expires_at, now_ms],
    ))?;
    let advanced = sql(conn.execute(
        "UPDATE claims SET current_revision_id = ?1 WHERE id = ?2 AND current_revision_id = ?3",
        params![revision_id, claim.claim_id, claim.current_revision_id],
    ))?;
    if advanced != 1 {
        return Err("claim revision pointer moved during append".to_string());
    }
    let lifecycle_state = lifecycle_head(conn, claim.claim_id)?.2;
    sql(conn.execute(
        "UPDATE claim_memory_current_heads SET category = ?1, normalized_hash = ?2, revision_id = ?3, \
         lifecycle_state = ?4, updated_at = ?5 WHERE claim_id = ?6",
        params![next_category, normalized_hash, revision_id, lifecycle_state, now_ms, claim.claim_id],
    ))?;
    insert_policy_subject(
        conn,
        revision_id,
        claim.project_id,
        observation_id,
        channel,
        &content_digest,
        now_ms,
    )?;
    let revised = ClaimRef {
        current_revision_id: revision_id,
        revision: next_revision,
        content: next_content.to_string(),
        content_digest,
        ..claim
    };
    Ok(Stage::Effects {
        payload: json!({"claim": claim_payload(&revised)?, "kind": "revised"}),
        effects: vec![Effect {
            effect_key: format!("upsert:{}:r{}", revised.public_claim_id, revised.revision),
            project_id: revised.project_id,
            claim_id: revised.claim_id,
            revision_id: Some(revision_id),
            change_kind: "upsert".to_string(),
        }],
        policy_revision_ids: vec![revision_id],
        mutation_token_public_ids: vec![revised.public_claim_id.clone()],
    })
}

fn lifecycle_stage(
    conn: &Connection,
    channel: MutationChannel,
    target: &ClaimMutationTarget,
    state: &str,
    now_ms: i64,
) -> AdapterResult<Stage> {
    if !matches!(state, "active" | "archived") {
        return Err(format!(
            "dashboard lifecycle mutation does not allow '{state}'"
        ));
    }
    let claim = match validate_target(conn, target)? {
        Ok(claim) => claim,
        Err(reason) => return Ok(Stage::Stale(reason)),
    };
    let (event_id, sequence, current_state) = lifecycle_head(conn, claim.claim_id)?;
    if current_state == state {
        return Ok(Stage::Noop {
            payload: json!({
                "claim": claim_payload(&claim)?,
                "kind": "lifecycle",
                "state": state,
            }),
            mutation_token_public_ids: vec![claim.public_claim_id.clone()],
        });
    }
    if state == "active" {
        let (category, normalized_hash): (String, String) = sql(conn.query_row(
            "SELECT category, normalized_hash FROM claim_memory_revision_attributes WHERE revision_id = ?1",
            [claim.current_revision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ))?;
        let duplicate: Option<String> = sql(conn
            .query_row(
                "SELECT public.public_id FROM claim_memory_current_heads head \
                 JOIN claim_public_ids public ON public.claim_id = head.claim_id \
                 WHERE head.project_id = ?1 AND head.category = ?2 AND head.normalized_hash = ?3 \
                   AND head.lifecycle_state = 'active' AND head.claim_id <> ?4 LIMIT 1",
                params![claim.project_id, category, normalized_hash, claim.claim_id],
                |row| row.get(0),
            )
            .optional())?;
        if let Some(duplicate) = duplicate {
            return Err(format!(
                "cannot restore claim; live duplicate exists: {duplicate}"
            ));
        }
    }
    sql(conn.execute(
        "INSERT INTO claim_memory_lifecycle_events \
         (claim_id, seq, predecessor_id, state, actor, reason, recorded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            claim.claim_id,
            sequence + 1,
            event_id,
            state,
            channel.actor(),
            format!("dashboard {state}"),
            now_ms
        ],
    ))?;
    sql(conn.execute(
        "UPDATE claims SET state = ?1 WHERE id = ?2",
        params![
            if state == "active" {
                "active"
            } else {
                "archived"
            },
            claim.claim_id
        ],
    ))?;
    sql(conn.execute(
        "UPDATE claim_memory_current_heads SET lifecycle_state = ?1, updated_at = ?2 WHERE claim_id = ?3",
        params![state, now_ms, claim.claim_id],
    ))?;
    Ok(Stage::Effects {
        payload: json!({"claim": claim_payload(&claim)?, "kind": "lifecycle", "state": state}),
        effects: vec![Effect {
            effect_key: format!("lifecycle:{}:{state}", claim.public_claim_id),
            project_id: claim.project_id,
            claim_id: claim.claim_id,
            revision_id: Some(claim.current_revision_id),
            change_kind: "lifecycle".to_string(),
        }],
        policy_revision_ids: Vec::new(),
        mutation_token_public_ids: vec![claim.public_claim_id.clone()],
    })
}

/// Build the response for an already-committed mutation.
///
/// Every hydrate failure here is post-commit, so none of them may fail the
/// mutation: the write is durable, and returning `Err` would invite the caller
/// to retry or report failure for an operation that succeeded. A claim that
/// cannot be hydrated is omitted from `refreshed_claims` — the same treatment
/// an unknown or hidden claim already gets — and the reason goes to stderr so
/// an invariant violation stays diagnosable instead of vanishing. `outcome`
/// still reports what happened.
fn response(
    conn: &Connection,
    run: RunResult,
    public_ids: &[String],
) -> AdapterResult<ClaimMutationResponse> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let refreshed_claims = public_ids
        .iter()
        .filter_map(|public_id| match hydrate_claim(conn, public_id) {
            Ok(claim) => Some(claim),
            Err(error) if error.starts_with("unknown project-memory claim") => None,
            Err(error) => {
                eprintln!(
                    "claim adapter: post-commit hydrate of {public_id} failed, omitting it from the response: {error}"
                );
                None
            }
        })
        // A mutation response never discloses more than a read would: a hidden
        // claim is omitted, and the outcome still reports what happened.
        .filter(|claim| claim_memory_is_explicitly_visible(claim, now_ms))
        .collect::<Vec<_>>();
    let project_ids = public_ids
        .iter()
        .filter_map(|public_id| get_claim(conn, public_id).ok().flatten())
        .map(|claim| claim.project_id)
        .collect::<Vec<_>>();
    Ok(ClaimMutationResponse {
        outcome: run.outcome,
        replayed: run.replayed,
        request_digest: run.request_digest,
        result_json: run.result_json,
        result: run.result,
        refreshed_claims,
        snapshot_vector: read_snapshot_vector(conn, &project_ids)?,
    })
}

pub fn revise_claim(
    conn: &mut Connection,
    channel: MutationChannel,
    input: ReviseClaimInput,
) -> AdapterResult<ClaimMutationResponse> {
    let public_id = input.target.mutation_token.public_claim_id.clone();
    let request = json!({
        "actor": channel.actor(),
        "category": input.category,
        "content": input.content,
        "expiresAt": "keep",
        "importance": Value::Null,
        "memoryScope": Value::Null,
        "operation": "revise-project-memory-claim",
        "provenance": provenance_shape(channel, &input.operation_key),
        "requestScope": Value::Null,
        "sharing": Value::Null,
        "token": token_shape(&input.target.mutation_token),
        "userInferred": false,
    });
    let now_ms = chrono::Utc::now().timestamp_millis();
    let operation_key = input.operation_key.clone();
    let run = run_operation(conn, channel, &operation_key, request, now_ms, |tx| {
        revise_stage(tx, channel, &input, now_ms)
    })?;
    response(conn, run, &[public_id])
}

pub fn set_claim_lifecycle(
    conn: &mut Connection,
    channel: MutationChannel,
    input: SetLifecycleInput,
) -> AdapterResult<ClaimMutationResponse> {
    let public_id = input.target.mutation_token.public_claim_id.clone();
    let request = json!({
        "actor": channel.actor(),
        "operation": "set-project-memory-lifecycle",
        "reason": format!("dashboard {}", input.lifecycle_state),
        "requestScope": Value::Null,
        "state": input.lifecycle_state,
        "token": token_shape(&input.target.mutation_token),
    });
    let now_ms = chrono::Utc::now().timestamp_millis();
    let operation_key = input.operation_key.clone();
    let run = run_operation(conn, channel, &operation_key, request, now_ms, |tx| {
        lifecycle_stage(tx, channel, &input.target, &input.lifecycle_state, now_ms)
    })?;
    response(conn, run, &[public_id])
}

pub fn bulk_archive_claims(
    conn: &mut Connection,
    channel: MutationChannel,
    input: BulkArchiveInput,
) -> AdapterResult<ClaimMutationResponse> {
    if input.targets.is_empty() {
        return Err("bulk archive requires at least one target".to_string());
    }
    let mut public_ids = Vec::with_capacity(input.targets.len());
    let mut seen = BTreeSet::new();
    for target in &input.targets {
        let public_id = target.mutation_token.public_claim_id.clone();
        if !seen.insert(public_id.clone()) {
            return Err(format!("bulk archive target repeated: {public_id}"));
        }
        public_ids.push(public_id);
    }
    let request_targets: Vec<Value> = input
        .targets
        .iter()
        .map(|target| {
            json!({
                "revisionLocator": target.revision_locator,
                "token": token_shape(&target.mutation_token),
            })
        })
        .collect();
    let request = json!({
        "actor": channel.actor(),
        "operation": "bulk-set-project-memory-lifecycle",
        "reason": "dashboard bulk archive",
        "requestScope": Value::Null,
        "state": "archived",
        "targets": request_targets,
    });
    let now_ms = chrono::Utc::now().timestamp_millis();
    let operation_key = input.operation_key.clone();
    let run = run_operation(conn, channel, &operation_key, request, now_ms, |tx| {
        let mut claims = Vec::with_capacity(input.targets.len());
        for target in &input.targets {
            match validate_target(tx, target)? {
                Ok(claim) => claims.push(claim),
                Err(reason) => {
                    return Ok(Stage::Stale(format!(
                        "{}: {reason}",
                        target.mutation_token.public_claim_id
                    )))
                }
            }
        }
        let mut effects = Vec::new();
        let mut payload_claims = Vec::new();
        for claim in claims {
            let (event_id, sequence, state) = lifecycle_head(tx, claim.claim_id)?;
            payload_claims.push(claim_payload(&claim)?);
            if state == "archived" {
                continue;
            }
            sql(tx.execute(
                "INSERT INTO claim_memory_lifecycle_events \
                 (claim_id, seq, predecessor_id, state, actor, reason, recorded_at) \
                 VALUES (?1, ?2, ?3, 'archived', ?4, 'dashboard bulk archive', ?5)",
                params![
                    claim.claim_id,
                    sequence + 1,
                    event_id,
                    channel.actor(),
                    now_ms
                ],
            ))?;
            sql(tx.execute(
                "UPDATE claims SET state = 'archived' WHERE id = ?1",
                [claim.claim_id],
            ))?;
            sql(tx.execute(
                "UPDATE claim_memory_current_heads SET lifecycle_state = 'archived', updated_at = ?1 WHERE claim_id = ?2",
                params![now_ms, claim.claim_id],
            ))?;
            effects.push(Effect {
                effect_key: format!("lifecycle:{}:archived", claim.public_claim_id),
                project_id: claim.project_id,
                claim_id: claim.claim_id,
                revision_id: Some(claim.current_revision_id),
                change_kind: "lifecycle".to_string(),
            });
        }
        if effects.is_empty() {
            Ok(Stage::Noop {
                payload: json!({"claims": payload_claims, "kind": "bulk-lifecycle", "state": "archived"}),
                mutation_token_public_ids: public_ids.clone(),
            })
        } else {
            Ok(Stage::Effects {
                payload: json!({"claims": payload_claims, "kind": "bulk-lifecycle", "state": "archived"}),
                effects,
                policy_revision_ids: Vec::new(),
                mutation_token_public_ids: public_ids.clone(),
            })
        }
    })?;
    response(conn, run, &public_ids)
}
