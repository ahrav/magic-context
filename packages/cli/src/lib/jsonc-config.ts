import { existsSync, readFileSync } from "node:fs";
import { parseConfigJsonc } from "@magic-context/core/shared/jsonc-parser";

export type JsoncReadResult =
    | { kind: "missing" }
    | { kind: "parsed"; value: Record<string, unknown> }
    | { kind: "parse-error"; error: ConfigParseError };

export class ConfigParseError extends Error {
    readonly path: string;

    constructor(path: string, content: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const location = parseErrorLocation(content, cause);
        super(
            `Refusing to overwrite unparseable config ${path} at line ${location.line}, column ${location.column}: ${detail}`,
            { cause },
        );
        this.name = "ConfigParseError";
        this.path = path;
    }
}

function parseErrorLocation(content: string, error: unknown): { line: number; column: number } {
    const lines = content.split("\n");
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unexpected end of JSON input")) {
        return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
    }

    const parserLocation = error as { line?: unknown; column?: unknown };
    if (
        typeof parserLocation.line === "number" &&
        parserLocation.line >= 1 &&
        parserLocation.line <= lines.length &&
        typeof parserLocation.column === "number" &&
        parserLocation.column >= 0
    ) {
        return { line: parserLocation.line, column: parserLocation.column + 1 };
    }

    const messageLine = /Line (\d+)/.exec(message)?.[1];
    return { line: messageLine ? Number.parseInt(messageLine, 10) : 1, column: 1 };
}

/**
 * Keeps a missing file distinct from malformed user data. Callers may create a
 * missing config, but must never replace a parse failure with an empty object.
 */
export function readJsoncConfig(path: string): JsoncReadResult {
    if (!existsSync(path)) return { kind: "missing" };

    const content = readFileSync(path, "utf-8");
    try {
        const rejectedKeyPaths: string[] = [];
        const parsed = parseConfigJsonc(content, {
            onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")),
        });
        if (rejectedKeyPaths.length > 0) {
            throw new Error(`unsafe prototype-pollution key at ${rejectedKeyPaths.join(", ")}`);
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a JSON object at the document root");
        }
        return { kind: "parsed", value: parsed as Record<string, unknown> };
    } catch (error) {
        return { kind: "parse-error", error: new ConfigParseError(path, content, error) };
    }
}

export function readJsoncConfigForUpdate(path: string): Record<string, unknown> {
    const result = readJsoncConfig(path);
    if (result.kind === "missing") return {};
    if (result.kind === "parse-error") throw result.error;
    return result.value;
}

export function assertJsoncConfigsParseable(paths: readonly string[]): void {
    for (const path of paths) {
        const result = readJsoncConfig(path);
        if (result.kind === "parse-error") throw result.error;
    }
}

/**
 * Lenient JSONC read for diagnostics surfaces: a missing file is an empty
 * config, and a parse failure is reported as a string instead of thrown.
 */
export function readJsoncLenient(path: string): {
    value: Record<string, unknown>;
    parseError?: string;
} {
    if (!existsSync(path)) return { value: {} };
    try {
        return {
            value: parseConfigJsonc<Record<string, unknown>>(readFileSync(path, "utf-8")),
        };
    } catch (error) {
        return {
            value: {},
            parseError: error instanceof Error ? error.message : String(error),
        };
    }
}
