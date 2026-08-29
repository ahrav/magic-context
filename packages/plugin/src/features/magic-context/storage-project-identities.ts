/**
 * Shared project-identity discovery and terminal-chain resolution.
 *
 * One algorithm serves three consumers so they cannot drift: the v82 migration
 * seeds `projects`/`project_aliases` from it, workspace expansion resolves
 * historical aliases through it, and runtime identity merges flatten both the
 * legacy `v22_identity_rekey_map` and the numeric registry through it.
 *
 * Dependency-light on purpose: type-only imports keep this module loadable by
 * the Node SQLite smoke script, whose loader cannot resolve extensionless
 * runtime imports.
 */

import type { Database } from "../../shared/sqlite";

/** Non-derived columns that carry project identity strings across legacy tables. */
const IDENTITY_COLUMNS: ReadonlySet<string> = new Set(["project_path", "project_identity"]);

const DERIVED_TABLE_SUFFIXES = [
    "_fts",
    "_fts_data",
    "_fts_idx",
    "_fts_content",
    "_fts_docsize",
    "_fts_config",
];

export interface IdentityTableInfo {
    name: string;
    identityColumn: string;
    derived: boolean;
}

export function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

export function tableExists(db: Database, tableName: string): boolean {
    return Boolean(
        db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .get(tableName),
    );
}

function isDerivedTable(tableName: string, sql: string | null): boolean {
    return (
        sql?.toUpperCase().includes("VIRTUAL TABLE") === true ||
        DERIVED_TABLE_SUFFIXES.some((suffix) => tableName.endsWith(suffix))
    );
}

/** Every table carrying a project identity column, flagged when search-derived. */
export function discoverIdentityTables(db: Database): IdentityTableInfo[] {
    const rows = db
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name?: unknown; sql?: unknown }>;
    const tables: IdentityTableInfo[] = [];
    for (const row of rows) {
        if (typeof row.name !== "string") continue;
        const columns = db
            .prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`)
            .all() as Array<{ name?: unknown }>;
        const identityColumn = columns.find(
            (column) => typeof column.name === "string" && IDENTITY_COLUMNS.has(column.name),
        )?.name;
        if (typeof identityColumn !== "string") continue;
        tables.push({
            name: row.name,
            identityColumn,
            derived: isDerivedTable(row.name, typeof row.sql === "string" ? row.sql : null),
        });
    }
    return tables;
}

/**
 * Canonical identities are `git:<root-commit>` or `dir:<hash>`. Raw filesystem
 * paths are not canonical and stay in the v22 repair path until rekeyed.
 */
export function isCanonicalProjectIdentity(identity: string): boolean {
    return (
        (identity.startsWith("git:") || identity.startsWith("dir:")) &&
        identity.length > "git:".length
    );
}

function boundedIdentityList(identities: Iterable<string>, limit = 5): string {
    const shown: string[] = [];
    let total = 0;
    for (const identity of identities) {
        total += 1;
        if (shown.length < limit) {
            shown.push(identity.length > 120 ? `${identity.slice(0, 120)}…` : identity);
        }
    }
    const suffix = total > limit ? ` (+${total - limit} more)` : "";
    return `${shown.join(", ")}${suffix}`;
}

/** The legacy old→new identity map, empty when the table does not exist. */
function readIdentityRekeyMap(db: Database): Map<string, string> {
    const map = new Map<string, string>();
    if (!tableExists(db, "v22_identity_rekey_map")) return map;
    const rows = db
        .prepare("SELECT old_project_path, new_project_path FROM v22_identity_rekey_map")
        .all() as Array<{ old_project_path?: unknown; new_project_path?: unknown }>;
    for (const row of rows) {
        if (typeof row.old_project_path !== "string" || typeof row.new_project_path !== "string") {
            continue;
        }
        map.set(row.old_project_path, row.new_project_path);
    }
    return map;
}

/**
 * Walk a rekey chain to its terminal identity. A cycle aborts with a bounded
 * diagnostic instead of seeding split or looping authoritative history.
 */
export function resolveTerminalIdentity(
    rekeyMap: ReadonlyMap<string, string>,
    identity: string,
): string {
    let current = identity;
    const seen = new Set<string>([current]);
    while (true) {
        const next = rekeyMap.get(current);
        if (next === undefined || next === current) return current;
        if (seen.has(next)) {
            throw new Error(
                `project identity rekey cycle detected: ${boundedIdentityList(seen)} -> ${next.slice(0, 120)}`,
            );
        }
        seen.add(next);
        current = next;
    }
}

/**
 * Append-only audit/ledger tables excluded from project seeding. Identities
 * recorded here necessarily co-existed with rows in live tables when written,
 * so they cannot be the sole legitimate holder of a live identity — but they
 * retain identities long after the live rows are gone, and they are the
 * largest tables in aged databases. Skipping them keeps the v82 startup scan
 * proportional to live state and avoids minting permanent `projects` rows
 * (aliases are ON DELETE RESTRICT) for long-dead history. Rekey-map chains
 * that reference these identities still produce aliases. Identity merges
 * still rewrite these tables; only seeding skips them.
 */
const SEED_EXCLUDED_AUDIT_TABLES: ReadonlySet<string> = new Set([
    "m0_mutation_log",
    "embedding_measurement_corpus",
    "synapse_batch_ledger",
    "retrospective_processed_windows",
    "v22_backfill_failures",
    "identity_merge_log",
]);

export interface ProjectIdentitySeed {
    /** Sorted canonical identities that become `projects` rows. */
    terminals: string[];
    /** Every identity (self and historical) mapped to its terminal. */
    aliasTargets: Map<string, string>;
    /**
     * Bounded diagnostics for identities whose rekey chain is cyclic. Cycles
     * are legacy repair-path corruption (old merge flows upserted `old→new`
     * with no acyclicity check); they skip registration instead of failing
     * the owning migration, matching the tolerant read path in
     * `collectAliasesForTargets`.
     */
    skippedCycles: string[];
}

/**
 * Collect every observed canonical identity plus every rekey-map key, resolve
 * each through the terminal-chain algorithm, and produce the seed set. Chains
 * that terminate at a non-canonical identity are left to the v22 repair path;
 * cyclic chains are skipped and reported rather than aborting the migration.
 */
export function resolveProjectIdentitySeed(db: Database): ProjectIdentitySeed {
    const rekeyMap = readIdentityRekeyMap(db);
    const observed = new Set<string>();
    for (const table of discoverIdentityTables(db)) {
        if (table.derived || SEED_EXCLUDED_AUDIT_TABLES.has(table.name)) continue;
        const rows = db
            .prepare(
                `SELECT DISTINCT ${quoteIdentifier(table.identityColumn)} AS identity FROM ${quoteIdentifier(table.name)}`,
            )
            .all() as Array<{ identity?: unknown }>;
        for (const row of rows) {
            if (typeof row.identity === "string" && isCanonicalProjectIdentity(row.identity)) {
                observed.add(row.identity);
            }
        }
    }

    const terminals = new Set<string>();
    const aliasTargets = new Map<string, string>();
    const skippedCycles = new Set<string>();
    const addAlias = (alias: string, terminal: string): void => {
        const existing = aliasTargets.get(alias);
        if (existing !== undefined && existing !== terminal) {
            throw new Error(
                `project identity alias resolves to conflicting terminals: ${boundedIdentityList([alias, existing, terminal])}`,
            );
        }
        aliasTargets.set(alias, terminal);
    };
    const register = (identity: string): void => {
        let terminal: string;
        try {
            terminal = resolveTerminalIdentity(rekeyMap, identity);
        } catch {
            if (skippedCycles.size < 5) skippedCycles.add(identity);
            return;
        }
        if (!isCanonicalProjectIdentity(terminal)) return;
        terminals.add(terminal);
        addAlias(terminal, terminal);
        addAlias(identity, terminal);
    };
    for (const identity of observed) register(identity);
    for (const oldIdentity of rekeyMap.keys()) register(oldIdentity);

    return {
        terminals: [...terminals].sort(),
        aliasTargets,
        skippedCycles: [...skippedCycles].sort(),
    };
}

/**
 * Insert the seed rows. No OR IGNORE: an unexpected collision must abort the
 * owning migration rather than silently splitting authoritative history.
 */
export function seedProjectRegistry(db: Database, seed: ProjectIdentitySeed, now: number): void {
    const insertProject = db.prepare(
        "INSERT INTO projects (canonical_identity, created_at) VALUES (?, ?)",
    );
    const insertAlias = db.prepare(
        "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
    );
    const idByTerminal = new Map<string, number>();
    for (const terminal of seed.terminals) {
        const result = insertProject.run(terminal, now) as { lastInsertRowid: number | bigint };
        idByTerminal.set(terminal, Number(result.lastInsertRowid));
    }
    for (const alias of [...seed.aliasTargets.keys()].sort()) {
        const terminal = seed.aliasTargets.get(alias) as string;
        const projectId = idByTerminal.get(terminal);
        if (projectId === undefined) {
            throw new Error(
                `project identity seed alias has no terminal project: ${boundedIdentityList([alias, terminal])}`,
            );
        }
        insertAlias.run(alias, projectId, now);
    }
}

/**
 * Resolve every historical alias of the given canonical identities, walking
 * multi-hop rekey chains and the numeric registry. Corrupt cycles skip their
 * chain instead of failing the read path.
 */
export function collectAliasesForTargets(
    db: Database,
    targets: readonly string[],
): Map<string, string> {
    const result = new Map<string, string>();
    const targetSet = new Set(targets);
    if (targetSet.size === 0) return result;

    const rekeyMap = readIdentityRekeyMap(db);
    for (const oldIdentity of rekeyMap.keys()) {
        try {
            const terminal = resolveTerminalIdentity(rekeyMap, oldIdentity);
            if (targetSet.has(terminal) && oldIdentity !== terminal) {
                result.set(oldIdentity, terminal);
            }
        } catch {
            // A cycle is repair-path corruption; reads stay usable without it.
        }
    }

    if (tableExists(db, "project_aliases")) {
        const targetList = [...targetSet];
        const placeholders = targetList.map(() => "?").join(", ");
        const rows = db
            .prepare(
                `SELECT alias.alias_identity AS alias, project.canonical_identity AS canonical
                   FROM project_aliases AS alias
                   JOIN projects AS project ON project.id = alias.project_id
                  WHERE project.canonical_identity IN (${placeholders})`,
            )
            .all(...targetList) as Array<{ alias?: unknown; canonical?: unknown }>;
        for (const row of rows) {
            if (typeof row.alias !== "string" || typeof row.canonical !== "string") continue;
            if (row.alias !== row.canonical) result.set(row.alias, row.canonical);
        }
    }
    return result;
}

/** Numeric project ID for a canonical or historical identity, when registered. */
function resolveRegistryProjectId(db: Database, identity: string): number | null {
    if (!tableExists(db, "project_aliases")) return null;
    const row = db
        .prepare("SELECT project_id FROM project_aliases WHERE alias_identity = ?")
        .get(identity) as { project_id?: unknown } | undefined;
    return typeof row?.project_id === "number" ? row.project_id : null;
}

/**
 * Keep the numeric registry atomic with a runtime identity merge. Must run
 * inside the caller's immediate write transaction so a competing authoritative
 * child insert either precedes the checked failure or follows a completed safe
 * merge. Throwing rolls back the whole merge, leaving both registries intact.
 */
export function applyIdentityMergeToProjectRegistry(
    db: Database,
    fromIdentity: string,
    toIdentity: string,
    now: number,
): void {
    if (!tableExists(db, "projects")) return;

    // Flatten chains so one-hop legacy consumers converge with the registry.
    if (tableExists(db, "v22_identity_rekey_map")) {
        db.prepare(
            "UPDATE v22_identity_rekey_map SET new_project_path = ?, rekeyed_at = ? WHERE new_project_path = ?",
        ).run(toIdentity, now, fromIdentity);
    }

    const sourceId = resolveRegistryProjectId(db, fromIdentity);
    const targetId = resolveRegistryProjectId(db, toIdentity);
    if (sourceId === null && targetId === null) return;
    if (sourceId === null) {
        db.prepare(
            "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
        ).run(fromIdentity, targetId, now);
        return;
    }
    if (sourceId === targetId) return;

    // A registered historical alias may not be merged away from its project:
    // repointing it would rename or absorb the whole project while sibling
    // rekey-map rows keep resolving to the old terminal, splitting one
    // registered history into two on any later re-seed.
    const sourceCanonical = db
        .prepare("SELECT canonical_identity AS canonical FROM projects WHERE id = ?")
        .get(sourceId) as { canonical: string };
    if (sourceCanonical.canonical !== fromIdentity) {
        throw new Error(
            `Refusing identity merge: source ${boundedIdentityList([fromIdentity])} is a historical alias of ${boundedIdentityList([sourceCanonical.canonical])}; merge the canonical identity instead.`,
        );
    }

    if (targetId === null) {
        // In-place adoption renames the source project's canonical identity on
        // the same numeric row; owned episodes/claims keep their project_id,
        // so this stays legal even when the source owns authoritative history
        // (the routine dir:<hash> → git:<sha> rekey after `git init`).
        if (!isCanonicalProjectIdentity(toIdentity)) {
            throw new Error(
                `Refusing identity merge: target ${boundedIdentityList([toIdentity])} is not a canonical git:/dir: identity, and source ${boundedIdentityList([fromIdentity])} is registered in the project registry.`,
            );
        }
        db.prepare("UPDATE projects SET canonical_identity = ? WHERE id = ?").run(
            toIdentity,
            sourceId,
        );
        db.prepare(
            "INSERT INTO project_aliases (alias_identity, project_id, created_at) VALUES (?, ?, ?)",
        ).run(toIdentity, sourceId, now);
        return;
    }

    // Only a true two-project merge would repoint children across numeric ids;
    // that is unsupported while the source owns authoritative history.
    const ownsChildren = db
        .prepare(
            `SELECT EXISTS (SELECT 1 FROM episodes WHERE project_id = ?)
                 OR EXISTS (SELECT 1 FROM claims WHERE project_id = ?) AS owns`,
        )
        .get(sourceId, sourceId) as { owns: number };
    if (ownsChildren.owns === 1) {
        throw new Error(
            `Refusing identity merge: source project ${sourceId} (${boundedIdentityList([fromIdentity])}) owns authoritative episodes or claims. Projects with claim history cannot be merged; use an explicit claim copy or move operation so each target gets derivation lineage.`,
        );
    }

    db.prepare("UPDATE project_aliases SET project_id = ? WHERE project_id = ?").run(
        targetId,
        sourceId,
    );

    // Git anchors and generation counters are append-only, project-scoped,
    // and reference projects(id) ON DELETE RESTRICT. A source that owns such
    // rows keeps its projects row as an inert tombstone: every alias now
    // resolves to the target, so no identity routes new work to the retired
    // numeric id. A source with no claim-graph rows is deleted outright.
    const ownsClaimGraphRows =
        (
            db
                .prepare(
                    `SELECT EXISTS (SELECT 1 FROM git_anchors WHERE project_id = ?)
                         OR EXISTS (SELECT 1 FROM claim_project_generations WHERE project_id = ?)
                         AS owns`,
                )
                .get(sourceId, sourceId) as { owns: number }
        ).owns === 1;
    if (!ownsClaimGraphRows) {
        db.prepare("DELETE FROM projects WHERE id = ?").run(sourceId);
    }
}
