/**
 * Exact-length JSON byte-array validation shared by the handshake and
 * connection-file leaves: every element must be an own integer in
 * `[0, 255]`. Sparse holes, `null`, fractions, negatives, and values above
 * 255 are all rejected without coercion.
 *
 * Leaf module: no imports from connection or facade code.
 */
export function toExactByteArray(value: unknown, length: number): Uint8Array | null {
    if (!Array.isArray(value) || value.length !== length) return null;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(value, i)) return null;
        const element: unknown = value[i];
        if (typeof element !== "number" || !Number.isInteger(element)) return null;
        if (element < 0 || element > 255) return null;
        bytes[i] = element;
    }
    return bytes;
}
