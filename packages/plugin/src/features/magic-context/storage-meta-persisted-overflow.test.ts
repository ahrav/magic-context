/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    clearEmergencyRecovery,
    getOverflowState,
    recordDetectedContextLimit,
    recordOverflowDetected,
} from "./storage-meta-persisted";
import { ensureSessionMetaRow } from "./storage-meta-shared";

/**
 * Tests require only the session_meta columns used by overflow state functions.
 */
function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            last_response_time INTEGER NOT NULL DEFAULT 0,
            cache_ttl TEXT NOT NULL DEFAULT '5m',
            counter INTEGER NOT NULL DEFAULT 0,
            last_nudge_tokens INTEGER NOT NULL DEFAULT 0,
            last_nudge_band TEXT NOT NULL DEFAULT '',
            last_transform_error TEXT NOT NULL DEFAULT '',
            is_subagent INTEGER NOT NULL DEFAULT 0,
            last_context_percentage REAL NOT NULL DEFAULT 0,
            last_input_tokens INTEGER NOT NULL DEFAULT 0,
            observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_alert_sent INTEGER NOT NULL DEFAULT 0,
            times_execute_threshold_reached INTEGER NOT NULL DEFAULT 0,
            compartment_in_progress INTEGER NOT NULL DEFAULT 0,
            system_prompt_hash TEXT NOT NULL DEFAULT '',
            system_prompt_tokens INTEGER NOT NULL DEFAULT 0,
            conversation_tokens INTEGER NOT NULL DEFAULT 0,
            tool_call_tokens INTEGER NOT NULL DEFAULT 0,
            cleared_reasoning_through_tag INTEGER NOT NULL DEFAULT 0,
            detected_context_limit INTEGER NOT NULL DEFAULT 0,
            detected_context_limit_model_key TEXT,
            detected_context_limit_provenance TEXT NOT NULL DEFAULT 'unknown',
            needs_emergency_recovery INTEGER NOT NULL DEFAULT 0,
            emergency_recovery_origin TEXT NOT NULL DEFAULT '',
            harness TEXT NOT NULL DEFAULT 'opencode'
        )
    `);
    return db;
}

describe("recordDetectedContextLimit", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it("records the detected limit WITHOUT arming recovery", () => {
        ensureSessionMetaRow(db, "ses_subagent_1");
        recordDetectedContextLimit(db, "ses_subagent_1", 120_000, undefined, "prompt_only");

        const state = getOverflowState(db, "ses_subagent_1");
        expect(state.detectedContextLimit).toBe(120_000);
        expect(state.detectedContextLimitProvenance).toBe("prompt_only");
        expect(state.needsEmergencyRecovery).toBe(false);
        expect(state.emergencyRecoveryOrigin).toBeNull();
    });

    it("is a no-op when reportedLimit is zero or negative", () => {
        ensureSessionMetaRow(db, "ses_subagent_2");
        recordDetectedContextLimit(db, "ses_subagent_2", 0);
        recordDetectedContextLimit(db, "ses_subagent_2", -1);

        const state = getOverflowState(db, "ses_subagent_2");
        expect(state.detectedContextLimit).toBe(0);
        expect(state.needsEmergencyRecovery).toBe(false);
    });

    it("creates the session_meta row when missing (like recordOverflowDetected)", () => {
        recordDetectedContextLimit(db, "ses_fresh", 64_000);

        const state = getOverflowState(db, "ses_fresh");
        expect(state.detectedContextLimit).toBe(64_000);
        expect(state.needsEmergencyRecovery).toBe(false);
    });

    it("does NOT overwrite an existing recovery flag set by primary path", () => {
        ensureSessionMetaRow(db, "ses_mixed");
        recordOverflowDetected(
            db,
            "ses_mixed",
            100_000,
            undefined,
            "provider_overflow",
            "combined",
        ); // Primary write records both the detected limit and its accounting provenance.

        recordDetectedContextLimit(db, "ses_mixed", 80_000, undefined, "prompt_only"); // Prompt-only write records an accepted-input ceiling without reserving output again.

        const state = getOverflowState(db, "ses_mixed");
        expect(state.detectedContextLimit).toBe(80_000); // updated
        expect(state.detectedContextLimitProvenance).toBe("prompt_only");
        expect(state.needsEmergencyRecovery).toBe(true); // preserved
        expect(state.emergencyRecoveryOrigin).toBe("provider_overflow");
    });

    it("keys detected limits by model when a model key is known", () => {
        ensureSessionMetaRow(db, "ses_model_keyed");
        recordDetectedContextLimit(db, "ses_model_keyed", 80_000, "anthropic/claude-small");

        const sameModel = getOverflowState(db, "ses_model_keyed", "anthropic/claude-small");
        const otherModel = getOverflowState(db, "ses_model_keyed", "anthropic/claude-large");

        expect(sameModel.detectedContextLimit).toBe(80_000);
        expect(sameModel.detectedContextLimitModelKey).toBe("anthropic/claude-small");
        expect(otherModel.detectedContextLimit).toBe(0);
        expect(otherModel.detectedContextLimitModelKey).toBe("anthropic/claude-small");
    });

    it("keeps legacy unkeyed detected limits usable", () => {
        ensureSessionMetaRow(db, "ses_legacy_limit");
        recordDetectedContextLimit(db, "ses_legacy_limit", 64_000);

        expect(getOverflowState(db, "ses_legacy_limit", "openai/gpt-4o").detectedContextLimit).toBe(
            64_000,
        );
    });

    it("persists proactive model-shrink origin without a detected limit", () => {
        recordOverflowDetected(
            db,
            "ses_proactive",
            undefined,
            "openai/smaller",
            "proactive_model_shrink",
        );

        expect(getOverflowState(db, "ses_proactive")).toMatchObject({
            detectedContextLimit: 0,
            needsEmergencyRecovery: true,
            emergencyRecoveryOrigin: "proactive_model_shrink",
        });
    });

    it("treats a legacy armed row with a detected limit as provider-proven", () => {
        ensureSessionMetaRow(db, "ses_legacy_provider");
        db.prepare(
            "UPDATE session_meta SET detected_context_limit = 64000, needs_emergency_recovery = 1, emergency_recovery_origin = '' WHERE session_id = ?",
        ).run("ses_legacy_provider");

        expect(getOverflowState(db, "ses_legacy_provider").emergencyRecoveryOrigin).toBe(
            "provider_overflow",
        );
    });

    it("clears cache-regression sentinels when a real overflow limit is recorded", () => {
        ensureSessionMetaRow(db, "ses_overflow_clears_alert");
        db.prepare(
            "UPDATE session_meta SET observed_safe_input_tokens = 90000, cache_alert_sent = 1 WHERE session_id = ?",
        ).run("ses_overflow_clears_alert");

        recordOverflowDetected(db, "ses_overflow_clears_alert", 64_000);

        const row = db
            .prepare(
                "SELECT observed_safe_input_tokens, cache_alert_sent FROM session_meta WHERE session_id = ?",
            )
            .get("ses_overflow_clears_alert") as {
            observed_safe_input_tokens: number;
            cache_alert_sent: number;
        };
        expect(row.observed_safe_input_tokens).toBe(0);
        expect(row.cache_alert_sent).toBe(0);
        expect(getOverflowState(db, "ses_overflow_clears_alert").emergencyRecoveryOrigin).toBe(
            "provider_overflow",
        );
    });

    it("can be cleared via clearEmergencyRecovery without touching the limit", () => {
        ensureSessionMetaRow(db, "ses_clear_recovery");
        recordOverflowDetected(db, "ses_clear_recovery", 128_000);
        expect(getOverflowState(db, "ses_clear_recovery").needsEmergencyRecovery).toBe(true);

        clearEmergencyRecovery(db, "ses_clear_recovery");
        const after = getOverflowState(db, "ses_clear_recovery");
        expect(after.detectedContextLimit).toBe(128_000); // preserved
        expect(after.needsEmergencyRecovery).toBe(false); // cleared
        expect(after.emergencyRecoveryOrigin).toBeNull();
    });
});
