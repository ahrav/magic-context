import type { AntiMemoryPayload } from "../../features/magic-context/memory/anti-memory-content";
import type { KernelClientResolver } from "../../shared/kernel-client";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/* */
export const CTX_MEMORY_ACTIONS = ["create", "get", "revise", "archive", "merge"] as const;

/* */
export const CTX_MEMORY_DREAMER_ACTIONS = [...CTX_MEMORY_ACTIONS, "list"] as const;

export type CtxMemoryAction = (typeof CTX_MEMORY_DREAMER_ACTIONS)[number];

export interface CtxMemoryArgs extends ImitatedReducedArgs {
    action?: CtxMemoryAction;
    content?: string;
    category?: string;
    antiMemory?: AntiMemoryPayload;
    /** The one target of `revise` or `archive`. */
    objectId?: string;
    /** `get` targets; for `merge`, the objects folded into one survivor. */
    objectIds?: string[];
    limit?: number;
    reason?: string;
}

export type { KernelClientResolver };

export interface CtxMemoryToolDeps {
    kernelClient: KernelClientResolver;
    resolveProjectPath: (directory: string) => string | undefined;
    memoryEnabled?: boolean;
    allowedActions?: CtxMemoryAction[];
}
