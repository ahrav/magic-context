import { type ConfigHarness } from "../config/migrate-config-location";
import { type PromptSurfaceConfig, type PromptSurfacePreset } from "./prompt-surface";
/**
 * The single source of truth for the ctx_* tools exposed by the prompt surface.
 * Consumers derive their registries and light-description catalogs from this list
 * so adding a tool cannot silently skip one prompt-surface integration point.
 */
export declare const ACTIVE_TOOL_IDS: readonly ["ctx_reduce", "ctx_expand", "ctx_note", "ctx_memory", "ctx_search"];
/** @deprecated Use ACTIVE_TOOL_IDS. Kept as an alias for existing consumers. */
export declare const PROMPT_SURFACE_TOOL_IDS: readonly ["ctx_reduce", "ctx_expand", "ctx_note", "ctx_memory", "ctx_search"];
export type PromptSurfaceToolId = (typeof ACTIVE_TOOL_IDS)[number];
export declare const LIGHT_TOOL_DESCRIPTIONS: {
    readonly ctx_reduce: "For ctx_reduce users, mark spent §N§ outputs discardable; release is QUEUED, not immediate, so content stays visible until space is needed. Newest tags stay protected until they age out. Released content becomes a placeholder; recover it only by rerunning the source or recovery tool, so mark only genuinely finished material. Mark analyzed, redundant, persisted, or merely confirmatory outputs; keep user messages, unresolved errors, unextracted evidence, and exact wording. NEVER blanket-mark a large range: review every tag first.";
    readonly ctx_expand: "For ctx_expand users, recover compacted conversation by passing a session-history heading's inclusive start/end ordinals. Results are raw [N] U:/A: transcript capped near 15K tokens; oversized ranges return the head and a continuation. Use verbose=true to list each message ordinal, part previews, and tool-output sizes; use message=N for one complete stored message and its tool exchanges. NEVER expand ranges after the last compartment because that live tail is already visible.";
    readonly ctx_note: "For ctx_note users, write saves, read lists, update changes, and dismiss retires future session notes; surface_condition creates a smart note. For smart notes, NEVER use a condition tied to this conversation or an unobservable future action because the background checker can inspect only external GitHub, disk, git, or web signals.";
    readonly ctx_memory: "For ctx_memory users, create one durable project claim with category and content; revise, archive, restore, or merge claims by opaque public ID plus the current mutation token, or get up to twenty public IDs. Stale tokens make no change. list remains dreamer-only, so primary agents must NEVER assume bulk-list access.";
    readonly ctx_search: "For ctx_search users, retrieve compacted messages, commits, and notes. Broad project-memory retrieval is disabled until the claim retrieval projection is active; exact public claim or revision locators resolve directly. Message hits continue through ctx_expand.";
};
/**
 * Preserve the existing full-preset hash exactly while giving other presets a
 * distinct semantic cache identity, including during any future asset fallback.
 */
export declare function promptSurfaceHashMaterial(systemContent: string, preset?: PromptSurfacePreset): string;
export interface PromptSurfaceGuidanceSelection {
    /** The configured built-in preset. */
    preset: PromptSurfacePreset;
    /** Complete user-authored primary section captured when a model-key epoch starts. */
    primaryOverride?: string;
}
export interface PromptSurfaceRegistrationSelection {
    preset: PromptSurfacePreset;
    descriptionFor: (toolId: string, fullDescription: string) => string;
}
export interface PromptSurfaceRuntime {
    resolveRegistration: (config: PromptSurfaceConfig | undefined) => PromptSurfaceRegistrationSelection;
    resolveGuidance: (config: PromptSurfaceConfig | undefined, modelKey: string | undefined) => PromptSurfaceGuidanceSelection;
}
export interface CreatePromptSurfaceRuntimeOptions {
    harness?: ConfigHarness;
    directory?: string;
    /** Explicit test/integration seam; production derives the USER config directory. */
    userConfigDirectory?: string;
    warn: (message: string) => void;
}
/**
 * Create one host-registration runtime. Its warning set is shared by tool
 * registration and every guidance epoch, so invalid overrides are reported once
 * instead of on every model call.
 */
export declare function createPromptSurfaceRuntime(options: CreatePromptSurfaceRuntimeOptions): PromptSurfaceRuntime;
/** Freeze preset selection and materialized override bytes for one model-key epoch. */
export declare function createPromptSurfaceGuidanceEpochCache(runtime: PromptSurfaceRuntime): {
    resolve: (sessionId: string, config: PromptSurfaceConfig | undefined, modelKey: string | undefined) => PromptSurfaceGuidanceSelection;
    clear: (sessionId: string) => void;
};
//# sourceMappingURL=prompt-surface-runtime.d.ts.map