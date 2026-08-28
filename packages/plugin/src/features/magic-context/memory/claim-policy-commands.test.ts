import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createClaimReaderTestDatabase, seedProjectMemoryClaim } from "../test-claim-database";
import {
    type ArtifactEvaluation,
    type ClaimCommandDeps,
    clearClaimCommandConfirmationsForTests,
    executeClaimApprovalCommand,
    executeClaimEnforceCommand,
} from "./claim-policy-commands";
import {
    computeProjectMemoryMutationToken,
    getProjectMemoryClaimByPublicId,
    reviseProjectMemoryClaim,
    setProjectMemoryClaimLifecycle,
} from "./storage-claim-operations";

const PROJECT = "git:approval-project";
const FOREIGN_PROJECT = "git:foreign-project";
const tempDirs: string[] = [];

function tempProjectRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "claim-enforce-"));
    tempDirs.push(dir);
    return dir;
}

function deps(
    db: ReturnType<typeof createClaimReaderTestDatabase>,
    overrides: Partial<ClaimCommandDeps> = {},
): ClaimCommandDeps {
    return {
        db,
        projectPath: PROJECT,
        projectRoot: tempProjectRoot(),
        host: "opencode",
        sessionId: "ses-approve",
        ...overrides,
    };
}

function seed(
    db: ReturnType<typeof createClaimReaderTestDatabase>,
    key: string,
    projectIdentity = PROJECT,
) {
    const claim = seedProjectMemoryClaim(db, {
        projectIdentity,
        content: `${key} content`,
        category: "CONSTRAINTS",
        operationKey: key,
    });
    const ref = getProjectMemoryClaimByPublicId(db, claim.publicClaimId);
    if (!ref) throw new Error("seeded claim missing");
    return { ...claim, revisionId: ref.currentRevisionId };
}

const passEvaluator = (): ArtifactEvaluation => ({
    result: "pass",
    evaluator: "test-evaluator",
    evaluatorVersion: "1",
});

function approvalCount(
    db: ReturnType<typeof createClaimReaderTestDatabase>,
    revisionId: number,
    action: string,
): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM claim_approval_actions WHERE revision_id = ? AND action = ?",
            )
            .get(revisionId, action) as { count: number }
    ).count;
}

function effectiveMaturity(
    db: ReturnType<typeof createClaimReaderTestDatabase>,
    revisionId: number,
): string | null {
    const row = db
        .prepare(
            "SELECT effective_maturity AS maturity FROM claim_effective_policy WHERE revision_id = ?",
        )
        .get(revisionId) as { maturity: string } | undefined;
    return row?.maturity ?? null;
}

afterEach(() => {
    clearClaimCommandConfirmationsForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claim approval command", () => {
    test("confirms the public claim locator and records one direct claim operation", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const claim = seed(db, "approve");
            const commandDeps = deps(db);
            const first = await executeClaimApprovalCommand(commandDeps, claim.publicClaimId);
            expect(first.level).toBe("warning");
            expect(first.text).toContain(claim.publicClaimId);
            expect(first.text).toContain(claim.revisionLocator);
            expect(approvalCount(db, claim.revisionId, "approve")).toBe(0);

            const second = await executeClaimApprovalCommand(commandDeps, claim.publicClaimId);
            expect(second.level).toBe("info");
            expect(approvalCount(db, claim.revisionId, "approve")).toBe(1);
            expect(effectiveMaturity(db, claim.revisionId)).toBe("APPROVED");
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM claim_operation_effects WHERE change_kind = 'lifecycle'",
                    )
                    .get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("revision or claim-token movement invalidates confirmation", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const revisionMoved = seed(db, "approval-revision-moved");
            const commandDeps = deps(db);
            await executeClaimApprovalCommand(commandDeps, revisionMoved.publicClaimId);
            reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "move-revision" },
                {
                    token: revisionMoved.token,
                    content: "changed after confirmation",
                    provenance: {
                        sourceLocator: "test://approval/revision",
                        sourceContent: "changed after confirmation",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "move-revision",
                        independenceKey: "move-revision",
                    },
                    actor: "user:test",
                },
            );
            const revisionRetry = await executeClaimApprovalCommand(
                commandDeps,
                revisionMoved.publicClaimId,
            );
            expect(revisionRetry.level).toBe("warning");
            expect(approvalCount(db, revisionMoved.revisionId, "approve")).toBe(0);

            clearClaimCommandConfirmationsForTests();
            const tokenMoved = seed(db, "approval-token-moved");
            await executeClaimApprovalCommand(commandDeps, tokenMoved.publicClaimId);
            setProjectMemoryClaimLifecycle(
                db,
                { producer: "test", operationKey: "move-lifecycle" },
                {
                    token: tokenMoved.token,
                    state: "archived",
                    actor: "user:test",
                },
            );
            const tokenRetry = await executeClaimApprovalCommand(
                commandDeps,
                tokenMoved.publicClaimId,
            );
            expect(tokenRetry.level).toBe("warning");
            expect(approvalCount(db, tokenMoved.revisionId, "approve")).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("foreign claims and numeric legacy IDs reveal no confirmation detail", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const foreign = seed(db, "foreign", FOREIGN_PROJECT);
            const foreignResult = await executeClaimApprovalCommand(
                deps(db),
                foreign.publicClaimId,
            );
            expect(foreignResult.level).toBe("error");
            expect(foreignResult.text).not.toContain("Confirmation Required");
            expect(foreignResult.text).not.toContain("foreign content");
            expect((await executeClaimApprovalCommand(deps(db), "42")).text).toContain("Usage");
        } finally {
            closeQuietly(db);
        }
    });

    test("revocation keeps history and falls back to explicit-user VERIFIED support", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const claim = seed(db, "revoke");
            expect(effectiveMaturity(db, claim.revisionId)).toBe("VERIFIED");
            const commandDeps = deps(db);
            await executeClaimApprovalCommand(commandDeps, claim.publicClaimId);
            await executeClaimApprovalCommand(commandDeps, claim.publicClaimId);
            await executeClaimApprovalCommand(commandDeps, `${claim.publicClaimId} --revoke`);
            await executeClaimApprovalCommand(commandDeps, `${claim.publicClaimId} --revoke`);
            expect(approvalCount(db, claim.revisionId, "approve")).toBe(1);
            expect(approvalCount(db, claim.revisionId, "revoke")).toBe(1);
            expect(effectiveMaturity(db, claim.revisionId)).toBe("VERIFIED");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("claim enforcement command", () => {
    async function approvedClaim(
        db: ReturnType<typeof createClaimReaderTestDatabase>,
        commandDeps: ClaimCommandDeps,
        key: string,
    ) {
        const claim = seed(db, key);
        await executeClaimApprovalCommand(commandDeps, claim.publicClaimId);
        await executeClaimApprovalCommand(commandDeps, claim.publicClaimId);
        return claim;
    }

    test("records ENFORCED for a passing artifact under the same direct operation contract", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const commandDeps = deps(db, { evaluateArtifact: passEvaluator });
            const claim = await approvedClaim(db, commandDeps, "enforce-pass");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            const args = `${claim.publicClaimId} gate.test.ts`;
            expect((await executeClaimEnforceCommand(commandDeps, args)).level).toBe("warning");
            const result = await executeClaimEnforceCommand(commandDeps, args);
            expect(result.level).toBe("info");
            expect(result.text).toContain(claim.revisionLocator);
            expect(effectiveMaturity(db, claim.revisionId)).toBe("ENFORCED");
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM claim_enforcement_artifacts").get(),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });

    test("rechecks exact revision and digest after artifact evaluation", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const commandDeps = deps(db);
            const claim = await approvedClaim(db, commandDeps, "enforce-revision-race");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            commandDeps.evaluateArtifact = () => {
                reviseProjectMemoryClaim(
                    db,
                    { producer: "test", operationKey: "evaluation-revision-race" },
                    {
                        token: computeProjectMemoryMutationToken(db, claim.publicClaimId),
                        content: "changed during artifact evaluation",
                        provenance: {
                            sourceLocator: "test://enforcement/revision-race",
                            sourceContent: "changed during artifact evaluation",
                            extractor: "test",
                            extractorVersion: "1",
                            extractorRunId: "evaluation-revision-race",
                            independenceKey: "evaluation-revision-race",
                        },
                        actor: "user:test",
                    },
                );
                return passEvaluator();
            };
            const args = `${claim.publicClaimId} gate.test.ts`;
            await executeClaimEnforceCommand(commandDeps, args);
            const result = await executeClaimEnforceCommand(commandDeps, args);
            expect(result.level).toBe("error");
            expect(result.text).toContain("changed since confirmation");
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM claim_enforcement_artifacts").get(),
            ).toEqual({ count: 0 });
            expect(effectiveMaturity(db, claim.revisionId)).not.toBe("ENFORCED");
        } finally {
            closeQuietly(db);
        }
    });

    test("rechecks the exact claim token after artifact evaluation", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const commandDeps = deps(db);
            const claim = await approvedClaim(db, commandDeps, "enforce-token-race");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            commandDeps.evaluateArtifact = () => {
                setProjectMemoryClaimLifecycle(
                    db,
                    { producer: "test", operationKey: "evaluation-lifecycle-race" },
                    {
                        token: computeProjectMemoryMutationToken(db, claim.publicClaimId),
                        state: "archived",
                        actor: "user:test",
                    },
                );
                return passEvaluator();
            };
            const args = `${claim.publicClaimId} gate.test.ts`;
            await executeClaimEnforceCommand(commandDeps, args);
            const result = await executeClaimEnforceCommand(commandDeps, args);
            expect(result.level).toBe("error");
            expect(result.text).toContain("changed since confirmation");
            expect(
                db.prepare("SELECT COUNT(*) AS count FROM claim_enforcement_artifacts").get(),
            ).toEqual({ count: 0 });
            expect(effectiveMaturity(db, claim.revisionId)).not.toBe("ENFORCED");
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects unapproved claims, path escapes, and artifact mutation", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const commandDeps = deps(db, { evaluateArtifact: passEvaluator });
            const unapproved = seed(db, "unapproved");
            writeFileSync(join(commandDeps.projectRoot, "gate.test.ts"), "test bytes");
            expect(
                (
                    await executeClaimEnforceCommand(
                        commandDeps,
                        `${unapproved.publicClaimId} gate.test.ts`,
                    )
                ).text,
            ).toContain("not approved");

            const claim = await approvedClaim(db, commandDeps, "artifact-change");
            const artifactPath = join(commandDeps.projectRoot, "changed.test.ts");
            writeFileSync(artifactPath, "original bytes");
            commandDeps.evaluateArtifact = () => {
                writeFileSync(artifactPath, "changed bytes");
                return passEvaluator();
            };
            const args = `${claim.publicClaimId} changed.test.ts`;
            await executeClaimEnforceCommand(commandDeps, args);
            const changed = await executeClaimEnforceCommand(commandDeps, args);
            expect(changed.level).toBe("error");
            expect(changed.text).toContain("changed during evaluation");
            expect(
                (
                    await executeClaimEnforceCommand(
                        commandDeps,
                        `${claim.publicClaimId} ../outside.test.ts`,
                    )
                ).level,
            ).toBe("error");
        } finally {
            closeQuietly(db);
        }
    });
});
