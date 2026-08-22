/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    type ArtifactEvaluation,
    type ClaimCommandDeps,
    clearClaimCommandConfirmationsForTests,
    executeClaimApprovalCommand,
    executeClaimEnforceCommand,
} from "./claim-policy-commands";
import { sha256Utf8Hex } from "./storage-claims";
import {
    createMemoryWithClaimsInCurrentTransaction,
    type MemoryClaimOperationEnvelope,
    runInMemoryClaimsWriteTransaction,
    updateMemoryContentWithClaimsInCurrentTransaction,
} from "./storage-memory-claims";

const PROJECT = "git:approval-project";
const FOREIGN_PROJECT = "git:foreign-project";

function migratedDb(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function envelope(operationKey: string, request: unknown): MemoryClaimOperationEnvelope {
    return {
        producer: "approval-test",
        operationKey,
        requestDigest: sha256Utf8Hex(JSON.stringify(request)),
    };
}

function seedMemory(
    db: Database,
    key: string,
    content: string,
    projectPath = PROJECT,
): { memoryId: number; claimId: number; revisionId: number } {
    const outcome = runInMemoryClaimsWriteTransaction(db, () =>
        createMemoryWithClaimsInCurrentTransaction(db, envelope(key, { key, content }), {
            projectPath,
            category: "CONSTRAINTS",
            content,
            normalizedHash: `hash:${content}`,
            importance: 60,
            sourceSessionId: "ses-approve",
            sourceType: "agent",
            nowMs: 1_000,
        }),
    );
    return {
        memoryId: outcome.result.memoryId,
        claimId: outcome.result.claimId as number,
        revisionId: outcome.result.revisionId as number,
    };
}

const tempDirs: string[] = [];
function tempProjectRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "claim-enforce-"));
    tempDirs.push(dir);
    return dir;
}

function deps(db: Database, overrides: Partial<ClaimCommandDeps> = {}): ClaimCommandDeps {
    return {
        db,
        projectPath: PROJECT,
        projectRoot: tempProjectRoot(),
        host: "opencode",
        sessionId: "ses-approve",
        ...overrides,
    };
}

const passEvaluator = (): ArtifactEvaluation => ({
    result: "pass",
    evaluator: "test-evaluator",
    evaluatorVersion: "1",
});

const failEvaluator = (): ArtifactEvaluation => ({
    result: "fail",
    evaluator: "test-evaluator",
    evaluatorVersion: "1",
    detail: "1 test failed",
});

function approvalCount(db: Database, revisionId: number, action: string): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM claim_approval_actions WHERE revision_id = ? AND action = ?",
            )
            .get(revisionId, action) as { count: number }
    ).count;
}

function effectiveMaturityOf(db: Database, revisionId: number): string | null {
    const row = db
        .prepare(
            "SELECT effective_maturity AS maturity FROM claim_effective_policy WHERE revision_id = ?",
        )
        .get(revisionId) as { maturity: string } | null | undefined;
    return row?.maturity ?? null;
}

afterEach(() => {
    clearClaimCommandConfirmationsForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claim approval command workflow", () => {
    test("first command confirms without recording; the repeat records one approval", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "appr-1", "approve me");
            const commandDeps = deps(db);
            const first = executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            expect(first.level).toBe("warning");
            expect(first.text).toContain("Confirmation Required");
            expect(first.text).toContain(PROJECT);
            expect(first.text).toContain(`revision ${seed.revisionId}`);
            expect(approvalCount(db, seed.revisionId, "approve")).toBe(0);

            const second = executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            expect(second.level).toBe("info");
            expect(approvalCount(db, seed.revisionId, "approve")).toBe(1);
            expect(effectiveMaturityOf(db, seed.revisionId)).toBe("APPROVED");

            const third = executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            expect(third.text).toContain("already approved");
            expect(approvalCount(db, seed.revisionId, "approve")).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("a content change between confirmation and repeat makes the confirmation stale", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "appr-stale", "original");
            const commandDeps = deps(db);
            executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            runInMemoryClaimsWriteTransaction(db, () =>
                updateMemoryContentWithClaimsInCurrentTransaction(
                    db,
                    envelope("appr-stale-2", { next: true }),
                    {
                        memoryId: seed.memoryId,
                        content: "changed content",
                        normalizedHash: "hash:changed content",
                        nowMs: 2_000,
                    },
                ),
            );
            const second = executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            expect(second.level).toBe("warning");
            expect(second.text).toContain("Confirmation Required");
            expect(approvalCount(db, seed.revisionId, "approve")).toBe(0);
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS count FROM claim_approval_actions").get() as {
                        count: number;
                    }
                ).count,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("a different session cannot consume another session's confirmation", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "appr-session", "session bound");
            executeClaimApprovalCommand(deps(db), String(seed.memoryId));
            const other = executeClaimApprovalCommand(
                deps(db, { sessionId: "other-session" }),
                String(seed.memoryId),
            );
            expect(other.level).toBe("warning");
            expect(approvalCount(db, seed.revisionId, "approve")).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("foreign-project targets are rejected before any confirmation detail", () => {
        const db = migratedDb();
        try {
            const foreign = seedMemory(db, "appr-foreign", "foreign row", FOREIGN_PROJECT);
            const result = executeClaimApprovalCommand(deps(db), String(foreign.memoryId));
            expect(result.level).toBe("error");
            expect(result.text).not.toContain("Confirmation Required");
            expect(result.text).not.toContain("foreign row");
            expect(approvalCount(db, foreign.revisionId, "approve")).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("revocation appends an action and lowers effective maturity without deleting history", () => {
        const db = migratedDb();
        try {
            const seed = seedMemory(db, "appr-revoke", "revoke me");
            const commandDeps = deps(db);
            executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
            expect(effectiveMaturityOf(db, seed.revisionId)).toBe("APPROVED");

            executeClaimApprovalCommand(commandDeps, `${seed.memoryId} --revoke`);
            executeClaimApprovalCommand(commandDeps, `${seed.memoryId} --revoke`);
            expect(approvalCount(db, seed.revisionId, "revoke")).toBe(1);
            expect(approvalCount(db, seed.revisionId, "approve")).toBe(1);
            expect(effectiveMaturityOf(db, seed.revisionId)).toBe("CANDIDATE");
            const head = db
                .prepare("SELECT maturity FROM claim_maturity_heads WHERE revision_id = ?")
                .get(seed.revisionId) as { maturity: string };
            expect(head.maturity).toBe("APPROVED");
        } finally {
            closeQuietly(db);
        }
    });

    test("invalid arguments and unknown memories fail with usage or resolution errors", () => {
        const db = migratedDb();
        try {
            expect(executeClaimApprovalCommand(deps(db), "").level).toBe("error");
            expect(executeClaimApprovalCommand(deps(db), "not-a-number").level).toBe("error");
            const missing = executeClaimApprovalCommand(deps(db), "99999");
            expect(missing.level).toBe("error");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("claim enforcement command workflow", () => {
    function approvedSeed(db: Database, commandDeps: ClaimCommandDeps, key: string) {
        const seed = seedMemory(db, key, `${key} content`);
        executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
        executeClaimApprovalCommand(commandDeps, String(seed.memoryId));
        return seed;
    }

    test("an approved revision plus a passing bound artifact records ENFORCED once", () => {
        const db = migratedDb();
        try {
            const commandDeps = deps(db, { evaluateArtifact: passEvaluator });
            const seed = approvedSeed(db, commandDeps, "enf-pass");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            const first = executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            expect(first.level).toBe("warning");
            const second = executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            expect(second.level).toBe("info");
            expect(second.text).toContain("ENFORCED");
            expect(effectiveMaturityOf(db, seed.revisionId)).toBe("ENFORCED");
            const artifact = db
                .prepare(
                    "SELECT canonical_path AS path, evaluator_result AS result FROM claim_enforcement_artifacts WHERE revision_id = ?",
                )
                .get(seed.revisionId) as { path: string; result: string };
            expect(artifact).toEqual({ path: "gate.test.ts", result: "pass" });
            const effects = db
                .prepare(
                    "SELECT COUNT(*) AS count FROM claim_change_outbox WHERE effect_key LIKE 'policy:%:enforcement'",
                )
                .get() as { count: number };
            expect(effects.count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("a failing artifact records the attempt but never ENFORCED", () => {
        const db = migratedDb();
        try {
            const commandDeps = deps(db, { evaluateArtifact: failEvaluator });
            const seed = approvedSeed(db, commandDeps, "enf-fail");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            const second = executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            expect(second.level).toBe("error");
            expect(effectiveMaturityOf(db, seed.revisionId)).toBe("APPROVED");
            expect(
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM claim_maturity_assertions WHERE maturity = 'ENFORCED'",
                        )
                        .get() as { count: number }
                ).count,
            ).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("unapproved revisions, absolute paths, escapes, and missing files are rejected", () => {
        const db = migratedDb();
        try {
            const commandDeps = deps(db, { evaluateArtifact: passEvaluator });
            const unapproved = seedMemory(db, "enf-unapproved", "not approved");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            expect(
                executeClaimEnforceCommand(commandDeps, `${unapproved.memoryId} gate.test.ts`).text,
            ).toContain("not approved");

            const seed = approvedSeed(db, commandDeps, "enf-paths");
            expect(
                executeClaimEnforceCommand(commandDeps, `${seed.memoryId} /etc/passwd`).text,
            ).toContain("project-relative");
            expect(
                executeClaimEnforceCommand(commandDeps, `${seed.memoryId} ../outside.test.ts`).text,
            ).toContain("not found");
            expect(
                executeClaimEnforceCommand(commandDeps, `${seed.memoryId} missing.test.ts`).text,
            ).toContain("not found");

            // A symlink pointing outside the project escapes canonicalization.
            const outside = tempProjectRoot();
            writeFileSync(join(outside, "outside.test.ts"), "outside bytes");
            symlinkSync(
                join(outside, "outside.test.ts"),
                join(commandDeps.projectRoot, "sneaky.test.ts"),
            );
            expect(
                executeClaimEnforceCommand(commandDeps, `${seed.memoryId} sneaky.test.ts`).text,
            ).toContain("escapes the owning project");

            // A directory is not a regular file.
            mkdirSync(join(commandDeps.projectRoot, "dir.test.ts"));
            expect(
                executeClaimEnforceCommand(commandDeps, `${seed.memoryId} dir.test.ts`).text,
            ).toContain("regular file");
        } finally {
            closeQuietly(db);
        }
    });

    test("an artifact rewritten during evaluation is rejected and records nothing", () => {
        const db = migratedDb();
        try {
            const commandDeps = deps(db);
            const seed = approvedSeed(db, commandDeps, "enf-mutate");
            const artifactPath = join(commandDeps.projectRoot, "gate.test.ts");
            writeFileSync(artifactPath, "original bytes");
            commandDeps.evaluateArtifact = () => {
                writeFileSync(artifactPath, "swapped bytes");
                return passEvaluator();
            };
            executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            const second = executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            expect(second.level).toBe("error");
            expect(second.text).toContain("changed during evaluation");
            expect(
                (
                    db
                        .prepare("SELECT COUNT(*) AS count FROM claim_enforcement_artifacts")
                        .get() as { count: number }
                ).count,
            ).toBe(0);
            expect(effectiveMaturityOf(db, seed.revisionId)).not.toBe("ENFORCED");
        } finally {
            closeQuietly(db);
        }
    });

    test("an approval revocation between confirmation and repeat blocks enforcement", () => {
        const db = migratedDb();
        try {
            const commandDeps = deps(db, { evaluateArtifact: passEvaluator });
            const seed = approvedSeed(db, commandDeps, "enf-revoked");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            executeClaimApprovalCommand(commandDeps, `${seed.memoryId} --revoke`);
            executeClaimApprovalCommand(commandDeps, `${seed.memoryId} --revoke`);
            const second = executeClaimEnforceCommand(commandDeps, `${seed.memoryId} gate.test.ts`);
            expect(second.level).toBe("error");
            expect(effectiveMaturityOf(db, seed.revisionId)).not.toBe("ENFORCED");
        } finally {
            closeQuietly(db);
        }
    });
});
