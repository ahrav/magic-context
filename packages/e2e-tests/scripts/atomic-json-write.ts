import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Readers never observe a partially written destination: the bytes land in a private staging directory and become visible through a single rename. `label` names the artifact in the error raised when the destination cannot be created. commentlint: allow(JUDGE) */
export function writeJsonAtomically(
    destination: string,
    value: unknown,
    label: string,
): void {
    const parent = dirname(destination);
    mkdirSync(parent, { recursive: true });
    /** A private directory per call, not a shared `${destination}.tmp`: with a fixed name two writers collide, and the loser's cleanup deletes the winner's staged bytes, so neither publishes. A fresh directory also cannot be pre-occupied by a stale file or a symlink pointing somewhere else. commentlint: allow(JUDGE) */
    const stagingDir = mkdtempSync(join(parent, ".atomic-json-"));
    const staging = join(stagingDir, basename(destination));
    try {
        writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
        renameSync(staging, destination);
    } catch (error) {
        throw new Error(`${label}: could not publish ${destination}`, { cause: error });
    } finally {
        rmSync(stagingDir, { recursive: true, force: true });
    }
}
