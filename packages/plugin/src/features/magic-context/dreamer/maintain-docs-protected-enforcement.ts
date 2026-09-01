import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../../shared/logger";
import { enforceProtectedRegions } from "./protected-regions";

export const MAINTAIN_DOCS_SNAPSHOT_FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;

export type MaintainDocsDocSnapshot = Map<string, string>;

/* */
export function snapshotMaintainDocsFiles(docsDir: string): MaintainDocsDocSnapshot {
    const snapshot = new Map<string, string>();
    for (const name of MAINTAIN_DOCS_SNAPSHOT_FILES) {
        const path = join(docsDir, name);
        try {
            if (existsSync(path)) {
                snapshot.set(name, readFileSync(path, "utf8"));
            }
        } catch {
            // best-effort snapshot
        }
    }
    return snapshot;
}

/**
 */
export function enforceMaintainDocsProtectedRegions(args: {
    docsDir: string;
    snapshot: MaintainDocsDocSnapshot;
}): void {
    for (const [fileName, original] of args.snapshot) {
        const path = join(args.docsDir, fileName);
        try {
            const current = readFileSync(path, "utf8");
            const { text, violated } = enforceProtectedRegions(original, current);
            if (!violated) {
                continue;
            }
            writeFileSync(path, text, "utf8");
            log(
                `[dreamer] maintain-docs altered a protected region in ${fileName} — restored from pre-task snapshot`,
            );
        } catch (error) {
            log(
                `[dreamer] maintain-docs protected-region enforcement failed for ${fileName}: ${error}`,
            );
        }
    }
}
