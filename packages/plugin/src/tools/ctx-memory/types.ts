import type { ClaimMutationToken } from "../../features/magic-context/memory/claim-operation-contract";
import type { AntiMemoryPayload } from "../../features/magic-context/memory/storage-anti-memory";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/** Agent-owned claim actions. Approval and enforcement stay host-command only. */
export const CTX_MEMORY_ACTIONS = [
    "create",
    "get",
    "revise",
    "archive",
    "restore",
    "merge",
] as const;

/** Bulk enumeration remains restricted to dreamer maintenance sessions. */
export const CTX_MEMORY_DREAMER_ACTIONS = [...CTX_MEMORY_ACTIONS, "list"] as const;

export type CtxMemoryAction = (typeof CTX_MEMORY_DREAMER_ACTIONS)[number];

export interface CtxMemoryArgs extends ImitatedReducedArgs {
    action?: CtxMemoryAction;
    content?: string;
    category?: string;
    antiMemory?: AntiMemoryPayload;
    /** Single target for revise/archive/restore. */
    publicClaimId?: string;
    /** Targets for get; ordered [target, ...sources] for merge. */
    publicClaimIds?: string[];
    /** Exact token returned by create/get/list for single-claim mutations. */
    mutationToken?: ClaimMutationToken;
    /** Exact tokens ordered [target, ...sources] for merge. */
    mutationTokens?: ClaimMutationToken[];
    limit?: number;
    reason?: string;
}

export interface CtxMemoryToolDeps {
    db: Database;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    resolveProjectPath: (directory: string) => string | undefined;
    memoryEnabled?: boolean;
    allowedActions?: CtxMemoryAction[];
    rustToolBackends?: RustToolBackends;
}
