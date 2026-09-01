import { afterEach, describe, expect, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    isLinkedGitWorktree,
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
} from "./project-identity";

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "mc-identity-"));
}

function returningRootCommit(rootCommit: string): typeof execFileSync {
    return (() => `${rootCommit}\n`) as typeof execFileSync;
}

afterEach(() => {
    __resetProjectIdentityForTests();
});

describe("linked Git worktree detection", () => {
    test("compares the per-checkout git dir with the shared common dir once per directory", () => {
        const calls: string[] = [];
        __setProjectIdentityTestHooks({
            execFileSync: ((command: string, args: string[], options: { cwd?: string }) => {
                expect(command).toBe("git");
                expect(args).toEqual([
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-dir",
                    "--git-common-dir",
                ]);
                const directory = String(options.cwd);
                calls.push(directory);
                return directory.endsWith("linked")
                    ? "/repo/.git/worktrees/linked\n/repo/.git\n"
                    : "/repo/.git\n/repo/.git\n";
            }) as unknown as typeof execFileSync,
        });

        expect(isLinkedGitWorktree("/repo/primary")).toBe(false);
        expect(isLinkedGitWorktree("/repo/linked")).toBe(true);
        expect(isLinkedGitWorktree("/repo/linked")).toBe(true);
        expect(calls).toEqual(["/repo/primary", "/repo/linked"]);
    });
});

describe("resolveProjectIdentity directory fallback", () => {
    test("refuses the exact canonical home directory unless the user opts in", () => {
        expect(resolveProjectIdentityForSession(homedir())).toBeUndefined();
        expect(resolveProjectIdentityForSession(join(homedir(), "a-project"))).not.toBeUndefined();
    });

    test("uses the canonical home directory's stable dir identity when opted in", () => {
        const canonicalHome = realpathSync.native(homedir());
        const expected = `dir:${createHash("md5").update(canonicalHome, "utf8").digest("hex").slice(0, 12)}`;

        expect(resolveProjectIdentityForSession(homedir(), true)).toBe(expected);
    });

    test("resolves a project identity when sandbox policy denies realpath for the home directory", () => {
        const project = tempDir();
        const deniedHome = tempDir();
        const originalNative = realpathSync.native;
        const permissionDenied = (): NodeJS.ErrnoException => {
            const error = new Error("sandbox denied realpath") as NodeJS.ErrnoException;
            error.code = "EPERM";
            return error;
        };
        __setProjectIdentityTestHooks({ homeDirectory: () => deniedHome });
        Object.defineProperty(realpathSync, "native", {
            configurable: true,
            value: (() => {
                throw permissionDenied();
            }) as typeof realpathSync.native,
        });

        try {
            const expected = `dir:${createHash("md5")
                .update(project, "utf8")
                .digest("hex")
                .slice(0, 12)}`;
            expect(resolveProjectIdentityForSession(project)).toBe(expected);
        } finally {
            Object.defineProperty(realpathSync, "native", {
                configurable: true,
                value: originalNative,
            });
            rmSync(project, { recursive: true, force: true });
            rmSync(deniedHome, { recursive: true, force: true });
        }
    });

    test("keeps a contained repository distinct from the home identity", () => {
        const contained = mkdtempSync(join(homedir(), "mc-home-identity-"));
        try {
            mkdirSync(join(contained, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });
            const homeIdentity = resolveProjectIdentityForSession(homedir(), true);
            const containedIdentity = resolveProjectIdentityForSession(contained, true);

            expect(homeIdentity).toBeDefined();
            expect(containedIdentity).toBe("git:abc1234");
            expect(containedIdentity).not.toBe(homeIdentity);
        } finally {
            rmSync(contained, { recursive: true, force: true });
        }
    });

    test("requires home opt-in when a child inherits the home git repository", () => {
        const fakeHome = tempDir();
        const child = join(fakeHome, "nested", "project");
        try {
            mkdirSync(join(fakeHome, ".git"));
            mkdirSync(child, { recursive: true });
            __setProjectIdentityTestHooks({
                execFileSync: returningRootCommit("def5678"),
                homeDirectory: () => fakeHome,
            });
            const expectedHomeIdentity = `dir:${createHash("md5")
                .update(realpathSync.native(fakeHome), "utf8")
                .digest("hex")
                .slice(0, 12)}`;

            expect(resolveProjectIdentityForSession(fakeHome)).toBeUndefined();
            expect(resolveProjectIdentityForSession(child)).toBeUndefined();
            expect(resolveProjectIdentityForSession(fakeHome, true)).toBe(expectedHomeIdentity);
            expect(resolveProjectIdentityForSession(child, true)).toBe(expectedHomeIdentity);
        } finally {
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });
    test("flips dir: fallback to git: once a repo gains its first commit (no stale cache)", () => {
        const dir = tempDir();
        try {
            const first = resolveProjectIdentity(dir);
            expect(first).toMatch(/^dir:[0-9a-f]{12}$/);
            expect(resolveProjectIdentity(dir)).toBe(first);

            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("abc1234") });

            const second = resolveProjectIdentity(dir);
            expect(second).toBe("git:abc1234");
            expect(second).not.toBe(first);
            expect(resolveProjectIdentity(dir)).toBe(second);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("derives a deterministic identity from grafted-history repos (multiple root commits)", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            // Git may return multiple root commits after unrelated histories are merged.
            // Git may enumerate those root commits in different orders.
            // resolveProjectIdentity selects the lexicographically smallest root commit rather than the first result.
            __setProjectIdentityTestHooks({
                execFileSync: (() => "7e96b9e\n1e394c2\n4058752\n") as typeof execFileSync,
            });
            expect(resolveProjectIdentity(dir)).toBe("git:1e394c2");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("reuses a parent repository identity for subdirectory transient git failures", () => {
        const dir = tempDir();
        try {
            mkdirSync(join(dir, ".git"));
            __setProjectIdentityTestHooks({ execFileSync: returningRootCommit("def5678") });
            const parentIdentity = resolveProjectIdentity(dir);
            const subdir = join(dir, "nested", "child");
            mkdirSync(subdir, { recursive: true });

            __setProjectIdentityTestHooks({
                execFileSync: (() => {
                    throw new Error("temporary git failure");
                }) as typeof execFileSync,
            });

            expect(resolveProjectIdentity(subdir)).toBe(parentIdentity);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
