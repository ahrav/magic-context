import {
    escapeRegex,
    hasShareabilitySensitiveText,
    isSecretKey,
    redactSecretText,
    sanitizeConfigValue,
    sanitizeDiagnosticText,
    sanitizePathString,
} from "@magic-context/core/shared/redaction";

export {
    escapeRegex,
    hasShareabilitySensitiveText,
    isSecretKey,
    redactSecretText,
    sanitizeConfigValue,
    sanitizeDiagnosticText,
    sanitizePathString,
};

export function sanitizeDiagnosticEndpoint(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return sanitizeDiagnosticText(value);
    try {
        const url = new URL(trimmed);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return sanitizeDiagnosticText(url.toString());
    } catch {
        const withoutQuery = trimmed.replace(/[?#].*$/, "");
        const withoutUserInfo = withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
        return sanitizeDiagnosticText(withoutUserInfo);
    }
}
