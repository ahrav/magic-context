import type { ContractPrimitives } from "../contract-primitives";
import type { SystemVersionTuple } from "./runner";

const SYSTEM_VERSION_TUPLE_KEYS = [
    "repoCommitSha",
    "bunVersion",
    "opencodeVersion",
    "historianModelId",
    "probeModelId",
    "parserImpl",
    "chunkTokenBudget",
] as const satisfies readonly (keyof SystemVersionTuple)[];

/**
 * `_keysComplete` fails to compile when `SystemVersionTuple` adds a key absent from `SYSTEM_VERSION_TUPLE_KEYS`.
 *
 * The `satisfies` clause above only proves each listed key exists, not that the list covers the type.
 */
type MissingKey = Exclude<keyof SystemVersionTuple, (typeof SYSTEM_VERSION_TUPLE_KEYS)[number]>;
const _keysComplete: MissingKey extends never ? true : never = true;
void _keysComplete;

/**
 * Parses a `SystemVersionTuple` with the caller's primitives so every lane report raises its own error class.
 *
 * One implementation keeps the historian, metamorphic, and scorecard consumers accepting the same bytes.
 */
export function parseSystemVersionTuple(p: ContractPrimitives, raw: unknown, label: string): SystemVersionTuple | null {
    if (raw === null) return null;
    const value = p.record(raw, label);
    p.exact(value, SYSTEM_VERSION_TUPLE_KEYS, label);
    if (value.parserImpl !== "ts") p.fail(`${label}.parserImpl: enum-invalid`);
    return {
        repoCommitSha: p.string(value.repoCommitSha, `${label}.repoCommitSha`),
        bunVersion: p.string(value.bunVersion, `${label}.bunVersion`),
        opencodeVersion: p.string(value.opencodeVersion, `${label}.opencodeVersion`),
        historianModelId: p.string(value.historianModelId, `${label}.historianModelId`),
        probeModelId: p.string(value.probeModelId, `${label}.probeModelId`),
        parserImpl: "ts",
        chunkTokenBudget: value.chunkTokenBudget === null ? null : p.integer(value.chunkTokenBudget, `${label}.chunkTokenBudget`, 1),
    };
}
