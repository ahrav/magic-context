/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../../shared/sqlite";
import {
    clearEmergencyDrainLatch,
    EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
    EMERGENCY_DRAIN_MAX_LATCH_MS,
    emergencyDrainExitThreshold,
    loadProtectedTailMeta,
    protectedTailWindowBudget,
    recordHistorianDrainFailure,
    reserveProtectedTailDrainTokens,
} from "./storage-meta-persisted";
import { createDirectTestDatabase } from "./test-database";

// The fourth reserve requires the emergency-latch bypass.
// At >=80%, min(750k, max(3*perRunCap, 0.35*usable)) equals 60k.
function reserve(
    db: Database,
    sessionId: string,
    usagePercentage: number,
    now: number,
    opts?: { executeThreshold?: number },
) {
    return reserveProtectedTailDrainTokens({
        db,
        sessionId,
        runId: `run-${now}`,
        trueRawTokens: 20_000,
        usagePercentage,
        usable: 100_000,
        perRunCap: 20_000,
        executeThresholdPercentage: opts?.executeThreshold ?? 80,
        now,
    });
}

function exhaustWindowBudget(db: Database, sessionId: string, usage: number, now: number) {
    // budget differs by tier (>=95% is larger than >=80%), so derive the count.
    const budget = protectedTailWindowBudget(usage, 100_000, 20_000);
    const reserves = Math.ceil(budget / 20_000);
    for (let i = 0; i < reserves; i++) {
        expect(reserve(db, sessionId, usage, now + i).ok).toBe(true);
    }
}

describe("emergency drain catch-up latch", () => {
    let db: Database;
    const SID = "sess-latch";

    beforeEach(() => {
        db = createDirectTestDatabase().db;
    });

    describe("emergencyDrainExitThreshold", () => {
        it("is 10 below the execute threshold", () => {
            expect(emergencyDrainExitThreshold(80)).toBe(70);
            expect(emergencyDrainExitThreshold(65)).toBe(55);
        });
        it("falls back to 55 when the execute threshold is missing/0", () => {
            expect(emergencyDrainExitThreshold(0)).toBe(55);
            expect(emergencyDrainExitThreshold(Number.NaN)).toBe(55);
        });
        it("clamps to >= 0", () => {
            expect(emergencyDrainExitThreshold(5)).toBe(0);
        });
    });

    it("below the derived force band with an exhausted budget skips (no latch)", () => {
        const t = 1_000_000;
        exhaustWindowBudget(db, SID, 83, t);
        const r = reserve(db, SID, 83, t + 10);
        expect(r.ok).toBe(false);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBe(0);
    });

    it("enters the latch at the derived force band and bypasses the exhausted budget every pass", () => {
        const t = 2_000_000;
        exhaustWindowBudget(db, SID, 85, t);
        const meta = loadProtectedTailMeta(db, SID);
        expect(meta.emergencyDrainActive).toBeGreaterThan(0); // latch armed on entry
        const r1 = reserve(db, SID, 85, t + 10);
        const r2 = reserve(db, SID, 85, t + 20);
        expect(r1.ok).toBe(true);
        expect(r1.overQuotaBypass).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r2.overQuotaBypass).toBe(true);
    });

    it("keeps bypassing in the 80-94% band after a spike, until below exit threshold", () => {
        const t = 3_000_000;
        exhaustWindowBudget(db, SID, 96, t);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
        // At 83%, below the force-band entry but above the 70% exit threshold, the latch stays armed and keeps draining.
        const r = reserve(db, SID, 83, t + 10, { executeThreshold: 80 });
        expect(r.ok).toBe(true);
        expect(r.overQuotaBypass).toBe(true);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
    });

    it("exits the latch once usage drops below executeThreshold-10", () => {
        const t = 4_000_000;
        exhaustWindowBudget(db, SID, 96, t);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
        // At 69%, below the 70% exit threshold, a reserve clears the latch.
        // With the budget exhausted, the 69% reserve skips after clearing the latch.
        const r = reserve(db, SID, 69, t + 10, { executeThreshold: 80 });
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBe(0);
        expect(r.ok).toBe(false);
    });

    it("self-expires the latch after MAX_LATCH_MS even if usage stays high", () => {
        const t = 5_000_000;
        exhaustWindowBudget(db, SID, 96, t);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
        // At 84%, exceeding EMERGENCY_DRAIN_MAX_LATCH_MS clears the latch.
        // The max-latch duration exceeds the drain-window duration.
        // The elapsed 10-minute drain window resets the per-window budget.
        // The reserve succeeds within the fresh budget without bypass, and the max-latch expiry clears the latch.
        const r = reserve(db, SID, 84, t + EMERGENCY_DRAIN_MAX_LATCH_MS + 1, {
            executeThreshold: 80,
        });
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBe(0);
        expect(r.ok).toBe(true);
        expect(r.overQuotaBypass).toBe(false);
    });

    it("keeps a 90% execute threshold below its 92% drain-entry band", () => {
        const t = 5_500_000;
        for (let i = 0; i < 3; i++) {
            expect(reserve(db, SID, 91, t + i, { executeThreshold: 90 }).ok).toBe(true);
        }
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBe(0);
        reserve(db, SID, 92, t + 10, { executeThreshold: 90 });
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
    });

    it("suppresses the bypass during the historian-failure backoff window", () => {
        const t = 6_000_000;
        exhaustWindowBudget(db, SID, 96, t);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
        recordHistorianDrainFailure(db, SID, t + 10);
        // Within the backoff window: latch is armed but bypass is suppressed → skip.
        const blocked = reserve(db, SID, 96, t + 20);
        expect(blocked.ok).toBe(false);
        // After the backoff window: bypass resumes.
        const allowed = reserve(db, SID, 96, t + EMERGENCY_DRAIN_FAILURE_BACKOFF_MS + 20);
        expect(allowed.ok).toBe(true);
        expect(allowed.overQuotaBypass).toBe(true);
    });

    it("clearEmergencyDrainLatch resets the latch (tail-exhausted no-op)", () => {
        const t = 7_000_000;
        exhaustWindowBudget(db, SID, 96, t);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBeGreaterThan(0);
        clearEmergencyDrainLatch(db, SID);
        expect(loadProtectedTailMeta(db, SID).emergencyDrainActive).toBe(0);
    });

    it("does not bust the window reset's independence from the latch", () => {
        const t = 8_000_000;
        exhaustWindowBudget(db, SID, 96, t);
        const activeAt = loadProtectedTailMeta(db, SID).emergencyDrainActive;
        expect(activeAt).toBeGreaterThan(0);
        // A reserve after the 10-minute window expires resets the budget without clearing the latch while usage remains in the emergency band.
        // The reserve must not clear the latch while usage remains in the emergency band.
        const r = reserve(db, SID, 96, t + 11 * 60 * 1000);
        expect(r.ok).toBe(true);
        const meta = loadProtectedTailMeta(db, SID);
        expect(meta.emergencyDrainActive).toBe(activeAt); // unchanged across reset
        expect(meta.protectedTailDrainTokens).toBe(20_000); // budget was reset then re-charged
    });
});
