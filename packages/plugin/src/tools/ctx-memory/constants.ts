import type { ImitatedArgRule } from "../unwrap-imitated-reduced-args";

export const CTX_MEMORY_TOOL_NAME = "ctx_memory";
export const CTX_MEMORY_DESCRIPTION = `Durable project claims shared across sessions.

Claims use public IDs (mcm_<32hex>), immutable revision locators, and claim-local mutation tokens. Reuse the exact token returned by create/get/list when revising or changing lifecycle state.

Actions:
- create: create a claim (content + category, or antiMemory).
- get: fetch up to 20 public claim IDs; hidden and missing claims have the same result.
- list: enumerate visible active claims (dreamer maintenance only).
- revise: append a revision (publicClaimId + mutationToken + content/category or antiMemory).
- archive / restore: append lifecycle state (publicClaimId + mutationToken).
- merge: same-project merge; mutationTokens are ordered [target, ...sources].

Approval and enforcement are human-owned /ctx-approve and /ctx-enforce commands. Agent calls to approve/enforce are rejected.`;
export const DEFAULT_SEARCH_LIMIT = 10;
export const GET_MAX_CLAIMS = 20;

/**
 * A decode schema must include the token required by revise, archive, restore, and merge.
 *
 */
export const CTX_MEMORY_MUTATION_TOKEN_RULE: ImitatedArgRule = {
    type: "object",
    fields: {
        tokenVersion: "number",
        publicClaimId: "string",
        revision: "number",
        contentDigest: "string",
        lifecycleSeq: "number",
        applicabilityHeadsDigest: "string",
        policyHeadsDigest: "string",
    },
};

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
