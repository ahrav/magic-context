export const DREAMER_AGENT = "dreamer";
export const DREAMER_RETROSPECTIVE_AGENT = "dreamer-retrospective";
// Read-only code investigator for the refresh-primers task. Locked to
// navigation/read/search tools only — NO write/edit/bash/ctx_memory/ctx_note —
// because it runs an unsupervised, scheduled, weak-model agentic loop. A
// ctx_memory mutation here would bump the project memory epoch and bust m[0],
// violating the primers cache-neutral contract; write/bash could corrupt the
// user's source. Mirrors the dreamer-retrospective lockPermissions pattern.
export const DREAMER_PRIMER_INVESTIGATOR_AGENT = "dreamer-primer-investigator";

// Locked read-only code reader for the memory-maintenance tasks (map-memories,
// verify, verify-broad). Same source-safety + cache-neutrality lock as the
// primer investigator (NO write/edit/bash/ctx_memory), but deliberately WITHOUT
// ctx_search — these tasks check memories against the CURRENT local source, not
// cross-session recall. The host parses the agent's XML manifest and applies the
// DB writes itself, so the agent never needs a mutation tool.
export const DREAMER_MEMORY_MAPPER_AGENT = "dreamer-memory-mapper";

/** Read-only tool profile shared by the memory-maintenance reader agent.
 *  No ctx_search (local-source checks only), no write/bash/ctx_memory. */
export const DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "aft_outline",
    "aft_zoom",
    "aft_search",
] as const;

// Pure-transform classifier for the classify-memories task: prompt in → ONE XML
// manifest out, ZERO tools. classify scores metadata from the memory text alone
// (no code inspection), and the host applies the column writes — so the agent
// needs no tools at all. Locked so a user override can't grant any.
export const DREAMER_CLASSIFIER_AGENT = "dreamer-classifier";

// Docs maintainer for the maintain-docs task: explores the codebase and writes
// ARCHITECTURE.md / STRUCTURE.md. Needs file read + write/edit + bash (git log,
// find) + aft navigation, but deliberately NO ctx_memory/ctx_search/ctx_note —
// it touches docs, never the memory store. Locked so a user override can't add
// the memory surface back.
export const DREAMER_DOCS_AGENT = "dreamer-docs";

/** Codebase-read + doc-write tool profile for the docs maintainer. No memory
 *  tools (it edits docs, not the memory store). */
export const DREAMER_DOCS_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "bash",
    "write",
    "edit",
    "aft_outline",
    "aft_zoom",
    "aft_search",
] as const;

// Pure JSON reviewer for the review-user-memories task: reads the candidate
// observations the host renders and returns a JSON verdict the host applies. It
// calls NO tools (zero), so it gets the empty allow-list, locked.
export const DREAMER_REVIEWER_AGENT = "dreamer-reviewer";

export const DREAMER_CURATE_ALLOWED_TOOLS = [] as const;
