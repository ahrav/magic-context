import type { DreamerConfig } from "../config/schema/magic-context";
import type { ClassifyModuleClient } from "../features/magic-context/dreamer/classify";
import { type RetrospectiveRawProvider } from "../features/magic-context/dreamer/retrospective-raw-provider";
import type { DreamTaskName, DreamTaskProgress } from "../features/magic-context/dreamer/task-registry";
import type { RawMessageProvider } from "../hooks/magic-context/read-session-chunk";
import type { Database } from "../shared/sqlite";
import type { PluginContext } from "./types";
/**
 * Per-project work registered with the timer. The timer is a process-wide
 * singleton, but Desktop OpenCode can load the same plugin once per project
 * within one process — every load needs its directory's git commits indexed,
 * its dream schedule checked, and its config respected.
 */
interface ProjectRegistration {
    directory: string;
    projectIdentity: string;
    client: PluginContext["client"];
    dreamerConfig?: DreamerConfig;
    language?: string;
    gitCommitIndexing?: {
        enabled: boolean;
        since_days: number;
        max_commits: number;
    };
    memoryEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    mural?: {
        enabled: boolean;
        model?: string;
    };
    retinaHandoff?: boolean;
    embeddingConfig?: {
        provider?: string;
    };
    ensureRegistered: (directory: string, db: Database) => Promise<void>;
    /**
     * Per-registration retrospective raw-source provider factory. Each harness
     * brings its own (the same way it brings its own `client`): OpenCode reads
     * opencode.db, Pi reads its JSONL sessions. When omitted, the timer defaults
     * to the OpenCode provider (preserving OpenCode behavior exactly).
     */
    retrospectiveRawProvider?: (db: Database, projectIdentity: string) => RetrospectiveRawProvider | null;
    /**
     * Per-registration primer raw-source provider factory for the SCHEDULED
     * refresh-primers task. Pi supplies a JSONL-backed factory so the open-book
     * primer seed renders the origin compartment's raw U:/TC: lines; OpenCode
     * omits it (buildPrimerSeed reads opencode.db directly). When omitted on Pi,
     * scheduled refresh-primers silently falls back to a closed-book seed.
     */
    primerRawProviderFactory?: (sessionId: string) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
    transformMode?: "ts" | "rust";
    onDreamerProgress?: (progress: DreamTaskProgress | null, completedTask?: DreamTaskName) => void;
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{
            authority: {
                state?: string;
                generation?: number;
            } | null;
        }>;
    };
}
/**
 * Clear the module-scope startup jitter slots. Slots are handed out for the
 * lifetime of the module and are otherwise released only when the last project
 * unregisters, so a test whose timing depends on which slots its projects
 * receive must clear them before registering.
 */
export declare function resetStartupJitterSlotsForTests(): void;
/**
 * Register the calling project with the process-wide dream + maintenance
 * timer. The timer itself is a singleton (we only need one setInterval per
 * process), but every registered project gets its per-directory work — git
 * commit indexing, dream schedule check, dream queue processing — on each
 *  tick. The first registration schedules a quiet-period startup pass so
 *  fresh installs do not create a writer burst during concurrent boot.
 *
 * Returns a cleanup that removes this project's registration. The timer
 * itself stops only when the last project unregisters.
 */
export declare function startDreamScheduleTimer(args: ProjectRegistration): Promise<(() => void) | undefined>;
export {};
//# sourceMappingURL=dream-timer.d.ts.map