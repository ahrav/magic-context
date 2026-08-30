/**
 * `doctor migrate-session` — re-home ONE OpenCode session to a different
 * working directory / project, across BOTH databases.
 *
 * OpenCode (`opencode.db`):
 *   - UPDATE session SET project_id, directory, path, workspace_id=NULL.
 *   - The target project row must ALREADY exist (we never fabricate OpenCode
 *     rows): non-git target → the shared `global` project; git target → the
 *     repo's project row (open OpenCode in the dir once so it registers).
 *
 * Magic Context (`context.db`):
 *   - Session-scoped state (tags, compartments, session_meta) is keyed by
 *     session_id and follows automatically. We proactively re-stamp the
 *     project-stamped session rows (session_projects, compartment chunk
 *     embeddings) to the new identity and clear the cached m[0]/m[1] so the
 *     next load re-materializes under the new project.
 *   - Claims, evidence, receipts, lineage, and staged claim intents are durable
 *     project history. Session re-home never rewrites or copies them.
 *
 * V1 is OpenCode-only. Pi sessions are JSONL (a different re-home mechanism).
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
    /** Resolve a directory to the Magic Context project identity (git:<sha> | dir:<hash>). */
    resolveIdentity: (directory: string) => string;
    /** Whether `<dir>/.git` exists. */
    hasGitDir: (directory: string) => boolean;
    /** Canonicalize a path (realpath). */
    realpath: (p: string) => string;
    now?: number;
}

export interface MigrateSessionPlan {
    sessionId: string;
    currentDirectory: string | null;
    targetDirectory: string;
    /** OpenCode project id the session will attach to. */
    ocProjectId: string;
    ocWorktree: string;
    /** True when a dedicated per-worktree OpenCode project row was found;
     *  false when we fell back to the shared `global` project. */
    ocProjectResolvedFromRow: boolean;
    /** session.path = relative(worktree, directory). */
    sessionPath: string;
    /** Magic Context identity the session is currently keyed under. */
    fromMcIdentity: string;
    /** Magic Context identity the session will be keyed under after the move. */
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
    // session.status is a read-only query. Its nullable row_version comes directly
    // from mc_cache_state, so a number proves the module still owns this session's
    // transform cache without asking the CLI to delete or rewrite module state.
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

/** Check the durable authority fences before a session move writes either database. */
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
            // A missing OpenCode directory cannot identify the old worktree, but
            // session.status is read-only and scoped by session id, so the target
            // root still lets us inspect the module's durable cache row.
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
 * Resolve everything the move needs and validate it WITHOUT writing. Throws a
 * clear, actionable error on any precondition failure.
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

    // Resolve the OpenCode project the session will attach to from OpenCode's
    // ACTUAL registration — we never fabricate project rows. A per-worktree row
    // exists only for a repo OpenCode could derive a non-global id for (remote,
    // cached repo id, or ≥1 commit); a plain dir AND an empty `git init` repo
    // (no commits/remote) both resolve to the shared `global` project. So we
    // look up the worktree row regardless of `.git` and fall back to `global`,
    // rather than branching on `.git` existence (which would dead-end an
    // init-without-commit repo: `.git` present but no project row).
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

    // session.path = path.relative(worktree, directory).
    const sessionPath = path.relative(ocWorktree, targetDirectory);

    // The Magic Context identity this session is CURRENTLY keyed under is the
    // authoritative session_projects row if present (what MC actually used),
    // falling back to recomputing from the current directory.
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
 * Apply the move. Each database is mutated inside its own transaction. Caller
 * is responsible for backups and for ensuring OpenCode is stopped.
 */
export function applyMigrateSession(
    plan: MigrateSessionPlan,
    deps: MigrateSessionDeps,
): MigrateSessionResult {
    const now = deps.now ?? Date.now();

    // 1. OpenCode side — update only the columns that exist (schema-resilient).
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
    // The two databases are separate files, so a single ACID transaction across
    // them is impossible. To avoid a split-brain (OpenCode moved, context.db not),
    // capture the session's PRIOR column values now; if the (larger, second)
    // context.db transaction fails, we compensate by restoring OpenCode to these
    // values so the user is never left half-migrated.
    const restoreCols = ["directory", ...sets.map((s) => s.split(" = ")[0]).slice(1)];
    const priorRow = deps.opencodeDb
        .prepare(`SELECT ${restoreCols.join(", ")} FROM session WHERE id = ?`)
        .get(plan.sessionId) as Record<string, string | null> | undefined;
    // If the session row vanished between planning and applying (it shouldn't —
    // the precondition is "OpenCode stopped"), refuse rather than mutate context
    // for a session OpenCode no longer has and leave nothing to compensate with.
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
        } catch {
            // ignore — nothing committed yet, the throw below is what matters
        }
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
            // Best-effort: the original error is what we rethrow. If even the
            // compensation fails the user still has their pre-run backup.
            try {
                deps.opencodeDb.exec("ROLLBACK");
            } catch {
                // ignore
            }
        }
    };

    // Magic Context re-stamps only session runtime.
    let chunkEmbeddingsRestamped = 0;

    // BEGIN is INSIDE the try: if it throws (e.g. DB locked), OpenCode is already
    // committed, so we must still compensate. `txBegan` gates the rollback so we
    // never ROLLBACK a transaction that never started.
    let txBegan = false;
    try {
        deps.contextDb.exec("BEGIN IMMEDIATE");
        txBegan = true;
        // session_projects ownership → new identity (upsert).
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

        // Force m[0]/m[1] re-materialization under the new project on next load.
        deps.contextDb
            .prepare(
                "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?",
            )
            .run(plan.sessionId);

        deps.contextDb.exec("COMMIT");
    } catch (error) {
        // Roll back context.db only if a transaction actually began, and never let
        // a failing ROLLBACK mask the original error OR skip compensation.
        if (txBegan) {
            try {
                deps.contextDb.exec("ROLLBACK");
            } catch {
                // ignore — compensation below is what keeps the two DBs consistent
            }
        }
        // OpenCode was already committed; undo it so the two databases stay
        // consistent (no split-brain). Runs for ANY post-OpenCode-commit failure,
        // including a BEGIN that never started a transaction.
        compensateOpenCode();
        throw error;
    }

    return {
        plan,
        dryRun: false,
        chunkEmbeddingsRestamped,
    };
}

// ── CLI wrapper ─────────────────────────────────────────────────────────────

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

    // Re-homing no longer moves or copies memory. Accepting and ignoring the
    // retired flag would re-home the session while silently skipping the memory
    // action the caller asked for, so automation still passing it must fail.
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

        // The collision-merge path relies on foreign-key cascades when source
        // memories are deleted. These pragmas must be enabled before planning or writing.
        try {
            opencodeDb.exec("PRAGMA busy_timeout=5000");
            contextDb.exec("PRAGMA foreign_keys=ON");
            contextDb.exec("PRAGMA busy_timeout=5000");
        } catch {
            // Best-effort; the move's own transactions remain the final safety net.
        }
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

        // A git working dir with no dedicated OpenCode project row means an
        // empty/no-remote repo that OpenCode resolves to the shared `global`
        // project. Attaching there is rarely what the user wants for a git
        // project — warn and let them abort to make a commit / add a remote
        // and open OpenCode once first.
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

        // Checkpoint committed WAL pages, prove both files can be write-locked,
        // and snapshot them through SQLite while the locks prevent new writers.
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
