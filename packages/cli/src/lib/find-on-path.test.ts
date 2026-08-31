import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findOnPath } from "./find-on-path";

/**
 * Tests use a staged PATH to avoid host-dependent results.
 *
 */
describe("findOnPath", () => {
    let originalPath: string | undefined;
    let tempRoot: string;
    const isWindows = process.platform === "win32";

    beforeEach(() => {
        originalPath = process.env.PATH;
        tempRoot = join(
            tmpdir(),
            `find-on-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        mkdirSync(tempRoot, { recursive: true });
    });

    afterEach(() => {
        if (originalPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = originalPath;
        }
        try {
            rmSync(tempRoot, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    function makeExecutable(dir: string, name: string): string {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, isWindows ? "@echo off\n" : "#!/bin/sh\necho hi\n");
        if (!isWindows) chmodSync(path, 0o755);
        return path;
    }

    function makeNonExecutable(dir: string, name: string): string {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, name);
        writeFileSync(path, "not executable\n");
        if (!isWindows) chmodSync(path, 0o644);
        return path;
    }

    it("returns null when PATH is unset", () => {
        delete process.env.PATH;
        expect(findOnPath("opencode")).toBeNull();
    });

    it("returns null when PATH is empty", () => {
        process.env.PATH = "";
        expect(findOnPath("opencode")).toBeNull();
    });

    it("returns null when binary is nowhere on PATH", () => {
        const dir = join(tempRoot, "empty-bin");
        mkdirSync(dir, { recursive: true });
        process.env.PATH = dir;
        expect(findOnPath("nonexistent-binary-xyzzy")).toBeNull();
    });

    it("finds an executable in a single-entry PATH (POSIX/Windows)", () => {
        const dir = join(tempRoot, "bin");
        const binName = isWindows ? "opencode.exe" : "opencode";
        const expected = makeExecutable(dir, binName);
        process.env.PATH = dir;

        const found = findOnPath("opencode");
        expect(found).toBe(expected);
    });

    it("returns the first match when binary exists in multiple PATH dirs", () => {
        const dir1 = join(tempRoot, "first");
        const dir2 = join(tempRoot, "second");
        const binName = isWindows ? "opencode.exe" : "opencode";
        const firstPath = makeExecutable(dir1, binName);
        makeExecutable(dir2, binName);
        process.env.PATH = `${dir1}${delimiter}${dir2}`;

        const found = findOnPath("opencode");
        expect(found).toBe(firstPath);
    });

    it("skips empty PATH segments without error", () => {
        const dir = join(tempRoot, "bin");
        const binName = isWindows ? "opencode.exe" : "opencode";
        const expected = makeExecutable(dir, binName);
        process.env.PATH = `${delimiter}${dir}${delimiter}${delimiter}`;

        const found = findOnPath("opencode");
        expect(found).toBe(expected);
    });

    it.if(!isWindows)("returns null for non-executable files on POSIX", () => {
        const dir = join(tempRoot, "bin");
        makeNonExecutable(dir, "opencode");
        process.env.PATH = dir;
        expect(findOnPath("opencode")).toBeNull();
    });

    it.if(!isWindows)("follows symlinks to a real executable on POSIX", () => {
        const dir1 = join(tempRoot, "real");
        const dir2 = join(tempRoot, "link");
        const realPath = makeExecutable(dir1, "opencode");
        mkdirSync(dir2, { recursive: true });
        const linkPath = join(dir2, "opencode");
        symlinkSync(realPath, linkPath);
        process.env.PATH = dir2;

        const found = findOnPath("opencode");
        expect(found).toBe(linkPath);
    });

    it.if(!isWindows)("ignores broken symlinks on POSIX", () => {
        const dir = join(tempRoot, "broken");
        mkdirSync(dir, { recursive: true });
        const brokenLink = join(dir, "opencode");
        symlinkSync(join(tempRoot, "does-not-exist"), brokenLink);
        process.env.PATH = dir;

        expect(findOnPath("opencode")).toBeNull();
    });

    it.if(!isWindows)("recognizes wrapper scripts (regression for issue #75)", () => {
        // Executable wrapper scripts are valid PATH matches.
        // Executable wrapper scripts are valid PATH matches.
        const wrapperDir = join(tempRoot, "home-bin");
        mkdirSync(wrapperDir, { recursive: true });
        const wrapperPath = join(wrapperDir, "opencode");
        writeFileSync(
            wrapperPath,
            '#!/bin/sh\n# Wrapper that does mise env setup, then execs real opencode\nexec /usr/bin/opencode "$@"\n',
        );
        chmodSync(wrapperPath, 0o755);
        process.env.PATH = wrapperDir;

        const found = findOnPath("opencode");
        expect(found).toBe(wrapperPath);
    });

    it.if(!isWindows)("does not match directories named like the binary", () => {
        // Directories named `opencode` are not executable candidates.
        const dir = join(tempRoot, "bin");
        mkdirSync(join(dir, "opencode"), { recursive: true });
        process.env.PATH = dir;
        expect(findOnPath("opencode")).toBeNull();
    });

    it.if(isWindows)("tries .exe, .cmd, .bat, .com extensions on Windows", () => {
        const dir = join(tempRoot, "bin");
        const cmdPath = makeExecutable(dir, "opencode.cmd");
        process.env.PATH = dir;

        const found = findOnPath("opencode");
        expect(found).toBe(cmdPath);
    });

    it.if(isWindows)("prefers .exe over .cmd when both exist", () => {
        const dir = join(tempRoot, "bin");
        const exePath = makeExecutable(dir, "opencode.exe");
        makeExecutable(dir, "opencode.cmd");
        process.env.PATH = dir;

        const found = findOnPath("opencode");
        expect(found).toBe(exePath);
    });
});
