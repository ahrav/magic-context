/**
 * Host-owned claim approval and enforcement command workflows shared by the
 * OpenCode and Pi harnesses (KD1; KTD5-KTD6). Two-step stale-safe
 * confirmation: the first invocation shows the owning project, exact
 * revision, and content digest; repeating the same command within the window
 * records exactly one idempotent action. Neither workflow is reachable from
 * any agent tool schema.
 */
import type { Database } from "../../../shared/sqlite";
import type { EnforcementArtifactKind } from "../storage-claim-policy-schema";
export interface ClaimCommandResult {
    text: string;
    level: "info" | "warning" | "error";
}
export interface ArtifactEvaluation {
    result: "pass" | "fail";
    evaluator: string;
    evaluatorVersion: string;
    detail?: string;
}
export interface ClaimCommandDeps {
    db: Database;
    /** Active project identity as stored in `memories.project_path`. */
    projectPath: string;
    /** Filesystem root of the active project, for artifact canonicalization. */
    projectRoot: string;
    host: "opencode" | "pi";
    sessionId: string;
    nowMs?: number;
    /** Injectable artifact evaluator; the default runs `bun test` for test
     * artifacts and rejects other kinds. Receives the absolute path of an
     * immutable same-directory snapshot of the artifact, not the live
     * artifact path (KTD6). */
    evaluateArtifact?: (snapshotPath: string, kind: EnforcementArtifactKind, projectRoot: string) => ArtifactEvaluation | Promise<ArtifactEvaluation>;
}
export declare function clearClaimCommandConfirmationsForTests(): void;
export declare function executeClaimApprovalCommand(deps: ClaimCommandDeps, argsText: string): Promise<ClaimCommandResult>;
export declare function executeClaimEnforceCommand(deps: ClaimCommandDeps, argsText: string): Promise<ClaimCommandResult>;
//# sourceMappingURL=claim-policy-commands.d.ts.map