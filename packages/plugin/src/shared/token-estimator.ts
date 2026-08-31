/**
 *
 * Feature and tool code use this token-counting contract without importing the transform runtime hook module.
 * The hook module re-exports the token-counting symbols, preserving existing imports.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Synchronous `require` preserves the `estimateTokens` API and defers both package loads until the first non-empty call.
type TokenizerLike = {
    encode: (text: string, allowedSpecial: string) => number[];
};
type TokenizerConstructor = new (encoding: unknown) => TokenizerLike;

const TOKENIZER_PACKAGE_DIRS = [
    ["@cortexkit", "opencode-magic-context"],
    ["@cortexkit", "pi-magic-context"],
] as const;
let tokenizer: TokenizerLike | undefined;
/** `tokenizerLoadAttempted` prevents `getTokenizer` from retrying a failed bare `require`.
 * */
let tokenizerLoadAttempted = false;
/** `tokenizerPreloadAttempted` gates `preloadTokenizer`'s asynchronous installed-package search.
 * A failed synchronous `require` does not prevent `preloadTokenizer` from finding an installed package on disk.
 * */
let tokenizerPreloadAttempted = false;
/** `tokenizerPoisoned` is set when a constructed tokenizer fails to encode.
 * After an encode failure produces heuristic estimates, later loads cannot replace the fallback estimator, preventing identical text from alternating between exact and approximate counts.
 * */
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
            // `tokenizerPackageRoots` prefers the plugin-nested `ai-tokenizer` dependency to a conflicting host-hoisted version.
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
        } catch {}
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
    // Non-literal specifiers prevent Bun's bundler from folding the Claude vocabulary into the eager chunk.
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
        // `estimateTokens` uses `allowedSpecial="all"` so literal special-token strings do not throw.
        return activeTokenizer.encode(text, "all").length;
    } catch (error) {
        // `estimateTokens` must not fail a prompt; after an encode failure, it latches the deterministic fallback for the process.
        tokenizer = undefined;
        tokenizerLoadAttempted = true;
        tokenizerPoisoned = true;
        warnTokenizerFallback(error);
        return estimateTokensHeuristically(text);
    }
}
