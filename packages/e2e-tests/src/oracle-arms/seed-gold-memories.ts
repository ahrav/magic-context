import { realpathSync, statSync } from "node:fs";
import {
    getMemoryById,
    insertMemory,
    resolveProjectIdentity,
    updateMemoryVerification,
    type Memory,
    type MemoryCategory,
} from "../../../plugin/src/features/magic-context/memory";
import { openTestDb } from "../test-db";

export interface GoldMemoryRow {
    category: MemoryCategory;
    content: string;
    importance?: number;
}

export interface SeedGoldMemoriesOptions {
    workdir: string;
    dbPath: string;
    rows: readonly GoldMemoryRow[];
    verification: "candidate" | "verified";
}

/**
 * Seed oracle rows through the production claim-aware write path.
 *
 * The database must already exist; opening a missing SQLite path would create a
 * schemaless file and turn a disabled-plugin baseline into misleading test data.
 * Inserts are intentionally not idempotent or transactional as a group. A
 * duplicate normalized hash surfaces the store's UNIQUE error after earlier
 * rows have committed, matching repeated direct `insertMemory` calls.
 */
export function seedGoldMemories(options: SeedGoldMemoriesOptions): Memory[] {
    let db: ReturnType<typeof openTestDb>;
    try {
        db = openTestDb(options.dbPath, { readwrite: true, create: false });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN") {
            try {
                statSync(options.dbPath);
            } catch (pathError) {
                if ((pathError as NodeJS.ErrnoException).code === "ENOENT") {
                    throw new Error(
                        `seedGoldMemories: context.db does not exist: ${options.dbPath}`,
                        { cause: error },
                    );
                }
            }
        }
        throw error;
    }
    try {
        const projectPath = resolveProjectIdentity(realpathSync(options.workdir));
        return options.rows.map((row) => {
            const inserted = insertMemory(db, {
                projectPath,
                category: row.category,
                content: row.content,
                importance: row.importance,
            });
            if (options.verification === "candidate") return inserted;

            updateMemoryVerification(db, inserted.id, "verified");
            const verified = getMemoryById(db, inserted.id);
            if (!verified) {
                throw new Error(
                    `seedGoldMemories: inserted memory ${inserted.id} disappeared after verification`,
                );
            }
            return verified;
        });
    } finally {
        db.close();
    }
}
