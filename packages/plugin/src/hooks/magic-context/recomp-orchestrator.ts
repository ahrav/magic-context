import {
    clearRecompStaging,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import {
    clearEmergencyRecovery,
    isWrapupInProgress,
} from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import {
    executeContextRecomp,
    executeContextRecompWithResult,
    type PartialRecompRange,
} from "./compartment-runner";
import type { RecompProgress } from "./compartment-runner-types";
import type { LiveSessionState } from "./live-session-state";
import { dropSlot } from "./lkg-slot";
import type { NotificationParams } from "./send-session-notification";

/**
 * */
function resolveLiveModelKey(
    liveSessionState: LiveSessionState,
    sessionId: string,
): string | undefined {
    const model = liveSessionState.liveModelBySession.get(sessionId);
    return model ? `${model.providerID}/${model.modelID}` : undefined;
}

/**
 *
 *
 */

/** Callers pass resolved config values to avoid coupling this context to RPC and hook config types.
 *  hook config. */
export interface ManagedRecompContext {
    client: PluginContext["client"];
    db: Database;
    liveSessionState: LiveSessionState;
    /* */
    directory: string;
    historianChunkTokens: number;
    historianTimeoutMs: number;
    memoryEnabled: boolean;
    autoPromote: boolean;
    /* */
    fallbackModels: readonly string[];
    language?: string;
    /**
     * */
    fallbackModelId?: string;
    userMemoriesEnabled: boolean;
    /* */
    historianTwoPass?: boolean;
    getNotificationParams: (sessionId: string) => NotificationParams;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
}

/**
 * */
export function isRecompFailure(message: string): boolean {
    return /—\s*(Failed|Skipped)/.test(message);
}

/**
 * */
export function isRecompSkip(message: string): boolean {
    return /—\s*Skipped|already mutating compartment state|already running/i.test(message);
}

/**
 * */
export function isRecompComplete(message: string): boolean {
    return /—\s*Complete/.test(message);
}

/**
 * */
export function extractRecompReason(raw: string): string {
    const meaningful = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    return meaningful.join(" ").trim() || "Recomp finished";
}

/**
 * The upgrade flow must direct retries to `/ctx-session-upgrade`, not `/ctx-recomp`.
 * Lease and active-run messages include retry guidance.
 */
export function contextualizeUpgradeReason(reason: string): string {
    const rewritten = reason.replace(/\/ctx-recomp\b/g, "/ctx-session-upgrade");
    if (/already mutating compartment state|lease|already running/i.test(rewritten)) {
        return "The history comparter is currently updating this session's tail. This is temporary — wait a few seconds, then run `/ctx-session-upgrade` again (or just send another message and re-run it). No changes were made.";
    }
    if (/missing the tiered paraphrase structure \(p1\.\.p4\)/i.test(rewritten)) {
        return `Your configured \`historian.model\` could not produce the required tiered (p1..p4) compartment output. Choose a historian model that can follow the XML format in magic-context.jsonc, then run \`/ctx-session-upgrade\` again. No compartments were rewritten. Validation error: ${rewritten}`;
    }
    return rewritten;
}

const RECOMP_DONE_GRACE_MS = 30_000;

/**
 * */
export function setRecompStarting(
    liveSessionState: LiveSessionState,
    sessionId: string,
    note: string,
    kind: "recomp" | "upgrade" | "embed" | "wrapup" = "recomp",
): void {
    dropSlot(sessionId, "recomp-start");
    liveSessionState.recompProgressBySession.set(sessionId, {
        sessionId,
        kind,
        phase: "recomp",
        processedMessages: 0,
        totalMessages: 0,
        passCount: 0,
        compartmentsCreated: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        note,
    });
}

/** Record a terminal recomp/upgrade phase ("done"/"failed") so the TUI shows the
 *  OUTCOME (not a missed toast). "done" auto-clears after a grace period; "failed"
 *  persists until the next run so the reason stays visible. */
export function setRecompTerminal(
    liveSessionState: LiveSessionState,
    sessionId: string,
    phase: "done" | "failed" | "skipped",
    message: string,
): void {
    const existing = liveSessionState.recompProgressBySession.get(sessionId);
    liveSessionState.recompProgressBySession.set(sessionId, {
        sessionId,
        kind: existing?.kind ?? "recomp",
        phase,
        processedMessages: existing?.processedMessages ?? 0,
        totalMessages: existing?.totalMessages ?? 0,
        passCount: existing?.passCount ?? 0,
        compartmentsCreated: existing?.compartmentsCreated ?? 0,
        startedAt: existing?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        message,
    });
    if (phase === "done" || phase === "skipped") {
        const t = setTimeout(() => {
            const cur = liveSessionState.recompProgressBySession.get(sessionId);
            if (cur?.phase === phase) liveSessionState.recompProgressBySession.delete(sessionId);
        }, RECOMP_DONE_GRACE_MS);
        (t as { unref?: () => void }).unref?.();
    }
}

/**
 * */
function buildRecompDeps(ctx: ManagedRecompContext, sessionId: string) {
    return {
        client: ctx.client,
        db: ctx.db,
        sessionId,
        historianChunkTokens: ctx.historianChunkTokens,
        historianTimeoutMs: ctx.historianTimeoutMs,
        directory: ctx.directory,
        memoryEnabled: ctx.memoryEnabled,
        autoPromote: ctx.autoPromote,
        fallbackModels: ctx.fallbackModels,
        language: ctx.language,
        fallbackModelId:
            ctx.fallbackModelId ?? resolveLiveModelKey(ctx.liveSessionState, sessionId),
        historianTwoPass: ctx.historianTwoPass,
        ensureProjectRegistered: ctx.ensureProjectRegistered,
        getNotificationParams: () => ctx.getNotificationParams(sessionId),
        onCompartmentStatePublished: (sid: string) => {
            ctx.liveSessionState.historyRefreshSessions.add(sid);
            ctx.liveSessionState.pendingMaterializationSessions.add(sid);
        },
        onDeferredMarkerPending: (sid: string) => {
            ctx.liveSessionState.deferredHistoryRefreshSessions.add(sid);
        },
        onRecompProgress: (p: RecompProgress) => {
            const prevKind =
                ctx.liveSessionState.recompProgressBySession.get(sessionId)?.kind ?? "recomp";
            ctx.liveSessionState.recompProgressBySession.set(sessionId, {
                ...p,
                kind: p.kind ?? prevKind,
            });
        },
    };
}

/**
 */
export async function runManagedRecomp(
    ctx: ManagedRecompContext,
    sessionId: string,
    options?: { range?: PartialRecompRange },
): Promise<string> {
    setRecompStarting(ctx.liveSessionState, sessionId, "Starting recomp…", "recomp");
    try {
        const message = await executeContextRecomp(buildRecompDeps(ctx, sessionId), options);
        const terminalPhase = isRecompSkip(message)
            ? "skipped"
            : isRecompFailure(message)
              ? "failed"
              : "done";
        if (terminalPhase === "done") {
            try {
                clearEmergencyRecovery(ctx.db, sessionId);
            } catch {
            }
        }
        setRecompTerminal(
            ctx.liveSessionState,
            sessionId,
            terminalPhase,
            extractRecompReason(message),
        );
        return message;
    } catch (error) {
        setRecompTerminal(
            ctx.liveSessionState,
            sessionId,
            "failed",
            `Recomp crashed: ${String(error)}`,
        );
        return `## Magic Recomp — Failed\n\nRecomp crashed: ${String(error)}`;
    }
}

export async function runManagedUpgrade(
    ctx: ManagedRecompContext,
    sessionId: string,
): Promise<string> {
    if (isWrapupInProgress(ctx.db, sessionId)) {
        const message =
            "/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-session-upgrade` again.";
        setRecompTerminal(ctx.liveSessionState, sessionId, "skipped", message);
        return `## Session Upgrade — Skipped\n\n${message}`;
    }
    setRecompStarting(ctx.liveSessionState, sessionId, "Starting upgrade…", "upgrade");
    try {
        //
        const compartments = getCompartments(ctx.db, sessionId);
        const legacyCount = compartments.filter(
            (c) => c.legacy === 1 || !c.p1 || c.p1.trim() === "",
        ).length;

        if (legacyCount === 0) {
            try {
                clearRecompStaging(ctx.db, sessionId);
            } catch {
                /* best-effort GC */
            }
            setRecompTerminal(ctx.liveSessionState, sessionId, "done", "Already upgraded");
            return [
                "## Session Upgrade — Already Up To Date",
                "",
                compartments.length === 0
                    ? "This session has no compartment history to upgrade yet."
                    : "This session's compartments are already in the current format.",
            ].join("\n");
        }

        const recompResult = await executeContextRecompWithResult(buildRecompDeps(ctx, sessionId));

        if (!recompResult.published || !isRecompComplete(recompResult.message)) {
            const reason = contextualizeUpgradeReason(
                isRecompFailure(recompResult.message)
                    ? extractRecompReason(recompResult.message)
                    : `Compartments were not fully rebuilt: ${extractRecompReason(recompResult.message)}`,
            );
            setRecompTerminal(ctx.liveSessionState, sessionId, "failed", reason);
            return `## Session Upgrade — Incomplete\n\n${reason}`;
        }

        setRecompTerminal(ctx.liveSessionState, sessionId, "done", "Upgrade complete");
        return ["## Session Upgrade — Complete", "", recompResult.message].join("\n");
    } catch (error) {
        setRecompTerminal(
            ctx.liveSessionState,
            sessionId,
            "failed",
            `Upgrade crashed: ${String(error)}`,
        );
        return `## Session Upgrade — Failed\n\nUpgrade crashed: ${String(error)}`;
    }
}
