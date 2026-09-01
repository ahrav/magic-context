import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const STAGING_ENTRY_RE = /^\.atomic-json-[A-Za-z0-9]{6}$/;
/** Only a directory older than this is reclaimable. A live writer's directory is seconds old, so the sweep cannot delete staged bytes another call is about to publish — which is the collision the private directory exists to prevent. commentlint: allow(JUDGE) */
const STAGING_ORPHAN_AGE_MS = 60_000;

/** A process killed between `mkdtempSync` and the `finally` leaves its directory behind, and for the frozen pool that debris lands in a committed directory. Reclaimed by a later publish rather than at exit, because a signal that skips `finally` skips an exit hook too. commentlint: allow(JUDGE) */
function reclaimOrphanedStaging(parent: string): void {
    let entries: string[];
    try {
        entries = readdirSync(parent);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!STAGING_ENTRY_RE.test(entry)) continue;
        const path = join(parent, entry);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        /** A publish only ever creates a directory under this name, and following a symlink would move the removal outside the parent. commentlint: allow(JUDGE) */
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
        if (Date.now() - stat.mtimeMs <= STAGING_ORPHAN_AGE_MS) continue;
        rmSync(path, { recursive: true, force: true });
    }
}

/** Readers never observe a partially written destination: the bytes land in a private staging directory and become visible through a single rename. `label` names the artifact in the error raised when the destination cannot be created. commentlint: allow(JUDGE) */
export function writeJsonAtomically(
    destination: string,
    value: unknown,
    label: string,
): void {
    const parent = dirname(destination);
    mkdirSync(parent, { recursive: true });
    reclaimOrphanedStaging(parent);
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
