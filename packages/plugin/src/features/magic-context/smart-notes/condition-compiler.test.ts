import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    type ConditionCompilerOptions,
    compileSurfaceCondition,
    conditionCompileStorageFields,
} from "./condition-compiler";

const temporaryDirectories: string[] = [];

function pureOptions(overrides: Partial<ConditionCompilerOptions> = {}): ConditionCompilerOptions {
    return {
        projectPath: "/workspace/repo",
        now: () => 1_786_320_000_000,
        resolvePath: async (path) => ({
            path: path.startsWith("/") ? path : resolve("/workspace/repo", path),
            exists: !path.includes("future"),
        }),
        ...overrides,
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("surface-condition compiler", () => {
    test.each([
        [
            "when file /tmp/state contains READY",
            { kind: "file_contains", path: "/tmp/state", needle: "READY" },
        ],
        [
            "when file '/tmp/state file' no longer contains 'not ready'",
            {
                kind: "file_contains",
                path: "/tmp/state file",
                needle: "not ready",
                absent: true,
            },
        ],
        ["when path /tmp/result exists", { kind: "path_exists", path: "/tmp/result" }],
        ["when /tmp/result is gone", { kind: "path_exists", path: "/tmp/result", gone: true }],
        [
            "when file /tmp/output changes",
            {
                kind: "mtime_after",
                path: "/tmp/output",
                since_ms: 1_786_320_000_000,
            },
        ],
        [
            "when /tmp/output is rebuilt",
            {
                kind: "mtime_after",
                path: "/tmp/output",
                since_ms: 1_786_320_000_000,
            },
        ],
        [
            "when /tmp/output mtime moves",
            {
                kind: "mtime_after",
                path: "/tmp/output",
                since_ms: 1_786_320_000_000,
            },
        ],
        [
            "when repo /workspace/repo has a commit after abcdef1",
            {
                kind: "git_commit_after",
                repo_path: "/workspace/repo",
                sha: "abcdef1",
            },
        ],
        [
            "when /workspace/repo has a commit newer than 0123456789abcdef",
            {
                kind: "git_commit_after",
                repo_path: "/workspace/repo",
                sha: "0123456789abcdef",
            },
        ],
        [
            "when a tag matching 'v2.*' appears",
            {
                kind: "git_tag_matching",
                repo_path: "/workspace/repo",
                pattern: "v2.*",
            },
        ],
        [
            "when a tag above semver 2.1.0 appears",
            {
                kind: "git_tag_matching",
                repo_path: "/workspace/repo",
                pattern: "*",
                above: "2.1.0",
            },
        ],
        [
            "when a tag matching v3.* above semver 3.0.0 appears in repo /workspace/other",
            {
                kind: "git_tag_matching",
                repo_path: "/workspace/other",
                pattern: "v3.*",
                above: "3.0.0",
            },
        ],
    ])("compiles %s", async (condition, expected) => {
        const result = await compileSurfaceCondition(condition, pureOptions());
        expect(result.status).toBe("compiled");
        if (result.status === "compiled") {
            expect(result.provider).toBe("local-fs");
            expect(result.config).toEqual(expected);
            expect(result.compiledAt).toBe(1_786_320_000_000);
        }
    });

    test.each([
        "when file /tmp/state includes READY",
        "when /tmp/result becomes available",
        "when /tmp/output changed",
        "when /workspace/repo gets a commit after abcdef1",
        "when release v2.0.0 appears",
        "when file /tmp/state stops containing READY",
        "either when path /a exists and path /b exists",
    ])("leaves near-miss prose plain: %s", async (condition) => {
        await expect(compileSurfaceCondition(condition, pureOptions())).resolves.toEqual({
            status: "plain",
        });
    });

    test.each([
        ["when file /tmp/state contains no ERROR", "ambiguous negation"],
        ["when file /tmp/state contains ERROR since yesterday", "temporal suffix"],
        ['when path "/tmp/result exists', "unbalanced quote"],
    ])("leaves unsafe grammar plain with a reason: %s", async (condition, reason) => {
        const result = await compileSurfaceCondition(condition, pureOptions());
        expect(result).toEqual({
            status: "plain",
            reason: expect.stringContaining(reason),
        });
        if (result.status === "plain") {
            expect(result.reason).not.toContain("\n");
        }
    });

    test("compiles up to four OR clauses without splitting quoted needles", async () => {
        const result = await compileSurfaceCondition(
            'either when file /a contains "red or blue" or path /b is gone or /c changes or a tag matching v* appears',
            pureOptions(),
        );

        expect(result.status).toBe("compiled");
        if (result.status === "compiled") {
            expect(result.config).toEqual({
                any: [
                    { kind: "file_contains", path: "/a", needle: "red or blue" },
                    { kind: "path_exists", path: "/b", gone: true },
                    {
                        kind: "mtime_after",
                        path: "/c",
                        since_ms: 1_786_320_000_000,
                    },
                    {
                        kind: "git_tag_matching",
                        repo_path: "/workspace/repo",
                        pattern: "v*",
                    },
                ],
            });
        }
    });

    test("resolves relative paths and records the migrator audit marker", async () => {
        const result = await compileSurfaceCondition(
            "when path build/existing.json exists",
            pureOptions(),
        );

        expect(result.status).toBe("compiled");
        if (result.status === "compiled") {
            expect(result.config).toEqual({
                kind: "path_exists",
                path: "/workspace/repo/build/existing.json",
                resolved_path_exists: false,
            });
            expect(conditionCompileStorageFields(result)).toEqual({
                compiledProvider: "local-fs",
                compiledConfig:
                    '{"kind":"path_exists","path":"/workspace/repo/build/existing.json","resolved_path_exists":false}',
                compiledAt: 1_786_320_000_000,
                compileStatus: "compiled",
            });
        }
    });

    test("refuses a provider-fenced path while preserving the authoring operation", async () => {
        const home = mkdtempSync(join(tmpdir(), "condition-compiler-home-"));
        temporaryDirectories.push(home);
        const previousDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = join(home, ".local", "share");
        try {
            const result = await compileSurfaceCondition(
                "when path ~/.local/share/cortexkit/plexus/store.db exists",
                {
                    projectPath: home,
                    homeDirectory: home,
                    now: () => 123,
                },
            );

            expect(result).toEqual({ status: "refused", reason: "fenced path" });
            expect(conditionCompileStorageFields(result)).toEqual({
                compiledProvider: null,
                compiledConfig: null,
                compiledAt: null,
                compileStatus: "refused",
            });
        } finally {
            if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousDataHome;
        }
    });

    test("turns provider schema validation failures into refused compilation", async () => {
        const result = await compileSurfaceCondition(
            "when a tag above semver definitely-not-semver appears",
            pureOptions(),
        );

        expect(result.status).toBe("refused");
        if (result.status === "refused") {
            expect(result.reason).toContain("provider schema");
            expect(result.reason).toContain("semantic version");
        }
    });

    test("refuses an OR config beyond the provider's four-predicate schema", async () => {
        const result = await compileSurfaceCondition(
            "either /a exists or /b exists or /c exists or /d exists or /e exists",
            pureOptions(),
        );

        expect(result.status).toBe("refused");
        if (result.status === "refused") {
            expect(result.reason).toContain("between 1 and 4 predicates");
        }
    });
});
