export declare const BROCA_CREDENTIAL_VALUE_CAP_BYTES: number;
export declare const BROCA_CREDENTIAL_ROW_CAP_BYTES: number;
declare const PROVIDER_ROWS: {
    readonly anthropic: readonly ["ANTHROPIC_API_KEY"];
    readonly google: readonly ["GEMINI_API_KEY"];
    readonly openai: readonly ["OPENAI_API_KEY"];
};
export declare const BROCA_CREDENTIAL_NAMES: readonly ("ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "OPENAI_API_KEY")[];
export declare function canonicalCredentialRowEncoding(harness: "opencode" | "pi", provider: keyof typeof PROVIDER_ROWS, entries: readonly (readonly [string, string])[]): string;
export declare function credentialFingerprints(connectionKey: Uint8Array, harness: "opencode" | "pi", source: Record<string, string | undefined>): Readonly<Record<string, string>>;
export {};
//# sourceMappingURL=credential-fingerprint.d.ts.map