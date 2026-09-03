/**
 *
 *
 */

import { compareCodeUnits } from "./code-unit-order";

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const REASON_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const GATE_ID_RE = /^gate-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ContractErrorConstructor {
    new (diagnostics: readonly string[]): Error;
}

/**
 * Builds a closed vocabulary from a `Record<T, true>` so the list is checked for completeness, not just membership.
 *
 * `[...] as const satisfies readonly T[]` only proves each element is a `T`; it does not require every `T` member.
 * A member missing from the record form is a type error, so a parser cannot silently reject a valid report.
 */
export function vocabulary<T extends string>(members: Record<T, true>): readonly T[] {
    return Object.keys(members) as T[];
}

export interface ContractPrimitives {
    fail(code: string): never;
    record(value: unknown, label: string): Record<string, unknown>;
    exact(recordValue: Record<string, unknown>, keys: readonly string[], label: string): void;
    string(value: unknown, label: string): string;
    /** Any string, including empty: for free-form fields where emptiness carries no meaning. `string` rejects blanks. */
    text(value: unknown, label: string): string;
    boolean(value: unknown, label: string): boolean;
    staticId(value: unknown, label: string, pattern: RegExp): string;
    hex64(value: unknown, label: string): string;
    enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T;
    array(value: unknown, label: string): unknown[];
    /** A finite number, optionally bounded on either side. */
    number(value: unknown, label: string, bounds?: { minimum?: number; maximum?: number }): number;
    integer(value: unknown, label: string, minimum?: number): number;
    /** An integer constrained on both sides, for a field whose producer has a published upper bound. */
    boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number;
    /** A `reason -> count` record. Counts are only ever reached by incrementing, so zero means corruption. */
    countRecord(raw: unknown, label: string): Record<string, number>;
    unique(values: readonly string[], label: string): void;
    /** Rejects an array the builder would have emitted in another order, which its own code-unit sort makes unreachable. */
    sorted<T>(values: readonly T[], rank: (value: T) => string, label: string): void;
    idArray(value: unknown, label: string, pattern: RegExp): string[];
    /** An array of free-form strings, each admitted by `text`. */
    textArray(value: unknown, label: string): string[];
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
        if (typeof value !== "string" || value.trim().length === 0) fail(`${label}: string-invalid`);
        return value;
    }

    function textValue(value: unknown, label: string): string {
        if (typeof value !== "string") fail(`${label}: string-invalid`);
        return value as string;
    }

    function booleanValue(value: unknown, label: string): boolean {
        if (typeof value !== "boolean") fail(`${label}: boolean-invalid`);
        return value as boolean;
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

    function numberValue(value: unknown, label: string, bounds: { minimum?: number; maximum?: number } = {}): number {
        if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}: number-invalid`);
        const result = value as number;
        if (bounds.minimum !== undefined && result < bounds.minimum) fail(`${label}: number-invalid`);
        if (bounds.maximum !== undefined && result > bounds.maximum) fail(`${label}: number-invalid`);
        return result;
    }

    function integer(value: unknown, label: string, minimum = 0): number {
        if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${label}: integer-invalid`);
        return value as number;
    }

    function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
        const result = integer(value, label, minimum);
        if (result > maximum) fail(`${label}: integer-invalid`);
        return result;
    }

    function countRecord(raw: unknown, label: string): Record<string, number> {
        const value = record(raw, label);
        return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, integer(count, `${label}.${key}`, 1)]));
    }

    function unique(values: readonly string[], label: string): void {
        if (new Set(values).size !== values.length) fail(`${label}: duplicate`);
    }

    function sorted<T>(values: readonly T[], rank: (value: T) => string, label: string): void {
        for (let index = 1; index < values.length; index += 1) {
            if (compareCodeUnits(rank(values[index - 1]!), rank(values[index]!)) > 0) fail(`${label}: order-invalid`);
        }
    }

    function idArray(value: unknown, label: string, pattern: RegExp): string[] {
        const values = array(value, label).map((entry, index) => staticId(entry, `${label}[${index}]`, pattern));
        unique(values, label);
        return values;
    }

    function textArray(value: unknown, label: string): string[] {
        return array(value, label).map((entry, index) => textValue(entry, `${label}[${index}]`));
    }

    return { fail, record, exact, string: stringValue, text: textValue, boolean: booleanValue, staticId, hex64, enumeration, array, number: numberValue, integer, boundedInteger, countRecord, unique, sorted, idArray, textArray };
}
