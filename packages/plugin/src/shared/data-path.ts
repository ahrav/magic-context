import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getHarness, type HarnessId } from "./harness";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

/**
 *
 * Layout:
 *
 *
 */
export function getMagicContextTempDir(harness: HarnessId = getHarness()): string {
    return path.join(os.tmpdir(), harness, "magic-context");
}

/**
 * The default path includes `harness`, preventing default-path collisions.
 *
 */
export function getMagicContextLogPath(harness: HarnessId = getHarness()): string {
    const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
    if (envPath) return envPath;
    return path.join(getMagicContextTempDir(harness), "magic-context.log");
}

/**
 * Each harness stores historian artifacts separately.
 */
export function getMagicContextHistorianDir(harness: HarnessId = getHarness()): string {
    return path.join(getMagicContextTempDir(harness), "historian");
}

/**
 *
 * Layout: `<project-directory>/.cortexkit/magic-context/`
 *
 *
 * The ignore rule leaves `magic-context.jsonc` trackable.
 *
 *
 */
export function getProjectMagicContextDir(directory: string): string {
    return path.join(directory, ".cortexkit", "magic-context");
}

const GITIGNORE_GUARD_OPEN = "# >>> cortexkit:magic-context";
const GITIGNORE_GUARD_CLOSE = "# <<< cortexkit:magic-context";

/**
 * If no opening guard exists, preserve existing entries and append the `magic-context/` block.
 *
 * The opening guard prevents duplicate block insertion.
 *
 */
export function ensureCortexKitArtifactGitignore(directory: string): void {
    try {
        const cortexKitDir = path.join(directory, ".cortexkit");
        const gitignorePath = path.join(cortexKitDir, ".gitignore");
        let existing = "";
        if (existsSync(gitignorePath)) {
            existing = readFileSync(gitignorePath, "utf8");
            if (existing.includes(GITIGNORE_GUARD_OPEN)) return;
        }
        const block = `${GITIGNORE_GUARD_OPEN}\nmagic-context/\n${GITIGNORE_GUARD_CLOSE}\n`;
        const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
        const next = existing + (needsLeadingNewline ? "\n" : "") + block;
        mkdirSync(cortexKitDir, { recursive: true });
        writeFileSync(gitignorePath, next, "utf8");
    } catch {
        // Ignore errors while reading or updating `.cortexkit/.gitignore`.
    }
}

/**
 *
 * Layout: `<project-directory>/.opencode/magic-context/historian/`
 *
 * Used for:
 *
 * Callers must create this directory before writing because a fresh project may not contain `.cortexkit/`.
 */
export function getProjectMagicContextHistorianDir(directory: string): string {
    return path.join(getProjectMagicContextDir(directory), "historian");
}

export function getOpenCodeStorageDir(): string {
    return path.join(getDataDir(), "opencode", "storage");
}

/**
 *
 * `OpenCode` and `Pi` use this path for shared persistent storage.
 *
 * Layout: <XDG_DATA_HOME>/cortexkit/magic-context/
 *
 * Tests must not resolve the user's shared database path.
 * When `XDG_DATA_HOME` is unset, `MAGIC_CONTEXT_TEST_DATA_DIR` overrides the storage root.
 * When `XDG_DATA_HOME` is unset, `MAGIC_CONTEXT_TEST_DATA_DIR` overrides the storage root.
 * `MAGIC_CONTEXT_TEST_DATA_DIR` overrides the storage root only when `XDG_DATA_HOME` is unset.
 *
 * When `XDG_DATA_HOME` is unset, `NODE_ENV=test` without `MAGIC_CONTEXT_TEST_DATA_DIR` uses a throwaway directory.
 * When `XDG_DATA_HOME` is unset, `NODE_ENV=test`, and `MAGIC_CONTEXT_TEST_DATA_DIR` is unset, the resolver uses a memoized throwaway directory.
 *
 * `XDG_DATA_HOME` takes precedence over test isolation.
 */
export function getMagicContextStorageDir(): string {
    if (!process.env.XDG_DATA_HOME) {
        const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        if (testDataDir) {
            return path.join(testDataDir, "cortexkit", "magic-context");
        }
        if (process.env.NODE_ENV === "test") {
            return getTestBackstopStorageDir();
        }
    }
    return path.join(getDataDir(), "cortexkit", "magic-context");
}

let testBackstopDataRoot: string | null = null;
let testBackstopWarned = false;

/**
 * The resolver uses this throwaway data root when `XDG_DATA_HOME` is unset, `NODE_ENV=test`, and `MAGIC_CONTEXT_TEST_DATA_DIR` is unset.
 * Memoization keeps repeated calls on one database path.
 * A fresh temporary directory per call would bypass `openDatabase()`'s path cache.
 *
 */
export function getTestBackstopDataRoot(): string {
    if (!testBackstopDataRoot) {
        testBackstopDataRoot = mkdtempSync(path.join(os.tmpdir(), "mc-test-db-backstop-"));
    }
    if (!testBackstopWarned) {
        testBackstopWarned = true;
        console.warn(
            "[magic-context] TEST BACKSTOP: NODE_ENV=test with no MAGIC_CONTEXT_TEST_DATA_DIR " +
                `— redirecting storage to a throwaway temp dir (${testBackstopDataRoot}) so no ` +
                "test can touch the user's real shared database or daemon state. Wire " +
                "`[test] preload` in this package's bunfig.toml.",
        );
    }
    return testBackstopDataRoot;
}

function getTestBackstopStorageDir(): string {
    return path.join(getTestBackstopDataRoot(), "cortexkit", "magic-context");
}

/**
 * release.
 */
export function getLegacyOpenCodeMagicContextStorageDir(): string {
    return path.join(getOpenCodeStorageDir(), "plugin", "magic-context");
}

/**
 *
 * OpenCode falls back to `<homedir>/.cache` when `XDG_CACHE_HOME` is unset, including on Windows.
 * untouched.
 */
export function getCacheDir(): string {
    return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

export function getOpenCodeCacheDir(): string {
    return path.join(getCacheDir(), "opencode");
}
