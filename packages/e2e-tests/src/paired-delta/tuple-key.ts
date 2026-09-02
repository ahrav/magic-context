/**
 * Encode a two-part key whose parts are free-form.
 *
 * A `:`-joined key is ambiguous when either part may contain the separator, so distinct pairs could
 * collide onto one entry. JSON array encoding keeps them distinct, and having one implementation
 * means the escaping is right in one place rather than in each map that needs a compound key.
 */
export function tupleKey(first: string, second: string | null | undefined): string {
    return JSON.stringify([first, second ?? null]);
}
