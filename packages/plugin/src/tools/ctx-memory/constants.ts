import { WRITABLE_MEMORY_CATEGORIES } from "../../features/magic-context/memory/constants";
import type { ImitatedArgRule, ImitatedArgsSchema } from "../unwrap-imitated-reduced-args";
import { CTX_MEMORY_DREAMER_ACTIONS } from "./types";

export const CTX_MEMORY_TOOL_NAME = "ctx_memory";
export const CTX_MEMORY_DESCRIPTION = `Durable project memories shared across sessions, served by the memory daemon.

Memories are addressed by object id (mem_<32hex>). revise and merge supersede their targets with one new object and return its id; no token is passed. A result starting with "Error:" names the memory state and what to do next.

Actions:
- create: content + category, or antiMemory.
- get: up to 20 object ids; hidden and missing objects read the same.
- list: visible memories (dreamer maintenance only).
- revise: objectId + content/category or antiMemory.
- archive: objectId.
- merge: objectIds into one survivor + content/category or antiMemory.

Memories created here surface in the project's automatic memory context and in explicit search. Agent calls to approve/enforce are rejected.`;
export const DEFAULT_SEARCH_LIMIT = 10;
export const GET_MAX_CLAIMS = 20;
/** Byte budget for the memories a get/list response serializes, matching the ~16 KiB scale of ctx_search's 4096-token render budget; entries past the budget are elided and reported. commentlint: allow(JUDGE) */
export const CTX_MEMORY_RESPONSE_BUDGET_BYTES = 16 * 1024;
/** Merge emits one `supersede_decision` per target; the cap keeps a schema-valid request from failing only at the daemon's envelope limit. */
export const MERGE_MAX_TARGETS = 20;

/**
 */
export const CTX_MEMORY_ANTI_MEMORY_RULE: ImitatedArgRule = {
    type: "object",
    fields: {
        trigger: "string",
        rejectedStrategy: "string",
        rejectionReason: "string",
    },
    optionalFields: {
        saferAlternative: "string",
        preconditions: "string",
        attemptedApproach: "string",
        observedFailure: "string",
        rootCause: "string",
        recovery: "string",
        nonApplicableWhen: "string",
        expiresAt: "number",
    },
};

/** How each `ctx_memory` argument is recovered from a reduced-args wrapper; every host registers the tool against this one table. */
export const CTX_MEMORY_UNWRAP_RULES: ImitatedArgsSchema = {
    action: { type: "enum", values: CTX_MEMORY_DREAMER_ACTIONS },
    content: "string",
    category: { type: "enum", values: WRITABLE_MEMORY_CATEGORIES },
    antiMemory: CTX_MEMORY_ANTI_MEMORY_RULE,
    objectId: "string",
    objectIds: { type: "array", items: "string", maxItems: 20 },
    limit: "number",
    reason: "string",
};
