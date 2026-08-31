#!/usr/bin/env bun
/**
 * Run-mode membership comes from the manifest; refreezing preserves
 * membership while rewriting fingerprints and digests.
 */
import { lstatSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { currentManifest } from "../src/paired-delta/registry";

const destination = resolve(import.meta.dir, "../pools/paired-delta-manifest.json");
const staging = `${destination}.tmp`;
/** lstat, not existsSync: writeFileSync would follow a symlink here and overwrite its target, then renameSync would publish the link. commentlint: allow(JUDGE) */
const occupant = lstatSync(staging, { throwIfNoEntry: false });
if (occupant !== undefined) {
    if (!occupant.isFile() && !occupant.isSymbolicLink()) {
        throw new Error(`manifest staging path is not a regular file: ${staging}`);
    }
    rmSync(staging, { force: true });
}
try {
    writeFileSync(staging, `${JSON.stringify(currentManifest(), null, 2)}\n`, { flag: "wx" });
    renameSync(staging, destination);
} catch (error) {
    rmSync(staging, { force: true });
    throw error;
}
console.log(`wrote ${destination}`);
