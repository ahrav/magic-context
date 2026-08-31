import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { stripJsonComments } from "../shared/jsonc-parser";

export interface SubstituteInput {
    /** Raw config text before JSONC parsing. */
    text: string;
    /**
     * Resolves relative `{file:...}` references.
     * Pass `undefined` for virtual inputs.
     * When `configPath` is undefined, relative `{file:}` paths resolve against `cwd`.
     * Pass `configPath` when a backing file exists.
     */
    configPath?: string;
    /**
     * Project-level config files leave `{env:}` and `{file:}` tokens literal to prevent secret expansion.
     */
    isProjectConfig?: boolean;
}

export interface SubstituteResult {
    /* */
    text: string;
    /**
     * Warnings cover missing environment variables, unreadable files, and tokens replaced with an empty string.
     */
    warnings: string[];
}

const ENV_PATTERN = /\{env:([^}]+)\}/g;
const FILE_PATTERN = /\{file:([^}]+)\}/g;

/**
 * User-level configs warn, rather than block, when `{file:}` resolves under these directories.
 */
function sensitiveFilePathReason(resolvedPath: string): string | null {
    const home = homedir();
    const sensitiveDirs: Array<{ dir: string; label: string }> = [
        { dir: resolve(home, ".ssh"), label: "SSH keys" },
        { dir: resolve(home, ".aws"), label: "AWS credentials" },
        { dir: resolve(home, ".gnupg"), label: "GnuPG keyring" },
        { dir: resolve(home, ".config", "gh"), label: "GitHub CLI auth" },
    ];
    for (const { dir, label } of sensitiveDirs) {
        if (resolvedPath === dir || resolvedPath.startsWith(`${dir}/`)) {
            return label;
        }
    }
    return null;
}

/**
 *
 *   - `{env:VAR}` → `process.env.VAR` (trimmed key), JSON-escaped for safe inlining, empty string when missing
 *   - `{file:~/path}` → contents of `~/path`, JSON-escaped for safe inlining
 * `{file:./rel}` and `{file:rel}` resolve against `dirname(configPath)`, or `cwd` when `configPath` is undefined.
 *   - `{file:/abs}` → resolved as absolute
 *
 * Missing values produce warnings instead of errors.
 *
 */
export function substituteConfigVariables(input: SubstituteInput): SubstituteResult {
    const warnings: string[] = [];
    let text = input.text;

    if (input.isProjectConfig) {
        const hasEnvTokens = ENV_PATTERN.test(text);
        const hasFileTokens = FILE_PATTERN.test(text);
        ENV_PATTERN.lastIndex = 0;
        FILE_PATTERN.lastIndex = 0;
        if (hasEnvTokens || hasFileTokens) {
            const tokenTypes = [
                hasEnvTokens ? "{env:}" : undefined,
                hasFileTokens ? "{file:}" : undefined,
            ]
                .filter(Boolean)
                .join(" and ");
            warnings.push(
                `Project-level config no longer supports ${tokenTypes} tokens for security reasons; leaving tokens literal. Move secret expansion to user-level config.`,
            );
        }
        return { text, warnings };
    }

    // Strip JSONC comments before substitution to prevent tokens in comments from triggering environment or file reads.
    text = stripJsonComments(text);

    text = text.replace(ENV_PATTERN, (_, rawName: string) => {
        const varName = rawName.trim();
        const value = varName ? process.env[varName] : undefined;
        if (value === undefined || value === "") {
            warnings.push(
                `Environment variable ${varName} is not set (referenced via {env:${varName}}); using empty string`,
            );
            return "";
        }

        return JSON.stringify(value).slice(1, -1);
    });

    const fileMatches = Array.from(text.matchAll(FILE_PATTERN));
    if (fileMatches.length === 0) {
        return { text, warnings };
    }

    const configDir = input.configPath ? dirname(input.configPath) : process.cwd();

    let output = "";
    let cursor = 0;

    for (const match of fileMatches) {
        const token = match[0];
        const rawPath = match[1] ?? "";
        const index = match.index ?? 0;

        output += text.slice(cursor, index);
        cursor = index + token.length;

        const lineStart = text.lastIndexOf("\n", index - 1) + 1;
        const prefix = text.slice(lineStart, index).trimStart();
        if (prefix.startsWith("//")) {
            output += token;
            continue;
        }

        let filePath = rawPath.trim();
        if (filePath.startsWith("~/")) {
            filePath = resolve(homedir(), filePath.slice(2));
        } else if (!isAbsolute(filePath)) {
            filePath = resolve(configDir, filePath);
        }

        // Inlining a sensitive file exposes its contents in the substituted config.
        // Inlining a sensitive file exposes its contents in the substituted config.
        const sensitiveReason = sensitiveFilePathReason(filePath);
        if (sensitiveReason) {
            warnings.push(
                `${token} resolves to a sensitive path (${sensitiveReason}: ${filePath}); ` +
                    "inlining its contents into config — make sure this is intentional.",
            );
        }

        if (!existsSync(filePath)) {
            warnings.push(
                `File not found for ${token} (resolved to ${filePath}); using empty string`,
            );
            continue;
        }

        let contents: string;
        try {
            contents = readFileSync(filePath, "utf-8").trim();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
                `Failed to read file for ${token} (${filePath}): ${message}; using empty string`,
            );
            continue;
        }

        // JSON-escape substitutions so quotes, backslashes, and line breaks survive JSONC parsing.
        // `slice(1, -1)` removes `JSON.stringify`'s outer quotes so the substitution remains inside the caller's string literal.
        output += JSON.stringify(contents).slice(1, -1);
    }

    output += text.slice(cursor);
    return { text: output, warnings };
}
