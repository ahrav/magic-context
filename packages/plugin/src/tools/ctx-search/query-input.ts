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

export function extractCtxSearchQueryInput(rawArgs: CtxSearchArgs): ExplicitQueryPreparation {
    // Persisted or model-supplied args can carry a non-string query (e.g.
    // { "query": 123 }); treat it like a missing query instead of letting
    // Buffer.byteLength throw a TypeError through every caller.
    const query = normalizeCtxSearchArgs(rawArgs).query;
    return prepareExplicitQuery(typeof query === "string" ? query : "");
}
