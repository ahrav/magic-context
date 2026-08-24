/**
 * v86 claim trust policy DDL (claim-trust-policy plan: U1; KTD1, KTD2,
 * KTD5-KTD7, KTD11-KTD12).
 *
 * Dependency-light on purpose: runtime imports here must carry explicit `.ts`
 * extensions so the Node SQLite smoke
 * (`packages/plugin/scripts/smoke-node-sqlite.ts`) can import this module
 * directly under Node's type-stripping loader.
 *
 * Every object here is migration-owned (created by migration v86, never by
 * `initializeDatabase()`), following the v82/v84/v85 precedent.
 *
 * Physical model (KTD1): trust state is an append-only decision ledger, never
 * mutable columns on `claims` or `claim_revisions`. Historical maturity only
 * moves upward within one gapless per-revision stream; the effective state
 * used by retrieval is derived by the TypeScript reducer from current support
 * (verification, approval, artifact validity, dispositions) and materialized
 * into the rebuildable, non-authoritative `claim_effective_policy` projection.
 * Missing policy state reads as `CANDIDATE` / unknown taint / automatic-hidden
 * by contract (R26).
 */

import type { Database } from "../../shared/sqlite";

/** Versioned policy contract consumed by U8/U18 (R1, R18). */
export const CLAIM_POLICY_VERSION = 1;

export const CLAIM_POLICY_TABLES = [
    "claim_revision_policy_subjects",
    "claim_maturity_streams",
    "claim_maturity_assertions",
    "claim_disposition_events",
    "claim_approval_actions",
    "claim_enforcement_artifacts",
    "claim_enforcement_artifact_events",
    "claim_effective_policy",
    "claim_policy_projector_watermarks",
] as const;

/** Claim kinds (R2). `unknown` receives directive-strength restrictions. */
export const CLAIM_KINDS = ["descriptive", "directive", "unknown"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Fine observation-level taint classes (R3). */
/** The BEFORE UPDATE / BEFORE DELETE append-only guard pair every v86
 * ledger table carries. One template so the seven copies cannot drift on a
 * future edit; each table's insert-collision trigger stays written out
 * individually because its WHEN clause differs by key shape. */
function appendOnlyTriggers(triggerPrefix: string, table: string): string {
    return `    CREATE TRIGGER ${triggerPrefix}_append_only_update
    BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only: updates are not allowed'); END;
    CREATE TRIGGER ${triggerPrefix}_append_only_delete
    BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only: deletes are not allowed'); END;`;
}

export const FINE_TAINTS = [
    "USER_EXPLICIT",
    "USER_INFERRED",
    "CURRENT_CODE",
    "CURRENT_TEST",
    "CURRENT_CONFIG",
    "REPO_UNTRUSTED_TEXT",
    "TOOL_UNTRUSTED_OUTPUT",
    "ASSISTANT_INFERENCE",
    "DREAMER_INFERENCE",
] as const;
export type FineTaint = (typeof FINE_TAINTS)[number];

/** Maturity ladder (R7). Historical assertions only move upward (R15). */
export const MATURITY_LEVELS = [
    "CANDIDATE",
    "CORROBORATED",
    "VERIFIED",
    "APPROVED",
    "ENFORCED",
] as const;
export type MaturityLevel = (typeof MATURITY_LEVELS)[number];

export const MATURITY_RANK: Readonly<Record<MaturityLevel, number>> = {
    CANDIDATE: 0,
    CORROBORATED: 1,
    VERIFIED: 2,
    APPROVED: 3,
    ENFORCED: 4,
};

/**
 * Explicit disposition kinds owned by `claim_disposition_events` (R14).
 * `contradicted` and `superseded` derive from `claim_conflicts`; verification
 * `stale`/`flagged` events additionally feed the reducer's stale/disputed
 * facts. Rejected is review-only; quarantined is hard-hidden (R16-R17).
 */
export const DISPOSITION_KINDS = ["stale", "disputed", "rejected", "quarantined"] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

export const DISPOSITION_ACTIONS = ["assert", "clear"] as const;
export type DispositionAction = (typeof DISPOSITION_ACTIONS)[number];

/** Host-recorded human authority actions (R10, KTD5). */
export const APPROVAL_ACTIONS = ["approve", "revoke"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Content-addressed enforcement artifact kinds (R11, KTD6). */
export const ENFORCEMENT_ARTIFACT_KINDS = ["test", "policy", "config"] as const;
export type EnforcementArtifactKind = (typeof ENFORCEMENT_ARTIFACT_KINDS)[number];

export const ENFORCEMENT_ARTIFACT_RESULTS = ["pass", "fail"] as const;
export type EnforcementArtifactResult = (typeof ENFORCEMENT_ARTIFACT_RESULTS)[number];

/** Append-only artifact support removal (KTD6). Re-validation appends a new
 * artifact row; there is no mutate-in-place path. */
export const ENFORCEMENT_ARTIFACT_EVENT_ACTIONS = ["revoked"] as const;

/** schema_migrations_meta keys for the bounded fail-closed seed (KTD11, R28). */
export const CLAIM_POLICY_SEED_META_KEYS = {
    boundaryRevisionId: "claim_policy_seed_boundary_revision_id",
    expectedCount: "claim_policy_seed_expected_count",
    cursor: "claim_policy_seed_cursor",
    phase: "claim_policy_seed_phase",
    completionWatermark: "claim_policy_seed_completion_watermark",
    seededCounts: "claim_policy_seed_counts",
    reconcileEventWatermark: "claim_policy_reconcile_event_watermark",
} as const;

const sqlList = (values: readonly string[]): string =>
    values.map((value) => `'${value}'`).join(", ");

const maturityRankCase = (column: string): string =>
    `CASE ${column} ${MATURITY_LEVELS.map((level) => `WHEN '${level}' THEN ${MATURITY_RANK[level]}`).join(" ")} END`;

/** Full v86 object graph: tables from dependency roots outward, indexes, the
 * head view, then guards. */
export function createClaimPolicySchema(db: Database): void {
    // Interpolation is a compile-time const allowlist, not caller input.
    // pi-lens-ignore: sql-injection
    db.exec(`
    -- One immutable policy subject per revision (R1, KTD2): freezes claim
    -- kind, origin observation, origin taint, bound digest, and policy
    -- version before any promotion. A revision without a subject reads as
    -- conservative unknown (R26).
    CREATE TABLE claim_revision_policy_subjects (
        revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        claim_kind TEXT NOT NULL CHECK (claim_kind IN (${sqlList(CLAIM_KINDS)})),
        origin_observation_id INTEGER REFERENCES observations(id) ON DELETE RESTRICT,
        -- Frozen origin taint (R5): later corroboration cannot launder it.
        origin_taint TEXT NOT NULL CHECK (origin_taint IN (${sqlList(FINE_TAINTS)})),
        classification_method TEXT NOT NULL CHECK (length(classification_method) > 0),
        source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
        policy_version INTEGER NOT NULL CHECK (
            typeof(policy_version) = 'integer' AND policy_version >= 1
        ),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_policy_subjects_project
        ON claim_revision_policy_subjects(project_id);

    -- One immutable maturity stream per revision (KTD1).
    CREATE TABLE claim_maturity_streams (
        id INTEGER PRIMARY KEY,
        revision_id INTEGER NOT NULL UNIQUE
            REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_maturity_streams_project ON claim_maturity_streams(project_id);

    -- Gapless append-only maturity decisions (R7, R15). Rank strictly
    -- increases within a stream; the effective reducer, not this history,
    -- selects the currently supported rung.
    CREATE TABLE claim_maturity_assertions (
        id INTEGER PRIMARY KEY,
        stream_id INTEGER NOT NULL REFERENCES claim_maturity_streams(id) ON DELETE RESTRICT,
        seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 1),
        predecessor_id INTEGER REFERENCES claim_maturity_assertions(id) ON DELETE RESTRICT,
        maturity TEXT NOT NULL CHECK (maturity IN (${sqlList(MATURITY_LEVELS)})),
        actor TEXT NOT NULL CHECK (length(actor) > 0),
        evidence_json TEXT,
        approval_action_id INTEGER REFERENCES claim_approval_actions(id) ON DELETE RESTRICT,
        artifact_id INTEGER REFERENCES claim_enforcement_artifacts(id) ON DELETE RESTRICT,
        policy_version INTEGER NOT NULL CHECK (
            typeof(policy_version) = 'integer' AND policy_version >= 1
        ),
        recorded_at INTEGER NOT NULL,
        UNIQUE (stream_id, seq),
        CHECK ((seq = 1) = (predecessor_id IS NULL)),
        -- Human-authority rungs must carry their proof rows (R10-R11).
        CHECK (maturity <> 'APPROVED' OR approval_action_id IS NOT NULL),
        CHECK (maturity <> 'ENFORCED' OR (approval_action_id IS NOT NULL AND artifact_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX idx_claim_maturity_assertions_predecessor
        ON claim_maturity_assertions(predecessor_id)
        WHERE predecessor_id IS NOT NULL;

    -- Orthogonal epistemic facts (R14): explicit assert/clear actions for
    -- dispositions not already represented by verification or conflict rows.
    CREATE TABLE claim_disposition_events (
        id INTEGER PRIMARY KEY,
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        disposition TEXT NOT NULL CHECK (disposition IN (${sqlList(DISPOSITION_KINDS)})),
        action TEXT NOT NULL CHECK (action IN (${sqlList(DISPOSITION_ACTIONS)})),
        reason TEXT CHECK (reason IS NULL OR length(reason) > 0),
        actor TEXT NOT NULL CHECK (length(actor) > 0),
        policy_version INTEGER NOT NULL CHECK (
            typeof(policy_version) = 'integer' AND policy_version >= 1
        ),
        recorded_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_disposition_events_revision
        ON claim_disposition_events(revision_id, disposition, id);

    -- Host-confirmed human authority (R10, KTD5). Approve and revoke both
    -- append here; command_identity is the idempotency identity.
    CREATE TABLE claim_approval_actions (
        id INTEGER PRIMARY KEY,
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        action TEXT NOT NULL CHECK (action IN (${sqlList(APPROVAL_ACTIONS)})),
        host TEXT NOT NULL CHECK (length(host) > 0),
        -- Provenance only: never joined to the clearSession() ownership
        -- contract (deliberately NOT named session_id, the v82 pattern).
        source_session_id TEXT NOT NULL CHECK (length(source_session_id) > 0),
        user_command_event TEXT NOT NULL CHECK (length(user_command_event) > 0),
        command_identity TEXT NOT NULL UNIQUE CHECK (length(command_identity) > 0),
        confirmation_nonce TEXT NOT NULL CHECK (length(confirmation_nonce) > 0),
        revision_digest TEXT NOT NULL CHECK (length(revision_digest) = 64),
        policy_version INTEGER NOT NULL CHECK (
            typeof(policy_version) = 'integer' AND policy_version >= 1
        ),
        recorded_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_approval_actions_revision
        ON claim_approval_actions(revision_id, id);

    -- Content-addressed enforcement artifacts (R11, KTD6). The row itself is
    -- the validation event; revocation appends to the events table.
    CREATE TABLE claim_enforcement_artifacts (
        id INTEGER PRIMARY KEY,
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (${sqlList(ENFORCEMENT_ARTIFACT_KINDS)})),
        canonical_path TEXT NOT NULL CHECK (length(canonical_path) > 0),
        bytes_digest TEXT NOT NULL CHECK (length(bytes_digest) = 64),
        git_anchor_id INTEGER REFERENCES git_anchors(id) ON DELETE RESTRICT,
        evaluator TEXT NOT NULL CHECK (length(evaluator) > 0),
        evaluator_version TEXT NOT NULL CHECK (length(evaluator_version) > 0),
        evaluator_result TEXT NOT NULL CHECK (
            evaluator_result IN (${sqlList(ENFORCEMENT_ARTIFACT_RESULTS)})
        ),
        revision_digest TEXT NOT NULL CHECK (length(revision_digest) = 64),
        policy_version INTEGER NOT NULL CHECK (
            typeof(policy_version) = 'integer' AND policy_version >= 1
        ),
        recorded_at INTEGER NOT NULL,
        -- enforced_from_root: the filesystem root the evaluation ran in.
        -- Clones and worktrees of one repository share a project identity,
        -- so revalidation must only rehash an artifact from the checkout
        -- that enforced it — checkout B legitimately lacks (or differs at)
        -- the same relative path. Intentionally NULLABLE: legacy rows carry
        -- no root and are skipped by revalidation.
        enforced_from_root TEXT
    );
    CREATE INDEX idx_claim_enforcement_artifacts_revision
        ON claim_enforcement_artifacts(revision_id, id);

    CREATE TABLE claim_enforcement_artifact_events (
        id INTEGER PRIMARY KEY,
        artifact_id INTEGER NOT NULL
            REFERENCES claim_enforcement_artifacts(id) ON DELETE RESTRICT,
        action TEXT NOT NULL CHECK (
            action IN (${sqlList(ENFORCEMENT_ARTIFACT_EVENT_ACTIONS)})
        ),
        reason TEXT CHECK (reason IS NULL OR length(reason) > 0),
        recorded_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_enforcement_artifact_events_artifact
        ON claim_enforcement_artifact_events(artifact_id, id);

    -- Rebuildable, NON-authoritative effective-policy projection (KTD7).
    -- Mutable by design: the reducer rewrites rows and rebuild-from-history
    -- must reproduce identical bytes. SQL surfaces filter on these indexed
    -- fields BEFORE candidate limits; hydration reruns the pure evaluator.
    CREATE TABLE claim_effective_policy (
        revision_id INTEGER PRIMARY KEY REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        effective_maturity TEXT NOT NULL CHECK (
            effective_maturity IN (${sqlList(MATURITY_LEVELS)})
        ),
        origin_taint TEXT NOT NULL CHECK (origin_taint IN (${sqlList(FINE_TAINTS)})),
        auto_eligible INTEGER NOT NULL CHECK (auto_eligible IN (0, 1)),
        explicit_eligible INTEGER NOT NULL CHECK (explicit_eligible IN (0, 1)),
        hard_hidden INTEGER NOT NULL CHECK (hard_hidden IN (0, 1)),
        reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
        dispositions_json TEXT NOT NULL CHECK (json_valid(dispositions_json)),
        policy_version INTEGER NOT NULL CHECK (
            typeof(policy_version) = 'integer' AND policy_version >= 1
        ),
        generation INTEGER NOT NULL CHECK (
            typeof(generation) = 'integer' AND generation >= 0
        ),
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_claim_effective_policy_auto
        ON claim_effective_policy(project_id, auto_eligible);
    CREATE INDEX idx_claim_effective_policy_explicit
        ON claim_effective_policy(project_id, explicit_eligible);
    CREATE INDEX idx_claim_effective_policy_claim ON claim_effective_policy(claim_id);

    -- Durable replay watermarks for cache/native projectors (KTD9, R27).
    CREATE TABLE claim_policy_projector_watermarks (
        consumer TEXT NOT NULL CHECK (length(consumer) > 0),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        watermark INTEGER NOT NULL CHECK (typeof(watermark) = 'integer' AND watermark >= 0),
        generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (consumer, project_id)
    ) WITHOUT ROWID;

    -- Current head assertion per stream (derived; not indexable storage).
    CREATE VIEW claim_maturity_heads AS
    SELECT
        assertion.id AS assertion_id,
        stream.revision_id AS revision_id,
        stream.project_id AS project_id,
        assertion.stream_id AS stream_id,
        assertion.seq AS seq,
        assertion.maturity AS maturity,
        assertion.approval_action_id AS approval_action_id,
        assertion.artifact_id AS artifact_id,
        assertion.policy_version AS policy_version,
        assertion.recorded_at AS recorded_at
    FROM claim_maturity_assertions AS assertion
    JOIN claim_maturity_streams AS stream ON stream.id = assertion.stream_id
    WHERE assertion.seq = (
        SELECT MAX(inner.seq) FROM claim_maturity_assertions AS inner
        WHERE inner.stream_id = assertion.stream_id
    );
    `);

    // Interpolation is a compile-time const allowlist, not caller input.
    // pi-lens-ignore: sql-injection
    db.exec(`
${appendOnlyTriggers("claim_policy_subjects", "claim_revision_policy_subjects")}
    CREATE TRIGGER claim_policy_subjects_append_only_insert_collision
    BEFORE INSERT ON claim_revision_policy_subjects
    WHEN EXISTS (SELECT 1 FROM claim_revision_policy_subjects WHERE revision_id = NEW.revision_id)
    BEGIN SELECT RAISE(ABORT, 'claim_revision_policy_subjects is append-only: key collisions cannot replace rows'); END;

    -- Subject project must be the revision's own project (KTD2). IS NOT is
    -- deliberate: a missing revision fails closed before the FK error would.
    CREATE TRIGGER claim_policy_subjects_project_guard
    BEFORE INSERT ON claim_revision_policy_subjects
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_revision_policy_subjects project must match the revision project'); END;

    -- The bound digest must be the revision's exact content hash (R1, R4).
    CREATE TRIGGER claim_policy_subjects_digest_guard
    BEFORE INSERT ON claim_revision_policy_subjects
    WHEN (
        SELECT content_sha256 FROM claim_revisions WHERE id = NEW.revision_id
    ) IS NOT NEW.source_digest
    BEGIN SELECT RAISE(ABORT, 'claim_revision_policy_subjects source digest must match the revision content hash'); END;

    -- A named origin must be SUPPORTING evidence FOR this exact revision
    -- (R4, KTD2): extracted content and self-asserted metadata never select
    -- the origin, and merged lineage ('merged_from') is provenance of a
    -- different observation, not evidence supporting this revision — an
    -- importer or merge path must not freeze a merged observation's taint
    -- as the revision origin. The second branch couples the ABSENCE of a
    -- named origin to inference taints for live writes: with no observation
    -- to back it, a higher trust class would freeze an unbacked taint
    -- forever. Legacy-seed subjects (classification method ':seed') are
    -- exempt — the pre-v86 corpus legitimately elevates boundary-gated
    -- metadata provenance whose observations were never linked as evidence.
    CREATE TRIGGER claim_policy_subjects_origin_guard
    BEFORE INSERT ON claim_revision_policy_subjects
    WHEN (
        NEW.origin_observation_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM claim_evidence
            WHERE revision_id = NEW.revision_id
              AND observation_id = NEW.origin_observation_id
              AND relation = 'supports'
        )
    ) OR (
        NEW.origin_observation_id IS NULL
        AND NEW.classification_method NOT LIKE '%:seed'
        AND NEW.origin_taint NOT IN ('ASSISTANT_INFERENCE', 'DREAMER_INFERENCE')
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_policy_subjects origin must be supporting evidence for the same revision, and a live write without a named origin only carries an inference taint'); END;

${appendOnlyTriggers("claim_maturity_streams", "claim_maturity_streams")}
    CREATE TRIGGER claim_maturity_streams_append_only_insert_collision
    BEFORE INSERT ON claim_maturity_streams
    WHEN EXISTS (
        SELECT 1 FROM claim_maturity_streams
        WHERE id = NEW.id OR revision_id = NEW.revision_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_maturity_streams is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_maturity_streams_project_guard
    BEFORE INSERT ON claim_maturity_streams
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_maturity_streams project must match the revision project'); END;

    -- Promotion requires the frozen policy subject to exist first (KTD2).
    CREATE TRIGGER claim_maturity_streams_subject_guard
    BEFORE INSERT ON claim_maturity_streams
    WHEN NOT EXISTS (
        SELECT 1 FROM claim_revision_policy_subjects WHERE revision_id = NEW.revision_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_maturity_streams require an existing policy subject for the revision'); END;

${appendOnlyTriggers("claim_maturity_assertions", "claim_maturity_assertions")}
    CREATE TRIGGER claim_maturity_assertions_append_only_insert_collision
    BEFORE INSERT ON claim_maturity_assertions
    WHEN EXISTS (
        SELECT 1 FROM claim_maturity_assertions
        WHERE id = NEW.id OR (stream_id = NEW.stream_id AND seq = NEW.seq)
           OR (NEW.predecessor_id IS NOT NULL AND predecessor_id = NEW.predecessor_id)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_maturity_assertions is append-only: key collisions cannot replace rows'); END;

    -- The predecessor must be the head of the SAME stream at exactly the
    -- previous sequence: one gapless chain, no forks (KTD1).
    CREATE TRIGGER claim_maturity_assertions_chain_guard
    BEFORE INSERT ON claim_maturity_assertions
    WHEN NEW.predecessor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM claim_maturity_assertions predecessor
        WHERE predecessor.id = NEW.predecessor_id
          AND predecessor.stream_id = NEW.stream_id
          AND predecessor.seq = NEW.seq - 1
    )
    BEGIN SELECT RAISE(ABORT, 'maturity assertion predecessor must be the same-stream head at the previous sequence'); END;

    CREATE TRIGGER claim_maturity_assertions_first_seq_guard
    BEFORE INSERT ON claim_maturity_assertions
    WHEN NEW.predecessor_id IS NULL AND EXISTS (
        SELECT 1 FROM claim_maturity_assertions WHERE stream_id = NEW.stream_id
    )
    BEGIN SELECT RAISE(ABORT, 'maturity assertion without a predecessor must open its stream'); END;

    -- Historical maturity only moves upward within its stream (R15).
    CREATE TRIGGER claim_maturity_assertions_ladder_guard
    BEFORE INSERT ON claim_maturity_assertions
    WHEN NEW.predecessor_id IS NOT NULL AND (
        ${maturityRankCase("NEW.maturity")}
    ) <= (
        SELECT ${maturityRankCase("maturity")} FROM claim_maturity_assertions
        WHERE id = NEW.predecessor_id
    )
    BEGIN SELECT RAISE(ABORT, 'maturity assertions must strictly increase within their stream'); END;

    -- APPROVED requires a same-revision host-recorded approve action (R10);
    -- ENFORCED additionally requires a same-revision passing artifact (R11).
    CREATE TRIGGER claim_maturity_assertions_approval_guard
    BEFORE INSERT ON claim_maturity_assertions
    WHEN NEW.approval_action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM claim_approval_actions approval
        JOIN claim_maturity_streams stream ON stream.id = NEW.stream_id
        WHERE approval.id = NEW.approval_action_id
          AND approval.revision_id = stream.revision_id
          AND approval.action = 'approve'
    )
    BEGIN SELECT RAISE(ABORT, 'maturity assertion approval must be an approve action for the same revision'); END;

    CREATE TRIGGER claim_maturity_assertions_artifact_guard
    BEFORE INSERT ON claim_maturity_assertions
    WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM claim_enforcement_artifacts artifact
        JOIN claim_maturity_streams stream ON stream.id = NEW.stream_id
        WHERE artifact.id = NEW.artifact_id
          AND artifact.revision_id = stream.revision_id
          AND artifact.evaluator_result = 'pass'
    )
    BEGIN SELECT RAISE(ABORT, 'maturity assertion artifact must be a passing artifact for the same revision'); END;

${appendOnlyTriggers("claim_disposition_events", "claim_disposition_events")}
    CREATE TRIGGER claim_disposition_events_append_only_insert_collision
    BEFORE INSERT ON claim_disposition_events
    WHEN EXISTS (SELECT 1 FROM claim_disposition_events WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'claim_disposition_events is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_disposition_events_project_guard
    BEFORE INSERT ON claim_disposition_events
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_disposition_events project must match the revision project'); END;

    -- A clear must resolve a currently asserted disposition.
    CREATE TRIGGER claim_disposition_events_clear_guard
    BEFORE INSERT ON claim_disposition_events
    WHEN NEW.action = 'clear' AND COALESCE((
        SELECT action FROM claim_disposition_events
        WHERE revision_id = NEW.revision_id AND disposition = NEW.disposition
        ORDER BY id DESC LIMIT 1
    ), 'clear') = 'clear'
    BEGIN SELECT RAISE(ABORT, 'claim_disposition_events clear requires a currently asserted disposition'); END;

${appendOnlyTriggers("claim_approval_actions", "claim_approval_actions")}
    CREATE TRIGGER claim_approval_actions_append_only_insert_collision
    BEFORE INSERT ON claim_approval_actions
    WHEN EXISTS (
        SELECT 1 FROM claim_approval_actions
        WHERE id = NEW.id OR command_identity = NEW.command_identity
    )
    BEGIN SELECT RAISE(ABORT, 'claim_approval_actions is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_approval_actions_project_guard
    BEFORE INSERT ON claim_approval_actions
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_approval_actions project must match the revision project'); END;

    -- The approval binds the exact revision content (R10).
    CREATE TRIGGER claim_approval_actions_digest_guard
    BEFORE INSERT ON claim_approval_actions
    WHEN (
        SELECT content_sha256 FROM claim_revisions WHERE id = NEW.revision_id
    ) IS NOT NEW.revision_digest
    BEGIN SELECT RAISE(ABORT, 'claim_approval_actions revision digest must match the revision content hash'); END;

    -- A revoke must target a currently effective approve (R15).
    CREATE TRIGGER claim_approval_actions_revoke_guard
    BEFORE INSERT ON claim_approval_actions
    WHEN NEW.action = 'revoke' AND COALESCE((
        SELECT action FROM claim_approval_actions
        WHERE revision_id = NEW.revision_id
        ORDER BY id DESC LIMIT 1
    ), 'revoke') = 'revoke'
    BEGIN SELECT RAISE(ABORT, 'claim_approval_actions revoke requires a currently effective approval'); END;

${appendOnlyTriggers("claim_enforcement_artifacts", "claim_enforcement_artifacts")}
    CREATE TRIGGER claim_enforcement_artifacts_append_only_insert_collision
    BEFORE INSERT ON claim_enforcement_artifacts
    WHEN EXISTS (SELECT 1 FROM claim_enforcement_artifacts WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'claim_enforcement_artifacts is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_enforcement_artifacts_project_guard
    BEFORE INSERT ON claim_enforcement_artifacts
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_enforcement_artifacts project must match the revision project'); END;

    -- The artifact binds the exact revision content atomically (R11).
    CREATE TRIGGER claim_enforcement_artifacts_digest_guard
    BEFORE INSERT ON claim_enforcement_artifacts
    WHEN (
        SELECT content_sha256 FROM claim_revisions WHERE id = NEW.revision_id
    ) IS NOT NEW.revision_digest
    BEGIN SELECT RAISE(ABORT, 'claim_enforcement_artifacts revision digest must match the revision content hash'); END;

    -- Anchors stay project-scoped (KTD6).
    CREATE TRIGGER claim_enforcement_artifacts_anchor_project_guard
    BEFORE INSERT ON claim_enforcement_artifacts
    WHEN NEW.git_anchor_id IS NOT NULL AND (
        SELECT project_id FROM git_anchors WHERE id = NEW.git_anchor_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_enforcement_artifacts anchor must belong to the artifact project'); END;

    -- Enforcement additionally requires a currently effective approval (R11).
    CREATE TRIGGER claim_enforcement_artifacts_approval_guard
    BEFORE INSERT ON claim_enforcement_artifacts
    WHEN COALESCE((
        SELECT action FROM claim_approval_actions
        WHERE revision_id = NEW.revision_id
        ORDER BY id DESC LIMIT 1
    ), 'revoke') <> 'approve'
    BEGIN SELECT RAISE(ABORT, 'claim_enforcement_artifacts require a currently effective approval for the revision'); END;

${appendOnlyTriggers("claim_artifact_events", "claim_enforcement_artifact_events")}
    CREATE TRIGGER claim_artifact_events_append_only_insert_collision
    BEFORE INSERT ON claim_enforcement_artifact_events
    WHEN EXISTS (SELECT 1 FROM claim_enforcement_artifact_events WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'claim_enforcement_artifact_events is append-only: key collisions cannot replace rows'); END;
    `);
}

/**
 * Targeted per-new-table foreign-key validation, mirroring the v82/v85
 * pattern so unrelated legacy corruption cannot turn this migration into a
 * whole-database repair gate.
 */
export function assertClaimPolicySchemaForeignKeys(db: Database): void {
    const violations: string[] = [];
    for (const table of CLAIM_POLICY_TABLES) {
        const rows = db.prepare(`PRAGMA foreign_key_check(${table})`).all() as unknown[];
        if (rows.length > 0) violations.push(`${table}: ${rows.length} violation(s)`);
    }
    if (violations.length > 0) {
        throw new Error(`v86 foreign_key_check failed: ${violations.join("; ")}`);
    }
}

/**
 * Non-table objects `createClaimPolicySchema` creates, absent from a bare
 * table listing. The v86 replay guard refuses a database whose tables
 * survived but whose view, indexes, or guard triggers did not.
 * migrations-v86.test.ts asserts this list stays in sync with the DDL.
 */
export function missingClaimPolicySchemaObjects(db: Database): string[] {
    const required: Array<[type: string, name: string]> = [
        ["view", "claim_maturity_heads"],
        ["index", "idx_claim_policy_subjects_project"],
        ["index", "idx_claim_maturity_streams_project"],
        ["index", "idx_claim_maturity_assertions_predecessor"],
        ["index", "idx_claim_disposition_events_revision"],
        ["index", "idx_claim_approval_actions_revision"],
        ["index", "idx_claim_enforcement_artifacts_revision"],
        ["index", "idx_claim_enforcement_artifact_events_artifact"],
        ["index", "idx_claim_effective_policy_auto"],
        ["index", "idx_claim_effective_policy_explicit"],
        ["index", "idx_claim_effective_policy_claim"],
        ["trigger", "claim_policy_subjects_append_only_update"],
        ["trigger", "claim_policy_subjects_append_only_delete"],
        ["trigger", "claim_policy_subjects_append_only_insert_collision"],
        ["trigger", "claim_policy_subjects_project_guard"],
        ["trigger", "claim_policy_subjects_digest_guard"],
        ["trigger", "claim_policy_subjects_origin_guard"],
        ["trigger", "claim_maturity_streams_append_only_update"],
        ["trigger", "claim_maturity_streams_append_only_delete"],
        ["trigger", "claim_maturity_streams_append_only_insert_collision"],
        ["trigger", "claim_maturity_streams_project_guard"],
        ["trigger", "claim_maturity_streams_subject_guard"],
        ["trigger", "claim_maturity_assertions_append_only_update"],
        ["trigger", "claim_maturity_assertions_append_only_delete"],
        ["trigger", "claim_maturity_assertions_append_only_insert_collision"],
        ["trigger", "claim_maturity_assertions_chain_guard"],
        ["trigger", "claim_maturity_assertions_first_seq_guard"],
        ["trigger", "claim_maturity_assertions_ladder_guard"],
        ["trigger", "claim_maturity_assertions_approval_guard"],
        ["trigger", "claim_maturity_assertions_artifact_guard"],
        ["trigger", "claim_disposition_events_append_only_update"],
        ["trigger", "claim_disposition_events_append_only_delete"],
        ["trigger", "claim_disposition_events_append_only_insert_collision"],
        ["trigger", "claim_disposition_events_project_guard"],
        ["trigger", "claim_disposition_events_clear_guard"],
        ["trigger", "claim_approval_actions_append_only_update"],
        ["trigger", "claim_approval_actions_append_only_delete"],
        ["trigger", "claim_approval_actions_append_only_insert_collision"],
        ["trigger", "claim_approval_actions_project_guard"],
        ["trigger", "claim_approval_actions_digest_guard"],
        ["trigger", "claim_approval_actions_revoke_guard"],
        ["trigger", "claim_enforcement_artifacts_append_only_update"],
        ["trigger", "claim_enforcement_artifacts_append_only_delete"],
        ["trigger", "claim_enforcement_artifacts_append_only_insert_collision"],
        ["trigger", "claim_enforcement_artifacts_project_guard"],
        ["trigger", "claim_enforcement_artifacts_digest_guard"],
        ["trigger", "claim_enforcement_artifacts_anchor_project_guard"],
        ["trigger", "claim_enforcement_artifacts_approval_guard"],
        ["trigger", "claim_artifact_events_append_only_update"],
        ["trigger", "claim_artifact_events_append_only_delete"],
        ["trigger", "claim_artifact_events_append_only_insert_collision"],
    ];
    const present = new Set(
        (
            db
                .prepare(
                    "SELECT type || ' ' || name AS object FROM sqlite_master WHERE type IN ('view', 'index', 'trigger')",
                )
                .all() as Array<{ object: string }>
        ).map((row) => row.object),
    );
    return required
        .map(([type, name]) => `${type} ${name}`)
        .filter((object) => !present.has(object));
}

export function dropClaimPolicyObjectsForTests(db: Database): void {
    db.exec(`
        DROP VIEW IF EXISTS claim_maturity_heads;
        DROP TABLE IF EXISTS claim_policy_projector_watermarks;
        DROP TABLE IF EXISTS claim_effective_policy;
        DROP TABLE IF EXISTS claim_enforcement_artifact_events;
        DROP TABLE IF EXISTS claim_maturity_assertions;
        DROP TABLE IF EXISTS claim_enforcement_artifacts;
        DROP TABLE IF EXISTS claim_approval_actions;
        DROP TABLE IF EXISTS claim_disposition_events;
        DROP TABLE IF EXISTS claim_maturity_streams;
        DROP TABLE IF EXISTS claim_revision_policy_subjects;
    `);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 86").run();
    db.prepare("DELETE FROM schema_migrations_meta WHERE key LIKE 'claim_policy_seed_%'").run();
}
