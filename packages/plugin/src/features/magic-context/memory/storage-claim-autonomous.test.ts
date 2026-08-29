import { expect, test } from "bun:test";

import { createDirectTestDatabase } from "../test-database";
import {
    type AutonomousManifestIdentity,
    computeAutonomousManifestRejectionRequestDigest,
    recordAutonomousManifestRejection,
} from "./storage-claim-autonomous";

test("rejection receipt uses the exported production request digest", () => {
    const db = createDirectTestDatabase().db;
    const identity: AutonomousManifestIdentity = {
        producer: "dreamer-verify",
        task: "verify",
        runId: "session-1",
        leaseKey: "verify:project",
        leaseGeneration: 3,
        batchId: "batch-1",
    };
    const rawManifest = "<invalid>";
    try {
        recordAutonomousManifestRejection({
            db,
            identity,
            rawManifest,
            reason: "invalid manifest",
            nowMs: 1,
        });
        const receipt = db
            .prepare("SELECT request_digest AS requestDigest FROM claim_operation_receipts")
            .get() as { requestDigest: string };
        expect(receipt.requestDigest).toBe(
            computeAutonomousManifestRejectionRequestDigest(identity, rawManifest),
        );
    } finally {
        db.close();
    }
});
