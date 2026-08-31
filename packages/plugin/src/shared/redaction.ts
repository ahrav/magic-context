import { homedir, userInfo } from "node:os";

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A key must contain a secret word as a complete separator-delimited segment.
// Substring matching would redact benign keys such as `pin_key_files`.
// `pin_key_files`, `token_budget`, and `injection_budget_tokens` must not be redacted.
const SECRET_WORDS = [
    "key",
    "token",
    "secret",
    "password",
    "auth",
    "authorization",
    "bearer",
    "credential",
];
const SECRET_SEGMENT_PATTERN = new RegExp(
    `^(?:${SECRET_WORDS.map((w) => `${w}s?`).join("|")})$`,
    "i",
);
const TRAILING_DESCRIPTORS = new Set(["id", "ids", "value", "values", "header", "headers"]);

function redactionTypeForKey(key: string): string {
    const normalized = key
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "_");
    const suffix = normalized.split(".").filter(Boolean).at(-1) ?? normalized;
    return suffix || "secret";
}

// Do not redact numeric, boolean, null, or undefined values solely because their key contains a secret word.
function isNonSecretScalarValue(value: string): boolean {
    const v = value.trim();
    if (v === "true" || v === "false" || v === "null" || v === "undefined") return true;
    return /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v);
}

const SECRET_QUALIFIERS = new Set([
    "api",
    "access",
    "private",
    "client",
    "auth",
    "authorization",
    "secret",
    "bearer",
    "session",
    "refresh",
    "service",
    "x",
    "openai",
    "anthropic",
    "google",
    "github",
    "huggingface",
    "aws",
    "azure",
]);

export function isSecretKey(key: string): boolean {
    const segments = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .split(/[._-]+/)
        .filter(Boolean);
    if (segments.length === 0) return false;

    if (segments.length === 1) {
        const first = segments[0];
        return Boolean(first && SECRET_SEGMENT_PATTERN.test(first));
    }

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg || !SECRET_SEGMENT_PATTERN.test(seg)) continue;

        let trailingOk = true;
        for (let j = i + 1; j < segments.length; j++) {
            const tail = segments[j];
            if (!tail) continue;
            if (TRAILING_DESCRIPTORS.has(tail)) continue;
            if (SECRET_SEGMENT_PATTERN.test(tail)) continue;
            trailingOk = false;
            break;
        }
        if (!trailingOk) continue;

        for (let k = i - 1; k >= 0; k--) {
            const lead = segments[k];
            if (lead && SECRET_QUALIFIERS.has(lead)) return true;
        }
    }
    return false;
}

/** `sanitizePathStringPortable` rewrites generic home-directory patterns without reading the host's home directory or username.
 * Use `sanitizePathStringPortable` when output must be identical across hosts.
 * Use `sanitizePathString` when diagnostics must redact the local identity. */
export function sanitizePathStringPortable(value: string): string {
    return value
        .replace(/\/Users\/[^/]+\//gi, "/Users/<USER>/")
        .replace(/\/home\/[^/]+\//gi, "/home/<USER>/")
        .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]/gi, "C:\\Users\\<USER>\\");
}

export function sanitizePathString(value: string): string {
    const home = homedir();
    const username = userInfo().username;
    let sanitized = value;
    if (home) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(home), "g"), "~");
    }
    sanitized = sanitizePathStringPortable(sanitized);
    if (username) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(username), "g"), "<USER>");
    }
    return sanitized;
}

const SECRET_TEXT_PATTERNS: Array<{
    pattern: RegExp;
    replacement: string | ((match: string, ...groups: string[]) => string);
}> = [
    {
        pattern: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}/g,
        replacement: "<ANTHROPIC_API_KEY_REDACTED>",
    },
    {
        pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
        replacement: "<OPENAI_API_KEY_REDACTED>",
    },
    {
        pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
        replacement: "<GITHUB_PAT_REDACTED>",
    },
    {
        pattern: /\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}/g,
        replacement: "<GITHUB_TOKEN_REDACTED>",
    },
    {
        pattern: /\bhf_[A-Za-z0-9]{30,}/g,
        replacement: "<HUGGINGFACE_TOKEN_REDACTED>",
    },
    {
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replacement: "<AWS_ACCESS_KEY_ID_REDACTED>",
    },
    {
        pattern: /\bxox[abprsuvc]-[A-Za-z0-9-]{10,}/g,
        replacement: "<SLACK_TOKEN_REDACTED>",
    },
    {
        pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
        replacement: "<GOOGLE_API_KEY_REDACTED>",
    },
    {
        pattern: /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
        replacement: (_full: string, prefix: string) => `${prefix}<REDACTED:bearer>`,
    },
    {
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        replacement: "<JWT_REDACTED>",
    },
    {
        pattern:
            /(["'])([^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)\1(\s*:\s*)(["'])([^"']*)\4/gi,
        replacement: (
            full: string,
            quote: string,
            key: string,
            separator: string,
            valueQuote: string,
            value: string,
        ) =>
            isNonSecretScalarValue(value)
                ? full
                : `${quote}${key}${quote}${separator}${valueQuote}<REDACTED:${redactionTypeForKey(key)}>${valueQuote}`,
    },
    {
        pattern:
            /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)\s*=\s*([^\s'"`]+)/gi,
        replacement: (full: string, key: string, value: string) =>
            isNonSecretScalarValue(value) ? full : `${key}=<REDACTED:${redactionTypeForKey(key)}>`,
    },
];

export function redactSecretText(value: string): string {
    let redacted = value;
    for (const { pattern, replacement } of SECRET_TEXT_PATTERNS) {
        if (typeof replacement === "string") {
            redacted = redacted.replace(pattern, replacement);
        } else {
            redacted = redacted.replace(
                pattern,
                replacement as (match: string, ...groups: string[]) => string,
            );
        }
    }
    return redacted;
}

export function sanitizeDiagnosticText(value: string): string {
    return redactSecretText(sanitizePathString(value));
}

// `sanitizeDiagnosticText` excludes shareability-only patterns.
const SHAREABILITY_SENSITIVE_PATTERNS: RegExp[] = [
    /\bC:\/Users\/[^/\s]+/i,
    /(?:^|\s)~\/[^\s]+/,
    // `sanitizeDiagnosticText` redacts inline `key: value` and `key=value` secrets because keyed redaction only processes config object keys.
    /\b(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*\S+/i,
    // Redact local and private endpoints because they identify the environment.
    // The bracketed arm handles `[::1]` because `\b` does not match before `[` at the start of input or after a non-word character.
    // The bare IPv6 loopback arm requires a non-word, non-colon, non-dot prefix to avoid matching suffixes of addresses such as `2001:db8::1`.
    /(?:\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]|(?:^|[^\w:.])::1\b)(?::\d+)?/i,
    /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
    /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
    // The redactor removes IPv4 link-local (APIPA), IPv6 unique-local (`fc00::/7`), and IPv6 link-local (`fe80::/10`) addresses because they identify the environment.
    /\b169\.254\.\d{1,3}\.\d{1,3}\b/,
    /(?:^|[\s"'`=([])\[?(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*[0-9a-f\]]/i,
];

export function hasShareabilitySensitiveText(text: string): boolean {
    try {
        if (sanitizeDiagnosticText(text) !== text) return true;
        return SHAREABILITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
    } catch {
        return true;
    }
}

/** `hasPortableSensitiveText` excludes host-specific path data, so identical input produces identical verdicts on every host.
 * */
export function hasPortableSensitiveText(text: string): boolean {
    try {
        if (redactSecretText(sanitizePathStringPortable(text)) !== text) return true;
        return SHAREABILITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
    } catch {
        return true;
    }
}

export function sanitizeConfigValue(value: unknown, keyPath: string[] = []): unknown {
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    const key = keyPath.at(-1) ?? "";
    if (key && isSecretKey(key)) {
        return `<REDACTED:${redactionTypeForKey(key)}>`;
    }
    if (typeof value === "string") return sanitizeDiagnosticText(value);
    if (Array.isArray(value)) {
        return value.map((entry, index) => sanitizeConfigValue(entry, [...keyPath, String(index)]));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
                entryKey,
                sanitizeConfigValue(entry, [...keyPath, entryKey]),
            ]),
        );
    }
    return value;
}
