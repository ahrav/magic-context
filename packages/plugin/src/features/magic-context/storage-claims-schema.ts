/**
 *
 * This module uses only type-only imports because Node's type-stripping loader cannot resolve extensionless runtime imports.
 * The Node SQLite smoke imports this module directly.
 * Node's type-stripping loader imports this module directly.
 *
 *
 * The database rejects UPDATE and DELETE on every append-only table.
 * Append-only tables reject INSERTs that conflict with a primary or unique key.
 * Conflicting INSERTs are rejected so INSERT OR REPLACE cannot bypass delete guards when recursive triggers are disabled.
 * `claims` remains mutable for lifecycle state and its current-revision pointer.
 * `claims` forbids changes to its semantic key columns.
 * A published current-revision pointer cannot become NULL.
 */

import type { Database } from "../../shared/sqlite";

export const CLAIMS_AND_EVIDENCE_TABLES = [
    "projects",
    "project_aliases",
    "episodes",
    "source_spans",
    "observations",
    "claims",
    "claim_revisions",
    "claim_evidence",
    "claim_conflicts",
    "verification_events",
] as const;

/** The database rejects UPDATE and DELETE on rows in these tables. */
export const APPEND_ONLY_CLAIMS_TABLES = [
    "episodes",
    "source_spans",
    "observations",
    "claim_revisions",
    "claim_evidence",
    "claim_conflicts",
    "verification_events",
] as const;

/* */
export function createClaimsAndEvidenceSchema(db: Database): void {
    db.exec(`
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_identity TEXT NOT NULL UNIQUE CHECK (
            canonical_identity GLOB 'git:?*' OR canonical_identity GLOB 'dir:?*'
        ),
        created_at INTEGER NOT NULL
    );

    CREATE TABLE project_aliases (
        alias_identity TEXT PRIMARY KEY CHECK (length(alias_identity) > 0),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_project_aliases_project ON project_aliases(project_id);

    CREATE TABLE episodes (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        -- Provenance only: never joined to the clearSession() ownership contract
        -- (deliberately NOT named session_id — see R37 / KTD36).
        source_session_id TEXT CHECK (source_session_id IS NULL OR length(source_session_id) > 0),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_episodes_project ON episodes(project_id);

    CREATE TABLE source_spans (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
        source_locator TEXT NOT NULL CHECK (length(source_locator) > 0),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        -- Half-open [start, end): a span must cover at least one unit.
        start_offset INTEGER NOT NULL CHECK (typeof(start_offset) = 'integer' AND start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (typeof(end_offset) = 'integer' AND end_offset > start_offset),
        -- Opaque reference; the raw-artifact table is deferred by contract.
        raw_artifact_ref TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_source_spans_episode ON source_spans(episode_id);

    CREATE TABLE observations (
        id INTEGER PRIMARY KEY,
        source_span_id INTEGER NOT NULL REFERENCES source_spans(id) ON DELETE RESTRICT,
        extracted_text TEXT NOT NULL CHECK (length(extracted_text) > 0),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        extractor TEXT NOT NULL CHECK (length(extractor) > 0),
        extractor_version TEXT NOT NULL CHECK (length(extractor_version) > 0),
        extractor_run_id TEXT NOT NULL CHECK (length(extractor_run_id) > 0),
        independence_key TEXT NOT NULL CHECK (length(independence_key) > 0),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_observations_span ON observations(source_span_id);

    CREATE TABLE claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL CHECK (length(subject) > 0),
        predicate TEXT NOT NULL CHECK (length(predicate) > 0),
        scope TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'permanent', 'archived')),
        -- NULL only while a storage transaction bootstraps revision 1 (KTD35).
        current_revision_id INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (project_id, subject, predicate, scope),
        -- Ownership-safe pointer: targets UNIQUE(claim_id, id) on claim_revisions,
        -- so a claim cannot point at another claim's revision.
        FOREIGN KEY (id, current_revision_id) REFERENCES claim_revisions(claim_id, id)
    );

    CREATE TABLE claim_revisions (
        id INTEGER PRIMARY KEY,
        claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
        content TEXT NOT NULL CHECK (length(content) > 0),
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        source_session_id TEXT CHECK (source_session_id IS NULL OR length(source_session_id) > 0),
        created_at INTEGER NOT NULL,
        UNIQUE (claim_id, revision),
        UNIQUE (claim_id, id)
    );

    -- WITHOUT ROWID is load-bearing for the append-only contract: on a rowid
    -- table an INSERT OR REPLACE addressed at an existing rowid with a fresh
    -- (revision_id, observation_id) pair would slip past the collision trigger
    -- and, with recursive triggers off, REPLACE's implicit delete would skip
    -- the delete guard — silently destroying an evidence row.
    CREATE TABLE claim_evidence (
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK (relation IN ('supports', 'merged_from')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (revision_id, observation_id)
    ) WITHOUT ROWID;
    CREATE INDEX idx_claim_evidence_observation ON claim_evidence(observation_id);

    CREATE TABLE claim_conflicts (
        id INTEGER PRIMARY KEY,
        relation TEXT NOT NULL CHECK (relation IN ('contradicts', 'supersedes')),
        left_revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        right_revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        CHECK (left_revision_id <> right_revision_id),
        -- Contradiction is symmetric: canonical ascending order deduplicates
        -- reverse input. Supersession stays directional.
        CHECK (relation <> 'contradicts' OR left_revision_id < right_revision_id),
        UNIQUE (relation, left_revision_id, right_revision_id)
    );
    CREATE INDEX idx_claim_conflicts_left ON claim_conflicts(left_revision_id);
    CREATE INDEX idx_claim_conflicts_right ON claim_conflicts(right_revision_id);

    CREATE TABLE verification_events (
        id INTEGER PRIMARY KEY,
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        observation_id INTEGER REFERENCES observations(id) ON DELETE RESTRICT,
        outcome TEXT NOT NULL CHECK (outcome IN ('verified', 'update', 'archive', 'stale', 'flagged')),
        verifier TEXT NOT NULL CHECK (length(verifier) > 0),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_verification_events_revision ON verification_events(revision_id);
    CREATE INDEX idx_verification_events_observation ON verification_events(observation_id);
    `);

    db.exec(`
    CREATE TRIGGER episodes_append_only_update BEFORE UPDATE ON episodes
    BEGIN SELECT RAISE(ABORT, 'episodes is append-only: updates are not allowed'); END;
    CREATE TRIGGER episodes_append_only_delete BEFORE DELETE ON episodes
    BEGIN SELECT RAISE(ABORT, 'episodes is append-only: deletes are not allowed'); END;
    CREATE TRIGGER episodes_append_only_insert_collision BEFORE INSERT ON episodes
    WHEN EXISTS (SELECT 1 FROM episodes WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'episodes is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER source_spans_append_only_update BEFORE UPDATE ON source_spans
    BEGIN SELECT RAISE(ABORT, 'source_spans is append-only: updates are not allowed'); END;
    CREATE TRIGGER source_spans_append_only_delete BEFORE DELETE ON source_spans
    BEGIN SELECT RAISE(ABORT, 'source_spans is append-only: deletes are not allowed'); END;
    CREATE TRIGGER source_spans_append_only_insert_collision BEFORE INSERT ON source_spans
    WHEN EXISTS (SELECT 1 FROM source_spans WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'source_spans is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER observations_append_only_update BEFORE UPDATE ON observations
    BEGIN SELECT RAISE(ABORT, 'observations is append-only: updates are not allowed'); END;
    CREATE TRIGGER observations_append_only_delete BEFORE DELETE ON observations
    BEGIN SELECT RAISE(ABORT, 'observations is append-only: deletes are not allowed'); END;
    CREATE TRIGGER observations_append_only_insert_collision BEFORE INSERT ON observations
    WHEN EXISTS (SELECT 1 FROM observations WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'observations is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_revisions_append_only_update BEFORE UPDATE ON claim_revisions
    BEGIN SELECT RAISE(ABORT, 'claim_revisions is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_revisions_append_only_delete BEFORE DELETE ON claim_revisions
    BEGIN SELECT RAISE(ABORT, 'claim_revisions is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_revisions_append_only_insert_collision BEFORE INSERT ON claim_revisions
    WHEN EXISTS (
        SELECT 1 FROM claim_revisions
        WHERE id = NEW.id OR (claim_id = NEW.claim_id AND revision = NEW.revision)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revisions is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_evidence_append_only_update BEFORE UPDATE ON claim_evidence
    BEGIN SELECT RAISE(ABORT, 'claim_evidence is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_evidence_append_only_delete BEFORE DELETE ON claim_evidence
    BEGIN SELECT RAISE(ABORT, 'claim_evidence is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_evidence_append_only_insert_collision BEFORE INSERT ON claim_evidence
    WHEN EXISTS (
        SELECT 1 FROM claim_evidence
        WHERE revision_id = NEW.revision_id AND observation_id = NEW.observation_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_evidence is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER claim_conflicts_append_only_update BEFORE UPDATE ON claim_conflicts
    BEGIN SELECT RAISE(ABORT, 'claim_conflicts is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_conflicts_append_only_delete BEFORE DELETE ON claim_conflicts
    BEGIN SELECT RAISE(ABORT, 'claim_conflicts is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_conflicts_append_only_insert_collision BEFORE INSERT ON claim_conflicts
    WHEN EXISTS (
        SELECT 1 FROM claim_conflicts
        WHERE id = NEW.id OR (
            relation = NEW.relation
            AND left_revision_id = NEW.left_revision_id
            AND right_revision_id = NEW.right_revision_id
        )
    )
    BEGIN SELECT RAISE(ABORT, 'claim_conflicts is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER verification_events_append_only_update BEFORE UPDATE ON verification_events
    BEGIN SELECT RAISE(ABORT, 'verification_events is append-only: updates are not allowed'); END;
    CREATE TRIGGER verification_events_append_only_delete BEFORE DELETE ON verification_events
    BEGIN SELECT RAISE(ABORT, 'verification_events is append-only: deletes are not allowed'); END;
    CREATE TRIGGER verification_events_append_only_insert_collision BEFORE INSERT ON verification_events
    WHEN EXISTS (SELECT 1 FROM verification_events WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'verification_events is append-only: key collisions cannot replace rows'); END;

    -- Claims stay mutable only for lifecycle state and the current pointer.
    CREATE TRIGGER claims_semantic_freeze BEFORE UPDATE ON claims
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.subject IS NOT OLD.subject
      OR NEW.predicate IS NOT OLD.predicate
      OR NEW.scope IS NOT OLD.scope
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'claims semantic identity is immutable'); END;

    CREATE TRIGGER claims_pointer_clear_guard BEFORE UPDATE OF current_revision_id ON claims
    WHEN NEW.current_revision_id IS NULL AND OLD.current_revision_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'claims current revision pointer cannot be cleared'); END;

    -- One identity string resolves to exactly one project (R35): an alias may
    -- not shadow another project's canonical identity and vice versa.
    CREATE TRIGGER project_aliases_namespace_guard BEFORE INSERT ON project_aliases
    WHEN EXISTS (
        SELECT 1 FROM projects
        WHERE canonical_identity = NEW.alias_identity AND id <> NEW.project_id
    )
    BEGIN SELECT RAISE(ABORT, 'project alias collides with another project canonical identity'); END;

    CREATE TRIGGER projects_namespace_guard BEFORE INSERT ON projects
    WHEN EXISTS (
        SELECT 1 FROM project_aliases
        WHERE alias_identity = NEW.canonical_identity
          AND (NEW.id IS NULL OR project_id <> NEW.id)
    )
    BEGIN SELECT RAISE(ABORT, 'project canonical identity collides with an existing alias'); END;

    -- The UNIQUE constraint only covers other canonical identities; a direct
    -- SQL UPDATE could still adopt an identity that is another project's alias.
    CREATE TRIGGER projects_namespace_guard_update BEFORE UPDATE OF canonical_identity ON projects
    WHEN EXISTS (
        SELECT 1 FROM project_aliases
        WHERE alias_identity = NEW.canonical_identity
          AND project_id <> NEW.id
    )
    BEGIN SELECT RAISE(ABORT, 'project canonical identity collides with an existing alias'); END;

    -- Numeric FKs prove existence, not common ownership: evidence, conflict
    -- endpoints, and verification observations must share one project (KTD36).
    -- IS NOT is deliberate: a missing endpoint makes a subselect NULL and the
    -- guard fails closed before the FK error would.
    CREATE TRIGGER claim_evidence_same_project_guard BEFORE INSERT ON claim_evidence
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT (
        SELECT episodes.project_id FROM observations
        JOIN source_spans ON source_spans.id = observations.source_span_id
        JOIN episodes ON episodes.id = source_spans.episode_id
        WHERE observations.id = NEW.observation_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_evidence endpoints must belong to the same project'); END;

    CREATE TRIGGER claim_conflicts_distinct_claims_guard BEFORE INSERT ON claim_conflicts
    WHEN (SELECT claim_id FROM claim_revisions WHERE id = NEW.left_revision_id)
      IS (SELECT claim_id FROM claim_revisions WHERE id = NEW.right_revision_id)
    BEGIN SELECT RAISE(ABORT, 'claim_conflicts endpoints must reference distinct claims'); END;

    CREATE TRIGGER claim_conflicts_same_project_guard BEFORE INSERT ON claim_conflicts
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.left_revision_id
    ) IS NOT (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.right_revision_id
    )
    BEGIN SELECT RAISE(ABORT, 'claim_conflicts endpoints must belong to the same project'); END;

    -- Supersession is directional: recording both A→B and B→A would make the
    -- pair mutually superseding, which no reader of the chain can interpret.
    CREATE TRIGGER claim_conflicts_supersedes_cycle_guard BEFORE INSERT ON claim_conflicts
    WHEN NEW.relation = 'supersedes' AND EXISTS (
        SELECT 1 FROM claim_conflicts
        WHERE relation = 'supersedes'
          AND left_revision_id = NEW.right_revision_id
          AND right_revision_id = NEW.left_revision_id
    )
    BEGIN SELECT RAISE(ABORT, 'supersedes conflict already recorded in the opposite direction'); END;

    CREATE TRIGGER verification_events_same_project_guard BEFORE INSERT ON verification_events
    WHEN NEW.observation_id IS NOT NULL AND (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT (
        SELECT episodes.project_id FROM observations
        JOIN source_spans ON source_spans.id = observations.source_span_id
        JOIN episodes ON episodes.id = source_spans.episode_id
        WHERE observations.id = NEW.observation_id
    )
    BEGIN SELECT RAISE(ABORT, 'verification_events observation must belong to the revision project'); END;
    `);
}

/**
 */
export function assertClaimsSchemaForeignKeys(db: Database): void {
    const violations: string[] = [];
    for (const table of CLAIMS_AND_EVIDENCE_TABLES) {
        const rows = db.prepare(`PRAGMA foreign_key_check(${table})`).all() as unknown[];
        if (rows.length > 0) violations.push(`${table}: ${rows.length} violation(s)`);
    }
    if (violations.length > 0) {
        throw new Error(`v82 foreign_key_check failed: ${violations.join("; ")}`);
    }
}
