import { constants } from "node:fs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { createDirectTestDatabase } from "../../plugin/src/features/magic-context/test-database";
import { releaseRootPath, type VerifiedReleaseRoot } from "./prospective-holdout/release-root";

export function initializeIsolatedContextDb(dataDir: string, releaseRoot?: VerifiedReleaseRoot): void {
    const path = join(dataDir, "cortexkit", "magic-context", "context.db");
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    if (releaseRoot) {
        // Stage and atomically rename the copy so an interrupted copy cannot leave a truncated `path`.
        const template = releaseRootPath(releaseRoot, "databaseTemplate");
        const staging = `${path}.staging-${randomBytes(8).toString("hex")}`;
        try {
            copyFileSync(template, staging, constants.COPYFILE_EXCL);
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
    createDirectTestDatabase({ path }).db.close();
}
