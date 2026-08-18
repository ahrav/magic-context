import {
    type ExplicitQueryPreparation,
    prepareExplicitQuery,
} from "../../features/magic-context/search-bounds";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import type { CtxSearchArgs } from "./types";

export function normalizeCtxSearchArgs(rawArgs: CtxSearchArgs): CtxSearchArgs {
    return unwrapImitatedReducedArgs(rawArgs, ["query"], {
        query: "string",
        limit: "number",
        sources: {
            type: "array",
            items: "string",
            maxItems: 5,
            values: ["memory", "message", "git_commit", "primer", "note"],
        },
    });
}

/** Type-safe preflight over ALREADY-normalized args: a non-string query
 *  (e.g. { "query": 123 }) reads as missing instead of letting
 *  Buffer.byteLength throw a TypeError through every caller. */
export function prepareQueryFromNormalizedArgs(args: CtxSearchArgs): ExplicitQueryPreparation {
    return prepareExplicitQuery(typeof args.query === "string" ? args.query : "");
}

/** Exactly ONE normalization pass plus the type-safe preflight. Every
 *  consumer (live tool, recovery) must apply exactly one pass so a
 *  twice-wrapped reduced shape behaves identically in both: normalizing
 *  twice on one path and once on the other would let the live tool measure
 *  a query recovery can never reconstruct. */
export function extractCtxSearchQueryInput(rawArgs: CtxSearchArgs): ExplicitQueryPreparation {
    return prepareQueryFromNormalizedArgs(normalizeCtxSearchArgs(rawArgs));
}
