import type { AntiMemoryPayload } from "../../features/magic-context/memory/anti-memory-content";
import type { KernelClientResolver } from "../../shared/kernel-client";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/* */
export const CTX_MEMORY_ACTIONS = ["create", "get", "revise", "archive", "merge"] as const;

/* */
export const CTX_MEMORY_DREAMER_ACTIONS = [...CTX_MEMORY_ACTIONS, "list"] as const;

export type CtxMemoryAction = (typeof CTX_MEMORY_DREAMER_ACTIONS)[number];

const CTX_MEMORY_READ_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set(["get", "list"]);

/** Whether `action` commits through the kernel rather than reading from it. */
export function isCtxMemoryMutation(action: CtxMemoryAction): boolean {
    return !CTX_MEMORY_READ_ACTIONS.has(action);
}

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
    /** Populates the project's embedding snapshot before the disabled gate reads it. */
    ensureProjectRegistered?: (directory: string) => Promise<void>;
    memoryEnabled?: boolean;
    allowedActions?: CtxMemoryAction[];
}
