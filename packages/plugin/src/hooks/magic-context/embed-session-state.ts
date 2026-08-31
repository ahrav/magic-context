import type { RecompProgress } from "./compartment-runner-types";

/* */
export const embedPauseBySession = new Set<string>();

/* */
export const embedRunStateBySession = new Map<string, AbortController>();

/* */
export const autoEmbedAttemptedBySession = new Set<string>();

export type EmbedDrainUiStatus = "idle" | "running" | "paused" | "stopped";

export function getEmbedDrainUiStatus(
    sessionId: string,
    progress: RecompProgress | undefined,
): { status: EmbedDrainUiStatus; detail?: string } {
    if (embedPauseBySession.has(sessionId)) {
        return { status: "paused" };
    }
    if (progress?.kind === "embed" && progress.phase === "recomp") {
        return { status: "running" };
    }
    if (
        progress?.kind === "embed" &&
        (progress.phase === "failed" || progress.phase === "skipped") &&
        progress.message
    ) {
        if (/provider/i.test(progress.message)) {
            return { status: "stopped", detail: progress.message };
        }
    }
    return { status: "idle" };
}

export function clearEmbedSessionState(sessionId: string): void {
    embedPauseBySession.delete(sessionId);
    const ctrl = embedRunStateBySession.get(sessionId);
    if (ctrl) {
        ctrl.abort();
        embedRunStateBySession.delete(sessionId);
    }
    autoEmbedAttemptedBySession.delete(sessionId);
}
