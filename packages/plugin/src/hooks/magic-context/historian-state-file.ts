import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    ensureCortexKitArtifactGitignore,
    getProjectMagicContextHistorianDir,
} from "../../shared/data-path";

/**
 *
 * output tokens.
 *
 * permission prompt.
 *
 * The caller MUST delete the file in finally{} via
 * {@link cleanupHistorianStateFile}.
 *
 */
export const HISTORIAN_STATE_INLINE_THRESHOLD = 30_000;

/**
 *
 */
export function maybeWriteHistorianStateFile(
    sessionId: string,
    existingState: string,
    directory: string,
): string | undefined {
    if (existingState.length <= HISTORIAN_STATE_INLINE_THRESHOLD) return undefined;
    try {
        const dir = getProjectMagicContextHistorianDir(directory);
        mkdirSync(dir, { recursive: true });
        ensureCortexKitArtifactGitignore(directory);
        const path = join(dir, `state-${sessionId}-${Date.now()}.xml`);
        writeFileSync(path, existingState, "utf8");
        return path;
    } catch {
        return undefined;
    }
}

/* */
export function cleanupHistorianStateFile(path: string | undefined): void {
    if (!path) return;
    try {
        unlinkSync(path);
    } catch {
        // best-effort cleanup
    }
}
