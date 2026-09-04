/**
 * Process-local deterministic JSON serialization for JSON-like plain
 * objects. Keys are sorted by code-point order (NOT locale-sensitive).
 *
 * Contract:
 * - Stable for plain objects, arrays, primitives, and `null`.
 * - `undefined` serialized as the string "undefined".
 * - Circular references serialized as the string `"[Circular]"`.
 * - **NOT** a canonical cross-runtime / cross-locale JSON serializer.
 *   Two different runtimes that disagree on `JSON.stringify` of primitives
 *   (none known today) would produce different output.
 *
 * Used for:
 * - `tool_definition_measurements` fingerprint hashing
 * - `pending_compaction_marker_state` CAS comparison
 *
 * If a future use case needs true canonical JSON (e.g. cross-process
 * signing), build a separate utility — do NOT widen this contract.
 */
export declare function stableStringify(value: unknown, seen?: WeakSet<object>): string;
//# sourceMappingURL=stable-json.d.ts.map