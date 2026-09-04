/**
 * verify prompt + manifest parser.
 *
 * verify checks each in-scope project memory against the CURRENT source and
 * emits ONE XML manifest (verified / update / archive). The agent reads code
 * and changes nothing; the HOST parses the manifest and applies the DB writes
 * (so the agent never needs a mutation tool). Calibrated in the shadow harness
 * with planted ground-truth controls (4/4: caught a stale number → update, a
 * wrong tool-count → archive, a same-session change → archive, and kept the
 * correct control verified). See .alfonso/plans/dreamer-v2-rework.md.
 *
 * The DANGEROUS failure mode is WRONG ARCHIVAL (deleting a TRUE memory), so the
 * prompt and the host apply both bias hard toward keeping memories.
 */
import type { ClaimMutationToken } from "../memory/claim-operation-contract";
export declare const VERIFY_SYSTEM_PROMPT: string;
export interface VerifyPromptMemory {
    publicClaimId: string;
    revisionLocator: string;
    contentDigest: string;
    mutationToken: ClaimMutationToken;
    category: string;
    content: string;
    mappedFiles: string[];
}
export declare function buildVerifyPrompt(projectPath: string, memories: VerifyPromptMemory[]): string;
export interface ParsedVerifyManifest {
    verified: Array<{
        publicClaimId: string;
        files: string[];
    }>;
    updated: Array<{
        publicClaimId: string;
        files: string[];
        content: string;
    }>;
    archived: Array<{
        publicClaimId: string;
        reason: string;
    }>;
}
/** Parse the agent's complete `<verify>` manifest. The root close tag is
 *  mandatory so truncated output cannot apply a partial set of verdicts.
 *  A well-formed root with no recognized entries is a format miss, not success. */
export declare function parseVerifyManifest(text: string, allowFilelessClaimIds?: ReadonlySet<string>): ParsedVerifyManifest;
/** Retry-time contract: non-empty parse + exact id coverage. Apply still
 *  re-asserts coverage as the final belt. */
export declare function validateVerifyManifest(text: string, expectedIds: ReadonlySet<string>, allowFilelessClaimIds?: ReadonlySet<string>): ParsedVerifyManifest;
//# sourceMappingURL=verify-prompt.d.ts.map