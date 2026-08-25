import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIncidentCatalog } from "../contract";
import { E2E_ROOT } from "../evidence";
import {
    builtinIncidentCaseRegistry,
    validateRegistryCatalogCorrespondence,
    type CaseDriverContext,
    type NormalizedObservation,
    type VerifierCheck,
} from "../registry";
import {
    driveHistorianFailureDump,
    driveLeaseLossResidualWrite,
    normalizeHistorianFailureDump,
    normalizeLeaseLossResidualWrite,
    preconditionHistorianFailureDump,
    preconditionLeaseLossResidualWrite,
    verifyHistorianFailureDump,
    verifyLeaseLossResidualWrite,
    type HistorianFailureDumpObservation,
    type LeaseLossResidualWriteObservation,
} from "./audit-background-lifecycle";

function failedIds(checks: VerifierCheck[]): string[] {
    return checks.filter((check) => !check.passed).map((check) => check.id);
}

function a28Observation(
    overrides: Partial<HistorianFailureDumpObservation> = {},
): HistorianFailureDumpObservation {
    return {
        kind: "a28-historian-dump-containment",
        workspaceScoped: true,
        namespaceUnique: true,
        failurePathCompleted: true,
        contentCanaryRetained: true,
        terminalCanaryRetained: true,
        shellCanaryRetained: true,
        dumpProjectLocal: true,
        dumpGitignored: true,
        dumpRetainedAfterFailure: true,
        publishedReportRedacted: true,
        sideEffectAbsent: true,
        ...overrides,
    };
}

const A47_CURRENT_TRACE = [
    "original-ownership",
    "pre-write-barrier",
    "replacement-ownership",
    "mutation-absent",
    "barrier-release",
    "guarded-write-attempt",
    "mutation-commit",
    "terminal-lease-loss",
    "child-release",
];

function a47Observation(
    overrides: Partial<LeaseLossResidualWriteObservation> = {},
): LeaseLossResidualWriteObservation {
    return {
        kind: "a47-lease-loss-residual-write",
        workspaceScoped: true,
        namespaceUnique: true,
        driverCompleted: true,
        curatePathUsed: true,
        memoryToolPublished: true,
        providerToolResultObserved: true,
        originalLeaseAcquired: true,
        originalOwnershipRead: true,
        preWriteBarrierReached: true,
        replacementOwnershipCommitted: true,
        replacementOwnershipRead: true,
        fencingIdUnique: true,
        mutationAbsentBeforeRelease: true,
        barrierReleased: true,
        guardedWriteAttempted: true,
        mutationCommitted: true,
        mutationIdUnique: true,
        postCommitMemoryRead: true,
        postCommitMutationRead: true,
        terminalLeaseLossEvents: 1,
        taskReportedLeaseLoss: true,
        childReleased: true,
        trace: [...A47_CURRENT_TRACE],
        ...overrides,
    };
}

describe("A28 historian failure containment verifier", () => {
    it("passes only static accepted containment facts", () => {
        const observation = a28Observation();
        expect(preconditionHistorianFailureDump(observation).satisfied).toBe(true);
        expect(failedIds(verifyHistorianFailureDump(observation))).toEqual([]);
    });

    it("rejects a dump outside the isolated project", () => {
        expect(
            failedIds(verifyHistorianFailureDump(a28Observation({ dumpProjectLocal: false }))),
        ).toEqual(["check-a28-project-local-dump"]);
    });

    it("rejects a dump without gitignore coverage", () => {
        expect(
            failedIds(verifyHistorianFailureDump(a28Observation({ dumpGitignored: false }))),
        ).toEqual(["check-a28-gitignore-coverage"]);
    });

    it("rejects deletion before intentional retention is observed", () => {
        expect(
            failedIds(
                verifyHistorianFailureDump(a28Observation({ dumpRetainedAfterFailure: false })),
            ),
        ).toEqual(["check-a28-intentional-retention"]);
    });

    it("rejects a published canary leak", () => {
        expect(
            failedIds(
                verifyHistorianFailureDump(a28Observation({ publishedReportRedacted: false })),
            ),
        ).toEqual(["check-a28-report-redaction"]);
    });

    it("rejects a shell command or external side effect", () => {
        expect(
            failedIds(verifyHistorianFailureDump(a28Observation({ sideEffectAbsent: false }))),
        ).toEqual(["check-a28-metacharacter-safety"]);
    });

    it("rejects dynamic raw dump data instead of publishing it", () => {
        expect(() =>
            normalizeHistorianFailureDump({
                ...a28Observation(),
                rawDump: "synthetic raw canary",
            } as never),
        ).toThrow(/must contain exactly/);
        expect(() =>
            verifyHistorianFailureDump({ kind: "a28-historian-dump-containment" } as unknown as NormalizedObservation),
        ).toThrow(/must contain exactly/);
    });

    it("does not score a failure path missing any canary class", () => {
        for (const overrides of [
            { failurePathCompleted: false },
            { contentCanaryRetained: false },
            { terminalCanaryRetained: false },
            { shellCanaryRetained: false },
        ] as const) {
            expect(preconditionHistorianFailureDump(a28Observation(overrides)).satisfied).toBe(false);
        }
    });
});

describe("A47 lease-loss residual-write verifier", () => {
    it("records current committed mutation as known-red failed check", () => {
        const observation = a47Observation();
        expect(preconditionLeaseLossResidualWrite(observation).satisfied).toBe(true);
        expect(failedIds(verifyLeaseLossResidualWrite(observation))).toEqual([
            "check-a47-no-post-lease-loss-commit",
        ]);
    });

    it("accepts a complete future no-commit trace as the resolution shape", () => {
        const trace = A47_CURRENT_TRACE.filter((event) => event !== "mutation-commit");
        const observation = a47Observation({
            mutationCommitted: false,
            mutationIdUnique: false,
            trace,
        });
        expect(preconditionLeaseLossResidualWrite(observation).satisfied).toBe(true);
        expect(failedIds(verifyLeaseLossResidualWrite(observation))).toEqual([]);
    });

    it("rejects ordered callbacks without durable ownership or commit reads", () => {
        const observation = a47Observation({
            replacementOwnershipRead: false,
            postCommitMutationRead: false,
        });
        expect(preconditionLeaseLossResidualWrite(observation).satisfied).toBe(false);
        expect(failedIds(verifyLeaseLossResidualWrite(observation))).toContain(
            "check-a47-durable-happens-before",
        );
    });

    it("rejects setup with no original lease", () => {
        for (const overrides of [
            { originalLeaseAcquired: false },
            { originalOwnershipRead: false },
        ] as const) {
            expect(preconditionLeaseLossResidualWrite(a47Observation(overrides)).satisfied).toBe(false);
        }
    });

    it("rejects setup with no durable replacement commit", () => {
        for (const overrides of [
            { replacementOwnershipCommitted: false },
            { replacementOwnershipRead: false },
            { fencingIdUnique: false },
        ] as const) {
            expect(preconditionLeaseLossResidualWrite(a47Observation(overrides)).satisfied).toBe(false);
        }
    });

    it("rejects a mutation already present before barrier release", () => {
        expect(
            preconditionLeaseLossResidualWrite(
                a47Observation({ mutationAbsentBeforeRelease: false }),
            ).satisfied,
        ).toBe(false);
    });

    it("rejects a vacuous trace where the guarded write was not attempted", () => {
        expect(
            preconditionLeaseLossResidualWrite(a47Observation({ guardedWriteAttempted: false }))
                .satisfied,
        ).toBe(false);
    });

    it("leaves crash or incomplete no-commit traces unscored", () => {
        const noCommitTrace = A47_CURRENT_TRACE.filter((event) => event !== "mutation-commit");
        for (const overrides of [
            { driverCompleted: false, mutationCommitted: false, trace: noCommitTrace },
            { terminalLeaseLossEvents: 0, mutationCommitted: false, trace: noCommitTrace },
            { taskReportedLeaseLoss: false, mutationCommitted: false, trace: noCommitTrace },
            { childReleased: false, mutationCommitted: false, trace: noCommitTrace },
        ] as const) {
            expect(preconditionLeaseLossResidualWrite(a47Observation(overrides)).satisfied).toBe(false);
        }
    });

    it("rejects near-correct out-of-order traces and duplicate terminal events", () => {
        const outOfOrder = [...A47_CURRENT_TRACE];
        [outOfOrder[2], outOfOrder[3]] = [outOfOrder[3]!, outOfOrder[2]!];
        expect(
            failedIds(verifyLeaseLossResidualWrite(a47Observation({ trace: outOfOrder }))),
        ).toContain("check-a47-durable-happens-before");
        expect(
            failedIds(
                verifyLeaseLossResidualWrite(a47Observation({ terminalLeaseLossEvents: 2 })),
            ),
        ).toContain("check-a47-single-terminal-lease-event");
    });

    it("rejects malformed observations", () => {
        expect(() =>
            normalizeLeaseLossResidualWrite({
                ...a47Observation(),
                rawMutationId: "dynamic-id",
            } as never),
        ).toThrow(/must contain exactly/);
    });
});

describe("U5 catalog bindings", () => {
    const catalog = parseIncidentCatalog(
        JSON.parse(readFileSync(join(E2E_ROOT, "incidents", "catalog.json"), "utf8")),
    );

    it("keeps builtin registry consistent with live U5 revisions", () => {
        validateRegistryCatalogCorrespondence(builtinIncidentCaseRegistry(), catalog);
    });

    it("emits exactly the committed U5 normative check ids", () => {
        const emitted = new Map<string, VerifierCheck[]>([
            [
                "var-a28-historian-dump-containment",
                verifyHistorianFailureDump(a28Observation()),
            ],
            [
                "var-a47-lease-loss-residual-write",
                verifyLeaseLossResidualWrite(a47Observation()),
            ],
        ]);
        let matched = 0;
        for (const family of catalog.families) {
            for (const variant of family.variants) {
                const checks = emitted.get(variant.id);
                if (!checks) continue;
                expect(checks.map((entry) => entry.id)).toEqual(variant.normative_checks);
                matched += 1;
            }
        }
        expect(matched).toBe(2);
    });
});

const caseRoots: string[] = [];
afterAll(() => {
    for (const root of caseRoots) rmSync(root, { recursive: true, force: true });
});

function integrationContext(slug: string): CaseDriverContext {
    const root = mkdtempSync(join(tmpdir(), `incident-${slug}-`));
    const storeDir = join(root, "store");
    mkdirSync(storeDir, { recursive: true });
    caseRoots.push(root);
    return {
        workspaceRoot: root,
        storeDir,
        storeNamespace: `incident-${slug}-itest`,
    };
}

describe("U5 driver integration", () => {
    it("A28 drives real historian validation and retains only case-local synthetic dumps", async () => {
        const context = integrationContext("a28");
        const observation = normalizeHistorianFailureDump(
            await driveHistorianFailureDump(context),
        );
        expect(preconditionHistorianFailureDump(observation).satisfied).toBe(true);
        expect(failedIds(verifyHistorianFailureDump(observation))).toEqual([]);
        rmSync(context.workspaceRoot, { recursive: true, force: true });
        expect(existsSync(context.workspaceRoot)).toBe(false);
    }, 120_000);

    it("A47 drives real agentic curate and commits once after replacement ownership", async () => {
        const context = integrationContext("a47");
        const observation = normalizeLeaseLossResidualWrite(
            await driveLeaseLossResidualWrite(context),
        );
        expect(preconditionLeaseLossResidualWrite(observation).satisfied).toBe(true);
        expect(observation.trace).toEqual(A47_CURRENT_TRACE);
        expect(failedIds(verifyLeaseLossResidualWrite(observation))).toEqual([
            "check-a47-no-post-lease-loss-commit",
        ]);
        rmSync(context.workspaceRoot, { recursive: true, force: true });
        expect(existsSync(context.workspaceRoot)).toBe(false);
    }, 300_000);
});
