export declare function isSecretKey(key: string): boolean;
/** Host-independent path rewriting: only the generic user-home patterns,
 *  never the running host's homedir or username. Case-insensitive with both
 *  separator styles: Windows and macOS filesystems are case-insensitive and
 *  tools emit `c:/users/...` as readily as `C:\Users\...`. Callers that must
 *  produce identical results on every machine (release validation) use this;
 *  diagnostics that redact the local identity use `sanitizePathString`. */
export declare function sanitizePathStringPortable(value: string): string;
export declare function sanitizePathString(value: string): string;
export declare function redactSecretText(value: string): string;
export declare function sanitizeDiagnosticText(value: string): string;
export declare function hasShareabilitySensitiveText(text: string): boolean;
/** Host-independent variant of `hasShareabilitySensitiveText`: same secret
 *  and shareability patterns, but never the running host's homedir or
 *  username, so the verdict for a given string is identical on every
 *  machine. Release-artifact validation depends on that determinism. */
export declare function hasPortableSensitiveText(text: string): boolean;
export declare function sanitizeConfigValue(value: unknown, keyPath?: string[]): unknown;
//# sourceMappingURL=redaction.d.ts.map