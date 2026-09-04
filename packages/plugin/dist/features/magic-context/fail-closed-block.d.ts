/**
 * Loud fail-closed blocking when Magic Context cannot operate on a session the
 * user enabled it for (schema fence, storage open/migration failure).
 *
 * Motivation: a schema-fence refusal used to unregister hooks and silently fall
 * through to native compaction — the user saw a 136%+ overflow with zero signal.
 * When blocking is armed, the harness transform throws an actionable error every
 * primary-session pass instead of degrading quietly.
 *
 * Transient SQLite contention (BUSY/LOCKED) is intentionally NOT handled here —
 * those stay fail-open pass-through in the outer transform wrappers.
 */
import type { ProcessKind } from "../../shared/rpc-utils";
export declare const FAIL_CLOSED_DOCTOR_COMMAND = "npx @cortexkit/magic-context@latest doctor";
/** How often a blocked transform pass re-attempts storage open (1 = every pass). */
export declare const FAIL_CLOSED_REPROBE_EVERY_N = 5;
export type FailClosedProcessKind = ProcessKind;
export interface FailClosedBlockingProcess {
    /** The detected kind of process holding the shared database. */
    kind?: FailClosedProcessKind;
    /** Legacy callers may still provide the old display label. */
    harness?: string;
    pid: number;
}
export type FailClosedReason = {
    kind: "format_refusal";
    family: string;
    reasons: readonly string[];
} | {
    kind: "schema_fence";
    persistedVersion: number;
    supportedVersion: number;
} | {
    kind: "storage_failure";
    cause: string;
};
export declare class FailClosedBlockingError extends Error {
    readonly code = "FAIL_CLOSED_BLOCKING";
    readonly reason: FailClosedReason;
    constructor(message: string, reason: FailClosedReason, options?: {
        cause?: unknown;
    });
}
export declare function formatFailClosedBlockingProcesses(processes: readonly FailClosedBlockingProcess[]): string;
export declare function formatFailClosedBlockingMessage(reason: FailClosedReason): string;
export declare function createFailClosedBlockingError(reason: FailClosedReason, options?: {
    cause?: unknown;
}): FailClosedBlockingError;
export declare function isFailClosedBlockingError(error: unknown): error is FailClosedBlockingError;
/**
 * Whether this transform/context pass should skip the loud block.
 * Primary user sessions are never exempt; internal OpenCode agents, Magic
 * Context hidden children, and Pi subagent processes are.
 */
export declare function shouldBypassFailClosedBlock(input: {
    agent?: string | null;
    isInternalChildSession?: boolean;
    isPiSubagentEnv?: boolean;
}): boolean;
export declare function resolveAgentNameFromMessages(messages: ReadonlyArray<{
    info?: unknown;
} | null | undefined>): string | undefined;
export interface FailClosedController {
    arm(reason: FailClosedReason): void;
    clear(): void;
    isArmed(): boolean;
    getReason(): FailClosedReason | null;
    /**
     * Enforce the gate for one transform/context pass.
     * - No-op when unarmed, when blocking is disabled, or when the pass is exempt.
     * - Periodically re-probes storage; clears and returns when reopen succeeds.
     * - Otherwise throws {@link FailClosedBlockingError}.
     */
    enforce(input: {
        blockingEnabled: boolean;
        exempt: boolean;
        tryReopen?: () => boolean | Promise<boolean>;
    }): void | Promise<void>;
}
/**
 * Process-local controller shared by the boot path (arms on deterministic
 * inoperability) and the per-turn transform (enforces / re-probes).
 */
export declare function createFailClosedController(options?: {
    reprobeEveryN?: number;
}): FailClosedController;
/** Hook-init classification so boot can arm the gate only for storage failures. */
export type HookInitFailure = {
    type: "storage";
    reason: FailClosedReason;
} | {
    type: "no_project";
};
export declare function recordHookInitFailure(failure: HookInitFailure): void;
export declare function clearHookInitFailure(): void;
export declare function getLastHookInitFailure(): HookInitFailure | null;
//# sourceMappingURL=fail-closed-block.d.ts.map