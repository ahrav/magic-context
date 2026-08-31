import type { Database } from "../../../shared/sqlite";

/**
 */
export const USER_MEMORY_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserMemoryCandidate {
    id: number;
    content: string;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    createdAt: number;
}

export interface UserMemorySourceProvenance {
    candidateId: number;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
}

export interface UserMemory {
    id: number;
    content: string;
    status: "active" | "dismissed";
    promotedAt: number;
    sourceCandidateIds: number[];
    sourceProvenance: UserMemorySourceProvenance[] | null;
    createdAt: number;
    updatedAt: number;
}

export function insertUserMemoryCandidates(
    db: Database,
    candidates: Array<{
        content: string;
        sessionId: string;
        sourceCompartmentStart?: number;
        sourceCompartmentEnd?: number;
    }>,
): void {
    if (candidates.length === 0) return;
    const now = Date.now();
    const stmt = db.prepare(
        "INSERT INTO user_memory_candidates (content, session_id, source_compartment_start, source_compartment_end, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
        for (const c of candidates) {
            stmt.run(
                c.content,
                c.sessionId,
                c.sourceCompartmentStart ?? null,
                c.sourceCompartmentEnd ?? null,
                now,
            );
        }
    })();
}

export function getUserMemoryCandidates(db: Database): UserMemoryCandidate[] {
    const rows = db
        .prepare(
            "SELECT id, content, session_id, source_compartment_start, source_compartment_end, created_at FROM user_memory_candidates ORDER BY created_at ASC",
        )
        .all() as Array<{
        id: number;
        content: string;
        session_id: string;
        source_compartment_start: number | null;
        source_compartment_end: number | null;
        created_at: number;
    }>;
    return rows.map((r) => ({
        id: r.id,
        content: r.content,
        sessionId: r.session_id,
        sourceCompartmentStart: r.source_compartment_start,
        sourceCompartmentEnd: r.source_compartment_end,
        createdAt: r.created_at,
    }));
}

export function deleteUserMemoryCandidates(db: Database, ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM user_memory_candidates WHERE id IN (${placeholders})`).run(...ids);
}

/* */
export function getUserMemoryCandidateProjectIdentities(
    db: Database,
    ids: readonly number[],
): Map<number, string[]> {
    const uniqueIds = [...new Set(ids)].sort((left, right) => left - right);
    const result = new Map(uniqueIds.map((id) => [id, [] as string[]]));
    if (uniqueIds.length === 0) return result;
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT candidates.id, projects.project_path
               FROM user_memory_candidates candidates
               LEFT JOIN session_projects projects
                 ON projects.session_id = candidates.session_id
              WHERE candidates.id IN (${placeholders})
              ORDER BY candidates.id ASC, projects.project_path ASC`,
        )
        .all(...uniqueIds) as Array<{ id: number; project_path: string | null }>;
    for (const row of rows) {
        if (row.project_path === null) continue;
        const identities = result.get(row.id);
        if (identities && identities.at(-1) !== row.project_path) identities.push(row.project_path);
    }
    return result;
}

/**
 */
export function pruneExpiredUserMemoryCandidates(
    db: Database,
    ttlMs: number,
    now: number = Date.now(),
): number {
    const cutoff = now - ttlMs;
    const result = db
        .prepare("DELETE FROM user_memory_candidates WHERE created_at < ?")
        .run(cutoff);
    return Number(result.changes ?? 0);
}

function loadUserMemorySourceProvenance(
    db: Database,
    candidateIds: number[],
): UserMemorySourceProvenance[] {
    const ids = [...new Set(candidateIds)].sort((a, b) => a - b);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT id, session_id, source_compartment_start, source_compartment_end
               FROM user_memory_candidates
              WHERE id IN (${placeholders})
              ORDER BY id ASC`,
        )
        .all(...ids) as Array<{
        id: number;
        session_id: string;
        source_compartment_start: number | null;
        source_compartment_end: number | null;
    }>;
    return rows.map((row) => ({
        candidateId: row.id,
        sessionId: row.session_id,
        sourceCompartmentStart: row.source_compartment_start,
        sourceCompartmentEnd: row.source_compartment_end,
    }));
}

function serializeUserMemorySourceProvenance(
    provenance: UserMemorySourceProvenance[],
    sourceCandidateIds: number[],
): string | null {
    const provenanceIds = new Set(provenance.map((source) => source.candidateId));
    if (sourceCandidateIds.some((id) => !provenanceIds.has(id))) return null;
    return JSON.stringify(
        provenance.map((source) => ({
            candidate_id: source.candidateId,
            session_id: source.sessionId,
            source_compartment_start: source.sourceCompartmentStart,
            source_compartment_end: source.sourceCompartmentEnd,
        })),
    );
}

export function insertUserMemory(
    db: Database,
    content: string,
    sourceCandidateIds: number[],
): number {
    return db.transaction(() => {
        const now = Date.now();
        const sourceProvenance = loadUserMemorySourceProvenance(db, sourceCandidateIds);
        const result = db
            .prepare(
                `INSERT INTO user_memories
                    (content, status, promoted_at, source_candidate_ids, source_candidate_provenance, created_at, updated_at)
                 VALUES (?, 'active', ?, ?, ?, ?, ?)`,
            )
            .run(
                content,
                now,
                JSON.stringify(sourceCandidateIds),
                serializeUserMemorySourceProvenance(sourceProvenance, sourceCandidateIds),
                now,
                now,
            );
        return Number(result.lastInsertRowid);
    })();
}

export function getActiveUserMemories(db: Database): UserMemory[] {
    const rows = db
        .prepare(
            "SELECT id, content, status, promoted_at, source_candidate_ids, source_candidate_provenance, created_at, updated_at FROM user_memories WHERE status = 'active' ORDER BY promoted_at ASC, id ASC",
        )
        .all() as Array<{
        id: number;
        content: string;
        status: string;
        promoted_at: number;
        source_candidate_ids: string;
        source_candidate_provenance: string | null;
        created_at: number;
        updated_at: number;
    }>;
    return rows.map(parseUserMemoryRow);
}

export function updateUserMemoryContent(
    db: Database,
    id: number,
    content: string,
    sourceCandidateIds: number[] = [],
): void {
    db.transaction(() => {
        if (sourceCandidateIds.length === 0) {
            db.prepare("UPDATE user_memories SET content = ?, updated_at = ? WHERE id = ?").run(
                content,
                Date.now(),
                id,
            );
            return;
        }
        const row = db
            .prepare(
                "SELECT source_candidate_ids, source_candidate_provenance FROM user_memories WHERE id = ?",
            )
            .get(id) as
            | { source_candidate_ids: string; source_candidate_provenance: string | null }
            | undefined;
        if (!row) return;
        const candidateIds = [
            ...new Set([...parseCandidateIds(row.source_candidate_ids), ...sourceCandidateIds]),
        ].sort((left, right) => left - right);
        const priorProvenance = parseUserMemorySourceProvenance(row.source_candidate_provenance);
        const provenanceById = new Map(
            (priorProvenance ?? []).map((source) => [source.candidateId, source]),
        );
        for (const source of loadUserMemorySourceProvenance(db, sourceCandidateIds)) {
            provenanceById.set(source.candidateId, source);
        }
        const provenance = [...provenanceById.values()].sort(
            (left, right) => left.candidateId - right.candidateId,
        );
        db.prepare(
            `UPDATE user_memories
                SET content = ?, source_candidate_ids = ?, source_candidate_provenance = ?, updated_at = ?
              WHERE id = ?`,
        ).run(
            content,
            JSON.stringify(candidateIds),
            serializeUserMemorySourceProvenance(provenance, candidateIds),
            Date.now(),
            id,
        );
    })();
}

export function dismissUserMemory(db: Database, id: number): void {
    db.prepare("UPDATE user_memories SET status = 'dismissed', updated_at = ? WHERE id = ?").run(
        Date.now(),
        id,
    );
}

function parseCandidateIds(raw: string): number[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
            : [];
    } catch {
        return [];
    }
}

function parseUserMemorySourceProvenance(raw: string | null): UserMemorySourceProvenance[] | null {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const provenance: UserMemorySourceProvenance[] = [];
        for (const value of parsed) {
            if (!value || typeof value !== "object") return null;
            const source = value as Record<string, unknown>;
            if (
                typeof source.candidate_id !== "number" ||
                !Number.isFinite(source.candidate_id) ||
                typeof source.session_id !== "string" ||
                (source.source_compartment_start !== null &&
                    typeof source.source_compartment_start !== "number") ||
                (source.source_compartment_end !== null &&
                    typeof source.source_compartment_end !== "number")
            ) {
                return null;
            }
            provenance.push({
                candidateId: source.candidate_id,
                sessionId: source.session_id,
                sourceCompartmentStart: source.source_compartment_start as number | null,
                sourceCompartmentEnd: source.source_compartment_end as number | null,
            });
        }
        return provenance;
    } catch {
        return null;
    }
}

function parseUserMemoryRow(row: {
    id: number;
    content: string;
    status: string;
    promoted_at: number;
    source_candidate_ids: string;
    source_candidate_provenance: string | null;
    created_at: number;
    updated_at: number;
}): UserMemory {
    return {
        id: row.id,
        content: row.content,
        status: row.status === "dismissed" ? "dismissed" : "active",
        promotedAt: row.promoted_at,
        sourceCandidateIds: parseCandidateIds(row.source_candidate_ids),
        sourceProvenance: parseUserMemorySourceProvenance(row.source_candidate_provenance),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
