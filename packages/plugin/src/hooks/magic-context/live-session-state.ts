import type { DreamTaskProgress } from "../../features/magic-context/dreamer/task-registry";
import type { RecompProgress } from "./compartment-runner-types";
import type { Channel1State } from "./ctx-reduce-nudge";
import type { AgentBySession, LiveModelBySession, VariantBySession } from "./hook-handlers";

/**
 *
 *
 */
export interface LiveSessionState {
    liveModelBySession: LiveModelBySession;
    variantBySession: VariantBySession;
    agentBySession: AgentBySession;
    /* */
    channel1StateBySession: Map<string, Channel1State>;
    historyRefreshSessions: Set<string>;
    deferredHistoryRefreshSessions: Set<string>;
    systemPromptRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
    deferredMaterializationSessions: Set<string>;
    /**
     *
     *
     */
    sessionDirectoryBySession: Map<string, string>;
    /**
     */
    recompProgressBySession: Map<string, RecompProgress>;
    /* */
    dreamerProgressByProject: Map<string, DreamTaskProgress>;
    /**
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
