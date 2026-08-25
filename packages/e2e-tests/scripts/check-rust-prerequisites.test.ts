import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRustPrerequisites } from "./check-rust-prerequisites";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0))
        rmSync(root, { recursive: true, force: true });
});

function fakeWorkspace(withFixture = true): { root: string; bin: string } {
    const parent = mkdtempSync(join(tmpdir(), "mc-rust-prereq-"));
    temporaryRoots.push(parent);
    const root = join(parent, "repo");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\nmembers = []\n");
    const metadata = JSON.stringify({
        packages: [
            {
                name: "mc-module",
                targets: withFixture
                    ? [{ name: "direct_host_fixture", kind: ["example"] }]
                    : [],
            },
        ],
    });
    const cargo = join(bin, "cargo");
    writeFileSync(cargo, `#!/bin/sh\nprintf '%s\\n' '${metadata}'\n`);
    chmodSync(cargo, 0o755);
    return { root, bin };
}

describe("Rust direct-host prerequisite detector", () => {
    it("ignores absent sibling workspaces and removed binaries", () => {
        const { root, bin } = fakeWorkspace();
        const removedBinary = join(root, "target", "release", ["ck", "mc"].join("-"));
        const siblingDaemon = join(root, "..", "subconscious");
        expect(existsSync(removedBinary)).toBe(false);
        expect(existsSync(siblingDaemon)).toBe(false);

        const result = detectRustPrerequisites({
            repoRoot: root,
            env: { PATH: bin },
        });

        expect(result).toEqual({ ok: true, missing: [] });
    });

    it("rejects a workspace without the direct host fixture target", () => {
        const { root, bin } = fakeWorkspace(false);
        const result = detectRustPrerequisites({
            repoRoot: root,
            env: { PATH: bin },
        });
        expect(result.ok).toBe(false);
        expect(result.missing).toContain(
            "cargo workspace: direct_host_fixture example is unavailable",
        );
    });
});
