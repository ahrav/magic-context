import type { Database } from "../../../shared/sqlite";
import { getContextStoreUuid } from "../context-authority";
import type { ClassifyModuleClient } from "./classify";

export class DreamerModuleBusyError extends Error {
    readonly transient = true;

    constructor(readonly state: string) {
        super(
            `Rust memory authority is ${state}; dreamer mutation deferred until authority settles.`,
        );
        this.name = "DreamerModuleBusyError";
    }
}

export class DreamerModuleFailureError extends Error {
    readonly transient = true;
    constructor(operation: string, cause: unknown) {
        super(
            `Rust dreamer ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.name = "DreamerModuleFailureError";
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

export interface DreamerModuleRoute {
    moduleClient: ClassifyModuleClient;
    moduleSessionId: string;
    moduleProjectRoot: string;
    moduleContextStoreUuid: string;
    moduleAuthorityGeneration: number;
    moduleCommandId: string;
}

/**
 * */
export async function resolveDreamerModuleRoute(args: {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    transformMode?: "ts" | "rust";
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: { state?: string; generation?: number } | null }>;
    };
    commandId: string;
}): Promise<DreamerModuleRoute | undefined> {
    const transport = args.transformMode === "ts" ? undefined : args.moduleClient;
    if (!transport?.authorityStatus) return undefined;
    const contextStoreUuid = getContextStoreUuid(args.db);
    if (!contextStoreUuid) throw new Error("Rust dreamer requires a context store identity");
    const result = await transport.authorityStatus({
        context_store_uuid: contextStoreUuid,
        project: args.projectIdentity,
        projectRoot: args.projectRoot,
        domain: "memories",
    });
    const authority = result.authority;
    if (authority?.state === "DRAINING") throw new DreamerModuleBusyError(authority.state);
    if (authority?.state !== "MODULE") return undefined;
    const generation = authority.generation;
    if (typeof generation !== "number") throw new Error("Rust authority status omitted generation");
    return {
        moduleClient: transport,
        moduleSessionId: args.projectIdentity,
        moduleProjectRoot: args.projectRoot,
        moduleContextStoreUuid: contextStoreUuid,
        moduleAuthorityGeneration: generation,
        moduleCommandId: args.commandId,
    };
}
