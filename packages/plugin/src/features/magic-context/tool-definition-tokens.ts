/**
 *
 *
 *
 *
 *
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { Database, Statement } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";

// Each measurement covers a tool's description and parameters.
const measurements = new Map<string, Map<string, number>>();

// A matching fingerprint skips recomputation; `measurements` retains the token count.
const fingerprints = new Map<string, Map<string, string>>();

// Before initialization, `recordToolDefinition()` does not persist measurements.
let persistenceDb: Database | null = null;

// The cached statement avoids recompilation on each write.
// `cachedInsertStmt` initializes on first use after `setDatabase()`.
// `cachedInsertStmt` is cleared on reset and database rebind.
let cachedInsertStmt: Statement | null = null;

function keyFor(providerID: string, modelID: string, agentName: string | undefined): string {
    const agent = agentName && agentName.length > 0 ? agentName : "default";
    return `${providerID}/${modelID}/${agent}`;
}

/**
 * Build a stable fingerprint of all inputs that determine the measured value.
 * Nested schema changes invalidate cached token counts.
 */
function fingerprintFor(description: string, parameters: unknown): string {
    return createHash("sha256")
        .update(description)
        .update("\0")
        .update(stableStringify(parameters))
        .digest("hex");
}

/**
 * `recordToolDefinition()` requires `tool_definition_measurements` to exist before it can persist measurements.
 * `recordToolDefinition()` attempts to persist subsequent measurements to SQLite.
 */
export function setDatabase(db: Database): void {
    persistenceDb = db;
    // A DB rebind clears cached statements compiled for the previous handle.
    // previous handle.
    cachedInsertStmt = null;
}

/**
 * Call `loadToolDefinitionMeasurements()` after `setDatabase()` and before the first sidebar snapshot or status query.
 *
 * Re-running over the same DB overwrites existing values instead of accumulating them.
 */
export function loadToolDefinitionMeasurements(db: Database): void {
    let rows: Array<{
        provider_id: string;
        model_id: string;
        agent_name: string;
        tool_id: string;
        token_count: number;
    }> = [];
    try {
        rows = db
            .prepare(
                "SELECT provider_id, model_id, agent_name, tool_id, token_count FROM tool_definition_measurements",
            )
            .all() as typeof rows;
    } catch {
        return;
    }

    for (const row of rows) {
        const key = keyFor(row.provider_id, row.model_id, row.agent_name);
        let inner = measurements.get(key);
        if (!inner) {
            inner = new Map<string, number>();
            measurements.set(key, inner);
        }
        inner.set(row.tool_id, row.token_count);
    }
    // Do not seed fingerprints from persisted measurements.
    // The first record after restart computes and stores a fingerprint because persisted measurements do not include fingerprints.
}

/**
 * `toolID` overwrites its measurement so the key total remains correct when a tool definition changes.
 */
export function recordToolDefinition(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    toolID: string,
    description: string,
    parameters: unknown,
): void {
    if (!providerID || !modelID || !toolID) return;
    const key = keyFor(providerID, modelID, agentName);

    const fp = fingerprintFor(description ?? "", parameters);
    let innerFp = fingerprints.get(key);
    if (innerFp && innerFp.get(toolID) === fp) return;

    // `parameters === undefined` is stored as an empty string because `JSON.stringify(undefined)` returns `undefined`.
    let paramsText = "";
    try {
        paramsText = parameters === undefined ? "" : JSON.stringify(parameters);
    } catch {
        paramsText = "";
    }

    // `tokens` excludes provider-level `tools` array syntax.
    const tokens = estimateTokens(description ?? "") + estimateTokens(paramsText);

    let inner = measurements.get(key);
    if (!inner) {
        inner = new Map<string, number>();
        measurements.set(key, inner);
    }
    inner.set(toolID, tokens);

    // Store the fingerprint after the measurement so an earlier failure cannot suppress a later retry.
    // defensive.)
    if (!innerFp) {
        innerFp = new Map<string, string>();
        fingerprints.set(key, innerFp);
    }
    innerFp.set(toolID, fp);

    // Measurements recorded while `persistenceDb` is unset remain only in memory.
    if (persistenceDb) {
        try {
            const agent = agentName && agentName.length > 0 ? agentName : "default";
            if (!cachedInsertStmt) {
                cachedInsertStmt = persistenceDb.prepare(
                    `INSERT OR REPLACE INTO tool_definition_measurements
                     (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                );
            }
            cachedInsertStmt.run(providerID, modelID, agent, toolID, tokens, Date.now());
        } catch {
            // A SQLite write failure must not prevent updating the in-memory measurement.
            // Discard the cached statement so the next attempt recompiles it.
            cachedInsertStmt = null;
        }
    }
}

/**
 */
export function getMeasuredToolDefinitionTokens(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
): number | undefined {
    if (!providerID || !modelID) return undefined;
    const inner = measurements.get(keyFor(providerID, modelID, agentName));
    if (!inner || inner.size === 0) return undefined;
    let total = 0;
    for (const tokens of inner.values()) total += tokens;
    return total;
}

/* */
export function __resetToolDefinitionMeasurements(): void {
    measurements.clear();
    fingerprints.clear();
    persistenceDb = null;
    cachedInsertStmt = null;
}

/* */
export function getToolDefinitionSnapshot(): Array<{
    key: string;
    totalTokens: number;
    toolCount: number;
}> {
    return Array.from(measurements.entries()).map(([key, inner]) => {
        let total = 0;
        for (const tokens of inner.values()) total += tokens;
        return { key, totalTokens: total, toolCount: inner.size };
    });
}
