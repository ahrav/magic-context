import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    drainClaimEffectPrefix,
    proveClaimOperationDurable,
} from "../../hooks/magic-context/module-state-sync";
import type {
    ClaimEffectDeliveryReceipt,
    ClaimIntentAckRequest,
    ClaimIntentBinding,
    ClaimIntentStageRequest,
    ClaimIntentWireRecord,
} from "../../hooks/magic-context/module-wire";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { type ContextClaimCommit, commitModuleClaimIntent } from "./context-authority";
import { computeClaimOperationRequestDigest } from "./memory/claim-operation-contract";
import {
    ClaimOperationInputError,
    createProjectMemoryClaim,
    runClaimOperation,
} from "./memory/storage-claim-operations";
import { ensureProject } from "./memory/storage-claims";
import { createDirectTestDatabase } from "./test-database";

const databases: Database[] = [];
const tempDirs: string[] = [];
const CONSUMER = "u5-crash-module";
const PRODUCER = "u5-crash";
const PROJECT = "git:u5-crash";
const SESSION = "ses-u5-crash";
const ROOT = "/tmp/u5-crash";

const binding: ClaimIntentBinding = {
    databaseIncarnationId: "0123456789abcdef0123456789abcdef",
    formatEpoch: 1,
    authorityProject: PROJECT,
    authorityGeneration: 7,
};

type CrashCut =
    | "after-rust-stage"
    | "after-context-commit"
    | "after-mirror-group-commit"
    | "after-intent-ack"
    | "after-caller-ack";

class InjectedCrash extends Error {
    constructor(readonly cut: CrashCut) {
        super(`injected crash ${cut}`);
    }
}

interface DurableModuleState {
    intents: Map<string, ClaimIntentWireRecord>;
    receiptGroups: Map<number, ClaimEffectDeliveryReceipt>;
    effectCommits: Map<number, number>;
    deliveryOrder: number[];
    callerResponses: string[];
}

interface AttemptOptions {
    cut?: CrashCut;
    failContext?: boolean;
    /** `failContextWithInputError` rejects inside `commitContext` as a caller-input defect. */
    failContextWithInputError?: boolean;
    request?: Record<string, unknown>;
    binding?: ClaimIntentBinding;
}

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openContext(path: string): Database {
    const db = existsSync(path) ? new Database(path) : createDirectTestDatabase({ path }).db;
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    databases.push(db);
    return db;
}

function closeContext(db: Database): void {
    closeQuietly(db);
    const index = databases.indexOf(db);
    if (index >= 0) databases.splice(index, 1);
}

function newModuleState(): DurableModuleState {
    return {
        intents: new Map(),
        receiptGroups: new Map(),
        effectCommits: new Map(),
        deliveryOrder: [],
        callerResponses: [],
    };
}

function reloadModuleState(state: DurableModuleState): DurableModuleState {
    return {
        intents: new Map([...state.intents].map(([key, value]) => [key, structuredClone(value)])),
        receiptGroups: new Map(
            [...state.receiptGroups].map(([key, value]) => [key, structuredClone(value)]),
        ),
        effectCommits: new Map(state.effectCommits),
        deliveryOrder: [...state.deliveryOrder],
        callerResponses: [...state.callerResponses],
    };
}

function commandKey(command: { producer: string; operationKey: string }): string {
    return `${command.producer}\u0000${command.operationKey}`;
}

function sameBinding(left: ClaimIntentBinding, right: ClaimIntentBinding): boolean {
    return (
        left.databaseIncarnationId === right.databaseIncarnationId &&
        left.formatEpoch === right.formatEpoch &&
        left.authorityProject === right.authorityProject &&
        left.authorityGeneration === right.authorityGeneration
    );
}

function moduleClient(state: DurableModuleState, cut: CrashCut | undefined, targetKey: string) {
    let cutFired = false;
    const crash = (site: CrashCut): void => {
        if (!cutFired && cut === site) {
            cutFired = true;
            throw new InjectedCrash(site);
        }
    };

    return {
        async claimIntentInspect(args: {
            request: { command: { producer: string; operationKey: string } | null };
        }) {
            const intent = args.request.command
                ? state.intents.get(commandKey(args.request.command))
                : undefined;
            return { protocolVersion: 1, intents: intent ? [{ ...intent }] : [] };
        },
        async claimIntentStage(args: { request: ClaimIntentStageRequest }) {
            const key = commandKey(args.request.command);
            const requestDigest = computeClaimOperationRequestDigest(args.request.request);
            const prior = state.intents.get(key);
            if (prior) {
                if (prior.requestDigest !== requestDigest) {
                    throw new Error(
                        "claim intent identity conflicts with a different request digest",
                    );
                }
                if (!sameBinding(prior.binding, args.request.binding)) {
                    throw new Error("claim intent binding mismatch");
                }
                return { protocolVersion: 1, replayed: true, intent: { ...prior } };
            }
            const intent: ClaimIntentWireRecord = {
                binding: { ...args.request.binding },
                command: { ...args.request.command },
                requestDigest,
                state: "staged",
                resultJson: null,
            };
            state.intents.set(key, intent);
            crash("after-rust-stage");
            return { protocolVersion: 1, replayed: false, intent: { ...intent } };
        },
        async claimIntentAck(args: { request: ClaimIntentAckRequest }) {
            const key = commandKey(args.request.command);
            const prior = state.intents.get(key);
            if (!prior) throw new Error("claim intent is missing");
            if (
                prior.requestDigest !== args.request.requestDigest ||
                !sameBinding(prior.binding, args.request.binding)
            ) {
                throw new Error("claim intent acknowledgement binding mismatch");
            }
            const nextState =
                args.request.kind === "context-committed"
                    ? "context-committed"
                    : args.request.kind === "terminal-rejected"
                      ? "terminal-rejected"
                      : "acknowledged";
            if (
                (args.request.kind === "context-committed" &&
                    prior.state !== "staged" &&
                    prior.state !== "context-committed" &&
                    prior.state !== "acknowledged") ||
                (args.request.kind === "acknowledged" &&
                    prior.state !== "context-committed" &&
                    prior.state !== "acknowledged") ||
                (args.request.kind === "terminal-rejected" &&
                    prior.state !== "staged" &&
                    prior.state !== "terminal-rejected")
            ) {
                throw new Error(`invalid claim intent transition from ${prior.state}`);
            }
            const intent: ClaimIntentWireRecord = {
                ...prior,
                state: nextState,
                resultJson: args.request.resultJson ?? prior.resultJson,
            };
            const replayed = prior.state === intent.state && prior.resultJson === intent.resultJson;
            state.intents.set(key, intent);
            if (args.request.kind === "acknowledged") crash("after-intent-ack");
            return { protocolVersion: 1, replayed, intent: { ...intent } };
        },
        async applyReceipt(
            receipt: ClaimEffectDeliveryReceipt,
        ): Promise<{ ackedEffectId: number }> {
            const prior = state.receiptGroups.get(receipt.receiptId);
            if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) {
                throw new Error(`receipt ${receipt.receiptId} changed during replay`);
            }
            if (!prior) {
                if (receipt.effects.some((effect) => state.effectCommits.has(effect.id))) {
                    throw new Error("effect crossed receipt groups");
                }
                state.receiptGroups.set(receipt.receiptId, structuredClone(receipt));
                state.deliveryOrder.push(receipt.receiptId);
                for (const effect of receipt.effects) state.effectCommits.set(effect.id, 1);
            }
            if (receipt.operationKey === targetKey) crash("after-mirror-group-commit");
            return { ackedEffectId: receipt.effects.at(-1)?.id ?? 0 };
        },
    };
}

function seedClaim(
    db: Database,
    operationKey: string,
): { projectId: number; claimId: number; revisionId: number } {
    const projectId = ensureProject(db, PROJECT);
    createProjectMemoryClaim(
        db,
        { producer: "u5-crash-seed", operationKey: `seed-${operationKey}` },
        {
            projectId,
            content: `seed ${operationKey}`,
            category: "CONSTRAINTS",
            provenance: {
                sourceLocator: `test:${operationKey}`,
                sourceContent: `seed ${operationKey}`,
                extractor: "u5-crash-test",
                extractorVersion: "1",
                extractorRunId: operationKey,
                independenceKey: operationKey,
            },
            actor: "test:u5",
            requestScope: PROJECT,
        },
    );
    return db
        .prepare(
            `SELECT claims.id AS claimId, heads.revision_id AS revisionId, claims.project_id AS projectId
               FROM claims
               JOIN claim_memory_current_heads AS heads ON heads.claim_id = claims.id
              WHERE claims.project_id = ? ORDER BY claims.id DESC LIMIT 1`,
        )
        .get(projectId) as { projectId: number; claimId: number; revisionId: number };
}

function commitContext(
    db: Database,
    operationKey: string,
    request: Record<string, unknown>,
    target: { projectId: number; claimId: number; revisionId: number },
    applications: { count: number },
): ContextClaimCommit {
    const operation = runClaimOperation(
        db,
        {
            producer: PRODUCER,
            operationKey,
            requestDigest: computeClaimOperationRequestDigest(request),
        },
        () => {
            applications.count += 1;
            return {
                kind: "effects",
                payload: { response: operationKey },
                effects: ["first", "second"].map((suffix) => ({
                    effectKey: `${operationKey}:${suffix}`,
                    projectId: target.projectId,
                    claimId: target.claimId,
                    revisionId: target.revisionId,
                    changeKind: "upsert" as const,
                })),
            };
        },
    );
    return {
        producer: PRODUCER,
        operationKey,
        requestDigest: computeClaimOperationRequestDigest(request),
        resultJson: operation.resultJson,
        response: `response:${operationKey}`,
    };
}

async function runAttempt(args: {
    db: Database;
    state: DurableModuleState;
    operationKey: string;
    target: { projectId: number; claimId: number; revisionId: number };
    applications: { count: number };
    options?: AttemptOptions;
}): Promise<string> {
    const options = args.options ?? {};
    const request = options.request ?? { operation: "revise", value: args.operationKey };
    const client = moduleClient(args.state, options.cut, args.operationKey);
    let contextCutFired = false;
    const response = await commitModuleClaimIntent({
        client,
        sessionId: SESSION,
        projectRoot: ROOT,
        request: {
            protocolVersion: 1,
            requestEncodingVersion: 1,
            binding: options.binding ?? binding,
            command: { producer: PRODUCER, operationKey: args.operationKey },
            request,
        },
        commitContext: () => {
            if (options.failContextWithInputError) {
                throw new ClaimOperationInputError(
                    "create requires non-empty content and category",
                );
            }
            if (options.failContext) throw new Error("injected context commit failure");
            const commit = commitContext(
                args.db,
                args.operationKey,
                request,
                args.target,
                args.applications,
            );
            if (!contextCutFired && options.cut === "after-context-commit") {
                contextCutFired = true;
                throw new InjectedCrash(options.cut);
            }
            return commit;
        },
        settleContext: async (commit) => {
            const proof = proveClaimOperationDurable({
                db: args.db,
                producer: commit.producer,
                operationKey: commit.operationKey,
                resultJson: commit.resultJson,
            });
            await drainClaimEffectPrefix({
                db: args.db,
                consumer: CONSUMER,
                throughReceiptId: proof.receiptId,
                deliver: (receipt) => client.applyReceipt(receipt),
            });
        },
    });
    if (options.cut === "after-caller-ack") {
        args.state.callerResponses.push(response);
        throw new InjectedCrash(options.cut);
    }
    return response;
}

function receiptCount(db: Database, operationKey: string): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS count FROM claim_operation_receipts WHERE producer = ? AND operation_key = ?",
            )
            .get(PRODUCER, operationKey) as { count: number }
    ).count;
}

function fixture(operationKey: string): {
    path: string;
    db: Database;
    state: DurableModuleState;
    target: ReturnType<typeof seedClaim>;
    applications: { count: number };
} {
    const dir = mkdtempSync(join(tmpdir(), "u5-claim-crash-"));
    tempDirs.push(dir);
    const path = join(dir, "context.db");
    const db = openContext(path);
    return {
        path,
        db,
        state: newModuleState(),
        target: seedClaim(db, operationKey),
        applications: { count: 0 },
    };
}

describe("U5 claim intent crash recovery", () => {
    test("every durable cut restarts to one canonical result without duplicate effects", async () => {
        const cuts: CrashCut[] = [
            "after-rust-stage",
            "after-context-commit",
            "after-mirror-group-commit",
            "after-intent-ack",
            "after-caller-ack",
        ];
        for (const cut of cuts) {
            const operationKey = `cut-${cut}`;
            const f = fixture(operationKey);
            await expect(
                runAttempt({
                    db: f.db,
                    state: f.state,
                    operationKey,
                    target: f.target,
                    applications: f.applications,
                    options: { cut },
                }),
            ).rejects.toEqual(expect.objectContaining({ cut }));

            closeContext(f.db);
            const restarted = openContext(f.path);
            const restartedState = reloadModuleState(f.state);
            const response = await runAttempt({
                db: restarted,
                state: restartedState,
                operationKey,
                target: f.target,
                applications: f.applications,
            });
            const proof = proveClaimOperationDurable({
                db: restarted,
                producer: PRODUCER,
                operationKey,
            });
            const intent = restartedState.intents.get(
                commandKey({ producer: PRODUCER, operationKey }),
            );

            expect(response).toBe(`response:${operationKey}`);
            expect(intent).toEqual(
                expect.objectContaining({ state: "acknowledged", resultJson: proof.resultJson }),
            );
            expect(receiptCount(restarted, operationKey)).toBe(1);
            expect(f.applications.count).toBe(1);
            expect(proof.effects).toHaveLength(2);
            expect(restartedState.deliveryOrder.at(-1)).toBe(proof.receiptId);
            expect([...restartedState.effectCommits.values()].every((count) => count === 1)).toBe(
                true,
            );
            if (cut === "after-caller-ack") {
                expect(restartedState.callerResponses).toEqual([response]);
            }
        }
    });

    test("context failure stays staged and invisible, rejects changed digest, then resumes", async () => {
        const operationKey = "context-failure";
        const f = fixture(operationKey);
        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: { failContext: true },
            }),
        ).rejects.toThrow("injected context commit failure");
        expect(f.state.intents.get(commandKey({ producer: PRODUCER, operationKey }))?.state).toBe(
            "staged",
        );
        expect(receiptCount(f.db, operationKey)).toBe(0);
        expect(f.state.receiptGroups.size).toBe(0);
        expect(f.state.effectCommits.size).toBe(0);

        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: { request: { operation: "revise", value: "changed" } },
            }),
        ).rejects.toThrow("different request digest");
        expect(receiptCount(f.db, operationKey)).toBe(0);

        closeContext(f.db);
        const restarted = openContext(f.path);
        await expect(
            runAttempt({
                db: restarted,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
            }),
        ).resolves.toBe(`response:${operationKey}`);
        expect(f.applications.count).toBe(1);
        expect(receiptCount(restarted, operationKey)).toBe(1);
    });

    test("incarnation mismatch terminally quarantines a pending intent without context effects", async () => {
        const operationKey = "incarnation-mismatch";
        const f = fixture(operationKey);
        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: { failContext: true },
            }),
        ).rejects.toThrow("injected context commit failure");

        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: {
                    binding: {
                        ...binding,
                        databaseIncarnationId: "abcdef0123456789abcdef0123456789",
                    },
                },
            }),
        ).rejects.toThrow("obsolete context incarnation or authority");

        expect(f.state.intents.get(commandKey({ producer: PRODUCER, operationKey }))?.state).toBe(
            "terminal-rejected",
        );
        expect(receiptCount(f.db, operationKey)).toBe(0);
        expect(f.state.effectCommits.size).toBe(0);
    });
    test("binding change resolves a context-committed intent instead of stranding it", async () => {
        const operationKey = "binding-change-after-context-commit";
        const f = fixture(operationKey);
        // A settlement crash leaves the context write and context-committed acknowledgement durable but prevents the final acknowledgement.
        // A settlement crash leaves the context write and context-committed acknowledgement durable but prevents the final acknowledgement.
        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: { cut: "after-mirror-group-commit" },
            }),
        ).rejects.toThrow("injected crash after-mirror-group-commit");
        expect(f.state.intents.get(commandKey({ producer: PRODUCER, operationKey }))?.state).toBe(
            "context-committed",
        );

        // Durable context effects require acknowledgement under the staged binding after the authority binding changes.
        // Durable context effects require acknowledgement under the staged binding after the authority binding changes.
        // Durable context effects require acknowledgement under the staged binding after the authority binding changes.
        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: {
                    binding: { ...binding, authorityGeneration: binding.authorityGeneration + 1 },
                },
            }),
        ).rejects.toThrow("obsolete context incarnation or authority");

        // An unresolved intent blocks claim-store rebuild and mirror reset.
        // An unresolved intent blocks claim-store rebuild and mirror reset.
        expect(f.state.intents.get(commandKey({ producer: PRODUCER, operationKey }))?.state).toBe(
            "acknowledged",
        );
        expect(receiptCount(f.db, operationKey)).toBe(1);
    });

    test("a caller-input rejection terminalizes the staged intent so retries cannot wedge", async () => {
        const operationKey = "context-input-rejection";
        const f = fixture(operationKey);
        await expect(
            runAttempt({
                db: f.db,
                state: f.state,
                operationKey,
                target: f.target,
                applications: f.applications,
                options: { failContextWithInputError: true },
            }),
        ).rejects.toThrow("create requires non-empty content and category");

        // A stable tool-call ID repeats the rejection, leaving a staged row unresolved and blocking claim-store rebuilds.
        // A stable tool-call ID repeats the rejection, leaving a staged row unresolved and blocking claim-store rebuilds.
        expect(f.state.intents.get(commandKey({ producer: PRODUCER, operationKey }))?.state).toBe(
            "terminal-rejected",
        );
        expect(receiptCount(f.db, operationKey)).toBe(0);
        expect(f.state.effectCommits.size).toBe(0);
    });
});
