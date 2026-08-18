/**
 * Rejecting privacy gate for benchmark artifacts.
 *
 * Reject a field (instead of rewriting it) when the host-independent secret
 * or path sanitizers would change it, when it matches a shareability-
 * sensitive pattern, or when it carries a corpus-specific residual signal:
 * normalized query hash, session id, source path, control character, or
 * seeded identifying token. Every check is deterministic across machines —
 * the loader host's username and home directory never participate; the
 * author host's identity enters through `forbiddenTokens` at recovery time.
 * Violations name only the JSON path and a category code — the value itself
 * never reaches any output channel.
 */

import {
    hasPortableSensitiveText,
    redactSecretText,
    sanitizePathStringPortable,
} from "../../src/shared/redaction";

export const PRIVACY_POLICY_VERSION = "privacy-policy/v1";
export const SANITIZER_VERSION = "sanitizer/v1";

export interface PrivacyViolation {
    path: string;
    category:
        | "secret-or-path"
        | "shareability"
        | "control-character"
        | "hash-like"
        | "session-id"
        | "source-path"
        | "forbidden-token";
}

/** String values under these keys skip ONLY the hash-like check so declared
 *  artifact fingerprints pass; every other category still applies to them. */
const FINGERPRINT_FIELDS = new Set([
    "corpusFingerprint",
    "judgmentsFingerprint",
    "syntheticProfilesFingerprint",
    "releaseTupleFingerprint",
    "manifestFingerprint",
    "streamHash",
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control-character rejection is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Hex-specific boundaries, not \b: underscore is a word character, so
// `query_hash_<64hex>` would otherwise slip the boundary.
const HASH_LIKE = /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/;
// Identifier-alphabet boundary, not \b: `source_session_ses_...` keeps the
// id behind a word character, which \b cannot cross.
const SESSION_ID = /(?:^|[^A-Za-z0-9])ses[_-][A-Za-z0-9]{8,}/;
// `~/` counts as a home path unless it directly follows a word character, so
// quoted ("~/notes"), bracketed ((~/f)), and delimiter-preceded (path=~/x,
// source:~/dir) spellings are caught, not only start-of-string/whitespace.
// Case-insensitive with both separators: Windows and macOS paths are
// case-insensitive and tools emit `c:/users/...` as readily as `C:\Users\`.
const SOURCE_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/]|(?:^|[^\w.-])~\/)/i;
// Identifying paths are not only home-rooted: `/workspace/customer-x/src`,
// `/Client Work/repo`, `/用户/客户/repo`, `D:\Client Work\repo`, or UNC
// shares in either separator form (`\\server\share\...`,
// `//server/share/...`) carry the same signal. This is a rejecting gate, so
// over-matching costs a review, never a leak.
// No trailing separator required: `D:\customer-x` alone is identifying.
// The UNC arm accepts either separator at the share boundary
// (\\server\share and \\server/share are the same path), and a single
// leading backslash (root-relative `\Client Work\repo`) counts too —
// path.win32.isAbsolute classifies both as absolute.
const WINDOWS_PATH =
    /(?:[A-Za-z]:[\\/][^\s\\/][^\\/\r\n]*|\\\\[\w.-]+[\\/][^\\/\r\n]+|(?:^|[^\w\\])\\[^\s\\/][^\\/\r\n]*)/;
// A file: URI is a local absolute path in URI clothing; the triple-slash
// form defeats the delimiter-anchored POSIX arm, so name it directly.
const FILE_URI = /\bfile:\/\//i;
// Extended-length Windows prefix (\\?\C:\..., \\?\UNC\server\share):
// always a path, and the `?` defeats the server-name class above.
const EXTENDED_LENGTH_PATH = /\\\\\?\\/;
// No ":" in this delimiter class: `scheme://host/...` URLs must not read as
// forward-slash UNC shares.
// Complement boundary (anything that cannot CONTINUE a token), not a
// delimiter allowlist: ":" stays excluded so scheme URLs never read as
// forward UNC.
const UNC_FORWARD = /(?:^|[^\w:./])\/\/[\w.-]+\/[^/\s]+/;
// Absolute POSIX paths (single components included: `/customer-x` is
// identifying), matched broadly and then verified segment-wise so prose
// around standalone slashes stays clean. Slash-command spellings
// (`/like-this`) reject too — a rejecting gate trades a lost candidate for
// never leaking a workspace name.
// Complement boundary: any character that cannot continue a token starts a
// candidate (comma, braces, markup, quotes, ...), instead of an allowlist
// that keeps missing punctuation. Word chars keep "and/or" clean, "." keeps
// relative "./x" clean, "*" keeps globs ("**/*.ts") clean, "/" keeps
// mid-path positions from re-anchoring; URLs stay clean through the
// empty-first-segment check below.
const POSIX_PATH_CANDIDATE = /(?:^|[^\w./*-])((?:\/[^/\r\n]+)+)/g;

function hasAbsolutePath(value: string): boolean {
    if (
        WINDOWS_PATH.test(value) ||
        UNC_FORWARD.test(value) ||
        FILE_URI.test(value) ||
        EXTENDED_LENGTH_PATH.test(value)
    ) {
        return true;
    }
    for (const match of value.matchAll(POSIX_PATH_CANDIDATE)) {
        const segments = match[1].split("/").slice(1);
        // Real path components carry no leading/trailing whitespace; prose
        // like "either / this / that" does.
        if (segments.every((segment) => segment.length > 0 && segment === segment.trim())) {
            return true;
        }
    }
    return false;
}

interface ForbiddenMatchers {
    tokens: readonly string[];
    identifiers: readonly RegExp[];
}

function scanString(
    value: string,
    path: string,
    forbidden: ForbiddenMatchers,
    violations: PrivacyViolation[],
    skipHashCheck = false,
): void {
    if (CONTROL_CHARS.test(value)) violations.push({ path, category: "control-character" });
    // Host-independent checks only: the same bytes must pass or fail on every
    // machine, or release validity would depend on the loader's username and
    // home directory. Author-host identity is checked at recovery time, where
    // the operator supplies it through `forbiddenTokens`.
    if (redactSecretText(sanitizePathStringPortable(value)) !== value) {
        violations.push({ path, category: "secret-or-path" });
    } else if (hasPortableSensitiveText(value)) {
        violations.push({ path, category: "shareability" });
    }
    if (!skipHashCheck && HASH_LIKE.test(value)) {
        violations.push({ path, category: "hash-like" });
    }
    if (SESSION_ID.test(value)) violations.push({ path, category: "session-id" });
    if (SOURCE_PATH.test(value) || hasAbsolutePath(value)) {
        violations.push({ path, category: "source-path" });
    }
    const lower = value.toLowerCase();
    const tokenHit = forbidden.tokens.some(
        (token) => token.length > 0 && lower.includes(token.toLowerCase()),
    );
    // Identifiers match as bounded words, not substrings: a username "dev"
    // must not reject "development" or "device". A username that is itself
    // an ordinary standalone word still rejects — the safe direction for a
    // rejecting gate.
    if (tokenHit || forbidden.identifiers.some((pattern) => pattern.test(value))) {
        violations.push({ path, category: "forbidden-token" });
    }
}

function scanValue(
    value: unknown,
    path: string,
    forbidden: ForbiddenMatchers,
    violations: PrivacyViolation[],
): void {
    if (typeof value === "string") {
        scanString(value, path, forbidden, violations);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => scanValue(item, `${path}[${i}]`, forbidden, violations));
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            // A sensitive KEY must not be echoed through violation paths
            // (paths are an output channel), so its own violation and every
            // descendant path use a redacted segment instead of the literal.
            const keyProbe: PrivacyViolation[] = [];
            scanString(key, `${path}.<redacted-key>`, forbidden, keyProbe);
            violations.push(...keyProbe);
            const segment = keyProbe.length > 0 ? "<redacted-key>" : key;
            if (typeof child === "string" && FINGERPRINT_FIELDS.has(key)) {
                scanString(child, `${path}.${segment}`, forbidden, violations, true);
                continue;
            }
            scanValue(child, `${path}.${segment}`, forbidden, violations);
        }
    }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return detected path/category violations; empty means promotable under
 *  this policy version. Defense in depth, not an anonymity proof — human
 *  review still gates promotion. */
export function scanForSensitiveContent(
    artifact: unknown,
    options: {
        /** Substring deny list (project codenames, home-directory paths). */
        forbiddenTokens?: readonly string[];
        /** Word-bounded deny list (usernames): matches only as a standalone
         *  identifier or path component, never inside a longer word. */
        forbiddenIdentifiers?: readonly string[];
    } = {},
): PrivacyViolation[] {
    const violations: PrivacyViolation[] = [];
    const identifiers = (options.forbiddenIdentifiers ?? [])
        .filter((token) => token.length > 0)
        .map((token) => new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegex(token)}(?:[^A-Za-z0-9_]|$)`, "i"));
    scanValue(
        artifact,
        "$",
        { tokens: options.forbiddenTokens ?? [], identifiers },
        violations,
    );
    return violations;
}
