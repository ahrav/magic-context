/**
 * Thin client over the daemon's `kernel.*` routes. Every method resolves to a
 * `MemoryState` plus the route's typed payload and never throws into the tool;
 * the caller owns the abort signal and the deadline.
 */

import { createHash } from "node:crypto";
import { Deadline, isConsumerReconnectTransient, isMcHostCallError } from "../mc-host-client";
import { isRecord } from "../record-type-guard";
import { stableStringify } from "../stable-json";
import { cancelled, disabled, invalid, type MemoryState, unavailable } from "./state";
import { TokenCache } from "./token";
import {
    type CommitPayload,
    type EgressPayload,
    type EligibilityPayload,
    type IngestFinishPayload,
    type MutationToken,
    type Parsed,
    parseCommitResponse,
    parseEgressResponse,
    parseEligibilityResponse,
    parseIngestBeginResponse,
    parseIngestFinishResponse,
    parseKernelResponse,
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
    connectionFileExists(): boolean;
    call(args: KernelTransportCall): Promise<unknown>;
    /** Rebinds the session route after the daemon reports `route_unbound`. */
    ensureRoute(args: { sessionId: string; projectRoot: string }): Promise<void>;
}

export type Surface = "auto_inject" | "auto_search" | "explicit_search";
export type Destination = "local" | "remote";
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

export interface ObservationSpecInput {
    observation_id: string;
    object_id: string;
    domain_id: string;
    proposition_id?: string;
    anchor_id?: string;
    evidence_id?: string;
    observation_kind: string;
    payload: { summary: string; classification: string; detail?: unknown };
    observed_at: number;
    dependencies?: {
        dependency_object_id: string;
        dependency_kind: string;
        dependency_payload?: string;
    }[];
    source_id: string;
    source_revision: number;
    sensitivity?: Sensitivity;
}

export type CommitOperation =
    | { op: "insert_decision"; spec: DecisionSpecInput }
    | { op: "supersede_decision"; replaced_object_id: string; spec: DecisionSpecInput }
    | { op: "retire_decision"; object_id: string }
    | { op: "insert_observation"; spec: ObservationSpecInput };

export interface CallOptions {
    signal?: AbortSignal;
    deadlineMs?: number;
}

export interface ReadArgs extends CallOptions {
    surface: Surface;
    asOf?: number | null;
    gated?: boolean;
}

export interface IntentArgs {
    actor: string;
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
     * read; when given (even empty), no cache lookup happens, which is how a
     * restore supersedes a retired object no live token can describe.
     */
    tokens?: MutationToken[];
    sourceKind?: SourceKind;
    assertedSourceClass?: string;
    assertedTaintClass?: string;
}

export type MutationArgs = Omit<CommitArgs, "operations" | "tokens">;

export interface EligibilityArgs extends CallOptions {
    destination: Destination;
    candidates: { object_id: string; source_revision: number; artifact_digest?: string }[];
}

export interface EgressArgs extends CallOptions {
    artifactDigest: string;
    evidenceId?: string;
    destination: Destination;
    assertedSensitivity: Sensitivity;
    owningObjectId: string;
}

export interface ArtifactRequest {
    evidence_id: string;
    object_id: string;
    object_kind: string;
    domain_id: string;
    source_kind: string;
    source_id: string;
    source_revision: number;
    media_type: string;
    retention_class: string;
    retain_until?: number;
    asserted_sensitivity: Sensitivity;
    provider_egress: "remote_allowed" | "local_only";
    provenance?: { repository_id: string; revision: string };
}

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
}

/** Resolves the client bound to one session and filesystem project root. */
export type KernelClientResolver = (args: {
    sessionId: string;
    projectRoot: string;
}) => KernelClient;

export function kernelMemorySnapshotFrom(result: ReadResult): KernelMemorySnapshot {
    return isAvailable(result)
        ? { state: result.state, rows: result.rows, knownAsOf: result.known_as_of }
        : { state: result.state, rows: [], knownAsOf: null };
}
export type CommitResult = KernelResult<CommitPayload>;
export type EligibilityResult = KernelResult<EligibilityPayload>;
export type EgressResult = KernelResult<EgressPayload>;
export type IngestResult = KernelResult<IngestFinishPayload>;

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
 * Decoded bytes per upload page. Declared at `begin`, before the daemon
 * reports its own cap, so it sits well under the daemon's 16 MiB page maximum
 * and the reply's `page_bytes_max` is checked against it.
 */
export const INGEST_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * Fields of the operation key are joined with the ASCII unit separator, which
 * no path, producer, actor, cause, or hex digest contains, so distinct inputs
 * cannot collide by concatenation.
 */
export const OPERATION_KEY_SEPARATOR = "\u001f";

export function sha256Hex(input: string | Uint8Array): string {
    return createHash("sha256").update(input).digest("hex");
}

export function deriveRequestDigest(operations: readonly CommitOperation[]): string {
    return sha256Hex(stableStringify(operations));
}

export function deriveOperationKey(parts: {
    projectRoot: string;
    producer: string;
    actor: string;
    cause: string;
    requestDigest: string;
}): string {
    return sha256Hex(
        [parts.projectRoot, parts.producer, parts.actor, parts.cause, parts.requestDigest].join(
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
            if (options.deadline.isExpired())
                return { ok: false, state: nonAvailable(cancelled()) };
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
                if (options.signal?.aborted || options.deadline.isExpired()) {
                    return { ok: false, state: nonAvailable(cancelled()) };
                }
                if (isMcHostCallError(error)) {
                    if (error.kind === "not_sent") return absent();
                    if (error.kind === "outcome_unknown") {
                        if (options.reissuable && !reissued) {
                            reissued = true;
                            continue;
                        }
                        return absent();
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
            }),
            { signal: args.signal, deadline, reissuable: false },
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
            cause: args.cause,
            requestDigest,
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

    private async commitOnce(args: CommitArgs, deadline: Deadline): Promise<CommitResult> {
        let { tokens, missing } = this.collectTokens(args);
        if (missing.length > 0) {
            const refreshed = await this.readAt(
                { surface: "explicit_search", gated: false, signal: args.signal },
                null,
                deadline,
            );
            if (refreshed.state.kind !== "available") return { state: refreshed.state };
            ({ tokens } = this.collectTokens(args));
        }
        const result = await this.call(
            "kernel.commit",
            this.commitBody(args, tokens),
            { signal: args.signal, deadline, reissuable: true },
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

    /**
     * A retired object is restored by superseding it with a live replacement.
     * The envelope carries no token: the daemon rejects any token for an
     * invalidated object as `conflict(retracted)`, so the restore's freshness
     * claim is the retirement itself.
     */
    restore(objectId: string, spec: DecisionSpecInput, args: MutationArgs): Promise<CommitResult> {
        return this.commit({
            ...args,
            operations: [{ op: "supersede_decision", replaced_object_id: objectId, spec }],
            tokens: [],
        });
    }

    async eligibilityBatch(args: EligibilityArgs): Promise<EligibilityResult> {
        return await this.call(
            "kernel.eligibility.batch",
            this.wireBody("kernel.eligibility.batch", {
                destination: args.destination,
                candidates: args.candidates,
            }),
            { signal: args.signal, deadline: this.deadline(args), reissuable: false },
            parseEligibilityResponse,
        );
    }

    async egressDecide(args: EgressArgs): Promise<EgressResult> {
        return await this.call(
            "kernel.egress.decide",
            this.wireBody("kernel.egress.decide", {
                artifact_digest: args.artifactDigest,
                ...(args.evidenceId === undefined ? {} : { evidence_id: args.evidenceId }),
                destination: args.destination,
                asserted_sensitivity: args.assertedSensitivity,
                owning_object_id: args.owningObjectId,
            }),
            { signal: args.signal, deadline: this.deadline(args), reissuable: false },
            parseEgressResponse,
        );
    }

    /**
     * Pages `payload` at `INGEST_PAGE_BYTES`. `begin` and `finish` are not
     * reissued after `outcome_unknown`: a second `begin` collides with the
     * staged upload and a second `finish` finds it consumed. A page resent with
     * identical bytes is accepted, so pages are.
     */
    async ingestArtifact(
        payload: Uint8Array,
        request: ArtifactRequest,
        args: IntentArgs & CallOptions,
    ): Promise<IngestResult> {
        if (payload.byteLength === 0) return { state: nonAvailable(invalid("invalid_input")) };
        const deadline = this.deadline(args);
        const producer = args.producer ?? this.producer;
        const payloadDigest = sha256Hex(payload);
        const requestDigest = args.requestDigest ?? payloadDigest;
        const operationKey = deriveOperationKey({
            projectRoot: this.projectRoot,
            producer,
            actor: args.actor,
            cause: args.cause,
            requestDigest,
        });
        const uploadId = operationKey;
        const pageCount = Math.ceil(payload.byteLength / INGEST_PAGE_BYTES);
        const begun = await this.call(
            "kernel.artifact.ingest.begin",
            this.wireBody("kernel.artifact.ingest.begin", {
                upload_id: uploadId,
                total_bytes: payload.byteLength,
                page_count: pageCount,
                payload_digest: payloadDigest,
                request,
                intent: {
                    producer,
                    operation_key: operationKey,
                    request_digest: requestDigest,
                    actor: args.actor,
                    cause: args.cause,
                },
            }),
            { signal: args.signal, deadline, reissuable: false },
            parseIngestBeginResponse,
        );
        if (!isAvailable(begun)) return { state: begun.state };
        if (begun.page_bytes_max < INGEST_PAGE_BYTES) {
            return { state: nonAvailable(invalid("page_too_large")) };
        }
        for (let index = 0; index < pageCount; index += 1) {
            const page = payload.subarray(
                index * INGEST_PAGE_BYTES,
                (index + 1) * INGEST_PAGE_BYTES,
            );
            const staged = await this.call(
                "kernel.artifact.ingest.page",
                this.wireBody("kernel.artifact.ingest.page", {
                    upload_id: uploadId,
                    index,
                    bytes_base64: Buffer.from(page).toString("base64"),
                    page_digest: sha256Hex(page),
                }),
                { signal: args.signal, deadline, reissuable: true },
                (raw) => {
                    const parsed = parseKernelResponse(raw);
                    return { state: parsed.state, payload: parsed.payload };
                },
            );
            if (staged.state.kind !== "available") return { state: staged.state };
        }
        return await this.call(
            "kernel.artifact.ingest.finish",
            this.wireBody("kernel.artifact.ingest.finish", { upload_id: uploadId }),
            { signal: args.signal, deadline, reissuable: false },
            parseIngestFinishResponse,
        );
    }
}
