/**
 *
 *
 */
export function isValidSemver(version: string): boolean {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

/**
 */
export function compareSemverCore(a: string, b: string): number | null {
    if (!isValidSemver(a) || !isValidSemver(b)) return null;
    const core = (v: string) =>
        v
            .split(/[-+]/, 1)[0]
            .split(".")
            .map((n) => Number.parseInt(n, 10));
    const [a0, a1, a2] = core(a);
    const [b0, b1, b2] = core(b);
    return a0 - b0 || a1 - b1 || a2 - b2;
}
