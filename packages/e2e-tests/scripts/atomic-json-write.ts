import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Exposed so stale-artifact cleanup can remove the staging sibling. commentlint: allow(JUDGE) */
export function stagingPathFor(destination: string): string {
    return `${destination}.tmp`;
}

/** Readers never observe a partially written destination: the bytes land on a staging sibling and become visible through a single rename. `label` names the artifact in the error raised when the staging path is occupied by something that must not be replaced. commentlint: allow(JUDGE) */
export function writeJsonAtomically(
    destination: string,
    value: unknown,
    label: string,
): void {
    mkdirSync(dirname(destination), { recursive: true });
    const staging = stagingPathFor(destination);
    /** lstat, not existsSync: writeFileSync would follow a symlink here and overwrite its target, then renameSync would publish the link. commentlint: allow(JUDGE) */
    const occupant = lstatSync(staging, { throwIfNoEntry: false });
    if (occupant !== undefined) {
        if (!occupant.isFile() && !occupant.isSymbolicLink()) {
            throw new Error(`${label} staging path is not a regular file: ${staging}`);
        }
        rmSync(staging, { force: true });
    }
    try {
        writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { force: true });
        throw error;
    }
}
