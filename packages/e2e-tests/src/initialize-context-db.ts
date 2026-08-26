import { constants } from "node:fs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
        // Copying straight to `path` publishes the destination before the bytes are
        // complete, so a worker killed mid-copy leaves a truncated database that the
        // existence check above then accepts on every retry, and each later paired attempt
        // runs against the partial file instead of the authenticated template. Staging the
        // copy beside the destination and renaming makes `path` appear only once the bytes
        // are whole, since the rename is atomic within the directory.
        const template = releaseRootPath(releaseRoot, "databaseTemplate");
        const staging = `${path}.staging-${randomBytes(8).toString("hex")}`;
        try {
            copyFileSync(template, staging, constants.COPYFILE_EXCL);
            // A short copy is the failure this guards, and it is invisible without a size
            // comparison: `copyFileSync` reports success for a destination the kernel
            // truncated under disk pressure.
            if (statSync(staging).size !== statSync(template).size) {
                throw new Error("initialize-context-db: template-copy-truncated");
            }
            chmodSync(staging, 0o600);
            renameSync(staging, path);
        } finally {
            rmSync(staging, { force: true });
        }
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
