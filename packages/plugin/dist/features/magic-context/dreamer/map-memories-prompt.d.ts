import type { ClaimMutationToken } from "../memory/claim-operation-contract";
/**
 * map-memories prompt + host-side helpers.
 *
 * map-memories is a ONE-TIME backfill: it locates the repo file(s) that back
 * each project memory (or marks it file-independent), recording the mapping so
 * the verify task can run incrementally from the start (verify reads "which
 * files changed since this memory's verification" — without a mapping, the first
 * verify would have to check the whole pool and time out, the cold-start trap).
 *
 * The agent only LOCATES backing files; the host parses its single XML manifest
 * and appends exact-revision applicability paths (mapped, not yet content-
 * verified). The prompt was calibrated in the shadow harness on real claim
 * pools (DeepSeek-v4-Flash); see .alfonso/plans/dreamer-v2-rework.md.
 */
export declare const MAP_MEMORIES_SYSTEM_PROMPT = "You are a memory mapper for the magic-context system. You map project memories to the repository files that back them.\n\nA memory's BACKING FILES are the file(s) whose code the memory makes a claim about \u2014 the files you would open to check whether the memory is accurate. You do NOT judge accuracy, rewrite, or remove anything. You only LOCATE backing files.\n\nTools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. Each memory may come with \"Likely files\" already named in it and confirmed to exist \u2014 confirm those FIRST (cheap) instead of searching. Use search/grep to FIND code only when no likely files are given. Do not guess \u2014 confirm a file exists and genuinely backs the memory before listing it. Keep reads minimal: you do not need to read a whole file to confirm it backs a one-line claim.\n\nFor each memory decide ONE of:\n- Backing files found \u2192 the COMPLETE set of repo-relative paths whose code the memory is about.\n- File-independent \u2192 the memory describes EXTERNAL behavior (a provider / API / platform / protocol limit, e.g. \"Anthropic returns 400 on empty content\"), or a pure process / workflow / philosophy rule, with NO specific local file that backs it.\n\nOutput ONE XML manifest at the very end and NOTHING else \u2014 no narration, no per-memory commentary, no reasoning:\n<mappings>\n<memory claim=\"mcm_...\" files=\"path/a.ts,path/b.ts\"/>\n<memory claim=\"mcm_...\" independent=\"true\"/>\n</mappings>\n\nRules:\n- Every input public claim id MUST appear exactly once.\n- files: repo-relative, comma-separated, no spaces inside a path. Only files that actually exist and genuinely back the memory.\n- A BACKING FILE is CODE that implements or handles the claim \u2014 not a file that merely mentions it. A markdown doc (.md), a PARITY/notes file, or a test that only DESCRIBES an external fact is NOT a backing file. If the only place a memory's fact appears is prose/docs/a test (no code implements or handles it), mark it independent=\"true\".\n- Many CONSTRAINTS are HYBRID: \"external system does X, and OUR code handles it here.\" Map those to the HANDLING code (you can verify the handling, even though you can't verify the external behavior). Only mark independent when there is NO local code that implements or handles the fact.\n- Prefer the most specific file(s); do not pad with tangential files. Most memories map to one file; some to a few.\n- When you genuinely cannot find any local backing and it is not clearly external, still emit the memory with independent=\"true\" (do not drop it).";
export declare const MAX_SEED_PATHS_PER_MEMORY = 3;
/** Extract candidate backing-file paths a memory NAMES, keep only those that
 *  EXIST in the repo, dedupe, cap. Pure host-side seeding — no LLM, no contents. */
export declare function extractMemoryCandidatePaths(content: string, repoDir: string): string[];
export interface MapMemoryInput {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    mutationToken: ClaimMutationToken;
    category: string;
    content: string;
    candidates: string[];
}
export declare function buildMapMemoriesPrompt(projectPath: string, memories: MapMemoryInput[]): string;
export interface ParsedMemoryMapping {
    publicClaimId: string;
    files: string[];
    independent: boolean;
}
/** Parse the agent's complete `<mappings>` manifest. A missing root close tag is
 *  treated as truncation and rejects the whole batch. `independent` is honored
 *  only for the explicit sentinel; a missing `files` attribute is never treated
 *  as file-independent (that silently excluded memories from verify). Nested
 *  `<file path="…"/>` children are accepted as an unambiguous alias. */
export declare function parseMapMemoriesManifest(text: string): ParsedMemoryMapping[];
/** Retry-time contract: non-empty parse + exact id coverage. Apply still
 *  re-asserts coverage as the final belt. */
export declare function validateMapMemoriesManifest(text: string, expectedIds: ReadonlySet<string>): ParsedMemoryMapping[];
//# sourceMappingURL=map-memories-prompt.d.ts.map