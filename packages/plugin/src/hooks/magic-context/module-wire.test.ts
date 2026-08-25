/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256HexUtf8 } from "../../features/magic-context/memory/claim-operation-contract";

import {
    buildClaimMirrorReceiptWireBody,
    buildClaimMirrorSnapshotWireBody,
    buildPagedModuleTransformPayloads,
    CLAIM_MIRROR_PROTOCOL_VERSION,
    CLAIM_MIRROR_VERSION,
    decodeClaimMirrorReceiptResponse,
    decodeClaimMirrorSnapshotResponse,
    type ClaimMirrorReceiptRequest,
    type ClaimMirrorSnapshotRequest,
    encodeOpenCodeMessagesToCk,
    MODULE_PAGE_MAX_BYTES,
    resolveOrdinalsForModule,
} from "./module-wire";
import { setRawMessageProvider } from "./read-session-chunk";
import type { MessageLike } from "./transform-operations";

describe("encodeOpenCodeMessagesToCk", () => {
    it("marks a collapsed synthetic todo pair as synthetic CK ingress", () => {
        const [encoded] = encodeOpenCodeMessagesToCk([
            {
                info: { id: "msg_synthetic_todo", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "todowrite",
                        callID: "mc_synthetic_todo_deadbeefdeadbeef",
                        syntheticTodoMarker: true,
                        state: {
                            status: "completed",
                            input: { todos: [] },
                            output: "[]",
                        },
                    },
                ],
            },
        ]);

        expect(encoded.ck.meta).toMatchObject({
            harness_id: "msg_synthetic_todo",
            synthetic: true,
        });
    });

    it("matches the module golden generated from raw OpenCode reasoning parts", () => {
        const golden = JSON.parse(
            readFileSync(
                join(
                    import.meta.dir,
                    "../../../../../crates/mc-module/testdata/merged-reasoning-adapter-golden.json",
                ),
                "utf8",
            ),
        ) as {
            generator_version: number;
            cases: Array<{
                name: string;
                raw_messages: unknown[];
                encoded_input: unknown[];
            }>;
        };

        expect(golden.generator_version).toBe(1);
        expect(golden.cases.map((fixture) => fixture.name)).toEqual([
            "reasoning",
            "thinking",
            "redacted_thinking",
            "reasoning_cache_control",
        ]);
        for (const fixture of golden.cases) {
            expect(encodeOpenCodeMessagesToCk(fixture.raw_messages)).toEqual(fixture.encoded_input);
        }
    });
});

describe("resolveOrdinalsForModule provisional tails", () => {
    async function resolveTail(count: number) {
        const sessionId = `module-wire-provisional-${count}`;
        const persistedTail: Array<{
            id: string;
            timeCreated: number;
            contributesOrdinal: boolean;
            hasValidInfo: boolean;
        }> = [];
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => persistedTail,
            readMessageOrdinalPage: (after, limit) =>
                persistedTail
                    .filter(
                        (row) =>
                            !after ||
                            row.timeCreated > after.timeCreated ||
                            (row.timeCreated === after.timeCreated && row.id > after.id),
                    )
                    .slice(0, limit),
            getStoredMessageCount: () => 500 + persistedTail.length,
        });
        const messages = Array.from({ length: count }, (_, index) => ({
            info: {
                id: `m-${501 + index}`,
                role: "user",
                sessionID: sessionId,
            },
            parts: [{ type: "text", text: `unpersisted ${index + 1}` }],
        })) as MessageLike[];
        const memo = new Map<string, number>([["m-500", 500]]);
        try {
            const first = await resolveOrdinalsForModule({
                sessionId,
                messages,
                generation: 1,
                memoGeneration: 1,
                memo,
                memoAnchor: { timeCreated: 500, id: "m-500" },
                memoStoredCount: 500,
                memoCanonicalCount: 500,
                provisionalBase: 500,
            });
            expect(first.ok).toBe(true);
            if (!first.ok) throw new Error(first.reason);
            return { first, messages, memo, persistedTail, unregister, sessionId };
        } catch (error) {
            unregister();
            throw error;
        }
    }

    it("continues wholly fresh post-descent arrays from the durable provisional base", async () => {
        const sessionId = "module-wire-wholly-fresh-descent";
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => [],
            readMessageOrdinalPage: () => [],
            getStoredMessageCount: () => 0,
        });
        const messages = [
            {
                info: { id: "summary", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continuation summary" }],
            },
            {
                info: { id: "tail", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "continued answer" }],
            },
        ] as MessageLike[];
        try {
            const resolved = await resolveOrdinalsForModule({
                sessionId,
                messages,
                generation: 1,
                memoGeneration: 1,
                memo: new Map(),
                memoAnchor: null,
                memoStoredCount: 0,
                memoCanonicalCount: 0,
                provisionalBase: 97,
            });
            expect(resolved.ok).toBe(true);
            if (!resolved.ok) throw new Error(resolved.reason);
            expect(
                encodeOpenCodeMessagesToCk(resolved.annotatedInput as MessageLike[]).map(
                    (message) => message.ck.meta.ordinal,
                ),
            ).toEqual([98, 99]);
        } finally {
            unregister();
        }
    });

    it("assigns one unpersisted append the next absolute ordinal", async () => {
        const result = await resolveTail(1);
        try {
            expect(result.first.annotatedInput).toEqual([
                expect.objectContaining({ absolute_ordinal: 501 }),
            ]);
            expect(
                encodeOpenCodeMessagesToCk(result.first.annotatedInput as MessageLike[])[0]?.ck
                    .meta,
            ).toEqual(expect.objectContaining({ ordinal: 501 }));
        } finally {
            result.unregister();
        }
    });

    it("assigns two unpersisted appends distinct absolute ordinals", async () => {
        const result = await resolveTail(2);
        try {
            expect(
                (result.first.annotatedInput as Array<{ absolute_ordinal: number }>).map(
                    (message) => message.absolute_ordinal,
                ),
            ).toEqual([501, 502]);
            expect(
                encodeOpenCodeMessagesToCk(result.first.annotatedInput as MessageLike[]).map(
                    (message) => message.ck.meta.ordinal,
                ),
            ).toEqual([501, 502]);
        } finally {
            result.unregister();
        }
    });

    it("reconciles provisional ordinals when the appended rows persist", async () => {
        const result = await resolveTail(2);
        try {
            result.persistedTail.push(
                { id: "m-501", timeCreated: 501, contributesOrdinal: true, hasValidInfo: true },
                { id: "m-502", timeCreated: 502, contributesOrdinal: true, hasValidInfo: true },
            );
            const reconciled = await resolveOrdinalsForModule({
                sessionId: result.sessionId,
                messages: result.messages,
                generation: 1,
                memoGeneration: result.first.memoGeneration,
                memo: result.memo,
                memoAnchor: result.first.memoAnchor,
                memoStoredCount: result.first.memoStoredCount,
                memoCanonicalCount: result.first.memoCanonicalCount,
            });
            expect(reconciled.ok).toBe(true);
            if (reconciled.ok) {
                expect(reconciled.memoCanonicalCount).toBe(502);
                expect(result.memo.get("m-501")).toBe(501);
                expect(result.memo.get("m-502")).toBe(502);
            }
        } finally {
            result.unregister();
        }
    });
});

describe("U10 claim mirror wire", () => {
    const publicClaimId = "mcm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const content = "Use repository formatter before commit.";
    const contentDigest = sha256HexUtf8(content);
    const revisionLocator = `${publicClaimId}/r3/${contentDigest}`;
    const vector = {
        vectorVersion: 1,
        databaseIncarnationId: "0123456789abcdef0123456789abcdef",
        workspaceEpoch: "workspace-epoch-1",
        projectGenerations: { "41": 7 },
        policyGenerations: { "41": 7 },
    } as const;
    const claim = {
        publicClaimId,
        projectId: 41,
        revisionLocator,
        content,
        contentDigest,
        attributes: {
            category: "workflow",
            normalizedHash: "a".repeat(64),
            importance: 80,
            memoryScope: "project",
            sharing: "private",
            expiresAt: null,
        },
        lifecycle: "active" as const,
        applicability: { assertions: [] },
        policy: {
            autoEligible: true,
            effectiveMaturity: "VERIFIED",
            explicitEligible: true,
            hardHidden: false,
            policyVersion: 1,
        },
        provenanceLabel: "User-confirmed project guidance",
        projectGeneration: 7,
        policyGeneration: 7,
    };
    const snapshotRequest: ClaimMirrorSnapshotRequest = {
        protocolVersion: CLAIM_MIRROR_PROTOCOL_VERSION,
        snapshot: {
            mirrorVersion: CLAIM_MIRROR_VERSION,
            vector,
            projectCheckpoints: { "41": 29 },
            claims: [claim],
        },
    };
    const receiptRequest: ClaimMirrorReceiptRequest = {
        protocolVersion: CLAIM_MIRROR_PROTOCOL_VERSION,
        receipt: {
            mirrorVersion: CLAIM_MIRROR_VERSION,
            receiptId: 9,
            expectedEffectCount: 1,
            vector,
            effects: [
                {
                    effectId: 30,
                    previousProjectEffectId: 29,
                    effectKey: "claim:30",
                    projectId: 41,
                    generation: 7,
                    changeKind: "verification",
                    publicClaimId,
                    revisionLocator,
                    claim,
                },
            ],
        },
    };

    it("scenario 1 carries exact committed claim vocabulary and generation vector", () => {
        expect(buildClaimMirrorSnapshotWireBody(snapshotRequest)).toEqual({
            name: "claim.mirror.replace",
            arguments: snapshotRequest,
        });
        expect(
            decodeClaimMirrorSnapshotResponse(
                {
                    protocolVersion: 1,
                    mirrorVersion: 1,
                    databaseIncarnationId: vector.databaseIncarnationId,
                    projectCheckpoints: { "41": 29 },
                },
                snapshotRequest,
            ),
        ).toEqual({
            protocolVersion: 1,
            mirrorVersion: 1,
            databaseIncarnationId: vector.databaseIncarnationId,
            projectCheckpoints: { "41": 29 },
        });
    });

    it("scenario 2 carries one complete ordered receipt group", () => {
        expect(buildClaimMirrorReceiptWireBody(receiptRequest)).toEqual({
            name: "claim.mirror.apply",
            arguments: receiptRequest,
        });
        expect(
            decodeClaimMirrorReceiptResponse(
                {
                    protocolVersion: 1,
                    mirrorVersion: 1,
                    receiptId: 9,
                    replayed: false,
                    appliedEffectCount: 1,
                    ackedEffectId: 30,
                },
                receiptRequest,
            ),
        ).toEqual({
            protocolVersion: 1,
            mirrorVersion: 1,
            receiptId: 9,
            replayed: false,
            appliedEffectCount: 1,
            ackedEffectId: 30,
        });
    });

    it("scenario 3 rejects future versions, partial groups, reorder, and bad acknowledgements", () => {
        expect(() =>
            buildClaimMirrorSnapshotWireBody({
                ...snapshotRequest,
                snapshot: { ...snapshotRequest.snapshot, mirrorVersion: 2 },
            }),
        ).toThrow("mirrorVersion is unsupported");
        expect(() =>
            buildClaimMirrorReceiptWireBody({
                ...receiptRequest,
                receipt: { ...receiptRequest.receipt, expectedEffectCount: 2 },
            }),
        ).toThrow("effect group is incomplete");
        expect(() =>
            buildClaimMirrorReceiptWireBody({
                ...receiptRequest,
                receipt: {
                    ...receiptRequest.receipt,
                    expectedEffectCount: 2,
                    effects: [
                        receiptRequest.receipt.effects[0]!,
                        { ...receiptRequest.receipt.effects[0]!, effectId: 32 },
                    ],
                },
            }),
        ).toThrow("effects must have contiguous IDs");
        expect(() =>
            decodeClaimMirrorReceiptResponse(
                {
                    protocolVersion: 1,
                    mirrorVersion: 2,
                    receiptId: 9,
                    replayed: false,
                    appliedEffectCount: 1,
                    ackedEffectId: 30,
                },
                receiptRequest,
            ),
        ).toThrow("mirrorVersion is unsupported");
        expect(() =>
            decodeClaimMirrorReceiptResponse(
                {
                    protocolVersion: 1,
                    mirrorVersion: 1,
                    receiptId: 9,
                    replayed: false,
                    appliedEffectCount: 1,
                    ackedEffectId: 31,
                },
                receiptRequest,
            ),
        ).toThrow("acknowledgement mismatch");
    });
});

describe("buildPagedModuleTransformPayloads byte reuse", () => {
    it("returns the first stringify length on the unpaged path", () => {
        const body = {
            method: "transform",
            session_id: "ses-unpaged",
            input: [{ mid: "m1", ordinal: 1, ck: { text: "hi" } }],
        };
        const pages = buildPagedModuleTransformPayloads(body);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.page).toBe(body);
        expect(pages[0]?.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    });

    it("returns paging sizes that match a later stringify of each page", () => {
        const body = {
            method: "transform",
            session_id: "ses-paged",
            input: Array.from({ length: 80 }, (_, index) => ({
                mid: `m${index}`,
                ordinal: index + 1,
                ck: { text: "x".repeat(8_000) },
            })),
        };
        expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(MODULE_PAGE_MAX_BYTES);
        const pages = buildPagedModuleTransformPayloads(body);
        expect(pages.length).toBeGreaterThan(1);
        for (const { page, bytes } of pages) {
            expect(bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
        }
    });
});
