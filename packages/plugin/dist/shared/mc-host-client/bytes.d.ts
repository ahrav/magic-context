/**
 * Exact-length JSON byte-array validation shared by the handshake and
 * connection-file leaves: every element must be an own integer in
 * `[0, 255]`. Sparse holes, `null`, fractions, negatives, and values above
 * 255 are all rejected without coercion.
 *
 * Leaf module: no imports from connection or facade code.
 */
export declare function toExactByteArray(value: unknown, length: number): Uint8Array | null;
//# sourceMappingURL=bytes.d.ts.map