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
    return prepareExplicitQuery(normalizeCtxSearchArgs(rawArgs).query ?? "");
}
