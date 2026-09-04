export declare function stripJsonComments(content: string): string;
export declare function isPrototypePollutionKey(key: string): boolean;
export interface ParsedJsonSanitizerOptions {
    onRejectedKey?: (path: readonly (string | number)[]) => void;
}
/**
 * Copy parsed JSON into fresh own-property-only containers while rejecting keys
 * that can alter an object's prototype during a later merge. Rebuilding objects
 * also removes an already-polluted prototype produced by third-party parsers.
 */
export declare function sanitizeParsedJson<T>(value: T, options?: ParsedJsonSanitizerOptions, path?: readonly (string | number)[]): T;
export declare function parseJsonc<T = unknown>(content: string, options?: ParsedJsonSanitizerOptions): T;
export declare function readJsoncFile<T = unknown>(filePath: string): T | null;
export declare function detectConfigFile(basePath: string): {
    format: "json" | "jsonc" | "none";
    path: string;
};
//# sourceMappingURL=jsonc-parser.d.ts.map