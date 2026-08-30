import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Create `filePath`'s parent directory when absent. */
export function ensureParentDir(filePath: string): void {
    if (!existsSync(dirname(filePath))) {
        mkdirSync(dirname(filePath), { recursive: true });
    }
}
