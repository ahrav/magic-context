import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { Database } from "../../plugin/src/shared/sqlite";
import { releaseRootPath, type VerifiedReleaseRoot } from "./prospective-holdout/release-root";

export function initializeIsolatedContextDb(dataDir: string, releaseRoot?: VerifiedReleaseRoot): void {
    const path = join(dataDir, "cortexkit", "magic-context", "context.db");
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    if (releaseRoot) {
        copyFileSync(releaseRootPath(releaseRoot, "databaseTemplate"), path);
        chmodSync(path, 0o600);
        return;
    }
    const db = new Database(path);
    try {
        initializeDatabase(db);
        runMigrations(db);
    } finally {
        db.close();
    }
}
