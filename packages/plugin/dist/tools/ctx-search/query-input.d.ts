import { type ExplicitQueryPreparation } from "../../features/magic-context/search-bounds";
import type { CtxSearchArgs } from "./types";
export declare function normalizeCtxSearchArgs(rawArgs: CtxSearchArgs): CtxSearchArgs;
/** Type-safe preflight over ALREADY-normalized args: a non-string query
 *  (e.g. { "query": 123 }) reads as missing instead of letting
 *  Buffer.byteLength throw a TypeError through every caller. */
export declare function prepareQueryFromNormalizedArgs(args: CtxSearchArgs): ExplicitQueryPreparation;
/** Exactly ONE normalization pass plus the type-safe preflight. Every
 *  consumer (live tool, recovery) must apply exactly one pass so a
 *  twice-wrapped reduced shape behaves identically in both: normalizing
 *  twice on one path and once on the other would let the live tool measure
 *  a query recovery can never reconstruct. */
export declare function extractCtxSearchQueryInput(rawArgs: CtxSearchArgs): ExplicitQueryPreparation;
//# sourceMappingURL=query-input.d.ts.map