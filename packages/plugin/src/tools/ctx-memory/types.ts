import type { ClaimMutationToken } from "../../features/magic-context/memory/claim-operation-contract";
import type { AntiMemoryPayload } from "../../features/magic-context/memory/storage-anti-memory";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/* */
export const CTX_MEMORY_ACTIONS = [
    "create",
    "get",
    "revise",
    "archive",
    "restore",
    "merge",
] as const;

/* */
export const CTX_MEMORY_DREAMER_ACTIONS = [...CTX_MEMORY_ACTIONS, "list"] as const;

export type CtxMemoryAction = (typeof CTX_MEMORY_DREAMER_ACTIONS)[number];

export interface CtxMemoryArgs extends ImitatedReducedArgs {
    action?: CtxMemoryAction;
    content?: string;
    category?: string;
    antiMemory?: AntiMemoryPayload;
    /** `publicClaimId` identifies one target for `revise`, `archive`, or `restore`. */
    publicClaimId?: string;
    /** `publicClaimIds` identifies `get` targets and orders merge claims as `[target, ...sources]`. */
    publicClaimIds?: string[];
    /** `mutationToken` must exactly match a token returned by `create`, `get`, or `list` for a single-claim mutation. */
    mutationToken?: ClaimMutationToken;
    /** `mutationTokens` must order merge tokens as `[target, ...sources]`. */
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
