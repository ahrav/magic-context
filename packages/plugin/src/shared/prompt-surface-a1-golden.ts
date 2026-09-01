import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *
 * across packages.
 *
 */

export const A1_TOOL_SECTION_HEADING = "## 2. Tool surface";
export const A1_HASH_BASELINE_HEADING = "## 3. System-prompt hash baseline";

export function readA1GoldenDocument(): string {
    return readFileSync(join(import.meta.dir, "prompt-surface-a1-golden.md"), "utf8");
}

/**
 *
 * clean run.
 */
export function a1GoldenSectionOffset(document: string, heading: string): number {
    const offset = document.indexOf(heading);
    if (offset === -1) {
        throw new Error(`A1 golden is missing the "${heading}" section heading`);
    }
    return offset;
}
