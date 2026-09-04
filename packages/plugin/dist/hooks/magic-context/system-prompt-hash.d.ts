import { type ContextDatabase } from "../../features/magic-context/storage";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
/**
 * Clear all per-session cache entries the system-prompt handler maintains,
 * including the module-scope user-profile/key-files maps and the per-handler
 * sticky-date/cached-docs maps (the latter passed in via the cleanup handle).
 * Called from the session-deleted event path.
 */
export declare function clearSystemPromptHashSession(sessionId: string, handleMaps: {
    stickyDateBySession: Map<string, string>;
    cachedDocsBySession: Map<string, string | null>;
}): void;
/**
 * Detect Magic Context's OWN hidden child agents by their system-prompt
 * openers. These children (historian/dreamer/sidekick/memory-migration) load a
 * fixed agent identity and must NOT receive the MC guidance block — it's wasted
 * spend and a contradictory second identity frame ("You are Historian…" plus
 * "You are the user's long-term partner…").
 *
 * This is the timing-independent companion to the `internalChildSessions` flag:
 * the flag is set at `session.created` (may race the very first system.transform
 * by event-delivery latency), whereas this signature is present in the prompt
 * content on pass 1 with zero timing dependency. Memory-migration loads the
 * historian agent prompt, so the historian opener covers it.
 *
 * The signature literals live in `internal-agent-signatures.ts`, shared with
 * the e2e cache/oracle analysis so both classifiers stay in lockstep.
 */
export declare function isMagicContextInternalAgent(systemPromptContent: string): boolean;
/**
 * Handle system prompt via experimental.chat.system.transform:
 *
 * 1. Inject generic magic-context guidance into the system prompt.
 *    Skips injection if guidance is already present (e.g., baked into the
 *    agent prompt by oh-my-opencode).
 *
 * 2. Detect system-prompt content or prompt-surface preset changes for
 *    cache-flush triggering. The hash transition is the semantic boundary at
 *    which queued operations can ride the same HARD fold.
 */
export declare function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    protectedTags: number;
    dreamerEnabled: boolean;
    /** When false (`memory.enabled: false`), the `<project-memory>` block is
     *  never injected, so ctx_memory guidance is dropped from the prompt and the
     *  ctx_memory tool is not registered. ctx_search guidance stays (it still
     *  recalls conversation + git commits). Default true. */
    memoryEnabled?: boolean;
    /** Optional language from user config for the main agent's generated text. */
    language?: string;
    promptSurface?: PromptSurfaceConfig;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** Recover the session's latest model when the transform input omits it. */
    resolveModel?: (sessionId: string) => {
        providerID: string;
        modelID: string;
    } | undefined;
    /**
     * One-shot signal that disk-backed adjuncts (user profile, key files,
     * sticky date) need to be re-read on this pass.
     * Drained at the end of the handler regardless of whether anything
     * actually refreshed — defer passes after this point MUST hit cached
     * values to keep the system prompt cache-stable.
     */
    systemPromptRefreshSessions: Set<string>;
    /**
     * Producer side: when this handler detects a real prompt-content or
     * prompt-surface-preset hash change, it adds the session to all three sets
     * so downstream consumers
     * (transform `prepareCompartmentInjection`, postprocess heuristics)
     * react on the same cycle. The hash change usually pairs with a new
     * agent identity, so all three are appropriate.
     */
    historyRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    /**
     * Issue #53: when false, Magic Context skips ALL system-prompt injection
     * for ALL agents. Global escape hatch for users who don't want Magic
     * Context guidance / sticky date touching the system prompt. (default: true)
     */
    injectionEnabled?: boolean;
    /**
     * Issue #53: per-agent opt-out. If the agent's system prompt contains
     * any of these substrings, skip ALL injection for this call. Lets users
     * mark specific custom agents (e.g. read-only QA agents that deny our
     * `ctx_*` tools) as no-injection without having to disable injection
     * globally.
     */
    injectionSkipSignatures?: string[];
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer/sidekick/memory-migration), flagged by title prefix at
     * `session.created`. When the active session is in this set we skip ALL
     * injection — these children have their own fixed agent identity/prompt and
     * never benefit from the MC guidance block. Belt to the prompt-signature
     * detection below (which is the pass-1 timing-independent suspenders).
     */
    internalChildSessions?: Set<string>;
    /** @deprecated user memories now render in m[0]/m[1], not system prompt. */
    experimentalUserMemories?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFiles?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFilesTokenBudget?: number;
    /** When true, add a temporal-awareness guidance paragraph + surface compartment dates */
    experimentalTemporalAwareness?: boolean;
    /** When true, inject a "BEWARE: history compression is on" warning so the
     *  agent doesn't mimic its own caveman-compressed past output. */
    experimentalCavemanTextCompression?: boolean;
}): {
    handler: (input: {
        sessionID?: string;
        model?: {
            providerID?: string;
            modelID?: string;
        };
    }, output: {
        system: string[];
    }) => Promise<void>;
    clearSession: (sessionId: string) => void;
};
//# sourceMappingURL=system-prompt-hash.d.ts.map