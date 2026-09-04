import type { DreamerConfig, SidekickConfig } from "../../config/schema/magic-context";
import type { ResolvedTransformMode } from "../../config/transform-mode";
import { type DreamTaskName } from "../../features/magic-context/dreamer/task-registry";
import type { ManualRunResult } from "../../features/magic-context/dreamer/task-scheduler";
import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import { type PartialRecompRange } from "./compartment-runner-partial-recomp";
import type { RustModeModuleClient } from "./rust-mode-transform";
import type { NotificationParams } from "./send-session-notification";
/** Parse `/ctx-recomp` arguments.
 *
 *  Accepted forms:
 *  - empty / whitespace-only → full recomp
 *  - `<start>-<end>`         → partial recomp with explicit inclusive range
 *  - `--upgrade`            → upgrade legacy compartments (dispatch stub until Wave 3)
 *
 *  Returns an error object for unparseable or nonsensical inputs. */
export declare function parseRecompArgs(raw: string): {
    kind: "full";
} | {
    kind: "partial";
    range: PartialRecompRange;
} | {
    kind: "upgrade";
} | {
    kind: "error";
    message: string;
};
export declare function parseWrapupArgs(raw: string): {
    ok: true;
    messagesToKeep: number;
} | {
    ok: false;
    message: string;
};
export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}
export interface CommandExecuteOutput {
    parts: Array<{
        type: string;
        text?: string;
    }>;
}
export type ManualDreamSummary = ManualRunResult;
export declare function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number;
    /** Boot-resolved mode; command paths must not re-read configuration. */
    compactionOff?: boolean;
    executeThresholdPercentage?: number | {
        default: number;
        [modelKey: string]: number;
    };
    executeThresholdTokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
    historyBudgetPercentage?: number;
    commitClusterTrigger?: {
        enabled: boolean;
        min_clusters: number;
    };
    getLiveModelKey?: (sessionId: string) => string | undefined;
    /** Optional live context limit resolver — used for tokens-based threshold display. */
    getContextLimit?: (sessionId: string) => number | undefined;
    getDreamerProgress?: () => import("../../features/magic-context/dreamer/task-registry").DreamTaskProgress | null;
    /** Cached U/T token measurement of the final rendered conversation tail, shared by both nudge mechanisms. */
    getTailHygiene?: (sessionId: string) => import("./ctx-reduce-nudge").Channel1State | undefined;
    onFlush?: (sessionId: string) => void;
    /** Runs /ctx-recomp. When `range` is provided, runs partial recomp over
     *  that range (snapped to enclosing compartment boundaries). When omitted,
     *  runs full recomp from message 1 to the protected tail. */
    executeRecomp?: (sessionId: string, options?: {
        range?: PartialRecompRange;
    }) => Promise<string>;
    /** Runs /ctx-wrapup over the live raw tail, keeping the newest N raw messages. */
    executeWrapup?: (sessionId: string, options: {
        messagesToKeep: number;
    }) => Promise<string>;
    /** Runs the once-per-project 5-cat memory migration for /ctx-session-upgrade.
     *  Optional: when unavailable, /ctx-session-upgrade still upgrades compartments
     *  via recomp and skips the memory re-evaluation. */
    runUpgrade?: (sessionId: string) => Promise<string>;
    /** `/ctx-embed start` — backfill this session's compartment embeddings. */
    executeEmbedHistory?: (sessionId: string, options?: {
        signal?: AbortSignal;
        silent?: boolean;
    }) => Promise<string>;
    pauseEmbedDrain?: (sessionId: string) => string;
    getEmbedStatusText?: (sessionId: string) => string;
    sendNotification: (sessionId: string, text: string, params: NotificationParams) => Promise<void>;
    /** Configured toast lifetime (ms) forwarded into diagnostics logs. */
    toastDurationMs?: number;
    transformMode?: ResolvedTransformMode;
    rustModeModuleClient?: RustModeModuleClient;
    projectRoot?: string;
    /** Active project identity as stored in `memories.project_path`. */
    projectPath?: string;
    /** Resolve the project for the invoking session at call time: the session
     * can be resumed in (or moved to) a different directory than the hook's
     * construction-time project, so approval/enforcement must target the
     * ACTIVE project — the same per-call discipline as `ctx_memory`'s
     * `toolContext.directory` and Pi's `resolveProject`. Absent resolver
     * falls back to the construction-time values. */
    resolveProjectForSession?: (sessionId: string) => {
        projectPath?: string;
        projectRoot: string;
    };
    sidekick?: {
        config: SidekickConfig;
        projectPath: string;
        sessionDirectory?: string;
        client: PluginContext["client"];
        language?: string;
    };
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        /** Dreamer v2 manual `/ctx-dream` entry — runs tasks now via the per-task
         *  scheduler (one forced task, or all enabled). Wired in hook.ts. */
        runManual: (task?: DreamTaskName) => Promise<ManualRunResult>;
    };
}): {
    "command.execute.before": (input: CommandExecuteInput, _output: CommandExecuteOutput, _params: NotificationParams) => Promise<void>;
};
//# sourceMappingURL=command-handler.d.ts.map