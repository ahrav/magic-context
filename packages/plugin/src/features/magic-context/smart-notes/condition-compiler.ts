import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveAndFenceProviderPath } from "@cortexkit/retina-local-fs/path-fence";
import type { AtomicPredicate, ProviderConfig } from "@cortexkit/retina-local-fs/provider";
import { validateProviderConfig } from "@cortexkit/retina-local-fs/provider";

export const RETINA_LOCAL_FS_PROVIDER = "local-fs";

export type ConditionCompileResult =
    | {
          status: "compiled";
          provider: typeof RETINA_LOCAL_FS_PROVIDER;
          config: ProviderConfig;
          compiledAt: number;
      }
    | { status: "plain"; reason?: string }
    | { status: "refused"; reason: string };

export interface ConditionPathResolution {
    path: string;
    exists: boolean;
}

export interface ConditionCompilerOptions {
    /** projectPath is the filesystem root for relative paths and default repository predicates. */
    projectPath: string;
    homeDirectory?: string;
    now?: () => number;
    resolvePath?: (path: string) => Promise<ConditionPathResolution>;
}

type RawPredicate =
    | { kind: "file_contains"; path: string; needle: string; absent?: boolean }
    | { kind: "path_exists"; path: string; gone?: boolean }
    | { kind: "mtime_after"; path: string }
    | { kind: "git_commit_after"; repo_path: string; sha: string }
    | { kind: "git_tag_matching"; repo_path: string; pattern: string; above?: string };

const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)`;

/**
 * compileSurfaceCondition compiles only deterministic local filesystem phrases.
 * Prose outside the grammar returns { status: "plain" }.
 */
export async function compileSurfaceCondition(
    surfaceCondition: string,
    options: ConditionCompilerOptions,
): Promise<ConditionCompileResult> {
    const plainReason = unsafeGrammarReason(surfaceCondition);
    if (plainReason) return { status: "plain", reason: plainReason };

    const parsed = parseCondition(surfaceCondition, options.projectPath);
    if (parsed === null) return { status: "plain" };

    const now = (options.now ?? Date.now)();
    const resolvePath =
        options.resolvePath ??
        (async (path: string): Promise<ConditionPathResolution> => {
            const resolved = await resolveAndFenceProviderPath(path, {
                allowMissing: true,
                homeDirectory: options.homeDirectory,
                cwd: options.projectPath,
            });
            return { path: resolved, exists: existsSync(resolved) };
        });

    let predicates: AtomicPredicate[];
    try {
        predicates = [];
        for (const predicate of parsed) {
            predicates.push(await resolvePredicate(predicate, resolvePath, now));
        }
    } catch (error) {
        const code =
            error !== null && typeof error === "object" && "code" in error
                ? (error as { code?: unknown }).code
                : undefined;
        return {
            status: "refused",
            reason: code === "fenced_path" ? "fenced path" : "path resolution failed",
        };
    }

    const candidate: ProviderConfig = predicates.length === 1 ? predicates[0] : { any: predicates };
    const validation = validateProviderConfig(candidate);
    if (!validation.success) {
        return {
            status: "refused",
            reason: `provider schema: ${singleLine(validation.reason)}`.slice(0, 180),
        };
    }

    return {
        status: "compiled",
        provider: RETINA_LOCAL_FS_PROVIDER,
        config: validation.config,
        compiledAt: now,
    };
}

export function conditionCompileStorageFields(result: ConditionCompileResult): {
    compiledProvider: string | null;
    compiledConfig: string | null;
    compiledAt: number | null;
    compileStatus: ConditionCompileResult["status"];
} {
    if (result.status === "compiled") {
        return {
            compiledProvider: result.provider,
            compiledConfig: JSON.stringify(result.config),
            compiledAt: result.compiledAt,
            compileStatus: result.status,
        };
    }
    return {
        compiledProvider: null,
        compiledConfig: null,
        compiledAt: null,
        compileStatus: result.status,
    };
}

export function conditionCompileReplySuffix(result: ConditionCompileResult): string {
    if (result.status === "compiled") {
        return `\n- Retina provider: ${result.provider}`;
    }
    if (result.status === "refused") {
        return `\n- Retina compile refused: ${result.reason}`;
    }
    return "";
}

function parseCondition(surfaceCondition: string, projectPath: string): RawPredicate[] | null {
    const trimmed = surfaceCondition.trim();
    const either = trimmed.match(/^either\s+(.+)$/i);
    if (!either) {
        const predicate = parseAtomicCondition(trimmed, projectPath);
        return predicate ? [predicate] : null;
    }

    const clauses = splitOrClauses(either[1]);
    if (clauses.length < 2) return null;
    const predicates = clauses.map((clause) => parseAtomicCondition(clause, projectPath));
    return predicates.every((predicate): predicate is RawPredicate => predicate !== null)
        ? predicates
        : null;
}

function parseAtomicCondition(text: string, projectPath: string): RawPredicate | null {
    const fileContains = text.match(
        new RegExp(
            `^(?:when\\s+)?file\\s+(${VALUE})\\s+(no longer contains|contains)\\s+(${VALUE})$`,
            "i",
        ),
    );
    if (fileContains) {
        const path = unquote(fileContains[1]);
        const needle = unquote(fileContains[3].trim());
        if (path === null || needle === null) return null;
        return {
            kind: "file_contains",
            path,
            needle,
            ...(fileContains[2].toLowerCase() === "no longer contains" ? { absent: true } : {}),
        };
    }

    const commit = text.match(
        new RegExp(
            `^(?:when\\s+)?(?:repo(?:sitory)?\\s+)?(${VALUE})\\s+has\\s+a\\s+commit\\s+(?:after|newer than)\\s+([0-9a-f]{7,64})$`,
            "i",
        ),
    );
    if (commit) {
        const repoPath = unquote(commit[1]);
        if (repoPath === null) return null;
        return {
            kind: "git_commit_after",
            repo_path: repoPath,
            sha: commit[2],
        };
    }

    const tag = text.match(
        new RegExp(
            `^(?:when\\s+)?a\\s+tag\\s+(?:(?:matching\\s+(${VALUE})(?:\\s+above\\s+semver\\s+(${VALUE}))?)|(?:above\\s+semver\\s+(${VALUE})))\\s+appears(?:\\s+in\\s+(?:repo(?:sitory)?\\s+)?(${VALUE}))?$`,
            "i",
        ),
    );
    if (tag) {
        const pattern = tag[1] ? unquote(tag[1]) : "*";
        const above = unquote(tag[2] ?? tag[3] ?? "");
        const repoPath = tag[4] ? unquote(tag[4]) : projectPath;
        if (pattern === null || above === null || repoPath === null) return null;
        return {
            kind: "git_tag_matching",
            repo_path: repoPath,
            pattern,
            ...(above.length > 0 ? { above } : {}),
        };
    }

    const mtime = text.match(
        new RegExp(
            `^(?:when\\s+)?(?:file\\s+)?(${VALUE})\\s+(changes|is rebuilt|mtime moves)$`,
            "i",
        ),
    );
    if (mtime) {
        const path = unquote(mtime[1]);
        if (path === null) return null;
        return {
            kind: "mtime_after",
            path,
        };
    }

    const pathExists = text.match(
        new RegExp(`^(?:when\\s+)?(?:path\\s+)?(${VALUE})\\s+(exists|is gone)$`, "i"),
    );
    if (pathExists) {
        const path = unquote(pathExists[1]);
        if (path === null) return null;
        return {
            kind: "path_exists",
            path,
            ...(pathExists[2].toLowerCase() === "is gone" ? { gone: true } : {}),
        };
    }

    return null;
}

async function resolvePredicate(
    predicate: RawPredicate,
    resolvePath: (path: string) => Promise<ConditionPathResolution>,
    now: number,
): Promise<AtomicPredicate> {
    const configuredPath = "repo_path" in predicate ? predicate.repo_path : predicate.path;
    const resolved = await resolvePath(configuredPath);
    const sourceIsResolvable =
        isAbsolute(configuredPath) || configuredPath === "~" || configuredPath.startsWith("~/");
    const audit =
        sourceIsResolvable && resolved.exists ? {} : { resolved_path_exists: false as const };

    switch (predicate.kind) {
        case "file_contains":
            return { ...predicate, path: resolved.path, ...audit };
        case "path_exists":
            return { ...predicate, path: resolved.path, ...audit };
        case "mtime_after":
            return { kind: predicate.kind, path: resolved.path, since_ms: now, ...audit };
        case "git_commit_after":
            return { ...predicate, repo_path: resolved.path, ...audit };
        case "git_tag_matching":
            return { ...predicate, repo_path: resolved.path, ...audit };
    }
}

function splitOrClauses(text: string): string[] {
    const clauses: string[] = [];
    let start = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote && character === "\\") {
            escaped = true;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = quote === character ? null : quote === null ? character : quote;
            continue;
        }
        if (quote !== null) continue;
        const separator = text.slice(index).match(/^\s+or\s+/i);
        if (!separator) continue;
        clauses.push(text.slice(start, index).trim());
        index += separator[0].length - 1;
        start = index + 1;
    }
    clauses.push(text.slice(start).trim());
    return clauses.filter(Boolean);
}

function unsafeGrammarReason(value: string): string | null {
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (const character of value) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote && character === "\\") {
            escaped = true;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = quote === character ? null : quote === null ? character : quote;
        }
    }
    if (quote !== null) return "unbalanced quote; leaving condition dreamer-evaluated";
    if (/\bcontains\s+no(?:\s|$)/i.test(value)) {
        return "ambiguous negation after contains; leaving condition dreamer-evaluated";
    }
    const temporalSuffix = new RegExp(
        `\\bcontains\\s+${VALUE}\\s+(?:since|until|after|before|when|while|for|as\\s+of)\\b`,
        "i",
    );
    if (temporalSuffix.test(value)) {
        return "temporal suffix after contains; leaving condition dreamer-evaluated";
    }
    return null;
}

function unquote(value: string): string | null {
    const quote = value[0];
    const final = value.at(-1);
    const startsQuoted = quote === '"' || quote === "'";
    const endsQuoted = final === '"' || final === "'";
    if (!startsQuoted && !endsQuoted) return value;
    if (!startsQuoted || final !== quote || value.length < 2) return null;
    if (quote === '"') {
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === "string" ? parsed : null;
        } catch {
            return null;
        }
    }
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function singleLine(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}
