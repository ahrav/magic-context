import type { ImitatedArgRule } from "../unwrap-imitated-reduced-args";

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

Memories created here start at candidate maturity and are surfaced through explicit search until promoted. Agent calls to approve/enforce are rejected.`;
export const DEFAULT_SEARCH_LIMIT = 10;
export const GET_MAX_CLAIMS = 20;

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
    },
};
