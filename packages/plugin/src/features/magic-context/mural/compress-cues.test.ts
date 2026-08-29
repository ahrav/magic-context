/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { acquireLease } from "../dreamer/lease";
import { createAntiMemory } from "../memory/storage-anti-memory";
import {
    type ProjectMemoryClaimSnapshot,
    readProjectMemoryCurrentState,
} from "../memory/storage-claim-current-state";
import {
    computeProjectMemoryMutationToken,
    reviseProjectMemoryClaim,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { createClaimReaderTestDatabase, seedProjectMemoryClaim } from "../test-claim-database";
import {
    applyCues,
    CHUNK_TIMEOUT_FLOOR_MS,
    type CompressCuesArgs,
    computeChunkSliceMs,
    runCompressCues,
} from "./compress-cues";
import { validateCue } from "./cue-validation";
import { claimNeedsCue, getClaimMuralCueStates } from "./storage-mural-cues";

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function poolIdsFromPrompt(prompt: string): string[] {
    return [...prompt.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1] ?? "");
}

function successfulCueClient(onPrompt?: () => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = poolIdsFromPrompt(prompt);
                manifest = `<cues>${ids.map((id) => `<cue id="${id}">anchor fact</cue>`).join("")}</cues>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

/** A client whose prompt always fails with the exact timeout error that
 *  promptWithTimeout throws, so the chunk is classified as a timeout-class
 *  failure (the kind that trips the consecutive-timeout circuit breaker). */
function timeoutCueClient(onPrompt?: () => void) {
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async () => {
                onPrompt?.();
                throw new Error("prompt timed out after 99997ms");
            },
            messages: async () => ({ data: [] }),
            delete: async () => ({}),
        },
    };
}

/** A client that repeats one candidate cue for every claim in the pool. */
function repeatingCueClient(cue: string) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                const ids = poolIdsFromPrompt(prompt);
                manifest = `<cues>${ids.map((id) => `<cue id="${id}">${cue}</cue>`).join("")}</cues>`;
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

/** A client whose prompt succeeds but returns output with no <cues> manifest,
 *  so output validation fails. This is a VALIDATION-class failure (bad manifest),
 *  which must NOT trip the timeout breaker — every chunk is still attempted. */
function invalidOutputCueClient(onPrompt?: () => void) {
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async () => {
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages("garbage without a cues root") }),
            delete: async () => ({}),
        },
    };
}

function providerFailureCueClient(onPrompt?: () => void) {
    return {
        session: {
            create: async () => ({ data: { id: "cue-child" } }),
            prompt: async () => {
                onPrompt?.();
                return {};
            },
            messages: async () => ({
                data: [
                    {
                        info: {
                            role: "assistant",
                            time: { created: Date.now() },
                            finish: "stop",
                            error: null,
                            tokens: { output: 8, reasoning: 0 },
                        },
                        parts: [{ type: "text", text: "All Antigravity endpoints failed" }],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    };
}

function cueArgs(db: Database, projectIdentity: string): CompressCuesArgs {
    const holderId = "compress-holder";
    const leaseKey = `compress-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: undefined,
        sessionDirectory: process.cwd(),
        holderId,
        leaseKey,
        // Comfortably above CHUNK_TIMEOUT_FLOOR_MS so the run loop actually
        // attempts chunks instead of stopping at the floor guard. Tests that
        // exercise the floor/deadline stops mutate this per case.
        deadline: Date.now() + 600_000,
    };
}

function claimSnapshot(db: Database, publicClaimId: string): ProjectMemoryClaimSnapshot {
    // CANDIDATE claims are eligible on the explicit_search surface.
    const result = readProjectMemoryCurrentState(db, {
        publicClaimIds: [publicClaimId],
        surface: "explicit_search",
    });
    if (result.status !== "ok" || result.items.length !== 1) {
        throw new Error(`expected one snapshot for ${publicClaimId}`);
    }
    const item = result.items[0];
    if (!item) throw new Error("unreachable");
    return item;
}

function cueStateOf(db: Database, publicClaimId: string) {
    return getClaimMuralCueStates(db, [publicClaimId]).get(publicClaimId);
}

function seedClaims(db: Database, projectIdentity: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
        seedProjectMemoryClaim(db, {
            projectIdentity,
            content: `Cue fact ${index}.`,
            category: "ARCHITECTURE",
        });
    }
}

describe("runCompressCues disposition", () => {
    test("never sends a verified rejected approach to cue compression", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-anti-memory";
            seedClaims(db, projectIdentity, 1);
            const anti = createAntiMemory(
                db,
                { producer: "test", operationKey: "cues-anti" },
                {
                    projectId: ensureProject(db, projectIdentity),
                    payload: {
                        trigger: "cache work",
                        rejectedStrategy: "use Redis",
                        rejectionReason: "operational burden",
                    },
                    provenance: {
                        sourceLocator: "transcript://cues-anti",
                        sourceContent: "user rejected Redis",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "cues-anti",
                        independenceKey: "cues-anti",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "host:user-corroborated",
                    nowMs: 1,
                },
            );
            const antiId = (anti.result.payload as { claim: { publicClaimId: string } }).claim
                .publicClaimId;
            const args = cueArgs(db, projectIdentity);
            args.client = successfulCueClient() as never;

            const result = await runCompressCues(args);
            expect(result.compressed).toBe(1);
            expect(cueStateOf(db, antiId)).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("banks a completed chunk and reports the deadline remainder", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-deadline";
            seedClaims(db, projectIdentity, 41);
            const args = cueArgs(db, projectIdentity);
            args.client = successfulCueClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await runCompressCues(args);

            expect(result.compressed).toBe(40);
            expect(result.remaining).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-complete";
            seedClaims(db, projectIdentity, 1);
            const args = cueArgs(db, projectIdentity);
            args.client = successfulCueClient() as never;

            const result = await runCompressCues(args);
            expect(result.compressed).toBe(1);
            expect(result.remaining).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed chunk failure as incomplete", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-failure";
            seedClaims(db, projectIdentity, 1);
            const args = cueArgs(db, projectIdentity);
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await runCompressCues(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("stops banking progress when the remaining budget falls below the chunk floor", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-floor-stop";
            seedClaims(db, projectIdentity, 41);
            const args = cueArgs(db, projectIdentity);
            // First chunk succeeds and banks its 40 cues; the callback then drops
            // the deadline to a value that is still > 0 but below the chunk floor,
            // so the loop must stop at the floor guard (not the <= 0 guard) before
            // attempting chunk 2.
            args.client = successfulCueClient(() => {
                args.deadline = Date.now() + 60_000; // > 0, < CHUNK_TIMEOUT_FLOOR_MS
            }) as never;

            const result = await runCompressCues(args);

            expect(result.compressed).toBe(40);
            expect(result.remaining).toBe(1);
            expect(result.chunks).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("two consecutive chunk timeouts trip the breaker; the third chunk is never attempted", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-breaker";
            // 120 claims = exactly 3 chunks of 40.
            seedClaims(db, projectIdentity, 120);
            const args = cueArgs(db, projectIdentity);
            let promptCalls = 0;
            args.client = timeoutCueClient(() => {
                promptCalls += 1;
            }) as never;

            const result = await runCompressCues(args);

            // The breaker trips after the 2nd consecutive timeout, so chunk 3 is
            // never attempted: exactly 2 prompt calls, not 3.
            expect(promptCalls).toBe(2);
            expect(result.chunks).toBe(2);
            expect(result.compressed).toBe(0);
            expect(result.remaining).toBe(120);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("provider-outage completion aborts remaining chunks after the model ladder", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-provider-outage";
            seedClaims(db, projectIdentity, 120);
            const args = cueArgs(db, projectIdentity);
            let promptCalls = 0;
            args.client = providerFailureCueClient(() => {
                promptCalls += 1;
            }) as never;
            args.fallbackModels = ["provider/fallback-one", "provider/fallback-two"];

            let thrown: unknown;
            try {
                await runCompressCues(args);
            } catch (error) {
                thrown = error;
            }

            expect(String(thrown)).toContain("provider-outage completion");
            expect(promptCalls).toBe(3);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM claim_mural_cues WHERE cue IS NOT NULL")
                    .get(),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("validation failures do not trip the timeout breaker (every chunk still attempted)", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-validation";
            seedClaims(db, projectIdentity, 120);
            const args = cueArgs(db, projectIdentity);
            let promptCalls = 0;
            args.client = invalidOutputCueClient(() => {
                promptCalls += 1;
            }) as never;

            const result = await runCompressCues(args);

            // Bad-manifest (validation) failures keep the per-chunk retry-next-run
            // behavior: all 3 chunks are attempted, the run is not stopped early.
            expect(promptCalls).toBe(3);
            expect(result.chunks).toBe(3);
            expect(result.compressed).toBe(0);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("cue validation precision", () => {
    test("rejects only the claim's own id and accepts legitimate references", () => {
        expect(validateCue("leaked mcm_own123", 50, "mcm_own123")?.reason).toBe("leaked-id");
        expect(validateCue("PR #21729 → issue #31638", 50, "mcm_own123")).toBeNull();
        expect(validateCue("foreign mcm_other99", 50, "mcm_own123")).toBeNull();
    });

    test("writes live-shaped PR and issue cues instead of retrying them", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-live-shape";
            const pr = seedProjectMemoryClaim(db, {
                projectIdentity,
                content: "PR #21729 tracks the parser fix.",
                category: "KNOWN_ISSUES",
            });
            const issue = seedProjectMemoryClaim(db, {
                projectIdentity,
                content: "Issue #31638 tracks the retry loop.",
                category: "KNOWN_ISSUES",
            });
            const chunk = [
                { item: claimSnapshot(db, pr.publicClaimId) },
                { item: claimSnapshot(db, issue.publicClaimId) },
            ];
            const manifest = `<cues><cue id="${pr.publicClaimId}">PR #21729 → parser fix</cue><cue id="${issue.publicClaimId}">issue #31638 → retry loop</cue></cues>`;

            expect(applyCues(cueArgs(db, projectIdentity), chunk, manifest)).toEqual({
                compressed: 2,
                skipped: 0,
            });
            expect(cueStateOf(db, pr.publicClaimId)?.cue).toBe("PR #21729 → parser fix");
            expect(cueStateOf(db, issue.publicClaimId)?.cue).toBe("issue #31638 → retry loop");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("cue rejection latch", () => {
    test("falls back after three same-content rejections and completes the run", async () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-latch";
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity,
                content: "The repeater must remain stable for issue #31638.",
                category: "KNOWN_ISSUES",
                importance: 90,
            });
            const overBudget = "x ".repeat(49);
            const client = repeatingCueClient(overBudget);

            const first = cueArgs(db, projectIdentity);
            first.client = client as never;
            const firstResult = await runCompressCues(first);
            expect(firstResult).toMatchObject({ compressed: 0, skipped: 1, remaining: 1 });

            const second = cueArgs(db, projectIdentity);
            second.client = client as never;
            const secondResult = await runCompressCues(second);
            expect(secondResult).toMatchObject({ compressed: 0, skipped: 1, remaining: 1 });

            const third = cueArgs(db, projectIdentity);
            third.client = client as never;
            const thirdResult = await runCompressCues(third);
            expect(thirdResult).toMatchObject({
                compressed: 1,
                skipped: 0,
                remaining: 0,
                complete: true,
            });

            const state = cueStateOf(db, claim.publicClaimId);
            expect(state?.cue).toBeTruthy();
            expect(state?.cue).not.toContain(claim.publicClaimId);
            expect([...(state?.cue ?? "")].length).toBeLessThanOrEqual(90);
            expect(validateCue(state?.cue ?? "", 90, claim.publicClaimId)).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("a revision resets the rejection latch for the next attempt", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:cues-latch-reset";
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity,
                content: "Original issue #31638 content.",
                category: "KNOWN_ISSUES",
            });
            const chunk = [{ item: claimSnapshot(db, claim.publicClaimId) }];
            const invalid = `<cues><cue id="${claim.publicClaimId}">broken (</cue></cues>`;
            applyCues(cueArgs(db, projectIdentity), chunk, invalid);
            expect(cueStateOf(db, claim.publicClaimId)?.rejectionCount).toBe(1);

            const revised = reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "revise-latch" },
                {
                    token: computeProjectMemoryMutationToken(db, claim.publicClaimId),
                    content: "Edited issue #31638 content.",
                    provenance: {
                        sourceLocator: "transcript://revise",
                        sourceContent: "revised source",
                        extractor: "historian",
                        extractorVersion: "1",
                        extractorRunId: "run-revise",
                        independenceKey: "ik-revise",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "user:test",
                },
            );
            expect(revised.outcome).toBe("applied");

            // The stored latch row is keyed to the old revision locator, so
            // the revised claim reads as needing a fresh cue and a new
            // rejection restarts at 1.
            const current = claimSnapshot(db, claim.publicClaimId);
            const state = cueStateOf(db, claim.publicClaimId);
            expect(claimNeedsCue(state, current.revisionLocator)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("computeChunkSliceMs (chunk time floor)", () => {
    test("applies the floor when the even split would be below it", () => {
        // 12 chunks of a 1_200s budget → even split 100s < 240s floor → floor wins.
        // This is the live failure shape: a 470-memory pool split into 12 chunks.
        expect(computeChunkSliceMs(1_200_000, 12)).toBe(CHUNK_TIMEOUT_FLOOR_MS);
    });

    test("uses the even split when it already exceeds the floor", () => {
        expect(computeChunkSliceMs(1_200_000, 2)).toBe(600_000);
    });

    test("never exceeds the remaining budget", () => {
        expect(computeChunkSliceMs(300_000, 1)).toBe(300_000);
    });
});

describe("applyCues (per-cue validation, skip-not-reject, locator-race)", () => {
    test("writes valid cues and skips invalid ones without rejecting the chunk", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const good = seedProjectMemoryClaim(db, {
                projectIdentity: "git:p",
                content: "good fact",
                category: "ARCHITECTURE",
            });
            const bad = seedProjectMemoryClaim(db, {
                projectIdentity: "git:p",
                content: "bad fact",
                category: "CONSTRAINTS",
            });
            const chunk = [
                { item: claimSnapshot(db, good.publicClaimId) },
                { item: claimSnapshot(db, bad.publicClaimId) },
            ];
            // The bad cue is an unbalanced-parens violation → skipped, not fatal.
            const manifest = `<cues><cue id="${good.publicClaimId}">good anchor</cue><cue id="${bad.publicClaimId}">oops (unbalanced</cue></cues>`;
            const result = applyCues(cueArgs(db, "git:p"), chunk, manifest);
            expect(result.compressed).toBe(1);
            expect(result.skipped).toBe(1);
            // good got its cue; bad stayed NULL (retried next run).
            expect(cueStateOf(db, good.publicClaimId)?.cue).toBe("good anchor");
            expect(cueStateOf(db, bad.publicClaimId)?.cue ?? null).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("stores the SELECTION-time locator so a revision mid-run yields a stale (excluded) cue", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity: "git:p",
                content: "original content",
                category: "ARCHITECTURE",
            });
            // Candidate captured at selection time (locator of the ORIGINAL
            // revision).
            const chunk = [{ item: claimSnapshot(db, claim.publicClaimId) }];

            // The claim is revised AFTER selection but BEFORE the cue is applied.
            const revised = reviseProjectMemoryClaim(
                db,
                { producer: "test", operationKey: "revise-mid-run" },
                {
                    token: computeProjectMemoryMutationToken(db, claim.publicClaimId),
                    content: "edited content",
                    provenance: {
                        sourceLocator: "transcript://revise",
                        sourceContent: "revised source",
                        extractor: "historian",
                        extractorVersion: "1",
                        extractorRunId: "run-mid",
                        independenceKey: "ik-mid",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "user:test",
                },
            );
            expect(revised.outcome).toBe("applied");

            const manifest = `<cues><cue id="${claim.publicClaimId}">anchor from original</cue></cues>`;
            applyCues(cueArgs(db, "git:p"), chunk, manifest);

            // The stored locator is the ORIGINAL revision's, which no longer
            // matches the current revision — so the cue is stale and
            // claimNeedsCue re-selects the claim next run.
            const current = claimSnapshot(db, claim.publicClaimId);
            const state = cueStateOf(db, claim.publicClaimId);
            expect(state?.revisionLocator).toBe(claim.revisionLocator);
            expect(state?.revisionLocator).not.toBe(current.revisionLocator);
            expect(claimNeedsCue(state, current.revisionLocator)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test.each([
        ["missing", (_id: string) => `<cues></cues>`, /missing id/],
        [
            "duplicate",
            (id: string) => `<cues><cue id="${id}">one</cue><cue id="${id}">two</cue></cues>`,
            /duplicate id/,
        ],
        [
            "foreign",
            (id: string) =>
                `<cues><cue id="${id}">ok</cue><cue id="mcm_stray999">stray</cue></cues>`,
            /unknown id/,
        ],
    ])("rejects %s manifest membership before writing", (_kind, manifestFor, error) => {
        const db = createClaimReaderTestDatabase();
        try {
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity: "git:p",
                content: "in chunk",
                category: "NAMING",
            });
            const chunk = [{ item: claimSnapshot(db, claim.publicClaimId) }];

            expect(() =>
                applyCues(cueArgs(db, "git:p"), chunk, manifestFor(claim.publicClaimId)),
            ).toThrow(error);
            expect(cueStateOf(db, claim.publicClaimId)?.cue ?? null).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
