import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createDirectTestDatabase } from "./test-database";
import {
    __resetToolDefinitionMeasurements,
    getMeasuredToolDefinitionTokens,
    getToolDefinitionSnapshot,
    loadToolDefinitionMeasurements,
    recordToolDefinition,
    setDatabase,
} from "./tool-definition-tokens";

function createTestDb(): Database {
    return createDirectTestDatabase().db;
}

describe("tool-definition-tokens", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("returns undefined before any measurement", () => {
        expect(
            getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus"),
        ).toBeUndefined();
    });

    test("records and retrieves tokens for a provider/model/agent key", () => {
        recordToolDefinition(
            "anthropic",
            "claude-sonnet-4.7",
            "sisyphus",
            "bash",
            "Run a shell command",
            { type: "object", properties: { command: { type: "string" } } },
        );
        const total = getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus");
        expect(total).toBeGreaterThan(0);
        expect(total).toBeGreaterThan(5);
    });

    test("sums multiple tools under same key", () => {
        recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
            type: "object",
        });
        recordToolDefinition("p", "m", "a", "edit", "Edit a file", {
            type: "object",
        });
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(total).toBeGreaterThan(0);

        recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
            type: "object",
        });
        const after = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(after).toBe(total);
    });

    test("isolates measurements by agent within same model", () => {
        recordToolDefinition("p", "m", "sisyphus", "bash", "x".repeat(100), {});
        recordToolDefinition("p", "m", "historian", "summarize", "y".repeat(50), {});
        const a = getMeasuredToolDefinitionTokens("p", "m", "sisyphus") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "m", "historian") ?? 0;
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(0);
        expect(a).not.toBe(b);
    });

    test("isolates measurements by model within same agent", () => {
        recordToolDefinition("p", "model-a", "sisyphus", "bash", "x".repeat(100), {});
        recordToolDefinition("p", "model-b", "sisyphus", "bash", "x".repeat(50), {});
        const a = getMeasuredToolDefinitionTokens("p", "model-a", "sisyphus") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "model-b", "sisyphus") ?? 0;
        expect(a).toBeGreaterThan(b);
    });

    test("treats missing agent as 'default' scope", () => {
        recordToolDefinition("p", "m", undefined, "bash", "x".repeat(40), {});
        const explicit = getMeasuredToolDefinitionTokens("p", "m", "default");
        const implicit = getMeasuredToolDefinitionTokens("p", "m", undefined);
        expect(explicit).toBe(implicit);
        expect(implicit).toBeGreaterThan(0);
    });

    test("same toolID on later flight overwrites its slot, not accumulates", () => {
        recordToolDefinition("p", "m", "a", "bash", "v1 description", { v: 1 });
        const first = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        recordToolDefinition("p", "m", "a", "bash", "v2 description", { v: 2 });
        const second = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        // Second flight replaces first — totals should reflect v2 only, not v1+v2.
        expect(second).toBeGreaterThan(0);
        expect(second).not.toBe(first * 2);
    });

    test("ignores invalid inputs", () => {
        recordToolDefinition("", "m", "a", "bash", "desc", {});
        recordToolDefinition("p", "", "a", "bash", "desc", {});
        recordToolDefinition("p", "m", "a", "", "desc", {});
        expect(getMeasuredToolDefinitionTokens("", "m", "a")).toBeUndefined();
        expect(getMeasuredToolDefinitionTokens("p", "", "a")).toBeUndefined();
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBeUndefined();
    });

    test("handles unserializable parameters without throwing", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        // recordToolDefinition does not throw when JSON.stringify fails.
        recordToolDefinition("p", "m", "a", "bad-tool", "desc", circular);
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        // Description still contributes even if params can't be serialized.
        expect(total).toBeGreaterThan(0);
    });

    test("snapshot helper lists all measurements", () => {
        recordToolDefinition("anthropic", "sonnet", "sisyphus", "bash", "a", {});
        recordToolDefinition("openai", "gpt-5", "historian", "sum", "b", {});
        const snapshot = getToolDefinitionSnapshot();
        expect(snapshot.length).toBe(2);
        expect(snapshot.every((s) => s.totalTokens > 0)).toBe(true);
        expect(snapshot.every((s) => s.toolCount === 1)).toBe(true);
    });
});

describe("tool-definition-tokens persistence (bug #2)", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("loadToolDefinitionMeasurements restores in-memory map after reset", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition(
                "anthropic",
                "claude-sonnet-4.7",
                "sisyphus",
                "bash",
                "Run a shell command",
                { type: "object", properties: { command: { type: "string" } } },
            );
            const beforeReset = getMeasuredToolDefinitionTokens(
                "anthropic",
                "claude-sonnet-4.7",
                "sisyphus",
            );
            expect(beforeReset).toBeGreaterThan(0);

            // __resetToolDefinitionMeasurements() clears the in-memory map without deleting the SQLite row.
            // resetMeasurements() preserves the SQLite row and clears persistenceDb.
            __resetToolDefinitionMeasurements();
            expect(
                getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus"),
            ).toBeUndefined();

            // SQLite rehydration restores the persisted measurement.
            loadToolDefinitionMeasurements(db);
            const afterLoad = getMeasuredToolDefinitionTokens(
                "anthropic",
                "claude-sonnet-4.7",
                "sisyphus",
            );
            expect(afterLoad).toBe(beforeReset);
        } finally {
            closeQuietly(db);
        }
    });

    test("INSERT OR REPLACE updates token_count when same key re-recorded", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "v1 description", { v: 1 });
            // The query verifies persistence independently of the in-memory map.
            const firstRow = db
                .prepare(
                    "SELECT token_count FROM tool_definition_measurements WHERE provider_id=? AND model_id=? AND agent_name=? AND tool_id=?",
                )
                .get("p", "m", "a", "bash") as { token_count: number } | undefined;
            expect(firstRow).toBeDefined();
            const firstCount = firstRow?.token_count ?? 0;
            expect(firstCount).toBeGreaterThan(0);

            // Re-recording the same key must retain one row with the latest token_count.
            recordToolDefinition("p", "m", "a", "bash", "v2 description ".repeat(50), { v: 2 });

            const allRows = db
                .prepare(
                    "SELECT token_count FROM tool_definition_measurements WHERE provider_id=? AND model_id=? AND agent_name=? AND tool_id=?",
                )
                .all("p", "m", "a", "bash") as Array<{ token_count: number }>;
            expect(allRows.length).toBe(1); // No duplicate row.
            expect(allRows[0].token_count).toBeGreaterThan(firstCount);

            // After reload, in-memory total reflects the new (larger) value.
            __resetToolDefinitionMeasurements();
            loadToolDefinitionMeasurements(db);
            const reloaded = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(reloaded).toBe(allRows[0].token_count);
        } finally {
            closeQuietly(db);
        }
    });

    test("recordToolDefinition without setDatabase still updates in-memory map", () => {
        // Before setDatabase(), recording must update the in-memory map without throwing.
        recordToolDefinition("p", "m", "a", "bash", "desc", {});
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(total).toBeGreaterThan(0);
    });
});

describe("tool-definition-tokens fingerprint skip", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("repeat fire with identical inputs does NOT write to SQLite", () => {
        // Matching fingerprints skip serialization, tokenization, and SQLite writes.
        // observable proof.
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
                type: "object",
                properties: { command: { type: "string" } },
            });
            const recordedAtAfterFirst = (
                db
                    .prepare("SELECT recorded_at FROM tool_definition_measurements WHERE tool_id=?")
                    .get("bash") as { recorded_at: number }
            ).recorded_at;

            // The test mutates recorded_at to detect an unexpected SQLite write.
            db.prepare("UPDATE tool_definition_measurements SET recorded_at=? WHERE tool_id=?").run(
                1, // Sentinel: any later write will overwrite this.
                "bash",
            );

            // Identical re-fire — must skip the SQLite write.
            recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
                type: "object",
                properties: { command: { type: "string" } },
            });

            const recordedAtAfterSecond = (
                db
                    .prepare("SELECT recorded_at FROM tool_definition_measurements WHERE tool_id=?")
                    .get("bash") as { recorded_at: number }
            ).recorded_at;
            expect(recordedAtAfterSecond).toBe(1); // Sentinel preserved → skip held.
            expect(recordedAtAfterFirst).toBeGreaterThan(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("changed description re-measures and re-writes", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "v1", { type: "object" });
            db.prepare("UPDATE tool_definition_measurements SET recorded_at=? WHERE tool_id=?").run(
                1,
                "bash",
            );

            // A changed description produces a new fingerprint and remeasures the tool.
            recordToolDefinition("p", "m", "a", "bash", "v2 description longer", {
                type: "object",
            });

            const row = db
                .prepare("SELECT recorded_at FROM tool_definition_measurements WHERE tool_id=?")
                .get("bash") as { recorded_at: number };
            expect(row.recorded_at).toBeGreaterThan(1); // Sentinel overwritten.
        } finally {
            closeQuietly(db);
        }
    });

    test("changed parameters key set re-measures", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            const tokensBefore = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;

            // Changing parameter keys changes the fingerprint and triggers remeasurement.
            recordToolDefinition("p", "m", "a", "bash", "desc", {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
            });
            const tokensAfter = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(tokensAfter).toBeGreaterThan(tokensBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("changed nested parameter schema re-measures", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", {
                type: "object",
                properties: { command: { type: "string", description: "short" } },
            });
            db.prepare("UPDATE tool_definition_measurements SET recorded_at=? WHERE tool_id=?").run(
                1,
                "bash",
            );

            const tokensBefore = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            recordToolDefinition("p", "m", "a", "bash", "desc", {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "much longer nested description ".repeat(200),
                    },
                },
            });
            const tokensAfter = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;

            expect(tokensAfter).toBeGreaterThan(tokensBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("skip is per-toolID — different tool always measured", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            // A different toolID with identical inputs must not skip measurement.
            // The fingerprint map is scoped by toolID within each composite key.
            // {provider,model,agent} key.
            recordToolDefinition("p", "m", "a", "edit", "desc", { type: "object" });
            const snapshot = getToolDefinitionSnapshot();
            expect(snapshot[0].toolCount).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });

    test("skip is per-key — different agent always measured", () => {
        // The (provider, model, agent) composite key isolates measurements.
        // A different agent triggers measurement for the same toolID.
        recordToolDefinition("p", "m", "agentA", "bash", "desc", { type: "object" });
        recordToolDefinition("p", "m", "agentB", "bash", "desc", { type: "object" });
        const a = getMeasuredToolDefinitionTokens("p", "m", "agentA") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "m", "agentB") ?? 0;
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(0);
    });

    test("__resetToolDefinitionMeasurements clears fingerprints too", () => {
        // Reset clears fingerprints, so the next fire is not skipped.
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            __resetToolDefinitionMeasurements();
            // resetMeasurements clears the database reference; call setDatabase() before re-firing to persist the measurement.
            // After setDatabase(), re-firing records a measurement rather than skipping it.
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(total).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });
});
