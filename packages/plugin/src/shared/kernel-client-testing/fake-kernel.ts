/**
 * An in-memory stand-in for the daemon's `kernel.*` routes, driven through
 * the `KernelTransport` surface so consumers are tested against the same
 * client they ship with. It keeps the semantics the client relies on:
 * `known_as_of` tokens, the three conflict reasons, replay by operation key,
 * and supersession chains. Anything else answers with a scripted state.
 */

import {
    type KernelMemorySnapshot,
    type KernelTransport,
    type KernelTransportCall,
    type MemoryState,
    parseReadResponse,
    type Surface,
} from "../kernel-client";

export interface FakeObject {
    object_id: string;
    object_kind: string;
    domain_id: string;
    source_kind: string;
    source_id: string;
    source_revision: number;
    created_commit_seq: number;
    invalidated_commit_seq: number | null;
    superseded_by: string | null;
    sensitivity: "normal" | "sensitive" | "secret";
    labeled: boolean;
    decision?: { decision_kind: string; payload: { summary: string; rationale: string } };
}

interface Receipt {
    commit_seq: number;
    request_digest: string;
    tokens: { object_id: string; known_as_of: number }[];
}

type Operation = Record<string, unknown> & { op: string };

export class FakeKernel {
    tip = 0;
    readonly objects = new Map<string, FakeObject>();
    /** Latest commit that changed each object; `kernel.commit` compares tokens against it. */
    readonly lastChange = new Map<string, number>();
    readonly receipts = new Map<string, Receipt>();
    /** Forces every read on a surface to answer with this state instead of rows. */
    readonly surfaceStates = new Map<Surface, MemoryState>();
    /** Forces the next commit to answer with this state. */
    nextCommitState: MemoryState | null = null;
    /** Runs after the client's read and before the commit's token check, standing in for a concurrent writer. */
    beforeCommit: (() => void) | null = null;

    private nextSeq(): number {
        this.tip += 1;
        return this.tip;
    }

    /** Seeds a live decision object as if a prior commit had written it. */
    seedDecision(input: {
        object_id: string;
        decision_kind: string;
        summary: string;
        rationale?: string;
        labeled?: boolean;
        source_revision?: number;
    }): FakeObject {
        const seq = this.nextSeq();
        const object: FakeObject = {
            object_id: input.object_id,
            object_kind: "decision",
            domain_id: "memory",
            source_kind: "assistant",
            source_id: "ctx_memory",
            source_revision: input.source_revision ?? 1,
            created_commit_seq: seq,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: "normal",
            labeled: input.labeled ?? false,
            decision: {
                decision_kind: input.decision_kind,
                payload: { summary: input.summary, rationale: input.rationale ?? "" },
            },
        };
        this.objects.set(object.object_id, object);
        this.lastChange.set(object.object_id, seq);
        return object;
    }

    /** A change outside the client's view: the object's `known_as_of` advances without a payload change. */
    touch(objectId: string): void {
        const seq = this.nextSeq();
        this.lastChange.set(objectId, seq);
    }

    /**
     * The snapshot a client would hold after reading `surface` at the tip,
     * parsed through the same wire decoder, for consumers that take the
     * snapshot as a value instead of dialing.
     */
    snapshot(surface: Surface = "auto_inject"): KernelMemorySnapshot {
        const parsed = parseReadResponse(this.readReply({ surface, gated: false }));
        return parsed.payload
            ? {
                  state: parsed.state,
                  rows: parsed.payload.rows,
                  knownAsOf: parsed.payload.known_as_of,
              }
            : { state: parsed.state, rows: [], knownAsOf: null };
    }

    liveRows(): FakeObject[] {
        return [...this.objects.values()]
            .filter((object) => object.invalidated_commit_seq === null)
            .sort((left, right) => (left.object_id < right.object_id ? -1 : 1));
    }

    private readReply(body: Record<string, unknown>): unknown {
        const surface = body.surface as Surface;
        const forced = this.surfaceStates.get(surface);
        if (forced && forced.kind !== "available") return { state: forced };
        const asOf = typeof body.as_of === "number" ? body.as_of : this.tip;
        if (asOf > this.tip) return { state: { kind: "unavailable", reason: "snapshot_diverged" } };
        const rows = [...this.objects.values()]
            .filter(
                (object) =>
                    object.created_commit_seq <= asOf &&
                    (object.invalidated_commit_seq === null ||
                        asOf < object.invalidated_commit_seq),
            )
            .sort((left, right) => (left.object_id < right.object_id ? -1 : 1))
            .map((object) => {
                const { labeled, decision, ...row } = object;
                return {
                    object: row,
                    visibility: labeled ? "labeled" : "visible",
                    labeled,
                    scope_id: "project:fake",
                    token: { object_id: object.object_id, known_as_of: asOf },
                    decision: decision ?? null,
                };
            });
        return {
            state: { kind: "available" },
            known_as_of: asOf,
            tip: this.tip,
            gated: body.gated === true,
            rows,
        };
    }

    private conflictFor(tokens: { object_id: string; known_as_of: number }[]): unknown | null {
        for (const token of tokens) {
            const object = this.objects.get(token.object_id);
            if (!object || object.invalidated_commit_seq !== null) {
                if (object?.superseded_by) {
                    return { state: { kind: "conflict", reason: "superseded" } };
                }
                return { state: { kind: "conflict", reason: "retracted" } };
            }
            if ((this.lastChange.get(token.object_id) ?? 0) > token.known_as_of) {
                return { state: { kind: "conflict", reason: "known_as_of_advanced" } };
            }
        }
        return null;
    }

    private commitReply(body: Record<string, unknown>): unknown {
        if (this.nextCommitState) {
            const state = this.nextCommitState;
            this.nextCommitState = null;
            return { state };
        }
        const intent = body.intent as { operation_key: string; request_digest: string };
        const replayed = this.receipts.get(intent.operation_key);
        if (replayed) {
            if (replayed.request_digest !== intent.request_digest) {
                return { state: { kind: "invalid", reason: "operation_key_reused" } };
            }
            return {
                state: { kind: "available" },
                receipt: { commit_seq: replayed.commit_seq, replayed: true },
                known_as_of: replayed.commit_seq,
                tokens: replayed.tokens,
            };
        }
        this.beforeCommit?.();
        const tokens = (body.tokens as { object_id: string; known_as_of: number }[]) ?? [];
        const conflict = this.conflictFor(tokens);
        if (conflict) return conflict;
        const operations = body.operations as Operation[];
        const touched = new Set<string>();
        const sourceKind = typeof body.source_kind === "string" ? body.source_kind : "assistant";
        // Every inserted object id must be new to the store; one envelope may name the same
        // survivor from several supersessions.
        for (const operation of operations) {
            if (operation.op !== "insert_decision" && operation.op !== "supersede_decision") {
                continue;
            }
            const objectId = (operation.spec as Record<string, unknown>).object_id as string;
            if (this.objects.has(objectId)) {
                return { state: { kind: "invalid", reason: "invalid_input" } };
            }
        }
        const seq = this.nextSeq();
        const insert = (spec: Record<string, unknown>): void => {
            const objectId = spec.object_id as string;
            if (!this.objects.has(objectId)) {
                const payload = spec.payload as { summary: string; rationale: string };
                this.objects.set(objectId, {
                    object_id: objectId,
                    object_kind: "decision",
                    domain_id: spec.domain_id as string,
                    source_kind: sourceKind,
                    source_id: spec.source_id as string,
                    source_revision: spec.source_revision as number,
                    created_commit_seq: seq,
                    invalidated_commit_seq: null,
                    superseded_by: null,
                    sensitivity: "normal",
                    labeled: false,
                    decision: { decision_kind: spec.decision_kind as string, payload },
                });
            }
            this.lastChange.set(objectId, seq);
            touched.add(objectId);
        };
        for (const operation of operations) {
            if (operation.op === "insert_decision") {
                insert(operation.spec as Record<string, unknown>);
            } else if (operation.op === "supersede_decision") {
                const replaced = this.objects.get(operation.replaced_object_id as string);
                if (!replaced) return { state: { kind: "invalid", reason: "invalid_input" } };
                const spec = operation.spec as Record<string, unknown>;
                insert(spec);
                replaced.invalidated_commit_seq = seq;
                replaced.superseded_by = spec.object_id as string;
                this.lastChange.set(replaced.object_id, seq);
                touched.add(replaced.object_id);
            } else if (operation.op === "retire_decision") {
                const retired = this.objects.get(operation.object_id as string);
                if (!retired) return { state: { kind: "invalid", reason: "invalid_input" } };
                retired.invalidated_commit_seq = seq;
                this.lastChange.set(retired.object_id, seq);
                touched.add(retired.object_id);
            } else {
                return { state: { kind: "invalid", reason: "invalid_input" } };
            }
        }
        const receipt: Receipt = {
            commit_seq: seq,
            request_digest: intent.request_digest,
            tokens: [...touched].sort().map((object_id) => ({ object_id, known_as_of: seq })),
        };
        this.receipts.set(intent.operation_key, receipt);
        return {
            state: { kind: "available" },
            receipt: { commit_seq: seq, replayed: false },
            known_as_of: seq,
            tokens: receipt.tokens,
        };
    }

    reply(call: KernelTransportCall): unknown {
        const body = call.body as Record<string, unknown>;
        switch (call.method) {
            case "kernel.read":
                return this.readReply(body);
            case "kernel.commit":
                return this.commitReply(body);
            default:
                return { state: { kind: "invalid", reason: "invalid_input" } };
        }
    }
}

/** A `KernelTransport` over a `FakeKernel` that records every call. */
export class FakeKernelTransport implements KernelTransport {
    readonly calls: KernelTransportCall[] = [];
    fileExists = true;
    rebinds = 0;
    /** Thrown by every call while set, standing in for a transport-level failure. */
    failWith: Error | null = null;

    constructor(readonly kernel: FakeKernel = new FakeKernel()) {}

    connectionFileExists(): boolean {
        return this.fileExists;
    }

    async call(args: KernelTransportCall): Promise<unknown> {
        this.calls.push(args);
        if (this.failWith) throw this.failWith;
        return this.kernel.reply(args);
    }

    async ensureRoute(): Promise<void> {
        this.rebinds += 1;
    }

    methods(): string[] {
        return this.calls.map((call) => call.method);
    }
}
