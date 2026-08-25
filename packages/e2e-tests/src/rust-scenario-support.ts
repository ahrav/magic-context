/**
 * Shared support for the Rust-mode incident-corpus scenarios.
 *
 * Gating layers:
 *
 *  1. Prerequisite gating checks Cargo, workspace metadata, and Unix sockets.
 *
 *  2. Fold scenarios remain gated for broad Rust qualification.
 *
 * The tail-mutation-readopt and park-self-heal scenarios are NOT gated: the P0
 * identity-drift / park-self-heal fix is merged into this branch's base, so they
 * assert the shipped mechanism (re-adopt, no permanent park) by default.
 */

import {
    RUST_EMERGENCY_WALL_PCT,
    RUST_FAILURE_PARK_THRESHOLD,
    RUST_PARK_PROBE_PRESSURE_BYPASS_PCT,
    RUST_PARK_RETRY_INTERVAL,
} from "../../plugin/src/hooks/magic-context/rust-mode-transform";
import { RustTestHarness } from "./rust-harness";

export {
    RUST_EMERGENCY_WALL_PCT,
    RUST_FAILURE_PARK_THRESHOLD,
    RUST_PARK_PROBE_PRESSURE_BYPASS_PCT,
    RUST_PARK_RETRY_INTERVAL,
};

export const rustPrereqs = RustTestHarness.detectPrereqs();

export function foldInfraEnabled(): boolean {
    return process.env.MC_RUST_E2E_FOLD === "1";
}

export const FOLD_SKIP_REASON =
    "requires broad Rust fold qualification beyond the focused direct " +
    "backend fixture; set MC_RUST_E2E_FOLD=1 to run it";

/** Enable the duplicate-ID regression only when the stack can produce the selection refresh needed to reproduce duplicate IDs. */
export function duplicateIdInfraEnabled(): boolean {
    return process.env.MC_RUST_E2E_DUPLICATE_IDS === "1";
}

export const DUPLICATE_ID_SKIP_REASON =
    "requires broad duplicate-ID qualification beyond the focused direct " +
    "backend fixture; set MC_RUST_E2E_DUPLICATE_IDS=1 to run it";

/**
 * Print a one-line skip notice. Call from a gated scenario's single `it` so the
 * reason is visible in the lane output (never a silent skip).
 */
export function printSkip(scenario: string, reason: string): void {
    console.log(`[rust-e2e] ${scenario} SKIPPED: ${reason}`);
}

/**
 * Drive a session to a steady SOFT+ defer state: one HARD first render followed
 * by `deferPasses` defers, each below any threshold. Returns once at least
 * `1 + deferPasses` rust passes are observed. Shared by scenarios that need an
 * established lineage before perturbing it.
 */
export async function driveToSteadyState(
    h: RustTestHarness,
    sessionId: string,
    deferPasses = 4,
): Promise<void> {
    for (let i = 1; i <= 1 + deferPasses; i += 1) {
        h.mock.setDefault({
            text: `steady assistant ${i}`,
            usage: {
                input_tokens: 2_000 * i,
                output_tokens: 20,
                cache_creation_input_tokens: 1_000,
            },
        });
        await h.sendPrompt(sessionId, `steady turn ${i}: ${h.ballast(400)}`);
    }
    await h.waitForRustPasses(1 + deferPasses);
}

/**
 * Keep placeholder checks scoped to the provider's messages array. The request
 * body also contains guidance that documents placeholder syntax, so scanning
 * the whole body would test the fixture's instructions instead of its output.
 */
export function assertMessagesHaveNoPlaceholders(
    messages: readonly unknown[],
    lineageKey: string,
): void {
    if (lineageKey.length === 0) throw new Error("placeholder assertion requires a lineage key");
    const serializedMessages = JSON.stringify(messages);
    if (/\[dropped §\d+§\]|\[truncated §\d+§\]/.test(serializedMessages)) {
        throw new Error(`placeholder found in messages[] for lineage ${lineageKey}`);
    }
}

/** Every tag/drop read is explicitly scoped to the session lineage under test. */
export function lineageScopedTagCount(
    h: RustTestHarness,
    sessionId: string,
    status: string,
): number {
    if (sessionId.length === 0) throw new Error("lineage-scoped assertion requires a session id");
    return h.countTagsByStatus(sessionId, status);
}

export function sessionLogLines(h: RustTestHarness, sessionId: string): string[] {
    if (sessionId.length === 0) throw new Error("log assertion requires a session id");
    return h
        .diagnosticLog()
        .split("\n")
        .filter((line) => line.includes(`[${sessionId}]`));
}

export function assertLoudModuleFailure(h: RustTestHarness, sessionId: string): string[] {
    const lines = sessionLogLines(h, sessionId);
    if (!lines.some((line) => line.includes("rust transform failed"))) {
        throw new Error(`module failure was not logged for lineage ${sessionId}`);
    }
    return lines;
}

export function assertExactlyOneLkgOutcome(lines: readonly string[], sessionId: string): void {
    const outcomes = lines.filter((line) =>
        /lkg_(?:replay_served|miss|invalidated|model_mismatch|content_mismatch|seam)/.test(line),
    );
    if (outcomes.length !== 1) {
        throw new Error(
            `expected one terminal LKG outcome for lineage ${sessionId}, got ${outcomes.length}`,
        );
    }
}

export async function sendOutagePasses(
    h: RustTestHarness,
    sessionId: string,
    start: number,
    count: number,
    label: string,
    inputTokens = 2_000,
): Promise<void> {
    for (let offset = 0; offset < count; offset += 1) {
        const turn = start + offset;
        h.mock.setDefault({
            text: `${label} assistant ${turn}`,
            usage: {
                input_tokens: inputTokens,
                output_tokens: 20,
                cache_creation_input_tokens: 1_000,
            },
        });
        await h.sendPrompt(sessionId, `${label} turn ${turn}: ${h.ballast(400)}`);
    }
}
