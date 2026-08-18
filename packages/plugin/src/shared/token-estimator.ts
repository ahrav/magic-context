/**
 * Shared token estimation (KTD1 — search hard bounds).
 *
 * Extracted from `hooks/magic-context/read-session-formatting.ts` so feature
 * and tool code (search bounds, ctx_search rendering, auto-search hints) can
 * consume the same token-counting contract without depending on the transform
 * runtime hook module. The hook module re-exports these symbols, so existing
 * imports keep working.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Keep ai-tokenizer out of the eager module graph. Pi imports this module through
// its system-prompt path during cold start, while token estimates are not needed
// until the first real prompt is processed. Synchronous require preserves the
// estimateTokens API and defers both package loads until that first non-empty call.
type TokenizerLike = {
    encode: (text: string, allowedSpecial: string) => number[];
};
type TokenizerConstructor = new (encoding: unknown) => TokenizerLike;

const TOKENIZER_PACKAGE_DIRS = [
    ["@cortexkit", "opencode-magic-context"],
    ["@cortexkit", "pi-magic-context"],
] as const;
let tokenizer: TokenizerLike | undefined;
/** Gate on the synchronous bare-require path (`getTokenizer`), so estimate
 *  calls do not pay a failing `require` more than once per process. */
let tokenizerLoadAttempted = false;
/** Gate on the async installed-package search path (`preloadTokenizer`). Kept
 *  separate from `tokenizerLoadAttempted`: a failed synchronous require must
 *  not stop the preload from finding the package on disk. */
let tokenizerPreloadAttempted = false;
/** Set when a constructed tokenizer failed to encode. Once estimates have
 *  been produced heuristically after such a failure, no later load may swap
 *  the estimator back, or identical text would alternate between exact and
 *  approximate counts across cache/budget decisions. */
let tokenizerPoisoned = false;
let tokenizerLoadPromise: Promise<boolean> | undefined;
let tokenizerWarningSent = false;

function tokenizerPackageRoots(): string[] {
    const cwd = process.cwd();
    const openCodeCache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode");
    const roots = [cwd, openCodeCache];
    const candidates: string[] = [];
    for (const root of roots) {
        for (const packageDir of TOKENIZER_PACKAGE_DIRS) {
            // Prefer a dependency nested under the plugin over a conflicting
            // version hoisted by the host application.
            candidates.push(
                join(root, "node_modules", ...packageDir, "node_modules", "ai-tokenizer"),
            );
        }
        candidates.push(join(root, "node_modules", "ai-tokenizer"));
    }

    let ancestor = process.argv[1] ? dirname(resolve(process.argv[1])) : cwd;
    while (true) {
        candidates.push(join(ancestor, "node_modules", "ai-tokenizer"));
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }
    return [...new Set(candidates)];
}

function packageImportTarget(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    const conditions = value as Record<string, unknown>;
    return packageImportTarget(conditions.import) ?? packageImportTarget(conditions.default);
}

function findTokenizerImportPaths(): { tokenizerPath: string; encodingPath: string } | undefined {
    for (const packageRoot of tokenizerPackageRoots()) {
        const packageJsonPath = join(packageRoot, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        try {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
                module?: unknown;
                main?: unknown;
                exports?: Record<string, unknown>;
            };
            const tokenizerTarget =
                packageImportTarget(packageJson.exports?.["."]) ??
                (typeof packageJson.module === "string" ? packageJson.module : undefined) ??
                (typeof packageJson.main === "string" ? packageJson.main : undefined);
            const encodingTarget = packageImportTarget(packageJson.exports?.["./encoding/claude"]);
            if (!tokenizerTarget || !encodingTarget) continue;
            return {
                tokenizerPath: realpathSync(join(packageRoot, tokenizerTarget)),
                encodingPath: realpathSync(join(packageRoot, encodingTarget)),
            };
        } catch {
            // Try the next npm layout; the caller warns if none is usable.
        }
    }
    return undefined;
}

function constructTokenizer(tokenizerModule: unknown, claudeEncoding: unknown): TokenizerLike {
    const typedModule = tokenizerModule as {
        default?: TokenizerConstructor;
        Tokenizer?: TokenizerConstructor;
    };
    const Tokenizer = typedModule.default ?? typedModule.Tokenizer;
    if (!Tokenizer) {
        throw new Error("ai-tokenizer does not expose a Tokenizer constructor");
    }
    return new Tokenizer(claudeEncoding);
}

function loadTokenizer(): TokenizerLike {
    // Non-literal specifiers keep Bun's bundler static analysis from folding the
    // Claude vocabulary into the eager chunk.
    const requireFromThisModule = createRequire(import.meta.url);
    return constructTokenizer(
        requireFromThisModule("ai-" + "tokenizer"),
        requireFromThisModule("ai-tokenizer/encoding/" + "claude"),
    );
}

async function loadTokenizerFromInstalledPackage(): Promise<TokenizerLike> {
    const installedPaths = findTokenizerImportPaths();
    if (!installedPaths) {
        throw new Error(
            "ai-tokenizer was not found under the project, runtime, or OpenCode cache node_modules roots",
        );
    }
    const [tokenizerModule, claudeEncoding] = await Promise.all([
        import(pathToFileURL(installedPaths.tokenizerPath).href),
        import(pathToFileURL(installedPaths.encodingPath).href),
    ]);
    return constructTokenizer(tokenizerModule, claudeEncoding);
}

function warnTokenizerFallback(error: unknown): void {
    if (tokenizerWarningSent) return;
    tokenizerWarningSent = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
        "[magic-context] ai-tokenizer is unavailable; using approximate character-based token counts for this process. Token budgets, persisted per-message counts, and protected-tail/compartment boundaries may be less accurate until restart:",
        reason,
    );
}

export async function preloadTokenizer(): Promise<boolean> {
    if (tokenizer) return true;
    if (tokenizerPoisoned || tokenizerPreloadAttempted) return false;
    if (tokenizerLoadPromise) return tokenizerLoadPromise;

    tokenizerLoadPromise = (async () => {
        try {
            try {
                tokenizer = loadTokenizer();
            } catch {
                tokenizer = await loadTokenizerFromInstalledPackage();
            }
            tokenizerLoadAttempted = true;
            return true;
        } catch (error) {
            tokenizerLoadAttempted = true;
            warnTokenizerFallback(error);
            return false;
        } finally {
            tokenizerPreloadAttempted = true;
            tokenizerLoadPromise = undefined;
        }
    })();
    return tokenizerLoadPromise;
}

function getTokenizer(): TokenizerLike | undefined {
    if (tokenizer || tokenizerLoadAttempted) return tokenizer;
    tokenizerLoadAttempted = true;
    try {
        tokenizer = loadTokenizer();
    } catch (error) {
        warnTokenizerFallback(error);
    }
    return tokenizer;
}

function estimateTokensHeuristically(text: string): number {
    return Math.ceil(text.length / 3.5);
}

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const activeTokenizer = getTokenizer();
    if (!activeTokenizer) return estimateTokensHeuristically(text);
    try {
        // Encode with allowedSpecial="all" so literal special-token strings (e.g.
        // `<EOT>` in tool output) are counted as text instead of throwing.
        return activeTokenizer.encode(text, "all").length;
    } catch (error) {
        // Estimation must not fail a prompt. Latch the deterministic fallback for
        // the rest of this process so identical text does not alternate between
        // exact and approximate counts as cache/budget decisions are made.
        tokenizer = undefined;
        tokenizerLoadAttempted = true;
        tokenizerPoisoned = true;
        warnTokenizerFallback(error);
        return estimateTokensHeuristically(text);
    }
}
