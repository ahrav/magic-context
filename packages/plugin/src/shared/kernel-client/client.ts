/**
 * Thin client over the daemon's `kernel.*` routes. Every method resolves to a
 * `MemoryState` plus the route's typed payload and never throws into the tool;
 * the caller owns the abort signal and the deadline.
 */

import { createHash } from "node:crypto";
import { Deadline, isConsumerReconnectTransient, isMcHostCallError } from "../mc-host-client";
import { isRecord } from "../record-type-guard";
import { stableStringify } from "../stable-json";
import { cancelled, conflict, disabled, invalid, type MemoryState, unavailable } from "./state";
import { TokenCache } from "./token";
import {
    type CommitPayload,
    MAX_READ_OBJECT_IDS,
    type MutationToken,
    type Parsed,
    parseCommitResponse,
    parseReadResponse,
    type ReadPayload,
    type ReadRow,
    type Sensitivity,
} from "./wire";

export interface KernelTransportCall {
    sessionId: string;
    projectRoot: string;
    method: string;
    body: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** The transport surface the client depends on; `McHostModuleTransport` is adapted onto it. */
export interface KernelTransport {
    /** False marks the daemon unreachable; a transport that starts the daemon during `call` answers true with no connection file. commentlint: allow(JUDGE) */
    connectionFileExists(): boolean;
    call(args: KernelTransportCall): Promise<unknown>;
    /** Rebinds the session route after the daemon reports `route_unbound`. */
    ensureRoute(args: { sessionId: string; projectRoot: string }): Promise<void>;
}

export type Surface = "auto_inject" | "auto_search" | "explicit_search";
export type SourceKind = "assistant" | "model" | "dreamer" | "user";

export interface DecisionSpecInput {
    decision_id: string;
    object_id: string;
    domain_id: string;
    proposition_id?: string;
    anchor_id?: string;
    evidence_id?: string;
    decision_kind: string;
    payload: { summary: string; rationale: string };
    source_id: string;
    source_revision: number;
    sensitivity?: Sensitivity;
}

export type CommitOperation =
    | { op: "insert_decision"; spec: DecisionSpecInput }
    | { op: "supersede_decision"; replaced_object_id: string; spec: DecisionSpecInput }
    | { op: "retire_decision"; object_id: string };

export interface CallOptions {
    signal?: AbortSignal;
    deadlineMs?: number;
}

export interface ReadArgs extends CallOptions {
    surface: Surface;
    asOf?: number | null;
    gated?: boolean;
    /** Scopes the read to the named objects before the daemon applies its row cap, so a targeted lookup reaches a live row a capped unfiltered snapshot drops. At most `MAX_READ_OBJECT_IDS` ids; a longer list answers `invalid_input` without a daemon round trip. commentlint: allow(JUDGE) */
    objectIds?: readonly string[];
}

export interface IntentArgs {
    actor: string;
    /** Stable identity the operation key hashes together with the project root, producer, and actor; a redelivered identity with different request bytes hits `operation_key_reused` instead of committing twice, so caller-controlled free text never rides here — it goes in `cause`. commentlint: allow(JUDGE) */
    operationId: string;
    /** Free-text audit trail carried in `intent.cause`; never key material. */
    cause: string;
    /** Defaults to the client's producer. */
    producer?: string;
    /** Derived from the canonical JSON of the operations when omitted. */
    requestDigest?: string;
}

export interface CommitArgs extends CallOptions, IntentArgs {
    operations: CommitOperation[];
    /**
     * The complete token set for the envelope. When omitted, the cache supplies
     * one token per replaced or retired object and a missing one triggers a
     * read; when given, no cache lookup happens.
     */
    tokens?: MutationToken[];
    sourceKind?: SourceKind;
    assertedSourceClass?: string;
    assertedTaintClass?: string;
}

export type MutationArgs = Omit<CommitArgs, "operations" | "tokens">;

export type AvailableState = Extract<MemoryState, { kind: "available" }>;
export type NonAvailableState = Exclude<MemoryState, { kind: "available" }>;

/** `available` carries the payload; any other state carries only itself. */
export type KernelResult<P> = ({ state: AvailableState } & P) | { state: NonAvailableState };

/** Narrows a result to its payload-bearing arm. */
export function isAvailable<P>(result: KernelResult<P>): result is { state: AvailableState } & P {
    return result.state.kind === "available";
}

export type ReadResult = KernelResult<ReadPayload>;

/**
 * A read projected to the value injectors and status surfaces carry: the
 * state, the rows (empty unless `available`), and the snapshot position the
 * rows were read at (`null` unless `available`).
 */
export interface KernelMemorySnapshot {
    state: MemoryState;
    rows: ReadRow[];
    knownAsOf: number | null;
    /** Mirrors the read's `truncated` flag: the daemon dropped rows to fit its per-read bounds, so `rows` is a capped prefix and counts derived from it are lower bounds. commentlint: allow(JUDGE) */
    truncated?: boolean;
}

/** Resolves the client bound to one session and filesystem project root. */
export type KernelClientResolver = (args: {
    sessionId: string;
    projectRoot: string;
}) => KernelClient;

export function kernelMemorySnapshotFrom(result: ReadResult): KernelMemorySnapshot {
    return isAvailable(result)
        ? {
              state: result.state,
              rows: result.rows,
              knownAsOf: result.known_as_of,
              truncated: result.truncated,
          }
        : { state: result.state, rows: [], knownAsOf: null };
}
export type CommitResult = KernelResult<CommitPayload>;

export interface KernelClientOptions {
    transport: KernelTransport;
    enabled: boolean;
    sessionId: string;
    projectRoot: string;
    /** `intent.producer` on every write; part of the `(producer, operation_key)` identity. */
    producer?: string;
    tokens?: TokenCache;
    /** Bounds a call whose caller passes no `deadlineMs`. */
    defaultDeadlineMs?: number;
}

const DEFAULT_PRODUCER = "plugin";
const DEFAULT_DEADLINE_MS = 10_000;
/**
 * Fields of the operation key are joined with the ASCII unit separator; identity fields carry only harness- or content-derived ids that never contain it, so distinct inputs cannot collide by concatenation. commentlint: allow(JUDGE)
 */
export const OPERATION_KEY_SEPARATOR = "\u001f";

export function sha256Hex(input: string | Uint8Array): string {
    return createHash("sha256").update(input).digest("hex");
}

/** Stores persist ids minted here, so the separator, field order, and 32-hex slice are frozen byte-for-byte: the same inputs always resolve to the same id. commentlint: allow(JUDGE) */
export function deriveObjectId(prefix: string, ...fields: readonly string[]): string {
    return `${prefix}_${sha256Hex(fields.join(OPERATION_KEY_SEPARATOR)).slice(0, 32)}`;
}

export function deriveRequestDigest(operations: readonly CommitOperation[]): string {
    // The JSON round-trip drops explicitly-undefined keys so a spec built by spread and a spec that omits the field hash identically; `stableStringify` then fixes key order. commentlint: allow(JUDGE)
    return sha256Hex(stableStringify(JSON.parse(JSON.stringify(operations))));
}

/** The key names only the stable operation identity — never the body, which travels in `request_digest`, and never the free-text `cause` — so a redelivered identity with different bytes hits the daemon's `operation_key_reused` rejection instead of committing as a second operation. commentlint: allow(JUDGE) */
export function deriveOperationKey(parts: {
    projectRoot: string;
    producer: string;
    actor: string;
    operationId: string;
}): string {
    return sha256Hex(
        [parts.projectRoot, parts.producer, parts.actor, parts.operationId].join(
            OPERATION_KEY_SEPARATOR,
        ),
    );
}

type Invoked = { ok: true; raw: unknown } | { ok: false; state: NonAvailableState };

interface InvokeOptions {
    signal?: AbortSignal;
    deadline: Deadline;
    /** A write whose `outcome_unknown` is reissued once with identical bytes. */
    reissuable: boolean;
    /** A mutating call whose exhausted `outcome_unknown` must stay ambiguous: reads answer `daemon_absent` because re-reading is always safe, but a sent write may have committed and a definitive-looking failure invites a retry under a fresh identity. commentlint: allow(JUDGE) */
    mutating?: boolean;
}

function errorCodeOf(error: unknown): string | undefined {
    return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isDaemonAbsent(error: unknown): boolean {
    return (
        isConsumerReconnectTransient(error) ||
        errorCodeOf(error) === "MC_HOST_CONNECTION_BACKOFF" ||
        (isRecord(error) && error.name === "ConnectionFileError")
    );
}

/**
 * Codes a daemon answers when no `kernel.*` route matches the request, so the
 * caller sees the version-skew state rather than an internal error.
 */
const UNKNOWN_METHOD_CODES: ReadonlySet<string> = new Set([
    "unrecognized_request_shape",
    "facade_envelope_not_supported",
]);

function isUnknownMethod(code: string | undefined): boolean {
    return code !== undefined && UNKNOWN_METHOD_CODES.has(code);
}

function nonAvailable(state: MemoryState): NonAvailableState {
    return state as NonAvailableState;
}

function isSnapshotDiverged(state: MemoryState): boolean {
    return state.kind === "unavailable" && state.reason === "snapshot_diverged";
}

export class KernelClient {
    private readonly transport: KernelTransport;
    private readonly enabled: boolean;
    private readonly sessionId: string;
    private readonly projectRoot: string;
    private readonly producer: string;
    private readonly defaultDeadlineMs: number;
    readonly tokens: TokenCache;

    constructor(options: KernelClientOptions) {
        this.transport = options.transport;
        this.enabled = options.enabled;
        this.sessionId = options.sessionId;
        this.projectRoot = options.projectRoot;
        this.producer = options.producer ?? DEFAULT_PRODUCER;
        this.tokens = options.tokens ?? new TokenCache();
        this.defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
    }

    private wireBody(method: string, fields: Record<string, unknown>): Record<string, unknown> {
        return {
            method,
            v: 1,
            session_id: this.sessionId,
            project_root: this.projectRoot,
            ...fields,
        };
    }

    private deadline(options: CallOptions): Deadline {
        return Deadline.start(options.deadlineMs ?? this.defaultDeadlineMs);
    }

    /** Preconditions every call shares, checked before any transport work. */
    private gate(signal: AbortSignal | undefined): NonAvailableState | null {
        if (!this.enabled) return nonAvailable(disabled());
        if (signal?.aborted) return nonAvailable(cancelled());
        if (!this.transport.connectionFileExists()) {
            return nonAvailable(unavailable("daemon_absent"));
        }
        return null;
    }

    private async invoke(
        method: string,
        body: Record<string, unknown>,
        options: InvokeOptions,
    ): Promise<Invoked> {
        const gated = this.gate(options.signal);
        if (gated) return { ok: false, state: gated };
        const absent = (): Invoked => ({
            ok: false,
            state: nonAvailable(unavailable("daemon_absent")),
        });
        let rebound = false;
        let reissued = false;
        for (;;) {
            if (options.deadline.isExpired()) {
                // After a reissued unknown outcome on a write, an expired deadline still leaves the original request possibly applied; a plain cancellation would invite a retry under a fresh identity. commentlint: allow(JUDGE)
                return {
                    ok: false,
                    state:
                        reissued && options.mutating
                            ? nonAvailable(unavailable("outcome_unknown"))
                            : nonAvailable(cancelled()),
                };
            }
            try {
                const raw = await this.transport.call({
                    sessionId: this.sessionId,
                    projectRoot: this.projectRoot,
                    method,
                    body,
                    ...(options.signal ? { signal: options.signal } : {}),
                    timeoutMs: Math.max(1, options.deadline.remainingMs()),
                });
                return { ok: true, raw };
            } catch (error) {
                // An `outcome_unknown` thrown from a write while cancellation or the deadline fires must keep its classification: the daemon may have committed, and reporting an ordinary cancellation would claim a definitively unapplied request. commentlint: allow(JUDGE)
                const unknownOutcome = isMcHostCallError(error) && error.kind === "outcome_unknown";
                if (options.signal?.aborted || options.deadline.isExpired()) {
                    return {
                        ok: false,
                        state:
                            unknownOutcome && options.mutating
                                ? nonAvailable(unavailable("outcome_unknown"))
                                : nonAvailable(cancelled()),
                    };
                }
                if (isMcHostCallError(error)) {
                    if (error.kind === "not_sent") return absent();
                    if (error.kind === "outcome_unknown") {
                        if (options.reissuable && !reissued) {
                            reissued = true;
                            continue;
                        }
                        return options.mutating
                            ? { ok: false, state: nonAvailable(unavailable("outcome_unknown")) }
                            : absent();
                    }
                    if (error.code === "route_unbound") {
                        if (rebound) return absent();
                        rebound = true;
                        try {
                            await this.transport.ensureRoute({
                                sessionId: this.sessionId,
                                projectRoot: this.projectRoot,
                            });
                        } catch {
                            return absent();
                        }
                        continue;
                    }
                    if (isUnknownMethod(error.code)) {
                        return { ok: false, state: nonAvailable(invalid("unrecognized_state")) };
                    }
                    return { ok: false, state: nonAvailable(invalid("internal")) };
                }
                if (isDaemonAbsent(error)) return absent();
                return { ok: false, state: nonAvailable(invalid("internal")) };
            }
        }
    }

    private async call<P>(
        method: string,
        body: Record<string, unknown>,
        options: InvokeOptions,
        parse: (raw: unknown) => Parsed<P>,
    ): Promise<KernelResult<P>> {
        const invoked = await this.invoke(method, body, options);
        if (!invoked.ok) return { state: invoked.state };
        const parsed = parse(invoked.raw);
        if (parsed.state.kind !== "available" || parsed.payload === null) {
            return { state: nonAvailable(parsed.state) };
        }
        return { state: parsed.state, ...parsed.payload };
    }

    private async readAt(
        args: ReadArgs,
        asOf: number | null,
        deadline: Deadline,
    ): Promise<ReadResult> {
        const result = await this.call(
            "kernel.read",
            this.wireBody("kernel.read", {
                surface: args.surface,
                as_of: asOf,
                gated: args.gated ?? false,
                ...(args.objectIds === undefined ? {} : { object_ids: [...args.objectIds] }),
            }),
            // Reads have no side effects, so an ambiguous transport outcome reissues once instead of answering daemon_absent for a transient drop. commentlint: allow(JUDGE)
            { signal: args.signal, deadline, reissuable: true },
            parseReadResponse,
        );
        if (isAvailable(result)) {
            this.tokens.remember(this.projectRoot, result.rows, result.known_as_of);
        }
        return result;
    }

    /**
     * A read at `asOf` that the daemon reports as diverged drops the project's
     * tokens and reads the tip once; a second divergence surfaces as-is.
     */
    async read(args: ReadArgs): Promise<ReadResult> {
        if (args.objectIds !== undefined && args.objectIds.length > MAX_READ_OBJECT_IDS) {
            return { state: nonAvailable(invalid("invalid_input")) };
        }
        const deadline = this.deadline(args);
        const first = await this.readAt(args, args.asOf ?? null, deadline);
        if (!isSnapshotDiverged(first.state)) return first;
        this.tokens.dropProject(this.projectRoot);
        return await this.readAt(args, null, deadline);
    }

    private commitBody(args: CommitArgs, tokens: MutationToken[]): Record<string, unknown> {
        const producer = args.producer ?? this.producer;
        const requestDigest = args.requestDigest ?? deriveRequestDigest(args.operations);
        const operationKey = deriveOperationKey({
            projectRoot: this.projectRoot,
            producer,
            actor: args.actor,
            operationId: args.operationId,
        });
        return this.wireBody("kernel.commit", {
            intent: {
                producer,
                operation_key: operationKey,
                request_digest: requestDigest,
                actor: args.actor,
                cause: args.cause,
            },
            tokens,
            operations: args.operations,
            source_kind: args.sourceKind ?? "assistant",
            ...(args.assertedSourceClass === undefined
                ? {}
                : { asserted_source_class: args.assertedSourceClass }),
            ...(args.assertedTaintClass === undefined
                ? {}
                : { asserted_taint_class: args.assertedTaintClass }),
            ...(args.deadlineMs === undefined ? {} : { deadline_ms: args.deadlineMs }),
        });
    }

    /** Tokens the commit needs: one per object an operation replaces or retires. */
    private targetIds(operations: readonly CommitOperation[]): string[] {
        const ids = new Set<string>();
        for (const operation of operations) {
            if (operation.op === "supersede_decision") ids.add(operation.replaced_object_id);
            if (operation.op === "retire_decision") ids.add(operation.object_id);
        }
        return [...ids];
    }

    private collectTokens(args: CommitArgs): { tokens: MutationToken[]; missing: string[] } {
        if (args.tokens !== undefined) return { tokens: [...args.tokens], missing: [] };
        const tokens: MutationToken[] = [];
        const missing: string[] = [];
        for (const objectId of this.targetIds(args.operations)) {
            const cached = this.tokens.get(this.projectRoot, objectId);
            if (cached) tokens.push(cached);
            else missing.push(objectId);
        }
        return { tokens, missing };
    }

    /**
     * A target still absent after the refresh read is not live in this
     * project's scope (retired, hidden, or foreign), so the envelope is never
     * sent: the daemon checks only the tokens it receives and would otherwise
     * mutate the object unfenced.
     */
    private async commitOnce(args: CommitArgs, deadline: Deadline): Promise<CommitResult> {
        let { tokens, missing } = this.collectTokens(args);
        if (missing.length > 0) {
            // The refresh only needs tokens for the missing targets, and a filtered read reaches a target beyond the daemon's row cap; a target list over the filter bound falls back to the unfiltered snapshot. commentlint: allow(JUDGE)
            const refreshed = await this.readAt(
                {
                    surface: "explicit_search",
                    gated: false,
                    signal: args.signal,
                    ...(missing.length <= MAX_READ_OBJECT_IDS ? { objectIds: missing } : {}),
                },
                null,
                deadline,
            );
            if (refreshed.state.kind !== "available") return { state: refreshed.state };
            ({ tokens, missing } = this.collectTokens(args));
            if (missing.length > 0) return { state: nonAvailable(conflict("retracted")) };
        }
        const result = await this.call(
            "kernel.commit",
            this.commitBody(args, tokens),
            { signal: args.signal, deadline, reissuable: true, mutating: true },
            parseCommitResponse,
        );
        if (isAvailable(result)) {
            this.tokens.rememberTokens(this.projectRoot, result.tokens, result.known_as_of);
        }
        return result;
    }

    /**
     * One idempotent envelope. A target without a cached token triggers one
     * ungated `explicit_search` read first; `snapshot_diverged` drops the
     * project's tokens and reruns the read-then-commit once.
     */
    async commit(args: CommitArgs): Promise<CommitResult> {
        const deadline = this.deadline(args);
        const first = await this.commitOnce(args, deadline);
        if (!isSnapshotDiverged(first.state)) return first;
        this.tokens.dropProject(this.projectRoot);
        const retried = await this.commitOnce(args, deadline);
        if (isSnapshotDiverged(retried.state)) this.tokens.dropProject(this.projectRoot);
        return retried;
    }

    create(spec: DecisionSpecInput, args: MutationArgs): Promise<CommitResult> {
        return this.commit({ ...args, operations: [{ op: "insert_decision", spec }] });
    }

    revise(objectId: string, spec: DecisionSpecInput, args: MutationArgs): Promise<CommitResult> {
        return this.commit({
            ...args,
            operations: [{ op: "supersede_decision", replaced_object_id: objectId, spec }],
        });
    }

    /** Every merged object is superseded by the one survivor inside one envelope. */
    merge(
        objectIds: readonly string[],
        survivorSpec: DecisionSpecInput,
        args: MutationArgs,
    ): Promise<CommitResult> {
        return this.commit({
            ...args,
            operations: objectIds.map((objectId) => ({
                op: "supersede_decision" as const,
                replaced_object_id: objectId,
                spec: survivorSpec,
            })),
        });
    }

    archive(objectId: string, args: MutationArgs): Promise<CommitResult> {
        return this.commit({
            ...args,
            operations: [{ op: "retire_decision", object_id: objectId }],
        });
    }
}
