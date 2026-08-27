import { computeNormalizedHash } from "../../src/features/magic-context/memory/normalize-hash";
import type { Database, Statement as PreparedStatement } from "../../src/shared/sqlite";

export function createBenchmarkMemoryFixtureTables(db: Database): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      source_type TEXT DEFAULT 'historian',
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      UNIQUE(project_path, category, normalized_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
    );
    `);
}

export interface BenchmarkMemoryInput {
    projectPath: string;
    category: string;
    content: string;
    nowMs: number;
    sourceType: string;
}

export function insertBenchmarkMemory(db: Database, input: BenchmarkMemoryInput): { id: number } {
    const result = db
        .prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash, source_type,
                 first_seen_at, created_at, updated_at, last_seen_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
            input.projectPath,
            input.category,
            input.content,
            computeNormalizedHash(input.content),
            input.sourceType,
            input.nowMs,
            input.nowMs,
            input.nowMs,
            input.nowMs,
        );
    return { id: Number(result.lastInsertRowid) };
}

export interface StoredMemoryEmbedding {
    embedding: Float32Array;
    modelId: string | null;
}

interface EmbeddingRow {
    memoryId: number;
    embedding: Uint8Array | ArrayBuffer;
    modelId: string | null;
}

const saveEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const loadAllEmbeddingsStatements = new WeakMap<Database, PreparedStatement>();

function isEmbeddingBlob(value: unknown): value is Uint8Array | ArrayBuffer {
    return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function isEmbeddingRow(row: unknown): row is EmbeddingRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.memoryId === "number" &&
        isEmbeddingBlob(candidate.embedding) &&
        (candidate.modelId === null || typeof candidate.modelId === "string")
    );
}

function toFloat32Array(blob: Uint8Array | ArrayBuffer): Float32Array {
    if (blob instanceof Uint8Array) {
        const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        return new Float32Array(buffer);
    }
    return new Float32Array(blob.slice(0));
}

export function saveMemoryVector(
    db: Database,
    memoryId: number,
    embedding: Float32Array,
    modelId: string,
): void {
    let stmt = saveEmbeddingStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (?, ?, ?) ON CONFLICT(memory_id, model_id) DO UPDATE SET embedding = excluded.embedding",
        );
        saveEmbeddingStatements.set(db, stmt);
    }
    stmt.run(
        memoryId,
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        modelId,
    );
}

function loadAllMemoryVectors(
    db: Database,
    projectPath: string,
    modelId: string,
): Map<number, StoredMemoryEmbedding> {
    let stmt = loadAllEmbeddingsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT memory_embeddings.memory_id AS memoryId, memory_embeddings.embedding AS embedding, memory_embeddings.model_id AS modelId FROM memory_embeddings INNER JOIN memories ON memories.id = memory_embeddings.memory_id WHERE memories.project_path = ? AND memory_embeddings.model_id = ? ORDER BY memory_embeddings.memory_id ASC",
        );
        loadAllEmbeddingsStatements.set(db, stmt);
    }
    const out = new Map<number, StoredMemoryEmbedding>();
    for (const row of stmt.all(projectPath, modelId)) {
        if (!isEmbeddingRow(row)) continue;
        out.set(row.memoryId, {
            embedding: toFloat32Array(row.embedding),
            modelId: row.modelId,
        });
    }
    return out;
}

const processVectorCache = new Map<string, Map<number, StoredMemoryEmbedding>>();

function cacheKey(projectPath: string, modelId: string): string {
    return `${projectPath}\0${modelId}`;
}

export function primeMemoryVectorCache(db: Database, projectPath: string, modelId: string): void {
    processVectorCache.set(
        cacheKey(projectPath, modelId),
        loadAllMemoryVectors(db, projectPath, modelId),
    );
}

export function peekMemoryVectorCache(projectPath: string, modelId: string): boolean {
    return processVectorCache.has(cacheKey(projectPath, modelId));
}

export function invalidateMemoryVectorCache(projectPath: string): void {
    for (const key of processVectorCache.keys()) {
        if (key.startsWith(`${projectPath}\0`)) processVectorCache.delete(key);
    }
}
