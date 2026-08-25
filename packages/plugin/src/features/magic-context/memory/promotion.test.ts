/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createClaimReaderTestDatabase } from "../test-claim-database";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "./storage-claim-current-state";
import { promoteSessionFactsDurable, type HistorianPromotionIdentity } from "./promotion";

const PROJECT = "git:promotion-test";
let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function identity(overrides: Partial<HistorianPromotionIdentity> = {}): HistorianPromotionIdentity {
    return {
        producer: "test-historian",
        runId: "ses-1:1:2",
        leaseKey: "compartment:ses-1",
        leaseGeneration: "holder-1",
        batchId: "1-2",
        ...overrides,
    };
}

function currentClaims(database: Database) {
    const projectIds = resolveProjectIdsForIdentities(database, [PROJECT]);
    const result = readProjectMemoryCurrentState(database, {
        projectIds,
        lifecycleStates: ["active"],
        surface: "maintenance_hygiene",
        workspaceEpoch: "promotion-test",
    });
    if (result.status !== "ok") throw new Error(result.reasons.join(", "));
    return result.items;
}

function count(database: Database, table: string): number {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
        .count;
}

describe("claim-native historian promotion", () => {
    it("creates one inference-tainted claim with a public locator", () => {
        db = createClaimReaderTestDatabase();
        const refs = promoteSessionFactsDurable(
            db,
            "ses-1",
            PROJECT,
            [{ category: "CONSTRAINTS", content: "Provider rejects empty batches." }],
            identity(),
        );

        expect(refs).toHaveLength(1);
        expect(refs[0]?.publicClaimId).toMatch(/^mcm_/);
        expect(refs[0]?.revisionLocator).toMatch(/^mcm_.+\/r1\/[a-f0-9]{64}$/);
        const claims = currentClaims(db);
        expect(claims).toHaveLength(1);
        expect(claims[0]?.content).toBe("Provider rejects empty batches.");
        expect(claims[0]?.policy.originTaint).toBe("ASSISTANT_INFERENCE");
        expect(count(db, "observations")).toBe(1);
        expect(count(db, "claim_operation_receipts")).toBe(1);
        expect(count(db, "claim_operation_effects")).toBe(1);
        expect(count(db, "claim_project_generations")).toBe(1);
    });

    it("replays one stable operation without duplicate evidence or generation bumps", () => {
        db = createClaimReaderTestDatabase();
        const facts = [{ category: "PROJECT_RULES", content: "Run focused tests before commit." }];
        const first = promoteSessionFactsDurable(db, "ses-1", PROJECT, facts, identity());
        const generation = currentClaims(db)[0]?.policy.generation;
        const second = promoteSessionFactsDurable(db, "ses-1", PROJECT, facts, identity());

        expect(second).toEqual(first);
        expect(count(db, "claims")).toBe(1);
        expect(count(db, "claim_revisions")).toBe(1);
        expect(count(db, "observations")).toBe(1);
        expect(count(db, "claim_operation_receipts")).toBe(1);
        expect(currentClaims(db)[0]?.policy.generation).toBe(generation);
    });

    it("attaches later independent evidence without creating another revision", () => {
        db = createClaimReaderTestDatabase();
        const facts = [{ category: "NAMING", content: "Use createX names for factories." }];
        promoteSessionFactsDurable(db, "ses-1", PROJECT, facts, identity());
        promoteSessionFactsDurable(
            db,
            "ses-2",
            PROJECT,
            facts,
            identity({
                runId: "ses-2:1:2",
                leaseKey: "compartment:ses-2",
                leaseGeneration: "holder-2",
            }),
        );

        expect(count(db, "claims")).toBe(1);
        expect(count(db, "claim_revisions")).toBe(1);
        expect(count(db, "observations")).toBe(2);
        expect(currentClaims(db)[0]?.evidence.observationCount).toBe(2);
    });

    it("rejects incomplete identity before any write", () => {
        db = createClaimReaderTestDatabase();
        expect(() =>
            promoteSessionFactsDurable(
                db as Database,
                "ses-1",
                PROJECT,
                [{ category: "ARCHITECTURE", content: "Claims are authoritative." }],
                identity({ leaseKey: "" }),
            ),
        ).toThrow("historian promotion identity is incomplete");
        expect(count(db, "claims")).toBe(0);
        expect(count(db, "claim_operation_receipts")).toBe(0);
    });

    it("rolls claim, evidence, receipt, effect, and generation back with its outer publish", () => {
        db = createClaimReaderTestDatabase();
        expect(() =>
            db
                ?.transaction(() => {
                    promoteSessionFactsDurable(
                        db as Database,
                        "ses-1",
                        PROJECT,
                        [
                            {
                                category: "ARCHITECTURE",
                                content: "Atomic publication owns promotion.",
                            },
                        ],
                        identity(),
                    );
                    throw new Error("publish failed");
                })
                .immediate(),
        ).toThrow("publish failed");

        for (const table of [
            "claims",
            "claim_revisions",
            "observations",
            "claim_operation_receipts",
            "claim_operation_effects",
            "claim_project_generations",
        ]) {
            expect(count(db, table)).toBe(0);
        }
    });
});
