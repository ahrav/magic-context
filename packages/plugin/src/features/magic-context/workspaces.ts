import { createHash } from "node:crypto";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { V2_MEMORY_CATEGORIES } from "./memory/constants";
import { normalizeStoredProjectPath, storedPathBelongsToIdentity } from "./project-identity";
import { collectAliasesForTargets } from "./storage-project-identities";

export interface WorkspaceIdentitySet {
    identities: string[];
    namesByIdentity: Map<string, string>;
}

export interface ExpandedWorkspaceIdentitySet {
    expandedIdentities: string[];
    canonicalIdentityByStoredPath: Map<string, string>;
}

interface WorkspaceMemberRow {
    identity: string;
    displayName: string;
}

interface WorkspaceShareCategoriesRow {
    shareCategories: string | null;
}

const VALID_SHARE_CATEGORIES = new Set<string>(V2_MEMORY_CATEGORIES);
const DEFAULT_WORKSPACE_SHARE_CATEGORIES = ["CONSTRAINTS"] as const;

function tableExists(db: Database, tableName: string): boolean {
    const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
        .get(tableName);
    return Boolean(row);
}

function columnExists(db: Database, tableName: string, columnName: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function placeholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
}

function defaultWorkspaceShareCategories(): string[] {
    return [...DEFAULT_WORKSPACE_SHARE_CATEGORIES];
}

function warnInvalidShareCategories(reason: string, raw: unknown): void {
    log(
        "[magic-context] WARN: invalid workspace share_categories; sharing no foreign memory categories",
        {
            reason,
            raw,
        },
    );
}

function normalizeShareCategories(raw: unknown): string[] {
    if (raw === null || raw === undefined) {
        return defaultWorkspaceShareCategories();
    }
    if (typeof raw !== "string") {
        warnInvalidShareCategories("not a string", raw);
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        warnInvalidShareCategories("malformed JSON", raw);
        return [];
    }
    if (!Array.isArray(parsed)) {
        warnInvalidShareCategories("not a JSON array", raw);
        return [];
    }
    const categories: string[] = [];
    for (const value of parsed) {
        if (typeof value !== "string" || !VALID_SHARE_CATEGORIES.has(value)) {
            warnInvalidShareCategories("unknown category", raw);
            return [];
        }
        if (!categories.includes(value)) categories.push(value);
    }
    return categories.sort((left, right) => left.localeCompare(right));
}

function selectWorkspaceShareCategories(
    db: Database,
    identities: readonly string[],
): string[] | null {
    const candidates = uniqueSorted(identities.filter((identity) => identity.length > 0));
    if (candidates.length === 0 || !tableExists(db, "workspace_members")) {
        return null;
    }

    const hasMembership = Boolean(
        db
            .prepare(
                `SELECT 1
                   FROM workspace_members
                  WHERE project_path IN (${placeholders(candidates)})
                  LIMIT 1`,
            )
            .get(...candidates),
    );
    if (!hasMembership) return null;

    if (!tableExists(db, "workspaces")) {
        log(
            "[magic-context] WARN: workspace member has no workspaces table; sharing no foreign memory categories",
        );
        return [];
    }
    if (!columnExists(db, "workspaces", "share_categories")) {
        return defaultWorkspaceShareCategories();
    }

    const row = db
        .prepare(
            `SELECT workspace.share_categories AS shareCategories
               FROM workspace_members AS member
               JOIN workspaces AS workspace ON workspace.id = member.workspace_id
              WHERE member.project_path IN (${placeholders(candidates)})
              ORDER BY workspace.id ASC
              LIMIT 1`,
        )
        .get(...candidates) as WorkspaceShareCategoriesRow | undefined;
    if (!row) {
        log(
            "[magic-context] WARN: workspace member has no workspace share_categories row; sharing no foreign memory categories",
        );
        return [];
    }
    return normalizeShareCategories(row.shareCategories);
}

/**
 * Resolve the categories this workspace shares from foreign member projects.
 *
 * Return null when the project is not in a workspace. For workspace members,
 * always return a list: [] means no foreign categories are shared, malformed
 * JSON falls back to [], and older rows with missing or NULL share_categories
 * default to CONSTRAINTS only.
 */
export function resolveWorkspaceShareCategories(
    db: Database,
    projectIdentity: string,
): string[] | null {
    return selectWorkspaceShareCategories(db, [projectIdentity]);
}

export function resolveWorkspaceIdentitySet(
    db: Database,
    projectIdentity: string,
): WorkspaceIdentitySet {
    if (!tableExists(db, "workspace_members")) {
        return { identities: [projectIdentity], namesByIdentity: new Map() };
    }

    const rows = db
        .prepare(
            `SELECT member.project_path AS identity, member.display_name AS displayName
               FROM workspace_members AS anchor
               JOIN workspace_members AS member ON member.workspace_id = anchor.workspace_id
              WHERE anchor.project_path = ?
              ORDER BY member.display_name ASC, member.project_path ASC`,
        )
        .all(projectIdentity) as WorkspaceMemberRow[];

    if (rows.length === 0) {
        return { identities: [projectIdentity], namesByIdentity: new Map() };
    }

    const namesByIdentity = new Map<string, string>();
    const identities: string[] = [];
    for (const row of rows) {
        if (typeof row.identity !== "string" || row.identity.length === 0) continue;
        if (identities.includes(row.identity)) continue;
        identities.push(row.identity);
        if (typeof row.displayName === "string" && row.displayName.length > 0) {
            namesByIdentity.set(row.identity, row.displayName);
        }
    }

    return identities.length > 0
        ? { identities, namesByIdentity }
        : { identities: [projectIdentity], namesByIdentity: new Map() };
}

export function expandWorkspaceIdentitySet(db: Database, identities: readonly string[]): string[] {
    return expandWorkspaceIdentitySetWithAliases(db, identities).expandedIdentities;
}

export function expandWorkspaceIdentitySetWithAliases(
    db: Database,
    identities: readonly string[],
): ExpandedWorkspaceIdentitySet {
    const canonical = uniqueSorted(identities.filter((identity) => identity.length > 0));
    const expanded = new Set(canonical);
    const canonicalIdentityByStoredPath = new Map<string, string>();
    for (const identity of canonical) {
        canonicalIdentityByStoredPath.set(identity, identity);
    }

    if (canonical.length === 0) {
        return { expandedIdentities: [...expanded], canonicalIdentityByStoredPath };
    }

    for (const [alias, target] of collectAliasesForTargets(db, canonical)) {
        expanded.add(alias);
        canonicalIdentityByStoredPath.set(alias, target);
    }

    return { expandedIdentities: [...expanded], canonicalIdentityByStoredPath };
}

export function resolveStoredPathWorkspaceIdentity(
    storedProjectPath: string,
    memberIdentities: readonly string[],
    canonicalIdentityByStoredPath: ReadonlyMap<string, string>,
): string | null {
    const direct = canonicalIdentityByStoredPath.get(storedProjectPath);
    if (direct) return direct;

    const normalized = normalizeStoredProjectPath(storedProjectPath);
    const normalizedDirect = canonicalIdentityByStoredPath.get(normalized);
    if (normalizedDirect) return normalizedDirect;
    if (memberIdentities.includes(normalized)) return normalized;

    for (const identity of memberIdentities) {
        if (storedPathBelongsToIdentity(storedProjectPath, identity)) {
            return identity;
        }
    }
    return null;
}

export function storedPathBelongsToWorkspace(
    storedProjectPath: string,
    memberIdentities: readonly string[],
    expandedIdentities: readonly string[],
    canonicalIdentityByStoredPath: ReadonlyMap<string, string>,
): boolean {
    if (expandedIdentities.includes(storedProjectPath)) return true;
    return (
        resolveStoredPathWorkspaceIdentity(
            storedProjectPath,
            memberIdentities,
            canonicalIdentityByStoredPath,
        ) !== null
    );
}

export function sourceNameForMemory(
    storedProjectPath: string,
    ownIdentity: string,
    memberIdentities: readonly string[],
    namesByIdentity: ReadonlyMap<string, string>,
    canonicalIdentityByStoredPath: ReadonlyMap<string, string>,
): string | undefined {
    const canonicalIdentity = resolveStoredPathWorkspaceIdentity(
        storedProjectPath,
        memberIdentities,
        canonicalIdentityByStoredPath,
    );
    if (!canonicalIdentity || canonicalIdentity === ownIdentity) return undefined;
    return namesByIdentity.get(canonicalIdentity);
}

function getEpochMap(db: Database, identities: readonly string[]): Map<string, number> {
    if (identities.length === 0) return new Map();
    const rows = db
        .prepare(
            `SELECT project_path AS projectPath, project_memory_epoch AS epoch
               FROM project_state
              WHERE project_path IN (${placeholders(identities)})`,
        )
        .all(...identities) as Array<{ projectPath?: unknown; epoch?: unknown }>;
    const epochs = new Map<string, number>();
    for (const row of rows) {
        if (typeof row.projectPath !== "string" || typeof row.epoch !== "number") continue;
        epochs.set(row.projectPath, row.epoch);
    }
    return epochs;
}

export function computeWorkspaceEpochFingerprint(
    db: Database,
    identities: readonly string[],
): string {
    const canonical = uniqueSorted(identities.filter((identity) => identity.length > 0));
    const epochs = getEpochMap(db, canonical);
    const shareCategories = selectWorkspaceShareCategories(db, canonical);
    const hash = createHash("sha256");
    hash.update("share_categories", "utf8");
    hash.update("\0");
    hash.update(
        shareCategories === null ? "NO_WORKSPACE" : JSON.stringify(shareCategories),
        "utf8",
    );
    hash.update("\n");
    for (const identity of canonical) {
        hash.update(identity, "utf8");
        hash.update("\0");
        hash.update(String(epochs.get(identity) ?? 0), "utf8");
        hash.update("\n");
    }
    return hash.digest("hex");
}

function isInTransaction(db: Database): boolean {
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

function workspaceMembersForIdentity(db: Database, identity: string): string[] {
    if (!tableExists(db, "workspace_members")) return [identity];
    const rows = db
        .prepare(
            `SELECT member.project_path AS identity
               FROM workspace_members AS anchor
               JOIN workspace_members AS member ON member.workspace_id = anchor.workspace_id
              WHERE anchor.project_path = ?
              ORDER BY member.project_path ASC`,
        )
        .all(identity) as Array<{ identity?: unknown }>;
    const identities = rows
        .map((row) => (typeof row.identity === "string" ? row.identity : ""))
        .filter((value) => value.length > 0);
    return identities.length > 0 ? uniqueSorted(identities) : [identity];
}

function bumpEpochRows(db: Database, identities: readonly string[], now: number): void {
    const stmt = db.prepare(
        `INSERT INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            project_memory_epoch = project_memory_epoch + 1,
            updated_at = excluded.updated_at`,
    );
    for (const identity of uniqueSorted(identities)) {
        stmt.run(identity, now);
    }
}

export function bumpEpochsForWorkspaceMembers(
    db: Database,
    identity: string,
    now = Date.now(),
): void {
    const run = () => bumpEpochRows(db, workspaceMembersForIdentity(db, identity), now);
    if (isInTransaction(db)) {
        run();
        return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
        run();
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // ignore rollback failures from an already-closed transaction
        }
        throw error;
    }
}

export function bumpEpochsForWorkspaceMemberSet(
    db: Database,
    identities: readonly string[],
    now = Date.now(),
): void {
    const run = () => bumpEpochRows(db, identities, now);
    if (isInTransaction(db)) {
        run();
        return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
        run();
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // ignore rollback failures from an already-closed transaction
        }
        throw error;
    }
}
