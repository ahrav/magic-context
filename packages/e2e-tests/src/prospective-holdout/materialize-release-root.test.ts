import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeReleaseRoot } from "./materialize-release-root";
import { releaseRootFixture } from "./test-fixtures";

function makeDirectoriesWritable(root: string): void {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) makeDirectoriesWritable(join(root, entry.name));
    }
    chmodSync(root, 0o700);
}

describe("release root materialization", () => {
    it("copies verified promoted bytes once into a writable temporary parent", () => {
        const promoted = mkdtempSync(join(tmpdir(), "holdout-promoted-"));
        const parent = mkdtempSync(join(tmpdir(), "holdout-materialized-"));
        const active = mkdtempSync(join(tmpdir(), "holdout-active-"));
        try {
            const manifest = releaseRootFixture(promoted);
            const destination = join(parent, "v2");
            const publicationLock = join(parent, ".v2.publish-lock");
            mkdirSync(publicationLock);
            expect(() => materializeReleaseRoot({
                promotedRoot: promoted,
                destination,
                manifest,
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            })).toThrow(/publication-busy/);
            expect(existsSync(destination)).toBe(false);
            rmSync(publicationLock, { recursive: true });

            const interruptedStaging = join(parent, ".v2.staging-interrupted");
            mkdirSync(interruptedStaging);
            writeFileSync(join(interruptedStaging, "partial"), "partial");
            const materialized = materializeReleaseRoot({
                promotedRoot: promoted,
                destination,
                manifest,
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            expect(materialized.root).toBe(destination);
            expect(lstatSync(join(destination, manifest.entrypoints.rustHost)).mode & 0o111).toBe(0o111);
            expect(lstatSync(join(destination, manifest.entrypoints.databaseTemplate)).mode & 0o222).toBe(0);
            expect(() => materializeReleaseRoot({
                promotedRoot: promoted,
                destination,
                manifest,
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            })).toThrow(/destination-exists/);
        } finally {
            rmSync(promoted, { recursive: true, force: true });
            makeDirectoriesWritable(parent);
            rmSync(parent, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    });
});
