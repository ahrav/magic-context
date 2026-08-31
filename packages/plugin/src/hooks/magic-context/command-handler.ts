import { randomUUID } from "node:crypto";
import { COMPACTION_ENABLED_PATH } from "../../config/agent-disable";
import type { DreamerConfig, SidekickConfig } from "../../config/schema/magic-context";
import type { ResolvedTransformMode } from "../../config/transform-mode";
import { getDreamTaskBacklogs } from "../../features/magic-context/dreamer/task-gates";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskName,
    formatDreamTaskBacklogs,
    isCanonicalDreamTask,
} from "../../features/magic-context/dreamer/task-registry";
import type { ManualRunResult } from "../../features/magic-context/dreamer/task-scheduler";
import {
    executeClaimApprovalCommand,
    executeClaimEnforceCommand,
} from "../../features/magic-context/memory/claim-policy-commands";
import { runSidekick } from "../../features/magic-context/sidekick/agent";
import { getCompartments, getOrCreateSessionMeta } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import {
    resolveTailHygieneStatus,
    type WireTailHygieneBaseline,
} from "../../shared/tail-hygiene-status";
import {
    type PartialRecompRange,
    snapRangeToCompartments,
} from "./compartment-runner-partial-recomp";
import { resolveContextWindowGeometry } from "./event-resolvers";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import { MAX_WRAPUP_REQUEST_BUDGET_MS } from "./module-transport";
import type { RustModeModuleClient } from "./rust-mode-transform";
import type { NotificationParams } from "./send-session-notification";
import { sendUserPrompt } from "./send-session-notification";

/**
 * Desktop has no dialog, so recomp confirmations are tracked per session.
 * Changing ranges requires a fresh confirmation.
 * confirmation.
 */
interface RecompConfirmation {
    timestamp: number;
    /** argsKey stores the normalized range argument or "" for a full recompilation. */
    argsKey: string;
}
const recompConfirmationBySession = new Map<string, RecompConfirmation>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;

function isSubagentSession(db: Database, sessionId: string): boolean {
    const meta = getOrCreateSessionMeta(db, sessionId);
    if (meta.isSubagent) return true;
    try {
        const row = db
            .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { is_subagent?: unknown } | null;
        return row?.is_subagent === 1 || row?.is_subagent === true;
    } catch {
        return false;
    }
}

const RECOMP_USAGE = [
    "Usage:",
    "- `/ctx-recomp` — full rebuild from message 1 to the protected tail",
    "- `/ctx-recomp <start>-<end>` — partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`)",
    "- `/ctx-recomp --upgrade` — upgrade legacy v1 compartments to v2 layout (Wave 3 runner)",
].join("\n");

/**
 *
 *  Accepted forms:
 *
 * */
export function parseRecompArgs(
    raw: string,
):
    | { kind: "full" }
    | { kind: "partial"; range: PartialRecompRange }
    | { kind: "upgrade" }
    | { kind: "error"; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "full" };
    if (trimmed === "--upgrade") return { kind: "upgrade" };

    const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
        return {
            kind: "error",
            message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${RECOMP_USAGE}`,
        };
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { kind: "error", message: "Range values must be finite integers." };
    }
    if (start < 1) {
        return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
    }
    if (end < start) {
        return {
            kind: "error",
            message: `End must be >= start (got ${start}-${end}).`,
        };
    }

    return { kind: "partial", range: { start, end } };
}

export function parseWrapupArgs(
    raw: string,
): { ok: true; messagesToKeep: number } | { ok: false; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, messagesToKeep: 20 };
    if (!/^\d+$/.test(trimmed)) {
        return {
            ok: false,
            message:
                "Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer.",
        };
    }
    const messagesToKeep = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
        return { ok: false, message: "messages_to_keep must be a positive integer." };
    }
    return { ok: true, messagesToKeep };
}

export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}

export interface CommandExecuteOutput {
    parts: Array<{ type: string; text?: string }>;
}

const SENTINEL_PREFIX = "__CONTEXT_MANAGEMENT_";

// Effect HTTP uses plain-string TypeIds, not Symbols.
// Effect HTTP guards check string keys, so plugin-built responses need no Effect import.
const HTTP_SERVER_RESPONSE_TYPE_ID = "~effect/http/HttpServerResponse";
const HTTP_COOKIES_TYPE_ID = "~effect/http/Cookies";
const HTTP_BODY_TYPE_ID = "~effect/http/HttpBody";
const ERROR_REPORTER_IGNORE = "~effect/ErrorReporter/ignore";

/** The 204 response prevents OpenCode from forwarding the handled command to the LLM.
 *
 * The thrown `Error` preserves `.message` and `.stack` on hosts that do not recognize the Effect HTTP tags.
 * The thrown duck-typed 204 Effect response makes OpenCode treat the command as handled without importing Effect.
 * OpenCode recognizes responses with the `"~effect/http/HttpServerResponse"` TypeId.
 * OpenCode recognizes `"~effect/http/HttpServerResponse" in defect`.
 * The HTTP boundary skips JSON-500 logging when it recognizes the response.
 * The HTTP boundary writes a recognized response as HTTP 204.
 *
 * Response.toWeb's empty-body path requires status, statusText, headers, cookies.cookies, and body._tag.
 *
 * The shim duck-types an Effect HTTP response because the command hook has no handled, cancel, or no-reply result.
 * */
function throwSentinel(command: string): never {
    const sentinel = new Error(`${SENTINEL_PREFIX}${command.toUpperCase()}_HANDLED__`) as Error &
        Record<string, unknown>;
    sentinel[HTTP_SERVER_RESPONSE_TYPE_ID] = HTTP_SERVER_RESPONSE_TYPE_ID;
    sentinel[ERROR_REPORTER_IGNORE] = true;
    sentinel.status = 204;
    sentinel.statusText = undefined;
    sentinel.headers = {};
    sentinel.cookies = { [HTTP_COOKIES_TYPE_ID]: HTTP_COOKIES_TYPE_ID, cookies: {} };
    sentinel.body = { [HTTP_BODY_TYPE_ID]: HTTP_BODY_TYPE_ID, _tag: "Empty" };
    throw sentinel;
}

function getLegacyCompartmentCount(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
            )
            .get(sessionId) as { count?: number } | undefined;
        return typeof row?.count === "number" ? row.count : 0;
    } catch {
        // The schema compatibility check supports databases without the v22 legacy column.
        return 0;
    }
}

function moduleResponseValue(response: unknown): Record<string, unknown> {
    if (response && typeof response === "object") {
        const value = response as Record<string, unknown>;
        if (value.result && typeof value.result === "object") {
            return value.result as Record<string, unknown>;
        }
        return value;
    }
    return {};
}

function rustCommandId(operation: string): string {
    return `opencode-${operation}-${randomUUID()}`;
}

function formatRustOperationMessage(
    operation: "wrapup" | "recomp",
    value: Record<string, unknown>,
): string {
    const disposition = typeof value.disposition === "string" ? value.disposition : "failed";
    const summary = typeof value.summary === "string" ? value.summary : "";
    const rounds = typeof value.rounds === "number" ? value.rounds : 0;
    if (operation === "wrapup") {
        switch (disposition) {
            case "completed":
                return `## Magic Wrapup\n\n${summary || "Wrapup completed."}${summary && rounds > 0 ? ` (${rounds} round${rounds === 1 ? "" : "s"})` : ""}`;
            case "nothing_to_compact":
                return `## Magic Wrapup\n\n${summary || "Nothing to compact."}`;
            case "already_in_progress":
                return `## Magic Wrapup — Skipped\n\n/ctx-wrapup is already running for this session${rounds > 0 ? ` (${rounds} round${rounds === 1 ? "" : "s"} complete)` : ""}. Wait for it to finish, then run /ctx-wrapup again if more history remains.`;
            case "retryable":
                // A nonterminal disposition indicates that the drain made progress but stopped before the keep watermark for a retryable reason.
                // The orchestrator renders retryable dispositions as Partial rather than Failed.
                // A retryable disposition instructs the user to rerun /ctx-wrapup instead of reporting failure.
                return `## Magic Wrapup — Partial\n\n${summary || "Wrapup made progress but stopped before the keep watermark."} Run /ctx-wrapup again to continue.`;
            default:
                return `## Magic Wrapup — Failed\n\n${summary || "Wrapup failed; try /ctx-wrapup again."}${rounds > 0 ? ` (${rounds} round${rounds === 1 ? "" : "s"})` : ""}`;
        }
    }
    switch (disposition) {
        case "started":
            return "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments from raw session history now.";
        case "already_in_progress":
            return "## Magic Recomp — Skipped\n\nHistorian recomp is already running for this session. Wait for it to finish, then try /ctx-recomp again.";
        case "nothing_to_do":
            return "## Magic Recomp\n\nNothing to rebuild: this session has no published compartments.";
        default:
            return `## Magic Recomp — Failed\n\n${summary || "Historian recomp failed; try /ctx-recomp again."}`;
    }
}

function formatRustStatusText(value: Record<string, unknown>): string {
    const usage =
        value.usage && typeof value.usage === "object"
            ? (value.usage as Record<string, unknown>)
            : {};
    const tokens =
        typeof usage.current_total_input_tokens === "number" ? usage.current_total_input_tokens : 0;
    const limit = typeof usage.context_limit_tokens === "number" ? usage.context_limit_tokens : 0;
    const coverage = value.coverage_ordinal == null ? "none" : String(value.coverage_ordinal);
    const boundary = value.boundary_present === true ? "present" : "absent";
    const compartments = typeof value.compartment_count === "number" ? value.compartment_count : 0;
    return [
        "### Module Cache",
        `- Usage: ${tokens.toLocaleString()}${limit > 0 ? ` / ${limit.toLocaleString()} tokens` : " tokens"}`,
        `- Boundary: ${boundary}`,
        `- Coverage ordinal: ${coverage}`,
        `- Compartments: ${compartments}`,
    ].join("\n");
}

function executeRecompUpgradeStub(db: Database, sessionId: string): string {
    const legacyCount = getLegacyCompartmentCount(db, sessionId);
    if (legacyCount === 0) {
        return "## Magic Recomp Upgrade\n\nNothing to upgrade: this session has no legacy compartments.";
    }

    return [
        "## Magic Recomp Upgrade",
        "",
        `Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
        "The `--upgrade` flag is deprecated. Run `/ctx-session-upgrade` to upgrade this session.",
    ].join("\n");
}

/**
 * This command upgrades the current session to the v2 history format.
 *
 * The upgrade recompiles session compartments and migrates project memories.
 * A full recomp rebuilds every legacy v1 compartment into v2 form and leaves no legacy compartments.
 * The migration classifies project memories into five categories once per project.
 * The migration uses a transient historian-model prompt once per project.
 *
 * Recomp rebuilds only the current session's compartments.
 * The shared orchestrator recompiles session compartments before migrating project memories.
 */
async function executeSessionUpgrade(
    deps: {
        /**
         * The command is unavailable when `deps.runUpgrade` is undefined.
         * */
        runUpgrade?: (sessionId: string) => Promise<string>;
    },
    sessionId: string,
): Promise<string> {
    if (!deps.runUpgrade) {
        return "## Session Upgrade\n\nUpgrade is unavailable because the recomp handler is not configured.";
    }
    return deps.runUpgrade(sessionId);
}

/**
 * /ctx-aug uses Sidekick to augment the user's prompt and sends the result as a user message.
 */
async function executeAugmentation(
    deps: {
        db: Database;
        sendNotification: (
            sessionId: string,
            text: string,
            params: NotificationParams,
        ) => Promise<void>;
        sidekick?: {
            config: SidekickConfig;
            projectPath: string;
            sessionDirectory?: string;
            client: PluginContext["client"];
            language?: string;
        };
    },
    sessionId: string,
    userPrompt: string,
): Promise<never> {
    if (!deps.sidekick?.config) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-aug\n\nSidekick is not configured. Add sidekick settings to `magic-context.jsonc` to use /ctx-aug.",
            {},
        );
        throwSentinel("CTX-AUG");
    }

    const prompt = userPrompt.trim();
    if (prompt.length === 0) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-aug\n\nUsage: `/ctx-aug <your prompt>`\n\nProvide a prompt to augment with project memory context.",
            {},
        );
        throwSentinel("CTX-AUG");
    }

    await deps.sendNotification(
        sessionId,
        "🔍 Preparing augmentation… this may take 2-10s depending on your sidekick provider.",
        {},
    );

    sessionLog(sessionId, "/ctx-aug: running sidekick");
    const sidekickResult = await runSidekick({
        client: deps.sidekick.client,
        sessionId,
        projectPath: deps.sidekick.projectPath,
        sessionDirectory: deps.sidekick.sessionDirectory,
        userMessage: prompt,
        config: deps.sidekick.config,
        language: deps.sidekick.language,
    });

    let augmentedPrompt: string;
    if (sidekickResult) {
        augmentedPrompt = `${prompt}\n\n<sidekick-augmentation>\n${sidekickResult}\n</sidekick-augmentation>`;
        sessionLog(sessionId, `/ctx-aug: sidekick returned ${sidekickResult.length} chars`);
    } else {
        augmentedPrompt = prompt;
        sessionLog(sessionId, "/ctx-aug: sidekick returned no result, sending prompt as-is");
    }

    await sendUserPrompt(deps.sidekick.client, sessionId, augmentedPrompt);

    throwSentinel("CTX-AUG");
}

export type ManualDreamSummary = ManualRunResult;

function readDreamTaskBacklogsSafely(
    db: Database,
    projectPath: string,
    tasks: readonly DreamTaskName[],
) {
    try {
        return getDreamTaskBacklogs(db, projectPath, tasks);
    } catch {
        // Command handling must remain available while an older/empty database is migrating.
        return {};
    }
}

function summarizeManualDream(s: ManualDreamSummary): string {
    const lines: string[] = ["## /ctx-dream", ""];
    if (s.ran.length > 0) lines.push(`Ran: ${s.ran.join(", ")}`);
    if (s.failed.length > 0) lines.push(`Failed: ${s.failed.join(", ")}`);
    if ((s.failureDetails?.length ?? 0) > 0) {
        lines.push("Failure details:", ...(s.failureDetails ?? []).map((detail) => `- ${detail}`));
    }
    if (s.skippedNoWork.length > 0) lines.push(`Skipped (no work): ${s.skippedNoWork.join(", ")}`);
    if (s.deferredBusy.length > 0)
        lines.push(
            // “Busy” means another task holds the domain lease.
            `Busy: ${s.deferredBusy.join(", ")} — another dream task holds this domain's lease; retry in a minute`,
        );
    if (Object.keys(s.backlogBefore ?? {}).length > 0) {
        lines.push("", "Backlog at run start:", formatDreamTaskBacklogs(s.backlogBefore ?? {}));
    }
    if (Object.keys(s.backlogAfter ?? {}).length > 0) {
        lines.push("", "Backlog at run end:", formatDreamTaskBacklogs(s.backlogAfter ?? {}));
    }
    if (
        s.ran.length === 0 &&
        s.failed.length === 0 &&
        s.skippedNoWork.length === 0 &&
        s.deferredBusy.length === 0
    ) {
        lines.push("No enabled dream tasks to run.");
    }
    return lines.join("\n");
}

async function executeDreaming(
    deps: {
        db: Database;
        sendNotification: (
            sessionId: string,
            text: string,
            params: NotificationParams,
        ) => Promise<void>;
        toastDurationMs?: number;
        dreamer?: {
            config: DreamerConfig;
            projectPath: string;
            /**
             *  `task` forces one task ignoring its gate; omitted runs all enabled. */
            runManual: (task?: DreamTaskName) => Promise<ManualDreamSummary>;
        };
    },
    sessionId: string,
    argText?: string,
): Promise<never> {
    const dreamNotificationParams: NotificationParams = {
        toastDurationMs: deps.toastDurationMs ?? 5000,
    };

    if (!deps.dreamer) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-dream\n\nDreaming is not configured for this project.",
            dreamNotificationParams,
        );
        throwSentinel("CTX-DREAM");
    }

    const requested = argText?.trim();
    let task: DreamTaskName | undefined;
    if (requested) {
        if (!isCanonicalDreamTask(requested)) {
            await deps.sendNotification(
                sessionId,
                `## /ctx-dream\n\nUnknown task "${requested}". Valid tasks: ${CANONICAL_DREAM_TASKS.join(", ")}.`,
                dreamNotificationParams,
            );
            throwSentinel("CTX-DREAM");
        }
        task = requested;
    }

    const backlogTasks = task ? [task] : CANONICAL_DREAM_TASKS;
    const backlogBefore = readDreamTaskBacklogsSafely(
        deps.db,
        deps.dreamer.projectPath,
        backlogTasks,
    );
    await deps.sendNotification(
        sessionId,
        [
            "## /ctx-dream",
            "",
            task ? `Running dream task "${task}"...` : "Starting dream run...",
            "",
            "Backlog before starting:",
            formatDreamTaskBacklogs(backlogBefore, backlogTasks),
        ].join("\n"),
        dreamNotificationParams,
    );

    const summary = await deps.dreamer.runManual(task);

    await deps.sendNotification(sessionId, summarizeManualDream(summary), dreamNotificationParams);
    throwSentinel("CTX-DREAM");
}

export function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number;
    /** Command paths use boot-resolved mode and must not reread configuration. */
    compactionOff?: boolean;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historyBudgetPercentage?: number;
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    getLiveModelKey?: (sessionId: string) => string | undefined;
    /** The optional live context limit resolver supplies token-based threshold displays. */
    getContextLimit?: (sessionId: string) => number | undefined;
    getDreamerProgress?: () =>
        | import("../../features/magic-context/dreamer/task-registry").DreamTaskProgress
        | null;
    /** Both nudge mechanisms share the cached U/T token measurement of the final rendered conversation tail. */
    getTailHygiene?: (sessionId: string) => import("./ctx-reduce-nudge").Channel1State | undefined;
    onFlush?: (sessionId: string) => void;
    /** `/ctx-recomp` recompiles `range` after snapping it to enclosing compartment boundaries.
     * Without `range`, `/ctx-recomp` recompiles messages 1 through the protected tail. */
    executeRecomp?: (
        sessionId: string,
        options?: { range?: PartialRecompRange },
    ) => Promise<string>;
    /** `/ctx-wrapup` runs over the live raw tail and keeps the newest N raw messages. */
    executeWrapup?: (sessionId: string, options: { messagesToKeep: number }) => Promise<string>;
    /** `/ctx-session-upgrade` runs the once-per-project five-category memory migration.
     * When memory migration is unavailable, `/ctx-session-upgrade` still upgrades compartments via recomp and skips memory reevaluation.
     * */
    runUpgrade?: (sessionId: string) => Promise<string>;
    /** `/ctx-embed start` backfills this session's compartment embeddings. */
    executeEmbedHistory?: (
        sessionId: string,
        options?: { signal?: AbortSignal; silent?: boolean },
    ) => Promise<string>;
    pauseEmbedDrain?: (sessionId: string) => string;
    getEmbedStatusText?: (sessionId: string) => string;
    sendNotification: (
        sessionId: string,
        text: string,
        params: NotificationParams,
    ) => Promise<void>;
    /** Diagnostics logs receive the configured toast lifetime in milliseconds. */
    toastDurationMs?: number;
    transformMode?: ResolvedTransformMode;
    rustModeModuleClient?: RustModeModuleClient;
    projectRoot?: string;
    /** `memories.project_path` stores the active project identity. */
    projectPath?: string;
    /** The project resolver runs per call because resumed or moved sessions can differ from the construction-time project; it falls back to construction-time values when unavailable.
     * */
    resolveProjectForSession?: (sessionId: string) => {
        projectPath?: string;
        projectRoot: string;
    };
    sidekick?: {
        config: SidekickConfig;
        projectPath: string;
        sessionDirectory?: string;
        client: PluginContext["client"];
        language?: string;
    };
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        /** `runManual` runs a requested task, or all enabled tasks, through the per-task scheduler.
         * */
        runManual: (task?: DreamTaskName) => Promise<ManualRunResult>;
    };
}) {
    // The notification wrapper logs and swallows delivery failures so `throwSentinel` prevents forwarding the raw command to the LLM; it also covers `executeAugmentation` and `executeDreaming`.
    const rawSendNotification = deps.sendNotification;
    deps.sendNotification = async (sessionId, text, params) => {
        try {
            await rawSendNotification(sessionId, text, params);
        } catch (err) {
            sessionLog(
                sessionId,
                `command notification delivery failed (continuing to sentinel): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    };

    const isStatusCommand = (command: string): boolean => command === "ctx-status";
    const isFlushCommand = (command: string): boolean => command === "ctx-flush";
    const isRecompCommand = (command: string): boolean => command === "ctx-recomp";
    const isWrapupCommand = (command: string): boolean => command === "ctx-wrapup";
    const isAugCommand = (command: string): boolean => command === "ctx-aug";
    const isDreamCommand = (command: string): boolean => command === "ctx-dream";
    const isSessionUpgradeCommand = (command: string): boolean => command === "ctx-session-upgrade";
    const isEmbedCommand = (command: string): boolean => command === "ctx-embed";
    const isApproveCommand = (command: string): boolean => command === "ctx-approve";
    const isEnforceCommand = (command: string): boolean => command === "ctx-enforce";
    const rustMode = deps.transformMode === "rust" && deps.rustModeModuleClient;
    const callRust = async (
        method: Parameters<RustModeModuleClient["call"]>[0]["method"],
        body: Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<Record<string, unknown>> => {
        if (!rustMode) throw new Error("Rust module client is unavailable");
        return moduleResponseValue(
            await rustMode.call({
                sessionId: body.session_id as string,
                projectRoot: deps.projectRoot ?? process.cwd(),
                method,
                body,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }),
        );
    };

    return {
        "command.execute.before": async (
            input: CommandExecuteInput,
            _output: CommandExecuteOutput,
            _params: NotificationParams,
        ): Promise<void> => {
            const isStatus = isStatusCommand(input.command);
            const isFlush = isFlushCommand(input.command);
            const isRecomp = isRecompCommand(input.command);
            const isWrapup = isWrapupCommand(input.command);
            const isAug = isAugCommand(input.command);
            const isDream = isDreamCommand(input.command);
            const isSessionUpgrade = isSessionUpgradeCommand(input.command);
            const isEmbed = isEmbedCommand(input.command);
            const isApprove = isApproveCommand(input.command);
            const isEnforce = isEnforceCommand(input.command);

            if (
                !isStatus &&
                !isFlush &&
                !isRecomp &&
                !isWrapup &&
                !isAug &&
                !isDream &&
                !isSessionUpgrade &&
                !isEmbed &&
                !isApprove &&
                !isEnforce
            ) {
                return;
            }

            const sessionId = input.sessionID;
            let result = "";

            if (isApprove || isEnforce) {
                // The project resolver runs per call because a resumed session can use a different directory than the construction-time project.
                // The invoking session may run in a different project than the construction-time project.
                const resolved = deps.resolveProjectForSession?.(sessionId);
                const projectPath = resolved ? resolved.projectPath : deps.projectPath;
                const projectRoot = resolved ? resolved.projectRoot : deps.projectRoot;
                if (!projectPath || !projectRoot) {
                    result = `## Claim ${isApprove ? "Approval" : "Enforcement"} — Unavailable\n\nNo active project is configured for this session.`;
                } else if (isSubagentSession(deps.db, sessionId)) {
                    result = `## Claim ${isApprove ? "Approval" : "Enforcement"} — Refused\n\n${isApprove ? "Approval" : "Enforcement"} commands are user-only and unavailable to subagent sessions.`;
                } else {
                    const commandDeps = {
                        db: deps.db,
                        projectPath,
                        projectRoot,
                        host: "opencode" as const,
                        sessionId,
                    };
                    try {
                        result = isApprove
                            ? (await executeClaimApprovalCommand(commandDeps, input.arguments)).text
                            : (await executeClaimEnforceCommand(commandDeps, input.arguments)).text;
                    } catch (error) {
                        result = `## Claim ${isApprove ? "Approval" : "Enforcement"} — Failed\n\n${error instanceof Error ? error.message : String(error)}`;
                    }
                }
                await deps.sendNotification(sessionId, result, {});
                sessionLog(
                    sessionId,
                    `command ${input.command} handled via command.execute.before`,
                );
                throwSentinel(input.command);
            }

            if (deps.compactionOff && (isFlush || isRecomp || isWrapup)) {
                const command = `/${input.command}`;
                await deps.sendNotification(
                    sessionId,
                    `Magic Context compaction is disabled (${COMPACTION_ENABLED_PATH}: false) — ${command} manages compacted history and has no effect in this mode.`,
                    {},
                );
                throwSentinel(input.command);
            }

            if (isAug) {
                await executeAugmentation(deps, sessionId, input.arguments);
                return; // executeAugmentation throws sentinel internally
            }

            if (isDream) {
                await executeDreaming(deps, sessionId, input.arguments);
                return;
            }

            if (isEmbed) {
                const sub = input.arguments.trim().toLowerCase();
                if (sub === "pause") {
                    const summary = deps.pauseEmbedDrain
                        ? deps.pauseEmbedDrain(sessionId)
                        : "Embedding pause is unavailable.";
                    if (isTuiConnected(sessionId)) {
                        pushNotification(
                            "action",
                            { action: "show-result-dialog", title: "Embed", message: summary },
                            sessionId,
                        );
                    } else {
                        await deps.sendNotification(sessionId, summary, {});
                    }
                    throwSentinel(input.command);
                }
                if (sub === "start") {
                    const summary = deps.executeEmbedHistory
                        ? await deps.executeEmbedHistory(sessionId)
                        : "Semantic embedding is not configured for this project, so there is nothing to embed.";
                    if (isTuiConnected(sessionId)) {
                        pushNotification(
                            "action",
                            { action: "show-result-dialog", title: "Embed", message: summary },
                            sessionId,
                        );
                    } else {
                        await deps.sendNotification(sessionId, summary, {});
                    }
                    throwSentinel(input.command);
                }
                if (sub !== "") {
                    await deps.sendNotification(
                        sessionId,
                        "Usage: `/ctx-embed` (status), `/ctx-embed start`, or `/ctx-embed pause`.",
                        {},
                    );
                    throwSentinel(input.command);
                }
                if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-embed-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-embed: pushed show-embed-dialog to TUI");
                    throwSentinel(input.command);
                }
                result = deps.getEmbedStatusText
                    ? `## Embedding Status\n\n${deps.getEmbedStatusText(sessionId)}`
                    : "## Embedding Status\n\nEmbedding status is unavailable.";
            }

            if (isFlush) {
                if (rustMode) {
                    try {
                        const value = await callRust("session.flush", {
                            method: "session.flush",
                            v: 1,
                            session_id: sessionId,
                        });
                        result =
                            value.armed === false
                                ? "No pending operations to flush."
                                : "Flushed: Changes take effect on next message.";
                    } catch (error) {
                        result = `Error: Failed to flush context operations. ${error instanceof Error ? error.message : String(error)}`;
                    }
                } else {
                    result = executeFlush(deps.db, sessionId);
                }
                deps.onFlush?.(sessionId);
                if (isTuiConnected(sessionId)) {
                    pushNotification(
                        "action",
                        { action: "show-flush-dialog", message: result },
                        sessionId,
                    );
                    sessionLog(sessionId, "command ctx-flush: pushed show-flush-dialog to TUI");
                    throwSentinel(input.command);
                }
            }

            if (isStatus) {
                let rustStatus: Record<string, unknown> | undefined;
                if (rustMode) {
                    try {
                        rustStatus = await callRust("session.status", {
                            method: "session.status",
                            v: 1,
                            session_id: sessionId,
                        });
                    } catch (error) {
                        sessionLog(sessionId, "rust session.status failed:", error);
                    }
                }
                if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-status-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-status: pushed show-status-dialog to TUI");
                    throwSentinel(input.command);
                }
                const liveModelKey = deps.getLiveModelKey?.(sessionId);
                const liveContextLimit = deps.getContextLimit?.(sessionId);
                const modelSlash = liveModelKey?.indexOf("/") ?? -1;
                const windowGeometry =
                    liveModelKey && modelSlash > 0
                        ? resolveContextWindowGeometry(
                              liveModelKey.slice(0, modelSlash),
                              liveModelKey.slice(modelSlash + 1),
                              { db: deps.db, sessionID: sessionId },
                          )
                        : undefined;
                const rustTailHygiene = rustStatus?.tail_hygiene;
                const tailHygiene = resolveTailHygieneStatus(
                    deps.getTailHygiene?.(sessionId),
                    rustTailHygiene && typeof rustTailHygiene === "object"
                        ? (rustTailHygiene as WireTailHygieneBaseline)
                        : undefined,
                );
                const statusOutput = executeStatus(
                    deps.db,
                    sessionId,
                    deps.protectedTags,
                    deps.executeThresholdPercentage,
                    liveModelKey,
                    deps.historyBudgetPercentage,
                    deps.commitClusterTrigger,
                    deps.executeThresholdTokens,
                    liveContextLimit,
                    deps.dreamer
                        ? {
                              backlog: readDreamTaskBacklogsSafely(
                                  deps.db,
                                  deps.dreamer.projectPath,
                                  CANONICAL_DREAM_TASKS,
                              ),
                              progress: deps.getDreamerProgress?.() ?? null,
                          }
                        : undefined,
                    windowGeometry,
                    tailHygiene,
                );
                const moduleStatus = rustStatus ? `\n\n${formatRustStatusText(rustStatus)}` : "";
                const modeStatus = deps.compactionOff
                    ? `**Compaction:** disabled (${COMPACTION_ENABLED_PATH}: false) — native compaction owns the context window.\n\n`
                    : "";
                const combinedStatus = `${modeStatus}${statusOutput}${moduleStatus}`;
                result += result ? `\n\n${combinedStatus}` : combinedStatus;
            }

            if (isWrapup) {
                const parsed = parseWrapupArgs(input.arguments);
                if (isSubagentSession(deps.db, sessionId)) {
                    result =
                        "## Magic Wrapup — Skipped\n\n/ctx-wrapup is only available in primary sessions.";
                } else if (!parsed.ok) {
                    result = `## Magic Wrapup — Invalid Arguments\n\n${parsed.message}`;
                } else if (rustMode) {
                    const keep = parsed.messagesToKeep;
                    await deps.sendNotification(
                        sessionId,
                        "## Magic Wrapup\n\nStarting wrapup…",
                        {},
                    );
                    try {
                        const value = await callRust(
                            "session.wrapup",
                            {
                                method: "session.wrapup",
                                v: 1,
                                session_id: sessionId,
                                keep,
                                command_id: rustCommandId("wrapup"),
                            },
                            MAX_WRAPUP_REQUEST_BUDGET_MS,
                        );
                        result = formatRustOperationMessage("wrapup", value);
                    } catch (error) {
                        result = `## Magic Wrapup — Failed\n\n${error instanceof Error ? error.message : String(error)}`;
                    }
                } else if (!deps.executeWrapup) {
                    result =
                        "## Magic Wrapup\n\n/ctx-wrapup is unavailable because the historian handler is not configured.";
                } else {
                    result = await deps.executeWrapup(sessionId, {
                        messagesToKeep: parsed.messagesToKeep,
                    });
                }
            }

            if (isRecomp) {
                const parsedArgs = parseRecompArgs(input.arguments);
                if (parsedArgs.kind === "error") {
                    result = `## Magic Recomp — Invalid Arguments\n\n${parsedArgs.message}`;
                } else if (parsedArgs.kind === "upgrade") {
                    result = executeRecompUpgradeStub(deps.db, sessionId);
                } else if (rustMode) {
                    try {
                        const value = await callRust("session.recomp", {
                            method: "session.recomp",
                            v: 1,
                            session_id: sessionId,
                            command_id: rustCommandId("recomp"),
                        });
                        result = formatRustOperationMessage("recomp", value);
                    } catch (error) {
                        result = `## Magic Recomp — Failed\n\n${error instanceof Error ? error.message : String(error)}`;
                    }
                } else if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-recomp-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-recomp: pushed show-recomp-dialog to TUI");
                    throwSentinel(input.command);
                } else if (!deps.executeRecomp) {
                    result =
                        "## Magic Recomp\n\n/ctx-recomp is unavailable because the recomp handler is not configured.";
                } else {
                    const argsKey =
                        parsedArgs.kind === "partial"
                            ? `${parsedArgs.range.start}-${parsedArgs.range.end}`
                            : "";
                    const lastConfirmation = recompConfirmationBySession.get(sessionId);
                    const now = Date.now();
                    const confirmationValid =
                        lastConfirmation &&
                        now - lastConfirmation.timestamp < RECOMP_CONFIRMATION_WINDOW_MS &&
                        lastConfirmation.argsKey === argsKey;

                    if (confirmationValid) {
                        // A second /ctx-recomp within 60 seconds with the same arguments confirms recompilation.
                        recompConfirmationBySession.delete(sessionId);
                        if (parsedArgs.kind === "partial") {
                            await deps.sendNotification(
                                sessionId,
                                `## Magic Recomp\n\nPartial recomp started for range ${parsedArgs.range.start}-${parsedArgs.range.end}. Rebuilding the matching compartments now (facts unchanged).`,
                                {},
                            );
                            result = await deps.executeRecomp(sessionId, {
                                range: parsedArgs.range,
                            });
                        } else {
                            await deps.sendNotification(
                                sessionId,
                                "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments and facts from raw session history now.",
                                {},
                            );
                            result = await deps.executeRecomp(sessionId);
                        }
                    } else {
                        recompConfirmationBySession.set(sessionId, {
                            timestamp: now,
                            argsKey,
                        });
                        const compartments = getCompartments(deps.db, sessionId);
                        const compartmentCount = compartments.length;

                        if (parsedArgs.kind === "partial") {
                            // The snap preview uses snapped bounds so users see the range that recompilation replaces.
                            const snap = snapRangeToCompartments(compartments, parsedArgs.range);
                            if ("error" in snap) {
                                // A snap error clears stale confirmation because it is not a pending intent.
                                recompConfirmationBySession.delete(sessionId);
                                result = `## Magic Recomp — Failed\n\n${snap.error}`;
                            } else {
                                const replaced = snap.rangeCompartments.length;
                                const preserved =
                                    snap.priorCompartments.length + snap.tailCompartments.length;
                                const warningLines = [
                                    "## ⚠️ Partial Recomp Confirmation Required",
                                    "",
                                    `Requested range: \`${parsedArgs.range.start}-${parsedArgs.range.end}\``,
                                    `Snapped to compartment boundaries: **messages ${snap.snapStart}-${snap.snapEnd}**`,
                                    "",
                                    `This will **rebuild ${replaced} compartment(s)** in the snapped range.`,
                                    `**${preserved} compartment(s)** outside the range will be preserved unchanged.`,
                                    "Facts will not be re-extracted.",
                                    "",
                                    "This operation:",
                                    "- May take several minutes to tens of minutes depending on range size",
                                    "- Will consume historian-model tokens for each chunk",
                                    "- Is resumable if interrupted (staging preserved on failure)",
                                    "",
                                    `**To confirm, run \`/ctx-recomp ${parsedArgs.range.start}-${parsedArgs.range.end}\` again within 60 seconds.**`,
                                ];
                                result = warningLines.join("\n");
                            }
                        } else {
                            const warningLines = [
                                "## ⚠️ Recomp Confirmation Required",
                                "",
                                `You currently have **${compartmentCount}** compartments.`,
                                "Running /ctx-recomp will **regenerate all compartments and facts** from raw session history.",
                                "",
                                "This operation:",
                                "- May take a long time (minutes to hours for long sessions)",
                                "- Will consume significant tokens on your historian model",
                                "- Cannot be interrupted cleanly once started",
                                "",
                                "Tip: to rebuild only a specific message range, use `/ctx-recomp <start>-<end>` (e.g. `/ctx-recomp 1-11322`).",
                                "",
                                "**To confirm, run `/ctx-recomp` again within 60 seconds.**",
                            ];
                            result = warningLines.join("\n");
                        }
                    }
                }
            }

            if (isSessionUpgrade) {
                // Before the first message, a TUI prompt may lack a bound session ID.
                if (!sessionId) {
                    result =
                        "## Session Upgrade\n\nThis prompt is not attached to a session yet — send a message first, then run `/ctx-session-upgrade`.";
                } else {
                    result = await executeSessionUpgrade(deps, sessionId);
                }
            }

            await deps.sendNotification(sessionId, result, {});
            sessionLog(sessionId, `command ${input.command} handled via command.execute.before`);

            throwSentinel(input.command);
        },
    };
}
