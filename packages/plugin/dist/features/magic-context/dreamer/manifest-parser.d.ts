/** Extract the complete root element body for Dreamer XML manifests.
 *  A missing closing root is treated as truncation and rejects the whole output,
 *  so a length-capped model response can never apply a prefix of mutations. */
export declare function extractCompleteManifestBody(text: string, rootName: string): string;
export declare function assertNoDuplicateManifestIds(ids: readonly (number | string)[], rootName: string): void;
export declare function assertManifestCoversExactly<T extends number | string>(ids: readonly T[], expectedIds: ReadonlySet<T>, rootName: string): void;
/** Name the shape a model actually emitted when a Dreamer parser found zero
 *  entries. Wrong-but-rooted output (`<map>`, JSON array, `<mapping>`) used to
 *  parse as `[]` and pass validation, so the fallback-model chain never fired.
 *  The message is thrown inside `validateOutput` and must name what was found. */
export declare function describeUnrecognizedManifestShape(text: string, expectedRoot: string, expectedEntry: string): string;
/** Reject a zero-entry parse when the caller asked for a non-empty batch.
 *  Empty output against a non-empty request must be retry-visible. */
export declare function assertParsedManifestNonEmpty(parsedCount: number, expectedCount: number, text: string, expectedRoot: string, expectedEntry: string): void;
//# sourceMappingURL=manifest-parser.d.ts.map