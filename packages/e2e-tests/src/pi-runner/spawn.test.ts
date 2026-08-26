import { describe, expect, it } from "bun:test";
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseRoot } from "../prospective-holdout/release-root";
import { releaseRootFixture } from "../prospective-holdout/test-fixtures";
import { createPiIsolatedEnv, ensurePluginAvailable } from "./spawn";

describe("Pi release root selection", () => {
    it("links selected plugin bytes without changing default option shape", () => {
        const release = mkdtempSync(join(tmpdir(), "pi-release-root-"));
        const active = mkdtempSync(join(tmpdir(), "pi-active-root-"));
        const env = createPiIsolatedEnv();
        try {
            const manifest = releaseRootFixture(release);
            const verified = verifyReleaseRoot(release, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            ensurePluginAvailable(env, verified);
            expect(lstatSync(env.pluginDir).isSymbolicLink()).toBe(true);
            expect(readlinkSync(env.pluginDir)).toBe(join(release, "packages/pi-plugin/dist/index.js"));
        } finally {
            rmSync(release, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
            rmSync(env.baseDir, { recursive: true, force: true });
        }
    });
});
