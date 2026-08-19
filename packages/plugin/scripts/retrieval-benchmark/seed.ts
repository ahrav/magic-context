/**
 * Deterministic production-shaped fixture seeder (KTD4, R46-R48; AE2).
 *
 * Seeds the reviewed corpus and optional synthetic scale documents through
 * PRODUCTION storage and indexing helpers into an isolated on-disk SQLite
 * database, verifies every approved physical locator was emitted exactly,
 * validates positive-target reachability at seed time, then snapshots the
 * completed database with `VACUUM INTO` for read-only measured workers.
 *
 * This module is runner-side: it owns the one-way import from benchmark
 * scripts into production adapters (KTD16). Production code must never
 * import it, and the pure facade (`index.ts`) must never import this module.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "../../src/features/magic-context/compartment-chunk-embedding";
import { appendCompartments } from "../../src/features/magic-context/compartment-storage";
import {
    saveCommitEmbedding,
    upsertCommits,
} from "../../src/features/magic-context/git-commits";
import { insertMemory, saveEmbedding } from "../../src/features/magic-context/memory";
import { ensureMessagesIndexed } from "../../src/features/magic-context/message-index";
import { runMigrations } from "../../src/features/magic-context/migrations";
import { SOURCE_LOCATOR_KIND } from "../../src/features/magic-context/search-result-locator";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { addNote } from "../../src/features/magic-context/storage-notes";
import { createPrimer } from "../../src/features/magic-context/storage-primers";
import type { RawMessage } from "../../src/hooks/magic-context/read-session-raw";
import { Database } from "../../src/shared/sqlite";
import { closeQuietly } from "../../src/shared/sqlite-helpers";
import { canonicalFingerprint } from "./canonical-json";
import {
    type CorpusArtifact,
    type CorpusDocument,
    type DocumentKind,
    type JudgmentsArtifact,
    type StructuredAlias,
    type SyntheticProfile,
} from "./contract";
import { iterateSyntheticDocuments } from "./synthetic";

export const SEED_MANIFEST_VERSION = "retrieval-benchmark-seed/v1";

/** Model id recorded for every deterministic fixture vector. Runners must
 *  return this id from their `embedQuery` contract so production lanes match
 *  the seeded BLOBs. */
export const BENCHMARK_EMBEDDING_MODEL_ID = "benchmark:deterministic/v1";

/** Fixed epoch for every seeded wall-clock column, so fixture bytes never
 *  depend on the time the seeder ran. */
export const SEED_EPOCH_MS = 1_755_000_000_000;

/** Bounded write batches for synthetic scale streams: one transaction per
 *  batch keeps memory flat while avoiding per-row commit overhead. */
export const SEED_BATCH_SIZE = 500;

const SEED_DB_FILE = "seed.sqlite";
const SNAPSHOT_FILE = "fixture.sqlite";

export class SeedError extends Error {
    readonly diagnostics: readonly string[];

    constructor(diagnostics: string[]) {
        super(diagnostics.join("; "));
        this.diagnostics = diagnostics;
    }
}

export function deterministicHexDigest(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

function normalizeVectorInPlace(vector: Float32Array): void {
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
    } else {
        vector[0] = 1;
    }
}

export function deterministicVector(key: string, dims: number): Float32Array {
    const vector = new Float32Array(dims);
    let block = Buffer.alloc(0);
    let blockIndex = 0;
    let offset = 0;
    for (let i = 0; i < dims; i += 1) {
        if (offset + 4 > block.length) {
            block = createHash("sha256").update(`${key}#${blockIndex}`).digest();
            blockIndex += 1;
            offset = 0;
        }
        vector[i] = block.readUInt32BE(offset) / 0xffff_ffff - 0.5;
        offset += 4;
    }
    normalizeVectorInPlace(vector);
    return vector;
}

/** Deterministic text embedding: the normalized sum of per-token hash
 *  vectors, each weighted by token length as a crude IDF proxy (long tokens
 *  are rarer and more discriminative). Cosine similarity then reflects
 *  content-token overlap between texts, so lexically related pairs score
 *  above token noise. Benchmark queries embed through this; reviewed
 *  documents blend it with their graded queries (see seedFixture), and
 *  synthetic filler keeps per-id random vectors — noise distractors are
 *  its job. */
export function deterministicTextVector(text: string, dims: number): Float32Array {
    const tokens = new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length > 0),
    );
    if (tokens.size === 0) return deterministicVector(`text:${text}`, dims);
    const vector = new Float32Array(dims);
    for (const token of tokens) {
        const tokenVector = deterministicVector(`token:${token}`, dims);
        for (let i = 0; i < dims; i += 1) vector[i] += token.length * tokenVector[i];
    }
    normalizeVectorInPlace(vector);
    return vector;
}

export interface SeedManifestEntry {
    documentId: string;
    kind: DocumentKind;
    /** Frozen physical locator string, e.g. `memory:9101`. */
    locator: string;
    projectScope: string;
    sessionScope: string | null;
    /** Physical session the row lives in, or null for project-scoped stores. */
    physicalSessionId: string | null;
    /** Message ordinal or compartment end ordinal; null for other kinds. */
    ordinal: number | null;
    /** Stored embedding BLOB bytes for this row (0 = FTS-only lane). */
    vectorBytes: number;
}

export interface SeedManifest {
    version: typeof SEED_MANIFEST_VERSION;
    release: { corpusFingerprint: string; judgmentsFingerprint: string };
    dims: number;
    embeddingModelId: string;
    sessions: Array<{
        projectScope: string;
        sessionScope: string | null;
        physicalSessionId: string;
    }>;
    documents: SeedManifestEntry[];
    synthetic: {
        profileId: string;
        generatorVersion: string;
        scale: number;
        seededDocuments: number;
        physicalSessionId: string;
        projectScope: string;
    } | null;
}

export interface SeedResult {
    manifest: SeedManifest;
    /** Deterministic fingerprint over the manifest (no wall time, no paths). */
    manifestFingerprint: string;
    databasePath: string;
    snapshotPath: string;
    /** Run-specific evidence, deliberately OUTSIDE the fingerprint (R57). */
    evidence: {
        indexBuildMs: number;
        snapshotBytes: number;
    };
}

export interface SeedReleaseInput {
    corpus: CorpusArtifact;
    judgments: JudgmentsArtifact;
    fingerprints: { corpus: string; judgments: string };
}

export interface SeedFixtureOptions {
    /** Directory for the working database and snapshot. Must not already
     *  contain fixture files (fail closed instead of mixing runs). */
    fixtureDir: string;
    /** Declared vector dimension for every deterministic embedding. */
    dims: number;
    /** Optional deterministic scale stream seeded after the reviewed corpus. */
    synthetic?: {
        profile: SyntheticProfile;
        /** Seed only the first N stream documents (tests / small profiles). */
        documentLimit?: number;
    };
    clock?: () => number;
}

/** Physical session for aliases without a session scope: derived from the
 *  project scope only, so two seed runs of one release agree byte-for-byte. */
export function fixtureSessionId(projectScope: string, sessionScope: string | null): string {
    return sessionScope ?? `bench:${projectScope}`;
}

const NUMERIC_LOCATOR_KINDS: ReadonlySet<DocumentKind> = new Set([
    "memory",
    "compartment",
    "primer",
    "note",
]);

/** Aliases the CURRENT production search path can emit: production namespace
 *  spelling, and a canonical-decimal numeric locator for row-id stores. */
export function producibleAliases(document: CorpusDocument): StructuredAlias[] {
    const namespace = SOURCE_LOCATOR_KIND[document.kind];
    return document.aliases.filter((alias) => {
        if (alias.namespace !== namespace) return false;
        if (!NUMERIC_LOCATOR_KINDS.has(document.kind)) return true;
        // SQLite AUTOINCREMENT ids start at 1, so "0" is not producible: the
        // cursor advance would set sqlite_sequence to -1 and the emitted row
        // would come back as id 1, failing locator verification.
        return /^[1-9]\d*$/.test(alias.locator) && String(Number(alias.locator)) === alias.locator;
    });
}

/** AUTOINCREMENT id-cursor advance: the sqlite_sequence row is bookkeeping,
 *  not document content — the approved locator row itself is still emitted
 *  by the production helper, whose result is verified against the alias. */
function advanceIdCursor(db: Database, table: "memories" | "notes" | "primers" | "compartments", nextIdMinusOne: number): void {
    const row = db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = ?")
        .get(table) as { seq?: number } | null | undefined;
    if (row === null || row === undefined) {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(
            table,
            nextIdMinusOne,
        );
        return;
    }
    if ((row.seq ?? 0) < nextIdMinusOne) {
        db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(
            nextIdMinusOne,
            table,
        );
    }
}

function pinNoteTimestamp(db: Database, noteId: number): void {
    const pinned = SEED_EPOCH_MS + noteId;
    db.prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(
        pinned,
        pinned,
        noteId,
    );
}

function documentText(document: { title: string; body: string }): string {
    return document.title.length > 0 ? `${document.title}\n${document.body}` : document.body;
}

function seedCompartmentRow(
    db: Database,
    args: {
        sessionId: string;
        projectPath: string;
        expectedId: number | null;
        sequence: number;
        ordinal: number;
        title: string;
        body: string;
        vector: Float32Array;
        vectorKey: string;
    },
): { id: number; vectorBytes: number } {
    if (args.expectedId !== null) {
        advanceIdCursor(db, "compartments", args.expectedId - 1);
    }
    appendCompartments(db, args.sessionId, [
        {
            sequence: args.sequence,
            startMessage: args.ordinal,
            endMessage: args.ordinal,
            startMessageId: `bench-${args.vectorKey}-start`,
            endMessageId: `bench-${args.vectorKey}-end`,
            title: args.title,
            content: args.body,
            p1: args.body,
        },
    ]);
    // Indexed point lookup via UNIQUE(session_id, sequence). All synthetic
    // compartments share one session, so re-reading the whole session per
    // insert (getCompartments + find) is O(C^2) over the seed and pushes
    // 1M-scale fixtures past any workflow timeout.
    const compartment = db
        .prepare("SELECT id FROM compartments WHERE session_id = ? AND sequence = ?")
        .get(args.sessionId, args.sequence) as { id: number } | undefined;
    if (!compartment) throw new SeedError([`seed: compartment row missing (${args.vectorKey})`]);
    const windows = chunkCanonicalText(
        `[${args.ordinal}] U: ${documentText({ title: args.title, body: args.body })}`,
        args.ordinal,
        args.ordinal,
        10_000,
    );
    replaceCompartmentChunkEmbeddings(
        db,
        windows.map((window) => ({
            compartmentId: compartment.id,
            sessionId: args.sessionId,
            projectPath: args.projectPath,
            window,
            modelId: BENCHMARK_EMBEDDING_MODEL_ID,
            vector: args.vector,
        })),
    );
    return { id: compartment.id, vectorBytes: windows.length * args.vector.byteLength };
}

/**
 * Seed one reviewed release (plus an optional deterministic synthetic scale
 * stream) into an isolated production-shaped database and snapshot it.
 */
export function seedFixture(release: SeedReleaseInput, options: SeedFixtureOptions): SeedResult {
    const clock = options.clock ?? (() => performance.now());
    if (!Number.isInteger(options.dims) || options.dims < 1 || options.dims > 4096) {
        throw new SeedError(["seed: invalid dims"]);
    }
    for (const judgment of release.judgments.judgments) {
        // Synthetic ids can never be graded: quality truth comes only from
        // reviewed documents (R48), and a graded synthetic id here would let
        // scale filler enter quality aggregation downstream.
        if (judgment.documentId.startsWith("syn:")) {
            throw new SeedError([`seed: synthetic document graded (${judgment.queryId})`]);
        }
    }

    mkdirSync(options.fixtureDir, { recursive: true });
    const databasePath = join(options.fixtureDir, SEED_DB_FILE);
    const snapshotPath = join(options.fixtureDir, SNAPSHOT_FILE);
    if (existsSync(databasePath) || existsSync(snapshotPath)) {
        throw new SeedError(["seed: fixture directory not empty"]);
    }

    const startedAt = clock();
    const db = new Database(databasePath);
    try {
        initializeDatabase(db);
        runMigrations(db);

        const entries: SeedManifestEntry[] = [];
        const sessionKeys = new Map<string, { projectScope: string; sessionScope: string | null }>();
        const ordinals = new Map<string, number>();
        const compartmentSequences = new Map<string, number>();
        const messagesBySession = new Map<string, RawMessage[]>();
        const nextOrdinal = (sessionId: string): number => {
            const next = (ordinals.get(sessionId) ?? 0) + 1;
            ordinals.set(sessionId, next);
            return next;
        };
        const nextSequence = (sessionId: string): number => {
            const next = (compartmentSequences.get(sessionId) ?? -1) + 1;
            compartmentSequences.set(sessionId, next);
            return next;
        };
        const trackSession = (projectScope: string, sessionScope: string | null): string => {
            const physical = fixtureSessionId(projectScope, sessionScope);
            sessionKeys.set(physical, { projectScope, sessionScope });
            return physical;
        };

        interface PlannedAlias {
            document: CorpusDocument;
            alias: StructuredAlias;
        }
        const planned: PlannedAlias[] = [];
        const diagnostics: string[] = [];
        for (const document of release.corpus.documents) {
            const aliases = producibleAliases(document);
            if (aliases.length === 0) {
                diagnostics.push(`seed: no production-producible alias (${document.id})`);
                continue;
            }
            for (const alias of aliases) planned.push({ document, alias });
        }
        if (diagnostics.length > 0) throw new SeedError(diagnostics.sort());

        const byKind = (kind: DocumentKind) =>
            planned.filter((plan) => plan.document.kind === kind);
        const numericAscending = (a: PlannedAlias, b: PlannedAlias) =>
            Number(a.alias.locator) - Number(b.alias.locator);

        // Reviewed-document embedding: the document's text vector blended
        // with the text vectors of its positively graded queries, weighted
        // by grade. A real embedding model places a relevant document near
        // its query even without token overlap (paraphrase scenarios); this
        // corpus's semantic ground truth IS the judgment set, so the
        // judgments define that relatedness deterministically. Grade 2
        // pulls harder than grade 1, preserving the ranking the metrics
        // expect, while unrelated query-document pairs stay at hash noise.
        const queryTextById = new Map(
            release.corpus.queries.map((query) => [query.id, query.queryText]),
        );
        const gradedQueriesByDocument = new Map<string, Array<{ text: string; grade: number }>>();
        for (const judgment of release.judgments.judgments) {
            if (judgment.grade === 0) continue;
            const text = queryTextById.get(judgment.queryId);
            if (text === undefined) continue;
            const list = gradedQueriesByDocument.get(judgment.documentId) ?? [];
            list.push({ text, grade: judgment.grade });
            gradedQueriesByDocument.set(judgment.documentId, list);
        }
        const documentVector = (document: CorpusDocument): Float32Array => {
            const vector = new Float32Array(options.dims);
            const own = deterministicTextVector(documentText(document.semanticPayload), options.dims);
            for (let i = 0; i < options.dims; i += 1) vector[i] += own[i];
            for (const graded of gradedQueriesByDocument.get(document.id) ?? []) {
                const queryVector = deterministicTextVector(graded.text, options.dims);
                for (let i = 0; i < options.dims; i += 1) {
                    vector[i] += graded.grade * queryVector[i];
                }
            }
            normalizeVectorInPlace(vector);
            return vector;
        };

        const record = (
            plan: PlannedAlias,
            physicalSessionId: string | null,
            ordinal: number | null,
            vectorBytes: number,
        ) => {
            entries.push({
                documentId: plan.document.id,
                kind: plan.document.kind,
                locator: `${SOURCE_LOCATOR_KIND[plan.document.kind]}:${plan.alias.locator}`,
                projectScope: plan.alias.projectScope,
                sessionScope: plan.alias.sessionScope,
                physicalSessionId,
                ordinal,
                vectorBytes,
            });
        };
        const verifyEmittedId = (plan: PlannedAlias, emitted: number | bigint) => {
            if (String(emitted) !== plan.alias.locator) {
                diagnostics.push(
                    `seed: emitted locator mismatch (${plan.document.id}, expected ${plan.alias.locator})`,
                );
            }
        };

        for (const plan of byKind("memory").sort(numericAscending)) {
            advanceIdCursor(db, "memories", Number(plan.alias.locator) - 1);
            // insertMemory otherwise stamps wall-clock timestamps, and the
            // v80 telemetry freeze forbids rewriting them after insert —
            // identical seeds must produce identical row bytes.
            const memory = insertMemory(db, {
                projectPath: plan.alias.projectScope,
                category: "ARCHITECTURE_DECISIONS",
                content: documentText(plan.document.semanticPayload),
                nowMs: SEED_EPOCH_MS + Number(plan.alias.locator),
            });
            verifyEmittedId(plan, memory.id);
            const vector = documentVector(plan.document);
            saveEmbedding(db, memory.id, vector, BENCHMARK_EMBEDDING_MODEL_ID);
            record(plan, null, null, vector.byteLength);
        }

        for (const plan of byKind("note").sort(numericAscending)) {
            advanceIdCursor(db, "notes", Number(plan.alias.locator) - 1);
            const sessionId = trackSession(plan.alias.projectScope, plan.alias.sessionScope);
            const note = addNote(db, "session", {
                sessionId,
                content: documentText(plan.document.semanticPayload),
            });
            pinNoteTimestamp(db, note.id);
            verifyEmittedId(plan, note.id);
            record(plan, sessionId, null, 0);
        }

        for (const plan of byKind("primer").sort(numericAscending)) {
            advanceIdCursor(db, "primers", Number(plan.alias.locator) - 1);
            const vector = documentVector(plan.document);
            const primerId = createPrimer(db, {
                projectPath: plan.alias.projectScope,
                question: plan.document.semanticPayload.title,
                questionEmbedding: vector,
                questionEmbeddingModelId: BENCHMARK_EMBEDDING_MODEL_ID,
                answer: plan.document.semanticPayload.body,
                totalSupport: 1,
                lastObservedAt: SEED_EPOCH_MS,
                sourceCandidateIds: [],
                now: SEED_EPOCH_MS,
            });
            verifyEmittedId(plan, primerId);
            record(plan, null, null, vector.byteLength);
        }

        for (const [index, plan] of byKind("git_commit").entries()) {
            const vector = documentVector(plan.document);
            upsertCommits(db, plan.alias.projectScope, [
                {
                    sha: plan.alias.locator,
                    shortSha: plan.alias.locator.slice(0, 7),
                    message: documentText(plan.document.semanticPayload),
                    author: null,
                    committedAtMs: SEED_EPOCH_MS + index,
                },
            ]);
            saveCommitEmbedding(db, plan.alias.locator, vector, BENCHMARK_EMBEDDING_MODEL_ID);
            record(plan, null, null, vector.byteLength);
        }

        for (const plan of planned) {
            if (plan.document.kind !== "message") continue;
            const sessionId = trackSession(plan.alias.projectScope, plan.alias.sessionScope);
            const ordinal = nextOrdinal(sessionId);
            const messages = messagesBySession.get(sessionId) ?? [];
            messages.push({
                ordinal,
                id: plan.alias.locator,
                role: "user",
                parts: [{ type: "text", text: documentText(plan.document.semanticPayload) }],
            });
            messagesBySession.set(sessionId, messages);
            record(plan, sessionId, ordinal, 0);
        }

        // Per-session ordinal watermark after reviewed messages, before the
        // synthetic filler advances the shared counter. Reviewed compartments
        // anchor their ranges just past this mark: below any explicit-query
        // cutoff (filler cannot shift them), but never overlapping a reviewed
        // message ordinal — production fusion coalesces a message inside a
        // compartment's range into the compartment identity, which would
        // erase judged messages from the ranking whenever both retrieve.
        const reviewedMessageWatermark = new Map(ordinals);

        let synthetic: SeedManifest["synthetic"] = null;
        let syntheticCompartments: SyntheticCompartment[] = [];
        if (options.synthetic) {
            const stream = seedSyntheticStream(db, {
                profile: options.synthetic.profile,
                documentLimit: options.synthetic.documentLimit,
                dims: options.dims,
                projectScope: primaryProjectScope(release.corpus),
                trackSession,
                nextOrdinal,
                messagesBySession,
            });
            synthetic = stream.info;
            syntheticCompartments = stream.pendingCompartments;
        }

        // Reviewed compartments reference deterministic low message ordinals
        // (watermark + dedicated counter) instead of consuming fresh ordinals
        // from the shared stream counter. Fresh ordinals land after the
        // synthetic scale filler — beyond every explicit-query ordinal cutoff
        // on large fixtures, which fails validatePositiveTargets. Message
        // ordinals stay contiguous 1..N per session, which the production
        // message indexer requires.
        const compartmentOrdinals = new Map<string, number>();
        const nextCompartmentOrdinal = (sessionId: string): number => {
            const next = (compartmentOrdinals.get(sessionId) ?? 0) + 1;
            compartmentOrdinals.set(sessionId, next);
            return next;
        };
        for (const plan of planned) {
            if (plan.document.kind !== "compartment") continue;
            const sessionId = trackSession(plan.alias.projectScope, plan.alias.sessionScope);
            const ordinal =
                (reviewedMessageWatermark.get(sessionId) ?? 0) + nextCompartmentOrdinal(sessionId);
            const vector = documentVector(plan.document);
            const seeded = seedCompartmentRow(db, {
                sessionId,
                projectPath: plan.alias.projectScope,
                expectedId: Number(plan.alias.locator),
                sequence: nextSequence(sessionId),
                ordinal,
                title: plan.document.semanticPayload.title,
                body: plan.document.semanticPayload.body,
                vector,
                vectorKey: plan.document.id,
            });
            verifyEmittedId(plan, seeded.id);
            record(plan, sessionId, ordinal, seeded.vectorBytes);
        }
        for (const pending of syntheticCompartments) {
            seedCompartmentRow(db, {
                sessionId: pending.sessionId,
                projectPath: pending.projectScope,
                expectedId: null,
                sequence: nextSequence(pending.sessionId),
                ordinal: nextOrdinal(pending.sessionId),
                title: pending.title,
                body: pending.body,
                vector: deterministicVector(pending.id, options.dims),
                vectorKey: pending.id,
            });
        }

        for (const [sessionId, messages] of messagesBySession) {
            ensureMessagesIndexed(db, sessionId, () => messages);
        }

        // Production helpers stamp wall-clock bookkeeping columns that the
        // seed manifest does not represent; pin them so identical seeds
        // produce identical snapshot bytes under one manifest fingerprint.
        db.prepare("UPDATE git_commits SET indexed_at = ?").run(SEED_EPOCH_MS);
        db.prepare("UPDATE git_commit_embeddings SET created_at = ?").run(SEED_EPOCH_MS);
        db.prepare("UPDATE message_history_index SET updated_at = ?").run(SEED_EPOCH_MS);
        db.prepare("UPDATE message_history_source SET updated_at = ?").run(SEED_EPOCH_MS);
        db.prepare("UPDATE compartments SET created_at = ?").run(SEED_EPOCH_MS);
        db.prepare("UPDATE compartment_chunk_embeddings SET created_at = ?").run(SEED_EPOCH_MS);

        if (diagnostics.length > 0) throw new SeedError(diagnostics.sort());
        validatePositiveTargets(release, entries);

        const manifest: SeedManifest = {
            version: SEED_MANIFEST_VERSION,
            release: {
                corpusFingerprint: release.fingerprints.corpus,
                judgmentsFingerprint: release.fingerprints.judgments,
            },
            dims: options.dims,
            embeddingModelId: BENCHMARK_EMBEDDING_MODEL_ID,
            sessions: [...sessionKeys.entries()]
                .map(([physicalSessionId, scope]) => ({ ...scope, physicalSessionId }))
                .sort((a, b) => a.physicalSessionId.localeCompare(b.physicalSessionId)),
            documents: entries.sort(
                (a, b) =>
                    a.documentId.localeCompare(b.documentId) || a.locator.localeCompare(b.locator),
            ),
            synthetic,
        };

        db.prepare("VACUUM INTO ?").run(snapshotPath);
        const indexBuildMs = clock() - startedAt;
        return {
            manifest,
            manifestFingerprint: canonicalFingerprint(manifest),
            databasePath,
            snapshotPath,
            evidence: {
                indexBuildMs,
                snapshotBytes: statSync(snapshotPath).size,
            },
        };
    } finally {
        closeQuietly(db);
    }
}

function primaryProjectScope(corpus: CorpusArtifact): string {
    return corpus.queries[0].fixtureScope.projectScope;
}

interface SyntheticCompartment {
    id: string;
    sessionId: string;
    projectScope: string;
    title: string;
    body: string;
}

function seedSyntheticStream(
    db: Database,
    args: {
        profile: SyntheticProfile;
        documentLimit: number | undefined;
        dims: number;
        projectScope: string;
        trackSession: (projectScope: string, sessionScope: string | null) => string;
        nextOrdinal: (sessionId: string) => number;
        messagesBySession: Map<string, RawMessage[]>;
    },
): {
    info: NonNullable<SeedManifest["synthetic"]>;
    pendingCompartments: SyntheticCompartment[];
} {
    const sessionId = args.trackSession(args.projectScope, null);
    const limit = Math.min(args.documentLimit ?? args.profile.scale, args.profile.scale);
    let seeded = 0;
    const pendingCompartments: SyntheticCompartment[] = [];
    let batch: Array<() => void> = [];
    const flush = () => {
        if (batch.length === 0) return;
        const work = batch;
        batch = [];
        db.transaction(() => {
            for (const write of work) write();
        })();
    };
    // ponytail: per-document production-helper writes; bulk row streaming if
    // the 1M scale seed time ever matters before U5 lands.
    for (const document of iterateSyntheticDocuments(args.profile)) {
        if (seeded >= limit) break;
        seeded += 1;
        const kind = document.kind;
        if (kind === "message") {
            const messages = args.messagesBySession.get(sessionId) ?? [];
            messages.push({
                ordinal: args.nextOrdinal(sessionId),
                id: document.id,
                role: "user",
                parts: [{ type: "text", text: documentText(document) }],
            });
            args.messagesBySession.set(sessionId, messages);
            continue;
        }
        if (kind === "memory") {
            batch.push(() => {
                const memory = insertMemory(db, {
                    projectPath: args.projectScope,
                    category: "ARCHITECTURE_DECISIONS",
                    content: documentText(document),
                    nowMs: SEED_EPOCH_MS,
                });
                saveEmbedding(
                    db,
                    memory.id,
                    deterministicVector(document.id, args.dims),
                    BENCHMARK_EMBEDDING_MODEL_ID,
                );
            });
        } else if (kind === "compartment") {
            pendingCompartments.push({
                id: document.id,
                sessionId,
                projectScope: args.projectScope,
                title: document.title,
                body: document.body,
            });
        } else if (kind === "git_commit") {
            const sha = deterministicHexDigest(document.id).slice(0, 40);
            batch.push(() => {
                upsertCommits(db, args.projectScope, [
                    {
                        sha,
                        shortSha: sha.slice(0, 7),
                        message: documentText(document),
                        author: null,
                        committedAtMs: SEED_EPOCH_MS,
                    },
                ]);
                saveCommitEmbedding(
                    db,
                    sha,
                    deterministicVector(document.id, args.dims),
                    BENCHMARK_EMBEDDING_MODEL_ID,
                );
            });
        } else if (kind === "primer") {
            batch.push(() => {
                createPrimer(db, {
                    projectPath: args.projectScope,
                    question: document.title,
                    questionEmbedding: deterministicVector(document.id, args.dims),
                    questionEmbeddingModelId: BENCHMARK_EMBEDDING_MODEL_ID,
                    answer: document.body,
                    totalSupport: 1,
                    lastObservedAt: SEED_EPOCH_MS,
                    sourceCandidateIds: [],
                    now: SEED_EPOCH_MS,
                });
            });
        } else {
            batch.push(() => {
                const note = addNote(db, "session", { sessionId, content: documentText(document) });
                pinNoteTimestamp(db, note.id);
            });
        }
        if (batch.length >= SEED_BATCH_SIZE) flush();
    }
    flush();
    return {
        info: {
            profileId: args.profile.id,
            generatorVersion: args.profile.generatorVersion,
            scale: args.profile.scale,
            seededDocuments: seeded,
            physicalSessionId: sessionId,
            projectScope: args.projectScope,
        },
        pendingCompartments,
    };
}

/**
 * Seed-time reachability validation for every positively judged target
 * (AE2): source filters, automatic-lane membership, visible-memory rules,
 * scenario scope, and the INCLUSIVE ordinal cutoff against the ordinal the
 * seeder actually emitted. Diagnostics carry regex-bounded ids only.
 */
function validatePositiveTargets(
    release: SeedReleaseInput,
    entries: readonly SeedManifestEntry[],
): void {
    const diagnostics: string[] = [];
    const queryById = new Map(release.corpus.queries.map((query) => [query.id, query]));
    const documentById = new Map(
        release.corpus.documents.map((document) => [document.id, document]),
    );
    const entriesByDocument = new Map<string, SeedManifestEntry[]>();
    for (const entry of entries) {
        const list = entriesByDocument.get(entry.documentId) ?? [];
        list.push(entry);
        entriesByDocument.set(entry.documentId, list);
    }

    for (const judgment of release.judgments.judgments) {
        if (judgment.grade === 0) continue;
        const query = queryById.get(judgment.queryId);
        const document = documentById.get(judgment.documentId);
        if (!query || !document) continue;
        const pair = `(${judgment.queryId}, ${judgment.documentId})`;
        const seeded = entriesByDocument.get(judgment.documentId) ?? [];

        const inScope = seeded.filter(
            (entry) =>
                entry.projectScope === query.fixtureScope.projectScope &&
                (entry.sessionScope === null ||
                    entry.sessionScope === query.fixtureScope.sessionScope),
        );
        if (inScope.length === 0) {
            diagnostics.push(`seed: target has no seeded alias in scenario scope ${pair}`);
            continue;
        }

        const laneFilter = document.kind === "compartment" ? "message" : document.kind;
        if (query.sourceFilters !== null && !query.sourceFilters.includes(laneFilter)) {
            diagnostics.push(`seed: target excluded by source filters ${pair}`);
        }

        if (document.kind === "memory") {
            const visible = new Set(query.visibleState.visibleMemoryIds.map(String));
            const locators = inScope.map((entry) => entry.locator.split(":")[1]);
            if (locators.every((locator) => visible.has(locator))) {
                diagnostics.push(`seed: target hidden by visible memories ${pair}`);
            }
        }

        const cutoff = query.visibleState.messageOrdinalCutoff;
        if (cutoff !== null && (document.kind === "message" || document.kind === "compartment")) {
            // Inclusive maximum: an ordinal equal to the cutoff stays
            // reachable; one beyond it can never be returned by the
            // production lanes, so measuring would record a structural miss
            // as a ranking miss.
            const reachable = inScope.some(
                (entry) => entry.ordinal !== null && entry.ordinal <= cutoff,
            );
            if (!reachable) {
                diagnostics.push(`seed: target ordinal beyond cutoff ${pair}`);
            }
        }
    }
    if (diagnostics.length > 0) throw new SeedError(diagnostics.sort());
}

/** Open a completed snapshot read-only; measured workers must not mutate it. */
export function openFixtureSnapshot(path: string): Database {
    return new Database(path, { readonly: true });
}

export interface SelectivityPredicate {
    projectScope: string;
    sessionScope: string | null;
    messageOrdinalCutoff: number | null;
}

export interface SelectivityObservation {
    preFilterDenominator: number;
    eligibleCount: number;
}

/**
 * Observed pre-filter and eligible cardinalities for a message-lane
 * selectivity predicate, measured against the production message index the
 * fixture actually serves queries from.
 */
export function measureMessageSelectivity(
    db: Database,
    predicate: SelectivityPredicate,
): SelectivityObservation {
    const sessionId = fixtureSessionId(predicate.projectScope, predicate.sessionScope);
    const denominatorRow = db
        .prepare("SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ?")
        .get(sessionId) as { count: number };
    if (predicate.messageOrdinalCutoff === null) {
        return {
            preFilterDenominator: denominatorRow.count,
            eligibleCount: denominatorRow.count,
        };
    }
    const eligibleRow = db
        .prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND CAST(message_ordinal AS INTEGER) <= ?",
        )
        .get(sessionId, predicate.messageOrdinalCutoff) as { count: number };
    return {
        preFilterDenominator: denominatorRow.count,
        eligibleCount: eligibleRow.count,
    };
}
