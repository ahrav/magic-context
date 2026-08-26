import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDistinctReleaseRoots, verifyReleaseRoot } from "./release-root";
import { releaseRootFixture } from "./test-fixtures";

describe("release root verification", () => {
    it("verifies immutable file and group digests outside active checkout", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-root-"));
        const active = mkdtempSync(join(tmpdir(), "holdout-active-"));
        try {
            const manifest = releaseRootFixture(root);
            const verified = verifyReleaseRoot(root, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            expect(verified.manifest.entrypoints.rustHost).toBe("bin/mc-host");
            writeFileSync(join(root, "bun.lock"), "drift");
            expect(() => verifyReleaseRoot(root, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            })).toThrow(/byte-mismatch/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    });

    it("rejects distinct paths containing identical file digest sets", () => {
        const leftRoot = mkdtempSync(join(tmpdir(), "holdout-left-root-"));
        const rightRoot = mkdtempSync(join(tmpdir(), "holdout-right-root-"));
        const active = mkdtempSync(join(tmpdir(), "holdout-active-"));
        try {
            const leftManifest = releaseRootFixture(leftRoot);
            const rightManifest = releaseRootFixture(rightRoot);
            const left = verifyReleaseRoot(leftRoot, leftManifest, {
                expectedRootFingerprint: leftManifest.rootFingerprint,
                activeCheckout: active,
            });
            const right = verifyReleaseRoot(rightRoot, rightManifest, {
                expectedRootFingerprint: rightManifest.rootFingerprint,
                activeCheckout: active,
            });
            expect(() => assertDistinctReleaseRoots(left, right)).toThrow(/identical-file-digests/);
        } finally {
            rmSync(leftRoot, { recursive: true, force: true });
            rmSync(rightRoot, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    });

    it("rejects active-checkout roots and symlinks", () => {
        const root = mkdtempSync(join(tmpdir(), "holdout-root-"));
        const active = mkdtempSync(join(tmpdir(), "holdout-active-"));
        try {
            const manifest = releaseRootFixture(root);
            expect(() => verifyReleaseRoot(root, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: root,
            })).toThrow(/active-checkout-forbidden/);
            rmSync(join(root, "bun.lock"));
            symlinkSync(join(root, "src/revision.txt"), join(root, "bun.lock"));
            expect(() => verifyReleaseRoot(root, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            })).toThrow(/symlink-rejected/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
        }
    });
});
