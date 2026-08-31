/**
 * The fail-closed gate blocks user-enabled sessions when Magic Context cannot operate because of a schema fence or storage open/migration failure.
 *
 * When blocking is armed, the harness transform throws an error on every primary-session pass.
 *
 * Outer transform wrappers pass through transient SQLite BUSY/LOCKED contention.
 */

import type { ProcessKind } from "../../shared/rpc-utils";

export const FAIL_CLOSED_DOCTOR_COMMAND = "npx @cortexkit/magic-context@latest doctor";

/** FAIL_CLOSED_REPROBE_EVERY_N sets the blocked-pass interval between storage-open retries; 1 retries every pass. */
export const FAIL_CLOSED_REPROBE_EVERY_N = 5;

export type FailClosedProcessKind = ProcessKind;

export interface FailClosedBlockingProcess {
    /** kind identifies the process holding the shared database. */
    kind?: FailClosedProcessKind;
    /** Legacy callers may still provide the old display label. */
    harness?: string;
    pid: number;
}

export type FailClosedReason =
    | {
          kind: "format_refusal";
          family: string;
          reasons: readonly string[];
      }
    | {
          kind: "schema_fence";
          persistedVersion: number;
          supportedVersion: number;
      }
    | {
          kind: "storage_failure";
          cause: string;
      };

export class FailClosedBlockingError extends Error {
    readonly code = "FAIL_CLOSED_BLOCKING";
    readonly reason: FailClosedReason;

    constructor(message: string, reason: FailClosedReason, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "FailClosedBlockingError";
        this.reason = reason;
    }
}

/** OpenCode native hidden agents bypass the gate. */
const OPENCODE_INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"]);

/**
 * Magic Context hidden-child jobs bypass blocking because blocking them stalls recovery and background maintenance.
 */
function isMagicContextHiddenAgentName(agent: string): boolean {
    if (
        agent === "sidekick" ||
        agent === "smart-note-compiler" ||
        agent.startsWith("smart-note-")
    ) {
        return true;
    }
    if (agent === "historian" || agent.startsWith("historian-")) return true;
    if (agent === "dreamer" || agent.startsWith("dreamer-")) return true;
    return false;
}

const MAX_FORMATTED_BLOCKING_PROCESSES = 8;

function normalizeFailClosedProcessKind(process: FailClosedBlockingProcess): FailClosedProcessKind {
    switch (process.kind) {
        case "OpenCode server":
        case "OpenCode instance (TUI/CLI)":
        case "Pi":
        case "process":
            return process.kind;
    }
    switch (process.harness?.trim().toLowerCase()) {
        case "opencode server":
            return "OpenCode server";
        case "opencode instance (tui/cli)":
        case "opencode instance":
            return "OpenCode instance (TUI/CLI)";
        case "pi":
        case "pi harness":
        case "omp":
            return "Pi";
        default:
            return "process";
    }
}

export function formatFailClosedBlockingProcesses(
    processes: readonly FailClosedBlockingProcess[],
): string {
    const uniqueProcesses = new Map<string, { kind: FailClosedProcessKind; pid: number }>();
    for (const process of processes) {
        if (!Number.isInteger(process.pid) || process.pid <= 0) continue;
        const kind = normalizeFailClosedProcessKind(process);
        uniqueProcesses.set(`${kind}\u0000${process.pid}`, { kind, pid: process.pid });
    }
    const entries = [...uniqueProcesses.values()];
    const visible = entries.slice(0, MAX_FORMATTED_BLOCKING_PROCESSES);
    const rendered = visible.map(({ kind, pid }) => `${kind} (PID ${pid})`);
    const omitted = entries.length - visible.length;
    if (omitted > 0) rendered.push(`${omitted} more blocking process(es)`);
    if (rendered.length === 0) return "a live process";
    if (rendered.length === 1) return rendered[0];
    const last = rendered.pop();
    return `${rendered.join(", ")}, and ${last}`;
}

export function formatFailClosedBlockingMessage(reason: FailClosedReason): string {
    if (reason.kind === "format_refusal") {
        const detail = reason.reasons.length > 0 ? ` (${reason.reasons.join("; ")})` : "";
        return [
            `Magic Context cannot operate: the shared database is not the supported direct claims format (${reason.family})${detail}. No data was changed.`,
            `To abandon this database family and start fresh, run '${FAIL_CLOSED_DOCTOR_COMMAND} reset-db'.`,
        ].join(" ");
    }
    if (reason.kind === "schema_fence") {
        return [
            `Magic Context cannot operate: this Magic Context build is older than the database; upgrade/restart this harness (upstream migration lane v${reason.persistedVersion}, build supports through v${reason.supportedVersion}).`,
            `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
        ].join(" ");
    }
    const cause = reason.cause.trim().length > 0 ? reason.cause.trim() : "unknown storage error";
    return [
        `Magic Context cannot operate: persistent storage failed (${cause}).`,
        "The plugin will not silently degrade to native compaction while enabled.",
        `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
    ].join(" ");
}

export function createFailClosedBlockingError(
    reason: FailClosedReason,
    options?: { cause?: unknown },
): FailClosedBlockingError {
    return new FailClosedBlockingError(formatFailClosedBlockingMessage(reason), reason, options);
}

export function isFailClosedBlockingError(error: unknown): error is FailClosedBlockingError {
    return (
        error instanceof FailClosedBlockingError ||
        (typeof error === "object" &&
            error !== null &&
            (error as { name?: string }).name === "FailClosedBlockingError" &&
            (error as { code?: string }).code === "FAIL_CLOSED_BLOCKING")
    );
}

/**
 * Primary user sessions are never exempt; internal OpenCode agents, Magic Context hidden children, and Pi subagent processes are exempt.
 */
export function shouldBypassFailClosedBlock(input: {
    agent?: string | null;
    isInternalChildSession?: boolean;
    isPiSubagentEnv?: boolean;
}): boolean {
    if (input.isPiSubagentEnv === true) return true;
    if (input.isInternalChildSession === true) return true;
    const agent = typeof input.agent === "string" ? input.agent.trim() : "";
    if (agent.length === 0) return false;
    if (OPENCODE_INTERNAL_AGENT_NAMES.has(agent)) return true;
    if (isMagicContextHiddenAgentName(agent)) return true;
    return false;
}

export function resolveAgentNameFromMessages(
    messages: ReadonlyArray<{ info?: unknown } | null | undefined>,
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const info = messages[i]?.info;
        if (!info || typeof info !== "object") continue;
        const agent = (info as { agent?: unknown }).agent;
        if (typeof agent === "string" && agent.length > 0) return agent;
    }
    return undefined;
}

export interface FailClosedController {
    arm(reason: FailClosedReason): void;
    clear(): void;
    isArmed(): boolean;
    getReason(): FailClosedReason | null;
    /**
     * The controller periodically re-probes storage and clears blocking when reopening succeeds.
     */
    enforce(input: {
        blockingEnabled: boolean;
        exempt: boolean;
        tryReopen?: () => boolean | Promise<boolean>;
    }): void | Promise<void>;
}

/**
 * The boot path arms the process-local controller on deterministic inoperability; the per-turn transform enforces and re-probes the controller.
 */
export function createFailClosedController(options?: {
    reprobeEveryN?: number;
}): FailClosedController {
    const reprobeEveryN = Math.max(1, options?.reprobeEveryN ?? FAIL_CLOSED_REPROBE_EVERY_N);
    let reason: FailClosedReason | null = null;
    let blockedPassCount = 0;

    return {
        arm(next: FailClosedReason): void {
            reason = next;
            blockedPassCount = 0;
        },
        clear(): void {
            reason = null;
            blockedPassCount = 0;
        },
        isArmed(): boolean {
            return reason !== null;
        },
        getReason(): FailClosedReason | null {
            return reason;
        },
        async enforce(input): Promise<void> {
            if (!reason) return;
            if (!input.blockingEnabled) return;
            if (input.exempt) return;

            blockedPassCount += 1;
            const shouldReprobe =
                typeof input.tryReopen === "function" &&
                (blockedPassCount === 1 || blockedPassCount % reprobeEveryN === 0);
            if (shouldReprobe) {
                try {
                    const healed = await input.tryReopen?.();
                    if (healed) {
                        reason = null;
                        blockedPassCount = 0;
                        return;
                    }
                } catch {
                    // The controller keeps blocking with the original reason after a failed re-probe.
                }
            }

            // A concurrent successful re-probe can clear the blocking reason while this re-probe awaits storage.
            const blockedReason = reason;
            if (!blockedReason) return;
            throw createFailClosedBlockingError(blockedReason);
        },
    };
}

/* */
export type HookInitFailure =
    | { type: "storage"; reason: FailClosedReason }
    | { type: "no_project" };

let lastHookInitFailure: HookInitFailure | null = null;

export function recordHookInitFailure(failure: HookInitFailure): void {
    lastHookInitFailure = failure;
}

export function clearHookInitFailure(): void {
    lastHookInitFailure = null;
}

export function getLastHookInitFailure(): HookInitFailure | null {
    return lastHookInitFailure;
}
