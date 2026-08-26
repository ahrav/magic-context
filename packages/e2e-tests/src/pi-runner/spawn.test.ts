import { describe, expect, it } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseRoot } from "../prospective-holdout/release-root";
import { releaseRootFixture } from "../prospective-holdout/test-fixtures";
import { createPiIsolatedEnv, ensurePluginAvailable } from "./spawn";

describe("Pi release root selection", () => {
    it("links selected plugin bytes without changing default option shape", () => {
        const release = realpathSync(mkdtempSync(join(tmpdir(), "pi-release-root-")));
        const active = mkdtempSync(join(tmpdir(), "pi-active-root-"));
        const env = createPiIsolatedEnv();
        try {
            const manifest = releaseRootFixture(release);
            const verified = verifyReleaseRoot(release, manifest, {
                expectedRootFingerprint: manifest.rootFingerprint,
                activeCheckout: active,
            });
            ensurePluginAvailable(env, verified);
            // Pi loads an extension through the `package.json` inside each configured
            // package, so the entry has to be a directory whose manifest names the link
            // to the release root's frozen entrypoint.
            expect(lstatSync(env.pluginDir).isDirectory()).toBe(true);
            expect(readlinkSync(join(env.pluginDir, "index.js"))).toBe(
                join(release, "packages/pi-plugin/dist/index.js"),
            );
            const manifestPath = join(env.pluginDir, "package.json");
            expect(JSON.parse(readFileSync(manifestPath, "utf8")).pi).toEqual({
                extensions: ["./index.js"],
            });
            expect(readFileSync(join(env.pluginDir, "index.js"), "utf8")).toBe("pi");
        } finally {
            rmSync(release, { recursive: true, force: true });
            rmSync(active, { recursive: true, force: true });
            rmSync(env.baseDir, { recursive: true, force: true });
        }
    });
});
