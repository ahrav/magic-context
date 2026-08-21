import { randomUUID } from "node:crypto";
import type { Database } from "../../../shared/sqlite";
import {
    computeClaimRequestDigest,
    hasMemoryClaimsCompatSchema,
    replaceMemoryVerificationFilesWithClaimsInCurrentTransaction,
    runInMemoryClaimsWriteTransaction,
    withClaimsWriteCapabilityInCurrentTransaction,
} from "./storage-memory-claims";

export const MEMORY_VERIFICATION_SENTINEL = "";

export interface MemoryVerificationState {
    /** Real repo-root-relative backing files. Excludes the no-file sentinel. */
    files: string[];
    /** True when a `""` no-file sentinel row exists for this memory. */
    hasSentinel: boolean;
    /** Max verified_at across all rows. 0 = mapped (files known) but NOT yet
     *  content-verified (the map-memories backfill records files without checking). */
    verifiedAt: number;
    /** Max mapped_at across all rows — when the file mapping was established. */
    mappedAt: number;
}

interface MemoryVerificationRow {
    memory_id: number;
    file_path: string;
    verified_at: number;
    mapped_at: number;
}

function placeholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
}

function uniqueSortedFiles(files: readonly string[]): string[] {
    return Array.from(
        new Set(files.filter((file) => file !== MEMORY_VERIFICATION_SENTINEL)),
    ).sort();
}

/**
 * MAP (map-memories backfill): record WHICH files back a memory (or the no-file
 * sentinel) WITHOUT content-verifying it — `verified_at=0`, `mapped_at=now`. The
 * first verify still sees it as unverified (verified_at=0) and checks the claim.
 */
export function recordMemoryMapping(
    db: Database,
    memoryId: number,
    normalizedFiles: readonly string[],
    now: number,
): number {
    const realFiles = uniqueSortedFiles(normalizedFiles);
    if (hasMemoryClaimsCompatSchema(db)) {
        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            replaceMemoryVerificationFilesWithClaimsInCurrentTransaction(
                db,
                {
                    producer: "storage-memory-verifications",
                    operationKey: `map:${randomUUID()}`,
                    requestDigest: computeClaimRequestDigest({ memoryId, realFiles, now }),
                    ephemeral: true,
                },
                { memoryId, files: realFiles, now, verified: false },
            ),
        );
        return outcome.result.rowsWritten;
    }
    const filesToWrite = realFiles.length > 0 ? realFiles : [MEMORY_VERIFICATION_SENTINEL];
    db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
    const insert = db.prepare(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, ?, 0, ?)",
    );
    for (const file of filesToWrite) {
        insert.run(memoryId, file, now);
    }
    return filesToWrite.length;
}

/**
 * VERIFY: replace one memory's side-table rows, marking them content-verified
 * (`verified_at=now`, `mapped_at=now`). Callers updating multiple memories should
 * wrap their batch in one transaction.
 */
export function recordMemoryVerifications(
    db: Database,
    memoryId: number,
    normalizedFiles: readonly string[],
    now: number,
): number {
    const realFiles = uniqueSortedFiles(normalizedFiles);
    if (hasMemoryClaimsCompatSchema(db)) {
        const outcome = runInMemoryClaimsWriteTransaction(db, () =>
            replaceMemoryVerificationFilesWithClaimsInCurrentTransaction(
                db,
                {
                    producer: "storage-memory-verifications",
                    operationKey: `verify:${randomUUID()}`,
                    requestDigest: computeClaimRequestDigest({ memoryId, realFiles, now }),
                    ephemeral: true,
                },
                { memoryId, files: realFiles, now, verified: true },
            ),
        );
        return outcome.result.rowsWritten;
    }
    const filesToWrite = realFiles.length > 0 ? realFiles : [MEMORY_VERIFICATION_SENTINEL];
    db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
    const insert = db.prepare(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at) VALUES (?, ?, ?, ?)",
    );
    for (const file of filesToWrite) {
        insert.run(memoryId, file, now, now);
    }
    return filesToWrite.length;
}

/** Memory ids (from the given set) that have NO mapping rows yet — the
 *  map-memories backfill scope. */
export function getUnmappedMemoryIds(db: Database, memoryIds: readonly number[]): number[] {
    const ids = Array.from(new Set(memoryIds.filter(Number.isInteger)));
    if (ids.length === 0) return [];
    const rows = db
        .prepare<unknown[], { memory_id: number }>(
            `SELECT DISTINCT memory_id FROM memory_verifications WHERE memory_id IN (${placeholders(ids)})`,
        )
        .all(...ids);
    const mapped = new Set(rows.map((r) => r.memory_id));
    return ids.filter((id) => !mapped.has(id));
}

export function clearMemoryVerifications(db: Database, memoryId: number): void {
    if (hasMemoryClaimsCompatSchema(db)) {
        db.transaction(() =>
            withClaimsWriteCapabilityInCurrentTransaction(db, () => {
                db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
            }),
        ).immediate();
        return;
    }
    db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
}

export function getMemoryVerifications(
    db: Database,
    memoryIds: readonly number[],
): Map<number, MemoryVerificationState> {
    const ids = Array.from(new Set(memoryIds.filter(Number.isInteger)));
    const result = new Map<number, MemoryVerificationState>();
    if (ids.length === 0) return result;

    const rows = db
        .prepare<unknown[], MemoryVerificationRow>(
            `SELECT memory_id, file_path, verified_at, mapped_at
               FROM memory_verifications
              WHERE memory_id IN (${placeholders(ids)})
              ORDER BY memory_id, file_path`,
        )
        .all(...ids);

    for (const row of rows) {
        const existing = result.get(row.memory_id) ?? {
            files: [],
            hasSentinel: false,
            verifiedAt: 0,
            mappedAt: 0,
        };
        if (row.file_path === MEMORY_VERIFICATION_SENTINEL) {
            existing.hasSentinel = true;
        } else if (!existing.files.includes(row.file_path)) {
            existing.files.push(row.file_path);
        }
        existing.verifiedAt = Math.max(existing.verifiedAt, row.verified_at);
        existing.mappedAt = Math.max(existing.mappedAt, row.mapped_at ?? 0);
        result.set(row.memory_id, existing);
    }

    for (const state of result.values()) {
        state.files.sort();
    }
    return result;
}
