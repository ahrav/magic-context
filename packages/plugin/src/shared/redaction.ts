import { homedir, userInfo } from "node:os";

/** Escape a literal string for interpolation into a RegExp. */
export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-segment match: the key (or its components when split on common
// separators) must BE one of these words, not merely contain them as a
// substring. Bare substring matching wrongly redacts benign fields like
// `pin_key_files`, `token_budget`, and `injection_budget_tokens`.
export const SECRET_WORDS = [
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
    return (
        key
            // `apiKey` needs camel-case splitting; lowercasing first produces
            // `apikey`, which no vocabulary word matches.
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(
                (segment) => SECRET_SEGMENT_PATTERN.test(segment) || SECRET_QUALIFIERS.has(segment),
            )
            .join("_") || "secret"
    );
}

// Do not redact numeric, boolean, null, or undefined values solely because their key contains a secret word.
function isNonSecretScalarValue(value: string): boolean {
    const v = value.trim();
    if (v === "true" || v === "false" || v === "null" || v === "undefined") return true;
    return /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v);
}

export const SECRET_QUALIFIERS = new Set([
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

/**
 * `isSecretKey` requires a qualifier segment before a secret word, which is right for
 * redaction: masking a benign field is a cosmetic loss, so it stays conservative.
 *
 * A configuration guard has the opposite failure cost — a missed credential is written to
 * disk — so it judges the key's final word instead, catching `masterKey`, `dbPassword`,
 * `webhookSecret`, and the glued `APIKEY` that no case transition splits.
 */
const CREDENTIAL_TAIL_WORDS = [
    "secret",
    "password",
    "passwd",
    "passphrase",
    "credential",
    "cookie",
    "authorization",
    "auth",
    "bearer",
    "dsn",
];

/**
 * `token` is the one credential word that also counts things, so it needs a rule rather
 * than a listing. The rule is inverted deliberately: a `*Token` key is credential-shaped
 * unless its qualifier names a quantity. An allowlist of issuers is open-ended — `botToken`,
 * `webhookToken`, `csrfToken`, and every future vendor's noun would have to be added, and a
 * missing entry writes a credential to disk — while the token-accounting vocabulary is small
 * and stable.
 */
const TOKEN_COUNTING_QUALIFIERS = [
    "max",
    "min",
    "total",
    "prompt",
    "completion",
    "input",
    "output",
    "cache",
    "cached",
    "budget",
    "limit",
    "count",
    "remaining",
    "used",
    "spent",
    "window",
    "context",
    "chunk",
    "sample",
    "estimated",
    "average",
    "avg",
    "num",
    "idle",
    "ideal",
    /** Named from this repository's own settings: `execute_threshold_tokens`, `injection_budget_tokens`, `max_input_tokens`. A tuning field rejected as a credential blocks the spawn outright. commentlint: allow(JUDGE) */
    "threshold",
];

/** `key` names a position in a data structure as often as a credential, and these qualifiers only ever mean the former. Kept closed and structural: anything not named here is treated as a credential, because a refused spawn is visible and a written credential is not. */
/** Words that name a credential when glued directly to `key`. Listed positively because the suffix alone carries no signal: an unrecognized glued word is left alone rather than treated as a secret, and a bare `key` remains a credential on its own. commentlint: allow(JUDGE) */
const CREDENTIAL_KEY_PREFIXES: readonly string[] = [
    "api",
    "access",
    "admin",
    "bearer",
    "cert",
    "db",
    "jwt",
    "oauth",
    "signature",
    "sql",
    "ssl",
    "tls",
    "auth",
    "client",
    "consumer",
    "encryption",
    "license",
    "master",
    "private",
    "root",
    "secret",
    "service",
    "session",
    "shared",
    "signing",
    "ssh",
    "subscription",
];

const STRUCTURAL_KEY_QUALIFIERS = [
    /** A public key is published by definition, and a caller cannot route one through `extraEnv` because it is not a secret; refusing the write blocked a legitimate field. `private` stays absent, so `privateKey` is still read as a credential. commentlint: allow(JUDGE) */
    "public",
    "fingerprint",
    "thumbprint",
    "foreign",
    "primary",
    "composite",
    "natural",
    "surrogate",
    "partition",
    "sort",
    "range",
    "index",
    "map",
    "hot",
    "short",
    "cache",
    "group",
];

export function isCredentialBearingConfigKey(key: string): boolean {
    if (isSecretKey(key)) return true;
    const allSegments = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    /** A trailing descriptor names the field, not the thing: `dbPasswordValue` and `masterKeyId` are the credential their descriptor points at, and `primaryKeyId` is the structural key its descriptor points at. `isSecretKey` reads them the same way. commentlint: allow(JUDGE) */
    const segments = [...allSegments];
    while (segments.length > 1 && TRAILING_DESCRIPTORS.has(segments.at(-1) as string)) {
        segments.pop();
    }
    // Separators are dropped rather than split on, so `APIKEY` is judged like `api_key`.
    let compact = segments.join("");
    /** An all-caps glued name gives the camel-case split nothing to break on, so `DBPASSWORDVALUE` arrives as one segment and the loop above cannot reach its descriptor. Peeling the descriptor off the compacted form reads it the same way `dbPasswordValue` is read. commentlint: allow(JUDGE) */
    for (;;) {
        /** Descriptors and enumerators peel in one loop because either can be outermost: `apiKey2Value` ends in a descriptor while `apiKeyValue2` ends in a digit, and stripping only one kind first left the other stranded behind it — `apikeyvalue` matches no credential tail. An enumerator distinguishes a rotated pair, it does not change what the field holds. commentlint: allow(JUDGE) */
        const trimmedEnumerator = compact.replace(/[0-9]+$/, "");
        const candidate = trimmedEnumerator.length > 0 ? trimmedEnumerator : compact;
        const descriptor = [...TRAILING_DESCRIPTORS].find(
            (word) => candidate.length > word.length && candidate.endsWith(word),
        );
        const next = descriptor === undefined ? candidate : candidate.slice(0, -descriptor.length);
        if (next === compact) break;
        compact = next;
    }
    // The qualifier is read from the adjacent segment, not from any prefix of the compacted
    // key: `identityTokens` and `idleTokens` both begin with `id`.
    const qualifier = segments.length > 1 ? segments.at(-2) : undefined;
    const endsWith = (word: string): boolean =>
        // Plurals are derived rather than listed, so `dbPasswords` cannot slip past a
        // singular entry.
        compact.endsWith(word) || compact.endsWith(`${word}s`);
    if (endsWith("key")) {
        if (qualifier !== undefined) return !STRUCTURAL_KEY_QUALIFIERS.includes(qualifier);
        // A glued name has no segment to read, so the whole word decides. `monkey` and
        // `turkey` end in these letters without naming a key at all, so a glued credential
        // has to be recognized positively rather than by ruling out structural words:
        // `apikey` is a credential, `hotkey` is a keystroke, `monkey` is neither.
        return CREDENTIAL_KEY_PREFIXES.some(
            (word) => compact === `${word}key` || compact === `${word}keys`,
        );
    }
    if (CREDENTIAL_TAIL_WORDS.some(endsWith)) return true;
    if (!endsWith("token")) return false;
    if (qualifier === undefined) return true;
    /** A counting qualifier excuses a count, and a count is plural: `cachedTokens` reports usage while `cacheToken` names one bearer token. Reading the qualifier without the number let a singular credential inherit the exemption. commentlint: allow(JUDGE) */
    if (!compact.endsWith("tokens")) return true;
    return !TOKEN_COUNTING_QUALIFIERS.includes(qualifier);
}

/**
 * Named credential formats, not entropy guessing: each pattern is a shape a credential
 * announces about itself, so a match can be reported by format name without ever putting
 * the value in a diagnostic.
 */
const CREDENTIAL_VALUE_FORMATS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    /** One opaque payload, long enough to be a credential and end-anchored: `Basic auth is optional here` is prose, not a header value. commentlint: allow(JUDGE) */
    {
        label: "HTTP authorization scheme",
        pattern: /^(?:bearer|basic|digest|token)\s+[A-Za-z0-9+/_=.~-]{16,}$/i,
    },
    /** Matched at a token boundary anywhere in the value rather than only at its start. A vendor prefix is distinctive enough that finding one mid-string identifies a credential, and requiring position zero meant any leading text — a comment, a resolved placeholder, a label — defeated every rule at once. The lookbehind keeps a prefix from matching inside a longer opaque run, where it would be a coincidence rather than a token. commentlint: allow(JUDGE) */
    { label: "JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
    // Ordered before the general `sk-` shape, which would otherwise claim it.
    { label: "Anthropic-style key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,}/ },
    { label: "OpenAI-style key", pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/ },
    /** Ordered before the `gh*_` shape, whose character class cannot reach the `i` in `github_pat_`. commentlint: allow(JUDGE) */
    {
        label: "GitHub fine-grained token",
        pattern: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}/,
    },
    { label: "GitHub token", pattern: /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{20,}/ },
    { label: "AWS access key id", pattern: /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[0-9A-Z]{12,}/ },
    { label: "Google API key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,}/ },
    { label: "Hugging Face token", pattern: /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,}/ },
    /** The same prefix set `SECRET_TEXT_PATTERNS` redacts: `xoxu`, `xoxv`, and `xoxc` are user, bot-refresh, and browser-session tokens, and `xapp-` is the app-level token, none of them less usable than the `xoxb` shape. commentlint: allow(JUDGE) */
    { label: "Slack token", pattern: /(?<![A-Za-z0-9_-])(?:xox[abprsuvc]|xapp)-[0-9A-Za-z-]{10,}/ },
    { label: "PEM private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    /** Any userinfo at all: the password may be empty (`redis://:secret@host`) or absent (`https://ghp_token@host`), and a bare token in the username position is the shape a personal access token takes. commentlint: allow(JUDGE) */
    {
        label: "credential-bearing URI",
        pattern: /(?<![A-Za-z0-9_-])[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i,
    },
];

/** Returns the format a value announces itself as, or null. The label never contains the value. */
export function credentialValueFormat(value: string): string | null {
    const trimmed = value.trim();
    return CREDENTIAL_VALUE_FORMATS.find(({ pattern }) => pattern.test(trimmed))?.label ?? null;
}

/** Parameter names by which the major signed-URL schemes carry their bearer signature: Azure SAS `sig`, SigV4 `x-amz-signature`, Google `signature`. A signed URL's signature *is* the credential — it is bearer authority for the request — and it announces itself by parameter name rather than by value shape, because a base64 signature matches no vendor prefix. Recognized only inside a URL, not by `isCredentialBearingConfigKey`, because `signature` names a legitimate config field elsewhere while in a query it grants access. commentlint: allow(JUDGE) */
const SIGNED_URL_CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
    "sig",
    "signature",
    "x-amz-signature",
    "x-goog-signature",
    "x-sap-signature",
]);

/** A segment that is not valid percent-encoding is judged as written rather than refused: `decodeURIComponent` throws on a stray `%`, and a malformed escape is not itself a credential. commentlint: allow(JUDGE) */
function decodeUrlPart(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

/**
 * Names a credential carried by a URL's own structure, or null when it carries none.
 *
 * `credentialValueFormat` anchors its rules at the start of the whole value, so a credential
 * parked in a hostname label, a path segment, a query parameter, or a fragment matches
 * neither a vendor prefix nor the userinfo rule. Each of those is its own namespace and is
 * judged here with the same value rules the config channels use: labels and segments carry no
 * key, so they are offered whole under an empty key; a fragment that is key-value shaped is
 * parsed as pairs, and one that is not is offered whole. Values that do not parse as a URL
 * carry no such namespace and are left to the whole-value rules.
 * commentlint: allow(JUDGE)
 */
export function urlCredentialFinding(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    const pairs: Array<[string, string]> = [...url.hostname.split("."), ...url.pathname.split("/")]
        .filter((part) => part.length > 0)
        .map((part) => ["", decodeUrlPart(part)] as [string, string]);
    pairs.push(...url.searchParams.entries());
    const fragment = url.hash.replace(/^#/, "");
    if (fragment.length > 0) {
        if (/[=&]/.test(fragment)) {
            pairs.push(...new URLSearchParams(fragment).entries());
        } else {
            pairs.push(["", decodeUrlPart(fragment)]);
        }
    }
    for (const [key, part] of pairs) {
        if (SIGNED_URL_CREDENTIAL_PARAMS.has(key.toLowerCase())) {
            return `signed-URL credential parameter ${key}`;
        }
        if (key.length > 0 && isCredentialBearingConfigKey(key)) {
            return `credential-shaped query key ${key}`;
        }
        const format = credentialValueFormat(part);
        if (format !== null) {
            return key.length > 0
                ? `${format} value in query key ${key}`
                : `${format} value in a URL component`;
        }
    }
    return null;
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
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
        replacement: "<AWS_ACCESS_KEY_ID_REDACTED>",
    },
    {
        pattern: /\b(?:xox[abprsuvc]|xapp)-[A-Za-z0-9-]{10,}/g,
        replacement: "<SLACK_TOKEN_REDACTED>",
    },
    {
        pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9])/g,
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
