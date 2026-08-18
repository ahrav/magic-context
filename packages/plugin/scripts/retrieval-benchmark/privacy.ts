/**
 * Rejecting privacy gate for benchmark artifacts.
 *
 * Reject a field (instead of rewriting it) when sanitizeDiagnosticText would
 * change it, when it matches a shareability-sensitive pattern, or when it
 * carries a corpus-specific residual signal: normalized query hash, session
 * id, source path, control character, or seeded identifying token.
 * Violations name only the JSON path and a category code — the value itself
 * never reaches any output channel.
 */

import {
    hasShareabilitySensitiveText,
    sanitizeDiagnosticText,
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
const HASH_LIKE = /\b[0-9a-f]{64}\b/i;
const SESSION_ID = /\bses[_-][A-Za-z0-9]{8,}/;
const SOURCE_PATH = /(?:\/home\/|\/Users\/|C:\\Users\\|(?:^|\s)~\/)/;

function scanString(
    value: string,
    path: string,
    forbiddenTokens: readonly string[],
    violations: PrivacyViolation[],
    skipHashCheck = false,
): void {
    if (CONTROL_CHARS.test(value)) violations.push({ path, category: "control-character" });
    if (sanitizeDiagnosticText(value) !== value) {
        violations.push({ path, category: "secret-or-path" });
    } else if (hasShareabilitySensitiveText(value)) {
        violations.push({ path, category: "shareability" });
    }
    if (!skipHashCheck && HASH_LIKE.test(value)) {
        violations.push({ path, category: "hash-like" });
    }
    if (SESSION_ID.test(value)) violations.push({ path, category: "session-id" });
    if (SOURCE_PATH.test(value)) violations.push({ path, category: "source-path" });
    const lower = value.toLowerCase();
    for (const token of forbiddenTokens) {
        if (token.length > 0 && lower.includes(token.toLowerCase())) {
            violations.push({ path, category: "forbidden-token" });
            break;
        }
    }
}

function scanValue(
    value: unknown,
    path: string,
    forbiddenTokens: readonly string[],
    violations: PrivacyViolation[],
): void {
    if (typeof value === "string") {
        scanString(value, path, forbiddenTokens, violations);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => scanValue(item, `${path}[${i}]`, forbiddenTokens, violations));
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            // A sensitive KEY must not be echoed through violation paths
            // (paths are an output channel), so its own violation and every
            // descendant path use a redacted segment instead of the literal.
            const keyProbe: PrivacyViolation[] = [];
            scanString(key, `${path}.<redacted-key>`, forbiddenTokens, keyProbe);
            violations.push(...keyProbe);
            const segment = keyProbe.length > 0 ? "<redacted-key>" : key;
            if (typeof child === "string" && FINGERPRINT_FIELDS.has(key)) {
                scanString(child, `${path}.${segment}`, forbiddenTokens, violations, true);
                continue;
            }
            scanValue(child, `${path}.${segment}`, forbiddenTokens, violations);
        }
    }
}

/** Return detected path/category violations; empty means promotable under
 *  this policy version. Defense in depth, not an anonymity proof — human
 *  review still gates promotion. */
export function scanForSensitiveContent(
    artifact: unknown,
    options: { forbiddenTokens?: readonly string[] } = {},
): PrivacyViolation[] {
    const violations: PrivacyViolation[] = [];
    scanValue(artifact, "$", options.forbiddenTokens ?? [], violations);
    return violations;
}
