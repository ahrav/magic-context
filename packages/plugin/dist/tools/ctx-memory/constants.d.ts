import type { ImitatedArgRule } from "../unwrap-imitated-reduced-args";
export declare const CTX_MEMORY_TOOL_NAME = "ctx_memory";
export declare const CTX_MEMORY_DESCRIPTION = "Durable project claims shared across sessions.\n\nClaims use public IDs (mcm_<32hex>), immutable revision locators, and claim-local mutation tokens. Reuse the exact token returned by create/get/list when revising or changing lifecycle state.\n\nActions:\n- create: create a claim (content + category, or antiMemory).\n- get: fetch up to 20 public claim IDs; hidden and missing claims have the same result.\n- list: enumerate visible active claims (dreamer maintenance only).\n- revise: append a revision (publicClaimId + mutationToken + content/category or antiMemory).\n- archive / restore: append lifecycle state (publicClaimId + mutationToken).\n- merge: same-project merge; mutationTokens are ordered [target, ...sources].\n\nApproval and enforcement are human-owned /ctx-approve and /ctx-enforce commands. Agent calls to approve/enforce are rejected.";
export declare const DEFAULT_SEARCH_LIMIT = 10;
export declare const GET_MAX_CLAIMS = 20;
/**
 * Shape of a claim-local mutation token for reduced-argument decoding, shared by
 * every adapter so no adapter's decode schema can drift from the token contract.
 * Revise, archive, restore, and merge all require a token, so a decode schema that
 * omits it rejects the whole imitated call and loses the action.
 *
 * Shape only: value-level checks (public-ID format, tokenVersion) already fail
 * closed in storage-claim-operations and surface as ClaimOperationInputError.
 */
export declare const CTX_MEMORY_MUTATION_TOKEN_RULE: ImitatedArgRule;
/**
 * Shape of a rejected-approach payload for reduced-argument decoding, shared by
 * every adapter so no adapter's decode schema can drift from the advertised
 * antiMemory schema. Must list every field the tool schemas advertise: a decode
 * rule that omits an optional field (e.g. saferAlternative) rejects the whole
 * imitated call and loses the action.
 */
export declare const CTX_MEMORY_ANTI_MEMORY_RULE: ImitatedArgRule;
//# sourceMappingURL=constants.d.ts.map