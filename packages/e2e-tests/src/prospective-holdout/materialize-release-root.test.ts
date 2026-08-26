import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HoldoutContractError } from "./contract";
import { LOCK_LEASE_MS, LOCK_OWNER_FILE } from "./lock";
import { materializeReleaseRoot } from "./materialize-release-root";
import { deadPid, releaseRootFixture } from "./test-fixtures";

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
            expect(existsSync(join(parent, ".v2.publish-lock"))).toBe(false);
            // A worker killed after the rename installed this root retries with the same
            // inputs, so the retry must complete rather than report a conflict it cannot
            // distinguish from one. It leaves no staging directory behind and releases the
            // lock, which is what proves the accept-existing path runs inside the wrapper.
            const stagingBefore = readdirSync(parent).filter((entry) => entry.startsWith(".v2.staging-")).sort();
            const retried = materializeReleaseRoot({
                promotedRoot: promoted,
                destination,
                manifest,
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            expect(retried.root).toBe(destination);
            expect(retried.observedRootFingerprint).toBe(materialized.observedRootFingerprint);
            // The accepted retry leaves its own staging directory behind no more than a
            // completed publication does.
            expect(readdirSync(parent).filter((entry) => entry.startsWith(".v2.staging-")).sort())
                .toEqual(stagingBefore);
            expect(existsSync(join(parent, ".v2.publish-lock"))).toBe(false);
            // Bytes that are not this root are the case existence alone could not tell
            // apart, and the lock wraps that rejection too, so its diagnostic surviving
            // the wrapper unchanged proves the wrapper still releases on that path.
            const conflicting = mkdtempSync(join(tmpdir(), "holdout-conflicting-"));
            const conflictingDestination = join(parent, "v3");
            let rejected: unknown;
            try {
                const other = releaseRootFixture(conflicting, {
                    releaseId: "rel-conflicting",
                    sourceBytes: "conflicting-source",
                });
                materializeReleaseRoot({
                    promotedRoot: conflicting,
                    destination: conflictingDestination,
                    manifest: other,
                    expectedRootFingerprint: other.rootFingerprint,
                    activeCheckout: active,
                });
                materializeReleaseRoot({
                    promotedRoot: promoted,
                    destination: conflictingDestination,
                    manifest,
                    expectedRootFingerprint: manifest.rootFingerprint,
                    activeCheckout: active,
                });
            } catch (error) {
                rejected = error;
            } finally {
                rmSync(conflicting, { recursive: true, force: true });
            }
            expect(rejected).toBeInstanceOf(HoldoutContractError);
            expect((rejected as HoldoutContractError).diagnostics).toEqual([
                "release-root-materialize: destination-conflict",
            ]);
            expect(existsSync(join(parent, ".v3.publish-lock"))).toBe(false);
        } finally {
            rmSync(promoted, { recursive: true, force: true });
            makeDirectoriesWritable(parent);
            rmSync(parent, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    });
});


function seedPublicationLock(
    parent: string,
    destinationName: string,
    owner: { pid: number; nonce: string; acquiredAt: number },
): string {
    const lock = join(parent, `.${destinationName}.publish-lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
    return lock;
}

describe("release root publication lock", () => {
    it("recovers a publication lock whose recorded holder is dead and whose lease expired", () => {
        const pid = deadPid();
        if (pid === null) return;
        const promoted = mkdtempSync(join(tmpdir(), "holdout-promoted-"));
        const parent = mkdtempSync(join(tmpdir(), "holdout-materialized-"));
        const active = mkdtempSync(join(tmpdir(), "holdout-active-"));
        try {
            const manifest = releaseRootFixture(promoted);
            const destination = join(parent, "v2");
            const lock = seedPublicationLock(parent, "v2", {
                pid,
                nonce: "abandoned-worker",
                acquiredAt: Date.now() - LOCK_LEASE_MS * 10,
            });
            const materialized = materializeReleaseRoot({
                promotedRoot: promoted,
                destination,
                manifest,
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            expect(materialized.root).toBe(destination);
            expect(existsSync(lock)).toBe(false);
        } finally {
            rmSync(promoted, { recursive: true, force: true });
            makeDirectoriesWritable(parent);
            rmSync(parent, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    });

    it("reports publication-busy while the recorded holder is live inside its lease", () => {
        const promoted = mkdtempSync(join(tmpdir(), "holdout-promoted-"));
        const parent = mkdtempSync(join(tmpdir(), "holdout-materialized-"));
        const active = mkdtempSync(join(tmpdir(), "holdout-active-"));
        try {
            const manifest = releaseRootFixture(promoted);
            const destination = join(parent, "v2");
            const lock = seedPublicationLock(parent, "v2", {
                pid: process.pid,
                nonce: "live-holder",
                acquiredAt: Date.now(),
            });
            expect(() => materializeReleaseRoot({
                promotedRoot: promoted,
                destination,
                manifest,
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            })).toThrow(/release-root-materialize: publication-busy/);
            expect(existsSync(lock)).toBe(true);
            expect(existsSync(destination)).toBe(false);
        } finally {
            rmSync(promoted, { recursive: true, force: true });
            makeDirectoriesWritable(parent);
            rmSync(parent, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    }, 20_000);
});
