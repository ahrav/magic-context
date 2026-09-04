/**
 * An in-memory stand-in for the daemon's `kernel.*` routes, driven through
 * the `KernelTransport` surface so consumers are tested against the same
 * client they ship with. It keeps the semantics the client relies on:
 * `known_as_of` tokens, the three conflict reasons, replay by operation key,
 * supersession chains, and per-surface visibility: a `labeled` row serves only
 * on `explicit_search`, `sensitive` rows hide from the automatic surfaces, and
 * `secret` rows hide everywhere. Rows carry the project root they were written
 * under and serve only to that project. Scripted surface and commit states
 * override the row-backed replies.
 */

import {
    type KernelMemorySnapshot,
    type KernelTransport,
    type KernelTransportCall,
    type MemoryState,
    parseReadResponse,
    type Surface,
    sha256Hex,
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
    /**
     * The project root the row was written under. `null` marks a seeded row
     * that serves to every project, a shape no route commit can produce.
     */
    project_root: string | null;
    decision?: { decision_kind: string; payload: { summary: string; rationale: string } };
}

interface Receipt {
    commit_seq: number;
    request_digest: string;
    tokens: { object_id: string; known_as_of: number }[];
    merged: string[];
}

type Operation = Record<string, unknown> & { op: string };

type Sensitivity = FakeObject["sensitivity"];

/** Keyed on the union so a new `Surface` member fails to typecheck here. */
const SURFACE_SET: Record<Surface, true> = {
    auto_inject: true,
    auto_search: true,
    explicit_search: true,
};
const SURFACES: readonly Surface[] = Object.keys(SURFACE_SET) as Surface[];

const SENSITIVITY_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, secret: 2 };

function restrictive(left: Sensitivity, right: Sensitivity): Sensitivity {
    return SENSITIVITY_RANK[left] >= SENSITIVITY_RANK[right] ? left : right;
}

/**
 * `project:` plus the sha256 of the root path bytes, the scope id the daemon
 * materializes per project. The daemon canonicalizes the root first; the fake
 * hashes `projectRoot` without canonicalizing.
 */
export function fakeProjectScopeId(projectRoot: string): string {
    return `project:${sha256Hex(projectRoot)}`;
}

function invalid(reason: string): unknown {
    return { state: { kind: "invalid", reason } };
}

function conflict(reason: string): unknown {
    return { state: { kind: "conflict", reason } };
}

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
    /** Every read reply carries this `truncated` flag, standing in for a daemon that dropped rows to fit its per-read bounds. commentlint: allow(JUDGE) */
    readTruncated = false;
    /** Rows served per read when set, standing in for the daemon's newest-rows cap: the `object_ids` filter applies before the cap, so a filtered read reaches a row a capped unfiltered read drops. commentlint: allow(JUDGE) */
    readRowCap: number | null = null;
    /** Rows served per filtered read when set, standing in for the daemon's serialization byte budget: the `object_ids` filter bypasses the row cap but not the budget, and the budget keeps a newest-first prefix of the filtered rows. commentlint: allow(JUDGE) */
    filteredReadRowCap: number | null = null;
    /** Runs after the client's read and before the commit's token check, standing in for a concurrent writer. */
    beforeCommit: (() => void) | null = null;

    private nextSeq(): number {
        this.tip += 1;
        return this.tip;
    }

    /**
     * Seeds a live decision object as if a prior commit had written it. Route
     * writes are `labeled`; `labeled: false` stands in for a verified object
     * only a direct store commit can produce. Without `projectRoot` the row
     * serves to every project.
     */
    seedDecision(input: {
        object_id: string;
        decision_kind: string;
        summary: string;
        rationale?: string;
        labeled?: boolean;
        sensitivity?: FakeObject["sensitivity"];
        source_revision?: number;
        domain_id?: string;
        source_kind?: string;
        source_id?: string;
        projectRoot?: string;
    }): FakeObject {
        const seq = this.nextSeq();
        const object: FakeObject = {
            object_id: input.object_id,
            object_kind: "decision",
            domain_id: input.domain_id ?? "memory",
            source_kind: input.source_kind ?? "assistant",
            source_id: input.source_id ?? "ctx_memory",
            source_revision: input.source_revision ?? 1,
            created_commit_seq: seq,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: input.sensitivity ?? "normal",
            labeled: input.labeled ?? true,
            project_root: input.projectRoot ?? null,
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
     * snapshot as a value instead of dialing. Without `projectRoot` no
     * project filter applies.
     */
    snapshot(surface: Surface = "explicit_search", projectRoot?: string): KernelMemorySnapshot {
        const parsed = parseReadResponse(
            this.readReply({ surface, gated: false }, projectRoot ?? null),
        );
        return parsed.payload
            ? {
                  state: parsed.state,
                  rows: parsed.payload.rows,
                  knownAsOf: parsed.payload.known_as_of,
                  truncated: parsed.payload.truncated,
              }
            : { state: parsed.state, rows: [], knownAsOf: null };
    }

    liveRows(): FakeObject[] {
        return [...this.objects.values()]
            .filter((object) => object.invalidated_commit_seq === null)
            .sort((left, right) => (left.object_id < right.object_id ? -1 : 1));
    }

    private static servesOn(object: FakeObject, surface: Surface): boolean {
        if (object.sensitivity === "secret") return false;
        if (surface === "explicit_search") return true;
        return !object.labeled && object.sensitivity !== "sensitive";
    }

    /** Whether a row is in the calling project's scope; a seeded row without a root, or a call without one, passes. */
    private static inProject(object: FakeObject, projectRoot: string | null): boolean {
        return (
            projectRoot === null ||
            object.project_root === null ||
            object.project_root === projectRoot
        );
    }

    private readReply(body: Record<string, unknown>, projectRoot: string | null): unknown {
        const surface = body.surface;
        if (!(SURFACES as readonly unknown[]).includes(surface)) return invalid("invalid_input");
        const forced = this.surfaceStates.get(surface as Surface);
        if (forced && forced.kind !== "available") return { state: forced };
        const asOf = typeof body.as_of === "number" ? body.as_of : this.tip;
        if (asOf > this.tip) return { state: { kind: "unavailable", reason: "snapshot_diverged" } };
        const objectIds = Array.isArray(body.object_ids)
            ? new Set(body.object_ids.filter((id): id is string => typeof id === "string"))
            : null;
        let visible = [...this.objects.values()].filter(
            (object) =>
                object.created_commit_seq <= asOf &&
                (object.invalidated_commit_seq === null || asOf < object.invalidated_commit_seq) &&
                FakeKernel.inProject(object, projectRoot) &&
                FakeKernel.servesOn(object, surface as Surface),
        );
        if (objectIds !== null) {
            visible = visible.filter((object) => objectIds.has(object.object_id));
        }
        // The daemon scopes rows to the id filter before its newest-rows cap, so the cap applies after the filter here too; the filtered cap stands in for the byte budget, which binds even when the id filter bypasses the row cap. commentlint: allow(JUDGE)
        let truncated = this.readTruncated;
        const caps = [this.readRowCap, objectIds === null ? null : this.filteredReadRowCap].filter(
            (cap): cap is number => cap !== null,
        );
        const cap = caps.length > 0 ? Math.min(...caps) : null;
        if (cap !== null && visible.length > cap) {
            visible = [...visible]
                .sort((left, right) => right.created_commit_seq - left.created_commit_seq)
                .slice(0, cap);
            truncated = true;
        }
        const rows = visible
            .sort((left, right) => (left.object_id < right.object_id ? -1 : 1))
            .map((object) => {
                const { labeled, project_root, decision, ...row } = object;
                return {
                    object: row,
                    visibility: labeled ? "labeled" : "visible",
                    labeled,
                    scope_id: fakeProjectScopeId(project_root ?? projectRoot ?? ""),
                    token: { object_id: object.object_id, known_as_of: asOf },
                    decision: decision ?? null,
                };
            });
        return {
            state: { kind: "available" },
            known_as_of: asOf,
            tip: this.tip,
            gated: body.gated === true,
            truncated,
            rows,
        };
    }

    /**
     * The daemon's token check: an object the store never held or another
     * project's object is `not_found`, so foreign ids are not enumerable; a
     * token from a snapshot past the tip is refused before the object is
     * consulted; an invalidated object names the disposition that invalidated
     * it; a live object that changed after the token's `known_as_of` is
     * `known_as_of_advanced`.
     */
    private conflictFor(
        tokens: { object_id: string; known_as_of: number }[],
        projectRoot: string | null,
    ): unknown | null {
        for (const token of tokens) {
            const object = this.objects.get(token.object_id);
            if (!object || !FakeKernel.inProject(object, projectRoot)) return invalid("not_found");
            if (token.known_as_of > this.tip) {
                return { state: { kind: "unavailable", reason: "snapshot_diverged" } };
            }
            if (object.invalidated_commit_seq !== null) {
                return conflict(object.superseded_by ? "superseded" : "retracted");
            }
            if ((this.lastChange.get(token.object_id) ?? 0) > token.known_as_of) {
                return conflict("known_as_of_advanced");
            }
        }
        return null;
    }

    private commitReply(body: Record<string, unknown>, projectRoot: string | null): unknown {
        if (this.nextCommitState) {
            const state = this.nextCommitState;
            this.nextCommitState = null;
            return { state };
        }
        const intent = body.intent as { operation_key: string; request_digest: string };
        const replayed = this.receipts.get(intent.operation_key);
        if (replayed) {
            if (replayed.request_digest !== intent.request_digest) {
                return invalid("operation_key_reused");
            }
            return {
                state: { kind: "available" },
                receipt: { commit_seq: replayed.commit_seq, replayed: true },
                known_as_of: replayed.commit_seq,
                tokens: replayed.tokens,
                merged: replayed.merged,
            };
        }
        this.beforeCommit?.();
        const tokens = (body.tokens as { object_id: string; known_as_of: number }[]) ?? [];
        const tokenConflict = this.conflictFor(tokens, projectRoot);
        if (tokenConflict) return tokenConflict;
        const operations = body.operations as Operation[];
        const sourceKind = typeof body.source_kind === "string" ? body.source_kind : "assistant";
        // One envelope is atomic: rows change on a staged overlay in envelope order, and a refusal at any operation leaves the store and the tip untouched. commentlint: allow(JUDGE)
        const seq = this.tip + 1;
        const staged = new Map<string, FakeObject>();
        const touched = new Set<string>();
        const merged = new Set<string>();
        const view = (objectId: string): FakeObject | undefined =>
            staged.get(objectId) ?? this.objects.get(objectId);
        const stage = (objectId: string): FakeObject => {
            let row = staged.get(objectId);
            if (!row) {
                row = { ...(this.objects.get(objectId) as FakeObject) };
                staged.set(objectId, row);
            }
            return row;
        };
        // A commit target is looked up among this project's live objects only, so a missing, foreign, or invalidated target is `not_found` alike. commentlint: allow(JUDGE)
        const liveTarget = (objectId: string): FakeObject | null => {
            const target = view(objectId);
            if (
                !target ||
                !FakeKernel.inProject(target, projectRoot) ||
                target.invalidated_commit_seq !== null
            ) {
                return null;
            }
            return target;
        };
        const insert = (spec: Record<string, unknown>, sensitivity: Sensitivity): void => {
            const objectId = spec.object_id as string;
            staged.set(objectId, {
                object_id: objectId,
                object_kind: "decision",
                domain_id: spec.domain_id as string,
                source_kind: sourceKind,
                source_id: spec.source_id as string,
                source_revision: spec.source_revision as number,
                created_commit_seq: seq,
                invalidated_commit_seq: null,
                superseded_by: null,
                sensitivity,
                labeled: true,
                project_root: projectRoot,
                decision: {
                    decision_kind: spec.decision_kind as string,
                    payload: spec.payload as { summary: string; rationale: string },
                },
            });
            touched.add(objectId);
        };
        const invalidate = (target: FakeObject, supersededBy: string | null): void => {
            const row = stage(target.object_id);
            row.invalidated_commit_seq = seq;
            row.superseded_by = supersededBy;
            touched.add(row.object_id);
        };
        for (const operation of operations) {
            if (operation.op === "insert_decision") {
                const spec = operation.spec as Record<string, unknown>;
                // The registry's primary key refuses any held id, live or retired, this project's or another's. commentlint: allow(JUDGE)
                if (view(spec.object_id as string)) return invalid("already_exists");
                insert(spec, (spec.sensitivity as Sensitivity | undefined) ?? "normal");
            } else if (operation.op === "supersede_decision") {
                const replaced = liveTarget(operation.replaced_object_id as string);
                if (!replaced) return invalid("not_found");
                const spec = operation.spec as Record<string, unknown>;
                const replacementId = spec.object_id as string;
                // A replacement id another project holds is `not_found` whether live or retired, so its state is not revealed. A live in-project replacement is a fold survivor: the spec is discarded, the survivor keeps its stored label and revision, and the predecessor is re-pointed at it. A retired in-project one is a duplicate insert. commentlint: allow(JUDGE)
                const replacement = view(replacementId);
                if (replacement && !FakeKernel.inProject(replacement, projectRoot)) {
                    return invalid("not_found");
                }
                const survivor =
                    replacement && replacement.invalidated_commit_seq === null ? replacement : null;
                if (
                    survivor &&
                    restrictive(survivor.sensitivity, replaced.sensitivity) !== survivor.sensitivity
                ) {
                    return invalid("admission_policy");
                }
                const successor = survivor ?? {
                    domain_id: spec.domain_id as string,
                    source_kind: sourceKind,
                    source_id: spec.source_id as string,
                    source_revision: spec.source_revision as number,
                };
                if (successor.source_revision <= replaced.source_revision) {
                    return invalid("revision_not_advanced");
                }
                if (
                    successor.domain_id !== replaced.domain_id ||
                    successor.source_kind !== replaced.source_kind ||
                    successor.source_id !== replaced.source_id
                ) {
                    return invalid("invalid_input");
                }
                if (replacement && !survivor) return invalid("already_exists");
                if (survivor) {
                    merged.add(survivor.object_id);
                    touched.add(survivor.object_id);
                } else {
                    // A non-fold successor may raise its predecessor's label but not lower it.
                    insert(
                        spec,
                        restrictive(
                            (spec.sensitivity as Sensitivity | undefined) ?? "normal",
                            replaced.sensitivity,
                        ),
                    );
                }
                invalidate(replaced, replacementId);
            } else if (operation.op === "retire_decision") {
                const retired = liveTarget(operation.object_id as string);
                if (!retired) return invalid("not_found");
                invalidate(retired, null);
            } else {
                return invalid("invalid_input");
            }
        }
        this.tip = seq;
        for (const [objectId, row] of staged) {
            const existing = this.objects.get(objectId);
            if (existing) {
                Object.assign(existing, row);
            } else {
                this.objects.set(objectId, row);
            }
        }
        for (const objectId of touched) this.lastChange.set(objectId, seq);
        const receipt: Receipt = {
            commit_seq: seq,
            request_digest: intent.request_digest,
            tokens: [...touched].sort().map((object_id) => ({ object_id, known_as_of: seq })),
            merged: [...merged].sort(),
        };
        this.receipts.set(intent.operation_key, receipt);
        return {
            state: { kind: "available" },
            receipt: { commit_seq: seq, replayed: false },
            known_as_of: seq,
            tokens: receipt.tokens,
            merged: receipt.merged,
        };
    }

    reply(call: KernelTransportCall): unknown {
        const body = call.body as Record<string, unknown>;
        // The route is bound to the transport call's root; a body root that names another project is refused before any work. The daemon canonicalizes both roots first; the fake compares the strings. commentlint: allow(JUDGE)
        if (typeof body.project_root === "string" && body.project_root !== call.projectRoot) {
            return invalid("project_mismatch");
        }
        const projectRoot = call.projectRoot;
        switch (call.method) {
            case "kernel.read":
                return this.readReply(body, projectRoot);
            case "kernel.commit":
                return this.commitReply(body, projectRoot);
            default:
                return invalid("invalid_input");
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
