import { expect, test } from "bun:test";

import { createDirectTestDatabase } from "../test-database";
import {
    type AutonomousManifestIdentity,
    recordAutonomousManifestRejection,
} from "./storage-claim-autonomous";

const identity: AutonomousManifestIdentity = {
    producer: "dreamer-verify",
    task: "verify",
    runId: "session-1",
    leaseKey: "verify:project",
    leaseGeneration: 3,
    batchId: "batch-1",
};

test("rejection receipts match independent operation and digest goldens", () => {
    const db = createDirectTestDatabase().db;
    try {
        const pairs = [
            [
                "batch-1",
                "<invalid>",
                "4e5b8ce4e465b5263778571420783a6014b06e8ff4210036940f364b96170370",
            ],
            [
                "batch-2",
                "<invalid-two>",
                "a1413710e3a0193519cc53cf25168c7de9198f51b3536b987547e43fc12b7273",
            ],
        ] as const;
        for (const [batchId, rawManifest, requestDigest] of pairs) {
            recordAutonomousManifestRejection({
                db,
                identity: { ...identity, batchId },
                rawManifest,
                reason: "invalid manifest",
                nowMs: 1,
            });
            const receipt = db
                .prepare(
                    "SELECT operation_key AS operationKey, request_digest AS requestDigest FROM claim_operation_receipts WHERE operation_key = ?",
                )
                .get(`verify:session-1:verify:project:3:${batchId}`) as {
                operationKey: string;
                requestDigest: string;
            };
            expect(receipt).toEqual({
                operationKey: `verify:session-1:verify:project:3:${batchId}`,
                requestDigest,
            });
        }
        recordAutonomousManifestRejection({
            db,
            identity: { ...identity, batchId: "batch-3" },
            rawManifest: "<invalid>",
            reason: "invalid manifest",
            nowMs: 1,
        });
        const sameManifestDigest = db
            .prepare(
                "SELECT request_digest AS requestDigest FROM claim_operation_receipts WHERE operation_key = ?",
            )
            .get("verify:session-1:verify:project:3:batch-3") as { requestDigest: string };
        expect(sameManifestDigest.requestDigest).not.toBe(pairs[0][2]);
    } finally {
        db.close();
    }
});

test("rejection digest rejects incomplete identity", () => {
    const db = createDirectTestDatabase().db;
    try {
        expect(() =>
            recordAutonomousManifestRejection({
                db,
                identity: { ...identity, leaseGeneration: 0 },
                rawManifest: "<invalid>",
                reason: "invalid manifest",
                nowMs: 1,
            }),
        ).toThrow("autonomous manifest identity is incomplete");
    } finally {
        db.close();
    }
});
