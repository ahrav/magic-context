import type { Database } from "../../shared/sqlite";
import type { VectorLoadObserver } from "./search-trace";

export const PRIMER_CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PRIMER_CANDIDATE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export interface PrimerCandidateInput {
    projectPath: string;
    harness: string;
    sessionId: string;
    question: string;
    normalizedQuestion?: string;
    sourceCompartmentStart?: number | null;
    sourceCompartmentEnd?: number | null;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
    sourceMessageTime: number;
    questionEmbedding?: Float32Array | null;
    questionEmbeddingModelId?: string | null;
    createdAt?: number;
}

export interface PrimerCandidate {
    id: number;
    projectPath: string;
    harness: string;
    sessionId: string;
    question: string;
    normalizedQuestion: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
    sourceMessageTime: number;
    questionEmbedding: Float32Array | null;
    questionEmbeddingModelId: string | null;
    createdAt: number;
}

export interface PrimerSourceProvenance {
    candidateId: number;
    projectPath: string;
    harness: string;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
}

export interface Primer {
    id: number;
    projectPath: string;
    question: string;
    questionEmbedding: Float32Array | null;
    questionEmbeddingModelId: string | null;
    answer: string;
    status: "active" | "archived";
    totalSupport: number;
    lastObservedAt: number | null;
    answerRefreshedAt: number | null;
    sourceCandidateIds: number[];
    sourceProvenance: PrimerSourceProvenance[] | null;
    createdAt: number;
    updatedAt: number;
}

interface CandidateRow {
    id: number;
    project_path: string;
    harness: string;
    session_id: string;
    question: string;
    normalized_question: string;
    source_compartment_start: number | null;
    source_compartment_end: number | null;
    source_start_message_id: string;
    source_end_message_id: string;
    source_message_time: number;
    question_embedding: Uint8Array | ArrayBuffer | null;
    question_embedding_model_id: string | null;
    created_at: number;
}

interface PrimerRow {
    id: number;
    project_path: string;
    question: string;
    question_embedding: Uint8Array | ArrayBuffer | null;
    question_embedding_model_id: string | null;
    answer: string;
    status: string;
    total_support: number;
    last_observed_at: number | null;
    answer_refreshed_at: number | null;
    source_candidate_ids: string | null;
    source_candidate_provenance: string | null;
    created_at: number;
    updated_at: number;
}

export function normalizePrimerQuestion(question: string): string {
    return question
        .trim()
        .toLowerCase()
        .replace(/[“”]/g, '"')
        .replace(/[’]/g, "'")
        .replace(/\s+/g, " ")
        .replace(/[?.!]+$/g, "")
        .trim();
}

export function primerOccurrenceKey(
    candidate: Pick<
        PrimerCandidate,
        "projectPath" | "harness" | "sessionId" | "sourceStartMessageId" | "sourceEndMessageId"
    >,
): string {
    return [
        candidate.projectPath,
        candidate.harness,
        candidate.sessionId,
        candidate.sourceStartMessageId,
        candidate.sourceEndMessageId,
    ].join("\u001f");
}

export function primerOccurrenceUtcDay(sourceMessageTime: number): string {
    return new Date(sourceMessageTime).toISOString().slice(0, 10);
}

export function vectorBlob(vector: Float32Array | null | undefined): Uint8Array | null {
    if (!vector) return null;
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function blobToFloat32Array(
    value: Uint8Array | ArrayBuffer | null | undefined,
): Float32Array | null {
    if (!value) return null;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    return new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
}

function parseCandidateIds(raw: string | null): number[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
            : [];
    } catch {
        return [];
    }
}

function parsePrimerSourceProvenance(raw: string | null): PrimerSourceProvenance[] | null {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const provenance: PrimerSourceProvenance[] = [];
        for (const value of parsed) {
            if (!value || typeof value !== "object") return null;
            const source = value as Record<string, unknown>;
            if (
                typeof source.candidate_id !== "number" ||
                !Number.isFinite(source.candidate_id) ||
                typeof source.project_path !== "string" ||
                typeof source.harness !== "string" ||
                typeof source.session_id !== "string" ||
                (source.source_compartment_start !== null &&
                    typeof source.source_compartment_start !== "number") ||
                (source.source_compartment_end !== null &&
                    typeof source.source_compartment_end !== "number") ||
                typeof source.source_start_message_id !== "string" ||
                typeof source.source_end_message_id !== "string"
            ) {
                return null;
            }
            provenance.push({
                candidateId: source.candidate_id,
                projectPath: source.project_path,
                harness: source.harness,
                sessionId: source.session_id,
                sourceCompartmentStart: source.source_compartment_start as number | null,
                sourceCompartmentEnd: source.source_compartment_end as number | null,
                sourceStartMessageId: source.source_start_message_id,
                sourceEndMessageId: source.source_end_message_id,
            });
        }
        return provenance;
    } catch {
        return null;
    }
}

function loadPrimerSourceProvenance(
    db: Database,
    candidateIds: number[],
): PrimerSourceProvenance[] {
    const ids = [...new Set(candidateIds)].sort((a, b) => a - b);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT id, project_path, harness, session_id,
                    source_compartment_start, source_compartment_end,
                    source_start_message_id, source_end_message_id
               FROM primer_candidates
              WHERE id IN (${placeholders})
              ORDER BY id ASC`,
        )
        .all(...ids) as Array<{
        id: number;
        project_path: string;
        harness: string;
        session_id: string;
        source_compartment_start: number | null;
        source_compartment_end: number | null;
        source_start_message_id: string;
        source_end_message_id: string;
    }>;
    return rows.map((row) => ({
        candidateId: row.id,
        projectPath: row.project_path,
        harness: row.harness,
        sessionId: row.session_id,
        sourceCompartmentStart: row.source_compartment_start,
        sourceCompartmentEnd: row.source_compartment_end,
        sourceStartMessageId: row.source_start_message_id,
        sourceEndMessageId: row.source_end_message_id,
    }));
}

function serializePrimerSourceProvenance(
    provenance: PrimerSourceProvenance[],
    sourceCandidateIds: number[],
): string | null {
    if (provenance.length === 0 && sourceCandidateIds.length > 0) return null;
    return JSON.stringify(
        provenance.map((source) => ({
            candidate_id: source.candidateId,
            project_path: source.projectPath,
            harness: source.harness,
            session_id: source.sessionId,
            source_compartment_start: source.sourceCompartmentStart,
            source_compartment_end: source.sourceCompartmentEnd,
            source_start_message_id: source.sourceStartMessageId,
            source_end_message_id: source.sourceEndMessageId,
        })),
    );
}

function normalizedCandidateIds(candidateIds: number[]): number[] {
    return [...new Set(candidateIds)].sort((a, b) => a - b);
}

function toCandidate(row: CandidateRow): PrimerCandidate {
    return {
        id: row.id,
        projectPath: row.project_path,
        harness: row.harness,
        sessionId: row.session_id,
        question: row.question,
        normalizedQuestion: row.normalized_question,
        sourceCompartmentStart: row.source_compartment_start,
        sourceCompartmentEnd: row.source_compartment_end,
        sourceStartMessageId: row.source_start_message_id,
        sourceEndMessageId: row.source_end_message_id,
        sourceMessageTime: row.source_message_time,
        questionEmbedding: blobToFloat32Array(row.question_embedding),
        questionEmbeddingModelId: row.question_embedding_model_id,
        createdAt: row.created_at,
    };
}

function toPrimer(row: PrimerRow): Primer {
    const status = row.status === "archived" ? "archived" : "active";
    return {
        id: row.id,
        projectPath: row.project_path,
        question: row.question,
        questionEmbedding: blobToFloat32Array(row.question_embedding),
        questionEmbeddingModelId: row.question_embedding_model_id,
        answer: row.answer,
        status,
        totalSupport: row.total_support,
        lastObservedAt: row.last_observed_at,
        answerRefreshedAt: row.answer_refreshed_at,
        sourceCandidateIds: parseCandidateIds(row.source_candidate_ids),
        sourceProvenance: parsePrimerSourceProvenance(row.source_candidate_provenance),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function insertPrimerCandidates(db: Database, candidates: PrimerCandidateInput[]): number[] {
    const ids: number[] = [];
    const stmt = db.prepare(`
        INSERT INTO primer_candidates (
            project_path, harness, session_id, question, normalized_question,
            source_compartment_start, source_compartment_end,
            source_start_message_id, source_end_message_id, source_message_time,
            question_embedding, question_embedding_model_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_path, harness, session_id, source_start_message_id, source_end_message_id)
        DO UPDATE SET
            question = excluded.question,
            normalized_question = excluded.normalized_question,
            source_compartment_start = excluded.source_compartment_start,
            source_compartment_end = excluded.source_compartment_end,
            source_message_time = excluded.source_message_time,
            question_embedding = COALESCE(excluded.question_embedding, primer_candidates.question_embedding),
            question_embedding_model_id = COALESCE(excluded.question_embedding_model_id, primer_candidates.question_embedding_model_id),
            created_at = MIN(primer_candidates.created_at, excluded.created_at)
    `);
    const select = db.prepare(`
        SELECT id FROM primer_candidates
        WHERE project_path = ? AND harness = ? AND session_id = ?
          AND source_start_message_id = ? AND source_end_message_id = ?
    `);
    db.transaction(() => {
        for (const candidate of candidates) {
            const question = candidate.question.trim();
            if (!question) continue;
            const normalized = candidate.normalizedQuestion ?? normalizePrimerQuestion(question);
            stmt.run(
                candidate.projectPath,
                candidate.harness || "opencode",
                candidate.sessionId,
                question,
                normalized,
                candidate.sourceCompartmentStart ?? null,
                candidate.sourceCompartmentEnd ?? null,
                candidate.sourceStartMessageId,
                candidate.sourceEndMessageId,
                candidate.sourceMessageTime,
                vectorBlob(candidate.questionEmbedding),
                candidate.questionEmbeddingModelId ?? null,
                candidate.createdAt ?? Date.now(),
            );
            const row = select.get(
                candidate.projectPath,
                candidate.harness || "opencode",
                candidate.sessionId,
                candidate.sourceStartMessageId,
                candidate.sourceEndMessageId,
            ) as { id?: number } | undefined;
            if (typeof row?.id === "number") ids.push(row.id);
        }
    })();
    return ids;
}

export function updatePrimerCandidateEmbedding(
    db: Database,
    candidateId: number,
    vector: Float32Array,
    modelId: string,
): void {
    db.prepare(
        "UPDATE primer_candidates SET question_embedding = ?, question_embedding_model_id = ? WHERE id = ?",
    ).run(vectorBlob(vector), modelId, candidateId);
}

export function getPrimerCandidatesByIds(db: Database, ids: number[]): PrimerCandidate[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
        .prepare(`SELECT * FROM primer_candidates WHERE id IN (${placeholders})`)
        .all(...ids) as CandidateRow[];
    return rows.map(toCandidate);
}

export function getPrimerCandidatesForProject(
    db: Database,
    projectPath: string,
): PrimerCandidate[] {
    const rows = db
        .prepare(
            `SELECT * FROM primer_candidates
             WHERE project_path = ?
             ORDER BY project_path ASC, harness ASC, session_id ASC, source_start_message_id ASC, source_end_message_id ASC, id ASC`,
        )
        .all(projectPath) as CandidateRow[];
    return rows.map(toCandidate);
}

export function getPrimerCandidatesForPromotion(
    db: Database,
    projectPath: string,
    now = Date.now(),
    ttlMs = PRIMER_CANDIDATE_TTL_MS,
): PrimerCandidate[] {
    const cutoff = now - ttlMs;
    const rows = db
        .prepare(
            `SELECT * FROM primer_candidates
             WHERE project_path = ? AND source_message_time >= ?
             ORDER BY project_path ASC, harness ASC, session_id ASC, source_start_message_id ASC, source_end_message_id ASC, id ASC`,
        )
        .all(projectPath, cutoff) as CandidateRow[];
    return rows.map(toCandidate);
}

export function countPrimerCandidatesForProject(db: Database, projectPath: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM primer_candidates WHERE project_path = ?")
        .get(projectPath) as { count?: number } | undefined;
    return row?.count ?? 0;
}

export function getActivePrimers(
    db: Database,
    projectPath: string,
    onVectorLoad?: VectorLoadObserver,
): Primer[] {
    const rows = db
        .prepare(
            `SELECT * FROM primers
             WHERE project_path = ? AND status = 'active'
             ORDER BY COALESCE(last_observed_at, created_at) DESC, id ASC`,
        )
        .all(projectPath) as PrimerRow[];
    const primers = rows.map(toPrimer);
    if (onVectorLoad) {
        let decodedBytes = 0;
        let vectorCount = 0;
        for (const primer of primers) {
            if (!primer.questionEmbedding) continue;
            decodedBytes += primer.questionEmbedding.byteLength;
            vectorCount += 1;
        }
        onVectorLoad({ decodedBytes, cachedBytes: 0, vectorCount, cacheHit: false });
    }
    return primers;
}

export function getAllPrimers(db: Database, projectPath?: string): Primer[] {
    const sql = projectPath
        ? `SELECT * FROM primers WHERE project_path = ? ORDER BY status ASC, COALESCE(last_observed_at, created_at) DESC, id ASC`
        : `SELECT * FROM primers ORDER BY project_path ASC, status ASC, COALESCE(last_observed_at, created_at) DESC, id ASC`;
    const rows = (
        projectPath ? db.prepare(sql).all(projectPath) : db.prepare(sql).all()
    ) as PrimerRow[];
    return rows.map(toPrimer);
}

export function createPrimer(
    db: Database,
    input: {
        projectPath: string;
        question: string;
        questionEmbedding?: Float32Array | null;
        questionEmbeddingModelId?: string | null;
        answer?: string;
        totalSupport: number;
        lastObservedAt: number;
        sourceCandidateIds: number[];
        now?: number;
    },
): number {
    return db.transaction(() => {
        const now = input.now ?? Date.now();
        const sourceCandidateIds = normalizedCandidateIds(input.sourceCandidateIds);
        const sourceProvenance = loadPrimerSourceProvenance(db, sourceCandidateIds);
        const info = db
            .prepare(
                `INSERT INTO primers (
                    project_path, question, question_embedding, question_embedding_model_id, answer,
                    status, total_support, last_observed_at, answer_refreshed_at,
                    source_candidate_ids, source_candidate_provenance, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?)`,
            )
            .run(
                input.projectPath,
                input.question,
                vectorBlob(input.questionEmbedding),
                input.questionEmbeddingModelId ?? null,
                input.answer ?? "",
                input.totalSupport,
                input.lastObservedAt,
                JSON.stringify(sourceCandidateIds),
                serializePrimerSourceProvenance(sourceProvenance, sourceCandidateIds),
                now,
                now,
            );
        return Number(info.lastInsertRowid);
    })();
}

export function updatePrimerSupport(
    db: Database,
    input: {
        primerId: number;
        questionEmbedding?: Float32Array | null;
        questionEmbeddingModelId?: string | null;
        totalSupport: number;
        lastObservedAt: number;
        sourceCandidateIds: number[];
        now?: number;
    },
): void {
    db.transaction(() => {
        const sourceCandidateIds = normalizedCandidateIds(input.sourceCandidateIds);
        const allowedIds = new Set(sourceCandidateIds);
        const existingRow = db
            .prepare("SELECT source_candidate_provenance FROM primers WHERE id = ?")
            .get(input.primerId) as { source_candidate_provenance: string | null } | undefined;
        const provenanceByCandidateId = new Map<number, PrimerSourceProvenance>();
        for (const source of parsePrimerSourceProvenance(
            existingRow?.source_candidate_provenance ?? null,
        ) ?? []) {
            if (allowedIds.has(source.candidateId)) {
                provenanceByCandidateId.set(source.candidateId, source);
            }
        }
        for (const source of loadPrimerSourceProvenance(db, sourceCandidateIds)) {
            provenanceByCandidateId.set(source.candidateId, source);
        }
        const sourceProvenance = [...provenanceByCandidateId.values()].sort(
            (a, b) => a.candidateId - b.candidateId,
        );

        db.prepare(
            `UPDATE primers
             SET question_embedding = COALESCE(?, question_embedding),
                 question_embedding_model_id = COALESCE(?, question_embedding_model_id),
                 total_support = ?,
                 last_observed_at = ?,
                 source_candidate_ids = ?,
                 source_candidate_provenance = ?,
                 updated_at = ?
             WHERE id = ?`,
        ).run(
            vectorBlob(input.questionEmbedding),
            input.questionEmbeddingModelId ?? null,
            input.totalSupport,
            input.lastObservedAt,
            JSON.stringify(sourceCandidateIds),
            serializePrimerSourceProvenance(sourceProvenance, sourceCandidateIds),
            input.now ?? Date.now(),
            input.primerId,
        );
    })();
}

export function updatePrimerAnswer(
    db: Database,
    primerId: number,
    answer: string,
    refreshedAt = Date.now(),
): void {
    db.prepare(
        "UPDATE primers SET answer = ?, answer_refreshed_at = ?, updated_at = ? WHERE id = ?",
    ).run(answer, refreshedAt, refreshedAt, primerId);
}

export function pruneExpiredPrimerCandidates(
    db: Database,
    now = Date.now(),
    ttlMs = PRIMER_CANDIDATE_TTL_MS,
    maxAgeMs = PRIMER_CANDIDATE_MAX_AGE_MS,
): number {
    const activePrimers = getAllPrimers(db).filter((primer) => primer.status === "active");
    const protectedIds = new Set<number>();
    for (const primer of activePrimers) {
        for (const id of primer.sourceCandidateIds) protectedIds.add(id);
    }
    const oldRows = db
        .prepare(
            "SELECT id, source_message_time FROM primer_candidates WHERE source_message_time < ?",
        )
        .all(now - ttlMs) as Array<{ id: number; source_message_time: number }>;
    const toDelete = oldRows
        .filter((row) => !protectedIds.has(row.id) || row.source_message_time < now - maxAgeMs)
        .map((row) => row.id);
    if (toDelete.length === 0) return 0;
    const stmt = db.prepare("DELETE FROM primer_candidates WHERE id = ?");
    db.transaction(() => {
        for (const id of toDelete) stmt.run(id);
    })();
    return toDelete.length;
}
