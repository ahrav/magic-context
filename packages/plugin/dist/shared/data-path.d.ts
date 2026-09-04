import { type HarnessId } from "./harness";
export declare function getDataDir(): string;
/**
 * Per-harness scratch directory under the OS temp dir.
 *
 * Layout:
 *   - OpenCode: `${os.tmpdir()}/opencode/magic-context/`
 *   - Pi:       `${os.tmpdir()}/pi/magic-context/`
 *
 * Why a per-harness subtree of `os.tmpdir()`:
 *   1. OpenCode Desktop runs as an Electron app with a permission sandbox.
 *      Writing to arbitrary tmp paths can trigger user-visible permission
 *      prompts; the `${tmpdir}/opencode/` subtree is allow-listed by
 *      OpenCode, so anything we put under it never asks for permission.
 *   2. Splitting OpenCode from Pi keeps their logs and historian dump
 *      directories cleanly separated. `doctor --issue` for each harness
 *      reports diagnostics from the matching subtree, so an OpenCode
 *      issue report never includes Pi log noise (and vice versa).
 *   3. Pi has no permission sandbox, so the path choice is purely
 *      cosmetic for Pi — it just keeps the layout symmetric.
 *
 * Pass an explicit `harness` only when the caller already knows the
 * harness without relying on the global `setHarness()` state (e.g. the
 * CLI's doctor commands, which target a specific harness regardless of
 * which plugin is loaded). Production runtime callers should omit it so
 * the helper picks up the boot-time harness automatically.
 */
export declare function getMagicContextTempDir(harness?: HarnessId): string;
/**
 * Standard log file path the plugin writes to. Pi and OpenCode write to
 * SEPARATE logs under their respective harness subtrees so a single
 * machine running both harnesses doesn't interleave session traces.
 *
 * The plugin's buffered logger calls this on every flush rather than
 * caching, so `setHarness("pi")` taking effect after module load is
 * reflected in the next flush.
 */
export declare function getMagicContextLogPath(harness?: HarnessId): string;
/**
 * Directory used for both historian validation-failure dumps and the
 * existing-state offload XMLs that large historian/recomp passes write
 * before invoking the model. Per-harness so dumps from different
 * harnesses don't collide on filename and so `doctor --issue` for each
 * harness reports only its own historian artifacts.
 */
export declare function getMagicContextHistorianDir(harness?: HarnessId): string;
/**
 * Project-local magic-context artifact directory.
 *
 * Layout: `<project-directory>/.cortexkit/magic-context/`
 *
 * Used for artifacts that the historian/recomp pipeline writes during a run
 * and that the model is asked to read via its native Read tool. OpenCode's
 * `external_directory` permission system asks the user before reading any
 * file outside the project directory or its worktree, which interrupts every
 * historian run when artifacts live under `os.tmpdir()`. Writing under the
 * project's own `.cortexkit/` subtree falls inside the project boundary and
 * never triggers a permission prompt.
 *
 * `.cortexkit/` is the shared CortexKit per-project dir (also holds the
 * project config `magic-context.jsonc`). Because these artifacts are transient
 * debug dumps that shouldn't dirty the user's repo, the first write also drops
 * a fenced-block `.gitignore` entry ignoring this subdir (see
 * ensureCortexKitArtifactGitignore) while leaving `*.jsonc` config tracked.
 *
 * Migration note: artifacts used to live under `.opencode/magic-context/`. We
 * cut the write path forward only — old transient dumps are git-ignored and
 * regenerated, so they are intentionally NOT migrated (left to be cleaned).
 *
 * Logger does NOT use this — log files stay in the per-harness tmp subtree
 * because they are written by the plugin process itself (no model-side Read
 * tool call, no permission prompt) and span sessions/projects.
 */
export declare function getProjectMagicContextDir(directory: string): string;
/**
 * Ensure `<project>/.cortexkit/.gitignore` ignores Magic Context's transient
 * artifact subdir (`magic-context/`) without touching anything else in the
 * shared `.cortexkit/` dir — the project config `magic-context.jsonc` stays
 * tracked, and any sibling module's (e.g. AFT's) entries are preserved.
 *
 * Uses the shared CortexKit fenced-block convention: each module owns exactly
 * its `# >>> cortexkit:<module>` … `# <<< cortexkit:<module>` block and appends
 * it idempotently (no-op when its own guard line is already present). This lets
 * multiple cortexkit modules coexist in one `.gitignore` without clobbering.
 *
 * Best-effort: a write failure never blocks an artifact write (the caller
 * already degrades gracefully on its own write failures).
 */
export declare function ensureCortexKitArtifactGitignore(directory: string): void;
/**
 * Project-local historian artifact directory.
 *
 * Layout: `<project-directory>/.opencode/magic-context/historian/`
 *
 * Used for:
 *   - existing-state offload XMLs that long historian/recomp passes write
 *     before invoking the model (the model reads the file via Read tool)
 *   - validation-failure dump XMLs preserved for debugging
 *
 * Callers must `mkdirSync(dir, { recursive: true })` before writing — the
 * `.opencode/` parent may not exist on a fresh project, and write failures
 * here must degrade gracefully (e.g. historian falls back to inline state).
 */
export declare function getProjectMagicContextHistorianDir(directory: string): string;
export declare function getOpenCodeStorageDir(): string;
/**
 * Resolve the shared magic-context storage directory.
 *
 * Magic-context's own data (compartments, facts, memories, embeddings, dream
 * runs, notes, etc.) lives at this path regardless of which harness loaded the
 * plugin (OpenCode or Pi). This enables:
 *   - Shared project memories across harnesses
 *   - Shared embedding cache
 *   - Shared Dreamer runs (one per project per machine)
 *   - Future cross-harness session migration
 *
 * Layout: <XDG_DATA_HOME>/cortexkit/magic-context/
 *
 * TEST-ISOLATION GUARD. `openDatabase()` has been guarded in
 * `resolveDatabasePath()` since the 2026-06-01 (v26) and 2026-06-19 (v41)
 * incidents, in which unisolated tests migrated the user's REAL shared DB.
 * Every OTHER caller bypassed that guard — notably the CLI doctors, which
 * build `join(getMagicContextStorageDir(), "context.db")` themselves and run
 * `PRAGMA integrity_check` against it. A test that deletes XDG_DATA_HOME to
 * exercise path fallbacks cannot restore isolation by setting
 * `process.env.HOME`: bun caches `os.homedir()` at startup, so `getDataDir()`
 * still resolves to the real home. MAGIC_CONTEXT_TEST_DATA_DIR — set by
 * `packages/plugin/test-preload.ts`, and restored by any test that touches it
 * — is honored here, so the preload's "cannot be defeated" guarantee holds for
 * every caller, not just `openDatabase()`. It is never set in production.
 *
 * CWD-INDEPENDENT BACKSTOP. The preload only runs when `bun test`'s CWD has a
 * bunfig wiring `[test] preload`. A run from a dir WITHOUT that wiring (a
 * package missing its bunfig, or a brand-new one) executes every *.test.ts with
 * NO preload, and this resolver would hand back the REAL shared path — which is
 * how the live DB reached v41. Bun sets NODE_ENV=test for EVERY `bun test`
 * regardless of CWD, and production never sets it, so that window redirects to
 * a memoized throwaway dir instead. It lives here rather than in
 * `resolveDatabasePath()` so direct callers (the CLI doctors' own
 * `PRAGMA integrity_check`, announcements, the models.dev cache) are covered
 * too — they never go through the DB resolver.
 *
 * XDG_DATA_HOME still wins over both: a test that manages its own data home is
 * already controlled, and production has no test dir set at all.
 */
export declare function getMagicContextStorageDir(): string;
/**
 * The throwaway data ROOT used when `NODE_ENV=test` and no isolation variable is
 * set. Memoized per process so repeated calls in the same unisolated test
 * resolve to the SAME path — `openDatabase()` caches by path, and a fresh temp
 * dir per call would defeat that cache and hand back different DB handles.
 *
 * Exported so the mc-host lifecycle resolver can share this exact root. In
 * production both it and the storage dir derive from one `XDG_DATA_HOME`, so a
 * backstop that split them would put a test's daemon state and its database
 * under different trees.
 */
export declare function getTestBackstopDataRoot(): string;
/**
 * Legacy magic-context storage directory used by the OpenCode plugin before the
 * shared cortexkit path. Used only for one-time migration of existing data into
 * the new shared location. The legacy directory is left in place after copy so
 * users can roll back if needed; manual cleanup is safe after one stable
 * release.
 */
export declare function getLegacyOpenCodeMagicContextStorageDir(): string;
/**
 * Resolve OpenCode's cache base directory.
 *
 * OpenCode uses the `xdg-basedir` package, which — on every platform, including
 * Windows — falls back to `<homedir>/.cache` when `XDG_CACHE_HOME` is unset.
 * A previous Windows-specific branch that resolved to `%LOCALAPPDATA%` did not
 * match OpenCode's own resolution and caused `doctor --force` to target a
 * non-existent directory, leaving the real cache at `C:\Users\<user>\.cache`
 * untouched.
 */
export declare function getCacheDir(): string;
export declare function getOpenCodeCacheDir(): string;
//# sourceMappingURL=data-path.d.ts.map