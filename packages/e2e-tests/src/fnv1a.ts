/** FNV-1a over UTF-16 code units, returned as an unsigned 32-bit integer. */
export function fnv1a32(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
}
