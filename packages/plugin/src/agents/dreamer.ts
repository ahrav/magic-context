export const DREAMER_AGENT = "dreamer";
export const DREAMER_RETROSPECTIVE_AGENT = "dreamer-retrospective";
export const DREAMER_PRIMER_INVESTIGATOR_AGENT = "dreamer-primer-investigator";

export const DREAMER_MEMORY_MAPPER_AGENT = "dreamer-memory-mapper";

/**
 * */
export const DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "aft_outline",
    "aft_zoom",
    "aft_search",
] as const;

export const DREAMER_CLASSIFIER_AGENT = "dreamer-classifier";

export const DREAMER_DOCS_AGENT = "dreamer-docs";

/**
 * */
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

export const DREAMER_REVIEWER_AGENT = "dreamer-reviewer";

export const DREAMER_CURATE_ALLOWED_TOOLS = [] as const;
