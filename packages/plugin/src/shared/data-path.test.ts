import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    ensureCortexKitArtifactGitignore,
    getCacheDir,
    getDataDir,
    getLegacyOpenCodeMagicContextStorageDir,
    getMagicContextLogPath,
    getMagicContextStorageDir,
    getOpenCodeCacheDir,
    getOpenCodeStorageDir,
    getProjectMagicContextDir,
    getProjectMagicContextHistorianDir,
} from "./data-path";

const savedEnv = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
    MAGIC_CONTEXT_TEST_DATA_DIR: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
};

describe("data-path", () => {
    beforeEach(() => {
        process.env.XDG_CACHE_HOME = undefined;
        process.env.XDG_DATA_HOME = undefined;
        process.env.LOCALAPPDATA = undefined;
        process.env.MAGIC_CONTEXT_LOG_PATH = undefined;
        // Bun requires deleting an environment key to unset it.
        delete process.env.XDG_CACHE_HOME;
        delete process.env.XDG_DATA_HOME;
        delete process.env.LOCALAPPDATA;
        delete process.env.MAGIC_CONTEXT_LOG_PATH;
    });

    afterEach(() => {
        // afterEach restores or deletes every environment variable this suite touches so unset NODE_ENV and MAGIC_CONTEXT_TEST_DATA_DIR cannot leak into subsequent tests.
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value !== undefined) process.env[key] = value;
            else delete process.env[key];
        }
    });

    test("getCacheDir falls back to <homedir>/.cache when XDG_CACHE_HOME is unset (all platforms)", () => {
        // OpenCode's xdg-basedir uses this fallback on every platform.
        expect(getCacheDir()).toBe(path.join(os.homedir(), ".cache"));
    });

    test("getCacheDir honors XDG_CACHE_HOME when set", () => {
        process.env.XDG_CACHE_HOME = "/tmp/custom-cache";
        expect(getCacheDir()).toBe("/tmp/custom-cache");
    });

    test("getCacheDir ignores LOCALAPPDATA on Windows (must match OpenCode's xdg-basedir)", () => {
        // OpenCode's xdg-basedir ignores LOCALAPPDATA when resolving the Windows cache directory.
        process.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local";
        expect(getCacheDir()).toBe(path.join(os.homedir(), ".cache"));
    });

    test("getOpenCodeCacheDir appends 'opencode' to the cache base", () => {
        expect(getOpenCodeCacheDir()).toBe(path.join(os.homedir(), ".cache", "opencode"));
    });

    test("getOpenCodeCacheDir with XDG_CACHE_HOME set", () => {
        process.env.XDG_CACHE_HOME = "/tmp/custom-cache";
        expect(getOpenCodeCacheDir()).toBe(path.join("/tmp/custom-cache", "opencode"));
    });

    test("getDataDir falls back to <homedir>/.local/share when XDG_DATA_HOME is unset", () => {
        expect(getDataDir()).toBe(path.join(os.homedir(), ".local", "share"));
    });

    test("getOpenCodeStorageDir composes correctly", () => {
        expect(getOpenCodeStorageDir()).toBe(
            path.join(os.homedir(), ".local", "share", "opencode", "storage"),
        );
    });

    test("getMagicContextStorageDir uses cortexkit/magic-context layout", () => {
        // Deleting MAGIC_CONTEXT_TEST_DATA_DIR and NODE_ENV makes this assertion exercise the production path.
        const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        const savedNodeEnv = process.env.NODE_ENV;
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        delete process.env.NODE_ENV;
        try {
            expect(getMagicContextStorageDir()).toBe(
                path.join(os.homedir(), ".local", "share", "cortexkit", "magic-context"),
            );
        } finally {
            if (savedTestDir !== undefined) process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
        }
    });

    test("getMagicContextStorageDir backstops to a temp dir under NODE_ENV=test with no guard set", () => {
        const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        process.env.NODE_ENV = "test";
        try {
            const resolved = getMagicContextStorageDir();
            expect(resolved).not.toContain(path.join(os.homedir(), ".local", "share"));
            expect(resolved.endsWith(path.join("cortexkit", "magic-context"))).toBe(true);
            expect(getMagicContextStorageDir()).toBe(resolved);
        } finally {
            if (savedTestDir !== undefined) process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
        }
    });

    test("getMagicContextStorageDir honors MAGIC_CONTEXT_TEST_DATA_DIR when XDG_DATA_HOME is unset", () => {
        // When XDG_DATA_HOME is unset, test fallbacks must not resolve to shared storage.
        // CLI doctors must not run integrity checks against production data.
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = "/tmp/mc-test-isolation";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/mc-test-isolation", "cortexkit", "magic-context"),
        );
    });

    test("getMagicContextStorageDir prefers XDG_DATA_HOME over MAGIC_CONTEXT_TEST_DATA_DIR", () => {
        // MAGIC_CONTEXT_TEST_DATA_DIR isolates the data homes required by several suites.
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = "/tmp/mc-test-isolation";
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/custom-data", "cortexkit", "magic-context"),
        );
    });

    test("getMagicContextStorageDir honors XDG_DATA_HOME", () => {
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/custom-data", "cortexkit", "magic-context"),
        );
    });

    test("getLegacyOpenCodeMagicContextStorageDir points at the pre-cortexkit OpenCode path", () => {
        // The legacy data path must remain stable so upgrades can migrate pre-shared-storage data.
        expect(getLegacyOpenCodeMagicContextStorageDir()).toBe(
            path.join(
                os.homedir(),
                ".local",
                "share",
                "opencode",
                "storage",
                "plugin",
                "magic-context",
            ),
        );
    });

    test("legacy storage dir distinct from new shared dir even with same XDG override", () => {
        // Even when XDG_DATA_HOME points to the same location, the resolvers must return different paths to prevent migration from overwriting its source.
        // self-overwrite.
        process.env.XDG_DATA_HOME = "/tmp/test-xdg";
        const legacy = getLegacyOpenCodeMagicContextStorageDir();
        const shared = getMagicContextStorageDir();
        expect(legacy).not.toBe(shared);
        expect(legacy).toContain("opencode");
        expect(shared).toContain("cortexkit");
    });

    test("getProjectMagicContextDir composes <project>/.cortexkit/magic-context", () => {
        // Project-local artifacts must remain inside the project so OpenCode's external_directory permission system permits access.
        // OpenCode treats artifacts under the project directory as project-internal, avoiding historian Read permission prompts.
        // OpenCode prompts for historian Read access when artifacts are outside the project directory.
        expect(getProjectMagicContextDir("/Users/me/Work/proj")).toBe(
            path.join("/Users/me/Work/proj", ".cortexkit", "magic-context"),
        );
    });

    test("getProjectMagicContextHistorianDir appends historian/", () => {
        expect(getProjectMagicContextHistorianDir("/Users/me/Work/proj")).toBe(
            path.join("/Users/me/Work/proj", ".cortexkit", "magic-context", "historian"),
        );
    });

    test("getProjectMagicContextDir is unaffected by XDG_DATA_HOME", () => {
        // XDG_DATA_HOME affects shared storage only; project-local artifacts remain under the supplied project directory.
        // XDG_DATA_HOME affects shared storage only; project-local artifacts remain under the supplied project directory.
        // XDG_DATA_HOME affects shared storage only; project-local artifacts remain under the supplied project directory.
        // XDG_DATA_HOME affects shared storage only; project-local artifacts remain under the supplied project directory.
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getProjectMagicContextDir("/some/project")).toBe(
            path.join("/some/project", ".cortexkit", "magic-context"),
        );
    });

    test("getProjectMagicContextDir handles trailing slashes via path.join", () => {
        expect(getProjectMagicContextDir("/some/project/")).toBe(
            path.join("/some/project/", ".cortexkit", "magic-context"),
        );
    });

    test("getMagicContextLogPath falls back to the harness temp dir when the env override is unset", () => {
        expect(getMagicContextLogPath("opencode")).toBe(
            path.join(os.tmpdir(), "opencode", "magic-context", "magic-context.log"),
        );
        expect(getMagicContextLogPath("pi")).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
    });

    test("getMagicContextLogPath honors MAGIC_CONTEXT_LOG_PATH", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "/tmp/custom/magic-context.log";
        expect(getMagicContextLogPath("pi")).toBe("/tmp/custom/magic-context.log");
    });

    test("getMagicContextLogPath ignores a blank MAGIC_CONTEXT_LOG_PATH", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "   ";
        expect(getMagicContextLogPath("pi")).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
    });
});

describe("ensureCortexKitArtifactGitignore", () => {
    test("creates .cortexkit/.gitignore with a fenced magic-context block", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(dir, ".cortexkit", ".gitignore"), "utf8");
            expect(gi).toContain("# >>> cortexkit:magic-context");
            expect(gi).toContain("magic-context/");
            expect(gi).toContain("# <<< cortexkit:magic-context");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("is idempotent — a second call does not duplicate the block", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            ensureCortexKitArtifactGitignore(dir);
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(dir, ".cortexkit", ".gitignore"), "utf8");
            const occurrences = gi.split("# >>> cortexkit:magic-context").length - 1;
            expect(occurrences).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("preserves a sibling module's existing entries (appends, never clobbers)", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            const ckDir = path.join(dir, ".cortexkit");
            mkdirSync(ckDir, { recursive: true });
            // .gitignore must not contain another `cortexkit:magic-context` block when one already exists.
            writeFileSync(
                path.join(ckDir, ".gitignore"),
                "# >>> cortexkit:aft\naft/scratch/\n# <<< cortexkit:aft\n",
            );
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(ckDir, ".gitignore"), "utf8");
            expect(gi).toContain("# >>> cortexkit:aft");
            expect(gi).toContain("aft/scratch/");
            expect(gi).toContain("# >>> cortexkit:magic-context");
            expect(gi).toContain("magic-context/");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("does not ignore the project config — only the artifact dir", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "mc-gi-"));
        try {
            ensureCortexKitArtifactGitignore(dir);
            const gi = readFileSync(path.join(dir, ".cortexkit", ".gitignore"), "utf8");
            // `.cortexkit/.gitignore` remains tracked; only `magic-context/` is ignored.
            expect(gi).not.toContain("magic-context.jsonc");
            expect(gi).not.toContain("*.jsonc");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
