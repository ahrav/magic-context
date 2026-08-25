import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    deterministicEmbedding,
    MockProvider,
} from "../../mock-provider/server";
import {
    driveArchivedReobservation,
    driveCrossSourceRank,
    driveEmbeddingFreshness,
    drivePendingNoteRecall,
    driveSupersedeReconciliation,
    normalizeArchivedReobservation,
    normalizeCrossSourceRank,
    normalizeEmbeddingFreshness,
    normalizePendingNoteRecall,
    normalizeSupersedeReconciliation,
    preconditionArchivedReobservation,
    preconditionCrossSourceRank,
    preconditionEmbeddingFreshness,
    preconditionPendingNoteRecall,
    preconditionSupersedeReconciliation,
    verifyArchivedReobservation,
    verifyCrossSourceRank,
    verifyEmbeddingFreshness,
    verifyPendingNoteRecall,
    verifySupersedeReconciliation,
    type ArchivedReobservationObservation,
    type CrossSourceRankObservation,
    type EmbeddingFreshnessObservation,
    type PendingNoteRecallObservation,
    type SupersedeReconciliationObservation,
} from "./audit-memory-search";

function failedIds(checks: VerifierCheck[]): string[] {
    return checks.filter((check) => !check.passed).map((check) => check.id);
}

function a5Observation(
    overrides: Partial<ArchivedReobservationObservation> = {},
): ArchivedReobservationObservation {
    return {
        kind: "a5-archived-reobservation",
        memoryToolPublished: true,
        searchToolPublished: true,
        argsValidated: true,
        workspaceScoped: true,
        namespaceUnique: true,
        writeAcknowledged: true,
        archiveAcknowledged: true,
        reobserveDuplicateAcknowledged: true,
        reobserveSameRow: true,
        factRowCount: 1,
        activeFactRowCount: 0,
        factRowStatus: "archived",
        recurrenceCount: 2,
        observerReadConsistent: true,
        searchAcknowledged: true,
        searchReturnsFact: false,
        ...overrides,
    };
}

function a10Observation(
    overrides: Partial<SupersedeReconciliationObservation> = {},
): SupersedeReconciliationObservation {
    return {
        kind: "a10-supersede-reconciliation",
        memoryToolPublished: true,
        argsValidated: true,
        workspaceScoped: true,
        namespaceUnique: true,
        baselineShowsOriginal: true,
        updateAcknowledged: true,
        m0StaleAfterUpdate: true,
        m1CarriesUpdateDelta: true,
        m1DeltaShowsRevised: true,
        m1PresentsOriginalAsCurrent: false,
        freshFoldShowsRevised: true,
        freshFoldShowsOriginal: false,
        ...overrides,
    };
}

function a32Observation(
    overrides: Partial<EmbeddingFreshnessObservation> = {},
): EmbeddingFreshnessObservation {
    return {
        kind: "a32-embedding-freshness",
        memoryToolPublished: true,
        searchToolPublished: true,
        argsValidated: true,
        workspaceScoped: true,
        namespaceUnique: true,
        schemaSentinel: true,
        emptyStateAtStart: true,
        seedEmbedded: true,
        seedVectorMatchesOldContent: true,
        editApplied: true,
        editKeptRowId: true,
        staleVectorPersistedAfterEdit: true,
        freshVectorWouldDiffer: true,
        lexicalOverlapStaleQuery: false,
        lexicalOverlapFreshQuery: false,
        staleQueryEmbedded: true,
        freshQueryEmbedded: true,
        staleQueryReturnsMemory: true,
        staleQueryMatchSemantic: true,
        freshQueryReturnsMemory: false,
        passageReembedObserved: false,
        vectorReplacedBySearchTime: false,
        ...overrides,
    };
}

function a44Observation(
    overrides: Partial<CrossSourceRankObservation> = {},
): CrossSourceRankObservation {
    return {
        kind: "a44-cross-source-rank",
        memoryToolPublished: true,
        searchToolPublished: true,
        argsValidated: true,
        workspaceScoped: true,
        namespaceUnique: true,
        compartmentCoversProbe: true,
        memoryDelivered: true,
        messageDelivered: true,
        memoryContentMatchesQuery: true,
        messageContentMatchesQuery: true,
        memoryOutranksMessage: false,
        ...overrides,
    };
}

function a54Observation(
    overrides: Partial<PendingNoteRecallObservation> = {},
): PendingNoteRecallObservation {
    return {
        kind: "a54-pending-note-recall",
        noteToolPublished: true,
        searchToolPublished: true,
        argsValidated: true,
        workspaceScoped: true,
        namespaceUnique: true,
        noteCreateAcknowledged: true,
        noteDurablePending: true,
        ordinaryTurnSurfacedNote: false,
        explicitSearchReturnedNote: true,
        explicitSearchLabeledPending: true,
        ...overrides,
    };
}

describe("A5 archived re-observation verifier (invalid states)", () => {
    it("passes the accepted archived-reobservation state", () => {
        const checks = verifyArchivedReobservation(a5Observation());
        expect(failedIds(checks)).toEqual([]);
        expect(
            preconditionArchivedReobservation(a5Observation()).satisfied,
        ).toBe(true);
    });

    it("fails when re-observation created a second active row", () => {
        const failed = failedIds(
            verifyArchivedReobservation(
                a5Observation({ factRowCount: 2, activeFactRowCount: 1 }),
            ),
        );
        expect(failed).toContain("check-a5-archived-row-preserved");
        expect(failed).toContain("check-a5-no-active-duplicate");
    });

    it("fails when the archived row was revived without an explicit restore (correct content, wrong lifecycle state)", () => {
        const failed = failedIds(
            verifyArchivedReobservation(
                a5Observation({
                    factRowStatus: "active",
                    activeFactRowCount: 1,
                }),
            ),
        );
        expect(failed).toContain("check-a5-archived-row-preserved");
        expect(failed).toContain("check-a5-no-active-duplicate");
    });

    it("fails when archived content is visible to agent recall", () => {
        expect(
            failedIds(
                verifyArchivedReobservation(
                    a5Observation({ searchReturnsFact: true }),
                ),
            ),
        ).toEqual(["check-a5-no-agent-recall"]);
    });

    it("rejects false success narration: duplicate acknowledged but recurrence never incremented", () => {
        expect(
            failedIds(
                verifyArchivedReobservation(
                    a5Observation({ recurrenceCount: 1 }),
                ),
            ),
        ).toEqual(["check-a5-recurrence-incremented"]);
    });

    it("rejects a SQLite-only state with no agent-visible search result", () => {
        expect(
            failedIds(
                verifyArchivedReobservation(
                    a5Observation({ searchAcknowledged: false }),
                ),
            ),
        ).toEqual(["check-a5-no-agent-recall"]);
    });

    it("cannot be satisfied by a wrong tool name or a result from another workspace", () => {
        for (const overrides of [
            { memoryToolPublished: false },
            { searchToolPublished: false },
            { argsValidated: false },
            { workspaceScoped: false },
            { namespaceUnique: false },
            { observerReadConsistent: false },
        ] as const) {
            const outcome = preconditionArchivedReobservation(
                a5Observation(overrides),
            );
            expect(outcome.satisfied).toBe(false);
            if (!outcome.satisfied) {
                expect(outcome.reason).toBe("precondition_unmet");
            }
        }
    });

    it("rejects malformed observations instead of scoring them", () => {
        expect(() =>
            verifyArchivedReobservation({
                kind: "a5-archived-reobservation",
            } as unknown as NormalizedObservation),
        ).toThrow(/must contain exactly/);
        expect(() =>
            normalizeArchivedReobservation({
                ...a5Observation(),
                extraField: true,
            } as never),
        ).toThrow(/must contain exactly/);
    });
});

describe("A10/A41 supersede reconciliation verifier (AE6)", () => {
    it("passes stale cached m0 bytes plus the correct m1 supersede correction", () => {
        expect(
            failedIds(verifySupersedeReconciliation(a10Observation())),
        ).toEqual([]);
        expect(
            preconditionSupersedeReconciliation(a10Observation()).satisfied,
        ).toBe(true);
    });

    it("fails stale m0 WITHOUT the m1 correction (AE6)", () => {
        expect(
            failedIds(
                verifySupersedeReconciliation(
                    a10Observation({
                        m1CarriesUpdateDelta: false,
                        m1DeltaShowsRevised: false,
                    }),
                ),
            ),
        ).toEqual(["check-a10-effective-context-reconciled"]);
    });

    it("fails when old and new claims both read as authoritative, even with the new text present", () => {
        expect(
            failedIds(
                verifySupersedeReconciliation(
                    a10Observation({ m1PresentsOriginalAsCurrent: true }),
                ),
            ),
        ).toEqual(["check-a10-no-dual-authority"]);
        const foldKeepsBoth = failedIds(
            verifySupersedeReconciliation(
                a10Observation({ freshFoldShowsOriginal: true }),
            ),
        );
        expect(foldKeepsBoth).toContain("check-a10-no-dual-authority");
        expect(foldKeepsBoth).toContain("check-a10-hard-fold-convergence");
    });

    it("fails a hard fold that never converges on the revised value", () => {
        const failed = failedIds(
            verifySupersedeReconciliation(
                a10Observation({
                    freshFoldShowsRevised: false,
                    freshFoldShowsOriginal: true,
                }),
            ),
        );
        expect(failed).toEqual(["check-a10-hard-fold-convergence"]);
    });

    it("rejects false success narration: update acknowledged without a rendered baseline", () => {
        const outcome = preconditionSupersedeReconciliation(
            a10Observation({ baselineShowsOriginal: false }),
        );
        expect(outcome.satisfied).toBe(false);
    });
});

describe("A32 embedding freshness verifier (known red)", () => {
    it("records the current known-red state with both normative checks failing", () => {
        const observation = a32Observation();
        expect(preconditionEmbeddingFreshness(observation).satisfied).toBe(
            true,
        );
        expect(failedIds(verifyEmbeddingFreshness(observation))).toEqual([
            "check-a32-fresh-semantic-recall",
            "check-a32-stale-vector-replaced",
        ]);
    });

    it("passes both checks once recall is fresh and the vector was replaced (resolution shape)", () => {
        expect(
            failedIds(
                verifyEmbeddingFreshness(
                    a32Observation({
                        staleQueryReturnsMemory: false,
                        staleQueryMatchSemantic: false,
                        freshQueryReturnsMemory: true,
                        passageReembedObserved: true,
                        vectorReplacedBySearchTime: true,
                    }),
                ),
            ),
        ).toEqual([]);
    });

    it("fails the reproduction precondition when lexical overlap could bypass the semantic lane", () => {
        for (const overrides of [
            { lexicalOverlapStaleQuery: true },
            { lexicalOverlapFreshQuery: true },
            { staleQueryMatchSemantic: false },
            { staleQueryEmbedded: false },
        ] as const) {
            expect(
                preconditionEmbeddingFreshness(a32Observation(overrides))
                    .satisfied,
            ).toBe(false);
        }
    });

    it("rejects a re-embedded (fresh) vector presented as stale", () => {
        expect(
            preconditionEmbeddingFreshness(
                a32Observation({ staleVectorPersistedAfterEdit: false }),
            ).satisfied,
        ).toBe(false);
        expect(
            preconditionEmbeddingFreshness(
                a32Observation({ freshVectorWouldDiffer: false }),
            ).satisfied,
        ).toBe(false);
    });

    it("rejects a vacuous setup: no persisted seed vector or a broken in-place edit", () => {
        for (const overrides of [
            { seedEmbedded: false },
            { seedVectorMatchesOldContent: false },
            { editApplied: false },
            { editKeptRowId: false },
            { schemaSentinel: false },
            { emptyStateAtStart: false },
        ] as const) {
            expect(
                preconditionEmbeddingFreshness(a32Observation(overrides))
                    .satisfied,
            ).toBe(false);
        }
    });
});

describe("A44 cross-source rank verifier (known red)", () => {
    it("records the current known-red ordering with nonvacuity intact", () => {
        const observation = a44Observation();
        expect(preconditionCrossSourceRank(observation).satisfied).toBe(true);
        expect(failedIds(verifyCrossSourceRank(observation))).toEqual([
            "check-a44-known-better-memory-outranks",
        ]);
    });

    it("passes once the known-better memory outranks the message (resolution shape)", () => {
        expect(
            failedIds(
                verifyCrossSourceRank(
                    a44Observation({ memoryOutranksMessage: true }),
                ),
            ),
        ).toEqual([]);
    });

    it("rejects a verifier fed only one eligible candidate", () => {
        for (const overrides of [
            { memoryDelivered: false },
            { messageDelivered: false },
            { memoryContentMatchesQuery: false },
            { messageContentMatchesQuery: false },
        ] as const) {
            const observation = a44Observation(overrides);
            expect(preconditionCrossSourceRank(observation).satisfied).toBe(
                false,
            );
            expect(failedIds(verifyCrossSourceRank(observation))).toContain(
                "check-a44-two-candidate-nonvacuity",
            );
        }
    });

    it("rejects a missing message-lane cutoff (probe not covered by a compartment)", () => {
        expect(
            preconditionCrossSourceRank(
                a44Observation({ compartmentCoversProbe: false }),
            ).satisfied,
        ).toBe(false);
    });
});

describe("A54 pending note recall verifier", () => {
    it("passes only when explicit search labels pending AND ordinary context omits the note", () => {
        expect(failedIds(verifyPendingNoteRecall(a54Observation()))).toEqual(
            [],
        );
        expect(preconditionPendingNoteRecall(a54Observation()).satisfied).toBe(
            true,
        );
    });

    it("fails when the pending note surfaces on an ordinary turn", () => {
        expect(
            failedIds(
                verifyPendingNoteRecall(
                    a54Observation({ ordinaryTurnSurfacedNote: true }),
                ),
            ),
        ).toEqual(["check-a54-no-unprompted-surfacing"]);
    });

    it("fails when the explicit search result omits the pending status label", () => {
        expect(
            failedIds(
                verifyPendingNoteRecall(
                    a54Observation({ explicitSearchLabeledPending: false }),
                ),
            ),
        ).toEqual(["check-a54-explicit-search-pending-status"]);
        expect(
            failedIds(
                verifyPendingNoteRecall(
                    a54Observation({ explicitSearchReturnedNote: false }),
                ),
            ),
        ).toEqual(["check-a54-explicit-search-pending-status"]);
    });

    it("rejects a note that never persisted as pending", () => {
        expect(
            preconditionPendingNoteRecall(
                a54Observation({ noteDurablePending: false }),
            ).satisfied,
        ).toBe(false);
    });
});

describe("catalog binding surface", () => {
    const catalog = parseIncidentCatalog(
        JSON.parse(
            readFileSync(join(E2E_ROOT, "incidents", "catalog.json"), "utf8"),
        ),
    );

    it("keeps the builtin registry consistent with the committed catalog", () => {
        validateRegistryCatalogCorrespondence(
            builtinIncidentCaseRegistry(),
            catalog,
        );
    });

    it("emits exactly the committed normative check ids per case", () => {
        const emitted: Record<string, VerifierCheck[]> = {
            "var-a5-archived-reobservation": verifyArchivedReobservation(
                a5Observation(),
            ),
            "var-a10-supersede-effective-context":
                verifySupersedeReconciliation(a10Observation()),
            "var-a32-stale-embedding-recall": verifyEmbeddingFreshness(
                a32Observation(),
            ),
            "var-a44-cross-source-rank-remap": verifyCrossSourceRank(
                a44Observation(),
            ),
            "var-a54-pending-note-recall": verifyPendingNoteRecall(
                a54Observation(),
            ),
        };
        let matched = 0;
        for (const family of catalog.families) {
            for (const variant of family.variants) {
                const checks = emitted[variant.id];
                if (!checks) continue;
                expect(checks.map((check) => check.id)).toEqual(
                    variant.normative_checks,
                );
                matched++;
            }
        }
        expect(matched).toBe(5);
    });
});

describe("deterministic embedding endpoint", () => {
    it("returns the same vector for the same input and separates marker axes", () => {
        const aurora = deterministicEmbedding("the aurora ledger");
        expect(deterministicEmbedding("the aurora ledger")).toEqual(aurora);
        const borealis = deterministicEmbedding("borealis dossier");
        const cascade = deterministicEmbedding("cascade checklist");
        const dot = (a: number[], b: number[]): number =>
            a.reduce((sum, value, i) => sum + value * b[i]!, 0);
        expect(dot(aurora, borealis)).toBeCloseTo(1, 5);
        expect(dot(aurora, cascade)).toBeCloseTo(0, 5);
    });

    it("records request provenance for /embeddings", async () => {
        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        try {
            const response = await fetch(`${baseURL}/embeddings`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "mock-embed",
                    input: ["aurora sample"],
                    input_type: "passage",
                }),
            });
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                data: Array<{ embedding: number[] }>;
                model: string;
            };
            expect(body.model).toBe("mock-embed");
            expect(body.data[0]!.embedding).toEqual(
                deterministicEmbedding("aurora sample"),
            );
            const captured = mock.embeddingRequests();
            expect(captured).toHaveLength(1);
            expect(captured[0]!.model).toBe("mock-embed");
            expect(captured[0]!.inputType).toBe("passage");
            expect(captured[0]!.inputs).toEqual(["aurora sample"]);
        } finally {
            await mock.stop();
        }
    });
});

const caseRoots: string[] = [];
afterAll(() => {
    for (const root of caseRoots)
        rmSync(root, { recursive: true, force: true });
});

function integrationContext(slug: string): CaseDriverContext {
    const root = mkdtempSync(join(tmpdir(), `incident-${slug}-`));
    caseRoots.push(root);
    return {
        workspaceRoot: root,
        storeDir: join(root, "store"),
        storeNamespace: `incident-${slug}-itest`,
    };
}

describe("driver integration (real harness)", () => {
    it("A5 drives the real ctx_memory/ctx_search loop and passes green", async () => {
        const observation = normalizeArchivedReobservation(
            await driveArchivedReobservation(integrationContext("a5")),
        );
        expect(preconditionArchivedReobservation(observation).satisfied).toBe(
            true,
        );
        expect(failedIds(verifyArchivedReobservation(observation))).toEqual([]);
    }, 300_000);

    it("A10/A41 judges stale m0 plus the m1 correction and converges on a hard fold", async () => {
        const observation = normalizeSupersedeReconciliation(
            await driveSupersedeReconciliation(integrationContext("a10")),
        );
        expect(preconditionSupersedeReconciliation(observation).satisfied).toBe(
            true,
        );
        expect(failedIds(verifySupersedeReconciliation(observation))).toEqual(
            [],
        );
    }, 300_000);

    it("A32 reproduces stale semantic recall through the semantic lane (known red)", async () => {
        const observation = normalizeEmbeddingFreshness(
            await driveEmbeddingFreshness(integrationContext("a32")),
        );
        expect(preconditionEmbeddingFreshness(observation).satisfied).toBe(
            true,
        );
        expect(observation.staleQueryMatchSemantic).toBe(true);
        expect(failedIds(verifyEmbeddingFreshness(observation))).toEqual([
            "check-a32-fresh-semantic-recall",
            "check-a32-stale-vector-replaced",
        ]);
    }, 300_000);

    it("A44 reproduces the common-literal message outranking the known-better memory (known red)", async () => {
        const observation = normalizeCrossSourceRank(
            await driveCrossSourceRank(integrationContext("a44")),
        );
        expect(preconditionCrossSourceRank(observation).satisfied).toBe(true);
        expect(failedIds(verifyCrossSourceRank(observation))).toEqual([
            "check-a44-known-better-memory-outranks",
        ]);
    }, 420_000);

    it("A54 returns the pending note on explicit search only", async () => {
        const observation = normalizePendingNoteRecall(
            await drivePendingNoteRecall(integrationContext("a54")),
        );
        expect(preconditionPendingNoteRecall(observation).satisfied).toBe(true);
        expect(failedIds(verifyPendingNoteRecall(observation))).toEqual([]);
    }, 300_000);
});
