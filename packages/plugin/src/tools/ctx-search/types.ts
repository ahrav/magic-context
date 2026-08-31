import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/** Facts always render in `<session-history>` in `message[0]`; searching them returns content already visible in context.
 * Facts always render in `<session-history>` in `message[0]`; searching them returns content already visible in context.
 * */
export type CtxSearchSource = "memory" | "message" | "git_commit" | "primer" | "note";

export interface CtxSearchArgs extends ImitatedReducedArgs {
    query?: string;
    limit?: number;
    /** Restrict search to specific sources. Omit to search all; [] searches none. */
    sources?: CtxSearchSource[];
}

export interface CtxSearchToolDeps {
    db: Database;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    /**
     * Resolve the project identity for the session's directory at call time.
     * OpenCode's top-level `ctx.directory` reflects the launch directory, not the session's working directory.
     */
    resolveProjectPath: (directory: string) => string | undefined;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    /* */
    gitCommitsEnabled?: boolean;
    /** Tests override `readMessages` to avoid opening the OpenCode DB. */
    readMessages?: (sessionId: string) => Array<{
        ordinal: number;
        id: string;
        role: string;
        parts: unknown[];
    }>;
}
