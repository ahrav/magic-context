import { describe, expect, mock, test } from "bun:test";

import { DREAMER_REVIEWER_AGENT } from "../../../agents/dreamer";
import type { Database } from "../../../shared/sqlite";
import { dreamerManifestIdentity, readDreamerProjectClaims } from "../dreamer/claim-manifest";
import { assistantMessages } from "../dreamer/dreamer-test-support";
import { acquireLeaseWithAcquisition, releaseLease } from "../dreamer/lease";
import { claimEffectMemoryChanges } from "../dreamer/storage-dream-runs";
import { createDirectTestDatabase } from "../test-database";
import {
    applyUserMemoryReviewManifest,
    captureUserMemoryReviewSnapshot,
    parseUserMemoryReviewManifest,
    reviewUserMemories,
} from "./review-user-memories";
import {
    getActiveUserMemories,
    getUserMemoryCandidates,
    insertUserMemory,
    insertUserMemoryCandidates,
} from "./storage-user-memory";

const PROJECT = "git:user-memory-review";
const OTHER_PROJECT = "git:other-project";
const LEASE = "user-memories";

function freshDb(): Database {
    return createDirectTestDatabase().db;
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function bindSession(db: Database, sessionId: string, projectIdentity = PROJECT): void {
    db.prepare(
        `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
         VALUES (?, 'opencode', ?, ?)`,
    ).run(sessionId, projectIdentity, Date.now());
}

function acquire(db: Database, holderId = "holder") {
    const acquisition = acquireLeaseWithAcquisition(db, holderId, LEASE);
    if (!acquisition) throw new Error("test lease unavailable");
    return acquisition;
}

function reviewClient(text: string, beforeMessages?: () => void) {
    return {
        session: {
            create: mock(async () => ({ id: "child-user-memories" })),
            prompt: mock(async () => ({})),
            messages: mock(async () => {
                beforeMessages?.();
                return assistantMessages(text);
            }),
            delete: mock(async () => ({})),
        },
    } as never;
}

function recordingReviewClient(text: string) {
    const prompts: string[] = [];
    const client = {
        session: {
            create: mock(async () => ({ id: "child-user-memories" })),
            prompt: mock(async (input: { body?: { parts?: Array<{ text?: string }> } }) => {
                const promptText = input.body?.parts?.[0]?.text;
                if (typeof promptText === "string") prompts.push(promptText);
                return {};
            }),
            messages: mock(async () => assistantMessages(text)),
            delete: mock(async () => ({})),
        },
    };
    return { client: client as never, prompts };
}

function seedCandidates(db: Database, contents: string[]): number[] {
    contents.forEach((content, index) => {
        const sessionId = `s${index + 1}`;
        bindSession(db, sessionId);
        insertUserMemoryCandidates(db, [{ content, sessionId }]);
    });
    return getUserMemoryCandidates(db).map((candidate) => candidate.id);
}

describe("reviewUserMemories", () => {
    test("applies and replays one bound profile/project manifest atomically", () => {
        const db = freshDb();
        const holderId = "holder-replay";
        const acquisition = acquire(db, holderId);
        const [profileCandidate, projectCandidate, updateCandidate] = seedCandidates(db, [
            "User prefers concise updates",
            "This project requires focused tests before commit",
            "User prefers root-cause summaries",
        ]);
        const updateId = insertUserMemory(db, "User likes short answers", []);
        const dismissId = insertUserMemory(db, "User wants verbose digressions", []);
        const snapshot = captureUserMemoryReviewSnapshot(db, PROJECT);
        const manifest = parseUserMemoryReviewManifest({
            promote: [
                {
                    content: "User prefers concise updates.",
                    candidate_ids: [profileCandidate],
                },
            ],
            promote_project: [
                {
                    content: "Run focused tests before commit.",
                    category: "PROJECT_RULES",
                    candidate_ids: [projectCandidate],
                },
            ],
            update_existing: [
                {
                    memory_id: updateId,
                    content: "User prefers concise root-cause summaries.",
                    candidate_ids: [updateCandidate],
                },
            ],
            dismiss_existing: [{ memory_id: dismissId, reason: "contradicted" }],
            consume_candidate_ids: [profileCandidate, projectCandidate, updateCandidate],
        });
        const identity = dreamerManifestIdentity({
            db,
            holderId,
            leaseKey: LEASE,
            task: "review-user-memories",
            publicClaimIds: [`snapshot:${snapshot.digest}`],
        });
        const apply = () =>
            applyUserMemoryReviewManifest({
                db,
                projectIdentity: PROJECT,
                holderId,
                leaseKey: LEASE,
                expectedLeaseGeneration: acquisition.generation,
                identity,
                snapshot,
                manifest,
                // These cases exercise apply/replay atomicity, not corroboration.
                promotionThreshold: 1,
                nowMs: 50_000,
            });

        const first = apply();
        const version = (
            db
                .prepare(
                    "SELECT project_user_profile_version AS version FROM project_state WHERE project_path = ?",
                )
                .get("__global__") as { version: number }
        ).version;
        const second = apply();

        expect(first).toMatchObject({
            result: {
                promoted: 1,
                projectPromoted: 1,
                merged: 1,
                dismissed: 1,
                candidatesConsumed: 3,
            },
            replayed: false,
            staleReason: null,
        });
        // A project promotion commits a claim, so the outcome has to carry the
        // effects the dream-run audit records; counts alone lose the claim IDs.
        expect(first.result.effects.length).toBeGreaterThan(0);
        expect(claimEffectMemoryChanges(first.result.effects)).not.toBeNull();
        expect(second).toEqual({ ...first, replayed: true });
        expect(getUserMemoryCandidates(db)).toHaveLength(0);
        expect(getActiveUserMemories(db).map((memory) => memory.content)).toEqual([
            "User prefers concise root-cause summaries.",
            "User prefers concise updates.",
        ]);
        expect(
            getActiveUserMemories(db).find((memory) => memory.id === updateId)?.sourceCandidateIds,
        ).toEqual([updateCandidate]);
        expect(
            (
                db
                    .prepare(
                        "SELECT project_user_profile_version AS version FROM project_state WHERE project_path = ?",
                    )
                    .get("__global__") as { version: number }
            ).version,
        ).toBe(version);
        expect(readDreamerProjectClaims(db, PROJECT, "hygiene")).toHaveLength(1);
        expect(count(db, "claim_operation_receipts")).toBe(1);
        expect(count(db, "claim_operation_effects")).toBe(1);
        expect(
            (
                db
                    .prepare(
                        `SELECT source_trust_class AS trust
                           FROM observations
                          ORDER BY id DESC LIMIT 1`,
                    )
                    .get() as { trust: string }
            ).trust,
        ).toBe("model_inference");
        expect(
            (
                db
                    .prepare(
                        `SELECT generation FROM claim_project_generations
                          JOIN projects ON projects.id = claim_project_generations.project_id
                         WHERE projects.canonical_identity = ?`,
                    )
                    .get(PROJECT) as { generation: number }
            ).generation,
        ).toBe(1);
        db.close();
    });

    test("an under-corroborated project promotion is refused", () => {
        // The threshold only decides whether the review runs; a qualifying
        // snapshot of three unrelated candidates can still yield a manifest that
        // promotes one of them, turning a single observation into a durable
        // project claim the prompt said required recurrence.
        const db = freshDb();
        const holderId = "holder-threshold";
        const acquisition = acquire(db, holderId);
        const [a, b, c] = seedCandidates(db, [
            "This project pins the toolchain",
            "User prefers short explanations",
            "This project runs focused tests",
        ]);
        const snapshot = captureUserMemoryReviewSnapshot(db, PROJECT);
        const manifest = parseUserMemoryReviewManifest({
            promote_project: [
                {
                    content: "Pin the toolchain.",
                    category: "PROJECT_RULES",
                    candidate_ids: [a],
                },
            ],
            consume_candidate_ids: [a, b, c],
        });
        const identity = dreamerManifestIdentity({
            db,
            holderId,
            leaseKey: LEASE,
            task: "review-user-memories",
            publicClaimIds: [`snapshot:${snapshot.digest}`],
        });

        expect(() =>
            applyUserMemoryReviewManifest({
                db,
                projectIdentity: PROJECT,
                holderId,
                leaseKey: LEASE,
                expectedLeaseGeneration: acquisition.generation,
                identity,
                snapshot,
                manifest,
                promotionThreshold: 3,
            }),
        ).toThrow(/carries 1 candidate\(s\); 3 are required/);
        expect(readDreamerProjectClaims(db, PROJECT, "hygiene")).toHaveLength(0);
    });

    test("rolls claim receipt, effect, generation, and profile changes back together", () => {
        const db = freshDb();
        const holderId = "holder-rollback";
        const acquisition = acquire(db, holderId);
        const [projectCandidate, updateCandidate] = seedCandidates(db, [
            "This project uses one release checklist",
            "User prefers short explanations",
        ]);
        const updateId = insertUserMemory(db, "Old profile text", []);
        const snapshot = captureUserMemoryReviewSnapshot(db, PROJECT);
        const manifest = parseUserMemoryReviewManifest({
            promote_project: [
                {
                    content: "Use one release checklist.",
                    category: "PROJECT_RULES",
                    candidate_ids: [projectCandidate],
                },
            ],
            update_existing: [
                {
                    memory_id: updateId,
                    content: "New profile text",
                    candidate_ids: [updateCandidate],
                },
            ],
            consume_candidate_ids: [projectCandidate, updateCandidate],
        });
        const identity = dreamerManifestIdentity({
            db,
            holderId,
            leaseKey: LEASE,
            task: "review-user-memories",
            publicClaimIds: [`snapshot:${snapshot.digest}`],
        });
        db.exec(`
            CREATE TRIGGER fail_profile_update BEFORE UPDATE ON user_memories
            BEGIN SELECT RAISE(ABORT, 'profile update failed'); END;
        `);

        expect(() =>
            applyUserMemoryReviewManifest({
                db,
                projectIdentity: PROJECT,
                holderId,
                leaseKey: LEASE,
                expectedLeaseGeneration: acquisition.generation,
                identity,
                snapshot,
                manifest,
                promotionThreshold: 1,
            }),
        ).toThrow("profile update failed");
        expect(readDreamerProjectClaims(db, PROJECT, "hygiene")).toHaveLength(0);
        expect(count(db, "claim_operation_receipts")).toBe(0);
        expect(count(db, "claim_operation_effects")).toBe(0);
        expect(count(db, "claim_project_generations")).toBe(0);
        expect(getActiveUserMemories(db)[0]?.content).toBe("Old profile text");
        expect(getUserMemoryCandidates(db)).toHaveLength(2);
        db.close();
    });

    test("malformed output records one zero-effect rejection and changes no profile rows", async () => {
        const db = freshDb();
        const holderId = "holder-malformed";
        const acquisition = acquire(db, holderId);
        seedCandidates(db, ["User prefers concise updates"]);

        await expect(
            reviewUserMemories({
                db,
                client: reviewClient('{"promote":"not-an-array"}'),
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId,
                leaseKey: LEASE,
                deadline: Date.now() + 60_000,
                leaseAcquisition: acquisition,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow("promote must be an array");

        expect(count(db, "claim_operation_receipts")).toBe(1);
        expect(count(db, "claim_operation_effects")).toBe(0);
        expect(count(db, "claim_project_generations")).toBe(0);
        expect(getActiveUserMemories(db)).toHaveLength(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });

    test("stale prompt snapshot commits only a zero-effect receipt", async () => {
        const db = freshDb();
        const holderId = "holder-stale";
        const acquisition = acquire(db, holderId);
        const [candidateId] = seedCandidates(db, ["User prefers concise updates"]);
        const output = JSON.stringify({
            promote: [
                {
                    content: "User prefers concise updates.",
                    candidate_ids: [candidateId],
                },
            ],
            consume_candidate_ids: [candidateId],
        });

        await expect(
            reviewUserMemories({
                db,
                client: reviewClient(output, () => {
                    db.prepare("UPDATE user_memory_candidates SET content = ? WHERE id = ?").run(
                        "changed concurrently",
                        candidateId,
                    );
                }),
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId,
                leaseKey: LEASE,
                deadline: Date.now() + 60_000,
                leaseAcquisition: acquisition,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow("manifest is stale");

        expect(count(db, "claim_operation_receipts")).toBe(1);
        expect(count(db, "claim_operation_effects")).toBe(0);
        expect(count(db, "claim_project_generations")).toBe(0);
        expect(getActiveUserMemories(db)).toHaveLength(0);
        expect(getUserMemoryCandidates(db)[0]?.content).toBe("changed concurrently");
        db.close();
    });

    test("lease loss after provider output leaves all semantic stores unchanged", async () => {
        const db = freshDb();
        const holderId = "holder-lost";
        const acquisition = acquire(db, holderId);
        const [candidateId] = seedCandidates(db, ["User prefers concise updates"]);
        const output = JSON.stringify({
            promote: [
                {
                    content: "User prefers concise updates.",
                    candidate_ids: [candidateId],
                },
            ],
            consume_candidate_ids: [candidateId],
        });

        await expect(
            reviewUserMemories({
                db,
                client: reviewClient(output, () => {
                    releaseLease(db, holderId, LEASE);
                    acquireLeaseWithAcquisition(db, "other-holder", LEASE);
                }),
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId,
                leaseKey: LEASE,
                deadline: Date.now() + 60_000,
                leaseAcquisition: acquisition,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow("Dream lease lost before guarded write");

        expect(count(db, "claim_operation_receipts")).toBe(0);
        expect(count(db, "claim_operation_effects")).toBe(0);
        expect(getActiveUserMemories(db)).toHaveLength(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });

    test("deletes its child session when provider review fails", async () => {
        const db = freshDb();
        const holderId = "holder-provider";
        const acquisition = acquire(db, holderId);
        insertUserMemoryCandidates(db, [
            { content: "User prefers concise updates", sessionId: "s1" },
        ]);
        const deleted: string[] = [];
        const prompt = mock(async () => {
            throw new Error("model unavailable");
        });
        const client = {
            session: {
                create: mock(async () => ({ id: "child-user-memories" })),
                prompt,
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    return {};
                }),
            },
        } as never;

        await expect(
            reviewUserMemories({
                db,
                client,
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId,
                leaseKey: LEASE,
                deadline: Date.now() + 60_000,
                leaseAcquisition: acquisition,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow("model unavailable");

        expect(
            prompt.mock.calls.some(([input]) => {
                const body = (input as { body?: { agent?: string } }).body;
                return body?.agent === DREAMER_REVIEWER_AGENT;
            }),
        ).toBe(true);
        expect(deleted).toEqual(["child-user-memories"]);
        expect(count(db, "claim_operation_receipts")).toBe(1);
        expect(count(db, "claim_operation_effects")).toBe(0);
        expect(count(db, "claim_project_generations")).toBe(0);
        expect(getActiveUserMemories(db)).toHaveLength(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });

    test("a project-A run cannot see or consume a project-B-bound candidate", async () => {
        const db = freshDb();
        const foreignContent = "Other project pins its toolchain in rust-toolchain.toml";
        bindSession(db, "sess-a", PROJECT);
        bindSession(db, "sess-b", OTHER_PROJECT);
        insertUserMemoryCandidates(db, [
            { content: "This project requires focused tests before commit", sessionId: "sess-a" },
        ]);
        insertUserMemoryCandidates(db, [{ content: foreignContent, sessionId: "sess-b" }]);
        const [ownCandidate, foreignCandidate] = getUserMemoryCandidates(db).map(
            (candidate) => candidate.id,
        );

        // Each project's review scope holds only the candidates it may act on.
        expect(
            captureUserMemoryReviewSnapshot(db, PROJECT).candidates.map(
                (candidate) => candidate.id,
            ),
        ).toEqual([ownCandidate]);
        expect(
            captureUserMemoryReviewSnapshot(db, OTHER_PROJECT).candidates.map(
                (candidate) => candidate.id,
            ),
        ).toEqual([foreignCandidate]);

        const holderA = "holder-project-a";
        const acquisitionA = acquire(db, holderA);
        const reviewA = recordingReviewClient(
            JSON.stringify({
                promote_project: [
                    {
                        content: "Run focused tests before commit.",
                        category: "PROJECT_RULES",
                        candidate_ids: [ownCandidate],
                    },
                ],
                consume_candidate_ids: [ownCandidate],
            }),
        );
        const resultA = await reviewUserMemories({
            db,
            client: reviewA.client,
            projectIdentity: PROJECT,
            parentSessionId: undefined,
            sessionDirectory: "/repo/project",
            holderId: holderA,
            leaseKey: LEASE,
            deadline: Date.now() + 60_000,
            leaseAcquisition: acquisitionA,
            promotionThreshold: 1,
        });
        releaseLease(db, holderA, LEASE);

        // The foreign candidate never reached the model, so it cannot be named
        // in consume_candidate_ids, and it survives project A's consumption.
        expect(reviewA.prompts.some((prompt) => prompt.includes(foreignContent))).toBe(false);
        expect(resultA.candidatesConsumed).toBe(1);
        expect(getUserMemoryCandidates(db).map((candidate) => candidate.id)).toEqual([
            foreignCandidate,
        ]);
        expect(readDreamerProjectClaims(db, PROJECT, "hygiene")).toHaveLength(1);

        // Project B's own review still finds its observation and promotes it.
        const holderB = "holder-project-b";
        const acquisitionB = acquire(db, holderB);
        const resultB = await reviewUserMemories({
            db,
            client: reviewClient(
                JSON.stringify({
                    promote_project: [
                        {
                            content: "Pin the toolchain in rust-toolchain.toml.",
                            category: "CONFIG_VALUES",
                            candidate_ids: [foreignCandidate],
                        },
                    ],
                    consume_candidate_ids: [foreignCandidate],
                }),
            ),
            projectIdentity: OTHER_PROJECT,
            parentSessionId: undefined,
            sessionDirectory: "/repo/other-project",
            holderId: holderB,
            leaseKey: LEASE,
            deadline: Date.now() + 60_000,
            leaseAcquisition: acquisitionB,
            promotionThreshold: 1,
        });
        releaseLease(db, holderB, LEASE);

        expect(resultB.projectPromoted).toBe(1);
        expect(readDreamerProjectClaims(db, OTHER_PROJECT, "hygiene")).toHaveLength(1);
        expect(getUserMemoryCandidates(db)).toHaveLength(0);
        db.close();
    });

    test("rejects a manifest that names a candidate outside the run's scope", async () => {
        const db = freshDb();
        const holderId = "holder-foreign-consume";
        const acquisition = acquire(db, holderId);
        bindSession(db, "sess-a", PROJECT);
        bindSession(db, "sess-b", OTHER_PROJECT);
        insertUserMemoryCandidates(db, [
            { content: "This project requires focused tests before commit", sessionId: "sess-a" },
        ]);
        insertUserMemoryCandidates(db, [
            { content: "Other project pins its toolchain", sessionId: "sess-b" },
        ]);
        const [ownCandidate, foreignCandidate] = getUserMemoryCandidates(db).map(
            (candidate) => candidate.id,
        );

        await expect(
            reviewUserMemories({
                db,
                client: reviewClient(
                    JSON.stringify({
                        consume_candidate_ids: [ownCandidate, foreignCandidate],
                    }),
                ),
                projectIdentity: PROJECT,
                parentSessionId: undefined,
                sessionDirectory: "/repo/project",
                holderId,
                leaseKey: LEASE,
                deadline: Date.now() + 60_000,
                leaseAcquisition: acquisition,
                promotionThreshold: 1,
            }),
        ).rejects.toThrow(`review consumes unknown candidate ${foreignCandidate}`);

        expect(getUserMemoryCandidates(db)).toHaveLength(2);
        expect(count(db, "claim_operation_effects")).toBe(0);
        db.close();
    });
});
