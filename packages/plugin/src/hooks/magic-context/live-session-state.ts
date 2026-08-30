import type { DreamTaskProgress } from "../../features/magic-context/dreamer/task-registry";
import type { RecompProgress } from "./compartment-runner-types";
import type { Channel1State } from "./ctx-reduce-nudge";
import type { AgentBySession, LiveModelBySession, VariantBySession } from "./hook-handlers";

/**
 * Plugin-process-scoped shared state. Lives in `index.ts` and is threaded into
 * every component that needs to share signals with the others (the magic-
 * context hook, RPC handlers, command handlers, etc).
 *
 * The `*Sessions` sets give each cache-busting signal one consumer and lifetime.
 * See `hook-handlers.ts` for the full lifetime/semantics doc-comment on
 * each set, and `system-prompt-hash.ts` / `transform.ts` /
 * `transform-postprocess-phase.ts` for the consumer drain points.
 *
 * Storing them here lets RPC-driven recomp (TUI command path) signal the
 * same sets the hook-driven recomp (server `/ctx-recomp` path) signals.
 * Without this, the TUI recomp publish would silently leave injection cache
 * stale and the next defer pass would reuse old `<session-history>`.
 */
export interface LiveSessionState {
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /** Cached U/T token measurement of each rendered conversation tail, shared with display RPCs. */
    channel1StateBySession: Map<string, Channel1State>;
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions: Set<string>;
    systemPromptRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions: Set<string>;
    /**
     * Cache of resolved session.directory values from `client.session.get(...)`.
     *
     * The session→project binding is set at session create time and never
     * changes (OpenCode source: `Session.directory` is read once from the
     * session record, no migration path), so caching for the lifetime of the
     * plugin process is safe. Without this, transform.ts hits OpenCode's
     * local API on every transform pass — observed to be 1.5s+ for large
     * sessions under Electron, accounting for the bulk of transform latency.
     *
     * Populated on first successful resolution; cleared on `session.deleted`.
     */
    sessionDirectoryBySession: Map<string, string>;
    /**
     * Live recomp / session-upgrade progress, keyed by sessionId. Written by the
     * RPC recomp/upgrade handlers (via the runner's `onRecompProgress` callback
     * plus their own migration/terminal updates) and read by `buildSidebarSnapshot`
     * so the TUI sidebar + /ctx-status can show a live progress bar. In-memory
     * only — a process restart interrupts the recomp anyway.
     */
    recompProgressBySession: Map<string, RecompProgress>;
    /** Live Dreamer progress keyed by project identity; kept only in process memory and not read from or written to the prompt/result cache. */
    dreamerProgressByProject: Map<string, DreamTaskProgress>;
    /**
     * Sessions that are Magic Context's OWN hidden children (historian,
     * dreamer, sidekick, memory-migration). Detected at `session.created` by
     * the `magic-context-` title prefix. These sessions are fully exempt from
     * the message transform AND system-prompt injection — they have their own
     * fixed agent identity/prompt, never use ctx_reduce/nudges/compartments,
     * and getting the MC guidance block bolted on is wasted spend plus a
     * contradictory second identity frame. In-memory only: these children are
     * ephemeral (a process restart abandons any in-flight run), so the set
     * never needs to survive a restart.
     */
    internalChildSessions: Set<string>;
}

export function createLiveSessionState(): LiveSessionState {
    return {
        liveModelBySession: new Map<string, { providerID: string; modelID: string }>(),
        variantBySession: new Map<string, string | undefined>(),
        agentBySession: new Map<string, string>(),
        channel1StateBySession: new Map<string, Channel1State>(),
        historyRefreshSessions: new Set<string>(),
        deferredHistoryRefreshSessions: new Set<string>(),
        systemPromptRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        deferredMaterializationSessions: new Set<string>(),
        sessionDirectoryBySession: new Map<string, string>(),
        recompProgressBySession: new Map<string, RecompProgress>(),
        dreamerProgressByProject: new Map<string, DreamTaskProgress>(),
        internalChildSessions: new Set<string>(),
    };
}
