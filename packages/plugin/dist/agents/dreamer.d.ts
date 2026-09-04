export declare const DREAMER_AGENT = "dreamer";
export declare const DREAMER_RETROSPECTIVE_AGENT = "dreamer-retrospective";
export declare const DREAMER_PRIMER_INVESTIGATOR_AGENT = "dreamer-primer-investigator";
export declare const DREAMER_MEMORY_MAPPER_AGENT = "dreamer-memory-mapper";
/** Read-only tool profile shared by the memory-maintenance reader agent.
 *  No ctx_search (local-source checks only), no write/bash/ctx_memory. */
export declare const DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS: readonly ["read", "grep", "glob", "aft_outline", "aft_zoom", "aft_search"];
export declare const DREAMER_CLASSIFIER_AGENT = "dreamer-classifier";
export declare const DREAMER_DOCS_AGENT = "dreamer-docs";
/** Codebase-read + doc-write tool profile for the docs maintainer. No memory
 *  tools (it edits docs, not the memory store). */
export declare const DREAMER_DOCS_ALLOWED_TOOLS: readonly ["read", "grep", "glob", "bash", "write", "edit", "aft_outline", "aft_zoom", "aft_search"];
export declare const DREAMER_REVIEWER_AGENT = "dreamer-reviewer";
export declare const DREAMER_CURATE_ALLOWED_TOOLS: readonly [];
//# sourceMappingURL=dreamer.d.ts.map