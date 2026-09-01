/** `localeCompare` is locale-dependent; `<` compares UTF-16 code units, so identical inputs order identically on every machine. */
export function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
