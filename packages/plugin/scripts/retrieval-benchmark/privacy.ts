/**
 * The gate rejects privacy-sensitive benchmark artifacts.
 *
 * The gate rejects rather than rewrites fields changed by portable secret/path sanitizers or matching shareability-sensitive or corpus-specific signals; loader-host identities are excluded, and recovery supplies author-host tokens through `forbiddenTokens`.
 */

import {
    hasPortableSensitiveText,
    redactSecretText,
    sanitizePathStringPortable,
} from "../../src/shared/redaction";
import { escapeRegex } from "../../src/shared/redaction";

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

/** `FINGERPRINT_FIELDS` values skip only `HASH_LIKE`; all other checks still apply.
 * */
const FINGERPRINT_FIELDS = new Set([
    "corpusFingerprint",
    "judgmentsFingerprint",
    "syntheticProfilesFingerprint",
    "releaseTupleFingerprint",
    "manifestFingerprint",
    "streamHash",
    "releaseRootManifestFingerprint",
    "releaseIdentityFingerprint",
    "immutableReference",
    "sourceFingerprint",
    "lockfileFingerprint",
    "artifactFingerprint",
    "runtimeFingerprint",
    "harnessFingerprint",
    "policyFingerprint",
    "eligibleSuiteRegistryFingerprint",
    "evaluatorFingerprint",
    "rubricFingerprint",
    "reviewedFingerprint",
    "evidenceFingerprint",
    "decodingFingerprint",
    "promptFingerprint",
    "subjectFingerprint",
    "freezeManifestFingerprint",
    "caseCommitment",
    "scenarioFingerprint",
    "subjectiveMapCommitment",
    "retentionEvidenceFingerprint",
    "custodyEvidenceFingerprint",
    "previousEventFingerprint",
    "rootFingerprint",
    "expectedRootFingerprint",
    "observedRootFingerprint",
    "implementationFingerprint",
    "packetFingerprint",
    "reportFingerprint",
    "closeManifestFingerprint",
    "analysisPolicyFingerprint",
    "scorecardPolicyFingerprint",
    "pairedFactsFingerprint",
    "estimatorResultFingerprint",
    "scorecardResultFingerprint",
    "dispositionFingerprint",
    "close_manifest_fingerprint",
    "case_commitment",
    "incident_bytes_fingerprint",
    "subject_fingerprint",
    "releaseFingerprint",
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control-character rejection is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// `HASH_LIKE` uses hex-specific rather than `\b` boundaries because underscore is a word character, so it detects `query_hash_<64hex>`.
const HASH_LIKE = /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/;
// `SESSION_ID` uses identifier-alphabet rather than `\b` boundaries because a word character can precede `ses_...`.
const SESSION_ID = /(?:^|[^A-Za-z0-9])ses[_-][A-Za-z0-9]{8,}/;
// `~/` matches only at the start or after a character other than a word character, `.` or `-`.
// `SOURCE_PATH` catches quoted, bracketed, and delimiter-preceded `~/` paths, not only paths at the start of a string or after whitespace.
// `SOURCE_PATH` is case-insensitive and accepts both separators, detecting `c:/users/...` and `C:\Users\`.
const SOURCE_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/]|(?:^|[^\w.-])~\/)/i;
// The gate rejects identifying paths outside home directories, including workspace, client-work, and UNC paths, because it rejects fields rather than rewriting them.
// `WINDOWS_PATH` matches `D:\customer-x` without a trailing separator.
// UNC shares accept either separator at the share boundary.
// Root-relative `\Client Work\repo` is absolute under `path.win32.isAbsolute`.
const WINDOWS_PATH =
    /(?:[A-Za-z]:[\\/][^\s\\/][^\\/\r\n]*|\\\\[\w.-]+[\\/][^\\/\r\n]+|(?:^|[^\w\\])\\[^\s\\/][^\\/\r\n]*)/;
// `FILE_URI` matches `file://` because `file:///...` bypasses the POSIX candidate boundary.
const FILE_URI = /\bfile:\/\//i;
// `EXTENDED_LENGTH_PATH` matches `\\?\` because its `?` prevents `WINDOWS_PATH` from recognizing extended-length paths.
const EXTENDED_LENGTH_PATH = /\\\\\?\\/;
// `UNC_FORWARD` excludes `:` from its boundary so `scheme://host/...` does not match a forward-slash UNC path.
// forward UNC.
const UNC_FORWARD = /(?:^|[^\w:./])\/\/[\w.-]+\/[^/\s]+/;
// `hasAbsolutePath` treats single-component absolute POSIX paths such as `/customer-x` as identifying.
// `hasAbsolutePath` verifies every component after broad matching to reject slash-delimited prose with whitespace.
// Excluding word characters prevents `and/or` from matching as a path.
// Excluding `.` and `*` prevents `./x` and `**/*.ts` from matching.
// Excluding `/` prevents re-anchoring within an existing path.
// A leading empty segment rejects `//host`.
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
    // `scanString` uses host-independent checks so identical bytes have identical validation results.
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
    // `forbidden.identifiers` matches identifiers as bounded words so `dev` does not match `development` or `device`.
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
            // A key that matches `forbidden` uses `<redacted-key>` in its violation path because paths are an output channel.
            // Every descendant path of a key that matches `forbidden` uses `<redacted-key>`.
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


/**
 * */
export function scanForSensitiveContent(
    artifact: unknown,
    options: {
        /* */
        forbiddenTokens?: readonly string[];
        /**
         * */
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
