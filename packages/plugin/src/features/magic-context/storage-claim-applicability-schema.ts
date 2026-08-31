/**
 * Migration v85 creates bitemporal claim-applicability, Git-anchor, and source-trust DDL.
 *
 * Runtime imports must use explicit `.ts` extensions because the Node SQLite smoke test imports this module under Node's type-stripping loader.
 * The SQLite smoke test at `packages/plugin/scripts/smoke-node-sqlite.ts` imports this module directly.
 *
 * Migration v85 creates every object here; `initializeDatabase()` creates none.
 *
 * Bitemporal state is an append-only assertion ledger, not mutable columns on `claims` or `claim_revisions`.
 * Each assertion belongs to exactly one immutable stream; a gapless sequence plus unique predecessor consumption forms one chain per stream.
 * `recorded_until` and `known_until` are derived at read time by the interval view; no end values are stored.
 * A missing assertion means `unknown`.
 * A stored baseline assertion also uses `unknown`.
 *
 * Pre-v85 revisions receive seeded `unknown` baselines.
 */

import type { Database } from "../../shared/sqlite";

export const CLAIM_APPLICABILITY_TABLES = [
    "git_anchors",
    "git_anchor_representations",
    "claim_revision_applicability_streams",
    "claim_revision_applicability_assertions",
    "claim_revision_applicability_paths",
    "claim_revision_applicability_symbols",
] as const;

/** `SOURCE_TRUST_CLASSES` classifies immutable observation origins. */
export const SOURCE_TRUST_CLASSES = [
    "explicit_user",
    "trusted_local_code",
    "trusted_tool_result",
    "untrusted_repo_text",
    "untrusted_web",
    "model_inference",
] as const;
export type SourceTrustClass = (typeof SOURCE_TRUST_CLASSES)[number];

/** `historical` persists invalidated intervals; `invalidated` is not a state.
 * */
export const APPLICABILITY_STATES = [
    "current",
    "historical",
    "dirty_tree_uncertain",
    "dependency_changed",
    "wrong_branch",
    "wrong_environment",
    "unknown",
] as const;
export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];

/* */
export const GIT_ANCHOR_REPRESENTATION_KINDS = [
    "commit_oid",
    "tree_oid",
    "patch_id",
    "path",
    "symbol",
    "version",
] as const;
export type GitAnchorRepresentationKind = (typeof GIT_ANCHOR_REPRESENTATION_KINDS)[number];

/**
 * `GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS` defines the tuple used by the DDL UNIQUE constraint, collision trigger, and application pre-check.
 * `storage-git-anchors.ts` must use the same tuple as the DDL constraint and collision trigger.
 * Divergent tuple spellings can make the `storage-git-anchors.ts` pre-check skip an insert that the trigger aborts.
 */
export const GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS = [
    "anchor_id",
    "kind",
    "object_format",
    "protocol",
    "namespace",
    "value",
] as const;

/** `APPLICABILITY_OWNER_KINDS` distinguishes source lineage from evaluation lineage. */
export const APPLICABILITY_OWNER_KINDS = ["source", "evaluation"] as const;
export type ApplicabilityOwnerKind = (typeof APPLICABILITY_OWNER_KINDS)[number];

/* */
export const APPLICABILITY_PATHS_STATES = ["unknown", "known"] as const;
export type ApplicabilityPathsState = (typeof APPLICABILITY_PATHS_STATES)[number];

/* */
export const APPLICABILITY_PATH_KINDS = ["exact", "glob"] as const;
export type ApplicabilityPathKind = (typeof APPLICABILITY_PATH_KINDS)[number];

const sqlList = (values: readonly string[]): string =>
    values.map((value) => `'${value}'`).join(", ");

const representationIdentityMatch = GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS.map(
    (column) => `${column} = NEW.${column}`,
).join(" AND ");

/**
 * The ALTER TABLE operation preserves existing v82 row bytes.
 * The column gives existing observations the `model_inference` default.
 * Fresh and upgraded databases run v82's CREATE TABLE before this ALTER, so both receive the same default.
 */
export function addObservationSourceTrustClassColumn(db: Database): void {
    // pi-lens-ignore: sql-injection
    db.exec(`
        ALTER TABLE observations ADD COLUMN source_trust_class TEXT NOT NULL
            DEFAULT 'model_inference'
            CHECK (source_trust_class IN (${sqlList(SOURCE_TRUST_CLASSES)}))
    `);
}

export function observationSourceTrustClassColumnExists(db: Database): boolean {
    const columns = db.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "source_trust_class");
}

/**
 * */
export function createClaimApplicabilitySchema(db: Database): void {
    // pi-lens-ignore: sql-injection
    db.exec(`
    -- One logical project-scoped anchor identity (KTD5). Deliberately no FK
    -- to the derived, evictable git_commits index.
    CREATE TABLE git_anchors (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_git_anchors_project ON git_anchors(project_id);

    -- Append-only typed representations for one anchor. Full commit OIDs are
    -- unique per (project, object format, protocol); tree/patch/path/symbol/
    -- version representations stay non-unique across anchors (R8).
    CREATE TABLE git_anchor_representations (
        id INTEGER PRIMARY KEY,
        anchor_id INTEGER NOT NULL REFERENCES git_anchors(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN (${sqlList(GIT_ANCHOR_REPRESENTATION_KINDS)})),
        -- 'sha1' | 'sha256' for oid kinds; '' otherwise.
        object_format TEXT NOT NULL DEFAULT '' CHECK (
            (kind IN ('commit_oid', 'tree_oid') AND object_format IN ('sha1', 'sha256'))
            OR (kind NOT IN ('commit_oid', 'tree_oid') AND object_format = '')
        ),
        protocol TEXT NOT NULL CHECK (length(protocol) > 0),
        -- Namespaced schema/config version representations only; '' otherwise.
        namespace TEXT NOT NULL DEFAULT '' CHECK (
            kind = 'version' OR namespace = ''
        ),
        value TEXT NOT NULL CHECK (length(value) > 0),
        created_at INTEGER NOT NULL,
        UNIQUE (${GIT_ANCHOR_REPRESENTATION_IDENTITY_COLUMNS.join(", ")})
    );
    CREATE UNIQUE INDEX idx_git_anchor_representations_commit_unique
        ON git_anchor_representations(project_id, object_format, protocol, value)
        WHERE kind = 'commit_oid';
    CREATE INDEX idx_git_anchor_representations_lookup
        ON git_anchor_representations(project_id, kind, value);
    CREATE INDEX idx_git_anchor_representations_anchor
        ON git_anchor_representations(anchor_id);

    -- First-class immutable stream parents (KTD3): stable source or
    -- evaluation lineage per exact revision. Evaluation streams must carry a
    -- checkout/environment context fingerprint so one worktree can never
    -- publish a global state (R5).
    CREATE TABLE claim_revision_applicability_streams (
        id INTEGER PRIMARY KEY,
        revision_id INTEGER NOT NULL REFERENCES claim_revisions(id) ON DELETE RESTRICT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN (${sqlList(APPLICABILITY_OWNER_KINDS)})),
        stream_key TEXT NOT NULL CHECK (length(stream_key) > 0),
        key_protocol TEXT NOT NULL CHECK (length(key_protocol) > 0),
        source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
        -- Exact opaque branch tag; NULL means unspecified (R5).
        branch_selector TEXT CHECK (branch_selector IS NULL OR length(branch_selector) > 0),
        context_fingerprint TEXT CHECK (
            context_fingerprint IS NULL OR length(context_fingerprint) > 0
        ),
        created_at INTEGER NOT NULL,
        UNIQUE (revision_id, stream_key),
        CHECK (owner_kind <> 'evaluation' OR context_fingerprint IS NOT NULL)
    );
    -- UNIQUE (revision_id, stream_key) already provides the revision_id-
    -- leading index, so revision lookups need no separate index.
    CREATE INDEX idx_claim_applicability_streams_project
        ON claim_revision_applicability_streams(project_id);

    -- Bitemporal assertions within one stream (KTD2). Valid time is half-open
    -- [valid_from_anchor, valid_until_anchor): an absent interval means valid
    -- time is unknown, and a missing end means "not retired by this ledger"
    -- (R3). recorded_until / known_until are derived by the interval view.
    CREATE TABLE claim_revision_applicability_assertions (
        id INTEGER PRIMARY KEY,
        stream_id INTEGER NOT NULL
            REFERENCES claim_revision_applicability_streams(id) ON DELETE RESTRICT,
        seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 1),
        predecessor_id INTEGER
            REFERENCES claim_revision_applicability_assertions(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK (state IN (${sqlList(APPLICABILITY_STATES)})),
        valid_from_anchor_id INTEGER REFERENCES git_anchors(id) ON DELETE RESTRICT,
        valid_until_anchor_id INTEGER REFERENCES git_anchors(id) ON DELETE RESTRICT,
        evaluated_against_anchor_id INTEGER REFERENCES git_anchors(id) ON DELETE RESTRICT,
        known_from INTEGER CHECK (
            known_from IS NULL OR (typeof(known_from) = 'integer' AND known_from > 0)
        ),
        recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer' AND recorded_at > 0),
        -- Path knowledge disposition (R6, KTD4): 'unknown' forbids child path
        -- rows; 'known' with zero child rows means file-independent
        -- (known-empty).
        paths_state TEXT NOT NULL CHECK (paths_state IN (${sqlList(APPLICABILITY_PATHS_STATES)})),
        dependency_fingerprint TEXT CHECK (
            dependency_fingerprint IS NULL OR length(dependency_fingerprint) > 0
        ),
        dependency_protocol TEXT CHECK (
            dependency_protocol IS NULL OR length(dependency_protocol) > 0
        ),
        verifier_spec TEXT CHECK (verifier_spec IS NULL OR length(verifier_spec) > 0),
        UNIQUE (stream_id, seq),
        -- A closed interval needs its opening anchor (R3).
        CHECK (valid_until_anchor_id IS NULL OR valid_from_anchor_id IS NOT NULL),
        -- Dependency fingerprints carry their canonicalization version (R6).
        CHECK (dependency_fingerprint IS NULL OR dependency_protocol IS NOT NULL),
        -- Exactly the first assertion of a stream has no predecessor.
        CHECK ((seq = 1) = (predecessor_id IS NULL))
    );
    -- Unique predecessor consumption: no forked heads within a stream.
    CREATE UNIQUE INDEX idx_claim_applicability_assertions_predecessor
        ON claim_revision_applicability_assertions(predecessor_id)
        WHERE predecessor_id IS NOT NULL;
    -- Stream-max knowledge-time lookups (the time-guard trigger and the
    -- typed-layer maxStreamKnownFrom) resolve via an index max instead of
    -- scanning every assertion in the stream on each append.
    CREATE INDEX idx_claim_applicability_assertions_known_from
        ON claim_revision_applicability_assertions(stream_id, known_from);

    -- Affected path selectors (R6, KTD4). WITHOUT ROWID closes the
    -- INSERT OR REPLACE bypass (the claim_evidence precedent).
    CREATE TABLE claim_revision_applicability_paths (
        assertion_id INTEGER NOT NULL
            REFERENCES claim_revision_applicability_assertions(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN (${sqlList(APPLICABILITY_PATH_KINDS)})),
        value TEXT NOT NULL CHECK (length(value) > 0),
        PRIMARY KEY (assertion_id, kind, value)
    ) WITHOUT ROWID;

    -- Symbol/API selectors with an explicit canonicalization protocol (R6).
    CREATE TABLE claim_revision_applicability_symbols (
        assertion_id INTEGER NOT NULL
            REFERENCES claim_revision_applicability_assertions(id) ON DELETE RESTRICT,
        protocol TEXT NOT NULL CHECK (length(protocol) > 0),
        value TEXT NOT NULL CHECK (length(value) > 0),
        PRIMARY KEY (assertion_id, protocol, value)
    ) WITHOUT ROWID;

    -- Read shape with derived interval ends (KTD2): partitioned only by
    -- stream and sequence. recorded_until always derives from the immediate
    -- successor. known_until derives from the nearest LATER same-stream
    -- assertion carrying a non-NULL knowledge time — not the immediate
    -- successor verbatim — so a NULL known_from gap cannot leave a superseded
    -- assertion reading as knowledge-open once a later assertion closes it
    -- (two open knowledge intervals in one stream would let an as-of-
    -- knowledge-time query return a stale state as current). The write
    -- guards keep known_from non-regressing, so MIN() is that nearest value.
    CREATE VIEW claim_revision_applicability_intervals AS
    SELECT
        assertion.id AS assertion_id,
        stream.revision_id AS revision_id,
        assertion.stream_id AS stream_id,
        assertion.seq AS seq,
        assertion.state AS state,
        assertion.valid_from_anchor_id AS valid_from_anchor_id,
        assertion.valid_until_anchor_id AS valid_until_anchor_id,
        assertion.evaluated_against_anchor_id AS evaluated_against_anchor_id,
        assertion.known_from AS known_from,
        (
            SELECT MIN(later.known_from)
            FROM claim_revision_applicability_assertions AS later
            WHERE later.stream_id = assertion.stream_id
              AND later.seq > assertion.seq
              AND later.known_from IS NOT NULL
        ) AS known_until,
        assertion.recorded_at AS recorded_at,
        successor.recorded_at AS recorded_until,
        assertion.paths_state AS paths_state
    FROM claim_revision_applicability_assertions AS assertion
    JOIN claim_revision_applicability_streams AS stream
        ON stream.id = assertion.stream_id
    LEFT JOIN claim_revision_applicability_assertions AS successor
        ON successor.stream_id = assertion.stream_id
        AND successor.seq = assertion.seq + 1;
    `);

    // Interpolation is a compile-time const allowlist, not caller input.
    // pi-lens-ignore: sql-injection
    db.exec(`
    CREATE TRIGGER git_anchors_append_only_update BEFORE UPDATE ON git_anchors
    BEGIN SELECT RAISE(ABORT, 'git_anchors is append-only: updates are not allowed'); END;
    CREATE TRIGGER git_anchors_append_only_delete BEFORE DELETE ON git_anchors
    BEGIN SELECT RAISE(ABORT, 'git_anchors is append-only: deletes are not allowed'); END;
    CREATE TRIGGER git_anchors_append_only_insert_collision BEFORE INSERT ON git_anchors
    WHEN EXISTS (SELECT 1 FROM git_anchors WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'git_anchors is append-only: key collisions cannot replace rows'); END;

    CREATE TRIGGER git_anchor_representations_append_only_update
    BEFORE UPDATE ON git_anchor_representations
    BEGIN SELECT RAISE(ABORT, 'git_anchor_representations is append-only: updates are not allowed'); END;
    CREATE TRIGGER git_anchor_representations_append_only_delete
    BEFORE DELETE ON git_anchor_representations
    BEGIN SELECT RAISE(ABORT, 'git_anchor_representations is append-only: deletes are not allowed'); END;
    CREATE TRIGGER git_anchor_representations_append_only_insert_collision
    BEFORE INSERT ON git_anchor_representations
    -- Covers every uniqueness on the table: the rowid, the full identity
    -- UNIQUE, and the partial commit-OID unique index — so an INSERT OR
    -- REPLACE colliding on any of them cannot silently delete the existing
    -- row (REPLACE's implicit delete skips the BEFORE DELETE trigger while
    -- recursive_triggers is off).
    WHEN EXISTS (
        SELECT 1 FROM git_anchor_representations
        WHERE id = NEW.id OR (${representationIdentityMatch})
           OR (NEW.kind = 'commit_oid' AND kind = 'commit_oid'
               AND project_id = NEW.project_id
               AND object_format = NEW.object_format
               AND protocol = NEW.protocol
               AND value = NEW.value)
    )
    BEGIN SELECT RAISE(ABORT, 'git_anchor_representations is append-only: key collisions cannot replace rows'); END;

    -- Representation project must be the anchor's own project (KTD9).
    -- IS NOT is deliberate: a missing anchor makes the subselect NULL and the
    -- guard fails closed before the FK error would.
    CREATE TRIGGER git_anchor_representations_project_guard
    BEFORE INSERT ON git_anchor_representations
    WHEN (SELECT project_id FROM git_anchors WHERE id = NEW.anchor_id) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'git_anchor_representations project must match the anchor project'); END;

    CREATE TRIGGER claim_applicability_streams_append_only_update
    BEFORE UPDATE ON claim_revision_applicability_streams
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_streams is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_applicability_streams_append_only_delete
    BEFORE DELETE ON claim_revision_applicability_streams
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_streams is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_applicability_streams_append_only_insert_collision
    BEFORE INSERT ON claim_revision_applicability_streams
    WHEN EXISTS (
        SELECT 1 FROM claim_revision_applicability_streams
        WHERE id = NEW.id OR (revision_id = NEW.revision_id AND stream_key = NEW.stream_key)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_streams is append-only: key collisions cannot replace rows'); END;

    -- Stream lineage shares the revision's numeric project (KTD9).
    CREATE TRIGGER claim_applicability_streams_project_guard
    BEFORE INSERT ON claim_revision_applicability_streams
    WHEN (
        SELECT claims.project_id FROM claim_revisions
        JOIN claims ON claims.id = claim_revisions.claim_id
        WHERE claim_revisions.id = NEW.revision_id
    ) IS NOT NEW.project_id
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_streams project must match the revision project'); END;

    CREATE TRIGGER claim_applicability_assertions_append_only_update
    BEFORE UPDATE ON claim_revision_applicability_assertions
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_assertions is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_applicability_assertions_append_only_delete
    BEFORE DELETE ON claim_revision_applicability_assertions
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_assertions is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_applicability_assertions_append_only_insert_collision
    BEFORE INSERT ON claim_revision_applicability_assertions
    WHEN EXISTS (
        SELECT 1 FROM claim_revision_applicability_assertions
        WHERE id = NEW.id OR (stream_id = NEW.stream_id AND seq = NEW.seq)
           OR (NEW.predecessor_id IS NOT NULL AND predecessor_id = NEW.predecessor_id)
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_assertions is append-only: key collisions cannot replace rows'); END;

    -- The predecessor must be the head of the SAME stream at exactly the
    -- previous sequence: one gapless chain, no cross-stream closure (KTD2).
    CREATE TRIGGER claim_applicability_assertions_chain_guard
    BEFORE INSERT ON claim_revision_applicability_assertions
    WHEN NEW.predecessor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM claim_revision_applicability_assertions predecessor
        WHERE predecessor.id = NEW.predecessor_id
          AND predecessor.stream_id = NEW.stream_id
          AND predecessor.seq = NEW.seq - 1
    )
    BEGIN SELECT RAISE(ABORT, 'applicability assertion predecessor must be the same-stream head at the previous sequence'); END;

    -- A first assertion may not skip sequence numbers.
    CREATE TRIGGER claim_applicability_assertions_first_seq_guard
    BEFORE INSERT ON claim_revision_applicability_assertions
    WHEN NEW.predecessor_id IS NULL AND EXISTS (
        SELECT 1 FROM claim_revision_applicability_assertions
        WHERE stream_id = NEW.stream_id
    )
    BEGIN SELECT RAISE(ABORT, 'applicability assertion without a predecessor must open its stream'); END;

    -- Recorded time never regresses behind the predecessor, and knowledge
    -- time never regresses behind ANY earlier assertion in the stream: a
    -- NULL known_from gap must not reopen the door to an older knowledge
    -- time (R2). A NULL known_from stays allowed; the interval view closes
    -- earlier assertions with the nearest later non-NULL knowledge time.
    CREATE TRIGGER claim_applicability_assertions_time_guard
    BEFORE INSERT ON claim_revision_applicability_assertions
    WHEN NEW.predecessor_id IS NOT NULL AND (
        NEW.recorded_at < (
            SELECT recorded_at FROM claim_revision_applicability_assertions
            WHERE id = NEW.predecessor_id
        )
        OR (
            NEW.known_from IS NOT NULL
            AND NEW.known_from < (
                SELECT MAX(known_from) FROM claim_revision_applicability_assertions
                WHERE stream_id = NEW.stream_id
            )
        )
    )
    BEGIN SELECT RAISE(ABORT, 'applicability assertion recorded/knowledge time cannot regress within its stream'); END;

    -- Every referenced anchor shares the stream's numeric project (KTD9).
    CREATE TRIGGER claim_applicability_assertions_anchor_project_guard
    BEFORE INSERT ON claim_revision_applicability_assertions
    WHEN (
        NEW.valid_from_anchor_id IS NOT NULL AND (
            SELECT project_id FROM git_anchors WHERE id = NEW.valid_from_anchor_id
        ) IS NOT (
            SELECT project_id FROM claim_revision_applicability_streams WHERE id = NEW.stream_id
        )
    ) OR (
        NEW.valid_until_anchor_id IS NOT NULL AND (
            SELECT project_id FROM git_anchors WHERE id = NEW.valid_until_anchor_id
        ) IS NOT (
            SELECT project_id FROM claim_revision_applicability_streams WHERE id = NEW.stream_id
        )
    ) OR (
        NEW.evaluated_against_anchor_id IS NOT NULL AND (
            SELECT project_id FROM git_anchors WHERE id = NEW.evaluated_against_anchor_id
        ) IS NOT (
            SELECT project_id FROM claim_revision_applicability_streams WHERE id = NEW.stream_id
        )
    )
    BEGIN SELECT RAISE(ABORT, 'applicability assertion anchors must belong to the stream project'); END;

    CREATE TRIGGER claim_applicability_paths_append_only_update
    BEFORE UPDATE ON claim_revision_applicability_paths
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_paths is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_applicability_paths_append_only_delete
    BEFORE DELETE ON claim_revision_applicability_paths
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_paths is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_applicability_paths_append_only_insert_collision
    BEFORE INSERT ON claim_revision_applicability_paths
    WHEN EXISTS (
        SELECT 1 FROM claim_revision_applicability_paths
        WHERE assertion_id = NEW.assertion_id AND kind = NEW.kind AND value = NEW.value
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_paths is append-only: key collisions cannot replace rows'); END;

    -- Path rows require a parent that declared known path state (KTD4).
    CREATE TRIGGER claim_applicability_paths_known_state_guard
    BEFORE INSERT ON claim_revision_applicability_paths
    WHEN (
        SELECT paths_state FROM claim_revision_applicability_assertions
        WHERE id = NEW.assertion_id
    ) IS NOT 'known'
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_paths require a parent assertion with known path state'); END;

    CREATE TRIGGER claim_applicability_symbols_append_only_update
    BEFORE UPDATE ON claim_revision_applicability_symbols
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_symbols is append-only: updates are not allowed'); END;
    CREATE TRIGGER claim_applicability_symbols_append_only_delete
    BEFORE DELETE ON claim_revision_applicability_symbols
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_symbols is append-only: deletes are not allowed'); END;
    CREATE TRIGGER claim_applicability_symbols_append_only_insert_collision
    BEFORE INSERT ON claim_revision_applicability_symbols
    WHEN EXISTS (
        SELECT 1 FROM claim_revision_applicability_symbols
        WHERE assertion_id = NEW.assertion_id AND protocol = NEW.protocol AND value = NEW.value
    )
    BEGIN SELECT RAISE(ABORT, 'claim_revision_applicability_symbols is append-only: key collisions cannot replace rows'); END;
    `);
}

/** Supported writers use a versioned, deterministic stream-key protocol. */
export const APPLICABILITY_STREAM_KEY_PROTOCOL = "mc-applicability-stream-key-v1";

/** The migration seeds this stream key as the writer-default baseline. */
export const APPLICABILITY_BASELINE_STREAM_KEY = "baseline:v1";

/**
 * The migration seeds an `unknown` baseline assertion for each claim revision without an applicability stream.
 * The migration leaves revision bytes unchanged.
 * Knowledge time uses the revision creation time only when it is a positive integer.
 */
export function seedApplicabilityBaselines(db: Database, nowMs: number): void {
    db.prepare(
        `INSERT INTO claim_revision_applicability_streams
            (revision_id, project_id, owner_kind, stream_key, key_protocol,
             source_digest, branch_selector, context_fingerprint, created_at)
         SELECT claim_revisions.id, claims.project_id, 'source', ?, ?,
                claim_revisions.content_sha256, NULL, NULL, ?
           FROM claim_revisions
           JOIN claims ON claims.id = claim_revisions.claim_id
          WHERE NOT EXISTS (
              SELECT 1 FROM claim_revision_applicability_streams streams
              WHERE streams.revision_id = claim_revisions.id
          )`,
    ).run(APPLICABILITY_BASELINE_STREAM_KEY, APPLICABILITY_STREAM_KEY_PROTOCOL, nowMs);
    db.prepare(
        `INSERT INTO claim_revision_applicability_assertions
            (stream_id, seq, predecessor_id, state, known_from, recorded_at, paths_state)
         SELECT streams.id, 1, NULL, 'unknown',
                CASE
                    WHEN typeof(claim_revisions.created_at) = 'integer'
                         AND claim_revisions.created_at > 0
                    THEN claim_revisions.created_at
                    ELSE NULL
                END,
                ?, 'unknown'
           FROM claim_revision_applicability_streams streams
           JOIN claim_revisions ON claim_revisions.id = streams.revision_id
          WHERE streams.stream_key = ?
            AND NOT EXISTS (
                SELECT 1 FROM claim_revision_applicability_assertions assertions
                WHERE assertions.stream_id = streams.id
            )`,
    ).run(nowMs, APPLICABILITY_BASELINE_STREAM_KEY);
}

/**
 * The migration validates foreign keys only for newly created tables.
 */
export function assertClaimApplicabilitySchemaForeignKeys(db: Database): void {
    const violations: string[] = [];
    for (const table of CLAIM_APPLICABILITY_TABLES) {
        const rows = db.prepare(`PRAGMA foreign_key_check(${table})`).all() as unknown[];
        if (rows.length > 0) violations.push(`${table}: ${rows.length} violation(s)`);
    }
    if (violations.length > 0) {
        throw new Error(`v85 foreign_key_check failed: ${violations.join("; ")}`);
    }
}

/**
 * The v85 replay guard checks the required non-table objects.
 */
export function missingClaimApplicabilitySchemaObjects(db: Database): string[] {
    const required: Array<[type: string, name: string]> = [
        ["view", "claim_revision_applicability_intervals"],
        ["index", "idx_git_anchors_project"],
        ["index", "idx_git_anchor_representations_commit_unique"],
        ["index", "idx_git_anchor_representations_lookup"],
        ["index", "idx_git_anchor_representations_anchor"],
        ["index", "idx_claim_applicability_streams_project"],
        ["index", "idx_claim_applicability_assertions_predecessor"],
        ["index", "idx_claim_applicability_assertions_known_from"],
        ["trigger", "git_anchors_append_only_update"],
        ["trigger", "git_anchors_append_only_delete"],
        ["trigger", "git_anchors_append_only_insert_collision"],
        ["trigger", "git_anchor_representations_append_only_update"],
        ["trigger", "git_anchor_representations_append_only_delete"],
        ["trigger", "git_anchor_representations_append_only_insert_collision"],
        ["trigger", "git_anchor_representations_project_guard"],
        ["trigger", "claim_applicability_streams_append_only_update"],
        ["trigger", "claim_applicability_streams_append_only_delete"],
        ["trigger", "claim_applicability_streams_append_only_insert_collision"],
        ["trigger", "claim_applicability_streams_project_guard"],
        ["trigger", "claim_applicability_assertions_append_only_update"],
        ["trigger", "claim_applicability_assertions_append_only_delete"],
        ["trigger", "claim_applicability_assertions_append_only_insert_collision"],
        ["trigger", "claim_applicability_assertions_chain_guard"],
        ["trigger", "claim_applicability_assertions_first_seq_guard"],
        ["trigger", "claim_applicability_assertions_time_guard"],
        ["trigger", "claim_applicability_assertions_anchor_project_guard"],
        ["trigger", "claim_applicability_paths_append_only_update"],
        ["trigger", "claim_applicability_paths_append_only_delete"],
        ["trigger", "claim_applicability_paths_append_only_insert_collision"],
        ["trigger", "claim_applicability_paths_known_state_guard"],
        ["trigger", "claim_applicability_symbols_append_only_update"],
        ["trigger", "claim_applicability_symbols_append_only_delete"],
        ["trigger", "claim_applicability_symbols_append_only_insert_collision"],
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

export function dropClaimApplicabilityObjectsForTests(db: Database): void {
    db.exec(`
        DROP VIEW IF EXISTS claim_revision_applicability_intervals;
        DROP TABLE IF EXISTS claim_revision_applicability_symbols;
        DROP TABLE IF EXISTS claim_revision_applicability_paths;
        DROP TABLE IF EXISTS claim_revision_applicability_assertions;
        DROP TABLE IF EXISTS claim_revision_applicability_streams;
        DROP TABLE IF EXISTS git_anchor_representations;
        DROP TABLE IF EXISTS git_anchors;
    `);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 85").run();
}
