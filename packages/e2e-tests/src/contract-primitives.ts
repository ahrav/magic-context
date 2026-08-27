/**
 * Shared fail-closed validator primitives for e2e artifact contracts.
 *
 * The prospective-holdout and historian-eval lanes both parse authored JSON
 * artifacts with the same fail-closed vocabulary (`object-required`,
 * `fields-invalid`, `string-invalid`, `id-invalid`, `integer-invalid`,
 * `duplicate`, ...). One implementation lives here so a hardening in one lane
 * cannot silently diverge from the other under identical diagnostic names.
 *
 * Each lane keeps its own error class (tests assert lane-specific
 * `instanceof`), so the primitives are built by a factory parameterized over
 * the error constructor. Diagnostics carry the label path and a code only —
 * never the offending artifact value (diagnostics are an output channel too).
 */

export const HEX64_RE = /^[0-9a-f]{64}$/;

export interface ContractErrorConstructor {
    new (diagnostics: readonly string[]): Error;
}

export interface ContractPrimitives {
    fail(code: string): never;
    record(value: unknown, label: string): Record<string, unknown>;
    exact(recordValue: Record<string, unknown>, keys: readonly string[], label: string): void;
    string(value: unknown, label: string): string;
    staticId(value: unknown, label: string, pattern: RegExp): string;
    hex64(value: unknown, label: string): string;
    enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T;
    array(value: unknown, label: string): unknown[];
    integer(value: unknown, label: string, minimum?: number): number;
    unique(values: readonly string[], label: string): void;
}

export function makeContractPrimitives(errorClass: ContractErrorConstructor): ContractPrimitives {
    function fail(code: string): never {
        throw new errorClass([code]);
    }

    function record(value: unknown, label: string): Record<string, unknown> {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            fail(`${label}: object-required`);
        }
        return value as Record<string, unknown>;
    }

    function exact(recordValue: Record<string, unknown>, keys: readonly string[], label: string): void {
        const actual = Object.keys(recordValue).sort();
        const expected = [...keys].sort();
        if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
            fail(`${label}: fields-invalid`);
        }
    }

    function stringValue(value: unknown, label: string): string {
        // Whitespace-only rejects for the same reason empty does. Production
        // transcript formatting trims a message and can discard it as empty, and
        // a blank probe question, answer, or choice is not scoreable — so a
        // formally valid frozen artifact would carry runtime input its gold
        // contract can never match. The authored value is returned unaltered:
        // trimming here would change the bytes a fingerprint covers.
        if (typeof value !== "string" || value.trim().length === 0) fail(`${label}: string-invalid`);
        return value;
    }

    function staticId(value: unknown, label: string, pattern: RegExp): string {
        const result = stringValue(value, label);
        if (!pattern.test(result)) fail(`${label}: id-invalid`);
        return result;
    }

    function hex64(value: unknown, label: string): string {
        const result = stringValue(value, label);
        if (!HEX64_RE.test(result)) fail(`${label}: fingerprint-invalid`);
        return result;
    }

    function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
        if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label}: enum-invalid`);
        return value as T;
    }

    function array(value: unknown, label: string): unknown[] {
        if (!Array.isArray(value)) fail(`${label}: array-required`);
        return value;
    }

    function integer(value: unknown, label: string, minimum = 0): number {
        if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label}: integer-invalid`);
        return value as number;
    }

    function unique(values: readonly string[], label: string): void {
        if (new Set(values).size !== values.length) fail(`${label}: duplicate`);
    }

    return { fail, record, exact, string: stringValue, staticId, hex64, enumeration, array, integer, unique };
}
