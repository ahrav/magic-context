import { existsSync, readFileSync } from "node:fs";

import { parse as parseCommentJson } from "comment-json";

export function stripJsonComments(content: string): string {
    let result = "";
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];
        const next = content[index + 1];

        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                result += char;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                index += 1;
                // A block comment is a token separator in the JSONC grammar:
                // emit one space so adjacent tokens ("1/*c*/2") cannot fuse
                // into a different token ("12") once the comment is removed.
                result += " ";
            }
            continue;
        }

        if (inString) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === "/" && next === "/") {
            inLineComment = true;
            index += 1;
            continue;
        }

        if (char === "/" && next === "*") {
            inBlockComment = true;
            index += 1;
            continue;
        }

        result += char;
    }

    return result;
}

export function stripTrailingCommas(content: string): string {
    let result = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];

        if (inString) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === ",") {
            let lookahead = index + 1;
            while (lookahead < content.length && /\s/.test(content[lookahead] ?? "")) {
                lookahead += 1;
            }
            const next = content[lookahead];
            if (next === "}" || next === "]") {
                continue;
            }
        }

        result += char;
    }

    return result;
}

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPrototypePollutionKey(key: string): boolean {
    return PROTOTYPE_POLLUTION_KEYS.has(key);
}

export interface ParsedJsonSanitizerOptions {
    onRejectedKey?: (path: readonly (string | number)[]) => void;
}

/**
 * Copy parsed JSON into fresh own-property-only containers while rejecting keys
 * that can alter an object's prototype during a later merge. Rebuilding objects
 * also removes an already-polluted prototype produced by third-party parsers.
 */
export function sanitizeParsedJson<T>(
    value: T,
    options: ParsedJsonSanitizerOptions = {},
    path: readonly (string | number)[] = [],
): T {
    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            sanitizeParsedJson(entry, options, [...path, index]),
        ) as T;
    }
    if (value === null || typeof value !== "object") return value;

    const source = value as Record<string, unknown>;
    const sourcePrototype = Object.getPrototypeOf(source);
    // Any non-plain prototype (a parser-injected object OR null) is treated
    // as an attempted __proto__ override; the rebuilt object always gets a
    // plain prototype either way.
    if (sourcePrototype !== Object.prototype) {
        options.onRejectedKey?.([...path, "__proto__"]);
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        if (isPrototypePollutionKey(key)) {
            options.onRejectedKey?.([...path, key]);
            continue;
        }
        Object.defineProperty(sanitized, key, {
            value: sanitizeParsedJson(source[key], options, [...path, key]),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return sanitized as T;
}

export function parseJsonc<T = unknown>(
    content: string,
    options: ParsedJsonSanitizerOptions = {},
): T {
    const normalized = stripTrailingCommas(stripJsonComments(content));
    return sanitizeParsedJson(JSON.parse(normalized) as T, options);
}

/**
 * The config-file JSONC parser for `magic-context.jsonc` readers. One
 * grammar (`comment-json`) parses the config so the same file cannot load
 * differently across harnesses; the sanitizer pass rebuilds the tree with
 * prototype-pollution keys rejected.
 */
export function parseConfigJsonc<T = unknown>(
    content: string,
    options: ParsedJsonSanitizerOptions = {},
): T {
    return sanitizeParsedJson(parseCommentJson(content) as T, options);
}

export function readJsoncFile<T = unknown>(filePath: string): T | null {
    try {
        return parseJsonc<T>(readFileSync(filePath, "utf-8"));
    } catch (_error) {
        return null;
    }
}

export function detectConfigFile(basePath: string): {
    format: "json" | "jsonc" | "none";
    path: string;
} {
    const jsoncPath = `${basePath}.jsonc`;
    const jsonPath = `${basePath}.json`;

    if (existsSync(jsoncPath)) {
        return { format: "jsonc", path: jsoncPath };
    }

    if (existsSync(jsonPath)) {
        return { format: "json", path: jsonPath };
    }

    return { format: "none", path: jsoncPath };
}
