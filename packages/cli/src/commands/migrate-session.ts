/**
 * `doctor migrate-session` moves one OpenCode session to a different working directory or project across both databases.
 *
 * OpenCode (`opencode.db`):
 * The target OpenCode project row must exist; the migration never creates project rows.
 * Non-Git targets use the shared `global` project; Git targets use the repository's registered project row.
 * Users must open OpenCode in the Git target once to register its project row.
 *
 * Tags, compartments, and `session_meta` are keyed by `session_id` and follow automatically.
 * The migration re-stamps `session_projects` and compartment chunk embeddings to the new identity.
 * The migration clears cached `m[0]` and `m[1]` so the next load re-materializes under the new project.
 * Claims, evidence, receipts, lineage, and staged claim intents are durable project history.
 * Session re-home never rewrites or copies claims, evidence, receipts, lineage, or staged claim intents.
 *
 * Pi sessions use JSONL and require a different re-home mechanism.
 */

import console from "node:console";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import type { AuthorityModuleClient } from "@magic-context/core/features/magic-context/context-authority";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { McHostModuleTransport } from "@magic-context/core/hooks/magic-context/module-transport";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";

import {
    backupDatabaseSnapshot,
    getPersistedSchemaVersion,
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
    openExistingDatabase,
} from "../lib/database-access";
import { getOpenCodeDatabasePath } from "../lib/migration-paths";
import { promptIO } from "../lib/prompts";
import {
    type AuthorityProjectToVerify,
    assertProjectsUseTsAuthority,
    authorityDrainCommand,
} from "./doctor-authority";

type DatabaseLike = Pick<DatabaseType, "prepare" | "close" | "exec">;

export interface MigrateSessionDeps {
    opencodeDb: DatabaseLike;
    contextDb: DatabaseLike;
    /** `resolveIdentity` returns the Magic Context project identity (`git:<sha>` | `dir:<hash>`). */
    resolveIdentity: (directory: string) => string;
    /* */
    hasGitDir: (directory: string) => boolean;
    /* */
    realpath: (p: string) => string;
    now?: number;
}

export interface MigrateSessionPlan {
    sessionId: string;
    currentDirectory: string | null;
    targetDirectory: string;
    /* */
    ocProjectId: string;
    ocWorktree: string;
    /** `ocProjectResolvedFromRow` is true when a dedicated per-worktree OpenCode project row exists.
     * `ocProjectResolvedFromRow` is false when the migration uses the shared `global` project. */
    ocProjectResolvedFromRow: boolean;
    /** session.path = relative(worktree, directory). */
    sessionPath: string;
    /* */
    fromMcIdentity: string;
    /* */
    toMcIdentity: string;
    targetIsGit: boolean;
}

export interface MigrateSessionResult {
    plan: MigrateSessionPlan;
    dryRun: boolean;
    chunkEmbeddingsRestamped: number;
}

export interface MigrateSessionSafetyModule {
    authorityStatus: AuthorityModuleClient["authorityStatus"];
    sessionStatus(args: { sessionId: string; projectRoot: string }): Promise<unknown>;
}

export interface MigrateSessionSafetyResult {
    warnings: string[];
}

function existingSessionColumns(db: DatabaseLike): Set<string> {
    const rows = db.prepare("PRAGMA table_info(session)").all() as Array<{ name?: string }>;
    return new Set(rows.map((r) => r.name).filter((n): n is string => typeof n === "string"));
}

function isModuleCacheStatePresent(status: unknown): boolean {
    if (!status || typeof status !== "object") return false;
    // `session.status` reads `row_version` directly from `mc_cache_state`; a numeric value proves the module owns the session's transform cache without modifying module state.
    const rowVersion = (status as { row_version?: unknown }).row_version;
    return typeof rowVersion === "number";
}

function drainCommandsForMarkers(
    markers: ReadonlyArray<{ project_path: string }>,
    projects: readonly AuthorityProjectToVerify[],
): string {
    const byProject = new Map(projects.map((project) => [project.projectPath, project]));
    return [
        ...new Set(
            markers.map((marker) =>
                authorityDrainCommand(
                    byProject.get(marker.project_path) ?? {
                        role: "marked",
                        projectPath: marker.project_path,
                        projectRoot: null,
                    },
                ),
            ),
        ),
    ].join("; ");
}

/** The migration checks durable authority fences before writing either database. */
export async function assertMigrateSessionIsSafeToRehome(args: {
    plan: MigrateSessionPlan;
    contextDb: DatabaseType;
    module: MigrateSessionSafetyModule;
}): Promise<MigrateSessionSafetyResult> {
    const projects: AuthorityProjectToVerify[] = [
        {
            role: "source",
            projectPath: args.plan.fromMcIdentity,
            projectRoot: args.plan.currentDirectory,
        },
        {
            role: "target",
            projectPath: args.plan.toMcIdentity,
            projectRoot: args.plan.targetDirectory,
        },
    ];
    const authority = await assertProjectsUseTsAuthority({
        db: args.contextDb,
        projects,
        module: args.module,
    });

    let sessionStatus: unknown;
    try {
        sessionStatus = await args.module.sessionStatus({
            sessionId: args.plan.sessionId,
            // A missing OpenCode directory prevents identifying the old worktree. `session.status` remains read-only and session-scoped, so the target root can still inspect the module's durable cache row.
            // `session.status` is read-only and session-scoped, so the target root can still inspect the module's durable cache row.
            // The target project root can inspect the module's durable cache row through the read-only, session-scoped `session.status` query.
            projectRoot: args.plan.currentDirectory ?? args.plan.targetDirectory,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (authority.markers.length === 0) {
            return {
                warnings: [
                    `Module session-cache state was not checked because the module is unreachable: ${message}. No durable authority markers exist, so continuing for this pure-TypeScript installation.`,
                ],
            };
        }
        throw new Error(
            "Migration refused: module session-cache state is unreachable while durable authority markers exist; writes remain fenced. " +
                `Drain marked projects first: ${drainCommandsForMarkers(authority.markers, projects)}. ` +
                `Module error: ${message}`,
        );
    }

    if (isModuleCacheStatePresent(sessionStatus)) {
        throw new Error(
            `Migration refused: the module still holds transform cache state for session ${args.plan.sessionId}. ` +
                "Use TypeScript transform mode for the session's project, or run `ck session delete` after preserving any needed state, then re-run this migration.",
        );
    }

    return { warnings: [] };
}

/**
 * Dry runs resolve and validate the move without writing.
 */
export function planMigrateSession(
    sessionId: string,
    rawTargetDirectory: string,
    deps: MigrateSessionDeps,
): MigrateSessionPlan {
    const sessionRow = deps.opencodeDb
        .prepare("SELECT id, directory FROM session WHERE id = ?")
        .get(sessionId) as { id: string; directory: string | null } | undefined;
    if (!sessionRow) {
        throw new Error(`Session ${sessionId} not found in opencode.db.`);
    }

    const targetDirectory = deps.realpath(rawTargetDirectory);
    const targetIsGit = deps.hasGitDir(targetDirectory);

    // The migration uses the registered `global` row when no worktree row exists.
    const projectRow = deps.opencodeDb
        .prepare("SELECT id, worktree FROM project WHERE worktree = ?")
        .get(targetDirectory) as { id: string; worktree: string } | undefined;
    let ocProjectId: string;
    let ocWorktree: string;
    // `.get()` returns null (node:sqlite) or undefined (bun:sqlite) for no row.
    const ocProjectResolvedFromRow = projectRow != null;
    if (projectRow) {
        ocProjectId = projectRow.id;
        ocWorktree = projectRow.worktree;
    } else {
        const globalRow = deps.opencodeDb
            .prepare("SELECT id, worktree FROM project WHERE id = 'global'")
            .get() as { id: string; worktree: string } | undefined;
        if (!globalRow) {
            throw new Error(
                "The OpenCode 'global' project row is missing.\n" +
                    "Open any folder in OpenCode once to create it, then re-run.",
            );
        }
        ocProjectId = "global";
        ocWorktree = globalRow.worktree || "/";
    }

    const sessionPath = path.relative(ocWorktree, targetDirectory);

    // `fromMcIdentity` is the Magic Context identity that keys the session before migration.
    // The authoritative `session_projects` row records the Magic Context identity used by the session.
    const ownershipRow = deps.contextDb
        .prepare(
            "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'opencode'",
        )
        .get(sessionId) as { project_path: string } | undefined;
    const fromMcIdentity =
        ownershipRow?.project_path ??
        (sessionRow.directory ? deps.resolveIdentity(sessionRow.directory) : "");
    const toMcIdentity = deps.resolveIdentity(targetDirectory);

    return {
        sessionId,
        currentDirectory: sessionRow.directory,
        targetDirectory,
        ocProjectId,
        ocWorktree,
        ocProjectResolvedFromRow,
        sessionPath,
        fromMcIdentity,
        toMcIdentity,
        targetIsGit,
    };
}

/**
 * Each database mutation uses its own transaction; callers must back up data and stop OpenCode.
 */
export function applyMigrateSession(
    plan: MigrateSessionPlan,
    deps: MigrateSessionDeps,
): MigrateSessionResult {
    const now = deps.now ?? Date.now();

    // The OpenCode update includes only columns present in the installed schema.
    const cols = existingSessionColumns(deps.opencodeDb);
    const sets: string[] = ["directory = ?"];
    const params: Array<string | null> = [plan.targetDirectory];
    if (cols.has("project_id")) {
        sets.push("project_id = ?");
        params.push(plan.ocProjectId);
    }
    if (cols.has("path")) {
        sets.push("path = ?");
        params.push(plan.sessionPath);
    }
    if (cols.has("workspace_id")) {
        sets.push("workspace_id = ?");
        params.push(null);
    }
    // Because the databases are separate files, they cannot share an ACID transaction.
    // Captured OpenCode values allow compensation if the context.db transaction fails.
    // The prior-row snapshot lets compensation restore OpenCode after a context.db transaction failure.
    // compensateOpenCode undoes the committed OpenCode update.
    const restoreCols = ["directory", ...sets.map((s) => s.split(" = ")[0]).slice(1)];
    const priorRow = deps.opencodeDb
        .prepare(`SELECT ${restoreCols.join(", ")} FROM session WHERE id = ?`)
        .get(plan.sessionId) as Record<string, string | null> | undefined;
    // Without the current OpenCode session row, context.db could change without OpenCode state available for compensation.
    if (!priorRow) {
        throw new Error(
            `Session ${plan.sessionId} not found in opencode.db — aborting (is OpenCode still running, or was the session deleted?).`,
        );
    }

    deps.opencodeDb.exec("BEGIN IMMEDIATE");
    try {
        deps.opencodeDb
            .prepare(`UPDATE session SET ${sets.join(", ")} WHERE id = ?`)
            .run(...params, plan.sessionId);
        deps.opencodeDb.exec("COMMIT");
    } catch (error) {
        try {
            deps.opencodeDb.exec("ROLLBACK");
        } catch {}
        throw error;
    }

    const compensateOpenCode = (): void => {
        if (!priorRow) return;
        try {
            const restoreSets = restoreCols.map((c) => `${c} = ?`).join(", ");
            const restoreParams = restoreCols.map((c) => priorRow[c] ?? null);
            deps.opencodeDb.exec("BEGIN IMMEDIATE");
            deps.opencodeDb
                .prepare(`UPDATE session SET ${restoreSets} WHERE id = ?`)
                .run(...restoreParams, plan.sessionId);
            deps.opencodeDb.exec("COMMIT");
        } catch {
            // Compensation failures do not replace the original error.
            try {
                deps.opencodeDb.exec("ROLLBACK");
            } catch {
                // ignore
            }
        }
    };

    let chunkEmbeddingsRestamped = 0;

    // If BEGIN IMMEDIATE fails after the OpenCode commit, the catch still compensates OpenCode.
    // txBegan prevents context.db rollback before BEGIN IMMEDIATE succeeds.
    let txBegan = false;
    try {
        deps.contextDb.exec("BEGIN IMMEDIATE");
        txBegan = true;
        deps.contextDb
            .prepare(
                `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
                 VALUES (?, 'opencode', ?, ?)
                 ON CONFLICT(session_id, harness)
                 DO UPDATE SET project_path = excluded.project_path, updated_at = excluded.updated_at`,
            )
            .run(plan.sessionId, plan.toMcIdentity, now);

        // compartment chunk embeddings are project-stamped but session-scoped.
        const chunkResult = deps.contextDb
            .prepare(
                "UPDATE compartment_chunk_embeddings SET project_path = ? WHERE session_id = ?",
            )
            .run(plan.toMcIdentity, plan.sessionId) as { changes?: number };
        chunkEmbeddingsRestamped = chunkResult.changes ?? 0;

        deps.contextDb
            .prepare(
                "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?",
            )
            .run(plan.sessionId);

        deps.contextDb.exec("COMMIT");
    } catch (error) {
        // A failing ROLLBACK must not mask the original error or prevent compensateOpenCode().
        if (txBegan) {
            try {
                deps.contextDb.exec("ROLLBACK");
            } catch {}
        }
        // compensateOpenCode() undoes the committed OpenCode change after a context.db failure.
        compensateOpenCode();
        throw error;
    }

    return {
        plan,
        dryRun: false,
        chunkEmbeddingsRestamped,
    };
}

function defaultContextDbPath(): string {
    return join(getMagicContextStorageDir(), "context.db");
}

function realDeps(opencodeDb: DatabaseLike, contextDb: DatabaseLike): MigrateSessionDeps {
    return {
        opencodeDb,
        contextDb,
        resolveIdentity: resolveProjectIdentity,
        hasGitDir: (dir) => existsSync(join(dir, ".git")),
        realpath: (p) => realpathSync(p),
    };
}

function valueAfter(args: string[], flag: string): string | null {
    const index = args.indexOf(flag);
    if (index === -1) return null;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
}

function printMigrateSessionHelp(): void {
    console.log("");
    console.log("  doctor migrate-session — re-home an OpenCode session to another directory");
    console.log("");
    console.log("  Required:");
    console.log("    --session <id>     OpenCode session id (ses_...)");
    console.log("    --to <dir>         Target working directory");
    console.log("");
    console.log("  Optional:");
    console.log("    --dry-run          Show the plan; write nothing");
    console.log("    --yes              Skip the 'OpenCode stopped?' confirmation");
    console.log("");
    console.log("  Example:");
    console.log("    npx @cortexkit/magic-context@latest doctor migrate-session \\");
    console.log("        --session ses_xxx --to ~/Work/Projects/CortexKit/benchmarks --dry-run");
    console.log("");
}

export async function runMigrateSessionCli(args: string[]): Promise<number> {
    if (args.includes("--help") || args.includes("-h")) {
        printMigrateSessionHelp();
        return 0;
    }
    const sessionId = valueAfter(args, "--session");
    const toDir = valueAfter(args, "--to");
    const dryRun = args.includes("--dry-run");
    const skipConfirm = args.includes("--yes");

    if (args.some((arg) => arg === "--memories" || arg.startsWith("--memories="))) {
        console.error(
            "--memories is no longer supported: re-homing a session leaves claim history unchanged.",
        );
        console.error(
            "Move or copy project memory explicitly with the claim copy/move workflow, then re-run without --memories.",
        );
        return 1;
    }

    if (!sessionId) {
        console.error("Missing required flag: --session <id>");
        printMigrateSessionHelp();
        return 1;
    }
    if (!toDir) {
        console.error("Missing required flag: --to <dir>");
        printMigrateSessionHelp();
        return 1;
    }
    const expandedTo = toDir.startsWith("~")
        ? join(homedir(), toDir.slice(1).replace(/^[/\\]/, ""))
        : toDir;
    if (!existsSync(expandedTo)) {
        console.error(`Target directory does not exist: ${expandedTo}`);
        return 1;
    }

    const opencodeDbPath = getOpenCodeDatabasePath();
    const contextDbPath = defaultContextDbPath();
    let opencodeDb: DatabaseLike | null = null;
    let contextDb: DatabaseLike | null = null;
    let contextSchemaVersionBefore: number | null = null;
    try {
        opencodeDb = openExistingDatabase(opencodeDbPath, { readonly: dryRun });
        if (opencodeDb === null) {
            throw new Error(
                `OpenCode database not found at ${opencodeDbPath}; nothing to migrate.`,
            );
        }
        contextDb = dryRun
            ? openExistingContextDatabase(contextDbPath, { readonly: true })
            : openExistingContextDatabaseForMutation(contextDbPath);
        if (contextDb === null) {
            throw new Error(
                `Magic Context database not found at ${contextDbPath}; nothing to migrate.`,
            );
        }

        contextSchemaVersionBefore = getPersistedSchemaVersion(contextDb as DatabaseType);

        try {
            opencodeDb.exec("PRAGMA busy_timeout=5000");
            contextDb.exec("PRAGMA foreign_keys=ON");
            contextDb.exec("PRAGMA busy_timeout=5000");
        } catch {}
        const deps = realDeps(opencodeDb, contextDb);
        const plan = planMigrateSession(sessionId, expandedTo, deps);
        const transport = new McHostModuleTransport();
        const safety = await assertMigrateSessionIsSafeToRehome({
            plan,
            contextDb: contextDb as DatabaseType,
            module: {
                authorityStatus: (request) => transport.authorityStatus(request),
                sessionStatus: ({ sessionId: statusSessionId, projectRoot }) =>
                    transport.call({
                        sessionId: statusSessionId,
                        projectRoot,
                        method: "session.status",
                        body: {
                            method: "session.status",
                            v: 1,
                            session_id: statusSessionId,
                        },
                    }),
            },
        });
        for (const warning of safety.warnings) {
            promptIO.log.warn(warning);
        }

        promptIO.note(
            [
                `session:        ${plan.sessionId}`,
                `from:           ${plan.currentDirectory ?? "(unknown)"}`,
                `to:             ${plan.targetDirectory}`,
                `OpenCode project: ${plan.ocProjectId}${plan.targetIsGit ? " (git)" : " (global / non-git)"}`,
                `MC identity:    ${plan.fromMcIdentity}  →  ${plan.toMcIdentity}`,
            ].join("\n"),
            "Session move plan",
        );

        if (plan.targetIsGit && !plan.ocProjectResolvedFromRow) {
            promptIO.log.warn(
                `${plan.targetDirectory} is a git repo, but OpenCode has no dedicated project for it ` +
                    `(an empty repo with no commits/remote resolves to the shared 'global' project). ` +
                    `For a dedicated project: make a commit (or add a remote), open OpenCode there once, then re-run.`,
            );
            if (!dryRun) {
                if (skipConfirm) {
                    promptIO.log.warn("Proceeding — the session will attach to 'global'.");
                } else {
                    const proceed = await promptIO.confirm(
                        "Proceed attaching the session to the shared 'global' project?",
                        false,
                    );
                    if (!proceed) {
                        promptIO.log.warn("Aborted. Make a commit / add a remote, then re-run.");
                        return 1;
                    }
                }
            }
        }

        if (dryRun) {
            promptIO.log.info(
                `[dry-run] Would update opencode.db session row → project ${plan.ocProjectId}, dir ${plan.targetDirectory}.`,
            );
            promptIO.log.info(
                `[dry-run] Would re-stamp session_projects + chunk embeddings to ${plan.toMcIdentity} and clear cached m[0]/m[1].`,
            );
            promptIO.log.info(
                "[dry-run] Durable claims, evidence, receipts, and lineage stay unchanged.",
            );
            promptIO.log.info("[dry-run] No changes written.");
            return 0;
        }

        const ok = await promptIO.confirm(
            "This edits opencode.db + context.db directly. Is OpenCode (TUI / Desktop / serve) fully stopped?",
            false,
        );
        if (!ok) {
            promptIO.log.warn("Aborted. Stop OpenCode, then re-run.");
            return 1;
        }

        opencodeDb.exec("PRAGMA wal_checkpoint(FULL)");
        contextDb.exec("PRAGMA wal_checkpoint(FULL)");
        opencodeDb.exec("BEGIN IMMEDIATE");
        let contextLocked = false;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const ocBackup = `${opencodeDbPath}.bak-${stamp}`;
        const ctxBackup = `${contextDbPath}.bak-${stamp}`;
        try {
            contextDb.exec("BEGIN IMMEDIATE");
            contextLocked = true;
            await backupDatabaseSnapshot(opencodeDb as DatabaseType, ocBackup);
            await backupDatabaseSnapshot(contextDb as DatabaseType, ctxBackup);
        } finally {
            if (contextLocked) contextDb.exec("ROLLBACK");
            opencodeDb.exec("ROLLBACK");
        }
        promptIO.log.info(`Backed up: ${ocBackup}`);
        promptIO.log.info(`Backed up: ${ctxBackup}`);

        const result = applyMigrateSession(plan, deps);

        promptIO.log.success("Session re-homed.");
        console.log(`  OpenCode: project ${plan.ocProjectId}, directory ${plan.targetDirectory}`);
        console.log(`  MC identity: ${plan.fromMcIdentity} → ${plan.toMcIdentity}`);
        console.log(`  chunk embeddings re-stamped: ${result.chunkEmbeddingsRestamped}`);
        console.log("  claim history: unchanged");
        console.log(
            `Magic Context schema: v${contextSchemaVersionBefore} → v${getPersistedSchemaVersion(contextDb as DatabaseType)}`,
        );
        console.log("Restart OpenCode to pick up the moved session.");
        console.log(
            "If another harness is running, restart it too so every process reloads the same schema fence.",
        );
        return 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        opencodeDb?.close();
        contextDb?.close();
    }
}
