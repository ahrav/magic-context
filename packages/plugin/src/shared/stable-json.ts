/**
 * `stableStringify` sorts keys by UTF-16 code-unit order rather than `localeCompare`.
 *
 * Contract:
 * `bigint` values cause `JSON.stringify` to throw.
 * `stableStringify` returns `"[Circular]"` for any object encountered more than once.
 * `stableStringify` emits non-JSON output for `undefined` values.
 *
 * Used for:
 *
 */
export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    }
    // `<` and `>` compare UTF-16 code units, avoiding locale-sensitive ordering.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    });
    return `{${entries
        .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child, seen)}`)
        .join(",")}}`;
}
