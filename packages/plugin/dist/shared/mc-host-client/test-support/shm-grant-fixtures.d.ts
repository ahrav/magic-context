/**
 * Avoid `bun:test` so non-Bun test suites can import these helpers.
 */
import { ShmGrantError, type ShmGrantErrorCode } from "../shm-grant";
export declare function grantHex(overrides?: Partial<{
    layoutVersion: number;
    incarnation: number;
    lane: number;
    depth: bigint;
    arena: bigint;
    maxLeases: bigint;
    total: bigint;
    reserved: number;
}>): string;
/** Runs `fn`, requiring it to throw a `ShmGrantError` with exactly `code`. */
export declare function expectGrantCode(fn: () => unknown, code: ShmGrantErrorCode): ShmGrantError;
//# sourceMappingURL=shm-grant-fixtures.d.ts.map