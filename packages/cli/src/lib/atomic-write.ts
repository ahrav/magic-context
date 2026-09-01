import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * When targetPath names a file and chmodSync succeeds, writeFileAtomic copies its 0o777 permission bits to tmpPath.
 *
 * Callers need not create the parent directory.
 */
export function writeFileAtomic(targetPath: string, data: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp`;
    writeFileSync(tmpPath, data, { encoding: "utf-8" });
    try {
        if (statSync(targetPath, { throwIfNoEntry: false })?.isFile()) {
            const mode = statSync(targetPath).mode & 0o777;
            chmodSync(tmpPath, mode);
        }
    } catch {
        // If statSync or chmodSync throws, writeFileAtomic still attempts renameSync(tmpPath, targetPath).
    }
    renameSync(tmpPath, targetPath);
}
