import { describe, expect, it } from "bun:test";
import {
    computeBudgetPressure,
    computeBudgetPressureTwoPass,
    renderedTier,
    shouldArchive,
    TIER_COST,
    tier,
} from "./decay-curve";

describe("decay-curve — tier boundaries", () => {
    it("newest compartment at importance 50 renders P1", () => {
        expect(tier(1, 50, 1)).toBe(1);
    });

    it("matches the documented boundary z-values at pressure 1, importance 50 (H=24)", () => {
        // z = (i-1)/24. Boundaries at z = 0.201, 0.729, 1.322, 2.587.
        // i-1 < 4.82 → P1 ; i = 5 (z=0.167) P1 ; i = 6 (z=0.208) P2
        expect(tier(5, 50, 1)).toBe(1);
        expect(tier(6, 50, 1)).toBe(2);
        // z crosses 0.729 at i-1 = 17.5 → i=18 (0.708) P2, i=19 (0.75) P3
        expect(tier(18, 50, 1)).toBe(2);
        expect(tier(19, 50, 1)).toBe(3);
        // z crosses 1.322 at i-1 = 31.7 → i=32 (1.29) P3, i=33 (1.33) P4
        expect(tier(32, 50, 1)).toBe(3);
        expect(tier(33, 50, 1)).toBe(4);
        // z crosses 2.587 at i-1 = 62.1 → i=63 (2.58) P4, i=64 (2.62) P5
        expect(tier(63, 50, 1)).toBe(4);
        expect(tier(64, 50, 1)).toBe(5);
    });
});

describe("decay-curve — verified invariants (formula §4)", () => {
    it("age monotonicity: older never renders a better tier", () => {
        for (const imp of [1, 30, 50, 75, 100]) {
            let prev = 1;
            for (let i = 1; i <= 500; i++) {
                const t = tier(i, imp, 1);
                expect(t).toBeGreaterThanOrEqual(prev);
                prev = t;
            }
        }
    });

    it("importance monotonicity: higher importance never renders a worse tier", () => {
        for (const i of [5, 25, 50, 100, 250]) {
            let prev = 5;
            for (const imp of [1, 30, 50, 75, 100]) {
                const t = tier(i, imp, 1);
                expect(t).toBeLessThanOrEqual(prev);
                prev = t;
            }
        }
    });

    it("importance 100 must eventually demote (no eternal P1)", () => {
        expect(tier(250, 100, 1)).toBe(5);
    });

    it("cost is O(H), not O(N): most of 10k compartments archive", () => {
        let rendered = 0;
        for (let i = 1; i <= 10_000; i++) {
            if (renderedTier(i, 50, 1) < 5) rendered++;
        }
        // Formula §4 reports ~63 rendered at N=10k, imp=50, p=1.
        expect(rendered).toBeLessThan(120);
        expect(rendered).toBeGreaterThan(40);
    });

    it("self-tuning: a generous budget renders more than a tight one for the same set", () => {
        const comps = Array.from({ length: 600 }, (_, k) => ({
            index: k + 1,
            importance: 59,
        }));
        const pGenerous = computeBudgetPressure(comps, 200_000);
        const pTight = computeBudgetPressure(comps, 10_000);
        const renderedGenerous = comps.filter(
            (c) => renderedTier(c.index, c.importance, pGenerous) < 5,
        ).length;
        const renderedTight = comps.filter(
            (c) => renderedTier(c.index, c.importance, pTight) < 5,
        ).length;
        expect(renderedGenerous).toBeGreaterThan(renderedTight);
        expect(pTight).toBeGreaterThanOrEqual(pGenerous);
    });

    it("numerical stability for large N (no NaN / overflow)", () => {
        for (const i of [1, 100, 1000, 10_000, 50_000]) {
            const t = tier(i, 100, 1);
            expect(Number.isFinite(t)).toBe(true);
            expect(t).toBeGreaterThanOrEqual(1);
            expect(t).toBeLessThanOrEqual(5);
        }
    });
});

describe("decay-curve — archive protection", () => {
    it("with anchorOverlap=0 (v2.0 default) archive reduces to z >= Z4", () => {
        // At imp=50,p=1: archives at i=64 (z=2.625 >= 2.587).
        expect(shouldArchive(64, 50, 1, 0)).toBe(true);
        expect(shouldArchive(63, 50, 1, 0)).toBe(false);
    });

    it("full anchor overlap buys extra P4 protection (renders P4, not P5)", () => {
        // At i=64, imp=50, p=1: archived with o=0, but o=1 adds G=2 half-lives.
        expect(renderedTier(64, 50, 1, 0)).toBe(5);
        expect(renderedTier(64, 50, 1, 1)).toBe(4);
    });
});

describe("decay-curve — budget pressure", () => {
    it("single-pass keeps rendered cost within ~1.3x of budget", () => {
        const comps = Array.from({ length: 600 }, (_, k) => ({
            index: k + 1,
            importance: 59,
        }));
        const budget = 80_000;
        const p = computeBudgetPressure(comps, budget);
        const cost = comps.reduce((sum, c) => sum + TIER_COST[tier(c.index, c.importance, p)], 0);
        expect(cost).toBeLessThan(budget * 1.3);
    });

    it("does not charge archived-tail compartments as rendered pressure", () => {
        const visible = Array.from({ length: 63 }, (_, k) => ({
            index: k + 1,
            importance: 50,
        }));
        const archivedTail = Array.from({ length: 400 }, (_, k) => ({
            index: k + 64,
            importance: 50,
        }));
        const budget = 20_000;

        expect(computeBudgetPressure([...visible, ...archivedTail], budget)).toBe(
            computeBudgetPressure(visible, budget),
        );
    });

    it("two-pass tightens an overshooting tight budget", () => {
        const comps = Array.from({ length: 600 }, (_, k) => ({
            index: k + 1,
            importance: 80,
        }));
        const budget = 4000;
        const cost1 = comps.reduce(
            (s, c) =>
                s + TIER_COST[tier(c.index, c.importance, computeBudgetPressure(comps, budget))],
            0,
        );
        const cost2 = comps.reduce(
            (s, c) =>
                s +
                TIER_COST[tier(c.index, c.importance, computeBudgetPressureTwoPass(comps, budget))],
            0,
        );
        expect(cost2).toBeLessThanOrEqual(cost1);
    });
});
