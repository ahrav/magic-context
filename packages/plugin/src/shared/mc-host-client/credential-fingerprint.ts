import { createHmac } from "node:crypto";

const DOMAIN = "subc-broca-credential-v1";
const CANONICALIZATION = "harness-provider-name-length-value/1";
export const BROCA_CREDENTIAL_VALUE_CAP_BYTES = 16 * 1024;
export const BROCA_CREDENTIAL_ROW_CAP_BYTES = 64 * 1024;

const PROVIDER_ROWS = {
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GEMINI_API_KEY"],
    openai: ["OPENAI_API_KEY"],
} as const;

export const BROCA_CREDENTIAL_NAMES = Object.freeze(Object.values(PROVIDER_ROWS).flat());

function encoded(field: string): string {
    return `${Buffer.byteLength(field)}:${field}`;
}

export function canonicalCredentialRowEncoding(
    harness: "opencode" | "pi",
    provider: keyof typeof PROVIDER_ROWS,
    entries: readonly (readonly [string, string])[],
): string {
    let message = encoded(CANONICALIZATION) + encoded(harness) + encoded(provider);
    for (const [name, value] of entries) {
        message += encoded(name) + encoded(String(Buffer.byteLength(value))) + encoded(value);
    }
    return message;
}

export function credentialFingerprints(
    connectionKey: Uint8Array,
    harness: "opencode" | "pi",
    source: Record<string, string | undefined>,
): Readonly<Record<string, string>> {
    if (connectionKey.byteLength !== 32) {
        throw new TypeError("connection key must be exactly 32 bytes");
    }
    const derivedKey = createHmac("sha256", connectionKey).update(DOMAIN).digest();
    const fingerprints: Record<string, string> = {};
    for (const [provider, names] of Object.entries(PROVIDER_ROWS) as [
        keyof typeof PROVIDER_ROWS,
        readonly string[],
    ][]) {
        const entries: [string, string][] = [];
        let rowBytes = 0;
        let complete = true;
        for (const name of names) {
            const value = source[name];
            if (value === undefined || value.length === 0) {
                complete = false;
                break;
            }
            const valueBytes = Buffer.byteLength(value);
            if (valueBytes > BROCA_CREDENTIAL_VALUE_CAP_BYTES) {
                const error = new Error("credential value exceeds its size cap") as Error & {
                    code?: string;
                };
                error.code = "credential_value_too_large";
                throw error;
            }
            rowBytes += Buffer.byteLength(name) + valueBytes;
            if (rowBytes > BROCA_CREDENTIAL_ROW_CAP_BYTES) {
                const error = new Error("credential row exceeds its size cap") as Error & {
                    code?: string;
                };
                error.code = "credential_row_too_large";
                throw error;
            }
            entries.push([name, value]);
        }
        if (!complete) continue;
        const message = canonicalCredentialRowEncoding(harness, provider, entries);
        fingerprints[provider] = createHmac("sha256", derivedKey).update(message).digest("hex");
    }
    return Object.freeze(fingerprints);
}
